/**
 * Router: Auto-Retro-Schalter CRUD (retro-auto-trigger AC2).
 *
 * AC2 — Persistenz + API:
 *   GET  /api/settings/retro-auto → 200 { enabled } (gespeichert oder Default).
 *   PUT  /api/settings/retro-auto → 200 { enabled } (persistiert) | 400 { field, message }
 *        bei ungültigem `enabled` (kein Boolean).
 *
 * Beide Endpunkte liegen hinter dem globalen AccessGuard auf `/api/*` (in server.js VOR
 * mountRouters() via `app.use('/api', accessGuard)` registriert — nicht Bestandteil dieses
 * Router-Moduls, analog ticker.js/notificationSettings.js).
 *
 * Keine Secrets (Floor) — die Datei/Response enthält ausschließlich den nicht-geheimen
 * globalen Ein/Aus-Schalter.
 *
 * Factory-Signatur: create(deps) → Express Router
 *
 * @module retroAutoSettings
 */

import { Router } from 'express';
import { read, write, validate } from '../RetroAutoSettingsStore.js';

export const order = 55;

/**
 * @param {object} [deps] - Composition-Root-Dependencies (keine benötigt — thin Router).
 * @returns {import('express').Router}
 */
export function create() {
  const router = Router();

  /**
   * GET /api/settings/retro-auto
   *
   * Response 200: { enabled }
   */
  router.get('/api/settings/retro-auto', async (_req, res) => {
    let settings;
    try {
      settings = await read();
    } catch (err) {
      console.error('[retroAutoSettings] read fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Auto-Retro-Einstellung konnte nicht geladen werden.' });
    }
    return res.json({ enabled: settings.enabled });
  });

  /**
   * PUT /api/settings/retro-auto { enabled }
   *
   * Validierung: `enabled` muss Boolean sein. Keine Speicherung bei Validierungsfehler.
   *
   * Response 200: { enabled } (persistiert)
   * Response 400: { field, message }
   */
  router.put('/api/settings/retro-auto', async (req, res) => {
    const body = req.body ?? {};

    const validationResult = validate(body);
    if (!validationResult.ok) {
      return res.status(400).json({
        field: validationResult.field,
        message: validationResult.message,
      });
    }

    let saved;
    try {
      saved = await write(body);
    } catch (err) {
      console.error('[retroAutoSettings] write fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Auto-Retro-Einstellung konnte nicht gespeichert werden.' });
    }

    return res.json({ enabled: saved.enabled });
  });

  return router;
}
