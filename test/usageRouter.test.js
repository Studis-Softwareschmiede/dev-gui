/**
 * usageRouter.test.js — GET /api/usage (Owner-Ko-Design 2026-07-03/05, "goldene
 * Münze"; offizieller Primärpfad ADR-022, docs/specs/usage-official-values.md).
 *
 * Covers (usage-official-values): AC1 (official-Erfolgspfad HTTP-Ebene),
 * AC5 (Fallback estimated bei fehlendem Token/HTTP-Fehler/Netzfehler),
 * AC6 (unavailable, wenn auch der Meter-Fallback scheitert), AC7 (Müll-Payload
 * degradiert auf estimated statt zu crashen), AC8 (kein Token im Antwort-Body,
 * auch nicht im Fallback-/Fehlerpfad), AC9 (TokenUsageMeter bleibt Fallback-
 * Zulieferer, unverändertes estimated-Verhalten).
 *
 * Strategy: `TokenUsageMeter` wird gemockt (kein echtes Transcript-Verzeichnis
 * nötig); der Anthropic-Upstream-Aufruf wird über den injizierbaren `fetchFn`
 * der Router-Factory gestubbt (kein echter HTTP-Call) — HTTP-/Router-Ebene
 * (coder/R06): jeder Test geht über einen echten `http`-Request bis zur
 * fertigen Response (Status + Body-Shape).
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import http from 'node:http';

jest.unstable_mockModule('../src/TokenUsageMeter.js', () => ({
  TokenUsageMeter: jest.fn().mockImplementation(() => ({
    getUsage: jest.fn(async ({ sinceMs }) => {
      const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
      return { outputTokens: sinceMs <= fiveHoursAgo - 1000 ? 500000 : 12345, filesScanned: 3, entriesCounted: 10 };
    }),
  })),
}));

/** GET-Helfer: startet einen ephemeren Server, ruft den Pfad ab, liefert Status+Body. */
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

const ORIGINAL_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

beforeEach(() => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIGINAL_TOKEN;
});

describe('GET /api/usage', () => {
  it('AC5/AC9 — ohne CLAUDE_CODE_OAUTH_TOKEN: source estimated mit Meter-Rohzahlen (heutiges Verhalten)', async () => {
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create());
    const { status, body } = await get(app, '/api/usage');
    expect(status).toBe(200);
    expect(body.source).toBe('estimated');
    expect(typeof body.session.outputTokens).toBe('number');
    expect(typeof body.week.outputTokens).toBe('number');
    expect(body.week.outputTokens).toBeGreaterThanOrEqual(body.session.outputTokens);
    expect(body).not.toHaveProperty('percent');
    expect(body).not.toHaveProperty('resetAt');
    expect(typeof body.generatedAt).toBe('string');
  });

  it('AC1 — mit Token + validem Upstream-Payload: source official mit session/week', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test-token-never-in-output';
    const { create } = await import('../src/routers/usage.js');
    const fetchFn = async () =>
      makeFetchResponse(200, {
        five_hour: { utilization: 42, resets_at: 1737199200 },
        seven_day: { utilization: 55, resets_at: 1737800000 },
        seven_day_opus: { utilization: 5, resets_at: 1737800000 },
      });
    const app = express();
    app.use(create({ fetchFn }));
    const { status, body } = await get(app, '/api/usage');
    expect(status).toBe(200);
    expect(body.source).toBe('official');
    expect(body.session.percentUsed).toBe(42);
    expect(body.week.allModels.percentUsed).toBe(55);
    expect(body.week.perModel).toEqual([{ model: 'opus', percentUsed: 5, resetAt: expect.any(String) }]);
  });

  it('AC5 — Token gesetzt, aber Upstream liefert 401: fällt auf estimated zurück', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test-token-never-in-output';
    const { create } = await import('../src/routers/usage.js');
    const fetchFn = async () => makeFetchResponse(401, { error: 'invalid token' });
    const app = express();
    app.use(create({ fetchFn }));
    const { status, body } = await get(app, '/api/usage');
    expect(status).toBe(200);
    expect(body.source).toBe('estimated');
  });

  it('AC5 — Token gesetzt, Upstream-Netzfehler/Timeout: fällt auf estimated zurück', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test-token-never-in-output';
    const { create } = await import('../src/routers/usage.js');
    const fetchFn = async () => {
      const err = new Error('timeout');
      err.name = 'AbortError';
      throw err;
    };
    const app = express();
    app.use(create({ fetchFn }));
    const { status, body } = await get(app, '/api/usage');
    expect(status).toBe(200);
    expect(body.source).toBe('estimated');
  });

  it('AC7 — Upstream liefert Müll-Struktur: Route crasht nicht, fällt auf estimated zurück', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test-token-never-in-output';
    const { create } = await import('../src/routers/usage.js');
    const fetchFn = async () => makeFetchResponse(200, { unexpected: 'garbage', nested: { a: [1, 2, 3] } });
    const app = express();
    app.use(create({ fetchFn }));
    const { status, body } = await get(app, '/api/usage');
    expect(status).toBe(200);
    expect(body.source).toBe('estimated');
  });

  it('AC6 — auch der Meter-Fallback scheitert: source unavailable, keine erfundenen Zahlen', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../src/TokenUsageMeter.js', () => ({
      TokenUsageMeter: jest.fn().mockImplementation(() => ({
        getUsage: jest.fn(async () => {
          throw new Error('boom');
        }),
      })),
    }));
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create());
    const { status, body } = await get(app, '/api/usage');
    expect(status).toBe(200);
    expect(body.source).toBe('unavailable');
    expect(body).not.toHaveProperty('session');
    expect(body).not.toHaveProperty('week');
    expect(body).not.toHaveProperty('percent');
    expect(typeof body.generatedAt).toBe('string');
  });

  it('AC8 — der Token-Wert erscheint in keinem Antwort-Body (official, estimated oder unavailable)', async () => {
    const secret = 'sk-ant-oat-super-secret-value-must-never-leak';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = secret;
    const { create } = await import('../src/routers/usage.js');

    const fetchFnOfficial = async () =>
      makeFetchResponse(200, { five_hour: { utilization: 1, resets_at: 1737199200 } });
    const appOfficial = express();
    appOfficial.use(create({ fetchFn: fetchFnOfficial }));
    const official = await get(appOfficial, '/api/usage');
    expect(JSON.stringify(official.body)).not.toContain(secret);

    const fetchFnFail = async () => makeFetchResponse(401, {});
    const appFallback = express();
    appFallback.use(create({ fetchFn: fetchFnFail }));
    const fallback = await get(appFallback, '/api/usage');
    expect(JSON.stringify(fallback.body)).not.toContain(secret);
  });
});
