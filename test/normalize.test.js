/**
 * normalize.test.js — Unit-Tests für normalize.js (data-model.md Normalisierungsregeln).
 *
 * Covers:
 *   AC1  — normalizeHetzner / normalizeIonos / normalizeHostinger implementieren denselben
 *           VpsMachine-Vertrag (alle Felder vorhanden)
 *   AC3  — Normalisierung kippt nie — fehlende Felder → null, Status → "unknown"
 *   AC4  — Degradation: ungültige Rohdaten erzeugen kein Throw
 *
 * Strategy:
 *   - Pure-Functions — kein Mocking nötig
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeHetzner, normalizeIonos, normalizeHostinger } from '../src/vps/normalize.js';

// ── normalizeHetzner ──────────────────────────────────────────────────────────

describe('normalizeHetzner', () => {
  it('mappt einen vollständigen Hetzner-Server korrekt', () => {
    const raw = {
      id: 42,
      name: 'my-server',
      status: 'running',
      public_net: {
        ipv4: { ip: '1.2.3.4' },
        ipv6: { ip: '2001:db8::1' },
      },
      datacenter: { location: { name: 'nbg1' } },
      server_type: { name: 'cx11' },
      created: '2026-01-01T00:00:00Z',
    };
    const vm = normalizeHetzner(raw);
    expect(vm).toMatchObject({
      provider: 'hetzner',
      serverId: '42',
      name: 'my-server',
      status: 'running',
      ipv4: '1.2.3.4',
      ipv6: '2001:db8::1',
      region: 'nbg1',
      serverType: 'cx11',
      createdAt: '2026-01-01T00:00:00Z',
    });
  });

  it('AC3 — fehlende Felder → null, kein Fehler', () => {
    const raw = { id: 7, name: 'minimal', status: 'off' };
    const vm = normalizeHetzner(raw);
    expect(vm.provider).toBe('hetzner');
    expect(vm.serverId).toBe('7');
    expect(vm.status).toBe('stopped');
    expect(vm.ipv4).toBeNull();
    expect(vm.ipv6).toBeNull();
    expect(vm.region).toBeNull();
    expect(vm.serverType).toBeNull();
    expect(vm.createdAt).toBeNull();
  });

  it('AC4 — null-Input → kein Fehler, status:"unknown"', () => {
    const vm = normalizeHetzner(null);
    expect(vm.status).toBe('unknown');
    expect(vm.provider).toBe('hetzner');
  });

  it('mappt Hetzner-Status "off" → "stopped"', () => {
    expect(normalizeHetzner({ id: 1, name: 'x', status: 'off' }).status).toBe('stopped');
  });

  it('mappt Hetzner-Status "starting" → "provisioning"', () => {
    expect(normalizeHetzner({ id: 1, name: 'x', status: 'starting' }).status).toBe('provisioning');
  });

  it('mappt Hetzner-Status "rebuilding" → "provisioning"', () => {
    expect(normalizeHetzner({ id: 1, name: 'x', status: 'rebuilding' }).status).toBe('provisioning');
  });

  it('mappt unbekannten Status → "unknown"', () => {
    expect(normalizeHetzner({ id: 1, name: 'x', status: 'banana' }).status).toBe('unknown');
  });

  it('serverId wird immer als String normalisiert', () => {
    const vm = normalizeHetzner({ id: 99999, name: 'n', status: 'running' });
    expect(typeof vm.serverId).toBe('string');
    expect(vm.serverId).toBe('99999');
  });
});

// ── normalizeIonos ────────────────────────────────────────────────────────────

describe('normalizeIonos', () => {
  it('mappt einen IONOS-Server korrekt', () => {
    const raw = {
      id: 'ionos-uuid-123',
      properties: {
        name: 'ionos-server',
        vmState: 'RUNNING',
        availabilityZone: 'ZONE_1',
        type: 'ENTERPRISE',
      },
      metadata: {
        state: 'AVAILABLE',
        createdDate: '2026-02-01T00:00:00Z',
      },
    };
    const vm = normalizeIonos(raw);
    expect(vm).toMatchObject({
      provider: 'ionos',
      serverId: 'ionos-uuid-123',
      name: 'ionos-server',
      status: 'running',
      region: 'ZONE_1',
      serverType: 'ENTERPRISE',
      createdAt: '2026-02-01T00:00:00Z',
    });
  });

  it('AC3 — fehlende Felder → null', () => {
    const raw = { id: 'x', properties: { name: 'minimal', vmState: 'SHUTOFF' }, metadata: {} };
    const vm = normalizeIonos(raw);
    expect(vm.status).toBe('stopped');
    expect(vm.ipv4).toBeNull();
    expect(vm.region).toBeNull();
  });

  it('AC4 — null-Input → kein Fehler', () => {
    const vm = normalizeIonos(null);
    expect(vm.status).toBe('unknown');
    expect(vm.provider).toBe('ionos');
  });

  it('mappt vmState CRASHED → "error"', () => {
    const raw = {
      id: 'x',
      properties: { name: 'c', vmState: 'CRASHED' },
      metadata: { state: 'AVAILABLE' },
    };
    expect(normalizeIonos(raw).status).toBe('error');
  });

  it('mappt metadata.state BUSY → "provisioning" (Vorrang vor vmState)', () => {
    const raw = {
      id: 'x',
      properties: { name: 'c', vmState: 'RUNNING' },
      metadata: { state: 'BUSY' },
    };
    expect(normalizeIonos(raw).status).toBe('provisioning');
  });
});

// ── normalizeHostinger ────────────────────────────────────────────────────────

describe('normalizeHostinger', () => {
  it('mappt einen Hostinger-Server korrekt', () => {
    const raw = {
      id: 'host-123',
      hostname: 'host-server',
      state: 'running',
      ip_addresses: [
        { type: 'ipv4', address: '5.6.7.8' },
        { type: 'ipv6', address: '2001:db8::2' },
      ],
      location: 'eu-west',
      plan_id: 'vps-basic',
      created_at: '2026-03-01T00:00:00Z',
    };
    const vm = normalizeHostinger(raw);
    expect(vm).toMatchObject({
      provider: 'hostinger',
      serverId: 'host-123',
      name: 'host-server',
      status: 'running',
      ipv4: '5.6.7.8',
      ipv6: '2001:db8::2',
      region: 'eu-west',
      serverType: 'vps-basic',
      createdAt: '2026-03-01T00:00:00Z',
    });
  });

  it('AC3 — fehlende Felder → null', () => {
    const raw = { id: 'h2', hostname: 'min', state: 'stopped' };
    const vm = normalizeHostinger(raw);
    expect(vm.status).toBe('stopped');
    expect(vm.ipv4).toBeNull();
    expect(vm.ipv6).toBeNull();
    expect(vm.region).toBeNull();
    expect(vm.createdAt).toBeNull();
  });

  it('AC4 — null-Input → kein Fehler', () => {
    const vm = normalizeHostinger(null);
    expect(vm.status).toBe('unknown');
    expect(vm.provider).toBe('hostinger');
  });

  it('mappt state "provisioning" → "provisioning"', () => {
    expect(normalizeHostinger({ id: '1', hostname: 'x', state: 'provisioning' }).status).toBe('provisioning');
  });

  it('mappt state "error" → "error"', () => {
    expect(normalizeHostinger({ id: '1', hostname: 'x', state: 'error' }).status).toBe('error');
  });

  it('mappt unbekannten state → "unknown"', () => {
    expect(normalizeHostinger({ id: '1', hostname: 'x', state: 'mystery' }).status).toBe('unknown');
  });
});
