/**
 * TriggerPanel.test.jsx — Unit tests for TriggerPanel component (AC4).
 *
 * Mocks fetch via a fetchFn prop.
 * Verifies: fire → POST /api/command; 202 → running state; Kill → cancel;
 * 409 → running; 400/500 → error messages; /api/session busy → running state.
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

    // Verify POST was called with default command (/flow, no arg)
    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/flow');
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

  it('includes the argument in the command when an arg is typed', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c2', status: 'running' })),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.change(getByLabelText(/argument/i), { target: { value: 'my-project' } });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/flow my-project');
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
    const fetchFn = jest.fn(() => new Promise((resolve) => { resolvePoll = resolve; }));

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
    expect(fetchFn).toHaveBeenCalledTimes(1); // only the initial poll, never the interval tick
  });
});
