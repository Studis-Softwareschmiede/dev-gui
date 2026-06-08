/**
 * cloudflareNormalize.test.js — Unit-Tests für src/cloudflare/normalize.js (ADR-010).
 *
 * Covers:
 *   normalizeZone()   — CfZone-Normalisierung, fehlende Felder → null
 *   normalizeTunnel() — CfTunnel-Normalisierung, zoneId-Injektion
 *   normalizeRoute()  — CfRoute-Normalisierung, protected-Flag
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeZone, normalizeTunnel, normalizeRoute } from '../src/cloudflare/normalize.js';

// ── normalizeZone ─────────────────────────────────────────────────────────────

describe('normalizeZone()', () => {
  it('normalisiert vollständigen Zone-Datensatz', () => {
    const raw = { id: 'zone-id-001', name: 'example.com', status: 'active' };
    const zone = normalizeZone(raw);
    expect(zone).toEqual({ id: 'zone-id-001', name: 'example.com', status: 'active' });
  });

  it('konvertiert id zu String', () => {
    const zone = normalizeZone({ id: 12345, name: 'example.com', status: 'active' });
    expect(zone.id).toBe('12345');
  });

  it('fehlender status → null (nie Fehler)', () => {
    const zone = normalizeZone({ id: 'z1', name: 'example.com' });
    expect(zone.status).toBeNull();
  });

  it('null input → fallback-Objekt ohne Fehler', () => {
    expect(() => normalizeZone(null)).not.toThrow();
    const zone = normalizeZone(null);
    expect(zone.id).toBeDefined();
    expect(zone.status).toBeNull();
  });

  it('fehlender name → "unknown"', () => {
    const zone = normalizeZone({ id: 'z1' });
    expect(zone.name).toBe('unknown');
  });
});

// ── normalizeTunnel ───────────────────────────────────────────────────────────

describe('normalizeTunnel()', () => {
  it('normalisiert vollständigen Tunnel-Datensatz', () => {
    const raw = { id: 'tun-001', name: 'my-tunnel', status: 'active' };
    const tunnel = normalizeTunnel(raw, 'zone-abc');
    expect(tunnel).toEqual({
      id: 'tun-001',
      name: 'my-tunnel',
      status: 'active',
      zoneId: 'zone-abc',
    });
  });

  it('injiziert zoneId', () => {
    const tunnel = normalizeTunnel({ id: 't1', name: 'tun', status: 'inactive' }, 'injected-zone');
    expect(tunnel.zoneId).toBe('injected-zone');
  });

  it('fehlender status → null', () => {
    const tunnel = normalizeTunnel({ id: 't1', name: 'tun' }, 'zone');
    expect(tunnel.status).toBeNull();
  });

  it('null input → fallback ohne Fehler', () => {
    expect(() => normalizeTunnel(null, 'zone')).not.toThrow();
    const tunnel = normalizeTunnel(null, 'zone');
    expect(tunnel.zoneId).toBe('zone');
  });
});

// ── normalizeRoute ────────────────────────────────────────────────────────────

describe('normalizeRoute()', () => {
  it('normalisiert vollständige Ingress-Regel', () => {
    const raw = { hostname: 'app.example.com', service: 'http://localhost:3000' };
    const route = normalizeRoute(raw, 'tun-001', false);
    expect(route).toEqual({
      hostname: 'app.example.com',
      service: 'http://localhost:3000',
      tunnelId: 'tun-001',
      protected: false,
    });
  });

  it('setzt protected:true wenn übergeben', () => {
    const raw = { hostname: 'devgui.example.com', service: 'http://localhost:8080' };
    const route = normalizeRoute(raw, 'tun-001', true);
    expect(route.protected).toBe(true);
  });

  it('fehlender service → null', () => {
    const raw = { hostname: 'app.example.com' };
    const route = normalizeRoute(raw, 'tun-001', false);
    expect(route.service).toBeNull();
  });

  it('null input → fail-closed (protected:true)', () => {
    expect(() => normalizeRoute(null, 'tun-001')).not.toThrow();
    const route = normalizeRoute(null, 'tun-001');
    expect(route.protected).toBe(true); // fail-closed
  });

  it('injiziert tunnelId', () => {
    const raw = { hostname: 'app.example.com', service: 'http://localhost:3000' };
    const route = normalizeRoute(raw, 'injected-tunnel', false);
    expect(route.tunnelId).toBe('injected-tunnel');
  });
});
