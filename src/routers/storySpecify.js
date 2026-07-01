/**
 * Router-Wrapper: Neue-Story-Chat („from scratch", ohne Idee-Karte) —
 * Multi-Turn `claude -p`-Chat (start/message) + headless `requirement`-Finalizer
 * (finalize/finalize/:jobId).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert:
 *   POST /api/board/projects/:slug/story-specify/start          (new-story-chat AC2)
 *   POST /api/board/projects/:slug/story-specify/message        (new-story-chat AC3)
 *   POST /api/board/projects/:slug/story-specify/finalize       (new-story-chat AC4)
 *   GET  /api/board/projects/:slug/story-specify/finalize/:jobId (new-story-chat AC5)
 *
 * order: 183 — nach board.js (180) und ideaSpecify.js (182), die verwandte
 * `:slug`-Präfixe nutzen (Ordering hier irrelevant für Express-Routing-
 * Korrektheit, da unterschiedliche Pfad-Suffixe, aber konsistent mit der
 * Konvention „verwandte Router in Slug-Nachbarschaft nahe beieinander").
 *
 * Wiederverwendung (new-story-chat AC8): NUTZT DIESELBE `IdeaSpecifyChatService`-
 * Instanz wie ideaSpecify.js (kein neuer Chat-Service — Sessions sind
 * UUID-basiert, keine Kollision). Der Finalizer ist der schlanke
 * `StorySpecifyFinalizer` (eigener `HeadlessFlowRunner` + eigenes
 * `ProjectJobLock`, „from scratch"-Prompt ohne Idee-Hinweis).
 *
 * Spec: docs/specs/new-story-chat.md AC2, AC3, AC4, AC5, AC8.
 */
import { storySpecifyRouter } from '../storySpecifyRouter.js';

export const order = 183;

/**
 * @param {{
 *   boardAggregator: import('../BoardAggregator.js').BoardAggregator,
 *   ideaSpecifyChatService: import('../IdeaSpecifyChatService.js').IdeaSpecifyChatService,
 *   storySpecifyFinalizer: import('../StorySpecifyFinalizer.js').StorySpecifyFinalizer,
 *   auditStore: import('../AuditStore.js').AuditStore,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ boardAggregator, ideaSpecifyChatService, storySpecifyFinalizer, auditStore }) {
  return storySpecifyRouter({
    boardAggregator,
    chatService: ideaSpecifyChatService,
    finalizer: storySpecifyFinalizer,
    auditStore,
  });
}
