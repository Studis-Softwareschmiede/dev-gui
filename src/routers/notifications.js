/**
 * Router: Notification-Settings CRUD (S-183 AC1/AC2/AC10).
 *
 * AC1 — Persistenz: Settings werden gespeichert und überleben Neustart.
 * AC2 — Settings-API:
 *   GET  /api/settings/notifications → Settings inkl. has_token, NIE Token-Klartext.
 *   PUT  /api/settings/notifications → Validierung + Speicherung; 400 bei Fehler.
 * AC10 — Token NIE in Response/Log.
 *
 * Factory-Signatur: create(deps) → Express Router
 *
 * @module notifications
 */

import { Router } from 'express';
import { read, write, validate } from '../NotificationSettingsStore.js';
import { catalogKey } from '../CredentialStore.js';

export const order = 52;

/**
 * @param {{
 *   credentialStore: import('../CredentialStore.js').CredentialStore,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore }) {
  const router = Router();

  /**
   * GET /api/settings/notifications
   *
   * Liefert die gespeicherten Notification-Settings inkl. has_token (Bool).
   * NIE den Token-Klartext (AC10).
   *
   * Response 200: { enabled, server, topic, priority, events, has_token }
   */
  router.get('/api/settings/notifications', async (_req, res) => {
    let settings;
    try {
      settings = await read();
    } catch (err) {
      console.error('[notifications] read fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Notification-Settings konnten nicht geladen werden.' });
    }

    // has_token: prüfe ob der Credential-Eintrag existiert (AC2 / AC10)
    let hasToken = false;
    try {
      if (credentialStore) {
        const meta = await credentialStore.getMeta(catalogKey('notifications', 'ntfy_token'));
        hasToken = meta?.status === 'set';
      }
    } catch {
      // Token-Status nicht abrufbar → has_token=false (graceful degradation)
      hasToken = false;
    }

    // AC10: NIE Token-Klartext in Response
    return res.json({
      enabled: settings.enabled,
      server: settings.server,
      topic: settings.topic,
      priority: settings.priority,
      events: settings.events,
      has_token: hasToken,
    });
  });

  /**
   * PUT /api/settings/notifications
   *
   * Speichert die nicht-geheimen Notification-Settings.
   * Validierung: server = http(s)-URL; topic nicht leer bei enabled=true;
   * events ⊆ erlaubte Schlüssel; priority im ntfy-Bereich.
   * SSRF-Schutz: server-URL gegen interne Ziele geprüft (security/R05).
   * Keine Teilspeicherung bei Validierungsfehler.
   *
   * Response 200: gespeicherte Settings (ohne has_token, da kein Token-Schreib-Vorgang)
   * Response 400: { field, message }
   */
  router.put('/api/settings/notifications', async (req, res) => {
    const { enabled, server, topic, priority, events } = req.body ?? {};

    // Validierung (AC2 / security/R05)
    const validationResult = validate({ enabled, server, topic, priority, events });
    if (!validationResult.ok) {
      return res.status(400).json({
        field: validationResult.field,
        message: validationResult.message,
      });
    }

    // Settings zusammenstellen (nur nicht-geheime Felder)
    const toSave = {};
    if (enabled !== undefined) toSave.enabled = Boolean(enabled);
    if (server !== undefined) toSave.server = String(server).trim();
    if (topic !== undefined) toSave.topic = String(topic);
    if (events !== undefined) toSave.events = Array.isArray(events) ? events : [];
    if (priority !== undefined) toSave.priority = priority === null ? null : Number(priority);

    let saved;
    try {
      saved = await write(toSave);
    } catch (err) {
      console.error('[notifications] write fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Notification-Settings konnten nicht gespeichert werden.' });
    }

    // AC10: NIE Token-Klartext in Response
    return res.json({
      enabled: saved.enabled,
      server: saved.server,
      topic: saved.topic,
      priority: saved.priority,
      events: saved.events,
    });
  });

  return router;
}
