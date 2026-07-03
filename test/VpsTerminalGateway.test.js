/**
 * @file VpsTerminalGateway.test.js
 *
 * Unit tests for the WS /ws/vps-terminal message-protocol gateway
 * (docs/specs/vps-ssh-terminal.md, S-263).
 *
 * Uses a fake WebSocketServer + fake WebSocket (analog test/WsGateway.test.js) and a
 * fully mocked `SshPtyManager` (`open()` is a jest.fn whose behavior is scripted per
 * test via `manager.openImpl`) — no real `node-pty`/`ssh` spawn, no network.
 *
 * Covers (vps-ssh-terminal):
 *   AC5 — Open-Handshake {type:"open",provider,serverId,user} → state connecting/
 *         connected → byteweises Output-Streaming; {type:"input"}/{type:"resize"}
 *         werden an die Session durchgereicht (sshPtyManager.open()-Rückgabe-Handle).
 *   AC6 — `user` wird unverändert an sshPtyManager.open() durchgereicht (die
 *         eigentliche Allowlist-Prüfung liegt in SshPtyManager selbst, s.
 *         SshPtyManager.test.js „AC6-Vorgriff" — hier wird nur verifiziert, dass ein
 *         von SshPtyManager abgelehnter Versuch [onError + null] KEINE Session im
 *         Gateway hinterlässt (kein Write/Resize auf eine nie existierende Session)).
 *         no-target — analoge Verifikation für ein von SshPtyManager als
 *         nicht-auflösbar abgelehntes Ziel.
 *   AC9  — Audit-First: auditStore.record() läuft NACHWEISLICH vor
 *          sshPtyManager.open() (Aufrufreihenfolge-Assertion); Audit-Write-Fehler
 *          → sshPtyManager.open() wird NICHT aufgerufen (keine Sitzung).
 *          AccessGuard-403 (Upgrade) + Rollen-403 (CRED_ADMIN_EMAILS) sind NICHT
 *          Teil dieser Datei — sie laufen bereits im Upgrade-Interceptor, BEVOR die
 *          WS-Verbindung hier ankommt (abgedeckt in test/AccessGuard.test.js
 *          „createWsAccessGuard — postAuthCheck" + test/wsUpgradeHandler.test.js
 *          „vps-ssh-terminal AC5/AC9"). Eine Verbindung, die hier `#onConnection`
 *          erreicht, hat beide Gates bereits bestanden — kein Doppel-Test hier.
 *   Edge-Cases (Verträge/Edge-Cases-Abschnitt der Spec):
 *     - Fehler-Klassifikation (errorClass/reason) wird unverändert an den Client
 *       durchgereicht (host-key-mismatch-Beispiel).
 *     - Doppeltes `open` auf derselben WS → Fehler, KEIN zweiter
 *       sshPtyManager.open()-Aufruf.
 *     - `input`/`resize` VOR erfolgreichem `open` → ignoriert (kein Crash, kein
 *       Aufruf gegen eine nicht existierende Session).
 *     - WS-Close → session.close() (Cleanup-Delegation an SshPtyManager).
 *     - WS-Close WÄHREND `sshPtyManager.open()` noch pending ist (Race-Fix, Review
 *       #S-263 Iteration 2): sobald `open()` danach doch noch auflöst, wird die
 *       soeben erst entstandene Sitzung SOFORT wieder geschlossen (kein verwaister
 *       ssh-PTY/Key-File bis zum Idle-Timeout) — inkl. Kontrolltest für den
 *       Normalfall (Close NACH bereits erfolgreichem open → genau ein close()-Aufruf,
 *       kein Doppel-Close).
 *     - Strukturell ungültiges `open` (fehlendes Feld / unbekannter provider) →
 *       Fehler, KEIN Audit-Eintrag, KEIN sshPtyManager.open()-Aufruf.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { VpsTerminalGateway, checkVpsTerminalAuthz } from '../src/VpsTerminalGateway.js';

// ── Fake WebSocket / WebSocketServer (analog test/WsGateway.test.js) ────────────

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.sent = [];
  }
  send(data) {
    this.sent.push(data);
  }
  simulateMessage(obj) {
    this.emit('message', JSON.stringify(obj));
  }
  sentMessages() {
    return this.sent.map((s) => JSON.parse(s));
  }
}

class FakeWss extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }
  simulateConnection(socket, req = { identity: { email: 'admin@example.com' } }) {
    this.clients.add(socket);
    this.emit('connection', socket, req);
  }
}

// ── Fake SshPtyManager ────────────────────────────────────────────────────────

class FakeSshPtyManager {
  constructor() {
    this.openCalls = [];
    /** @type {(params: object) => Promise<object|null>} */
    this.openImpl = async () => null;
  }
  open(params) {
    this.openCalls.push(params);
    return this.openImpl(params);
  }
}

/** Builds a controllable fake SSH session handle (SshPtyManager.open() return shape). */
function makeFakeSession() {
  return {
    write: jest.fn(),
    resize: jest.fn(),
    close: jest.fn(async () => {}),
  };
}

/** Fake AuditStore — records calls, optionally throws (Audit-Fehler test). */
function makeFakeAuditStore({ throwOnRecord = false } = {}) {
  const calls = [];
  return {
    calls,
    record: jest.fn(({ identity, command }) => {
      if (throwOnRecord) throw new Error('audit write failed');
      const entry = { time: '2026-07-03T00:00:00.000Z', identity, command };
      calls.push(entry);
      return entry;
    }),
  };
}

function makeGateway({ auditStore, manager } = {}) {
  const wss = new FakeWss();
  const sshPtyManager = manager ?? new FakeSshPtyManager();
  const audit = auditStore ?? makeFakeAuditStore();
  const gw = new VpsTerminalGateway(wss, sshPtyManager, { auditStore: audit });
  return { wss, sshPtyManager, audit, gw };
}

/** Flush pending microtasks (lets `sshPtyManager.open().then(...)` settle). */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── AC5: Happy-Path Handshake → state → output-Streaming → input/resize ────────

describe('VpsTerminalGateway — AC5: happy-path handshake + streaming', () => {
  it('open → sshPtyManager.open() called with provider/serverId/user; state connecting/connected + output forwarded', async () => {
    const manager = new FakeSshPtyManager();
    const session = makeFakeSession();
    let capturedParams;
    manager.openImpl = async (params) => {
      capturedParams = params;
      params.onState('connecting');
      params.onState('connected');
      return session;
    };
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush();

    expect(manager.openCalls).toHaveLength(1);
    expect(manager.openCalls[0]).toMatchObject({ provider: 'hetzner', serverId: 'vps-1', user: 'root' });

    const msgs = ws.sentMessages();
    expect(msgs).toContainEqual({ type: 'state', state: 'connecting' });
    expect(msgs).toContainEqual({ type: 'state', state: 'connected' });

    // Output streaming (byteweise, ANSI erhalten — data is passed through verbatim)
    capturedParams.onOutput('\x1b[2Jhello');
    expect(ws.sentMessages()).toContainEqual({ type: 'output', data: '\x1b[2Jhello' });
  });

  it('input after open is routed to session.write(data)', async () => {
    const manager = new FakeSshPtyManager();
    const session = makeFakeSession();
    manager.openImpl = async () => session;
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush();

    ws.simulateMessage({ type: 'input', data: 'ls -la\n' });
    expect(session.write).toHaveBeenCalledWith('ls -la\n');
  });

  it('resize after open is routed to session.resize(cols, rows)', async () => {
    const manager = new FakeSshPtyManager();
    const session = makeFakeSession();
    manager.openImpl = async () => session;
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'alex' });
    await flush();

    ws.simulateMessage({ type: 'resize', cols: 120, rows: 40 });
    expect(session.resize).toHaveBeenCalledWith(120, 40);
  });

  it('input with non-string data is ignored (no session.write call)', async () => {
    const manager = new FakeSshPtyManager();
    const session = makeFakeSession();
    manager.openImpl = async () => session;
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush();

    ws.simulateMessage({ type: 'input', data: 12345 });
    expect(session.write).not.toHaveBeenCalled();
  });
});

// ── AC6: SshPtyManager-Ablehnung hinterlässt keine Session im Gateway ───────────

describe('VpsTerminalGateway — AC6: rejected open() leaves no session (no write/resize possible)', () => {
  it('user "bob" rejected by SshPtyManager (onError + null) → error surfaced, no session, input ignored', async () => {
    const manager = new FakeSshPtyManager();
    manager.openImpl = async (params) => {
      params.onError('error', 'Ungültiger SSH-Benutzer');
      return null;
    };
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'bob' });
    await flush();

    expect(manager.openCalls[0]).toMatchObject({ user: 'bob' });
    expect(ws.sentMessages()).toContainEqual({
      type: 'error',
      errorClass: 'error',
      reason: 'Ungültiger SSH-Benutzer',
    });

    // No session exists — input after a rejected open must be a no-op, not a crash.
    ws.simulateMessage({ type: 'input', data: 'echo hi\n' });
    expect(manager.openCalls).toHaveLength(1); // no retry/second open triggered by input
  });

  it('unresolvable serverId (no-target) rejected by SshPtyManager → error surfaced, no session', async () => {
    const manager = new FakeSshPtyManager();
    manager.openImpl = async (params) => {
      params.onError('no-target', 'SSH-Ziel nicht auflösbar');
      return null;
    };
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'unknown-vps', user: 'root' });
    await flush();

    expect(ws.sentMessages()).toContainEqual({
      type: 'error',
      errorClass: 'no-target',
      reason: 'SSH-Ziel nicht auflösbar',
    });
  });
});

// ── AC9: Audit-First ─────────────────────────────────────────────────────────

describe('VpsTerminalGateway — AC9: Audit-First (vor sshPtyManager.open())', () => {
  it('auditStore.record() is called BEFORE sshPtyManager.open() (order assertion)', async () => {
    const order = [];
    const manager = new FakeSshPtyManager();
    manager.openImpl = async () => {
      order.push('open');
      return makeFakeSession();
    };
    const auditStore = makeFakeAuditStore();
    auditStore.record.mockImplementation(({ identity, command }) => {
      order.push('audit');
      return { time: 't', identity, command };
    });
    const { wss } = makeGateway({ manager, auditStore });
    const ws = new FakeSocket();
    wss.simulateConnection(ws, { identity: { email: 'admin@example.com' } });

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush();

    expect(order).toEqual(['audit', 'open']);
  });

  it('audit entry contains identity/provider/serverId/user — no secret', async () => {
    const manager = new FakeSshPtyManager();
    manager.openImpl = async () => makeFakeSession();
    const auditStore = makeFakeAuditStore();
    const { wss } = makeGateway({ manager, auditStore });
    const ws = new FakeSocket();
    wss.simulateConnection(ws, { identity: { email: 'admin@example.com' } });

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush();

    expect(auditStore.calls).toHaveLength(1);
    expect(auditStore.calls[0].identity).toBe('admin@example.com');
    expect(auditStore.calls[0].command).toContain('hetzner');
    expect(auditStore.calls[0].command).toContain('vps-1');
    expect(auditStore.calls[0].command).toContain('root');
    // security/R01 — no key/secret material could ever appear here (command is a
    // fixed-shape string built only from provider/serverId/user, no key material exists
    // at this layer at all).
    expect(auditStore.calls[0].command).not.toMatch(/PRIVATE KEY/i);
  });

  it('Audit-Write-Fehler → sshPtyManager.open() NICHT aufgerufen (keine Sitzung)', async () => {
    const manager = new FakeSshPtyManager();
    const auditStore = makeFakeAuditStore({ throwOnRecord: true });
    const { wss } = makeGateway({ manager, auditStore });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush();

    expect(manager.openCalls).toHaveLength(0);
    expect(ws.sentMessages()).toContainEqual({
      type: 'error',
      errorClass: 'error',
      reason: 'Audit-Write fehlgeschlagen — Sitzung abgebrochen',
    });
  });
});

// ── Fehler-Klassifikation durchgereicht ─────────────────────────────────────────

describe('VpsTerminalGateway — Fehlerklassen werden unverändert durchgereicht', () => {
  it('host-key-mismatch from SshPtyManager reaches the client verbatim', async () => {
    const manager = new FakeSshPtyManager();
    const session = makeFakeSession();
    manager.openImpl = async (params) => {
      params.onState('connecting');
      // Simulates a later exit classified as host-key-mismatch (post-connect failure).
      params.onError('host-key-mismatch', 'SSH-Host-Key hat sich geändert (möglicher MITM) — Verbindung abgelehnt');
      return session;
    };
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush();

    expect(ws.sentMessages()).toContainEqual({
      type: 'error',
      errorClass: 'host-key-mismatch',
      reason: 'SSH-Host-Key hat sich geändert (möglicher MITM) — Verbindung abgelehnt',
    });
  });
});

// ── Edge-Case: doppeltes open ────────────────────────────────────────────────

describe('VpsTerminalGateway — Edge-Case: doppeltes open auf derselben WS → Fehler', () => {
  it('a second open message is rejected — sshPtyManager.open() called only once', async () => {
    const manager = new FakeSshPtyManager();
    manager.openImpl = async () => makeFakeSession();
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush();
    ws.simulateMessage({ type: 'open', provider: 'ionos', serverId: 'vps-2', user: 'alex' });
    await flush();

    expect(manager.openCalls).toHaveLength(1);
    expect(ws.sentMessages()).toContainEqual({
      type: 'error',
      errorClass: 'error',
      reason: 'Sitzung bereits geöffnet',
    });
  });

  it('a second open after a REJECTED first attempt is also rejected (no retry-open on the same WS)', async () => {
    const manager = new FakeSshPtyManager();
    manager.openImpl = async (params) => {
      params.onError('no-target', 'SSH-Ziel nicht auflösbar');
      return null;
    };
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush();
    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-2', user: 'root' });
    await flush();

    expect(manager.openCalls).toHaveLength(1);
  });
});

// ── Edge-Case: input/resize vor open ────────────────────────────────────────────

describe('VpsTerminalGateway — Edge-Case: input/resize vor open → ignoriert', () => {
  it('input before any open is ignored (no crash, no sshPtyManager.open() call)', async () => {
    const manager = new FakeSshPtyManager();
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    expect(() => ws.simulateMessage({ type: 'input', data: 'echo hi\n' })).not.toThrow();
    expect(manager.openCalls).toHaveLength(0);
    expect(ws.sentMessages()).toEqual([]);
  });

  it('resize before any open is ignored (no crash)', async () => {
    const manager = new FakeSshPtyManager();
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    expect(() => ws.simulateMessage({ type: 'resize', cols: 80, rows: 24 })).not.toThrow();
    expect(manager.openCalls).toHaveLength(0);
  });
});

// ── WS-Close → session.close() ──────────────────────────────────────────────────

describe('VpsTerminalGateway — WS-Close delegiert an session.close()', () => {
  it('closing the socket after a successful open calls session.close()', async () => {
    const manager = new FakeSshPtyManager();
    const session = makeFakeSession();
    manager.openImpl = async () => session;
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush();

    ws.emit('close');
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('closing the socket BEFORE any successful open does not throw (no session to close)', async () => {
    const manager = new FakeSshPtyManager();
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    expect(() => ws.emit('close')).not.toThrow();
  });

  it('Race-Fix (Review #S-263 Iteration 2): WS closes WHILE open() is still pending — once open() resolves, the just-opened session is immediately closed (no orphaned PTY/key-file)', async () => {
    const manager = new FakeSshPtyManager();
    const session = makeFakeSession();
    let resolveOpen;
    manager.openImpl = () => new Promise((resolve) => { resolveOpen = resolve; });
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush(); // let the open() call fire, but it stays pending (SSH connect in flight)

    // Client tab closes / connection drops WHILE the SSH connect is still in progress —
    // at this point `session` inside the gateway is still null, so the naive close-handler
    // would have nothing to close.
    ws.emit('close');
    expect(session.close).not.toHaveBeenCalled(); // nothing to close yet — open() hasn't resolved

    // SSH connect now finishes (after the WS is already gone).
    resolveOpen(session);
    await flush();

    // The just-opened session MUST be closed immediately — no orphaned ssh-PTY/key-file
    // waiting for the idle-timeout.
    expect(session.close).toHaveBeenCalledTimes(1);

    // A late input message (impossible in practice once the ws is closed, but guards
    // against ever treating this session as "active") must not write to the closed session.
    ws.simulateMessage({ type: 'input', data: 'echo hi\n' });
    expect(session.write).not.toHaveBeenCalled();
  });

  it('Race-Fix: WS closes AFTER open() already resolved successfully → normal single close() call (no double-close)', async () => {
    const manager = new FakeSshPtyManager();
    const session = makeFakeSession();
    manager.openImpl = async () => session;
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', serverId: 'vps-1', user: 'root' });
    await flush(); // open() already resolved and stored the session before close

    ws.emit('close');
    await flush();

    expect(session.close).toHaveBeenCalledTimes(1);
  });
});

// ── Strukturell ungültiges open → kein Audit, kein Spawn-Versuch ────────────────

describe('VpsTerminalGateway — malformed open message: no audit write, no sshPtyManager.open() call', () => {
  it('missing serverId → error, no audit, no open() call', async () => {
    const manager = new FakeSshPtyManager();
    const auditStore = makeFakeAuditStore();
    const { wss } = makeGateway({ manager, auditStore });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'hetzner', user: 'root' });
    await flush();

    expect(manager.openCalls).toHaveLength(0);
    expect(auditStore.record).not.toHaveBeenCalled();
    expect(ws.sentMessages()[0]).toMatchObject({ type: 'error' });
  });

  it('unknown provider → error, no audit, no open() call', async () => {
    const manager = new FakeSshPtyManager();
    const auditStore = makeFakeAuditStore();
    const { wss } = makeGateway({ manager, auditStore });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    ws.simulateMessage({ type: 'open', provider: 'not-a-real-provider', serverId: 'vps-1', user: 'root' });
    await flush();

    expect(manager.openCalls).toHaveLength(0);
    expect(auditStore.record).not.toHaveBeenCalled();
  });

  it('malformed JSON message is ignored (no throw)', async () => {
    const manager = new FakeSshPtyManager();
    const { wss } = makeGateway({ manager });
    const ws = new FakeSocket();
    wss.simulateConnection(ws);

    expect(() => ws.emit('message', '{not valid json')).not.toThrow();
    expect(manager.openCalls).toHaveLength(0);
  });
});

// ── checkVpsTerminalAuthz (AC9, CRED_ADMIN_EMAILS-Logik) ────────────────────────
// Die Verdrahtung ins WS-Upgrade (postAuthCheck) wird in test/AccessGuard.test.js
// geprüft; hier nur die reine Funktions-Logik (analog vpsRouter/vpsContainerRouter
// checkMutationAuthz-Tests).

describe('checkVpsTerminalAuthz — AC9 CRED_ADMIN_EMAILS-Logik', () => {
  const ORIGINAL = process.env.CRED_ADMIN_EMAILS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CRED_ADMIN_EMAILS;
    else process.env.CRED_ADMIN_EMAILS = ORIGINAL;
  });

  it('no CRED_ADMIN_EMAILS configured → allowed (open access, matches ADR-007 default)', () => {
    delete process.env.CRED_ADMIN_EMAILS;
    expect(checkVpsTerminalAuthz({ email: 'anyone@example.com' })).toEqual({ allowed: true });
  });

  it('email in CRED_ADMIN_EMAILS list → allowed', () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com, other@example.com';
    expect(checkVpsTerminalAuthz({ email: 'admin@example.com' })).toEqual({ allowed: true });
  });

  it('email NOT in CRED_ADMIN_EMAILS list → not allowed', () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    expect(checkVpsTerminalAuthz({ email: 'intruder@example.com' })).toEqual({ allowed: false });
  });

  it('null identity with CRED_ADMIN_EMAILS configured → not allowed', () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    expect(checkVpsTerminalAuthz(null)).toEqual({ allowed: false });
  });

  it('email match is case-insensitive', () => {
    process.env.CRED_ADMIN_EMAILS = 'Admin@Example.com';
    expect(checkVpsTerminalAuthz({ email: 'admin@example.com' })).toEqual({ allowed: true });
  });
});
