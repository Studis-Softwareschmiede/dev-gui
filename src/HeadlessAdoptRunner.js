/**
 * HeadlessAdoptRunner — headless Ausführungs-Naht für den `/agent-flow:adopt
 * <owner/repo>`-Kindprozess (docs/specs/per-app-gpg-passphrase-provisioning.md
 * AC12/AC14, F-073/S-343 — Umstellung der drei Anlage-Wege auf headless,
 * ADR-021-Muster ADR-017).
 *
 * Dünner Wrapper um `HeadlessRunnerCore` (analog `HeadlessReconcileRunner`) mit
 * fest verdrahtetem Befehl `/agent-flow:adopt` und **eigener** `ProjectJobLock`-
 * Instanz — getrennt von Nacht-/manuellem Drain / Reconcile / Retro /
 * `IdeaSpecifyFinalizer` / `ObsidianIngestRunner` / `HeadlessNewProjectRunner`
 * (Fremd-/Selbstblockade-Vermeidung, Muster ADR-017/ADR-021).
 *
 * **Bewusst KEINE Auto-Provisionierungs-Kopplung** (anders als
 * `HeadlessNewProjectRunner#runWithAutoProvisioning`): `/agent-flow:adopt`
 * erzeugt das initiale `.env.gpg` NICHT deterministisch beim Scaffold — laut
 * `adopt`-SKILL §2g ist es „optional … kein GE4-Zwang" (entsteht erst beim
 * ersten echten Secret, zu einem für dev-gui nicht vorhersehbaren Zeitpunkt).
 * Ein `GPG_PASS_FILE`, das der Scaffold-Lauf nie konsumiert, würde ein
 * verwaistes Bitwarden-Item ohne Konsum-Garantie erzeugen. Adoptierte Apps
 * nutzen stattdessen den bestehenden Nach-Provisionierungs-Knopf (AC7, S-337).
 *
 * Getrennt vom interaktiven PTY-Pfad: importiert/mutiert WEDER `PtyManager`
 * NOCH `PtySessionRegistry` NOCH den `CommandService`-Schreibpfad — der
 * bestehende PTY-„Übernehmen"-Trigger (AdoptSection.jsx) bleibt als
 * technischer Fallback unverändert bestehen (AC14).
 *
 * `start(projectPath, { args })` ist fire-and-forget (Muster `core.start()`):
 * liefert synchron `{ ok: true, jobId }` bzw. `{ ok: false, reason: 'locked' }`
 * — kein Warten auf den vollständigen Lauf (anders als
 * `HeadlessNewProjectRunner#run`, das bewusst awaitbar ist, weil die
 * Provisionierung NACH Scaffold-Erfolg feuern muss). `getJob(jobId)` erlaubt
 * optionale Introspektion (Muster Geschwister-Runner), wird vom aktuellen
 * `POST /api/adopt/start`-Endpunkt (`newProjectHeadlessRouter.js`) nicht
 * zwingend gepollt (kein angefordertes UI-Polling in dieser Story, coder/R01).
 *
 * Security (Floor):
 *   - Kein Token-Wert und kein absoluter Host-Pfad in Logs/Fehlermeldungen.
 *   - argv als Array, kein Shell-Interpolation (security/R03).
 *   - `--dangerously-skip-permissions` ausschließlich hier (getrennter
 *     headless-Pfad, wie alle Geschwister-Runner).
 *
 * Injectable (Test-Entkopplung): `spawnFn` (Default `node:child_process`
 * `spawn`), `lock`, `timeoutMs` — kein Test benötigt einen echten `claude`-Lauf.
 *
 * @module HeadlessAdoptRunner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { ProjectJobLock } from './ProjectJobLock.js';
import { HeadlessRunnerCore } from './HeadlessRunnerCore.js';

/** Der einzige `/agent-flow:...`-Befehl, den dieser Runner je auslöst. */
export const ADOPT_COMMAND = '/agent-flow:adopt';

/**
 * Default Runaway-Timeout für einen headless `adopt`-Lauf (Fork/Clone +
 * Scaffold + optionales Validate) — eigenständig über `ADOPT_HEADLESS_TIMEOUT_MS`
 * (Env, ms) konfigurierbar, NICHT an andere headless-Timeouts gekoppelt.
 */
export const DEFAULT_ADOPT_HEADLESS_TIMEOUT_MS = 60 * 60 * 1000; // 1h

/** Generischer, secret-freier Fehlertext für nicht-401 Exit-Fehler. */
const GENERIC_FAILURE_MESSAGE = 'Adopt-Lauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Adopt-Lauf abgebrochen (Timeout)';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Adopt-Runner';
const DONE_RESULT_MESSAGE = 'Adopt-Lauf abgeschlossen';

/**
 * HeadlessAdoptRunner — Kindprozess-Runner + In-Memory Job-Registry.
 * Dünner Wrapper um `HeadlessRunnerCore` mit fest verdrahtetem
 * `/agent-flow:adopt`-Befehl (Argument = `<owner/repo>`, vom Aufrufer
 * validiert BEVOR `start()` aufgerufen wird — analog allen Geschwister-Routern).
 */
export class HeadlessAdoptRunner {
  /** @type {HeadlessRunnerCore} */
  #core;

  /**
   * @param {object} [params]
   * @param {Function} [params.spawnFn] - injectable spawn (default: node:child_process spawn).
   * @param {number} [params.timeoutMs] - Runaway-Timeout (default: ADOPT_HEADLESS_TIMEOUT_MS env
   *   oder DEFAULT_ADOPT_HEADLESS_TIMEOUT_MS).
   * @param {ProjectJobLock} [params.lock] - injectable Lock-Instanz (Default: EIGENE, frische
   *   `ProjectJobLock`-Instanz — bewusst getrennt von allen anderen headless-Runnern).
   */
  constructor({ spawnFn = nodeSpawn, timeoutMs, lock = new ProjectJobLock() } = {}) {
    this.#core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: timeoutMs ?? (Number(process.env.ADOPT_HEADLESS_TIMEOUT_MS) || DEFAULT_ADOPT_HEADLESS_TIMEOUT_MS),
      lock,
      defaultCommand: ADOPT_COMMAND,
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
   * Startet einen headless `adopt`-Job (fire-and-forget, AC12).
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Workspace-Root-Pfad
   *   (der Ziel-Klon entsteht ERST während dieses Laufs — `cwd` ist daher die Workspace-
   *   Wurzel, nicht ein noch nicht existierender App-Pfad).
   * @param {object} [opts]
   * @param {string[]} [opts.args] - Extra-argv (genau `[<owner/repo>]`, vom Aufrufer validiert).
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath, { args } = {}) {
    return this.#core.start(projectPath, { args });
  }

  /**
   * Liest den aktuellen Status eines Jobs (optionale Introspektion, Muster Geschwister-Runner).
   * @param {string} jobId
   * @returns {{ status: string, result?: string, error?: string, prHint?: string } | undefined}
   */
  getJob(jobId) {
    return this.#core.getJob(jobId);
  }
}
