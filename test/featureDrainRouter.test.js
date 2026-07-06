/**
 * featureDrainRouter.test.js — HTTP-/Router-Ebenen-Test für den
 * Feature-Umsetzen-Button (feature-umsetzen-button, Owner-Auftrag 2026-07-06).
 *
 * Covers:
 *   GET  .../batch — Zustandsableitung (ready/running/done) aus dem
 *        UNGEFILTERTEN Story-Bestand (echte Datei-Fixtures, kein Board-Filter).
 *   POST .../batch — 202 + Runner-Start bei ≥2 Storys, 400 bei <2 Storys,
 *        409 bei bereits laufendem Batch (Lock), 503 ohne agent-flow-Plugin.
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '../src/routers/featureDrain.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';

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

function writeStory(repoPath, id, parent, status) {
  writeFileSync(join(repoPath, 'board', 'stories', `${id}-x.yaml`), `id: ${id}\nparent: ${parent}\nstatus: ${status}\n`);
}

describe('GET/POST /api/board/projects/:slug/features/:featureId/batch', () => {
  let repoPath;

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  function makeApp({ running = false, pluginRoot = '/plugin' } = {}) {
    repoPath = mkdtempSync(join(tmpdir(), 'feature-drain-router-'));
    mkdirSync(join(repoPath, 'board', 'stories'), { recursive: true });

    const boardAggregator = {
      getIndex: async () => [{ slug: 'demo', repo_path: repoPath, features: [{ id: 'F-001' }] }],
    };
    const featureDrainRegistry = {
      isRunning: jest.fn(() => running),
      getJob: jest.fn(() => null),
    };
    const featureDrainRunner = { start: jest.fn() };
    const featureDrainLock = new ProjectJobLock();
    const agentFlowReader = { resolvePluginRoot: async () => pluginRoot };

    const app = express();
    app.use(express.json());
    app.use(create({ boardAggregator, featureDrainRegistry, featureDrainRunner, featureDrainLock, agentFlowReader }));
    return { app, featureDrainRunner, featureDrainLock, repoPath: () => repoPath };
  }

  it('GET: 0 Storys -> ready (Button ohnehin nicht gerendert)', async () => {
    const { app } = makeApp();
    const { status, body } = await request(app, 'GET', '/api/board/projects/demo/features/F-001/batch');
    expect(status).toBe(200);
    expect(body.state).toBe('ready');
  });

  it('GET: alle Storys terminal (Done/Verworfen) -> done', async () => {
    const { app, repoPath: rp } = makeApp();
    writeStory(rp(), 'S-001', 'F-001', 'Done');
    writeStory(rp(), 'S-002', 'F-001', 'Verworfen');
    const { body } = await request(app, 'GET', '/api/board/projects/demo/features/F-001/batch');
    expect(body.state).toBe('done');
  });

  it('GET: mindestens eine nicht-terminale Story -> ready', async () => {
    const { app, repoPath: rp } = makeApp();
    writeStory(rp(), 'S-001', 'F-001', 'Done');
    writeStory(rp(), 'S-002', 'F-001', 'To Do');
    const { body } = await request(app, 'GET', '/api/board/projects/demo/features/F-001/batch');
    expect(body.state).toBe('ready');
  });

  it('GET: laufender Batch -> running (unabhängig vom Story-Bestand)', async () => {
    const { app, repoPath: rp } = makeApp({ running: true });
    writeStory(rp(), 'S-001', 'F-001', 'Done');
    writeStory(rp(), 'S-002', 'F-001', 'Done');
    const { body } = await request(app, 'GET', '/api/board/projects/demo/features/F-001/batch');
    expect(body.state).toBe('running');
  });

  it('POST: <2 Storys -> 400, kein Runner-Start', async () => {
    const { app, repoPath: rp, featureDrainRunner } = makeApp();
    writeStory(rp(), 'S-001', 'F-001', 'To Do');
    const { status, body } = await request(app, 'POST', '/api/board/projects/demo/features/F-001/batch');
    expect(status).toBe(400);
    expect(body.error).toMatch(/weniger als 2/);
    expect(featureDrainRunner.start).not.toHaveBeenCalled();
  });

  it('POST: ≥2 Storys -> 202, Runner gestartet mit korrektem scriptsDir', async () => {
    const { app, repoPath: rp, featureDrainRunner } = makeApp({ pluginRoot: '/plugin-root' });
    writeStory(rp(), 'S-001', 'F-001', 'To Do');
    writeStory(rp(), 'S-002', 'F-001', 'To Do');
    const { status, body } = await request(app, 'POST', '/api/board/projects/demo/features/F-001/batch');
    expect(status).toBe(202);
    expect(body.state).toBe('running');
    expect(featureDrainRunner.start).toHaveBeenCalledWith(expect.objectContaining({
      projectSlug: 'demo', featureId: 'F-001', agentFlowScriptsDir: '/plugin-root/scripts',
    }));
  });

  it('POST: Lock bereits gehalten -> 409, kein zweiter Runner-Start', async () => {
    const { app, repoPath: rp, featureDrainRunner, featureDrainLock } = makeApp();
    writeStory(rp(), 'S-001', 'F-001', 'To Do');
    writeStory(rp(), 'S-002', 'F-001', 'To Do');
    featureDrainLock.tryAcquire('demo:F-001'); // extern schon gehalten simulieren
    const { status } = await request(app, 'POST', '/api/board/projects/demo/features/F-001/batch');
    expect(status).toBe(409);
    expect(featureDrainRunner.start).not.toHaveBeenCalled();
  });

  it('POST: kein agent-flow-Plugin gefunden -> 503, Lock wieder freigegeben', async () => {
    const { app, repoPath: rp, featureDrainRunner, featureDrainLock } = makeApp({ pluginRoot: null });
    writeStory(rp(), 'S-001', 'F-001', 'To Do');
    writeStory(rp(), 'S-002', 'F-001', 'To Do');
    const { status } = await request(app, 'POST', '/api/board/projects/demo/features/F-001/batch');
    expect(status).toBe(503);
    expect(featureDrainRunner.start).not.toHaveBeenCalled();
    expect(featureDrainLock.tryAcquire('demo:F-001')).toBe(true); // Lock wurde freigegeben
  });
});
