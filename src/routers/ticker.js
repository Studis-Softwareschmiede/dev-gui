/**
 * Router: Ticker(Nachtwächter)-Settings CRUD (taktgeber-nachtwaechter AC15/AC16/AC17).
 *
 * AC15 — Persistenz + API:
 *   GET  /api/settings/ticker → gespeicherte Settings (oder Defaults).
 *   PUT  /api/settings/ticker → Validierung + Speicherung; 400 bei ungültiger Eingabe.
 * AC16 — enabled=false wird unverändert gespeichert/gelesen (Scheduler-Idle-Entscheidung
 *   liegt beim Scheduler selbst, S-195 — dieser Router liefert nur den Wert).
 * AC17 — kompakte Statusanzeige (Fabrik-Übersicht, S-197 NightWatchStatusBadge):
 *   GET /api/settings/ticker/status → abgeleiteter Status, kombiniert die persistierten
 *   Settings (enabled/window) mit `isWithinWindow` (Wiederverwendung aus NightWatchScheduler.js,
 *   S-195 — keine Duplizierung der TZ-/über-Mitternacht-Logik) und der Anzahl aktuell
 *   laufender Drains (`NightWatchScheduler#getStatus()`, optionaler Dep — 0 wenn der
 *   Scheduler nicht verdrahtet ist, graceful degradation, analog `_resolveKnownSlugs`).
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
import { isWithinWindow } from '../NightWatchScheduler.js';

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
 *   nightWatchScheduler?: import('../NightWatchScheduler.js').NightWatchScheduler,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ boardAggregator, nightWatchScheduler } = {}) {
  const router = Router();

  /**
   * GET /api/settings/ticker
   *
   * Response 200: { enabled, window:{start,end,timezone}, intervalMinutes, maxParallel,
   *   staleInProgressHours, escalationAttempts, projects, nightBudgetTokens,
   *   budgetThresholdPercent } (nightBudgetTokens/budgetThresholdPercent additiv,
   *   night-budget-guard AC1)
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
   * GET /api/settings/ticker/status
   *
   * AC17 — abgeleiteter Status für die kompakte Statusanzeige (Fabrik-Übersicht).
   * Registriert VOR der generischen `/api/settings/ticker`-Route unschädlich, da Express
   * exakte Pfad-Segmente matcht (`/status` matcht nie den `/api/settings/ticker`-Handler).
   *
   * Response 200: { enabled, window:{start,end,timezone}, withinWindow, activeDrains }
   *   - withinWindow: `isWithinWindow(Date.now(), settings.window)` (Wiederverwendung
   *     NightWatchScheduler.js, AC10 — keine eigene TZ-/über-Mitternacht-Logik hier).
   *   - activeDrains: Anzahl aktuell laufender Drains (`nightWatchScheduler.getStatus()`),
   *     0 wenn der Scheduler nicht verdrahtet ist (graceful degradation).
   */
  router.get('/api/settings/ticker/status', async (_req, res) => {
    let settings;
    try {
      settings = await read();
    } catch (err) {
      console.error('[ticker] status read fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Ticker-Status konnte nicht geladen werden.' });
    }

    let activeDrains = 0;
    if (nightWatchScheduler && typeof nightWatchScheduler.getStatus === 'function') {
      try {
        const schedulerStatus = nightWatchScheduler.getStatus();
        activeDrains = Array.isArray(schedulerStatus?.activeDrainProjectPaths)
          ? schedulerStatus.activeDrainProjectPaths.length
          : 0;
      } catch {
        activeDrains = 0; // best-effort — ein Scheduler-Status-Fehler darf die Anzeige nie crashen
      }
    }

    return res.json({
      enabled: settings.enabled,
      window: settings.window,
      withinWindow: isWithinWindow(Date.now(), settings.window),
      activeDrains,
    });
  });

  /**
   * PUT /api/settings/ticker
   *
   * Validierung: window.start/end (HH:MM), window.timezone (IANA), intervalMinutes ≥ 1,
   * staleInProgressHours ≥ 1, escalationAttempts ≥ 1, projects "all"|Slug-Array (Format +
   * Existenz gegen BoardAggregator-Index, falls verfügbar), nightBudgetTokens ≥ 0 (int),
   * budgetThresholdPercent 1–100 (int) — night-budget-guard AC1. maxParallel wird auf 1–3
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
