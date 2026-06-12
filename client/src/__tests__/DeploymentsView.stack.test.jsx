/**
 * DeploymentsView.stack.test.jsx — Unit tests for AC12: UI-Modus-Umschalter (stack-deploy-orchestration.md)
 *
 * Spec: stack-deploy-orchestration.md
 *
 * Covers:
 *   AC12 — Modus-Umschalter Single-Image | Compose-Stack
 *     - Mode toggle renders with both buttons (Single-Image + Compose-Stack aus Repo)
 *     - Switching to stack mode loads stacks via GET /api/deployments/stacks
 *     - Stack-Auswahl (select rendered from registry response)
 *     - Stack-Deploy (POST /api/deployments/stacks/{stackName}/deploy)
 *     - Stack-Undeploy type-to-confirm gate (submit disabled until confirm === stackName)
 *     - Stack-Undeploy DELETE /api/deployments/stacks/{stackName}/undeploy with body {confirm}
 *     - Stack-Status GET /api/deployments/stacks/{stackName}/status with drift-flag display
 *     - Single-Image mode remains functional (no regression on mode switch back)
 *     - A11y: role="group", aria-pressed, aria-label, aria-live, aria-busy, touch-targets >= 44px
 *     - Security: no secrets in rendered output (formatReason stripping)
 *     - 422 protected-resource and confirmation-required rendered as user-friendly text
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }              = await import('@testing-library/react');
const React                   = (await import('react')).default;
const { DeploymentsView }     = await import('../DeploymentsView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function renderView(props = {}) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(DeploymentsView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

function makeFetchOk(body) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
}

function makeFetchError(status, body) {
  return jest.fn(async () => ({
    ok: false,
    status,
    json: async () => body,
  }));
}

/** Switch to stack mode and wait for stacks to load */
async function switchToStackMode(utils) {
  await act(async () => {
    fireEvent.click(utils.getByRole('button', { name: /Compose-Stack aus Repo/i }));
  });
}

// ── Mode toggle — presence & A11y ─────────────────────────────────────────────

describe('DeploymentsView — AC12: Mode toggle presence & A11y', () => {
  it('renders a mode toggle group with aria-label', () => {
    const { container } = renderView();
    const group = container.querySelector('[role="group"][aria-label="Deployment-Modus wählen"]');
    expect(group).toBeTruthy();
  });

  it('renders "Single-Image" button in the toggle', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /^Single-Image$/i });
    expect(btn).toBeTruthy();
  });

  it('renders "Compose-Stack aus Repo" button in the toggle', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /Compose-Stack aus Repo/i });
    expect(btn).toBeTruthy();
  });

  it('Single-Image button has aria-pressed=true by default', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /^Single-Image$/i });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('Compose-Stack button has aria-pressed=false by default', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /Compose-Stack aus Repo/i });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('mode toggle buttons have minHeight >= 44px (touch targets)', () => {
    const { getByRole } = renderView();
    const singleBtn = getByRole('button', { name: /^Single-Image$/i });
    const stackBtn  = getByRole('button', { name: /Compose-Stack aus Repo/i });
    expect(parseInt(singleBtn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    expect(parseInt(stackBtn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
  });

  it('clicking "Compose-Stack aus Repo" sets aria-pressed=true on it', async () => {
    globalThis.fetch = makeFetchOk({ stacks: [] });
    const { getByRole } = renderView();
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Compose-Stack aus Repo/i }));
    });
    expect(getByRole('button', { name: /Compose-Stack aus Repo/i }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: /^Single-Image$/i }).getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking "Single-Image" after stack mode restores single-image mode', async () => {
    globalThis.fetch = makeFetchOk({ stacks: [] });
    const { getByRole } = renderView();

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Compose-Stack aus Repo/i }));
    });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /^Single-Image$/i }));
    });
    expect(getByRole('button', { name: /^Single-Image$/i }).getAttribute('aria-pressed')).toBe('true');
  });
});

// ── Single-Image mode preserved ───────────────────────────────────────────────

describe('DeploymentsView — AC12: Single-Image mode unimpaired after toggle exists', () => {
  it('renders Deploy-starten button in default single-image mode', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /Deploy starten/i });
    expect(btn).toBeTruthy();
  });

  it('Deploy form is visible in single-image mode', () => {
    const { getByRole } = renderView();
    expect(getByRole('form', { name: /Deploy-Formular/i })).toBeTruthy();
  });

  it('Deploy form is NOT visible in stack mode', async () => {
    globalThis.fetch = makeFetchOk({ stacks: [] });
    const { getByRole, queryByRole } = renderView();
    await switchToStackMode({ getByRole });
    expect(queryByRole('form', { name: /Deploy-Formular/i })).toBeNull();
  });

  it('Stack mode sections are NOT visible in single-image mode', () => {
    const { queryByRole } = renderView();
    expect(queryByRole('region', { name: /Stack-Auswahl/i })).toBeNull();
  });
});

// ── Stack mode: load stacks from registry ────────────────────────────────────

describe('DeploymentsView — AC12: Stack mode loads stacks (GET /api/deployments/stacks)', () => {
  it('calls GET /api/deployments/stacks on switch to stack mode', async () => {
    globalThis.fetch = makeFetchOk({ stacks: [] });
    const { getByRole } = renderView();

    await switchToStackMode({ getByRole });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/deployments/stacks');
  });

  it('shows "Stack-Auswahl" section in stack mode', async () => {
    globalThis.fetch = makeFetchOk({ stacks: [] });
    const { getByRole } = renderView();

    await switchToStackMode({ getByRole });

    await waitFor(() => {
      expect(getByRole('region', { name: /Stack-Auswahl/i })).toBeTruthy();
    });
  });

  it('renders stack options in select when registry returns stacks', async () => {
    globalThis.fetch = makeFetchOk({
      stacks: [
        { stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' },
        { stackName: 'otheralpha', repoUrl: 'https://github.com/org/other', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't2' },
      ],
    });
    const { getByRole } = renderView();

    await switchToStackMode({ getByRole });

    await waitFor(() => {
      expect(getByRole('combobox', { name: /Compose-Stack auswählen/i })).toBeTruthy();
    });

    const select = getByRole('combobox', { name: /Compose-Stack auswählen/i });
    expect(select.querySelector('option[value="myapp"]')).toBeTruthy();
    expect(select.querySelector('option[value="otheralpha"]')).toBeTruthy();
  });

  it('shows "Keine Stacks in der Registry" when registry is empty', async () => {
    globalThis.fetch = makeFetchOk({ stacks: [] });
    const { getByRole, findByText } = renderView();

    await switchToStackMode({ getByRole });

    const msg = await findByText(/Keine Stacks in der Registry/i);
    expect(msg).toBeTruthy();
  });

  it('shows error alert when stacks load fails', async () => {
    globalThis.fetch = makeFetchError(500, { error: 'Stack-Registry nicht erreichbar' });
    const { getByRole, findByRole } = renderView();

    await switchToStackMode({ getByRole });

    const alert = await findByRole('alert');
    expect(alert.textContent).toMatch(/Stack-Registry nicht erreichbar/i);
  });

  it('shows error alert on network failure', async () => {
    globalThis.fetch = jest.fn(async () => { throw new Error('Network fail'); });
    const { getByRole, findByRole } = renderView();

    await switchToStackMode({ getByRole });

    const alert = await findByRole('alert');
    expect(alert.textContent).toMatch(/Netzwerkfehler/i);
  });

  it('Aktualisieren button reloads stacks', async () => {
    globalThis.fetch = makeFetchOk({ stacks: [] });
    const { getByRole } = renderView();

    await switchToStackMode({ getByRole });

    await waitFor(() => {
      expect(getByRole('region', { name: /Stack-Auswahl/i })).toBeTruthy();
    });

    const callCount = globalThis.fetch.mock.calls.length;
    await act(async () => {
      // Find the refresh button inside Stack-Auswahl section
      fireEvent.click(getByRole('button', { name: /Aktualisieren/i }));
    });
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(callCount);
  });
});

// ── Stack mode: deploy ────────────────────────────────────────────────────────

describe('DeploymentsView — AC12: Stack-Deploy (POST /api/deployments/stacks/{stackName}/deploy)', () => {
  function makeStackFetch(stackName) {
    return jest.fn(async (url, init) => {
      if (url.includes('/deploy') && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ result: 'ok', stack: { stackName } }) };
      }
      if (url.includes('/status')) {
        return { ok: true, status: 200, json: async () => ({ stackName, project: stackName, services: [] }) };
      }
      // List stacks (GET /api/deployments/stacks)
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName, repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });
  }

  async function setupWithStack(stackName = 'myapp') {
    globalThis.fetch = makeStackFetch(stackName);

    const utils = renderView();

    await switchToStackMode(utils);

    await waitFor(() => {
      expect(utils.getByRole('combobox', { name: /Compose-Stack auswählen/i })).toBeTruthy();
    });

    // Select the stack
    await act(async () => {
      fireEvent.change(utils.getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: stackName },
      });
    });

    return utils;
  }

  it('renders "Stack deployen" button after selecting a stack', async () => {
    const { getByRole } = await setupWithStack();
    await waitFor(() => {
      expect(getByRole('button', { name: /Stack deployen/i })).toBeTruthy();
    });
  });

  it('Stack-Deploy-Formular has aria-label', async () => {
    const { getByRole } = await setupWithStack();
    await waitFor(() => {
      expect(getByRole('form', { name: /Stack-Deploy-Formular/i })).toBeTruthy();
    });
  });

  it('POST /api/deployments/stacks/{stackName}/deploy on submit', async () => {
    let deployUrl;
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/deploy') && init?.method === 'POST') {
        deployUrl = url;
        return { ok: true, status: 200, json: async () => ({ result: 'ok', stack: { stackName: 'myapp' } }) };
      }
      if (url.includes('/status')) {
        return { ok: true, status: 200, json: async () => ({ stackName: 'myapp', project: 'myapp', services: [] }) };
      }
      // GET stacks
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('button', { name: /Stack deployen/i }));
    await act(async () => {
      fireEvent.submit(getByRole('form', { name: /Stack-Deploy-Formular/i }));
    });

    await waitFor(() => {
      expect(deployUrl).toBeTruthy();
    });
    expect(deployUrl).toContain('/api/deployments/stacks/myapp/deploy');
  });

  it('shows success message after successful deploy', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/deploy') && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ result: 'ok', stack: { stackName: 'myapp' } }) };
      }
      if (url.includes('/status')) {
        return { ok: true, status: 200, json: async () => ({ stackName: 'myapp', project: 'myapp', services: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('form', { name: /Stack-Deploy-Formular/i }));
    await act(async () => {
      fireEvent.submit(getByRole('form', { name: /Stack-Deploy-Formular/i }));
    });

    const alert = await findByRole('alert');
    expect(alert.textContent).toMatch(/Stack deployt.*myapp/i);
  });

  it('shows error on deploy failure (422 protected-resource)', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/deploy') && init?.method === 'POST') {
        return { ok: false, status: 422, json: async () => ({ result: 'error', reason: 'protected-resource' }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('form', { name: /Stack-Deploy-Formular/i }));
    await act(async () => {
      fireEvent.submit(getByRole('form', { name: /Stack-Deploy-Formular/i }));
    });

    const alert = await findByRole('alert');
    expect(alert.textContent).toMatch(/geschuetzt/i);
  });

  it('shows error on network failure during deploy', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/deploy') && init?.method === 'POST') {
        throw new Error('Network error');
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('form', { name: /Stack-Deploy-Formular/i }));
    await act(async () => {
      fireEvent.submit(getByRole('form', { name: /Stack-Deploy-Formular/i }));
    });

    const alert = await findByRole('alert');
    expect(alert.textContent).toMatch(/Netzwerkfehler/i);
  });
});

// ── Stack mode: undeploy type-to-confirm ─────────────────────────────────────

describe('DeploymentsView — AC12: Stack-Undeploy type-to-confirm', () => {
  async function setupStackUndeploy(stackName = 'myapp') {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/undeploy') && init?.method === 'DELETE') {
        const body = JSON.parse(init.body);
        if (body.confirm === stackName) {
          return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
        }
        return { ok: false, status: 422, json: async () => ({ result: 'error', reason: 'confirmation-required' }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName, repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const utils = renderView();
    await switchToStackMode(utils);
    await waitFor(() => utils.getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(utils.getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: stackName },
      });
    });

    return utils;
  }

  it('renders "Stack entfernen" section after selecting a stack', async () => {
    const { getByRole } = await setupStackUndeploy();
    await waitFor(() => {
      expect(getByRole('region', { name: /Stack entfernen/i })).toBeTruthy();
    });
  });

  it('renders confirm input with correct aria-label', async () => {
    const { getByLabelText } = await setupStackUndeploy('myapp');
    await waitFor(() => {
      expect(getByLabelText(/Stack-Name myapp bestätigen/i)).toBeTruthy();
    });
  });

  it('submit button disabled when confirm is empty', async () => {
    const { getByRole } = await setupStackUndeploy('myapp');
    await waitFor(() => getByRole('region', { name: /Stack entfernen/i }));

    const submitBtn = getByRole('button', { name: /Stack entfernen bestätigen/i });
    expect(submitBtn.disabled).toBe(true);
  });

  it('submit button disabled when confirm != stackName', async () => {
    const { getByRole, getByLabelText } = await setupStackUndeploy('myapp');
    await waitFor(() => getByRole('region', { name: /Stack entfernen/i }));

    await act(async () => {
      fireEvent.change(getByLabelText(/Stack-Name myapp bestätigen/i), {
        target: { value: 'wrong-name' },
      });
    });

    expect(getByRole('button', { name: /Stack entfernen bestätigen/i }).disabled).toBe(true);
  });

  it('submit button enabled when confirm === stackName', async () => {
    const { getByRole, getByLabelText } = await setupStackUndeploy('myapp');
    await waitFor(() => getByRole('region', { name: /Stack entfernen/i }));

    await act(async () => {
      fireEvent.change(getByLabelText(/Stack-Name myapp bestätigen/i), {
        target: { value: 'myapp' },
      });
    });

    expect(getByRole('button', { name: /Stack entfernen bestätigen/i }).disabled).toBe(false);
  });

  it('sends DELETE /api/deployments/stacks/{stackName}/undeploy with correct body', async () => {
    let deleteCall;
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/undeploy') && init?.method === 'DELETE') {
        deleteCall = { url, body: JSON.parse(init.body) };
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, getByLabelText } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('region', { name: /Stack entfernen/i }));

    await act(async () => {
      fireEvent.change(getByLabelText(/Stack-Name myapp bestätigen/i), {
        target: { value: 'myapp' },
      });
    });

    await act(async () => {
      fireEvent.submit(getByRole('region', { name: /Stack entfernen/i }).querySelector('form'));
    });

    await waitFor(() => {
      expect(deleteCall).toBeDefined();
    });

    expect(deleteCall.url).toContain('/api/deployments/stacks/myapp/undeploy');
    expect(deleteCall.body).toMatchObject({ confirm: 'myapp' });
    // No secret in body
    expect(Object.keys(deleteCall.body)).not.toContain('token');
    expect(Object.keys(deleteCall.body)).not.toContain('key');
  });

  it('shows success message after successful undeploy', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/undeploy') && init?.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ result: 'ok' }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, getByLabelText, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('region', { name: /Stack entfernen/i }));

    await act(async () => {
      fireEvent.change(getByLabelText(/Stack-Name myapp bestätigen/i), {
        target: { value: 'myapp' },
      });
    });

    await act(async () => {
      fireEvent.submit(getByRole('region', { name: /Stack entfernen/i }).querySelector('form'));
    });

    const alert = await findByRole('alert');
    expect(alert.textContent).toMatch(/Stack entfernt.*myapp/i);
  });

  it('shows user-friendly message for 422 confirmation-required', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/undeploy') && init?.method === 'DELETE') {
        return { ok: false, status: 422, json: async () => ({ result: 'error', reason: 'confirmation-required' }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, getByLabelText, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('region', { name: /Stack entfernen/i }));

    // Set confirm to trigger submit (button must be enabled)
    await act(async () => {
      fireEvent.change(getByLabelText(/Stack-Name myapp bestätigen/i), {
        target: { value: 'myapp' },
      });
    });

    await act(async () => {
      fireEvent.submit(getByRole('region', { name: /Stack entfernen/i }).querySelector('form'));
    });

    const alert = await findByRole('alert');
    // formatReason('confirmation-required', 'stack') → 'Bitte den Stack-Namen exakt eintippen...'
    expect(alert.textContent).toMatch(/Stack-Namen exakt eintippen/i);
  });
});

// ── Stack mode: status with drift flags ──────────────────────────────────────

describe('DeploymentsView — AC12: Stack-Status with drift flags', () => {
  async function setupAndSelectStack(stackName = 'myapp') {
    globalThis.fetch = jest.fn(async (url) => {
      if (url.includes('/status')) {
        return {
          ok: true, status: 200, json: async () => ({
            stackName,
            project: stackName,
            services: [
              { service: 'web', hostname: 'app.example.com', status: 'running', containerPresent: true, routePresent: true, drift: false },
              { service: 'api', hostname: 'api.example.com', status: null, containerPresent: false, routePresent: true, drift: true },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName, repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const utils = renderView();
    await switchToStackMode(utils);
    await waitFor(() => utils.getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(utils.getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: stackName },
      });
    });

    return utils;
  }

  it('renders "Stack-Status" section after selecting a stack', async () => {
    const { getByRole } = await setupAndSelectStack();
    await waitFor(() => {
      expect(getByRole('region', { name: /Stack-Status/i })).toBeTruthy();
    });
  });

  it('"Status abrufen" button is present', async () => {
    const { getByRole } = await setupAndSelectStack();
    await waitFor(() => {
      expect(getByRole('button', { name: /Status abrufen/i })).toBeTruthy();
    });
  });

  it('GET /api/deployments/stacks/{stackName}/status on button click', async () => {
    let statusUrl;
    globalThis.fetch = jest.fn(async (url) => {
      if (url.includes('/status')) {
        statusUrl = url;
        return { ok: true, status: 200, json: async () => ({ stackName: 'myapp', project: 'myapp', services: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('button', { name: /Status abrufen/i }));
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Status abrufen/i }));
    });

    await waitFor(() => {
      expect(statusUrl).toBeTruthy();
    });
    expect(statusUrl).toContain('/api/deployments/stacks/myapp/status');
  });

  it('renders service table with drift flags', async () => {
    const { getByRole } = await setupAndSelectStack('myapp');
    await waitFor(() => getByRole('button', { name: /Status abrufen/i }));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Status abrufen/i }));
    });

    await waitFor(() => {
      expect(getByRole('table', { name: /Stack-Service-Status/i })).toBeTruthy();
    });
  });

  it('shows drift flag in status table for drifted service', async () => {
    const { getByRole, findByRole } = await setupAndSelectStack('myapp');
    await waitFor(() => getByRole('button', { name: /Status abrufen/i }));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Status abrufen/i }));
    });

    // Wait for table to appear
    await findByRole('table', { name: /Stack-Service-Status/i });

    // The drift column cell for drifted service should show 'Drift'
    const driftedCell = getByRole('cell', {
      name: /Drift erkannt für api/i,
    });
    expect(driftedCell.textContent).toBe('Drift');
  });

  it('shows "OK" (no drift) for healthy service', async () => {
    const { getByRole, findByRole } = await setupAndSelectStack('myapp');
    await waitFor(() => getByRole('button', { name: /Status abrufen/i }));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Status abrufen/i }));
    });

    await findByRole('table', { name: /Stack-Service-Status/i });

    const okCell = getByRole('cell', { name: /Kein Drift für web/i });
    expect(okCell.textContent).toBe('OK');
  });

  it('drift conveyed by text label, not colour alone (a11y — no colour-only meaning)', async () => {
    const { getByRole, findByRole } = await setupAndSelectStack('myapp');
    await waitFor(() => getByRole('button', { name: /Status abrufen/i }));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Status abrufen/i }));
    });

    await findByRole('table', { name: /Stack-Service-Status/i });

    // Drift cell must have aria-label AND text content (not just colour)
    const driftCell = getByRole('cell', { name: /Drift erkannt für api/i });
    expect(driftCell.textContent).toBe('Drift');
    expect(driftCell.getAttribute('aria-label')).toMatch(/Drift erkannt/i);
  });

  it('shows errors[] from status response', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url.includes('/status')) {
        return {
          ok: true, status: 200, json: async () => ({
            stackName: 'myapp', project: 'myapp', services: [],
            errors: [{ scope: 'composePs:myapp', errorClass: 'ssh-connect-failed' }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('button', { name: /Status abrufen/i }));
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Status abrufen/i }));
    });

    const alert = await findByRole('alert');
    expect(alert.textContent).toMatch(/ssh-connect-failed/i);
  });

  it('shows error alert when status call fails', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url.includes('/status')) {
        return { ok: false, status: 502, json: async () => ({ error: 'Stack-Status konnte nicht abgerufen werden' }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('button', { name: /Status abrufen/i }));
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Status abrufen/i }));
    });

    const alert = await findByRole('alert');
    expect(alert.textContent).toMatch(/Stack-Status/i);
  });
});

// ── A11y: aria-live regions in stack mode ────────────────────────────────────

describe('DeploymentsView — AC12: A11y aria-live in stack mode', () => {
  it('stack deploy result uses role="alert" + aria-live="polite"', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/deploy') && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ result: 'ok', stack: { stackName: 'myapp' } }) };
      }
      if (url.includes('/status')) {
        return { ok: true, status: 200, json: async () => ({ stackName: 'myapp', project: 'myapp', services: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('form', { name: /Stack-Deploy-Formular/i }));
    await act(async () => {
      fireEvent.submit(getByRole('form', { name: /Stack-Deploy-Formular/i }));
    });

    const alert = await findByRole('alert');
    expect(alert.getAttribute('aria-live')).toBe('polite');
  });

  it('stack undeploy confirm input has aria-describedby pointing to hint', async () => {
    globalThis.fetch = jest.fn(async () => {
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, getByLabelText, container } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('region', { name: /Stack entfernen/i }));

    const input = getByLabelText(/Stack-Name myapp bestätigen/i);
    const describedById = input.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(container.querySelector(`#${describedById}`)).toBeTruthy();
  });
});

// ── Security: no secrets in stack mode output ─────────────────────────────────

describe('DeploymentsView — AC12: Security — no secrets in stack mode', () => {
  it('Bearer token stripped from stack deploy error', async () => {
    const tokenMsg = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig failed';
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/deploy') && init?.method === 'POST') {
        return { ok: false, status: 502, json: async () => ({ result: 'error', reason: tokenMsg }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('form', { name: /Stack-Deploy-Formular/i }));
    await act(async () => {
      fireEvent.submit(getByRole('form', { name: /Stack-Deploy-Formular/i }));
    });

    const alert = await findByRole('alert');
    expect(alert.textContent).not.toMatch(/Bearer eyJ/i);
    expect(alert.textContent).toContain('[redacted]');
  });

  it('long base64 token stripped from stack undeploy error', async () => {
    const longToken = 'B'.repeat(44);
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/undeploy') && init?.method === 'DELETE') {
        return { ok: false, status: 502, json: async () => ({ result: 'error', reason: `Error: ${longToken} failed` }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, getByLabelText, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('region', { name: /Stack entfernen/i }));

    await act(async () => {
      fireEvent.change(getByLabelText(/Stack-Name myapp bestätigen/i), {
        target: { value: 'myapp' },
      });
    });

    await act(async () => {
      fireEvent.submit(getByRole('region', { name: /Stack entfernen/i }).querySelector('form'));
    });

    const alert = await findByRole('alert');
    expect(alert.textContent).not.toContain('B'.repeat(44));
    expect(alert.textContent).toContain('[...]');
  });

  it('XSS injection in stack error rendered as text (no innerHTML)', async () => {
    const xss = '<script>alert("xss")</script>';
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.includes('/deploy') && init?.method === 'POST') {
        return { ok: false, status: 502, json: async () => ({ result: 'error', reason: xss }) };
      }
      return { ok: true, status: 200, json: async () => ({ stacks: [{ stackName: 'myapp', repoUrl: 'https://github.com/org/app', branch: 'main', composeFile: 'docker-compose.yml', vps: 'vps-1', publicServices: [], tunnelId: 't1' }] }) };
    });

    const { getByRole, findByRole } = renderView();
    await switchToStackMode({ getByRole });
    await waitFor(() => getByRole('combobox', { name: /Compose-Stack auswählen/i }));

    await act(async () => {
      fireEvent.change(getByRole('combobox', { name: /Compose-Stack auswählen/i }), {
        target: { value: 'myapp' },
      });
    });

    await waitFor(() => getByRole('form', { name: /Stack-Deploy-Formular/i }));
    await act(async () => {
      fireEvent.submit(getByRole('form', { name: /Stack-Deploy-Formular/i }));
    });

    const alert = await findByRole('alert');
    expect(alert.querySelector('script')).toBeNull();
  });
});
