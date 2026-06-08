/**
 * hostinger.js — Hostinger VPS API REST-Adapter (AC1, ADR-009).
 *
 * Implementiert den VpsProvider-Vertrag für Hostinger:
 *   capabilities() → { list, start, stop, create }
 *   listMachines()                               → VpsMachine[]
 *   start(serverId)                              → { result, reason? }
 *   stop(serverId)                               → { result, reason? }
 *   create({ name, region, serverType, image, userData, sshPublicKeys }) → VpsMachine
 *
 * REST-Endpunkte (Hostinger VPS API — developers.hostinger.com):
 *   GET  https://developers.hostinger.com/api/vps/v1/virtual-machines         → Liste
 *   POST https://developers.hostinger.com/api/vps/v1/virtual-machines/{id}/start → start
 *   POST https://developers.hostinger.com/api/vps/v1/virtual-machines/{id}/stop  → stop
 *   POST https://developers.hostinger.com/api/vps/v1/virtual-machines            → create
 *
 * Auth: Authorization: Bearer <token>
 *
 * PLACEHOLDER-Adapter: Dieses Item (#95) implementiert den Hetzner-Adapter vollständig.
 * Hostinger ist für Item #97 vorgesehen. Dieser Stub implementiert capabilities() korrekt
 * und liefert bei jedem Aufruf result:"unsupported" — kein Fehler, keine destruktive
 * Ersatzaktion. Die Registry kann den Provider registrieren ohne dass GET /api/vps/machines
 * daran scheitert (AC4 / Degradation-Sicherheit).
 *
 * @module hostinger
 */

// ── HostingerAdapter ──────────────────────────────────────────────────────────

/**
 * Hostinger VPS API Adapter (Stub — vollständige Implementierung in #97).
 * Implementiert den VpsProvider-Vertrag (ADR-009).
 */
export class HostingerAdapter {
  constructor(_options = {}) {
    // Stub — no state needed until #97
  }

  /**
   * Stub-Capabilities: alle false, da Hostinger noch nicht implementiert ist.
   * Item #97 setzt die echten Capabilities (list/start/stop/create: true),
   * sobald der vollständige Adapter implementiert ist. So zeigt
   * GET /api/vps/providers den Provider korrekt als „noch nicht verfügbar"
   * statt als leer-aber-fähig.
   *
   * @returns {{ list: boolean, start: boolean, stop: boolean, create: boolean }}
   */
  capabilities() {
    // Stub — echte Capabilities folgen in #97
    return { list: false, start: false, stop: false, create: false };
  }

  /**
   * Stub: noch nicht implementiert (folgt in #97).
   * @param {string} _token
   * @returns {Promise<[]>}
   */
  async listMachines(_token) {
    return [];
  }

  /**
   * Stub: noch nicht implementiert (folgt in #97).
   * @param {string} _serverId
   * @param {string} _token
   * @returns {Promise<{ result: "unsupported", reason: string }>}
   */
  async start(_serverId, _token) {
    return { result: 'unsupported', reason: 'Hostinger-Adapter noch nicht implementiert (folgt in #97)' };
  }

  /**
   * Stub: noch nicht implementiert (folgt in #97).
   * @param {string} _serverId
   * @param {string} _token
   * @returns {Promise<{ result: "unsupported", reason: string }>}
   */
  async stop(_serverId, _token) {
    return { result: 'unsupported', reason: 'Hostinger-Adapter noch nicht implementiert (folgt in #97)' };
  }

  /**
   * Stub: noch nicht implementiert (folgt in #97).
   * @param {object} _params
   * @param {string} _token
   * @returns {Promise<never>}
   */
  async create(_params, _token) {
    throw new HostingerAdapterError(
      'Hostinger-Adapter noch nicht implementiert (folgt in #97)',
      'not-implemented',
      501,
    );
  }
}

// ── HostingerAdapterError ─────────────────────────────────────────────────────

/**
 * Typed error for HostingerAdapter.
 */
export class HostingerAdapterError extends Error {
  constructor(message, errorClass, httpStatus) {
    super(message);
    this.name = 'HostingerAdapterError';
    this.errorClass = errorClass;
    this.httpStatus = httpStatus ?? null;
  }
}
