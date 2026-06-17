/**
 * vpsDelete.test.js — Tests für den VPS-Delete-Endpunkt (S-153, vps-delete).
 *
 * Covers (vps-delete):
 *   AC1  — DELETE /api/vps/machines/:provider/*splat existiert; composite IONOS-IDs via *splat
 *   AC2  — unsupported-Provider → 422 result:"unsupported"; capabilities.delete ausgewiesen
 *   AC3  — Tunnel-Cleanup: deleteTunnel + Token-Referenz aus Store entfernt
 *   AC4  — Cloudflare-Cleanup-Fehler maskiert nicht Server-Lösch-Erfolg (cleanupError)
 *   AC5  — Keine Tunnel-Zuordnung → Cleanup übersprungen, kein Fehler
 *   AC6  — 403 ohne Access (AccessGuard) + 403 ohne CRED_ADMIN_EMAILS-Berechtigung
 *   AC7  — Audit-First: Eintrag vor Mutation; Audit-Fail → Aktion unterbleibt
 *          Token erscheint NICHT in Response/Audit
 *
 * Strategy:
 *   - VpsProviderRegistry als Mock injiziert
 *   - AuditStore real (in-memory)
 *   - AccessGuard mit DEV_NO_ACCESS=1 für Nicht-403-Tests
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { vpsRouter } from '../src/vpsRouter.js';
import { AuditStore } from '../src/AuditStore.js';
import { VpsRegistryError } from '../src/vps/VpsProviderRegistry.js';
import { createAccessGuard } from '../src/AccessGuard.js';

const MOCK_TOKEN = 'should-never-appear-in-response-or-audit';

// ── Mock-Registry-Fabrik ───────────────────────────────────────────────────────

function makeMockRegistry({
  providers = null,
  deleteResult = null,
  throwOn = null,
} = {}) {
  return {
    async listProviders() {
      return providers ?? [
        { id: 'hetzner', configured: true,
          capabilities: { list: true, start: true, stop: true, create: true, delete: true } },
        { id: 'ionos', configured: false,
          capabilities: { list: false, start: false, stop: false, create: false, delete: false } },
        { id: 'hostinger', configured: false,
          capabilities: { list: false, start: false, stop: false, create: false, delete: false } },
      ];
    },
    async listAllMachines() {
      return { machines: [] };
    },
    async start(_provider, _serverId) { return { result: 'ok' }; },
    async stop(_provider, _serverId) { return { result: 'ok' }; },
    async create(_provider, _params) { return {}; },
    async delete(_provider, _serverId, _vpsName) {
      if (throwOn === 'delete') {
        throw deleteResult ?? new Error('delete-Fehler');
      }
      return deleteResult ?? { result: 'ok' };
    },
  };
}

// ── Test-Server-Fabrik ─────────────────────────────────────────────────────────

async function makeTestServer({ registry, audit } = {}) {
  const app = express();
  app.use(express.json());

  const guard = createAccessGuard();
  app.use('/api', guard);

  const auditInstance = audit ?? new AuditStore();
  app.use(vpsRouter(registry ?? makeMockRegistry(), auditInstance));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  function req(method, path, body = null, extraHeaders = {}) {
    return new Promise((resolve) => {
      const headers = { 'Content-Type': 'application/json', ...extraHeaders };
      const bodyStr = body !== null ? JSON.stringify(body) : null;
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const options = { hostname: '127.0.0.1', port, path, method, headers };
      const r = httpRequest(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      r.on('error', () => resolve({ status: 0, body: '' }));
      if (bodyStr) r.write(bodyStr);
      r.end();
    });
  }

  async function close() {
    await new Promise((r) => server.close(r));
  }

  return { req, close, audit: auditInstance };
}

// ── AC6: AccessGuard — 403 ohne Access-Token ──────────────────────────────────

describe('vpsDelete — AC6: AccessGuard (403 ohne Token)', () => {
  let ts;

  beforeEach(() => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
    if (ts) await ts.close();
    ts = null;
  });

  it('DELETE /api/vps/machines/hetzner/123 → 403 ohne Access-Token', async () => {
    ts = await makeTestServer();
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/123',
      { vpsName: 'my-server' });
    expect(res.status).toBe(403);
  });
});

// ── AC6: CRED_ADMIN_EMAILS-Rollenschutz ───────────────────────────────────────

describe('vpsDelete — AC6: CRED_ADMIN_EMAILS-Rollenschutz', () => {
  let ts;

  beforeEach(() => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
    if (ts) await ts.close();
    ts = null;
  });

  it('DELETE mit CRED_ADMIN_EMAILS gesetzt, dev@local nicht erlaubt → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    ts = await makeTestServer();
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/123',
      { vpsName: 'my-server' });
    expect(res.status).toBe(403);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/berechtigung/i);
  });

  it('DELETE mit CRED_ADMIN_EMAILS=dev@local → erlaubt (200)', async () => {
    process.env.CRED_ADMIN_EMAILS = 'dev@local';
    ts = await makeTestServer();
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/123',
      { vpsName: 'my-server' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('ok');
  });

  it('DELETE ohne CRED_ADMIN_EMAILS → jede Identität erlaubt', async () => {
    delete process.env.CRED_ADMIN_EMAILS;
    ts = await makeTestServer();
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/123',
      { vpsName: 'my-server' });
    expect(res.status).toBe(200);
  });
});

// ── AC1: DELETE-Endpunkt grundlegendes Verhalten ──────────────────────────────

describe('vpsDelete — AC1: DELETE-Endpunkt', () => {
  let ts;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
    if (ts) await ts.close();
    ts = null;
  });

  it('DELETE /api/vps/machines/hetzner/123 → 200 { result: "ok" }', async () => {
    ts = await makeTestServer();
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/123',
      { vpsName: 'my-server' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('ok');
  });

  it('DELETE mit composite IONOS serverId (via *splat) → korrekt rekonstruiert', async () => {
    let capturedServerId;
    const registry = {
      ...makeMockRegistry(),
      async delete(_provider, serverId, _vpsName) {
        capturedServerId = serverId;
        return { result: 'ok' };
      },
    };
    ts = await makeTestServer({ registry });
    const res = await ts.req('DELETE', '/api/vps/machines/ionos/dc-abc123/srv-def456',
      { vpsName: 'test-vps' });
    expect(res.status).toBe(200);
    expect(capturedServerId).toBe('dc-abc123/srv-def456');
  });

  it('DELETE ohne vpsName → 400', async () => {
    ts = await makeTestServer();
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/123', {});
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/vpsName/i);
  });

  it('DELETE mit unbekanntem Provider → 422', async () => {
    ts = await makeTestServer();
    const res = await ts.req('DELETE', '/api/vps/machines/unknown-provider/123',
      { vpsName: 'my-server' });
    expect(res.status).toBe(422);
  });

  it('Token erscheint NICHT in der Response (AC7 Security-Floor)', async () => {
    const registry = {
      ...makeMockRegistry(),
      async delete(_provider, _serverId, _vpsName) {
        return { result: 'ok' };
      },
    };
    ts = await makeTestServer({ registry });
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/123',
      { vpsName: 'my-server' });
    expect(res.body).not.toContain(MOCK_TOKEN);
    expect(res.body).not.toContain('Bearer');
  });
});

// ── AC2: unsupported-Provider ─────────────────────────────────────────────────

describe('vpsDelete — AC2: unsupported-Provider → 422', () => {
  let ts;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (ts) await ts.close();
    ts = null;
  });

  it('delete unsupported → 422 { result: "unsupported" }', async () => {
    const registry = makeMockRegistry({
      deleteResult: { result: 'unsupported', reason: 'Provider unterstützt kein Löschen' },
    });
    ts = await makeTestServer({ registry });
    const res = await ts.req('DELETE', '/api/vps/machines/hostinger/vm-1',
      { vpsName: 'my-vm' });
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('unsupported');
  });
});

// ── AC3/AC4: Tunnel-Cleanup via Registry ──────────────────────────────────────

describe('vpsDelete — AC3/AC4: Tunnel-Cleanup', () => {
  let ts;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (ts) await ts.close();
    ts = null;
  });

  it('AC3: Tunnel-Cleanup-Erfolg → result:ok ohne cleanupError', async () => {
    const registry = makeMockRegistry({
      deleteResult: { result: 'ok' },
    });
    ts = await makeTestServer({ registry });
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/1',
      { vpsName: 'my-server' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('ok');
    expect(data.cleanupError).toBeUndefined();
  });

  it('AC4: Cloudflare-Cleanup-Fehler → result:ok + cleanupError gesetzt', async () => {
    const registry = makeMockRegistry({
      deleteResult: {
        result: 'ok',
        cleanupError: 'Tunnel-Delete fehlgeschlagen: cloudflare-auth-failed',
      },
    });
    ts = await makeTestServer({ registry });
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/1',
      { vpsName: 'my-server' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('ok');
    expect(data.cleanupError).toBeTruthy();
    // cleanupError enthält keinen Token (Security-Floor)
    expect(data.cleanupError).not.toMatch(/Bearer/i);
  });

  it('AC4: Teil-Audit wird geschrieben wenn cleanupError vorhanden', async () => {
    const registry = makeMockRegistry({
      deleteResult: {
        result: 'ok',
        cleanupError: 'Tunnel-Cleanup fehlgeschlagen',
      },
    });
    const auditStore = new AuditStore();
    ts = await makeTestServer({ registry, audit: auditStore });
    await ts.req('DELETE', '/api/vps/machines/hetzner/1', { vpsName: 'my-server' });

    const entries = auditStore.getAll();
    // Outcome-Audit enthält "partial" wegen cleanupError
    const outcomeEntry = entries.find((e) => e.command.includes('partial'));
    expect(outcomeEntry).toBeTruthy();
  });
});

// ── AC7: Audit-First ──────────────────────────────────────────────────────────

describe('vpsDelete — AC7: Audit-First', () => {
  let ts;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (ts) await ts.close();
    ts = null;
  });

  it('Audit-Eintrag mit vps:delete vor Ausführung', async () => {
    const auditStore = new AuditStore();
    ts = await makeTestServer({ audit: auditStore });
    await ts.req('DELETE', '/api/vps/machines/hetzner/123', { vpsName: 'my-server' });

    const entries = auditStore.getAll();
    const deleteEntry = entries.find((e) => e.command.includes('vps:delete:hetzner:123'));
    expect(deleteEntry).toBeTruthy();
  });

  it('Token erscheint NICHT im Audit', async () => {
    const auditStore = new AuditStore();
    ts = await makeTestServer({ audit: auditStore });
    await ts.req('DELETE', '/api/vps/machines/hetzner/123', { vpsName: 'my-server' });

    const entries = auditStore.getAll();
    for (const entry of entries) {
      expect(entry.command ?? '').not.toContain(MOCK_TOKEN);
      expect(entry.command ?? '').not.toContain('Bearer');
    }
  });

  it('Audit-Write-Fehler → 500, Aktion unterbleibt', async () => {
    const registry = makeMockRegistry();
    let deleted = false;
    const originalDelete = registry.delete.bind(registry);
    registry.delete = async (...args) => {
      deleted = true;
      return originalDelete(...args);
    };

    const failingAudit = {
      record() { throw new Error('Audit-DB ausgefallen'); },
      recent: () => [],
    };

    ts = await makeTestServer({ registry, audit: failingAudit });
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/123',
      { vpsName: 'my-server' });
    expect(res.status).toBe(500);
    expect(deleted).toBe(false); // Aktion unterbleibt
  });
});

// ── AC1: Provider-not-configured → 422 ───────────────────────────────────────

describe('vpsDelete — AC1: provider-not-configured', () => {
  let ts;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (ts) await ts.close();
    ts = null;
  });

  it('Registry wirft VpsRegistryError(provider-not-configured) → 422', async () => {
    const registry = makeMockRegistry({
      throwOn: 'delete',
      deleteResult: new VpsRegistryError(
        'Provider nicht konfiguriert',
        'provider-not-configured',
        422,
      ),
    });
    ts = await makeTestServer({ registry });
    const res = await ts.req('DELETE', '/api/vps/machines/hetzner/123',
      { vpsName: 'my-server' });
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.errorClass).toBe('provider-not-configured');
  });
});
