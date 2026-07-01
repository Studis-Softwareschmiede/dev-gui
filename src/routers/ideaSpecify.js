/**
 * Router-Wrapper: Idee-Specify-Chat (Multi-Turn `claude -p`, start/message).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert:
 *   POST /api/board/projects/:slug/ideas/:id/specify/start   (idea-specify-chat AC3)
 *   POST /api/board/projects/:slug/ideas/:id/specify/message (idea-specify-chat AC4, AC13)
 *
 * order: 182 — nach board.js (180), das denselben `:slug/ideas/:id`-Präfix nutzt
 * (Ordering hier irrelevant für Express-Routing-Korrektheit, da unterschiedliche
 * Pfad-Suffixe, aber konsistent mit der Konvention „verwandte Router in
 * Slug-/Idee-Nachbarschaft nahe beieinander" — coder-Lesson 2026-06-14).
 *
 * Spec: docs/specs/idea-specify-chat.md AC3, AC4, AC5, AC13.
 */
import { ideaSpecifyRouter } from '../ideaSpecifyRouter.js';

export const order = 182;

/**
 * @param {{
 *   boardAggregator: import('../BoardAggregator.js').BoardAggregator,
 *   ideaSpecifyChatService: import('../IdeaSpecifyChatService.js').IdeaSpecifyChatService,
 *   auditStore: import('../AuditStore.js').AuditStore,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ boardAggregator, ideaSpecifyChatService, auditStore }) {
  return ideaSpecifyRouter({ boardAggregator, chatService: ideaSpecifyChatService, auditStore });
}
