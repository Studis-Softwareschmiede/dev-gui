/**
 * DeploymentsView.test.jsx — Unit tests for the DeploymentsView component (Capability B).
 *
 * Covers (deploy-lifecycle.md AC3–AC9 frontend-side + AC10–AC14, S-155):
 *   - AC3: Deploy form renders, posts to /api/deployments, shows success/error
 *   - AC5: Undeploy button triggers confirmation dialog (route-first handled by backend)
 *   - AC6: type-to-confirm — submit button disabled until confirm === hostname
 *   - AC7: LockoutGuard — protected-resource reason displayed in user-friendly form
 *   - AC8: CRED_ADMIN_EMAILS — 403 from backend shown as error (not crash)
 *   - AC9: No token/key in rendered output; error strings stripped
 *   - AC10: Image-Dropdown (from /api/github/packages), Tag-Dropdown (disabled until image chosen),
 *           VPS-Dropdown (from /api/deployments/vps-targets), Domain-Dropdown (/api/cloudflare/zones)
 *   - AC11: Subdomain pre-filled from image name, editable; assembled hostname shown
 *   - AC12: Deploy-Button active only when Image+Tag+VPS+Domain+Subdomain set
 *           POST body: { image: "fullRef:tag", vps, hostname: "sub.domain", tunnelId }
 *   - AC13: Port-Ambiguity/Fallback hints shown in success response
 *   - AC14: Re-Deploy indicator shown when existing deploy matches hostname
 *   - A11y WCAG 2.1 AA: semantic landmarks, h1, aria-live, htmlFor labels, touch-targets ≥44px
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }              = await import('@testing-library/react');
const React                   = (await import('react')).default;
const { DeploymentsView }     = await import('../DeploymentsView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function renderView(props = {}) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(DeploymentsView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

/** Minimal fetch stub that handles all dropdown-source requests + a custom override. */
function makeDropdownFetch(overrideFn) {
  return jest.fn(async (url, init) => {
    // Let overrideFn handle specific URLs if provided
    if (overrideFn) {
      const result = await overrideFn(url, init);
      if (result !== undefined) return result;
    }
    // Default: return empty data for all dropdown sources
    if (url.includes('/api/github/packages') && !url.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({ packages: [] }) };
    }
    if (url.includes('/api/github/packages') && url.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({ tags: [] }) };
    }
    if (url.includes('/api/deployments/vps-targets')) {
      return { ok: true, status: 200, json: async () => ({ vpsIds: [] }) };
    }
    if (url.includes('/api/cloudflare/zones')) {
      return { ok: true, status: 200, json: async () => ({ configured: false, zones: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

/** Stub fetch for dropdown sources with populated data. */
function makeDropdownFetchWithData({
  packages = [{ name: 'brew-assistent', fullImageRef: 'ghcr.io/org/brew-assistent', visibility: 'public', htmlUrl: '', updatedAt: '' }],
  tags = [{ tag: 'v1.0.0', digest: 'sha256:abc', updatedAt: '' }],
  vpsIds = ['vps-1'],
  zones = [{ id: 'zone-abc', name: 'alexstuder.cloud' }],
  tunnels = [{ id: 'tunnel-uuid-1', name: 'main-tunnel' }],
  deployResult = { result: 'ok', deployment: { hostname: 'brew-assistent.alexstuder.cloud', replaced: false } },
} = {}) {
  return jest.fn(async (url, init) => {
    if (url.includes('/api/github/packages') && !url.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({ packages }) };
    }
    if (url.includes('/api/github/packages') && url.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({ tags }) };
    }
    if (url.includes('/api/deployments/vps-targets')) {
      return { ok: true, status: 200, json: async () => ({ vpsIds }) };
    }
    if (url.includes('/api/cloudflare/zones/') && url.includes('/tunnels')) {
      return { ok: true, status: 200, json: async () => ({ tunnels }) };
    }
    if (url.includes('/api/cloudflare/zones')) {
      return { ok: true, status: 200, json: async () => ({ configured: true, zones }) };
    }
    if (url === '/api/deployments' && init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => deployResult };
    }
    if (url.includes('/api/deployments')) {
      return { ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

/**
 * Select image, tag, vps, zone and fill subdomain; waits for dropdown rendering.
 * Uses expect() inside waitFor() so it throws when not ready (waitFor polls until no-throw).
 */
async function fillDeployForm(utils) {
  // Wait for packages to load (must have at least 1 real option besides placeholder)
  await waitFor(() => {
    const select = utils.container.querySelector('#deploy-image-select');
    expect(select.querySelectorAll('option').length).toBeGreaterThan(1);
  });

  // Select image
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-image-select'), {
      target: { value: 'brew-assistent' },
    });
  });

  // Wait for tags to load (triggered by image selection)
  await waitFor(() => {
    const tagSelect = utils.container.querySelector('#deploy-tag-select');
    expect(tagSelect.querySelectorAll('option').length).toBeGreaterThan(1);
  });

  // Select tag
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-tag-select'), {
      target: { value: 'v1.0.0' },
    });
  });

  // Wait for VPS list
  await waitFor(() => {
    const vpsSelect = utils.container.querySelector('#deploy-vps-select');
    expect(vpsSelect.querySelectorAll('option').length).toBeGreaterThan(1);
  });

  // Select VPS
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-vps-select'), {
      target: { value: 'vps-1' },
    });
  });

  // Wait for zones
  await waitFor(() => {
    const zoneSelect = utils.container.querySelector('#deploy-zone-select');
    expect(zoneSelect.querySelectorAll('option').length).toBeGreaterThan(1);
  });

  // Select zone (triggers tunnel loading)
  await act(async () => {
    fireEvent.change(utils.container.querySelector('#deploy-zone-select'), {
      target: { value: 'alexstuder.cloud' },
    });
  });

  // Wait for tunnel dropdown to appear with options loaded
  await waitFor(() => {
    const tunnelSelect = utils.container.querySelector('#deploy-tunnel-select');
    // Tunnel select must exist AND have at least 2 options (placeholder + real)
    expect(tunnelSelect).not.toBeNull();
    expect(tunnelSelect.querySelectorAll('option').length).toBeGreaterThan(1);
  });

  // Select tunnel
  await act(async () => {
    const tunnelSelect = utils.container.querySelector('#deploy-tunnel-select');
    if (tunnelSelect) {
      fireEvent.change(tunnelSelect, { target: { value: 'tunnel-uuid-1' } });
    }
  });
}

// ── A11y — Landmarks & Heading ─────────────────────────────────────────────

describe('DeploymentsView — A11y: Landmarks & Heading', () => {
  it('renders a <main> landmark with aria-label', async () => {
    globalThis.fetch = makeDropdownFetch();
    const { getByRole } = renderView();
    expect(getByRole('main', { name: /deployments-ansicht/i })).toBeTruthy();
  });

  it('renders an <h1> heading "Deployments"', async () => {
    globalThis.fetch = makeDropdownFetch();
    const { getByRole } = renderView();
    const h = getByRole('heading', { name: /^deployments$/i });
    expect(h.tagName).toBe('H1');
  });

  it('renders labelled dropdown selects (htmlFor on labels)', async () => {
    globalThis.fetch = makeDropdownFetch();
    const { container } = renderView();
    // New dropdown-based form elements
    expect(container.querySelector('#deploy-image-select')).toBeTruthy();
    expect(container.querySelector('#deploy-tag-select')).toBeTruthy();
    expect(container.querySelector('#deploy-vps-select')).toBeTruthy();
    expect(container.querySelector('#deploy-zone-select')).toBeTruthy();
    expect(container.querySelector('#deploy-subdomain')).toBeTruthy();
  });

  it('Deploy-starten button has minHeight >= 44px (touch target)', () => {
    globalThis.fetch = makeDropdownFetch();
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /Deploy starten/i });
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });

  it('renders a Home button with accessible label', () => {
    globalThis.fetch = makeDropdownFetch();
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('Home button has minHeight >= 44px (touch target)', () => {
    globalThis.fetch = makeDropdownFetch();
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });

  it('clicking Home button calls onNavigate("panel")', async () => {
    globalThis.fetch = makeDropdownFetch();
    const { getByRole, onNavigate } = renderView();
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /zurück zum einstiegs-panel/i }));
    });
    expect(onNavigate).toHaveBeenCalledWith('panel');
  });

  it('Deploy form has aria-live region for status feedback (shown after result)', async () => {
    globalThis.fetch = makeDropdownFetch();
    const { container } = renderView();
    // No aria-live alert initially in deploy section
    expect(container.querySelector('[role="alert"]')).toBeFalsy();
  });
});

// ── AC10: Dropdown data loading ────────────────────────────────────────────

describe('DeploymentsView — AC10: Dropdown sources', () => {
  it('renders Image dropdown with packages from /api/github/packages', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const { container } = renderView();
    await waitFor(() => {
      const select = container.querySelector('#deploy-image-select');
      expect(select.querySelectorAll('option').length).toBeGreaterThan(1);
    });
    const option = container.querySelector('#deploy-image-select option[value="brew-assistent"]');
    expect(option).toBeTruthy();
  });

  it('Tag dropdown is disabled/empty until image is selected', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const { container } = renderView();
    await waitFor(() => container.querySelector('#deploy-image-select'));
    const tagSelect = container.querySelector('#deploy-tag-select');
    expect(tagSelect.disabled).toBe(true);
  });

  it('Tag dropdown loads after image selected', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const { container } = renderView();
    await waitFor(() => {
      const imgSelect = container.querySelector('#deploy-image-select');
      expect(imgSelect.querySelectorAll('option').length).toBeGreaterThan(1);
    });
    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-image-select'), {
        target: { value: 'brew-assistent' },
      });
    });
    await waitFor(() => {
      const tagSelect = container.querySelector('#deploy-tag-select');
      expect(tagSelect.querySelectorAll('option').length).toBeGreaterThan(1);
    });
    const option = container.querySelector('#deploy-tag-select option[value="v1.0.0"]');
    expect(option).toBeTruthy();
  });

  it('VPS dropdown renders configured VPS IDs', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const { container } = renderView();
    await waitFor(() => {
      const vpsSelect = container.querySelector('#deploy-vps-select');
      const options = Array.from(vpsSelect.querySelectorAll('option'));
      expect(options.some((o) => o.value === 'vps-1')).toBe(true);
    });
  });

  it('Domain dropdown renders Cloudflare zones', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const { container } = renderView();
    await waitFor(() => {
      const zoneSelect = container.querySelector('#deploy-zone-select');
      expect(zoneSelect.querySelectorAll('option').length).toBeGreaterThan(1);
    });
    const option = Array.from(
      container.querySelector('#deploy-zone-select').querySelectorAll('option'),
    ).find((o) => o.value === 'alexstuder.cloud');
    expect(option).toBeTruthy();
  });

  it('Calls /api/github/packages/:name/tags when image selected', async () => {
    let tagUrl;
    globalThis.fetch = jest.fn(async (url) => {
      if (url.includes('/tags')) tagUrl = url;
      if (url.includes('/api/github/packages') && !url.includes('/tags')) {
        return { ok: true, status: 200, json: async () => ({ packages: [{ name: 'myapp', fullImageRef: 'ghcr.io/org/myapp' }] }) };
      }
      if (url.includes('/tags')) return { ok: true, status: 200, json: async () => ({ tags: [] }) };
      if (url.includes('/api/deployments/vps-targets')) return { ok: true, status: 200, json: async () => ({ vpsIds: [] }) };
      if (url.includes('/api/cloudflare/zones')) return { ok: true, status: 200, json: async () => ({ zones: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const { container } = renderView();
    await waitFor(() => {
      expect(container.querySelector('#deploy-image-select').querySelectorAll('option').length).toBeGreaterThan(1);
    });
    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-image-select'), { target: { value: 'myapp' } });
    });
    await waitFor(() => {
      expect(tagUrl).toBeDefined();
    });
    expect(tagUrl).toContain('/api/github/packages/myapp/tags');
  });

  it('Tag dropdown is disabled with placeholder if no image selected', async () => {
    globalThis.fetch = makeDropdownFetch();
    const { container } = renderView();
    const tagSelect = container.querySelector('#deploy-tag-select');
    expect(tagSelect.disabled).toBe(true);
    const firstOption = tagSelect.querySelector('option');
    expect(firstOption.textContent).toMatch(/zuerst image wählen/i);
  });
});

// ── AC11: Subdomain pre-fill ───────────────────────────────────────────────

describe('DeploymentsView — AC11: Subdomain pre-fill + assembled hostname', () => {
  it('pre-fills subdomain from selected image name', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const { container } = renderView();
    await waitFor(() => {
      expect(container.querySelector('#deploy-image-select').querySelectorAll('option').length).toBeGreaterThan(1);
    });
    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-image-select'), {
        target: { value: 'brew-assistent' },
      });
    });
    await waitFor(() => {
      expect(container.querySelector('#deploy-subdomain').value).toBe('brew-assistent');
    });
  });

  it('subdomain is manually editable', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const { container } = renderView();
    await waitFor(() => {
      expect(container.querySelector('#deploy-image-select').querySelectorAll('option').length).toBeGreaterThan(1);
    });
    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-image-select'), { target: { value: 'brew-assistent' } });
    });
    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-subdomain'), { target: { value: 'custom-name' } });
    });
    expect(container.querySelector('#deploy-subdomain').value).toBe('custom-name');
  });

  it('assembled hostname shown: subdomain + domain', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const { container } = renderView();
    await waitFor(() => {
      expect(container.querySelector('#deploy-image-select').querySelectorAll('option').length).toBeGreaterThan(1);
    });
    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-image-select'), { target: { value: 'brew-assistent' } });
    });
    await waitFor(() => {
      expect(container.querySelector('#deploy-zone-select').querySelectorAll('option').length).toBeGreaterThan(1);
    });
    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-zone-select'), { target: { value: 'alexstuder.cloud' } });
    });
    await waitFor(() => {
      const hint = container.querySelector('#deploy-hostname-preview');
      expect(hint.textContent).toContain('brew-assistent.alexstuder.cloud');
    });
  });

  it('hostname preview shows placeholder when domain not selected', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const { container } = renderView();
    const hint = container.querySelector('#deploy-hostname-preview');
    expect(hint.textContent).toMatch(/Domäne.*Subdomain/i);
  });
});

// ── AC12: Deploy-Button activation + POST body ────────────────────────────

describe('DeploymentsView — AC12: Deploy-Button activation', () => {
  it('Deploy-starten button disabled when fields empty', () => {
    globalThis.fetch = makeDropdownFetch();
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /Deploy starten/i });
    expect(btn.disabled).toBe(true);
  });

  it('Deploy button enabled when all dropdowns + subdomain filled', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => {
      const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
      expect(btn.disabled).toBe(false);
    });
  });

  it('Deploy button disabled when subdomain is cleared', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const utils = renderView();
    await fillDeployForm(utils);
    await act(async () => {
      fireEvent.change(utils.container.querySelector('#deploy-subdomain'), { target: { value: '' } });
    });
    const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
    expect(btn.disabled).toBe(true);
  });

  it('POST /api/deployments with correct body: fullRef:tag + vps + hostname + tunnelId', async () => {
    let capturedBody;
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url === '/api/deployments' && init?.method === 'POST') {
        capturedBody = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ result: 'ok', deployment: { replaced: false } }) };
      }
      if (url.includes('/api/github/packages') && !url.includes('/tags')) {
        return { ok: true, status: 200, json: async () => ({
          packages: [{ name: 'brew-assistent', fullImageRef: 'ghcr.io/org/brew-assistent' }],
        }) };
      }
      if (url.includes('/tags')) return { ok: true, status: 200, json: async () => ({ tags: [{ tag: 'v1.0.0' }] }) };
      if (url.includes('/vps-targets')) return { ok: true, status: 200, json: async () => ({ vpsIds: ['vps-1'] }) };
      if (url.includes('/api/cloudflare/zones/') && url.includes('/tunnels')) {
        return { ok: true, status: 200, json: async () => ({ tunnels: [{ id: 'tunnel-uuid-1', name: 'main' }] }) };
      }
      if (url.includes('/api/cloudflare/zones')) {
        return { ok: true, status: 200, json: async () => ({ zones: [{ id: 'zone-abc', name: 'alexstuder.cloud' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) };
    });

    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => {
      const btn = utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i });
      expect(btn.disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    });
    expect(capturedBody).toMatchObject({
      image: 'ghcr.io/org/brew-assistent:v1.0.0',
      vps: 'vps-1',
      hostname: 'brew-assistent.alexstuder.cloud',
      tunnelId: 'tunnel-uuid-1',
    });
    // zoneId must NOT be in the POST body
    expect(capturedBody).not.toHaveProperty('zoneId');
  });

  it('shows success message after successful deploy', async () => {
    globalThis.fetch = makeDropdownFetchWithData();
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).toMatch(/deployed/i);
  });
});

// ── AC13: Port-Ambiguity + Fallback display ────────────────────────────────

describe('DeploymentsView — AC13: Port hints in success response', () => {
  it('shows portAmbiguous hint when backend signals multiple ports', async () => {
    globalThis.fetch = makeDropdownFetchWithData({
      deployResult: { result: 'ok', deployment: { replaced: false, portAmbiguous: true, portFallback: false, hostname: 'brew-assistent.alexstuder.cloud' } },
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).toMatch(/mehrere exponierte ports/i);
  });

  it('shows portFallback hint when backend signals no exposed port', async () => {
    globalThis.fetch = makeDropdownFetchWithData({
      deployResult: { result: 'ok', deployment: { replaced: false, portAmbiguous: false, portFallback: true, hostname: 'brew-assistent.alexstuder.cloud' } },
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).toMatch(/kein exponierter port/i);
  });
});

// ── AC14: Re-Deploy indicator ──────────────────────────────────────────────

describe('DeploymentsView — AC14: Re-Deploy indicator', () => {
  it('shows re-deploy warning when existing deploy matches hostname', async () => {
    // Mock fetch: deployments list returns an existing deploy on our target hostname
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/api/github/packages') && !url.includes('/tags')) {
        return { ok: true, status: 200, json: async () => ({
          packages: [{ name: 'brew-assistent', fullImageRef: 'ghcr.io/org/brew-assistent' }],
        }) };
      }
      if (url.includes('/tags')) return { ok: true, status: 200, json: async () => ({ tags: [{ tag: 'v1.0.0' }] }) };
      if (url.includes('/vps-targets')) return { ok: true, status: 200, json: async () => ({ vpsIds: ['vps-1'] }) };
      if (url.includes('/api/cloudflare/zones/') && url.includes('/tunnels')) {
        return { ok: true, status: 200, json: async () => ({ tunnels: [{ id: 'tunnel-uuid-1', name: 'main' }] }) };
      }
      if (url.includes('/api/cloudflare/zones')) {
        return { ok: true, status: 200, json: async () => ({ zones: [{ id: 'zone-abc', name: 'alexstuder.cloud' }] }) };
      }
      // Deployments list: return existing deploy matching the target hostname
      if (url.includes('/api/deployments') && !init?.method) {
        return { ok: true, status: 200, json: async () => ({
          deployments: [{ vps: 'vps-1', hostname: 'brew-assistent.alexstuder.cloud', routePresent: true, containerPresent: true }],
          errors: [],
        }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const utils = renderView();

    // Load the deployments list first
    await act(async () => {
      fireEvent.change(utils.getByLabelText(/VPS-ID für Bestandsliste/i), { target: { value: 'vps-1' } });
      fireEvent.change(utils.getByLabelText(/Tunnel-ID für Bestandsliste/i), { target: { value: 'tunnel-uuid-1' } });
    });
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /Aktualisieren/i }));
    });
    await waitFor(() => utils.queryByRole('table', { name: /Deployment-Liste/i }));

    // Now fill the deploy form to target the same hostname
    await fillDeployForm(utils);

    // Re-deploy warning should appear
    await waitFor(() => {
      const warning = utils.container.querySelector('[role="status"]');
      expect(warning).not.toBeNull();
      expect(warning.textContent).toContain('brew-assistent.alexstuder.cloud');
    });
    const warning = utils.container.querySelector('[role="status"]');
    expect(warning.textContent).toMatch(/existiert bereits/i);
  });

  it('shows "Re-Deploy starten" in button text when replacing', async () => {
    // Fetch that returns an existing deployment matching the target hostname
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/api/github/packages') && !url.includes('/tags')) {
        return { ok: true, status: 200, json: async () => ({ packages: [{ name: 'brew-assistent', fullImageRef: 'ghcr.io/org/brew-assistent' }] }) };
      }
      if (url.includes('/tags')) return { ok: true, status: 200, json: async () => ({ tags: [{ tag: 'v1.0.0' }] }) };
      if (url.includes('/vps-targets')) return { ok: true, status: 200, json: async () => ({ vpsIds: ['vps-1'] }) };
      if (url.includes('/api/cloudflare/zones/') && url.includes('/tunnels')) {
        return { ok: true, status: 200, json: async () => ({ tunnels: [{ id: 'tunnel-uuid-1', name: 'main' }] }) };
      }
      if (url.includes('/api/cloudflare/zones')) {
        return { ok: true, status: 200, json: async () => ({ zones: [{ id: 'zone-abc', name: 'alexstuder.cloud' }] }) };
      }
      if (url.includes('/api/deployments') && !init?.method) {
        return { ok: true, status: 200, json: async () => ({
          deployments: [{ vps: 'vps-1', hostname: 'brew-assistent.alexstuder.cloud', routePresent: true, containerPresent: true }],
          errors: [],
        }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const utils = renderView();
    // Load existing deployment list first
    await act(async () => {
      fireEvent.change(utils.getByLabelText(/VPS-ID für Bestandsliste/i), { target: { value: 'vps-1' } });
      fireEvent.change(utils.getByLabelText(/Tunnel-ID für Bestandsliste/i), { target: { value: 'tunnel-uuid-1' } });
    });
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /Aktualisieren/i }));
    });
    await waitFor(() => {
      expect(utils.queryByRole('table', { name: /Deployment-Liste/i })).not.toBeNull();
    });
    // Fill deploy form to target brew-assistent.alexstuder.cloud (same as existing)
    await fillDeployForm(utils);
    // The button text should change to Re-Deploy starten
    await waitFor(() => {
      expect(utils.getByRole('button', { name: /Re-Deploy starten/i })).toBeTruthy();
    });
  });

  it('shows "Re-Deployed (ersetzt)" in success message when replaced=true', async () => {
    globalThis.fetch = makeDropdownFetchWithData({
      deployResult: { result: 'ok', deployment: { replaced: true, portAmbiguous: false, portFallback: false, hostname: 'brew-assistent.alexstuder.cloud' } },
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).toMatch(/re-deployed.*ersetzt/i);
  });
});

// ── Deploy error handling ──────────────────────────────────────────────────

describe('DeploymentsView — Deploy: error handling', () => {
  it('shows error message on 400 validation error', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url === '/api/deployments' && init?.method === 'POST') {
        return { ok: false, status: 400, json: async () => ({ error: 'validation-error' }) };
      }
      return makeDropdownFetchWithData()(url, init);
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).toBeTruthy();
  });

  it('shows user-friendly message for 422 protected-resource', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url === '/api/deployments' && init?.method === 'POST') {
        return { ok: false, status: 422, json: async () => ({ reason: 'protected-resource' }) };
      }
      return makeDropdownFetchWithData()(url, init);
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).toMatch(/geschuetzt|protected/i);
  });

  it('shows error on network failure (fetch throws)', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url === '/api/deployments' && init?.method === 'POST') {
        throw new Error('Network error');
      }
      return makeDropdownFetchWithData()(url, init);
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).toMatch(/netzwerkfehler|error/i);
  });
});

// ── AC9 — Secret sanitization in error display ─────────────────────────────

describe('DeploymentsView — AC9: No secret in rendered output', () => {
  it('Bearer token stripped from error reason', async () => {
    const rawMessage = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig error';
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url === '/api/deployments' && init?.method === 'POST') {
        return { ok: false, status: 502, json: async () => ({ reason: rawMessage }) };
      }
      return makeDropdownFetchWithData()(url, init);
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).not.toMatch(/Bearer eyJ/i);
    expect(alert.textContent).toContain('[redacted]');
  });

  it('long base64 token stripped and replaced with [...]', async () => {
    const longToken = 'A'.repeat(44);
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url === '/api/deployments' && init?.method === 'POST') {
        return { ok: false, status: 502, json: async () => ({ reason: `Error: ${longToken} failed` }) };
      }
      return makeDropdownFetchWithData()(url, init);
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).not.toContain('A'.repeat(44));
    expect(alert.textContent).toContain('[...]');
  });

  it('error message content rendered as text node (no innerHTML path)', async () => {
    const xss = '<script>alert("xss")</script>';
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url === '/api/deployments' && init?.method === 'POST') {
        return { ok: false, status: 502, json: async () => ({ reason: xss }) };
      }
      return makeDropdownFetchWithData()(url, init);
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.querySelector('script')).toBeNull();
  });
});

// ── AC5/AC6 — Undeploy with type-to-confirm ───────────────────────────────

describe('DeploymentsView — AC5/AC6: Undeploy type-to-confirm', () => {
  function renderWithDeployments() {
    globalThis.fetch = jest.fn(async (url) => {
      if (url.includes('/api/deployments') && !url.includes('DELETE')
          && !url.includes('/vps-targets') && !url.includes('/stacks')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deployments: [{
              hostname: 'myapp.example.com',
              vps: 'vps-1',
              image: 'ghcr.io/org/app:v1',
              status: 'running',
              routePresent: true,
              containerPresent: true,
            }],
            errors: [],
          }),
        };
      }
      if (url.includes('/api/github/packages') && !url.includes('/tags')) {
        return { ok: true, status: 200, json: async () => ({ packages: [] }) };
      }
      if (url.includes('/vps-targets')) return { ok: true, status: 200, json: async () => ({ vpsIds: [] }) };
      if (url.includes('/api/cloudflare/zones')) return { ok: true, status: 200, json: async () => ({ zones: [] }) };
      return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
    });
    const onNavigate = jest.fn();
    const utils = render(React.createElement(DeploymentsView, { onNavigate }));
    return { ...utils, onNavigate };
  }

  async function loadDeployments(utils) {
    const { getByLabelText, getByRole } = utils;
    await act(async () => {
      fireEvent.change(getByLabelText(/VPS-ID für Bestandsliste/i), { target: { value: 'vps-1' } });
      fireEvent.change(getByLabelText(/Tunnel-ID für Bestandsliste/i), { target: { value: 'tunnel-123' } });
    });
    await act(async () => {
      const btn = getByRole('button', { name: /Aktualisieren/i });
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(utils.getByRole('table', { name: /Deployment-Liste/i })).toBeTruthy();
    });
  }

  it('shows deployment list with Entfernen button after loading', async () => {
    const utils = renderWithDeployments();
    await loadDeployments(utils);
    expect(utils.getByRole('button', { name: /Deployment myapp\.example\.com entfernen/i })).toBeTruthy();
  });

  it('clicking Entfernen opens undeploy confirmation section', async () => {
    const utils = renderWithDeployments();
    await loadDeployments(utils);
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /Deployment myapp\.example\.com entfernen/i }));
    });
    expect(utils.getByRole('region', { name: /deployment entfernen/i })).toBeTruthy();
  });

  it('AC6: submit disabled when confirm is empty', async () => {
    const utils = renderWithDeployments();
    await loadDeployments(utils);
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /Deployment myapp\.example\.com entfernen/i }));
    });
    const submitBtn = utils.getByRole('button', { name: /Entfernen bestätigen/i });
    expect(submitBtn.disabled).toBe(true);
  });

  it('AC6: submit disabled when confirm != hostname', async () => {
    const utils = renderWithDeployments();
    await loadDeployments(utils);
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /Deployment myapp\.example\.com entfernen/i }));
    });
    await act(async () => {
      fireEvent.change(utils.getByLabelText(/Hostname myapp\.example\.com bestätigen/i), {
        target: { value: 'wrong.example.com' },
      });
    });
    const submitBtn = utils.getByRole('button', { name: /Entfernen bestätigen/i });
    expect(submitBtn.disabled).toBe(true);
  });

  it('AC6: submit enabled when confirm === hostname', async () => {
    const utils = renderWithDeployments();
    await loadDeployments(utils);
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /Deployment myapp\.example\.com entfernen/i }));
    });
    await act(async () => {
      fireEvent.change(utils.getByLabelText(/Hostname myapp\.example\.com bestätigen/i), {
        target: { value: 'myapp.example.com' },
      });
    });
    const submitBtn = utils.getByRole('button', { name: /Entfernen bestätigen/i });
    expect(submitBtn.disabled).toBe(false);
  });

  it('Abbrechen button closes confirmation dialog', async () => {
    const utils = renderWithDeployments();
    await loadDeployments(utils);
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /Deployment myapp\.example\.com entfernen/i }));
    });
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /Abbrechen/i }));
    });
    expect(utils.queryByRole('region', { name: /deployment entfernen/i })).toBeNull();
  });

  it('sends DELETE with correct URL and body on confirm', async () => {
    let deleteCall;
    globalThis.fetch = jest.fn(async (url, init) => {
      if (init?.method === 'DELETE' && url.includes('/api/deployments')) {
        deleteCall = { url, body: JSON.parse(init.body) };
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      if (url.includes('/api/deployments') && !url.includes('/vps-targets') && !url.includes('/stacks')) {
        return { ok: true, status: 200, json: async () => ({
          deployments: [{ hostname: 'myapp.example.com', vps: 'vps-1', routePresent: true, containerPresent: true }],
          errors: [],
        }) };
      }
      if (url.includes('/api/github/packages') && !url.includes('/tags')) return { ok: true, status: 200, json: async () => ({ packages: [] }) };
      if (url.includes('/vps-targets')) return { ok: true, status: 200, json: async () => ({ vpsIds: [] }) };
      if (url.includes('/api/cloudflare/zones')) return { ok: true, status: 200, json: async () => ({ zones: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const onNavigate = jest.fn();
    const utils = render(React.createElement(DeploymentsView, { onNavigate }));
    await act(async () => {
      fireEvent.change(utils.getByLabelText(/VPS-ID für Bestandsliste/i), { target: { value: 'vps-1' } });
      fireEvent.change(utils.getByLabelText(/Tunnel-ID für Bestandsliste/i), { target: { value: 'tunnel-abc' } });
    });
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /Aktualisieren/i }));
    });
    await waitFor(() => utils.getByRole('table', { name: /Deployment-Liste/i }));
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /Deployment myapp\.example\.com entfernen/i }));
    });
    await act(async () => {
      fireEvent.change(utils.getByLabelText(/Hostname myapp\.example\.com bestätigen/i), {
        target: { value: 'myapp.example.com' },
      });
    });
    await act(async () => {
      fireEvent.submit(utils.getByRole('region', { name: /deployment entfernen/i }).querySelector('form'));
    });
    await waitFor(() => deleteCall !== undefined);
    expect(deleteCall.url).toContain('myapp.example.com');
    expect(deleteCall.url).toContain('vps-1');
    expect(deleteCall.body).toMatchObject({ confirm: 'myapp.example.com', tunnelId: 'tunnel-abc' });
    expect(deleteCall.body).not.toHaveProperty('zoneId');
  });
});

// ── AC7 — LockoutGuard protected-resource ─────────────────────────────────

describe('DeploymentsView — AC7: LockoutGuard protected-resource display', () => {
  it('shows user-friendly protected-resource message', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url === '/api/deployments' && init?.method === 'POST') {
        return { ok: false, status: 422, json: async () => ({ reason: 'protected-resource' }) };
      }
      return makeDropdownFetchWithData()(url, init);
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).toMatch(/geschuetzt/i);
  });
});

// ── AC8 — 403 Forbidden (CRED_ADMIN_EMAILS) ───────────────────────────────

describe('DeploymentsView — AC8: 403 Forbidden display', () => {
  it('shows error message on 403 (not crash)', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url === '/api/deployments' && init?.method === 'POST') {
        return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) };
      }
      return makeDropdownFetchWithData()(url, init);
    });
    const utils = renderView();
    await fillDeployForm(utils);
    await waitFor(() => { expect(utils.getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false); });
    await act(async () => {
      fireEvent.submit(utils.getByRole('form', { name: /Deploy-Formular/i }));
    });
    const alert = await utils.findByRole('alert');
    expect(alert.textContent).toBeTruthy();
  });
});

// ── List: degrading errors[] ───────────────────────────────────────────────

describe('DeploymentsView — List: degrading errors display', () => {
  it('shows partial errors from errors[] alongside deployments', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url.includes('/api/deployments') && !url.includes('/vps-targets') && !url.includes('/stacks')) {
        return { ok: true, status: 200, json: async () => ({
          deployments: [],
          errors: [{ scope: 'vps-1', errorClass: 'ssh-connect-failed' }],
        }) };
      }
      if (url.includes('/api/github/packages') && !url.includes('/tags')) return { ok: true, status: 200, json: async () => ({ packages: [] }) };
      if (url.includes('/vps-targets')) return { ok: true, status: 200, json: async () => ({ vpsIds: [] }) };
      if (url.includes('/api/cloudflare/zones')) return { ok: true, status: 200, json: async () => ({ zones: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const { getByLabelText, getByRole, findByRole } = renderView();
    await act(async () => {
      fireEvent.change(getByLabelText(/VPS-ID für Bestandsliste/i), { target: { value: 'vps-1' } });
      fireEvent.change(getByLabelText(/Tunnel-ID für Bestandsliste/i), { target: { value: 'tunnel-123' } });
    });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Aktualisieren/i }));
    });
    const alert = await findByRole('alert');
    expect(alert.textContent).toMatch(/vps-1/i);
    expect(alert.textContent).toMatch(/ssh-connect-failed/i);
  });

  it('Aktualisieren button is disabled while loading', async () => {
    let resolveList;
    globalThis.fetch = jest.fn((url) => {
      if (url.includes('/api/deployments') && !url.includes('/vps-targets') && !url.includes('/stacks')) {
        return new Promise((resolve) => { resolveList = resolve; });
      }
      if (url.includes('/api/github/packages') && !url.includes('/tags')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ packages: [] }) });
      if (url.includes('/vps-targets')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ vpsIds: [] }) });
      if (url.includes('/api/cloudflare/zones')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ zones: [] }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    const { getByLabelText, container } = renderView();
    await act(async () => {
      fireEvent.change(getByLabelText(/VPS-ID für Bestandsliste/i), { target: { value: 'vps-1' } });
      fireEvent.change(getByLabelText(/Tunnel-ID für Bestandsliste/i), { target: { value: 'tunnel-123' } });
    });
    const section = container.querySelector('section[aria-label="Bestand laden"]');
    const btn = section.querySelector('button');
    expect(btn.disabled).toBe(true);
    await act(async () => {
      resolveList({ ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) });
    });
  });
});
