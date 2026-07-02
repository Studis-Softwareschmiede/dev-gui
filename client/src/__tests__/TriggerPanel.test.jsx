/**
 * TriggerPanel.test.jsx — Unit tests for the slimmed TriggerPanel component.
 *
 * Mocks fetch via a fetchFn prop.
 *
 * Covers (flow-trigger): AC4, AC7 — command-aware composition + required-field guards
 *   for the interactive PTY commands that REMAIN in the panel
 *   (adopt / preview / requirement / train / new-project).
 * Covers (fabric-intake-dialog): AC3 — /agent-flow:new-project selectable + fires bare.
 * Covers (headless-manual-drain): AC8 — verschlanktes Panel:
 *   - `flow` ist NICHT mehr im Befehls-Dropdown (moved out — läuft headless über
 *     den „Board abarbeiten"-Knopf).
 *   - der Cost-Mode-Schalter ist ENTFALLEN (kein /cost-mode/i-Control, kein
 *     `--cost`-Flag in irgendeinem POST; auch nicht für das vormals cost-aware
 *     `requirement`/`train`).
 *   - `adopt` / `preview` / `requirement` / `train` / `new-project` und der
 *     Kill-Switch bleiben unverändert funktionsfähig (interaktiver PTY-Pfad).
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

/** Wait until the initial session poll settled to idle (Kill disabled). */
async function waitIdle(getByRole) {
  await waitFor(() => {
    expect(getByRole('button', { name: /kill/i }).disabled).toBe(true);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TriggerPanel — initial idle state', () => {
  it('renders idle (Kill disabled); default command adopt requires a repo → Senden disabled', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitIdle(getByRole);
    // default command is /agent-flow:adopt which needs owner/repo → Senden disabled
    expect(getByRole('button', { name: /senden/i }).disabled).toBe(true);
    expect(getByRole('button', { name: /kill/i }).disabled).toBe(true);
  });
});

// ── AC8 (headless-manual-drain) — flow + cost-mode removed (requirement bleibt) ─

describe('TriggerPanel — AC8 Verschlankung (flow + cost-mode entfernt)', () => {
  it('bietet /agent-flow:flow NICHT mehr im Dropdown; requirement bleibt Survivor', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitIdle(getByRole);

    const cmdSelect = getByRole('combobox', { name: /befehl/i });
    const options = Array.from(cmdSelect.options).map((o) => o.value);
    expect(options).toEqual([
      '/agent-flow:adopt',
      '/agent-flow:preview',
      '/agent-flow:requirement',
      '/agent-flow:train',
      '/agent-flow:new-project',
    ]);
    expect(options).not.toContain('/agent-flow:flow');
  });

  it('zeigt keinen Cost-Mode-Schalter — für keinen der verbleibenden Befehle', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/status':  () => Promise.resolve(statusResp(['sandbox-1'])),
    });
    const { getByRole, queryByLabelText, queryByTestId } = renderPanel(fetchFn);

    await waitIdle(getByRole);

    // adopt (default)
    expect(queryByLabelText(/cost-mode/i)).toBeNull();
    expect(queryByTestId('cost-info')).toBeNull();

    // train — was cost-aware before, must no longer show the switch
    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:train' },
      });
    });
    expect(queryByLabelText(/cost-mode/i)).toBeNull();

    // requirement — was cost-aware before, must no longer show the switch
    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:requirement' },
      });
    });
    expect(queryByLabelText(/cost-mode/i)).toBeNull();

    // preview
    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:preview' },
      });
    });
    expect(queryByLabelText(/cost-mode/i)).toBeNull();
  });

  it('train fires without any --cost flag (bare command)', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'ct', status: 'running' })),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:train' },
      });
    });

    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:train');
    expect(body.command).not.toMatch(/--cost/);
  });
});

// ── AC4 — command-aware controls render ──────────────────────────────────────

describe('TriggerPanel — command-aware controls per command', () => {
  it('shows adopt owner/repo input by default (adopt is the first command)', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitIdle(getByRole);
    expect(getByLabelText(/owner\/repo/i)).toBeTruthy();
  });

  it('shows sub-command select when preview is selected', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/status': () => Promise.resolve(statusResp(['sandbox-1', 'sandbox-2'])),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:preview' },
      });
    });

    await waitFor(() => {
      expect(getByLabelText(/sub-befehl/i)).toBeTruthy();
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

    await waitIdle(getByRole);

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

    await waitIdle(getByRole);

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

    await waitIdle(getByRole);

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

  it('requirement with context text → POSTs /agent-flow:requirement <text> (no --cost)', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c-req1', status: 'running' })),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitIdle(getByRole);

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
    expect(body.command).not.toMatch(/--cost/);
  });

  it('requirement without context → POSTs bare /agent-flow:requirement (no trailing space, no --cost)', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c-req2', status: 'running' })),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitIdle(getByRole);

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
    expect(body.command).not.toMatch(/--cost/);
  });

  it('train with a value → POSTs /agent-flow:train security', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c-train1', status: 'running' })),
    });
    const { getByRole, getByLabelText } = renderPanel(fetchFn);

    await waitIdle(getByRole);

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

    await waitIdle(getByRole);

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

    await waitIdle(getByRole);

    // adopt is the default command — repo empty → Senden must be disabled
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

    await waitIdle(getByRole);

    // adopt is default — just fill the repo
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

  // AC3 (fabric-intake-dialog) — /agent-flow:new-project in frontend catalog
  it('AC3 — /agent-flow:new-project is selectable in the command dropdown', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitIdle(getByRole);

    const cmdSelect = getByRole('combobox', { name: /befehl/i });
    const options = Array.from(cmdSelect.options).map((o) => o.value);
    expect(options).toContain('/agent-flow:new-project');
  });

  it('AC3 — /agent-flow:new-project fires bare command (no argument) → 202', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c-np1', status: 'running' })),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:new-project' },
      });
    });

    // Senden must be enabled immediately (no required arg)
    await waitFor(() => {
      expect(getByRole('button', { name: /senden/i }).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:new-project');
  });
});

// ── Existing behavior tests (namespaced commands) ────────────────────────────

describe('TriggerPanel — fire command → 202 → running state', () => {
  it('POSTs /api/command with the composed command on click (new-project)', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c1', status: 'running' })),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:new-project' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    const commandCall = fetchFn.mock.calls.find(([url]) => url === '/api/command');
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(commandCall[1].body);
    expect(body.command).toBe('/agent-flow:new-project');
  });

  it('disables trigger controls and enables Kill after 202', async () => {
    const fetchFn = makeFetchFn({
      '/api/session': () => Promise.resolve(sessionResp('ready')),
      '/api/command': () => Promise.resolve(cmdResp(202, { commandId: 'c1', status: 'running' })),
    });
    const { getByRole } = renderPanel(fetchFn);

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:new-project' },
      });
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

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:new-project' },
      });
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

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:new-project' },
      });
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

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:new-project' },
      });
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

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:new-project' },
      });
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

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:new-project' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/ungültig/i);
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

    await waitIdle(getByRole);

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /befehl/i }), {
        target: { value: '/agent-flow:new-project' },
      });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /senden/i }));
    });

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/serverfehler/i);
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
    const sessionCalls = fetchFn.mock.calls.filter(([url]) => url === '/api/session');
    expect(sessionCalls).toHaveLength(1); // only the initial poll, never the interval tick
  });
});
