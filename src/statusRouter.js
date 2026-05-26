/**
 * statusRouter — GET /api/status
 *
 * Aggregates live data from GitHubReader + DockerReader in parallel (AC2, AC4).
 * Each source is independent: failure of one does not block the other (AC4).
 *
 * Response shape:
 *   {
 *     projects: [{ name, openItems, lastCi }],
 *     previews: [{ name, url, status }]
 *   }
 *
 * Tokens and secrets are NEVER included in the response (security/R01).
 *
 * @module statusRouter
 */

import { Router } from 'express';

/**
 * Create the status router.
 *
 * @param {object} options
 * @param {import('./GitHubReader.js').GitHubReader} options.githubReader
 * @param {import('./DockerReader.js').DockerReader} options.dockerReader
 * @returns {import('express').Router}
 */
export function statusRouter({ githubReader, dockerReader }) {
  const router = Router();

  /**
   * GET /api/status
   *
   * Fetches GitHub projects and Docker previews in parallel.
   * Any source that errors degrades to its safe default (AC4):
   *   - GitHub error → projects: []  (or per-repo fields "unknown")
   *   - Docker error → previews: []
   * Always returns 200 (AC4 — never 500 on source failure).
   */
  router.get('/api/status', async (_req, res) => {
    // Parallel fetch — one slow/failing source never blocks the other (AC4)
    const [projectsResult, previewsResult] = await Promise.allSettled([
      githubReader.getProjects(),
      dockerReader.getPreviews(),
    ]);

    const projects = projectsResult.status === 'fulfilled'
      ? projectsResult.value
      : [];

    const previews = previewsResult.status === 'fulfilled'
      ? previewsResult.value
      : [];

    // Security: token is only ever in GitHubReader internals — nothing sensitive reaches here
    res.json({ projects, previews });
  });

  return router;
}
