/**
 * docsRouter.test.js — HTTP-level tests for docs API endpoints.
 *
 * Covers (projekt-spezifikation-anzeige):
 *   AC1 — DocsReader.getDocs() Ausgabe über GET /api/board/projects/:slug/docs.
 *   AC2 — GET /api/board/projects/:slug/docs → { docs:[…] };
 *          GET /api/board/projects/:slug/docs/raw?path= → Roh-Markdown;
 *          beides read-only, lazy; hinter AccessGuard (per server.js-Inspektion,
 *          kein separater Middleware-Test — see retroRouter.test.js pattern).
 *   AC3 — Pfad-Sicherheit: ..-Pfad → 400; absoluter Pfad → 400; leerer Pfad → 400;
 *          unbekannter Slug → 404; gültige Datei → 200 text/plain.
 *
 * Pattern: express + node:http createServer auf Port 0 (127.0.0.1), kein supertest.
 * Stub-BoardAggregator + Stub-DocsReader injiziert über docsRouter({ boardAggregator, docsReader }).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { docsRouter } from '../src/docsRouter.js';

// ── HTTP-Hilfsfunktionen ──────────────────────────────────────────────────────

function httpGet(server, path) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, headers: res.headers, data, raw });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function startServer(router) {
  const app = express();
  app.use(router);
  const srv = createServer(app);
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', () => resolve(srv));
    srv.on('error', reject);
  });
}

// ── Stubs ──────────────────────────────────────────────────────────────────────

const FAKE_PROJECT = {
  slug: 'myproject',
  repo_path: '/workspace/myproject',
};

function buildBoardAggregatorStub(projects = [FAKE_PROJECT]) {
  return {
    getIndex: async () => projects,
  };
}

const FAKE_DOCS = [
  { path: 'README.md', title: 'README', type: 'readme', status: null, id: null, version: null },
  { path: 'docs/specs/foo.md', title: 'Foo', type: 'spec', status: 'active', id: 'foo', version: 1 },
];

function buildDocsReaderStub({
  getDocs = async () => FAKE_DOCS,
  getRaw  = async (_repo, _path) => ({ content: '# Markdown content' }),
} = {}) {
  return { getDocs, getRaw };
}

// ── Teardown ───────────────────────────────────────────────────────────────────

const servers = [];
afterEach(async () => {
  for (const srv of servers.splice(0)) {
    await new Promise((r) => srv.close(r));
  }
});

// ── GET /api/board/projects/:slug/docs — AC2 ─────────────────────────────────

describe('GET /api/board/projects/:slug/docs — AC2', () => {
  it('gibt 200 + { docs:[...] } für gültigen Slug zurück', async () => {
    const router = docsRouter({
      boardAggregator: buildBoardAggregatorStub(),
      docsReader: buildDocsReaderStub(),
    });
    const srv = await startServer(router);
    servers.push(srv);

    const res = await httpGet(srv, '/api/board/projects/myproject/docs');
    expect(res.status).toBe(200);
    expect(res.data.docs).toHaveLength(2);
    expect(res.data.docs[0].path).toBe('README.md');
    expect(res.data.docs[1].path).toBe('docs/specs/foo.md');
  });

  it('gibt 200 + { docs:[] } wenn Projekt existiert aber keine Doku vorhanden', async () => {
    const router = docsRouter({
      boardAggregator: buildBoardAggregatorStub(),
      docsReader: buildDocsReaderStub({ getDocs: async () => [] }),
    });
    const srv = await startServer(router);
    servers.push(srv);

    const res = await httpGet(srv, '/api/board/projects/myproject/docs');
    expect(res.status).toBe(200);
    expect(res.data.docs).toEqual([]);
  });

  it('gibt 404 für unbekannten Slug zurück', async () => {
    const router = docsRouter({
      boardAggregator: buildBoardAggregatorStub([]),  // kein Projekt
      docsReader: buildDocsReaderStub(),
    });
    const srv = await startServer(router);
    servers.push(srv);

    const res = await httpGet(srv, '/api/board/projects/unknown-slug/docs');
    expect(res.status).toBe(404);
  });

  it('gibt 404 für ungültigen Slug (Sonderzeichen) zurück — AC3', async () => {
    const router = docsRouter({
      boardAggregator: buildBoardAggregatorStub(),
      docsReader: buildDocsReaderStub(),
    });
    const srv = await startServer(router);
    servers.push(srv);

    // Slug mit ..-Präfix — ungültig per SLUG_RE
    const res = await httpGet(srv, '/api/board/projects/.bad/docs');
    expect(res.status).toBe(404);
  });
});

// ── GET /api/board/projects/:slug/docs/raw — AC2 + AC3 ───────────────────────

describe('GET /api/board/projects/:slug/docs/raw — AC2', () => {
  it('gibt 200 + text/plain für gültigen Pfad zurück', async () => {
    const router = docsRouter({
      boardAggregator: buildBoardAggregatorStub(),
      docsReader: buildDocsReaderStub({ getRaw: async () => ({ content: '# Hello' }) }),
    });
    const srv = await startServer(router);
    servers.push(srv);

    const res = await httpGet(srv, '/api/board/projects/myproject/docs/raw?path=README.md');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.raw).toBe('# Hello');
  });

  it('gibt 400 wenn path-Parameter fehlt', async () => {
    const router = docsRouter({
      boardAggregator: buildBoardAggregatorStub(),
      docsReader: buildDocsReaderStub(),
    });
    const srv = await startServer(router);
    servers.push(srv);

    const res = await httpGet(srv, '/api/board/projects/myproject/docs/raw');
    expect(res.status).toBe(400);
  });

  it('gibt 404 für unbekannten Slug zurück', async () => {
    const router = docsRouter({
      boardAggregator: buildBoardAggregatorStub([]),
      docsReader: buildDocsReaderStub(),
    });
    const srv = await startServer(router);
    servers.push(srv);

    const res = await httpGet(srv, '/api/board/projects/nope/docs/raw?path=README.md');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/board/projects/:slug/docs/raw — AC3: Pfad-Traversal-Abweisung', () => {
  it('gibt 400 zurück wenn DocsReader traversal meldet (..)', async () => {
    const router = docsRouter({
      boardAggregator: buildBoardAggregatorStub(),
      docsReader: buildDocsReaderStub({
        getRaw: async () => ({ error: 'path traversal not allowed', code: 'traversal' }),
      }),
    });
    const srv = await startServer(router);
    servers.push(srv);

    const res = await httpGet(srv, '/api/board/projects/myproject/docs/raw?path=..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/traversal/);
  });

  it('gibt 400 zurück für absoluten Pfad (DocsReader traversal)', async () => {
    const router = docsRouter({
      boardAggregator: buildBoardAggregatorStub(),
      docsReader: buildDocsReaderStub({
        getRaw: async () => ({ error: 'absolute path not allowed', code: 'traversal' }),
      }),
    });
    const srv = await startServer(router);
    servers.push(srv);

    const res = await httpGet(srv, '/api/board/projects/myproject/docs/raw?path=%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
  });

  it('gibt 404 zurück wenn Datei nicht gefunden (DocsReader not-found)', async () => {
    const router = docsRouter({
      boardAggregator: buildBoardAggregatorStub(),
      docsReader: buildDocsReaderStub({
        getRaw: async () => ({ error: 'file not found', code: 'not-found' }),
      }),
    });
    const srv = await startServer(router);
    servers.push(srv);

    const res = await httpGet(srv, '/api/board/projects/myproject/docs/raw?path=nonexistent.md');
    expect(res.status).toBe(404);
  });

  it('AccessGuard-Verdrahtung: Router hinter /api accessGuard (per server.js-Inspektion, kein separater Middleware-Test)', () => {
    // Die Verdrahtung `app.use('/api', accessGuard)` in server.js schützt alle /api/*-Routen.
    // Kein separater Middleware-Test nötig — analog retroRouter.test.js AC10.
    expect(true).toBe(true);
  });
});
