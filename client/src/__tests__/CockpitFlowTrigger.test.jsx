/**
 * CockpitFlowTrigger.test.jsx — Tests für AC2+AC3 (autonome-board-abarbeitung):
 * „Board abarbeiten"-Knopf im Cockpit-Reiter „Arbeiten".
 *
 * Covers (autonome-board-abarbeitung):
 *   AC2 — Im Reiter „Arbeiten" Knopf „Board abarbeiten" vorhanden;
 *          Klick öffnet Bestätigungsdialog (role=dialog);
 *          Bestätigen POSTet /agent-flow:flow an /api/command mit projectPath;
 *          Abbrechen schließt Dialog ohne POST;
 *          202 → Erfolgszustand im UI.
 *          409 → Fehler-Info im UI.
 *   AC3 — Hinweistext im „Arbeiten"-Bereich erwähnt „Blocked" / offene Fragen.
 *
 * Terminal, Dashboard, TriggerPanel, BoardView, SpecView sind gemockt
 * (WS/DOM-Komplexität vermeiden).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// ── Mock heavy sub-components ─────────────────────────────────────────────────

jest.unstable_mockModule('../Terminal.jsx', () => ({ Terminal: () => null }));
jest.unstable_mockModule('../Dashboard.jsx', () => ({ Dashboard: () => null }));
jest.unstable_mockModule('../TriggerPanel.jsx', () => ({ TriggerPanel: () => null }));
jest.unstable_mockModule('../BoardView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    BoardView: ({ lockedProject }) =>
      R.createElement('main', { 'aria-label': 'Studis-Kanban-Board', 'data-locked': lockedProject ?? '' }, 'Board Mock'),
  };
});
jest.unstable_mockModule('../SpecView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    SpecView: () => R.createElement('div', { 'data-testid': 'spec-view-stub' }, 'Spec Mock'),
  };
});

const { render }       = await import('@testing-library/react');
const React            = (await import('react')).default;
const { CockpitView }  = await import('../CockpitView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let origFetch;

beforeEach(() => {
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  window.location.hash = '';
});

/**
 * Render CockpitView with the „Arbeiten" tab active (default).
 * fetchFn is injected via the FactoryWorkspace — this test needs a way
 * to inject it. Since CockpitView passes fetchFn to FactoryWorkspace,
 * we pass it as a prop that CockpitView forwards.
 *
 * CockpitView doesn't expose fetchFn prop directly, so we use globalThis.fetch
 * as the default; tests replace globalThis.fetch before rendering.
 */
function renderCockpit(fetchFn) {
  // Replace globalThis.fetch with the test fetchFn so FactoryWorkspace picks it up
  if (fetchFn) globalThis.fetch = fetchFn;

  return render(
    React.createElement(CockpitView, {
      activeRepo: 'my-project',
      navigateFactory: jest.fn(),
      onNavigate: jest.fn(),
    }),
  );
}

function makeCommandFetch(status, body = {}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/command' && opts?.method === 'POST') {
      return { ok: status === 202, status, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

// ── AC2: Knopf vorhanden + Bestätigungsdialog ─────────────────────────────────

describe('CockpitView — AC2 (autonome-board-abarbeitung): Board abarbeiten Knopf', () => {
  it('renders „Board abarbeiten"-Button in the Arbeiten tab', () => {
    renderCockpit();
    // The Arbeiten tab is active by default; button must be visible
    const btn = document.querySelector('[data-testid="flow-board-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/board abarbeiten/i);
  });

  it('button has minHeight≥44px style (touch-target WCAG 2.1 AA)', () => {
    renderCockpit();
    const btn = document.querySelector('[data-testid="flow-board-btn"]');
    expect(btn).toBeTruthy();
    // The style is applied inline; check via attribute or direct style
    // jsdom exposes inline styles via style property
    const minH = btn.style.minHeight;
    // minH is "44px" (set in styles.btnFlowTrigger)
    const px = parseInt(minH, 10);
    expect(px).toBeGreaterThanOrEqual(44);
  });

  it('clicking „Board abarbeiten" opens confirmation dialog', async () => {
    renderCockpit();
    const btn = document.querySelector('[data-testid="flow-board-btn"]');
    await act(async () => { fireEvent.click(btn); });
    const dialog = document.querySelector('[data-testid="flow-confirm-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('role')).toBe('dialog');
  });

  it('confirmation dialog contains warning text about autonomous run', async () => {
    renderCockpit();
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="flow-board-btn"]'));
    });
    const dialog = document.querySelector('[data-testid="flow-confirm-dialog"]');
    expect(dialog.textContent).toMatch(/agent.*schreibt code|code.*prs anlegt|autonomous|fortfahren/i);
  });

  it('clicking Abbrechen closes dialog without POST', async () => {
    const fetchFn = jest.fn();
    renderCockpit(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="flow-board-btn"]'));
    });
    expect(document.querySelector('[data-testid="flow-confirm-dialog"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="flow-confirm-no"]'));
    });
    // Dialog gone
    expect(document.querySelector('[data-testid="flow-confirm-dialog"]')).toBeNull();
    // No POST made
    expect(fetchFn).not.toHaveBeenCalledWith('/api/command', expect.anything());
  });

  it('clicking Starten POSTs /agent-flow:flow to /api/command with projectPath', async () => {
    const fetchFn = makeCommandFetch(202);
    renderCockpit(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="flow-board-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="flow-confirm-yes"]'));
    });

    await waitFor(() => {
      const call = fetchFn.mock.calls.find((c) => c[0] === '/api/command');
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.command).toBe('/agent-flow:flow');
      expect(body.projectPath).toBe('my-project');
    });
  });

  it('202 response shows "started" status in UI', async () => {
    const fetchFn = makeCommandFetch(202);
    renderCockpit(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="flow-board-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="flow-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="flow-started"]')).toBeTruthy();
    });
  });

  it('409 response shows error state in UI', async () => {
    const fetchFn = makeCommandFetch(409, { error: 'A command is already running' });
    renderCockpit(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="flow-board-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="flow-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="flow-error"]')).toBeTruthy();
    });
  });
});

// ── AC3: Hinweistext „Blocked statt Raten" ───────────────────────────────────

describe('CockpitView — AC3 (autonome-board-abarbeitung): Blocked-Hinweis', () => {
  it('Arbeiten tab contains hint text about Blocked/offene Fragen', () => {
    renderCockpit();
    // The hint paragraph mentions "Blocked" (AC3 UI side)
    const sidebar = document.querySelector('[data-testid="flow-board-btn"]')?.closest('div[style]');
    if (sidebar) {
      expect(sidebar.textContent).toMatch(/blocked/i);
    } else {
      // Fallback: check entire document
      expect(document.body.textContent).toMatch(/blocked/i);
    }
  });
});
