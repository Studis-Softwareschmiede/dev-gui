/**
 * CommandService + commandRouter tests (#8)
 *
 * Covers:
 *   AC1  — POST /api/command with allowed command → 202 + line written to PTY
 *          + exactly one audit entry with identity
 *   AC2  — disallowed/empty/newline-injection command → 400 + nothing written to PTY
 *          + no audit entry
 *   AC3  — second concurrent command while one running → 409
 *   AC5  — cancel → interrupt sent + status cancelled + lock released → next cmd accepted
 *   AC6  — audit record() throws → command not run + lock released (failure path)
 *
 * Strategy:
 *   - Stub PtyManager (EventEmitter-based fake — no real PTY spawned)
 *   - Stub AuditStore (real class, can be replaced with throwing stub for AC6)
 *   - Stub JobLock (real class, fresh instance per test)
 *   - Routes tested through real Express app with DEV_NO_ACCESS=1 so AccessGuard
 *     lets requests through and sets identity = { email: 'dev@local' }
 *   - COMMAND_IDLE_MS set to a very short value so idle-completion tests are fast
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { CommandService, sanitizeCommand, isAllowed, DEFAULT_ALLOWED_COMMANDS } from '../src/CommandService.js';
import { commandRouter } from '../src/commandRouter.js';
import { AuditStore } from '../src/AuditStore.js';
import { JobLock } from '../src/JobLock.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Minimal PtyManager stub (no real PTY). */
class StubPtyManager extends EventEmitter {
  constructor() {
    super();
    this.written = [];
  }

  write(data) {
    this.written.push(data);
  }

  /** Simulate PTY output (triggers idle-timer resets). */
  emitOutput(data) {
    this.emit('output', data);
  }
}

/** AuditStore that throws on record() — for AC6 failure path. */
class ThrowingAuditStore {
  record() {
    throw new Error('Simulated audit failure');
  }
  getAll() { return []; }
}

/** PtyManager stub whose write() throws — for PTY-write-error path. */
class ThrowingPtyManager extends EventEmitter {
  constructor() {
    super();
    this.written = [];
  }

  write() {
    throw new Error('PTY destroyed');
  }
}

/**
 * Create a real Express app with AccessGuard (dev bypass) + commandRouter.
 * Returns { app, service, ptyStub, auditStore, lock }.
 */
function makeApp({ idleMs = 200, auditStoreOverride } = {}) {
  const app = express();
  app.use(express.json());

  // Dev-bypass AccessGuard — sets req.identity = { email: 'dev@local' }
  const guard = createAccessGuard();
  app.use('/api', guard);

  const ptyStub = new StubPtyManager();
  const auditStore = auditStoreOverride ?? new AuditStore();
  const lock = new JobLock();

  const service = new CommandService({
    ptyManager: ptyStub,
    auditStore,
    lock,
    idleMs,
  });

  app.use(commandRouter(service));

  return { app, service, ptyStub, auditStore, lock };
}

/**
 * Start an HTTP server on a random port and return { server, port }.
 */
function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/**
 * Close a server and wait for it.
 */
function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Simple HTTP request helper.
 * Returns { status, body } where body is parsed JSON.
 */
function post(port, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          // Dev bypass: set so AccessGuard doesn't 403
          // (DEV_NO_ACCESS=1 means the header check is skipped)
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Unit tests: sanitizeCommand ───────────────────────────────────────────────

describe('sanitizeCommand()', () => {
  it('returns null for non-string input', () => {
    expect(sanitizeCommand(42)).toBeNull();
    expect(sanitizeCommand(null)).toBeNull();
    expect(sanitizeCommand(undefined)).toBeNull();
    expect(sanitizeCommand({})).toBeNull();
  });

  it('returns null for empty or whitespace-only strings', () => {
    expect(sanitizeCommand('')).toBeNull();
    expect(sanitizeCommand('   ')).toBeNull();
    expect(sanitizeCommand('\t')).toBeNull();
  });

  it('returns null when command contains newline', () => {
    expect(sanitizeCommand('/flow\nsecond')).toBeNull();
    expect(sanitizeCommand('/flow\r\nsecond')).toBeNull();
    expect(sanitizeCommand('/flow\r')).toBeNull();
  });

  it('returns null when command contains other control chars', () => {
    expect(sanitizeCommand('/flow\x00bad')).toBeNull();
    expect(sanitizeCommand('/flow\x1bbad')).toBeNull();
    expect(sanitizeCommand('/flow\x7f')).toBeNull();
  });

  it('returns trimmed string for valid command', () => {
    expect(sanitizeCommand('/flow #8')).toBe('/flow #8');
    expect(sanitizeCommand('  /flow #8  ')).toBe('/flow #8');
  });
});

// ── Unit tests: isAllowed ─────────────────────────────────────────────────────

describe('isAllowed()', () => {
  it('returns true for commands in the allowlist', () => {
    for (const cmd of DEFAULT_ALLOWED_COMMANDS) {
      expect(isAllowed(cmd, DEFAULT_ALLOWED_COMMANDS)).toBe(true);
      expect(isAllowed(`${cmd} #12`, DEFAULT_ALLOWED_COMMANDS)).toBe(true);
    }
  });

  it('returns false for commands not in the allowlist', () => {
    expect(isAllowed('/hack', DEFAULT_ALLOWED_COMMANDS)).toBe(false);
    expect(isAllowed('bash', DEFAULT_ALLOWED_COMMANDS)).toBe(false);
    expect(isAllowed('', DEFAULT_ALLOWED_COMMANDS)).toBe(false);
  });
});

// ── Unit tests: CommandService.tryRun ────────────────────────────────────────

describe('CommandService.tryRun() — unit (no HTTP)', () => {
  let pty, audit, lock, svc;

  beforeEach(() => {
    pty = new StubPtyManager();
    audit = new AuditStore();
    lock = new JobLock();
    svc = new CommandService({ ptyManager: pty, auditStore: audit, lock, idleMs: 200 });
  });

  afterEach(() => {
    // Release lock to avoid cross-test pollution (idle timer may still hold it)
    lock.release();
  });

  it('AC1 — accepted command: returns { ok, commandId, status:"running" }', () => {
    const res = svc.tryRun({ command: '/flow #8', identity: { email: 'alice@test.com' } });
    expect(res.ok).toBe(true);
    expect(typeof res.commandId).toBe('string');
    expect(res.status).toBe('running');
  });

  it('AC1 — accepted command: writes exactly "command\\n" to PTY', () => {
    svc.tryRun({ command: '/flow #8', identity: null });
    expect(pty.written).toHaveLength(1);
    expect(pty.written[0]).toBe('/flow #8\n');
  });

  it('AC1 — accepted command: produces exactly one audit entry', () => {
    svc.tryRun({ command: '/flow #8', identity: { email: 'alice@test.com' } });
    const entries = audit.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe('/flow #8');
    expect(entries[0].identity).toBe('alice@test.com');
  });

  it('AC1/AC6 — audit entry records identity from req.identity.email', () => {
    svc.tryRun({ command: '/flow #8', identity: { email: 'bob@test.com' } });
    expect(audit.getAll()[0].identity).toBe('bob@test.com');
  });

  it('AC2 — disallowed command: returns invalid, nothing written to PTY, no audit', () => {
    const res = svc.tryRun({ command: '/hack', identity: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid');
    expect(pty.written).toHaveLength(0);
    expect(audit.getAll()).toHaveLength(0);
  });

  it('AC2 — empty command: returns invalid, nothing written, no audit', () => {
    const res = svc.tryRun({ command: '', identity: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid');
    expect(pty.written).toHaveLength(0);
    expect(audit.getAll()).toHaveLength(0);
  });

  it('AC2 — newline injection: returns invalid, nothing written, no audit', () => {
    const res = svc.tryRun({ command: '/flow\nsecond', identity: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid');
    expect(pty.written).toHaveLength(0);
    expect(audit.getAll()).toHaveLength(0);
  });

  it('AC3 — second tryRun while lock held: returns locked, nothing written', () => {
    svc.tryRun({ command: '/flow #1', identity: null });
    expect(lock.isHeld()).toBe(true);

    const res2 = svc.tryRun({ command: '/flow #2', identity: null });
    expect(res2.ok).toBe(false);
    expect(res2.reason).toBe('locked');
    // Only the first write should have occurred
    expect(pty.written).toHaveLength(1);
  });

  it('AC5 — cancel(): sends \\x03 to PTY, status becomes cancelled, lock released', () => {
    svc.tryRun({ command: '/flow #8', identity: null });
    expect(lock.isHeld()).toBe(true);

    const result = svc.cancel();
    expect(result.cancelled).toBe(true);
    // Last write should be Ctrl-C
    expect(pty.written[pty.written.length - 1]).toBe('\x03');
    expect(lock.isHeld()).toBe(false);
    expect(svc.getStatus().status).toBe('cancelled');
  });

  it('AC5 — after cancel, next tryRun is accepted', () => {
    svc.tryRun({ command: '/flow #1', identity: null });
    svc.cancel();

    const res = svc.tryRun({ command: '/flow #2', identity: null });
    expect(res.ok).toBe(true);
    lock.release(); // cleanup
  });

  it('AC5 — cancel when nothing running returns { cancelled: false }', () => {
    const result = svc.cancel();
    expect(result.cancelled).toBe(false);
  });

  it('AC6 — audit throws: command not run, lock released', () => {
    const throwingAudit = new ThrowingAuditStore();
    const svc2 = new CommandService({
      ptyManager: pty,
      auditStore: throwingAudit,
      lock,
      idleMs: 200,
    });

    const res = svc2.tryRun({ command: '/flow #8', identity: null });
    expect(res.ok).toBe(false);
    // PTY must NOT have been written
    expect(pty.written).toHaveLength(0);
    // Lock must be released (not held)
    expect(lock.isHeld()).toBe(false);
  });
});

// ── PTY-write-error path ──────────────────────────────────────────────────────

describe('CommandService.tryRun() — PTY write throws (unit)', () => {
  it('returns { ok:false, reason:"internal" }, lock released, no duplicate audit entry', () => {
    const throwingPty = new ThrowingPtyManager();
    const audit = new AuditStore();
    const lock = new JobLock();
    const svc = new CommandService({
      ptyManager: throwingPty,
      auditStore: audit,
      lock,
      idleMs: 200,
    });

    const res = svc.tryRun({ command: '/flow #8', identity: null });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('internal');
    // Lock must be released — not permanently held
    expect(lock.isHeld()).toBe(false);
    // Audit records exactly one entry (audit ran before the write attempt)
    expect(audit.getAll()).toHaveLength(1);
  });
});

describe('POST /api/command — PTY write error → 500 (HTTP integration)', () => {
  let server, port, lock;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const app = express();
    app.use(express.json());
    const guard = createAccessGuard();
    app.use('/api', guard);

    const throwingPty = new ThrowingPtyManager();
    const audit = new AuditStore();
    lock = new JobLock();

    const service = new CommandService({
      ptyManager: throwingPty,
      auditStore: audit,
      lock,
      idleMs: 200,
    });

    app.use(commandRouter(service));
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    lock.release();
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('PTY write throws → 500, lock released (next command would get 202 not 409)', async () => {
    const res = await post(port, '/api/command', { command: '/flow #8' });
    expect(res.status).toBe(500);
    expect(lock.isHeld()).toBe(false);
  });
});

// ── Idle-completion test ──────────────────────────────────────────────────────

describe('CommandService — idle-based lock release', () => {
  it('lock is released after quiet period with no PTY output', async () => {
    const pty = new StubPtyManager();
    const audit = new AuditStore();
    const lock = new JobLock();
    const svc = new CommandService({ ptyManager: pty, auditStore: audit, lock, idleMs: 150 });

    svc.tryRun({ command: '/flow #8', identity: null });
    expect(lock.isHeld()).toBe(true);

    // Wait longer than idleMs
    await new Promise((r) => setTimeout(r, 300));
    expect(lock.isHeld()).toBe(false);
    expect(svc.getStatus().status).toBe('done');
  }, 5000);

  it('output resets the idle timer; lock held until quiet period after last output', async () => {
    const pty = new StubPtyManager();
    const audit = new AuditStore();
    const lock = new JobLock();
    // idleMs = 150ms; emit output at 80ms → should extend to 80+150=230ms
    const svc = new CommandService({ ptyManager: pty, auditStore: audit, lock, idleMs: 150 });

    svc.tryRun({ command: '/flow #8', identity: null });
    expect(lock.isHeld()).toBe(true);

    // Emit output at ~80ms — resets the timer
    await new Promise((r) => setTimeout(r, 80));
    pty.emitOutput('some output');
    expect(lock.isHeld()).toBe(true); // still running

    // At 80+160=240ms total, timer should have fired
    await new Promise((r) => setTimeout(r, 200));
    expect(lock.isHeld()).toBe(false);
    expect(svc.getStatus().status).toBe('done');
  }, 5000);
});

// ── Integration tests: HTTP routes ───────────────────────────────────────────

describe('POST /api/command — HTTP integration', () => {
  let server, port, app, ptyStub, auditStore, lock;

  beforeEach(async () => {
    // Set dev bypass env so AccessGuard lets requests through
    process.env.DEV_NO_ACCESS = '1';
    const setup = makeApp({ idleMs: 200 });
    app = setup.app;
    ptyStub = setup.ptyStub;
    auditStore = setup.auditStore;
    lock = setup.lock;
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    lock.release();
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC1 — allowed command → 202 with commandId and status:running', async () => {
    const res = await post(port, '/api/command', { command: '/flow #8' });
    expect(res.status).toBe(202);
    expect(typeof res.body.commandId).toBe('string');
    expect(res.body.status).toBe('running');
  });

  it('AC1 — allowed command → exactly one audit entry with identity', async () => {
    await post(port, '/api/command', { command: '/flow #8' });
    const entries = auditStore.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe('/flow #8');
    // DEV_NO_ACCESS sets email = 'dev@local'
    expect(entries[0].identity).toBe('dev@local');
  });

  it('AC1 — allowed command → line written to PTY stub', async () => {
    await post(port, '/api/command', { command: '/flow #8' });
    expect(ptyStub.written).toHaveLength(1);
    expect(ptyStub.written[0]).toBe('/flow #8\n');
  });

  it('AC2 — disallowed command → 400, nothing written to PTY, no audit', async () => {
    const res = await post(port, '/api/command', { command: '/hack me' });
    expect(res.status).toBe(400);
    expect(ptyStub.written).toHaveLength(0);
    expect(auditStore.getAll()).toHaveLength(0);
  });

  it('AC2 — empty command → 400, nothing written, no audit', async () => {
    const res = await post(port, '/api/command', { command: '' });
    expect(res.status).toBe(400);
    expect(ptyStub.written).toHaveLength(0);
    expect(auditStore.getAll()).toHaveLength(0);
  });

  it('AC2 — newline injection → 400, nothing written, no audit', async () => {
    const res = await post(port, '/api/command', { command: '/flow\nsecret' });
    expect(res.status).toBe(400);
    expect(ptyStub.written).toHaveLength(0);
    expect(auditStore.getAll()).toHaveLength(0);
  });

  it('AC3 — second command while first running → 409', async () => {
    // First command — should succeed
    const res1 = await post(port, '/api/command', { command: '/flow #1' });
    expect(res1.status).toBe(202);
    expect(lock.isHeld()).toBe(true);

    // Second command — should be rejected with 409
    const res2 = await post(port, '/api/command', { command: '/flow #2' });
    expect(res2.status).toBe(409);
    // Only one write should have happened
    expect(ptyStub.written).toHaveLength(1);
  });
});

describe('POST /api/command/cancel — HTTP integration', () => {
  let server, port, app, ptyStub, lock, service;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const setup = makeApp({ idleMs: 200 });
    app = setup.app;
    ptyStub = setup.ptyStub;
    lock = setup.lock;
    service = setup.service;
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    lock.release();
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC5 — cancel while running → 200 { cancelled: true }, interrupt sent, lock released', async () => {
    // Start a command first
    const cmdRes = await post(port, '/api/command', { command: '/flow #8' });
    expect(cmdRes.status).toBe(202);
    expect(lock.isHeld()).toBe(true);

    const cancelRes = await post(port, '/api/command/cancel', {});
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.cancelled).toBe(true);

    // Ctrl-C should have been written to PTY
    expect(ptyStub.written).toContain('\x03');
    // Lock must be released
    expect(lock.isHeld()).toBe(false);
    expect(service.getStatus().status).toBe('cancelled');
  });

  it('AC5 — after cancel, next command is accepted (lock free)', async () => {
    await post(port, '/api/command', { command: '/flow #1' });
    await post(port, '/api/command/cancel', {});

    const res = await post(port, '/api/command', { command: '/flow #2' });
    expect(res.status).toBe(202);
  });

  it('AC5 — cancel when nothing running → 200 { cancelled: false }', async () => {
    const res = await post(port, '/api/command/cancel', {});
    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(false);
  });
});

describe('AC6 — audit failure path (HTTP integration)', () => {
  let server, port, app, ptyStub, lock;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const setup = makeApp({ idleMs: 200, auditStoreOverride: new ThrowingAuditStore() });
    app = setup.app;
    ptyStub = setup.ptyStub;
    lock = setup.lock;
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    lock.release();
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC6 — audit throws → command not run (PTY not written), lock released → next command accepted', async () => {
    // With throwing audit store, tryRun() returns invalid
    const res = await post(port, '/api/command', { command: '/flow #8' });
    // Returns 400 (reason: 'invalid' from audit failure path)
    expect(res.status).toBe(400);

    // PTY must not have been written
    expect(ptyStub.written).toHaveLength(0);

    // Lock must be released (otherwise the next test would get 409)
    expect(lock.isHeld()).toBe(false);
  });
});
