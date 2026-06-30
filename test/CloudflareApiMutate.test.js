/**
 * CloudflareApiMutate.test.js — Tests für CloudflareApi-Mutate-Methoden (ADR-010/012).
 *
 * Covers:
 *   createTunnel   — POST /accounts/{id}/cfd_tunnel → { tunnelId, token } (AC1–AC4, vps-tunnel-provisioning)
 *   addRoute       — Adds/replaces a route in tunnel ingress config (LockoutGuard-Check)
 *   removeRoute    — Removes a route from tunnel ingress config (LockoutGuard-Check)
 *   createDnsRecord — Creates a DNS CNAME record (LockoutGuard-Check)
 *   deleteDnsRecord — Deletes a DNS record by hostname lookup + DELETE
 *   deleteTunnel   — Deletes a tunnel (AC4: exists, no duplication)
 *   #apiDelete success:false guard — Cloudflare HTTP 200 + { success: false } must throw
 *   LockoutGuard   — protected target → CloudflareApiError(protected-resource) before API call
 *   not-configured — missing token/accountId → CloudflareApiError(cloudflare-not-configured)
 *
 * Covers (vps-tunnel-provisioning): AC1, AC2, AC3, AC4
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

// ── createTunnel ──────────────────────────────────────────────────────────────
// AC1: POST /accounts/{accountId}/cfd_tunnel, config_src:"cloudflare", returns { tunnelId, token }
// AC2: token never appears in logs/errors; API-token never in errors
// AC3: error classification (auth-failed/rate-limit/5xx/timeout) + AbortController-Timeout
// AC4: deleteTunnel exists (no own delete path in createTunnel)

const MOCK_TUNNEL_ID = 'tunnel-created-abcdef1234567890';
const MOCK_TUNNEL_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.tunnel-connector-token-secret';

function makeCreateTunnelSuccessResponse({ id = MOCK_TUNNEL_ID, token = MOCK_TUNNEL_TOKEN } = {}) {
  return {
    success: true,
    result: { id, token },
  };
}

describe('CloudflareApi — createTunnel() — AC1–AC4 (vps-tunnel-provisioning)', () => {
  it('AC1: POSTs to /accounts/{accountId}/cfd_tunnel with config_src:cloudflare', async () => {
    let capturedUrl;
    let capturedBody;
    const fetchFn = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return makeFetchResponse(200, makeCreateTunnelSuccessResponse());
    };
    const api = makeApi({ fetchFn });
    await api.createTunnel('devgui-my-vps');

    expect(capturedUrl).toContain(`/accounts/${MOCK_ACCOUNT_ID}/cfd_tunnel`);
    expect(capturedBody.name).toBe('devgui-my-vps');
    expect(capturedBody.config_src).toBe('cloudflare');
  });

  it('AC1: returns { tunnelId, token } on success', async () => {
    const fetchFn = async () => makeFetchResponse(200, makeCreateTunnelSuccessResponse());
    const api = makeApi({ fetchFn });
    const result = await api.createTunnel('devgui-my-vps');

    expect(result.tunnelId).toBe(MOCK_TUNNEL_ID);
    expect(result.token).toBe(MOCK_TUNNEL_TOKEN);
  });

  it('AC1: not configured → throws cloudflare-not-configured (422) without API call', async () => {
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return makeFetchResponse(200, {}); };
    const api = makeApi({ configured: false, fetchFn });

    await expect(api.createTunnel('devgui-my-vps'))
      .rejects.toMatchObject({ errorClass: 'cloudflare-not-configured', httpStatus: 422 });
    expect(calls).toHaveLength(0); // no API call made
  });

  it('AC2: tunnel token does not appear in thrown error message on auth failure', async () => {
    // Simulate a scenario where we have a tunnel token in memory and auth fails
    // The tunnel token must NOT leak into any error message
    const fetchFn = async () => makeFetchResponse(401, { success: false, errors: [] });
    const api = makeApi({ fetchFn });

    let thrown;
    try {
      await api.createTunnel('devgui-my-vps');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).not.toContain(MOCK_TUNNEL_TOKEN);
    expect(thrown.message).not.toContain(MOCK_TOKEN); // API token also must not leak
  });

  it('AC2: tunnel token does not appear in error on network failure', async () => {
    const fetchFn = async () => { throw new Error('ECONNREFUSED'); };
    const api = makeApi({ fetchFn });

    let thrown;
    try {
      await api.createTunnel('devgui-my-vps');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).not.toContain(MOCK_TUNNEL_TOKEN);
    expect(thrown.message).not.toContain(MOCK_TOKEN);
  });

  it('AC2: tunnel token does not appear in invalid-response error when result is missing', async () => {
    // API returns 200 but result has no token
    const fetchFn = async () => makeFetchResponse(200, { success: true, result: { id: MOCK_TUNNEL_ID } });
    const api = makeApi({ fetchFn });

    let thrown;
    try {
      await api.createTunnel('devgui-my-vps');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.errorClass).toBe('invalid-response');
    expect(thrown.message).not.toContain(MOCK_TOKEN);
  });

  it('AC3: 401 → cloudflare-auth-failed (502)', async () => {
    const fetchFn = async () => makeFetchResponse(401, {});
    const api = makeApi({ fetchFn });

    await expect(api.createTunnel('devgui-my-vps'))
      .rejects.toMatchObject({ errorClass: 'cloudflare-auth-failed', httpStatus: 502 });
  });

  it('AC3: 403 → cloudflare-auth-failed (502)', async () => {
    const fetchFn = async () => makeFetchResponse(403, {});
    const api = makeApi({ fetchFn });

    await expect(api.createTunnel('devgui-my-vps'))
      .rejects.toMatchObject({ errorClass: 'cloudflare-auth-failed', httpStatus: 502 });
  });

  it('AC3: 429 → cloudflare-unavailable (503)', async () => {
    const fetchFn = async () => makeFetchResponse(429, {});
    const api = makeApi({ fetchFn });

    await expect(api.createTunnel('devgui-my-vps'))
      .rejects.toMatchObject({ errorClass: 'cloudflare-unavailable', httpStatus: 503 });
  });

  it('AC3: 500 → cloudflare-unavailable (502)', async () => {
    const fetchFn = async () => makeFetchResponse(500, {});
    const api = makeApi({ fetchFn });

    await expect(api.createTunnel('devgui-my-vps'))
      .rejects.toMatchObject({ errorClass: 'cloudflare-unavailable', httpStatus: 502 });
  });

  it('AC3: timeout (AbortError) → cloudflare-unavailable (503)', async () => {
    const fetchFn = async () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    };
    const api = makeApi({ fetchFn });

    await expect(api.createTunnel('devgui-my-vps'))
      .rejects.toMatchObject({ errorClass: 'cloudflare-unavailable', httpStatus: 503 });
  });

  it('AC3: success:false with auth error code → cloudflare-auth-failed', async () => {
    const fetchFn = async () => makeFetchResponse(200, {
      success: false,
      errors: [{ code: 10000, message: 'Authentication error' }],
    });
    const api = makeApi({ fetchFn });

    await expect(api.createTunnel('devgui-my-vps'))
      .rejects.toMatchObject({ errorClass: 'cloudflare-auth-failed' });
  });

  it('AC3: success:false (generic) → cloudflare-unavailable', async () => {
    const fetchFn = async () => makeFetchResponse(200, {
      success: false,
      errors: [{ code: 1200, message: 'conflict' }],
    });
    const api = makeApi({ fetchFn });

    await expect(api.createTunnel('devgui-my-vps'))
      .rejects.toMatchObject({ errorClass: 'cloudflare-unavailable' });
  });

  it('AC4: deleteTunnel method exists on CloudflareApi (no new delete path in createTunnel)', () => {
    const api = makeApi();
    expect(typeof api.deleteTunnel).toBe('function');
    // createTunnel does not define its own delete path — deleteTunnel is the single path (AC4)
  });
});

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

  it('vorhandener CNAME → PUT-Update statt Duplikat-POST (idempotent), Duplikate gelöscht', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
      if (method === 'GET') {
        // Zwei vorhandene CNAMEs für denselben Hostnamen (Record + Duplikat)
        return makeFetchResponse(200, {
          success: true,
          result: [
            { id: 'rec-1', name: 'app.example.com', type: 'CNAME', content: 'old.cfargotunnel.com' },
            { id: 'rec-2', name: 'app.example.com', type: 'CNAME', content: 'old.cfargotunnel.com' },
          ],
        });
      }
      return makeFetchResponse(200, { success: true, result: {} });
    };
    const api = makeApi({ fetchFn });
    await api.createDnsRecord(ZONE_ID, 'app.example.com', TUNNEL_ID);

    const post = calls.find((c) => c.method === 'POST');
    const put = calls.find((c) => c.method === 'PUT');
    const del = calls.find((c) => c.method === 'DELETE');
    expect(post).toBeUndefined();              // KEIN Duplikat-POST (das wäre der HTTP-400-Fehler)
    expect(put).toBeDefined();
    expect(put.url).toContain('rec-1');
    expect(put.body.content).toContain(TUNNEL_ID); // auf neuen Tunnel umgebogen
    expect(del).toBeDefined();
    expect(del.url).toContain('rec-2');         // Duplikat aufgeräumt
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

  // ── AC3a (vps-delete S-171): Connections-Cleanup vor dem Tunnel-Delete ──────
  it('AC3a: räumt Connections VOR dem Tunnel-Delete auf', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      if (init?.method === 'DELETE') {
        calls.push(url.includes('/connections') ? 'connections' : 'tunnel');
        return makeFetchResponse(200, DELETE_SUCCESS_RESPONSE);
      }
      return makeFetchResponse(200, { success: true, result: {} });
    };
    const api = makeApi({ fetchFn });
    await api.deleteTunnel(TUNNEL_ID);
    expect(calls).toEqual(['connections', 'tunnel']);
  });

  it('AC3a: Tunnel-Delete scheitert (1022) → Connections-Cleanup + Retry → ok', async () => {
    const seq = [];
    let tunnelAttempts = 0;
    const fetchFn = async (url, init) => {
      if (init?.method !== 'DELETE') return makeFetchResponse(200, { success: true, result: {} });
      if (url.includes('/connections')) { seq.push('conn'); return makeFetchResponse(200, DELETE_SUCCESS_RESPONSE); }
      tunnelAttempts++; seq.push('tunnel');
      if (tunnelAttempts === 1) {
        return makeFetchResponse(400, { success: false, errors: [{ code: 1022, message: 'This tunnel has active connections' }] });
      }
      return makeFetchResponse(200, DELETE_SUCCESS_RESPONSE);
    };
    const api = makeApi({ fetchFn });
    await expect(api.deleteTunnel(TUNNEL_ID)).resolves.toEqual({ result: 'ok' });
    expect(seq).toEqual(['conn', 'tunnel', 'conn', 'tunnel']);
  });

  it('AC3a: Connections-Cleanup-Fehler ist best-effort (Tunnel-Delete trotzdem)', async () => {
    const fetchFn = async (url, init) => {
      if (init?.method !== 'DELETE') return makeFetchResponse(200, { success: true, result: {} });
      if (url.includes('/connections')) return makeFetchResponse(500, { success: false });
      return makeFetchResponse(200, DELETE_SUCCESS_RESPONSE);
    };
    const api = makeApi({ fetchFn });
    await expect(api.deleteTunnel(TUNNEL_ID)).resolves.toEqual({ result: 'ok' });
  });

  it('AC3a/AC4: dauerhafter Delete-Fehler propagiert geheimnisfrei (kein Token im Fehler)', async () => {
    const fetchFn = async (url, init) => {
      if (init?.method !== 'DELETE') return makeFetchResponse(200, { success: true, result: {} });
      if (url.includes('/connections')) return makeFetchResponse(200, DELETE_SUCCESS_RESPONSE);
      return makeFetchResponse(400, { success: false, errors: [{ code: 1022 }] });
    };
    const api = makeApi({ fetchFn });
    const err = await api.deleteTunnel(TUNNEL_ID).catch((e) => e);
    expect(err).toMatchObject({ errorClass: 'cloudflare-unavailable' });
    expect(JSON.stringify(err.message)).not.toContain(MOCK_TOKEN);
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
