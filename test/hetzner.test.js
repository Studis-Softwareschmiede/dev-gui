/**
 * hetzner.test.js — Unit-Tests für den Hetzner Cloud API Adapter.
 *
 * Covers (vps-provider-boundary):
 *   AC1  — HetznerAdapter implementiert den VpsProvider-Vertrag (capabilities/list/start/stop/create)
 *   AC2  — capabilities().delete ausgewiesen (vps-delete)
 *   AC5  — start/stop liefern { result: "ok" } bei Erfolg; idempotent bei 422
 *   AC6  — Lifecycle-Aktion: Hetzner unterstützt alle vier → capabilities() alle true
 *   AC7  — create übergibt userData + sshPublicKeys als Params; Default-Image wenn keins angegeben
 *   AC8  — create-Antwort ist VpsMachine; Fehler → HetznerAdapterError ohne Token-Leak
 *   AC10 — Token erscheint NICHT in Fehlermeldungen / Antworten
 *
 * Covers (vps-delete): AC2 — capabilities().delete ausgewiesen
 *
 * Covers (vps-create-options AC15–AC17):
 *   AC15 — listDatacenters(token) ruft GET /v1/datacenters ab; selbe ADR-009-Disziplin
 *   AC16 — Rohdaten-Mapping: locationName + availableIds korrekt extrahiert
 *   AC17 — Graceful: Fehler bei /v1/datacenters → HetznerAdapterError (Registry degradiert dann)
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
  it('liefert alle fünf Lifecycle-Flags (inkl. delete:true)', () => {
    const adapter = new HetznerAdapter();
    const caps = adapter.capabilities();
    expect(caps).toEqual({ list: true, start: true, stop: true, create: true, delete: true });
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

// ── deleteServer() ────────────────────────────────────────────────────────────

describe('HetznerAdapter — deleteServer()', () => {
  it('liefert { result: "ok" } bei HTTP 204 (Erfolg)', async () => {
    const fetchFn = makeFetchFn([{ status: 204, body: null }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.deleteServer('123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('liefert { result: "ok" } bei HTTP 200 (Erfolg)', async () => {
    const fetchFn = makeFetchFn([{ status: 200, body: {} }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.deleteServer('123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('idempotent: liefert { result: "ok" } bei 404 (Server bereits gelöscht)', async () => {
    const fetchFn = makeFetchFn([{
      status: 404,
      body: { error: { code: 'not_found', message: 'server not found' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.deleteServer('999', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('liefert { result: "error" } bei 401 — Token erscheint NICHT im Fehlertext', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { error: { code: 'unauthorized', message: `Bearer ${MOCK_TOKEN} is invalid` } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.deleteServer('123', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(JSON.stringify(result)).not.toContain(MOCK_TOKEN);
  });

  it('liefert { result: "error" } bei Timeout (AbortError)', async () => {
    const fetchFn = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    const adapter = new HetznerAdapter({ fetchFn });
    const result = await adapter.deleteServer('123', MOCK_TOKEN);
    expect(result.result).toBe('error');
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

// ── S-161: listServerTypes() / listLocations() / listImages() (vps-create-options AC1–AC5) ──

describe('HetznerAdapter — S-161: listServerTypes()', () => {
  it('liefert Typen mit Preisen; deprecated ausgeblendet (AC1–AC3)', async () => {
    const fetchFn = makeFetchFn([{ status: 200, body: { server_types: [
      { name: 'cx23', cores: 2, memory: 4, disk: 40, deprecated: false,
        prices: [{ location: 'nbg1', price_monthly: { net: '3.79', gross: '4.51' }, price_hourly: { net: '0.006', gross: '0.007' } }] },
      { name: 'cx11', cores: 1, memory: 2, disk: 20, deprecated: true, prices: [] },
    ], meta: { pagination: { last_page: 1 } } } }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const types = await adapter.listServerTypes(MOCK_TOKEN);
    expect(types.map((t) => t.name)).toEqual(['cx23']); // deprecated cx11 ausgeblendet
    expect(types[0]).toMatchObject({ cores: 2, memory: 4, disk: 40 });
    expect(types[0].prices[0]).toMatchObject({ location: 'nbg1', monthly: { gross: '4.51' }, hourly: { gross: '0.007' } });
  });

  it('graceful bei fehlenden Preisfeldern', async () => {
    const fetchFn = makeFetchFn([{ status: 200, body: { server_types: [
      { name: 'cx23', cores: 2, memory: 4, disk: 40, deprecated: false, prices: [{ location: 'nbg1' }] },
    ], meta: { pagination: { last_page: 1 } } } }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const types = await adapter.listServerTypes(MOCK_TOKEN);
    expect(types[0].prices[0]).toMatchObject({ location: 'nbg1', monthly: null, hourly: null });
  });
});

describe('HetznerAdapter — S-161: listLocations()', () => {
  it('liefert Locations mit name (z.B. nbg1) + networkZone (AC4)', async () => {
    const fetchFn = makeFetchFn([{ status: 200, body: { locations: [
      { name: 'nbg1', network_zone: 'eu-central', city: 'Nuremberg', country: 'DE' },
    ] } }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const locs = await adapter.listLocations(MOCK_TOKEN);
    expect(locs[0]).toMatchObject({ name: 'nbg1', networkZone: 'eu-central', city: 'Nuremberg', country: 'DE' });
  });
});

describe('HetznerAdapter — S-161: listImages()', () => {
  it('liefert System-Images (AC5)', async () => {
    const fetchFn = makeFetchFn([{ status: 200, body: { images: [
      { name: 'ubuntu-26.04', description: 'Ubuntu 26.04', os_flavor: 'ubuntu', os_version: '26.04' },
    ], meta: { pagination: { last_page: 1 } } } }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const imgs = await adapter.listImages(MOCK_TOKEN);
    expect(imgs[0]).toMatchObject({ name: 'ubuntu-26.04', osFlavor: 'ubuntu', osVersion: '26.04' });
  });
});

// ── S-177 AC15–AC17: listDatacenters() ──────────────────────────────────────

describe('HetznerAdapter — S-177 AC15/AC16: listDatacenters()', () => {
  it('AC16 — extrahiert locationName + availableIds aus Hetzner-Rohdaten', async () => {
    const fetchFn = makeFetchFn([{
      status: 200,
      body: {
        datacenters: [
          {
            name: 'fsn1-dc14',
            location: { name: 'fsn1' },
            server_types: { available: [22, 32, 42], supported: [22, 32, 42], available_for_migration: [] },
          },
          {
            name: 'hel1-dc2',
            location: { name: 'hel1' },
            server_types: { available: [11, 22], supported: [11, 22], available_for_migration: [] },
          },
        ],
      },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const dcs = await adapter.listDatacenters(MOCK_TOKEN);
    expect(dcs).toHaveLength(2);
    expect(dcs[0]).toMatchObject({ locationName: 'fsn1', availableIds: [22, 32, 42] });
    expect(dcs[1]).toMatchObject({ locationName: 'hel1', availableIds: [11, 22] });
  });

  it('AC16 — leere datacenters-Liste → leeres Array (graceful)', async () => {
    const fetchFn = makeFetchFn([{ status: 200, body: { datacenters: [] } }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const dcs = await adapter.listDatacenters(MOCK_TOKEN);
    expect(dcs).toEqual([]);
  });

  it('AC16 — Datacenter ohne location.name wird ausgelassen (graceful)', async () => {
    const fetchFn = makeFetchFn([{
      status: 200,
      body: {
        datacenters: [
          { name: 'broken', location: null, server_types: { available: [1] } },
          { name: 'fsn1-dc14', location: { name: 'fsn1' }, server_types: { available: [22] } },
        ],
      },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const dcs = await adapter.listDatacenters(MOCK_TOKEN);
    expect(dcs).toHaveLength(1);
    expect(dcs[0].locationName).toBe('fsn1');
  });

  it('AC17 — wirft HetznerAdapterError bei HTTP 401 (Auth-Fehler)', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { error: { code: 'unauthorized', message: 'Invalid token' } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    await expect(adapter.listDatacenters(MOCK_TOKEN)).rejects.toThrow(HetznerAdapterError);
  });

  it('AC17 — Token erscheint NICHT in Fehlermeldung bei Datacenter-Fehler', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { error: { code: 'unauthorized', message: `Bearer ${MOCK_TOKEN} ist ungültig` } },
    }]);
    const adapter = new HetznerAdapter({ fetchFn });
    try {
      await adapter.listDatacenters(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(HetznerAdapterError);
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });

  it('AC15 — ruft GET /v1/datacenters auf (URL-Prüfung via capturedUrl)', async () => {
    let capturedUrl = null;
    const fetchFn = async (url, _init) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ datacenters: [] }),
      };
    };
    const adapter = new HetznerAdapter({ fetchFn });
    await adapter.listDatacenters(MOCK_TOKEN);
    expect(capturedUrl).toMatch(/\/v1\/datacenters/);
    // AC1/ADR-009: Token NICHT in URL
    expect(capturedUrl).not.toContain(MOCK_TOKEN);
  });

  it('AC15 — Bearer-Token im Authorization-Header (nie in URL)', async () => {
    let capturedHeaders = null;
    const fetchFn = async (_url, init) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ datacenters: [] }),
      };
    };
    const adapter = new HetznerAdapter({ fetchFn });
    await adapter.listDatacenters(MOCK_TOKEN);
    expect(capturedHeaders['Authorization']).toBe(`Bearer ${MOCK_TOKEN}`);
  });
});

// ── S-161: listServerTypes() — id-Feld für S-177 availability-Map ────────────

describe('HetznerAdapter — S-177: listServerTypes() liefert id-Feld', () => {
  it('AC16 — listServerTypes gibt id-Feld mit (benötigt für ID→name-Mapping)', async () => {
    const fetchFn = makeFetchFn([{ status: 200, body: { server_types: [
      { id: 22, name: 'cpx22', cores: 2, memory: 4, disk: 40, deprecated: false, prices: [] },
      { id: 11, name: 'cpx11', cores: 1, memory: 2, disk: 20, deprecated: true, prices: [] },
    ], meta: { pagination: { last_page: 1 } } } }]);
    const adapter = new HetznerAdapter({ fetchFn });
    const types = await adapter.listServerTypes(MOCK_TOKEN);
    // deprecated cpx11 ausgeblendet; nur cpx22 bleibt
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({ id: 22, name: 'cpx22' });
  });
});
