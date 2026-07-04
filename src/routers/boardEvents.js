/**
 * Router-Wrapper: Board-Live-SSE-Endpunkt
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/board/events
 *
 * Spec: docs/specs/board-live-sse.md (AC1–AC7, Backend)
 * Hinter /api AccessGuard (via server.js-Verdrahtung).
 * In-process Pub/Sub für Server-Sent-Events (BoardEventHub).
 */

import { boardEventsRouter } from '../boardEventsRouter.js';

export const order = 185;

/**
 * @param {{
 *   boardEventHub: import('../BoardEventHub.js').BoardEventHub,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ boardEventHub }) {
  return boardEventsRouter({ boardEventHub });
}
