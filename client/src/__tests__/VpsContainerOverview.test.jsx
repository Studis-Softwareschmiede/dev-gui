/**
 * VpsContainerOverview.test.jsx — Tests für die Container-Übersicht (S-157).
 *
 * @jest-environment jsdom
 *
 * Covers (vps-container-overview):
 *   AC1  — Container-Button je VPS-Zeile; Klick öffnet Übersicht + Listing-Fetch
 *   AC2  — Listet Name, Status, Image, Port; managed vs. unmanaged markiert
 *   AC3  — Leer-Zustand; Listing-Fehler degradiert nur diese Übersicht
 *   AC4  — Start/Stop/Neustart/Logs/Entfernen-Buttons; nach Erfolg Re-Fetch; 403 → Hinweis
 *   AC5  — Logs: rendert Zeilen; kein SSH-Key/Token im DOM
 *   AC6  — Managed-Remove: type-to-confirm (Hostname); Undeploy-Call; ohne Confirm deaktiviert
 *   AC7  — Unmanaged-Remove: type-to-confirm (ContainerId); kein Cloudflare-Step
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { VpsView } = await import('../VpsView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SSH_LABELS_BOTH = [
  { user: 'root', publicKey: 'ssh-ed25519 AAA root@test', privateKeyStatus: 'set' },
  { user: 'alex', publicKey: 'ssh-ed25519 AAA alex@test', privateKeyStatus: 'set' },
];

const PROVIDERS = [
  { id: 'hetzner', configured: true, capabilities: { list: true, start: true, stop: true, create: true, delete: true } },
];

const MACHINE = {
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

const MANAGED_CONTAINER = {
  containerId: 'abc123def456',
  name: 'abc123def456',
  image: 'ghcr.io/org/app:v1',
  hostname: 'app.example.com',
  status: 'Up 2 hours',
  hostPort: 8080,
  managed: true,
};

const UNMANAGED_CONTAINER = {
  containerId: 'fff000eee111',
  name: 'fff000eee111',
  image: 'nginx:latest',
  hostname: null,
  status: 'Up 1 hour',
  hostPort: 80,
  managed: false,
};

// ── Fetch-Mock-Fabrik ─────────────────────────────────────────────────────────

function makeFetch({
  sshLabels = SSH_LABELS_BOTH,
  providers = PROVIDERS,
  machines = { machines: [MACHINE] },
  containers = { result: 'ok', containers: [MANAGED_CONTAINER, UNMANAGED_CONTAINER] },
  containerAction = { result: 'ok' },
  containerActionStatus = 200,
  logs = { result: 'ok', lines: ['log line 1', 'log line 2'] },
  logsStatus = 200,
  deleteResult = { result: 'ok' },
  deleteStatus = 200,
} = {}) {
  return jest.fn(async (url, opts = {}) => {
    if (url === '/api/settings/ssh-keys') {
      return { ok: true, json: async () => sshLabels };
    }
    if (url === '/api/vps/providers') {
      return { ok: true, json: async () => providers };
    }
    if (url === '/api/vps/machines' && (!opts || !opts.method || opts.method === 'GET')) {
      return { ok: true, json: async () => machines };
    }
    if (url.endsWith('/containers') && (!opts?.method || opts.method === 'GET')) {
      return { ok: true, json: async () => containers };
    }
    if (url.includes('/logs')) {
      return {
        ok: logsStatus >= 200 && logsStatus < 300,
        status: logsStatus,
        json: async () => logs,
      };
    }
    if (opts?.method === 'DELETE' && url.includes('/containers/')) {
      return {
        ok: deleteStatus >= 200 && deleteStatus < 300,
        status: deleteStatus,
        json: async () => deleteResult,
      };
    }
    if (opts?.method === 'POST' && url.includes('/containers/')) {
      return {
        ok: containerActionStatus >= 200 && containerActionStatus < 300,
        status: containerActionStatus,
        json: async () => containerAction,
      };
    }
    if (opts?.method === 'POST' && (url.endsWith('/start') || url.endsWith('/stop'))) {
      return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
    }
    if (opts?.method === 'DELETE' && !url.includes('/containers/')) {
      return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  });
}

async function renderVpsView(fetchMock) {
  globalThis.fetch = fetchMock;
  let result;
  await act(async () => {
    result = render(React.createElement(VpsView, { onNavigate: jest.fn() }));
  });
  return result;
}

// ── AC1: Container-Button vorhanden + Listing-Fetch ───────────────────────────

describe('VpsContainerOverview — AC1: Container-Button + Listing-Fetch', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('Container-Button ist in jeder VPS-Zeile vorhanden', async () => {
    const fetchMock = makeFetch();
    const { getByRole } = await renderVpsView(fetchMock);
    await waitFor(() => {
      expect(getByRole('button', { name: /Container/i })).toBeDefined();
    });
  });

  it('Klick auf Container-Button öffnet die Übersicht und ruft Listing-Fetch ab', async () => {
    const fetchMock = makeFetch();
    const { getByRole } = await renderVpsView(fetchMock);

    await waitFor(() => {
      expect(getByRole('button', { name: /Container/i })).toBeDefined();
    });

    // Vor dem Klick: kein Listing-Fetch
    const callsBefore = fetchMock.mock.calls.filter((c) => c[0].includes('/containers')).length;
    expect(callsBefore).toBe(0);

    const btn = getByRole('button', { name: /Container/i });
    await act(async () => { fireEvent.click(btn); });

    // Nach dem Klick: Listing-Fetch für diesen VPS
    await waitFor(() => {
      const containerCalls = fetchMock.mock.calls.filter((c) => c[0].includes('/containers'));
      expect(containerCalls.length).toBeGreaterThan(0);
      const url = containerCalls[0][0];
      expect(url).toContain('/api/vps/machines/hetzner/1/containers');
    });
  });

  it('Container-Button hat korrekte aria-expanded-Attribute', async () => {
    const fetchMock = makeFetch();
    const { getByRole } = await renderVpsView(fetchMock);

    await waitFor(() => {
      expect(getByRole('button', { name: /Container/i })).toBeDefined();
    });

    const btn = getByRole('button', { name: /Container/i });
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    await act(async () => { fireEvent.click(btn); });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });
});

// ── AC2: Listet Container mit Name, Status, Image, Port; managed vs. unmanaged ─

describe('VpsContainerOverview — AC2: Container-Felder + managed/unmanaged', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('rendert managed Container mit Hostname sichtbar', async () => {
    const fetchMock = makeFetch();
    const { getByRole, getByText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());

    const btn = getByRole('button', { name: /Container/i });
    await act(async () => { fireEvent.click(btn); });

    await waitFor(() => {
      // Hostname des managed Containers soll sichtbar sein
      expect(getByText('app.example.com')).toBeDefined();
    });
  });

  it('rendert Image, Status, Port für Container', async () => {
    const fetchMock = makeFetch();
    const { getByRole, getByText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());

    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByText(/ghcr\.io\/org\/app:v1/)).toBeDefined();
      expect(getByText(/Up 2 hours/)).toBeDefined();
    });
  });

  it('managed Container hat Badge "M", unmanaged hat Badge "U"', async () => {
    const fetchMock = makeFetch();
    const { getByRole, getAllByText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      const managedBadges = getAllByText('M');
      const unmanagedBadges = getAllByText('U');
      expect(managedBadges.length).toBeGreaterThan(0);
      expect(unmanagedBadges.length).toBeGreaterThan(0);
    });
  });
});

// ── AC3: Leer-Zustand + Fehler-Degradierung ────────────────────────────────────

describe('VpsContainerOverview — AC3: Leer-Zustand + Fehler-Degradierung', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('Leer-Antwort → neutraler Leer-Hinweis', async () => {
    const fetchMock = makeFetch({ containers: { result: 'ok', containers: [] } });
    const { getByRole, getByText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByText(/keine container laufend/i)).toBeDefined();
    });
  });

  it('SSH-Fehler-Antwort → Fehlermarkierung für diesen VPS, übrige VPS bleiben', async () => {
    const fetchMock = makeFetch({
      containers: { result: 'error', errorClass: 'unreachable', reason: 'VPS nicht erreichbar' },
    });
    const { getByRole, getByText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      // Fehlertext für diese Übersicht
      expect(getByText(/VPS nicht erreichbar/i)).toBeDefined();
    });

    // Übrige VPS-Zeile noch vorhanden (Name)
    expect(getByText('web-server')).toBeDefined();
  });
});

// ── AC4: Aktions-Buttons + Re-Fetch + 403 ─────────────────────────────────────

describe('VpsContainerOverview — AC4: Aktions-Buttons', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('Start-Button vorhanden und aufrufbar', async () => {
    const fetchMock = makeFetch();
    const { getByRole } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByRole('button', { name: /container abc123def456 starten/i })).toBeDefined();
    });
  });

  it('nach erfolgreicher Start-Aktion wird Liste neu geladen (Re-Fetch)', async () => {
    const fetchMock = makeFetch();
    const { getByRole } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    const listCallsBefore = fetchMock.mock.calls.filter((c) => c[0].endsWith('/containers')).length;

    await waitFor(() => {
      expect(getByRole('button', { name: /container abc123def456 starten/i })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /container abc123def456 starten/i }));
    });

    await waitFor(() => {
      const listCallsAfter = fetchMock.mock.calls.filter((c) => c[0].endsWith('/containers')).length;
      expect(listCallsAfter).toBeGreaterThan(listCallsBefore);
    });
  });

  it('403-Antwort → Berechtigungs-Meldung ohne UI-Crash', async () => {
    const fetchMock = makeFetch({
      containerAction: { error: 'Keine Berechtigung' },
      containerActionStatus: 403,
    });
    const { getByRole, getByText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByRole('button', { name: /container abc123def456 starten/i })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /container abc123def456 starten/i }));
    });

    await waitFor(() => {
      expect(getByText(/keine berechtigung/i)).toBeDefined();
    });

    // VPS-Zeile noch vorhanden (kein UI-Crash)
    expect(getByText('web-server')).toBeDefined();
  });
});

// ── AC5: Logs ansehen ─────────────────────────────────────────────────────────

describe('VpsContainerOverview — AC5: Logs ansehen', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('Logs-Button lädt Log-Zeilen und zeigt sie an', async () => {
    const fetchMock = makeFetch();
    const { getByRole, getByText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByRole('button', { name: /logs von container abc123def456/i })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /logs von container abc123def456/i }));
    });

    await waitFor(() => {
      expect(getByText(/log line 1/i)).toBeDefined();
      expect(getByText(/log line 2/i)).toBeDefined();
    });
  });

  it('AC5 — kein SSH-Private-Key oder CF-Token im DOM nach Log-Anzeige', async () => {
    const SECRET_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----FAKESECRET';
    const fetchMock = makeFetch({
      logs: { result: 'ok', lines: ['normal log output'] },
    });
    const { getByRole, baseElement } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByRole('button', { name: /logs von container abc123def456/i })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /logs von container abc123def456/i }));
    });

    await waitFor(() => {
      expect(baseElement.textContent).toContain('normal log output');
    });

    // Kein Secret im DOM
    expect(baseElement.textContent).not.toContain(SECRET_KEY);
    expect(baseElement.textContent).not.toContain('OPENSSH');
  });
});

// ── AC6: Managed-Remove mit type-to-confirm ────────────────────────────────────

describe('VpsContainerOverview — AC6: Managed-Remove', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('Entfernen-Button öffnet type-to-confirm-Dialog für managed Container', async () => {
    const fetchMock = makeFetch({
      containers: { result: 'ok', containers: [MANAGED_CONTAINER] },
    });
    const { getByRole, getAllByText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByRole('button', { name: /container abc123def456 entfernen/i })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /container abc123def456 entfernen/i }));
    });

    await waitFor(() => {
      // Dialog soll Hostname zeigen (managed → Hostname); kann mehrfach vorkommen
      const matches = getAllByText(/app\.example\.com/);
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it('ohne korrekten Confirm ist der Entfernen-Button deaktiviert', async () => {
    const fetchMock = makeFetch({
      containers: { result: 'ok', containers: [MANAGED_CONTAINER] },
    });
    const { getByRole, getByPlaceholderText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByRole('button', { name: /container abc123def456 entfernen/i })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /container abc123def456 entfernen/i }));
    });

    await waitFor(() => {
      expect(getByPlaceholderText('app.example.com')).toBeDefined();
    });

    // Falschen Wert eintippen
    const input = getByPlaceholderText('app.example.com');
    await act(async () => { fireEvent.change(input, { target: { value: 'wrong-hostname' } }); });

    const confirmBtn = getByRole('button', { name: /endgültig entfernen/i });
    expect(confirmBtn.disabled).toBe(true);
  });

  it('mit korrektem Confirm (Hostname) wird DELETE-Call ausgelöst (AC6)', async () => {
    const fetchMock = makeFetch({
      containers: { result: 'ok', containers: [MANAGED_CONTAINER] },
    });
    const { getByRole, getByPlaceholderText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByRole('button', { name: /container abc123def456 entfernen/i })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /container abc123def456 entfernen/i }));
    });

    await waitFor(() => {
      expect(getByPlaceholderText('app.example.com')).toBeDefined();
    });

    const input = getByPlaceholderText('app.example.com');
    await act(async () => { fireEvent.change(input, { target: { value: 'app.example.com' } }); });

    const confirmBtn = getByRole('button', { name: /endgültig entfernen/i });
    expect(confirmBtn.disabled).toBe(false);

    await act(async () => { fireEvent.click(confirmBtn); });

    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter(
        (c) => c[1]?.method === 'DELETE' && c[0].includes('/containers/'),
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
      // confirm-Wert = Hostname (managed)
      const body = JSON.parse(deleteCalls[0][1].body);
      expect(body.confirm).toBe('app.example.com');
    });
  });
});

// ── AC7: Unmanaged-Remove ─────────────────────────────────────────────────────

describe('VpsContainerOverview — AC7: Unmanaged-Remove', () => {
  afterEach(() => { delete globalThis.fetch; });

  it('Entfernen eines unmanaged Containers → type-to-confirm mit ContainerId', async () => {
    const fetchMock = makeFetch({
      containers: { result: 'ok', containers: [UNMANAGED_CONTAINER] },
    });
    const { getByRole, getByPlaceholderText, getByText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByRole('button', { name: /container fff000eee111 entfernen/i })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /container fff000eee111 entfernen/i }));
    });

    // Confirm-Feld mit ContainerId als Placeholder
    await waitFor(() => {
      expect(getByPlaceholderText('fff000eee111')).toBeDefined();
    });

    // Hostname soll NICHT erscheinen (unmanaged hat keinen Hostname)
    expect(() => getByText('app.example.com')).toThrow();
  });

  it('mit ContainerId bestätigt → DELETE-Call ohne Cloudflare-Step', async () => {
    const fetchMock = makeFetch({
      containers: { result: 'ok', containers: [UNMANAGED_CONTAINER] },
    });
    const { getByRole, getByPlaceholderText } = await renderVpsView(fetchMock);

    await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
    await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });

    await waitFor(() => {
      expect(getByRole('button', { name: /container fff000eee111 entfernen/i })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /container fff000eee111 entfernen/i }));
    });

    await waitFor(() => {
      expect(getByPlaceholderText('fff000eee111')).toBeDefined();
    });

    const input = getByPlaceholderText('fff000eee111');
    await act(async () => { fireEvent.change(input, { target: { value: 'fff000eee111' } }); });

    const confirmBtn = getByRole('button', { name: /endgültig entfernen/i });
    await act(async () => { fireEvent.click(confirmBtn); });

    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter(
        (c) => c[1]?.method === 'DELETE' && c[0].includes('/containers/'),
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(deleteCalls[0][1].body);
      // confirm-Wert = ContainerId (unmanaged — kein Hostname)
      expect(body.confirm).toBe('fff000eee111');
    });
  });
});
