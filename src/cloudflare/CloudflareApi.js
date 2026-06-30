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

  // ── Zone resolution ─────────────────────────────────────────────────────────

  /**
   * Resolve the Cloudflare Zone ID for a given hostname by longest-suffix match.
   *
   * Algorithm: list all accessible zones, find the zone whose name is the longest
   * suffix of the hostname (e.g. "app.example.com" → zone "example.com").
   * Returns null if no zone matches (caller should surface a 400/422 zone-not-found).
   *
   * The zone ID is never cached (ADR-010 — per-request credential resolution).
   * No zone-name or zone-id is leaked into error messages (security/R01).
   *
   * @param {string} hostname - Full hostname (e.g. "app.example.com")
   * @returns {Promise<string|null>} The matching zone ID, or null if no zone matches.
   * @throws {CloudflareApiError} on auth failure or Cloudflare API error.
   */
  async resolveZoneForHostname(hostname) {
    const { zones } = await this.listZones();

    // Find the zone whose name is the longest suffix of the hostname
    let bestZone = null;
    let bestLen = 0;

    for (const zone of zones) {
      const zoneName = zone.name ?? '';
      // Accept exact match or suffix match (.zoneName)
      const isSuffix = hostname === zoneName || hostname.endsWith(`.${zoneName}`);
      if (isSuffix && zoneName.length > bestLen) {
        bestZone = zone;
        bestLen = zoneName.length;
      }
    }

    return bestZone ? bestZone.id : null;
  }

  // ── Mutate API (ADR-010/011, #108/#110) ─────────────────────────────────────

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
   * Add (or update) a single Public-Hostname route to a tunnel's ingress config.
   * Uses PUT .../configurations — the full ingress list is replaced, so we:
   *   1. Fetch existing ingress rules
   *   2. Remove any existing rule for this hostname
   *   3. Prepend the new rule
   *   4. PUT the updated list back
   *
   * LockoutGuard is checked BEFORE any API call (ADR-011).
   *
   * @param {string} tunnelId
   * @param {string} hostname  - e.g. "app.example.com"
   * @param {string} service   - e.g. "http://localhost:8080"
   * @returns {Promise<void>}
   * @throws {CloudflareApiError}
   */
  async addRoute(tunnelId, hostname, service) {
    if (this.#lockoutGuard.isProtected(hostname)) {
      throw new CloudflareApiError(
        `Target "${hostname}" is protected — mutation not allowed (ADR-011)`,
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
    const configUrl = `${CF_BASE}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`;

    // 1. Fetch current ingress rules
    const current = await this.#apiGet(configUrl, token);
    const existingIngress = Array.isArray(current?.result?.config?.ingress)
      ? current.result.config.ingress
      : [];

    // 2. Remove existing rule for this hostname (idempotent replace)
    const filtered = existingIngress.filter(
      (r) => typeof r.hostname === 'string' && r.hostname !== hostname,
    );

    // 3. Prepend the new rule (before the catch-all)
    const newRule = { hostname, service };
    // Preserve the catch-all (hostname === '') at the end
    const catchAll = filtered.find((r) => !r.hostname || r.hostname === '');
    const named = filtered.filter((r) => r.hostname && r.hostname !== '');
    const newIngress = [newRule, ...named, ...(catchAll ? [catchAll] : [{ service: 'http_status:404' }])];

    // 4. PUT the updated configuration
    await this.#apiPut(configUrl, token, { config: { ingress: newIngress } });
  }

  /**
   * Remove a single Public-Hostname route from a tunnel's ingress config.
   * Uses PUT .../configurations to replace the full ingress list.
   *
   * LockoutGuard is checked BEFORE any API call (ADR-011).
   *
   * @param {string} tunnelId
   * @param {string} hostname - hostname to remove
   * @returns {Promise<void>}
   * @throws {CloudflareApiError}
   */
  async removeRoute(tunnelId, hostname) {
    if (this.#lockoutGuard.isProtected(hostname)) {
      throw new CloudflareApiError(
        `Target "${hostname}" is protected — mutation not allowed (ADR-011)`,
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
    const configUrl = `${CF_BASE}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`;

    // Fetch current ingress rules
    const current = await this.#apiGet(configUrl, token);
    const existingIngress = Array.isArray(current?.result?.config?.ingress)
      ? current.result.config.ingress
      : [];

    // Remove the named rule; keep everything else including catch-all
    const newIngress = existingIngress.filter(
      (r) => !(typeof r.hostname === 'string' && r.hostname === hostname),
    );

    // Ensure there is always a catch-all entry
    const hasCatchAll = newIngress.some((r) => !r.hostname || r.hostname === '');
    if (!hasCatchAll) {
      newIngress.push({ service: 'http_status:404' });
    }

    await this.#apiPut(configUrl, token, { config: { ingress: newIngress } });
    return { result: 'ok' };
  }

  /**
   * Create a DNS CNAME record pointing hostname → <tunnelId>.cfargotunnel.com.
   *
   * LockoutGuard is checked BEFORE any API call.
   *
   * @param {string} zoneId
   * @param {string} hostname  - full hostname (e.g. "app.example.com")
   * @param {string} tunnelId  - Cloudflare tunnel ID (CNAME target base)
   * @returns {Promise<void>}
   * @throws {CloudflareApiError}
   */
  async createDnsRecord(zoneId, hostname, tunnelId) {
    if (this.#lockoutGuard.isProtected(hostname)) {
      throw new CloudflareApiError(
        `Target "${hostname}" is protected — mutation not allowed (ADR-011)`,
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

    const { token } = creds;
    const body = {
      type: 'CNAME',
      name: hostname,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    };

    // Idempotenz (Re-Deploy-fest): einen bereits existierenden CNAME für den Hostnamen
    // NICHT als Duplikat-Fehler behandeln. Cloudflare lehnt ein zweites POST mit gleichem
    // name sonst mit HTTP 400 ab — das blockierte Re-Deploys und Hostnamen mit Alt-Eintrag
    // (z.B. aus einem früheren Tunnel). Vorhanden → ersten Record per PUT aktualisieren
    // (biegt ihn ggf. auf den neuen Tunnel um); etwaige Duplikate löschen. Keiner → neu anlegen.
    const listUrl = `${CF_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(hostname)}&type=CNAME`;
    const listData = await this.#apiGet(listUrl, token);
    const existing = Array.isArray(listData?.result) ? listData.result : [];

    if (existing.length > 0) {
      const [first, ...dupes] = existing;
      await this.#apiPut(
        `${CF_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(first.id)}`,
        token,
        body,
      );
      // Hygiene: idempotenter Endzustand = genau ein Record je Hostname
      for (const dupe of dupes) {
        if (dupe?.id) {
          await this.#apiDelete(
            `${CF_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(dupe.id)}`,
            token,
          );
        }
      }
      return;
    }

    const url = `${CF_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records`;
    await this.#apiPost(url, token, body);
  }

  /**
   * Delete a DNS record by hostname within a zone.
   * Looks up the record ID first, then deletes it.
   *
   * LockoutGuard is checked BEFORE any API call.
   *
   * @param {string} zoneId
   * @param {string} hostname
   * @returns {Promise<void>}
   * @throws {CloudflareApiError}
   */
  async deleteDnsRecord(zoneId, hostname) {
    if (this.#lockoutGuard.isProtected(hostname)) {
      throw new CloudflareApiError(
        `Target "${hostname}" is protected — mutation not allowed (ADR-011)`,
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

    const { token } = creds;

    // Look up the record ID by name
    const listUrl = `${CF_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(hostname)}&type=CNAME`;
    const listData = await this.#apiGet(listUrl, token);
    const records = Array.isArray(listData?.result) ? listData.result : [];

    // Delete all matching records (idempotent)
    for (const record of records) {
      if (record?.id) {
        await this.#apiDelete(
          `${CF_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
          token,
        );
      }
    }
  }

  /**
   * Create a new remote-managed Cloudflare Tunnel and return its ID + connector token.
   *
   * Calls POST /accounts/{accountId}/cfd_tunnel with config_src:"cloudflare" (remote-managed).
   * The returned token is the cloudflared connector token — treat as a secret:
   *   - NEVER log the token (AC2, security/R01)
   *   - NEVER include it in error messages
   *   - Pass to caller; caller persists it in CredentialStore (not this method's responsibility)
   *
   * Not configured (no token/account-id) → throws CloudflareApiError('cloudflare-not-configured', 422)
   * without making any API call (AC1).
   *
   * @param {string} name - Tunnel name (e.g. "<sanitized-vpsname>" = Servername)
   * @returns {Promise<{ tunnelId: string, token: string }>}
   * @throws {CloudflareApiError}
   */
  async createTunnel(name) {
    const creds = await this.#resolveCredentials();
    if (!creds) {
      throw new CloudflareApiError(
        'Cloudflare not configured (no token/account-id)',
        'cloudflare-not-configured',
        422,
      );
    }

    const { token, accountId } = creds;
    const url = `${CF_BASE}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`;

    // AC2: token NEVER in request body, error messages, or logs.
    // token goes only in Authorization: Bearer header (handled by #apiPost / buildHeaders).
    const response = await this.#apiPost(url, token, {
      name,
      config_src: 'cloudflare', // remote-managed (not local credentials file)
    });

    const result = response?.result;
    const tunnelId = result?.id;
    const tunnelToken = result?.token;

    // Validate that both fields are present and are non-empty strings
    if (typeof tunnelId !== 'string' || !tunnelId || typeof tunnelToken !== 'string' || !tunnelToken) {
      throw new CloudflareApiError(
        'Cloudflare API returned an invalid tunnel response (missing id or token)',
        'invalid-response',
        502,
      );
    }

    // AC2: return token to caller — caller is responsible for secure storage.
    // Do NOT log tunnelToken here or anywhere in this path.
    return { tunnelId, token: tunnelToken };
  }

  /**
   * Delete a Cloudflare tunnel by ID.
   *
   * LockoutGuard check is done by the router caller (ADR-011) before invoking this method.
   *
   * @param {string} tunnelId
   * @returns {Promise<void>}
   * @throws {CloudflareApiError}
   */
  async deleteTunnel(tunnelId) {
    const creds = await this.#resolveCredentials();
    if (!creds) {
      throw new CloudflareApiError(
        'Cloudflare not configured (no token/account-id)',
        'cloudflare-not-configured',
        422,
      );
    }

    const { token, accountId } = creds;
    const tunnelUrl = `${CF_BASE}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`;
    const connectionsUrl = `${tunnelUrl}/connections`;

    // AC3a (vps-delete): Aktive cloudflared-Connections VOR dem Tunnel-Delete aufräumen.
    // Ein gerade getrennter Tunnel meldet sonst HTTP 400 / Code 1022 ("This tunnel has
    // active connections") und bliebe verwaist. Der Connections-Cleanup ist idempotent
    // (0 Connections → 200) und best-effort: schlägt er fehl, wird der Delete (+ Retry)
    // trotzdem versucht. Token nie im Log (CloudflareApiError enthält kein Secret).
    try {
      await this.#apiDelete(connectionsUrl, token);
    } catch {
      // best-effort — der eigentliche Delete (+ Retry) ist maßgeblich
    }

    try {
      await this.#apiDelete(tunnelUrl, token);
    } catch {
      // Falls der Delete dennoch scheitert (Connections noch nicht geschlossen, Code 1022):
      // Connections einmal erneut aufräumen und Delete wiederholen. Schlägt auch das fehl,
      // wird der Fehler propagiert (→ geheimnisfreier cleanupError in VpsProviderRegistry, AC4).
      try {
        await this.#apiDelete(connectionsUrl, token);
      } catch {
        // best-effort
      }
      await this.#apiDelete(tunnelUrl, token);
    }
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
   * @param {object} body  - JSON request body
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

    if (res.status === 404) {
      throw new CloudflareApiError('Cloudflare resource not found', 'not-found', 404);
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

    let parsed;
    try {
      parsed = await res.json();
    } catch {
      throw new CloudflareApiError(
        'Cloudflare API returned invalid JSON',
        'cloudflare-unavailable',
        502,
      );
    }

    if (parsed?.success === false) {
      const firstError = Array.isArray(parsed.errors) ? parsed.errors[0] : null;
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

    return parsed;
  }

  /**
   * Execute a POST request against the Cloudflare API.
   * Token goes in Authorization: Bearer header — never in URL/log/response.
   *
   * @param {string} url
   * @param {string} token - Bearer token (NEVER logged)
   * @param {object} body  - JSON request body
   * @returns {Promise<object>} Parsed JSON response body
   * @throws {CloudflareApiError}
   */
  async #apiPost(url, token, body) {
    let res;
    try {
      res = await this.#fetch(url, {
        method: 'POST',
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

    if (res.status === 404) {
      throw new CloudflareApiError('Cloudflare resource not found', 'not-found', 404);
    }

    if (res.status === 409) {
      // Conflict — e.g. DNS record already exists; treat as non-fatal for idempotent creates
      throw new CloudflareApiError('Cloudflare resource already exists', 'conflict', 409);
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

    let parsed;
    try {
      parsed = await res.json();
    } catch {
      throw new CloudflareApiError(
        'Cloudflare API returned invalid JSON',
        'cloudflare-unavailable',
        502,
      );
    }

    if (parsed?.success === false) {
      const firstError = Array.isArray(parsed.errors) ? parsed.errors[0] : null;
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

    return parsed;
  }

  /**
   * Execute a DELETE request against the Cloudflare API.
   * Token goes in Authorization: Bearer header — never in URL/log/response.
   *
   * @param {string} url
   * @param {string} token - Bearer token (NEVER logged)
   * @returns {Promise<void>}
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
      // Idempotent: resource already gone is fine
      return;
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

    // Guard: Cloudflare can return HTTP 200 with { success: false } — treat as error
    // (finding from #108-Review: #apiDelete lacked this guard, present in #apiGet/#apiPut)
    let parsed;
    try {
      parsed = await res.json();
    } catch {
      // DELETE responses may have no body (204-style) — that is fine
      return;
    }

    if (parsed?.success === false) {
      const firstError = Array.isArray(parsed.errors) ? parsed.errors[0] : null;
      const code = firstError?.code;
      if (code === 10000 || code === 9109) {
        throw new CloudflareApiError(
          'Cloudflare authentication failed',
          'cloudflare-auth-failed',
          502,
        );
      }
      throw new CloudflareApiError(
        'Cloudflare API returned an error on DELETE',
        'cloudflare-unavailable',
        502,
      );
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
