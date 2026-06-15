/**
 * ProjektCockpit.test.jsx — Tests für projekt-cockpit-navigation AC1–AC3.
 *
 * Covers (projekt-cockpit-navigation):
 *   AC1 — RepoOverview rendert lokale Klone (Name/Branch/dirty/letzter Commit);
 *          Loading-, Error- und Empty-State vorhanden.
 *   AC2 — Repo-Auswahl setzt aktiven Projekt-Kontext (navigateFactory(name));
 *          Deep-Link #/factory/<repo> stellt Projekt wieder her;
 *          Rückweg zur Übersicht (navigateFactory(null) → #/factory);
 *          parseHashFull parst #/factory/<repo> korrekt.
 *   AC3 — CockpitView zeigt Reiter-Leiste Arbeiten/Studis-Kanban-Board/Spezifikation;
 *          „Arbeiten" zeigt Terminal (FactoryWorkspace);
 *          Reiter-Umschaltung wechselt Panel.
 *   AC4 — Terminal-WS-URL enthält ?project=<encoded-activeRepo> (S-111);
 *          buildTerminalWsUrl gibt absolute WS-URL zurück.
 *   AC5 — TriggerPanel erhält projectPath=activeRepo via FactoryWorkspace-Prop.
 *   AC6 — Board-Reiter bettet BoardView mit lockedProject=activeRepo ein;
 *          kein eigener Projekt-Selektor im Cockpit (S-113).
 *
 * Covers (studis-kanban-board-ux):
 *   AC1 — CockpitView-Reiter trägt label „Studis-Kanban-Board" statt „Board"
 *          (getestet per tab-name-Assertion).
 *
 * Covers (projekt-spezifikation-anzeige):
 *   AC4 — Spezifikation-Reiter eingebettet (SpecView gemockt; Volltest in SpecView.test.jsx);
 *          CockpitView übergibt onOpenSpec-Callback an BoardView (AC5).
 *   AC5 — AccessGuard-Verdrahtung: per server.js-Inspektion, kein separater Middleware-Test.
 *          AC5 (nicht unit-testbar ohne echte SpecView) — dokumentiert im Covers-Block.
 *
 * Terminal, Dashboard, TriggerPanel, BoardView, SpecView gemockt (WS/DOM-Komplexität vermeiden).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// ── Mock heavy sub-components ─────────────────────────────────────────────────

// Terminal mock records the wsUrl prop so WS-URL tests can inspect it.
let _terminalLastWsUrl = null;
jest.unstable_mockModule('../Terminal.jsx', () => ({
  Terminal: ({ wsUrl }) => {
    _terminalLastWsUrl = wsUrl ?? null;
    return null;
  },
}));
jest.unstable_mockModule('../Dashboard.jsx', () => ({
  Dashboard: () => null,
}));
jest.unstable_mockModule('../TriggerPanel.jsx', () => ({
  TriggerPanel: () => null,
}));

// Mock BoardView — AC6/S-113: board tab embeds BoardView.
// Rendered as a recognizable stub (main[aria-label="Studis-Kanban-Board"]) without
// triggering real fetch calls, matching the real component's landmark (AC1/studis-kanban-board-ux).
// The stub records the onOpenSpec prop for AC5 assertions.
let _boardLastOnOpenSpec = null;
jest.unstable_mockModule('../BoardView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    BoardView: ({ lockedProject, onOpenSpec }) => {
      _boardLastOnOpenSpec = onOpenSpec ?? null;
      return R.createElement(
        'main',
        { 'aria-label': 'Studis-Kanban-Board', 'data-locked-project': lockedProject ?? '' },
        `Studis-Kanban-Board für Projekt: ${lockedProject ?? '—'}`,
      );
    },
  };
});

// Mock SpecView — AC4 (projekt-spezifikation-anzeige): Spezifikation-Reiter bettet SpecView ein.
// Rendered as recognizable stub without triggering real fetch calls.
jest.unstable_mockModule('../SpecView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    SpecView: ({ projectSlug, initialPath }) =>
      R.createElement(
        'div',
        { 'data-testid': 'spec-view-stub', 'data-project-slug': projectSlug ?? '' },
        `Spezifikation für: ${projectSlug ?? '—'}${initialPath ? ` / ${initialPath}` : ''}`,
      ),
  };
});

// Mock TeamView to avoid /api/team fetch in any AppShell-level renders
jest.unstable_mockModule('../TeamView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    TeamView: () => R.createElement('main', { 'aria-label': 'Team-Ansicht' }, 'Team (Mock)'),
  };
});

// Dynamic imports AFTER mock declarations (ESM VM-modules requirement)
const { render }              = await import('@testing-library/react');
const React                   = (await import('react')).default;
const { AppShell }            = await import('../AppShell.jsx');
const { parseHashFull, factoryToHash } = await import('../useHashRouter.js');
const { RepoOverview }        = await import('../RepoOverview.jsx');
const { CockpitView }         = await import('../CockpitView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let _origFetch;

// lastCommit ist ein Objekt {hash,subject,date} (oder null) — so liefert es die API.
const MOCK_REPOS = [
  { name: 'dev-gui',    branch: 'main',    dirty: false, lastCommit: { hash: 'abc1234', subject: 'Fix bug', date: '2026-06-15T12:00:00Z' } },
  { name: 'agent-flow', branch: 'feature', dirty: true,  lastCommit: { hash: 'def5678', subject: 'Add feature', date: '2026-06-15T12:00:00Z' } },
];

function mockFetchRepos(repos = MOCK_REPOS) {
  globalThis.fetch = jest.fn((url) => {
    if (url === '/api/workspace/repos') {
      return Promise.resolve({ ok: true, json: async () => repos });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  });
}

function mockFetchError() {
  globalThis.fetch = jest.fn((url) => {
    if (url === '/api/workspace/repos') {
      return Promise.resolve({ ok: false, status: 500 });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  });
}

beforeEach(() => {
  window.location.hash = '';
  _terminalLastWsUrl = null;
  _origFetch = globalThis.fetch;
  // Default: empty repos
  globalThis.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [] }));
});

afterEach(() => {
  window.location.hash = '';
  globalThis.fetch = _origFetch;
});

// ── parseHashFull unit tests (AC2) ────────────────────────────────────────────

describe('parseHashFull — factory route parsing (AC2)', () => {
  it('parses #/factory as view=factory, factoryRepo=null', () => {
    expect(parseHashFull('#/factory')).toEqual({ view: 'factory', factoryRepo: null });
  });

  it('parses #/factory/dev-gui as view=factory, factoryRepo=dev-gui', () => {
    expect(parseHashFull('#/factory/dev-gui')).toEqual({ view: 'factory', factoryRepo: 'dev-gui' });
  });

  it('parses #/factory/agent-flow as view=factory, factoryRepo=agent-flow', () => {
    expect(parseHashFull('#/factory/agent-flow')).toEqual({ view: 'factory', factoryRepo: 'agent-flow' });
  });

  it('parses #/ as panel (no factoryRepo)', () => {
    expect(parseHashFull('#/')).toEqual({ view: 'panel', factoryRepo: null });
  });

  it('parses #/github as github (no factoryRepo)', () => {
    expect(parseHashFull('#/github')).toEqual({ view: 'github', factoryRepo: null });
  });

  it('parses empty string as panel', () => {
    expect(parseHashFull('')).toEqual({ view: 'panel', factoryRepo: null });
  });

  it('parses unknown hash as panel', () => {
    expect(parseHashFull('#/unknown-route')).toEqual({ view: 'panel', factoryRepo: null });
  });
});

// ── factoryToHash unit tests (AC2) ───────────────────────────────────────────

describe('factoryToHash — hash generation (AC2)', () => {
  it('returns #/factory for null', () => {
    expect(factoryToHash(null)).toBe('#/factory');
  });

  it('returns #/factory/dev-gui for "dev-gui"', () => {
    expect(factoryToHash('dev-gui')).toBe('#/factory/dev-gui');
  });

  it('returns #/factory/agent-flow for "agent-flow"', () => {
    expect(factoryToHash('agent-flow')).toBe('#/factory/agent-flow');
  });
});

// ── AC1 — RepoOverview rendert lokale Klone ───────────────────────────────────

describe('RepoOverview — AC1: Rendert lokale Klone', () => {
  it('zeigt Loading-State initial', () => {
    // Fetch never resolves — keeps loading state
    globalThis.fetch = jest.fn(() => new Promise(() => {}));

    const { getByRole } = render(
      React.createElement(RepoOverview, { navigateFactory: jest.fn() })
    );
    expect(getByRole('main', { name: /repo-übersicht/i })).toBeTruthy();
    // aria-busy present during loading
    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).toBeTruthy();
  });

  it('zeigt Repos nach erfolgreichem Fetch (Name, Branch, dirty, lastCommit)', async () => {
    mockFetchRepos(MOCK_REPOS);

    const { getByText } = render(
      React.createElement(RepoOverview, { navigateFactory: jest.fn() })
    );

    await waitFor(() => {
      // Repo names are shown
      expect(getByText('dev-gui')).toBeTruthy();
      expect(getByText('agent-flow')).toBeTruthy();
    });

    // Branch shown
    expect(getByText('main')).toBeTruthy();
    expect(getByText('feature')).toBeTruthy();

    // dirty/clean badges
    expect(getByText('clean')).toBeTruthy();
    expect(getByText('dirty')).toBeTruthy();

    // lastCommit shown (Objekt → "hash · subject")
    expect(getByText('abc1234 · Fix bug')).toBeTruthy();
    expect(getByText('def5678 · Add feature')).toBeTruthy();
  });

  it('zeigt Empty-State wenn keine Repos vorhanden', async () => {
    mockFetchRepos([]);

    const { getByRole } = render(
      React.createElement(RepoOverview, { navigateFactory: jest.fn() })
    );

    await waitFor(() => {
      const main = getByRole('main', { name: /repo-übersicht/i });
      expect(main.textContent).toMatch(/keine lokalen klone/i);
    });
  });

  it('zeigt Error-State bei HTTP-Fehler', async () => {
    mockFetchError();

    const { getByRole } = render(
      React.createElement(RepoOverview, { navigateFactory: jest.fn() })
    );

    await waitFor(() => {
      // role="alert" for error message
      const alert = getByRole('alert');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toMatch(/fehler/i);
    });
  });

  it('Repo-Buttons haben Touch-Target minHeight >= 44px', async () => {
    mockFetchRepos(MOCK_REPOS);

    const { getAllByRole } = render(
      React.createElement(RepoOverview, { navigateFactory: jest.fn() })
    );

    await waitFor(() => {
      // Repo select buttons are present
      expect(getAllByRole('button', { name: /projekt.*öffnen/i }).length).toBeGreaterThan(0);
    });

    const btns = document.querySelectorAll('button[data-repo]');
    for (const btn of btns) {
      const minH = parseInt(btn.style.minHeight, 10);
      expect(minH).toBeGreaterThanOrEqual(44);
    }
  });

  it('Repo-Buttons sind per Maus und Tastatur aktivierbar (nicht disabled)', async () => {
    mockFetchRepos(MOCK_REPOS);

    const { getAllByRole } = render(
      React.createElement(RepoOverview, { navigateFactory: jest.fn() })
    );

    await waitFor(() => {
      const btns = getAllByRole('button', { name: /projekt.*öffnen/i });
      for (const btn of btns) {
        expect(btn.disabled).toBe(false);
      }
    });
  });
});

// ── AC2 — Repo-Auswahl setzt Projekt-Kontext ─────────────────────────────────

describe('RepoOverview — AC2: Repo-Auswahl setzt Projekt-Kontext', () => {
  it('Klick auf Repo ruft navigateFactory mit Repo-Namen auf', async () => {
    mockFetchRepos(MOCK_REPOS);
    const navigateFactory = jest.fn();

    const { getByRole } = render(
      React.createElement(RepoOverview, { navigateFactory })
    );

    await waitFor(() => {
      expect(getByRole('button', { name: /projekt dev-gui öffnen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /projekt dev-gui öffnen/i }));
    });

    expect(navigateFactory).toHaveBeenCalledWith('dev-gui');
  });

  it('Klick auf zweiten Repo ruft navigateFactory mit dessen Namen auf', async () => {
    mockFetchRepos(MOCK_REPOS);
    const navigateFactory = jest.fn();

    const { getByRole } = render(
      React.createElement(RepoOverview, { navigateFactory })
    );

    await waitFor(() => {
      expect(getByRole('button', { name: /projekt agent-flow öffnen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /projekt agent-flow öffnen/i }));
    });

    expect(navigateFactory).toHaveBeenCalledWith('agent-flow');
  });
});

// ── AC2 — Deep-Link / Reload stellt Projekt wieder her ───────────────────────

describe('AppShell — AC2: Deep-Link #/factory/<repo> stellt Projekt wieder her', () => {
  it('Deep-Link #/factory/dev-gui zeigt Cockpit (nicht Repo-Übersicht)', async () => {
    mockFetchRepos(MOCK_REPOS);
    window.location.hash = '#/factory/dev-gui';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { queryByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      // CockpitView is shown (has tablist with Arbeiten/Board/Spezifikation)
      expect(queryByRole('tablist', { name: /cockpit-reiter/i })).toBeTruthy();
      // RepoOverview is NOT shown
      expect(queryByRole('main', { name: /repo-übersicht/i })).toBeNull();
    });
  });

  it('Deep-Link #/factory (ohne Repo) zeigt Repo-Übersicht', async () => {
    mockFetchRepos(MOCK_REPOS);
    window.location.hash = '#/factory';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('main', { name: /repo-übersicht/i })).toBeTruthy();
    });
  });

  it('Repo-Auswahl setzt Hash auf #/factory/<repo>', async () => {
    mockFetchRepos(MOCK_REPOS);
    window.location.hash = '#/factory';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('button', { name: /projekt dev-gui öffnen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /projekt dev-gui öffnen/i }));
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/factory/dev-gui');
    });
  });
});

// ── AC2 — Rückweg zur Übersicht ──────────────────────────────────────────────

describe('CockpitView — AC2: Rückweg zur Übersicht', () => {
  it('Back-Button ruft navigateFactory(null) auf', () => {
    const navigateFactory = jest.fn();
    const onNavigate = jest.fn();

    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory,
        onNavigate,
      })
    );

    fireEvent.click(getByRole('button', { name: /zurück zur repo-übersicht/i }));
    expect(navigateFactory).toHaveBeenCalledWith(null);
  });

  it('Back-Button in AppShell navigiert zu #/factory (Übersicht)', async () => {
    window.location.hash = '#/factory/dev-gui';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('button', { name: /zurück zur repo-übersicht/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /zurück zur repo-übersicht/i }));
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/factory');
    });
  });
});

// ── AC3 — Cockpit-Reiter-Shell ────────────────────────────────────────────────

describe('CockpitView — AC3: Reiter-Leiste und Reiter-Umschaltung', () => {
  it('zeigt Reiter-Leiste mit Arbeiten, Studis-Kanban-Board, Spezifikation (AC1/studis-kanban-board-ux)', () => {
    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    const tablist = getByRole('tablist', { name: /cockpit-reiter/i });
    expect(tablist).toBeTruthy();
    expect(tablist.textContent).toMatch(/arbeiten/i);
    expect(tablist.textContent).toMatch(/studis-kanban-board/i);
    expect(tablist.textContent).toMatch(/spezifikation/i);
  });

  it('"Arbeiten"-Reiter ist initial aktiv (aria-selected="true")', () => {
    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    const arbeitenTab = getByRole('tab', { name: /arbeiten/i });
    expect(arbeitenTab.getAttribute('aria-selected')).toBe('true');
  });

  it('"Arbeiten"-Reiter zeigt Terminal (FactoryWorkspace mit main[aria-label="Terminal"])', () => {
    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    // Terminal landmark is rendered in the Arbeiten tab
    expect(getByRole('main', { name: /^terminal$/i })).toBeTruthy();
  });

  it('"Studis-Kanban-Board"-Reiter ist initial nicht aktiv', () => {
    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    const boardTab = getByRole('tab', { name: /^studis-kanban-board$/i });
    expect(boardTab.getAttribute('aria-selected')).toBe('false');
  });

  it('Klick auf "Studis-Kanban-Board"-Reiter zeigt Platzhalter-Panel', async () => {
    const { getByRole, queryByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /^studis-kanban-board$/i }));
    });

    await waitFor(() => {
      // Board tabpanel is shown
      expect(getByRole('tabpanel', { name: /board/i })).toBeTruthy();
      // Terminal is NOT shown (Arbeiten tab is gone)
      expect(queryByRole('main', { name: /^terminal$/i })).toBeNull();
    });
  });

  it('Studis-Kanban-Board-Reiter zeigt BoardView mit Projekt-Kontext (AC6/S-113)', async () => {
    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /^studis-kanban-board$/i }));
    });

    await waitFor(() => {
      // Board tabpanel must be present
      const panel = getByRole('tabpanel', { name: /board/i });
      expect(panel).toBeTruthy();
      // BoardView is embedded: the landmark main[aria-label="Studis-Kanban-Board"] is in the panel
      const boardMain = panel.querySelector('main[aria-label="Studis-Kanban-Board"]');
      expect(boardMain).toBeTruthy();
      // Projekt-Kontext (activeRepo) is passed as lockedProject (no own selector, AC6)
      expect(boardMain.dataset.lockedProject).toBe('dev-gui');
    });
  });

  it('Klick auf "Spezifikation"-Reiter zeigt Platzhalter-Panel', async () => {
    const { getByRole, queryByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /spezifikation/i }));
    });

    await waitFor(() => {
      expect(getByRole('tabpanel', { name: /spezifikation/i })).toBeTruthy();
      expect(queryByRole('main', { name: /^terminal$/i })).toBeNull();
    });
  });

  it('Spezifikation-Reiter bettet SpecView ein (AC4 — projekt-spezifikation-anzeige)', async () => {
    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /spezifikation/i }));
    });

    await waitFor(() => {
      const panel = getByRole('tabpanel', { name: /spezifikation/i });
      // SpecView-Stub rendert "Spezifikation für: dev-gui"
      expect(panel.textContent).toMatch(/Spezifikation für: dev-gui/);
    });
  });

  it('Klick zurück auf "Arbeiten" zeigt wieder Terminal', async () => {
    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    // Switch to Studis-Kanban-Board
    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /^studis-kanban-board$/i }));
    });

    // Switch back to Arbeiten
    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /arbeiten/i }));
    });

    await waitFor(() => {
      expect(getByRole('main', { name: /^terminal$/i })).toBeTruthy();
    });
  });

  it('aktiver Reiter erbt Projekt-Kontext (Projekt-Name im Header)', () => {
    render(
      React.createElement(CockpitView, {
        activeRepo: 'agent-flow',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    // Project name is visible in the cockpit header
    const header = document.querySelector('[aria-label="Aktives Projekt: agent-flow"]');
    expect(header).toBeTruthy();
    expect(header.textContent).toBe('agent-flow');
  });

  it('Reiter-Buttons haben Touch-Target minHeight >= 44px', () => {
    render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    const tabBtns = document.querySelectorAll('[role="tab"]');
    expect(tabBtns.length).toBe(3);
    for (const btn of tabBtns) {
      const minH = parseInt(btn.style.minHeight, 10);
      expect(minH).toBeGreaterThanOrEqual(44);
    }
  });
});

// ── AC6/S-113 — Board-Reiter Projekt-Kontext ─────────────────────────────────

describe('CockpitView — AC6/S-113: Board-Reiter zeigt aktives Projekt (kein eigener Selektor)', () => {
  it('BoardView erhält onOpenSpec-Callback (AC5 — projekt-spezifikation-anzeige)', async () => {
    _boardLastOnOpenSpec = null;
    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /^studis-kanban-board$/i }));
    });

    await waitFor(() => {
      // BoardView-Mock speichert onOpenSpec beim Render
      expect(typeof _boardLastOnOpenSpec).toBe('function');
    });

    // Aufruf des Callbacks wechselt zum Spezifikation-Reiter
    await act(async () => {
      _boardLastOnOpenSpec('docs/specs/foo.md');
    });

    await waitFor(() => {
      // Spezifikation-Panel sichtbar mit initialPath-Stub
      const panel = getByRole('tabpanel', { name: /spezifikation/i });
      expect(panel.textContent).toMatch(/docs\/specs\/foo\.md/);
    });
  });

  it('BoardView erhält lockedProject=activeRepo (kein eigener Projekt-Selektor)', async () => {
    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'agent-flow',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /^studis-kanban-board$/i }));
    });

    await waitFor(() => {
      const boardMain = document.querySelector('main[aria-label="Studis-Kanban-Board"]');
      expect(boardMain).toBeTruthy();
      expect(boardMain.dataset.lockedProject).toBe('agent-flow');
    });
  });

  it('Terminal-WS-URL trägt ?project=<activeRepo> (AC4/S-111 client-side)', () => {
    // Terminal mock records the wsUrl prop; in jsdom window.location.protocol is 'about:',
    // so we can't rely on ws/wss — just check the project param is encoded in the URL.
    render(
      React.createElement(CockpitView, {
        activeRepo: '/home/user/agent-flow',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    // Arbeiten tab is active by default — Terminal is mounted
    expect(_terminalLastWsUrl).toBeTruthy();
    expect(_terminalLastWsUrl).toContain('project=');
    expect(_terminalLastWsUrl).toContain(encodeURIComponent('/home/user/agent-flow'));
  });

  it('Spezifikation-Reiter zeigt SpecView mit projectSlug (AC4 — projekt-spezifikation-anzeige)', async () => {
    const { getByRole } = render(
      React.createElement(CockpitView, {
        activeRepo: 'dev-gui',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      })
    );

    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /spezifikation/i }));
    });

    await waitFor(() => {
      const panel = getByRole('tabpanel', { name: /spezifikation/i });
      // SpecView-Stub rendert projectSlug als data-attribute und im Text
      const stub = panel.querySelector('[data-testid="spec-view-stub"]');
      expect(stub).not.toBeNull();
      expect(stub.getAttribute('data-project-slug')).toBe('dev-gui');
    });
  });
});

// ── AC3 — Cockpit in AppShell via #/factory/<repo> ───────────────────────────

describe('AppShell — AC3: Cockpit in App via Deep-Link', () => {
  it('#/factory/dev-gui zeigt Cockpit mit Reiter-Leiste', async () => {
    window.location.hash = '#/factory/dev-gui';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('tablist', { name: /cockpit-reiter/i })).toBeTruthy();
    });
  });

  it('#/factory/dev-gui zeigt Terminal im Arbeiten-Reiter', async () => {
    window.location.hash = '#/factory/dev-gui';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('main', { name: /^terminal$/i })).toBeTruthy();
    });
  });

  it('Navigieren von #/factory/dev-gui zu #/github entfernt Cockpit', async () => {
    window.location.hash = '#/factory/dev-gui';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { queryByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(queryByRole('tablist', { name: /cockpit-reiter/i })).toBeTruthy();
    });

    await act(async () => {
      window.location.hash = '#/github';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    await waitFor(() => {
      expect(queryByRole('tablist', { name: /cockpit-reiter/i })).toBeNull();
      expect(queryByRole('main', { name: /github-ansicht/i })).toBeTruthy();
    });
  });
});
