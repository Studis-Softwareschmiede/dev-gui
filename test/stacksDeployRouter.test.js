/**
 * stacksDeployRouter.test.js — HTTP-Router-Tests für Stack-Deploy/Undeploy/Status-Endpunkte.
 *
 * Covers (stack-deploy-orchestration.md AC6–AC11):
 *   AC6  — POST /api/deployments/stacks/:stackName/deploy → { result: "ok", stack }
 *   AC7  — Deploy route-fail → { result: "error", reason } ohne Secret-Leak
 *   AC8  — DELETE /api/deployments/stacks/:stackName/undeploy mit korrektem confirm → 200
 *   AC8  — Undeploy ohne/falschem confirm → 422 confirmation-required; keine Mutation
 *   AC9  — GET /api/deployments/stacks/:stackName/status → StackStatus mit Drift-Flags
 *   AC10 — Deploy/Undeploy auf protected Hostname → 422 protected-resource; kein Schritt
 *   AC11 — Access+Rolle+Audit-First: 403 ohne Berechtigung; Audit-Write-Fail → 500 + keine Aktion
 *   AC11 — Kein App-Boot-Secret/SSH-Key/CF-Token in Response/Audit
 *   AC11 — #160-Registry-DELETE /api/deployments/stacks/:stackName unverändert (Kollisions-Auflösung)
 *   AC11 — AccessGuard-Verdrahtung: per server.js-Inspektion sichergestellt; kein separater JWT-Middleware-Test in dieser Datei.
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { CredentialStore } from '../src/CredentialStore.js';
import { StackRegistry } from '../src/StackRegistry.js';
import { stacksRouter } from '../src/stacksRouter.js';
import { AuditStore } from '../src/AuditStore.js';

// ── HTTP-Test-Helpers ──────────────────────────────────────────────────────────

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function httpReq(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = httpRequest(
      { hostname: '127.0.0.1', port, method, path, headers },
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
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const VALID_STACK = {
  stackName: 'my-stack',
  repoUrl: 'https://github.com/org/my-stack',
  branch: 'main',
  composeFile: 'docker-compose.yml',
  vps: 'vps-1',
  publicServices: [
    { service: 'web', hostname: 'web.example.com' },
    { service: 'api', hostname: 'api.example.com' },
  ],
  tunnelId: 'tunnel-abc-123',
};

const VPS_TARGETS = new Map([
  ['vps-1', { host: '1.2.3.4', port: 22, targetUser: 'root' }],
]);

// ── StackDeployOrchestrator-Stubs ─────────────────────────────────────────────

function makeDeployOrchestrator({
  deployResult = { result: 'ok', stack: { stackName: 'my-stack', routedHostnames: ['web.example.com', 'api.example.com'], envStatus: 'exists' } },
  deployError = null,
  undeployResult = { result: 'ok' },
  undeployError = null,
  statusResult = {
    stackName: 'my-stack',
    project: 'my-stack',
    services: [
      { service: 'web', hostname: 'web.example.com', status: 'running', containerPresent: true, routePresent: true, drift: false },
    ],
  },
  statusError = null,
} = {}) {
  return {
    deploy: jest.fn(async () => {
      if (deployError) throw deployError;
      return deployResult;
    }),
    undeploy: jest.fn(async () => {
      if (undeployError) throw undeployError;
      return undeployResult;
    }),
    status: jest.fn(async () => {
      if (statusError) throw statusError;
      return statusResult;
    }),
  };
}

// ── Test-Setup ─────────────────────────────────────────────────────────────────

describe('stacksDeployRouter (AC6–AC11)', () => {
  let tmpDir;
  let credentialStore;
  let stackRegistry;
  let auditStore;
  let stackDeployOrchestrator;
  let app;
  let server;
  let port;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'stacks-deploy-router-test-'));
    credentialStore = new CredentialStore({ dir: tmpDir, masterKey: 'test-master-key' });
    stackRegistry = new StackRegistry(credentialStore);
    auditStore = new AuditStore();
    stackDeployOrchestrator = makeDeployOrchestrator();

    app = express();
    app.use(express.json());
    // Admin-Identität injizieren (simuliert AccessGuard)
    app.use((req, _res, next) => {
      req.identity = { email: 'admin@example.com' };
      next();
    });
    app.use(stacksRouter(stackRegistry, auditStore, { stackDeployOrchestrator, vpsTargets: VPS_TARGETS }));

    // Stack für Tests vorab anlegen
    await stackRegistry.set(VALID_STACK);

    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.CRED_ADMIN_EMAILS;
  });

  // ── AC6: Deploy Happy-Path ─────────────────────────────────────────────────

  describe('AC6 — POST /api/deployments/stacks/:stackName/deploy', () => {
    it('200 { result: "ok", stack } bei erfolgreichem Deploy', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');

      expect(status).toBe(200);
      expect(body.result).toBe('ok');
      expect(body.stack.stackName).toBe('my-stack');
      expect(body.stack.routedHostnames).toEqual(['web.example.com', 'api.example.com']);
    });

    it('Deploy-Orchestrator wird mit stackDef aus Registry + VPS-Target aufgerufen', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');

      expect(stackDeployOrchestrator.deploy).toHaveBeenCalledWith(
        expect.objectContaining({
          vps: expect.objectContaining({ host: '1.2.3.4', targetUser: 'root' }),
          stackDef: expect.objectContaining({ stackName: 'my-stack' }),
        }),
      );
    });

    it('404 wenn Stack nicht in Registry', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks/ghost-stack/deploy');

      expect(status).toBe(404);
      expect(body.error).toMatch(/nicht in der Registry/i);
    });

    it('503 wenn stackDeployOrchestrator nicht konfiguriert', async () => {
      const appNoOrch = express();
      appNoOrch.use(express.json());
      appNoOrch.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });
      appNoOrch.use(stacksRouter(stackRegistry, auditStore)); // kein Orchestrator
      const { server: s2, port: p2 } = await startServer(appNoOrch);
      try {
        const { status } = await httpReq(p2, 'POST', '/api/deployments/stacks/my-stack/deploy');
        expect(status).toBe(503);
      } finally {
        await closeServer(s2);
      }
    });
  });

  // ── AC7: Deploy Route-Fehler ──────────────────────────────────────────────

  describe('AC7 — Deploy-Fehler', () => {
    it('502 { result: "error", reason } bei Deploy-Fehler; kein Secret-Leak', async () => {
      stackDeployOrchestrator.deploy.mockResolvedValue({
        result: 'error',
        reason: 'Route-Anlage fehlgeschlagen',
        errorClass: 'cloudflare-error',
      });

      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');

      expect(status).toBe(502);
      expect(body.result).toBe('error');
      expect(body.reason).toBeDefined();
      // Kein Secret in reason
      expect(body.reason).not.toMatch(/Bearer [A-Za-z0-9._-]{8,}/);
    });

    it('400 bei validation-error errorClass', async () => {
      stackDeployOrchestrator.deploy.mockResolvedValue({
        result: 'error',
        reason: 'Ungültiger Hostname',
        errorClass: 'validation-error',
      });

      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');

      expect(status).toBe(400);
      expect(body.result).toBe('error');
    });
  });

  // ── AC8: Undeploy ─────────────────────────────────────────────────────────

  describe('AC8 — DELETE /api/deployments/stacks/:stackName/undeploy', () => {
    it('200 { result: "ok" } bei korrektem confirm', async () => {
      const { status, body } = await httpReq(
        port, 'DELETE', '/api/deployments/stacks/my-stack/undeploy',
        { confirm: 'my-stack' },
      );

      expect(status).toBe(200);
      expect(body.result).toBe('ok');
    });

    it('422 confirmation-required wenn confirm fehlt', async () => {
      const { status, body } = await httpReq(
        port, 'DELETE', '/api/deployments/stacks/my-stack/undeploy',
        {},
      );

      expect(status).toBe(422);
      expect(body.reason).toBe('confirmation-required');
      // Kein Orchestrator-Aufruf
      expect(stackDeployOrchestrator.undeploy).not.toHaveBeenCalled();
    });

    it('422 confirmation-required wenn confirm falscher Wert', async () => {
      const { status, body } = await httpReq(
        port, 'DELETE', '/api/deployments/stacks/my-stack/undeploy',
        { confirm: 'wrong-stack' },
      );

      expect(status).toBe(422);
      expect(body.reason).toBe('confirmation-required');
      expect(stackDeployOrchestrator.undeploy).not.toHaveBeenCalled();
    });

    it('404 wenn Stack nicht in Registry', async () => {
      const { status } = await httpReq(
        port, 'DELETE', '/api/deployments/stacks/ghost-stack/undeploy',
        { confirm: 'ghost-stack' },
      );

      expect(status).toBe(404);
    });

    it('Undeploy-Orchestrator wird mit korrektem confirm aufgerufen', async () => {
      await httpReq(port, 'DELETE', '/api/deployments/stacks/my-stack/undeploy', { confirm: 'my-stack' });

      expect(stackDeployOrchestrator.undeploy).toHaveBeenCalledWith(
        expect.objectContaining({
          vps: expect.objectContaining({ host: '1.2.3.4' }),
          stackDef: expect.objectContaining({ stackName: 'my-stack' }),
          confirm: 'my-stack',
        }),
      );
    });
  });

  // ── AC9: Stack-Status ─────────────────────────────────────────────────────

  describe('AC9 — GET /api/deployments/stacks/:stackName/status', () => {
    it('200 StackStatus mit services + Drift-Flags', async () => {
      const { status, body } = await httpReq(port, 'GET', '/api/deployments/stacks/my-stack/status');

      expect(status).toBe(200);
      expect(body.stackName).toBe('my-stack');
      expect(Array.isArray(body.services)).toBe(true);
      expect(body.services[0]).toHaveProperty('drift');
      expect(body.services[0]).toHaveProperty('containerPresent');
      expect(body.services[0]).toHaveProperty('routePresent');
    });

    it('404 wenn Stack nicht in Registry', async () => {
      const { status } = await httpReq(port, 'GET', '/api/deployments/stacks/ghost-stack/status');
      expect(status).toBe(404);
    });

    it('kein Rollen-Check für Status-Lesen (nur Access)', async () => {
      process.env.CRED_ADMIN_EMAILS = 'other@example.com';
      const { status } = await httpReq(port, 'GET', '/api/deployments/stacks/my-stack/status');
      // Kein 403 — GET ist nicht unter Rollen-Schutz
      expect(status).toBe(200);
    });
  });

  // ── AC10: Protected Hostname ──────────────────────────────────────────────

  describe('AC10 — Protected Hostname', () => {
    it('Deploy mit protected-resource errorClass → 422 protected-resource', async () => {
      stackDeployOrchestrator.deploy.mockResolvedValue({
        result: 'error',
        reason: 'protected-resource',
        errorClass: 'protected-resource',
      });

      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');

      expect(status).toBe(422);
      expect(body.result).toBe('error');
      expect(body.reason).toBe('protected-resource');
    });

    it('Undeploy mit protected-resource errorClass → 422 protected-resource', async () => {
      stackDeployOrchestrator.undeploy.mockResolvedValue({
        result: 'error',
        reason: 'protected-resource',
        errorClass: 'protected-resource',
      });

      const { status, body } = await httpReq(
        port, 'DELETE', '/api/deployments/stacks/my-stack/undeploy',
        { confirm: 'my-stack' },
      );

      expect(status).toBe(422);
      expect(body.result).toBe('error');
      expect(body.reason).toBe('protected-resource');
    });
  });

  // ── AC11: Access + Rolle + Audit-First ───────────────────────────────────

  describe('AC11 — Rollen-Gate CRED_ADMIN_EMAILS', () => {
    it('POST deploy 403 wenn CRED_ADMIN_EMAILS gesetzt und Identität nicht enthalten', async () => {
      process.env.CRED_ADMIN_EMAILS = 'other@example.com';
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');
      expect(status).toBe(403);
      expect(body.error).toMatch(/Berechtigung/i);
      expect(stackDeployOrchestrator.deploy).not.toHaveBeenCalled();
    });

    it('DELETE undeploy 403 wenn CRED_ADMIN_EMAILS gesetzt und Identität nicht enthalten', async () => {
      process.env.CRED_ADMIN_EMAILS = 'other@example.com';
      const { status } = await httpReq(
        port, 'DELETE', '/api/deployments/stacks/my-stack/undeploy',
        { confirm: 'my-stack' },
      );
      expect(status).toBe(403);
      expect(stackDeployOrchestrator.undeploy).not.toHaveBeenCalled();
    });

    it('POST deploy 200 wenn CRED_ADMIN_EMAILS gesetzt und Identität enthalten', async () => {
      process.env.CRED_ADMIN_EMAILS = 'admin@example.com,other@example.com';
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');
      expect(status).toBe(200);
    });
  });

  describe('AC11 — Audit-First', () => {
    it('Deploy schreibt Audit-Eintrag VOR der Aktion', async () => {
      const before = auditStore.getAll().length;
      await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');
      const entries = auditStore.getAll().slice(before);
      const entry = entries.find((e) => e.command === 'stack:deploy:my-stack');
      expect(entry).toBeDefined();
      expect(entry.identity).toBe('admin@example.com');
    });

    it('Undeploy schreibt Audit-Eintrag stack:undeploy:<stackName>', async () => {
      const before = auditStore.getAll().length;
      await httpReq(port, 'DELETE', '/api/deployments/stacks/my-stack/undeploy', { confirm: 'my-stack' });
      const entries = auditStore.getAll().slice(before);
      const entry = entries.find((e) => e.command === 'stack:undeploy:my-stack');
      expect(entry).toBeDefined();
    });

    it('Audit-Eintrag enthält KEIN App-Boot-Secret / SSH-Key / CF-Token', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');
      const entries = auditStore.getAll();
      for (const entry of entries) {
        if (entry.command.startsWith('stack:deploy')) {
          expect(entry.command).not.toMatch(/Bearer/);
          expect(entry.command).not.toContain('PRIVATE KEY');
          expect(entry.command).not.toMatch(/ghp_|cf-/);
        }
      }
    });

    it('Audit-Write-Fail → 500 + kein Deploy (Audit-First-Vertrag)', async () => {
      const brokenAudit = { record: () => { throw new Error('Audit-Write fehlgeschlagen'); } };
      const brokenApp = express();
      brokenApp.use(express.json());
      brokenApp.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });
      brokenApp.use(stacksRouter(stackRegistry, brokenAudit, { stackDeployOrchestrator, vpsTargets: VPS_TARGETS }));
      const { server: s2, port: p2 } = await startServer(brokenApp);
      try {
        const { status } = await httpReq(p2, 'POST', '/api/deployments/stacks/my-stack/deploy');
        expect(status).toBe(500);
        expect(stackDeployOrchestrator.deploy).not.toHaveBeenCalled();
      } finally {
        await closeServer(s2);
      }
    });

    it('Audit-Write-Fail beim Undeploy → 500 + kein Undeploy', async () => {
      const brokenAudit = { record: () => { throw new Error('Audit-Write fehlgeschlagen'); } };
      const brokenApp = express();
      brokenApp.use(express.json());
      brokenApp.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });
      brokenApp.use(stacksRouter(stackRegistry, brokenAudit, { stackDeployOrchestrator, vpsTargets: VPS_TARGETS }));
      const { server: s2, port: p2 } = await startServer(brokenApp);
      try {
        const { status } = await httpReq(p2, 'DELETE', '/api/deployments/stacks/my-stack/undeploy', { confirm: 'my-stack' });
        expect(status).toBe(500);
        expect(stackDeployOrchestrator.undeploy).not.toHaveBeenCalled();
      } finally {
        await closeServer(s2);
      }
    });
  });

  describe('AC11 — Kein Secret in Response', () => {
    it('Deploy-Fehler-Response enthält kein Bearer-Token', async () => {
      stackDeployOrchestrator.deploy.mockResolvedValue({
        result: 'error',
        reason: 'Bearer secret-token-xyz unauthorized',
        errorClass: 'cloudflare-error',
      });

      const { body } = await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');

      const bodyStr = JSON.stringify(body);
      expect(bodyStr).not.toContain('secret-token-xyz');
    });

    it('Deploy-Response enthält kein app-boot-secret (envStatus nur "exists"/"generated")', async () => {
      const { body } = await httpReq(port, 'POST', '/api/deployments/stacks/my-stack/deploy');

      const bodyStr = JSON.stringify(body);
      // Nur envStatus (string), kein generierterer Wert
      expect(bodyStr).not.toMatch(/[a-f0-9]{32,}/); // kein Hash-Muster
      expect(bodyStr).not.toContain('password');
    });
  });

  // ── Kollisions-Auflösung: #160-Registry-DELETE unverändert ───────────────────

  describe('Kollisions-Auflösung — Registry-DELETE /api/deployments/stacks/:stackName unverändert', () => {
    it('DELETE /api/deployments/stacks/my-stack löscht nur Registry-Eintrag (kein composeDown)', async () => {
      const { status, body } = await httpReq(port, 'DELETE', '/api/deployments/stacks/my-stack');

      expect(status).toBe(200);
      // backup-Feld koennte vorhanden sein (S-140 AC6), aber stackName+status sind gesetzt
      expect(body.stackName).toBe('my-stack');
      expect(body.status).toBe('deleted');
      // stackDeployOrchestrator.undeploy wurde NICHT aufgerufen
      expect(stackDeployOrchestrator.undeploy).not.toHaveBeenCalled();

      // Stack ist aus Registry gelöscht
      const get = await httpReq(port, 'GET', '/api/deployments/stacks/my-stack');
      expect(get.status).toBe(404);
    });

    it('GET /api/deployments/stacks/:stackName liefert StackDefinition (unverändert, AC1)', async () => {
      const { status, body } = await httpReq(port, 'GET', '/api/deployments/stacks/my-stack');
      expect(status).toBe(200);
      expect(body.stackName).toBe('my-stack');
    });

    it('GET /api/deployments/stacks listet registrierte Stacks (unverändert, AC1)', async () => {
      const { status, body } = await httpReq(port, 'GET', '/api/deployments/stacks');
      expect(status).toBe(200);
      expect(body.stacks).toHaveLength(1);
    });
  });

  // ── VPS-Auflösung ──────────────────────────────────────────────────────────

  describe('VPS-Auflösung', () => {
    it('422 wenn VPS-ID aus stackDef nicht in vpsTargets-Map', async () => {
      // Stack mit nicht-konfiguriertem VPS anlegen
      const unknownVpsStack = { ...VALID_STACK, stackName: 'unknown-vps-stack', vps: 'vps-unknown' };
      await stackRegistry.set(unknownVpsStack);

      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks/unknown-vps-stack/deploy');

      expect(status).toBe(422);
      expect(body.error).toMatch(/Unbekannter|nicht konfiguriert/i);
    });
  });
});
