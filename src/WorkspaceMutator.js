/**
 * WorkspaceMutator — Workspace-FS Mutation Boundary (delete AC5; pull AC3, AC4).
 *
 * Architecture boundary: the ONLY place that performs mutating filesystem
 * operations on WORKSPACE_DIR (deleting local clones, pulling clones).
 * Complements WorkspaceScanner (read-only).
 *
 * Design:
 *   - Target path is resolved with path.resolve() to prevent `..` traversal.
 *   - Symlink-Flucht protection: we verify the resolved path starts with
 *     WORKSPACE_DIR + sep AND is exactly one level deep (direct child only).
 *     We use lstat() (not stat() / realpath()) so a symlink inside WORKSPACE_DIR
 *     is treated as a filesystem entry at that path — we delete the link itself,
 *     never following it outside WORKSPACE_DIR.
 *   - Only direct children of WORKSPACE_DIR can be deleted or pulled (no nesting).
 *   - Injectable fsDeps for unit testing without real FS calls.
 *   - Graceful degradation on invalid input → throws with a typed error class.
 *   - workspaceRootResolver: optional async fn () => { path, source }; wenn gesetzt
 *     wird der Effektivwert pro Operation aufgelöst (workspace-path-config AC5, AC9).
 *
 * Pull / Token Injection (AC3):
 *   - The Installation Token is minted IMMEDIATELY BEFORE `git pull` (transient).
 *   - Token is injected via GIT_ASKPASS: a temp shell script outputs "token <value>"
 *     to stdout. The token value itself is passed via a randomly-named env var
 *     (so it never appears in argv / ps output / shell history).
 *   - The temp script and env var are cleaned up after `git pull` completes.
 *   - Token NEVER appears in: argv, logs, audit entries, responses, origin URL,
 *     or any persisted file.
 *
 * Security:
 *   - path.resolve() prevents any `..` / absolute path injection via the `name`
 *     field (AC4/AC5).
 *   - lstat() is used to confirm the target exists without following symlinks;
 *     rm -rf is run on the resolved path (not dereferenced), so symlinks pointing
 *     outside WORKSPACE_DIR are deleted as the link itself — target untouched (AC5).
 *   - No secrets are logged (security/R01).
 *
 * @module WorkspaceMutator
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, writeFile, unlink, realpath } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { writeAskpassScript, minimalGitEnv } from './githubAppToken.js';

const execFileAsync = promisify(execFile);

/** Timeout for the rm subprocess (ms). */
const RM_TIMEOUT_MS = 15000;

/** Timeout for git pull subprocess (ms). */
const PULL_TIMEOUT_MS = 60000;

/**
 * @typedef {'traversal'|'not-found'|'rm-failed'|'workspace-unset'|'pull-failed'|'no-remote'|'credentials-missing'} MutatorErrorClass
 */

/**
 * Typed error thrown by WorkspaceMutator.
 */
export class WorkspaceMutatorError extends Error {
  /** @type {MutatorErrorClass} */
  errorClass;

  /**
   * @param {string} message
   * @param {MutatorErrorClass} errorClass
   */
  constructor(message, errorClass) {
    super(message);
    this.name = 'WorkspaceMutatorError';
    this.errorClass = errorClass;
  }
}

/**
 * WorkspaceMutator performs mutating operations on WORKSPACE_DIR.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceDir]
 *   Override for the workspace directory (default: process.env.WORKSPACE_DIR).
 *   Wird ignoriert wenn workspaceRootResolver gesetzt ist.
 * @param {Function} [options.workspaceRootResolver]
 *   Optionaler async Resolver `() => Promise<{ path: string, source: string }>`.
 *   Wenn gesetzt: wird pro Operation aufgerufen (AC5 — Effektivwert pro Operation).
 *   Wenn nicht gesetzt: workspaceDir-Parameter oder env-Fallback (AC9 — Verhaltensneutralität).
 * @param {Function} [options.execFn]
 *   Injectable exec function for tests: `(cmd, args, options) => Promise<void|{stdout}>`.
 *   Defaults to promisified execFile.
 * @param {object} [options.fsDeps]
 *   Injectable filesystem helpers for tests: `{ lstat, writeFile, unlink }`.
 *   Defaults to node:fs/promises equivalents.
 */
export class WorkspaceMutator {
  #workspaceDir;
  #workspaceRootResolver;
  #execFn;
  #fsDeps;

  constructor({ workspaceDir, workspaceRootResolver, execFn, fsDeps } = {}) {
    this.#workspaceDir = workspaceDir ?? process.env.WORKSPACE_DIR ?? '';
    this.#workspaceRootResolver = workspaceRootResolver ?? null;
    this.#execFn = execFn ?? this.#defaultExec.bind(this);
    this.#fsDeps = fsDeps ?? { lstat, writeFile, unlink, realpath };
  }

  /**
   * Löst den effektiven Workspace-Root auf (AC5: pro Operation, nicht beim Boot eingefroren).
   * AC9: ohne Resolver → Fallback auf #workspaceDir (Verhaltensneutralität).
   *
   * @returns {Promise<string>}
   */
  async #resolveWorkspaceDir() {
    if (this.#workspaceRootResolver) {
      try {
        const resolved = await this.#workspaceRootResolver();
        return resolved.path ?? this.#workspaceDir;
      } catch {
        return this.#workspaceDir;
      }
    }
    return this.#workspaceDir;
  }

  /**
   * Default exec: runs execFile with timeout.
   *
   * @param {string} cmd
   * @param {string[]} args
   * @param {{ timeout?: number, cwd?: string, env?: object }} [opts]
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  async #defaultExec(cmd, args, opts = {}) {
    const result = await execFileAsync(cmd, args, {
      timeout: opts.timeout ?? RM_TIMEOUT_MS,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });
    return {
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : '',
    };
  }

  /**
   * Resolve and validate the target path for a clone name.
   *
   * Rules:
   *   1. WORKSPACE_DIR must be set (non-empty).
   *   2. `name` must not be empty or contain path separators that escape.
   *   3. The resolved absolute path must be a DIRECT child of WORKSPACE_DIR
   *      (i.e. parent === workspaceDir after normalization).
   *
   * This prevents:
   *   - `../../../etc` traversal (path.resolve collapses these)
   *   - absolute paths (e.g. name = "/etc") — resolved path won't start under workspaceDir
   *   - nested paths (name = "a/b/c") — resolved parent won't equal workspaceDir
   *
   * Note on symlinks: we do NOT call realpath() here. We validate the path
   * syntactically (preventing traversal via the name itself). A symlink INSIDE
   * WORKSPACE_DIR that points OUTSIDE is deleted as the symlink file — its target
   * is never touched. This is the correct behaviour per AC5 ("nichts außerhalb
   * gelöscht").
   *
   * AC5/AC9: Der workspaceDir-Wert wird per resolvedWorkspaceDir gesetzt, der
   * vom Resolver (wenn konfiguriert) oder direkt aus #workspaceDir kommt.
   * Der Resolver-Aufruf ist async — daher rufen pullClone/deleteClone ihn auf
   * und übergeben den Pfad; #validateTarget selbst bleibt synchron.
   *
   * @param {string} name  The clone folder name from user input.
   * @param {string} [resolvedWorkspaceDir]  Pre-resolved workspace dir (from resolver or #workspaceDir).
   * @returns {{ workspaceDir: string, targetPath: string }}
   * @throws {WorkspaceMutatorError}
   */
  #validateTarget(name, resolvedWorkspaceDir) {
    const workspaceDir = resolvedWorkspaceDir ?? this.#workspaceDir;

    if (!workspaceDir) {
      throw new WorkspaceMutatorError(
        'WORKSPACE_DIR ist nicht konfiguriert',
        'workspace-unset',
      );
    }

    // name must be a non-empty string
    if (typeof name !== 'string' || name.trim() === '') {
      throw new WorkspaceMutatorError(
        'Ungültiger Klon-Name: leer oder kein String',
        'traversal',
      );
    }

    // Resolve the absolute target path
    // path.resolve(workspaceDir, name) handles both `..` and absolute `name` inputs:
    //   - resolve('/workspace', '../etc/passwd') → '/etc/passwd' (caught below)
    //   - resolve('/workspace', '/etc/passwd')   → '/etc/passwd' (caught below)
    //   - resolve('/workspace', 'my-repo')       → '/workspace/my-repo' (ok)
    const targetPath = resolve(workspaceDir, name.trim());

    // Normalise workspaceDir (remove trailing sep if present, then re-add for prefix check)
    const normalizedWorkspace = workspaceDir.endsWith(sep)
      ? workspaceDir.slice(0, -1)
      : workspaceDir;

    // The target's parent directory must be exactly workspaceDir (direct child only).
    // This guards against nested paths like "a/b/c" and all traversal variants.
    const expectedParent = normalizedWorkspace;
    const actualParent = resolve(targetPath, '..');

    if (actualParent !== expectedParent) {
      throw new WorkspaceMutatorError(
        `Pfad-Traversal oder ungültiger Klon-Name: "${name}"`,
        'traversal',
      );
    }

    return { workspaceDir: normalizedWorkspace, targetPath };
  }

  /**
   * Pull a local clone strictly within WORKSPACE_DIR (AC3, AC4).
   *
   * Steps:
   *   1. Validate the target path (traversal/symlink-flucht prevention — AC4).
   *   2. Check the target exists via lstat() (no symlink following).
   *   3. Mint an Installation Token via the provided mintTokenFn (transient, AC3).
   *   4. Write a GIT_ASKPASS helper script to a tmp file; pass token via a randomly-
   *      named env var (token never in argv / process list / origin URL — AC3).
   *   5. Run `git pull` in the clone dir with GIT_ASKPASS + token env set.
   *   6. Clean up the temp askpass script regardless of outcome.
   *   7. Discard token — it is never returned, logged, audited, or written anywhere.
   *
   * Token-injection mechanism (GIT_ASKPASS, AC3):
   *   - A temp shell script is written to a random path in $TMPDIR.
   *   - The script reads the token from a randomly-named env var (not argv)
   *     and prints "token <value>\n" to stdout.
   *   - GIT_ASKPASS=<script> is set in the child env; git calls the script
   *     to obtain HTTPS credentials without ever putting the token in argv.
   *   - The randomly-named env var is NOT exported beyond this method scope.
   *   - The temp script is deleted (unlink) in a finally block.
   *
   * @param {string} name          The clone folder name from user input (e.g. "my-repo").
   * @param {() => Promise<string>} mintTokenFn
   *   Async function that mints a fresh Installation Token (transient).
   *   Must resolve to the raw token string. Never called if validation fails.
   * @returns {Promise<{ summary: string }>}  stdout snippet from git pull (credential-free).
   * @throws {WorkspaceMutatorError} on traversal, not-found, credentials-missing, or pull failure.
   */
  async pullClone(name, mintTokenFn) {
    const wsDir = await this.#resolveWorkspaceDir();
    const { workspaceDir, targetPath } = this.#validateTarget(name, wsDir);

    // Check target exists — lstat does NOT follow symlinks (AC4).
    try {
      await this.#fsDeps.lstat(targetPath);
    } catch {
      throw new WorkspaceMutatorError(
        `Klon "${name}" nicht gefunden in WORKSPACE_DIR`,
        'not-found',
      );
    }

    // C1: Symlink-Flucht guard — resolve the real path and verify it is still
    // inside WORKSPACE_DIR.  lstat() above only confirms the entry exists as a
    // symlink; if that symlink points outside WORKSPACE_DIR, git pull would run
    // in the resolved external directory, violating AC4.
    try {
      const realWorkspace = await this.#fsDeps.realpath(workspaceDir);
      const realTarget = await this.#fsDeps.realpath(targetPath);
      // realTarget must start with realWorkspace + sep (direct-child check)
      const wsPrefix = realWorkspace.endsWith(sep) ? realWorkspace : realWorkspace + sep;
      if (!realTarget.startsWith(wsPrefix)) {
        throw new WorkspaceMutatorError(
          `Symlink-Flucht erkannt: "${name}" zeigt außerhalb von WORKSPACE_DIR`,
          'traversal',
        );
      }
    } catch (err) {
      if (err instanceof WorkspaceMutatorError) throw err;
      // realpath failed (broken symlink or race) — treat as not-found
      throw new WorkspaceMutatorError(
        `Klon "${name}" nicht auflösbar in WORKSPACE_DIR`,
        'not-found',
      );
    }

    // Mint token IMMEDIATELY before git pull (AC3 — transient).
    let token;
    try {
      token = await mintTokenFn();
    } catch {
      // Never log the error details — may contain credential context.
      throw new WorkspaceMutatorError(
        'Installation-Token konnte nicht gemintet werden',
        'credentials-missing',
      );
    }

    if (typeof token !== 'string' || !token.trim()) {
      throw new WorkspaceMutatorError(
        'Installation-Token ist leer oder ungültig',
        'credentials-missing',
      );
    }

    // Build GIT_ASKPASS: a temp script that reads the token from a randomly-named env var.
    // The token never appears in argv or the script file itself — only via env var.
    const envVarName = `_GHTOKEN_${randomBytes(8).toString('hex').toUpperCase()}`;
    const askpassScript = join(
      tmpdir(),
      `_git_askpass_${randomBytes(8).toString('hex')}.sh`,
    );

    // Write + make executable using the shared helper (correct case/*) pattern — C2 fix).
    // Clean up in finally.
    let askpassCreated = false;
    try {
      // Use shared writeAskpassScript: injects the correct case/$1 / printenv pattern.
      // The token is NOT written into the script file; it lives in [envVarName] env var only.
      await writeAskpassScript(askpassScript, envVarName, this.#fsDeps.writeFile);
      askpassCreated = true;

      // S2: Minimal child env — allowlist only (HOME, PATH, USER, LANG, TMP, TMPDIR)
      // plus GIT_ASKPASS, GIT_TERMINAL_PROMPT, and the token env var.
      // We do NOT spread process.env to avoid leaking host secrets into the git child.
      const childEnv = minimalGitEnv({
        GIT_ASKPASS: askpassScript,
        GIT_TERMINAL_PROMPT: '0', // disable interactive prompts
        [envVarName]: token,       // token via env var, not argv
      });

      // Run git pull in the clone directory.
      let pullResult;
      try {
        pullResult = await this.#execFn('git', ['pull'], {
          cwd: targetPath,
          timeout: PULL_TIMEOUT_MS,
          env: childEnv,
        });
      } catch (err) {
        // Parse stderr for known error conditions; never leak token.
        const rawErr = String(err?.message ?? '');
        const safeErr = rawErr
          .replace(/x-access-token:[^\s@]*/gi, 'x-access-token:[REDACTED]')
          .replace(/ghp_[A-Za-z0-9]{10,}/g, '[REDACTED]')
          .replace(/ghs_[A-Za-z0-9]{10,}/g, '[REDACTED]')
          .slice(0, 300);

        // S1: Detect "no remote configured" case.
        if (rawErr.includes('does not appear to be a git repository')) {
          throw new WorkspaceMutatorError(
            `Kein Remote konfiguriert für "${name}": ${safeErr}`,
            'no-remote',
          );
        }

        throw new WorkspaceMutatorError(
          `git pull fehlgeschlagen für "${name}": ${safeErr}`,
          'pull-failed',
        );
      } finally {
        // Zeroize token reference immediately after git pull attempt.
        // envVarName is local — it leaves no trace beyond this scope.
        token = null; // allow GC
      }

      // Sanitize stdout before returning — strip any accidental credential leaks.
      const rawSummary = String(pullResult?.stdout ?? '').slice(0, 2000);
      const summary = rawSummary
        .replace(/x-access-token:[^\s@]*/gi, 'x-access-token:[REDACTED]')
        .replace(/ghp_[A-Za-z0-9]{10,}/g, '[REDACTED]')
        .replace(/ghs_[A-Za-z0-9]{10,}/g, '[REDACTED]');

      return { summary };
    } finally {
      // Always clean up the askpass script — even on error.
      if (askpassCreated) {
        try {
          await this.#fsDeps.unlink(askpassScript);
        } catch {
          // Best-effort; temp file cleanup failure is not a security issue
          // (script content doesn't contain the token itself — only env-var reference).
        }
      }
    }
  }

  /**
   * Delete a local clone strictly within WORKSPACE_DIR (AC5).
   *
   * Steps:
   *   1. Validate the target path (traversal/symlink-flucht prevention).
   *   2. Check the target exists via lstat() (no symlink following).
   *   3. Remove with `rm -rf <targetPath>` (operates on the entry itself,
   *      never dereferences symlinks pointing outside).
   *
   * @param {string} name  The clone folder name from user input (e.g. "my-repo").
   * @returns {Promise<void>}
   * @throws {WorkspaceMutatorError} on traversal, not-found, or rm failure.
   */
  async deleteClone(name) {
    const wsDir = await this.#resolveWorkspaceDir();
    const { targetPath } = this.#validateTarget(name, wsDir);

    // Check target exists — lstat does NOT follow symlinks.
    // If name is a symlink pointing outside, lstat still succeeds for the symlink itself.
    try {
      await this.#fsDeps.lstat(targetPath);
    } catch {
      throw new WorkspaceMutatorError(
        `Klon "${name}" nicht gefunden in WORKSPACE_DIR`,
        'not-found',
      );
    }

    // Delete the target.
    // `rm -rf` on a symlink removes the symlink itself, not its target — safe.
    // We pass the absolute targetPath (already validated) as the sole argument.
    try {
      await this.#execFn('rm', ['-rf', '--', targetPath], { timeout: RM_TIMEOUT_MS });
    } catch (err) {
      const safeMsg = String(err?.message ?? '').slice(0, 200);
      throw new WorkspaceMutatorError(
        `Löschen von "${name}" fehlgeschlagen: ${safeMsg}`,
        'rm-failed',
      );
    }
  }
}
