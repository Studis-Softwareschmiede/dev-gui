/**
 * @file regressionSuitesRouter.test.js — HTTP-level tests für die
 * Regressionstest-Suite-Liste (docs/specs/regression-run.md AC4, AC6).
 *
 * Covers (regression-run):
 *   AC4 — GET /api/projects/:slug/regression-suites → 200 { suites } mit
 *         `target` je Suite (Router-Ebene: reicht das Ergebnis des injizierten
 *         `suiteReader` unverändert durch, deckt Status/Body-Shape ab —
 *         RegressionSuiteReader.test.js deckt das Frontmatter-Parsing selbst).
 *   AC6 — `kosten`-Feld bei ephemeral-infra-Suiten kommt in der Response an.
 *
 * Zusätzlich (coder/R06 Minimal-Coverage neuer Endpunkte):
 *   - Validierungs-Fehler: ungültiger/unresolvierbarer Slug → 400.
 *   - Graceful-Fehler-Pfad: `suiteReader` wirft → 200 { suites: [] } (kein Crash).
 *
 * Pattern: express + node:http auf Port 0 (Muster regressionRunRouter.test.js).
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { regressionSuitesRouter } from '../src/regressionSuitesRouter.js';

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

function makeSlugResolver(map = { 'dev-gui': '/workspace/dev-gui' }) {
  return (slug) => (Object.prototype.hasOwnProperty.call(map, slug) ? map[slug] : null);
}

function identityPathValidator() {
  return async (p) => ({ resolvedPath: p });
}

function buildApp(router) {
  const app = express();
  app.use(router);
  return app;
}

describe('regressionSuitesRouter — regression-run.md', () => {
  describe('AC4 — GET liefert die Suite-Liste inkl. target', () => {
    it('200 { suites } mit target je Suite (Reader-Ergebnis unverändert durchgereicht)', async () => {
      const suiteReader = jest.fn(async () => ({
        suites: [
          { scope: { typ: 'bereich', id: 'board' }, label: 'board', target: 'local' },
          { scope: { typ: 'verbund' }, label: 'Verbund', target: 'ephemeral-infra', kosten: 'gering' },
          { scope: { typ: 'gesamt' }, label: 'Gesamt' },
        ],
      }));
      const router = regressionSuitesRouter({
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
        suiteReader,
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpGet(server, '/api/projects/dev-gui/regression-suites');
        expect(res.status).toBe(200);
        expect(res.body.suites).toHaveLength(3);
        expect(res.body.suites[0]).toEqual({ scope: { typ: 'bereich', id: 'board' }, label: 'board', target: 'local' });
        expect(suiteReader).toHaveBeenCalledWith('/workspace/dev-gui');
      } finally {
        await closeServer(server);
      }
    });

    it('400 bei ungültigem/unresolvierbarem Slug', async () => {
      const suiteReader = jest.fn(async () => ({ suites: [] }));
      const router = regressionSuitesRouter({
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
        suiteReader,
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpGet(server, '/api/projects/unknown-repo/regression-suites');
        expect(res.status).toBe(400);
        expect(suiteReader).not.toHaveBeenCalled();
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('AC6 — kosten-Hinweis bei ephemeral-infra kommt in der Response an', () => {
    it('kosten-Feld einer ephemeral-infra-Suite bleibt in der Response erhalten', async () => {
      const suiteReader = jest.fn(async () => ({
        suites: [
          { scope: { typ: 'verbund' }, label: 'Verbund', target: 'ephemeral-infra', kosten: 'hoch — 3 VMs' },
        ],
      }));
      const router = regressionSuitesRouter({
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
        suiteReader,
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpGet(server, '/api/projects/dev-gui/regression-suites');
        expect(res.status).toBe(200);
        expect(res.body.suites[0].kosten).toBe('hoch — 3 VMs');
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('Graceful-Fehler-Pfad', () => {
    it('suiteReader wirft → 200 { suites: [] } statt Crash', async () => {
      const suiteReader = jest.fn(async () => { throw new Error('fs kaputt'); });
      const router = regressionSuitesRouter({
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
        suiteReader,
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpGet(server, '/api/projects/dev-gui/regression-suites');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ suites: [] });
      } finally {
        await closeServer(server);
      }
    });
  });
});
