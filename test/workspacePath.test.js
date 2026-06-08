/**
 * workspacePath.test.js — Tests for workspace-path-config (Item #85, AC2–AC9)
 *
 * Covers:
 *   AC2  — Traversal/Symlink/außerhalb-Schranke → 4xx, Effektivwert unverändert
 *   AC3  — nicht-existent/kein-Verzeichnis/nicht-schreibbar → 422, Effektivwert unverändert
 *   AC4  — Persistenz: setzen → Neustart simulieren (Store neu laden) → Effektivwert konfiguriert
 *   AC5  — Effektivwert pro Operation aufgelöst (WorkspaceScanner/WorkspaceMutator/GitHubCloner
 *           lesen den Resolver, nicht direkt env)
 *   AC6  — Pfad ist kein Geheimnis: im meta-Block (Klartext), nicht in entries
 *   AC7  — Audit-First (Intent vor Mutation, Outcome nach Mutation; Audit-Fehler blockiert Mutation)
 *   AC8  — 403 ohne CRED_ADMIN_EMAILS-Berechtigung; read-only EP kein zusätzlicher Rollencheck
 *   AC9  — ohne Konfiguration: env-Fallback; Verhaltensneutralität (drei Boundaries)
 *
 * Strategy:
 *   - CredentialStore.readWorkspacePath / writeWorkspacePath / deleteWorkspacePath: Unit-Tests
 *     mit echtem CredentialStore (tmp-Dir, kein Encrypt-Master-Key nötig da meta-only).
 *   - validateWorkspacePath: Unit-Tests mit injected fsDeps.
 *   - workspacePathRouter: HTTP-Integration via Express + AccessGuard-Dev-Bypass.
 *   - WorkspaceScanner / WorkspaceMutator / GitHubCloner: AC5/AC9 via workspaceRootResolver.
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { CredentialStore } from '../src/CredentialStore.js';
import { validateWorkspacePath, buildWorkspaceRootResolver } from '../src/workspacePath.js';
import { workspacePathRouter } from '../src/workspacePathRouter.js';
import { WorkspaceScanner } from '../src/WorkspaceScanner.js';
import { WorkspaceMutator } from '../src/WorkspaceMutator.js';
import { GitHubCloner } from '../src/GitHubCloner.js';
import { AuditStore } from '../src/AuditStore.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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
      { hostname: '127.0.0.1', port, path, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function get(port, path) { return httpReq(port, 'GET', path); }
function put(port, path, body) { return httpReq(port, 'PUT', path, body); }
function del(port, path) { return httpReq(port, 'DELETE', path); }

// ── App builder ───────────────────────────────────────────────────────────────

function makeApp(credentialStore, auditStore, deps = {}) {
  const app = express();
  app.use(express.json());
  const guard = createAccessGuard();
  app.use('/api', guard);
  app.use(workspacePathRouter(credentialStore, auditStore, deps));
  return app;
}

// ── Fake CredentialStore ──────────────────────────────────────────────────────

function makeFakeCredStore(initialPath = null) {
  let storedPath = initialPath;
  return {
    async readWorkspacePath() { return storedPath; },
    async writeWorkspacePath(p) { storedPath = p; return { updatedAt: new Date().toISOString() }; },
    async deleteWorkspacePath() { storedPath = null; },
    _getStoredPath() { return storedPath; },
  };
}

// ── Unit tests: validateWorkspacePath ────────────────────────────────────────

describe('validateWorkspacePath — AC2/AC3 Validierung', () => {
  const MOUNT_ROOT = '/workspace';

  // Fake deps: Pfad existiert, ist Verzeichnis, ist schreibbar
  function fakeDeps(opts = {}) {
    const {
      realpathMountFails = false,
      realpathInputFails = false,
      statFails = false,
      isDir = true,
      accessFails = false,
    } = opts;
    return {
      realpath: async (p) => {
        // MOUNT_ROOT = '/workspace' (exact match)
        if (realpathMountFails && p === MOUNT_ROOT) throw new Error('ENOENT');
        // Input path: anything that is NOT exactly MOUNT_ROOT
        if (realpathInputFails && p !== MOUNT_ROOT) throw new Error('ENOENT');
        return p; // identity
      },
      stat: async () => {
        if (statFails) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isDirectory: () => isDir };
      },
      access: async () => {
        if (accessFails) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    };
  }

  beforeEach(() => {
    process.env.WORKSPACE_DIR = MOUNT_ROOT;
  });

  afterEach(() => {
    delete process.env.WORKSPACE_DIR;
  });

  it('AC2 — leer/whitespace → WorkspacePathError empty-path', async () => {
    await expect(validateWorkspacePath('', fakeDeps())).rejects.toMatchObject({
      errorClass: 'empty-path',
    });
    await expect(validateWorkspacePath('   ', fakeDeps())).rejects.toMatchObject({
      errorClass: 'empty-path',
    });
  });

  it('AC2 — Pfad = exakt WORKSPACE_DIR → erlaubt (kein Fehler)', async () => {
    const result = await validateWorkspacePath(MOUNT_ROOT, fakeDeps());
    expect(result.resolvedPath).toBe(MOUNT_ROOT);
  });

  it('AC2 — Unterordner von WORKSPACE_DIR → erlaubt', async () => {
    const result = await validateWorkspacePath('/workspace/projects', fakeDeps());
    expect(result.resolvedPath).toBe('/workspace/projects');
  });

  it('AC2 — außerhalb Schranke (absoluter Pfad) → outside-boundary', async () => {
    await expect(validateWorkspacePath('/etc/passwd', fakeDeps())).rejects.toMatchObject({
      errorClass: 'outside-boundary',
    });
  });

  it('AC2 — außerhalb Schranke (/workspace-evil) → outside-boundary (kein falscher Prefix-Match)', async () => {
    // /workspace-evil beginnt mit /workspace aber liegt NICHT darunter
    await expect(validateWorkspacePath('/workspace-evil', fakeDeps())).rejects.toMatchObject({
      errorClass: 'outside-boundary',
    });
  });

  it('AC2 — außerhalb Schranke (/tmp) → outside-boundary', async () => {
    await expect(validateWorkspacePath('/tmp', fakeDeps())).rejects.toMatchObject({
      errorClass: 'outside-boundary',
    });
  });

  it('AC2 — WORKSPACE_DIR selbst nicht gesetzt → outside-boundary', async () => {
    delete process.env.WORKSPACE_DIR;
    await expect(validateWorkspacePath('/workspace', fakeDeps())).rejects.toMatchObject({
      errorClass: 'outside-boundary',
    });
  });

  it('AC2 — WORKSPACE_DIR existiert nicht (realpath schlägt fehl) → outside-boundary', async () => {
    await expect(validateWorkspacePath('/workspace/sub', fakeDeps({ realpathMountFails: true }))).rejects.toMatchObject({
      errorClass: 'outside-boundary',
    });
  });

  it('AC2 — Symlink-Escape: Pfad syntaktisch INNERHALB Schranke, realpath zeigt AUSSERHALB → outside-boundary', async () => {
    // /workspace/outside-link liegt syntaktisch innerhalb /workspace, aber der Symlink
    // zeigt nach /etc — die realpath-Auflösung muss das Escaping erkennen.
    const symlinkDeps = {
      realpath: async (p) => {
        if (p === MOUNT_ROOT) return MOUNT_ROOT;
        if (p.includes('outside-link')) return '/etc';
        return p;
      },
      stat: async () => ({ isDirectory: () => true }),
      access: async () => {},
    };
    await expect(validateWorkspacePath('/workspace/outside-link', symlinkDeps)).rejects.toMatchObject({
      errorClass: 'outside-boundary',
    });
  });

  it('AC3 — Pfad existiert nicht (stat schlägt fehl, realpath auch) → not-exists', async () => {
    await expect(validateWorkspacePath('/workspace/nonexistent', fakeDeps({ realpathInputFails: true, statFails: true }))).rejects.toMatchObject({
      errorClass: 'not-exists',
    });
  });

  it('AC3 — Pfad existiert aber ist kein Verzeichnis → not-directory', async () => {
    await expect(validateWorkspacePath('/workspace/file.txt', fakeDeps({ isDir: false }))).rejects.toMatchObject({
      errorClass: 'not-directory',
    });
  });

  it('AC3 — Pfad existiert, Verzeichnis, aber nicht schreibbar → not-writable', async () => {
    await expect(validateWorkspacePath('/workspace/readonly', fakeDeps({ accessFails: true }))).rejects.toMatchObject({
      errorClass: 'not-writable',
    });
  });

  it('AC3 — gültiger Pfad → gibt resolvedPath zurück', async () => {
    const result = await validateWorkspacePath('/workspace/projects', fakeDeps());
    expect(result).toHaveProperty('resolvedPath');
    expect(result.resolvedPath).toBe('/workspace/projects');
  });
});

// ── Unit tests: CredentialStore workspace-path API ───────────────────────────

describe('CredentialStore — workspace-path meta-Block (AC4/AC6)', () => {
  let storeDir, store;

  beforeEach(async () => {
    storeDir = join(tmpdir(), `cred-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(storeDir, { recursive: true });
    store = new CredentialStore({ dir: storeDir, masterKey: null });
  });

  afterEach(async () => {
    await rm(storeDir, { recursive: true, force: true });
  });

  it('AC6 — readWorkspacePath() → null wenn nicht konfiguriert', async () => {
    const path = await store.readWorkspacePath();
    expect(path).toBeNull();
  });

  it('AC4 — writeWorkspacePath() persistiert Wert; readWorkspacePath() liest ihn', async () => {
    await store.writeWorkspacePath('/workspace/my-project');
    const path = await store.readWorkspacePath();
    expect(path).toBe('/workspace/my-project');
  });

  it('AC4 — Persistenz überlebt Neustart-Simulation (neuer CredentialStore, gleicher Dir)', async () => {
    await store.writeWorkspacePath('/workspace/persistent-path');
    // Simulate restart: new CredentialStore instance with same dir
    const store2 = new CredentialStore({ dir: storeDir, masterKey: null });
    const path = await store2.readWorkspacePath();
    expect(path).toBe('/workspace/persistent-path');
  });

  it('AC4 — deleteWorkspacePath() entfernt den Wert; readWorkspacePath() → null', async () => {
    await store.writeWorkspacePath('/workspace/to-delete');
    await store.deleteWorkspacePath();
    const path = await store.readWorkspacePath();
    expect(path).toBeNull();
  });

  it('AC4 — deleteWorkspacePath() idempotent (kein Fehler wenn nicht gesetzt)', async () => {
    // Nothing set — should not throw
    await expect(store.deleteWorkspacePath()).resolves.not.toThrow();
  });

  it('AC6 — Wert liegt im meta-Block, NICHT in entries (kein verschlüsselter Block)', async () => {
    await store.writeWorkspacePath('/workspace/check');
    // Read raw file to verify structure
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(storeDir, 'secrets.enc.json'), 'utf8');
    const parsed = JSON.parse(raw);
    // Path must be in meta, not in entries
    expect(parsed.meta?.['settings/workspace-path']?.value).toBe('/workspace/check');
    // entries must NOT contain the path (no encryption of non-secret)
    const entriesStr = JSON.stringify(parsed.entries ?? {});
    expect(entriesStr).not.toContain('/workspace/check');
  });

  it('AC6 — writeWorkspacePath() überschreibt vorherigen Wert', async () => {
    await store.writeWorkspacePath('/workspace/old');
    await store.writeWorkspacePath('/workspace/new');
    const path = await store.readWorkspacePath();
    expect(path).toBe('/workspace/new');
  });
});

// ── Unit tests: buildWorkspaceRootResolver ────────────────────────────────────

describe('buildWorkspaceRootResolver — AC5/AC9 Effektivwert-Auflösung', () => {
  const origWorkspaceDir = process.env.WORKSPACE_DIR;

  afterEach(() => {
    if (origWorkspaceDir !== undefined) {
      process.env.WORKSPACE_DIR = origWorkspaceDir;
    } else {
      delete process.env.WORKSPACE_DIR;
    }
  });

  it('AC9 — kein CredentialStore → env-Fallback', async () => {
    process.env.WORKSPACE_DIR = '/workspace-env';
    const resolver = buildWorkspaceRootResolver(null);
    const result = await resolver();
    expect(result.path).toBe('/workspace-env');
    expect(result.source).toBe('env-default');
  });

  it('AC5 — konfigurierter Wert → source: configured', async () => {
    const fakeStore = { readWorkspacePath: async () => '/workspace/configured' };
    process.env.WORKSPACE_DIR = '/workspace-env';
    const resolver = buildWorkspaceRootResolver(fakeStore);
    const result = await resolver();
    expect(result.path).toBe('/workspace/configured');
    expect(result.source).toBe('configured');
  });

  it('AC9 — konfiguriert null → env-Fallback', async () => {
    const fakeStore = { readWorkspacePath: async () => null };
    process.env.WORKSPACE_DIR = '/workspace-env-fallback';
    const resolver = buildWorkspaceRootResolver(fakeStore);
    const result = await resolver();
    expect(result.path).toBe('/workspace-env-fallback');
    expect(result.source).toBe('env-default');
  });

  it('AC5 — Resolver wird pro Operation aufgerufen (nicht gecacht)', async () => {
    let callCount = 0;
    let currentPath = '/workspace/v1';
    const fakeStore = {
      readWorkspacePath: async () => {
        callCount++;
        return currentPath;
      },
    };
    const resolver = buildWorkspaceRootResolver(fakeStore);

    const r1 = await resolver();
    expect(r1.path).toBe('/workspace/v1');

    // Simulates a runtime change without restart
    currentPath = '/workspace/v2';
    const r2 = await resolver();
    expect(r2.path).toBe('/workspace/v2');

    expect(callCount).toBe(2); // called twice, not cached
  });

  it('AC9 — Store-Fehler → env-Fallback (kein Crash)', async () => {
    const fakeStore = { readWorkspacePath: async () => { throw new Error('Store down'); } };
    process.env.WORKSPACE_DIR = '/workspace-fallback-on-error';
    const resolver = buildWorkspaceRootResolver(fakeStore);
    const result = await resolver();
    expect(result.path).toBe('/workspace-fallback-on-error');
    expect(result.source).toBe('env-default');
  });
});

// ── Integration tests: GET /api/settings/workspace-path ─────────────────────

describe('GET /api/settings/workspace-path (AC1/AC5/AC9)', () => {
  let server, port;

  beforeEach(() => {
    process.env.DEV_NO_ACCESS = '1';
    process.env.WORKSPACE_DIR = '/workspace';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
    delete process.env.WORKSPACE_DIR;
    delete process.env.CRED_ADMIN_EMAILS;
  });

  it('AC9 — nicht konfiguriert → source: env-default, mountRoot gesetzt', async () => {
    const credStore = makeFakeCredStore(null);
    const app = makeApp(credStore, new AuditStore());
    ({ server, port } = await startServer(app));

    const res = await get(port, '/api/settings/workspace-path');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('env-default');
    expect(res.body.mountRoot).toBe('/workspace');
    expect(res.body.effectivePath).toBe('/workspace');
  });

  it('AC5 — konfiguriert → source: configured, effectivePath = konfigurierter Wert', async () => {
    const credStore = makeFakeCredStore('/workspace/my-project');
    const app = makeApp(credStore, new AuditStore());
    ({ server, port } = await startServer(app));

    const res = await get(port, '/api/settings/workspace-path');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('configured');
    expect(res.body.effectivePath).toBe('/workspace/my-project');
    expect(res.body.mountRoot).toBe('/workspace');
  });

  it('AC6 — Wert im Klartext in der Response (kein Secret)', async () => {
    const credStore = makeFakeCredStore('/workspace/plaintext-path');
    const app = makeApp(credStore, new AuditStore());
    ({ server, port } = await startServer(app));

    const res = await get(port, '/api/settings/workspace-path');
    expect(res.status).toBe(200);
    expect(res.body.effectivePath).toBe('/workspace/plaintext-path');
  });

  it('AC8 — GET ist hinter AccessGuard aber NICHT zusätzlich rollengeschützt', async () => {
    // CRED_ADMIN_EMAILS gesetzt, aber GET sollte trotzdem klappen (nur mutierende EPs geschützt)
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com'; // dev@local ist nicht in der Liste
    const credStore = makeFakeCredStore(null);
    const app = makeApp(credStore, new AuditStore());
    ({ server, port } = await startServer(app));

    const res = await get(port, '/api/settings/workspace-path');
    expect(res.status).toBe(200); // kein 403 für GET
  });
});

// ── Integration tests: PUT /api/settings/workspace-path ─────────────────────

describe('PUT /api/settings/workspace-path (AC2/AC3/AC7/AC8)', () => {
  let server, port, auditStore;

  beforeEach(() => {
    process.env.DEV_NO_ACCESS = '1';
    process.env.WORKSPACE_DIR = '/workspace';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
    delete process.env.WORKSPACE_DIR;
    delete process.env.CRED_ADMIN_EMAILS;
  });

  async function startTestApp(credStore, opts = {}) {
    auditStore = new AuditStore();
    // validatePath fake: erlaubt /workspace/* und /workspace selbst; alles andere schlägt fehl
    const fakeDepsSuccess = {
      validatePath: async (p) => {
        if (!p.startsWith('/workspace')) {
          const { WorkspacePathError: WPE } = await import('../src/workspacePath.js');
          throw new WPE('Pfad außerhalb Schranke', 'outside-boundary');
        }
        return { resolvedPath: p };
      },
    };
    const app = makeApp(credStore, auditStore, opts.deps ?? fakeDepsSuccess);
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  }

  it('AC2/AC3 — gültiger Pfad → 200 { effectivePath, source: "configured" }', async () => {
    const credStore = makeFakeCredStore(null);
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/workspace-path', { path: '/workspace/projects' });
    expect(res.status).toBe(200);
    expect(res.body.effectivePath).toBe('/workspace/projects');
    expect(res.body.source).toBe('configured');
  });

  it('AC2 — außerhalb Schranke → 422, Effektivwert unverändert', async () => {
    const credStore = makeFakeCredStore('/workspace/original');
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/workspace-path', { path: '/etc/passwd' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBeTruthy();
    // Effektivwert unverändert
    expect(credStore._getStoredPath()).toBe('/workspace/original');
  });

  it('AC3 — leerer Pfad → 422', async () => {
    const credStore = makeFakeCredStore(null);
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/workspace-path', { path: '' });
    expect(res.status).toBe(422);
  });

  it('AC3 — fehlendes path-Feld → 422', async () => {
    const credStore = makeFakeCredStore(null);
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/workspace-path', {});
    expect(res.status).toBe(422);
  });

  it('AC8 — CRED_ADMIN_EMAILS gesetzt, dev@local nicht in Liste → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    const credStore = makeFakeCredStore(null);
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/workspace-path', { path: '/workspace/x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/berechtigung/i);
  });

  it('AC8 — CRED_ADMIN_EMAILS gesetzt, dev@local in Liste → 200', async () => {
    process.env.CRED_ADMIN_EMAILS = 'dev@local,admin@example.com';
    const credStore = makeFakeCredStore(null);
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/workspace-path', { path: '/workspace/allowed' });
    expect(res.status).toBe(200);
  });

  it('AC7 — Audit-First: Intent-Eintrag vor Persistierung (callOrder)', async () => {
    const callOrder = [];
    const credStore = {
      readWorkspacePath: async () => null,
      writeWorkspacePath: async (p) => { callOrder.push(`write:${p}`); return { updatedAt: new Date().toISOString() }; },
      deleteWorkspacePath: async () => {},
    };
    const spyAudit = {
      record(entry) {
        callOrder.push(`audit:${entry.command.split(':')[0]}:${entry.command.split(':')[1]}`);
        auditStore.record(entry);
      },
    };
    auditStore = new AuditStore();
    const app = makeApp(credStore, spyAudit, {
      validatePath: async (p) => ({ resolvedPath: p }),
    });
    const started = await startServer(app);
    server = started.server;
    port = started.port;

    await put(port, '/api/settings/workspace-path', { path: '/workspace/test' });

    const intentIdx = callOrder.findIndex((e) => e.startsWith('audit:workspace-path:set'));
    const writeIdx = callOrder.findIndex((e) => e.startsWith('write:'));
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(intentIdx); // Audit vor Write
  });

  it('AC7 — Audit-Write-Fehler blockiert Mutation (Audit-First)', async () => {
    let writeCalled = false;
    const credStore = {
      readWorkspacePath: async () => null,
      writeWorkspacePath: async () => { writeCalled = true; return {}; },
      deleteWorkspacePath: async () => {},
    };
    const brokenAudit = { record() { throw new Error('Audit store down'); } };
    const app = makeApp(credStore, brokenAudit, {
      validatePath: async (p) => ({ resolvedPath: p }),
    });
    const started = await startServer(app);
    server = started.server;
    port = started.port;

    const res = await put(port, '/api/settings/workspace-path', { path: '/workspace/test' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/audit/i);
    expect(writeCalled).toBe(false);
  });

  it('AC7 — Audit-Einträge enthalten alt→neu (Identität, Aktion, Pfad)', async () => {
    const credStore = makeFakeCredStore('/workspace/old');
    await startTestApp(credStore);
    await put(port, '/api/settings/workspace-path', { path: '/workspace/new' });

    const entries = auditStore.getAll();
    const intentEntry = entries.find((e) => e.command.includes('workspace-path:set'));
    expect(intentEntry).toBeDefined();
    expect(intentEntry.command).toContain('workspace-path:set');
    expect(intentEntry.command).toContain('/workspace/old');
    expect(intentEntry.command).toContain('/workspace/new');
  });

  it('AC7 — Outcome-Audit nach erfolgreicher Mutation', async () => {
    const credStore = makeFakeCredStore(null);
    await startTestApp(credStore);
    await put(port, '/api/settings/workspace-path', { path: '/workspace/test' });

    const entries = auditStore.getAll();
    const outcomeEntry = entries.find((e) => e.command.includes('workspace-path:set:success'));
    expect(outcomeEntry).toBeDefined();
  });

  it('AC7 — Outcome-Audit nach fehlgeschlagener Validierung (Fehlerpfad)', async () => {
    const credStore = makeFakeCredStore(null);
    await startTestApp(credStore);
    await put(port, '/api/settings/workspace-path', { path: '/etc/invalid' });

    const entries = auditStore.getAll();
    const failedEntry = entries.find((e) => e.command.includes('workspace-path:set:failed'));
    expect(failedEntry).toBeDefined();
  });
});

// ── Integration tests: DELETE /api/settings/workspace-path ───────────────────

describe('DELETE /api/settings/workspace-path (AC7/AC8)', () => {
  let server, port, auditStore;

  beforeEach(() => {
    process.env.DEV_NO_ACCESS = '1';
    process.env.WORKSPACE_DIR = '/workspace-mount';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
    delete process.env.WORKSPACE_DIR;
    delete process.env.CRED_ADMIN_EMAILS;
  });

  async function startTestApp(credStore) {
    auditStore = new AuditStore();
    const app = makeApp(credStore, auditStore);
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  }

  it('AC9 — DELETE → 200 { source: "env-default", effectivePath = WORKSPACE_DIR }', async () => {
    const credStore = makeFakeCredStore('/workspace/configured');
    await startTestApp(credStore);
    const res = await del(port, '/api/settings/workspace-path');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('env-default');
    expect(res.body.effectivePath).toBe('/workspace-mount');
    // konfigurierter Wert gelöscht
    expect(credStore._getStoredPath()).toBeNull();
  });

  it('AC8 — CRED_ADMIN_EMAILS gesetzt, nicht berechtigt → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    const credStore = makeFakeCredStore(null);
    await startTestApp(credStore);
    const res = await del(port, '/api/settings/workspace-path');
    expect(res.status).toBe(403);
  });

  it('AC7 — Audit-First bei DELETE: Intent vor Mutation', async () => {
    const callOrder = [];
    const credStore = {
      readWorkspacePath: async () => '/workspace/to-delete',
      writeWorkspacePath: async () => {},
      deleteWorkspacePath: async () => { callOrder.push('delete'); },
    };
    const spyAudit = {
      record(entry) {
        callOrder.push(`audit:${entry.command.substring(0, 30)}`);
        auditStore.record(entry);
      },
    };
    auditStore = new AuditStore();
    const app = makeApp(credStore, spyAudit);
    const started = await startServer(app);
    server = started.server;
    port = started.port;

    await del(port, '/api/settings/workspace-path');

    const intentIdx = callOrder.findIndex((e) => e.includes('workspace-path:delete'));
    const deleteIdx = callOrder.findIndex((e) => e === 'delete');
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(intentIdx);
  });

  it('AC7 — Audit-Write-Fehler blockiert DELETE (Audit-First)', async () => {
    let deleteCalled = false;
    const credStore = {
      readWorkspacePath: async () => null,
      writeWorkspacePath: async () => {},
      deleteWorkspacePath: async () => { deleteCalled = true; },
    };
    const brokenAudit = { record() { throw new Error('Audit store down'); } };
    const app = makeApp(credStore, brokenAudit);
    const started = await startServer(app);
    server = started.server;
    port = started.port;

    const res = await del(port, '/api/settings/workspace-path');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/audit/i);
    expect(deleteCalled).toBe(false);
  });
});

// ── AC5/AC9: WorkspaceScanner nutzt workspaceRootResolver ────────────────────

describe('WorkspaceScanner — AC5/AC9: workspaceRootResolver (Effektivwert pro Operation)', () => {
  it('AC9 — ohne Resolver: env-Fallback (Verhaltensneutralität)', async () => {
    // Kein Resolver → Scanner nutzt workspaceDir direkt
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace-env',
      fsDeps: {
        readdir: async () => [],
        stat: async () => { throw new Error('ENOENT'); },
      },
      execFn: async () => ({ stdout: '' }),
    });
    const clones = await scanner.listClones();
    expect(clones).toEqual([]);
    // kein Fehler, kein Crash
  });

  it('AC5 — Resolver liefert /workspace/custom → Scanner scannt diesen Pfad', async () => {
    let readdirCalledWith = null;
    const resolver = async () => ({ path: '/workspace/custom', source: 'configured' });
    const scanner = new WorkspaceScanner({
      workspaceRootResolver: resolver,
      fsDeps: {
        readdir: async (p) => { readdirCalledWith = p; return []; },
        stat: async () => { throw new Error('ENOENT'); },
      },
      execFn: async () => ({ stdout: '' }),
    });
    await scanner.listClones();
    expect(readdirCalledWith).toBe('/workspace/custom');
  });

  it('AC5 — Resolver-Wert ändert sich zwischen Aufrufen → zweiter Aufruf nutzt neuen Wert', async () => {
    let configuredPath = '/workspace/v1';
    const resolver = async () => ({ path: configuredPath, source: 'configured' });
    const readdirPaths = [];
    const scanner = new WorkspaceScanner({
      workspaceRootResolver: resolver,
      fsDeps: {
        readdir: async (p) => { readdirPaths.push(p); return []; },
        stat: async () => { throw new Error('ENOENT'); },
      },
      execFn: async () => ({ stdout: '' }),
    });

    await scanner.listClones();
    configuredPath = '/workspace/v2';
    await scanner.listClones();

    expect(readdirPaths[0]).toBe('/workspace/v1');
    expect(readdirPaths[1]).toBe('/workspace/v2');
  });

  it('AC9 — Resolver-Fehler → Fallback auf workspaceDir (kein Crash)', async () => {
    let readdirCalledWith = null;
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace-fallback',
      workspaceRootResolver: async () => { throw new Error('Resolver down'); },
      fsDeps: {
        readdir: async (p) => { readdirCalledWith = p; return []; },
        stat: async () => { throw new Error('ENOENT'); },
      },
      execFn: async () => ({ stdout: '' }),
    });
    await scanner.listClones();
    expect(readdirCalledWith).toBe('/workspace-fallback');
  });
});

// ── AC5/AC9: WorkspaceMutator nutzt workspaceRootResolver ────────────────────

describe('WorkspaceMutator — AC5/AC9: workspaceRootResolver (Effektivwert pro Operation)', () => {
  it('AC9 — ohne Resolver: workspaceDir-Fallback (Verhaltensneutralität)', async () => {
    let rmCalledWith = null;
    const mutator = new WorkspaceMutator({
      workspaceDir: '/workspace-direct',
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},
      },
      execFn: async (_cmd, args) => { rmCalledWith = args; },
    });
    await mutator.deleteClone('my-repo');
    expect(rmCalledWith).toContain('/workspace-direct/my-repo');
  });

  it('AC5 — Resolver liefert /workspace/custom → Mutator operiert dort', async () => {
    let rmCalledWith = null;
    const resolver = async () => ({ path: '/workspace/custom', source: 'configured' });
    const mutator = new WorkspaceMutator({
      workspaceRootResolver: resolver,
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},
      },
      execFn: async (_cmd, args) => { rmCalledWith = args; },
    });
    await mutator.deleteClone('my-repo');
    expect(rmCalledWith).toContain('/workspace/custom/my-repo');
  });

  it('AC5 — Resolver ändert sich zwischen Operationen → nachfolgende Op nutzt neuen Wert', async () => {
    let configuredPath = '/workspace/v1';
    const resolver = async () => ({ path: configuredPath, source: 'configured' });
    const rmPaths = [];
    const mutator = new WorkspaceMutator({
      workspaceRootResolver: resolver,
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},
      },
      execFn: async (_cmd, args) => { rmPaths.push(args[2]); },
    });

    await mutator.deleteClone('repo-a');
    configuredPath = '/workspace/v2';
    await mutator.deleteClone('repo-b');

    expect(rmPaths[0]).toBe('/workspace/v1/repo-a');
    expect(rmPaths[1]).toBe('/workspace/v2/repo-b');
  });

  it('AC9 — Resolver-Fehler → workspaceDir-Fallback (kein Crash)', async () => {
    let rmCalledWith = null;
    const mutator = new WorkspaceMutator({
      workspaceDir: '/workspace-fallback',
      workspaceRootResolver: async () => { throw new Error('Resolver down'); },
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},
      },
      execFn: async (_cmd, args) => { rmCalledWith = args; },
    });
    await mutator.deleteClone('repo');
    expect(rmCalledWith).toContain('/workspace-fallback/repo');
  });
});

// ── AC5/AC9: GitHubCloner nutzt workspaceRootResolver ────────────────────────

describe('GitHubCloner — AC5/AC9: workspaceRootResolver (Effektivwert pro Operation)', () => {
  it('AC9 — ohne Resolver: workspaceDir-Fallback (Verhaltensneutralität)', async () => {
    // Cloner mit workspaceDir, kein Resolver → schlägt fehl mit workspace-missing (kein echtes FS)
    const cloner = new GitHubCloner({
      workspaceDir: '',
      fsDeps: {
        mkdir: async () => {},
        access: async () => {},
        realpath: async (p) => p,
        rm: async () => {},
        writeFile: async () => {},
      },
      execFn: async () => ({}),
    });
    await expect(cloner.cloneRepo({ repoName: 'my-repo' })).rejects.toMatchObject({
      errorClass: 'workspace-missing',
    });
  });

  it('AC5 — Resolver liefert /workspace/custom → Cloner nutzt dieses Verzeichnis (mkdir-Call)', async () => {
    // Wir prüfen via mkdir-Call: #ensureWorkspaceDir(wsDir) ruft mkdir(wsDir) auf.
    // So ist verifizierbar, welchen Workspace-Root der Cloner aufgelöst hat.
    let mkdirCalledWith = null;
    const resolver = async () => ({ path: '/workspace/custom', source: 'configured' });
    const cloner = new GitHubCloner({
      workspaceRootResolver: resolver,
      // kein credentialStore → wirft credential-store-missing NACH #ensureWorkspaceDir
      fsDeps: {
        mkdir: async (p) => { mkdirCalledWith = p; },
        access: async () => { throw new Error('ENOENT'); },
        realpath: async (p) => p,
        rm: async () => {},
        writeFile: async () => {},
      },
      execFn: async () => ({ stdout: '', stderr: '' }),
    });
    // Error expected (no credentials), but mkdir must have been called with the resolved path
    await cloner.cloneRepo({ repoName: 'test-repo' }).catch(() => {});
    expect(mkdirCalledWith).toBe('/workspace/custom');
  });

  it('AC9 — Resolver-Fehler → workspaceDir-Fallback (mkdir mit Fallback-Pfad)', async () => {
    let mkdirCalledWith = null;
    const cloner = new GitHubCloner({
      workspaceDir: '/workspace-fallback',
      workspaceRootResolver: async () => { throw new Error('Resolver down'); },
      fsDeps: {
        mkdir: async (p) => { mkdirCalledWith = p; },
        access: async () => { throw new Error('ENOENT'); },
        realpath: async (p) => p,
        rm: async () => {},
        writeFile: async () => {},
      },
      execFn: async () => ({ stdout: '', stderr: '' }),
    });
    await cloner.cloneRepo({ repoName: 'test-repo' }).catch(() => {});
    expect(mkdirCalledWith).toBe('/workspace-fallback');
  });
});

// ── AC8: AccessGuard (mutierende EPs ohne Token → 403) ───────────────────────

describe('PUT/DELETE /api/settings/workspace-path — AC8: kein Access → 403', () => {
  it('PUT ohne AccessGuard-Token → 403', async () => {
    delete process.env.DEV_NO_ACCESS;
    const savedDomain = process.env.ACCESS_TEAM_DOMAIN;
    const savedAud = process.env.ACCESS_AUD;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;

    const credStore = makeFakeCredStore(null);
    const app = makeApp(credStore, new AuditStore());
    const { server, port } = await startServer(app);
    try {
      const res = await put(port, '/api/settings/workspace-path', { path: '/workspace/x' });
      expect(res.status).toBe(403);
    } finally {
      await closeServer(server);
      if (savedDomain !== undefined) process.env.ACCESS_TEAM_DOMAIN = savedDomain;
      if (savedAud !== undefined) process.env.ACCESS_AUD = savedAud;
    }
  });

  it('DELETE ohne AccessGuard-Token → 403', async () => {
    delete process.env.DEV_NO_ACCESS;
    const savedDomain = process.env.ACCESS_TEAM_DOMAIN;
    const savedAud = process.env.ACCESS_AUD;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;

    const credStore = makeFakeCredStore(null);
    const app = makeApp(credStore, new AuditStore());
    const { server, port } = await startServer(app);
    try {
      const res = await del(port, '/api/settings/workspace-path');
      expect(res.status).toBe(403);
    } finally {
      await closeServer(server);
      if (savedDomain !== undefined) process.env.ACCESS_TEAM_DOMAIN = savedDomain;
      if (savedAud !== undefined) process.env.ACCESS_AUD = savedAud;
    }
  });
});
