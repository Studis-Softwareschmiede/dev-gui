/**
 * stacksRouter — Express-Router für Stack-Registry CRUD (AC1/AC2, stack-deploy-orchestration).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/deployments/stacks                  → { stacks: StackDefinition[] }
 *   GET    /api/deployments/stacks/:stackName       → StackDefinition | 404
 *   POST   /api/deployments/stacks                  → { stackName, updatedAt }   [MUTATION]
 *   PUT    /api/deployments/stacks/:stackName        → { stackName, updatedAt }   [MUTATION]
 *   DELETE /api/deployments/stacks/:stackName        → { stackName, status: "deleted" }  [MUTATION]
 *
 * KOLLISIONSHINWEIS für Item C (#162, AC8):
 *   `DELETE /api/deployments/stacks/:stackName` ist hier als Registry-DELETE implementiert
 *   (löscht nur den Registry-Eintrag, KEIN composeDown, KEINE Route-Entfernung).
 *   Item C implementiert Stack-Undeploy mit Body `{ confirm: "<stackName>" }` (AC8).
 *   Der #162-Coder MUSS diesen Endpunkt entweder:
 *     (a) durch einen eigenen Sub-Pfad trennen (z.B. DELETE /api/deployments/stacks/:stackName/undeploy),
 *         ODER
 *     (b) den bestehenden DELETE erweitern: Body `{ confirm }` vorhanden → Undeploy-Pfad,
 *         fehlender Body → Registry-DELETE (trennscharf per spec-deploy-orchestration.md Vertrag).
 *   Entscheidung liegt beim #162-Coder; dieses Item (A) lässt den Endpunkt offen
 *   (spec-deploy-orchestration.md: "coder finalisiert ob eigener Sub-Pfad z.B. /undeploy").
 *
 * Security (AC2 — stack-deploy-orchestration.md):
 *   - Alle /api/deployments/stacks/* hinter AccessGuard (server.js — alle /api/* sind geschützt).
 *   - Mutierende Aktionen (POST, PUT, DELETE) zusätzlich identitäts-/rollengeschützt
 *     (gleiche CRED_ADMIN_EMAILS-Logik wie credentialsRouter/deploymentsRouter/vpsRouter).
 *   - Audit-First: Audit-Eintrag VOR jeder Mutation; schlägt Audit fehl → Aktion unterbleibt.
 *   - Eingaben (stackName, repoUrl, branch, Pfade, hostnames) validiert (AC2).
 *   - secretsSpec enthält nur Secret-NAMEN, keine Werte — niemals in Response/Audit (AC1).
 *   - Keine Secrets in Response, Log, Audit, WS (AC1/AC2).
 *
 * @module stacksRouter
 */

import { Router } from 'express';
import { validateStackName, validateStackDefinition } from './StackRegistry.js';

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
 * Erstellt den Stack-Registry-Router.
 *
 * @param {import('./StackRegistry.js').StackRegistry} stackRegistry
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @returns {import('express').Router}
 */
export function stacksRouter(stackRegistry, auditStore) {
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
      return res.status(201).json({ stackName: def.stackName, updatedAt: result.updatedAt });
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
      return res.json({ stackName: def.stackName, updatedAt: result.updatedAt });
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
      await stackRegistry.delete(stackName);
      return res.json({ stackName, status: 'deleted' });
    } catch (err) {
      console.error('[stacksRouter] DELETE Stack-Registry-Schreib-Fehler:', sanitizeMsg(err?.message));
      return res.status(500).json({ error: 'Stack-Registry nicht schreibbar' });
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
