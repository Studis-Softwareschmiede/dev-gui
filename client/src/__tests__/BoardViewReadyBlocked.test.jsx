/**
 * BoardViewReadyBlocked.test.jsx — UI-Tests für AC4 (autonome-board-abarbeitung):
 * Ready-Badge und blocked_reason-Anzeige im Board.
 *
 * Covers (autonome-board-abarbeitung):
 *   AC4 — Ready-Stories (status=To Do, ready=true) tragen ein „ready"-Badge.
 *          Blocked-Stories zeigen ihren blocked_reason als Hinweiszeile.
 *          Nicht-ready To-Do-Stories (ready=false) tragen kein Badge.
 *          Kontrast/aria: Badge hat aria-label; Grund hat aria-label und data-testid.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { waitFor } from '@testing-library/react';

// Mock heavy sub-components
jest.unstable_mockModule('../Terminal.jsx', () => ({ Terminal: () => null }));
jest.unstable_mockModule('../Dashboard.jsx', () => ({ Dashboard: () => null }));
jest.unstable_mockModule('../TriggerPanel.jsx', () => ({ TriggerPanel: () => null }));

const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { BoardView } = await import('../BoardView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A To-Do story that is ready */
const STORY_READY = {
  id: 'S-010',
  parent: 'F-001',
  title: 'Ready Story',
  status: 'To Do',
  priority: 'P1',
  labels: [],
  spec: 'docs/specs/my.md',
  implements: ['AC1'],
  depends: [],
  blocked_reason: null,
  ready: true,
  ready_reason: null,
};

/** A To-Do story that is NOT ready (missing spec) */
const STORY_NOT_READY = {
  id: 'S-011',
  parent: 'F-001',
  title: 'Not-Ready Story',
  status: 'To Do',
  priority: 'P1',
  labels: [],
  spec: null,
  implements: [],
  depends: [],
  blocked_reason: null,
  ready: false,
  ready_reason: 'spec nicht gesetzt',
};

/** A Blocked story with a reason */
const STORY_BLOCKED = {
  id: 'S-012',
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
  stories: [STORY_READY, STORY_NOT_READY, STORY_BLOCKED],
};

const PROJECT = {
  slug: 'test-proj',
  repo_path: '/fake/repos/test-proj',
  project_slug: 'test-proj',
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

  // Wait for project data to load
  await waitFor(() => {
    expect(utils.container.querySelector(`[data-project="${project.slug}"]`)).toBeTruthy();
  });

  return utils;
}

// ── Ready-Badge Tests (AC4) ───────────────────────────────────────────────────

describe('BoardView — AC4 (autonome-board-abarbeitung): Ready-Badge', () => {
  it('shows ready-badge for a To-Do story with ready=true', async () => {
    const { container } = await renderWithProject(PROJECT);
    const badge = container.querySelector(`[data-testid="ready-badge-${STORY_READY.id}"]`);
    expect(badge).toBeTruthy();
    expect(badge.textContent.toLowerCase()).toBe('ready');
  });

  it('ready-badge has aria-label', async () => {
    const { container } = await renderWithProject(PROJECT);
    const badge = container.querySelector(`[data-testid="ready-badge-${STORY_READY.id}"]`);
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('aria-label')).toBeTruthy();
  });

  it('does NOT show ready-badge for a To-Do story with ready=false', async () => {
    const { container } = await renderWithProject(PROJECT);
    const badge = container.querySelector(`[data-testid="ready-badge-${STORY_NOT_READY.id}"]`);
    expect(badge).toBeNull();
  });

  it('does NOT show ready-badge for a Blocked story', async () => {
    const { container } = await renderWithProject(PROJECT);
    const badge = container.querySelector(`[data-testid="ready-badge-${STORY_BLOCKED.id}"]`);
    expect(badge).toBeNull();
  });
});

// ── blocked_reason display Tests (AC4) ────────────────────────────────────────

describe('BoardView — AC4 (autonome-board-abarbeitung): blocked_reason', () => {
  it('shows blocked_reason for a Blocked story', async () => {
    const { container } = await renderWithProject(PROJECT);
    const reasonEl = container.querySelector(`[data-testid="blocked-reason-${STORY_BLOCKED.id}"]`);
    expect(reasonEl).toBeTruthy();
    expect(reasonEl.textContent).toContain(STORY_BLOCKED.blocked_reason);
  });

  it('blocked_reason element has aria-label', async () => {
    const { container } = await renderWithProject(PROJECT);
    const reasonEl = container.querySelector(`[data-testid="blocked-reason-${STORY_BLOCKED.id}"]`);
    expect(reasonEl).toBeTruthy();
    expect(reasonEl.getAttribute('aria-label')).toContain(STORY_BLOCKED.blocked_reason);
  });

  it('does NOT show blocked_reason element for a To-Do story', async () => {
    const { container } = await renderWithProject(PROJECT);
    // STORY_NOT_READY is To-Do with blocked_reason=null — no element expected
    const reasonEl = container.querySelector(`[data-testid="blocked-reason-${STORY_NOT_READY.id}"]`);
    expect(reasonEl).toBeNull();
  });

  it('does NOT show blocked_reason element for Blocked story with null reason', async () => {
    const storyBlockedNoReason = {
      ...STORY_BLOCKED,
      id: 'S-099',
      blocked_reason: null,
    };
    const proj = {
      ...PROJECT,
      features: [{ ...FEATURE, stories: [storyBlockedNoReason] }],
    };
    const { container } = await renderWithProject(proj);
    const reasonEl = container.querySelector('[data-testid="blocked-reason-S-099"]');
    expect(reasonEl).toBeNull();
  });
});
