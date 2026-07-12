/**
 * bitwardenDeployAccessRouter — Express-Router für den unbeaufsichtigten
 * Bitwarden-Deploy-Zugang (Variante B, Spec docs/specs/deploy-bitwarden-gpg-injection.md).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/settings/deploy-access          → Status (write-only: set/updatedAt + ready)
 *   PUT    /api/settings/deploy-access/:field   → Feld setzen/überschreiben   [MUTATION]
 *   DELETE /api/settings/deploy-access/:field   → Feld entfernen (idempotent) [MUTATION]
 *
 * Der Prüf-/Validierungs-Endpunkt (POST .../validate) kommt in S-332 hinzu
 * (braucht den Login-Dienst).
 *
 * Security (Spec S1/S4/S5):
 *   - Kein Klartext in Response/Log/Audit (write-only).
 *   - Jede Mutation → Audit-First (Identität, Feld, Aktion) OHNE Wert; Audit-Fail
 *     → Mutation unterbleibt.
 *   - Mutationen zusätzlich CRED_ADMIN_EMAILS-geschützt (gleiche Logik wie
 *     credentialsRouter/deploymentsRouter).
 *
 * @module bitwardenDeployAccessRouter
 */

import { Router } from 'express';
import { ACCESS_FIELDS } from './BitwardenDeployAccessStore.js';

/**
 * Mutations-Autorisierung (identisch zu credentialsRouter/ADR-007).
 * @param {import('./AccessGuard.js').Identity} identity
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

/** Klartext-Fehlermeldungen je Store-Fehlerklasse (kein Secret-Leak). */
const FIELD_ERROR_MESSAGES = {
  'unknown-field': 'Unbekanntes Zugangs-Feld',
  'empty-value': 'Feld "value" ist ein Pflichtfeld und darf nicht leer sein',
  'value-too-long': 'Wert überschreitet das zulässige Längenlimit',
};

/**
 * @param {import('./BitwardenDeployAccessStore.js').BitwardenDeployAccessStore} accessStore
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @returns {import('express').Router}
 */
export function bitwardenDeployAccessRouter(accessStore, auditStore) {
  const router = Router();

  /**
   * GET /api/settings/deploy-access
   * Write-only Status: je Feld { set, updatedAt } + aggregiertes ready + persisted.
   */
  router.get('/api/settings/deploy-access', async (_req, res) => {
    try {
      const status = await accessStore.getStatus();
      return res.json(status);
    } catch (err) {
      console.error('[bitwardenDeployAccessRouter] GET status failed:', err.message);
      return res.status(500).json({ error: 'Zugangs-Speicher nicht erreichbar' });
    }
  });

  /**
   * PUT /api/settings/deploy-access/:field   Body: { value: string }
   * Setzt/überschreibt genau ein Feld. Response enthält KEINEN Wert.
   */
  router.put('/api/settings/deploy-access/:field', async (req, res) => {
    const identity = req.identity ?? null;

    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { field } = req.params;
    if (!ACCESS_FIELDS.includes(field)) {
      return res.status(404).json({ error: 'Unbekanntes Zugangs-Feld' });
    }

    const { value } = req.body ?? {};
    if (typeof value !== 'string' || value.trim() === '') {
      return res.status(400).json({ error: 'Feld "value" ist ein Pflichtfeld und darf nicht leer sein' });
    }

    // Audit-First (OHNE Wert) — Spec S4.
    try {
      auditStore.record({ identity: identity?.email ?? null, command: `deploy-access:set:${field}` });
    } catch (auditErr) {
      console.error('[bitwardenDeployAccessRouter] Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      const meta = await accessStore.setField(field, value);
      return res.json({ field, ...meta });
    } catch (err) {
      const msg = FIELD_ERROR_MESSAGES[err.message];
      if (msg) {
        const code = err.message === 'value-too-long' ? 422 : err.message === 'unknown-field' ? 404 : 400;
        return res.status(code).json({ error: msg });
      }
      console.error('[bitwardenDeployAccessRouter] PUT set failed:', err.message);
      return res.status(500).json({ error: 'Zugangs-Speicher nicht schreibbar' });
    }
  });

  /**
   * DELETE /api/settings/deploy-access/:field
   * Entfernt genau ein Feld. Idempotent.
   */
  router.delete('/api/settings/deploy-access/:field', async (req, res) => {
    const identity = req.identity ?? null;

    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { field } = req.params;
    if (!ACCESS_FIELDS.includes(field)) {
      return res.status(404).json({ error: 'Unbekanntes Zugangs-Feld' });
    }

    try {
      auditStore.record({ identity: identity?.email ?? null, command: `deploy-access:delete:${field}` });
    } catch (auditErr) {
      console.error('[bitwardenDeployAccessRouter] Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      const meta = await accessStore.clearField(field);
      return res.json({ field, ...meta });
    } catch (err) {
      if (err.message === 'unknown-field') {
        return res.status(404).json({ error: 'Unbekanntes Zugangs-Feld' });
      }
      console.error('[bitwardenDeployAccessRouter] DELETE failed:', err.message);
      return res.status(500).json({ error: 'Zugangs-Speicher nicht schreibbar' });
    }
  });

  return router;
}
