/**
 * deploymentsRouterGpgExists.test.js — HTTP-Ebene für die read-only Existenz-
 * Abfrage (per-app-gpg-passphrase-provisioning.md, F-073/S-373 AC16).
 *
 * Covers:
 *   AC16 — GET /api/deployments/:app/gpg-exists hinter CRED_ADMIN_EMAILS
 *          (AccessGuard sitzt in server.js, siehe Covers-Note unten); ohne
 *          Berechtigung → 403, KEIN Aufruf des Provisionierungsdienstes (kein bw).
 *          Vorhandenes Item → 200 { exists: true }. Fehlendes Item → 200
 *          { exists: false }. Zugang nicht ready → 200 { exists: false,
 *          reason: 'access-not-ready' }. Response enthält nie einen
 *          Passphrasen-Wert (nur exists/reason).
 *   400  — app-Parameter mit ungültigen Zeichen → 400, kein Dienst-Aufruf.
 *   503  — Dienst nicht konfiguriert (kein perAppGpgProvisioningService injiziert)
 *          bzw. Dienst ohne itemExistsFor-Methode (Rückwärtskompatibilität).
 *
 * AC9-Analogie — AccessGuard-Verdrahtung: per server.js-Inspektion (app.use('/api',
 * accessGuard) vor mountRouters()), kein separater Middleware-Test hier (Muster
 * deploymentsRouterGpgProvision.test.js).
 *
 * Real-HTTP (nicht nur router.stack[...].handle(mockReq, mockRes)) — Muster
 * deploymentsRouterGpgProvision.test.js (S-335).
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { deploymentsRouter } from '../src/deploymentsRouter.js';

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function closeServer(server) { return new Promise((r) => server.close(r)); }
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => { let j = null; try { j = raw ? JSON.parse(raw) : null; } catch { /* */ } resolve({ status: res.statusCode, body: j, raw }); });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let ctx;
let prevAdmin;

function build({ existsResult, existsImpl, service, identityEmail = 'a@b.ch' } = {}) {
  const orchestrator = { deploy: jest.fn() };
  const auditRecord = jest.fn();
  const itemExistsFor = existsImpl ?? jest.fn(async () => existsResult ?? { exists: false });
  const perAppGpgProvisioningService = service === null ? undefined : (service ?? { itemExistsFor });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.identity = identityEmail ? { email: identityEmail } : null; next(); });
  app.use(deploymentsRouter(
    orchestrator, { record: auditRecord }, new Map(),
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, perAppGpgProvisioningService,
  ));
  return { orchestrator, auditRecord, itemExistsFor, app };
}

async function serve(parts) {
  const { server, port } = await startServer(parts.app);
  ctx = { server, port, ...parts };
  return ctx;
}

beforeEach(() => { prevAdmin = process.env.CRED_ADMIN_EMAILS; delete process.env.CRED_ADMIN_EMAILS; });
afterEach(async () => {
  if (ctx?.server) await closeServer(ctx.server);
  ctx = null;
  if (prevAdmin === undefined) delete process.env.CRED_ADMIN_EMAILS; else process.env.CRED_ADMIN_EMAILS = prevAdmin;
});

describe('deploymentsRouter — GET /:app/gpg-exists (F-073/S-373 AC16)', () => {
  it('AC16: ohne Berechtigung (nicht in CRED_ADMIN_EMAILS) → 403, KEIN Dienst-Aufruf', async () => {
    process.env.CRED_ADMIN_EMAILS = 'other@b.ch';
    const parts = build({ identityEmail: 'a@b.ch' });
    await serve(parts);

    const r = await httpGet(ctx.port, '/api/deployments/myapp/gpg-exists');

    expect(r.status).toBe(403);
    expect(parts.itemExistsFor).not.toHaveBeenCalled();
  });

  it('AC16: vorhandenes Item → 200 { exists: true }', async () => {
    const parts = build({ existsResult: { exists: true } });
    await serve(parts);

    const r = await httpGet(ctx.port, '/api/deployments/myapp/gpg-exists');

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ exists: true });
    expect(parts.itemExistsFor).toHaveBeenCalledWith('myapp', { identity: 'a@b.ch' });
  });

  it('AC16: fehlendes Item → 200 { exists: false }', async () => {
    const parts = build({ existsResult: { exists: false } });
    await serve(parts);

    const r = await httpGet(ctx.port, '/api/deployments/other-app/gpg-exists');

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ exists: false });
  });

  it('AC16: Zugang nicht ready → 200 { exists: false, reason: "access-not-ready" }, kein Raten', async () => {
    const parts = build({ existsResult: { exists: false, reason: 'access-not-ready' } });
    await serve(parts);

    const r = await httpGet(ctx.port, '/api/deployments/myapp/gpg-exists');

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ exists: false, reason: 'access-not-ready' });
  });

  it('400: ungültiger app-Parameter (Shell-Metazeichen) → 400, kein Dienst-Aufruf', async () => {
    const parts = build({});
    await serve(parts);

    const r = await httpGet(ctx.port, '/api/deployments/my%3Bapp/gpg-exists');

    expect(r.status).toBe(400);
    expect(parts.itemExistsFor).not.toHaveBeenCalled();
  });

  it('503: Dienst nicht konfiguriert → 503, kein Crash', async () => {
    const parts = build({ service: null });
    await serve(parts);

    const r = await httpGet(ctx.port, '/api/deployments/myapp/gpg-exists');

    expect(r.status).toBe(503);
    expect(r.body.exists).toBe(false);
  });

  it('503: Dienst ohne itemExistsFor-Methode (z.B. veraltetes Double) → 503, kein Crash', async () => {
    const parts = build({ service: { provision: jest.fn() } });
    await serve(parts);

    const r = await httpGet(ctx.port, '/api/deployments/myapp/gpg-exists');

    expect(r.status).toBe(503);
    expect(r.body.exists).toBe(false);
  });

  it('AC16: Response enthält nie einen freien Passphrasen-artigen Wert (nur exists/reason)', async () => {
    const parts = build({ existsResult: { exists: true } });
    await serve(parts);

    const r = await httpGet(ctx.port, '/api/deployments/myapp/gpg-exists');

    expect(Object.keys(r.body).sort()).toEqual(['exists']);
  });

  it('kein Mutations-Nebeneffekt: orchestrator.deploy wird nie aufgerufen (read-only)', async () => {
    const parts = build({ existsResult: { exists: false } });
    await serve(parts);

    await httpGet(ctx.port, '/api/deployments/myapp/gpg-exists');

    expect(parts.orchestrator.deploy).not.toHaveBeenCalled();
  });
});
