/**
 * deploymentsRouterGpgProvision.test.js — HTTP-Ebene für den Nach-Provisionierungs-
 * Endpunkt (per-app-gpg-passphrase-provisioning.md, F-073/S-335 AC7/AC10).
 *
 * Covers:
 *   AC10 — POST /api/deployments/:app/gpg-provision hinter CRED_ADMIN_EMAILS
 *          (AccessGuard sitzt in server.js, siehe Covers-Note unten); ohne
 *          Berechtigung → 403, KEIN Aufruf des Provisionierungsdienstes (kein bw).
 *   AC7  — Happy-Path: Dienst-Ergebnis (created/already-exists/access-not-ready/
 *          failed) wird 1:1 als { result, reason? } durchgereicht (200).
 *   AC8  — Response ist geheimnisfrei (kein Passphrasen-Wert je im Body).
 *   400  — app-Parameter mit ungültigen Zeichen → 400, kein Dienst-Aufruf.
 *   503  — Dienst nicht konfiguriert (kein perAppGpgProvisioningService injiziert).
 *
 * AC9 — AccessGuard-Verdrahtung: per server.js-Inspektion (app.use('/api', accessGuard)
 * vor mountRouters()), kein separater Middleware-Test hier (Muster deploymentsRouter,
 * coder.md-Lesson 2026-06-12 — Router-Test injiziert req.identity direkt).
 *
 * Real-HTTP (nicht nur router.stack[...].handle(mockReq, mockRes)) — Muster
 * deploymentsRouterGpgGuard.test.js (S-334).
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
function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => { let j = null; try { j = raw ? JSON.parse(raw) : null; } catch { /* */ } resolve({ status: res.statusCode, body: j, raw }); });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let ctx;
let prevAdmin;

function build({ provisionResult, provisionImpl, service, identityEmail = 'a@b.ch' } = {}) {
  const orchestrator = { deploy: jest.fn() };
  const auditRecord = jest.fn();
  const provision = provisionImpl ?? jest.fn(async () => provisionResult ?? { result: 'created' });
  const perAppGpgProvisioningService = service === null ? undefined : (service ?? { provision });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.identity = identityEmail ? { email: identityEmail } : null; next(); });
  app.use(deploymentsRouter(
    orchestrator, { record: auditRecord }, new Map(),
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, perAppGpgProvisioningService,
  ));
  return { orchestrator, auditRecord, provision, app };
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

describe('deploymentsRouter — POST /:app/gpg-provision (F-073/S-335)', () => {
  it('AC10: ohne Berechtigung (nicht in CRED_ADMIN_EMAILS) → 403, KEIN Dienst-Aufruf', async () => {
    process.env.CRED_ADMIN_EMAILS = 'other@b.ch';
    const parts = build({ identityEmail: 'a@b.ch' });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-provision', {});

    expect(r.status).toBe(403);
    expect(parts.provision).not.toHaveBeenCalled();
  });

  it('AC7/AC8: created → 200 { result: "created" }, geheimnisfrei', async () => {
    const parts = build({ provisionResult: { result: 'created' } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-provision', {});

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ result: 'created' });
    expect(parts.provision).toHaveBeenCalledWith('myapp', { identity: 'a@b.ch' });
  });

  it('AC7: already-exists → 200 { result: "already-exists", reason }', async () => {
    const parts = build({ provisionResult: { result: 'already-exists', reason: 'existiert bereits' } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/existing-app/gpg-provision', {});

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ result: 'already-exists', reason: 'existiert bereits' });
  });

  it('AC3 (durchgereicht): access-not-ready → 200 { result: "access-not-ready", reason }', async () => {
    const parts = build({ provisionResult: { result: 'access-not-ready', reason: 'Zugang fehlt' } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-provision', {});

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ result: 'access-not-ready', reason: 'Zugang fehlt' });
  });

  it('failed → 200 { result: "failed", reason }, kein Crash', async () => {
    const parts = build({ provisionResult: { result: 'failed', reason: 'Bitwarden-Fehler' } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-provision', {});

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ result: 'failed', reason: 'Bitwarden-Fehler' });
  });

  it('400: ungültiger app-Parameter (Shell-Metazeichen) → 400, kein Dienst-Aufruf', async () => {
    const parts = build({});
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/my%3Bapp/gpg-provision', {});

    expect(r.status).toBe(400);
    expect(parts.provision).not.toHaveBeenCalled();
  });

  it('503: Dienst nicht konfiguriert → 503, kein Crash', async () => {
    const parts = build({ service: null });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-provision', {});

    expect(r.status).toBe(503);
    expect(r.body.result).toBe('failed');
  });

  it('AC8: Response enthält nie einen freien Passphrasen-artigen Wert (nur result/reason)', async () => {
    const parts = build({ provisionResult: { result: 'created' } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-provision', {});

    expect(Object.keys(r.body).sort()).toEqual(['result']);
  });
});
