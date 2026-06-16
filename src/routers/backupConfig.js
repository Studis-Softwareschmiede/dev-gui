/**
 * Router-Wrapper: Backup-Konfiguration-Endpunkte (S-143, AC12 — Architekt-Entscheid Variante B).
 *
 * GET /api/settings/backup-config
 *   Liefert die persistierte nicht-geheime Backup-Konfiguration.
 *   Quelle: ${CRED_STORE_DIR}/backup-config.json > Env-Vars > Defaults.
 *   Metadaten-only — KEIN Remote-Secret, KEIN Master-Key, KEIN Store-Klartext.
 *
 * PUT /api/settings/backup-config
 *   Schreibt die nicht-geheime Konfiguration in backup-config.json (atomar, 0600).
 *   Body: { offHostEnabled, targetType, endpoint, bucket, prefix, region,
 *            host, port, user, retentionCount }
 *   Schutz: AccessGuard (via server.js /api-Middleware) +
 *            CRED_ADMIN_EMAILS-Rollencheck + Audit-First.
 *
 * Security-Floor:
 *   - Nur nicht-geheime Felder erlaubt (Remote-Secrets bleiben im CredentialStore).
 *   - PUT: Audit-First (AuditStore.record() VOR dem Schreiben).
 *   - PUT: CRED_ADMIN_EMAILS-Rollencheck → 403 bei nicht-berechtigt.
 *   - Input-Validierung: Typ, Zeichenlimit, keine Secrets in den erlaubten Feldern.
 *
 * Factory-Signatur: create(deps) → Express Router
 *
 * @module backupConfig
 */

import { Router } from 'express';
import { read, write } from '../BackupConfigStore.js';

export const order = 52;

/** Maximal erlaubte Zeichenlänge für String-Felder in der Konfig. */
const MAX_STRING_LEN = 1024;

/** Erlaubte targetType-Werte. */
const ALLOWED_TYPES = new Set(['local', 's3', 'sftp']);

/**
 * Prüft ob die anfragende Identität die Backup-Konfiguration mutieren darf.
 * Analoges Muster zu checkMutationAuthz() in credentialsRouter.js.
 *
 * @param {object|null} identity - req.identity (AccessGuard-Ergebnis)
 * @returns {{ allowed: boolean }}
 */
function checkMutationAuthz(identity) {
  const adminEmails = process.env.CRED_ADMIN_EMAILS;
  if (!adminEmails || !adminEmails.trim()) {
    // Keine Allowlist → jede gültige Identität darf mutieren
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
 * Validiert einen String-Feldwert (Längenlimit, kein Null-Byte).
 *
 * @param {unknown} val
 * @param {string} fieldName
 * @returns {{ ok: boolean, error?: string }}
 */
function validateStringField(val, fieldName) {
  if (val === undefined || val === null || val === '') return { ok: true }; // leer ist OK (optional)
  if (typeof val !== 'string') return { ok: false, error: `${fieldName} muss ein String sein.` };
  if (val.length > MAX_STRING_LEN) return { ok: false, error: `${fieldName} überschreitet Längenlimit (${MAX_STRING_LEN} Zeichen).` };
  // eslint-disable-next-line no-control-regex
  if (/\x00/.test(val)) return { ok: false, error: `${fieldName} enthält ungültige Zeichen.` };
  return { ok: true };
}

/**
 * @param {{ auditStore: import('../AuditStore.js').AuditStore }} deps
 * @returns {import('express').Router}
 */
export function create({ auditStore }) {
  const router = Router();

  /**
   * GET /api/settings/backup-config
   * Liefert die aktuelle nicht-geheime Backup-Konfiguration.
   * Quelle: JSON-Datei (wenn vorhanden) > Env-Vars > Defaults.
   *
   * Response 200: BackupConfig (alle nicht-geheimen Felder)
   * Response 500: { error: string }
   */
  router.get('/api/settings/backup-config', async (_req, res) => {
    try {
      const config = await read();
      // Metadaten-only — nur nicht-geheime Felder zurückgeben
      return res.json(config);
    } catch (err) {
      console.error('[backupConfig] GET failed:', err.message);
      return res.status(500).json({ error: 'Backup-Konfiguration nicht abrufbar' });
    }
  });

  /**
   * PUT /api/settings/backup-config
   * Schreibt die nicht-geheime Backup-Konfiguration (atomar, 0600).
   *
   * Schutz: AccessGuard (global /api-Middleware) + CRED_ADMIN_EMAILS + Audit-First.
   *
   * Body (alle Felder optional, werden mit aktueller Konfig gemergt):
   *   { offHostEnabled?: boolean, targetType?: 'local'|'s3'|'sftp',
   *     endpoint?: string, bucket?: string, prefix?: string, region?: string,
   *     host?: string, port?: string, user?: string, retentionCount?: number }
   *
   * Response 200: { ok: true, config: BackupConfig }
   * Response 400: { error: string }  — Validierungsfehler
   * Response 403: { error: string }  — CRED_ADMIN_EMAILS-Check fehlgeschlagen
   * Response 500: { error: string }  — Schreibfehler
   */
  router.put('/api/settings/backup-config', async (req, res) => {
    // CRED_ADMIN_EMAILS-Rollencheck (Spec §13/[[access-and-guardrails]])
    const authz = checkMutationAuthz(req.identity ?? null);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Ändern der Backup-Konfiguration.' });
    }

    // Eingabe-Validierung
    const body = req.body ?? {};
    const {
      offHostEnabled,
      targetType,
      endpoint,
      bucket,
      prefix,
      region,
      host,
      port,
      user,
      retentionCount,
    } = body;

    // targetType validieren
    if (targetType !== undefined && !ALLOWED_TYPES.has(targetType)) {
      return res.status(400).json({ error: `targetType muss 'local', 's3' oder 'sftp' sein (erhalten: ${targetType}).` });
    }

    // String-Felder validieren
    for (const [fieldName, val] of [
      ['endpoint', endpoint],
      ['bucket', bucket],
      ['prefix', prefix],
      ['region', region],
      ['host', host],
      ['port', port],
      ['user', user],
    ]) {
      const r = validateStringField(val, fieldName);
      if (!r.ok) return res.status(400).json({ error: r.error });
    }

    // retentionCount validieren
    if (retentionCount !== undefined) {
      const n = Number(retentionCount);
      if (!Number.isFinite(n) || n < 1 || n > 9999) {
        return res.status(400).json({ error: 'retentionCount muss eine positive Ganzzahl (1–9999) sein.' });
      }
    }

    // Audit-First (Spec §NFRs / [[access-and-guardrails]]: Audit-Write schlägt fehl → Aktion läuft nicht)
    const identity = req.identity ?? null;
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: 'backup-config-update',
      });
    } catch (auditErr) {
      console.error('[backupConfig] Audit-Schreiben fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Schreiben fehlgeschlagen — Konfiguration nicht gespeichert.' });
    }

    // Konfiguration schreiben
    const update = {};
    if (offHostEnabled !== undefined) update.offHostEnabled = Boolean(offHostEnabled);
    if (targetType !== undefined) update.targetType = targetType;
    if (endpoint !== undefined) update.endpoint = String(endpoint).trim();
    if (bucket !== undefined) update.bucket = String(bucket).trim();
    if (prefix !== undefined) update.prefix = String(prefix).trim();
    if (region !== undefined) update.region = String(region).trim();
    if (host !== undefined) update.host = String(host).trim();
    if (port !== undefined) update.port = String(port).trim();
    if (user !== undefined) update.user = String(user).trim();
    if (retentionCount !== undefined) update.retentionCount = Math.floor(Number(retentionCount));

    try {
      const saved = await write(update);
      return res.json({ ok: true, config: saved });
    } catch (err) {
      console.error('[backupConfig] PUT write failed:', err.message);
      return res.status(500).json({ error: 'Backup-Konfiguration konnte nicht gespeichert werden.' });
    }
  });

  return router;
}
