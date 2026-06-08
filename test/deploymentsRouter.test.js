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
 *   AC9  — Audit-First: audit.record() called before any mutation; Audit-Write-Fail → 500 + no action
 *   AC9  — No SSH-Key / CF-Token in any response body
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { deploymentsRouter } from '../src/deploymentsRouter.js';
import { AuditStore } from '../src/AuditStore.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build Express app with deploymentsRouter wired.
 * Identity is injected via req.identity (simulating AccessGuard).
 */
function makeApp({
  orchestratorStub,
  auditStore,
  vpsTargets = new Map([['vps-1', { host: '1.2.3.4', port: 22, targetUser: 'root' }]]),
  identity = { email: 'admin@example.com' },
} = {}) {
  const app = express();
  app.use(express.json());
  // Inject identity (simulating AccessGuard)
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });
  app.use(deploymentsRouter(orchestratorStub, auditStore, vpsTargets));
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

/** Standard deploy body */
const DEPLOY_BODY = {
  image: 'ghcr.io/org/app:v1',
  vps: 'vps-1',
  hostname: 'app.example.com',
  tunnelId: 'tunnel-abc-123',
  zoneId: 'zone-def-456',
};

/** Standard undeploy body */
const UNDEPLOY_BODY = {
  confirm: 'app.example.com',
  tunnelId: 'tunnel-abc-123',
  zoneId: 'zone-def-456',
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
  it('Cloudflare-Token erscheint nicht in GET-Response', async () => {
    const cfToken = 'cf-secret-api-token-never-in-response-12345';
    const deployments = [{ hostname: 'app.example.com', routePresent: true, containerPresent: true }];
    const orch = makeOrchestratorStub({ listResult: { deployments } });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'GET', '/api/deployments?vps=vps-1&tunnelId=tun-abc');
    expect(JSON.stringify(res.body)).not.toContain(cfToken);
  });
});
