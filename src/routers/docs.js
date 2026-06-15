/**
 * Router-Wrapper: Projekt-Doku-Endpunkte (read-only, lazy).
 * Factory-Signatur: create(deps) → Express Router
 *
 * Montiert:
 *   GET /api/board/projects/:slug/docs
 *   GET /api/board/projects/:slug/docs/raw?path=<relpfad>
 *
 * Hinter /api AccessGuard (via server.js-Verdrahtung app.use('/api', accessGuard)).
 */
import { docsRouter } from '../docsRouter.js';

export const order = 182;

/**
 * @param {{
 *   boardAggregator: import('../BoardAggregator.js').BoardAggregator,
 *   docsReader: import('../DocsReader.js').DocsReader,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ boardAggregator, docsReader }) {
  return docsRouter({ boardAggregator, docsReader });
}
