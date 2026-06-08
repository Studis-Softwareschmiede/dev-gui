/**
 * cloudflareRouter — Express-Router für Cloudflare-API-Boundary (ADR-010/011).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET  /api/cloudflare/zones                      → { configured, zones: CfZone[], errors? }
 *   GET  /api/cloudflare/zones/:zoneId/tunnels       → { tunnels: CfTunnel[], routes: CfRoute[], errors? }
 *
 * Security (ADR-010 / security/R01):
 *   - Alle /api/cloudflare/* hinter AccessGuard (server.js — alle /api/* sind geschützt).
 *   - Cloudflare-Token/Account-Id erscheinen NIEMALS in Response, Log, Audit, WS oder URL.
 *   - Untrusted Input (zoneId) wird validiert (security/R02/R03).
 *   - Degradation: ein Zone-/Tunnel-Fehler kippt nicht die Gesamt-Antwort (errors[]).
 *
 * @module cloudflareRouter
 */

import { Router } from 'express';
import { CloudflareApiError } from './cloudflare/CloudflareApi.js';

/** Zone-ID validation: Cloudflare zone IDs are 32-char hex strings. */
const ZONE_ID_RE = /^[a-f0-9]{32}$/i;

// ── Router Factory ─────────────────────────────────────────────────────────────

/**
 * @param {import('./cloudflare/CloudflareApi.js').CloudflareApi} cloudflareApi
 * @returns {import('express').Router}
 */
export function cloudflareRouter(cloudflareApi) {
  const router = Router();

  // ── GET /api/cloudflare/zones ─────────────────────────────────────────────────
  /**
   * List all Cloudflare zones for the configured account.
   * Returns { configured: false, zones: [] } when not configured (AC3).
   *
   * Response: { configured: boolean, zones: CfZone[], errors?: [{ scope, errorClass }] }
   */
  router.get('/api/cloudflare/zones', async (_req, res) => {
    try {
      const result = await cloudflareApi.listZones();
      res.json(result);
    } catch (err) {
      const { errorClass, httpStatus } = classifyError(err);
      // Never include token/account-id in response (security/R01)
      res.status(httpStatus).json({ error: errorClass });
    }
  });

  // ── GET /api/cloudflare/zones/:zoneId/tunnels ─────────────────────────────────
  /**
   * List tunnels + routes for a zone.
   * Tunnels are account-scoped; zoneId is passed through to annotate results.
   * Routes are fetched per-tunnel and degraded individually.
   *
   * Response: { tunnels: CfTunnel[], routes: CfRoute[], errors?: [{ scope, errorClass }] }
   */
  router.get('/api/cloudflare/zones/:zoneId/tunnels', async (req, res) => {
    const { zoneId } = req.params;

    // Validate zoneId — Cloudflare zone IDs are 32-char hex
    if (!zoneId || !ZONE_ID_RE.test(zoneId)) {
      return res.status(422).json({ error: 'invalid-zone-id' });
    }

    const tunnels = [];
    const routes = [];
    const errors = [];

    try {
      // List all tunnels for the account, annotated with this zoneId
      const fetchedTunnels = await cloudflareApi.listTunnels(zoneId);
      tunnels.push(...fetchedTunnels);

      // Fetch routes per tunnel — degrading (one tunnel failure != total failure)
      const routePromises = fetchedTunnels.map(async (tunnel) => {
        try {
          const tunnelRoutes = await cloudflareApi.listRoutes(tunnel.id);
          routes.push(...tunnelRoutes);
        } catch (err) {
          const { errorClass } = classifyError(err);
          errors.push({ scope: `tunnel:${tunnel.id}`, errorClass });
        }
      });

      await Promise.allSettled(routePromises);
    } catch (err) {
      const { errorClass, httpStatus } = classifyError(err);
      // Not-configured is a 422 with a specific body
      if (errorClass === 'cloudflare-not-configured') {
        return res.status(422).json({ error: errorClass });
      }
      // Other errors on the tunnel-list level → degraded response with errors[]
      errors.push({ scope: `zone:${zoneId}`, errorClass });
      // Return partial result even on top-level tunnel-list failure
      const result = { tunnels, routes };
      if (errors.length > 0) result.errors = errors;
      return res.status(httpStatus).json(result);
    }

    const result = { tunnels, routes };
    if (errors.length > 0) result.errors = errors;
    res.json(result);
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Classify an error to errorClass + httpStatus.
 * Token/secret MUST NOT appear in errorClass.
 *
 * @param {unknown} err
 * @returns {{ errorClass: string, httpStatus: number }}
 */
function classifyError(err) {
  if (err instanceof CloudflareApiError) {
    return { errorClass: err.errorClass, httpStatus: err.httpStatus };
  }
  return { errorClass: 'cloudflare-unavailable', httpStatus: 502 };
}
