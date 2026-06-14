/**
 * Router-Wrapper: Board-Aggregator (read-only Multi-Repo-Scan).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/board/projects, POST /api/board/projects/rescan
 */
import { boardRouter } from '../boardRouter.js';

export const order = 180;

/**
 * @param {{ boardAggregator: import('../BoardAggregator.js').BoardAggregator }} deps
 * @returns {import('express').Router}
 */
export function create({ boardAggregator }) {
  return boardRouter({ boardAggregator });
}
