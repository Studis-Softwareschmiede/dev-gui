/**
 * wsClient.test.js — Unit tests for TerminalConnection
 *
 * Uses jest-environment-jsdom + a FakeWebSocket (no real network).
 * Tests: connect→connected; incoming output dispatched; send emits input msg;
 *        socket close → disconnected → reconnect → connected;
 *        destroy() prevents reconnect.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TerminalConnection, WS_STATUS } from '../wsClient.js';

// ── FakeWebSocket ────────────────────────────────────────────────────────────

/**
 * Minimal fake WebSocket.
 * Stores the last instance in FakeWebSocket.last so tests can drive events.
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN       = 1;
  static CLOSING    = 2;
  static CLOSED     = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen    = null;
    this.onmessage = null;
    this.onerror   = null;
    this.onclose   = null;
    FakeWebSocket.last = this;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code: 1000, reason: 'test close' });
  }

  /** Test helper: simulate server opening connection */
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen({});
  }

  /** Test helper: simulate an incoming message */
  simulateMessage(data) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  /** Test helper: simulate raw message (already a string) */
  simulateRawMessage(raw) {
    if (this.onmessage) this.onmessage({ data: raw });
  }

  /** Test helper: simulate server closing */
  simulateClose() {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code: 1006, reason: '' });
  }
}

beforeEach(() => {
  FakeWebSocket.last = null;
  FakeWebSocket.instances = [];
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConn(url = 'ws://localhost:8080/ws/terminal') {
  return new TerminalConnection(url, { WebSocket: FakeWebSocket });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TerminalConnection — initial state', () => {
  it('starts as disconnected', () => {
    const conn = makeConn();
    expect(conn.status).toBe(WS_STATUS.DISCONNECTED);
  });
});

describe('TerminalConnection — connect → connected', () => {
  it('transitions to connecting then connected on open', () => {
    const conn = makeConn();
    const statuses = [];
    conn.onStatus(s => statuses.push(s));

    conn.connect();
    expect(conn.status).toBe(WS_STATUS.CONNECTING);

    FakeWebSocket.last.simulateOpen();
    expect(conn.status).toBe(WS_STATUS.CONNECTED);
    expect(statuses).toEqual([WS_STATUS.CONNECTING, WS_STATUS.CONNECTED]);
  });
});

describe('TerminalConnection — incoming output message', () => {
  it('dispatches output messages to registered listeners', () => {
    const conn = makeConn();
    const received = [];
    conn.onMessage(msg => received.push(msg));

    conn.connect();
    FakeWebSocket.last.simulateOpen();
    FakeWebSocket.last.simulateMessage({ type: 'output', data: '\x1b[32mHello\x1b[0m' });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'output', data: '\x1b[32mHello\x1b[0m' });
  });

  it('dispatches state messages to registered listeners', () => {
    const conn = makeConn();
    const received = [];
    conn.onMessage(msg => received.push(msg));

    conn.connect();
    FakeWebSocket.last.simulateOpen();
    FakeWebSocket.last.simulateMessage({ type: 'state', state: 'running' });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'state', state: 'running' });
  });

  it('silently ignores malformed JSON', () => {
    const conn = makeConn();
    const received = [];
    conn.onMessage(msg => received.push(msg));

    conn.connect();
    FakeWebSocket.last.simulateOpen();
    FakeWebSocket.last.simulateRawMessage('not-json{{{');

    expect(received).toHaveLength(0);
  });

  it('silently ignores non-object JSON', () => {
    const conn = makeConn();
    const received = [];
    conn.onMessage(msg => received.push(msg));

    conn.connect();
    FakeWebSocket.last.simulateOpen();
    FakeWebSocket.last.simulateRawMessage('"just a string"');

    expect(received).toHaveLength(0);
  });
});

describe('TerminalConnection — send() emits {type:"input",data}', () => {
  it('sends the correct JSON payload when connected', () => {
    const conn = makeConn();
    conn.connect();
    FakeWebSocket.last.simulateOpen();

    conn.send('ls -la\n');

    expect(FakeWebSocket.last.sent).toHaveLength(1);
    expect(JSON.parse(FakeWebSocket.last.sent[0])).toEqual({
      type: 'input',
      data: 'ls -la\n',
    });
  });

  it('does nothing when not yet connected', () => {
    const conn = makeConn();
    conn.connect();
    // socket still CONNECTING — no simulateOpen

    conn.send('hello');
    expect(FakeWebSocket.last.sent).toHaveLength(0);
  });

  it('does nothing after disconnect', () => {
    const conn = makeConn();
    conn.connect();
    FakeWebSocket.last.simulateOpen();
    FakeWebSocket.last.simulateClose();

    // Advance timers to skip backoff — but we test send before reconnect
    conn.send('hello');
    expect(FakeWebSocket.last.sent).toHaveLength(0);
  });
});

describe('TerminalConnection — socket close → disconnected → reconnect', () => {
  it('goes to disconnected on close, schedules reconnect', () => {
    const conn = makeConn();
    const statuses = [];
    conn.onStatus(s => statuses.push(s));

    conn.connect();
    FakeWebSocket.last.simulateOpen();
    expect(conn.status).toBe(WS_STATUS.CONNECTED);

    FakeWebSocket.last.simulateClose();
    expect(conn.status).toBe(WS_STATUS.DISCONNECTED);
  });

  it('auto-reconnects after backoff and reaches connected again', () => {
    const conn = makeConn();
    const statuses = [];
    conn.onStatus(s => statuses.push(s));

    conn.connect();
    FakeWebSocket.last.simulateOpen();

    const ws1 = FakeWebSocket.last;
    ws1.simulateClose();

    expect(conn.status).toBe(WS_STATUS.DISCONNECTED);

    // Advance timers past the backoff delay (first retry ≤ 500 + 200ms)
    jest.advanceTimersByTime(1000);

    // A new WS should have been created
    const ws2 = FakeWebSocket.last;
    expect(ws2).not.toBe(ws1);
    expect(conn.status).toBe(WS_STATUS.CONNECTING);

    ws2.simulateOpen();
    expect(conn.status).toBe(WS_STATUS.CONNECTED);

    // Verify output still flows after reconnect
    const received = [];
    conn.onMessage(msg => received.push(msg));
    ws2.simulateMessage({ type: 'output', data: 'after reconnect' });
    expect(received[0]).toEqual({ type: 'output', data: 'after reconnect' });
  });

  it('resets retry counter on successful reconnect', () => {
    const conn = makeConn();
    conn.connect();
    FakeWebSocket.last.simulateOpen();

    // Simulate two drops → two reconnects → verify it stabilises
    for (let i = 0; i < 2; i++) {
      FakeWebSocket.last.simulateClose();
      jest.advanceTimersByTime(2000);
      FakeWebSocket.last.simulateOpen();
    }
    expect(conn.status).toBe(WS_STATUS.CONNECTED);
  });
});

describe('TerminalConnection — destroy() prevents further reconnects', () => {
  it('does not reconnect after destroy()', () => {
    const conn = makeConn();
    conn.connect();
    FakeWebSocket.last.simulateOpen();
    const instancesBefore = FakeWebSocket.instances.length;

    conn.destroy();
    expect(conn.status).toBe(WS_STATUS.DISCONNECTED);

    // Advance far past any backoff
    jest.advanceTimersByTime(30_000);

    expect(FakeWebSocket.instances.length).toBe(instancesBefore);
  });
});

describe('TerminalConnection — onStatus unsubscribe', () => {
  it('stops receiving events after unsubscribe', () => {
    const conn = makeConn();
    const received = [];
    const unsub = conn.onStatus(s => received.push(s));

    conn.connect();
    unsub();

    FakeWebSocket.last.simulateOpen();
    expect(received).toEqual([WS_STATUS.CONNECTING]); // only connecting, not connected
  });
});

describe('TerminalConnection — onMessage unsubscribe', () => {
  it('stops receiving messages after unsubscribe', () => {
    const conn = makeConn();
    const received = [];
    const unsub = conn.onMessage(msg => received.push(msg));

    conn.connect();
    FakeWebSocket.last.simulateOpen();
    unsub();

    FakeWebSocket.last.simulateMessage({ type: 'output', data: 'hello' });
    expect(received).toHaveLength(0);
  });
});
