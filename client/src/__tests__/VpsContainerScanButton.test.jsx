/**
 * VpsContainerScanButton.test.jsx — Tests für den Red-Team-Scan-Knopf in
 * `VpsView.jsx` `ContainerRow` (docs/specs/red-team-scan-per-container.md AC10, AC21).
 * Die Panel-eigene Poll-/Ergebnis-/Fehler-Logik ist in `RedTeamScanPanel.test.jsx`
 * abgedeckt (AC11/AC12/AC13) — dieser Test deckt NUR die Knopf-Verdrahtung
 * (Sichtbarkeit/Sperre/Öffnen-des-Panels) ab.
 *
 * @jest-environment jsdom
 *
 * Covers (red-team-scan-per-container):
 *   AC10 — „Red-Team-Scan"-Knopf NUR für managed+laufende Container aktiv (sonst
 *          disabled mit Begründung); Klick öffnet sofort das Live-Panel und sperrt den
 *          Knopf (Spinner-Text + `aria-busy`); ein zweiter Klick ist wirkungslos, solange
 *          das Panel offen ist (kein zweiter POST).
 *   AC21 — kein zusätzlicher Rollen-Check am Knopf (Knopf ist für jeden mit Zugriff auf
 *          die Ansicht aktiv, sofern managed+laufend — keine feinere Gate-Prüfung nötig).
 *
 * Covers (red-team-scan-access-token, S-407):
 *   AC2 — „Hinter der Wall"-Checkbox neben dem Scan-Knopf; angehakt → POST-Body enthält
 *         `{ hinterWall: true }`; Default (nicht angehakt) → `{ hinterWall: false }`.
 *   AC4 — Checkbox ist disabled (mit `title`-Begründung) solange kein vollständiges
 *         Cloudflare-Access-Service-Token hinterlegt ist (`GET /api/settings/credentials`,
 *         wiederverwendeter generischer Endpunkt); mit Token aktivierbar.
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

function makeFetch({
  containers = [MANAGED_RUNNING],
  scanStartStatus = 202,
  scanStartBody = { jobId: 'scan-job-1' },
  scanPollBody = { status: 'running', phase: 'direkt' },
  hasAccessToken = false,
} = {}) {
  const scanPostCalls = [];
  const fn = jest.fn(async (url, opts = {}) => {
    if (url === '/api/settings/ssh-keys') return { ok: true, json: async () => SSH_LABELS };
    if (url === '/api/vps/providers') return { ok: true, json: async () => PROVIDERS };
    // red-team-scan-access-token AC1/AC4 (S-407): generischer Credential-Status-Endpunkt,
    // wiederverwendet von `ContainerOverview` zur Bestimmung von `hasAccessToken`.
    if (url === '/api/settings/credentials') {
      return {
        ok: true,
        json: async () => (hasAccessToken
          ? [
            { integration: 'cloudflare-access-service-token', name: 'client_id', status: 'set' },
            { integration: 'cloudflare-access-service-token', name: 'client_secret', status: 'set' },
          ]
          : [
            { integration: 'cloudflare-access-service-token', name: 'client_id', status: 'unset' },
            { integration: 'cloudflare-access-service-token', name: 'client_secret', status: 'unset' },
          ]),
      };
    }
    if (url === '/api/vps/machines' && (!opts.method || opts.method === 'GET')) {
      return { ok: true, json: async () => ({ machines: [MACHINE] }) };
    }
    if (url.endsWith('/containers') && (!opts?.method || opts.method === 'GET')) {
      return { ok: true, json: async () => ({ result: 'ok', containers }) };
    }
    if (opts?.method === 'POST' && url.endsWith('/scan')) {
      let body = {};
      try { body = JSON.parse(opts.body ?? '{}'); } catch { /* ignore */ }
      scanPostCalls.push({ url, body });
      return { ok: scanStartStatus === 202, status: scanStartStatus, json: async () => scanStartBody };
    }
    if ((!opts?.method || opts.method === 'GET') && url.includes('/scan/')) {
      return { ok: true, status: 200, json: async () => scanPollBody };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  });
  fn.scanPostCalls = scanPostCalls;
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

// ── AC10 — Sichtbarkeit/Sperre ─────────────────────────────────────────────────

describe('VpsContainerScanButton — AC10: Knopf-Aktivierung', () => {
  it('managed + laufender Container: Scan-Knopf ist aktiv', async () => {
    const fetchMock = makeFetch({ containers: [MANAGED_RUNNING] });
    const { getByRole } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /red-team-scan für container abc123def456/i })).toBeDefined();
    });
    const scanBtn = getByRole('button', { name: /red-team-scan für container abc123def456/i });
    expect(scanBtn.disabled).toBe(false);
  });

  it('managed + gestoppter Container: Scan-Knopf ist disabled mit Begründung', async () => {
    const fetchMock = makeFetch({ containers: [MANAGED_STOPPED] });
    const { getByRole } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /red-team-scan für container stopped1/i })).toBeDefined();
    });
    const scanBtn = getByRole('button', { name: /red-team-scan für container stopped1/i });
    expect(scanBtn.disabled).toBe(true);
    expect(scanBtn.title).toBeTruthy();
  });

  it('unmanaged + laufender Container: Scan-Knopf ist disabled', async () => {
    const fetchMock = makeFetch({ containers: [UNMANAGED_RUNNING] });
    const { getByRole } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /red-team-scan für container unmanaged1/i })).toBeDefined();
    });
    const scanBtn = getByRole('button', { name: /red-team-scan für container unmanaged1/i });
    expect(scanBtn.disabled).toBe(true);
  });
});

describe('VpsContainerScanButton — AC10: Klick öffnet Panel + sperrt Knopf', () => {
  it('Klick startet den Scan (POST .../scan) und zeigt sofort "läuft"-Zustand', async () => {
    const fetchMock = makeFetch({ containers: [MANAGED_RUNNING] });
    const { getByRole, getByTestId } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /red-team-scan für container abc123def456/i })).toBeDefined();
    });
    const scanBtn = getByRole('button', { name: /red-team-scan für container abc123def456/i });

    await act(async () => { fireEvent.click(scanBtn); });

    // Panel öffnet sofort (AC11).
    await waitFor(() => expect(getByTestId('redteam-scan-panel')).toBeDefined());
    // Knopf ist gesperrt + zeigt Spinner-Text (AC10).
    expect(scanBtn.disabled).toBe(true);
    expect(scanBtn.getAttribute('aria-busy')).toBe('true');
    expect(scanBtn.textContent).toMatch(/Scan läuft/);

    await waitFor(() => {
      expect(fetchMock.scanPostCalls.map((c) => c.url)).toEqual(['/api/vps/machines/hetzner/1/containers/abc123def456/scan']);
    });
  });

  it('ein zweiter Klick während das Panel offen ist löst KEINEN zweiten Start aus (Client-Sperre)', async () => {
    const fetchMock = makeFetch({ containers: [MANAGED_RUNNING] });
    const { getByRole, getByTestId } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /red-team-scan für container abc123def456/i })).toBeDefined();
    });
    const scanBtn = getByRole('button', { name: /red-team-scan für container abc123def456/i });

    await act(async () => { fireEvent.click(scanBtn); });
    await waitFor(() => expect(getByTestId('redteam-scan-panel')).toBeDefined());

    // Knopf ist disabled → ein weiterer Klick löst im DOM keinen Handler aus.
    await act(async () => { fireEvent.click(scanBtn); });

    await waitFor(() => {
      expect(fetchMock.scanPostCalls).toHaveLength(1);
    });
  });

  it('nach Abschluss (done) + Schließen kann ein neuer Scan gestartet werden', async () => {
    const fetchMock = makeFetch({
      containers: [MANAGED_RUNNING],
      scanPollBody: { status: 'done', phase: 'fertig', ampel: 'gruen', findings: [] },
    });
    const { getByRole, getByTestId } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /red-team-scan für container abc123def456/i })).toBeDefined();
    });
    const scanBtn = getByRole('button', { name: /red-team-scan für container abc123def456/i });
    await act(async () => { fireEvent.click(scanBtn); });

    await waitFor(() => expect(getByTestId('redteam-scan-result')).toBeDefined());
    // Panel bleibt sichtbar bis zum expliziten Schließen (AC12/AC13: kein leerer Endzustand).
    expect(scanBtn.disabled).toBe(true);

    await act(async () => { fireEvent.click(getByTestId('redteam-scan-close-btn')); });

    expect(scanBtn.disabled).toBe(false);
    expect(scanBtn.textContent).toBe('Red-Team-Scan');
  });
});

// ── red-team-scan-access-token AC2/AC4 — "Hinter der Wall"-Checkbox (S-407) ────────────

describe('VpsContainerScanButton — red-team-scan-access-token AC2/AC4: "Hinter der Wall"-Checkbox', () => {
  it('AC4: ohne hinterlegtes Token ist die Checkbox disabled mit Begründung im title', async () => {
    const fetchMock = makeFetch({ containers: [MANAGED_RUNNING], hasAccessToken: false });
    const { getByRole } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    const checkbox = await waitFor(() => getByRole('checkbox', {
      name: /red-team-scan für container abc123def456 hinter der access-wall ausführen/i,
    }));
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.closest('label').title).toBeTruthy();
  });

  it('AC4: mit hinterlegtem Token ist die Checkbox aktivierbar', async () => {
    const fetchMock = makeFetch({ containers: [MANAGED_RUNNING], hasAccessToken: true });
    const { getByRole } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    const checkbox = await waitFor(() => getByRole('checkbox', {
      name: /red-team-scan für container abc123def456 hinter der access-wall ausführen/i,
    }));
    expect(checkbox.disabled).toBe(false);
  });

  it('AC2: Checkbox angehakt + Scan gestartet → POST-Body enthält { hinterWall: true }', async () => {
    const fetchMock = makeFetch({ containers: [MANAGED_RUNNING], hasAccessToken: true });
    const { getByRole } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    const checkbox = await waitFor(() => getByRole('checkbox', {
      name: /red-team-scan für container abc123def456 hinter der access-wall ausführen/i,
    }));
    await act(async () => { fireEvent.click(checkbox); });
    expect(checkbox.checked).toBe(true);

    const scanBtn = getByRole('button', { name: /red-team-scan für container abc123def456/i });
    await act(async () => { fireEvent.click(scanBtn); });

    await waitFor(() => {
      expect(fetchMock.scanPostCalls).toHaveLength(1);
      expect(fetchMock.scanPostCalls[0].body).toEqual({ hinterWall: true });
    });
  });

  it('AC4: Checkbox NICHT angehakt (Default) → POST-Body enthält { hinterWall: false }', async () => {
    const fetchMock = makeFetch({ containers: [MANAGED_RUNNING], hasAccessToken: true });
    const { getByRole } = await renderVpsView(fetchMock);
    await openContainerOverview(getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /red-team-scan für container abc123def456/i })).toBeDefined();
    });
    const scanBtn = getByRole('button', { name: /red-team-scan für container abc123def456/i });
    await act(async () => { fireEvent.click(scanBtn); });

    await waitFor(() => {
      expect(fetchMock.scanPostCalls).toHaveLength(1);
      expect(fetchMock.scanPostCalls[0].body).toEqual({ hinterWall: false });
    });
  });
});
