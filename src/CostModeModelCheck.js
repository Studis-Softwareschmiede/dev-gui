/**
 * CostModeModelCheck — schmale dev-gui-Boundary für die periodische
 * Cost-Mode-Modellprüfung (docs/specs/cost-mode-model-check.md,
 * Kern-Anteil S-211: AC1, AC2, AC3, AC6, AC7).
 *
 * Zweck (A2/A3/A4/A5): dev-gui besitzt die maßgebliche Rolle×Modus→Modell-Matrix
 * NICHT — sie lebt agent-flow-seitig (`knowledge/model-tiers.md`, kuratiert vom
 * Sondermodus `/train model-tiers`). Diese Klasse liest ausschließlich das
 * **Frische-Signal** dieser Matrix (`last_curated`-Datum) READ-ONLY und stößt bei
 * Drift den agent-flow-Curator **headless** an. Sie MUTIERT `model-tiers.md`
 * NIEMALS selbst (NFR Sicherheit, Grep-prüfbar: nur `readFile`, kein `writeFile`).
 *
 * Auslöser dieser Story (Kern):
 *   - Boot (AC1): `start()` fährt beim Prozess-Boot EINEN Check fire-and-forget
 *     an (blockiert den Boot nicht; Plugin/Datei fehlt → still übersprungen).
 *   - Periodisch (AC1/AC2): ein setTimeout-Tick (Default 1×/Tag, Muster
 *     `ReconciliationJob`/`NightWatchScheduler`) wiederholt denselben Check.
 *   Der Dispatch-Auslöser (vor Cost-Mode-Übergabe an einen Drain) + die
 *   Frontend-Meldung/Vorher-Nachher-Übersicht sind die Folge-Story S-228
 *   (AC4/AC5/AC3-Frontend-Teil) — NICHT Teil dieser Klasse.
 *
 * Verhalten je Check:
 *   - Signal frisch (innerhalb Cooldown, AC2): KEINERLEI Meldung, KEIN
 *     Curator-Anstoß, kein Job-Eintrag. Stiller Normalfall.
 *   - Drift (außerhalb Cooldown / `never` / leer, AC3): kurze Log-Meldung,
 *     Curator-Anstoß `claude -p '/agent-flow:train model-tiers'` über die
 *     **eigene** `HeadlessFlowRunner`-Instanz (mit ihrer **eigenen**
 *     `ProjectJobLock`-Instanz — AC7-Isolation, getrennt von Nacht-Drain/
 *     Reconcile/Finalizer/manuellem Drain); Job-Registry-Eintrag
 *     `checkId → { status, changed?, before?, after? }`; Audit-First.
 *
 * Cooldown (A5): „max. 1× pro Kalendermonat" — Signal ist frisch, wenn
 * `last_curated` im aktuellen Kalendermonat liegt (Jahr+Monat == heute, UTC);
 * andernfalls (früherer Monat / `never` / unparsebar) → Drift.
 *
 * AC6 (delegiert + dokumentiert): der Auswahlbarkeits-Filter „nur angebotene UND
 * auswählbare Modelle; nicht-auswählbare (`Mythos`/`Fable`) ausschließen" wird
 * VOLLSTÄNDIG im agent-flow-Curator durchgesetzt. dev-gui besitzt KEINEN
 * Live-Modell-Auswahlbarkeits-Check und führt hier KEINEN eigenen Filter ein.
 *
 * Vorher/Nachher (AC3): leichtgewichtig auf Basis des Frische-Signals — `before`
 * = `{ lastCurated }` vor dem Lauf, `after` = re-gelesenes `{ lastCurated }` nach
 * dem Lauf, `changed` = ob sich `lastCurated` geändert hat. Ein maschinenlesbares
 * Matrix-Diff wäre ein agent-flow-seitiger Vorgang (Spec „Offene Fragen 1",
 * Out-of-scope).
 *
 * Nicht-Blockierung (AC5-Analogon): der Curator-Anstoß + die Poll-Schleife auf
 * seinen Abschluss laufen im Hintergrund (fire-and-forget); Boot/Tick warten
 * nie darauf. `runCheck()` gibt bei Drift ein `done`-Promise zurück, das den
 * Curator-Zyklus abbildet — Produktion ignoriert es, Tests können es awaiten.
 *
 * Security (Floor):
 *   - READ-ONLY auf `model-tiers.md` (kein Schreibpfad).
 *   - Keine Secrets/Token/absoluten Host-Pfade in Audit/Log/Response — `before`/
 *     `after` enthalten nur das (nicht-geheime) `last_curated`-Datum.
 *   - Keine hartkodierten Secrets; der Curator-Kindprozess erbt keine API-Keys
 *     (Trust-Boundary im `HeadlessRunnerCore`).
 *
 * Injectable (Test-Entkopplung): `pluginRootResolver`, `fsDeps.readFile`,
 * `flowRunner`, `auditStore`, `now`, `sleepFn`, `setTimeoutFn`/`clearTimeoutFn`.
 *
 * @module CostModeModelCheck
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Curator-Befehl + Args (A4): `claude -p '/agent-flow:train model-tiers'`. */
export const CURATOR_COMMAND = '/agent-flow:train';
export const CURATOR_ARGS = ['model-tiers'];

/** Default periodisches Prüf-Intervall (AC1) — 1×/Tag. */
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/** Default Poll-Intervall für den Curator-Abschluss (Hintergrund). */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 1000; // 5s

/** Relativer Pfad der Matrix-Datei unterhalb des agent-flow-Plugin-Roots. */
const MODEL_TIERS_REL_PATH = ['knowledge', 'model-tiers.md'];

// ── Pure Helpers (kein IO — direkt unit-testbar) ──────────────────────────────

/**
 * Extrahiert das `last_curated`-Datum aus dem Inhalt von `model-tiers.md`.
 *
 * Akzeptierte Formen (Header-Blockquote ODER YAML-artig):
 *   `> **last_curated:** 2026-06-10 — …`   → "2026-06-10"
 *   `last_curated: 2026-06-10`             → "2026-06-10"
 *   `last_curated: never` / fehlt          → null
 *
 * @param {unknown} content
 * @returns {string|null}  ISO-Datum "YYYY-MM-DD" oder null (never/leer/unparsebar).
 */
export function parseLastCurated(content) {
  if (typeof content !== 'string') return null;
  const m = /last_curated:\**\s*(\d{4}-\d{2}-\d{2}|never)/i.exec(content);
  if (!m) return null;
  if (m[1].toLowerCase() === 'never') return null;
  return m[1];
}

/**
 * Prüft, ob das Frische-Signal innerhalb des Cooldowns (aktueller Kalendermonat)
 * liegt (AC2). `null`/unparsebar → nicht frisch (Drift, AC3).
 *
 * Cooldown-Definition (A5): „max. 1× pro Kalendermonat" — frisch, wenn
 * `last_curated` denselben Kalendermonat (Jahr+Monat, UTC) wie `now` hat.
 *
 * @param {string|null} lastCurated
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isSignalFresh(lastCurated, now = new Date()) {
  if (typeof lastCurated !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastCurated.trim());
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return year === now.getUTCFullYear() && month === now.getUTCMonth() + 1;
}

// ── CostModeModelCheck ────────────────────────────────────────────────────────

export class CostModeModelCheck {
  /** @type {() => Promise<string|null>} */
  #pluginRootResolver;
  /** @type {{ readFile: typeof readFile }} */
  #fsDeps;
  /** @type {{ start: Function, getJob: Function }} */
  #flowRunner;
  /** @type {{ record: Function }|null} */
  #auditStore;
  /** @type {string} cwd + Lock-Key des Curator-Kindprozesses. */
  #curatorCwd;
  /** @type {() => Date} */
  #now;
  /** @type {(ms: number) => Promise<void>} */
  #sleepFn;
  /** @type {number} */
  #pollIntervalMs;
  /** @type {number} */
  #intervalMs;
  /** @type {(fn: Function, ms: number) => *} */
  #setTimeoutFn;
  /** @type {(handle: *) => void} */
  #clearTimeoutFn;

  /** @type {Map<string, { status: string, changed?: boolean, before?: object, after?: object }>} */
  #checks = new Map();
  /** Skip-if-running: verhindert überlappende Checks (ein Curator-Lauf zur Zeit). */
  #checking = false;
  /** @type {*} Timer-Handle der setTimeout-Kette. */
  #timer = null;

  /**
   * @param {object} deps
   * @param {() => Promise<string|null>} deps.pluginRootResolver
   *   Löst den agent-flow-Plugin-Root auf (Muster `AgentFlowReader.resolvePluginRoot`).
   * @param {{ start: (cwd: string, overrides?: object) => ({ ok: boolean, jobId?: string, reason?: string }),
   *          getJob: (jobId: string) => (object|undefined) }} deps.flowRunner
   *   EIGENE `HeadlessFlowRunner`-Instanz mit EIGENER `ProjectJobLock`-Instanz (AC7).
   * @param {{ record: Function }} [deps.auditStore]  Audit-First (AC7), best-effort.
   * @param {string} [deps.curatorCwd]  cwd + Lock-Key des Curator-Kindprozesses (Default `process.cwd()`).
   * @param {{ readFile: typeof readFile }} [deps.fsDeps]  Injectable FS (Default node:fs/promises).
   * @param {() => Date} [deps.now]  Injectable Uhr (Default `() => new Date()`).
   * @param {(ms: number) => Promise<void>} [deps.sleepFn]  Injectable Poll-Sleep.
   * @param {number} [deps.pollIntervalMs]  Poll-Abstand für den Curator-Abschluss.
   * @param {number} [deps.intervalMs]  Periodisches Prüf-Intervall (Default 24h).
   * @param {(fn: Function, ms: number) => *} [deps.setTimeoutFn]
   * @param {(handle: *) => void} [deps.clearTimeoutFn]
   */
  constructor({
    pluginRootResolver,
    flowRunner,
    auditStore,
    curatorCwd,
    fsDeps,
    now,
    sleepFn,
    pollIntervalMs,
    intervalMs,
    setTimeoutFn,
    clearTimeoutFn,
  } = {}) {
    if (typeof pluginRootResolver !== 'function') {
      throw new Error('[CostModeModelCheck] pluginRootResolver (() => Promise<string|null>) ist Pflicht');
    }
    if (!flowRunner || typeof flowRunner.start !== 'function' || typeof flowRunner.getJob !== 'function') {
      throw new Error('[CostModeModelCheck] flowRunner mit start()/getJob() ist Pflicht');
    }
    this.#pluginRootResolver = pluginRootResolver;
    this.#flowRunner = flowRunner;
    this.#auditStore = auditStore ?? null;
    this.#curatorCwd = curatorCwd ?? process.cwd();
    this.#fsDeps = fsDeps ?? { readFile };
    this.#now = now ?? (() => new Date());
    this.#sleepFn = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollIntervalMs = pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#intervalMs = intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.#setTimeoutFn = setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeoutFn = clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  // ── Scheduler (Boot + periodisch) ──────────────────────────────────────────

  /**
   * Startet die Prüfung: EIN Boot-Check fire-and-forget (blockiert nie, AC1) +
   * die periodische setTimeout-Kette. Idempotent — ein laufender Timer wird
   * zuerst gestoppt.
   */
  start() {
    this.stop();
    // Boot-Check: fire-and-forget, blockiert den Boot NICHT (AC1). Ein Fehler
    // darf den Boot nie crashen (degradiert still).
    this.runCheck('boot').catch(() => {});
    this.#scheduleNext();
  }

  /** Stoppt die periodische Kette (graceful shutdown). */
  stop() {
    if (this.#timer !== null) {
      this.#clearTimeoutFn(this.#timer);
      this.#timer = null;
    }
  }

  #scheduleNext() {
    this.#timer = this.#setTimeoutFn(async () => {
      try {
        await this.runCheck('periodic');
      } catch {
        // Ein Tick-Fehler darf die Kette nie abbrechen (Robustheit).
      }
      this.#scheduleNext();
    }, this.#intervalMs);
    if (this.#timer && typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  // ── Ein Check-Zyklus ───────────────────────────────────────────────────────

  /**
   * Führt genau einen Frische-Check aus (AC1/AC2/AC3). Skip-if-running:
   * überlappende Aufrufe werden übersprungen (kein Doppel-Anstoß).
   *
   * @param {'boot'|'periodic'|string} [trigger]
   * @returns {Promise<
   *   { drift: false, reason: 'fresh'|'unavailable' } |
   *   { drift: true, skipped: 'locked'|'busy' } |
   *   { drift: true, checkId: string, done: Promise<void> }
   * >}
   */
  async runCheck(trigger = 'manual') {
    if (this.#checking) {
      // Ein Check/Curator-Lauf ist bereits aktiv → kein Doppel-Anstoß (AC7).
      return { drift: true, skipped: 'busy' };
    }
    this.#checking = true;
    try {
      const signal = await this.#readFreshnessSignal();
      if (!signal.available) {
        // Plugin/Datei fehlt → still übersprungen (AC1 degradierend, kein Crash).
        return { drift: false, reason: 'unavailable' };
      }

      const fresh = isSignalFresh(signal.lastCurated, this.#now());
      if (fresh) {
        // Normalfall (AC2): keinerlei Meldung, kein Curator-Anstoß, kein Job.
        return { drift: false, reason: 'fresh' };
      }

      // ── Drift (AC3) ───────────────────────────────────────────────────────
      // Kurze (nicht-geheime) Log-Meldung. Die GUI-Meldung ist S-228.
      const displayCurated = signal.lastCurated ?? 'never';
      console.info(
        `[cost-mode-check] Modell-Frische veraltet (last_curated=${displayCurated}) — ` +
        'Cost-Mode-Zuordnung wird über den agent-flow-Curator aufgefrischt',
      );

      // Curator headless anstoßen — EIGENE Runner-/Lock-Instanz (AC7).
      const startResult = this.#flowRunner.start(this.#curatorCwd, {
        command: CURATOR_COMMAND,
        args: CURATOR_ARGS,
      });

      if (!startResult.ok) {
        // Curator läuft bereits (Lock) → interner Tick überspringt still
        // (Edge-Case „Curator läuft bereits → kein Doppel-Anstoß").
        return { drift: true, skipped: 'locked' };
      }

      const before = { lastCurated: signal.lastCurated };
      const checkId = randomUUID();
      this.#checks.set(checkId, { status: 'running', before });

      // Audit-First (AC7): Start des Curator-Anstoßes.
      this.#audit(`cost-mode-check:curator-start trigger=${sanitizeToken(trigger)}`);

      // Curator-Abschluss im Hintergrund verfolgen (nicht-blockierend, AC5).
      const done = this.#trackCurator(checkId, startResult.jobId, before);

      return { drift: true, checkId, done };
    } finally {
      this.#checking = false;
    }
  }

  /**
   * Liest den Status eines Checks (AC7).
   * @param {string} checkId
   * @returns {{ status: string, changed?: boolean, before?: object, after?: object }|undefined}
   */
  getCheck(checkId) {
    return this.#checks.get(checkId);
  }

  // ── intern ─────────────────────────────────────────────────────────────────

  /**
   * Liest das Frische-Signal (`last_curated`) READ-ONLY aus `model-tiers.md`.
   * Degradiert still: Plugin-Root nicht auflösbar / Datei fehlt / unlesbar →
   * `{ available: false }` (kein Crash, AC1).
   *
   * @returns {Promise<{ available: boolean, lastCurated?: string|null }>}
   */
  async #readFreshnessSignal() {
    let root;
    try {
      root = await this.#pluginRootResolver();
    } catch {
      return { available: false };
    }
    if (!root) return { available: false };

    const filePath = join(root, ...MODEL_TIERS_REL_PATH);
    let content;
    try {
      content = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch {
      // Datei fehlt/unlesbar → still übersprungen (AC1 Edge-Case).
      return { available: false };
    }

    return { available: true, lastCurated: parseLastCurated(content) };
  }

  /**
   * Verfolgt den Curator-Kindprozess bis zum Terminalzustand, re-liest danach
   * das Frische-Signal und aktualisiert die Job-Registry mit Vorher/Nachher
   * (AC3). Best-effort — ein Fehler hier crasht nie den Prozess (AC5).
   *
   * @param {string} checkId
   * @param {string} jobId
   * @param {{ lastCurated: string|null }} before
   * @returns {Promise<void>}
   */
  async #trackCurator(checkId, jobId, before) {
    try {
      const job = await this.#waitForJob(jobId);
      const terminalStatus = job?.status;

      if (terminalStatus === 'done') {
        // Nach dem Curator-Lauf: Signal re-lesen → Vorher/Nachher (AC3).
        const afterSignal = await this.#readFreshnessSignal();
        const after = { lastCurated: afterSignal.available ? afterSignal.lastCurated : null };
        const changed = before.lastCurated !== after.lastCurated;
        this.#checks.set(checkId, { status: 'done', changed, before, after });
        this.#audit(`cost-mode-check:curator-done changed=${changed}`);
      } else {
        // failed / auth-expired / verschwundener Job → nicht-blockierend als
        // fehlgeschlagen führen (der Board-/Flow-Vorgang läuft trotzdem, AC5).
        this.#checks.set(checkId, { status: 'failed', before });
        this.#audit('cost-mode-check:curator-failed');
      }
    } catch {
      this.#checks.set(checkId, { status: 'failed', before });
      this.#audit('cost-mode-check:curator-failed');
    }
  }

  /**
   * Pollt `flowRunner.getJob(jobId)` bis zum Terminalzustand
   * (status !== 'running') oder bis der Job verschwindet. Ein Sicherheits-Cap
   * verhindert eine Endlosschleife, falls ein Job nie terminal wird (der Runner
   * terminiert normalerweise via close/timeout/error selbst).
   *
   * @param {string} jobId
   * @returns {Promise<object|undefined>}  der terminale Job-Zustand.
   */
  async #waitForJob(jobId) {
    // Cap: der HeadlessFlowRunner hat einen eigenen (großzügigen) Timeout, der
    // den Job terminal macht; dieser Cap ist nur ein Netz gegen einen kaputten
    // (Test-)Stub, der nie terminal wird.
    const maxPolls = 100_000;
    for (let i = 0; i < maxPolls; i++) {
      const job = this.#flowRunner.getJob(jobId);
      if (!job || job.status !== 'running') return job;
      await this.#sleepFn(this.#pollIntervalMs);
    }
    return this.#flowRunner.getJob(jobId);
  }

  /**
   * Best-effort Audit-Eintrag (AC7). Ein Audit-Fehler darf den Check nie
   * crashen. Keine Secrets/Pfade im Kommando.
   * @param {string} command
   */
  #audit(command) {
    if (!this.#auditStore) return;
    try {
      this.#auditStore.record({ identity: null, command });
    } catch {
      // best-effort — kein Crash
    }
  }
}

/**
 * Entfernt Whitespace/Sonderzeichen aus einem kurzen Token für das Audit-Log
 * (Tiefenverteidigung — der `trigger` ist intern, aber wir halten das Audit-
 * Kommando robust gegen unerwartete Werte).
 * @param {unknown} s
 * @returns {string}
 */
function sanitizeToken(s) {
  if (typeof s !== 'string') return 'unknown';
  return s.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'unknown';
}
