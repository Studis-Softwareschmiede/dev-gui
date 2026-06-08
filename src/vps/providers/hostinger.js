/**
 * hostinger.js — Hostinger VPS API REST-Adapter (AC1, ADR-009).
 *
 * Implementiert den VpsProvider-Vertrag für Hostinger:
 *   capabilities() → { list, start, stop, create }
 *   listMachines()                               → VpsMachine[]
 *   start(serverId)                              → { result, reason? }
 *   stop(serverId)                               → { result, reason? }
 *   create({ name, region, serverType, image, userData, sshPublicKeys }) → { result: "unsupported" }
 *
 * REST-Endpunkte (Hostinger VPS API — developers.hostinger.com):
 *   GET  https://developers.hostinger.com/api/vps/v1/virtual-machines         → Liste aller VMs
 *   POST https://developers.hostinger.com/api/vps/v1/virtual-machines/{id}/start → start
 *   POST https://developers.hostinger.com/api/vps/v1/virtual-machines/{id}/stop  → stop
 *
 * Auth: Authorization: Bearer <token> (Header, nicht URL)
 *
 * HOSTINGER_CREATE_UNSUPPORTED:
 *   Hostinger POST /api/vps/v1/virtual-machines ist ein kostenpflichtiger Kauf
 *   ("purchase and setup a new virtual machine") — er löst eine echte Zahlung aus.
 *   Dieser Endpunkt ist NICHT der Scope unseres Lifecycle-Panels (Create-from-scratch
 *   eines Servers, nicht ein Kauf mit Abrechnung). Daher ist `create` für Hostinger
 *   bewusst als `unsupported` deklariert (capability create:false, result "unsupported"/422
 *   bei Aufruf). Das entspricht dem von AC6 vorgesehenen `unsupported`-Fall.
 *
 * Security (ADR-009 / security/R01):
 *   - Token wird als Funktionsargument empfangen (nie gecacht, nie geloggt).
 *   - Token landet nur im Authorization-Header — nie in URL, Argv, Log, Response.
 *   - Alle Calls: Timeout via AbortController (js/R03).
 *   - Non-2xx → typisierter Fehler (HostingerAdapterError) ohne Token-Leak.
 *
 * @module hostinger
 */

import { normalizeHostinger } from '../normalize.js';

/** Hostinger VPS API base URL. */
const HOSTINGER_API = 'https://developers.hostinger.com';

/** Fetch timeout in ms (ADR-009: ~10s). */
const FETCH_TIMEOUT_MS = 10000;

// ── HostingerAdapter ──────────────────────────────────────────────────────────

/**
 * Hostinger VPS API Adapter.
 * Implements the VpsProvider contract (ADR-009).
 *
 * The token is passed per-call by VpsProviderRegistry — never stored in the adapter.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn] - Injectable fetch for tests
 */
export class HostingerAdapter {
  #fetch;

  constructor({ fetchFn } = {}) {
    this.#fetch = fetchFn ?? fetch;
  }

  /**
   * Returns static capability flags for Hostinger.
   *
   * HOSTINGER_CREATE_UNSUPPORTED: create is false because the Hostinger
   * POST /api/vps/v1/virtual-machines endpoint is a paid purchase action —
   * not a lifecycle panel operation. See module-level comment.
   *
   * @returns {{ list: boolean, start: boolean, stop: boolean, create: boolean }}
   */
  capabilities() {
    return { list: true, start: true, stop: true, create: false };
  }

  /**
   * Lists all virtual machines from the Hostinger VPS API.
   * The Hostinger API returns a flat list (no datacenter construct).
   *
   * @param {string} token - API token (transient, from VpsProviderRegistry)
   * @returns {Promise<import('../VpsProviderRegistry.js').VpsMachine[]>}
   * @throws {HostingerAdapterError}
   */
  async listMachines(token) {
    const url = `${HOSTINGER_API}/api/vps/v1/virtual-machines`;
    const data = await this.#apiGet(url, token);

    // Hostinger returns either an array directly or { data: [...] }
    // HOSTINGER_API_ASSUMPTION: The list endpoint returns a top-level array or
    // a wrapper object with a "data" key containing the array of VMs.
    const vms = Array.isArray(data) ? data : (data?.data ?? []);
    return vms.map((vm) => normalizeHostinger(vm));
  }

  /**
   * Powers on a virtual machine.
   * Idempotent: if the VM is already running, we treat the call as ok.
   *
   * @param {string} serverId - VM ID (as string)
   * @param {string} token    - API token (transient)
   * @returns {Promise<{ result: "ok"|"unsupported"|"error", reason?: string }>}
   */
  async start(serverId, token) {
    const id = encodeURIComponent(serverId);
    const url = `${HOSTINGER_API}/api/vps/v1/virtual-machines/${id}/start`;
    try {
      await this.#apiPost(url, token, {});
      return { result: 'ok' };
    } catch (err) {
      if (err instanceof HostingerAdapterError) {
        // Already in target state (200/204 with specific message, or 409 Conflict)
        if (err.errorClass === 'already-in-target-state') {
          return { result: 'ok' };
        }
        if (err.errorClass === 'not-found') {
          return { result: 'error', reason: 'VM nicht gefunden' };
        }
        return { result: 'error', reason: err.message };
      }
      return { result: 'error', reason: 'Unerwarteter Fehler beim Starten' };
    }
  }

  /**
   * Powers off a virtual machine.
   * Idempotent: if already off, returns ok.
   *
   * @param {string} serverId - VM ID (as string)
   * @param {string} token    - API token (transient)
   * @returns {Promise<{ result: "ok"|"unsupported"|"error", reason?: string }>}
   */
  async stop(serverId, token) {
    const id = encodeURIComponent(serverId);
    const url = `${HOSTINGER_API}/api/vps/v1/virtual-machines/${id}/stop`;
    try {
      await this.#apiPost(url, token, {});
      return { result: 'ok' };
    } catch (err) {
      if (err instanceof HostingerAdapterError) {
        if (err.errorClass === 'already-in-target-state') {
          return { result: 'ok' };
        }
        if (err.errorClass === 'not-found') {
          return { result: 'error', reason: 'VM nicht gefunden' };
        }
        return { result: 'error', reason: err.message };
      }
      return { result: 'error', reason: 'Unerwarteter Fehler beim Stoppen' };
    }
  }

  /**
   * Create is NOT supported for Hostinger.
   *
   * HOSTINGER_CREATE_UNSUPPORTED: The Hostinger POST /api/vps/v1/virtual-machines
   * endpoint is a paid purchase action that triggers real billing — it is intentionally
   * out of scope for the lifecycle panel. Per AC6, this method declares
   * create as unsupported and returns result:"unsupported" without any destructive
   * fallback action. The capability flag create:false communicates this to the UI.
   *
   * @param {object} _params - ignored
   * @param {string} _token  - ignored
   * @returns {Promise<{ result: "unsupported", reason: string }>}
   */
  async create(_params, _token) {
    return {
      result: 'unsupported',
      reason:
        'Hostinger create ist nicht unterstützt: POST /api/vps/v1/virtual-machines löst ' +
        'einen kostenpflichtigen Kauf aus und ist nicht im Scope des Lifecycle-Panels. ' +
        '(HOSTINGER_CREATE_UNSUPPORTED)',
    };
  }

  // ── Private API helpers ──────────────────────────────────────────────────────

  /**
   * Performs a GET request with Bearer auth and timeout.
   * Throws HostingerAdapterError on non-2xx or network failure.
   * Token NEVER appears in URL, log, or error message.
   *
   * @param {string} url
   * @param {string} token
   * @returns {Promise<object>}
   */
  async #apiGet(url, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await this.#fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new HostingerAdapterError('Hostinger API Timeout', 'provider-unavailable', null);
      }
      throw new HostingerAdapterError(
        `Hostinger API nicht erreichbar: ${sanitizeMsg(err.message)}`,
        'provider-unavailable',
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      return res.json();
    }
    return this.#handleErrorResponse(res);
  }

  /**
   * Performs a POST request with Bearer auth and timeout.
   * Throws HostingerAdapterError on non-2xx or network failure.
   *
   * @param {string} url
   * @param {string} token
   * @param {object} body
   * @returns {Promise<object>}
   */
  async #apiPost(url, token, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new HostingerAdapterError('Hostinger API Timeout', 'provider-unavailable', null);
      }
      throw new HostingerAdapterError(
        `Hostinger API nicht erreichbar: ${sanitizeMsg(err.message)}`,
        'provider-unavailable',
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.ok || res.status === 201 || res.status === 204) {
      // 204 No Content (empty body) — return empty object
      if (res.status === 204) return {};
      return res.json();
    }
    return this.#handleErrorResponse(res);
  }

  /**
   * Reads and classifies a non-2xx Hostinger response.
   * Token NEVER appears in the thrown error.
   *
   * @param {Response} res
   * @returns {Promise<never>}
   */
  async #handleErrorResponse(res) {
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    // HOSTINGER_API_ASSUMPTION: Hostinger error responses follow the shape
    // { message: "...", errors?: {...} } or { error: "..." }
    const message = body?.message ?? body?.error ?? '';

    if (res.status === 401) {
      throw new HostingerAdapterError(
        'Hostinger API: Authentifizierung fehlgeschlagen (Token ungültig)',
        'provider-auth-failed',
        401,
      );
    }
    if (res.status === 403) {
      throw new HostingerAdapterError(
        'Hostinger API: Keine Berechtigung',
        'provider-auth-failed',
        403,
      );
    }
    if (res.status === 404) {
      throw new HostingerAdapterError(
        'Hostinger API: Ressource nicht gefunden',
        'not-found',
        404,
      );
    }
    if (res.status === 409) {
      // 409 Conflict — VM already in target state (idempotent)
      throw new HostingerAdapterError(
        'Hostinger: VM bereits im Zielzustand',
        'already-in-target-state',
        409,
      );
    }
    if (res.status === 422) {
      throw new HostingerAdapterError(
        `Hostinger API: Ungültige Anfrage (422) — ${sanitizeMsg(message)}`,
        'validation-error',
        422,
      );
    }
    if (res.status === 429) {
      throw new HostingerAdapterError(
        'Hostinger API: Rate-Limit überschritten',
        'provider-unavailable',
        429,
      );
    }
    if (res.status >= 500) {
      throw new HostingerAdapterError(
        `Hostinger API: Serverfehler (HTTP ${res.status})`,
        'provider-unavailable',
        res.status,
      );
    }
    throw new HostingerAdapterError(
      `Hostinger API: Unerwarteter Statuscode (HTTP ${res.status})`,
      'provider-unavailable',
      res.status,
    );
  }
}

// ── HostingerAdapterError ─────────────────────────────────────────────────────

/**
 * Typed error thrown by HostingerAdapter.
 * Message MUST NOT contain the API token or any secret.
 */
export class HostingerAdapterError extends Error {
  /**
   * @param {string} message    - Human-readable (NO secrets)
   * @param {string} errorClass - Machine-readable classification
   * @param {number|null} httpStatus - HTTP status that caused this
   */
  constructor(message, errorClass, httpStatus) {
    super(message);
    this.name = 'HostingerAdapterError';
    this.errorClass = errorClass;
    this.httpStatus = httpStatus ?? null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strips bearer-token-like patterns from error messages (security/R01).
 * @param {string} msg
 * @returns {string}
 */
function sanitizeMsg(msg) {
  if (typeof msg !== 'string') return 'unbekannter Fehler';
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 200);
}
