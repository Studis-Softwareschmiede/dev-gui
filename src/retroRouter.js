/**
 * retroRouter — GET /api/retro/runs, GET /api/retro/runs/:slug, GET /api/retro/trend,
 *               GET /api/retro/cards
 *
 * Exposes the retro/train/teamLeader run history, momentum trend view, and promotion
 * cards board as read-only JSON endpoints.
 * All routes are behind the existing /api AccessGuard.
 *
 * Routes:
 *   GET /api/retro/runs               → { runs: [{ slug, date, source, counts, statusMix }] }
 *   GET /api/retro/runs/:slug         → { slug, date, source, statusMix, agents:[…], skills:[…], knowledge:[…] }
 *   GET /api/retro/trend?category=<knowledge|agents|skills>
 *                                     → { category, lanes:[…], runs:[…], empty?, placeholder? }
 *   GET /api/retro/cards              → { cards: { <status>: [{ id, datum, ziel, regel, quelle, pr, status, art, kategorie, metric }] } }
 *
 * Security:
 *   - :slug validated against strict whitelist regex BEFORE any file/reader access (retro-view AC8).
 *   - category validated against explicit whitelist BEFORE any data access (retro-trend AC9).
 *   - No traversal: kein '..', kein '\', kein Null-Byte.
 *   - Read-only; no new secrets; no new authorization.
 *   - Behind existing /api AccessGuard via server.js registration.
 *
 * @module retroRouter
 */

import { Router } from 'express';

/**
 * Valid category values for GET /api/retro/trend (AC9 retro-trend-backend).
 * Validated BEFORE any data/file access.
 */
const VALID_TREND_CATEGORIES = new Set(['knowledge', 'agents', 'skills']);

/**
 * Whitelist for :slug in /api/retro/runs/:slug.
 * Allows alphanumerics, dots, underscores, hyphens, and forward slashes
 * (for multi-segment slugs like retro/PR-Q1234-coder-R01).
 * Explicitly rejects '..', '\', null bytes.
 *
 * Spec AC8: ^[a-zA-Z0-9._/-]+$, no '..', no '\', no null byte.
 */
const VALID_SLUG_RE = /^[a-zA-Z0-9._/-]+$/;

/**
 * Validate a slug against the whitelist (AC8).
 *
 * @param {string} slug
 * @returns {boolean}
 */
function isValidSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  if (!VALID_SLUG_RE.test(slug)) return false;
  if (slug.includes('..')) return false;
  if (slug.includes('\\')) return false;
  if (slug.includes('\0')) return false;
  return true;
}

/**
 * Create the retro router.
 *
 * @param {object} options
 * @param {import('./RetroReader.js').RetroReader} options.retroReader
 * @returns {import('express').Router}
 */
export function retroRouter({ retroReader }) {
  const router = Router();

  /**
   * GET /api/retro/cards
   *
   * Returns all promotion cards from LEARNINGS.md grouped by status.
   * Read-only; missing LEARNINGS.md → valid empty response, no crash (AC1/AC2).
   */
  router.get('/api/retro/cards', async (_req, res) => {
    const result = await retroReader.getPromotionCards();
    res.json(result);
  });

  /**
   * GET /api/retro/runs
   *
   * Returns the overview of all retro/train/teamLeader runs.
   * No individual rule texts are included (AC1).
   * Degrades to empty list (200) when LEARNINGS.md is missing (AC9).
   */
  router.get('/api/retro/runs', async (_req, res) => {
    const result = await retroReader.getRuns();
    res.json(result);
  });

  /**
   * GET /api/retro/trend
   *
   * Returns the momentum-aggregated trend view for the requested category.
   *
   * Query param: category=knowledge|agents|skills (default: knowledge — AC1).
   * category is validated against VALID_TREND_CATEGORIES BEFORE any data access (AC9).
   *
   * Responds 400 for unknown category values (no 500, no guessing).
   * Responds 200 for valid category (including skills placeholder and Phase-0 empty — AC7/AC8).
   */
  router.get('/api/retro/trend', async (req, res) => {
    // AC1: default to 'knowledge' when category is absent
    const rawCategory = req.query.category;
    const category = (rawCategory === undefined || rawCategory === '')
      ? 'knowledge'
      : rawCategory;

    // AC9: validate category BEFORE any data/file access
    if (!VALID_TREND_CATEGORIES.has(category)) {
      return res.status(400).json({ error: 'invalid category' });
    }

    const result = await retroReader.getTrend(category);
    return res.json(result);
  });

  /**
   * GET /api/retro/runs/:slug
   *
   * Returns the full report for one run (entries grouped by category).
   *
   * :slug must match VALID_SLUG_RE (whitelist — no '..', no backslash, no null byte).
   * Validated BEFORE any file/reader access (AC8).
   *
   * Note: Express 5 (path-to-regexp 8) uses /*splat for multi-segment wildcards.
   * The splat param is an array of path segments; we join them to reconstruct
   * the full slug (e.g. ["retro", "PR-Q1234-coder-R01"] → "retro/PR-Q1234-coder-R01").
   *
   * Responds 404 for:
   *   - Invalid slug (traversal attempt, disallowed chars)
   *   - Unknown (valid but non-existent) slug
   * Responds 200 with metric: null throughout when baseline.json is missing/empty (AC7).
   */
  router.get('/api/retro/runs/*splat', async (req, res) => {
    // Reconstruct full slug from splat segments (Express 5 splat is an array)
    const splatParts = Array.isArray(req.params.splat)
      ? req.params.splat
      : [req.params.splat];
    const slug = splatParts.join('/');

    // AC8: validate slug BEFORE any access
    if (!isValidSlug(slug)) {
      return res.status(404).json({ error: 'Not found' });
    }

    const report = await retroReader.getRunReport(slug);
    if (!report) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json(report);
  });

  return router;
}
