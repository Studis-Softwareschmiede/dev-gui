/**
 * @file regressionDefineRouter.test.js — HTTP-level tests for the headless
 * Regressionstest-Definier endpoints (docs/specs/regression-define-dialog.md).
 *
 * Covers (regression-define-dialog): AC1, AC2, AC3, AC4, AC5, AC9, AC12
 *
 *   AC1 — POST /api/projects/:slug/regression-define { ziel, stichworte? } →
 *         202 { jobId, status:"running" }; active project lock → 409;
 *         invalid/unresolvable slug → 400.
 *   AC2 — GET /api/projects/:slug/regression-define/:jobId → 200 { status,
 *         vorschlag?, result?, error? }; `vorschlag` only on needs-review;
 *         secret-free; unknown jobId → 404.
 *   AC3 — POST /api/projects/:slug/regression-define/:jobId/review → 202
 *         { status:"running" } on an accepted review; the reviewed payload is
 *         forwarded via STDIN inside the runner (covered in RegressionDefineRunner.test.js) —
 *         this file only asserts the HTTP contract (jobId addressing, no new run).
 *   AC4 — invalid/missing `ziel` (typ/id) → 400 (Eingabe-Vertrag Vorprüfung).
 *   AC5 — Security floor at the HTTP layer: start + review are audited exactly
 *         once with identity (audit-first: audit-write failure → 500, action not
 *         performed); error/vorschlag bodies are secret-free.
 *         AccessGuard-Verdrahtung: per server.js-Inspektion (`app.use('/api',
 *         accessGuard)`), kein separater Middleware-Test.
 *   AC9 — GET .../:jobId passes startedAt/lastActivityAt/phase through 1:1 from
 *         the runner's already secret-free job view (the runner itself is
 *         covered in RegressionDefineRunner.test.js — this file only asserts
 *         the HTTP body actually carries the fields).
 *   AC12 — GET .../:jobId passes error_class/raw_output through on a failed
 *         (parse-error) job; secret-free (asserted at the HTTP body level).
 *
 * Error paths: review on a non-waiting job → 409; unknown job → 404; malformed
 * body → 400.
 *
 * Pattern: express + node:http on port 0 (Muster obsidianIngestRouter.test.js /
 * projectDrainRouter.test.js). The REAL RegressionDefineRunner is used with an
 * injected runClaude adapter — no real `claude` process, no PTY path. Slug→Pfad-
 * Auflösung ist über injizierte `slugResolver`/`pathValidator`-Stubs entkoppelt
 * (kein echtes Filesystem nötig — workspacePath.test.js deckt die echten
 * Resolver bereits ab).
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { regressionDefineRouter } from '../src/regressionDefineRouter.js';
import { RegressionDefineRunner } from '../src/RegressionDefineRunner.js';

// ── HTTP helpers (Muster projectDrainRouter.test.js/obsidianIngestRouter.test.js) ──

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

function closeServer(srv) {
  return new Promise((resolvePromise) => srv.close(() => resolvePromise()));
}

function flush() {
  return new Promise((r) => setImmediate(r));
}

/** Default slugResolver: 'dev-gui' → '/workspace/dev-gui', alles andere → null. */
function makeSlugResolver(map = { 'dev-gui': '/workspace/dev-gui' }) {
  return (slug) => (Object.prototype.hasOwnProperty.call(map, slug) ? map[slug] : null);
}

/** Default pathValidator: identity — resolviert den übergebenen Pfad unverändert. */
function identityPathValidator() {
  return async (p) => ({ resolvedPath: p });
}

const VORSCHLAG_OUTPUT = JSON.stringify({
  status: 'needs-review',
  projekt: 'dev-gui',
  ziel: { typ: 'bereich', id: 'fabrik-arbeiten' },
  quell_specs: ['docs/specs/regression-define-dialog.md'],
  vorschlag: [{ titel: 'Test-Vorschlag', schritte: ['a'], pruefpunkte: ['b'], beispieldaten: [] }],
  target_vorschlag: null,
});

/** A runClaude adapter returning queued round results. */
function sequencedRunClaude(results) {
  const queue = [...results];
  return jest.fn(async () => queue.shift() ?? { exitCode: 0, output: '{"status":"done"}', authError: false });
}

function makeApp({
  runner,
  slugResolver = makeSlugResolver(),
  pathValidator = identityPathValidator(),
  auditStore,
  identity = { email: 'test@example.com' },
} = {}) {
  const app = express();
  app.use(express.json());
  if (identity !== undefined) {
    app.use((req, _res, next) => { req.identity = identity; next(); });
  }
  const _runner = runner ?? new RegressionDefineRunner({ runClaude: sequencedRunClaude([]) });
  app.use(regressionDefineRouter(_runner, { slugResolver, pathValidator, auditStore }));
  return { app, runner: _runner };
}

// ── POST /api/projects/:slug/regression-define (AC1/AC4) ────────────────────

describe('POST /api/projects/:slug/regression-define — AC1/AC4', () => {
  let server;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
  });

  it('202 { jobId, status:"running" } for a valid bereich ziel', async () => {
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false }]) });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const res = await httpPost(server, '/api/projects/dev-gui/regression-define', {
      ziel: { typ: 'bereich', id: 'fabrik-arbeiten' },
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('running');
    expect(typeof res.body.jobId).toBe('string');
    await flush();
  });

  it('202 for a valid verbund ziel with stichworte (A1)', async () => {
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, output: '{"status":"done"}', authError: false }]) });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const res = await httpPost(server, '/api/projects/dev-gui/regression-define', {
      ziel: { typ: 'verbund', id: 'ephemeral-infra' },
      stichworte: ['login'],
    });
    expect(res.status).toBe(202);
    await flush();
  });

  it('400 when ziel is missing/malformed', async () => {
    const { app } = makeApp();
    server = await startServer(app);
    const res1 = await httpPost(server, '/api/projects/dev-gui/regression-define', {});
    expect(res1.status).toBe(400);
    const res2 = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'nope', id: 'x' } });
    expect(res2.status).toBe(400);
    const res3 = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich' } });
    expect(res3.status).toBe(400);
  });

  it('400 when stichworte is not an array of strings', async () => {
    const { app } = makeApp();
    server = await startServer(app);
    const res = await httpPost(server, '/api/projects/dev-gui/regression-define', {
      ziel: { typ: 'bereich', id: 'x' },
      stichworte: 'not-an-array',
    });
    expect(res.status).toBe(400);
  });

  it('400 for an invalid/unresolvable slug', async () => {
    const { app } = makeApp();
    server = await startServer(app);
    const res = await httpPost(server, '/api/projects/unknown-repo/regression-define', {
      ziel: { typ: 'bereich', id: 'x' },
    });
    expect(res.status).toBe(400);
  });

  it('409 when a definition run is already active for the SAME project (lock held during needs-review)', async () => {
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false }]) });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const first = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    expect(first.status).toBe(202);
    await flush();

    const second = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'y' } });
    expect(second.status).toBe(409);
  });
});

// ── GET /api/projects/:slug/regression-define/:jobId (AC2) ───────────────────

describe('GET /api/projects/:slug/regression-define/:jobId — AC2', () => {
  let server;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
  });

  it('200 with the vorschlag on needs-review, secret-free', async () => {
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false }]) });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush();

    const res = await httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('needs-review');
    expect(res.body.vorschlag.vorschlag).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/\/workspace\//);
  });

  it('404 for an unknown jobId', async () => {
    const { app } = makeApp();
    server = await startServer(app);
    const res = await httpGet(server, '/api/projects/dev-gui/regression-define/nope');
    expect(res.status).toBe(404);
  });

  it('400 for an invalid slug', async () => {
    const { app } = makeApp();
    server = await startServer(app);
    const res = await httpGet(server, '/api/projects/unknown-repo/regression-define/nope');
    expect(res.status).toBe(400);
  });

  it('AC9: carries startedAt/lastActivityAt (and phase, best-effort) while running', async () => {
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false }]) });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    const res = await httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(res.body)).not.toMatch(/\/workspace\//);
    await flush();
  });

  it('AC12: failed (parse-error) carries error_class + secret-filtered raw_output', async () => {
    const runner = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: 'kaputte Ausgabe /workspace/dev-gui geheim', authError: false }]),
    });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush();

    const res = await httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error_class).toBe('parse-error');
    expect(res.body.raw_output).toContain('kaputte Ausgabe');
    expect(res.body.raw_output).not.toMatch(/\/workspace\//);
  });

  it('AC12: failed via a non-zero exit (agent-failed) carries NO raw_output', async () => {
    const runner = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([{ exitCode: 2, output: '', authError: false }]),
    });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush();

    const res = await httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`);
    expect(res.body.error_class).toBe('agent-failed');
    expect(res.body.raw_output).toBeUndefined();
  });
});

// ── POST /api/projects/:slug/regression-define/:jobId/review (AC3) ───────────

describe('POST /api/projects/:slug/regression-define/:jobId/review — AC3', () => {
  let server;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
  });

  it('202 { status:"running" } and reaches done after a valid review', async () => {
    const runner = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([
        { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false },
        { exitCode: 0, output: '{"status":"done"}', authError: false },
      ]),
    });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush();

    const res = await httpPost(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}/review`, {
      reviewed: { vorschlag: [{ titel: 'redigiert', schritte: [], pruefpunkte: [], beispieldaten: [] }] },
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('running');
    await flush();

    const status = await httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`);
    expect(status.body.status).toBe('done');
  });

  it('400 when reviewed is missing', async () => {
    const runner = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false }]),
    });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush();

    const res = await httpPost(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}/review`, {});
    expect(res.status).toBe(400);
  });

  it('404 for review on an unknown jobId', async () => {
    const { app } = makeApp();
    server = await startServer(app);
    const res = await httpPost(server, '/api/projects/dev-gui/regression-define/nope/review', { reviewed: { vorschlag: [] } });
    expect(res.status).toBe(404);
  });

  it('409 for review when the job is not awaiting a vorschlag', async () => {
    const runner = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: '{"status":"done"}', authError: false }]),
    });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush();

    const res = await httpPost(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}/review`, { reviewed: { vorschlag: [] } });
    expect(res.status).toBe(409);
  });

  it('400 for an invalid slug', async () => {
    const { app } = makeApp();
    server = await startServer(app);
    const res = await httpPost(server, '/api/projects/unknown-repo/regression-define/nope/review', { reviewed: {} });
    expect(res.status).toBe(400);
  });
});

// ── Audit-First at the HTTP layer — AC5 ──────────────────────────────────────

describe('Audit-First at the HTTP layer — AC5', () => {
  let server;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
  });

  it('records exactly one start audit with the AccessGuard identity', async () => {
    const record = jest.fn();
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, output: '{"status":"done"}', authError: false }]) });
    const { app } = makeApp({ runner, auditStore: { record }, identity: { email: 'alex@x' } });
    server = await startServer(app);

    const res = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    expect(res.status).toBe(202);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ identity: 'alex@x', command: 'regression-define:start' });
    await flush();
  });

  it('audit-write failure on start → 500, runner NOT started (audit-first)', async () => {
    const record = jest.fn(() => { throw new Error('audit down'); });
    const start = jest.fn();
    const runner = { start, getJob: jest.fn(), review: jest.fn() };
    const { app } = makeApp({ runner, auditStore: { record } });
    server = await startServer(app);

    const res = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    expect(res.status).toBe(500);
    expect(start).not.toHaveBeenCalled();
  });

  it('records a review audit only for an accepted (waiting) job', async () => {
    const record = jest.fn();
    const runner = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([
        { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false },
        { exitCode: 0, output: '{"status":"done"}', authError: false },
      ]),
    });
    const { app } = makeApp({ runner, auditStore: { record }, identity: { email: 'alex@x' } });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush();
    record.mockClear();

    const res = await httpPost(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}/review`, {
      reviewed: { vorschlag: [] },
    });
    expect(res.status).toBe(202);
    expect(record).toHaveBeenCalledWith({ identity: 'alex@x', command: expect.stringContaining('regression-define:review') });
  });
});
