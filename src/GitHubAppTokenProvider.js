/**
 * GitHubAppTokenProvider — cached GitHub App Installation Token provider.
 *
 * Architecture boundary: the single place that caches a short-lived App
 * Installation Token and exposes it as a `getToken()` call for the read path
 * (GitHubReader).  Write paths (GitHubWriter, GitHubCloner, WorkspaceMutator)
 * continue to mint transient tokens directly via `mintInstallationToken` —
 * deliberately NOT through this cached provider (see [[github-repo-create]]
 * "transient-per-mutation" floor).
 *
 * Design:
 *   - In-memory cache with a conservative Safety-Margin (SAFE_TTL_MS = 50 min).
 *     Installation tokens are ~1 h valid; we treat them as stale 10 min before
 *     that to guard against clock-skew / propagation latency.
 *   - Single-Flight: concurrent `getToken()` calls while no valid token is
 *     cached share ONE in-flight Promise (no N-fold minting).  On failure the
 *     in-flight Promise is cleared so the next caller can retry.
 *   - Injected `mintFn` (default: `mintInstallationToken`) and `now`
 *     (default: `Date.now`) enable deterministic unit-testing of cache-hit,
 *     refresh, concurrency, and error paths without real network I/O.
 *
 * Security (Token-Floor, AC8):
 *   - The cached token lives exclusively in this boundary's private fields.
 *   - It is NEVER logged, returned in error messages, placed in URLs or argv.
 *   - Error messages and `.code` fields contain only field names / status
 *     codes — no secret values.
 *
 * @module GitHubAppTokenProvider
 */

import { mintInstallationToken } from './githubAppToken.js';

/**
 * Conservative TTL for the cached token (50 min in ms).
 *
 * GitHub App Installation Tokens are valid for ~60 min.  We treat them as
 * stale 10 min before real expiry to guard against clock-skew and network
 * latency during the next `getToken()` call.
 */
// Fixed TTL (not the API's `expires_at`): mintInstallationToken returns only the
// token string, never the `{ token, expires_at }` body — so a conservative fixed
// window is the only practical option (spec-conform: "~50 min" < real ~60 min TTL).
const SAFE_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * Cached App-Installation-Token provider.
 *
 * @example
 * const provider = new GitHubAppTokenProvider({ credentialStore });
 * const tokenProvider = () => provider.getToken();
 * const reader = new GitHubReader({ tokenProvider });
 */
export class GitHubAppTokenProvider {
  /** @type {import('./CredentialStore.js').CredentialStore} */
  #credentialStore;

  /** @type {(credentialStore: object) => Promise<string>} */
  #mintFn;

  /** @type {() => number} */
  #now;

  /** @type {string|null} — cached token string; null = no valid cache. */
  #cachedToken = null;

  /**
   * Absolute timestamp (ms, from `#now`) after which `#cachedToken` is stale.
   * Set to 0 when no token is cached.
   *
   * @type {number}
   */
  #expiresAt = 0;

  /**
   * In-flight mint Promise shared by concurrent `getToken()` callers.
   * Cleared (set to null) after the mint resolves OR rejects.
   *
   * @type {Promise<string>|null}
   */
  #inflight = null;

  /**
   * @param {object} opts
   * @param {import('./CredentialStore.js').CredentialStore} opts.credentialStore
   *   The credential store that holds `credentials/github/{app_id,installation_id,private_key}`.
   * @param {(credentialStore: object) => Promise<string>} [opts.mintFn]
   *   Injectable mint function (default: `mintInstallationToken`).
   *   For tests: inject a function that counts invocations and returns a mock token.
   * @param {() => number} [opts.now]
   *   Injectable clock returning current time in ms (default: `Date.now`).
   *   For tests: inject a controlled clock to advance time without real waiting.
   */
  constructor({ credentialStore, mintFn = mintInstallationToken, now = Date.now } = {}) {
    this.#credentialStore = credentialStore;
    this.#mintFn = mintFn;
    this.#now = now;
  }

  /**
   * Return a valid Installation Token, using the in-memory cache when possible.
   *
   * Behaviour:
   *   - Cache HIT (token cached and not within the Safety-Margin of expiry):
   *       returns the cached token immediately (no mint).
   *   - Cache MISS / token within Safety-Margin:
   *       if a mint is already in-flight → join the shared Promise (Single-Flight).
   *       otherwise → start a new mint, cache result, resolve all waiters.
   *       on mint failure → clear in-flight Promise, throw `GitHubAppTokenError`.
   *
   * @returns {Promise<string>} Valid Installation Token.
   * @throws {GitHubAppTokenError} When credentials are incomplete or minting fails.
   */
  async getToken() {
    // Cache HIT: token is cached and not within Safety-Margin of expiry.
    if (this.#cachedToken !== null && this.#now() < this.#expiresAt) {
      return this.#cachedToken;
    }

    // Cache MISS or stale — Single-Flight: join in-flight or start a new mint.
    if (this.#inflight !== null) {
      // Another caller is already minting — share the Promise.
      return this.#inflight;
    }

    // We are the first caller to notice the cache is stale/empty.
    // Create a new in-flight Promise and store it so concurrent callers share it.
    this.#inflight = this.#mint();
    try {
      const token = await this.#inflight;
      return token;
    } finally {
      // Always clear in-flight after resolve OR reject, so future callers can retry.
      this.#inflight = null;
    }
  }

  /**
   * Execute the actual mint, update the internal cache on success.
   *
   * @returns {Promise<string>}
   * @throws {GitHubAppTokenError}
   */
  async #mint() {
    // On failure, the exception propagates; #inflight is cleared by getToken()'s finally.
    const token = await this.#mintFn(this.#credentialStore);

    // Token is valid — cache it with a conservative TTL.
    // The token value itself lives ONLY in this private field — never logged.
    this.#cachedToken = token;
    this.#expiresAt = this.#now() + SAFE_TTL_MS;

    return token;
  }

  /**
   * Invalidate the cache (e.g. for testing or after a forced refresh).
   * Public for testing convenience; not required in production flows.
   *
   * @warn Must NOT be called while a mint is in-flight: resetting #inflight to
   *       null lets new callers start a second concurrent mint (already-waiting
   *       callers still receive the original promise's result correctly).
   */
  clearCache() {
    this.#cachedToken = null;
    this.#expiresAt = 0;
    this.#inflight = null;
  }
}
