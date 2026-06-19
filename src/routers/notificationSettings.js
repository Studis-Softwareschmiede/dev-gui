/**
 * Router: Notification-Settings-Endpunkte (S-182 AC5).
 *
 * AC5 — POST /api/settings/notifications/test
 *   Sendet eine Probenachricht mit der aktuellen Notification-Konfiguration.
 *   - Bei disabled (enabled=false) oder leerem Topic → { ok: false, error }
 *   - Bei Erfolg → { ok: true }
 *   - Bei ntfy-Fehler → { ok: false, error, status? }
 *   - Token wird serverseitig aus CredentialStore gelesen; verlässt nie die Response.
 *
 * Config-Quelle: Der Endpunkt liest die Konfiguration über `getNotificationConfig()`
 * aus den `deps` (injizierbarer Provider — S-183 ersetzt ihn mit dem echten Store).
 * Default-Provider: disabled/leer wenn kein echter Store existiert.
 *
 * Security (AC10 / security/R01):
 *   - Token erscheint NICHT in der Response.
 *   - Response enthält niemals den Token-Klartext.
 *
 * Factory-Signatur: create(deps) → Express Router
 *
 * @module notificationSettings
 */

import { Router } from 'express';
import { sendNotification } from '../NotifyService.js';
import { catalogKey } from '../CredentialStore.js';

export const order = 53;

/**
 * Default-Provider für die Notification-Config.
 * Liefert eine leere / deaktivierte Config, solange S-183 (Settings-Persistenz)
 * noch nicht implementiert ist. S-183 ersetzt diesen Provider via deps-Injektion.
 *
 * @returns {Promise<{ enabled: boolean, server: string, topic: string, priority?: number, events: string[] }>}
 */
async function defaultGetNotificationConfig() {
  return {
    enabled: false,
    server: 'https://ntfy.sh',
    topic: '',
    priority: undefined,
    events: [],
  };
}

/**
 * @param {{
 *   credentialStore: import('../CredentialStore.js').CredentialStore,
 *   getNotificationConfig?: () => Promise<{ enabled: boolean, server: string, topic: string, priority?: number, events: string[] }>
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore, getNotificationConfig }) {
  const router = Router();

  // Config-Provider: injiziert aus deps (S-183 steckt den echten Store ein)
  // oder Default-Fallback (disabled/leer) wenn nicht gesetzt.
  const resolveConfig = getNotificationConfig ?? defaultGetNotificationConfig;

  /**
   * POST /api/settings/notifications/test
   *
   * Sendet eine Probenachricht mit der aktuellen Notification-Config.
   *
   * Response 200: { ok: true }
   * Response 200: { ok: false, error: string, status?: number }
   *   (auch bei Konfigurationsfehlern — kein 4xx, damit das Frontend
   *    den ntfy-Fehlergrund darstellen kann)
   *
   * Security: Token verlässt die Response NIEMALS (AC10 / security/R01).
   */
  router.post('/api/settings/notifications/test', async (_req, res) => {
    let config;
    try {
      config = await resolveConfig();
    } catch (err) {
      console.error('[notificationSettings] getNotificationConfig fehlgeschlagen:', err.message);
      return res.json({ ok: false, error: 'Notification-Konfiguration nicht abrufbar' });
    }

    // AC5: disabled → Fehlerantwort statt Versuch
    if (!config.enabled) {
      return res.json({ ok: false, error: 'Benachrichtigungen sind deaktiviert (enabled=false).' });
    }

    // AC5: leeres Topic → Fehlerantwort statt Versuch
    if (!config.topic || !config.topic.trim()) {
      return res.json({ ok: false, error: 'Kein ntfy-Topic konfiguriert.' });
    }

    // Token serverseitig aus CredentialStore holen (NIE in Response/Log)
    let token = null;
    try {
      if (credentialStore) {
        token = await credentialStore.getPlaintext(catalogKey('notifications', 'ntfy_token'));
      }
    } catch (err) {
      // Token-Lese-Fehler: kein Hard-Stop — Versand ohne Token
      console.error('[notificationSettings] Token-Lesen fehlgeschlagen:', err.message);
    }

    // Probenachricht senden
    const result = await sendNotification(
      {
        server: config.server,
        topic: config.topic.trim(),
        priority: config.priority,
        token,
      },
      {
        title: 'Test-Benachrichtigung',
        message: 'Dies ist eine Probe-Nachricht von dev-gui (ntfy-Konfigurationstest).',
        tags: ['test', 'white_check_mark'],
      },
    );

    // AC10: Token erscheint NICHT in der Response
    // result enthält nur { ok, status?, error? } — kein token-Feld
    return res.json(result);
  });

  return router;
}
