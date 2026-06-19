/**
 * VpsViewCreateOptions.test.jsx — Tests für S-162 + S-178: Server-Typ- und Region-Dropdowns
 * mit Kosten-Anzeige und availability-basierter Filterung im VPS-Create-Formular.
 *
 * Covers (vps-create-options AC6–AC10):
 *   AC6  — Bei Provider hetzner + optionsAvailable:true → Region und Server-Typ als Dropdowns;
 *           bei Nicht-Hetzner oder optionsAvailable:false → Freitext-Felder (Fallback).
 *   AC7  — Server-Typ-Dropdown zeigt Spezifikationen (cores/memory/disk) und Kosten
 *           (monatlich + stündlich, brutto bevorzugt); Preis richtet sich nach gewählter Region.
 *   AC8  — Fehlende Preise → „Preis unbekannt" statt Fehler; deprecated Typen nicht als
 *           wählbare Option angeboten.
 *   AC9  — Graceful Degradation: Fehler beim Options-Laden / optionsAvailable:false →
 *           Freitext-Felder bleiben, Create bleibt absendbar; Fallback-Hinweis sichtbar.
 *   AC10 — Kein Hetzner-Token im Frontend-Bundle/Log; Create-Payload enthält nur
 *           region (Location-name) und serverType (Typ-name), kein Token.
 *
 * Covers (vps-create-options AC18–AC20, S-178):
 *   AC18 — Bei gewählter Region + vorhandenem availability[region]: Server-Typ-Dropdown zeigt
 *           nur bereitstellbare Typen (Region steuert die Typen-Liste, kein beidseitiges Filtern).
 *   AC19 — Bei Region-Wechsel: serverType zurücksetzen wenn Typ in neuer Region nicht verfügbar;
 *           Wahl bleibt erhalten wenn der Typ verfügbar bleibt.
 *   AC20 — Graceful Fallback: fehlt availability ganz oder fehlt Eintrag für die Region →
 *           ungefiltert rendern (heutiges Story-B-Verhalten); Floor unverändert.
 *
 * A11y (jsdom-testbar):
 *   — Dropdowns haben beschriftete selects (label htmlFor, aria-required).
 *   — Fallback-Hinweis mit role=status (nicht role=alert — kein harter Fehler).
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

/** Minimale Options-Response mit zwei Locations und zwei Server-Typen. */
const OPTIONS_HETZNER = {
  optionsAvailable: true,
  serverTypes: [
    {
      name: 'cx23',
      cores: 2,
      memory: 4,
      disk: 40,
      deprecated: false,
      prices: [
        {
          location: 'nbg1',
          priceMonthly: { net: '3.79', gross: '4.51' },
          priceHourly:  { net: '0.0053', gross: '0.0063' },
        },
        {
          location: 'fsn1',
          priceMonthly: { net: '3.79', gross: '4.51' },
          priceHourly:  { net: '0.0053', gross: '0.0063' },
        },
        {
          location: 'ash',
          priceMonthly: { net: '3.79', gross: '3.79' }, // USA — brutto == netto (keine MwSt)
          priceHourly:  { net: '0.0053', gross: '0.0053' },
        },
      ],
    },
    {
      name: 'cx33',
      cores: 4,
      memory: 8,
      disk: 80,
      deprecated: false,
      prices: [
        {
          location: 'nbg1',
          priceMonthly: { net: '6.72', gross: '7.99' },
          priceHourly:  { net: '0.0093', gross: '0.0111' },
        },
      ],
    },
    {
      // deprecated — darf nicht wählbar sein (AC8)
      name: 'cx11-old',
      cores: 1,
      memory: 2,
      disk: 20,
      deprecated: true,
      prices: [],
    },
  ],
  locations: [
    { name: 'nbg1', networkZone: 'eu-central', city: 'Nuremberg', country: 'DE' },
    { name: 'fsn1', networkZone: 'eu-central', city: 'Falkenstein', country: 'DE' },
    { name: 'ash',  networkZone: 'us-east',    city: 'Ashburn',     country: 'US' },
  ],
  images: [
    { name: 'ubuntu-22.04', description: 'Ubuntu 22.04', osFlavor: 'ubuntu', osVersion: '22.04' },
  ],
};

/** Server-Typ ohne jegliche Preis-Infos (AC8: "Preis unbekannt"). */
const OPTIONS_NO_PRICE = {
  optionsAvailable: true,
  serverTypes: [
    { name: 'cx23', cores: 2, memory: 4, disk: 40, deprecated: false, prices: [] },
  ],
  locations: [
    { name: 'nbg1', networkZone: 'eu-central', city: 'Nuremberg', country: 'DE' },
  ],
  images: [],
};

// ── Mock-fetch-Fabrik ─────────────────────────────────────────────────────────

/**
 * Baut einen fetch-Mock der je nach URL unterschiedliche Daten zurückgibt.
 * options: was GET /api/vps/providers/hetzner/options liefert (null → 404-Fallback).
 */
function makeFetch({
  sshLabels     = SSH_LABELS_BOTH,
  providers     = PROVIDERS_HETZNER,
  machines      = MACHINES_EMPTY,
  options       = OPTIONS_HETZNER,   // null → simuliert Fehler (404)
  createResult  = null,
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
    // Options-Endpunkt (S-161)
    if (url.startsWith('/api/vps/providers/') && url.endsWith('/options')) {
      if (options === null) {
        return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
      }
      return { ok: true, json: async () => options };
    }
    // Create
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

/** Öffnet das Create-Formular und wartet bis Options geladen. */
async function openCreateForm(utils) {
  const { getByRole } = utils;
  await act(async () => {
    fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
  });
  // Warte bis Dropdowns gerendert (optionsState='ok')
  await waitFor(() => {
    const regionSelect = document.getElementById('vps-create-region');
    return regionSelect && regionSelect.tagName === 'SELECT';
  });
}

// ── AC6: Dropdowns bei hetzner+optionsAvailable:true ─────────────────────────

describe('VpsView — S-162 AC6: Dropdowns bei hetzner + optionsAvailable:true', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC6 — Region-Feld ist ein SELECT (kein input) wenn hetzner + optionsAvailable:true', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const regionEl = document.getElementById('vps-create-region');
    expect(regionEl).not.toBeNull();
    expect(regionEl.tagName).toBe('SELECT');
  });

  it('AC6 — Server-Typ-Feld ist ein SELECT wenn hetzner + optionsAvailable:true', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const stEl = document.getElementById('vps-create-servertype');
    expect(stEl).not.toBeNull();
    expect(stEl.tagName).toBe('SELECT');
  });

  it('AC6 — Region-Dropdown enthält die Hetzner-Locations (nbg1, fsn1, ash)', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const regionSelect = document.getElementById('vps-create-region');
    const values = Array.from(regionSelect.options).map((o) => o.value);
    expect(values).toContain('nbg1');
    expect(values).toContain('fsn1');
    expect(values).toContain('ash');
  });

  it('AC6 — Region-Option zeigt Name + City + Country', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const regionSelect = document.getElementById('vps-create-region');
    const nbg1Option = Array.from(regionSelect.options).find((o) => o.value === 'nbg1');
    expect(nbg1Option).toBeTruthy();
    expect(nbg1Option.textContent).toMatch(/nbg1/i);
    expect(nbg1Option.textContent).toMatch(/nuremberg|nürnberg/i);
  });

  it('AC6 — Server-Typ-Dropdown enthält cx23 und cx33 (nicht cx11-old weil deprecated)', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const stSelect = document.getElementById('vps-create-servertype');
    const values = Array.from(stSelect.options).map((o) => o.value);
    expect(values).toContain('cx23');
    expect(values).toContain('cx33');
    // deprecated darf NICHT erscheinen (AC8)
    expect(values).not.toContain('cx11-old');
  });

  it('AC6 — Auswahl im Region-Dropdown setzt region auf Location-name', async () => {
    let capturedBody = null;
    const fetchMock = makeFetch();
    const wrappedFetch = jest.fn(async (url, opts) => {
      if (url.startsWith('/api/vps/machines/hetzner') && opts?.method === 'POST') {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, status: 201, json: async () => ({ result: 'ok', machine: { provider: 'hetzner', serverId: '1', name: 'x', status: 'provisioning', ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null } }) };
      }
      return fetchMock(url, opts);
    });

    const savedFetch = globalThis.fetch;
    globalThis.fetch = wrappedFetch;
    const onNavigate = jest.fn();
    let utils;
    await act(async () => {
      utils = render(React.createElement(VpsView, { onNavigate }));
    });
    restoreFetch = () => { globalThis.fetch = savedFetch; };

    await openCreateForm(utils);

    // Region auf 'ash' setzen
    const regionSelect = document.getElementById('vps-create-region');
    await act(async () => {
      fireEvent.change(regionSelect, { target: { value: 'ash' } });
    });

    // Name füllen und Submit
    const nameInput = document.getElementById('vps-create-name');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'test-srv' } });
    });

    // Server-Typ ist bereits vorbelegt (cx23)
    const submitBtn = utils.getByRole('button', { name: /^erstellen$/i });
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => expect(capturedBody).not.toBeNull());
    // region muss der Location-name sein
    expect(capturedBody.region).toBe('ash');
  });
});

// ── AC7: Specs + Kosten im Server-Typ-Dropdown ───────────────────────────────

describe('VpsView — S-162 AC7: Specs + Kosten im Server-Typ-Dropdown', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC7 — cx23-Option zeigt Cores, Memory, Disk (Spezifikationen)', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const stSelect = document.getElementById('vps-create-servertype');
    const cx23Option = Array.from(stSelect.options).find((o) => o.value === 'cx23');
    expect(cx23Option).toBeTruthy();
    // Spezifikationen: 2 vCPU, 4 GB, 40 GB
    expect(cx23Option.textContent).toMatch(/2.*vcpu|2 vcpu/i);
    expect(cx23Option.textContent).toMatch(/4.*gb.*ram|4 gb/i);
    expect(cx23Option.textContent).toMatch(/40.*gb/i);
  });

  it('AC7 — cx23-Option zeigt Kosten für nbg1 (brutto: 4.51 €/monatlich)', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Default-Region ist nbg1 (erste Location)
    const stSelect = document.getElementById('vps-create-servertype');
    const cx23Option = Array.from(stSelect.options).find((o) => o.value === 'cx23');
    expect(cx23Option.textContent).toMatch(/4\.51/); // brutto monatlich
  });

  it('AC7 — Regionswechsel zu fsn1 zeigt fsn1-Preis für cx23', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Region auf fsn1 wechseln → Preisanzeige soll folgen
    const regionSelect = document.getElementById('vps-create-region');
    await act(async () => {
      fireEvent.change(regionSelect, { target: { value: 'fsn1' } });
    });

    const stSelect = document.getElementById('vps-create-servertype');
    const cx23Option = Array.from(stSelect.options).find((o) => o.value === 'cx23');
    // fsn1 hat denselben Preis (4.51)
    expect(cx23Option.textContent).toMatch(/4\.51/);
    // Kein "anderer Standort"-Hinweis weil exakter Match
    expect(cx23Option.textContent).not.toMatch(/anderer standort/i);
  });

  it('AC7 — Regionswechsel zu ash: cx33 hat keinen ash-Preis → Fallback mit Hinweis', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // ash wählen — cx33 hat nur nbg1-Preis
    const regionSelect = document.getElementById('vps-create-region');
    await act(async () => {
      fireEvent.change(regionSelect, { target: { value: 'ash' } });
    });

    const stSelect = document.getElementById('vps-create-servertype');
    const cx33Option = Array.from(stSelect.options).find((o) => o.value === 'cx33');
    expect(cx33Option).toBeTruthy();
    // Zeigt Fallback-Preis (nbg1) mit "anderer Standort"-Hinweis
    expect(cx33Option.textContent).toMatch(/7\.99|anderer standort/i);
  });

  it('AC7 — Preis-Anzeige bevorzugt brutto (gross) vor netto (net)', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const stSelect = document.getElementById('vps-create-servertype');
    const cx23Option = Array.from(stSelect.options).find((o) => o.value === 'cx23');
    // 4.51 ist der gross-Wert; 3.79 ist net → gross muss erscheinen
    expect(cx23Option.textContent).toMatch(/4\.51/);
    expect(cx23Option.textContent).toMatch(/brutto/i);
  });
});

// ── AC8: Preis unbekannt + deprecated ausgeblendet ───────────────────────────

describe('VpsView — S-162 AC8: Preis-unbekannt und deprecated', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC8 — Preis unbekannt wenn prices-Array leer', async () => {
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_NO_PRICE }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const stSelect = document.getElementById('vps-create-servertype');
    const cx23Option = Array.from(stSelect.options).find((o) => o.value === 'cx23');
    expect(cx23Option).toBeTruthy();
    expect(cx23Option.textContent).toMatch(/preis unbekannt/i);
  });

  it('AC8 — kein Crash wenn prices-Array leer (graceful)', async () => {
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_NO_PRICE }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Kein Fehler → Form ist noch gerendert
    expect(document.querySelector('form[aria-label="Neuen VPS erstellen"]')).not.toBeNull();
  });

  it('AC8 — deprecated Typ (cx11-old) erscheint NICHT als wählbare Option', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const stSelect = document.getElementById('vps-create-servertype');
    const values = Array.from(stSelect.options).map((o) => o.value);
    expect(values).not.toContain('cx11-old');
  });
});

// ── AC9: Graceful Degradation ─────────────────────────────────────────────────

describe('VpsView — S-162 AC9: Graceful Degradation', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC9 — Fehler beim Options-Laden → Region-Feld bleibt Freitext-Input', async () => {
    const utils = await renderVpsView(makeFetch({ options: null }));
    restoreFetch = utils.restoreFetch;

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
    });
    // Warte bis Fallback eingetreten (optionsState='fallback' → input statt select)
    await waitFor(() => {
      const el = document.getElementById('vps-create-region');
      return el && el.tagName === 'INPUT';
    });

    const regionEl = document.getElementById('vps-create-region');
    expect(regionEl.tagName).toBe('INPUT');
  });

  it('AC9 — Fehler beim Options-Laden → Server-Typ-Feld bleibt Freitext-Input', async () => {
    const utils = await renderVpsView(makeFetch({ options: null }));
    restoreFetch = utils.restoreFetch;

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
    });
    await waitFor(() => {
      const el = document.getElementById('vps-create-region');
      return el && el.tagName === 'INPUT';
    });

    const stEl = document.getElementById('vps-create-servertype');
    expect(stEl.tagName).toBe('INPUT');
  });

  it('AC9 — optionsAvailable:false → Freitext-Fallback', async () => {
    const utils = await renderVpsView(
      makeFetch({ options: { optionsAvailable: false } }),
    );
    restoreFetch = utils.restoreFetch;

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
    });
    await waitFor(() => {
      const el = document.getElementById('vps-create-region');
      return el && el.tagName === 'INPUT';
    });

    const regionEl = document.getElementById('vps-create-region');
    expect(regionEl.tagName).toBe('INPUT');
  });

  it('AC9 — Freitext-Fallback: Hinweis sichtbar (aria-live, kein role=alert)', async () => {
    const utils = await renderVpsView(makeFetch({ options: null }));
    restoreFetch = utils.restoreFetch;

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
    });
    await waitFor(() => {
      const el = document.getElementById('vps-create-region');
      return el && el.tagName === 'INPUT';
    });

    // Fallback-Hinweis ist sichtbar (aria-live, kein role=status oder role=alert)
    const bodyText = document.body.textContent;
    expect(bodyText).toMatch(/live-optionen.*nicht verfügbar|nicht verfügbar.*live-optionen|manuell eingeben/i);
    // Kein role=alert für den Fallback-Zustand (kein harter Fehler)
    const alertEls = Array.from(document.querySelectorAll('[role="alert"]'));
    const fallbackAlert = alertEls.find((el) =>
      el.textContent.match(/live-optionen|nicht verfügbar/i)
    );
    expect(fallbackAlert).toBeUndefined();
  });

  it('AC9 — Create bleibt absendbar bei Freitext-Fallback', async () => {
    let createCalled = false;
    const baseFetch = makeFetch({ options: null });
    const fetchMock = jest.fn(async (url, opts) => {
      if (url.startsWith('/api/vps/machines/hetzner') && opts?.method === 'POST') {
        createCalled = true;
        return { ok: true, status: 201, json: async () => ({ result: 'ok', machine: { provider: 'hetzner', serverId: '1', name: 'x', status: 'provisioning', ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null } }) };
      }
      return baseFetch(url, opts);
    });

    const utils = await renderVpsView(fetchMock);
    restoreFetch = utils.restoreFetch;

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
    });
    await waitFor(() => {
      const el = document.getElementById('vps-create-region');
      return el && el.tagName === 'INPUT';
    });

    // Felder manuell füllen
    await act(async () => {
      fireEvent.change(document.getElementById('vps-create-name'), { target: { value: 'test-srv' } });
      fireEvent.change(document.getElementById('vps-create-region'), { target: { value: 'nbg1' } });
      fireEvent.change(document.getElementById('vps-create-servertype'), { target: { value: 'cx23' } });
    });

    const submitBtn = utils.getByRole('button', { name: /^erstellen$/i });
    expect(submitBtn.disabled).toBe(false);

    await act(async () => { fireEvent.click(submitBtn); });
    await waitFor(() => expect(createCalled).toBe(true));
  });

  it('AC9 — Nicht-Hetzner Provider → Freitext-Felder (Region + Typ als Input)', async () => {
    const ionosProviders = [
      { id: 'ionos', configured: true, capabilities: { list: true, start: true, stop: true, create: true } },
    ];
    const utils = await renderVpsView(makeFetch({ providers: ionosProviders }));
    restoreFetch = utils.restoreFetch;

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
    });
    // ionos → keine Optionen → Freitext (optionsState='idle' → keine Dropdowns)
    // Kurz warten um sicherzustellen dass kein async-Load läuft
    await new Promise((r) => setTimeout(r, 50));

    const regionEl = document.getElementById('vps-create-region');
    expect(regionEl.tagName).toBe('INPUT');
  });

  it('AC9 — alle Server-Typen deprecated → Freitext-Fallback (kein leeres Dropdown)', async () => {
    // Fixture: optionsAvailable:true, Locations vorhanden, aber ALLE Server-Typen sind deprecated
    const optionsAllDeprecated = {
      optionsAvailable: true,
      serverTypes: [
        { name: 'cx11-old', cores: 1, memory: 2, disk: 20, deprecated: true, prices: [] },
        { name: 'cx21-old', cores: 2, memory: 4, disk: 40, deprecated: true, prices: [] },
      ],
      locations: [
        { name: 'nbg1', networkZone: 'eu-central', city: 'Nuremberg', country: 'DE' },
      ],
      images: [],
    };

    let createCalled = false;
    const baseFetch = makeFetch({ options: optionsAllDeprecated });
    const fetchMock = jest.fn(async (url, opts) => {
      if (url.startsWith('/api/vps/machines/hetzner') && opts?.method === 'POST') {
        createCalled = true;
        return { ok: true, status: 201, json: async () => ({ result: 'ok', machine: { provider: 'hetzner', serverId: '1', name: 'x', status: 'provisioning', ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null } }) };
      }
      return baseFetch(url, opts);
    });

    const utils = await renderVpsView(fetchMock);
    restoreFetch = utils.restoreFetch;

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
    });

    // Muss auf Freitext-Fallback fallen (kein leeres Server-Typ-Dropdown)
    await waitFor(() => {
      const el = document.getElementById('vps-create-servertype');
      return el && el.tagName === 'INPUT';
    });

    const stEl = document.getElementById('vps-create-servertype');
    expect(stEl.tagName).toBe('INPUT');

    // Freitext-Fallback: Create muss absendbar bleiben
    await act(async () => {
      fireEvent.change(document.getElementById('vps-create-name'), { target: { value: 'test-srv' } });
      fireEvent.change(document.getElementById('vps-create-region'), { target: { value: 'nbg1' } });
      fireEvent.change(document.getElementById('vps-create-servertype'), { target: { value: 'cx11-old' } });
    });

    const submitBtn = utils.getByRole('button', { name: /^erstellen$/i });
    expect(submitBtn.disabled).toBe(false);

    await act(async () => { fireEvent.click(submitBtn); });
    await waitFor(() => expect(createCalled).toBe(true));
  });
});

// ── AC10: Kein Token im Bundle/Payload ───────────────────────────────────────

describe('VpsView — S-162 AC10: Kein Token im Bundle/Payload', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC10 — Create-Payload enthält nur region (Location-name) + serverType (Typ-name), keinen Token', async () => {
    let capturedBody = null;
    const baseFetch = makeFetch();
    const fetchMock = jest.fn(async (url, opts) => {
      if (url.startsWith('/api/vps/machines/hetzner') && opts?.method === 'POST') {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, status: 201, json: async () => ({ result: 'ok', machine: { provider: 'hetzner', serverId: '1', name: 'x', status: 'provisioning', ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null } }) };
      }
      return baseFetch(url, opts);
    });

    const utils = await renderVpsView(fetchMock);
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Name setzen (Region + Typ sind durch Vorauswahl belegt)
    await act(async () => {
      fireEvent.change(document.getElementById('vps-create-name'), { target: { value: 'test-srv' } });
    });

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /^erstellen$/i }));
    });

    await waitFor(() => expect(capturedBody).not.toBeNull());

    // region ist ein Location-name (kein Token)
    expect(capturedBody.region).toMatch(/^[a-z0-9-]+$/);
    // serverType ist ein Typ-name (kein Token)
    expect(capturedBody.serverType).toMatch(/^[a-z0-9-]+$/);
    // Kein "Bearer"-Token im Body
    expect(JSON.stringify(capturedBody)).not.toMatch(/Bearer|hetzner.*token|api.*token/i);
    // Kein SSH-Key-Material (schon in VpsView.test.jsx geprüft, hier als Sanity-Check)
    expect(JSON.stringify(capturedBody)).not.toContain('ssh-ed25519');
  });

  it('AC10 — Options-Endpunkt-URL enthält keinen Token (Fetch-URL ist clean)', async () => {
    const capturedUrls = [];
    const baseFetch = makeFetch();
    const fetchMock = jest.fn(async (url, opts) => {
      capturedUrls.push(url);
      return baseFetch(url, opts);
    });

    const utils = await renderVpsView(fetchMock);
    restoreFetch = utils.restoreFetch;

    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /neuen vps erstellen/i }));
    });
    await waitFor(() => capturedUrls.some((u) => u.includes('/options')));

    const optionsUrl = capturedUrls.find((u) => u.includes('/options'));
    expect(optionsUrl).toBeTruthy();
    // URL enthält keinen Bearer-Token-ähnlichen String
    expect(optionsUrl).not.toMatch(/Bearer|[A-Za-z0-9]{40,}/);
  });
});

// ── AC18–AC20: availability-Filter + Region-Wechsel-Reset (S-178) ────────────

/**
 * Fixture: Options-Response MIT availability-Map.
 * - nbg1: nur cx33 bereitstellbar (NICHT cx23)
 * - ash:  nur cx23 bereitstellbar (NICHT cx33)
 * - fsn1: kein Eintrag in availability → ungefiltert (AC20)
 *
 * Beide Typen cx23 + cx33 sind nicht deprecated (in serverTypes enthalten).
 * cpx11 ist ebenfalls in ash verfügbar (für Preis-unbekannt-Test nicht nötig hier,
 * aber dokumentiert dass availability unabhängig von prices[] ist).
 */
const OPTIONS_WITH_AVAILABILITY = {
  optionsAvailable: true,
  serverTypes: [
    {
      name: 'cx23',
      cores: 2,
      memory: 4,
      disk: 40,
      deprecated: false,
      prices: [
        { location: 'nbg1', priceMonthly: { net: '3.79', gross: '4.51' }, priceHourly: { net: '0.005', gross: '0.006' } },
        { location: 'ash',  priceMonthly: { net: '3.79', gross: '3.79' }, priceHourly: { net: '0.005', gross: '0.005' } },
      ],
    },
    {
      name: 'cx33',
      cores: 4,
      memory: 8,
      disk: 80,
      deprecated: false,
      prices: [
        { location: 'nbg1', priceMonthly: { net: '6.72', gross: '7.99' }, priceHourly: { net: '0.009', gross: '0.011' } },
      ],
    },
  ],
  locations: [
    { name: 'nbg1', networkZone: 'eu-central', city: 'Nuremberg', country: 'DE' },
    { name: 'ash',  networkZone: 'us-east',    city: 'Ashburn',   country: 'US' },
    { name: 'fsn1', networkZone: 'eu-central', city: 'Falkenstein', country: 'DE' },
  ],
  images: [
    { name: 'ubuntu-24.04', description: 'Ubuntu 24.04', osFlavor: 'ubuntu', osVersion: '24.04' },
  ],
  // availability: nbg1 → cx33 only; ash → cx23 only; fsn1 fehlt → ungefiltert (AC20)
  availability: {
    nbg1: ['cx33'],
    ash:  ['cx23'],
    // fsn1 absichtlich nicht eingetragen (AC20-Fallback-Test)
  },
};

describe('VpsView — S-178 AC18: availability[region]-Filter im Server-Typ-Dropdown', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC18 — Server-Typ-Dropdown zeigt nur Typen aus availability[region] (nbg1 → nur cx33)', async () => {
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_WITH_AVAILABILITY }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Default-Region ist nbg1 (erste Location); availability[nbg1] = ['cx33']
    const regionSelect = document.getElementById('vps-create-region');
    expect(regionSelect.value).toBe('nbg1');

    const stSelect = document.getElementById('vps-create-servertype');
    const values = Array.from(stSelect.options).map((o) => o.value);
    // cx33 muss vorhanden sein (in nbg1 bereitstellbar)
    expect(values).toContain('cx33');
    // cx23 darf NICHT erscheinen (nicht in availability[nbg1])
    expect(values).not.toContain('cx23');
  });

  it('AC18 — Region ash: nur cx23 wählbar (cx33 nicht in availability[ash])', async () => {
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_WITH_AVAILABILITY }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Region auf ash wechseln
    const regionSelect = document.getElementById('vps-create-region');
    await act(async () => {
      fireEvent.change(regionSelect, { target: { value: 'ash' } });
    });

    const stSelect = document.getElementById('vps-create-servertype');
    const values = Array.from(stSelect.options).map((o) => o.value);
    expect(values).toContain('cx23');
    expect(values).not.toContain('cx33');
  });

  it('AC18 — Region steuert Typen-Liste; keine beidseitige Filterung (Region ändert sich nicht wenn Typ gewählt)', async () => {
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_WITH_AVAILABILITY }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Region-Dropdown muss unabhängig von gewähltem Typ alle Locations anbieten
    const regionSelect = document.getElementById('vps-create-region');
    const regionValues = Array.from(regionSelect.options).map((o) => o.value);
    expect(regionValues).toContain('nbg1');
    expect(regionValues).toContain('ash');
    expect(regionValues).toContain('fsn1');
  });
});

describe('VpsView — S-178 AC19: Typ-Reset bei Region-Wechsel wenn Typ nicht mehr verfügbar', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC19 — Wechsel von nbg1 (cx33) zu ash: cx33 nicht in availability[ash] → Typ wird zurückgesetzt', async () => {
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_WITH_AVAILABILITY }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Initial: nbg1 gewählt, cx33 vorausgewählt (einziger nbg1-Typ)
    const regionSelect = document.getElementById('vps-create-region');
    expect(regionSelect.value).toBe('nbg1');
    const stSelect = document.getElementById('vps-create-servertype');
    expect(stSelect.value).toBe('cx33');

    // Wechsel zu ash — cx33 ist nicht in availability[ash]
    await act(async () => {
      fireEvent.change(regionSelect, { target: { value: 'ash' } });
    });

    // serverType muss zurückgesetzt worden sein (nicht mehr cx33)
    expect(stSelect.value).not.toBe('cx33');
    // Stattdessen cx23 (einziger Typ in ash)
    expect(stSelect.value).toBe('cx23');
  });

  it('AC19 — Wechsel zu Region wo der gewählte Typ noch verfügbar ist → Wahl bleibt erhalten', async () => {
    // cx23 ist in ash verfügbar; wählen wir ash initial, dann zurück zu fsn1 (ungefiltert → cx23 bleibt)
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_WITH_AVAILABILITY }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Zu ash wechseln (cx23 wird vorausgewählt)
    const regionSelect = document.getElementById('vps-create-region');
    await act(async () => {
      fireEvent.change(regionSelect, { target: { value: 'ash' } });
    });
    const stSelect = document.getElementById('vps-create-servertype');
    expect(stSelect.value).toBe('cx23');

    // Zu fsn1 wechseln (kein Eintrag in availability → ungefiltert → cx23 ist weiter vorhanden)
    await act(async () => {
      fireEvent.change(regionSelect, { target: { value: 'fsn1' } });
    });

    // cx23 muss noch ausgewählt sein (AC19: Wahl bleibt wenn Typ verfügbar; AC20: fsn1 ungefiltert)
    expect(stSelect.value).toBe('cx23');
  });

  it('AC19 — keine ungültige Region+Typ-Kombi absendbar nach Reset', async () => {
    let capturedBody = null;
    const baseFetch = makeFetch({ options: OPTIONS_WITH_AVAILABILITY });
    const fetchMock = jest.fn(async (url, opts) => {
      if (url.startsWith('/api/vps/machines/hetzner') && opts?.method === 'POST') {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, status: 201, json: async () => ({ result: 'ok', machine: { provider: 'hetzner', serverId: '1', name: 'x', status: 'provisioning', ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null } }) };
      }
      return baseFetch(url, opts);
    });

    const savedFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    restoreFetch = () => { globalThis.fetch = savedFetch; };
    const onNavigate = jest.fn();
    let utils;
    await act(async () => {
      utils = render(React.createElement(VpsView, { onNavigate }));
    });
    await openCreateForm(utils);

    // nbg1 → cx33; Wechsel zu ash → Reset auf cx23
    const regionSelect = document.getElementById('vps-create-region');
    await act(async () => {
      fireEvent.change(regionSelect, { target: { value: 'ash' } });
    });

    // Name setzen + submit
    await act(async () => {
      fireEvent.change(document.getElementById('vps-create-name'), { target: { value: 'test-srv' } });
    });
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /^erstellen$/i }));
    });

    await waitFor(() => expect(capturedBody).not.toBeNull());
    // Nach Reset: region=ash, serverType=cx23 — eine gültige Kombi laut availability
    expect(capturedBody.region).toBe('ash');
    expect(capturedBody.serverType).toBe('cx23');
    // cx33 darf NICHT im Payload stehen (wäre ungültig für ash)
    expect(capturedBody.serverType).not.toBe('cx33');
  });
});

describe('VpsView — S-178 AC20: Graceful Fallback wenn availability fehlt oder Region-Eintrag fehlt', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC20 — fehlt availability komplett → alle nicht-deprecated Typen wählbar (ungefiltert)', async () => {
    // OPTIONS_HETZNER hat kein availability-Feld
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_HETZNER }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Alle aktiven Typen müssen erscheinen (cx23 + cx33; cx11-old deprecated → nicht da)
    const stSelect = document.getElementById('vps-create-servertype');
    const values = Array.from(stSelect.options).map((o) => o.value);
    expect(values).toContain('cx23');
    expect(values).toContain('cx33');
    expect(values).not.toContain('cx11-old'); // deprecated bleibt draussen (AC8)
  });

  it('AC20 — fsn1 hat keinen Eintrag in availability → ungefiltert (alle Typen sichtbar)', async () => {
    const utils = await renderVpsView(makeFetch({ options: OPTIONS_WITH_AVAILABILITY }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    // Wechsel zu fsn1 (kein availability-Eintrag)
    const regionSelect = document.getElementById('vps-create-region');
    await act(async () => {
      fireEvent.change(regionSelect, { target: { value: 'fsn1' } });
    });

    // Beide Typen müssen sichtbar sein (Fallback: ungefiltert)
    const stSelect = document.getElementById('vps-create-servertype');
    const values = Array.from(stSelect.options).map((o) => o.value);
    expect(values).toContain('cx23');
    expect(values).toContain('cx33');
  });

  it('AC20 — availability = {} (leeres Objekt) → alle Regionen ungefiltert', async () => {
    const optionsEmptyAvailability = {
      ...OPTIONS_HETZNER,
      availability: {},
    };
    const utils = await renderVpsView(makeFetch({ options: optionsEmptyAvailability }));
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const stSelect = document.getElementById('vps-create-servertype');
    const values = Array.from(stSelect.options).map((o) => o.value);
    // Kein Eintrag für nbg1 → ungefiltert → alle aktiven Typen sichtbar
    expect(values).toContain('cx23');
    expect(values).toContain('cx33');
  });

  it('AC20 — Floor: Create-Payload unverändert (nur region/serverType/image + sshKeyAssignment)', async () => {
    // Stellt sicher dass die availability-Map NICHT in der Create-Payload landet
    let capturedBody = null;
    const baseFetch = makeFetch({ options: OPTIONS_WITH_AVAILABILITY });
    const fetchMock = jest.fn(async (url, opts) => {
      if (url.startsWith('/api/vps/machines/hetzner') && opts?.method === 'POST') {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, status: 201, json: async () => ({ result: 'ok', machine: { provider: 'hetzner', serverId: '1', name: 'x', status: 'provisioning', ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null } }) };
      }
      return baseFetch(url, opts);
    });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    restoreFetch = () => { globalThis.fetch = savedFetch; };
    const onNavigate = jest.fn();
    let utils;
    await act(async () => {
      utils = render(React.createElement(VpsView, { onNavigate }));
    });
    await openCreateForm(utils);

    await act(async () => {
      fireEvent.change(document.getElementById('vps-create-name'), { target: { value: 'test-srv' } });
    });
    await act(async () => {
      fireEvent.click(utils.getByRole('button', { name: /^erstellen$/i }));
    });
    await waitFor(() => expect(capturedBody).not.toBeNull());

    // Payload darf KEIN availability-Feld enthalten
    expect(capturedBody).not.toHaveProperty('availability');
    // Pflicht-Felder vorhanden
    expect(capturedBody).toHaveProperty('region');
    expect(capturedBody).toHaveProperty('serverType');
    expect(capturedBody).toHaveProperty('sshKeyAssignment');
    // Kein Token
    expect(JSON.stringify(capturedBody)).not.toMatch(/Bearer|api.*token/i);
  });
});

// ── A11y: Beschriftete Dropdowns ─────────────────────────────────────────────

describe('VpsView — S-162 A11y: Dropdown-Beschriftung', () => {
  let restoreFetch;
  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('A11y — Region-Dropdown hat label htmlFor="vps-create-region" und aria-required', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const regionSelect = document.getElementById('vps-create-region');
    expect(regionSelect.getAttribute('aria-required')).toBe('true');
    // Label muss über htmlFor verknüpft sein
    const label = document.querySelector('label[for="vps-create-region"]');
    expect(label).not.toBeNull();
    expect(label.textContent).toMatch(/region/i);
  });

  it('A11y — Server-Typ-Dropdown hat label htmlFor und aria-required', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const stSelect = document.getElementById('vps-create-servertype');
    expect(stSelect.getAttribute('aria-required')).toBe('true');
    const label = document.querySelector('label[for="vps-create-servertype"]');
    expect(label).not.toBeNull();
    expect(label.textContent).toMatch(/server-typ/i);
  });

  it('A11y — minHeight ≥ 44px für Region-Dropdown (Touch-Target, WCAG 2.1 AA)', async () => {
    const utils = await renderVpsView(makeFetch());
    restoreFetch = utils.restoreFetch;
    await openCreateForm(utils);

    const regionSelect = document.getElementById('vps-create-region');
    const minH = parseInt(regionSelect.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44); // createStyles.select minHeight muss ≥ 44px sein (WCAG Touch-Target)
  });
});
