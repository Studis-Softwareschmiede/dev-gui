/**
 * NightWatchScheduler — Nachtfenster-Scheduler für den Taktgeber/Nachtwächter
 * (docs/specs/taktgeber-nachtwaechter.md AC9, AC10, AC11; erweitert um
 * docs/specs/headless-parallel-drain.md AC7, AC8, AC9, AC11, AC12, S-213;
 * Registrierung in der geteilten persistenten Drain-Job-Registry —
 * docs/specs/drain-restart-robustness.md AC3, S-282;
 * `windowEndMs`-Weiterreichung an den Nacht-Drain —
 * docs/specs/night-budget-guard.md AC10, S-274).
 *
 * windowEndMs-Weiterreichung (night-budget-guard AC10, S-274):
 *   `#runTick` bestimmt je Tick das für "jetzt" GÜLTIGE Fensterende
 *   (`computeWindowEndMs(nowMs, window)` — dieselbe bereits vorhandene
 *   TZ-Wandzeit-Logik, keine eigene) und reicht es an jeden in diesem Tick
 *   frisch gestarteten Nacht-Drain (`#startDrain` → `opts.windowEndMs`)
 *   weiter, damit dessen Budget-Pausen (`server.js` injiziert den
 *   konkreten `BudgetGuard` in `nightProjectDrain`, S-274) das sanfte
 *   Fensterende ehren (A2/AC6) statt darüber hinaus zu warten. Der `null`-
 *   Fall (nicht-parsebare Fenster-Konfig) wird unverändert durchgereicht —
 *   `ProjectDrain` behandelt `windowEndMs:null` als "kein Fenster" (A2).
 *
 * Nacht-Drain-Registrierung (drain-restart-robustness AC3, S-282):
 *   `#startDrain` registriert jeden in-flight Nacht-Drain ZUSÄTZLICH in der
 *   geteilten, datei-persistierten `DrainJobRegistry` (`trigger:'night'`, eine
 *   frisch generierte `drainId`, Projekt-Slug — kein absoluter Pfad) und
 *   markiert ihn beim Abschluss terminal (`markDone`/`markFailed`). Das
 *   bestehende `#activeDrains`-Concurrency-Tracking bleibt davon vollständig
 *   UNVERÄNDERT — rein additive Erfassung, damit ein neugestarteter/
 *   abgestürzter Nacht-Drain nach einem Server-Neustart einen wiederauffindbaren
 *   `running`-Eintrag hinterlässt (statt still verloren zu gehen, s. Vorfall
 *   2026-07-02 in der Spec-Einleitung). Optional/best-effort — ohne injizierte
 *   `drainJobRegistry` läuft der Scheduler unverändert (No-op, Degradation);
 *   ein Registrierungs-/Markierungs-Fehler crasht den Scheduler NIE (analog
 *   `#recordNightReport`). Ohne gültigen Projekt-Slug wird NICHT registriert
 *   (kein leerer/ungültiger Slug in der Persistenz).
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
 * verifiziert critical, siehe `.claude/lessons/coder.md` 2026-07-01) —
 * HISTORISCH, gilt nur solange dieser Scheduler mit einer INTERAKTIV
 * verdrahteten `ProjectDrain`-Instanz betrieben wird (siehe darunter, S-213):
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
 *   das Projekt wird beim nächsten Poll erneut versucht.
 *
 * ECHTE Parallelität (S-213, docs/specs/headless-parallel-drain.md AC7/AC8):
 *   Die Composition-Root (`server.js`) verdrahtet diesen Scheduler mit einer
 *   EIGENEN `ProjectDrain`-Instanz, deren `flowRunner` ein
 *   `HeadlessFlowRunnerAdapter` (`src/FlowRunner.js`) ist — jeder `/flow`-
 *   Anstoß läuft dadurch als eigener `claude -p`-Kindprozess (kein globaler
 *   PTY-`JobLock`, nur ein projektweises `ProjectJobLock` des Kindprozess-
 *   Runners, EIGENE Instanz — NICHT die `ProjectDrain`-Lock-Instanz, sonst
 *   Selbst-Blockade). Bis zu `maxParallel` Projekte drainen damit ECHT
 *   gleichzeitig (mehrere unabhängige OS-Subprozesse). Der oben beschriebene
 *   Engpass (`command-channel-busy`) tritt im Headless-Modus strukturell
 *   NICHT mehr auf (AC8) — der manuelle „Board abarbeiten"-Knopf (S-196)
 *   nutzt weiterhin eine SEPARATE, interaktiv verdrahtete `ProjectDrain`-
 *   Instanz und bleibt davon unberührt (AC6, bit-identisches Verhalten).
 *
 * sessionRegistry-Naht — Attach (hier) vs. Busy-Check (`ProjectDrain`), CRITICAL-
 * Fix S-213 Iteration 2 (live reproduziert, siehe `.claude/lessons/coder.md`
 * 2026-07-01 "attachTokenWatcher (PTY-Session-CREATE) läuft VOR isProjectBusy()
 * (PTY-Session-EXISTS)"): `server.js` injiziert DIESELBE `sessionRegistry`
 * (`ptyRegistry`) in ZWEI Collaborators mit UNTERSCHIEDLICHEM Zweck:
 *   (1) hier, `#attachTokenWatcher()` — hängt den `TokenLimitWatcher` an eine
 *       PTY-Session (S-193, konto-weite Token-Limit-Erkennung).
 *   (2) `ProjectDrain#drainProject()`s allererster Schritt, `isProjectBusy()`
 *       (`ProjectJobLock.js`) — fragt `sessionRegistry.hasSession(projectPath)`
 *       (NICHT-mutierend) ab, um eine UNABHÄNGIG vom Scheduler entstandene
 *       (z.B. manuell in der UI geöffnete) Session als "busy" zu erkennen
 *       (kein Doppel-Trigger, AC7 taktgeber-nachtwaechter).
 * `#attachTokenWatcher()` ruft daher NIEMALS `getOrCreate()` (das eine PTY-
 * Session ERZEUGEN würde) ohne vorherigen `hasSession()`-Check — sonst würde
 * (1) genau die Session-EXISTENZ herstellen, die (2) unmittelbar danach als
 * "busy" liest (Selbst-Blockade, `already-busy`, `flowRunner.startRun()` wird
 * NIE aufgerufen — der Normalfall JEDEN automatischen Nacht-Ticks für ein
 * Projekt ohne bereits offene manuelle PTY-Session). Im Headless-Nacht-Modus
 * gibt es ohnehin keine PTY-Ausgabe zum Mitlesen (`claude -p` schreibt auf
 * stdout/stderr des Kindprozesses, nicht in eine PTY) — ein Attach ohne
 * bereits bestehende Session entfällt daher im Headless-Modus vollständig
 * (die headless-Token-Limit-Erkennung selbst bleibt ein separates,
 * spec-benanntes Restrisiko, docs/specs/headless-parallel-drain.md
 * Abschnitt "Restrisiko" — NICHT Teil dieser Story). Details siehe
 * `#attachTokenWatcher()` unten.
 *
 * Auth-Vorabprüfung (S-213 AC9): vor jedem Tick, der neue Drains starten
 * würde, wird — sofern injiziert — `claudeAuthHealthService.getState()`
 * geprüft. Bei `claudeAuth:'expired'` startet dieser Tick KEINE neuen Drains
 * (spart Fehl-Läufe gegen eine abgelaufene Container-Anmeldung) und der
 * Umstand wird EINMALIG auditiert (Dedupe, kein Audit-Spam pro Tick, analog
 * zum bestehenden `token-limit-stop`-Dedupe unten). `'unknown'`/`'ok'`
 * blockieren nicht (kein Fehlalarm-Stop, AC9).
 *
 * Nicht in dieser Story (bewusst NICHT gebaut):
 *   - „Board abarbeiten"-Knopf-Umbau (S-196) / Settings-API (S-194, fertig)
 *     / UI (S-197).
 *   - Kein eigener Board-Schreibpfad — Eskalation bleibt Sache von
 *     `ProjectDrain`/`BoardWriter` (S-191/S-192).
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

import { randomUUID } from 'node:crypto';
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
 * @param {{ hasSession: (path: string) => boolean, getOrCreate: (path: string|null) => object|null }} [deps.sessionRegistry]
 *   `PtySessionRegistry` — nur genutzt um `tokenLimitWatcher.attach()` an die
 *   PTY-Session eines gerade gestarteten Projekt-Drains zu hängen ("welche
 *   Sessions das sind, entscheidet der Scheduler", TokenLimitWatcher-Doku).
 * @param {{ record: Function }} [deps.auditStore]  best-effort Audit für Token-Limit-Pause/Stop.
 * @param {{ getState: () => { claudeAuth: 'ok'|'expired'|'unknown', lastCheckedAt: string|null } }} [deps.claudeAuthHealthService]
 *   Auth-Vorabprüfung (S-213 AC9). Optional — ohne ihn läuft der Scheduler ohne Auth-Gate (kein Crash, degradiert).
 * @param {{ runCheck: (trigger?: string) => Promise<object> }} [deps.costModeModelCheck]
 *   Cost-Mode-Frische-Prüfung beim Dispatch (cost-mode-model-check AC4/AC5,
 *   Wiederverwendung der S-211-Boundary). Optional — vor jedem Nacht-Drain-Start
 *   wird `runCheck('dispatch')` fire-and-forget angestoßen (blockiert den
 *   Drain-Start NIE, AC5). Ohne ihn läuft der Scheduler unverändert.
 * @param {{ record: (r: object) => Promise<object> }} [deps.drainReportStore]
 *   Abschlussbericht-Ablage (drain-completion-report AC6, geteilte Instanz mit
 *   dem manuellen Drain). Optional — bei jedem abgeschlossenen Nacht-Drain wird
 *   best-effort GENAU EIN Bericht (`trigger:'night'`) geschrieben. Ersetzt den
 *   früheren `.catch(() => null)`-Ergebnisverlust: das (erfolgreiche wie
 *   fehlgeschlagene) Drain-Ergebnis wird ERFASST statt verworfen; ein
 *   Store-/Drain-Fehler crasht den Scheduler weiterhin NICHT (best-effort).
 * @param {{ notifyDrainComplete: (projectPath: string, drainResult: object) => void }} [deps.autoRetroTrigger]
 *   Auto-Retro-Auslöser an der Drain-Abschluss-Naht (retro-auto-trigger AC4–AC7,
 *   `AutoRetroTrigger`, geteilte Instanz mit dem manuellen Drain). Optional —
 *   bei jedem abgeschlossenen Nacht-Drain wird best-effort/fire-and-forget der
 *   Auto-Retro-Check angestoßen (`isRetroDue` → ggf. `enqueue` in die geteilte
 *   `RetroAutoQueue`). Strikt best-effort: `notifyDrainComplete` gibt sofort
 *   synchron zurück und wirft nie — der Nacht-Tick/Drain-Abschluss bleibt bei
 *   jedem Check-Fehler unberührt (AC4). Ohne ihn läuft der Scheduler unverändert.
 * @param {{ notifyDrainDone: (args: { slug: string, result: object }) => Promise<void> }} [deps.drainNotifier]
 *   Drain-Fertig-Push (drain-done-notification AC4/AC6, `DrainNotifier`, geteilte
 *   Instanz mit dem manuellen Drain — kein zweiter Config-Pfad). Optional — bei
 *   jedem abgeschlossenen Nacht-Drain wird best-effort GENAU EIN Push angestoßen
 *   (`notifyDrainDone({ slug, result })`, `slug` = der bereits abgeleitete
 *   Projekt-Slug). `notifyDrainDone` wirft selbst nie (best-effort,
 *   drain-done-notification AC4/AC5/AC7); ohne ihn läuft der Scheduler unverändert.
 * @param {{ register: Function, markDone: Function, markFailed: Function }} [deps.drainJobRegistry]
 *   Geteilte, datei-persistierte Drain-Job-Registry (drain-restart-robustness AC1–AC3,
 *   `DrainJobRegistry`, GETEILTE Instanz mit dem manuellen `projectDrainRouter` —
 *   kein zweiter Config-/Datei-Pfad). Optional — bei jedem gestarteten Nacht-Drain
 *   wird best-effort GENAU EIN `register(drainId,{project,trigger:'night',startedAt})`
 *   aufgerufen (neue `drainId` je Drain), bei Abschluss `markDone`/`markFailed`
 *   mit derselben `drainId`. Ohne ihn läuft der Scheduler unverändert (No-op,
 *   Degradation); ein Registry-Fehler crasht den Scheduler NIE.
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
  #claudeAuthHealthService;
  #costModeModelCheck;
  #drainReportStore;
  #autoRetroTrigger;
  #drainNotifier;
  #drainJobRegistry;
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
  /** Dedupe: verhindert wiederholten "auth-expired-skip"-Audit-Spam über mehrere Ticks hinweg (AC9). */
  #lastAuditedAuthExpired = false;

  constructor({
    readSettings,
    boardAggregator,
    projectDrain,
    tokenLimitWatcher,
    sessionRegistry,
    auditStore,
    claudeAuthHealthService,
    costModeModelCheck,
    drainReportStore,
    autoRetroTrigger,
    drainNotifier,
    drainJobRegistry,
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
    this.#claudeAuthHealthService = claudeAuthHealthService ?? null;
    this.#costModeModelCheck = costModeModelCheck ?? null;
    this.#drainReportStore = drainReportStore ?? null;
    this.#autoRetroTrigger = autoRetroTrigger ?? null;
    this.#drainNotifier = drainNotifier ?? null;
    this.#drainJobRegistry = drainJobRegistry ?? null;
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

    // AC9 Auth-Vorabprüfung: bei abgelaufener Container-Anmeldung KEINE neuen
    // Drains in diesem Tick (spart Fehl-Läufe). Bereits laufende Drains
    // (#activeDrains) werden NICHT angefasst — analog AC11/AC12 Sanftes Ende.
    if (this.#claudeAuthHealthService) {
      const authGateResult = this.#applyAuthGate();
      if (authGateResult) return authGateResult;
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

    // night-budget-guard AC10: das für "jetzt" GÜLTIGE Fensterende (Wieder-
    // verwendung von `computeWindowEndMs`, keine eigene TZ-Logik) wird an
    // JEDEN in diesem Tick gestarteten Nacht-Drain gereicht, damit dessen
    // Budget-Pausen das sanfte Fensterende ehren können (A2, AC6).
    const windowEndMs = computeWindowEndMs(nowMs, window);

    const started = [];
    for (const project of candidates) {
      if (started.length >= freeSlots) break;
      // drain-completion-report AC6: der Projekt-Slug (kein Pfad) wird an
      // #startDrain gereicht, damit der Abschlussbericht ihn als `project`
      // führt. Fällt der Slug im Index (defensiv) weg → null, der Bericht wird
      // dann übersprungen (best-effort), ohne den Drain zu beeinträchtigen.
      this.#startDrain(project.repo_path, project.project_slug ?? project.slug ?? null, windowEndMs);
      started.push(project.repo_path);
    }

    return { started, activeDrains: this.#activeDrains.size };
  }

  /**
   * Auth-Vorabprüfung (S-213 AC9): bei `claudeAuth:'expired'` startet dieser
   * Tick keine neuen Drains. `'unknown'`/`'ok'` blockieren nicht (kein
   * Fehlalarm-Stop). Dedupe verhindert Audit-Spam über mehrere Ticks hinweg,
   * solange die Anmeldung durchgängig abgelaufen bleibt (analog
   * `#lastAuditedStopResetAt` beim Token-Limit-Gate).
   *
   * @returns {object|null}  ein Tick-Ergebnis wenn dieser Tick mit
   *   "auth-expired" abbrechen muss, sonst `null` (weiter mit dem normalen
   *   Drain-Start).
   */
  #applyAuthGate() {
    const state = this.#claudeAuthHealthService.getState();
    if (state?.claudeAuth !== 'expired') {
      this.#lastAuditedAuthExpired = false; // Anmeldung (wieder) gesund/unbekannt → nächster Stop ist wieder neu
      return null;
    }
    if (!this.#lastAuditedAuthExpired) {
      this.#audit(`taktgeber:auth-expired-skip lastCheckedAt=${state.lastCheckedAt ?? ''}`);
      this.#lastAuditedAuthExpired = true;
    }
    return { skipped: true, reason: 'auth-expired', activeDrains: this.#activeDrains.size };
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
   * @param {string|null} [projectSlug]  Projekt-Slug für den Abschlussbericht (AC6).
   * @param {number|null} [windowEndMs]  night-budget-guard AC10: das für "jetzt"
   *   gültige Nachtfenster-Ende (`computeWindowEndMs`), an `ProjectDrain.drainProject()`
   *   gereicht, damit Budget-Pausen das sanfte Fensterende ehren (A2, AC6).
   */
  #startDrain(projectPath, projectSlug = null, windowEndMs = null) {
    this.#attachTokenWatcher(projectPath);
    // cost-mode-model-check AC4/AC5: Dispatch-Frische-Prüfung unmittelbar vor der
    // Cost-Mode-Übergabe an den Nacht-Drain — fire-and-forget, blockiert den
    // Drain-Start NIE (AC5). Der drainProject-Aufruf unten läuft unabhängig; der
    // Curator-Anstoß in runCheck ist asynchron/best-effort mit eigener Runner-/
    // Lock-Instanz (getrennt vom Nacht-Drain-Lock, keine Selbst-/Fremdblockade).
    this.#runCostModeDispatchCheck();
    // drain-completion-report AC6: Startzeitpunkt für den Bericht erfassen
    // (injizierbare Uhr, testbar). Nur ein Zeitstempel — kein Secret/Pfad.
    const startedAt = new Date(this.#now()).toISOString();
    // drain-restart-robustness AC3: Nacht-Drain zusätzlich in der geteilten
    // persistenten Registry führen (best-effort, additiv — #activeDrains bleibt
    // unverändert die maßgebliche Concurrency-Buchführung dieser Klasse).
    const drainId = this.#registerNightDrain(projectSlug, startedAt);
    const promise = this.#projectDrain
      .drainProject(projectPath, { identity: this.#identity, windowEndMs })
      // AC6: das (erfolgreiche wie fehlgeschlagene) Drain-Ergebnis wird ERFASST
      // statt — wie früher via `.catch(() => null)` — verworfen; danach best-
      // effort GENAU EIN Bericht (`trigger:'night'`). Ein Drain-Fehler darf den
      // Scheduler NIE crashen: onRejected schreibt einen secret-freien
      // `reason:'drain-failed'`-Bericht; das abschließende `.catch(() => null)`
      // schluckt einen etwaigen Fehler der Bericht-Erfassung selbst.
      .then(
        (result) => {
          this.#markNightDrainDone(drainId, result ?? {});
          this.#recordNightReport(projectSlug, result ?? {}, startedAt);
          // retro-auto-trigger AC4/AC6: nach dem abgeschlossenen Nacht-Drain den
          // Auto-Retro-Check best-effort/fire-and-forget anstoßen (isRetroDue →
          // ggf. enqueue). `notifyDrainComplete` gibt sofort synchron zurück und
          // wirft nie — der Nacht-Drain-Abschluss bleibt bei Check-Fehler unberührt.
          this.#notifyAutoRetro(projectPath, result ?? {});
          // drain-done-notification AC4: best-effort GENAU EIN Drain-Fertig-Push
          // (slug = der bereits abgeleitete Projekt-Slug). Gating lebt komplett
          // im DrainNotifier selbst (flowRuns<=0/enabled=false/Event-Gating).
          this.#notifyDrainDone(projectSlug, result ?? {});
        },
        () => {
          this.#markNightDrainFailed(drainId);
          this.#recordNightReport(projectSlug, { reason: 'drain-failed', flowRuns: 0, completed: [], blocked: [] }, startedAt);
          // Fehlgeschlagener Drain: flowRuns:0 → isRetroDue == false (kein Enqueue).
          // Der Aufruf bleibt dennoch symmetrisch (AC4: „nach JEDEM Drain").
          this.#notifyAutoRetro(projectPath, { reason: 'drain-failed', flowRuns: 0 });
          // drain-done-notification AC4: symmetrischer Aufruf ("je abgeschlossenem
          // Projekt-Drain") — flowRuns:0 → DrainNotifier selbst gated auf kein
          // Push (A1), kein zusätzliches Verhalten hier.
          this.#notifyDrainDone(projectSlug, { reason: 'drain-failed', flowRuns: 0 });
        },
      )
      .catch(() => null)
      .finally(() => this.#activeDrains.delete(projectPath));
    this.#activeDrains.set(projectPath, promise);
  }

  /**
   * Registriert den in-flight Nacht-Drain best-effort in der geteilten
   * persistenten `DrainJobRegistry` (drain-restart-robustness AC3). No-op ohne
   * injizierte Registry oder ohne gültigen Projekt-Slug (analog
   * `#recordNightReport`s Slug-Guard — kein leerer/ungültiger Slug in der
   * Persistenz). Ein Registrierungsfehler crasht den Scheduler NIE.
   *
   * @param {string|null} projectSlug
   * @param {string} startedAt  ISO-8601
   * @returns {string|null}  die generierte `drainId`, oder `null` wenn NICHT
   *   registriert wurde (kein Store injiziert / kein gültiger Slug / Fehler).
   */
  #registerNightDrain(projectSlug, startedAt) {
    if (!this.#drainJobRegistry || typeof this.#drainJobRegistry.register !== 'function') return null;
    if (typeof projectSlug !== 'string' || projectSlug === '') return null;
    try {
      const drainId = randomUUID();
      const p = this.#drainJobRegistry.register(drainId, { project: projectSlug, trigger: 'night', startedAt });
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return drainId;
    } catch {
      // best-effort — die Registrierung darf den Scheduler nie crashen.
      return null;
    }
  }

  /**
   * Markiert den Nacht-Drain-Registry-Eintrag terminal als `done` (drain-restart-
   * robustness AC3). No-op ohne `drainId` (nicht registriert) oder ohne Registry.
   * Ein Markierungsfehler crasht den Scheduler NIE.
   *
   * @param {string|null} drainId
   * @param {object} result
   */
  #markNightDrainDone(drainId, result) {
    if (!drainId || !this.#drainJobRegistry || typeof this.#drainJobRegistry.markDone !== 'function') return;
    try {
      const p = this.#drainJobRegistry.markDone(drainId, result ?? {});
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // best-effort — die Markierung darf den Scheduler nie crashen.
    }
  }

  /**
   * Markiert den Nacht-Drain-Registry-Eintrag terminal als `failed` (drain-restart-
   * robustness AC3). No-op ohne `drainId` (nicht registriert) oder ohne Registry.
   * Ein Markierungsfehler crasht den Scheduler NIE.
   *
   * @param {string|null} drainId
   */
  #markNightDrainFailed(drainId) {
    if (!drainId || !this.#drainJobRegistry || typeof this.#drainJobRegistry.markFailed !== 'function') return;
    try {
      const p = this.#drainJobRegistry.markFailed(drainId);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // best-effort — die Markierung darf den Scheduler nie crashen.
    }
  }

  /**
   * Schreibt best-effort GENAU EINEN Nacht-Abschlussbericht in die geteilte
   * DrainReportStore-Instanz (drain-completion-report AC6). No-op ohne Store
   * oder ohne gültigen Slug. Ein Store-/Schreibfehler ist non-fatal — er darf
   * den Scheduler nie crashen (best-effort, Robustheits-NFR).
   *
   * @param {string|null} projectSlug  Projekt-Slug (kein Pfad); null → übersprungen.
   * @param {{ reason?: string, flowRuns?: number, completed?: object[], blocked?: object[], budgetPauses?: object[] }} result
   * @param {string} startedAt  ISO-8601 Startzeitpunkt des Drains
   */
  #recordNightReport(projectSlug, result, startedAt) {
    if (!this.#drainReportStore || typeof this.#drainReportStore.record !== 'function') return;
    if (typeof projectSlug !== 'string' || projectSlug === '') return;
    const r = result ?? {};
    try {
      const p = this.#drainReportStore.record({
        project: projectSlug,
        trigger: 'night',
        startedAt,
        finishedAt: new Date(this.#now()).toISOString(),
        reason: typeof r.reason === 'string' ? r.reason : '',
        flowRuns: Number.isFinite(r.flowRuns) ? r.flowRuns : 0,
        completed: Array.isArray(r.completed) ? r.completed : [],
        blocked: Array.isArray(r.blocked) ? r.blocked : [],
        // night-budget-guard AC12: additiv durchgereicht — Alt-Aufrufe ohne
        // das Feld (z.B. der drain-failed-Zweig unten) → [] (kein Regress).
        budgetPauses: Array.isArray(r.budgetPauses) ? r.budgetPauses : [],
      });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // best-effort — die Bericht-Erfassung darf den Scheduler nie crashen.
    }
  }

  /**
   * Stößt den Auto-Retro-Check an der Drain-Abschluss-Naht an (retro-auto-trigger
   * AC4/AC5/AC6). No-op ohne injizierten `autoRetroTrigger`. Strikt best-effort:
   * `notifyDrainComplete` gibt selbst sofort synchron zurück und wirft nie — das
   * zusätzliche try/catch ist reine Tiefenverteidigung, damit der Nacht-Drain-
   * Abschluss unter keinen Umständen crasht (AC4).
   *
   * @param {string} projectPath  gerade gedrainter Projekt-Repo-Pfad (Queue-Dedup-Schlüssel).
   * @param {{ flowRuns?: number }} result  Drain-Ergebnis (nur `flowRuns` relevant).
   */
  #notifyAutoRetro(projectPath, result) {
    if (!this.#autoRetroTrigger || typeof this.#autoRetroTrigger.notifyDrainComplete !== 'function') return;
    try {
      this.#autoRetroTrigger.notifyDrainComplete(projectPath, result ?? {});
    } catch {
      // best-effort — der Auto-Retro-Check darf den Drain-Abschluss nie crashen (AC4).
    }
  }

  /**
   * Stößt best-effort GENAU EINEN Drain-Fertig-Push an der Nacht-Drain-
   * Abschluss-Naht an (drain-done-notification AC4, GETEILTE `DrainNotifier`-
   * Instanz mit dem manuellen Drain). No-op ohne injizierten `drainNotifier`.
   * `notifyDrainDone` selbst wirft nie (best-effort, drain-done-notification
   * AC4/AC5/AC7) — das try/catch ist reine Tiefenverteidigung, damit der
   * Nacht-Drain-Abschluss/Scheduler unter keinen Umständen crasht.
   *
   * @param {string|null} projectSlug  der bereits abgeleitete Projekt-Slug (kein Pfad).
   * @param {object} result  Drain-Ergebnis (flowRuns/completed/blocked/budgetPauses relevant).
   */
  #notifyDrainDone(projectSlug, result) {
    if (!this.#drainNotifier || typeof this.#drainNotifier.notifyDrainDone !== 'function') return;
    if (typeof projectSlug !== 'string' || projectSlug === '') return;
    try {
      const p = this.#drainNotifier.notifyDrainDone({ slug: projectSlug, result: result ?? {} });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // best-effort — der Drain-Fertig-Push darf den Scheduler nie crashen.
    }
  }

  /**
   * Stößt die Cost-Mode-Frische-Prüfung fire-and-forget an (cost-mode-model-check
   * AC4/AC5, Wiederverwendung der S-211-Boundary). NICHT-BLOCKIEREND: das
   * zurückgegebene Promise wird bewusst NICHT awaitet — nur mit `.catch()` gegen
   * unhandled rejections abgesichert. `CostModeModelCheck.runCheck` hat selbst
   * ein Skip-if-running (ein Curator-Lauf zur Zeit), sodass ein wiederholter
   * Anstoß je Drain-Start unschädlich ist. Ohne injizierte Boundary → No-op.
   */
  #runCostModeDispatchCheck() {
    if (!this.#costModeModelCheck || typeof this.#costModeModelCheck.runCheck !== 'function') return;
    try {
      const result = this.#costModeModelCheck.runCheck('dispatch');
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // best-effort — die Prüfung darf den Drain-Start nie verhindern (AC5).
    }
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
   * NICHT-ERZEUGEND (S-213 headless-parallel-drain, CRITICAL-Fix Iteration 2,
   * siehe `.claude/lessons/coder.md` 2026-07-01 "attachTokenWatcher (PTY-
   * Session-CREATE) läuft VOR isProjectBusy() (PTY-Session-EXISTS)"): attacht
   * NUR, wenn `sessionRegistry.hasSession(projectPath)` bereits `true` ist —
   * niemals via `getOrCreate()` selbst eine PTY-Session anlegen. Grund: in
   * `server.js` teilen `NightWatchScheduler` (hier) UND `ProjectDrain` (für
   * `isProjectBusy()`, siehe `ProjectDrain.js`) dieselbe `sessionRegistry`-
   * Instanz (`ptyRegistry`). Würde hier `getOrCreate()` aufgerufen, legt das
   * für ein frisches Projekt OHNE offene manuelle Session GERADE JETZT eine
   * neue PTY-Session an — `ProjectDrain#drainProject()`s allererster Schritt
   * (`isProjectBusy()` → `sessionRegistry.hasSession()`) sieht diese Session
   * dann als "aktiv" und bricht sofort mit `already-busy` ab, OHNE
   * `flowRunner.startRun()` je aufzurufen (Selbst-Blockade — live
   * reproduziert: `started:[proj]`, aber `spawnCount` blieb 0). Im
   * Headless-Nacht-Modus gibt es ohnehin KEINE PTY-Ausgabe zum Mitlesen —
   * `claude -p` schreibt auf stdout/stderr des Kindprozesses, nicht in eine
   * PTY (siehe `HeadlessRunnerCore`/`combinedOutput`) — ein Attach ohne
   * bereits bestehende (z.B. manuell in der UI geöffnete) Session wäre also
   * ohnehin nutzlos für die Token-Limit-Erkennung. Die headless-Token-Limit-
   * Erkennung selbst ist ein separates, spec-benanntes Restrisiko
   * (docs/specs/headless-parallel-drain.md, Abschnitt "Restrisiko") — NICHT
   * Teil dieser Story. Das fremd-erzeugte (z.B. manuell geöffnete)
   * Session-Signal für `isProjectBusy()` bleibt davon unberührt: `hasSession`
   * (non-mutating) prüft weiterhin exakt wie zuvor.
   *
   * @param {string} projectPath
   */
  #attachTokenWatcher(projectPath) {
    if (!this.#tokenLimitWatcher || !this.#sessionRegistry) return;
    let hasSession;
    try {
      hasSession = this.#sessionRegistry.hasSession(projectPath);
    } catch {
      return; // best-effort — fehlende Session-Anbindung darf den Drain nicht verhindern
    }
    if (!hasSession) return; // kein getOrCreate() — keine Session erzeugen (Selbst-Blockade-Vermeidung)
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
