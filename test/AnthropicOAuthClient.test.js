/**
 * AnthropicOAuthClient.test.js — Unit-Tests für den Abo-OAuth-Token-Refresh-
 * Adapter (docs/specs/anthropic-oauth-vault.md).
 *
 * Covers (anthropic-oauth-vault): AC5 (Refresh-Erfolg: neues access_token/
 * refresh_token/expiresAt), AC6 (Refresh-Fehler: Netz/Timeout/HTTP>=400/
 * kaputtes JSON → { ok: false }, wirft nie), AC8 (Token nie im Fehlerpfad),
 * AC9 (fester Host/Pfad, client_id als Konstante — kein Nutzer-Input).
 *
 * Strategy: `refreshAnthropicOAuthToken` wird gegen einen injizierten `fetchFn`-
 * Stub getestet (kein echter HTTP-Call).
 *
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  refreshAnthropicOAuthToken,
  ANTHROPIC_OAUTH_TOKEN_HOST,
  ANTHROPIC_OAUTH_TOKEN_PATH,
  ANTHROPIC_OAUTH_CLIENT_ID,
} from '../src/AnthropicOAuthClient.js';

function makeFetchResponse(status, body) {
  return { status, json: async () => body };
}

describe('refreshAnthropicOAuthToken', () => {
  it('AC9 — ruft den festen Host/Pfad mit client_id + refresh_token als JSON-Body ab', async () => {
    let seenUrl;
    let seenInit;
    const fetchFn = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return makeFetchResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    };
    await refreshAnthropicOAuthToken({ refreshToken: 'old-refresh-secret', fetchFn });

    expect(seenUrl).toBe(`${ANTHROPIC_OAUTH_TOKEN_HOST}${ANTHROPIC_OAUTH_TOKEN_PATH}`);
    expect(seenInit.method).toBe('POST');
    expect(seenInit.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(seenInit.body);
    expect(body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh-secret',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    });
    // AC9: scope wird bewusst NICHT gesendet (RFC-6749-konformer Default)
    expect(body).not.toHaveProperty('scope');
  });

  it('AC5 — Erfolg: liefert neues access_token/refresh_token + berechnetes expiresAt', async () => {
    const fetchFn = async () =>
      makeFetchResponse(200, { access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 7200 });
    const before = Date.now();
    const result = await refreshAnthropicOAuthToken({ refreshToken: 'r', fetchFn });
    const after = Date.now();

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000);
    expect(result.expiresAt).toBeLessThanOrEqual(after + 7200 * 1000);
  });

  it('AC5 — Response ohne rotiertes refresh_token: der gesendete refresh_token bleibt gültig', async () => {
    const fetchFn = async () => makeFetchResponse(200, { access_token: 'new-access-only', expires_in: 3600 });
    const result = await refreshAnthropicOAuthToken({ refreshToken: 'still-valid-refresh', fetchFn });

    expect(result.ok).toBe(true);
    expect(result.refreshToken).toBe('still-valid-refresh');
  });

  it('AC6/AC8 — HTTP-Fehler (400/401/403) → { ok: false, reason: "http-error" }, kein Token im Fehlerpfad', async () => {
    const fetchFn = async () => makeFetchResponse(400, { error: 'invalid_grant' });
    const result = await refreshAnthropicOAuthToken({ refreshToken: 'expired-refresh-secret', fetchFn });

    expect(result).toEqual({ ok: false, reason: 'http-error' });
    expect(JSON.stringify(result)).not.toContain('expired-refresh-secret');
  });

  it('AC6 — Netzfehler/Timeout (fetchFn wirft) → { ok: false, reason: "network" }, wirft nicht', async () => {
    const fetchFn = async () => {
      const err = new Error('timeout');
      err.name = 'AbortError';
      throw err;
    };
    await expect(refreshAnthropicOAuthToken({ refreshToken: 'r', fetchFn })).resolves.toEqual({ ok: false, reason: 'network' });
  });

  it('AC6 — nicht-parsebares JSON → { ok: false, reason: "invalid-response" }', async () => {
    const fetchFn = async () => ({ status: 200, json: async () => { throw new SyntaxError('bad json'); } });
    await expect(refreshAnthropicOAuthToken({ refreshToken: 'r', fetchFn })).resolves.toEqual({ ok: false, reason: 'invalid-response' });
  });

  it('AC6 — Response ohne access_token/expires_in → { ok: false, reason: "invalid-response" }', async () => {
    const fetchFn = async () => makeFetchResponse(200, { unrelated: true });
    await expect(refreshAnthropicOAuthToken({ refreshToken: 'r', fetchFn })).resolves.toEqual({ ok: false, reason: 'invalid-response' });
  });

  it('AC6 — leerer/fehlender refresh_token → { ok: false, reason: "invalid-input" }, kein Abruf-Versuch', async () => {
    let called = false;
    const fetchFn = async () => {
      called = true;
      return makeFetchResponse(200, {});
    };
    expect(await refreshAnthropicOAuthToken({ refreshToken: '', fetchFn })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(await refreshAnthropicOAuthToken({ refreshToken: undefined, fetchFn })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(called).toBe(false);
  });
});
