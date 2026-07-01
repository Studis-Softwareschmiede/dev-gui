/**
 * @file costModeCheckRouter.test.js — HTTP-Level-Test des Status-Endpunkts der
 * Cost-Mode-Modellprüfung (docs/specs/cost-mode-model-check.md AC7).
 *
 * Covers (cost-mode-model-check): AC7 (Status-Endpunkt)
 *
 *   AC7 — GET /api/cost-mode/check/:checkId → 200 { status, changed?, before?, after? }
 *         (secret-/pfad-frei aus der Registry); unbekannte checkId → 404.
 *
 * Ebenen-Test (coder/R06): der Pfad Router → CostModeModelCheck-Registry →
 * Response wird auf HTTP-Ebene abgedeckt (Status-Code + Body-Shape), nicht nur
 * der Registry-Getter. Es wird die ECHTE CostModeModelCheck-Instanz verwendet,
 * über einen `runCheck()`-Drift-Zyklus befüllt; der `flowRunner` ist ein Stub
 * (kein echter `claude -p`-Lauf).
 *
 * Muster: express + node:http createServer auf Port 0 (127.0.0.1), kein
 * supertest — analog reconcileRouter.test.js.
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { costModeCheckRouter } from '../src/costModeCheckRouter.js';
import { CostModeModelCheck } from '../src/CostModeModelCheck.js';

const JUNE_CONTENT = '# model-tiers\n\n> **last_curated:** 2026-06-10 — x\n';
const JULY_CONTENT = '# model-tiers\n\n> **last_curated:** 2026-07-01 — x\n';
const NOW_JULY = () => new Date('2026-07-15T12:00:00Z');

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

function makeReadFile(contents) {
  let i = 0;
  return jest.fn(async () => {
    const c = contents[Math.min(i, contents.length - 1)];
    i++;
    return c;
  });
}

function makeFakeRunner(terminalStatus = 'done') {
  let jobId = null;
  return {
    start() { jobId = 'job-1'; return { ok: true, jobId }; },
    getJob(id) { return id === jobId ? { status: terminalStatus } : undefined; },
  };
}

function makeCheck(contents, terminalStatus = 'done') {
  return new CostModeModelCheck({
    pluginRootResolver: async () => '/fake/plugin/root',
    flowRunner: makeFakeRunner(terminalStatus),
    curatorCwd: '/fake/cwd',
    fsDeps: { readFile: makeReadFile(contents) },
    now: NOW_JULY,
    sleepFn: async () => {},
    pollIntervalMs: 1,
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {},
  });
}

function makeApp(costModeModelCheck) {
  const app = express();
  app.use(costModeCheckRouter(costModeModelCheck));
  return app;
}

describe('GET /api/cost-mode/check/:checkId — AC7', () => {
  it('200 { status:"done", changed, before, after } nach einem Drift-Zyklus', async () => {
    const check = makeCheck([JUNE_CONTENT, JULY_CONTENT], 'done');
    const res = await check.runCheck('periodic');
    await res.done;

    const srv = await startServer(makeApp(check));
    try {
      const { status, body } = await httpGet(srv, `/api/cost-mode/check/${res.checkId}`);
      expect(status).toBe(200);
      expect(body.status).toBe('done');
      expect(body.changed).toBe(true);
      expect(body.before).toEqual({ lastCurated: '2026-06-10' });
      expect(body.after).toEqual({ lastCurated: '2026-07-01' });
      // Secret-/pfad-frei: keine absoluten Pfade im Body.
      expect(JSON.stringify(body)).not.toMatch(/\/fake\//);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('200 { status:"failed" } wenn der Curator-Lauf fehlschlägt (nicht-blockierend)', async () => {
    const check = makeCheck([JUNE_CONTENT], 'failed');
    const res = await check.runCheck('periodic');
    await res.done;

    const srv = await startServer(makeApp(check));
    try {
      const { status, body } = await httpGet(srv, `/api/cost-mode/check/${res.checkId}`);
      expect(status).toBe(200);
      expect(body.status).toBe('failed');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 für eine unbekannte checkId', async () => {
    const check = makeCheck([JULY_CONTENT], 'done');
    const srv = await startServer(makeApp(check));
    try {
      const { status, body } = await httpGet(srv, '/api/cost-mode/check/does-not-exist');
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
