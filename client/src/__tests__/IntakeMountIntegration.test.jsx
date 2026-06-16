/**
 * IntakeMountIntegration.test.jsx — Mount-integration tests for IntakeDialog (S-132 + S-133).
 *
 * Covers (fabric-intake-dialog): AC1, AC2, AC4
 *   AC1 — IntakeDialog is reachable from the normal user flow:
 *          (a) CockpitView (Arbeiten tab) has „Änderung erfassen"-Button (mode=change);
 *          (b) RepoOverview has „Neues Projekt / Idee erfassen"-Button (mode=new).
 *          Trigger opens the dialog, mode is correct, dialog can be closed.
 *   AC2 — new-mode two-trigger sequence (S-133):
 *          Trigger 1 (/agent-flow:new-project) 202 → onNewStepChange('trigger2') + navigate;
 *          dialog stays open (dialog does NOT close after Trigger 1).
 *          Trigger 2 (/agent-flow:requirement <held-idea>) 202 → dialog closes + navigate.
 *          Held idea (heldIdeaText) survives pane-switch: state in parent (RepoOverview)
 *          is not lost when IntakeDialog unmounts on navigate.
 *          change-mode: one trigger only (regression — dialog closes after single 202).
 *          Reopen after completed sequence: dialog starts in step 1 (Bootstrap visible,
 *          no stale idea text, sequence status "Schritt 1 von 2") — no Bootstrap-skip.
 *   AC4 — After successful submit (202) onNavigate('factory') is called for both triggers.
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

  it('AC4: 202 response closes dialog and calls onNavigate("factory") (change mode — one trigger)', async () => {
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

    // Dialog closed after navigation (change mode: single trigger, closes immediately)
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
    render(
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

  it('AC1: clicking trigger opens IntakeDialog in new mode (sequence status indicator visible)', async () => {
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

    // mode=new: sequence status rendered (S-133 — step 1 sequence indicator)
    const seqStatus = document.querySelector('[data-testid="intake-new-sequence-status"]');
    expect(seqStatus).toBeTruthy();
    expect(seqStatus.textContent).toMatch(/new-project/i);
    expect(seqStatus.textContent).toMatch(/schritt 1 von 2/i);
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

  it('AC2+AC4: Trigger 1 (new-project) 202 → onNavigate("factory") + dialog stays open (no close)', async () => {
    // Trigger 1 fires /agent-flow:new-project → 202 → navigates to terminal.
    // Dialog must STAY OPEN (step advances to trigger2, user returns to submit idea).
    const onNavigate = jest.fn();

    globalThis.fetch = jest.fn(async (url, opts) => {
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url === '/api/command' && opts?.method === 'POST') {
        const body = JSON.parse(opts.body);
        // Only accept new-project for trigger 1
        if (body.command === '/agent-flow:new-project') {
          return { ok: true, status: 202, json: async () => ({ commandId: 'np1', status: 'running' }) };
        }
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

    // Fill idea text (pre-captured for step 2)
    const textarea = document.querySelector('#intake-idea');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Meine Projektidee' } });
    });

    // Submit Trigger 1 — "Bootstrap starten"
    const bootstrapBtn = document.querySelector('[aria-label*="Bootstrap starten"]');
    expect(bootstrapBtn).toBeTruthy();
    await act(async () => { fireEvent.click(bootstrapBtn); });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    // Dialog must remain OPEN after Trigger 1 (step advanced to trigger2, waiting for user)
    expect(document.querySelector('[data-testid="intake-new-dialog-wrapper"]')).toBeTruthy();

    // Step indicator now shows Schritt 2 von 2
    const seqStatus = document.querySelector('[data-testid="intake-new-sequence-status"]');
    expect(seqStatus).toBeTruthy();
    expect(seqStatus.textContent).toMatch(/schritt 2 von 2/i);
  });

  it('AC2+AC4: Trigger 2 (requirement) 202 → dialog closes + onNavigate("factory")', async () => {
    // Simulate state after Trigger 1 completed: newStep=trigger2, heldIdeaText already set.
    // We render RepoOverview with the dialog already open AND in step 2.
    // Since RepoOverview owns newStep/heldIdeaText in state, we simulate the full flow.
    const onNavigate = jest.fn();
    let postCount = 0;

    globalThis.fetch = jest.fn(async (url, opts) => {
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url === '/api/command' && opts?.method === 'POST') {
        postCount += 1;
        return { ok: true, status: 202, json: async () => ({ commandId: `cmd${postCount}`, status: 'running' }) };
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

    // Enter idea text
    const textarea = document.querySelector('#intake-idea');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Task-Manager für Studis' } });
    });

    // Trigger 1: Bootstrap starten → 202 → stays open, step advances
    const bootstrapBtn = document.querySelector('[aria-label*="Bootstrap starten"]');
    await act(async () => { fireEvent.click(bootstrapBtn); });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });
    onNavigate.mockClear(); // reset for Trigger 2

    // Dialog still open in step 2 — "Idee übergeben" button present
    await waitFor(() => {
      expect(document.querySelector('[aria-label*="Idee übergeben"]')).toBeTruthy();
    });

    // Trigger 2: Idee übergeben → 202 → dialog closes
    const ideaBtn = document.querySelector('[aria-label*="Idee übergeben"]');
    await act(async () => { fireEvent.click(ideaBtn); });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    // Dialog closed after Trigger 2
    expect(document.querySelector('[data-testid="intake-new-dialog-wrapper"]')).toBeNull();
    expect(document.querySelector('[data-testid="intake-new-btn"]')).toBeTruthy();
  });

  it('AC2: held idea survives pane-switch (heldIdeaText in parent state across trigger1 → trigger2)', async () => {
    // Verifies the key AC2 state-persistence contract:
    // After Trigger 1, user navigates to terminal (onNavigate), but when they return
    // (dialog still open), the idea entered in step 1 is still present in the textarea.
    const onNavigate = jest.fn();

    globalThis.fetch = jest.fn(async (url, opts) => {
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url === '/api/command' && opts?.method === 'POST') {
        return { ok: true, status: 202, json: async () => ({ commandId: 'np1', status: 'running' }) };
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

    // Open dialog and enter idea
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="intake-new-btn"]')); });
    const textarea = document.querySelector('#intake-idea');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Gespeicherte Idee' } });
    });

    // Fire Trigger 1
    const bootstrapBtn = document.querySelector('[aria-label*="Bootstrap starten"]');
    await act(async () => { fireEvent.click(bootstrapBtn); });

    await waitFor(() => {
      // After trigger1: step should be 2 (sequence status shows Schritt 2)
      const seqStatus = document.querySelector('[data-testid="intake-new-sequence-status"]');
      expect(seqStatus).toBeTruthy();
      expect(seqStatus.textContent).toMatch(/schritt 2 von 2/i);
    });

    // The idea must still be present in the textarea (held in parent across the step)
    const textareaAfter = document.querySelector('#intake-idea');
    expect(textareaAfter.value).toBe('Gespeicherte Idee');
  });

  it('AC4 (legacy): 202 response closes dialog and calls onNavigate("factory") after both triggers', async () => {
    // Full flow smoke test — same as AC2+AC4 Trigger 2 test above, re-formulated as AC4.
    const onNavigate = jest.fn();
    let callCount = 0;

    globalThis.fetch = jest.fn(async (url, opts) => {
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url === '/api/command' && opts?.method === 'POST') {
        callCount += 1;
        return { ok: true, status: 202, json: async () => ({ commandId: `n${callCount}`, status: 'running' }) };
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
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="intake-new-btn"]')); });

    // Fill primary text
    const textarea = document.querySelector('#intake-idea');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Task-Manager für Studis' } });
    });

    // Trigger 1 (Bootstrap starten)
    await act(async () => { fireEvent.click(document.querySelector('[aria-label*="Bootstrap starten"]')); });
    await waitFor(() => { expect(onNavigate).toHaveBeenCalledWith('factory'); });
    onNavigate.mockClear();

    // Trigger 2 (Idee übergeben)
    await waitFor(() => { expect(document.querySelector('[aria-label*="Idee übergeben"]')).toBeTruthy(); });
    await act(async () => { fireEvent.click(document.querySelector('[aria-label*="Idee übergeben"]')); });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    // Dialog closed
    expect(document.querySelector('[data-testid="intake-new-dialog-wrapper"]')).toBeNull();
  });

  it('AC2 (reopen): after completed sequence, re-opening dialog starts in step 1 (no Bootstrap-skip)', async () => {
    // Verifies I1 fix: after a full Trigger1→Trigger2 cycle the sequence state
    // is reset so the next open always shows step 1 (Bootstrap button) with an
    // empty idea field — not stale trigger2 state with the old idea pre-loaded.
    const onNavigate = jest.fn();
    let callCount = 0;

    globalThis.fetch = jest.fn(async (url, opts) => {
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url === '/api/command' && opts?.method === 'POST') {
        callCount += 1;
        return { ok: true, status: 202, json: async () => ({ commandId: `r${callCount}`, status: 'running' }) };
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

    // ── First complete sequence ────────────────────────────────────────────────

    // Open dialog
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="intake-new-btn"]')); });

    // Enter idea text
    const textarea = document.querySelector('#intake-idea');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Erste Projektidee' } });
    });

    // Trigger 1 → stays open, advances to step 2
    await act(async () => { fireEvent.click(document.querySelector('[aria-label*="Bootstrap starten"]')); });
    await waitFor(() => { expect(onNavigate).toHaveBeenCalledWith('factory'); });
    onNavigate.mockClear();

    // Trigger 2 → dialog closes
    await waitFor(() => { expect(document.querySelector('[aria-label*="Idee übergeben"]')).toBeTruthy(); });
    await act(async () => { fireEvent.click(document.querySelector('[aria-label*="Idee übergeben"]')); });
    await waitFor(() => { expect(onNavigate).toHaveBeenCalledWith('factory'); });

    // Confirm dialog closed
    expect(document.querySelector('[data-testid="intake-new-dialog-wrapper"]')).toBeNull();

    // ── Re-open: must start in step 1, not stale step 2 ──────────────────────

    const reopenBtn = document.querySelector('[data-testid="intake-new-btn"]');
    expect(reopenBtn).toBeTruthy();
    await act(async () => { fireEvent.click(reopenBtn); });

    // Dialog wrapper visible again
    expect(document.querySelector('[data-testid="intake-new-dialog-wrapper"]')).toBeTruthy();

    // Sequence status must show step 1 of 2 (not step 2)
    await waitFor(() => {
      const seqStatus = document.querySelector('[data-testid="intake-new-sequence-status"]');
      expect(seqStatus).toBeTruthy();
      expect(seqStatus.textContent).toMatch(/schritt 1 von 2/i);
    });

    // Bootstrap button must be visible (not Idee übergeben from step 2)
    expect(document.querySelector('[aria-label*="Bootstrap starten"]')).toBeTruthy();
    expect(document.querySelector('[aria-label*="Idee übergeben"]')).toBeNull();

    // Idea textarea must be empty (no stale text from previous run)
    const freshTextarea = document.querySelector('#intake-idea');
    expect(freshTextarea).toBeTruthy();
    expect(freshTextarea.value).toBe('');
  });
});
