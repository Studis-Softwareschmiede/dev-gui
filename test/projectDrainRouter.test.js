/**
 * projectDrainRouter.test.js — HTTP-Ebenen-Tests für POST /api/projects/:slug/drain
 * (docs/specs/taktgeber-nachtwaechter.md AC12, S-196).
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC12 — der manuelle „Board abarbeiten"-Knopf nutzt die ProjectDrain-Engine:
 *          POST /api/projects/:slug/drain löst `projectDrain.drainProject()`
 *          für das aufgelöste Projekt aus und antwortet SOFORT mit
 *          202 {drainId} (Fire-and-forget — der Request wartet nicht auf das
 *          Ende des potenziell lang laufenden Drains, s. projectDrainRouter.js
 *          Modul-Doku); ein rejecteter Drain crasht den Server nicht.
 *   AC6/AC7 (Wiederverwendung S-190/S-192) — 409, wenn das Projekt bereits
 *          busy ist (Lock gehalten ODER CommandService running ODER aktive
 *          Session) — kein Doppel-Start; drainProject() wird in diesem Fall
 *          NICHT aufgerufen (Router dupliziert den Lock-Erwerb nicht, prüft
 *          nur lesend vor).
 *   Slug-/Pfad-Validierung — 400 bei ungültigem Slug (Traversal-Token) oder
 *          wenn der Pfad-Validator eine Boundary-Verletzung meldet.
 *          500, wenn die ProjectDrain-Engine nicht verdrahtet ist
 *          (Composition-Root-Fehler, defensiv).
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
 */
function makeApp({
  projectDrain,
  commandService = { getStatus: () => ({ status: 'idle' }) },
  sessionRegistry = { hasSession: () => false },
  lock,
  slugResolver = makeSlugResolver(),
  pathValidator = identityPathValidator(),
  identity = { email: 'test@example.com' },
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });
  app.use(
    projectDrainRouter(
      { projectDrain, commandService, sessionRegistry },
      { slugResolver, pathValidator, lock },
    ),
  );
  return app;
}

describe('POST /api/projects/:slug/drain (AC12 taktgeber-nachtwaechter)', () => {
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
    // ist der Aufruf bereits erfolgt.
    expect(drainProject).toHaveBeenCalledTimes(1);
    expect(drainProject).toHaveBeenCalledWith('/workspace/dev-gui', { identity: { email: 'test@example.com' } });
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
});
