/**
 * HeadlessReconcileRunner — echter `claude -p`-Kindprozess-Runner für
 * `/agent-flow:reconcile` (docs/specs/headless-reconcile-runner.md AC1–AC7).
 *
 * Getrennt vom interaktiven PTY-Pfad (AC7): dieses Modul importiert/mutiert
 * WEDER `PtyManager` NOCH `PtySessionRegistry` NOCH den `CommandService`-
 * Schreibpfad. Der bestehende `/api/command`-Flow (Flow-/Board-Button) bleibt
 * unangetastet.
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
import { randomUUID } from 'node:crypto';
import { ProjectJobLock } from './ProjectJobLock.js';

/** Default Runaway-Timeout (Reconcile kann mehrere Minuten dauern — grosszügig). */
export const DEFAULT_RECONCILE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

/** Klartext-Hinweis bei erkanntem Auth-Fehler (AC6/AC7 — Erneuerungs-Hinweis). */
export const AUTH_EXPIRED_MESSAGE =
  'Claude-Anmeldung abgelaufen — Token via `claude setup-token` erneuern';

/** Generischer, secret-freier Fehlertext für nicht-401 Exit-Fehler. */
const GENERIC_FAILURE_MESSAGE = 'Reconcile-Lauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Reconcile-Lauf abgebrochen (Timeout)';
const NOT_AVAILABLE_MESSAGE = 'claude nicht verfügbar';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Reconcile-Runner';

/** Auth-Fehler-Signatur (Stufe 1, best-effort — AC6). */
const AUTH_ERROR_PATTERN = /401|Invalid authentication credentials/i;

/**
 * Minimale Shell-/Locale-Plumbing-Allowlist für die Child-Env (AC2).
 * Explizit NICHT enthalten: ANTHROPIC_API_KEY, OPENAI_API_KEY (Trust-Boundary).
 */
const BASE_ALLOWED_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME', 'SHELL'];

/** Server-only Secrets, die NIE in die Child-Env gelangen dürfen (Defense in Depth, AC2). */
const BLOCKED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

/**
 * Baut die Child-Env für den Reconcile-Kindprozess (AC2).
 *
 * @param {NodeJS.ProcessEnv} [sourceEnv] - default process.env (injectable für Tests).
 * @returns {Record<string,string>}
 */
export function buildChildEnv(sourceEnv = process.env) {
  const childEnv = {};
  for (const key of BASE_ALLOWED_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) childEnv[key] = sourceEnv[key];
  }
  // CLAUDE_CODE_OAUTH_TOKEN: nur wenn gesetzt (kein leerer Eintrag, AC2).
  if (sourceEnv.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = sourceEnv.CLAUDE_CODE_OAUTH_TOKEN;
  }
  // Defense in depth: auch wenn ein künftiger Refactor die Blockliste versehentlich
  // in BASE_ALLOWED_ENV_KEYS aufnimmt, werden diese Keys hier hart entfernt (AC2/AC3).
  for (const blocked of BLOCKED_ENV_KEYS) {
    delete childEnv[blocked];
  }
  return childEnv;
}

/**
 * Prüft, ob Exit-Code oder erfasste Ausgabe eine Auth-Fehler-Signatur zeigen (AC6).
 * 401 hat Vorrang vor einem "sauberen" Exit-Code 0 (Edge-Case „401 + Exit 0").
 *
 * @param {number|null} code
 * @param {string} combinedOutput - stdout + stderr
 * @returns {boolean}
 */
export function isAuthError(code, combinedOutput) {
  if (code === 401) return true;
  return AUTH_ERROR_PATTERN.test(combinedOutput);
}

/**
 * Best-effort PR-Hinweis aus der erfassten Ausgabe extrahieren (AC9).
 * Sucht zuerst eine volle GitHub-PR-URL, dann eine `#<nummer>`-Erwähnung.
 * Liefert `undefined` wenn nichts erkennbar ist (graceful absence).
 *
 * @param {string} combinedOutput
 * @returns {string|undefined}
 */
export function extractPrHint(combinedOutput) {
  const urlMatch = combinedOutput.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
  if (urlMatch) return urlMatch[0];
  const numberMatch = combinedOutput.match(/#\d+/);
  if (numberMatch) return numberMatch[0];
  return undefined;
}

/**
 * HeadlessReconcileRunner — Kindprozess-Runner + In-Memory Job-Registry.
 */
export class HeadlessReconcileRunner {
  /** @type {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} */
  #spawnFn;
  /** @type {number} */
  #timeoutMs;
  /** @type {ProjectJobLock} */
  #lock;
  /** @type {Map<string, object>} */
  #jobs = new Map();

  /**
   * @param {object} [params]
   * @param {Function} [params.spawnFn] - injectable spawn (default: node:child_process spawn).
   * @param {number} [params.timeoutMs] - Runaway-Timeout (default: RECONCILE_TIMEOUT_MS env
   *   oder DEFAULT_RECONCILE_TIMEOUT_MS).
   * @param {ProjectJobLock} [params.lock] - injectable Lock-Instanz (default: eigene, isoliert
   *   vom `taktgeber-nachtwaechter`-ProjectDrain-Lock — Nicht-Ziel: keine Integration nötig).
   */
  constructor({ spawnFn = nodeSpawn, timeoutMs, lock = new ProjectJobLock() } = {}) {
    this.#spawnFn = spawnFn;
    this.#timeoutMs = timeoutMs ?? (Number(process.env.RECONCILE_TIMEOUT_MS) || DEFAULT_RECONCILE_TIMEOUT_MS);
    this.#lock = lock;
  }

  /**
   * Startet einen Reconcile-Job für ein Projekt (AC1, AC5, AC8).
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad (WORKSPACE_DIR/<slug>).
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath) {
    if (!this.#lock.tryAcquire(projectPath)) {
      return { ok: false, reason: 'locked' };
    }

    const jobId = randomUUID();
    this.#jobs.set(jobId, { status: 'running', result: undefined, error: undefined, prHint: undefined });

    // Fire-and-forget: der Reconcile-Lauf kann mehrere Minuten dauern; der Aufrufer
    // (Router) wartet nicht darauf (202 sofort). Der interne try/finally übernimmt
    // die Lock-Freigabe auch bei einer unerwarteten Exception (AC5).
    this.#runProcess(jobId, projectPath).catch(() => {
      // #runProcess() fängt selbst alle Fehler ab und setzt den Job-Status —
      // dieser catch ist nur ein zusätzliches Sicherheitsnetz gegen eine
      // unhandled rejection, falls doch etwas durchrutscht.
    });

    return { ok: true, jobId };
  }

  /**
   * Liest den aktuellen Status eines Jobs (AC9).
   *
   * @param {string} jobId
   * @returns {{ status: string, result?: string, error?: string, prHint?: string } | undefined}
   */
  getJob(jobId) {
    return this.#jobs.get(jobId);
  }

  /**
   * Führt den Kindprozess aus und aktualisiert den Job-Status terminal
   * (genau EIN terminaler Zustand — AC3/AC4/AC6, Race-frei via `settled`-Flag).
   *
   * @param {string} jobId
   * @param {string} projectPath
   * @returns {Promise<void>}
   */
  async #runProcess(jobId, projectPath) {
    try {
      await new Promise((resolve) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        let timeoutHandle;
        let child;

        const finish = (status, patch) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          this.#jobs.set(jobId, { status, result: undefined, error: undefined, prHint: undefined, ...patch });
          resolve();
        };

        try {
          child = this.#spawnFn('claude', ['-p', '/agent-flow:reconcile', '--dangerously-skip-permissions'], {
            cwd: projectPath,
            env: buildChildEnv(),
          });
        } catch {
          // Synchroner Spawn-Fehler (selten bei echtem Node-spawn, aber möglich bei
          // einem Test-Stub) → failed, kein Crash (AC5-Freigabe via äusseres finally).
          finish('failed', { error: INTERNAL_FAILURE_MESSAGE });
          return;
        }

        timeoutHandle = setTimeout(() => {
          if (settled) return;
          // Runaway-Schutz (AC4): terminieren; `kill` auf einen bereits beendeten
          // Prozess ist no-op (Edge-Case „Timeout exakt bei Exit").
          child.kill('SIGTERM');
          finish('failed', { error: TIMEOUT_FAILURE_MESSAGE });
        }, this.#timeoutMs);

        // stdout/stderr erfassen (AC3) — gedraint, keine Pipe-Blockade.
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.stderr?.on('data', (chunk) => { stderr += chunk; });

        child.on('close', (code) => {
          const combined = `${stdout}\n${stderr}`;
          if (isAuthError(code, combined)) {
            // 401 hat Vorrang vor "sauberem" Exit (Edge-Case „401 + Exit 0").
            finish('auth-expired', { error: AUTH_EXPIRED_MESSAGE });
            return;
          }
          if (code === 0) {
            finish('done', { result: 'Reconcile abgeschlossen', prHint: extractPrHint(combined) });
            return;
          }
          // Nicht-null Exit ohne 401 → generischer, secret-freier Grund
          // (kein stderr-Leak von Pfaden/Env in der Fehlermeldung).
          finish('failed', { error: GENERIC_FAILURE_MESSAGE });
        });

        child.on('error', (err) => {
          // Nur generische Meldung — kein Pfad-/Umgebungs-Leak (security/R01).
          finish('failed', { error: err?.code === 'ENOENT' ? NOT_AVAILABLE_MESSAGE : INTERNAL_FAILURE_MESSAGE });
        });
      });
    } catch {
      // Unerwartete Exception ausserhalb des Promise-Executors (z.B. erzwungen in
      // Tests) → failed, Lock-Freigabe erfolgt trotzdem im finally unten (AC5).
      this.#jobs.set(jobId, { status: 'failed', error: INTERNAL_FAILURE_MESSAGE, result: undefined, prHint: undefined });
    } finally {
      // AC5: Sperre wird IMMER freigegeben — auch bei Crash/Exception des Runners.
      this.#lock.release(projectPath);
    }
  }
}
