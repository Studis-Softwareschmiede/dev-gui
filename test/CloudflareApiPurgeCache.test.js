/**
 * CloudflareApiPurgeCache.test.js — Tests für CloudflareApi.purgeCache() (deploy-cache-purge).
 *
 * Covers (deploy-cache-purge AC1–AC8, S-370):
 *   AC1 — genau eine Methode purgeCache(zoneId, hostname); Token store-intern, nur im
 *         Authorization: Bearer-Header
 *   AC2 — POST /client/v4/zones/{zoneId}/purge_cache mit Body {"hosts":["<hostname>"]}
 *         (URL, Methode, Header, Body)
 *   AC3 — hosts-Fehler (Nichtunterstützung) → einmaliger Fallback auf purge_everything;
 *         purge_everything wird NIE ohne vorherigen hosts-Versuch gesendet; ein UNVERWANDTER
 *         Fehler (Auth/Rate-Limit/Netz) löst KEINEN Fallback aus
 *   AC6 — best-effort: purgeCache wirft nie, liefert { result:'error', errorClass, reason }
 *   AC7 — nicht konfiguriert / kein zoneId → { result:'skipped', reason }, kein API-Call
 *   AC8 — Token erscheint nie im Body/URL/Ergebnis; Erfolg/Fehler sind secret-frei
 *
 * Strategy: CredentialStore + fetch als Stub injiziert (kein echter HTTP-Call).
 */

import { describe, it, expect, jest } from '@jest/globals';
import { CloudflareApi } from '../src/cloudflare/CloudflareApi.js';
import { LockoutGuard } from '../src/cloudflare/LockoutGuard.js';

const MOCK_TOKEN = 'cf-purge-test-token-never-in-output';
const MOCK_ACCOUNT_ID = 'acc-test-1234567890abcdef';
const ZONE_ID = 'zone-test-abcdef1234567890abcdef12';
const HOSTNAME = 'app.example.com';

function makeCredentialStore({ token = MOCK_TOKEN, accountId = MOCK_ACCOUNT_ID } = {}) {
  return {
    async getPlaintext(key) {
      if (key === 'credentials/cloudflare/api_token') return token;
      if (key === 'credentials/cloudflare/account_id') return accountId;
      return null;
    },
  };
}

function makeFetchResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function makeApi({ fetchFn, configured = true } = {}) {
  return new CloudflareApi({
    credentialStore: configured ? makeCredentialStore() : makeCredentialStore({ token: null, accountId: null }),
    lockoutGuard: new LockoutGuard({ devguiHostname: 'devgui.example.com' }),
    fetchFn,
  });
}

const SUCCESS_RESPONSE = { success: true, result: { id: 'purge-id-1' } };

// ── AC1/AC2: hostname-scoped purge ──────────────────────────────────────────────

describe('CloudflareApi.purgeCache() — AC1/AC2: hostname-scoped POST', () => {
  it('AC2: POSTs to /zones/{zoneId}/purge_cache with Bearer header + hosts body', async () => {
    let capturedUrl;
    let capturedInit;
    const fetchFn = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return makeFetchResponse(200, SUCCESS_RESPONSE);
    };
    const api = makeApi({ fetchFn });

    const result = await api.purgeCache(ZONE_ID, HOSTNAME);

    expect(result).toEqual({ result: 'ok', mode: 'hosts' });
    expect(capturedUrl).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`);
    expect(capturedInit.method).toBe('POST');
    expect(capturedInit.headers.Authorization).toBe(`Bearer ${MOCK_TOKEN}`);
    expect(JSON.parse(capturedInit.body)).toEqual({ hosts: [HOSTNAME] });
  });

  it('AC1: kein API-Call, wenn Cloudflare nicht konfiguriert (kein Token/Account-Id) → skipped', async () => {
    const fetchFn = jest.fn(async () => makeFetchResponse(200, SUCCESS_RESPONSE));
    const api = makeApi({ fetchFn, configured: false });

    const result = await api.purgeCache(ZONE_ID, HOSTNAME);

    expect(result).toEqual({ result: 'skipped', reason: 'cloudflare-not-configured' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('AC7: kein zoneId → skipped, kein API-Call', async () => {
    const fetchFn = jest.fn(async () => makeFetchResponse(200, SUCCESS_RESPONSE));
    const api = makeApi({ fetchFn });

    const result = await api.purgeCache(null, HOSTNAME);

    expect(result).toEqual({ result: 'skipped', reason: 'zone-not-found' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ── AC3: purge_everything fallback ──────────────────────────────────────────────

describe('CloudflareApi.purgeCache() — AC3: purge_everything-Fallback', () => {
  it('AC3: hosts-Fehler (Nichtunterstützung) → zweiter Call mit purge_everything derselben Zone', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (body.hosts) {
        return makeFetchResponse(400, {
          success: false,
          errors: [{ code: 1234, message: 'Purge by hosts is not available for this zone plan (Enterprise only)' }],
        });
      }
      return makeFetchResponse(200, SUCCESS_RESPONSE);
    };
    const api = makeApi({ fetchFn });

    const result = await api.purgeCache(ZONE_ID, HOSTNAME);

    expect(result).toEqual({ result: 'ok', mode: 'purge_everything' });
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toEqual({ hosts: [HOSTNAME] });
    expect(calls[1].body).toEqual({ purge_everything: true });
    expect(calls[1].url).toBe(calls[0].url); // dieselbe Zone
  });

  it('AC3: purge_everything wird NIE ohne vorherigen hosts-Versuch gesendet (kein Direkt-Fallback)', async () => {
    const bodies = [];
    const fetchFn = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return makeFetchResponse(400, {
        success: false,
        errors: [{ code: 1234, message: 'hosts purge not available for this plan' }],
      });
    };
    const api = makeApi({ fetchFn });

    await api.purgeCache(ZONE_ID, HOSTNAME);

    expect(bodies[0]).toEqual({ hosts: [HOSTNAME] });
  });

  it('AC3: unverwandter Fehler (Auth 401) löst KEINEN Fallback aus — genau ein Call', async () => {
    const fetchFn = jest.fn(async () => makeFetchResponse(401, {}));
    const api = makeApi({ fetchFn });

    const result = await api.purgeCache(ZONE_ID, HOSTNAME);

    expect(result).toEqual({ result: 'error', errorClass: 'cloudflare-auth-failed', reason: 'Cloudflare authentication failed' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('AC3: unverwandter API-Fehler (unrelated success:false ohne Hosts-Wortlaut) löst KEINEN Fallback aus', async () => {
    const fetchFn = jest.fn(async () => makeFetchResponse(400, {
      success: false,
      errors: [{ code: 9999, message: 'Something else went wrong' }],
    }));
    const api = makeApi({ fetchFn });

    const result = await api.purgeCache(ZONE_ID, HOSTNAME);

    expect(result.result).toBe('error');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('AC6: schlägt auch der purge_everything-Fallback fehl → best-effort result:error, kein Wurf', async () => {
    const fetchFn = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.hosts) {
        return makeFetchResponse(400, {
          success: false,
          errors: [{ code: 1234, message: 'hosts purge not available (enterprise only)' }],
        });
      }
      return makeFetchResponse(500, { success: false, errors: [{ code: 500, message: 'internal error' }] });
    };
    const api = makeApi({ fetchFn });

    await expect(api.purgeCache(ZONE_ID, HOSTNAME)).resolves.toEqual(
      expect.objectContaining({ result: 'error' }),
    );
  });
});

// ── AC6: best-effort — Timeout / Rate-Limit / Netzwerk ──────────────────────────

describe('CloudflareApi.purgeCache() — AC6: best-effort Fehlerklassen (wirft nie)', () => {
  it('Timeout (AbortError) → result:error, cloudflare-unavailable, kein Wurf', async () => {
    const fetchFn = async () => {
      const err = new Error('timeout');
      err.name = 'AbortError';
      throw err;
    };
    const api = makeApi({ fetchFn });

    const result = await api.purgeCache(ZONE_ID, HOSTNAME);
    expect(result).toEqual({ result: 'error', errorClass: 'cloudflare-unavailable', reason: 'Cloudflare API request timed out' });
  });

  it('Rate-Limit (429) → result:error, cloudflare-unavailable', async () => {
    const fetchFn = async () => makeFetchResponse(429, {});
    const api = makeApi({ fetchFn });

    const result = await api.purgeCache(ZONE_ID, HOSTNAME);
    expect(result).toEqual({ result: 'error', errorClass: 'cloudflare-unavailable', reason: 'Cloudflare API rate limit exceeded' });
  });

  it('Netzwerkfehler → result:error, cloudflare-unavailable, kein Wurf in den Aufrufer', async () => {
    const fetchFn = async () => { throw new Error('fetch failed'); };
    const api = makeApi({ fetchFn });

    await expect(api.purgeCache(ZONE_ID, HOSTNAME)).resolves.toEqual(
      expect.objectContaining({ result: 'error', errorClass: 'cloudflare-unavailable' }),
    );
  });
});

// ── AC8: Token-Disziplin ────────────────────────────────────────────────────────

describe('CloudflareApi.purgeCache() — AC8: Token nie im Body/URL/Ergebnis', () => {
  it('Token erscheint nur im Authorization-Header — nie im Body oder in der URL', async () => {
    let capturedUrl;
    let capturedBody;
    const fetchFn = async (url, init) => {
      capturedUrl = url;
      capturedBody = init.body;
      return makeFetchResponse(200, SUCCESS_RESPONSE);
    };
    const api = makeApi({ fetchFn });

    await api.purgeCache(ZONE_ID, HOSTNAME);

    expect(capturedUrl).not.toContain(MOCK_TOKEN);
    expect(capturedBody).not.toContain(MOCK_TOKEN);
  });

  it('Fehler-Ergebnis (result:error) enthält keinen Token-String', async () => {
    const fetchFn = async () => makeFetchResponse(401, {});
    const api = makeApi({ fetchFn });

    const result = await api.purgeCache(ZONE_ID, HOSTNAME);

    expect(JSON.stringify(result)).not.toContain(MOCK_TOKEN);
  });
});
