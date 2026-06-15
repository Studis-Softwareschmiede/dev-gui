/**
 * boardRouter — board API routes (read-only, AC1-3, AC5, AC7-9 studis-kanban-board-ux;
 *               AC1-AC2 story-detail-ansicht)
 *
 * Exposes the in-memory Board-Aggregat as read-only JSON.
 *
 * Routes:
 *   GET /api/board/projects                          → { projects: [...] }  (full aggregat, legacy)
 *   GET /api/board/projects/list                     → { projects: [{slug,feature_count,story_count}] }
 *                                                      (leicht, KEIN Story-Scan — AC5)
 *   GET /api/board/projects/:slug                    → { project: {...} }  (ein Projekt voll, on-demand — AC5)
 *   POST /api/board/projects/rescan                  → { ok: true }  (on-demand re-scan, AC9)
 *   GET /api/board/projects/:slug/stories/:id/detail → { detail: StoryDetail }  (read-only, lazy — AC2)
 *
 * Security:
 *   - Read-only: no writes to board/ files (AC7).
 *   - :slug and :id parameters validated against regex before use as index lookup.
 *     slug is compared to in-memory index only (never used as filesystem path).
 *     id is compared as value only (never used as filesystem path — no traversal).
 *   - Behind existing /api AccessGuard via server.js registration.
 *   - No secrets in output; no new authentication surface.
 *
 * @module boardRouter
 */

import { Router } from 'express';

/** Valid slug characters: alphanumeric, dash, underscore, dot. No leading slash. */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Valid story ID characters: alphanumeric, dash, underscore, dot.
 * Must start with alphanumeric. No path traversal possible.
 */
const STORY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Create the board router.
 *
 * @param {object} options
 * @param {import('./BoardAggregator.js').BoardAggregator} options.boardAggregator
 * @param {import('./StoryMetricReader.js').StoryMetricReader} options.storyMetricReader
 * @returns {import('express').Router}
 */
export function boardRouter({ boardAggregator, storyMetricReader }) {
  const router = Router();

  /**
   * GET /api/board/projects
   *
   * Returns the current aggregated board index as JSON (full — all projects, all stories).
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
   * GET /api/board/projects/list
   *
   * Lightweight project list — returns only slug + coarse counters per repo.
   * Does NOT trigger a full story-YAML scan; uses the already-built in-memory index
   * (which is populated by scan() on first access — that scan does read stories,
   * but list only returns the summary, making subsequent list calls cheap).
   *
   * Response shape:
   * {
   *   projects: [
   *     { slug, feature_count, story_count }  // healthy project
   *     { slug, error }                        // error project
   *   ]
   * }
   *
   * AC5 (studis-kanban-board-ux): getIndex() populates from board.yaml + files,
   * but list strips stories — only slug + counters reach the client.
   */
  router.get('/api/board/projects/list', async (_req, res) => {
    const projects = await boardAggregator.getIndex();
    const list = projects.map((p) => {
      if (p.error) {
        return { slug: p.slug, error: p.error };
      }
      const features = p.features ?? [];
      const feature_count = features.length;
      const story_count = features.reduce((acc, f) => acc + (f.stories ?? []).length, 0);
      return { slug: p.slug, feature_count, story_count };
    });
    return res.json({ projects: list });
  });

  /**
   * GET /api/board/projects/:slug
   *
   * Returns a single project (full data) by slug (on-demand, AC5).
   * The slug is validated and matched against the in-memory index — never used as a
   * filesystem path (security: no path traversal possible).
   *
   * Response: { project: { slug, repo_path, project_slug, schema_version, features: [...] } }
   * 404 if slug unknown or invalid.
   */
  router.get('/api/board/projects/:slug', async (req, res) => {
    const { slug } = req.params;

    // Validate slug format — reject obviously invalid inputs early
    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);

    if (!project) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    return res.json({ project });
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

  /**
   * GET /api/board/projects/:slug/stories/:id/detail
   *
   * Returns story detail metrics (AC2 story-detail-ansicht): Start/Ende/Dauer,
   * Agenten-Flow (seq-geordnet), Soll-Ist (ep_est/ep_act/tok/size_est + Abweichungen).
   *
   * Read-only, lazy (no scan triggered — StoryMetricReader reads on-demand).
   * Behind existing /api AccessGuard.
   *
   * Security:
   *   - :slug validated against SLUG_RE; matched against in-memory index (never used as path).
   *   - :id validated against STORY_ID_RE; used ONLY as a value to compare (never as path).
   *   - No path traversal possible: repo_path comes from trusted Board-Index.
   *
   * Response: { detail: StoryDetail }
   * 404 if slug unknown/invalid or id format invalid.
   * 200 with all-null fields if metrics files are missing (AC1 — no crash).
   */
  router.get('/api/board/projects/:slug/stories/:id/detail', async (req, res) => {
    const { slug, id } = req.params;

    // Validate slug format
    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    // Validate story id format (no traversal — pure value comparison downstream)
    if (!id || !STORY_ID_RE.test(id)) {
      return res.status(404).json({ error: 'Story nicht gefunden.' });
    }

    // Resolve repo_path from trusted in-memory index (slug never used as filesystem path)
    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);

    if (!project || project.error) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const repoPath = project.repo_path;

    // Read metrics (lazy, read-only); missing files → null fields, no crash (AC1)
    const detail = await storyMetricReader.getDetail(repoPath, id);

    return res.json({ detail });
  });

  return router;
}
