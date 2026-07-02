/**
 * drainReports.test.js — HTTP-Ebenen-Tests für GET /api/drain-reports
 * (docs/specs/drain-completion-report.md AC4).
 *
 * Covers (drain-completion-report):
 *   AC4 — GET /api/drain-reports → 200 { reports: [...] } (die vom Store
 *          gelieferten Berichte, absteigend nach finishedAt); optional
 *          `?project=<slug>` filtert (an den Store durchgereicht). Ein
 *          ungültiger/traversierender `?project`-Wert → 200 { reports: [] }
 *          OHNE Store-/Dateizugriff (list() wird NICHT aufgerufen). Kein
 *          verdrahteter Store → 200 { reports: [] } (defensiv). Ein werfender
 *          Store → 500 { error } (secret-/pfad-frei). Der DrainReportStore
 *          selbst ist unit-getestet in test/DrainReportStore.test.js; der
 *          globale AccessGuard auf /api/* ist server.js-seitig (nicht Teil des
 *          Router-Moduls, analog tickerSettings.test.js).
 *
 * Strategy: echter Express-App + echter HTTP-Server (Muster tickerSettings.test.js)
 * mit einem Fake-drainReportStore (jest.fn) — kein echtes fs/CRED_STORE_DIR nötig.
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer, request as httpRequest } from 'node:http';
import { create } from '../src/routers/drainReports.js';

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

const SAMPLE = [
  { reportId: 'r2', project: 'proj-a', trigger: 'night', startedAt: '2026-07-02T22:00:00.000Z', finishedAt: '2026-07-02T22:30:00.000Z', reason: 'no-drain-target', flowRuns: 2, completed: [{ id: 'S-1', title: 'Eins' }], blocked: [] },
  { reportId: 'r1', project: 'proj-b', trigger: 'manual', startedAt: '2026-07-02T20:00:00.000Z', finishedAt: '2026-07-02T20:10:00.000Z', reason: 'no-drain-target', flowRuns: 0, completed: [], blocked: [{ id: 'S-9', title: 'Neun' }] },
];

describe('GET /api/drain-reports (AC4)', () => {
  it('200 { reports } — liefert die Store-Berichte', async () => {
    const drainReportStore = { list: jest.fn(async () => SAMPLE) };
    await withServer({ drainReportStore }, async (port) => {
      const res = await httpGet(port, '/api/drain-reports');
      expect(res.status).toBe(200);
      expect(res.body.reports).toHaveLength(2);
      expect(res.body.reports[0].reportId).toBe('r2');
      expect(drainReportStore.list).toHaveBeenCalledWith({});
    });
  });

  it('?project=<slug> reicht den Filter an den Store durch', async () => {
    const drainReportStore = { list: jest.fn(async () => [SAMPLE[0]]) };
    await withServer({ drainReportStore }, async (port) => {
      const res = await httpGet(port, '/api/drain-reports?project=proj-a');
      expect(res.status).toBe(200);
      expect(res.body.reports).toHaveLength(1);
      expect(drainReportStore.list).toHaveBeenCalledWith({ project: 'proj-a' });
    });
  });

  it('ungültiger/traversierender ?project → 200 { reports: [] } OHNE Store-Zugriff', async () => {
    const drainReportStore = { list: jest.fn(async () => SAMPLE) };
    await withServer({ drainReportStore }, async (port) => {
      for (const bad of ['..%2Fetc', 'a/b', 'a b']) {
        const res = await httpGet(port, '/api/drain-reports?project=' + encodeURIComponent(decodeURIComponent(bad)));
        expect(res.status).toBe(200);
        expect(res.body.reports).toEqual([]);
      }
      expect(drainReportStore.list).not.toHaveBeenCalled();
    });
  });

  it('kein verdrahteter Store → 200 { reports: [] } (defensiv)', async () => {
    await withServer({}, async (port) => {
      const res = await httpGet(port, '/api/drain-reports');
      expect(res.status).toBe(200);
      expect(res.body.reports).toEqual([]);
    });
  });

  it('werfender Store → 500 { error } (secret-/pfad-frei)', async () => {
    const drainReportStore = { list: jest.fn(async () => { throw new Error('/secret/path kaputt'); }) };
    await withServer({ drainReportStore }, async (port) => {
      const res = await httpGet(port, '/api/drain-reports');
      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
      expect(JSON.stringify(res.body)).not.toContain('/secret/');
    });
  });
});
