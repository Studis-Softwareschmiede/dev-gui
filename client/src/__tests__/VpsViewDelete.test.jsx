/**
 * VpsViewDelete.test.jsx — Tests für den Löschen-Button + type-to-confirm (S-153).
 *
 * @jest-environment jsdom
 *
 * Covers (vps-delete):
 *   AC8  — Löschen-Button in der VPS-Zeile; disabled wenn capabilities.delete=false
 *   AC9  — type-to-confirm: VPS-Name exakt eintippen; Mismatch → Button gesperrt, kein DELETE
 *          Abbruch verwirft folgenlos
 *   AC10 — Lade-/Erfolg-/Fehler-/403-Zustände; nach Erfolg verschwindet VPS; kein Token im Frontend
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { VpsView }   = await import('../VpsView.jsx');

// ── Test-Fixtures ─────────────────────────────────────────────────────────────

const SSH_LABELS_BOTH = [
  { user: 'root', publicKey: 'ssh-ed25519 AAA root@test', privateKeyStatus: 'set' },
  { user: 'alex', publicKey: 'ssh-ed25519 AAA alex@test', privateKeyStatus: 'set' },
];

const PROVIDERS_WITH_DELETE = [
  { id: 'hetzner', configured: true, capabilities: { list: true, start: true, stop: true, create: true, delete: true } },
];

const PROVIDERS_WITHOUT_DELETE = [
  { id: 'hostinger', configured: true, capabilities: { list: true, start: true, stop: true, create: false, delete: false } },
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

// ── Fetch-Mock-Fabrik ─────────────────────────────────────────────────────────

function makeFetch({
  sshLabels = SSH_LABELS_BOTH,
  providers = PROVIDERS_WITH_DELETE,
  machines = { machines: [MACHINE_RUNNING] },
  deleteResult = { result: 'ok' },
  deleteStatus = 200,
} = {}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/settings/ssh-keys') {
      return { ok: true, json: async () => sshLabels };
    }
    if (url === '/api/vps/providers') {
      return { ok: true, json: async () => providers };
    }
    if (url === '/api/vps/machines' && (!opts || opts.method !== 'DELETE')) {
      return { ok: true, json: async () => machines };
    }
    if (opts?.method === 'DELETE') {
      return {
        ok: deleteStatus >= 200 && deleteStatus < 300,
        status: deleteStatus,
        json: async () => deleteResult,
      };
    }
    if (opts?.method === 'POST' && (url.endsWith('/start') || url.endsWith('/stop'))) {
      return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  });
}

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

// ── AC8: Löschen-Button Sichtbarkeit und disabled-Status ─────────────────────

describe('VpsViewDelete — AC8: Löschen-Button', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('Löschen-Button vorhanden wenn delete:true', async () => {
    const { getByRole, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;
    const btn = getByRole('button', { name: /web-server löschen/i });
    expect(btn).toBeTruthy();
  });

  it('Löschen-Button disabled wenn capabilities.delete=false', async () => {
    const fetchMock = makeFetch({
      providers: PROVIDERS_WITHOUT_DELETE,
      machines: { machines: [{ ...MACHINE_RUNNING, provider: 'hostinger' }] },
    });
    const { getByRole, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;
    const btn = getByRole('button', { name: /web-server löschen/i });
    expect(btn.disabled).toBe(true);
  });

  it('Löschen-Button hat title-Hinweis wenn capabilities.delete=false', async () => {
    const fetchMock = makeFetch({
      providers: PROVIDERS_WITHOUT_DELETE,
      machines: { machines: [{ ...MACHINE_RUNNING, provider: 'hostinger' }] },
    });
    const { getByRole, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;
    const btn = getByRole('button', { name: /web-server löschen/i });
    expect(btn.title).toMatch(/nicht unterstützt/i);
  });
});

// ── AC9: type-to-confirm-Dialog ───────────────────────────────────────────────

describe('VpsViewDelete — AC9: type-to-confirm', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('Klick auf Löschen öffnet type-to-confirm-Dialog', async () => {
    const { getByRole, findByLabelText, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const input = await findByLabelText(/namen eintippen/i);
    expect(input).toBeTruthy();
  });

  it('finaler Löschen-Button gesperrt bei leerem Eingabefeld', async () => {
    const { getByRole, findByRole, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const finalBtn = await findByRole('button', { name: /endgültig löschen/i });
    expect(finalBtn.disabled).toBe(true);
  });

  it('finaler Löschen-Button gesperrt bei falschem Namen', async () => {
    const { getByRole, findByRole, findByLabelText, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const input = await findByLabelText(/namen eintippen/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'wrong-name' } }); });

    const finalBtn = await findByRole('button', { name: /endgültig löschen/i });
    expect(finalBtn.disabled).toBe(true);
  });

  it('finaler Löschen-Button aktiv bei exakt korrektem Namen', async () => {
    const { getByRole, findByRole, findByLabelText, restoreFetch: rf } = await renderVpsView(makeFetch());
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const input = await findByLabelText(/namen eintippen/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'web-server' } }); });

    const finalBtn = await findByRole('button', { name: /endgültig löschen/i });
    expect(finalBtn.disabled).toBe(false);
  });

  it('kein DELETE gesendet bei Mismatch-Namen', async () => {
    const fetchMock = makeFetch();
    const { getByRole, findByRole, findByLabelText, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const input = await findByLabelText(/namen eintippen/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'wrong-name' } }); });

    const finalBtn = await findByRole('button', { name: /endgültig löschen/i });
    // finalBtn.disabled === true, simuliere trotzdem submit
    const form = finalBtn.closest('form');
    await act(async () => { fireEvent.submit(form); });

    // kein DELETE-Aufruf
    const deleteCalls = fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCalls.length).toBe(0);
  });

  it('Abbrechen schließt Dialog folgenlos ohne DELETE', async () => {
    const fetchMock = makeFetch();
    const { getByRole, findByRole, queryByRole, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const cancelBtn = await findByRole('button', { name: /abbrechen/i });
    await act(async () => { fireEvent.click(cancelBtn); });

    // Dialog verschwunden
    await waitFor(() => {
      expect(queryByRole('button', { name: /endgültig löschen/i })).toBeNull();
    });

    // kein DELETE gesendet
    const deleteCalls = fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCalls.length).toBe(0);
  });
});

// ── AC10: Lade-/Erfolg-/Fehler-/403-Zustände ──────────────────────────────────

describe('VpsViewDelete — AC10: Zustände', () => {
  let restoreFetch;

  afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

  it('nach Erfolg verschwindet der VPS aus der Übersicht', async () => {
    // Nach dem Delete-Call liefert /api/vps/machines eine leere Liste
    let callCount = 0;
    const fetchMock = jest.fn(async (url, opts) => {
      if (url === '/api/settings/ssh-keys') {
        return { ok: true, json: async () => SSH_LABELS_BOTH };
      }
      if (url === '/api/vps/providers') {
        return { ok: true, json: async () => PROVIDERS_WITH_DELETE };
      }
      if (url === '/api/vps/machines' && (!opts || opts.method !== 'DELETE')) {
        callCount++;
        // Erste Anfrage: Maschine vorhanden; nach Delete: leer
        if (callCount === 1) {
          return { ok: true, json: async () => ({ machines: [MACHINE_RUNNING] }) };
        }
        return { ok: true, json: async () => ({ machines: [] }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { getByRole, findByRole, findByLabelText, queryByRole, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const input = await findByLabelText(/namen eintippen/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'web-server' } }); });

    const finalBtn = await findByRole('button', { name: /endgültig löschen/i });
    await act(async () => { fireEvent.click(finalBtn); });

    // VPS-Zeile verschwindet (null-Return wenn deleted)
    await waitFor(() => {
      expect(queryByRole('button', { name: /web-server löschen/i })).toBeNull();
    });
  });

  it('403-Antwort → als „keine Berechtigung"-Meldung angezeigt', async () => {
    const fetchMock = makeFetch({
      deleteStatus: 403,
      deleteResult: { error: 'Keine Berechtigung für diese Aktion' },
    });

    const { getByRole, findByRole, findByLabelText, findByText, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const input = await findByLabelText(/namen eintippen/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'web-server' } }); });

    const finalBtn = await findByRole('button', { name: /endgültig löschen/i });
    await act(async () => { fireEvent.click(finalBtn); });

    await findByText(/berechtigung/i);
  });

  it('Fehler-Antwort → Fehlermeldung angezeigt', async () => {
    const fetchMock = makeFetch({
      deleteStatus: 502,
      deleteResult: { reason: 'Provider nicht erreichbar' },
    });

    const { getByRole, findByRole, findByLabelText, findByText, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const input = await findByLabelText(/namen eintippen/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'web-server' } }); });

    const finalBtn = await findByRole('button', { name: /endgültig löschen/i });
    await act(async () => { fireEvent.click(finalBtn); });

    await findByText(/Provider nicht erreichbar/i);
  });

  it('kein Token im Frontend (Security-Floor)', async () => {
    const fetchMock = makeFetch();
    const { container, getByRole, findByRole, findByLabelText, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const input = await findByLabelText(/namen eintippen/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'web-server' } }); });

    const finalBtn = await findByRole('button', { name: /endgültig löschen/i });
    await act(async () => { fireEvent.click(finalBtn); });

    // kein Bearer-Token im gerenderten HTML
    expect(container.innerHTML).not.toMatch(/Bearer/i);
    // kein Secret-ähnliches Pattern
    expect(container.innerHTML).not.toMatch(/api[_-]token/i);
  });

  it('DELETE-Request enthält vpsName im Body (für Tunnel-Cleanup)', async () => {
    const fetchMock = makeFetch();
    const { getByRole, findByRole, findByLabelText, restoreFetch: rf } = await renderVpsView(fetchMock);
    restoreFetch = rf;

    const deleteBtn = getByRole('button', { name: /web-server löschen/i });
    await act(async () => { fireEvent.click(deleteBtn); });

    const input = await findByLabelText(/namen eintippen/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'web-server' } }); });

    const finalBtn = await findByRole('button', { name: /endgültig löschen/i });
    await act(async () => { fireEvent.click(finalBtn); });

    // Finde den DELETE-Call
    const deleteCalls = fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCalls.length).toBeGreaterThan(0);
    const deleteOpts = deleteCalls[0][1];
    const body = JSON.parse(deleteOpts.body);
    expect(body.vpsName).toBe('web-server');
  });
});
