/**
 * version.test.js — tests for GET /api/version (build-version)
 *
 * Covers:
 *   - Returns { version: process.env.APP_VERSION } when the env var is set
 *   - Returns { version: "dev" } when APP_VERSION is not set
 *   - Endpoint is behind accessGuard (/api/* guard — DEV_NO_ACCESS bypass used in tests)
 *   - Response is always 200
 *
 * Strategy:
 *   - Build a minimal Express app with AccessGuard (dev bypass) + versionRouter
 *   - Run real HTTP requests against it
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createAccessGuard } from '../src/AccessGuard.js';
import { versionRouter } from '../src/versionRouter.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
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
    req.end();
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  const guard = createAccessGuard();
  app.use('/api', guard);
  app.use(versionRouter());
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/version — APP_VERSION set', () => {
  let server, port;
  const savedVersion = process.env.APP_VERSION;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    process.env.APP_VERSION = '260609063500 CEST';
    const app = makeApp();
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
    if (savedVersion === undefined) {
      delete process.env.APP_VERSION;
    } else {
      process.env.APP_VERSION = savedVersion;
    }
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/version');
    expect(res.status).toBe(200);
  });

  it('returns { version } matching APP_VERSION', async () => {
    const res = await get(port, '/api/version');
    expect(res.body).toEqual({ version: '260609063500 CEST' });
  });
});

describe('GET /api/version — APP_VERSION not set (fallback "dev")', () => {
  let server, port;
  const savedVersion = process.env.APP_VERSION;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    delete process.env.APP_VERSION;
    const app = makeApp();
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
    if (savedVersion !== undefined) {
      process.env.APP_VERSION = savedVersion;
    }
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/version');
    expect(res.status).toBe(200);
  });

  it('returns { version: "dev" } when APP_VERSION is unset', async () => {
    const res = await get(port, '/api/version');
    expect(res.body).toEqual({ version: 'dev' });
  });
});

describe('GET /api/version — behind AccessGuard', () => {
  let server, port, savedAud, savedTeam;

  beforeEach(async () => {
    // No DEV_NO_ACCESS — guard is active. Without a cf-access-jwt-assertion
    // header the guard rejects at the missing-header check (403), before JWKS.
    delete process.env.DEV_NO_ACCESS;
    // Save + clear the real Access config vars (ACCESS_AUD / ACCESS_TEAM_DOMAIN)
    // so the guard environment is deterministic; restored in afterEach.
    savedAud = process.env.ACCESS_AUD;
    savedTeam = process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;
    delete process.env.ACCESS_TEAM_DOMAIN;
    const app = makeApp();
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    if (savedAud !== undefined) process.env.ACCESS_AUD = savedAud;
    if (savedTeam !== undefined) process.env.ACCESS_TEAM_DOMAIN = savedTeam;
  });

  it('rejects unauthenticated requests (no DEV_NO_ACCESS, no token)', async () => {
    const res = await get(port, '/api/version');
    // AccessGuard returns 401 or 403 when not in dev mode and no valid token
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
