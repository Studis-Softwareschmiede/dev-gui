/**
 * SpecViewReconcileTrigger.test.jsx — Tests für AC1–AC7 (reconcile-trigger):
 * „Konzept/Spec nachziehen"-Button im Spezifikation-Reiter (SpecView.jsx).
 *
 * Covers (reconcile-trigger):
 *   AC1 — Button „Konzept/Spec nachziehen" im Spezifikation-Reiter vorhanden;
 *          Touch-Target ≥ 44 px (WCAG 2.1 AA); Hinweistext nennt den ausgelösten
 *          Befehl /agent-flow:reconcile.
 *   AC2 — Klick (bei freier Session) öffnet Bestätigungsdialog (role="dialog")
 *          mit Warntext, dass die Fabrik-Agenten die Doku ändern; noch kein POST.
 *   AC3 — „Starten" POSTet genau einmal {command:'/agent-flow:reconcile',
 *          projectPath} an /api/command; „Abbrechen" schließt ohne POST.
 *   AC4 — Bei aktivem Job (GET /api/session → state:"busy") ist der Button
 *          deaktiviert (disabled-Attribut + zugängliches Label, nie Farbe
 *          allein); Klick auf deaktivierten Button öffnet keinen Dialog,
 *          löst keinen POST aus.
 *   AC5 — Antwort 202 → onNavigate('factory') wird aufgerufen; kein
 *          stehengebliebenes „gestartet"-Element im Spezifikation-Reiter.
 *   AC6 — Antwort 409 → sichtbare Fehler-/Status-Anzeige; onNavigate wird
 *          NICHT aufgerufen; kein Crash.
 *   AC7 — Netzwerkfehler oder 500/unerwarteter Status → sichtbare
 *          Fehleranzeige mit Reset-Möglichkeit; onNavigate wird NICHT
 *          aufgerufen.
 *
 * Doc-Navigation/-Filter/initialPath (projekt-spezifikation-anzeige AC4–AC6)
 * sind bereits in SpecView.test.jsx abgedeckt — diese Datei deckt
 * ausschließlich den Reconcile-Trigger ab. Gespiegelt vom Test-Muster in
 * CockpitFlowTrigger.test.jsx (mockbarer fetchFn via globalThis.fetch).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }  = await import('@testing-library/react');
const React        = (await import('react')).default;
const { SpecView } = await import('../SpecView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let origFetch;
beforeEach(() => {
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

const FAKE_DOCS = [
  { path: 'README.md', title: 'README', type: 'readme', status: null, id: null, version: null },
];

/**
 * Build a fetch mock that handles the doc list, /api/session and /api/command.
 *
 * @param {object} opts
 * @param {'busy'|'ready'} [opts.sessionState='ready'] — state returned by /api/session
 * @param {number}         [opts.commandStatus=202]    — HTTP status for /api/command POST
 * @param {object}         [opts.commandBody={}]       — body for /api/command POST
 */
function makeFetchFn({ sessionState = 'ready', commandStatus = 202, commandBody = {} } = {}) {
  return jest.fn(async (url, opts) => {
    if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
      return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
    }
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => ({ state: sessionState, restarts: 0 }) };
    }
    if (url === '/api/command' && opts?.method === 'POST') {
      return { ok: commandStatus === 202, status: commandStatus, json: async () => commandBody };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

/**
 * Render SpecView, replacing globalThis.fetch so the Reconcile-Trigger
 * (default fetchFn = globalThis.fetch) picks it up.
 *
 * @param {Function} [fetchFn]  Optional fetch mock; defaults to makeFetchFn().
 * @returns {{ onNavigateSpy: jest.Mock, fetchFn: jest.Mock }}
 */
function renderSpecView(fetchFn) {
  const fn = fetchFn ?? makeFetchFn();
  globalThis.fetch = fn;

  const onNavigateSpy = jest.fn();
  render(
    React.createElement(SpecView, {
      projectSlug: 'my-project',
      onNavigate: onNavigateSpy,
    }),
  );
  return { onNavigateSpy, fetchFn: fn };
}

// ── AC1: Button + Hinweistext ──────────────────────────────────────────────────

describe('SpecView — reconcile-trigger AC1: Button + Hinweistext', () => {
  it('rendert „Konzept/Spec nachziehen"-Button im Spezifikation-Reiter', () => {
    renderSpecView();
    const btn = document.querySelector('[data-testid="reconcile-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Konzept\/Spec nachziehen/i);
  });

  it('Button hat minHeight≥44px (Touch-Target, WCAG 2.1 AA)', () => {
    renderSpecView();
    const btn = document.querySelector('[data-testid="reconcile-btn"]');
    const px = parseInt(btn.style.minHeight, 10);
    expect(px).toBeGreaterThanOrEqual(44);
  });

  it('Hinweistext nennt den ausgelösten Befehl /agent-flow:reconcile', () => {
    renderSpecView();
    const box = document.querySelector('[data-testid="reconcile-box"]');
    expect(box.textContent).toMatch(/\/agent-flow:reconcile/);
  });
});

// ── AC2: Bestätigungsdialog ─────────────────────────────────────────────────────

describe('SpecView — reconcile-trigger AC2: Bestätigungsdialog', () => {
  it('Klick (Session frei) öffnet Bestätigungsdialog (role="dialog"); noch kein POST', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready' });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });

    const dialog = document.querySelector('[data-testid="reconcile-confirm-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('role')).toBe('dialog');

    const commandCalls = fetchFn.mock.calls.filter(
      (c) => c[0] === '/api/command' && c[1]?.method === 'POST',
    );
    expect(commandCalls).toHaveLength(0);
  });

  it('Dialog enthält Warntext, dass die Fabrik-Agenten die Doku ändern', async () => {
    renderSpecView(makeFetchFn({ sessionState: 'ready' }));

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });

    const dialog = document.querySelector('[data-testid="reconcile-confirm-dialog"]');
    expect(dialog.textContent).toMatch(/doku.*ändert|abgleicht|fortfahren/i);
  });
});

// ── AC3: Starten/Abbrechen ────────────────────────────────────────────────────

describe('SpecView — reconcile-trigger AC3: Starten POSTet, Abbrechen nicht', () => {
  it('Abbrechen schließt Dialog ohne POST', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready' });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });
    expect(document.querySelector('[data-testid="reconcile-confirm-dialog"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-no"]'));
    });
    expect(document.querySelector('[data-testid="reconcile-confirm-dialog"]')).toBeNull();

    const commandCalls = fetchFn.mock.calls.filter(
      (c) => c[0] === '/api/command' && c[1]?.method === 'POST',
    );
    expect(commandCalls).toHaveLength(0);
  });

  it('Starten POSTet genau einmal /agent-flow:reconcile mit projectPath', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready', commandStatus: 202 });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-yes"]'));
    });

    await waitFor(() => {
      const calls = fetchFn.mock.calls.filter(
        (c) => c[0] === '/api/command' && c[1]?.method === 'POST',
      );
      expect(calls).toHaveLength(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body.command).toBe('/agent-flow:reconcile');
      expect(body.projectPath).toBe('my-project');
    });
  });
});

// ── AC4: Busy-Guard ───────────────────────────────────────────────────────────

describe('SpecView — reconcile-trigger AC4: Busy-Guard (Session state:"busy")', () => {
  it('Button ist NICHT disabled wenn Session idle (ready)', async () => {
    renderSpecView(makeFetchFn({ sessionState: 'ready' }));

    await waitFor(() => {
      const btn = document.querySelector('[data-testid="reconcile-btn"]');
      expect(btn.disabled).toBe(false);
    });
  });

  it('Button ist disabled (disabled-Attribut) wenn Session busy', async () => {
    renderSpecView(makeFetchFn({ sessionState: 'busy' }));

    await waitFor(() => {
      const btn = document.querySelector('[data-testid="reconcile-btn"]');
      expect(btn.disabled).toBe(true);
    });
  });

  it('Button hat zugängliches Label bei Busy (Text, nicht nur Farbe — WCAG 2.1 AA)', async () => {
    renderSpecView(makeFetchFn({ sessionState: 'busy' }));

    await waitFor(() => {
      const btn = document.querySelector('[data-testid="reconcile-btn"]');
      expect(btn.disabled).toBe(true);
      const label = btn.getAttribute('aria-label');
      expect(label).toMatch(/gesperrt|läuft/i);
    });
  });

  it('Lock-Hinweis sichtbar wenn Session busy', async () => {
    renderSpecView(makeFetchFn({ sessionState: 'busy' }));

    await waitFor(() => {
      const notice = document.querySelector('[data-testid="reconcile-lock-notice"]');
      expect(notice).toBeTruthy();
      expect(notice.textContent).toMatch(/job läuft|gesperrt/i);
    });
  });

  it('Klick auf deaktivierten Button öffnet keinen Dialog, löst keinen POST aus', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'busy' });
    renderSpecView(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-btn"]').disabled).toBe(true);
    });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });

    expect(document.querySelector('[data-testid="reconcile-confirm-dialog"]')).toBeNull();

    const commandCalls = fetchFn.mock.calls.filter(
      (c) => c[0] === '/api/command' && c[1]?.method === 'POST',
    );
    expect(commandCalls).toHaveLength(0);
  });
});

// ── AC5: Erfolg (202) ──────────────────────────────────────────────────────────

describe('SpecView — reconcile-trigger AC5: 202 → onNavigate("factory")', () => {
  it('202 → onNavigate("factory") wird aufgerufen', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready', commandStatus: 202 });
    const { onNavigateSpy } = renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(onNavigateSpy).toHaveBeenCalledWith('factory');
    });
  });

  it('202 → kein stehengebliebenes „gestartet"-Element im Spezifikation-Reiter', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready', commandStatus: 202 });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-starting"]')).toBeNull();
      expect(document.querySelector('[data-testid="reconcile-confirm-dialog"]')).toBeNull();
    });
  });
});

// ── AC6: 409 ────────────────────────────────────────────────────────────────────

describe('SpecView — reconcile-trigger AC6: 409 → Fehleranzeige, kein Crash', () => {
  it('409 → sichtbare Fehleranzeige, onNavigate NICHT aufgerufen', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready', commandStatus: 409 });
    const { onNavigateSpy } = renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-error"]')).toBeTruthy();
    });
    expect(onNavigateSpy).not.toHaveBeenCalled();
  });
});

// ── AC7: Netzwerkfehler / 500 ─────────────────────────────────────────────────

describe('SpecView — reconcile-trigger AC7: Netzwerkfehler/500 → Fehleranzeige mit Reset', () => {
  it('Netzwerkfehler → Fehleranzeige mit Reset-Möglichkeit, kein onNavigate, kein Crash', async () => {
    const fetchFn = jest.fn(async (url, opts) => {
      if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
        return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
      }
      if (url === '/api/session') {
        return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      }
      if (url === '/api/command' && opts?.method === 'POST') {
        throw new Error('network down');
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { onNavigateSpy } = renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-error"]')).toBeTruthy();
    });
    expect(onNavigateSpy).not.toHaveBeenCalled();

    // Reset-Möglichkeit (AC7) — clears the error state, button reappears
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-error-reset"]'));
    });
    expect(document.querySelector('[data-testid="reconcile-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="reconcile-btn"]')).toBeTruthy();
  });

  it('500 → sichtbare Fehleranzeige, onNavigate NICHT aufgerufen', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready', commandStatus: 500 });
    const { onNavigateSpy } = renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-error"]')).toBeTruthy();
    });
    expect(onNavigateSpy).not.toHaveBeenCalled();
  });
});
