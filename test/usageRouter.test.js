/**
 * usageRouter.test.js — GET /api/usage (Owner-Ko-Design 2026-07-03/05, "goldene Münze").
 *
 * Covers: liefert estimated:true + session/week-Output-Token-Zahlen aus dem
 * (gemockten) TokenUsageMeter; keine %/Reset-Zeit-Felder (bewusst nur Rohzahlen).
 *
 * @jest-environment node
 */
import { describe, it, expect, jest } from '@jest/globals';
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
        .on('error', (e) => { server.close(); reject(e); });
    });
  });
}

describe('GET /api/usage', () => {
  it('liefert estimated:true mit session- und week-Output-Tokens (keine %/Reset-Felder)', async () => {
    const { create } = await import('../src/routers/usage.js');
    const app = express();
    app.use(create());
    const { status, body } = await get(app, '/api/usage');
    expect(status).toBe(200);
    expect(body.estimated).toBe(true);
    expect(typeof body.session.outputTokens).toBe('number');
    expect(typeof body.week.outputTokens).toBe('number');
    expect(body.week.outputTokens).toBeGreaterThanOrEqual(body.session.outputTokens);
    expect(body).not.toHaveProperty('percent');
    expect(body).not.toHaveProperty('resetAt');
    expect(typeof body.generatedAt).toBe('string');
  });
});
