/**
 * BoardViewWaiting.test.jsx — UI-Tests für AC3 (waiting-status-devgui, S-428):
 * eigene, ruhige Kategorie „Wartet (extern)" für Waiting-Storys.
 *
 * Covers (waiting-status-devgui):
 *   AC3 — Waiting-Storys erscheinen als eigene, ruhige Kategorie „Wartet
 *          (extern)" (eigene Kanban-Spalte, eigenes StatusBadge-/Filter-
 *          Anzeige-Label) — getrennt von der Blocked-Optik (anderer
 *          Badge-Ton, kein blocked_reason-Element). `wait_reason` rendert als
 *          sichtbare Hinweiszeile (Text + aria-label + title), fehlt es →
 *          dezenter Default-Text „wartet extern" (kein Crash). Bestehende
 *          Status-Kategorien (Idee/To Do/In Progress/Blocked/In Review/Done/
 *          Verworfen) bleiben unverändert (Regressionsschutz: eine Blocked-
 *          Story zeigt weiterhin ihr eigenes blocked_reason-Element, kein
 *          Wartet-Element).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { waitFor } from '@testing-library/react';

jest.unstable_mockModule('../Terminal.jsx', () => ({ Terminal: () => null }));

const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { BoardView } = await import('../BoardView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STORY_WAITING_WITH_REASON = {
  id: 'S-020',
  parent: 'F-001',
  title: 'Waiting Story mit Grund',
  status: 'Waiting',
  priority: 'P1',
  labels: [],
  spec: 'docs/specs/my.md',
  implements: ['AC1'],
  depends: [],
  blocked_reason: null,
  wait_reason: 'wartet auf den nächsten realen /adopt-Fall',
  ready: false,
  ready_reason: null,
};

const STORY_WAITING_NO_REASON = {
  id: 'S-021',
  parent: 'F-001',
  title: 'Waiting Story ohne Grund',
  status: 'Waiting',
  priority: 'P1',
  labels: [],
  spec: 'docs/specs/my.md',
  implements: ['AC1'],
  depends: [],
  blocked_reason: null,
  wait_reason: null,
  ready: false,
  ready_reason: null,
};

const STORY_BLOCKED = {
  id: 'S-022',
  parent: 'F-001',
  title: 'Blocked Story',
  status: 'Blocked',
  priority: 'P1',
  labels: [],
  spec: 'docs/specs/my.md',
  implements: ['AC1'],
  depends: [],
  blocked_reason: 'Warte auf externe API-Docs',
  ready: false,
  ready_reason: null,
};

const FEATURE = {
  id: 'F-001',
  title: 'Test Feature',
  status: 'Active',
  priority: 'P1',
  progress: null,
  stories: [STORY_WAITING_WITH_REASON, STORY_WAITING_NO_REASON, STORY_BLOCKED],
};

const PROJECT = {
  slug: 'test-proj-waiting',
  repo_path: '/fake/repos/test-proj-waiting',
  project_slug: 'test-proj-waiting',
  schema_version: 1,
  features: [FEATURE],
};

let origFetch;

beforeEach(() => {
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  window.location.hash = '';
});

/** Render BoardView in cockpit mode (lockedProject) with given project data. */
async function renderWithProject(project) {
  globalThis.fetch = jest.fn(async (url) => {
    if (url.startsWith('/api/board/projects/')) {
      return { ok: true, status: 200, json: async () => ({ project }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  const utils = render(
    React.createElement(BoardView, { lockedProject: project.slug }),
  );

  await waitFor(() => {
    expect(utils.container.querySelector(`[data-project="${project.slug}"]`)).toBeTruthy();
  });

  return utils;
}

describe('BoardView — waiting-status-devgui AC3: eigene Kategorie „Wartet (extern)"', () => {
  it('renders a Waiting story inside its own [data-status="Waiting"] column, separate from Blocked', async () => {
    const { container } = await renderWithProject(PROJECT);
    const waitingCol = container.querySelector('[data-status="Waiting"]');
    expect(waitingCol).toBeTruthy();
    expect(waitingCol.querySelector(`[data-story="${STORY_WAITING_WITH_REASON.id}"]`)).toBeTruthy();

    const blockedCol = container.querySelector('[data-status="Blocked"]');
    expect(blockedCol.querySelector(`[data-story="${STORY_WAITING_WITH_REASON.id}"]`)).toBeNull();
    expect(blockedCol.querySelector(`[data-story="${STORY_BLOCKED.id}"]`)).toBeTruthy();
  });

  it('shows the display label "Wartet (extern)" on the column badge, not the raw status word "Waiting"', async () => {
    const { container } = await renderWithProject(PROJECT);
    const waitingCol = container.querySelector('[data-status="Waiting"]');
    const badge = waitingCol.querySelector('[aria-label^="Status:"]');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('Wartet (extern)');
    expect(badge.getAttribute('aria-label')).toBe('Status: Wartet (extern)');
  });

  it('shows wait_reason as a hint line under the title, with aria-label + title', async () => {
    const { container } = await renderWithProject(PROJECT);
    const reasonEl = container.querySelector(`[data-testid="wait-reason-${STORY_WAITING_WITH_REASON.id}"]`);
    expect(reasonEl).toBeTruthy();
    expect(reasonEl.textContent).toContain(STORY_WAITING_WITH_REASON.wait_reason);
    expect(reasonEl.getAttribute('aria-label')).toContain(STORY_WAITING_WITH_REASON.wait_reason);
    expect(reasonEl.getAttribute('title')).toBe(STORY_WAITING_WITH_REASON.wait_reason);
  });

  it('AC5 (Toleranz): missing wait_reason falls back to a calm default text, no crash', async () => {
    const { container } = await renderWithProject(PROJECT);
    const reasonEl = container.querySelector(`[data-testid="wait-reason-${STORY_WAITING_NO_REASON.id}"]`);
    expect(reasonEl).toBeTruthy();
    expect(reasonEl.textContent).toBe('wartet extern');
  });

  it('does NOT show a blocked_reason element for a Waiting story (visually separate from Blocked)', async () => {
    const { container } = await renderWithProject(PROJECT);
    expect(container.querySelector(`[data-testid="blocked-reason-${STORY_WAITING_WITH_REASON.id}"]`)).toBeNull();
  });

  it('does NOT show a wait-reason element for a Blocked story (existing category unchanged)', async () => {
    const { container } = await renderWithProject(PROJECT);
    expect(container.querySelector(`[data-testid="wait-reason-${STORY_BLOCKED.id}"]`)).toBeNull();
    const reasonEl = container.querySelector(`[data-testid="blocked-reason-${STORY_BLOCKED.id}"]`);
    expect(reasonEl).toBeTruthy();
    expect(reasonEl.textContent).toContain(STORY_BLOCKED.blocked_reason);
  });

  it('the Waiting status filter checkbox shows the "Wartet (extern)" label, is default-checked', async () => {
    const { container } = await renderWithProject(PROJECT);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));

    const checkbox = container.querySelector('#board-filter-status-waiting');
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(true);
    const label = checkbox.closest('label');
    expect(label.textContent).toContain('Wartet (extern)');
  });
});
