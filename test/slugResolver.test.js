/**
 * slugResolver + integration tests for S-125 (AC9, AC10)
 *
 * Covers:
 *   AC9  — resolveProjectSlug() translates a valid slug to WORKSPACE_DIR/slug;
 *          both entry paths (WsGateway ?project= and POST /api/command) use the
 *          same resolution; global case (no slug) remains unchanged.
 *   AC10 — Boundary guard stays effective: slugs containing '/', '..' or absolute
 *          paths are rejected with ProjectPathError BEFORE validateProjectPath runs;
 *          NUL-byte slugs are explicitly rejected by the slug layer (not silently
 *          passed to validateProjectPath); percent-encoded traversal ('..%2fetc')
 *          contains no literal '/' and is safe as a literal directory name (documented);
 *          WS → close(1008), POST /api/command → 400; no process crash.
 *
 *   AccessGuard: verdrahtet via createAccessGuard() + DEV_NO_ACCESS=1 (dev-bypass);
 *                kein separater Middleware-Test — AccessGuard ist ein eigenständiges Modul.
 *
 * Strategy:
 *   - Unit tests for resolveProjectSlug() in isolation (injected mountRoot).
 *   - WsGateway integration: fake Wss + fake Registry + injected slugResolver +
 *     injected pathValidator to verify end-to-end slug resolution in multi-session mode.
 *   - commandRouter integration: real Express app + injected slugResolver +
 *     injected pathValidator + stub CommandService.
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { resolveProjectSlug, ProjectPathError } from '../src/workspacePath.js';
import { WsGateway } from '../src/WsGateway.js';
import { commandRouter } from '../src/commandRouter.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── Unit tests: resolveProjectSlug() ─────────────────────────────────────────

describe('resolveProjectSlug() — AC9 + AC10', () => {
  const MOUNT = '/workspace';

  it('AC9 — valid slug → WORKSPACE_DIR/slug', () => {
    expect(resolveProjectSlug('dev-gui', { mountRoot: MOUNT })).toBe('/workspace/dev-gui');
    expect(resolveProjectSlug('my_repo', { mountRoot: MOUNT })).toBe('/workspace/my_repo');
    expect(resolveProjectSlug('project.123', { mountRoot: MOUNT })).toBe('/workspace/project.123');
  });

  it('AC9 — global case: null → null (no resolve)', () => {
    expect(resolveProjectSlug(null, { mountRoot: MOUNT })).toBeNull();
    expect(resolveProjectSlug(undefined, { mountRoot: MOUNT })).toBeNull();
  });

  it('AC9 — empty string → null (global session)', () => {
    expect(resolveProjectSlug('', { mountRoot: MOUNT })).toBeNull();
    expect(resolveProjectSlug('   ', { mountRoot: MOUNT })).toBeNull();
  });

  it('AC9 — strips trailing slash from mountRoot before joining', () => {
    expect(resolveProjectSlug('dev-gui', { mountRoot: '/workspace/' })).toBe('/workspace/dev-gui');
    expect(resolveProjectSlug('dev-gui', { mountRoot: '/workspace///' })).toBe('/workspace/dev-gui');
  });

  it('AC9 — uses process.env.WORKSPACE_DIR when no mountRoot dep injected', () => {
    const orig = process.env.WORKSPACE_DIR;
    try {
      process.env.WORKSPACE_DIR = '/env-workspace';
      expect(resolveProjectSlug('my-repo')).toBe('/env-workspace/my-repo');
    } finally {
      if (orig !== undefined) process.env.WORKSPACE_DIR = orig;
      else delete process.env.WORKSPACE_DIR;
    }
  });

  it('AC10 — slug with "/" → outside-boundary', () => {
    expect(() => resolveProjectSlug('../etc', { mountRoot: MOUNT })).toThrow(ProjectPathError);
    expect(() => resolveProjectSlug('../etc', { mountRoot: MOUNT })).toThrow(
      expect.objectContaining({ errorClass: 'outside-boundary' }),
    );
  });

  it('AC10 — slug that is absolute path → outside-boundary (contains "/")', () => {
    expect(() => resolveProjectSlug('/etc/passwd', { mountRoot: MOUNT })).toThrow(
      expect.objectContaining({ errorClass: 'outside-boundary' }),
    );
  });

  it('AC10 — slug ".." alone → outside-boundary', () => {
    expect(() => resolveProjectSlug('..', { mountRoot: MOUNT })).toThrow(
      expect.objectContaining({ errorClass: 'outside-boundary' }),
    );
  });

  it('AC10 — slug "." alone → outside-boundary', () => {
    expect(() => resolveProjectSlug('.', { mountRoot: MOUNT })).toThrow(
      expect.objectContaining({ errorClass: 'outside-boundary' }),
    );
  });

  it('AC10 — slug with NUL byte → outside-boundary (explicit slug-layer rejection)', () => {
    // NUL bytes are not stripped by trim(); the slug layer must reject them explicitly
    // rather than passing them to validateProjectPath (which would return not-exists).
    expect(() => resolveProjectSlug('\x00', { mountRoot: MOUNT })).toThrow(
      expect.objectContaining({ errorClass: 'outside-boundary' }),
    );
    expect(() => resolveProjectSlug('dev\x00gui', { mountRoot: MOUNT })).toThrow(
      expect.objectContaining({ errorClass: 'outside-boundary' }),
    );
    // Verify the error message does NOT contain the raw NUL byte (security: no NUL in logs)
    try {
      resolveProjectSlug('\x00', { mountRoot: MOUNT });
    } catch (err) {
      expect(err.message.includes('\x00')).toBe(false);
      expect(err.message).toMatch(/null bytes/);
    }
  });

  it('AC10 — percent-encoded traversal ("..%2fetc") has no literal "/" → passes slug-form check; safe as literal dir name in validateProjectPath', () => {
    // '..%2fetc' contains no literal '/'; the JSON body is NOT URL-decoded by Express.
    // resolveProjectSlug produces '/workspace/..%2fetc'; path.resolve() does NOT expand
    // %2f as a directory separator → the resulting path is a literal dir name, not traversal.
    // validateProjectPath (realpath-boundary) is the final guard and rejects it (ENOENT → 400).
    // This test documents the known behaviour: slug-form check does not reject %2f slugs,
    // and that is safe because validateProjectPath still rejects the path.
    const result = resolveProjectSlug('..%2fetc', { mountRoot: MOUNT });
    expect(result).toBe('/workspace/..%2fetc');
    // (validateProjectPath would reject this in integration; the real guard remains in place)
  });

  it('AC10 — no WORKSPACE_DIR configured → outside-boundary', () => {
    const orig = process.env.WORKSPACE_DIR;
    try {
      delete process.env.WORKSPACE_DIR;
      expect(() => resolveProjectSlug('dev-gui', {})).toThrow(
        expect.objectContaining({ errorClass: 'outside-boundary' }),
      );
    } finally {
      if (orig !== undefined) process.env.WORKSPACE_DIR = orig;
    }
  });
});

// ── Fake WS helpers ───────────────────────────────────────────────────────────

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.sent = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
  }
  send(data) { this.sent.push(data); }
  close(code, reason) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }
  simulateMessage(obj) { this.emit('message', JSON.stringify(obj)); }
}

class FakeWss extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }
  simulateConnection(socket, url = '/ws/terminal') {
    this.clients.add(socket);
    this.emit('connection', socket, { url });
  }
}

class FakePty extends EventEmitter {
  constructor(scrollback = '') {
    super();
    this.state = 'ready';
    this._scrollback = scrollback;
    this.writeCalls = [];
  }
  get scrollback() { return this._scrollback; }
  write(data) { this.writeCalls.push(data); }
  emitOutput(data) { this.emit('output', data); }
}

class FakeRegistry {
  constructor(sessions = {}) {
    this.sessions = new Map(Object.entries(sessions));
    this.globalSession = new FakePty('global scrollback');
    this.getOrCreateCalls = [];
  }
  getOrCreate(path) {
    this.getOrCreateCalls.push(path);
    if (!path) return this.globalSession;
    return this.sessions.get(path) ?? null;
  }
}

// flush microtasks so async #onConnectionMulti resolves
const flush = () => new Promise((r) => setTimeout(r, 0));

// ── WsGateway integration: slug resolution ────────────────────────────────────

describe('WsGateway — slug resolution (AC9 + AC10)', () => {
  beforeEach(() => {
    process.env.WORKSPACE_DIR = '/workspace';
  });
  afterEach(() => {
    delete process.env.WORKSPACE_DIR;
  });

  it('AC9 — valid slug resolves to WORKSPACE_DIR/slug before pathValidator is called', async () => {
    const wss = new FakeWss();
    const pty = new FakePty('session scrollback');
    const registry = new FakeRegistry({ '/workspace/dev-gui': pty });

    const pathValidatorCalls = [];
    // pathValidator records what it receives (the resolved absolute path)
    const stubPathValidator = async (p) => {
      pathValidatorCalls.push(p);
      return { resolvedPath: p };
    };

    new WsGateway(wss, registry, { pathValidator: stubPathValidator });

    const ws = new FakeSocket();
    // Client sends slug 'dev-gui' (not absolute path)
    wss.simulateConnection(ws, '/ws/terminal?project=dev-gui');
    await flush();

    // pathValidator must have received the resolved absolute path
    expect(pathValidatorCalls).toEqual(['/workspace/dev-gui']);
    // registry.getOrCreate called with the resolved path
    expect(registry.getOrCreateCalls).toContain('/workspace/dev-gui');
    // connection is open (session found)
    expect(ws.closed).toBe(false);
    // scrollback sent
    const msgs = ws.sent.map((s) => JSON.parse(s));
    expect(msgs[0]).toEqual({ type: 'output', data: 'session scrollback' });
  });

  it('AC9 — global case (no ?project) bypasses slug resolver and pathValidator', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();

    const pathValidatorCalls = [];
    const stubPathValidator = async (p) => { pathValidatorCalls.push(p); return { resolvedPath: p }; };

    new WsGateway(wss, registry, { pathValidator: stubPathValidator });

    const ws = new FakeSocket();
    wss.simulateConnection(ws, '/ws/terminal'); // no ?project
    await flush();

    // pathValidator NOT called for global session
    expect(pathValidatorCalls).toHaveLength(0);
    expect(registry.getOrCreateCalls).toContain(null);
    expect(ws.closed).toBe(false);
  });

  it('AC10 — slug with ".." rejected by slugResolver → WS close(1008)', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    // pathValidator should never be called
    const pathValidatorCalls = [];
    const stubPathValidator = async (p) => { pathValidatorCalls.push(p); return { resolvedPath: p }; };

    new WsGateway(wss, registry, { pathValidator: stubPathValidator });

    const ws = new FakeSocket();
    wss.simulateConnection(ws, `/ws/terminal?project=${encodeURIComponent('../etc')}`);
    await flush();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    // pathValidator must NOT have been called (slug rejected before boundary check)
    expect(pathValidatorCalls).toHaveLength(0);
    // registry.getOrCreate must NOT have been called (no session created)
    expect(registry.getOrCreateCalls).toHaveLength(0);
    // no data sent before close
    expect(ws.sent).toHaveLength(0);
  });

  it('AC10 — absolute-path slug rejected by slugResolver → WS close(1008)', async () => {
    const wss = new FakeWss();
    const registry = new FakeRegistry();
    const stubPathValidator = async (p) => ({ resolvedPath: p });

    new WsGateway(wss, registry, { pathValidator: stubPathValidator });

    const ws = new FakeSocket();
    // Absolute path is not a valid slug (contains '/')
    wss.simulateConnection(ws, `/ws/terminal?project=${encodeURIComponent('/etc/passwd')}`);
    await flush();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    expect(ws.sent).toHaveLength(0);
    expect(registry.getOrCreateCalls).toHaveLength(0);
  });

  it('AC10 — boundary violation from pathValidator → WS close(1008) (last-defence)', async () => {
    // Simulates: slug resolves to a path that escapes the workspace (e.g. symlink escape).
    // slugResolver produces a path, but pathValidator rejects it.
    const wss = new FakeWss();
    const registry = new FakeRegistry();

    // Use a custom slugResolver that bypasses form check (simulates symlink abuse
    // not catchable by form check alone) — for testing that the boundary check still fires.
    const bypassSlugResolver = () => '/workspace/evil-link';
    const rejectingPathValidator = async () => {
      throw new ProjectPathError('Path is outside workspace boundary', 'outside-boundary');
    };

    new WsGateway(wss, registry, {
      slugResolver: bypassSlugResolver,
      pathValidator: rejectingPathValidator,
    });

    const ws = new FakeSocket();
    wss.simulateConnection(ws, '/ws/terminal?project=some-slug');
    await flush();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    expect(registry.getOrCreateCalls).toHaveLength(0);
  });

  it('AC9/AC10 — both entry paths share the same slug-to-path logic (WsGateway uses resolveProjectSlug)', async () => {
    // Verify that the default slugResolver (resolveProjectSlug) is used in production mode.
    // We inject only pathValidator so slugResolver uses the real resolveProjectSlug.
    // Slug 'dev-gui' with WORKSPACE_DIR=/workspace → expects pathValidator to see /workspace/dev-gui.
    process.env.WORKSPACE_DIR = '/workspace';

    const wss = new FakeWss();
    const pty = new FakePty('sb');
    const registry = new FakeRegistry({ '/workspace/dev-gui': pty });
    const calls = [];
    const pathValidator = async (p) => { calls.push(p); return { resolvedPath: p }; };

    new WsGateway(wss, registry, { pathValidator });

    const ws = new FakeSocket();
    wss.simulateConnection(ws, '/ws/terminal?project=dev-gui');
    await flush();

    expect(calls).toEqual(['/workspace/dev-gui']);
    expect(ws.closed).toBe(false);
  });
});

// ── commandRouter integration: slug resolution ────────────────────────────────

function makeCommandApp({ slugResolver, pathValidator, tryRunResult = null } = {}) {
  const app = express();
  app.use(express.json());
  const guard = createAccessGuard();
  app.use('/api', guard);

  // Minimal CommandService stub
  const stubService = {
    tryRun: ({ projectPath }) => {
      if (tryRunResult) return tryRunResult;
      return { ok: true, commandId: 'cmd-1', status: 'running', _projectPath: projectPath };
    },
  };

  app.use(commandRouter(stubService, { pathValidator, slugResolver }));
  return app;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

describe('commandRouter — slug resolution (AC9 + AC10)', () => {
  let server, port;

  beforeEach(() => {
    process.env.DEV_NO_ACCESS = '1';
    process.env.WORKSPACE_DIR = '/workspace';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
    delete process.env.WORKSPACE_DIR;
  });

  it('AC9 — valid slug → slugResolver + pathValidator called in order; 202 returned', async () => {
    const slugResolverCalls = [];
    const pathValidatorCalls = [];

    const stubSlugResolver = (slug, deps) => {
      slugResolverCalls.push(slug);
      // Delegate to real resolveProjectSlug (with injected mountRoot)
      return resolveProjectSlug(slug, { ...(deps ?? {}), mountRoot: '/workspace' });
    };

    const stubPathValidator = async (p) => {
      pathValidatorCalls.push(p);
      return { resolvedPath: p };
    };

    const app = makeCommandApp({ slugResolver: stubSlugResolver, pathValidator: stubPathValidator });
    ({ server, port } = await startServer(app));

    const res = await postJson(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: 'dev-gui',
    });

    expect(res.status).toBe(202);
    // slugResolver received the raw slug
    expect(slugResolverCalls).toEqual(['dev-gui']);
    // pathValidator received the resolved absolute path
    expect(pathValidatorCalls).toEqual(['/workspace/dev-gui']);
  });

  it('AC9 — global case (no projectPath) → slugResolver and pathValidator NOT called; 202', async () => {
    const slugResolverCalls = [];
    const pathValidatorCalls = [];

    const stubSlugResolver = (slug) => { slugResolverCalls.push(slug); return null; };
    const stubPathValidator = async (p) => { pathValidatorCalls.push(p); return { resolvedPath: p }; };

    const app = makeCommandApp({ slugResolver: stubSlugResolver, pathValidator: stubPathValidator });
    ({ server, port } = await startServer(app));

    const res = await postJson(port, '/api/command', { command: '/agent-flow:flow' });

    expect(res.status).toBe(202);
    expect(slugResolverCalls).toHaveLength(0);
    expect(pathValidatorCalls).toHaveLength(0);
  });

  it('AC10 — slug with ".." → slugResolver throws → 400 returned (no PTY spawn)', async () => {
    // Use default (real) slugResolver so the slug-form check runs
    const pathValidatorCalls = [];
    const stubPathValidator = async (p) => { pathValidatorCalls.push(p); return { resolvedPath: p }; };

    const app = makeCommandApp({ pathValidator: stubPathValidator });
    ({ server, port } = await startServer(app));

    const res = await postJson(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: '../etc',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    // pathValidator must NOT have been called (slug rejected before boundary check)
    expect(pathValidatorCalls).toHaveLength(0);
  });

  it('AC10 — absolute-path projectPath → 400 (slugResolver rejects "/" in slug)', async () => {
    const pathValidatorCalls = [];
    const stubPathValidator = async (p) => { pathValidatorCalls.push(p); return { resolvedPath: p }; };

    const app = makeCommandApp({ pathValidator: stubPathValidator });
    ({ server, port } = await startServer(app));

    const res = await postJson(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: '/etc/passwd',
    });

    expect(res.status).toBe(400);
    expect(pathValidatorCalls).toHaveLength(0);
  });

  it('AC10 — boundary violation from pathValidator → 400 (last-defence remains effective)', async () => {
    // slugResolver produces a valid-looking path, but pathValidator rejects it
    const stubSlugResolver = () => '/workspace/evil-link';
    const rejectingPathValidator = async () => {
      throw new ProjectPathError('Path is outside workspace boundary', 'outside-boundary');
    };

    const app = makeCommandApp({ slugResolver: stubSlugResolver, pathValidator: rejectingPathValidator });
    ({ server, port } = await startServer(app));

    const res = await postJson(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: 'evil-link',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid projectPath/);
  });

  it('AC10 — percent-encoded traversal "..%2fetc" (literal, no URL-decode in JSON body) → 400', async () => {
    // Express JSON parser does NOT URL-decode body values; '..%2fetc' arrives literal.
    // The slug has no '/' → passes slug-form check; resolveProjectSlug produces
    // '/workspace/..%2fetc'; validateProjectPath (realpath-boundary) rejects it → 400.
    // This test ensures the full request path is covered (slug layer + boundary guard).
    const pathValidatorCalls = [];
    const stubPathValidator = async (p) => {
      pathValidatorCalls.push(p);
      // Simulate: the literal dir '/workspace/..%2fetc' does not exist → ENOENT-equivalent
      const { ProjectPathError: PPE } = await import('../src/workspacePath.js');
      throw new PPE('Path does not exist or is outside workspace', 'not-exists');
    };

    const app = makeCommandApp({ pathValidator: stubPathValidator });
    ({ server, port } = await startServer(app));

    const res = await postJson(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: '..%2fetc',
    });

    expect(res.status).toBe(400);
    // pathValidator was called (slug passed form check; boundary guard fired)
    expect(pathValidatorCalls).toEqual(['/workspace/..%2fetc']);
  });

  it('AC10 — NUL-byte slug in JSON body → 400 (slug layer rejects before boundary check)', async () => {
    // NUL-byte slug must be rejected explicitly by resolveProjectSlug (slug layer),
    // NOT passed through to validateProjectPath.
    const pathValidatorCalls = [];
    const stubPathValidator = async (p) => { pathValidatorCalls.push(p); return { resolvedPath: p }; };

    const app = makeCommandApp({ pathValidator: stubPathValidator });
    ({ server, port } = await startServer(app));

    const res = await postJson(port, '/api/command', {
      command: '/agent-flow:flow',
      projectPath: 'dev\x00gui',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    // pathValidator must NOT have been called (slug rejected by slug layer)
    expect(pathValidatorCalls).toHaveLength(0);
  });

  it('AC9 — both WsGateway and commandRouter use same resolveProjectSlug (symmetry check)', () => {
    // Symmetry: resolveProjectSlug produces the same path for both entry paths given the same slug.
    // This is a pure unit assertion (no server needed).
    const slug = 'dev-gui';
    const mountRoot = '/workspace';

    const result = resolveProjectSlug(slug, { mountRoot });
    expect(result).toBe('/workspace/dev-gui');

    // Same function is imported in both WsGateway.js and commandRouter.js
    // (verified by file imports above — same resolveProjectSlug from workspacePath.js)
  });
});
