/**
 * Router-Wrapper: Board-Aggregator (read-only Multi-Repo-Scan) + Story-Detail
 * + Quick-Capture-Create (ideen-inbox AC3/AC4/AC7/AC8, S-199) + Besprechung/
 * Auflösung (ideen-inbox AC5/AC6/AC7/AC8, S-200).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert:
 *   GET /api/board/projects, POST /api/board/projects/rescan,
 *   GET /api/board/projects/:slug/stories/:id/detail (AC2 story-detail-ansicht),
 *   POST /api/board/projects/:slug/ideas (ideen-inbox AC3 — Quick-Capture),
 *   POST /api/board/projects/:slug/ideas/:id/discuss (ideen-inbox AC5, S-200),
 *   POST /api/board/projects/:slug/ideas/:id/resolve (ideen-inbox AC6, S-200)
 *
 * commandService/sessionRegistry (S-200 AC5): bereits im server.js-deps-Objekt
 * vorhanden (CommandService/PtySessionRegistry-Composition-Root für den
 * Flow-Trigger/Terminal-Pfad) — hier zusätzlich für den Besprechungs-Endpunkt
 * verdrahtet (kein neuer server.js-Eintrag nötig).
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
 *   commandService?: import('../CommandService.js').CommandService,
 *   sessionRegistry?: import('../PtySessionRegistry.js').PtySessionRegistry,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({
  boardAggregator,
  storyMetricReader,
  notificationWatcher,
  boardWriter,
  auditStore,
  commandService,
  sessionRegistry,
}) {
  return boardRouter({
    boardAggregator,
    storyMetricReader,
    notificationWatcher,
    boardWriter,
    auditStore,
    commandService,
    sessionRegistry,
  });
}
