/**
 * VpsProviderRegistry.test.js — Unit-Tests für die VpsProviderRegistry.
 *
 * Covers:
 *   AC1  — Registry ist der einzige Ort, der Adapter-Aufrufe koordiniert;
 *           unbekannter Provider → VpsRegistryError
 *   AC2  — Provider ohne gesetzten Token → configured:false, kein API-Call
 *   AC3  — listAllMachines() aggregiert über alle konfigurierten Provider
 *   AC4  — Degradation: ein Provider-Fehler kippt nicht die Gesamt-Antwort (providerErrors)
 *   AC5  — start/stop routen an den richtigen Adapter
 *   AC6  — Provider-not-configured → VpsRegistryError("provider-not-configured")
 *   AC7  — create routen an den richtigen Adapter
 *   AC10 — Token erscheint NICHT in VpsRegistryError-Messages
 *
 * vps-ssh-key-assignment:
 *   AC3  — Label→PublicKey-Auflösung; Public-Keys als { root, alex } an build() übergeben
 *   AC4  — nur getPublicKey, kein getPlaintext für ssh/-Pfade
 *   AC5  — fehlendes Public-Key → CloudInitError(missing-ssh-key), kein Provider-Call
 *   AC6  — Audit ohne Key-Material
 *
 * Covers (vps-tunnel-provisioning / S-152):
 *   AC5  — create() ruft createTunnel('<sanitized-vpsname>') auf (Tunnel-Name = Servername) + Token in cloud-init
 *   AC6  — Token erscheint NICHT im Log/Response/Argv (Token-Floor)
 *   AC7  — tunnelId dem VPS zugeordnet (im CredentialStore gespeichert); keine Token-Referenz
 *   AC8  — Token im CredentialStore abgelegt (set() aufgerufen); kein Token in VpsMachine-Return
 *   AC9  — cloudflare-not-configured → Create ohne Tunnel, kein Crash
 *   AC10 — Token bleibt im CredentialStore auch wenn VPS-Start-Fehler (Persistenz-Reihenfolge)
 *
 * Covers (vps-create-options AC15–AC17 / S-177):
 *   AC15 — getProviderOptions('hetzner') ruft listDatacenters(token) im Adapter auf
 *   AC16 — availability-Map korrekt als Union je Location mit ID→name-Mapping gebaut;
 *           dedupliziert; ID ohne Match ausgelassen; Beispiel fsn1→cpx22 nicht cpx11
 *   AC17 — Graceful: listDatacenters-Fehler → availability weggelassen, Rest vollständig;
 *           Token erscheint nicht in availability/Response
 *
 * Strategy:
 *   - CredentialStore wird als Stub injiziert
 *   - Adapter werden als Stubs injiziert (kein echter Fetch)
 *   - CloudflareApi wird als Stub injiziert (kein echter Fetch)
 */

import { describe, it, expect } from '@jest/globals';
import { VpsProviderRegistry, VpsRegistryError } from '../src/vps/VpsProviderRegistry.js';

const MOCK_TOKEN = 'registry-test-token-never-in-output';

// ── Mock-Bausteine ─────────────────────────────────────────────────────────────

function makeCredentialStore(tokensByProvider = {}, publicKeysByLabel = {}) {
  const storedEntries = {};
  return {
    async getMeta(key) {
      // Gibt "set" wenn ein Token für den Provider gesetzt ist
      const provider = key.replace('credentials/vps/', '').replace('_api_token', '');
      return { status: tokensByProvider[provider] ? 'set' : 'unset' };
    },
    async getPlaintext(key) {
      const provider = key.replace('credentials/vps/', '').replace('_api_token', '');
      if (tokensByProvider[provider] !== undefined) {
        return tokensByProvider[provider] ?? null;
      }
      // Für misc/tunnel-id Lookups
      return storedEntries[key] ?? null;
    },
    async getPublicKey(label) {
      return publicKeysByLabel[label] ?? null;
    },
    async set(storeKey, value) {
      storedEntries[storeKey] = value;
      return { status: 'set', updatedAt: new Date().toISOString() };
    },
    async delete(storeKey) {
      delete storedEntries[storeKey];
      return { status: 'deleted' };
    },
    _storedEntries: storedEntries, // für Test-Assertions zugänglich
  };
}

function makeAdapter(overrides = {}) {
  return {
    capabilities: () => ({ list: true, start: true, stop: true, create: true }),
    listMachines: async (_token) => overrides.machines ?? [],
    start: async (_serverId, _token) => overrides.startResult ?? { result: 'ok' },
    stop: async (_serverId, _token) => overrides.stopResult ?? { result: 'ok' },
    create: async (_params, _token) => overrides.createResult ?? {
      provider: 'hetzner',
      serverId: '1',
      name: 'test',
      status: 'provisioning',
      ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null,
    },
  };
}

// ── AC2: listProviders() ──────────────────────────────────────────────────────

describe('VpsProviderRegistry — AC2: listProviders()', () => {
  it('gibt configured:false zurück wenn kein Token gesetzt', async () => {
    const store = makeCredentialStore({});
    const registry = new VpsProviderRegistry({ credentialStore: store });
    const providers = await registry.listProviders();
    expect(providers).toHaveLength(3);
    for (const p of providers) {
      expect(p.configured).toBe(false);
    }
  });

  it('gibt configured:true zurück wenn Token gesetzt', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({ credentialStore: store });
    const providers = await registry.listProviders();
    const hetzner = providers.find((p) => p.id === 'hetzner');
    expect(hetzner.configured).toBe(true);
    expect(hetzner.capabilities).toBeDefined();
  });

  it('enthält alle drei Provider (hetzner, ionos, hostinger)', async () => {
    const store = makeCredentialStore({});
    const registry = new VpsProviderRegistry({ credentialStore: store });
    const providers = await registry.listProviders();
    const ids = providers.map((p) => p.id);
    expect(ids).toContain('hetzner');
    expect(ids).toContain('ionos');
    expect(ids).toContain('hostinger');
  });
});

// ── AC3/AC4: listAllMachines() Degradation ────────────────────────────────────

describe('VpsProviderRegistry — AC3/AC4: listAllMachines() Degradation', () => {
  it('AC3 — aggregiert Maschinen aller konfigurierten Provider', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN, ionos: MOCK_TOKEN });
    const hetznerMachines = [
      { provider: 'hetzner', serverId: '1', name: 'h1', status: 'running',
        ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null },
    ];
    const ionosMachines = [
      { provider: 'ionos', serverId: 'i1', name: 'ionos-1', status: 'stopped',
        ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null },
    ];
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeAdapter({ machines: hetznerMachines }),
        ionos: makeAdapter({ machines: ionosMachines }),
        hostinger: makeAdapter({ machines: [] }),
      },
    });
    const result = await registry.listAllMachines();
    expect(result.machines).toHaveLength(2);
    expect(result.providerErrors).toBeUndefined();
  });

  it('AC2 — nicht konfigurierte Provider werden übersprungen (kein API-Call)', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN }); // ionos + hostinger nicht gesetzt
    let ionosCalled = false;
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeAdapter({ machines: [] }),
        ionos: {
          capabilities: () => ({ list: true, start: true, stop: true, create: true }),
          listMachines: async () => { ionosCalled = true; return []; },
          start: async () => ({ result: 'ok' }),
          stop: async () => ({ result: 'ok' }),
          create: async () => { throw new Error('no'); },
        },
        hostinger: makeAdapter({ machines: [] }),
      },
    });
    await registry.listAllMachines();
    expect(ionosCalled).toBe(false);
  });

  it('AC4 — ein Provider-Fehler kippt NICHT die Gesamt-Antwort (200 mit providerErrors)', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN, ionos: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeAdapter({ machines: [
          { provider: 'hetzner', serverId: '1', name: 'h1', status: 'running',
            ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null },
        ] }),
        ionos: {
          capabilities: () => ({ list: true, start: true, stop: true, create: true }),
          listMachines: async () => { throw new Error('IONOS timeout'); },
          start: async () => ({ result: 'ok' }),
          stop: async () => ({ result: 'ok' }),
          create: async () => { throw new Error('no'); },
        },
        hostinger: makeAdapter({ machines: [] }),
      },
    });
    const result = await registry.listAllMachines();
    // Hetzner-Maschinen sind noch da
    expect(result.machines).toHaveLength(1);
    // IONOS-Fehler im providerErrors
    expect(result.providerErrors).toBeDefined();
    expect(result.providerErrors).toHaveLength(1);
    expect(result.providerErrors[0].provider).toBe('ionos');
  });

  it('AC4 — leere machines wenn alle Provider nicht konfiguriert', async () => {
    const store = makeCredentialStore({});
    const registry = new VpsProviderRegistry({ credentialStore: store });
    const result = await registry.listAllMachines();
    expect(result.machines).toEqual([]);
    expect(result.providerErrors).toBeUndefined();
  });
});

// ── AC1/AC6: start() / stop() ─────────────────────────────────────────────────

describe('VpsProviderRegistry — AC1/AC5/AC6: start() / stop()', () => {
  it('AC5 — start() routet an den richtigen Adapter', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeAdapter({ startResult: { result: 'ok' } }),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    const result = await registry.start('hetzner', '123');
    expect(result).toEqual({ result: 'ok' });
  });

  it('AC5 — stop() routet an den richtigen Adapter', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeAdapter({ stopResult: { result: 'ok' } }),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    const result = await registry.stop('hetzner', '123');
    expect(result).toEqual({ result: 'ok' });
  });

  it('AC1 — unbekannter Provider → VpsRegistryError(unknown-provider)', async () => {
    const store = makeCredentialStore({});
    const registry = new VpsProviderRegistry({ credentialStore: store });
    await expect(registry.start('aws', '123')).rejects.toThrow(VpsRegistryError);
    try {
      await registry.start('aws', '123');
    } catch (err) {
      expect(err.errorClass).toBe('unknown-provider');
      expect(err.httpStatus).toBe(404);
    }
  });

  it('AC6 — nicht konfigurierter Provider → VpsRegistryError(provider-not-configured)', async () => {
    const store = makeCredentialStore({}); // kein Token für hetzner
    const registry = new VpsProviderRegistry({ credentialStore: store });
    try {
      await registry.start('hetzner', '123');
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(VpsRegistryError);
      expect(err.errorClass).toBe('provider-not-configured');
      expect(err.httpStatus).toBe(422);
    }
  });

  it('AC10 — Token erscheint NICHT in VpsRegistryError-Message', async () => {
    const store = makeCredentialStore({});
    const registry = new VpsProviderRegistry({ credentialStore: store });
    try {
      await registry.start('hetzner', '123');
    } catch (err) {
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });
});

// ── Konstanten für SSH-Test-Keys ───────────────────────────────────────────────

const ROOT_PUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRootKeyTestOnlyNotReal root@test';
const ALEX_PUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAlexKeyTestOnlyNotReal alex@test';

// ── AC7/AC8: create() ─────────────────────────────────────────────────────────

describe('VpsProviderRegistry — AC7: create()', () => {
  it('AC7 — routet create() an den richtigen Adapter mit Parametern', async () => {
    let capturedParams = null;
    // Store mit Token und Public-Keys für beide Labels
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );

    // CloudInitBuilder als Stub injizieren: gibt direkt ein gültiges #cloud-config zurück.
    // Die vollständige Validierung der CloudInitBuilder-Vorlage (AC1–AC8) liegt in
    // CloudInitBuilder.test.js. Hier wird nur geprüft, dass die Registry den Builder
    // aufruft und userData server-intern weitergibt (ADR-009).
    const cloudInitBuilderStub = { build: (_params) => '#cloud-config\n# stub\n' };

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudInitBuilder: cloudInitBuilderStub,
      adapters: {
        hetzner: {
          capabilities: () => ({ list: true, start: true, stop: true, create: true }),
          listMachines: async () => [],
          start: async () => ({ result: 'ok' }),
          stop: async () => ({ result: 'ok' }),
          create: async (params, _token) => {
            capturedParams = params;
            return { provider: 'hetzner', serverId: '42', name: params.name, status: 'provisioning',
              ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null };
          },
        },
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    // ADR-009: Client übergibt NUR fachliche Parameter + Label-Referenzen (sshKeyAssignment).
    // Die Registry löst Labels store-intern auf und erzeugt userData via CloudInitBuilder.
    const machine = await registry.create('hetzner', {
      name: 'new-srv',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });
    expect(capturedParams.name).toBe('new-srv');
    // userData wird server-intern erzeugt (CloudInitBuilder, ADR-009)
    expect(typeof capturedParams.userData).toBe('string');
    expect(capturedParams.userData).toMatch(/^#cloud-config/);
    // sshPublicKeys wird server-intern aufgelöst
    expect(capturedParams.sshPublicKeys).toBeDefined();
    expect(machine.serverId).toBe('42');
  });

  it('AC6 — create() für nicht konfigurierten Provider → VpsRegistryError', async () => {
    const store = makeCredentialStore({});
    const registry = new VpsProviderRegistry({ credentialStore: store });
    await expect(
      registry.create('ionos', { name: 'x', region: 'de', serverType: 'small' }),
    ).rejects.toThrow(VpsRegistryError);
  });
});

// ── S-164: Tunnel-Rollback bei fehlgeschlagenem VPS-Create (vps-create-options AC13/AC14) ──

describe('VpsProviderRegistry — S-164: Tunnel-Rollback bei Create-Fehler', () => {
  function makeCfApi({ createTunnel, deleteTunnel } = {}) {
    return {
      createTunnel: createTunnel ?? (async () => ({ tunnelId: 'T-rollback', token: 'tunnel-secret-never-logged' })),
      deleteTunnel: deleteTunnel ?? (async () => ({ result: 'ok' })),
      listRoutes: async () => [],
      removeRoute: async () => ({ result: 'ok' }),
      isProtected: () => false,
    };
  }
  function makeFailingRegistry(store, cloudflareApi, createErr) {
    return new VpsProviderRegistry({
      credentialStore: store,
      cloudInitBuilder: { build: () => '#cloud-config\n# stub\n' },
      cloudflareApi,
      adapters: {
        hetzner: { capabilities: () => ({ list: true, start: true, stop: true, create: true }),
          listMachines: async () => [], start: async () => ({ result: 'ok' }), stop: async () => ({ result: 'ok' }),
          create: async () => { throw createErr; } },
        ionos: makeAdapter(), hostinger: makeAdapter(),
      },
    });
  }
  const validParams = { name: 'rollback-srv', region: 'nbg1', serverType: 'cx-invalid', sshKeyAssignment: { root: 'root', alex: 'alex' } };

  it('AC13/AC14: adapter.create() wirft → deleteTunnel(tunnelId) aufgerufen + Original-Fehler propagiert', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN }, { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY });
    const deleted = [];
    const cf = makeCfApi({ deleteTunnel: async (id) => { deleted.push(id); return { result: 'ok' }; } });
    const registry = makeFailingRegistry(store, cf, new Error('Server-Typ ungültig (cx-invalid)'));
    await expect(registry.create('hetzner', validParams)).rejects.toThrow('Server-Typ ungültig');
    expect(deleted).toContain('T-rollback');
  });

  it('AC9: cloudflare-not-configured (kein Tunnel angelegt) → kein deleteTunnel beim Create-Fehler', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN }, { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY });
    const deleted = [];
    const cf = makeCfApi({
      createTunnel: async () => { const e = new Error('not configured'); e.errorClass = 'cloudflare-not-configured'; throw e; },
      deleteTunnel: async (id) => { deleted.push(id); },
    });
    const registry = makeFailingRegistry(store, cf, new Error('boom'));
    await expect(registry.create('hetzner', validParams)).rejects.toThrow('boom');
    expect(deleted).toEqual([]);
  });

  it('AC14: Rollback-Fehler maskiert den Original-Create-Fehler NICHT', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN }, { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY });
    const cf = makeCfApi({ deleteTunnel: async () => { throw new Error('rollback failed'); } });
    const registry = makeFailingRegistry(store, cf, new Error('original create error'));
    await expect(registry.create('hetzner', validParams)).rejects.toThrow('original create error');
  });
});

// ── AC3/AC4/AC5: SSH-Key-Auflösung (vps-ssh-key-assignment) ──────────────────

import { CloudInitError } from '../src/vps/CloudInitBuilder.js';

describe('VpsProviderRegistry — SSH-Key-Auflösung (vps-ssh-key-assignment)', () => {
  /** Baut einen Adapter-Stub, der die übergebenen sshPublicKeys aufzeichnet. */
  function makeCaptureAdapter() {
    let captured = null;
    return {
      getCapture: () => captured,
      adapter: {
        capabilities: () => ({ list: true, start: true, stop: true, create: true }),
        listMachines: async () => [],
        start: async () => ({ result: 'ok' }),
        stop: async () => ({ result: 'ok' }),
        create: async (params, _token) => {
          captured = params;
          return { provider: 'hetzner', serverId: '99', name: params.name, status: 'provisioning',
            ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null };
        },
      },
    };
  }

  it('AC3 — löst Label-Referenzen zu Public-Keys auf und übergibt { root, alex } an build()', async () => {
    let buildArgs = null;
    const cloudInitBuilderStub = {
      build: (params) => { buildArgs = params; return '#cloud-config\n# stub\n'; },
    };
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    const { adapter } = makeCaptureAdapter();
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudInitBuilder: cloudInitBuilderStub,
      adapters: { hetzner: adapter, ionos: makeAdapter(), hostinger: makeAdapter() },
    });

    await registry.create('hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    // build() muss die aufgelösten Public-Keys erhalten
    expect(buildArgs).not.toBeNull();
    expect(buildArgs.sshPublicKeys.root).toBe(ROOT_PUB_KEY);
    expect(buildArgs.sshPublicKeys.alex).toBe(ALEX_PUB_KEY);
  });

  it('AC4 — nur Public-Keys verlassen den Store (kein Private-Key-Pfad)', async () => {
    let buildArgs = null;
    const cloudInitBuilderStub = {
      build: (params) => { buildArgs = params; return '#cloud-config\n# stub\n'; },
    };
    // Store mit Public-Key; kein Zugriff auf getPlaintext für ssh-Pfade
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    // getPlaintext-Aufrufe für SSH-Pfade überwachen — dürfen NICHT vorkommen
    let plaintextCalledForSsh = false;
    const origGetPlaintext = store.getPlaintext.bind(store);
    store.getPlaintext = async (key) => {
      if (key.startsWith('ssh/')) plaintextCalledForSsh = true;
      return origGetPlaintext(key);
    };

    const { adapter } = makeCaptureAdapter();
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudInitBuilder: cloudInitBuilderStub,
      adapters: { hetzner: adapter, ionos: makeAdapter(), hostinger: makeAdapter() },
    });

    await registry.create('hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    // Private-Key-Klartext-Pfad darf für SSH-Schlüssel NICHT aufgerufen werden
    expect(plaintextCalledForSsh).toBe(false);
    // build() erhält nur Public-Keys (kein Private-Key-Material)
    expect(buildArgs.sshPublicKeys.root).toBe(ROOT_PUB_KEY);
    expect(buildArgs.sshPublicKeys.alex).toBe(ALEX_PUB_KEY);
  });

  it('AC5 — fehlendes Public-Key für root → CloudInitError(missing-ssh-key)', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { alex: ALEX_PUB_KEY }, // kein root-Key
    );
    // Echter CloudInitBuilder — wirft bei fehlendem Key
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: { hetzner: makeAdapter(), ionos: makeAdapter(), hostinger: makeAdapter() },
    });

    await expect(
      registry.create('hetzner', {
        name: 'srv',
        region: 'nbg1',
        serverType: 'cx11',
        sshKeyAssignment: { root: 'root', alex: 'alex' },
      }),
    ).rejects.toBeInstanceOf(CloudInitError);

    try {
      await registry.create('hetzner', {
        name: 'srv',
        region: 'nbg1',
        serverType: 'cx11',
        sshKeyAssignment: { root: 'root', alex: 'alex' },
      });
    } catch (err) {
      expect(err.errorClass).toBe('missing-ssh-key');
      expect(err.httpStatus).toBe(422);
    }
  });

  it('AC5 — fehlendes Public-Key für alex → CloudInitError(missing-ssh-key)', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY }, // kein alex-Key
    );
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: { hetzner: makeAdapter(), ionos: makeAdapter(), hostinger: makeAdapter() },
    });

    await expect(
      registry.create('hetzner', {
        name: 'srv',
        region: 'nbg1',
        serverType: 'cx11',
        sshKeyAssignment: { root: 'root', alex: 'alex' },
      }),
    ).rejects.toBeInstanceOf(CloudInitError);
  });

  it('AC5 — kein sshKeyAssignment übergeben → CloudInitError(missing-ssh-key) (kein Provider-Call)', async () => {
    let adapterCalled = false;
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN }, {});
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: {
          capabilities: () => ({ list: true, start: true, stop: true, create: true }),
          listMachines: async () => [],
          start: async () => ({ result: 'ok' }),
          stop: async () => ({ result: 'ok' }),
          create: async () => { adapterCalled = true; return {}; },
        },
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });

    await expect(
      registry.create('hetzner', { name: 'srv', region: 'nbg1', serverType: 'cx11' }),
    ).rejects.toBeInstanceOf(CloudInitError);

    // kein Provider-Call bei fehlendem Key
    expect(adapterCalled).toBe(false);
  });

  it('AC3 — Default-Vorbelegung: gleichnamiges Label "root"/"alex" wird korrekt aufgelöst', async () => {
    let buildArgs = null;
    const cloudInitBuilderStub = {
      build: (params) => { buildArgs = params; return '#cloud-config\n# stub\n'; },
    };
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    const { adapter } = makeCaptureAdapter();
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudInitBuilder: cloudInitBuilderStub,
      adapters: { hetzner: adapter, ionos: makeAdapter(), hostinger: makeAdapter() },
    });

    // Labels entsprechen den Rollen-Namen (gleichnamige Default-Zuordnung)
    await registry.create('hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    expect(buildArgs.sshPublicKeys.root).toBe(ROOT_PUB_KEY);
    expect(buildArgs.sshPublicKeys.alex).toBe(ALEX_PUB_KEY);
  });

  it('AC6 — Audit ohne Key-Material: sshPublicKeys erscheint nicht in VpsRegistryError-Messages', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN }, {});
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: { hetzner: makeAdapter(), ionos: makeAdapter(), hostinger: makeAdapter() },
      cloudflareApi: null, // kein Tunnel (CF nicht konfiguriert)
    });

    try {
      await registry.create('hetzner', {
        name: 'srv',
        region: 'nbg1',
        serverType: 'cx11',
        sshKeyAssignment: { root: 'root', alex: 'alex' },
      });
    } catch (err) {
      // Fehlermeldung darf keine Public-Key-Werte enthalten
      expect(err.message).not.toContain(ROOT_PUB_KEY);
      expect(err.message).not.toContain(ALEX_PUB_KEY);
      expect(err.message).not.toContain(MOCK_TOKEN);
    }
  });
});

// ── vps-tunnel-provisioning S-152: Tunnel-Provisionierung beim Create ────────

const MOCK_TUNNEL_ID = 'cf-tunnel-uuid-1234';
const MOCK_TUNNEL_TOKEN = 'eyJhbGci.mock-tunnel-token-never-in-output';

/**
 * Baut einen CloudflareApi-Stub.
 * @param {object} [opts]
 * @param {boolean} [opts.notConfigured] - wirft cloudflare-not-configured
 * @param {boolean} [opts.authFailed] - wirft cloudflare-auth-failed
 * @returns {{ stub: object, calls: string[] }}
 */
function makeCloudflareApiStub(opts = {}) {
  const calls = [];
  const stub = {
    async createTunnel(name) {
      calls.push(`createTunnel:${name}`);
      if (opts.notConfigured) {
        const err = new Error('Cloudflare not configured');
        err.errorClass = 'cloudflare-not-configured';
        throw err;
      }
      if (opts.authFailed) {
        const err = new Error('Cloudflare auth failed');
        err.errorClass = 'cloudflare-auth-failed';
        throw err;
      }
      return { tunnelId: MOCK_TUNNEL_ID, token: MOCK_TUNNEL_TOKEN };
    },
  };
  return { stub, calls };
}

/** Baut einen CloudInitBuilder-Stub, der die build()-Argumente aufzeichnet. */
function makeBuildCapture() {
  let captured = null;
  const stub = {
    build(params) {
      captured = params;
      return '#cloud-config\n# stub\n';
    },
  };
  return { stub, getCapture: () => captured };
}

describe('VpsProviderRegistry — S-152 Tunnel-Provisionierung beim Create', () => {
  it('AC5 — createTunnel("<sanitized-vpsname>") wird aufgerufen (Tunnel-Name = Servername)', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    const { stub: cfStub, calls } = makeCloudflareApiStub();
    const { stub: builderStub } = makeBuildCapture();

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: cfStub,
      cloudInitBuilder: builderStub,
      adapters: {
        hetzner: makeAdapter(),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });

    await registry.create('hetzner', {
      name: 'My Server 01',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    // Tunnel-Name-Konvention: Servername sanitisiert, kein Präfix (lowercase, alphanumerisch+Bindestrich)
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^createTunnel:my-server-01$/);
  });

  it('AC5 — tunnelToken wird an CloudInitBuilder.build() übergeben', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    const { stub: cfStub } = makeCloudflareApiStub();
    const { stub: builderStub, getCapture } = makeBuildCapture();

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: cfStub,
      cloudInitBuilder: builderStub,
      adapters: {
        hetzner: makeAdapter(),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });

    await registry.create('hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const buildArgs = getCapture();
    expect(buildArgs).not.toBeNull();
    // tunnelToken wurde an build() übergeben
    expect(buildArgs.tunnelToken).toBe(MOCK_TUNNEL_TOKEN);
  });

  it('AC7/AC8 — Token wird im CredentialStore abgelegt (credentials/cloudflare/tunnel_token/<tunnelId>)', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    const setCallKeys = [];
    const origSet = store.set.bind(store);
    store.set = async (key, value) => {
      setCallKeys.push(key);
      return origSet(key, value);
    };

    const { stub: cfStub } = makeCloudflareApiStub();
    const { stub: builderStub } = makeBuildCapture();

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: cfStub,
      cloudInitBuilder: builderStub,
      adapters: {
        hetzner: makeAdapter(),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });

    await registry.create('hetzner', {
      name: 'my-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    // Token muss unter credentials/cloudflare/tunnel_token/<tunnelId> abgelegt sein
    const tokenKey = `credentials/cloudflare/tunnel_token/${MOCK_TUNNEL_ID}`;
    expect(setCallKeys).toContain(tokenKey);

    // Tunnel-ID muss ebenfalls abgelegt sein (AC7 — Zuordnung VPS ↔ Tunnel)
    const idKey = `credentials/misc/vps-my-vps-tunnel-id`;
    expect(setCallKeys).toContain(idKey);

    // Tunnel-ID-Wert ist korrekt
    expect(store._storedEntries[idKey]).toBe(MOCK_TUNNEL_ID);
  });

  it('AC8 — Token erscheint NICHT in der Create-Response (VpsMachine)', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    const { stub: cfStub } = makeCloudflareApiStub();
    const { stub: builderStub } = makeBuildCapture();

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: cfStub,
      cloudInitBuilder: builderStub,
      adapters: {
        hetzner: makeAdapter(),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });

    const machine = await registry.create('hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    // Token darf NICHT in der VpsMachine / Create-Response erscheinen (AC8 / security/R01)
    const machineStr = JSON.stringify(machine);
    expect(machineStr).not.toContain(MOCK_TUNNEL_TOKEN);
    expect(machineStr).not.toContain('tunnel_token');
  });

  it('AC9 — cloudflare-not-configured → Create ohne Tunnel, kein Crash', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    const { stub: cfStub } = makeCloudflareApiStub({ notConfigured: true });
    let buildArgs = null;
    const builderStub = { build: (p) => { buildArgs = p; return '#cloud-config\n# stub\n'; } };

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: cfStub,
      cloudInitBuilder: builderStub,
      adapters: {
        hetzner: makeAdapter(),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });

    // Kein Crash — Create läuft durch (AC9)
    const machine = await registry.create('hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    expect(machine).toBeDefined();
    // Kein tunnelToken in build()-Aufruf (da CF nicht konfiguriert)
    expect(buildArgs).not.toBeNull();
    expect(buildArgs.tunnelToken).toBeUndefined();
  });

  it('AC9 — kein cloudflareApi injiziert → Create ohne Tunnel, kein Crash', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    let buildArgs = null;
    const builderStub = { build: (p) => { buildArgs = p; return '#cloud-config\n# stub\n'; } };

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: null, // kein CF
      cloudInitBuilder: builderStub,
      adapters: {
        hetzner: makeAdapter(),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });

    const machine = await registry.create('hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    expect(machine).toBeDefined();
    // Kein Token weitergegeben
    expect(buildArgs.tunnelToken).toBeUndefined();
  });

  it('AC9 — andere CF-Fehler (auth-failed) → Create bricht ab', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    const { stub: cfStub } = makeCloudflareApiStub({ authFailed: true });
    const builderStub = { build: () => '#cloud-config\n# stub\n' };

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: cfStub,
      cloudInitBuilder: builderStub,
      adapters: {
        hetzner: makeAdapter(),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });

    // Auth-Fehler → Create bricht ab (kein VPS-Create ohne Tunnel bei CF-Fehler ≠ not-configured)
    await expect(
      registry.create('hetzner', {
        name: 'srv',
        region: 'nbg1',
        serverType: 'cx11',
        sshKeyAssignment: { root: 'root', alex: 'alex' },
      }),
    ).rejects.toMatchObject({ errorClass: 'cloudflare-auth-failed' });
  });

  it('AC6 Token-Floor — tunnelToken erscheint NICHT im tunnelId-Wert im CredentialStore', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    const { stub: cfStub } = makeCloudflareApiStub();
    const { stub: builderStub } = makeBuildCapture();

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: cfStub,
      cloudInitBuilder: builderStub,
      adapters: {
        hetzner: makeAdapter(),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });

    await registry.create('hetzner', {
      name: 'srv',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    // Tunnel-ID-Zuordnung darf NUR die tunnelId enthalten, NICHT das Token
    const idKey = 'credentials/misc/vps-srv-tunnel-id';
    const storedIdValue = store._storedEntries[idKey];
    expect(storedIdValue).toBe(MOCK_TUNNEL_ID);
    expect(storedIdValue).not.toContain(MOCK_TUNNEL_TOKEN);
  });

  it('AC10/S-164 — Adapter-Create-Fehler → Tunnel-Rollback (Token + Tunnel entfernt, kein verwaister Tunnel)', async () => {
    const store = makeCredentialStore(
      { hetzner: MOCK_TOKEN },
      { root: ROOT_PUB_KEY, alex: ALEX_PUB_KEY },
    );
    // S-164 überschreibt die ursprüngliche S-152-AC10-Annahme ("Token bleibt"): der beim
    // Create vorab angelegte Tunnel war bei einem Adapter-Fehler GENAU das Problem (verwaister
    // Tunnel → "Cloudflare resource already exists" beim nächsten Versuch). Daher: Rollback.
    const deletedTunnels = [];
    const cfStub = {
      async createTunnel(_name) { return { tunnelId: MOCK_TUNNEL_ID, token: MOCK_TUNNEL_TOKEN }; },
      async deleteTunnel(id) { deletedTunnels.push(id); return { result: 'ok' }; },
      async listRoutes(_id) { return []; },
      async removeRoute(_id, _h) { return { result: 'ok' }; },
      isProtected() { return false; },
    };
    const { stub: builderStub } = makeBuildCapture();

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: cfStub,
      cloudInitBuilder: builderStub,
      adapters: {
        hetzner: {
          capabilities: () => ({ list: true, start: true, stop: true, create: true }),
          listMachines: async () => [],
          start: async () => ({ result: 'ok' }),
          stop: async () => ({ result: 'ok' }),
          create: async () => { throw new Error('Provider-API nicht erreichbar'); },
        },
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });

    // Create schlägt beim Adapter fehl → S-164: Tunnel zurückrollen, Original-Fehler propagieren.
    await expect(
      registry.create('hetzner', {
        name: 'my-vps',
        region: 'nbg1',
        serverType: 'cx23',
        sshKeyAssignment: { root: 'root', alex: 'alex' },
      }),
    ).rejects.toThrow('Provider-API nicht erreichbar');

    // Rollback: Tunnel gelöscht + Token-Referenz aus dem Store entfernt (kein verwaistes Geheimnis).
    expect(deletedTunnels).toContain(MOCK_TUNNEL_ID);
    const tokenKey = `credentials/cloudflare/tunnel_token/${MOCK_TUNNEL_ID}`;
    expect(store._storedEntries[tokenKey]).toBeUndefined();
  });
});

// ── S-161: getProviderOptions() (vps-create-options AC1–AC5) ──────────────────

describe('VpsProviderRegistry — S-161: getProviderOptions()', () => {
  it('hetzner → optionsAvailable:true mit serverTypes/locations/images', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: {
          ...makeAdapter(),
          listServerTypes: async () => [{ name: 'cx23', cores: 2, memory: 4, disk: 40, prices: [] }],
          listLocations: async () => [{ name: 'nbg1', networkZone: 'eu-central' }],
          listImages: async () => [{ name: 'ubuntu-26.04' }],
        },
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    const opts = await registry.getProviderOptions('hetzner');
    expect(opts.optionsAvailable).toBe(true);
    expect(opts.serverTypes[0].name).toBe('cx23');
    expect(opts.locations[0].name).toBe('nbg1');
    expect(opts.images[0].name).toBe('ubuntu-26.04');
  });

  it('nicht-hetzner Provider → optionsAvailable:false (Freitext-Fallback)', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN, ionos: 'tok' });
    const registry = new VpsProviderRegistry({ credentialStore: store });
    expect(await registry.getProviderOptions('ionos')).toEqual({ optionsAvailable: false });
  });

  it('hetzner nicht konfiguriert (kein Token) → optionsAvailable:false', async () => {
    const store = makeCredentialStore({});
    const registry = new VpsProviderRegistry({ credentialStore: store });
    expect(await registry.getProviderOptions('hetzner')).toEqual({ optionsAvailable: false });
  });
});

// ── S-177 AC15–AC17: getProviderOptions() + availability-Map ─────────────────

describe('VpsProviderRegistry — S-177 AC15–AC17: availability-Map in getProviderOptions()', () => {
  /**
   * Baut einen Hetzner-Adapter-Stub mit listDatacenters-Unterstützung.
   * serverTypesWithIds enthält {id, name, ...} wie der echte Adapter jetzt liefert (AC16).
   */
  function makeHetznerAdapterWithDatacenters({ serverTypesWithIds, datacenters, datacenterError } = {}) {
    return {
      ...makeAdapter(),
      listServerTypes: async () => serverTypesWithIds ?? [
        { id: 22, name: 'cpx22', cores: 2, memory: 4, disk: 40, prices: [] },
        { id: 32, name: 'cpx32', cores: 3, memory: 8, disk: 80, prices: [] },
        { id: 11, name: 'cpx11', cores: 1, memory: 2, disk: 20, prices: [] },
      ],
      listLocations: async () => [{ name: 'fsn1', networkZone: 'eu-central' }],
      listImages: async () => [{ name: 'ubuntu-26.04' }],
      listDatacenters: async () => {
        if (datacenterError) throw datacenterError;
        return datacenters ?? [
          // fsn1-dc14: cpx22 (id=22) + cpx32 (id=32), KEIN cpx11
          { locationName: 'fsn1', availableIds: [22, 32] },
          // hel1-dc2: cpx22 (id=22)
          { locationName: 'hel1', availableIds: [22] },
          // ash: cpx11 (id=11) + cpx22 (id=22)
          { locationName: 'ash', availableIds: [11, 22] },
        ];
      },
    };
  }

  it('AC15 — getProviderOptions ruft listDatacenters(token) im Adapter auf', async () => {
    let datacentersCalled = false;
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: {
          ...makeAdapter(),
          listServerTypes: async () => [],
          listLocations: async () => [],
          listImages: async () => [],
          listDatacenters: async (_token) => {
            datacentersCalled = true;
            return [];
          },
        },
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    await registry.getProviderOptions('hetzner');
    expect(datacentersCalled).toBe(true);
  });

  it('AC16 — availability-Map: Union je Location, ID→name-Mapping, korrekte Beispiele', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeHetznerAdapterWithDatacenters(),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    const opts = await registry.getProviderOptions('hetzner');
    expect(opts.optionsAvailable).toBe(true);
    expect(opts.availability).toBeDefined();

    // AC16-Verifikationsbeispiel aus der Spec:
    // fsn1 enthält cpx22 — NICHT cpx11 (cpx11 nur in ash/hil)
    expect(opts.availability.fsn1).toContain('cpx22');
    expect(opts.availability.fsn1).toContain('cpx32');
    expect(opts.availability.fsn1).not.toContain('cpx11');

    // ash enthält cpx11
    expect(opts.availability.ash).toContain('cpx11');
    expect(opts.availability.ash).toContain('cpx22');

    // hel1 enthält nur cpx22
    expect(opts.availability.hel1).toContain('cpx22');
    expect(opts.availability.hel1).not.toContain('cpx11');
  });

  it('AC16 — Union über mehrere Datacenters einer Location (Deduplizierung)', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeHetznerAdapterWithDatacenters({
          serverTypesWithIds: [
            { id: 22, name: 'cpx22', cores: 2, memory: 4, disk: 40, prices: [] },
            { id: 32, name: 'cpx32', cores: 3, memory: 8, disk: 80, prices: [] },
          ],
          datacenters: [
            // Zwei Datacenters in fsn1 — Union, dedupliziert
            { locationName: 'fsn1', availableIds: [22, 32] },
            { locationName: 'fsn1', availableIds: [22] }, // cpx22 nochmals, darf nicht doppelt erscheinen
          ],
        }),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    const opts = await registry.getProviderOptions('hetzner');
    // Union: [22,32] ∪ [22] = {22,32} → ['cpx22','cpx32'] (dedupliziert, AC16)
    expect(opts.availability.fsn1).toHaveLength(2);
    expect(opts.availability.fsn1).toContain('cpx22');
    expect(opts.availability.fsn1).toContain('cpx32');
  });

  it('AC16 — ID ohne Name-Match wird ausgelassen (kein Fehler)', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeHetznerAdapterWithDatacenters({
          serverTypesWithIds: [
            { id: 22, name: 'cpx22', cores: 2, memory: 4, disk: 40, prices: [] },
          ],
          datacenters: [
            // id=999 existiert nicht in serverTypes → wird ausgelassen (AC16)
            { locationName: 'fsn1', availableIds: [22, 999] },
          ],
        }),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    const opts = await registry.getProviderOptions('hetzner');
    // Nur cpx22 (id=22); id=999 ohne Match → ausgelassen
    expect(opts.availability.fsn1).toEqual(['cpx22']);
  });

  it('AC17 — listDatacenters-Fehler → availability weggelassen, serverTypes/locations/images vollständig', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeHetznerAdapterWithDatacenters({
          datacenterError: new Error('Hetzner API nicht erreichbar'),
        }),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    const opts = await registry.getProviderOptions('hetzner');
    // Kein Hard-Fail: optionsAvailable bleibt true (AC17)
    expect(opts.optionsAvailable).toBe(true);
    // serverTypes/locations/images vollständig (AC17)
    expect(opts.serverTypes).toBeDefined();
    expect(opts.locations).toBeDefined();
    expect(opts.images).toBeDefined();
    // availability weggelassen (kein undefined-Feld in Response)
    expect(opts.availability).toBeUndefined();
  });

  it('AC17 — Token erscheint NICHT in Optionen-Response (Security-Floor)', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeHetznerAdapterWithDatacenters(),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    const opts = await registry.getProviderOptions('hetzner');
    const serialized = JSON.stringify(opts);
    expect(serialized).not.toContain(MOCK_TOKEN);
  });

  it('AC17 — leere datacenters-Antwort → leere availability-Map (graceful)', async () => {
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
      adapters: {
        hetzner: makeHetznerAdapterWithDatacenters({
          datacenters: [], // leere Antwort
        }),
        ionos: makeAdapter(),
        hostinger: makeAdapter(),
      },
    });
    const opts = await registry.getProviderOptions('hetzner');
    // Leere Map ist gültig — kein Hard-Fail, kein undefined
    expect(opts.optionsAvailable).toBe(true);
    // availability kann leer sein oder fehlen — beides ist AC17-konform
    if (opts.availability !== undefined) {
      expect(Object.keys(opts.availability)).toHaveLength(0);
    }
  });
});
