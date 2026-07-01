/**
 * Router-Wrapper: Board-Aggregator (read-only Multi-Repo-Scan) + Story-Detail
 * + Quick-Capture-Create (ideen-inbox AC3/AC4/AC7/AC8, S-199).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert:
 *   GET /api/board/projects, POST /api/board/projects/rescan,
 *   GET /api/board/projects/:slug/stories/:id/detail (AC2 story-detail-ansicht),
 *   POST /api/board/projects/:slug/ideas (ideen-inbox AC3 — Quick-Capture)
 */
import { boardRouter } from '../boardRouter.js';

export const order = 180;

/**
 * @param {{
 *   boardAggregator: import('../BoardAggregator.js').BoardAggregator,
 *   storyMetricReader: import('../StoryMetricReader.js').StoryMetricReader,
 *   notificationWatcher?: import('../NotificationWatcher.js').NotificationWatcher,
 *   boardWriter?: import('../BoardWriter.js').BoardWriter,
 *   auditStore?: import('../AuditStore.js').AuditStore,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ boardAggregator, storyMetricReader, notificationWatcher, boardWriter, auditStore }) {
  return boardRouter({ boardAggregator, storyMetricReader, notificationWatcher, boardWriter, auditStore });
}
