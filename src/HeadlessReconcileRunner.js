/**
 * HeadlessReconcileRunner — echter `claude -p`-Kindprozess-Runner für
 * `/agent-flow:reconcile` (docs/specs/headless-reconcile-runner.md AC1–AC7).
 *
 * Getrennt vom interaktiven PTY-Pfad (AC7): dieses Modul importiert/mutiert
 * WEDER `PtyManager` NOCH `PtySessionRegistry` NOCH den `CommandService`-
 * Schreibpfad. Der bestehende `/api/command`-Flow (Flow-/Board-Button) bleibt
 * unangetastet.
 *
 * Seit docs/specs/headless-parallel-drain.md (AC2, S-204) ist die Runner-Engine
 * (spawn/env/timeout/lock/close-Semantik) nach `HeadlessRunnerCore.js`
 * extrahiert — dieser Runner ist ein dünner Wrapper mit fest verdrahtetem
 * Befehl `/agent-flow:reconcile` und reconcile-spezifischen Meldungstexten.
 * Verhalten bleibt 1:1 identisch zu vorher (kein Regress, alle bestehenden
 * Tests unverändert grün); siehe `HeadlessFlowRunner.js` für den generalisierten
 * Geschwister-Runner (konfigurierbarer Befehl, eigener Timeout-Default).
 *
 * Design:
 *   - Kindprozess: `claude -p "/agent-flow:reconcile" --dangerously-skip-permissions`
 *     als Array-argv (kein Shell-String, security/R03), `cwd` = aufgelöster
 *     Projekt-Pfad (Aufrufer löst Slug→Pfad via `resolveProjectSlug`/
 *     `validateProjectPath` auf, BEVOR `start()` aufgerufen wird).
 *   - Spawn-Env: minimale Allowlist (Shell-/Locale-Plumbing) + `CLAUDE_CODE_OAUTH_TOKEN`
 *     sofern im Server-Prozess gesetzt; `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` werden
 *     NIE in die Child-Env übernommen (Trust-Boundary, AC2).
 *   - Prozess-Exit = fertig (AC3): `close`-Event ist die einzige Fertig-Quelle,
 *     kein Idle-/Rate-Timer. stdout/stderr werden während des Laufs erfasst
 *     (gedraint, keine Pipe-Blockade).
 *   - Timeout (AC4): `RECONCILE_TIMEOUT_MS` terminiert einen hängenden Kindprozess
 *     (SIGTERM) und setzt den Job auf `failed`.
 *   - Sperre pro Projekt (AC5): `ProjectJobLock`-Instanz, Lock-Key = aufgelöster
 *     Projekt-Pfad; Freigabe in try/finally (Crash/Exception-sicher).
 *   - 401-Erkennung (AC6): 401-Signatur in Exit-Code ODER erfasstem stdout/stderr
 *     hat Vorrang vor "sauberem" Exit-Code 0 → Status `auth-expired`.
 *
 * Job-Registry: In-Memory (Map jobId → JobState), geht bei Server-Neustart
 * verloren (Nicht-Ziel: keine persistente Job-Historie).
 *
 * Security (Floor):
 *   - Kein Token-Wert und kein absoluter Host-Pfad in Logs/Fehlermeldungen.
 *   - argv als Array, kein Shell-Interpolation (security/R03).
 *   - `--dangerously-skip-permissions` ausschließlich hier (getrennter Headless-Pfad).
 *
 * Injectable (Test-Entkopplung, SR3): `spawnFn` (Default `node:child_process` `spawn`),
 * kein Test benötigt einen echten `claude`-Lauf.
 *
 * @module HeadlessReconcileRunner
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

/** Default Runaway-Timeout (Reconcile kann mehrere Minuten dauern — grosszügig). */
export const DEFAULT_RECONCILE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

// Re-exportiert für Rückwärtskompatibilität — bestehende Importe aus diesem Modul
// (Tests, Aufrufer) bleiben unverändert gültig.
export { buildChildEnv, isAuthError, extractPrHint, AUTH_EXPIRED_MESSAGE };

const RECONCILE_COMMAND = '/agent-flow:reconcile';

/** Generischer, secret-freier Fehlertext für nicht-401 Exit-Fehler. */
const GENERIC_FAILURE_MESSAGE = 'Reconcile-Lauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Reconcile-Lauf abgebrochen (Timeout)';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Reconcile-Runner';
const DONE_RESULT_MESSAGE = 'Reconcile abgeschlossen';

/**
 * HeadlessReconcileRunner — Kindprozess-Runner + In-Memory Job-Registry.
 * Dünner Wrapper um `HeadlessRunnerCore` mit fest verdrahtetem
 * `/agent-flow:reconcile`-Befehl (kein Befehls-Override, anders als
 * `HeadlessFlowRunner`).
 */
export class HeadlessReconcileRunner {
  /** @type {HeadlessRunnerCore} */
  #core;

  /**
   * @param {object} [params]
   * @param {Function} [params.spawnFn] - injectable spawn (default: node:child_process spawn).
   * @param {number} [params.timeoutMs] - Runaway-Timeout (default: RECONCILE_TIMEOUT_MS env
   *   oder DEFAULT_RECONCILE_TIMEOUT_MS).
   * @param {ProjectJobLock} [params.lock] - injectable Lock-Instanz (default: eigene, isoliert
   *   vom `taktgeber-nachtwaechter`-ProjectDrain-Lock — Nicht-Ziel: keine Integration nötig).
   */
  constructor({ spawnFn = nodeSpawn, timeoutMs, lock = new ProjectJobLock() } = {}) {
    this.#core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: timeoutMs ?? (Number(process.env.RECONCILE_TIMEOUT_MS) || DEFAULT_RECONCILE_TIMEOUT_MS),
      lock,
      defaultCommand: RECONCILE_COMMAND,
      defaultArgs: [],
      messages: {
        genericFailure: GENERIC_FAILURE_MESSAGE,
        timeoutFailure: TIMEOUT_FAILURE_MESSAGE,
        internalFailure: INTERNAL_FAILURE_MESSAGE,
        doneResult: DONE_RESULT_MESSAGE,
      },
    });
  }

  /**
   * Startet einen Reconcile-Job für ein Projekt (AC1, AC5, AC8).
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad (WORKSPACE_DIR/<slug>).
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath) {
    return this.#core.start(projectPath);
  }

  /**
   * Liest den aktuellen Status eines Jobs (AC9).
   *
   * @param {string} jobId
   * @returns {{ status: string, result?: string, error?: string, prHint?: string } | undefined}
   */
  getJob(jobId) {
    return this.#core.getJob(jobId);
  }
}
