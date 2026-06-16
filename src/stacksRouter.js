/**
 * stacksRouter — Express-Router für Stack-Registry CRUD (AC1/AC2) +
 *               Stack-Deploy/Undeploy/Status (AC6–AC11, stack-deploy-orchestration).
 *
 * Pfad-Kollisions-Auflösung (AC8, Item C):
 *   `DELETE /api/deployments/stacks/:stackName` bleibt der Registry-DELETE
 *   (löscht nur den Registry-Eintrag, KEIN composeDown, KEINE Route-Entfernung).
 *   Stack-Undeploy (Compose-Down + Routen-Entfernung) liegt auf einem eigenen Sub-Pfad:
 *     DELETE /api/deployments/stacks/:stackName/undeploy  (AC8, Body: { confirm: "<stackName>" })
 *   Diese Trennung ist trennscharf, rückwärtskompatibel mit den #160-Tests und folgt
 *   Spec-Option (a): "coder finalisiert ob eigener Sub-Pfad z.B. /undeploy".
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/deployments/stacks                         → { stacks: StackDefinition[] }
 *   GET    /api/deployments/stacks/:stackName              → StackDefinition | 404
 *   POST   /api/deployments/stacks                         → { stackName, updatedAt }   [MUTATION]
 *   PUT    /api/deployments/stacks/:stackName              → { stackName, updatedAt }   [MUTATION]
 *   DELETE /api/deployments/stacks/:stackName              → { stackName, status: "deleted" }  [MUTATION/Registry]
 *   POST   /api/deployments/stacks/:stackName/deploy       → { result, stack? }         [MUTATION/AC6]
 *   DELETE /api/deployments/stacks/:stackName/undeploy     → { result, reason? }        [MUTATION/AC8]
 *   GET    /api/deployments/stacks/:stackName/status       → StackStatus               [AC9]
 *
 * Security (AC2/AC11 — stack-deploy-orchestration.md):
 *   - Alle /api/deployments/stacks/* hinter AccessGuard (server.js — alle /api/* sind geschützt).
 *   - Mutierende Aktionen (POST, PUT, DELETE) zusätzlich identitäts-/rollengeschützt
 *     (gleiche CRED_ADMIN_EMAILS-Logik wie credentialsRouter/deploymentsRouter/vpsRouter).
 *   - Audit-First: Audit-Eintrag VOR jeder Mutation; schlägt Audit fehl → Aktion unterbleibt.
 *   - Eingaben (stackName, repoUrl, branch, Pfade, hostnames) validiert (AC2/AC11).
 *   - secretsSpec enthält nur Secret-NAMEN, keine Werte — niemals in Response/Audit (AC1).
 *   - Keine App-Boot-Secrets, SSH-Key oder CF-Token in Response, Log, Audit, WS (AC11).
 *
 * @module stacksRouter
 */

import { Router } from 'express';
import { validateStackName, validateStackDefinition } from './StackRegistry.js';
import { toExternalBackup } from './CredentialStore.js';

// ── Authz-Helper (gleiche Logik wie credentialsRouter / deploymentsRouter / vpsRouter) ─────

/**
 * Prüft ob die anfragende Identität mutieren darf (CRED_ADMIN_EMAILS-Logik, AC2).
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

// ── Router Factory ─────────────────────────────────────────────────────────────

/**
 * Erstellt den Stack-Registry-Router inkl. Deploy/Undeploy/Status (AC6–AC11).
 *
 * @param {import('./StackRegistry.js').StackRegistry} stackRegistry
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {object} [opts]
 * @param {import('./deploy/StackDeployOrchestrator.js').StackDeployOrchestrator} [opts.stackDeployOrchestrator]
 *   Orchestrator für Deploy/Undeploy/Status; optional — fehlt er, liefern diese Endpoints 503.
 * @param {Map<string, object>} [opts.vpsTargets]
 *   VPS-Target-Map (vpsId → VpsTarget); wird für VPS-Auflösung aus stackDef.vps verwendet.
 * @returns {import('express').Router}
 */
export function stacksRouter(stackRegistry, auditStore, { stackDeployOrchestrator, vpsTargets } = {}) {
  const router = Router();

  // ── GET /api/deployments/stacks ──────────────────────────────────────────────

  /**
   * GET /api/deployments/stacks
   * Listet alle registrierten Stack-Definitionen.
   * Hinter Access (kein Rollen-Check für Lesen).
   *
   * Responses:
   *   200 { stacks: StackDefinition[] }
   *   500 { error: string }
   */
  router.get('/api/deployments/stacks', async (req, res) => {
    try {
      const stacks = await stackRegistry.list();
      return res.json({ stacks });
    } catch (err) {
      console.error('[stacksRouter] GET /api/deployments/stacks Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht erreichbar' });
    }
  });

  // ── GET /api/deployments/stacks/:stackName ───────────────────────────────────

  /**
   * GET /api/deployments/stacks/:stackName
   * Liest eine einzelne Stack-Definition.
   * Hinter Access (kein Rollen-Check für Lesen).
   *
   * Responses:
   *   200 StackDefinition
   *   404 { error: string }  — nicht vorhanden
   *   422 { error: string }  — ungültiger stackName
   *   500 { error: string }
   */
  router.get('/api/deployments/stacks/:stackName', async (req, res) => {
    const nameVal = validateStackName(req.params.stackName);
    if (!nameVal.ok) {
      return res.status(422).json({ error: nameVal.error });
    }

    try {
      const def = await stackRegistry.get(req.params.stackName);
      if (!def) {
        return res.status(404).json({ error: `Stack '${req.params.stackName}' nicht in der Registry` });
      }
      return res.json(def);
    } catch (err) {
      console.error('[stacksRouter] GET /api/deployments/stacks/:stackName Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht erreichbar' });
    }
  });

  // ── POST /api/deployments/stacks ─────────────────────────────────────────────

  /**
   * POST /api/deployments/stacks
   * Legt eine neue Stack-Definition an (schlägt fehl wenn stackName bereits existiert).
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC2).
   *
   * Body: StackDefinition (stackName, repoUrl, branch, composeFile, overrideFile?,
   *                         vps, publicServices, tunnelId, secretsSpec?)
   *
   * Responses:
   *   201 { stackName, updatedAt }
   *   400 { error }  — Validierungsfehler
   *   403 { error }  — keine Berechtigung
   *   409 { error }  — stackName bereits vorhanden
   *   500 { error }  — Audit-Write fehlgeschlagen / Store nicht schreibbar
   */
  router.post('/api/deployments/stacks', async (req, res) => {
    const identity = req.identity ?? null;

    // AC2: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Eingabe validieren (AC2)
    const bodyVal = validateStackDefinition(req.body);
    if (!bodyVal.ok) {
      return res.status(400).json({ error: bodyVal.error });
    }
    const { def } = bodyVal;

    // Existenz-Prüfung vor Audit (kein Audit-Eintrag für ungültige Anfragen)
    let existing;
    try {
      existing = await stackRegistry.get(def.stackName);
    } catch (err) {
      console.error('[stacksRouter] POST Stack-Registry-Lese-Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht erreichbar' });
    }
    if (existing) {
      return res.status(409).json({ error: `Stack '${def.stackName}' existiert bereits. PUT zum Überschreiben verwenden.` });
    }

    // AC2: Audit-First — VOR der Mutation; secretsSpec-Werte NICHT im Audit (AC1)
    const auditAction = `stack:create:${def.stackName}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[stacksRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      const result = await stackRegistry.set(def);
      // S-1: localPath (interner Volume-Pfad) aus HTTP-Response filtern
      return res.status(201).json({
        stackName: def.stackName,
        updatedAt: result.updatedAt,
        ...(result.backup ? { backup: toExternalBackup(result.backup) } : {}),
      });
    } catch (err) {
      console.error('[stacksRouter] POST Stack-Registry-Schreib-Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht schreibbar' });
    }
  });

  // ── PUT /api/deployments/stacks/:stackName ────────────────────────────────────

  /**
   * PUT /api/deployments/stacks/:stackName
   * Überschreibt eine vorhandene Stack-Definition (oder legt sie an falls nicht vorhanden).
   * Der stackName im URL-Parameter und im Body müssen übereinstimmen.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC2).
   *
   * Body: StackDefinition (stackName muss mit :stackName übereinstimmen)
   *
   * Responses:
   *   200 { stackName, updatedAt }
   *   400 { error }  — Validierungsfehler / Name-Konflikt
   *   403 { error }  — keine Berechtigung
   *   500 { error }  — Audit-Write fehlgeschlagen / Store nicht schreibbar
   */
  router.put('/api/deployments/stacks/:stackName', async (req, res) => {
    const identity = req.identity ?? null;

    // AC2: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // URL-Parameter validieren
    const nameVal = validateStackName(req.params.stackName);
    if (!nameVal.ok) {
      return res.status(422).json({ error: nameVal.error });
    }

    // Body validieren
    const bodyVal = validateStackDefinition(req.body);
    if (!bodyVal.ok) {
      return res.status(400).json({ error: bodyVal.error });
    }
    const { def } = bodyVal;

    // stackName im Body muss mit URL-Parameter übereinstimmen
    if (def.stackName !== req.params.stackName) {
      return res.status(400).json({ error: 'stackName im Body muss mit dem URL-Parameter übereinstimmen' });
    }

    // AC2: Audit-First — VOR der Mutation
    const auditAction = `stack:update:${def.stackName}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[stacksRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      const result = await stackRegistry.set(def);
      // S-1: localPath (interner Volume-Pfad) aus HTTP-Response filtern
      return res.json({
        stackName: def.stackName,
        updatedAt: result.updatedAt,
        ...(result.backup ? { backup: toExternalBackup(result.backup) } : {}),
      });
    } catch (err) {
      console.error('[stacksRouter] PUT Stack-Registry-Schreib-Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht schreibbar' });
    }
  });

  // ── DELETE /api/deployments/stacks/:stackName ─────────────────────────────────

  /**
   * DELETE /api/deployments/stacks/:stackName
   * Löscht eine Stack-Definition aus der Registry. Idempotent.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC2).
   *
   * HINWEIS: Dieser Endpunkt löscht nur den Registry-Eintrag — NICHT den laufenden Stack.
   * Stack-Undeploy (compose down + Routen entfernen) wird in Item C (AC8) implementiert.
   *
   * Responses:
   *   200 { stackName, status: "deleted" }
   *   403 { error }  — keine Berechtigung
   *   404 { error }  — nicht vorhanden
   *   422 { error }  — ungültiger stackName
   *   500 { error }  — Audit-Write fehlgeschlagen / Store nicht schreibbar
   */
  router.delete('/api/deployments/stacks/:stackName', async (req, res) => {
    const identity = req.identity ?? null;

    // AC2: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // URL-Parameter validieren
    const nameVal = validateStackName(req.params.stackName);
    if (!nameVal.ok) {
      return res.status(422).json({ error: nameVal.error });
    }

    const { stackName } = req.params;

    // Existenz-Prüfung (404 wenn nicht vorhanden)
    let existing;
    try {
      existing = await stackRegistry.get(stackName);
    } catch (err) {
      console.error('[stacksRouter] DELETE Stack-Registry-Lese-Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht erreichbar' });
    }
    if (!existing) {
      return res.status(404).json({ error: `Stack '${stackName}' nicht in der Registry` });
    }

    // AC2: Audit-First — VOR der Mutation
    const auditAction = `stack:delete:${stackName}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[stacksRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      const result = await stackRegistry.delete(stackName);
      // S-1: localPath (interner Volume-Pfad) aus HTTP-Response filtern
      return res.json({
        stackName,
        status: 'deleted',
        ...(result?.backup ? { backup: toExternalBackup(result.backup) } : {}),
      });
    } catch (err) {
      console.error('[stacksRouter] DELETE Stack-Registry-Schreib-Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht schreibbar' });
    }
  });

  // ── POST /api/deployments/stacks/:stackName/deploy ────────────────────────────

  /**
   * POST /api/deployments/stacks/:stackName/deploy
   * Stack-Deploy-Saga: syncRepo → ensureEnv → composeUp → Route je öffentlichem Service.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC6, AC11).
   *
   * Responses:
   *   200 { result: "ok", stack }
   *   422 { result: "error", reason: "protected-resource" }   — LockoutGuard (AC10)
   *   422 { error }  — ungültiger stackName
   *   404 { error }  — Stack nicht in Registry
   *   403 { error }  — keine Berechtigung
   *   500 { error }  — Audit-Write fehlgeschlagen
   *   503 { error }  — Orchestrator nicht konfiguriert
   *   502 { result: "error", reason }  — SSH/Cloudflare-Fehler
   */
  router.post('/api/deployments/stacks/:stackName/deploy', async (req, res) => {
    if (!stackDeployOrchestrator) {
      return res.status(503).json({ error: 'StackDeployOrchestrator nicht konfiguriert' });
    }

    const identity = req.identity ?? null;

    // AC11: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // URL-Parameter validieren
    const nameVal = validateStackName(req.params.stackName);
    if (!nameVal.ok) {
      return res.status(422).json({ error: nameVal.error });
    }
    const { stackName } = req.params;

    // Stack aus Registry laden
    let stackDef;
    try {
      stackDef = await stackRegistry.get(stackName);
    } catch (err) {
      console.error('[stacksRouter] POST deploy — Registry-Lese-Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht erreichbar' });
    }
    if (!stackDef) {
      return res.status(404).json({ error: `Stack '${stackName}' nicht in der Registry` });
    }

    // VPS-Auflösung: stackDef.vps ist ein vpsId-String → VpsTarget via vpsTargets-Map
    const vpsTarget = vpsTargets ? vpsTargets.get(stackDef.vps) : undefined;
    if (!vpsTarget) {
      return res.status(422).json({ error: `Unbekannter oder nicht konfigurierter VPS: ${stackDef.vps}` });
    }

    // AC11: Audit-First — Eintrag VOR der Mutation; kein Secret im Audit
    const auditAction = `stack:deploy:${stackName}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[stacksRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Deploy-Saga ausführen
    let result;
    try {
      result = await stackDeployOrchestrator.deploy({ vps: vpsTarget, stackDef });
    } catch (err) {
      console.error('[stacksRouter] POST deploy — Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ result: 'error', reason: 'Deploy fehlgeschlagen' });
    }

    if (result.result !== 'ok') {
      const { errorClass } = result;
      if (errorClass === 'protected-resource') {
        return res.status(422).json({ result: 'error', reason: 'protected-resource' });
      }
      if (errorClass === 'validation-error') {
        return res.status(400).json({ result: 'error', reason: sanitizeMsg(result.reason) });
      }
      return res.status(502).json({ result: 'error', reason: sanitizeMsg(result.reason ?? 'Deploy fehlgeschlagen') });
    }

    return res.status(200).json(result);
  });

  // ── DELETE /api/deployments/stacks/:stackName/undeploy ───────────────────────

  /**
   * DELETE /api/deployments/stacks/:stackName/undeploy
   * Stack-Undeploy: Alle Routen entfernen → composeDown (Volumes behalten).
   * MUTATION: Audit-First + Identitäts-/Rollenschutz + type-to-confirm (AC8, AC10, AC11).
   *
   * Body: { confirm: "<stackName>" }  — muss dem stackName entsprechen (AC8)
   *
   * Responses:
   *   200 { result: "ok" }
   *   422 { result: "error", reason: "confirmation-required" }  — kein/falsches confirm (AC8)
   *   422 { result: "error", reason: "protected-resource" }     — LockoutGuard (AC10)
   *   422 { error }  — ungültiger stackName
   *   404 { error }  — Stack nicht in Registry
   *   403 { error }  — keine Berechtigung
   *   500 { error }  — Audit-Write fehlgeschlagen
   *   503 { error }  — Orchestrator nicht konfiguriert
   *   502 { result: "error", reason }  — SSH/Cloudflare-Fehler
   */
  router.delete('/api/deployments/stacks/:stackName/undeploy', async (req, res) => {
    if (!stackDeployOrchestrator) {
      return res.status(503).json({ error: 'StackDeployOrchestrator nicht konfiguriert' });
    }

    const identity = req.identity ?? null;

    // AC11: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // URL-Parameter validieren
    const nameVal = validateStackName(req.params.stackName);
    if (!nameVal.ok) {
      return res.status(422).json({ error: nameVal.error });
    }
    const { stackName } = req.params;

    // AC8: confirm aus Body
    const confirm = req.body?.confirm;

    // Stack aus Registry laden
    let stackDef;
    try {
      stackDef = await stackRegistry.get(stackName);
    } catch (err) {
      console.error('[stacksRouter] DELETE undeploy — Registry-Lese-Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht erreichbar' });
    }
    if (!stackDef) {
      return res.status(404).json({ error: `Stack '${stackName}' nicht in der Registry` });
    }

    // VPS-Auflösung
    const vpsTarget = vpsTargets ? vpsTargets.get(stackDef.vps) : undefined;
    if (!vpsTarget) {
      return res.status(422).json({ error: `Unbekannter oder nicht konfigurierter VPS: ${stackDef.vps}` });
    }

    // AC8: type-to-confirm — confirm muss stackName entsprechen (VOR Audit-First, denn
    // ungültige Anfragen bekommen keinen Audit-Eintrag)
    if (!confirm || confirm !== stackName) {
      return res.status(422).json({ result: 'error', reason: 'confirmation-required' });
    }

    // AC11: Audit-First — Eintrag VOR der Mutation; kein Secret im Audit
    const auditAction = `stack:undeploy:${stackName}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[stacksRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Undeploy ausführen (bestätigter confirm wird an Orchestrator weitergegeben)
    let result;
    try {
      result = await stackDeployOrchestrator.undeploy({ vps: vpsTarget, stackDef, confirm });
    } catch (err) {
      console.error('[stacksRouter] DELETE undeploy — Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ result: 'error', reason: 'Undeploy fehlgeschlagen' });
    }

    if (result.result !== 'ok') {
      const { errorClass } = result;
      if (errorClass === 'protected-resource') {
        return res.status(422).json({ result: 'error', reason: 'protected-resource' });
      }
      if (errorClass === 'confirmation-required') {
        return res.status(422).json({ result: 'error', reason: 'confirmation-required' });
      }
      return res.status(502).json({ result: 'error', reason: sanitizeMsg(result.reason ?? 'Undeploy fehlgeschlagen') });
    }

    return res.status(200).json(result);
  });

  // ── GET /api/deployments/stacks/:stackName/status ─────────────────────────────

  /**
   * GET /api/deployments/stacks/:stackName/status
   * Live-Status: composePs ⊕ Routen je öffentlichem Hostname; Drift-Flags (AC9).
   * Hinter Access (kein Rollen-Check für Status-Lesen).
   *
   * Responses:
   *   200 StackStatus
   *   422 { error }  — ungültiger stackName
   *   404 { error }  — Stack nicht in Registry
   *   422 { error }  — VPS nicht konfiguriert
   *   503 { error }  — Orchestrator nicht konfiguriert
   *   502 { error }  — SSH/Cloudflare-Fehler
   */
  router.get('/api/deployments/stacks/:stackName/status', async (req, res) => {
    if (!stackDeployOrchestrator) {
      return res.status(503).json({ error: 'StackDeployOrchestrator nicht konfiguriert' });
    }

    // URL-Parameter validieren
    const nameVal = validateStackName(req.params.stackName);
    if (!nameVal.ok) {
      return res.status(422).json({ error: nameVal.error });
    }
    const { stackName } = req.params;

    // Stack aus Registry laden
    let stackDef;
    try {
      stackDef = await stackRegistry.get(stackName);
    } catch (err) {
      console.error('[stacksRouter] GET status — Registry-Lese-Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht erreichbar' });
    }
    if (!stackDef) {
      return res.status(404).json({ error: `Stack '${stackName}' nicht in der Registry` });
    }

    // VPS-Auflösung
    const vpsTarget = vpsTargets ? vpsTargets.get(stackDef.vps) : undefined;
    if (!vpsTarget) {
      return res.status(422).json({ error: `Unbekannter oder nicht konfigurierter VPS: ${stackDef.vps}` });
    }

    try {
      const statusObj = await stackDeployOrchestrator.status({ vps: vpsTarget, stackDef });
      return res.status(200).json(statusObj);
    } catch (err) {
      console.error('[stacksRouter] GET status — Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ error: 'Stack-Status konnte nicht abgerufen werden' });
    }
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Entfernt Token-ähnliche Muster aus Fehlermeldungen (security/R01).
 * Konsistent mit deploymentsRouter/vpsRouter sanitizeMsg.
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
