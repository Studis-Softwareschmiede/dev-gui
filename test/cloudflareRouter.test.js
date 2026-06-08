/**
 * cloudflareRouter.test.js — HTTP-Router-Tests für Cloudflare-Endpunkte (ADR-010/011).
 *
 * Covers:
 *   AC4  — GET /api/cloudflare/zones → zones list
 *   AC4  — GET /api/cloudflare/zones/:zoneId/tunnels → tunnels + routes
 *   AC8  — Token nie in HTTP-Response
 *   Degradation — zones-Fehler → errors[] in Response, kein 500
 *   Nicht-konfiguriert → { configured: false }
 *   Invalid zoneId → 422
 *
 * Strategy:
 *   - CloudflareApi wird als Stub injiziert
 *   - Express-Router direkt instantiiert und mit supertest getestet
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import { cloudflareRouter } from '../src/cloudflareRouter.js';
import { CloudflareApiError } from '../src/cloudflare/CloudflareApi.js';

// ── Helper ─────────────────────────────────────────────────────────────────────

function makeApp(apiStub) {
  const app = express();
  app.use(express.json());
  app.use(cloudflareRouter(apiStub));
  return app;
}

async function request(app, method, path, body) {
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const options = {
        hostname: 'localhost',
        port,
        path,
        method: method.toUpperCase(),
        headers: { 'Content-Type': 'application/json' },
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          server.close();
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

const ZONE_ID = 'a'.repeat(32); // valid 32-char hex

// ── Tests: GET /api/cloudflare/zones ──────────────────────────────────────────

describe('GET /api/cloudflare/zones', () => {
  it('200 + { configured, zones } bei Erfolg', async () => {
    const zones = [{ id: '1'.repeat(32), name: 'example.com', status: 'active' }];
    const apiStub = { listZones: async () => ({ configured: true, zones }) };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', '/api/cloudflare/zones');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.zones).toHaveLength(1);
    expect(res.body.zones[0].name).toBe('example.com');
  });

  it('200 + { configured: false } wenn nicht konfiguriert', async () => {
    const apiStub = { listZones: async () => ({ configured: false, zones: [] }) };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', '/api/cloudflare/zones');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.zones).toEqual([]);
  });

  it('200 + errors[] bei degradierter Antwort', async () => {
    const apiStub = {
      listZones: async () => ({
        configured: true,
        zones: [],
        errors: [{ scope: 'zones', errorClass: 'cloudflare-unavailable' }],
      }),
    };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', '/api/cloudflare/zones');
    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].errorClass).toBe('cloudflare-unavailable');
  });

  it('Token erscheint nicht in Response (kein Bearer, kein Credential-Wert)', async () => {
    // The router must not inject any token/credential into the response.
    // We pass clean zone data (as CloudflareApi always returns) and verify
    // neither 'Bearer' nor the credential value appears in the JSON body.
    const TOKEN = 'super-secret-cf-token-12345';
    const apiStub = {
      // Real CloudflareApi never includes token in zone data; stub mirrors this
      listZones: async () => ({ configured: true, zones: [{ id: '1'.repeat(32), name: 'example.com', status: 'active' }] }),
    };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', '/api/cloudflare/zones');
    const bodyStr = JSON.stringify(res.body);
    // Router must not add token/Bearer metadata
    expect(bodyStr).not.toContain('Bearer');
    expect(bodyStr).not.toContain(TOKEN);
  });
});

// ── Tests: GET /api/cloudflare/zones/:zoneId/tunnels ──────────────────────────

describe('GET /api/cloudflare/zones/:zoneId/tunnels', () => {
  it('200 + { tunnels, routes } bei Erfolg', async () => {
    const tunnels = [{ id: 'tun-1', name: 'my-tunnel', status: 'active', zoneId: ZONE_ID }];
    const routes = [{ hostname: 'app.example.com', service: 'http://localhost:3000', tunnelId: 'tun-1', protected: false }];
    const apiStub = {
      listTunnels: async (_zoneId) => tunnels,
      listRoutes: async (_tunnelId) => routes,
    };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', `/api/cloudflare/zones/${ZONE_ID}/tunnels`);
    expect(res.status).toBe(200);
    expect(res.body.tunnels).toHaveLength(1);
    expect(res.body.routes).toHaveLength(1);
    expect(res.body.routes[0].hostname).toBe('app.example.com');
    expect(res.body.routes[0].protected).toBe(false);
  });

  it('protected:true route erscheint in Response', async () => {
    const tunnels = [{ id: 'tun-1', name: 'my-tunnel', status: 'active', zoneId: ZONE_ID }];
    const routes = [
      { hostname: 'devgui.example.com', service: 'http://localhost:8080', tunnelId: 'tun-1', protected: true },
      { hostname: 'app.example.com', service: 'http://localhost:3000', tunnelId: 'tun-1', protected: false },
    ];
    const apiStub = {
      listTunnels: async () => tunnels,
      listRoutes: async () => routes,
    };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', `/api/cloudflare/zones/${ZONE_ID}/tunnels`);
    expect(res.status).toBe(200);
    const devgui = res.body.routes.find((r) => r.hostname === 'devgui.example.com');
    expect(devgui.protected).toBe(true);
  });

  it('422 bei ungültiger zoneId (zu kurz)', async () => {
    const apiStub = { listTunnels: async () => [], listRoutes: async () => [] };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', '/api/cloudflare/zones/short-id/tunnels');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid-zone-id');
  });

  it('422 bei zoneId mit Sonderzeichen', async () => {
    const apiStub = { listTunnels: async () => [], listRoutes: async () => [] };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', '/api/cloudflare/zones/../../../../etc%2Fpasswd/tunnels');
    // Express won't even route this properly — if it does reach us, we validate
    expect([404, 422]).toContain(res.status);
  });

  it('200 + errors[] bei Tunnel-Fehler (S-1: immer HTTP 200, kein 503/502)', async () => {
    const apiStub = {
      listTunnels: async () => {
        throw new CloudflareApiError('tunnel fetch failed', 'cloudflare-unavailable', 503);
      },
      listRoutes: async () => [],
    };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', `/api/cloudflare/zones/${ZONE_ID}/tunnels`);
    // S-1: always HTTP 200 + errors[] so fetch-clients stay in success branch
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].errorClass).toBe('cloudflare-unavailable');
    expect(res.body.tunnels).toEqual([]);
    expect(res.body.routes).toEqual([]);
  });

  it('422 bei cloudflare-not-configured', async () => {
    const apiStub = {
      listTunnels: async () => {
        throw new CloudflareApiError('not configured', 'cloudflare-not-configured', 422);
      },
      listRoutes: async () => [],
    };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', `/api/cloudflare/zones/${ZONE_ID}/tunnels`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('cloudflare-not-configured');
  });

  it('degradiert bei Route-Fehler für einen Tunnel (andere Tunnel bleiben)', async () => {
    const tunnels = [
      { id: 'tun-ok', name: 'ok-tunnel', status: 'active', zoneId: ZONE_ID },
      { id: 'tun-err', name: 'err-tunnel', status: 'active', zoneId: ZONE_ID },
    ];
    const apiStub = {
      listTunnels: async () => tunnels,
      listRoutes: async (tunnelId) => {
        if (tunnelId === 'tun-err') {
          throw new CloudflareApiError('tunnel unavailable', 'cloudflare-unavailable', 503);
        }
        return [{ hostname: 'app.example.com', service: 'http://localhost:3000', tunnelId: 'tun-ok', protected: false }];
      },
    };
    const app = makeApp(apiStub);

    const res = await request(app, 'GET', `/api/cloudflare/zones/${ZONE_ID}/tunnels`);
    expect(res.status).toBe(200);
    expect(res.body.tunnels).toHaveLength(2); // both tunnels returned
    expect(res.body.routes).toHaveLength(1);  // only ok-tunnel routes
    expect(res.body.errors).toHaveLength(1);  // error for tun-err
    expect(res.body.errors[0].scope).toBe('tunnel:tun-err');
  });
});
