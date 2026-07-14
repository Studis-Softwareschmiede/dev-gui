/**
 * WorkspaceMutator — Workspace-FS Mutation Boundary (delete AC5; pull AC3, AC4;
 * commitAndPushFile — per-app-gpg-passphrase-rotation, F-073/S-338, AC4/AC11).
 *
 * Architecture boundary: the ONLY place that performs mutating filesystem
 * operations on WORKSPACE_DIR (deleting local clones, pulling clones,
 * committing + pushing a single file within a clone — direct push, no PR).
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
 * Command-Scope credential-helper neutralization flags (workspace-mutator-
 * credential-helper AC1/AC2). Prepended to EVERY mutating/auth-relevant git
 * subcommand this module runs, so an ambient `credential.helper` (e.g. the
 * container-wide `!gh auth git-credential` set by `gh auth setup-git` in
 * docker-entrypoint.sh) is neutralized and git falls through to GIT_ASKPASS
 * exclusively — a stale gh-CLI token can no longer shadow the freshly minted
 * Installation Token. Command-Scope (`-c`) overrides system + global + all
 * other config scopes. Values are intentionally EMPTY (no secret in argv);
 * the token itself continues to flow exclusively via GIT_ASKPASS + a
 * randomly-named env var (minimalGitEnv), never via argv.
 * Flag-Kanon (order fixed, see docs/specs/workspace-mutator-credential-helper.md §Verträge):
 *   git -c credential.helper= -c credential.https://github.com.helper= <subcommand> …
 */
const GIT_CRED_HELPER_NEUTRALIZE_ARGS = [
  '-c', 'credential.helper=',
  '-c', 'credential.https://github.com.helper=',
];

/**
 * Prepends the Command-Scope credential-helper neutralization flags (see
 * GIT_CRED_HELPER_NEUTRALIZE_ARGS) to a git subcommand's argv, in the fixed
 * order the spec mandates — flags before the subcommand.
 *
 * @param {string[]} subArgs  e.g. ['pull'] or ['commit', '-m', msg]
 * @returns {string[]}
 */
function gitArgs(subArgs) {
  return [...GIT_CRED_HELPER_NEUTRALIZE_ARGS, ...subArgs];
}

/**
 * @typedef {'traversal'|'not-found'|'rm-failed'|'workspace-unset'|'pull-failed'|'no-remote'|'credentials-missing'|'commit-failed'|'push-failed'|'branch-mismatch'|'default-branch-undetermined'} MutatorErrorClass
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
        pullResult = await this.#execFn('git', gitArgs(['pull']), {
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
   * Commit + push a single file within a local clone directly to its
   * Default-Branch — NO PR (per-app-gpg-passphrase-rotation, F-073/S-338,
   * AC4/AC11; Review-Iteration 2 hardening — Finding 1 + Finding 2).
   *
   * Branch verification (Finding 2): the CURRENT branch (`git rev-parse
   * --abbrev-ref HEAD`) is verified against the AUTHORITATIVE remote default
   * (`git symbolic-ref --short refs/remotes/origin/HEAD`, set by `git clone`
   * and NOT touched by anything in this codebase) BEFORE any mutation. A
   * mismatch (e.g. a clone manually switched to a different branch via the
   * Terminal feature) aborts hard with `branch-mismatch` — no silent push to
   * a non-default branch.
   *
   * No-orphan-commit guarantee (Finding 1): the current `HEAD` sha is
   * captured BEFORE `git add`/`git commit`. If ANY step from that point on
   * fails (add/commit/push), the clone is rolled back to that sha via
   * `git reset --hard <prevHead>` (best-effort) before the error is thrown —
   * this also discards the uncommitted file write the caller already made
   * (`PerAppGpgRotationService` overwrites `.env.gpg` before calling this),
   * so a failed rotation never leaves the clone in a "kein Teil-/Misch-
   * Zustand"-verletzenden Zwischenstand (dirty working tree or orphaned
   * local commit that a plain `git pull` cannot clean up on retry).
   *
   * Steps:
   *   1. Validate the target path (traversal/symlink-flucht prevention — same
   *      guard as pullClone/deleteClone).
   *   2. Capture `prevHead` (`git rev-parse HEAD`) for the rollback guarantee.
   *   3. Verify the current branch equals the authoritative remote default.
   *   4. `git add -- <relFilePath>`.
   *   5. `git commit -m <commitMessage>` — a "nothing to commit" outcome is
   *      NOT treated as an error (defensive: content already matches).
   *   6. `git push origin HEAD:<verified-branch>` — token injected via
   *      GIT_ASKPASS (same mechanism as pullClone, AC3-style: never in argv).
   *
   * @param {string} name              The clone folder name (e.g. "my-app").
   * @param {string} relFilePath       Path relative to the clone root (e.g. ".env.gpg").
   * @param {() => Promise<string>} mintTokenFn
   *   Async function that mints a fresh Installation Token (transient).
   * @param {{ commitMessage?: string }} [opts]
   * @returns {Promise<{ summary: string }>} credential-free stdout snippet from git push.
   * @throws {WorkspaceMutatorError} errorClass: traversal|not-found|credentials-missing|branch-mismatch|commit-failed|push-failed
   */
  async commitAndPushFile(name, relFilePath, mintTokenFn, { commitMessage } = {}) {
    const wsDir = await this.#resolveWorkspaceDir();
    const { workspaceDir, targetPath } = this.#validateTarget(name, wsDir);

    // Check target exists — lstat does NOT follow symlinks.
    try {
      await this.#fsDeps.lstat(targetPath);
    } catch {
      throw new WorkspaceMutatorError(
        `Klon "${name}" nicht gefunden in WORKSPACE_DIR`,
        'not-found',
      );
    }

    // Symlink-Flucht guard (identical to pullClone).
    try {
      const realWorkspace = await this.#fsDeps.realpath(workspaceDir);
      const realTarget = await this.#fsDeps.realpath(targetPath);
      const wsPrefix = realWorkspace.endsWith(sep) ? realWorkspace : realWorkspace + sep;
      if (!realTarget.startsWith(wsPrefix)) {
        throw new WorkspaceMutatorError(
          `Symlink-Flucht erkannt: "${name}" zeigt außerhalb von WORKSPACE_DIR`,
          'traversal',
        );
      }
    } catch (err) {
      if (err instanceof WorkspaceMutatorError) throw err;
      throw new WorkspaceMutatorError(
        `Klon "${name}" nicht auflösbar in WORKSPACE_DIR`,
        'not-found',
      );
    }

    // Mint token IMMEDIATELY before git push (transient, same discipline as pullClone).
    let token;
    try {
      token = await mintTokenFn();
    } catch {
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

    const envVarName = `_GHTOKEN_${randomBytes(8).toString('hex').toUpperCase()}`;
    const askpassScript = join(
      tmpdir(),
      `_git_askpass_${randomBytes(8).toString('hex')}.sh`,
    );

    let askpassCreated = false;
    try {
      await writeAskpassScript(askpassScript, envVarName, this.#fsDeps.writeFile);
      askpassCreated = true;

      const childEnv = minimalGitEnv({
        GIT_ASKPASS: askpassScript,
        GIT_TERMINAL_PROMPT: '0',
        [envVarName]: token,
      });

      // Finding 1: capture the pre-mutation HEAD sha so ANY failure below can
      // be rolled back — no orphaned local commit / dirty working tree survives
      // a failed attempt.
      let prevHead = null;
      try {
        const headResult = await this.#execFn('git', gitArgs(['rev-parse', 'HEAD']), {
          cwd: targetPath,
          timeout: RM_TIMEOUT_MS,
          env: childEnv,
        });
        const sha = String(headResult?.stdout ?? '').trim();
        if (sha) prevHead = sha;
      } catch {
        // Very fresh/empty clone without a commit yet — no rollback anchor
        // available; failures below simply cannot be rolled back (best-effort).
        prevHead = null;
      }

      const rollbackToPrevHead = async () => {
        if (!prevHead) return;
        try {
          await this.#execFn('git', gitArgs(['reset', '--hard', prevHead]), {
            cwd: targetPath,
            timeout: RM_TIMEOUT_MS,
            env: childEnv,
          });
        } catch {
          // Best-effort — the primary (already-classified) error stays authoritative.
        }
      };

      // Finding 2: verify the checked-out branch against the AUTHORITATIVE
      // remote default (refs/remotes/origin/HEAD, set by `git clone`) BEFORE
      // any mutation — a manually-switched clone must never silently push to
      // a non-default branch.
      let branch;
      try {
        branch = await this.#verifyPushBranch(targetPath, childEnv, name);
      } catch (err) {
        await rollbackToPrevHead();
        throw err;
      }

      try {
        await this.#execFn('git', gitArgs(['add', '--', relFilePath]), {
          cwd: targetPath,
          timeout: RM_TIMEOUT_MS,
          env: childEnv,
        });
      } catch (err) {
        await rollbackToPrevHead();
        const safeErr = String(err?.message ?? '').slice(0, 300);
        throw new WorkspaceMutatorError(`git add fehlgeschlagen für "${name}": ${safeErr}`, 'commit-failed');
      }

      try {
        await this.#execFn(
          'git',
          gitArgs(['commit', '-m', commitMessage ?? `chore: rotate ${relFilePath}`]),
          { cwd: targetPath, timeout: RM_TIMEOUT_MS, env: childEnv },
        );
      } catch (err) {
        const rawErr = String(err?.message ?? '');
        if (!/nothing to commit/i.test(rawErr)) {
          await rollbackToPrevHead();
          const safeErr = rawErr.slice(0, 300);
          throw new WorkspaceMutatorError(`git commit fehlgeschlagen für "${name}": ${safeErr}`, 'commit-failed');
        }
        // "nothing to commit" — working tree already matches the (unmodified)
        // committed state — defensive no-op, not an error.
      }

      let pushResult;
      try {
        pushResult = await this.#execFn('git', gitArgs(['push', 'origin', `HEAD:${branch}`]), {
          cwd: targetPath,
          timeout: PULL_TIMEOUT_MS,
          env: childEnv,
        });
      } catch (err) {
        await rollbackToPrevHead();
        const rawErr = String(err?.message ?? '');
        const safeErr = rawErr
          .replace(/x-access-token:[^\s@]*/gi, 'x-access-token:[REDACTED]')
          .replace(/ghp_[A-Za-z0-9]{10,}/g, '[REDACTED]')
          .replace(/ghs_[A-Za-z0-9]{10,}/g, '[REDACTED]')
          .slice(0, 300);
        throw new WorkspaceMutatorError(`git push fehlgeschlagen für "${name}": ${safeErr}`, 'push-failed');
      } finally {
        token = null; // allow GC
      }

      const rawSummary = String(pushResult?.stdout ?? '').slice(0, 2000);
      const summary = rawSummary
        .replace(/x-access-token:[^\s@]*/gi, 'x-access-token:[REDACTED]')
        .replace(/ghp_[A-Za-z0-9]{10,}/g, '[REDACTED]')
        .replace(/ghs_[A-Za-z0-9]{10,}/g, '[REDACTED]');

      return { summary };
    } finally {
      if (askpassCreated) {
        try {
          await this.#fsDeps.unlink(askpassScript);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  /**
   * Finding 2 (per-app-gpg-passphrase-rotation Review-Iteration 2): verifies
   * the clone's checked-out branch against the AUTHORITATIVE remote default
   * branch (`refs/remotes/origin/HEAD`, set once by `git clone` — never
   * rewritten by WorkspaceMutator/GitHubCloner) BEFORE `commitAndPushFile`
   * mutates or pushes anything. A clone that was manually switched to a
   * different branch (e.g. via the Terminal feature) must hard-abort instead
   * of silently pushing the rotated `.env.gpg` to a non-default branch.
   *
   * @param {string} targetPath
   * @param {object} childEnv
   * @param {string} name
   * @returns {Promise<string>} the verified branch name (safe to push to).
   * @throws {WorkspaceMutatorError} errorClass: push-failed|branch-mismatch|default-branch-undetermined
   */
  async #verifyPushBranch(targetPath, childEnv, name) {
    let branchResult;
    try {
      branchResult = await this.#execFn('git', gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), {
        cwd: targetPath,
        timeout: RM_TIMEOUT_MS,
        env: childEnv,
      });
    } catch (err) {
      const safeErr = String(err?.message ?? '').slice(0, 300);
      throw new WorkspaceMutatorError(`Branch-Ermittlung fehlgeschlagen für "${name}": ${safeErr}`, 'push-failed');
    }
    const branch = String(branchResult?.stdout ?? '').trim();
    if (!branch || branch === 'HEAD') {
      throw new WorkspaceMutatorError(`Branch-Ermittlung fehlgeschlagen für "${name}": leerer Branch-Name oder losgelöster HEAD`, 'push-failed');
    }

    let defaultRefResult;
    try {
      defaultRefResult = await this.#execFn('git', gitArgs(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']), {
        cwd: targetPath,
        timeout: RM_TIMEOUT_MS,
        env: childEnv,
      });
    } catch {
      // `refs/remotes/origin/HEAD` ist nicht gesetzt (Klon ohne `set-head`, oder manuell
      // manipuliert — der häufige Realfall). Statt sofort zu scheitern: die Markierung aus
      // dem Remote herstellen (`git remote set-head origin -a` fragt den Remote nach seinem
      // Default-Branch und setzt die Ref lokal) und erneut lesen. So läuft die Rotation ohne
      // manuelles Nachhelfen. Erst wenn AUCH das scheitert, ist der Default-Branch wirklich
      // nicht ermittelbar → eigene, ehrliche Fehlerklasse `default-branch-undetermined`
      // (NICHT `push-failed`: der Push hat nie stattgefunden — diese Fehlklassifizierung
      // schickte Debugging fälschlich in Richtung Auth/Token, statt zur wahren Ursache).
      try {
        await this.#execFn('git', gitArgs(['remote', 'set-head', 'origin', '-a']), {
          cwd: targetPath,
          timeout: RM_TIMEOUT_MS,
          env: childEnv,
        });
        defaultRefResult = await this.#execFn('git', gitArgs(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']), {
          cwd: targetPath,
          timeout: RM_TIMEOUT_MS,
          env: childEnv,
        });
      } catch (err2) {
        const safeErr = String(err2?.message ?? '').slice(0, 300);
        throw new WorkspaceMutatorError(
          `Default-Branch nicht ermittelbar für "${name}" (refs/remotes/origin/HEAD nicht gesetzt und via 'git remote set-head origin -a' nicht herstellbar): ${safeErr}`,
          'default-branch-undetermined',
        );
      }
    }
    const defaultRef = String(defaultRefResult?.stdout ?? '').trim(); // e.g. "origin/main"
    const defaultBranch = defaultRef.startsWith('origin/') ? defaultRef.slice('origin/'.length) : defaultRef;
    if (!defaultBranch) {
      throw new WorkspaceMutatorError(`Default-Branch-Ermittlung fehlgeschlagen für "${name}": leerer Wert`, 'push-failed');
    }

    if (branch !== defaultBranch) {
      throw new WorkspaceMutatorError(
        `Klon "${name}" ist auf Branch "${branch}" statt dem Default-Branch "${defaultBranch}" ausgecheckt — Push abgebrochen (kein stiller Push auf einen Nicht-Default-Branch)`,
        'branch-mismatch',
      );
    }

    return branch;
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
