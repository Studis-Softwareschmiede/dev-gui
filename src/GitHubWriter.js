/**
 * GitHubWriter — the ONLY mutating GitHub boundary (AC2).
 *
 * Implements `POST /orgs/{org}/repos` to create an Org-Repository.
 * The read-only GitHubReader has NO write calls — this module keeps them separate.
 *
 * Security (AC3 / NFR):
 *   - Installation-Token is minted IMMEDIATELY BEFORE the GitHub call (transient).
 *   - Token NEVER appears in responses, logs, audit entries, WS streams, URLs, or argv.
 *   - App credentials come from CredentialStore schema `github`
 *     (app_id / installation_id / private_key) — never hard-coded.
 *   - Input is validated before any GitHub call (AC6 / security/R04).
 *
 * Token-Minting (GitHub App → Installation Token):
 *   1. Build a JWT signed with the App's private key (RS256, 10-minute exp).
 *   2. POST /app/installations/{id}/access_tokens with that JWT → {token}.
 *   3. Use token as `Authorization: Bearer <token>` for the actual API call.
 *   4. Token is discarded after the call (transient, not cached).
 *
 * Architecture (docs/architecture.md):
 *   GitHubWriter is the ONLY place that makes POST/PATCH/PUT/DELETE calls to GitHub.
 *   GitHubReader remains read-only.
 *
 * @module GitHubWriter
 */

import { SignJWT, importPKCS8 } from 'jose';

/** Org to create repos in. Matches GitHubReader. */
const ORG = 'Studis-Softwareschmiede';

/** GitHub API base URL. */
const GITHUB_API = 'https://api.github.com';

/** Fetch timeout in ms. */
const FETCH_TIMEOUT_MS = 15000;

/**
 * Valid GitHub repo name:
 *   - 1–100 characters
 *   - Only alphanumerics, hyphens, underscores, dots
 *   - Must not start or end with a dot or hyphen
 *   - Must not be two consecutive dots (..)
 *
 * Reference: https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits
 */
const REPO_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,98}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
const REPO_NAME_MAX = 100;

/**
 * Validates a GitHub repository name.
 * Returns { ok: true } or { ok: false, error: string }.
 *
 * @param {unknown} name
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateRepoName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'name ist ein Pflichtfeld und darf nicht leer sein' };
  }
  const n = name.trim();
  if (n.length > REPO_NAME_MAX) {
    return { ok: false, error: `name überschreitet Längenlimit (max. ${REPO_NAME_MAX} Zeichen)` };
  }
  if (!REPO_NAME_RE.test(n)) {
    return {
      ok: false,
      error:
        'name enthält ungültige Zeichen oder ist ungültig formatiert. ' +
        'Erlaubt: Buchstaben, Ziffern, Bindestriche, Unterstriche, Punkte. ' +
        'Darf nicht mit Bindestrich oder Punkt beginnen/enden.',
    };
  }
  // Reject ".." sequences (GitHub rejects these)
  if (n.includes('..')) {
    return { ok: false, error: 'name darf keine aufeinanderfolgenden Punkte (..) enthalten' };
  }
  return { ok: true };
}

/**
 * Validates the visibility field.
 * Returns { ok: true } or { ok: false, error: string }.
 *
 * @param {unknown} visibility
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateVisibility(visibility) {
  if (visibility === undefined || visibility === null) {
    return { ok: true }; // optional — defaults to 'private'
  }
  if (visibility !== 'private' && visibility !== 'public') {
    return { ok: false, error: 'visibility muss "private" oder "public" sein' };
  }
  return { ok: true };
}

/**
 * Fetch with a timeout. Rejects with AbortError on timeout.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [timeoutMs]
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Response>}
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
 * GitHubWriter — creates Org repositories via the GitHub REST API.
 *
 * @param {object} [options]
 * @param {import('./CredentialStore.js').CredentialStore} [options.credentialStore]
 *   Store to read GitHub App credentials from (schema `github`).
 *   If omitted, token minting will fail with a clear error.
 * @param {typeof fetch} [options.fetchFn]
 *   Injectable fetch implementation for testing.
 */
export class GitHubWriter {
  #credentialStore;
  #fetch;

  constructor({ credentialStore, fetchFn } = {}) {
    this.#credentialStore = credentialStore ?? null;
    this.#fetch = fetchFn ?? ((...args) => fetchWithTimeout(...args));
  }

  // ── Token Minting ─────────────────────────────────────────────────────────────

  /**
   * Reads GitHub App credentials from the CredentialStore.
   * Throws a clear error (no secret leak) if any field is missing.
   *
   * @returns {Promise<{ appId: string, installationId: string, privateKeyPem: string }>}
   */
  async #loadCredentials() {
    if (!this.#credentialStore) {
      throw new GitHubWriterError(
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
      // Do NOT include values in this message — just field names
      throw new GitHubWriterError(
        `GitHub-App-Credentials unvollständig: ${missing.join(', ')} fehlen im CredentialStore`,
        'credentials-incomplete',
      );
    }

    return { appId, installationId, privateKeyPem };
  }

  /**
   * Mints a fresh GitHub App Installation Token.
   * Token is transient — caller uses it immediately and discards it.
   *
   * @returns {Promise<string>} Installation token (never logged)
   */
  async #mintInstallationToken() {
    const { appId, installationId, privateKeyPem } = await this.#loadCredentials();

    // Step 1: Build and sign the App JWT (RS256, 10-minute expiry)
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
      // Do NOT include privateKeyPem or appId in error details
      throw new GitHubWriterError(
        `GitHub-App-JWT konnte nicht erstellt werden: ${sanitizeErrorMessage(err.message)}`,
        'jwt-sign-failed',
      );
    }

    // Step 2: Exchange JWT for an Installation Access Token
    const tokenUrl = `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
    let res;
    try {
      // Token only in Authorization header — never in URL, log, or argv
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
      throw new GitHubWriterError(
        `GitHub-API nicht erreichbar (Token-Minting): ${sanitizeErrorMessage(err.message)}`,
        'network-error',
      );
    }

    if (!res.ok) {
      // Consume body to release connection; do NOT log it (may contain sensitive info)
      try { await res.text(); } catch { /* ignore */ }
      throw new GitHubWriterError(
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
      throw new GitHubWriterError(
        'GitHub-API lieferte ungültige Antwort beim Token-Minting',
        'invalid-response',
      );
    }

    const token = data?.token;
    if (typeof token !== 'string' || !token) {
      throw new GitHubWriterError(
        'GitHub-API lieferte keinen Token in der Token-Minting-Antwort',
        'invalid-response',
      );
    }

    // appJwt and token are NOT logged — transient
    return token;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Creates a new repository in the configured Org.
   *
   * Mints a fresh Installation Token immediately before the GitHub call.
   * Token is discarded after the call (never returned, logged, or cached).
   *
   * @param {object} params
   * @param {string} params.name         - Repository name (required, validated)
   * @param {'private'|'public'} [params.visibility='private'] - Visibility
   * @param {string} [params.description] - Optional description
   * @param {boolean} [params.autoInit]   - Auto-initialize with README
   * @returns {Promise<{ name: string, fullName: string, htmlUrl: string, visibility: string }>}
   * @throws {GitHubWriterError}
   */
  async createRepo({ name, visibility = 'private', description, autoInit = false }) {
    // Validation is the caller's responsibility (Router validates before calling),
    // but we add a defensive check here for direct use.
    const nameVal = validateRepoName(name);
    if (!nameVal.ok) {
      throw new GitHubWriterError(nameVal.error, 'validation-error');
    }
    const visVal = validateVisibility(visibility);
    if (!visVal.ok) {
      throw new GitHubWriterError(visVal.error, 'validation-error');
    }

    // Mint token IMMEDIATELY before the call (AC3 — transient)
    const token = await this.#mintInstallationToken();

    const url = `${GITHUB_API}/orgs/${encodeURIComponent(ORG)}/repos`;

    const body = {
      name: name.trim(),
      visibility: visibility ?? 'private',
      private: (visibility ?? 'private') === 'private',
      auto_init: Boolean(autoInit),
    };
    if (description && typeof description === 'string' && description.trim()) {
      body.description = description.trim();
    }

    let res;
    try {
      res = await this.#fetch(
        url,
        {
          method: 'POST',
          headers: {
            // Token only in Authorization header — never in URL/log/audit/argv
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        FETCH_TIMEOUT_MS,
      );
    } catch (err) {
      throw new GitHubWriterError(
        `GitHub-API nicht erreichbar: ${sanitizeErrorMessage(err.message)}`,
        'network-error',
      );
    } finally {
      // Token is used and discarded; no reference retained
    }

    if (res.status === 201) {
      let data;
      try {
        data = await res.json();
      } catch {
        throw new GitHubWriterError(
          'GitHub-API lieferte ungültige Antwort beim Repo-Anlegen',
          'invalid-response',
          201,
        );
      }
      return {
        name: data.name,
        fullName: data.full_name,
        htmlUrl: data.html_url,
        visibility: data.visibility ?? (data.private ? 'private' : 'public'),
      };
    }

    // Error responses — read body for classification, but NEVER leak token or raw body to caller
    let errBody;
    try {
      errBody = await res.json();
    } catch {
      errBody = null;
    }

    if (res.status === 422) {
      // GitHub 422: name already taken or validation error
      const ghMessage = errBody?.message ?? '';
      const isNameTaken =
        ghMessage.toLowerCase().includes('already exist') ||
        ghMessage.toLowerCase().includes('name already');
      if (isNameTaken) {
        throw new GitHubWriterError(
          `Repository-Name '${name.trim()}' existiert bereits in der Org`,
          'name-conflict',
          422,
        );
      }
      throw new GitHubWriterError(
        `GitHub-Validierungsfehler beim Anlegen des Repositories: ${sanitizeGhMessage(ghMessage)}`,
        'validation-error',
        422,
      );
    }

    if (res.status === 403) {
      throw new GitHubWriterError(
        'GitHub-App hat keine Berechtigung zum Anlegen von Repositories. ' +
          'Die GitHub-App benötigt die Permission "Administration: Read & Write".',
        'permission-denied',
        403,
      );
    }

    if (res.status === 404) {
      throw new GitHubWriterError(
        `Org '${ORG}' nicht gefunden oder keine Zugriffsberechtigung`,
        'not-found',
        404,
      );
    }

    // Any other error → network/GitHub error → 502
    throw new GitHubWriterError(
      `GitHub-API-Fehler beim Anlegen des Repositories (HTTP ${res.status})`,
      'github-error',
      res.status,
    );
  }
}

// ── GitHubWriterError ─────────────────────────────────────────────────────────

/**
 * Typed error thrown by GitHubWriter.
 * `errorClass` enables the router to map to the right HTTP status without
 * inspecting raw error messages.
 *
 * Token and secrets MUST NOT appear in `message`.
 */
export class GitHubWriterError extends Error {
  /**
   * @param {string} message    - Human-readable message (NO secrets)
   * @param {string} errorClass - Machine-readable class (see Router for mapping)
   * @param {number} [githubStatus] - GitHub HTTP status that caused this (if applicable)
   */
  constructor(message, errorClass, githubStatus) {
    super(message);
    this.name = 'GitHubWriterError';
    this.errorClass = errorClass;
    this.githubStatus = githubStatus ?? null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strips anything that looks like a token or secret from an error message.
 * Defensive sanitization — error messages must not leak sensitive values.
 *
 * @param {string} msg
 * @returns {string}
 */
function sanitizeErrorMessage(msg) {
  if (typeof msg !== 'string') return 'unknown error';
  // Replace anything that looks like a bearer token or PEM content
  return msg
    .replace(/ghp_[A-Za-z0-9]{30,}/g, '[REDACTED]')
    .replace(/ghs_[A-Za-z0-9]{30,}/g, '[REDACTED]')
    .replace(/-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g, '[REDACTED-PEM]')
    .slice(0, 256); // cap length to prevent log flooding
}

/**
 * Returns a safe portion of a GitHub API error message.
 * GitHub errors may contain field names and values — keep them short.
 *
 * @param {string} msg
 * @returns {string}
 */
function sanitizeGhMessage(msg) {
  if (typeof msg !== 'string') return 'GitHub-Fehler';
  return msg.slice(0, 200);
}
