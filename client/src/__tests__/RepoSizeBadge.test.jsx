/**
 * RepoSizeBadge.test.jsx
 *
 * Covers (repo-size-badge):
 *   AC9  — menschenlesbares Gesamt-Größen-Badge (MB/GB) mit letztem bekanntem
 *          Wert + Alter (relativ im Text, absoluter Zeitstempel im `title`);
 *          nie vermessen → neutraler Platzhalter; Ladefehler blockiert das
 *          Rendern nie (Platzhalter bleibt sichtbar, kein Crash).
 *   AC10 — Aufschlüsselung (Arbeitsstand | .git | Abhängigkeiten/Artefakte,
 *          Summe = Gesamt) über <details>/<summary>; Aktualisieren-Button
 *          ruft POST /api/workspace/repo-sizes/refresh mit { repo } und
 *          spiegelt "läuft"/"aktualisiert"-Zustand; Zahlen sind textlich.
 *   AC11 — bei gitWarning:true erscheint ein dezenter, TEXTLICHER Warnhinweis
 *          (role="note"), ohne gitWarning kein Hinweis, keine eigene Aktion.
 *
 * NICHT unit-testbar: reale Zeitzonen-Formatierung von `toLocaleString()`
 * (jsdom-Umgebungsabhängig) — verifiziert über das Vorhandensein eines
 * nicht-leeren `title`-Attributs statt eines exakten Formats (Muster
 * NightRunsSection.jsx / RepoOverview.test.jsx).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { fireEvent, waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { RepoSizeBadge } = await import('../RepoSizeBadge.jsx');

function makeFetch({ sizesResponse, refreshResponse, sizesOk = true, refreshOk = true } = {}) {
  return jest.fn(async (url) => {
    if (typeof url === 'string' && url.startsWith('/api/workspace/repo-sizes/refresh')) {
      if (refreshResponse === 'reject') throw new Error('Netzwerkfehler');
      return {
        ok: refreshOk,
        status: refreshOk ? 202 : 500,
        json: async () => refreshResponse ?? { repo: 'dev-gui', status: 'scheduled' },
      };
    }
    if (typeof url === 'string' && url.startsWith('/api/workspace/repo-sizes')) {
      if (sizesResponse === 'reject') throw new Error('Netzwerkfehler');
      return {
        ok: sizesOk,
        status: sizesOk ? 200 : 500,
        json: async () => sizesResponse ?? { sizes: [] },
      };
    }
    throw new Error(`Unerwartete URL im Test-Fetch-Mock: ${url}`);
  });
}

describe('RepoSizeBadge — AC9: Gesamt-Badge + Alter + Platzhalter', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('zeigt menschenlesbare Gesamtgröße (MB) + relatives Alter im Text + absoluten Zeitstempel im title', async () => {
    const measuredAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // vor 3h
    const fetchFn = makeFetch({
      sizesResponse: {
        sizes: [{
          repo: 'dev-gui', total: 1_400_000, git: 500_000, artifacts: 800_000, workspace: 100_000,
          measuredAt, gitWarning: false,
        }],
      },
    });

    const { getByText } = render(
      React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
    );

    await waitFor(() => {
      expect(getByText(/Größe: 1\.3 MB/)).toBeTruthy();
    });
    const summary = getByText(/Größe: 1\.3 MB/);
    expect(summary.textContent).toMatch(/vor 3 h/);
    expect(summary.getAttribute('title')).toBeTruthy();
  });

  it('nie vermessen (measuredAt: null) → neutraler Platzhalter "noch nicht vermessen"', async () => {
    const fetchFn = makeFetch({
      sizesResponse: { sizes: [{ repo: 'dev-gui', total: 0, git: 0, artifacts: 0, workspace: 0, measuredAt: null, gitWarning: false }] },
    });

    const { getByText } = render(
      React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
    );

    await waitFor(() => {
      expect(getByText(/noch nicht vermessen/)).toBeTruthy();
    });
  });

  it('leere sizes-Liste (Repo noch nie im Store) → neutraler Platzhalter, kein Crash', async () => {
    const fetchFn = makeFetch({ sizesResponse: { sizes: [] } });

    const { getByText } = render(
      React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
    );

    await waitFor(() => {
      expect(getByText(/noch nicht vermessen/)).toBeTruthy();
    });
  });

  it('Ladefehler (Netzwerk) → Platzhalter bleibt sichtbar, blockiert das Rendern nicht, kein Crash', async () => {
    const fetchFn = makeFetch({ sizesResponse: 'reject' });

    const { getByText } = render(
      React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
    );

    await waitFor(() => {
      expect(getByText(/noch nicht vermessen/)).toBeTruthy();
    });
  });

  it('unerwartete Antwortform (kein sizes-Array) → Platzhalter, kein Crash', async () => {
    const fetchFn = makeFetch({ sizesResponse: { unexpected: true } });

    const { getByText } = render(
      React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
    );

    await waitFor(() => {
      expect(getByText(/noch nicht vermessen/)).toBeTruthy();
    });
  });
});

describe('RepoSizeBadge — AC10: Aufschlüsselung + Aktualisieren-Aktion', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  const MEASURED_SIZE = {
    repo: 'dev-gui', total: 1_400_000, git: 500_000, artifacts: 800_000, workspace: 100_000,
    measuredAt: new Date().toISOString(), gitWarning: false,
  };

  it('Aufschlüsselung zeigt drei Buckets menschenlesbar + Summe = Gesamt', async () => {
    const fetchFn = makeFetch({ sizesResponse: { sizes: [MEASURED_SIZE] } });

    const { getByText } = render(
      React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
    );

    await waitFor(() => expect(getByText(/Größe: 1\.3 MB/)).toBeTruthy());

    expect(getByText(/Arbeitsstand: 97\.7 KB/)).toBeTruthy();
    expect(getByText(/\.git: 488\.3 KB/)).toBeTruthy();
    expect(getByText(/Abhängigkeiten\/Artefakte: 781\.3 KB/)).toBeTruthy();
    expect(getByText(/Summe = Gesamt: 1\.3 MB/)).toBeTruthy();
  });

  it('Aktualisieren-Button ruft POST refresh mit { repo } und spiegelt läuft/aktualisiert-Zustand', async () => {
    const fetchFn = makeFetch({ sizesResponse: { sizes: [MEASURED_SIZE] } });

    const { findByRole } = render(
      React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
    );

    const btn = await findByRole('button', { name: /Größe von diesem Projekt neu messen/i });
    expect(btn.textContent).toMatch(/Aktualisieren/);

    fireEvent.click(btn);

    // "läuft"-Zustand
    await waitFor(() => expect(btn.textContent).toMatch(/läuft/));

    // POST-Aufruf mit korrektem Body
    const refreshCall = fetchFn.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/refresh'));
    expect(refreshCall).toBeTruthy();
    expect(refreshCall[1].method).toBe('POST');
    expect(JSON.parse(refreshCall[1].body)).toEqual({ repo: 'dev-gui' });

    // "aktualisiert"-Zustand nach Abschluss
    await waitFor(() => expect(btn.textContent).toMatch(/Aktualisiert/));
  });

  it('Klick auf Aktualisieren-Button löst NICHT den Karten-Auswahl-Klick der umgebenden Liste aus', async () => {
    const fetchFn = makeFetch({ sizesResponse: { sizes: [MEASURED_SIZE] } });
    const onSelect = jest.fn();

    const { findByRole } = render(
      React.createElement(
        'ul',
        null,
        React.createElement(
          'li',
          { onClick: onSelect },
          React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
        ),
      ),
    );

    const btn = await findByRole('button', { name: /Größe von diesem Projekt neu messen/i });
    fireEvent.click(btn);

    expect(onSelect).not.toHaveBeenCalled();
    // Async-Kette vollständig auflaufen lassen, bevor der Test endet (kein act()-Leak).
    await waitFor(() => expect(btn.textContent).toMatch(/Aktualisiert/));
  });

  it('zweiter Klick während laufendem Refresh ist No-op (Button disabled während "läuft")', async () => {
    const fetchFn = makeFetch({ sizesResponse: { sizes: [MEASURED_SIZE] } });

    const { findByRole } = render(
      React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
    );

    const btn = await findByRole('button', { name: /Größe von diesem Projekt neu messen/i });
    fireEvent.click(btn);

    await waitFor(() => expect(btn.disabled).toBe(true));
    // Async-Kette vollständig auflaufen lassen, bevor der Test endet (kein act()-Leak).
    await waitFor(() => expect(btn.textContent).toMatch(/Aktualisiert/));
  });
});

describe('RepoSizeBadge — AC11: Warnhinweis bei gitWarning', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('gitWarning:true → dezenter, textlicher Warnhinweis (role=note), keine Aktion', async () => {
    const fetchFn = makeFetch({
      sizesResponse: {
        sizes: [{
          repo: 'dev-gui', total: 600_000_000, git: 550_000_000, artifacts: 40_000_000, workspace: 10_000_000,
          measuredAt: new Date().toISOString(), gitWarning: true,
        }],
      },
    });

    const { getByRole } = render(
      React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
    );

    await waitFor(() => {
      const note = getByRole('note');
      expect(note.textContent).toMatch(/\.git/);
    });
  });

  it('gitWarning:false → kein Warnhinweis', async () => {
    const fetchFn = makeFetch({
      sizesResponse: {
        sizes: [{
          repo: 'dev-gui', total: 100_000, git: 50_000, artifacts: 30_000, workspace: 20_000,
          measuredAt: new Date().toISOString(), gitWarning: false,
        }],
      },
    });

    const { queryByRole, getByText } = render(
      React.createElement(RepoSizeBadge, { repo: 'dev-gui', fetchFn }),
    );

    await waitFor(() => expect(getByText(/Größe:/)).toBeTruthy());
    expect(queryByRole('note')).toBeNull();
  });
});
