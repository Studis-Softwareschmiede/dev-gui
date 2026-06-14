/**
 * credentialStatusRouter.test.js — Tests für credential-bootstrap-status (Item #184, AC1–AC7)
 *
 * Covers:
 *   AC1 — GET /api/settings/credential-status → 200 { state, hasEncryptedEntries }; niemals Schlüssel/Klartext
 *   AC2 — kein Key + keine verschlüsselten Entries → state "locked", hasEncryptedEntries false
 *   AC3 — Key geladen → state "unlocked"
 *   AC4 — verschlüsselte Entries vorhanden + entsperrt → hasEncryptedEntries true; sonst false
 *   AC5 — nach Laufzeit-Unlock wechselt erneuter Abruf von locked → unlocked ohne Neustart
 *   AC6 — hinter AccessGuard (kein gültiger Access → 403); im gesperrten Zustand erreichbar
 *          (AccessGuard-Verdrahtung: per server.js-Inspektion, kein separater Middleware-Test;
 *           locked-erreichbar via DEV_NO_ACCESS-Bypass, da der Endpoint KEIN Master-Key-Gate hat)
 *   AC7 — kein Geheimnis-Leak in Response/Log/Audit
 *
 * Strategy:
 *   - credentialStatusRouter: HTTP-Integration via Express + AccessGuard-Dev-Bypass.
 *   - Fake-CredentialStore mit steuerbarer getLockState()-Implementierung (kein echtes FS).
 *   - AC5: getLockState() wird live aufgerufen — simuliere Zustandswechsel durch Mutation des Fake.
 *   - AC6/403: ohne DEV_NO_ACCESS=1 und ohne Token → 403 (AccessGuard fail-closed).
 *   - AC7: keine der Shape-Felder enthält schlüssel-artige Inhalte; Antwort-Shape geprüft.
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { credentialStatusRouter } from '../src/credentialStatusRouter.js';
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

function httpGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
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
    req.end();
  });
}

// ── App builder ───────────────────────────────────────────────────────────────

function makeApp(credentialStore) {
  const app = express();
  app.use(express.json());
  const guard = createAccessGuard();
  app.use('/api', guard);
  app.use(credentialStatusRouter(credentialStore));
  return app;
}

// ── Fake CredentialStore ──────────────────────────────────────────────────────

/**
 * Erstellt einen kontrollierbaren Fake-CredentialStore mit steuerbarem getLockState().
 * @param {{ state: "locked"|"unlocked", hasEncryptedEntries: boolean }} initial
 */
function makeFakeCredStore(initial) {
  let currentState = { ...initial };
  return {
    async getLockState() {
      return { ...currentState };
    },
    // Simuliert einen Laufzeit-Unlock (AC5)
    _simulateUnlock() {
      currentState = { state: 'unlocked', hasEncryptedEntries: currentState.hasEncryptedEntries };
    },
    // Erlaubt das Setzen beliebiger Zustände für Tests
    _setState(s) {
      currentState = { ...s };
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/settings/credential-status — AC1: Response-Shape + kein Geheimnis-Leak', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC1 — liefert 200', async () => {
    const res = await httpGet(port, '/api/settings/credential-status');
    expect(res.status).toBe(200);
  });

  it('AC1 — Response enthält genau die Felder state und hasEncryptedEntries', async () => {
    const res = await httpGet(port, '/api/settings/credential-status');
    expect(res.body).toHaveProperty('state');
    expect(res.body).toHaveProperty('hasEncryptedEntries');
  });

  it('AC1/AC7 — Response enthält KEINE weiteren Felder (kein Schlüssel/Klartext-Leak)', async () => {
    const res = await httpGet(port, '/api/settings/credential-status');
    const keys = Object.keys(res.body);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('state');
    expect(keys).toContain('hasEncryptedEntries');
    // Explizit: keine Felder wie key, masterKey, secret, token, password, plaintext
    expect(keys).not.toContain('key');
    expect(keys).not.toContain('masterKey');
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('token');
    expect(keys).not.toContain('password');
    expect(keys).not.toContain('plaintext');
  });

  it('AC1 — state ist "locked" oder "unlocked" (valider Enum-Wert)', async () => {
    const res = await httpGet(port, '/api/settings/credential-status');
    expect(['locked', 'unlocked']).toContain(res.body.state);
  });

  it('AC1 — hasEncryptedEntries ist boolean', async () => {
    const res = await httpGet(port, '/api/settings/credential-status');
    expect(typeof res.body.hasEncryptedEntries).toBe('boolean');
  });
});

describe('GET /api/settings/credential-status — AC2: gesperrt + kein Store', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC2 — kein Key + keine Entries → state "locked", hasEncryptedEntries false', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    const res = await httpGet(port, '/api/settings/credential-status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('locked');
    expect(res.body.hasEncryptedEntries).toBe(false);
  });

  it('AC2 — Dienst läuft (kein Fail-Fast) — Endpunkt ist erreichbar ohne Key', async () => {
    // Verifikation: der Endpunkt antwortet; der Dienst ist gestartet und akzeptiert Requests
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    const res = await httpGet(port, '/api/settings/credential-status');
    // Kein 500/503 → Dienst läuft ohne Fail-Fast
    expect(res.status).toBeLessThan(500);
  });
});

describe('GET /api/settings/credential-status — AC3: Key geladen → unlocked', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC3 — Key aus Env/Boot geladen → state "unlocked"', async () => {
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    const res = await httpGet(port, '/api/settings/credential-status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('unlocked');
  });

  it('AC3 — Key nach Laufzeit-Unlock geladen → state "unlocked"', async () => {
    // Simuliert: nach einem unlock() ist getLockState() = unlocked
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    const res = await httpGet(port, '/api/settings/credential-status');
    expect(res.body.state).toBe('unlocked');
  });
});

describe('GET /api/settings/credential-status — AC4: hasEncryptedEntries-Varianten', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC4 — Entries vorhanden + entsperrt → hasEncryptedEntries true', async () => {
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: true });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    const res = await httpGet(port, '/api/settings/credential-status');
    expect(res.status).toBe(200);
    expect(res.body.hasEncryptedEntries).toBe(true);
  });

  it('AC4 — keine Entries → hasEncryptedEntries false (unlocked)', async () => {
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    const res = await httpGet(port, '/api/settings/credential-status');
    expect(res.status).toBe(200);
    expect(res.body.hasEncryptedEntries).toBe(false);
  });

  it('AC4 — gesperrt + keine Entries → hasEncryptedEntries false', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    const res = await httpGet(port, '/api/settings/credential-status');
    expect(res.status).toBe(200);
    expect(res.body.hasEncryptedEntries).toBe(false);
  });

  it('AC4 — gesperrt + verschlüsselte Entries vorhanden → hasEncryptedEntries true', async () => {
    // Edge-Case: locked + hasEncryptedEntries (wäre Fail-Fast beim Boot — aber getLockState() kann es melden)
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: true });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    const res = await httpGet(port, '/api/settings/credential-status');
    expect(res.status).toBe(200);
    expect(res.body.hasEncryptedEntries).toBe(true);
  });
});

describe('GET /api/settings/credential-status — AC5: locked→unlocked nach Laufzeit-Unlock ohne Neustart', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC5 — erster Abruf: locked; nach Unlock: unlocked (kein Neustart)', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    // Erster Abruf: locked
    const res1 = await httpGet(port, '/api/settings/credential-status');
    expect(res1.status).toBe(200);
    expect(res1.body.state).toBe('locked');

    // Laufzeit-Unlock simulieren (ohne Prozess-Neustart)
    credStore._simulateUnlock();

    // Zweiter Abruf: unlocked (live, kein Neustart)
    const res2 = await httpGet(port, '/api/settings/credential-status');
    expect(res2.status).toBe(200);
    expect(res2.body.state).toBe('unlocked');
  });

  it('AC5 — Abruf direkt nach Zustandsänderung spiegelt den neuen Zustand wider', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: true });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    // Nach Unlock: state wechselt
    credStore._simulateUnlock();

    const res = await httpGet(port, '/api/settings/credential-status');
    expect(res.body.state).toBe('unlocked');
    expect(res.body.hasEncryptedEntries).toBe(true); // hasEncryptedEntries bleibt true
  });
});

describe('GET /api/settings/credential-status — AC6: AccessGuard + locked erreichbar', () => {
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;
  });

  it('AC6 — kein gültiger Access (kein DEV_NO_ACCESS, kein Token) → 403', async () => {
    delete process.env.DEV_NO_ACCESS;
    const savedDomain = process.env.ACCESS_TEAM_DOMAIN;
    const savedAud = process.env.ACCESS_AUD;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;

    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    const { server, port } = await startServer(app);
    try {
      const res = await httpGet(port, '/api/settings/credential-status');
      expect(res.status).toBe(403);
    } finally {
      await closeServer(server);
      if (savedDomain !== undefined) process.env.ACCESS_TEAM_DOMAIN = savedDomain;
      if (savedAud !== undefined) process.env.ACCESS_AUD = savedAud;
    }
  });

  it('AC6 — im gesperrten Zustand erreichbar (DEV_NO_ACCESS=1 → kein Master-Key-Gate)', async () => {
    // Der Endpunkt hat KEIN Master-Key-Voraussetzungs-Gate → auch im locked-Zustand erreichbar
    process.env.DEV_NO_ACCESS = '1';
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    const { server, port } = await startServer(app);
    try {
      const res = await httpGet(port, '/api/settings/credential-status');
      // Muss erreichbar sein (kein 403, kein 500) — 200 im locked-Zustand
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('locked');
    } finally {
      await closeServer(server);
    }
  });

});

describe('GET /api/settings/credential-status — AC7: kein Geheimnis-Leak in Response', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC7 — Response enthält keine Felder mit schlüssel-artigen Namen', async () => {
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: true });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    const res = await httpGet(port, '/api/settings/credential-status');
    const body = res.body;
    const forbidden = ['key', 'masterKey', 'master_key', 'secret', 'token', 'password', 'plaintext', 'rawKey', 'ciphertext'];
    for (const f of forbidden) {
      expect(body).not.toHaveProperty(f);
    }
  });

  it('AC7 — Response-Werte sind ausschliesslich state-String und boolean (kein Schlüssel)', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const app = makeApp(credStore);
    ({ server, port } = await startServer(app));

    const res = await httpGet(port, '/api/settings/credential-status');
    // state muss "locked" oder "unlocked" sein (kein Schlüssel-Wert)
    expect(res.body.state).toMatch(/^(locked|unlocked)$/);
    // hasEncryptedEntries muss boolean sein
    expect(typeof res.body.hasEncryptedEntries).toBe('boolean');
    // Keine weiteren Felder
    expect(Object.keys(res.body)).toHaveLength(2);
  });

  it('AC7 — Store-Fehler → 500 ohne Secret-Leak (generische Fehlermeldung + kein Secret im Log)', async () => {
    const secretValue = 'secret123';
    const brokenStore = {
      async getLockState() {
        throw new Error(`CRED_MASTER_KEY=${secretValue} — interner Fehler`);
      },
    };

    // Log-Kanal überwachen: kein Secret darf in console.error oder console.warn erscheinen
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const app = makeApp(brokenStore);
    const { server, port } = await startServer(app);
    try {
      const res = await httpGet(port, '/api/settings/credential-status');
      expect(res.status).toBe(500);

      // Response enthält kein Secret
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain(secretValue);
      expect(bodyStr).not.toContain('CRED_MASTER_KEY=');

      // Log-Kanal: kein console.error/warn-Aufruf enthält den Secret-Wert
      for (const call of errorSpy.mock.calls) {
        const logLine = call.map(String).join(' ');
        expect(logLine).not.toContain(secretValue);
      }
      for (const call of warnSpy.mock.calls) {
        const logLine = call.map(String).join(' ');
        expect(logLine).not.toContain(secretValue);
      }
    } finally {
      await closeServer(server);
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
