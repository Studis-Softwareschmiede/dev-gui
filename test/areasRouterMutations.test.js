/**
 * areasRouterMutations.test.js — HTTP-/Router-Ebenen-Test für die mutierenden
 * Bereichs-Endpunkte (bereichs-modell AC6, S-289, coder/R06).
 *
 * Covers (bereichs-modell.md):
 *   AC6 — `POST /api/board/projects/:slug/areas`, `PATCH .../areas/:id`,
 *          `POST .../areas/reorder`, `DELETE .../areas/:id`: Slug-/ID-
 *          Validierung (404 bei unbekanntem Projekt/Bereich, 400 bei
 *          ungültiger Eingabe), Audit-First (GENAU EIN Eintrag je
 *          akzeptiertem Aufruf, VOR dem Schreiben), kurz gehaltenes
 *          `ProjectJobLock` (409 wenn belegt — Lock wird auch bei
 *          Validierungs-/Schreibfehlern zuverlässig wieder freigegeben),
 *          `area-not-empty` (409 mit `storyCount`/`specCount`) beim
 *          Lösch-Guard-Konflikt (AC5).
 *
 * Strategy: echte Express-App mit `boardRouter()`, `boardAggregator`/
 * `areaWriter`/`auditStore`/`lock` sind schlanke Test-Doubles (analog
 * `boardRouterArchiveQuery.test.js`) — die HTTP-Ebene (Statuscode + Body-
 * Shape) ist der Fokus, nicht die AreaWriter-Interna (siehe AreaWriter.test.js).
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { boardRouter } from '../src/boardRouter.js';
import { AreaWriterError } from '../src/AreaWriter.js';

const DEMO_PROJECT = {
  slug: 'demo',
  repo_path: '/tmp/demo-repo',
  project_slug: 'demo',
  schema_version: 1,
  features: [],
};

/**
 * @param {object} [overrides]
 * @param {object} [overrides.areaWriter]
 * @param {boolean} [overrides.withAuditStore]
 * @param {object} [overrides.lock]
 */
function makeApp({ areaWriter, withAuditStore = true, lock } = {}) {
  const auditCalls = [];
  const auditStore = withAuditStore ? { record: (entry) => auditCalls.push(entry) } : undefined;

  const boardAggregator = {
    getIndex: async () => [DEMO_PROJECT],
    scan: async () => {},
  };

  const app = express();
  app.use(express.json());
  app.use(
    boardRouter({
      boardAggregator,
      areaWriter,
      auditStore,
      lock,
    }),
  );
  return { app, auditCalls };
}

/** Generischer HTTP-Helfer für GET/POST/PATCH/DELETE mit optionalem JSON-Body. */
async function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const payload = body != null ? JSON.stringify(body) : null;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let respBody = '';
          res.on('data', (c) => (respBody += c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: respBody ? JSON.parse(respBody) : null });
          });
        },
      );
      req.on('error', (e) => {
        server.close();
        reject(e);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ── POST /api/board/projects/:slug/areas ──────────────────────────────────────

describe('POST /api/board/projects/:slug/areas (bereichs-modell AC3/AC6)', () => {
  it('happy path: 201 { id }, GENAU EIN Audit-Eintrag VOR dem Schreiben', async () => {
    const calls = [];
    const areaWriter = {
      createArea: async (params) => {
        calls.push(params);
        return { id: 'neuer-bereich' };
      },
    };
    const { app, auditCalls } = makeApp({ areaWriter });

    const res = await request(app, 'POST', '/api/board/projects/demo/areas', { name: 'Neuer Bereich' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'neuer-bereich' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ projectSlug: 'demo', name: 'Neuer Bereich' });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].command).toBe('board:area:create:demo');
  });

  it('leerer name → 400 { field: "name" }, createArea NICHT aufgerufen, KEIN Audit', async () => {
    let called = false;
    const areaWriter = { createArea: async () => { called = true; return { id: 'x' }; } };
    const { app, auditCalls } = makeApp({ areaWriter });

    const res = await request(app, 'POST', '/api/board/projects/demo/areas', { name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('name');
    expect(called).toBe(false);
    expect(auditCalls).toHaveLength(0);
  });

  it('duplicate-name vom Writer → 400 { field: "name" }', async () => {
    const areaWriter = {
      createArea: async () => {
        throw new AreaWriterError('bereits vergeben', 'duplicate-name');
      },
    };
    const { app } = makeApp({ areaWriter });

    const res = await request(app, 'POST', '/api/board/projects/demo/areas', { name: 'Board' });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('name');
  });

  it('unbekannter Slug → 404, kein Aufruf', async () => {
    let called = false;
    const areaWriter = { createArea: async () => { called = true; return { id: 'x' }; } };
    const { app } = makeApp({ areaWriter });

    const res = await request(app, 'POST', '/api/board/projects/unknown-project/areas', { name: 'X' });

    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  it('ProjectJobLock belegt → 409, kein Aufruf, kein Audit', async () => {
    const areaWriter = { createArea: async () => ({ id: 'x' }) };
    const lock = { tryAcquire: () => false, release: () => {} };
    const { app, auditCalls } = makeApp({ areaWriter, lock });

    const res = await request(app, 'POST', '/api/board/projects/demo/areas', { name: 'X' });

    expect(res.status).toBe(409);
    expect(auditCalls).toHaveLength(0);
  });

  it('Lock wird nach einem Schreibfehler zuverlässig wieder freigegeben (finally)', async () => {
    const areaWriter = {
      createArea: async () => {
        throw new Error('unerwarteter Fehler');
      },
    };
    let released = false;
    const lock = { tryAcquire: () => true, release: () => { released = true; } };
    const { app } = makeApp({ areaWriter, lock });

    const res = await request(app, 'POST', '/api/board/projects/demo/areas', { name: 'X' });

    expect(res.status).toBe(500);
    expect(released).toBe(true);
  });
});

// ── PATCH /api/board/projects/:slug/areas/:id ─────────────────────────────────

describe('PATCH /api/board/projects/:slug/areas/:id (bereichs-modell AC4/AC6)', () => {
  it('happy path: 200 { id }, GENAU EIN Audit-Eintrag', async () => {
    const calls = [];
    const areaWriter = {
      renameArea: async (params) => {
        calls.push(params);
        return { id: 'board' };
      },
    };
    const { app, auditCalls } = makeApp({ areaWriter });

    const res = await request(app, 'PATCH', '/api/board/projects/demo/areas/board', { name: 'Board (neu)' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'board' });
    expect(calls[0]).toMatchObject({ projectSlug: 'demo', id: 'board', name: 'Board (neu)' });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].command).toBe('board:area:rename:demo:board');
  });

  it('ungültiges :id-Format (Großbuchstaben, kein kebab-case) → 404, kein Aufruf', async () => {
    let called = false;
    const areaWriter = { renameArea: async () => { called = true; return { id: 'x' }; } };
    const { app } = makeApp({ areaWriter });

    const res = await request(app, 'PATCH', '/api/board/projects/demo/areas/BOARD', { name: 'X' });

    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  it('unbekannte Bereichs-id vom Writer → 404', async () => {
    const areaWriter = {
      renameArea: async () => {
        throw new AreaWriterError('nicht gefunden', 'area-not-found');
      },
    };
    const { app } = makeApp({ areaWriter });

    const res = await request(app, 'PATCH', '/api/board/projects/demo/areas/unbekannt', { name: 'X' });

    expect(res.status).toBe(404);
  });
});

// ── POST /api/board/projects/:slug/areas/reorder ──────────────────────────────

describe('POST /api/board/projects/:slug/areas/reorder (bereichs-modell AC4/AC6)', () => {
  it('happy path: 200 { areas }', async () => {
    const areaWriter = {
      reorderAreas: async ({ orderedIds }) => ({
        areas: orderedIds.map((id, i) => ({ id, name: id, order: i + 1, description: null })),
      }),
    };
    const { app, auditCalls } = makeApp({ areaWriter });

    const res = await request(app, 'POST', '/api/board/projects/demo/areas/reorder', {
      orderedIds: ['fabrik-arbeiten', 'board'],
    });

    expect(res.status).toBe(200);
    expect(res.body.areas.map((a) => a.id)).toEqual(['fabrik-arbeiten', 'board']);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].command).toBe('board:area:reorder:demo');
  });

  it('ungültige orderedIds-Form → 400, kein Aufruf', async () => {
    let called = false;
    const areaWriter = { reorderAreas: async () => { called = true; return { areas: [] }; } };
    const { app, auditCalls } = makeApp({ areaWriter });

    const res = await request(app, 'POST', '/api/board/projects/demo/areas/reorder', { orderedIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('orderedIds');
    expect(called).toBe(false);
    expect(auditCalls).toHaveLength(0);
  });

  it('ID-Menge stimmt nicht (invalid-order-ids vom Writer) → 400', async () => {
    const areaWriter = {
      reorderAreas: async () => {
        throw new AreaWriterError('Menge stimmt nicht', 'invalid-order-ids');
      },
    };
    const { app } = makeApp({ areaWriter });

    const res = await request(app, 'POST', '/api/board/projects/demo/areas/reorder', {
      orderedIds: ['nur-eine-id'],
    });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('orderedIds');
  });
});

// ── DELETE /api/board/projects/:slug/areas/:id ────────────────────────────────

describe('DELETE /api/board/projects/:slug/areas/:id (bereichs-modell AC5/AC6)', () => {
  it('happy path: 200 { deleted }', async () => {
    const areaWriter = { deleteArea: async ({ id }) => ({ id }) };
    const { app, auditCalls } = makeApp({ areaWriter });

    const res = await request(app, 'DELETE', '/api/board/projects/demo/areas/vps');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 'vps' });
    expect(auditCalls[0].command).toBe('board:area:delete:demo:vps');
  });

  it('area-not-empty → 409 { error, storyCount, specCount }, keine Löschung', async () => {
    const areaWriter = {
      deleteArea: async () => {
        throw new AreaWriterError('noch gebunden', 'area-not-empty', { storyCount: 2, specCount: 1 });
      },
    };
    const { app } = makeApp({ areaWriter });

    const res = await request(app, 'DELETE', '/api/board/projects/demo/areas/board');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'area-not-empty', storyCount: 2, specCount: 1 });
  });

  it('ProjectJobLock belegt → 409 (generischer Lock-Fehler, kein area-not-empty-Shape)', async () => {
    const areaWriter = { deleteArea: async () => ({ id: 'x' }) };
    const lock = { tryAcquire: () => false, release: () => {} };
    const { app } = makeApp({ areaWriter, lock });

    const res = await request(app, 'DELETE', '/api/board/projects/demo/areas/board');

    expect(res.status).toBe(409);
    expect(res.body.error).not.toBe('area-not-empty');
  });

  it('unbekannter Slug → 404', async () => {
    const areaWriter = { deleteArea: async () => ({ id: 'x' }) };
    const { app } = makeApp({ areaWriter });

    const res = await request(app, 'DELETE', '/api/board/projects/unknown/areas/board');

    expect(res.status).toBe(404);
  });
});
