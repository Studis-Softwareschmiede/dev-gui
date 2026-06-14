/**
 * Router-Wrapper: VPS-Provider-Boundary.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/vps/providers, GET /api/vps/machines,
 *           POST /api/vps/machines/:provider,
 *           POST /api/vps/machines/:provider/:serverId/start,
 *           POST /api/vps/machines/:provider/:serverId/stop
 */
import { vpsRouter } from '../vpsRouter.js';

export const order = 120;

/**
 * @param {{ vpsRegistry: import('../vps/VpsProviderRegistry.js').VpsProviderRegistry, auditStore: import('../AuditStore.js').AuditStore }} deps
 * @returns {import('express').Router}
 */
export function create({ vpsRegistry, auditStore }) {
  return vpsRouter(vpsRegistry, auditStore);
}
