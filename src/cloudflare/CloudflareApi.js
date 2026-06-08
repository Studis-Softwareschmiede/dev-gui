/**
 * CloudflareApi — einziger Ort, der die Cloudflare-API via fetch anspricht (ADR-010).
 *
 * Architecture boundary: the ONLY place that fetches api.cloudflare.com.
 * No other module may import from api.cloudflare.com or use cfd_tunnel/dns_records
 * endpoints (grep-verifiable per ADR-010 constraint).
 *
 * Design (analog GitHubReader + VpsProviderRegistry):
 *   - Token + Account-Id store-intern per call from CredentialStore
 *     (credentials/cloudflare/api_token, credentials/cloudflare/account_id).
 *   - Token goes in Authorization: Bearer header ONLY — never URL, log, response,
 *     audit, argv, or any external channel (security/R01).
 *   - Per-request AbortController timeout (js/R03).
 *   - Read-aggregation live + per-zone degrading (ADR-005-line, ADR-010).
 *   - Not configured (no token) → no API call, returns cloudflare-not-configured.
 *   - Zone-Id resolved live from listZones(), not stored as credential.
 *
 * Read-methods (this item, AC4/AC8):
 *   listZones()              → { configured, zones: CfZone[], errors? }
 *   listTunnels(accountId)   → CfTunnel[]  (per-account, zone from parent call)
 *   listRoutes(tunnelId)     → CfRoute[]   (via tunnel configurations endpoint)
 *
 * Mutate-methods (stub placeholders — implemented in #108):
 *   mutate* methods are wired to LockoutGuard.isProtected() BEFORE any API call.
 *
 * @module cloudflare/CloudflareApi
 */

import { normalizeZone, normalizeTunnel, normalizeRoute } from './normalize.js';
import { LockoutGuard } from './LockoutGuard.js';

/** Cloudflare API base URL */
const CF_BASE = 'https://api.cloudflare.com/client/v4';

/** CredentialStore keys for Cloudflare credentials */
const TOKEN_KEY = 'credentials/cloudflare/api_token';
const ACCOUNT_ID_KEY = 'credentials/cloudflare/account_id';

/** Per-request fetch timeout in ms (ADR-010) */
const FETCH_TIMEOUT_MS = 10000;

/** Safety cap: maximum pages to fetch in a pagination loop (prevents infinite loops) */
const PAGINATION_MAX_PAGES = 20;

// ── CloudflareApi ─────────────────────────────────────────────────────────────

export class CloudflareApi {
  /** @type {import('../CredentialStore.js').CredentialStore|null} */
  #credentialStore;

  /** @type {LockoutGuard} */
  #lockoutGuard;

  /** @type {typeof fetch} Injectable fetch implementation */
  #fetch;

  /**
   * @param {object} [options]
   * @param {import('../CredentialStore.js').CredentialStore} [options.credentialStore]
   *   CredentialStore instance. Required for production; may be null in tests
   *   where credentials are injected differently.
   * @param {LockoutGuard} [options.lockoutGuard]
   *   Injectable LockoutGuard (defaults to new LockoutGuard()).
   * @param {typeof fetch} [options.fetchFn]
   *   Injectable fetch implementation (default: global fetch with timeout).
   * @param {number} [options.timeoutMs]
   *   Per-request timeout in ms (default: FETCH_TIMEOUT_MS).
   */
  constructor({ credentialStore, lockoutGuard, fetchFn, timeoutMs } = {}) {
    this.#credentialStore = credentialStore ?? null;
    this.#lockoutGuard = lockoutGuard ?? new LockoutGuard();
    const timeout = timeoutMs ?? FETCH_TIMEOUT_MS;
    this.#fetch = fetchFn ?? ((url, init) => fetchWithTimeout(url, init, timeout));
  }

  // ── Public read API ──────────────────────────────────────────────────────────

  /**
   * List all zones/domains accessible to the configured account.
   *
   * Returns { configured: false } without making any API call when
   * token or account-id is not configured (AC3, cloudflare-not-configured).
   *
   * Per-zone degradation: if individual zones fail (shouldn't happen at this
   * level since listZones is a single API call), the error is captured in errors[].
   *
   * @returns {Promise<{
   *   configured: boolean,
   *   zones: import('./normalize.js').CfZone[],
   *   errors?: Array<{ scope: string, errorClass: string }>
   * }>}
   */
  async listZones() {
    const creds = await this.#resolveCredentials();
    if (!creds) {
      return { configured: false, zones: [] };
    }

    const { token } = creds;

    try {
      const allZones = [];
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages && page <= PAGINATION_MAX_PAGES) {
        const data = await this.#apiGet(
          `${CF_BASE}/zones?per_page=50&status=active&page=${page}`,
          token,
        );
        const rawZones = Array.isArray(data?.result) ? data.result : [];
        allZones.push(...rawZones.map((z) => normalizeZone(z)));

        // Update totalPages from result_info (Cloudflare standard pagination)
        const resultInfo = data?.result_info;
        if (resultInfo && typeof resultInfo.total_pages === 'number') {
          totalPages = resultInfo.total_pages;
        }
        page += 1;
      }

      return { configured: true, zones: allZones };
    } catch (err) {
      const errorClass = classifyApiError(err);
      return {
        configured: true,
        zones: [],
        errors: [{ scope: 'zones', errorClass }],
      };
    }
  }

  /**
   * List all tunnels for an account, annotated with the resolved zone ID.
   *
   * Cloudflare tunnels are account-scoped, not zone-scoped. We list all tunnels
   * for the account and annotate each with the provided zoneId.
   *
   * This is the per-zone degrading read path: if the tunnel call fails, the
   * caller captures the error in errors[] without breaking the overall response.
   *
   * @param {string} zoneId - Zone ID to annotate returned tunnels with
   * @returns {Promise<import('./normalize.js').CfTunnel[]>}
   * @throws {CloudflareApiError} on auth failure, network error, etc.
   */
  async listTunnels(zoneId) {
    const creds = await this.#resolveCredentials();
    if (!creds) {
      const err = new CloudflareApiError(
        'Cloudflare not configured (no token/account-id)',
        'cloudflare-not-configured',
        422,
      );
      throw err;
    }

    const { token, accountId } = creds;
    const allTunnels = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && page <= PAGINATION_MAX_PAGES) {
      const data = await this.#apiGet(
        `${CF_BASE}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?per_page=50&is_deleted=false&page=${page}`,
        token,
      );

      const rawTunnels = Array.isArray(data?.result) ? data.result : [];
      allTunnels.push(...rawTunnels.map((t) => normalizeTunnel(t, zoneId)));

      // Update totalPages from result_info (Cloudflare standard pagination)
      const resultInfo = data?.result_info;
      if (resultInfo && typeof resultInfo.total_pages === 'number') {
        totalPages = resultInfo.total_pages;
      }
      page += 1;
    }

    return allTunnels;
  }

  /**
   * List all Public Hostname routes for a given tunnel.
   *
   * Fetches the tunnel's ingress configuration and maps each ingress rule
   * (excluding the catch-all entry with no hostname) to a CfRoute.
   * The protected flag is set via LockoutGuard.isProtected().
   *
   * @param {string} tunnelId - Tunnel ID to fetch routes for
   * @returns {Promise<import('./normalize.js').CfRoute[]>}
   * @throws {CloudflareApiError}
   */
  async listRoutes(tunnelId) {
    const creds = await this.#resolveCredentials();
    if (!creds) {
      const err = new CloudflareApiError(
        'Cloudflare not configured (no token/account-id)',
        'cloudflare-not-configured',
        422,
      );
      throw err;
    }

    const { token, accountId } = creds;
    const data = await this.#apiGet(
      `${CF_BASE}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      token,
    );

    const ingress = data?.result?.config?.ingress;
    if (!Array.isArray(ingress)) {
      return [];
    }

    // Filter out the catch-all entry (no hostname) — it's the default fallback rule
    const routes = ingress
      .filter((rule) => typeof rule?.hostname === 'string' && rule.hostname !== '')
      .map((rule) => {
        const isProtected = this.#lockoutGuard.isProtected(rule.hostname);
        return normalizeRoute(rule, tunnelId, isProtected);
      });

    return routes;
  }

  // ── Mutate methods (ADR-010/011, #108) ──────────────────────────────────────

  /**
   * Check if a target hostname is protected before any mutation.
   * Exposed for use by HTTP handlers (DELETE route/tunnel pre-flight check).
   *
   * @param {string} target
   * @returns {boolean}
   */
  isProtected(target) {
    return this.#lockoutGuard.isProtected(target);
  }

  /**
   * Remove a Public Hostname route from a tunnel's ingress configuration.
   *
   * ADR-011 canonical order (HARD, enforced here):
   *   1. LockoutGuard.isProtected(hostname) → 422 protected-resource if true
   *   2. Caller MUST have already validated confirm === hostname (confirmed at router layer)
   *   3. Mutation: PUT updated ingress config without the removed hostname
   *
   * The caller (cloudflareRouter) is responsible for confirm-match and CRED_ADMIN_EMAILS
   * role checks BEFORE calling this method. Audit-First must also be done by the caller.
   *
   * @param {string} tunnelId
   * @param {string} hostname - The hostname to remove
   * @returns {Promise<{ result: "ok"|"error", reason?: string }>}
   * @throws {CloudflareApiError} on protected resource, auth failure, network error
   */
  async removeRoute(tunnelId, hostname) {
    // ADR-011: LockoutGuard FIRST — before any mutation
    if (this.#lockoutGuard.isProtected(hostname)) {
      throw new CloudflareApiError(
        `Hostname "${hostname}" is protected and cannot be mutated`,
        'protected-resource',
        422,
      );
    }

    const creds = await this.#resolveCredentials();
    if (!creds) {
      throw new CloudflareApiError(
        'Cloudflare not configured (no token/account-id)',
        'cloudflare-not-configured',
        422,
      );
    }

    const { token, accountId } = creds;

    // Fetch current tunnel configuration
    const configData = await this.#apiGet(
      `${CF_BASE}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      token,
    );

    const ingress = configData?.result?.config?.ingress;
    if (!Array.isArray(ingress)) {
      throw new CloudflareApiError(
        'Tunnel configuration ingress not found',
        'not-found',
        404,
      );
    }

    // Remove the route with matching hostname (keep catch-all and all others)
    const updatedIngress = ingress.filter(
      (rule) => rule?.hostname !== hostname,
    );

    if (updatedIngress.length === ingress.length) {
      throw new CloudflareApiError(
        `Route for hostname "${hostname}" not found in tunnel`,
        'not-found',
        404,
      );
    }

    // PUT updated configuration
    await this.#apiPut(
      `${CF_BASE}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      token,
      { config: { ingress: updatedIngress } },
    );

    return { result: 'ok' };
  }

  /**
   * Delete an entire Cloudflare tunnel (cfd_tunnel DELETE).
   *
   * ADR-011 canonical order (HARD, enforced here):
   *   1. LockoutGuard: if any route in the tunnel is protected → 422 protected-resource
   *   2. Caller MUST have already validated confirm and CRED_ADMIN_EMAILS role
   *   3. Mutation: DELETE the tunnel via the Cloudflare API
   *
   * Protected check uses the tunnelName (or a representative hostname). Since a tunnel
   * can have multiple routes, we check the tunnelId/tunnelName itself against LockoutGuard
   * and rely on the router having listed routes to check for protected hostnames.
   *
   * @param {string} tunnelId
   * @param {string} tunnelNameOrHostname - Used for LockoutGuard check (name of tunnel or representative hostname)
   * @returns {Promise<{ result: "ok"|"error", reason?: string }>}
   * @throws {CloudflareApiError}
   */
  async deleteTunnel(tunnelId, tunnelNameOrHostname) {
    // ADR-011: LockoutGuard FIRST
    if (this.#lockoutGuard.isProtected(tunnelNameOrHostname)) {
      throw new CloudflareApiError(
        `Tunnel "${tunnelNameOrHostname}" is protected and cannot be deleted`,
        'protected-resource',
        422,
      );
    }

    const creds = await this.#resolveCredentials();
    if (!creds) {
      throw new CloudflareApiError(
        'Cloudflare not configured (no token/account-id)',
        'cloudflare-not-configured',
        422,
      );
    }

    const { token, accountId } = creds;

    await this.#apiDelete(
      `${CF_BASE}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
      token,
    );

    return { result: 'ok' };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Resolve Cloudflare credentials from CredentialStore.
   * Returns null if token or account-id is not set (not configured).
   * Credentials are NEVER cached beyond the request (ADR-010).
   *
   * @returns {Promise<{ token: string, accountId: string }|null>}
   */
  async #resolveCredentials() {
    if (!this.#credentialStore) return null;

    try {
      const [token, accountId] = await Promise.all([
        this.#credentialStore.getPlaintext(TOKEN_KEY),
        this.#credentialStore.getPlaintext(ACCOUNT_ID_KEY),
      ]);

      if (!token || !accountId) return null;
      return { token, accountId };
    } catch {
      return null;
    }
  }

  /**
   * Execute a GET request against the Cloudflare API.
   * Token goes in Authorization: Bearer header — never in URL/log/response.
   *
   * @param {string} url
   * @param {string} token - Bearer token (NEVER logged)
   * @returns {Promise<object>} Parsed JSON response body
   * @throws {CloudflareApiError}
   */
  async #apiGet(url, token) {
    let res;
    try {
      res = await this.#fetch(url, {
        headers: buildHeaders(token),
      });
    } catch (err) {
      // Network / timeout error
      if (err?.name === 'AbortError' || err?.message === 'timeout') {
        throw new CloudflareApiError(
          'Cloudflare API request timed out',
          'cloudflare-unavailable',
          503,
        );
      }
      throw new CloudflareApiError(
        'Cloudflare API unreachable',
        'cloudflare-unavailable',
        503,
      );
    }

    if (res.status === 401 || res.status === 403) {
      // Auth failure — never include token in error message
      throw new CloudflareApiError(
        'Cloudflare authentication failed (check token/account-id)',
        'cloudflare-auth-failed',
        502,
      );
    }

    if (res.status === 404) {
      throw new CloudflareApiError(
        'Cloudflare resource not found',
        'not-found',
        404,
      );
    }

    if (res.status === 429) {
      throw new CloudflareApiError(
        'Cloudflare API rate limit exceeded',
        'cloudflare-unavailable',
        503,
      );
    }

    if (!res.ok) {
      throw new CloudflareApiError(
        `Cloudflare API error (HTTP ${res.status})`,
        'cloudflare-unavailable',
        502,
      );
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new CloudflareApiError(
        'Cloudflare API returned invalid JSON',
        'cloudflare-unavailable',
        502,
      );
    }

    // Cloudflare wraps all responses in { success, result, errors }
    if (body?.success === false) {
      const firstError = Array.isArray(body.errors) ? body.errors[0] : null;
      const code = firstError?.code;
      // Auth error codes from Cloudflare API
      if (code === 10000 || code === 9109) {
        throw new CloudflareApiError(
          'Cloudflare authentication failed',
          'cloudflare-auth-failed',
          502,
        );
      }
      throw new CloudflareApiError(
        'Cloudflare API returned an error',
        'cloudflare-unavailable',
        502,
      );
    }

    return body;
  }
  /**
   * Execute a PUT request against the Cloudflare API.
   * Token goes in Authorization: Bearer header — never in URL/log/response.
   *
   * @param {string} url
   * @param {string} token - Bearer token (NEVER logged)
   * @param {object} body - Request body (will be JSON-serialized)
   * @returns {Promise<object>} Parsed JSON response body
   * @throws {CloudflareApiError}
   */
  async #apiPut(url, token, body) {
    let res;
    try {
      res = await this.#fetch(url, {
        method: 'PUT',
        headers: buildHeaders(token),
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.message === 'timeout') {
        throw new CloudflareApiError(
          'Cloudflare API request timed out',
          'cloudflare-unavailable',
          503,
        );
      }
      throw new CloudflareApiError(
        'Cloudflare API unreachable',
        'cloudflare-unavailable',
        503,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new CloudflareApiError(
        'Cloudflare authentication failed (check token/account-id)',
        'cloudflare-auth-failed',
        502,
      );
    }

    if (!res.ok) {
      throw new CloudflareApiError(
        `Cloudflare API error (HTTP ${res.status})`,
        'cloudflare-unavailable',
        502,
      );
    }

    let responseBody;
    try {
      responseBody = await res.json();
    } catch {
      // Some PUT responses may have empty bodies — treat as success
      return {};
    }

    if (responseBody?.success === false) {
      const firstError = Array.isArray(responseBody.errors) ? responseBody.errors[0] : null;
      const code = firstError?.code;
      if (code === 10000 || code === 9109) {
        throw new CloudflareApiError(
          'Cloudflare authentication failed',
          'cloudflare-auth-failed',
          502,
        );
      }
      throw new CloudflareApiError(
        'Cloudflare API returned an error',
        'cloudflare-unavailable',
        502,
      );
    }

    return responseBody;
  }

  /**
   * Execute a DELETE request against the Cloudflare API.
   * Token goes in Authorization: Bearer header — never in URL/log/response.
   *
   * @param {string} url
   * @param {string} token - Bearer token (NEVER logged)
   * @returns {Promise<object>} Parsed JSON response body (may be empty)
   * @throws {CloudflareApiError}
   */
  async #apiDelete(url, token) {
    let res;
    try {
      res = await this.#fetch(url, {
        method: 'DELETE',
        headers: buildHeaders(token),
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.message === 'timeout') {
        throw new CloudflareApiError(
          'Cloudflare API request timed out',
          'cloudflare-unavailable',
          503,
        );
      }
      throw new CloudflareApiError(
        'Cloudflare API unreachable',
        'cloudflare-unavailable',
        503,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new CloudflareApiError(
        'Cloudflare authentication failed (check token/account-id)',
        'cloudflare-auth-failed',
        502,
      );
    }

    if (res.status === 404) {
      throw new CloudflareApiError(
        'Cloudflare resource not found',
        'not-found',
        404,
      );
    }

    if (!res.ok) {
      throw new CloudflareApiError(
        `Cloudflare API error (HTTP ${res.status})`,
        'cloudflare-unavailable',
        502,
      );
    }

    try {
      return await res.json();
    } catch {
      // DELETE responses may have empty bodies
      return {};
    }
  }
}

// ── CloudflareApiError ────────────────────────────────────────────────────────

/**
 * Typed error thrown by CloudflareApi.
 * Message MUST NOT contain tokens or secrets.
 */
export class CloudflareApiError extends Error {
  /**
   * @param {string} message      - Human-readable (NO secrets)
   * @param {string} errorClass   - Machine-readable classification (ADR-010 canonical values)
   * @param {number} [httpStatus] - Suggested HTTP status for router
   */
  constructor(message, errorClass, httpStatus) {
    super(message);
    this.name = 'CloudflareApiError';
    this.errorClass = errorClass;
    this.httpStatus = httpStatus ?? 500;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build Cloudflare API request headers.
 * Token goes in Authorization: Bearer ONLY — never in URL or logged.
 *
 * @param {string} token
 * @returns {Record<string, string>}
 */
function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Fetch with AbortController timeout (js/R03).
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify an API error for the errors[] array.
 * Tokens/secrets MUST NOT appear in the classification.
 *
 * @param {Error} err
 * @returns {string} errorClass
 */
function classifyApiError(err) {
  if (!err) return 'cloudflare-unavailable';

  const cls = err.errorClass;
  if (cls) return cls;

  const msg = String(err.message ?? '').toLowerCase();
  if (msg.includes('auth') || msg.includes('401') || msg.includes('403')) {
    return 'cloudflare-auth-failed';
  }
  if (msg.includes('not found') || msg.includes('404')) {
    return 'not-found';
  }
  if (
    msg.includes('timeout') ||
    msg.includes('unavailable') ||
    msg.includes('rate limit') ||
    msg.includes('econnrefused')
  ) {
    return 'cloudflare-unavailable';
  }
  return 'cloudflare-unavailable';
}
