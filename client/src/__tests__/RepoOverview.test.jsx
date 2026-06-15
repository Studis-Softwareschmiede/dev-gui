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
