/**
 * vpsTargetMetadata.test.js — Unit-Tests für S-166: VPS-Ziel-Metadaten-Persistenz + Cleanup.
 *
 * Covers (vps-dynamic-ssh-targets):
 *   AC1  — Bei erfolgreichem Create wird ein VpsTargetRecord persistiert
 *           ({ provider, serverId, host, port, targetUser, tunnelId }),
 *           secret-frei (kein SSH-Private-Key, kein Tunnel-Token).
 *           targetUser default "root", port default 22.
 *   AC2  — getMachineIp(provider, serverId) liefert die aktuelle IPv4 über den Adapter.
 *           Datensatz mit null-host + getMachineIp-Mock → aufgelöstes Ziel trägt aktuelle IP.
 *   AC7  — Beim Delete wird der Ziel-Datensatz mit entfernt (best-effort, idempotent);
 *           danach ist er nicht mehr abrufbar (getTargetRecord = null).
 *   AC8  — Datensatz + Response enthalten KEINEN SSH-Private-Key und KEIN Tunnel-Token.
 *
 * Strategy:
 *   - CredentialStore als Stub mit set/getPlaintext/delete-Tracking
 *   - Adapter als Stubs (kein echter Fetch)
 *   - CloudflareApi als Stub (kein echter Fetch)
 */

import { describe, it, expect } from '@jest/globals';
import { VpsProviderRegistry } from '../src/vps/VpsProviderRegistry.js';

// ── Konstanten ─────────────────────────────────────────────────────────────────

const MOCK_TOKEN = 'test-provider-token-never-in-response';
const MOCK_TUNNEL_ID = 'cf-tunnel-s166-test-uuid';
const MOCK_TUNNEL_TOKEN = 'eyJhbGci.mock-s166-tunnel-token-never-in-record';
const ROOT_PUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRootKeyS166Test root@test';
const ALEX_PUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAlexKeyS166Test alex@test';
const MOCK_IPV4 = '188.34.202.209';

// ── Store-Stub ──────────────────────────────────────────────────────────────────

/**
 * Baut einen vollständig steuerbaren CredentialStore-Stub.
 * Alle Operationen tracken ihre Aufrufe in den jeweiligen Arrays.
 */
function makeStore(opts = {}) {
  const { providerToken = MOCK_TOKEN } = opts;
  const entries = {};
  const setCalls = [];
  const deletedKeys = [];

  return {
    async getMeta(key) {
      if (key.includes('_api_token')) return { status: providerToken ? 'set' : 'unset' };
      return { status: 'unset' };
    },
    async getPlaintext(key) {
      if (key.startsWith('credentials/vps/')) return providerToken ?? null;
      return entries[key] ?? null;
    },
    async getPublicKey(label) {
      if (label === 'root') return ROOT_PUB_KEY;
      if (label === 'alex') return ALEX_PUB_KEY;
      return null;
    },
    async set(key, value) {
      entries[key] = value;
      setCalls.push({ key, value });
      return { status: 'set', updatedAt: new Date().toISOString() };
    },
    async delete(key) {
      deletedKeys.push(key);
      delete entries[key];
    },
    _entries: entries,
    _setCalls: setCalls,
    _deletedKeys: deletedKeys,
  };
}

// ── Adapter-Stubs ───────────────────────────────────────────────────────────────

function makeHetznerAdapter(opts = {}) {
  const { ipv4 = MOCK_IPV4, serverId = 'srv-42' } = opts;
  return {
    capabilities: () => ({ list: true, start: true, stop: true, create: true, delete: true }),
    listMachines: async () => [{
      provider: 'hetzner', serverId, name: 'test-vps', status: 'running',
      ipv4, ipv6: null, region: 'nbg1', serverType: 'cx11', createdAt: null,
    }],
    start: async () => ({ result: 'ok' }),
    stop: async () => ({ result: 'ok' }),
    deleteServer: async () => ({ result: 'ok' }),
    create: async () => ({
      provider: 'hetzner',
      serverId,
      name: 'test-vps',
      status: 'provisioning',
      ipv4,
      ipv6: null,
      region: 'nbg1',
      serverType: 'cx11',
      createdAt: null,
    }),
    ...opts.methods,
  };
}

function makeInertAdapter() {
  return {
    capabilities: () => ({ list: true, start: true, stop: true, create: true, delete: false }),
    listMachines: async () => [],
    start: async () => ({ result: 'ok' }),
    stop: async () => ({ result: 'ok' }),
    deleteServer: async () => ({ result: 'unsupported' }),
    create: async () => { throw new Error('not used'); },
  };
}

// ── CloudflareApi-Stub ──────────────────────────────────────────────────────────

function makeCfApi(opts = {}) {
  return {
    createTunnel: async () => ({ tunnelId: MOCK_TUNNEL_ID, token: MOCK_TUNNEL_TOKEN }),
    listRoutes: async () => opts.routes ?? [],
    removeRoute: async () => {},
    deleteTunnel: async () => ({ result: 'ok' }),
    isProtected: () => false,
    ...opts.methods,
  };
}

// ── CloudInitBuilder-Stub ───────────────────────────────────────────────────────

function makeBuilderStub() {
  return {
    build: () => '#cloud-config\n# s166-test-stub\n',
  };
}

// ── Hilfsfunktion: Registry aufbauen ───────────────────────────────────────────

function makeRegistry(opts = {}) {
  const store = opts.store ?? makeStore();
  return {
    store,
    registry: new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: opts.cfApi ?? makeCfApi(),
      cloudInitBuilder: opts.builder ?? makeBuilderStub(),
      adapters: {
        hetzner: opts.hetznerAdapter ?? makeHetznerAdapter(),
        ionos: makeInertAdapter(),
        hostinger: makeInertAdapter(),
      },
    }),
  };
}

// ── AC1: Persistenz beim Create ────────────────────────────────────────────────

describe('S-166 AC1 — VpsTargetRecord beim Create persistieren', () => {
  it('speichert den Datensatz unter credentials/misc/vps-<sanitized>-target', async () => {
    const { store, registry } = makeRegistry();

    await registry.create('hetzner', {
      name: 'testDevGui',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    // Datensatz-Schlüssel: credentials/misc/vps-testdevgui-target
    const targetKey = 'credentials/misc/vps-testdevgui-target';
    const rawRecord = store._entries[targetKey];
    expect(rawRecord).toBeTruthy();

    const record = JSON.parse(rawRecord);
    expect(record.provider).toBe('hetzner');
    expect(record.serverId).toBe('srv-42');
    expect(record.host).toBe(MOCK_IPV4);
    expect(record.port).toBe(22);
    expect(record.targetUser).toBe('root');
    expect(record.tunnelId).toBe(MOCK_TUNNEL_ID);
  });

  it('speichert provider und serverId korrekt aus der VpsMachine-Antwort', async () => {
    const adapter = makeHetznerAdapter({ serverId: '9999', ipv4: '1.2.3.4' });
    const { store, registry } = makeRegistry({ hetznerAdapter: adapter });

    await registry.create('hetzner', {
      name: 'my-prod-vps',
      region: 'fsn1',
      serverType: 'cx21',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const targetKey = 'credentials/misc/vps-my-prod-vps-target';
    const record = JSON.parse(store._entries[targetKey]);
    expect(record.provider).toBe('hetzner');
    expect(record.serverId).toBe('9999');
    expect(record.host).toBe('1.2.3.4');
  });

  it('targetUser ist "root" (Default aus Create-Kontext)', async () => {
    const { store, registry } = makeRegistry();

    await registry.create('hetzner', {
      name: 'my-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const record = JSON.parse(store._entries['credentials/misc/vps-my-vps-target']);
    expect(record.targetUser).toBe('root');
  });

  it('port ist 22 (Default SSH-Port)', async () => {
    const { store, registry } = makeRegistry();

    await registry.create('hetzner', {
      name: 'my-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const record = JSON.parse(store._entries['credentials/misc/vps-my-vps-target']);
    expect(record.port).toBe(22);
  });

  it('host ist null wenn Provider null-ipv4 zurückgibt (asynchrone Provisionierung)', async () => {
    const adapter = makeHetznerAdapter({ ipv4: null });
    const { store, registry } = makeRegistry({ hetznerAdapter: adapter });

    await registry.create('hetzner', {
      name: 'provisioning-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const record = JSON.parse(store._entries['credentials/misc/vps-provisioning-vps-target']);
    expect(record.host).toBeNull();
    // serverId + provider sind dennoch vorhanden (IP-unabhängig)
    expect(record.serverId).toBeTruthy();
    expect(record.provider).toBe('hetzner');
  });

  it('tunnelId ist null wenn kein Tunnel angelegt wurde (CF nicht konfiguriert)', async () => {
    const cfApi = {
      createTunnel: async () => {
        const err = new Error('Cloudflare not configured');
        err.errorClass = 'cloudflare-not-configured';
        throw err;
      },
    };
    const { store, registry } = makeRegistry({ cfApi });

    await registry.create('hetzner', {
      name: 'no-tunnel-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const record = JSON.parse(store._entries['credentials/misc/vps-no-tunnel-vps-target']);
    expect(record.tunnelId).toBeNull();
    expect(record.provider).toBe('hetzner');
  });
});

// ── AC1 Security: Kein Secret im Datensatz ────────────────────────────────────

describe('S-166 AC1/AC8 — VpsTargetRecord ist secret-frei', () => {
  it('Datensatz enthält KEINEN SSH-Private-Key (ADR-008)', async () => {
    const { store, registry } = makeRegistry();

    await registry.create('hetzner', {
      name: 'secret-check-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const targetKey = 'credentials/misc/vps-secret-check-vps-target';
    const rawRecord = store._entries[targetKey];
    expect(rawRecord).toBeTruthy();

    // Public-Key-Material darf nicht im Datensatz stehen
    expect(rawRecord).not.toContain('AAAAC3NzaC1');  // Key-Material
    expect(rawRecord).not.toContain('private');
    expect(rawRecord).not.toContain('BEGIN OPENSSH');
  });

  it('Datensatz enthält KEIN Tunnel-Token (ADR-007)', async () => {
    const { store, registry } = makeRegistry();

    await registry.create('hetzner', {
      name: 'token-check-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const targetKey = 'credentials/misc/vps-token-check-vps-target';
    const rawRecord = store._entries[targetKey];

    // Tunnel-Token (MOCK_TUNNEL_TOKEN) darf nicht im Target-Record stehen
    expect(rawRecord).not.toContain(MOCK_TUNNEL_TOKEN);
    expect(rawRecord).not.toContain('eyJhbGci');

    // Provider-Token darf nicht im Record stehen
    expect(rawRecord).not.toContain(MOCK_TOKEN);
  });

  it('set() für Target-Key wird mit dem gespeicherten JSON-Wert aufgerufen, nicht mit Secrets', async () => {
    const { store, registry } = makeRegistry();

    await registry.create('hetzner', {
      name: 'set-check-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const targetSetCall = store._setCalls.find(
      (c) => c.key === 'credentials/misc/vps-set-check-vps-target',
    );
    expect(targetSetCall).toBeTruthy();

    // Der gespeicherte Wert ist gültiges JSON
    const parsed = JSON.parse(targetSetCall.value);
    expect(parsed).toMatchObject({ provider: 'hetzner', port: 22, targetUser: 'root' });

    // Kein Token im Wert
    expect(targetSetCall.value).not.toContain(MOCK_TUNNEL_TOKEN);
    expect(targetSetCall.value).not.toContain(MOCK_TOKEN);
  });

  it('Create-Response (VpsMachine) enthält KEIN Tunnel-Token (AC8)', async () => {
    const { registry } = makeRegistry();

    const machine = await registry.create('hetzner', {
      name: 'response-check-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const machineStr = JSON.stringify(machine);
    expect(machineStr).not.toContain(MOCK_TUNNEL_TOKEN);
    expect(machineStr).not.toContain('tunnel_token');
    expect(machineStr).not.toContain(MOCK_TOKEN);
  });
});

// ── AC2: getMachineIp() ────────────────────────────────────────────────────────

describe('S-166 AC2 — getMachineIp(provider, serverId)', () => {
  it('gibt die aktuelle IPv4 aus der listMachines-Antwort zurück', async () => {
    const adapter = makeHetznerAdapter({ serverId: 'srv-100', ipv4: '10.20.30.40' });
    const { registry } = makeRegistry({ hetznerAdapter: adapter });

    const ip = await registry.getMachineIp('hetzner', 'srv-100');
    expect(ip).toBe('10.20.30.40');
  });

  it('gibt null zurück wenn serverId nicht gefunden', async () => {
    const adapter = makeHetznerAdapter({ serverId: 'srv-100', ipv4: '10.20.30.40' });
    const { registry } = makeRegistry({ hetznerAdapter: adapter });

    const ip = await registry.getMachineIp('hetzner', 'srv-999-unknown');
    expect(ip).toBeNull();
  });

  it('gibt null zurück wenn IPv4 noch nicht verfügbar (asynchrone Provisionierung)', async () => {
    const adapter = makeHetznerAdapter({ serverId: 'srv-200', ipv4: null });
    const { registry } = makeRegistry({ hetznerAdapter: adapter });

    const ip = await registry.getMachineIp('hetzner', 'srv-200');
    expect(ip).toBeNull();
  });

  it('gibt null zurück wenn Adapter wirft (degradierend)', async () => {
    const adapter = {
      ...makeHetznerAdapter(),
      listMachines: async () => { throw new Error('Provider timeout'); },
    };
    const { registry } = makeRegistry({ hetznerAdapter: adapter });

    const ip = await registry.getMachineIp('hetzner', 'srv-100');
    expect(ip).toBeNull(); // degradierend — kein Crash
  });

  it('wirft VpsRegistryError bei unbekanntem Provider', async () => {
    const { registry } = makeRegistry();
    const { VpsRegistryError } = await import('../src/vps/VpsProviderRegistry.js');
    await expect(registry.getMachineIp('unknown-provider', 'srv-1')).rejects.toBeInstanceOf(VpsRegistryError);
  });
});

// ── AC2: getTargetRecord() — Lese-Baustein für S-167 ──────────────────────────

describe('S-166 AC2 — getTargetRecord(vpsName) Lese-Baustein', () => {
  it('gibt den persistierten Datensatz nach Create zurück', async () => {
    const { registry } = makeRegistry();

    await registry.create('hetzner', {
      name: 'my-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const record = await registry.getTargetRecord('my-vps');
    expect(record).not.toBeNull();
    expect(record.provider).toBe('hetzner');
    expect(record.serverId).toBe('srv-42');
    expect(record.host).toBe(MOCK_IPV4);
    expect(record.port).toBe(22);
    expect(record.targetUser).toBe('root');
    expect(record.tunnelId).toBe(MOCK_TUNNEL_ID);
  });

  it('gibt null zurück wenn kein Datensatz vorhanden (Bestandssetup)', async () => {
    const { registry } = makeRegistry();
    const record = await registry.getTargetRecord('nonexistent-vps');
    expect(record).toBeNull();
  });

  it('liefert KEINEN Secret-Wert (kein Token, kein Private-Key)', async () => {
    const { registry } = makeRegistry();

    await registry.create('hetzner', {
      name: 'read-check-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const record = await registry.getTargetRecord('read-check-vps');
    const recordStr = JSON.stringify(record);
    expect(recordStr).not.toContain(MOCK_TUNNEL_TOKEN);
    expect(recordStr).not.toContain(MOCK_TOKEN);
    expect(recordStr).not.toContain('AAAAC3NzaC1');
  });
});

// ── AC7: Cleanup beim Delete ───────────────────────────────────────────────────

describe('S-166 AC7 — Ziel-Datensatz beim Delete entfernen', () => {
  it('Target-Record wird nach Delete gelöscht (nicht mehr über getTargetRecord abrufbar)', async () => {
    const { store, registry } = makeRegistry();

    // Erst erstellen, dann löschen
    await registry.create('hetzner', {
      name: 'my-server',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    // Sicherstellen: Datensatz ist nach Create vorhanden
    const recordBefore = await registry.getTargetRecord('my-server');
    expect(recordBefore).not.toBeNull();

    // Delete aufrufen
    await registry.delete('hetzner', 'srv-42', 'my-server');

    // Datensatz muss entfernt sein
    const targetKey = 'credentials/misc/vps-my-server-target';
    expect(store._deletedKeys).toContain(targetKey);
  });

  it('delete() ruft store.delete für den Target-Key auf', async () => {
    const store = makeStore();
    // Target-Record manuell vorbefüllen (simuliert Zustand nach Create)
    await store.set('credentials/misc/vps-my-server-target', JSON.stringify({
      provider: 'hetzner', serverId: 'srv-42', host: MOCK_IPV4,
      port: 22, targetUser: 'root', tunnelId: MOCK_TUNNEL_ID,
    }));
    // Tunnel-ID ebenfalls vorbefüllen (für Tunnel-Cleanup)
    await store.set('credentials/misc/vps-my-server-tunnel-id', MOCK_TUNNEL_ID);

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: makeCfApi(),
      cloudInitBuilder: makeBuilderStub(),
      adapters: {
        hetzner: makeHetznerAdapter(),
        ionos: makeInertAdapter(),
        hostinger: makeInertAdapter(),
      },
    });

    // Löschen aufrufen
    await registry.delete('hetzner', 'srv-42', 'my-server');

    expect(store._deletedKeys).toContain('credentials/misc/vps-my-server-target');
  });

  it('Cleanup ist idempotent — kein Fehler wenn Target-Record nicht existiert', async () => {
    const store = makeStore();
    // Kein Target-Record, aber Tunnel-ID vorhanden
    await store.set('credentials/misc/vps-ghost-vps-tunnel-id', MOCK_TUNNEL_ID);

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: makeCfApi(),
      cloudInitBuilder: makeBuilderStub(),
      adapters: {
        hetzner: makeHetznerAdapter(),
        ionos: makeInertAdapter(),
        hostinger: makeInertAdapter(),
      },
    });

    // Kein Crash auch ohne vorherigen Target-Record (idempotent)
    const result = await registry.delete('hetzner', 'srv-42', 'ghost-vps');
    expect(result.result).toBe('ok');
  });

  it('Cleanup ist idempotent wenn kein Tunnel im Store (kein Target-Record, kein Tunnel)', async () => {
    const store = makeStore();
    // Leerer Store — weder Tunnel-ID noch Target-Record

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: makeCfApi(),
      cloudInitBuilder: makeBuilderStub(),
      adapters: {
        hetzner: makeHetznerAdapter(),
        ionos: makeInertAdapter(),
        hostinger: makeInertAdapter(),
      },
    });

    const result = await registry.delete('hetzner', 'srv-42', 'orphan-vps');
    expect(result.result).toBe('ok');
    // Target-Key wurde versucht zu löschen (idempotent, kein Crash)
    expect(store._deletedKeys).toContain('credentials/misc/vps-orphan-vps-target');
  });

  it('Target-Record wird auch bei Tunnel-Delete-Fehler entfernt (best-effort)', async () => {
    const store = makeStore();
    await store.set('credentials/misc/vps-error-vps-target', JSON.stringify({
      provider: 'hetzner', serverId: 'srv-1', host: MOCK_IPV4,
      port: 22, targetUser: 'root', tunnelId: MOCK_TUNNEL_ID,
    }));
    await store.set('credentials/misc/vps-error-vps-tunnel-id', MOCK_TUNNEL_ID);

    const cfApi = {
      ...makeCfApi(),
      deleteTunnel: async () => {
        const err = new Error('Cloudflare unavailable');
        err.errorClass = 'cloudflare-unavailable';
        throw err;
      },
    };

    const registry = new VpsProviderRegistry({
      credentialStore: store,
      cloudflareApi: cfApi,
      cloudInitBuilder: makeBuilderStub(),
      adapters: {
        hetzner: makeHetznerAdapter(),
        ionos: makeInertAdapter(),
        hostinger: makeInertAdapter(),
      },
    });

    const result = await registry.delete('hetzner', 'srv-1', 'error-vps');

    // Server-Delete ist ok (best-effort Cleanup)
    expect(result.result).toBe('ok');
    // Target-Record wurde trotz Tunnel-Fehler entfernt
    expect(store._deletedKeys).toContain('credentials/misc/vps-error-vps-target');
  });
});

// ── AC8: Security-Floor gesamt ────────────────────────────────────────────────

describe('S-166 AC8 — Security-Floor: kein Secret in Store-Set-Calls für Target-Key', () => {
  it('kein Provider-Token im Target-Record-Set-Call', async () => {
    const { store, registry } = makeRegistry();

    await registry.create('hetzner', {
      name: 'floor-check-vps',
      region: 'nbg1',
      serverType: 'cx11',
      sshKeyAssignment: { root: 'root', alex: 'alex' },
    });

    const targetSetCall = store._setCalls.find(
      (c) => c.key === 'credentials/misc/vps-floor-check-vps-target',
    );
    expect(targetSetCall).toBeTruthy();
    expect(targetSetCall.value).not.toContain(MOCK_TOKEN);
    expect(targetSetCall.value).not.toContain(MOCK_TUNNEL_TOKEN);
    expect(targetSetCall.value).not.toContain(ROOT_PUB_KEY);
    expect(targetSetCall.value).not.toContain(ALEX_PUB_KEY);
  });
});
