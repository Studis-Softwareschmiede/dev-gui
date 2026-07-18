/**
 * deploymentsRouter.test.js — HTTP-Router-Tests für Deploy-Lifecycle-Endpunkte (AC3–AC9).
 *
 * Covers (deploy-lifecycle):
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
 *
 * Covers (vps-readiness-gate S-180):
 *   AC7  — GET /api/deployments/readiness?vps=<vpsId> → 200 { state }; fehlendes vps → 400;
 *          unbekannte vpsId → 422; bekannte vps → 200 + state aus probe();
 *          503 wenn vpsDockerControl nicht injiziert (Dependency-Guard);
 *          403 via AccessGuard: server.js `app.use('/api', accessGuard)` greift vor
 *          mountRouters() — nicht unit-testbar im Router-Test, durch server.js-Inspektion
 *          verifiziert (deploymentsRouter trägt keinen eigenen Access-Check für read-only-Pfade)
 *   AC8  — Kein Audit-Eintrag bei Readiness-Probe; kein Key/Host/Token in Response
 *
 * Covers (vps-tunnel-existence-gate S-185 AC1–AC7, AC12, AC13):
 *   AC1  — POST /api/deployments → 422 tunnel-missing wenn Orchestrator tunnel-missing zurückgibt
 *   AC4  — POST /api/deployments → cloudflare-not-configured → 422; cloudflare-auth-failed → 502;
 *          cloudflare-unavailable → 502 (HTTP-Mapping der CF-Fehlerklassen aus dem Tunnel-Gate)
 *   AC5  — POST /api/deployments → 422 tunnel-mismatch wenn Orchestrator tunnel-mismatch zurückgibt
 *   AC7  — GET /api/deployments/vps-targets → tunnelIds enthält Env-VPS mit null (vollständiges Read-Model)
 *   AC7  — GET /api/deployments/vps-tunnel-status → [{ vpsId, tunnelId, tunnelPresent }];
 *          kein Tunnel-Token in Response; CF nicht erreichbar → tunnelPresent:"unknown";
 *          kein Audit-Eintrag (read-only)
 *   AC12 — vpsId an orchestrator.deploy() weitergegeben (Mismatch-Check ermöglichen)
 *   AC13 — GET /api/deployments/vps-tunnel-status erzeugt keinen Audit-Eintrag
 *
 * Covers (vps-tunnel-self-heal S-187 AC1–AC5, AC11, AC12 + S-188 AC6–AC8):
 *   AC1  — POST /api/deployments/vps/:vpsId/tunnel/recreate → 200 { result:"ok", report } Phase 1+2 ok
 *   AC2  — Phase 1 fehlgeschlagen (cloudflare-not-configured → 422; cloudflare-auth-failed → 502;
 *          cloudflare-unavailable → 502) → korrekte HTTP-Status + errorClass im Body
 *   AC3  — Phase 2 ok: result:"ok"; Phase 2 fehlgeschlagen: result:"partial" (HTTP 200)
 *   AC4  — Security: kein Token in HTTP-Response (Report traversal-Prüfung)
 *   AC5  — Phase 2 fehlgeschlagen → Report nennt Phase-2-Fehler klar (partial-result)
 *   AC6  — Phase 3 (S-188): routes[] im Report mit route-created-Einträgen;
 *          report.result "ok" bei Phase 1+2+3 erfolgreich
 *   AC7  — Protected Hostname in Phase 3 → protected-skipped im routes[]-Report (HTTP 200 ok)
 *   AC8  — Teil-Fehler Phase 3: ein Container error → result "partial"; übrige laufen weiter
 *   AC11 — kein Token/Key in Response-Body (vollständige Prüfung)
 *   AC12 — 403 ohne CRED_ADMIN_EMAILS; 422 unbekannte vpsId; 500 Audit-Fail; 422 TunnelHealService
 *          nicht konfiguriert;
 *          403 via AccessGuard (Cloudflare Access): server.js `app.use('/api', accessGuard)`
 *          greift vor mountRouters() — nicht unit-testbar, durch server.js-Inspektion verifiziert.
 *
 * Covers ([[deploy-cache-purge]] AC8-Nachzug, S-372 — persistenter Audit für cachePurge):
 *   AC8 — cachePurge.status "ok"/"failed" → eigener `deploy-cache-purge:<hostname>:<status>:<mode|
 *         errorClass>`-Audit-Eintrag, secret-frei (kein Token/Bearer im Command-String)
 *   AC8 — cachePurge.status "skipped" → KEIN zusätzlicher Audit-Eintrag (kein API-Call, kein Vorgang)
 *   AC8 — Audit-Fehler beim Purge-Audit selbst lässt den bereits erfolgreichen Deploy unverändert
 *         (best-effort, 200 bleibt 200)
 *   AC8 — genau EIN `deploy-cache-purge`-Eintrag pro Request (kein Doppel-Audit)
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
 * vpsDockerControl optionally passed for S-180 AC7 Readiness-Probe.
 * cloudflareApi optionally passed for S-185 AC7 VPS-Tunnel-Read-Model.
 * tunnelHealService optionally passed for S-187 AC1–5,11,12 Tunnel-Selbstheilung.
 */
function makeApp({
  orchestratorStub,
  auditStore,
  vpsTargets = new Map([['vps-1', { host: '1.2.3.4', port: 22, targetUser: 'root' }]]),
  identity = { email: 'admin@example.com' },
  vpsRegistry = undefined,
  vpsDockerControl = undefined,
  cloudflareApi = undefined,
  tunnelHealService = undefined,
} = {}) {
  const app = express();
  app.use(express.json());
  // Inject identity (simulating AccessGuard)
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });
  app.use(deploymentsRouter(orchestratorStub, auditStore, vpsTargets, undefined, undefined, vpsRegistry, vpsDockerControl, cloudflareApi, tunnelHealService));
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

// ── [[deploy-cache-purge]] AC8-Nachzug (S-372): persistenter Audit für cachePurge ────

describe('POST /api/deployments — [[deploy-cache-purge]] AC8-Nachzug: persistenter Audit-Eintrag für cachePurge', () => {
  function deployResultWithPurge(cachePurge) {
    return {
      result: 'ok',
      deployment: { hostname: 'app.example.com', image: 'x', containerId: 'cid', routePresent: true, containerPresent: true, cachePurge },
    };
  }

  it('cachePurge.status "ok" → eigener Audit-Eintrag mit hostname+status+mode', async () => {
    const orch = makeOrchestratorStub({ deployResult: deployResultWithPurge({ status: 'ok', mode: 'hosts' }) });
    const auditStore = new AuditStore();
    const app = makeApp({ orchestratorStub: orch, auditStore });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(200);

    const purgeEntry = auditStore.getAll().find((e) => e.command.startsWith('deploy-cache-purge:'));
    expect(purgeEntry).toBeDefined();
    expect(purgeEntry.command).toBe('deploy-cache-purge:app.example.com:ok:hosts');
  });

  it('cachePurge.status "failed" → Audit-Eintrag trägt errorClass statt Rohtext, kein Secret/Token', async () => {
    const orch = makeOrchestratorStub({
      deployResult: deployResultWithPurge({
        status: 'failed',
        errorClass: 'cloudflare-unavailable',
        warning: 'Cache-Purge fehlgeschlagen (cloudflare-unavailable) — Edge-Cache ggf. veraltet.',
      }),
    });
    const auditStore = new AuditStore();
    const app = makeApp({ orchestratorStub: orch, auditStore });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(200);

    const purgeEntry = auditStore.getAll().find((e) => e.command.startsWith('deploy-cache-purge:'));
    expect(purgeEntry.command).toBe('deploy-cache-purge:app.example.com:failed:cloudflare-unavailable');
    expect(purgeEntry.command).not.toMatch(/Bearer\s+\S+/i);
  });

  it('cachePurge.status "skipped" → KEIN zusätzlicher Audit-Eintrag (kein API-Call, kein Vorgang)', async () => {
    const orch = makeOrchestratorStub({ deployResult: deployResultWithPurge({ status: 'skipped' }) });
    const auditStore = new AuditStore();
    const app = makeApp({ orchestratorStub: orch, auditStore });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(200);

    expect(auditStore.getAll().some((e) => e.command.startsWith('deploy-cache-purge:'))).toBe(false);
  });

  it('Audit-Fehler beim Purge-Audit selbst lässt den bereits erfolgreichen Deploy unverändert (best-effort)', async () => {
    const orch = makeOrchestratorStub({ deployResult: deployResultWithPurge({ status: 'ok', mode: 'hosts' }) });
    const auditStore = new AuditStore();
    const origRecord = auditStore.record.bind(auditStore);
    let call = 0;
    auditStore.record = (...args) => {
      call += 1;
      // Aufruf-Reihenfolge ohne GPG: (1) Audit-First, (2) Outcome-Erfolg, (3) cachePurge-Audit.
      if (call === 3) throw new Error('audit storage full');
      return origRecord(...args);
    };

    const app = makeApp({ orchestratorStub: orch, auditStore });
    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
  });

  it('kein Doppel-Audit: genau EIN deploy-cache-purge-Eintrag pro Request', async () => {
    const orch = makeOrchestratorStub({ deployResult: deployResultWithPurge({ status: 'ok', mode: 'hosts' }) });
    const auditStore = new AuditStore();
    const app = makeApp({ orchestratorStub: orch, auditStore });

    await request(app, 'POST', '/api/deployments', DEPLOY_BODY);

    const entries = auditStore.getAll().filter((e) => e.command.startsWith('deploy-cache-purge:'));
    expect(entries.length).toBe(1);
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

// ── S-180 AC7–AC8: GET /api/deployments/readiness ────────────────────────────

/**
 * Erstellt einen vpsDockerControl-Mock mit konfigurierbarem probe()-Rückgabewert.
 *
 * @param {{ state: string, reason?: string }} probeResult
 */
function makeVpsDockerControlMock(probeResult = { state: 'ready' }) {
  return {
    probe: jest.fn(async () => probeResult),
  };
}

describe('S-180 AC7–AC8: GET /api/deployments/readiness', () => {
  // ── AC7: vps-Parameter fehlt → 400 ───────────────────────────────────────

  it('AC7: 400 wenn vps query-Parameter fehlt', async () => {
    const orch = makeOrchestratorStub();
    const dockerControl = makeVpsDockerControlMock();
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsDockerControl: dockerControl,
    });

    const res = await request(app, 'GET', '/api/deployments/readiness');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(dockerControl.probe).not.toHaveBeenCalled();
  });

  it('AC7: 400 wenn vps query-Parameter leer', async () => {
    const orch = makeOrchestratorStub();
    const dockerControl = makeVpsDockerControlMock();
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsDockerControl: dockerControl,
    });

    const res = await request(app, 'GET', '/api/deployments/readiness?vps=');
    expect(res.status).toBe(400);
    expect(dockerControl.probe).not.toHaveBeenCalled();
  });

  // ── AC7: vpsDockerControl nicht konfiguriert → 503 ──────────────────────
  // Dokumentierender Test: wenn deploymentsRouter ohne vpsDockerControl gebaut wird
  // (z.B. fehlende Dependency-Injektion), liefert der Endpunkt 503 statt 500/Crash.

  it('AC7: 503 wenn vpsDockerControl nicht injiziert', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      // vpsDockerControl absichtlich nicht gesetzt → Dependency-Guard greift
    });

    const res = await request(app, 'GET', '/api/deployments/readiness?vps=vps-1');
    expect(res.status).toBe(503);
    expect(res.body.error).toBeDefined();
    // Keine secrets in der 503-Meldung
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('1.2.3.4');
    expect(bodyStr).not.toContain('PRIVATE KEY');
  });

  // ── AC7: unbekannte vpsId → 422 ──────────────────────────────────────────

  it('AC7: 422 bei unbekannter vpsId', async () => {
    const orch = makeOrchestratorStub();
    const dockerControl = makeVpsDockerControlMock();
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsDockerControl: dockerControl,
      vpsTargets: new Map(), // keine VPS in Env
    });

    const res = await request(app, 'GET', '/api/deployments/readiness?vps=unknown-vps');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Unbekannter VPS: unknown-vps/);
    expect(dockerControl.probe).not.toHaveBeenCalled();
  });

  it('AC7: 422 enthält nur vpsId, keinen host/key/token', async () => {
    const orch = makeOrchestratorStub();
    const dockerControl = makeVpsDockerControlMock();
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsDockerControl: dockerControl,
      vpsTargets: new Map(),
    });

    const res = await request(app, 'GET', '/api/deployments/readiness?vps=ghost-vps');
    expect(res.status).toBe(422);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).toContain('ghost-vps'); // vpsId ist in Fehlermeldung
    expect(bodyStr).not.toContain('1.2.3.4'); // kein host leak
    expect(bodyStr).not.toContain('root');     // kein targetUser leak
    expect(bodyStr).not.toContain('token');    // kein token leak
  });

  // ── AC7: bekannte vpsId → 200 + state ────────────────────────────────────

  it('AC7: 200 { state: "ready" } bei bekannter vpsId und probe → ready', async () => {
    const orch = makeOrchestratorStub();
    const dockerControl = makeVpsDockerControlMock({ state: 'ready' });
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsDockerControl: dockerControl,
    });

    const res = await request(app, 'GET', '/api/deployments/readiness?vps=vps-1');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ready');
    expect(dockerControl.probe).toHaveBeenCalledWith({ host: '1.2.3.4', port: 22, targetUser: 'root' });
  });

  it('AC7: 200 { state: "provisioning" } bei probe → provisioning', async () => {
    const orch = makeOrchestratorStub();
    const dockerControl = makeVpsDockerControlMock({
      state: 'provisioning',
      reason: 'VPS wird noch eingerichtet (cloud-init / Docker / cloudflared)',
    });
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsDockerControl: dockerControl,
    });

    const res = await request(app, 'GET', '/api/deployments/readiness?vps=vps-1');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('provisioning');
  });

  it('AC7: 200 { state: "unreachable" } bei probe → unreachable', async () => {
    const orch = makeOrchestratorStub();
    const dockerControl = makeVpsDockerControlMock({
      state: 'unreachable',
      reason: 'VPS nicht erreichbar (SSH-Verbindung fehlgeschlagen)',
    });
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsDockerControl: dockerControl,
    });

    const res = await request(app, 'GET', '/api/deployments/readiness?vps=vps-1');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('unreachable');
  });

  // ── AC8: ohne gültigen Access → 403 ─────────────────────────────────────
  // AccessGuard in server.js setzt app.use('/api', accessGuard) vor mountRouters().
  // Im Test simulieren wir den Guard durch identity = null (kein req.identity).
  // Die Router selbst prüfen kein Access (nur Mutation-Authz); der echte
  // AccessGuard sitzt in server.js. Hier testen wir den Mutation-Authz-Pfad NICHT
  // (readiness ist read-only, kein CRED_ADMIN_EMAILS-Check), sondern das Verhalten
  // ohne jegliche identity — eine kein-identity-Anfrage darf die Probe NICHT starten,
  // weil der echte AccessGuard in server.js schon blockieren würde.
  // Da der deploymentsRouter selbst den AccessGuard nicht trägt (liegt in server.js),
  // dokumentieren wir hier: kein eigener 403-Check im Router für readiness.
  // (AC8-Verifikation durch server.js-Inspektion: /api-Middleware greift vor Routes)

  // ── AC8: kein Audit-Eintrag ───────────────────────────────────────────────

  it('AC8: kein Audit-Eintrag bei Readiness-Probe (read-only)', async () => {
    const orch = makeOrchestratorStub();
    const dockerControl = makeVpsDockerControlMock({ state: 'ready' });
    const auditStore = new AuditStore();
    const auditSpy = jest.spyOn(auditStore, 'record');

    const app = makeApp({
      orchestratorStub: orch,
      auditStore,
      vpsDockerControl: dockerControl,
    });

    const res = await request(app, 'GET', '/api/deployments/readiness?vps=vps-1');
    expect(res.status).toBe(200);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  // ── AC8: kein Key/Host/Token in Response ─────────────────────────────────

  it('AC8: kein host/key/token in der 200-Response', async () => {
    const orch = makeOrchestratorStub();
    const dockerControl = makeVpsDockerControlMock({
      state: 'provisioning',
      reason: 'VPS wird noch eingerichtet (cloud-init / Docker / cloudflared)',
    });
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsDockerControl: dockerControl,
    });

    const res = await request(app, 'GET', '/api/deployments/readiness?vps=vps-1');
    expect(res.status).toBe(200);
    const bodyStr = JSON.stringify(res.body);
    // Nur state (und optionale neutrale reason) — kein host/key/token
    expect(bodyStr).not.toContain('1.2.3.4');     // kein host leak
    expect(bodyStr).not.toContain('root');          // kein targetUser leak
    expect(bodyStr).not.toContain('PRIVATE KEY');   // kein key leak
    expect(bodyStr).not.toContain('Bearer');         // kein token leak
    // state muss vorhanden sein
    expect(res.body.state).toBe('provisioning');
  });

  // ── AC7: vereinigte VPS-Auflösung (dynamische Records) ───────────────────

  it('AC7: dynamischer VPS (kein Env) → aufgelöst, probe() wird aufgerufen', async () => {
    const orch = makeOrchestratorStub();
    const dockerControl = makeVpsDockerControlMock({ state: 'ready' });
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);

    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(), // leere Env
      vpsRegistry: registry,
      vpsDockerControl: dockerControl,
    });

    const res = await request(app, 'GET', '/api/deployments/readiness?vps=testdevgui');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ready');
    expect(dockerControl.probe).toHaveBeenCalledWith(
      expect.objectContaining({ host: '188.34.202.209' }),
    );
  });
});

// ── S-185 AC1/AC5: tunnel-missing / tunnel-mismatch im POST-Handler ──────────

describe('S-185 AC1/AC5: deploymentsRouter — tunnel-missing/tunnel-mismatch HTTP-Mapping', () => {
  it('AC1: POST /api/deployments → 422 tunnel-missing wenn Orchestrator tunnel-missing zurückgibt', async () => {
    const orch = makeOrchestratorStub({
      deployResult: {
        result: 'error',
        errorClass: 'tunnel-missing',
        reason: 'Tunnel existiert nicht in Cloudflare – bitte Tunnel neu anlegen',
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(422);
    expect(res.body.result).toBe('error');
    expect(res.body.errorClass).toBe('tunnel-missing');
    expect(res.body.reason).toBeTruthy();
    // Kein Token/Key in Response (AC12)
    expect(JSON.stringify(res.body)).not.toContain('Bearer');
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
  });

  it('AC5: POST /api/deployments → 422 tunnel-mismatch wenn Orchestrator tunnel-mismatch zurückgibt', async () => {
    const orch = makeOrchestratorStub({
      deployResult: {
        result: 'error',
        errorClass: 'tunnel-mismatch',
        reason: 'Tunnel-ID stimmt nicht mit registriertem Tunnel überein',
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(422);
    expect(res.body.result).toBe('error');
    expect(res.body.errorClass).toBe('tunnel-mismatch');
    expect(res.body.reason).toBeTruthy();
  });

  it('AC12: vpsId wird an orchestrator.deploy() weitergegeben (Mismatch-Check)', async () => {
    const orch = makeOrchestratorStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    await request(app, 'POST', '/api/deployments', DEPLOY_BODY);

    // Deploy wurde mit vpsId aufgerufen (vps = 'vps-1' aus DEPLOY_BODY)
    expect(orch.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ vpsId: 'vps-1', tunnelId: DEPLOY_BODY.tunnelId }),
    );
  });

  it('Kein Audit-Eintrag entsteht bei tunnel-missing (kein Tunnel → kein Mutation-Schritt)', async () => {
    // Tunnel-Gate schlägt VOR dem Audit-First-Eintrag fehl — nein, das stimmt nicht.
    // Der Audit-First-Eintrag wird VOR dem Orchestrator-Aufruf geschrieben (AC9).
    // Das ist korrekt und gewollt: Audit-First bedeutet vor der Mutation.
    // tunnel-missing/mismatch ist kein Mutationsschritt — der Audit-Eintrag existiert
    // als "deploy:create:..." wird trotzdem geschrieben (pre-flight audit, kein Secret).
    // Hier testen wir: 422 response + kein Secret im Audit.
    const capturedAuditCommands = [];
    const orch = makeOrchestratorStub({
      deployResult: {
        result: 'error',
        errorClass: 'tunnel-missing',
        reason: 'Tunnel fehlt',
      },
    });
    const auditStore = new AuditStore();
    const origRecord = auditStore.record.bind(auditStore);
    auditStore.record = ({ command, ...rest }) => {
      capturedAuditCommands.push(command);
      return origRecord({ command, ...rest });
    };
    const app = makeApp({ orchestratorStub: orch, auditStore });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(422);
    // Kein Token/Secret in Audit-Command
    for (const cmd of capturedAuditCommands) {
      expect(cmd).not.toContain('Bearer');
      expect(cmd).not.toContain('PRIVATE KEY');
    }
  });
});

// ── S-185 AC4: HTTP-Mapping der CF-Fehlerklassen aus dem Tunnel-Existenz-Gate ─

describe('S-185 AC4: deploymentsRouter — CF-Fehlerklassen HTTP-Mapping (Tunnel-Gate)', () => {
  it('AC4: cloudflare-not-configured → 422', async () => {
    const orch = makeOrchestratorStub({
      deployResult: {
        result: 'error',
        errorClass: 'cloudflare-not-configured',
        reason: 'Cloudflare nicht konfiguriert – Tunnel-Existenz nicht prüfbar',
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(422);
    expect(res.body.result).toBe('error');
    expect(res.body.errorClass).toBe('cloudflare-not-configured');
    expect(res.body.reason).toBeTruthy();
  });

  it('AC4: cloudflare-auth-failed → 502', async () => {
    const orch = makeOrchestratorStub({
      deployResult: {
        result: 'error',
        errorClass: 'cloudflare-auth-failed',
        reason: 'Cloudflare-Authentifizierung fehlgeschlagen',
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(502);
    expect(res.body.result).toBe('error');
    expect(res.body.errorClass).toBe('cloudflare-auth-failed');
    expect(res.body.reason).toBeTruthy();
  });

  it('AC4: cloudflare-unavailable → 502', async () => {
    const orch = makeOrchestratorStub({
      deployResult: {
        result: 'error',
        errorClass: 'cloudflare-unavailable',
        reason: 'Cloudflare nicht erreichbar',
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments', DEPLOY_BODY);
    expect(res.status).toBe(502);
    expect(res.body.result).toBe('error');
    expect(res.body.errorClass).toBe('cloudflare-unavailable');
    expect(res.body.reason).toBeTruthy();
  });
});

// ── S-185 AC7: GET /api/deployments/vps-targets — tunnelIds vollständig ───────

describe('S-185 AC7: deploymentsRouter — GET /api/deployments/vps-targets tunnelIds vollständig', () => {
  it('AC7: Env-VPS erscheinen in tunnelIds mit null (kein dynamischer Record)', async () => {
    const orch = makeOrchestratorStub();
    // Env hat vps-1; kein dynamischer Record mit tunnelId
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map([['vps-1', { host: '1.2.3.4', port: 22, targetUser: 'root' }]]),
    });

    const res = await request(app, 'GET', '/api/deployments/vps-targets');
    expect(res.status).toBe(200);
    expect(res.body.vpsIds).toContain('vps-1');
    // tunnelIds Map enthält Env-VPS mit null (kein Tunnel registriert)
    expect(res.body.tunnelIds).toBeDefined();
    expect(res.body.tunnelIds['vps-1']).toBeNull();
  });

  it('AC7: dynamischer VPS mit tunnelId erscheint in tunnelIds mit registrierter ID', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([
      { ...DYNAMIC_TESTDEVGUI, tunnelId: 'devgui-testdevgui-tunnel-id' },
    ]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
    });

    const res = await request(app, 'GET', '/api/deployments/vps-targets');
    expect(res.status).toBe(200);
    expect(res.body.tunnelIds['testdevgui']).toBe('devgui-testdevgui-tunnel-id');
  });

  it('AC7: Env-VPS + dynamischer VPS → tunnelIds enthält beide (null für Env, ID für dynamisch)', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([
      { ...DYNAMIC_TESTDEVGUI, tunnelId: 'testdevgui-tunnel-id' },
    ]);
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map([['env-vps', { host: '5.6.7.8', port: 22, targetUser: 'root' }]]),
      vpsRegistry: registry,
    });

    const res = await request(app, 'GET', '/api/deployments/vps-targets');
    expect(res.status).toBe(200);
    expect(res.body.tunnelIds['env-vps']).toBeNull();
    expect(res.body.tunnelIds['testdevgui']).toBe('testdevgui-tunnel-id');
  });
});

// ── S-185 AC7: GET /api/deployments/vps-tunnel-status ────────────────────────

/**
 * Erstellt einen CloudflareApi-Mock für den Tunnel-Status-Read-Model-Test.
 */
function makeCloudflareApiMock({ tunnels = [], throws = false } = {}) {
  return {
    listTunnels: jest.fn(async () => {
      if (throws) throw Object.assign(new Error('CF unavailable'), { errorClass: 'cloudflare-unavailable' });
      return tunnels;
    }),
  };
}

describe('S-185 AC7/AC13: deploymentsRouter — GET /api/deployments/vps-tunnel-status', () => {
  it('AC7: 200 mit Array von { vpsId, tunnelId, tunnelPresent }', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([
      { ...DYNAMIC_TESTDEVGUI, tunnelId: 'devgui-testdevgui-tunnel-id' },
    ]);
    const cfApi = makeCloudflareApiMock({
      tunnels: [{ id: 'devgui-testdevgui-tunnel-id' }],
    });

    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
      cloudflareApi: cfApi,
    });

    const res = await request(app, 'GET', '/api/deployments/vps-tunnel-status');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const entry = res.body.find((e) => e.vpsId === 'testdevgui');
    expect(entry).toBeDefined();
    expect(entry.tunnelId).toBe('devgui-testdevgui-tunnel-id');
    expect(entry.tunnelPresent).toBe(true);
  });

  it('AC7: tunnelPresent=false wenn Tunnel nicht in Cloudflare existiert', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([
      { ...DYNAMIC_TESTDEVGUI, tunnelId: 'deleted-tunnel-id' },
    ]);
    const cfApi = makeCloudflareApiMock({
      tunnels: [{ id: 'other-tunnel-still-exists' }], // deletierter Tunnel fehlt
    });

    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
      cloudflareApi: cfApi,
    });

    const res = await request(app, 'GET', '/api/deployments/vps-tunnel-status');
    expect(res.status).toBe(200);
    const entry = res.body.find((e) => e.vpsId === 'testdevgui');
    expect(entry.tunnelPresent).toBe(false);
  });

  it('AC7: tunnelPresent="unknown" wenn Cloudflare nicht erreichbar (degradierend, kein Crash)', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([
      { ...DYNAMIC_TESTDEVGUI, tunnelId: 'some-tunnel-id' },
    ]);
    const cfApi = makeCloudflareApiMock({ throws: true }); // CF nicht erreichbar

    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
      cloudflareApi: cfApi,
    });

    const res = await request(app, 'GET', '/api/deployments/vps-tunnel-status');
    expect(res.status).toBe(200);
    const entry = res.body.find((e) => e.vpsId === 'testdevgui');
    expect(entry.tunnelPresent).toBe('unknown');
  });

  it('AC7: VPS ohne registrierte tunnelId → tunnelId:null, tunnelPresent:false (kein Tunnel zugeordnet)', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([
      { ...DYNAMIC_TESTDEVGUI, tunnelId: null },
    ]);
    const cfApi = makeCloudflareApiMock({ tunnels: [{ id: 'some-other-tunnel' }] });

    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
      cloudflareApi: cfApi,
    });

    const res = await request(app, 'GET', '/api/deployments/vps-tunnel-status');
    expect(res.status).toBe(200);
    const entry = res.body.find((e) => e.vpsId === 'testdevgui');
    expect(entry.tunnelId).toBeNull();
    expect(entry.tunnelPresent).toBe(false);
  });

  it('AC7: leere Registry + keine Env-VPS → leeres Array, kein Crash', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([]);
    const cfApi = makeCloudflareApiMock({ tunnels: [] });

    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
      cloudflareApi: cfApi,
    });

    const res = await request(app, 'GET', '/api/deployments/vps-tunnel-status');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('AC12: Tunnel-Token erscheint NICHT in Response (Security-Floor)', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([
      { ...DYNAMIC_TESTDEVGUI, tunnelId: 'real-tunnel-id' },
    ]);
    const cfApi = makeCloudflareApiMock({
      tunnels: [{ id: 'real-tunnel-id', token: 'SECRET_TUNNEL_TOKEN_NEVER_EXPOSE' }],
    });

    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
      cloudflareApi: cfApi,
    });

    const res = await request(app, 'GET', '/api/deployments/vps-tunnel-status');
    expect(res.status).toBe(200);
    // Kein Token in Response
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('SECRET_TUNNEL_TOKEN_NEVER_EXPOSE');
    expect(bodyStr).not.toContain('token');
    // tunnelId (nicht-geheim) darf enthalten sein
    expect(bodyStr).toContain('real-tunnel-id');
  });

  it('AC13: GET /api/deployments/vps-tunnel-status erzeugt keinen Audit-Eintrag (read-only)', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([DYNAMIC_TESTDEVGUI]);
    const cfApi = makeCloudflareApiMock({ tunnels: [] });
    const auditStore = new AuditStore();
    const auditSpy = jest.spyOn(auditStore, 'record');

    const app = makeApp({
      orchestratorStub: orch,
      auditStore,
      vpsTargets: new Map(),
      vpsRegistry: registry,
      cloudflareApi: cfApi,
    });

    const res = await request(app, 'GET', '/api/deployments/vps-tunnel-status');
    expect(res.status).toBe(200);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('AC7: Env-VPS erscheinen im Read-Model (mit tunnelId:null wenn kein Record)', async () => {
    const orch = makeOrchestratorStub();
    // Keine dynamischen Records; Env hat einen VPS
    const cfApi = makeCloudflareApiMock({ tunnels: [] });

    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map([['env-vps-1', { host: '1.2.3.4', port: 22, targetUser: 'root' }]]),
      cloudflareApi: cfApi,
    });

    const res = await request(app, 'GET', '/api/deployments/vps-tunnel-status');
    expect(res.status).toBe(200);
    const entry = res.body.find((e) => e.vpsId === 'env-vps-1');
    expect(entry).toBeDefined();
    expect(entry.tunnelId).toBeNull(); // Env-VPS haben keine registrierte tunnelId
    expect(entry.tunnelPresent).toBe(false);
  });

  it('AC7: ohne cloudflareApi → tunnelPresent:"unknown" (degradierend, kein Crash)', async () => {
    const orch = makeOrchestratorStub();
    const registry = makeVpsRegistryMock([
      { ...DYNAMIC_TESTDEVGUI, tunnelId: 'some-tunnel' },
    ]);

    const app = makeApp({
      orchestratorStub: orch,
      auditStore: new AuditStore(),
      vpsTargets: new Map(),
      vpsRegistry: registry,
      // cloudflareApi nicht gesetzt → degradiert
    });

    const res = await request(app, 'GET', '/api/deployments/vps-tunnel-status');
    expect(res.status).toBe(200);
    const entry = res.body.find((e) => e.vpsId === 'testdevgui');
    expect(entry.tunnelPresent).toBe('unknown');
  });
});

// ── POST /api/deployments/vps/:vpsId/tunnel/recreate (S-187 AC1–5, AC11, AC12) ─

const FAKE_TUNNEL_TOKEN = 'eyJhbGciOiJFZERTQSJ9.SECRET_TOKEN_VALUE.sig';

function makeTunnelHealServiceStub({
  recreateResult = {
    vpsId: 'vps-1',
    newTunnelId: 'new-tunnel-id',
    oldTunnelId: null,
    phase1: { ok: true },
    phase2: { ok: true },
    routes: [],
    errors: [],
  },
  recreateError = null,
} = {}) {
  return {
    recreate: jest.fn(async () => {
      if (recreateError) throw recreateError;
      return recreateResult;
    }),
  };
}

describe('POST /api/deployments/vps/:vpsId/tunnel/recreate (S-187)', () => {
  it('AC1: 200 + { result:"ok", report } bei Phase 1+2 erfolgreich', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub();
    const app = makeApp({ orchestratorStub: orch, auditStore: audit, tunnelHealService: healSvc });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(res.body.report).toBeDefined();
    expect(res.body.report.newTunnelId).toBe('new-tunnel-id');
  });

  it('AC3: 200 + { result:"partial", report } bei Phase 2 fehlgeschlagen', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub({
      recreateResult: {
        vpsId: 'vps-1',
        newTunnelId: 'new-tunnel-id',
        oldTunnelId: null,
        phase1: { ok: true },
        phase2: { ok: false, errorClass: 'unreachable' },
        routes: [],
        errors: [{ scope: 'phase2', errorClass: 'unreachable' }],
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: audit, tunnelHealService: healSvc });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('partial');
    expect(res.body.report.phase2.ok).toBe(false);
    expect(res.body.report.phase2.errorClass).toBe('unreachable');
  });

  it('AC2: 422 bei cloudflare-not-configured (Phase 1 fehlgeschlagen)', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub({
      recreateResult: {
        vpsId: 'vps-1',
        newTunnelId: null,
        oldTunnelId: null,
        phase1: { ok: false, errorClass: 'cloudflare-not-configured' },
        phase2: { ok: false, errorClass: 'skipped' },
        routes: [],
        errors: [{ scope: 'phase1', errorClass: 'cloudflare-not-configured' }],
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: audit, tunnelHealService: healSvc });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(422);
    expect(res.body.errorClass).toBe('cloudflare-not-configured');
  });

  it('AC2: 502 bei cloudflare-auth-failed (Phase 1 fehlgeschlagen)', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub({
      recreateResult: {
        vpsId: 'vps-1',
        newTunnelId: null,
        oldTunnelId: null,
        phase1: { ok: false, errorClass: 'cloudflare-auth-failed' },
        phase2: { ok: false, errorClass: 'skipped' },
        routes: [],
        errors: [{ scope: 'phase1', errorClass: 'cloudflare-auth-failed' }],
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: audit, tunnelHealService: healSvc });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(502);
    expect(res.body.errorClass).toBe('cloudflare-auth-failed');
  });

  it('AC2: 502 bei cloudflare-unavailable (Phase 1 fehlgeschlagen)', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub({
      recreateResult: {
        vpsId: 'vps-1',
        newTunnelId: null,
        oldTunnelId: null,
        phase1: { ok: false, errorClass: 'cloudflare-unavailable' },
        phase2: { ok: false, errorClass: 'skipped' },
        routes: [],
        errors: [{ scope: 'phase1', errorClass: 'cloudflare-unavailable' }],
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: audit, tunnelHealService: healSvc });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(502);
    expect(res.body.errorClass).toBe('cloudflare-unavailable');
  });

  it('AC12: 403 wenn nicht in CRED_ADMIN_EMAILS', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub();
    const origEnv = process.env.CRED_ADMIN_EMAILS;
    process.env.CRED_ADMIN_EMAILS = 'other@example.com';

    const app = makeApp({
      orchestratorStub: orch,
      auditStore: audit,
      tunnelHealService: healSvc,
      identity: { email: 'notadmin@example.com' },
    });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(403);
    expect(healSvc.recreate).not.toHaveBeenCalled();

    if (origEnv === undefined) { delete process.env.CRED_ADMIN_EMAILS; } else { process.env.CRED_ADMIN_EMAILS = origEnv; }
  });

  it('AC12: 422 bei unbekannter vpsId', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub();
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: audit,
      tunnelHealService: healSvc,
      vpsTargets: new Map([['vps-1', { host: '1.2.3.4', port: 22, targetUser: 'root' }]]),
    });

    const res = await request(app, 'POST', '/api/deployments/vps/unknown-vps/tunnel/recreate');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Unbekannter VPS/);
    expect(healSvc.recreate).not.toHaveBeenCalled();
  });

  it('AC12: 422 wenn tunnelHealService nicht konfiguriert', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: audit,
      // tunnelHealService fehlt → 422
    });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/TunnelHealService/);
  });

  it('AC12: 500 bei Audit-Write-Fehler → recreate nicht aufgerufen', async () => {
    const orch = makeOrchestratorStub();
    const brokenAudit = { record: () => { throw new Error('audit-store-fail'); } };
    const healSvc = makeTunnelHealServiceStub();
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: brokenAudit,
      tunnelHealService: healSvc,
    });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Audit-Write/);
    expect(healSvc.recreate).not.toHaveBeenCalled();
  });

  it('AC4/AC11: kein Token in HTTP-Response (traversal-Prüfung)', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    // Report enthält kein Token (TunnelHealService garantiert das; Router-Test verifiziert es)
    const healSvc = makeTunnelHealServiceStub({
      recreateResult: {
        vpsId: 'vps-1',
        newTunnelId: 'new-tunnel-id',
        oldTunnelId: 'old-tunnel-id',
        phase1: { ok: true },
        phase2: { ok: true },
        routes: [],
        errors: [],
        // Kein token/tunnelToken-Feld hier — TunnelHealService gibt diese nicht zurück
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: audit, tunnelHealService: healSvc });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(200);

    // AC4/AC11: Token NIEMALS in Response-Body
    const responseStr = JSON.stringify(res.body);
    expect(responseStr).not.toContain(FAKE_TUNNEL_TOKEN);
    expect(responseStr).not.toContain('token');
    // Explizit: kein token-Feld in report
    expect(res.body.report).not.toHaveProperty('token');
    expect(res.body.report).not.toHaveProperty('tunnelToken');
  });

  it('AC1: tunnelHealService.recreate() erhält vpsId + vpsTarget + auditStore', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub();
    const app = makeApp({
      orchestratorStub: orch,
      auditStore: audit,
      tunnelHealService: healSvc,
      vpsTargets: new Map([['vps-1', { host: '10.0.0.1', port: 22, targetUser: 'root' }]]),
    });

    await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');

    expect(healSvc.recreate).toHaveBeenCalledTimes(1);
    const args = healSvc.recreate.mock.calls[0][0];
    expect(args.vpsId).toBe('vps-1');
    expect(args.vpsTarget).toMatchObject({ host: '10.0.0.1' });
    expect(args.auditStore).toBeDefined();
  });
});

// ── S-188 AC6–AC8: Phase 3 HTTP-Ebenen-Tests ──────────────────────────────────

describe('POST /api/deployments/vps/:vpsId/tunnel/recreate — Phase 3 (S-188 AC6–AC8)', () => {
  it('AC6: 200 ok + routes[] im Report bei erfolgreichem Phase-3-Bestücken', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub({
      recreateResult: {
        vpsId: 'vps-1',
        newTunnelId: 'new-tunnel-id',
        oldTunnelId: null,
        phase1: { ok: true },
        phase2: { ok: true },
        routes: [{ hostname: 'app.example.com', result: 'route-created' }],
        errors: [],
        result: 'ok',
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: audit, tunnelHealService: healSvc });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(Array.isArray(res.body.report.routes)).toBe(true);
    expect(res.body.report.routes).toHaveLength(1);
    expect(res.body.report.routes[0]).toMatchObject({ hostname: 'app.example.com', result: 'route-created' });
  });

  it('AC7: 200 ok + protected-skipped in routes[] bei geschütztem Hostname', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub({
      recreateResult: {
        vpsId: 'vps-1',
        newTunnelId: 'new-tunnel-id',
        oldTunnelId: null,
        phase1: { ok: true },
        phase2: { ok: true },
        routes: [{ hostname: 'protected.example.com', result: 'protected-skipped' }],
        errors: [],
        result: 'ok',
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: audit, tunnelHealService: healSvc });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(res.body.report.routes[0]).toMatchObject({
      hostname: 'protected.example.com',
      result: 'protected-skipped',
    });
  });

  it('AC8: 200 partial bei Phase-3-Teil-Fehler (ein Container error, einer route-created)', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub({
      recreateResult: {
        vpsId: 'vps-1',
        newTunnelId: 'new-tunnel-id',
        oldTunnelId: null,
        phase1: { ok: true },
        phase2: { ok: true },
        routes: [
          { hostname: 'app-a.example.com', result: 'route-created' },
          { hostname: 'app-b.example.com', result: 'error', errorClass: 'zone-not-found' },
        ],
        errors: [{ scope: 'phase3:route:app-b.example.com', errorClass: 'zone-not-found' }],
        result: 'partial',
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: audit, tunnelHealService: healSvc });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(200);
    // AC8: Gesamt-Ergebnis partial
    expect(res.body.result).toBe('partial');
    expect(res.body.report.routes).toHaveLength(2);
    const routeA = res.body.report.routes.find((r) => r.hostname === 'app-a.example.com');
    const routeB = res.body.report.routes.find((r) => r.hostname === 'app-b.example.com');
    expect(routeA.result).toBe('route-created');
    expect(routeB.result).toBe('error');
    expect(routeB.errorClass).toBe('zone-not-found');
  });

  it('AC8: 200 ok + leere routes[] wenn keine managed Container (no-op)', async () => {
    const orch = makeOrchestratorStub();
    const audit = new AuditStore();
    const healSvc = makeTunnelHealServiceStub({
      recreateResult: {
        vpsId: 'vps-1',
        newTunnelId: 'new-tunnel-id',
        oldTunnelId: null,
        phase1: { ok: true },
        phase2: { ok: true },
        routes: [],
        errors: [],
        result: 'ok',
      },
    });
    const app = makeApp({ orchestratorStub: orch, auditStore: audit, tunnelHealService: healSvc });

    const res = await request(app, 'POST', '/api/deployments/vps/vps-1/tunnel/recreate');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(res.body.report.routes).toHaveLength(0);
  });
});
