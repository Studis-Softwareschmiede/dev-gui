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
 * Strategy:
 *   - CredentialStore wird als Stub injiziert
 *   - Adapter werden als Stubs injiziert (kein echter Fetch)
 */

import { describe, it, expect } from '@jest/globals';
import { VpsProviderRegistry, VpsRegistryError } from '../src/vps/VpsProviderRegistry.js';

const MOCK_TOKEN = 'registry-test-token-never-in-output';

// ── Mock-Bausteine ─────────────────────────────────────────────────────────────

function makeCredentialStore(tokensByProvider = {}) {
  return {
    async getMeta(key) {
      // Gibt "set" wenn ein Token für den Provider gesetzt ist
      const provider = key.replace('credentials/vps/', '').replace('_api_token', '');
      return { status: tokensByProvider[provider] ? 'set' : 'unset' };
    },
    async getPlaintext(key) {
      const provider = key.replace('credentials/vps/', '').replace('_api_token', '');
      return tokensByProvider[provider] ?? null;
    },
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

// ── AC7/AC8: create() ─────────────────────────────────────────────────────────

describe('VpsProviderRegistry — AC7: create()', () => {
  it('AC7 — routet create() an den richtigen Adapter mit Parametern', async () => {
    let capturedParams = null;
    const store = makeCredentialStore({ hetzner: MOCK_TOKEN });
    const registry = new VpsProviderRegistry({
      credentialStore: store,
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
    // ADR-009: Client übergibt NUR fachliche Parameter (keine userData/sshPublicKeys).
    // Die Registry erzeugt userData server-intern via CloudInitBuilder.
    const machine = await registry.create('hetzner', {
      name: 'new-srv',
      region: 'nbg1',
      serverType: 'cx11',
    });
    expect(capturedParams.name).toBe('new-srv');
    // userData wird server-intern erzeugt (CloudInitBuilder-Stub, CLOUDINIT_STUB_98)
    expect(typeof capturedParams.userData).toBe('string');
    expect(capturedParams.userData).toMatch(/^#cloud-config/);
    // sshPublicKeys wird server-intern aufgelöst (SSHKEYS_STUB_99 — derzeit leer)
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
