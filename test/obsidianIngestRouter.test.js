/**
 * @file obsidianIngestRouter.test.js — HTTP-level tests for the headless
 * Obsidian-Ingest endpoints (docs/specs/obsidian-question-catalog.md).
 *
 * Covers (obsidian-question-catalog): AC1, AC2, AC4, AC5, AC6, AC7
 *
 *   AC1 — POST /api/obsidian-ingest/start { projectFolderPath } → 202 { jobId,
 *         status:"running" }; active project lock → 409; missing/not-listed path →
 *         400; vault not configured / "Projekte" unreachable → 404 (vault-confined
 *         resolution via listObsidianVaultProjects, security/R02/R03 — reuse, no
 *         new confinement mechanism, obsidian-vault-config AC5).
 *
 * Covers (obsidian-vault-config v3, S-380 — AC10):
 *   AC10 — the Ingest-Flow (this router) resolves the project-subdir via the SAME
 *         persisted → env → default ranking as the other consumption points
 *         (AC2c/AC5) — verified by asserting `listProjects` receives the effective
 *         `projekteSubdir` computed from a persisted CredentialStore value.
 *   AC2 — GET /api/obsidian-ingest/:jobId → 200 { status, catalog?, result?, error? };
 *         `catalog` only on needs-answers; secret-free; unknown jobId → 404.
 *   AC4 — POST /api/obsidian-ingest/:jobId/answers → 202 { status:"running" } on a
 *         valid required-complete set; missing required / unknown id → 400.
 *   AC5 — after answers the status endpoint reports the next state (running →
 *         done/needs-answers) — verified via the real runner + a stubbed adapter.
 *   AC6 — Security floor at the HTTP layer: start + answers are audited exactly
 *         once with identity (audit-first: audit-write failure → 500, action not
 *         performed); error/catalog bodies are secret-free.
 *         AccessGuard-Verdrahtung: per server.js-Inspektion (`app.use('/api',
 *         accessGuard)`), kein separater Middleware-Test.
 *   AC7 — error paths: answers on a non-waiting job → 409; unknown job → 404;
 *         malformed answers body → 400.
 *
 * Pattern: express + node:http on port 0 (matches reconcileRouter.test.js). The
 * REAL ObsidianIngestRunner is used with an injected runClaude adapter — no real
 * `claude` process, no PTY path. Path confinement is exercised via injected
 * `credentialStore`/`listProjects`/`realpath` stubs (no real fs/vault needed —
 * `obsidianVaultPath.test.js` already covers `listObsidianVaultProjects()` itself).
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { obsidianIngestRouter } from '../src/obsidianIngestRouter.js';
import { ObsidianIngestRunner } from '../src/ObsidianIngestRunner.js';
import { ObsidianVaultPathError } from '../src/obsidianVaultPath.js';

// ── HTTP helpers (Muster reconcileRouter.test.js) ────────────────────────────

function httpPost(server, path, body, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const port = server.address().port;
    const bodyStr = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
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
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolvePromise({ status: res.statusCode, body: data });
      });
    });
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

function flush() {
  return new Promise((r) => setImmediate(r));
}

// Default fixtures: a configured vault with three "known" project folders —
// mirrors the paths exercised elsewhere in this file. `realpath` is an identity
// passthrough by default (no real fs access needed for the router-level tests).
const KNOWN_PROJECTS = [
  { name: 'proj', path: '/workspace/proj' },
  { name: 'other', path: '/workspace/other' },
  { name: 'secret-path', path: '/workspace/secret-path' },
];
const defaultCredentialStore = { readObsidianVaultPath: async () => '/vault' };
const defaultListProjects = async () => KNOWN_PROJECTS;
const defaultRealpath = async (p) => p;

const CATALOG_OUTPUT = JSON.stringify({
  status: 'needs-answers',
  catalog: [{ stage: 'Notiz→Konzept', id: 'q1', frage: 'Ziel?', quelle: 'n.md' }],
});

/** A runClaude adapter returning queued round results. */
function sequencedRunClaude(results) {
  const queue = [...results];
  return jest.fn(async () => queue.shift() ?? { exitCode: 0, output: '{"status":"done"}', authError: false });
}

function makeApp({ runner, credentialStore, listProjects, realpath, auditStore, identity } = {}) {
  const app = express();
  app.use(express.json());
  // Simulate the AccessGuard identity claim (server.js applies the guard before mount).
  if (identity !== undefined) {
    app.use((req, _res, next) => { req.identity = identity; next(); });
  }
  const _runner =
    runner ?? new ObsidianIngestRunner({ runClaude: sequencedRunClaude([]) });
  app.use(
    obsidianIngestRouter(_runner, {
      credentialStore: credentialStore ?? defaultCredentialStore,
      listProjects: listProjects ?? defaultListProjects,
      realpath: realpath ?? defaultRealpath,
      auditStore,
    }),
  );
  return { app, runner: _runner };
}

// ── POST /start (AC1) ────────────────────────────────────────────────────────

describe('POST /api/obsidian-ingest/start — AC1', () => {
  it('202 { jobId, status:"running" } for a vault-listed projectFolderPath', async () => {
    const runner = new ObsidianIngestRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, output: CATALOG_OUTPUT, authError: false }]) });
    const { app } = makeApp({ runner });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      expect(status).toBe(202);
      expect(typeof body.jobId).toBe('string');
      expect(body.status).toBe('running');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 when projectFolderPath is missing', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', {});
      expect(status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 when the path is not one of the listed <vault>/Projekte entries (security/R02/R03)', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/etc/passwd' });
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 when realpath rejects a non-existent path', async () => {
    const rejectingRealpath = async () => { throw new Error('ENOENT'); };
    const { app } = makeApp({ realpath: rejectingRealpath });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      expect(status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 when no Obsidian vault is configured', async () => {
    const unconfigured = { readObsidianVaultPath: async () => null };
    const { app } = makeApp({ credentialStore: unconfigured });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('AC10 (obsidian-vault-config v3, S-380) — listProjects receives the effective projekteSubdir per the persisted → env → default ranking', async () => {
    process.env.OBSIDIAN_PROJEKTE_SUBDIR = 'Env Segment';
    try {
      let receivedDeps;
      const capturingListProjects = async (_vaultPath, deps) => { receivedDeps = deps; return KNOWN_PROJECTS; };
      const credentialStoreWithPersisted = {
        readObsidianVaultPath: async () => '/vault',
        readObsidianProjekteSubdir: async () => 'GUI Segment',
      };
      const { app } = makeApp({ credentialStore: credentialStoreWithPersisted, listProjects: capturingListProjects });
      const srv = await startServer(app);
      try {
        await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
        expect(receivedDeps?.projekteSubdir).toBe('GUI Segment'); // persisted verdrängt Env
      } finally {
        await new Promise((r) => srv.close(r));
      }
    } finally {
      delete process.env.OBSIDIAN_PROJEKTE_SUBDIR;
    }
  });

  it('404 when "Projekte" is (no longer) reachable (vault-unreachable/missing-projekte)', async () => {
    const failingListProjects = async () => { throw new ObsidianVaultPathError('Vault enthält keinen Unterordner', 'missing-projekte'); };
    const { app } = makeApp({ listProjects: failingListProjects });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('409 when an ingest is already active for the SAME project (lock held during needs-answers)', async () => {
    const runner = new ObsidianIngestRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: CATALOG_OUTPUT, authError: false }]),
    });
    const { app } = makeApp({ runner });
    const srv = await startServer(app);
    try {
      const first = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      expect(first.status).toBe(202);
      await flush(); // settle into needs-answers (lock still held)
      const second = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      expect(second.status).toBe(409);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── GET /:jobId (AC2) ────────────────────────────────────────────────────────

describe('GET /api/obsidian-ingest/:jobId — AC2', () => {
  it('200 with the catalog on needs-answers, secret-free', async () => {
    const runner = new ObsidianIngestRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: CATALOG_OUTPUT, sessionId: 's1', authError: false }]),
    });
    const { app } = makeApp({ runner });
    const srv = await startServer(app);
    try {
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      await flush();
      const { status, body } = await httpGet(srv, `/api/obsidian-ingest/${startBody.jobId}`);
      expect(status).toBe(200);
      expect(body.status).toBe('needs-answers');
      expect(Array.isArray(body.catalog)).toBe(true);
      expect(body.catalog[0]).toMatchObject({ id: 'q1', frage: 'Ziel?', pflicht: true });
      // secret-free: no internal fields.
      expect(body).not.toHaveProperty('sessionId');
      expect(JSON.stringify(body)).not.toMatch(/s1/);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('200 { status:"failed", error } secret-free on an unparsable catalog (AC2/AC7)', async () => {
    const runner = new ObsidianIngestRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: 'garbage from /Users/secret', authError: false }]),
    });
    const { app } = makeApp({ runner });
    const srv = await startServer(app);
    try {
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      await flush();
      const { status, body } = await httpGet(srv, `/api/obsidian-ingest/${startBody.jobId}`);
      expect(status).toBe(200);
      expect(body.status).toBe('failed');
      expect(typeof body.error).toBe('string');
      expect(body.error).not.toMatch(/secret/);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 for an unknown jobId', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status } = await httpGet(srv, '/api/obsidian-ingest/does-not-exist');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── POST /:jobId/answers (AC4, AC5, AC7) ─────────────────────────────────────

describe('POST /api/obsidian-ingest/:jobId/answers — AC4/AC5/AC7', () => {
  it('202 { status:"running" } and reaches done after a valid resume', async () => {
    const runner = new ObsidianIngestRunner({
      runClaude: sequencedRunClaude([
        { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 's1', authError: false },
        { exitCode: 0, output: '{"status":"done"}', sessionId: 's1', authError: false },
      ]),
    });
    const { app } = makeApp({ runner });
    const srv = await startServer(app);
    try {
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      await flush();
      const ans = await httpPost(srv, `/api/obsidian-ingest/${startBody.jobId}/answers`, {
        answers: [{ id: 'q1', answer: 'Ziel X' }],
      });
      expect(ans.status).toBe(202);
      expect(ans.body.status).toBe('running');
      await flush();
      // AC5: after resume the status endpoint reports the next state.
      const { body } = await httpGet(srv, `/api/obsidian-ingest/${startBody.jobId}`);
      expect(body.status).toBe('done');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 when a required answer is missing', async () => {
    const runner = new ObsidianIngestRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: CATALOG_OUTPUT, sessionId: 's1', authError: false }]),
    });
    const { app } = makeApp({ runner });
    const srv = await startServer(app);
    try {
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      await flush();
      const ans = await httpPost(srv, `/api/obsidian-ingest/${startBody.jobId}/answers`, { answers: [] });
      expect(ans.status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 when answers is not an array', async () => {
    const runner = new ObsidianIngestRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: CATALOG_OUTPUT, authError: false }]),
    });
    const { app } = makeApp({ runner });
    const srv = await startServer(app);
    try {
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      await flush();
      const ans = await httpPost(srv, `/api/obsidian-ingest/${startBody.jobId}/answers`, { answers: 'nope' });
      expect(ans.status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 for answers on an unknown jobId', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const ans = await httpPost(srv, '/api/obsidian-ingest/ghost/answers', { answers: [] });
      expect(ans.status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('409 for answers when the job is not awaiting a catalog (AC7)', async () => {
    const runner = new ObsidianIngestRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: '{"status":"done"}', authError: false }]),
    });
    const { app } = makeApp({ runner });
    const srv = await startServer(app);
    try {
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      await flush(); // settles to done (terminal), no open catalog
      const ans = await httpPost(srv, `/api/obsidian-ingest/${startBody.jobId}/answers`, { answers: [] });
      expect(ans.status).toBe(409);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── Audit (AC6) ──────────────────────────────────────────────────────────────

describe('Audit-First at the HTTP layer — AC6', () => {
  it('records exactly one start audit with the AccessGuard identity', async () => {
    const record = jest.fn();
    const runner = new ObsidianIngestRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, output: CATALOG_OUTPUT, authError: false }]) });
    const { app } = makeApp({ runner, auditStore: { record }, identity: { email: 'alex@x' } });
    const srv = await startServer(app);
    try {
      await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ identity: 'alex@x', command: 'obsidian:ingest:start' }),
      );
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('audit-write failure on start → 500, runner NOT started (audit-first)', async () => {
    const record = jest.fn(() => { throw new Error('audit down'); });
    const start = jest.fn(() => ({ ok: true, jobId: 'x' }));
    const runner = { start, getJob: () => undefined, answers: () => ({ ok: true }) };
    const { app } = makeApp({ runner, auditStore: { record } });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      expect(status).toBe(500);
      expect(start).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('records an answers audit only for an accepted (waiting) job', async () => {
    const record = jest.fn();
    const runner = new ObsidianIngestRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: CATALOG_OUTPUT, authError: false }]),
    });
    const { app } = makeApp({ runner, auditStore: { record }, identity: { email: 'alex@x' } });
    const srv = await startServer(app);
    try {
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj' });
      await flush();
      record.mockClear();
      await httpPost(srv, `/api/obsidian-ingest/${startBody.jobId}/answers`, { answers: [{ id: 'q1', answer: 'a' }] });
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ identity: 'alex@x', command: expect.stringContaining('obsidian:ingest:answers') }),
      );
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
