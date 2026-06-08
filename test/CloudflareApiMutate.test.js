/**
 * CloudflareApiMutate.test.js — Tests für CloudflareApi-Mutate-Methoden (ADR-010/012).
 *
 * Covers:
 *   addRoute       — Adds/replaces a route in tunnel ingress config (LockoutGuard-Check)
 *   removeRoute    — Removes a route from tunnel ingress config (LockoutGuard-Check)
 *   createDnsRecord — Creates a DNS CNAME record (LockoutGuard-Check)
 *   deleteDnsRecord — Deletes a DNS record by hostname lookup + DELETE
 *   deleteTunnel   — Deletes a tunnel
 *   #apiDelete success:false guard — Cloudflare HTTP 200 + { success: false } must throw
 *   LockoutGuard   — protected target → CloudflareApiError(protected-resource) before API call
 *   not-configured — missing token/accountId → CloudflareApiError(cloudflare-not-configured)
 */

import { describe, it, expect } from '@jest/globals';
import { CloudflareApi } from '../src/cloudflare/CloudflareApi.js';
import { LockoutGuard } from '../src/cloudflare/LockoutGuard.js';

// ── Mock helpers ───────────────────────────────────────────────────────────────

const MOCK_TOKEN = 'cf-test-token-never-in-output';
const MOCK_ACCOUNT_ID = 'acc-test-1234567890abcdef';
const TUNNEL_ID = 'tunnel-test-id-12345678901234';
const ZONE_ID = 'zone-test-abcdef1234567890abcdef12';

function makeCredentialStore({ token = MOCK_TOKEN, accountId = MOCK_ACCOUNT_ID } = {}) {
  return {
    async getPlaintext(key) {
      if (key === 'credentials/cloudflare/api_token') return token;
      if (key === 'credentials/cloudflare/account_id') return accountId;
      return null;
    },
  };
}

function makeUnconfiguredStore() {
  return makeCredentialStore({ token: null, accountId: null });
}

function makeFetchResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** Build a CloudflareApi with a fetch stub that intercepts calls. */
function makeApi({
  fetchFn,
  lockoutGuard,
  configured = true,
} = {}) {
  return new CloudflareApi({
    credentialStore: configured ? makeCredentialStore() : makeUnconfiguredStore(),
    lockoutGuard: lockoutGuard ?? new LockoutGuard({ devguiHostname: 'devgui.example.com' }),
    fetchFn: fetchFn ?? (async () => makeFetchResponse(200, { success: true, result: {} })),
  });
}

// Existing ingress config response (GET .../configurations)
const EXISTING_INGRESS_RESPONSE = {
  success: true,
  result: {
    config: {
      ingress: [
        { hostname: 'existing.example.com', service: 'http://localhost:3000' },
        { hostname: '', service: 'http_status:404' }, // catch-all
      ],
    },
  },
};

const PUT_SUCCESS_RESPONSE = { success: true, result: { config: { ingress: [] } } };
const DNS_LIST_RESPONSE = {
  success: true,
  result: [{ id: 'dns-record-id-123', name: 'app.example.com', type: 'CNAME' }],
};
const DELETE_SUCCESS_RESPONSE = { success: true, result: { id: TUNNEL_ID } };

// ── addRoute ──────────────────────────────────────────────────────────────────

describe('CloudflareApi — addRoute()', () => {
  it('fetches current config (GET), then PUTs updated ingress', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if ((init?.method ?? 'GET') === 'GET') return makeFetchResponse(200, EXISTING_INGRESS_RESPONSE);
      return makeFetchResponse(200, PUT_SUCCESS_RESPONSE);
    };
    const api = makeApi({ fetchFn });
    await api.addRoute(TUNNEL_ID, 'new.example.com', 'http://localhost:8080');

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => c.method === 'GET')).toBe(true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('new route is prepended before existing routes in PUT body', async () => {
    let putBody;
    const fetchFn = async (_url, init) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        putBody = JSON.parse(init.body);
        return makeFetchResponse(200, PUT_SUCCESS_RESPONSE);
      }
      return makeFetchResponse(200, EXISTING_INGRESS_RESPONSE);
    };
    const api = makeApi({ fetchFn });
    await api.addRoute(TUNNEL_ID, 'new.example.com', 'http://localhost:8082');

    expect(putBody.config.ingress[0].hostname).toBe('new.example.com');
    expect(putBody.config.ingress[0].service).toBe('http://localhost:8082');
  });

  it('replaces existing rule for same hostname (idempotent)', async () => {
    let putBody;
    const existingWithSame = {
      success: true,
      result: {
        config: {
          ingress: [
            { hostname: 'app.example.com', service: 'http://localhost:3000' }, // old rule
            { hostname: '', service: 'http_status:404' },
          ],
        },
      },
    };
    const fetchFn = async (_url, init) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        putBody = JSON.parse(init.body);
        return makeFetchResponse(200, PUT_SUCCESS_RESPONSE);
      }
      return makeFetchResponse(200, existingWithSame);
    };
    const api = makeApi({ fetchFn });
    await api.addRoute(TUNNEL_ID, 'app.example.com', 'http://localhost:8080');

    // Only one rule for app.example.com
    const rules = putBody.config.ingress.filter((r) => r.hostname === 'app.example.com');
    expect(rules).toHaveLength(1);
    expect(rules[0].service).toBe('http://localhost:8080'); // updated
  });

  it('protected hostname → throws CloudflareApiError(protected-resource) without API call', async () => {
    const calls = [];
    const api = makeApi({
      fetchFn: async (url, _init) => { calls.push(url); return makeFetchResponse(200, {}); },
      lockoutGuard: new LockoutGuard({ devguiHostname: 'devgui.example.com' }),
    });

    await expect(api.addRoute(TUNNEL_ID, 'devgui.example.com', 'http://localhost:8080'))
      .rejects.toMatchObject({ errorClass: 'protected-resource' });
    expect(calls).toHaveLength(0);
  });

  it('not configured → throws cloudflare-not-configured without API call', async () => {
    const calls = [];
    const api = makeApi({
      configured: false,
      fetchFn: async (url) => { calls.push(url); return makeFetchResponse(200, {}); },
    });

    await expect(api.addRoute(TUNNEL_ID, 'app.example.com', 'http://localhost:8080'))
      .rejects.toMatchObject({ errorClass: 'cloudflare-not-configured' });
    expect(calls).toHaveLength(0);
  });

  it('Token does not appear in thrown error message', async () => {
    const api = makeApi({
      fetchFn: async () => makeFetchResponse(401, {}),
    });

    let thrown;
    try {
      await api.addRoute(TUNNEL_ID, 'app.example.com', 'http://localhost:8080');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).not.toContain(MOCK_TOKEN);
  });
});

// ── removeRoute ───────────────────────────────────────────────────────────────

describe('CloudflareApi — removeRoute()', () => {
  it('fetches current config (GET), removes hostname, PUTs result', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if ((init?.method ?? 'GET') === 'GET') return makeFetchResponse(200, EXISTING_INGRESS_RESPONSE);
      return makeFetchResponse(200, PUT_SUCCESS_RESPONSE);
    };
    const api = makeApi({ fetchFn });
    await api.removeRoute(TUNNEL_ID, 'existing.example.com');

    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('removed hostname is absent from PUT body', async () => {
    let putBody;
    const fetchFn = async (_url, init) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        putBody = JSON.parse(init.body);
        return makeFetchResponse(200, PUT_SUCCESS_RESPONSE);
      }
      return makeFetchResponse(200, EXISTING_INGRESS_RESPONSE);
    };
    const api = makeApi({ fetchFn });
    await api.removeRoute(TUNNEL_ID, 'existing.example.com');

    const remainingHostnames = putBody.config.ingress.map((r) => r.hostname);
    expect(remainingHostnames).not.toContain('existing.example.com');
  });

  it('keeps catch-all rule in PUT body', async () => {
    let putBody;
    const fetchFn = async (_url, init) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        putBody = JSON.parse(init.body);
        return makeFetchResponse(200, PUT_SUCCESS_RESPONSE);
      }
      return makeFetchResponse(200, EXISTING_INGRESS_RESPONSE);
    };
    const api = makeApi({ fetchFn });
    await api.removeRoute(TUNNEL_ID, 'existing.example.com');

    // Catch-all (empty hostname) must be present
    expect(putBody.config.ingress.some((r) => !r.hostname || r.hostname === '')).toBe(true);
  });

  it('protected hostname → throws protected-resource without API call', async () => {
    const calls = [];
    const api = makeApi({
      fetchFn: async (url) => { calls.push(url); return makeFetchResponse(200, {}); },
      lockoutGuard: new LockoutGuard({ devguiHostname: 'devgui.example.com' }),
    });

    await expect(api.removeRoute(TUNNEL_ID, 'devgui.example.com'))
      .rejects.toMatchObject({ errorClass: 'protected-resource' });
    expect(calls).toHaveLength(0);
  });
});

// ── createDnsRecord ───────────────────────────────────────────────────────────

describe('CloudflareApi — createDnsRecord()', () => {
  it('POSTs a CNAME record to zones DNS endpoint', async () => {
    let postBody;
    let postedUrl;
    const fetchFn = async (url, init) => {
      if (init?.method === 'POST') {
        postedUrl = url;
        postBody = JSON.parse(init.body);
        return makeFetchResponse(200, { success: true, result: { id: 'dns-id-new' } });
      }
      return makeFetchResponse(200, { success: true, result: {} });
    };
    const api = makeApi({ fetchFn });
    await api.createDnsRecord(ZONE_ID, 'app.example.com', TUNNEL_ID);

    expect(postedUrl).toContain(ZONE_ID);
    expect(postedUrl).toContain('dns_records');
    expect(postBody.type).toBe('CNAME');
    expect(postBody.name).toBe('app.example.com');
    expect(postBody.content).toContain(TUNNEL_ID);
    expect(postBody.proxied).toBe(true);
  });

  it('protected hostname → throws protected-resource', async () => {
    const api = makeApi({
      lockoutGuard: new LockoutGuard({ devguiHostname: 'devgui.example.com' }),
    });

    await expect(api.createDnsRecord(ZONE_ID, 'devgui.example.com', TUNNEL_ID))
      .rejects.toMatchObject({ errorClass: 'protected-resource' });
  });

  it('token not in error on auth failure', async () => {
    const api = makeApi({ fetchFn: async () => makeFetchResponse(401, {}) });
    let thrown;
    try { await api.createDnsRecord(ZONE_ID, 'app.example.com', TUNNEL_ID); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(thrown.message).not.toContain(MOCK_TOKEN);
  });
});

// ── deleteDnsRecord ───────────────────────────────────────────────────────────

describe('CloudflareApi — deleteDnsRecord()', () => {
  it('lists records first, then DELETEs each matching record', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (method === 'DELETE') return makeFetchResponse(200, DELETE_SUCCESS_RESPONSE);
      return makeFetchResponse(200, DNS_LIST_RESPONSE);
    };
    const api = makeApi({ fetchFn });
    await api.deleteDnsRecord(ZONE_ID, 'app.example.com');

    expect(calls.some((c) => c.method === 'GET')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    const deleteCall = calls.find((c) => c.method === 'DELETE');
    expect(deleteCall.url).toContain('dns-record-id-123');
  });

  it('no records found → no DELETE call (idempotent)', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ method: init?.method ?? 'GET' });
      return makeFetchResponse(200, { success: true, result: [] }); // empty list
    };
    const api = makeApi({ fetchFn });
    await api.deleteDnsRecord(ZONE_ID, 'nonexistent.example.com');

    expect(calls.every((c) => c.method !== 'DELETE')).toBe(true);
  });

  it('protected hostname → throws protected-resource', async () => {
    const api = makeApi({
      lockoutGuard: new LockoutGuard({ devguiHostname: 'devgui.example.com' }),
    });
    await expect(api.deleteDnsRecord(ZONE_ID, 'devgui.example.com'))
      .rejects.toMatchObject({ errorClass: 'protected-resource' });
  });
});

// ── deleteTunnel ──────────────────────────────────────────────────────────────

describe('CloudflareApi — deleteTunnel()', () => {
  it('DELETEs the tunnel endpoint', async () => {
    let deleteUrl;
    const fetchFn = async (url, init) => {
      if (init?.method === 'DELETE') {
        deleteUrl = url;
        return makeFetchResponse(200, DELETE_SUCCESS_RESPONSE);
      }
      return makeFetchResponse(200, { success: true, result: {} });
    };
    const api = makeApi({ fetchFn });
    await api.deleteTunnel(TUNNEL_ID);

    expect(deleteUrl).toContain(TUNNEL_ID);
    expect(deleteUrl).toContain('cfd_tunnel');
  });

  it('not configured → throws cloudflare-not-configured', async () => {
    const api = makeApi({ configured: false });
    await expect(api.deleteTunnel(TUNNEL_ID))
      .rejects.toMatchObject({ errorClass: 'cloudflare-not-configured' });
  });
});

// ── #apiDelete success:false Guard ────────────────────────────────────────────

describe('CloudflareApi — #apiDelete success:false Guard (Finding #108-Review)', () => {
  it('HTTP 200 + { success: false } → throws cloudflare-unavailable (not treated as ok)', async () => {
    // Cloudflare can return HTTP 200 with { success: false, errors } — must NOT be treated as ok
    // (Finding from #108-Review: #apiDelete lacked the success:false guard)
    const fetchFn = async (_url, init) => {
      if (init?.method === 'DELETE') {
        return makeFetchResponse(200, { success: false, errors: [{ code: 1200, message: 'tunnel in use' }] });
      }
      return makeFetchResponse(200, { success: true, result: {} });
    };
    const api = makeApi({ fetchFn });

    await expect(api.deleteTunnel(TUNNEL_ID))
      .rejects.toMatchObject({ errorClass: 'cloudflare-unavailable' });
  });

  it('HTTP 200 + { success: false, errors: [{code:10000}] } → throws cloudflare-auth-failed', async () => {
    const fetchFn = async (_url, init) => {
      if (init?.method === 'DELETE') {
        return makeFetchResponse(200, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
      }
      return makeFetchResponse(200, { success: true, result: {} });
    };
    const api = makeApi({ fetchFn });

    await expect(api.deleteTunnel(TUNNEL_ID))
      .rejects.toMatchObject({ errorClass: 'cloudflare-auth-failed' });
  });

  it('HTTP 200 + { success: true } → does not throw (valid success)', async () => {
    const fetchFn = async (_url, init) => {
      if (init?.method === 'DELETE') {
        return makeFetchResponse(200, { success: true, result: { id: TUNNEL_ID } });
      }
      return makeFetchResponse(200, { success: true, result: {} });
    };
    const api = makeApi({ fetchFn });

    // Should NOT throw
    await expect(api.deleteTunnel(TUNNEL_ID)).resolves.not.toThrow();
  });

  it('HTTP 200 + empty body (204-style) → does not throw', async () => {
    const fetchFn = async (_url, init) => {
      if (init?.method === 'DELETE') {
        return {
          ok: true,
          status: 200,
          json: async () => { throw new SyntaxError('No body'); },
        };
      }
      return makeFetchResponse(200, { success: true, result: {} });
    };
    const api = makeApi({ fetchFn });

    // Should NOT throw when body is empty
    await expect(api.deleteTunnel(TUNNEL_ID)).resolves.not.toThrow();
  });

  it('HTTP 404 on DELETE → does not throw (idempotent: already gone)', async () => {
    const fetchFn = async (_url, init) => {
      if (init?.method === 'DELETE') {
        return makeFetchResponse(404, { success: false, errors: [{ code: 1003, message: 'not found' }] });
      }
      return makeFetchResponse(200, { success: true, result: {} });
    };
    const api = makeApi({ fetchFn });

    // 404 on DELETE should be idempotent (resource already gone)
    await expect(api.deleteTunnel(TUNNEL_ID)).resolves.not.toThrow();
  });
});
