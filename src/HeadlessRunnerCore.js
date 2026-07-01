/**
 * HeadlessRunnerCore — shared engine behind the headless `claude -p`
 * child-process runners (docs/specs/headless-parallel-drain.md AC1-AC3;
 * extracted from `HeadlessReconcileRunner.js`, docs/specs/headless-reconcile-runner.md).
 *
 * Both `HeadlessReconcileRunner` (`/agent-flow:reconcile`, fixed command) and
 * `HeadlessFlowRunner` (`/agent-flow:flow`, configurable command + extra args)
 * are thin wrappers around this core so the well-tested reconcile behaviour
 * (S-207) stays byte-identical while the flow runner reuses the exact same
 * spawn/env/timeout/lock/close semantics instead of re-implementing them.
 *
 * Design (1:1 taken from HeadlessReconcileRunner, generalised):
 *   - Kindprozess: `claude -p '<command>' --dangerously-skip-permissions [...extraArgs]`
 *     as Array-argv (kein Shell-String, security/R03), `cwd` = aufgelöster
 *     Projekt-Pfad (Aufrufer löst Slug→Pfad auf, BEVOR `start()` aufgerufen wird).
 *   - Spawn-Env: minimale Allowlist (Shell-/Locale-Plumbing) + `CLAUDE_CODE_OAUTH_TOKEN`
 *     sofern im Server-Prozess gesetzt; `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` werden
 *     NIE in die Child-Env übernommen (Trust-Boundary).
 *   - Prozess-Exit = fertig: `close`-Event ist die einzige Fertig-Quelle, kein
 *     Idle-/Rate-Timer. stdout/stderr werden während des Laufs erfasst (gedraint,
 *     keine Pipe-Blockade).
 *   - Timeout: der konstruktor-injizierte `timeoutMs` terminiert einen hängenden
 *     Kindprozess (SIGTERM) und setzt den Job auf `failed`.
 *   - Sperre pro Projekt: `ProjectJobLock`-Instanz, Lock-Key = aufgelöster
 *     Projekt-Pfad; Freigabe in try/finally (Crash/Exception-sicher).
 *   - 401-Erkennung: 401-Signatur in Exit-Code ODER erfasstem stdout/stderr hat
 *     Vorrang vor "sauberem" Exit-Code 0 → Status `auth-expired`.
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
 * @module HeadlessRunnerCore
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ProjectJobLock } from './ProjectJobLock.js';

/** Klartext-Hinweis bei erkanntem Auth-Fehler (Erneuerungs-Hinweis) — geteilt
 * zwischen allen headless-Runnern, da der Hinweistext runner-unabhängig ist. */
export const AUTH_EXPIRED_MESSAGE =
  'Claude-Anmeldung abgelaufen — Token via `claude setup-token` erneuern';

/** Generischer, secret-freier Hinweis wenn `claude` nicht im PATH ist — runner-unabhängig. */
const NOT_AVAILABLE_MESSAGE = 'claude nicht verfügbar';

/** Auth-Fehler-Signatur (Stufe 1, best-effort). */
const AUTH_ERROR_PATTERN = /401|Invalid authentication credentials/i;

/**
 * Minimale Shell-/Locale-Plumbing-Allowlist für die Child-Env.
 * Explizit NICHT enthalten: ANTHROPIC_API_KEY, OPENAI_API_KEY (Trust-Boundary).
 */
const BASE_ALLOWED_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME', 'SHELL'];

/** Server-only Secrets, die NIE in die Child-Env gelangen dürfen (Defense in Depth). */
const BLOCKED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

/**
 * Baut die Child-Env für einen headless-Kindprozess.
 *
 * @param {NodeJS.ProcessEnv} [sourceEnv] - default process.env (injectable für Tests).
 * @returns {Record<string,string>}
 */
export function buildChildEnv(sourceEnv = process.env) {
  const childEnv = {};
  for (const key of BASE_ALLOWED_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) childEnv[key] = sourceEnv[key];
  }
  // CLAUDE_CODE_OAUTH_TOKEN: nur wenn gesetzt (kein leerer Eintrag).
  if (sourceEnv.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = sourceEnv.CLAUDE_CODE_OAUTH_TOKEN;
  }
  // Defense in depth: auch wenn ein künftiger Refactor die Blockliste versehentlich
  // in BASE_ALLOWED_ENV_KEYS aufnimmt, werden diese Keys hier hart entfernt.
  for (const blocked of BLOCKED_ENV_KEYS) {
    delete childEnv[blocked];
  }
  return childEnv;
}

/**
 * Prüft, ob Exit-Code oder erfasste Ausgabe eine Auth-Fehler-Signatur zeigen.
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
 * Best-effort PR-Hinweis aus der erfassten Ausgabe extrahieren.
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
 * HeadlessRunnerCore — Kindprozess-Runner-Engine + In-Memory Job-Registry,
 * parametriert über Befehl/Args/Timeout/Meldungstexte. Wird NICHT direkt von
 * Routern verwendet — `HeadlessReconcileRunner` und `HeadlessFlowRunner` sind
 * die öffentlichen, dünnen Wrapper.
 */
export class HeadlessRunnerCore {
  /** @type {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} */
  #spawnFn;
  /** @type {number} */
  #timeoutMs;
  /** @type {ProjectJobLock} */
  #lock;
  /** @type {Map<string, object>} */
  #jobs = new Map();
  /** @type {string} default `/agent-flow:...` slash-command */
  #defaultCommand;
  /** @type {string[]} default extra argv appended after --dangerously-skip-permissions */
  #defaultArgs;
  /** @type {{genericFailure:string, timeoutFailure:string, internalFailure:string, doneResult:string}} */
  #messages;

  /**
   * @param {object} params
   * @param {Function} [params.spawnFn] - injectable spawn (default: node:child_process spawn).
   * @param {number} params.timeoutMs - Runaway-Timeout in ms (caller resolves the default).
   * @param {ProjectJobLock} [params.lock] - injectable Lock-Instanz.
   * @param {string} params.defaultCommand - default `/agent-flow:...` slash-command.
   * @param {string[]} [params.defaultArgs] - default extra argv (e.g. ['--cost','balanced']).
   * @param {object} [params.messages] - secret-free, runner-specific message texts.
   * @param {string} [params.messages.genericFailure]
   * @param {string} [params.messages.timeoutFailure]
   * @param {string} [params.messages.internalFailure]
   * @param {string} [params.messages.doneResult]
   */
  constructor({
    spawnFn = nodeSpawn,
    timeoutMs,
    lock = new ProjectJobLock(),
    defaultCommand,
    defaultArgs = [],
    messages = {},
  }) {
    this.#spawnFn = spawnFn;
    this.#timeoutMs = timeoutMs;
    this.#lock = lock;
    this.#defaultCommand = defaultCommand;
    this.#defaultArgs = defaultArgs;
    this.#messages = {
      genericFailure: messages.genericFailure ?? 'Headless-Lauf fehlgeschlagen',
      timeoutFailure: messages.timeoutFailure ?? 'Headless-Lauf abgebrochen (Timeout)',
      internalFailure: messages.internalFailure ?? 'Interner Fehler im Headless-Runner',
      doneResult: messages.doneResult ?? 'Headless-Lauf abgeschlossen',
    };
  }

  /**
   * Startet einen headless-Job für ein Projekt.
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad.
   * @param {object} [overrides]
   * @param {string} [overrides.command] - überschreibt den default-Befehl für DIESEN Lauf.
   * @param {string[]} [overrides.args] - überschreibt die default-Extra-Args für DIESEN Lauf.
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath, overrides = {}) {
    if (!this.#lock.tryAcquire(projectPath)) {
      return { ok: false, reason: 'locked' };
    }

    const jobId = randomUUID();
    this.#jobs.set(jobId, { status: 'running', result: undefined, error: undefined, prHint: undefined });

    const command = overrides.command ?? this.#defaultCommand;
    const args = overrides.args ?? this.#defaultArgs;

    // Fire-and-forget: der Lauf kann lange dauern; der Aufrufer wartet nicht
    // darauf. Der interne try/finally übernimmt die Lock-Freigabe auch bei
    // einer unerwarteten Exception.
    this.#runProcess(jobId, projectPath, command, args).catch(() => {
      // #runProcess() fängt selbst alle Fehler ab und setzt den Job-Status —
      // dieser catch ist nur ein zusätzliches Sicherheitsnetz gegen eine
      // unhandled rejection, falls doch etwas durchrutscht.
    });

    return { ok: true, jobId };
  }

  /**
   * Liest den aktuellen Status eines Jobs.
   *
   * @param {string} jobId
   * @returns {{ status: string, result?: string, error?: string, prHint?: string } | undefined}
   */
  getJob(jobId) {
    return this.#jobs.get(jobId);
  }

  /**
   * Führt den Kindprozess aus und aktualisiert den Job-Status terminal
   * (genau EIN terminaler Zustand, Race-frei via `settled`-Flag).
   *
   * @param {string} jobId
   * @param {string} projectPath
   * @param {string} command
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async #runProcess(jobId, projectPath, command, args) {
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
          child = this.#spawnFn('claude', ['-p', command, '--dangerously-skip-permissions', ...args], {
            cwd: projectPath,
            env: buildChildEnv(),
          });
        } catch {
          // Synchroner Spawn-Fehler (selten bei echtem Node-spawn, aber möglich bei
          // einem Test-Stub) → failed, kein Crash (Lock-Freigabe via äusseres finally).
          finish('failed', { error: this.#messages.internalFailure });
          return;
        }

        timeoutHandle = setTimeout(() => {
          if (settled) return;
          // Runaway-Schutz: terminieren; `kill` auf einen bereits beendeten
          // Prozess ist no-op (Edge-Case „Timeout exakt bei Exit").
          child.kill('SIGTERM');
          finish('failed', { error: this.#messages.timeoutFailure });
        }, this.#timeoutMs);

        // stdout/stderr erfassen — gedraint, keine Pipe-Blockade.
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
            finish('done', { result: this.#messages.doneResult, prHint: extractPrHint(combined) });
            return;
          }
          // Nicht-null Exit ohne 401 → generischer, secret-freier Grund
          // (kein stderr-Leak von Pfaden/Env in der Fehlermeldung).
          finish('failed', { error: this.#messages.genericFailure });
        });

        child.on('error', (err) => {
          // Nur generische Meldung — kein Pfad-/Umgebungs-Leak (security/R01).
          finish('failed', { error: err?.code === 'ENOENT' ? NOT_AVAILABLE_MESSAGE : this.#messages.internalFailure });
        });
      });
    } catch {
      // Unerwartete Exception ausserhalb des Promise-Executors (z.B. erzwungen in
      // Tests) → failed, Lock-Freigabe erfolgt trotzdem im finally unten.
      this.#jobs.set(jobId, { status: 'failed', error: this.#messages.internalFailure, result: undefined, prHint: undefined });
    } finally {
      // Sperre wird IMMER freigegeben — auch bei Crash/Exception des Runners.
      this.#lock.release(projectPath);
    }
  }
}
