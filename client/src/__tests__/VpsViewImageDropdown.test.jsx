/**
 * VpsViewImageDropdown.test.jsx — Tests für S-163: Image-Dropdown im VPS-Create-Formular.
 *
 * Covers (vps-create-options AC11–AC12):
 *   AC11 — Bei Provider hetzner + optionsAvailable:true → Image-Feld als Dropdown aus
 *           System-Images; Default-Vorauswahl ubuntu-26.04 (falls vorhanden), sonst
 *           ubuntu-24.04 (LTS-Fallback). Auswahl setzt image = Image-name (Slug).
 *   AC12 — Fehler beim Laden / optionsAvailable:false → Image-Feld bleibt Freitext-Input
 *           mit Placeholder-Hinweis Ubuntu 26.04; Create bleibt absendbar.
 *
 * A11y (jsdom-testbar):
 *   — Image-Dropdown hat label htmlFor="vps-create-image".
 *   — Fallback-Hinweis mit aria-live (kein role=alert).
 *   — minHeight ≥ 44px (WCAG Touch-Target — createStyles.select).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }  = await import('@testing-library/react');
const React       = (await import('react')).default;
const { VpsView } = await import('../VpsView.jsx');

// ── Test-Fixtures ─────────────────────────────────────────────────────────────

const ROOT_PUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRootKeyTestFrontend root@test';
const ALEX_PUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAlexKeyTestFrontend alex@test';

const SSH_LABELS_BOTH = [
  { user: 'root', publicKey: ROOT_PUB_KEY, privateKeyStatus: 'set' },
  { user: 'alex', publicKey: ALEX_PUB_KEY, privateKeyStatus: 'set' },
];

const PROVIDERS_HETZNER = [
  { id: 'hetzner', configured: true, capabilities: { list: true, start: true, stop: true, create: true } },
];

const MACHINES_EMPTY = { machines: [] };

/** Options mit Ubuntu 26.04 in der Image-Liste (ubuntu-26.04 vorhanden). */
const OPTIONS_WITH_UBUNTU_2604 = {
  optionsAvailable: true,
  serverTypes: [
    {
      name: 'cx23',
      cores: 2,
      memory: 4,
      disk: 40,
      deprecated: false,
      prices: [
        { location: 'nbg1', priceMonthly: { net: '3.79', gross: '4.51' }, priceHourly: { net: '0.0053', gross: '0.0063' } },
      ],
    },
  ],
  locations: [
    { name: 'nbg1', networkZone: 'eu-central', city: 'Nuremberg', country: 'DE' },
  ],
  images: [
    { name: 'ubuntu-22.04', description: 'Ubuntu 22.04', osFlavor: 'ubuntu', osVersion: '22.04' },
    { name: 'ubuntu-24.04', description: 'Ubuntu 24.04', osFlavor: 'ubuntu', osVersion: '24.04' },
    { name: 'ubuntu-26.04', description: 'Ubuntu 26.04', osFlavor: 'ubuntu', osVersion: '26.04' },
    { name: 'debian-12',    description: 'Debian 12',    osFlavor: 'debian', osVersion: '12'    },
  ],
};

/** Options OHNE Ubuntu 26.04 — LTS-Fallback ubuntu-24.04 muss vorausgewählt werden. */
const OPTIONS_WITHOUT_UBUNTU_2604 = {
  optionsAvailable: true,
  serverTypes: [
    {
      name: 'cx23',
      cores: 2,
      memory: 4,
      disk: 40,
      deprecated: false,
      prices: [
        { location: 'nbg1', priceMonthly: { net: '3.79', gross: '4.51' }, priceHourly: { net: '0.0053', gross: '0.0063' } },
      ],
    },
  ],
  locations: [
    { name: 'nbg1', networkZone: 'eu-central', city: 'Nuremberg', country: 'DE' },
  ],
  images: [
    { name: 'ubuntu-22.04', description: 'Ubuntu 22.04', osFlavor: 'ubuntu', osVersion: '22.04' },
    { name: 'ubuntu-24.04', description: 'Ubuntu 24.04', osFlavor: 'ubuntu', osVersion: '24.04' },
    { name: 'debian-12',    description: 'Debian 12',    osFlavor: 'debian', osVersion: '12'    },
  ],
};

/** Options mit leerem images-Array (Dropdown soll nicht erscheinen). */
const OPTIONS_EMPTY_IMAGES = {
  optionsAvailable: true,
  serverTypes: [
    {
      name: 'cx23',
      cores: 2,
      memory: 4,
      disk: 40,
      deprecated: false,
      prices: [
        { location: 'nbg1', priceMonthly: { net: '3.79', gross: '4.51' }, priceHourly: { net: '0.0053', gross: '0.0063' } },
      ],
    },
  ],
  locations: [
    { name: 'nbg1', networkZone: 'eu-central', city: 'Nuremberg', country: 'DE' },
  ],
  images: [],
};

// ── Mock-fetch-Fabrik ─────────────────────────────────────────────────────────

function makeFetch({
  sshLabels    = SSH_LABELS_BOTH,
  providers    = PROVIDERS_HETZNER,
  machines     = MACHINES_EMPTY,
  options      = OPTIONS_WITH_UBUNTU_2604,
  createResult = null,
} = {}) {
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
    if (url.startsWith('/api/vps/providers/') && url.endsWith('/options')) {
      if (options === null) {
        return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
      }
      return { ok: true, json: async () => options };
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

// ── Render-Helfer ─────────────────────────────────────────────────────────────

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

/** Öffnet das Create-Formular und wartet bis Options geladen (Region-Select vorhanden). */
async function openCreateForm(utils) {
  await act(async () => {
    fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
  });
  // Warte bis Dropdowns gerendert (optionsState='ok')
  await waitFor(() => {
    const regionSelect = document.getElementById('vps-create-region');
    return regionSelect && regionSelect.tagName === 'SELECT';
  });
}

/** Öffnet das Create-Formular und wartet bis Freitext-Fallback (Input statt Select für Region). */
async function openCreateFormFallback(utils) {
  await act(async () => {
    fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
  });
  await waitFor(() => {
    const el = document.getElementById('vps-create-region');
    return el && el.tagName === 'INPUT';
  });
}

// ── AC11: Image-Dropdown bei hetzner + optionsAvailable:true ─────────────────

describe('VpsView — S-163 AC11: Image-Dropdown bei hetzner + optionsAvailable:true', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC11 — Image-Feld ist ein SELECT wenn hetzner + optionsAvailable:true + images vorhanden', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Warte explizit auf Image-Select (kann nach Region-Select erscheinen)
    await waitFor(() => {
      const el = document.getElementById('vps-create-image');
      return el && el.tagName === 'SELECT';
    });

    const imageEl = document.getElementById('vps-create-image');
    expect(imageEl).not.toBeNull();
    expect(imageEl.tagName).toBe('SELECT');
  });

  it('AC11 — Image-Dropdown enthält alle System-Images aus dem Endpunkt', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    await waitFor(() => {
      const el = document.getElementById('vps-create-image');
      return el && el.tagName === 'SELECT';
    });

    const imageSelect = document.getElementById('vps-create-image');
    const values = Array.from(imageSelect.options).map((o) => o.value);
    // Alle Images aus OPTIONS_WITH_UBUNTU_2604 müssen erscheinen
    expect(values).toContain('ubuntu-22.04');
    expect(values).toContain('ubuntu-24.04');
    expect(values).toContain('ubuntu-26.04');
    expect(values).toContain('debian-12');
  });

  it('AC11 — Image-Dropdown zeigt description als Anzeige-Text', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    await waitFor(() => {
      const el = document.getElementById('vps-create-image');
      return el && el.tagName === 'SELECT';
    });

    const imageSelect = document.getElementById('vps-create-image');
    const ubuntu2604Option = Array.from(imageSelect.options).find((o) => o.value === 'ubuntu-26.04');
    expect(ubuntu2604Option).toBeTruthy();
    // description "Ubuntu 26.04" muss als Anzeige-Text erscheinen
    expect(ubuntu2604Option.textContent).toMatch(/Ubuntu 26\.04/);
  });

  it('AC11 — Default-Vorauswahl ist ubuntu-26.04 wenn in der Live-Liste vorhanden', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    await waitFor(() => {
      const el = document.getElementById('vps-create-image');
      return el && el.tagName === 'SELECT';
    });

    const imageSelect = document.getElementById('vps-create-image');
    // ubuntu-26.04 ist in OPTIONS_WITH_UBUNTU_2604 → muss vorausgewählt sein
    expect(imageSelect.value).toBe('ubuntu-26.04');
  });

  it('AC11 — Default-Vorauswahl fällt auf ubuntu-24.04 wenn ubuntu-26.04 NICHT in der Liste', async () => {
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_WITHOUT_UBUNTU_2604 }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    await waitFor(() => {
      const el = document.getElementById('vps-create-image');
      return el && el.tagName === 'SELECT';
    });

    const imageSelect = document.getElementById('vps-create-image');
    // ubuntu-26.04 fehlt → Fallback auf ubuntu-24.04
    expect(imageSelect.value).toBe('ubuntu-24.04');
  });

  it('AC11 — Auswahl eines anderen Images setzt image = Image-name (Slug) in der Create-Payload', async () => {
    let capturedBody = null;
    const baseFetch = makeFetch();
    const fetchMock = jest.fn(async (url, opts) => {
      if (url.startsWith('/api/vps/machines/hetzner') && opts?.method === 'POST') {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true, status: 201,
          json: async () => ({ result: 'ok', machine: { provider: 'hetzner', serverId: '1', name: 'x',
            status: 'provisioning', ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null } }),
        };
      }
      return baseFetch(url, opts);
    });

    const utils = await renderVpsView(fetchMock);
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    await waitFor(() => {
      const el = document.getElementById('vps-create-image');
      return el && el.tagName === 'SELECT';
    });

    // debian-12 auswählen
    const imageSelect = document.getElementById('vps-create-image');
    await act(async () => {
      fireEvent.change(imageSelect, { target: { value: 'debian-12' } });
    });

    // Name füllen und Submit
    await act(async () => {
      fireEvent.change(document.getElementById('vps-create-name'), { target: { value: 'test-srv' } });
    });

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /^erstellen$/i }));
    });

    await waitFor(() => expect(capturedBody).not.toBeNull());
    // image muss der Slug (name) sein
    expect(capturedBody.image).toBe('debian-12');
  });

  it('AC11 — Image-Feld ist Freitext-Input wenn images-Array leer (keine Bilder vom Endpunkt)', async () => {
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_EMPTY_IMAGES }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Warte kurz — bei leerem images-Array kein Image-Dropdown (Freitext stattdessen)
    await new Promise((r) => setTimeout(r, 80));

    const imageEl = document.getElementById('vps-create-image');
    expect(imageEl).not.toBeNull();
    // Kein Dropdown bei leerem images-Array
    expect(imageEl.tagName).toBe('INPUT');
  });
});

// ── AC11: A11y des Image-Dropdowns ───────────────────────────────────────────

describe('VpsView — S-163 AC11 A11y: Image-Dropdown Beschriftung', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('A11y — Image-Dropdown hat label htmlFor="vps-create-image"', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    await waitFor(() => {
      const el = document.getElementById('vps-create-image');
      return el && el.tagName === 'SELECT';
    });

    const label = document.querySelector('label[for="vps-create-image"]');
    expect(label).not.toBeNull();
    expect(label.textContent).toMatch(/image/i);
  });

  it('A11y — Image-Dropdown hat minHeight ≥ 44px (Touch-Target, WCAG 2.1 AA)', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    await waitFor(() => {
      const el = document.getElementById('vps-create-image');
      return el && el.tagName === 'SELECT';
    });

    const imageSelect = document.getElementById('vps-create-image');
    const minH = parseInt(imageSelect.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });
});

// ── AC12: Graceful Fallback auf Freitext ─────────────────────────────────────

describe('VpsView — S-163 AC12: Graceful Fallback bei Fehler/keine Quelle', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC12 — Fehler beim Options-Laden → Image-Feld bleibt Freitext-Input', async () => {
    const utils = await renderVpsView(makeFetch({ options: null }));
    restoreFetch = utils.restoreFetch;
    await openCreateFormFallback(utils);

    const imageEl = document.getElementById('vps-create-image');
    expect(imageEl).not.toBeNull();
    expect(imageEl.tagName).toBe('INPUT');
  });

  it('AC12 — optionsAvailable:false → Image-Feld bleibt Freitext-Input', async () => {
    const utils = await renderVpsView(makeFetch({ options: { optionsAvailable: false } }));
    restoreFetch = utils.restoreFetch;
    await openCreateFormFallback(utils);

    const imageEl = document.getElementById('vps-create-image');
    expect(imageEl).not.toBeNull();
    expect(imageEl.tagName).toBe('INPUT');
  });

  it('AC12 — Freitext-Image-Fallback: Placeholder-Hinweis Ubuntu 26.04 vorhanden', async () => {
    const utils = await renderVpsView(makeFetch({ options: null }));
    restoreFetch = utils.restoreFetch;
    await openCreateFormFallback(utils);

    const imageEl = document.getElementById('vps-create-image');
    expect(imageEl.placeholder).toMatch(/ubuntu.*26\.04|26\.04.*ubuntu/i);
  });

  it('AC12 — Create bleibt absendbar bei Freitext-Image-Fallback', async () => {
    let createCalled = false;
    const baseFetch = makeFetch({ options: null });
    const fetchMock = jest.fn(async (url, opts) => {
      if (url.startsWith('/api/vps/machines/hetzner') && opts?.method === 'POST') {
        createCalled = true;
        return {
          ok: true, status: 201,
          json: async () => ({ result: 'ok', machine: { provider: 'hetzner', serverId: '1', name: 'x',
            status: 'provisioning', ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null } }),
        };
      }
      return baseFetch(url, opts);
    });

    const utils = await renderVpsView(fetchMock);
    restoreFetch = utils.restoreFetch;
    await openCreateFormFallback(utils);

    // Pflichtfelder manuell füllen (Freitext-Fallback)
    await act(async () => {
      fireEvent.change(document.getElementById('vps-create-name'),       { target: { value: 'test-srv' } });
      fireEvent.change(document.getElementById('vps-create-region'),     { target: { value: 'nbg1' } });
      fireEvent.change(document.getElementById('vps-create-servertype'), { target: { value: 'cx23' } });
      // Image ist optional — leer lassen (Default-Verhalten)
    });

    const submitBtn = utils.getByRole('button', { name: /^erstellen$/i });
    expect(submitBtn.disabled).toBe(false);

    await act(async () => { fireEvent.click(submitBtn); });
    await waitFor(() => expect(createCalled).toBe(true));
  });

  it('AC12 — Nicht-Hetzner Provider → Image-Feld bleibt Freitext-Input', async () => {
    const ionosProviders = [
      { id: 'ionos', configured: true, capabilities: { list: true, start: true, stop: true, create: true } },
    ];
    const utils = await renderVpsView(makeFetch({ providers: ionosProviders }));
    restoreFetch = utils.restoreFetch;

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
    });
    await new Promise((r) => setTimeout(r, 50));

    const imageEl = document.getElementById('vps-create-image');
    expect(imageEl).not.toBeNull();
    expect(imageEl.tagName).toBe('INPUT');
  });

  it('AC12 — Freitext-Image-Fallback: Fallback-Hinweis sichtbar (kein role=alert)', async () => {
    const utils = await renderVpsView(makeFetch({ options: null }));
    restoreFetch = utils.restoreFetch;
    await openCreateFormFallback(utils);

    // Fallback-Hinweis muss sichtbar sein
    const bodyText = document.body.textContent;
    expect(bodyText).toMatch(/live-optionen.*nicht verfügbar|nicht verfügbar.*live-optionen|manuell eingeben/i);

    // Kein role=alert für Fallback-Zustand (kein harter Fehler)
    const alertEls = Array.from(document.querySelectorAll('[role="alert"]'));
    const fallbackAlert = alertEls.find((el) =>
      el.textContent.match(/live-optionen|nicht verfügbar/i),
    );
    expect(fallbackAlert).toBeUndefined();
  });
});
