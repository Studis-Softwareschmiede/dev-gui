/**
 * NightWatchScheduler — Nachtfenster-Scheduler für den Taktgeber/Nachtwächter
 * (docs/specs/taktgeber-nachtwaechter.md AC9, AC10, AC11).
 *
 * Fügt die bereits gebauten Bausteine (ProjectDrain S-192, ProjectJobLock
 * S-190, TokenLimitWatcher S-193, TickerSettingsStore S-194) zu einem
 * periodischen Prozess-internen Job zusammen: pollt im konfigurierten
 * Nachtfenster (Default 23:00–07:00, Europe/Zurich) im konfigurierten
 * Intervall (Default 15 min) das Board über `BoardAggregator` und startet
 * bis zu `maxParallel` (Default 3, geklemmt 1–3) parallele
 * `ProjectDrain.drainProject()`-Läufe.
 *
 * Scope dieser Story (S-195, `implements: [AC9, AC10, AC11]`):
 *   - AC9  — pollt im Fenster alle Projekte (oder `projects`-Liste) bis
 *     `maxParallel` parallel, Intervall `intervalMinutes`.
 *   - AC10 — Nachtfenster-Berechnung (TZ, über-Mitternacht `start>end`:
 *     ein Zeitpunkt liegt im Fenster wenn er ≥ start ODER < end ist).
 *   - AC11 — Sanftes Ende: ab `window.end` keine NEUEN Drains; bereits
 *     laufende Drains werden NICHT abgebrochen (sie werden schlicht nicht
 *     angefasst — kein Kill-Pfad existiert in dieser Klasse).
 *
 *   Zusätzlich konsumiert diese Klasse den bereits gebauten
 *   `TokenLimitWatcher` (S-193, dessen Modul-Doku dies explizit als Aufgabe
 *   des künftigen Schedulers benennt: "Konsumiert von Scheduler (S-195)") —
 *   AC13/AC14 selbst bleiben bei S-193 implementiert; hier wird nur der
 *   `exceeds-window`-Fall auf einen Tick-Stop gemappt (Story-Vorgabe) und
 *   der `paused`-Fall abgewartet, bevor neue Drains gestartet werden.
 *   `ProjectJobLock`/`isProjectBusy` (AC6/AC7, S-190) werden NICHT hier
 *   dupliziert — `ProjectDrain.drainProject()` prüft dies bereits selbst
 *   vor jedem Lauf (kein Doppel-Trigger, siehe ProjectDrain.js).
 *
 * EHRLICHER Parallelitäts-Hinweis (S-195 Review-Iteration 2, live
 * verifiziert critical, siehe `.claude/lessons/coder.md` 2026-07-01):
 *   `maxParallel>1` startet zwar wirklich bis zu `maxParallel` parallele
 *   `ProjectDrain.drainProject()`-Loops (dieser Scheduler selbst limitiert
 *   nichts weiter) — ABER der darunterliegende `CommandService` serialisiert
 *   JEDEN `/agent-flow:flow`-Anstoß weiterhin über einen einzigen
 *   PROZESSWEITEN `JobLock` (`src/CommandService.js`), nicht über einen
 *   projektweisen Lock. Effektiv läuft damit zu jedem Zeitpunkt höchstens
 *   EIN echter /flow-Prozess; die übrigen `maxParallel-1` gestarteten Drains
 *   bekommen von `tryRun()` `{ok:false, reason:'locked'}` und beenden sich
 *   (dank des Fixes in `ProjectDrain.js`, reason `'command-channel-busy'`)
 *   sofort sauber OHNE Eskalation/Fehl-Blocked — sie bleiben Kandidat für
 *   den nächsten Tick. `drainProject()`-Ausgänge mit `reason`
 *   `'command-channel-busy'`, `'contended'` oder `'already-busy'` sind daher
 *   ein NORMALER, unkritischer Tick-Ausgang (kein Fehler, kein Warnsignal) —
 *   das Projekt wird beim nächsten Poll erneut versucht. Volle, ECHTE
 *   Parallelität (mehrere /flow-Prozesse gleichzeitig) ist bewusst NICHT
 *   Teil dieser Story — sie erfordert einen Umbau von `CommandService` auf
 *   einen projektweisen PTY-Lock (separate Folge-Story `S-204`, `depends:
 *   [S-195]`). WICHTIG: kein Fehl-Blocked mehr — das war der behobene
 *   Critical-Bug dieser Iteration.
 *
 * Nicht in dieser Story (bewusst NICHT gebaut):
 *   - „Board abarbeiten"-Knopf-Umbau (S-196) / Settings-API (S-194, fertig)
 *     / UI (S-197).
 *   - Kein eigener Board-Schreibpfad — Eskalation bleibt Sache von
 *     `ProjectDrain`/`BoardWriter` (S-191/S-192).
 *   - Echte projektweise CommandService-Parallelität (S-204, s.o.).
 *
 * Zeitzone/über-Mitternacht (AC10):
 *   Wiederverwendet die TZ-Wandzeit-Helfer aus `TokenLimitWatcher.js`
 *   (`getZonedParts`, `zonedWallTimeToUtc`, `addCalendarDays`,
 *   `isValidIanaTimeZone`) statt sie zu duplizieren (Story-Vorgabe:
 *   "evtl. gemeinsame Hilfsfunktion wiederverwenden statt duplizieren").
 *   `isWithinWindow()` prüft die aktuelle Wandzeit (Minuten seit
 *   Mitternacht) gegen `start`/`end`:
 *     - `start === end` → NIE im Fenster (Edge-Case, defensive Owner-
 *       Korrektur laut Spec).
 *     - `start < end`   → normales Fenster: `start ≤ now < end`.
 *     - `start > end`   → über Mitternacht: `now ≥ start ODER now < end`.
 *   `computeWindowEndMs()` bestimmt den ms-Epoch-Zeitpunkt des für „jetzt"
 *   GÜLTIGEN Fensterendes (heute oder morgen, je nachdem ob wir uns aktuell
 *   in der Abend- oder der Morgen-Hälfte eines über-Mitternacht-Fensters
 *   befinden) — wird als `windowEndMs` an `TokenLimitWatcher.waitForReset()`
 *   gereicht (AC14-Konsum).
 *
 * Robustheit (NFR):
 *   - Einzelne `setTimeout`-Kette (kein `setInterval`, kein Drift) +
 *     Skip-if-running (Muster `ReconciliationJob`), Timer `unref()`.
 *   - Ein Board-Scan-/Settings-Lese-Fehler degradiert den Tick (übersprungen,
 *     kein Crash, kein Timer-Abbruch) — analog `ReconciliationJob`.
 *   - Injizierbare Uhr (`now`), injizierbares `sleepFn` (für
 *     `TokenLimitWatcher.waitForReset`) und injizierbare
 *     `setTimeoutFn`/`clearTimeoutFn` (Äquivalent zu `setInterval`) — Tests
 *     laufen ohne echtes Warten und ohne echte Systemuhr.
 *
 * Security (Floor):
 *   - Kein eigener PTY-Schreibpfad — `ProjectDrain`/`CommandService` bleiben
 *     der einzige Weg (Allowlist, Sanitization dort).
 *   - Kein Secret in Audit/Log.
 *
 * @module NightWatchScheduler
 */

import { getZonedParts, zonedWallTimeToUtc, addCalendarDays } from './TokenLimitWatcher.js';

/** Default Poll-Intervall (Minuten) — mirrors TickerSettingsStore-Default, falls Settings nicht lesbar sind. */
export const DEFAULT_INTERVAL_MINUTES = 15;

/** Default `maxParallel` — mirrors TickerSettingsStore-Default/Klemmung 1–3. */
export const DEFAULT_MAX_PARALLEL = 3;

// ── Pure Helpers (kein IO — direkt unit-testbar) ──────────────────────────────

/**
 * Parst ein "HH:MM"-Zeitfeld (24h). Gibt `null` bei ungültigem Format zurück
 * (defensiv — Aufrufer behandelt `null` konservativ als "nie im Fenster").
 *
 * @param {unknown} value
 * @returns {{hour:number, minute:number}|null}
 */
export function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Prüft, ob ein Zeitpunkt (`nowMs`) innerhalb des Nachtfensters liegt (AC10).
 *
 * @param {number} nowMs
 * @param {{start:string, end:string, timezone:string}} window
 * @returns {boolean}
 */
export function isWithinWindow(nowMs, window) {
  const s = parseHHMM(window?.start);
  const e = parseHHMM(window?.end);
  if (!s || !e) return false; // defensiv: ungültige Fenster-Konfig → nie im Fenster
  const startMin = s.hour * 60 + s.minute;
  const endMin = e.hour * 60 + e.minute;
  if (startMin === endMin) return false; // Edge-Case Spec: start==end → nie im Fenster

  const timezone = window.timezone;
  const nowParts = getZonedParts(nowMs, timezone);
  const nowMin = nowParts.hour * 60 + nowParts.minute;

  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // über Mitternacht (AC10, AC8 Spec Punkt 8): now ≥ start ODER now < end
  return nowMin >= startMin || nowMin < endMin;
}

/**
 * Bestimmt den ms-Epoch-Zeitpunkt des für `nowMs` GÜLTIGEN Fensterendes
 * (heute oder morgen, je nach über-Mitternacht-Halbierung) — wird als
 * `windowEndMs` an `TokenLimitWatcher.waitForReset()` gereicht (AC14-Konsum,
 * "liegt der Reset NACH window.end?").
 *
 * Gibt `null` zurück, wenn Start/Ende nicht parsebar sind (defensiv — der
 * Aufrufer behandelt `null` als "keine Fenster-Prüfung möglich", identisch zu
 * `TokenLimitWatcher.waitForReset({windowEndMs: null})`).
 *
 * @param {number} nowMs
 * @param {{start:string, end:string, timezone:string}} window
 * @returns {number|null}
 */
export function computeWindowEndMs(nowMs, window) {
  const s = parseHHMM(window?.start);
  const e = parseHHMM(window?.end);
  if (!s || !e) return null;
  const startMin = s.hour * 60 + s.minute;
  const endMin = e.hour * 60 + e.minute;
  const timezone = window.timezone;

  const nowParts = getZonedParts(nowMs, timezone);
  const nowMin = nowParts.hour * 60 + nowParts.minute;
  const endTodayMs = zonedWallTimeToUtc(nowParts.year, nowParts.month, nowParts.day, e.hour, e.minute, timezone);

  if (startMin < endMin) {
    // Normales (nicht über-Mitternacht) Fenster: Ende ist immer "heute".
    return endTodayMs;
  }

  // Über-Mitternacht-Fenster: zwei Hälften.
  if (nowMin >= startMin) {
    // Abend-Hälfte (z.B. 23:30, start=23:00) → Ende liegt am NÄCHSTEN Kalendertag.
    const tomorrow = addCalendarDays(nowParts.year, nowParts.month, nowParts.day, 1);
    return zonedWallTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, e.hour, e.minute, timezone);
  }
  // Morgen-Hälfte (z.B. 02:00, end=07:00) → Ende liegt noch "heute".
  return endTodayMs;
}

/**
 * Klemmt `maxParallel` defensiv auf den gültigen Bereich 1–3 (Edge-Case
 * Spec: "maxParallel außerhalb 1–3 → auf gültigen Bereich klemmen").
 * `TickerSettingsStore.read()` klemmt bereits selbst — dies ist ein
 * zusätzlicher Verteidigungsgürtel für den Fall einer künftigen alternativen
 * Settings-Quelle.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampMaxParallel(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return DEFAULT_MAX_PARALLEL;
  return Math.min(3, Math.max(1, n));
}

/**
 * Wählt die Kandidaten-Projekte für diesen Tick aus dem Board-Index (AC9:
 * "alle Projekte (oder die konfigurierte `projects`-Liste)").
 * Fehlerhafte Index-Einträge (`project.error`) und Einträge ohne
 * `repo_path` werden übersprungen (Board-Scan-Fehler-Edge-Case).
 *
 * @param {Array<object>} index  `BoardAggregator.getIndex()`-Ergebnis
 * @param {"all"|string[]} projectsSetting
 * @returns {Array<{repo_path: string, project_slug: string}>}
 */
export function selectCandidateProjects(index, projectsSetting) {
  if (!Array.isArray(index)) return [];
  const withPath = index.filter((p) => p && !p.error && typeof p.repo_path === 'string' && p.repo_path);

  if (projectsSetting === 'all' || projectsSetting === undefined) return withPath;
  if (!Array.isArray(projectsSetting)) return []; // defensiv: unbekannte Form → nichts drainen

  const allowed = new Set(projectsSetting);
  return withPath.filter((p) => allowed.has(p.project_slug ?? p.slug));
}

// ── NightWatchScheduler ───────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {() => Promise<import('./TickerSettingsStore.js').TickerSettings>} deps.readSettings
 *   Settings-Quelle (S-194 `TickerSettingsStore.read`).
 * @param {{ getIndex: () => Promise<Array<object>> }} deps.boardAggregator  read-only Board-Quelle (AC9).
 * @param {{ drainProject: (path: string, opts?: object) => Promise<object> }} deps.projectDrain
 *   Die zentrale ProjectDrain-Engine (S-192, wiederverwendet, nicht dupliziert).
 * @param {{ getState: Function, waitForReset: Function }} [deps.tokenLimitWatcher]
 *   Konto-weiter Token-Limit-Watcher (S-193). Optional — ohne ihn läuft der
 *   Scheduler ohne Token-Limit-Gate (kein Crash, degradiert).
 * @param {{ getOrCreate: (path: string|null) => object|null }} [deps.sessionRegistry]
 *   `PtySessionRegistry` — nur genutzt um `tokenLimitWatcher.attach()` an die
 *   PTY-Session eines gerade gestarteten Projekt-Drains zu hängen ("welche
 *   Sessions das sind, entscheidet der Scheduler", TokenLimitWatcher-Doku).
 * @param {{ record: Function }} [deps.auditStore]  best-effort Audit für Token-Limit-Pause/Stop.
 * @param {string|null} [deps.identity]  auslösende Identität (Audit + ProjectDrain-Weiterreichung).
 * @param {() => number} [deps.now]  injizierbare Uhr (ms epoch), Default `Date.now`.
 * @param {(ms: number) => Promise<void>} [deps.sleepFn]  injizierbares Sleep (für `waitForReset`), Default echtes `setTimeout`.
 * @param {(fn: Function, ms: number) => *} [deps.setTimeoutFn]  injizierbares `setTimeout`-Äquivalent (Tests).
 * @param {(handle: *) => void} [deps.clearTimeoutFn]  injizierbares `clearTimeout`-Äquivalent (Tests).
 */
export class NightWatchScheduler {
  #readSettings;
  #boardAggregator;
  #projectDrain;
  #tokenLimitWatcher;
  #sessionRegistry;
  #auditStore;
  #identity;
  #now;
  #sleepFn;
  #setTimeoutFn;
  #clearTimeoutFn;

  /** @type {Map<string, Promise<object>>} projectPath → in-flight drainProject()-Promise. */
  #activeDrains = new Map();
  /** @type {Map<string, object>} projectPath → zuletzt an tokenLimitWatcher angehängte PTY-Instanz. */
  #attachedPtys = new Map();
  /** Skip-if-running (Robustheit-NFR, Muster ReconciliationJob). */
  #ticking = false;
  /** @type {*} aktueller Timer-Handle der setTimeout-Kette. */
  #timer = null;
  /** Zuletzt gelesenes Poll-Intervall (ms) — bestimmt den nächsten Tick-Abstand. */
  #lastIntervalMs = DEFAULT_INTERVAL_MINUTES * 60_000;
  /** Dedupe: verhindert wiederholte "token-limit-stop"-Audit-Spam für denselben Reset-Zeitpunkt. */
  #lastAuditedStopResetAt = null;

  constructor({
    readSettings,
    boardAggregator,
    projectDrain,
    tokenLimitWatcher,
    sessionRegistry,
    auditStore,
    identity = null,
    now,
    sleepFn,
    setTimeoutFn,
    clearTimeoutFn,
  } = {}) {
    this.#readSettings = readSettings;
    this.#boardAggregator = boardAggregator;
    this.#projectDrain = projectDrain;
    this.#tokenLimitWatcher = tokenLimitWatcher ?? null;
    this.#sessionRegistry = sessionRegistry ?? null;
    this.#auditStore = auditStore ?? null;
    this.#identity = identity;
    this.#now = now ?? (() => Date.now());
    this.#sleepFn = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#setTimeoutFn = setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeoutFn = clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  // ── Scheduler-Kette (setTimeout, kein Drift, unref) ────────────────────────

  /**
   * Startet den periodischen Scheduler (erster Tick sofort). Idempotent —
   * ein laufender Timer wird zuerst gestoppt.
   */
  start() {
    this.stop();
    this.#scheduleNext(0);
  }

  /** Stoppt den Scheduler (graceful shutdown). */
  stop() {
    if (this.#timer !== null) {
      this.#clearTimeoutFn(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * @param {number} delayMs
   */
  #scheduleNext(delayMs) {
    this.#timer = this.#setTimeoutFn(async () => {
      try {
        await this.tick();
      } catch {
        // Ein Tick-Fehler darf die Kette nie abbrechen (Robustheit-NFR).
      }
      this.#scheduleNext(this.#lastIntervalMs);
    }, delayMs);
    // Blockiert nie den Prozess-Shutdown (Robustheit-NFR, Muster ReconciliationJob).
    if (this.#timer && typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  // ── Ein Tick (öffentlich direkt aufrufbar/testbar) ─────────────────────────

  /**
   * Führt genau einen Poll-Zyklus aus (AC9/AC10/AC11). Skip-if-running:
   * überlappende Aufrufe werden übersprungen (liefert `null`).
   *
   * @returns {Promise<object|null>}
   */
  async tick() {
    if (this.#ticking) return null;
    this.#ticking = true;
    try {
      return await this.#runTick();
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * @returns {Promise<object>}
   */
  async #runTick() {
    this.#reapFinishedDrains();

    let settings;
    try {
      settings = await this.#readSettings();
    } catch {
      return { skipped: true, reason: 'settings-read-failed', activeDrains: this.#activeDrains.size };
    }

    if (Number.isInteger(settings?.intervalMinutes) && settings.intervalMinutes >= 1) {
      this.#lastIntervalMs = settings.intervalMinutes * 60_000;
    }

    // AC16 (S-194, bereits gebaut): enabled=false → Scheduler tut nichts.
    if (!settings?.enabled) {
      return { skipped: true, reason: 'disabled', activeDrains: this.#activeDrains.size };
    }

    const nowMs = this.#now();
    const window = settings.window ?? {};

    if (!isWithinWindow(nowMs, window)) {
      // AC11 Sanftes Ende / außerhalb des Fensters: KEINE neuen Drains;
      // bereits laufende (#activeDrains) werden hier schlicht nicht
      // angefasst — sie laufen über ihre eigene Promise-Kette zu Ende.
      return { skipped: true, reason: 'outside-window', activeDrains: this.#activeDrains.size };
    }

    // Token-Limit-Gate (Konsum von S-193 TokenLimitWatcher, siehe Modul-Doku).
    if (this.#tokenLimitWatcher) {
      const gateResult = await this.#applyTokenLimitGate(nowMs, window);
      if (gateResult) return gateResult; // 'token-limit-stop' → in diesem Tick keine neuen Drains
    }

    const maxParallel = clampMaxParallel(settings.maxParallel);
    const freeSlots = Math.max(0, maxParallel - this.#activeDrains.size);
    if (freeSlots === 0) {
      return { started: [], activeDrains: this.#activeDrains.size };
    }

    let index;
    try {
      index = await this.#boardAggregator.getIndex();
    } catch {
      return { skipped: true, reason: 'board-scan-failed', activeDrains: this.#activeDrains.size };
    }

    const candidates = selectCandidateProjects(index, settings.projects).filter(
      (p) => !this.#activeDrains.has(p.repo_path),
    );

    const started = [];
    for (const project of candidates) {
      if (started.length >= freeSlots) break;
      this.#startDrain(project.repo_path);
      started.push(project.repo_path);
    }

    return { started, activeDrains: this.#activeDrains.size };
  }

  /**
   * Wendet das Token-Limit-Gate an (Konsum von `TokenLimitWatcher`, AC13/14
   * bleiben bei S-193 implementiert — hier wird nur der Aufruf verdrahtet).
   *
   * @param {number} nowMs
   * @param {{start:string,end:string,timezone:string}} window
   * @returns {Promise<object|null>}  ein Tick-Ergebnis wenn dieser Tick mit
   *   "token-limit-stop" abbrechen muss, sonst `null` (weiter mit dem
   *   normalen Drain-Start, entweder weil nicht limitiert oder weil die
   *   Pause bereits erfolgreich abgewartet wurde).
   */
  async #applyTokenLimitGate(nowMs, window) {
    const state = this.#tokenLimitWatcher.getState();
    if (!state?.limited) return null;

    const windowEndMs = computeWindowEndMs(nowMs, window);
    const waitResult = await this.#tokenLimitWatcher.waitForReset({ windowEndMs, sleepFn: this.#sleepFn });

    if (waitResult.paused) {
      this.#lastAuditedStopResetAt = null; // Pause erfolgreich abgewartet → nächster Stop ist wieder neu
      this.#audit(`taktgeber:token-limit-pause resumedAt=${waitResult.resumedAt}`);
      return null; // weiter mit dem normalen Drain-Start in diesem Tick
    }

    if (waitResult.reason === 'exceeds-window') {
      // AC14-Konsum: Reset liegt nach window.end → nicht warten, stoppen,
      // nächste Nacht fortsetzen (kein Kill laufender Drains, AC11).
      if (this.#lastAuditedStopResetAt !== waitResult.resetAt) {
        this.#audit(`taktgeber:token-limit-stop resetAt=${waitResult.resetAt}`);
        this.#lastAuditedStopResetAt = waitResult.resetAt;
      }
      return { skipped: true, reason: 'token-limit-stop', resetAt: waitResult.resetAt, activeDrains: this.#activeDrains.size };
    }

    // reason: 'not-limited' (sollte wegen state.limited-Check oben nicht vorkommen) → weiter.
    return null;
  }

  /**
   * Startet einen Drain für `projectPath` (fire-and-forget aus Tick-Sicht —
   * die Promise wird in `#activeDrains` verfolgt und beim Abschluss wieder
   * entfernt). `ProjectDrain.drainProject()` prüft Busy/Lock selbst (AC6/AC7,
   * S-190/S-192) — kein Doppel-Trigger-Check hier nötig.
   *
   * @param {string} projectPath
   */
  #startDrain(projectPath) {
    this.#attachTokenWatcher(projectPath);
    const promise = this.#projectDrain
      .drainProject(projectPath, { identity: this.#identity })
      .catch(() => null) // ein Drain-Fehler darf den Scheduler nie crashen (Robustheit-NFR)
      .finally(() => this.#activeDrains.delete(projectPath));
    this.#activeDrains.set(projectPath, promise);
  }

  /**
   * Entfernt bereits abgeschlossene Drain-Promises aus der Buchführung.
   * (Die `.finally()`-Callbacks in `#startDrain` erledigen dies bereits
   * asynchron selbst — dieser Aufruf ist ein zusätzlicher, synchroner
   * Cleanup-Punkt zu Beginn jedes Ticks, schadet aber nicht wenn bereits
   * entfernt.)
   */
  #reapFinishedDrains() {
    // No-op by design: Einträge werden ausschließlich über die .finally()-
    // Continuation in #startDrain entfernt (kein synchrones "isSettled"-API
    // für Promises verfügbar). Methode bleibt als Erweiterungspunkt/
    // Dokumentations-Anker für künftige Statusanzeigen (S-197) bestehen.
  }

  /**
   * Hängt `tokenLimitWatcher` an die PTY-Session eines Projekts (konto-weite
   * Erkennung, S-193). Attacht nur einmal PRO Session-INSTANZ — wird die
   * Session (Idle-Timeout) zerstört und neu erstellt, wird erneut attached
   * (Vergleich per Objekt-Referenz, nicht nur per Pfad).
   *
   * @param {string} projectPath
   */
  #attachTokenWatcher(projectPath) {
    if (!this.#tokenLimitWatcher || !this.#sessionRegistry) return;
    let pty;
    try {
      pty = this.#sessionRegistry.getOrCreate(projectPath);
    } catch {
      return; // best-effort — fehlende Session-Anbindung darf den Drain nicht verhindern
    }
    if (!pty) return;
    if (this.#attachedPtys.get(projectPath) === pty) return; // bereits an genau diese Instanz gehängt
    this.#tokenLimitWatcher.attach(pty);
    this.#attachedPtys.set(projectPath, pty);
  }

  /**
   * Best-effort Audit-Eintrag. Ein Audit-Fehler darf den Scheduler nicht
   * crashen (analog `ProjectDrain#auditRecord`).
   * @param {string} command
   */
  #audit(command) {
    if (!this.#auditStore) return;
    try {
      this.#auditStore.record({ identity: this.#identity, command });
    } catch {
      // best-effort — kein Crash
    }
  }

  /**
   * Rein lesender Momentan-Status-Snapshot — Erweiterungspunkt für die
   * Nachtwächter-Statusanzeige (S-197, AC17 "aktuell laufende Drains").
   * Nutzt ausschließlich die in-memory Buchführung dieser Instanz
   * (`#activeDrains`) — kein Board-/PTY-Zugriff, keine Seiteneffekte.
   *
   * @returns {{ activeDrainProjectPaths: string[] }}
   */
  getStatus() {
    return { activeDrainProjectPaths: [...this.#activeDrains.keys()] };
  }
}
