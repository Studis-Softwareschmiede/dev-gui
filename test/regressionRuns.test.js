/**
 * regressionRuns.test.js — HTTP-Ebenen-Tests für
 * GET /api/projects/:slug/regression-runs[/:runId]
 * (docs/specs/regression-result-store.md AC4).
 *
 * Covers (regression-result-store):
 *   AC4 — GET /api/projects/:slug/regression-runs → 200 { runs: [...] }
 *          (Store-Liste, absteigend nach startedAt, OHNE `ctrf`-Feld in der
 *          Listen-Response — Details liefert der Einzel-Lauf-Endpunkt).
 *          GET /api/projects/:slug/regression-runs/:runId → 200 { run } inkl.
 *          `ctrf` (Testfall-Details) + `artifacts` bei roten Läufen, oder
 *          404 { error } wenn nicht gefunden. Kein verdrahteter Store →
 *          200 { runs: [] } bzw. 404 (defensiv). Ein werfender Store →
 *          500 { error } (secret-/pfad-frei). Der RegressionResultStore
 *          selbst ist unit-getestet in test/RegressionResultStore.test.js;
 *          der globale AccessGuard auf /api/* ist server.js-seitig (nicht
 *          Teil des Router-Moduls, analog drainReports.test.js).
 *
 * Strategy: echter Express-App + echter HTTP-Server (Muster drainReports.test.js)
 * mit einem Fake-regressionResultStore (jest.fn) — kein echtes fs/CRED_STORE_DIR nötig.
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer, request as httpRequest } from 'node:http';
import { create } from '../src/routers/regressionRuns.js';

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(deps, fn) {
  const app = express();
  app.use(create(deps));
  const { server, port } = await startServer(app);
  try {
    return await fn(port);
  } finally {
    await closeServer(server);
  }
}

const SAMPLE_RUN = {
  runId: 'run-2',
  projekt: 'proj-a',
  suite: 'checkout',
  scopeTyp: 'bereich',
  status: 'failed',
  startedAt: '2026-07-02T22:00:00.000Z',
  durationMs: 5000,
  counts: { passed: 8, failed: 2, total: 10 },
  ctrf: { results: { tests: [{ name: 'a', status: 'failed' }] } },
  artifacts: { htmlReport: 'report.html', traces: 'traces.zip' },
};
const SAMPLE_RUN_2 = {
  runId: 'run-1',
  projekt: 'proj-a',
  suite: 'checkout',
  scopeTyp: 'bereich',
  status: 'passed',
  startedAt: '2026-07-02T20:00:00.000Z',
  durationMs: 3000,
  counts: { passed: 10, failed: 0, total: 10 },
  ctrf: { results: { tests: [{ name: 'a', status: 'passed' }] } },
};

describe('GET /api/projects/:slug/regression-runs (AC4)', () => {
  it('200 { runs } — liefert die Store-Liste OHNE ctrf-Feld', async () => {
    const regressionResultStore = { list: jest.fn(async () => [SAMPLE_RUN, SAMPLE_RUN_2]) };
    await withServer({ regressionResultStore }, async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs');
      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);
      expect(res.body.runs[0].runId).toBe('run-2');
      expect(res.body.runs[0].ctrf).toBeUndefined();
      expect(res.body.runs[0].artifacts).toEqual(SAMPLE_RUN.artifacts);
      expect(regressionResultStore.list).toHaveBeenCalledWith('proj-a');
    });
  });

  it('kein verdrahteter Store → 200 { runs: [] } (defensiv)', async () => {
    await withServer({}, async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs');
      expect(res.status).toBe(200);
      expect(res.body.runs).toEqual([]);
    });
  });

  it('werfender Store → 500 { error } (secret-/pfad-frei)', async () => {
    const regressionResultStore = { list: jest.fn(async () => { throw new Error('/secret/path kaputt'); }) };
    await withServer({ regressionResultStore }, async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs');
      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
      expect(JSON.stringify(res.body)).not.toContain('/secret/');
    });
  });

  it('leere Liste vom Store → 200 { runs: [] }', async () => {
    const regressionResultStore = { list: jest.fn(async () => []) };
    await withServer({ regressionResultStore }, async (port) => {
      const res = await httpGet(port, '/api/projects/unbekannt/regression-runs');
      expect(res.status).toBe(200);
      expect(res.body.runs).toEqual([]);
    });
  });
});

describe('GET /api/projects/:slug/regression-runs/:runId (AC4)', () => {
  it('200 { run } — liefert den Einzel-Lauf inkl. ctrf + artifacts (rot)', async () => {
    const regressionResultStore = { get: jest.fn(async () => SAMPLE_RUN) };
    await withServer({ regressionResultStore }, async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-2');
      expect(res.status).toBe(200);
      expect(res.body.run.runId).toBe('run-2');
      expect(res.body.run.ctrf).toEqual(SAMPLE_RUN.ctrf);
      expect(res.body.run.artifacts).toEqual(SAMPLE_RUN.artifacts);
      expect(regressionResultStore.get).toHaveBeenCalledWith('proj-a', 'run-2');
    });
  });

  it('200 { run } — grüner Lauf ohne artifacts-Feld', async () => {
    const regressionResultStore = { get: jest.fn(async () => SAMPLE_RUN_2) };
    await withServer({ regressionResultStore }, async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-1');
      expect(res.status).toBe(200);
      expect(res.body.run.status).toBe('passed');
      expect(res.body.run.artifacts).toBeUndefined();
    });
  });

  it('404 { error } wenn der Store null liefert (Lauf nicht gefunden)', async () => {
    const regressionResultStore = { get: jest.fn(async () => null) };
    await withServer({ regressionResultStore }, async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/unknown');
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  it('kein verdrahteter Store → 404 { error } (defensiv)', async () => {
    await withServer({}, async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-1');
      expect(res.status).toBe(404);
    });
  });

  it('werfender Store → 500 { error } (secret-/pfad-frei)', async () => {
    const regressionResultStore = { get: jest.fn(async () => { throw new Error('/secret/path kaputt'); }) };
    await withServer({ regressionResultStore }, async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-1');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('/secret/');
    });
  });
});
