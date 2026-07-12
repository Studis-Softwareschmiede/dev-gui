/**
 * bitwardenDeployAccessRouter.test.js — HTTP-Tests für den Deploy-Zugangs-Router.
 *
 * Covers (docs/specs/deploy-bitwarden-gpg-injection.md):
 *   AC2 — GET liefert write-only Status (set/updatedAt + ready), KEIN Klartext.
 *   AC3 — PUT/DELETE mutieren genau ein Feld; Validierung (unknown/empty/too-long).
 *   S1  — Response enthält nie den gesetzten Wert.
 *   S4  — Audit-First: Audit vor Mutation; Audit-Fail → 500, KEINE Mutation.
 *   S5  — CRED_ADMIN_EMAILS-Gate: fremde Identität → 403.
 *
 * Strategy: echter BitwardenDeployAccessStore gegen tmp-CRED_STORE_DIR; Audit als
 * Spy; Identität via Test-Middleware injiziert (AccessGuard ist server.js-Sache).
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { BitwardenDeployAccessStore } from '../src/BitwardenDeployAccessStore.js';
import { bitwardenDeployAccessRouter } from '../src/bitwardenDeployAccessRouter.js';

// ── HTTP helpers ────────────────────────────────────────────────────────────
function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}
function httpReq(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { /* non-json */ }
          resolve({ status: res.statusCode, body: json, raw });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let storeDir;
let prevStoreDir;
let prevAdmin;
let ctx; // { server, port, auditRecord, identity }

async function buildApp({ audit, identity }) {
  const store = new BitwardenDeployAccessStore();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.identity = identity ?? null; next(); });
  app.use(bitwardenDeployAccessRouter(store, audit));
  const { server, port } = await startServer(app);
  return { server, port, store };
}

beforeEach(async () => {
  prevStoreDir = process.env.CRED_STORE_DIR;
  prevAdmin = process.env.CRED_ADMIN_EMAILS;
  delete process.env.CRED_ADMIN_EMAILS; // Default: jede Identität darf mutieren
  storeDir = join(tmpdir(), 'bw-deploy-router-test-' + randomBytes(6).toString('hex'));
  await mkdir(storeDir, { recursive: true });
  process.env.CRED_STORE_DIR = storeDir;
});

afterEach(async () => {
  if (ctx?.server) await closeServer(ctx.server);
  ctx = null;
  if (prevStoreDir === undefined) delete process.env.CRED_STORE_DIR; else process.env.CRED_STORE_DIR = prevStoreDir;
  if (prevAdmin === undefined) delete process.env.CRED_ADMIN_EMAILS; else process.env.CRED_ADMIN_EMAILS = prevAdmin;
  await rm(storeDir, { recursive: true, force: true }).catch(() => {});
});

describe('bitwardenDeployAccessRouter — Status + Mutation', () => {
  it('GET liefert write-only Status; PUT setzt Feld ohne Wert-Leak; Audit vor Mutation', async () => {
    const auditRecord = jest.fn();
    ctx = await buildApp({ audit: { record: auditRecord }, identity: { email: 'a@b.ch' } });

    let r = await httpReq(ctx.port, 'GET', '/api/settings/deploy-access');
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(false);
    expect(r.body.fields.client_id).toEqual({ set: false, updatedAt: null });

    r = await httpReq(ctx.port, 'PUT', '/api/settings/deploy-access/client_secret', { value: 'geheim-xyz' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ field: 'client_secret', set: true });
    // S1: Wert taucht nirgends in der Response auf
    expect(r.raw).not.toContain('geheim-xyz');
    // S4: Audit-First mit Feldname, ohne Wert
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ command: 'deploy-access:set:client_secret' }));
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain('geheim-xyz');

    r = await httpReq(ctx.port, 'GET', '/api/settings/deploy-access');
    expect(r.body.fields.client_secret.set).toBe(true);
  });

  it('Validierung: unbekanntes Feld → 404, leerer Wert → 400, zu lang → 422', async () => {
    ctx = await buildApp({ audit: { record: jest.fn() }, identity: { email: 'a@b.ch' } });

    let r = await httpReq(ctx.port, 'PUT', '/api/settings/deploy-access/nope', { value: 'x' });
    expect(r.status).toBe(404);

    r = await httpReq(ctx.port, 'PUT', '/api/settings/deploy-access/client_id', { value: '   ' });
    expect(r.status).toBe(400);

    r = await httpReq(ctx.port, 'PUT', '/api/settings/deploy-access/client_id', { value: 'x'.repeat(5000) });
    expect(r.status).toBe(422);
  });

  it('DELETE entfernt ein Feld (idempotent)', async () => {
    ctx = await buildApp({ audit: { record: jest.fn() }, identity: { email: 'a@b.ch' } });
    await httpReq(ctx.port, 'PUT', '/api/settings/deploy-access/client_id', { value: 'cid' });
    let r = await httpReq(ctx.port, 'DELETE', '/api/settings/deploy-access/client_id');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ field: 'client_id', set: false, updatedAt: null });
    // idempotent
    r = await httpReq(ctx.port, 'DELETE', '/api/settings/deploy-access/client_id');
    expect(r.status).toBe(200);
  });

  it('S4: Audit-Write-Fehler → 500 und KEINE Mutation', async () => {
    const auditRecord = jest.fn(() => { throw new Error('audit down'); });
    ctx = await buildApp({ audit: { record: auditRecord }, identity: { email: 'a@b.ch' } });

    const r = await httpReq(ctx.port, 'PUT', '/api/settings/deploy-access/client_id', { value: 'cid' });
    expect(r.status).toBe(500);
    // Mutation unterblieb
    const g = await httpReq(ctx.port, 'GET', '/api/settings/deploy-access');
    expect(g.body.fields.client_id.set).toBe(false);
  });

  it('S5: CRED_ADMIN_EMAILS gesetzt + fremde Identität → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@schmiede.ch';
    ctx = await buildApp({ audit: { record: jest.fn() }, identity: { email: 'intruder@evil.ch' } });
    const r = await httpReq(ctx.port, 'PUT', '/api/settings/deploy-access/client_id', { value: 'cid' });
    expect(r.status).toBe(403);
  });
});
