/**
 * obsidianVaultPath.test.js — Tests für obsidian-vault-config (S-245, AC1–AC4, AC6, AC7)
 *
 * Covers (obsidian-vault-config):
 *   AC1 — GET liefert konfigurierten Pfad + Zustand (configured/not); PUT setzt/ändert,
 *         DELETE setzt zurück (HTTP-Ebene).
 *   AC2 — Beim Setzen wird geprüft: existiert / Verzeichnis / lesbar / enthält „Projekte";
 *         Fehler → 422 mit feldzugeordneter Meldung, bisher konfigurierter Wert unverändert.
 *   AC3 — Traversal-/Symlink-Schutz: ist OBSIDIAN_VAULT_DIR gesetzt, wird ein Pfad außerhalb
 *         (absoluter Pfad, `/vault-evil`-Prefix, Symlink-Flucht) mit outside-boundary abgewiesen,
 *         ohne wirksam zu werden; ohne gesetzte Env → kein Containment-Fehler.
 *   AC4 — Persistenz im meta-Block (Klartext), NICHT in entries; überlebt Neustart-Simulation.
 *   AC6 — Audit-First (Intent vor Mutation; Audit-Write-Fehler blockiert Mutation; alt→neu).
 *   AC7 — 403 ohne CRED_ADMIN_EMAILS-Berechtigung; GET (read-only) kein zusätzlicher Rollencheck.
 *   AC5 — Projekt-Auflistung `GET .../obsidian-vault/projects` — NICHT in diesem Item (S-246);
 *         hier bewusst nicht getestet (baut auf dieser Config-Boundary auf).
 *
 * Strategy:
 *   - CredentialStore.read/write/deleteObsidianVaultPath: Unit-Tests mit echtem CredentialStore
 *     (tmp-Dir, kein Master-Key nötig da meta-only).
 *   - validateObsidianVaultPath: Unit-Tests — Happy/Sad-Paths mit echtem fs (tmp-Vault) +
 *     Traversal/Symlink/Boundary mit injizierten fsDeps.
 *   - obsidianVaultPathRouter: HTTP-Integration via Express + AccessGuard-Dev-Bypass (DEV_NO_ACCESS).
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { CredentialStore } from '../src/CredentialStore.js';
import {
  validateObsidianVaultPath,
  ObsidianVaultPathError,
  resolveMountRoot,
  PROJEKTE_SUBDIR,
} from '../src/obsidianVaultPath.js';
import { obsidianVaultPathRouter } from '../src/obsidianVaultPathRouter.js';
import { AuditStore } from '../src/AuditStore.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
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
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
const get = (port, path) => httpReq(port, 'GET', path);
const put = (port, path, body) => httpReq(port, 'PUT', path, body);
const del = (port, path) => httpReq(port, 'DELETE', path);

// ── App builder ───────────────────────────────────────────────────────────────

function makeApp(credentialStore, auditStore, deps = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAccessGuard());
  app.use(obsidianVaultPathRouter(credentialStore, auditStore, deps));
  return app;
}

// ── Fake CredentialStore ──────────────────────────────────────────────────────

function makeFakeCredStore(initialPath = null) {
  let stored = initialPath;
  return {
    async readObsidianVaultPath() { return stored; },
    async writeObsidianVaultPath(p) { stored = p; return { updatedAt: new Date().toISOString() }; },
    async deleteObsidianVaultPath() { stored = null; return {}; },
    _get() { return stored; },
  };
}

// ── Unit tests: validateObsidianVaultPath (echtes fs, AC2) ───────────────────

describe('validateObsidianVaultPath — AC2 (echtes fs)', () => {
  let vaultDir;

  beforeEach(async () => {
    vaultDir = join(tmpdir(), `obs-vault-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(vaultDir, PROJEKTE_SUBDIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
    delete process.env.OBSIDIAN_VAULT_DIR;
  });

  it('AC2 — gültiger Vault (existiert, Verzeichnis, lesbar, enthält „Projekte") → resolvedPath', async () => {
    const { resolvedPath } = await validateObsidianVaultPath(vaultDir);
    // realpath kann /var→/private/var (macOS) o.ä. normalisieren → endsWith reicht
    expect(resolvedPath.endsWith(vaultDir.split('/').pop())).toBe(true);
  });

  it('AC2 — leer/whitespace → empty-path', async () => {
    await expect(validateObsidianVaultPath('')).rejects.toMatchObject({ errorClass: 'empty-path' });
    await expect(validateObsidianVaultPath('   ')).rejects.toMatchObject({ errorClass: 'empty-path' });
  });

  it('AC2 — nicht-existent → not-exists', async () => {
    await expect(validateObsidianVaultPath(join(vaultDir, 'does-not-exist')))
      .rejects.toMatchObject({ errorClass: 'not-exists' });
  });

  it('AC2 — Pfad ist Datei (kein Verzeichnis) → not-directory', async () => {
    const filePath = join(vaultDir, 'a-file.md');
    await writeFile(filePath, 'note');
    await expect(validateObsidianVaultPath(filePath))
      .rejects.toMatchObject({ errorClass: 'not-directory' });
  });

  it('AC2 — Verzeichnis ohne Unterordner „Projekte" → missing-projekte', async () => {
    const emptyDir = join(tmpdir(), `obs-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(emptyDir, { recursive: true });
    try {
      await expect(validateObsidianVaultPath(emptyDir))
        .rejects.toMatchObject({ errorClass: 'missing-projekte' });
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('AC2 — „Projekte" existiert, ist aber eine Datei → missing-projekte', async () => {
    const dir = join(tmpdir(), `obs-projfile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, PROJEKTE_SUBDIR), 'not a dir');
    try {
      await expect(validateObsidianVaultPath(dir))
        .rejects.toMatchObject({ errorClass: 'missing-projekte' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ObsidianVaultPathError trägt name + errorClass', async () => {
    const err = await validateObsidianVaultPath('').catch((e) => e);
    expect(err).toBeInstanceOf(ObsidianVaultPathError);
    expect(err.name).toBe('ObsidianVaultPathError');
  });
});

// ── Unit tests: validateObsidianVaultPath — Containment/Symlink (AC3, injizierte deps) ──

describe('validateObsidianVaultPath — AC3 Containment/Symlink (injiziert)', () => {
  const MOUNT = '/vault';

  // fsDeps: alles existiert/ist Verzeichnis/lesbar/hat Projekte; realpath = identity.
  function okDeps(overrides = {}) {
    return {
      mountRoot: MOUNT,
      realpath: async (p) => p,
      stat: async () => ({ isDirectory: () => true }),
      access: async () => {},
      ...overrides,
    };
  }

  it('AC3 — Pfad = exakt Schranke → erlaubt', async () => {
    const { resolvedPath } = await validateObsidianVaultPath(MOUNT, okDeps());
    expect(resolvedPath).toBe(MOUNT);
  });

  it('AC3 — Unterordner der Schranke → erlaubt', async () => {
    const { resolvedPath } = await validateObsidianVaultPath('/vault/my-notes', okDeps());
    expect(resolvedPath).toBe('/vault/my-notes');
  });

  it('AC3 — außerhalb Schranke (absoluter Pfad) → outside-boundary', async () => {
    await expect(validateObsidianVaultPath('/etc/passwd', okDeps()))
      .rejects.toMatchObject({ errorClass: 'outside-boundary' });
  });

  it('AC3 — Prefix-Falle /vault-evil → outside-boundary (kein nackter startsWith)', async () => {
    await expect(validateObsidianVaultPath('/vault-evil', okDeps()))
      .rejects.toMatchObject({ errorClass: 'outside-boundary' });
  });

  it('AC3 — Symlink-Flucht: syntaktisch innerhalb, realpath zeigt außerhalb → outside-boundary', async () => {
    const deps = okDeps({
      realpath: async (p) => {
        if (p === MOUNT) return MOUNT;
        if (p.includes('escape-link')) return '/etc';
        return p;
      },
    });
    await expect(validateObsidianVaultPath('/vault/escape-link', deps))
      .rejects.toMatchObject({ errorClass: 'outside-boundary' });
  });

  it('AC3 — Schranke existiert nicht (realpath schlägt fehl) → outside-boundary', async () => {
    const deps = okDeps({
      realpath: async (p) => { if (p === MOUNT) throw new Error('ENOENT'); return p; },
    });
    await expect(validateObsidianVaultPath('/vault/sub', deps))
      .rejects.toMatchObject({ errorClass: 'outside-boundary' });
  });

  it('AC3 — OHNE gesetzte Schranke: kein Containment-Fehler (nur lesbar-Prüfung)', async () => {
    // mountRoot undefined → boundary inaktiv; /somewhere/else ist erlaubt sofern es existiert.
    const deps = {
      realpath: async (p) => p,
      stat: async () => ({ isDirectory: () => true }),
      access: async () => {},
    };
    const { resolvedPath } = await validateObsidianVaultPath('/anywhere/vault', deps);
    expect(resolvedPath).toBe('/anywhere/vault');
  });

  it('AC2 — nicht lesbar (access wirft) → not-readable', async () => {
    const deps = okDeps({ access: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
    await expect(validateObsidianVaultPath('/vault/notes', deps))
      .rejects.toMatchObject({ errorClass: 'not-readable' });
  });

  it('AC2 — „Projekte" fehlt (stat auf Projekte wirft) → missing-projekte', async () => {
    let call = 0;
    const deps = okDeps({
      stat: async () => {
        call += 1;
        if (call === 1) return { isDirectory: () => true }; // Vault selbst
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); // Projekte
      },
    });
    await expect(validateObsidianVaultPath('/vault/notes', deps))
      .rejects.toMatchObject({ errorClass: 'missing-projekte' });
  });
});

// ── resolveMountRoot (AC3/GET mountRoot) ─────────────────────────────────────

describe('resolveMountRoot — Env-Auflösung', () => {
  afterEach(() => { delete process.env.OBSIDIAN_VAULT_DIR; });

  it('gibt null zurück wenn OBSIDIAN_VAULT_DIR ungesetzt', () => {
    delete process.env.OBSIDIAN_VAULT_DIR;
    expect(resolveMountRoot()).toBeNull();
  });

  it('gibt getrimmten Wert zurück wenn gesetzt', () => {
    process.env.OBSIDIAN_VAULT_DIR = '  /mnt/vault  ';
    expect(resolveMountRoot()).toBe('/mnt/vault');
  });

  it('deps.mountRoot override schlägt Env', () => {
    process.env.OBSIDIAN_VAULT_DIR = '/env-vault';
    expect(resolveMountRoot({ mountRoot: '/override' })).toBe('/override');
  });
});

// ── Unit tests: CredentialStore meta-Block (AC4) ─────────────────────────────

describe('CredentialStore — obsidian-vault-path meta-Block (AC4)', () => {
  let storeDir, store;

  beforeEach(async () => {
    storeDir = join(tmpdir(), `obs-cred-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(storeDir, { recursive: true });
    store = new CredentialStore({ dir: storeDir, masterKey: null });
  });

  afterEach(async () => {
    await rm(storeDir, { recursive: true, force: true });
  });

  it('AC4 — readObsidianVaultPath() → null wenn nicht konfiguriert', async () => {
    expect(await store.readObsidianVaultPath()).toBeNull();
  });

  it('AC4 — write persistiert; read liest ihn', async () => {
    await store.writeObsidianVaultPath('/mnt/vault/notes');
    expect(await store.readObsidianVaultPath()).toBe('/mnt/vault/notes');
  });

  it('AC4 — Persistenz überlebt Neustart-Simulation (neuer Store, gleicher Dir)', async () => {
    await store.writeObsidianVaultPath('/mnt/vault/persist');
    const store2 = new CredentialStore({ dir: storeDir, masterKey: null });
    expect(await store2.readObsidianVaultPath()).toBe('/mnt/vault/persist');
  });

  it('AC1/AC4 — delete entfernt den Wert; read → null', async () => {
    await store.writeObsidianVaultPath('/mnt/vault/to-delete');
    await store.deleteObsidianVaultPath();
    expect(await store.readObsidianVaultPath()).toBeNull();
  });

  it('AC1 — delete idempotent (kein Fehler wenn nicht gesetzt)', async () => {
    await expect(store.deleteObsidianVaultPath()).resolves.not.toThrow();
  });

  it('AC4 — Wert liegt im meta-Block, NICHT in entries (nicht-geheim, kein Secret-Block)', async () => {
    await store.writeObsidianVaultPath('/mnt/vault/plain');
    const raw = await readFile(join(storeDir, 'secrets.enc.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.meta?.['settings/obsidian-vault-path']?.value).toBe('/mnt/vault/plain');
    const entriesStr = JSON.stringify(parsed.entries ?? {});
    expect(entriesStr).not.toContain('/mnt/vault/plain');
  });

  it('AC1 — write überschreibt vorherigen Wert (ändern)', async () => {
    await store.writeObsidianVaultPath('/mnt/vault/old');
    await store.writeObsidianVaultPath('/mnt/vault/new');
    expect(await store.readObsidianVaultPath()).toBe('/mnt/vault/new');
  });

  it('AC4 — write mit leerem Pfad wirft (Programmierfehler-Schutz)', async () => {
    await expect(store.writeObsidianVaultPath('')).rejects.toThrow();
    await expect(store.writeObsidianVaultPath('   ')).rejects.toThrow();
  });
});

// ── Integration: GET /api/settings/obsidian-vault-path (AC1/AC7) ─────────────

describe('GET /api/settings/obsidian-vault-path (AC1/AC7)', () => {
  let server, port;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
    delete process.env.OBSIDIAN_VAULT_DIR;
  });

  it('AC1 — nicht konfiguriert → { vaultPath: null, configured: false }', async () => {
    ({ server, port } = await startServer(makeApp(makeFakeCredStore(null), new AuditStore())));
    const res = await get(port, '/api/settings/obsidian-vault-path');
    expect(res.status).toBe(200);
    expect(res.body.vaultPath).toBeNull();
    expect(res.body.configured).toBe(false);
  });

  it('AC1 — konfiguriert → { vaultPath, configured: true }', async () => {
    ({ server, port } = await startServer(makeApp(makeFakeCredStore('/mnt/vault/x'), new AuditStore())));
    const res = await get(port, '/api/settings/obsidian-vault-path');
    expect(res.status).toBe(200);
    expect(res.body.vaultPath).toBe('/mnt/vault/x');
    expect(res.body.configured).toBe(true);
  });

  it('AC3/AC1 — mountRoot im Response wenn OBSIDIAN_VAULT_DIR gesetzt, sonst nicht', async () => {
    process.env.OBSIDIAN_VAULT_DIR = '/mnt/vault';
    ({ server, port } = await startServer(makeApp(makeFakeCredStore(null), new AuditStore())));
    const withEnv = await get(port, '/api/settings/obsidian-vault-path');
    expect(withEnv.body.mountRoot).toBe('/mnt/vault');
    await closeServer(server);

    delete process.env.OBSIDIAN_VAULT_DIR;
    ({ server, port } = await startServer(makeApp(makeFakeCredStore(null), new AuditStore())));
    const withoutEnv = await get(port, '/api/settings/obsidian-vault-path');
    expect(withoutEnv.body.mountRoot).toBeUndefined();
  });

  it('AC7 — GET ist hinter AccessGuard, aber NICHT zusätzlich rollengeschützt', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com'; // dev@local nicht in Liste
    ({ server, port } = await startServer(makeApp(makeFakeCredStore(null), new AuditStore())));
    const res = await get(port, '/api/settings/obsidian-vault-path');
    expect(res.status).toBe(200); // kein 403 für read-only GET
  });
});

// ── Integration: PUT /api/settings/obsidian-vault-path (AC1/AC2/AC3/AC6/AC7) ─

describe('PUT /api/settings/obsidian-vault-path (AC1/AC2/AC3/AC6/AC7)', () => {
  let server, port, auditStore;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
  });

  // validatePath-Fake: erlaubt /vault/*, alles andere → outside-boundary.
  function fakeValidate() {
    return {
      validatePath: async (p) => {
        if (!p.startsWith('/vault')) {
          throw new ObsidianVaultPathError('Pfad außerhalb Schranke', 'outside-boundary');
        }
        return { resolvedPath: p };
      },
    };
  }

  async function startTestApp(credStore, opts = {}) {
    auditStore = new AuditStore();
    const app = makeApp(credStore, auditStore, opts.deps ?? fakeValidate());
    ({ server, port } = await startServer(app));
  }

  it('AC1/AC2 — gültiger Pfad → 200 { vaultPath, configured: true }', async () => {
    const credStore = makeFakeCredStore(null);
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/obsidian-vault-path', { path: '/vault/notes' });
    expect(res.status).toBe(200);
    expect(res.body.vaultPath).toBe('/vault/notes');
    expect(res.body.configured).toBe(true);
    expect(credStore._get()).toBe('/vault/notes');
  });

  it('AC1 — ändern: bereits konfiguriert → neuer Wert überschreibt', async () => {
    const credStore = makeFakeCredStore('/vault/old');
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/obsidian-vault-path', { path: '/vault/new' });
    expect(res.status).toBe(200);
    expect(credStore._get()).toBe('/vault/new');
  });

  it('AC2/AC3 — Validierungsfehler → 422 mit errorClass, alter Wert unverändert', async () => {
    const credStore = makeFakeCredStore('/vault/original');
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/obsidian-vault-path', { path: '/etc/passwd' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBeTruthy();
    // Response-Shape spiegelt workspacePathRouter (`{ error }`); die Klassifikation
    // (outside-boundary) fließt in den Audit-Trail (siehe AC6-Failed-Outcome-Test), nicht in den Body.
    expect(res.body.errorClass).toBeUndefined();
    expect(credStore._get()).toBe('/vault/original'); // unverändert
  });

  it('AC2 — leerer Pfad → 422 empty-path, kein Store-Write', async () => {
    const credStore = makeFakeCredStore('/vault/original');
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/obsidian-vault-path', { path: '   ' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBeTruthy();
    expect(credStore._get()).toBe('/vault/original');
  });

  it('AC2 — fehlendes path-Feld → 422', async () => {
    await startTestApp(makeFakeCredStore(null));
    const res = await put(port, '/api/settings/obsidian-vault-path', {});
    expect(res.status).toBe(422);
  });

  it('AC7 — CRED_ADMIN_EMAILS gesetzt, dev@local NICHT in Liste → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    const credStore = makeFakeCredStore(null);
    await startTestApp(credStore);
    const res = await put(port, '/api/settings/obsidian-vault-path', { path: '/vault/x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/berechtigung/i);
    expect(credStore._get()).toBeNull(); // keine Mutation
  });

  it('AC7 — CRED_ADMIN_EMAILS gesetzt, dev@local in Liste → 200', async () => {
    process.env.CRED_ADMIN_EMAILS = 'dev@local,admin@example.com';
    await startTestApp(makeFakeCredStore(null));
    const res = await put(port, '/api/settings/obsidian-vault-path', { path: '/vault/allowed' });
    expect(res.status).toBe(200);
  });

  it('AC6 — Audit-First: Intent-Eintrag VOR Persistierung (callOrder)', async () => {
    const callOrder = [];
    const credStore = {
      readObsidianVaultPath: async () => null,
      writeObsidianVaultPath: async (p) => { callOrder.push(`write:${p}`); return { updatedAt: new Date().toISOString() }; },
      deleteObsidianVaultPath: async () => ({}),
    };
    auditStore = new AuditStore();
    const spyAudit = {
      record(entry) { callOrder.push(`audit:${entry.command.split(':').slice(0, 3).join(':')}`); auditStore.record(entry); },
    };
    const app = makeApp(credStore, spyAudit, { validatePath: async (p) => ({ resolvedPath: p }) });
    ({ server, port } = await startServer(app));

    await put(port, '/api/settings/obsidian-vault-path', { path: '/vault/test' });

    const intentIdx = callOrder.findIndex((e) => e.startsWith('audit:obsidian-vault-path:set'));
    const writeIdx = callOrder.findIndex((e) => e.startsWith('write:'));
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(intentIdx);
  });

  it('AC6 — Audit-Write-Fehler blockiert Mutation (Audit-First)', async () => {
    let writeCalled = false;
    const credStore = {
      readObsidianVaultPath: async () => null,
      writeObsidianVaultPath: async () => { writeCalled = true; return {}; },
      deleteObsidianVaultPath: async () => ({}),
    };
    const brokenAudit = { record() { throw new Error('Audit store down'); } };
    const app = makeApp(credStore, brokenAudit, { validatePath: async (p) => ({ resolvedPath: p }) });
    ({ server, port } = await startServer(app));

    const res = await put(port, '/api/settings/obsidian-vault-path', { path: '/vault/test' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/audit/i);
    expect(writeCalled).toBe(false);
  });

  it('AC6 — Intent-Audit enthält alt→neu (Identität, Aktion, Pfad)', async () => {
    const credStore = makeFakeCredStore('/vault/old');
    await startTestApp(credStore);
    await put(port, '/api/settings/obsidian-vault-path', { path: '/vault/new' });
    const intent = auditStore.getAll().find((e) => e.command.includes('obsidian-vault-path:set'));
    expect(intent).toBeDefined();
    expect(intent.command).toContain('/vault/old');
    expect(intent.command).toContain('/vault/new');
  });

  it('AC6 — Outcome-Audit (success) nach erfolgreicher Mutation', async () => {
    await startTestApp(makeFakeCredStore(null));
    await put(port, '/api/settings/obsidian-vault-path', { path: '/vault/test' });
    const outcome = auditStore.getAll().find((e) => e.command.includes('obsidian-vault-path:set:success'));
    expect(outcome).toBeDefined();
  });

  it('AC6 — Outcome-Audit (failed:errorClass) nach fehlgeschlagener Validierung', async () => {
    await startTestApp(makeFakeCredStore(null));
    await put(port, '/api/settings/obsidian-vault-path', { path: '/etc/invalid' });
    const failed = auditStore.getAll().find((e) => e.command.includes('obsidian-vault-path:set:failed:outside-boundary'));
    expect(failed).toBeDefined();
  });
});

// ── Integration: DELETE /api/settings/obsidian-vault-path (AC1/AC6/AC7) ──────

describe('DELETE /api/settings/obsidian-vault-path (AC1/AC6/AC7)', () => {
  let server, port, auditStore;

  beforeEach(() => { process.env.DEV_NO_ACCESS = '1'; });
  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
  });

  it('AC1 — zurücksetzen → 200 { vaultPath: null, configured: false }', async () => {
    const credStore = makeFakeCredStore('/vault/configured');
    auditStore = new AuditStore();
    ({ server, port } = await startServer(makeApp(credStore, auditStore)));
    const res = await del(port, '/api/settings/obsidian-vault-path');
    expect(res.status).toBe(200);
    expect(res.body.vaultPath).toBeNull();
    expect(res.body.configured).toBe(false);
    expect(credStore._get()).toBeNull();
  });

  it('AC7 — DELETE ohne Berechtigung (CRED_ADMIN_EMAILS) → 403, keine Mutation', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    const credStore = makeFakeCredStore('/vault/keep');
    auditStore = new AuditStore();
    ({ server, port } = await startServer(makeApp(credStore, auditStore)));
    const res = await del(port, '/api/settings/obsidian-vault-path');
    expect(res.status).toBe(403);
    expect(credStore._get()).toBe('/vault/keep');
  });

  it('AC6 — DELETE Audit-First: Audit-Fehler blockiert Löschung', async () => {
    let deleteCalled = false;
    const credStore = {
      readObsidianVaultPath: async () => '/vault/x',
      writeObsidianVaultPath: async () => ({}),
      deleteObsidianVaultPath: async () => { deleteCalled = true; return {}; },
    };
    const brokenAudit = { record() { throw new Error('Audit down'); } };
    ({ server, port } = await startServer(makeApp(credStore, brokenAudit)));
    const res = await del(port, '/api/settings/obsidian-vault-path');
    expect(res.status).toBe(500);
    expect(deleteCalled).toBe(false);
  });

  it('AC6 — DELETE Outcome-Audit (success) nach erfolgreicher Löschung', async () => {
    const credStore = makeFakeCredStore('/vault/x');
    auditStore = new AuditStore();
    ({ server, port } = await startServer(makeApp(credStore, auditStore)));
    await del(port, '/api/settings/obsidian-vault-path');
    const outcome = auditStore.getAll().find((e) => e.command.includes('obsidian-vault-path:delete:success'));
    expect(outcome).toBeDefined();
  });
});

// ── End-to-End: echter CredentialStore + realer Symlink-Vault (AC2/AC3/AC4) ──

describe('E2E — echter CredentialStore + realer Vault (AC2/AC3/AC4)', () => {
  let server, port, storeDir, vaultDir, store;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    storeDir = join(tmpdir(), `obs-e2e-cred-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    vaultDir = join(tmpdir(), `obs-e2e-vault-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(vaultDir, PROJEKTE_SUBDIR), { recursive: true });
    store = new CredentialStore({ dir: storeDir, masterKey: null });
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
    delete process.env.OBSIDIAN_VAULT_DIR;
    await rm(storeDir, { recursive: true, force: true });
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('AC2/AC4 — PUT gültiger realer Vault → persistiert im meta-Block; GET liest ihn', async () => {
    // Kein OBSIDIAN_VAULT_DIR → kein Containment, nur lesbar+Projekte-Prüfung.
    ({ server, port } = await startServer(makeApp(store, new AuditStore())));
    const put1 = await put(port, '/api/settings/obsidian-vault-path', { path: vaultDir });
    expect(put1.status).toBe(200);
    expect(put1.body.configured).toBe(true);

    const getRes = await get(port, '/api/settings/obsidian-vault-path');
    expect(getRes.body.configured).toBe(true);
    // realpath-normalisiert (macOS /var→/private/var) → Endteil vergleichen
    expect(getRes.body.vaultPath.endsWith(vaultDir.split('/').pop())).toBe(true);

    // meta-Block, nicht entries
    const raw = await readFile(join(storeDir, 'secrets.enc.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.meta?.['settings/obsidian-vault-path']?.value).toBeTruthy();
  });

  it('AC2 — PUT auf realen Vault OHNE „Projekte" → 422 missing-projekte, kein Persist', async () => {
    const noProjekte = join(tmpdir(), `obs-noproj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(noProjekte, { recursive: true });
    try {
      ({ server, port } = await startServer(makeApp(store, new AuditStore())));
      const res = await put(port, '/api/settings/obsidian-vault-path', { path: noProjekte });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/Projekte/);
      expect(await store.readObsidianVaultPath()).toBeNull();
    } finally {
      await rm(noProjekte, { recursive: true, force: true });
    }
  });

  it('AC3 — Symlink-Flucht aus gesetzter Schranke → 422 outside-boundary, kein Persist', async () => {
    // OBSIDIAN_VAULT_DIR = vaultDir; ein Symlink INNERHALB, der nach außen (tmpdir) zeigt.
    process.env.OBSIDIAN_VAULT_DIR = vaultDir;
    const outsideTarget = join(tmpdir(), `obs-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(outsideTarget, PROJEKTE_SUBDIR), { recursive: true });
    const escapeLink = join(vaultDir, 'escape');
    await symlink(outsideTarget, escapeLink);
    try {
      ({ server, port } = await startServer(makeApp(store, new AuditStore())));
      const res = await put(port, '/api/settings/obsidian-vault-path', { path: escapeLink });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/außerhalb/);
      expect(await store.readObsidianVaultPath()).toBeNull();
    } finally {
      await rm(outsideTarget, { recursive: true, force: true });
    }
  });
});
