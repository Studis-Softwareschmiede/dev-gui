/**
 * normalize.js — Cloudflare API raw responses → CfZone / CfTunnel / CfRoute (data-model.md).
 *
 * Ground rule (ADR-010 / data-model.md):
 *   Missing/unknown fields → null, NEVER an error.
 *   A missing field neither breaks the mapping nor the read-aggregation.
 *
 * protected flag on CfRoute is set by the caller (CloudflareApi) via LockoutGuard,
 * NOT by normalize.js — this module stays pure mapping, no LockoutGuard import.
 *
 * @module cloudflare/normalize
 *
 * @typedef {object} CfZone
 * @property {string} id
 * @property {string} name
 * @property {string|null} status
 *
 * @typedef {object} CfTunnel
 * @property {string} id
 * @property {string} name
 * @property {string|null} status
 * @property {string} zoneId
 *
 * @typedef {object} CfRoute
 * @property {string} hostname
 * @property {string|null} service
 * @property {string} tunnelId
 * @property {boolean} protected
 */

// ── CfZone ────────────────────────────────────────────────────────────────────

/**
 * Normalise a raw Cloudflare Zone API object to CfZone.
 *
 * Cloudflare Zones API (GET /zones):
 *   id, name, status (active | pending | initializing | moved | deleted | deactivated)
 *
 * @param {object} raw - Cloudflare API zone object
 * @returns {CfZone}
 */
export function normalizeZone(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      id: String(raw?.id ?? 'unknown'),
      name: raw?.name ?? 'unknown',
      status: null,
    };
  }

  return {
    id: String(raw.id ?? 'unknown'),
    name: typeof raw.name === 'string' ? raw.name : 'unknown',
    status: typeof raw.status === 'string' ? raw.status : null,
  };
}

// ── CfTunnel ──────────────────────────────────────────────────────────────────

/**
 * Normalise a raw Cloudflare cfd_tunnel object to CfTunnel.
 *
 * Cloudflare Tunnels API (GET /accounts/{accountId}/cfd_tunnel):
 *   id, name, status (inactive | active | down | degraded | unknown), created_at
 *
 * @param {object} raw       - Cloudflare API tunnel object
 * @param {string} zoneId    - Parent zone ID (injected by caller, not in tunnel response)
 * @returns {CfTunnel}
 */
export function normalizeTunnel(raw, zoneId) {
  if (!raw || typeof raw !== 'object') {
    return {
      id: String(raw?.id ?? 'unknown'),
      name: raw?.name ?? 'unknown',
      status: null,
      zoneId: zoneId ?? 'unknown',
    };
  }

  return {
    id: String(raw.id ?? 'unknown'),
    name: typeof raw.name === 'string' ? raw.name : 'unknown',
    status: typeof raw.status === 'string' ? raw.status : null,
    zoneId: zoneId ?? 'unknown',
  };
}

// ── CfRoute ───────────────────────────────────────────────────────────────────

/**
 * Normalise a raw Cloudflare tunnel ingress rule to CfRoute.
 *
 * Cloudflare Tunnel Configuration API
 * (GET /accounts/{accountId}/cfd_tunnel/{tunnelId}/configurations):
 *   config.ingress: [{ hostname, service, originRequest? }, ...]
 *   The last entry is typically a catch-all with no hostname (exclude it).
 *
 * @param {object} raw        - Cloudflare ingress rule object
 * @param {string} tunnelId   - Parent tunnel ID (injected by caller)
 * @param {boolean} [isProtected=false] - Set by CloudflareApi via LockoutGuard
 * @returns {CfRoute}
 */
export function normalizeRoute(raw, tunnelId, isProtected = false) {
  if (!raw || typeof raw !== 'object') {
    return {
      hostname: raw?.hostname ?? 'unknown',
      service: null,
      tunnelId: tunnelId ?? 'unknown',
      protected: true, // fail-closed on bad input
    };
  }

  return {
    hostname: typeof raw.hostname === 'string' ? raw.hostname : 'unknown',
    service: typeof raw.service === 'string' ? raw.service : null,
    tunnelId: tunnelId ?? 'unknown',
    protected: isProtected,
  };
}
