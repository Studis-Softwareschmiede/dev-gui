/**
 * RedTeamScanHistory.test.jsx — Tests für den „Verlauf"-Aufklapper pro Container
 * (docs/specs/red-team-scan-per-container.md AC14/AC15). Die Knopf-Verdrahtung in
 * `ContainerRow` (VpsView.jsx) ist in `RedTeamScanHistoryButton.test.jsx` abgedeckt
 * (Mount-Reachability, coder/R07) — dieser Test deckt NUR die isolierte
 * Komponenten-Logik (Liste laden/rendern, Detail-Klick, Board-Rückverfolgung) ab.
 *
 * @jest-environment jsdom
 *
 * Covers (red-team-scan-per-container):
 *   AC14 — Lädt `GET .../scans` sobald `open:true`; rendert je Lauf Zeitpunkt (formatiert),
 *          statischen Testort-Text ("Direkt + über Cloudflare" — jeder Lauf testet laut AC5
 *          immer beide Orte, s. Spec-Präzisierung S-404), Ampel-Textbadge (AMPEL_LABEL,
 *          wiederverwendet aus RedTeamScanPanel.jsx), Befund-Anzahl. Leer-/Fehler-/Lade-
 *          Zustand degradiert klar (kein Crash, `role="alert"`/`role="status"`). Klick auf
 *          eine Zeile lädt/rendert den Detailbericht (`GET .../scans/:scanId`) inline:
 *          Bericht-Link (`reportRef`) oder "Kein Bericht verfügbar", volle Findings-Liste.
 *   AC15 — Ein Verlaufseintrag mit nicht-leeren `boardItemIds` zeigt "daraus wurden N
 *          Punkte aufs Board gelegt — Status live vom Board" + je Board-ID den live via
 *          `GET /api/board/projects/:slug` gelesenen `status` (repoSlug kommt aus dem
 *          Detail-Endpunkt, `scan.repoSlug`). Fehlt `repoSlug` oder schlägt der
 *          Board-Projekt-Fetch fehl → "Status derzeit nicht verfügbar" statt Crash
 *          (Robustheit-NFR). Ein Eintrag ohne `boardItemIds` zeigt gar keine Zeile.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { RedTeamScanHistory } = await import('../RedTeamScanHistory.jsx');

const PROPS = { provider: 'hetzner', serverId: 'srv1', containerId: 'c1', containerLabel: 'app.example.com' };

function makeFetchFn({ scans = [], detailByScanId = {}, projectBySlug = {}, scansStatus = 200 } = {}) {
  const calls = [];
  const fn = jest.fn(async (url) => {
    calls.push(url);
    if (url.includes('/scans/') && !url.endsWith('/board')) {
      const scanId = decodeURIComponent(url.split('/scans/')[1]);
      const entry = detailByScanId[scanId];
      if (!entry) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      return { ok: true, status: 200, json: async () => ({ scan: entry }) };
    }
    if (url.endsWith('/scans')) {
      return { ok: scansStatus === 200, status: scansStatus, json: async () => ({ scans }) };
    }
    if (url.startsWith('/api/board/projects/')) {
      const slug = decodeURIComponent(url.split('/api/board/projects/')[1]);
      const project = projectBySlug[slug];
      if (!project) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      return { ok: true, status: 200, json: async () => ({ project }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  });
  fn.calls = calls;
  return fn;
}

function renderHistory(fetchFn, extra = {}) {
  return render(React.createElement(RedTeamScanHistory, { ...PROPS, open: true, fetchFn, ...extra }));
}

// ── AC14 — Liste laden/rendern ──────────────────────────────────────────────────

describe('RedTeamScanHistory — AC14: Verlaufsliste', () => {
  it('geschlossen (open:false): rendert nichts, kein Fetch', async () => {
    const fetchFn = makeFetchFn();
    const { container } = renderHistory(fetchFn, { open: false });
    await act(async () => {});
    expect(container.querySelector('[data-testid="redteam-scan-history"]')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('lädt beim Öffnen die Liste und zeigt Zeitpunkt/Testort/Ampel/Anzahl je Lauf', async () => {
    const fetchFn = makeFetchFn({
      scans: [
        { scanId: 'scan-1', startedAt: '2026-07-20T10:00:00.000Z', ampel: 'rot', findingCount: 3, boardItemIds: [] },
      ],
    });
    const { getByTestId, getByText } = renderHistory(fetchFn);
    await waitFor(() => expect(getByTestId('redteam-history-list')).toBeDefined());

    expect(getByText('Direkt + über Cloudflare')).toBeDefined();
    expect(getByText('3 Befunde')).toBeDefined();
    expect(getByText(/Rot — kritische Befunde/)).toBeDefined();
  });

  it('leere Liste → "Noch keine Läufe."', async () => {
    const fetchFn = makeFetchFn({ scans: [] });
    const { getByTestId } = renderHistory(fetchFn);
    await waitFor(() => expect(getByTestId('redteam-history-empty')).toBeDefined());
  });

  it('Nicht-200 beim Laden der Liste → role="alert"-Fehlertext, kein Crash', async () => {
    const fetchFn = makeFetchFn({ scansStatus: 500 });
    const { getByTestId } = renderHistory(fetchFn);
    await waitFor(() => expect(getByTestId('redteam-history-error')).toBeDefined());
  });

  it('Klick auf eine Zeile lädt und zeigt den Detailbericht inline (Bericht-Link + Findings)', async () => {
    const fetchFn = makeFetchFn({
      scans: [{ scanId: 'scan-1', startedAt: '2026-07-20T10:00:00.000Z', ampel: 'gelb', findingCount: 1, boardItemIds: [] }],
      detailByScanId: {
        'scan-1': {
          scanId: 'scan-1',
          app: 'app.example.com',
          repoSlug: null,
          findings: [{ id: 'f1', severity: 'medium', kind: 'xss', testort: 'direkt', titel: 'XSS gefunden' }],
          reportRef: 'https://example.com/report/1',
          boardItemIds: [],
        },
      },
    });
    const { getByTestId, getByRole } = renderHistory(fetchFn);
    await waitFor(() => expect(getByTestId('redteam-history-row-scan-1')).toBeDefined());

    await act(async () => { fireEvent.click(getByTestId('redteam-history-row-scan-1')); });

    await waitFor(() => expect(getByTestId('redteam-history-report-link-scan-1')).toBeDefined());
    expect(getByRole('link', { name: /Vollen Bericht öffnen/i }).getAttribute('href')).toBe('https://example.com/report/1');
    expect(getByTestId('redteam-history-detail-scan-1').textContent).toMatch(/XSS gefunden/);
  });

  it('Detailbericht ohne reportRef → "Kein Bericht verfügbar."', async () => {
    const fetchFn = makeFetchFn({
      scans: [{ scanId: 'scan-1', startedAt: '2026-07-20T10:00:00.000Z', ampel: 'gruen', findingCount: 0, boardItemIds: [] }],
      detailByScanId: {
        'scan-1': { scanId: 'scan-1', app: 'app.example.com', repoSlug: null, findings: [], reportRef: null, boardItemIds: [] },
      },
    });
    const { getByTestId } = renderHistory(fetchFn);
    await waitFor(() => expect(getByTestId('redteam-history-row-scan-1')).toBeDefined());
    await act(async () => { fireEvent.click(getByTestId('redteam-history-row-scan-1')); });
    await waitFor(() => expect(getByTestId('redteam-history-no-report-scan-1')).toBeDefined());
  });
});

// ── AC15 — Board-Rückverfolgung (live) ──────────────────────────────────────────

describe('RedTeamScanHistory — AC15: Board-Rückverfolgung live', () => {
  it('ohne boardItemIds: keine Rückverfolgungs-Zeile', async () => {
    const fetchFn = makeFetchFn({
      scans: [{ scanId: 'scan-1', startedAt: '2026-07-20T10:00:00.000Z', ampel: 'gruen', findingCount: 0, boardItemIds: [] }],
    });
    const { getByTestId, queryByTestId } = renderHistory(fetchFn);
    await waitFor(() => expect(getByTestId('redteam-history-row-scan-1')).toBeDefined());
    expect(queryByTestId('redteam-history-board-trace-scan-1')).toBeNull();
  });

  it('mit boardItemIds: zeigt "N Punkte aufs Board gelegt" + live gelesenen Status je ID', async () => {
    const fetchFn = makeFetchFn({
      scans: [
        { scanId: 'scan-1', startedAt: '2026-07-20T10:00:00.000Z', ampel: 'rot', findingCount: 2, boardItemIds: ['S-500', 'S-501'] },
      ],
      detailByScanId: {
        'scan-1': {
          scanId: 'scan-1', app: 'app.example.com', repoSlug: 'demo-repo', findings: [], reportRef: null,
          boardItemIds: ['S-500', 'S-501'],
        },
      },
      projectBySlug: {
        'demo-repo': {
          slug: 'demo-repo',
          features: [
            { id: 'F-1', stories: [{ id: 'S-500', status: 'Done' }, { id: 'S-501', status: 'In Progress' }] },
          ],
        },
      },
    });
    const { getByTestId } = renderHistory(fetchFn);

    await waitFor(() => {
      const el = getByTestId('redteam-history-board-trace-scan-1');
      expect(el.textContent).toMatch(/daraus wurden 2 Punkte aufs Board gelegt/);
      expect(el.textContent).toMatch(/S-500 \(Done\)/);
      expect(el.textContent).toMatch(/S-501 \(In Progress\)/);
    });
  });

  it('fehlender repoSlug am Scan → "Status derzeit nicht verfügbar" statt Crash', async () => {
    const fetchFn = makeFetchFn({
      scans: [{ scanId: 'scan-1', startedAt: '2026-07-20T10:00:00.000Z', ampel: 'rot', findingCount: 1, boardItemIds: ['S-500'] }],
      detailByScanId: {
        'scan-1': { scanId: 'scan-1', app: 'app.example.com', repoSlug: null, findings: [], reportRef: null, boardItemIds: ['S-500'] },
      },
    });
    const { getByTestId } = renderHistory(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-history-board-trace-scan-1').textContent).toMatch(/Status derzeit nicht verfügbar/);
    });
  });

  it('Board-Projekt-Fetch schlägt fehl (Nicht-200) → "Status derzeit nicht verfügbar" statt Crash', async () => {
    const fetchFn = makeFetchFn({
      scans: [{ scanId: 'scan-1', startedAt: '2026-07-20T10:00:00.000Z', ampel: 'rot', findingCount: 1, boardItemIds: ['S-500'] }],
      detailByScanId: {
        'scan-1': { scanId: 'scan-1', app: 'app.example.com', repoSlug: 'missing-repo', findings: [], reportRef: null, boardItemIds: ['S-500'] },
      },
      projectBySlug: {},
    });
    const { getByTestId } = renderHistory(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-history-board-trace-scan-1').textContent).toMatch(/Status derzeit nicht verfügbar/);
    });
  });
});
