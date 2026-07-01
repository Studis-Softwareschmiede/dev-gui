/**
 * @file reconcileRouter.test.js — HTTP-level tests for the Headless-Reconcile-Runner
 * endpoints (docs/specs/headless-reconcile-runner.md AC8, AC9).
 *
 * Covers (headless-reconcile-runner): AC8, AC9
 *
 *   AC8 — POST /api/reconcile { projectSlug } → 202 { jobId, status:"running" };
 *         active project lock → 409; missing/invalid/traversal slug → 400
 *         (slug-form check before path concatenation, security/R02/R03); missing
 *         projectSlug → 400 (headless runner is always project-bound, unlike the
 *         global /api/command fallback).
 *   AC9  — GET /api/reconcile/:jobId → { status, result?, error?, prHint? } with
 *         status ∈ {running,done,failed,auth-expired}; unknown jobId → 404.
 *
 * Pattern: express + node:http createServer on port 0 (127.0.0.1), no supertest
 * (matches assistRefineRouter.test.js / deploymentsRouter.test.js). The real
 * HeadlessReconcileRunner is used, but with an injected spawnFn stub — no real
 * `claude` process, and no reliance on the interactive PTY path (AC7).
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { reconcileRouter } from '../src/reconcileRouter.js';
import { HeadlessReconcileRunner } from '../src/HeadlessReconcileRunner.js';
import { ProjectPathError } from '../src/workspacePath.js';

// ── HTTP-Hilfsfunktionen (Muster assistRefineRouter.test.js) ──────────────────

function httpPost(server, path, body) {
  return new Promise((resolvePromise, reject) => {
    const port = server.address().port;
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
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolvePromise({ status: res.statusCode, body: data });
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpGet(server, path) {
  return new Promise((resolvePromise, reject) => {
    const port = server.address().port;
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolvePromise({ status: res.statusCode, body: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function startServer(app) {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer(app);
    srv.listen(0, '127.0.0.1', () => resolvePromise(srv));
    srv.on('error', reject);
  });
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function tick() {
  return new Promise((r) => setImmediate(r));
}

/**
 * Builds an express app mounting reconcileRouter, with an injectable
 * pathValidator/slugResolver (bypasses the real WORKSPACE_DIR/realpath
 * filesystem checks — mirrors commandRouter.test.js style).
 */
function makeApp({ runner, pathValidator, slugResolver } = {}) {
  const app = express();
  app.use(express.json());
  const _runner = runner ?? new HeadlessReconcileRunner({ spawnFn: jest.fn(() => makeFakeChild()), timeoutMs: 10_000 });
  app.use(reconcileRouter(_runner, { pathValidator, slugResolver }));
  return { app, runner: _runner };
}

const defaultSlugResolver = (slug) => (slug ? `/workspace/${slug}` : null);
const defaultPathValidator = async (p) => ({ resolvedPath: p });

describe('POST /api/reconcile — AC8: happy path (202)', () => {
  it('202 { jobId, status:"running" } for a valid projectSlug', async () => {
    const { app } = makeApp({ slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/reconcile', { projectSlug: 'dev-gui' });
      expect(status).toBe(202);
      expect(typeof body.jobId).toBe('string');
      expect(body.status).toBe('running');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/reconcile — AC8: 400 on missing/invalid/traversal slug', () => {
  it('400 when projectSlug is missing entirely (always project-bound, no global fallback)', async () => {
    const { app } = makeApp({ slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/reconcile', {});
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 when projectSlug is an empty string', async () => {
    const { app } = makeApp({ slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/reconcile', { projectSlug: '   ' });
      expect(status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 when the slug resolver rejects a traversal-shaped slug (security/R02/R03)', async () => {
    const throwingSlugResolver = () => {
      throw new ProjectPathError("Project slug must not contain '/'", 'outside-boundary');
    };
    const { app } = makeApp({ slugResolver: throwingSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/reconcile', { projectSlug: '../etc' });
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 when the boundary path validator rejects the resolved path (outside WORKSPACE_DIR)', async () => {
    const rejectingPathValidator = async () => {
      throw new ProjectPathError('outside boundary', 'outside-boundary');
    };
    const { app } = makeApp({ slugResolver: defaultSlugResolver, pathValidator: rejectingPathValidator });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/reconcile', { projectSlug: 'evil' });
      expect(status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/reconcile — AC8/AC5: 409 on active project lock', () => {
  it('409 when a reconcile job is already running for the SAME project', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });
    const { app } = makeApp({ runner, slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const first = await httpPost(srv, '/api/reconcile', { projectSlug: 'dev-gui' });
      expect(first.status).toBe(202);

      const second = await httpPost(srv, '/api/reconcile', { projectSlug: 'dev-gui' });
      expect(second.status).toBe(409);
      expect(typeof second.body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('does NOT block a start for a DIFFERENT project (no cross-project lock)', async () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });
    const { app } = makeApp({ runner, slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const first = await httpPost(srv, '/api/reconcile', { projectSlug: 'project-a' });
      const second = await httpPost(srv, '/api/reconcile', { projectSlug: 'project-b' });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('GET /api/reconcile/:jobId — AC9: status shapes + unknown jobId', () => {
  it('200 { status:"running" } while the job is in flight', async () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });
    const { app } = makeApp({ runner, slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const { body: startBody } = await httpPost(srv, '/api/reconcile', { projectSlug: 'proj-running' });
      const { status, body } = await httpGet(srv, `/api/reconcile/${startBody.jobId}`);
      expect(status).toBe(200);
      expect(body.status).toBe('running');
      expect(body.result).toBeUndefined();
      expect(body.error).toBeUndefined();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('200 { status:"done", prHint } once the process exits cleanly', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });
    const { app } = makeApp({ runner, slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const { body: startBody } = await httpPost(srv, '/api/reconcile', { projectSlug: 'proj-done' });
      child.stdout.emit('data', 'PR: https://github.com/acme/repo/pull/9\n');
      child.emit('close', 0);
      await tick();

      const { status, body } = await httpGet(srv, `/api/reconcile/${startBody.jobId}`);
      expect(status).toBe(200);
      expect(body.status).toBe('done');
      expect(body.prHint).toBe('https://github.com/acme/repo/pull/9');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('200 { status:"failed", error } on a non-zero exit without a 401 signature', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });
    const { app } = makeApp({ runner, slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const { body: startBody } = await httpPost(srv, '/api/reconcile', { projectSlug: 'proj-failed' });
      child.emit('close', 1);
      await tick();

      const { status, body } = await httpGet(srv, `/api/reconcile/${startBody.jobId}`);
      expect(status).toBe(200);
      expect(body.status).toBe('failed');
      expect(typeof body.error).toBe('string');
      expect(body.error).not.toMatch(/\/workspace\//);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('200 { status:"auth-expired", error } with the renewal hint when a 401 signature is detected', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });
    const { app } = makeApp({ runner, slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const { body: startBody } = await httpPost(srv, '/api/reconcile', { projectSlug: 'proj-auth' });
      child.stderr.emit('data', 'Invalid authentication credentials\n');
      child.emit('close', 1);
      await tick();

      const { status, body } = await httpGet(srv, `/api/reconcile/${startBody.jobId}`);
      expect(status).toBe(200);
      expect(body.status).toBe('auth-expired');
      expect(body.error).toMatch(/claude setup-token/);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 for an unknown jobId', async () => {
    const { app } = makeApp({ slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpGet(srv, '/api/reconcile/does-not-exist');
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
