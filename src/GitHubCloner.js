/**
 * GitHubCloner — local git clone boundary for GitHub Org repos (AC1–AC7).
 *
 * Implements `POST /api/github/repos/clone`:
 *   - Mints a fresh Installation Token immediately before the clone (AC3).
 *   - Token is passed via environment variable + GIT_ASKPASS helper (never in argv).
 *   - After the clone the origin remote is rewritten to a credential-free URL (AC3).
 *   - Klon-Ziel is strikt within WORKSPACE_DIR (path-traversal + symlink guard) (AC2).
 *   - Re-clone without `force` → error (AC4).
 *   - Audit-First: Intent + Outcome (AC5).
 *   - Identitäts-/Rollencheck via CRED_ADMIN_EMAILS (AC6).
 *
 * Security (NFR):
 *   - Token NEVER in argv, clone URL, response, log, audit, or persisted origin.
 *   - GIT_ASKPASS helper reads token from env var (not argv).
 *   - After clone: `git remote set-url origin <credential-free-url>`.
 *   - Untrusted `repo` input is validated before any filesystem or git call.
 *   - Resolved clone path checked to be strictly inside WORKSPACE_DIR (realpath guard).
 *
 * Token-Minting: delegates to shared githubAppToken helper (same as GitHubWriter,
 * WorkspaceMutator/workspaceReposRouter). No private mint implementation.
 *
 * @module GitHubCloner
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  mintInstallationToken,
  writeAskpassScript,
  minimalGitEnv,
  GitHubAppTokenError,
} from './githubAppToken.js';

const execFileAsync = promisify(execFile);

/** Org for clone URLs. Matches GitHubReader/GitHubWriter. */
const ORG = 'Studis-Softwareschmiede';

/** Fetch timeout in ms (for the fetchWithTimeout wrapper used by #mintInstallationToken). */
const FETCH_TIMEOUT_MS = 15000;

/** Git clone timeout in ms. */
const GIT_CLONE_TIMEOUT_MS = 120000;

/** Git remote-set-url timeout in ms. */
const GIT_REMOTE_TIMEOUT_MS = 10000;

/**
 * Validates the `repo` field from the request body.
 * Accepts either "owner/name" or plain "name" (within the Org).
 * Returns { ok, repoName, error }.
 *
 * Security: rejects any path-traversal characters ('/', '..', absolute paths)
 * that could escape WORKSPACE_DIR — the repo name is used as a directory name.
 *
 * @param {unknown} repo
 * @returns {{ ok: boolean, repoName?: string, error?: string }}
 */
export function validateRepoRef(repo) {
  if (typeof repo !== 'string' || repo.trim() === '') {
    return { ok: false, error: 'repo ist ein Pflichtfeld und darf nicht leer sein' };
  }
  const r = repo.trim();

  // Reject any traversal characters immediately — before any splitting
  // This prevents bypass via "owner-segment/../etc" patterns
  if (r.includes('..')) {
    return { ok: false, error: 'repo-Referenz darf keine aufeinanderfolgenden Punkte (..) enthalten' };
  }
  // Reject absolute paths
  if (r.startsWith('/')) {
    return { ok: false, error: 'repo-Referenz darf kein absoluter Pfad sein' };
  }

  // Accept "owner/name" — strip owner prefix if it matches the Org
  let name;
  if (r.includes('/')) {
    const parts = r.split('/');
    if (parts.length !== 2) {
      return { ok: false, error: 'repo-Referenz ungültig: nur "name" oder "owner/name" erlaubt' };
    }
    // The second part is the repo name; owner is ignored for URL construction
    name = parts[1];
  } else {
    name = r;
  }

  // Repo name validation (GitHub limits)
  if (name.length === 0 || name.length > 100) {
    return {
      ok: false,
      error: 'Repo-Name muss 1–100 Zeichen lang sein',
    };
  }
  // Only alphanumerics, hyphens, underscores, dots — NO slashes or traversal
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && !/^[a-zA-Z0-9]$/.test(name)) {
    // Single char is valid; multi-char checked separately
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/.test(name) && name.length > 1) {
      return {
        ok: false,
        error:
          'Repo-Name enthält ungültige Zeichen. Erlaubt: Buchstaben, Ziffern, Bindestriche, Unterstriche, Punkte.',
      };
    }
  }
  if (name.includes('..')) {
    return { ok: false, error: 'Repo-Name darf keine aufeinanderfolgenden Punkte enthalten' };
  }
  // Reject anything that could be a path traversal attack
  if (name.startsWith('.') || name.endsWith('.') || name.startsWith('-') || name.endsWith('-')) {
    return {
      ok: false,
      error: 'Repo-Name darf nicht mit Punkt oder Bindestrich beginnen/enden',
    };
  }

  return { ok: true, repoName: name };
}

/**
 * GitHubCloner — clones Org repositories into WORKSPACE_DIR.
 *
 * @param {object} [options]
 * @param {import('./CredentialStore.js').CredentialStore} [options.credentialStore]
 * @param {string} [options.workspaceDir]  Override for WORKSPACE_DIR (default: env).
 *   Wird ignoriert wenn workspaceRootResolver gesetzt ist.
 * @param {Function} [options.workspaceRootResolver]
 *   Optionaler async Resolver `() => Promise<{ path: string, source: string }>`.
 *   Wenn gesetzt: wird pro Operation aufgerufen (AC5 — Effektivwert pro Operation).
 *   Wenn nicht gesetzt: workspaceDir-Parameter oder env-Fallback (AC9 — Verhaltensneutralität).
 * @param {typeof fetch} [options.fetchFn] Injectable fetch for tests (passed to mintInstallationToken)
 * @param {Function} [options.execFn]      Injectable exec for tests
 * @param {object} [options.fsDeps]        Injectable fs helpers for tests
 */
export class GitHubCloner {
  #credentialStore;
  #workspaceDir;
  #workspaceRootResolver;
  #fetch;
  #execFn;
  #fsDeps;

  constructor({ credentialStore, workspaceDir, workspaceRootResolver, fetchFn, execFn, fsDeps } = {}) {
    this.#credentialStore = credentialStore ?? null;
    this.#workspaceDir = workspaceDir ?? process.env.WORKSPACE_DIR ?? '';
    this.#workspaceRootResolver = workspaceRootResolver ?? null;
    // fetchFn is passed to the shared mintInstallationToken helper.
    // The helper calls fetchFn(url, init) — standard 2-arg form with signal in init.
    // If not injected, we provide a wrapper that adds an AbortController timeout.
    this.#fetch = fetchFn ?? ((...args) => fetchWithTimeout(...args));
    this.#execFn = execFn ?? defaultExec;
    // writeFile stays in fsDeps for the shared writeAskpassScript helper.
    // chmod is accepted for backward compatibility (no longer called directly).
    this.#fsDeps = fsDeps ?? { mkdir, access, realpath, rm, writeFile };
  }

  // ── Workspace-Root-Auflösung (AC5/AC9) ───────────────────────────────────────

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

  // ── Token Minting — delegates to shared githubAppToken helper ────────────────

  /**
   * Mints a fresh GitHub App Installation Token via the shared helper (transient).
   * Wraps GitHubAppTokenError into GitHubClonerError to preserve the cloner's
   * error taxonomy for callers (errorClass instead of code).
   *
   * @returns {Promise<string>} Installation token
   * @throws {GitHubClonerError}
   */
  async #mintInstallationToken() {
    // Preserve external taxonomy: null credentialStore → 'credential-store-missing'
    if (!this.#credentialStore) {
      throw new GitHubClonerError(
        'CredentialStore nicht konfiguriert — GitHub-App-Credentials nicht verfügbar',
        'credential-store-missing',
      );
    }

    try {
      // Pass this.#fetch so injected fetchFn in tests intercepts the token-mint call.
      // The shared helper calls fetchFn(url, init) — the wrapper handles timeout.
      return await mintInstallationToken(this.#credentialStore, {
        fetchFn: this.#fetch,
      });
    } catch (err) {
      // Branch on err.code (typed GitHubAppTokenError) — not on message strings
      if (err instanceof GitHubAppTokenError) {
        if (err.code === 'credentials-incomplete') {
          throw new GitHubClonerError(err.message, 'credentials-incomplete');
        }
        if (err.code === 'jwt-sign-failed') {
          throw new GitHubClonerError(
            `GitHub-App-JWT konnte nicht erstellt werden: ${sanitizeErrorMessage(err.message)}`,
            'jwt-sign-failed',
          );
        }
        if (err.code === 'network-error') {
          // Covers both "unreachable" and "auth-failed (HTTP NNN)" cases
          const statusMatch = err.message.match(/HTTP (\d+)/);
          if (statusMatch) {
            const status = Number(statusMatch[1]);
            throw new GitHubClonerError(
              `GitHub-App-Authentication fehlgeschlagen (HTTP ${status}). ` +
                'Prüfe App-ID, Installation-ID und Private-Key im CredentialStore.',
              'auth-failed',
              status,
            );
          }
          throw new GitHubClonerError(
            `GitHub-API nicht erreichbar (Token-Minting): ${sanitizeErrorMessage(err.message)}`,
            'network-error',
          );
        }
        // invalid-response or any other GitHubAppTokenError code
        throw new GitHubClonerError(err.message, 'invalid-response');
      }
      // Non-GitHubAppTokenError (unexpected) — re-throw so the router's default
      // case handles it (returns HTTP 502), preserving the pre-refactor behaviour.
      throw err;
    }
  }

  // ── Path-Traversal Guard ──────────────────────────────────────────────────────

  /**
   * Resolves and validates the clone target path.
   *
   * The clone target must be strictly inside WORKSPACE_DIR (AC2).
   * Strategy:
   *   1. Join WORKSPACE_DIR with the (untrusted) repoName.
   *   2. Ensure WORKSPACE_DIR itself resolves (exists).
   *   3. The joined path must start with the resolved WORKSPACE_DIR + separator.
   *
   * Note: we check BEFORE the clone (WORKSPACE_DIR must exist), and we use
   * `realpath` on the WORKSPACE_DIR to resolve symlinks on that side.
   * The clone target itself doesn't exist yet, so we can't realpath it —
   * instead we normalise via `join` (Node resolves `..` in join) and then
   * verify the prefix.
   *
   * @param {string} repoName  Validated repo name (no slashes, no ..)
   * @param {string} wsDir     Effective workspace directory (resolved by caller).
   * @returns {Promise<{ absPath: string, relPath: string }>}
   */
  async #resolveClonePath(repoName, wsDir) {
    if (!wsDir) {
      throw new GitHubClonerError(
        'WORKSPACE_DIR ist nicht konfiguriert',
        'workspace-missing',
      );
    }

    // Resolve WORKSPACE_DIR itself (handles symlinks on the workspace side)
    let resolvedWs;
    try {
      resolvedWs = await this.#fsDeps.realpath(wsDir);
    } catch {
      throw new GitHubClonerError(
        `WORKSPACE_DIR '${wsDir}' existiert nicht oder ist nicht zugänglich`,
        'workspace-missing',
      );
    }

    // Build the target path — join() normalises any residual '..' sequences
    const absPath = join(resolvedWs, repoName);

    // Strict prefix check (AC2: path-traversal guard)
    const wsPrefix = resolvedWs.endsWith('/') ? resolvedWs : resolvedWs + '/';
    if (!absPath.startsWith(wsPrefix) && absPath !== resolvedWs) {
      throw new GitHubClonerError(
        'Klon-Ziel liegt außerhalb von WORKSPACE_DIR — Path-Traversal abgewiesen',
        'traversal',
      );
    }

    const relPath = repoName;
    return { absPath, relPath };
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Clone a GitHub Org repository into WORKSPACE_DIR.
   *
   * Mints a fresh Installation Token immediately before the git clone.
   * Token is passed via GIT_ASKPASS env var helper (never in argv/log/audit).
   * After clone, origin is rewritten to a credential-free URL.
   *
   * @param {object} params
   * @param {string} params.repoName  Validated repo name
   * @param {boolean} [params.force]  If true, remove existing clone before cloning
   * @returns {Promise<{ repo: string, status: 'cloned', path: string }>}
   * @throws {GitHubClonerError}
   */
  async cloneRepo({ repoName, force = false }) {
    // AC5: Effektivwert pro Operation aufgelöst (nicht beim Boot eingefroren)
    const wsDir = await this.#resolveWorkspaceDir();

    // Ensure WORKSPACE_DIR exists (create idempotently)
    await this.#ensureWorkspaceDir(wsDir);

    // Resolve + guard clone target path (AC2)
    const { absPath, relPath } = await this.#resolveClonePath(repoName, wsDir);

    // AC4: Already-present check (before minting token)
    const exists = await this.#pathExists(absPath);
    if (exists && !force) {
      throw new GitHubClonerError(
        `Klon-Ziel '${relPath}' existiert bereits. Verwende force=true zum Überschreiben.`,
        'already-present',
      );
    }

    // Remove existing clone if force=true
    if (exists && force) {
      await this.#fsDeps.rm(absPath, { recursive: true, force: true });
    }

    // Mint token IMMEDIATELY before the clone (AC3 — transient)
    const token = await this.#mintInstallationToken();

    // Credential-free clone URL (token injected via GIT_ASKPASS env var, not in URL/argv)
    const cloneUrl = `https://github.com/${ORG}/${repoName}.git`;

    // AC3: Token NOT in argv — use askpass helper that reads token from env
    // We write a temp script that echoes the token from a specific env var.
    // The env var name contains a random suffix to prevent collision.
    const envVarName = `_GIT_CLONE_TOKEN_${randomBytes(8).toString('hex').toUpperCase()}`;
    const askpassScript = join(
      tmpdir(),
      `git-askpass-${randomBytes(8).toString('hex')}.sh`,
    );
    await writeAskpassScript(askpassScript, envVarName, this.#fsDeps.writeFile);

    try {
      // git clone with credential helper via GIT_ASKPASS (token in env, not argv)
      // Use the token-free URL so no credential is visible in argv
      await this.#execFn(
        'git',
        ['clone', '--', cloneUrl, absPath],
        {
          timeout: GIT_CLONE_TIMEOUT_MS,
          env: {
            ...minimalGitEnv(),
            GIT_ASKPASS: askpassScript,
            GIT_TERMINAL_PROMPT: '0', // disable interactive prompts
            [envVarName]: token,       // token in env var, not argv (AC3)
          },
        },
      );
    } catch (err) {
      // AC7: clean up partial clone directory
      await this.#fsDeps.rm(absPath, { recursive: true, force: true }).catch(() => {});
      const msg = sanitizeErrorMessage(err.message ?? '');
      if (msg.includes('not found') || msg.includes('repository') || msg.includes('404')) {
        throw new GitHubClonerError(
          `Repository '${repoName}' nicht gefunden oder kein Zugriff`,
          'repo-not-found',
        );
      }
      throw new GitHubClonerError(
        `git clone fehlgeschlagen: ${msg}`,
        'clone-failed',
      );
    } finally {
      // Always clean up the askpass script (contains no secret itself — token is in env)
      await this.#fsDeps.rm(askpassScript, { force: true }).catch(() => {});
      // token goes out of scope here — not retained; cloneUrlWithToken was never used (AC3)
    }

    // AC3: Rewrite origin to credential-free URL (token must not persist in .git/config)
    try {
      await this.#execFn(
        'git',
        ['remote', 'set-url', 'origin', cloneUrl],
        {
          timeout: GIT_REMOTE_TIMEOUT_MS,
          cwd: absPath,
          env: minimalGitEnv(),
        },
      );
    } catch (err) {
      // Non-fatal — clone succeeded; origin rewrite failure is logged but doesn't fail the request
      // (The credential-free URL is the same as cloneUrl which was already used without creds)
      console.warn('[GitHubCloner] git remote set-url failed (non-fatal):', err.code ?? err.message?.slice(0, 80));
    }

    return { repo: repoName, status: 'cloned', path: relPath };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /**
   * Ensures WORKSPACE_DIR exists (idempotent, uid-1000-writable assumed by infra).
   *
   * @param {string} wsDir  Effective workspace directory (resolved by caller).
   */
  async #ensureWorkspaceDir(wsDir) {
    if (!wsDir) {
      throw new GitHubClonerError(
        'WORKSPACE_DIR ist nicht konfiguriert',
        'workspace-missing',
      );
    }
    try {
      await this.#fsDeps.mkdir(wsDir, { recursive: true });
    } catch (err) {
      // mkdir throws if exists AND some other error — recursive: true suppresses EEXIST
      throw new GitHubClonerError(
        `WORKSPACE_DIR '${wsDir}' konnte nicht angelegt werden: ${sanitizeErrorMessage(err.message)}`,
        'workspace-not-writable',
      );
    }
  }

  /**
   * Checks whether a path exists (any type).
   * @param {string} absPath
   * @returns {Promise<boolean>}
   */
  async #pathExists(absPath) {
    try {
      await this.#fsDeps.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

}

// ── GitHubClonerError ─────────────────────────────────────────────────────────

/**
 * Typed error thrown by GitHubCloner.
 * Token and secrets MUST NOT appear in `message`.
 */
export class GitHubClonerError extends Error {
  /**
   * @param {string} message      - Human-readable message (NO secrets)
   * @param {string} errorClass   - Machine-readable class (router maps to HTTP status)
   * @param {number} [httpStatus] - Upstream HTTP status (if applicable)
   */
  constructor(message, errorClass, httpStatus) {
    super(message);
    this.name = 'GitHubClonerError';
    this.errorClass = errorClass;
    this.httpStatus = httpStatus ?? null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch with timeout.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [timeoutMs]
 * @param {typeof fetch} [fetchFn]
 */
async function fetchWithTimeout(url, init, timeoutMs = FETCH_TIMEOUT_MS, fetchFn = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default exec: runs execFile with timeout.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 */
async function defaultExec(cmd, args, opts = {}) {
  const { timeout, cwd, env } = opts;
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: timeout ?? GIT_CLONE_TIMEOUT_MS,
    cwd,
    env,
  });
  return { stdout, stderr };
}

/**
 * Strips anything that looks like a token or secret from an error message.
 * @param {string} msg
 * @returns {string}
 */
function sanitizeErrorMessage(msg) {
  if (typeof msg !== 'string') return 'unknown error';
  return msg
    .replace(/ghp_[A-Za-z0-9]{30,}/g, '[REDACTED]')
    .replace(/ghs_[A-Za-z0-9]{30,}/g, '[REDACTED]')
    .replace(/https?:\/\/[^@]*@/g, 'https://[REDACTED]@')
    .replace(/-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g, '[REDACTED-PEM]')
    .slice(0, 256);
}
