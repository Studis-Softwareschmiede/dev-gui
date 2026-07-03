/**
 * VpsSshTerminal.test.jsx — Tests für die root/alex-Buttons + das Inline-SSH-Terminal
 * je VPS-Karte (S-264, Frontend-Anteil von docs/specs/vps-ssh-terminal.md).
 *
 * @jest-environment jsdom
 *
 * Covers (vps-ssh-terminal):
 *   AC1 — Jede VPS-Karte zeigt zwei klein übereinander angeordnete, beschriftete
 *          Buttons „root"/„alex" (aria-label je Rolle).
 *   AC2 — Klick öffnet unterhalb GENAU dieser Karte ein Terminal-Fenster (Terminal.jsx
 *          wiederverwendet, WS-URL `/ws/vps-terminal`) + startet den Open-Handshake
 *          `{type:"open",provider,serverId,user}`; Tastatureingaben werden als
 *          `{type:"input",data}` durchgereicht.
 *   AC3 — Verbindungs-Status als Label sichtbar; „Schließen"-Knopf beendet die Sitzung;
 *          zweiter Klick auf denselben Button schließt ebenfalls; mehrere Karten dürfen
 *          gleichzeitig je ein eigenes Terminal (unabhängige WS) offen haben.
 *   AC4 — `{type:"error",errorClass,reason}` → geheimnisfreie Meldung in genau diesem
 *          Fenster (im Terminal-Output UND als role="alert", WCAG AA — spec NFR
 *          "Fehlermeldung als role=alert"), übrige Liste bleibt intakt; WS-Upgrade-403
 *          (nie verbunden) → „Keine Berechtigung"-Meldung ohne Crash (ebenfalls
 *          role="alert"), übrige Liste bleibt intakt.
 *
 * `../wsClient.js` wird gemockt (ESM, `jest.unstable_mockModule` + dynamische Imports
 * danach — Muster analog `Terminal.test.jsx`), damit keine echte WebSocket-Verbindung
 * nötig ist. `@xterm/xterm`/`@xterm/addon-fit` sind global über `moduleNameMapper`
 * gestubbt (jest.config.js) — kein zusätzlicher Mock hier nötig.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// ── Mock wsClient (ESM — vor dynamischen Imports deklarieren) ────────────────────

/** @type {Array<object>} Eine Test-Instanz je TerminalConnection-Konstruktion. */
let mockInstances = [];

jest.unstable_mockModule('../wsClient.js', () => ({
  WS_STATUS: {
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    DISCONNECTED: 'disconnected',
  },
  TerminalConnection: jest.fn().mockImplementation((url, opts = {}) => {
    const inst = {
      url,
      openPayload: opts.openPayload,
      connect:    jest.fn(),
      send:       jest.fn(),
      sendResize: jest.fn(),
      destroy:    jest.fn(),
      onStatus:  jest.fn((fn) => { inst._statusFn = fn; return () => {}; }),
      onMessage: jest.fn((fn) => { inst._messageFn = fn; return () => {}; }),
    };
    mockInstances.push(inst);
    return inst;
  }),
}));

const { render }               = await import('@testing-library/react');
const React                    = (await import('react')).default;
const { VpsView }              = await import('../VpsView.jsx');
const { Terminal: XTermStub }  = await import('@xterm/xterm');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SSH_LABELS_BOTH = [
  { user: 'root', publicKey: 'ssh-ed25519 AAA root@test', privateKeyStatus: 'set' },
  { user: 'alex', publicKey: 'ssh-ed25519 AAA alex@test', privateKeyStatus: 'set' },
];

const PROVIDERS = [
  { id: 'hetzner', configured: true, capabilities: { list: true, start: true, stop: true, create: true, delete: true } },
];

const MACHINE_A = {
  provider: 'hetzner', serverId: '1', name: 'web-server',
  status: 'running', ipv4: '1.2.3.4', ipv6: null, region: 'nbg1', serverType: 'cx11', createdAt: null,
};
const MACHINE_B = {
  provider: 'hetzner', serverId: '2', name: 'backup-server',
  status: 'running', ipv4: '5.6.7.8', ipv6: null, region: 'fsn1', serverType: 'cx11', createdAt: null,
};

function makeFetch({ machines = { machines: [MACHINE_A, MACHINE_B] } } = {}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/settings/ssh-keys') return { ok: true, json: async () => SSH_LABELS_BOTH };
    if (url === '/api/vps/providers') return { ok: true, json: async () => PROVIDERS };
    if (url === '/api/vps/machines' && (!opts || !opts.method || opts.method === 'GET')) {
      return { ok: true, json: async () => machines };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  });
}

async function renderVpsView(fetchMock = makeFetch()) {
  globalThis.fetch = fetchMock;
  let result;
  await act(async () => {
    result = render(React.createElement(VpsView, { onNavigate: jest.fn() }));
  });
  return result;
}

beforeEach(() => {
  mockInstances = [];
  XTermStub._reset();
});

afterEach(() => {
  delete globalThis.fetch;
});

// ── AC1: root/alex-Buttons je Karte ───────────────────────────────────────────

describe('VpsSshTerminal — AC1: root/alex-Buttons je VPS-Karte', () => {
  it('zeigt je Karte einen beschrifteten root- und alex-Button', async () => {
    const { getAllByRole } = await renderVpsView();

    await waitFor(() => {
      expect(getAllByRole('button', { name: /SSH-Terminal als root für/i })).toHaveLength(2);
      expect(getAllByRole('button', { name: /SSH-Terminal als alex für/i })).toHaveLength(2);
    });
  });

  it('aria-label benennt die jeweilige VPS-Karte eindeutig', async () => {
    const { getByRole } = await renderVpsView();

    await waitFor(() => {
      expect(getByRole('button', { name: 'SSH-Terminal als root für web-server öffnen' })).toBeDefined();
      expect(getByRole('button', { name: 'SSH-Terminal als alex für backup-server öffnen' })).toBeDefined();
    });
  });
});

// ── AC2: Terminal unter richtiger Karte + Open-Handshake + Input ──────────────

describe('VpsSshTerminal — AC2: Terminal-Fenster + Open-Handshake + Input-Relay', () => {
  it('öffnet ein Terminal unter der angeklickten Karte mit korrekter WS-URL', async () => {
    const { getAllByRole, getByRole } = await renderVpsView();
    await waitFor(() => expect(getAllByRole('button', { name: /SSH-Terminal als root für/i })).toHaveLength(2));

    const rootBtnCardA = getByRole('button', { name: 'SSH-Terminal als root für web-server öffnen' });
    await act(async () => { fireEvent.click(rootBtnCardA); });

    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0].url).toContain('/ws/vps-terminal');
    // panel is rendered (Schließen-Knopf identifies it, scoped to web-server)
    expect(getByRole('button', { name: 'SSH-Terminal (root) für web-server schließen' })).toBeDefined();
  });

  it('sendet den Open-Handshake {type:"open",provider,serverId,user} als openPayload', async () => {
    const { getAllByRole, getByRole } = await renderVpsView();
    await waitFor(() => expect(getAllByRole('button', { name: /SSH-Terminal als alex für/i })).toHaveLength(2));

    const alexBtnCardB = getByRole('button', { name: 'SSH-Terminal als alex für backup-server öffnen' });
    await act(async () => { fireEvent.click(alexBtnCardB); });

    expect(mockInstances[0].openPayload).toEqual({
      type: 'open', provider: 'hetzner', serverId: '2', user: 'alex',
    });
    expect(mockInstances[0].connect).toHaveBeenCalled();
  });

  it('reicht Tastatureingaben als {type:"input",data} über die WS-Verbindung durch', async () => {
    const { getAllByRole, getByRole } = await renderVpsView();
    await waitFor(() => expect(getAllByRole('button', { name: /SSH-Terminal als root für/i })).toHaveLength(2));

    const rootBtnCardA = getByRole('button', { name: 'SSH-Terminal als root für web-server öffnen' });
    await act(async () => { fireEvent.click(rootBtnCardA); });

    const xterm = XTermStub._lastInstance;
    expect(xterm.onData).toHaveBeenCalled();
    const dataHandler = xterm.onData.mock.calls[0][0];

    act(() => { dataHandler('ls -la\n'); });

    // Terminal.jsx relays via conn.send(data) — wsClient.js itself wraps it as
    // {type:"input",data} (tested at unit level in wsClient.test.js).
    expect(mockInstances[0].send).toHaveBeenCalledWith('ls -la\n');
  });
});

// ── AC3: Status-Label + Schließen + mehrere unabhängige Sitzungen ─────────────

describe('VpsSshTerminal — AC3: Status-Label, Schließen, mehrere unabhängige Terminals', () => {
  it('zeigt den Verbindungs-Status als Label im Terminal-Fenster', async () => {
    const { getAllByRole, getByRole, container } = await renderVpsView();
    await waitFor(() => expect(getAllByRole('button', { name: /SSH-Terminal als root für/i })).toHaveLength(2));

    const rootBtnCardA = getByRole('button', { name: 'SSH-Terminal als root für web-server öffnen' });
    await act(async () => { fireEvent.click(rootBtnCardA); });

    const panel = container.querySelector('[aria-label="SSH-Terminal (root) — web-server"]');
    expect(panel).not.toBeNull();
    const status = panel.querySelector('[role="status"]');
    expect(status.textContent).toContain('verbinde');
  });

  it('zweiter Klick auf denselben Button schließt das Terminal', async () => {
    const { getAllByRole, getByRole, queryByRole } = await renderVpsView();
    await waitFor(() => expect(getAllByRole('button', { name: /SSH-Terminal als root für/i })).toHaveLength(2));

    const rootBtnCardA = getByRole('button', { name: 'SSH-Terminal als root für web-server öffnen' });
    await act(async () => { fireEvent.click(rootBtnCardA); });
    expect(queryByRole('button', { name: 'SSH-Terminal (root) für web-server schließen' })).not.toBeNull();

    // Zweiter Klick auf denselben Button (jetzt "schließen"-beschriftet)
    const rootBtnCardAActive = getByRole('button', { name: 'SSH-Terminal als root für web-server schließen' });
    await act(async () => { fireEvent.click(rootBtnCardAActive); });

    expect(mockInstances[0].destroy).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'SSH-Terminal (root) für web-server schließen' })).toBeNull();
  });

  it('„Schließen"-Knopf im Terminal-Fenster beendet die Sitzung', async () => {
    const { getAllByRole, getByRole, queryByRole } = await renderVpsView();
    await waitFor(() => expect(getAllByRole('button', { name: /SSH-Terminal als alex für/i })).toHaveLength(2));

    const alexBtnCardB = getByRole('button', { name: 'SSH-Terminal als alex für backup-server öffnen' });
    await act(async () => { fireEvent.click(alexBtnCardB); });

    const closeBtn = getByRole('button', { name: 'SSH-Terminal (alex) für backup-server schließen' });
    await act(async () => { fireEvent.click(closeBtn); });

    expect(mockInstances[0].destroy).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'SSH-Terminal (alex) für backup-server schließen' })).toBeNull();
  });

  it('zwei Karten dürfen gleichzeitig je ein eigenes SSH-Terminal offen haben (unabhängige WS)', async () => {
    const { getAllByRole, getByRole } = await renderVpsView();
    await waitFor(() => expect(getAllByRole('button', { name: /SSH-Terminal als root für/i })).toHaveLength(2));

    const rootBtnCardA = getByRole('button', { name: 'SSH-Terminal als root für web-server öffnen' });
    await act(async () => { fireEvent.click(rootBtnCardA); });

    const alexBtnCardB = getByRole('button', { name: 'SSH-Terminal als alex für backup-server öffnen' });
    await act(async () => { fireEvent.click(alexBtnCardB); });

    expect(mockInstances).toHaveLength(2);
    expect(mockInstances[0].openPayload).toEqual({ type: 'open', provider: 'hetzner', serverId: '1', user: 'root' });
    expect(mockInstances[1].openPayload).toEqual({ type: 'open', provider: 'hetzner', serverId: '2', user: 'alex' });

    // Beide Fenster gleichzeitig im DOM (beide Schließen-Buttons vorhanden)
    expect(getByRole('button', { name: 'SSH-Terminal (root) für web-server schließen' })).toBeDefined();
    expect(getByRole('button', { name: 'SSH-Terminal (alex) für backup-server schließen' })).toBeDefined();
  });
});

// ── AC4: Fehlerklassen-Anzeige + 403 + übrige Liste intakt ────────────────────

describe('VpsSshTerminal — AC4: Fehlerklassen-Anzeige, 403, Liste bleibt intakt', () => {
  it('zeigt eine {type:"error"}-Meldung geheimnisfrei in genau diesem Fenster', async () => {
    const { getAllByRole, getByRole } = await renderVpsView();
    await waitFor(() => expect(getAllByRole('button', { name: /SSH-Terminal als root für/i })).toHaveLength(2));

    const rootBtnCardA = getByRole('button', { name: 'SSH-Terminal als root für web-server öffnen' });
    await act(async () => { fireEvent.click(rootBtnCardA); });

    act(() => {
      mockInstances[0]._messageFn({ type: 'error', errorClass: 'unreachable', reason: 'VPS-Ziel nicht erreichbar' });
    });

    const xterm = XTermStub._lastInstance;
    expect(xterm.write).toHaveBeenCalledWith(expect.stringContaining('VPS-Ziel nicht erreichbar'));
    // WCAG AA (spec NFR "Fehlermeldung als role=alert") — xterm's canvas ist nicht AT-zugänglich
    expect(getByRole('alert').textContent).toContain('VPS-Ziel nicht erreichbar');

    // übrige Liste bleibt intakt: die andere Karte + ihre Buttons sind weiterhin da
    expect(getByRole('button', { name: 'SSH-Terminal als alex für backup-server öffnen' })).toBeDefined();
    expect(getByRole('button', { name: /web-server starten/i })).toBeDefined();
  });

  it('WS-Upgrade-403 (nie verbunden) → „Keine Berechtigung"-Meldung ohne Crash; Liste bleibt intakt', async () => {
    const { getAllByRole, getByRole } = await renderVpsView();
    await waitFor(() => expect(getAllByRole('button', { name: /SSH-Terminal als alex für/i })).toHaveLength(2));

    const alexBtnCardB = getByRole('button', { name: 'SSH-Terminal als alex für backup-server öffnen' });
    await act(async () => { fireEvent.click(alexBtnCardB); });

    // Verbindung schlägt fehl, ohne je 'connected' erreicht zu haben (403 beim Upgrade)
    act(() => { mockInstances[0]._statusFn('disconnected'); });

    const xterm = XTermStub._lastInstance;
    expect(xterm.write).toHaveBeenCalledWith(expect.stringContaining('Keine Berechtigung'));
    // WCAG AA (spec NFR "Fehlermeldung als role=alert")
    expect(getByRole('alert').textContent).toContain('Keine Berechtigung');

    // kein Crash: die übrige Kartenliste + deren Buttons sind weiterhin bedienbar
    expect(getAllByRole('button', { name: /SSH-Terminal als root für/i })).toHaveLength(2);
    expect(getByRole('button', { name: /backup-server starten/i })).toBeDefined();
  });
});
