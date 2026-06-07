/**
 * CredentialStore.test.js — Unit-Tests für CredentialStore + credentialsRouter.
 *
 * Covers (settings-credentials):
 *   AC1  — list() liefert Metadaten (status, masked, updatedAt), niemals Klartext
 *   AC2  — set() speichert verschlüsselt; nachfolgendes getMeta() → status 'set', kein Klartext
 *   AC3  — delete() → status 'unset'; Klartext nicht mehr abrufbar
 *   AC4  — Kein API-Endpunkt gibt Klartext zurück (Response-Body enthält gesetzten Wert nicht)
 *   AC5  — misc-Integration: set/delete/list mit frei wählbarem Namen
 *   AC6  — Audit-Einträge enthalten keinen Klartext-Wert
 *   AC7  — Mutierende Endpunkte prüfen CRED_ADMIN_EMAILS (403 wenn nicht berechtigt)
 *   AC8  — Leere/ungültige Eingaben → 4xx, bestehender Wert bleibt erhalten
 *
 * Strategie:
 *   - CredentialStore mit tmpdir + injiziertem masterKey (kein Env nötig)
 *   - credentialsRouter mit Express-Testserver + DEV_NO_ACCESS=1
 *   - Server wird einmal pro Describe-Block gestartet (beforeEach), danach closeServer
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { CredentialStore, resolveKey, CREDENTIAL_CATALOG } from '../src/CredentialStore.js';
import { credentialsRouter } from '../src/credentialsRouter.js';
import { AuditStore } from '../src/AuditStore.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const TEST_MASTER_KEY = 'test-master-key-for-unit-tests-not-a-real-secret';

/** Erstellt einen temporären Store in einem tmpdir. */
async function makeTmpStore(masterKey = TEST_MASTER_KEY) {
  const dir = await mkdtemp(join(tmpdir(), 'credstore-test-'));
  const store = new CredentialStore({ dir, masterKey });
  return { store, dir };
}

/**
 * Erstellt einen Express-Testserver, startet ihn einmalig auf Port 0 und
 * gibt eine Anfrage-Funktion zurück.
 *
 * Rückgabe: { req(method, path, body?) → Promise<{status, body}>, close(), audit, server }
 */
async function makeTestServer(store, auditStoreOverride) {
  const app = express();
  app.use(express.json());

  const guard = createAccessGuard();
  app.use('/api', guard);

  const audit = auditStoreOverride ?? new AuditStore();
  app.use(credentialsRouter(store, audit));

  const server = createServer(app);

  // Einmalig starten
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

// ── Unit-Tests: CredentialStore direkt ────────────────────────────────────────

describe('CredentialStore — resolveKey()', () => {
  it('akzeptiert bekannte Katalog-Felder', () => {
    const r = resolveKey('github', 'app_id');
    expect(r.ok).toBe(true);
    expect(r.storeKey).toBe('credentials/github/app_id');
  });

  it('lehnt unbekannte Integration ab', () => {
    const r = resolveKey('unknown_integration', 'foo');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unbekannte Integration/);
  });

  it('lehnt unbekanntes Feld in bekannter Integration ab', () => {
    const r = resolveKey('github', 'nonexistent_field');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unbekanntes Feld/);
  });

  it('akzeptiert misc mit gültigem Namen', () => {
    const r = resolveKey('misc', 'my-secret-key');
    expect(r.ok).toBe(true);
    expect(r.storeKey).toBe('credentials/misc/my-secret-key');
  });

  it('lehnt misc mit leerem Namen ab', () => {
    const r = resolveKey('misc', '');
    expect(r.ok).toBe(false);
  });

  it('lehnt misc mit zu langem Namen ab', () => {
    const r = resolveKey('misc', 'x'.repeat(129));
    expect(r.ok).toBe(false);
  });

  it('lehnt misc mit unerlaubten Zeichen ab', () => {
    const r = resolveKey('misc', 'invalid name!');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unerlaubte Zeichen/);
  });
});

// maskValue() ist nicht mehr exportiert (S1: konservative Maskierung — kein Decrypt pro list()).
// Das Masken-Verhalten wird über die öffentliche API (list() / getMeta()) getestet.
describe('CredentialStore — Maskierung via list() / getMeta()', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    const { rm: rmDir } = await import('node:fs/promises');
    await rmDir(dir, { recursive: true, force: true });
  });

  it('list() nach set() liefert masked "•••• gesetzt" (konservativ, kein Decrypt)', async () => {
    await store.set('credentials/github/app_id', 'some-secret-value');
    const items = await store.list();
    const gh = items.find((i) => i.integration === 'github' && i.name === 'app_id');
    expect(gh).toBeTruthy();
    expect(gh.masked).toBe('•••• gesetzt');
    expect(JSON.stringify(items)).not.toContain('some-secret-value');
  });

  it('getMeta() nach set() liefert masked "•••• gesetzt"', async () => {
    await store.set('credentials/github/app_id', 'another-secret');
    const meta = await store.getMeta('credentials/github/app_id');
    expect(meta.masked).toBe('•••• gesetzt');
    expect(JSON.stringify(meta)).not.toContain('another-secret');
  });
});

describe('CredentialStore — set / getMeta / list', () => {
  let dir;
  let store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await rm(dir, { recursive: true, force: true });
  });

  it('AC2 — set() gibt status:set und updatedAt zurück (kein Klartext)', async () => {
    const meta = await store.set('credentials/github/app_id', 'my-secret-value');
    expect(meta.status).toBe('set');
    expect(meta.updatedAt).toBeTruthy();
    // Klartext nicht in meta
    expect(JSON.stringify(meta)).not.toContain('my-secret-value');
  });

  it('AC2 — getMeta() nach set() → status:set, kein Klartext', async () => {
    await store.set('credentials/github/app_id', 'super-secret');
    const meta = await store.getMeta('credentials/github/app_id');
    expect(meta.status).toBe('set');
    expect(meta.masked).toBeTruthy();
    expect(JSON.stringify(meta)).not.toContain('super-secret');
  });

  it('AC2 — set() überschreibt bestehenden Wert', async () => {
    await store.set('credentials/github/app_id', 'first-value');
    await store.set('credentials/github/app_id', 'second-value');
    const pt = await store.getPlaintext('credentials/github/app_id');
    expect(pt).toBe('second-value');
  });

  it('AC1 — list() enthält alle Katalog-Felder mit status unset wenn leer', async () => {
    const items = await store.list();
    const allFields = Object.values(CREDENTIAL_CATALOG).flat();
    for (const item of items) {
      expect(item.status).toBe('unset');
    }
    expect(items.length).toBeGreaterThanOrEqual(allFields.length);
  });

  it('AC1 — list() nach set() zeigt status:set, kein Klartext', async () => {
    await store.set('credentials/github/app_id', 'gh_secretvalue');
    const items = await store.list();
    const gh = items.find((i) => i.integration === 'github' && i.name === 'app_id');
    expect(gh).toBeTruthy();
    expect(gh.status).toBe('set');
    expect(gh.masked).toBeTruthy();
    // Klartext darf NICHT im list()-Ergebnis stehen
    expect(JSON.stringify(items)).not.toContain('gh_secretvalue');
  });

  it('AC4 — getPlaintext() gibt Klartext zurück (interner Konsument)', async () => {
    await store.set('credentials/github/app_id', 'plaintext-value');
    const pt = await store.getPlaintext('credentials/github/app_id');
    expect(pt).toBe('plaintext-value');
  });

  it('AC3 — delete() → status:unset; getPlaintext() → null', async () => {
    await store.set('credentials/github/app_id', 'to-be-deleted');
    await store.delete('credentials/github/app_id');
    const meta = await store.getMeta('credentials/github/app_id');
    expect(meta.status).toBe('unset');
    const pt = await store.getPlaintext('credentials/github/app_id');
    expect(pt).toBeNull();
  });

  it('AC3 — delete() ist idempotent (kein Fehler wenn nicht vorhanden)', async () => {
    const result = await store.delete('credentials/github/app_id');
    expect(result.status).toBe('unset');
  });

  it('AC5 — misc-Eintrag anlegen + abrufen + löschen', async () => {
    await store.set('credentials/misc/my-custom-key', 'custom-value');
    const pt = await store.getPlaintext('credentials/misc/my-custom-key');
    expect(pt).toBe('custom-value');

    const items = await store.list();
    const misc = items.find((i) => i.integration === 'misc' && i.name === 'my-custom-key');
    expect(misc).toBeTruthy();
    expect(misc.status).toBe('set');
    expect(JSON.stringify(items)).not.toContain('custom-value');

    await store.delete('credentials/misc/my-custom-key');
    const pt2 = await store.getPlaintext('credentials/misc/my-custom-key');
    expect(pt2).toBeNull();
  });

  it('AC8 — set() mit leerem Wert → wirft Fehler, bestehender Wert bleibt', async () => {
    await store.set('credentials/github/app_id', 'original');
    await expect(store.set('credentials/github/app_id', '')).rejects.toThrow(/leer/);
    const pt = await store.getPlaintext('credentials/github/app_id');
    expect(pt).toBe('original');
  });

  it('Datei wird at-rest verschlüsselt — Klartext nicht im Store-File', async () => {
    await store.set('credentials/github/private_key', 'ultra-secret-key');
    const { readFile: rf } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');
    const raw = await rf(pjoin(dir, 'secrets.enc.json'), 'utf8');
    expect(raw).not.toContain('ultra-secret-key');
  });

  it('GCM-Tag-Verifikation: manipulierte Datei → harter Fehler', async () => {
    await store.set('credentials/github/app_id', 'sensitive');
    // Store-Datei lesen und ct manipulieren
    const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');
    const filePath = pjoin(dir, 'secrets.enc.json');
    const raw = JSON.parse(await rf(filePath, 'utf8'));
    // ct Base64 leicht ändern (ungültige Bytes)
    raw.entries['credentials/github/app_id'].ct = Buffer.from('corrupt-data').toString('base64');
    await wf(filePath, JSON.stringify(raw));

    await expect(store.getPlaintext('credentials/github/app_id')).rejects.toThrow(/GCM|manipuliert/);
  });
});

// ── Integrations-Tests: credentialsRouter über HTTP ───────────────────────────

describe('credentialsRouter — GET /api/settings/credentials', () => {
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

  it('AC1 — GET 200 mit Array (leerer Store)', async () => {
    const res = await testServer.req('GET', '/api/settings/credentials');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
  });

  it('AC4 — GET-Response enthält keinen gesetzten Klartext-Wert', async () => {
    await store.set('credentials/github/app_id', 'should-not-appear-in-response');
    const res = await testServer.req('GET', '/api/settings/credentials');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('should-not-appear-in-response');
  });

  it('AC1 — GET zeigt status:set für gesetztes Feld, status:unset für andere', async () => {
    await store.set('credentials/cloudflare/api_token', 'cf-token-secret');
    const res = await testServer.req('GET', '/api/settings/credentials');
    const data = JSON.parse(res.body);
    const cf = data.find((i) => i.integration === 'cloudflare' && i.name === 'api_token');
    expect(cf.status).toBe('set');
    const gh = data.find((i) => i.integration === 'github' && i.name === 'app_id');
    expect(gh.status).toBe('unset');
  });
});

describe('credentialsRouter — PUT /api/settings/credentials/:integration/:name', () => {
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

  it('AC2 — PUT setzt Credential; Response enthält kein Klartext-Wert', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/github/app_id', { value: 'my-app-id-12345' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('set');
    expect(data.updatedAt).toBeTruthy();
    expect(res.body).not.toContain('my-app-id-12345');
  });

  it('AC2 — nach PUT: GET zeigt status:set, kein Klartext', async () => {
    await testServer.req('PUT', '/api/settings/credentials/github/installation_id', { value: 'install-secret' });
    const res = await testServer.req('GET', '/api/settings/credentials');
    expect(res.body).not.toContain('install-secret');
    const data = JSON.parse(res.body);
    const item = data.find((i) => i.name === 'installation_id');
    expect(item.status).toBe('set');
  });

  it('AC6 — PUT schreibt Audit-Eintrag ohne Klartext', async () => {
    await testServer.req('PUT', '/api/settings/credentials/cloudflare/api_token', { value: 'cf-secret-token' });
    const entries = testServer.audit.getAll();
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[entries.length - 1];
    expect(entry.command).toMatch(/credential:set/);
    expect(entry.command).not.toContain('cf-secret-token');
    expect(JSON.stringify(entry)).not.toContain('cf-secret-token');
  });

  it('AC8 — PUT mit leerem Wert → 400, bestehender Wert bleibt', async () => {
    await store.set('credentials/github/app_id', 'original-value');
    const res = await testServer.req('PUT', '/api/settings/credentials/github/app_id', { value: '' });
    expect(res.status).toBe(400);
    const pt = await store.getPlaintext('credentials/github/app_id');
    expect(pt).toBe('original-value');
  });

  it('AC8 — PUT mit fehlendem value-Feld → 400', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/github/app_id', {});
    expect(res.status).toBe(400);
  });

  it('AC8 — PUT unbekannte Integration → 404', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/unknown_int/some_field', { value: 'x' });
    expect(res.status).toBe(404);
  });

  it('AC8 — PUT unbekanntes Feld → 404', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/github/nonexistent', { value: 'x' });
    expect(res.status).toBe(404);
  });

  it('AC5 — PUT misc mit gültigem Namen → 200', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/misc/my-custom-cred', { value: 'misc-value' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('set');
    expect(res.body).not.toContain('misc-value');
  });

  it('AC5 — PUT misc mit ungültigem Namen (Sonderzeichen) → 422', async () => {
    // Sonderzeichen-Namen werden durch Express URL-Parameter als gültig weitergegeben,
    // aber resolveKey soll sie ablehnen; URL-kodierter Name mit Leerzeichen
    const res = await testServer.req('PUT', '/api/settings/credentials/misc/invalid%20name%21', { value: 'x' });
    // "invalid name!" nach URL-Dekodierung → resolveKey lehnt ab wegen Leerzeichen
    expect(res.status).toBe(422);
  });
});

describe('credentialsRouter — DELETE /api/settings/credentials/:integration/:name', () => {
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

  it('AC3 — DELETE gesetztes Credential → 200, status:unset', async () => {
    await store.set('credentials/vps/hetzner_api_token', 'hetzner-secret');
    const res = await testServer.req('DELETE', '/api/settings/credentials/vps/hetzner_api_token');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('unset');
  });

  it('AC3 — DELETE nicht gesetztes Credential → 200, idempotent', async () => {
    const res = await testServer.req('DELETE', '/api/settings/credentials/github/app_id');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('unset');
  });

  it('AC6 — DELETE schreibt Audit-Eintrag ohne Klartext', async () => {
    await store.set('credentials/github/app_id', 'to-delete-secret');
    await testServer.req('DELETE', '/api/settings/credentials/github/app_id');
    const entries = testServer.audit.getAll();
    const entry = entries[entries.length - 1];
    expect(entry.command).toMatch(/credential:delete/);
    expect(JSON.stringify(entry)).not.toContain('to-delete-secret');
  });

  it('AC8 — DELETE unbekannte Integration → 404', async () => {
    const res = await testServer.req('DELETE', '/api/settings/credentials/unknown_int/foo');
    expect(res.status).toBe(404);
  });
});

describe('credentialsRouter — AC7: Mutations-Autorisierung', () => {
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

  it('AC7 — ohne CRED_ADMIN_EMAILS: dev@local darf mutieren', async () => {
    delete process.env.CRED_ADMIN_EMAILS;
    const res = await testServer.req('PUT', '/api/settings/credentials/github/app_id', { value: 'allowed' });
    expect(res.status).toBe(200);
  });

  it('AC7 — CRED_ADMIN_EMAILS gesetzt, Identität nicht in Liste → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com,other@example.com';
    // dev@local ist nicht in der Liste
    const res = await testServer.req('PUT', '/api/settings/credentials/github/app_id', { value: 'blocked' });
    expect(res.status).toBe(403);
  });

  it('AC7 — CRED_ADMIN_EMAILS gesetzt, Identität in Liste → 200', async () => {
    process.env.CRED_ADMIN_EMAILS = 'dev@local,other@example.com';
    const res = await testServer.req('PUT', '/api/settings/credentials/github/app_id', { value: 'permitted' });
    expect(res.status).toBe(200);
  });

  it('AC7 — DELETE ebenfalls durch CRED_ADMIN_EMAILS geschützt', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    const res = await testServer.req('DELETE', '/api/settings/credentials/github/app_id');
    expect(res.status).toBe(403);
  });
});

describe('credentialsRouter — AC7: AccessGuard (403 ohne Token)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
    // Kein DEV_NO_ACCESS
    delete process.env.DEV_NO_ACCESS;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC7 — GET ohne Token (kein DEV_NO_ACCESS) → 403', async () => {
    const app = express();
    app.use(express.json());
    // Guard mit kaputtem KeySet → immer 403
    const guard = createAccessGuard({ aud: 'test-aud', keySet: () => { throw new Error('no keyset'); } });
    app.use('/api', guard);
    const audit = new AuditStore();
    app.use(credentialsRouter(store, audit));
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await new Promise((resolve) => {
      const r = httpRequest(
        { hostname: '127.0.0.1', port, path: '/api/settings/credentials', method: 'GET' },
        (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); },
      );
      r.on('error', () => resolve({ status: 0, body: '' }));
      r.end();
    });
    expect(res.status).toBe(403);

    await new Promise((r) => server.close(r));
  });
});

describe('CredentialStore — assertCredentialConfig()', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'credstore-assert-test-'));
    delete process.env.DEV_NO_ACCESS;
    delete process.env.NODE_ENV;
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.NODE_ENV;
    await rm(dir, { recursive: true, force: true });
  });

  it('Fail-Fast: Store existiert aber kein Key (kein Dev-Bypass) → Fehler', async () => {
    // Store anlegen mit echtem Key
    const s = new CredentialStore({ dir, masterKey: 'some-key' });
    await s.set('credentials/github/app_id', 'val');
    // Neuer Store ohne Key und ohne Dev-Bypass → assertCredentialConfig soll Fehler werfen
    const noKeyStore = new CredentialStore({ dir });
    // Kein DEV_NO_ACCESS → Fail-Fast aktiv
    await expect(noKeyStore.assertCredentialConfig()).rejects.toThrow(/CRED_MASTER_KEY/);
  });

  it('kein Store + kein Key + Dev-Bypass → kein Fehler (nur Warn)', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const noKeyStore = new CredentialStore({ dir }); // kein masterKey, kein Store
    await expect(noKeyStore.assertCredentialConfig()).resolves.toBeUndefined();
  });

  it('Store vorhanden + Key vorhanden → kein Fehler', async () => {
    const s = new CredentialStore({ dir, masterKey: 'some-key' });
    await s.set('credentials/github/app_id', 'val');
    // Neuer Store mit gleichem Key → assertCredentialConfig ok
    const s2 = new CredentialStore({ dir, masterKey: 'some-key' });
    await expect(s2.assertCredentialConfig()).resolves.toBeUndefined();
  });
});
