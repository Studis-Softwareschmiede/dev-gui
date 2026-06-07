/**
 * githubAppToken — shared GitHub App Installation Token minting.
 *
 * Single canonical implementation consumed by:
 *   - GitHubWriter  (createRepo)
 *   - workspaceReposRouter / WorkspaceMutator  (git pull)
 *   - GitHubCloner  (git clone)
 *
 * Security (AC3 / NFR):
 *   - Token is returned as a plain string; it is the CALLER's responsibility
 *     to use it immediately and discard it (transient, not cached, not logged).
 *   - No secret value ever appears in thrown error messages.
 *   - writeAskpassScript() writes the token into the child environment via a
 *     randomly-named env var (never into argv or the script file itself).
 *
 * Typed errors:
 *   - All failures throw GitHubAppTokenError with a `.code` property.
 *   - Consumers branch on `err.code` (not on message strings) for robustness.
 *
 * @module githubAppToken
 */

import { SignJWT, importPKCS8 } from 'jose';
import { writeFile } from 'node:fs/promises';

/** GitHub API base URL. */
const GITHUB_API = 'https://api.github.com';

/** Fetch timeout for token minting (ms). */
const MINT_TIMEOUT_MS = 15000;

// ── GitHubAppTokenError ───────────────────────────────────────────────────────

/**
 * Typed error thrown by githubAppToken helpers.
 *
 * Consumers MUST branch on `.code` (not on message strings) so internal
 * wording changes never silently break error-handling logic.
 *
 * Codes:
 *   'credentials-incomplete' — one or more required CredentialStore fields missing
 *   'jwt-sign-failed'        — RS256 JWT could not be created (bad key material)
 *   'network-error'          — GitHub API unreachable (timeout / connection refused)
 *   'invalid-response'       — GitHub returned a non-parseable or token-less body
 *
 * Token and secrets MUST NOT appear in `message`.
 */
export class GitHubAppTokenError extends Error {
  /**
   * @param {string} message  Human-readable message (NO secrets)
   * @param {string} code     Machine-readable code (see above)
   */
  constructor(message, code) {
    super(message);
    this.name = 'GitHubAppTokenError';
    this.code = code;
  }
}

/**
 * Mint a fresh GitHub App Installation Token from the CredentialStore.
 *
 * Steps:
 *   1. Load app_id / installation_id / private_key from CredentialStore schema `github`.
 *   2. Build an RS256 JWT (App JWT) signed with the private key.
 *   3. POST /app/installations/{id}/access_tokens → receive {token}.
 *   4. Return token string.
 *
 * The returned token must be used immediately and discarded. It is NEVER logged,
 * stored, passed in URLs, or placed in argv.
 *
 * @param {import('./CredentialStore.js').CredentialStore} credentialStore
 * @param {{ fetchFn?: typeof fetch }} [opts]
 *   Optional injectable fetch (for tests).
 * @returns {Promise<string>}  Installation token (transient, caller discards)
 * @throws {Error} if credentials are missing or token minting fails;
 *                 message contains NO secret values.
 */
export async function mintInstallationToken(credentialStore, { fetchFn = fetch } = {}) {
  if (!credentialStore) {
    throw new GitHubAppTokenError(
      'CredentialStore nicht konfiguriert — GitHub-App-Credentials nicht verfügbar',
      'credentials-incomplete',
    );
  }

  const [appId, installationId, privateKeyPem] = await Promise.all([
    credentialStore.getPlaintext('credentials/github/app_id'),
    credentialStore.getPlaintext('credentials/github/installation_id'),
    credentialStore.getPlaintext('credentials/github/private_key'),
  ]);

  const missing = [];
  if (!appId) missing.push('github/app_id');
  if (!installationId) missing.push('github/installation_id');
  if (!privateKeyPem) missing.push('github/private_key');

  if (missing.length > 0) {
    // Do NOT include values — only field names
    throw new GitHubAppTokenError(
      `GitHub-App-Credentials unvollständig: ${missing.join(', ')} fehlen im CredentialStore`,
      'credentials-incomplete',
    );
  }

  // Build App JWT (RS256, 10-minute expiry)
  let appJwt;
  try {
    const privateKey = await importPKCS8(privateKeyPem, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    appJwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)       // 60 s clock-skew buffer
      .setExpirationTime(now + 600) // 10 minutes
      .setIssuer(String(appId))
      .sign(privateKey);
  } catch {
    // Do NOT log privateKeyPem or appJwt
    throw new GitHubAppTokenError(
      'GitHub-App-JWT konnte nicht erstellt werden',
      'jwt-sign-failed',
    );
  }

  // Exchange JWT for Installation Access Token
  const tokenUrl = `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
    try {
      res = await fetchFn(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new GitHubAppTokenError(
      'GitHub-API nicht erreichbar (Token-Minting)',
      'network-error',
    );
  }

  if (!res.ok) {
    try { await res.text(); } catch { /* ignore */ }
    throw new GitHubAppTokenError(
      `GitHub-App-Authentication fehlgeschlagen (HTTP ${res.status}) beim Token-Minting`,
      'network-error',
    );
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new GitHubAppTokenError(
      'GitHub-API lieferte ungültige Antwort beim Token-Minting',
      'invalid-response',
    );
  }

  const token = data?.token;
  if (typeof token !== 'string' || !token) {
    throw new GitHubAppTokenError(
      'GitHub-API lieferte keinen Token in der Token-Minting-Antwort',
      'invalid-response',
    );
  }

  // appJwt and token are transient — caller uses immediately and discards
  return token;
}

/**
 * Write a GIT_ASKPASS helper script to `scriptPath`.
 *
 * The script reads the GitHub token from the env var named `envVarName`
 * (passed via a randomly-named env var, never argv or the script file).
 *
 * Correct pattern (matches GitHubCloner convention):
 *
 *   #!/bin/sh
 *   case "$1" in
 *     *Username*) echo x-access-token ;;
 *     *) printenv ENVVAR ;;
 *   esac
 *
 * Git calls this script twice:
 *   - Once with "Username for …" → we return the credential user (x-access-token)
 *   - Once with "Password for …" → we return the token via printenv (no substitution risk)
 *
 * @param {string} scriptPath     Absolute path to write the script.
 * @param {string} envVarName     Name of the env var that holds the token.
 * @param {(path: string, content: string, opts: object) => Promise<void>} [writeFileFn]
 *   Injectable for tests (default: node:fs/promises writeFile).
 * @returns {Promise<void>}
 */
export async function writeAskpassScript(scriptPath, envVarName, writeFileFn = writeFile) {
  const content = [
    '#!/bin/sh',
    'case "$1" in',
    '  *Username*) echo x-access-token ;;',
    `  *) printenv ${envVarName} ;;`,
    'esac',
    '',
  ].join('\n');
  await writeFileFn(scriptPath, content, { mode: 0o700 });
}

/**
 * Build a minimal git child environment (allowlist only).
 *
 * Only the env vars required for git to function are forwarded;
 * no sensitive process.env variables bleed into the child process.
 *
 * Allowlist: HOME, PATH, USER, LANG, TMP, TMPDIR + GIT_ASKPASS,
 *            GIT_TERMINAL_PROMPT, and the randomly-named token var.
 *
 * USER / LANG / TMP / TMPDIR are intentionally included: they are non-sensitive
 * (locale + temp-dir configuration) and git relies on them for correct behaviour
 * on some platforms. This is the canonical, deliberately unified allowlist —
 * not an accidental leak of process environment.
 *
 * @param {object} extra  Additional env vars to include (e.g. GIT_ASKPASS, token var).
 * @returns {object}  Minimal child environment object.
 */
export function minimalGitEnv(extra = {}) {
  const allowed = ['HOME', 'PATH', 'USER', 'LANG', 'TMP', 'TMPDIR'];
  const base = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) {
      base[key] = process.env[key];
    }
  }
  return { ...base, ...extra };
}
