/**
 * WsGateway unit tests (AC5 + AC6 routing).
 *
 * Uses a fake WebSocketServer + fake WebSocket to avoid any real network.
 * Tests: resize message routed to ptyManager.resize; scrollback replay on connect.
 */

import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { WsGateway } from '../src/WsGateway.js';

// ── Fake WebSocket ────────────────────────────────────────────────────────────

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.sent = [];
  }
  send(data) {
    this.sent.push(data);
  }
  // Helper: simulate an incoming message from the client
  simulateMessage(obj) {
    this.emit('message', JSON.stringify(obj));
  }
}

// ── Fake WebSocketServer ───────────────────────────────────────────────────────

class FakeWss extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }
  // Helper: simulate a new client connecting
  simulateConnection(socket) {
    this.clients.add(socket);
    this.emit('connection', socket);
  }
}

// ── Fake PtyManager ───────────────────────────────────────────────────────────

class FakePty extends EventEmitter {
  constructor(scrollbackContent = '') {
    super();
    this.state = 'ready';
    this._scrollback = scrollbackContent;
    this.resizeCalls = [];
    this.writeCalls  = [];
  }
  get scrollback() { return this._scrollback; }
  resize(cols, rows) { this.resizeCalls.push({ cols, rows }); }
  write(data) { this.writeCalls.push(data); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGateway(scrollbackContent = '') {
  const wss = new FakeWss();
  const pty = new FakePty(scrollbackContent);
  const gw  = new WsGateway(wss, pty);
  return { wss, pty, gw };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WsGateway — AC5: resize message routed to ptyManager.resize', () => {
  it('routes {type:"resize"} to ptyManager.resize(cols, rows)', () => {
    const { wss, pty } = makeGateway();
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'resize', cols: 120, rows: 40 });

    expect(pty.resizeCalls).toHaveLength(1);
    expect(pty.resizeCalls[0]).toEqual({ cols: 120, rows: 40 });
  });

  it('calls ptyManager.resize even for invalid dims (validation inside PtyManager)', () => {
    // WsGateway passes whatever is in the message; PtyManager validates.
    // This test verifies routing, not validation (which is PtyManager's job).
    const { wss, pty } = makeGateway();
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'resize', cols: 0, rows: 24 });

    // resize is called with the raw values — PtyManager decides to ignore them
    expect(pty.resizeCalls).toHaveLength(1);
    expect(pty.resizeCalls[0]).toEqual({ cols: 0, rows: 24 });
  });

  it('does not write to PTY on resize messages', () => {
    const { wss, pty } = makeGateway();
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'resize', cols: 80, rows: 24 });

    expect(pty.writeCalls).toHaveLength(0);
  });
});

describe('WsGateway — AC6: scrollback replay on connect', () => {
  it('sends buffered scrollback as {type:"output"} immediately on connect', () => {
    const SCROLLBACK = '\x1b[2JHello from scrollback';
    const { wss } = makeGateway(SCROLLBACK);
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    // First message must be the scrollback replay
    const firstMsg = JSON.parse(ws.sent[0]);
    expect(firstMsg).toEqual({ type: 'output', data: SCROLLBACK });
  });

  it('sends state message after scrollback replay', () => {
    const { wss } = makeGateway('some output');
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    // At minimum 2 messages: scrollback output + state
    expect(ws.sent.length).toBeGreaterThanOrEqual(2);
    const stateMsg = JSON.parse(ws.sent[1]);
    expect(stateMsg.type).toBe('state');
  });

  it('does not send a scrollback output message when buffer is empty', () => {
    const { wss } = makeGateway(''); // empty scrollback
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    // Only the state message should be sent on connect (no empty output)
    const msgs = ws.sent.map((s) => JSON.parse(s));
    const outputMsgs = msgs.filter((m) => m.type === 'output');
    expect(outputMsgs).toHaveLength(0);
  });

  it('a newly connected client receives scrollback; already-connected client does not get it again', () => {
    const SCROLLBACK = 'prior output';
    const { wss } = makeGateway(SCROLLBACK);

    const ws1 = new FakeSocket();
    wss.simulateConnection(ws1);
    const ws1SentCount = ws1.sent.length;

    const ws2 = new FakeSocket();
    wss.simulateConnection(ws2);

    // ws1 should not have received any additional messages from ws2's connect
    expect(ws1.sent.length).toBe(ws1SentCount);

    // ws2 should have received the scrollback
    const ws2Msgs = ws2.sent.map((s) => JSON.parse(s));
    expect(ws2Msgs[0]).toEqual({ type: 'output', data: SCROLLBACK });
  });
});
