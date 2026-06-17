/**
 * hostinger.test.js — Unit-Tests für den Hostinger VPS API Adapter.
 *
 * Covers:
 *   AC1  — HostingerAdapter implementiert den VpsProvider-Vertrag
 *           (capabilities/listMachines/start/stop/create)
 *   AC2  — capabilities().delete ausgewiesen (vps-delete)
 *   AC5  — start/stop liefern { result: "ok" } bei Erfolg; idempotent bei 409
 *   AC6  — create liefert { result: "unsupported" } + capabilities().create === false
 *           (HOSTINGER_CREATE_UNSUPPORTED: kostenpflichtiger Kauf, nicht im Scope)
 *   AC10 — Token erscheint NICHT in Fehlermeldungen / Antworten
 *
 * Covers (vps-delete): AC2 — capabilities().delete ausgewiesen
 *
 * Strategy:
 *   - fetchFn wird injiziert (kein echter Netzwerkaufruf)
 *   - Token ist ein Platzhalter-String; Tests prüfen, dass er nie in Errors auftaucht
 */

import { describe, it, expect } from '@jest/globals';
import { HostingerAdapter, HostingerAdapterError } from '../src/vps/providers/hostinger.js';

const MOCK_TOKEN = 'hostinger-test-token-should-never-appear-in-output';

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

function makeVmRaw(overrides = {}) {
  return {
    id: 'vm-123',
    hostname: 'test-vm',
    state: 'running',
    ip_addresses: [
      { type: 'ipv4', address: '10.20.30.40' },
      { type: 'ipv6', address: '2001:db8::3' },
    ],
    location: 'eu-west-1',
    plan_id: 'vps-starter',
    created_at: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

function makeFetchFn(responses = []) {
  let callIndex = 0;
  return async (_url, _init) => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    const { status, body } = response;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

// ── AC1/AC6: capabilities() ───────────────────────────────────────────────────

describe('HostingerAdapter — AC1/AC6: capabilities()', () => {
  it('liefert list/start/stop:true und create:false, delete:false', () => {
    const adapter = new HostingerAdapter();
    const caps = adapter.capabilities();
    expect(caps).toEqual({ list: true, start: true, stop: true, create: false, delete: false });
  });

  it('capabilities().create ist false (HOSTINGER_CREATE_UNSUPPORTED)', () => {
    const adapter = new HostingerAdapter();
    expect(adapter.capabilities().create).toBe(false);
  });
});

// ── AC1/AC3: listMachines() ───────────────────────────────────────────────────

describe('HostingerAdapter — AC1/AC3: listMachines()', () => {
  it('gibt eine leere Liste zurück wenn keine VMs vorhanden (leeres Array)', async () => {
    const fetchFn = makeFetchFn([{ status: 200, body: [] }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);
    expect(machines).toEqual([]);
  });

  it('gibt eine leere Liste zurück wenn Response { data: [] }', async () => {
    const fetchFn = makeFetchFn([{ status: 200, body: { data: [] } }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);
    expect(machines).toEqual([]);
  });

  it('normalisiert VM-Rohdaten auf VpsMachine-Schema (Array-Response)', async () => {
    const fetchFn = makeFetchFn([{
      status: 200,
      body: [makeVmRaw()],
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      provider: 'hostinger',
      serverId: 'vm-123',
      name: 'test-vm',
      status: 'running',
      ipv4: '10.20.30.40',
      ipv6: '2001:db8::3',
      region: 'eu-west-1',
      serverType: 'vps-starter',
      createdAt: '2026-03-01T00:00:00Z',
    });
  });

  it('normalisiert VM-Rohdaten auf VpsMachine-Schema ({ data: [...] }-Response)', async () => {
    const fetchFn = makeFetchFn([{
      status: 200,
      body: { data: [makeVmRaw({ id: 'vm-456', hostname: 'wrapped-vm' })] },
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);
    expect(machines).toHaveLength(1);
    expect(machines[0].serverId).toBe('vm-456');
    expect(machines[0].name).toBe('wrapped-vm');
  });

  it('wirft HostingerAdapterError bei 401 (auth-failed)', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { message: 'Unauthorized' },
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    await expect(adapter.listMachines(MOCK_TOKEN)).rejects.toThrow(HostingerAdapterError);
  });

  it('wirft HostingerAdapterError mit errorClass provider-auth-failed bei 401', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { message: 'Invalid API token' },
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HostingerAdapterError);
      expect(err.errorClass).toBe('provider-auth-failed');
      expect(err.httpStatus).toBe(401);
    }
  });

  it('AC10 — Token erscheint NICHT in HostingerAdapterError-Message bei 401', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { message: 'Bearer token-leak-test is invalid' },
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HostingerAdapterError);
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });

  it('wirft HostingerAdapterError mit provider-unavailable bei Timeout (AbortError)', async () => {
    const fetchFn = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    const adapter = new HostingerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HostingerAdapterError);
      expect(err.errorClass).toBe('provider-unavailable');
    }
  });

  it('wirft HostingerAdapterError mit provider-unavailable bei Netzwerkfehler', async () => {
    const fetchFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const adapter = new HostingerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HostingerAdapterError);
      expect(err.errorClass).toBe('provider-unavailable');
    }
  });

  it('wirft HostingerAdapterError mit provider-unavailable bei 500', async () => {
    const fetchFn = makeFetchFn([{ status: 500, body: { message: 'Internal Server Error' } }]);
    const adapter = new HostingerAdapter({ fetchFn });
    await expect(adapter.listMachines(MOCK_TOKEN)).rejects.toMatchObject({
      errorClass: 'provider-unavailable',
      httpStatus: 500,
    });
  });

  it('AC10 — Bearer-Token wird aus Netzwerkfehler-Message herausgefiltert', async () => {
    // Simulate a network error whose message accidentally contains a Bearer pattern
    const fetchFn = async () => {
      throw new Error(`Connection failed: Bearer ${MOCK_TOKEN} was rejected`);
    };
    const adapter = new HostingerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HostingerAdapterError);
      // sanitizeMsg strips "Bearer <token>" patterns
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });
});

// ── AC5: start() ──────────────────────────────────────────────────────────────

describe('HostingerAdapter — AC5: start()', () => {
  it('liefert { result: "ok" } bei Erfolg (200)', async () => {
    const fetchFn = makeFetchFn([{
      status: 200,
      body: { message: 'VM started' },
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.start('vm-123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('liefert { result: "ok" } bei Erfolg (204 No Content)', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 204,
      json: async () => { throw new Error('No body'); },
    });
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.start('vm-123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('idempotent: liefert { result: "ok" } bei 409 (already in target state)', async () => {
    const fetchFn = makeFetchFn([{
      status: 409,
      body: { message: 'VM is already running' },
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.start('vm-123', MOCK_TOKEN);
    expect(result.result).toBe('ok');
  });

  it('liefert { result: "error" } bei 404 (VM nicht gefunden)', async () => {
    const fetchFn = makeFetchFn([{
      status: 404,
      body: { message: 'Virtual machine not found' },
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.start('vm-999', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(result.reason).toMatch(/nicht gefunden/i);
  });

  it('liefert { result: "error" } bei 500', async () => {
    const fetchFn = makeFetchFn([{ status: 500, body: { message: 'Internal error' } }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.start('vm-123', MOCK_TOKEN);
    expect(result.result).toBe('error');
  });

  it('liefert { result: "error" } bei Netzwerkfehler', async () => {
    const fetchFn = async () => { throw new Error('ECONNREFUSED'); };
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.start('vm-123', MOCK_TOKEN);
    expect(result.result).toBe('error');
  });

  it('AC10 — Token erscheint NICHT in start-Fehlermeldung', async () => {
    const fetchFn = makeFetchFn([{
      status: 500,
      body: { message: 'Server error' },
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.start('vm-123', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(JSON.stringify(result)).not.toContain(MOCK_TOKEN);
  });
});

// ── AC5: stop() ───────────────────────────────────────────────────────────────

describe('HostingerAdapter — AC5: stop()', () => {
  it('liefert { result: "ok" } bei Erfolg (200)', async () => {
    const fetchFn = makeFetchFn([{
      status: 200,
      body: { message: 'VM stopped' },
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.stop('vm-123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('idempotent: liefert { result: "ok" } bei 409 (already stopped)', async () => {
    const fetchFn = makeFetchFn([{
      status: 409,
      body: { message: 'VM is already stopped' },
    }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.stop('vm-123', MOCK_TOKEN);
    expect(result.result).toBe('ok');
  });

  it('liefert { result: "error" } bei 404', async () => {
    const fetchFn = makeFetchFn([{ status: 404, body: { message: 'not found' } }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.stop('vm-999', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(result.reason).toMatch(/nicht gefunden/i);
  });

  it('AC10 — Token erscheint NICHT in stop-Fehlermeldung', async () => {
    const fetchFn = makeFetchFn([{ status: 500, body: { message: 'Server error' } }]);
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.stop('vm-123', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(JSON.stringify(result)).not.toContain(MOCK_TOKEN);
  });
});

// ── AC6: create() → unsupported ───────────────────────────────────────────────

describe('HostingerAdapter — AC6: create() → unsupported (HOSTINGER_CREATE_UNSUPPORTED)', () => {
  it('liefert { result: "unsupported" } ohne API-Aufruf', async () => {
    // fetchFn should never be called for create
    let fetchCalled = false;
    const fetchFn = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const adapter = new HostingerAdapter({ fetchFn });
    const result = await adapter.create(
      { name: 'new-vm', region: 'eu-west-1', serverType: 'vps-starter' },
      MOCK_TOKEN,
    );
    expect(result.result).toBe('unsupported');
    expect(fetchCalled).toBe(false);
  });

  it('liefert eine Begründung in reason', async () => {
    const adapter = new HostingerAdapter();
    const result = await adapter.create({}, MOCK_TOKEN);
    expect(result.result).toBe('unsupported');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('liefert KEIN error, wirft NICHT — AC6: unsupported ist kein Fehler', async () => {
    const adapter = new HostingerAdapter();
    await expect(adapter.create({}, MOCK_TOKEN)).resolves.toMatchObject({ result: 'unsupported' });
  });

  it('capabilities().create === false — konsistent mit create-Verhalten', () => {
    const adapter = new HostingerAdapter();
    expect(adapter.capabilities().create).toBe(false);
  });

  it('AC10 — Token erscheint NICHT in create-Antwort', async () => {
    const adapter = new HostingerAdapter();
    const result = await adapter.create({}, MOCK_TOKEN);
    expect(JSON.stringify(result)).not.toContain(MOCK_TOKEN);
  });
});

// ── Fehlerpfade: 403, 422, 429 ────────────────────────────────────────────────

describe('HostingerAdapter — Fehlerpfade (403/422/429)', () => {
  it('wirft HostingerAdapterError mit provider-auth-failed bei 403', async () => {
    const fetchFn = makeFetchFn([{ status: 403, body: { message: 'Forbidden' } }]);
    const adapter = new HostingerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HostingerAdapterError);
      expect(err.errorClass).toBe('provider-auth-failed');
      expect(err.httpStatus).toBe(403);
    }
  });

  it('wirft HostingerAdapterError mit validation-error bei 422', async () => {
    const fetchFn = makeFetchFn([{ status: 422, body: { message: 'Invalid request' } }]);
    const adapter = new HostingerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HostingerAdapterError);
      expect(err.errorClass).toBe('validation-error');
      expect(err.httpStatus).toBe(422);
    }
  });

  it('wirft HostingerAdapterError mit provider-unavailable bei 429 (Rate-Limit)', async () => {
    const fetchFn = makeFetchFn([{ status: 429, body: { message: 'Too many requests' } }]);
    const adapter = new HostingerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HostingerAdapterError);
      expect(err.errorClass).toBe('provider-unavailable');
      expect(err.httpStatus).toBe(429);
    }
  });

  it('AC10 — Token erscheint NICHT in 422-Fehlermeldung', async () => {
    const fetchFn = makeFetchFn([{ status: 422, body: { message: 'bad param' } }]);
    const adapter = new HostingerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });
});
