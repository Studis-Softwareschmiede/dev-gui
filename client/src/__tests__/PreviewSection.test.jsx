/**
 * PreviewSection.test.jsx — Komponenten-Test für das neue Zuhause von
 * `/agent-flow:preview` auf der Fabrik-Übersicht (cockpit-declutter, S-305).
 *
 * Covers (cockpit-declutter): AC7
 *   AC7 — Fabrik-Übersicht rendert einen „Vorschau"-Bereich mit Modus-Auswahl
 *         (up/down/list/available, analog dem bisherigen TriggerPanel-
 *         Dropdown). Für up/down ist ein Projekt Pflicht. Klick auf
 *         „Auslösen" POSTet GENAU EINMAL { command: '/agent-flow:preview …' }
 *         an POST /api/command (derselbe bestehende Pfad, unveränderte
 *         Backend-Allowlist). 202 → inline Lauf-Status, Kill aktiv; 409 →
 *         „Ein Job läuft bereits"; Busy-Guard (GET /api/session state:"busy")
 *         sperrt „Auslösen"; 400/500/Netzwerkfehler → Fehleranzeige mit Reset,
 *         kein Crash.
 *
 * NFR A11y:
 *   - Select/Buttons: Touch-Target ≥ 44 px (minHeight), disabled-Attribut + Text-Label.
 *   - Status-/Fehlermeldungen: role=alert bzw. role=status, aria-live.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { PreviewSection } = await import('../PreviewSection.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STATUS_WITH_PROJECTS = {
  projects: [{ name: 'dev-gui' }, { name: 'agent-flow' }],
};

const SESSION_READY = { state: 'ready' };
const SESSION_BUSY = { state: 'busy' };

const PREVIEW_ACCEPTED = { commandId: 'cmd-1', status: 'accepted' };

// ── Helper: routed fetchFn ───────────────────────────────────────────────────

/**
 * @param {{
 *   status?: { status: number, data: object } | 'reject',
 *   session?: object,
 *   command?: { status: number, data: object } | 'reject' | 'pending',
 *   cancel?: { status: number } | 'reject',
 * }} opts
 * @returns {{ fetchFn: jest.Mock, calls: Array<{url:string, method:string, body:*}> }}
 */
function makeFetchFn({
  status = { status: 200, data: STATUS_WITH_PROJECTS },
  session = SESSION_READY,
  command = { status: 202, data: PREVIEW_ACCEPTED },
  cancel = { status: 200 },
} = {}) {
  const calls = [];

  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ url, method, body: opts.body });

    if (url === '/api/status') {
      if (status === 'reject') throw new Error('network error');
      return {
        ok: status.status < 400,
        status: status.status,
        json: async () => status.data,
      };
    }
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => session };
    }
    if (url === '/api/command' && method === 'POST') {
      if (command === 'reject') throw new Error('network error');
      if (command === 'pending') {
        return new Promise(() => {});
      }
      return {
        ok: command.status >= 200 && command.status < 300,
        status: command.status,
        json: async () => command.data,
      };
    }
    if (url === '/api/command/cancel' && method === 'POST') {
      if (cancel === 'reject') throw new Error('network error');
      return { ok: cancel.status >= 200 && cancel.status < 300, status: cancel.status };
    }
    throw new Error(`Unerwarteter fetch-Aufruf: ${method} ${url}`);
  });

  return { fetchFn, calls };
}

/** Rendert PreviewSection mit injizierbarem fetchFn. */
function renderSection(fetchFn) {
  return render(React.createElement(PreviewSection, { fetchFn }));
}

afterEach(() => {
  jest.clearAllMocks();
});

// ── AC7: Rendering + Modus-Auswahl ────────────────────────────────────────────

describe('cockpit-declutter AC7 — PreviewSection rendert „Vorschau"-Bereich', () => {
  it('rendert Überschrift + Modus-Select mit up/down/list/available', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByText, getByTestId } = renderSection(fetchFn);
    expect(getByText(/vorschau/i)).toBeTruthy();

    const select = getByTestId('preview-mode-select');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['up', 'down', 'list', 'available']);
  });

  it('Default-Modus "up" zeigt Projekt-Pflichtfeld', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByTestId } = renderSection(fetchFn);
    await waitFor(() => expect(getByTestId('preview-repo-select')).toBeTruthy());
  });

  it('Modus "list" zeigt KEIN Projektfeld, "Auslösen" sofort aktivierbar', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByTestId, queryByTestId } = renderSection(fetchFn);
    const select = getByTestId('preview-mode-select');
    fireEvent.change(select, { target: { value: 'list' } });

    expect(queryByTestId('preview-repo-select')).toBeNull();
    expect(queryByTestId('preview-repo-textinput')).toBeNull();
    await waitFor(() => expect(getByTestId('preview-fire-btn').disabled).toBe(false));
  });

  it('Modus "available" zeigt KEIN Projektfeld, "Auslösen" sofort aktivierbar', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByTestId, queryByTestId } = renderSection(fetchFn);
    const select = getByTestId('preview-mode-select');
    fireEvent.change(select, { target: { value: 'available' } });

    expect(queryByTestId('preview-repo-select')).toBeNull();
    await waitFor(() => expect(getByTestId('preview-fire-btn').disabled).toBe(false));
  });

  it('Projektliste nicht verfügbar (Netzwerkfehler) → Freitextfeld statt Select', async () => {
    const { fetchFn } = makeFetchFn({ status: 'reject' });
    const { getByTestId } = renderSection(fetchFn);
    await waitFor(() => expect(getByTestId('preview-repo-textinput')).toBeTruthy());
  });

  it('Modus up/down ohne Projekt → "Auslösen" bleibt disabled', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByTestId } = renderSection(fetchFn);
    await waitFor(() => expect(getByTestId('preview-repo-select')).toBeTruthy());
    expect(getByTestId('preview-fire-btn').disabled).toBe(true);
  });
});

// ── AC7: Auslösung — genau ein POST ───────────────────────────────────────────

describe('cockpit-declutter AC7 — "Auslösen" POSTet genau einmal', () => {
  it('Modus "list" POSTet { command: "/agent-flow:preview list" }', async () => {
    const { fetchFn, calls } = makeFetchFn();
    const { getByTestId } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'list' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });

    const commandCalls = calls.filter((c) => c.url === '/api/command' && c.method === 'POST');
    expect(commandCalls.length).toBe(1);
    const body = JSON.parse(commandCalls[0].body);
    expect(body.command).toBe('/agent-flow:preview list');
  });

  it('Modus "up" + Projekt POSTet { command: "/agent-flow:preview up <repo>" }', async () => {
    const { fetchFn, calls } = makeFetchFn();
    const { getByTestId } = renderSection(fetchFn);
    await waitFor(() => expect(getByTestId('preview-repo-select')).toBeTruthy());
    fireEvent.change(getByTestId('preview-repo-select'), { target: { value: 'dev-gui' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });

    const commandCalls = calls.filter((c) => c.url === '/api/command' && c.method === 'POST');
    expect(commandCalls.length).toBe(1);
    const body = JSON.parse(commandCalls[0].body);
    expect(body.command).toBe('/agent-flow:preview up dev-gui');
  });

  it('Modus "down" + Projekt (Freitext-Fallback) kollabiert das Argument (defense in depth)', async () => {
    const { fetchFn, calls } = makeFetchFn({ status: 'reject' });
    const { getByTestId } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'down' } });
    await waitFor(() => expect(getByTestId('preview-repo-textinput')).toBeTruthy());
    fireEvent.change(getByTestId('preview-repo-textinput'), { target: { value: '  dev-gui  ' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });

    const commandCalls = calls.filter((c) => c.url === '/api/command' && c.method === 'POST');
    const body = JSON.parse(commandCalls[0].body);
    expect(body.command).toBe('/agent-flow:preview down dev-gui');
    expect(body.command).not.toMatch(/[\r\n\t]/);
  });

  it('Doppelklick auf "Auslösen" während "starting" → kein zweiter POST', async () => {
    const { fetchFn, calls } = makeFetchFn({ command: 'pending' });
    const { getByTestId } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'list' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });
    await waitFor(() => expect(fireBtn.disabled).toBe(true));
    fireEvent.click(fireBtn);

    const commandCalls = calls.filter((c) => c.url === '/api/command' && c.method === 'POST');
    expect(commandCalls.length).toBe(1);
  });
});

// ── AC7: Busy-Sperre + Kill + Rückmeldung ─────────────────────────────────────

describe('cockpit-declutter AC7 — Busy-Sperre + Kill + Rückmeldung', () => {
  it('GET /api/session state:"busy" → "Auslösen" disabled + Text-/Lock-Hinweis', async () => {
    const { fetchFn } = makeFetchFn({ session: SESSION_BUSY });
    const { getByTestId } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'list' } });

    await waitFor(() => {
      expect(getByTestId('preview-fire-btn').disabled).toBe(true);
    });
    expect(getByTestId('preview-busy-notice').textContent).toMatch(/ein job läuft bereits/i);
  });

  it('202 → inline Lauf-Status "läuft", Kill-Button wird aktiv', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByTestId } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'list' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });

    await waitFor(() => {
      expect(getByTestId('preview-running-notice').textContent).toMatch(/vorschau-lauf läuft/i);
    });
    expect(getByTestId('preview-kill-btn').disabled).toBe(false);
  });

  it('Kill POSTet /api/command/cancel', async () => {
    const { fetchFn, calls } = makeFetchFn();
    const { getByTestId } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'list' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });
    await waitFor(() => expect(getByTestId('preview-kill-btn').disabled).toBe(false));

    await act(async () => {
      fireEvent.click(getByTestId('preview-kill-btn'));
    });

    const cancelCalls = calls.filter((c) => c.url === '/api/command/cancel' && c.method === 'POST');
    expect(cancelCalls.length).toBe(1);
  });

  it('409 → "Ein Job läuft bereits", kein Crash', async () => {
    const { fetchFn } = makeFetchFn({ command: { status: 409, data: {} } });
    const { getByTestId, getByRole } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'list' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/ein job läuft bereits/i);
    });
  });

  it('400 → sichtbare Fehlermeldung mit Reset, kein Crash', async () => {
    const { fetchFn } = makeFetchFn({ command: { status: 400, data: { reason: 'ungültige Allowlist' } } });
    const { getByTestId, getByRole } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'list' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/ungültiger befehl/i);
    });
    const resetBtn = getByRole('button', { name: /fehler zurücksetzen/i });
    await act(async () => {
      fireEvent.click(resetBtn);
    });
    expect(() => getByRole('alert')).toThrow();
  });

  it('500 → sichtbare Fehlermeldung, kein Crash', async () => {
    const { fetchFn } = makeFetchFn({ command: { status: 500, data: {} } });
    const { getByTestId, getByRole } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'list' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/serverfehler/i);
    });
  });

  it('Netzwerkfehler → sichtbare Fehlermeldung, kein Crash', async () => {
    const { fetchFn } = makeFetchFn({ command: 'reject' });
    const { getByTestId, getByRole } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'list' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/netzwerkfehler/i);
    });
  });
});

// ── AC7 / AC8 (cockpit-declutter): nur bestehende Endpunkte ──────────────────

describe('cockpit-declutter — reiner Frontend-Change, keine neuen Endpunkte', () => {
  it('nutzt ausschließlich /api/command, /api/command/cancel, /api/session, /api/status', async () => {
    const { fetchFn, calls } = makeFetchFn();
    const { getByTestId } = renderSection(fetchFn);
    fireEvent.change(getByTestId('preview-mode-select'), { target: { value: 'list' } });

    const fireBtn = getByTestId('preview-fire-btn');
    await waitFor(() => expect(fireBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(fireBtn);
    });
    await waitFor(() => expect(getByTestId('preview-kill-btn').disabled).toBe(false));

    await act(async () => {
      fireEvent.click(getByTestId('preview-kill-btn'));
    });

    const allowedUrls = new Set(['/api/status', '/api/session', '/api/command', '/api/command/cancel']);
    for (const call of calls) {
      expect(allowedUrls.has(call.url)).toBe(true);
    }
  });
});
