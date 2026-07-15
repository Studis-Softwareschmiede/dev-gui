/**
 * vpsContainerRouter.test.js — Tests für Container-Übersicht + Aktionen (S-157, S-352, S-355, S-359, S-360).
 *
 * Covers (vps-container-overview):
 *   AC8  — GET /api/vps/machines/:provider/*splat/containers → ContainerEntry[]; SSH-Fehler
 *          degradiert; `state` wird durchgereicht (gestoppter Container → state:'exited', v2, S-352)
 *   AC9  — VpsDockerControl.start/stop/restart/logs + Container-ID-Validierung + secret-freie Fehler
 *   AC10 — POST .../start|stop|restart → VpsDockerControl-Methode; GET .../logs → read-only
 *   AC11 — DELETE .../containers/:id: managed → undeploy; unmanaged → rm; protected → 422;
 *          tunnelId für den managed-Undeploy-Pfad kommt seit S-359 additiv aus
 *          resolveVpsTarget()/dem Target-Record (kein separater Host-basierter Lookup mehr)
 *   AC11b — (S-360) managed-Remove ist fail-closed bzgl. Route: tunnelId nicht auflösbar (und
 *          nicht protected) → 422 tunnel-not-found, rm-Mock NIE aufgerufen, kein undeploy;
 *          kein stiller Rückfall auf reines VpsDockerControl.rm mehr (Alt-Verhalten entfernt);
 *          auflösbare tunnelId → undeploy inkl. tunnelId-Weitergabe; unmanaged unverändert → rm.
 *          Reihenfolge unverändert: LockoutGuard (C1) greift weiterhin VOR der tunnelId-Prüfung.
 *   AC12 — AccessGuard-403 (ohne Access); CRED_ADMIN_EMAILS-403 für Mutationen; Audit-First
 *   AC13 — Kein SSH-Key/Token in Response; Fehlertexte secret-frei
 *
 * Covers (container-image-update, S-355/S-356/S-359):
 *   AC1  — POST .../update: pull + recreate über DeployOrchestrator.deploy() mit unverändertem
 *          Image-Ref; Erfolg → { result:'ok', deployment }
 *   AC2  — Nie `docker restart`/VpsDockerControl.restart im Update-Pfad (grep-prüfbar)
 *   AC3  — Unmanaged Container (kein Hostname-Label) → 422 not-managed, keine Mutation
 *   AC4  — mitgesendetes Image/Tag im Body wird ignoriert — Bestands-Ref bestimmt den Deploy
 *   AC7  — Fail-closed vor jeder Mutation: inspectContainer-Fehler, Container-not-found,
 *          tunnelId nicht auflösbar (S-359: inkl. Edge-Case "VPS nur über Env-Ziele auflösbar",
 *          kein Target-Record → tunnelId bleibt null), Run-Config ambiguous (update-unsafe)
 *          → kein pull/rm/run (die 404-container-not-found-Variante deckt zugleich den
 *          Spec-Edge-Case "zwei Updates gleichzeitig" ab: die zweite Anfrage trifft auf den
 *          bereits entfernten Altcontainer und endet hier, ohne dass deploy() erneut
 *          aufgerufen wird)
 *   AC8  — gestoppter Container (state:'exited'): Update ist zulässig, kein Block/Gate auf den
 *          Zustand, Ergebnis weist den laufenden Container aus (S-356; AC9/pull-"up to date"
 *          ist Saga-Verhalten und in test/DeployOrchestrator.test.js belegt, S-356)
 *   AC10 — 403 ohne Berechtigung; Audit-First inkl. hostname (Audit-Write folgt dem reinen
 *          Container-Read/psAll, da hostname erst dort bekannt wird; Audit-Fail → 500, keine
 *          Mutation; abgelehnte Versuche wie unmanaged werden nicht auditiert, S-355 Iteration 2)
 *   AC11 — LockoutGuard: protected Hostname → 422 protected-resource, kein Schritt
 *   AC12 — Env-Werte aus inspectContainer erscheinen nie in Response/Audit
 *   AC13 — (S-359, Kernfix) tunnelId wird server-seitig über `listTargetRecords({provider,
 *          serverId})` aufgelöst (Target-Record derselben Registrierung wie Host/Port/User),
 *          kein Host-basierter Lookup mehr — der tote `resolveTunnelId`-Hilfsfunktions-Pfad
 *          ist ersatzlos entfernt (grep-prüfbar, AC15 aus der Spec).
 *   AC14 — (S-359) `deploy()` erhält `vpsId` aus demselben Target-Record wie `tunnelId` — das
 *          Tunnel-Mismatch/-Missing-Gate des DeployOrchestrator greift damit statt still
 *          übersprungen zu werden.
 *
 * Strategie:
 *   - VpsDockerControl als Mock injiziert (kein SSH-I/O)
 *   - DeployOrchestrator als Mock injiziert
 *   - AuditStore real (in-memory)
 *   - AccessGuard mit DEV_NO_ACCESS=1 für Nicht-403-Tests
 *   - vpsTargets: Map mit einem Test-Eintrag
 *   - vpsRegistry: Mock (getMachineIp gibt IP zurück für den Env-Match-Zweig; für tunnelId/
 *     vpsId-Auflösung mockt `makeRegistryWithTargetRecord`/`makeRegistryWithTunnel` gezielt
 *     `listTargetRecords({provider,serverId})` — die einzige reale Registry-Oberfläche, AC15)
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
  inspectContainerResult = {
    result: 'ok',
    config: { image: MANAGED_CONTAINER.image, env: {}, binds: [], labels: { 'cloudflare.tunnel-hostname': MANAGED_CONTAINER.hostname } },
  },
  onPsAll = null,
  onStart = null,
  onStop = null,
  onRestart = null,
  onLogs = null,
  onRm = null,
  onInspectContainer = null,
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
    async inspectContainer(_vps, containerId, _opts) {
      if (onInspectContainer) onInspectContainer(containerId);
      return inspectContainerResult;
    },
  };
}

function makeMockOrchestrator({
  undeployResult = { result: 'ok' },
  deployResult = {
    result: 'ok',
    deployment: { vps: '1.2.3.4', hostname: MANAGED_CONTAINER.hostname, image: MANAGED_CONTAINER.image, containerId: 'new123', hostPort: 8080, containerPort: 8080, status: 'running', routePresent: true, containerPresent: true, replaced: true },
  },
  onUndeploy = null,
  onDeploy = null,
} = {}) {
  return {
    async undeploy(params) {
      if (onUndeploy) onUndeploy(params);
      return undeployResult;
    },
    async deploy(params) {
      if (onDeploy) onDeploy(params);
      return deployResult;
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

/**
 * Registry-Mock mit auflösbarer tunnelId über den Target-Record-Weg (AC13, container-image-update)
 * — bewusst KEIN getMachineIp, sonst würde der Env-Match-Zweig (Default-vpsTargets führen denselben
 * Host) mit tunnelId:null gewinnen. Provider/serverId matchen die Standard-Testpfade `hetzner`/`1`.
 */
function makeRegistryWithTargetRecord({ tunnelId = 'tunnel-abc', vpsId = 'test-vps' } = {}) {
  return {
    async listTargetRecords() {
      return [{ provider: 'hetzner', serverId: '1', host: '1.2.3.4', port: 22, targetUser: 'root', tunnelId, _vpsId: vpsId }];
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
      registry: makeRegistryWithTargetRecord({ tunnelId: 'tunnel-abc' }),
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
    expect(undeployParams.tunnelId).toBe('tunnel-abc'); // AC11b: undeploy inkl. Route-Abbau
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
      registry: makeRegistryWithTargetRecord({ tunnelId: 'tunnel-abc' }),
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
    // Regression-Guard C1: bei tunnelId=null MUSS der LockoutGuard weiterhin VOR der
    // tunnelId-Prüfung greifen (Reihenfolge unverändert durch S-360) — protected-resource
    // gewinnt, nicht tunnel-not-found; kein rm/undeploy in beiden Fällen.
    // Setup: Default-Registry (kein listTargetRecords) → Env-Match-Zweig liefert tunnelId:null
    // (kein Target-Record, AC7-Edge-Case); DEVGUI_HOSTNAME = Hostname des Containers.
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
      registry: makeMockRegistry(),
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

  it('AC11b — managed Container, tunnelId nicht auflösbar (nicht protected) → 422 tunnel-not-found, KEIN rm, KEIN undeploy', async () => {
    // AC11b (vps-container-overview): fail-closed statt stillem Fallback auf reines
    // VpsDockerControl.rm. Registry ohne listTargetRecords + Env-Match-Zweig ohne
    // tunnelId → tunnelId bleibt null; Hostname ist NICHT protected (kein DEVGUI_HOSTNAME),
    // damit dieser Test den tunnel-not-found-Pfad prüft und nicht den bereits von C1
    // abgedeckten protected-resource-Pfad.
    let rmCalled = false;
    let undeployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        onRm: () => { rmCalled = true; },
      }),
      orchestrator: makeMockOrchestrator({
        onUndeploy: () => { undeployCalled = true; },
      }),
      registry: makeMockRegistry(),
    });
    const { status, body } = await server.doRequest({
      method: 'DELETE',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}`,
      body: { confirm: MANAGED_CONTAINER.hostname },
    });
    expect(status).toBe(422);
    expect(body.errorClass).toBe('tunnel-not-found');
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

// ── container-image-update AC1/AC2/AC3/AC4/AC7/AC10/AC11/AC12 (S-355) ───────────

/** Alias auf makeRegistryWithTargetRecord (Update-Testsektion, historischer Name beibehalten). */
function makeRegistryWithTunnel(tunnelId = 'tunnel-abc', vpsId = 'test-vps') {
  return makeRegistryWithTargetRecord({ tunnelId, vpsId });
}

const SECRET_ENV_VALUE = 'GPG_PASSPHRASE_SHOULD_NOT_LEAK';

describe('vpsContainerRouter — container-image-update: POST .../update', () => {
  let server;

  afterEach(async () => {
    if (server) await server.cleanup();
  });

  // ── AC1: Erfolg — pull + recreate über DeployOrchestrator.deploy() ──────────

  it('AC1 — managed Container: deploy() wird mit unverändertem Image-Ref aufgerufen, Erfolg → { result:"ok", deployment }', async () => {
    let deployParams = null;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        inspectContainerResult: {
          result: 'ok',
          config: { image: MANAGED_CONTAINER.image, env: {}, binds: [], labels: { 'cloudflare.tunnel-hostname': MANAGED_CONTAINER.hostname } },
        },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: (params) => { deployParams = params; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(200);
    expect(body.result).toBe('ok');
    expect(body.deployment).toBeDefined();
    expect(deployParams).not.toBeNull();
    expect(deployParams.image).toBe(MANAGED_CONTAINER.image); // unveränderter Bestands-Ref
    expect(deployParams.hostname).toBe(MANAGED_CONTAINER.hostname);
    expect(deployParams.tunnelId).toBe('tunnel-abc');
    expect(deployParams.vpsId).toBe('test-vps'); // AC14: vpsId aus demselben Target-Record
  });

  // ── AC13/AC14: tunnelId + vpsId aus dem Target-Record durchgereicht (S-359) ──

  it('AC13 — tunnelId wird über listTargetRecords({provider,serverId}) aufgelöst, kein Host-Lookup', async () => {
    let deployParams = null;
    let listTargetRecordsCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        inspectContainerResult: {
          result: 'ok',
          config: { image: MANAGED_CONTAINER.image, env: {}, binds: [], labels: { 'cloudflare.tunnel-hostname': MANAGED_CONTAINER.hostname } },
        },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: (params) => { deployParams = params; },
      }),
      registry: {
        async listTargetRecords() {
          listTargetRecordsCalled = true;
          return [{ provider: 'hetzner', serverId: '1', host: '1.2.3.4', port: 22, targetUser: 'root', tunnelId: 'tunnel-xyz', _vpsId: 'vps-one' }];
        },
      },
    });

    const { status } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(200);
    expect(listTargetRecordsCalled).toBe(true);
    expect(deployParams.tunnelId).toBe('tunnel-xyz');
    expect(deployParams.vpsId).toBe('vps-one');
  });

  it('AC14 — Registrierung ohne tunnelId im Target-Record (tunnelId:null) → 422 tunnel-not-found, kein deploy()', async () => {
    let deployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      registry: {
        async listTargetRecords() {
          return [{ provider: 'hetzner', serverId: '1', host: '1.2.3.4', port: 22, targetUser: 'root', tunnelId: null, _vpsId: 'vps-one' }];
        },
      },
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(422);
    expect(body.errorClass).toBe('tunnel-not-found');
    expect(deployCalled).toBe(false);
  });

  it('AC6/AC12 — Env des Bestands-Containers wird an deploy() als containerEnv durchgereicht, ohne in der Response zu erscheinen', async () => {
    let deployParams = null;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        inspectContainerResult: {
          result: 'ok',
          config: {
            image: MANAGED_CONTAINER.image,
            env: { GPG_PASSPHRASE: SECRET_ENV_VALUE },
            binds: [],
            labels: { 'cloudflare.tunnel-hostname': MANAGED_CONTAINER.hostname },
          },
        },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: (params) => { deployParams = params; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(200);
    expect(deployParams.containerEnv).toEqual({ GPG_PASSPHRASE: SECRET_ENV_VALUE });
    // AC12: Env-Wert erscheint NIE in der Response
    expect(JSON.stringify(body)).not.toContain(SECRET_ENV_VALUE);
  });

  // ── AC8 (container-image-update, S-356): gestoppter Container läuft danach ──

  it('AC8 — gestoppter Container (state:"exited"): Update ist zulässig, deploy() wird aufgerufen, Ergebnis weist den laufenden Container aus', async () => {
    // Der Update-Handler prüft container.state an keiner Stelle (kein Gate/Block für
    // gestoppte Container) — die Saga (DeployOrchestrator.deploy → docker run) startet den
    // neu aufgebauten Container unabhängig vom Vorzustand des Altcontainers immer.
    let deployParams = null;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [STOPPED_MANAGED_CONTAINER] },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: (params) => { deployParams = params; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${STOPPED_MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(200);
    expect(body.result).toBe('ok');
    expect(deployParams).not.toBeNull(); // kein Block/Gate auf state:'exited'
    expect(body.deployment.status).toBe('running'); // Saga startet den Container (AC8)
  });

  // ── AC2: Nie docker restart im Update-Pfad ───────────────────────────────────

  it('AC2 — VpsDockerControl.restart wird im Update-Pfad zu keinem Zeitpunkt aufgerufen', async () => {
    let restartCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        onRestart: () => { restartCalled = true; },
      }),
      orchestrator: makeMockOrchestrator(),
      registry: makeRegistryWithTunnel(),
    });

    await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(restartCalled).toBe(false);
  });

  it('AC2 — Grep-Beleg: der Update-Routen-Handler im Quelltext ruft nirgends .restart( auf', async () => {
    // Grep-prüfbar (Spec-Wortlaut AC2): isoliert den Router-Handler-Block für die
    // /update-Route und stellt sicher, dass darin kein `.restart(`-Aufruf vorkommt.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/vpsContainerRouter.js', import.meta.url), 'utf8');
    const startIdx = src.indexOf("router.post('/api/vps/machines/:provider/*splat/containers/:containerId/update'");
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = src.indexOf("// ── Shared Handler: start/stop/restart", startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const updateHandlerSrc = src.slice(startIdx, endIdx);
    expect(updateHandlerSrc).not.toMatch(/\.restart\(/);
  });

  // ── AC3: Nur managed ──────────────────────────────────────────────────────────

  it('AC3 — unmanaged Container (kein Hostname-Label) → 422 not-managed, keine Mutation', async () => {
    let deployCalled = false;
    let inspectCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [UNMANAGED_CONTAINER] },
        onInspectContainer: () => { inspectCalled = true; },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${UNMANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(422);
    expect(body.errorClass).toBe('not-managed');
    expect(inspectCalled).toBe(false);
    expect(deployCalled).toBe(false);
  });

  // ── AC4: Client-Image/Tag wird ignoriert ─────────────────────────────────────

  it('AC4 — im Body mitgesendetes Image/Tag wird ignoriert, deploy() erhält den Bestands-Ref', async () => {
    let deployParams = null;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        inspectContainerResult: {
          result: 'ok',
          config: { image: MANAGED_CONTAINER.image, env: {}, binds: [], labels: { 'cloudflare.tunnel-hostname': MANAGED_CONTAINER.hostname } },
        },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: (params) => { deployParams = params; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
      body: { image: 'ghcr.io/evil/other:latest', tag: 'latest', tunnelId: 'fremde-tunnel-id' },
    });

    expect(status).toBe(200);
    expect(deployParams.image).toBe(MANAGED_CONTAINER.image);
    expect(deployParams.image).not.toBe('ghcr.io/evil/other:latest');
    expect(deployParams.tunnelId).not.toBe('fremde-tunnel-id');
  });

  // ── AC7: Fail-closed vor jeder Mutation ──────────────────────────────────────

  it('AC7 — Container nicht (mehr) vorhanden → 404 container-not-found, keine Mutation', async () => {
    let deployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [] }, // Container zwischenzeitlich weg
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(404);
    expect(body.errorClass).toBe('container-not-found');
    expect(deployCalled).toBe(false);
  });

  it('AC7 — inspectContainer schlägt fehl → 502, keine Mutation (kein deploy())', async () => {
    let deployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        inspectContainerResult: { result: 'error', errorClass: 'docker-failed', reason: 'docker-Kommando fehlgeschlagen' },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(502);
    expect(body.errorClass).toBe('docker-failed');
    expect(deployCalled).toBe(false);
  });

  it('AC7 — VPS nur über Env-Ziele auflösbar (kein Target-Record) → 422 tunnel-not-found, kein Fallback-Deploy', async () => {
    let deployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      // Default-Registry hat KEIN listTargetRecords → Env-Match-Zweig greift, tunnelId bleibt
      // null (AC7-Edge-Case: VPS nur über Env-Ziele auflösbar, kein Target-Record).
      registry: makeMockRegistry(),
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(422);
    expect(body.errorClass).toBe('tunnel-not-found');
    expect(deployCalled).toBe(false);
  });

  it('AC7 — Run-Config nicht eindeutig abbildbar (mehrere Binds) → 422 update-unsafe, kein deploy()', async () => {
    let deployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        inspectContainerResult: {
          result: 'ok',
          config: {
            image: MANAGED_CONTAINER.image,
            env: {},
            binds: ['/home/user/apps/app1/config:/app/config', '/home/user/apps/app2/config:/app/config2'],
            labels: { 'cloudflare.tunnel-hostname': MANAGED_CONTAINER.hostname },
          },
        },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(422);
    expect(body.errorClass).toBe('update-unsafe');
    expect(deployCalled).toBe(false);
  });

  // ── AC10: Authz + Audit-First ─────────────────────────────────────────────────

  it('AC10 — ohne CRED_ADMIN_EMAILS-Berechtigung → 403, keine Mutation', async () => {
    let deployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1', CRED_ADMIN_EMAILS: 'admin@example.com' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(403);
    expect(deployCalled).toBe(false);
  });

  it('AC10 — Audit-First: Audit-Eintrag enthält hostname und wird NACH psAll (Hostname-Auflösung, reiner Read) aber VOR inspectContainer/LockoutGuard/deploy geschrieben', async () => {
    // Iteration-2-Fix: AC10 verlangt hostname im Audit-Eintrag — der ist erst nach dem
    // Container-Read (psAll) bekannt. psAll ist ein reiner Read, "Audit-First" bleibt im
    // Sinne der AC gewahrt: der Eintrag liegt weiterhin VOR jeder Mutation.
    const auditStore = new AuditStore();
    const entries = [];
    const origRecord = auditStore.record.bind(auditStore);
    let inspectCalled = false;
    let deployCalled = false;

    auditStore.record = (entry) => {
      entries.push({ ...entry, inspectAlreadyCalled: inspectCalled, deployAlreadyCalled: deployCalled });
      return origRecord(entry);
    };

    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      audit: auditStore,
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        onInspectContainer: () => { inspectCalled = true; },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(entries.length).toBeGreaterThan(0);
    const actionEntry = entries.find((e) => e.command?.includes('update'));
    expect(actionEntry).toBeDefined();
    expect(actionEntry.command).toContain(MANAGED_CONTAINER.hostname); // AC10: hostname im Audit-Eintrag
    expect(actionEntry.inspectAlreadyCalled).toBe(false); // Audit VOR inspectContainer
    expect(actionEntry.deployAlreadyCalled).toBe(false); // Audit VOR deploy() (VOR LockoutGuard)
  });

  it('AC10 — Audit-Fail → 500, keine Mutation (psAll bereits gelaufen — reiner Read; kein inspectContainer/deploy)', async () => {
    const auditStore = new AuditStore();
    auditStore.record = () => { throw new Error('Audit-Store-Fehler'); };

    let psAllCalled = false;
    let inspectCalled = false;
    let deployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      audit: auditStore,
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        onPsAll: () => { psAllCalled = true; },
        onInspectContainer: () => { inspectCalled = true; },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(500);
    expect(psAllCalled).toBe(true); // reiner Read, läuft VOR dem (fehlschlagenden) Audit-Write
    expect(inspectCalled).toBe(false); // aber keine weitere Aktion danach
    expect(deployCalled).toBe(false); // insbesondere keine Mutation
  });

  it('AC10 — Audit-Fail bei unmanaged Container: kein Audit-Write nötig (Ablehnung vor Audit), keine Mutation', async () => {
    // unmanaged Container wird VOR dem Audit-Write abgelehnt (kein hostname zum Auditieren
    // nötig) — der Audit-Store wird für diesen abgelehnten Versuch gar nicht aufgerufen.
    const auditStore = new AuditStore();
    let auditCalled = false;
    const origRecord = auditStore.record.bind(auditStore);
    auditStore.record = (entry) => { auditCalled = true; return origRecord(entry); };

    let deployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      audit: auditStore,
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [UNMANAGED_CONTAINER] },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${UNMANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(422);
    expect(body.errorClass).toBe('not-managed');
    expect(auditCalled).toBe(false); // kein Audit-Eintrag für abgelehnten (nicht-mutierenden) Versuch
    expect(deployCalled).toBe(false);
  });

  // ── AC11: LockoutGuard ────────────────────────────────────────────────────────

  it('AC11 — protected Hostname (DEVGUI_HOSTNAME) → 422 protected-resource, kein deploy()', async () => {
    let deployCalled = false;
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1', DEVGUI_HOSTNAME: MANAGED_CONTAINER.hostname },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
      }),
      orchestrator: makeMockOrchestrator({
        onDeploy: () => { deployCalled = true; },
      }),
      registry: makeRegistryWithTunnel(),
    });

    const { status, body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(status).toBe(422);
    expect(body.errorClass).toBe('protected-resource');
    expect(deployCalled).toBe(false);
  });

  // ── AC12: Kein Leak ───────────────────────────────────────────────────────────

  it('AC12 — Env-Werte aus inspectContainer erscheinen nie im Audit-Eintrag', async () => {
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
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        inspectContainerResult: {
          result: 'ok',
          config: {
            image: MANAGED_CONTAINER.image,
            env: { GPG_PASSPHRASE: SECRET_ENV_VALUE },
            binds: [],
            labels: { 'cloudflare.tunnel-hostname': MANAGED_CONTAINER.hostname },
          },
        },
      }),
      orchestrator: makeMockOrchestrator(),
      registry: makeRegistryWithTunnel(),
    });

    await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(JSON.stringify(entry)).not.toContain(SECRET_ENV_VALUE);
    }
  });

  it('AC12 — Fehler-Response bei inspectContainer-Fehlschlag enthält keinen SSH-Key/Token', async () => {
    server = await makeTestServer({
      env: { DEV_NO_ACCESS: '1' },
      dockerControl: makeMockDockerControl({
        psAllResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
        inspectContainerResult: { result: 'error', errorClass: 'auth-failed', reason: 'SSH-Auth fehlgeschlagen' },
      }),
      orchestrator: makeMockOrchestrator(),
      registry: makeRegistryWithTunnel(),
    });

    const { body } = await server.doRequest({
      method: 'POST',
      path: `/api/vps/machines/hetzner/1/containers/${MANAGED_CONTAINER.containerId}/update`,
    });

    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(FAKE_KEY);
    expect(bodyStr).not.toContain(FAKE_CF_TOKEN);
  });
});
