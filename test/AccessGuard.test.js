/**
 * AccessGuard tests (AC1, AC2, AC5 + fail-closed + dev-bypass + WS postAuthCheck).
 *
 * Uses an in-process RSA keypair generated with jose — no network calls.
 * All JWT signing/verification is done against the injected keyset.
 *
 * Covers (vps-ssh-terminal, S-263): AC9 — createWsAccessGuard()'s new optional
 * `postAuthCheck` option (role-403 for /ws/vps-terminal, enforced BEFORE
 * handleUpgrade, both via the dev-bypass and the real-JWT branch); backward-compat
 * for the existing /ws/terminal caller (no postAuthCheck → unaffected).
 */

import { describe, it, beforeAll, afterEach, expect, jest } from '@jest/globals';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import express from 'express';
import { createServer } from 'node:http';
import { createAccessGuard, createWsAccessGuard, assertAccessConfig } from '../src/AccessGuard.js';
import { AuditStore, auditRouter } from '../src/AuditStore.js';

// ── Key setup ──────────────────────────────────────────────────────────────

let privateKey;
let publicKey;
let keySet; // JWKS-compatible local keyset

const AUD = 'test-aud-12345';

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { modulusLength: 2048 });
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;

  const jwk = await exportJWK(publicKey);
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  jwk.kid = 'test-key-1';
  keySet = createLocalJWKSet({ keys: [jwk] });
});

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a signed JWT with the test private key.
 */
async function buildToken({ email = 'user@example.com', aud = AUD, exp = null, wrongKey = false } = {}) {
  let signingKey = privateKey;
  if (wrongKey) {
    // Generate a throwaway key for signature mismatch test
    const { privateKey: badKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
    signingKey = badKey;
  }
  const builder = new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setAudience(aud)
    .setIssuedAt();

  if (exp === null) {
    builder.setExpirationTime('1h');
  } else {
    // Explicitly set numeric exp
    builder.setExpirationTime(exp);
  }

  return builder.sign(signingKey);
}

/**
 * Create a minimal Express app + HTTP server with AccessGuard applied.
 * Returns { app, server, guard } — caller must close server when done.
 */
function makeApp(guardOptions = {}) {
  const app = express();
  const guard = createAccessGuard({ aud: AUD, keySet, ...guardOptions });
  app.use('/api', guard);
  app.get('/api/ping', (_req, res) => {
    res.json({ identity: _req.identity });
  });
  const server = createServer(app);
  return { app, server };
}

/**
 * Make an HTTP request to the server without using external fetch.
 */
function request(server, path, headers = {}) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const options = {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      };
      import('node:http').then(({ request: httpReq }) => {
        const req = httpReq(options, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            resolve({ status: res.statusCode, body });
          });
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.end();
      });
    });
  });
}

/**
 * Higher-level helper: spin up a test server, make one request, tear down.
 */
async function probe(guardOptions, headers) {
  const { server } = makeApp(guardOptions);
  try {
    return await request(server, '/api/ping', headers);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ── AC1: valid token passes + identity extracted ───────────────────────────

describe('AC1 — valid token passes and identity is extracted', () => {
  it('valid RS256 JWT → 200 and email extracted', async () => {
    const token = await buildToken({ email: 'alice@example.com' });
    const res = await probe({}, { 'cf-access-jwt-assertion': token });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.identity.email).toBe('alice@example.com');
  });
});

// ── AC1: invalid tokens → 403 ─────────────────────────────────────────────

describe('AC1 — invalid/missing JWT → 403', () => {
  it('missing header → 403', async () => {
    const res = await probe({}, {});
    expect(res.status).toBe(403);
  });

  it('empty header value → 403', async () => {
    const res = await probe({}, { 'cf-access-jwt-assertion': '' });
    expect(res.status).toBe(403);
  });

  it('expired token → 403', async () => {
    // exp in the past
    const token = await buildToken({ exp: '1s' });
    // Wait 2 seconds so it's definitely expired
    await new Promise((r) => setTimeout(r, 1500));
    const res = await probe({}, { 'cf-access-jwt-assertion': token });
    expect(res.status).toBe(403);
  }, 10000);

  it('wrong audience → 403', async () => {
    const token = await buildToken({ aud: 'wrong-audience' });
    const res = await probe({}, { 'cf-access-jwt-assertion': token });
    expect(res.status).toBe(403);
  });

  it('bad signature (different key) → 403', async () => {
    const token = await buildToken({ wrongKey: true });
    const res = await probe({}, { 'cf-access-jwt-assertion': token });
    expect(res.status).toBe(403);
  });

  it('garbage string → 403', async () => {
    const res = await probe({}, { 'cf-access-jwt-assertion': 'not.a.jwt' });
    expect(res.status).toBe(403);
  });
});

// ── R04: /api/audit requires valid JWT (server-wiring integration) ────────

describe('R04 — GET /api/audit returns 403 without valid JWT (guard-order regression)', () => {
  /**
   * Builds a server that mirrors the production server.js wiring:
   * AccessGuard applied to /api, then auditRouter mounted.
   * Verifies the guard cannot be silently dropped by a future middleware reorder.
   */
  function makeAuditServer(guardOptions = {}) {
    const app = express();
    const guard = createAccessGuard({ aud: AUD, keySet, ...guardOptions });
    app.use('/api', guard);
    const store = new AuditStore();
    app.use(auditRouter(store));
    return createServer(app);
  }

  it('GET /api/audit without JWT → 403', async () => {
    const server = makeAuditServer();
    try {
      const res = await request(server, '/api/audit', {});
      expect(res.status).toBe(403);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('GET /api/audit with valid JWT → 200', async () => {
    const token = await buildToken({ email: 'auditor@example.com' });
    const server = makeAuditServer();
    try {
      const res = await request(server, '/api/audit', { 'cf-access-jwt-assertion': token });
      expect(res.status).toBe(200);
      // Must return an array (empty or not)
      const data = JSON.parse(res.body);
      expect(Array.isArray(data)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── Fail-closed: JWKS unreachable ─────────────────────────────────────────

describe('Fail-closed — JWKS fetch error → 403', () => {
  it('keySet that always throws → 403', async () => {
    const brokenKeySet = () => { throw new Error('JWKS unreachable'); };
    const token = await buildToken();
    const res = await probe({ keySet: brokenKeySet }, { 'cf-access-jwt-assertion': token });
    expect(res.status).toBe(403);
  });

  it('no teamDomain and no keySet → 403 (cannot build keyset)', async () => {
    // Guard with no keySet and no teamDomain configured — must fail-closed
    const savedTeam = process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_TEAM_DOMAIN;
    const { server } = makeApp({ keySet: undefined, teamDomain: undefined });
    try {
      const token = await buildToken();
      const result = await request(server, '/api/ping', { 'cf-access-jwt-assertion': token });
      expect(result.status).toBe(403);
    } finally {
      await new Promise((r) => server.close(r));
      if (savedTeam !== undefined) process.env.ACCESS_TEAM_DOMAIN = savedTeam;
    }
  });
});

// ── AC5: JWT never logged ──────────────────────────────────────────────────

describe('AC5 — JWT and claims not logged', () => {
  it('no console.error/warn output contains the JWT string on failure', async () => {
    const token = await buildToken({ aud: 'wrong-audience' });
    const logs = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => logs.push(args.join(' '));
    try {
      await probe({}, { 'cf-access-jwt-assertion': token });
      // The token (a long base64url string) must NOT appear in any log
      for (const log of logs) {
        expect(log).not.toContain(token);
      }
    } finally {
      console.error = origError;
      console.warn = origWarn;
    }
  });
});

// ── Dev bypass ────────────────────────────────────────────────────────────

describe('Dev bypass — DEV_NO_ACCESS=1 + non-prod → allowed without token', () => {
  afterEach(() => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.NODE_ENV;
  });

  it('DEV_NO_ACCESS=1 and NODE_ENV unset → /api/ping returns 200 without token', async () => {
    process.env.DEV_NO_ACCESS = '1';
    delete process.env.NODE_ENV; // non-production
    const res = await probe({}, {});
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.identity.email).toBe('dev@local');
  });

  it('DEV_NO_ACCESS=1 but NODE_ENV=production → bypass NOT active, missing token → 403', async () => {
    process.env.DEV_NO_ACCESS = '1';
    process.env.NODE_ENV = 'production';
    const res = await probe({}, {});
    expect(res.status).toBe(403);
    delete process.env.NODE_ENV;
    delete process.env.DEV_NO_ACCESS;
  });
});

// ── AC2: assertAccessConfig ───────────────────────────────────────────────

describe('AC2 — assertAccessConfig throws in production without config', () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;
    delete process.env.DEV_NO_ACCESS;
  });

  it('production + missing both → throws', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;
    expect(() => assertAccessConfig()).toThrow(/ACCESS_TEAM_DOMAIN/);
  });

  it('production + missing AUD only → throws', () => {
    process.env.NODE_ENV = 'production';
    process.env.ACCESS_TEAM_DOMAIN = 'example.cloudflareaccess.com';
    delete process.env.ACCESS_AUD;
    expect(() => assertAccessConfig()).toThrow(/ACCESS_AUD/);
  });

  it('production + missing TEAM_DOMAIN only → throws', () => {
    process.env.NODE_ENV = 'production';
    process.env.ACCESS_AUD = 'some-aud';
    delete process.env.ACCESS_TEAM_DOMAIN;
    expect(() => assertAccessConfig()).toThrow(/ACCESS_TEAM_DOMAIN/);
  });

  it('production + both present → does not throw', () => {
    process.env.NODE_ENV = 'production';
    process.env.ACCESS_TEAM_DOMAIN = 'example.cloudflareaccess.com';
    process.env.ACCESS_AUD = 'some-aud';
    expect(() => assertAccessConfig()).not.toThrow();
  });

  it('non-production + missing config → throws (still required without dev bypass)', () => {
    delete process.env.NODE_ENV;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;
    delete process.env.DEV_NO_ACCESS;
    expect(() => assertAccessConfig()).toThrow();
  });

  it('non-production + DEV_NO_ACCESS=1 + missing config → no throw', () => {
    delete process.env.NODE_ENV;
    process.env.DEV_NO_ACCESS = '1';
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;
    expect(() => assertAccessConfig()).not.toThrow();
  });
});

// ── AC2: process exit in production (child-process test) ──────────────────

describe('AC2 — server refuses to start in production without Access config', () => {
  it('NODE_ENV=production + no ACCESS vars → child process exits non-zero', async () => {
    const { execFile } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const serverPath = path.join(__dirname, '../server.js');

    const exitCode = await new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        ['--input-type=module', '--eval',
          `import '${serverPath}'`],
        {
          env: {
            ...process.env,
            NODE_ENV: 'production',
            ACCESS_TEAM_DOMAIN: '',
            ACCESS_AUD: '',
            DEV_NO_ACCESS: '',
            // Use a dummy SESSION_CMD so PTY spawn doesn't cause noise
            SESSION_CMD: '/bin/true',
          },
          timeout: 5000,
        },
        (_err, _stdout, _stderr) => {
          // _err.code holds exit code when process exits non-zero
          resolve(_err ? (_err.code ?? 1) : 0);
        },
      );
      // Ensure it doesn't hang
      setTimeout(() => { try { child.kill(); } catch { /**/ } }, 4500);
    });

    expect(exitCode).not.toBe(0);
  }, 10000);
});

// ── createWsAccessGuard — postAuthCheck (AC9 Rolle-403, vps-ssh-terminal S-263) ──
// Fake wss/socket (no live HTTP server needed — createWsAccessGuard operates purely
// on req/socket/head + wss.handleUpgrade/emit).

function makeFakeWss() {
  return {
    handleUpgrade: jest.fn((_req, _socket, _head, cb) => cb({ fakeWs: true })),
    emit: jest.fn(),
  };
}

function makeFakeSocket() {
  return { write: jest.fn(), destroy: jest.fn() };
}

describe('createWsAccessGuard — postAuthCheck (AC9 Rolle-403, S-263)', () => {
  afterEach(() => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.NODE_ENV;
  });

  it('backward-compat: no postAuthCheck option → existing /ws/terminal behavior unaffected', async () => {
    const token = await buildToken({ email: 'user@example.com' });
    const wss = makeFakeWss();
    const socket = makeFakeSocket();
    const guard = createWsAccessGuard(wss, { aud: AUD, keySet });
    await guard({ headers: { 'cf-access-jwt-assertion': token } }, socket, Buffer.alloc(0));
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('valid JWT + postAuthCheck() returns false → 403 + destroy, handleUpgrade NOT called', async () => {
    const token = await buildToken({ email: 'notadmin@example.com' });
    const wss = makeFakeWss();
    const socket = makeFakeSocket();
    const guard = createWsAccessGuard(wss, {
      aud: AUD,
      keySet,
      postAuthCheck: (req) => req.identity?.email === 'admin@example.com',
    });
    await guard({ headers: { 'cf-access-jwt-assertion': token } }, socket, Buffer.alloc(0));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('valid JWT + postAuthCheck() returns true → handleUpgrade called, identity already set', async () => {
    const token = await buildToken({ email: 'admin@example.com' });
    const wss = makeFakeWss();
    const socket = makeFakeSocket();
    let seenIdentity;
    const guard = createWsAccessGuard(wss, {
      aud: AUD,
      keySet,
      postAuthCheck: (req) => {
        seenIdentity = req.identity;
        return true;
      },
    });
    await guard({ headers: { 'cf-access-jwt-assertion': token } }, socket, Buffer.alloc(0));
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(seenIdentity).toEqual({ email: 'admin@example.com' });
  });

  it('missing token → 403 regardless of postAuthCheck (AccessGuard-403 still takes precedence)', async () => {
    const wss = makeFakeWss();
    const socket = makeFakeSocket();
    const postAuthCheck = jest.fn(() => true);
    const guard = createWsAccessGuard(wss, { aud: AUD, keySet, postAuthCheck });
    await guard({ headers: {} }, socket, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    // postAuthCheck must never even run — the Access-Mauer rejects before role check.
    expect(postAuthCheck).not.toHaveBeenCalled();
  });

  it('dev-bypass (DEV_NO_ACCESS=1) + postAuthCheck() returns false → 403, no bypass of the role check', async () => {
    process.env.DEV_NO_ACCESS = '1';
    delete process.env.NODE_ENV;
    const wss = makeFakeWss();
    const socket = makeFakeSocket();
    const guard = createWsAccessGuard(wss, { postAuthCheck: () => false });
    await guard({ headers: {} }, socket, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('dev-bypass (DEV_NO_ACCESS=1) + postAuthCheck() returns true → handleUpgrade called', async () => {
    process.env.DEV_NO_ACCESS = '1';
    delete process.env.NODE_ENV;
    const wss = makeFakeWss();
    const socket = makeFakeSocket();
    const guard = createWsAccessGuard(wss, { postAuthCheck: () => true });
    await guard({ headers: {} }, socket, Buffer.alloc(0));
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
  });
});
