/**
 * RepoOverview.test.jsx — Regression: lastCommit ist ein Objekt {hash,subject,date}
 * (oder null bei Worktrees/leeren Repos), NICHT ein String. Frühere Version
 * renderte {lastCommit ?? '—'} direkt → React-Crash „Objects are not valid as a
 * React child" → schwarzer Screen beim Fabrik-Einstieg.
 *
 * Covers (projekt-cockpit-navigation):
 *   AC1 — Repo-Übersicht rendert lokale Klone (Name/Branch/dirty/letzter Commit)
 *          robust, auch wenn lastCommit ein Objekt oder null ist (kein Crash).
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC17 — kompakte Statusanzeige (NightWatchStatusBadge) in der Header-Zeile:
 *          aktiv+Fenster+im/außerhalb-Fenster-Text, pausiert-Text, laufende
 *          Drains angehängt; unsichtbar bei Fehler/unerwarteter Antwortform
 *          (graceful degradation, kein Crash).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { RepoOverview } = await import('../RepoOverview.jsx');

const REPOS = [
  {
    name: 'dev-gui',
    branch: 'main',
    dirty: false,
    lastCommit: { hash: 'abc1234', subject: 'feat: etwas Sinnvolles', date: '2026-06-15T12:00:00Z' },
    originUrl: 'https://github.com/org/dev-gui.git',
  },
  {
    // Worktree / leeres Repo — git-Felder null (genau der Crash-Auslöser in prod)
    name: 'dev-gui-99-worktree',
    branch: null,
    dirty: false,
    lastCommit: null,
    originUrl: null,
  },
];

function mockFetchOnce(payload, ok = true) {
  globalThis.fetch = jest.fn(() =>
    Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(payload) }),
  );
}

describe('RepoOverview — lastCommit-Objekt/null robust (kein Crash)', () => {
  beforeEach(() => { mockFetchOnce({ repos: REPOS }); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('rendert Repos mit lastCommit-Objekt UND null ohne zu crashen', async () => {
    const { getByText, queryAllByLabelText } = render(
      React.createElement(RepoOverview, { navigateFactory: () => {} }),
    );

    // Beide Repos erscheinen
    await waitFor(() => expect(getByText('dev-gui')).toBeTruthy());
    expect(getByText('dev-gui-99-worktree')).toBeTruthy();

    // Objekt-lastCommit wird als "hash · subject" gerendert (nicht [object Object])
    expect(getByText(/abc1234 · feat: etwas Sinnvolles/)).toBeTruthy();

    // null-lastCommit fällt auf '—' zurück; nichts wirft
    const commitLabels = queryAllByLabelText(/Letzter Commit:/);
    expect(commitLabels.length).toBe(2);
    expect(commitLabels.some((el) => el.getAttribute('aria-label') === 'Letzter Commit: —')).toBe(true);
  });
});

// ── AC17 (taktgeber-nachtwaechter): NightWatchStatusBadge in der Header-Zeile ────

/**
 * URL-routender Fetch-Mock: /api/workspace/repos → REPOS; /api/settings/ticker/status →
 * `statusResponse` (injizierbar je Test).
 */
function makeFetch(statusResponse) {
  return jest.fn(async (url) => {
    if (url === '/api/settings/ticker/status') {
      if (statusResponse === 'reject') throw new Error('Netzwerkfehler');
      if (statusResponse === 'malformed') {
        return { ok: true, status: 200, json: async () => ({ repos: [] }) };
      }
      return { ok: true, status: 200, json: async () => statusResponse };
    }
    return { ok: true, status: 200, json: async () => ({ repos: REPOS }) };
  });
}

describe('RepoOverview — AC17: NightWatchStatusBadge (taktgeber-nachtwaechter)', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('enabled=true, im Fenster, keine aktiven Drains → Text zeigt Fenster + "im Fenster"', async () => {
    globalThis.fetch = makeFetch({
      enabled: true,
      window: { start: '23:00', end: '07:00', timezone: 'Europe/Zurich' },
      withinWindow: true,
      activeDrains: 0,
    });
    const { getByRole } = render(
      React.createElement(RepoOverview, { navigateFactory: () => {} }),
    );
    await waitFor(() => {
      const badge = getByRole('status', { name: /nachtwächter: aktiv/i });
      expect(badge.textContent).toMatch(/23:00–07:00/);
      expect(badge.textContent).toMatch(/im Fenster/);
      expect(badge.textContent).not.toMatch(/Drain/);
    });
  });

  it('enabled=true, außerhalb Fenster + 2 laufende Drains → Text zeigt "außerhalb Fenster" + Drain-Anzahl', async () => {
    globalThis.fetch = makeFetch({
      enabled: true,
      window: { start: '23:00', end: '07:00', timezone: 'Europe/Zurich' },
      withinWindow: false,
      activeDrains: 2,
    });
    const { getByRole } = render(
      React.createElement(RepoOverview, { navigateFactory: () => {} }),
    );
    await waitFor(() => {
      const badge = getByRole('status', { name: /nachtwächter: aktiv/i });
      expect(badge.textContent).toMatch(/außerhalb Fenster/);
      expect(badge.textContent).toMatch(/2 Drains aktiv/);
    });
  });

  it('enabled=false → Text "Nachtwächter: pausiert" (kein Fenster-Detail)', async () => {
    globalThis.fetch = makeFetch({
      enabled: false,
      window: { start: '23:00', end: '07:00', timezone: 'Europe/Zurich' },
      withinWindow: false,
      activeDrains: 0,
    });
    const { getByRole } = render(
      React.createElement(RepoOverview, { navigateFactory: () => {} }),
    );
    await waitFor(() => {
      expect(getByRole('status', { name: /nachtwächter: pausiert/i })).toBeTruthy();
    });
  });

  it('Status-Endpunkt nicht erreichbar (Netzwerkfehler) → keine Badge, kein Crash', async () => {
    globalThis.fetch = makeFetch('reject');
    const { getByText, queryByRole } = render(
      React.createElement(RepoOverview, { navigateFactory: () => {} }),
    );
    // Restliche Ansicht bleibt funktionsfähig (Repos laden weiterhin — separater fetch-Call).
    await waitFor(() => expect(getByText('dev-gui')).toBeTruthy());
    expect(queryByRole('status', { name: /nachtwächter/i })).toBeNull();
  });

  it('unerwartete Antwortform (kein enabled-Feld) → keine Badge, kein Crash', async () => {
    globalThis.fetch = makeFetch('malformed');
    const { getByText, queryByRole } = render(
      React.createElement(RepoOverview, { navigateFactory: () => {} }),
    );
    await waitFor(() => expect(getByText('dev-gui')).toBeTruthy());
    expect(queryByRole('status', { name: /nachtwächter/i })).toBeNull();
  });
});
