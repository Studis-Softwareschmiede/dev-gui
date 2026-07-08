/**
 * @file regressionRunRouter.test.js — HTTP-level tests for the deterministic
 * Regressionstest-Ausführen endpoints (docs/specs/regression-run.md).
 *
 * Covers (regression-run): AC1, AC2, AC3, AC5, AC7, AC8, AC9
 *
 *   AC1 — POST /api/projects/:slug/regression-run { scope } → 202 { runId,
 *         status:"running" } startet den REALEN RegressionRunner (eigenes
 *         Lock) — kein claude-Bezug auf HTTP-Ebene (RegressionRunner.test.js
 *         deckt den Grep-Beweis "kein claude-Spawn" bereits ab).
 *   AC2 — Busy-Check: ein aktiver Drain (isProjectBusy via injizierten
 *         commandService/sessionRegistry/drainLock) ODER ein bereits
 *         laufender Regressionslauf desselben Projekts (runner.isRunning())
 *         → 409 { error: "busy" }; TOCTOU-frei (kein await dazwischen).
 *   AC3 — Access/Rolle: CRED_ADMIN_EMAILS gesetzt + anfragende Identität NICHT
 *         enthalten → 403; Audit-First — Audit-Write-Fehler → 500, KEIN
 *         Runner-Start; kein Secret in der Response.
 *   AC5 — (End-to-End über den Runner, hier nur die HTTP-Vertragsform):
 *         GET liefert `status`/`target`/`suite`/`counts`/`durationMs`/`reason`
 *         gemäß Vertrag; unbekannte runId → 404.
 *   AC7/AC8 — `freshRollout` (Body) wird 1:1 an `runner.start()`
 *         durchgereicht (`meta.freshRollout`); die eigentliche
 *         Rollout-/Selbsttest-Entscheidung lebt im RegressionRunner selbst
 *         (RegressionRunner.test.js AC7/AC8-Blöcke decken die Logik ab) —
 *         hier nur der HTTP-Vertrags-Durchreiche-Beweis (`runner.start`-Spy).
 *   AC9 — Ungültiger `scope` (fehlendes/unbekanntes typ, fehlende id bei
 *         bereich/verbund) → 400, KEIN Runner-Start.
 *
 * Pattern: express + node:http auf Port 0 (Muster regressionDefineRouter.test.js/
 * projectDrainRouter.test.js). Slug→Pfad-Auflösung über injizierte
 * `slugResolver`/`pathValidator`-Stubs (kein echtes Filesystem nötig).
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { regressionRunRouter } from '../src/regressionRunRouter.js';
import { RegressionRunner } from '../src/RegressionRunner.js';

// ── HTTP helpers (Muster regressionDefineRouter.test.js) ────────────────────

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
        res.on('data', (c) => { raw += c; });
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

function flush() {
  return new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
}

/** Default slugResolver: 'dev-gui' → '/workspace/dev-gui', alles andere → null. */
function makeSlugResolver(map = { 'dev-gui': '/workspace/dev-gui' }) {
  return (slug) => (Object.prototype.hasOwnProperty.call(map, slug) ? map[slug] : null);
}

/** Default pathValidator: identity — resolviert den übergebenen Pfad unverändert. */
function identityPathValidator() {
  return async (p) => ({ resolvedPath: p });
}

/** Baut eine App mit injiziertem Identity-Middleware-Stub (simuliert AccessGuard-Claim). */
function buildApp(router, identity = { email: 'owner@example.com' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });
  app.use(router);
  return app;
}

/** Ein RegressionRunner, der NIE terminiert (für Busy-/Lock-Tests). */
function makeHangingRunner() {
  const readFile = jest.fn(async (p) => {
    if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
    if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
    throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
  });
  return new RegressionRunner({ runPlaywright: () => new Promise(() => {}), readFile });
}

/** Ein RegressionRunner, der sofort grün terminiert. */
function makeGreenRunner() {
  const readFile = jest.fn(async (p) => {
    if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
    if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
    if (String(p).endsWith('test-results/ctrf-report.json')) {
      return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
    }
    throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
  });
  return new RegressionRunner({ runPlaywright: async () => ({ exitCode: 0 }), readFile });
}

describe('regressionRunRouter — regression-run.md', () => {
  // ── AC1: happy path ─────────────────────────────────────────────────────
  describe('AC1 — POST startet einen Lauf', () => {
    it('202 { runId, status: "running" } bei validem scope', async () => {
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(res.status).toBe(202);
        expect(res.body.status).toBe('running');
        expect(typeof res.body.runId).toBe('string');
        await flush();
      } finally {
        await closeServer(server);
      }
    });

    it('400 bei ungültigem/unresolvierbarem Slug', async () => {
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpPost(server, '/api/projects/unknown-repo/regression-run', { scope: { typ: 'gesamt' } });
        expect(res.status).toBe(400);
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── AC9: scope-Validierung ──────────────────────────────────────────────
  describe('AC9 — scope-Validierung', () => {
    it('400 bei fehlendem scope', async () => {
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpPost(server, '/api/projects/dev-gui/regression-run', {});
        expect(res.status).toBe(400);
      } finally {
        await closeServer(server);
      }
    });

    it('400 bei unbekanntem scope.typ', async () => {
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'unbekannt' } });
        expect(res.status).toBe(400);
      } finally {
        await closeServer(server);
      }
    });

    it('400 bei fehlender id für bereich/verbund', async () => {
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'bereich' } });
        expect(res.status).toBe(400);
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── AC2: Busy-Check ─────────────────────────────────────────────────────
  describe('AC2 — Busy-Check', () => {
    it('409 { error: "busy" } wenn ein Drain aktiv ist (commandService.getStatus().status === "running")', async () => {
      const runner = makeGreenRunner();
      const commandService = { getStatus: () => ({ status: 'running' }) };
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
        commandService,
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'busy' });
      } finally {
        await closeServer(server);
      }
    });

    it('409 wenn bereits ein Regressionslauf desselben Projekts läuft (RegressionRunner-eigenes Lock)', async () => {
      const runner = makeHangingRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        const first = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(first.status).toBe(202);

        const second = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(second.status).toBe(409);
        expect(second.body).toEqual({ error: 'busy' });
      } finally {
        await closeServer(server);
      }
    });

    it('ein Drain-Lauf eines ANDEREN Projekts blockiert dieses Projekt nicht', async () => {
      const runner = makeGreenRunner();
      const commandService = { getStatus: () => ({ status: null }) };
      const sessionRegistry = { hasSession: () => false };
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
        commandService,
        sessionRegistry,
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(res.status).toBe(202);
        await flush();
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── AC3: Access/Rolle + Audit-First ─────────────────────────────────────
  describe('AC3 — Identitäts-/Rollenschutz + Audit-First', () => {
    const originalAdminEmails = process.env.CRED_ADMIN_EMAILS;
    afterEach(() => {
      if (originalAdminEmails === undefined) delete process.env.CRED_ADMIN_EMAILS;
      else process.env.CRED_ADMIN_EMAILS = originalAdminEmails;
    });

    it('403 wenn CRED_ADMIN_EMAILS gesetzt ist und die Identität nicht enthalten ist', async () => {
      process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router, { email: 'nicht-admin@example.com' }));
      try {
        const res = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(res.status).toBe(403);
      } finally {
        await closeServer(server);
      }
    });

    it('202 wenn die Identität in CRED_ADMIN_EMAILS enthalten ist', async () => {
      process.env.CRED_ADMIN_EMAILS = 'owner@example.com,admin@example.com';
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router, { email: 'owner@example.com' }));
      try {
        const res = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(res.status).toBe(202);
        await flush();
      } finally {
        await closeServer(server);
      }
    });

    it('202 wenn CRED_ADMIN_EMAILS nicht gesetzt ist (Fail-Open, wie Schwester-Router)', async () => {
      delete process.env.CRED_ADMIN_EMAILS;
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(res.status).toBe(202);
        await flush();
      } finally {
        await closeServer(server);
      }
    });

    it('Audit-Write-Fehler -> 500, KEIN Runner-Start', async () => {
      const runner = makeGreenRunner();
      const startSpy = jest.spyOn(runner, 'start');
      const auditStore = { record: () => { throw new Error('audit down'); } };
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
        auditStore,
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(res.status).toBe(500);
        expect(startSpy).not.toHaveBeenCalled();
      } finally {
        await closeServer(server);
      }
    });

    it('genau EIN Audit-Eintrag je akzeptiertem Start, secret-frei (nur identity/command)', async () => {
      const runner = makeGreenRunner();
      const record = jest.fn();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
        auditStore: { record },
      });
      const server = await startServer(buildApp(router));
      try {
        await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(record).toHaveBeenCalledTimes(1);
        const entry = record.mock.calls[0][0];
        expect(entry.identity).toBe('owner@example.com');
        expect(entry.command).toMatch(/^regression-run:start:/);
        expect(JSON.stringify(entry)).not.toMatch(/token|secret|password/i);
        await flush();
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── AC7/AC8: freshRollout wird 1:1 an runner.start() durchgereicht ───────
  describe('AC7/AC8 — freshRollout-Durchreiche (Vertragsform)', () => {
    it('freshRollout:true im Body -> runner.start() wird mit meta.freshRollout:true aufgerufen', async () => {
      const runner = makeGreenRunner();
      const startSpy = jest.spyOn(runner, 'start');
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' }, freshRollout: true });
        expect(startSpy).toHaveBeenCalledWith(
          expect.any(String),
          'dev-gui',
          expect.any(Object),
          expect.objectContaining({ freshRollout: true }),
        );
        await flush();
      } finally {
        await closeServer(server);
      }
    });

    it('freshRollout fehlt im Body -> runner.start() erhält meta.freshRollout:false (Default)', async () => {
      const runner = makeGreenRunner();
      const startSpy = jest.spyOn(runner, 'start');
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        expect(startSpy).toHaveBeenCalledWith(
          expect.any(String),
          'dev-gui',
          expect.any(Object),
          expect.objectContaining({ freshRollout: false }),
        );
        await flush();
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── AC5 (Vertragsform): GET-Status ──────────────────────────────────────
  describe('AC5 — GET /api/projects/:slug/regression-run/:runId', () => {
    it('200 mit status/suite/counts/durationMs nach Abschluss', async () => {
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        const startRes = await httpPost(server, '/api/projects/dev-gui/regression-run', { scope: { typ: 'gesamt' } });
        const { runId } = startRes.body;
        await flush();

        const res = await httpGet(server, `/api/projects/dev-gui/regression-run/${runId}`);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('passed');
        expect(res.body.suite).toBe('Gesamt');
        expect(res.body.counts).toEqual({ passed: 1, failed: 0, total: 1 });
        expect(typeof res.body.durationMs).toBe('number');
        // secret-frei: keine internen Felder (projectPath/identity) in der Response.
        expect(res.body.projectPath).toBeUndefined();
        expect(res.body.identity).toBeUndefined();
      } finally {
        await closeServer(server);
      }
    });

    it('404 bei unbekannter runId', async () => {
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpGet(server, '/api/projects/dev-gui/regression-run/unknown-run-id');
        expect(res.status).toBe(404);
      } finally {
        await closeServer(server);
      }
    });

    it('400 bei ungültigem Slug', async () => {
      const runner = makeGreenRunner();
      const router = regressionRunRouter(runner, {
        slugResolver: makeSlugResolver(),
        pathValidator: identityPathValidator(),
      });
      const server = await startServer(buildApp(router));
      try {
        const res = await httpGet(server, '/api/projects/unknown-repo/regression-run/some-id');
        expect(res.status).toBe(400);
      } finally {
        await closeServer(server);
      }
    });
  });
});
