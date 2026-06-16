/**
 * stacksRouter.test.js — Unit-Tests für Stack-Registry CRUD (stack-deploy-orchestration.md).
 *
 * Covers:
 *   AC1  — StackDefinition CRUD via Backend; Klartext-Metadatum nicht im verschlüsselten entries-Block;
 *           secretsSpec enthält nur Secret-NAMEN, keine Werte; Felder round-trip korrekt gespeichert
 *   AC2  — Registry-Mutationen hinter Access + CRED_ADMIN_EMAILS-Rolle + Audit-First;
 *           Eingaben (stackName/repoUrl/branch/Pfade/hostname) validiert (Path-Traversal/Shell-Metazeichen/Hostname);
 *           secretsSpec-Werte nie in Response/Audit
 *   AC2 (AccessGuard-Verdrahtung): per server.js-Inspektion, kein separater Middleware-Test
 *
 * Strategie:
 *   - CredentialStore mit echtem tmpdir + masterKey (keine Verschlüsselung nötig für meta-only)
 *   - StackRegistry mit echtem CredentialStore (vollständiger Boundary-Test)
 *   - stacksRouter HTTP-Integration via Express (kein AccessGuard — wird per server.js verdrahtet)
 *   - AuditStore echt (append-only in-memory)
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
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

/**
 * Minimale, valide StackDefinition für Tests.
 */
const VALID_STACK = {
  stackName: 'my-app',
  repoUrl: 'https://github.com/org/my-app',
  branch: 'main',
  composeFile: 'docker-compose.yml',
  vps: 'vps-1',
  publicServices: [{ service: 'web', hostname: 'my-app.example.com' }],
  tunnelId: 'tunnel-abc-123',
};

/**
 * StackDefinition mit allen optionalen Feldern.
 */
const FULL_STACK = {
  stackName: 'full-stack',
  repoUrl: 'https://github.com/org/full-stack',
  branch: 'release/v2',
  composeFile: 'docker/docker-compose.yml',
  overrideFile: 'docker/docker-compose.prod.yml',
  vps: 'vps-prod-1',
  publicServices: [
    { service: 'web', hostname: 'full.example.com' },
    { service: 'kong', hostname: 'db.example.com' },
  ],
  tunnelId: 'tunnel-xyz-456',
  secretsSpec: {
    generate: ['DB_PASSWORD', 'JWT_SECRET'],
    required: ['OPENAI_API_KEY'],
  },
};

// ── Test-Setup ─────────────────────────────────────────────────────────────────

describe('stacksRouter', () => {
  let tmpDir;
  let credentialStore;
  let stackRegistry;
  let auditStore;
  let app;
  let server;
  let port;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'stacks-router-test-'));
    // masterKey is optional for meta-only operations; provide one for completeness
    credentialStore = new CredentialStore({ dir: tmpDir, masterKey: 'test-master-key' });
    stackRegistry = new StackRegistry(credentialStore);
    auditStore = new AuditStore();

    app = express();
    app.use(express.json());
    // Inject admin identity (simulating AccessGuard pass-through)
    app.use((req, _res, next) => {
      req.identity = { email: 'admin@example.com' };
      next();
    });
    app.use(stacksRouter(stackRegistry, auditStore));

    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.CRED_ADMIN_EMAILS;
  });

  // ── AC1: CRUD ──────────────────────────────────────────────────────────────────

  describe('AC1 — GET /api/deployments/stacks (leere Liste)', () => {
    it('gibt leere stacks-Liste zurück wenn noch kein Stack angelegt', async () => {
      const { status, body } = await httpReq(port, 'GET', '/api/deployments/stacks');
      expect(status).toBe(200);
      expect(body).toEqual({ stacks: [] });
    });
  });

  describe('AC1 — POST + GET round-trip', () => {
    it('legt Stack an und liest ihn wieder zurück (minimal)', async () => {
      const create = await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);
      expect(create.status).toBe(201);
      expect(create.body.stackName).toBe('my-app');
      expect(create.body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const list = await httpReq(port, 'GET', '/api/deployments/stacks');
      expect(list.status).toBe(200);
      expect(list.body.stacks).toHaveLength(1);
      expect(list.body.stacks[0].stackName).toBe('my-app');
    });

    it('legt Stack mit allen optionalen Feldern an und liest ihn zurück', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks', FULL_STACK);

      const get = await httpReq(port, 'GET', '/api/deployments/stacks/full-stack');
      expect(get.status).toBe(200);
      expect(get.body.stackName).toBe('full-stack');
      expect(get.body.overrideFile).toBe('docker/docker-compose.prod.yml');
      expect(get.body.publicServices).toHaveLength(2);
      expect(get.body.tunnelId).toBe('tunnel-xyz-456');
    });

    it('AC1: secretsSpec enthält nur Namen, niemals Werte — round-trip prüft nur generate/required-Listen', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks', FULL_STACK);

      const get = await httpReq(port, 'GET', '/api/deployments/stacks/full-stack');
      expect(get.status).toBe(200);
      // secretsSpec enthält NUR die Namen-Listen
      expect(get.body.secretsSpec.generate).toEqual(['DB_PASSWORD', 'JWT_SECRET']);
      expect(get.body.secretsSpec.required).toEqual(['OPENAI_API_KEY']);
      // Kein Wert-Feld in secretsSpec
      expect(get.body.secretsSpec).not.toHaveProperty('values');
      expect(get.body.secretsSpec).not.toHaveProperty('secrets');
    });

    it('AC1: Stack-Daten liegen IM meta-Block, NICHT im verschlüsselten entries-Block', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);

      // CredentialStore direkt prüfen: kein entries-Eintrag für stacks/
      const entries = await credentialStore.list(); // verschlüsselte entries
      const stackEntries = entries.filter((e) => e.integration?.startsWith('stacks') ||
        (e.name ?? '').startsWith('stacks'));
      expect(stackEntries).toHaveLength(0);

      // meta-Block: Stack-Daten müssen abrufbar sein
      const metaValue = await credentialStore.getStackMeta('my-app');
      expect(metaValue).not.toBeNull();
      const parsed = JSON.parse(metaValue);
      expect(parsed.stackName).toBe('my-app');
    });
  });

  describe('AC1 — PUT (Update)', () => {
    it('überschreibt vorhandene Stack-Definition', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);

      const updated = { ...VALID_STACK, branch: 'develop' };
      const put = await httpReq(port, 'PUT', '/api/deployments/stacks/my-app', updated);
      expect(put.status).toBe(200);
      expect(put.body.stackName).toBe('my-app');

      const get = await httpReq(port, 'GET', '/api/deployments/stacks/my-app');
      expect(get.body.branch).toBe('develop');
    });

    it('legt Stack per PUT an wenn noch nicht vorhanden', async () => {
      const put = await httpReq(port, 'PUT', '/api/deployments/stacks/my-app', VALID_STACK);
      expect(put.status).toBe(200);

      const get = await httpReq(port, 'GET', '/api/deployments/stacks/my-app');
      expect(get.status).toBe(200);
      expect(get.body.stackName).toBe('my-app');
    });

    it('400 wenn stackName im Body nicht mit URL-Parameter übereinstimmt', async () => {
      const mismatch = { ...VALID_STACK, stackName: 'other-app' };
      const put = await httpReq(port, 'PUT', '/api/deployments/stacks/my-app', mismatch);
      expect(put.status).toBe(400);
      expect(put.body.error).toMatch(/übereinstimmen/i);
    });
  });

  describe('AC1 — DELETE', () => {
    it('löscht eine vorhandene Stack-Definition', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);

      const del = await httpReq(port, 'DELETE', '/api/deployments/stacks/my-app');
      expect(del.status).toBe(200);
      // backup-Feld koennte vorhanden sein (S-140 AC6), aber stackName+status sind gesetzt
      expect(del.body.stackName).toBe('my-app');
      expect(del.body.status).toBe('deleted');

      const get = await httpReq(port, 'GET', '/api/deployments/stacks/my-app');
      expect(get.status).toBe(404);
    });

    it('404 wenn Stack nicht vorhanden', async () => {
      const del = await httpReq(port, 'DELETE', '/api/deployments/stacks/ghost-stack');
      expect(del.status).toBe(404);
      expect(del.body.error).toMatch(/nicht in der Registry/i);
    });
  });

  describe('AC1 — GET einzelner Stack', () => {
    it('404 wenn Stack nicht vorhanden', async () => {
      const get = await httpReq(port, 'GET', '/api/deployments/stacks/ghost-stack');
      expect(get.status).toBe(404);
    });
  });

  describe('AC1 — 409 Duplikat bei POST', () => {
    it('409 wenn stackName bereits vorhanden', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);
      const again = await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);
      expect(again.status).toBe(409);
      expect(again.body.error).toMatch(/existiert bereits/i);
    });
  });

  // ── AC2: Rollen-Gate + Audit-First ────────────────────────────────────────────

  describe('AC2 — CRED_ADMIN_EMAILS-Rollenschutz für Mutationen', () => {
    it('POST 403 wenn CRED_ADMIN_EMAILS gesetzt und Identität nicht enthalten', async () => {
      process.env.CRED_ADMIN_EMAILS = 'other@example.com';
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);
      expect(status).toBe(403);
      expect(body.error).toMatch(/Berechtigung/i);
    });

    it('PUT 403 wenn CRED_ADMIN_EMAILS gesetzt und Identität nicht enthalten', async () => {
      process.env.CRED_ADMIN_EMAILS = 'other@example.com';
      const { status } = await httpReq(port, 'PUT', '/api/deployments/stacks/my-app', VALID_STACK);
      expect(status).toBe(403);
    });

    it('DELETE 403 wenn CRED_ADMIN_EMAILS gesetzt und Identität nicht enthalten', async () => {
      process.env.CRED_ADMIN_EMAILS = 'other@example.com';
      const { status } = await httpReq(port, 'DELETE', '/api/deployments/stacks/my-app');
      expect(status).toBe(403);
    });

    it('POST 201 wenn CRED_ADMIN_EMAILS gesetzt und Identität enthalten', async () => {
      process.env.CRED_ADMIN_EMAILS = 'admin@example.com,other@example.com';
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);
      expect(status).toBe(201);
    });

    it('GET /api/deployments/stacks kein Rollen-Check (nur Access)', async () => {
      process.env.CRED_ADMIN_EMAILS = 'other@example.com';
      const { status } = await httpReq(port, 'GET', '/api/deployments/stacks');
      expect(status).toBe(200);
    });

    it('GET /api/deployments/stacks/:stackName kein Rollen-Check (nur Access)', async () => {
      // Stack vorher anlegen ohne Rollen-Check-Effekt
      await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);
      process.env.CRED_ADMIN_EMAILS = 'other@example.com';
      const { status } = await httpReq(port, 'GET', '/api/deployments/stacks/my-app');
      expect(status).toBe(200);
    });
  });

  describe('AC2 — Audit-First: Eintrag VOR Mutation', () => {
    it('POST schreibt Audit-Eintrag vor der Mutation', async () => {
      const before = auditStore.getAll().length;
      await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);
      const entries = auditStore.getAll();
      expect(entries.length).toBeGreaterThan(before);
      const entry = entries.find((e) => e.command === 'stack:create:my-app');
      expect(entry).toBeDefined();
      expect(entry.identity).toBe('admin@example.com');
    });

    it('PUT schreibt Audit-Eintrag stack:update:<stackName>', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);
      const before = auditStore.getAll().length;
      await httpReq(port, 'PUT', '/api/deployments/stacks/my-app', VALID_STACK);
      const entries = auditStore.getAll().slice(before);
      const entry = entries.find((e) => e.command === 'stack:update:my-app');
      expect(entry).toBeDefined();
    });

    it('DELETE schreibt Audit-Eintrag stack:delete:<stackName>', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);
      const before = auditStore.getAll().length;
      await httpReq(port, 'DELETE', '/api/deployments/stacks/my-app');
      const entries = auditStore.getAll().slice(before);
      const entry = entries.find((e) => e.command === 'stack:delete:my-app');
      expect(entry).toBeDefined();
    });

    it('Audit-Einträge enthalten KEINE secretsSpec-Werte (AC1)', async () => {
      await httpReq(port, 'POST', '/api/deployments/stacks', FULL_STACK);
      const entries = auditStore.getAll();
      for (const entry of entries) {
        // Kein Secret-Wert in irgendeinem Audit-Eintrag
        expect(entry.command).not.toContain('DB_PASSWORD');
        expect(entry.command).not.toContain('JWT_SECRET');
        expect(entry.command).not.toContain('OPENAI_API_KEY');
        // Nur die Aktion + stackName
        expect(entry.command).toMatch(/^stack:(create|update|delete):/);
      }
    });

    it('Audit-Write-Fail → 500 + keine Mutation (Audit-First-Vertrag)', async () => {
      // AuditStore durch defekten Stub ersetzen
      const brokenAudit = { record: () => { throw new Error('Audit-Write fehlgeschlagen'); } };
      const brokenApp = express();
      brokenApp.use(express.json());
      brokenApp.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });
      brokenApp.use(stacksRouter(stackRegistry, brokenAudit));
      const { server: s2, port: p2 } = await startServer(brokenApp);
      try {
        const { status } = await httpReq(p2, 'POST', '/api/deployments/stacks', VALID_STACK);
        expect(status).toBe(500);
        // Mutation hat NICHT stattgefunden
        const list = await httpReq(port, 'GET', '/api/deployments/stacks');
        expect(list.body.stacks).toHaveLength(0);
      } finally {
        await closeServer(s2);
      }
    });
  });

  // ── AC2: Eingabe-Validierung ───────────────────────────────────────────────────

  describe('AC2 — stackName-Validierung (Path-Traversal / Shell-Metazeichen)', () => {
    it('400 bei stackName mit .. (Path-Traversal)', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, stackName: '../etc/passwd',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/unerlaubte Zeichen/i);
    });

    it('400 bei stackName mit Shell-Metazeichen', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, stackName: 'my;app',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/unerlaubte Zeichen/i);
    });

    it('422 bei stackName im URL-Parameter mit .. ', async () => {
      const { status } = await httpReq(port, 'GET', '/api/deployments/stacks/..%2Fetc');
      expect(status).toBe(422);
    });

    it('400 bei leerem stackName', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, stackName: '',
      });
      expect(status).toBe(400);
    });
  });

  describe('AC2 — repoUrl-Validierung', () => {
    it('400 bei repoUrl mit eingebettetem Token (https://token@host)', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, repoUrl: 'https://user:ghp_token@github.com/org/repo',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/repoUrl/i);
    });

    it('400 bei repoUrl mit Shell-Metazeichen', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, repoUrl: 'https://github.com/org/repo;evil',
      });
      expect(status).toBe(400);
    });

    it('400 bei fehlender repoUrl', async () => {
      const body = { ...VALID_STACK };
      delete body.repoUrl;
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', body);
      expect(status).toBe(400);
    });
  });

  describe('AC2 — branch-Validierung', () => {
    it('400 bei branch mit .. (Path-Traversal)', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, branch: '../secret',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/branch/i);
    });

    it('400 bei branch mit Shell-Metazeichen', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, branch: 'main; rm -rf /',
      });
      expect(status).toBe(400);
    });
  });

  describe('AC2 — composeFile / overrideFile-Validierung (Path-Traversal)', () => {
    it('400 bei composeFile mit absoluter Pfad', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, composeFile: '/etc/passwd',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/composeFile/i);
    });

    it('400 bei composeFile mit .. (Path-Traversal)', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, composeFile: '../../etc/docker-compose.yml',
      });
      expect(status).toBe(400);
    });

    it('400 bei overrideFile mit .. (Path-Traversal)', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, overrideFile: '../override.yml',
      });
      expect(status).toBe(400);
    });

    it('overrideFile optional — fehlt oder leer → kein Fehler', async () => {
      const noOverride = { ...VALID_STACK };
      delete noOverride.overrideFile;
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', noOverride);
      expect(status).toBe(201);
    });
  });

  describe('AC2 — hostname-Validierung (publicServices)', () => {
    it('400 bei hostname mit Shell-Metazeichen', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK,
        publicServices: [{ service: 'web', hostname: 'my-app;evil.com' }],
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/hostname/i);
    });

    it('400 bei leerem hostname', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK,
        publicServices: [{ service: 'web', hostname: '' }],
      });
      expect(status).toBe(400);
    });

    it('leeres publicServices-Array ist erlaubt', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, publicServices: [],
      });
      expect(status).toBe(201);
    });
  });

  describe('AC2 — secretsSpec-Validierung: nur Secret-NAMEN, keine Werte', () => {
    it('400 wenn secretsSpec.generate ungültigen Namen enthält', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK,
        secretsSpec: { generate: ['123_INVALID'], required: [] },
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/generate/i);
    });

    it('400 wenn secretsSpec.required ungültigen Namen enthält', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK,
        secretsSpec: { generate: [], required: ['VALID_KEY', 'with space'] },
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/required/i);
    });

    it('400 wenn secretsSpec kein Objekt ist', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, secretsSpec: 'DB_PASSWORD=secret',
      });
      expect(status).toBe(400);
    });

    it('AC1: secretsSpec-Werte dürfen niemals in der Response erscheinen', async () => {
      // Response enthält KEINE Werte, nur Namen
      const { body } = await httpReq(port, 'POST', '/api/deployments/stacks', FULL_STACK);
      const bodyStr = JSON.stringify(body);
      // Response ist { stackName, updatedAt } — keine Stack-Daten mit Werten
      expect(bodyStr).not.toContain('DB_PASSWORD=');
      expect(bodyStr).not.toContain('secret');
    });

    it('gültiger secretsSpec mit generate + required', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK,
        secretsSpec: {
          generate: ['DB_PASSWORD', 'JWT_SECRET', 'ANON_KEY'],
          required: ['OPENAI_API_KEY'],
        },
      });
      expect(status).toBe(201);
    });

    it('secretsSpec ist optional', async () => {
      const noSpec = { ...VALID_STACK };
      delete noSpec.secretsSpec;
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', noSpec);
      expect(status).toBe(201);
    });
  });

  describe('AC2 — Pflichtfelder fehlen', () => {
    it('400 wenn vps fehlt', async () => {
      const body = { ...VALID_STACK };
      delete body.vps;
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', body);
      expect(status).toBe(400);
    });

    it('400 wenn tunnelId fehlt', async () => {
      const body = { ...VALID_STACK };
      delete body.tunnelId;
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', body);
      expect(status).toBe(400);
    });

    it('400 wenn publicServices fehlt', async () => {
      const body = { ...VALID_STACK };
      delete body.publicServices;
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', body);
      expect(status).toBe(400);
    });
  });

  describe('AC2 — vps-Validierung (Shell-Metazeichen)', () => {
    it('400 bei vps mit Shell-Metazeichen', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, vps: 'vps-1; rm -rf /',
      });
      expect(status).toBe(400);
    });
  });

  describe('AC2/I2 — tunnelId-Validierung (Shell-Metazeichen, ..-Segmente, Leerzeichen, Längenlimit)', () => {
    it('400 bei tunnelId mit Shell-Metazeichen', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, tunnelId: 'tunnel-abc;evil',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/tunnelId/i);
    });

    it('400 bei tunnelId mit ..-Segment (Path-Traversal-Schutz)', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, tunnelId: '../etc/tunnel',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/\.\./);
    });

    it('400 bei tunnelId mit eingebetteten .. (kein Pfad-Separator nötig)', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, tunnelId: 'tunnel..evil',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/\.\./);
    });

    it('400 bei tunnelId mit Leerzeichen (Whitespace-Schutz)', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, tunnelId: 'tunnel abc 123',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/Leerzeichen|Whitespace/i);
    });

    it('400 bei tunnelId mit Tab-Zeichen', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, tunnelId: 'tunnel\tabc',
      });
      expect(status).toBe(400);
    });

    it('400 bei tunnelId die das Längenlimit (128) überschreitet', async () => {
      const { status, body } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, tunnelId: 'a'.repeat(129),
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/tunnelId/i);
    });

    it('201 bei tunnelId mit UUID-Format (gültig)', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, tunnelId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      });
      expect(status).toBe(201);
    });

    it('201 bei tunnelId exakt am Längenlimit (128 Zeichen)', async () => {
      const { status } = await httpReq(port, 'POST', '/api/deployments/stacks', {
        ...VALID_STACK, tunnelId: 'a'.repeat(128),
      });
      expect(status).toBe(201);
    });
  });

  // ── AC1: Mehrere Stacks ─────────────────────────────────────────────────────

  describe('AC1 — mehrere Stacks', () => {
    it('listet mehrere registrierte Stacks', async () => {
      const stack2 = { ...VALID_STACK, stackName: 'app-b', tunnelId: 'tunnel-b' };
      await httpReq(port, 'POST', '/api/deployments/stacks', VALID_STACK);
      await httpReq(port, 'POST', '/api/deployments/stacks', stack2);

      const { body } = await httpReq(port, 'GET', '/api/deployments/stacks');
      expect(body.stacks).toHaveLength(2);
      const names = body.stacks.map((s) => s.stackName);
      expect(names).toContain('my-app');
      expect(names).toContain('app-b');
    });
  });
});
