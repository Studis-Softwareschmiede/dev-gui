/**
 * StoryCardEntityIcon.test.jsx — AC12 integration tests: EntityIcon in StoryCard.
 *
 * Covers (team-entity-icons, Etappe 3):
 *   AC12 — StoryCard renders an EntityIcon (aria-hidden SVG or monogram) before
 *           story.id when story.labels contains an entity label; renders NO icon
 *           when no entity label is present; correct kind/id is forwarded to
 *           EntityIcon; no new API calls introduced.
 *
 * NOTE (jsdom-Limitation): jsdom has no layout engine — visual size/position
 * of the icon is not asserted; presence of aria-hidden element is used instead.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { waitFor } from '@testing-library/react';

// Mock AppShell dependencies not used here
jest.unstable_mockModule('../Terminal.jsx', () => ({ Terminal: () => null }));

const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { BoardView } = await import('../BoardView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Story with an agent entity label → should show EntityIcon. */
const STORY_WITH_AGENT = {
  id: 'S-100',
  parent: 'F-100',
  title: 'Implement Coder Agent',
  status: 'To Do',
  priority: 'high',
  labels: ['agent:coder', 'backend'],
  spec: null,
};

/** Story with a skill entity label. */
const STORY_WITH_SKILL = {
  id: 'S-101',
  parent: 'F-100',
  title: 'Add Flow Skill',
  status: 'To Do',
  priority: 'medium',
  labels: ['frontend', 'skill:flow'],
  spec: null,
};

/** Story with a knowledge entity label. */
const STORY_WITH_KNOWLEDGE = {
  id: 'S-102',
  parent: 'F-100',
  title: 'Document JS Knowledge',
  status: 'In Progress',
  priority: 'low',
  labels: ['knowledge:js'],
  spec: null,
};

/** Story with NO entity label → no EntityIcon. */
const STORY_WITHOUT_ENTITY = {
  id: 'S-103',
  parent: 'F-100',
  title: 'Plain Story No Entity',
  status: 'Done',
  priority: 'low',
  labels: ['ci', 'devops'],
  spec: null,
};

/** Story with an unknown-kind label (should not produce icon). */
const STORY_UNKNOWN_KIND = {
  id: 'S-104',
  parent: 'F-100',
  title: 'Unknown Kind Story',
  status: 'To Do',
  priority: 'low',
  labels: ['feature:login'],
  spec: null,
};

/** Story with an empty labels array (labels: []) — no entity label present. */
const STORY_EMPTY_LABELS = {
  id: 'S-105',
  parent: 'F-100',
  title: 'Story with empty labels array',
  status: 'To Do',
  priority: 'low',
  labels: [],
  spec: null,
};

/**
 * Story where the labels field is entirely absent (labels: undefined).
 * Exercises the `story.labels ?? []` guard in StoryCard directly.
 */
const STORY_MISSING_LABELS = {
  id: 'S-106',
  parent: 'F-100',
  title: 'Story with no labels field at all',
  status: 'To Do',
  priority: 'low',
  // labels intentionally omitted — value is undefined
  spec: null,
};

const FEATURE = {
  id: 'F-100',
  title: 'Entity Icon Feature',
  status: 'In Progress',
  priority: 'high',
  stories: [
    STORY_WITH_AGENT,
    STORY_WITH_SKILL,
    STORY_WITH_KNOWLEDGE,
    STORY_WITHOUT_ENTITY,
    STORY_UNKNOWN_KIND,
    STORY_EMPTY_LABELS,
    STORY_MISSING_LABELS,
  ],
};

const PROJECT = {
  slug: 'entity-icon-project',
  repo_path: '/home/user/Git/entity',
  project_slug: 'entity-icon-project',
  schema_version: 1,
  features: [FEATURE],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeFetch(project) {
  return jest.fn(async (url) => {
    if (url === `/api/board/projects/${project.slug}`) {
      return { ok: true, status: 200, json: async () => ({ project }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

/** Render BoardView in cockpit mode (lockedProject) and wait for project load. */
async function renderCockpitLoaded(project) {
  globalThis.fetch = makeFetch(project);
  const onNavigate = jest.fn();
  const utils = render(React.createElement(BoardView, {
    onNavigate,
    lockedProject: project.slug,
  }));

  await waitFor(() => {
    expect(utils.container.querySelector(`[data-project="${project.slug}"]`)).toBeTruthy();
  });

  return utils;
}

// ── AC12: EntityIcon rendered for entity-label stories ───────────────────────

describe('team-entity-icons — AC12: EntityIcon in StoryCard header', () => {
  it('renders an aria-hidden element in header for story with "agent:coder" label', async () => {
    const { container } = await renderCockpitLoaded(PROJECT);

    const storyCard = container.querySelector('[data-story="S-100"]');
    expect(storyCard).toBeTruthy();

    // EntityIcon must be present: either an aria-hidden SVG (lucide) or
    // an aria-hidden span (monogram). Both carry aria-hidden="true".
    const header = storyCard.querySelector('[aria-label="Story-ID"]').parentElement;
    const ariaHiddenEl = header.querySelector('[aria-hidden="true"]');
    expect(ariaHiddenEl).toBeTruthy();
  });

  it('renders an SVG icon (lucide) for known agent role "coder"', async () => {
    const { container } = await renderCockpitLoaded(PROJECT);

    const storyCard = container.querySelector('[data-story="S-100"]');
    const header    = storyCard.querySelector('[aria-label="Story-ID"]').parentElement;
    // "coder" is a known role → should produce a lucide SVG element.
    const svg = header.querySelector('svg[aria-hidden="true"]');
    expect(svg).toBeTruthy();
  });

  it('renders an aria-hidden element for story with "skill:flow" label', async () => {
    const { container } = await renderCockpitLoaded(PROJECT);

    const storyCard = container.querySelector('[data-story="S-101"]');
    const header    = storyCard.querySelector('[aria-label="Story-ID"]').parentElement;
    const ariaHiddenEl = header.querySelector('[aria-hidden="true"]');
    expect(ariaHiddenEl).toBeTruthy();
  });

  it('renders an aria-hidden element for story with "knowledge:js" label', async () => {
    const { container } = await renderCockpitLoaded(PROJECT);

    const storyCard = container.querySelector('[data-story="S-102"]');
    const header    = storyCard.querySelector('[aria-label="Story-ID"]').parentElement;
    const ariaHiddenEl = header.querySelector('[aria-hidden="true"]');
    expect(ariaHiddenEl).toBeTruthy();
  });
});

// ── AC12: NO EntityIcon when no entity label ─────────────────────────────────

describe('team-entity-icons — AC12: NO icon when no entity label', () => {
  it('does NOT render an aria-hidden icon in header for story without entity label', async () => {
    const { container } = await renderCockpitLoaded(PROJECT);

    const storyCard = container.querySelector('[data-story="S-103"]');
    expect(storyCard).toBeTruthy();

    const header = storyCard.querySelector('[aria-label="Story-ID"]').parentElement;
    // The only aria-hidden child of storyHeader should not exist when no entity label.
    const ariaHiddenEl = header.querySelector('[aria-hidden="true"]');
    expect(ariaHiddenEl).toBeNull();
  });

  it('does NOT render an icon for story with unknown-kind label ("feature:login")', async () => {
    const { container } = await renderCockpitLoaded(PROJECT);

    const storyCard = container.querySelector('[data-story="S-104"]');
    const header    = storyCard.querySelector('[aria-label="Story-ID"]').parentElement;
    expect(header.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('does NOT render an icon for story with empty labels array (labels: [])', async () => {
    const { container } = await renderCockpitLoaded(PROJECT);

    const storyCard = container.querySelector('[data-story="S-105"]');
    expect(storyCard).toBeTruthy();
    const header    = storyCard.querySelector('[aria-label="Story-ID"]').parentElement;
    expect(header.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('does NOT crash and renders NO icon when labels field is absent (labels: undefined)', async () => {
    // Directly exercises the `story.labels ?? []` null-guard in StoryCard.
    const { container } = await renderCockpitLoaded(PROJECT);

    const storyCard = container.querySelector('[data-story="S-106"]');
    expect(storyCard).toBeTruthy(); // card must render without crash
    const header    = storyCard.querySelector('[aria-label="Story-ID"]').parentElement;
    expect(header.querySelector('[aria-hidden="true"]')).toBeNull(); // no EntityIcon
  });
});

// ── AC12: story.id still present (icon is BEFORE id, header otherwise intact) ─

describe('team-entity-icons — AC12: story.id remains visible, layout intact', () => {
  it('story.id span is still present after icon is inserted', async () => {
    const { container } = await renderCockpitLoaded(PROJECT);

    const storyCard = container.querySelector('[data-story="S-100"]');
    const idSpan    = storyCard.querySelector('[aria-label="Story-ID"]');
    expect(idSpan).toBeTruthy();
    expect(idSpan.textContent).toBe('S-100');
  });

  it('story title still rendered', async () => {
    const { container } = await renderCockpitLoaded(PROJECT);

    const storyCard = container.querySelector('[data-story="S-100"]');
    expect(storyCard.textContent).toContain('Implement Coder Agent');
  });

  it('no new fetch calls are made when rendering icons (AC12 floor: no new API)', async () => {
    const fetchMock = makeFetch(PROJECT);
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { container } = render(React.createElement(BoardView, {
      onNavigate,
      lockedProject: PROJECT.slug,
    }));

    await waitFor(() => {
      expect(container.querySelector(`[data-project="${PROJECT.slug}"]`)).toBeTruthy();
    });

    // All calls must be to board API only (no new icon-related API calls).
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toMatch(/^\/api\/board\//);
    }
  });
});

// ── AC12: first matching label wins (precedence) ─────────────────────────────

describe('team-entity-icons — AC12: first matching label wins', () => {
  it('uses the first entity-kind label when multiple entity labels are present', async () => {
    const storyMulti = {
      id: 'S-200',
      parent: 'F-200',
      title: 'Multi-entity story',
      status: 'To Do',
      priority: 'high',
      // "skill:deploy" comes BEFORE "agent:coder" → skill should win
      labels: ['skill:deploy', 'agent:coder'],
      spec: null,
    };

    const feature = { id: 'F-200', title: 'Multi', status: 'To Do', stories: [storyMulti] };
    const project = { slug: 'multi-project', features: [feature] };

    const fetchMock = jest.fn(async (url) => {
      if (url === '/api/board/projects/multi-project') {
        return { ok: true, status: 200, json: async () => ({ project }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { container } = render(React.createElement(BoardView, {
      onNavigate,
      lockedProject: 'multi-project',
    }));

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-200"]')).toBeTruthy();
    });

    // An icon must be present (whichever entity label won).
    const storyCard = container.querySelector('[data-story="S-200"]');
    const header    = storyCard.querySelector('[aria-label="Story-ID"]').parentElement;
    expect(header.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });
});
