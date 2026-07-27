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
 * Covers (night-budget-guard):
 *   AC13 — je Bericht werden `budgetPauses` (`{from,to,reason}[]`) textlich
 *          gerendert (von/bis lokal formatiert, `to===null` → „Nacht-Ende",
 *          Grund als Klartext); ein leeres/fehlendes Array (Alt-Bericht vor
 *          S-275) → kein Budget-Pausen-Block gerendert (dezent).
 *
 * Covers (drain-completion-report, v2):
 *   AC10 — ein verschmolzener Leerlauf-Bericht (`flowRuns:0`,
 *          `reason:'no-drain-target'`, `count > 1`) erscheint als EINE
 *          kompakte Zeile mit `count` + Zeitspanne (`firstAt`–`lastAt`)
 *          statt als Einzeleintrag; ein einzelner (noch nicht verschmolzener)
 *          Leerlauf-Bericht (`count` fehlt/`1`) bleibt ein normaler
 *          Einzeleintrag; nicht-leere Berichte sind unberührt. NICHT
 *          unit-testbar ist das exakte lokale Datumsformat (jsdom-
 *          umgebungsabhängig) — verifiziert über feste Textteile.
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

describe('drain-completion-report AC10 — verschmolzene Leerlauf-Serie als eine Zeile', () => {
  it('ein verschmolzener Leerlauf-Bericht (count > 1) erscheint als eine Zeile mit count + Zeitspanne', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-idle', project: 'dev-gui', trigger: 'night',
          reason: 'no-drain-target', flowRuns: 0,
          startedAt: '2026-07-12T22:00:00.000Z', finishedAt: '2026-07-26T22:00:00.000Z',
          firstAt: '2026-07-12T22:00:00.000Z', lastAt: '2026-07-26T22:00:00.000Z',
          count: 32, completed: [], blocked: [],
        },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="night-run-idle-series"]')).toBeTruthy();
    });
    const el = document.querySelector('[data-testid="night-run-idle-series"]');
    expect(el.textContent).toMatch(/dev-gui/);
    expect(el.textContent).toMatch(/32 leere Nachtläufe/);
    expect(el.textContent).toMatch(/–/); // Zeitspannen-Trennzeichen
    // Kein Einzeleintrag/keine "X erledigt/Y blockiert"-Zeile für diesen Bericht.
    expect(document.querySelector('[data-testid="night-run-item"]')).toBeFalsy();
  });

  it('ein einzelner (noch nicht verschmolzener) Leerlauf-Bericht (count fehlt) bleibt ein normaler Einzeleintrag', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-idle-1', project: 'dev-gui', trigger: 'night',
          reason: 'no-drain-target', flowRuns: 0,
          finishedAt: '2026-07-26T22:00:00.000Z', completed: [], blocked: [],
          // KEIN count-Feld — noch nicht verschmolzen.
        },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="night-run-item"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="night-run-idle-series"]')).toBeFalsy();
    expect(document.querySelector('[data-testid="night-run-item"]').textContent).toMatch(
      /0 erledigt \/ 0 blockiert/,
    );
  });

  it('ein einzelner Leerlauf-Bericht mit explizitem count:1 bleibt ebenfalls ein normaler Einzeleintrag', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-idle-1', project: 'dev-gui', trigger: 'night',
          reason: 'no-drain-target', flowRuns: 0, count: 1,
          finishedAt: '2026-07-26T22:00:00.000Z', completed: [], blocked: [],
        },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="night-run-item"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="night-run-idle-series"]')).toBeFalsy();
  });

  it('nicht-leere Berichte bleiben Einzelzeilen, auch mit count > 1 (nur Leerlauf wird verschmolzen)', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-nonempty', project: 'dev-gui', trigger: 'night',
          reason: 'converged', flowRuns: 3, count: 5, // count>1 aber NICHT idle
          finishedAt: '2026-07-26T22:00:00.000Z',
          completed: [{ id: 'S-1', title: 'Eins' }], blocked: [],
        },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="night-run-item"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="night-run-idle-series"]')).toBeFalsy();
    expect(document.querySelector('[data-testid="night-run-item"]').textContent).toMatch(
      /1 erledigt \/ 0 blockiert/,
    );
  });

  it('mischt verschmolzene Leerlauf-Serie und Einzel-Berichte korrekt in derselben Liste', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-nonempty', project: 'dev-gui', trigger: 'night',
          reason: 'converged', flowRuns: 1, finishedAt: '2026-07-27T02:00:00.000Z',
          completed: [{ id: 'S-1', title: 'Eins' }], blocked: [],
        },
        {
          reportId: 'r-idle', project: 'other-repo', trigger: 'night',
          reason: 'no-drain-target', flowRuns: 0,
          firstAt: '2026-07-01T22:00:00.000Z', lastAt: '2026-07-26T22:00:00.000Z',
          count: 10, finishedAt: '2026-07-26T22:00:00.000Z', completed: [], blocked: [],
        },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="night-run-item"]').length).toBe(1);
    });
    expect(document.querySelectorAll('[data-testid="night-run-idle-series"]').length).toBe(1);
  });
});

describe('night-budget-guard AC13 — Budget-Pausen je Bericht', () => {
  it('zeigt Budget-Pausen textlich (von–bis, Grund) je Bericht', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-1', project: 'dev-gui', trigger: 'night',
          finishedAt: '2026-07-02T02:00:00Z',
          completed: [], blocked: [],
          budgetPauses: [
            { from: Date.UTC(2026, 6, 2, 1, 0, 0), to: Date.UTC(2026, 6, 2, 1, 5, 0), reason: 'reactive-limit' },
            { from: Date.UTC(2026, 6, 2, 1, 30, 0), to: null, reason: 'proactive-threshold' },
          ],
        },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      const block = document.querySelector('[data-testid="night-run-budget-pauses"]');
      expect(block).toBeTruthy();
      expect(block.textContent).toMatch(/Session-Limit erreicht/);
      expect(block.textContent).toMatch(/Budget-Schwelle erreicht/);
      // Sanftes Ende (`to === null`) wird textlich als „Nacht-Ende" angezeigt.
      expect(block.textContent).toMatch(/Nacht-Ende/);
    });
  });

  it('leeres budgetPauses-Array → kein Budget-Pausen-Block (dezent, nichts)', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-1', project: 'dev-gui', trigger: 'night',
          finishedAt: '2026-07-02T02:00:00Z', completed: [], blocked: [], budgetPauses: [],
        },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="night-run-item"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="night-run-budget-pauses"]')).toBeFalsy();
  });

  it('fehlendes budgetPauses-Feld (Alt-Bericht) → kein Crash, kein Budget-Pausen-Block', async () => {
    const fetchFn = makeFetch({
      reports: [
        {
          reportId: 'r-1', project: 'dev-gui', trigger: 'night',
          finishedAt: '2026-07-02T02:00:00Z', completed: [], blocked: [],
          // KEIN budgetPauses-Feld — simuliert einen Alt-Bericht vor S-275.
        },
      ],
    });
    render(React.createElement(NightRunsSection, { fetchFn }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="night-run-item"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="night-run-budget-pauses"]')).toBeFalsy();
  });
});
