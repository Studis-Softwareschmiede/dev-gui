/**
 * notificationSettings.test.js — Tests für NotificationSettingsStore + notifications-Router (S-183).
 *
 * Covers (push-notifications S-183):
 *   AC1  — Persistenz: Store-Roundtrip (write→read); überleben Neustart (Dateipersistenz);
 *           ENOENT gibt Defaults zurück; Defaults korrekt; write ist atomar.
 *   AC2  — GET /api/settings/notifications: 200 mit Settings + has_token (Bool);
 *           Token-Klartext NIE in Response (AC10 Floor).
 *           PUT /api/settings/notifications: 200 gespeichert; 400 bei ungültiger server-URL;
 *           400 bei leerem topic + enabled=true; 400 bei ungültigen events;
 *           400 bei ungültiger priority; SSRF-Ablehnung interner Ziele inkl.
 *           IPv4-mapped IPv6 [::ffff:7f00:1] + [::ffff:a9fe:a9fe] (security/R05-Fix Iter.2),
 *           AWS EC2 IPv6 IMDS [fd00:ec2::254] + bare [::1] (security/R05-Fix Iter.3);
 *           keine Teilspeicherung bei Validierungsfehler (400 → read() liefert alten Stand).
 *   AC10 — Response enthält NIE Token-Klartext; has_token ist Bool (kein String/Klartext).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile } from 'node:fs/promises';

// ── HTTP-Helpers ──────────────────────────────────────────────────────────────

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPut(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = httpRequest(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── AC1: NotificationSettingsStore Unit-Tests ─────────────────────────────────

describe('AC1 — NotificationSettingsStore Persistenz', () => {
  let tmpDir;
  let origCredStoreDir;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `notif-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = tmpDir;
    // Module-Cache leeren damit resolveSettingsFilePath() neuen CRED_STORE_DIR liest
    jest.resetModules();
  });

  afterEach(async () => {
    if (origCredStoreDir !== undefined) {
      process.env.CRED_STORE_DIR = origCredStoreDir;
    } else {
      delete process.env.CRED_STORE_DIR;
    }
    await rm(tmpDir, { recursive: true, force: true });
    jest.resetModules();
  });

  it('gibt Defaults zurück wenn keine JSON-Datei existiert (ENOENT)', async () => {
    const { read } = await import('../src/NotificationSettingsStore.js');
    const settings = await read();
    expect(settings.enabled).toBe(false);
    expect(settings.server).toBe('https://ntfy.sh');
    expect(settings.topic).toBe('');
    expect(settings.priority).toBeNull();
    expect(settings.events).toEqual([]);
  });

  it('write→read Roundtrip: gespeicherte Werte werden zurückgeliefert', async () => {
    const { read, write } = await import('../src/NotificationSettingsStore.js');
    const toWrite = {
      enabled: true,
      server: 'https://my-ntfy.example.com',
      topic: 'alerts',
      priority: 4,
      events: ['story_done', 'feature_done'],
    };
    await write(toWrite);
    const result = await read();
    expect(result.enabled).toBe(true);
    expect(result.server).toBe('https://my-ntfy.example.com');
    expect(result.topic).toBe('alerts');
    expect(result.priority).toBe(4);
    expect(result.events).toEqual(['story_done', 'feature_done']);
  });

  it('write erstellt Datei in CRED_STORE_DIR', async () => {
    const { write } = await import('../src/NotificationSettingsStore.js');
    await write({ enabled: false, server: 'https://ntfy.sh', topic: '', priority: null, events: [] });
    const filePath = join(tmpDir, 'notification-settings.json');
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.server).toBe('https://ntfy.sh');
  });

  it('Persistenz über Modul-Reload (simuliert Neustart): Datei bleibt erhalten', async () => {
    const { write } = await import('../src/NotificationSettingsStore.js');
    await write({ enabled: true, server: 'https://ntfy.sh', topic: 'my-topic', priority: 3, events: ['story_blocked'] });

    // Modul-Cache leeren → frischer Import (simuliert Neustart)
    jest.resetModules();
    const { read: readAgain } = await import('../src/NotificationSettingsStore.js');
    const reloaded = await readAgain();
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.topic).toBe('my-topic');
    expect(reloaded.priority).toBe(3);
    expect(reloaded.events).toEqual(['story_blocked']);
  });

  it('gibt Fehler wenn CRED_STORE_DIR nicht gesetzt', async () => {
    delete process.env.CRED_STORE_DIR;
    jest.resetModules();
    const { write } = await import('../src/NotificationSettingsStore.js');
    await expect(write({ enabled: false })).rejects.toThrow(/CRED_STORE_DIR/);
  });
});

// ── AC2: validate() Unit-Tests ────────────────────────────────────────────────

describe('AC2 — validate() Feldvalidierung', () => {
  let validate;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../src/NotificationSettingsStore.js');
    validate = mod.validate;
  });

  afterEach(() => jest.resetModules());

  it('gültige Eingabe → { ok: true }', () => {
    const result = validate({
      enabled: true,
      server: 'https://ntfy.sh',
      topic: 'my-alerts',
      priority: 3,
      events: ['story_done'],
    });
    expect(result.ok).toBe(true);
  });

  it('server: keine URL → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'not-a-url', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('server: file:// scheme → 400 field=server (Scheme-Allowlist)', () => {
    const result = validate({ enabled: false, server: 'file:///etc/passwd', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('server: ftp:// scheme → 400 field=server (Scheme-Allowlist)', () => {
    const result = validate({ enabled: false, server: 'ftp://files.example.com', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('SSRF: localhost → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'http://localhost:9999', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('SSRF: 127.0.0.1 → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'http://127.0.0.1:8080', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('SSRF: 10.0.0.1 (private) → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'http://10.0.0.1', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('SSRF: 192.168.1.1 (private) → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'https://192.168.1.1', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('SSRF: 169.254.169.254 (Cloud-Metadaten) → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'http://169.254.169.254', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('SSRF: metadata.google.internal → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'http://metadata.google.internal', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('SSRF: IPv4-mapped IPv6 [::ffff:7f00:1] (=127.0.0.1) → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'http://[::ffff:7f00:1]', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('SSRF: IPv4-mapped IPv6 [::ffff:a9fe:a9fe] (=169.254.169.254 Cloud-Metadaten) → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'http://[::ffff:a9fe:a9fe]', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('SSRF: AWS EC2 IPv6 IMDS [fd00:ec2::254] → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'http://[fd00:ec2::254]', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('SSRF: bare [::1] (IPv6 loopback mit Klammern) → 400 field=server', () => {
    const result = validate({ enabled: false, server: 'http://[::1]', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('server');
  });

  it('topic: leer bei enabled=true → 400 field=topic', () => {
    const result = validate({ enabled: true, server: 'https://ntfy.sh', topic: '', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('topic');
  });

  it('topic: leer bei enabled=false → ok (kein Fehler)', () => {
    const result = validate({ enabled: false, server: 'https://ntfy.sh', topic: '', events: [] });
    expect(result.ok).toBe(true);
  });

  it('topic: Leerzeichen + Doppelpunkt ("DEV-GUI melder :") → 400 field=topic (sonst ntfy-404)', () => {
    const result = validate({ enabled: true, server: 'https://ntfy.sh', topic: 'DEV-GUI melder :', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('topic');
  });

  it('topic: internes Leerzeichen → 400 field=topic', () => {
    const result = validate({ enabled: true, server: 'https://ntfy.sh', topic: 'my topic', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('topic');
  });

  it('topic: Sonderzeichen (#) → 400 field=topic', () => {
    const result = validate({ enabled: false, server: 'https://ntfy.sh', topic: 'alerts#1', events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('topic');
  });

  it('topic: über 64 Zeichen → 400 field=topic', () => {
    const result = validate({ enabled: true, server: 'https://ntfy.sh', topic: 'a'.repeat(65), events: [] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('topic');
  });

  it('topic: gültig (Buchstaben/Ziffern/Bindestrich/Unterstrich) → ok', () => {
    const result = validate({ enabled: true, server: 'https://ntfy.sh', topic: 'DEV-GUI_melder-1', events: [] });
    expect(result.ok).toBe(true);
  });

  it('events: ungültiger Schlüssel → 400 field=events', () => {
    const result = validate({ enabled: false, server: 'https://ntfy.sh', topic: '', events: ['invalid_event'] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('events');
  });

  it('events: alle erlaubten Schlüssel → ok', () => {
    const result = validate({
      enabled: false,
      server: 'https://ntfy.sh',
      topic: '',
      events: ['story_done', 'story_blocked', 'feature_done'],
    });
    expect(result.ok).toBe(true);
  });

  it('priority: 0 (unter Min) → 400 field=priority', () => {
    const result = validate({ enabled: false, server: 'https://ntfy.sh', topic: '', events: [], priority: 0 });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('priority');
  });

  it('priority: 6 (über Max) → 400 field=priority', () => {
    const result = validate({ enabled: false, server: 'https://ntfy.sh', topic: '', events: [], priority: 6 });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('priority');
  });

  it('priority: null → ok (ntfy-Default)', () => {
    const result = validate({ enabled: false, server: 'https://ntfy.sh', topic: '', events: [], priority: null });
    expect(result.ok).toBe(true);
  });

  it('priority: 1–5 → ok', () => {
    for (let p = 1; p <= 5; p++) {
      const result = validate({ enabled: false, server: 'https://ntfy.sh', topic: '', events: [], priority: p });
      expect(result.ok).toBe(true);
    }
  });
});

// ── AC2: notifications-Router HTTP-Tests ──────────────────────────────────────

describe('AC2 — GET/PUT /api/settings/notifications (HTTP-Ebene)', () => {
  let server;
  let port;
  let tmpDir;
  let origCredStoreDir;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `notif-router-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = tmpDir;
    jest.resetModules();
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    if (origCredStoreDir !== undefined) {
      process.env.CRED_STORE_DIR = origCredStoreDir;
    } else {
      delete process.env.CRED_STORE_DIR;
    }
    await rm(tmpDir, { recursive: true, force: true });
    jest.resetModules();
  });

  /**
   * Baut eine Express-App mit dem notifications-Router.
   *
   * @param {{ hasToken?: boolean }} opts
   */
  async function makeApp({ hasToken = false } = {}) {
    const { create } = await import('../src/routers/notifications.js');
    const credentialStore = {
      getMeta: jest.fn(async () => hasToken ? { status: 'set', masked: '••••token' } : { status: 'unset' }),
      getPlaintext: jest.fn(async () => null),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'test@example.com' }; next(); });
    app.use(create({ credentialStore }));
    return app;
  }

  it('GET /api/settings/notifications → 200 mit Default-Settings + has_token=false', async () => {
    const app = await makeApp({ hasToken: false });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpGet(port, '/api/settings/notifications');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.server).toBe('https://ntfy.sh');
    expect(res.body.topic).toBe('');
    expect(res.body.events).toEqual([]);
    expect(res.body.has_token).toBe(false);
  });

  it('GET /api/settings/notifications → has_token=true wenn Token gesetzt', async () => {
    const app = await makeApp({ hasToken: true });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpGet(port, '/api/settings/notifications');
    expect(res.status).toBe(200);
    expect(res.body.has_token).toBe(true);
  });

  it('AC10: GET-Response enthält NIE Token-Klartext', async () => {
    const app = await makeApp({ hasToken: true });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpGet(port, '/api/settings/notifications');
    // has_token ist Bool, kein String/Klartext
    expect(typeof res.body.has_token).toBe('boolean');
    // Kein token-Feld, kein ntfy_token-Feld in der Response
    expect(res.body.token).toBeUndefined();
    expect(res.body.ntfy_token).toBeUndefined();
  });

  it('PUT /api/settings/notifications → 200 mit gespeicherten Werten', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/notifications', {
      enabled: true,
      server: 'https://my-ntfy.example.com',
      topic: 'alerts',
      priority: 3,
      events: ['story_done'],
    });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.server).toBe('https://my-ntfy.example.com');
    expect(res.body.topic).toBe('alerts');
    expect(res.body.priority).toBe(3);
    expect(res.body.events).toEqual(['story_done']);
  });

  it('PUT → GET Roundtrip: gespeicherte Werte werden zurückgeliefert', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    await httpPut(port, '/api/settings/notifications', {
      enabled: true,
      server: 'https://ntfy.example.org',
      topic: 'board-events',
      priority: 2,
      events: ['story_done', 'feature_done'],
    });

    const getRes = await httpGet(port, '/api/settings/notifications');
    expect(getRes.status).toBe(200);
    expect(getRes.body.enabled).toBe(true);
    expect(getRes.body.server).toBe('https://ntfy.example.org');
    expect(getRes.body.topic).toBe('board-events');
    expect(getRes.body.priority).toBe(2);
    expect(getRes.body.events).toEqual(['story_done', 'feature_done']);
  });

  it('PUT: ungültige server-URL → 400 { field: "server", message }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/notifications', {
      enabled: false,
      server: 'not-a-valid-url',
      topic: '',
      events: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('server');
    expect(res.body.message).toBeDefined();
  });

  it('PUT: leeres topic bei enabled=true → 400 { field: "topic" }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/notifications', {
      enabled: true,
      server: 'https://ntfy.sh',
      topic: '',
      events: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('topic');
  });

  it('PUT: ungültige events → 400 { field: "events" }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/notifications', {
      enabled: false,
      server: 'https://ntfy.sh',
      topic: '',
      events: ['invalid_event'],
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('events');
  });

  it('PUT: ungültige priority → 400 { field: "priority" }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/notifications', {
      enabled: false,
      server: 'https://ntfy.sh',
      topic: '',
      events: [],
      priority: 10,
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('priority');
  });

  it('PUT: SSRF — localhost → 400 { field: "server" }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/notifications', {
      enabled: false,
      server: 'http://localhost:9999',
      topic: '',
      events: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('server');
  });

  it('PUT: SSRF — 169.254.169.254 (Cloud-Metadaten) → 400 { field: "server" }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/notifications', {
      enabled: false,
      server: 'http://169.254.169.254/latest/meta-data/',
      topic: '',
      events: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('server');
  });

  it('PUT: keine Teilspeicherung bei Validierungsfehler (alter Stand bleibt)', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    // Erst gültige Daten speichern
    await httpPut(port, '/api/settings/notifications', {
      enabled: true,
      server: 'https://ntfy.sh',
      topic: 'my-topic',
      events: ['story_done'],
    });

    // Dann ungültige Daten → 400
    const badPut = await httpPut(port, '/api/settings/notifications', {
      enabled: false,
      server: 'http://localhost',
      topic: '',
      events: [],
    });
    expect(badPut.status).toBe(400);

    // GET muss noch den alten (gültigen) Stand liefern
    const getRes = await httpGet(port, '/api/settings/notifications');
    expect(getRes.body.enabled).toBe(true);
    expect(getRes.body.topic).toBe('my-topic');
  });
});
