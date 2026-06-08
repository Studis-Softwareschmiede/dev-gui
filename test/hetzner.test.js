/**
 * hetzner.test.js — Unit-Tests für den Hetzner Cloud API Adapter.
 *
 * Covers:
 *   AC1  — HetznerAdapter implementiert den VpsProvider-Vertrag (capabilities/list/start/stop/create)
 *   AC5  — start/stop liefern { result: "ok" } bei Erfolg; idempotent bei 422
 *   AC6  — Lifecycle-Aktion: Hetzner unterstützt alle vier → capabilities() alle true
 *   AC7  — create übergibt userData + sshPublicKeys als Params; Default-Image wenn keins angegeben
 *   AC8  — create-Antwort ist VpsMachine; Fehler → HetznerAdapterError ohne Token-Leak
 *   AC10 — Token erscheint NICHT in Fehlermeldungen / Antworten
 *
 * Strategy:
 *   - fetchFn wird injiziert (kein echter Netzwerkaufruf)
 *   - Token ist ein Platzhalter-String; Tests prüfen, dass er nie in Errors auftaucht
 */

import { describe, it, expect } from '@jest/globals';
import { HetznerAdapter, HetznerAdapterError } from '../src/vps/providers/hetzner.js';

const MOCK_TOKEN = 'hetzner-test-token-should-never-appear-in-output';

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

function makeServerRaw(overrides = {}) {
  return {
    id: 123,
    name: 'test-server',
    status: 'running',
    public_net: {
      ipv4: { ip: '1.2.3.4' },
      ipv6: { ip: '2001:db8::1/64' },
    },
    datacenter: { location: { name: 'nbg1' } },
    server_type: { name: 'cx11' },
    created: '2026-01-01T00:00:00Z',
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

describe('HetznerAdapter — AC1/AC6: capabilities()', () => {
  it('liefert alle vier Lifecycle-Flags als true', () => {
    const adapter = new HetznerAdapter();
    const caps = adapter.capabilities();
    expect(caps).toEqual({ list: true, start: true, stop: true, create: true });
  });
});

// ── AC1/AC3: listMachines() ───────────────────────────────────────────────────

describe('HetznerAdapter — AC1/AC3: listMachines()', () => {
  it('gibt eine leere Liste zurück wenn keine Server vorhanden', async () => {
    const fetchFn = makeFetchFn([{
      status: 200,
      body: { servers: [], meta: { pagination: { last_page: 1 } } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);
    expect(machines).toEqual([]);
  });

  it('normalisiert Server-Rohdaten auf VpsMachine-Schema', async () => {
    const fetchFn = makeFetchFn([{
      status: 200,
      body: {
        servers: [makeServerRaw()],
        meta: { pagination: { last_page: 1 } },
      },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      provider: 'hetzner',
      serverId: '123',
      name: 'test-server',
      status: 'running',
      ipv4: '1.2.3.4',
      region: 'nbg1',
      serverType: 'cx11',
    });
  });

  it('wirft HetznerAdapterError bei 401 (auth-failed)', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { error: { code: 'unauthorized', message: 'Invalid token' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    await expect(adapter.listMachines(MOCK_TOKEN)).rejects.toThrow(HetznerAdapterError);
  });

  it('AC10 — Token erscheint NICHT in HetznerAdapterError-Message bei 401', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { error: { code: 'unauthorized', message: 'Bearer token-leak-test is invalid' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HetznerAdapterError);
      expect(err.errorClass).toBe('provider-auth-failed');
      // Token darf nicht in der Fehlermeldung erscheinen
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });

  it('wirft HetznerAdapterError mit provider-unavailable bei Timeout (AbortError)', async () => {
    const fetchFn = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    const adapter = new HetznerAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HetznerAdapterError);
      expect(err.errorClass).toBe('provider-unavailable');
    }
  });
});

// ── AC5: start() ──────────────────────────────────────────────────────────────

describe('HetznerAdapter — AC5: start()', () => {
  it('liefert { result: "ok" } bei Erfolg (201)', async () => {
    const fetchFn = makeFetchFn([{
      status: 201,
      body: { action: { id: 1, status: 'running' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.start('123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('idempotent: liefert { result: "ok" } bei 422 already-in-target-state', async () => {
    const fetchFn = makeFetchFn([{
      status: 422,
      body: { error: { code: 'action_failed', message: 'Server is already running' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.start('123', MOCK_TOKEN);
    expect(result.result).toBe('ok');
  });

  it('liefert { result: "error" } bei 404 (Server nicht gefunden)', async () => {
    const fetchFn = makeFetchFn([{
      status: 404,
      body: { error: { code: 'not_found', message: 'server not found' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.start('999', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(result.reason).toMatch(/nicht gefunden/i);
  });

  it('AC10 — Token erscheint NICHT in start-Fehlermeldung', async () => {
    const fetchFn = makeFetchFn([{
      status: 500,
      body: { error: { code: 'internal_error', message: 'Server error' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.start('123', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(JSON.stringify(result)).not.toContain(MOCK_TOKEN);
  });
});

// ── AC5: stop() ───────────────────────────────────────────────────────────────

describe('HetznerAdapter — AC5: stop()', () => {
  it('liefert { result: "ok" } bei Erfolg (201)', async () => {
    const fetchFn = makeFetchFn([{
      status: 201,
      body: { action: { id: 2, status: 'running' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.stop('123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('idempotent: liefert { result: "ok" } bei 422 already-stopped', async () => {
    const fetchFn = makeFetchFn([{
      status: 422,
      body: { error: { code: 'action_failed', message: 'Server is already off' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.stop('123', MOCK_TOKEN);
    expect(result.result).toBe('ok');
  });
});

// ── AC7/AC8: create() ─────────────────────────────────────────────────────────

describe('HetznerAdapter — AC7/AC8: create()', () => {
  it('erstellt Server und gibt VpsMachine zurück', async () => {
    const fetchFn = makeFetchFn([{
      status: 201,
      body: { server: makeServerRaw({ name: 'new-server', id: 456 }) },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const machine = await adapter.create(
      { name: 'new-server', region: 'nbg1', serverType: 'cx11' },
      MOCK_TOKEN,
    );
    expect(machine).toMatchObject({
      provider: 'hetzner',
      serverId: '456',
      name: 'new-server',
    });
  });

  it('AC7 — übergibt userData an die API (user_data-Feld)', async () => {
    let capturedBody = null;
    const fetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 201,
        json: async () => ({ server: makeServerRaw({ name: 'srv', id: 789 }) }),
      };
    };
    const adapter = new HetznerAdapter({ fetchFn });
    await adapter.create(
      {
        name: 'srv',
        region: 'fsn1',
        serverType: 'cx21',
        userData: '#cloud-config\npackages:\n  - htop',
      },
      MOCK_TOKEN,
    );
    expect(capturedBody.user_data).toBe('#cloud-config\npackages:\n  - htop');
  });

  it('AC7 — Default-Image "ubuntu-24.04" wenn kein image angegeben', async () => {
    let capturedBody = null;
    const fetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 201,
        json: async () => ({ server: makeServerRaw({ name: 'srv2', id: 101 }) }),
      };
    };
    const adapter = new HetznerAdapter({ fetchFn });
    await adapter.create({ name: 'srv2', region: 'hel1', serverType: 'cx11' }, MOCK_TOKEN);
    expect(capturedBody.image).toBe('ubuntu-24.04');
  });

  it('AC7 — Übernimmt angegebenes Image wenn vorhanden', async () => {
    let capturedBody = null;
    const fetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 201,
        json: async () => ({ server: makeServerRaw({ name: 'srv3', id: 102 }) }),
      };
    };
    const adapter = new HetznerAdapter({ fetchFn });
    await adapter.create(
      { name: 'srv3', region: 'nbg1', serverType: 'cx11', image: 'debian-12' },
      MOCK_TOKEN,
    );
    expect(capturedBody.image).toBe('debian-12');
  });

  it('AC8 — wirft HetznerAdapterError bei Validierungsfehler (fehlendes name)', async () => {
    const adapter = new HetznerAdapter();
    await expect(
      adapter.create({ name: '', region: 'nbg1', serverType: 'cx11' }, MOCK_TOKEN),
    ).rejects.toThrow(HetznerAdapterError);
  });

  it('AC8 — wirft HetznerAdapterError bei 422 (ungültige Region)', async () => {
    const fetchFn = makeFetchFn([{
      status: 422,
      body: { error: { code: 'invalid_input', message: 'invalid location' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    try {
      await adapter.create(
        { name: 'srv', region: 'invalid-region', serverType: 'cx11' },
        MOCK_TOKEN,
      );
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HetznerAdapterError);
      expect(err.errorClass).toBe('validation-error');
      expect(err.httpStatus).toBe(422);
    }
  });

  it('AC10 — Token erscheint NICHT in create-Fehlermeldung', async () => {
    const fetchFn = makeFetchFn([{
      status: 422,
      body: { error: { code: 'invalid_input', message: 'bad param' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    try {
      await adapter.create({ name: 'srv', region: 'invalid', serverType: 'cx11' }, MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });
});
