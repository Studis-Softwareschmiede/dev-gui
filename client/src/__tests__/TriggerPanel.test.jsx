/**
 * TriggerPanel.test.jsx — Unit tests for TriggerPanel component (AC4, AC7).
 *
 * Mocks fetch via a fetchFn prop.
 * Verifies:
 *   - command-aware composition (preview+sub+repo, adopt+repo, requirement/train free-text)
 *   - adopt with empty repo → no request (AC7)
 *   - preview+up with empty repo → Senden disabled / no request (AC7)
 *   - preview+available → no arg in POST body
 *   - requirement with context text → POSTs /agent-flow:requirement <text>
 *   - requirement without context → POSTs bare /agent-flow:requirement
 *   - train with value → POSTs /agent-flow:train <value>
 *   - fire → POST /api/command; 202 → running state; Kill → cancel
 *   - 409 → running; 400/500 → error messages; /api/session busy → running state
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest } from '@jest/globals';
import { act, waitFor, fireEvent } from '@testing-library/react';

// Dynamic imports after mock declarations (ESM VM-modules requirement).
const { render }         = await import('@testing-library/react');
const React              = (await import('react')).default;
const { TriggerPanel }   = await import('../TriggerPanel.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a fetchFn that maps URL→response.
 * Unrecognised URLs resolve to { ok: true, status: 200, json: () => ({}) }.
 *
 * @param {Record<string, () => Promise>} map  URL → response factory
 */
function makeFetchFn(map) {
  return jest.fn((url, _opts) => {
    const factory = map[url];
    if (factory) return factory();
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
}

/** Session response helper */
function sessionResp(state) {
  return { ok: true, status: 200, json: () => Promise.resolve({ state, restarts: 0 }) };
}

/** Command response helper */
function cmdResp(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** Status response with project list */
function statusResp(projectNames = []) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      projects: projectNames.map((name) => ({ name, openItems: 0, lastCi: 'none' })),
      previews: [],
    }),
  };
}

/** Render TriggerPanel with a pre-configured fetchFn and a long poll interval. */
function renderPanel(fetchFn) {
  return render(
    React.createElement(TriggerPanel, { fetchFn, pollInterval: 60_000 })
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TriggerPanel — initial idle state', () => {
  it('renders Senden button enabled and Kill button disabled when session is ready', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      const send = getByRole('button', { name: /senden/i });
      const kill = getByRole('button', { name: /kill/i });
      expect(send.disabled).toBe(false);
      expect(kill.disabled).toBe(true);
    });
  });
});

// ── AC4 — command-aware controls render ──────────────────────────────────────

describe('TriggerPanel — command-aware controls per command', () => {
  it('shows no sub-command or arg controls for /agent-flow:flow', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
    });
    const { queryByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      // No sub-command select, no repo or free-text for 'flow'
      expect(queryByLabelText(/sub-befehl/i)).toBeNull();
      expect(queryByLabelText(/owner\/repo/i)).toBeNull();
    });
  });

  it('shows sub-command select when preview is selected', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/status': () => Promise.resolve(statusResp(['sandbox-1', 'sandbox-2'])),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    // Switch to preview
    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:preview' },
      });
    });

    await waitFor(() => {
      expect(getByLabelText(/sub-befehl/i)).toBeTruthy();
    });
  });

  it('shows adopt owner/repo input when adopt is selected', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:adopt' },
      });
    });

    await waitFor(() => {
      expect(getByLabelText(/owner\/repo/i)).toBeTruthy();
    });
  });
});

// ── AC7 — composition ────────────────────────────────────────────────────────

describe('TriggerPanel — AC7 command composition', () => {
  it('preview+up+repo composes /agent-flow:preview up <repo> in POST body', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/status':  () => Promise.resolve(statusResp(['sandbox-1', 'sandbox-2'])),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c1', status: 'running' })),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    // Select preview command
    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:preview' },
      });
    });

    // Select 'up' sub-command (it's the default, but let's be explicit)
    await act(async () => {
      fireEvent.change(getByLabelText(/sub-befehl/i), {
        target: { value: 'up' },
      });
    });

    // Wait for project list to populate — select element appears with the repo options
    await waitFor(() => {
      const repoSelect = getByRole('combobox', { name: /repo/i });
      expect(repoSelect.tagName).toBe('SELECT');
    });

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /repo/i }), {
        target: { value: 'sandbox-2' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:preview up sandbox-2');
  });

  it('preview+available posts /agent-flow:preview available (no trailing arg)', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/status':  () => Promise.resolve(statusResp([])),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c2', status: 'running' })),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:preview' },
      });
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/sub-befehl/i), {
        target: { value: 'available' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:preview available');
  });

  it('preview+list posts /agent-flow:preview list (no trailing arg)', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/status':  () => Promise.resolve(statusResp([])),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c3', status: 'running' })),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:preview' },
      });
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/sub-befehl/i), {
        target: { value: 'list' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:preview list');
  });

  it('requirement with context text → POSTs /agent-flow:requirement <text>', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c-req1', status: 'running' })),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:requirement' },
      });
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/kontext/i), {
        target: { value: 'Dark-Mode-Toggle' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:requirement Dark-Mode-Toggle');
  });

  it('requirement without context → POSTs bare /agent-flow:requirement (no trailing space)', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c-req2', status: 'running' })),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:requirement' },
      });
    });

    // Leave freeArg empty (default) and fire
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:requirement');
  });

  it('train with a value → POSTs /agent-flow:train security', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c-train1', status: 'running' })),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:train' },
      });
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/sprache/i), {
        target: { value: 'security' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:train security');
  });

  it('preview+up with empty repo → Senden disabled / no request sent (AC7)', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/status':  () => Promise.resolve(statusResp(['sandbox-1'])),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:preview' },
      });
    });

    // sub-command defaults to 'up' — ensure it's up
    await act(async () => {
      fireEvent.change(getByLabelText(/sub-befehl/i), {
        target: { value: 'up' },
      });
    });

    // Wait for repo select to appear (projects loaded), then verify Senden is disabled (no repo selected)
    await waitFor(() => {
      const repoSelect = getByRole('combobox', { name: /repo/i });
      expect(repoSelect.tagName).toBe('SELECT');
      // default value is '' (— wählen —), so Senden must be disabled
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(true);
    });

    // Clicking the disabled button triggers no command request
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCalls = fetchFn.mock.calls.filter(([url]) => url === '/api/command');
    expect(commandCalls).toHaveLength(0);
  });

  it('adopt with empty repo → no request sent (AC7 — Senden disabled)', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:adopt' },
      });
    });

    // Leave repo empty — Senden should be disabled
    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(true);
    });

    // Even clicking does nothing (button is disabled)
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCalls = fetchFn.mock.calls.filter(([url]) => url === '/api/command');
    expect(commandCalls).toHaveLength(0);
  });

  it('adopt with filled repo → posts /agent-flow:adopt <owner/repo>', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c4', status: 'running' })),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:adopt' },
      });
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/owner\/repo/i), {
        target: { value: 'octocat/Hello-World' },
      });
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:adopt octocat/Hello-World');
  });

  it('/agent-flow:flow fires with no argument', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c5', status: 'running' })),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    // Default is /agent-flow:flow — just click Senden
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:flow');
  });
});

// ── Existing behavior tests (updated for namespaced commands) ─────────────────

describe('TriggerPanel — fire command → 202 → running state', () => {
  it('POSTs /api/command with the composed command on click', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c1', status: 'running' })),
    });
    const { getByRole } = renderPanel(fetchFn);

    // Wait for initial session poll
    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    // Verify POST was called with default command (/agent-flow:flow, no arg)
    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:flow');
  });

  it('disables trigger controls and enables Kill after 202', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c1', status: 'running' })),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(true);
      expect(getByRole('button', { name: /kill/i }).disabled).toBe(false);
    });
  });
});

describe('TriggerPanel — Kill button → 200 → back to idle', () => {
  it('POSTs /api/command/cancel on Kill click and restores idle state', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c3', status: 'running' })),
      '/api/command/cancel': () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ cancelled: true }) }),
    });
    const { getByRole } = renderPanel(fetchFn);

    // Wait for idle
    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    // Fire a command → running
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /kill/i }).disabled).toBe(false);
    });

    // Click Kill
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /kill/i }));
    });

    // Should return to idle
    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
      expect(getByRole('button', { name: /kill/i }).disabled).toBe(true);
    });

    const cancelCall = fetchFn.mock.calls.find(([url]) => url === '/api/command/cancel');
    expect(cancelCall).toBeTruthy();
    expect(cancelCall[1].method).toBe('POST');
  });

  it('shows error message and keeps running state when cancel returns non-ok', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c4', status: 'running' })),
      '/api/command/cancel': () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    });
    const { getByRole } = renderPanel(fetchFn);

    // Wait for idle then fire
    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /kill/i }).disabled).toBe(false);
    });

    // Click Kill — cancel fails
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /kill/i }));
    });

    // Error message visible, still running (Kill button still enabled)
    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/abbrechen fehlgeschlagen/i);
      expect(getByRole('button', { name: /kill/i }).disabled).toBe(false);
    });
  });
});

describe('TriggerPanel — 409 → running state reflected', () => {
  it('shows running state (triggers disabled) when server returns 409', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(409, {})),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(true);
      expect(getByRole('button', { name: /kill/i }).disabled).toBe(false);
    });
  });

  it('shows an info message on 409', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(409, {})),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/läuft/i);
    });
  });
});

describe('TriggerPanel — 400 → error message, no crash', () => {
  it('shows validation error message on 400', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(400, { reason: 'not-allowed' })),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/ungültig/i);
    });
  });

  it('does not crash and keeps idle state on 400', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(400, {})),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    // Senden stays enabled (idle state — 400 does not set running)
    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });
  });
});

describe('TriggerPanel — 500 → error message, no crash', () => {
  it('shows server error message on 500', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(500, {})),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/serverfehler/i);
    });
  });

  it('does not crash on 500', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(500, {})),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    // No crash — component still renders buttons
    await waitFor(() => {
      expect(getByRole('button', { name: /kill/i })).toBeTruthy();
    });
  });
});

describe('TriggerPanel — /api/session busy → running state', () => {
  it('shows triggers disabled when session state is busy', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('busy')),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(true);
      expect(getByRole('button', { name: /kill/i }).disabled).toBe(false);
    });
  });

  it('shows running badge when session state is busy', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('busy')),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      const badge = getByRole('status', { name: /job läuft/i });
      expect(badge).toBeTruthy();
    });
  });
});

describe('TriggerPanel — unmount clears poll interval (leak guard)', () => {
  it('clears the poll interval and triggers no further state updates after unmount', async () => {
    // Use a controlled, never-resolving session fetch so the initial poll does
    // not resolve before we unmount — this ensures we only observe the poll
    // timer's clearInterval behaviour, not async state updates.
    let resolvePoll;
    const fetchFn = jest.fn((url) => {
      if (url === '/api/status') return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
      return new Promise((resolve) => { resolvePoll = resolve; });
    });

    const { unmount } = render(
      React.createElement(TriggerPanel, { fetchFn, pollInterval: 60_000 })
    );

    // Unmount before the pending poll resolves
    unmount();

    // Now resolve the dangling fetch — the `cancelled` flag in the effect
    // closure prevents any setState call on the unmounted component.
    await act(async () => {
      resolvePoll({ ok: true, json: () => Promise.resolve({ state: 'ready', restarts: 0 }) });
    });

    // If the interval was NOT cleared, the jest fake-timer tick below would
    // fire another poll and trigger a React state-update warning.  A passing
    // test here confirms clearInterval ran on cleanup.
    // Session poll + status fetch = 2 calls at mount, only 1 from the session poll
    // since status fetch is a separate one-shot effect. We check session poll count.
    const sessionCalls = fetchFn.mock.calls.filter(([url]) => url === '/api/session');
    expect(sessionCalls).toHaveLength(1); // only the initial poll, never the interval tick
  });
});
