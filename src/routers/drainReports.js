/**
 * Router: Drain-Abschlussberichte (docs/specs/drain-completion-report.md AC4).
 *
 * GET /api/drain-reports[?project=<slug>]
 *   → 200 { reports: [ { reportId, project, trigger, startedAt, finishedAt,
 *          reason, flowRuns, completed:[{id,title}], blocked:[{id,title}],
 *          budgetPauses:[{from,to,reason}] } ] }
 *   `budgetPauses` additiv seit docs/specs/night-budget-guard.md AC12 — fehlt
 *   das Feld bei Alt-Berichten, liefert der Store `[]` (rückwärtskompatibel).
 *   absteigend nach `finishedAt` (jüngster zuerst); optional per `?project=<slug>`
 *   gefiltert. Read-only, hinter dem globalen AccessGuard auf `/api/*` (server.js).
 *
 * Ein ungültiger/traversierender `?project`-Wert → leere Liste (KEIN Dateizugriff,
 * kein 500): der Slug wird VOR dem Store-Aufruf gegen den Slug-Form-Check
 * validiert; der Store selbst arbeitet ohnehin nur auf seinem In-Memory-Cache.
 *
 * Security (Floor): keine Secrets/absoluten Pfade in der Response — der
 * DrainReportStore hält ausschließlich Slug + Story-ID/Titel + Zähler.
 *
 * Factory-Signatur: create(deps) → Express Router
 *
 * @module drainReports
 */

import { Router } from 'express';
import { PROJECT_SLUG_RE } from '../DrainReportStore.js';

export const order = 53;

/**
 * @param {{ drainReportStore?: import('../DrainReportStore.js').DrainReportStore }} deps
 * @returns {import('express').Router}
 */
export function create({ drainReportStore } = {}) {
  const router = Router();

  /**
   * GET /api/drain-reports[?project=<slug>]
   *
   * Responses:
   *   200 { reports: [...] }  — absteigend nach finishedAt, optional gefiltert
   *   500 { error }           — Store-Lesefehler (best-effort — sollte nicht vorkommen)
   */
  router.get('/api/drain-reports', async (req, res) => {
    const rawProject = req.query.project;

    // Ungültiger/traversierender Slug → leere Liste, KEIN Dateizugriff (AC4).
    if (rawProject !== undefined) {
      if (typeof rawProject !== 'string' || !PROJECT_SLUG_RE.test(rawProject)) {
        return res.json({ reports: [] });
      }
    }

    if (!drainReportStore || typeof drainReportStore.list !== 'function') {
      // Composition-Root-Fehler / Store nicht verdrahtet → leere Liste (defensiv).
      return res.json({ reports: [] });
    }

    try {
      const reports = await drainReportStore.list(
        rawProject === undefined ? {} : { project: rawProject },
      );
      return res.json({ reports });
    } catch (err) {
      console.error('[drainReports] list fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Drain-Berichte konnten nicht geladen werden.' });
    }
  });

  return router;
}
