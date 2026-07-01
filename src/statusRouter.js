/**
 * statusRouter — GET /api/status
 *
 * Aggregates live data from GitHubReader + DockerReader in parallel (AC2, AC4).
 * Each source is independent: failure of one does not block the other (AC4).
 *
 * Response shape:
 *   {
 *     projects: [{ name, openItems, lastCi }],
 *     previews: [{ name, url, status }],
 *     claudeAuth: "ok"|"expired"|"unknown",
 *     lastCheckedAt: string|null
 *   }
 *
 * claudeAuth/lastCheckedAt (docs/specs/claude-auth-health.md AC4): angegliedert an
 * diese bestehende Status-Route (statt eines dedizierten Endpunkts) — Zustand
 * kommt von der injizierten `ClaudeAuthHealthService`-Instanz (Boot- + periodische
 * Probe, S-209). Graceful degradation auf `unknown`/`null`, falls der Service
 * nicht verdrahtet ist oder `getState()` wirft (kein Crash).
 *
 * Tokens and secrets are NEVER included in the response (security/R01) — weder
 * GitHub-/Docker-Tokens noch der Claude-Auth-Token-Wert (claude-auth-health AC6).
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
 * @param {{ getState: () => { claudeAuth: string, lastCheckedAt: string|null } }} [options.claudeAuthHealthService]
 *   Optional (claude-auth-health AC4) — ohne Dep degradiert die Antwort auf
 *   `claudeAuth: 'unknown', lastCheckedAt: null`.
 * @returns {import('express').Router}
 */
export function statusRouter({ githubReader, dockerReader, claudeAuthHealthService }) {
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

    // claude-auth-health AC4: Zustand ohne Token-Wert anhängen. Best-effort —
    // ein fehlender/werfender Service degradiert auf 'unknown'/null, nie 500.
    let claudeAuth = 'unknown';
    let lastCheckedAt = null;
    if (claudeAuthHealthService && typeof claudeAuthHealthService.getState === 'function') {
      try {
        const state = claudeAuthHealthService.getState();
        claudeAuth = state?.claudeAuth ?? 'unknown';
        lastCheckedAt = state?.lastCheckedAt ?? null;
      } catch {
        // best-effort — degradiert auf 'unknown'/null (AC4)
      }
    }

    // Security: token is only ever in GitHubReader internals — nothing sensitive reaches here
    res.json({ projects, previews, claudeAuth, lastCheckedAt });
  });

  return router;
}
