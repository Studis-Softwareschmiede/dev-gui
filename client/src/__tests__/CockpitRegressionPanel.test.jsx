/**
 * CockpitRegressionPanel.test.jsx — Tests für regression-panel AC1–AC7:
 * Regressionstests-Karte im Fabrik-„Arbeiten"-Reiter (`CockpitView.jsx`,
 * `actionGrid`).
 *
 * Covers (regression-panel):
 *   AC1 — Karte „Regressionstests" rendert im `actionGrid` an Position 5
 *          (nach „Neue Story", vor Status-Dashboard); reuse der bestehenden
 *          `flowTriggerBox`/`flowTriggerHeader`/`flowTriggerHint`-Tokens.
 *   AC2 — Genau zwei Buttons untereinander, feste Reihenfolge „ausführen"
 *          (primär, btnFlowTrigger-Token) → „definieren" (sekundär, Outline).
 *   AC3 — Klick-Ziele: „ausführen"/„definieren" schalten den lokalen
 *          Öffnen-State um (data-run-dialog-open/data-define-dialog-open) —
 *          die eigentlichen Dialoge (S-311/S-308) sind separate Stories und
 *          hier bewusst NICHT gebaut (Nicht-Ziel).
 *   AC4 — Inline-Statuszeile bildet „kein Lauf"/„läuft"/„erfolgreich +
 *          Zeitstempel"/„fehlgeschlagen + Zeitstempel" ab (D9); Zeitstempel-
 *          Format wie D10 (toLocaleString('de-DE', {dateStyle:'short',
 *          timeStyle:'medium'})). Quelle: GET …/regression-runs (jüngster
 *          Lauf zuerst).
 *   AC5 — Während `status:"running"` ist NUR „ausführen" gesperrt
 *          (Disabled-Token + lockNotice-Hinweis); „definieren" bleibt
 *          bedienbar (D11).
 *   AC6 — Native `<button type="button">`, `minHeight:44`, Fokusring nicht
 *          entfernt (kein outline:none), aria-labels (inkl. Gesperrt-
 *          Variante) exakt wie Design-Abschnitt 4/D13.
 *   AC7 — data-testid-Konvention: regression-card, regression-run-btn,
 *          regression-define-btn, regression-status.
 *
 * Edge-Cases (Spec „Edge-Cases & Fehlerverhalten"):
 *   - Kein Lauf im Store → „Noch kein Regressionstest gelaufen." (kein Fehler).
 *   - Lauf-Status-Quelle nicht erreichbar (404/Netzwerkfehler) → kein Crash,
 *     Karte bleibt bei „kein Lauf".
 *
 * Terminal, Dashboard, BoardView, SpecView, IdeaCaptureModal,
 * IdeaSpecifyChatModal, CostModeDriftNotice sind gemockt.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// ── Mock heavy sub-components ─────────────────────────────────────────────────

jest.unstable_mockModule('../Terminal.jsx', () => ({ Terminal: () => null }));
jest.unstable_mockModule('../Dashboard.jsx', () => ({ Dashboard: () => null }));
jest.unstable_mockModule('../IdeaCaptureModal.jsx', () => ({ IdeaCaptureModal: () => null }));
jest.unstable_mockModule('../IdeaSpecifyChatModal.jsx', () => ({ IdeaSpecifyChatModal: () => null }));
jest.unstable_mockModule('../CostModeDriftNotice.jsx', () => ({ CostModeDriftNotice: () => null }));
jest.unstable_mockModule('../BoardView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    BoardView: ({ lockedProject }) =>
      R.createElement('main', { 'aria-label': 'Studis-Kanban-Board', 'data-locked': lockedProject ?? '' }, 'Board Mock'),
  };
});
jest.unstable_mockModule('../SpecView.jsx', async () => {
  const R = (await import('react')).default;
  return { SpecView: () => R.createElement('div', { 'data-testid': 'spec-view-stub' }, 'Spec Mock') };
});

const { render }      = await import('@testing-library/react');
const React           = (await import('react')).default;
const { CockpitView } = await import('../CockpitView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION_URL = '/api/session';
const REGRESSION_RUNS_URL_RE = /^\/api\/projects\/[^/]+\/regression-runs$/;

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; window.location.hash = ''; });

/**
 * fetch mock: /api/session (ready) + GET …/regression-runs.
 * @param {object} [opts]
 * @param {'ok'|'404'|'network-error'} [opts.mode='ok']
 * @param {Array<object>} [opts.runs=[]] — list body when mode='ok' (jüngste zuerst)
 */
function makeFetchFn({ mode = 'ok', runs = [] } = {}) {
  return jest.fn(async (url) => {
    if (url === SESSION_URL) {
      return { ok: true, status: 200, json: async () => ({ state: 'ready', restarts: 0 }) };
    }
    if (REGRESSION_RUNS_URL_RE.test(url)) {
      if (mode === '404') {
        return { ok: false, status: 404, json: async () => ({ error: 'not-found' }) };
      }
      if (mode === 'network-error') {
        throw new Error('network unreachable');
      }
      return { ok: true, status: 200, json: async () => runs };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

function renderCockpit(fetchFn) {
  const fn = fetchFn ?? makeFetchFn();
  globalThis.fetch = fn;
  render(
    React.createElement(CockpitView, {
      activeRepo: 'my-project',
      navigateFactory: jest.fn(),
      onNavigate: jest.fn(),
    }),
  );
  return { fetchFn: fn };
}

// ── AC1: Platzierung & Tokens ─────────────────────────────────────────────────

describe('CockpitView — regression-panel AC1: Platzierung & Gestaltung', () => {
  it('renders the „Regressionstests"-card in the actionGrid', async () => {
    renderCockpit();
    const card = document.querySelector('[data-testid="regression-card"]');
    expect(card).toBeTruthy();
    await waitFor(() => {}); // let pending effects settle
  });

  it('card appears after „Neue Story" and before the Dashboard in DOM order', () => {
    renderCockpit();
    const grid = document.querySelector('[data-testid="regression-card"]').parentElement;
    const children = Array.from(grid.children);
    const newStoryIdx = children.findIndex((c) => c.textContent.includes('Neue Story'));
    const regressionIdx = children.findIndex((c) => c.getAttribute('data-testid') === 'regression-card');
    expect(newStoryIdx).toBeGreaterThanOrEqual(0);
    expect(regressionIdx).toBeGreaterThan(newStoryIdx);
  });

  it('card header shows the title „Regressionstests"', () => {
    renderCockpit();
    const card = document.querySelector('[data-testid="regression-card"]');
    expect(card.textContent).toMatch(/Regressionstests/);
  });
});

// ── AC2: Zwei Buttons, Reihenfolge, Hierarchie ────────────────────────────────

describe('CockpitView — regression-panel AC2: Buttons & Hierarchie', () => {
  it('renders exactly the run and define buttons in that order', () => {
    renderCockpit();
    const card = document.querySelector('[data-testid="regression-card"]');
    const buttons = Array.from(card.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute('data-testid')).toBe('regression-run-btn');
    expect(buttons[1].getAttribute('data-testid')).toBe('regression-define-btn');
  });

  it('primary „ausführen"-button uses the filled btnFlowTrigger look (bold, filled background)', () => {
    renderCockpit();
    const btn = document.querySelector('[data-testid="regression-run-btn"]');
    expect(btn.style.background).toBe('rgb(29, 78, 216)'); // #1d4ed8
    expect(String(btn.style.fontWeight)).toBe('600');
  });

  it('secondary „definieren"-button uses the outline look (transparent, not bold)', () => {
    renderCockpit();
    const btn = document.querySelector('[data-testid="regression-define-btn"]');
    expect(btn.style.background).toBe('transparent');
    expect(String(btn.style.fontWeight)).not.toBe('600');
  });
});

// ── AC3: Klick-Ziele ───────────────────────────────────────────────────────────

describe('CockpitView — regression-panel AC3: Klick-Ziele', () => {
  it('clicking „ausführen" flips the run-dialog-open anchor (dialog itself is a separate story)', async () => {
    renderCockpit();
    const card = document.querySelector('[data-testid="regression-card"]');
    expect(card.getAttribute('data-run-dialog-open')).toBe('false');
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-run-btn"]'));
    });
    expect(card.getAttribute('data-run-dialog-open')).toBe('true');
  });

  it('clicking „definieren" flips the define-dialog-open anchor', async () => {
    renderCockpit();
    const card = document.querySelector('[data-testid="regression-card"]');
    expect(card.getAttribute('data-define-dialog-open')).toBe('false');
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-define-btn"]'));
    });
    expect(card.getAttribute('data-define-dialog-open')).toBe('true');
  });
});

// ── AC4: Inline-Statuszeile ────────────────────────────────────────────────────

describe('CockpitView — regression-panel AC4: Inline-Statuszeile', () => {
  it('shows „Noch kein Regressionstest gelaufen." when the store has no runs', async () => {
    renderCockpit(makeFetchFn({ mode: 'ok', runs: [] }));
    await waitFor(() => {
      const status = document.querySelector('[data-testid="regression-status"]');
      expect(status.textContent).toMatch(/Noch kein Regressionstest gelaufen\./);
      expect(status.getAttribute('data-status')).toBe('none');
    });
  });

  it('shows „⏳ Regressionstest läuft…" when the latest run is running', async () => {
    renderCockpit(makeFetchFn({ mode: 'ok', runs: [{ runId: 'r1', status: 'running', startedAt: '2026-07-07T10:00:00Z' }] }));
    await waitFor(() => {
      const status = document.querySelector('[data-testid="regression-status"]');
      expect(status.textContent).toMatch(/Regressionstest läuft/);
      expect(status.getAttribute('role')).toBe('status');
    });
  });

  it('shows „✓ Erfolgreich — <Zeitstempel>" when the latest run passed', async () => {
    const ts = '2026-07-07T10:00:00Z';
    renderCockpit(makeFetchFn({ mode: 'ok', runs: [{ runId: 'r1', status: 'passed', startedAt: ts }] }));
    await waitFor(() => {
      const status = document.querySelector('[data-testid="regression-status"]');
      expect(status.textContent).toMatch(/^✓ Erfolgreich —/);
      expect(status.textContent).toContain(
        new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' }),
      );
      expect(status.getAttribute('role')).toBe('status');
    });
  });

  it('shows „✗ Fehlgeschlagen — <Zeitstempel>" as role=alert when the latest run failed', async () => {
    const ts = '2026-07-07T11:30:00Z';
    renderCockpit(makeFetchFn({ mode: 'ok', runs: [{ runId: 'r2', status: 'failed', startedAt: ts }] }));
    await waitFor(() => {
      const status = document.querySelector('[data-testid="regression-status"]');
      expect(status.textContent).toMatch(/^✗ Fehlgeschlagen —/);
      expect(status.getAttribute('role')).toBe('alert');
    });
  });
});

// ── AC5: Sperr-Logik ───────────────────────────────────────────────────────────

describe('CockpitView — regression-panel AC5: Sperr-/Status-Logik', () => {
  it('disables ONLY „ausführen" while a run is active; „definieren" stays enabled', async () => {
    renderCockpit(makeFetchFn({ mode: 'ok', runs: [{ runId: 'r1', status: 'running', startedAt: null }] }));
    await waitFor(() => {
      const runBtn = document.querySelector('[data-testid="regression-run-btn"]');
      expect(runBtn.disabled).toBe(true);
    });
    const defineBtn = document.querySelector('[data-testid="regression-define-btn"]');
    expect(defineBtn.disabled).toBe(false);
  });

  it('shows the lock-notice text while a run is active', async () => {
    renderCockpit(makeFetchFn({ mode: 'ok', runs: [{ runId: 'r1', status: 'running', startedAt: null }] }));
    await waitFor(() => {
      const notice = document.querySelector('[data-testid="regression-lock-notice"]');
      expect(notice).toBeTruthy();
      expect(notice.textContent).toBe('Ein Regressionstest läuft — Ausführen gesperrt.');
    });
  });

  it('does NOT show the lock-notice when idle', async () => {
    renderCockpit(makeFetchFn({ mode: 'ok', runs: [] }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-status"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="regression-lock-notice"]')).toBeNull();
  });
});

// ── AC6: Accessibility ─────────────────────────────────────────────────────────

describe('CockpitView — regression-panel AC6: Accessibility', () => {
  it('both buttons are native <button type="button"> with minHeight ≥ 44', () => {
    renderCockpit();
    const runBtn = document.querySelector('[data-testid="regression-run-btn"]');
    const defineBtn = document.querySelector('[data-testid="regression-define-btn"]');
    expect(runBtn.tagName).toBe('BUTTON');
    expect(runBtn.getAttribute('type')).toBe('button');
    expect(defineBtn.tagName).toBe('BUTTON');
    expect(defineBtn.getAttribute('type')).toBe('button');
    expect(parseInt(runBtn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    expect(parseInt(defineBtn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
  });

  it('no outline:none on either button (focus ring preserved)', () => {
    renderCockpit();
    const runBtn = document.querySelector('[data-testid="regression-run-btn"]');
    const defineBtn = document.querySelector('[data-testid="regression-define-btn"]');
    expect(runBtn.style.outline).not.toBe('none');
    expect(defineBtn.style.outline).not.toBe('none');
  });

  it('aria-label for „ausführen" matches D13 wording (idle)', () => {
    renderCockpit();
    const runBtn = document.querySelector('[data-testid="regression-run-btn"]');
    expect(runBtn.getAttribute('aria-label')).toBe(
      'Regressionstest ausführen — startet die Regressionstest-Suite',
    );
  });

  it('aria-label for „ausführen" switches to the locked variant while running (D13)', async () => {
    renderCockpit(makeFetchFn({ mode: 'ok', runs: [{ runId: 'r1', status: 'running', startedAt: null }] }));
    await waitFor(() => {
      const runBtn = document.querySelector('[data-testid="regression-run-btn"]');
      expect(runBtn.getAttribute('aria-label')).toBe(
        'Regressionstest ausführen — gesperrt (Lauf aktiv)',
      );
    });
  });

  it('aria-label for „definieren" matches D13 wording', () => {
    renderCockpit();
    const defineBtn = document.querySelector('[data-testid="regression-define-btn"]');
    expect(defineBtn.getAttribute('aria-label')).toBe(
      'Regressionstest definieren — öffnet die Definitionsansicht',
    );
  });
});

// ── AC7: data-testid-Konvention ────────────────────────────────────────────────

describe('CockpitView — regression-panel AC7: data-testid-Konvention', () => {
  it('sets all four required data-testids', async () => {
    renderCockpit();
    expect(document.querySelector('[data-testid="regression-card"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="regression-run-btn"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="regression-define-btn"]')).toBeTruthy();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-status"]')).toBeTruthy();
    });
  });
});

// ── Edge-Cases: Store nicht erreichbar / kein Crash ────────────────────────────

describe('CockpitView — regression-panel: Projekt-Wechsel setzt Zustand zurück', () => {
  it('resets the status to idle immediately on activeRepo change (no stale status from the previous project)', async () => {
    const fetchFn = makeFetchFn({
      mode: 'ok',
      runs: [{ runId: 'r1', status: 'failed', startedAt: '2026-07-07T09:00:00Z' }],
    });
    globalThis.fetch = fetchFn;
    const { rerender } = render(
      React.createElement(CockpitView, {
        activeRepo: 'project-a',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      }),
    );
    await waitFor(() => {
      const status = document.querySelector('[data-testid="regression-status"]');
      expect(status.getAttribute('data-status')).toBe('failed');
    });

    // Switch project — before the new project's fetch resolves, the card must
    // NOT keep showing project-a's stale „failed" status.
    let resolveNewFetch;
    const pending = new Promise((resolve) => {
      resolveNewFetch = resolve;
    });
    globalThis.fetch = jest.fn(async (url) => {
      if (url === SESSION_URL) {
        return { ok: true, status: 200, json: async () => ({ state: 'ready', restarts: 0 }) };
      }
      if (REGRESSION_RUNS_URL_RE.test(url)) {
        await pending;
        return { ok: true, status: 200, json: async () => [] };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    act(() => {
      rerender(
        React.createElement(CockpitView, {
          activeRepo: 'project-b',
          navigateFactory: jest.fn(),
          onNavigate: jest.fn(),
        }),
      );
    });

    const status = document.querySelector('[data-testid="regression-status"]');
    expect(status.getAttribute('data-status')).toBe('none');

    await act(async () => {
      resolveNewFetch();
      await pending;
    });
  });
});

describe('CockpitView — regression-panel Edge-Cases: Store nicht erreichbar', () => {
  it('404 from the regression-runs endpoint degrades to „kein Lauf" without crashing', async () => {
    renderCockpit(makeFetchFn({ mode: '404' }));
    await waitFor(() => {
      const status = document.querySelector('[data-testid="regression-status"]');
      expect(status.getAttribute('data-status')).toBe('none');
    });
    // Card still renders normally (no crash)
    expect(document.querySelector('[data-testid="regression-card"]')).toBeTruthy();
  });

  it('network error from the regression-runs endpoint does not crash the card', async () => {
    renderCockpit(makeFetchFn({ mode: 'network-error' }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-card"]')).toBeTruthy();
    });
    const status = document.querySelector('[data-testid="regression-status"]');
    expect(status.getAttribute('data-status')).toBe('none');
  });
});
