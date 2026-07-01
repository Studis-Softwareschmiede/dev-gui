/**
 * Router: Ticker(Nachtwächter)-Settings CRUD (taktgeber-nachtwaechter AC15/AC16).
 *
 * AC15 — Persistenz + API:
 *   GET  /api/settings/ticker → gespeicherte Settings (oder Defaults).
 *   PUT  /api/settings/ticker → Validierung + Speicherung; 400 bei ungültiger Eingabe.
 * AC16 — enabled=false wird unverändert gespeichert/gelesen (Scheduler-Idle-Entscheidung
 *   liegt beim Scheduler selbst, S-195 — dieser Router liefert nur den Wert).
 *
 * Keine Secrets (Floor) — die Ticker-Settings enthalten ausschließlich Nachtfenster-/
 * Parallelitäts-/Projekt-Konfiguration.
 *
 * Factory-Signatur: create(deps) → Express Router
 *
 * @module ticker
 */

import { Router } from 'express';
import { read, write, validate } from '../TickerSettingsStore.js';

export const order = 54;

/**
 * Ermittelt die bekannten Projekt-Slugs aus dem BoardAggregator-Index (Settings-Schema:
 * "projects: Slugs aus BoardAggregator-Index"). Graceful degradation: liefert `undefined`
 * wenn boardAggregator fehlt oder der Scan fehlschlägt — die Existenz-Prüfung wird dann
 * übersprungen (Format-Prüfung bleibt bestehen), statt PUT hart zu blockieren.
 *
 * @param {import('../BoardAggregator.js').BoardAggregator} [boardAggregator]
 * @returns {Promise<string[]|undefined>}
 */
async function _resolveKnownSlugs(boardAggregator) {
  if (!boardAggregator) return undefined;
  try {
    const index = await boardAggregator.getIndex();
    return index.filter((entry) => typeof entry?.slug === 'string').map((entry) => entry.slug);
  } catch {
    return undefined;
  }
}

/**
 * @param {{
 *   boardAggregator?: import('../BoardAggregator.js').BoardAggregator,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ boardAggregator } = {}) {
  const router = Router();

  /**
   * GET /api/settings/ticker
   *
   * Response 200: { enabled, window:{start,end,timezone}, intervalMinutes, maxParallel,
   *   staleInProgressHours, escalationAttempts, projects }
   */
  router.get('/api/settings/ticker', async (_req, res) => {
    let settings;
    try {
      settings = await read();
    } catch (err) {
      console.error('[ticker] read fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Ticker-Settings konnten nicht geladen werden.' });
    }
    return res.json(settings);
  });

  /**
   * PUT /api/settings/ticker
   *
   * Validierung: window.start/end (HH:MM), window.timezone (IANA), intervalMinutes ≥ 1,
   * staleInProgressHours ≥ 1, escalationAttempts ≥ 1, projects "all"|Slug-Array (Format +
   * Existenz gegen BoardAggregator-Index, falls verfügbar). maxParallel wird auf 1–3
   * geklemmt statt abgelehnt (Edge-Case Account-Überlast-Schutz).
   * Keine Teilspeicherung bei Validierungsfehler.
   *
   * Response 200: gespeicherte Settings
   * Response 400: { field, message }
   */
  router.put('/api/settings/ticker', async (req, res) => {
    const body = req.body ?? {};

    const knownSlugs = await _resolveKnownSlugs(boardAggregator);
    const validationResult = validate(body, { knownSlugs });
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
      console.error('[ticker] write fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Ticker-Settings konnten nicht gespeichert werden.' });
    }

    return res.json(saved);
  });

  return router;
}
