/**
 * repoSizeRouter.test.js — HTTP-/Router-Ebenen-Test für repo-size-badge AC4–AC8 (S-298).
 *
 * Covers:
 *   AC4 — GET /api/workspace/repo-sizes antwortet sofort mit letztem bekannten Wert,
 *         wartet nie auf einen laufenden/nie gelaufenen Scan.
 *   AC5 — Dedup: zweiter Refresh-Trigger während eines laufenden Scans ist No-op
 *         (kein zweiter Scan-Aufruf), Scan-Fehler lässt übrige Klone unberührt.
 *   AC6 — Read-Endpunkt-Shape { sizes: [{ repo, total, git, artifacts, workspace,
 *         measuredAt, gitWarning }] }, ?repo-Filter.
 *   AC7 — Refresh-Endpunkt: 202 bei bekanntem Slug, 404 bei unbekanntem/ungültigem
 *         Slug (regression coder/R03-Vorfall 2026-07-06 — .path statt Resolver-
 *         Objekt selbst), 400 ohne repo-Feld.
 *   AC8 — gitWarning-Flag gegen GIT_SIZE_WARN_MB (Default 500 MB).
 *
 * @jest-environment node
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { create } from '../src/routers/repoSize.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

async function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }); });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (data) req.write(data);
      req.end();
    });
  });
}

function makeApp({ sizes = new Map(), scanImpl, resolverPath = '/tmp/ws' } = {}) {
  const scanCalls = [];
  const repoSizeStore = {
    list: async () => sizes,
    record: async () => {},
  };
  const repoSizeScanner = {
    scan: scanImpl ?? (async (slug) => { scanCalls.push(slug); return { total: 100, git: 10, artifacts: 20, workspace: 70 }; }),
  };
  // Bewusst identisch zum echten resolveWorkspaceRoot()-Vertrag: { path, source }.
  const resolveWorkspaceRoot = async () => ({ path: resolverPath, source: 'env-default' });
  const app = express();
  app.use(express.json());
  app.use(create({
    repoSizeScanner,
    repoSizeStore,
    resolveWorkspaceRoot,
    repoSizeRefreshLock: new ProjectJobLock(),
  }));
  return { app, scanCalls };
}

describe('GET /api/workspace/repo-sizes (AC4/AC6/AC8)', () => {
  it('liefert sofort die letzten bekannten Werte (AC4/AC6)', async () => {
    const sizes = new Map([['dev-gui', { total: 1000, git: 100, artifacts: 200, workspace: 700, measuredAt: '2026-07-06T10:00:00Z' }]]);
    const { app } = makeApp({ sizes });
    const { status, body } = await request(app, 'GET', '/api/workspace/repo-sizes');
    expect(status).toBe(200);
    expect(body.sizes).toEqual([
      { repo: 'dev-gui', total: 1000, git: 100, artifacts: 200, workspace: 700, measuredAt: '2026-07-06T10:00:00Z', gitWarning: false },
    ]);
  });

  it('?repo-Filter liefert nur den passenden Eintrag, unbekannter Slug leeres Array', async () => {
    const sizes = new Map([['a', { total: 1, git: 0, artifacts: 0, workspace: 1, measuredAt: null }]]);
    const { app } = makeApp({ sizes });
    const hit = await request(app, 'GET', '/api/workspace/repo-sizes?repo=a');
    expect(hit.body.sizes).toHaveLength(1);
    const miss = await request(app, 'GET', '/api/workspace/repo-sizes?repo=unbekannt');
    expect(miss.body.sizes).toEqual([]);
  });

  it('AC8 — gitWarning true, wenn git-Bucket die (konfigurierbare) Grenze überschreitet', async () => {
    const sizes = new Map([['big-git', { total: 600 * 1024 * 1024, git: 600 * 1024 * 1024, artifacts: 0, workspace: 0, measuredAt: null }]]);
    const { app } = makeApp({ sizes });
    const { body } = await request(app, 'GET', '/api/workspace/repo-sizes');
    expect(body.sizes[0].gitWarning).toBe(true);
  });
});

describe('POST /api/workspace/repo-sizes/refresh (AC5/AC7)', () => {
  let workspaceRoot;

  afterEach(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('202 + startet Scan bei existierendem Klon (Fix: resolver.path statt Resolver-Objekt selbst)', async () => {
    workspaceRoot = mkdtempSync(pathJoin(tmpdir(), 'repo-size-router-'));
    mkdirSync(pathJoin(workspaceRoot, 'dev-gui'));
    const { app, scanCalls } = makeApp({ resolverPath: workspaceRoot });
    const { status, body } = await request(app, 'POST', '/api/workspace/repo-sizes/refresh', { repo: 'dev-gui' });
    expect(status).toBe(202);
    expect(body.status).toBe('scanning');
    await new Promise((r) => setTimeout(r, 20)); // fire-and-forget abwarten
    expect(scanCalls).toEqual(['dev-gui']);
  });

  it('404 bei unbekanntem Klon-Slug — kein Scan gestartet', async () => {
    workspaceRoot = mkdtempSync(pathJoin(tmpdir(), 'repo-size-router-'));
    const { app, scanCalls } = makeApp({ resolverPath: workspaceRoot });
    const { status } = await request(app, 'POST', '/api/workspace/repo-sizes/refresh', { repo: 'nicht-vorhanden' });
    expect(status).toBe(404);
    await new Promise((r) => setTimeout(r, 20));
    expect(scanCalls).toEqual([]);
  });

  it('400 ohne repo-Feld', async () => {
    const { app } = makeApp();
    const { status } = await request(app, 'POST', '/api/workspace/repo-sizes/refresh', {});
    expect(status).toBe(400);
  });

  it('AC5 — Dedup: zweiter Trigger während laufendem Scan startet keinen zweiten Scan', async () => {
    workspaceRoot = mkdtempSync(pathJoin(tmpdir(), 'repo-size-router-'));
    mkdirSync(pathJoin(workspaceRoot, 'dev-gui'));
    let resolveScan;
    const scanImpl = async (slug) => {
      scanCallsHolder.push(slug);
      await new Promise((r) => { resolveScan = r; });
      return { total: 1, git: 0, artifacts: 0, workspace: 1 };
    };
    var scanCallsHolder = [];
    const { app } = makeApp({ resolverPath: workspaceRoot, scanImpl });
    const first = await request(app, 'POST', '/api/workspace/repo-sizes/refresh', { repo: 'dev-gui' });
    expect(first.status).toBe(202);
    const second = await request(app, 'POST', '/api/workspace/repo-sizes/refresh', { repo: 'dev-gui' });
    expect(second.status).toBe(202); // AC5: kein Fehler, koalesziert
    resolveScan();
    await new Promise((r) => setTimeout(r, 20));
    expect(scanCallsHolder).toEqual(['dev-gui']); // nur EIN tatsächlicher Scan
  });
});
