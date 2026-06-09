/**
 * teamRouter — GET /api/team, GET /api/team/:kind/:id
 *
 * Exposes the agent-flow team (agents, skills, knowledge packs) as read-only
 * JSON endpoints. Both routes are behind the existing /api AccessGuard (AC9).
 *
 * Routes:
 *   GET /api/team               → { agents:[...], skills:[...], knowledge:[...] }
 *   GET /api/team/:kind/:id     → { ...meta, body } (kind ∈ {agent, skill, knowledge})
 *
 * Security:
 *   - :id validated against strict whitelist regex BEFORE any file access (AC5).
 *   - Only reads agents/, skills/, knowledge/ under plugin root (AC8).
 *   - No secrets in responses (AC8).
 *   - Degrades to empty lists / 404 when plugin missing (AC7).
 *
 * @module teamRouter
 */

import { Router } from 'express';

/**
 * Whitelist for :id — only safe chars, no traversal.
 * agent + skill: no slash (ids are plain filenames / dirnames).
 * knowledge: slash allowed to address sub-path ids (e.g. "frameworks/spring-boot-3").
 */
const VALID_ID_RE_NO_SLASH = /^[a-zA-Z0-9._-]+$/;
const VALID_ID_RE_KNOWLEDGE = /^[a-zA-Z0-9._/-]+$/;

/** Known kinds for the detail endpoint. */
const VALID_KINDS = new Set(['agent', 'skill', 'knowledge']);

/**
 * Create the team router.
 *
 * @param {object} options
 * @param {import('./AgentFlowReader.js').AgentFlowReader} options.agentFlowReader
 * @returns {import('express').Router}
 */
export function teamRouter({ agentFlowReader }) {
  const router = Router();

  /**
   * GET /api/team
   *
   * Returns the overview of all agents, skills and knowledge packs.
   * No body fields are included. Stable alphabetical sort per kind;
   * knowledge additionally sorted by group.
   *
   * Degrades to empty lists (200) when the plugin is not installed (AC7).
   */
  router.get('/api/team', async (_req, res) => {
    const overview = await agentFlowReader.getOverview();
    res.json(overview);
  });

  /**
   * GET /api/team/:kind/:id
   *
   * Returns meta + raw Markdown body for one entry.
   *
   * :kind must be one of: agent, skill, knowledge
   * :id  must match VALID_ID_RE (whitelist — no .., no slash/backslash other
   *      than the forward-slash already in VALID_ID_RE for knowledge sub-paths,
   *      no null byte) — validated BEFORE any file access (AC5).
   *
   * Responds 404 for:
   *   - Unknown kind
   *   - Invalid :id (traversal attempt)
   *   - Not-found entry
   * Never 500 on missing plugin (degrades to 404 for detail calls, AC7).
   *
   * Note: Express 5 (path-to-regexp 8) uses /*splat for multi-segment wildcards.
   * The splat param is an array of path segments; we join them to reconstruct
   * the knowledge id (e.g. ["frameworks", "spring-boot-3"] → "frameworks/spring-boot-3").
   */
  router.get('/api/team/:kind/*splat', async (req, res) => {
    const { kind } = req.params;
    // splat is an array of path segments in Express 5
    const splatParts = Array.isArray(req.params.splat)
      ? req.params.splat
      : [req.params.splat];
    const id = splatParts.join('/');

    // AC6: reject unknown kind immediately
    if (!VALID_KINDS.has(kind)) {
      return res.status(404).json({ error: 'Not found' });
    }

    // AC5: validate :id — reject any path-traversal attempt.
    // Per-kind regex: agent + skill allow no slash (plain ids); knowledge allows slash for sub-paths.
    // Also explicitly forbid '..' segments, backslash and null byte.
    const idRegex = kind === 'knowledge' ? VALID_ID_RE_KNOWLEDGE : VALID_ID_RE_NO_SLASH;
    if (
      !id ||
      !idRegex.test(id) ||
      id.includes('..') ||
      id.includes('\\') ||
      id.includes('\0')
    ) {
      return res.status(404).json({ error: 'Not found' });
    }

    const detail = await agentFlowReader.getDetail(kind, id);
    if (!detail) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json(detail);
  });

  return router;
}
