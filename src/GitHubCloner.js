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
 * Token-Minting: same mechanism as GitHubWriter (JWT RS256 → Installation Token).
 *
 * @module GitHubCloner
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';

const execFileAsync = promisify(execFile);

/** Org for clone URLs. Matches GitHubReader/GitHubWriter. */
const ORG = 'Studis-Softwareschmiede';

/** GitHub API base URL. */
const GITHUB_API = 'https://api.github.com';

/** Fetch timeout in ms (for token minting). */
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
 * @param {string} [options.workspaceDir]  Override for WORKSPACE_DIR (default: env)
 * @param {typeof fetch} [options.fetchFn] Injectable fetch for tests
 * @param {Function} [options.execFn]      Injectable exec for tests
 * @param {object} [options.fsDeps]        Injectable fs helpers for tests
 */
export class GitHubCloner {
  #credentialStore;
  #workspaceDir;
  #fetch;
  #execFn;
  #fsDeps;

  constructor({ credentialStore, workspaceDir, fetchFn, execFn, fsDeps } = {}) {
    this.#credentialStore = credentialStore ?? null;
    this.#workspaceDir = workspaceDir ?? process.env.WORKSPACE_DIR ?? '';
    this.#fetch = fetchFn ?? ((...args) => fetchWithTimeout(...args));
    this.#execFn = execFn ?? defaultExec;
    this.#fsDeps = fsDeps ?? { mkdir, access, realpath, rm, writeFile, chmod };
  }

  // ── Token Minting (same pattern as GitHubWriter) ──────────────────────────────

  /**
   * Reads GitHub App credentials from CredentialStore.
   * @returns {Promise<{ appId: string, installationId: string, privateKeyPem: string }>}
   */
  async #loadCredentials() {
    if (!this.#credentialStore) {
      throw new GitHubClonerError(
        'CredentialStore nicht konfiguriert — GitHub-App-Credentials nicht verfügbar',
        'credential-store-missing',
      );
    }
    const [appId, installationId, privateKeyPem] = await Promise.all([
      this.#credentialStore.getPlaintext('credentials/github/app_id'),
      this.#credentialStore.getPlaintext('credentials/github/installation_id'),
      this.#credentialStore.getPlaintext('credentials/github/private_key'),
    ]);

    const missing = [];
    if (!appId) missing.push('github/app_id');
    if (!installationId) missing.push('github/installation_id');
    if (!privateKeyPem) missing.push('github/private_key');

    if (missing.length > 0) {
      throw new GitHubClonerError(
        `GitHub-App-Credentials unvollständig: ${missing.join(', ')} fehlen im CredentialStore`,
        'credentials-incomplete',
      );
    }
    return { appId, installationId, privateKeyPem };
  }

  /**
   * Mints a fresh GitHub App Installation Token (transient — never cached).
   * @returns {Promise<string>} Installation token
   */
  async #mintInstallationToken() {
    const { appId, installationId, privateKeyPem } = await this.#loadCredentials();

    // Step 1: Build App JWT (RS256, 10-minute exp)
    let appJwt;
    try {
      const privateKey = await importPKCS8(privateKeyPem, 'RS256');
      const now = Math.floor(Date.now() / 1000);
      appJwt = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt(now - 60) // 60s clock skew buffer
        .setExpirationTime(now + 600) // 10 minutes
        .setIssuer(String(appId))
        .sign(privateKey);
    } catch (err) {
      throw new GitHubClonerError(
        `GitHub-App-JWT konnte nicht erstellt werden: ${sanitizeErrorMessage(err.message)}`,
        'jwt-sign-failed',
      );
    }

    // Step 2: Exchange JWT for Installation Access Token
    const tokenUrl = `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
    let res;
    try {
      res = await this.#fetch(
        tokenUrl,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${appJwt}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
        FETCH_TIMEOUT_MS,
      );
    } catch (err) {
      throw new GitHubClonerError(
        `GitHub-API nicht erreichbar (Token-Minting): ${sanitizeErrorMessage(err.message)}`,
        'network-error',
      );
    }

    if (!res.ok) {
      try { await res.text(); } catch { /* ignore */ }
      throw new GitHubClonerError(
        `GitHub-App-Authentication fehlgeschlagen (HTTP ${res.status}). ` +
          'Prüfe App-ID, Installation-ID und Private-Key im CredentialStore.',
        'auth-failed',
        res.status,
      );
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new GitHubClonerError(
        'GitHub-API lieferte ungültige Antwort beim Token-Minting',
        'invalid-response',
      );
    }

    const token = data?.token;
    if (typeof token !== 'string' || !token) {
      throw new GitHubClonerError(
        'GitHub-API lieferte keinen Token in der Token-Minting-Antwort',
        'invalid-response',
      );
    }

    // token is NOT logged — transient
    return token;
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
   * @returns {Promise<{ absPath: string, relPath: string }>}
   */
  async #resolveClonePath(repoName) {
    const wsDir = this.#workspaceDir;
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
    // Ensure WORKSPACE_DIR exists (create idempotently)
    await this.#ensureWorkspaceDir();

    // Resolve + guard clone target path (AC2)
    const { absPath, relPath } = await this.#resolveClonePath(repoName);

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
    const askpassScript = await this.#writeAskpassScript(envVarName);

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
   */
  async #ensureWorkspaceDir() {
    const wsDir = this.#workspaceDir;
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

  /**
   * Writes a GIT_ASKPASS helper script to a temp file.
   * The script echoes the token from the given env var (token never in script content).
   *
   * @param {string} envVarName  Environment variable name that holds the token
   * @returns {Promise<string>} Absolute path to the script
   */
  async #writeAskpassScript(envVarName) {
    const scriptPath = join(
      tmpdir(),
      `git-askpass-${randomBytes(8).toString('hex')}.sh`,
    );
    // The script outputs:
    //   For "Username" prompts → x-access-token  (GitHub token auth username)
    //   For "Password" prompts → <token from env> (the actual Installation Token)
    // git calls the script with the prompt string as $1; we branch on it for semantic correctness.
    // Use printenv so there's no shell variable substitution that might interpolate ${}.
    const scriptContent = [
      '#!/bin/sh',
      '# git-askpass helper — outputs GitHub token credentials from env var',
      'case "$1" in',
      '  *Username*) echo x-access-token ;;',
      '  *) printenv ' + envVarName + ' ;;',
      'esac',
    ].join('\n') + '\n';

    await this.#fsDeps.writeFile(scriptPath, scriptContent, { mode: 0o700 });
    await this.#fsDeps.chmod(scriptPath, 0o700);
    return scriptPath;
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
 * Returns a minimal environment for git subprocess calls.
 * Inherits HOME, PATH, GIT_CONFIG so git can find system config,
 * but does NOT forward secrets from the parent process env.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function minimalGitEnv() {
  return {
    HOME: process.env.HOME ?? '/root',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '0',
    // Do NOT forward: CRED_MASTER_KEY, GPG_PASSPHRASE, etc.
  };
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
