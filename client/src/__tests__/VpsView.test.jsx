/**
 * VpsView.test.jsx — Tests für die VpsView-Komponente.
 *
 * Covers (vps-ssh-key-assignment AC1/AC2/AC5):
 *   AC1  — Create-Formular zeigt je Rolle (root, alex) ein Dropdown mit Labels mit Public-Key;
 *           Labels ohne Public-Key werden nicht angeboten.
 *   AC2  — Default-Vorbelegung: gleichnamiges Label → Rolle (Label "root" → root, "alex" → alex);
 *           übersteuerbar. Non-distinkte Auswahl zeigt Hinweis.
 *   AC5  — Create-Button gesperrt wenn kein Label mit Public-Key vorhanden oder Rolle leer.
 *   AC3  — sshKeyAssignment wird als Label-Referenzen gesendet, nie als Key-Material.
 *
 * view-vps Ursprungs-ACs (weiterhin gültig):
 *   - h1-Heading "VPS" vorhanden
 *   - Home-Button navigiert zurück zum Panel
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { VpsView }   = await import('../VpsView.jsx');

// ── Test-Fixtures ─────────────────────────────────────────────────────────────

const ROOT_PUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRootKeyTestFrontend root@test';
const ALEX_PUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAlexKeyTestFrontend alex@test';

const SSH_LABELS_BOTH = [
  { user: 'root', publicKey: ROOT_PUB_KEY, privateKeyStatus: 'set' },
  { user: 'alex', publicKey: ALEX_PUB_KEY, privateKeyStatus: 'set' },
];

const SSH_LABELS_NONE = [
  { user: 'orphan', privateKeyStatus: 'unset' }, // kein publicKey
];

const PROVIDERS_HETZNER = [
  { id: 'hetzner', configured: true, capabilities: { list: true, start: true, stop: true, create: true } },
  { id: 'ionos', configured: false, capabilities: { list: false, start: false, stop: false, create: false } },
];

const MACHINES_EMPTY = { machines: [] };

// ── Mock-fetch-Fabrik ─────────────────────────────────────────────────────────

/**
 * Baut einen fetch-Mock der je nach URL unterschiedliche Daten zurückgibt.
 */
function makeFetch({ sshLabels = SSH_LABELS_BOTH, providers = PROVIDERS_HETZNER, machines = MACHINES_EMPTY, createResult = null } = {}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/settings/ssh-keys') {
      return { ok: true, json: async () => sshLabels };
    }
    if (url === '/api/vps/providers') {
      return { ok: true, json: async () => providers };
    }
    if (url === '/api/vps/machines' && (!opts || opts.method !== 'POST')) {
      return { ok: true, json: async () => machines };
    }
    if (url.startsWith('/api/vps/machines/') && opts?.method === 'POST') {
      if (createResult?.error) {
        return { ok: false, status: 422, json: async () => createResult };
      }
      return {
        ok: true,
        status: 201,
        json: async () => createResult ?? {
          result: 'ok',
          machine: { provider: 'hetzner', serverId: '42', name: 'new-srv', status: 'provisioning',
            ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null },
        },
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  });
}

// ── Helfer ────────────────────────────────────────────────────────────────────

async function renderVpsView(fetchMock) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  const onNavigate = jest.fn();
  let utils;
  await act(async () => {
    utils = render(React.createElement(VpsView, { onNavigate }));
  });
  return { ...utils, onNavigate, restoreFetch: () => { globalThis.fetch = savedFetch; } };
}

// ── Heading / Navigation (view-vps — Basis-Tests weiter gültig) ───────────────

describe('VpsView — Heading und Navigation', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('rendert ein h1-Heading "VPS"', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    const heading = getByRole('heading', { name: /^vps$/i });
    expect(heading.tagName).toBe('H1');
  });

  it('Home-Button navigiert zurück zum Panel', async () => {
    const { getByRole, onNavigate, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    await act(async () => { fireEvent.click(btn); });
    expect(onNavigate).toHaveBeenCalledWith('panel');
  });

  it('Home-Button hat minHeight >= 44px (Touch-Target)', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });
});

// ── AC1: Create-Formular — Dropdowns je Rolle ─────────────────────────────────

describe('VpsView — AC1: Create-Formular mit SSH-Label-Dropdowns', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('öffnet das Create-Formular nach Klick auf "Neuer Server"', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    const btn = getByRole('button', { name: /neuen vps erstellen/i });
    await act(async () => { fireEvent.click(btn); });
    // form hat aria-label="Neuen VPS erstellen"
    expect(getByRole('form', { name: /neuen vps erstellen/i })).toBeTruthy();
  });

  it('AC1 — zeigt Dropdown für root-Rolle mit verfügbaren Labels', async () => {
    const { getByRole, getByLabelText, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    // root-Dropdown vorhanden
    const rootSelect = getByLabelText(/^root$/i);
    expect(rootSelect.tagName).toBe('SELECT');
    // "root"-Label als Option
    const options = Array.from(rootSelect.options).map((o) => o.value);
    expect(options).toContain('root');
    expect(options).toContain('alex');
  });

  it('AC1 — zeigt Dropdown für alex-Rolle mit verfügbaren Labels', async () => {
    const { getByRole, getByLabelText, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    const alexSelect = getByLabelText(/^alex$/i);
    expect(alexSelect.tagName).toBe('SELECT');
    const options = Array.from(alexSelect.options).map((o) => o.value);
    expect(options).toContain('root');
    expect(options).toContain('alex');
  });

  it('AC1 — Labels ohne Public-Key erscheinen NICHT in den Dropdowns', async () => {
    // label "orphan" hat kein publicKey
    const labelsWithOrphan = [
      ...SSH_LABELS_BOTH,
      { user: 'orphan', privateKeyStatus: 'unset' },
    ];
    const { getByRole, getByLabelText, restoreFetch: rf } = await renderVpsView(
      makeFetch({ sshLabels: labelsWithOrphan }),
    );
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    const rootSelect = getByLabelText(/^root$/i);
    const options = Array.from(rootSelect.options).map((o) => o.value);
    // "orphan" ohne publicKey darf nicht erscheinen
    expect(options).not.toContain('orphan');
  });
});

// ── AC2: Default-Vorbelegung und Übersteuerbarkeit ───────────────────────────

describe('VpsView — AC2: Default-Vorbelegung', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC2 — root-Dropdown ist mit Label "root" vorbelegt (gleichnamig)', async () => {
    const { getByRole, getByLabelText, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    const rootSelect = getByLabelText(/^root$/i);
    expect(rootSelect.value).toBe('root');
  });

  it('AC2 — alex-Dropdown ist mit Label "alex" vorbelegt (gleichnamig)', async () => {
    const { getByRole, getByLabelText, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    const alexSelect = getByLabelText(/^alex$/i);
    expect(alexSelect.value).toBe('alex');
  });

  it('AC2 — kein gleichnamiges Label → leere Vorbelegung (leere Auswahl)', async () => {
    // Nur ein Label "deploy" vorhanden — kein "root" oder "alex"
    const labelsNoDefault = [
      { user: 'deploy', publicKey: 'ssh-ed25519 AAAA deploy@test', privateKeyStatus: 'set' },
    ];
    const { getByRole, getByLabelText, restoreFetch: rf } = await renderVpsView(
      makeFetch({ sshLabels: labelsNoDefault }),
    );
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    const rootSelect = getByLabelText(/^root$/i);
    // kein "root"-Label → leere Vorbelegung
    expect(rootSelect.value).toBe('');
  });

  it('AC2 — Non-distinkte Wahl zeigt Hinweis', async () => {
    const { getByRole, getByLabelText, queryByRole, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    // Beide auf "root" setzen (non-distinkt)
    const rootSelect = getByLabelText(/^root$/i);
    const alexSelect = getByLabelText(/^alex$/i);
    await act(async () => {
      fireEvent.change(alexSelect, { target: { value: 'root' } });
    });
    // Hinweis "nicht distinkter Key" muss erscheinen
    const hint = queryByRole('status');
    expect(hint).not.toBeNull();
    expect(hint.textContent).toMatch(/distinkter/i);
    // root-Wert unverändert
    expect(rootSelect.value).toBe('root');
  });
});

// ── AC5: UI-Sperre wenn kein Label mit Key ────────────────────────────────────

describe('VpsView — AC5: Create-Sperre', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC5 — Blockier-Hinweis wenn kein Label mit Public-Key vorhanden', async () => {
    const { getByRole, queryByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({ sshLabels: SSH_LABELS_NONE }),
    );
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    // Warnung/Hinweis vorhanden
    const alert = queryByRole('alert');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toMatch(/ssh-key|public-key|key/i);
  });

  it('AC5 — Create-Button disabled wenn root-Label nicht gewählt', async () => {
    const labelsOnlyAlex = [
      { user: 'alex', publicKey: ALEX_PUB_KEY, privateKeyStatus: 'set' },
    ];
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({ sshLabels: labelsOnlyAlex }),
    );
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    // root hat kein gleichnamiges Label → Vorbelegung leer → Button disabled
    const submitBtn = getByRole('button', { name: /erstell/i });
    expect(submitBtn.disabled).toBe(true);
  });

  it('AC5 — Create-Button disabled wenn kein Provider konfiguriert', async () => {
    const providersNone = [
      { id: 'hetzner', configured: false, capabilities: { list: false, start: false, stop: false, create: false } },
    ];
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({ providers: providersNone }),
    );
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    const submitBtn = getByRole('button', { name: /erstell/i });
    expect(submitBtn.disabled).toBe(true);
  });
});

// ── AC3: sshKeyAssignment im Request — nur Label-Referenzen, kein Key-Material ─

describe('VpsView — AC3: Create-Request enthält nur Label-Referenzen', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC3 — POST-Body enthält sshKeyAssignment mit Labels, kein Key-Material', async () => {
    let capturedBody = null;
    const fetchMock = jest.fn(async (url, opts) => {
      if (url === '/api/settings/ssh-keys') {
        return { ok: true, json: async () => SSH_LABELS_BOTH };
      }
      if (url === '/api/vps/providers') {
        return { ok: true, json: async () => PROVIDERS_HETZNER };
      }
      if (url === '/api/vps/machines' && (!opts || opts.method !== 'POST')) {
        return { ok: true, json: async () => MACHINES_EMPTY };
      }
      if (url.startsWith('/api/vps/machines/') && opts?.method === 'POST') {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 201,
          json: async () => ({
            result: 'ok',
            machine: { provider: 'hetzner', serverId: '42', name: 'srv', status: 'provisioning',
              ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { getByRole, getByLabelText, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });

    // Pflichtfelder füllen
    const nameInput = getByLabelText(/^name/i);
    const regionInput = getByLabelText(/^region/i);
    const serverTypeInput = getByLabelText(/^server-typ/i);

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'srv' } });
      fireEvent.change(regionInput, { target: { value: 'nbg1' } });
      fireEvent.change(serverTypeInput, { target: { value: 'cx11' } });
    });

    // Submit
    const submitBtn = getByRole('button', { name: /^erstellen$/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Warten bis fetch aufgerufen
    await waitFor(() => expect(capturedBody).not.toBeNull());

    // sshKeyAssignment enthält nur Label-Strings — KEIN Key-Material
    expect(capturedBody.sshKeyAssignment).toBeDefined();
    expect(capturedBody.sshKeyAssignment.root).toBe('root');
    expect(capturedBody.sshKeyAssignment.alex).toBe('alex');
    // Kein Public-Key-Material in den Labels
    expect(capturedBody.sshKeyAssignment.root).not.toMatch(/^ssh-/);
    expect(capturedBody.sshKeyAssignment.alex).not.toMatch(/^ssh-/);
    // Kein roher Public-Key irgendwo im Body
    expect(JSON.stringify(capturedBody)).not.toContain(ROOT_PUB_KEY);
    expect(JSON.stringify(capturedBody)).not.toContain(ALEX_PUB_KEY);
  });
});
