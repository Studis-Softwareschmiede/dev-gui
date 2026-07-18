/**
 * usageRouterAnthropicOAuthVault.test.js — GET /api/usage: Tresor-Token-Auflösung
 * + On-demand-Refresh (docs/specs/anthropic-oauth-vault.md).
 *
 * Covers (anthropic-oauth-vault): AC3 (Token-Auflösung Priorität: Tresor →
 * Env → Fallback), AC4 (abgelaufenes Tresor-Token wird NICHT direkt gesendet,
 * löst Refresh aus), AC5 (Refresh-Erfolg: Rückschreiben + Retry mit neuem
 * Token), AC6 (Refresh-Fehler nicht destruktiv, Fallback + secret-freier
 * Audit-Eintrag), AC7 (höchstens ein Refresh-Versuch je Request, kein Loop),
 * AC8 (kein Token-Klartext in Response/Audit auf irgendeinem Pfad), AC12
 * (Bestandsverhalten unverändert ohne Tresor-Tokens — separat in
 * usageRouter.test.js verifiziert, hier nicht dupliziert).
 *
 * Strategy: `TokenUsageMeter` gemockt (kein echtes Transcript-Verzeichnis
 * nötig); ein einziger `fetchFn`-Stub bedient sowohl den Usage- als auch den
 * Refresh-Aufruf (Unterscheidung per URL — wie in Produktion, wo beide
 * denselben globalen `fetch` nutzen); `credentialStore`/`auditStore` als
 * schlanke In-Memory-Test-Doubles injiziert. HTTP-/Router-Ebene (coder/R06):
 * jeder Test geht über einen echten `http`-Request bis zur fertigen Response.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { ANTHROPIC_OAUTH_TOKEN_HOST, ANTHROPIC_OAUTH_TOKEN_PATH } from '../src/AnthropicOAuthClient.js';
import { ANTHROPIC_USAGE_HOST, ANTHROPIC_USAGE_PATH } from '../src/AnthropicUsageClient.js';

jest.unstable_mockModule('../src/TokenUsageMeter.js', () => ({
  TokenUsageMeter: jest.fn().mockImplementation(() => ({
    getUsage: jest.fn(async () => ({ outputTokens: 999, filesScanned: 0, entriesCounted: 0 })),
  })),
}));

const USAGE_URL = `${ANTHROPIC_USAGE_HOST}${ANTHROPIC_USAGE_PATH}`;
const REFRESH_URL = `${ANTHROPIC_OAUTH_TOKEN_HOST}${ANTHROPIC_OAUTH_TOKEN_PATH}`;

async function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      http
        .get(`http://127.0.0.1:${port}${path}`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
          });
        })
        .on('error', (e) => {
          server.close();
          reject(e);
        });
    });
  });
}

function makeFetchResponse(status, body) {
  return { status, json: async () => body };
}

/** Baut ein Test-Double des CredentialStore mit In-Memory-Zustand + Aufruf-Spy. */
function makeFakeCredentialStore(initial) {
  let state = { accessToken: null, refreshToken: null, expiresAt: null, ...initial };
  const setCalls = [];
  return {
    async getAnthropicOAuthCredentials() {
      return { ...state };
    },
    async setAnthropicOAuthCredentials(tokens) {
      setCalls.push(tokens);
      state = { ...tokens };
      return { backup: { local: 'ok', offHost: 'disabled' } };
    },
    _setCalls: setCalls,
    _getState: () => state,
  };
}

function makeFakeAuditStore() {
  const entries = [];
  return {
    record({ identity, command }) {
      entries.push({ identity, command, time: new Date().toISOString() });
      return entries.at(-1);
    },
    getAll() {
      return [...entries];
    },
  };
}

const ORIGINAL_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
beforeEach(() => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});
afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIGINAL_TOKEN;
});

describe('GET /api/usage — Tresor-Token-Priorität (AC3)', () => {
  it('AC3 — gültiges Tresor-Token wird verwendet (Vorrang vor Env)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token-should-not-be-used';
    const credentialStore = makeFakeCredentialStore({
      accessToken: 'vault-access-token',
      refreshToken: 'vault-refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    let seenAuth;
    const fetchFn = async (url, init) => {
      if (url === USAGE_URL) {
        seenAuth = init.headers.Authorization;
        return makeFetchResponse(200, { five_hour: { utilization: 10, resets_at: 1737199200 } });
      }
      throw new Error(`unerwarteter Aufruf: ${url}`);
    };
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn, credentialStore }));
    const { status, body } = await get(app, '/api/usage');

    expect(status).toBe(200);
    expect(body.source).toBe('official');
    expect(seenAuth).toBe('Bearer vault-access-token');
  });

  it('AC3 — kein Tresor-Token gesetzt → Env-Token wird verwendet', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token-value';
    const credentialStore = makeFakeCredentialStore({});
    let seenAuth;
    const fetchFn = async (url, init) => {
      seenAuth = init.headers.Authorization;
      return makeFetchResponse(200, { five_hour: { utilization: 5, resets_at: 1737199200 } });
    };
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn, credentialStore }));
    const { status, body } = await get(app, '/api/usage');

    expect(status).toBe(200);
    expect(body.source).toBe('official');
    expect(seenAuth).toBe('Bearer env-token-value');
  });

  it('AC3/AC12 — weder Tresor noch Env-Token → estimated-Fallback', async () => {
    const credentialStore = makeFakeCredentialStore({});
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ credentialStore }));
    const { status, body } = await get(app, '/api/usage');

    expect(status).toBe(200);
    expect(body.source).toBe('estimated');
  });

  it('AC3 — kein credentialStore injiziert (Bestandsverhalten): Env-Token wird trotzdem verwendet', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-only-token';
    const fetchFn = async () => makeFetchResponse(200, { five_hour: { utilization: 1, resets_at: 1737199200 } });
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn }));
    const { status, body } = await get(app, '/api/usage');
    expect(status).toBe(200);
    expect(body.source).toBe('official');
  });
});

describe('GET /api/usage — Ablauf-Prüfung + On-demand-Refresh (AC4/AC5)', () => {
  it('AC4/AC5 — abgelaufenes Tresor-Token: kein Usage-Call mit dem alten Token, Refresh zuerst, dann Retry mit neuem Token', async () => {
    const credentialStore = makeFakeCredentialStore({
      accessToken: 'expired-access-token',
      refreshToken: 'valid-refresh-token',
      expiresAt: Date.now() - 1000, // bereits abgelaufen
    });
    const seenUsageAuths = [];
    const fetchFn = async (url, init) => {
      if (url === REFRESH_URL) {
        const body = JSON.parse(init.body);
        expect(body.refresh_token).toBe('valid-refresh-token');
        return makeFetchResponse(200, { access_token: 'refreshed-access-token', refresh_token: 'refreshed-refresh-token', expires_in: 3600 });
      }
      if (url === USAGE_URL) {
        seenUsageAuths.push(init.headers.Authorization);
        return makeFetchResponse(200, { five_hour: { utilization: 20, resets_at: 1737199200 } });
      }
      throw new Error(`unerwarteter Aufruf: ${url}`);
    };
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn, credentialStore }));
    const { status, body } = await get(app, '/api/usage');

    expect(status).toBe(200);
    expect(body.source).toBe('official');
    // AC4: der Usage-Endpunkt wurde NIE mit dem alten (abgelaufenen) Token aufgerufen
    expect(seenUsageAuths).toEqual(['Bearer refreshed-access-token']);
    // AC5: rotierte Werte wurden zurückgeschrieben
    expect(credentialStore._getState()).toEqual({
      accessToken: 'refreshed-access-token',
      refreshToken: 'refreshed-refresh-token',
      expiresAt: expect.any(Number),
    });
  });

  it('AC5 — Refresh-Erfolg wird atomar (ein einziger set-Aufruf) zurückgeschrieben', async () => {
    const credentialStore = makeFakeCredentialStore({
      accessToken: 'expired', refreshToken: 'rt', expiresAt: Date.now() - 1,
    });
    const fetchFn = async (url) => {
      if (url === REFRESH_URL) return makeFetchResponse(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 100 });
      return makeFetchResponse(200, { five_hour: { utilization: 1, resets_at: 1737199200 } });
    };
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn, credentialStore }));
    await get(app, '/api/usage');

    expect(credentialStore._setCalls.length).toBe(1);
  });

  it('AC5 — 401 auf ein noch nicht abgelaufenes Tresor-Token löst ebenfalls einen Refresh + Retry aus', async () => {
    const credentialStore = makeFakeCredentialStore({
      accessToken: 'stale-but-not-yet-expired',
      refreshToken: 'valid-refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    let usageCallCount = 0;
    const fetchFn = async (url, init) => {
      if (url === REFRESH_URL) {
        return makeFetchResponse(200, { access_token: 'retried-access-token', refresh_token: 'rotated-refresh', expires_in: 3600 });
      }
      usageCallCount += 1;
      if (usageCallCount === 1) {
        expect(init.headers.Authorization).toBe('Bearer stale-but-not-yet-expired');
        return makeFetchResponse(401, { error: 'invalid token' });
      }
      expect(init.headers.Authorization).toBe('Bearer retried-access-token');
      return makeFetchResponse(200, { five_hour: { utilization: 33, resets_at: 1737199200 } });
    };
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn, credentialStore }));
    const { status, body } = await get(app, '/api/usage');

    expect(status).toBe(200);
    expect(body.source).toBe('official');
    expect(usageCallCount).toBe(2);
  });
});

describe('GET /api/usage — Refresh-Fehler nicht destruktiv + Audit (AC6)', () => {
  it('AC6 — Refresh scheitert (HTTP-Fehler): Tresor-Eintrag unverändert, Fallback estimated, Audit ohne Token', async () => {
    const credentialStore = makeFakeCredentialStore({
      accessToken: 'expired-access', refreshToken: 'invalid-refresh-token-secret', expiresAt: Date.now() - 1,
    });
    const auditStore = makeFakeAuditStore();
    const fetchFn = async (url) => {
      if (url === REFRESH_URL) return makeFetchResponse(400, { error: 'invalid_grant' });
      throw new Error('Usage-Endpunkt hätte nicht aufgerufen werden dürfen (kein gültiges Token)');
    };
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn, credentialStore, auditStore }));
    const { status, body } = await get(app, '/api/usage');

    expect(status).toBe(200);
    expect(body.source).toBe('estimated');
    // Tresor unverändert (kein set-Aufruf)
    expect(credentialStore._setCalls.length).toBe(0);
    expect(credentialStore._getState().refreshToken).toBe('invalid-refresh-token-secret');
    // Audit-Eintrag ohne Token
    const entries = auditStore.getAll();
    expect(entries.some((e) => e.command.includes('anthropic-oauth'))).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('invalid-refresh-token-secret');
  });

  it('AC6 — Refresh scheitert, aber Env-Token verfügbar: Fallback liefert official über Env', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token-as-fallback';
    const credentialStore = makeFakeCredentialStore({
      accessToken: 'expired-access', refreshToken: 'bad-refresh', expiresAt: Date.now() - 1,
    });
    const fetchFn = async (url, init) => {
      if (url === REFRESH_URL) return makeFetchResponse(400, {});
      expect(init.headers.Authorization).toBe('Bearer env-token-as-fallback');
      return makeFetchResponse(200, { five_hour: { utilization: 7, resets_at: 1737199200 } });
    };
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn, credentialStore }));
    const { status, body } = await get(app, '/api/usage');

    expect(status).toBe(200);
    expect(body.source).toBe('official');
  });

  it('AC6 — kein refresh_token vorhanden, Token abgelaufen: kein Refresh-Versuch, direkt Fallback', async () => {
    const credentialStore = makeFakeCredentialStore({
      accessToken: 'expired-access', refreshToken: null, expiresAt: Date.now() - 1,
    });
    const fetchFn = async () => {
      throw new Error('kein Aufruf erwartet (weder Refresh noch Usage mit ungültigem Token)');
    };
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn, credentialStore }));
    const { status, body } = await get(app, '/api/usage');

    expect(status).toBe(200);
    expect(body.source).toBe('estimated');
  });
});

describe('GET /api/usage — kein Refresh-Loop (AC7)', () => {
  it('AC7 — Refresh liefert ein Token, das erneut 401 ergibt: genau EIN Refresh-Call, danach Fallback', async () => {
    const credentialStore = makeFakeCredentialStore({
      accessToken: 'stale-token', refreshToken: 'rt', expiresAt: Date.now() + 3600_000,
    });
    let refreshCallCount = 0;
    const fetchFn = async (url) => {
      if (url === REFRESH_URL) {
        refreshCallCount += 1;
        return makeFetchResponse(200, { access_token: 'still-rejected-token', refresh_token: 'rt2', expires_in: 3600 });
      }
      return makeFetchResponse(401, { error: 'invalid token' }); // Usage lehnt IMMER ab
    };
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn, credentialStore }));
    const { status, body } = await get(app, '/api/usage');

    expect(status).toBe(200);
    expect(body.source).toBe('estimated'); // Fallback, kein zweiter Refresh
    expect(refreshCallCount).toBe(1);
  });
});

describe('GET /api/usage — Secret-Disziplin über den Tresor-Pfad (AC8)', () => {
  it('AC8 — kein Token-Wert (Tresor oder Refresh) in Response oder Audit, auf keinem Pfad', async () => {
    const vaultSecret = 'vault-access-secret-must-never-leak';
    const refreshSecret = 'vault-refresh-secret-must-never-leak';
    const rotatedSecret = 'rotated-access-secret-must-never-leak';
    const credentialStore = makeFakeCredentialStore({
      accessToken: vaultSecret, refreshToken: refreshSecret, expiresAt: Date.now() - 1,
    });
    const auditStore = makeFakeAuditStore();
    const fetchFn = async (url) => {
      if (url === REFRESH_URL) return makeFetchResponse(200, { access_token: rotatedSecret, refresh_token: 'rotated-refresh-secret', expires_in: 10 });
      return makeFetchResponse(200, { five_hour: { utilization: 1, resets_at: 1737199200 } });
    };
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create({ fetchFn, credentialStore, auditStore }));
    const { body } = await get(app, '/api/usage');

    expect(JSON.stringify(body)).not.toContain(vaultSecret);
    expect(JSON.stringify(body)).not.toContain(refreshSecret);
    expect(JSON.stringify(body)).not.toContain(rotatedSecret);
    expect(JSON.stringify(auditStore.getAll())).not.toContain(vaultSecret);
    expect(JSON.stringify(auditStore.getAll())).not.toContain(refreshSecret);
    expect(JSON.stringify(auditStore.getAll())).not.toContain(rotatedSecret);
  });
});
