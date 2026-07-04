/**
 * @file BoardEventHub unit tests (board-live-sse AC1–AC7, S-285).
 *
 * Scope (board-live-sse.md):
 *   AC1 — SSE-Endpunkt Headers + offener Stream (getestet via boardEventsRouter.test.js)
 *   AC3 — subscribe(res) & broadcast({ slug }) — BoardEventHub-Kern
 *   AC4 — Broadcast-Format: `data: {"slug":"<slug>"}\n\n`
 *   AC5 — Verbindungs-Lifecycle: close-Event-Handler, Schreibfehler-Cleanup, no crash
 *   AC6 — Heartbeat: periodischer Kommentar-Frame `: ping\n\n` (~25 s Intervall)
 *   AC7 — Ruhezustand: kein Polling, keine Daten-Events ohne broadcast-Aufruf
 *
 * Covers (board-live-sse):
 *   AC3, AC4, AC5, AC6, AC7 — vollständig abgedeckt durch Unit-Tests
 *   AC1, AC2 — HTTP-Header/AccessGuard in boardEventsRouter.test.js
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { BoardEventHub } from '../src/BoardEventHub.js';

// ── Fake Response Object ──────────────────────────────────────────────────────

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.written = [];
  }

  write(data) {
    this.written.push(data);
  }

  simulateClose() {
    this.emit('close');
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BoardEventHub', () => {
  let hub;

  beforeEach(() => {
    hub = new BoardEventHub();
  });

  afterEach(() => {
    hub.shutdown();
  });

  // ── AC3: subscribe & broadcast ────────────────────────────────────────────

  describe('AC3 — subscribe(res) registriert Verbindung', () => {
    it('registriert eine Response-Verbindung', () => {
      const res = new FakeResponse();
      const unsub = hub.subscribe(res);

      expect(hub.connections.size).toBe(1);
      expect(hub.connections.has(res)).toBe(true);
      expect(typeof unsub).toBe('function');
    });

    it('gibt eine Unsubscribe-Funktion zurück', () => {
      const res = new FakeResponse();
      const unsub = hub.subscribe(res);

      unsub();

      expect(hub.connections.size).toBe(0);
      expect(hub.connections.has(res)).toBe(false);
    });
  });

  describe('AC4 — broadcast({ slug }) sendet SSE-Frames', () => {
    it('schreibt Daten-Frame mit korrektem Format', () => {
      const res = new FakeResponse();
      hub.subscribe(res);

      hub.broadcast({ slug: 'my-project' });

      expect(res.written).toHaveLength(1);
      expect(res.written[0]).toBe('data: {"slug":"my-project"}\n\n');
    });

    it('sendet an alle registrierten Verbindungen', () => {
      const res1 = new FakeResponse();
      const res2 = new FakeResponse();
      const res3 = new FakeResponse();

      hub.subscribe(res1);
      hub.subscribe(res2);
      hub.subscribe(res3);

      hub.broadcast({ slug: 'test-project' });

      expect(res1.written).toHaveLength(1);
      expect(res2.written).toHaveLength(1);
      expect(res3.written).toHaveLength(1);

      const expected = 'data: {"slug":"test-project"}\n\n';
      expect(res1.written[0]).toBe(expected);
      expect(res2.written[0]).toBe(expected);
      expect(res3.written[0]).toBe(expected);
    });

    it('ignoriert ungültige Payloads (keine slug)', () => {
      const res = new FakeResponse();
      hub.subscribe(res);

      hub.broadcast({}); // missing slug
      hub.broadcast(null);
      hub.broadcast(undefined);

      expect(res.written).toHaveLength(0);
    });

    it('ignoriert Payload mit nicht-String slug', () => {
      const res = new FakeResponse();
      hub.subscribe(res);

      hub.broadcast({ slug: 123 });
      hub.broadcast({ slug: null });

      expect(res.written).toHaveLength(0);
    });
  });

  // ── AC5: Verbindungs-Lifecycle & Fehlerbehandlung ─────────────────────────

  describe('AC5 — Verbindungs-Lifecycle (close-Event)', () => {
    it('entfernt Verbindung bei close-Event', () => {
      const res = new FakeResponse();
      hub.subscribe(res);

      expect(hub.connections.size).toBe(1);

      res.simulateClose();

      expect(hub.connections.size).toBe(0);
    });

    it('stoppt keinen anderen Listener auf close', () => {
      const res = new FakeResponse();
      hub.subscribe(res);

      const otherCloseListener = jest.fn();
      res.on('close', otherCloseListener);

      res.simulateClose();

      expect(otherCloseListener).toHaveBeenCalled();
    });
  });

  describe('AC5 — Broadcast-Fehlerbehandlung (Schreibfehler)', () => {
    it('entfernt Verbindung, die beim Schreiben wirft', () => {
      const res1 = new FakeResponse();
      const res2 = new FakeResponse();

      res1.write = () => {
        throw new Error('Connection lost');
      };

      hub.subscribe(res1);
      hub.subscribe(res2);

      expect(hub.connections.size).toBe(2);

      hub.broadcast({ slug: 'test' });

      // res1 sollte entfernt sein (Fehler), res2 bleibt
      expect(hub.connections.size).toBe(1);
      expect(hub.connections.has(res1)).toBe(false);
      expect(hub.connections.has(res2)).toBe(true);

      // res2 sollte das Frame erhalten haben
      expect(res2.written).toHaveLength(1);
    });

    it('wirft nicht bei Broadcast auf tote Verbindung', () => {
      const res = new FakeResponse();
      res.write = () => {
        throw new Error('Dead connection');
      };

      hub.subscribe(res);

      // Sollte nicht werfen
      expect(() => {
        hub.broadcast({ slug: 'test' });
      }).not.toThrow();
    });

    it('stört andere Verbindungen nicht bei Fehler einer', () => {
      const res1 = new FakeResponse();
      const res2 = new FakeResponse();
      const res3 = new FakeResponse();

      res2.write = () => {
        throw new Error('Error in res2');
      };

      hub.subscribe(res1);
      hub.subscribe(res2);
      hub.subscribe(res3);

      hub.broadcast({ slug: 'test' });

      // res1 und res3 sollten erfolgreich geschrieben haben
      expect(res1.written).toHaveLength(1);
      expect(res3.written).toHaveLength(1);

      // res2 wurde entfernt
      expect(hub.connections.has(res2)).toBe(false);
    });
  });

  // ── AC6: Heartbeat ────────────────────────────────────────────────────────

  describe('AC6 — Heartbeat-Kommentar-Frame', () => {
    it('startet Heartbeat-Timer bei subscribe()', (done) => {
      const res = new FakeResponse();
      hub.HEARTBEAT_INTERVAL_MS = 50; // schneller für Test

      hub.subscribe(res);

      expect(hub.heartbeatTimer).not.toBeNull();

      setTimeout(() => {
        // Nach ~50ms sollte mindestens ein Heartbeat gesendet sein
        const heartbeats = res.written.filter((f) => f === ': ping\n\n');
        expect(heartbeats.length).toBeGreaterThanOrEqual(1);
        done();
      }, 100);
    });

    it('sendet Heartbeat-Frame im korrekten Format', (done) => {
      const res = new FakeResponse();
      hub.HEARTBEAT_INTERVAL_MS = 50;

      hub.subscribe(res);

      setTimeout(() => {
        expect(res.written.length).toBeGreaterThan(0);
        expect(res.written.some((f) => f === ': ping\n\n')).toBe(true);
        done();
      }, 100);
    });

    it('stoppt Heartbeat-Timer, wenn keine Verbindungen mehr offen', (done) => {
      const res = new FakeResponse();
      hub.HEARTBEAT_INTERVAL_MS = 50;

      hub.subscribe(res);
      expect(hub.heartbeatTimer).not.toBeNull();

      res.simulateClose();
      expect(hub.heartbeatTimer).toBeNull();

      done();
    });

    it('stoppt Heartbeat-Timer bei shutdown()', (done) => {
      const res = new FakeResponse();
      hub.HEARTBEAT_INTERVAL_MS = 50;

      hub.subscribe(res);
      expect(hub.heartbeatTimer).not.toBeNull();

      hub.shutdown();

      expect(hub.heartbeatTimer).toBeNull();
      expect(hub.connections.size).toBe(0);

      done();
    });

    it('entfernt tote Verbindungen beim Heartbeat', (done) => {
      const res1 = new FakeResponse();
      const res2 = new FakeResponse();

      res1.write = (data) => {
        if (data === ': ping\n\n') {
          throw new Error('Dead connection');
        }
      };

      hub.HEARTBEAT_INTERVAL_MS = 50;
      hub.subscribe(res1);
      hub.subscribe(res2);

      expect(hub.connections.size).toBe(2);

      setTimeout(() => {
        // Nach Heartbeat sollte res1 entfernt sein (Fehler beim Schreiben von Heartbeat)
        expect(hub.connections.has(res1)).toBe(false);
        expect(hub.connections.has(res2)).toBe(true);

        done();
      }, 100);
    });
  });

  // ── AC7: Ruhezustand ──────────────────────────────────────────────────────

  describe('AC7 — Ruhezustand (kein Polling)', () => {
    it('sendet keine Daten ohne broadcast() oder Heartbeat', (done) => {
      const res = new FakeResponse();
      hub.HEARTBEAT_INTERVAL_MS = 50;

      hub.subscribe(res);

      setTimeout(() => {
        // Nur Heartbeat-Frames sollten gesendet sein, keine `data:` Frames
        const dataFrames = res.written.filter((f) => f.startsWith('data:'));
        expect(dataFrames).toHaveLength(0);
        done();
      }, 60);
    });
  });

  // ── Integration ───────────────────────────────────────────────────────────

  describe('Integration: broadcast & Heartbeat', () => {
    it('sendet broadcast-Frame und danach Heartbeats', (done) => {
      const res = new FakeResponse();
      hub.HEARTBEAT_INTERVAL_MS = 50;

      hub.subscribe(res);
      hub.broadcast({ slug: 'test' });

      setTimeout(() => {
        const dataFrames = res.written.filter((f) => f.startsWith('data:'));
        const heartbeats = res.written.filter((f) => f === ': ping\n\n');

        expect(dataFrames).toHaveLength(1);
        expect(dataFrames[0]).toBe('data: {"slug":"test"}\n\n');
        expect(heartbeats.length).toBeGreaterThanOrEqual(1);

        done();
      }, 100);
    });
  });
});
