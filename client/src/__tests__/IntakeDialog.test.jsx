/**
 * IntakeDialog.test.jsx — Unit tests for IntakeDialog component (S-132, fabric-intake-dialog).
 *
 * Covers (fabric-intake-dialog): AC1, AC2b, AC4, AC9
 *   AC1  — mode switching (new vs change): correct labels/placeholders rendered;
 *           both modes render a mehrzeilige textarea; new-mode shows bootstrap hint.
 *   AC2b — multiline text collapsed to single line (no newlines/control chars);
 *           empty/whitespace-only text → no request fired (Senden disabled).
 *   AC4  — after 202 → onNavigate('factory') called; no navigation on error.
 *   AC9  — cost-mode selector present, default 'balanced' → no --cost flag;
 *           non-balanced cost → --cost flag appended before text.
 *
 * Additional coverage:
 *   - Submit fires POST /api/command with /agent-flow:requirement <collapsed>
 *   - Optional field text included in collapsed argument
 *   - 409 → error message, no navigation
 *   - 400 → error message, no navigation
 *   - 500 → error message, no navigation
 *   - Network error → error message, no navigation
 *   - I2: new mode renders aria-live bootstrap hint
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

  it('shows "Stack-Wunsch / Constraints" optional label in new mode', () => {
    const { getByLabelText } = renderDialog({ mode: 'new' });
    expect(getByLabelText(/stack-wunsch.*constraints/i)).toBeTruthy();
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

// ── I2 — Bootstrap hint (new mode only) ──────────────────────────────────────

describe('IntakeDialog — I2 bootstrap hint in new mode', () => {
  it('renders aria-live bootstrap hint in new mode', () => {
    const { getByTestId } = renderDialog({ mode: 'new' });
    const hint = getByTestId('intake-new-bootstrap-hint');
    expect(hint.textContent).toMatch(/new-project/i);
    expect(hint.textContent).toMatch(/trigger-panel/i);
    expect(hint.getAttribute('role')).toBe('note');
  });

  it('does NOT render bootstrap hint in change mode', () => {
    const { queryByTestId } = renderDialog({ mode: 'change' });
    expect(queryByTestId('intake-new-bootstrap-hint')).toBeNull();
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

  it('posts /agent-flow:requirement <text> in new mode', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'new', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/projektidee.*vision/i), {
        target: { value: 'Task-Management-App für Studis' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /idee erfassen/i }));
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });

    const call = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe('/agent-flow:requirement Task-Management-App für Studis');
  });

  it('includes optional field text in the collapsed argument', async () => {
    const fetchFn = makeFetchFn({
      '/api/command': () => Promise.resolve(cmdResp(202, {})),
    });
    const onNavigate = jest.fn();
    const { getByLabelText, getByRole } = renderDialog({ mode: 'new', fetchFn, onNavigate });

    await act(async () => {
      fireEvent.change(getByLabelText(/projektidee.*vision/i), {
        target: { value: 'Task-Manager' },
      });
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/stack-wunsch.*constraints/i), {
        target: { value: 'TypeScript React' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /idee erfassen/i }));
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

// ── AC4 — Navigate to factory (Terminal-Pane) on 202 ─────────────────────────

describe('IntakeDialog — AC4 navigate to factory after 202', () => {
  it('calls onNavigate("factory") after 202', async () => {
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
  it('shows command preview when primary text is non-empty', async () => {
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

  it('hides command preview when text is empty', () => {
    const { queryByTestId } = renderDialog({ mode: 'change' });
    // No text entered → preview not shown
    expect(queryByTestId('intake-preview')).toBeNull();
  });
});
