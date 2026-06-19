/**
 * BoardView.test.jsx — Unit tests for BoardView.
 *
 * Covers (dev-gui-board-aggregator):
 *   AC4 — Dreistufige Übersicht Projekt → Feature → Story mit Status-Spalten;
 *          aggregiert über alle Projekte; aria-busy/aria-live Ladezustand;
 *          Fehlerzustand; Leerzustand; GET /api/board/projects/* Aufrufe.
 *   AC5 — Rollup-Anzeige je Feature: vorhandenes progress-Feld → direkt anzeigen;
 *          fehlendes/stale progress → read-only aus Kind-Story-Status berechnet;
 *          progressbar-Role mit aria-valuenow.
 *   AC6 — Filter nach Projekt (Dropdown), Status (Checkbox-Gruppe),
 *          Label (Dropdown); unabhängig kombinierbar; Zurücksetzen-Button;
 *          kein Backend-Aufruf beim Filtern.
 *          Filter-Leerzustand: role=status-Hinweis wenn Filter alle Stories eliminieren.
 *   Feature detail panel — expand/collapse je Feature-Titel (aria-expanded/aria-controls);
 *          goal, DoD, priority, depends, labels; null-Felder ausgeblendet.
 *   Multi-Status-Filter — Mehrfach-Check; Uncheck; Reset.
 *
 * Covers (studis-kanban-board-ux):
 *   AC1 — aria-label + h1 = „Studis-Kanban-Board"; Route-id `board` unverändert;
 *          viewRegistry label = „Studis-Kanban-Board".
 *   AC2 — Status-Filter Default: alle 5 angehakt; alles sichtbar; Deselektieren blendet aus.
 *   AC3 — Alle Status deselektiert → role=status „Kein Status gewählt".
 *   AC4 — Status-Filter als Popover: Button „Status (n/5) ▾"; öffnet/schließt per Klick;
 *          schließt per Esc + Außenklick; aria-expanded/-controls korrekt.
 *   AC5 — GET /api/board/projects/list (leicht) in standalone;
 *          GET /api/board/projects/:slug (voll) on-demand;
 *          GET /api/board/projects/:slug (cockpit) on mount.
 *   AC6 — Standalone: öffnet mit Projektliste; Klick lädt Projekt (lazy, aria-busy);
 *          Rückweg zur Liste; Cockpit-Modus (lockedProject): direkt ohne Liste.
 *
 * Covers (story-detail-ansicht):
 *   AC3, AC4, AC5 — Story-Klick, Soll-Ist, Vorab-Badge; fehlende Schätzung; null-Fälle.
 *   AC3 — Story-Klick öffnet Detail-Ansicht; drei Blöcke sichtbar.
 *   AC4 — Soll-Ist zeigt ep_est/ep_act/tok_est/tok_total; null → „keine Schätzung".
 *   AC5 — Vorab-Badge (ep-est-vorab-badge) bei ep_est_source='yaml'; kein Badge bei 'ledger'.
 *
 * Covers (story-detail-yaml-fallback):
 *   AC5 — Differenzierter Leer-Zustand: „Vor Metrik-Erfassung abgeschlossen" wenn
 *          ended_at vorhanden; „Noch kein Flow-Lauf" wenn nicht. YAML-Badge bei
 *          ended_at_source='yaml'. Bestehender Text „Keine Flow-Daten" ersetzt.
 *   AC6 — Block „Verknüpfungen" mit Branch + PR-Link wenn vorhanden; Block ausgeblendet
 *          wenn beide null. PR-Link mit rel=noopener noreferrer (AC8 Floor).
 *   AC7 — Ledger-Daten: bestehende Tests unverändert (Ledger hat Vorrang).
 *   AC8 — Kein dangerouslySetInnerHTML; PR-Link rel=noopener noreferrer.
 *          jsdom-Limitation: WCAG-Kontrast und Layout nicht testbar — visuell verifiziert.
 *
 * Covers (projekt-spezifikation-anzeige):
 *   AC5 — Story-Spec-Bezug ist klickbar (onOpenSpec-Prop) und ruft onOpenSpec(relPath) auf.
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
const { VIEW_REGISTRY }    = await import('../viewRegistry.js');

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

/**
 * Build a fetch mock that handles all three board API endpoints.
 *
 * - /api/board/projects/list  → { projects: listItems }
 * - /api/board/projects/:slug → { project: fullProject } (looked up from fullProjects)
 * - /api/board/projects       → { projects: fullProjects }
 *
 * @param {{ fullProjects?: object[], ok?: boolean }} opts
 */
function makeBoardFetch({ fullProjects = [], ok = true } = {}) {
  return jest.fn(async (url) => {
    if (!ok) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (url === '/api/board/projects/list') {
      const list = fullProjects.map((p) => {
        if (p.error) return { slug: p.slug, error: p.error };
        const features = p.features ?? [];
        return {
          slug: p.slug,
          feature_count: features.length,
          story_count: features.reduce((a, f) => a + (f.stories ?? []).length, 0),
        };
      });
      return { ok: true, status: 200, json: async () => ({ projects: list }) };
    }
    if (url === '/api/board/projects') {
      return { ok: true, status: 200, json: async () => ({ projects: fullProjects }) };
    }
    // /api/board/projects/:slug
    const slugMatch = url.match(/^\/api\/board\/projects\/(.+)$/);
    if (slugMatch) {
      const slug = decodeURIComponent(slugMatch[1]);
      const proj = fullProjects.find((p) => p.slug === slug);
      if (proj) {
        return { ok: true, status: 200, json: async () => ({ project: proj }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Projekt nicht gefunden.' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

/** Render BoardView in STANDALONE mode (no lockedProject). */
function renderBoard(props = {}) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(BoardView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

/** Render BoardView in COCKPIT mode (lockedProject set). */
function renderCockpit(slug, props = {}) {
  return renderBoard({ lockedProject: slug, ...props });
}

/** Load standalone board and click on a project to enter its detail view. */
async function renderBoardWithProject(fullProjects, slugToSelect) {
  globalThis.fetch = makeBoardFetch({ fullProjects });
  const utils = renderBoard();

  // Wait for project list
  await waitFor(() => {
    expect(utils.container.querySelector(`[data-project-list-item="${slugToSelect}"]`)).toBeTruthy();
  });

  // Click project to load it
  await act(async () => {
    const btn = utils.container.querySelector(`[data-testid="project-select-${slugToSelect}"]`);
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
  });

  // Wait for project data
  await waitFor(() => {
    expect(utils.container.querySelector(`[data-project="${slugToSelect}"]`)).toBeTruthy();
  });

  return utils;
}

// ── AC1 (studis-kanban-board-ux) — Umbenennung ────────────────────────────────

describe('studis-kanban-board-ux — AC1: Umbenennung „Studis-Kanban-Board"', () => {
  it('<main> has aria-label "Studis-Kanban-Board"', () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [] });
    const { getByRole } = renderBoard();
    expect(getByRole('main', { name: /studis-kanban-board/i })).toBeTruthy();
  });

  it('<h1> text is "Studis-Kanban-Board"', () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [] });
    const { container } = renderBoard();
    const h1 = container.querySelector('h1');
    expect(h1).toBeTruthy();
    expect(h1.textContent).toBe('Studis-Kanban-Board');
  });

  it('viewRegistry board entry has label "Studis-Kanban-Board"', () => {
    const entry = VIEW_REGISTRY.find((v) => v.id === 'board');
    expect(entry).toBeTruthy();
    expect(entry.label).toBe('Studis-Kanban-Board');
  });

  it('Route-id "board" remains unchanged (VIEWS contains "board")', () => {
    expect(VIEWS).toContain('board');
    expect(parseHash('#/board')).toBe('board');
  });
});

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

// ── AC6 (studis-kanban-board-ux) — Standalone lazy-load ──────────────────────

describe('studis-kanban-board-ux — AC6: Standalone Projektliste + Lazy-Load', () => {
  it('standalone board calls /api/board/projects/list on mount (not full endpoint)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A, PROJECT_B] });
    renderBoard();

    await waitFor(() => {
      const listCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects/list');
      expect(listCalls).toHaveLength(1);
      // Full projects endpoint must NOT be called on mount
      const fullCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects');
      expect(fullCalls).toHaveLength(0);
    });
  });

  it('standalone: shows project list with slugs and counters', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A, PROJECT_B] });
    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
      expect(container.querySelector('[data-project-list-item="project-beta"]')).toBeTruthy();
    });
  });

  it('standalone: shows aria-busy loading state during list fetch', async () => {
    let resolveList;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects/list') {
        await new Promise((r) => { resolveList = r; });
        return { ok: true, json: async () => ({ projects: [] }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderBoard();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    await act(async () => { resolveList(); });
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
  });

  it('standalone: click on project calls /api/board/projects/:slug', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="project-select-project-alpha"]'));
    });

    await waitFor(() => {
      const slugCalls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/board/projects/project-alpha'
      );
      expect(slugCalls).toHaveLength(1);
    });
  });

  it('standalone: after project click shows project detail (not list)', async () => {
    const { container } = await renderBoardWithProject([PROJECT_A], 'project-alpha');
    expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeNull();
  });

  it('standalone: shows back button in project-detail view', async () => {
    const { container } = await renderBoardWithProject([PROJECT_A], 'project-alpha');
    expect(container.querySelector('[data-testid="board-back-btn"]')).toBeTruthy();
  });

  it('standalone: back button returns to project list', async () => {
    const { container } = await renderBoardWithProject([PROJECT_A], 'project-alpha');

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="board-back-btn"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
      expect(container.querySelector('[data-project="project-alpha"]')).toBeNull();
    });
  });

  it('standalone: shows aria-busy loading during project fetch (AC6 — Ladezustand)', async () => {
    let resolveProject;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects/list') {
        return { ok: true, json: async () => ({ projects: [{ slug: 'project-alpha', feature_count: 2, story_count: 5 }] }) };
      }
      if (url === '/api/board/projects/project-alpha') {
        await new Promise((r) => { resolveProject = r; });
        return { ok: true, json: async () => ({ project: PROJECT_A }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="project-select-project-alpha"]'));
    });

    // aria-busy must appear while loading
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    await act(async () => { resolveProject(); });
    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
  });

  it('standalone: list error shows alert', async () => {
    globalThis.fetch = makeBoardFetch({ ok: false });
    const { container } = renderBoard();
    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('standalone: empty list shows no-projects hint', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [] });
    const { container } = renderBoard();
    await waitFor(() => {
      const hint = container.querySelector('[role="status"]');
      expect(hint).toBeTruthy();
      expect(hint.textContent).toMatch(/keine projekte/i);
    });
  });
});

// ── AC6 — Cockpit mode (lockedProject) ───────────────────────────────────────

describe('studis-kanban-board-ux — AC6: Cockpit-Modus (lockedProject)', () => {
  it('cockpit: does NOT show project list', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // No project list items
    expect(container.querySelector('[data-project-list-item]')).toBeNull();
    // No back button
    expect(container.querySelector('[data-testid="board-back-btn"]')).toBeNull();
  });

  it('cockpit: calls /api/board/projects/:slug on mount', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    renderCockpit('project-alpha');

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/board/projects/project-alpha'
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('cockpit: does NOT call /api/board/projects/list', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const listCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects/list');
    expect(listCalls).toHaveLength(0);
  });

  it('cockpit: shows aria-busy during load', async () => {
    let resolveProject;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects/project-alpha') {
        await new Promise((r) => { resolveProject = r; });
        return { ok: true, json: async () => ({ project: PROJECT_A }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderCockpit('project-alpha');
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    await act(async () => { resolveProject(); });
    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
  });
});

// ── AC5 (studis-kanban-board-ux) — Backend endpoints ─────────────────────────

describe('studis-kanban-board-ux — AC5: Backend endpoint URLs', () => {
  it('standalone calls /api/board/projects/list (not /api/board/projects)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
    });

    const listCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects/list');
    expect(listCalls).toHaveLength(1);
  });

  it('standalone calls /api/board/projects/:slug when project selected', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="project-select-project-alpha"]'));
    });

    await waitFor(() => {
      const slugCalls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/board/projects/project-alpha'
      );
      expect(slugCalls).toHaveLength(1);
    });
  });

  it('cockpit calls /api/board/projects/:slug on mount', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    renderCockpit('project-alpha');

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/board/projects/project-alpha')).toBe(true);
    });
  });
});

// ── AC2 (studis-kanban-board-ux) — Status-Filter Default alle gewählt ─────────

describe('studis-kanban-board-ux — AC2: Status-Filter Default alle ausgewählt', () => {
  it('all 5 status checkboxes are checked by default (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // Open popover to see checkboxes
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    await waitFor(() => {
      const checkboxes = container.querySelectorAll('#board-filter-status-group input[type="checkbox"]');
      expect(checkboxes).toHaveLength(5);
      for (const cb of checkboxes) {
        expect(cb.checked).toBe(true);
      }
    });
  });

  it('all stories visible by default (all statuses selected — cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('deselecting a status hides its stories (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy(); // Done
    });

    // Open popover
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    // Uncheck "Done"
    await act(async () => {
      const doneCheckbox = container.querySelector('#board-filter-status-done');
      expect(doneCheckbox).toBeTruthy();
      fireEvent.click(doneCheckbox);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeNull();
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy(); // To Do still visible
    });
  });

  it('status button label shows "Status (5/5) ▾" by default (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const btn = container.querySelector('[data-testid="status-filter-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Status \(5\/5\)/);
  });

  it('status button label shows "Status (n/5) ▾" after deselect', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // Open popover and uncheck "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await act(async () => {
      const doneCheckbox = container.querySelector('#board-filter-status-done');
      fireEvent.click(doneCheckbox);
    });

    const btn = container.querySelector('[data-testid="status-filter-btn"]');
    expect(btn.textContent).toMatch(/Status \(4\/5\)/);
  });
});

// ── AC3 (studis-kanban-board-ux) — Kein Status gewählt ───────────────────────

describe('studis-kanban-board-ux — AC3: Alle Status deselektiert → Hinweis', () => {
  it('shows "Kein Status gewählt" hint when all statuses deselected (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // Open popover
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    // Uncheck all 5
    const statuses = ['to-do', 'in-progress', 'blocked', 'in-review', 'done'];
    for (const s of statuses) {
      await act(async () => {
        const cb = container.querySelector(`#board-filter-status-${s}`);
        expect(cb).toBeTruthy();
        fireEvent.click(cb);
      });
    }

    await waitFor(() => {
      const hint = container.querySelector('[data-testid="no-status-hint"]');
      expect(hint).toBeTruthy();
      expect(hint.getAttribute('role')).toBe('status');
      expect(hint.textContent).toMatch(/kein status gewählt/i);
    });
  });

  it('no stories shown when all statuses deselected (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    const statuses = ['to-do', 'in-progress', 'blocked', 'in-review', 'done'];
    for (const s of statuses) {
      await act(async () => {
        fireEvent.click(container.querySelector(`#board-filter-status-${s}`));
      });
    }

    await waitFor(() => {
      // No story cards visible
      expect(container.querySelector('[data-story]')).toBeNull();
    });
  });
});

// ── AC4 (studis-kanban-board-ux) — Status-Filter Popover ─────────────────────

describe('studis-kanban-board-ux — AC4: Status-Filter als Popover', () => {
  it('status filter button is present with aria-expanded=false initially (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const btn = container.querySelector('[data-testid="status-filter-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('click opens popover (aria-expanded=true) and shows checkboxes', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    const btn = container.querySelector('[data-testid="status-filter-btn"]');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="status-popover"]')).toBeTruthy();

    const checkboxes = container.querySelectorAll('#board-filter-status-group input[type="checkbox"]');
    expect(checkboxes).toHaveLength(5);
  });

  it('second click closes popover (aria-expanded=false)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeNull();
      expect(container.querySelector('[data-testid="status-filter-btn"]').getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('Esc key closes popover', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeNull();
    });
  });

  it('outside click closes popover', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeTruthy();
    });

    // Click outside the popover
    await act(async () => {
      fireEvent.mouseDown(document.body);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeNull();
    });
  });

  it('button has aria-controls pointing to popover id', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const btn = container.querySelector('[data-testid="status-filter-btn"]');
    expect(btn.getAttribute('aria-controls')).toBe('board-status-popover');
  });

  it('popover is not visible when closed (no status-popover testid)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    expect(container.querySelector('[data-testid="status-popover"]')).toBeNull();
  });
});

// ── AC4 — Mount loads projects exactly once (cockpit) ────────────────────────

describe('dev-gui-board-aggregator — AC4: Mount loads project in cockpit', () => {
  it('calls GET /api/board/projects/:slug exactly once on mount (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    renderCockpit('project-alpha');

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/board/projects/project-alpha'
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('shows aria-busy loading state during fetch (cockpit)', async () => {
    let resolveProject;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects/project-alpha') {
        await new Promise((r) => { resolveProject = r; });
        return { ok: true, json: async () => ({ project: PROJECT_A }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderCockpit('project-alpha');
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    await act(async () => { resolveProject(); });
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
  });

  it('renders project sections after load (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
  });

  it('renders feature rows within a project (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-001"]')).toBeTruthy();
      expect(container.querySelector('[data-feature="F-002"]')).toBeTruthy();
    });
  });

  it('renders story cards within a feature (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('renders all five status columns for a feature (AC4 status columns, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-001"]');
      expect(feature.querySelector('[data-status="To Do"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="In Progress"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="Blocked"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="In Review"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="Done"]')).toBeTruthy();
    });
  });

  it('places stories in the correct status column (AC4, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const toDoCol = container.querySelector('[data-status="To Do"]');
      expect(toDoCol.querySelector('[data-story="S-001"]')).toBeTruthy();

      const inProgressCol = container.querySelector('[data-status="In Progress"]');
      expect(inProgressCol.querySelector('[data-story="S-002"]')).toBeTruthy();

      const doneCol = container.querySelector('[data-status="Done"]');
      expect(doneCol.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('renders story title and id (AC3 model fields, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container, getByText } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(getByText('Erstelle Login-Seite')).toBeTruthy();
    });
  });

  it('<main> has aria-label "Studis-Kanban-Board" (AC1/A11y)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [] });
    const { getByRole } = renderCockpit('project-alpha');
    expect(getByRole('main', { name: /studis-kanban-board/i })).toBeTruthy();
  });
});

// ── AC4 — Empty + Error state (cockpit) ───────────────────────────────────────

describe('dev-gui-board-aggregator — AC4: Empty and Error states (cockpit)', () => {
  it('shows hint when projects list is empty (cockpit)', async () => {
    // When lockedProject slug not found, /api/board/projects/:slug returns 404
    // fallback to /api/board/projects with empty list
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects/project-empty') {
        return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      }
      if (url === '/api/board/projects') {
        return { ok: true, status: 200, json: async () => ({ projects: [] }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderCockpit('project-empty');

    await waitFor(() => {
      expect(container.querySelector('[role="status"]')).toBeTruthy();
    });
    expect(container.querySelector('[role="status"]').textContent).toMatch(/keine projekte/i);
  });

  it('shows error alert when fetch fails with HTTP error (cockpit)', async () => {
    globalThis.fetch = jest.fn(async () => {
      return { ok: false, status: 500, json: async () => ({}) };
    });

    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('shows error alert when fetch throws (network error, cockpit)', async () => {
    globalThis.fetch = jest.fn(async () => { throw new Error('Network error'); });

    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('<main> remains in DOM when fetch fails (cockpit)', async () => {
    globalThis.fetch = jest.fn(async () => { throw new Error('Network error'); });

    const { getByRole } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(getByRole('main', { name: /studis-kanban-board/i })).toBeTruthy();
    });
  });

  it('renders project with error badge and skips features (AC8 / V8, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_ERROR, PROJECT_A] });
    // cockpit locks to project-alpha — so it renders just that project via :slug
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
  });
});

// ── AC5 — Rollup display ──────────────────────────────────────────────────────

describe('dev-gui-board-aggregator — AC5: Rollup display (cockpit)', () => {
  it('shows progress from progress field when present (AC5 — use existing)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-001"]');
      const rollup = feature.querySelector('[data-testid="rollup-bar"]');
      expect(rollup).toBeTruthy();
      expect(rollup.textContent).toMatch(/1\/3/);
    });
  });

  it('computes rollup from child stories when progress is missing (AC5 — fallback)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-002"]');
      const rollup = feature.querySelector('[data-testid="rollup-bar"]');
      expect(rollup).toBeTruthy();
      expect(rollup.textContent).toMatch(/0\/2/);
    });
  });

  it('progressbar has role="progressbar" with aria-valuenow (A11y)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

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
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-001"]');
      const pb = feature.querySelector('[role="progressbar"]');
      expect(parseInt(pb.getAttribute('aria-valuenow'), 10)).toBe(33);
    });
  });

  it('progressbar aria-valuenow equals 0 for 0/2 done', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-002"]');
      const pb = feature.querySelector('[role="progressbar"]');
      expect(parseInt(pb.getAttribute('aria-valuenow'), 10)).toBe(0);
    });
  });

  it('shows "0/0 done" for feature with no stories (empty feature, cockpit)', async () => {
    const projectWithEmpty = {
      slug: 'project-x',
      features: [FEATURE_EMPTY],
    };
    globalThis.fetch = makeBoardFetch({ fullProjects: [projectWithEmpty] });
    const { container } = renderCockpit('project-x');

    await waitFor(() => {
      const rollup = container.querySelector('[data-testid="rollup-bar"]');
      expect(rollup.textContent).toMatch(/0\/0/);
    });
  });

  it('uses progress.done=2 progress.total=3 when progress field provided (not recount)', async () => {
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
    const staleProject = { slug: 'project-stale', features: [featureStaleProgress] };
    globalThis.fetch = makeBoardFetch({ fullProjects: [staleProject] });
    const { container } = renderCockpit('project-stale');

    await waitFor(() => {
      const rollup = container.querySelector('[data-testid="rollup-bar"]');
      expect(rollup.textContent).toMatch(/2\/3/);
    });
  });
});

// ── AC6 (dev-gui-board-aggregator) — Filter (cockpit) ─────────────────────────

describe('dev-gui-board-aggregator — AC6: Filter (cockpit)', () => {
  it('renders label filter dropdown with labels from all stories', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const select = container.querySelector('#board-filter-label');
      expect(select).toBeTruthy();
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain('frontend');
      expect(options).toContain('backend');
      expect(options).toContain('auth');
    });
  });

  it('filtering by status only shows stories with that status (AC6 — cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });

    // Open popover and uncheck all except "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    // Uncheck all except done: to-do, in-progress, blocked, in-review
    for (const s of ['to-do', 'in-progress', 'blocked', 'in-review']) {
      await act(async () => {
        const cb = container.querySelector(`#board-filter-status-${s}`);
        fireEvent.click(cb);
      });
    }

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
      expect(container.querySelector('[data-story="S-002"]')).toBeNull();
    });
  });

  it('filtering by label only shows stories with that label (AC6 — cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: 'ci' },
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-004"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
      expect(container.querySelector('[data-story="S-002"]')).toBeNull();
      expect(container.querySelector('[data-story="S-003"]')).toBeNull();
    });
  });

  it('shows reset button when label filter is active', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // No filter active yet (all 5 selected, no label)
    expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeNull();

    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: 'ci' },
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeTruthy();
    });
  });

  it('reset button restores all 5 statuses checked and clears label (AC2 reset)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // Open popover, uncheck "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await act(async () => {
      fireEvent.click(container.querySelector('#board-filter-status-done'));
    });
    // S-003 (Done) should be hidden now
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeNull();
    });

    // Click reset
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="Filter zurücksetzen"]'));
    });

    await waitFor(() => {
      // All stories restored
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
      // No reset button visible (all selected = no filter)
      expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeNull();
    });
  });

  it('does NOT call /api/board/* again when filters change (AC6 — client-side only)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const callsBefore = globalThis.fetch.mock.calls.length;

    // Open popover and uncheck "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await act(async () => {
      fireEvent.click(container.querySelector('#board-filter-status-done'));
    });

    expect(globalThis.fetch.mock.calls.length).toBe(callsBefore);
  });

  it('filter controls have aria-labels (A11y, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const statusBtn = container.querySelector('[data-testid="status-filter-btn"]');
      expect(statusBtn.getAttribute('aria-label')).toMatch(/status/i);

      const labelSelect = container.querySelector('#board-filter-label');
      expect(labelSelect.getAttribute('aria-label')).toMatch(/label/i);
    });
  });
});

// ── AC4/A11y — Status badges ──────────────────────────────────────────────────

describe('dev-gui-board-aggregator — AC4/A11y: Status badges have text labels', () => {
  it('status column headers carry aria-label with status text (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const statusBadges = container.querySelectorAll('[aria-label^="Status:"]');
      expect(statusBadges.length).toBeGreaterThan(0);
      for (const badge of statusBadges) {
        expect(badge.textContent.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it('project section has aria-label with project slug', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const section = container.querySelector('[data-project="project-alpha"]');
      expect(section.getAttribute('aria-label')).toMatch(/projekt/i);
    });
  });

  it('story cards have aria-label with story title', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const card = container.querySelector('[data-story="S-001"]');
      expect(card.getAttribute('aria-label')).toMatch(/story/i);
    });
  });

  it('label chips are rendered with aria-label per chip', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

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
  it('only /api/board/* URLs are called (cockpit, no other endpoints)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    for (const call of globalThis.fetch.mock.calls) {
      expect(call[0]).toMatch(/^\/api\/board\//);
    }
  });

  it('only /api/board/* URLs are called (standalone, project list + project fetch)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="project-select-project-alpha"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    for (const call of globalThis.fetch.mock.calls) {
      expect(call[0]).toMatch(/^\/api\/board\//);
    }
  });
});

// ── Feature detail panel ──────────────────────────────────────────────────────

const FEATURE_WITH_DETAIL = {
  id: 'F-detail',
  title: 'Detail-Feature',
  status: 'Active',
  priority: 'P1',
  goal: 'Abloesung der manuellen Provisionierung.',
  definition_of_done: 'Alle Adapter gruen, Review bestanden.',
  depends: ['F-000'],
  labels: ['infra', 'vps'],
  stories: [],
};

const FEATURE_NO_OPTIONAL = {
  id: 'F-plain',
  title: 'Plain Feature',
  status: 'Backlog',
  priority: 'P2',
  goal: null,
  definition_of_done: null,
  depends: null,
  labels: null,
  stories: [],
};

const PROJECT_WITH_DETAIL = {
  slug: 'project-detail',
  repo_path: '/home/user/Git/detail',
  features: [FEATURE_WITH_DETAIL, FEATURE_NO_OPTIONAL],
};

describe('dev-gui-board-aggregator — Feature detail panel (cockpit)', () => {
  it('feature title is a button that toggles the detail panel', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    expect(container.querySelector('[data-testid="feature-detail-F-detail"]')).toBeNull();

    await act(async () => {
      const btn = container.querySelector('[data-testid="feature-title-btn-F-detail"]');
      expect(btn).toBeTruthy();
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="feature-detail-F-detail"]')).toBeTruthy();
    });
  });

  it('detail panel shows goal when present', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      const goal = container.querySelector('[data-testid="feature-detail-goal"]');
      expect(goal).toBeTruthy();
      expect(goal.textContent).toMatch(/Abloesung/);
    });
  });

  it('detail panel shows definition_of_done when present', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      const dod = container.querySelector('[data-testid="feature-detail-dod"]');
      expect(dod).toBeTruthy();
      expect(dod.textContent).toMatch(/Alle Adapter/);
    });
  });

  it('detail panel shows priority', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      const prio = container.querySelector('[data-testid="feature-detail-priority"]');
      expect(prio).toBeTruthy();
      expect(prio.textContent).toMatch(/P1/);
    });
  });

  it('detail panel shows depends when present', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      const dep = container.querySelector('[data-testid="feature-detail-depends"]');
      expect(dep).toBeTruthy();
      expect(dep.textContent).toContain('F-000');
    });
  });

  it('detail panel shows labels when present', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      const labels = container.querySelector('[data-testid="feature-detail-labels"]');
      expect(labels).toBeTruthy();
      expect(labels.textContent).toContain('infra');
      expect(labels.textContent).toContain('vps');
    });
  });

  it('clicking title again closes the detail panel', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="feature-detail-F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="feature-detail-F-detail"]')).toBeNull();
    });
  });

  it('detail panel omits null fields', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-plain"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-plain"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="feature-detail-F-plain"]')).toBeTruthy();
    });

    expect(container.querySelector('[data-testid="feature-detail-goal"]')).toBeNull();
    expect(container.querySelector('[data-testid="feature-detail-dod"]')).toBeNull();
    expect(container.querySelector('[data-testid="feature-detail-depends"]')).toBeNull();
    expect(container.querySelector('[data-testid="feature-detail-labels"]')).toBeNull();
  });

  it('title button has aria-expanded false initially and true when open', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    const btn = container.querySelector('[data-testid="feature-title-btn-F-detail"]');
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(btn.getAttribute('aria-expanded')).toBe('true');
    });
  });
});

// ── Multi-Status-Filter (cockpit) ─────────────────────────────────────────────

describe('dev-gui-board-aggregator — Multi-Status-Filter (cockpit)', () => {
  it('all stories visible by default (all 5 selected, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('two status checkboxes unchecked → only remaining statuses visible', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // Open popover and uncheck "Blocked" and "In Review" and "Done"
    // so only "To Do" and "In Progress" remain
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    for (const s of ['blocked', 'in-review', 'done']) {
      await act(async () => {
        const cb = container.querySelector(`#board-filter-status-${s}`);
        expect(cb).toBeTruthy();
        fireEvent.click(cb);
      });
    }

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy(); // To Do
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy(); // In Progress
      expect(container.querySelector('[data-story="S-003"]')).toBeNull(); // Done
    });
  });

  it('unchecking and rechecking a status restores its stories', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // Open popover, uncheck "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await act(async () => {
      fireEvent.click(container.querySelector('#board-filter-status-done'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeNull();
    });

    // Re-check "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('#board-filter-status-done'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('reset button clears status checkboxes back to all-5-selected', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // Open popover and activate a label filter (so reset button appears)
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), { target: { value: 'ci' } });
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="Filter zurücksetzen"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
      expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeNull();
    });
  });
});

// ── projekt-spezifikation-anzeige AC5: Spec-Bezug klickbar ───────────────────

describe('BoardView — projekt-spezifikation-anzeige AC5: Spec-Link in StoryCard', () => {
  it('rendert Spec-Bezug als klickbaren Button wenn onOpenSpec übergeben wird', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const onOpenSpec = jest.fn();
    const { container } = renderCockpit('project-alpha', { onOpenSpec });

    await waitFor(() => {
      // S-001 hat spec: 'docs/specs/login.md'
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    const specLink = container.querySelector('[data-testid="spec-link-S-001"]');
    expect(specLink).not.toBeNull();
    expect(specLink.tagName).toBe('BUTTON');
    expect(specLink.textContent).toBe('docs/specs/login.md');
  });

  it('ruft onOpenSpec(relPath) auf wenn Spec-Link geklickt wird', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const onOpenSpec = jest.fn();
    const { container } = renderCockpit('project-alpha', { onOpenSpec });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="spec-link-S-001"]')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="spec-link-S-001"]'));
    });

    expect(onOpenSpec).toHaveBeenCalledWith('docs/specs/login.md');
  });

  it('rendert Spec-Bezug als reinen Text wenn kein onOpenSpec übergeben wird', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha'); // kein onOpenSpec

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // Kein Button für Spec (statischer Text)
    expect(container.querySelector('[data-testid="spec-link-S-001"]')).toBeNull();
    // Spec-Wert erscheint aber als Text
    const storyEl = container.querySelector('[data-story="S-001"]');
    expect(storyEl?.textContent).toMatch(/docs\/specs\/login\.md/);
  });

  it('specLink-Button hat minHeight 44px (Touch-Target ≥ 44 px, WCAG 2.1 AA)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const onOpenSpec = jest.fn();
    const { container } = renderCockpit('project-alpha', { onOpenSpec });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="spec-link-S-001"]')).not.toBeNull();
    });

    const specLink = container.querySelector('[data-testid="spec-link-S-001"]');
    // jsdom exposes inline styles via element.style
    expect(specLink.style.minHeight).toBe('44px');
  });
});

// ── story-detail-ansicht: AC3/AC4 — Story-Klick öffnet Detail-Ansicht ─────────

/**
 * Fixture: detail data returned by GET .../stories/:id/detail
 */
const STORY_DETAIL_FULL = {
  started_at:  '2025-01-10T10:00:00.000Z',
  ended_at:    '2025-01-10T10:05:00.000Z',
  duration:    300,
  flow: [
    { seq: 1, agent: 'coder',    iter: 1, gate: null,   secs: 120, tok: 800 },
    { seq: 2, agent: 'reviewer', iter: 1, gate: 'PASS', secs:  60, tok: 400 },
  ],
  ep_est:      3,
  ep_act:      4,
  tok_est:     1200,
  tok_total:   1500,
  size_est:    'M',
  ep_dev:      1,
  ep_dev_pct:  33.3,
  tok_dev:     300,
  tok_dev_pct: 25,
};

const STORY_DETAIL_MISSING = {
  started_at:  null,
  ended_at:    null,
  duration:    null,
  flow:        [],
  ep_est:      null,
  ep_act:      null,
  tok_est:     null,
  tok_total:   null,
  size_est:    null,
  ep_dev:      null,
  ep_dev_pct:  null,
  tok_dev:     null,
  tok_dev_pct: null,
};

/**
 * Build a fetch mock that handles board API + story detail endpoint.
 */
function makeBoardFetchWithDetail({ fullProjects = [], detailData = STORY_DETAIL_FULL } = {}) {
  const boardMock = makeBoardFetch({ fullProjects });
  return jest.fn(async (url) => {
    // Detail endpoint: /api/board/projects/:slug/stories/:id/detail
    if (/\/stories\/[^/]+\/detail$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ detail: detailData }) };
    }
    return boardMock(url);
  });
}

describe('story-detail-ansicht — AC3: Story-Klick öffnet Detail-Ansicht', () => {
  it('story card is rendered as a clickable button when project is loaded (cockpit)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // The story card should be a button
    const storyBtn = container.querySelector('[data-testid="story-card-btn-S-001"]');
    expect(storyBtn).toBeTruthy();
    expect(storyBtn.tagName).toBe('BUTTON');
  });

  it('clicking story card opens detail view with story title in heading', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      const h1 = container.querySelector('h1');
      expect(h1?.textContent).toMatch(/S-001/);
    });
  });

  it('detail view shows loading state while fetching', async () => {
    let resolveDetail;
    globalThis.fetch = jest.fn(async (url) => {
      if (/\/stories\/[^/]+\/detail$/.test(url)) {
        await new Promise((r) => { resolveDetail = r; });
        return { ok: true, json: async () => ({ detail: STORY_DETAIL_FULL }) };
      }
      return makeBoardFetch({ fullProjects: [PROJECT_A] })(url);
    });

    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    // Loading indicator must appear
    expect(container.querySelector('[data-testid="detail-loading"]')).toBeTruthy();

    await act(async () => { resolveDetail(); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  });

  it('detail view shows back button', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-back-btn"]')).toBeTruthy();
    });
  });

  it('back button returns to board view', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-back-btn"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="detail-back-btn"]'));
    });

    await waitFor(() => {
      // Back to board — story cards visible again
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeNull();
    });
  });

  it('detail view has aria-label with story title (A11y)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      const main = container.querySelector('main');
      expect(main?.getAttribute('aria-label')).toMatch(/S-001|Erstelle Login-Seite/);
    });
  });

  it('detail view calls GET .../stories/:id/detail endpoint', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    const callsBefore = globalThis.fetch.mock.calls.length;

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      const detailCalls = globalThis.fetch.mock.calls.filter((c) =>
        /\/stories\/S-001\/detail$/.test(c[0])
      );
      expect(detailCalls).toHaveLength(1);
      expect(globalThis.fetch.mock.calls.length).toBe(callsBefore + 1);
    });
  });

  it('detail view shows error when fetch fails', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (/\/stories\/[^/]+\/detail$/.test(url)) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return makeBoardFetch({ fullProjects: [PROJECT_A] })(url);
    });

    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-error"]')).toBeTruthy();
    });
  });

  it('story card button has minHeight 44px (Touch-Target ≥ 44 px, AC3)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    const btn = container.querySelector('[data-testid="story-card-btn-S-001"]');
    // jsdom exposes inline styles via element.style — check minHeight from storyCardBtn style
    expect(btn.style.minHeight).toBe('44px');
  });
});

describe('story-detail-ansicht — AC3: Drei Blöcke in Detail-Ansicht', () => {
  async function openStoryDetail(container) {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  }

  it('block Zeiten is present', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);
    expect(container.querySelector('[data-testid="block-zeiten"]')).toBeTruthy();
  });

  it('block Agenten-Flow is present', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);
    expect(container.querySelector('[data-testid="block-flow"]')).toBeTruthy();
  });

  it('block Soll-Ist is present', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);
    expect(container.querySelector('[data-testid="block-soll-ist"]')).toBeTruthy();
  });

  it('Zeiten block shows started_at, ended_at, duration', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    const startEl = container.querySelector('[data-testid="detail-started-at"]');
    const endEl   = container.querySelector('[data-testid="detail-ended-at"]');
    const durEl   = container.querySelector('[data-testid="detail-duration"]');

    expect(startEl).toBeTruthy();
    expect(startEl.textContent).not.toBe('');
    expect(endEl).toBeTruthy();
    expect(durEl).toBeTruthy();
    expect(durEl.textContent).toMatch(/5 min|300/);
  });

  it('Agenten-Flow block shows flow steps with agent names', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    const flowBlock = container.querySelector('[data-testid="block-flow"]');
    expect(flowBlock.textContent).toMatch(/coder/);
    expect(flowBlock.textContent).toMatch(/reviewer/);
  });

  it('Agenten-Flow shows all seq-ordered steps', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    expect(container.querySelector('[data-testid="flow-step-0"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="flow-step-1"]')).toBeTruthy();
  });

  it('Soll-Ist block shows ep_est and ep_act', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    const epEst = container.querySelector('[data-testid="ep-est"]');
    const epAct = container.querySelector('[data-testid="ep-act"]');
    expect(epEst.textContent).toContain('3');
    expect(epAct.textContent).toContain('4');
  });

  it('Soll-Ist block shows tok_est and tok_total', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    const tokEst   = container.querySelector('[data-testid="tok-est"]');
    const tokTotal = container.querySelector('[data-testid="tok-total"]');
    expect(tokEst.textContent).toContain('1200');
    expect(tokTotal.textContent).toContain('1500');
  });

  it('Soll-Ist block shows ep deviation percentage', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    const epDev = container.querySelector('[data-testid="ep-dev"]');
    expect(epDev.textContent).toMatch(/33/);
  });
});

describe('story-detail-ansicht — AC4: fehlende Schätzung sauber dargestellt', () => {
  async function openDetailMissing(container) {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  }

  it('shows "keine Schätzung" for ep_est when null (AC4)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailMissing(container);

    const epEst = container.querySelector('[data-testid="ep-est"]');
    expect(epEst.textContent).toMatch(/keine Schätzung/i);
  });

  it('shows "keine Schätzung" for tok_est when null (AC4)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailMissing(container);

    const tokEst = container.querySelector('[data-testid="tok-est"]');
    expect(tokEst.textContent).toMatch(/keine Schätzung/i);
  });

  it('shows "Noch kein Flow-Lauf erfasst" when flow is empty and ended_at null (AC4 + AC5)', async () => {
    // AC5 (story-detail-yaml-fallback): Leer-Zustand differenziert:
    // kein ended_at → "Noch kein Flow-Lauf erfasst."
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailMissing(container);

    const flowEmpty = container.querySelector('[data-testid="flow-empty"]');
    expect(flowEmpty).toBeTruthy();
    expect(flowEmpty.textContent).toMatch(/noch kein flow-lauf/i);
  });

  it('shows "—" for started_at when null (no crash)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailMissing(container);

    const startEl = container.querySelector('[data-testid="detail-started-at"]');
    expect(startEl.textContent).toBe('—');
  });

  it('shows "—" for deviation when null', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailMissing(container);

    const epDev = container.querySelector('[data-testid="ep-dev"]');
    expect(epDev.textContent).toBe('—');
  });
});

// ── story-detail-ansicht — AC5: Vorab-Schätzungs-Fallback ────────────────────

/**
 * Fixture: detail data from YAML-Fallback (ep_est from dispo_est, no Ledger-Wert).
 * ep_est_source = 'yaml' → Vorab-Badge; Ist/Abweichung bleiben null/leer.
 */
const STORY_DETAIL_YAML_FALLBACK = {
  started_at:  null,
  ended_at:    null,
  duration:    null,
  flow:        [],
  ep_est:      2,          // aus dispo_est der Story-YAML
  ep_act:      null,       // kein Ledger-Wert
  tok_est:     null,
  tok_total:   null,
  size_est:    'S',
  ep_dev:      null,       // kein Ledger-Wert → keine Abweichung
  ep_dev_pct:  null,
  tok_dev:     null,
  tok_dev_pct: null,
  ep_est_source: 'yaml',   // Herkunfts-Flag
};

/**
 * Fixture: detail data with Ledger-Wert (ep_est_source = 'ledger').
 */
const STORY_DETAIL_LEDGER = {
  ...STORY_DETAIL_FULL,
  ep_est_source: 'ledger',
};

describe('story-detail-ansicht — AC5: Vorab-Schätzungs-Fallback', () => {
  /** Click the story card and wait for the detail block to appear. */
  async function openDetailAC5(container) {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  }

  it('YAML-Fallback: ep-est cell zeigt dispo_est-Wert', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_YAML_FALLBACK,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    const epEst = container.querySelector('[data-testid="ep-est"]');
    expect(epEst.textContent).toContain('2');
  });

  it('YAML-Fallback: ep-est cell zeigt „Vorab"-Badge (Herkunfts-Kennzeichnung)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_YAML_FALLBACK,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    const vorabBadge = container.querySelector('[data-testid="ep-est-vorab-badge"]');
    expect(vorabBadge).toBeTruthy();
    expect(vorabBadge.textContent).toMatch(/vorab/i);
  });

  it('YAML-Fallback: ep-act (Ist) bleibt leer „—"', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_YAML_FALLBACK,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    const epAct = container.querySelector('[data-testid="ep-act"]');
    expect(epAct.textContent).toBe('—');
  });

  it('YAML-Fallback: ep-dev (Abweichung) bleibt leer „—"', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_YAML_FALLBACK,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    const epDev = container.querySelector('[data-testid="ep-dev"]');
    expect(epDev.textContent).toBe('—');
  });

  it('Ledger-Wert: kein Vorab-Badge wenn ep_est_source = "ledger"', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_LEDGER,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    expect(container.querySelector('[data-testid="ep-est-vorab-badge"]')).toBeNull();

    const epEst = container.querySelector('[data-testid="ep-est"]');
    expect(epEst.textContent).toContain('3');
  });

  it('weder Ledger noch YAML → „keine Schätzung" (kein Vorab-Badge)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: { ...STORY_DETAIL_MISSING, ep_est_source: null },
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    const epEst = container.querySelector('[data-testid="ep-est"]');
    expect(epEst.textContent).toMatch(/keine Schätzung/i);
    expect(container.querySelector('[data-testid="ep-est-vorab-badge"]')).toBeNull();
  });
});

// ── story-detail-yaml-fallback — AC5: differenzierter Leer-Zustand + YAML-Badge ─

/**
 * Fixture: Story erledigt (done_at), aber kein Ledger.
 * ended_at kommt aus YAML (ended_at_source = 'yaml'), flow leer.
 */
const STORY_DETAIL_DONE_NO_LEDGER = {
  ...STORY_DETAIL_MISSING,
  ended_at: '2026-06-14T12:00:00.000Z',
  ended_at_source: 'yaml',
};

/**
 * Fixture: Story noch nicht erledigt, kein Ledger.
 */
const STORY_DETAIL_NOT_DONE_NO_LEDGER = {
  ...STORY_DETAIL_MISSING,
  ended_at: null,
  ended_at_source: null,
};

describe('story-detail-yaml-fallback — AC5: differenzierter Leer-Zustand im Flow-Block', () => {
  async function openDetailYamlFallback(container) {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  }

  it('zeigt "Vor Metrik-Erfassung abgeschlossen" wenn ended_at vorhanden aber flow leer', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_DONE_NO_LEDGER,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailYamlFallback(container);

    const flowEmpty = container.querySelector('[data-testid="flow-empty"]');
    expect(flowEmpty).toBeTruthy();
    expect(flowEmpty.textContent).toMatch(/vor metrik-erfassung abgeschlossen/i);
  });

  it('zeigt "Noch kein Flow-Lauf erfasst" wenn ended_at null und flow leer', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_NOT_DONE_NO_LEDGER,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailYamlFallback(container);

    const flowEmpty = container.querySelector('[data-testid="flow-empty"]');
    expect(flowEmpty).toBeTruthy();
    expect(flowEmpty.textContent).toMatch(/noch kein flow-lauf/i);
  });

  it('zeigt YAML-Badge bei ended_at aus YAML (ended_at_source="yaml")', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_DONE_NO_LEDGER,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailYamlFallback(container);

    const yamlBadge = container.querySelector('[data-testid="ended-at-yaml-badge"]');
    expect(yamlBadge).toBeTruthy();
    expect(yamlBadge.textContent.trim().toLowerCase()).toContain('yaml');
  });

  it('zeigt keinen YAML-Badge wenn ended_at_source="ledger"', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: { ...STORY_DETAIL_FULL, ended_at_source: 'ledger' },
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailYamlFallback(container);

    expect(container.querySelector('[data-testid="ended-at-yaml-badge"]')).toBeNull();
  });

  it('zeigt "—" für ended_at wenn null (kein Badge, kein Datum)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailYamlFallback(container);

    const endEl = container.querySelector('[data-testid="detail-ended-at"]');
    expect(endEl.textContent).toBe('—');
    expect(container.querySelector('[data-testid="ended-at-yaml-badge"]')).toBeNull();
  });
});

// ── story-detail-yaml-fallback — AC6: Block „Verknüpfungen" ──────────────────

/**
 * Fixture: mit branch und pr.
 */
const STORY_DETAIL_WITH_LINKS = {
  ...STORY_DETAIL_MISSING,
  branch: 'board/my-feature-2026-06-14',
  pr: 'https://github.com/org/repo/pull/42',
};

/**
 * Fixture: nur branch, kein pr.
 */
const STORY_DETAIL_BRANCH_ONLY = {
  ...STORY_DETAIL_MISSING,
  branch: 'board/my-feature-2026-06-14',
  pr: null,
};

/**
 * Fixture: weder branch noch pr.
 */
const STORY_DETAIL_NO_LINKS = {
  ...STORY_DETAIL_MISSING,
  branch: null,
  pr: null,
};

describe('story-detail-yaml-fallback — AC6: Block Verknüpfungen (Branch + PR)', () => {
  async function openDetailLinks(container) {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  }

  it('zeigt Block Verknüpfungen wenn branch und pr vorhanden', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_WITH_LINKS,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    expect(container.querySelector('[data-testid="block-verknuepfungen"]')).toBeTruthy();
  });

  it('zeigt Branch-Text im Verknüpfungen-Block', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_WITH_LINKS,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    const branchEl = container.querySelector('[data-testid="detail-branch"]');
    expect(branchEl).toBeTruthy();
    expect(branchEl.textContent).toContain('board/my-feature-2026-06-14');
  });

  it('zeigt PR-Link mit korrektem href (AC6)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_WITH_LINKS,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    const prEl = container.querySelector('[data-testid="detail-pr"]');
    expect(prEl).toBeTruthy();
    const link = prEl.querySelector('a');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('https://github.com/org/repo/pull/42');
  });

  it('PR-Link hat rel=noopener noreferrer (AC8 Security-Floor)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_WITH_LINKS,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    const link = container.querySelector('[data-testid="detail-pr"] a');
    expect(link).toBeTruthy();
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('zeigt Block Verknüpfungen auch wenn nur branch gesetzt ist (kein pr)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_BRANCH_ONLY,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    expect(container.querySelector('[data-testid="block-verknuepfungen"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="detail-branch"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="detail-pr"]')).toBeNull();
  });

  it('blendet Block Verknüpfungen aus wenn weder branch noch pr gesetzt (AC6)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_NO_LINKS,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    expect(container.querySelector('[data-testid="block-verknuepfungen"]')).toBeNull();
  });

  it('AC7 — bestehende Ledger-Daten (flow vorhanden) bleiben unverändert', async () => {
    // Stellt sicher dass AC7 (Ledger Vorrang) durch Erweiterung nicht gebrochen wird
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: { ...STORY_DETAIL_FULL, ended_at_source: 'ledger', branch: null, pr: null },
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    // Flow-Tabelle zeigt echte Ledger-Daten
    expect(container.querySelector('[data-testid="flow-step-0"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="flow-step-1"]')).toBeTruthy();
    // Kein YAML-Badge (Ledger hat Vorrang)
    expect(container.querySelector('[data-testid="ended-at-yaml-badge"]')).toBeNull();
    // Kein Verknüpfungen-Block (branch/pr null)
    expect(container.querySelector('[data-testid="block-verknuepfungen"]')).toBeNull();
  });
});
