/**
 * deploymentsRouter.test.js — HTTP-Router-Tests für Deploy-Lifecycle-Endpunkte (AC3–AC9).
 *
 * Covers:
 *   AC3  — GET /api/deployments → { deployments: [...] }
 *   AC3  — POST /api/deployments (deploy) → { result: "ok", deployment }
 *   AC4  — POST /api/deployments → route-fail rollback → { result: "error", reason }
 *   AC5  — DELETE /api/deployments/:vps/:hostname → { result: "ok" }
 *   AC6  — DELETE with wrong confirm → 422 confirmation-required
 *   AC7  — Deploy/Undeploy protected hostname → 422 protected-resource
 *   AC8  — Access+Role guard: 403 without CRED_ADMIN_EMAILS match
 *   AC8  — (vps-dynamic-ssh-targets S-169) Security floor: vpsId nur in 422-Meldung, kein host/key/token
 *   AC9  — Audit-First: audit.record() called before any mutation; Audit-Write-Fail → 500 + no action
 *   AC9  — No SSH-Key / CF-Token in any response body
 *   AC9  — (vps-dynamic-ssh-targets S-169) Vereinigte VPS-Auflösung: Env ⊕ dynamisch, Env gewinnt
 *          leere Env + dynamischer VPS → aufgelöst (kein 422); unbekannte ID → 422;
 *          Kollision → Env gewinnt; AccessGuard-403 vor Auflösung
 *   AC4  (vps-readiness-gate) — POST /api/deployments → 422 vps-provisioning bei state != ready
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { deploymentsRouter } from '../src/deploymentsRouter.js';
import { AuditStore } from '../src/AuditStore.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build Express app with deploymentsRouter wired.
 * Identity is injected via req.identity (simulating AccessGuard).
 * vpsRegistry optionally passed for S-169 AC9 vereinigte Auflösung.
 */
function makeApp({
  orchestratorStub,
  auditStore,
  vpsTargets = new Map([['vps-1', { host: '1.2.3.4', port: 22, targetUser: 'root' }]]),
  identity = { email: 'admin@example.com' },
  vpsRegistry = undefined,
} = {}) {
  const app = express();
  app.use(express.json());
  // Inject identity (simulating AccessGuard)
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });
  app.use(deploymentsRouter(orchestratorStub, auditStore, vpsTargets, undefined, undefined, vpsRegistry));
  return app;
}

async function request(app, method, path, body) {
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      // Include Content-Length so express.json() parses body for all methods (incl. DELETE)
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers = { 'Content-Type': 'application/json' };
      if (bodyStr !== undefined) {
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }
      const options = {
        hostname: 'localhost',
        port,
        path,
        method: method.toUpperCase(),
        headers,
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          server.close();
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (bodyStr !== undefined) req.write(bodyStr);
      req.end();
    });
  });
}

/** Standard deploy body — zoneId NOT included (resolved server-side) */
const DEPLOY_BODY = {
  image: 'ghcr.io/org/app:v1',
  vps: 'vps-1',
  hostname: 'app.example.com',
  tunnelId: 'tunnel-abc-123',
};

/** Standard undeploy body — zoneId NOT included (resolved server-side) */
const UNDEPLOY_BODY = {
  confirm: 'app.example.com',
  tunnelId: 'tunnel-abc-123',
};

function makeOrchestratorStub({
  deployResult = { result: 'ok', deployment: { hostname: 'app.example.com', image: 'x', containerId: 'cid', routePresent: true, containerPresent: true } },
  undeployResult = { result: 'ok' },
  listResult = { deployments: [] },
} = {}) {
  return {
    deploy: jest.fn(async () => deployResult),
    undeploy: jest.fn(async () => undeployResult),
    listDeployments: jest.fn(async () => listResult),
  };
}

// ── GET /api/deployments ──────────────────────────────────────────────────────

describe('GET /api/deployments', () => {
  it('200 + { deployments: [] } bei leerer Liste', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'GET', '/api/deployments?vps=vps-1&tunnelId=tun-abc');
    expect(res.status).toBe(200);
    expect(res.body.deployments).toEqual([]);
  });

  it('422 wenn vps query-Parameter fehlt', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'GET', '/api/deployments?tunnelId=tun-abc');
    expect(res.status).toBe(422);
  });

  it('422 wenn tunnelId query-Parameter fehlt', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'GET', '/api/deployments?vps=vps-1');
    expect(res.status).toBe(422);
  });

  it('422 wenn VPS-ID unbekannt', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'GET', '/api/deployments?vps=unknown-vps&tunnelId=tun-abc');
    expect(res.status).toBe(422);
  });

  it('liefert Deployment-Liste vom Orchestrator', async () => {
    const deployments = [
      { vps: '1.2.3.4', hostname: 'app.example.com', routePresent: true, containerPresent: true },
    ];
    const orch = makeOrchestratorStub({ listResult: { deployments } });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'GET', '/api/deployments?vps=vps-1&tunnelId=tun-abc');
    expect(res.status).toBe(200);
    expect(res.body.deployments).toHaveLength(1);
    expect(res.body.deployments[0].hostname).toBe('app.example.com');
  });
});

// ── POST /api/deployments ─────────────────────────────────────────────────────

describe('POST /api/deployments', () => {
  it('AC3: 200 + { result: "ok", deployment } bei erfolgreichem Deploy', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(res.body.deployment).toBeDefined();
  });

  it('400 bei fehlendem image-Feld', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', { ...DEPLOY_BODY, image: '' });
    expect(res.status).toBe(400);
  });

  it('400 bei fehlendem vps-Feld', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', { ...DEPLOY_BODY, vps: '' });
    expect(res.status).toBe(400);
  });

  it('400 bei ungültigem hostname (Shell-Metacharacter)', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', { ...DEPLOY_BODY, hostname: 'app;rm -rf /' });
    expect(res.status).toBe(400);
  });

  it('422 wenn VPS-ID unbekannt', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', { ...DEPLOY_BODY, vps: 'unknown-vps' });
    expect(res.status).toBe(422);
    expect(orch.deploy).not.toHaveBeenCalled();
  });

  it('AC7: 422 protected-resource bei geschütztem Hostname', async () => {
    const orch = makeOrchestratorStub({
      deployResult: { result: 'error', reason: 'protected-resource', errorClass: 'protected-resource' },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('protected-resource');
  });

  it('AC4 (vps-readiness-gate): 422 vps-provisioning wenn VPS noch nicht bereit', async () => {
    const orch = makeOrchestratorStub({
      deployResult: {
        result: 'error',
        errorClass: 'vps-provisioning',
        reason: 'VPS wird noch eingerichtet (Docker installieren) – in ~1–2 Min erneut versuchen',
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(422);
    expect(res.body.errorClass).toBe('vps-provisioning');
    expect(res.body.reason).toMatch(/eingerichtet|versuchen/i);
  });

  it('AC8: 403 wenn CRED_ADMIN_EMAILS gesetzt und Identität nicht in Liste', async () => {
    const old = process.env.CRED_ADMIN_EMAILS;
    process.env.CRED_ADMIN_EMAILS = 'other@example.com';
    try {
      const orch = makeOrchestratorStub();
      // identity is admin@example.com but not in CRED_ADMIN_EMAILS
      const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

      const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
      expect(res.status).toBe(403);
      expect(orch.deploy).not.toHaveBeenCalled();
    } finally {
      if (old === undefined) { delete process.env.CRED_ADMIN_EMAILS; } else { process.env.CRED_ADMIN_EMAILS = old; }
    }
  });

  it('AC9: Audit-First: audit.record() wird VOR deploy() aufgerufen', async () => {
    const callOrder = [];
    const orch = makeOrchestratorStub();
    orch.deploy.mockImplementation(async () => { callOrder.push('deploy'); return { result: 'ok', deployment: {} }; });
    const auditStore = new AuditStore();
    const origRecord = auditStore.record.bind(auditStore);
    auditStore.record = (...args) => { callOrder.push('audit'); return origRecord(...args); };

    const app = makeApp({ orchestratorStub: orch, auditStore });
    await request(app, 'POST', '/api/deployments', DEPLOY_BODY);

    expect(callOrder.indexOf('audit')).toBeLessThan(callOrder.indexOf('deploy'));
  });

  it('AC9: Audit-Write-Fail → 500, deploy() wird NICHT aufgerufen', async () => {
    const orch = makeOrchestratorStub();
    const auditStore = { record: () => { throw new Error('audit storage full'); } };

    const app = makeApp({ orchestratorStub: orch, auditStore });
    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);

    expect(res.status).toBe(500);
    expect(orch.deploy).not.toHaveBeenCalled();
  });

  it('AC9: SSH-Key erscheint NICHT in Response', async () => {
    const pemDummy = ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') + '\nSECRET\n' + ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' ');
    const orch = makeOrchestratorStub({
      deployResult: { result: 'error', reason: `deploy failed: ${pemDummy}`, errorClass: 'error' },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('SECRET');
    expect(bodyStr).not.toContain('PRIVATE KEY');
  });
});

// ── DELETE /api/deployments/:vps/:hostname ────────────────────────────────────

describe('DELETE /api/deployments/:vps/:hostname', () => {
  it('AC5: 200 + { result: "ok" } bei erfolgreichem Undeploy', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(
      app, 'DELETE',
      '/api/deployments/vps-1/app.example.com',
      UNDEPLOY_BODY,
    );
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
  });

  it('AC6: 422 confirmation-required bei fehlendem confirm', async () => {
    const orch = makeOrchestratorStub({
      undeployResult: { result: 'error', reason: 'confirmation-required', errorClass: 'confirmation-required' },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(
      app, 'DELETE',
      '/api/deployments/vps-1/app.example.com',
      { ...UNDEPLOY_BODY, confirm: '' },
    );
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('confirmation-required');
  });

  it('AC6: 422 confirmation-required bei falschem confirm', async () => {
    const orch = makeOrchestratorStub({
      undeployResult: { result: 'error', reason: 'confirmation-required', errorClass: 'confirmation-required' },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(
      app, 'DELETE',
      '/api/deployments/vps-1/app.example.com',
      { ...UNDEPLOY_BODY, confirm: 'wrong.hostname.com' },
    );
    expect(res.status).toBe(422);
  });

  it('AC7: 422 protected-resource bei geschütztem Hostname', async () => {
    const orch = makeOrchestratorStub({
      undeployResult: { result: 'error', reason: 'protected-resource', errorClass: 'protected-resource' },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(
      app, 'DELETE',
      '/api/deployments/vps-1/app.example.com',
      UNDEPLOY_BODY,
    );
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('protected-resource');
  });

  it('AC8: 403 wenn CRED_ADMIN_EMAILS gesetzt und Identität nicht in Liste', async () => {
    const old = process.env.CRED_ADMIN_EMAILS;
    process.env.CRED_ADMIN_EMAILS = 'other@example.com';
    try {
      const orch = makeOrchestratorStub();
      const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

      const res = await request(
        app, 'DELETE',
        '/api/deployments/vps-1/app.example.com',
        UNDEPLOY_BODY,
      );
      expect(res.status).toBe(403);
      expect(orch.undeploy).not.toHaveBeenCalled();
    } finally {
      if (old === undefined) { delete process.env.CRED_ADMIN_EMAILS; } else { process.env.CRED_ADMIN_EMAILS = old; }
    }
  });

  it('AC9: Audit-First für DELETE: audit.record() VOR undeploy() aufgerufen', async () => {
    const callOrder = [];
    const orch = makeOrchestratorStub();
    orch.undeploy.mockImplementation(async () => { callOrder.push('undeploy'); return { result: 'ok' }; });
    const auditStore = new AuditStore();
    const origRecord = auditStore.record.bind(auditStore);
    auditStore.record = (...args) => { callOrder.push('audit'); return origRecord(...args); };

    const app = makeApp({ orchestratorStub: orch, auditStore });
    await request(app, 'DELETE', '/api/deployments/vps-1/app.example.com', UNDEPLOY_BODY);

    const firstAudit = callOrder.indexOf('audit');
    const firstUndeploy = callOrder.indexOf('undeploy');
    expect(firstAudit).toBeLessThan(firstUndeploy);
  });

  it('AC9: Audit-Write-Fail → 500, undeploy() wird NICHT aufgerufen', async () => {
    const orch = makeOrchestratorStub();
    const auditStore = { record: () => { throw new Error('audit storage full'); } };

    const app = makeApp({ orchestratorStub: orch, auditStore });
    const res = await request(app, 'DELETE', '/api/deployments/vps-1/app.example.com', UNDEPLOY_BODY);

    expect(res.status).toBe(500);
    expect(orch.undeploy).not.toHaveBeenCalled();
  });

  it('AC9: Undeploy-Audit enthält image aus Container-Lookup', async () => {
    const capturedAuditCommands = [];
    const orch = makeOrchestratorStub({
      listResult: {
        deployments: [
          { hostname: 'app.example.com', vps: '1.2.3.4', image: 'ghcr.io/org/app:v2', routePresent: true, containerPresent: true },
        ],
      },
    });
    const auditStore = new AuditStore();
    const origRecord = auditStore.record.bind(auditStore);
    auditStore.record = ({ command, ...rest }) => {
      capturedAuditCommands.push(command);
      return origRecord({ command, ...rest });
    };

    const app = makeApp({ orchestratorStub: orch, auditStore });
    await request(app, 'DELETE', '/api/deployments/vps-1/app.example.com', UNDEPLOY_BODY);

    // The first audit entry (Audit-First) must contain the image
    const firstAudit = capturedAuditCommands[0];
    expect(firstAudit).toContain('deploy:remove:');
    expect(firstAudit).toContain('ghcr.io/org/app:v2');
  });

  it('AC9: Undeploy-Audit mit image:unknown wenn Container nicht auffindbar', async () => {
    const capturedAuditCommands = [];
    const orch = makeOrchestratorStub({
      listResult: { deployments: [] }, // no container found
    });
    const auditStore = new AuditStore();
    const origRecord = auditStore.record.bind(auditStore);
    auditStore.record = ({ command, ...rest }) => {
      capturedAuditCommands.push(command);
      return origRecord({ command, ...rest });
    };

    const app = makeApp({ orchestratorStub: orch, auditStore });
    await request(app, 'DELETE', '/api/deployments/vps-1/app.example.com', UNDEPLOY_BODY);

    const firstAudit = capturedAuditCommands[0];
    expect(firstAudit).toContain('image:unknown');
  });

  it('400 bei fehlendem tunnelId im Body', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(
      app, 'DELETE',
      '/api/deployments/vps-1/app.example.com',
      { ...UNDEPLOY_BODY, tunnelId: '' },
    );
    expect(res.status).toBe(400);
  });

  it('422 wenn VPS-ID unbekannt', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(
      app, 'DELETE',
      '/api/deployments/unknown-vps/app.example.com',
      UNDEPLOY_BODY,
    );
    expect(res.status).toBe(422);
    expect(orch.undeploy).not.toHaveBeenCalled();
  });

  it('400 bei ungültigem Hostname-Parameter (Semikolon)', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(
      app, 'DELETE',
      `/api/deployments/vps-1/${encodeURIComponent('bad;hostname')}`,
      UNDEPLOY_BODY,
    );
    // Either 400 (validation) or 422 (not-found) is acceptable — must NOT be 200
    expect(res.status).not.toBe(200);
  });
});

// ── Security: No secret in Response ──────────────────────────────────────────

describe('deploymentsRouter — AC9: Kein Secret in Response', () => {
  it('Cloudflare-Token erscheint nicht in GET-Response (token embedded in error reason via orchestrator)', async () => {
    // Token injected into a simulated error reason from the orchestrator.
    // The router must sanitize it before returning — token must NOT appear in any response property.
    const cfToken = 'Bearer cf-secret-live-token-deadbeef12345678';
    const orch = {
      deploy: jest.fn(),
      undeploy: jest.fn(),
      // listDeployments throws an error whose message contains the token
      listDeployments: jest.fn(async () => {
        throw Object.assign(
          new Error(`Cloudflare call failed: ${cfToken}`),
          { errorClass: 'cloudflare-auth-failed' },
        );
      }),
    };
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'GET', '/api/deployments?vps=vps-1&tunnelId=tun-abc');
    // The router catches the throw and returns a generic 502 — token must not leak
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('cf-secret-live-token-deadbeef12345678');
    expect(bodyStr).not.toContain('Bearer cf-secret');
  });

  it('SSH-Private-Key erscheint nicht in POST-Response (key embedded in deploy error reason)', async () => {
    const pemDummy = '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET_KEY_DATA\n-----END OPENSSH PRIVATE KEY-----';
    const orch = makeOrchestratorStub({
      deployResult: { result: 'error', reason: `deploy failed: ${pemDummy}`, errorClass: 'error' },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('SECRET_KEY_DATA');
    expect(bodyStr).not.toContain('PRIVATE KEY');
  });
});

// ── S-169 AC9: Vereinigte VPS-Auflösung (Env ⊕ dynamisch) ───────────────────

/**
 * Erstellt einen vpsRegistry-Mock mit einer vordefinierten Liste von Target-Records.
 * Simuliert vpsRegistry.listTargetRecords() und optional getMachineIp().
 *
 * @param {Array<object>} records - Simulierte Target-Records (mit _vpsId-Feld)
 * @param {Function|null} getMachineIpFn - Optionale getMachineIp-Implementierung
 */
function makeVpsRegistryMock(records = [], getMachineIpFn = null) {
  const stub = {
    listTargetRecords: jest.fn(async () => records),
  };
  if (getMachineIpFn) {
    stub.getMachineIp = getMachineIpFn;
  }
  return stub;
}

/** Dynamischer VPS-Datensatz für testdevgui (reales Live-Szenario, S-169). */
const DYNAMIC_TESTDEVGUI = {
  _vpsId: 'testdevgui',
  provider: 'hetzner',
  serverId: '142574176',
  host: '188.34.202.209',
  port: 22,
  targetUser: 'root',
  tunnelId: 'devgui-testdevgui',
};

/** Deploy-Body für den dynamischen VPS. */
const DEPLOY_BODY_DYN = {
  image: 'ghcr.io/org/app:v1',
  vps: 'testdevgui',
  hostname: 'app.example.com',
  tunnelId: 'devgui-testdevgui',
};

describe('S-169 AC9: deploymentsRouter — Vereinigte VPS-Auflösung (Env ⊕ dynamisch)', () => {
  // ── GET /api/deployments — Listing ────────────────────────────────────────

  it('AC9: GET /api/deployments — leere Env + dynamischer VPS → aufgelöst, kein 422', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(), // leere Env
      vpsRegistry: registry,
    });

    const res = await request(app, 'GET', '/api/deployments?vps=testdevgui&tunnelId=devgui-testdevgui');
    expect(res.status).toBe(200);
    expect(orch.listDeployments).toHaveBeenCalledWith({
      vps: { host: '188.34.202.209', port: 22, targetUser: 'root' },
      tunnelId: 'devgui-testdevgui',
    });
  });

  it('AC9: GET /api/deployments — Env-Kollision → Env-Ziel gewinnt', async () => {
    const orch = makeOrchestratorStub();
    // Env hat dieselbe vpsId mit anderer IP
    const envTargets = new Map([['testdevgui', { host: '10.0.0.1', port: 22, targetUser: 'root' }]]);
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]); // host 188.34.202.209
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: envTargets,
      vpsRegistry: registry,
    });

    const res = await request(app, 'GET', '/api/deployments?vps=testdevgui&tunnelId=devgui-testdevgui');
    expect(res.status).toBe(200);
    // Env-Eintrag (10.0.0.1) muss gewinnen — nicht der dynamische (188.34.202.209)
    expect(orch.listDeployments).toHaveBeenCalledWith(
      expect.objectContaining({ vps: expect.objectContaining({ host: '10.0.0.1' }) }),
    );
  });

  it('AC9: GET /api/deployments — unbekannte vpsId (in keiner Quelle) → 422', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
    });

    const res = await request(app, 'GET', '/api/deployments?vps=nonexistent&tunnelId=tun-x');
    expect(res.status).toBe(422);
    expect(orch.listDeployments).not.toHaveBeenCalled();
  });

  // ── POST /api/deployments — Deploy ────────────────────────────────────────

  it('AC9: POST /api/deployments — leere Env + dynamischer VPS → Deploy aufgelöst, kein 422', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
    });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY_DYN);
    expect(res.status).toBe(200);
    expect(orch.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ vps: { host: '188.34.202.209', port: 22, targetUser: 'root' } }),
    );
  });

  it('AC9: POST /api/deployments — Env-Kollision → Env-Ziel gewinnt bei Deploy', async () => {
    const orch = makeOrchestratorStub();
    const envTargets = new Map([['testdevgui', { host: '10.0.0.1', port: 22, targetUser: 'alex' }]]);
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: envTargets,
      vpsRegistry: registry,
    });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY_DYN);
    expect(res.status).toBe(200);
    expect(orch.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ vps: expect.objectContaining({ host: '10.0.0.1', targetUser: 'alex' }) }),
    );
  });

  it('AC9: POST /api/deployments — unbekannte vpsId → 422, kein Deploy, Audit unterbleibt', async () => {
    const orch = makeOrchestratorStub();
    const auditStore = new AuditStore();
    const auditSpy = jest.spyOn(auditStore, 'record');
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore,
      vpsTargets: new Map(),
      vpsRegistry: registry,
    });

    const res = await request(app, 'POST', '/api/deployments', { ...DEPLOY_BODY_DYN, vps: 'nonexistent' });
    expect(res.status).toBe(422);
    expect(orch.deploy).not.toHaveBeenCalled();
    // Audit-First gilt NUR wenn VPS aufgelöst wurde; vor der Auflösung kein Audit-Eintrag
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('AC9: POST /api/deployments — AccessGuard-403 vor VPS-Auflösung (Rollencheck zuerst)', async () => {
    const old = process.env.CRED_ADMIN_EMAILS;
    process.env.CRED_ADMIN_EMAILS = 'other@example.com';
    try {
      const orch = makeOrchestratorStub();
      const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
      const app = makeApp({
        orchestratorStub: orch,
        auditStore: new AuditStore(),
        vpsTargets: new Map(),
        vpsRegistry: registry,
        identity: { email: 'admin@example.com' }, // nicht in CRED_ADMIN_EMAILS
      });

      const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY_DYN);
      expect(res.status).toBe(403);
      expect(orch.deploy).not.toHaveBeenCalled();
      expect(registry.listTargetRecords).not.toHaveBeenCalled();
    } finally {
      if (old === undefined) { delete process.env.CRED_ADMIN_EMAILS; } else { process.env.CRED_ADMIN_EMAILS = old; }
    }
  });

  // ── DELETE /api/deployments/:vps/:hostname — Undeploy ─────────────────────

  it('AC9: DELETE /api/deployments — leere Env + dynamischer VPS → Undeploy aufgelöst, kein 422', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
    });

    const res = await request(
      app, 'DELETE',
      '/api/deployments/testdevgui/app.example.com',
      { confirm: 'app.example.com', tunnelId: 'devgui-testdevgui' },
    );
    expect(res.status).toBe(200);
    expect(orch.undeploy).toHaveBeenCalledWith(
      expect.objectContaining({ vps: { host: '188.34.202.209', port: 22, targetUser: 'root' } }),
    );
  });

  it('AC9: DELETE /api/deployments — Env-Kollision → Env-Ziel gewinnt bei Undeploy', async () => {
    const orch = makeOrchestratorStub();
    const envTargets = new Map([['testdevgui', { host: '10.0.0.2', port: 22, targetUser: 'root' }]]);
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: envTargets,
      vpsRegistry: registry,
    });

    const res = await request(
      app, 'DELETE',
      '/api/deployments/testdevgui/app.example.com',
      { confirm: 'app.example.com', tunnelId: 'devgui-testdevgui' },
    );
    expect(res.status).toBe(200);
    expect(orch.undeploy).toHaveBeenCalledWith(
      expect.objectContaining({ vps: expect.objectContaining({ host: '10.0.0.2' }) }),
    );
  });

  it('AC9: DELETE /api/deployments — unbekannte vpsId → 422, Undeploy unterbleibt', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
    });

    const res = await request(
      app, 'DELETE',
      '/api/deployments/unknown-vps/app.example.com',
      { confirm: 'app.example.com', tunnelId: 'devgui-testdevgui' },
    );
    expect(res.status).toBe(422);
    expect(orch.undeploy).not.toHaveBeenCalled();
  });

  // ── AC8: Security-Floor — 422-Meldung enthält nur vpsId, kein host/key/token ──

  it('AC8: 422-Response enthält nur vpsId, keinen host/targetUser/key/token', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
    });

    // Unbekannte ID → 422
    const res = await request(app, 'GET', '/api/deployments?vps=nonexistent&tunnelId=tun-x');
    expect(res.status).toBe(422);
    const bodyStr = JSON.stringify(res.body);
    // Meldung enthält nur die vpsId, kein Ziel-Metadatum
    expect(bodyStr).toContain('nonexistent');
    expect(bodyStr).not.toContain('188.34.202.209'); // kein host leak
    expect(bodyStr).not.toContain('root');            // kein targetUser leak
    expect(bodyStr).not.toContain('token');           // kein token leak
  });

  it('AC9: dynamischer VPS mit veraltetem host → getMachineIp-Refresh wird versucht', async () => {
    const orch = makeOrchestratorStub();
    const staleRecord = { ...DYNAMIC_TESTDEVGUI, host: null }; // kein host im Record
    const registry = makeVpsRegistryMock(
      [staleRecord],
      jest.fn(async () => '188.34.202.209'), // getMachineIp liefert frische IP
    );
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
    });

    const res = await request(app, 'GET', '/api/deployments?vps=testdevgui&tunnelId=devgui-testdevgui');
    expect(res.status).toBe(200);
    expect(orch.listDeployments).toHaveBeenCalledWith(
      expect.objectContaining({ vps: expect.objectContaining({ host: '188.34.202.209' }) }),
    );
    expect(registry.getMachineIp).toHaveBeenCalled();
  });
});
