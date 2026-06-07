/**
 * WorkspaceMutator — Workspace-FS Mutation Boundary (delete, AC5).
 *
 * Architecture boundary: the ONLY place that performs mutating filesystem
 * operations on WORKSPACE_DIR (deleting local clones, and in a later item:
 * git pull). Complements WorkspaceScanner (read-only).
 *
 * Design:
 *   - Target path is resolved with path.resolve() to prevent `..` traversal.
 *   - Symlink-Flucht protection: we verify the resolved path starts with
 *     WORKSPACE_DIR + sep AND is exactly one level deep (direct child only).
 *     We use lstat() (not stat() / realpath()) so a symlink inside WORKSPACE_DIR
 *     is treated as a filesystem entry at that path — we delete the link itself,
 *     never following it outside WORKSPACE_DIR.
 *   - Only direct children of WORKSPACE_DIR can be deleted (no nesting).
 *   - Injectable fsDeps for unit testing without real FS calls.
 *   - Graceful degradation on invalid input → throws with a typed error class.
 *
 * Security:
 *   - path.resolve() prevents any `..` / absolute path injection via the `name`
 *     field (AC5).
 *   - lstat() is used to confirm the target exists without following symlinks;
 *     rm -rf is run on the resolved path (not dereferenced), so symlinks pointing
 *     outside WORKSPACE_DIR are deleted as the link itself — target untouched (AC5).
 *   - No secrets are logged (security/R01).
 *
 * @module WorkspaceMutator
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const execFileAsync = promisify(execFile);

/** Timeout for the rm subprocess (ms). */
const RM_TIMEOUT_MS = 15000;

/**
 * @typedef {'traversal'|'not-found'|'rm-failed'|'workspace-unset'} MutatorErrorClass
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
 * @param {Function} [options.execFn]
 *   Injectable exec function for tests: `(cmd, args, options) => Promise<void>`.
 *   Defaults to promisified execFile.
 * @param {object} [options.fsDeps]
 *   Injectable filesystem helpers for tests: `{ lstat }`.
 *   Defaults to node:fs/promises equivalents.
 */
export class WorkspaceMutator {
  #workspaceDir;
  #execFn;
  #fsDeps;

  constructor({ workspaceDir, execFn, fsDeps } = {}) {
    this.#workspaceDir = workspaceDir ?? process.env.WORKSPACE_DIR ?? '';
    this.#execFn = execFn ?? this.#defaultExec.bind(this);
    this.#fsDeps = fsDeps ?? { lstat };
  }

  /**
   * Default exec: runs execFile with timeout.
   *
   * @param {string} cmd
   * @param {string[]} args
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<void>}
   */
  async #defaultExec(cmd, args, opts = {}) {
    await execFileAsync(cmd, args, {
      timeout: opts.timeout ?? RM_TIMEOUT_MS,
    });
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
   * @param {string} name  The clone folder name from user input.
   * @returns {{ workspaceDir: string, targetPath: string }}
   * @throws {WorkspaceMutatorError}
   */
  #validateTarget(name) {
    const workspaceDir = this.#workspaceDir;

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
    const { targetPath } = this.#validateTarget(name);

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
