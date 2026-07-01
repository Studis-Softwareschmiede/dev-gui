/**
 * tickerSettings.test.js — Tests für TickerSettingsStore + ticker-Router (taktgeber-nachtwaechter S-194).
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC15 — Persistenz: Store-Roundtrip (write→read); ENOENT gibt Defaults zurück;
 *          Defaults korrekt (Settings-Schema-Tabelle); write ist atomar; Persistenz über
 *          Modul-Reload (simuliert Neustart). Validierung je Feld: window.start/end
 *          (HH:MM), window.timezone (gültige IANA-TZ), intervalMinutes ≥ 1, maxParallel
 *          (Klemmen 1–3, kein Reject bei out-of-range — Edge-Case Account-Überlast-Schutz),
 *          staleInProgressHours ≥ 1, escalationAttempts ≥ 1, projects "all" vs.
 *          Slug-Array (Format + Existenz gegen BoardAggregator-Index).
 *          GET/PUT /api/settings/ticker: 200 mit Defaults/gespeicherten Werten;
 *          PUT 200 bei gültiger Eingabe; PUT 400 bei ungültiger Eingabe mit
 *          { field, message }; keine Teilspeicherung bei Validierungsfehler;
 *          AccessGuard — nicht separat getestet, da global vor mountRouters() in
 *          server.js via `app.use('/api', accessGuard)` angewendet (nicht Bestandteil
 *          des einzelnen Router-Moduls, analog notifications.js/notificationSettings.js).
 *   AC16 — enabled=false wird unverändert gespeichert/gelesen (Roundtrip-Test); die
 *          Scheduler-Idle-Entscheidung selbst liegt bei S-195 (Nicht-Ziel dieser Story).
 *   AC17 — GET /api/settings/ticker/status (S-197, Statusanzeige Fabrik-Übersicht):
 *          200 { enabled, window, withinWindow, activeDrains }; activeDrains 0 ohne
 *          verdrahteten nightWatchScheduler (graceful degradation) und bei einem
 *          werfenden getStatus() (best-effort, kein Crash); activeDrains spiegelt
 *          nightWatchScheduler.getStatus().activeDrainProjectPaths.length; withinWindow
 *          spiegelt PUT-gespeicherte enabled/window-Werte (Roundtrip, Wiederverwendung
 *          isWithinWindow aus NightWatchScheduler.js — nicht separat re-getestet, s.
 *          NightWatchScheduler.test.js AC10).
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

// ── AC15: TickerSettingsStore Persistenz ─────────────────────────────────────

describe('AC15 — TickerSettingsStore Persistenz', () => {
  let tmpDir;
  let origCredStoreDir;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `ticker-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('gibt Defaults zurück wenn keine JSON-Datei existiert (ENOENT)', async () => {
    const { read } = await import('../src/TickerSettingsStore.js');
    const settings = await read();
    expect(settings.enabled).toBe(false);
    expect(settings.window).toEqual({ start: '23:00', end: '07:00', timezone: 'Europe/Zurich' });
    expect(settings.intervalMinutes).toBe(15);
    expect(settings.maxParallel).toBe(3);
    expect(settings.staleInProgressHours).toBe(4);
    expect(settings.escalationAttempts).toBe(3);
    expect(settings.projects).toBe('all');
  });

  it('write→read Roundtrip: gespeicherte Werte werden zurückgeliefert', async () => {
    const { read, write } = await import('../src/TickerSettingsStore.js');
    await write({
      enabled: true,
      window: { start: '22:00', end: '06:30', timezone: 'Europe/Berlin' },
      intervalMinutes: 10,
      maxParallel: 2,
      staleInProgressHours: 6,
      escalationAttempts: 5,
      projects: ['dev-gui', 'agent-flow'],
    });
    const result = await read();
    expect(result.enabled).toBe(true);
    expect(result.window).toEqual({ start: '22:00', end: '06:30', timezone: 'Europe/Berlin' });
    expect(result.intervalMinutes).toBe(10);
    expect(result.maxParallel).toBe(2);
    expect(result.staleInProgressHours).toBe(6);
    expect(result.escalationAttempts).toBe(5);
    expect(result.projects).toEqual(['dev-gui', 'agent-flow']);
  });

  it('write erstellt Datei in CRED_STORE_DIR', async () => {
    const { write } = await import('../src/TickerSettingsStore.js');
    await write({ enabled: false });
    const filePath = join(tmpDir, 'ticker-settings.json');
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.window.timezone).toBe('Europe/Zurich');
  });

  it('Persistenz über Modul-Reload (simuliert Neustart): Datei bleibt erhalten', async () => {
    const { write } = await import('../src/TickerSettingsStore.js');
    await write({ enabled: true, intervalMinutes: 20 });

    jest.resetModules();
    const { read: readAgain } = await import('../src/TickerSettingsStore.js');
    const reloaded = await readAgain();
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.intervalMinutes).toBe(20);
  });

  it('write ist ein Partial-Update (Merge mit aktuellem Stand statt Overwrite)', async () => {
    const { read, write } = await import('../src/TickerSettingsStore.js');
    await write({ enabled: true, intervalMinutes: 30 });
    await write({ maxParallel: 1 });
    const result = await read();
    expect(result.enabled).toBe(true);
    expect(result.intervalMinutes).toBe(30);
    expect(result.maxParallel).toBe(1);
  });

  it('gibt Fehler wenn CRED_STORE_DIR nicht gesetzt', async () => {
    delete process.env.CRED_STORE_DIR;
    jest.resetModules();
    const { write } = await import('../src/TickerSettingsStore.js');
    await expect(write({ enabled: false })).rejects.toThrow(/CRED_STORE_DIR/);
  });
});

// ── AC15: validate() Unit-Tests ───────────────────────────────────────────────

describe('AC15 — validate() Feldvalidierung', () => {
  let validate;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../src/TickerSettingsStore.js');
    validate = mod.validate;
  });

  afterEach(() => jest.resetModules());

  it('gültige Eingabe (vollständig) → { ok: true }', () => {
    const result = validate({
      enabled: true,
      window: { start: '23:00', end: '07:00', timezone: 'Europe/Zurich' },
      intervalMinutes: 15,
      maxParallel: 3,
      staleInProgressHours: 4,
      escalationAttempts: 3,
      projects: 'all',
    });
    expect(result.ok).toBe(true);
  });

  it('gültige Eingabe (leer/Partial) → { ok: true }', () => {
    expect(validate({}).ok).toBe(true);
  });

  it('enabled: kein Boolean → 400 field=enabled', () => {
    const result = validate({ enabled: 'yes' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('enabled');
  });

  it('window.start: ungültiges Format ("25:99") → 400 field=window.start', () => {
    const result = validate({ window: { start: '25:99' } });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('window.start');
  });

  it('window.start: ungültiges Format ("11pm") → 400 field=window.start', () => {
    const result = validate({ window: { start: '11pm' } });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('window.start');
  });

  it('window.end: ungültiges Format → 400 field=window.end', () => {
    const result = validate({ window: { end: '7:5' } });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('window.end');
  });

  it('window.start/end: gültiges HH:MM (inkl. Mitternacht-Grenzfälle "00:00"/"23:59") → ok', () => {
    expect(validate({ window: { start: '00:00', end: '23:59' } }).ok).toBe(true);
  });

  it('window.timezone: ungültige IANA-Zone → 400 field=window.timezone', () => {
    const result = validate({ window: { timezone: 'Not/AZone' } });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('window.timezone');
  });

  it('window.timezone: gültige IANA-Zone (Europe/Berlin) → ok', () => {
    expect(validate({ window: { timezone: 'Europe/Berlin' } }).ok).toBe(true);
  });

  it('window: kein Objekt (String) → 400 field=window', () => {
    const result = validate({ window: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('window');
  });

  it('intervalMinutes: 0 → 400 field=intervalMinutes', () => {
    const result = validate({ intervalMinutes: 0 });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('intervalMinutes');
  });

  it('intervalMinutes: negativ → 400 field=intervalMinutes', () => {
    const result = validate({ intervalMinutes: -5 });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('intervalMinutes');
  });

  it('intervalMinutes: nicht-ganzzahlig (1.5) → 400 field=intervalMinutes', () => {
    const result = validate({ intervalMinutes: 1.5 });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('intervalMinutes');
  });

  it('intervalMinutes: ≥ 1 → ok', () => {
    expect(validate({ intervalMinutes: 1 }).ok).toBe(true);
  });

  it('maxParallel: nicht-ganzzahlig (2.5) → 400 field=maxParallel', () => {
    const result = validate({ maxParallel: 2.5 });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('maxParallel');
  });

  it('maxParallel: außerhalb 1–3 (z.B. 0 oder 10) → ok bei validate() (Klemmen passiert beim Schreiben, kein Reject)', () => {
    expect(validate({ maxParallel: 0 }).ok).toBe(true);
    expect(validate({ maxParallel: 10 }).ok).toBe(true);
  });

  it('staleInProgressHours: 0 → 400 field=staleInProgressHours', () => {
    const result = validate({ staleInProgressHours: 0 });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('staleInProgressHours');
  });

  it('escalationAttempts: 0 → 400 field=escalationAttempts', () => {
    const result = validate({ escalationAttempts: 0 });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('escalationAttempts');
  });

  it('projects: "all" → ok', () => {
    expect(validate({ projects: 'all' }).ok).toBe(true);
  });

  it('projects: Array gültiger Slugs → ok', () => {
    expect(validate({ projects: ['dev-gui', 'agent-flow_2'] }).ok).toBe(true);
  });

  it('projects: kein Array und nicht "all" (String) → 400 field=projects', () => {
    const result = validate({ projects: 'some-string' });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('projects');
  });

  it('projects: ungültiger Slug (Leerzeichen/Sonderzeichen) → 400 field=projects', () => {
    const result = validate({ projects: ['dev gui!'] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('projects');
  });

  it('projects: unbekannter Slug gegen knownSlugs-Kontext → 400 field=projects', () => {
    const result = validate({ projects: ['dev-gui', 'unknown-project'] }, { knownSlugs: ['dev-gui', 'agent-flow'] });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('projects');
  });

  it('projects: bekannter Slug gegen knownSlugs-Kontext → ok', () => {
    const result = validate({ projects: ['dev-gui'] }, { knownSlugs: ['dev-gui', 'agent-flow'] });
    expect(result.ok).toBe(true);
  });

  it('projects: ohne knownSlugs-Kontext (BoardAggregator nicht verfügbar) → nur Format-Prüfung, kein Reject', () => {
    const result = validate({ projects: ['irgendein-slug'] });
    expect(result.ok).toBe(true);
  });
});

// ── AC15/AC16: ticker-Router HTTP-Tests ───────────────────────────────────────

describe('AC15/AC16 — GET/PUT /api/settings/ticker (HTTP-Ebene)', () => {
  let server;
  let port;
  let tmpDir;
  let origCredStoreDir;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `ticker-router-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
   * Baut eine Express-App mit dem ticker-Router.
   *
   * @param {{ knownSlugs?: string[] }} opts - Wenn gesetzt, wird ein boardAggregator-Stub
   *   mit `getIndex()` injiziert (analog `BoardAggregator.ProjectEntry[]`).
   */
  async function makeApp({ knownSlugs } = {}) {
    const { create } = await import('../src/routers/ticker.js');
    const boardAggregator = knownSlugs
      ? { getIndex: jest.fn(async () => knownSlugs.map((slug) => ({ slug, features: [] }))) }
      : undefined;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'test@example.com' }; next(); });
    app.use(create({ boardAggregator }));
    return app;
  }

  it('GET /api/settings/ticker → 200 mit Default-Settings', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpGet(port, '/api/settings/ticker');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.window).toEqual({ start: '23:00', end: '07:00', timezone: 'Europe/Zurich' });
    expect(res.body.intervalMinutes).toBe(15);
    expect(res.body.maxParallel).toBe(3);
    expect(res.body.staleInProgressHours).toBe(4);
    expect(res.body.escalationAttempts).toBe(3);
    expect(res.body.projects).toBe('all');
  });

  it('PUT /api/settings/ticker → 200 mit gespeicherten Werten', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', {
      enabled: true,
      window: { start: '22:30', end: '06:15', timezone: 'Europe/Berlin' },
      intervalMinutes: 5,
      maxParallel: 2,
      staleInProgressHours: 2,
      escalationAttempts: 4,
      projects: ['dev-gui'],
    });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.window).toEqual({ start: '22:30', end: '06:15', timezone: 'Europe/Berlin' });
    expect(res.body.intervalMinutes).toBe(5);
    expect(res.body.maxParallel).toBe(2);
    expect(res.body.projects).toEqual(['dev-gui']);
  });

  it('PUT → GET Roundtrip: gespeicherte Werte werden zurückgeliefert', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    await httpPut(port, '/api/settings/ticker', { enabled: true, intervalMinutes: 30 });

    const getRes = await httpGet(port, '/api/settings/ticker');
    expect(getRes.status).toBe(200);
    expect(getRes.body.enabled).toBe(true);
    expect(getRes.body.intervalMinutes).toBe(30);
  });

  it('AC16: PUT enabled=false → gespeichert/gelesen unverändert (Scheduler-Idle-Entscheidung liegt bei S-195)', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    await httpPut(port, '/api/settings/ticker', { enabled: false });
    const res = await httpGet(port, '/api/settings/ticker');
    expect(res.body.enabled).toBe(false);
  });

  it('PUT: maxParallel außerhalb 1–3 (10) → 200 geklemmt auf 3 (kein 400)', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', { maxParallel: 10 });
    expect(res.status).toBe(200);
    expect(res.body.maxParallel).toBe(3);
  });

  it('PUT: maxParallel außerhalb 1–3 (0) → 200 geklemmt auf 1 (kein 400)', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', { maxParallel: 0 });
    expect(res.status).toBe(200);
    expect(res.body.maxParallel).toBe(1);
  });

  it('PUT: ungültiges window.start → 400 { field: "window.start", message }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', { window: { start: 'not-a-time' } });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('window.start');
    expect(res.body.message).toBeDefined();
  });

  it('PUT: ungültige window.timezone → 400 { field: "window.timezone" }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', { window: { timezone: 'Not/AZone' } });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('window.timezone');
  });

  it('PUT: intervalMinutes < 1 → 400 { field: "intervalMinutes" }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', { intervalMinutes: 0 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('intervalMinutes');
  });

  it('PUT: staleInProgressHours < 1 → 400 { field: "staleInProgressHours" }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', { staleInProgressHours: 0 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('staleInProgressHours');
  });

  it('PUT: escalationAttempts < 1 → 400 { field: "escalationAttempts" }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', { escalationAttempts: 0 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('escalationAttempts');
  });

  it('PUT: projects weder "all" noch Array → 400 { field: "projects" }', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', { projects: 'not-all' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('projects');
  });

  it('PUT: projects mit unbekanntem Slug (BoardAggregator-Index injiziert) → 400 { field: "projects" }', async () => {
    const app = await makeApp({ knownSlugs: ['dev-gui', 'agent-flow'] });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', { projects: ['unknown-project'] });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('projects');
  });

  it('PUT: projects mit bekanntem Slug (BoardAggregator-Index injiziert) → 200', async () => {
    const app = await makeApp({ knownSlugs: ['dev-gui', 'agent-flow'] });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPut(port, '/api/settings/ticker', { projects: ['dev-gui'] });
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual(['dev-gui']);
  });

  it('PUT: keine Teilspeicherung bei Validierungsfehler (alter Stand bleibt)', async () => {
    const app = await makeApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    await httpPut(port, '/api/settings/ticker', { enabled: true, intervalMinutes: 20 });

    const badPut = await httpPut(port, '/api/settings/ticker', { intervalMinutes: -1 });
    expect(badPut.status).toBe(400);

    const getRes = await httpGet(port, '/api/settings/ticker');
    expect(getRes.body.enabled).toBe(true);
    expect(getRes.body.intervalMinutes).toBe(20);
  });
});

// ── AC17: ticker-Router GET /api/settings/ticker/status (HTTP-Ebene, S-197) ─────

describe('AC17 — GET /api/settings/ticker/status (HTTP-Ebene, S-197 Statusanzeige)', () => {
  let server;
  let port;
  let tmpDir;
  let origCredStoreDir;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `ticker-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
   * @param {{ nightWatchScheduler?: { getStatus: () => object } }} [opts]
   */
  async function makeStatusApp({ nightWatchScheduler } = {}) {
    const { create } = await import('../src/routers/ticker.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'test@example.com' }; next(); });
    app.use(create({ nightWatchScheduler }));
    return app;
  }

  it('enabled=false (Default) → { enabled:false, window, withinWindow, activeDrains:0 }', async () => {
    const app = await makeStatusApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpGet(port, '/api/settings/ticker/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.window).toEqual({ start: '23:00', end: '07:00', timezone: 'Europe/Zurich' });
    expect(typeof res.body.withinWindow).toBe('boolean');
    expect(res.body.activeDrains).toBe(0);
  });

  it('ohne nightWatchScheduler-Dep (nicht verdrahtet) → activeDrains 0 (graceful degradation), kein Crash', async () => {
    const app = await makeStatusApp({ nightWatchScheduler: undefined });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpGet(port, '/api/settings/ticker/status');
    expect(res.status).toBe(200);
    expect(res.body.activeDrains).toBe(0);
  });

  it('mit nightWatchScheduler-Dep → activeDrains spiegelt getStatus().activeDrainProjectPaths.length', async () => {
    const nightWatchScheduler = {
      getStatus: () => ({ activeDrainProjectPaths: ['/workspace/proj-a', '/workspace/proj-b'] }),
    };
    const app = await makeStatusApp({ nightWatchScheduler });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpGet(port, '/api/settings/ticker/status');
    expect(res.status).toBe(200);
    expect(res.body.activeDrains).toBe(2);
  });

  it('nightWatchScheduler.getStatus() wirft → activeDrains 0 (best-effort, kein Crash)', async () => {
    const nightWatchScheduler = { getStatus: () => { throw new Error('boom'); } };
    const app = await makeStatusApp({ nightWatchScheduler });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpGet(port, '/api/settings/ticker/status');
    expect(res.status).toBe(200);
    expect(res.body.activeDrains).toBe(0);
  });

  it('withinWindow spiegelt PUT-gespeicherte enabled/window-Werte (Roundtrip)', async () => {
    const app = await makeStatusApp();
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    // Ein Fenster, das die gesamte Wanduhr abdeckt (00:00–23:59) → immer im Fenster.
    await httpPut(port, '/api/settings/ticker', {
      enabled: true,
      window: { start: '00:00', end: '23:59', timezone: 'Europe/Zurich' },
    });

    const res = await httpGet(port, '/api/settings/ticker/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.withinWindow).toBe(true);
  });
});
