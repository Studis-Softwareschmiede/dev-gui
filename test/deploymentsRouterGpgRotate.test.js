/**
 * deploymentsRouterGpgRotate.test.js — HTTP-Ebene für die Rotations-Endpunkte
 * (docs/specs/per-app-gpg-passphrase-rotation.md, F-073/S-338).
 *
 * Covers:
 *   AC7  — Alle drei Endpunkte hinter CRED_ADMIN_EMAILS (AccessGuard sitzt in
 *          server.js, siehe Covers-Note unten); ohne Berechtigung → 403, KEIN
 *          Dienst-Aufruf. Response ist geheimnisfrei (nie ein Passphrasen-Wert).
 *   AC1/AC3 — POST .../gpg-rotate/start: Dienst-Ergebnis (candidate-proved/
 *          aborted) 1:1 als { ok, phase?, errorClass?, reason? } durchgereicht (200).
 *   AC4/AC13 — POST .../gpg-rotate/commit: Dienst-Ergebnis (ok/errorClass)
 *          1:1 durchgereicht (200).
 *   AC5  — POST .../gpg-rotate/discard-previous: Dienst-Ergebnis 1:1
 *          durchgereicht (200).
 *   400  — app-Parameter mit ungültigen Zeichen → 400, kein Dienst-Aufruf.
 *   503  — Dienst nicht konfiguriert (kein perAppGpgRotationService injiziert).
 *
 * AC9 (per-app-gpg-passphrase-provisioning-Naht, gleiche Doktrin) —
 * AccessGuard-Verdrahtung: per server.js-Inspektion (app.use('/api', accessGuard)
 * vor mountRouters()), kein separater Middleware-Test hier (Muster
 * deploymentsRouterGpgProvision.test.js).
 *
 * Real-HTTP (nicht nur router.stack[...].handle(mockReq, mockRes)) — Muster
 * deploymentsRouterGpgProvision.test.js/deploymentsRouterGpgGuard.test.js.
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

function build({ startResult, commitResult, discardResult, service, identityEmail = 'a@b.ch' } = {}) {
  const orchestrator = { deploy: jest.fn() };
  const auditRecord = jest.fn();
  const startRotation = jest.fn(async () => startResult ?? { ok: true, phase: 'candidate-proved' });
  const commitRotation = jest.fn(async () => commitResult ?? { ok: true });
  const discardPrevious = jest.fn(async () => discardResult ?? { ok: true });
  const perAppGpgRotationService = service === null ? undefined : (service ?? { startRotation, commitRotation, discardPrevious });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.identity = identityEmail ? { email: identityEmail } : null; next(); });
  app.use(deploymentsRouter(
    orchestrator, { record: auditRecord }, new Map(),
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, perAppGpgRotationService,
  ));
  return { orchestrator, auditRecord, startRotation, commitRotation, discardPrevious, app };
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

describe('deploymentsRouter — POST /:app/gpg-rotate/start (F-073/S-338)', () => {
  it('AC7: ohne Berechtigung (nicht in CRED_ADMIN_EMAILS) → 403, KEIN Dienst-Aufruf', async () => {
    process.env.CRED_ADMIN_EMAILS = 'other@b.ch';
    const parts = build({ identityEmail: 'a@b.ch' });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/start', {});

    expect(r.status).toBe(403);
    expect(parts.startRotation).not.toHaveBeenCalled();
  });

  it('AC1/AC3: candidate-proved → 200 { ok: true, phase: "candidate-proved" }', async () => {
    const parts = build({ startResult: { ok: true, phase: 'candidate-proved' } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/start', {});

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, phase: 'candidate-proved' });
    expect(parts.startRotation).toHaveBeenCalledWith('myapp', { identity: 'a@b.ch' });
  });

  it('AC3/AC12: aborted (clone-missing) → 200 { ok:false, phase:"aborted", errorClass, reason }', async () => {
    const parts = build({ startResult: { ok: false, phase: 'aborted', errorClass: 'clone-missing', reason: 'App zuerst in den Workspace klonen.' } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/start', {});

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, phase: 'aborted', errorClass: 'clone-missing', reason: 'App zuerst in den Workspace klonen.' });
  });

  it('AC3: aborted (verify-failed) → 200, Beweis-Runden-Fehler durchgereicht', async () => {
    const parts = build({ startResult: { ok: false, phase: 'aborted', errorClass: 'verify-failed', reason: 'Klartext-Vergleich stimmt nicht überein.' } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/start', {});

    expect(r.status).toBe(200);
    expect(r.body.errorClass).toBe('verify-failed');
  });

  it('400: ungültiger app-Parameter (Shell-Metazeichen) → 400, kein Dienst-Aufruf', async () => {
    const parts = build({});
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/my%3Bapp/gpg-rotate/start', {});

    expect(r.status).toBe(400);
    expect(parts.startRotation).not.toHaveBeenCalled();
  });

  it('503: Dienst nicht konfiguriert → 503, kein Crash', async () => {
    const parts = build({ service: null });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/start', {});

    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
  });

  it('AC7: Response enthält nie ein Passphrasen-artiges Feld (nur ok/phase/errorClass/reason)', async () => {
    const parts = build({ startResult: { ok: true, phase: 'candidate-proved' } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/start', {});

    expect(Object.keys(r.body).sort()).toEqual(['ok', 'phase']);
  });
});

describe('deploymentsRouter — POST /:app/gpg-rotate/commit (F-073/S-338)', () => {
  it('AC7: ohne Berechtigung → 403, KEIN Dienst-Aufruf', async () => {
    process.env.CRED_ADMIN_EMAILS = 'other@b.ch';
    const parts = build({ identityEmail: 'a@b.ch' });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/commit', {});

    expect(r.status).toBe(403);
    expect(parts.commitRotation).not.toHaveBeenCalled();
  });

  it('AC4: Erfolg → 200 { ok: true }', async () => {
    const parts = build({ commitResult: { ok: true } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/commit', {});

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(parts.commitRotation).toHaveBeenCalledWith('myapp', { identity: 'a@b.ch' });
  });

  it('AC13: push-failed (Bitwarden zurückgerollt) → 200 { ok:false, errorClass:"push-failed", reason }', async () => {
    const parts = build({ commitResult: { ok: false, errorClass: 'push-failed', reason: 'Rückschreiben fehlgeschlagen.' } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/commit', {});

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, errorClass: 'push-failed', reason: 'Rückschreiben fehlgeschlagen.' });
  });

  it('400: ungültiger app-Parameter → 400, kein Dienst-Aufruf', async () => {
    const parts = build({});
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/my%3Bapp/gpg-rotate/commit', {});

    expect(r.status).toBe(400);
    expect(parts.commitRotation).not.toHaveBeenCalled();
  });

  it('503: Dienst nicht konfiguriert → 503, kein Crash', async () => {
    const parts = build({ service: null });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/commit', {});

    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
  });
});

describe('deploymentsRouter — POST /:app/gpg-rotate/discard-previous (F-073/S-338 AC5)', () => {
  it('AC7: ohne Berechtigung → 403, KEIN Dienst-Aufruf', async () => {
    process.env.CRED_ADMIN_EMAILS = 'other@b.ch';
    const parts = build({ identityEmail: 'a@b.ch' });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/discard-previous', {});

    expect(r.status).toBe(403);
    expect(parts.discardPrevious).not.toHaveBeenCalled();
  });

  it('AC5: Erfolg → 200 { ok: true }', async () => {
    const parts = build({ discardResult: { ok: true } });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/discard-previous', {});

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(parts.discardPrevious).toHaveBeenCalledWith('myapp', { identity: 'a@b.ch' });
  });

  it('400: ungültiger app-Parameter → 400, kein Dienst-Aufruf', async () => {
    const parts = build({});
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/my%3Bapp/gpg-rotate/discard-previous', {});

    expect(r.status).toBe(400);
    expect(parts.discardPrevious).not.toHaveBeenCalled();
  });

  it('503: Dienst nicht konfiguriert → 503, kein Crash', async () => {
    const parts = build({ service: null });
    await serve(parts);

    const r = await httpPost(ctx.port, '/api/deployments/myapp/gpg-rotate/discard-previous', {});

    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
  });
});
