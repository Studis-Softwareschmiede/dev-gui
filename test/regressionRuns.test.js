/**
 * regressionRuns.test.js — HTTP-Ebenen-Tests für
 * GET /api/projects/:slug/regression-runs[/:runId] und den
 * Debug-Artefakt-Zugriff (docs/specs/regression-result-store.md AC4,
 * docs/specs/regression-result-view.md AC2).
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
 * Covers (regression-result-view):
 *   AC2 — GET /api/projects/:slug/regression-runs/:runId/artifacts/*splat:
 *          nur bei `status:"failed"` verfügbar (grüner/unbekannter Lauf →
 *          404, kein Leak); dient eine Datei INNERHALB der Artefakt-Ablage
 *          des Laufs aus (200 + Bytes); Path-Traversal (`..` im Wildcard-Rest,
 *          manipulierter `artifacts.htmlReport`-String) UND Symlink-Ausbruch
 *          aus der Ablage → 404 (kein Escape). Slug-Auflösung über
 *          injizierte `slugResolver`/`pathValidator`-Stubs (Muster
 *          regressionRunRouter.test.js) — echtes Dateisystem nur für die
 *          Artefakt-Ablage selbst (mkdtemp, Muster AreaWriter.test.js).
 *
 * Strategy: echter Express-App + echter HTTP-Server (Muster drainReports.test.js)
 * mit einem Fake-regressionResultStore (jest.fn) — kein echtes fs/CRED_STORE_DIR nötig
 * für die Liste-/Einzel-Lauf-Endpunkte; der Artefakt-Block nutzt ein echtes
 * `mkdtemp`-Temp-Verzeichnis als "Projekt-Klon" (kein echter WORKSPACE_DIR nötig).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// ── AC2 (regression-result-view): Debug-Artefakt-Zugriff ────────────────────

describe('GET /api/projects/:slug/regression-runs/:runId/artifacts/*splat (regression-result-view AC2)', () => {
  let projectDir;

  /** Default slugResolver/pathValidator: 'proj-a' -> der Temp-"Projekt-Klon". */
  function makeDeps(regressionResultStore) {
    return {
      regressionResultStore,
      slugResolver: (slug) => (slug === 'proj-a' ? projectDir : null),
      pathValidator: async (p) => ({ resolvedPath: p }),
    };
  }

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'regression-artifact-test-'));
    await mkdir(join(projectDir, 'playwright-report'), { recursive: true });
    await writeFile(join(projectDir, 'playwright-report', 'index.html'), '<html>report</html>', 'utf8');
    await mkdir(join(projectDir, 'playwright-report', 'data'), { recursive: true });
    await writeFile(join(projectDir, 'playwright-report', 'data', 'trace.zip'), 'zip-bytes', 'utf8');
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  const RED_RUN = {
    runId: 'run-red',
    projekt: 'proj-a',
    status: 'failed',
    artifacts: { htmlReport: 'playwright-report' },
  };
  const GREEN_RUN = {
    runId: 'run-green',
    projekt: 'proj-a',
    status: 'passed',
  };

  it('200 + Datei-Bytes für index.html eines roten Laufs', async () => {
    const regressionResultStore = { get: jest.fn(async () => RED_RUN) };
    await withServer(makeDeps(regressionResultStore), async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-red/artifacts/index.html');
      expect(res.status).toBe(200);
      expect(String(res.body)).toContain('report');
    });
  });

  it('200 + Datei-Bytes für eine verschachtelte Datei (Trace) eines roten Laufs', async () => {
    const regressionResultStore = { get: jest.fn(async () => RED_RUN) };
    await withServer(makeDeps(regressionResultStore), async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-red/artifacts/data/trace.zip');
      expect(res.status).toBe(200);
      expect(String(res.body)).toContain('zip-bytes');
    });
  });

  it('404 bei grünem Lauf (kein Artefakt, kein toter Link)', async () => {
    const regressionResultStore = { get: jest.fn(async () => GREEN_RUN) };
    await withServer(makeDeps(regressionResultStore), async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-green/artifacts/index.html');
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  it('404 bei unbekanntem/geprunten Lauf (Store liefert null)', async () => {
    const regressionResultStore = { get: jest.fn(async () => null) };
    await withServer(makeDeps(regressionResultStore), async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/unknown/artifacts/index.html');
      expect(res.status).toBe(404);
    });
  });

  it('kein verdrahteter Store → 404 (defensiv)', async () => {
    await withServer(makeDeps(undefined), async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-red/artifacts/index.html');
      expect(res.status).toBe(404);
    });
  });

  it('404 bei ungültigem Slug (slugResolver liefert null)', async () => {
    const regressionResultStore = { get: jest.fn(async () => RED_RUN) };
    await withServer(
      { regressionResultStore, slugResolver: () => null, pathValidator: async (p) => ({ resolvedPath: p }) },
      async (port) => {
        const res = await httpGet(port, '/api/projects/andere-projekt/regression-runs/run-red/artifacts/index.html');
        expect(res.status).toBe(404);
      },
    );
  });

  it('404 bei fehlendem artifacts.htmlReport im Lauf-Datensatz', async () => {
    const regressionResultStore = {
      get: jest.fn(async () => ({ runId: 'run-red', projekt: 'proj-a', status: 'failed' })),
    };
    await withServer(makeDeps(regressionResultStore), async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-red/artifacts/index.html');
      expect(res.status).toBe(404);
    });
  });

  it('404 bei Path-Traversal im Wildcard-Rest-Pfad (`..`-Segmente)', async () => {
    // Ein geheimes Secret AUSSERHALB der Artefakt-Ablage, das per Traversal
    // erreichbar wäre, wenn der Endpunkt den `..`-Rest-Pfad nicht härtet.
    await writeFile(join(projectDir, 'secret.txt'), 'top-secret', 'utf8');
    const regressionResultStore = { get: jest.fn(async () => RED_RUN) };
    await withServer(makeDeps(regressionResultStore), async (port) => {
      const res = await httpGet(
        port,
        '/api/projects/proj-a/regression-runs/run-red/artifacts/..%2f..%2fsecret.txt',
      );
      expect(res.status).toBe(404);
      expect(String(res.body)).not.toContain('top-secret');
    });
  });

  it('404 bei manipuliertem artifacts.htmlReport, der aus dem Projekt-Klon ausbricht (`../../etc`)', async () => {
    const regressionResultStore = {
      get: jest.fn(async () => ({
        runId: 'run-red',
        projekt: 'proj-a',
        status: 'failed',
        artifacts: { htmlReport: '../../etc' },
      })),
    };
    await withServer(makeDeps(regressionResultStore), async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-red/artifacts/passwd');
      expect(res.status).toBe(404);
    });
  });

  it('404 bei Symlink-Ausbruch aus der Artefakt-Ablage heraus', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'regression-artifact-outside-'));
    await writeFile(join(outsideDir, 'secret.txt'), 'top-secret-symlink', 'utf8');
    const linkPath = join(projectDir, 'playwright-report', 'escape-link');
    await symlink(outsideDir, linkPath, 'dir');

    const regressionResultStore = { get: jest.fn(async () => RED_RUN) };
    try {
      await withServer(makeDeps(regressionResultStore), async (port) => {
        const res = await httpGet(
          port,
          '/api/projects/proj-a/regression-runs/run-red/artifacts/escape-link/secret.txt',
        );
        expect(res.status).toBe(404);
        expect(String(res.body)).not.toContain('top-secret-symlink');
      });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('404 wenn die Artefakt-Datei nicht (mehr) existiert', async () => {
    const regressionResultStore = { get: jest.fn(async () => RED_RUN) };
    await withServer(makeDeps(regressionResultStore), async (port) => {
      const res = await httpGet(port, '/api/projects/proj-a/regression-runs/run-red/artifacts/nicht-vorhanden.html');
      expect(res.status).toBe(404);
    });
  });
});
