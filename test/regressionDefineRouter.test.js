/**
 * @file regressionDefineRouter.test.js — HTTP-level tests for the headless
 * Regressionstest-Definier endpoints (docs/specs/regression-define-dialog.md).
 *
 * Covers (regression-define-dialog): AC1, AC2, AC3, AC4, AC5, AC9, AC12, AC14, AC15, AC16, AC17
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
 *   AC14/AC15/AC16/AC17 — the ergebnis_datei-Vertrag itself is exercised in
 *         depth in RegressionDefineRunner.test.js; this file only re-confirms,
 *         at the HTTP level, that a needs-review/done/failed(parse-error)
 *         outcome sourced from the ergebnis-datei (not stdout) still surfaces
 *         correctly through the router's pass-through view (no router-level
 *         behaviour change — the runner already returns a secret-free view).
 *
 * Error paths: review on a non-waiting job → 409; unknown job → 404; malformed
 * body → 400.
 *
 * Pattern: express + node:http on port 0 (Muster obsidianIngestRouter.test.js /
 * projectDrainRouter.test.js). The REAL RegressionDefineRunner is used with an
 * injected runClaude adapter — no real `claude` process, no PTY path. Slug→Pfad-
 * Auflösung ist über injizierte `slugResolver`/`pathValidator`-Stubs entkoppelt
 * (kein echtes Filesystem nötig — workspacePath.test.js deckt die echten
 * Resolver bereits ab). Since the runner now reads/writes a real ergebnis-datei
 * under `<projectPath>/board/runs/regression-define/` (AC14/AC15/AC17), the
 * slug resolves to a REAL tmp directory (`mkdtemp`) instead of the literal
 * `/workspace/dev-gui` — this test file must NOT write into the actual repo
 * checkout.
 */

import { describe, it, expect, jest, beforeEach, afterEach as afterEachHook } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Resolve pending microtasks/filesystem-awaits so a fire-and-forget round
 * settles — POLLS the job status via a GET (deterministic, no fixed tick
 * budget: AC14-AC17 added real filesystem `await`s — mkdir/readFile/unlink —
 * to the runner, which go through libuv's threadpool).
 *
 * @param {() => Promise<{status:string}>} getStatusView - e.g. `() => httpGet(server, path).then(r => r.body)`.
 * @param {(status: string) => boolean} [isSettled] - default: any status other than 'running'.
 */
async function flush(getStatusView, isSettled = (status) => status !== 'running') {
  if (typeof getStatusView !== 'function') {
    await new Promise((r) => setImmediate(r));
    return;
  }
  for (let i = 0; i < 500; i += 1) {
    const view = await getStatusView();
    if (view && isSettled(view.status)) return;
    await new Promise((r) => setImmediate(r));
  }
}

/** @type {string} real tmp dir standing in for the resolved project path (AC14/AC15/AC17 need a real fs). */
let tmpProjectDir;

beforeEach(async () => {
  tmpProjectDir = await mkdtemp(join(tmpdir(), 'regression-define-router-test-'));
});

afterEachHook(async () => {
  await rm(tmpProjectDir, { recursive: true, force: true });
});

/** Default slugResolver: 'dev-gui' → the real tmp project dir, alles andere → null. */
function makeSlugResolver(map) {
  const resolved = map ?? { 'dev-gui': () => tmpProjectDir };
  return (slug) => {
    if (!Object.prototype.hasOwnProperty.call(resolved, slug)) return null;
    const entry = resolved[slug];
    return typeof entry === 'function' ? entry() : entry;
  };
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

/**
 * A runClaude adapter returning queued round results. AC14/AC15: each queued
 * result may carry `fileContent` (written to `params.ergebnisDatei` before
 * resolving, simulating the agent-flow-skill's atomic write) — mirrors
 * `RegressionDefineRunner.test.js#makeSequencedRunClaude`.
 */
function sequencedRunClaude(results) {
  const queue = [...results];
  return jest.fn(async (params) => {
    const next = queue.shift() ?? { exitCode: 0, fileContent: '{"status":"done"}', output: '' };
    if (typeof next.fileContent === 'string' && params.ergebnisDatei) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(join(params.ergebnisDatei, '..'), { recursive: true });
      await writeFile(params.ergebnisDatei, next.fileContent, 'utf8');
    }
    const rest = { ...next };
    delete rest.fileContent;
    return { output: '', authError: false, ...rest };
  });
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
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false }]) });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const res = await httpPost(server, '/api/projects/dev-gui/regression-define', {
      ziel: { typ: 'bereich', id: 'fabrik-arbeiten' },
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('running');
    expect(typeof res.body.jobId).toBe('string');
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${res.body.jobId}`).then((r) => r.body));
  });

  it('202 for a valid verbund ziel with stichworte (A1)', async () => {
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, fileContent: '{"status":"done"}', authError: false }]) });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const res = await httpPost(server, '/api/projects/dev-gui/regression-define', {
      ziel: { typ: 'verbund', id: 'ephemeral-infra' },
      stichworte: ['login'],
    });
    expect(res.status).toBe(202);
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${res.body.jobId}`).then((r) => r.body));
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
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false }]) });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const first = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    expect(first.status).toBe(202);
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${first.body.jobId}`).then((r) => r.body), (status) => status === 'needs-review');

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
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false }]) });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));

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
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false }]) });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    const res = await httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(res.body)).not.toMatch(/\/workspace\//);
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));
  });

  it('AC12: failed (parse-error) carries error_class + secret-filtered raw_output', async () => {
    const runner = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([{
        exitCode: 0,
        fileContent: 'kaputte Ausgabe /workspace/dev-gui geheim',
        output: 'kaputte Ausgabe /workspace/dev-gui geheim',
        authError: false,
      }]),
    });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));

    const res = await httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error_class).toBe('parse-error');
    expect(res.body.raw_output).toContain('kaputte Ausgabe');
    expect(res.body.raw_output).not.toMatch(/\/workspace\//);
  });

  it('AC16: differentiates "Ergebnisdatei fehlt" (no file written) vs "Ergebnisdatei kein gültiges JSON" (broken file content)', async () => {
    const runnerMissing = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, output: 'stdout prosa, keine Datei geschrieben', authError: false }]),
    });
    const { app: appMissing } = makeApp({ runner: runnerMissing });
    const serverMissing = await startServer(appMissing);
    try {
      const started = await httpPost(serverMissing, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
      await flush(() => httpGet(serverMissing, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));
      const res = await httpGet(serverMissing, `/api/projects/dev-gui/regression-define/${started.body.jobId}`);
      expect(res.body.status).toBe('failed');
      expect(res.body.error_class).toBe('parse-error');
      expect(res.body.error).toBe('Ergebnisdatei fehlt');
    } finally {
      await closeServer(serverMissing);
    }

    const runnerBroken = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, fileContent: 'not valid json {{{', output: '', authError: false }]),
    });
    const { app: appBroken } = makeApp({ runner: runnerBroken });
    const serverBroken = await startServer(appBroken);
    try {
      const started = await httpPost(serverBroken, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
      await flush(() => httpGet(serverBroken, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));
      const res = await httpGet(serverBroken, `/api/projects/dev-gui/regression-define/${started.body.jobId}`);
      expect(res.body.status).toBe('failed');
      expect(res.body.error_class).toBe('parse-error');
      expect(res.body.error).toBe('Ergebnisdatei kein gültiges JSON');
    } finally {
      await closeServer(serverBroken);
    }
  });

  it('AC12: failed via a non-zero exit (agent-failed) carries NO raw_output', async () => {
    const runner = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([{ exitCode: 2, output: '', authError: false }]),
    });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));

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
        { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false },
        { exitCode: 0, fileContent: '{"status":"done"}', authError: false },
      ]),
    });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));

    const res = await httpPost(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}/review`, {
      reviewed: { vorschlag: [{ titel: 'redigiert', schritte: [], pruefpunkte: [], beispieldaten: [] }] },
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('running');
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));

    const status = await httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`);
    expect(status.body.status).toBe('done');
  });

  it('400 when reviewed is missing', async () => {
    const runner = new RegressionDefineRunner({
      runClaude: sequencedRunClaude([{ exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false }]),
    });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));

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
      runClaude: sequencedRunClaude([{ exitCode: 0, fileContent: '{"status":"done"}', authError: false }]),
    });
    const { app } = makeApp({ runner });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));

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
    const runner = new RegressionDefineRunner({ runClaude: sequencedRunClaude([{ exitCode: 0, fileContent: '{"status":"done"}', authError: false }]) });
    const { app } = makeApp({ runner, auditStore: { record }, identity: { email: 'alex@x' } });
    server = await startServer(app);

    const res = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    expect(res.status).toBe(202);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ identity: 'alex@x', command: 'regression-define:start' });
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${res.body.jobId}`).then((r) => r.body));
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
        { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 's1', authError: false },
        { exitCode: 0, fileContent: '{"status":"done"}', authError: false },
      ]),
    });
    const { app } = makeApp({ runner, auditStore: { record }, identity: { email: 'alex@x' } });
    server = await startServer(app);

    const started = await httpPost(server, '/api/projects/dev-gui/regression-define', { ziel: { typ: 'bereich', id: 'x' } });
    await flush(() => httpGet(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}`).then((r) => r.body));
    record.mockClear();

    const res = await httpPost(server, `/api/projects/dev-gui/regression-define/${started.body.jobId}/review`, {
      reviewed: { vorschlag: [] },
    });
    expect(res.status).toBe(202);
    expect(record).toHaveBeenCalledWith({ identity: 'alex@x', command: expect.stringContaining('regression-define:review') });
  });
});
