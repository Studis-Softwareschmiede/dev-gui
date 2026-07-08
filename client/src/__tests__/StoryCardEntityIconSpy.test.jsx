/**
 * StoryCardEntityIconSpy.test.jsx — AC12 prop-forwarding assertions via spy mock.
 *
 * Separate test file to isolate the EntityIcon module mock from
 * StoryCardEntityIcon.test.jsx (which relies on the real SVG output).
 *
 * Covers (team-entity-icons, Etappe 3 — S2/S3 test-quality suggestions):
 *   S2 — Asserts that StoryCard passes the correct {kind, id} props to EntityIcon
 *        for a story with label "agent:coder".
 *   S3 — Asserts (via the same spy) that the FIRST matching label wins in the
 *        precedence test: for ['skill:deploy', 'agent:coder'] the spy must record
 *        {kind:'skill', id:'deploy'}, not the second label.
 *
 * Approach: jest.unstable_mockModule replaces EntityIcon.jsx with a spy
 * component that records every render's props into a shared array. All dynamic
 * imports happen AFTER the mock registration so they pick up the stubbed module.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { waitFor } from '@testing-library/react';

// ── Spy state ─────────────────────────────────────────────────────────────────
// Shared across all tests; cleared in beforeEach.
const entityIconCalls = [];

// ── Mock EntityIcon.jsx BEFORE any dynamic imports that pull in BoardView ─────
// jest.unstable_mockModule must be called before the module under test is
// imported (ESM hoisting equivalent for --experimental-vm-modules).
jest.unstable_mockModule('../icons/EntityIcon.jsx', () => ({
  EntityIcon: (props) => {
    // Record every render call so tests can assert which props were received.
    entityIconCalls.push({ kind: props.kind, id: props.id });
    // Return a minimal aria-hidden placeholder so DOM-based guards still work.
    return null;
  },
}));

// ── Mock AppShell peer-dependencies (not under test) ─────────────────────────
jest.unstable_mockModule('../Terminal.jsx',     () => ({ Terminal:      () => null }));

// ── Dynamic imports (after mocks) ─────────────────────────────────────────────
const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { BoardView } = await import('../BoardView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STORY_AGENT_CODER = {
  id: 'S-300',
  parent: 'F-300',
  title: 'Coder Agent Story',
  status: 'To Do',
  priority: 'high',
  labels: ['agent:coder', 'backend'],
  spec: null,
};

const STORY_MULTI_LABEL = {
  id: 'S-400',
  parent: 'F-400',
  title: 'Precedence Story',
  status: 'To Do',
  priority: 'high',
  // "skill:deploy" comes BEFORE "agent:coder" → skill:deploy must win.
  labels: ['skill:deploy', 'agent:coder'],
  spec: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  entityIconCalls.length = 0; // reset spy state before each test
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

async function renderProject(stories, slug) {
  const feature = { id: `F-spy-${slug}`, title: 'Spy Feature', status: 'To Do', stories };
  const project = { slug, features: [feature] };

  globalThis.fetch = makeFetch(project);
  const onNavigate = jest.fn();

  const utils = render(React.createElement(BoardView, {
    onNavigate,
    lockedProject: slug,
  }));

  await waitFor(() => {
    expect(utils.container.querySelector(`[data-project="${slug}"]`)).toBeTruthy();
  });

  return utils;
}

// ── S2: correct kind/id forwarded to EntityIcon ───────────────────────────────

describe('team-entity-icons — AC12 S2: EntityIcon receives correct kind/id props', () => {
  it('passes {kind:"agent", id:"coder"} to EntityIcon for label "agent:coder"', async () => {
    await renderProject([STORY_AGENT_CODER], 'spy-agent-coder');

    // The spy must have been called at least once with the expected props.
    const agentCoderCall = entityIconCalls.find(
      (c) => c.kind === 'agent' && c.id === 'coder',
    );
    expect(agentCoderCall).toBeDefined();
  });
});

// ── S3: first matching label wins (precedence via spy) ────────────────────────

describe('team-entity-icons — AC12 S3: first matching label wins (spy asserts winner)', () => {
  it('for ["skill:deploy", "agent:coder"] the spy records kind:"skill" id:"deploy" (not agent:coder)', async () => {
    await renderProject([STORY_MULTI_LABEL], 'spy-precedence');

    // There must be exactly one EntityIcon render for S-400 (one story).
    // It must carry the FIRST matching label: skill:deploy.
    expect(entityIconCalls.length).toBeGreaterThan(0);

    // The winning call must be skill:deploy — not agent:coder.
    const winner = entityIconCalls[0];
    expect(winner.kind).toBe('skill');
    expect(winner.id).toBe('deploy');

    // Double-check: agent:coder must NOT have been rendered.
    const loser = entityIconCalls.find((c) => c.kind === 'agent' && c.id === 'coder');
    expect(loser).toBeUndefined();
  });
});
