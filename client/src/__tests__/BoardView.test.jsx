/**
 * BoardView.test.jsx — Unit tests for BoardView (dev-gui-board-aggregator, AC4–AC6).
 *
 * Covers (dev-gui-board-aggregator):
 *   AC4 — Dreistufige Übersicht Projekt → Feature → Story mit Status-Spalten;
 *          aggregiert über alle Projekte; aria-busy/aria-live Ladezustand;
 *          Fehlerzustand; Leerzustand; GET /api/board/projects einmal beim Mount.
 *   AC5 — Rollup-Anzeige je Feature: vorhandenes progress-Feld → direkt anzeigen;
 *          fehlendes/stale progress → read-only aus Kind-Story-Status berechnet;
 *          progressbar-Role mit aria-valuenow.
 *   AC6 — Filter nach Projekt (Dropdown), Status (Dropdown), Label (Dropdown);
 *          unabhängig kombinierbar; Zurücksetzen-Button; kein Backend-Aufruf beim Filtern.
 *          Filter-Leerzustand: role=status-Hinweis wenn Status- oder Label-Filter alle Stories eliminieren.
 *   AC4/A11y — <main> aria-label "Board-Übersicht"; Status-Badges mit Text-Label
 *               (Bedeutung nicht allein über Farbe); aria-current-Muster nicht benötigt
 *               (Übersicht, kein Master-Detail); WCAG-Kontrast in Quellcode-Kommentaren
 *               dokumentiert, jsdom nicht testbar.
 *
 * NOTE (jsdom-Limitation): jsdom hat keine Layout-Engine — Style-Property-Asserts beweisen
 * kein Scroll-/Layout-Verhalten; getestet werden Verhalten, Struktur, Rollen und aria.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// Mocks for AppShell dependencies (unused here, but may be loaded via viewRegistry)
jest.unstable_mockModule('../Terminal.jsx', () => ({
  Terminal: () => null,
}));
jest.unstable_mockModule('../Dashboard.jsx', () => ({
  Dashboard: () => null,
}));
jest.unstable_mockModule('../TriggerPanel.jsx', () => ({
  TriggerPanel: () => null,
}));

const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { BoardView } = await import('../BoardView.jsx');
const { VIEWS, parseHash } = await import('../useHashRouter.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STORY_TODO = {
  id: 'S-001',
  parent: 'F-001',
  title: 'Erstelle Login-Seite',
  status: 'To Do',
  priority: 'high',
  labels: ['frontend', 'auth'],
  spec: 'docs/specs/login.md',
};

const STORY_IN_PROGRESS = {
  id: 'S-002',
  parent: 'F-001',
  title: 'Implementiere Auth-Flow',
  status: 'In Progress',
  priority: 'high',
  labels: ['backend', 'auth'],
  spec: null,
};

const STORY_DONE = {
  id: 'S-003',
  parent: 'F-001',
  title: 'Setup Datenbank',
  status: 'Done',
  priority: 'medium',
  labels: ['backend'],
  spec: null,
};

const STORY_BLOCKED = {
  id: 'S-004',
  parent: 'F-002',
  title: 'Deploy Pipeline',
  status: 'Blocked',
  priority: 'high',
  labels: ['ci', 'devops'],
  spec: null,
};

const STORY_IN_REVIEW = {
  id: 'S-005',
  parent: 'F-002',
  title: 'Code Review Backend',
  status: 'In Review',
  priority: 'low',
  labels: ['backend'],
  spec: null,
};

const FEATURE_WITH_PROGRESS = {
  id: 'F-001',
  title: 'Authentication',
  status: 'In Progress',
  priority: 'high',
  // progress explicitly provided (AC5 — use directly)
  progress: { done: 1, total: 3 },
  stories: [STORY_TODO, STORY_IN_PROGRESS, STORY_DONE],
};

const FEATURE_NO_PROGRESS = {
  id: 'F-002',
  title: 'CI/CD Pipeline',
  status: 'Blocked',
  priority: 'high',
  // No progress field — compute from stories (AC5)
  stories: [STORY_BLOCKED, STORY_IN_REVIEW],
};

const FEATURE_EMPTY = {
  id: 'F-003',
  title: 'Empty Feature',
  status: 'To Do',
  priority: 'low',
  stories: [],
};

const PROJECT_A = {
  slug: 'project-alpha',
  repo_path: '/home/user/Git/alpha',
  project_slug: 'project-alpha',
  schema_version: 1,
  features: [FEATURE_WITH_PROGRESS, FEATURE_NO_PROGRESS],
};

const PROJECT_B = {
  slug: 'project-beta',
  repo_path: '/home/user/Git/beta',
  project_slug: 'project-beta',
  schema_version: 1,
  features: [FEATURE_EMPTY],
};

const PROJECT_ERROR = {
  slug: 'project-broken',
  repo_path: '/home/user/Git/broken',
  error: 'board.yaml not found',
  features: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.location.hash = '';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.location.hash = '';
});

function makeBoardFetch({ projects = [], ok = true } = {}) {
  return jest.fn(async (url) => {
    if (url === '/api/board/projects') {
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => ({ projects }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function renderBoard(props = {}) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(BoardView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

// ── Route registration ────────────────────────────────────────────────────────

describe('dev-gui-board-aggregator — Route registration in useHashRouter', () => {
  it('VIEWS array includes "board"', () => {
    expect(VIEWS).toContain('board');
  });

  it('parseHash returns "board" for "#/board"', () => {
    expect(parseHash('#/board')).toBe('board');
  });

  it('parseHash is case-insensitive for board', () => {
    expect(parseHash('#/BOARD')).toBe('board');
  });
});

// ── AC4 — Mount loads projects exactly once ───────────────────────────────────

describe('dev-gui-board-aggregator — AC4: Mount loads projects exactly once', () => {
  it('calls GET /api/board/projects exactly once on mount', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    renderBoard();

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects');
      expect(calls).toHaveLength(1);
    });
  });

  it('does NOT call GET /api/board/projects again on re-render', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { rerender } = renderBoard();

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects')).toHaveLength(1);
    });

    await act(async () => {
      rerender(React.createElement(BoardView, { onNavigate: jest.fn() }));
    });

    expect(globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects')).toHaveLength(1);
  });

  it('shows aria-busy loading state during fetch', async () => {
    let resolveProjects;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects') {
        await new Promise((r) => { resolveProjects = r; });
        return { ok: true, json: async () => ({ projects: [PROJECT_A] }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderBoard();

    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    await act(async () => { resolveProjects(); });

    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
  });

  it('renders project sections after load', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A, PROJECT_B] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
      expect(container.querySelector('[data-project="project-beta"]')).toBeTruthy();
    });
  });

  it('renders feature rows within a project', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-001"]')).toBeTruthy();
      expect(container.querySelector('[data-feature="F-002"]')).toBeTruthy();
    });
  });

  it('renders story cards within a feature', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('renders all five status columns for a feature (AC4 status columns)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-001"]');
      expect(feature.querySelector('[data-status="To Do"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="In Progress"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="Blocked"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="In Review"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="Done"]')).toBeTruthy();
    });
  });

  it('places stories in the correct status column (AC4)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const toDoCol = container.querySelector('[data-status="To Do"]');
      expect(toDoCol.querySelector('[data-story="S-001"]')).toBeTruthy();

      const inProgressCol = container.querySelector('[data-status="In Progress"]');
      expect(inProgressCol.querySelector('[data-story="S-002"]')).toBeTruthy();

      const doneCol = container.querySelector('[data-status="Done"]');
      expect(doneCol.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('renders story title and id (AC3 model fields)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container, getByText } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(getByText('Erstelle Login-Seite')).toBeTruthy();
    });
  });

  it('<main> has aria-label "Board-Übersicht" (A11y)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [] });

    const { getByRole } = renderBoard();

    expect(getByRole('main', { name: /board-übersicht/i })).toBeTruthy();
  });
});

// ── AC4 — Empty + Error state ─────────────────────────────────────────────────

describe('dev-gui-board-aggregator — AC4: Empty and Error states', () => {
  it('shows hint when projects list is empty', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[role="status"]')).toBeTruthy();
    });

    expect(container.querySelector('[role="status"]').textContent).toMatch(/keine projekte/i);
  });

  it('shows error alert when fetch fails with HTTP error', async () => {
    globalThis.fetch = makeBoardFetch({ ok: false });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('shows error alert when fetch throws (network error)', async () => {
    globalThis.fetch = jest.fn(async () => { throw new Error('Network error'); });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('<main> remains in DOM when fetch fails (shell stays usable)', async () => {
    globalThis.fetch = jest.fn(async () => { throw new Error('Network error'); });

    const { getByRole } = renderBoard();

    await waitFor(() => {
      expect(getByRole('main', { name: /board-übersicht/i })).toBeTruthy();
    });
  });

  it('renders project with error badge and skips features (AC8 / V8)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_ERROR, PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const broken = container.querySelector('[data-project="project-broken"]');
      expect(broken).toBeTruthy();
      expect(broken.querySelector('[role="status"]').textContent).toMatch(/fehler/i);

      // Good project still visible
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
  });
});

// ── AC5 — Rollup display ──────────────────────────────────────────────────────

describe('dev-gui-board-aggregator — AC5: Rollup display', () => {
  it('shows progress from progress field when present (AC5 — use existing)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-001"]');
      const rollup = feature.querySelector('[data-testid="rollup-bar"]');
      expect(rollup).toBeTruthy();
      // FEATURE_WITH_PROGRESS has progress: { done: 1, total: 3 }
      expect(rollup.textContent).toMatch(/1\/3/);
    });
  });

  it('computes rollup from child stories when progress is missing (AC5 — fallback)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-002"]');
      const rollup = feature.querySelector('[data-testid="rollup-bar"]');
      expect(rollup).toBeTruthy();
      // FEATURE_NO_PROGRESS: stories = [BLOCKED, IN_REVIEW] → 0 done, 2 total
      expect(rollup.textContent).toMatch(/0\/2/);
    });
  });

  it('progressbar has role="progressbar" with aria-valuenow (A11y)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const progressbars = container.querySelectorAll('[role="progressbar"]');
      expect(progressbars.length).toBeGreaterThan(0);
      for (const pb of progressbars) {
        expect(pb.hasAttribute('aria-valuenow')).toBe(true);
        expect(pb.hasAttribute('aria-valuemin')).toBe(true);
        expect(pb.hasAttribute('aria-valuemax')).toBe(true);
      }
    });
  });

  it('progressbar aria-valuenow equals 33 for 1/3 done (rounded)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      // F-001 has progress { done: 1, total: 3 } → 33%
      const feature = container.querySelector('[data-feature="F-001"]');
      const pb = feature.querySelector('[role="progressbar"]');
      expect(parseInt(pb.getAttribute('aria-valuenow'), 10)).toBe(33);
    });
  });

  it('progressbar aria-valuenow equals 0 for 0/2 done', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      // F-002 has no progress and 0 done stories → 0%
      const feature = container.querySelector('[data-feature="F-002"]');
      const pb = feature.querySelector('[role="progressbar"]');
      expect(parseInt(pb.getAttribute('aria-valuenow'), 10)).toBe(0);
    });
  });

  it('shows "0/0 done" for feature with no stories (empty feature)', async () => {
    const projectWithEmpty = {
      slug: 'project-x',
      features: [FEATURE_EMPTY],
    };
    globalThis.fetch = makeBoardFetch({ projects: [projectWithEmpty] });

    const { container } = renderBoard();

    await waitFor(() => {
      const rollup = container.querySelector('[data-testid="rollup-bar"]');
      expect(rollup.textContent).toMatch(/0\/0/);
    });
  });

  it('uses progress.done=2 progress.total=3 when progress field provided (not recount)', async () => {
    // Feature with progress.done=2, total=3 but 0 actual done stories
    const featureStaleProgress = {
      id: 'F-stale',
      title: 'Stale Progress Feature',
      status: 'In Progress',
      priority: 'high',
      progress: { done: 2, total: 3 },
      stories: [
        { id: 'S-x1', parent: 'F-stale', title: 'Story 1', status: 'To Do', labels: [] },
        { id: 'S-x2', parent: 'F-stale', title: 'Story 2', status: 'In Progress', labels: [] },
      ],
    };
    globalThis.fetch = makeBoardFetch({
      projects: [{ slug: 'project-stale', features: [featureStaleProgress] }],
    });

    const { container } = renderBoard();

    await waitFor(() => {
      const rollup = container.querySelector('[data-testid="rollup-bar"]');
      // Must show 2/3 from progress field, not 0/2 from stories
      expect(rollup.textContent).toMatch(/2\/3/);
    });
  });
});

// ── AC6 — Filter ──────────────────────────────────────────────────────────────

describe('dev-gui-board-aggregator — AC6: Filter', () => {
  it('renders project filter dropdown with project slugs', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A, PROJECT_B] });

    const { container } = renderBoard();

    await waitFor(() => {
      const select = container.querySelector('#board-filter-project');
      expect(select).toBeTruthy();
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain('project-alpha');
      expect(options).toContain('project-beta');
    });
  });

  it('renders status filter dropdown with all five status lifecycle values', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const select = container.querySelector('#board-filter-status');
      expect(select).toBeTruthy();
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain('To Do');
      expect(options).toContain('In Progress');
      expect(options).toContain('Blocked');
      expect(options).toContain('In Review');
      expect(options).toContain('Done');
    });
  });

  it('renders label filter dropdown with labels from all stories', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const select = container.querySelector('#board-filter-label');
      expect(select).toBeTruthy();
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain('frontend');
      expect(options).toContain('backend');
      expect(options).toContain('auth');
    });
  });

  it('filtering by project only shows that project (AC6)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A, PROJECT_B] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
      expect(container.querySelector('[data-project="project-beta"]')).toBeTruthy();
    });

    // Select project-alpha only
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-project'), {
        target: { value: 'project-alpha' },
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
      expect(container.querySelector('[data-project="project-beta"]')).toBeNull();
    });
  });

  it('filtering by status only shows stories with that status (AC6)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });

    // Filter: only 'Done'
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-status'), {
        target: { value: 'Done' },
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
      expect(container.querySelector('[data-story="S-002"]')).toBeNull();
    });
  });

  it('filtering by label only shows stories with that label (AC6)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // Filter: label 'ci'
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: 'ci' },
      });
    });

    await waitFor(() => {
      // S-004 has label 'ci', others don't
      expect(container.querySelector('[data-story="S-004"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
      expect(container.querySelector('[data-story="S-002"]')).toBeNull();
      expect(container.querySelector('[data-story="S-003"]')).toBeNull();
    });
  });

  it('filters can be combined independently (AC6)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A, PROJECT_B] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // Combine: project=alpha AND status=Done
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-project'), {
        target: { value: 'project-alpha' },
      });
      fireEvent.change(container.querySelector('#board-filter-status'), {
        target: { value: 'Done' },
      });
    });

    await waitFor(() => {
      // project-beta not shown (project filter)
      expect(container.querySelector('[data-project="project-beta"]')).toBeNull();
      // S-003 is Done in alpha
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
      // S-001 is To Do — filtered out by status
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
    });
  });

  it('shows reset button when any filter is active', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A, PROJECT_B] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // No filter active yet — no reset button
    expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeNull();

    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-project'), {
        target: { value: 'project-alpha' },
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeTruthy();
    });
  });

  it('reset button clears all filters and shows all projects again', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A, PROJECT_B] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // Set a filter
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-project'), {
        target: { value: 'project-alpha' },
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-beta"]')).toBeNull();
    });

    // Click reset
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="Filter zurücksetzen"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
      expect(container.querySelector('[data-project="project-beta"]')).toBeTruthy();
    });
  });

  it('shows "Keine Stories passen" hint when status-filter eliminates all stories (AC6 — filter empty-state)', async () => {
    // PROJECT_B has FEATURE_EMPTY (stories: []) — a status filter that matches nothing
    // leaves project nodes intact but zero filtered stories
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_B] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-beta"]')).toBeTruthy();
    });

    // Apply a status filter that has no match in PROJECT_B (empty feature, zero stories)
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-status'), {
        target: { value: 'Done' },
      });
    });

    await waitFor(() => {
      // Project node still present (filteredProjects.length >= 1)
      expect(container.querySelector('[data-project="project-beta"]')).toBeTruthy();
      // But the "no stories" hint must appear
      const hints = Array.from(container.querySelectorAll('[role="status"]'));
      const noStoriesHint = hints.find((el) =>
        /keine stories passen/i.test(el.textContent),
      );
      expect(noStoriesHint).toBeTruthy();
    });
  });

  it('shows "Keine Stories passen" hint when label-filter eliminates all stories (AC6 — label filter empty-state)', async () => {
    // Build a project whose stories carry only label 'auth-only'.
    // A second project (not used in the project filter) carries label 'devops-only',
    // so both labels appear in the dropdown.  When we filter by project-auth-only AND
    // label 'devops-only', zero stories survive from that project → hint must appear.
    const STORY_AUTH = {
      id: 'SA-001',
      parent: 'FA-001',
      title: 'Auth Story',
      status: 'To Do',
      priority: 'high',
      labels: ['auth-only'],
      spec: null,
    };
    const PROJECT_AUTH_ONLY = {
      slug: 'project-auth-only',
      features: [{ id: 'FA-001', title: 'Auth Feature', stories: [STORY_AUTH] }],
    };
    const STORY_DEVOPS = {
      id: 'SD-001',
      parent: 'FD-001',
      title: 'Devops Story',
      status: 'To Do',
      priority: 'low',
      labels: ['devops-only'],
      spec: null,
    };
    const PROJECT_DEVOPS_ONLY = {
      slug: 'project-devops-only',
      features: [{ id: 'FD-001', title: 'Devops Feature', stories: [STORY_DEVOPS] }],
    };

    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_AUTH_ONLY, PROJECT_DEVOPS_ONLY] });

    const { container } = renderBoard();

    await waitFor(() => {
      // Both projects loaded
      expect(container.querySelector('[data-project="project-auth-only"]')).toBeTruthy();
      expect(container.querySelector('[data-project="project-devops-only"]')).toBeTruthy();
      // Both labels in the dropdown
      const select = container.querySelector('#board-filter-label');
      const opts = Array.from(select.options).map((o) => o.value);
      expect(opts).toContain('auth-only');
      expect(opts).toContain('devops-only');
    });

    // Step 1: scope to project-auth-only (project filter)
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-project'), {
        target: { value: 'project-auth-only' },
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-devops-only"]')).toBeNull();
    });

    // Step 2: filter by 'devops-only' label — valid option in dropdown, but
    // project-auth-only has NO story with that label → totalFilteredStories = 0
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: 'devops-only' },
      });
    });

    await waitFor(() => {
      // Project node still present (filteredProjects.length >= 1)
      expect(container.querySelector('[data-project="project-auth-only"]')).toBeTruthy();
      // The "no stories" hint must appear
      const hints = Array.from(container.querySelectorAll('[role="status"]'));
      const noStoriesHint = hints.find((el) =>
        /keine stories passen/i.test(el.textContent),
      );
      expect(noStoriesHint).toBeTruthy();
    });
  });

  it('does NOT call /api/board/projects again when filters change (AC6 — client-side only)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A, PROJECT_B] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const callsBefore = globalThis.fetch.mock.calls.length;

    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-status'), {
        target: { value: 'Done' },
      });
    });

    // No additional fetch calls after filter change
    expect(globalThis.fetch.mock.calls.length).toBe(callsBefore);
  });

  it('filter dropdowns have aria-labels (A11y)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const projectSelect = container.querySelector('#board-filter-project');
      const statusSelect = container.querySelector('#board-filter-status');
      const labelSelect = container.querySelector('#board-filter-label');

      expect(projectSelect.getAttribute('aria-label')).toMatch(/projekt/i);
      expect(statusSelect.getAttribute('aria-label')).toMatch(/status/i);
      expect(labelSelect.getAttribute('aria-label')).toMatch(/label/i);
    });
  });
});

// ── AC4/A11y — Status badges ──────────────────────────────────────────────────

describe('dev-gui-board-aggregator — AC4/A11y: Status badges have text labels', () => {
  it('status column headers carry aria-label with status text (meaning not only colour)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const statusBadges = container.querySelectorAll('[aria-label^="Status:"]');
      expect(statusBadges.length).toBeGreaterThan(0);
      for (const badge of statusBadges) {
        expect(badge.textContent.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it('project section has aria-label with project slug', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const section = container.querySelector('[data-project="project-alpha"]');
      expect(section.getAttribute('aria-label')).toMatch(/projekt/i);
    });
  });

  it('story cards have aria-label with story title', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const card = container.querySelector('[data-story="S-001"]');
      expect(card.getAttribute('aria-label')).toMatch(/story/i);
    });
  });

  it('label chips are rendered with aria-label per chip', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      const labelChips = container.querySelectorAll('[aria-label^="Label:"]');
      expect(labelChips.length).toBeGreaterThan(0);
      for (const chip of labelChips) {
        expect(chip.textContent.trim().length).toBeGreaterThan(0);
      }
    });
  });
});

// ── Security floor ────────────────────────────────────────────────────────────

describe('dev-gui-board-aggregator — Security floor', () => {
  it('only /api/board/* URLs are called (no other endpoints)', async () => {
    globalThis.fetch = makeBoardFetch({ projects: [PROJECT_A] });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    for (const call of globalThis.fetch.mock.calls) {
      expect(call[0]).toMatch(/^\/api\/board\//);
    }
  });
});
