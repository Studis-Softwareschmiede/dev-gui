/**
 * Router-Wrapper: Board-Aggregator (read-only Multi-Repo-Scan) + Story-Detail.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert:
 *   GET /api/board/projects, POST /api/board/projects/rescan,
 *   GET /api/board/projects/:slug/stories/:id/detail (AC2 story-detail-ansicht)
 */
import { boardRouter } from '../boardRouter.js';

export const order = 180;

/**
 * @param {{
 *   boardAggregator: import('../BoardAggregator.js').BoardAggregator,
 *   storyMetricReader: import('../StoryMetricReader.js').StoryMetricReader,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ boardAggregator, storyMetricReader }) {
  return boardRouter({ boardAggregator, storyMetricReader });
}
