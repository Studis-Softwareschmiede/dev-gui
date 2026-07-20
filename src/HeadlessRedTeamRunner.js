/**
 * HeadlessRedTeamRunner — echter `claude -p`-Kindprozess-Runner für
 * `/agent-flow:red-team` (docs/specs/red-team-tile.md AC1).
 *
 * Getrennt vom interaktiven PTY-Pfad: dieses Modul importiert/mutiert WEDER
 * `PtyManager` NOCH `PtySessionRegistry` NOCH den `CommandService`-Schreibpfad.
 * Der bestehende `/api/command`-Flow (Flow-/Board-Button) bleibt unangetastet.
 *
 * Analog zu `HeadlessReconcileRunner.js` ein dünner Wrapper um
 * `HeadlessRunnerCore` (docs/specs/headless-parallel-drain.md AC2) mit fest
 * verdrahtetem Befehl `/agent-flow:red-team` und red-team-spezifischen
 * Meldungstexten. Verhalten (spawn/env/timeout/lock/close-Semantik) erbt 1:1
 * aus dem Core — kein Regress gegenüber den Geschwister-Runnern.
 *
 * Besonderheit gegenüber Reconcile: der Red-Team-Lauf braucht Per-Lauf-
 * Argumente (`ziel`, optional `modus`). Diese werden als args-Array an den Core
 * durchgereicht und dort zu EINEM zusammenhängenden `-p`-argv-Element
 * (`/agent-flow:red-team ziel=<slug> [modus=<modus>]`) zusammengesetzt.
 *
 * Trust-Boundary: `ziel` ist ein bereits validierter Slug — der Aufrufer/Router
 * prüft ihn gegen die Allowlist, BEVOR `start()` gerufen wird. Der Runner
 * vertraut dem übergebenen Wert und interpoliert ihn nicht in eine Shell
 * (argv-Array, kein Shell-String, security/R03). Als defensive Basis wirft
 * `start()` bei fehlendem/leerem `ziel` einen `TypeError`, statt einen leeren
 * `ziel=`-Parameter an den Kindprozess zu reichen.
 *
 * Injectable (Test-Entkopplung): `spawnFn` (Default `node:child_process` `spawn`),
 * kein Test benötigt einen echten `claude`-Lauf.
 *
 * @module HeadlessRedTeamRunner
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

/** Default Runaway-Timeout (Red-Team-Lauf kann mehrere Minuten dauern — grosszügig). */
export const DEFAULT_RED_TEAM_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

// Re-exportiert für Rückwärtskompatibilität — bestehende Importe aus diesem Modul
// (Tests, Aufrufer) bleiben unverändert gültig.
export { buildChildEnv, isAuthError, extractPrHint, AUTH_EXPIRED_MESSAGE };

const RED_TEAM_COMMAND = '/agent-flow:red-team';

/** Generischer, secret-freier Fehlertext für nicht-401 Exit-Fehler. */
const GENERIC_FAILURE_MESSAGE = 'Red-Team-Lauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Red-Team-Lauf abgebrochen (Timeout)';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Red-Team-Runner';
const DONE_RESULT_MESSAGE = 'Red-Team-Lauf abgeschlossen';

/**
 * HeadlessRedTeamRunner — Kindprozess-Runner + In-Memory Job-Registry.
 * Dünner Wrapper um `HeadlessRunnerCore` mit fest verdrahtetem
 * `/agent-flow:red-team`-Befehl (kein Befehls-Override) und Per-Lauf-
 * Argumenten (`ziel`, optional `modus`).
 */
export class HeadlessRedTeamRunner {
  /** @type {HeadlessRunnerCore} */
  #core;

  /**
   * @param {object} [params]
   * @param {Function} [params.spawnFn] - injectable spawn (default: node:child_process spawn).
   * @param {number} [params.timeoutMs] - Runaway-Timeout (default: RED_TEAM_TIMEOUT_MS env
   *   oder DEFAULT_RED_TEAM_TIMEOUT_MS).
   * @param {ProjectJobLock} [params.lock] - injectable Lock-Instanz (default: eigene, isoliert
   *   von den übrigen Headless-Runnern).
   */
  constructor({ spawnFn = nodeSpawn, timeoutMs, lock = new ProjectJobLock() } = {}) {
    this.#core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: timeoutMs ?? (Number(process.env.RED_TEAM_TIMEOUT_MS) || DEFAULT_RED_TEAM_TIMEOUT_MS),
      lock,
      defaultCommand: RED_TEAM_COMMAND,
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
   * Startet einen Red-Team-Job für ein Projekt (docs/specs/red-team-tile.md AC1).
   *
   * Baut die Per-Lauf-Argumente `['ziel=<ziel>']` (plus `'modus=<modus>'`, wenn
   * `modus` gesetzt ist) und reicht sie als `overrides.args` an den Core, der sie
   * zu EINEM `-p`-argv-Element `/agent-flow:red-team ziel=<ziel> [modus=<modus>]`
   * zusammensetzt.
   *
   * Trust-Boundary: `ziel` ist ein bereits validierter Slug — der Aufrufer/Router
   * hat ihn GEGEN DIE ALLOWLIST GEPRÜFT, bevor `start()` gerufen wird. Der Runner
   * vertraut dem Wert (kein Re-Validieren), interpoliert ihn aber nicht in eine
   * Shell (argv-Array, security/R03). Fehlt/leer → `TypeError` (defensive Basis
   * gegen einen leeren `ziel=`-Parameter).
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad (WORKSPACE_DIR/<slug>).
   * @param {object} [params]
   * @param {string} params.ziel - validierter Ziel-Slug (Pflicht).
   * @param {string} [params.modus] - optionaler Red-Team-Modus.
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   * @throws {TypeError} wenn `ziel` fehlt oder leer ist.
   */
  start(projectPath, { ziel, modus } = {}) {
    if (!ziel) {
      throw new TypeError('HeadlessRedTeamRunner.start: "ziel" ist erforderlich (validierter Slug)');
    }
    const args = ['ziel=' + ziel];
    if (modus) {
      args.push('modus=' + modus);
    }
    return this.#core.start(projectPath, { args });
  }

  /**
   * Liest den aktuellen Status eines Jobs.
   *
   * @param {string} jobId
   * @returns {{ status: string, result?: string, error?: string, prHint?: string } | undefined}
   */
  getJob(jobId) {
    return this.#core.getJob(jobId);
  }
}
