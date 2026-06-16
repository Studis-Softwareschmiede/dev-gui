/**
 * IntakeMountIntegration.test.jsx — Mount-integration tests for IntakeDialog (S-132).
 *
 * Covers (fabric-intake-dialog): AC1, AC4
 *   AC1 — IntakeDialog is reachable from the normal user flow:
 *          (a) CockpitView (Arbeiten tab) has „Änderung erfassen"-Button (mode=change);
 *          (b) RepoOverview has „Neues Projekt / Idee erfassen"-Button (mode=new).
 *          Trigger opens the dialog, mode is correct, dialog can be closed.
 *   AC4 — After successful submit (202) onNavigate('factory') is called and dialog closes.
 *
 * Heavy sub-components are mocked (WS/DOM complexity avoided).
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
      R.createElement('main', { 'aria-label': 'Board', 'data-locked': lockedProject ?? '' }, 'Board Mock'),
  };
});
jest.unstable_mockModule('../SpecView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    SpecView: () => R.createElement('div', { 'data-testid': 'spec-view-stub' }, 'Spec Mock'),
  };
});

const { render }         = await import('@testing-library/react');
const React              = (await import('react')).default;
const { CockpitView }    = await import('../CockpitView.jsx');
const { RepoOverview }   = await import('../RepoOverview.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let origFetch;

beforeEach(() => {
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  window.location.hash = '';
});

function makeCommandFetch(status, body = {}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/command' && opts?.method === 'POST') {
      return { ok: status === 202, status, json: async () => body };
    }
    // workspace/repos for RepoOverview
    if (url === '/api/workspace/repos') {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

// ── CockpitView mount: mode=change ────────────────────────────────────────────

describe('IntakeMountIntegration — CockpitView: Änderung erfassen (mode=change)', () => {
  beforeEach(() => {
    // IntakeDialog uses globalThis.fetch as fallback when no fetchFn prop is passed.
    // Provide a no-op stub so the component can initialize (tests that need specific
    // responses override globalThis.fetch before rendering).
    globalThis.fetch = makeCommandFetch(200);
  });

  it('AC1: renders "Änderung erfassen" trigger button in CockpitView Arbeiten tab', () => {
    const onNavigate = jest.fn();
    render(
      React.createElement(CockpitView, {
        activeRepo: 'my-project',
        navigateFactory: jest.fn(),
        onNavigate,
      }),
    );

    const btn = document.querySelector('[data-testid="intake-change-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/änderung erfassen/i);
  });

  it('AC1: clicking trigger opens IntakeDialog (change badge visible)', async () => {
    const onNavigate = jest.fn();
    render(
      React.createElement(CockpitView, {
        activeRepo: 'my-project',
        navigateFactory: jest.fn(),
        onNavigate,
      }),
    );

    const btn = document.querySelector('[data-testid="intake-change-btn"]');
    await act(async () => { fireEvent.click(btn); });

    // The dialog is now open — close button should appear
    const closeBtn = document.querySelector('[data-testid="intake-close-btn"]');
    expect(closeBtn).toBeTruthy();

    // mode=change: badge text "change" is visible inside the dialog
    expect(document.body.textContent).toMatch(/change/);
  });

  it('AC1: close button hides IntakeDialog (trigger-button reappears)', async () => {
    render(
      React.createElement(CockpitView, {
        activeRepo: 'my-project',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      }),
    );

    // Open
    const openBtn = document.querySelector('[data-testid="intake-change-btn"]');
    await act(async () => { fireEvent.click(openBtn); });
    expect(document.querySelector('[data-testid="intake-close-btn"]')).toBeTruthy();

    // Close
    const closeBtn = document.querySelector('[data-testid="intake-close-btn"]');
    await act(async () => { fireEvent.click(closeBtn); });

    // Trigger button reappears
    expect(document.querySelector('[data-testid="intake-change-btn"]')).toBeTruthy();
    // Close button gone
    expect(document.querySelector('[data-testid="intake-close-btn"]')).toBeNull();
  });

  it('AC4: 202 response closes dialog and calls onNavigate("factory")', async () => {
    const onNavigate = jest.fn();
    globalThis.fetch = makeCommandFetch(202, { commandId: 'c1', status: 'running' });

    render(
      React.createElement(CockpitView, {
        activeRepo: 'my-project',
        navigateFactory: jest.fn(),
        onNavigate,
      }),
    );

    // Open dialog
    const openBtn = document.querySelector('[data-testid="intake-change-btn"]');
    await act(async () => { fireEvent.click(openBtn); });

    // Fill in text
    const textarea = document.querySelector('#intake-idea');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Dark-Mode einbauen' } });
    });

    // Submit
    const submitBtn = document.querySelector('[aria-label*="Änderung erfassen"]');
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    // Dialog closed after navigation
    expect(document.querySelector('[data-testid="intake-close-btn"]')).toBeNull();
  });
});

// ── RepoOverview mount: mode=new ──────────────────────────────────────────────

describe('IntakeMountIntegration — RepoOverview: Neues Projekt (mode=new)', () => {
  beforeEach(() => {
    // RepoOverview fetches /api/workspace/repos on mount
    globalThis.fetch = makeCommandFetch(200);
  });

  it('AC1: renders "Neues Projekt / Idee erfassen" button in RepoOverview', async () => {
    const { getByTestId } = render(
      React.createElement(RepoOverview, {
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      }),
    );

    await waitFor(() => {
      const btn = document.querySelector('[data-testid="intake-new-btn"]');
      expect(btn).toBeTruthy();
      expect(btn.textContent).toMatch(/neues projekt/i);
    });
  });

  it('AC1: clicking trigger opens IntakeDialog in new mode (bootstrap hint visible)', async () => {
    render(
      React.createElement(RepoOverview, {
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      }),
    );

    // Wait for component to finish loading repos
    await waitFor(() => {
      expect(document.querySelector('[data-testid="intake-new-btn"]')).toBeTruthy();
    });

    const openBtn = document.querySelector('[data-testid="intake-new-btn"]');
    await act(async () => { fireEvent.click(openBtn); });

    // Dialog wrapper visible
    const wrapper = document.querySelector('[data-testid="intake-new-dialog-wrapper"]');
    expect(wrapper).toBeTruthy();

    // mode=new: bootstrap hint rendered (I2)
    const hint = document.querySelector('[data-testid="intake-new-bootstrap-hint"]');
    expect(hint).toBeTruthy();
    expect(hint.textContent).toMatch(/new-project/i);
  });

  it('AC1: close button hides IntakeDialog (trigger-button reappears)', async () => {
    render(
      React.createElement(RepoOverview, {
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="intake-new-btn"]')).toBeTruthy();
    });

    // Open
    const openBtn = document.querySelector('[data-testid="intake-new-btn"]');
    await act(async () => { fireEvent.click(openBtn); });
    expect(document.querySelector('[data-testid="intake-new-dialog-wrapper"]')).toBeTruthy();

    // Close
    const closeBtn = document.querySelector('[data-testid="intake-new-close-btn"]');
    await act(async () => { fireEvent.click(closeBtn); });

    // Wrapper gone, open-button reappears
    expect(document.querySelector('[data-testid="intake-new-dialog-wrapper"]')).toBeNull();
    expect(document.querySelector('[data-testid="intake-new-btn"]')).toBeTruthy();
  });

  it('AC4: 202 response closes dialog and calls onNavigate("factory")', async () => {
    const onNavigate = jest.fn();

    // First call will be /api/workspace/repos (mount), subsequent: /api/command
    let callCount = 0;
    globalThis.fetch = jest.fn(async (url, opts) => {
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url === '/api/command' && opts?.method === 'POST') {
        return { ok: true, status: 202, json: async () => ({ commandId: 'n1', status: 'running' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      React.createElement(RepoOverview, {
        navigateFactory: jest.fn(),
        onNavigate,
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="intake-new-btn"]')).toBeTruthy();
    });

    // Open dialog
    const openBtn = document.querySelector('[data-testid="intake-new-btn"]');
    await act(async () => { fireEvent.click(openBtn); });

    // Fill primary text
    const textarea = document.querySelector('#intake-idea');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Task-Manager für Studis' } });
    });

    // Submit
    const submitBtn = document.querySelector('[aria-label*="Idee erfassen"]');
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    // Dialog closed
    expect(document.querySelector('[data-testid="intake-new-dialog-wrapper"]')).toBeNull();
  });
});
