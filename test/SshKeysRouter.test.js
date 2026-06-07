/**
 * SshKeysRouter.test.js — Unit- und Integrations-Tests für SSH-Key-Verwaltung (settings-ssh-keys AC1–AC10).
 *
 * Covers (settings-ssh-keys Stufe A):
 *   AC1  — GET /api/settings/ssh-keys liefert Liste mit Public-Key (Klartext) + Private-Key-Status
 *   AC2  — PUT setzt Private-Key; Response enthält KEINEN Private-Key-Klartext (nur Status)
 *   AC3  — DELETE löscht Public- und/oder Private-Key; danach Status „unset"
 *   AC4  — Ungültiges Public-Key-Format → 422, bestehender Wert bleibt
 *   AC5  — Mutationen auditiert ohne Private-Key-Klartext
 *   AC6  — Endpunkte hinter AccessGuard (403 ohne Token); mutierende durch CRED_ADMIN_EMAILS geschützt
 *
 * Covers (settings-ssh-keys Stufe B):
 *   AC7  — POST /provision mit gemocktem VpsProvisioner → result:added
 *   AC8  — POST /provision idempotent → result:already-present
 *   AC9  — Provision auditiert ohne Geheim-Leak; Fehlerklassen (no-public-key, unreachable, auth-failed)
 *   AC10 — POST /provision hinter CRED_ADMIN_EMAILS (403 wenn nicht berechtigt)
 *
 * Strategie:
 *   - CredentialStore mit tmpdir + injiziertem masterKey
 *   - sshKeysRouter mit Express-Testserver + DEV_NO_ACCESS=1
 *   - VpsProvisioner für Stufe-B-Tests gemockt (kein echter SSH-Verkehr)
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { CredentialStore } from '../src/CredentialStore.js';
import { sshKeysRouter } from '../src/sshKeysRouter.js';
import { AuditStore } from '../src/AuditStore.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const TEST_MASTER_KEY = 'test-ssh-key-for-unit-tests-not-a-real-secret';

/** Gültiger OpenSSH-Public-Key (ed25519). */
const VALID_ED25519_PUBKEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyForTestingPurposesOnlyNotReal test@example.com';

/** Gültiger OpenSSH-Public-Key (rsa). */
const VALID_RSA_PUBKEY =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7N2FakeKeyForTestingPurposesNotReal== test@example.com';

/** Ungültiger Public-Key (kein OpenSSH-Präfix). */
const INVALID_PUBKEY = 'not-an-openssh-key';

/** Temporären Store anlegen. */
async function makeTmpStore(masterKey = TEST_MASTER_KEY) {
  const dir = await mkdtemp(join(tmpdir(), 'ssh-keys-test-'));
  const store = new CredentialStore({ dir, masterKey });
  return { store, dir };
}

/**
 * Erstellt einen Express-Testserver mit sshKeysRouter.
 * @param {object} store - CredentialStore
 * @param {object} [auditStoreOverride] - AuditStore (optional)
 * @param {object} [mockProvisioner] - VpsProvisioner-Mock (optional, für Stufe-B-Tests)
 */
async function makeTestServer(store, auditStoreOverride, mockProvisioner) {
  const app = express();
  app.use(express.json());

  const guard = createAccessGuard();
  app.use('/api', guard);

  const audit = auditStoreOverride ?? new AuditStore();
  app.use(sshKeysRouter(store, audit, mockProvisioner));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  function req(method, path, body = null) {
    return new Promise((resolve) => {
      const headers = { 'Content-Type': 'application/json' };
      const bodyStr = body ? JSON.stringify(body) : null;
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const options = { hostname: '127.0.0.1', port, path, method, headers };
      const r = httpRequest(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      r.on('error', () => resolve({ status: 0, body: '' }));
      if (bodyStr) r.write(bodyStr);
      r.end();
    });
  }

  async function close() {
    await new Promise((r) => server.close(r));
  }

  return { req, close, audit, server };
}

// ── AC1 — GET /api/settings/ssh-keys ──────────────────────────────────────────

describe('sshKeysRouter — AC1: GET /api/settings/ssh-keys', () => {
  let dir, store, testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
    testServer = await makeTestServer(store);
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('AC1 — GET 200 mit leerem Array wenn kein SSH-Key gesetzt', async () => {
    const res = await testServer.req('GET', '/api/settings/ssh-keys');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  it('AC1 — GET zeigt Public-Key im Klartext (AC1: nicht geheim)', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    const res = await testServer.req('GET', '/api/settings/ssh-keys');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    const rootEntry = data.find((e) => e.user === 'root');
    expect(rootEntry).toBeTruthy();
    expect(rootEntry.publicKey).toBe(VALID_ED25519_PUBKEY);
  });

  it('AC2 — GET enthält KEINEN Private-Key-Klartext', async () => {
    await store.set('ssh/root/private_key', 'SUPER_SECRET_PRIVATE_KEY');
    const res = await testServer.req('GET', '/api/settings/ssh-keys');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('SUPER_SECRET_PRIVATE_KEY');
    const data = JSON.parse(res.body);
    const rootEntry = data.find((e) => e.user === 'root');
    expect(rootEntry.privateKeyStatus).toBe('set');
    expect(rootEntry.privateKey).toBeUndefined();
  });

  it('AC1 — GET zeigt beide Benutzer wenn zwei vorhanden', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.setPublicKey('alex', VALID_RSA_PUBKEY);
    const res = await testServer.req('GET', '/api/settings/ssh-keys');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.some((e) => e.user === 'root')).toBe(true);
    expect(data.some((e) => e.user === 'alex')).toBe(true);
  });

  it('AC1 — GET zeigt privateKeyStatus:unset wenn kein Private-Key gesetzt', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    const res = await testServer.req('GET', '/api/settings/ssh-keys');
    const data = JSON.parse(res.body);
    const rootEntry = data.find((e) => e.user === 'root');
    expect(rootEntry.privateKeyStatus).toBe('unset');
  });
});

// ── AC1+AC2 — PUT /api/settings/ssh-keys/:user ────────────────────────────────

describe('sshKeysRouter — AC1+AC2: PUT /api/settings/ssh-keys/:user', () => {
  let dir, store, testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
    testServer = await makeTestServer(store);
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('AC1 — PUT Public-Key setzt ihn; Response enthält Public-Key im Klartext', async () => {
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/root', { publicKey: VALID_ED25519_PUBKEY });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.user).toBe('root');
    expect(data.publicKey).toBe(VALID_ED25519_PUBKEY);
  });

  it('AC2 — PUT Private-Key; Response enthält KEINEN Private-Key-Klartext', async () => {
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/root', {
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEKEY\n-----END OPENSSH PRIVATE KEY-----',
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.user).toBe('root');
    expect(data.privateKeyStatus).toBe('set');
    // Kein Klartext in Response
    expect(res.body).not.toContain('FAKEKEY');
    expect(data.privateKey).toBeUndefined();
  });

  it('AC1+AC2 — PUT beides gleichzeitig', async () => {
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/alex', {
      publicKey: VALID_RSA_PUBKEY,
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nALEXKEY\n-----END OPENSSH PRIVATE KEY-----',
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.user).toBe('alex');
    expect(data.publicKey).toBe(VALID_RSA_PUBKEY);
    expect(data.privateKeyStatus).toBe('set');
    expect(res.body).not.toContain('ALEXKEY');
  });

  it('AC4 — PUT ungültiges Public-Key-Format → 422, bestehender Wert bleibt', async () => {
    // Zuerst gültigen Key setzen
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);

    // Dann ungültigen versuchen
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/root', {
      publicKey: INVALID_PUBKEY,
    });
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/format|openssh/i);

    // Bestehender Key bleibt
    const still = await store.getPublicKey('root');
    expect(still).toBe(VALID_ED25519_PUBKEY);
  });

  it('AC4 — PUT mit nur Leerzeichen als Public-Key → 422', async () => {
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/root', { publicKey: '   ' });
    expect(res.status).toBe(422);
  });

  it('AC4 — PUT ohne publicKey und ohne privateKey → 400', async () => {
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/root', {});
    expect(res.status).toBe(400);
  });

  it('PUT mit ungültigem Benutzer-Label (Leerzeichen) → 400', async () => {
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/invalid%20user', {
      publicKey: VALID_ED25519_PUBKEY,
    });
    expect(res.status).toBe(400);
  });

  it('I1 — PUT mit Newline im Public-Key → 422 (authorized_keys-Injection-Vorsorge)', async () => {
    const keyWithNewline = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey test@example.com\nmalicious-option command="evil"';
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/root', { publicKey: keyWithNewline });
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/keine.*Zeilen|Zeilenumbr/);
  });

  it('I1 — PUT mit CR+LF im Public-Key → 422', async () => {
    const keyWithCRLF = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey test@example.com\r\nmalicious';
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/root', { publicKey: keyWithCRLF });
    expect(res.status).toBe(422);
  });
});

// ── AC3 — DELETE /api/settings/ssh-keys/:user ─────────────────────────────────

describe('sshKeysRouter — AC3: DELETE /api/settings/ssh-keys/:user', () => {
  let dir, store, testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
    testServer = await makeTestServer(store);
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('AC3 — DELETE both löscht Public- und Private-Key', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', 'secret-private');

    const res = await testServer.req('DELETE', '/api/settings/ssh-keys/root?target=both');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.privateKeyStatus).toBe('unset');
    expect(data.publicKey).toBeUndefined();

    const pub = await store.getPublicKey('root');
    expect(pub).toBeNull();
    const priv = await store.getPlaintext('ssh/root/private_key');
    expect(priv).toBeNull();
  });

  it('AC3 — DELETE ?target=public löscht nur Public-Key, Private bleibt', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', 'secret-priv-intact');

    const res = await testServer.req('DELETE', '/api/settings/ssh-keys/root?target=public');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.privateKeyStatus).toBe('set');
    expect(data.publicKey).toBeUndefined();

    const priv = await store.getPlaintext('ssh/root/private_key');
    expect(priv).toBe('secret-priv-intact');
  });

  it('AC3 — DELETE ?target=private löscht nur Private-Key, Public bleibt', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', 'gone-priv-key');

    const res = await testServer.req('DELETE', '/api/settings/ssh-keys/root?target=private');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.privateKeyStatus).toBe('unset');
    expect(data.publicKey).toBe(VALID_ED25519_PUBKEY);
  });

  it('AC3 — DELETE ist idempotent (kein Fehler wenn nicht gesetzt)', async () => {
    const res = await testServer.req('DELETE', '/api/settings/ssh-keys/nonexistent?target=both');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.privateKeyStatus).toBe('unset');
  });

  it('AC3 — DELETE ohne target-Param → löscht beides (Default)', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    const res = await testServer.req('DELETE', '/api/settings/ssh-keys/root');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.privateKeyStatus).toBe('unset');
  });

  it('AC3 — DELETE ungültiger target → 400', async () => {
    const res = await testServer.req('DELETE', '/api/settings/ssh-keys/root?target=invalid');
    expect(res.status).toBe(400);
  });
});

// ── AC5 — Audit-Einträge ───────────────────────────────────────────────────────

describe('sshKeysRouter — AC5: Audit-Einträge', () => {
  let dir, store, testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
    testServer = await makeTestServer(store);
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('AC5 — PUT schreibt Audit-Eintrag ohne Private-Key-Klartext', async () => {
    const secretPrivKey = 'SUPER_SECRET_PRIVATE_KEY_VALUE';
    await testServer.req('PUT', '/api/settings/ssh-keys/root', {
      privateKey: secretPrivKey,
    });
    const entries = testServer.audit.getAll();
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[entries.length - 1];
    expect(entry.command).toMatch(/ssh-key:set:root/);
    // Private-Key-Klartext DARF NICHT im Audit-Eintrag stehen
    expect(entry.command).not.toContain(secretPrivKey);
    expect(JSON.stringify(entry)).not.toContain(secretPrivKey);
  });

  it('AC5 — DELETE schreibt Audit-Eintrag ohne Klartext', async () => {
    await store.set('ssh/root/private_key', 'deleted-secret-key');
    await testServer.req('DELETE', '/api/settings/ssh-keys/root');
    const entries = testServer.audit.getAll();
    const entry = entries[entries.length - 1];
    expect(entry.command).toMatch(/ssh-key:delete:root/);
    expect(JSON.stringify(entry)).not.toContain('deleted-secret-key');
  });

  it('AC5 — Audit-Eintrag enthält Benutzer-Label und Aktion', async () => {
    await testServer.req('PUT', '/api/settings/ssh-keys/alex', {
      publicKey: VALID_RSA_PUBKEY,
    });
    const entries = testServer.audit.getAll();
    const entry = entries[entries.length - 1];
    expect(entry.command).toContain('alex');
    expect(entry.command).toContain('public_key');
  });

  it('AC5 — Audit-Eintrag enthält Identität (dev@local im Test)', async () => {
    await testServer.req('PUT', '/api/settings/ssh-keys/root', {
      publicKey: VALID_ED25519_PUBKEY,
    });
    const entries = testServer.audit.getAll();
    const entry = entries[entries.length - 1];
    expect(entry.identity).toBe('dev@local');
  });
});

// ── AC6 — AccessGuard + CRED_ADMIN_EMAILS ────────────────────────────────────

describe('sshKeysRouter — AC6: AccessGuard (403 ohne Token)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
    delete process.env.DEV_NO_ACCESS;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC6 — GET ohne Token (kein DEV_NO_ACCESS) → 403', async () => {
    const app = express();
    app.use(express.json());
    const guard = createAccessGuard({ aud: 'test-aud', keySet: () => { throw new Error('no keyset'); } });
    app.use('/api', guard);
    const audit = new AuditStore();
    app.use(sshKeysRouter(store, audit));
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await new Promise((resolve) => {
      const r = httpRequest(
        { hostname: '127.0.0.1', port, path: '/api/settings/ssh-keys', method: 'GET' },
        (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); },
      );
      r.on('error', () => resolve({ status: 0, body: '' }));
      r.end();
    });
    expect(res.status).toBe(403);

    await new Promise((r) => server.close(r));
  });
});

describe('sshKeysRouter — AC6: CRED_ADMIN_EMAILS Mutations-Autorisierung', () => {
  let dir, store, testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
    testServer = await makeTestServer(store);
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
    await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('AC6 — ohne CRED_ADMIN_EMAILS: dev@local darf mutieren (PUT)', async () => {
    delete process.env.CRED_ADMIN_EMAILS;
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/root', { publicKey: VALID_ED25519_PUBKEY });
    expect(res.status).toBe(200);
  });

  it('AC6 — CRED_ADMIN_EMAILS gesetzt, Identität nicht in Liste → 403 (PUT)', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com,other@example.com';
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/root', { publicKey: VALID_ED25519_PUBKEY });
    expect(res.status).toBe(403);
  });

  it('AC6 — CRED_ADMIN_EMAILS gesetzt, Identität in Liste → 200 (PUT)', async () => {
    process.env.CRED_ADMIN_EMAILS = 'dev@local,other@example.com';
    const res = await testServer.req('PUT', '/api/settings/ssh-keys/root', { publicKey: VALID_ED25519_PUBKEY });
    expect(res.status).toBe(200);
  });

  it('AC6 — DELETE ebenfalls durch CRED_ADMIN_EMAILS geschützt', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    const res = await testServer.req('DELETE', '/api/settings/ssh-keys/root');
    expect(res.status).toBe(403);
  });

  it('AC6 — GET ist NICHT durch CRED_ADMIN_EMAILS geschützt (lese-only)', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    const res = await testServer.req('GET', '/api/settings/ssh-keys');
    expect(res.status).toBe(200);
  });
});

// ── AC7 — POST /provision: added ──────────────────────────────────────────────

describe('sshKeysRouter — AC7: POST /provision → result:added', () => {
  let dir, store, testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (testServer) await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('AC7 — POST /provision mit result:added → 200 { result:"added" }', async () => {
    const mockProv = {
      provision: async () => ({ result: 'added' }),
    };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('added');
  });

  it('AC7 — Validierung: fehlendes host-Feld → 400', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      targetUser: 'root',
    });
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/host/i);
  });

  it('AC7 — Validierung: fehlendes targetUser-Feld → 400', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
    });
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/targetUser/i);
  });

  it('AC7 — Validierung: ungültiger Port (0) → 400', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      port: 0,
      targetUser: 'root',
    });
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/port/i);
  });

  it('AC7 — Validierung: Port 65535 ist erlaubt', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      port: 65535,
      targetUser: 'root',
    });
    expect(res.status).toBe(200);
  });

  it('AC7 — Validierung: ungültiger Benutzer-Label im URL → 400', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/invalid%20user/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });
    expect(res.status).toBe(400);
  });
});

// ── AC8 — POST /provision: already-present (Idempotenz) ───────────────────────

describe('sshKeysRouter — AC8: POST /provision → result:already-present', () => {
  let dir, store, testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (testServer) await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('AC8 — POST /provision mit result:already-present → 200 { result:"already-present" }', async () => {
    const mockProv = {
      provision: async () => ({ result: 'already-present' }),
    };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('already-present');
  });
});

// ── AC9 — POST /provision: Audit + Fehlerklassen ──────────────────────────────

describe('sshKeysRouter — AC9: Audit + Fehlerklassen', () => {
  let dir, store, testServer, auditStore;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
    auditStore = new AuditStore();
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (testServer) await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('AC9 — POST /provision schreibt Audit-Eintrag (Audit-First)', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, auditStore, mockProv);

    await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });

    const entries = auditStore.getAll();
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1];
    expect(last.command).toMatch(/ssh-key:provision:root/);
  });

  it('AC9 — Audit-Eintrag enthält kein Private-Key-Klartext', async () => {
    const secretKey = 'ULTRA_SECRET_PRIVATE_KEY_PROVISION';
    await store.set('ssh/root/private_key', secretKey);
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, auditStore, mockProv);

    await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });

    const entries = auditStore.getAll();
    const allEntriesStr = JSON.stringify(entries);
    expect(allEntriesStr).not.toContain(secretKey);
  });

  it('AC9 — errorClass:no-public-key → 422', async () => {
    const mockProv = {
      provision: async () => ({ result: 'error', errorClass: 'no-public-key', reason: 'Kein Public-Key' }),
    };
    testServer = await makeTestServer(store, auditStore, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('error');
  });

  it('AC9 — errorClass:no-private-key → 422', async () => {
    const mockProv = {
      provision: async () => ({ result: 'error', errorClass: 'no-private-key', reason: 'Kein Private-Key' }),
    };
    testServer = await makeTestServer(store, auditStore, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });
    expect(res.status).toBe(422);
  });

  it('AC9 — errorClass:unreachable → 502', async () => {
    const mockProv = {
      provision: async () => ({ result: 'error', errorClass: 'unreachable', reason: 'Nicht erreichbar' }),
    };
    testServer = await makeTestServer(store, auditStore, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });
    expect(res.status).toBe(502);
    const data = JSON.parse(res.body);
    expect(data.result).toBe('error');
    // Kein Geheim-Leak in Response
    expect(res.body).not.toContain('FAKEPRIVATE');
    expect(res.body).not.toContain('ULTRA_SECRET');
  });

  it('AC9 — errorClass:auth-failed → 502', async () => {
    const mockProv = {
      provision: async () => ({ result: 'error', errorClass: 'auth-failed', reason: 'Auth fehlgeschlagen' }),
    };
    testServer = await makeTestServer(store, auditStore, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });
    expect(res.status).toBe(502);
  });

  it('AC9 — Response enthält keinen Private-Key-Klartext (kein Geheim-Leak)', async () => {
    const secretKey = 'MY_SECRET_PROVISION_PRIVATE_KEY';
    await store.set('ssh/root/private_key', secretKey);
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, auditStore, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });

    expect(res.status).toBe(200);
    expect(res.body).not.toContain(secretKey);
    expect(res.body).not.toContain('MY_SECRET_PROVISION');
  });
});

// ── I1 — TOFU-Hash im zweiten Audit-Eintrag ───────────────────────────────────

describe('sshKeysRouter — I1: TOFU-Hash-Audit-Eintrag', () => {
  let dir, store, testServer, auditStore;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
    auditStore = new AuditStore();
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (testServer) await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('I1 — provision() mit hostKeyHash → zweiter Audit-Eintrag mit Hash (tofu-accepted)', async () => {
    const fakeHash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const mockProv = {
      provision: async () => ({ result: 'added', hostKeyHash: fakeHash }),
    };
    testServer = await makeTestServer(store, auditStore, mockProv);

    await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });

    const entries = auditStore.getAll();
    // Zwei Einträge: Audit-First (provision) + TOFU-Hash-Eintrag
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const tofuEntry = entries.find((e) => e.command.includes('tofu-accepted'));
    expect(tofuEntry).toBeTruthy();
    expect(tofuEntry.command).toContain(fakeHash);
    // Kein Klartext-Private-Key im TOFU-Eintrag
    expect(tofuEntry.command).not.toContain('SECRET');
    expect(tofuEntry.command).not.toContain('PRIVATE');
  });

  it('I1 — provision() ohne hostKeyHash → kein zweiter tofu-accepted-Eintrag', async () => {
    const mockProv = {
      provision: async () => ({ result: 'added' }), // kein hostKeyHash
    };
    testServer = await makeTestServer(store, auditStore, mockProv);

    await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });

    const entries = auditStore.getAll();
    const tofuEntry = entries.find((e) => e.command.includes('tofu-accepted'));
    expect(tofuEntry).toBeUndefined();
  });

  it('I1 — TOFU-Audit-Eintrag enthält keinen Private-Key-Klartext', async () => {
    const secretKey = 'ULTRA_SECRET_TOFU_PRIVATE_KEY';
    await store.set('ssh/root/private_key', secretKey);
    const fakeHash = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ=';
    const mockProv = {
      provision: async () => ({ result: 'already-present', hostKeyHash: fakeHash }),
    };
    testServer = await makeTestServer(store, auditStore, mockProv);

    await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });

    const entries = auditStore.getAll();
    const allStr = JSON.stringify(entries);
    expect(allStr).not.toContain(secretKey);
    expect(allStr).not.toContain('ULTRA_SECRET');
  });
});

// ── S2 — hostFingerprint-Format-Validierung ───────────────────────────────────

describe('sshKeysRouter — S2: hostFingerprint-Format-Validierung', () => {
  let dir, store, testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (testServer) await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('S2 — gültiger SHA256-Base64-Fingerprint (44 Zeichen) → 200', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    // SHA256 → 32 Bytes → Base64 → 44 Zeichen (mit '='-Padding)
    const validFp = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
      hostFingerprint: validFp,
    });
    expect(res.status).toBe(200);
  });

  it('S2 — gültiger SHA256-Base64-Fingerprint (43 Zeichen, ohne Padding) → 200', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    // 43 Zeichen ohne '='-Padding (ebenfalls gültig)
    const validFp43 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.slice(0, 43);
    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
      hostFingerprint: validFp43,
    });
    expect(res.status).toBe(200);
  });

  it('S2 — zu kurzer Fingerprint → 422 mit klarer Meldung', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
      hostFingerprint: 'tooshort',
    });
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/länge|length/i);
  });

  it('S2 — zu langer Fingerprint (45+ Zeichen) → 422', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
      hostFingerprint: 'A'.repeat(45),
    });
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/länge|length/i);
  });

  it('S2 — Fingerprint mit ungültigem Zeichen (!) → 422', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    // 43 Zeichen lang, aber enthält '!' statt Base64-Zeichen
    const invalidFp = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!';
    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
      hostFingerprint: invalidFp,
    });
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/zeichen|character/i);
  });

  it('S2 — hostFingerprint weggelassen → kein Fehler (optional)', async () => {
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
      // kein hostFingerprint
    });
    expect(res.status).toBe(200);
  });
});

// ── AC10 — POST /provision: Identitäts-/Rollenschutz ─────────────────────────

describe('sshKeysRouter — AC10: Provision-AuthZ (CRED_ADMIN_EMAILS)', () => {
  let dir, store, testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
    if (testServer) await testServer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('AC10 — ohne CRED_ADMIN_EMAILS: dev@local darf provisionieren', async () => {
    delete process.env.CRED_ADMIN_EMAILS;
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });
    expect(res.status).toBe(200);
  });

  it('AC10 — CRED_ADMIN_EMAILS gesetzt, Identität nicht in Liste → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com,other@example.com';
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });
    expect(res.status).toBe(403);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/berechtigung/i);
  });

  it('AC10 — CRED_ADMIN_EMAILS gesetzt, Identität in Liste → 200', async () => {
    process.env.CRED_ADMIN_EMAILS = 'dev@local,other@example.com';
    const mockProv = { provision: async () => ({ result: 'added' }) };
    testServer = await makeTestServer(store, undefined, mockProv);

    const res = await testServer.req('POST', '/api/settings/ssh-keys/root/provision', {
      host: '1.2.3.4',
      targetUser: 'root',
    });
    expect(res.status).toBe(200);
  });
});

// ── CredentialStore — SSH-Key-Methoden direkt ─────────────────────────────────

describe('CredentialStore — SSH-Key-API (getPublicKey / setPublicKey / deletePublicKey / listSshKeys)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await rm(dir, { recursive: true, force: true });
  });

  it('AC1 — setPublicKey / getPublicKey gibt Klartext zurück', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    const pub = await store.getPublicKey('root');
    expect(pub).toBe(VALID_ED25519_PUBKEY);
  });

  it('AC1 — getPublicKey gibt null wenn nicht gesetzt', async () => {
    const pub = await store.getPublicKey('nonexistent');
    expect(pub).toBeNull();
  });

  it('AC3 — deletePublicKey entfernt den Key; danach null', async () => {
    await store.setPublicKey('alex', VALID_RSA_PUBKEY);
    await store.deletePublicKey('alex');
    const pub = await store.getPublicKey('alex');
    expect(pub).toBeNull();
  });

  it('AC3 — deletePublicKey ist idempotent', async () => {
    await expect(store.deletePublicKey('doesnotexist')).resolves.toBeUndefined();
  });

  it('AC1 — listSshKeys zeigt Benutzer mit Public-Key', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    const list = await store.listSshKeys();
    const rootEntry = list.find((e) => e.user === 'root');
    expect(rootEntry).toBeTruthy();
    expect(rootEntry.publicKey).toBe(VALID_ED25519_PUBKEY);
    expect(rootEntry.privateKeyStatus).toBe('unset');
  });

  it('AC2 — listSshKeys zeigt privateKeyStatus:set aber KEINEN Klartext', async () => {
    await store.set('ssh/root/private_key', 'top-secret-private');
    const list = await store.listSshKeys();
    const rootEntry = list.find((e) => e.user === 'root');
    expect(rootEntry.privateKeyStatus).toBe('set');
    expect(JSON.stringify(list)).not.toContain('top-secret-private');
    expect(rootEntry.privateKey).toBeUndefined();
  });

  it('AC1+AC2 — listSshKeys zeigt Benutzer mit beiden Keys', async () => {
    await store.setPublicKey('alex', VALID_RSA_PUBKEY);
    await store.set('ssh/alex/private_key', 'alex-secret');
    const list = await store.listSshKeys();
    const alexEntry = list.find((e) => e.user === 'alex');
    expect(alexEntry.publicKey).toBe(VALID_RSA_PUBKEY);
    expect(alexEntry.privateKeyStatus).toBe('set');
  });

  it('Public-Key wird NICHT verschlüsselt in entries gespeichert (im meta-Block)', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    // Public-Key muss im Klartext in der Datei stehen (meta-Block)
    const { readFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');
    const raw = await readFile(pjoin(dir, 'secrets.enc.json'), 'utf8');
    // Public-Key darf in der Datei im Klartext stehen (nicht geheim)
    expect(raw).toContain('ssh-ed25519');
  });

  it('Private-Key wird verschlüsselt gespeichert — Klartext NICHT in Store-Datei', async () => {
    await store.set('ssh/root/private_key', 'ultra-secret-private-key-data');
    const { readFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');
    const raw = await readFile(pjoin(dir, 'secrets.enc.json'), 'utf8');
    expect(raw).not.toContain('ultra-secret-private-key-data');
  });
});

// ── I2 — CredentialStore: User-Label-Validierung in setPublicKey/deletePublicKey ─

describe('CredentialStore — I2: Benutzer-Label-Validierung (Defense-in-Depth)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await rm(dir, { recursive: true, force: true });
  });

  it('I2 — setPublicKey mit leerem Label → wirft Fehler', async () => {
    await expect(store.setPublicKey('', VALID_ED25519_PUBKEY)).rejects.toThrow(/Benutzer-Label/i);
  });

  it('I2 — setPublicKey mit zu langem Label (>64) → wirft Fehler', async () => {
    const longLabel = 'a'.repeat(65);
    await expect(store.setPublicKey(longLabel, VALID_ED25519_PUBKEY)).rejects.toThrow(/Benutzer-Label/i);
  });

  it('I2 — setPublicKey mit unerlaubten Zeichen → wirft Fehler', async () => {
    await expect(store.setPublicKey('user name!', VALID_ED25519_PUBKEY)).rejects.toThrow(/unerlaubte Zeichen/i);
  });

  it('I2 — setPublicKey mit gültigem Label → kein Fehler', async () => {
    await expect(store.setPublicKey('root', VALID_ED25519_PUBKEY)).resolves.toBeDefined();
  });

  it('I2 — deletePublicKey mit leerem Label → wirft Fehler', async () => {
    await expect(store.deletePublicKey('')).rejects.toThrow(/Benutzer-Label/i);
  });

  it('I2 — deletePublicKey mit unerlaubten Zeichen → wirft Fehler', async () => {
    await expect(store.deletePublicKey('bad user!')).rejects.toThrow(/unerlaubte Zeichen/i);
  });

  it('I2 — deletePublicKey mit gültigem Label (nicht vorhanden) → idempotent, kein Fehler', async () => {
    await expect(store.deletePublicKey('root')).resolves.toBeUndefined();
  });
});
