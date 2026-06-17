/**
 * ionos.test.js — Unit-Tests für den IONOS Cloud API Adapter.
 *
 * Covers:
 *   AC1  — IonosAdapter implementiert den VpsProvider-Vertrag (capabilities/list/start/stop/create)
 *   AC2  — capabilities().delete ausgewiesen (vps-delete)
 *   AC3  — listMachines() iteriert über alle Datacenters und aggregiert Server
 *   AC5  — start/stop liefern { result: "ok" } bei Erfolg; idempotent bei 422/already-in-target-state
 *   AC6  — capabilities() liefert alle vier Lifecycle-Flags als true (IONOS unterstützt alle)
 *   AC7  — create übergibt base64-kodierte userData; Default-Image-Fallback
 *   AC8  — create-Antwort ist VpsMachine; Fehler → IonosAdapterError ohne Token-Leak
 *   AC10 — Token erscheint NICHT in Fehlermeldungen / Antworten
 *
 * Covers (vps-delete): AC2 — capabilities().delete ausgewiesen
 *
 * Strategy:
 *   - fetchFn wird injiziert (kein echter Netzwerkaufruf)
 *   - Token ist ein Platzhalter-String; Tests prüfen, dass er nie in Errors auftaucht
 *   - Datacenter-Iteration: mehrere DCs → Server werden aggregiert
 *   - Composite serverId "<dcId>/<srvId>" wird korrekt kodiert und geparst
 */

import { describe, it, expect } from '@jest/globals';
import { IonosAdapter, IonosAdapterError } from '../src/vps/providers/ionos.js';

const MOCK_TOKEN = 'ionos-test-token-should-never-appear-in-output';

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

function makeDatacenterRaw(overrides = {}) {
  return {
    id: 'dc-001',
    properties: {
      name: 'Frankfurt DC',
      location: 'de/fra',
    },
    ...overrides,
  };
}

function makeServerRaw(overrides = {}) {
  return {
    id: 'srv-abc123',
    properties: {
      name: 'test-server',
      vmState: 'RUNNING',
      availabilityZone: 'ZONE_1',
      type: 'ENTERPRISE',
    },
    metadata: {
      state: 'AVAILABLE',
      createdDate: '2026-01-01T00:00:00Z',
    },
    entities: {
      nics: {
        items: [
          {
            entities: {
              ips: {
                items: [
                  { properties: { ip: '1.2.3.4' } },
                ],
              },
            },
          },
        ],
      },
    },
    ...overrides,
  };
}

/**
 * Creates a mock fetch that returns different responses for sequential calls.
 * Cycles back to last response when calls exceed the responses array length.
 */
function makeFetchFn(responses = []) {
  let callIndex = 0;
  return async (url, _init) => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;

    if (typeof response === 'function') {
      return response(url);
    }

    const { status, body } = response;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (body === null || body === undefined ? '' : JSON.stringify(body)),
    };
  };
}

/**
 * Creates a fetch that captures the URL + body of each call.
 */
function makeCapturingFetch(responses = []) {
  const calls = [];
  let callIndex = 0;
  const fetchFn = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    const { status, body } = response;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (body === null || body === undefined ? '' : JSON.stringify(body)),
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

// ── AC1/AC6: capabilities() ───────────────────────────────────────────────────

describe('IonosAdapter — AC1/AC6: capabilities()', () => {
  it('liefert alle fünf Lifecycle-Flags (inkl. delete:true)', () => {
    const adapter = new IonosAdapter();
    const caps = adapter.capabilities();
    expect(caps).toEqual({ list: true, start: true, stop: true, create: true, delete: true });
  });
});

// ── AC1/AC3: listMachines() — Datacenter-Iteration ───────────────────────────

describe('IonosAdapter — AC1/AC3: listMachines()', () => {
  it('gibt eine leere Liste zurück wenn keine Datacenters vorhanden', async () => {
    const fetchFn = makeFetchFn([{
      status: 200,
      body: { items: [] },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);
    expect(machines).toEqual([]);
  });

  it('gibt eine leere Liste zurück wenn Datacenter keine Server hat', async () => {
    const fetchFn = makeFetchFn([
      // GET /datacenters?depth=1
      { status: 200, body: { items: [makeDatacenterRaw()] } },
      // GET /datacenters/dc-001/servers?depth=1
      { status: 200, body: { items: [] } },
    ]);
    const adapter = new IonosAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);
    expect(machines).toEqual([]);
  });

  it('normalisiert Server-Rohdaten auf VpsMachine-Schema', async () => {
    const fetchFn = makeFetchFn([
      { status: 200, body: { items: [makeDatacenterRaw()] } },
      { status: 200, body: { items: [makeServerRaw()] } },
    ]);
    const adapter = new IonosAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      provider: 'ionos',
      serverId: 'dc-001/srv-abc123',
      name: 'test-server',
      status: 'running',
      ipv4: '1.2.3.4',
      region: 'ZONE_1',
      serverType: 'ENTERPRISE',
    });
  });

  it('aggregiert Server über mehrere Datacenters', async () => {
    const dc1 = makeDatacenterRaw({ id: 'dc-001' });
    const dc2 = makeDatacenterRaw({ id: 'dc-002', properties: { name: 'Berlin DC', location: 'de/txl' } });
    const srv1 = makeServerRaw({ id: 'srv-1', properties: { name: 'server-1', vmState: 'RUNNING', availabilityZone: 'ZONE_1', type: 'ENTERPRISE' } });
    const srv2 = makeServerRaw({ id: 'srv-2', properties: { name: 'server-2', vmState: 'SHUTOFF', availabilityZone: 'ZONE_2', type: 'ENTERPRISE' } });

    const fetchFn = makeFetchFn([
      // GET /datacenters
      { status: 200, body: { items: [dc1, dc2] } },
      // GET /datacenters/dc-001/servers
      { status: 200, body: { items: [srv1] } },
      // GET /datacenters/dc-002/servers
      { status: 200, body: { items: [srv2] } },
    ]);
    const adapter = new IonosAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);

    expect(machines).toHaveLength(2);
    expect(machines[0].serverId).toBe('dc-001/srv-1');
    expect(machines[1].serverId).toBe('dc-002/srv-2');
    expect(machines[0].status).toBe('running');
    expect(machines[1].status).toBe('stopped');
  });

  it('degradiert bei einzelnem DC-Fehler — übrige DCs werden weiter verarbeitet', async () => {
    const dc1 = makeDatacenterRaw({ id: 'dc-001' });
    const dc2 = makeDatacenterRaw({ id: 'dc-002' });
    const srv = makeServerRaw({ id: 'srv-ok' });

    const fetchFn = makeFetchFn([
      // GET /datacenters
      { status: 200, body: { items: [dc1, dc2] } },
      // GET /datacenters/dc-001/servers → Fehler
      { status: 500, body: { message: 'internal server error' } },
      // GET /datacenters/dc-002/servers → ok
      { status: 200, body: { items: [srv] } },
    ]);
    const adapter = new IonosAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);

    // dc-002 Server ist noch da trotz dc-001 Fehler
    expect(machines).toHaveLength(1);
    // compositeId uses dc-002 + the server id 'srv-ok' from makeServerRaw override
    expect(machines[0].serverId).toBe('dc-002/srv-ok');
  });

  it('wirft IonosAdapterError bei 401 (auth-failed) beim Datacenter-Abruf', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { message: 'Unauthorized' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    await expect(adapter.listMachines(MOCK_TOKEN)).rejects.toThrow(IonosAdapterError);
  });

  it('AC10 — Token erscheint NICHT in IonosAdapterError-Message bei 401', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { message: `Bearer ${MOCK_TOKEN} is invalid` },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(IonosAdapterError);
      expect(err.errorClass).toBe('provider-auth-failed');
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });

  it('wirft IonosAdapterError mit provider-unavailable bei Timeout (AbortError)', async () => {
    const fetchFn = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    const adapter = new IonosAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(IonosAdapterError);
      expect(err.errorClass).toBe('provider-unavailable');
    }
  });
});

// ── AC5: start() ──────────────────────────────────────────────────────────────

describe('IonosAdapter — AC5: start()', () => {
  it('liefert { result: "ok" } bei Erfolg (202)', async () => {
    const fetchFn = makeFetchFn([{
      status: 202,
      body: null,
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.start('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('idempotent: liefert { result: "ok" } bei 422 bereits-laufend', async () => {
    const fetchFn = makeFetchFn([{
      status: 422,
      body: { message: 'Server is already running' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.start('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result.result).toBe('ok');
  });

  it('liefert { result: "error" } bei 404 (Server nicht gefunden)', async () => {
    const fetchFn = makeFetchFn([{
      status: 404,
      body: { message: 'The requested resource could not be found' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.start('dc-001/srv-999', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(result.reason).toMatch(/nicht gefunden/i);
  });

  it('liefert { result: "error" } bei ungültiger composite serverId', async () => {
    const adapter = new IonosAdapter();
    const result = await adapter.start('invalid-no-slash', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(result.reason).toMatch(/serverId/i);
  });

  it('liefert { result: "error" } wenn serverId kein "/" hat (nur DC-Teil)', async () => {
    const adapter = new IonosAdapter();
    const result = await adapter.start('dc-001/', MOCK_TOKEN);
    expect(result.result).toBe('error');
  });

  it('AC10 — Token erscheint NICHT in start-Fehlermeldung', async () => {
    const fetchFn = makeFetchFn([{
      status: 500,
      body: { message: 'Internal server error' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.start('dc-001/srv-abc', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(JSON.stringify(result)).not.toContain(MOCK_TOKEN);
  });

  it('verwendet korrekte URL mit Datacenter-ID aus composite serverId', async () => {
    const capFetch = makeCapturingFetch([{ status: 202, body: null }]);
    const adapter = new IonosAdapter({ fetchFn: capFetch });
    await adapter.start('my-datacenter/my-server', MOCK_TOKEN);
    expect(capFetch.calls[0].url).toContain('/datacenters/my-datacenter/servers/my-server/start');
  });
});

// ── AC5: stop() ───────────────────────────────────────────────────────────────

describe('IonosAdapter — AC5: stop()', () => {
  it('liefert { result: "ok" } bei Erfolg (202)', async () => {
    const fetchFn = makeFetchFn([{
      status: 202,
      body: null,
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.stop('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('idempotent: liefert { result: "ok" } bei 422 bereits-gestoppt', async () => {
    const fetchFn = makeFetchFn([{
      status: 422,
      body: { message: 'Server is already stopped' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.stop('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result.result).toBe('ok');
  });

  it('liefert { result: "error" } bei 404', async () => {
    const fetchFn = makeFetchFn([{
      status: 404,
      body: { message: 'Not found' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.stop('dc-001/srv-999', MOCK_TOKEN);
    expect(result.result).toBe('error');
  });

  it('liefert { result: "error" } bei ungültiger composite serverId', async () => {
    const adapter = new IonosAdapter();
    const result = await adapter.stop('no-slash-here', MOCK_TOKEN);
    expect(result.result).toBe('error');
  });

  it('verwendet korrekte URL mit Datacenter-ID aus composite serverId', async () => {
    const capFetch = makeCapturingFetch([{ status: 202, body: null }]);
    const adapter = new IonosAdapter({ fetchFn: capFetch });
    await adapter.stop('dc-xyz/srv-xyz', MOCK_TOKEN);
    expect(capFetch.calls[0].url).toContain('/datacenters/dc-xyz/servers/srv-xyz/stop');
  });
});

// ── deleteServer() ────────────────────────────────────────────────────────────

describe('IonosAdapter — deleteServer()', () => {
  it('liefert { result: "ok" } bei HTTP 204 (Erfolg)', async () => {
    const fetchFn = makeFetchFn([{ status: 204, body: null }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.deleteServer('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('liefert { result: "ok" } bei HTTP 200 (Erfolg)', async () => {
    const fetchFn = makeFetchFn([{ status: 200, body: {} }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.deleteServer('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('idempotent: liefert { result: "ok" } bei 404 (Server bereits gelöscht)', async () => {
    const fetchFn = makeFetchFn([{
      status: 404,
      body: { message: 'The requested resource could not be found' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.deleteServer('dc-001/srv-gone', MOCK_TOKEN);
    expect(result).toEqual({ result: 'ok' });
  });

  it('liefert { result: "error" } bei 401 — Token erscheint NICHT im Fehlertext', async () => {
    const fetchFn = makeFetchFn([{
      status: 401,
      body: { message: `Bearer ${MOCK_TOKEN} is invalid` },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.deleteServer('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(JSON.stringify(result)).not.toContain(MOCK_TOKEN);
  });

  it('liefert { result: "error" } bei Timeout (AbortError)', async () => {
    const fetchFn = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.deleteServer('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result.result).toBe('error');
  });

  it('liefert { result: "error" } bei ungültiger composite-ID ohne "/"', async () => {
    const adapter = new IonosAdapter();
    const result = await adapter.deleteServer('invalid-no-slash', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(result.reason).toMatch(/serverId/i);
  });
});

// ── AC7/AC8: create() ─────────────────────────────────────────────────────────

describe('IonosAdapter — AC7/AC8: create()', () => {
  /**
   * Helper: builds fetch responses for a full create flow:
   *   1. GET /datacenters?depth=1
   *   2. GET /images?type=IMAGE
   *   3. POST /datacenters/{dcId}/servers
   */
  function makeCreateFetch({ dcItems, imageItems, createStatus, createBody }) {
    return makeFetchFn([
      { status: 200, body: { items: dcItems ?? [makeDatacenterRaw()] } },
      { status: 200, body: { items: imageItems ?? [] } },
      { status: createStatus ?? 202, body: createBody ?? makeServerRaw() },
    ]);
  }

  it('erstellt Server und gibt VpsMachine zurück', async () => {
    const fetchFn = makeCreateFetch({
      imageItems: [{ id: 'img-ubuntu-26', properties: { name: 'Ubuntu-26.04-x86_64' } }],
      createBody: makeServerRaw({ id: 'new-srv', properties: { name: 'new-server', vmState: 'RUNNING', availabilityZone: 'ZONE_1', type: 'ENTERPRISE' } }),
    });
    const adapter = new IonosAdapter({ fetchFn });
    const machine = await adapter.create(
      { name: 'new-server', region: 'de/fra', serverType: 'ENTERPRISE' },
      MOCK_TOKEN,
    );
    expect(machine).toMatchObject({
      provider: 'ionos',
      serverId: 'dc-001/new-srv',
      name: 'new-server',
    });
  });

  it('AC7 — base64-kodiert userData und übergibt sie in properties.userData des Volumes', async () => {
    const capFetch = makeCapturingFetch([
      { status: 200, body: { items: [makeDatacenterRaw()] } },
      { status: 200, body: { items: [{ id: 'img-u26', properties: { name: 'Ubuntu-26.04' } }] } },
      { status: 202, body: makeServerRaw({ id: 'srv-new' }) },
    ]);
    const adapter = new IonosAdapter({ fetchFn: capFetch });
    const userData = '#cloud-config\npackages:\n  - htop';
    await adapter.create(
      { name: 'srv', region: 'de/fra', serverType: 'ENTERPRISE', userData },
      MOCK_TOKEN,
    );
    // The create call is the third fetch call (index 2)
    const createBody = capFetch.calls[2].body;
    const volumeProps = createBody.entities.volumes.items[0].properties;
    // userData should be base64-encoded
    const expected = Buffer.from(userData, 'utf8').toString('base64');
    expect(volumeProps.userData).toBe(expected);
  });

  it('AC7 — sucht Ubuntu-26-Image als Default, fällt auf Ubuntu-24 zurück', async () => {
    const capFetch = makeCapturingFetch([
      { status: 200, body: { items: [makeDatacenterRaw()] } },
      // No Ubuntu-26 images, but Ubuntu-24 exists
      {
        status: 200,
        body: {
          items: [
            { id: 'img-ubuntu-24', properties: { name: 'Ubuntu-24.04-x86_64' } },
          ],
        },
      },
      { status: 202, body: makeServerRaw({ id: 'srv-new' }) },
    ]);
    const adapter = new IonosAdapter({ fetchFn: capFetch });
    await adapter.create(
      { name: 'srv', region: 'de/fra', serverType: 'ENTERPRISE' },
      MOCK_TOKEN,
    );
    const createBody = capFetch.calls[2].body;
    const volumeProps = createBody.entities.volumes.items[0].properties;
    expect(volumeProps.image).toBe('img-ubuntu-24');
  });

  it('AC7 — übergibt angegebene Image-UUID direkt ohne Suche', async () => {
    const capFetch = makeCapturingFetch([
      { status: 200, body: { items: [makeDatacenterRaw()] } },
      // Images endpoint should NOT be called when image is provided
      { status: 202, body: makeServerRaw({ id: 'srv-new' }) },
    ]);
    const adapter = new IonosAdapter({ fetchFn: capFetch });
    await adapter.create(
      { name: 'srv', region: 'de/fra', serverType: 'ENTERPRISE', image: 'custom-image-uuid' },
      MOCK_TOKEN,
    );
    // Only 2 calls: GET /datacenters + POST /servers (no GET /images)
    expect(capFetch.calls).toHaveLength(2);
    const createBody = capFetch.calls[1].body;
    const volumeProps = createBody.entities.volumes.items[0].properties;
    expect(volumeProps.image).toBe('custom-image-uuid');
  });

  it('AC8 — wirft IonosAdapterError bei fehlendem name', async () => {
    const adapter = new IonosAdapter();
    await expect(
      adapter.create({ name: '', region: 'de/fra', serverType: 'ENTERPRISE' }, MOCK_TOKEN),
    ).rejects.toThrow(IonosAdapterError);
  });

  it('AC8 — wirft IonosAdapterError bei fehlendem region', async () => {
    const adapter = new IonosAdapter();
    await expect(
      adapter.create({ name: 'srv', region: '', serverType: 'ENTERPRISE' }, MOCK_TOKEN),
    ).rejects.toThrow(IonosAdapterError);
  });

  it('AC8 — wirft IonosAdapterError bei fehlendem serverType', async () => {
    const adapter = new IonosAdapter();
    await expect(
      adapter.create({ name: 'srv', region: 'de/fra', serverType: '' }, MOCK_TOKEN),
    ).rejects.toThrow(IonosAdapterError);
  });

  it('AC8 — wirft IonosAdapterError wenn kein passendes Image gefunden', async () => {
    const fetchFn = makeFetchFn([
      { status: 200, body: { items: [makeDatacenterRaw()] } },
      { status: 200, body: { items: [] } }, // no images
    ]);
    const adapter = new IonosAdapter({ fetchFn });
    await expect(
      adapter.create({ name: 'srv', region: 'de/fra', serverType: 'ENTERPRISE' }, MOCK_TOKEN),
    ).rejects.toThrow(IonosAdapterError);
  });

  it('AC8 — wirft IonosAdapterError wenn kein Datacenter vorhanden', async () => {
    const fetchFn = makeFetchFn([
      { status: 200, body: { items: [] } }, // no datacenters
    ]);
    const adapter = new IonosAdapter({ fetchFn });
    await expect(
      adapter.create({ name: 'srv', region: 'de/fra', serverType: 'ENTERPRISE' }, MOCK_TOKEN),
    ).rejects.toThrow(IonosAdapterError);
  });

  it('AC8 — wirft IonosAdapterError bei 422 (ungültige Anfrage)', async () => {
    const fetchFn = makeFetchFn([
      { status: 200, body: { items: [makeDatacenterRaw()] } },
      { status: 200, body: { items: [{ id: 'img-26', properties: { name: 'Ubuntu-26.04' } }] } },
      { status: 422, body: { message: 'Invalid server type specified' } },
    ]);
    const adapter = new IonosAdapter({ fetchFn });
    try {
      await adapter.create(
        { name: 'srv', region: 'de/fra', serverType: 'INVALID' },
        MOCK_TOKEN,
      );
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(IonosAdapterError);
      expect(err.errorClass).toBe('validation-error');
      expect(err.httpStatus).toBe(422);
    }
  });

  it('AC10 — Token erscheint NICHT in create-Fehlermeldung (Bearer-Reflection)', async () => {
    // Simulates an API that reflects the Authorization header value in the error body
    const fetchFn = makeFetchFn([
      { status: 200, body: { items: [makeDatacenterRaw()] } },
      { status: 200, body: { items: [{ id: 'img-26', properties: { name: 'Ubuntu-26.04' } }] } },
      { status: 422, body: { message: `Bearer ${MOCK_TOKEN} is invalid` } },
    ]);
    const adapter = new IonosAdapter({ fetchFn });
    try {
      await adapter.create({ name: 'srv', region: 'de/fra', serverType: 'ENTERPRISE' }, MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(IonosAdapterError);
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });

  it('wählt Datacenter anhand der region aus', async () => {
    const dc1 = makeDatacenterRaw({ id: 'dc-fra', properties: { name: 'Frankfurt', location: 'de/fra' } });
    const dc2 = makeDatacenterRaw({ id: 'dc-txl', properties: { name: 'Berlin', location: 'de/txl' } });
    const capFetch = makeCapturingFetch([
      { status: 200, body: { items: [dc1, dc2] } },
      { status: 200, body: { items: [{ id: 'img-26', properties: { name: 'Ubuntu-26.04' } }] } },
      { status: 202, body: makeServerRaw({ id: 'srv-new' }) },
    ]);
    const adapter = new IonosAdapter({ fetchFn: capFetch });
    await adapter.create(
      { name: 'srv', region: 'de/txl', serverType: 'ENTERPRISE' },
      MOCK_TOKEN,
    );
    // POST should go to dc-txl
    expect(capFetch.calls[2].url).toContain('/datacenters/dc-txl/servers');
  });
});

// ── Finding 2: Idempotenz-Mapping — echte 422 dürfen NICHT als ok behandelt werden ──

describe('IonosAdapter — Finding 2: Idempotenz nur bei already-in-target-state', () => {
  it('start: echter Validation-422 (nicht already/running) → result:"error"', async () => {
    // A 422 with a generic validation message must NOT be swallowed as idempotent ok.
    // handleErrorResponse classifies this as errorClass:"validation-error" (not "already-in-target-state")
    // → the narrowed catch-block must propagate it as result:"error".
    const fetchFn = makeFetchFn([{
      status: 422,
      body: { message: 'Invalid request body' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.start('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(result.reason).toBeTruthy();
  });

  it('stop: echter Validation-422 (nicht already/stopped) → result:"error"', async () => {
    const fetchFn = makeFetchFn([{
      status: 422,
      body: { message: 'Invalid request body' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.stop('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result.result).toBe('error');
    expect(result.reason).toBeTruthy();
  });

  it('start: already-running 422 (enthält "running") → result:"ok" (idempotent)', async () => {
    // Regression guard: the already-in-target-state path still works correctly.
    const fetchFn = makeFetchFn([{
      status: 422,
      body: { message: 'Server is already running' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.start('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result.result).toBe('ok');
  });

  it('stop: already-stopped 422 (enthält "stopped") → result:"ok" (idempotent)', async () => {
    const fetchFn = makeFetchFn([{
      status: 422,
      body: { message: 'Server is already stopped' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    const result = await adapter.stop('dc-001/srv-abc123', MOCK_TOKEN);
    expect(result.result).toBe('ok');
  });
});

// ── AC10: Token-Leak-Test (allgemein) ─────────────────────────────────────────

describe('IonosAdapter — AC10: Token-Leak-Schutz', () => {
  it('Token erscheint nicht in IonosAdapterError bei Netzwerkfehler', async () => {
    // Real network errors (e.g. ECONNREFUSED) never contain the token — test with realistic error
    const fetchFn = async () => {
      throw new Error('connect ECONNREFUSED 1.2.3.4:443');
    };
    const adapter = new IonosAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(IonosAdapterError);
      expect(err.errorClass).toBe('provider-unavailable');
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });

  it('Token erscheint nicht in Rate-Limit-Fehler', async () => {
    const fetchFn = makeFetchFn([{
      status: 429,
      body: { message: 'Too many requests' },
    }]);
    const adapter = new IonosAdapter({ fetchFn });
    try {
      await adapter.listMachines(MOCK_TOKEN);
    } catch (err) {
      expect(err).toBeInstanceOf(IonosAdapterError);
      expect(err.errorClass).toBe('provider-unavailable');
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });
});

// ── Composite ServerId Parsing ────────────────────────────────────────────────

describe('IonosAdapter — Composite ServerId', () => {
  it('start mit DC-ID der das "/" enthält — richtiges Splitting', async () => {
    // Test that composite IDs with UUID-format (containing dashes) work correctly
    const dcId = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
    const srvId = 'cccccccc-4444-5555-6666-dddddddddddd';
    const compositeId = `${dcId}/${srvId}`;

    const capFetch = makeCapturingFetch([{ status: 202, body: null }]);
    const adapter = new IonosAdapter({ fetchFn: capFetch });
    const result = await adapter.start(compositeId, MOCK_TOKEN);
    expect(result.result).toBe('ok');
    expect(capFetch.calls[0].url).toContain(`/datacenters/${dcId}/servers/${srvId}/start`);
  });

  it('listMachines kodiert serverId korrekt als "<dcId>/<srvId>"', async () => {
    const fetchFn = makeFetchFn([
      { status: 200, body: { items: [makeDatacenterRaw({ id: 'dc-abc' })] } },
      { status: 200, body: { items: [makeServerRaw({ id: 'srv-xyz' })] } },
    ]);
    const adapter = new IonosAdapter({ fetchFn });
    const machines = await adapter.listMachines(MOCK_TOKEN);
    expect(machines[0].serverId).toBe('dc-abc/srv-xyz');
  });
});
