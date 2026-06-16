/**
 * credentialsRouter — Express-Router für Credential-Verwaltung (AC1–AC8).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/settings/credentials                    → Liste aller Felder (Metadaten, kein Klartext)
 *   PUT    /api/settings/credentials/:integration/:name → Setzen/Überschreiben
 *   DELETE /api/settings/credentials/:integration/:name → Löschen
 *
 * Security (ADR-007):
 *   - Kein Klartext in Responses, Logs oder Audit.
 *   - Jede Mutation → AuditStore-Eintrag (Identität, Feld-Key, Aktion).
 *   - Optionale Admin-Allowlist via CRED_ADMIN_EMAILS (AC7/ADR-007).
 *   - Eingabe-Validierung: Pflichtfelder, Längenlimit, erlaubte Chars (AC8).
 *
 * @module credentialsRouter
 */

import { Router } from 'express';
import { resolveKey, toExternalBackup } from './CredentialStore.js';

/**
 * Prüft ob die anfragende Identität mutieren darf (AC7/ADR-007).
 * Wenn CRED_ADMIN_EMAILS gesetzt: nur gelistete E-Mails.
 * Wenn nicht gesetzt: jede gültige Access-Identität.
 *
 * @param {import('./AccessGuard.js').Identity} identity
 * @returns {{ allowed: boolean }}
 */
function checkMutationAuthz(identity) {
  const adminEmails = process.env.CRED_ADMIN_EMAILS;
  if (!adminEmails || !adminEmails.trim()) {
    // Keine Allowlist gesetzt → jede gültige Identität darf mutieren
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

/**
 * @param {import('./CredentialStore.js').CredentialStore} credentialStore
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @returns {import('express').Router}
 */
export function credentialsRouter(credentialStore, auditStore) {
  const router = Router();

  /**
   * GET /api/settings/credentials
   * Listet alle bekannten Credential-Felder mit Metadaten.
   * Keine Klartext-Werte.
   *
   * Responses:
   *   200 [{ integration, name, status, masked?, updatedAt? }]
   *   500 { error: string }  — Store nicht lesbar
   */
  router.get('/api/settings/credentials', async (req, res) => {
    try {
      const items = await credentialStore.list();
      return res.json(items);
    } catch (err) {
      console.error('[credentialsRouter] GET list failed:', err.message);
      return res.status(500).json({ error: 'Credential-Store nicht erreichbar' });
    }
  });

  /**
   * PUT /api/settings/credentials/:integration/:name
   * Setzt oder überschreibt einen Credential-Wert.
   * Body: { value: string }
   *
   * Responses:
   *   200 { integration, name, status: 'set', updatedAt }
   *   400 { error: string }  — Validierungsfehler
   *   403 { error: string }  — keine Berechtigung
   *   404 { error: string }  — unbekannte Integration/Name
   *   422 { error: string }  — Längenlimit
   *   500 { error: string }  — Store nicht schreibbar
   */
  router.put('/api/settings/credentials/:integration/:name', async (req, res) => {
    const identity = req.identity ?? null;

    // AC7: Mutations-Autorisierung
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { integration, name } = req.params;

    // AC8: Key validieren
    const resolved = resolveKey(integration, name);
    if (!resolved.ok) {
      const status = resolved.error?.includes('Unbekannte') || resolved.error?.includes('Unbekanntes') ? 404 : 422;
      return res.status(status).json({ error: resolved.error });
    }

    // AC8: Wert validieren
    const { value } = req.body ?? {};
    if (typeof value !== 'string' || value.trim() === '') {
      return res.status(400).json({ error: 'Feld "value" ist ein Pflichtfeld und darf nicht leer sein' });
    }

    // Audit ZUERST (ADR-007: Audit-Write fail → Mutation unterbleibt)
    const auditAction = `credential:set:${resolved.storeKey}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[credentialsRouter] Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      const meta = await credentialStore.set(resolved.storeKey, value);
      // S-1: localPath (interner Volume-Pfad) aus HTTP-Response filtern
      return res.json({ integration, name, ...meta, backup: toExternalBackup(meta.backup) });
    } catch (err) {
      if (err.message.includes('Längenlimit')) {
        return res.status(422).json({ error: 'Wert überschreitet das zulässige Längenlimit' });
      }
      if (err.message.includes('leer')) {
        return res.status(400).json({ error: 'Wert darf nicht leer sein' });
      }
      if (err.message.includes('Master-Key') || err.message.includes('CRED_MASTER_KEY')) {
        return res.status(500).json({ error: 'Credential-Store nicht konfiguriert' });
      }
      console.error('[credentialsRouter] PUT set failed:', err.message);
      return res.status(500).json({ error: 'Credential-Store nicht erreichbar' });
    }
  });

  /**
   * DELETE /api/settings/credentials/:integration/:name
   * Löscht einen Credential-Eintrag. Idempotent.
   *
   * Responses:
   *   200 { integration, name, status: 'unset', backup? }
   *   403 { error: string }  — keine Berechtigung
   *   404 { error: string }  — unbekannte Integration/Name
   *   500 { error: string }  — Store nicht schreibbar
   */
  router.delete('/api/settings/credentials/:integration/:name', async (req, res) => {
    const identity = req.identity ?? null;

    // AC7: Mutations-Autorisierung
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { integration, name } = req.params;

    // Key validieren
    const resolved = resolveKey(integration, name);
    if (!resolved.ok) {
      const status = resolved.error?.includes('Unbekannte') || resolved.error?.includes('Unbekanntes') ? 404 : 422;
      return res.status(status).json({ error: resolved.error });
    }

    // Audit ZUERST
    const auditAction = `credential:delete:${resolved.storeKey}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[credentialsRouter] Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      const meta = await credentialStore.delete(resolved.storeKey);
      // S-1: localPath (interner Volume-Pfad) aus HTTP-Response filtern
      return res.json({ integration, name, ...meta, backup: toExternalBackup(meta.backup) });
    } catch (err) {
      if (err.message.includes('Master-Key') || err.message.includes('CRED_MASTER_KEY')) {
        return res.status(500).json({ error: 'Credential-Store nicht konfiguriert' });
      }
      console.error('[credentialsRouter] DELETE failed:', err.message);
      return res.status(500).json({ error: 'Credential-Store nicht erreichbar' });
    }
  });

  return router;
}
