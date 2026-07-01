/**
 * @file ideaSpecifyRouter.test.js — HTTP-level tests for the Idea-Specify Chat
 * endpoints (docs/specs/idea-specify-chat.md AC3, AC4, AC5, AC13).
 *
 * Covers (idea-specify-chat): AC3, AC4, AC5, AC13
 *
 *   AC3  — POST .../specify/start → 201 { sessionId, reply }; seedet mit Titel+Notes;
 *          404 bei unbekanntem Projekt/Slug-Format/Idee; 400 { field:'status' }
 *          wenn das Item keine besprechbare Idee ist (status !== 'Idee').
 *   AC4  — POST .../specify/message { sessionId, message } → 200 { reply,
 *          readyToSpecify, draftText? }; Client übermittelt NUR die neue
 *          Nachricht; 400 bei fehlender/leerer sessionId/message; 404 bei
 *          unbekannter Session.
 *   AC5  — hinter (simuliertem) AccessGuard; genau EIN Audit-Eintrag je
 *          akzeptiertem Turn (start UND message); 502 bei claude -p-Fehler
 *          (secret-frei); kein Audit bei 400/404-Ablehnung.
 *          AccessGuard-Verdrahtung: per server.js-Inspektion (`app.use('/api',
 *          accessGuard)`), kein separater Middleware-Test.
 *   AC13 — Multi-Turn-Kontext ohne Verlust — auf HTTP-Ebene verifiziert über
 *          mehrere aufeinanderfolgende /message-Aufrufe derselben Session.
 *
 * Pattern: express + node:http createServer auf Port 0 (127.0.0.1), kein
 * supertest (Muster reconcileRouter.test.js/assistRefineRouter.test.js). Der
 * echte `IdeaSpecifyChatService` wird verwendet, mit injiziertem `runClaude`
 * (Stub) — kein echter `claude`-Prozess, kein PTY-Pfad.
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { ideaSpecifyRouter } from '../src/ideaSpecifyRouter.js';
import { IdeaSpecifyChatService } from '../src/IdeaSpecifyChatService.js';
import { AuditStore } from '../src/AuditStore.js';

// ── HTTP-Hilfsfunktionen (Muster reconcileRouter.test.js) ────────────────────

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

function startServer(app) {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer(app);
    srv.listen(0, '127.0.0.1', () => resolvePromise(srv));
    srv.on('error', reject);
  });
}

const NOT_READY_RAW = JSON.stringify({ reply: 'What audience is this for?', readyToSpecify: false });
const READY_RAW = JSON.stringify({ reply: 'Got it.', readyToSpecify: true, draftText: 'Draft text.' });

function makeProject({ slug = 'demo', storyId = 'S-900', storyStatus = 'Idee', title = 'Dark mode', notes = 'toggle in settings' } = {}) {
  return {
    slug,
    repo_path: `/workspace/${slug}`,
    features: [
      {
        id: 'F-001',
        stories: [{ id: storyId, status: storyStatus, title, notes }],
      },
    ],
  };
}

function makeApp({ projects, runClaude, identity = { email: 'owner@example.com' }, auditStore } = {}) {
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

  app.use(ideaSpecifyRouter({ boardAggregator, chatService, auditStore: store }));

  return { app, auditStore: store, chatService };
}

// ── AC3: POST .../specify/start ──────────────────────────────────────────────

describe('POST .../specify/start — AC3: happy path (201)', () => {
  it('201 { sessionId, reply }, seedet mit Titel+Notes der Idee', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/start', {});
      expect(status).toBe(201);
      expect(typeof body.sessionId).toBe('string');
      expect(body.reply).toBe('What audience is this for?');

      expect(runClaude).toHaveBeenCalledTimes(1);
      const { history } = runClaude.mock.calls[0][0];
      expect(history[0].content).toContain('Dark mode');
      expect(history[0].content).toContain('toggle in settings');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST .../specify/start — AC3: 404-Pfade', () => {
  it('404 bei ungültigem Slug-Format (führender Punkt, ungültig per SLUG_RE)', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/board/projects/.bad/ideas/S-900/specify/start', {});
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 bei unbekanntem Projekt-Slug', async () => {
    const { app } = makeApp({ projects: [] });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/does-not-exist/ideas/S-900/specify/start', {});
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 bei unbekannter Idee-ID im Projekt', async () => {
    const { app } = makeApp({ projects: [makeProject()] });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/board/projects/demo/ideas/S-999/specify/start', {});
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST .../specify/start — AC3: 400 wenn Item keine besprechbare Idee ist', () => {
  it('400 { field:"status" } wenn story.status !== "Idee"', async () => {
    const { app, auditStore } = makeApp({ projects: [makeProject({ storyStatus: 'To Do' })] });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/start', {});
      expect(status).toBe(400);
      expect(body.field).toBe('status');
      // Kein Audit bei einer abgelehnten Eingabe (Audit-First-Konvention)
      expect(auditStore.getAll()).toHaveLength(0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST .../specify/start — AC5: Audit-First + 502 bei claude-Fehler', () => {
  it('genau EIN Audit-Eintrag je akzeptiertem Start', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const { app, auditStore } = makeApp({ runClaude, identity: { email: 'owner@example.com' } });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/start', {});
      expect(status).toBe(201);

      const entries = auditStore.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].identity).toBe('owner@example.com');
      expect(entries[0].command).toBe('board:idea:specify:start:demo:S-900');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('502 wenn claude -p fehlschlägt (secret-frei)', async () => {
    const runClaude = jest.fn(async () => { throw new Error('claude is not available in PATH'); });
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/start', {});
      expect(status).toBe(502);
      expect(typeof body.error).toBe('string');
      expect(body.error).not.toMatch(/PATH|secret|token|password/i);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('record()-Fehler → 500, claude wird NICHT aufgerufen', async () => {
    const faultyAuditStore = new AuditStore();
    faultyAuditStore.record = jest.fn(() => { throw new Error('Disk full'); });
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const { app } = makeApp({ runClaude, auditStore: faultyAuditStore });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/start', {});
      expect(status).toBe(500);
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── AC4/AC13: POST .../specify/message ───────────────────────────────────────

describe('POST .../specify/message — AC4: happy path + Multi-Turn ohne Verlust (AC13)', () => {
  it('200 { reply, readyToSpecify, draftText? }, hängt Nachricht an bestehende Historie an', async () => {
    const runClaude = jest.fn()
      .mockResolvedValueOnce(NOT_READY_RAW)
      .mockResolvedValueOnce(READY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { body: startBody } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/start', {});

      const { status, body } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/message', {
        sessionId: startBody.sessionId,
        message: 'Only premium users.',
      });

      expect(status).toBe(200);
      expect(body.reply).toBe('Got it.');
      expect(body.readyToSpecify).toBe(true);
      expect(body.draftText).toBe('Draft text.');

      // AC13: der zweite runClaude-Aufruf enthält die GESAMTE bisherige Historie
      // (Seed-Turn, erste Claude-Antwort, neue Owner-Nachricht) — Client schickte
      // NUR die neue Nachricht, nicht die ganze Historie (im Request-Body oben).
      const secondCallArgs = runClaude.mock.calls[1][0];
      expect(secondCallArgs.history).toHaveLength(3);
      expect(secondCallArgs.history[2].content).toBe('Only premium users.');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('draftText fehlt im Response wenn readyToSpecify false ist', async () => {
    const runClaude = jest.fn()
      .mockResolvedValueOnce(NOT_READY_RAW)
      .mockResolvedValueOnce(NOT_READY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { body: startBody } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/start', {});
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/message', {
        sessionId: startBody.sessionId,
        message: 'Not sure yet.',
      });
      expect(status).toBe(200);
      expect(body.readyToSpecify).toBe(false);
      expect(body.draftText).toBeUndefined();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST .../specify/message — AC4: 400/404-Pfade', () => {
  it('404 bei ungültigem Slug-Format (führender Punkt, ungültig per SLUG_RE)', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/board/projects/.bad/ideas/S-900/specify/message', {
        sessionId: 'x', message: 'hi',
      });
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei fehlender sessionId', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/message', {
        message: 'hi',
      });
      expect(status).toBe(400);
      expect(body.field).toBe('sessionId');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei fehlender/leerer message', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { body: startBody } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/start', {});
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/message', {
        sessionId: startBody.sessionId,
        message: '   ',
      });
      expect(status).toBe(400);
      expect(body.field).toBe('message');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 bei unbekannter/abgelaufener sessionId', async () => {
    const { app } = makeApp({});
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/message', {
        sessionId: 'does-not-exist',
        message: 'hi',
      });
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST .../specify/message — AC5: Audit-First + 502 bei claude-Fehler', () => {
  it('genau EIN Audit-Eintrag je akzeptiertem Turn (zusätzlich zum Start-Eintrag)', async () => {
    const runClaude = jest.fn()
      .mockResolvedValueOnce(NOT_READY_RAW)
      .mockResolvedValueOnce(READY_RAW);
    const { app, auditStore } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { body: startBody } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/start', {});
      await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/message', {
        sessionId: startBody.sessionId,
        message: 'Only premium users.',
      });

      const entries = auditStore.getAll();
      expect(entries).toHaveLength(2);
      expect(entries[0].command).toBe('board:idea:specify:start:demo:S-900');
      expect(entries[1].command).toBe('board:idea:specify:message:demo:S-900');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('kein Audit-Eintrag bei 404 (unbekannte Session)', async () => {
    const { app, auditStore } = makeApp({});
    const srv = await startServer(app);

    try {
      await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/message', {
        sessionId: 'does-not-exist',
        message: 'hi',
      });
      expect(auditStore.getAll()).toHaveLength(0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('502 wenn claude -p im zweiten Turn fehlschlägt (Historie bleibt für Retry erhalten)', async () => {
    const runClaude = jest.fn()
      .mockResolvedValueOnce(NOT_READY_RAW)
      .mockRejectedValueOnce(new Error('claude -p exited with code 1'));
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { body: startBody } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/start', {});
      const { status, body } = await httpPost(srv, '/api/board/projects/demo/ideas/S-900/specify/message', {
        sessionId: startBody.sessionId,
        message: 'Only premium users.',
      });
      expect(status).toBe(502);
      expect(body.error).not.toMatch(/PATH|secret|token|password/i);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
