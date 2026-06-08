/**
 * ionos.js — IONOS Cloud (Compute Engine) API REST-Adapter (AC1, ADR-009).
 *
 * Implementiert den VpsProvider-Vertrag für IONOS Cloud:
 *   capabilities() → { list, start, stop, create }
 *   listMachines()                               → VpsMachine[]
 *   start(serverId)                              → { result, reason? }
 *   stop(serverId)                               → { result, reason? }
 *   create({ name, region, serverType, image, userData, sshPublicKeys }) → VpsMachine
 *
 * REST-Endpunkte (IONOS Cloud API v6):
 *   GET  https://api.ionos.com/cloudapi/v6/datacenters?depth=1          → Datacenter-Liste
 *   GET  https://api.ionos.com/cloudapi/v6/datacenters/{dcId}/servers?depth=1 → Server je DC
 *   POST https://api.ionos.com/cloudapi/v6/datacenters/{dcId}/servers/{id}/start → start
 *   POST https://api.ionos.com/cloudapi/v6/datacenters/{dcId}/servers/{id}/stop  → stop
 *   POST https://api.ionos.com/cloudapi/v6/datacenters/{dcId}/servers            → create
 *
 * Auth: Authorization: Bearer <token>
 *
 * ServerId-Kodierung (ADR-009 / IONOS-spezifisch):
 *   IONOS-Server sind unter Datacenters genestet. Ein Server kann nicht über seine
 *   eigene ID allein adressiert werden — das Datacenter-ID/Server-ID-Paar wird
 *   benötigt. Dieses Adapter kodiert das als zusammengesetztes serverId-String:
 *     "<datacenterId>/<serverId>"
 *   Beispiel: "abc123-dc/def456-srv"
 *   Beim Parsen: erster '/'-Separator trennt datacenter von server (beide Teile
 *   können UUIDs mit '-' enthalten, aber kein '/').
 *
 * Create-Annahmen (IONOS_API_ASSUMPTION):
 *   1. userData-Kodierung: IONOS nimmt userData als base64-kodiertes cloud-init-Dokument
 *      in properties.userData des Create-Body.
 *      IONOS_API_ASSUMPTION: genaue Verschachtelung im Create-Payload für server+volume.
 *   2. Image-Identifikation für Ubuntu 26.04: IONOS-Images werden über ihre UUID
 *      referenziert, nicht über Namen-Slugs. Als Default-Suche wird nach einem
 *      Image mit name-Substring "Ubuntu-26" / "ubuntu-26" gesucht; existiert keines,
 *      wird "Ubuntu-24" als Fallback genutzt.
 *      IONOS_API_ASSUMPTION: exakter Image-Name/Slug in IONOS-Cloud-Katalog.
 *   3. Volume-Pflicht: IONOS erfordert beim Server-Create ein separates Volume-Objekt
 *      (entities.volumes) mit einem Image. Der Adapter erstellt Server + Volume in
 *      einem einzigen POST (IONOS Cloud API v6 unterstützt das inline im Server-Body).
 *      IONOS_API_ASSUMPTION: inline-Volume-Create im Server-Create-POST ist ausreichend;
 *      kein separater POST /volumes nötig.
 *
 * Security (ADR-009 / security/R01):
 *   - Token wird als Funktionsargument empfangen (nie gecacht, nie geloggt).
 *   - Token landet nur im Authorization-Header — nie in URL, Argv, Log, Response.
 *   - Alle Calls: Timeout via AbortController (js/R03).
 *   - Non-2xx → typisierter Fehler (IonosAdapterError) ohne Token-Leak.
 *
 * @module ionos
 */

import { normalizeIonos } from '../normalize.js';

/** IONOS Cloud API base URL. */
const IONOS_API = 'https://api.ionos.com/cloudapi/v6';

/**
 * Default Ubuntu LTS image name substring for IONOS.
 * IONOS uses UUIDs for images — the adapter searches by name substring.
 * IONOS_API_ASSUMPTION: exact image name format in IONOS Cloud catalog.
 */
const IONOS_DEFAULT_IMAGE_SEARCH = 'Ubuntu-26';
const IONOS_FALLBACK_IMAGE_SEARCH = 'Ubuntu-24';

/** Fetch timeout in ms (ADR-009: ~10s). */
const FETCH_TIMEOUT_MS = 10000;

/**
 * Parses a composite serverId ("<datacenterId>/<serverId>") into its parts.
 * Returns null if the format is invalid.
 *
 * @param {string} compositeId
 * @returns {{ datacenterId: string, serverId: string }|null}
 */
function parseCompositeId(compositeId) {
  if (typeof compositeId !== 'string') return null;
  const slashIdx = compositeId.indexOf('/');
  if (slashIdx <= 0 || slashIdx === compositeId.length - 1) return null;
  return {
    datacenterId: compositeId.slice(0, slashIdx),
    serverId: compositeId.slice(slashIdx + 1),
  };
}

// ── IonosAdapter ──────────────────────────────────────────────────────────────

/**
 * IONOS Cloud API Adapter.
 * Implements the VpsProvider contract (ADR-009).
 *
 * The token is passed per-call by VpsProviderRegistry — never stored in the adapter.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn] - Injectable fetch for tests
 */
export class IonosAdapter {
  #fetch;

  constructor({ fetchFn } = {}) {
    this.#fetch = fetchFn ?? fetch;
  }

  /**
   * Returns static capability flags for IONOS.
   * IONOS Cloud API v6 supports all four Lifecycle actions.
   *
   * @returns {{ list: boolean, start: boolean, stop: boolean, create: boolean }}
   */
  capabilities() {
    return { list: true, start: true, stop: true, create: true };
  }

  /**
   * Lists all servers across all IONOS Datacenters.
   *
   * IONOS servers are nested under Datacenters — there is no flat server list.
   * Strategy:
   *   1. GET /datacenters?depth=1  → all datacenter IDs
   *   2. For each DC: GET /datacenters/{dcId}/servers?depth=1 → servers
   *   3. Aggregate; normalize each server with composite serverId "<dcId>/<srvId>"
   *
   * @param {string} token - API token (transient, from VpsProviderRegistry)
   * @returns {Promise<import('../VpsProviderRegistry.js').VpsMachine[]>}
   * @throws {IonosAdapterError}
   */
  async listMachines(token) {
    // Step 1: list all datacenters
    const dcData = await this.#apiGet(`${IONOS_API}/datacenters?depth=1`, token);
    const datacenters = dcData.items ?? [];

    const machines = [];

    // Step 2: for each datacenter, list its servers
    for (const dc of datacenters) {
      const dcId = dc.id;
      if (!dcId) continue;

      let serversData;
      try {
        serversData = await this.#apiGet(
          `${IONOS_API}/datacenters/${encodeURIComponent(dcId)}/servers?depth=1`,
          token,
        );
      } catch {
        // Degradation: single DC failure does not abort the whole listing
        continue;
      }

      const servers = serversData.items ?? [];
      for (const server of servers) {
        // Encode composite serverId: "<datacenterId>/<serverId>"
        const compositeId = `${dcId}/${server.id}`;
        machines.push(normalizeIonos(server, compositeId));
      }
    }

    return machines;
  }

  /**
   * Powers on a server (IONOS: POST .../start).
   * Idempotent: already-running servers return ok.
   *
   * serverId must be composite "<datacenterId>/<serverId>".
   *
   * @param {string} serverId - Composite "<dcId>/<srvId>"
   * @param {string} token    - API token (transient)
   * @returns {Promise<{ result: "ok"|"unsupported"|"error", reason?: string }>}
   */
  async start(serverId, token) {
    const parts = parseCompositeId(serverId);
    if (!parts) {
      return { result: 'error', reason: 'Ungültige serverId — Format erwartet: "<datacenterId>/<serverId>"' };
    }
    const { datacenterId, serverId: srvId } = parts;
    const url = `${IONOS_API}/datacenters/${encodeURIComponent(datacenterId)}/servers/${encodeURIComponent(srvId)}/start`;
    try {
      await this.#apiPost(url, token, null);
      return { result: 'ok' };
    } catch (err) {
      if (err instanceof IonosAdapterError) {
        // Only already-in-target-state is idempotent ok — real validation errors (422
        // with a different message) must propagate as result:"error" (Finding 2 fix).
        if (err.errorClass === 'already-in-target-state') {
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
   * Powers off a server (IONOS: POST .../stop).
   * Idempotent: already-stopped servers return ok.
   *
   * serverId must be composite "<datacenterId>/<serverId>".
   *
   * @param {string} serverId - Composite "<dcId>/<srvId>"
   * @param {string} token    - API token (transient)
   * @returns {Promise<{ result: "ok"|"unsupported"|"error", reason?: string }>}
   */
  async stop(serverId, token) {
    const parts = parseCompositeId(serverId);
    if (!parts) {
      return { result: 'error', reason: 'Ungültige serverId — Format erwartet: "<datacenterId>/<serverId>"' };
    }
    const { datacenterId, serverId: srvId } = parts;
    const url = `${IONOS_API}/datacenters/${encodeURIComponent(datacenterId)}/servers/${encodeURIComponent(srvId)}/stop`;
    try {
      await this.#apiPost(url, token, null);
      return { result: 'ok' };
    } catch (err) {
      if (err instanceof IonosAdapterError) {
        // Only already-in-target-state is idempotent ok — real validation errors (422
        // with a different message) must propagate as result:"error" (Finding 2 fix).
        if (err.errorClass === 'already-in-target-state') {
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
   * Creates a new server in the first available IONOS Datacenter matching region.
   *
   * IONOS Create-Payload (POST /datacenters/{dcId}/servers):
   *   properties: { name, cores, ram, type }
   *   entities: { volumes: { items: [{ properties: { name, size, image, userData, type } }] } }
   *
   * IONOS_API_ASSUMPTION: inline Volume in the Server-Create POST is supported.
   * IONOS_API_ASSUMPTION: userData must be base64-encoded in properties.userData.
   * IONOS_API_ASSUMPTION: image field references an image UUID (not a name/slug).
   *
   * @param {object} params
   * @param {string} params.name           - Server name
   * @param {string} params.region         - IONOS datacenter location (e.g. "de/fra", "de/txl")
   * @param {string} params.serverType     - IONOS server type (e.g. "ENTERPRISE", "CUBE")
   * @param {string} [params.image]        - Image UUID or name substring; default: Ubuntu 26/24
   * @param {string} [params.userData]     - cloud-init user-data string (from CloudInitBuilder)
   * @param {object} [params.sshPublicKeys] - { root?: string, alex?: string } — via cloud-init
   * @param {string} token                 - API token (transient)
   * @returns {Promise<import('../VpsProviderRegistry.js').VpsMachine>}
   * @throws {IonosAdapterError}
   */
  async create({ name, region, serverType, image, userData, sshPublicKeys: _sshPublicKeys }, token) {
    // Validate required fields (security/R02)
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new IonosAdapterError('name ist ein Pflichtfeld', 'validation-error', 422);
    }
    if (!region || typeof region !== 'string' || !region.trim()) {
      throw new IonosAdapterError('region ist ein Pflichtfeld', 'validation-error', 422);
    }
    if (!serverType || typeof serverType !== 'string' || !serverType.trim()) {
      throw new IonosAdapterError('serverType ist ein Pflichtfeld', 'validation-error', 422);
    }

    // Step 1: find target datacenter by region
    const dcData = await this.#apiGet(`${IONOS_API}/datacenters?depth=1`, token);
    const datacenters = dcData.items ?? [];

    const targetDc = datacenters.find((dc) => {
      const loc = dc.properties?.location ?? '';
      return loc === region.trim() || loc.includes(region.trim());
    });
    // IONOS_API_ASSUMPTION: if no datacenter matches region, we fail with a clear error
    // (previously: silent fallback to datacenters[0] — removed to avoid creating servers
    // in unexpected locations).

    if (!targetDc) {
      throw new IonosAdapterError(
        `Kein Datacenter für Region '${sanitizeMsg(region)}' gefunden`,
        'validation-error',
        422,
      );
    }

    const dcId = targetDc.id;

    // Step 2: resolve image — use provided UUID or search by name
    // IONOS_API_ASSUMPTION: image name search via GET /images?type=IMAGE
    const imageId = (image && typeof image === 'string' && image.trim())
      ? image.trim()
      : await this.#resolveDefaultImage(token);

    if (!imageId) {
      throw new IonosAdapterError(
        'Kein passendes Ubuntu-Image in IONOS gefunden',
        'validation-error',
        422,
      );
    }

    // Step 3: base64-encode userData for IONOS
    // IONOS_API_ASSUMPTION: userData must be base64-encoded string in properties.userData
    let encodedUserData;
    if (userData && typeof userData === 'string' && userData.trim()) {
      encodedUserData = Buffer.from(userData, 'utf8').toString('base64');
    }

    // Step 4: build create payload
    // IONOS_API_ASSUMPTION: inline Volume in Server-Create POST; type "HDD" for boot volume
    const payload = {
      properties: {
        name: name.trim(),
        cores: 1, // IONOS_API_ASSUMPTION: default 1 core; serverType maps to ENTERPRISE/CUBE type
        ram: 1024, // IONOS_API_ASSUMPTION: default 1 GB RAM
        type: serverType.trim(),
      },
      entities: {
        volumes: {
          items: [
            {
              properties: {
                name: `${name.trim()}-boot`,
                size: 20, // IONOS_API_ASSUMPTION: default 20 GB boot volume
                image: imageId,
                type: 'HDD', // IONOS_API_ASSUMPTION: HDD type for boot volume
                ...(encodedUserData ? { userData: encodedUserData } : {}),
              },
            },
          ],
        },
      },
    };

    const data = await this.#apiPost(
      `${IONOS_API}/datacenters/${encodeURIComponent(dcId)}/servers`,
      token,
      payload,
    );

    // IONOS Create returns the server object directly (HTTP 202 Accepted)
    const server = data;
    const compositeId = `${dcId}/${server.id}`;
    return normalizeIonos(server, compositeId);
  }

  // ── Private API helpers ──────────────────────────────────────────────────────

  /**
   * Resolves the default Ubuntu image ID from IONOS image catalog.
   * Searches for Ubuntu 26 first, falls back to Ubuntu 24.
   * IONOS_API_ASSUMPTION: images available via GET /images?type=IMAGE&imageAliases=true
   *
   * @param {string} token
   * @returns {Promise<string|null>} image UUID or null
   */
  async #resolveDefaultImage(token) {
    let imagesData;
    try {
      imagesData = await this.#apiGet(`${IONOS_API}/images?type=IMAGE`, token);
    } catch {
      return null;
    }
    const images = imagesData.items ?? [];

    // Try Ubuntu 26 first, then Ubuntu 24
    for (const search of [IONOS_DEFAULT_IMAGE_SEARCH, IONOS_FALLBACK_IMAGE_SEARCH]) {
      const found = images.find((img) => {
        const imgName = img.properties?.name ?? '';
        return imgName.includes(search);
      });
      if (found) return found.id;
    }
    return null;
  }

  /**
   * Performs a GET request with Bearer auth and timeout.
   * Throws IonosAdapterError on non-2xx or network failure.
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
        throw new IonosAdapterError('IONOS API Timeout', 'provider-unavailable', null);
      }
      throw new IonosAdapterError(
        `IONOS API nicht erreichbar: ${sanitizeMsg(err.message)}`,
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
   * Throws IonosAdapterError on non-2xx or network failure.
   *
   * @param {string} url
   * @param {string} token
   * @param {object|null} body - Request body; null for parameterless actions (start/stop)
   * @returns {Promise<object>}
   */
  async #apiPost(url, token, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      const init = {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      };
      if (body !== null && body !== undefined) {
        init.body = JSON.stringify(body);
      }
      res = await this.#fetch(url, init);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new IonosAdapterError('IONOS API Timeout', 'provider-unavailable', null);
      }
      throw new IonosAdapterError(
        `IONOS API nicht erreichbar: ${sanitizeMsg(err.message)}`,
        'provider-unavailable',
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    // IONOS returns 202 Accepted for async mutations (start/stop/create)
    if (res.ok || res.status === 202) {
      // start/stop return 202 with empty body — guard against empty-body JSON parse
      const text = await res.text();
      if (!text || text.trim() === '') return {};
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    }
    return this.#handleErrorResponse(res);
  }

  /**
   * Reads and classifies a non-2xx IONOS response.
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

    // IONOS error shape: { httpStatus, message, ... }
    const message = body?.message ?? body?.messages?.[0]?.message ?? '';

    if (res.status === 401) {
      throw new IonosAdapterError(
        'IONOS API: Authentifizierung fehlgeschlagen (Token ungültig)',
        'provider-auth-failed',
        401,
      );
    }
    if (res.status === 403) {
      throw new IonosAdapterError(
        'IONOS API: Keine Berechtigung',
        'provider-auth-failed',
        403,
      );
    }
    if (res.status === 404) {
      throw new IonosAdapterError(
        'IONOS API: Ressource nicht gefunden',
        'not-found',
        404,
      );
    }
    if (res.status === 422) {
      // Check for already-in-target-state semantics
      const msgLower = String(message).toLowerCase();
      if (msgLower.includes('already') || msgLower.includes('running') || msgLower.includes('stopped')) {
        throw new IonosAdapterError(
          'IONOS: Server bereits im Zielzustand',
          'already-in-target-state',
          422,
        );
      }
      throw new IonosAdapterError(
        `IONOS API: Ungültige Anfrage — ${sanitizeMsg(message)}`,
        'validation-error',
        422,
      );
    }
    if (res.status === 429) {
      throw new IonosAdapterError(
        'IONOS API: Rate-Limit überschritten',
        'provider-unavailable',
        429,
      );
    }
    if (res.status >= 500) {
      throw new IonosAdapterError(
        `IONOS API: Serverfehler (HTTP ${res.status})`,
        'provider-unavailable',
        res.status,
      );
    }
    throw new IonosAdapterError(
      `IONOS API: Unerwarteter Statuscode (HTTP ${res.status})`,
      'provider-unavailable',
      res.status,
    );
  }
}

// ── IonosAdapterError ─────────────────────────────────────────────────────────

/**
 * Typed error thrown by IonosAdapter.
 * Message MUST NOT contain the API token or any secret.
 */
export class IonosAdapterError extends Error {
  /**
   * @param {string} message    - Human-readable (NO secrets)
   * @param {string} errorClass - Machine-readable classification
   * @param {number|null} httpStatus - HTTP status that caused this
   */
  constructor(message, errorClass, httpStatus) {
    super(message);
    this.name = 'IonosAdapterError';
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
