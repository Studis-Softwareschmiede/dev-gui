/**
 * CommandService + commandRouter — multi-session tests (AC5 / S-112)
 *
 * Covers:
 *   - tryRun({ command, identity, projectPath }) writes to the session for projectPath
 *   - tryRun without projectPath → writes to global session (backward compat)
 *   - session cap exceeded → { ok: false, reason: 'session-cap' }
 *   - commandRouter returns 429 when session cap exceeded
 *   - cancel() sends Ctrl-C to the correct (project) session
 *   - idle timer tracks output on the correct (project) PTY
 *
 * Strategy:
 *   - Fake PtySessionRegistry (duck-typed — same as WsGateway tests)
 *   - StubPtyManager EventEmitter-based (same pattern as CommandService.test.js)
 *   - Real Express app with commandRouter for HTTP tests
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { CommandService } from '../src/CommandService.js';
import { commandRouter } from '../src/commandRouter.js';
import { ProjectPathError } from '../src/workspacePath.js';
import { AuditStore } from '../src/AuditStore.js';
import { JobLock } from '../src/JobLock.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── Path validator stubs ──────────────────────────────────────────────────────

/** Stub: always allows the path (simulates inside-workspace). */
function allowAllValidator(path) {
  return Promise.resolve({ resolvedPath: path });
}

/** Stub: always rejects with outside-boundary error (simulates traversal attempt). */
function rejectOutsideBoundary(path) {
  return Promise.reject(new ProjectPathError(
    `Path '${path}' is outside workspace boundary`,
    'outside-boundary',
  ));
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Minimal PtyManager stub (no real PTY). */
class StubPty extends EventEmitter {
  constructor() {
    super();
    this.written = [];
  }
  write(data) { this.written.push(data); }
  emitOutput(data) { this.emit('output', data); }
}

/** Fake PtySessionRegistry with injectable sessions. */
class FakeRegistry {
  constructor() {
    this.globalPty = new StubPty();
    this.sessions = new Map(); // path → StubPty
    this._capExceeded = false;
  }

  // duck-type: CommandService checks for getOrCreate
  getOrCreate(path) {
    if (this._capExceeded) return null;
    if (!path) return this.globalPty;
    if (this.sessions.has(path)) return this.sessions.get(path);
    // Auto-create a new stub session
    const pty = new StubPty();
    this.sessions.set(path, pty);
    return pty;
  }

  setCapExceeded(exceeded) { this._capExceeded = exceeded; }
}

// HTTP helpers (copied from CommandService.test.js)
function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function post(port, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Unit tests: tryRun with sessionRegistry ───────────────────────────────────

describe('CommandService.tryRun() — multi-session (sessionRegistry)', () => {
  let registry, audit, lock, svc;

  beforeEach(() => {
    registry = new FakeRegistry();
    audit = new AuditStore();
    lock = new JobLock();
    svc = new CommandService({ sessionRegistry: registry, auditStore: audit, lock, idleMs: 200 });
  });

  afterEach(() => { lock.release(); });

  it('AC5 — without projectPath: writes to global session', () => {
    const res = svc.tryRun({ command: '/agent-flow:flow', identity: null });
    expect(res.ok).toBe(true);
    expect(registry.globalPty.written).toHaveLength(1);
    expect(registry.globalPty.written[0]).toBe('/agent-flow:flow\n');
  });

  it('AC5 — with projectPath=null: writes to global session', () => {
    const res = svc.tryRun({ command: '/agent-flow:flow', identity: null, projectPath: null });
    expect(res.ok).toBe(true);
    expect(registry.globalPty.written).toHaveLength(1);
  });

  it('AC5 — with projectPath: writes to the project session, NOT the global session', () => {
    const res = svc.tryRun({ command: '/agent-flow:flow', identity: null, projectPath: '/p/myrepo' });
    expect(res.ok).toBe(true);

    // Written to project session
    const projectPty = registry.sessions.get('/p/myrepo');
    expect(projectPty).toBeDefined();
    expect(projectPty.written).toHaveLength(1);
    expect(projectPty.written[0]).toBe('/agent-flow:flow\n');

    // NOT written to global session
    expect(registry.globalPty.written).toHaveLength(0);
  });

  it('AC5 — different projectPath values → different target PTYs', () => {
    lock.release(); // for second command

    // First command to /p/alpha
    svc.tryRun({ command: '/agent-flow:flow', identity: null, projectPath: '/p/alpha' });
    lock.release();

    // Second command to /p/beta
    svc.tryRun({ command: '/agent-flow:preview', identity: null, projectPath: '/p/beta' });
    lock.release();

    const alpha = registry.sessions.get('/p/alpha');
    const beta  = registry.sessions.get('/p/beta');

    expect(alpha.written).toHaveLength(1);
    expect(alpha.written[0]).toBe('/agent-flow:flow\n');
    expect(beta.written).toHaveLength(1);
    expect(beta.written[0]).toBe('/agent-flow:preview\n');
  });

  it('session-cap: returns { ok: false, reason: "session-cap" }', () => {
    registry.setCapExceeded(true);
    const res = svc.tryRun({ command: '/agent-flow:flow', identity: null, projectPath: '/p/myrepo' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('session-cap');
    // Lock must not be held
    expect(lock.isHeld()).toBe(false);
    // Nothing written
    expect(registry.globalPty.written).toHaveLength(0);
  });

  it('AC5 — cancel() sends Ctrl-C to the project session', () => {
    svc.tryRun({ command: '/agent-flow:flow', identity: null, projectPath: '/p/myrepo' });
    expect(lock.isHeld()).toBe(true);

    const result = svc.cancel();
    expect(result.cancelled).toBe(true);

    // Ctrl-C goes to the project PTY
    const projectPty = registry.sessions.get('/p/myrepo');
    expect(projectPty.written[projectPty.written.length - 1]).toBe('\x03');

    // NOT to global
    expect(registry.globalPty.written).toHaveLength(0);

    expect(lock.isHeld()).toBe(false);
  });

  it('AC5 — idle timer fires on the project PTY output', async () => {
    svc.tryRun({ command: '/agent-flow:flow', identity: null, projectPath: '/p/myrepo' });
    expect(lock.isHeld()).toBe(true);

    // Wait for idle (idleMs = 200ms)
    await new Promise((r) => setTimeout(r, 350));
    expect(lock.isHeld()).toBe(false);
    expect(svc.getStatus().status).toBe('done');
  }, 5000);

  it('AC5 — project PTY output resets idle timer', async () => {
    const projectPty = registry.getOrCreate('/p/myrepo'); // pre-create so we can emit output
    svc.tryRun({ command: '/agent-flow:flow', identity: null, projectPath: '/p/myrepo' });
    expect(lock.isHeld()).toBe(true);

    // Emit output at 100ms to reset the 200ms idle timer
    await new Promise((r) => setTimeout(r, 100));
    projectPty.emitOutput('some output');
    expect(lock.isHeld()).toBe(true); // still running

    // Idle fires at 100 + 200 = 300ms total (we wait 220ms after emit)
    await new Promise((r) => setTimeout(r, 250));
    expect(lock.isHeld()).toBe(false);
    expect(svc.getStatus().status).toBe('done');
  }, 5000);
});

// ── Unit tests: backward compat — ptyManager without registry ─────────────────

describe('CommandService.tryRun() — legacy ptyManager (no registry), projectPath ignored', () => {
  let pty, audit, lock, svc;

  beforeEach(() => {
    pty = new StubPty();
    audit = new AuditStore();
    lock = new JobLock();
    svc = new CommandService({ ptyManager: pty, auditStore: audit, lock, idleMs: 200 });
  });

  afterEach(() => { lock.release(); });

  it('writes to the single pty regardless of projectPath', () => {
    const res = svc.tryRun({ command: '/agent-flow:flow', identity: null, projectPath: '/p/whatever' });
    expect(res.ok).toBe(true);
    expect(pty.written).toHaveLength(1);
    expect(pty.written[0]).toBe('/agent-flow:flow\n');
  });
});

// ── HTTP integration: POST /api/command with projectPath ──────────────────────

describe('POST /api/command — multi-session HTTP integration (AC5)', () => {
  let server, port, app, registry, lock;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';

    registry = new FakeRegistry();
    const audit = new AuditStore();
    lock = new JobLock();

    const service = new CommandService({ sessionRegistry: registry, auditStore: audit, lock, idleMs: 200 });

    app = express();
    app.use(express.json());
    app.use('/api', createAccessGuard());
    // Inject allowAllValidator: tests use fake paths like /p/myrepo that don't exist on disk
    app.use(commandRouter(service, { pathValidator: allowAllValidator }));

    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    lock.release();
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC5 — projectPath in body routes command to project session → 202', async () => {
    const res = await post(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: '/p/myrepo',
    });
    expect(res.status).toBe(202);

    const projectPty = registry.sessions.get('/p/myrepo');
    expect(projectPty).toBeDefined();
    expect(projectPty.written).toHaveLength(1);
    expect(projectPty.written[0]).toBe('/agent-flow:flow\n');

    // Global NOT written
    expect(registry.globalPty.written).toHaveLength(0);
  });

  it('AC5 — missing projectPath uses global session → 202', async () => {
    const res = await post(port, '/api/command', { command: '/agent-flow:flow' });
    expect(res.status).toBe(202);
    expect(registry.globalPty.written).toHaveLength(1);
  });

  it('AC5 — null projectPath uses global session → 202', async () => {
    const res = await post(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: null,
    });
    expect(res.status).toBe(202);
    expect(registry.globalPty.written).toHaveLength(1);
  });

  it('AC5 — session cap exceeded → 429', async () => {
    registry.setCapExceeded(true);
    const res = await post(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: '/p/myrepo',
    });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/session cap/i);
  });

  it('AC5 — command with projectPath still validated by allowlist → 400 for disallowed', async () => {
    const res = await post(port, '/api/command', {
      command: '/hack',
      projectPath: '/p/myrepo',
    });
    expect(res.status).toBe(400);
    // Project session NOT created (validation fails before session lookup)
    expect(registry.sessions.has('/p/myrepo')).toBe(false);
  });
});

// ── HTTP integration: Path-Traversal rejection (CRITICAL security fix) ────────

describe('POST /api/command — path-traversal boundary rejection (security/R02/R03)', () => {
  let server, port, app, registry, lock;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';

    registry = new FakeRegistry();
    const audit = new AuditStore();
    lock = new JobLock();

    const service = new CommandService({ sessionRegistry: registry, auditStore: audit, lock, idleMs: 200 });

    app = express();
    app.use(express.json());
    app.use('/api', createAccessGuard());
    // Inject rejectOutsideBoundary: simulates path outside WORKSPACE_DIR
    app.use(commandRouter(service, { pathValidator: rejectOutsideBoundary }));

    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    lock.release();
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('projectPath outside workspace boundary → HTTP 400 (Path-Traversal rejected)', async () => {
    const res = await post(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: '/etc/passwd',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid projectpath/i);
    // getOrCreate must NOT have been called — path rejected before session lookup
    expect([...registry.sessions.keys()]).toHaveLength(0);
    expect(registry.globalPty.written).toHaveLength(0);
  });

  it('projectPath with .. traversal → HTTP 400', async () => {
    const res = await post(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: '/workspace/../../../etc',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid projectpath/i);
    expect(registry.globalPty.written).toHaveLength(0);
  });

  it('null projectPath → skips boundary check → global session (backward compat)', async () => {
    // Use allowAllValidator for this sub-test: need a valid command to reach the session
    const audit2 = new AuditStore();
    const lock2 = new JobLock();
    const registry2 = new FakeRegistry();
    const service2 = new CommandService({ sessionRegistry: registry2, auditStore: audit2, lock: lock2, idleMs: 200 });

    const app2 = express();
    app2.use(express.json());
    app2.use('/api', createAccessGuard());
    // rejectOutsideBoundary: prove null path does NOT call the validator
    app2.use(commandRouter(service2, {
      pathValidator: () => { throw new Error('should not be called for null projectPath'); },
    }));

    const { server: srv2, port: port2 } = await startServer(app2);
    try {
      const res = await post(port2, '/api/command', { command: '/agent-flow:flow' });
      // Should reach global session (validator never called)
      expect(res.status).toBe(202);
      expect(registry2.globalPty.written).toHaveLength(1);
    } finally {
      lock2.release();
      await closeServer(srv2);
    }
  });
});
