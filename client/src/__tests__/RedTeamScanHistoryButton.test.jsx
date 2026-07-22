/**
 * RedTeamScanHistoryButton.test.jsx — Tests für die Verdrahtung des „Verlauf"-Knopfs in
 * `VpsView.jsx` `ContainerRow` (docs/specs/red-team-scan-per-container.md AC14).
 * Die isolierte Listen-/Detail-/Board-Rückverfolgungs-Logik ist in
 * `RedTeamScanHistory.test.jsx` abgedeckt (AC14/AC15) — dieser Test deckt NUR die
 * Knopf-Sichtbarkeit + das Öffnen/Schließen des Panels (Mount-Reachability, coder/R07).
 *
 * @jest-environment jsdom
 *
 * Covers (red-team-scan-per-container):
 *   AC14 — „Verlauf"-Knopf ist NUR für managed Container sichtbar (unabhängig vom
 *          Laufzustand — Verlauf bleibt für gestoppte Container einsehbar); Klick öffnet
 *          `RedTeamScanHistory` (`aria-expanded` wechselt, Panel erscheint mit der
 *          Verlaufsliste); zweiter Klick schließt es wieder.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { VpsView } = await import('../VpsView.jsx');

const SSH_LABELS = [{ user: 'root', publicKey: 'ssh-ed25519 AAA root@test', privateKeyStatus: 'set' }];
const PROVIDERS = [{ id: 'hetzner', configured: true, capabilities: { list: true, start: true, stop: true, create: true, delete: true } }];
const MACHINE = { provider: 'hetzner', serverId: '1', name: 'web-server', status: 'running', ipv4: '1.2.3.4', ipv6: null, region: 'nbg1', serverType: 'cx11', createdAt: null };

const MANAGED_RUNNING = {
  containerId: 'abc123def456',
  name: 'abc123def456',
  image: 'ghcr.io/org/app:v1',
  hostname: 'app.example.com',
  state: 'running',
  status: 'Up 2 hours',
  hostPort: 8080,
  managed: true,
};
const MANAGED_STOPPED = { ...MANAGED_RUNNING, containerId: 'stopped1', name: 'stopped1', state: 'exited', status: 'Exited (0) 1h ago' };
const UNMANAGED_RUNNING = { ...MANAGED_RUNNING, containerId: 'unmanaged1', name: 'unmanaged1', hostname: null, managed: false };

function makeFetch({ containers = [MANAGED_RUNNING], scans = [] } = {}) {
  const fn = jest.fn(async (url, opts = {}) => {
    if (url === '/api/settings/ssh-keys') return { ok: true, json: async () => SSH_LABELS };
    if (url === '/api/vps/providers') return { ok: true, json: async () => PROVIDERS };
    if (url === '/api/vps/machines' && (!opts.method || opts.method === 'GET')) {
      return { ok: true, json: async () => ({ machines: [MACHINE] }) };
    }
    if (url.endsWith('/containers') && (!opts?.method || opts.method === 'GET')) {
      return { ok: true, json: async () => ({ result: 'ok', containers }) };
    }
    if ((!opts?.method || opts.method === 'GET') && url.endsWith('/scans')) {
      return { ok: true, status: 200, json: async () => ({ scans }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  });
  return fn;
}

async function renderVpsView(fetchMock) {
  globalThis.fetch = fetchMock;
  let result;
  await act(async () => {
    result = render(React.createElement(VpsView, { onNavigate: jest.fn() }));
  });
  return result;
}

async function openContainerOverview(getByRole) {
  await waitFor(() => expect(getByRole('button', { name: /Container/i })).toBeDefined());
  await act(async () => { fireEvent.click(getByRole('button', { name: /Container/i })); });
}

afterEach(() => { delete globalThis.fetch; });

describe('VpsContainerScanHistoryButton — AC14: Sichtbarkeit + Öffnen/Schließen', () => {
  it('managed + laufender Container: "Verlauf"-Knopf ist sichtbar', async () => {
    const fetchMock = makeFetch({ containers: [MANAGED_RUNNING] });
    const { getByRole } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /verlauf für container abc123def456 anzeigen/i })).toBeDefined();
    });
  });

  it('managed + gestoppter Container: "Verlauf"-Knopf bleibt sichtbar (Verlauf ist an hostname gebunden)', async () => {
    const fetchMock = makeFetch({ containers: [MANAGED_STOPPED] });
    const { getByRole } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /verlauf für container stopped1 anzeigen/i })).toBeDefined();
    });
  });

  it('unmanaged Container: kein "Verlauf"-Knopf', async () => {
    const fetchMock = makeFetch({ containers: [UNMANAGED_RUNNING] });
    const { getByRole, queryByRole } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    await waitFor(() => expect(getByRole('button', { name: /entfernen/i })).toBeDefined());
    expect(queryByRole('button', { name: /verlauf für container/i })).toBeNull();
  });

  it('Klick öffnet den Verlauf-Aufklapper (Liste wird geladen und gerendert) — zweiter Klick schließt ihn wieder', async () => {
    const fetchMock = makeFetch({
      containers: [MANAGED_RUNNING],
      scans: [{ scanId: 'scan-1', startedAt: '2026-07-20T10:00:00.000Z', ampel: 'gruen', findingCount: 0, boardItemIds: [] }],
    });
    const { getByRole, getByTestId, queryByTestId } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    const historyBtn = await waitFor(() => getByRole('button', { name: /verlauf für container abc123def456 anzeigen/i }));
    expect(historyBtn.getAttribute('aria-expanded')).toBe('false');

    await act(async () => { fireEvent.click(historyBtn); });

    await waitFor(() => {
      expect(getByRole('button', { name: /verlauf für container abc123def456 schließen/i }).getAttribute('aria-expanded')).toBe('true');
      expect(getByTestId('redteam-scan-history')).toBeDefined();
    });

    const closeBtn = getByRole('button', { name: /verlauf für container abc123def456 schließen/i });
    await act(async () => { fireEvent.click(closeBtn); });

    await waitFor(() => {
      expect(queryByTestId('redteam-scan-history')).toBeNull();
    });
  });
});
