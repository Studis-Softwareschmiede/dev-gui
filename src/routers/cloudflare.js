/**
 * Router-Wrapper: Cloudflare-API-Boundary.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/cloudflare/zones, GET /api/cloudflare/zones/:zoneId/tunnels,
 *           DELETE /api/cloudflare/tunnels/:tunnelId/routes/:hostname,
 *           DELETE /api/cloudflare/tunnels/:tunnelId
 */
import { cloudflareRouter } from '../cloudflareRouter.js';

export const order = 130;

/**
 * @param {{ cloudflareApi: import('../cloudflare/CloudflareApi.js').CloudflareApi, auditStore: import('../AuditStore.js').AuditStore }} deps
 * @returns {import('express').Router}
 */
export function create({ cloudflareApi, auditStore }) {
  return cloudflareRouter(cloudflareApi, auditStore);
}
