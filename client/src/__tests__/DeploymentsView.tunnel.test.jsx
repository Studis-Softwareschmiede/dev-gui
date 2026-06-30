/**
 * DeploymentsView.tunnel.test.jsx
 *
 * Covers (vps-tunnel-existence-gate.md, S-186):
 *   AC8  — tunnelId für Deploy aus VPS↔Tunnel-Read-Model (vps-targets.tunnelIds /
 *           vps-tunnel-status), nicht aus account-weitem Tunnel-Dropdown
 *   AC9  — Tunnel-Badge "Tunnel ✓" / "Tunnel fehlt ✗" neben VPS-Feld;
 *           kein Badge/Poll ohne VPS-Auswahl; Badge aus vps-tunnel-status
 *   AC10 — Deploy-Button deaktiviert solange tunnelPresent !== true;
 *           freigegeben wenn tunnelPresent === true (+ übrige Bedingungen)
 *   AC11 — tunnel-missing / tunnel-mismatch errorClass → freundliche Meldung
 *           (in DeploymentsView.test.jsx mitgetestet)
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { DeploymentsView } = await import('../DeploymentsView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  jest.useFakeTimers();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});

/**
 * Baseline fetch stub: empty/configured dropdown lists + configurable tunnel status.
 *
 * @param {{ tunnelPresent?: boolean|'unknown', tunnelId?: string|null, tunnelStatusFn?: Function, vpsIds?: string[], tunnelIds?: object }} opts
 */
function makeTunnelFetch({
  tunnelPresent = true,
  tunnelStatusFn,
  vpsIds = ['vps-1'],
  tunnelIds = { 'vps-1': 'tunnel-abc' },
} = {}) {
  return jest.fn(async (url) => {
    const u = String(url);

    // S-186 AC9: vps-tunnel-status Read-Model
    if (u.includes('/api/deployments/vps-tunnel-status')) {
      if (tunnelStatusFn) return tunnelStatusFn(u);
      return {
        ok: true, status: 200,
        json: async () => vpsIds.map((id) => ({
          vpsId: id,
          tunnelId: tunnelIds[id] ?? null,
          tunnelPresent,
        })),
      };
    }
    // S-181: readiness always 'ready' in tunnel tests (not the focus here)
    if (u.includes('/api/deployments/readiness')) {
      return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
    }
    if (u.includes('/api/github/packages') && !u.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({
        packages: [{ name: 'brew-assistent', fullImageRef: 'ghcr.io/org/brew-assistent' }],
      }) };
    }
    if (u.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({ tags: [{ tag: 'v1.0.0' }] }) };
    }
    if (u.includes('/api/deployments/vps-targets')) {
      // S-186 AC8: tunnelIds map
      return { ok: true, status: 200, json: async () => ({ vpsIds, tunnelIds }) };
    }
    if (u.includes('/api/cloudflare/zones')) {
      return { ok: true, status: 200, json: async () => ({ zones: [{ id: 'zone-1', name: 'alexstuder.cloud' }] }) };
    }
    if (u.includes('/api/deployments') && !u.includes('/vps-targets') && !u.includes('/stacks') && !u.includes('/readiness') && !u.includes('/vps-tunnel-status')) {
      return { ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

function renderView(props = {}) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(DeploymentsView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

/** Select a VPS in the deploy form. Waits for VPS dropdown to be populated. */
async function selectVps(utils, vpsId = 'vps-1') {
  await waitFor(() => {
    const sel = utils.container.querySelector('#deploy-vps-select');
    expect(sel.querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-vps-select'), {
      target: { value: vpsId },
    });
  });
}

/** Fill the full deploy form without zone-tunnel dropdown (S-186 AC8). */
async function fillFullForm(utils) {
  await waitFor(() => {
    expect(utils.container.querySelector('#deploy-image-select').querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-image-select'), { target: { value: 'brew-assistent' } });
  });
  await waitFor(() => {
    expect(utils.container.querySelector('#deploy-tag-select').querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-tag-select'), { target: { value: 'v1.0.0' } });
  });
  await selectVps(utils);
  await waitFor(() => {
    expect(utils.container.querySelector('#deploy-zone-select').querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-zone-select'), { target: { value: 'alexstuder.cloud' } });
  });
  // S-186 AC9: wait for Tunnel-Badge to confirm tunnel status resolved from vps-tunnel-status
  await waitFor(() => {
    const badge = utils.container.querySelector('[aria-label*="Tunnel-Status"]');
    expect(badge).not.toBeNull();
  });
}

// ── AC9: Badge nur bei VPS-Auswahl ───────────────────────────────────────────

describe('AC9 — Tunnel-Badge: kein Badge ohne VPS-Auswahl', () => {
  it('shows no tunnel badge when no VPS is selected', async () => {
    globalThis.fetch = makeTunnelFetch();
    const utils = renderView();
    await act(async () => { jest.advanceTimersByTime(100); });
    const badge = utils.container.querySelector('[aria-label*="Tunnel-Status"]');
    expect(badge).toBeNull();
  });

  it('does not call /api/deployments/vps-tunnel-status when no VPS selected', async () => {
    const fetchMock = makeTunnelFetch();
    globalThis.fetch = fetchMock;
    renderView();
    await act(async () => { jest.advanceTimersByTime(10000); });
    const tunnelCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/deployments/vps-tunnel-status'),
    );
    expect(tunnelCalls.length).toBe(0);
  });
});

// ── AC9: Badge-Text je Zustand ─────────────────────────────────────────────────

describe('AC9 — Tunnel-Badge: Text je Zustand', () => {
  it('shows "Tunnel ✓" when tunnelPresent=true', async () => {
    globalThis.fetch = makeTunnelFetch({ tunnelPresent: true });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[aria-label*="Tunnel-Status"]');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('Tunnel ✓');
    });
  });

  it('shows "Tunnel fehlt ✗" when tunnelPresent=false', async () => {
    globalThis.fetch = makeTunnelFetch({ tunnelPresent: false });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[aria-label*="Tunnel-Status"]');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('Tunnel fehlt ✗');
    });
  });

  it('shows "Tunnel fehlt ✗" when tunnelPresent="unknown" (Cloudflare unavailable)', async () => {
    globalThis.fetch = makeTunnelFetch({ tunnelPresent: 'unknown' });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[aria-label*="Tunnel-Status"]');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('Tunnel fehlt ✗');
    });
  });

  it('badge disappears when VPS is deselected', async () => {
    globalThis.fetch = makeTunnelFetch({ tunnelPresent: true });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => {
      expect(utils.container.querySelector('[aria-label*="Tunnel-Status"]')).not.toBeNull();
    });
    // Deselect VPS
    await act(async () => {
      fireEvent.change(utils.container.querySelector('#deploy-vps-select'), { target: { value: '' } });
    });
    expect(utils.container.querySelector('[aria-label*="Tunnel-Status"]')).toBeNull();
  });

  it('badge has role=status and aria-live=polite', async () => {
    globalThis.fetch = makeTunnelFetch({ tunnelPresent: true });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[aria-label*="Tunnel-Status"]');
      expect(badge).not.toBeNull();
      expect(badge.getAttribute('role')).toBe('status');
      expect(badge.getAttribute('aria-live')).toBe('polite');
    });
  });

  it('polling stops when tunnelPresent=true (no further calls after first)', async () => {
    let callCount = 0;
    globalThis.fetch = makeTunnelFetch({
      tunnelStatusFn: async (u) => {
        if (u.includes('/api/deployments/vps-tunnel-status')) {
          callCount++;
          return { ok: true, status: 200, json: async () => [{ vpsId: 'vps-1', tunnelId: 'tunnel-abc', tunnelPresent: true }] };
        }
      },
    });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(1));
    const countAfterReady = callCount;
    // Advance several intervals — no more calls
    await act(async () => { jest.advanceTimersByTime(30000); });
    expect(callCount).toBe(countAfterReady);
  });

  it('polling continues when tunnelPresent=false', async () => {
    let callCount = 0;
    globalThis.fetch = makeTunnelFetch({
      tunnelStatusFn: async (u) => {
        if (u.includes('/api/deployments/vps-tunnel-status')) {
          callCount++;
          return { ok: true, status: 200, json: async () => [{ vpsId: 'vps-1', tunnelId: null, tunnelPresent: false }] };
        }
      },
    });
    const utils = renderView();
    await selectVps(utils);
    // First poll
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(1));
    const countAfterFirst = callCount;
    // More intervals → more polls
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(callCount).toBeGreaterThan(countAfterFirst);
  });

  it('clears tunnel poll timer on unmount', async () => {
    let callCount = 0;
    globalThis.fetch = makeTunnelFetch({
      tunnelStatusFn: async (u) => {
        if (u.includes('/api/deployments/vps-tunnel-status')) {
          callCount++;
          return { ok: true, status: 200, json: async () => [{ vpsId: 'vps-1', tunnelId: null, tunnelPresent: false }] };
        }
      },
    });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(1));
    await act(async () => { utils.unmount(); });
    const countAtUnmount = callCount;
    await act(async () => { jest.advanceTimersByTime(30000); });
    expect(callCount).toBe(countAtUnmount);
  });
});

// ── AC8: tunnelId aus VPS-Kopplung (nicht Dropdown) ─────────────────────────

describe('AC8 — tunnelId from VPS-linked Read-Model', () => {
  it('shows linked tunnel-id display when VPS selected', async () => {
    // vps-1 is linked to 'tunnel-abc' via tunnelIds map
    globalThis.fetch = makeTunnelFetch({ tunnelPresent: true, tunnelIds: { 'vps-1': 'tunnel-abc' } });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    // Tunnel-Kopplung display should show the linked tunnel ID (AC8 — non-secret)
    await waitFor(() => {
      const text = utils.container.textContent;
      expect(text).toContain('tunnel-abc');
    });
  });

  it('shows placeholder text when VPS has no registered tunnel', async () => {
    // vps-1 has null tunnelId
    globalThis.fetch = makeTunnelFetch({
      tunnelPresent: false,
      tunnelIds: { 'vps-1': null },
    });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => {
      const text = utils.container.textContent;
      expect(text).toMatch(/kein tunnel|kein.*zugeordnet/i);
    });
  });

  it('POST body tunnelId equals the VPS-linked tunnelId from Read-Model, not from dropdown', async () => {
    let capturedBody;
    const tunnelIds = { 'vps-1': 'vps-linked-tunnel-xyz' };
    globalThis.fetch = jest.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/deployments' && init?.method === 'POST') {
        capturedBody = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ result: 'ok', deployment: { replaced: false } }) };
      }
      if (u.includes('/api/deployments/readiness')) {
        return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      }
      if (u.includes('/api/deployments/vps-tunnel-status')) {
        return { ok: true, status: 200, json: async () => [{ vpsId: 'vps-1', tunnelId: 'vps-linked-tunnel-xyz', tunnelPresent: true }] };
      }
      if (u.includes('/api/github/packages') && !u.includes('/tags')) {
        return { ok: true, status: 200, json: async () => ({ packages: [{ name: 'brew-assistent', fullImageRef: 'ghcr.io/org/brew-assistent' }] }) };
      }
      if (u.includes('/tags')) {
        return { ok: true, status: 200, json: async () => ({ tags: [{ tag: 'v1.0.0' }] }) };
      }
      if (u.includes('/api/deployments/vps-targets')) {
        return { ok: true, status: 200, json: async () => ({ vpsIds: ['vps-1'], tunnelIds }) };
      }
      if (u.includes('/api/cloudflare/zones')) {
        return { ok: true, status: 200, json: async () => ({ zones: [{ id: 'zone-1', name: 'alexstuder.cloud' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) };
    });

    const utils = renderView();
    await fillFullForm(utils);
    // Allow timer to resolve readiness + tunnel
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
      expect(btn.disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    await waitFor(() => { expect(capturedBody).toBeDefined(); });
    // tunnelId MUST be the VPS-linked one (not from any dropdown)
    expect(capturedBody.tunnelId).toBe('vps-linked-tunnel-xyz');
    expect(capturedBody.vps).toBe('vps-1');
  });
});

// ── AC10: Deploy-Button gesperrt solange Tunnel fehlt ────────────────────────

describe('AC10 — Deploy-Button gesperrt solange tunnelPresent !== true', () => {
  it('Deploy-Button disabled when tunnel is missing (tunnelPresent=false)', async () => {
    globalThis.fetch = makeTunnelFetch({ tunnelPresent: false });
    const utils = renderView();
    await fillFullForm(utils);
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[aria-label*="Tunnel-Status"]');
      expect(badge).not.toBeNull();
    });
    const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
    expect(btn.disabled).toBe(true);
  });

  it('Deploy-Button disabled when tunnelPresent="unknown" (CF unavailable)', async () => {
    globalThis.fetch = makeTunnelFetch({ tunnelPresent: 'unknown' });
    const utils = renderView();
    await fillFullForm(utils);
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[aria-label*="Tunnel-Status"]');
      expect(badge).not.toBeNull();
    });
    const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
    expect(btn.disabled).toBe(true);
  });

  it('Deploy-Button enabled automatically when tunnel transitions to present', async () => {
    let callCount = 0;
    globalThis.fetch = makeTunnelFetch({
      tunnelStatusFn: async (u) => {
        if (u.includes('/api/deployments/vps-tunnel-status')) {
          callCount++;
          const present = callCount >= 2; // first poll: false, second: true
          return { ok: true, status: 200, json: async () => [{ vpsId: 'vps-1', tunnelId: 'tunnel-abc', tunnelPresent: present }] };
        }
      },
    });
    const utils = renderView();
    await fillFullForm(utils);

    // First poll → tunnelPresent=false → button disabled
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[aria-label*="Tunnel-Status"]');
      expect(badge?.textContent).toContain('Tunnel fehlt ✗');
    });
    expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(true);

    // Advance past poll interval → second poll → tunnelPresent=true → button enabled
    await act(async () => { jest.advanceTimersByTime(6000); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[aria-label*="Tunnel-Status"]');
      expect(badge?.textContent).toContain('Tunnel ✓');
    });
    const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
    expect(btn.disabled).toBe(false);
  });

  it('Deploy-Button enabled when both VPS ready and tunnel present', async () => {
    globalThis.fetch = makeTunnelFetch({ tunnelPresent: true });
    const utils = renderView();
    await fillFullForm(utils);
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
      expect(btn.disabled).toBe(false);
    });
  });
});
