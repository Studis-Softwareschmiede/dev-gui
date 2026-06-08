/**
 * cloudflareRouter — Express-Router für Cloudflare-API-Boundary (ADR-010/011).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/cloudflare/zones                                  → { configured, zones: CfZone[], errors? }
 *   GET    /api/cloudflare/zones/:zoneId/tunnels                  → { tunnels: CfTunnel[], routes: CfRoute[], errors? }
 *   DELETE /api/cloudflare/tunnels/:tunnelId/routes/:hostname     → { result, reason? }
 *   DELETE /api/cloudflare/tunnels/:tunnelId                      → { result, reason? }
 *
 * Security (ADR-010/011 / security/R01/R04):
 *   - Alle /api/cloudflare/* hinter AccessGuard (server.js — alle /api/* sind geschützt).
 *   - DELETE-Endpunkte zusätzlich: LockoutGuard (hart) → confirm-Match → CRED_ADMIN_EMAILS-Rolle
 *     → Audit-First → Mutation (ADR-011 kanonische Reihenfolge).
 *   - Cloudflare-Token/Account-Id erscheinen NIEMALS in Response, Log, Audit, WS oder URL.
 *   - Untrusted Input (zoneId, tunnelId, hostname) wird validiert (security/R02/R03).
 *   - Degradation: ein Zone-/Tunnel-Fehler kippt nicht die Gesamt-Antwort (errors[]).
 *
 * @module cloudflareRouter
 */

import { Router } from 'express';
import { CloudflareApiError } from './cloudflare/CloudflareApi.js';

/** Zone-ID validation: Cloudflare zone IDs are 32-char hex strings. */
const ZONE_ID_RE = /^[a-f0-9]{32}$/i;

/** Tunnel-ID validation: Cloudflare tunnel IDs are UUID v4 format. */
const TUNNEL_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Hostname validation: basic hostname format (no injection characters). */
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-._]{0,251}[a-zA-Z0-9])?$/;

/** Max hostname length (DNS limit). */
const HOSTNAME_MAX_LEN = 253;

// ── Router Factory ─────────────────────────────────────────────────────────────

/**
 * @param {import('./cloudflare/CloudflareApi.js').CloudflareApi} cloudflareApi
 * @param {import('./AuditStore.js').AuditStore} [auditStore]
 * @returns {import('express').Router}
 */
export function cloudflareRouter(cloudflareApi, auditStore) {
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
      const { errorClass } = classifyError(err);
      // Not-configured is a 422 with a specific body
      if (errorClass === 'cloudflare-not-configured') {
        return res.status(422).json({ error: errorClass });
      }
      // Other errors on the tunnel-list level → HTTP 200 + errors[]
      // (analog VPS providerErrors-pattern; fetch-clients stay in success-branch)
      errors.push({ scope: `zone:${zoneId}`, errorClass });
      const result = { tunnels, routes, errors };
      return res.json(result);
    }

    const result = { tunnels, routes };
    if (errors.length > 0) result.errors = errors;
    res.json(result);
  });

  // ── DELETE /api/cloudflare/tunnels/:tunnelId/routes/:hostname ─────────────────
  /**
   * Delete a single Public Hostname route from a tunnel.
   *
   * ADR-011 canonical guard sequence (HARD):
   *   1. LockoutGuard.isProtected(hostname) → 422 protected-resource (before ALL else)
   *   2. confirm body must exactly match hostname → 422 confirmation-required
   *   3. CRED_ADMIN_EMAILS role check → 403
   *   4. Audit-First → AuditStore.record(…)
   *   5. Mutation via CloudflareApi.removeRoute(tunnelId, hostname)
   *
   * Body: { confirm: "<hostname>" }
   * Response: { result: "ok"|"error", reason? }
   */
  router.delete('/api/cloudflare/tunnels/:tunnelId/routes/:hostname', async (req, res) => {
    const { tunnelId, hostname } = req.params;

    // Validate tunnelId
    if (!tunnelId || !TUNNEL_ID_RE.test(tunnelId)) {
      return res.status(422).json({ error: 'invalid-tunnel-id' });
    }

    // Validate hostname (security/R02 — untrusted input)
    if (!hostname || hostname.length > HOSTNAME_MAX_LEN || !HOSTNAME_RE.test(hostname)) {
      return res.status(422).json({ error: 'invalid-hostname' });
    }

    // ADR-011 Step 1: LockoutGuard FIRST — before confirm/role/audit
    if (cloudflareApi.isProtected(hostname)) {
      return res.status(422).json({ error: 'protected-resource', reason: 'geschützt: eigene Erreichbarkeit' });
    }

    // ADR-011 Step 2: type-to-confirm — confirm body must exactly match hostname
    const { confirm } = req.body ?? {};
    if (!confirm || confirm !== hostname) {
      return res.status(422).json({ error: 'confirmation-required', reason: 'Hostname im confirm-Feld muss exakt übereinstimmen' });
    }

    // ADR-011 Step 3: CRED_ADMIN_EMAILS role check (security/R04)
    const roleError = checkAdminRole(req);
    if (roleError) {
      return res.status(403).json({ error: roleError });
    }

    // ADR-011 Step 4: Audit-First — before mutation
    const identity = req.identity?.email ?? null;
    if (auditStore) {
      try {
        auditStore.record({
          identity,
          command: `cloudflare:route:delete tunnelId=${tunnelId} hostname=${hostname}`,
        });
      } catch {
        // Audit-Write failed → no mutation (ADR-010/007 Audit-First contract)
        return res.status(500).json({ error: 'audit-failed' });
      }
    }

    // ADR-011 Step 5: Mutation
    try {
      const result = await cloudflareApi.removeRoute(tunnelId, hostname);
      res.json(result);
    } catch (err) {
      const { errorClass, httpStatus } = classifyError(err);
      // Never leak token/credentials in response
      res.status(httpStatus).json({ error: errorClass });
    }
  });

  // ── DELETE /api/cloudflare/tunnels/:tunnelId ──────────────────────────────────
  /**
   * Delete an entire Cloudflare tunnel.
   *
   * ADR-011 canonical guard sequence (same as route-delete):
   *   1. LockoutGuard on tunnelId / representative hostname (confirm value)
   *   2. confirm body must exactly match tunnelId or tunnel name → 422 confirmation-required
   *   3. CRED_ADMIN_EMAILS role check → 403
   *   4. Audit-First
   *   5. Mutation via CloudflareApi.deleteTunnel(tunnelId, confirm)
   *
   * Body: { confirm: "<tunnelname-oder-hostname>" }
   * Response: { result: "ok"|"error", reason? }
   */
  router.delete('/api/cloudflare/tunnels/:tunnelId', async (req, res) => {
    const { tunnelId } = req.params;

    // Validate tunnelId
    if (!tunnelId || !TUNNEL_ID_RE.test(tunnelId)) {
      return res.status(422).json({ error: 'invalid-tunnel-id' });
    }

    const { confirm } = req.body ?? {};

    // ADR-011 Step 1: LockoutGuard FIRST — hart, vor allem anderen (nicht überschreibbar,
    // egal welcher confirm-Token oder ob confirm fehlt).
    // Check tunnelId (always present from URL) plus confirm value if provided.
    if (cloudflareApi.isProtected(tunnelId) || (confirm && cloudflareApi.isProtected(confirm))) {
      return res.status(422).json({ error: 'protected-resource', reason: 'geschützt: eigene Erreichbarkeit' });
    }

    // ADR-011 Step 2: type-to-confirm Pflicht — confirm must be present and non-empty
    if (!confirm || typeof confirm !== 'string' || confirm.trim() === '') {
      return res.status(422).json({ error: 'confirmation-required', reason: 'confirm-Feld ist Pflicht' });
    }

    // ADR-011 Step 3: CRED_ADMIN_EMAILS role check (security/R04)
    const roleError = checkAdminRole(req);
    if (roleError) {
      return res.status(403).json({ error: roleError });
    }

    // ADR-011 Step 4: Audit-First — before mutation
    const identity = req.identity?.email ?? null;
    if (auditStore) {
      try {
        auditStore.record({
          identity,
          command: `cloudflare:tunnel:delete tunnelId=${tunnelId} confirm=${confirm}`,
        });
      } catch {
        return res.status(500).json({ error: 'audit-failed' });
      }
    }

    // ADR-011 Step 5: Mutation
    try {
      const result = await cloudflareApi.deleteTunnel(tunnelId, confirm);
      res.json(result);
    } catch (err) {
      const { errorClass, httpStatus } = classifyError(err);
      res.status(httpStatus).json({ error: errorClass });
    }
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

/**
 * Check CRED_ADMIN_EMAILS role (security/R04, ADR-007/010/011).
 * Returns an error string if access is denied, null if allowed.
 *
 * If CRED_ADMIN_EMAILS env var is set (comma-separated list), only those
 * email addresses may perform mutating actions. If unset, any valid Access
 * identity may mutate (ADR-007 "jede gültige Access-Identität").
 *
 * @param {import('express').Request} req
 * @returns {string|null} error string or null if authorized
 */
function checkAdminRole(req) {
  const adminEmails = process.env.CRED_ADMIN_EMAILS;
  if (!adminEmails || adminEmails.trim() === '') {
    // No restriction — any valid Access identity is allowed
    return null;
  }
  const allowlist = adminEmails.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const identity = req.identity?.email;
  if (!identity || !allowlist.includes(identity.toLowerCase())) {
    return 'forbidden';
  }
  return null;
}
