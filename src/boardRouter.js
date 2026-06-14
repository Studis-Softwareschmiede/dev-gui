/**
 * boardRouter — GET /api/board/projects (read-only, AC1-3, AC7-9)
 *
 * Exposes the in-memory Board-Aggregat as read-only JSON.
 *
 * Routes:
 *   GET /api/board/projects           → { projects: [...] }  (full aggregat)
 *   POST /api/board/projects/rescan   → { ok: true }  (on-demand re-scan, AC9)
 *
 * Security:
 *   - Read-only: no writes to board/ files (AC7).
 *   - No user input used as filesystem path; all scanning is based on
 *     configured board roots (env-derived).
 *   - Behind existing /api AccessGuard via server.js registration.
 *   - No secrets in output; no new authentication surface.
 *
 * @module boardRouter
 */

import { Router } from 'express';

/**
 * Create the board router.
 *
 * @param {object} options
 * @param {import('./BoardAggregator.js').BoardAggregator} options.boardAggregator
 * @returns {import('express').Router}
 */
export function boardRouter({ boardAggregator }) {
  const router = Router();

  /**
   * GET /api/board/projects
   *
   * Returns the current aggregated board index as JSON.
   * Triggers a scan on first call if the index is not yet populated.
   * Error entries (invalid boards) are included with an `error` field
   * and an empty `features` array (AC8).
   *
   * Response shape:
   * {
   *   projects: [
   *     {
   *       slug, repo_path, project_slug, schema_version,
   *       features: [
   *         { id, title, status, priority, progress,
   *           stories: [{ id, parent, title, status, priority, labels, spec, dispo_est, dispo_act }]
   *         }
   *       ]
   *     },
   *     { slug, repo_path, error, features: [] }   // error board
   *   ]
   * }
   */
  router.get('/api/board/projects', async (_req, res) => {
    const projects = await boardAggregator.getIndex();
    return res.json({ projects });
  });

  /**
   * POST /api/board/projects/rescan
   *
   * Triggers an on-demand re-scan of all configured board roots (AC9).
   * The new index is immediately available for the next GET request.
   *
   * This route does NOT write to any board/ file (AC7 read-only guarantee).
   *
   * Response: { ok: true }
   */
  router.post('/api/board/projects/rescan', async (_req, res) => {
    await boardAggregator.scan();
    return res.json({ ok: true });
  });

  return router;
}
