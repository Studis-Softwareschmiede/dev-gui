/**
 * @file redTeamRouter.test.js — HTTP-level tests für die Headless-Red-Team-Runner
 * Endpunkte (docs/specs/red-team-tile.md AC2, AC3, AC4, AC5, AC10).
 *
 * Deckt ab:
 *   AC2 — GET /api/red-team/targets → 200 { targets } (Allowlist-Schnittmenge
 *         VPS-laufend ∩ eigenes Repo): korrekte Schnittmenge; nicht-laufender
 *         Container zählt nicht; nicht-eigenes Repo zählt nicht; hostname-Match;
 *         ein psAll-Fehler eines Ziels kippt den Endpunkt nicht; leere Liste gültig.
 *   AC3 — POST /api/red-team { projectSlug, modus? } → 202 { jobId, status:"running" };
 *         leerer/fehlender Slug → 400; Traversal-Slug → 400; Ziel nicht in der
 *         Allowlist → 403 (Default deny); aktive Projekt-Sperre → 409.
 *   AC4 — GET /api/red-team/:jobId → 200 { status, result?, error?, prHint? };
 *         unbekannte jobId → 404.
 *   AC10 — Allowlist-Gate serverseitig; jobId = Korrelations-ID; keine Host-Pfade
 *         in der Response.
 *
 * Muster: express + node:http createServer auf Port 0 (127.0.0.1), kein supertest
 * (wie reconcileRouter.test.js). Injizierte Stubs für runner + Allowlist-Boundaries
 * (vpsDockerControl/vpsRegistry/vpsTargets/workspaceScanner) + pathValidator/slugResolver.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { redTeamRouter, imageRepoName } from '../src/redTeamRouter.js';
import { ProjectPathError } from '../src/workspacePath.js';

// ── HTTP-Hilfsfunktionen (Muster reconcileRouter.test.js) ─────────────────────

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

// ── Stubs ─────────────────────────────────────────────────────────────────────

const defaultSlugResolver = (slug) => (slug ? `/workspace/${slug}` : null);
const defaultPathValidator = async (p) => ({ resolvedPath: p });

/**
 * Minimaler Runner-Stub: start() sperrt pro projectPath (409 beim zweiten Start),
 * getJob() liefert seeded Jobs. Zeichnet start-Aufrufe für Assertions auf.
 */
function makeRunner() {
  const jobs = new Map();
  const locked = new Set();
  let seq = 0;
  return {
    startCalls: [],
    start(projectPath, opts) {
      this.startCalls.push({ projectPath, opts });
      if (locked.has(projectPath)) return { ok: false, reason: 'locked' };
      locked.add(projectPath);
      const jobId = `job-${++seq}`;
      jobs.set(jobId, { status: 'running' });
      return { ok: true, jobId };
    },
    getJob(id) {
      return jobs.has(id) ? jobs.get(id) : null;
    },
    seedJob(id, job) {
      jobs.set(id, job);
    },
  };
}

const runningContainer = (over = {}) => ({
  containerId: 'c1',
  image: 'ghcr.io/org/img:sha',
  hostname: null,
  state: 'running',
  status: 'Up 3 minutes',
  hostPort: 8080,
  ...over,
});

/**
 * Baut Allowlist-Deps, deren Schnittmenge genau `slug` enthält — via hostname-Match,
 * damit der exakte Slug unabhängig vom Image-Parsing in der Allowlist landet.
 */
function makeDepsAllowing(slug) {
  return {
    vpsTargets: new Map([['a', { host: '1.1.1.1', targetUser: 'root' }]]),
    vpsDockerControl: { psAll: async () => ({ result: 'ok', containers: [runningContainer({ hostname: slug })] }) },
    workspaceScanner: { listClones: async () => [{ name: slug }] },
  };
}

function makeApp({ runner, deps, pathValidator, slugResolver } = {}) {
  const app = express();
  app.use(express.json());
  const _runner = runner ?? makeRunner();
  app.use(redTeamRouter(_runner, deps ?? {}, { pathValidator, slugResolver }));
  return { app, runner: _runner };
}

// ── imageRepoName (exportiert, testbar) ───────────────────────────────────────

describe('imageRepoName — Image-Repo-Ableitung', () => {
  it('leitet das letzte Segment ohne Registry-Präfix und ohne :tag ab', () => {
    expect(imageRepoName('ghcr.io/org/dev-gui:sha')).toBe('dev-gui');
  });
  it('entfernt einen @digest', () => {
    expect(imageRepoName('ghcr.io/org/dev-gui@sha256:abc123')).toBe('dev-gui');
  });
  it('ignoriert einen Registry-Port im Präfix', () => {
    expect(imageRepoName('localhost:5000/foo/bar:latest')).toBe('bar');
  });
  it('akzeptiert einen nackten Namen', () => {
    expect(imageRepoName('dev-gui')).toBe('dev-gui');
  });
  it('leere/ungültige Eingabe → leerer String', () => {
    expect(imageRepoName('')).toBe('');
    expect(imageRepoName(undefined)).toBe('');
  });
});

// ── GET /api/red-team/targets — AC2 ───────────────────────────────────────────

describe('GET /api/red-team/targets — AC2: Allowlist-Schnittmenge', () => {
  it('liefert genau die Schnittmenge (Image-Repo-Match); Stopped/Fremd-Repo zählen nicht', async () => {
    const deps = {
      vpsTargets: new Map([['a', { host: '1.1.1.1', targetUser: 'root' }]]),
      vpsDockerControl: {
        psAll: async () => ({
          result: 'ok',
          containers: [
            runningContainer({ containerId: 'ok', image: 'ghcr.io/org/dev-gui:sha' }),   // laufend + eigenes Repo → zählt
            runningContainer({ containerId: 'stopped', image: 'ghcr.io/org/other:sha', state: 'exited' }), // nicht laufend
            runningContainer({ containerId: 'foreign', image: 'ghcr.io/org/not-mine:sha' }), // laufend, aber kein eigenes Repo
          ],
        }),
      },
      workspaceScanner: { listClones: async () => [{ name: 'dev-gui' }, { name: 'other' }, { name: 'idle-repo' }] },
    };
    const { app } = makeApp({ deps });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/red-team/targets');
      expect(status).toBe(200);
      expect(body.targets).toEqual([
        { slug: 'dev-gui', image: 'ghcr.io/org/dev-gui:sha', state: 'running', repo: 'dev-gui' },
      ]);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('matcht auch über den Container-hostname (nicht nur das Image)', async () => {
    const deps = {
      vpsTargets: new Map([['a', { host: '1.1.1.1', targetUser: 'root' }]]),
      vpsDockerControl: {
        psAll: async () => ({
          result: 'ok',
          containers: [runningContainer({ image: 'ghcr.io/org/anon:sha', hostname: 'host-repo' })],
        }),
      },
      workspaceScanner: { listClones: async () => [{ name: 'host-repo' }] },
    };
    const { app } = makeApp({ deps });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/red-team/targets');
      expect(status).toBe(200);
      expect(body.targets).toEqual([
        { slug: 'host-repo', image: 'ghcr.io/org/anon:sha', state: 'running', repo: 'host-repo' },
      ]);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ein fehlschlagendes psAll eines Ziels kippt den Endpunkt nicht (überspringen)', async () => {
    const deps = {
      vpsTargets: new Map([
        ['a', { host: '1.1.1.1', targetUser: 'root' }],
        ['b', { host: '2.2.2.2', targetUser: 'root' }],
      ]),
      vpsDockerControl: {
        psAll: async (target) => {
          if (target.host === '2.2.2.2') throw new Error('ssh down');
          return { result: 'ok', containers: [runningContainer({ image: 'ghcr.io/org/dev-gui:sha' })] };
        },
      },
      workspaceScanner: { listClones: async () => [{ name: 'dev-gui' }] },
    };
    const { app } = makeApp({ deps });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/red-team/targets');
      expect(status).toBe(200);
      expect(body.targets.map((t) => t.slug)).toEqual(['dev-gui']);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('leere Schnittmenge → 200 { targets: [] } (AC8, nichts autorisiert)', async () => {
    const deps = {
      vpsTargets: new Map([['a', { host: '1.1.1.1', targetUser: 'root' }]]),
      vpsDockerControl: { psAll: async () => ({ result: 'ok', containers: [] }) },
      workspaceScanner: { listClones: async () => [{ name: 'dev-gui' }] },
    };
    const { app } = makeApp({ deps });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/red-team/targets');
      expect(status).toBe(200);
      expect(body.targets).toEqual([]);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── POST /api/red-team — AC3 ──────────────────────────────────────────────────

describe('POST /api/red-team — AC3: happy path (202)', () => {
  it('202 { jobId, status:"running" } für ein gültiges Allowlist-Ziel; reicht ziel+modus an den Runner', async () => {
    const runner = makeRunner();
    const { app } = makeApp({ runner, deps: makeDepsAllowing('dev-gui'), slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/red-team', { projectSlug: 'dev-gui', modus: 'direkt' });
      expect(status).toBe(202);
      expect(typeof body.jobId).toBe('string');
      expect(body.status).toBe('running');
      expect(runner.startCalls).toHaveLength(1);
      expect(runner.startCalls[0].opts).toEqual({ ziel: 'dev-gui', modus: 'direkt' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ungültiger/fehlender modus → Default "beide"', async () => {
    const runner = makeRunner();
    const { app } = makeApp({ runner, deps: makeDepsAllowing('dev-gui'), slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/red-team', { projectSlug: 'dev-gui', modus: 'kaputt' });
      expect(status).toBe(202);
      expect(runner.startCalls[0].opts).toEqual({ ziel: 'dev-gui', modus: 'beide' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/red-team — AC3: 400 auf leeren/Traversal-Slug', () => {
  it('400 wenn projectSlug fehlt (stets projektgebunden, kein globaler Fallback)', async () => {
    const { app } = makeApp({ deps: makeDepsAllowing('dev-gui'), slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/red-team', {});
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 wenn projectSlug ein leerer String ist', async () => {
    const { app } = makeApp({ deps: makeDepsAllowing('dev-gui'), slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/red-team', { projectSlug: '   ' });
      expect(status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 wenn der slugResolver einen Traversal-Slug ablehnt (security/R02/R03)', async () => {
    // Der Traversal-Slug muss zuerst das Allowlist-Gate passieren (hostname-Match),
    // damit die Slug→Pfad-Auflösung (400) überhaupt erreicht wird.
    const throwingSlugResolver = () => {
      throw new ProjectPathError("Project slug must not contain '/'", 'outside-boundary');
    };
    const { app } = makeApp({ deps: makeDepsAllowing('../etc'), slugResolver: throwingSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/red-team', { projectSlug: '../etc' });
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 wenn der Boundary-Path-Validator den aufgelösten Pfad ablehnt (ausserhalb WORKSPACE_DIR)', async () => {
    const rejectingPathValidator = async () => {
      throw new ProjectPathError('outside boundary', 'outside-boundary');
    };
    const { app } = makeApp({ deps: makeDepsAllowing('evil'), slugResolver: defaultSlugResolver, pathValidator: rejectingPathValidator });
    const srv = await startServer(app);
    try {
      const { status } = await httpPost(srv, '/api/red-team', { projectSlug: 'evil' });
      expect(status).toBe(400);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/red-team — AC3/AC10: 403 auf Ziel ausserhalb der Allowlist (Default deny)', () => {
  it('403 wenn projectSlug nicht in der Allowlist-Schnittmenge liegt; Runner wird NICHT gestartet', async () => {
    const runner = makeRunner();
    const { app } = makeApp({ runner, deps: makeDepsAllowing('dev-gui'), slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpPost(srv, '/api/red-team', { projectSlug: 'ghost-repo' });
      expect(status).toBe(403);
      expect(typeof body.error).toBe('string');
      expect(runner.startCalls).toHaveLength(0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/red-team — AC3: 409 auf aktive Projekt-Sperre', () => {
  it('409 wenn bereits ein Red-Team-Job für DASSELBE Projekt läuft', async () => {
    const runner = makeRunner();
    const { app } = makeApp({ runner, deps: makeDepsAllowing('dev-gui'), slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);
    try {
      const first = await httpPost(srv, '/api/red-team', { projectSlug: 'dev-gui' });
      expect(first.status).toBe(202);
      const second = await httpPost(srv, '/api/red-team', { projectSlug: 'dev-gui' });
      expect(second.status).toBe(409);
      expect(typeof second.body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ── GET /api/red-team/:jobId — AC4 ────────────────────────────────────────────

describe('GET /api/red-team/:jobId — AC4: Status-Formen + unbekannte jobId', () => {
  it('200 { status:"running" } für einen frisch gestarteten Job', async () => {
    const runner = makeRunner();
    const { app } = makeApp({ runner, deps: makeDepsAllowing('dev-gui'), slugResolver: defaultSlugResolver, pathValidator: defaultPathValidator });
    const srv = await startServer(app);
    try {
      const { body: startBody } = await httpPost(srv, '/api/red-team', { projectSlug: 'dev-gui' });
      const { status, body } = await httpGet(srv, `/api/red-team/${startBody.jobId}`);
      expect(status).toBe(200);
      expect(body.status).toBe('running');
      expect(body.result).toBeUndefined();
      expect(body.error).toBeUndefined();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('200 { status:"done", prHint } für einen abgeschlossenen Job (Protokoll-PR)', async () => {
    const runner = makeRunner();
    runner.seedJob('done-1', { status: 'done', prHint: 'https://github.com/acme/repo/pull/9' });
    const { app } = makeApp({ runner, deps: makeDepsAllowing('dev-gui') });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/red-team/done-1');
      expect(status).toBe(200);
      expect(body.status).toBe('done');
      expect(body.prHint).toBe('https://github.com/acme/repo/pull/9');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('404 für eine unbekannte jobId', async () => {
    const { app } = makeApp({ deps: makeDepsAllowing('dev-gui') });
    const srv = await startServer(app);
    try {
      const { status, body } = await httpGet(srv, '/api/red-team/does-not-exist');
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
