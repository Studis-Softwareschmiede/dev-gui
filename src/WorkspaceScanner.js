/**
 * WorkspaceScanner — Workspace-FS/Git Boundary (read-only portion, AC1, AC2).
 *
 * Architecture boundary: the ONLY place that reads WORKSPACE_DIR from the
 * filesystem and executes git commands on local clones for the listing endpoint.
 *
 * Design:
 *   - Scans direct subdirectories of WORKSPACE_DIR live on every call (ADR-005:
 *     no store, no cache).
 *   - A subdirectory is a clone iff it contains a `.git` entry.
 *   - Per clone reports: name, branch, dirty, lastCommit, originUrl.
 *   - originUrl is ALWAYS credential-free before leaving this boundary (AC2).
 *   - Injectable execFn and fsDeps for unit testing without real git/FS.
 *   - Graceful degradation: WORKSPACE_DIR missing/unset → empty repos list.
 *   - Per-clone git errors → that clone reports safe fallback values.
 *
 * Security:
 *   - Credentials (tokens/passwords in git remote URLs) are stripped (AC2).
 *   - Clone names come from the filesystem listing, never from user input —
 *     no path traversal is possible via this read path (AC1).
 *   - No secrets are logged (security/R01).
 *
 * @module WorkspaceScanner
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/** Default timeout for git subprocess calls (ms). */
const GIT_TIMEOUT_MS = 8000;

/**
 * Strip credentials from a git remote URL.
 *
 * Handles the pattern:  scheme://user:password@host/...
 * e.g.  https://x-access-token:ghs_abc123@github.com/org/repo.git
 *   →   https://github.com/org/repo.git
 *
 * Also handles user-only (no password) userinfo: user@host → host
 *
 * Returns the input unchanged if it is not a URL (e.g. SSH git@host:... format,
 * or null/undefined).
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function stripCredentials(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    const parsed = new URL(url);
    // Remove username + password from the URL authority
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
    return url;
  } catch {
    // Not a parseable URL (e.g. git@github.com:org/repo.git SSH shorthand)
    // Apply a regex strip for the userinfo@ portion as a safety net.
    // git SSH remote format: git@github.com:org/repo.git — has no embedded creds.
    // Defensive strip for any scheme://user:pass@host pattern even if URL() fails:
    return url.replace(/^([a-zA-Z][a-zA-Z0-9+\-.]*:\/\/)[^@]*@/, '$1');
  }
}

/**
 * WorkspaceScanner reads local git clones from WORKSPACE_DIR.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceDir]
 *   Override for the workspace directory (default: process.env.WORKSPACE_DIR).
 * @param {Function} [options.execFn]
 *   Injectable exec function for tests: `(cmd, args, options) => Promise<{stdout}>`.
 *   Defaults to promisified execFile.
 * @param {object} [options.fsDeps]
 *   Injectable filesystem helpers for tests: `{ stat, readdir }`.
 *   Defaults to node:fs/promises equivalents.
 */
export class WorkspaceScanner {
  #workspaceDir;
  #execFn;
  #fsDeps;

  constructor({ workspaceDir, execFn, fsDeps } = {}) {
    this.#workspaceDir = workspaceDir ?? process.env.WORKSPACE_DIR ?? '';
    this.#execFn = execFn ?? this.#defaultExec.bind(this);
    this.#fsDeps = fsDeps ?? { stat, readdir };
  }

  /**
   * Default exec: runs execFile with timeout, returns { stdout }.
   *
   * @param {string} cmd
   * @param {string[]} args
   * @param {{ cwd?: string }} [opts]
   * @returns {Promise<{ stdout: string }>}
   */
  async #defaultExec(cmd, args, opts = {}) {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: GIT_TIMEOUT_MS,
      cwd: opts.cwd,
      // Do not inherit WORKSPACE_DIR env unnecessarily; sanitise only what git needs.
      // Inherit full env so git picks up system config (HOME, GIT_CONFIG, etc.).
    });
    return { stdout };
  }

  /**
   * Run a git command in the given clone directory.
   * Returns stdout string or null on error.
   *
   * @param {string} cloneDir  Absolute path to the clone.
   * @param {string[]} args    git sub-command + args.
   * @returns {Promise<string|null>}
   */
  async #git(cloneDir, args) {
    try {
      const { stdout } = await this.#execFn('git', args, { cwd: cloneDir });
      return typeof stdout === 'string' ? stdout.trim() : null;
    } catch {
      // git command failed (not a repo, no remote, etc.) — safe degradation
      return null;
    }
  }

  /**
   * Resolve the current branch name in a clone.
   * Returns null on error (e.g. empty repo, detached HEAD).
   *
   * @param {string} cloneDir
   * @returns {Promise<string|null>}
   */
  async #getBranch(cloneDir) {
    return this.#git(cloneDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  /**
   * Check whether the working tree is dirty (has uncommitted changes).
   * Returns false (safe default) on error.
   *
   * @param {string} cloneDir
   * @returns {Promise<boolean>}
   */
  async #getDirty(cloneDir) {
    // --porcelain gives machine-readable output; empty string = clean
    const out = await this.#git(cloneDir, ['status', '--porcelain']);
    if (out === null) return false;
    return out.length > 0;
  }

  /**
   * Retrieve the last commit as { hash, subject, date }.
   * Returns null on error or empty repo.
   *
   * @param {string} cloneDir
   * @returns {Promise<{ hash: string, subject: string, date: string }|null>}
   */
  async #getLastCommit(cloneDir) {
    // Format: <short-hash>\x1f<subject>\x1f<ISO-date>
    const out = await this.#git(cloneDir, [
      'log', '-1', '--format=%h\x1f%s\x1f%aI',
    ]);
    if (!out) return null;
    const parts = out.split('\x1f');
    if (parts.length < 3) return null;
    return {
      hash: parts[0].trim(),
      subject: parts[1].trim(),
      date: parts[2].trim(),
    };
  }

  /**
   * Get the credential-free remote origin URL.
   * Returns null if no origin remote is configured.
   *
   * @param {string} cloneDir
   * @returns {Promise<string|null>}
   */
  async #getOriginUrl(cloneDir) {
    const raw = await this.#git(cloneDir, ['remote', 'get-url', 'origin']);
    if (!raw) return null;
    return stripCredentials(raw);
  }

  /**
   * Scan WORKSPACE_DIR and return live clone info.
   *
   * @returns {Promise<Array<{
   *   name: string,
   *   branch: string|null,
   *   dirty: boolean,
   *   lastCommit: { hash: string, subject: string, date: string }|null,
   *   originUrl: string|null
   * }>>}
   */
  async listClones() {
    const workspaceDir = this.#workspaceDir;

    // Edge-case: WORKSPACE_DIR not set / not a directory → empty list, no crash
    if (!workspaceDir) return [];

    let entries;
    try {
      entries = await this.#fsDeps.readdir(workspaceDir, { withFileTypes: true });
    } catch {
      // WORKSPACE_DIR does not exist or is not accessible
      return [];
    }

    // Filter to direct subdirectories only
    const subdirs = entries.filter((e) => e.isDirectory());

    // For each subdir, check for .git presence, then collect git info in parallel
    const results = await Promise.all(
      subdirs.map(async (entry) => {
        const name = entry.name;
        const cloneDir = join(workspaceDir, name);

        // Check for .git (file OR directory — submodules use a .git file)
        let hasGit = false;
        try {
          await this.#fsDeps.stat(join(cloneDir, '.git'));
          hasGit = true;
        } catch {
          // stat failed → no .git present
        }

        if (!hasGit) return null; // Not a git clone — skip

        // Collect git info; each call degrades independently on error
        const [branch, dirty, lastCommit, originUrl] = await Promise.all([
          this.#getBranch(cloneDir),
          this.#getDirty(cloneDir),
          this.#getLastCommit(cloneDir),
          this.#getOriginUrl(cloneDir),
        ]);

        return { name, branch, dirty, lastCommit, originUrl };
      }),
    );

    // Remove null entries (non-git subdirs)
    return results.filter(Boolean);
  }
}
