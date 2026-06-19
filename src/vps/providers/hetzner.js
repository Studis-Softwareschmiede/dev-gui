/**
 * hetzner.js — Hetzner Cloud API REST-Adapter (AC1, ADR-009).
 *
 * Implementiert den VpsProvider-Vertrag für Hetzner:
 *   capabilities() → { list, start, stop, create }
 *   listMachines()                               → VpsMachine[]
 *   start(serverId)                              → { result, reason? }
 *   stop(serverId)                               → { result, reason? }
 *   create({ name, region, serverType, image, userData, sshPublicKeys }) → VpsMachine
 *
 * REST-Endpunkte (Hetzner Cloud API v1):
 *   GET  https://api.hetzner.cloud/v1/servers                        → Liste aller Server
 *   POST https://api.hetzner.cloud/v1/servers/{id}/actions/poweron   → Server starten
 *   POST https://api.hetzner.cloud/v1/servers/{id}/actions/poweroff  → Server stoppen
 *   POST https://api.hetzner.cloud/v1/servers                        → Server erstellen
 *
 * Auth: Authorization: Bearer <token> (Header, nicht URL)
 *
 * Ubuntu-26.04-Annahme:
 *   Zum Stand der Implementierung (Juni 2026) ist Ubuntu 26.04 LTS noch nicht als
 *   offizieller Hetzner-Image-Slug verfügbar (Ubuntu 26.04 erscheint April 2026,
 *   Hetzner-Slug-Verfügbarkeit üblicherweise einige Wochen nach Ubuntu-Release).
 *   Als Default wird "ubuntu-24.04" (Ubuntu 24.04 LTS "Noble Numbat") verwendet —
 *   der aktuell späteste offizielle Ubuntu-LTS-Slug bei Hetzner.
 *   Sobald "ubuntu-26.04" bei Hetzner verfügbar ist, muss HETZNER_DEFAULT_IMAGE
 *   auf diesen Slug aktualisiert werden (Grep-Tag: UBUNTU_26_04_SLUG).
 *
 * Security (ADR-009 / security/R01):
 *   - Token wird als Funktionsargument empfangen (nie gecacht, nie geloggt).
 *   - Token landet nur im Authorization-Header — nie in URL, Argv, Log, Response.
 *   - Alle Calls: Timeout via AbortController (js/R03).
 *   - Non-2xx → typisierter Fehler (HetznerAdapterError) ohne Token-Leak.
 *
 * @module hetzner
 */

import { normalizeHetzner } from '../normalize.js';

/** Hetzner Cloud API base URL. */
const HETZNER_API = 'https://api.hetzner.cloud/v1';

/**
 * Default Ubuntu LTS image slug.
 * NOTE: Ubuntu 26.04 LTS is not yet available as a Hetzner image slug (as of June 2026).
 * Using ubuntu-24.04 (Noble Numbat) as the latest available Ubuntu LTS.
 * Update this constant when ubuntu-26.04 becomes available at Hetzner.
 * GREP-TAG: UBUNTU_26_04_SLUG
 */
const HETZNER_DEFAULT_IMAGE = 'ubuntu-24.04';

/** Fetch timeout in ms (ADR-009: ~10s). */
const FETCH_TIMEOUT_MS = 10000;

// ── HetznerAdapter ─────────────────────────────────────────────────────────────

/**
 * Hetzner Cloud API Adapter.
 * Implements the VpsProvider contract (ADR-009).
 *
 * The token is passed per-call by VpsProviderRegistry — never stored in the adapter.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn] - Injectable fetch for tests
 */
export class HetznerAdapter {
  #fetch;

  constructor({ fetchFn } = {}) {
    this.#fetch = fetchFn ?? fetch;
  }

  /**
   * Returns static capability flags for Hetzner.
   * Hetzner Cloud API supports all five Lifecycle actions.
   *
   * @returns {{ list: boolean, start: boolean, stop: boolean, create: boolean, delete: boolean }}
   */
  capabilities() {
    return { list: true, start: true, stop: true, create: true, delete: true };
  }

  /**
   * Lists all servers from the Hetzner Cloud API.
   * Paginates through all pages (Hetzner max 25/page by default; we request 100).
   *
   * @param {string} token - API token (transient, from VpsProviderRegistry)
   * @returns {Promise<import('../VpsProviderRegistry.js').VpsMachine[]>}
   * @throws {HetznerAdapterError}
   */
  async listMachines(token) {
    const machines = [];
    let page = 1;

    while (true) {
      const url = `${HETZNER_API}/servers?per_page=100&page=${page}`;
      const data = await this.#apiGet(url, token);

      const servers = data.servers ?? [];
      for (const server of servers) {
        machines.push(normalizeHetzner(server));
      }

      // Pagination: check if there are more pages
      const meta = data.meta?.pagination;
      if (!meta || page >= meta.last_page || servers.length === 0) {
        break;
      }
      page++;
    }

    return machines;
  }

  /**
   * Lists available server types (S-161, vps-create-options AC1–AC3).
   * Deprecated types are excluded. Prices are returned per location (monthly + hourly).
   *
   * @param {string} token - API token (transient)
   * @returns {Promise<Array<{ name, cores, memory, disk, prices }>>}
   * @throws {HetznerAdapterError}
   */
  async listServerTypes(token) {
    const types = [];
    let page = 1;
    while (true) {
      const data = await this.#apiGet(`${HETZNER_API}/server_types?per_page=50&page=${page}`, token);
      const list = data.server_types ?? [];
      for (const t of list) {
        if (t.deprecated) continue; // AC: deprecated Typen ausblenden
        types.push({
          name: t.name,
          cores: t.cores ?? null,
          memory: t.memory ?? null,
          disk: t.disk ?? null,
          // Preise je Location (monatlich + stündlich, net+gross); graceful bei fehlenden Feldern
          prices: (t.prices ?? []).map((p) => ({
            location: p.location ?? null,
            monthly: p.price_monthly ? { net: p.price_monthly.net ?? null, gross: p.price_monthly.gross ?? null } : null,
            hourly: p.price_hourly ? { net: p.price_hourly.net ?? null, gross: p.price_hourly.gross ?? null } : null,
          })),
        });
      }
      const meta = data.meta?.pagination;
      if (!meta || page >= meta.last_page || list.length === 0) break;
      page++;
    }
    return types;
  }

  /**
   * Lists available locations (S-161, vps-create-options AC1/AC4).
   * `name` is the location slug (e.g. nbg1/fsn1/hel1) — NOT the network zone (eu-central).
   *
   * @param {string} token - API token (transient)
   * @returns {Promise<Array<{ name, networkZone, city, country }>>}
   * @throws {HetznerAdapterError}
   */
  async listLocations(token) {
    const data = await this.#apiGet(`${HETZNER_API}/locations`, token);
    return (data.locations ?? []).map((l) => ({
      name: l.name,
      networkZone: l.network_zone ?? null,
      city: l.city ?? null,
      country: l.country ?? null,
    }));
  }

  /**
   * Lists available system images (S-161, vps-create-options AC1/AC5).
   *
   * @param {string} token - API token (transient)
   * @returns {Promise<Array<{ name, description, osFlavor, osVersion }>>}
   * @throws {HetznerAdapterError}
   */
  async listImages(token) {
    const images = [];
    let page = 1;
    while (true) {
      const data = await this.#apiGet(`${HETZNER_API}/images?type=system&per_page=50&page=${page}`, token);
      const list = data.images ?? [];
      for (const img of list) {
        images.push({
          name: img.name,
          description: img.description ?? null,
          osFlavor: img.os_flavor ?? null,
          osVersion: img.os_version ?? null,
        });
      }
      const meta = data.meta?.pagination;
      if (!meta || page >= meta.last_page || list.length === 0) break;
      page++;
    }
    return images;
  }

  /**
   * Powers on a server.
   * Idempotent: if the server is already running, Hetzner returns success.
   *
   * @param {string} serverId - Numeric server ID (as string)
   * @param {string} token    - API token (transient)
   * @returns {Promise<{ result: "ok"|"unsupported"|"error", reason?: string }>}
   */
  async start(serverId, token) {
    const id = encodeURIComponent(serverId);
    const url = `${HETZNER_API}/servers/${id}/actions/poweron`;
    try {
      await this.#apiPost(url, token, {});
      return { result: 'ok' };
    } catch (err) {
      if (err instanceof HetznerAdapterError) {
        // 422 with action_failed or server already in target state → idempotent ok
        if (err.httpStatus === 422 || err.errorClass === 'already-in-target-state') {
          return { result: 'ok' };
        }
        if (err.errorClass === 'not-found') {
          return { result: 'error', reason: 'Server nicht gefunden' };
        }
        return { result: 'error', reason: err.message };
      }
      return { result: 'error', reason: 'Unerwarteter Fehler beim Starten' };
    }
  }

  /**
   * Powers off a server (hard off).
   * Idempotent: if already off, returns ok.
   *
   * @param {string} serverId - Numeric server ID (as string)
   * @param {string} token    - API token (transient)
   * @returns {Promise<{ result: "ok"|"unsupported"|"error", reason?: string }>}
   */
  async stop(serverId, token) {
    const id = encodeURIComponent(serverId);
    const url = `${HETZNER_API}/servers/${id}/actions/poweroff`;
    try {
      await this.#apiPost(url, token, {});
      return { result: 'ok' };
    } catch (err) {
      if (err instanceof HetznerAdapterError) {
        if (err.httpStatus === 422 || err.errorClass === 'already-in-target-state') {
          return { result: 'ok' };
        }
        if (err.errorClass === 'not-found') {
          return { result: 'error', reason: 'Server nicht gefunden' };
        }
        return { result: 'error', reason: err.message };
      }
      return { result: 'error', reason: 'Unerwarteter Fehler beim Stoppen' };
    }
  }

  /**
   * Deletes a server at Hetzner (DELETE /servers/{id}).
   *
   * Idempotent: if the server is already gone (404), returns ok.
   *
   * @param {string} serverId - Numeric server ID (as string)
   * @param {string} token    - API token (transient)
   * @returns {Promise<{ result: "ok"|"unsupported"|"error", reason?: string }>}
   */
  async deleteServer(serverId, token) {
    const id = encodeURIComponent(serverId);
    const url = `${HETZNER_API}/servers/${id}`;
    try {
      await this.#apiDelete(url, token);
      return { result: 'ok' };
    } catch (err) {
      if (err instanceof HetznerAdapterError) {
        if (err.errorClass === 'not-found') {
          // Already gone — idempotent ok
          return { result: 'ok' };
        }
        return { result: 'error', reason: err.message };
      }
      return { result: 'error', reason: 'Unerwarteter Fehler beim Löschen' };
    }
  }

  /**
   * Creates a new server at Hetzner.
   *
   * Hetzner Create-Payload (POST /servers):
   *   name, server_type, image, location, user_data, ssh_keys, start_after_create
   *
   * NOTE: ssh_keys in the Hetzner API refers to SSH-Key-IDs or names registered
   * in the Hetzner project — NOT raw public key material. In this adapter we pass
   * sshPublicKeys (raw OpenSSH strings from the CredentialStore) via user_data only,
   * since we cannot assume they are pre-registered in Hetzner. The user_data (cloud-init)
   * handles key injection for root and alex users.
   *
   * @param {object} params
   * @param {string} params.name           - Server name
   * @param {string} params.region         - Hetzner location (e.g. "nbg1", "fsn1", "hel1")
   * @param {string} params.serverType     - Hetzner server type slug (e.g. "cx11", "cx21")
   * @param {string} [params.image]        - Image slug (default: ubuntu-24.04)
   * @param {string} [params.userData]     - cloud-init user-data string (from CloudInitBuilder)
   * @param {object} [params.sshPublicKeys] - { root?: string, alex?: string } — passed via cloud-init
   * @param {string} token                 - API token (transient)
   * @returns {Promise<import('../VpsProviderRegistry.js').VpsMachine>}
   * @throws {HetznerAdapterError}
   */
  async create({ name, region, serverType, image, userData, sshPublicKeys: _sshPublicKeys }, token) {
    // Validate required fields before API call (security/R02)
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new HetznerAdapterError('name ist ein Pflichtfeld', 'validation-error', 422);
    }
    if (!region || typeof region !== 'string' || !region.trim()) {
      throw new HetznerAdapterError('region ist ein Pflichtfeld', 'validation-error', 422);
    }
    if (!serverType || typeof serverType !== 'string' || !serverType.trim()) {
      throw new HetznerAdapterError('serverType ist ein Pflichtfeld', 'validation-error', 422);
    }

    const resolvedImage = (image && typeof image === 'string' && image.trim())
      ? image.trim()
      : HETZNER_DEFAULT_IMAGE;

    const payload = {
      name: name.trim(),
      server_type: serverType.trim(),
      image: resolvedImage,
      location: region.trim(),
      start_after_create: true,
    };

    // cloud-init user_data — passed through as-is from CloudInitBuilder
    if (userData && typeof userData === 'string' && userData.trim()) {
      payload.user_data = userData;
    }

    const data = await this.#apiPost(`${HETZNER_API}/servers`, token, payload);

    // Hetzner returns { server: {...}, ... } on 201
    const server = data.server ?? data;
    return normalizeHetzner(server);
  }

  // ── Private API helpers ──────────────────────────────────────────────────────

  /**
   * Performs a GET request with Bearer auth and timeout.
   * Throws HetznerAdapterError on non-2xx or network failure.
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
        throw new HetznerAdapterError('Hetzner API Timeout', 'provider-unavailable', null);
      }
      throw new HetznerAdapterError(
        `Hetzner API nicht erreichbar: ${sanitizeMsg(err.message)}`,
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
   * Throws HetznerAdapterError on non-2xx or network failure.
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
        throw new HetznerAdapterError('Hetzner API Timeout', 'provider-unavailable', null);
      }
      throw new HetznerAdapterError(
        `Hetzner API nicht erreichbar: ${sanitizeMsg(err.message)}`,
        'provider-unavailable',
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.ok || res.status === 201) {
      return res.json();
    }
    return this.#handleErrorResponse(res);
  }

  /**
   * Performs a DELETE request with Bearer auth and timeout.
   * Throws HetznerAdapterError on non-2xx (except 404) or network failure.
   *
   * @param {string} url
   * @param {string} token
   * @returns {Promise<void>}
   */
  async #apiDelete(url, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await this.#fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new HetznerAdapterError('Hetzner API Timeout', 'provider-unavailable', null);
      }
      throw new HetznerAdapterError(
        `Hetzner API nicht erreichbar: ${sanitizeMsg(err.message)}`,
        'provider-unavailable',
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    // 204 No Content or 200 OK on successful delete
    if (res.ok || res.status === 204) {
      return;
    }
    return this.#handleErrorResponse(res);
  }

  /**
   * Reads and classifies a non-2xx Hetzner response.
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

    const code = body?.error?.code ?? '';
    const message = body?.error?.message ?? '';

    if (res.status === 401) {
      throw new HetznerAdapterError(
        'Hetzner API: Authentifizierung fehlgeschlagen (Token ungültig)',
        'provider-auth-failed',
        401,
      );
    }
    if (res.status === 403) {
      throw new HetznerAdapterError(
        'Hetzner API: Keine Berechtigung',
        'provider-auth-failed',
        403,
      );
    }
    if (res.status === 404) {
      throw new HetznerAdapterError(
        'Hetzner API: Ressource nicht gefunden',
        'not-found',
        404,
      );
    }
    if (res.status === 422) {
      // Check for "already in target state" (idempotency)
      if (code === 'action_failed' || message.toLowerCase().includes('already')) {
        throw new HetznerAdapterError(
          'Hetzner: Server bereits im Zielzustand',
          'already-in-target-state',
          422,
        );
      }
      if (code === 'invalid_input' || code === 'resource_unavailable') {
        throw new HetznerAdapterError(
          `Hetzner API: Ungültige Anfrage — ${sanitizeMsg(message)}`,
          'validation-error',
          422,
        );
      }
      throw new HetznerAdapterError(
        `Hetzner API: Unverarbeitbare Anfrage (422) — ${sanitizeMsg(message)}`,
        'validation-error',
        422,
      );
    }
    if (res.status === 429) {
      throw new HetznerAdapterError(
        'Hetzner API: Rate-Limit überschritten',
        'provider-unavailable',
        429,
      );
    }
    if (res.status >= 500) {
      throw new HetznerAdapterError(
        `Hetzner API: Serverfehler (HTTP ${res.status})`,
        'provider-unavailable',
        res.status,
      );
    }
    throw new HetznerAdapterError(
      `Hetzner API: Unerwarteter Statuscode (HTTP ${res.status})`,
      'provider-unavailable',
      res.status,
    );
  }
}

// ── HetznerAdapterError ────────────────────────────────────────────────────────

/**
 * Typed error thrown by HetznerAdapter.
 * Message MUST NOT contain the API token or any secret.
 */
export class HetznerAdapterError extends Error {
  /**
   * @param {string} message    - Human-readable (NO secrets)
   * @param {string} errorClass - Machine-readable classification
   * @param {number|null} httpStatus - HTTP status that caused this
   */
  constructor(message, errorClass, httpStatus) {
    super(message);
    this.name = 'HetznerAdapterError';
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
