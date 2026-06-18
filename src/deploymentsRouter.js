/**
 * deploymentsRouter — Express-Router für Deploy-Lifecycle (AC3–AC9, ADR-012)
 *                     + Reconciliation-Endpunkte (AC2/AC8/AC8b, ADR-013)
 *                     + Lokaler Image-Test (S-156, AC1–AC5).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/deployments                          → { deployments: Deployment[], errors? }
 *   POST   /api/deployments                          → { result, deployment?, reason? }   [MUTATION]
 *   DELETE /api/deployments/:vps/:hostname           → { result, reason? }               [MUTATION]
 *   POST   /api/deployments/reconcile                → { result, report? }               [MUTATION]
 *   GET    /api/deployments/reconcile/last           → ReconcileReport | {}
 *   GET    /api/deployments/reconcile/reports        → ReconcileReport[]
 *   GET    /api/deployments/reconcile/notices        → ReconcileNotice[]
 *   POST   /api/deployments/local-test               → { result, report? }               [MUTATION, S-156]
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

// ── Local-Test Validation (S-156, AC5) ────────────────────────────────────────

/**
 * ghcr image reference: letters, digits, dots, underscores, forward slashes, colons, hyphens.
 * No shell metacharacters (AC5).
 */
const IMAGE_RE = /^[A-Za-z0-9._/:@-]+$/;

/** Maximum image reference length. */
const MAX_IMAGE_LEN = 512;

/**
 * Tag: letters, digits, dots, underscores, hyphens — no shell metacharacters (AC5).
 */
const TAG_RE = /^[A-Za-z0-9._-]+$/;

/** Maximum tag length. */
const MAX_TAG_LEN = 128;

/**
 * Validates POST /api/deployments/local-test body (AC5).
 *
 * @param {unknown} body
 * @returns {{ ok: boolean, params?: { image: string, tag: string }, error?: string }}
 */
function validateLocalTestBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request-Body ist Pflicht' };
  }
  const { image, tag } = body;

  if (typeof image !== 'string' || !image.trim()) {
    return { ok: false, error: 'image ist ein Pflichtfeld' };
  }
  if (image.trim().length > MAX_IMAGE_LEN) {
    return { ok: false, error: `image überschreitet Längenlimit (max. ${MAX_IMAGE_LEN})` };
  }
  if (!IMAGE_RE.test(image.trim())) {
    return { ok: false, error: 'image enthält ungültige Zeichen (nur ghcr-Referenz-Zeichensatz erlaubt)' };
  }

  if (typeof tag !== 'string' || !tag.trim()) {
    return { ok: false, error: 'tag ist ein Pflichtfeld' };
  }
  if (tag.trim().length > MAX_TAG_LEN) {
    return { ok: false, error: `tag überschreitet Längenlimit (max. ${MAX_TAG_LEN})` };
  }
  if (!TAG_RE.test(tag.trim())) {
    return { ok: false, error: 'tag enthält ungültige Zeichen (nur alphanumerisch, Punkte, Bindestriche, Unterstriche)' };
  }

  return { ok: true, params: { image: image.trim(), tag: tag.trim() } };
}

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

// ── Vereinigte VPS-Ziel-Auflösung (AC9) ──────────────────────────────────────

/**
 * Löst eine vpsId zur vereinigten VpsTarget-Quelle (Env-Map ⊕ dynamische Records) auf.
 *
 * Strategie (AC9, identisch zu vps-targets-Listing AC3 + resolveVpsTarget AC4):
 *   1. Env-Map (vpsTargets): direkter Key-Lookup → Env gewinnt bei Kollision.
 *   2. Dynamische Records (vpsRegistry.listTargetRecords()): exakter _vpsId-Match.
 *      Ist host null/veraltet, wird er über getMachineIp aufgefrischt (AC2-Analogie).
 *   3. Kein Treffer → undefined (→ 422 "Unbekannter VPS: <vpsId>").
 *
 * Security (AC8): kein SSH-Key, kein Tunnel-Token in der Rückgabe (nur host/port/targetUser).
 * Die 422-Fehlermeldung enthält nur die vpsId, kein host/targetUser/Key.
 *
 * @param {string} vpsId - sanitisierter VPS-Name aus Request
 * @param {Map<string, { host: string, port?: number, targetUser: string }>} vpsTargets
 * @param {import('./vps/VpsProviderRegistry.js').VpsProviderRegistry|undefined} vpsRegistry
 * @returns {Promise<{ host: string, port: number, targetUser: string } | undefined>}
 */
async function resolveVpsIdToTarget(vpsId, vpsTargets, vpsRegistry) {
  // ── 1. Env-Map: Env gewinnt bei Kollision (Override/Fallback) ──
  const envTarget = vpsTargets.get(vpsId);
  if (envTarget) {
    return { host: envTarget.host, port: envTarget.port ?? 22, targetUser: envTarget.targetUser };
  }

  // ── 2. Dynamische Records (vpsRegistry) ──
  if (vpsRegistry && typeof vpsRegistry.listTargetRecords === 'function') {
    try {
      const records = await vpsRegistry.listTargetRecords();
      const match = records.find((r) => r._vpsId === vpsId);
      if (match) {
        // Host aus Record; bei null/leer über getMachineIp auffrischen (AC2-Analogie)
        let host = match.host ?? null;
        if (!host && typeof vpsRegistry.getMachineIp === 'function') {
          try {
            host = await vpsRegistry.getMachineIp(match.provider, match.serverId);
          } catch {
            // Degradierend — IP-Refresh fehlgeschlagen; host bleibt null
          }
        }
        if (host) {
          // Security-Floor (AC8): nur Verbindungs-Metadaten, kein Key/Token
          return { host, port: match.port ?? 22, targetUser: match.targetUser ?? 'root' };
        }
        // host nicht auflösbar (kein Host in Record und getMachineIp fehlgeschlagen):
        // kein Ziel lieferbar → undefined (→ 422), kein Crash
      }
    } catch {
      // Degradierend — Store-Fehler bei listTargetRecords → kein Ziel via dynamische Quelle
    }
  }

  // ── 3. Keine Quelle kennt die vpsId → undefined (→ 422) ──
  return undefined;
}

// ── Router Factory ─────────────────────────────────────────────────────────────

/**
 * Creates the deployments router.
 *
 * @param {import('./deploy/DeployOrchestrator.js').DeployOrchestrator} orchestrator
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {Map<string, object>} vpsTargets - map of vpsId → VpsTarget { host, port?, targetUser }
 * @param {import('./deploy/ReconciliationJob.js').ReconciliationJob} [reconciliationJob]
 * @param {import('./deploy/LocalDockerControl.js').LocalDockerControl} [localDockerControl]
 * @param {import('./vps/VpsProviderRegistry.js').VpsProviderRegistry} [vpsRegistry]
 *   Optionale Registry-Referenz für dynamische VPS-Ziel-Auflösung (S-167 AC3, S-169 AC9).
 *   Wenn gesetzt: dynamisch angelegte VPS erscheinen zusätzlich zur Env im Dropdown
 *   und sind über Deploy/Undeploy/Listing auflösbar.
 *   Env gewinnt bei Kollision (Override/Fallback).
 * @returns {import('express').Router}
 */
export function deploymentsRouter(orchestrator, auditStore, vpsTargets, reconciliationJob, localDockerControl, vpsRegistry) {
  const router = Router();

  // ── GET /api/deployments/vps-targets ────────────────────────────────────
  // Returns the unified list of VPS IDs (dynamisch ⊕ Env) for the frontend dropdown.
  // S-167 AC3: dynamisch angelegte VPS + VPS_TARGETS-Env; Env gewinnt bei Kollision.
  // Read-only — no mutation, no secrets (only IDs, no host/user/key exposed — AC8).
  router.get('/api/deployments/vps-targets', async (_req, res) => {
    // Env-IDs als Override-Menge (Env gewinnt bei Kollision)
    const envIds = new Set(vpsTargets.keys());

    // Dynamische IDs aus persistierten Target-Records (S-167 AC3)
    // _vpsId = sanitisierter VPS-Name (aus CredentialStore-Schlüssel abgeleitet)
    const dynamicIds = new Set();
    if (vpsRegistry && typeof vpsRegistry.listTargetRecords === 'function') {
      try {
        const records = await vpsRegistry.listTargetRecords();
        for (const record of records) {
          if (record._vpsId) dynamicIds.add(record._vpsId);
        }
      } catch {
        // Degradierend: Quell-Fehler → nur Env-IDs zurückliefern (kein Crash)
      }
    }

    // Vereinigung: Env-IDs zuerst, dann dynamische IDs die noch nicht vorhanden sind
    // (Env gewinnt bei Kollision — gleicher _vpsId → Env-Eintrag bleibt)
    const ids = [...envIds];
    for (const id of dynamicIds) {
      if (!envIds.has(id)) ids.push(id);
    }

    // Security-Floor (AC8): nur IDs — kein host/user/key in der Response
    return res.json({ vpsIds: ids });
  });

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

    // AC9: Vereinigte Auflösung (Env-Map ⊕ dynamische Records, Env gewinnt bei Kollision)
    const vpsTarget = await resolveVpsIdToTarget(vpsId.trim(), vpsTargets, vpsRegistry);
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

    // AC9: Vereinigte Auflösung (Env-Map ⊕ dynamische Records, Env gewinnt bei Kollision)
    const vpsTarget = await resolveVpsIdToTarget(vpsId, vpsTargets, vpsRegistry);
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

    // AC9: Vereinigte Auflösung (Env-Map ⊕ dynamische Records, Env gewinnt bei Kollision)
    const vpsTarget = await resolveVpsIdToTarget(vpsId, vpsTargets, vpsRegistry);
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

  // ── POST /api/deployments/local-test ─────────────────────────────────────
  // S-156: Lokaler Image-Test vor VPS-Deploy.
  // MUTATION: Audit-First + Identitäts-/Rollenschutz (AC5).
  // MUSS vor /api/deployments/:vps/:hostname registriert sein (Express matcht "local-test" sonst als :vps).

  /**
   * POST /api/deployments/local-test
   * Lokaler Probe-Lauf: Image lokal pullen → kurzlebigen Container starten →
   * Start-Status + ExposedPorts (docker inspect) → Best-Effort HTTP-Reachability →
   * Container immer entfernen (rm -f, try/finally, AC4).
   *
   * Body: { image, tag }
   *
   * Responses:
   *   200 { result: "ok", report: LocalTestReport }
   *   400 { error }        — Validierungsfehler (image/tag ungültig)
   *   403 { error }        — nicht in CRED_ADMIN_EMAILS oder AccessGuard-Block
   *   500 { error }        — Audit-Write fehlgeschlagen
   *   502 { result: "error", reason }  — Pull/Start-Fehler oder Docker unerreichbar
   */
  router.post('/api/deployments/local-test', async (req, res) => {
    const identity = req.identity ?? null;

    // AC5: Identitäts-/Rollenschutz (analog Deploy-Mutationen)
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // AC5: Input-Validierung vor Docker-Sink
    const bodyVal = validateLocalTestBody(req.body);
    if (!bodyVal.ok) {
      return res.status(400).json({ error: bodyVal.error });
    }
    const { image, tag } = bodyVal.params;

    // AC5: Audit-First — Eintrag VOR Pull/Start; schlägt Audit fehl → keine Aktion
    const auditAction = `local-test:${image}:${tag}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[deploymentsRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Prüfen ob LocalDockerControl verfügbar
    if (!localDockerControl) {
      return res.status(502).json({ result: 'error', reason: 'Lokaler Docker-Zugriff nicht konfiguriert' });
    }

    // Probe-Lauf (AC2, AC3, AC4 — rm -f in LocalDockerControl try/finally garantiert)
    try {
      const report = await localDockerControl.runProbe(image, tag);
      return res.status(200).json({ result: 'ok', report });
    } catch (err) {
      // Pull-Fehler, Start-Fehler oder Docker unerreichbar → 502 (kein Leak)
      const reason = sanitizeMsg(err?.message ?? 'Probe-Lauf fehlgeschlagen');
      console.error('[deploymentsRouter] POST /api/deployments/local-test Fehler:', reason);
      return res.status(502).json({ result: 'error', reason });
    }
  });

  // ── POST /api/deployments/reconcile ──────────────────────────────────────
  // NOTE: Die GET /api/deployments/reconcile/*-Routen (reconcile/last, reconcile/reports,
  // reconcile/notices) sowie POST /api/deployments/reconcile müssen vor einem etwaigen
  // künftigen GET /:vps/:hostname registriert werden, damit Express "reconcile" nicht als
  // :vps-Parameter matcht. POST und DELETE konkurrieren NICHT (verschiedene HTTP-Methoden).

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
