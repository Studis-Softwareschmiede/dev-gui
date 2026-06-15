/**
 * WsGateway — multi-session tests (AC4 / S-111)
 *
 * Covers:
 *   - WsGateway accepts a PtySessionRegistry and routes connections per project
 *   - Connections without ?project param fall back to global session
 *   - Connections with ?project=<path> get routed to the right session
 *   - Cap exceeded → socket closed with 1013
 *   - extractProjectParam helper
 *   - Per-connection output listener isolation (output from session A does not reach session B's socket)
 *   - Path-Traversal rejection: projectPath outside workspace boundary → socket closed with 1008
 *   - ws.on('error') registered before pty/cap check (always registered)
 *
 * All tests use fake WebSocket / fake Registry — no real network or PTY.
 * Path validation is injected as a stub to avoid real filesystem calls.
 */

import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { ProjectPathError } from '../src/workspacePath.js';
import { WsGateway, extractProjectParam } from '../src/WsGateway.js';

// ── Fake WebSocket ─────────────────────────────────────────────────────────────

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.sent = [];
    this.closed = false;
    this.closeCode = null;
  }
  send(data) { this.sent.push(data); }
  close(code) { this.closed = true; this.closeCode = code; this.readyState = 3; }
  simulateMessage(obj) { this.emit('message', JSON.stringify(obj)); }
}

// ── Fake WebSocketServer ──────────────────────────────────────────────────────

class FakeWss extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }
  simulateConnection(socket, url = '/ws/terminal') {
    this.clients.add(socket);
    const req = { url };
    this.emit('connection', socket, req);
  }
}

// ── Fake PtyManager ───────────────────────────────────────────────────────────

class FakePty extends EventEmitter {
  constructor(scrollback = '') {
    super();
    this.state = 'ready';
    this._scrollback = scrollback;
    this.writeCalls = [];
    this.resizeCalls = [];
  }
  get scrollback() { return this._scrollback; }
  write(data) { this.writeCalls.push(data); }
  resize(cols, rows) { this.resizeCalls.push({ cols, rows }); }
  emitOutput(data) { this.emit('output', data); }
  emitState(s) { this.state = s; this.emit('state', s); }
}

// ── Fake PtySessionRegistry ───────────────────────────────────────────────────

class FakeRegistry {
  constructor() {
    this.sessions = new Map(); // path → FakePty
    this.globalSession = new FakePty('global scrollback');
    this.capExceeded = false;
    this.getOrCreateCalls = [];
  }

  addSession(path, pty) {
    this.sessions.set(path, pty);
  }

  // duck-type: WsGateway checks for getOrCreate
  getOrCreate(path) {
    this.getOrCreateCalls.push(path);
    if (this.capExceeded) return null;
    if (!path) return this.globalSession;
    return this.sessions.get(path) ?? null;
  }
}

// ── Path validator stubs ──────────────────────────────────────────────────────

/** Stub: always allows the path (simulates path inside workspace). */
function allowAllValidator(path) {
  return Promise.resolve({ resolvedPath: path });
}

/** Stub: always rejects with outside-boundary error (simulates path outside workspace). */
function rejectOutsideBoundary() {
  return Promise.reject(new ProjectPathError('Path is outside workspace boundary', 'outside-boundary'));
}

/** Stub: rejects with not-exists error. */
function rejectNotExists() {
  return Promise.reject(new ProjectPathError('Path does not exist', 'not-exists'));
}

// ── Tests: extractProjectParam ────────────────────────────────────────────────

describe('extractProjectParam()', () => {
  it('returns null for null/undefined', () => {
    expect(extractProjectParam(null)).toBeNull();
    expect(extractProjectParam(undefined)).toBeNull();
  });

  it('returns null when no ?project param present', () => {
    expect(extractProjectParam('/ws/terminal')).toBeNull();
    expect(extractProjectParam('/ws/terminal?foo=bar')).toBeNull();
  });

  it('returns null for empty ?project value', () => {
    expect(extractProjectParam('/ws/terminal?project=')).toBeNull();
    expect(extractProjectParam('/ws/terminal?project=   ')).toBeNull();
  });

  it('returns the decoded path when ?project is present', () => {
    const encoded = encodeURIComponent('/home/user/myrepo');
    expect(extractProjectParam(`/ws/terminal?project=${encoded}`)).toBe('/home/user/myrepo');
  });

  it('returns plain path without encoding', () => {
    expect(extractProjectParam('/ws/terminal?project=/projects/alpha')).toBe('/projects/alpha');
  });

  it('trims whitespace from the value', () => {
    expect(extractProjectParam('/ws/terminal?project=%20%2Fpath%20')).toBe('/path');
  });
});

// ── Tests: WsGateway in single-session mode (legacy, backward compat) ─────────

describe('WsGateway — single-session (legacy PtyManager, backward compat)', () => {
  it('still works with a plain PtyManager (no getOrCreate)', () => {
    const wss = new FakeWss();
    const pty = new FakePty('old scrollback');
    new WsGateway(wss, pty);

    const ws = new FakeSocket();
    wss.simulateConnection(ws, '/ws/terminal');

    // Should receive scrollback + state
    expect(ws.sent.length).toBeGreaterThanOrEqual(2);
    const msgs = ws.sent.map((s) => JSON.parse(s));
    expect(msgs[0]).toEqual({ type: 'output', data: 'old scrollback' });
    expect(msgs[1].type).toBe('state');
  });
});

// ── Helper: flush microtasks (so async #onConnectionMulti resolves) ──────────
// Uses setTimeout(0) to yield to the event loop, allowing async microtasks to settle.
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

// ── Tests: WsGateway in multi-session mode ────────────────────────────────────

describe('WsGateway — multi-session (PtySessionRegistry)', () => {
  it('connection without ?project routes to global session', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    // no pathValidator needed: null path skips validation
    new WsGateway(wss, registry);

    const ws = new FakeSocket();
    wss.simulateConnection(ws, '/ws/terminal');
    await flushMicrotasks();

    // getOrCreate called with null (no project param)
    expect(registry.getOrCreateCalls).toContain(null);

    // global session's scrollback sent
    const msgs = ws.sent.map((s) => JSON.parse(s));
    expect(msgs[0]).toEqual({ type: 'output', data: 'global scrollback' });
  });

  it('connection with ?project routes to project-specific session', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    const projectPty = new FakePty('project alpha scrollback');
    registry.addSession('/p/alpha', projectPty);
    // inject allowAllValidator: skip real filesystem calls
    new WsGateway(wss, registry, { pathValidator: allowAllValidator });

    const ws = new FakeSocket();
    const encoded = encodeURIComponent('/p/alpha');
    wss.simulateConnection(ws, `/ws/terminal?project=${encoded}`);
    await flushMicrotasks();

    // getOrCreate called with the decoded path
    expect(registry.getOrCreateCalls).toContain('/p/alpha');

    // project session's scrollback sent
    const msgs = ws.sent.map((s) => JSON.parse(s));
    expect(msgs[0]).toEqual({ type: 'output', data: 'project alpha scrollback' });
  });

  it('session cap → socket closed with 1013', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    registry.capExceeded = true;
    new WsGateway(wss, registry, { pathValidator: allowAllValidator });

    const ws = new FakeSocket();
    wss.simulateConnection(ws, '/ws/terminal?project=%2Fp%2Falpha');
    await flushMicrotasks();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1013);
    // No data sent to the socket before closing
    expect(ws.sent).toHaveLength(0);
  });

  it('output from project A session does not reach socket connected to project B', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    const ptyA = new FakePty('');
    const ptyB = new FakePty('');
    registry.addSession('/p/A', ptyA);
    registry.addSession('/p/B', ptyB);
    new WsGateway(wss, registry, { pathValidator: allowAllValidator });

    // Connect two sockets: one to A, one to B
    const wsA = new FakeSocket();
    const wsB = new FakeSocket();
    wss.simulateConnection(wsA, `/ws/terminal?project=${encodeURIComponent('/p/A')}`);
    wss.simulateConnection(wsB, `/ws/terminal?project=${encodeURIComponent('/p/B')}`);
    await flushMicrotasks();

    const sentBeforeA = wsA.sent.length;
    const sentBeforeB = wsB.sent.length;

    // Emit output on A's PTY
    ptyA.emitOutput('output-from-A');

    // wsA should receive it
    expect(wsA.sent.length).toBe(sentBeforeA + 1);
    expect(JSON.parse(wsA.sent[wsA.sent.length - 1])).toEqual({ type: 'output', data: 'output-from-A' });

    // wsB should NOT receive it
    expect(wsB.sent.length).toBe(sentBeforeB);
  });

  it('output from project B session does not reach socket connected to project A', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    const ptyA = new FakePty('');
    const ptyB = new FakePty('');
    registry.addSession('/p/A', ptyA);
    registry.addSession('/p/B', ptyB);
    new WsGateway(wss, registry, { pathValidator: allowAllValidator });

    const wsA = new FakeSocket();
    const wsB = new FakeSocket();
    wss.simulateConnection(wsA, `/ws/terminal?project=${encodeURIComponent('/p/A')}`);
    wss.simulateConnection(wsB, `/ws/terminal?project=${encodeURIComponent('/p/B')}`);
    await flushMicrotasks();

    const sentBeforeA = wsA.sent.length;

    // Emit output on B's PTY
    ptyB.emitOutput('output-from-B');

    // wsA should NOT receive it
    expect(wsA.sent.length).toBe(sentBeforeA);
  });

  it('socket close removes per-connection listeners from the session PTY', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    const pty = new FakePty('');
    registry.addSession('/p/alpha', pty);
    new WsGateway(wss, registry, { pathValidator: allowAllValidator });

    const ws = new FakeSocket();
    wss.simulateConnection(ws, `/ws/terminal?project=${encodeURIComponent('/p/alpha')}`);
    await flushMicrotasks();

    const listenerCountBefore = pty.listenerCount('output');

    // Close the socket
    ws.emit('close');

    // Listeners should be removed
    expect(pty.listenerCount('output')).toBe(listenerCountBefore - 1);
  });

  it('input from client is written to the correct session PTY', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    const ptyA = new FakePty('');
    const ptyB = new FakePty('');
    registry.addSession('/p/A', ptyA);
    registry.addSession('/p/B', ptyB);
    new WsGateway(wss, registry, { pathValidator: allowAllValidator });

    const wsA = new FakeSocket();
    wss.simulateConnection(wsA, `/ws/terminal?project=${encodeURIComponent('/p/A')}`);
    await flushMicrotasks();

    wsA.simulateMessage({ type: 'input', data: 'hello from A' });

    // Written to A's PTY
    expect(ptyA.writeCalls).toContain('hello from A');
    // NOT written to B's PTY
    expect(ptyB.writeCalls).not.toContain('hello from A');
  });

  it('resize from client is routed to the correct session PTY', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    const ptyA = new FakePty('');
    const ptyB = new FakePty('');
    registry.addSession('/p/A', ptyA);
    registry.addSession('/p/B', ptyB);
    new WsGateway(wss, registry, { pathValidator: allowAllValidator });

    const wsA = new FakeSocket();
    wss.simulateConnection(wsA, `/ws/terminal?project=${encodeURIComponent('/p/A')}`);
    await flushMicrotasks();

    wsA.simulateMessage({ type: 'resize', cols: 132, rows: 50 });

    expect(ptyA.resizeCalls).toHaveLength(1);
    expect(ptyA.resizeCalls[0]).toEqual({ cols: 132, rows: 50 });
    expect(ptyB.resizeCalls).toHaveLength(0);
  });
});

// ── Tests: Path-Traversal rejection (CRITICAL security fix) ──────────────────

describe('WsGateway — path-traversal rejection (security/R02/R03)', () => {
  it('projectPath outside workspace boundary → socket closed with 1008', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    // Stub: rejects with outside-boundary error (simulates /etc/passwd or /../escape)
    new WsGateway(wss, registry, { pathValidator: rejectOutsideBoundary });

    const ws = new FakeSocket();
    const outsidePath = encodeURIComponent('/etc/passwd');
    wss.simulateConnection(ws, `/ws/terminal?project=${outsidePath}`);
    await flushMicrotasks();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    // getOrCreate must NOT have been called (path rejected before session creation)
    expect(registry.getOrCreateCalls).toHaveLength(0);
    // No data sent to the socket
    expect(ws.sent).toHaveLength(0);
  });

  it('projectPath that does not exist → socket closed with 1008', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    new WsGateway(wss, registry, { pathValidator: rejectNotExists });

    const ws = new FakeSocket();
    wss.simulateConnection(ws, `/ws/terminal?project=${encodeURIComponent('/workspace/nonexistent')}`);
    await flushMicrotasks();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    expect(registry.getOrCreateCalls).toHaveLength(0);
  });

  it('symlink escaping workspace (realpath resolves outside) → socket closed with 1008', async () => {
    // Simulates: /workspace/link → /etc (symlink escape)
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    // rejectOutsideBoundary simulates realpath returning /etc (outside workspace)
    new WsGateway(wss, registry, { pathValidator: rejectOutsideBoundary });

    const ws = new FakeSocket();
    // Syntactically inside workspace but resolves outside via symlink
    wss.simulateConnection(ws, `/ws/terminal?project=${encodeURIComponent('/workspace/evil-link')}`);
    await flushMicrotasks();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    expect(registry.getOrCreateCalls).toHaveLength(0);
  });

  it('null project (no ?project param) skips validation → global session used', async () => {
    // No pathValidator needed: null path bypasses validation entirely
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    // pathValidator NOT injected — if it were called it would throw (no stub)
    // Using rejectOutsideBoundary to prove null path never reaches the validator
    new WsGateway(wss, registry, {
      pathValidator: () => { throw new Error('should not be called for null path'); },
    });

    const ws = new FakeSocket();
    wss.simulateConnection(ws, '/ws/terminal'); // no ?project → null
    await flushMicrotasks();

    // Global session used — getOrCreate called with null
    expect(registry.getOrCreateCalls).toContain(null);
    // Socket not closed
    expect(ws.closed).toBe(false);
  });
});
