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
 *   AC5  — create() ruft createTunnel('devgui-<sanitized-vpsname>') auf + Token in cloud-init
 *   AC6  — Token erscheint NICHT im Log/Response/Argv (Token-Floor)
 *   AC7  — tunnelId dem VPS zugeordnet (im CredentialStore gespeichert); keine Token-Referenz
 *   AC8  — Token im CredentialStore abgelegt (set() aufgerufen); kein Token in VpsMachine-Return
 *   AC9  — cloudflare-not-configured → Create ohne Tunnel, kein Crash
 *   AC10 — Token bleibt im CredentialStore auch wenn VPS-Start-Fehler (Persistenz-Reihenfolge)
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
  it('AC5 — createTunnel("devgui-<sanitized-vpsname>") wird aufgerufen', async () => {
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

    // Tunnel-Name-Konvention: devgui-<sanitized> (lowercase, alphanumerisch+Bindestrich)
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^createTunnel:devgui-my-server-01$/);
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

  it('AC10 — Token bleibt im CredentialStore, auch wenn Adapter-Create fehlschlägt', async () => {
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

    // Create schlägt beim Adapter fehl — Token wurde aber VOR dem Adapter-Call persistiert
    await expect(
      registry.create('hetzner', {
        name: 'my-vps',
        region: 'nbg1',
        serverType: 'cx11',
        sshKeyAssignment: { root: 'root', alex: 'alex' },
      }),
    ).rejects.toThrow();

    // Token muss im Store sein (AC10 — kein verwaistes, unreferenziertes Geheimnis)
    const tokenKey = `credentials/cloudflare/tunnel_token/${MOCK_TUNNEL_ID}`;
    expect(store._storedEntries[tokenKey]).toBe(MOCK_TUNNEL_TOKEN);
  });
});
