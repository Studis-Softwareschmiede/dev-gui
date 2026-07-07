/**
 * Router: Regressionslauf-Ergebnisse (docs/specs/regression-result-store.md AC4).
 *
 * GET /api/projects/:slug/regression-runs
 *   → 200 { runs: [ { runId, projekt, suite, scopeTyp, status, startedAt,
 *          durationMs, counts:{passed,failed,total}, artifacts? } ] }
 *   Liste je Projekt, absteigend nach `startedAt` (jüngster zuerst). Das
 *   `ctrf`-Feld wird in der LISTE bewusst NICHT mitgeschickt (kann groß sein) —
 *   Testfall-Details liefert der Einzel-Lauf-Endpunkt.
 *
 * GET /api/projects/:slug/regression-runs/:runId
 *   → 200 { run: { ...,  ctrf: <CTRF-JSON> } }  (inkl. Testfall-Details)
 *   → 404 { error }  wenn Lauf nicht gefunden / Slug ungültig
 *
 * Ein ungültiger/traversierender `:slug` → leere Liste bzw. 404 (KEIN
 * Dateizugriff): der Store validiert den Slug ohnehin selbst, arbeitet aber
 * nur auf seinem In-Memory-Cache.
 *
 * Security (Floor): keine Secrets/absoluten Pfade in der Response — der
 * RegressionResultStore hält nur Slug/Suite/Status/Zähler/CTRF-JSON/
 * Artefakt-Pfad-Referenzen (Runner-Verantwortung, keine Secrets darin,
 * agent-flow `regression-runner` AC9). Read-only, hinter dem globalen
 * AccessGuard auf `/api/*` (server.js).
 *
 * Factory-Signatur: create(deps) → Express Router
 *
 * @module regressionRuns
 */

import { Router } from 'express';

export const order = 94;

/**
 * @param {{ regressionResultStore?: import('../RegressionResultStore.js').RegressionResultStore }} deps
 * @returns {import('express').Router}
 */
export function create({ regressionResultStore } = {}) {
  const router = Router();

  /**
   * GET /api/projects/:slug/regression-runs
   *
   * Responses:
   *   200 { runs: [...] }  — absteigend nach startedAt, ohne `ctrf`-Feld
   *   500 { error }        — Store-Lesefehler (best-effort — sollte nicht vorkommen)
   */
  router.get('/api/projects/:slug/regression-runs', async (req, res) => {
    const { slug } = req.params;

    if (!regressionResultStore || typeof regressionResultStore.list !== 'function') {
      // Composition-Root-Fehler / Store nicht verdrahtet → leere Liste (defensiv).
      return res.json({ runs: [] });
    }

    try {
      const runs = await regressionResultStore.list(slug);
      // Listen-Response bewusst ohne `ctrf` (kann groß sein) — Details liefert
      // der Einzel-Lauf-Endpunkt.
      const summary = runs.map(({ ctrf: _ctrf, ...rest }) => rest);
      return res.json({ runs: summary });
    } catch (err) {
      console.error('[regressionRuns] list fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Regressionsläufe konnten nicht geladen werden.' });
    }
  });

  /**
   * GET /api/projects/:slug/regression-runs/:runId
   *
   * Responses:
   *   200 { run: {...} }  — inkl. `ctrf` (Testfall-Details) + `artifacts` bei Rot
   *   404 { error }       — Lauf nicht gefunden / Slug ungültig
   *   500 { error }       — Store-Lesefehler
   */
  router.get('/api/projects/:slug/regression-runs/:runId', async (req, res) => {
    const { slug, runId } = req.params;

    if (!regressionResultStore || typeof regressionResultStore.get !== 'function') {
      return res.status(404).json({ error: 'Lauf nicht gefunden.' });
    }

    try {
      const run = await regressionResultStore.get(slug, runId);
      if (!run) {
        return res.status(404).json({ error: 'Lauf nicht gefunden.' });
      }
      return res.json({ run });
    } catch (err) {
      console.error('[regressionRuns] get fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Regressionslauf konnte nicht geladen werden.' });
    }
  });

  return router;
}
