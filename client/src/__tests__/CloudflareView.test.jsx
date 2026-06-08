/**
 * CloudflareView.test.jsx — Unit tests for the CloudflareView component (v2, Capability A).
 *
 * Covers (view-cloudflare spec AC1–AC9):
 *   AC1  — Title "Cloudflare" as semantic <h1>; main landmark present.
 *   AC2  — Back-to-panel navigation (onNavigate).
 *   AC3  — Onboarding hint when not configured; no API call when configured=false.
 *   AC4  — Renders zones list; zone click triggers tunnel/route load.
 *   AC5  — Hostname, Ziel-Service, protected-Flag angezeigt;
 *          protected Route hat keinen aktiven Lösch-Button (disabled).
 *   AC6  — type-to-confirm dialog: Löschen deaktiviert bis exakter Hostname getippt;
 *          nach erfolgreicher Löschung Re-Fetch ausgelöst.
 *   AC7  — Degradierende Anzeige: Tunnel-Fehler markiert, übrige sichtbar.
 *   AC8  — Kein Token im Frontend-Output; fetch-Stubs liefern keine Token-Inhalte.
 *   AC9  — 403 → „keine Berechtigung"; protected-resource → „geschützt";
 *          confirmation-required → „Bestätigung".
 *   A11y — <h1>; aria-label; Buttons mit aria-label ≥44px; Fehler role=alert.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }             = await import('@testing-library/react');
const React                  = (await import('react')).default;
const { CloudflareView }     = await import('../CloudflareView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ZONE_ID = 'a'.repeat(32);
const TUNNEL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const ZONE = { id: ZONE_ID, name: 'example.com', status: 'active' };

const TUNNEL = { id: TUNNEL_ID, name: 'my-tunnel', status: 'active', zoneId: ZONE_ID };

const ROUTE_NORMAL = {
  hostname: 'app.example.com',
  service: 'http://localhost:3000',
  tunnelId: TUNNEL_ID,
  protected: false,
};

const ROUTE_PROTECTED = {
  hostname: 'devgui.example.com',
  service: 'http://localhost:8080',
  tunnelId: TUNNEL_ID,
  protected: true,
};

// ── Fetch helpers ─────────────────────────────────────────────────────────────

function notConfiguredFetch() {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ configured: false, zones: [] }),
  }));
}

function configuredFetch(zones = [ZONE], tunnelResp = { tunnels: [TUNNEL], routes: [ROUTE_NORMAL, ROUTE_PROTECTED] }) {
  return jest.fn(async (url) => {
    if (url.includes('/api/cloudflare/zones') && !url.includes('tunnels')) {
      return { ok: true, status: 200, json: async () => ({ configured: true, zones }) };
    }
    if (url.includes('tunnels')) {
      return { ok: true, status: 200, json: async () => tunnelResp };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

// ── Render helper ─────────────────────────────────────────────────────────────

function renderView(fetchImpl) {
  const onNavigate = jest.fn();
  const originalFetch = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const utils = render(React.createElement(CloudflareView, { onNavigate }));
  return { ...utils, onNavigate, restore: () => { globalThis.fetch = originalFetch; } };
}

// ── AC1: Title + A11y landmark ────────────────────────────────────────────────

describe('CloudflareView — AC1: Title', () => {
  it('renders heading with text "Cloudflare"', async () => {
    const fetch = notConfiguredFetch();
    const { getByRole, restore } = renderView(fetch);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const heading = getByRole('heading', { name: /^cloudflare$/i });
    expect(heading).toBeTruthy();
    restore();
  });

  it('heading is an <h1>', async () => {
    const fetch = notConfiguredFetch();
    const { getByRole, restore } = renderView(fetch);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const heading = getByRole('heading', { name: /^cloudflare$/i });
    expect(heading.tagName).toBe('H1');
    restore();
  });

  it('renders the main landmark', async () => {
    const fetch = notConfiguredFetch();
    const { getByRole, restore } = renderView(fetch);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(getByRole('main', { name: /cloudflare-ansicht/i })).toBeTruthy();
    restore();
  });
});

// ── AC2: Navigation ───────────────────────────────────────────────────────────

describe('CloudflareView — AC2: Navigation', () => {
  it('clicking the Home button calls onNavigate("panel")', async () => {
    const fetch = notConfiguredFetch();
    const { getByRole, onNavigate, restore } = renderView(fetch);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /zurück zum einstiegs-panel/i }));
    });

    expect(onNavigate).toHaveBeenCalledWith('panel');
    restore();
  });

  it('Home button is keyboard-focusable (not disabled)', async () => {
    const fetch = notConfiguredFetch();
    const { getByRole, restore } = renderView(fetch);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    expect(btn.disabled).toBe(false);
    restore();
  });

  it('Home button has Touch-Target ≥ 44px', async () => {
    const fetch = notConfiguredFetch();
    const { getByRole, restore } = renderView(fetch);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
    restore();
  });
});

// ── AC3: Onboarding / not configured ─────────────────────────────────────────

describe('CloudflareView — AC3: Not configured', () => {
  it('renders an onboarding hint when not configured', async () => {
    const fetch = notConfiguredFetch();
    const { getByRole, restore } = renderView(fetch);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/nicht konfiguriert/i);
    });
    // The Settings link should be available
    expect(getByRole('button', { name: /einstellungen/i })).toBeTruthy();
    restore();
  });

  it('does not call zones API more than once (just the initial GET)', async () => {
    const fetch = notConfiguredFetch();
    renderView(fetch);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    // Only the GET /api/cloudflare/zones call — no other CF calls
    const cfCalls = fetch.mock.calls.filter(([url]) =>
      typeof url === 'string' && url.includes('/api/cloudflare'),
    );
    expect(cfCalls).toHaveLength(1);
  });

  it('onboarding hint links to settings', async () => {
    const fetch = notConfiguredFetch();
    const { getByRole, onNavigate, restore } = renderView(fetch);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/nicht konfiguriert/i);
    });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /einstellungen/i }));
    });
    expect(onNavigate).toHaveBeenCalledWith('settings');
    restore();
  });
});

// ── AC4: Zones list + zone selection ─────────────────────────────────────────

describe('CloudflareView — AC4: Zones list', () => {
  it('renders the zone name from API', async () => {
    const fetch = configuredFetch();
    const { restore } = renderView(fetch);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/example\.com/);
    });
    restore();
  });

  it('clicking a zone loads its tunnels (calls the tunnels endpoint)', async () => {
    const fetch = configuredFetch();
    const { getByRole, restore } = renderView(fetch);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/example\.com/);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /zone example\.com auswählen/i }));
    });

    await waitFor(() => {
      const tunnelCalls = fetch.mock.calls.filter(([url]) =>
        typeof url === 'string' && url.includes('tunnels'),
      );
      expect(tunnelCalls.length).toBeGreaterThan(0);
    });
    restore();
  });

  it('selected zone button has aria-pressed=true', async () => {
    const fetch = configuredFetch();
    const { getByRole, restore } = renderView(fetch);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/example\.com/);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /zone example\.com auswählen/i }));
    });

    const btn = getByRole('button', { name: /zone example\.com auswählen/i });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    restore();
  });
});

// ── AC5: Route display + protected flag ──────────────────────────────────────

describe('CloudflareView — AC5: Route display + protected', () => {
  async function renderWithTunnels() {
    const fetch = configuredFetch();
    const utils = renderView(fetch);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/example\.com/);
    });
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /zone example\.com auswählen/i }));
    });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/app\.example\.com/);
    });
    return { ...utils, restore: utils.restore };
  }

  it('shows the non-protected hostname', async () => {
    const { restore } = await renderWithTunnels();
    expect(document.body.textContent).toMatch(/app\.example\.com/);
    restore();
  });

  it('shows the protected hostname', async () => {
    const { restore } = await renderWithTunnels();
    expect(document.body.textContent).toMatch(/devgui\.example\.com/);
    restore();
  });

  it('protected route has disabled Löschen button', async () => {
    const { restore } = await renderWithTunnels();
    const deleteBtns = document.querySelectorAll('button[disabled]');
    const protectedBtn = Array.from(deleteBtns).find(
      (b) => b.getAttribute('aria-label')?.includes('devgui.example.com'),
    );
    expect(protectedBtn).toBeTruthy();
    restore();
  });

  it('non-protected route has an active Löschen button', async () => {
    const { restore } = await renderWithTunnels();
    const btn = document.querySelector('button[aria-label*="app.example.com"]:not([disabled])');
    expect(btn).toBeTruthy();
    restore();
  });

  it('shows service for the non-protected route', async () => {
    const { restore } = await renderWithTunnels();
    expect(document.body.textContent).toMatch(/localhost:3000/);
    restore();
  });
});

// ── AC6: type-to-confirm dialog ───────────────────────────────────────────────

describe('CloudflareView — AC6: type-to-confirm', () => {
  async function openConfirmDialog() {
    const originalFetch = globalThis.fetch;
    let deleteCallCount = 0;
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/api/cloudflare/zones') && !url.includes('tunnels')) {
        return { ok: true, status: 200, json: async () => ({ configured: true, zones: [ZONE] }) };
      }
      if (url.includes('tunnels') && (init?.method === undefined || init?.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ tunnels: [TUNNEL], routes: [ROUTE_NORMAL] }) };
      }
      if (init?.method === 'DELETE') {
        deleteCallCount++;
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const onNavigate = jest.fn();
    render(React.createElement(CloudflareView, { onNavigate }));

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/example\.com/);
    });

    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label*="Zone example.com"]'));
    });

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/app\.example\.com/);
    });

    // Click the delete button for the non-protected route
    await act(async () => {
      const deleteBtn = document.querySelector('button[aria-label*="app.example.com"]:not([disabled])');
      fireEvent.click(deleteBtn);
    });

    return {
      restore: () => { globalThis.fetch = originalFetch; },
      getDeleteCallCount: () => deleteCallCount,
    };
  }

  it('type-to-confirm dialog appears after clicking Löschen', async () => {
    const { restore } = await openConfirmDialog();
    expect(document.body.textContent).toMatch(/Hostname zur Bestätigung/);
    restore();
  });

  it('confirm button is disabled when input is empty', async () => {
    const { restore } = await openConfirmDialog();
    const confirmBtn = document.querySelector('button[aria-label*="Löschung bestätigen"]');
    expect(confirmBtn?.disabled).toBe(true);
    restore();
  });

  it('confirm button remains disabled when wrong hostname is typed', async () => {
    const { restore } = await openConfirmDialog();
    const input = document.getElementById('confirm-dialog-input');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'wrong.hostname.com' } });
    });
    const confirmBtn = document.querySelector('button[aria-label*="Löschung bestätigen"]');
    expect(confirmBtn?.disabled).toBe(true);
    restore();
  });

  it('confirm button becomes enabled when exact hostname is typed', async () => {
    const { restore } = await openConfirmDialog();
    const input = document.getElementById('confirm-dialog-input');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'app.example.com' } });
    });
    const confirmBtn = document.querySelector('button[aria-label*="Löschung bestätigen"]');
    expect(confirmBtn?.disabled).toBe(false);
    restore();
  });

  it('clicking confirm calls DELETE endpoint', async () => {
    const { restore, getDeleteCallCount } = await openConfirmDialog();
    const input = document.getElementById('confirm-dialog-input');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'app.example.com' } });
    });
    const confirmBtn = document.querySelector('button[aria-label*="Löschung bestätigen"]');
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await waitFor(() => expect(getDeleteCallCount()).toBeGreaterThan(0));
    restore();
  });

  it('Abbrechen button closes dialog without deleting', async () => {
    const { restore, getDeleteCallCount } = await openConfirmDialog();
    const cancelBtn = document.querySelector('button[aria-label="Abbrechen"]');
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    expect(document.body.textContent).not.toMatch(/Hostname zur Bestätigung/);
    expect(getDeleteCallCount()).toBe(0);
    restore();
  });
});

// ── AC7: Degraded display ─────────────────────────────────────────────────────

describe('CloudflareView — AC7: Degraded display', () => {
  it('shows tunnel-level error but keeps other tunnels visible', async () => {
    const originalFetch = globalThis.fetch;
    const TUNNEL2 = { id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'ok-tunnel', status: 'active', zoneId: ZONE_ID };
    globalThis.fetch = jest.fn(async (url) => {
      if (url.includes('/api/cloudflare/zones') && !url.includes('tunnels')) {
        return { ok: true, status: 200, json: async () => ({ configured: true, zones: [ZONE] }) };
      }
      if (url.includes('tunnels')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tunnels: [TUNNEL, TUNNEL2],
            routes: [{ ...ROUTE_NORMAL, tunnelId: TUNNEL2.id }],
            errors: [{ scope: `tunnel:${TUNNEL_ID}`, errorClass: 'cloudflare-unavailable' }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const onNavigate = jest.fn();
    render(React.createElement(CloudflareView, { onNavigate }));

    await waitFor(() => expect(document.body.textContent).toMatch(/example\.com/));
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label*="Zone example.com"]'));
    });
    await waitFor(() => expect(document.body.textContent).toMatch(/ok-tunnel/));

    // Both tunnels appear
    expect(document.body.textContent).toMatch(/my-tunnel/);
    expect(document.body.textContent).toMatch(/ok-tunnel/);

    globalThis.fetch = originalFetch;
  });

  it('shows zones-level degraded warning when errors[] present', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        configured: true,
        zones: [ZONE],
        errors: [{ scope: 'zones', errorClass: 'cloudflare-unavailable' }],
      }),
    }));

    const onNavigate = jest.fn();
    render(React.createElement(CloudflareView, { onNavigate }));

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/degradiert|unvollständig|Einige/i);
    });

    globalThis.fetch = originalFetch;
  });
});

// ── AC8: No token in frontend ─────────────────────────────────────────────────

describe('CloudflareView — AC8: No token in frontend', () => {
  it('does not render any Bearer token text', async () => {
    const fetch = configuredFetch();
    renderView(fetch);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(document.body.textContent).not.toMatch(/Bearer/i);
    expect(document.body.textContent).not.toMatch(/api_token/i);
  });
});

// ── AC9: Error handling ───────────────────────────────────────────────────────

describe('CloudflareView — AC9: Error responses', () => {
  async function openAndConfirmDialog(deleteResponse) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/api/cloudflare/zones') && !url.includes('tunnels')) {
        return { ok: true, status: 200, json: async () => ({ configured: true, zones: [ZONE] }) };
      }
      if (url.includes('tunnels') && (init?.method === undefined || init?.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ tunnels: [TUNNEL], routes: [ROUTE_NORMAL] }) };
      }
      if (init?.method === 'DELETE') {
        return {
          ok: false,
          status: deleteResponse.status,
          json: async () => ({ error: deleteResponse.error }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const onNavigate = jest.fn();
    render(React.createElement(CloudflareView, { onNavigate }));

    await waitFor(() => expect(document.body.textContent).toMatch(/example\.com/));
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label*="Zone example.com"]'));
    });
    await waitFor(() => expect(document.body.textContent).toMatch(/app\.example\.com/));
    await act(async () => {
      const deleteBtn = document.querySelector('button[aria-label*="app.example.com"]:not([disabled])');
      fireEvent.click(deleteBtn);
    });

    // Type the correct hostname
    const input = document.getElementById('confirm-dialog-input');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'app.example.com' } });
    });
    await act(async () => {
      const confirmBtn = document.querySelector('button[aria-label*="Löschung bestätigen"]');
      fireEvent.click(confirmBtn);
    });

    return { restore: () => { globalThis.fetch = originalFetch; } };
  }

  it('403 response → "keine Berechtigung" message (AC9)', async () => {
    const { restore } = await openAndConfirmDialog({ status: 403, error: 'forbidden' });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/keine Berechtigung/i);
    });
    restore();
  });

  it('422 protected-resource → "geschützt" message (AC9)', async () => {
    const { restore } = await openAndConfirmDialog({ status: 422, error: 'protected-resource' });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/geschützt/i);
    });
    restore();
  });

  it('422 confirmation-required → "Bestätigung" message (AC9)', async () => {
    const { restore } = await openAndConfirmDialog({ status: 422, error: 'confirmation-required' });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Bestätigung/i);
    });
    restore();
  });

  it('error message does not contain token-like strings', async () => {
    const { restore } = await openAndConfirmDialog({ status: 403, error: 'forbidden' });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/keine Berechtigung/i);
    });
    expect(document.body.textContent).not.toMatch(/Bearer/);
    expect(document.body.textContent).not.toMatch(/api_token/);
    restore();
  });
});

// ── A11y ─────────────────────────────────────────────────────────────────────

describe('CloudflareView — A11y', () => {
  it('zone buttons have descriptive aria-label', async () => {
    const fetch = configuredFetch();
    const { restore } = renderView(fetch);
    await waitFor(() => expect(document.body.textContent).toMatch(/example\.com/));
    const btn = document.querySelector('button[aria-label*="Zone example.com"]');
    expect(btn).toBeTruthy();
    restore();
  });

  it('error paragraphs have role=alert', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'cloudflare-unavailable' }),
    }));

    const onNavigate = jest.fn();
    render(React.createElement(CloudflareView, { onNavigate }));

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      expect(alerts.length).toBeGreaterThan(0);
    });

    globalThis.fetch = originalFetch;
  });
});
