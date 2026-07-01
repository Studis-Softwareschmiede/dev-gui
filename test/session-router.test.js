/**
 * session-router.test.js — HTTP-level tests for GET /api/session
 * (reconcile-inline-feedback / S-205 AC6).
 *
 * Covers (reconcile-inline-feedback):
 *   AC6 — `GET /api/session` returns `state:"busy"` while a Command-Job is in
 *          flight (commandService.getStatus().status === 'running'), and the
 *          pre-existing PTY-lifecycle state (e.g. "ready") once the job
 *          completes — a Vertragsänderung of the route (previously it only
 *          reflected ptyManager.state, never job status). HTTP-level test per
 *          coder/R06 — the unit-level CommandService.getStatus() tests
 *          (test/CommandService.test.js, test/CommandServiceMultiSession.test.js)
 *          are NOT a substitute for verifying the route actually surfaces it.
 *
 * Backward-compat (unchanged behaviour, regression guard):
 *   - No commandService dependency provided → route falls back to the plain
 *     ptyManager.state (pre-S-205 behaviour), no crash.
 *   - restarts/startedAt fields unchanged.
 *
 * Strategy: real Express app + src/routers/session.js create(deps), HTTP via
 * node:http (same helper pattern as test/CommandServiceMultiSession.test.js —
 * no supertest dependency in this repo).
 */

import { describe, it, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { create as createSessionRouter } from '../src/routers/session.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal ptyManager stub — only the fields session.js reads. */
function makePtyManager({ state = 'ready', restarts = 0, startedAt = null } = {}) {
  return { state, restarts, startedAt };
}

/** Minimal commandService stub — only getStatus() is read by session.js. */
function makeCommandService(status) {
  return { getStatus: () => ({ commandId: status === 'running' ? 'cmd-1' : null, status }) };
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

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function buildApp(deps) {
  const app = express();
  app.use(createSessionRouter(deps));
  return startServer(app);
}

// ── AC6: busy reflects commandService running state ────────────────────────────

describe('GET /api/session — reconcile-inline-feedback (S-205) AC6', () => {
  let server, port;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
  });

  it('commandService running → state:"busy" (job-in-flight surfaced, not just PTY lifecycle)', async () => {
    const ptyManager = makePtyManager({ state: 'ready' });
    const commandService = makeCommandService('running');
    ({ server, port } = await buildApp({ ptyManager, commandService }));

    const res = await get(port, '/api/session');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('busy');
  });

  it('commandService done → state falls back to ptyManager.state ("ready")', async () => {
    const ptyManager = makePtyManager({ state: 'ready' });
    const commandService = makeCommandService('done');
    ({ server, port } = await buildApp({ ptyManager, commandService }));

    const res = await get(port, '/api/session');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ready');
  });

  it('commandService null status (never run) → state falls back to ptyManager.state', async () => {
    const ptyManager = makePtyManager({ state: 'ready' });
    const commandService = makeCommandService(null);
    ({ server, port } = await buildApp({ ptyManager, commandService }));

    const res = await get(port, '/api/session');
    expect(res.body.state).toBe('ready');
  });

  it('AC6 — sequence: running → busy, then done → non-busy again (job completion visible)', async () => {
    const ptyManager = makePtyManager({ state: 'ready' });
    let status = 'running';
    const commandService = { getStatus: () => ({ commandId: 'cmd-1', status }) };
    ({ server, port } = await buildApp({ ptyManager, commandService }));

    const first = await get(port, '/api/session');
    expect(first.body.state).toBe('busy');

    status = 'done';
    const second = await get(port, '/api/session');
    expect(second.body.state).toBe('ready');
  });

  it('restarts/startedAt fields are passed through unchanged', async () => {
    const startedAt = '2026-07-01T00:00:00.000Z';
    const ptyManager = makePtyManager({ state: 'ready', restarts: 3, startedAt });
    const commandService = makeCommandService('done');
    ({ server, port } = await buildApp({ ptyManager, commandService }));

    const res = await get(port, '/api/session');
    expect(res.body.restarts).toBe(3);
    expect(res.body.startedAt).toBe(startedAt);
  });
});

// ── Backward compat: no commandService dependency ───────────────────────────────

describe('GET /api/session — backward compat (no commandService dependency)', () => {
  let server, port;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
  });

  it('no commandService provided → falls back to plain ptyManager.state, no crash', async () => {
    const ptyManager = makePtyManager({ state: 'starting' });
    ({ server, port } = await buildApp({ ptyManager }));

    const res = await get(port, '/api/session');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('starting');
  });
});
