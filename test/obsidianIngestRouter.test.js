/**
 * @file obsidianIngestRouter.test.js — HTTP-level tests for the headless
 * Obsidian-Ingest endpoints (docs/specs/obsidian-question-catalog.md).
 *
 * Covers (obsidian-question-catalog): AC1, AC2, AC4, AC5, AC6, AC7, AC8, AC9
 *
 *   AC1 — POST /api/obsidian-ingest/start { projectFolderPath, targetProjectSlug } →
 *         202 { jobId, status:"running" }; active project lock → 409; missing/
 *         not-listed note path → 400; vault not configured / "Projekte" unreachable
 *         → 404 (vault-confined resolution via listObsidianVaultProjects,
 *         security/R02/R03 — reuse, no new confinement mechanism,
 *         obsidian-vault-config AC5).
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
 *   AC8 — the runner receives cwd = the resolved target repo path and the note
 *         folder path ONLY as the from-notes argv argument — verified via a spy
 *         runner (no real claude process, no need to exercise ObsidianIngestRunner
 *         internals here — those are covered in ObsidianIngestRunner.test.js).
 *   AC9 — POST /start additionally resolves `targetProjectSlug` via the injected
 *         `slugResolver`/`pathValidator` (same confinement pattern as
 *         `POST /api/projects/:slug/drain`): missing/empty/malformed slug → 400;
 *         resolver reports the checkout doesn't exist / workspace unreachable →
 *         404; in both cases the runner is NEVER started (no lock/audit side
 *         effect) — no silent cwd-fallback to the note folder.
 *
 * Pattern: express + node:http on port 0 (matches reconcileRouter.test.js). The
 * REAL ObsidianIngestRunner is used with an injected runClaude adapter — no real
 * `claude` process, no PTY path. Path confinement is exercised via injected
 * `credentialStore`/`listProjects`/`realpath` stubs (no real fs/vault needed —
 * `obsidianVaultPath.test.js` already covers `listObsidianVaultProjects()` itself)
 * plus injected `slugResolver`/`pathValidator` stubs for the target-repo
 * confinement (AC9; no real WORKSPACE_DIR/fs access needed here either —
 * `workspacePath.test.js` already covers `resolveProjectSlug`/`validateProjectPath`
 * themselves).
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { obsidianIngestRouter } from '../src/obsidianIngestRouter.js';
import { ObsidianIngestRunner } from '../src/ObsidianIngestRunner.js';
import { ObsidianVaultPathError } from '../src/obsidianVaultPath.js';
import { ProjectPathError } from '../src/workspacePath.js';

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

// AC9 fixtures: a simple pass-through slug→path resolver + validator so the
// pre-existing (AC1-AC7) tests below don't need real WORKSPACE_DIR/fs access —
// any non-empty slug resolves to a workspace path. Tests exercising the AC9
// confinement itself inject their own stubs.
const defaultSlugResolver = (slug) =>
  typeof slug === 'string' && slug.trim() !== '' ? `/workspace/${slug.trim()}` : null;
const defaultPathValidator = async (p) => ({ resolvedPath: p });

const CATALOG_OUTPUT = JSON.stringify({
  status: 'needs-answers',
  catalog: [{ stage: 'Notiz→Konzept', id: 'q1', frage: 'Ziel?', quelle: 'n.md' }],
});

/** A runClaude adapter returning queued round results. */
function sequencedRunClaude(results) {
  const queue = [...results];
  return jest.fn(async () => queue.shift() ?? { exitCode: 0, output: '{"status":"done"}', authError: false });
}

function makeApp({ runner, credentialStore, listProjects, realpath, auditStore, identity, slugResolver, pathValidator } = {}) {
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
      slugResolver: slugResolver ?? defaultSlugResolver,
      pathValidator: pathValidator ?? defaultPathValidator,
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
      const { status, body } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const { status, body } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
        await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const first = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
      expect(first.status).toBe(202);
      await flush(); // settle into needs-answers (lock still held)
      const second = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
      expect(second.status).toBe(409);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC8/AC9 — target-repo cwd + confinement at the start endpoint ───────────

describe('POST /api/obsidian-ingest/start — AC8 (cwd = target repo, argv = note folder)', () => {
  it('passes the resolved target repo path as start()s first arg and the note folder as noteFolderPath (never swapped)', async () => {
    const startSpy = jest.fn(() => ({ ok: true, jobId: 'job-1' }));
    const spyRunner = { start: startSpy, getJob: () => undefined, answers: () => ({ ok: true }) };
    const { app } = makeApp({ runner: spyRunner });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', {
        projectFolderPath: '/workspace/proj',
        targetProjectSlug: 'target-repo',
      });
      expect(status).toBe(202);
      expect(startSpy).toHaveBeenCalledTimes(1);
      const [targetRepoArg, opts] = startSpy.mock.calls[0];
      // AC8: cwd = the resolved TARGET REPO path (from targetProjectSlug),
      // noteFolderPath = the resolved vault-confined NOTE folder — distinct,
      // never swapped.
      expect(targetRepoArg).toBe('/workspace/target-repo');
      expect(opts.noteFolderPath).toBe('/workspace/proj');
      expect(targetRepoArg).not.toBe(opts.noteFolderPath);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/obsidian-ingest/start — AC9 (targetProjectSlug confinement)', () => {
  it('400 when targetProjectSlug is missing — no runner start (no lock/audit side effect)', async () => {
    const record = jest.fn();
    const start = jest.fn(() => ({ ok: true, jobId: 'x' }));
    const runner = { start, getJob: () => undefined, answers: () => ({ ok: true }) };
    const { app } = makeApp({ runner, auditStore: { record } });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/obsidian-ingest/start', {
        projectFolderPath: '/workspace/proj',
      });
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
      expect(start).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 when targetProjectSlug is empty/whitespace — no runner start', async () => {
    const start = jest.fn(() => ({ ok: true, jobId: 'x' }));
    const runner = { start, getJob: () => undefined, answers: () => ({ ok: true }) };
    const { app } = makeApp({ runner });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', {
        projectFolderPath: '/workspace/proj',
        targetProjectSlug: '   ',
      });
      expect(status).toBe(400);
      expect(start).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 when the slug resolver rejects a malformed slug (e.g. traversal) — no runner start', async () => {
    const start = jest.fn(() => ({ ok: true, jobId: 'x' }));
    const runner = { start, getJob: () => undefined, answers: () => ({ ok: true }) };
    const rejectingSlugResolver = () => {
      throw new ProjectPathError("Project slug must not contain '/'", 'outside-boundary');
    };
    const { app } = makeApp({ runner, slugResolver: rejectingSlugResolver });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', {
        projectFolderPath: '/workspace/proj',
        targetProjectSlug: '../etc',
      });
      expect(status).toBe(400);
      expect(start).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 when the resolved target repo checkout does not exist — no runner start, no cwd-fallback to the note folder', async () => {
    const start = jest.fn(() => ({ ok: true, jobId: 'x' }));
    const runner = { start, getJob: () => undefined, answers: () => ({ ok: true }) };
    const notFoundPathValidator = async () => {
      throw new ProjectPathError('Project path does not exist', 'not-exists');
    };
    const { app } = makeApp({ runner, pathValidator: notFoundPathValidator });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/obsidian-ingest/start', {
        projectFolderPath: '/workspace/proj',
        targetProjectSlug: 'unknown-repo',
      });
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
      expect(start).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 when the workspace boundary itself is not configured/reachable', async () => {
    const start = jest.fn(() => ({ ok: true, jobId: 'x' }));
    const runner = { start, getJob: () => undefined, answers: () => ({ ok: true }) };
    const boundaryPathValidator = async () => {
      throw new ProjectPathError('WORKSPACE_DIR is not configured', 'outside-boundary');
    };
    const { app } = makeApp({ runner, pathValidator: boundaryPathValidator });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', {
        projectFolderPath: '/workspace/proj',
        targetProjectSlug: 'target-repo',
      });
      expect(status).toBe(404);
      expect(start).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('no audit entry is written when targetProjectSlug resolution fails (audit-first — action never accepted)', async () => {
    const record = jest.fn();
    const { app } = makeApp({ auditStore: { record } });
    const srv = await startServer(app);
    try {
      await httpPost(srv, '/api/obsidian-ingest/start', {
        projectFolderPath: '/workspace/proj',
        // targetProjectSlug missing
      });
      expect(record).not.toHaveBeenCalled();
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
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const { status } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
      const { body: startBody } = await httpPost(srv, '/api/obsidian-ingest/start', { projectFolderPath: '/workspace/proj', targetProjectSlug: 'target-repo' });
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
