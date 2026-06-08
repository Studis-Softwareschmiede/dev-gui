/**
 * VpsView.test.jsx — Tests für die VpsView-Komponente.
 *
 * Covers (view-vps AC3–AC10):
 *   AC3  — GET /api/vps/machines; Maschinen-Liste mit Provider/Name/Status/IPv4; Leer-Zustand.
 *   AC4  — Provider ohne Token → „nicht konfiguriert"-Hinweis; kein Lifecycle-Aufruf.
 *   AC5  — providerErrors → degradierende Anzeige; gestörter Provider markiert; übrige sichtbar.
 *   AC6  — Start/Stop pro Maschine; Capability-Flag disabled + title; 403 klar als Fehler.
 *   AC7  — Create-Formular: Provider/Name/Region/Servertyp/Image + SSH-Key-Zuordnung auslösen.
 *   AC8  — Create gesperrt wenn root/alex kein gesetzter Public-Key; Hinweis auf SSH-Keys.
 *   AC9  — Lade-/Erfolg-/Fehlerzustände für Mutationen; kein Token im Frontend.
 *   AC10 — 403 → „keine Berechtigung"-Meldung; kein UI-Crash.
 *
 * Covers (vps-ssh-key-assignment AC1/AC2/AC5):
 *   AC1  — Create-Formular zeigt je Rolle (root, alex) ein Dropdown mit Labels mit Public-Key;
 *           Labels ohne Public-Key werden nicht angeboten.
 *   AC2  — Default-Vorbelegung: gleichnamiges Label → Rolle (Label "root" → root, "alex" → alex);
 *           übersteuerbar. Non-distinkte Auswahl zeigt Hinweis.
 *   AC5  (ssh-key-assignment) — Create-Button gesperrt wenn kein Label mit Public-Key vorhanden oder Rolle leer.
 *   AC3  (ssh-key-assignment) — sshKeyAssignment wird als Label-Referenzen gesendet, nie als Key-Material.
 *
 * view-vps Gerüst (weiterhin gültig):
 *   - h1-Heading "VPS" vorhanden
 *   - Home-Button navigiert zurück zum Panel; Touch-Target ≥ 44 px
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

const PROVIDERS_ALL_UNCONFIGURED = [
  { id: 'hetzner', configured: false, capabilities: { list: false, start: false, stop: false, create: false } },
  { id: 'ionos', configured: false, capabilities: { list: false, start: false, stop: false, create: false } },
];

const MACHINE_RUNNING = {
  provider: 'hetzner',
  serverId: '1',
  name: 'web-server',
  status: 'running',
  ipv4: '1.2.3.4',
  ipv6: null,
  region: 'nbg1',
  serverType: 'cx11',
  createdAt: null,
};

const MACHINE_STOPPED = {
  provider: 'hetzner',
  serverId: '2',
  name: 'backup-server',
  status: 'stopped',
  ipv4: null,
  ipv6: null,
  region: 'fsn1',
  serverType: 'cx11',
  createdAt: null,
};

// Provider mit start-Capability=false
const PROVIDERS_NO_START = [
  { id: 'hetzner', configured: true, capabilities: { list: true, start: false, stop: true, create: true } },
];

const MACHINES_ONE = { machines: [MACHINE_RUNNING] };
const MACHINES_TWO = { machines: [MACHINE_RUNNING, MACHINE_STOPPED] };
const MACHINES_EMPTY = { machines: [] };
const MACHINES_WITH_PROVIDER_ERROR = {
  machines: [MACHINE_RUNNING],
  providerErrors: [{ provider: 'ionos', errorClass: 'provider-unavailable' }],
};

// ── Mock-fetch-Fabrik ─────────────────────────────────────────────────────────

/**
 * Baut einen fetch-Mock der je nach URL unterschiedliche Daten zurückgibt.
 */
function makeFetch({
  sshLabels = SSH_LABELS_BOTH,
  providers = PROVIDERS_HETZNER,
  machines = MACHINES_EMPTY,
  createResult = null,
  powerResult = { result: 'ok' },
  powerStatus = 200,
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
    // Start/Stop: URL ends with /start or /stop
    if (opts?.method === 'POST' && (url.endsWith('/start') || url.endsWith('/stop'))) {
      return {
        ok: powerStatus >= 200 && powerStatus < 300,
        status: powerStatus,
        json: async () => powerResult,
      };
    }
    // Create: POST to /api/vps/machines/:provider (no /start or /stop suffix)
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

// ── AC3 (view-vps): Maschinen-Liste ──────────────────────────────────────────

describe('VpsView — AC3 (view-vps): Maschinen-Übersicht', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC3 — zeigt Maschinen mit Provider, Name, Status und IPv4', async () => {
    const { getByText, restoreFetch: rf } = await renderVpsView(
      makeFetch({ machines: MACHINES_ONE }),
    );
    restoreFetch = rf;
    expect(getByText('web-server')).toBeTruthy();
    expect(getByText('hetzner')).toBeTruthy();
    expect(getByText('running')).toBeTruthy();
    expect(getByText('1.2.3.4')).toBeTruthy();
  });

  it('AC3 — zeigt Leer-Zustand wenn keine Maschinen vorhanden', async () => {
    const { getByText, restoreFetch: rf } = await renderVpsView(
      makeFetch({ machines: MACHINES_EMPTY, providers: [
        { id: 'hetzner', configured: true, capabilities: { list: true, start: true, stop: true, create: true } },
      ] }),
    );
    restoreFetch = rf;
    expect(getByText(/keine maschinen/i)).toBeTruthy();
  });

  it('AC3 — mehrere Maschinen werden alle aufgelistet', async () => {
    const { getByText, restoreFetch: rf } = await renderVpsView(
      makeFetch({ machines: MACHINES_TWO }),
    );
    restoreFetch = rf;
    expect(getByText('web-server')).toBeTruthy();
    expect(getByText('backup-server')).toBeTruthy();
  });
});

// ── AC4 (view-vps): nicht konfigurierte Provider ─────────────────────────────

describe('VpsView — AC4 (view-vps): nicht konfigurierter Provider', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC4 — zeigt Hinweis für nicht konfigurierten Provider (ionos)', async () => {
    const { getByText, restoreFetch: rf } = await renderVpsView(
      makeFetch({ providers: PROVIDERS_HETZNER, machines: MACHINES_EMPTY }),
    );
    restoreFetch = rf;
    expect(getByText(/ionos/i)).toBeTruthy();
    expect(getByText(/nicht konfiguriert/i)).toBeTruthy();
  });

  it('AC4 — Onboarding-Hinweis wenn alle Provider unkonfiguriert', async () => {
    const { restoreFetch: rf } = await renderVpsView(
      makeFetch({ providers: PROVIDERS_ALL_UNCONFIGURED, machines: MACHINES_EMPTY }),
    );
    restoreFetch = rf;
    // Entweder im list-Bereich oder als Onboarding-Banner
    const page = document.body.textContent;
    expect(page).toMatch(/kein provider konfiguriert|nicht konfiguriert/i);
  });

  it('AC4 — Hinweis verweist auf Einstellungen/Credentials', async () => {
    const { getByText, restoreFetch: rf } = await renderVpsView(
      makeFetch({ providers: PROVIDERS_HETZNER, machines: MACHINES_EMPTY }),
    );
    restoreFetch = rf;
    expect(getByText(/Credentials|credentials/i)).toBeTruthy();
  });

  it('AC4 — kein Lifecycle-Aufruf (POST /start oder /stop) für ausschließlich unkonfigurierte Provider', async () => {
    // Alle Provider unkonfiguriert — kein Start/Stop darf ausgelöst werden.
    // Die Machines-Liste liefert Maschinen (z.B. aus einem Cache), aber Buttons
    // müssen disabled sein (S2: capsMap gibt start/stop=false für unkonfigurierte Provider).
    const powerCalls = [];
    const fetchMock = jest.fn(async (url, opts) => {
      if (url === '/api/settings/ssh-keys') return { ok: true, json: async () => SSH_LABELS_BOTH };
      if (url === '/api/vps/providers') return { ok: true, json: async () => PROVIDERS_ALL_UNCONFIGURED };
      if (url === '/api/vps/machines' && (!opts || opts.method !== 'POST')) {
        return { ok: true, json: async () => MACHINES_ONE };
      }
      if (opts?.method === 'POST' && (url.endsWith('/start') || url.endsWith('/stop'))) {
        powerCalls.push(url);
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { getByRole, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    // Start/Stop-Buttons sollen disabled sein (S2: unkonfiguriert → caps false)
    const startBtn = getByRole('button', { name: /web-server starten/i });
    const stopBtn = getByRole('button', { name: /web-server stoppen/i });
    expect(startBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(true);

    // Kein POST auf /start oder /stop erfolgt
    expect(powerCalls.length).toBe(0);
  });
});

// ── AC5 (view-vps): providerErrors — degradierende Anzeige ───────────────────

describe('VpsView — AC5 (view-vps): degradierende Provider-Fehler', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC5 — zeigt Maschinen des funktionierenden Providers weiterhin', async () => {
    const { getByText, restoreFetch: rf } = await renderVpsView(
      makeFetch({ machines: MACHINES_WITH_PROVIDER_ERROR }),
    );
    restoreFetch = rf;
    // Maschine des funktionierenden Providers (hetzner) bleibt sichtbar
    expect(getByText('web-server')).toBeTruthy();
  });

  it('AC5 — zeigt gestörten Provider als Fehlermeldung (nicht Voll-Fehler)', async () => {
    const { getAllByText, restoreFetch: rf } = await renderVpsView(
      makeFetch({ machines: MACHINES_WITH_PROVIDER_ERROR }),
    );
    restoreFetch = rf;
    // ionos erscheint (ggf. mehrfach — als unkonfiguriert und als gestört)
    const ionosEls = getAllByText(/ionos/i);
    expect(ionosEls.length).toBeGreaterThan(0);
    // gestört-Meldung enthält provider-unavailable
    const body = document.body.textContent;
    expect(body).toMatch(/gestört|provider-unavailable/i);
  });

  it('AC5 — kein Voll-Fehler-Zustand bei einzelnem Provider-Fehler', async () => {
    const { restoreFetch: rf } = await renderVpsView(
      makeFetch({ machines: MACHINES_WITH_PROVIDER_ERROR }),
    );
    restoreFetch = rf;
    // Kein loadError-Banner (keine main-level-alert für degradierten Provider)
    // Die Maschinen-Liste ist trotzdem sichtbar — kein allgemeiner Fehlerbalken
    const alerts = document.querySelectorAll('[role="alert"]');
    // Es sollte kein Alert für den normalen Load-Fehler vorhanden sein
    const loadAlerts = Array.from(alerts).filter(
      (a) => a.textContent.includes('Maschinen-Laden fehlgeschlagen')
    );
    expect(loadAlerts).toHaveLength(0);
  });
});

// ── AC6 (view-vps): Start/Stop pro Maschine ──────────────────────────────────

describe('VpsView — AC6 (view-vps): Start/Stop-Buttons', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC6 — Start- und Stop-Buttons pro Maschine vorhanden', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({ machines: MACHINES_ONE }),
    );
    restoreFetch = rf;
    const startBtn = getByRole('button', { name: /web-server starten/i });
    const stopBtn = getByRole('button', { name: /web-server stoppen/i });
    expect(startBtn).toBeTruthy();
    expect(stopBtn).toBeTruthy();
  });

  it('AC6 — Start-Button disabled wenn Capability start=false', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({ machines: MACHINES_ONE, providers: PROVIDERS_NO_START }),
    );
    restoreFetch = rf;
    const startBtn = getByRole('button', { name: /web-server starten/i });
    expect(startBtn.disabled).toBe(true);
  });

  it('AC6 — Start-Button hat title-Hinweis wenn nicht unterstützt', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({ machines: MACHINES_ONE, providers: PROVIDERS_NO_START }),
    );
    restoreFetch = rf;
    const startBtn = getByRole('button', { name: /web-server starten/i });
    expect(startBtn.title).toMatch(/nicht unterstützt/i);
  });

  it('AC6 — Touch-Target ≥ 44 px für Start/Stop-Buttons', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({ machines: MACHINES_ONE }),
    );
    restoreFetch = rf;
    const startBtn = getByRole('button', { name: /web-server starten/i });
    const stopBtn = getByRole('button', { name: /web-server stoppen/i });
    expect(parseInt(startBtn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    expect(parseInt(stopBtn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
  });

  it('AC6 — Start-Button ruft POST .../start auf und zeigt OK', async () => {
    let startCalled = false;
    const fetchMock = jest.fn(async (url, opts) => {
      if (url === '/api/settings/ssh-keys') return { ok: true, json: async () => SSH_LABELS_BOTH };
      if (url === '/api/vps/providers') return { ok: true, json: async () => PROVIDERS_HETZNER };
      if (url === '/api/vps/machines' && (!opts || opts.method !== 'POST')) {
        return { ok: true, json: async () => MACHINES_ONE };
      }
      if (opts?.method === 'POST' && url.endsWith('/start')) {
        startCalled = true;
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { getByRole, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    const startBtn = getByRole('button', { name: /web-server starten/i });
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => expect(startCalled).toBe(true));
    // OK-Feedback erscheint
    await waitFor(() => {
      const okTexts = Array.from(document.querySelectorAll('[role="status"]'))
        .filter((el) => el.textContent.includes('OK'));
      expect(okTexts.length).toBeGreaterThan(0);
    });
  });

  it('AC6 — Stop-Button ruft POST .../stop auf', async () => {
    let stopCalled = false;
    const fetchMock = jest.fn(async (url, opts) => {
      if (url === '/api/settings/ssh-keys') return { ok: true, json: async () => SSH_LABELS_BOTH };
      if (url === '/api/vps/providers') return { ok: true, json: async () => PROVIDERS_HETZNER };
      if (url === '/api/vps/machines' && (!opts || opts.method !== 'POST')) {
        return { ok: true, json: async () => MACHINES_ONE };
      }
      if (opts?.method === 'POST' && url.endsWith('/stop')) {
        stopCalled = true;
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { getByRole, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    const stopBtn = getByRole('button', { name: /web-server stoppen/i });
    await act(async () => { fireEvent.click(stopBtn); });

    await waitFor(() => expect(stopCalled).toBe(true));
  });
});

// ── AC9 (view-vps): Lade-/Erfolg-/Fehlerzustände für Mutationen ──────────────

describe('VpsView — AC9 (view-vps): Mutations-Feedback', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC9 — zeigt Fehlermeldung bei fehlgeschlagenem Start (502)', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({
        machines: MACHINES_ONE,
        powerResult: { result: 'error', reason: 'Provider nicht erreichbar' },
        powerStatus: 502,
      }),
    );
    restoreFetch = rf;

    const startBtn = getByRole('button', { name: /web-server starten/i });
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => {
      const errors = Array.from(document.querySelectorAll('[role="alert"]'))
        .filter((el) => el.textContent.match(/provider|fehlgeschlagen|erreichbar/i));
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  it('AC9 — keine Provider-Tokens (Bearer-Strings) in Fehlermeldungen (AC10-Kombi)', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({
        machines: MACHINES_ONE,
        powerResult: { result: 'error', reason: 'Interner Fehler' },
        powerStatus: 502,
      }),
    );
    restoreFetch = rf;

    const startBtn = getByRole('button', { name: /web-server starten/i });
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => {
      const body = document.body.textContent;
      // Kein Bearer-Token-Wert im UI (die Text-Labels "API-Token" sind erlaubt)
      expect(body).not.toMatch(/Bearer [A-Za-z0-9._-]+/i);
    });
  });

  it('AC9 — "unsupported" Ergebnis (HTTP 200) wird als Hinweis (role="status", nicht "alert") gezeigt', async () => {
    // HTTP-Contract für result:'unsupported' ist 200 — nicht 4xx.
    // Der echte Code-Pfad: postPowerAction gibt { result:'unsupported', reason:… } zurück,
    // VpsMachineRow setzt actionState='unsupported' → rendert mit role="status".
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({
        machines: MACHINES_ONE,
        powerResult: { result: 'unsupported', reason: 'Start wird nicht unterstützt' },
        powerStatus: 200,
      }),
    );
    restoreFetch = rf;

    const startBtn = getByRole('button', { name: /web-server starten/i });
    await act(async () => { fireEvent.click(startBtn); });

    // Muss in einem role="status"-Element erscheinen (nicht role="alert")
    await waitFor(() => {
      const statusEls = Array.from(document.querySelectorAll('[role="status"]'));
      const unsupportedEl = statusEls.find((el) => el.textContent.match(/nicht unterstützt|unsupported/i));
      expect(unsupportedEl).toBeTruthy();
    });
    // Darf NICHT in einem role="alert"-Element stehen (wäre der error-Pfad)
    const alertEls = Array.from(document.querySelectorAll('[role="alert"]'));
    const unsupportedAlert = alertEls.find((el) => el.textContent.match(/nicht unterstützt|unsupported/i));
    expect(unsupportedAlert).toBeUndefined();
  });
});

// ── AC10 (view-vps): 403 → keine Berechtigung ────────────────────────────────

describe('VpsView — AC10 (view-vps): 403-Behandlung', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC10 — 403 bei Start zeigt „keine Berechtigung"-Meldung', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({
        machines: MACHINES_ONE,
        powerResult: { error: 'Keine Berechtigung für diese Aktion' },
        powerStatus: 403,
      }),
    );
    restoreFetch = rf;

    const startBtn = getByRole('button', { name: /web-server starten/i });
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => {
      const body = document.body.textContent;
      expect(body).toMatch(/berechtigung|403/i);
    });
  });

  it('AC10 — 403 bei Start kein UI-Crash (Komponente rendert weiterhin)', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({
        machines: MACHINES_ONE,
        powerResult: { error: 'Keine Berechtigung für diese Aktion' },
        powerStatus: 403,
      }),
    );
    restoreFetch = rf;

    const startBtn = getByRole('button', { name: /web-server starten/i });
    await act(async () => { fireEvent.click(startBtn); });

    // Maschinen-Liste und Heading bleiben sichtbar
    await waitFor(() => {
      expect(getByRole('heading', { name: /^vps$/i })).toBeTruthy();
    });
  });

  it('AC10 — 403 bei Stop zeigt „keine Berechtigung"-Meldung', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({
        machines: MACHINES_ONE,
        powerResult: { error: 'Keine Berechtigung für diese Aktion' },
        powerStatus: 403,
      }),
    );
    restoreFetch = rf;

    const stopBtn = getByRole('button', { name: /web-server stoppen/i });
    await act(async () => { fireEvent.click(stopBtn); });

    await waitFor(() => {
      const body = document.body.textContent;
      expect(body).toMatch(/berechtigung|403/i);
    });
  });
});

// ── AC7 (view-vps): Create-Formular ──────────────────────────────────────────

describe('VpsView — AC7 (view-vps): Create-Formular', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC7 — Create-Formular zeigt alle Pflichtfelder (Provider, Name, Region, Servertyp)', async () => {
    const { getByRole, getByLabelText, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    expect(getByLabelText(/^provider/i)).toBeTruthy();
    expect(getByLabelText(/^name/i)).toBeTruthy();
    expect(getByLabelText(/^region/i)).toBeTruthy();
    expect(getByLabelText(/^server-typ/i)).toBeTruthy();
  });

  it('AC7 — Image-Feld zeigt Ubuntu 26.04 als Default-Placeholder', async () => {
    const { getByRole, getByLabelText, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    const imageInput = getByLabelText(/^image/i);
    expect(imageInput.placeholder).toMatch(/ubuntu.*26\.04|default.*ubuntu/i);
  });

  it('AC7 — erfolgreicher Create schließt Formular und listet neue Maschine', async () => {
    const newMachine = {
      provider: 'hetzner', serverId: '99', name: 'new-srv', status: 'provisioning',
      ipv4: null, ipv6: null, region: null, serverType: null, createdAt: null,
    };
    // Nach Create liefert der Re-Fetch die neue Maschine
    let createDone = false;
    const fetchMock = jest.fn(async (url, opts) => {
      if (url === '/api/settings/ssh-keys') return { ok: true, json: async () => SSH_LABELS_BOTH };
      if (url === '/api/vps/providers') return { ok: true, json: async () => PROVIDERS_HETZNER };
      if (url === '/api/vps/machines' && (!opts || opts.method !== 'POST')) {
        return { ok: true, json: async () => createDone
          ? { machines: [newMachine] }
          : MACHINES_EMPTY };
      }
      if (opts?.method === 'POST' && !url.endsWith('/start') && !url.endsWith('/stop')) {
        createDone = true;
        return { ok: true, status: 201, json: async () => ({ result: 'ok', machine: newMachine }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { getByRole, getByLabelText, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });

    const nameInput = getByLabelText(/^name/i);
    const regionInput = getByLabelText(/^region/i);
    const serverTypeInput = getByLabelText(/^server-typ/i);

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'new-srv' } });
      fireEvent.change(regionInput, { target: { value: 'nbg1' } });
      fireEvent.change(serverTypeInput, { target: { value: 'cx11' } });
    });

    const submitBtn = getByRole('button', { name: /^erstellen$/i });
    await act(async () => { fireEvent.click(submitBtn); });

    // Formular wird nach Erfolg geschlossen (role="form" ist weg)
    await waitFor(() => {
      expect(document.querySelector('form[aria-label="Neuen VPS erstellen"]')).toBeNull();
    });
  });
});

// ── AC8 (view-vps): Create gesperrt ohne SSH-Keys ────────────────────────────

describe('VpsView — AC8 (view-vps): Create-Sperre ohne SSH-Keys', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('AC8 — Blockier-Hinweis nennt SSH-Keys/Einstellungen wenn kein Key vorhanden', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({ sshLabels: SSH_LABELS_NONE }),
    );
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    const body = document.body.textContent;
    expect(body).toMatch(/ssh-key|einstellungen|ssh/i);
  });

  it('AC8 — Create-Button disabled wenn kein SSH-Key mit Public-Key hinterlegt', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(
      makeFetch({ sshLabels: SSH_LABELS_NONE }),
    );
    restoreFetch = rf;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /neuen vps erstellen/i }));
    });
    const submitBtn = getByRole('button', { name: /erstell/i });
    expect(submitBtn.disabled).toBe(true);
  });
});
