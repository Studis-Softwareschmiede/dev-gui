/**
 * DeploymentsView.gpgBwItem.test.jsx
 *
 * Covers (deploy-bitwarden-gpg-injection.md): AC16
 *   AC16 — Das Deploy-Formular leitet den `gpgBwItem`-Default automatisch als
 *          `env.gpg-passphrase-<slug>` aus dem gewählten Ziel-Slug (Image-Auswahl)
 *          ab und sendet ihn im Deploy-Request mit. Der abgeleitete Wert ist im
 *          Formular überschreibbar; ein vom Nutzer manuell gesetzter Wert wird
 *          beim Slug-Wechsel NICHT überschrieben (nur ein noch unberührter/
 *          abgeleiteter Default folgt dem Slug).
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

describe('DeploymentsView — GPG-Bitwarden-Item-Default (deploy-bitwarden-gpg-injection.md AC16)', () => {
  it('AC16: leitet gpgBwItem-Default env.gpg-passphrase-<slug> aus gewähltem Image ab', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await selectImage(container, 'brew-assistent');

    await waitFor(() => {
      expect(container.querySelector('#deploy-gpg-bw-item').value).toBe('env.gpg-passphrase-brew-assistent');
    });
  });

  it('AC16: Feld ist manuell überschreibbar', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await selectImage(container, 'brew-assistent');
    await waitFor(() => {
      expect(container.querySelector('#deploy-gpg-bw-item').value).toBe('env.gpg-passphrase-brew-assistent');
    });

    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-gpg-bw-item'), { target: { value: 'custom-item-name' } });
    });
    expect(container.querySelector('#deploy-gpg-bw-item').value).toBe('custom-item-name');
  });

  it('AC16: ein manuell gesetzter Wert wird beim Slug-Wechsel NICHT überschrieben', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await selectImage(container, 'brew-assistent');
    await waitFor(() => {
      expect(container.querySelector('#deploy-gpg-bw-item').value).toBe('env.gpg-passphrase-brew-assistent');
    });

    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-gpg-bw-item'), { target: { value: 'custom-item-name' } });
    });

    // Slug-Wechsel auf ein anderes Image — der manuelle Wert bleibt erhalten.
    await selectImage(container, 'zweite-app');
    expect(container.querySelector('#deploy-gpg-bw-item').value).toBe('custom-item-name');
  });

  it('AC16: ein noch unberührter Default folgt weiterhin dem Slug-Wechsel', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await selectImage(container, 'brew-assistent');
    await waitFor(() => {
      expect(container.querySelector('#deploy-gpg-bw-item').value).toBe('env.gpg-passphrase-brew-assistent');
    });

    // Kein manueller Edit — Slug-Wechsel darf den Default aktualisieren.
    await selectImage(container, 'zweite-app');
    await waitFor(() => {
      expect(container.querySelector('#deploy-gpg-bw-item').value).toBe('env.gpg-passphrase-zweite-app');
    });
  });

  it('AC16: der abgeleitete Default wird im Deploy-Request mitgesendet', async () => {
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
    expect(capturedBody).toMatchObject({ gpgBwItem: 'env.gpg-passphrase-brew-assistent' });
  });

  it('AC16: ein manuell gesetzter Wert wird (statt des Defaults) im Deploy-Request gesendet', async () => {
    let capturedBody;
    globalThis.fetch = makeFetch({ onDeployCapture: (body) => { capturedBody = body; } });
    const { container, getByRole } = renderView();

    await fillFullForm(container);
    await act(async () => {
      fireEvent.change(container.querySelector('#deploy-gpg-bw-item'), { target: { value: 'custom-item-name' } });
    });
    await waitFor(() => {
      expect(getByRole('button', { name: /Deploy starten|Re-Deploy starten/i }).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.submit(getByRole('form', { name: /Deploy-Formular/i }));
    });

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody).toMatchObject({ gpgBwItem: 'custom-item-name' });
  });
});
