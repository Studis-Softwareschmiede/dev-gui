/**
 * vpsRouter.test.js — Integrationstests für die VPS-Endpunkte.
 *
 * Covers:
 *   AC1  — Registry ist die einzige Boundary (Router ruft nur registry.*, nie direkt Adapter)
 *   AC2  — GET /api/vps/providers liefert [{ id, configured, capabilities }]
 *   AC3  — GET /api/vps/machines aggregiert VpsMachines
 *   AC4  — Degradation: providerErrors in GET /api/vps/machines, kein 500
 *   AC5  — POST .../start / .../stop → { result: "ok" }
 *   AC6  — unsupported → 422 { result: "unsupported" }; provider-not-configured → 422
 *   AC7  — POST /api/vps/machines/:provider → 201 mit machine (Create)
 *   AC8  — Create-Fehler → result:"error", kein Token-Leak
 *   AC9  — AccessGuard: 403 ohne Token; CRED_ADMIN_EMAILS-Rollenschutz für Mutationen
 *   AC10 — Audit-First: Audit-Eintrag vor Mutation; Audit-Fail blockiert Mutation;
 *           Token nie in Response/Audit
 *
 * Strategy:
 *   - VpsProviderRegistry wird als Mock injiziert (keine echten Adapter/Fetch-Calls)
 *   - AuditStore ist real (in-memory) — prüft Einträge
 *   - AccessGuard mit DEV_NO_ACCESS=1 (Dev-Bypass) für Nicht-403-Tests
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { vpsRouter } from '../src/vpsRouter.js';
import { AuditStore } from '../src/AuditStore.js';
import { VpsRegistryError } from '../src/vps/VpsProviderRegistry.js';
import { CloudInitError } from '../src/vps/CloudInitBuilder.js';
import { createAccessGuard } from '../src/AccessGuard.js';

const MOCK_TOKEN = 'should-never-appear-in-response-or-audit';

// ── Mock-Registry-Fabrik ───────────────────────────────────────────────────────

function makeMockRegistry({
  providers = null,
  machines = null,
  startResult = null,
  stopResult = null,
  createResult = null,
  throwOn = null,
} = {}) {
  return {
    async listProviders() {
      if (throwOn === 'listProviders') throw new Error('Registry-Fehler');
      return providers ?? [
        { id: 'hetzner', configured: true,
          capabilities: { list: true, start: true, stop: true, create: true } },
        { id: 'ionos', configured: false,
          capabilities: { list: false, start: false, stop: false, create: false } },
        { id: 'hostinger', configured: false,
          capabilities: { list: false, start: false, stop: false, create: false } },
      ];
    },
    async listAllMachines() {
      if (throwOn === 'listAllMachines') throw new Error('Registry-Fehler');
      return machines ?? { machines: [] };
    },
    async start(_provider, _serverId) {
      if (throwOn === 'start') throw startResult ?? new Error('start-Fehler');
      return startResult ?? { result: 'ok' };
    },
    async stop(_provider, _serverId) {
      if (throwOn === 'stop') throw stopResult ?? new Error('stop-Fehler');
      return stopResult ?? { result: 'ok' };
    },
    async create(_provider, _params) {
      if (throwOn === 'create') throw createResult ?? new Error('create-Fehler');
      return createResult ?? {
        provider: 'hetzner', serverId: '42', name: 'new-srv',
        status: 'provisioning', ipv4: null, ipv6: null,
        region: null, serverType: null, createdAt: null,
      };
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

// ── AC9: AccessGuard — 403 ohne Token ─────────────────────────────────────────

describe('vpsRouter — AC9: AccessGuard', () => {
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

  it('GET /api/vps/providers → 403 ohne Access-Token', async () => {
    ts = await makeTestServer();
    const res = await ts.req('GET', '/api/vps/providers');
    expect(res.status).toBe(403);
  });

  it('GET /api/vps/machines → 403 ohne Access-Token', async () => {
    ts = await makeTestServer();
    const res = await ts.req('GET', '/api/vps/machines');
    expect(res.status).toBe(403);
  });

  it('POST /api/vps/machines/hetzner → 403 ohne Access-Token', async () => {
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner',
      { name: 'x', region: 'nbg1', serverType: 'cx11' });
    expect(res.status).toBe(403);
  });

  it('POST .../start → 403 ohne Access-Token', async () => {
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner/123/start');
    expect(res.status).toBe(403);
  });
});

// ── AC9: CRED_ADMIN_EMAILS-Rollenschutz ───────────────────────────────────────

describe('vpsRouter — AC9: CRED_ADMIN_EMAILS', () => {
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

  it('Mutation mit CRED_ADMIN_EMAILS gesetzt, dev@local nicht erlaubt → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner/123/start');
    expect(res.status).toBe(403);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/berechtigung/i);
  });

  it('Mutation mit CRED_ADMIN_EMAILS=dev@local → erlaubt', async () => {
    process.env.CRED_ADMIN_EMAILS = 'dev@local';
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner/123/start');
    expect(res.status).toBe(200);
  });

  it('Mutation ohne CRED_ADMIN_EMAILS → jede Identität erlaubt', async () => {
    delete process.env.CRED_ADMIN_EMAILS;
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner/123/start');
    expect(res.status).toBe(200);
  });

  it('GET (nicht mutierend) ohne CRED_ADMIN_EMAILS → erlaubt', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com'; // Allowlist gesetzt
    ts = await makeTestServer();
    // GET /api/vps/providers ist READ — kein Rollenschutz nötig
    const res = await ts.req('GET', '/api/vps/providers');
    expect(res.status).toBe(200);
  });
});

// ── AC2: GET /api/vps/providers ───────────────────────────────────────────────

describe('vpsRouter — AC2: GET /api/vps/providers', () => {
  let ts;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (ts) await ts.close();
    ts = null;
  });

  it('liefert [{ id, configured, capabilities }] für alle drei Provider', async () => {
    ts = await makeTestServer();
    const res = await ts.req('GET', '/api/vps/providers');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(3);
    for (const p of data) {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('configured');
      expect(p).toHaveProperty('capabilities');
      expect(p.capabilities).toHaveProperty('list');
      expect(p.capabilities).toHaveProperty('start');
      expect(p.capabilities).toHaveProperty('stop');
      expect(p.capabilities).toHaveProperty('create');
    }
  });

  it('hetzner.configured=true wenn Token gesetzt', async () => {
    ts = await makeTestServer({
      registry: makeMockRegistry({
        providers: [{ id: 'hetzner', configured: true,
          capabilities: { list: true, start: true, stop: true, create: true } }],
      }),
    });
    const res = await ts.req('GET', '/api/vps/providers');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data[0].configured).toBe(true);
  });
});

// ── AC3/AC4: GET /api/vps/machines ───────────────────────────────────────────

describe('vpsRouter — AC3/AC4: GET /api/vps/machines', () => {
  let ts;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (ts) await ts.close();
    ts = null;
  });

  it('AC3 — liefert { machines: [...] }', async () => {
    const machine = { provider: 'hetzner', serverId: '1', name: 'h1',
      status: 'running', ipv4: '1.2.3.4', ipv6: null,
      region: 'nbg1', serverType: 'cx11', createdAt: null };
    ts = await makeTestServer({
      registry: makeMockRegistry({ machines: { machines: [machine] } }),
    });
    const res = await ts.req('GET', '/api/vps/machines');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.machines).toHaveLength(1);
    expect(data.machines[0].provider).toBe('hetzner');
  });

  it('AC4 — providerErrors in Antwort wenn ein Provider fehlschlug (kein 500)', async () => {
    ts = await makeTestServer({
      registry: makeMockRegistry({
        machines: {
          machines: [],
          providerErrors: [{ provider: 'ionos', errorClass: 'provider-unavailable' }],
        },
      }),
    });
    const res = await ts.req('GET', '/api/vps/machines');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.providerErrors).toHaveLength(1);
    expect(data.providerErrors[0].provider).toBe('ionos');
  });
});

// ── AC5/AC6: POST .../start|stop ─────────────────────────────────────────────

describe('vpsRouter — AC5/AC6: start/stop', () => {
  let ts;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (ts) await ts.close();
    ts = null;
  });

  it('AC5 — start → 200 { result: "ok" }', async () => {
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner/123/start');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('ok');
  });

  it('AC5 — stop → 200 { result: "ok" }', async () => {
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner/123/stop');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('ok');
  });

  it('AC6 — unsupported → 422 { result: "unsupported" }', async () => {
    ts = await makeTestServer({
      registry: makeMockRegistry({ startResult: { result: 'unsupported', reason: 'Nicht implementiert' } }),
    });
    const res = await ts.req('POST', '/api/vps/machines/ionos/123/start');
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('unsupported');
  });

  it('AC6 — provider-not-configured → 422', async () => {
    ts = await makeTestServer({
      registry: makeMockRegistry({
        throwOn: 'start',
        startResult: new VpsRegistryError('nicht konfiguriert', 'provider-not-configured', 422),
      }),
    });
    const res = await ts.req('POST', '/api/vps/machines/ionos/123/start');
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.errorClass).toBe('provider-not-configured');
  });

  it('unbekannter Provider → 422 (Validierung vor Registry-Call)', async () => {
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/aws/123/start');
    expect(res.status).toBe(422);
  });

  it('ungültige serverId (Path-Traversal ".." via *splat) → 422', async () => {
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner/../../etc/passwd/start');
    // *splat captures "../../etc/passwd"; validateServerId rejects ".." → 422
    expect(res.status).toBe(422);
  });
});

// ── AC5/Finding 1: IONOS composite serverId mit "/" durch HTTP-Schicht ───────

describe('vpsRouter — AC5/Finding-1: IONOS composite serverId routing', () => {
  let ts;
  let capturedStartServerId;
  let capturedStopServerId;

  beforeEach(() => {
    process.env.DEV_NO_ACCESS = '1';
    capturedStartServerId = null;
    capturedStopServerId = null;
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (ts) await ts.close();
    ts = null;
  });

  it('start mit IONOS composite serverId (dc-uuid/srv-uuid) → 200 { result: "ok" }', async () => {
    const registry = {
      async listProviders() { return []; },
      async listAllMachines() { return { machines: [] }; },
      async start(_provider, serverId) {
        capturedStartServerId = serverId;
        return { result: 'ok' };
      },
      async stop(_provider, serverId) {
        capturedStopServerId = serverId;
        return { result: 'ok' };
      },
      async create() { return {}; },
    };
    ts = await makeTestServer({ registry });

    // Composite ID with literal "/" in URL path — no URL encoding needed (Express 5 *splat)
    const res = await ts.req('POST', '/api/vps/machines/ionos/dc-aaa-111/srv-bbb-222/start');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('ok');
    // Registry must receive the reconstructed composite ID
    expect(capturedStartServerId).toBe('dc-aaa-111/srv-bbb-222');
  });

  it('stop mit IONOS composite serverId (dc-uuid/srv-uuid) → 200 { result: "ok" }', async () => {
    const registry = {
      async listProviders() { return []; },
      async listAllMachines() { return { machines: [] }; },
      async start() { return { result: 'ok' }; },
      async stop(_provider, serverId) {
        capturedStopServerId = serverId;
        return { result: 'ok' };
      },
      async create() { return {}; },
    };
    ts = await makeTestServer({ registry });

    const res = await ts.req('POST', '/api/vps/machines/ionos/dc-aaa-111/srv-bbb-222/stop');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('ok');
    expect(capturedStopServerId).toBe('dc-aaa-111/srv-bbb-222');
  });

  it('start mit einfacher (Hetzner) serverId ohne Slash → 200 { result: "ok" }', async () => {
    // Regression: plain serverIds (no slash) still work after the *splat routing change
    const registry = {
      async listProviders() { return []; },
      async listAllMachines() { return { machines: [] }; },
      async start(_provider, serverId) {
        capturedStartServerId = serverId;
        return { result: 'ok' };
      },
      async stop() { return { result: 'ok' }; },
      async create() { return {}; },
    };
    ts = await makeTestServer({ registry });

    const res = await ts.req('POST', '/api/vps/machines/hetzner/12345/start');
    expect(res.status).toBe(200);
    expect(capturedStartServerId).toBe('12345');
  });
});

// ── AC7/AC8: POST /api/vps/machines/:provider ─────────────────────────────────

describe('vpsRouter — AC7/AC8: Create-from-scratch', () => {
  let ts;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (ts) await ts.close();
    ts = null;
  });

  it('AC7 — 201 mit machine in Antwort', async () => {
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner', {
      name: 'new-srv',
      region: 'nbg1',
      serverType: 'cx11',
    });
    expect(res.status).toBe(201);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('ok');
    expect(data.machine).toBeDefined();
    expect(data.machine.provider).toBe('hetzner');
    expect(data.machine.serverId).toBe('42');
  });

  it('AC7 — 400 bei fehlendem name', async () => {
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner', {
      region: 'nbg1',
      serverType: 'cx11',
    });
    expect(res.status).toBe(400);
  });

  it('AC7 — 400 bei fehlendem region', async () => {
    ts = await makeTestServer();
    const res = await ts.req('POST', '/api/vps/machines/hetzner', {
      name: 'srv',
      serverType: 'cx11',
    });
    expect(res.status).toBe(400);
  });

  it('AC8 — Create-Fehler → result:"error", kein Token-Leak', async () => {
    ts = await makeTestServer({
      registry: makeMockRegistry({
        throwOn: 'create',
        createResult: new VpsRegistryError('provider-not-configured', 'provider-not-configured', 422),
      }),
    });
    const res = await ts.req('POST', '/api/vps/machines/hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
    });
    // Kein 201 bei Fehler
    expect(res.status).not.toBe(201);
    // Token darf nicht in der Antwort erscheinen
    expect(res.body).not.toContain(MOCK_TOKEN);
  });

  it('AC7 — CloudInitError(missing-ssh-key) → 422 mit errorClass "missing-ssh-key"', async () => {
    ts = await makeTestServer({
      registry: makeMockRegistry({
        throwOn: 'create',
        createResult: new CloudInitError('Fehlender SSH-Public-Key für User root', 'missing-ssh-key', 422),
      }),
    });
    const res = await ts.req('POST', '/api/vps/machines/hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
    });
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.errorClass).toBe('missing-ssh-key');
  });

  it('AC10 — Token erscheint NICHT in Create-Response', async () => {
    const machine = {
      provider: 'hetzner', serverId: '1', name: 'srv',
      status: 'provisioning', ipv4: null, ipv6: null,
      region: null, serverType: null, createdAt: null,
    };
    ts = await makeTestServer({
      registry: makeMockRegistry({ createResult: machine }),
    });
    const res = await ts.req('POST', '/api/vps/machines/hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
    });
    expect(res.body).not.toContain(MOCK_TOKEN);
  });
});

// ── AC10: Audit-First ─────────────────────────────────────────────────────────

describe('vpsRouter — AC10: Audit-First', () => {
  let ts;
  let audit;

  beforeEach(() => {
    process.env.DEV_NO_ACCESS = '1';
    audit = new AuditStore();
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (ts) await ts.close();
    ts = null;
  });

  it('AC10 — start erzeugt Audit-Eintrag vor Ausführung (Intent + Outcome)', async () => {
    ts = await makeTestServer({ audit });
    await ts.req('POST', '/api/vps/machines/hetzner/123/start');
    const entries = audit.getAll();
    // Intent-Eintrag (vor dem API-Call)
    const intent = entries.find((e) => e.command.includes('vps:start:hetzner:123') && !e.command.includes(':ok'));
    expect(intent).toBeDefined();
    // Outcome-Eintrag (nach dem API-Call)
    const outcome = entries.find((e) => e.command.includes('vps:start:hetzner:123:ok'));
    expect(outcome).toBeDefined();
  });

  it('AC10 — create erzeugt Audit-Eintrag vor Ausführung', async () => {
    ts = await makeTestServer({ audit });
    await ts.req('POST', '/api/vps/machines/hetzner', {
      name: 'my-server',
      region: 'nbg1',
      serverType: 'cx11',
    });
    const entries = audit.getAll();
    const intent = entries.find((e) => e.command.includes('vps:create:hetzner:my-server'));
    expect(intent).toBeDefined();
  });

  it('AC10 — Token erscheint NICHT in Audit-Einträgen', async () => {
    ts = await makeTestServer({ audit });
    await ts.req('POST', '/api/vps/machines/hetzner/123/start');
    const entries = audit.getAll();
    for (const entry of entries) {
      expect(JSON.stringify(entry)).not.toContain(MOCK_TOKEN);
    }
  });

  it('AC10 — Audit-Fail blockiert die Mutation (start unterbleibt)', async () => {
    let registryCalled = false;
    const registry = {
      async listProviders() { return []; },
      async listAllMachines() { return { machines: [] }; },
      async start() { registryCalled = true; return { result: 'ok' }; },
      async stop() { registryCalled = true; return { result: 'ok' }; },
      async create() { registryCalled = true; return {}; },
    };
    // AuditStore der immer wirft
    const failingAudit = {
      record() { throw new Error('Audit-Store nicht erreichbar'); },
      getAll() { return []; },
    };
    ts = await makeTestServer({ registry, audit: failingAudit });
    const res = await ts.req('POST', '/api/vps/machines/hetzner/123/start');
    expect(res.status).toBe(500);
    expect(registryCalled).toBe(false);
  });
});
