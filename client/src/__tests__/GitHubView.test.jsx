/**
 * GitHubView.test.jsx — Unit-Tests für GitHubView.
 *
 * Covers (github-repo-create AC1, AC5, AC6 — Frontend):
 *   AC1  — Formular vorhanden (Name, Sichtbarkeit, Beschreibung, README-Init);
 *           bei 201-Antwort wird Repo-URL klickbar angezeigt + fokussiert.
 *   AC5  — Fehlerantworten (403, 409, 422, 502, 500) werden klar und ohne
 *           Secret-Leak dargestellt.
 *   AC6  — Leerer Name → Fehlermeldung, kein Fetch-Request.
 *
 * Covers (github-repos-overview AC3, AC4, AC6 — Frontend-Anteil):
 *   AC3  — Repo-Liste rendert Name, Sichtbarkeit, offene Issues, CI-Status,
 *           klickbaren GitHub-Link pro Zeile (semantische Tabelle).
 *   AC4  — „Neues Repo"-Button über der Liste (togglet Formular);
 *           „Klonen"-Button pro Zeile (disabled placeholder für #62).
 *   AC6  — Graceful degradation: Fehler-Hinweis bei Nichterreichbarkeit,
 *           leere Liste mit Hinweis, kein Crash/Whitescreen.
 *
 * NFR A11y:
 *   - Alle Felder mit <label> beschriftet (htmlFor).
 *   - Fehler programmatisch zugeordnet (aria-describedby).
 *   - Erfolgs-URL: tabIndex, <a>-Link (klickbar und fokussierbar).
 *   - <h1> für Haupt-Titel, <h2> für Sektion-Überschriften.
 *   - Touch-Target ≥ 44 px für Submit-Button.
 *   - Repo-Tabelle mit scope="col" Spaltenköpfen; Links + Aktionen tastaturerreichbar.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }       = await import('@testing-library/react');
const React            = (await import('react')).default;
const { GitHubView }   = await import('../GitHubView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Standardmässige Erfolgs-Antwort des Backends für POST (201). */
const CREATE_SUCCESS = {
  name: 'mein-repo',
  fullName: 'softwareschmiede/mein-repo',
  htmlUrl: 'https://github.com/softwareschmiede/mein-repo',
  visibility: 'private',
};

/** Beispiel-Repo-Liste für GET /api/github/repos. */
const REPOS_RESPONSE = {
  repos: [
    {
      name: 'alpha-repo',
      fullName: 'org/alpha-repo',
      visibility: 'private',
      openIssues: 3,
      lastCi: 'success',
      htmlUrl: 'https://github.com/org/alpha-repo',
    },
    {
      name: 'beta-repo',
      fullName: 'org/beta-repo',
      visibility: 'public',
      openIssues: 0,
      lastCi: 'failure',
      htmlUrl: 'https://github.com/org/beta-repo',
    },
  ],
};

/** Leere Repo-Liste. */
const REPOS_EMPTY = { repos: [] };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Erstellt einen fetchFn der GET und POST /api/github/repos separat bedient.
 *
 * @param {{
 *   getRepos?: { ok?: boolean, status?: number, data?: object },
 *   postCreate?: { ok?: boolean, status?: number, data?: object },
 * }} opts
 */
function makeRoutedFetchFn({
  getRepos  = { ok: true,  status: 200, data: REPOS_RESPONSE  },
  postCreate = { ok: true, status: 201, data: CREATE_SUCCESS   },
} = {}) {
  return jest.fn(async (url, opts = {}) => {
    if ((opts.method ?? 'GET') === 'POST') {
      return { ok: postCreate.ok, status: postCreate.status, json: async () => postCreate.data };
    }
    // GET /api/github/repos
    return { ok: getRepos.ok, status: getRepos.status, json: async () => getRepos.data };
  });
}

/**
 * Erstellt einen fetchFn der POST /api/github/repos simuliert
 * (GET liefert leere Liste — für Create-Form-Tests).
 */
function makeFetchFn({ ok = true, status = 201, data = CREATE_SUCCESS } = {}) {
  return makeRoutedFetchFn({ postCreate: { ok, status, data } });
}

/** Rendert GitHubView mit injizierbarem fetchFn. */
function renderView(fetchFn) {
  const onNavigate = jest.fn();
  const utils = render(
    React.createElement(GitHubView, { onNavigate, fetchFn })
  );
  return { ...utils, onNavigate };
}

/**
 * Öffnet das „Neues Repo"-Formular über den Toggle-Button.
 * Muss aufgerufen werden bevor fillAndSubmit() auf Form-Elemente zugreift.
 */
async function openCreateForm(getByRole) {
  const toggleBtn = getByRole('button', { name: /\+ neues repo/i });
  await act(async () => {
    fireEvent.click(toggleBtn);
  });
}

/** Füllt den Name-Input aus und submitted das Formular. */
async function fillAndSubmit(getByLabelText, getByRole, nameValue = 'mein-repo') {
  const nameInput = getByLabelText(/repository-name/i);
  fireEvent.change(nameInput, { target: { value: nameValue } });

  const submitBtn = getByRole('button', { name: /repository anlegen/i });
  await act(async () => {
    fireEvent.click(submitBtn);
  });
}

// ── Struktur / A11y (Grundgerüst) ────────────────────────────────────────────

describe('GitHubView — Struktur und A11y', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rendert h1 "GitHub"', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    const h1 = getByRole('heading', { level: 1 });
    expect(h1.textContent).toMatch(/^github$/i);
  });

  it('rendert main landmark "GitHub-Ansicht"', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    expect(getByRole('main', { name: /github-ansicht/i })).toBeTruthy();
  });

  it('rendert h2 "Repositories"', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    expect(getByRole('heading', { name: /repositories/i })).toBeTruthy();
  });

  it('rendert Zurück-Button zum Panel', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    expect(getByRole('button', { name: /zurück zum einstiegs-panel/i })).toBeTruthy();
  });

  it('Zurück-Button hat Touch-Target ≥ 44 px (minHeight)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });

  it('Zurück-Button ruft onNavigate("panel") auf', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole, onNavigate } = renderView(fetchFn);
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(onNavigate).toHaveBeenCalledWith('panel');
  });

  it('Submit-Button hat Touch-Target ≥ 44 px (minHeight)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);

    await waitFor(() => {
      const btn = getByRole('button', { name: /repository anlegen/i });
      expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    });
  });

  it('Sichtbarkeits-Select hat Default-Wert "private"', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole, getByLabelText } = renderView(fetchFn);

    await openCreateForm(getByRole);

    await waitFor(() => {
      expect(getByLabelText(/sichtbarkeit/i).value).toBe('private');
    });
  });
});

// ── AC3 — Repo-Liste rendert Felder ──────────────────────────────────────────

describe('GitHubView — AC3: Repo-Liste Felder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rendert Tabelle "Org-Repositories" nach erfolgreichem Laden', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByRole('table', { name: /org-repositories/i })).toBeTruthy();
    });
  });

  it('rendert eine Zeile pro Repo (tbody rows)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      const table = getByRole('table', { name: /org-repositories/i });
      const rows = table.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(REPOS_RESPONSE.repos.length);
    });
  });

  it('rendert Repo-Namen in der Tabelle', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText('alpha-repo')).toBeTruthy();
      expect(getByText('beta-repo')).toBeTruthy();
    });
  });

  it('rendert Sichtbarkeits-Pill "Privat" und "Öffentlich"', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText('Privat')).toBeTruthy();
      expect(getByText('Öffentlich')).toBeTruthy();
    });
  });

  it('rendert offene Issues (numerisch)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText('3')).toBeTruthy();
      expect(getByText('0')).toBeTruthy();
    });
  });

  it('rendert CI-Status-Label für success und failure', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText(/erfolg/i)).toBeTruthy();
      expect(getByText(/fehlgeschlagen/i)).toBeTruthy();
    });
  });

  it('rendert klickbare GitHub-Links (htmlUrl) für jedes Repo', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const links = getAllByRole('link', { name: /auf github öffnen/i });
      expect(links).toHaveLength(REPOS_RESPONSE.repos.length);
      expect(links[0].href).toContain('github.com/org/alpha-repo');
    });
  });

  it('GitHub-Links haben target="_blank" und rel="noopener noreferrer"', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const links = getAllByRole('link', { name: /auf github öffnen/i });
      for (const link of links) {
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toContain('noopener');
        expect(link.getAttribute('rel')).toContain('noreferrer');
      }
    });
  });

  it('Tabelle hat semantische Spaltenköpfe mit scope="col"', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      const table = getByRole('table', { name: /org-repositories/i });
      const ths = table.querySelectorAll('th[scope="col"]');
      expect(ths.length).toBeGreaterThanOrEqual(4);
    });
  });

  it('rendert "unbekannt" für openIssues === "unknown"', async () => {
    const fetchFn = makeRoutedFetchFn({
      getRepos: {
        ok: true,
        status: 200,
        data: {
          repos: [{
            name: 'x',
            fullName: 'org/x',
            visibility: 'private',
            openIssues: 'unknown',
            lastCi: 'unknown',
            htmlUrl: 'https://github.com/org/x',
          }],
        },
      },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText('unbekannt')).toBeTruthy();
    });
  });
});

// ── AC4 — Andockpunkte ────────────────────────────────────────────────────────

describe('GitHubView — AC4: Andockpunkte', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rendert „+ Neues Repo"-Button über der Liste', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    expect(getByRole('button', { name: /\+ neues repo/i })).toBeTruthy();
  });

  it('„+ Neues Repo"-Button hat Touch-Target ≥ 44 px', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    const btn = getByRole('button', { name: /\+ neues repo/i });
    expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
  });

  it('Klick auf „+ Neues Repo" zeigt RepoCreateForm mit h2 „Neues Repository anlegen"', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole, container } = renderView(fetchFn);

    // S2: div#repo-create-section existiert immer (aria-controls gültig); vor Toggle hidden
    expect(container.querySelector('#repo-create-section').hidden).toBe(true);

    await openCreateForm(getByRole);

    await waitFor(() => {
      expect(getByRole('heading', { name: /neues repository anlegen/i })).toBeTruthy();
      // S2: nach Toggle sichtbar (hidden=false)
      expect(container.querySelector('#repo-create-section').hidden).toBe(false);
    });
  });

  it('„+ Neues Repo"-Button zeigt Formular an (aria-expanded)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);

    const toggleBtn = getByRole('button', { name: /\+ neues repo/i });
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      fireEvent.click(toggleBtn);
    });

    await waitFor(() => {
      const btn = getByRole('button', { name: /formular schließen/i });
      expect(btn.getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('zweites Klick auf Toggle schließt das Formular wieder', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole, container } = renderView(fetchFn);

    await openCreateForm(getByRole);

    await waitFor(() => {
      expect(getByRole('heading', { name: /neues repository anlegen/i })).toBeTruthy();
    });

    const closeBtn = getByRole('button', { name: /formular schließen/i });
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    await waitFor(() => {
      // S2: div#repo-create-section bleibt im DOM; aria-controls ist immer gültig.
      // Sichtbarkeit wird per hidden-Attribut gesteuert.
      const section = container.querySelector('#repo-create-section');
      expect(section).toBeTruthy();
      expect(section.hidden).toBe(true);
    });
  });

  it('rendert pro Repo-Zeile einen „Klonen"-Button (disabled)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const cloneBtns = getAllByRole('button', { name: /klonen/i });
      expect(cloneBtns).toHaveLength(REPOS_RESPONSE.repos.length);
      for (const btn of cloneBtns) {
        expect(btn.disabled).toBe(true);
      }
    });
  });

  it('„Klonen"-Button hat Touch-Target ≥ 44 px (minHeight)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const cloneBtns = getAllByRole('button', { name: /klonen/i });
      expect(cloneBtns.length).toBeGreaterThan(0);
      for (const btn of cloneBtns) {
        expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
      }
    });
  });

  it('Formular-Felder sind tastaturerreichbar (Name-Input vorhanden und fokussierbar)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole, getByLabelText } = renderView(fetchFn);

    await openCreateForm(getByRole);

    await waitFor(() => {
      const input = getByLabelText(/repository-name/i);
      expect(input.tagName).toBe('INPUT');
      // tabIndex -1 = nicht fokussierbar; 0 oder kein tabIndex = fokussierbar
      expect(input.tabIndex).not.toBe(-1);
    });
  });
});

// ── AC6 — Graceful Degradation (Repo-Liste) ───────────────────────────────────

describe('GitHubView — AC6: Graceful degradation (Repo-Liste)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('zeigt Lade-Indikator während Fetch aussteht', () => {
    const fetchFn = jest.fn(() => new Promise(() => {})); // hängt für immer
    const { container } = renderView(fetchFn);
    // loadState === 'loading' → role="status" mit Lade-Text vorhanden
    const statusEl = container.querySelector('[role="status"]');
    expect(statusEl).toBeTruthy();
    expect(statusEl.textContent).toMatch(/lade/i);
  });

  it('zeigt Fehler-Hinweis bei Netzwerkfehler (kein Crash/Whitescreen)', async () => {
    const fetchFn = jest.fn(() => Promise.reject(new Error('network error')));
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByRole('alert')).toBeTruthy();
      expect(getByRole('alert').textContent).toMatch(/nicht erreichbar|nicht geladen/i);
    });
  });

  it('zeigt Fehler-Hinweis bei HTTP 5xx', async () => {
    const fetchFn = makeRoutedFetchFn({
      getRepos: { ok: false, status: 503, data: {} },
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByRole('alert')).toBeTruthy();
    });
  });

  it('leere Liste → zeigt Leerzustand-Hinweis', async () => {
    const fetchFn = makeRoutedFetchFn({
      getRepos: { ok: true, status: 200, data: REPOS_EMPTY },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText(/keine repositories/i)).toBeTruthy();
    });
  });

  it('bei Fehler: h1 und Zurück-Button bleiben sichtbar (keine leere Whitescreen-Situation)', async () => {
    const fetchFn = jest.fn(() => Promise.reject(new Error('network error')));
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByRole('heading', { level: 1 })).toBeTruthy();
      expect(getByRole('button', { name: /zurück zum einstiegs-panel/i })).toBeTruthy();
    });
  });

  it('"unknown"-Felder werden als "unbekannt" gerendert, kein Crash', async () => {
    const fetchFn = makeRoutedFetchFn({
      getRepos: {
        ok: true,
        status: 200,
        data: {
          repos: [{
            name: 'degraded-repo',
            fullName: 'org/degraded-repo',
            visibility: 'private',
            openIssues: 'unknown',
            lastCi: 'unknown',
            htmlUrl: 'https://github.com/org/degraded-repo',
          }],
        },
      },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText('degraded-repo')).toBeTruthy();
      // openIssues 'unknown' → 'unbekannt'
      expect(getByText('unbekannt')).toBeTruthy();
    });
  });
});

// ── AC6 — Frontend-Validierung: leerer Name (github-repo-create) ──────────────

describe('GitHubView — AC6: Frontend-Validierung Formular', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('leerer Name → Fehlermeldung wird angezeigt', async () => {
    const fetchFn = makeFetchFn();
    const { getByRole, getByText } = renderView(fetchFn);

    await openCreateForm(getByRole);

    const submitBtn = getByRole('button', { name: /repository anlegen/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(getByText(/pflichtfeld/i)).toBeTruthy();
    });
  });

  it('leerer Name → kein POST-Request ausgelöst', async () => {
    const fetchFn = makeFetchFn();
    const { getByRole } = renderView(fetchFn);

    // Merke Anzahl Calls nach GET (Repo-Liste) vor dem Submit
    await waitFor(() => {
      // GET-Call ist abgeschlossen
      expect(fetchFn).toHaveBeenCalledWith('/api/github/repos');
    });
    const callsAfterGet = fetchFn.mock.calls.length;

    await openCreateForm(getByRole);

    const submitBtn = getByRole('button', { name: /repository anlegen/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Kein weiterer Call (kein POST)
    expect(fetchFn.mock.calls.length).toBe(callsAfterGet);
  });

  it('leerer Name → Name-Input hat aria-describedby auf Fehler-Element', async () => {
    const fetchFn = makeFetchFn();
    const { getByRole, getByLabelText } = renderView(fetchFn);

    await openCreateForm(getByRole);

    const submitBtn = getByRole('button', { name: /repository anlegen/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      const nameInput = getByLabelText(/repository-name/i);
      const errorId = nameInput.getAttribute('aria-describedby');
      expect(errorId).toBeTruthy();
      const errorEl = document.getElementById(errorId);
      expect(errorEl).toBeTruthy();
      expect(errorEl.textContent).toMatch(/pflichtfeld/i);
    });
  });

  it('Name nur aus Leerzeichen → Fehlermeldung, kein weiterer POST-Request', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole, getByText } = renderView(fetchFn);

    await openCreateForm(getByRole);

    // Warte bis GET-Call abgeschlossen
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith('/api/github/repos'));
    const callsAfterGet = fetchFn.mock.calls.length;

    const nameInput = getByLabelText(/repository-name/i);
    fireEvent.change(nameInput, { target: { value: '   ' } });

    const submitBtn = getByRole('button', { name: /repository anlegen/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(getByText(/pflichtfeld/i)).toBeTruthy();
    });
    expect(fetchFn.mock.calls.length).toBe(callsAfterGet);
  });
});

// ── AC1 — Erfolgspfad: klickbare Repo-URL (github-repo-create) ───────────────

describe('GitHubView — AC1: Erfolgspfad Formular', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bei 201: Repo-URL wird als klickbarer Link angezeigt', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const link = getByRole('link', { name: /softwareschmiede\/mein-repo/i });
      expect(link).toBeTruthy();
      expect(link.href).toContain('github.com/softwareschmiede/mein-repo');
    });
  });

  it('bei 201: Link ist mit target="_blank" und rel="noreferrer" ausgestattet', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const link = getByRole('link', { name: /softwareschmiede\/mein-repo/i });
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noreferrer');
    });
  });

  it('bei 201: Link ist fokussierbar (tabIndex) UND hat tatsächlich den Fokus (useEffect)', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const link = getByRole('link', { name: /softwareschmiede\/mein-repo/i });
      expect(link.tabIndex).not.toBe(-1);
      expect(document.activeElement).toBe(link);
    });
  });

  it('bei 201: Erfolgs-Statusbox hat role="status" und aria-live="polite"', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const statusBox = document.querySelector('[role="status"][aria-live="polite"]');
      expect(statusBox).toBeTruthy();
    });
  });

  it('bei 201: fullName wird in der Erfolgsanzeige genannt', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole, getAllByText } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const els = getAllByText(/softwareschmiede\/mein-repo/i);
      expect(els.length).toBeGreaterThan(0);
    });
  });

  it('bei 201: Button "Weiteres Repository anlegen" erscheint', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /weiteres repository anlegen/i })).toBeTruthy();
    });
  });

  it('bei 201: "Weiteres Repository anlegen" setzt Formular zurück', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      getByRole('button', { name: /weiteres repository anlegen/i });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /weiteres repository anlegen/i }));
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /repository anlegen/i })).toBeTruthy();
    });
  });

  it('bei 201: öffentliches Repo zeigt "Öffentlich" Badge', async () => {
    const fetchFn = makeRoutedFetchFn({
      postCreate: { ok: true, status: 201, data: { ...CREATE_SUCCESS, visibility: 'public' } },
    });
    const { getByLabelText, getByRole, getAllByText } = renderView(fetchFn);

    await openCreateForm(getByRole);

    const select = getByLabelText(/sichtbarkeit/i);
    fireEvent.change(select, { target: { value: 'public' } });

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      // "Öffentlich" kann sowohl im Badge als auch in der Repo-Liste auftauchen
      const matches = getAllByText(/öffentlich/i);
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it('bei 201: POST-Request enthält name, visibility und autoInit', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);

    const nameInput = getByLabelText(/repository-name/i);
    fireEvent.change(nameInput, { target: { value: 'test-repo' } });

    const checkbox = getByLabelText(/mit readme initialisieren/i);
    fireEvent.click(checkbox);

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /repository anlegen/i }));
    });

    // Warte auf POST-Call
    await waitFor(() => {
      const postCalls = fetchFn.mock.calls.filter(([, opts]) => opts?.method === 'POST');
      expect(postCalls).toHaveLength(1);
      const [url, opts] = postCalls[0];
      expect(url).toBe('/api/github/repos');
      const body = JSON.parse(opts.body);
      expect(body.name).toBe('test-repo');
      expect(body.visibility).toBe('private');
      expect(body.autoInit).toBe(true);
    });
  });

  it('bei 201: optionale Beschreibung wird mitgeschickt wenn gefüllt', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);

    const nameInput = getByLabelText(/repository-name/i);
    fireEvent.change(nameInput, { target: { value: 'test-repo' } });

    const descInput = getByLabelText(/beschreibung/i);
    fireEvent.change(descInput, { target: { value: 'Meine Beschreibung' } });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /repository anlegen/i }));
    });

    await waitFor(() => {
      const postCalls = fetchFn.mock.calls.filter(([, opts]) => opts?.method === 'POST');
      expect(postCalls).toHaveLength(1);
      const body = JSON.parse(postCalls[0][1].body);
      expect(body.description).toBe('Meine Beschreibung');
    });
  });

  it('bei 201: leere Beschreibung wird NICHT mitgeschickt', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);

    const nameInput = getByLabelText(/repository-name/i);
    fireEvent.change(nameInput, { target: { value: 'test-repo' } });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /repository anlegen/i }));
    });

    await waitFor(() => {
      const postCalls = fetchFn.mock.calls.filter(([, opts]) => opts?.method === 'POST');
      expect(postCalls).toHaveLength(1);
      const body = JSON.parse(postCalls[0][1].body);
      expect(body.description).toBeUndefined();
    });
  });
});

// ── AC5 — Fehlerpfade: 403, 409, 422, 502, 500 (github-repo-create) ──────────
// Verhalten §4 + AC7 (error rendering)

describe('GitHubView — AC5: Fehlerpfade Formular', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('403 → Fehlermeldung "403" oder "Berechtigung" angezeigt', async () => {
    const fetchFn = makeRoutedFetchFn({
      postCreate: { ok: false, status: 403, data: { error: 'Keine Berechtigung für diese Aktion' } },
    });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/403|berechtigung/i);
    });
  });

  it('403 → Kein Token/Secret in der Fehlermeldung (Security)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postCreate: { ok: false, status: 403, data: { error: 'Keine Berechtigung für diese Aktion' } },
    });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).not.toMatch(/eyJ[A-Za-z0-9]/); // JWT
      expect(text).not.toMatch(/ghp_/);            // GitHub PAT
    });
  });

  it('409 → Fehlermeldung "409" oder "vergeben" angezeigt', async () => {
    const fetchFn = makeRoutedFetchFn({
      postCreate: { ok: false, status: 409, data: { error: 'Repository-Name bereits vergeben in der Org' } },
    });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/409|vergeben/i);
    });
  });

  it('422 → Fehlermeldung "422" oder "ungültig" angezeigt', async () => {
    const fetchFn = makeRoutedFetchFn({
      postCreate: { ok: false, status: 422, data: { error: 'Ungültiger Repository-Name' } },
    });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/422|ungültig/i);
    });
  });

  it('502 → Fehlermeldung "502" oder "GitHub" angezeigt', async () => {
    const fetchFn = makeRoutedFetchFn({
      postCreate: { ok: false, status: 502, data: { error: 'GitHub-API-Fehler beim Anlegen des Repositories' } },
    });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/502|github/i);
    });
  });

  it('500 → Fehlermeldung "500" oder "Fehler" angezeigt', async () => {
    const fetchFn = makeRoutedFetchFn({
      postCreate: { ok: false, status: 500, data: { error: 'Audit-Write fehlgeschlagen' } },
    });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/500|fehler/i);
    });
  });

  it('Netzwerkfehler (POST wirft) → Fehlermeldung angezeigt', async () => {
    // GET resolves OK, POST rejects
    const fetchFn = jest.fn(async (url, opts = {}) => {
      if ((opts.method ?? 'GET') === 'POST') {
        throw new Error('Network failure');
      }
      return { ok: true, status: 200, json: async () => REPOS_EMPTY };
    });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/network failure|fehler/i);
    });
  });

  it('Fehler-Paragraph hat role="alert" (A11y — sofortige Ankündigung)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postCreate: { ok: false, status: 422, data: { error: 'Ungültiger Name' } },
    });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  it('nach Fehlerpfad: Formular bleibt sichtbar (kein Erfolgs-Panel)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postCreate: { ok: false, status: 422, data: { error: 'Ungültiger Name' } },
    });
    const { getByLabelText, getByRole, queryByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      expect(queryByRole('link', { name: /github\.com.*softwareschmiede/i })).toBeFalsy();
      expect(getByRole('button', { name: /repository anlegen/i })).toBeTruthy();
    });
  });
});

// ── A11y — aria-describedby auf API-Fehler (github-repo-create) ───────────────

describe('GitHubView — A11y: aria-describedby für API-Fehler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-Fehler: Fehlermeldung hat id "repo-form-error"', async () => {
    const fetchFn = makeRoutedFetchFn({
      postCreate: { ok: false, status: 422, data: { error: 'Ungültiger Name' } },
    });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await openCreateForm(getByRole);
    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const formError = document.querySelector('#repo-form-error');
      expect(formError).toBeTruthy();
      expect(formError.textContent).toMatch(/422|ungültig/i);
    });
  });
});
