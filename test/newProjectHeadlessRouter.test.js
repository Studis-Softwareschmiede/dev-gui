/**
 * @file newProjectHeadlessRouter.test.js — HTTP-level tests for the headless
 * Anlage-Auslöser der Fabrik-Übersicht (docs/specs/per-app-gpg-passphrase-
 * provisioning.md AC12–AC15, F-073/S-343).
 *
 * Covers (per-app-gpg-passphrase-provisioning.md):
 *   AC12 — POST /api/new-project/start und POST /api/adopt/start rufen die
 *          jeweiligen headless-Runner auf (kein PTY-`CommandService`-Import,
 *          s. AC14-Test unten).
 *   AC13 — POST /api/new-project/start validiert den App-Slug (Zeichensatz/
 *          Länge) VOR dem Aufruf des Runners; der validierte Slug wird
 *          UNVERÄNDERT als `app` UND als einziges argv-Element an
 *          `runWithAutoProvisioning` gereicht (Runner erhält denselben Slug).
 *   AC14 — Struktur-Regressionsschutz: `newProjectHeadlessRouter.js` importiert
 *          weder `PtyManager` noch `PtySessionRegistry` noch `CommandService`
 *          (der bestehende `/api/command`-Pfad bleibt unangetastet).
 *   AC15 — Ein erfolgreicher new-project-Lauf löst GENAU EINEN
 *          `runWithAutoProvisioning`-Aufruf aus (fire-and-forget aus HTTP-
 *          Sicht — 202 wartet nicht auf den Abschluss); dieser Test prüft die
 *          Aufruf-Ebene (Router → Runner), die interne Erfolg/Fehlschlag-
 *          Provisionierungs-Semantik ist bereits in
 *          `test/HeadlessNewProjectRunner.test.js` (S-336) verifiziert.
 *
 * Adopt-Pfad (AC12/AC14): eigener, einfacherer Endpunkt ohne
 * Provisionierungs-Kopplung (s. Modul-Header `newProjectHeadlessRouter.js`).
 *
 * Authz: Muster `deploymentsRouterGpgProvision.test.js` — `req.identity` wird
 * direkt injiziert (AccessGuard sitzt in server.js, kein separater Middleware-
 * Test hier).
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newProjectHeadlessRouter } from '../src/newProjectHeadlessRouter.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../');

function startServer(app) {
  return new Promise((res) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}
function closeServer(server) {
  return new Promise((r) => server.close(r));
}
function httpPost(port, path, body) {
  return new Promise((resolvePromise, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let j = null;
          try { j = raw ? JSON.parse(raw) : null; } catch { /* */ }
          resolvePromise({ status: res.statusCode, body: j });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let ctx;
let prevAdmin;

beforeEach(() => {
  prevAdmin = process.env.CRED_ADMIN_EMAILS;
  delete process.env.CRED_ADMIN_EMAILS;
});
afterEach(async () => {
  if (ctx?.server) await closeServer(ctx.server);
  ctx = null;
  if (prevAdmin === undefined) delete process.env.CRED_ADMIN_EMAILS;
  else process.env.CRED_ADMIN_EMAILS = prevAdmin;
});

function build({
  identityEmail = 'a@b.ch',
  newProjectRunner,
  adoptRunner,
  workspaceRoot = '/workspace',
  statOk = true,
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.identity = identityEmail ? { email: identityEmail } : null; next(); });

  const workspaceRootResolver = jest.fn(async () => ({ path: workspaceRoot, source: 'env-default' }));
  const statFn = jest.fn(async () => {
    if (!statOk) throw new Error('ENOENT');
    return { isDirectory: () => true };
  });

  app.use(newProjectHeadlessRouter(newProjectRunner, adoptRunner, { workspaceRootResolver, statFn }));
  return { app, workspaceRootResolver, statFn };
}

async function serve(parts) {
  const { server, port } = await startServer(parts.app);
  ctx = { server, port, ...parts };
  return ctx;
}

// ── POST /api/new-project/start ──────────────────────────────────────────────

describe('POST /api/new-project/start — AC12/AC13/AC15', () => {
  it('AC13: valid slug → 202, runWithAutoProvisioning called ONCE with the SAME slug (app + argv)', async () => {
    const runWithAutoProvisioning = jest.fn(async () => ({ result: 'created' }));
    const parts = build({ newProjectRunner: { runWithAutoProvisioning } });
    const { port } = await serve(parts);

    const { status, body } = await httpPost(port, '/api/new-project/start', { app: 'mein-neues-projekt' });
    expect(status).toBe(202);
    expect(body.status).toBe('started');

    await new Promise((r) => setImmediate(r));
    expect(runWithAutoProvisioning).toHaveBeenCalledTimes(1);
    const [slugArg, projectPathArg, opts] = runWithAutoProvisioning.mock.calls[0];
    expect(slugArg).toBe('mein-neues-projekt');
    expect(projectPathArg).toBe('/workspace');
    expect(opts.args).toEqual(['mein-neues-projekt']);
  });

  it('AC13: invalid slug (Zeichensatz) → 400, runWithAutoProvisioning NICHT aufgerufen', async () => {
    const runWithAutoProvisioning = jest.fn(async () => ({ result: 'created' }));
    const parts = build({ newProjectRunner: { runWithAutoProvisioning } });
    const { port } = await serve(parts);

    const { status, body } = await httpPost(port, '/api/new-project/start', { app: 'invalid slug!' });
    expect(status).toBe(400);
    expect(typeof body.error).toBe('string');
    expect(runWithAutoProvisioning).not.toHaveBeenCalled();
  });

  it('missing app → 400, kein Aufruf', async () => {
    const runWithAutoProvisioning = jest.fn();
    const parts = build({ newProjectRunner: { runWithAutoProvisioning } });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/new-project/start', {});
    expect(status).toBe(400);
    expect(runWithAutoProvisioning).not.toHaveBeenCalled();
  });

  it('AC10-Muster: ohne Berechtigung (CRED_ADMIN_EMAILS gesetzt, Identität nicht gelistet) → 403, kein Aufruf', async () => {
    process.env.CRED_ADMIN_EMAILS = 'other@b.ch';
    const runWithAutoProvisioning = jest.fn();
    const parts = build({ identityEmail: 'a@b.ch', newProjectRunner: { runWithAutoProvisioning } });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/new-project/start', { app: 'mein-projekt' });
    expect(status).toBe(403);
    expect(runWithAutoProvisioning).not.toHaveBeenCalled();
  });

  it('Workspace-Root nicht erreichbar (statFn wirft) → 503, kein Aufruf', async () => {
    const runWithAutoProvisioning = jest.fn();
    const parts = build({ newProjectRunner: { runWithAutoProvisioning }, statOk: false });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/new-project/start', { app: 'mein-projekt' });
    expect(status).toBe(503);
    expect(runWithAutoProvisioning).not.toHaveBeenCalled();
  });

  it('Runner nicht konfiguriert (undefined) → 503', async () => {
    const parts = build({ newProjectRunner: undefined });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/new-project/start', { app: 'mein-projekt' });
    expect(status).toBe(503);
  });

  it('AC15: fire-and-forget — 202 kommt zurück BEVOR runWithAutoProvisioning aufgelöst ist (kein Blockieren)', async () => {
    let releaseRun;
    const runWithAutoProvisioning = jest.fn(
      () => new Promise((resolvePromise) => { releaseRun = resolvePromise; }),
    );
    const parts = build({ newProjectRunner: { runWithAutoProvisioning } });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/new-project/start', { app: 'mein-projekt' });
    expect(status).toBe(202); // Antwort kam, obwohl der Runner-Promise noch nicht aufgelöst ist.
    expect(runWithAutoProvisioning).toHaveBeenCalledTimes(1);

    releaseRun({ result: 'created' }); // cleanup — verhindert eine offene Promise-Chain im Test
    await new Promise((r) => setImmediate(r));
  });

  it('ein rejecteter runWithAutoProvisioning-Aufruf crasht die Antwort NICHT (bereits versendet) und wirft keine unhandled rejection', async () => {
    const runWithAutoProvisioning = jest.fn(async () => { throw new Error('scaffold failed'); });
    const parts = build({ newProjectRunner: { runWithAutoProvisioning } });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/new-project/start', { app: 'mein-projekt' });
    expect(status).toBe(202);
    await new Promise((r) => setImmediate(r));
  });
});

// ── POST /api/adopt/start ─────────────────────────────────────────────────────

describe('POST /api/adopt/start — AC12/AC14', () => {
  it('valid ownerRepo → 202 { status:"started", jobId }, adoptRunner.start called with args=[ownerRepo]', async () => {
    const start = jest.fn(() => ({ ok: true, jobId: 'job-1' }));
    const parts = build({ adoptRunner: { start } });
    const { port } = await serve(parts);

    const { status, body } = await httpPost(port, '/api/adopt/start', { ownerRepo: 'acme/some-repo' });
    expect(status).toBe(202);
    expect(body.status).toBe('started');
    expect(body.jobId).toBe('job-1');
    expect(start).toHaveBeenCalledWith('/workspace', { args: ['acme/some-repo'] });
  });

  it('invalid ownerRepo (kein Schrägstrich) → 400, kein Aufruf', async () => {
    const start = jest.fn();
    const parts = build({ adoptRunner: { start } });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/adopt/start', { ownerRepo: 'not-a-valid-form' });
    expect(status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it('SSH-Form (git@github.com:owner/repo.git) → 400 (nur https-owner/repo-Form akzeptiert)', async () => {
    const start = jest.fn();
    const parts = build({ adoptRunner: { start } });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/adopt/start', { ownerRepo: 'git@github.com:owner/repo.git' });
    expect(status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it('Repo-Segment mit führendem Punkt/Traversal (acme/..evil) → 400, kein Aufruf', async () => {
    const start = jest.fn();
    const parts = build({ adoptRunner: { start } });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/adopt/start', { ownerRepo: 'acme/..evil' });
    expect(status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it('locked (bereits ein Adopt-Lauf) → 409', async () => {
    const start = jest.fn(() => ({ ok: false, reason: 'locked' }));
    const parts = build({ adoptRunner: { start } });
    const { port } = await serve(parts);

    const { status, body } = await httpPost(port, '/api/adopt/start', { ownerRepo: 'acme/some-repo' });
    expect(status).toBe(409);
    expect(typeof body.error).toBe('string');
  });

  it('ohne Berechtigung (CRED_ADMIN_EMAILS) → 403, kein Aufruf', async () => {
    process.env.CRED_ADMIN_EMAILS = 'other@b.ch';
    const start = jest.fn();
    const parts = build({ identityEmail: 'a@b.ch', adoptRunner: { start } });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/adopt/start', { ownerRepo: 'acme/some-repo' });
    expect(status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it('Runner nicht konfiguriert (undefined) → 503', async () => {
    const parts = build({ adoptRunner: undefined });
    const { port } = await serve(parts);

    const { status } = await httpPost(port, '/api/adopt/start', { ownerRepo: 'acme/some-repo' });
    expect(status).toBe(503);
  });
});

describe('newProjectHeadlessRouter.js — AC14: separated from the interactive PTY path', () => {
  it('does not import PtyManager, PtySessionRegistry, or CommandService', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/newProjectHeadlessRouter.js'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/PtyManager\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/PtySessionRegistry\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/CommandService\.js['"]/);
  });
});
