/**
 * AnthropicUsageClient.test.js — Unit-Tests für den Anthropic-Usage-Adapter
 * (docs/specs/usage-official-values.md).
 *
 * Covers (usage-official-values): AC1 (Abruf + official-Erfolgsform),
 * AC2 (session 1:1 gemappt), AC3 (week.allModels + week.perModel),
 * AC4 (spend nur wenn upstream vorhanden, kein null-Platzhalter),
 * AC7 (Schema-Validierung/Adapter: Müll-Payload/Teil-Payload crasht nie),
 * AC8 (Token nie im Body/Fehlerpfad — kein leerer Abruf-Versuch ohne Token).
 *
 * Strategy: `fetchAnthropicUsage` wird gegen einen injizierten `fetchFn`-Stub
 * getestet (kein echter HTTP-Call); `mapAnthropicUsagePayload` ist eine reine
 * Funktion und wird direkt mit synthetischen Upstream-Payloads getestet.
 *
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  fetchAnthropicUsage,
  mapAnthropicUsagePayload,
  ANTHROPIC_USAGE_HOST,
  ANTHROPIC_USAGE_PATH,
} from '../src/AnthropicUsageClient.js';

function makeFetchResponse(status, body) {
  return { status, json: async () => body };
}

describe('fetchAnthropicUsage', () => {
  it('AC8 — ruft ohne Token nicht ab (kein leerer Header-Versuch)', async () => {
    let called = false;
    const fetchFn = async () => {
      called = true;
      return makeFetchResponse(200, {});
    };
    const result = await fetchAnthropicUsage({ token: undefined, fetchFn });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('AC1 — ruft den festen Host/Pfad mit Bearer-Token ab und liefert das JSON', async () => {
    let seenUrl;
    let seenAuth;
    const fetchFn = async (url, init) => {
      seenUrl = url;
      seenAuth = init.headers.Authorization;
      return makeFetchResponse(200, { five_hour: { utilization: 42, resets_at: 1737199200 } });
    };
    const raw = await fetchAnthropicUsage({ token: 'super-secret-oauth-token', fetchFn });
    expect(seenUrl).toBe(`${ANTHROPIC_USAGE_HOST}${ANTHROPIC_USAGE_PATH}`);
    expect(seenAuth).toBe('Bearer super-secret-oauth-token');
    expect(raw).toEqual({ five_hour: { utilization: 42, resets_at: 1737199200 } });
  });

  it('AC5/AC8 — HTTP-Fehler (401) liefert null, kein Token im Fehlerpfad', async () => {
    const fetchFn = async () => makeFetchResponse(401, { error: 'invalid token' });
    const result = await fetchAnthropicUsage({ token: 'super-secret-oauth-token', fetchFn });
    expect(result).toBeNull();
  });

  it('AC5 — Netzfehler/Timeout (fetchFn wirft) liefert null statt zu werfen', async () => {
    const fetchFn = async () => {
      const err = new Error('network down');
      err.name = 'AbortError';
      throw err;
    };
    await expect(fetchAnthropicUsage({ token: 'x', fetchFn })).resolves.toBeNull();
  });

  it('AC7 — nicht-parsebares JSON liefert null statt zu werfen', async () => {
    const fetchFn = async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError('unexpected token');
      },
    });
    await expect(fetchAnthropicUsage({ token: 'x', fetchFn })).resolves.toBeNull();
  });
});

describe('mapAnthropicUsagePayload', () => {
  const NOW = new Date('2026-07-18T12:00:00.000Z');

  it('AC1/AC2 — mappt ein valides Session-Fenster (five_hour) 1:1', () => {
    const raw = { five_hour: { utilization: 42, resets_at: 1737199200 } };
    const mapped = mapAnthropicUsagePayload(raw, { now: NOW });
    expect(mapped.source).toBe('official');
    expect(mapped.session).toEqual({ percentUsed: 42, resetAt: new Date(1737199200 * 1000).toISOString() });
    expect(mapped.generatedAt).toBe(NOW.toISOString());
  });

  it('AC3 — mappt week.allModels + week.perModel aus seven_day + seven_day_<model>', () => {
    const raw = {
      five_hour: { utilization: 10, resets_at: 1737199200 },
      seven_day: { utilization: 55, resets_at: 1737800000 },
      seven_day_opus: { utilization: 5, resets_at: 1737800000 },
      seven_day_sonnet: { utilization: 60, resets_at: 1737800000 },
      seven_day_overage_included: true, // non-window Flag, muss ignoriert werden
    };
    const mapped = mapAnthropicUsagePayload(raw, { now: NOW });
    expect(mapped.week.allModels).toEqual({
      percentUsed: 55,
      resetAt: new Date(1737800000 * 1000).toISOString(),
    });
    expect(mapped.week.perModel).toEqual(
      expect.arrayContaining([
        { model: 'opus', percentUsed: 5, resetAt: new Date(1737800000 * 1000).toISOString() },
        { model: 'sonnet', percentUsed: 60, resetAt: new Date(1737800000 * 1000).toISOString() },
      ])
    );
    expect(mapped.week.perModel).toHaveLength(2);
  });

  it('AC4 — spend fehlt in der Antwort, wenn upstream keinen Wert liefert (kein null-Platzhalter)', () => {
    const raw = { five_hour: { utilization: 10, resets_at: 1737199200 } };
    const mapped = mapAnthropicUsagePayload(raw, { now: NOW });
    expect(mapped).not.toHaveProperty('spend');
  });

  it('AC4 — spend wird durchgereicht, wenn upstream einen Wert liefert', () => {
    const raw = {
      five_hour: { utilization: 10, resets_at: 1737199200 },
      spend: { amountUsd: 12.5 },
    };
    const mapped = mapAnthropicUsagePayload(raw, { now: NOW });
    expect(mapped.spend).toEqual({ amountUsd: 12.5 });
  });

  it('AC7 — Teil-Payload (Session ok, Wochenliste fehlt): vorhandene Felder gemappt, fehlende weggelassen', () => {
    const raw = { five_hour: { utilization: 10, resets_at: 1737199200 } };
    const mapped = mapAnthropicUsagePayload(raw, { now: NOW });
    expect(mapped.session).toBeDefined();
    expect(mapped).not.toHaveProperty('week');
  });

  it('AC7 — Müll-Struktur (fehlende Pflichtfelder) liefert null statt zu werfen', () => {
    expect(mapAnthropicUsagePayload({ five_hour: { foo: 'bar' } }, { now: NOW })).toBeNull();
    expect(mapAnthropicUsagePayload({ unrelated: true }, { now: NOW })).toBeNull();
    expect(mapAnthropicUsagePayload(null, { now: NOW })).toBeNull();
    expect(mapAnthropicUsagePayload('not-an-object', { now: NOW })).toBeNull();
    expect(mapAnthropicUsagePayload(42, { now: NOW })).toBeNull();
  });

  it('AC7 — falsche Typen (resets_at als kaputter String) degradieren nur das betroffene Fenster', () => {
    const raw = {
      five_hour: { utilization: 10, resets_at: 'not-a-date' },
      seven_day: { utilization: 20, resets_at: 1737800000 },
    };
    const mapped = mapAnthropicUsagePayload(raw, { now: NOW });
    expect(mapped).not.toBeNull();
    expect(mapped).not.toHaveProperty('session'); // five_hour war kaputt → weggelassen
    expect(mapped.week.allModels.percentUsed).toBe(20);
  });

  it('normalisiert eine Utilization als Bruch (0..1) zu Prozent', () => {
    const raw = { five_hour: { utilization: 0.42, resets_at: 1737199200 } };
    const mapped = mapAnthropicUsagePayload(raw, { now: NOW });
    expect(mapped.session.percentUsed).toBe(42);
  });
});
