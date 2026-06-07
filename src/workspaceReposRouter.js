/**
 * workspaceReposRouter — Express router for the Workspace Repos API (AC1, AC2).
 *
 * Routes (behind the AccessGuard middleware mounted in server.js):
 *   GET /api/workspace/repos
 *     → 200 { repos: [{ name, branch, dirty, lastCommit, originUrl }] }
 *       credential-free originUrl (AC2)
 *
 * Security:
 *   - AccessGuard is applied upstream (in server.js) — req.identity is set.
 *   - originUrl credential-stripping is done inside WorkspaceScanner (AC2).
 *   - No user input is accepted on this read-only endpoint (no path traversal).
 *   - Listing is live from WORKSPACE_DIR filesystem (ADR-005, no store).
 *
 * @module workspaceReposRouter
 */

import { Router } from 'express';

/**
 * Create and return the workspace repos router.
 *
 * @param {import('./WorkspaceScanner.js').WorkspaceScanner} workspaceScanner
 * @returns {import('express').Router}
 */
export function workspaceReposRouter(workspaceScanner) {
  const router = Router();

  /**
   * GET /api/workspace/repos
   *
   * Lists all local git clones in WORKSPACE_DIR live from the filesystem.
   *
   * Responses:
   *   200 { repos: [{ name, branch, dirty, lastCommit, originUrl }] }
   *       — always 200; WORKSPACE_DIR missing/empty → repos: []
   */
  router.get('/api/workspace/repos', async (_req, res) => {
    try {
      const repos = await workspaceScanner.listClones();
      return res.json({ repos });
    } catch (err) {
      // Unexpected error — degrade to empty list, never expose internals
      console.error('[workspaceReposRouter] listClones failed:', err.message);
      return res.json({ repos: [] });
    }
  });

  return router;
}
