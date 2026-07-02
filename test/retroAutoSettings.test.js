/**
 * retroAutoSettings.test.js — Tests für RetroAutoSettingsStore + retroAutoSettings-Router
 * (retro-auto-trigger S-259).
 *
 * Covers (retro-auto-trigger):
 *   AC1 — RetroAutoSettingsStore: read() liefert { enabled } (Default enabled:false, auch
 *         bei fehlender Datei — kein Crash, Edge-Case ENOENT); Store-Roundtrip (write→read);
 *         write persistiert atomar (tmp+rename, Datei in CRED_STORE_DIR); Persistenz über
 *         Modul-Reload (simuliert Neustart); korrupte JSON-Datei → Default (kein Crash);
 *         write ohne CRED_STORE_DIR wirft; validate({enabled}) lehnt Nicht-Boolean mit
 *         { ok:false, field:'enabled' } ab, akzeptiert Boolean/leer/undefined; keine Secrets
 *         in der Datei (Roundtrip prüft, dass nur `enabled` persistiert wird).
 *   AC2 — GET/PUT /api/settings/retro-auto (HTTP-Ebene): GET → 200 { enabled } (Default/
 *         gespeichert); PUT → 200 { enabled } (persistiert, Roundtrip); PUT 400
 *         { field, message } bei Nicht-Boolean; keine Teilspeicherung bei Validierungsfehler;
 *         Response enthält ausschließlich `enabled` (keine Secrets).
 *         AccessGuard — nicht separat getestet, da global vor mountRouters() in server.js
 *         via `app.use('/api', accessGuard)` angewendet (nicht Bestandteil des einzelnen
 *         Router-Moduls, analog tickerSettings.test.js/notificationSettings.test.js).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';

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

// ── AC1: RetroAutoSettingsStore Persistenz ────────────────────────────────────

describe('AC1 — RetroAutoSettingsStore Persistenz', () => {
  let tmpDir;
  let origCredStoreDir;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `retro-auto-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = tmpDir;
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

  it('gibt Default { enabled:false } zurück wenn keine JSON-Datei existiert (ENOENT, kein Crash)', async () => {
    const { read } = await import('../src/RetroAutoSettingsStore.js');
    const settings = await read();
    expect(settings).toEqual({ enabled: false });
  });

  it('write→read Roundtrip: enabled=true wird zurückgeliefert', async () => {
    const { read, write } = await import('../src/RetroAutoSettingsStore.js');
    await write({ enabled: true });
    const result = await read();
    expect(result).toEqual({ enabled: true });
  });

  it('write erstellt Datei in CRED_STORE_DIR und persistiert ausschließlich `enabled` (keine Secrets)', async () => {
    const { write } = await import('../src/RetroAutoSettingsStore.js');
    await write({ enabled: true });
    const filePath = join(tmpDir, 'retro-auto-settings.json');
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ enabled: true });
    // Keine Secrets: exakt ein Feld, ausschließlich `enabled`.
    expect(Object.keys(parsed)).toEqual(['enabled']);
  });

  it('Persistenz über Modul-Reload (simuliert Neustart): Datei bleibt erhalten', async () => {
    const { write } = await import('../src/RetroAutoSettingsStore.js');
    await write({ enabled: true });

    jest.resetModules();
    const { read: readAgain } = await import('../src/RetroAutoSettingsStore.js');
    const reloaded = await readAgain();
    expect(reloaded.enabled).toBe(true);
  });

  it('write ist ein Partial-Update (Merge mit aktuellem Stand statt Overwrite)', async () => {
    const { read, write } = await import('../src/RetroAutoSettingsStore.js');
    await write({ enabled: true });
    await write({});
    const result = await read();
    expect(result.enabled).toBe(true);
  });

  it('korrupte JSON-Datei → read fällt auf Default zurück (kein Crash)', async () => {
    const filePath = join(tmpDir, 'retro-auto-settings.json');
    await writeFile(filePath, '{ this is not valid json ');
    const { read } = await import('../src/RetroAutoSettingsStore.js');
    const settings = await read();
    expect(settings).toEqual({ enabled: false });
  });

  it('nicht-boolescher persistierter Wert → read normalisiert auf Default false', async () => {
    const filePath = join(tmpDir, 'retro-auto-settings.json');
    await writeFile(filePath, JSON.stringify({ enabled: 'yes' }));
    const { read } = await import('../src/RetroAutoSettingsStore.js');
    const settings = await read();
    expect(settings.enabled).toBe(false);
  });

  it('gibt Fehler wenn CRED_STORE_DIR nicht gesetzt', async () => {
    delete process.env.CRED_STORE_DIR;
    jest.resetModules();
    const { write } = await import('../src/RetroAutoSettingsStore.js');
    await expect(write({ enabled: true })).rejects.toThrow(/CRED_STORE_DIR/);
  });

  it('read liefert Default (enabled:false) auch ohne CRED_STORE_DIR (kein Crash)', async () => {
    delete process.env.CRED_STORE_DIR;
    jest.resetModules();
    const { read } = await import('../src/RetroAutoSettingsStore.js');
    const settings = await read();
    expect(settings).toEqual({ enabled: false });
  });
});

// ── AC1: validate() Unit-Tests ────────────────────────────────────────────────

describe('AC1 — validate() Feldvalidierung', () => {
  let validate;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../src/RetroAutoSettingsStore.js');
    validate = mod.validate;
  });

  afterEach(() => jest.resetModules());

  it('enabled=true → { ok: true }', () => {
    expect(validate({ enabled: true }).ok).toBe(true);
  });

  it('enabled=false → { ok: true }', () => {
    expect(validate({ enabled: false }).ok).toBe(true);
  });

  it('leer/Partial ({}) → { ok: true } (enabled undefined ist erlaubt)', () => {
    expect(validate({}).ok).toBe(true);
  });

  it('body undefined → { ok: true }', () => {
    expect(validate(undefined).ok).toBe(true);
  });

  it('enabled: String → 400 field=enabled', () => {
    const result = validate({ enabled: 'yes' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('enabled');
    expect(result.message).toBeDefined();
  });

  it('enabled: Zahl (1) → 400 field=enabled', () => {
    const result = validate({ enabled: 1 });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('enabled');
  });

  it('enabled: null → 400 field=enabled', () => {
    const result = validate({ enabled: null });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('enabled');
  });
});

// ── AC2: retroAutoSettings-Router HTTP-Tests ──────────────────────────────────

describe('AC2 — GET/PUT /api/settings/retro-auto (HTTP-Ebene)', () => {
  let server;
  let port;
  let tmpDir;
  let origCredStoreDir;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `retro-auto-router-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  async function makeApp() {
    const { create } = await import('../src/routers/retroAutoSettings.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'test@example.com' }; next(); });
    app.use(create());
    return app;
  }

  it('GET /api/settings/retro-auto → 200 { enabled: false } (Default)', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpGet(port, '/api/settings/retro-auto');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it('PUT /api/settings/retro-auto { enabled:true } → 200 { enabled: true } (persistiert)', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/retro-auto', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it('PUT → GET Roundtrip: gespeicherter Wert wird zurückgeliefert', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    await httpPut(port, '/api/settings/retro-auto', { enabled: true });

    const getRes = await httpGet(port, '/api/settings/retro-auto');
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({ enabled: true });
  });

  it('PUT { enabled:false } → 200 { enabled:false } (heutiges Verhalten, Default)', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    await httpPut(port, '/api/settings/retro-auto', { enabled: true });
    const res = await httpPut(port, '/api/settings/retro-auto', { enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });

    const getRes = await httpGet(port, '/api/settings/retro-auto');
    expect(getRes.body.enabled).toBe(false);
  });

  it('PUT { enabled:"yes" } (Nicht-Boolean) → 400 { field: "enabled", message }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/retro-auto', { enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('enabled');
    expect(res.body.message).toBeDefined();
  });

  it('PUT: keine Teilspeicherung bei Validierungsfehler (alter Stand bleibt)', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    await httpPut(port, '/api/settings/retro-auto', { enabled: true });

    const badPut = await httpPut(port, '/api/settings/retro-auto', { enabled: 1 });
    expect(badPut.status).toBe(400);

    const getRes = await httpGet(port, '/api/settings/retro-auto');
    expect(getRes.body.enabled).toBe(true);
  });

  it('Response enthält ausschließlich `enabled` (keine Secrets/Zusatzfelder)', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpGet(port, '/api/settings/retro-auto');
    expect(Object.keys(res.body)).toEqual(['enabled']);
  });
});
