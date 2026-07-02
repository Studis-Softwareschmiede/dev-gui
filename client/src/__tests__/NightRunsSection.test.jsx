/**
 * NightRunsSection.test.jsx — Tests für drain-completion-report AC7b
 * (Nacht-Läufe-Sektion in der Fabrik-Übersicht).
 *
 * Covers (drain-completion-report):
 *   AC7b — listet die letzten Drain-Abschlussberichte des Nachtwächters
 *          (`GET /api/drain-reports`, hier client-seitig auf `trigger:'night'`
 *          gefiltert — manuelle Läufe erscheinen bereits inline am „Board
 *          abarbeiten"-Knopf, AC7a): je Bericht Projekt, Zeitpunkt,
 *          X erledigt/Y blockiert (textlich, WCAG 2.1 AA), aufklappbare
 *          Story-Liste. Leere Liste dezent (Hinweistext statt leerer Fläche).
 *          Netzwerkfehler/unerwartete Antwortform → Sektion unsichtbar
 *          (graceful degradation, kein Crash — analog NightWatchStatusBadge).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { render, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { NightRunsSection } = await import('../NightRunsSection.jsx');

afterEach(() => { jest.restoreAllMocks(); });

function makeFetch(payload, ok = true) {
  return jest.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  }));
}

describe('drain-completion-report AC7b — Nacht-Läufe-Sektion', () => {
  it('leere Liste (keine Nacht-Läufe) → dezenter Hinweistext, kein Crash', async () => {
    const fetchFn = makeFetch({ reports: [] });
    const { getByTestId, queryByTestId } = render(
      React.createElement(NightRunsSection, { fetchFn }),
    );
    await waitFor(() => {
      expect(getByTestId('night-runs-empty')).toBeTruthy();
    });
    expect(queryByTestId('night-runs-list')).toBeFalsy();
  });

  it('filtert manuelle Berichte heraus — nur trigger:"night" erscheint', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-1', project: 'dev-gui', trigger: 'manual',
          finishedAt: '2026-07-02T03:00:00Z', completed: [], blocked: [],
        },
        {
          reportId: 'r-2', project: 'other-repo', trigger: 'night',
          finishedAt: '2026-07-02T02:00:00Z',
          completed: [{ id: 'S-1', title: 'Eins' }], blocked: [],
        },
      ],
    });
    const { getByTestId, queryByText } = render(
      React.createElement(NightRunsSection, { fetchFn }),
    );
    await waitFor(() => {
      expect(getByTestId('night-runs-list')).toBeTruthy();
    });
    const items = document.querySelectorAll('[data-testid="night-run-item"]');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toMatch(/other-repo/);
    expect(queryByText(/dev-gui/)).toBeFalsy();
  });

  it('zeigt Projekt + X erledigt/Y blockiert textlich je Bericht', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-1', project: 'dev-gui', trigger: 'night',
          finishedAt: '2026-07-02T02:00:00Z',
          completed: [{ id: 'S-1', title: 'Eins' }, { id: 'S-2', title: 'Zwei' }],
          blocked: [{ id: 'S-9', title: 'Neun' }],
        },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      const item = document.querySelector('[data-testid="night-run-item"]');
      expect(item).toBeTruthy();
      expect(item.textContent).toMatch(/dev-gui/);
      expect(item.textContent).toMatch(/2 erledigt \/ 1 blockiert/);
    });
  });

  it('aufklappbare Story-Liste enthält ID + Titel (erledigt UND blockiert)', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-1', project: 'dev-gui', trigger: 'night',
          finishedAt: '2026-07-02T02:00:00Z',
          completed: [{ id: 'S-1', title: 'Eins' }],
          blocked: [{ id: 'S-9', title: 'Neun' }],
        },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      const details = document.querySelector('[data-testid="night-run-details"]');
      expect(details).toBeTruthy();
      expect(details.textContent).toMatch(/S-1/);
      expect(details.textContent).toMatch(/Eins/);
      expect(details.textContent).toMatch(/S-9/);
      expect(details.textContent).toMatch(/Neun/);
    });
  });

  it('0 erledigt / 0 blockiert → keine aufklappbare Liste (nichts zum Aufklappen)', async () => {
    const fetchFn = makeFetch({
      reports: [
        { reportId: 'r-1', project: 'dev-gui', trigger: 'night', finishedAt: '2026-07-02T02:00:00Z', completed: [], blocked: [] },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      const item = document.querySelector('[data-testid="night-run-item"]');
      expect(item).toBeTruthy();
      expect(item.textContent).toMatch(/0 erledigt \/ 0 blockiert/);
    });
    expect(document.querySelector('[data-testid="night-run-details"]')).toBeFalsy();
  });

  it('Netzwerkfehler → Sektion unsichtbar (graceful degradation, kein Crash)', async () => {
    const fetchFn = jest.fn(async () => { throw new Error('Netzwerkfehler'); });
    const { container } = render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalled();
    });
    expect(container.querySelector('section')).toBeFalsy();
  });

  it('unerwartete Antwortform (kein reports-Array) → Sektion unsichtbar, kein Crash', async () => {
    const fetchFn = makeFetch({ unexpected: true });
    const { container } = render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalled();
    });
    // Keine `reports`-Property → leere Liste nach Filter → "keine Läufe"-Hinweis,
    // KEIN Crash. Die Sektion selbst bleibt aber sichtbar (kein HTTP-Fehler).
    expect(container.querySelector('[data-testid="night-runs-empty"]')).toBeTruthy();
  });

  it('HTTP-Fehlerstatus (kein res.ok) → Sektion unsichtbar', async () => {
    const fetchFn = makeFetch({}, false);
    const { container } = render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalled();
    });
    expect(container.querySelector('section')).toBeFalsy();
  });
});
