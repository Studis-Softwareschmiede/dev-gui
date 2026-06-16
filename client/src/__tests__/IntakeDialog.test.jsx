/**
 * IntakeDialog.test.jsx — Unit tests for IntakeDialog component (S-132 + S-133, fabric-intake-dialog).
 *
 * Covers (fabric-intake-dialog): AC1, AC2, AC2b, AC4, AC9
 *   AC1  — mode switching (new vs change): correct labels/placeholders rendered;
 *           both modes render a mehrzeilige textarea.
 *           new-mode shows two-step sequence status indicator (S-133, replaces S-132 bootstrap hint).
 *   AC2  — new-mode two-trigger sequence (S-133):
 *           Trigger 1 fires /agent-flow:new-project (no argument) → 202 → onNewStepChange('trigger2').
 *           Trigger 2 fires /agent-flow:requirement <held-idea> → 202 → onNavigate('factory').
 *           No auto-chaining: Trigger 2 only offered after explicit user confirmation.
 *           change-mode fires one trigger /agent-flow:requirement <text> (regression).
 *           Held idea survives across the Bootstrap step (heldIdeaText prop).
 *   AC2b — multiline text collapsed to single line (no newlines/control chars);
 *           empty/whitespace-only text → no request fired (Senden disabled).
 *   AC4  — after 202 → onNavigate('factory') called for both triggers; no navigation on error.
 *   AC9  — cost-mode selector present, default 'balanced' → no --cost flag;
 *           non-balanced cost → --cost flag appended before text.
 *           new-project (trigger1) does NOT show cost-mode (not cost-aware).
 *
 * Additional coverage:
 *   - Submit fires POST /api/command with /agent-flow:requirement <collapsed>
 *   - Optional field text included in collapsed argument (step 2 / change mode)
 *   - 409 → error message, no navigation
 *   - 400 → error message, no navigation
 *   - 500 → error message, no navigation
 *   - Network error → error message, no navigation
 *   - I2: new mode renders aria-live sequence status (intake-new-sequence-status)
 *   - I3: optional textarea has aria-describedby pointing to hint div
 *   - S2: cost select has aria-describedby="intake-cost-info"
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest } from '@jest/globals';
import { act, waitFor, fireEvent } from '@testing-library/react';

const { render }         = await import('@testing-library/react');
const React              = (await import('react')).default;
const { IntakeDialog }   = await import('../IntakeDialog.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFetchFn(map) {
  return jest.fn((url, _opts) => {
    const factory = map[url];
    if (factory) return factory();
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
}

function cmdResp(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function renderDialog(props = {}) {
  const onNavigate = props.onNavigate ?? jest.fn();
  const fetchFn    = props.fetchFn ?? makeFetchFn({});
  const mode       = props.mode ?? 'change';
  return {
    onNavigate,
    fetchFn,
    ...render(React.createElement(IntakeDialog, { mode, onNavigate, fetchFn, ...props })),
  };
}

// ── AC1 — Mode rendering ──────────────────────────────────────────────────────

describe('IntakeDialog — AC1 mode rendering', () => {
  it('renders "Neue Projektidee" header in new mode', () => {
    const { getByText } = renderDialog({ mode: 'new' });
    expect(getByText(/neue projektidee/i)).toBeTruthy();
  });

  it('renders "Änderungswunsch" header in change mode', () => {
    const { getByText } = renderDialog({ mode: 'change' });
    expect(getByText(/änderungswunsch/i)).toBeTruthy();
  });

  it('shows Projektidee/Vision label in new mode', () => {
    const { getByLabelText } = renderDialog({ mode: 'new' });
    expect(getByLabelText(/projektidee.*vision/i)).toBeTruthy();
  });

  it('shows "Was soll sich ändern?" label in change mode', () => {
    const { getByLabelText } = renderDialog({ mode: 'change' });
    expect(getByLabelText(/was soll sich ändern/i)).toBeTruthy();
  });

  it('renders a textarea (mehrzeilige Freitexterfassung) in new mode', () => {
    const { getByLabelText } = renderDialog({ mode: 'new' });
    const el = getByLabelText(/projektidee.*vision/i);
    expect(el.tagName).toBe('TEXTAREA');
  });

  it('renders a textarea (mehrzeilige Freitexterfassung) in change mode', () => {
    const { getByLabelText } = renderDialog({ mode: 'change' });
    const el = getByLabelText(/was soll sich ändern/i);
    expect(el.tagName).toBe('TEXTAREA');
  });

  it('shows "Stack-Wunsch / Constraints" optional label in new mode step 2 (trigger2)', () => {
    // The optional field is hidden in step 1 (trigger1) but visible in step 2 (trigger2).
    const { getByLabelText } = renderDialog({ mode: 'new', newStep: 'trigger2' });
    expect(getByLabelText(/stack-wunsch.*constraints/i)).toBeTruthy();
  });

  it('hides "Stack-Wunsch / Constraints" optional label in new mode step 1 (trigger1)', () => {
    // In step 1 only the primary idea textarea is shown (optional field is for step 2).
    const { queryByLabelText } = renderDialog({ mode: 'new', newStep: 'trigger1' });
    expect(queryByLabelText(/stack-wunsch.*constraints/i)).toBeNull();
  });

  it('shows "Betroffener Bereich" optional label in change mode', () => {
    const { getByLabelText } = renderDialog({ mode: 'change' });
    expect(getByLabelText(/betroffener bereich/i)).toBeTruthy();
  });

  it('renders "new" badge in new mode', () => {
    const { getByText } = renderDialog({ mode: 'new' });
    // The mode badge text
    const badge = getByText('new');
    expect(badge).toBeTruthy();
  });

  it('renders "change" badge in change mode', () => {
    const { getByText } = renderDialog({ mode: 'change' });
    const badge = getByText('change');
    expect(badge).toBeTruthy();
  });
});

// ── I2 — Sequence status indicator (new mode, S-133 two-step sequence) ───────

describe('IntakeDialog — I2 sequence status indicator in new mode', () => {
  it('renders aria-live sequence status in new mode step 1', () => {
    const { getByTestId } = renderDialog({ mode: 'new', newStep: 'trigger1' });
    const status = getByTestId('intake-new-sequence-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toMatch(/schritt 1 von 2/i);
    expect(status.textContent).toMatch(/new-project/i);
  });

  it('renders step 2 status when newStep=trigger2', () => {
    const { getByTestId } = renderDialog({ mode: 'new', newStep: 'trigger2' });
    const status = getByTestId('intake-new-sequence-status');
    expect(status.textContent).toMatch(/schritt 2 von 2/i);
    expect(status.textContent).toMatch(/requirement/i);
  });

  it('does NOT render sequence status in change mode', () => {
    const { queryByTestId } = renderDialog({ mode: 'change' });
    expect(queryByTestId('intake-new-sequence-status')).toBeNull();
  });
});

// ── I3 — Optional textarea aria-describedby ───────────────────────────────────

describe('IntakeDialog — I3 optional textarea aria-describedby', () => {
  it('optional textarea has aria-describedby="intake-optional-hint"', () => {
    const { container } = renderDialog({ mode: 'change' });
    const optTextarea = container.querySelector('#intake-optional');
    expect(optTextarea).not.toBeNull();
    expect(optTextarea.getAttribute('aria-describedby')).toBe('intake-optional-hint');
  });

  it('hint div with id="intake-optional-hint" exists', () => {
    const { container } = renderDialog({ mode: 'change' });
    const hint = container.querySelector('#intake-optional-hint');
    expect(hint).not.toBeNull();
    expect(hint.textContent.length).toBeGreaterThan(0);
  });
});

// ── S2 — Cost select aria-describedby ────────────────────────────────────────

describe('IntakeDialog — S2 cost select aria-describedby', () => {
  it('cost select has aria-describedby="intake-cost-info"', () => {
    const { container } = renderDialog({ mode: 'change' });
    const costSelect = container.querySelector('#intake-cost');
    expect(costSelect).not.toBeNull();
    expect(costSelect.getAttribute('aria-describedby')).toBe('intake-cost-info');
  });
});

// ── AC2 — new-mode two-trigger sequence (S-133) ───────────────────────────────

describe('IntakeDialog — AC2 new-mode two-trigger sequence (S-133)', () => {
  it('change-mode: one trigger — /agent-flow:requirement <text> (regression)', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c1', status: 'running' })),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Dark-Mode einbauen' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    // Exactly one POST to /api/command
    const commandCalls = fetchFn.mock.calls.filter(([url]) => url === '/api/command');
    expect(commandCalls).toHaveLength(1);
    const body = JSON.parse(commandCalls[0][1].body);
    expect(body.command).toBe('/agent-flow:requirement Dark-Mode einbauen');
  });

  it('new-mode Trigger 1: fires /agent-flow:new-project WITHOUT argument', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'np1', status: 'running' })),
    });
    const onNewStepChange = jest.fn();
    const onNavigate = jest.fn();
    const { getByRole } = renderDialog({
      mode: 'new',
      newStep: 'trigger1',
      fetchFn,
      onNavigate,
      onNewStepChange,
    });

    // Step 1 button: "Bootstrap starten"
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bootstrap starten/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    // Must advance to trigger2
    expect(onNewStepChange).toHaveBeenCalledWith('trigger2');

    // Command must be /agent-flow:new-project WITHOUT argument
    const commandCalls = fetchFn.mock.calls.filter(([url]) => url === '/api/command');
    expect(commandCalls).toHaveLength(1);
    const body = JSON.parse(commandCalls[0][1].body);
    expect(body.command).toBe('/agent-flow:new-project');
    expect(body.command).not.toContain(' '); // no argument — single token
  });

  it('new-mode Trigger 1: fires /agent-flow:new-project even when idea text is empty', async () => {
    // Trigger 1 does not require idea text (the idea is held for Trigger 2).
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNewStepChange = jest.fn();
    const { getByRole } = renderDialog({
      mode: 'new',
      newStep: 'trigger1',
      fetchFn,
      onNewStepChange,
    });

    // Button must be enabled even with no text (no idea text required for Trigger 1)
    const btn = getByRole('button', { name: /bootstrap starten/i });
    expect(btn.disabled).toBe(false);

    await act(async () => { fireEvent.click(btn); });

    await waitFor(() => {
      expect(onNewStepChange).toHaveBeenCalledWith('trigger2');
    });
  });

  it('new-mode Trigger 2: fires /agent-flow:requirement <held-idea> after bootstrap confirmed', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'r1', status: 'running' })),
    });
    const onNavigate = jest.fn();
    const onNewStepChange = jest.fn();
    const { getByRole } = renderDialog({
      mode: 'new',
      newStep: 'trigger2',         // Parent confirmed bootstrap done — now in step 2
      heldIdeaText: 'Task-Manager für Studis',  // Idea held by parent across Bootstrap step
      fetchFn,
      onNavigate,
      onNewStepChange,
    });

    // Step 2 button: "Idee übergeben"
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /idee übergeben/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    // onNewStepChange must NOT be called again in step 2
    expect(onNewStepChange).not.toHaveBeenCalled();

    // Command must carry the held idea text
    const commandCalls = fetchFn.mock.calls.filter(([url]) => url === '/api/command');
    expect(commandCalls).toHaveLength(1);
    const body = JSON.parse(commandCalls[0][1].body);
    expect(body.command).toBe('/agent-flow:requirement Task-Manager für Studis');
  });

  it('new-mode: held idea survives the Bootstrap step (heldIdeaText prop)', async () => {
    // Simulate: user entered idea in step 1, then Bootstrap fired (nav to factory),
    // user returned → dialog remounted with heldIdeaText still containing the idea.
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { container, getByRole } = renderDialog({
      mode: 'new',
      newStep: 'trigger2',
      heldIdeaText: 'Idee aus Schritt 1',  // held by parent across unmount/remount
      fetchFn,
      onNavigate,
    });

    // The textarea must show the held idea text (populated from heldIdeaText prop)
    const textarea = container.querySelector('#intake-idea');
    expect(textarea.value).toBe('Idee aus Schritt 1');

    // Submit must carry the held text
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /idee übergeben/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe('/agent-flow:requirement Idee aus Schritt 1');
  });

  it('new-mode Trigger 1 does NOT chain to Trigger 2 automatically (no auto-chaining)', async () => {
    // After Trigger 1 202, onNewStepChange is called but onNavigate fires once (AC4),
    // and the component does NOT immediately fire a second POST (no auto-chain).
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'np2', status: 'running' })),
    });
    const onNewStepChange = jest.fn();
    const onNavigate = jest.fn();
    const { getByRole } = renderDialog({
      mode: 'new',
      newStep: 'trigger1',
      heldIdeaText: 'Idee vorhanden',
      fetchFn,
      onNavigate,
      onNewStepChange,
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bootstrap starten/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    // Only one POST fired — no auto-chain to requirement
    const commandCalls = fetchFn.mock.calls.filter(([url]) => url === '/api/command');
    expect(commandCalls).toHaveLength(1);
    expect(JSON.parse(commandCalls[0][1].body).command).toBe('/agent-flow:new-project');
  });

  it('new-mode step 2: disabled when held idea collapses to empty (AC2b)', () => {
    // If the user navigated away before entering an idea, step 2 must block submit.
    const { getByRole } = renderDialog({
      mode: 'new',
      newStep: 'trigger2',
      heldIdeaText: '',   // empty — no idea held
    });

    const btn = getByRole('button', { name: /idee übergeben.*fehlt/i });
    expect(btn.disabled).toBe(true);
  });

  it('new-mode step 1 shows "Schritt 1 von 2 — Bootstrap" sequence indicator', () => {
    const { getByTestId } = renderDialog({ mode: 'new', newStep: 'trigger1' });
    const status = getByTestId('intake-new-sequence-status');
    expect(status.textContent).toMatch(/schritt 1 von 2/i);
    expect(status.textContent).toMatch(/bootstrap/i);
  });

  it('new-mode step 2 shows "Schritt 2 von 2 — Idee übergeben" sequence indicator', () => {
    const { getByTestId } = renderDialog({ mode: 'new', newStep: 'trigger2' });
    const status = getByTestId('intake-new-sequence-status');
    expect(status.textContent).toMatch(/schritt 2 von 2/i);
    expect(status.textContent).toMatch(/bootstrap abgeschlossen/i);
  });

  it('new-mode step 1 does NOT show cost-mode switch (new-project is not cost-aware)', () => {
    const { container } = renderDialog({ mode: 'new', newStep: 'trigger1' });
    const costSelect = container.querySelector('#intake-cost');
    expect(costSelect).toBeNull();
  });

  it('new-mode step 2 DOES show cost-mode switch (requirement is cost-aware)', () => {
    const { container } = renderDialog({ mode: 'new', newStep: 'trigger2', heldIdeaText: 'Idee' });
    const costSelect = container.querySelector('#intake-cost');
    expect(costSelect).not.toBeNull();
  });
});

// ── AC4 — Navigate to factory (Terminal-Pane) on 202 ─────────────────────────

describe('IntakeDialog — AC4 navigate to factory after 202', () => {
  it('calls onNavigate("factory") after 202 (change mode)', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'x', status: 'running' })),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'API-Rate-Limiting' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });
  });

  it('calls onNavigate("factory") after 202 on Trigger 1 (new-project)', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const onNewStepChange = jest.fn();
    const { getByRole } = renderDialog({
      mode: 'new',
      newStep: 'trigger1',
      fetchFn,
      onNavigate,
      onNewStepChange,
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bootstrap starten/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });
  });

  it('calls onNavigate("factory") after 202 on Trigger 2 (requirement)', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { getByRole } = renderDialog({
      mode: 'new',
      newStep: 'trigger2',
      heldIdeaText: 'Meine Idee',
      fetchFn,
      onNavigate,
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /idee übergeben/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });
  });

  it('does NOT call onNavigate on 409 (error, not a success)', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(409, {})),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'API-Test' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      expect(getByRole('alert')).toBeTruthy();
    });

    expect(onNavigate).not.toHaveBeenCalled();
  });
});

// ── AC2b — Single-line collapse ───────────────────────────────────────────────

describe('IntakeDialog — AC2b single-line collapse', () => {
  it('collapses multiline text before sending POST', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c1', status: 'running' })),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Zeile 1\nZeile 2\nZeile 3' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(call).toBeTruthy();
    const body = JSON.parse(call[1].body);
    // Must be exactly one line — no newlines
    expect(body.command).toBe('/agent-flow:requirement Zeile 1 Zeile 2 Zeile 3');
    expect(body.command).not.toMatch(/\n|\r|\t/);
  });

  it('collapses text with mixed whitespace (tabs, carriage returns, multiple spaces)', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: '  Hallo   Welt\r\nNoch eine Zeile\t\tTabulator  ' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalled();
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe('/agent-flow:requirement Hallo Welt Noch eine Zeile Tabulator');
  });

  it('does not fire request when primary text is empty (AC2b — Leer-Guard)', async () => {
    const fetchFn = makeFetchFn({});
    const { getByRole } = renderDialog({ mode: 'change', fetchFn });

    // Leave primary textarea empty — submit button must be disabled
    const btn = getByRole('button', { name: /änderung erfassen.*fehlt/i });
    expect(btn.disabled).toBe(true);

    // Clicking a disabled button → no POST
    await act(async () => {
      fireEvent.click(btn);
    });

    const commandCalls = fetchFn.mock.calls.filter(([url]) => url === '/api/command');
    expect(commandCalls).toHaveLength(0);
  });

  it('does not fire request when text is whitespace-only (collapses to empty)', async () => {
    const fetchFn = makeFetchFn({});
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: '   \n\n   ' },
      });
    });

    // After entering whitespace only, Senden must remain disabled (collapsed to empty)
    await waitFor(() => {
      const btn = getByRole('button', { name: /änderung erfassen/i });
      expect(btn.disabled).toBe(true);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    const commandCalls = fetchFn.mock.calls.filter(([url]) => url === '/api/command');
    expect(commandCalls).toHaveLength(0);
  });
});

// ── Submit — POST /api/command ────────────────────────────────────────────────

describe('IntakeDialog — Submit fires POST /api/command with requirement', () => {
  it('posts /agent-flow:requirement <text> when text is provided (change mode)', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'r1', status: 'running' })),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Dark-Mode-Toggle einbauen' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe('/agent-flow:requirement Dark-Mode-Toggle einbauen');
  });

  it('posts /agent-flow:requirement <text> in new mode step 2', async () => {
    // In step 2 the idea has been held by the parent (heldIdeaText prop).
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { getByRole } = renderDialog({
      mode: 'new',
      newStep: 'trigger2',
      heldIdeaText: 'Task-Management-App für Studis',
      fetchFn,
      onNavigate,
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /idee übergeben/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe('/agent-flow:requirement Task-Management-App für Studis');
  });

  it('includes optional field text in the collapsed argument (step 2)', async () => {
    // Optional field is available in step 2 / change mode (not step 1).
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({
      mode: 'new',
      newStep: 'trigger2',
      heldIdeaText: 'Task-Manager',
      fetchFn,
      onNavigate,
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/stack-wunsch.*constraints/i), {
        target: { value: 'TypeScript React' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /idee übergeben/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalled();
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(call[1].body);
    // Both fields appear in the argument, separated by a space
    expect(body.command).toBe('/agent-flow:requirement Task-Manager TypeScript React');
  });
});

// ── AC9 — Cost-Mode switch ────────────────────────────────────────────────────

describe('IntakeDialog — AC9 cost-mode switch', () => {
  it('shows the cost-mode select with default "balanced"', () => {
    const { getByLabelText } = renderDialog({ mode: 'change' });
    const sel = getByLabelText(/cost-mode/i);
    expect(sel).toBeTruthy();
    expect(sel.value).toBe('balanced');
  });

  it('balanced (default) → no --cost flag in POST body', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Performance-Verbesserung' },
      });
    });

    // Leave cost at default 'balanced'
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalled();
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe('/agent-flow:requirement Performance-Verbesserung');
    expect(body.command).not.toContain('--cost');
  });

  it('low-cost → --cost low-cost flag before text', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Kleiner Bugfix' },
      });
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/cost-mode/i), {
        target: { value: 'low-cost' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalled();
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe('/agent-flow:requirement --cost low-cost Kleiner Bugfix');
  });

  it('max-quality → --cost max-quality flag before text', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Komplexe Architektur-Refaktorierung' },
      });
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/cost-mode/i), {
        target: { value: 'max-quality' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalled();
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe('/agent-flow:requirement --cost max-quality Komplexe Architektur-Refaktorierung');
  });

  it('frontier → --cost frontier flag before text', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Neues Feature mit ML' },
      });
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/cost-mode/i), {
        target: { value: 'frontier' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalled();
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe('/agent-flow:requirement --cost frontier Neues Feature mit ML');
  });

  it('shows cost-info text including Abo-Betrieb disclaimer', () => {
    const { getByTestId } = renderDialog({ mode: 'change' });
    const info = getByTestId('intake-cost-info');
    expect(info.textContent).toMatch(/abo-betrieb/i);
  });

  it('cost-info updates when frontier is selected → shows fable', async () => {
    const { getByLabelText, getByTestId } = renderDialog({ mode: 'change' });

    await act(async () => {
      fireEvent.change(getByLabelText(/cost-mode/i), {
        target: { value: 'frontier' },
      });
    });

    expect(getByTestId('intake-cost-info').textContent).toMatch(/fable/);
    expect(getByTestId('intake-cost-info').textContent).toMatch(/\$10 \/ \$50/);
  });
});

// ── Error responses ───────────────────────────────────────────────────────────

describe('IntakeDialog — error responses', () => {
  it('shows error message on 409 (job already running)', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(409, {})),
    });
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Test' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/läuft bereits/i);
    });
  });

  it('shows error message on 400 with reason from server', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(400, { reason: 'not-allowed' })),
    });
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Test' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/ungültig/i);
    });
  });

  it('shows generic error message on 500', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(500, {})),
    });
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Test' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/serverfehler/i);
    });
  });

  it('shows network error message when fetch throws', async () => {
    const fetchFn = jest.fn(() => Promise.reject(new Error('Network error')));
    const { getByLabelText, getByRole } = renderDialog({ mode: 'change', fetchFn });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Test' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /änderung erfassen/i }));
    });

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/netzwerkfehler/i);
    });
  });
});

// ── Command preview ───────────────────────────────────────────────────────────

describe('IntakeDialog — command preview', () => {
  it('shows command preview when primary text is non-empty (change mode)', async () => {
    const { getByLabelText, getByTestId } = renderDialog({ mode: 'change' });

    await act(async () => {
      fireEvent.change(getByLabelText(/was soll sich ändern/i), {
        target: { value: 'Refactoring' },
      });
    });

    await waitFor(() => {
      const preview = getByTestId('intake-preview');
      expect(preview.textContent).toContain('/agent-flow:requirement');
      expect(preview.textContent).toContain('Refactoring');
    });
  });

  it('shows new-project preview in step 1 (no text required)', () => {
    // In step 1, /agent-flow:new-project is always shown (no text argument needed).
    const { getByTestId } = renderDialog({ mode: 'new', newStep: 'trigger1' });
    const preview = getByTestId('intake-preview');
    expect(preview.textContent).toContain('/agent-flow:new-project');
  });

  it('hides command preview in step 2 when held idea is empty', () => {
    const { queryByTestId } = renderDialog({ mode: 'new', newStep: 'trigger2', heldIdeaText: '' });
    // No held text → no command → no preview
    expect(queryByTestId('intake-preview')).toBeNull();
  });

  it('hides command preview in change mode when text is empty', () => {
    const { queryByTestId } = renderDialog({ mode: 'change' });
    // No text entered → preview not shown
    expect(queryByTestId('intake-preview')).toBeNull();
  });
});
