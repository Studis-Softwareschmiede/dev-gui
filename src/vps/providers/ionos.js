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
 *   GET  https://api.ionos.com/cloudapi/v6/datacenters/{dcId}/servers      → Liste
 *   POST https://api.ionos.com/cloudapi/v6/datacenters/{dcId}/servers/{id}/start → start
 *   POST https://api.ionos.com/cloudapi/v6/datacenters/{dcId}/servers/{id}/stop  → stop
 *   POST https://api.ionos.com/cloudapi/v6/datacenters/{dcId}/servers            → create
 *
 * Auth: Authorization: Bearer <token>
 *
 * PLACEHOLDER-Adapter: Dieses Item (#95) implementiert den Hetzner-Adapter vollständig.
 * IONOS ist für Item #96 vorgesehen. Dieser Stub implementiert capabilities() korrekt
 * (alle true, da IONOS Cloud API alle Lifecycle-Aktionen unterstützt) und liefert
 * bei jedem Aufruf result:"unsupported" mit einem klaren Hinweis — kein Fehler,
 * keine destruktive Ersatzaktion. Die Registry kann den Provider registrieren ohne
 * dass GET /api/vps/machines daran scheitert (AC4 / Degradation-Sicherheit).
 *
 * @module ionos
 */

// ── IonosAdapter ──────────────────────────────────────────────────────────────

/**
 * IONOS Cloud API Adapter (Stub — vollständige Implementierung in #96).
 * Implementiert den VpsProvider-Vertrag (ADR-009).
 */
export class IonosAdapter {
  constructor(_options = {}) {
    // Stub — no state needed until #96
  }

  /**
   * Stub-Capabilities: alle false, da IONOS noch nicht implementiert ist.
   * Item #96 setzt die echten Capabilities (list/start/stop/create: true),
   * sobald der vollständige Adapter implementiert ist. So zeigt
   * GET /api/vps/providers den Provider korrekt als „noch nicht verfügbar"
   * statt als leer-aber-fähig.
   *
   * @returns {{ list: boolean, start: boolean, stop: boolean, create: boolean }}
   */
  capabilities() {
    // Stub — echte Capabilities folgen in #96
    return { list: false, start: false, stop: false, create: false };
  }

  /**
   * Stub: noch nicht implementiert (folgt in #96).
   * @param {string} _token
   * @returns {Promise<[]>}
   */
  async listMachines(_token) {
    return [];
  }

  /**
   * Stub: noch nicht implementiert (folgt in #96).
   * @param {string} _serverId
   * @param {string} _token
   * @returns {Promise<{ result: "unsupported", reason: string }>}
   */
  async start(_serverId, _token) {
    return { result: 'unsupported', reason: 'IONOS-Adapter noch nicht implementiert (folgt in #96)' };
  }

  /**
   * Stub: noch nicht implementiert (folgt in #96).
   * @param {string} _serverId
   * @param {string} _token
   * @returns {Promise<{ result: "unsupported", reason: string }>}
   */
  async stop(_serverId, _token) {
    return { result: 'unsupported', reason: 'IONOS-Adapter noch nicht implementiert (folgt in #96)' };
  }

  /**
   * Stub: noch nicht implementiert (folgt in #96).
   * @param {object} _params
   * @param {string} _token
   * @returns {Promise<never>}
   */
  async create(_params, _token) {
    throw new IonosAdapterError(
      'IONOS-Adapter noch nicht implementiert (folgt in #96)',
      'not-implemented',
      501,
    );
  }
}

// ── IonosAdapterError ─────────────────────────────────────────────────────────

/**
 * Typed error for IonosAdapter.
 */
export class IonosAdapterError extends Error {
  constructor(message, errorClass, httpStatus) {
    super(message);
    this.name = 'IonosAdapterError';
    this.errorClass = errorClass;
    this.httpStatus = httpStatus ?? null;
  }
}
