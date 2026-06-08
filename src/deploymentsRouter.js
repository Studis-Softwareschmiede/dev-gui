/**
 * deploymentsRouter — Express-Router für Deploy-Lifecycle (AC3–AC9, ADR-012)
 *                     + Reconciliation-Endpunkte (AC2/AC8/AC8b, ADR-013).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/deployments                          → { deployments: Deployment[], errors? }
 *   POST   /api/deployments                          → { result, deployment?, reason? }   [MUTATION]
 *   DELETE /api/deployments/:vps/:hostname           → { result, reason? }               [MUTATION]
 *   POST   /api/deployments/reconcile                → { result, report? }               [MUTATION]
 *   GET    /api/deployments/reconcile/last           → ReconcileReport | {}
 *   GET    /api/deployments/reconcile/reports        → ReconcileReport[]
 *   GET    /api/deployments/reconcile/notices        → ReconcileNotice[]
 *
 * Security (AC7–AC9 / ADR-012):
 *   - Alle /api/deployments/* hinter AccessGuard (server.js — alle /api/* sind geschützt).
 *   - Mutierende Aktionen (POST, DELETE) zusätzlich identitäts-/rollengeschützt
 *     (gleiche CRED_ADMIN_EMAILS-Logik wie ADR-007/vpsRouter).
 *   - Audit-First: Audit-Eintrag VOR jeder Mutation; schlägt Audit fehl → Aktion unterbleibt.
 *   - LockoutGuard-Hard-Block: protected Hostname → 422 before any step (AC7).
 *   - Undeploy: type-to-confirm (confirm must equal hostname) (AC6).
 *   - SSH-Key + Cloudflare-Token erscheinen NIEMALS in Response, Log, Audit, WS oder URL.
 *   - Untrusted Input (vps, hostname, image, confirm) wird validiert (security/R02/R03).
 *
 * VPS configuration: The router receives a pre-configured vpsConfig map
 * (vpsId → VpsTarget) from server.js. The client sends a vpsId string;
 * the router resolves it to the target server-internally.
 *
 * @module deploymentsRouter
 */

import { Router } from 'express';
import { isValidHostname } from './deploy/hostnameSanitizer.js';

/** Maximum allowed length for free-text fields. */
const MAX_FIELD_LEN = 512;

/** Hostname param: only DNS chars, no shell metacharacters. */
const HOSTNAME_PARAM_RE = /^[a-zA-Z0-9._-]+$/;

// ── Authz-Helper (same pattern as vpsRouter / credentialsRouter) ──────────────

/**
 * Checks whether the requesting identity is allowed to mutate
 * (CRED_ADMIN_EMAILS-logic, AC8/ADR-007).
 *
 * @param {object|null} identity - req.identity from AccessGuard
 * @returns {{ allowed: boolean }}
 */
function checkMutationAuthz(identity) {
  const adminEmails = process.env.CRED_ADMIN_EMAILS;
  if (!adminEmails || !adminEmails.trim()) {
    return { allowed: true };
  }
  const allowed = adminEmails
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const email = (identity?.email ?? '').toLowerCase();
  if (!email || !allowed.includes(email)) {
    return { allowed: false };
  }
  return { allowed: true };
}

// ── Input validation ──────────────────────────────────────────────────────────

/**
 * Validates the POST /api/deployments request body.
 * zoneId is NOT in the body — resolved server-side from hostname (Spec-Gap-Resolution).
 *
 * @param {unknown} body
 * @returns {{ ok: boolean, params?: object, error?: string }}
 */
function validateDeployBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request-Body ist Pflicht' };
  }

  const { image, vps, hostname, tunnelId } = body;

  if (typeof image !== 'string' || !image.trim()) {
    return { ok: false, error: 'image ist ein Pflichtfeld' };
  }
  if (image.trim().length > MAX_FIELD_LEN) {
    return { ok: false, error: `image überschreitet Längenlimit (max. ${MAX_FIELD_LEN} Zeichen)` };
  }

  if (typeof vps !== 'string' || !vps.trim()) {
    return { ok: false, error: 'vps ist ein Pflichtfeld' };
  }
  if (vps.trim().length > MAX_FIELD_LEN) {
    return { ok: false, error: `vps überschreitet Längenlimit` };
  }

  if (typeof hostname !== 'string' || !hostname.trim()) {
    return { ok: false, error: 'hostname ist ein Pflichtfeld' };
  }
  if (!isValidHostname(hostname.trim())) {
    return { ok: false, error: 'hostname enthält ungültige Zeichen (nur DNS-Zeichensatz erlaubt)' };
  }

  if (typeof tunnelId !== 'string' || !tunnelId.trim()) {
    return { ok: false, error: 'tunnelId ist ein Pflichtfeld' };
  }
  if (tunnelId.trim().length > MAX_FIELD_LEN) {
    return { ok: false, error: `tunnelId überschreitet Längenlimit` };
  }

  return {
    ok: true,
    params: {
      image: image.trim(),
      vps: vps.trim(),
      hostname: hostname.trim(),
      tunnelId: tunnelId.trim(),
    },
  };
}

/**
 * Validates the DELETE /api/deployments/:vps/:hostname request params and body.
 * zoneId is NOT required in the body — resolved server-side from hostname.
 *
 * @param {object} params - Express route params
 * @param {unknown} body  - Request body
 * @returns {{ ok: boolean, params?: object, error?: string }}
 */
function validateUndeployParams(params, body) {
  const { vps: vpsParam, hostname: hostnameParam } = params;

  if (!vpsParam || typeof vpsParam !== 'string' || !vpsParam.trim()) {
    return { ok: false, error: 'vps-Parameter fehlt' };
  }

  if (!hostnameParam || typeof hostnameParam !== 'string' || !hostnameParam.trim()) {
    return { ok: false, error: 'hostname-Parameter fehlt' };
  }

  if (!HOSTNAME_PARAM_RE.test(hostnameParam.trim())) {
    return { ok: false, error: 'hostname enthält ungültige Zeichen' };
  }

  const confirm = body?.confirm;
  const tunnelId = body?.tunnelId;

  if (typeof tunnelId !== 'string' || !tunnelId.trim()) {
    return { ok: false, error: 'tunnelId ist ein Pflichtfeld im Body' };
  }

  return {
    ok: true,
    params: {
      vps: vpsParam.trim(),
      hostname: hostnameParam.trim(),
      confirm: typeof confirm === 'string' ? confirm : '',
      tunnelId: tunnelId.trim(),
    },
  };
}

// ── Router Factory ─────────────────────────────────────────────────────────────

/**
 * Creates the deployments router.
 *
 * @param {import('./deploy/DeployOrchestrator.js').DeployOrchestrator} orchestrator
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {Map<string, object>} vpsTargets - map of vpsId → VpsTarget { host, port?, targetUser }
 * @param {import('./deploy/ReconciliationJob.js').ReconciliationJob} [reconciliationJob]
 * @returns {import('express').Router}
 */
export function deploymentsRouter(orchestrator, auditStore, vpsTargets, reconciliationJob) {
  const router = Router();

  // ── GET /api/deployments ──────────────────────────────────────────────────

  /**
   * GET /api/deployments
   * Live listing: container-labels ⊕ cloudflare-routes, no Deploy-State-Store.
   * Degrades per VPS/zone.
   *
   * Query params: vps (required), tunnelId (required)
   *
   * Response: { deployments: Deployment[], errors?: [{ scope, errorClass }] }
   */
  router.get('/api/deployments', async (req, res) => {
    const { vps: vpsId, tunnelId } = req.query;

    if (!vpsId || typeof vpsId !== 'string' || !vpsId.trim()) {
      return res.status(422).json({ error: 'vps query-Parameter ist Pflicht' });
    }
    if (!tunnelId || typeof tunnelId !== 'string' || !tunnelId.trim()) {
      return res.status(422).json({ error: 'tunnelId query-Parameter ist Pflicht' });
    }

    const vpsTarget = vpsTargets.get(vpsId.trim());
    if (!vpsTarget) {
      return res.status(422).json({ error: `Unbekannter VPS: ${vpsId.trim()}` });
    }

    try {
      const result = await orchestrator.listDeployments({
        vps: vpsTarget,
        tunnelId: tunnelId.trim(),
      });
      return res.json(result);
    } catch (err) {
      console.error('[deploymentsRouter] GET /api/deployments Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ error: 'Deployments konnten nicht geladen werden' });
    }
  });

  // ── POST /api/deployments ─────────────────────────────────────────────────

  /**
   * POST /api/deployments
   * Deploy: ghcr-Image → Container + Tunnel-Route + DNS-CNAME (atomare Saga).
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC8/AC9).
   *
   * Body: { image, vps, hostname, tunnelId }
   *   — zoneId is resolved server-side from hostname (Spec-Gap-Resolution)
   *
   * Responses:
   *   200 { result: "ok", deployment }
   *   400 { error }           — Validierungsfehler
   *   403 { error }           — nicht in CRED_ADMIN_EMAILS
   *   422 { result: "error", reason: "protected-resource" }  — LockoutGuard (AC7)
   *   422 { result: "error", reason: "zone-not-found" }      — kein Zone-Match
   *   500 { error }           — Audit-Write fehlgeschlagen
   *   502 { result: "error", reason }  — SSH/Cloudflare-Fehler
   */
  router.post('/api/deployments', async (req, res) => {
    const identity = req.identity ?? null;

    // AC8: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Validate body
    const bodyVal = validateDeployBody(req.body);
    if (!bodyVal.ok) {
      return res.status(400).json({ error: bodyVal.error });
    }
    const { image, vps: vpsId, hostname, tunnelId } = bodyVal.params;

    // Resolve VPS target
    const vpsTarget = vpsTargets.get(vpsId);
    if (!vpsTarget) {
      return res.status(422).json({ error: `Unbekannter VPS: ${vpsId}` });
    }

    // AC9: Audit-First — Eintrag VOR der Mutation; Token/Key NICHT im Audit
    const auditAction = `deploy:create:${vpsId}:${hostname}:${image}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[deploymentsRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Execute deploy saga (zoneId resolved server-side in DeployOrchestrator)
    let result;
    try {
      result = await orchestrator.deploy({
        image,
        vps: vpsTarget,
        hostname,
        tunnelId,
      });
    } catch (err) {
      const errorClass = err?.errorClass ?? 'error';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `deploy:create:${vpsId}:${hostname}:failed:${errorClass}`,
        });
      } catch { /* ignore outcome-audit failure */ }
      console.error('[deploymentsRouter] POST /api/deployments Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ result: 'error', reason: 'Deploy fehlgeschlagen' });
    }

    // Map errorClasses to HTTP status
    if (result.result !== 'ok') {
      const { errorClass, reason } = result;
      // Outcome-audit on failure
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `deploy:create:${vpsId}:${hostname}:failed:${errorClass ?? 'error'}`,
        });
      } catch { /* ignore */ }

      if (errorClass === 'protected-resource') {
        return res.status(422).json({ result: 'error', reason: 'protected-resource' });
      }
      if (errorClass === 'confirmation-required') {
        return res.status(422).json({ result: 'error', reason: 'confirmation-required' });
      }
      if (errorClass === 'zone-not-found') {
        return res.status(422).json({ result: 'error', reason: 'zone-not-found' });
      }
      if (errorClass === 'validation-error') {
        return res.status(400).json({ result: 'error', reason });
      }
      return res.status(502).json({ result: 'error', reason: sanitizeMsg(reason ?? 'Deploy fehlgeschlagen') });
    }

    // Outcome-audit on success
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `deploy:create:${vpsId}:${hostname}:success:${result.deployment?.containerId ?? ''}`,
      });
    } catch { /* ignore */ }

    return res.status(200).json(result);
  });

  // ── DELETE /api/deployments/:vps/:hostname ────────────────────────────────

  /**
   * DELETE /api/deployments/:vps/:hostname
   * Undeploy: remove Route+DNS → Container rm.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz + type-to-confirm (AC5/AC6/AC8/AC9).
   *
   * Body: { confirm: "<hostname>", tunnelId }
   *   — zoneId is resolved server-side from hostname (Spec-Gap-Resolution)
   *
   * Responses:
   *   200 { result: "ok" }
   *   400 { error }           — Validierungsfehler
   *   403 { error }           — nicht in CRED_ADMIN_EMAILS
   *   422 { result: "error", reason: "protected-resource" }   — LockoutGuard (AC7)
   *   422 { result: "error", reason: "confirmation-required" } — falsch/fehlendes confirm (AC6)
   *   500 { error }           — Audit-Write fehlgeschlagen
   *   502 { result: "error", reason }  — SSH/Cloudflare-Fehler
   */
  router.delete('/api/deployments/:vps/:hostname', async (req, res) => {
    const identity = req.identity ?? null;

    // AC8: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Validate params + body
    const paramsVal = validateUndeployParams(req.params, req.body);
    if (!paramsVal.ok) {
      return res.status(400).json({ error: paramsVal.error });
    }
    const { vps: vpsId, hostname, confirm, tunnelId } = paramsVal.params;

    // Resolve VPS target
    const vpsTarget = vpsTargets.get(vpsId);
    if (!vpsTarget) {
      return res.status(422).json({ error: `Unbekannter VPS: ${vpsId}` });
    }

    // AC9: Audit-First — look up container image BEFORE audit to embed in audit string (AC9).
    // If container not found → use 'image:unknown'. Audit stays before mutation.
    let imageForAudit = 'image:unknown';
    try {
      const listResult = await orchestrator.listDeployments({ vps: vpsTarget, tunnelId });
      if (listResult.deployments) {
        const found = listResult.deployments.find((d) => d.hostname === hostname);
        if (found?.image) {
          imageForAudit = found.image;
        }
      }
    } catch {
      // Best-effort image lookup — audit proceeds with 'image:unknown'
    }

    // AC9: Audit-First — VOR der Mutation; Token/Key NICHT im Audit
    const auditAction = `deploy:remove:${vpsId}:${hostname}:${imageForAudit}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[deploymentsRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Execute undeploy (zoneId resolved server-side in DeployOrchestrator)
    let result;
    try {
      result = await orchestrator.undeploy({
        vps: vpsTarget,
        hostname,
        confirm,
        tunnelId,
      });
    } catch (err) {
      const errorClass = err?.errorClass ?? 'error';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `deploy:remove:${vpsId}:${hostname}:failed:${errorClass}`,
        });
      } catch { /* ignore */ }
      console.error('[deploymentsRouter] DELETE /api/deployments Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ result: 'error', reason: 'Undeploy fehlgeschlagen' });
    }

    // Map errorClasses to HTTP status
    if (result.result !== 'ok') {
      const { errorClass, reason } = result;
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `deploy:remove:${vpsId}:${hostname}:failed:${errorClass ?? 'error'}`,
        });
      } catch { /* ignore */ }

      if (errorClass === 'protected-resource') {
        return res.status(422).json({ result: 'error', reason: 'protected-resource' });
      }
      if (errorClass === 'confirmation-required') {
        return res.status(422).json({ result: 'error', reason: 'confirmation-required' });
      }
      return res.status(502).json({ result: 'error', reason: sanitizeMsg(reason ?? 'Undeploy fehlgeschlagen') });
    }

    // Outcome-audit success
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `deploy:remove:${vpsId}:${hostname}:${imageForAudit}:success`,
      });
    } catch { /* ignore */ }

    return res.status(200).json(result);
  });

  // ── POST /api/deployments/reconcile ──────────────────────────────────────
  // NOTE: This route MUST be registered before DELETE /api/deployments/:vps/:hostname
  // to avoid Express matching "reconcile" as a :vps param.
  // (It is registered here, after the above, relying on specificity — express 4/5 matches
  //  exact paths before parameterised ones when the path is registered first.)

  /**
   * POST /api/deployments/reconcile
   * Manual reconcile trigger. Same logic as cron. Produces a ReconcileReport (AC2).
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC2/AC8/AC9).
   *
   * Response: { result: "ok"|"error", report? }
   */
  router.post('/api/deployments/reconcile', async (req, res) => {
    if (!reconciliationJob) {
      return res.status(503).json({ result: 'error', reason: 'ReconciliationJob nicht konfiguriert' });
    }

    const identity = req.identity ?? null;

    // AC2: Identitäts-/Rollenschutz (same as deploy mutations)
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Audit-First (AC9)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: 'reconcile:manual-trigger',
      });
    } catch (auditErr) {
      console.error('[deploymentsRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      const report = await reconciliationJob.reconcile('manual');
      if (report === null) {
        // Skip-if-running
        return res.status(200).json({ result: 'ok', reason: 'already-running' });
      }
      return res.status(200).json({ result: 'ok', report });
    } catch (err) {
      console.error('[deploymentsRouter] POST /api/deployments/reconcile Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ result: 'error', reason: 'Reconciliation fehlgeschlagen' });
    }
  });

  // ── GET /api/deployments/reconcile/last ───────────────────────────────────

  /**
   * GET /api/deployments/reconcile/last
   * Returns the last ReconcileReport, or {} if none (AC8).
   * Hinter Access.
   */
  router.get('/api/deployments/reconcile/last', (_req, res) => {
    if (!reconciliationJob) {
      return res.json({});
    }
    const report = reconciliationJob.getLastReport();
    return res.json(report ?? {});
  });

  // ── GET /api/deployments/reconcile/reports ────────────────────────────────

  /**
   * GET /api/deployments/reconcile/reports?limit=N
   * Returns the last N ReconcileReports (AC8).
   * Hinter Access.
   */
  router.get('/api/deployments/reconcile/reports', (req, res) => {
    if (!reconciliationJob) {
      return res.json([]);
    }
    const limitRaw = req.query.limit;
    const limit = Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
      ? Math.min(Number(limitRaw), 100)
      : 20;
    const reports = reconciliationJob.getReports(limit);
    return res.json(reports);
  });

  // ── GET /api/deployments/reconcile/notices ────────────────────────────────

  /**
   * GET /api/deployments/reconcile/notices?limit=N
   * Returns the last N ReconcileNotices (AC8b).
   * Hinter Access.
   */
  router.get('/api/deployments/reconcile/notices', (req, res) => {
    if (!reconciliationJob) {
      return res.json([]);
    }
    const limitRaw = req.query.limit;
    const limit = Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
      ? Math.min(Number(limitRaw), 200)
      : 50;
    const notices = reconciliationJob.getNotices(limit);
    return res.json(notices);
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Remove token-like patterns from error messages before logging.
 * Tokens/keys MUST NOT appear in console logs (security/R01).
 *
 * @param {string} msg
 * @returns {string}
 */
function sanitizeMsg(msg) {
  if (typeof msg !== 'string') return 'unbekannter Fehler';
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY[\s\S]*?END (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY/gi, '[KEY REDACTED]')
    .slice(0, 300);
}
