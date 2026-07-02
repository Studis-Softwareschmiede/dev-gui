/**
 * @file storySpecifyRouter.test.js — HTTP-level tests for the Neue-Story-Chat
 * („from scratch", ohne Idee-Karte) endpoints — docs/specs/new-story-chat.md
 * AC2, AC3, AC4, AC5, AC8 — plus the finalize-visibility extension
 * (docs/specs/story-specify-finalize-visibility.md AC2, AC3, AC4).
 *
 * Covers (new-story-chat): AC2, AC3, AC4, AC5, AC8
 *
 *   AC2 — POST .../story-specify/start { initialText } → 201 { sessionId, reply };
 *         seedet die neue Session mit `initialText`; 400 { field:'initialText' }
 *         bei leerem/whitespace-only/zu langem Text (KEIN Audit); 404 bei
 *         unbekanntem Projekt/ungültigem Slug-Format; 502 bei claude -p-Fehler
 *         (secret-frei); genau EIN Audit-Eintrag je akzeptiertem Start.
 *   AC3 — POST .../story-specify/message { sessionId, message } → 200 { reply,
 *         readyToSpecify, draftText? }; Client übermittelt NUR die neue
 *         Nachricht; 400 bei fehlender/leerer/zu langer sessionId/message;
 *         404 bei unbekannter Session; nutzt denselben IdeaSpecifyChatService;
 *         genau EIN Audit-Eintrag je akzeptiertem Turn; Multi-Turn ohne Verlust.
 *   AC4 — POST .../story-specify/finalize { sessionId } → 202 { jobId,
 *         status:'running' } NUR wenn `readyToSpecify` (gelesen via
 *         `chatService.getSessionState()`, NICHT aus dem Body) — sonst 400
 *         { field:'readyToSpecify' }; 404 bei unbekanntem Projekt/Session/Slug;
 *         409 bei Finalizer-Lock ('locked'); genau EIN Audit je akzeptiertem
 *         Finalize-Start; `finalizer.start()` erhält `{ draftText }` aus der
 *         Session + `project.repo_path` als projectPath (KEIN ideaStoryId).
 *   AC5 — GET .../story-specify/finalize/:jobId → 200 { status, result?, error? }
 *         1:1 wie reconcile/idea-specify; 404 bei unbekannter jobId.
 *   AC8 — der an `finalizer.start()` übergebene `draftText` stammt aus der
 *         serverseitig gehaltenen Session (`getSessionState().draftText`); der
 *         Chat nutzt den echten `IdeaSpecifyChatService` (kein neuer Chat-Service).
 *         AccessGuard-Verdrahtung: per server.js-Inspektion (`app.use('/api',
 *         accessGuard)`), kein separater Middleware-Test.
 *
 * Covers (story-specify-finalize-visibility): AC2, AC3, AC4
 *
 *   AC2 — der per-Job-Endpunkt (`GET .../finalize/:jobId`) reicht den neuen
 *         `no-op`-Statuswert korrekt durch (200 { status:'no-op', error }).
 *   AC3 — POST .../finalize reicht den (SLUG_RE-validierten) `projectSlug` an
 *         `finalizer.start()` durch (Registry-Schlüssel für die projekt-keyed
 *         `running`-Registrierung).
 *   AC4 — GET .../story-specify/finalize (projekt-keyed) → 200 { job | null };
 *         liefert `lastForProject(slug)`; 404 bei unbekanntem Projekt/ungültigem
 *         Slug-Format; token-/secret-frei (kein Agenten-Dispatch, kein Audit).
 *
 * Pattern: express + node:http createServer auf Port 0 (127.0.0.1), kein
 * supertest (Muster ideaSpecifyRouter.test.js). Der echte
 * `IdeaSpecifyChatService` wird verwendet, mit injiziertem `runClaude` (Stub) —
 * kein echter `claude`-Prozess, kein PTY-Pfad. Der `finalizer` (AC4/AC5) ist ein
 * reiner Test-Stub ({start, getJob, lastForProject}) —
 * `StorySpecifyFinalizer.test.js` deckt den echten Orchestrator ab.
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { storySpecifyRouter } from '../src/storySpecifyRouter.js';
import { IdeaSpecifyChatService } from '../src/IdeaSpecifyChatService.js';
import { AuditStore } from '../src/AuditStore.js';

// ── HTTP-Hilfsfunktionen (Muster ideaSpecifyRouter.test.js) ──────────────────

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

const NOT_READY_RAW = JSON.stringify({ reply: 'What audience is this for?', readyToSpecify: false });
const READY_RAW = JSON.stringify({ reply: 'Got it.', readyToSpecify: true, draftText: 'Draft text.' });

function makeProject({ slug = 'demo' } = {}) {
  return { slug, repo_path: `/workspace/${slug}`, features: [] };
}

/** Test-Stub für `StorySpecifyFinalizer` (AC4/AC5 + finalize-visibility AC2/AC3/AC4)
 *  — der echte Orchestrator wird in `StorySpecifyFinalizer.test.js` getestet, hier
 *  nur die Router-Verdrahtung. `start()` ist async (der Router awaited es). */
function makeFinalizerStub({ startResult = { ok: true, jobId: 'job-1' }, jobs = {}, lastJob = null } = {}) {
  const jobsMap = new Map(Object.entries(jobs));
  return {
    start: jest.fn(async () => startResult),
    getJob: jest.fn(async (jobId) => jobsMap.get(jobId)),
    lastForProject: jest.fn(async () => lastJob),
    _jobsMap: jobsMap,
  };
}

function makeApp({ projects, runClaude, identity = { email: 'owner@example.com' }, auditStore, finalizer } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });

  const boardAggregator = {
    getIndex: async () => projects ?? [makeProject()],
  };
  const store = auditStore ?? new AuditStore();
  const chatService = new IdeaSpecifyChatService({ runClaude: runClaude ?? jest.fn(async () => NOT_READY_RAW) });
  const finalizerStub = finalizer ?? makeFinalizerStub();

  app.use(storySpecifyRouter({ boardAggregator, chatService, finalizer: finalizerStub, auditStore: store }));

  return { app, auditStore: store, chatService, finalizer: finalizerStub };
}

/** Startet eine Session + treibt sie in den readyToSpecify-Zustand (für finalize-Tests). */
async function startReadySession(srv, { slug = 'demo' } = {}) {
  const startRes = await httpPost(srv, `/api/board/projects/${slug}/story-specify/start`, { initialText: 'Dark mode toggle' });
  const { sessionId } = startRes.body;
  await httpPost(srv, `/api/board/projects/${slug}/story-specify/message`, { sessionId, message: 'yes please' });
  return sessionId;
}

// ── AC2: POST .../story-specify/start ────────────────────────────────────────

describe('POST .../story-specify/start — AC2: happy path (201)', () => {
  it('201 { sessionId, reply }, seedet mit initialText', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/start', { initialText: 'Dark mode toggle in settings' });
      expect(status).toBe(201);
      expect(typeof body.sessionId).toBe('string');
      expect(body.reply).toBe('What audience is this for?');

      expect(runClaude).toHaveBeenCalledTimes(1);
      const { history } = runClaude.mock.calls[0][0];
      expect(history[0].content).toContain('Dark mode toggle in settings');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST .../story-specify/start — AC2: Validierung (400, kein Audit)', () => {
  it('400 { field:"initialText" } bei leerem Text — kein Audit', async () => {
    const { app, auditStore } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/start', { initialText: '   ' });
      expect(status).toBe(400);
      expect(body.field).toBe('initialText');
      expect(auditStore.getAll()).toHaveLength(0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 { field:"initialText" } bei fehlendem Feld', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/start', {});
      expect(status).toBe(400);
      expect(body.field).toBe('initialText');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei zu langem initialText (> Längenlimit)', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const initialText = 'x'.repeat(10_001);
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/start', { initialText });
      expect(status).toBe(400);
      expect(body.field).toBe('initialText');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST .../story-specify/start — AC2: 404-Pfade', () => {
  it('404 bei ungültigem Slug-Format (führender Punkt)', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/board/projects/.bad/story-specify/start', { initialText: 'x' });
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 bei unbekanntem Projekt-Slug', async () => {
    const { app } = makeApp({ projects: [] });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/nope/story-specify/start', { initialText: 'x' });
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST .../story-specify/start — AC2: Audit-First + 502 bei claude-Fehler', () => {
  it('genau EIN Audit-Eintrag je akzeptiertem Start', async () => {
    const { app, auditStore } = makeApp({ identity: { email: 'owner@example.com' } });
    const srv = await startServer(app);
    try {
      await httpPost(srv, '/api/board/projects/demo/story-specify/start', { initialText: 'x' });
      const entries = auditStore.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].command).toBe('board:story:specify:start:demo');
      expect(entries[0].identity).toBe('owner@example.com');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('502 (secret-frei) bei claude -p-Fehler', async () => {
    const runClaude = jest.fn(async () => { throw new Error('/opt/homebrew/bin/claude ENOENT'); });
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/start', { initialText: 'x' });
      expect(status).toBe(502);
      expect(typeof body.error).toBe('string');
      expect(body.error).not.toContain('/opt/homebrew');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC3: POST .../story-specify/message ──────────────────────────────────────

describe('POST .../story-specify/message — AC3', () => {
  it('200 { reply, readyToSpecify, draftText? } und nutzt denselben Chat-Service', async () => {
    let call = 0;
    const runClaude = jest.fn(async () => (call++ === 0 ? NOT_READY_RAW : READY_RAW));
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);
    try {
      const startRes = await httpPost(srv, '/api/board/projects/demo/story-specify/start', { initialText: 'Dark mode' });
      const { sessionId } = startRes.body;

      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/message', { sessionId, message: 'For everyone.' });
      expect(status).toBe(200);
      expect(body.reply).toBe('Got it.');
      expect(body.readyToSpecify).toBe(true);
      expect(body.draftText).toBe('Draft text.');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei fehlender sessionId', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/message', { message: 'hi' });
      expect(status).toBe(400);
      expect(body.field).toBe('sessionId');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei leerer message', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/message', { sessionId: 'x', message: '   ' });
      expect(status).toBe(400);
      expect(body.field).toBe('message');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei zu langer message', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);
    try {
      const startRes = await httpPost(srv, '/api/board/projects/demo/story-specify/start', { initialText: 'x' });
      const { sessionId } = startRes.body;
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/message', { sessionId, message: 'y'.repeat(10_001) });
      expect(status).toBe(400);
      expect(body.field).toBe('message');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 bei unbekannter Session', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/board/projects/demo/story-specify/message', { sessionId: 'unknown', message: 'hi' });
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('AC3 Multi-Turn ohne Verlust: der komplette Verlauf geht bei jedem Turn erneut an claude', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);
    try {
      const startRes = await httpPost(srv, '/api/board/projects/demo/story-specify/start', { initialText: 'seed' });
      const { sessionId } = startRes.body;

      await httpPost(srv, '/api/board/projects/demo/story-specify/message', { sessionId, message: 'first' });
      await httpPost(srv, '/api/board/projects/demo/story-specify/message', { sessionId, message: 'second' });

      // Dritter Aufruf (Index 2 nach start) trägt den kompletten Verlauf.
      const lastHistory = runClaude.mock.calls[2][0].history;
      const contents = lastHistory.map((t) => t.content).join('\n');
      expect(contents).toContain('seed');
      expect(contents).toContain('first');
      expect(contents).toContain('second');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC4: POST .../story-specify/finalize ─────────────────────────────────────

describe('POST .../story-specify/finalize — AC4', () => {
  it('202 { jobId, status:"running" } bei readyToSpecify; finalizer.start erhält { draftText } + repo_path', async () => {
    let call = 0;
    const runClaude = jest.fn(async () => (call++ === 0 ? NOT_READY_RAW : READY_RAW));
    const finalizer = makeFinalizerStub({ startResult: { ok: true, jobId: 'job-42' } });
    const { app, auditStore } = makeApp({ runClaude, finalizer });
    const srv = await startServer(app);
    try {
      const sessionId = await startReadySession(srv);
      const auditBefore = auditStore.getAll().length;

      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/finalize', { sessionId });
      expect(status).toBe(202);
      expect(body).toEqual({ jobId: 'job-42', status: 'running' });

      expect(finalizer.start).toHaveBeenCalledTimes(1);
      const [projectPath, params] = finalizer.start.mock.calls[0];
      expect(projectPath).toBe('/workspace/demo');
      expect(params.draftText).toBe('Draft text.'); // aus getSessionState(), AC8
      expect(params.ideaStoryId).toBeUndefined(); // „from scratch": kein Idee-Bezug
      // finalize-visibility AC3: der SLUG_RE-validierte Slug ist der Registry-Schlüssel.
      expect(params.projectSlug).toBe('demo');

      // genau EIN zusätzlicher Audit-Eintrag für den Finalize-Start
      const finalizeEntries = auditStore.getAll().slice(auditBefore);
      expect(finalizeEntries).toHaveLength(1);
      expect(finalizeEntries[0].command).toBe('board:story:specify:finalize:demo');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 { field:"readyToSpecify" } wenn der Chat NICHT bereit ist (kein Finalizer-Start, kein Audit)', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const finalizer = makeFinalizerStub();
    const { app, auditStore } = makeApp({ runClaude, finalizer });
    const srv = await startServer(app);
    try {
      const startRes = await httpPost(srv, '/api/board/projects/demo/story-specify/start', { initialText: 'x' });
      const { sessionId } = startRes.body;
      const auditBefore = auditStore.getAll().length;

      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/finalize', { sessionId });
      expect(status).toBe(400);
      expect(body.field).toBe('readyToSpecify');
      expect(finalizer.start).not.toHaveBeenCalled();
      expect(auditStore.getAll().length).toBe(auditBefore);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei fehlender sessionId', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/finalize', {});
      expect(status).toBe(400);
      expect(body.field).toBe('sessionId');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 bei unbekannter Session', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/board/projects/demo/story-specify/finalize', { sessionId: 'unknown' });
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 bei unbekanntem Projekt (Session existiert, Projekt aber nicht mehr im Index)', async () => {
    let call = 0;
    const runClaude = jest.fn(async () => (call++ === 0 ? NOT_READY_RAW : READY_RAW));
    // Chat-Session wird gegen ein vorhandenes Projekt gestartet, dann für den
    // Finalize-Call verschwindet der Slug aus dem Index.
    let indexProjects = [makeProject()];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'o@x.ch' }; next(); });
    const boardAggregator = { getIndex: async () => indexProjects };
    const chatService = new IdeaSpecifyChatService({ runClaude });
    const finalizer = makeFinalizerStub();
    app.use(storySpecifyRouter({ boardAggregator, chatService, finalizer, auditStore: new AuditStore() }));
    const srv = await startServer(app);
    try {
      const sessionId = await startReadySession(srv);
      indexProjects = []; // Projekt verschwindet
      const { status } = await httpPost(srv, '/api/board/projects/demo/story-specify/finalize', { sessionId });
      expect(status).toBe(404);
      expect(finalizer.start).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('409 bei belegtem Finalizer-Lock (locked)', async () => {
    let call = 0;
    const runClaude = jest.fn(async () => (call++ === 0 ? NOT_READY_RAW : READY_RAW));
    const finalizer = makeFinalizerStub({ startResult: { ok: false, reason: 'locked' } });
    const { app } = makeApp({ runClaude, finalizer });
    const srv = await startServer(app);
    try {
      const sessionId = await startReadySession(srv);
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/story-specify/finalize', { sessionId });
      expect(status).toBe(409);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC5: GET .../story-specify/finalize/:jobId ───────────────────────────────

describe('GET .../story-specify/finalize/:jobId — AC5', () => {
  it('200 { status, result? } für einen bekannten Job', async () => {
    const finalizer = makeFinalizerStub({ jobs: { 'job-1': { status: 'done', result: 'Flow abgeschlossen' } } });
    const { app } = makeApp({ finalizer });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/board/projects/demo/story-specify/finalize/job-1');
      expect(status).toBe(200);
      expect(body).toEqual({ status: 'done', result: 'Flow abgeschlossen' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('200 { status, error } für einen fehlgeschlagenen Job (secret-frei durchgereicht)', async () => {
    const finalizer = makeFinalizerStub({ jobs: { 'job-2': { status: 'failed', error: 'Flow-Lauf fehlgeschlagen' } } });
    const { app } = makeApp({ finalizer });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/board/projects/demo/story-specify/finalize/job-2');
      expect(status).toBe(200);
      expect(body).toEqual({ status: 'failed', error: 'Flow-Lauf fehlgeschlagen' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 bei unbekannter jobId', async () => {
    const finalizer = makeFinalizerStub({ jobs: {} });
    const { app } = makeApp({ finalizer });
    const srv = await startServer(app);
    try {
      const { status } = await httpGet(srv, '/api/board/projects/demo/story-specify/finalize/nope');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('finalize-visibility AC2: 200 { status:"no-op", error } wird korrekt durchgereicht', async () => {
    const finalizer = makeFinalizerStub({
      jobs: { 'job-3': { status: 'no-op', error: 'Der Lauf hat keine Story angelegt — bitte erneut versuchen.' } },
    });
    const { app } = makeApp({ finalizer });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/board/projects/demo/story-specify/finalize/job-3');
      expect(status).toBe(200);
      expect(body.status).toBe('no-op');
      expect(body.error).toContain('keine Story');
      expect(body.error).not.toMatch(/\/workspace|token/);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC4 (finalize-visibility): GET .../story-specify/finalize (projekt-keyed) ──

describe('GET .../story-specify/finalize — story-specify-finalize-visibility AC4', () => {
  it('200 { job } mit dem letzten Finalize-Job dieses Projekts (lastForProject)', async () => {
    const lastJob = { status: 'no-op', jobId: 'job-9', error: 'Der Lauf hat keine Story angelegt — bitte erneut versuchen.' };
    const finalizer = makeFinalizerStub({ lastJob });
    const { app } = makeApp({ finalizer });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/board/projects/demo/story-specify/finalize');
      expect(status).toBe(200);
      expect(body).toEqual({ job: lastJob });
      expect(finalizer.lastForProject).toHaveBeenCalledWith('demo');
      // Token-frei: kein Agenten-Dispatch (start/getJob nicht angefasst).
      expect(finalizer.start).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('200 { job: null } wenn (noch) kein Finalize für dieses Projekt lief', async () => {
    const finalizer = makeFinalizerStub({ lastJob: null });
    const { app } = makeApp({ finalizer });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/board/projects/demo/story-specify/finalize');
      expect(status).toBe(200);
      expect(body).toEqual({ job: null });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('200 { job } für einen laufenden Job (running)', async () => {
    const finalizer = makeFinalizerStub({ lastJob: { status: 'running', jobId: 'job-run' } });
    const { app } = makeApp({ finalizer });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/board/projects/demo/story-specify/finalize');
      expect(status).toBe(200);
      expect(body.job).toEqual({ status: 'running', jobId: 'job-run' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 bei unbekanntem Projekt-Slug (kein lastForProject-Aufruf)', async () => {
    const finalizer = makeFinalizerStub({ lastJob: { status: 'running', jobId: 'x' } });
    const { app } = makeApp({ projects: [], finalizer });
    const srv = await startServer(app);
    try {
      const { status } = await httpGet(srv, '/api/board/projects/nope/story-specify/finalize');
      expect(status).toBe(404);
      expect(finalizer.lastForProject).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 bei ungültigem Slug-Format (führender Punkt)', async () => {
    const finalizer = makeFinalizerStub();
    const { app } = makeApp({ finalizer });
    const srv = await startServer(app);
    try {
      const { status } = await httpGet(srv, '/api/board/projects/.bad/story-specify/finalize');
      expect(status).toBe(404);
      expect(finalizer.lastForProject).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
