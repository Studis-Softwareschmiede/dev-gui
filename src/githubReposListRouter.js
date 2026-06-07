/**
 * githubReposListRouter — GET /api/github/repos
 *
 * Read-only endpoint: lists all Org repos live via GitHubReader.listRepos().
 * Hinter AccessGuard (montiert via app.use('/api', accessGuard) in server.js).
 *
 * Response shape (Spec github-repos-overview AC1, Verträge):
 *   200 { repos: [{ name, fullName, visibility, openIssues, lastCi, htmlUrl }] }
 *
 * Graceful degradation (AC6):
 *   - GitHub unreachable → repos: [] (kein Crash, kein Secret-Leak)
 *   - Per-repo fetch failure → Feld degrades to 'unknown'
 *
 * Security (security/R01):
 *   - App-Token erscheint NIE in Response, Log oder WS-Stream.
 *   - Kein POST/PATCH/PUT/DELETE auf diesem Router.
 *
 * @module githubReposListRouter
 */

import { Router } from 'express';

/**
 * Create the GitHub repos list router.
 *
 * @param {object} options
 * @param {import('./GitHubReader.js').GitHubReader} options.githubReader
 * @returns {import('express').Router}
 */
export function githubReposListRouter({ githubReader }) {
  const router = Router();

  /**
   * GET /api/github/repos
   *
   * Returns all org repos with shape { name, fullName, visibility, openIssues, lastCi, htmlUrl }.
   * Always 200 — on source failure repos:[] is returned (AC6, graceful degradation).
   */
  router.get('/api/github/repos', async (_req, res) => {
    let repos;
    try {
      repos = await githubReader.listRepos();
    } catch {
      // Unexpected rejection (should not happen — listRepos degrades internally)
      // Degrade gracefully: return empty list (AC6), never expose internals or token
      repos = [];
    }

    // Security: token is only ever in GitHubReader internals — nothing sensitive reaches here
    res.json({ repos });
  });

  return router;
}
