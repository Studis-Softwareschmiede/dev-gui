/**
 * CockpitDrainReportInline.test.jsx — Tests für drain-completion-report AC7a
 * (manuelle Inline-Status-Fläche zeigt bei `done` zusätzlich den Abschlussbericht).
 *
 * Covers (drain-completion-report):
 *   AC7a — Bei `done` zeigt die Fläche „X erledigt / Y blockiert" (Zahlen
 *          textlich, WCAG 2.1 AA) plus eine aufklappbare Liste (`<details>`)
 *          der erledigten/blockierten Story-IDs + Titel, gelesen aus
 *          `result.completed`/`result.blocked` derselben Poll-Antwort
 *          (GET …/drain/:drainId). Fehlt `result`/sind die Felder kein Array
 *          → 0/0, kein Crash. Der bestehende läuft/fertig/fehlgeschlagen-Status
 *          und das Board-Re-Fetch-Verhalten (headless-manual-drain AC6) bleiben
 *          UNVERÄNDERT (weiterhin geprüft in CockpitDrainCostModeStatus.test.jsx).
 *
 * HTTP-/fetch-Ebene: die Tests konfigurieren den echten GET …/drain/:drainId-
 * Poll-Response-Body (inkl. `result.completed`/`result.blocked`) — kein
 * separater Endpunkt/Zusatz-Request für den Bericht (AC7a: „Datenquelle: das
 * Drain-Job-Ergebnis").
 *
 * Terminal, BoardView, SpecView, IdeaCaptureModal,
 * IdeaSpecifyChatModal, CostModeDriftNotice sind gemockt.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// ── Mock heavy sub-components ─────────────────────────────────────────────────

jest.unstable_mockModule('../Terminal.jsx', () => ({ Terminal: () => null }));
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

const DRAIN_POST_URL_RE   = /^\/api\/projects\/[^/]+\/drain$/;
const DRAIN_STATUS_URL_RE = /^\/api\/projects\/[^/]+\/drain\/[^/]+$/;

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; window.location.hash = ''; });

/**
 * fetch mock: /api/session, POST …/drain (202 {drainId}), GET …/drain/:id
 * (status + optional `result`, wie das echte DrainJobRegistry-Ergebnis).
 * @param {object} [opts]
 * @param {string} [opts.jobStatus='done']
 * @param {object|undefined} [opts.result]  wird 1:1 als `result` zurückgegeben
 */
function makeFetch({ jobStatus = 'done', result } = {}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => ({ state: 'ready', restarts: 0 }) };
    }
    if (DRAIN_STATUS_URL_RE.test(url)) {
      const body = { status: jobStatus };
      if (result !== undefined) body.result = result;
      return { ok: true, status: 200, json: async () => body };
    }
    if (DRAIN_POST_URL_RE.test(url) && opts?.method === 'POST') {
      return { ok: true, status: 202, json: async () => ({ drainId: 'd-1' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

function renderCockpit(fetchFn) {
  const fn = fetchFn ?? makeFetch();
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

/** Click „Board abarbeiten" → confirm dialog → „Starten". */
async function startDrain() {
  await act(async () => {
    fireEvent.click(document.querySelector('[data-testid="flow-board-btn"]'));
  });
  await act(async () => {
    fireEvent.click(document.querySelector('[data-testid="flow-confirm-yes"]'));
  });
}

// ── AC7a: Abschlussbericht inline bei done ────────────────────────────────────

describe('drain-completion-report AC7a — manuelle Inline-Status-Fläche zeigt Abschlussbericht bei done', () => {
  it('zeigt „X erledigt / Y blockiert" textlich', async () => {
    renderCockpit(makeFetch({
      jobStatus: 'done',
      result: {
        reason: 'no-drain-target', flowRuns: 2, escalated: [],
        completed: [{ id: 'S-1', title: 'Eins' }, { id: 'S-2', title: 'Zwei' }],
        blocked: [{ id: 'S-9', title: 'Neun' }],
      },
    }));
    await startDrain();
    await waitFor(() => {
      const summary = document.querySelector('[data-testid="drain-report-summary"]');
      expect(summary).toBeTruthy();
      expect(summary.textContent).toMatch(/2 erledigt \/ 1 blockiert/);
    });
  });

  it('aufklappbare Liste enthält Story-IDs + Titel (erledigt UND blockiert)', async () => {
    renderCockpit(makeFetch({
      jobStatus: 'done',
      result: {
        reason: 'no-drain-target', flowRuns: 2, escalated: [],
        completed: [{ id: 'S-1', title: 'Eins' }],
        blocked: [{ id: 'S-9', title: 'Neun' }],
      },
    }));
    await startDrain();
    await waitFor(() => {
      const details = document.querySelector('[data-testid="drain-report-details"]');
      expect(details).toBeTruthy();
      expect(details.textContent).toMatch(/S-1/);
      expect(details.textContent).toMatch(/Eins/);
      expect(details.textContent).toMatch(/S-9/);
      expect(details.textContent).toMatch(/Neun/);
    });
  });

  it('0 erledigt / 0 blockiert (flowRuns==0, AC2-Randfall) → 0/0 textlich, keine aufklappbare Liste', async () => {
    renderCockpit(makeFetch({
      jobStatus: 'done',
      result: { reason: 'no-drain-target', flowRuns: 0, escalated: [], completed: [], blocked: [] },
    }));
    await startDrain();
    await waitFor(() => {
      const summary = document.querySelector('[data-testid="drain-report-summary"]');
      expect(summary).toBeTruthy();
      expect(summary.textContent).toMatch(/0 erledigt \/ 0 blockiert/);
    });
    expect(document.querySelector('[data-testid="drain-report-details"]')).toBeFalsy();
  });

  it('fehlendes result → 0/0, kein Crash (defensive Normalisierung)', async () => {
    renderCockpit(makeFetch({ jobStatus: 'done', result: undefined }));
    await startDrain();
    await waitFor(() => {
      const summary = document.querySelector('[data-testid="drain-report-summary"]');
      expect(summary).toBeTruthy();
      expect(summary.textContent).toMatch(/0 erledigt \/ 0 blockiert/);
    });
  });

  it('läuft/fehlgeschlagen zeigen KEINEN Abschlussbericht', async () => {
    renderCockpit(makeFetch({ jobStatus: 'running' }));
    await startDrain();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="drain-job-status"]')?.getAttribute('data-status')).toBe('running');
    });
    expect(document.querySelector('[data-testid="drain-report-summary"]')).toBeFalsy();
  });

  it('bestehender „fertig"-Status bleibt unverändert sichtbar neben dem Bericht', async () => {
    renderCockpit(makeFetch({
      jobStatus: 'done',
      result: { reason: 'no-drain-target', flowRuns: 1, escalated: [], completed: [], blocked: [] },
    }));
    await startDrain();
    await waitFor(() => {
      const status = document.querySelector('[data-testid="drain-job-status"]');
      expect(status.getAttribute('data-status')).toBe('done');
      expect(status.textContent).toMatch(/fertig/i);
      expect(document.querySelector('[data-testid="drain-report-summary"]')).toBeTruthy();
    });
  });
});
