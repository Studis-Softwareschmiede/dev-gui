/**
 * @file vpsContainerScanRouter.test.js — HTTP-level tests für den Pro-Container
 * Red-Team-Scan-Endpunkt (docs/specs/red-team-scan-per-container.md).
 *
 * Covers (red-team-scan-per-container):
 *   AC1 — Runner andocken: `runner.start(cwd, {ziel, modus:'beide', url, urlEdge})` wird mit
 *         server-seitig abgeleiteten Argumenten aufgerufen (kein Client-Override).
 *   AC2 — POST .../containers/:containerId/scan → 202 { jobId, status:'running' }; nur
 *         managed+laufende Container (sonst 422 not-scannable); bereits laufender Scan für
 *         denselben Container → 409 scan-in-progress; ungültige Route → 400. Der 409-Guard
 *         leitet "läuft noch" aus derselben mapStatus()-Quelle wie der GET-Statuspoll ab —
 *         Regressionstest belegt, dass ein mit `budget-limited` beendeter Scan (Core-
 *         Terminalstatus, s. HeadlessRunnerCore) NICHT dauerhaft blockiert (vormals Important-
 *         Review-Befund: eine separate Terminal-Status-Menge kannte `budget-limited` nicht).
 *   AC3 — GET .../containers/:containerId/scan/:jobId → 200 { status, phase, ampel?,
 *         findings?, reportRef? }; status∈{running,done,failed,auth-expired} (budget-limited
 *         wird defensiv auf failed gemappt); unbekannte/fremde jobId → 404 (kein
 *         Cross-Container-Leak).
 *   AC4 — Ziel-Confinement: direkt/öffentlich werden ausschließlich server-seitig aus
 *         VPS-Target + ContainerEntry gebaut; ein mitgesendeter Body-/Query-URL-Wert wird
 *         ignoriert (Default-deny durch Konstruktion, kein Filter-Code).
 *   AC5 — Zwei Testorte in einem Job (modus:'beide'); unterschiedliche Container/Repos
 *         blockieren einander nicht (eigenes cwd/Lock je Repo); ein bereits abgeschlossener
 *         Scan lässt einen neuen Lauf für denselben Container zu.
 *   AC6 — Wiring: Router akzeptiert Runner + Boundaries via Factory-Parameter (analog
 *         server.js-Dependency-Injection); scanResultStore ist optional/best-effort
 *         verdrahtet (S-402 hängt den echten Store nur noch ein).
 *   AC7/AC8 (S-402) — GET .../containers/:containerId/scans → 200 { scans:[...] } (kompakt,
 *         neueste zuerst, ohne findings/reportRef); ohne Store/nicht auflösbaren Container/
 *         Store-Fehler → 200 { scans:[] } (best-effort, kein Crash). GET .../scans/:scanId →
 *         200 { scan:{...} } (voller Datensatz inkl. findings+reportRef) | 404 bei
 *         unbekannter scanId/fehlendem Store; ungültige Route (provider/serverId/
 *         containerId) → 400.
 *   AC22 — Security-Floor: jobId ist reine Korrelations-ID; keine Host-Pfade in der
 *         Response; Confinement bleibt bei einem Store-Fehler robust (kein Crash).
 *
 * Muster: express + node:http createServer auf Port 0 (127.0.0.1), kein supertest
 * (wie redTeamRouter.test.js / reconcileRouter.test.js). Injizierte Stubs für runner +
 * vpsDockerControl/vpsRegistry/vpsTargets/workspaceScanner + pathValidator/slugResolver.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { vpsContainerScanRouter } from '../src/vpsContainerScanRouter.js';

// ── HTTP-Hilfsfunktionen (Muster redTeamRouter.test.js) ───────────────────────

function httpPost(server, path, body) {
  return new Promise((resolvePromise, reject) => {
    const port = server.address().port;
    const bodyStr = JSON.stringify(body ?? {});
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

// ── Stubs ──────────────────────────────────────────────────────────────────────

const defaultSlugResolver = (slug) => (slug ? `/workspace/${slug}` : null);
const defaultPathValidator = async (p) => ({ resolvedPath: p });

/**
 * Runner-Stub, der die reale HeadlessRunnerCore-Lock-Semantik nachbildet: `start()` sperrt
 * pro cwd/projectPath, bis der Job terminal wird (`finishJob()` simuliert das reale
 * `lock.release()` im `close`-Handler). Zeichnet alle start()-Aufrufe für Assertions auf.
 */
function makeRunner() {
  const jobs = new Map();
  const locked = new Set();
  let seq = 0;
  return {
    startCalls: [],
    start(projectPath, opts) {
      this.startCalls.push({ projectPath, opts });
      if (locked.has(projectPath)) return { ok: false, reason: 'locked' };
      locked.add(projectPath);
      const jobId = `job-${++seq}`;
      jobs.set(jobId, { status: 'running', _path: projectPath });
      return { ok: true, jobId };
    },
    getJob(id) {
      return jobs.get(id);
    },
    /** Testhilfe: simuliert den `close`-Handler-Abschluss (Terminalstatus + Lock-Freigabe). */
    finishJob(jobId, patch) {
      const job = jobs.get(jobId);
      if (!job) return;
      locked.delete(job._path);
      jobs.set(jobId, { ...job, ...patch });
    },
  };
}

const runningContainer = (over = {}) => ({
  containerId: 'c1',
  image: 'ghcr.io/org/dev-gui:sha',
  hostname: 'dev-gui.example.com',
  state: 'running',
  status: 'Up 3 minutes',
  hostPort: 8080,
  ...over,
});

/** Deps, deren Container `containerId` auf ein reales Workspace-Repo matcht (Happy-Path). */
function makeDeps({ containers, listClones } = {}) {
  return {
    vpsTargets: new Map([['a', { host: '1.1.1.1', targetUser: 'root' }]]),
    vpsDockerControl: { psAll: async () => ({ result: 'ok', containers: containers ?? [runningContainer()] }) },
    workspaceScanner: { listClones: async () => listClones ?? [{ name: 'dev-gui' }] },
  };
}

function makeApp({ runner, deps, pathValidator, slugResolver, scanResultStore } = {}) {
  const app = express();
  app.use(express.json());
  const _runner = runner ?? makeRunner();
  app.use(
    vpsContainerScanRouter(
      _runner,
      { ...(deps ?? makeDeps()), scanResultStore },
      {
        pathValidator: pathValidator ?? defaultPathValidator,
        slugResolver: slugResolver ?? defaultSlugResolver,
      },
    ),
  );
  return { app, runner: _runner };
}

const SCAN_PATH = '/api/vps/machines/hetzner/srv1/containers/c1/scan';

// ── AC2 — POST .../containers/:containerId/scan ───────────────────────────────

describe('POST .../containers/:containerId/scan — AC2', () => {
  it('managed+laufender Container → 202 { jobId, status: "running" }', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, SCAN_PATH, {});
      expect(status).toBe(202);
      expect(body.status).toBe('running');
      expect(typeof body.jobId).toBe('string');
      expect(body.jobId.length).toBeGreaterThan(0);
      expect(runner.startCalls).toHaveLength(1);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('unmanaged Container (hostname: null) → 422 not-scannable', async () => {
    const deps = makeDeps({ containers: [runningContainer({ hostname: null })] });
    const { app } = makeApp({ deps });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, SCAN_PATH, {});
      expect(status).toBe(422);
      expect(body.errorClass).toBe('not-scannable');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('nicht laufender Container (state: "exited") → 422 not-scannable', async () => {
    const deps = makeDeps({ containers: [runningContainer({ state: 'exited' })] });
    const { app } = makeApp({ deps });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, SCAN_PATH, {});
      expect(status).toBe(422);
      expect(body.errorClass).toBe('not-scannable');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('Container nicht (mehr) vorhanden (psAll ohne Treffer) → 422 not-scannable', async () => {
    const deps = makeDeps({ containers: [runningContainer({ containerId: 'other' })] });
    const { app } = makeApp({ deps });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, SCAN_PATH, {});
      expect(status).toBe(422);
      expect(body.errorClass).toBe('not-scannable');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('kein Workspace-Repo-Match (workspaceScanner.listClones leer) → 422 not-scannable', async () => {
    const deps = makeDeps({ listClones: [] });
    const { app } = makeApp({ deps });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, SCAN_PATH, {});
      expect(status).toBe(422);
      expect(body.errorClass).toBe('not-scannable');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('kein VPS-Ziel auflösbar (leere vpsTargets) → 422 not-scannable', async () => {
    const deps = { ...makeDeps(), vpsTargets: new Map() };
    const { app } = makeApp({ deps });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, SCAN_PATH, {});
      expect(status).toBe(422);
      expect(body.errorClass).toBe('not-scannable');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ungültiger Provider → 400', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/vps/machines/evil-provider/srv1/containers/c1/scan', {});
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ungültige containerId (Sonderzeichen) → 400', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/vps/machines/hetzner/srv1/containers/c!1/scan', {});
      expect(status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('bereits laufender Scan für denselben Container → 409 scan-in-progress', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const first = await httpPost(srv, SCAN_PATH, {});
      expect(first.status).toBe(202);
      const second = await httpPost(srv, SCAN_PATH, {});
      expect(second.status).toBe(409);
      expect(second.body.errorClass).toBe('scan-in-progress');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('abgeschlossener Scan (done) lässt einen neuen Lauf für denselben Container zu (AC5)', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      const first = await httpPost(srv, SCAN_PATH, {});
      expect(first.status).toBe(202);
      runner.finishJob(first.body.jobId, { status: 'done' });
      const second = await httpPost(srv, SCAN_PATH, {});
      expect(second.status).toBe(202);
      expect(second.body.jobId).not.toBe(first.body.jobId);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ein mit "budget-limited" beendeter Scan lässt einen neuen Lauf für denselben Container zu (Regression: budget-limited ist terminal, kein Dauer-409)', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      const first = await httpPost(srv, SCAN_PATH, {});
      expect(first.status).toBe(202);
      runner.finishJob(first.body.jobId, { status: 'budget-limited', resetAt: 12345 });
      const second = await httpPost(srv, SCAN_PATH, {});
      expect(second.status).toBe(202);
      expect(second.body.jobId).not.toBe(first.body.jobId);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('unterschiedliche Container (verschiedene Repos) blockieren einander nicht (AC5)', async () => {
    const runner = makeRunner();
    const deps = {
      vpsTargets: new Map([['a', { host: '1.1.1.1', targetUser: 'root' }]]),
      vpsDockerControl: {
        psAll: async () => ({
          result: 'ok',
          containers: [
            runningContainer({ containerId: 'c1', image: 'ghcr.io/org/dev-gui:sha', hostname: 'dev-gui.example.com' }),
            runningContainer({ containerId: 'c2', image: 'ghcr.io/org/other-app:sha', hostname: 'other-app.example.com' }),
          ],
        }),
      },
      workspaceScanner: { listClones: async () => [{ name: 'dev-gui' }, { name: 'other-app' }] },
    };
    const { app } = makeApp({ runner, deps });
    const srv = await startServer(app);
    try {
      const first = await httpPost(srv, SCAN_PATH, {});
      expect(first.status).toBe(202);
      const second = await httpPost(srv, '/api/vps/machines/hetzner/srv1/containers/c2/scan', {});
      expect(second.status).toBe(202);
      expect(second.body.jobId).not.toBe(first.body.jobId);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC1/AC4 — Runner-Args + Ziel-Confinement ──────────────────────────────────

describe('Runner-Args + Ziel-Confinement — AC1/AC4', () => {
  it('startet den Runner mit server-seitig abgeleiteten Args (ziel, modus:"beide", url, urlEdge)', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      await httpPost(srv, SCAN_PATH, {});
      expect(runner.startCalls).toHaveLength(1);
      const { projectPath, opts } = runner.startCalls[0];
      expect(projectPath).toBe('/workspace/dev-gui');
      expect(opts).toEqual({
        ziel: 'dev-gui',
        modus: 'beide',
        url: 'http://1.1.1.1:8080',
        urlEdge: 'https://dev-gui.example.com',
      });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ein mitgesendeter URL-Wert (Body) wird ignoriert — Ziel bleibt server-seitig abgeleitet', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      await httpPost(srv, SCAN_PATH, { url: 'http://evil.example.com', urlEdge: 'http://evil2.example.com', ziel: 'not-mine' });
      const { opts } = runner.startCalls[0];
      expect(opts.url).toBe('http://1.1.1.1:8080');
      expect(opts.urlEdge).toBe('https://dev-gui.example.com');
      expect(opts.ziel).toBe('dev-gui');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ein mitgesendeter URL-Query-Parameter wird ignoriert', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      await httpPost(srv, `${SCAN_PATH}?url=http://evil.example.com`, {});
      const { opts } = runner.startCalls[0];
      expect(opts.url).toBe('http://1.1.1.1:8080');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC3 — GET .../containers/:containerId/scan/:jobId ─────────────────────────

describe('GET .../containers/:containerId/scan/:jobId — AC3', () => {
  it('running → { status: "running", phase: "direkt" }', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const start = await httpPost(srv, SCAN_PATH, {});
      const { status, body } = await httpGet(srv, `${SCAN_PATH}/${start.body.jobId}`);
      expect(status).toBe(200);
      expect(body).toEqual({ status: 'running', phase: 'direkt' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('done → { status: "done", phase: "fertig" }', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      const start = await httpPost(srv, SCAN_PATH, {});
      runner.finishJob(start.body.jobId, { status: 'done' });
      const { status, body } = await httpGet(srv, `${SCAN_PATH}/${start.body.jobId}`);
      expect(status).toBe(200);
      expect(body).toEqual({ status: 'done', phase: 'fertig' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('failed → { status: "failed", phase: "fertig" }', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      const start = await httpPost(srv, SCAN_PATH, {});
      runner.finishJob(start.body.jobId, { status: 'failed', error: 'Red-Team-Lauf fehlgeschlagen' });
      const { body } = await httpGet(srv, `${SCAN_PATH}/${start.body.jobId}`);
      expect(body).toEqual({ status: 'failed', phase: 'fertig' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('auth-expired → { status: "auth-expired", phase: "fertig" }', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      const start = await httpPost(srv, SCAN_PATH, {});
      runner.finishJob(start.body.jobId, { status: 'auth-expired' });
      const { body } = await httpGet(srv, `${SCAN_PATH}/${start.body.jobId}`);
      expect(body).toEqual({ status: 'auth-expired', phase: 'fertig' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('budget-limited (interner Core-Status) wird defensiv auf "failed" gemappt', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      const start = await httpPost(srv, SCAN_PATH, {});
      runner.finishJob(start.body.jobId, { status: 'budget-limited', resetAt: 12345 });
      const { body } = await httpGet(srv, `${SCAN_PATH}/${start.body.jobId}`);
      expect(body.status).toBe('failed');
      expect(body.phase).toBe('fertig');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('unbekannte jobId → 404', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, `${SCAN_PATH}/does-not-exist`);
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('jobId gehört zu einem ANDEREN Container → 404 (kein Cross-Container-Leak)', async () => {
    const runner = makeRunner();
    const deps = {
      vpsTargets: new Map([['a', { host: '1.1.1.1', targetUser: 'root' }]]),
      vpsDockerControl: {
        psAll: async () => ({
          result: 'ok',
          containers: [
            runningContainer({ containerId: 'c1', image: 'ghcr.io/org/dev-gui:sha', hostname: 'dev-gui.example.com' }),
            runningContainer({ containerId: 'c2', image: 'ghcr.io/org/other-app:sha', hostname: 'other-app.example.com' }),
          ],
        }),
      },
      workspaceScanner: { listClones: async () => [{ name: 'dev-gui' }, { name: 'other-app' }] },
    };
    const { app } = makeApp({ runner, deps });
    const srv = await startServer(app);
    try {
      const start = await httpPost(srv, SCAN_PATH, {}); // Container c1
      // Status-Abfrage über den ANDEREN Container c2, mit der jobId von c1.
      const { status } = await httpGet(srv, `/api/vps/machines/hetzner/srv1/containers/c2/scan/${start.body.jobId}`);
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('scanResultStore (best-effort, AC6): liefert ampel/findings/reportRef zusätzlich zu status/phase', async () => {
    const scanResultStore = {
      getByJobId: async () => ({ ampel: 'rot', findings: [{ id: 'f1', severity: 'high', testort: 'direkt' }], reportRef: 'scan-1' }),
    };
    const { app, runner } = makeApp({ scanResultStore });
    const srv = await startServer(app);
    try {
      const start = await httpPost(srv, SCAN_PATH, {});
      runner.finishJob(start.body.jobId, { status: 'done' });
      const { status, body } = await httpGet(srv, `${SCAN_PATH}/${start.body.jobId}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        status: 'done',
        phase: 'fertig',
        ampel: 'rot',
        findings: [{ id: 'f1', severity: 'high', testort: 'direkt' }],
        reportRef: 'scan-1',
      });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ein scanResultStore-Fehler crasht den Status-Poll nicht (best-effort, Robustheit)', async () => {
    const scanResultStore = { getByJobId: async () => { throw new Error('store down'); } };
    const { app, runner } = makeApp({ scanResultStore });
    const srv = await startServer(app);
    try {
      const start = await httpPost(srv, SCAN_PATH, {});
      runner.finishJob(start.body.jobId, { status: 'done' });
      const { status, body } = await httpGet(srv, `${SCAN_PATH}/${start.body.jobId}`);
      expect(status).toBe(200);
      expect(body).toEqual({ status: 'done', phase: 'fertig' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ohne scanResultStore bleiben ampel/findings/reportRef abwesend (optional laut Contract)', async () => {
    const { app, runner } = makeApp();
    const srv = await startServer(app);
    try {
      const start = await httpPost(srv, SCAN_PATH, {});
      runner.finishJob(start.body.jobId, { status: 'done' });
      const { body } = await httpGet(srv, `${SCAN_PATH}/${start.body.jobId}`);
      expect(body.ampel).toBeUndefined();
      expect(body.findings).toBeUndefined();
      expect(body.reportRef).toBeUndefined();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC22 — Security-Floor ──────────────────────────────────────────────────────

describe('Security-Floor — AC22', () => {
  it('jobId ist eine reine Korrelations-ID — keine Host-Pfade in der Response', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const { body } = await httpPost(srv, SCAN_PATH, {});
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/\/workspace\//);
      expect(serialized).not.toMatch(/\/home\//);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC7/AC8 (S-402) — GET .../containers/:containerId/scans ──────────────────────

describe('GET .../containers/:containerId/scans — AC7/AC8', () => {
  function makeScanResultStore(scansByApp = {}) {
    return {
      calls: [],
      async list(app) {
        this.calls.push(app);
        return scansByApp[app] ?? [];
      },
      async getByScanId() {
        return null;
      },
    };
  }

  it('liefert die kompakte Verlaufsliste des über den Container aufgelösten App-Hostnamens', async () => {
    const scanResultStore = makeScanResultStore({
      'dev-gui.example.com': [
        { scanId: 'scan-1', startedAt: '2026-07-22T10:00:00.000Z', ampel: 'gruen', findingCount: 0, boardItemIds: [] },
      ],
    });
    const { app } = makeApp({ scanResultStore });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/vps/machines/hetzner/srv1/containers/c1/scans');
      expect(status).toBe(200);
      expect(body).toEqual({
        scans: [{ scanId: 'scan-1', startedAt: '2026-07-22T10:00:00.000Z', ampel: 'gruen', findingCount: 0, boardItemIds: [] }],
      });
      expect(scanResultStore.calls).toEqual(['dev-gui.example.com']);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ohne scanResultStore → 200 { scans: [] } (best-effort, kein Crash)', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/vps/machines/hetzner/srv1/containers/c1/scans');
      expect(status).toBe(200);
      expect(body).toEqual({ scans: [] });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('Container nicht (mehr) gefunden → 200 { scans: [] } (kein Crash, kein 404)', async () => {
    const deps = makeDeps({ containers: [runningContainer({ containerId: 'other' })] });
    const scanResultStore = makeScanResultStore();
    const { app } = makeApp({ deps, scanResultStore });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/vps/machines/hetzner/srv1/containers/c1/scans');
      expect(status).toBe(200);
      expect(body).toEqual({ scans: [] });
      expect(scanResultStore.calls).toEqual([]); // nie aufgerufen — kein Hostname auflösbar
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ein scanResultStore.list()-Fehler crasht die Anfrage nicht (best-effort)', async () => {
    const scanResultStore = {
      list: async () => { throw new Error('store down'); },
      getByScanId: async () => null,
    };
    const { app } = makeApp({ scanResultStore });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/vps/machines/hetzner/srv1/containers/c1/scans');
      expect(status).toBe(200);
      expect(body).toEqual({ scans: [] });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ungültiger Provider → 400', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const { status } = await httpGet(srv, '/api/vps/machines/evil-provider/srv1/containers/c1/scans');
      expect(status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ungültige containerId (Sonderzeichen) → 400', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const { status } = await httpGet(srv, '/api/vps/machines/hetzner/srv1/containers/c!1/scans');
      expect(status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC7/AC8 (S-402) — GET .../scans/:scanId ────────────────────────────────────

describe('GET .../scans/:scanId — AC7/AC8', () => {
  it('liefert den vollen Datensatz inkl. findings + reportRef', async () => {
    const fullScan = {
      scanId: 'scan-1',
      app: 'dev-gui.example.com',
      startedAt: '2026-07-22T10:00:00.000Z',
      finishedAt: '2026-07-22T10:05:00.000Z',
      ampel: 'rot',
      findings: [{ id: 'f1', severity: 'high', kind: 'xss', testort: 'direkt', titel: 'XSS' }],
      findingCount: 1,
      reportRef: 'report-1',
      boardItemIds: [],
    };
    const scanResultStore = { getByScanId: async (scanId) => (scanId === 'scan-1' ? fullScan : null) };
    const { app } = makeApp({ scanResultStore });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/vps/machines/hetzner/srv1/scans/scan-1');
      expect(status).toBe(200);
      expect(body).toEqual({ scan: fullScan });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('unbekannte scanId → 404', async () => {
    const scanResultStore = { getByScanId: async () => null };
    const { app } = makeApp({ scanResultStore });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/vps/machines/hetzner/srv1/scans/does-not-exist');
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ohne scanResultStore → 404 (kein Crash)', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const { status } = await httpGet(srv, '/api/vps/machines/hetzner/srv1/scans/scan-1');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ein scanResultStore.getByScanId()-Fehler crasht die Anfrage nicht (best-effort) → 404', async () => {
    const scanResultStore = { getByScanId: async () => { throw new Error('store down'); } };
    const { app } = makeApp({ scanResultStore });
    const srv = await startServer(app);
    try {
      const { status } = await httpGet(srv, '/api/vps/machines/hetzner/srv1/scans/scan-1');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ungültiger Provider → 400', async () => {
    const { app } = makeApp();
    const srv = await startServer(app);
    try {
      const { status } = await httpGet(srv, '/api/vps/machines/evil-provider/srv1/scans/scan-1');
      expect(status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
