/**
 * deploymentsRouterGpgGuard.test.js — Deploy-Guard + per-App-GPG-Passphrase-Injektion
 * (deploy-bitwarden-gpg-injection F-072/S-334).
 *
 * Covers:
 *   AC12 — gpgBwItem gesetzt + Zugang NICHT ready → 422 bitwarden-access-missing,
 *          KEIN orchestrator.deploy (kein docker run), kein Passphrase-Abruf.
 *   AC13 — kein gpgBwItem → Deploy läuft unverändert, Zugangs-Store/Login unberührt.
 *   AC14 — gpgBwItem + ready → Passphrase geholt + als containerEnv.GPG_PASSPHRASE an
 *          orchestrator.deploy gereicht; Wert erscheint nicht in Response/Audit (S1).
 *   AC15 — fehlendes Item → 422 gpg-item-not-found; Login-Fehler → 502.
 *   AC19 (S-409, §4.5) — deployErrorClass 'config-failed' → 502
 *          errorClass 'bitwarden-config-failed' (eigene reason, kein
 *          Sammelfall 'bitwarden-login-failed', kein bw-Rohtext-Leak).
 *   503  — gpgBwItem gesetzt, aber Zugangs-Dienst nicht verdrahtet.
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

const VPS_TARGETS = new Map([['my-vps', { host: '1.2.3.4', port: 22, targetUser: 'root' }]]);
const BASE_BODY = { image: 'ghcr.io/org/app:v1', vps: 'my-vps', hostname: 'app.example.com', tunnelId: 't-123' };

let ctx;
let prevAdmin;

function build({ deploy, accessStatus, fetchItemPassword, accessStore, loginService } = {}) {
  const orchestrator = {
    deploy: deploy ?? jest.fn(async () => ({ result: 'ok', deployment: { containerId: 'c1', hostname: BASE_BODY.hostname } })),
  };
  const auditRecord = jest.fn();
  const store = accessStore === null ? undefined
    : (accessStore ?? { getStatus: jest.fn(async () => accessStatus ?? { ready: true }) });
  const login = loginService === null ? undefined
    : (loginService ?? { fetchItemPassword: fetchItemPassword ?? jest.fn(async () => 'PASSPHRASE-XYZ') });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.identity = { email: 'a@b.ch' }; next(); });
  app.use(deploymentsRouter(orchestrator, { record: auditRecord }, VPS_TARGETS, undefined, undefined, undefined, undefined, undefined, undefined, store, login));
  return { orchestrator, auditRecord, store, login, app };
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

describe('deploymentsRouter — GPG-Guard + Injektion (F-072/S-334)', () => {
  it('AC12: gpgBwItem + Zugang nicht ready → 422 bitwarden-access-missing, kein Deploy/Abruf', async () => {
    const parts = build({ accessStatus: { ready: false } });
    await serve(parts);
    const r = await httpPost(ctx.port, '/api/deployments', { ...BASE_BODY, gpgBwItem: 'deploy-gpg-app' });
    expect(r.status).toBe(422);
    expect(r.body.errorClass).toBe('bitwarden-access-missing');
    expect(parts.orchestrator.deploy).not.toHaveBeenCalled();
    expect(parts.login.fetchItemPassword).not.toHaveBeenCalled();
  });

  it('AC13: kein gpgBwItem → Deploy läuft, Zugangs-Store/Login unberührt, kein containerEnv', async () => {
    const parts = build({});
    await serve(parts);
    const r = await httpPost(ctx.port, '/api/deployments', BASE_BODY);
    expect(r.status).toBe(200);
    expect(parts.orchestrator.deploy).toHaveBeenCalledTimes(1);
    const arg = parts.orchestrator.deploy.mock.calls[0][0];
    expect(arg.containerEnv).toBeUndefined();
    expect(parts.store.getStatus).not.toHaveBeenCalled();
    expect(parts.login.fetchItemPassword).not.toHaveBeenCalled();
  });

  it('AC14: gpgBwItem + ready → Passphrase als containerEnv.GPG_PASSPHRASE; Wert nicht in Response/Audit', async () => {
    const parts = build({ accessStatus: { ready: true } });
    await serve(parts);
    const r = await httpPost(ctx.port, '/api/deployments', { ...BASE_BODY, gpgBwItem: 'deploy-gpg-app' });
    expect(r.status).toBe(200);
    expect(parts.login.fetchItemPassword).toHaveBeenCalledWith('deploy-gpg-app', expect.any(Object));
    const arg = parts.orchestrator.deploy.mock.calls[0][0];
    expect(arg.containerEnv).toEqual({ GPG_PASSPHRASE: 'PASSPHRASE-XYZ' });
    // S1: Passphrase nirgends in Response/Audit
    expect(r.raw).not.toContain('PASSPHRASE-XYZ');
    expect(JSON.stringify(parts.auditRecord.mock.calls)).not.toContain('PASSPHRASE-XYZ');
  });

  it('AC15: fehlendes Item → 422 gpg-item-not-found, kein Deploy', async () => {
    const fetchItemPassword = jest.fn(async () => { const e = new Error('x'); e.deployErrorClass = 'item-not-found'; throw e; });
    const parts = build({ accessStatus: { ready: true }, fetchItemPassword });
    await serve(parts);
    const r = await httpPost(ctx.port, '/api/deployments', { ...BASE_BODY, gpgBwItem: 'deploy-gpg-missing' });
    expect(r.status).toBe(422);
    expect(r.body.errorClass).toBe('gpg-item-not-found');
    expect(parts.orchestrator.deploy).not.toHaveBeenCalled();
  });

  it('AC15: Login-Fehler (bw-unreachable) → 502 bitwarden-login-failed', async () => {
    const fetchItemPassword = jest.fn(async () => { const e = new Error('x'); e.deployErrorClass = 'bw-unreachable'; throw e; });
    const parts = build({ accessStatus: { ready: true }, fetchItemPassword });
    await serve(parts);
    const r = await httpPost(ctx.port, '/api/deployments', { ...BASE_BODY, gpgBwItem: 'deploy-gpg-app' });
    expect(r.status).toBe(502);
    expect(r.body.errorClass).toBe('bitwarden-login-failed');
  });

  it('AC19 (S-409): config-Fehler (config-failed) → 502 bitwarden-config-failed, nicht bitwarden-login-failed', async () => {
    const fetchItemPassword = jest.fn(async () => { const e = new Error('bw-deploy: config-failed'); e.deployErrorClass = 'config-failed'; throw e; });
    const parts = build({ accessStatus: { ready: true }, fetchItemPassword });
    await serve(parts);
    const r = await httpPost(ctx.port, '/api/deployments', { ...BASE_BODY, gpgBwItem: 'deploy-gpg-app' });
    expect(r.status).toBe(502);
    expect(r.body.errorClass).toBe('bitwarden-config-failed');
    expect(r.body.errorClass).not.toBe('bitwarden-login-failed');
    expect(r.raw).not.toContain('Logout required');
    expect(parts.orchestrator.deploy).not.toHaveBeenCalled();
  });

  it('503 wenn gpgBwItem gesetzt, aber Zugangs-Dienst nicht verdrahtet', async () => {
    const parts = build({ accessStore: null, loginService: null });
    await serve(parts);
    const r = await httpPost(ctx.port, '/api/deployments', { ...BASE_BODY, gpgBwItem: 'deploy-gpg-app' });
    expect(r.status).toBe(503);
    expect(parts.orchestrator.deploy).not.toHaveBeenCalled();
  });
});
