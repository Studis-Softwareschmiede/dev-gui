/**
 * HeadlessFlowRunner — headless `claude -p`-Kindprozess-Runner für einen
 * KONFIGURIERBAREN Befehl (Default `/agent-flow:flow`), als generische
 * Ausführungs-Primitive für den späteren headless-Nacht-Drain (S-212/S-213).
 * (docs/specs/headless-parallel-drain.md AC1, AC2, AC3, AC13.)
 *
 * Diese Story baut NUR den Runner selbst — kein `ProjectDrain`-Umbau (S-212),
 * kein Scheduler (S-213), kein neuer HTTP-Endpunkt (Nicht-Ziel der Spec).
 *
 * Getrennt vom interaktiven PTY-Pfad: dieses Modul importiert/mutiert WEDER
 * `PtyManager` NOCH `PtySessionRegistry` NOCH den `CommandService`-Schreibpfad.
 * Der bestehende `/api/command`-Flow (Flow-/Board-Button) bleibt unangetastet.
 *
 * Wiederverwendung (AC1/AC2 — `HeadlessRunnerCore.js`, extrahiert aus
 * `HeadlessReconcileRunner.js`): identische spawn/env/timeout/lock/close-
 * Semantik wie der bewährte Reconcile-Runner, aber mit injizierbarem Befehl
 * + Extra-Args statt fest verdrahtet auf `/agent-flow:reconcile`:
 *   - Kindprozess: `claude -p '<command>' --dangerously-skip-permissions [...args]`
 *     als Array-argv (kein Shell-String, security/R03), `cwd` = aufgelöster,
 *     validierter Projekt-Pfad.
 *   - Spawn-Env: minimale Allowlist + `CLAUDE_CODE_OAUTH_TOKEN` sofern gesetzt;
 *     `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` werden NIE übernommen (Trust-Boundary).
 *   - Prozess-Exit = fertig: `close`-Event ist die einzige Fertig-Quelle.
 *   - 401-Erkennung hat Vorrang vor "sauberem" Exit-Code 0 → `auth-expired`.
 *   - Sperre pro Projekt (`ProjectJobLock`, finally-Freigabe).
 *   - Session-/Usage-Limit-Erkennung (S-270, docs/specs/headless-budget-limit-
 *     detection.md): terminaler Status `budget-limited` samt `resetAt`/
 *     `rawMatch`, Vorrang nach `auth-expired` aber vor `done`/`failed`
 *     (Details/Wiederverwendung von `parseTokenLimitMessage()` in
 *     `HeadlessRunnerCore.js`, dort implementiert — dieser Wrapper reicht sie
 *     nur unverändert durch).
 *
 * Eigener, viel großzügigerer Timeout (AC3): ein `/flow`-Lauf über ein ganzes
 * Board dauert lange (viele Subagenten, CI, IO) — der 15-min-Reconcile-Default
 * ist hierfür ungeeignet. `FLOW_HEADLESS_TIMEOUT_MS` (Env, ms) ist NICHT an
 * `RECONCILE_TIMEOUT_MS`/`DEFAULT_RECONCILE_TIMEOUT_MS` gekoppelt; Default
 * `DEFAULT_FLOW_HEADLESS_TIMEOUT_MS` = 4 Stunden.
 *
 * Job-Registry: In-Memory (Map jobId → JobState), geht bei Server-Neustart
 * verloren (Nicht-Ziel: keine persistente Job-Historie).
 *
 * Security (Floor):
 *   - Kein Token-Wert und kein absoluter Host-Pfad in Logs/Fehlermeldungen.
 *   - argv als Array, kein Shell-Interpolation (security/R03).
 *   - `--dangerously-skip-permissions` ausschließlich hier (getrennter Headless-Pfad).
 *
 * Injectable (Test-Entkopplung, AC13): `spawnFn` (Default `node:child_process` `spawn`),
 * kein Test benötigt einen echten `claude`-Lauf.
 *
 * @module HeadlessFlowRunner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { ProjectJobLock } from './ProjectJobLock.js';
import {
  HeadlessRunnerCore,
  buildChildEnv,
  isAuthError,
  extractPrHint,
  AUTH_EXPIRED_MESSAGE,
} from './HeadlessRunnerCore.js';

/** Default-Befehl, wenn kein `command` übergeben wird (AC1). */
export const DEFAULT_FLOW_COMMAND = '/agent-flow:flow';

/**
 * Default Runaway-Timeout für einen headless `/flow`-Lauf (AC3) — deutlich
 * größer als `DEFAULT_RECONCILE_TIMEOUT_MS` (15 min), da ein `/flow`-Lauf ein
 * ganzes Board abarbeiten kann (viele Subagenten-Runden, CI, IO-Wartezeiten).
 * Eigenständig konfigurierbar über die Env-Variable `FLOW_HEADLESS_TIMEOUT_MS`,
 * NICHT an den Reconcile-Timeout gekoppelt.
 */
export const DEFAULT_FLOW_HEADLESS_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h

// Re-exportiert für Aufrufer/Tests dieses Moduls (gleiche Semantik wie im
// Reconcile-Runner, aus dem gemeinsamen Core wiederverwendet).
export { buildChildEnv, isAuthError, extractPrHint, AUTH_EXPIRED_MESSAGE };

/** Generischer, secret-freier Fehlertext für nicht-401 Exit-Fehler. */
const GENERIC_FAILURE_MESSAGE = 'Flow-Lauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Flow-Lauf abgebrochen (Timeout)';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Flow-Runner';
const DONE_RESULT_MESSAGE = 'Flow abgeschlossen';

/**
 * HeadlessFlowRunner — Kindprozess-Runner + In-Memory Job-Registry für einen
 * konfigurierbaren `/agent-flow:...`-Befehl. Dünner Wrapper um
 * `HeadlessRunnerCore` (AC1/AC2) mit eigenem Timeout-Default (AC3) und
 * Möglichkeit, Befehl/Args pro `start()`-Aufruf zu überschreiben.
 */
export class HeadlessFlowRunner {
  /** @type {HeadlessRunnerCore} */
  #core;

  /**
   * @param {object} [params]
   * @param {Function} [params.spawnFn] - injectable spawn (default: node:child_process spawn).
   * @param {number} [params.timeoutMs] - Runaway-Timeout (default: FLOW_HEADLESS_TIMEOUT_MS env
   *   oder DEFAULT_FLOW_HEADLESS_TIMEOUT_MS).
   * @param {ProjectJobLock} [params.lock] - injectable Lock-Instanz (eigene Instanz per
   *   Default — Nicht-Ziel dieser Story: Integration mit dem ProjectDrain-Lock ist S-212/S-213).
   * @param {string} [params.command] - Default-Befehl für `start()`-Aufrufe ohne Override
   *   (Default `/agent-flow:flow`).
   * @param {string[]} [params.args] - Default-Extra-Args für `start()`-Aufrufe ohne Override
   *   (z.B. `['--cost', 'balanced']`).
   */
  constructor({
    spawnFn = nodeSpawn,
    timeoutMs,
    lock = new ProjectJobLock(),
    command = DEFAULT_FLOW_COMMAND,
    args = [],
  } = {}) {
    this.#core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: timeoutMs ?? (Number(process.env.FLOW_HEADLESS_TIMEOUT_MS) || DEFAULT_FLOW_HEADLESS_TIMEOUT_MS),
      lock,
      defaultCommand: command,
      defaultArgs: args,
      messages: {
        genericFailure: GENERIC_FAILURE_MESSAGE,
        timeoutFailure: TIMEOUT_FAILURE_MESSAGE,
        internalFailure: INTERNAL_FAILURE_MESSAGE,
        doneResult: DONE_RESULT_MESSAGE,
      },
    });
  }

  /**
   * Startet einen headless-Lauf für ein Projekt (AC1, AC3).
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad.
   * @param {object} [overrides]
   * @param {string} [overrides.command] - überschreibt den Konstruktor-Default für DIESEN Lauf
   *   (z.B. ein anderer `/agent-flow:...`-Befehl).
   * @param {string[]} [overrides.args] - überschreibt die Konstruktor-Default-Args für DIESEN
   *   Lauf (z.B. `['--cost', 'economical']`).
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath, overrides = {}) {
    return this.#core.start(projectPath, overrides);
  }

  /**
   * Liest den aktuellen Status eines Jobs.
   *
   * @param {string} jobId
   * @returns {{ status: 'running'|'done'|'failed'|'auth-expired'|'budget-limited', result?: string, error?: string, prHint?: string, resetAt?: number, rawMatch?: string } | undefined}
   */
  getJob(jobId) {
    return this.#core.getJob(jobId);
  }
}
