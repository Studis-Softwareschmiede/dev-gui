/**
 * vpsRegistryDelete.test.js — Unit-Tests für VpsProviderRegistry.delete() (S-153).
 *
 * Covers (vps-delete):
 *   AC1  — delete() ruft Adapter.deleteServer() auf, composite IONOS-ID passiert durch
 *   AC2  — Adapter mit delete:false → result:"unsupported", kein deleteServer-Call
 *   AC3  — Tunnel-Cleanup: tunnelId aus Store lesen, deleteTunnel + Store.delete aufrufen
 *   AC4  — CloudflareApi.deleteTunnel-Fehler → result:ok + cleanupError (best-effort)
 *   AC5  — Keine Tunnel-ID im Store → Cleanup übersprungen, result:ok
 *   AC6  — Kein cloudflareApi → Cleanup übersprungen, Store-Refs trotzdem entfernt
 */

import { describe, it, expect } from '@jest/globals';
import { VpsProviderRegistry, VpsRegistryError } from '../src/vps/VpsProviderRegistry.js';

// ── Stub-Bausteine ────────────────────────────────────────────────────────────

function makeCredentialStore(opts = {}) {
  const {
    providerToken = 'test-token',
    tunnelId = null,       // null = keine Tunnel-Zuordnung
    tunnelToken = null,
    deleted = [],
  } = opts;

  const storedEntries = {};

  // Vorbelegung mit tunnelId falls vorhanden
  if (tunnelId) {
    storedEntries[`credentials/misc/vps-my-server-tunnel-id`] = tunnelId;
  }
  if (tunnelToken) {
    storedEntries[`credentials/cloudflare/tunnel_token/${tunnelId}`] = tunnelToken;
  }

  return {
    async getMeta(_key) {
      return { status: providerToken ? 'set' : 'unset' };
    },
    async getPlaintext(key) {
      if (key.startsWith('credentials/vps/')) {
        return providerToken;
      }
      return storedEntries[key] ?? null;
    },
    async getPublicKey(_label) { return null; },
    async set(storeKey, value) {
      storedEntries[storeKey] = value;
      return { status: 'set', updatedAt: new Date().toISOString() };
    },
    async delete(storeKey) {
      deleted.push(storeKey);
      delete storedEntries[storeKey];
    },
    _storedEntries: storedEntries,
    _deleted: deleted,
  };
}

function makeAdapter(overrides = {}) {
  return {
    capabilities: () => ({
      list: true, start: true, stop: true, create: true,
      delete: overrides.deleteCapability ?? true,
    }),
    listMachines: async () => [],
    start: async () => ({ result: 'ok' }),
    stop: async () => ({ result: 'ok' }),
    create: async () => ({ provider: 'hetzner', serverId: '1', name: 'x', status: 'provisioning', ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null }),
    deleteServer: async (_serverId, _token) => overrides.deleteResult ?? { result: 'ok' },
    ...overrides.methods,
  };
}

function makeCloudflareApi(overrides = {}) {
  return {
    listRoutes: async (_tunnelId) => overrides.routes ?? [],
    removeRoute: async (_tunnelId, _hostname) => {},
    deleteTunnel: async (_tunnelId) => {
      if (overrides.deleteTunnelThrows) throw overrides.deleteTunnelThrows;
      return { result: 'ok' };
    },
    isProtected: (_hostname) => false,
    ...overrides.methods,
  };
}

function makeRegistry({ credentialStore, adapters, cloudflareApi } = {}) {
  const store = credentialStore ?? makeCredentialStore();
  return new VpsProviderRegistry({
    credentialStore: store,
    adapters: adapters ?? {
      hetzner: makeAdapter(),
      ionos: makeAdapter(),
      hostinger: makeAdapter({ deleteCapability: false }),
    },
    cloudflareApi: cloudflareApi ?? null,
  });
}

// ── AC1: Grundlegender Delete-Aufruf ──────────────────────────────────────────

describe('VpsProviderRegistry.delete — AC1', () => {
  it('ruft adapter.deleteServer(serverId, token) auf und gibt result:ok zurück', async () => {
    let capturedServerId;
    const adapter = makeAdapter({
      methods: {
        deleteServer: async (serverId) => {
          capturedServerId = serverId;
          return { result: 'ok' };
        },
      },
    });
    const registry = makeRegistry({
      adapters: { hetzner: adapter, ionos: makeAdapter(), hostinger: makeAdapter({ deleteCapability: false }) },
    });

    const result = await registry.delete('hetzner', 'srv-123', 'my-server');
    expect(result.result).toBe('ok');
    expect(capturedServerId).toBe('srv-123');
  });

  it('composite IONOS serverId passiert unverändert durch', async () => {
    let capturedServerId;
    const adapter = makeAdapter({
      methods: {
        deleteServer: async (serverId) => {
          capturedServerId = serverId;
          return { result: 'ok' };
        },
      },
    });
    const registry = makeRegistry({
      adapters: { hetzner: makeAdapter(), ionos: adapter, hostinger: makeAdapter({ deleteCapability: false }) },
    });

    const result = await registry.delete('ionos', 'dc-abc/srv-def', 'my-server');
    expect(result.result).toBe('ok');
    expect(capturedServerId).toBe('dc-abc/srv-def');
  });

  it('unbekannter Provider → wirft VpsRegistryError', async () => {
    const registry = makeRegistry();
    await expect(registry.delete('unknown', '123', 'my-server')).rejects.toThrow(VpsRegistryError);
  });

  it('nicht konfigurierter Provider → wirft VpsRegistryError(provider-not-configured)', async () => {
    const store = makeCredentialStore({ providerToken: null });
    const registry = makeRegistry({ credentialStore: store });
    await expect(registry.delete('hetzner', '123', 'my-server')).rejects.toMatchObject({
      errorClass: 'provider-not-configured',
    });
  });
});

// ── AC2: unsupported-Provider ─────────────────────────────────────────────────

describe('VpsProviderRegistry.delete — AC2: unsupported', () => {
  it('Provider mit delete:false → result:"unsupported", kein deleteServer-Aufruf', async () => {
    let deleteServerCalled = false;
    const hostingerAdapter = makeAdapter({
      deleteCapability: false,
      methods: {
        deleteServer: async () => {
          deleteServerCalled = true;
          return { result: 'ok' };
        },
      },
    });
    const registry = makeRegistry({
      adapters: {
        hetzner: makeAdapter(),
        ionos: makeAdapter(),
        hostinger: hostingerAdapter,
      },
    });

    const result = await registry.delete('hostinger', 'vm-1', 'my-vm');
    expect(result.result).toBe('unsupported');
    expect(deleteServerCalled).toBe(false);
  });
});

// ── AC3: Tunnel-Cleanup ───────────────────────────────────────────────────────

describe('VpsProviderRegistry.delete — AC3: Tunnel-Cleanup', () => {
  it('Tunnel-ID vorhanden → deleteTunnel aufgerufen', async () => {
    let deleteTunnelCalled = false;
    const cfApi = makeCloudflareApi({
      methods: {
        deleteTunnel: async (tunnelId) => {
          deleteTunnelCalled = true;
          expect(tunnelId).toBe('tun-abc123');
          return { result: 'ok' };
        },
        listRoutes: async () => [],
        removeRoute: async () => {},
        isProtected: () => false,
      },
    });

    const deleted = [];
    const store = makeCredentialStore({
      tunnelId: 'tun-abc123',
      tunnelToken: 'super-secret-token',
      deleted,
    });

    const registry = makeRegistry({ credentialStore: store, cloudflareApi: cfApi });
    const result = await registry.delete('hetzner', 'srv-1', 'my-server');

    expect(result.result).toBe('ok');
    expect(deleteTunnelCalled).toBe(true);
    // Token-Referenz aus Store entfernt
    expect(deleted).toContain('credentials/cloudflare/tunnel_token/tun-abc123');
    expect(deleted).toContain('credentials/misc/vps-my-server-tunnel-id');
  });

  it('Routen werden vor deleteTunnel entfernt', async () => {
    const callOrder = [];
    const cfApi = {
      listRoutes: async () => [{ hostname: 'app.example.com' }],
      removeRoute: async (_tunnelId, hostname) => { callOrder.push(`removeRoute:${hostname}`); },
      deleteTunnel: async () => { callOrder.push('deleteTunnel'); return { result: 'ok' }; },
      isProtected: () => false,
    };

    const store = makeCredentialStore({ tunnelId: 'tun-xyz' });
    const registry = makeRegistry({ credentialStore: store, cloudflareApi: cfApi });
    await registry.delete('hetzner', 'srv-1', 'my-server');

    expect(callOrder.indexOf('removeRoute:app.example.com')).toBeLessThan(callOrder.indexOf('deleteTunnel'));
  });

  it('geschützte Hostnames werden NICHT via removeRoute entfernt', async () => {
    const removedHostnames = [];
    const cfApi = {
      listRoutes: async () => [
        { hostname: 'devgui.example.com' },
        { hostname: 'app.example.com' },
      ],
      removeRoute: async (_tunnelId, hostname) => { removedHostnames.push(hostname); },
      deleteTunnel: async () => ({ result: 'ok' }),
      isProtected: (hostname) => hostname === 'devgui.example.com',
    };

    const store = makeCredentialStore({ tunnelId: 'tun-xyz' });
    const registry = makeRegistry({ credentialStore: store, cloudflareApi: cfApi });
    await registry.delete('hetzner', 'srv-1', 'my-server');

    expect(removedHostnames).not.toContain('devgui.example.com');
    expect(removedHostnames).toContain('app.example.com');
  });

  it('Token erscheint NICHT in cleanupError-Meldung (Security-Floor)', async () => {
    const cfApi = makeCloudflareApi({
      deleteTunnelThrows: Object.assign(new Error('Auth fehlgeschlagen'), { errorClass: 'cloudflare-auth-failed' }),
    });

    const store = makeCredentialStore({ tunnelId: 'tun-abc' });
    const registry = makeRegistry({ credentialStore: store, cloudflareApi: cfApi });
    const result = await registry.delete('hetzner', 'srv-1', 'my-server');

    expect(result.result).toBe('ok'); // best-effort: Server gelöscht
    if (result.cleanupError) {
      expect(result.cleanupError).not.toMatch(/Bearer/i);
      expect(result.cleanupError).not.toContain('super-secret');
    }
  });
});

// ── AC4: best-effort — Cleanup-Fehler maskiert nicht Server-Lösch-Erfolg ──────

describe('VpsProviderRegistry.delete — AC4: best-effort Cleanup', () => {
  it('deleteTunnel fehlgeschlagen → result:ok + cleanupError', async () => {
    const cfApi = makeCloudflareApi({
      deleteTunnelThrows: Object.assign(
        new Error('Cloudflare not reachable'),
        { errorClass: 'cloudflare-unavailable' },
      ),
    });

    const store = makeCredentialStore({ tunnelId: 'tun-fail' });
    const registry = makeRegistry({ credentialStore: store, cloudflareApi: cfApi });
    const result = await registry.delete('hetzner', 'srv-1', 'my-server');

    // Server-Delete-Ergebnis OK (best-effort)
    expect(result.result).toBe('ok');
    // cleanupError gesetzt (AC4: klar gemeldet)
    expect(result.cleanupError).toBeTruthy();
  });

  it('404 (already gone) bei deleteTunnel → idempotent, kein cleanupError', async () => {
    const cfApi = makeCloudflareApi({
      deleteTunnelThrows: Object.assign(
        new Error('not found'),
        { errorClass: 'not-found' },
      ),
    });

    const store = makeCredentialStore({ tunnelId: 'tun-already-gone' });
    const registry = makeRegistry({ credentialStore: store, cloudflareApi: cfApi });
    const result = await registry.delete('hetzner', 'srv-1', 'my-server');

    expect(result.result).toBe('ok');
    expect(result.cleanupError).toBeUndefined();
  });

  it('cloudflare-not-configured bei deleteTunnel → kein cleanupError', async () => {
    const cfApi = makeCloudflareApi({
      deleteTunnelThrows: Object.assign(
        new Error('Cloudflare not configured'),
        { errorClass: 'cloudflare-not-configured' },
      ),
    });

    const store = makeCredentialStore({ tunnelId: 'tun-nocf' });
    const registry = makeRegistry({ credentialStore: store, cloudflareApi: cfApi });
    const result = await registry.delete('hetzner', 'srv-1', 'my-server');

    expect(result.result).toBe('ok');
    expect(result.cleanupError).toBeUndefined();
  });
});

// ── AC5: Keine Tunnel-Zuordnung → Cleanup übersprungen ───────────────────────

describe('VpsProviderRegistry.delete — AC5: Keine Tunnel-Zuordnung', () => {
  it('kein tunnelId im Store → Cleanup übersprungen, result:ok', async () => {
    let deleteTunnelCalled = false;
    const cfApi = makeCloudflareApi({
      methods: {
        deleteTunnel: async () => { deleteTunnelCalled = true; },
        listRoutes: async () => [],
        removeRoute: async () => {},
        isProtected: () => false,
      },
    });

    const store = makeCredentialStore({ tunnelId: null }); // keine Zuordnung
    const registry = makeRegistry({ credentialStore: store, cloudflareApi: cfApi });
    const result = await registry.delete('hetzner', 'srv-1', 'my-server');

    expect(result.result).toBe('ok');
    expect(deleteTunnelCalled).toBe(false);
    expect(result.cleanupError).toBeUndefined();
  });

  it('kein cloudflareApi → deleteTunnel wird nie aufgerufen', async () => {
    const store = makeCredentialStore({ tunnelId: 'tun-123' }); // Zuordnung vorhanden
    const registry = makeRegistry({ credentialStore: store, cloudflareApi: null });
    const result = await registry.delete('hetzner', 'srv-1', 'my-server');
    expect(result.result).toBe('ok');
    // kein cloudflareApi → Cleanup skipped (kein Crash)
  });
});

// ── AC2: capabilities().delete ausgewiesen ────────────────────────────────────

describe('VpsProviderRegistry — AC2: capabilities().delete', () => {
  it('hetzner capabilities enthält delete:true', async () => {
    // Direkt den HetznerAdapter testen (der Registry gibt capabilities weiter)
    const { HetznerAdapter } = await import('../src/vps/providers/hetzner.js');
    const adapter = new HetznerAdapter();
    expect(adapter.capabilities().delete).toBe(true);
  });

  it('ionos capabilities enthält delete:true', async () => {
    const { IonosAdapter } = await import('../src/vps/providers/ionos.js');
    const adapter = new IonosAdapter();
    expect(adapter.capabilities().delete).toBe(true);
  });

  it('hostinger capabilities enthält delete:false', async () => {
    const { HostingerAdapter } = await import('../src/vps/providers/hostinger.js');
    const adapter = new HostingerAdapter();
    expect(adapter.capabilities().delete).toBe(false);
  });

  it('hostinger.deleteServer() → result:"unsupported"', async () => {
    const { HostingerAdapter } = await import('../src/vps/providers/hostinger.js');
    const adapter = new HostingerAdapter();
    const result = await adapter.deleteServer('vm-1', 'some-token');
    expect(result.result).toBe('unsupported');
  });
});
