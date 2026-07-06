/**
 * CockpitDrainCostModeStatus.test.jsx — Tests für headless-manual-drain
 * AC5 (Cost-Mode am „Board abarbeiten"-Knopf) und AC6 (Status-Feedback inline +
 * Kein-Live-Terminal-Hinweis + Board-Re-Fetch bei done).
 *
 * Covers (headless-manual-drain):
 *   AC5 — Cost-Mode-Dropdown (4-Wege low-cost|balanced|max-quality|frontier,
 *          Default balanced, grobe Tier-/Kosten-Orientierung + Abo-Disclaimer,
 *          geteilt via costMode.js) sitzt beim „Board abarbeiten"-Knopf und wird
 *          als `{ costMode }` im JSON-Body an POST …/drain gesendet
 *          (balanced-Default wird mitgeschickt — der Server lässt das Flag weg).
 *          Das Dropdown ist bei Session-Busy deaktiviert.
 *   AC6 — Nach 202 pollt das Panel GET …/drain/:drainId und zeigt den Status
 *          INLINE neben dem Knopf: „läuft…" | „fertig" | „fehlgeschlagen"
 *          (Bedeutung immer textlich, nie nur Farbe). Ein 404/unbekannter Status
 *          endet als „fehlgeschlagen" (kein endloses Pollen — coder-Lesson).
 *          Ein sichtbarer Hinweis stellt klar, dass keine Live-Terminal-Ausgabe
 *          erscheint. Bei `done` triggert das Panel ein Board-Re-Fetch
 *          (Re-Key der BoardView — beim Öffnen des Board-Reiters frisch), ohne
 *          Tab-Wechsel (der „fertig"-Status bleibt sichtbar). Bestätigungsdialog
 *          bleibt erhalten.
 *
 * HTTP-/fetch-Ebene (coder/R06-Analogon fürs Frontend): die Tests prüfen die
 * echten fetch-Calls (POST-Body trägt costMode; GET …/drain/:drainId wird
 * gepollt) — nicht nur Render-Zustände.
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

const DRAIN_POST_URL_RE   = /^\/api\/projects\/[^/]+\/drain$/;
const DRAIN_STATUS_URL_RE = /^\/api\/projects\/[^/]+\/drain\/[^/]+$/;

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; window.location.hash = ''; });

/**
 * fetch mock: /api/session, POST …/drain (202 {drainId}), GET …/drain/:id (status).
 * @param {object} [opts]
 * @param {'busy'|'ready'} [opts.sessionState='ready']
 * @param {number} [opts.postStatus=202]
 * @param {object} [opts.postBody={drainId:'d-1'}]
 * @param {string} [opts.jobStatus='running'] — status returned by GET …/drain/:id
 * @param {number} [opts.statusHttp=200]       — HTTP status of the status GET
 */
function makeFetch({
  sessionState = 'ready',
  postStatus = 202,
  postBody = { drainId: 'd-1' },
  jobStatus = 'running',
  statusHttp = 200,
} = {}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => ({ state: sessionState, restarts: 0 }) };
    }
    if (DRAIN_STATUS_URL_RE.test(url)) {
      return { ok: statusHttp === 200, status: statusHttp, json: async () => ({ status: jobStatus }) };
    }
    if (DRAIN_POST_URL_RE.test(url) && opts?.method === 'POST') {
      return { ok: postStatus === 202, status: postStatus, json: async () => postBody };
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

/** Extract the parsed JSON body of the (first) POST …/drain call. */
function postedDrainBody(fetchFn) {
  const call = fetchFn.mock.calls.find((c) => DRAIN_POST_URL_RE.test(c[0]) && c[1]?.method === 'POST');
  if (!call) return null;
  try { return JSON.parse(call[1].body); } catch { return null; }
}

// ── AC5: Cost-Mode am Knopf ───────────────────────────────────────────────────

describe('headless-manual-drain AC5 — Cost-Mode am „Board abarbeiten"-Knopf', () => {
  it('renders a 4-way cost-mode dropdown (default balanced) next to the button', () => {
    renderCockpit();
    const select = document.querySelector('[data-testid="drain-cost-mode-select"]');
    expect(select).toBeTruthy();
    expect(select.value).toBe('balanced');
    const opts = [...select.querySelectorAll('option')].map((o) => o.value);
    expect(opts).toEqual(['low-cost', 'balanced', 'max-quality', 'frontier']);
  });

  it('shows the tier/cost orientation + subscription disclaimer (shared costMode.js)', () => {
    renderCockpit();
    const info = document.querySelector('[data-testid="drain-cost-info"]');
    expect(info).toBeTruthy();
    // COST_MODE_INFO['balanced'] = { models: 'sonnet/opus', price: '$3–5 / $15–25' }
    expect(info.textContent).toMatch(/sonnet\/opus/);
    expect(info.textContent).toMatch(/Abo-Betrieb/);
  });

  it('confirms with default → POST body carries { costMode: "balanced" }', async () => {
    const fetchFn = makeFetch();
    renderCockpit(fetchFn);
    await startDrain();
    await waitFor(() => {
      expect(postedDrainBody(fetchFn)).toEqual({ costMode: 'balanced' });
    });
  });

  it('selecting max-quality → POST body carries { costMode: "max-quality" }', async () => {
    const fetchFn = makeFetch();
    renderCockpit(fetchFn);
    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="drain-cost-mode-select"]'), {
        target: { value: 'max-quality' },
      });
    });
    await startDrain();
    await waitFor(() => {
      expect(postedDrainBody(fetchFn)).toEqual({ costMode: 'max-quality' });
    });
    // Content-Type must be JSON so the server body-parser reads costMode.
    const call = fetchFn.mock.calls.find((c) => DRAIN_POST_URL_RE.test(c[0]) && c[1]?.method === 'POST');
    expect(call[1].headers['Content-Type']).toMatch(/application\/json/);
  });

  it('cost-mode dropdown is disabled when the session is busy', async () => {
    renderCockpit(makeFetch({ sessionState: 'busy' }));
    await waitFor(() => {
      const select = document.querySelector('[data-testid="drain-cost-mode-select"]');
      expect(select.disabled).toBe(true);
    });
  });
});

// ── AC6: Status-Feedback inline + Hinweis + Board-Re-Fetch ────────────────────

describe('headless-manual-drain AC6 — Status-Feedback + Kein-Live-Terminal-Hinweis', () => {
  it('always shows a visible „kein Live-Terminal"-hint', () => {
    renderCockpit();
    const hint = document.querySelector('[data-testid="drain-no-live-terminal-hint"]');
    expect(hint).toBeTruthy();
    expect(hint.textContent).toMatch(/keine/i);
    expect(hint.textContent).toMatch(/terminal/i);
  });

  it('after 202 + running poll → inline status shows „läuft" (text, not color alone)', async () => {
    renderCockpit(makeFetch({ jobStatus: 'running' }));
    await startDrain();
    await waitFor(() => {
      const status = document.querySelector('[data-testid="drain-job-status"]');
      expect(status).toBeTruthy();
      expect(status.getAttribute('data-status')).toBe('running');
      expect(status.textContent).toMatch(/läuft/i);
    });
  });

  it('done poll → inline status shows „fertig" and stays on the Arbeiten tab', async () => {
    renderCockpit(makeFetch({ jobStatus: 'done' }));
    await startDrain();
    await waitFor(() => {
      const status = document.querySelector('[data-testid="drain-job-status"]');
      expect(status).toBeTruthy();
      expect(status.getAttribute('data-status')).toBe('done');
      expect(status.textContent).toMatch(/fertig/i);
    });
    // No forced tab switch — the Arbeiten panel (board button) is still mounted.
    expect(document.querySelector('[data-testid="flow-board-btn"]')).toBeTruthy();
  });

  it('failed poll → inline status shows „fehlgeschlagen" as role=alert', async () => {
    renderCockpit(makeFetch({ jobStatus: 'failed' }));
    await startDrain();
    await waitFor(() => {
      const status = document.querySelector('[data-testid="drain-job-status"]');
      expect(status).toBeTruthy();
      expect(status.getAttribute('data-status')).toBe('failed');
      expect(status.getAttribute('role')).toBe('alert');
      expect(status.textContent).toMatch(/fehlgeschlagen/i);
    });
  });

  it('404 on the status poll → ends as „fehlgeschlagen" (no endless polling — coder-lesson)', async () => {
    const fetchFn = makeFetch({ statusHttp: 404 });
    renderCockpit(fetchFn);
    await startDrain();
    await waitFor(() => {
      const status = document.querySelector('[data-testid="drain-job-status"]');
      expect(status?.getAttribute('data-status')).toBe('failed');
    });
    // Exactly one status GET was made — the loop did not keep polling a 404.
    const statusCalls = fetchFn.mock.calls.filter((c) => DRAIN_STATUS_URL_RE.test(c[0]));
    expect(statusCalls).toHaveLength(1);
  });

  it('done → board is fresh when the board tab is opened (Board-Re-Fetch via re-key)', async () => {
    renderCockpit(makeFetch({ jobStatus: 'done' }));
    await startDrain();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="drain-job-status"]')?.getAttribute('data-status')).toBe('done');
    });
    // Switch to the board tab → BoardView mounts fresh (re-keyed on done).
    await act(async () => {
      fireEvent.click(document.querySelector('#cockpit-tab-board'));
    });
    expect(document.querySelector('main[aria-label="Studis-Kanban-Board"]')).toBeTruthy();
  });

  it('confirmation dialog is still required before starting (no accidental drain)', async () => {
    const fetchFn = makeFetch();
    renderCockpit(fetchFn);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="flow-board-btn"]'));
    });
    // Dialog shown, no POST yet.
    expect(document.querySelector('[data-testid="flow-confirm-dialog"]')).toBeTruthy();
    const postsBefore = fetchFn.mock.calls.filter((c) => DRAIN_POST_URL_RE.test(c[0]) && c[1]?.method === 'POST');
    expect(postsBefore).toHaveLength(0);
  });
});
