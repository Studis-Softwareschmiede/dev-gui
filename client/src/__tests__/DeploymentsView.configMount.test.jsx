/**
 * DeploymentsView.configMount.test.jsx
 *
 * Covers (deploy-config-volume-mount.md): AC9
 *   AC9 — Checkbox „config.yaml auf dem VPS bereitstellen (read-only nach
 *         /app/config.yaml gemountet)". Aktiv → optionales mehrzeiliges Seed-Feld
 *         (Erst-Deploy-Inhalt) + read-only Vorschau des Host-Pfads
 *         `~/apps/<app>/config.yaml`. configApp-Default wird aus dem gewählten
 *         Image/Package abgeleitet (gleiche Ableitung wie gpgBwItem/Subdomain),
 *         bleibt editierbar. Beim Absenden gehen requiresConfig/configApp/configSeed
 *         im Deploy-Request mit; ist die Checkbox inaktiv, werden KEINE
 *         config-Params gesendet (unveränderter Request).
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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function renderView(props = {}) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(DeploymentsView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

/**
 * Fetch-Stub mit zwei wählbaren Images ("brew-assistent", "zweite-app"), einem
 * VPS ("vps-1", verlinkt mit "tunnel-uuid-1") und einer Zone. Deploy-POST wird
 * abgefangen und der Body in `onDeployCapture` gespiegelt.
 */
function makeFetch({ onDeployCapture } = {}) {
  return jest.fn(async (url, init) => {
    const u = String(url);
    if (u.includes('/api/deployments/readiness')) {
      return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
    }
    if (u.includes('/api/deployments/vps-tunnel-status')) {
      return { ok: true, status: 200, json: async () => [{ vpsId: 'vps-1', tunnelId: 'tunnel-uuid-1', tunnelPresent: true }] };
    }
    if (u === '/api/deployments' && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      if (onDeployCapture) onDeployCapture(body);
      return { ok: true, status: 200, json: async () => ({ result: 'ok', deployment: { replaced: false } }) };
    }
    if (u.includes('/api/github/packages') && !u.includes('/tags')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          packages: [
            { name: 'brew-assistent', fullImageRef: 'ghcr.io/org/brew-assistent' },
            { name: 'zweite-app', fullImageRef: 'ghcr.io/org/zweite-app' },
          ],
        }),
      };
    }
    if (u.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({ tags: [{ tag: 'v1.0.0' }] }) };
    }
    if (u.includes('/vps-targets')) {
      return { ok: true, status: 200, json: async () => ({ vpsIds: ['vps-1'], tunnelIds: { 'vps-1': 'tunnel-uuid-1' } }) };
    }
    if (u.includes('/api/cloudflare/zones')) {
      return { ok: true, status: 200, json: async () => ({ configured: true, zones: [{ id: 'zone-abc', name: 'alexstuder.cloud' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) };
  });
}

async function selectImage(container, name) {
  await waitFor(() => {
    expect(container.querySelector('#deploy-image-select').querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(container.querySelector('#deploy-image-select'), { target: { value: name } });
  });
}

async function fillFullForm(container) {
  await selectImage(container, 'brew-assistent');
  await waitFor(() => {
    expect(container.querySelector('#deploy-tag-select').querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(container.querySelector('#deploy-tag-select'), { target: { value: 'v1.0.0' } });
  });
  await waitFor(() => {
    expect(container.querySelector('#deploy-vps-select').querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(container.querySelector('#deploy-vps-select'), { target: { value: 'vps-1' } });
  });
  await waitFor(() => {
    expect(container.querySelector('#deploy-zone-select').querySelectorAll('option').length).toBeGreaterThan(1);
  });
  await act(async () => {
    fireEvent.change(container.querySelector('#deploy-zone-select'), { target: { value: 'alexstuder.cloud' } });
  });
  await waitFor(() => {
    expect(container.querySelector('[aria-label*="Tunnel-Status"]')).not.toBeNull();
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeploymentsView — config.yaml-Mount (deploy-config-volume-mount.md AC9)', () => {
  it('AC9: Checkbox ist standardmäßig unchecked; Seed-Feld/config-App-Feld nicht sichtbar', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await selectImage(container, 'brew-assistent');
    await waitFor(() => {
      expect(container.querySelector('#deploy-requires-config')).not.toBeNull();
    });
    expect(container.querySelector('#deploy-requires-config').checked).toBe(false);
    expect(container.querySelector('#deploy-config-app')).toBeNull();
    expect(container.querySelector('#deploy-config-seed')).toBeNull();
  });

  it('AC9: Checkbox aktivieren zeigt config-App-Feld (mit Default aus Image-Slug) + Seed-Feld + Host-Pfad-Vorschau', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await selectImage(container, 'brew-assistent');
    await act(async () => {
      fireEvent.click(container.querySelector('#deploy-requires-config'));
    });

    await waitFor(() => {
      expect(container.querySelector('#deploy-config-app').value).toBe('brew-assistent');
    });
    expect(container.querySelector('#deploy-config-seed')).not.toBeNull();
    expect(container.querySelector('#deploy-config-host-path-preview').textContent).toContain('~/apps/brew-assistent/config.yaml');
  });

  it('AC9: config-App-Feld ist manuell überschreibbar; Host-Pfad-Vorschau folgt der Eingabe', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await selectImage(container, 'brew-assistent');
    await act(async () => {
      fireEvent.click(container.querySelector('#deploy-requires-config'));
    });
    await waitFor(() => {
      expect(container.querySelector('#deploy-config-app').value).toBe('brew-assistent');
    });

    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-config-app'), { target: { value: 'custom-app-slug' } });
    });
    expect(container.querySelector('#deploy-config-app').value).toBe('custom-app-slug');
    expect(container.querySelector('#deploy-config-host-path-preview').textContent).toContain('~/apps/custom-app-slug/config.yaml');
  });

  it('AC9: ein manuell gesetzter configApp-Wert wird beim Slug-Wechsel NICHT überschrieben', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await selectImage(container, 'brew-assistent');
    await act(async () => {
      fireEvent.click(container.querySelector('#deploy-requires-config'));
    });
    await waitFor(() => {
      expect(container.querySelector('#deploy-config-app').value).toBe('brew-assistent');
    });

    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-config-app'), { target: { value: 'custom-app-slug' } });
    });

    await selectImage(container, 'zweite-app');
    expect(container.querySelector('#deploy-config-app').value).toBe('custom-app-slug');
  });

  it('AC9: Checkbox aktiv → requiresConfig/configApp/configSeed werden im Deploy-Request mitgesendet', async () => {
    let capturedBody;
    globalThis.fetch = makeFetch({ onDeployCapture: (body) => { capturedBody = body; } });
    const { container, getByRole } = renderView();

    await fillFullForm(container);
    await act(async () => {
      fireEvent.click(container.querySelector('#deploy-requires-config'));
    });
    await waitFor(() => {
      expect(container.querySelector('#deploy-config-app').value).toBe('brew-assistent');
    });
    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-config-seed'), { target: { value: 'key: value\n' } });
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.submit(getByRole('form', { name: /Deploy-Formular/i }));
    });

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody).toMatchObject({
      requiresConfig: true,
      configApp: 'brew-assistent',
      configSeed: 'key: value\n',
    });
  });

  it('AC9: Checkbox inaktiv → KEINE config-Params im Deploy-Request (unveränderter Request)', async () => {
    let capturedBody;
    globalThis.fetch = makeFetch({ onDeployCapture: (body) => { capturedBody = body; } });
    const { container, getByRole } = renderView();

    await fillFullForm(container);
    await waitFor(() => {
      expect(getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.submit(getByRole('form', { name: /Deploy-Formular/i }));
    });

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody).not.toHaveProperty('requiresConfig');
    expect(capturedBody).not.toHaveProperty('configApp');
    expect(capturedBody).not.toHaveProperty('configSeed');
  });
});
