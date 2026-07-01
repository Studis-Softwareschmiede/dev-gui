/**
 * SpecViewReconcileTrigger.test.jsx — Tests für AC1/AC2/AC4 (reconcile-trigger,
 * unverändert) + AC10/AC13 (headless-reconcile-runner, S-208): „Konzept/Spec
 * nachziehen"-Button im Spezifikation-Reiter (SpecView.jsx).
 *
 * Covers (reconcile-trigger):
 *   AC1 — Button „Konzept/Spec nachziehen" im Spezifikation-Reiter vorhanden;
 *          Touch-Target ≥ 44 px (WCAG 2.1 AA); Hinweistext nennt den ausgelösten
 *          Befehl /agent-flow:reconcile.
 *   AC2 — Klick (bei freier Session) öffnet Bestätigungsdialog (role="dialog")
 *          mit Warntext, dass die Fabrik-Agenten die Doku ändern; noch kein POST.
 *   AC3 — ÜBERSCHRIEBEN durch headless-reconcile-runner (S-208) AC10: „Starten"
 *          POSTet jetzt an /api/reconcile {projectSlug} (statt /api/command).
 *          Siehe AC10-Tests unten. „Abbrechen" schließt weiterhin ohne POST.
 *   AC4 — Bei aktivem Fremd-Job (GET /api/session → state:"busy") ist der
 *          Button deaktiviert (disabled-Attribut + zugängliches Label, nie
 *          Farbe allein); Klick auf deaktivierten Button öffnet keinen Dialog,
 *          löst keinen POST aus. Unverändert (Busy-Guard läuft unabhängig vom
 *          Headless-Runner-Projekt-Lock, headless-reconcile-runner-Abhängigkeiten).
 *   AC5 — ÜBERSCHRIEBEN durch reconcile-inline-feedback (S-205) AC1: kein
 *          `onNavigate` mehr nach 202. Siehe SpecViewReconcileInline.test.jsx
 *          für die AC1-Tests (kein onNavigate, inline „Reconcile läuft…").
 *   AC6 — ÜBERSCHRIEBEN durch headless-reconcile-runner (S-208) AC13: 409 kommt
 *          jetzt von POST /api/reconcile (Headless-Runner-Projekt-Sperre). Siehe
 *          AC13-Tests unten.
 *   AC7 — ÜBERSCHRIEBEN durch headless-reconcile-runner (S-208) AC13: Netzwerkfehler/
 *          500/400 vom neuen /api/reconcile-Start. Siehe AC13-Tests unten.
 *
 * Covers (headless-reconcile-runner):
 *   AC10 — „Starten" POSTet genau einmal {projectSlug} an POST /api/reconcile
 *          (statt /api/command); onNavigate wird nicht aufgerufen (Inline-
 *          Zustand „Reconcile läuft…" wird in SpecViewReconcileInline.test.jsx
 *          geprüft, hier nur der POST-Vertrag).
 *   AC13 — 409 (Projekt-Sperre) / 400 (ungültiger Slug) / 500 / Netzwerkfehler
 *          beim Start → sichtbare Fehleranzeige mit Reset, kein onNavigate,
 *          kein Crash.
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
 * Build a fetch mock that handles the doc list, /api/session and
 * POST /api/reconcile (headless-reconcile-runner AC10/AC13).
 *
 * @param {object} opts
 * @param {'busy'|'ready'} [opts.sessionState='ready']  — state returned by /api/session
 * @param {number}         [opts.reconcileStartStatus=202] — HTTP status for POST /api/reconcile
 * @param {object}         [opts.reconcileStartBody={jobId:'job-1', status:'running'}] — body for POST /api/reconcile
 * @param {object}         [opts.jobStatusBody={status:'running'}] — body for GET /api/reconcile/:jobId (kept "running" by default so tests that don't await further ticks stay stable)
 */
function makeFetchFn({
  sessionState = 'ready',
  reconcileStartStatus = 202,
  reconcileStartBody = { jobId: 'job-1', status: 'running' },
  jobStatusBody = { status: 'running' },
} = {}) {
  return jest.fn(async (url, opts) => {
    if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
      return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
    }
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => ({ state: sessionState, restarts: 0 }) };
    }
    if (url === '/api/reconcile' && opts?.method === 'POST') {
      return {
        ok: reconcileStartStatus === 202,
        status: reconcileStartStatus,
        json: async () => reconcileStartBody,
      };
    }
    if (typeof url === 'string' && url.startsWith('/api/reconcile/')) {
      return { ok: true, status: 200, json: async () => jobStatusBody };
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

    const reconcileCalls = fetchFn.mock.calls.filter(
      (c) => c[0] === '/api/reconcile' && c[1]?.method === 'POST',
    );
    expect(reconcileCalls).toHaveLength(0);
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

// ── AC3 (ÜBERSCHRIEBEN durch headless-reconcile-runner AC10): Starten/Abbrechen ──

describe('SpecView — reconcile-trigger AC3/headless-reconcile-runner AC10: Starten POSTet an /api/reconcile, Abbrechen nicht', () => {
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

    const reconcileCalls = fetchFn.mock.calls.filter(
      (c) => c[0] === '/api/reconcile' && c[1]?.method === 'POST',
    );
    expect(reconcileCalls).toHaveLength(0);
  });

  it('Starten POSTet genau einmal {projectSlug} an POST /api/reconcile (headless-reconcile-runner AC10)', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready', reconcileStartStatus: 202 });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-yes"]'));
    });

    await waitFor(() => {
      const calls = fetchFn.mock.calls.filter(
        (c) => c[0] === '/api/reconcile' && c[1]?.method === 'POST',
      );
      expect(calls).toHaveLength(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body.projectSlug).toBe('my-project');
      expect(body.command).toBeUndefined();
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

    const reconcileCalls = fetchFn.mock.calls.filter(
      (c) => c[0] === '/api/reconcile' && c[1]?.method === 'POST',
    );
    expect(reconcileCalls).toHaveLength(0);
  });
});

// ── AC5: ÜBERSCHRIEBEN durch reconcile-inline-feedback (S-205) AC1 ─────────────
// Die 202-Erfolgs-Tests (kein onNavigate mehr, inline „Reconcile läuft…") leben
// jetzt in SpecViewReconcileInline.test.jsx (S-205 AC1).

// ── AC6/AC7 (ÜBERSCHRIEBEN durch headless-reconcile-runner AC13): 409/400/500/Netzwerkfehler beim Start ──

describe('SpecView — reconcile-trigger AC6/headless-reconcile-runner AC13: 409 (Projekt-Sperre) → Fehleranzeige, kein Crash', () => {
  it('409 → sichtbare Fehleranzeige ("läuft bereits"), onNavigate NICHT aufgerufen', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready', reconcileStartStatus: 409 });
    const { onNavigateSpy } = renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-yes"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="reconcile-error"]');
      expect(err).toBeTruthy();
      expect(err.textContent).toMatch(/läuft bereits/i);
    });
    expect(onNavigateSpy).not.toHaveBeenCalled();
  });
});

// ── AC7/headless-reconcile-runner AC13: Netzwerkfehler/400/500 ─────────────────

describe('SpecView — reconcile-trigger AC7/headless-reconcile-runner AC13: Netzwerkfehler/400/500 → Fehleranzeige mit Reset', () => {
  it('Netzwerkfehler → Fehleranzeige mit Reset-Möglichkeit, kein onNavigate, kein Crash', async () => {
    const fetchFn = jest.fn(async (url, opts) => {
      if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
        return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
      }
      if (url === '/api/session') {
        return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      }
      if (url === '/api/reconcile' && opts?.method === 'POST') {
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

    // Reset-Möglichkeit — clears the error state, button reappears
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-error-reset"]'));
    });
    expect(document.querySelector('[data-testid="reconcile-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="reconcile-btn"]')).toBeTruthy();
  });

  it('400 (ungültiger/fehlender Slug) → sichtbare Fehleranzeige, onNavigate NICHT aufgerufen', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready', reconcileStartStatus: 400 });
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

  it('500 → sichtbare Fehleranzeige, onNavigate NICHT aufgerufen', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'ready', reconcileStartStatus: 500 });
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
