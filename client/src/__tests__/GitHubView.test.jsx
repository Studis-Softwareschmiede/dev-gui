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
 * Covers (github-repos-overview AC3, AC4, AC5, AC6 — Frontend-Anteil):
 *   AC3  — Repo-Liste rendert Name, Sichtbarkeit, offene Issues, CI-Status,
 *           klickbaren GitHub-Link pro Zeile (semantische Tabelle).
 *   AC4  — „Neues Repo"-Button über der Liste (togglet Formular);
 *           „Klonen"-Button pro Zeile (disabled placeholder für #62).
 *   AC5  — Badge „lokal vorhanden" bei Repos, die in GET /api/workspace/repos auftauchen;
 *           kein Badge bei Repos ohne lokalen Klon; Klonen-Button entfällt bei isLocal=true;
 *           Workspace-Endpunkt down → Liste normal, kein Badge, kein Fehler-Banner;
 *           nach erfolgreichem Klon → Badge erscheint (workspace/repos re-fetch).
 *   AC6  — Graceful degradation: Fehler-Hinweis bei Nichterreichbarkeit,
 *           leere Liste mit Hinweis, kein Crash/Whitescreen.
 *
 * Covers (github-repo-clone AC1, AC4, AC6 — Frontend-Anteil, #62):
 *   AC1  — „Klonen"-Button löst POST /api/github/repos/clone aus;
 *           bei 201 wird „Geklont" + Ziel-Pfad angezeigt (role=status).
 *   AC4  — 409 already-present: Hinweis + expliziter Bestätigungs-Button für
 *           force-Re-Clone (kein stilles Überschreiben); Abbrechen möglich.
 *   AC6  — Fehlerpfade (403/404/422/500/502/Netzwerk) werden klar dargestellt;
 *           während Klonens: Button disabled (Loading-State, Mehrfachklick-Schutz).
 *
 * Covers (workspace-repos AC6, AC9 — Frontend-Anteil, #68):
 *   AC9  — Workspace-Übersicht rendert pro Klon: Name, Branch, clean/dirty, letzter Commit,
 *           credential-freie origin-URL, Aktionen Pull + Löschen; semantische Tabelle;
 *           leerer Workspace → Hinweis; Endpunkt down → graceful (keine Tabelle, kein Crash).
 *   AC9  — Pull-Erfolg (role=status, aria-busy, kein Mehrfachklick), Pull-Fehler (role=alert),
 *           List-Refresh nach Pull + Löschen.
 *   AC6  — Lösch-Dialog: öffnen → Klon-Name im Dialog; bestätigen → POST delete; abbrechen →
 *           kein POST; Escape schließt Dialog; Fokus bei Öffnen im Dialog; Fokus zurück zum
 *           Auslöser bei Abbruch (activeElement-Assertions).
 *   AC6  — Touch-Targets ≥ 44 px für Pull/Löschen/Dialog-Buttons.
 *   AC6  — Pull-Fehler + Delete-Fehler (role=alert, Backend-error-Text).
 *
 * Covers (workspace-path-config AC1 + UI-Anteil AC3 — #89):
 *   AC1  — Sektion „Workspace" in der GitHub-Ansicht zeigt wirksamen Pfad + Quelle
 *           (configured / env-default); Buttons Setzen/Ändern/Zurücksetzen vorhanden.
 *   AC3  — 422-Fehler (role=alert, Backend-Meldung), alter Pfad bleibt sichtbar;
 *           leeres Feld → Frontend-Fehlermeldung, kein PUT; aria-describedby gesetzt.
 *
 * NFR A11y (Clone-Teil):
 *   - Erfolg: role=status, aria-live=polite, Fokusführung auf Status-Region.
 *   - Fehler/already-present: role=alert, aria-live=assertive, Fokusführung.
 *   - Clone-Button: Touch-Target ≥ 44 px, aria-label, aria-busy während Laden.
 *
 * NFR A11y (allgemein):
 *   - Alle Felder mit <label> beschriftet (htmlFor).
 *   - Fehler programmatisch zugeordnet (aria-describedby).
 *   - Erfolgs-URL: tabIndex, <a>-Link (klickbar und fokussierbar).
 *   - <h1> für Haupt-Titel, <h2> für Sektion-Überschriften.
 *   - Touch-Target ≥ 44 px für Submit-Button.
 *   - Repo-Tabelle mit scope="col" Spaltenköpfen; Links + Aktionen tastaturerreichbar.
 *   - Badge „lokal vorhanden": Text-Content (kein reines Farb-Signal), Kontrast ≥ 4.5:1.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }       = await import('@testing-library/react');
const React            = (await import('react')).default;
const { GitHubView }   = await import('../GitHubView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Standardmässige Erfolgs-Antwort des Backends für POST /api/github/repos (201). */
const CREATE_SUCCESS = {
  name: 'mein-repo',
  fullName: 'softwareschmiede/mein-repo',
  htmlUrl: 'https://github.com/softwareschmiede/mein-repo',
  visibility: 'private',
};

/** Standardmässige Erfolgs-Antwort für POST /api/github/repos/clone (201). */
const CLONE_SUCCESS = {
  repo: 'alpha-repo',
  status: 'cloned',
  path: 'alpha-repo',
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

/**
 * Workspace-Repos-Antwort: alpha-repo ist lokal vorhanden, beta-repo nicht.
 * AC5: { repos: [{ name, branch, dirty, lastCommit, originUrl }] }
 */
const WORKSPACE_REPOS_RESPONSE = {
  repos: [
    {
      name: 'alpha-repo',
      branch: 'main',
      dirty: false,
      lastCommit: 'abc1234',
      originUrl: 'https://github.com/org/alpha-repo',
    },
  ],
};

/** Leere Workspace-Repos-Antwort (kein Repo lokal vorhanden). */
const WORKSPACE_REPOS_EMPTY = { repos: [] };

/**
 * Workspace-Repos für die WorkspaceOverview-Tests (#68 AC9):
 * Zwei Klone mit allen Feldern (name, branch, dirty, lastCommit, originUrl).
 */
const WORKSPACE_REPOS_FULL = {
  repos: [
    {
      name: 'alpha-repo',
      branch: 'main',
      dirty: false,
      lastCommit: { hash: 'abc1234', subject: 'Initial commit', date: '2026-06-07' },
      originUrl: 'https://github.com/org/alpha-repo',
    },
    {
      name: 'beta-repo',
      branch: 'feature-x',
      dirty: true,
      lastCommit: { hash: 'def5678', subject: 'WIP changes', date: '2026-06-06' },
      originUrl: 'https://github.com/org/beta-repo',
    },
  ],
};

/** Pull-Erfolgs-Antwort */
const PULL_SUCCESS = { name: 'alpha-repo', status: 'pulled' };
/** Lösch-Erfolgs-Antwort */
const DELETE_SUCCESS = { name: 'alpha-repo', status: 'deleted' };

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Standard-Workspace-Path-Antwort (env-default). */
const DEFAULT_WORKSPACE_PATH = {
  effectivePath: '/workspace',
  source: 'env-default',
  mountRoot: '/workspace',
};

/** Workspace-Path-Antwort mit konfiguriertem Pfad. */
const CONFIGURED_WORKSPACE_PATH = {
  effectivePath: '/workspace/projekt',
  source: 'configured',
  mountRoot: '/workspace',
};

/**
 * Erstellt einen fetchFn der GET /api/github/repos, GET /api/workspace/repos,
 * GET /api/settings/workspace-path, POST /api/github/repos, POST /api/github/repos/clone,
 * POST /api/workspace/repos/pull, POST /api/workspace/repos/delete,
 * PUT /api/settings/workspace-path und DELETE /api/settings/workspace-path separat bedient.
 *
 * AC5: getWorkspaceRepos steuert die Antwort für GET /api/workspace/repos.
 * Default: leere Workspace-Repos-Liste (kein Badge sichtbar).
 * #68 AC9: postWsPull / postWsDelete steuern Antworten für Pull/Delete-Endpunkte.
 * #89 WS-AC1/WS-AC3: getWorkspacePath / putWorkspacePath / deleteWorkspacePath
 *   steuern Antworten für die workspace-path Endpunkte.
 *
 * @param {{
 *   getRepos?: { ok?: boolean, status?: number, data?: object },
 *   getWorkspaceRepos?: { ok?: boolean, status?: number, data?: object } | 'reject',
 *   getWorkspacePath?: { ok?: boolean, status?: number, data?: object } | 'reject',
 *   postCreate?: { ok?: boolean, status?: number, data?: object },
 *   postClone?: { ok?: boolean, status?: number, data?: object },
 *   postWsPull?: { ok?: boolean, status?: number, data?: object },
 *   postWsDelete?: { ok?: boolean, status?: number, data?: object },
 *   putWorkspacePath?: { ok?: boolean, status?: number, data?: object },
 *   deleteWorkspacePath?: { ok?: boolean, status?: number, data?: object },
 * }} opts
 */
function makeRoutedFetchFn({
  getRepos           = { ok: true, status: 200, data: REPOS_RESPONSE          },
  getWorkspaceRepos  = { ok: true, status: 200, data: WORKSPACE_REPOS_EMPTY   },
  getWorkspacePath   = { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH  },
  postCreate         = { ok: true, status: 201, data: CREATE_SUCCESS           },
  postClone          = { ok: true, status: 201, data: CLONE_SUCCESS            },
  postWsPull         = { ok: true, status: 200, data: PULL_SUCCESS             },
  postWsDelete       = { ok: true, status: 200, data: DELETE_SUCCESS           },
  putWorkspacePath   = { ok: true, status: 200, data: { effectivePath: '/workspace/projekt', source: 'configured' } },
  deleteWorkspacePath = { ok: true, status: 200, data: { effectivePath: '/workspace', source: 'env-default' } },
} = {}) {
  return jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';

    if (method === 'PUT' && url === '/api/settings/workspace-path') {
      return { ok: putWorkspacePath.ok, status: putWorkspacePath.status, json: async () => putWorkspacePath.data };
    }
    if (method === 'DELETE' && url === '/api/settings/workspace-path') {
      return { ok: deleteWorkspacePath.ok, status: deleteWorkspacePath.status, json: async () => deleteWorkspacePath.data };
    }
    if (method === 'POST') {
      if (url === '/api/workspace/repos/pull') {
        return { ok: postWsPull.ok, status: postWsPull.status, json: async () => postWsPull.data };
      }
      if (url === '/api/workspace/repos/delete') {
        return { ok: postWsDelete.ok, status: postWsDelete.status, json: async () => postWsDelete.data };
      }
      if (url === '/api/github/repos/clone') {
        return { ok: postClone.ok, status: postClone.status, json: async () => postClone.data };
      }
      // POST /api/github/repos (create)
      return { ok: postCreate.ok, status: postCreate.status, json: async () => postCreate.data };
    }
    // GET routes
    if (url === '/api/settings/workspace-path') {
      if (getWorkspacePath === 'reject') throw new Error('workspace-path endpoint unreachable');
      return { ok: getWorkspacePath.ok, status: getWorkspacePath.status, json: async () => getWorkspacePath.data };
    }
    if (url === '/api/workspace/repos') {
      // 'reject' simuliert Netzwerkfehler (AC5: Workspace-Endpunkt nicht erreichbar)
      if (getWorkspaceRepos === 'reject') throw new Error('workspace endpoint unreachable');
      return {
        ok: getWorkspaceRepos.ok,
        status: getWorkspaceRepos.status,
        json: async () => getWorkspaceRepos.data,
      };
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

  it('rendert pro Repo-Zeile einen „Klonen"-Button (aktiv nach #62)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const cloneBtns = getAllByRole('button', { name: /klonen/i });
      expect(cloneBtns).toHaveLength(REPOS_RESPONSE.repos.length);
      // Nach #62 sind die Buttons aktiv (nicht mehr disabled)
      for (const btn of cloneBtns) {
        expect(btn.disabled).toBe(false);
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
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const alerts = getAllByRole('alert');
      expect(alerts.length).toBeGreaterThan(0);
      // Mindestens ein Alert passt zum Repo-Ladefehler oder Workspace-Pfad-Fehler
      const hasRelevantAlert = alerts.some((el) =>
        el.textContent.match(/nicht erreichbar|nicht geladen/i),
      );
      expect(hasRelevantAlert).toBe(true);
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

// ── #62 AC1 — Klonen: Erfolgspfad ────────────────────────────────────────────

describe('GitHubView — #62 AC1: Klonen Erfolgspfad', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Klick auf „Klonen" sendet POST /api/github/repos/clone mit { repo: name }', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /klonen/i }).length).toBeGreaterThan(0);
    });

    const cloneBtn = getAllByRole('button', { name: /alpha-repo klonen/i })[0];
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => {
      const postCalls = fetchFn.mock.calls.filter(
        ([url, opts]) => url === '/api/github/repos/clone' && opts?.method === 'POST',
      );
      expect(postCalls).toHaveLength(1);
      const body = JSON.parse(postCalls[0][1].body);
      expect(body.repo).toBe('alpha-repo');
    });
  });

  it('bei 201: zeigt „Geklont" inkl. Ziel-Pfad (AC1)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getAllByRole, getByText } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      expect(getByText(/geklont/i)).toBeTruthy();
      expect(document.body.textContent).toContain('alpha-repo');
    });
  });

  it('bei 201: Erfolgs-Bereich hat role="status" und aria-live="polite" (A11y)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      const statusEls = document.querySelectorAll('[role="status"][aria-live="polite"]');
      expect(statusEls.length).toBeGreaterThan(0);
    });
  });

  it('bei 201: Fokus wird auf Status-Bereich gesetzt (Fokusführung A11y)', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"][aria-live="polite"]');
      expect(statusEl).toBeTruthy();
      expect(document.activeElement).toBe(statusEl);
    });
  });

  it('bei 201: Ziel-Pfad aus der Response wird angezeigt', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: true, status: 201, data: { repo: 'alpha-repo', status: 'cloned', path: 'alpha-repo' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain('alpha-repo');
    });
  });
});

// ── #62 AC6 — Klonen: Loading-State (Mehrfachklick-Schutz) ───────────────────

describe('GitHubView — #62 AC6: Loading-State (Mehrfachklick-Schutz)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('während Klonens: Klonen-Button ist disabled / zeigt Lade-Label (aria-busy)', async () => {
    // fetchFn der niemals resolved — simuliert langes Klonen
    let resolveClone;
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/github/repos/clone') {
        return new Promise((resolve) => { resolveClone = resolve; });
      }
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_EMPTY };
      }
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    // Während Klonens: loading-Button mit aria-busy vorhanden
    await waitFor(() => {
      const busyBtn = document.querySelector('[aria-busy="true"]');
      expect(busyBtn).toBeTruthy();
      expect(busyBtn.disabled).toBe(true);
    });

    // Aufräumen: clone-Promise auflösen
    await act(async () => {
      resolveClone({ ok: true, status: 201, json: async () => CLONE_SUCCESS });
    });
  });
});

// ── #62 AC4 — Klonen: 409 already-present + force-Bestätigung ────────────────

describe('GitHubView — #62 AC4: 409 already-present + force-Re-Clone', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('409 → zeigt „Bereits vorhanden"-Meldung (role=alert)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 409, data: { status: 'already-present', path: 'alpha-repo' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toMatch(/bereits vorhanden/i);
    });
  });

  it('409 → zeigt „Überschreiben"-Button für explizite force-Bestätigung (AC4)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 409, data: { status: 'already-present', path: 'alpha-repo' } },
    });
    const { getAllByRole, getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      // Expliziter Bestätigungs-Button muss sichtbar sein
      expect(getByRole('button', { name: /überschreiben/i })).toBeTruthy();
    });
  });

  it('409 → force-Re-Clone sendet { repo, force: true } nach Bestätigung', async () => {
    let callCount = 0;
    const fetchFn = jest.fn(async (url, opts = {}) => {
      if (url === '/api/github/repos/clone' && (opts.method ?? '') === 'POST') {
        callCount++;
        if (callCount === 1) {
          // Erster Aufruf: 409
          return { ok: false, status: 409, json: async () => ({ status: 'already-present', path: 'alpha-repo' }) };
        }
        // Zweiter Aufruf (force): Erfolg
        return { ok: true, status: 201, json: async () => CLONE_SUCCESS };
      }
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_EMPTY };
      }
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });
    const { getAllByRole, getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    // Erster Klick → 409
    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /überschreiben/i })).toBeTruthy();
    });

    // Klick auf „Überschreiben" → force-Request
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /überschreiben/i }));
    });

    await waitFor(() => {
      const cloneCalls = fetchFn.mock.calls.filter(
        ([url]) => url === '/api/github/repos/clone',
      );
      expect(cloneCalls).toHaveLength(2);
      const forceBody = JSON.parse(cloneCalls[1][1].body);
      expect(forceBody.force).toBe(true);
      expect(forceBody.repo).toBe('alpha-repo');
    });
  });

  it('409 → nach erfolgreicher force-Re-Clone wird „Geklont" angezeigt', async () => {
    let callCount = 0;
    const fetchFn = jest.fn(async (url, opts = {}) => {
      if (url === '/api/github/repos/clone' && (opts.method ?? '') === 'POST') {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 409, json: async () => ({ status: 'already-present', path: 'alpha-repo' }) };
        }
        return { ok: true, status: 201, json: async () => CLONE_SUCCESS };
      }
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_EMPTY };
      }
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });
    const { getAllByRole, getByRole, getByText } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /überschreiben/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /überschreiben/i }));
    });

    await waitFor(() => {
      expect(getByText(/geklont/i)).toBeTruthy();
    });
  });

  it('409 → „Abbrechen"-Button setzt Zustand zurück auf idle (Klonen-Button wieder sichtbar)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 409, data: { status: 'already-present', path: 'alpha-repo' } },
    });
    const { getAllByRole, getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /abbrechen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /abbrechen/i }));
    });

    await waitFor(() => {
      // Klonen-Button ist wieder sichtbar
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });
  });

  it('409 → Fokus wird auf alert-Bereich gesetzt (Fokusführung A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 409, data: { status: 'already-present', path: 'alpha-repo' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"][aria-live="assertive"]');
      expect(alertEl).toBeTruthy();
      expect(document.activeElement).toBe(alertEl);
    });
  });

  it('Touch-Targets für Überschreiben/Abbrechen-Buttons ≥ 44 px (minHeight)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 409, data: { status: 'already-present', path: 'alpha-repo' } },
    });
    const { getAllByRole, getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      const overwriteBtn = getByRole('button', { name: /überschreiben/i });
      const cancelBtn    = getByRole('button', { name: /abbrechen/i });
      expect(parseInt(overwriteBtn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
      expect(parseInt(cancelBtn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    });
  });
});

// ── #62 AC6 — Klonen: Fehlerpfade ────────────────────────────────────────────

describe('GitHubView — #62 AC6: Fehlerpfade beim Klonen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('403 → Fehlermeldung wird angezeigt (role=alert)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 403, data: { error: 'Keine Berechtigung für diese Aktion' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toMatch(/berechtigung|403/i);
    });
  });

  it('404 → Fehlermeldung wird angezeigt', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 404, data: { error: 'Repository nicht gefunden' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/repository nicht gefunden|404/i);
    });
  });

  it('422 → Fehlermeldung wird angezeigt', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 422, data: { error: 'Ungültige Repo-Referenz' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/ungültige|422/i);
    });
  });

  it('500 → Fehlermeldung wird angezeigt', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 500, data: { error: 'Interner Fehler' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/interner fehler|500/i);
    });
  });

  it('502 → Fehlermeldung wird angezeigt', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 502, data: { error: 'GitHub-API-Fehler beim Klonen' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/github|502/i);
    });
  });

  it('Netzwerkfehler (clone-POST wirft) → Fehlermeldung angezeigt', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/github/repos/clone') {
        throw new Error('Network failure during clone');
      }
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_EMPTY };
      }
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/network failure|fehler/i);
    });
  });

  it('Fehler: kein Token/Secret in der Fehlermeldung (Security AC6/AC3)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 403, data: { error: 'Keine Berechtigung für diese Aktion' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).not.toMatch(/eyJ[A-Za-z0-9]/); // JWT
      expect(text).not.toMatch(/ghp_/);            // GitHub PAT
      expect(text).not.toMatch(/ghs_/);            // GitHub App token
    });
  });

  it('Fehler: Fokus wird auf alert-Element gesetzt (Fokusführung A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 422, data: { error: 'Ungültige Referenz' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(document.activeElement).toBe(alertEl);
    });
  });

  it('nach Fehler: „Klonen"-Button bleibt sichtbar für erneuten Versuch', async () => {
    const fetchFn = makeRoutedFetchFn({
      postClone: { ok: false, status: 502, data: { error: 'Clone fehlgeschlagen' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      // Klonen-Button bleibt im idle/error-Zustand sichtbar
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });
  });
});

// ── #62 A11y — Touch-Targets für Klonen-Buttons ──────────────────────────────

describe('GitHubView — #62 A11y: Touch-Targets Klonen-Buttons', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('„Klonen"-Button pro Zeile hat Touch-Target ≥ 44 px (minHeight)', async () => {
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

  it('„Erneut klonen"-Button nach Erfolg hat Touch-Target ≥ 44 px', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getAllByRole, getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    await waitFor(() => {
      const btn = getByRole('button', { name: /erneut klonen/i });
      expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    });
  });
});

// ── AC5 (github-repos-overview) — Badge „lokal vorhanden" ────────────────────

describe('GitHubView — AC5: Badge „lokal vorhanden"', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Badge erscheint bei Repo, das in workspace/repos auftaucht', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_RESPONSE },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      // alpha-repo ist lokal vorhanden → Badge sichtbar
      expect(getByText(/lokal vorhanden/i)).toBeTruthy();
    });
  });

  it('Badge enthält Text (nicht nur Farbe) — A11y SC 1.4.1', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_RESPONSE },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      const badge = getByText(/lokal vorhanden/i);
      // Muss Text-Content haben (kein leeres Element mit nur Farbe)
      expect(badge.textContent.trim()).toMatch(/lokal vorhanden/i);
    });
  });

  it('Badge hat aria-label "lokal vorhanden" (programmatische Beschriftung)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_RESPONSE },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      const badge = getByText(/lokal vorhanden/i);
      expect(badge.getAttribute('aria-label')).toMatch(/lokal vorhanden/i);
    });
  });

  it('kein Badge bei Repo, das NICHT in workspace/repos auftaucht', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_RESPONSE },
    });
    const { getByText, queryAllByText } = renderView(fetchFn);
    await waitFor(() => {
      // beta-repo ist nicht lokal → kein zweites Badge
      // alpha-repo hat Badge, beta-repo nicht → genau 1 Badge insgesamt
      const badges = queryAllByText(/lokal vorhanden/i);
      expect(badges).toHaveLength(1);
      // beta-repo muss in der Liste stehen
      expect(getByText('beta-repo')).toBeTruthy();
    });
  });

  it('Klonen-Button entfällt für Repo mit Badge „lokal vorhanden"', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_RESPONSE },
    });
    const { queryAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      // alpha-repo ist lokal → kein Klonen-Button für alpha-repo
      const alphaCloneBtn = queryAllByRole('button', { name: /alpha-repo klonen/i });
      expect(alphaCloneBtn).toHaveLength(0);
      // beta-repo ist nicht lokal → Klonen-Button für beta-repo vorhanden
      const betaCloneBtns = queryAllByRole('button', { name: /beta-repo klonen/i });
      expect(betaCloneBtns.length).toBeGreaterThan(0);
    });
  });

  it('Workspace-Endpunkt nicht erreichbar (Netzwerkfehler) → kein Badge, Liste bleibt nutzbar', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: 'reject',
    });
    const { queryAllByText, getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      // Keine Badges
      expect(queryAllByText(/lokal vorhanden/i)).toHaveLength(0);
      // Liste ist trotzdem voll nutzbar — beide Klonen-Buttons vorhanden
      const cloneBtns = getAllByRole('button', { name: /klonen/i });
      expect(cloneBtns.length).toBe(REPOS_RESPONSE.repos.length);
    });
  });

  it('Workspace-Endpunkt liefert HTTP 5xx → kein Badge, kein Fehler-Banner für Repo-Liste', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: false, status: 503, data: {} },
    });
    const { queryAllByText, getByRole } = renderView(fetchFn);
    await waitFor(() => {
      // Keine Badges wegen workspace-Fehler
      expect(queryAllByText(/lokal vorhanden/i)).toHaveLength(0);
      // Kein workspace-spezifisches Fehler-Banner
      // (der einzige role=alert käme von github/repos-Fehler — hier kein Fehler)
      // Tabelle ist vorhanden
      expect(getByRole('table', { name: /org-repositories/i })).toBeTruthy();
    });
  });

  it('Workspace-Endpunkt down → kein Fehler-Banner zusätzlich zur Repo-Liste', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: 'reject',
    });
    const { getByRole, queryByRole } = renderView(fetchFn);
    await waitFor(() => {
      // Tabelle ist da
      expect(getByRole('table', { name: /org-repositories/i })).toBeTruthy();
      // Kein alert-Banner wegen workspace-Fehler allein
      // (Hinweis: queryByRole('alert') kann null sein oder von Clone-Zustand kommen;
      //  hier ist noch kein Clone ausgeführt worden → kein alert)
      const alert = queryByRole('alert');
      expect(alert).toBeFalsy();
    });
  });

  it('nach erfolgreichem Klon: Badge erscheint (workspace/repos wird neu abgerufen)', async () => {
    // Workspace-Repos: zuerst leer, nach Clone-Erfolg enthält alpha-repo
    let workspaceCallCount = 0;
    const fetchFn = jest.fn(async (url, opts = {}) => {
      if ((opts.method ?? 'GET') === 'POST' && url === '/api/github/repos/clone') {
        return { ok: true, status: 201, json: async () => CLONE_SUCCESS };
      }
      if (url === '/api/workspace/repos') {
        workspaceCallCount++;
        // Erster Aufruf (beim Mount): leer; zweiter Aufruf (nach Clone): alpha-repo vorhanden
        const data = workspaceCallCount >= 2 ? WORKSPACE_REPOS_RESPONSE : WORKSPACE_REPOS_EMPTY;
        return { ok: true, status: 200, json: async () => data };
      }
      // GET /api/github/repos
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });

    const { getAllByRole, queryAllByText } = renderView(fetchFn);

    // Warte bis Liste geladen
    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo klonen/i }).length).toBeGreaterThan(0);
    });

    // Noch kein Badge
    expect(queryAllByText(/lokal vorhanden/i)).toHaveLength(0);

    // Klonen ausführen
    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo klonen/i })[0]);
    });

    // Nach Clone-Erfolg: workspace/repos wird neu abgerufen → Badge erscheint
    await waitFor(() => {
      expect(queryAllByText(/lokal vorhanden/i).length).toBeGreaterThan(0);
    });
  });

  it('kein Badge wenn workspace/repos leere Liste liefert', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_EMPTY },
    });
    const { queryAllByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(queryAllByText(/lokal vorhanden/i)).toHaveLength(0);
    });
  });
});

// ── #68 AC9 — Workspace-Übersicht: Struktur und Felder ───────────────────────

describe('GitHubView — #68 AC9: Workspace-Übersicht Struktur und Felder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rendert h2 "Workspace-Klone"', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByRole('heading', { name: /workspace-klone/i })).toBeTruthy();
    });
  });

  it('rendert Tabelle "Workspace-Klone" mit allen Spaltenköpfen', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      const table = getByRole('table', { name: /workspace-klone/i });
      expect(table).toBeTruthy();
      const ths = table.querySelectorAll('th[scope="col"]');
      // Name, Branch, Status, Letzter Commit, Origin-URL, Aktionen
      expect(ths.length).toBeGreaterThanOrEqual(5);
    });
  });

  it('rendert eine Zeile pro Klon (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      const table = getByRole('table', { name: /workspace-klone/i });
      const rows = table.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(WORKSPACE_REPOS_FULL.repos.length);
    });
  });

  it('rendert Name jedes Klons in der Tabelle (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByText } = renderView(fetchFn);
    await waitFor(() => {
      // alpha-repo und beta-repo müssen beide erscheinen
      expect(getAllByText('alpha-repo').length).toBeGreaterThan(0);
      expect(getAllByText('beta-repo').length).toBeGreaterThan(0);
    });
  });

  it('rendert Branch-Wert pro Klon (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText('main')).toBeTruthy();
      expect(getByText('feature-x')).toBeTruthy();
    });
  });

  it('rendert "clean"-Badge für dirty=false (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText('clean')).toBeTruthy();
    });
  });

  it('rendert "dirty"-Badge für dirty=true (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText('dirty')).toBeTruthy();
    });
  });

  it('rendert letzten Commit (subject) in der Tabelle (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText(/initial commit/i)).toBeTruthy();
    });
  });

  it('rendert credential-freie origin-URL in der Tabelle (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText('https://github.com/org/alpha-repo')).toBeTruthy();
    });
  });

  it('originUrl=null → zeigt "—" (keine URL vorhanden)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: {
        ok: true,
        status: 200,
        data: {
          repos: [{
            name: 'no-remote-repo',
            branch: 'main',
            dirty: false,
            lastCommit: null,
            originUrl: null,
          }],
        },
      },
    });
    const { getAllByText } = renderView(fetchFn);
    await waitFor(() => {
      // "—" als Fallback für fehlende URL und lastCommit
      expect(getAllByText('—').length).toBeGreaterThan(0);
    });
  });

  it('rendert Pull-Button pro Klon (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const pullBtns = getAllByRole('button', { name: /pullen/i });
      expect(pullBtns.length).toBeGreaterThanOrEqual(WORKSPACE_REPOS_FULL.repos.length);
    });
  });

  it('rendert Löschen-Button pro Klon (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const deleteBtns = getAllByRole('button', { name: /löschen/i });
      expect(deleteBtns.length).toBeGreaterThanOrEqual(WORKSPACE_REPOS_FULL.repos.length);
    });
  });

  it('Pull-Button hat Touch-Target ≥ 44 px (A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const pullBtns = getAllByRole('button', { name: /pullen/i });
      expect(pullBtns.length).toBeGreaterThan(0);
      for (const btn of pullBtns) {
        expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
      }
    });
  });

  it('Löschen-Button hat Touch-Target ≥ 44 px (A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const deleteBtns = getAllByRole('button', { name: /löschen/i });
      expect(deleteBtns.length).toBeGreaterThan(0);
      for (const btn of deleteBtns) {
        expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
      }
    });
  });

  it('leerer Workspace → zeigt Leerzustand-Hinweis (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_EMPTY },
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText(/keine lokalen klone/i)).toBeTruthy();
    });
  });

  it('Workspace-Endpunkt down → kein Crash, kein Workspace-Fehler-Banner, Hinweis vorhanden', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: 'reject',
    });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      // Leerzustand-Hinweis für Workspace-Übersicht
      expect(getByText(/keine lokalen klone/i)).toBeTruthy();
    });
    // Kein separates Fehler-Banner für Workspace-Übersicht allein
    // (alert kommt nur bei github/repos-Fehler)
    const alerts = document.querySelectorAll('[role="alert"]');
    // Wenn ein alert da ist, dann nur wegen github/repos (nicht wegen workspace)
    // In diesem Test gelingt github/repos → kein alert erwartet
    expect(alerts.length).toBe(0);
  });
});

// ── #68 AC9 — Pull-Aktion ─────────────────────────────────────────────────────

describe('GitHubView — #68 AC9: Pull-Aktion', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Klick auf Pull-Button sendet POST /api/workspace/repos/pull mit { name }', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo pullen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo pullen/i })[0]);
    });

    await waitFor(() => {
      const pullCalls = fetchFn.mock.calls.filter(
        ([url, opts]) => url === '/api/workspace/repos/pull' && opts?.method === 'POST',
      );
      expect(pullCalls).toHaveLength(1);
      const body = JSON.parse(pullCalls[0][1].body);
      expect(body.name).toBe('alpha-repo');
    });
  });

  it('Pull-Erfolg: zeigt „Gepullt" mit role=status (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
      postWsPull: { ok: true, status: 200, data: PULL_SUCCESS },
    });
    const { getAllByRole, getByText } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo pullen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo pullen/i })[0]);
    });

    await waitFor(() => {
      expect(getByText(/gepullt/i)).toBeTruthy();
    });
  });

  it('Pull-Erfolg: role=status und aria-live=polite (A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
      postWsPull: { ok: true, status: 200, data: PULL_SUCCESS },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo pullen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo pullen/i })[0]);
    });

    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"][aria-live="polite"]');
      expect(statusEl).toBeTruthy();
    });
  });

  it('Pull-Erfolg: Fokus wird auf Status-Bereich gesetzt (activeElement, A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
      postWsPull: { ok: true, status: 200, data: PULL_SUCCESS },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo pullen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo pullen/i })[0]);
    });

    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"][aria-live="polite"]');
      expect(statusEl).toBeTruthy();
      expect(document.activeElement).toBe(statusEl);
    });
  });

  it('während Pullens: Button disabled + aria-busy (Loading-State / Mehrfachklick-Schutz)', async () => {
    let resolvePull;
    const fetchFn = jest.fn(async (url, opts = {}) => {
      if (url === '/api/workspace/repos/pull' && opts?.method === 'POST') {
        return new Promise((resolve) => { resolvePull = resolve; });
      }
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_FULL };
      }
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo pullen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo pullen/i })[0]);
    });

    await waitFor(() => {
      const busyBtn = document.querySelector('[aria-busy="true"]');
      expect(busyBtn).toBeTruthy();
      expect(busyBtn.disabled).toBe(true);
    });

    // Aufräumen
    await act(async () => {
      resolvePull({ ok: true, status: 200, json: async () => PULL_SUCCESS });
    });
  });

  it('Pull-Fehler (4xx/5xx): zeigt Backend-error als role=alert (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
      postWsPull: { ok: false, status: 502, data: { error: 'git pull fehlgeschlagen' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo pullen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo pullen/i })[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toMatch(/git pull fehlgeschlagen/i);
    });
  });

  it('Pull-Fehler: Fokus auf alert-Element gesetzt (activeElement, A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
      postWsPull: { ok: false, status: 409, data: { error: 'Uncommitted changes vorhanden' } },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo pullen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo pullen/i })[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(document.activeElement).toBe(alertEl);
    });
  });

  it('nach Pull-Erfolg: fetchWorkspaceRepos wird erneut aufgerufen (List-Refresh)', async () => {
    let wsCallCount = 0;
    const fetchFn = jest.fn(async (url, opts = {}) => {
      if (url === '/api/workspace/repos/pull' && opts?.method === 'POST') {
        return { ok: true, status: 200, json: async () => PULL_SUCCESS };
      }
      if (url === '/api/workspace/repos') {
        wsCallCount++;
        return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_FULL };
      }
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo pullen/i }).length).toBeGreaterThan(0);
    });

    const callsBeforePull = wsCallCount;

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo pullen/i })[0]);
    });

    await waitFor(() => {
      // workspace/repos muss nach Pull erneut abgerufen worden sein
      expect(wsCallCount).toBeGreaterThan(callsBeforePull);
    });
  });
});

// ── #68 AC6 — Lösch-Dialog: Bestätigung, Abbruch, Fokus, Escape ──────────────

describe('GitHubView — #68 AC6: Lösch-Dialog', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Klick auf Löschen-Button öffnet Dialog (AC6)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole, getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      expect(getByRole('dialog')).toBeTruthy();
    });
  });

  it('Dialog nennt den Klon-Namen (AC6)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog.textContent).toContain('alpha-repo');
    });
  });

  it('Dialog: Fokus beim Öffnen auf Abbrechen-Button gesetzt (activeElement, A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      // Fokus liegt auf Abbrechen-Button im Dialog
      expect(document.activeElement?.textContent).toMatch(/abbrechen/i);
    });
  });

  it('Dialog: Abbrechen schließt Dialog, kein POST (AC6)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole, queryByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    });

    // Abbrechen klicken
    await act(async () => {
      const cancelBtn = document.querySelector('[role="dialog"] button[aria-label*="abbrechen"]') ??
        document.querySelector('[role="dialog"] button');
      cancelBtn.click();
    });

    await waitFor(() => {
      expect(queryByRole('dialog')).toBeFalsy();
    });

    // Kein DELETE-POST ausgelöst
    const deleteCalls = fetchFn.mock.calls.filter(
      ([url, opts]) => url === '/api/workspace/repos/delete' && opts?.method === 'POST',
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('Dialog: Abbrechen → Fokus zurück zum Löschen-Button (activeElement, A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    });

    // Abbrechen
    await act(async () => {
      const cancelBtn = document.querySelector('[role="dialog"] button[aria-label*="abbrechen"]') ??
        document.querySelector('[role="dialog"] button');
      cancelBtn.click();
    });

    await waitFor(() => {
      // Dialog geschlossen
      expect(document.querySelector('[role="dialog"]')).toBeFalsy();
      // Fokus zurück auf Löschen-Button — re-query nach Re-Mount des Buttons
      const freshDeleteBtn = getAllByRole('button', { name: /alpha-repo löschen/i })[0];
      expect(document.activeElement).toBe(freshDeleteBtn);
    });
  });

  it('Dialog: Escape schließt Dialog, kein POST (A11y / AC6)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole, queryByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    });

    // Escape-Taste drücken
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    await waitFor(() => {
      expect(queryByRole('dialog')).toBeFalsy();
    });

    // Kein DELETE-POST
    const deleteCalls = fetchFn.mock.calls.filter(
      ([url, opts]) => url === '/api/workspace/repos/delete' && opts?.method === 'POST',
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('Dialog: Bestätigen → sendet POST /api/workspace/repos/delete mit { name } (AC6)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
      postWsDelete: { ok: true, status: 200, data: DELETE_SUCCESS },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    });

    // Bestätigen klicken
    await act(async () => {
      const confirmBtn = document.querySelector('[role="dialog"] button[aria-label*="endgültig löschen"]') ??
        Array.from(document.querySelectorAll('[role="dialog"] button')).pop();
      confirmBtn.click();
    });

    await waitFor(() => {
      const deleteCalls = fetchFn.mock.calls.filter(
        ([url, opts]) => url === '/api/workspace/repos/delete' && opts?.method === 'POST',
      );
      expect(deleteCalls).toHaveLength(1);
      const body = JSON.parse(deleteCalls[0][1].body);
      expect(body.name).toBe('alpha-repo');
    });
  });

  it('nach erfolgreichem Löschen: fetchWorkspaceRepos wird aufgerufen (List-Refresh)', async () => {
    let wsCallCount = 0;
    const fetchFn = jest.fn(async (url, opts = {}) => {
      if (url === '/api/workspace/repos/delete' && opts?.method === 'POST') {
        return { ok: true, status: 200, json: async () => DELETE_SUCCESS };
      }
      if (url === '/api/workspace/repos') {
        wsCallCount++;
        return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_FULL };
      }
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    const wsCallsBeforeDelete = wsCallCount;

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    });

    await act(async () => {
      const confirmBtn = document.querySelector('[role="dialog"] button[aria-label*="endgültig löschen"]') ??
        Array.from(document.querySelectorAll('[role="dialog"] button')).pop();
      confirmBtn.click();
    });

    await waitFor(() => {
      expect(wsCallCount).toBeGreaterThan(wsCallsBeforeDelete);
    });
  });

  it('Löschen schlägt fehl (5xx): Fehler-Alert angezeigt, Dialog geschlossen (AC9)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
      postWsDelete: { ok: false, status: 500, data: { error: 'Löschen fehlgeschlagen intern' } },
    });
    const { getAllByRole, queryByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    });

    await act(async () => {
      const confirmBtn = document.querySelector('[role="dialog"] button[aria-label*="endgültig löschen"]') ??
        Array.from(document.querySelectorAll('[role="dialog"] button')).pop();
      confirmBtn.click();
    });

    await waitFor(() => {
      // Dialog ist geschlossen
      expect(queryByRole('dialog')).toBeFalsy();
      // Fehler-Alert vorhanden
      const alerts = document.querySelectorAll('[role="alert"]');
      const deleteAlert = Array.from(alerts).find((el) =>
        el.textContent.match(/löschen fehlgeschlagen intern/i),
      );
      expect(deleteAlert).toBeTruthy();
    });
  });

  it('Dialog-Buttons haben Touch-Target ≥ 44 px (A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      const dialogBtns = document.querySelectorAll('[role="dialog"] button');
      expect(dialogBtns.length).toBeGreaterThan(0);
      for (const btn of dialogBtns) {
        expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
      }
    });
  });

  it('Dialog hat role=dialog und aria-modal=true (A11y)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspaceRepos: { ok: true, status: 200, data: WORKSPACE_REPOS_FULL },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getAllByRole('button', { name: /alpha-repo löschen/i }).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(getAllByRole('button', { name: /alpha-repo löschen/i })[0]);
    });

    await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog.getAttribute('aria-modal')).toBe('true');
    });
  });
});

// ── Workspace-Path (WS-AC1 + UI-Anteil WS-AC3) — verschoben von SettingsView #89 ──

describe('GitHubView — WS-AC1: Workspace-Sektion Grundstruktur', () => {
  afterEach(() => jest.restoreAllMocks());

  it('WS-AC1 — rendert h3 "Workspace" in der Workspace-Klone-Sektion', async () => {
    const fetchFn = makeRoutedFetchFn();
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByRole('heading', { name: /^workspace$/i })).toBeTruthy();
    });
  });

  it('WS-AC1 — zeigt wirksamen Pfad (env-default)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      const section = getByRole('region', { name: /workspace-klone/i });
      expect(section.textContent).toContain('/workspace');
    });
  });

  it('WS-AC1 — zeigt Quelle "Default aus Env" wenn source=env-default', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      const section = getByRole('region', { name: /workspace-klone/i });
      expect(section.textContent).toMatch(/default aus env/i);
    });
  });

  it('WS-AC1 — zeigt Quelle "konfiguriert" wenn source=configured', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: CONFIGURED_WORKSPACE_PATH },
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      const section = getByRole('region', { name: /workspace-klone/i });
      expect(section.textContent).toMatch(/konfiguriert/i);
    });
  });

  it('WS-AC1 — zeigt Effektivwert /workspace/projekt wenn source=configured', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: CONFIGURED_WORKSPACE_PATH },
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      const section = getByRole('region', { name: /workspace-klone/i });
      expect(section.textContent).toContain('/workspace/projekt');
    });
  });

  it('WS-AC1 — zeigt "Setzen"-Button wenn source=env-default', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });
  });

  it('WS-AC1 — zeigt "Ändern"- und "Zurücksetzen"-Button wenn source=configured', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: CONFIGURED_WORKSPACE_PATH },
    });
    const { getAllByRole } = renderView(fetchFn);
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad ändern/i))).toBe(true);
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad auf env-default zurücksetzen/i))).toBe(true);
    });
  });
});

describe('GitHubView — WS-AC1: Setzen (PUT)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('WS-AC1 — Klick auf "Setzen" öffnet Eingabefeld mit label/htmlFor', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      const input = document.getElementById('workspace-path-input');
      expect(input).toBeTruthy();
      const label = document.querySelector('label[for="workspace-path-input"]');
      expect(label).toBeTruthy();
    });
  });

  it('WS-AC1 — erfolgreiches Setzen: PUT abgefeuert, Quelle wechselt auf "konfiguriert"', async () => {
    let wsPathCallCount = 0;
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (method === 'PUT' && url === '/api/settings/workspace-path') {
        return { ok: true, status: 200, json: async () => ({ effectivePath: '/workspace/projekt', source: 'configured' }) };
      }
      if (method === 'GET' && url === '/api/settings/workspace-path') {
        wsPathCallCount++;
        return {
          ok: true, status: 200,
          json: async () => (wsPathCallCount <= 1 ? DEFAULT_WORKSPACE_PATH : CONFIGURED_WORKSPACE_PATH),
        };
      }
      if (url === '/api/workspace/repos') return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_EMPTY };
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/projekt' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // PUT wurde abgefeuert
    await waitFor(() => {
      const putCalls = fetchFn.mock.calls.filter(([u, o]) =>
        (o?.method ?? 'GET') === 'PUT' && u === '/api/settings/workspace-path',
      );
      expect(putCalls.length).toBe(1);
    });

    // Nach Reload: Quelle wechselt auf "konfiguriert"
    await waitFor(() => {
      const section = getByRole('region', { name: /workspace-klone/i });
      expect(section.textContent).toMatch(/konfiguriert/i);
    });
  });

  it('WS-AC1 — Erfolg zeigt role=status Meldung', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/projekt' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"]');
      expect(statusEl).toBeTruthy();
      expect(statusEl.textContent).toMatch(/gespeichert/i);
    });
  });
});

describe('GitHubView — WS-AC1: Zurücksetzen (DELETE)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('WS-AC1 — Zurücksetzen: DELETE abgefeuert, Quelle wechselt auf "Default aus Env"', async () => {
    let wsPathCallCount = 0;
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (method === 'DELETE' && url === '/api/settings/workspace-path') {
        return { ok: true, status: 200, json: async () => ({ effectivePath: '/workspace', source: 'env-default' }) };
      }
      if (method === 'GET' && url === '/api/settings/workspace-path') {
        wsPathCallCount++;
        return {
          ok: true, status: 200,
          json: async () => (wsPathCallCount <= 1 ? CONFIGURED_WORKSPACE_PATH : DEFAULT_WORKSPACE_PATH),
        };
      }
      if (url === '/api/workspace/repos') return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_EMPTY };
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });
    const { getByRole, getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad auf env-default zurücksetzen/i))).toBe(true);
    });

    await act(async () => {
      const resetBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad auf env-default zurücksetzen/i),
      );
      if (resetBtn) fireEvent.click(resetBtn);
    });

    // DELETE wurde abgefeuert
    await waitFor(() => {
      const deleteCalls = fetchFn.mock.calls.filter(([u, o]) =>
        (o?.method ?? 'GET') === 'DELETE' && u === '/api/settings/workspace-path',
      );
      expect(deleteCalls.length).toBe(1);
    });

    // Nach Reload: Quelle wechselt auf "Default aus Env"
    await waitFor(() => {
      const section = getByRole('region', { name: /workspace-klone/i });
      expect(section.textContent).toMatch(/default aus env/i);
    });
  });
});

describe('GitHubView — WS-AC3 (UI): Validierungsfehler', () => {
  afterEach(() => jest.restoreAllMocks());

  it('WS-AC3 — 422-Fehler: role=alert erscheint mit Backend-Fehlermeldung', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
      putWorkspacePath: { ok: false, status: 422, data: { error: 'Pfad existiert nicht oder ist kein Verzeichnis' } },
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/etc/shadow' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toMatch(/pfad existiert nicht|verzeichnis/i);
    });
  });

  it('WS-AC3 — 422-Fehler: alter wirksamer Pfad bleibt sichtbar (unverändert)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
      putWorkspacePath: { ok: false, status: 422, data: { error: 'Pfad existiert nicht oder ist kein Verzeichnis' } },
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      const section = getByRole('region', { name: /workspace-klone/i });
      expect(section.textContent).toContain('/workspace');
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/etc/shadow' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Fehler erscheint + alter Wert /workspace noch sichtbar
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).toBeTruthy();
      const section = getByRole('region', { name: /workspace-klone/i });
      expect(section.textContent).toContain('/workspace');
    });
  });

  it('WS-AC3 — leeres Feld: Frontend-Fehlermeldung, kein PUT abgefeuert', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    // Kein Wert eingeben — direkt Speichern
    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toMatch(/leer/i);
    });

    // Kein PUT abgefeuert
    const putCalls = fetchFn.mock.calls.filter(([u, o]) =>
      (o?.method ?? 'GET') === 'PUT' && u === '/api/settings/workspace-path',
    );
    expect(putCalls.length).toBe(0);
  });

  it('WS-AC3 — aria-describedby verbindet Input mit Fehler-Element', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
      putWorkspacePath: { ok: false, status: 422, data: { error: 'Pfad existiert nicht oder ist kein Verzeichnis' } },
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/outside' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const input = document.getElementById('workspace-path-input');
      expect(input.getAttribute('aria-describedby')).toBe('workspace-path-error');
      const errorEl = document.getElementById('workspace-path-error');
      expect(errorEl).toBeTruthy();
    });
  });

  it('WS-AC3 — ohne Fehler hat Input kein aria-describedby', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    const input = document.getElementById('workspace-path-input');
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('GitHubView — WS-Loading: aria-busy + Mehrfachklick-Schutz', () => {
  afterEach(() => jest.restoreAllMocks());

  it('WS-Loading — Speichern-Button hat aria-busy=true während in-flight', async () => {
    let resolvePut;
    const putPromise = new Promise((res) => { resolvePut = res; });

    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (method === 'PUT' && url === '/api/settings/workspace-path') {
        await putPromise;
        return { ok: true, status: 200, json: async () => ({ effectivePath: '/workspace/x', source: 'configured' }) };
      }
      if (method === 'GET' && url === '/api/settings/workspace-path') {
        return { ok: true, status: 200, json: async () => DEFAULT_WORKSPACE_PATH };
      }
      if (url === '/api/workspace/repos') return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_EMPTY };
      return { ok: true, status: 200, json: async () => REPOS_RESPONSE };
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/x' },
      });
    });

    // Klick ohne await-Abschluss — Button sollte in-flight disabled sein
    act(() => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern' || b.textContent.trim() === 'Speichern…',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent.trim() === 'Speichern…' || b.getAttribute('aria-busy') === 'true',
      );
      expect(btn).toBeTruthy();
    });

    // PUT freigeben
    resolvePut();
    await act(async () => {});
  });
});

describe('GitHubView — WS-A11y: Touch-Target + Fokusführung', () => {
  afterEach(() => jest.restoreAllMocks());

  it('WS-A11y — Workspace-Buttons (Setzen/Ändern/Zurücksetzen + Speichern/Abbrechen) haben minHeight ≥ 44 px', async () => {
    // Teste Display-Modus-Buttons (Ändern + Zurücksetzen) bei configured
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: CONFIGURED_WORKSPACE_PATH },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      const btns = getAllByRole('button');
      const workspaceBtns = btns.filter((b) => {
        const label = b.getAttribute('aria-label') ?? '';
        return label.match(/workspace-pfad/i);
      });
      expect(workspaceBtns.length).toBeGreaterThan(0);
      for (const btn of workspaceBtns) {
        expect(parseInt(btn.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
      }
    });

    // Teste Editier-Modus-Buttons (Speichern + Abbrechen)
    await act(async () => {
      const changeBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad ändern/i),
      );
      if (changeBtn) fireEvent.click(changeBtn);
    });

    await waitFor(() => {
      const editBtns = Array.from(document.querySelectorAll('button')).filter((b) =>
        b.textContent.trim() === 'Speichern' || b.textContent.trim() === 'Abbrechen',
      );
      expect(editBtns.length).toBeGreaterThan(0);
      for (const btn of editBtns) {
        expect(parseInt(btn.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
      }
    });
  });

  it('WS-A11y — Fokus landet nach 422-Fehler auf dem Input (activeElement)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
      putWorkspacePath: { ok: false, status: 422, data: { error: 'Pfad existiert nicht oder ist kein Verzeichnis' } },
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/etc/shadow' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Nach Fehler: activeElement muss der Input sein
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).toBeTruthy();
      expect(document.activeElement).toBe(document.getElementById('workspace-path-input'));
    });
  });

  it('WS-A11y — Fokus landet nach Erfolg auf der Erfolgsmeldung (activeElement)', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/projekt' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Nach Erfolg: activeElement muss die Erfolgsmeldung (role=status) sein
    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"]');
      expect(statusEl).toBeTruthy();
      expect(document.activeElement).toBe(statusEl);
    });
  });

  it('WS-A11y — Workspace-Pfad-Ladefehler zeigt role=alert', async () => {
    const fetchFn = makeRoutedFetchFn({
      getWorkspacePath: 'reject',
    });
    const { getByRole } = renderView(fetchFn);

    await waitFor(() => {
      const section = getByRole('region', { name: /workspace-klone/i });
      const alerts = section.querySelectorAll('[role="alert"]');
      const hasWsError = Array.from(alerts).some((el) =>
        el.textContent.match(/workspace-pfad konnte nicht geladen werden/i),
      );
      expect(hasWsError).toBe(true);
    });
  });
});
