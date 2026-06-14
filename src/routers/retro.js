/**
 * Router-Wrapper: Retro-Ansicht + Retro-Trend.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/retro/runs, GET /api/retro/runs/:slug, GET /api/retro/trend
 */
import { retroRouter } from '../retroRouter.js';

export const order = 170;

/**
 * @param {{ retroReader: import('../RetroReader.js').RetroReader }} deps
 * @returns {import('express').Router}
 */
export function create({ retroReader }) {
  return retroRouter({ retroReader });
}
