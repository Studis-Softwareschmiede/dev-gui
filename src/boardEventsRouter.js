/**
 * boardEventsRouter.js — SSE-Endpunkt GET /api/board/events
 *
 * Spec: docs/specs/board-live-sse.md (AC1–AC7, Backend)
 * Öffnet eine Server-Sent-Events-Verbindung und registriert sie im `BoardEventHub`.
 *
 * AC1: Response mit Status 200, Content-Type: text/event-stream, Cache-Control: no-cache,
 *      Connection: keep-alive, X-Accel-Buffering: no; Verbindung bleibt offen.
 * AC2: Der Endpunkt liegt unter /api/* und passiert damit den AccessGuard (keine
 *      neuen Auth-Header nötig — same-origin Cloudflare-Access-Cookie).
 * AC3: BoardEventHub verwaltet die Verbindungen; subscribe() registriert,
 *      broadcast() schreibt an alle.
 * AC5: Bei Request-`close` wird die Verbindung entfernt (kein Leak).
 */

import express from 'express';

/**
 * Erstellt einen Express-Router mit dem SSE-Endpunkt.
 *
 * @param {{ boardEventHub: import('./BoardEventHub.js').BoardEventHub }} deps
 * @returns {import('express').Router}
 */
export function boardEventsRouter({ boardEventHub }) {
  const router = express.Router();

  /**
   * GET /api/board/events — SSE-Stream öffnen
   *
   * AC1: Headers + offener Stream.
   * AC5: Cleanup bei Request-`close`.
   */
  router.get('/board/events', (req, res) => {
    // AC1: SSE-Headers setzen
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.status(200);

    // AC1: Flush headers sofort an den Client — ohne flushHeaders() puffert Node
    // intern und der Client erhält Status+Header erst beim ersten write() (Heartbeat ~25s).
    res.flushHeaders();

    // AC3/AC5: Verbindung im Hub registrieren; cleanup bei close
    boardEventHub.subscribe(res);

    // AC7: Ruhezustand — keine Daten ohne broadcast-Aufruf
    // (nur Heartbeat-Kommentare alle ~25 s)
  });

  return router;
}
