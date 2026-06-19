/**
 * notifyService.test.js — Tests für NotifyService (AC4) und
 * notificationSettings-Router (AC5 — POST /api/settings/notifications/test).
 *
 * Covers (push-notifications):
 *   AC4  — NotifyService sendet korrekten POST mit Title/Priority/Tags/Authorization-Header;
 *           Non-2xx → { ok: false } ohne throw;
 *           Netzfehler → { ok: false } ohne throw;
 *           Token wird NIE geloggt (Spy auf console.error prüft kein Token im Log-Text)
 *   AC5  — POST /api/settings/notifications/test: enabled + gültig → ruft Service, gibt ok;
 *           disabled → { ok: false, error } ohne Versand;
 *           leeres Topic → { ok: false, error } ohne Versand;
 *           Response enthält NIE den Token-Klartext;
 *           kein Versand wenn topic fehlt (AC5 Spec-Vertrag)
 *   AC10 — Token erscheint in keiner Response-Body-Eigenschaft;
 *           Token erscheint nicht in strukturierten Log-Ausgaben
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import { createServer, request as httpRequest } from 'node:http';

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

function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
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

// ── Mock fetch ────────────────────────────────────────────────────────────────

/**
 * Erstellt einen fetch-Mock, der sofort mit einem konfigurierbaren Ergebnis antwortet.
 *
 * @param {{ status?: number, ok?: boolean, text?: string }} opts
 * @returns {jest.Mock}
 */
function makeFetchMock({ status = 200, ok = true, text = '' } = {}) {
  return jest.fn(async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => text,
  }));
}

// ── AC4: NotifyService Unit-Tests ─────────────────────────────────────────────

describe('AC4 — NotifyService.sendNotification', () => {
  let originalFetch;
  let consoleSpy;

  beforeEach(() => {
    originalFetch = global.fetch;
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleSpy.mockRestore();
  });

  it('sendet POST an <server>/<topic> mit korrekter URL', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const { sendNotification } = await import('../src/NotifyService.js');
    await sendNotification(
      { server: 'https://ntfy.sh', topic: 'my-topic' },
      { title: 'Test', message: 'Hello' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ntfy.sh/my-topic');
  });

  it('sendet POST (Methode)', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const { sendNotification } = await import('../src/NotifyService.js');
    await sendNotification(
      { server: 'https://ntfy.sh', topic: 'topic' },
      { title: 'T', message: 'M' },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
  });

  it('setzt Title-Header korrekt', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const { sendNotification } = await import('../src/NotifyService.js');
    await sendNotification(
      { server: 'https://ntfy.sh', topic: 'topic' },
      { title: 'Mein Titel', message: 'body' },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Title']).toBe('Mein Titel');
  });

  it('setzt Priority-Header wenn config.priority angegeben', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const { sendNotification } = await import('../src/NotifyService.js');
    await sendNotification(
      { server: 'https://ntfy.sh', topic: 'topic', priority: 4 },
      { title: 'T', message: 'M' },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Priority']).toBe('4');
  });

  it('setzt Tags-Header wenn payload.tags angegeben', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const { sendNotification } = await import('../src/NotifyService.js');
    await sendNotification(
      { server: 'https://ntfy.sh', topic: 'topic' },
      { title: 'T', message: 'M', tags: ['tada', 'warning'] },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Tags']).toBe('tada,warning');
  });

  it('setzt Authorization-Header wenn token vorhanden', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const { sendNotification } = await import('../src/NotifyService.js');
    const SECRET_TOKEN = 'tk_secret_value_1234';
    await sendNotification(
      { server: 'https://ntfy.sh', topic: 'topic', token: SECRET_TOKEN },
      { title: 'T', message: 'M' },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
  });

  it('setzt KEINEN Authorization-Header wenn kein Token', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const { sendNotification } = await import('../src/NotifyService.js');
    await sendNotification(
      { server: 'https://ntfy.sh', topic: 'topic', token: null },
      { title: 'T', message: 'M' },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Authorization']).toBeUndefined();
  });

  it('gibt { ok: true, status: 200 } bei Erfolg zurück', async () => {
    global.fetch = makeFetchMock({ status: 200, ok: true });

    const { sendNotification } = await import('../src/NotifyService.js');
    const result = await sendNotification(
      { server: 'https://ntfy.sh', topic: 'topic' },
      { title: 'T', message: 'M' },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('AC4: Non-2xx → { ok: false } ohne throw', async () => {
    global.fetch = makeFetchMock({ status: 403, ok: false, text: 'Forbidden' });

    const { sendNotification } = await import('../src/NotifyService.js');
    let threw = false;
    let result;
    try {
      result = await sendNotification(
        { server: 'https://ntfy.sh', topic: 'topic' },
        { title: 'T', message: 'M' },
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toBeDefined();
  });

  it('AC4: Netzfehler → { ok: false } ohne throw', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network error');
    });

    const { sendNotification } = await import('../src/NotifyService.js');
    let threw = false;
    let result;
    try {
      result = await sendNotification(
        { server: 'https://ntfy.sh', topic: 'topic' },
        { title: 'T', message: 'M' },
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('AC10: Token erscheint NICHT im Log bei Non-2xx', async () => {
    global.fetch = makeFetchMock({ status: 401, ok: false, text: 'Unauthorized' });

    const SECRET_TOKEN = 'SECRET_NTFY_TOKEN_9876';
    const { sendNotification } = await import('../src/NotifyService.js');
    await sendNotification(
      { server: 'https://ntfy.sh', topic: 'topic', token: SECRET_TOKEN },
      { title: 'T', message: 'M' },
    );

    // Alle console.error-Aufrufe prüfen — Token darf dort nicht auftauchen
    for (const call of consoleSpy.mock.calls) {
      const logText = call.map((a) => String(a)).join(' ');
      expect(logText).not.toContain(SECRET_TOKEN);
    }
  });

  it('AC10: Token erscheint NICHT im Log bei Netzfehler', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('connection refused');
    });

    const SECRET_TOKEN = 'SECRET_TOKEN_CONN_ERR';
    const { sendNotification } = await import('../src/NotifyService.js');
    await sendNotification(
      { server: 'https://ntfy.sh', topic: 'topic', token: SECRET_TOKEN },
      { title: 'T', message: 'M' },
    );

    for (const call of consoleSpy.mock.calls) {
      const logText = call.map((a) => String(a)).join(' ');
      expect(logText).not.toContain(SECRET_TOKEN);
    }
  });

  it('normalisiert server trailing slash korrekt', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const { sendNotification } = await import('../src/NotifyService.js');
    await sendNotification(
      { server: 'https://ntfy.sh/', topic: 'my-topic' },
      { title: 'T', message: 'M' },
    );

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ntfy.sh/my-topic');
  });
});

// ── AC5: notificationSettings Router HTTP-Tests ───────────────────────────────

describe('AC5 — POST /api/settings/notifications/test (HTTP-Ebene)', () => {
  let server;
  let port;
  let fetchSpy;
  let originalFetch;

  beforeEach(async () => {
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    global.fetch = originalFetch;
    jest.resetModules();
  });

  /**
   * Hilfsfunktion: baut eine Express-App mit dem notificationSettings-Router.
   *
   * @param {object} opts
   * @param {object} opts.config - Notification-Config die getNotificationConfig liefert
   * @param {string|null} opts.token - Token den credentialStore.getPlaintext() liefert
   * @returns {import('express').Application}
   */
  async function makeApp({ config, token = null }) {
    const { create } = await import('../src/routers/notificationSettings.js');

    const credentialStore = {
      getPlaintext: jest.fn(async () => token),
    };

    const getNotificationConfig = jest.fn(async () => config);

    const app = express();
    app.use(express.json());
    // Simuliere identity-Middleware (AccessGuard setzt req.identity)
    app.use((req, _res, next) => {
      req.identity = { email: 'admin@example.com' };
      next();
    });
    app.use(create({ credentialStore, getNotificationConfig }));
    return app;
  }

  it('AC5: enabled + gültiges Topic → 200 { ok: true } wenn ntfy antwortet', async () => {
    global.fetch = makeFetchMock({ status: 200, ok: true });

    const app = await makeApp({
      config: { enabled: true, server: 'https://ntfy.sh', topic: 'my-topic', events: [] },
      token: null,
    });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPost(port, '/api/settings/notifications/test', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('AC5: disabled (enabled=false) → 200 { ok: false, error } ohne fetch-Aufruf', async () => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const app = await makeApp({
      config: { enabled: false, server: 'https://ntfy.sh', topic: 'my-topic', events: [] },
    });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPost(port, '/api/settings/notifications/test', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AC5: leeres Topic → 200 { ok: false, error } ohne fetch-Aufruf', async () => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const app = await makeApp({
      config: { enabled: true, server: 'https://ntfy.sh', topic: '', events: [] },
    });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPost(port, '/api/settings/notifications/test', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AC5: Topic nur Whitespace → 200 { ok: false, error } ohne fetch-Aufruf', async () => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const app = await makeApp({
      config: { enabled: true, server: 'https://ntfy.sh', topic: '   ', events: [] },
    });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPost(port, '/api/settings/notifications/test', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AC5: ntfy antwortet Non-2xx → 200 { ok: false, error, status }', async () => {
    global.fetch = makeFetchMock({ status: 429, ok: false, text: 'Rate limit' });

    const app = await makeApp({
      config: { enabled: true, server: 'https://ntfy.sh', topic: 'my-topic', events: [] },
    });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPost(port, '/api/settings/notifications/test', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(429);
    expect(res.body.error).toBeDefined();
  });

  it('AC5: ntfy Netzfehler → 200 { ok: false, error }', async () => {
    global.fetch = jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); });

    const app = await makeApp({
      config: { enabled: true, server: 'https://ntfy.example.com', topic: 'topic', events: [] },
    });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPost(port, '/api/settings/notifications/test', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeDefined();
  });

  it('AC10: Response enthält NICHT den Token-Klartext', async () => {
    global.fetch = makeFetchMock({ status: 200, ok: true });
    const SECRET_TOKEN = 'SECRET_RESPONSE_LEAK_CHECK_TOKEN';

    const app = await makeApp({
      config: { enabled: true, server: 'https://ntfy.sh', topic: 'my-topic', events: [] },
      token: SECRET_TOKEN,
    });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPost(port, '/api/settings/notifications/test', {});
    // Token darf in keinem Body-Feld erscheinen
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(SECRET_TOKEN);
  });

  it('AC10: Response enthält NICHT den Token auch bei Fehlerantwort (Non-2xx)', async () => {
    global.fetch = makeFetchMock({ status: 401, ok: false, text: 'Unauthorized' });
    const SECRET_TOKEN = 'SECRET_ERROR_RESPONSE_TOKEN';

    const app = await makeApp({
      config: { enabled: true, server: 'https://ntfy.sh', topic: 'topic', events: [] },
      token: SECRET_TOKEN,
    });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPost(port, '/api/settings/notifications/test', {});
    expect(res.body.ok).toBe(false);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(SECRET_TOKEN);
  });

  it('AC5: Token wird aus credentialStore bezogen und an fetch weitergegeben', async () => {
    fetchSpy = makeFetchMock({ status: 200, ok: true });
    global.fetch = fetchSpy;
    const SECRET_TOKEN = 'tk_passed_to_fetch';

    const app = await makeApp({
      config: { enabled: true, server: 'https://ntfy.sh', topic: 'my-topic', events: [] },
      token: SECRET_TOKEN,
    });
    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPost(port, '/api/settings/notifications/test', {});
    expect(res.body.ok).toBe(true);
    // fetch wurde mit Authorization-Header aufgerufen
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    // Aber: Response enthält den Token NICHT
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(SECRET_TOKEN);
  });

  it('AC5: Default-Provider (kein getNotificationConfig injiziert) → disabled → { ok: false }', async () => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const { create } = await import('../src/routers/notificationSettings.js');
    const credentialStore = { getPlaintext: jest.fn(async () => null) };

    // KEIN getNotificationConfig → Default-Provider greift (disabled)
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'test@x.com' }; next(); });
    app.use(create({ credentialStore }));

    const s = await startServer(app);
    server = s.server;
    port = s.port;

    const res = await httpPost(port, '/api/settings/notifications/test', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    // Default-Provider → disabled
    expect(res.body.error).toMatch(/deaktiviert|disabled/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
