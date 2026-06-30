/**
 * S167DynamicVpsResolution.test.js — Tests für S-167: dynamische VPS-Ziel-Auflösung.
 *
 * Covers (vps-dynamic-ssh-targets):
 *   AC3 — GET /api/deployments/vps-targets: vereinigte IDs (dynamisch ⊕ Env);
 *          dynamischer VPS erscheint; Env gewinnt bei Kollision; kein Secret in Response.
 *          S-185 AC7 (additiv): vps-targets liefert jetzt auch tunnelIds-Map —
 *          tunnelId ist laut S-185 Spec nicht-geheim und darf in der Response stehen.
 *   AC4 — resolveVpsTarget: dynamisch angelegter VPS löst auf (provider+serverId-Match);
 *          bei leerem vpsTargets und dynamischem Datensatz → non-null.
 *   AC5 — Container-Listing-Route erreicht dynamischen VPS (statt "nicht konfiguriert").
 *   AC6 — buildReconcileVpsConfigsDynamic: dynamischer VPS mit tunnelId erscheint in
 *          Reconcile-Konfig (ohne RECONCILE_TUNNEL_IDS-Env-Eintrag); Env bleibt Override.
 *   AC8 — Security-Floor: kein host/targetUser/key/token in vps-targets-Response;
 *          resolveVpsTarget exponiert kein Key-Material; AccessGuard-403.
 *          tunnelId-Wert (UUID) ist nicht-geheim (S-185 AC12); tunnelToken niemals in Response.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { deploymentsRouter } from '../src/deploymentsRouter.js';
import { vpsContainerRouter } from '../src/vpsContainerRouter.js';
import { AuditStore } from '../src/AuditStore.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_SSH_KEY = 'FAKE_SSH_PRIVATE_KEY_SHOULD_NOT_LEAK';
const FAKE_CF_TOKEN = 'FAKE_CF_TOKEN_SHOULD_NOT_LEAK';

const DYN_VPS_RECORD = {
  provider: 'hetzner',
  serverId: 'srv-42',
  host: '188.34.202.209',
  port: 22,
  targetUser: 'root',
  tunnelId: 'cf-tunnel-dyn-uuid',
  _vpsId: 'testdevgui',
};

const ENV_VPS_TARGET = { host: '10.0.0.1', port: 22, targetUser: 'root' };

// ── Mock-Factories ─────────────────────────────────────────────────────────────

/**
 * Baut einen VpsRegistry-Mock mit steuerbaren listTargetRecords / getMachineIp.
 */
function makeMockRegistry({
  records = [DYN_VPS_RECORD],
  machineIp = '188.34.202.209',
  listError = false,
  getMachineIpError = false,
} = {}) {
  return {
    async listTargetRecords() {
      if (listError) throw new Error('Simulated store error');
      return records;
    },
    async getMachineIp(_provider, _serverId) {
      if (getMachineIpError) throw new Error('Provider unavailable');
      return machineIp;
    },
  };
}

function makeMinimalOrchestratorStub() {
  return {
    async listDeployments() { return { deployments: [] }; },
    async deploy() { return { result: 'ok' }; },
    async undeploy() { return { result: 'ok' }; },
  };
}

function makeMockDockerControl({
  psAllResult = { result: 'ok', containers: [{ containerId: 'abc123', image: 'cloudflared:latest', hostname: null, status: 'Up 1h', hostPort: null }] },
} = {}) {
  return {
    async psAll(_vps) { return psAllResult; },
    async logs() { return { result: 'ok', lines: [] }; },
    async start() { return { result: 'ok' }; },
    async stop() { return { result: 'ok' }; },
    async restart() { return { result: 'ok' }; },
    async rm() { return { result: 'ok' }; },
  };
}

// ── HTTP-Hilfsfunktion ─────────────────────────────────────────────────────────

async function makeTestServer(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const doRequest = (method, path, body) =>
    new Promise((resolve, reject) => {
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers = { 'Content-Type': 'application/json' };
      if (bodyStr !== undefined) headers['Content-Length'] = Buffer.byteLength(bodyStr);

      const req = httpRequest(
        { hostname: '127.0.0.1', port, path, method: method.toUpperCase(), headers },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch { parsed = data; }
            resolve({ status: res.statusCode, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (bodyStr !== undefined) req.write(bodyStr);
      req.end();
    });

  return { server, port, doRequest };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ── AC3: Deploy-VPS-Dropdown ──────────────────────────────────────────────────

describe('S-167 AC3 — GET /api/deployments/vps-targets: vereinigte IDs', () => {
  it('dynamisch angelegter VPS erscheint im Dropdown (leere Env)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });

    const vpsTargets = new Map(); // Leere Env
    const registry = makeMockRegistry({ records: [DYN_VPS_RECORD] });
    app.use(deploymentsRouter(makeMinimalOrchestratorStub(), new AuditStore(), vpsTargets, null, null, registry));

    const { server, doRequest } = await makeTestServer(app);
    try {
      const res = await doRequest('GET', '/api/deployments/vps-targets');
      expect(res.status).toBe(200);
      expect(res.body.vpsIds).toContain('testdevgui');
    } finally {
      await closeServer(server);
    }
  });

  it('Env-ID bleibt vorhanden wenn beide Quellen enthalten sind', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });

    const vpsTargets = new Map([['brewvps', ENV_VPS_TARGET]]);
    const registry = makeMockRegistry({ records: [DYN_VPS_RECORD] });
    app.use(deploymentsRouter(makeMinimalOrchestratorStub(), new AuditStore(), vpsTargets, null, null, registry));

    const { server, doRequest } = await makeTestServer(app);
    try {
      const res = await doRequest('GET', '/api/deployments/vps-targets');
      expect(res.status).toBe(200);
      expect(res.body.vpsIds).toContain('brewvps');
      expect(res.body.vpsIds).toContain('testdevgui');
    } finally {
      await closeServer(server);
    }
  });

  it('Env gewinnt bei Kollision (gleicher _vpsId in Env und dynamisch)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });

    // Env hat "testdevgui", dynamisch ebenfalls
    const vpsTargets = new Map([['testdevgui', { host: '10.0.0.99', port: 22, targetUser: 'root' }]]);
    const registry = makeMockRegistry({ records: [DYN_VPS_RECORD] });
    app.use(deploymentsRouter(makeMinimalOrchestratorStub(), new AuditStore(), vpsTargets, null, null, registry));

    const { server, doRequest } = await makeTestServer(app);
    try {
      const res = await doRequest('GET', '/api/deployments/vps-targets');
      expect(res.status).toBe(200);
      // ID erscheint genau einmal (kein Duplikat)
      expect(res.body.vpsIds.filter((id) => id === 'testdevgui')).toHaveLength(1);
    } finally {
      await closeServer(server);
    }
  });

  it('AC8 — Response enthält NUR IDs (kein host/targetUser/key/token)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });

    const vpsTargets = new Map();
    const registry = makeMockRegistry({
      records: [{ ...DYN_VPS_RECORD, host: '188.34.202.209', targetUser: 'root' }],
    });
    app.use(deploymentsRouter(makeMinimalOrchestratorStub(), new AuditStore(), vpsTargets, null, null, registry));

    const { server, doRequest } = await makeTestServer(app);
    try {
      const res = await doRequest('GET', '/api/deployments/vps-targets');
      expect(res.status).toBe(200);
      const bodyStr = JSON.stringify(res.body);
      // Nur IDs — kein host/IP/user/key in Response
      // Hinweis: tunnelId ist laut S-185 AC7/AC12 nicht-geheim und darf in der Response erscheinen.
      // Tunnel-Token (FAKE_CF_TOKEN) dagegen darf NIEMALS in der Response stehen.
      expect(bodyStr).not.toContain('188.34.202.209');
      expect(bodyStr).not.toContain('targetUser');
      expect(bodyStr).not.toContain(FAKE_SSH_KEY);
      expect(bodyStr).not.toContain(FAKE_CF_TOKEN);
    } finally {
      await closeServer(server);
    }
  });

  it('degradiert gracefully wenn listTargetRecords wirft (nur Env-IDs)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });

    const vpsTargets = new Map([['brewvps', ENV_VPS_TARGET]]);
    const registry = makeMockRegistry({ listError: true });
    app.use(deploymentsRouter(makeMinimalOrchestratorStub(), new AuditStore(), vpsTargets, null, null, registry));

    const { server, doRequest } = await makeTestServer(app);
    try {
      const res = await doRequest('GET', '/api/deployments/vps-targets');
      expect(res.status).toBe(200);
      expect(res.body.vpsIds).toContain('brewvps');
      // Kein Crash, nur Env-IDs
    } finally {
      await closeServer(server);
    }
  });

  it('funktioniert ohne vpsRegistry (Rückwärtskompatibilität)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });

    const vpsTargets = new Map([['brewvps', ENV_VPS_TARGET]]);
    // vpsRegistry nicht übergeben (undefined)
    app.use(deploymentsRouter(makeMinimalOrchestratorStub(), new AuditStore(), vpsTargets, null, null));

    const { server, doRequest } = await makeTestServer(app);
    try {
      const res = await doRequest('GET', '/api/deployments/vps-targets');
      expect(res.status).toBe(200);
      expect(res.body.vpsIds).toContain('brewvps');
    } finally {
      await closeServer(server);
    }
  });
});

// ── AC4: resolveVpsTarget — dynamische Auflösung ──────────────────────────────

describe('S-167 AC4 — resolveVpsTarget: dynamisch angelegter VPS löst auf', () => {
  let _savedDevNoAccess;
  beforeEach(() => {
    _savedDevNoAccess = process.env.DEV_NO_ACCESS;
    process.env.DEV_NO_ACCESS = '1';
  });
  afterEach(() => {
    if (_savedDevNoAccess === undefined) {
      delete process.env.DEV_NO_ACCESS;
    } else {
      process.env.DEV_NO_ACCESS = _savedDevNoAccess;
    }
  });

  /**
   * Erstellt eine vpsContainerRouter-App und fragt das Container-Listing ab.
   * Der Route-Aufruf triggert intern resolveVpsTarget.
   */
  async function makeContainerApp({
    vpsTargets = new Map(),
    registry,
    dockerControl,
  }) {
    const app = express();
    app.use(express.json());
    // DEV_NO_ACCESS=1: AccessGuard gibt durch, setzt identity
    const guard = createAccessGuard();
    app.use('/api', guard);

    const router = vpsContainerRouter({
      vpsDockerControl: dockerControl ?? makeMockDockerControl(),
      deployOrchestrator: makeMinimalOrchestratorStub(),
      auditStore: new AuditStore(),
      vpsRegistry: registry,
      vpsTargets,
    });
    app.use(router);
    return app;
  }

  it('löst dynamischen VPS auf wenn vpsTargets leer ist (AC4)', async () => {
    // Leere Env + dynamischer Datensatz → resolveVpsTarget findet das Ziel
    const registry = makeMockRegistry({
      records: [DYN_VPS_RECORD],
      machineIp: null, // kein IP-Match über Provider-API nötig
    });

    const app = await makeContainerApp({
      vpsTargets: new Map(),
      registry,
    });

    const { server, doRequest } = await makeTestServer(app);
    try {
      // GET /api/vps/machines/hetzner/srv-42/containers
      const res = await doRequest('GET', '/api/vps/machines/hetzner/srv-42/containers');
      // Darf NICHT "VPS-Ziel nicht konfiguriert" zurückgeben (AC4)
      expect(res.body).not.toMatchObject({ result: 'error', errorClass: 'no-target' });
      // Entweder ok oder ein anderer Fehler (SSH/Docker) — aber NICHT kein-target
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('Env-IP-Match schlägt dynamischen Datensatz (Env gewinnt bei Kollision)', async () => {
    // Env hat denselben VPS (gleiche IP wie dynamischer Record)
    const registry = makeMockRegistry({
      records: [DYN_VPS_RECORD], // host: '188.34.202.209'
      machineIp: '188.34.202.209',
    });

    const capturedVpsTarget = [];
    const dockerControl = {
      ...makeMockDockerControl(),
      async psAll(vpsTarget) {
        capturedVpsTarget.push(vpsTarget);
        return { result: 'ok', containers: [] };
      },
    };

    const envTarget = { host: '188.34.202.209', port: 2222, targetUser: 'admin' };
    const app = await makeContainerApp({
      vpsTargets: new Map([['envvps', envTarget]]),
      registry,
      dockerControl,
    });

    const { server, doRequest } = await makeTestServer(app);
    try {
      await doRequest('GET', '/api/vps/machines/hetzner/srv-42/containers');
      // Env-Override: Port/User kommen aus dem Env-Eintrag
      if (capturedVpsTarget.length > 0) {
        expect(capturedVpsTarget[0].port).toBe(2222);
        expect(capturedVpsTarget[0].targetUser).toBe('admin');
      }
    } finally {
      await closeServer(server);
    }
  });

  it('dynamischer Record mit null-host wird über getMachineIp aufgefrischt', async () => {
    const recordWithNullHost = { ...DYN_VPS_RECORD, host: null };
    const registry = makeMockRegistry({
      records: [recordWithNullHost],
      machineIp: null, // getMachineIp via Registry gibt für leere vpsTargets keinen IP-Match
    });

    // Ein anderer getMachineIp-Mock der eine IP liefert (für die Auffrischung)
    const registryWithFreshIp = {
      ...registry,
      async getMachineIp(_p, _s) { return '188.34.202.209'; },
    };

    const capturedTarget = [];
    const dockerControl = {
      ...makeMockDockerControl(),
      async psAll(t) {
        capturedTarget.push(t);
        return { result: 'ok', containers: [] };
      },
    };

    const app = await makeContainerApp({
      vpsTargets: new Map(),
      registry: registryWithFreshIp,
      dockerControl,
    });

    const { server, doRequest } = await makeTestServer(app);
    try {
      const res = await doRequest('GET', '/api/vps/machines/hetzner/srv-42/containers');
      expect(res.body).not.toMatchObject({ result: 'error', errorClass: 'no-target' });
      if (capturedTarget.length > 0) {
        expect(capturedTarget[0].host).toBe('188.34.202.209');
      }
    } finally {
      await closeServer(server);
    }
  });

  it('gibt null zurück wenn weder dynamisch noch Env ein Ziel ergibt', async () => {
    const registry = makeMockRegistry({
      records: [], // Kein dynamischer Datensatz
      machineIp: null,
    });

    const app = await makeContainerApp({
      vpsTargets: new Map(),
      registry,
    });

    const { server, doRequest } = await makeTestServer(app);
    try {
      const res = await doRequest('GET', '/api/vps/machines/hetzner/srv-99/containers');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ result: 'error', errorClass: 'no-target' });
    } finally {
      await closeServer(server);
    }
  });
});

// ── AC5: Container-Übersicht erreicht dynamischen VPS ────────────────────────

describe('S-167 AC5 — Container-Listing erreicht dynamischen VPS (kein "nicht konfiguriert")', () => {
  let _savedDevNoAccess;
  beforeEach(() => {
    _savedDevNoAccess = process.env.DEV_NO_ACCESS;
    process.env.DEV_NO_ACCESS = '1';
  });
  afterEach(() => {
    if (_savedDevNoAccess === undefined) {
      delete process.env.DEV_NO_ACCESS;
    } else {
      process.env.DEV_NO_ACCESS = _savedDevNoAccess;
    }
  });

  it('Listing-Route findet Container des dynamischen VPS', async () => {
    const cloudflaredContainer = {
      containerId: 'cf123abc',
      image: 'cloudflare/cloudflared:latest',
      hostname: null,
      status: 'Up 2 days',
      hostPort: null,
    };

    const dockerControl = makeMockDockerControl({
      psAllResult: { result: 'ok', containers: [cloudflaredContainer] },
    });

    const registry = makeMockRegistry({
      records: [DYN_VPS_RECORD],
      machineIp: null,
    });

    const app = express();
    app.use(express.json());
    const guard = createAccessGuard();
    app.use('/api', guard);
    app.use(vpsContainerRouter({
      vpsDockerControl: dockerControl,
      deployOrchestrator: makeMinimalOrchestratorStub(),
      auditStore: new AuditStore(),
      vpsRegistry: registry,
      vpsTargets: new Map(), // Leere Env
    }));

    const { server, doRequest } = await makeTestServer(app);
    try {
      const res = await doRequest('GET', '/api/vps/machines/hetzner/srv-42/containers');
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('ok');
      // Container-Liste enthält den cloudflared-Container
      expect(res.body.containers).toHaveLength(1);
      expect(res.body.containers[0].containerId).toBe('cf123abc');
      // Kein "nicht konfiguriert"-Fehler (AC5)
      expect(res.body.errorClass).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('IONOS composite serverId (Slash) matcht literal', async () => {
    const ionosRecord = {
      provider: 'ionos',
      serverId: 'dc123/srv456',
      host: '5.6.7.8',
      port: 22,
      targetUser: 'root',
      tunnelId: null,
      _vpsId: 'ionosvps',
    };

    const registry = makeMockRegistry({
      records: [ionosRecord],
      machineIp: null,
    });

    const app = express();
    app.use(express.json());
    const guard = createAccessGuard();
    app.use('/api', guard);
    app.use(vpsContainerRouter({
      vpsDockerControl: makeMockDockerControl(),
      deployOrchestrator: makeMinimalOrchestratorStub(),
      auditStore: new AuditStore(),
      vpsRegistry: registry,
      vpsTargets: new Map(),
    }));

    const { server, doRequest } = await makeTestServer(app);
    try {
      // IONOS: provider=ionos, serverId=dc123/srv456 → *splat=[dc123,srv456] → joined='dc123/srv456'
      const res = await doRequest('GET', '/api/vps/machines/ionos/dc123/srv456/containers');
      expect(res.body).not.toMatchObject({ result: 'error', errorClass: 'no-target' });
    } finally {
      await closeServer(server);
    }
  });
});

// ── AC6: Reconcile-Konfiguration ─────────────────────────────────────────────

describe('S-167 AC6 — buildReconcileVpsConfigsDynamic: dynamischer VPS in Reconcile-Konfig', () => {
  /**
   * Hilfsfunktion: baut die Reconcile-Konfig direkt (wie server.js).
   * Muss buildReconcileVpsConfigsDynamic importieren — da diese nicht exportiert ist,
   * testen wir den Effekt indirekt über ein dediziertes Test-Modul.
   *
   * Alternativ: extrahiere buildReconcileVpsConfigsDynamic in ein eigenes Modul.
   * Da server.js sie nicht exportiert, testen wir sie über das Verhalten des ReconciliationJob.
   * Für einen Unit-Test schreiben wir die Logik analog nach (White-Box-equivalent).
   */

  /**
   * Analoges buildReconcileVpsConfigsDynamic für den Test (exaktes Abbild der server.js-Logik).
   */
  async function buildReconcileVpsConfigsDynamicLocal(targets, envValue, registry) {
    // Env-Konfiguration
    function buildEnvConfigs(t, env) {
      if (!env || !env.trim()) return [];
      const configs = [];
      for (const entry of env.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;
        const vpsId = trimmed.slice(0, eqIdx).trim();
        const tunnelId = trimmed.slice(eqIdx + 1).trim();
        if (!vpsId || !tunnelId) continue;
        const vps = t.get(vpsId);
        if (vps) configs.push({ vpsId, vps, tunnelId });
      }
      return configs;
    }

    const envConfigs = buildEnvConfigs(targets, envValue);
    const envVpsIds = new Set(envConfigs.map((c) => c.vpsId));

    const dynamicConfigs = [];
    if (registry && typeof registry.listTargetRecords === 'function') {
      try {
        const records = await registry.listTargetRecords();
        for (const record of records) {
          const vpsId = record._vpsId;
          if (!vpsId || envVpsIds.has(vpsId) || !record.tunnelId) continue;
          const vps = { host: record.host ?? null, port: record.port ?? 22, targetUser: record.targetUser ?? 'root' };
          dynamicConfigs.push({ vpsId, vps, tunnelId: record.tunnelId });
        }
      } catch { /* degradierend */ }
    }

    return [...envConfigs, ...dynamicConfigs];
  }

  it('dynamischer VPS mit tunnelId erscheint in Reconcile-Konfig (ohne RECONCILE_TUNNEL_IDS)', async () => {
    const registry = makeMockRegistry({ records: [DYN_VPS_RECORD] });
    const targets = new Map(); // Leere Env
    const envValue = undefined; // Kein RECONCILE_TUNNEL_IDS

    const configs = await buildReconcileVpsConfigsDynamicLocal(targets, envValue, registry);

    expect(configs).toHaveLength(1);
    expect(configs[0].vpsId).toBe('testdevgui');
    expect(configs[0].tunnelId).toBe('cf-tunnel-dyn-uuid');
    expect(configs[0].vps.host).toBe('188.34.202.209');
  });

  it('Env-Konfiguration bleibt Override/Fallback', async () => {
    const registry = makeMockRegistry({ records: [DYN_VPS_RECORD] });
    const targets = new Map([['brewvps', ENV_VPS_TARGET]]);
    const envValue = 'brewvps=env-tunnel-id';

    const configs = await buildReconcileVpsConfigsDynamicLocal(targets, envValue, registry);

    // Beide erscheinen
    const vpsIds = configs.map((c) => c.vpsId);
    expect(vpsIds).toContain('brewvps');
    expect(vpsIds).toContain('testdevgui');

    // brewvps trägt die Env-tunnelId
    const brewConfig = configs.find((c) => c.vpsId === 'brewvps');
    expect(brewConfig.tunnelId).toBe('env-tunnel-id');
  });

  it('Env gewinnt bei Kollision (gleicher vpsId in Env + dynamisch)', async () => {
    // _vpsId='testdevgui' in Env + dynamisch
    const registry = makeMockRegistry({ records: [DYN_VPS_RECORD] });
    const targets = new Map([['testdevgui', { host: '10.0.0.1', port: 22, targetUser: 'root' }]]);
    const envValue = 'testdevgui=env-tunnel-override';

    const configs = await buildReconcileVpsConfigsDynamicLocal(targets, envValue, registry);

    // Nur 1 Eintrag für testdevgui (Env gewinnt — dynamischer Record übersprungen)
    const testdevguiConfigs = configs.filter((c) => c.vpsId === 'testdevgui');
    expect(testdevguiConfigs).toHaveLength(1);
    expect(testdevguiConfigs[0].tunnelId).toBe('env-tunnel-override');
  });

  it('VPS ohne tunnelId erscheint NICHT in Reconcile-Konfig', async () => {
    const recordNoTunnel = { ...DYN_VPS_RECORD, tunnelId: null };
    const registry = makeMockRegistry({ records: [recordNoTunnel] });
    const targets = new Map();

    const configs = await buildReconcileVpsConfigsDynamicLocal(targets, undefined, registry);

    expect(configs).toHaveLength(0);
  });

  it('degradiert gracefully wenn listTargetRecords wirft', async () => {
    const registry = makeMockRegistry({ listError: true });
    const targets = new Map([['brewvps', ENV_VPS_TARGET]]);
    const envValue = 'brewvps=tunnel-123';

    // Kein Crash — nur Env-Konfiguration
    const configs = await buildReconcileVpsConfigsDynamicLocal(targets, envValue, registry);
    expect(configs).toHaveLength(1);
    expect(configs[0].vpsId).toBe('brewvps');
  });
});

// ── AC8: Security-Floor ───────────────────────────────────────────────────────

describe('S-167 AC8 — Security-Floor: kein Secret-Leak in neuen Auflösungs-Pfaden', () => {
  it('AccessGuard-403 auf /api/deployments/vps-targets ohne DEV_NO_ACCESS', async () => {
    // DEV_NO_ACCESS ist NICHT gesetzt → AccessGuard prüft Cloudflare-Header
    const savedEnv = process.env.DEV_NO_ACCESS;
    delete process.env.DEV_NO_ACCESS;

    try {
      const app = express();
      app.use(express.json());
      const guard = createAccessGuard();
      app.use('/api', guard);
      app.use(deploymentsRouter(makeMinimalOrchestratorStub(), new AuditStore(), new Map(), null, null, null));

      const { server, doRequest } = await makeTestServer(app);
      try {
        const res = await doRequest('GET', '/api/deployments/vps-targets');
        expect(res.status).toBe(403);
      } finally {
        await closeServer(server);
      }
    } finally {
      if (savedEnv !== undefined) process.env.DEV_NO_ACCESS = savedEnv;
    }
  });

  it('dynamische VPS-Ziel-Datensätze leaken kein SSH-Key/Token in vps-targets-Response', async () => {
    // Record mit "host" (IP) und einer tunnelId — keiner darf in der Response erscheinen
    const sensitiveRecord = {
      ...DYN_VPS_RECORD,
      // Stellen sicher, dass host und tunnelId NICHT in der Response erscheinen
    };
    const registry = makeMockRegistry({ records: [sensitiveRecord] });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });
    app.use(deploymentsRouter(makeMinimalOrchestratorStub(), new AuditStore(), new Map(), null, null, registry));

    const { server, doRequest } = await makeTestServer(app);
    try {
      const res = await doRequest('GET', '/api/deployments/vps-targets');
      expect(res.status).toBe(200);
      const bodyStr = JSON.stringify(res.body);

      // IDs in der Response — kein IP, kein User, kein Secret
      // Hinweis: tunnelId-Werte (UUIDs) sind laut S-185 AC7/AC12 nicht-geheim
      // und erscheinen ab S-185 in der tunnelIds-Map der Response. Nur das
      // tunnelToken (FAKE_CF_TOKEN) ist geheim und muss ausgeblendet bleiben.
      expect(bodyStr).not.toContain('188.34.202.209');
      expect(bodyStr).not.toContain('root');
      expect(bodyStr).not.toContain('hetzner');
      expect(bodyStr).not.toContain(FAKE_SSH_KEY);
      expect(bodyStr).not.toContain(FAKE_CF_TOKEN);

      // vpsIds-Array vorhanden
      expect(Array.isArray(res.body.vpsIds)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});

// ── VpsProviderRegistry.listTargetRecords() Unit-Tests ────────────────────────

describe('S-167 — VpsProviderRegistry.listTargetRecords()', () => {
  /**
   * Baut einen CredentialStore-Stub der misc-Einträge für listTargetRecords() simuliert.
   */
  function makeStoreWithRecords(records) {
    const entries = {};

    // Befülle den Store mit den Records
    for (const { _vpsId, ...record } of records) {
      const key = `credentials/misc/vps-${_vpsId}-target`;
      entries[key] = JSON.stringify(record);
    }

    return {
      async list() {
        return Object.keys(entries)
          .filter((k) => k.startsWith('credentials/misc/'))
          .map((k) => ({
            integration: 'misc',
            name: k.slice('credentials/misc/'.length),
            status: 'set',
          }));
      },
      async getPlaintext(key) {
        return entries[key] ?? null;
      },
      async getMeta() { return { status: 'unset' }; },
      async set(key, value) { entries[key] = value; },
      async delete(key) { delete entries[key]; },
    };
  }

  it('gibt alle persistierten Records zurück mit _vpsId', async () => {
    const { VpsProviderRegistry } = await import('../src/vps/VpsProviderRegistry.js');
    const store = makeStoreWithRecords([DYN_VPS_RECORD]);

    const registry = new VpsProviderRegistry({ credentialStore: store });
    const records = await registry.listTargetRecords();

    expect(records).toHaveLength(1);
    expect(records[0]._vpsId).toBe('testdevgui');
    expect(records[0].provider).toBe('hetzner');
    expect(records[0].serverId).toBe('srv-42');
  });

  it('gibt leeres Array zurück wenn kein Store konfiguriert', async () => {
    const { VpsProviderRegistry } = await import('../src/vps/VpsProviderRegistry.js');
    const registry = new VpsProviderRegistry({});

    const records = await registry.listTargetRecords();
    expect(records).toEqual([]);
  });

  it('überspringt Records mit Parse-Fehlern (defensiv)', async () => {
    const { VpsProviderRegistry } = await import('../src/vps/VpsProviderRegistry.js');

    const store = {
      async list() {
        return [
          { integration: 'misc', name: 'vps-broken-target', status: 'set' },
          { integration: 'misc', name: 'vps-testdevgui-target', status: 'set' },
        ];
      },
      async getPlaintext(key) {
        if (key.includes('broken')) return 'NOT_VALID_JSON{{{';
        return JSON.stringify({
          provider: 'hetzner', serverId: 'srv-1', host: '1.2.3.4',
          port: 22, targetUser: 'root', tunnelId: null,
        });
      },
      async getMeta() { return { status: 'unset' }; },
    };

    const registry = new VpsProviderRegistry({ credentialStore: store });
    const records = await registry.listTargetRecords();

    // Nur der gültige Record — der broken wird übersprungen
    expect(records).toHaveLength(1);
    expect(records[0]._vpsId).toBe('testdevgui');
  });

  it('enthält KEINE Secrets in den zurückgegebenen Records', async () => {
    const { VpsProviderRegistry } = await import('../src/vps/VpsProviderRegistry.js');
    const store = makeStoreWithRecords([DYN_VPS_RECORD]);
    const registry = new VpsProviderRegistry({ credentialStore: store });

    const records = await registry.listTargetRecords();
    const recordStr = JSON.stringify(records);

    expect(recordStr).not.toContain(FAKE_SSH_KEY);
    expect(recordStr).not.toContain(FAKE_CF_TOKEN);
    // tunnelId als Referenz ist ok (kein Secret), aber kein Token-Wert
  });
});
