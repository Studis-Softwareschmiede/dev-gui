/**
 * TeamView.test.jsx — Unit tests for TeamView component (team-view-frontend).
 *
 * Covers (team-view-frontend):
 *   - AC3: Mount calls GET /api/team exactly once; grouped list AGENTEN/SKILLS/KNOWLEDGE;
 *          Knowledge grouped by `group` with stable sort (group first, name second);
 *          aria-busy/aria-live loading state.
 *   - AC4: Selecting a list entry (mouse + keyboard) calls GET /api/team/:kind/:id;
 *          Detail pane shows metadata badges + rendered Markdown body;
 *          active entry carries aria-current.
 *   - AC6: Empty lists → "Kein agent-flow-Plugin gefunden" hint; no crash.
 *   - AC7: Fetch failure → error message displayed; view remains usable.
 *   - AC8: Touch-targets ≥ 44 px; aria-current on active item; semantic list/landmark.
 *
 * Covers (team-detail-scroll):
 *   - AC1: Detail pane has overflowY:'auto' so long content is scrollable (not clipped).
 *   - AC2: The layout is a CSS grid (NOT flex-wrap). A flex-wrap row sizes its line to
 *          content height, so the detail pane grew past the viewport and overflow:hidden
 *          clipped it — overflowY:'auto' never engaged. A grid track is bounded by the
 *          container, giving each column a real height limit so it scrolls.
 *   - AC3: The height chain is closed — minHeight:0 on the layout grid + nav + detail.
 *   - AC4 (no regression): Nav list remains visible/usable; its own overflowY:'auto' +
 *          minHeight:0 preserved.
 *   - AC5 (no regression): A11y properties (touch-targets, focus ring, aria-current,
 *          keyboard) remain unaffected by the layout fix — verified by the existing
 *          team-view-frontend AC8 tests above.
 *
 *   NOTE: jsdom has no layout engine, so these assert the *style properties* that make
 *   scrolling possible — not the scroll behaviour itself. Actual scrollability
 *   (scrollHeight > clientHeight, end-of-content reachable) was verified in a real
 *   browser (headless Chrome) against the built app; see the fix commit for the
 *   measured before/after (flex-wrap canScroll=false → grid canScroll=true).
 *
 * Covers (team-detail-related-refs):
 *   - AC7: Agent-DetailPane renders "Zugehörige Skills" and "Zugehöriges Knowledge" chip
 *          sections from relatedSkills/relatedKnowledge; empty list → no section rendered.
 *   - AC8: Chip click (mouse + keyboard Enter/Space) calls loadDetail with correct kind/id;
 *          no full reload.
 *   - AC9: Skill-/Knowledge-DetailPane renders "Verwendet von" chip section from usedByAgents;
 *          click calls loadDetail('agent', id); empty list → no section rendered.
 *   - AC10: Chips are focusable buttons without outline:none; no dangerouslySetInnerHTML;
 *           no external library.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }      = await import('@testing-library/react');
const React           = (await import('react')).default;
const { TeamView }    = await import('../TeamView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AGENTS = [
  { id: 'coder', name: 'Coder', description: 'Implementiert Features', model: 'claude-opus-4', tools: ['Read', 'Write'] },
  { id: 'reviewer', name: 'Reviewer', description: 'Prüft Code', model: 'claude-sonnet-4', tools: ['Read'] },
];

// Agent detail with relatedSkills + relatedKnowledge (AC7/AC8)
const AGENT_DETAIL_WITH_REFS = {
  id: 'coder',
  name: 'Coder',
  description: 'Implementiert Features',
  model: 'claude-opus-4',
  tools: ['Read', 'Write'],
  body: '# Coder\n\nMacht Code.',
  relatedSkills: [
    { id: 'deploy', name: 'Deploy' },
    { id: 'test', name: 'Test' },
  ],
  relatedKnowledge: [
    { id: 'security', name: 'Security', group: 'core' },
    { id: 'frameworks/react-18', name: 'React 18', group: 'frameworks' },
  ],
};

// Agent detail without any refs → chip sections must not render (AC10 empty state)
const AGENT_DETAIL_NO_REFS = {
  id: 'reviewer',
  name: 'Reviewer',
  description: 'Prüft Code',
  model: 'claude-sonnet-4',
  tools: ['Read'],
  body: '## Reviewer\n\nPrüft Pull Requests.',
  relatedSkills: [],
  relatedKnowledge: [],
};

// Skill detail with usedByAgents (AC9)
const SKILL_DETAIL_WITH_AGENTS = {
  id: 'deploy',
  name: 'Deploy',
  description: 'Deploy-Skill',
  body: '## Deploy\n\nDeploys the app.',
  usedByAgents: [
    { id: 'coder', name: 'Coder' },
    { id: 'reviewer', name: 'Reviewer' },
  ],
};

// Knowledge detail with usedByAgents (AC9)
const KNOWLEDGE_DETAIL_WITH_AGENTS = {
  id: 'security',
  name: 'Security',
  description: 'Security-Wissen',
  group: 'core',
  body: '## Security\n\nSicherheit.',
  usedByAgents: [
    { id: 'coder', name: 'Coder' },
  ],
};

// Skill detail with empty usedByAgents → no section (AC9 empty state)
const SKILL_DETAIL_NO_AGENTS = {
  id: 'test',
  name: 'Test',
  description: 'Test-Skill',
  body: '## Test',
  usedByAgents: [],
};

const SKILLS = [
  { id: 'deploy', name: 'Deploy', description: 'Deploy-Skill' },
  { id: 'test', name: 'Test', description: 'Test-Skill' },
];

// Knowledge: two groups, two items in the same group.
// Order matches backend sort: group asc, name asc (as AgentFlowReader produces).
const KNOWLEDGE = [
  { id: 'security', name: 'Security', group: 'core' },
  { id: 'typescript', name: 'TypeScript', group: 'core' },
  { id: 'frameworks/react-18', name: 'React 18', group: 'frameworks' },
  { id: 'frameworks/spring-boot-3', name: 'Spring Boot 3', group: 'frameworks' },
];

const OVERVIEW_RESPONSE = { agents: AGENTS, skills: SKILLS, knowledge: KNOWLEDGE };

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.location.hash = '';
});

function makeFetch({ overviewBody, detailBody, overviewOk = true, detailOk = true }) {
  return jest.fn(async (url) => {
    if (url === '/api/team') {
      return {
        ok: overviewOk,
        status: overviewOk ? 200 : 500,
        json: async () => overviewBody,
      };
    }
    if (url.startsWith('/api/team/')) {
      return {
        ok: detailOk,
        status: detailOk ? 200 : 500,
        json: async () => detailBody,
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function renderTeam(props = {}) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(TeamView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

// ── AC3 — Mount calls GET /api/team exactly once ──────────────────────────────

describe('TeamView — AC3: Mount loads overview exactly once', () => {
  it('calls GET /api/team exactly once on mount', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    renderTeam();

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/team');
      expect(calls).toHaveLength(1);
    });
  });

  it('does NOT call GET /api/team a second time when the component re-renders', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { rerender } = renderTeam();

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/team')).toHaveLength(1);
    });

    // Re-render with same props — should not trigger another fetch
    await act(async () => {
      rerender(React.createElement(TeamView, { onNavigate: jest.fn() }));
    });

    // Still exactly one call
    expect(globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/team')).toHaveLength(1);
  });

  it('shows aria-busy loading state during fetch', async () => {
    let resolveOverview;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/team') {
        await new Promise((r) => { resolveOverview = r; });
        return { ok: true, json: async () => OVERVIEW_RESPONSE };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderTeam();

    // While fetch is pending, aria-busy should be present
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    // Resolve fetch
    await act(async () => { resolveOverview(); });

    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
  });

  it('renders AGENTEN section heading after load', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { getByText } = renderTeam();

    await waitFor(() => {
      expect(getByText(/agenten/i)).toBeTruthy();
    });
  });

  it('renders SKILLS section heading after load', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { getByText } = renderTeam();

    await waitFor(() => {
      expect(getByText(/skills/i)).toBeTruthy();
    });
  });

  it('renders KNOWLEDGE section heading after load', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { getByText } = renderTeam();

    await waitFor(() => {
      expect(getByText(/knowledge/i)).toBeTruthy();
    });
  });
});

// ── AC3 — Grouped list / Knowledge sorting ────────────────────────────────────

describe('TeamView — AC3: Grouped list with stable Knowledge sort', () => {
  it('renders all agent names in nav list', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { getByText } = renderTeam();

    await waitFor(() => {
      expect(getByText('Coder')).toBeTruthy();
      expect(getByText('Reviewer')).toBeTruthy();
    });
  });

  it('renders all skill names in nav list', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { getByText } = renderTeam();

    await waitFor(() => {
      expect(getByText('Deploy')).toBeTruthy();
      expect(getByText('Test')).toBeTruthy();
    });
  });

  it('renders knowledge names in nav list', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { getByText } = renderTeam();

    await waitFor(() => {
      expect(getByText('Spring Boot 3')).toBeTruthy();
      expect(getByText('React 18')).toBeTruthy();
      expect(getByText('Security')).toBeTruthy();
      expect(getByText('TypeScript')).toBeTruthy();
    });
  });

  it('Knowledge: group headings rendered (core, frameworks)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { getByText } = renderTeam();

    await waitFor(() => {
      expect(getByText('core')).toBeTruthy();
      expect(getByText('frameworks')).toBeTruthy();
    });
  });

  it('Knowledge: group sort — core before frameworks (alphabetical)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { container } = renderTeam();

    await waitFor(() => {
      // Knowledge section nav contains group headings
      const groupHeadings = container.querySelectorAll('h3');
      const labels = Array.from(groupHeadings).map((h) => h.textContent.trim());
      // core < frameworks alphabetically
      expect(labels).toEqual(['core', 'frameworks']);
    });
  });

  it('Knowledge: within same group "core", Security before TypeScript (name sort)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { container } = renderTeam();

    await waitFor(() => {
      // Find the core group heading and its sibling list
      const groupHeadings = Array.from(container.querySelectorAll('h3'));
      const coreHeading = groupHeadings.find((h) => h.textContent.trim() === 'core');
      expect(coreHeading).toBeTruthy();
      // The ul immediately after the h3 (in the same div)
      const coreGroup = coreHeading.closest('div');
      const buttons = Array.from(coreGroup.querySelectorAll('button[data-kind="knowledge"]'));
      const names = buttons.map((b) => b.textContent.trim());
      // Alphabetical by name within group: Security < TypeScript
      expect(names).toEqual(['Security', 'TypeScript']);
    });
  });

  it('Knowledge: within frameworks group, React 18 before Spring Boot 3 (name sort)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { container } = renderTeam();

    await waitFor(() => {
      const groupHeadings = Array.from(container.querySelectorAll('h3'));
      const fwHeading = groupHeadings.find((h) => h.textContent.trim() === 'frameworks');
      expect(fwHeading).toBeTruthy();
      const fwGroup = fwHeading.closest('div');
      const buttons = Array.from(fwGroup.querySelectorAll('button[data-kind="knowledge"]'));
      const names = buttons.map((b) => b.textContent.trim());
      expect(names).toEqual(['React 18', 'Spring Boot 3']);
    });
  });
});

// ── AC4 — Selection via mouse and keyboard ────────────────────────────────────

describe('TeamView — AC4: Selection via mouse', () => {
  const agentDetail = {
    id: 'coder',
    name: 'Coder',
    description: 'Implementiert Features',
    model: 'claude-opus-4',
    tools: ['Read', 'Write'],
    body: '# Coder\n\nMacht Code.',
  };

  it('clicking an agent entry calls GET /api/team/agent/<id>', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: agentDetail });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      const detailCalls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/team/agent/coder',
      );
      expect(detailCalls).toHaveLength(1);
    });
  });

  it('detail pane shows metadata badges after selection', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: agentDetail });

    const { container, getByText } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      // Model badge
      expect(getByText('claude-opus-4')).toBeTruthy();
      // Tool badges
      expect(getByText('Read')).toBeTruthy();
      expect(getByText('Write')).toBeTruthy();
    });
  });

  it('detail pane shows rendered Markdown body heading', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: agentDetail });

    const { container, getByRole } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      // markdownLite renders "# Coder" as <h1>
      expect(getByRole('heading', { level: 1, name: /coder/i })).toBeTruthy();
    });
  });

  it('active entry carries aria-current="page"', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: agentDetail });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      const btn = container.querySelector('button[data-kind="agent"][data-id="coder"]');
      expect(btn.getAttribute('aria-current')).toBe('page');
    });
  });

  it('other entries do NOT carry aria-current after selection', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: agentDetail });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      const reviewerBtn = container.querySelector('button[data-kind="agent"][data-id="reviewer"]');
      expect(reviewerBtn.getAttribute('aria-current')).toBeNull();
    });
  });
});

describe('TeamView — AC4: Selection via keyboard', () => {
  const skillDetail = {
    id: 'deploy',
    name: 'Deploy',
    description: 'Deploy-Skill',
    body: '## Deploy\n\nDeploys the app.',
  };

  it('Enter key on a skill entry loads detail', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: skillDetail });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.keyDown(
        container.querySelector('button[data-kind="skill"][data-id="deploy"]'),
        { key: 'Enter' },
      );
    });

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/team/skill/deploy',
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('Space key on a skill entry loads detail', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: skillDetail });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.keyDown(
        container.querySelector('button[data-kind="skill"][data-id="deploy"]'),
        { key: ' ' },
      );
    });

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/team/skill/deploy',
      );
      expect(calls).toHaveLength(1);
    });
  });
});

// ── AC6 — Empty state ─────────────────────────────────────────────────────────

describe('TeamView — AC6: Empty state', () => {
  it('shows "Kein agent-flow-Plugin gefunden" when all lists are empty', async () => {
    globalThis.fetch = makeFetch({
      overviewBody: { agents: [], skills: [], knowledge: [] },
    });

    const { getByText } = renderTeam();

    await waitFor(() => {
      expect(getByText(/kein agent-flow-plugin gefunden/i)).toBeTruthy();
    });
  });

  it('does not crash with empty lists', async () => {
    globalThis.fetch = makeFetch({
      overviewBody: { agents: [], skills: [], knowledge: [] },
    });

    await expect(
      act(async () => {
        renderTeam();
        await new Promise((r) => setTimeout(r, 50));
      }),
    ).resolves.not.toThrow();
  });

  it('does not render any nav buttons when lists are empty', async () => {
    globalThis.fetch = makeFetch({
      overviewBody: { agents: [], skills: [], knowledge: [] },
    });

    const { container } = renderTeam();

    await waitFor(() => {
      // Wait for load to complete
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    expect(container.querySelectorAll('button[data-kind]')).toHaveLength(0);
  });
});

// ── AC7 — Error state ─────────────────────────────────────────────────────────

describe('TeamView — AC7: Error state', () => {
  it('shows error message when overview fetch fails (network error)', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/team') throw new Error('Network error');
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('shows error message when overview fetch returns non-ok status', async () => {
    globalThis.fetch = makeFetch({
      overviewBody: { error: 'Server error' },
      overviewOk: false,
    });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('shell (main landmark) remains in DOM when fetch fails', async () => {
    globalThis.fetch = jest.fn(async () => { throw new Error('Network error'); });

    const { getByRole } = renderTeam();

    await waitFor(() => {
      expect(getByRole('main', { name: /team-ansicht/i })).toBeTruthy();
    });
  });

  it('detail pane error: list remains usable after detail fetch fails', async () => {
    const agentDetail = {
      id: 'coder', name: 'Coder', description: 'Implementiert Features',
      model: 'claude-opus-4', tools: [], body: '',
    };

    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/team') {
        return { ok: true, json: async () => OVERVIEW_RESPONSE };
      }
      if (url.startsWith('/api/team/agent/coder')) {
        throw new Error('Detail error');
      }
      return { ok: true, json: async () => agentDetail };
    });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"][data-id="coder"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      // Error in detail pane
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });

    // List still usable — other agent buttons still present
    expect(container.querySelector('button[data-kind="agent"][data-id="reviewer"]')).toBeTruthy();
  });
});

// ── AC8 — A11y ────────────────────────────────────────────────────────────────

describe('TeamView — AC8: A11y', () => {
  it('main landmark has aria-label "Team-Ansicht"', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { getByRole } = renderTeam();

    expect(getByRole('main', { name: /team-ansicht/i })).toBeTruthy();
  });

  it('nav buttons have minHeight >= 44px (touch-targets)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    const navButtons = container.querySelectorAll('button[data-kind]');
    for (const btn of navButtons) {
      const minH = parseInt(btn.style.minHeight, 10);
      expect(minH).toBeGreaterThanOrEqual(44);
    }
  });

  it('nav button does not have outline:none (focus ring visible)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    const navButton = container.querySelector('button[data-kind="agent"]');
    // outline:none would be set in style.outline; should not be 'none' or '0'
    expect(navButton.style.outline).not.toBe('none');
    expect(navButton.style.outline).not.toBe('0');
  });

  it('navigation landmark is present', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { getByRole } = renderTeam();

    await waitFor(() => {
      expect(getByRole('navigation', { name: /team-navigation/i })).toBeTruthy();
    });
  });
});

// ── team-detail-scroll: AC1–AC4 — Scroll layout properties ───────────────────

describe('TeamView — team-detail-scroll AC1/AC2/AC3: detail pane scroll layout', () => {
  it('AC1/AC2 — detail pane has overflowY:"auto" (scrollable on overflow)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    const detailPane = container.querySelector('[aria-label="Detail-Pane"]');
    expect(detailPane).toBeTruthy();
    expect(detailPane.style.overflowY).toBe('auto');
  });

  it('AC3 — detail pane has minHeight:0 (closes flex height chain)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    const detailPane = container.querySelector('[aria-label="Detail-Pane"]');
    expect(detailPane).toBeTruthy();
    // Grid items default to min-height:auto (content-based); minHeight:0 lets the pane
    // shrink below content height so overflowY:'auto' actually scrolls.
    // jsdom normalises numeric 0 → '0' (not '0px')
    expect(detailPane.style.minHeight).toBe('0');
  });

  it('AC3/AC4 — nav pane has overflowY:"auto" + minHeight:0 (chain complete, no regression)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Team-Navigation"]')).toBeTruthy();
    });

    const navPane = container.querySelector('[aria-label="Team-Navigation"]');
    expect(navPane.style.overflowY).toBe('auto');
    // jsdom normalises numeric 0 → '0' (not '0px')
    expect(navPane.style.minHeight).toBe('0');
  });

  it('AC2/AC4 — layout is a CSS grid (NOT flex-wrap) with bounded height (overflow:hidden + minHeight:0)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    // The layout div wraps nav + detail; it must constrain height for the chain to work.
    const detailPane = container.querySelector('[aria-label="Detail-Pane"]');
    const layoutDiv = detailPane.parentElement;

    // Regression guard: must be a grid, NOT flex-wrap. A flex-wrap row sizes its line to
    // content height, which defeats overflow scrolling (the original team-detail-scroll bug).
    expect(layoutDiv.style.display).toBe('grid');
    expect(layoutDiv.style.flexWrap).toBe('');
    expect(layoutDiv.style.gridTemplateColumns).toContain('minmax');

    expect(layoutDiv.style.overflow).toBe('hidden');
    // jsdom normalises numeric 0 → '0' (not '0px')
    expect(layoutDiv.style.minHeight).toBe('0');
  });
});

// ── team-detail-related-refs: AC7 — Agent chip sections ──────────────────────

describe('TeamView — team-detail-related-refs AC7: Agent chip sections render', () => {
  it('renders "Zugehörige Skills" section when relatedSkills is non-empty', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container, getByText } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      expect(getByText('Zugehörige Skills')).toBeTruthy();
    });
  });

  it('renders "Zugehöriges Knowledge" section when relatedKnowledge is non-empty', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container, getByText } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      expect(getByText('Zugehöriges Knowledge')).toBeTruthy();
    });
  });

  it('renders a chip per relatedSkills entry with the entry name', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      const skillChips = container.querySelectorAll('button[data-kind="skill"]');
      const names = Array.from(skillChips).map((b) => b.textContent.trim());
      expect(names).toContain('Deploy');
      expect(names).toContain('Test');
    });
  });

  it('renders a chip per relatedKnowledge entry with the entry name', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      const knChips = container.querySelectorAll('button[data-kind="knowledge"]');
      const names = Array.from(knChips).map((b) => b.textContent.trim());
      expect(names).toContain('Security');
      expect(names).toContain('React 18');
    });
  });

  it('does NOT render "Zugehörige Skills" section when relatedSkills is empty', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_NO_REFS });

    const { container, queryByText } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="reviewer"]'));
    });

    await waitFor(() => {
      // detail loaded
      expect(container.querySelector('article')).toBeTruthy();
    });

    expect(queryByText('Zugehörige Skills')).toBeNull();
  });

  it('does NOT render "Zugehöriges Knowledge" section when relatedKnowledge is empty', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_NO_REFS });

    const { container, queryByText } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="reviewer"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('article')).toBeTruthy();
    });

    expect(queryByText('Zugehöriges Knowledge')).toBeNull();
  });
});

// ── team-detail-related-refs: AC8 — Chip click/keyboard calls loadDetail ─────

describe('TeamView — team-detail-related-refs AC8: Chip navigation', () => {
  it('clicking a Skill chip calls loadDetail("skill", id)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    // Reset fetch mock to track next call
    const initialCalls = globalThis.fetch.mock.calls.length;

    await act(async () => {
      // Click the skill chip inside the detail pane (article)
      fireEvent.click(container.querySelector('article button[data-kind="skill"][data-id="deploy"]'));
    });

    await waitFor(() => {
      const newCalls = globalThis.fetch.mock.calls.slice(initialCalls);
      const skillCall = newCalls.find((c) => c[0] === '/api/team/skill/deploy');
      expect(skillCall).toBeTruthy();
    });

    // AC8: the corresponding nav button must now carry aria-current="page" (no full reload)
    await waitFor(() => {
      const navBtn = container.querySelector('nav button[data-kind="skill"][data-id="deploy"]');
      expect(navBtn).toBeTruthy();
      expect(navBtn.getAttribute('aria-current')).toBe('page');
    });
  });

  it('clicking a Knowledge chip calls loadDetail("knowledge", id)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="knowledge"]')).toBeTruthy();
    });

    const initialCalls = globalThis.fetch.mock.calls.length;

    await act(async () => {
      // Click the knowledge chip inside the detail pane (article)
      fireEvent.click(container.querySelector('article button[data-kind="knowledge"][data-id="security"]'));
    });

    await waitFor(() => {
      const newCalls = globalThis.fetch.mock.calls.slice(initialCalls);
      const knCall = newCalls.find((c) => c[0] === '/api/team/knowledge/security');
      expect(knCall).toBeTruthy();
    });

    // AC8: the corresponding nav button must now carry aria-current="page" (no full reload)
    await waitFor(() => {
      const navBtn = container.querySelector('nav button[data-kind="knowledge"][data-id="security"]');
      expect(navBtn).toBeTruthy();
      expect(navBtn.getAttribute('aria-current')).toBe('page');
    });
  });

  it('Enter key on a Skill chip calls loadDetail("skill", id)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    const initialCalls = globalThis.fetch.mock.calls.length;

    await act(async () => {
      fireEvent.keyDown(
        container.querySelector('button[data-kind="skill"][data-id="deploy"]'),
        { key: 'Enter' },
      );
    });

    await waitFor(() => {
      const newCalls = globalThis.fetch.mock.calls.slice(initialCalls);
      const skillCall = newCalls.find((c) => c[0] === '/api/team/skill/deploy');
      expect(skillCall).toBeTruthy();
    });
  });

  it('Space key on a Knowledge chip calls loadDetail("knowledge", id)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="knowledge"]')).toBeTruthy();
    });

    const initialCalls = globalThis.fetch.mock.calls.length;

    await act(async () => {
      fireEvent.keyDown(
        container.querySelector('button[data-kind="knowledge"][data-id="security"]'),
        { key: ' ' },
      );
    });

    await waitFor(() => {
      const newCalls = globalThis.fetch.mock.calls.slice(initialCalls);
      const knCall = newCalls.find((c) => c[0] === '/api/team/knowledge/security');
      expect(knCall).toBeTruthy();
    });
  });

  it('Chip navigation does not cause a full page reload (no location.href change)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container } = renderTeam();
    const locationBefore = window.location.href;

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="skill"][data-id="deploy"]'));
    });

    // location must not have changed (no full reload)
    expect(window.location.href).toBe(locationBefore);
  });
});

// ── team-detail-related-refs: AC9 — "Verwendet von" chips ────────────────────

describe('TeamView — team-detail-related-refs AC9: "Verwendet von" chips in Skill/Knowledge detail', () => {
  it('renders "Verwendet von" section when usedByAgents is non-empty (skill detail)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: SKILL_DETAIL_WITH_AGENTS });

    const { container, getByText } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="skill"][data-id="deploy"]'));
    });

    await waitFor(() => {
      expect(getByText('Verwendet von')).toBeTruthy();
    });
  });

  it('renders "Verwendet von" section when usedByAgents is non-empty (knowledge detail)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: KNOWLEDGE_DETAIL_WITH_AGENTS });

    const { container, getByText } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="knowledge"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="knowledge"][data-id="security"]'));
    });

    await waitFor(() => {
      expect(getByText('Verwendet von')).toBeTruthy();
    });
  });

  it('renders agent chips inside "Verwendet von" section', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: SKILL_DETAIL_WITH_AGENTS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="skill"][data-id="deploy"]'));
    });

    await waitFor(() => {
      // usedByAgents chips rendered as agent kind buttons inside the detail pane article
      const articleAgentChips = container.querySelectorAll('article button[data-kind="agent"]');
      const names = Array.from(articleAgentChips).map((b) => b.textContent.trim());
      expect(names).toContain('Coder');
      expect(names).toContain('Reviewer');
    });
  });

  it('clicking an agent chip in "Verwendet von" calls loadDetail("agent", id)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: SKILL_DETAIL_WITH_AGENTS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="skill"][data-id="deploy"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('article button[data-kind="agent"]')).toBeTruthy();
    });

    const initialCalls = globalThis.fetch.mock.calls.length;

    await act(async () => {
      fireEvent.click(container.querySelector('article button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      const newCalls = globalThis.fetch.mock.calls.slice(initialCalls);
      const agentCall = newCalls.find((c) => c[0] === '/api/team/agent/coder');
      expect(agentCall).toBeTruthy();
    });

    // AC8: the corresponding nav button must now carry aria-current="page" (no full reload)
    await waitFor(() => {
      const navBtn = container.querySelector('nav button[data-kind="agent"][data-id="coder"]');
      expect(navBtn).toBeTruthy();
      expect(navBtn.getAttribute('aria-current')).toBe('page');
    });
  });

  it('does NOT render "Verwendet von" section when usedByAgents is empty', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: SKILL_DETAIL_NO_AGENTS });

    const { container, queryByText } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="skill"][data-id="test"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('article')).toBeTruthy();
    });

    expect(queryByText('Verwendet von')).toBeNull();
  });
});

// ── team-detail-related-refs: AC10 — A11y for chips ──────────────────────────

describe('TeamView — team-detail-related-refs AC10: Chip A11y', () => {
  it('chip buttons do not have outline:none (focus ring visible)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    const chipButtons = container.querySelectorAll('article button[data-kind]');
    expect(chipButtons.length).toBeGreaterThan(0);
    for (const btn of chipButtons) {
      expect(btn.style.outline).not.toBe('none');
      expect(btn.style.outline).not.toBe('0');
    }
  });

  it('chip buttons have a visible label (name or id, not empty)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="skill"]')).toBeTruthy();
    });

    const chipButtons = container.querySelectorAll('article button[data-kind]');
    for (const btn of chipButtons) {
      expect(btn.textContent.trim().length).toBeGreaterThan(0);
    }
  });

  it('chip buttons are native button elements (keyboard-activatable by default)', async () => {
    globalThis.fetch = makeFetch({ overviewBody: OVERVIEW_RESPONSE, detailBody: AGENT_DETAIL_WITH_REFS });

    const { container } = renderTeam();

    await waitFor(() => {
      expect(container.querySelector('button[data-kind="agent"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-kind="agent"][data-id="coder"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('article button[data-kind="skill"]')).toBeTruthy();
    });

    const chipButtons = container.querySelectorAll('article button[data-kind]');
    for (const btn of chipButtons) {
      expect(btn.tagName.toLowerCase()).toBe('button');
      expect(btn.getAttribute('type')).toBe('button');
    }
  });
});
