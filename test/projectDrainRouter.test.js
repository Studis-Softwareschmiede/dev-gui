/**
 * projectDrainRouter.test.js — HTTP-Ebenen-Tests für POST /api/projects/:slug/drain
 * + GET /api/projects/:slug/drain/:drainId
 * (docs/specs/headless-manual-drain.md AC1/AC2/AC3/AC4, ADR-017 — ersetzt den
 * interaktiven Pfad aus taktgeber-nachtwaechter AC12).
 *
 * Covers (headless-manual-drain):
 *   AC1 — der manuelle „Board abarbeiten"-Knopf löst `projectDrain.drainProject()`
 *          für das aufgelöste Projekt aus und antwortet SOFORT mit 202 {drainId}
 *          (Fire-and-forget — der Request wartet nicht auf das Ende des
 *          potenziell lang laufenden Drains, s. projectDrainRouter.js Modul-Doku);
 *          ein rejecteter Drain crasht den Server nicht. Ob die injizierte
 *          ProjectDrain-Instanz headless oder interaktiv verdrahtet ist, ist auf
 *          Router-Ebene transparent — der Router kennt nur `drainProject()`;
 *          die konkrete headless-Verdrahtung (HeadlessFlowRunnerAdapter) ist in
 *          server.js + test/FlowRunner.test.js/test/ProjectDrain.test.js abgedeckt.
 *   AC2 — 409, wenn das Projekt bereits busy ist (Lock gehalten ODER
 *          CommandService running ODER aktive Session) — kein Doppel-Start;
 *          drainProject() wird in diesem Fall NICHT aufgerufen (Router dupliziert
 *          den Lock-Erwerb nicht, prüft nur lesend vor). Der geprüfte Lock ist
 *          via `options.lock` injiziert (in server.js dieselbe Instanz wie der
 *          Session-Lock der manuellen ProjectDrain-Instanz).
 *   AC3 — Cost-Mode-Durchreichung: `{ costMode }` gültig+≠balanced → args
 *          `['--cost', <mode>]` an drainProject; `balanced`/fehlend → args `[]`
 *          (kein Flag); ungültiger costMode → 400, KEIN Drain-Start.
 *   AC4 — Drain-Job-Status: jeder gestartete Drain wird unter seiner `drainId`
 *          in der In-Memory-Registry geführt; `GET …/drain/:drainId` liefert
 *          `200 { status: 'running'|'done'|'failed', … }` (secret-/pfad-frei) |
 *          `404` (unbekannte drainId) | `400` (ungültiger Slug). `running` vor
 *          Auflösung, `done` (mit Ergebnis-Zusammenfassung) nach resolve,
 *          `failed` (generischer Text) nach reject. Der DrainJobRegistry-Baustein
 *          selbst ist zusätzlich unit-getestet in test/DrainJobRegistry.test.js.
 *   Slug-/Pfad-Validierung — 400 bei ungültigem Slug (Traversal-Token) oder
 *          wenn der Pfad-Validator eine Boundary-Verletzung meldet.
 *          500, wenn die ProjectDrain-Engine nicht verdrahtet ist
 *          (Composition-Root-Fehler, defensiv).
 *
 * Covers (cost-mode-model-check, S-228):
 *   AC4 — Dispatch-Frische-Prüfung: `costModeModelCheck.runCheck('dispatch')`
 *          wird beim Cost-Mode-Dispatch aufgerufen; bei erkanntem Drift
 *          (`{ drift:true, checkId }`) trägt die 202-Antwort das optionale Feld
 *          `costModeCheckId`. Kein Drift / `skipped` (keine checkId) / fehlende
 *          Boundary → KEIN Feld (stiller Normalfall).
 *   AC5 — nicht-blockierend: der Drain wird VOR der Prüfung gestartet
 *          (drainProject() aufgerufen, auch wenn runCheck wirft/hängt); ein
 *          Fehler in runCheck verhindert die 202-Antwort NIE (best-effort).
 *
 * Strategy: echter Express-App + echter HTTP-Server (Muster
 * test/slugResolver.test.js "commandRouter integration" + test/tickerSettings.test.js
 * HTTP-Helpers) — injizierbarer slugResolver/pathValidator/lock (kein echtes
 * WORKSPACE_DIR/fs nötig), ein Fake-`projectDrain` (jest.fn) statt der echten
 * Engine (die Engine selbst ist in test/ProjectDrain.test.js abgedeckt).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import { createServer, request as httpRequest } from 'node:http';
import { ProjectPathError } from '../src/workspacePath.js';
import { projectDrainRouter } from '../src/projectDrainRouter.js';

// ── HTTP-Helpers (Muster test/tickerSettings.test.js) ────────────────────────

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function postNoBody(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'POST' },
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
    req.end();
  });
}

/** GET → JSON (AC4 Drain-Job-Status). */
function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
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
    req.end();
  });
}

/** Flush pending microtasks + one macrotask tick — der fire-and-forget
 *  drainProject().then()/catch() (Registry-Update, AC4) läuft danach garantiert. */
function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** POST mit JSON-Body (AC3 costMode). */
function postJson(port, path, bodyObj) {
  const payload = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
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
    req.end(payload);
  });
}

// ── Test-Doubles ──────────────────────────────────────────────────────────────

/** Default slugResolver: 'dev-gui' → '/workspace/dev-gui', alles andere → null. */
function makeSlugResolver(map = { 'dev-gui': '/workspace/dev-gui' }) {
  return (slug) => (Object.prototype.hasOwnProperty.call(map, slug) ? map[slug] : null);
}

/** Default pathValidator: identity — resolviert den übergebenen Pfad unverändert. */
function identityPathValidator() {
  return async (p) => ({ resolvedPath: p });
}

/**
 * Baut eine Express-App mit dem projectDrainRouter.
 *
 * @param {object} [opts]
 * @param {object} [opts.projectDrain]      Fake ProjectDrain-Instanz (drainProject jest.fn)
 * @param {object} [opts.commandService]    für isProjectBusy (default: getStatus → idle)
 * @param {object} [opts.sessionRegistry]   für isProjectBusy (default: hasSession → false)
 * @param {object} [opts.lock]              für isProjectBusy (default: kein Override, echtes Singleton)
 * @param {Function} [opts.slugResolver]    default: makeSlugResolver()
 * @param {Function} [opts.pathValidator]   default: identityPathValidator()
 * @param {object|null} [opts.identity]     req.identity (default: {email:'test@example.com'})
 * @param {object} [opts.costModeModelCheck] Fake CostModeModelCheck (runCheck jest.fn) — AC4/AC5
 */
function makeApp({
  projectDrain,
  commandService = { getStatus: () => ({ status: 'idle' }) },
  sessionRegistry = { hasSession: () => false },
  lock,
  slugResolver = makeSlugResolver(),
  pathValidator = identityPathValidator(),
  identity = { email: 'test@example.com' },
  costModeModelCheck,
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });
  app.use(
    projectDrainRouter(
      { projectDrain, commandService, sessionRegistry, costModeModelCheck },
      { slugResolver, pathValidator, lock },
    ),
  );
  return app;
}

describe('POST /api/projects/:slug/drain (headless-manual-drain AC1/AC2/AC3)', () => {
  let server;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    consoleErrorSpy.mockRestore();
  });

  it('202 {drainId} — startet drainProject() mit aufgelöstem Pfad + Identity (happy path)', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');

    expect(res.status).toBe(202);
    expect(typeof res.body.drainId).toBe('string');
    expect(res.body.drainId.length).toBeGreaterThan(0);

    // drainProject wird synchron (fire-and-forget) angestoßen — nach dem Response
    // ist der Aufruf bereits erfolgt. Ohne costMode → args: [] (kein --cost-Flag).
    expect(drainProject).toHaveBeenCalledTimes(1);
    expect(drainProject).toHaveBeenCalledWith('/workspace/dev-gui', {
      identity: { email: 'test@example.com' },
      args: [],
    });
  });

  it('Fire-and-forget: HTTP-Antwort kommt SOFORT, ohne auf das Drain-Ende zu warten', async () => {
    let resolveDrain;
    const drainPromise = new Promise((resolve) => { resolveDrain = resolve; });
    const drainProject = jest.fn(() => drainPromise);
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    // Die Antwort muss ankommen, OBWOHL drainPromise absichtlich nie vor dem
    // Request auflöst (die Drain-Engine "läuft" hier für immer weiter).
    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(res.status).toBe(202);
    expect(typeof res.body.drainId).toBe('string');

    // Aufräumen: Promise jetzt auflösen, damit kein offener Handle übrig bleibt.
    resolveDrain({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] });
  });

  it('ein rejecteter Drain crasht den Server nicht (best-effort catch)', async () => {
    const drainProject = jest.fn(() => Promise.reject(new Error('boom')));
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(res.status).toBe(202);

    // Zweiter Request beweist: der Server lebt noch (kein Absturz durch die
    // unhandled rejection oben).
    const res2 = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(res2.status).toBe(202);
  });

  it('409 — Projekt bereits busy (CommandService running) — drainProject() wird NICHT aufgerufen', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));
    const app = makeApp({
      projectDrain: { drainProject },
      commandService: { getStatus: () => ({ status: 'running' }) },
    });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(res.status).toBe(409);
    expect(drainProject).not.toHaveBeenCalled();
  });

  it('409 — Projekt bereits busy (aktive Session) — drainProject() wird NICHT aufgerufen', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));
    const app = makeApp({
      projectDrain: { drainProject },
      sessionRegistry: { hasSession: () => true },
    });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(res.status).toBe(409);
    expect(drainProject).not.toHaveBeenCalled();
  });

  it('409 — Projekt bereits busy (Lock gehalten) — drainProject() wird NICHT aufgerufen', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));
    const app = makeApp({
      projectDrain: { drainProject },
      lock: { isHeld: () => true },
    });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(res.status).toBe(409);
    expect(drainProject).not.toHaveBeenCalled();
  });

  it('400 — ungültiger Slug (Traversal-Token) via echtem resolveProjectSlug', async () => {
    // Kein slugResolver-Override → Default `resolveProjectSlug` aus workspacePath.js;
    // '..' wirft VOR dem WORKSPACE_DIR-Check (kein env nötig). Percent-encoded,
    // damit der Literal-String '..' (kein Filesystem-Traversal) als :slug-Segment
    // ankommt (Express deodiert Route-Parameter automatisch).
    const drainProject = jest.fn();
    const app = makeApp({ projectDrain: { drainProject }, slugResolver: undefined });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/%2e%2e/drain');
    expect(res.status).toBe(400);
    expect(drainProject).not.toHaveBeenCalled();
  });

  it('400 — pathValidator meldet Boundary-Verletzung (ProjectPathError)', async () => {
    const drainProject = jest.fn();
    const app = makeApp({
      projectDrain: { drainProject },
      pathValidator: async () => {
        throw new ProjectPathError('outside boundary', 'outside-boundary');
      },
    });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(res.status).toBe(400);
    expect(drainProject).not.toHaveBeenCalled();
  });

  it('400 — slugResolver liefert null (leerer/ungültiger Slug)', async () => {
    const drainProject = jest.fn();
    const app = makeApp({
      projectDrain: { drainProject },
      slugResolver: () => null,
    });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(res.status).toBe(400);
    expect(drainProject).not.toHaveBeenCalled();
  });

  it('500 — ProjectDrain-Engine nicht verdrahtet (Composition-Root-Fehler, defensiv)', async () => {
    const app = makeApp({ projectDrain: undefined });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(res.status).toBe(500);
  });

  // ── AC3: Cost-Mode-Durchreichung ────────────────────────────────────────────

  it('AC3 — costMode gültig+≠balanced → args ["--cost", <mode>] an drainProject, 202', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const res = await postJson(s.port, '/api/projects/dev-gui/drain', { costMode: 'low-cost' });

    expect(res.status).toBe(202);
    expect(typeof res.body.drainId).toBe('string');
    expect(drainProject).toHaveBeenCalledWith('/workspace/dev-gui', {
      identity: { email: 'test@example.com' },
      args: ['--cost', 'low-cost'],
    });
  });

  it('AC3 — costMode "frontier" → args ["--cost", "frontier"]', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const res = await postJson(s.port, '/api/projects/dev-gui/drain', { costMode: 'frontier' });

    expect(res.status).toBe(202);
    expect(drainProject).toHaveBeenCalledWith('/workspace/dev-gui', {
      identity: { email: 'test@example.com' },
      args: ['--cost', 'frontier'],
    });
  });

  it('AC3 — costMode "balanced" (Default) → KEIN Flag (args: [])', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const res = await postJson(s.port, '/api/projects/dev-gui/drain', { costMode: 'balanced' });

    expect(res.status).toBe(202);
    expect(drainProject).toHaveBeenCalledWith('/workspace/dev-gui', {
      identity: { email: 'test@example.com' },
      args: [],
    });
  });

  it('AC3 — ungültiger costMode → 400, KEIN Drain-Start', async () => {
    const drainProject = jest.fn();
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const res = await postJson(s.port, '/api/projects/dev-gui/drain', { costMode: 'ultra-mega' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/costMode/i);
    expect(drainProject).not.toHaveBeenCalled();
  });

  it('AC3 — costMode nicht-String (z.B. Zahl) → 400, KEIN Drain-Start', async () => {
    const drainProject = jest.fn();
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const res = await postJson(s.port, '/api/projects/dev-gui/drain', { costMode: 42 });

    expect(res.status).toBe(400);
    expect(drainProject).not.toHaveBeenCalled();
  });

  it('AC3 — leerer JSON-Body {} → args: [] (costMode optional, kein Flag)', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const res = await postJson(s.port, '/api/projects/dev-gui/drain', {});

    expect(res.status).toBe(202);
    expect(drainProject).toHaveBeenCalledWith('/workspace/dev-gui', {
      identity: { email: 'test@example.com' },
      args: [],
    });
  });
});

// ── AC4/AC5 (cost-mode-model-check, S-228): Dispatch-Frische-Prüfung ───────────

describe('POST /api/projects/:slug/drain — Cost-Mode-Frische-Prüfung (cost-mode-model-check AC4/AC5)', () => {
  let server;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    consoleErrorSpy.mockRestore();
  });

  const okDrain = () => jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));

  it('AC4 — Drift erkannt: runCheck("dispatch") aufgerufen + costModeCheckId in der 202-Antwort', async () => {
    const drainProject = okDrain();
    const runCheck = jest.fn(async () => ({ drift: true, checkId: 'chk-123', done: Promise.resolve() }));
    const app = makeApp({ projectDrain: { drainProject }, costModeModelCheck: { runCheck } });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');

    expect(res.status).toBe(202);
    expect(typeof res.body.drainId).toBe('string');
    expect(res.body.costModeCheckId).toBe('chk-123');
    expect(runCheck).toHaveBeenCalledWith('dispatch');
    // AC5: der Drain wurde ebenfalls gestartet (nicht durch die Prüfung ersetzt).
    expect(drainProject).toHaveBeenCalledTimes(1);
  });

  it('AC4 — kein Drift (fresh): KEIN costModeCheckId-Feld, runCheck trotzdem aufgerufen', async () => {
    const drainProject = okDrain();
    const runCheck = jest.fn(async () => ({ drift: false, reason: 'fresh' }));
    const app = makeApp({ projectDrain: { drainProject }, costModeModelCheck: { runCheck } });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ drainId: expect.any(String) });
    expect(res.body.costModeCheckId).toBeUndefined();
    expect(runCheck).toHaveBeenCalledWith('dispatch');
  });

  it('AC4 — Curator läuft bereits (skipped, keine checkId): KEIN costModeCheckId-Feld', async () => {
    const drainProject = okDrain();
    const runCheck = jest.fn(async () => ({ drift: true, skipped: 'locked' }));
    const app = makeApp({ projectDrain: { drainProject }, costModeModelCheck: { runCheck } });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');

    expect(res.status).toBe(202);
    expect(res.body.costModeCheckId).toBeUndefined();
  });

  it('AC5 — nicht-blockierend: runCheck wirft → 202 kommt trotzdem, Drain wurde gestartet', async () => {
    const drainProject = okDrain();
    const runCheck = jest.fn(async () => { throw new Error('curator boom'); });
    const app = makeApp({ projectDrain: { drainProject }, costModeModelCheck: { runCheck } });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');

    expect(res.status).toBe(202);
    expect(typeof res.body.drainId).toBe('string');
    expect(res.body.costModeCheckId).toBeUndefined();
    // AC5: der Drain-Start ist unabhängig von der Prüfung erfolgt.
    expect(drainProject).toHaveBeenCalledTimes(1);
  });

  it('AC5 — Drain wird VOR der Prüfung gestartet (drainProject aufgerufen, bevor runCheck resolved)', async () => {
    const callOrder = [];
    const drainProject = jest.fn(async () => {
      callOrder.push('drain');
      return { stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] };
    });
    const runCheck = jest.fn(async () => {
      callOrder.push('check');
      return { drift: false, reason: 'fresh' };
    });
    const app = makeApp({ projectDrain: { drainProject }, costModeModelCheck: { runCheck } });
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(res.status).toBe(202);
    // drainProject() wird synchron VOR dem await runCheck() angestoßen.
    expect(callOrder[0]).toBe('drain');
  });

  it('ohne injizierte Boundary läuft der Drain unverändert (kein costModeCheckId, kein Crash)', async () => {
    const drainProject = okDrain();
    const app = makeApp({ projectDrain: { drainProject } }); // kein costModeModelCheck
    const s = await startServer(app);
    server = s.server;

    const res = await postNoBody(s.port, '/api/projects/dev-gui/drain');

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ drainId: expect.any(String) });
    expect(drainProject).toHaveBeenCalledTimes(1);
  });
});

// ── AC4: Drain-Job-Status (GET /api/projects/:slug/drain/:drainId) ─────────────

describe('GET /api/projects/:slug/drain/:drainId (headless-manual-drain AC4)', () => {
  let server;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    consoleErrorSpy.mockRestore();
  });

  it('404 — unbekannte drainId', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const res = await getJson(s.port, '/api/projects/dev-gui/drain/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/drainId/i);
  });

  it('200 { status: "running" } — solange der Drain noch läuft (Promise offen)', async () => {
    let resolveDrain;
    const drainPromise = new Promise((resolve) => { resolveDrain = resolve; });
    const drainProject = jest.fn(() => drainPromise);
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const post = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(post.status).toBe(202);
    const { drainId } = post.body;

    const res = await getJson(s.port, `/api/projects/dev-gui/drain/${drainId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'running' });

    // Aufräumen: Promise auflösen, damit kein offener Handle übrig bleibt.
    resolveDrain({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] });
  });

  it('200 { status: "done", result } — nach erfolgreichem Drain (secret-/pfad-frei)', async () => {
    const drainProject = jest.fn(async () => ({
      stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: ['S-5'],
    }));
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const post = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    const { drainId } = post.body;

    await flushAsync(); // fire-and-forget .then() (Registry → done) durchlaufen lassen

    const res = await getJson(s.port, `/api/projects/dev-gui/drain/${drainId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'done',
      result: { reason: 'no-drain-target', flowRuns: 2, escalated: ['S-5'] },
    });
  });

  it('200 { status: "failed", error } — nach rejectetem Drain (generischer Text, kein Roh-Fehler)', async () => {
    const drainProject = jest.fn(() => Promise.reject(new Error('boom /workspace/secret/path')));
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const post = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    const { drainId } = post.body;

    await flushAsync(); // fire-and-forget .catch() (Registry → failed) durchlaufen lassen

    const res = await getJson(s.port, `/api/projects/dev-gui/drain/${drainId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(typeof res.body.error).toBe('string');
    // Security-Floor: der Roh-Fehlertext (inkl. Pfad) darf NICHT in der Response landen.
    expect(res.body.error).not.toMatch(/workspace|secret|boom/i);
  });

  it('400 — ungültiger Slug (Traversal-Token) via echtem resolveProjectSlug', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }));
    const app = makeApp({ projectDrain: { drainProject }, slugResolver: undefined });
    const s = await startServer(app);
    server = s.server;

    const res = await getJson(s.port, '/api/projects/%2e%2e/drain/some-id');
    expect(res.status).toBe(400);
  });

  it('400 — slugResolver liefert null (leerer/ungültiger Slug)', async () => {
    const drainProject = jest.fn();
    const app = makeApp({ projectDrain: { drainProject }, slugResolver: () => null });
    const s = await startServer(app);
    server = s.server;

    const res = await getJson(s.port, '/api/projects/dev-gui/drain/some-id');
    expect(res.status).toBe(400);
  });

  it('POST → GET Round-Trip: dieselbe drainId ist über die geteilte Registry auflösbar', async () => {
    const drainProject = jest.fn(async () => ({ stopped: true, reason: 'already-busy', flowRuns: 0, escalated: [] }));
    const app = makeApp({ projectDrain: { drainProject } });
    const s = await startServer(app);
    server = s.server;

    const post = await postNoBody(s.port, '/api/projects/dev-gui/drain');
    expect(post.status).toBe(202);
    const { drainId } = post.body;

    await flushAsync();

    const res = await getJson(s.port, `/api/projects/dev-gui/drain/${drainId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(res.body.result.reason).toBe('already-busy');
  });
});
