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
 *   AC9  — VPS-Provider-Token (hetzner, ionos, hostinger): je Provider set/getMeta/delete write-only; Audit ohne Klartext
 *   AC10 — Cloudflare-Credentials (api_token, account_id): CATALOG, resolveKey, set/getMeta/delete write-only, at-rest-Verschlüsselung, HTTP PUT/GET/DELETE, Audit ohne Klartext, CRED_ADMIN_EMAILS-Schutz
 *
 * Covers (credential-runtime-unlock):
 *   AC1  — Start ohne Master-Key und ohne verschlüsselte Einträge → locked, kein Abbruch
 *   AC2  — Fail-Fast-Regression: Store mit verschlüsselten Einträgen + kein Key → assertCredentialConfig wirft
 *   AC3  — Runtime-unlock(key): Key wird geladen, Klartext-Ops funktionieren danach; locked→unlocked
 *   AC4  — Falscher Key bei vorhandenen Einträgen → Ablehnung, .env unverändert, bleibt locked
 *   AC5  — Nach erfolgreichem unlock: .env enthält CRED_MASTER_KEY=<key>; andere Zeilen unverändert; kein Duplikat; 0600
 *   AC6  — .env-Schreiben atomar (tmp + rename)
 *   AC7  — Master-Key erscheint in keinem Log/Response/unlock-Ergebnis
 *   AC8  — getLockState() → {state, hasEncryptedEntries} ohne Key/Klartext
 *
 * Strategie:
 *   - CredentialStore mit tmpdir + injiziertem masterKey (kein Env nötig)
 *   - credentialsRouter mit Express-Testserver + DEV_NO_ACCESS=1
 *   - Server wird einmal pro Describe-Block gestartet (beforeEach), danach closeServer
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { mkdtemp, rm, stat as fsStat, readFile as fsReadFile } from 'node:fs/promises';
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

// ── AC9 — VPS-Provider: drei eigene API-Token-Felder ─────────────────────────

describe('CredentialStore — AC9: VPS-Provider-Token (hetzner, ionos, hostinger)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await rm(dir, { recursive: true, force: true });
  });

  it('AC9 — CREDENTIAL_CATALOG.vps enthält alle drei Provider-Token', () => {
    expect(CREDENTIAL_CATALOG.vps).toContain('hetzner_api_token');
    expect(CREDENTIAL_CATALOG.vps).toContain('ionos_api_token');
    expect(CREDENTIAL_CATALOG.vps).toContain('hostinger_api_token');
    expect(CREDENTIAL_CATALOG.vps.length).toBe(3);
  });

  it('AC9 — resolveKey akzeptiert ionos_api_token', () => {
    const r = resolveKey('vps', 'ionos_api_token');
    expect(r.ok).toBe(true);
    expect(r.storeKey).toBe('credentials/vps/ionos_api_token');
  });

  it('AC9 — resolveKey akzeptiert hostinger_api_token', () => {
    const r = resolveKey('vps', 'hostinger_api_token');
    expect(r.ok).toBe(true);
    expect(r.storeKey).toBe('credentials/vps/hostinger_api_token');
  });

  it('AC9 — list() listet alle drei VPS-Felder (unset bei leerem Store)', async () => {
    const items = await store.list();
    const vpsItems = items.filter((i) => i.integration === 'vps');
    expect(vpsItems.length).toBe(3);
    const names = vpsItems.map((i) => i.name);
    expect(names).toContain('hetzner_api_token');
    expect(names).toContain('ionos_api_token');
    expect(names).toContain('hostinger_api_token');
    for (const item of vpsItems) {
      expect(item.status).toBe('unset');
    }
  });

  it('AC9 — set/getMeta/delete für ionos_api_token: write-only-Verhalten', async () => {
    const meta = await store.set('credentials/vps/ionos_api_token', 'ionos-secret');
    expect(meta.status).toBe('set');
    expect(JSON.stringify(meta)).not.toContain('ionos-secret');

    const getMeta = await store.getMeta('credentials/vps/ionos_api_token');
    expect(getMeta.status).toBe('set');
    expect(getMeta.masked).toBe('•••• gesetzt');
    expect(JSON.stringify(getMeta)).not.toContain('ionos-secret');

    await store.delete('credentials/vps/ionos_api_token');
    const afterDelete = await store.getMeta('credentials/vps/ionos_api_token');
    expect(afterDelete.status).toBe('unset');
  });

  it('AC9 — set/getMeta/delete für hostinger_api_token: write-only-Verhalten', async () => {
    const meta = await store.set('credentials/vps/hostinger_api_token', 'hostinger-secret');
    expect(meta.status).toBe('set');
    expect(JSON.stringify(meta)).not.toContain('hostinger-secret');

    const getMeta = await store.getMeta('credentials/vps/hostinger_api_token');
    expect(getMeta.status).toBe('set');
    expect(getMeta.masked).toBe('•••• gesetzt');
    expect(JSON.stringify(getMeta)).not.toContain('hostinger-secret');

    await store.delete('credentials/vps/hostinger_api_token');
    const afterDelete = await store.getMeta('credentials/vps/hostinger_api_token');
    expect(afterDelete.status).toBe('unset');
  });

  it('AC9 — alle drei VPS-Token unabhängig setzbar (keine gegenseitige Überschreibung)', async () => {
    await store.set('credentials/vps/hetzner_api_token', 'hetzner-val');
    await store.set('credentials/vps/ionos_api_token', 'ionos-val');
    await store.set('credentials/vps/hostinger_api_token', 'hostinger-val');

    expect(await store.getPlaintext('credentials/vps/hetzner_api_token')).toBe('hetzner-val');
    expect(await store.getPlaintext('credentials/vps/ionos_api_token')).toBe('ionos-val');
    expect(await store.getPlaintext('credentials/vps/hostinger_api_token')).toBe('hostinger-val');

    // list() zeigt alle drei als 'set', ohne Klartext
    const items = await store.list();
    const vpsItems = items.filter((i) => i.integration === 'vps');
    for (const item of vpsItems) {
      expect(item.status).toBe('set');
    }
    expect(JSON.stringify(items)).not.toContain('hetzner-val');
    expect(JSON.stringify(items)).not.toContain('ionos-val');
    expect(JSON.stringify(items)).not.toContain('hostinger-val');
  });

  it('AC9 — at-rest verschlüsselt: kein Provider-Token-Klartext in der Store-Datei', async () => {
    await store.set('credentials/vps/ionos_api_token', 'ionos-cleartext-secret');
    await store.set('credentials/vps/hostinger_api_token', 'hostinger-cleartext-secret');
    const { readFile: rf } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');
    const raw = await rf(pjoin(dir, 'secrets.enc.json'), 'utf8');
    expect(raw).not.toContain('ionos-cleartext-secret');
    expect(raw).not.toContain('hostinger-cleartext-secret');
  });
});

describe('credentialsRouter — AC9: VPS-Provider-Token über HTTP', () => {
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

  it('AC9 — PUT ionos_api_token → 200, Response kein Klartext', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/vps/ionos_api_token', { value: 'ionos-api-secret' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('set');
    expect(data.updatedAt).toBeTruthy();
    expect(res.body).not.toContain('ionos-api-secret');
  });

  it('AC9 — PUT hostinger_api_token → 200, Response kein Klartext', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/vps/hostinger_api_token', { value: 'hostinger-api-secret' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('set');
    expect(res.body).not.toContain('hostinger-api-secret');
  });

  it('AC9 — GET nach PUT ionos zeigt status:set für ionos, unset für andere VPS', async () => {
    await testServer.req('PUT', '/api/settings/credentials/vps/ionos_api_token', { value: 'ionos-val' });
    const res = await testServer.req('GET', '/api/settings/credentials');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    const ionos = data.find((i) => i.integration === 'vps' && i.name === 'ionos_api_token');
    expect(ionos.status).toBe('set');
    const hostinger = data.find((i) => i.integration === 'vps' && i.name === 'hostinger_api_token');
    expect(hostinger.status).toBe('unset');
    expect(res.body).not.toContain('ionos-val');
  });

  it('AC9 — DELETE ionos_api_token → 200, status:unset', async () => {
    await store.set('credentials/vps/ionos_api_token', 'ionos-to-delete');
    const res = await testServer.req('DELETE', '/api/settings/credentials/vps/ionos_api_token');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('unset');
  });

  it('AC9 — DELETE hostinger_api_token → 200, idempotent', async () => {
    const res = await testServer.req('DELETE', '/api/settings/credentials/vps/hostinger_api_token');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe('unset');
  });

  it('AC9 — Audit-Eintrag für ionos_api_token ohne Klartext', async () => {
    await testServer.req('PUT', '/api/settings/credentials/vps/ionos_api_token', { value: 'ionos-audit-test' });
    const entries = testServer.audit.getAll();
    const entry = entries[entries.length - 1];
    expect(entry.command).toMatch(/credential:set:credentials\/vps\/ionos_api_token/);
    expect(JSON.stringify(entry)).not.toContain('ionos-audit-test');
  });
});

// ── AC10 — Cloudflare: api_token + account_id ─────────────────────────────────

describe('CredentialStore — AC10: Cloudflare-Credentials (api_token + account_id)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await rm(dir, { recursive: true, force: true });
  });

  it('AC10 — CREDENTIAL_CATALOG.cloudflare enthält api_token und account_id', () => {
    expect(CREDENTIAL_CATALOG.cloudflare).toContain('api_token');
    expect(CREDENTIAL_CATALOG.cloudflare).toContain('account_id');
    expect(CREDENTIAL_CATALOG.cloudflare.length).toBe(2);
  });

  it('AC10 — resolveKey akzeptiert api_token', () => {
    const r = resolveKey('cloudflare', 'api_token');
    expect(r.ok).toBe(true);
    expect(r.storeKey).toBe('credentials/cloudflare/api_token');
  });

  it('AC10 — resolveKey akzeptiert account_id', () => {
    const r = resolveKey('cloudflare', 'account_id');
    expect(r.ok).toBe(true);
    expect(r.storeKey).toBe('credentials/cloudflare/account_id');
  });

  it('AC10 — list() listet beide Cloudflare-Felder (unset bei leerem Store)', async () => {
    const items = await store.list();
    const cfItems = items.filter((i) => i.integration === 'cloudflare');
    expect(cfItems.length).toBe(2);
    const names = cfItems.map((i) => i.name);
    expect(names).toContain('api_token');
    expect(names).toContain('account_id');
    for (const item of cfItems) {
      expect(item.status).toBe('unset');
    }
  });

  it('AC10 — set/getMeta/delete für api_token: write-only-Verhalten', async () => {
    const meta = await store.set('credentials/cloudflare/api_token', 'cf-api-secret');
    expect(meta.status).toBe('set');
    expect(JSON.stringify(meta)).not.toContain('cf-api-secret');

    const getMeta = await store.getMeta('credentials/cloudflare/api_token');
    expect(getMeta.status).toBe('set');
    expect(getMeta.masked).toBe('•••• gesetzt');
    expect(JSON.stringify(getMeta)).not.toContain('cf-api-secret');

    await store.delete('credentials/cloudflare/api_token');
    const afterDelete = await store.getMeta('credentials/cloudflare/api_token');
    expect(afterDelete.status).toBe('unset');
  });

  it('AC10 — set/getMeta/delete für account_id: write-only-Verhalten', async () => {
    const meta = await store.set('credentials/cloudflare/account_id', 'cf-account-secret');
    expect(meta.status).toBe('set');
    expect(JSON.stringify(meta)).not.toContain('cf-account-secret');

    const getMeta = await store.getMeta('credentials/cloudflare/account_id');
    expect(getMeta.status).toBe('set');
    expect(getMeta.masked).toBe('•••• gesetzt');
    expect(JSON.stringify(getMeta)).not.toContain('cf-account-secret');

    await store.delete('credentials/cloudflare/account_id');
    const afterDelete = await store.getMeta('credentials/cloudflare/account_id');
    expect(afterDelete.status).toBe('unset');
  });

  it('AC10 — api_token und account_id unabhängig setzbar (keine gegenseitige Überschreibung)', async () => {
    await store.set('credentials/cloudflare/api_token', 'cf-token-val');
    await store.set('credentials/cloudflare/account_id', 'cf-account-val');

    expect(await store.getPlaintext('credentials/cloudflare/api_token')).toBe('cf-token-val');
    expect(await store.getPlaintext('credentials/cloudflare/account_id')).toBe('cf-account-val');

    // list() zeigt beide als 'set', ohne Klartext
    const items = await store.list();
    const cfItems = items.filter((i) => i.integration === 'cloudflare');
    for (const item of cfItems) {
      expect(item.status).toBe('set');
    }
    expect(JSON.stringify(items)).not.toContain('cf-token-val');
    expect(JSON.stringify(items)).not.toContain('cf-account-val');
  });

  it('AC10 — at-rest verschlüsselt: kein Cloudflare-Klartext in der Store-Datei', async () => {
    await store.set('credentials/cloudflare/api_token', 'cf-token-cleartext');
    await store.set('credentials/cloudflare/account_id', 'cf-account-cleartext');
    const { readFile: rf } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');
    const raw = await rf(pjoin(dir, 'secrets.enc.json'), 'utf8');
    expect(raw).not.toContain('cf-token-cleartext');
    expect(raw).not.toContain('cf-account-cleartext');
  });
});

describe('credentialsRouter — AC10: Cloudflare-Credentials über HTTP', () => {
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

  it('AC10 — PUT api_token → 200, Response kein Klartext', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/cloudflare/api_token', { value: 'cf-api-secret-http' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('set');
    expect(data.updatedAt).toBeTruthy();
    expect(res.body).not.toContain('cf-api-secret-http');
  });

  it('AC10 — PUT account_id → 200, Response kein Klartext', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/cloudflare/account_id', { value: 'cf-account-secret-http' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('set');
    expect(res.body).not.toContain('cf-account-secret-http');
  });

  it('AC10 — GET nach PUT api_token zeigt status:set für api_token, unset für account_id', async () => {
    await testServer.req('PUT', '/api/settings/credentials/cloudflare/api_token', { value: 'cf-token-only' });
    const res = await testServer.req('GET', '/api/settings/credentials');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    const token = data.find((i) => i.integration === 'cloudflare' && i.name === 'api_token');
    expect(token.status).toBe('set');
    const acctId = data.find((i) => i.integration === 'cloudflare' && i.name === 'account_id');
    expect(acctId.status).toBe('unset');
    expect(res.body).not.toContain('cf-token-only');
  });

  it('AC10/AC4 — GET Response enthält keinen Cloudflare-Klartext', async () => {
    await store.set('credentials/cloudflare/api_token', 'cf-secret-never-in-response');
    await store.set('credentials/cloudflare/account_id', 'cf-account-never-in-response');
    const res = await testServer.req('GET', '/api/settings/credentials');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('cf-secret-never-in-response');
    expect(res.body).not.toContain('cf-account-never-in-response');
  });

  it('AC10 — DELETE api_token → 200, status:unset', async () => {
    await store.set('credentials/cloudflare/api_token', 'cf-to-delete');
    const res = await testServer.req('DELETE', '/api/settings/credentials/cloudflare/api_token');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('unset');
  });

  it('AC10 — DELETE account_id → 200, idempotent', async () => {
    const res = await testServer.req('DELETE', '/api/settings/credentials/cloudflare/account_id');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe('unset');
  });

  it('AC10/AC6 — Audit-Eintrag für api_token ohne Klartext', async () => {
    await testServer.req('PUT', '/api/settings/credentials/cloudflare/api_token', { value: 'cf-audit-test-value' });
    const entries = testServer.audit.getAll();
    const entry = entries[entries.length - 1];
    expect(entry.command).toMatch(/credential:set:credentials\/cloudflare\/api_token/);
    expect(JSON.stringify(entry)).not.toContain('cf-audit-test-value');
  });

  it('AC10/AC6 — Audit-Eintrag für account_id ohne Klartext', async () => {
    await testServer.req('PUT', '/api/settings/credentials/cloudflare/account_id', { value: 'cf-account-audit-test' });
    const entries = testServer.audit.getAll();
    const entry = entries[entries.length - 1];
    expect(entry.command).toMatch(/credential:set:credentials\/cloudflare\/account_id/);
    expect(JSON.stringify(entry)).not.toContain('cf-account-audit-test');
  });

  it('AC10/AC6 — DELETE cloudflare/api_token schreibt Audit-Eintrag', async () => {
    await store.set('credentials/cloudflare/api_token', 'cf-to-delete-audit');
    await testServer.req('DELETE', '/api/settings/credentials/cloudflare/api_token');
    const entries = testServer.audit.getAll();
    const entry = entries[entries.length - 1];
    expect(entry.command).toMatch(/credential:delete/);
    expect(JSON.stringify(entry)).not.toContain('cf-to-delete-audit');
  });

  it('AC10/AC7 — PUT cloudflare/api_token mit CRED_ADMIN_EMAILS und nicht berechtigter Identität → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    const res = await testServer.req('PUT', '/api/settings/credentials/cloudflare/api_token', { value: 'blocked-cf-token' });
    expect(res.status).toBe(403);
    delete process.env.CRED_ADMIN_EMAILS;
  });

  it('AC10/AC7 — PUT cloudflare/account_id mit CRED_ADMIN_EMAILS und nicht berechtigter Identität → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    const res = await testServer.req('PUT', '/api/settings/credentials/cloudflare/account_id', { value: 'blocked-cf-account' });
    expect(res.status).toBe(403);
    delete process.env.CRED_ADMIN_EMAILS;
  });

  it('AC10/AC8 — PUT cloudflare mit leerem Wert → 400', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/cloudflare/api_token', { value: '' });
    expect(res.status).toBe(400);
  });

  it('AC10/AC8 — PUT cloudflare mit unbekanntem Feldnamen → 404', async () => {
    const res = await testServer.req('PUT', '/api/settings/credentials/cloudflare/zone_id', { value: 'some-zone-id' });
    expect(res.status).toBe(404);
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

// ── Runtime-Unlock-Zustandsmodell (credential-runtime-unlock AC1–AC8) ─────────

describe('AC1 (credential-runtime-unlock) — locked-Start: kein Key, kein Store → kein Abbruch', () => {
  let dir, envFile;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'credstore-ru-ac1-'));
    envFile = join(dir, '.env');
    delete process.env.DEV_NO_ACCESS;
    delete process.env.NODE_ENV;
    delete process.env.CRED_MASTER_KEY;
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.NODE_ENV;
    delete process.env.CRED_MASTER_KEY;
    await rm(dir, { recursive: true, force: true });
  });

  it('AC1 — Store ohne Key und ohne verschlüsselte Einträge: assertCredentialConfig wirft NICHT', async () => {
    // Kein Key, kein Store
    const store = new CredentialStore({ dir, envPath: envFile });
    // kein masterKey gesetzt → #masterKeyRaw=null
    // assertCredentialConfig darf nicht werfen (leerer Store → locked, OK)
    await expect(store.assertCredentialConfig()).resolves.toBeUndefined();
  });

  it('AC1 — isUnlocked() ist false ohne Key', () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    expect(store.isUnlocked()).toBe(false);
  });

  it('AC1 — getLockState() → state: locked, hasEncryptedEntries: false bei leerem Store', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    const state = await store.getLockState();
    expect(state.state).toBe('locked');
    expect(state.hasEncryptedEntries).toBe(false);
    // Kein Schlüssel/Klartext im Ergebnis
    expect(JSON.stringify(state)).not.toContain('key');
  });

  it('AC1 — Store mit nur meta-Block (Public-Keys) aber keinen verschlüsselten entries: kein Fail-Fast', async () => {
    // Einen Store anlegen der nur meta hat (kein kdf, keine entries)
    const storeWithMeta = new CredentialStore({ dir, masterKey: 'any-key', envPath: envFile });
    await storeWithMeta.setPublicKey('root', 'ssh-ed25519 AAAAC3Nz test');
    // Neuer Store ohne Key → soll NICHT fehlschlagen (nur meta, keine verschlüsselten entries)
    const noKeyStore = new CredentialStore({ dir, envPath: envFile });
    await expect(noKeyStore.assertCredentialConfig()).resolves.toBeUndefined();
  });
});

describe('AC2 (credential-runtime-unlock) — Fail-Fast-Regression: verschlüsselte entries + kein Key → Abbruch', () => {
  let dir, envFile;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'credstore-ru-ac2-'));
    envFile = join(dir, '.env');
    delete process.env.DEV_NO_ACCESS;
    delete process.env.NODE_ENV;
    delete process.env.CRED_MASTER_KEY;
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.NODE_ENV;
    delete process.env.CRED_MASTER_KEY;
    await rm(dir, { recursive: true, force: true });
  });

  it('AC2 — kdf vorhanden + entries nicht leer + kein Key → assertCredentialConfig wirft (Fail-Fast bleibt)', async () => {
    // Store mit echtem Key anlegen → verschlüsselte entries entstehen
    const withKey = new CredentialStore({ dir, masterKey: 'real-key', envPath: envFile });
    await withKey.set('credentials/github/app_id', 'secret-value');

    // Store ohne Key: muss Fail-Fast auslösen
    const noKey = new CredentialStore({ dir, envPath: envFile });
    await expect(noKey.assertCredentialConfig()).rejects.toThrow(/CRED_MASTER_KEY/);
  });

  it('AC2 — Fail-Fast Exit-Pfad: assertCredentialConfig wirft auch ohne Dev-Bypass', async () => {
    const withKey = new CredentialStore({ dir, masterKey: 'real-key-2', envPath: envFile });
    await withKey.set('credentials/cloudflare/api_token', 'cf-token');

    delete process.env.DEV_NO_ACCESS;
    const noKey = new CredentialStore({ dir, envPath: envFile });
    await expect(noKey.assertCredentialConfig()).rejects.toThrow(/CRED_MASTER_KEY/);
  });
});

describe('AC3 (credential-runtime-unlock) — Runtime-unlock: locked→unlocked, Klartext-Ops danach möglich', () => {
  let dir, envFile;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'credstore-ru-ac3-'));
    envFile = join(dir, '.env');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC3 — unlock mit leerem Store: Zustand wechselt locked → unlocked', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    expect(store.isUnlocked()).toBe(false);

    const result = await store.unlock('test-master-key-runtime', { persist: false });
    expect(result.ok).toBe(true);
    expect(store.isUnlocked()).toBe(true);

    const lockState = await store.getLockState();
    expect(lockState.state).toBe('unlocked');
  });

  it('AC3 — nach unlock: set() + getPlaintext() funktionieren (ohne Neustart)', async () => {
    // Store mit Einträgen vorbereiten
    const setup = new CredentialStore({ dir, masterKey: 'my-runtime-key', envPath: envFile });
    await setup.set('credentials/github/app_id', 'my-github-app-id');

    // Neuer Store ohne Key (simuliert gesperrten Start)
    const store = new CredentialStore({ dir, envPath: envFile });
    expect(store.isUnlocked()).toBe(false);

    // Runtime-unlock
    const result = await store.unlock('my-runtime-key', { persist: false });
    expect(result.ok).toBe(true);
    expect(store.isUnlocked()).toBe(true);

    // Klartext-Op funktioniert jetzt
    const pt = await store.getPlaintext('credentials/github/app_id');
    expect(pt).toBe('my-github-app-id');
  });

  it('AC3 — nach unlock: set() auf einem zunächst gesperrten Store schreibt korrekt', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    await store.unlock('fresh-key', { persist: false });

    await store.set('credentials/github/installation_id', 'install-123');
    const pt = await store.getPlaintext('credentials/github/installation_id');
    expect(pt).toBe('install-123');
  });
});

describe('AC4 (credential-runtime-unlock) — Falscher Key bei vorhandenen Einträgen → Ablehnung', () => {
  let dir, envFile;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'credstore-ru-ac4-'));
    envFile = join(dir, '.env');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC4 — falscher Key → ok:false, reason:invalid-key', async () => {
    // Store mit echtem Key anlegen
    const setup = new CredentialStore({ dir, masterKey: 'correct-key', envPath: envFile });
    await setup.set('credentials/github/app_id', 'top-secret');

    // Store ohne Key + falscher Key beim unlock
    const store = new CredentialStore({ dir, envPath: envFile });
    const result = await store.unlock('wrong-key', { persist: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-key');
  });

  it('AC4 — nach Ablehnung: Zustand bleibt locked', async () => {
    const setup = new CredentialStore({ dir, masterKey: 'correct-key-2', envPath: envFile });
    await setup.set('credentials/cloudflare/api_token', 'cf-secret');

    const store = new CredentialStore({ dir, envPath: envFile });
    await store.unlock('completely-wrong-key', { persist: false });

    expect(store.isUnlocked()).toBe(false);
    const lockState = await store.getLockState();
    expect(lockState.state).toBe('locked');
  });

  it('AC4 — nach Ablehnung: .env nicht verändert (persist:true, falscher Key)', async () => {
    // .env mit bestehender Zeile anlegen
    const { writeFile } = await import('node:fs/promises');
    await writeFile(envFile, 'OTHER_VAR=other-value\nCRED_MASTER_KEY=old-key\n', { mode: 0o600 });

    const setup = new CredentialStore({ dir, masterKey: 'correct-key-3', envPath: envFile });
    await setup.set('credentials/github/private_key', 'priv-secret');

    const store = new CredentialStore({ dir, envPath: envFile });
    const result = await store.unlock('wrong-key-persist', { persist: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-key');

    // .env muss unverändert sein
    const envContent = await fsReadFile(envFile, 'utf8');
    expect(envContent).toContain('OTHER_VAR=other-value');
    expect(envContent).toContain('CRED_MASTER_KEY=old-key');
    expect(envContent).not.toContain('wrong-key-persist');
  });

  it('AC4 — leerer Key → ok:false, reason:empty-key (keine Validierung, keine .env-Mutation)', async () => {
    const setup = new CredentialStore({ dir, masterKey: 'correct-key-4', envPath: envFile });
    await setup.set('credentials/github/app_id', 'val');

    const store = new CredentialStore({ dir, envPath: envFile });
    const result = await store.unlock('', { persist: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-key');
    expect(store.isUnlocked()).toBe(false);
  });

  it('AC4 — whitespace-only Key → ok:false, reason:empty-key', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    const result = await store.unlock('   ', { persist: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-key');
  });

  it('AC4 — Key mit eingebettetem Newline → ok:false, reason:invalid-key-format, .env unverändert', async () => {
    // Embedded \n korrumpiert .env: "abc\ndef" erzeugt zwei Zeilen → späterer Boot liest nur "abc"
    const { writeFile } = await import('node:fs/promises');
    await writeFile(envFile, 'OTHER=preserved\nCRED_MASTER_KEY=old-key\n', { mode: 0o600 });

    const store = new CredentialStore({ dir, envPath: envFile });
    const result = await store.unlock('abc\ndef', { persist: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-key-format');

    // .env darf nicht verändert worden sein
    const envContent = await fsReadFile(envFile, 'utf8');
    expect(envContent).toContain('OTHER=preserved');
    expect(envContent).toContain('CRED_MASTER_KEY=old-key');
    expect(envContent).not.toContain('abc');

    // Store bleibt locked
    expect(store.isUnlocked()).toBe(false);
  });

  it('AC4 — Key mit eingebettetem \\r → ok:false, reason:invalid-key-format', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    const result = await store.unlock('key\rwith-cr', { persist: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-key-format');
    expect(store.isUnlocked()).toBe(false);
  });
});

describe('AC5/AC6 (credential-runtime-unlock) — .env-Persistenz: atomar, 0600, kein Duplikat, andere Zeilen erhalten', () => {
  let dir, envFile;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'credstore-ru-ac5-'));
    envFile = join(dir, '.env');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC5 — nach unlock: .env enthält CRED_MASTER_KEY=<key>', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    const result = await store.unlock('my-persist-key', { persist: true });
    expect(result.ok).toBe(true);

    const envContent = await fsReadFile(envFile, 'utf8');
    expect(envContent).toContain('CRED_MASTER_KEY=my-persist-key');
  });

  it('AC5 — nach unlock: andere .env-Variablen bleiben erhalten', async () => {
    // .env mit bestehenden Zeilen anlegen
    const { writeFile } = await import('node:fs/promises');
    await writeFile(envFile, 'ACCESS_TEAM_DOMAIN=example.com\nGH_TOKEN=ghp_123\n', { mode: 0o600 });

    const store = new CredentialStore({ dir, envPath: envFile });
    await store.unlock('persist-key-no-overwrite', { persist: true });

    const envContent = await fsReadFile(envFile, 'utf8');
    expect(envContent).toContain('ACCESS_TEAM_DOMAIN=example.com');
    expect(envContent).toContain('GH_TOKEN=ghp_123');
    expect(envContent).toContain('CRED_MASTER_KEY=persist-key-no-overwrite');
  });

  it('AC5 — vorhandener CRED_MASTER_KEY wird ersetzt (kein Duplikat)', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(envFile, 'OTHER=val\nCRED_MASTER_KEY=old-key\n', { mode: 0o600 });

    const store = new CredentialStore({ dir, envPath: envFile });
    await store.unlock('new-key-replacing-old', { persist: true });

    const envContent = await fsReadFile(envFile, 'utf8');
    expect(envContent).toContain('CRED_MASTER_KEY=new-key-replacing-old');
    expect(envContent).toContain('OTHER=val');
    // Kein Duplikat: genau eine CRED_MASTER_KEY-Zeile
    const lines = envContent.split('\n').filter((l) => l.startsWith('CRED_MASTER_KEY='));
    expect(lines.length).toBe(1);
    // Alter Key nicht mehr vorhanden
    expect(envContent).not.toContain('CRED_MASTER_KEY=old-key');
  });

  it('AC5 — Dateirechte 0600 nach unlock', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    await store.unlock('key-for-chmod-test', { persist: true });

    const stats = await fsStat(envFile);
    // Nur Owner-Bits prüfen (0o600 = 0o100600, Typ-Bits ausblenden)
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('AC6 — atomares Schreiben: kein tmp-File nach erfolgreichem unlock', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    await store.unlock('atomic-write-key', { persist: true });

    // Temp-Datei darf nicht übrig bleiben
    let tmpExists = false;
    try {
      await fsStat(`${envFile}.cred-tmp`);
      tmpExists = true;
    } catch {
      // ENOENT erwartet
    }
    expect(tmpExists).toBe(false);

    // .env muss vorhanden und korrekt sein
    const envContent = await fsReadFile(envFile, 'utf8');
    expect(envContent).toContain('CRED_MASTER_KEY=atomic-write-key');
  });
});

describe('AC7 (credential-runtime-unlock) — Master-Key darf NICHT in unlock-Ergebnis, Logs oder Fehlern erscheinen', () => {
  let dir, envFile;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'credstore-ru-ac7-'));
    envFile = join(dir, '.env');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC7 — unlock-Ergebnis bei Erfolg enthält keinen Key-Wert', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    const secret = 'super-secret-key-must-not-leak-0xdeadbeef';
    const result = await store.unlock(secret, { persist: false });

    expect(result.ok).toBe(true);
    // Ergebnis-Objekt darf den Key nicht enthalten
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('AC7 — unlock-Ergebnis bei Fehler (falscher Key) enthält keinen Key-Wert', async () => {
    const setup = new CredentialStore({ dir, masterKey: 'correct-secret', envPath: envFile });
    await setup.set('credentials/github/app_id', 'val');

    const store = new CredentialStore({ dir, envPath: envFile });
    const wrongKey = 'wrong-key-must-not-leak-0xcafebabe';
    const result = await store.unlock(wrongKey, { persist: false });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(wrongKey);
  });

  it('AC7 — unlock-Ergebnis bei empty-key enthält keinen Key-Wert', async () => {
    // S3: konkreter Wert statt aussagelosem Whitespace-String — der gesamte .
    // Ergebnis-String des whitespace-only-Aufrufs darf keine gesonderten Schlüssel-Fragmente
    // enthalten. Wir prüfen reason und dass result kein Payload mit Schlüsselwert trägt.
    const store = new CredentialStore({ dir, envPath: envFile });
    const result = await store.unlock('  ', { persist: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-key');
    // Das Ergebnis-Objekt darf nur {ok, reason} enthalten — kein Schlüssel-Wert
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('"ok":false');
    expect(serialized).toContain('"reason":"empty-key"');
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('AC7 — getLockState() enthält weder Key noch Klartext-Werte', async () => {
    const store = new CredentialStore({ dir, masterKey: 'secret-key-in-mem', envPath: envFile });
    await store.set('credentials/github/app_id', 'plaintext-cred');
    const lockState = await store.getLockState();

    expect(JSON.stringify(lockState)).not.toContain('secret-key-in-mem');
    expect(JSON.stringify(lockState)).not.toContain('plaintext-cred');
    // Nur erlaubte Felder: state, hasEncryptedEntries
    expect(Object.keys(lockState)).toEqual(expect.arrayContaining(['state', 'hasEncryptedEntries']));
    expect(Object.keys(lockState).length).toBe(2);
  });

  it('AC7 — persist-failed-Fehler enthält keinen Key-Wert', async () => {
    // persist auf nicht-schreibbaren Pfad setzen → persist-failed
    const store = new CredentialStore({ dir, envPath: '/nonexistent-dir/cannot-write/.env' });
    const secretKey = 'secret-key-persist-fail-test-0xfeed';
    const result = await store.unlock(secretKey, { persist: true });

    // Ergebnis: persist-failed, aber kein Key-Leak
    expect(result.reason).toBe('persist-failed');
    expect(JSON.stringify(result)).not.toContain(secretKey);
  });

  it('AC7 — Log-Kanal (console.warn/error): Key erscheint in keinem console-Aufruf (Erfolg + persist-failed)', async () => {
    // Erfolg-Pfad: unlock mit nicht-schreibbarem Pfad provoziert persist-failed
    // → assertiert dass der Secret-String NICHT in console.warn oder console.error landet
    const secretKey = 'ultra-secret-log-leak-check-0xdeadcafe';

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // persist-failed: der Catch-Zweig in #persistKeyToEnv und unlock darf den Key nicht loggen
      const store = new CredentialStore({ dir, envPath: '/nonexistent-path-for-spy-test/.env' });
      const result = await store.unlock(secretKey, { persist: true });
      expect(result.reason).toBe('persist-failed');

      // Alle console.warn/error-Aufrufe prüfen: kein Argument darf den Secret-String enthalten
      for (const call of warnSpy.mock.calls) {
        const callStr = call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        expect(callStr).not.toContain(secretKey);
      }
      for (const call of errorSpy.mock.calls) {
        const callStr = call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        expect(callStr).not.toContain(secretKey);
      }
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('AC7 — Log-Kanal: Key erscheint nicht in console bei erfolgreichem unlock', async () => {
    const secretKey = 'success-unlock-no-log-leak-0xcafed00d';

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const store = new CredentialStore({ dir, envPath: envFile });
      const result = await store.unlock(secretKey, { persist: true });
      expect(result.ok).toBe(true);

      for (const call of warnSpy.mock.calls) {
        const callStr = call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        expect(callStr).not.toContain(secretKey);
      }
      for (const call of errorSpy.mock.calls) {
        const callStr = call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        expect(callStr).not.toContain(secretKey);
      }
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('AC8 (credential-runtime-unlock) — getLockState(): zustandslos, leak-frei', () => {
  let dir, envFile;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'credstore-ru-ac8-'));
    envFile = join(dir, '.env');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC8 — gesperrter Store: {state:"locked", hasEncryptedEntries:false}', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    const lockState = await store.getLockState();
    expect(lockState).toEqual({ state: 'locked', hasEncryptedEntries: false });
  });

  it('AC8 — entsperrter Store ohne Einträge: {state:"unlocked", hasEncryptedEntries:false}', async () => {
    const store = new CredentialStore({ dir, masterKey: 'some-key', envPath: envFile });
    const lockState = await store.getLockState();
    expect(lockState).toEqual({ state: 'unlocked', hasEncryptedEntries: false });
  });

  it('AC8 — entsperrter Store mit Einträgen: {state:"unlocked", hasEncryptedEntries:true}', async () => {
    const store = new CredentialStore({ dir, masterKey: 'some-key-2', envPath: envFile });
    await store.set('credentials/github/app_id', 'some-value');
    const lockState = await store.getLockState();
    expect(lockState).toEqual({ state: 'unlocked', hasEncryptedEntries: true });
  });

  it('AC8 — gesperrter Store mit vorhandenen Einträgen (kein Key): {state:"locked", hasEncryptedEntries:true}', async () => {
    // Einträge anlegen (mit Key)
    const setup = new CredentialStore({ dir, masterKey: 'setup-key', envPath: envFile });
    await setup.set('credentials/github/private_key', 'priv-key-val');

    // Store ohne Key: locked aber hasEncryptedEntries=true
    const store = new CredentialStore({ dir, envPath: envFile });
    const lockState = await store.getLockState();
    expect(lockState).toEqual({ state: 'locked', hasEncryptedEntries: true });
  });

  it('AC8 — getLockState() hat exakt zwei Felder (state + hasEncryptedEntries)', async () => {
    const store = new CredentialStore({ dir, masterKey: 'k', envPath: envFile });
    const lockState = await store.getLockState();
    const keys = Object.keys(lockState);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('state');
    expect(keys).toContain('hasEncryptedEntries');
  });

  it('AC8 — Doppeltes unlock (gleicher Key) ist idempotent → state bleibt unlocked', async () => {
    const store = new CredentialStore({ dir, envPath: envFile });
    await store.unlock('idempotent-key', { persist: false });
    const result2 = await store.unlock('idempotent-key', { persist: false });
    expect(result2.ok).toBe(true);
    expect(store.isUnlocked()).toBe(true);
  });
});
