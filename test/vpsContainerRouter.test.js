/**
 * vpsContainerRouter.test.js — Tests für Container-Übersicht + Aktionen (S-157, S-352).
 *
 * Covers (vps-container-overview):
 *   AC8  — GET /api/vps/machines/:provider/*splat/containers → ContainerEntry[]; SSH-Fehler
 *          degradiert; `state` wird durchgereicht (gestoppter Container → state:'exited', v2, S-352)
 *   AC9  — VpsDockerControl.start/stop/restart/logs + Container-ID-Validierung + secret-freie Fehler
 *   AC10 — POST .../start|stop|restart → VpsDockerControl-Methode; GET .../logs → read-only
 *   AC11 — DELETE .../containers/:id: managed → undeploy; unmanaged → rm; protected → 422
 *   AC12 — AccessGuard-403 (ohne Access); CRED_ADMIN_EMAILS-403 für Mutationen; Audit-First
 *   AC13 — Kein SSH-Key/Token in Response; Fehlertexte secret-frei
 *
 * Strategie:
 *   - VpsDockerControl als Mock injiziert (kein SSH-I/O)
 *   - DeployOrchestrator als Mock injiziert
 *   - AuditStore real (in-memory)
 *   - AccessGuard mit DEV_NO_ACCESS=1 für Nicht-403-Tests
 *   - vpsTargets: Map mit einem Test-Eintrag
 *   - vpsRegistry: Mock (getMachineIp gibt IP zurück)
 */

import { describe, it, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { vpsContainerRouter } from '../src/vpsContainerRouter.js';
import { AuditStore } from '../src/AuditStore.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_KEY = 'FAKE_SSH_KEY_SHOULD_NOT_LEAK';
const FAKE_CF_TOKEN = 'FAKE_CF_TOKEN_SHOULD_NOT_LEAK';

const TEST_VPS_TARGET = { host: '1.2.3.4', port: 22, targetUser: 'root' };

const MANAGED_CONTAINER = {
  containerId: 'abc123def456',
  image: 'ghcr.io/org/app:v1',
  hostname: 'app.example.com',
  state: 'running',
  status: 'Up 2 hours',
  hostPort: 8080,
  composeProject: null,
  managed: true,
};

const UNMANAGED_CONTAINER = {
  containerId: 'fff000eee111',
  image: 'nginx:latest',
  hostname: null,
  state: 'running',
  status: 'Up 1 hour',
  hostPort: 80,
  composeProject: null,
  managed: false,
};

const STOPPED_MANAGED_CONTAINER = {
  containerId: 'stopped777',
  image: 'ghcr.io/org/app:v1',
  hostname: 'app.example.com',
  state: 'exited',
  status: 'Exited (0) 3 hours ago',
  hostPort: null,
  composeProject: null,
  managed: true,
};

// ── Mock-Factories ─────────────────────────────────────────────────────────────

function makeMockDockerControl({
  psAllResult = { result: 'ok', containers: [MANAGED_CONTAINER, UNMANAGED_CONTAINER] },
  startResult = { result: 'ok' },
  stopResult = { result: 'ok' },
  restartResult = { result: 'ok' },
  logsResult = { result: 'ok', lines: ['line1', 'line2'] },
  rmResult = { result: 'ok' },
  onPsAll = null,
  onStart = null,
  onStop = null,
  onRestart = null,
  onLogs = null,
  onRm = null,
} = {}) {
  return {
    async psAll(_vps, _opts) {
      if (onPsAll) onPsAll(_vps, _opts);
      return psAllResult;
    },
    async start(_vps, containerId, _opts) {
      if (onStart) onStart(containerId);
      return startResult;
    },
    async stop(_vps, containerId, _opts) {
      if (onStop) onStop(containerId);
      return stopResult;
    },
    async restart(_vps, containerId, _opts) {
      if (onRestart) onRestart(containerId);
      return restartResult;
    },
    async logs(_vps, containerId, opts) {
      if (onLogs) onLogs(containerId, opts);
      return logsResult;
    },
    async rm(_vps, containerId, _opts) {
      if (onRm) onRm(containerId);
      return rmResult;
    },
  };
}

function makeMockOrchestrator({
  undeployResult = { result: 'ok' },
  onUndeploy = null,
} = {}) {
  return {
    async undeploy(params) {
      if (onUndeploy) onUndeploy(params);
      return undeployResult;
    },
  };
}

function makeMockRegistry({ machineIp = '1.2.3.4' } = {}) {
  return {
    async getMachineIp(_provider, _serverId) {
      return machineIp;
    },
  };
}

// ── Test-Server-Fabrik ─────────────────────────────────────────────────────────

async function makeTestServer({
  dockerControl,
  orchestrator,
  audit,
  registry,
  vpsTargets,
  env = {},
} = {}) {
  // Umgebungsvariablen setzen
  const origEnv = {};
  for (const [k, v] of Object.entries(env)) {
    origEnv[k] = process.env[k];
    process.env[k] = v;
  }

  const app = express();
  app.use(express.json());

  // AccessGuard (DEV_NO_ACCESS=1 → keine Access-Prüfung, trotzdem identity gesetzt)
  const guard = createAccessGuard();
  app.use('/api', guard);

  const auditInstance = audit ?? new AuditStore();
  const targets = vpsTargets ?? new Map([['test-vps', TEST_VPS_TARGET]]);

  const router = vpsContainerRouter({
    vpsDockerControl: dockerControl ?? makeMockDockerControl(),
    deployOrchestrator: orchestrator ?? makeMockOrchestrator(),
    auditStore: auditInstance,
    vpsRegistry: registry ?? makeMockRegistry(),
    vpsTargets: targets,
  });
  app.use(router);

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  function doRequest({ method = 'GET', path, body = null, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const bodyStr = body !== null ? JSON.stringify(body) : null;
      const opts = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(bodyStr ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
          } : {}),
          ...headers,
        },
      };
      const req = httpRequest(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async function cleanup() {
    await new Promise((resolve) => server.close(resolve));
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  return { doRequest, cleanup, auditInstance, port };
}

// ── AC8: Container-Listing (GET /api/vps/machines/:provider/*splat/containers) ──

describe('vpsContainerRouter — AC8: Container-Listing', () => {
  let server;

  afterEach(async () => {
    if (server) await server.cleanup();
  });

  it('liefert Container-Liste managed + unmanaged', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
    });
    const { status, body } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers',
    });
    expect(status).toBe(200);
    expect(body.result).toBe('ok');
    expect(Array.isArray(body.containers)).toBe(true);
    expect(body.containers).toHaveLength(2);

    const managed = body.containers.find((c) => c.containerId === MANAGED_CONTAINER.containerId);
    expect(managed.managed).toBe(true);
    expect(managed.hostname).toBe('app.example.com');

    const unmanaged = body.containers.find((c) => c.containerId === UNMANAGED_CONTAINER.containerId);
    expect(unmanaged.managed).toBe(false);
    expect(unmanaged.hostname).toBeNull();
  });

  it('I1 — name-Feld: Container-Name aus name-Property übernommen, Fallback auf containerId', async () => {
    // Wenn psAll einen Container mit name-Feld liefert → name-Feld im ContainerEntry.
    // Ohne name-Feld → containerId als Fallback.
    const containerWithName = { ...MANAGED_CONTAINER, name: 'my-app-container' };
    const containerWithoutName = { ...UNMANAGED_CONTAINER }; // kein name-Feld
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [containerWithName, containerWithoutName] },
      }),
    });
    const { status, body } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers',
    });
    expect(status).toBe(200);
    expect(body.result).toBe('ok');

    const withName = body.containers.find((c) => c.containerId === MANAGED_CONTAINER.containerId);
    expect(withName.name).toBe('my-app-container'); // name aus name-Property

    const withoutName = body.containers.find((c) => c.containerId === UNMANAGED_CONTAINER.containerId);
    expect(withoutName.name).toBe(UNMANAGED_CONTAINER.containerId); // Fallback auf containerId
  });

  it('S-352 AC8 — state-Feld wird durchgereicht: gestoppter Container ist in der Antwort enthalten und trägt state:"exited"', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER, STOPPED_MANAGED_CONTAINER] },
      }),
    });
    const { status, body } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers',
    });
    expect(status).toBe(200);
    expect(body.result).toBe('ok');
    expect(body.containers).toHaveLength(2);

    const running = body.containers.find((c) => c.containerId === MANAGED_CONTAINER.containerId);
    expect(running.state).toBe('running');

    const stopped = body.containers.find((c) => c.containerId === STOPPED_MANAGED_CONTAINER.containerId);
    expect(stopped).toBeDefined(); // gestoppter Container ist enthalten (kein Verschwinden)
    expect(stopped.state).toBe('exited');
    expect(stopped.managed).toBe(true); // managed-Prädikat unabhängig vom state (AC9b)
  });

  it('IONOS composite serverId via *splat', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
    });
    const { status, body } = await server.doRequest({
      path: '/api/vps/machines/ionos/dc-123/srv-456/containers',
    });
    expect(status).toBe(200);
    expect(body.result).toBe('ok');
  });

  it('SSH-Fehler → degradierend { result:"error", errorClass, reason }', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'error', errorClass: 'unreachable', reason: 'VPS-Ziel nicht erreichbar' },
      }),
    });
    const { status, body } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers',
    });
    expect(status).toBe(200); // degradierend, kein 5xx
    expect(body.result).toBe('error');
    expect(body.errorClass).toBe('unreachable');
  });

  it('SSH-Fehler enthält keinen Private-Key (AC13)', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'error', errorClass: 'auth-failed', reason: 'SSH-Auth fehlgeschlagen' },
      }),
    });
    const { body } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers',
    });
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(body)).not.toContain(FAKE_CF_TOKEN);
  });

  it('ungültiger Provider → 422', async () => {
    server = await makeTestServer({ env: { DEV_NO_ACCESS: '1' } });
    const { status } = await server.doRequest({
      path: '/api/vps/machines/invalid-provider/1/containers',
    });
    expect(status).toBe(422);
  });
});

// ── AC10: GET .../logs ─────────────────────────────────────────────────────────

describe('vpsContainerRouter — AC10: Logs (read-only)', () => {
  let server;

  afterEach(async () => {
    if (server) await server.cleanup();
  });

  it('liefert Log-Zeilen read-only', async () => {
    server = await makeTestServer({ env: { DEV_NO_ACCESS: '1' } });
    const { status, body } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/logs',
    });
    expect(status).toBe(200);
    expect(body.result).toBe('ok');
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.lines).toContain('line1');
  });

  it('tail-Parameter wird an VpsDockerControl.logs weitergegeben', async () => {
    let capturedTail = null;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        onLogs: (_containerId, opts) => { capturedTail = opts?.tail; },
      }),
    });
    await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/logs?tail=50',
    });
    expect(capturedTail).toBe(50);
  });

  it('AC13 — kein SSH-Key in Log-Response', async () => {
    server = await makeTestServer({ env: { DEV_NO_ACCESS: '1' } });
    const { body } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/logs',
    });
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(body)).not.toContain(FAKE_CF_TOKEN);
  });

  it('ungültige containerId (Sonderzeichen) → 422', async () => {
    server = await makeTestServer({ env: { DEV_NO_ACCESS: '1' } });
    // containerId mit Sonderzeichen — URL-encoded
    const { status } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers/abc%3Brm-rf/logs',
    });
    expect(status).toBe(422);
  });
});

// ── AC10: POST start/stop/restart ─────────────────────────────────────────────

describe('vpsContainerRouter — AC10: start/stop/restart', () => {
  let server;

  afterEach(async () => {
    if (server) await server.cleanup();
  });

  it('POST .../start ruft VpsDockerControl.start mit containerId auf', async () => {
    let capturedId = null;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        onStart: (id) => { capturedId = id; },
      }),
    });
    const { status, body } = await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/start',
    });
    expect(status).toBe(200);
    expect(body.result).toBe('ok');
    expect(capturedId).toBe('abc123def456');
  });

  it('POST .../stop → VpsDockerControl.stop', async () => {
    let capturedId = null;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        onStop: (id) => { capturedId = id; },
      }),
    });
    const { status } = await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/stop',
    });
    expect(status).toBe(200);
    expect(capturedId).toBe('abc123def456');
  });

  it('POST .../restart → VpsDockerControl.restart', async () => {
    let capturedId = null;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        onRestart: (id) => { capturedId = id; },
      }),
    });
    const { status } = await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/restart',
    });
    expect(status).toBe(200);
    expect(capturedId).toBe('abc123def456');
  });

  it('ungültige containerId (Sonderzeichen) → 422', async () => {
    server = await makeTestServer({ env: { DEV_NO_ACCESS: '1' } });
    // containerId mit Sonderzeichen (URL-encoded Semikolon + Punkt)
    const { status } = await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc%3Becho%20malicious/start',
    });
    expect(status).toBe(422);
  });
});

// ── AC11: DELETE (managed → undeploy; unmanaged → rm; protected → 422) ────────

describe('vpsContainerRouter — AC11: Container entfernen', () => {
  let server;

  afterEach(async () => {
    if (server) await server.cleanup();
  });

  it('unmanaged Container → VpsDockerControl.rm (kein Cloudflare-Schritt)', async () => {
    let rmCalled = false;
    let undeployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [UNMANAGED_CONTAINER] },
        onRm: () => { rmCalled = true; },
      }),
      orchestrator: makeMockOrchestrator({
        onUndeploy: () => { undeployCalled = true; },
      }),
    });
    const { status, body } = await server.doRequest({
      method: 'DELETE',
      path: `/api/vps/machines/hetzner/1/containers/${UNMANAGED_CONTAINER.containerId}`,
      body: { confirm: UNMANAGED_CONTAINER.containerId },
    });
    expect(status).toBe(200);
    expect(body.result).toBe('ok');
    expect(rmCalled).toBe(true);
    expect(undeployCalled).toBe(false); // kein Cloudflare-Schritt (AC7)
  });

  it('managed Container + tunnelId → DeployOrchestrator.undeploy aufgerufen', async () => {
    let undeployParams = null;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
      }),
      orchestrator: makeMockOrchestrator({
        onUndeploy: (params) => { undeployParams = params; },
      }),
      registry: {
        async getMachineIp() { return '1.2.3.4'; },
        async getTunnelIdForHost() { return 'tunnel-abc'; },
      },
    });
    const { status, body } = await server.doRequest({
      method: 'DELETE',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}`,
      body: { confirm: MANAGED_CONTAINER.hostname },
    });
    expect(status).toBe(200);
    expect(body.result).toBe('ok');
    expect(undeployParams).not.toBeNull();
    expect(undeployParams.hostname).toBe(MANAGED_CONTAINER.hostname);
    expect(undeployParams.confirm).toBe(MANAGED_CONTAINER.hostname);
  });

  it('protected Hostname → 422 protected-resource, kein Docker-Schritt', async () => {
    let rmCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        onRm: () => { rmCalled = true; },
      }),
      orchestrator: makeMockOrchestrator({
        undeployResult: { result: 'error', errorClass: 'protected-resource', reason: 'protected-resource' },
      }),
      registry: {
        async getMachineIp() { return '1.2.3.4'; },
        async getTunnelIdForHost() { return 'tunnel-abc'; },
      },
    });
    const { status, body } = await server.doRequest({
      method: 'DELETE',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}`,
      body: { confirm: MANAGED_CONTAINER.hostname },
    });
    expect(status).toBe(422);
    expect(body.errorClass).toBe('protected-resource');
    expect(rmCalled).toBe(false); // kein Docker-Schritt
  });

  it('C1 — managed Container, tunnelId=null, protected Hostname → 422 protected-resource, KEIN rm', async () => {
    // Regression-Guard C1: wenn tunnelId=null bei managed Container, darf der Fallback
    // NICHT am LockoutGuard vorbei vpsDockerControl.rm() aufrufen.
    // Setup: Registry gibt keine tunnelId → tunnelId=null; DEVGUI_HOSTNAME = Hostname des Containers.
    let rmCalled = false;
    let undeployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1', DEVGUI_HOSTNAME: MANAGED_CONTAINER.hostname },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        onRm: () => { rmCalled = true; },
      }),
      orchestrator: makeMockOrchestrator({
        onUndeploy: () => { undeployCalled = true; },
      }),
      registry: {
        async getMachineIp() { return '1.2.3.4'; },
        // getTunnelIdForHost gibt null → kein Tunnel (Fallback-Pfad)
        async getTunnelIdForHost() { return null; },
      },
    });
    const { status, body } = await server.doRequest({
      method: 'DELETE',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}`,
      body: { confirm: MANAGED_CONTAINER.hostname },
    });
    expect(status).toBe(422);
    expect(body.errorClass).toBe('protected-resource');
    // KEIN rm und KEIN undeploy darf aufgerufen worden sein (AC11 bedingungslos)
    expect(rmCalled).toBe(false);
    expect(undeployCalled).toBe(false);
  });

  it('fehlender confirm → 422 confirmation-required', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [UNMANAGED_CONTAINER] },
      }),
    });
    const { status, body } = await server.doRequest({
      method: 'DELETE',
      path: `/api/vps/machines/hetzner/1/containers/${UNMANAGED_CONTAINER.containerId}`,
      body: {}, // kein confirm
    });
    expect(status).toBe(422);
    expect(body.errorClass).toBe('confirmation-required');
  });

  it('falscher confirm → 422 confirmation-required', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [UNMANAGED_CONTAINER] },
      }),
    });
    const { status, body } = await server.doRequest({
      method: 'DELETE',
      path: `/api/vps/machines/hetzner/1/containers/${UNMANAGED_CONTAINER.containerId}`,
      body: { confirm: 'wrong-id' },
    });
    expect(status).toBe(422);
    expect(body.errorClass).toBe('confirmation-required');
  });
});

// ── AC12: AccessGuard + CRED_ADMIN_EMAILS + Audit-First ───────────────────────

describe('vpsContainerRouter — AC12: Sicherheit + Audit', () => {
  let server;

  afterEach(async () => {
    if (server) await server.cleanup();
  });

  it('ohne Access (kein DEV_NO_ACCESS) → 403 für read-only Listing', async () => {
    // DEV_NO_ACCESS ist NICHT gesetzt → AccessGuard greift
    const origVal = process.env.DEV_NO_ACCESS;
    delete process.env.DEV_NO_ACCESS;
    server = await makeTestServer({});
    const { status } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers',
    });
    if (origVal !== undefined) process.env.DEV_NO_ACCESS = origVal;
    expect(status).toBe(403);
  });

  it('ohne CRED_ADMIN_EMAILS-Berechtigung → 403 für mutierende Aktion (start)', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1', CRED_ADMIN_EMAILS: 'admin@example.com' },
      // identity hat keine E-Mail → nicht in admin list
    });
    const { status } = await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/start',
    });
    expect(status).toBe(403);
  });

  it('ohne CRED_ADMIN_EMAILS-Berechtigung → 403 für stop', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1', CRED_ADMIN_EMAILS: 'admin@example.com' },
    });
    const { status } = await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/stop',
    });
    expect(status).toBe(403);
  });

  it('ohne CRED_ADMIN_EMAILS-Berechtigung → 403 für restart', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1', CRED_ADMIN_EMAILS: 'admin@example.com' },
    });
    const { status } = await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/restart',
    });
    expect(status).toBe(403);
  });

  it('ohne CRED_ADMIN_EMAILS-Berechtigung → 403 für remove', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1', CRED_ADMIN_EMAILS: 'admin@example.com' },
    });
    const { status } = await server.doRequest({
      method: 'DELETE',
      path: '/api/vps/machines/hetzner/1/containers/abc123def456',
      body: { confirm: 'abc123def456' },
    });
    expect(status).toBe(403);
  });

  it('read-only (Listing) hat KEINEN Rollencheck — kein 403 ohne Admin', async () => {
    // CRED_ADMIN_EMAILS gesetzt, aber GET /containers ist read-only (kein Rollencheck)
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1', CRED_ADMIN_EMAILS: 'admin@example.com' },
    });
    const { status, body } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers',
    });
    expect(status).toBe(200);
    expect(body.result).toBe('ok');
  });

  it('read-only (Logs) hat KEINEN Rollencheck', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1', CRED_ADMIN_EMAILS: 'admin@example.com' },
    });
    const { status } = await server.doRequest({
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/logs',
    });
    expect(status).toBe(200);
  });

  it('Audit-First: Audit-Eintrag wird vor der Mutation geschrieben', async () => {
    const auditStore = new AuditStore();
    const entries = [];
    const origRecord = auditStore.record.bind(auditStore);

    let dockerCalled = false;
    // Audit-Eintrag verfolgen
    auditStore.record = (entry) => {
      entries.push({ ...entry, dockerAlreadyCalled: dockerCalled });
      return origRecord(entry);
    };

    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      audit: auditStore,
      dockerControl: makeMockDockerControl({
        onStart: () => { dockerCalled = true; },
      }),
    });

    await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/start',
    });

    // Audit-Eintrag muss existieren
    expect(entries.length).toBeGreaterThan(0);
    // Audit-Eintrag VOR der Docker-Mutation (Audit-First)
    const actionEntry = entries.find((e) => e.command?.includes('start'));
    expect(actionEntry).toBeDefined();
    expect(actionEntry.dockerAlreadyCalled).toBe(false); // Audit VOR Docker
  });

  it('Audit-First: Audit-Fail → Aktion unterbleibt (500)', async () => {
    const auditStore = new AuditStore();
    auditStore.record = () => { throw new Error('Audit-Store-Fehler'); };

    let dockerCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      audit: auditStore,
      dockerControl: makeMockDockerControl({
        onStart: () => { dockerCalled = true; },
      }),
    });

    const { status } = await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/start',
    });

    expect(status).toBe(500);
    expect(dockerCalled).toBe(false); // Aktion unterbleibt
  });

  it('I2 — Audit-String enthält keinen Slash aus IONOS composite serverId', async () => {
    // IONOS serverId "dc-123/srv-456" darf im Audit-String nicht als Pfad erscheinen.
    const auditStore = new AuditStore();
    const entries = [];
    const origRecord = auditStore.record.bind(auditStore);
    auditStore.record = (entry) => {
      entries.push(entry);
      return origRecord(entry);
    };

    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      audit: auditStore,
    });

    await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/ionos/dc-123/srv-456/containers/abc123def456/start',
    });

    expect(entries.length).toBeGreaterThan(0);
    const actionEntry = entries.find((e) => e.command?.includes('start'));
    expect(actionEntry).toBeDefined();
    // Slash aus IONOS-serverId muss durch ':' ersetzt sein
    expect(actionEntry.command).not.toMatch(/dc-123\/srv-456/);
    expect(actionEntry.command).toContain('dc-123:srv-456');
  });

  it('I3 — DELETE Audit-First: Audit-Eintrag VOR psAll/rm/undeploy', async () => {
    // Analog Audit-First für POST start: Audit muss VOR Docker-Aktionen geschrieben werden.
    const auditStore = new AuditStore();
    const entries = [];
    const origRecord = auditStore.record.bind(auditStore);

    let dockerActionCalled = false;
    auditStore.record = (entry) => {
      entries.push({ ...entry, dockerAlreadyCalled: dockerActionCalled });
      return origRecord(entry);
    };

    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      audit: auditStore,
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [UNMANAGED_CONTAINER] },
        onRm: () => { dockerActionCalled = true; },
      }),
    });

    await server.doRequest({
      method: 'DELETE',
      path: `/api/vps/machines/hetzner/1/containers/${UNMANAGED_CONTAINER.containerId}`,
      body: { confirm: UNMANAGED_CONTAINER.containerId },
    });

    expect(entries.length).toBeGreaterThan(0);
    const actionEntry = entries.find((e) => e.command?.includes('remove'));
    expect(actionEntry).toBeDefined();
    // Audit-Eintrag muss VOR dem Docker-Schritt (rm) geschrieben worden sein
    expect(actionEntry.dockerAlreadyCalled).toBe(false);
  });

  it('I3 — DELETE Audit-Fail → rm unterbleibt (500)', async () => {
    // Analog Audit-Fail für POST start: Audit-Fehler → keine Docker-Aktion.
    const auditStore = new AuditStore();
    auditStore.record = () => { throw new Error('Audit-Store-Fehler'); };

    let rmCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      audit: auditStore,
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [UNMANAGED_CONTAINER] },
        onRm: () => { rmCalled = true; },
      }),
    });

    const { status } = await server.doRequest({
      method: 'DELETE',
      path: `/api/vps/machines/hetzner/1/containers/${UNMANAGED_CONTAINER.containerId}`,
      body: { confirm: UNMANAGED_CONTAINER.containerId },
    });

    expect(status).toBe(500);
    expect(rmCalled).toBe(false); // rm unterbleibt
  });
});

// ── AC9: VpsDockerControl.start/stop/restart/logs — ID-Validierung + secret-frei ─

describe('vpsContainerRouter — AC9: Container-ID-Validierung + secret-freie Fehler', () => {
  let server;

  afterEach(async () => {
    if (server) await server.cleanup();
  });

  it('containerId mit Shell-Injection-Zeichen → 422 (nicht an Docker weitergegeben)', async () => {
    let dockerCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        onStart: () => { dockerCalled = true; },
      }),
    });
    // URL-encode Sonderzeichen damit httpRequest nicht wirft
    const { status } = await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc%3Brm-rf/start',
    });
    expect(status).toBe(422);
    expect(dockerCalled).toBe(false);
  });

  it('Fehlermeldungen (SSH-Fehler) enthalten keinen Private-Key (AC13)', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        startResult: { result: 'error', errorClass: 'auth-failed', reason: 'SSH-Auth fehlgeschlagen' },
      }),
    });
    const { body } = await server.doRequest({
      method: 'POST',
      path: '/api/vps/machines/hetzner/1/containers/abc123def456/start',
    });
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(FAKE_KEY);
    expect(bodyStr).not.toContain(FAKE_CF_TOKEN);
  });
});
