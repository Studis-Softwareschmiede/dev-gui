/**
 * @file boardEventsRouter integration tests (board-live-sse AC1–AC7, S-285).
 *
 * Scope (board-live-sse.md):
 *   AC1 — SSE-Endpunkt Headers (200, Content-Type: text/event-stream, Cache-Control: no-cache,
 *         Connection: keep-alive, X-Accel-Buffering: no) + offener Stream
 *   AC2 — Endpunkt liegt unter /api/* hinter AccessGuard (keine neuen Auth-Header)
 *   AC5 — Verbindung bleibt offen (close-Event wird verarbeitet)
 *
 * Covers (board-live-sse):
 *   AC1 — HTTP-Header-Assertions (both mock-Ebene + echter HTTP-Roundtrip)
 *   AC5 — Verbindungs-Lifecycle (subscribe & Hub-Registrierung)
 *   AC2 — Anmerkung: AccessGuard-Test fehlt (würde /api.*-Integration mit echtem
 *         AccessGuard brauchen); Standard-Router-Unit-Test-Limitation.
 */

import { describe, it, expect } from '@jest/globals';
import http from 'http';
import express from 'express';
import { BoardEventHub } from '../src/BoardEventHub.js';
import { boardEventsRouter } from '../src/boardEventsRouter.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('boardEventsRouter', () => {
  /**
   * Covers: AC1 — SSE-Endpunkt Headers
   */
  describe('AC1 — GET /api/board/events Headers', () => {
    let hub;

    afterEach(() => {
      // Heartbeat-Timer und Verbindungen cleanup
      if (hub) {
        hub.shutdown();
      }
    });

    it('antwortet mit Status 200', (done) => {
      // Manually create a mock request/response since we need to inspect headers

      const mockRes = {
        statusCode: null,
        headers: {},
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(key, value) {
          this.headers[key] = value;
        },
        flushHeaders() {
          // Mock: no-op (in echtem HTTP würde das die Headers sofort senden)
        },
        write(_data) {
          // SSE stream write
        },
        on() {
          // Mock event handler
        },
        removeListener() {
          // Mock event handler
        },
      };

      const mockReq = {};

      // Invoke the route handler directly
      hub = new BoardEventHub();
      const router = boardEventsRouter({ boardEventHub: hub });
      router.stack[0].route.stack[0].handle(mockReq, mockRes);

      expect(mockRes.statusCode).toBe(200);
      done();
    });

    it('setzt Content-Type: text/event-stream', (done) => {
      const mockRes = {
        statusCode: null,
        headers: {},
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(key, value) {
          this.headers[key] = value;
        },
        flushHeaders() {},
        write() {},
        on() {},
        removeListener() {},
      };

      const mockReq = {};

      hub = new BoardEventHub();
      const router = boardEventsRouter({ boardEventHub: hub });
      router.stack[0].route.stack[0].handle(mockReq, mockRes);

      expect(mockRes.headers['Content-Type']).toBe('text/event-stream');
      done();
    });

    it('setzt Cache-Control: no-cache', (done) => {
      const mockRes = {
        statusCode: null,
        headers: {},
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(key, value) {
          this.headers[key] = value;
        },
        flushHeaders() {},
        write() {},
        on() {},
        removeListener() {},
      };

      const mockReq = {};

      hub = new BoardEventHub();
      const router = boardEventsRouter({ boardEventHub: hub });
      router.stack[0].route.stack[0].handle(mockReq, mockRes);

      expect(mockRes.headers['Cache-Control']).toBe('no-cache');
      done();
    });

    it('setzt Connection: keep-alive', (done) => {
      const mockRes = {
        statusCode: null,
        headers: {},
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(key, value) {
          this.headers[key] = value;
        },
        flushHeaders() {},
        write() {},
        on() {},
        removeListener() {},
      };

      const mockReq = {};

      hub = new BoardEventHub();
      const router = boardEventsRouter({ boardEventHub: hub });
      router.stack[0].route.stack[0].handle(mockReq, mockRes);

      expect(mockRes.headers['Connection']).toBe('keep-alive');
      done();
    });

    it('setzt X-Accel-Buffering: no', (done) => {
      const mockRes = {
        statusCode: null,
        headers: {},
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(key, value) {
          this.headers[key] = value;
        },
        flushHeaders() {},
        write() {},
        on() {},
        removeListener() {},
      };

      const mockReq = {};

      hub = new BoardEventHub();
      const router = boardEventsRouter({ boardEventHub: hub });
      router.stack[0].route.stack[0].handle(mockReq, mockRes);

      expect(mockRes.headers['X-Accel-Buffering']).toBe('no');
      done();
    });
  });

  /**
   * Covers: AC5 — Verbindung bleibt offen
   */
  describe('AC5 — Verbindung bleibt offen', () => {
    let hub;

    afterEach(() => {
      // Heartbeat-Timer und Verbindungen cleanup
      if (hub) {
        hub.shutdown();
      }
    });

    it('registriert Response im BoardEventHub', (done) => {
      hub = new BoardEventHub();
      const mockRes = {
        statusCode: null,
        headers: {},
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader() {},
        flushHeaders() {},
        write() {},
        on() {},
        removeListener() {},
      };

      const mockReq = {};

      const router = boardEventsRouter({ boardEventHub: hub });
      router.stack[0].route.stack[0].handle(mockReq, mockRes);

      // Response sollte im Hub registriert sein
      expect(hub.connections.size).toBe(1);

      done();
    });
  });

  /**
   * Covers: AC1 — HTTP-Ebenen-Test (echter HTTP-Roundtrip)
   *
   * Dieser Test verifiziert über eine echte HTTP-Verbindung (nicht nur mocked),
   * dass die Response-Header sofort beim Client ankommen — OHNE auf den
   * Heartbeat zu warten (~25 s). Dies war ein Bug (Finding 1): ohne flushHeaders()
   * puffert Express die Headers intern.
   */
  describe('AC1 — HTTP-Roundtrip: Headers sofort, ohne Heartbeat zu warten', () => {
    it('antwortet sofort mit Status 200 und SSE-Headern (echter HTTP-Request)', () => {
      return new Promise((resolve, reject) => {
        const app = express();
        const hub = new BoardEventHub();

        // Router auf /board/events mounten (ohne /api Prefix für diesen Test)
        app.use(boardEventsRouter({ boardEventHub: hub }));

        const server = app.listen(0); // port 0 = zufälliger verfügbarer Port

        const cleanup = () => {
          server.close();
          hub.shutdown();
        };

        server.on('listening', () => {
          const port = server.address().port;
          let connectionClosed = false;

          // Timer: Wenn wir innerhalb von 3 Sekunden keine Antwort-Header bekommen,
          // schlägt der Test fehl. Der Heartbeat wäre ~25 s später — dies testet,
          // dass wir flushHeaders() aufrufen, nicht auf den Heartbeat warten.
          const timeoutHandle = setTimeout(() => {
            if (!connectionClosed) {
              connectionClosed = true;
              req.abort();
              cleanup();
              reject(new Error('Timeout: Response-Header kamen nicht schnell genug an (warte auf flushHeaders)'));
            }
          }, 3000);

          const req = http.get(`http://127.0.0.1:${port}/board/events`, (res) => {
            try {
              // Headers sollten sofort da sein
              expect(res.statusCode).toBe(200);
              expect(res.headers['content-type']).toBe('text/event-stream');
              expect(res.headers['cache-control']).toBe('no-cache');
              expect(res.headers['connection']).toBe('keep-alive');
              expect(res.headers['x-accel-buffering']).toBe('no');

              clearTimeout(timeoutHandle);
              connectionClosed = true;

              // Verbindung abbrechen
              req.abort();

              cleanup();
              resolve();
            } catch (err) {
              clearTimeout(timeoutHandle);
              connectionClosed = true;
              req.abort();
              cleanup();
              reject(err);
            }
          });

          req.on('error', (err) => {
            if (!connectionClosed && err.code !== 'ECONNRESET') {
              // ECONNRESET ist erwartet, wenn wir die Verbindung abbrechen
              clearTimeout(timeoutHandle);
              connectionClosed = true;
              cleanup();
              reject(err);
            }
          });
        });

        server.on('close', () => {
          // Server ist geschlossen
        });

        server.on('error', (err) => {
          cleanup();
          reject(err);
        });
      });
    });
  });
});
