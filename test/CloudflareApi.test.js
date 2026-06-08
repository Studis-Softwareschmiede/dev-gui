/**
 * CloudflareApi.test.js — Unit-Tests für CloudflareApi (ADR-010).
 *
 * Covers:
 *   AC4  — listZones/listTunnels/listRoutes: Zonen/Tunnel/Routen-Read + Normalisierung
 *   AC8  — Token store-intern & kein Leak in Log/Response
 *   Degradation — pro Zone degradierend (ein Zonen-Fehler kippt nicht Gesamtantwort)
 *   Nicht-konfiguriert — kein Token → kein API-Call, configured:false
 *   AbortController-Timeout-Pfad — timeout erzeugt cloudflare-unavailable
 *   Auth-Fehler — 401/403 → cloudflare-auth-failed ohne Token-Leak
 *   LockoutGuard-Integration — protected flag auf CfRoute
 *
 * Strategy:
 *   - CredentialStore wird als Stub injiziert
 *   - fetch wird als Stub injiziert (kein echter HTTP-Call)
 *   - LockoutGuard wird als Stub injiziert für isProtected-Tests
 */

import { describe, it, expect } from '@jest/globals';
import { CloudflareApi, CloudflareApiError } from '../src/cloudflare/CloudflareApi.js';

const MOCK_TOKEN = 'cf-api-test-token-never-in-output';
const MOCK_ACCOUNT_ID = 'acc-test-1234567890abcdef';

// ── Mock-Bausteine ─────────────────────────────────────────────────────────────

function makeCredentialStore({ token = null, accountId = null } = {}) {
  return {
    async getPlaintext(key) {
      if (key === 'credentials/cloudflare/api_token') return token;
      if (key === 'credentials/cloudflare/account_id') return accountId;
      return null;
    },
  };
}

function makeConfiguredStore() {
  return makeCredentialStore({ token: MOCK_TOKEN, accountId: MOCK_ACCOUNT_ID });
}

/** Builds a fetch stub that returns the given JSON response */
function makeFetch(statusOrMap, body) {
  if (typeof statusOrMap === 'function') {
    // statusOrMap is a handler function (url, init) => { status, body }
    return async (url, init) => {
      const result = await statusOrMap(url, init);
      return makeFetchResponse(result.status ?? 200, result.body ?? {});
    };
  }
  const status = statusOrMap;
  return async (_url, _init) => makeFetchResponse(status, body);
}

function makeFetchResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function makeTimeoutFetch() {
  return async (_url, _init) => {
    const err = new Error('timeout');
    err.name = 'AbortError';
    throw err;
  };
}

function makeNetworkErrorFetch() {
  return async (_url, _init) => {
    throw new Error('fetch failed');
  };
}

// Raw Cloudflare API responses
const RAW_ZONE = {
  id: 'abc123def456abc123def456abc123de',
  name: 'example.com',
  status: 'active',
};

const RAW_TUNNEL = {
  id: 'tunnel-id-0000000000000001',
  name: 'my-tunnel',
  status: 'active',
};

const RAW_TUNNEL_CONFIG_RESPONSE = {
  success: true,
  result: {
    config: {
      ingress: [
        { hostname: 'app.example.com', service: 'http://localhost:3000' },
        { hostname: 'api.example.com', service: 'http://localhost:8080' },
        { hostname: '', service: 'http_status:404' }, // catch-all — should be excluded
      ],
    },
  },
};

// ── Tests: Not-configured ──────────────────────────────────────────────────────

describe('CloudflareApi — not configured (kein Token)', () => {
  it('listZones() gibt { configured: false, zones: [] } zurück ohne API-Call', async () => {
    const calls = [];
    const api = new CloudflareApi({
      credentialStore: makeCredentialStore({}),
      fetchFn: async (url) => { calls.push(url); return makeFetchResponse(200, {}); },
    });

    const result = await api.listZones();
    expect(result.configured).toBe(false);
    expect(result.zones).toEqual([]);
    expect(calls).toHaveLength(0); // no API call
  });

  it('listZones() gibt { configured: false } wenn nur Token fehlt', async () => {
    const calls = [];
    const api = new CloudflareApi({
      credentialStore: makeCredentialStore({ accountId: MOCK_ACCOUNT_ID }),
      fetchFn: async (url) => { calls.push(url); return makeFetchResponse(200, {}); },
    });

    const result = await api.listZones();
    expect(result.configured).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('listTunnels() wirft cloudflare-not-configured wenn nicht konfiguriert', async () => {
    const api = new CloudflareApi({
      credentialStore: makeCredentialStore({}),
    });

    await expect(api.listTunnels('zoneid')).rejects.toMatchObject({
      errorClass: 'cloudflare-not-configured',
      httpStatus: 422,
    });
  });

  it('listRoutes() wirft cloudflare-not-configured wenn nicht konfiguriert', async () => {
    const api = new CloudflareApi({
      credentialStore: makeCredentialStore({}),
    });

    await expect(api.listRoutes('tunnelid')).rejects.toMatchObject({
      errorClass: 'cloudflare-not-configured',
    });
  });
});

// ── Tests: listZones() ─────────────────────────────────────────────────────────

describe('CloudflareApi — listZones()', () => {
  it('listet Zonen und normalisiert auf CfZone', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(200, { success: true, result: [RAW_ZONE] }),
    });

    const result = await api.listZones();
    expect(result.configured).toBe(true);
    expect(result.zones).toHaveLength(1);
    expect(result.zones[0]).toMatchObject({
      id: RAW_ZONE.id,
      name: RAW_ZONE.name,
      status: RAW_ZONE.status,
    });
    expect(result.errors).toBeUndefined();
  });

  it('gibt leere Zonen zurück wenn Cloudflare keine liefert', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(200, { success: true, result: [] }),
    });

    const result = await api.listZones();
    expect(result.configured).toBe(true);
    expect(result.zones).toEqual([]);
  });

  it('degradiert mit errors[] bei API-Fehler statt 500', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(503, { success: false }),
    });

    const result = await api.listZones();
    expect(result.configured).toBe(true);
    expect(result.zones).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ scope: 'zones', errorClass: 'cloudflare-unavailable' });
  });

  it('Token erscheint nicht in listZones-Response', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(200, { success: true, result: [RAW_ZONE] }),
    });

    const result = await api.listZones();
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(MOCK_TOKEN);
    expect(resultStr).not.toContain(MOCK_ACCOUNT_ID);
  });
});

// ── Tests: listZones() — Token in Headers, nie in URL ──────────────────────────

describe('CloudflareApi — Token-Placement (security/R01)', () => {
  it('Token geht in Authorization-Header, nie in URL', async () => {
    const capturedRequests = [];
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: async (url, init) => {
        capturedRequests.push({ url, headers: init?.headers });
        return makeFetchResponse(200, { success: true, result: [] });
      },
    });

    await api.listZones();

    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];

    // Token must be in Authorization header
    expect(req.headers?.Authorization).toBe(`Bearer ${MOCK_TOKEN}`);

    // Token must NOT appear in URL
    expect(req.url).not.toContain(MOCK_TOKEN);
    expect(req.url).not.toContain(MOCK_ACCOUNT_ID);
  });
});

// ── Tests: listTunnels() ───────────────────────────────────────────────────────

describe('CloudflareApi — listTunnels()', () => {
  it('listet Tunnel und normalisiert auf CfTunnel', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(200, { success: true, result: [RAW_TUNNEL] }),
    });

    const tunnels = await api.listTunnels('zone-test-id');
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0]).toMatchObject({
      id: RAW_TUNNEL.id,
      name: RAW_TUNNEL.name,
      status: RAW_TUNNEL.status,
      zoneId: 'zone-test-id',
    });
  });

  it('gibt leere Liste zurück wenn keine Tunnel', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(200, { success: true, result: [] }),
    });

    const tunnels = await api.listTunnels('zone-test-id');
    expect(tunnels).toEqual([]);
  });

  it('wirft cloudflare-auth-failed bei 401', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(401, {}),
    });

    await expect(api.listTunnels('zone-test-id')).rejects.toMatchObject({
      errorClass: 'cloudflare-auth-failed',
      httpStatus: 502,
    });
  });

  it('wirft cloudflare-auth-failed bei 403', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(403, {}),
    });

    await expect(api.listTunnels('zone-test-id')).rejects.toMatchObject({
      errorClass: 'cloudflare-auth-failed',
    });
  });

  it('Token erscheint nicht in Fehler-Message bei Auth-Fehler', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(401, {}),
    });

    try {
      await api.listTunnels('zone-test-id');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });
});

// ── Tests: listRoutes() ───────────────────────────────────────────────────────

describe('CloudflareApi — listRoutes()', () => {
  it('listet Routen und normalisiert auf CfRoute', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(200, RAW_TUNNEL_CONFIG_RESPONSE),
      lockoutGuard: { isProtected: () => false },
    });

    const routes = await api.listRoutes('tunnel-id-001');
    // catch-all (empty hostname) should be excluded
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      hostname: 'app.example.com',
      service: 'http://localhost:3000',
      tunnelId: 'tunnel-id-001',
      protected: false,
    });
    expect(routes[1]).toMatchObject({
      hostname: 'api.example.com',
      service: 'http://localhost:8080',
      tunnelId: 'tunnel-id-001',
      protected: false,
    });
  });

  it('setzt protected:true via LockoutGuard für geschützte Hostnames', async () => {
    // Stub LockoutGuard: first route is protected, second is not
    let callCount = 0;
    const stubGuard = {
      isProtected: (_hostname) => {
        callCount++;
        return callCount === 1; // first call = protected
      },
    };

    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(200, RAW_TUNNEL_CONFIG_RESPONSE),
      lockoutGuard: stubGuard,
    });

    const routes = await api.listRoutes('tunnel-id-001');
    expect(routes[0].protected).toBe(true);
    expect(routes[1].protected).toBe(false);
  });

  it('schließt catch-all Eintrag (leerer hostname) aus', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(200, RAW_TUNNEL_CONFIG_RESPONSE),
      lockoutGuard: { isProtected: () => false },
    });

    const routes = await api.listRoutes('tunnel-id-001');
    const catchAll = routes.find((r) => r.hostname === '');
    expect(catchAll).toBeUndefined();
  });

  it('gibt leere Liste zurück wenn keine Ingress-Regeln', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(200, {
        success: true,
        result: { config: { ingress: [] } },
      }),
      lockoutGuard: { isProtected: () => false },
    });

    const routes = await api.listRoutes('tunnel-id-001');
    expect(routes).toEqual([]);
  });

  it('gibt leere Liste zurück wenn keine Ingress-Konfiguration', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeFetch(200, { success: true, result: {} }),
      lockoutGuard: { isProtected: () => false },
    });

    const routes = await api.listRoutes('tunnel-id-001');
    expect(routes).toEqual([]);
  });
});

// ── Tests: AbortController-Timeout ────────────────────────────────────────────

describe('CloudflareApi — AbortController-Timeout', () => {
  it('listZones() → cloudflare-unavailable bei Timeout (abort)', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeTimeoutFetch(),
    });

    const result = await api.listZones();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].errorClass).toBe('cloudflare-unavailable');
  });

  it('listTunnels() wirft cloudflare-unavailable bei Netzwerk-Fehler', async () => {
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: makeNetworkErrorFetch(),
    });

    await expect(api.listTunnels('zone-id')).rejects.toMatchObject({
      errorClass: 'cloudflare-unavailable',
    });
  });
});

// ── Tests: Pagination (I-1) ───────────────────────────────────────────────────

describe('CloudflareApi — Pagination (I-1)', () => {
  it('listZones() aggregiert alle Seiten bei mehrseitiger Antwort', async () => {
    const zone1 = { id: 'aaa' + '0'.repeat(29), name: 'page1.com', status: 'active' };
    const zone2 = { id: 'bbb' + '0'.repeat(29), name: 'page2.com', status: 'active' };

    let callCount = 0;
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: async (_url, _init) => {
        callCount++;
        if (callCount === 1) {
          return makeFetchResponse(200, {
            success: true,
            result: [zone1],
            result_info: { page: 1, per_page: 50, total_pages: 2, count: 1, total_count: 2 },
          });
        }
        return makeFetchResponse(200, {
          success: true,
          result: [zone2],
          result_info: { page: 2, per_page: 50, total_pages: 2, count: 1, total_count: 2 },
        });
      },
    });

    const result = await api.listZones();
    expect(result.configured).toBe(true);
    expect(result.zones).toHaveLength(2);
    expect(result.zones[0].name).toBe('page1.com');
    expect(result.zones[1].name).toBe('page2.com');
    expect(callCount).toBe(2);
  });

  it('listZones() hält bei total_pages=1 nach einer Seite an', async () => {
    let callCount = 0;
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: async (_url, _init) => {
        callCount++;
        return makeFetchResponse(200, {
          success: true,
          result: [RAW_ZONE],
          result_info: { page: 1, per_page: 50, total_pages: 1, count: 1, total_count: 1 },
        });
      },
    });

    const result = await api.listZones();
    expect(result.zones).toHaveLength(1);
    expect(callCount).toBe(1);
  });

  it('listZones() respektiert Safety-Cap (max 20 Seiten)', async () => {
    let callCount = 0;
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: async (_url, _init) => {
        callCount++;
        return makeFetchResponse(200, {
          success: true,
          result: [RAW_ZONE],
          result_info: { page: callCount, per_page: 50, total_pages: 9999, count: 1, total_count: 9999 },
        });
      },
    });

    const result = await api.listZones();
    // Must not exceed 20 pages (PAGINATION_MAX_PAGES)
    expect(callCount).toBeLessThanOrEqual(20);
    expect(result.zones).toHaveLength(callCount); // one zone per page
  });

  it('listTunnels() aggregiert alle Seiten bei mehrseitiger Antwort', async () => {
    const tunnel1 = { id: 'tun-page1', name: 'tunnel-1', status: 'active' };
    const tunnel2 = { id: 'tun-page2', name: 'tunnel-2', status: 'active' };

    let callCount = 0;
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: async (_url, _init) => {
        callCount++;
        if (callCount === 1) {
          return makeFetchResponse(200, {
            success: true,
            result: [tunnel1],
            result_info: { page: 1, per_page: 50, total_pages: 2, count: 1, total_count: 2 },
          });
        }
        return makeFetchResponse(200, {
          success: true,
          result: [tunnel2],
          result_info: { page: 2, per_page: 50, total_pages: 2, count: 1, total_count: 2 },
        });
      },
    });

    const tunnels = await api.listTunnels('zone-test-id');
    expect(tunnels).toHaveLength(2);
    expect(tunnels[0].id).toBe('tun-page1');
    expect(tunnels[1].id).toBe('tun-page2');
    expect(callCount).toBe(2);
  });

  it('listTunnels() respektiert Safety-Cap (max 20 Seiten)', async () => {
    let callCount = 0;
    const api = new CloudflareApi({
      credentialStore: makeConfiguredStore(),
      fetchFn: async (_url, _init) => {
        callCount++;
        return makeFetchResponse(200, {
          success: true,
          result: [RAW_TUNNEL],
          result_info: { page: callCount, per_page: 50, total_pages: 9999, count: 1, total_count: 9999 },
        });
      },
    });

    const tunnels = await api.listTunnels('zone-test-id');
    expect(callCount).toBeLessThanOrEqual(20);
    expect(tunnels).toHaveLength(callCount);
  });
});

// ── Tests: CloudflareApiError ──────────────────────────────────────────────────

describe('CloudflareApiError', () => {
  it('hat name, errorClass und httpStatus', () => {
    const err = new CloudflareApiError('test message', 'cloudflare-unavailable', 503);
    expect(err.name).toBe('CloudflareApiError');
    expect(err.errorClass).toBe('cloudflare-unavailable');
    expect(err.httpStatus).toBe(503);
    expect(err.message).toBe('test message');
    expect(err instanceof Error).toBe(true);
  });
});

// ── Tests: isProtected (delegiert an LockoutGuard) ──────────────────────────────

describe('CloudflareApi — isProtected()', () => {
  it('delegiert an LockoutGuard', () => {
    let checked = null;
    const stubGuard = { isProtected: (t) => { checked = t; return true; } };
    const api = new CloudflareApi({ lockoutGuard: stubGuard });

    const result = api.isProtected('devgui.example.com');
    expect(result).toBe(true);
    expect(checked).toBe('devgui.example.com');
  });
});
