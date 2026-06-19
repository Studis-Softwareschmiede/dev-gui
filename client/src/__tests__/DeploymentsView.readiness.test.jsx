/**
 * DeploymentsView.readiness.test.jsx
 *
 * Covers (vps-readiness-gate.md, S-181):
 *   AC9  — Readiness-Badge neben VPS-Dropdown; kein Badge/Poll ohne VPS-Auswahl;
 *           Badge-Text je Zustand (unreachable / provisioning / ready)
 *   AC10 — Deploy-Button deaktiviert bis VPS ready; automatisch freigegeben wenn ready
 *   AC11 — Polling stoppt bei ready (kein Dauer-Poll); Timer-Cleanup bei Unmount und VPS-Wechsel
 *   AC12 — errorClass vps-provisioning / docker-failed → Retry-Hinweis; andere Klassen unverändert
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
 * Baseline fetch stub: empty dropdown lists + configurable readiness response.
 *
 * @param {{ readinessState?: string, readinessFn?: Function }} opts
 */
function makeReadinessFetch({ readinessState = 'ready', readinessFn } = {}) {
  return jest.fn(async (url) => {
    const u = String(url);

    if (u.includes('/api/deployments/readiness')) {
      if (readinessFn) return readinessFn(u);
      return { ok: true, status: 200, json: async () => ({ state: readinessState }) };
    }
    if (u.includes('/api/github/packages') && !u.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({ packages: [{ name: 'brew-assistent', fullImageRef: 'ghcr.io/org/brew-assistent' }] }) };
    }
    if (u.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({ tags: [{ tag: 'v1.0.0' }] }) };
    }
    if (u.includes('/api/deployments/vps-targets')) {
      return { ok: true, status: 200, json: async () => ({ vpsIds: ['vps-1', 'vps-2'] }) };
    }
    if (u.includes('/api/cloudflare/zones/') && u.includes('/tunnels')) {
      return { ok: true, status: 200, json: async () => ({ tunnels: [{ id: 'tunnel-1', name: 'main' }] }) };
    }
    if (u.includes('/api/cloudflare/zones')) {
      return { ok: true, status: 200, json: async () => ({ zones: [{ id: 'zone-1', name: 'alexstuder.cloud' }] }) };
    }
    if (u.includes('/api/deployments') && !u.includes('/vps-targets') && !u.includes('/stacks') && !u.includes('/readiness')) {
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

/** Fill the full deploy form (image + tag + vps + zone + tunnel + subdomain). */
async function fillFullForm(utils) {
  // Wait for image dropdown
  await waitFor(() => {
    expect(utils.container.querySelector('#deploy-image-select').querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-image-select'), { target: { value: 'brew-assistent' } });
  });
  // Wait for tag dropdown
  await waitFor(() => {
    expect(utils.container.querySelector('#deploy-tag-select').querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-tag-select'), { target: { value: 'v1.0.0' } });
  });
  // VPS
  await selectVps(utils);
  // Zone
  await waitFor(() => {
    expect(utils.container.querySelector('#deploy-zone-select').querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-zone-select'), { target: { value: 'alexstuder.cloud' } });
  });
  // Tunnel
  await waitFor(() => {
    const sel = utils.container.querySelector('#deploy-tunnel-select');
    expect(sel).not.toBeNull();
    expect(sel.querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-tunnel-select'), { target: { value: 'tunnel-1' } });
  });
}

// ── AC9: Badge only when VPS selected ─────────────────────────────────────────

describe('AC9 — Readiness-Badge: kein Badge ohne VPS-Auswahl', () => {
  it('shows no readiness badge when no VPS is selected', async () => {
    globalThis.fetch = makeReadinessFetch();
    const utils = renderView();
    // Advance timers but don't select a VPS
    await act(async () => { jest.advanceTimersByTime(100); });
    const badge = utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]');
    expect(badge).toBeNull();
  });

  it('does not call /api/deployments/readiness when no VPS selected', async () => {
    const fetchMock = makeReadinessFetch();
    globalThis.fetch = fetchMock;
    renderView();
    await act(async () => { jest.advanceTimersByTime(6000); });
    const readinessCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/deployments/readiness'),
    );
    expect(readinessCalls.length).toBe(0);
  });
});

// ── AC9: Badge text per readiness state ───────────────────────────────────────

describe('AC9 — Readiness-Badge: Text je Zustand', () => {
  it('shows "⏳ VPS wird hochgefahren…" for unreachable state', async () => {
    globalThis.fetch = makeReadinessFetch({ readinessState: 'unreachable' });
    const utils = renderView();
    await selectVps(utils);
    // Allow the first poll to resolve
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('VPS wird hochgefahren');
    });
  });

  it('shows "⏳ VPS wird eingerichtet (Docker installieren)…" for provisioning state', async () => {
    globalThis.fetch = makeReadinessFetch({ readinessState: 'provisioning' });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('Docker installieren');
    });
  });

  it('shows "✅ VPS bereit" for ready state', async () => {
    globalThis.fetch = makeReadinessFetch({ readinessState: 'ready' });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('VPS bereit');
    });
  });

  it('badge has role=status and aria-live=polite', async () => {
    globalThis.fetch = makeReadinessFetch({ readinessState: 'ready' });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[role="status"]');
      expect(badge).not.toBeNull();
      expect(badge.getAttribute('aria-live')).toBe('polite');
    });
  });
});

// ── AC10: Deploy-Button gesperrt bis ready ─────────────────────────────────────

describe('AC10 — Deploy-Button gesperrt bis VPS ready', () => {
  it('Deploy-Button disabled when VPS selected but not yet ready (provisioning)', async () => {
    globalThis.fetch = makeReadinessFetch({ readinessState: 'provisioning' });
    const utils = renderView();
    await fillFullForm(utils);
    // Allow polls to resolve
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]');
      expect(badge).not.toBeNull();
    });
    const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
    expect(btn.disabled).toBe(true);
  });

  it('Deploy-Button disabled for unreachable state', async () => {
    globalThis.fetch = makeReadinessFetch({ readinessState: 'unreachable' });
    const utils = renderView();
    await fillFullForm(utils);
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]');
      expect(badge).not.toBeNull();
    });
    const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
    expect(btn.disabled).toBe(true);
  });

  it('Deploy-Button enabled automatically when VPS transitions to ready', async () => {
    let callCount = 0;
    // First poll: provisioning, subsequent: ready
    globalThis.fetch = makeReadinessFetch({
      readinessFn: async (url) => {
        if (url.includes('/api/deployments/readiness')) {
          callCount++;
          const state = callCount === 1 ? 'provisioning' : 'ready';
          return { ok: true, status: 200, json: async () => ({ state }) };
        }
      },
    });
    const utils = renderView();
    await fillFullForm(utils);

    // First poll → provisioning → button still disabled
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]');
      expect(badge?.textContent).toContain('eingerichtet');
    });
    expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(true);

    // Advance past interval → second poll → ready → button enabled automatically
    await act(async () => { jest.advanceTimersByTime(3500); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]');
      expect(badge?.textContent).toContain('VPS bereit');
    });
    const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
    expect(btn.disabled).toBe(false);
  });
});

// ── AC11: Poll stoppt bei ready; Timer-Cleanup ────────────────────────────────

describe('AC11 — Poll stoppt bei ready; Timer-Cleanup', () => {
  it('stops polling once ready is reached (no further readiness calls)', async () => {
    let readinessCalls = 0;
    globalThis.fetch = makeReadinessFetch({
      readinessFn: async (url) => {
        if (url.includes('/api/deployments/readiness')) {
          readinessCalls++;
          return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
        }
      },
    });
    const utils = renderView();
    await selectVps(utils);

    // First poll fires immediately
    await act(async () => { jest.advanceTimersByTime(100); });
    await waitFor(() => expect(readinessCalls).toBeGreaterThanOrEqual(1));

    const countAfterReady = readinessCalls;

    // Advance several intervals — no more polls should occur
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(readinessCalls).toBe(countAfterReady);
  });

  it('restarts polling when a different (not-ready) VPS is selected', async () => {
    let calls = [];
    globalThis.fetch = makeReadinessFetch({
      readinessFn: async (url) => {
        if (url.includes('/api/deployments/readiness')) {
          calls.push(url);
          // vps-1 → ready; vps-2 → provisioning
          const vpsMatch = url.match(/vps=([^&]+)/);
          const vps = vpsMatch ? decodeURIComponent(vpsMatch[1]) : '';
          const state = vps === 'vps-1' ? 'ready' : 'provisioning';
          return { ok: true, status: 200, json: async () => ({ state }) };
        }
      },
    });
    const utils = renderView();

    // Select vps-1 → reaches ready → polling stops
    await selectVps(utils, 'vps-1');
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]');
      expect(badge?.textContent).toContain('VPS bereit');
    });
    const callsAfterVps1 = calls.length;

    // Advance — no more polls for vps-1
    await act(async () => { jest.advanceTimersByTime(6000); });
    expect(calls.length).toBe(callsAfterVps1);

    // Switch to vps-2 → polling restarts
    await selectVps(utils, 'vps-2');
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const badge = utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]');
      expect(badge?.textContent).toContain('eingerichtet');
    });
    // More readiness calls now (for vps-2)
    expect(calls.filter((u) => u.includes('vps-2')).length).toBeGreaterThanOrEqual(1);
  });

  it('clears timer on unmount (no poll on unmounted component)', async () => {
    let callCount = 0;
    globalThis.fetch = makeReadinessFetch({
      readinessFn: async (url) => {
        if (url.includes('/api/deployments/readiness')) {
          callCount++;
          return { ok: true, status: 200, json: async () => ({ state: 'provisioning' }) };
        }
      },
    });
    const utils = renderView();
    await selectVps(utils);

    // Let first poll fire
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(1));

    // Unmount
    await act(async () => {
      utils.unmount();
    });
    const countAtUnmount = callCount;

    // Advance timers after unmount — no more calls
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(callCount).toBe(countAtUnmount);
  });

  it('stops polling on VPS deselect (back to empty)', async () => {
    let callCount = 0;
    globalThis.fetch = makeReadinessFetch({
      readinessFn: async (url) => {
        if (url.includes('/api/deployments/readiness')) {
          callCount++;
          return { ok: true, status: 200, json: async () => ({ state: 'provisioning' }) };
        }
      },
    });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(1));

    // Deselect VPS
    await act(async () => {
      fireEvent.change(utils.container.querySelector('#deploy-vps-select'), { target: { value: '' } });
    });
    const countAfterDeselect = callCount;

    // Advance timers — no further polls
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(callCount).toBe(countAfterDeselect);
  });

  it('badge disappears when VPS is deselected', async () => {
    globalThis.fetch = makeReadinessFetch({ readinessState: 'provisioning' });
    const utils = renderView();
    await selectVps(utils);
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      expect(utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]')).not.toBeNull();
    });

    // Deselect
    await act(async () => {
      fireEvent.change(utils.container.querySelector('#deploy-vps-select'), { target: { value: '' } });
    });
    expect(utils.container.querySelector('[role="status"][aria-label*="VPS-Bereitschaft"]')).toBeNull();
  });
});

// ── AC12: errorClass-Mapping → Retry-Hinweis ──────────────────────────────────

describe('AC12 — errorClass vps-provisioning / docker-failed → Retry-Hinweis', () => {
  /** Build a fetch stub that returns a given errorClass from POST /api/deployments */
  function makeDeployErrorFetch(errorClass) {
    return jest.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/deployments' && init?.method === 'POST') {
        return {
          ok: false,
          status: 422,
          json: async () => ({ result: 'error', errorClass, reason: 'raw backend reason' }),
        };
      }
      if (u.includes('/api/deployments/readiness')) {
        return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      }
      if (u.includes('/api/github/packages') && !u.includes('/tags')) {
        return { ok: true, status: 200, json: async () => ({ packages: [{ name: 'brew-assistent', fullImageRef: 'ghcr.io/org/brew-assistent' }] }) };
      }
      if (u.includes('/tags')) {
        return { ok: true, status: 200, json: async () => ({ tags: [{ tag: 'v1.0.0' }] }) };
      }
      if (u.includes('/api/deployments/vps-targets')) {
        return { ok: true, status: 200, json: async () => ({ vpsIds: ['vps-1'] }) };
      }
      if (u.includes('/api/cloudflare/zones/') && u.includes('/tunnels')) {
        return { ok: true, status: 200, json: async () => ({ tunnels: [{ id: 'tunnel-1', name: 'main' }] }) };
      }
      if (u.includes('/api/cloudflare/zones')) {
        return { ok: true, status: 200, json: async () => ({ zones: [{ id: 'zone-1', name: 'alexstuder.cloud' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) };
    });
  }

  async function deployAndGetAlert(utils) {
    // Allow readiness to resolve to 'ready' so button enables
    await act(async () => { jest.advanceTimersByTime(200); });
    await fillFullForm(utils);
    await act(async () => { jest.advanceTimersByTime(200); });
    await waitFor(() => {
      const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
      expect(btn.disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    return utils.findByRole('alert');
  }

  it('errorClass "vps-provisioning" → Retry-Hinweis (Docker installieren)', async () => {
    globalThis.fetch = makeDeployErrorFetch('vps-provisioning');
    const utils = renderView();
    const alert = await deployAndGetAlert(utils);
    expect(alert.textContent).toContain('Docker installieren');
    expect(alert.textContent).toContain('erneut versuchen');
    // Must NOT show the raw error class string
    expect(alert.textContent).not.toContain('vps-provisioning');
  });

  it('errorClass "docker-failed" → same Retry-Hinweis (Docker installieren)', async () => {
    globalThis.fetch = makeDeployErrorFetch('docker-failed');
    const utils = renderView();
    const alert = await deployAndGetAlert(utils);
    expect(alert.textContent).toContain('Docker installieren');
    expect(alert.textContent).toContain('erneut versuchen');
    expect(alert.textContent).not.toContain('docker-failed');
  });

  it('other errorClass "protected-resource" shows its own user-friendly message', async () => {
    globalThis.fetch = makeDeployErrorFetch('protected-resource');
    const utils = renderView();
    const alert = await deployAndGetAlert(utils);
    expect(alert.textContent).toMatch(/geschuetzt/i);
    // Must NOT show the docker retry hint
    expect(alert.textContent).not.toContain('Docker installieren');
  });

  it('unknown errorClass falls through to default formatting (no raw secret)', async () => {
    globalThis.fetch = makeDeployErrorFetch('zone-not-found');
    const utils = renderView();
    const alert = await deployAndGetAlert(utils);
    // Default: string passthrough (sanitized)
    expect(alert.textContent).toBeTruthy();
    expect(alert.textContent).toContain('zone-not-found');
  });
});
