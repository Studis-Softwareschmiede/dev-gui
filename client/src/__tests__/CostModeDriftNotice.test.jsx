/**
 * CostModeDriftNotice.test.jsx — nicht-modale Drift-Meldung + Vorher/Nachher-Übersicht
 * für die Cost-Mode-Modellprüfung beim Dispatch (docs/specs/cost-mode-model-check.md
 * AC4/AC5 — Frontend-Anteil, S-228).
 *
 * Covers (cost-mode-model-check, S-228):
 *   AC4 — bei laufendem Curator: kurze „Modell veraltet — wird aufgefrischt"-Meldung
 *          (role=status, aria-live, nicht-modal). Nach `done` mit `changed:true`:
 *          Vorher/Nachher-Übersicht (bisheriges `last_curated` → neues) plus die
 *          grobe COST_MODE_INFO-Orientierung (textlich, kein dangerouslySetInnerHTML).
 *          Nach `done` mit `changed:false`: „bereits aktuell — keine Änderung".
 *   AC5 — nicht-blockierend/best-effort: bei `failed` wird „Auffrischen
 *          fehlgeschlagen — der Vorgang läuft trotzdem weiter" gezeigt (nie
 *          blockierend). Poll-Robustheit (coder-Lesson): ein 404/Nicht-200 wird
 *          NICHT wie „running" behandelt — der Loop stoppt und blendet aus (kein
 *          endloses stilles Pollen).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, waitFor } from '@testing-library/react';
import React from 'react';
import { CostModeDriftNotice } from '../CostModeDriftNotice.jsx';

const CHECK_URL_RE = /^\/api\/cost-mode\/check\/chk-1$/;

/** Baut einen fetch-Mock, der die aufeinanderfolgenden Antworten aus `sequence` liefert. */
function makeSeqFetch(sequence) {
  let i = 0;
  return jest.fn(async (url) => {
    if (!CHECK_URL_RE.test(url)) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    const step = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    return {
      ok: step.status === undefined ? true : step.status === 200,
      status: step.status ?? 200,
      json: async () => step.body,
    };
  });
}

function renderNotice(fetchFn, extraProps = {}) {
  return render(
    React.createElement(CostModeDriftNotice, {
      checkId: 'chk-1',
      fetchFn,
      pollIntervalMs: 5,
      ...extraProps,
    }),
  );
}

let consoleErrorSpy;
beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('CostModeDriftNotice (cost-mode-model-check AC4/AC5)', () => {
  it('AC4 — zeigt initial die nicht-modale „Modell veraltet"-Meldung (role=status)', async () => {
    const fetchFn = makeSeqFetch([{ body: { status: 'running' } }]);
    await act(async () => { renderNotice(fetchFn); });

    const notice = document.querySelector('[data-testid="cost-mode-drift-notice"]');
    expect(notice).toBeTruthy();
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(notice.textContent).toMatch(/modell veraltet.*aufgefrischt/i);
  });

  it('AC4 — nach done+changed: Vorher/Nachher-Übersicht (bisher → neu) + COST_MODE_INFO', async () => {
    const fetchFn = makeSeqFetch([
      { body: { status: 'running' } },
      { body: { status: 'done', changed: true, before: { lastCurated: '2026-05-01' }, after: { lastCurated: '2026-07-01' } } },
    ]);
    await act(async () => { renderNotice(fetchFn); });

    await waitFor(() => {
      const ba = document.querySelector('[data-testid="cost-mode-drift-beforeafter"]');
      expect(ba).toBeTruthy();
      expect(ba.textContent).toMatch(/2026-05-01/);
      expect(ba.textContent).toMatch(/2026-07-01/);
    });

    const notice = document.querySelector('[data-testid="cost-mode-drift-notice"]');
    expect(notice.textContent).toMatch(/aufgefrischt/i);
    // COST_MODE_INFO-Orientierung ist textlich vorhanden (mind. ein Modus-Name).
    expect(notice.textContent).toMatch(/low-cost|balanced|max-quality|frontier/);
  });

  it('AC4 — done+changed:false → „bereits aktuell — keine Änderung"', async () => {
    const fetchFn = makeSeqFetch([
      { body: { status: 'done', changed: false, before: { lastCurated: '2026-07-01' }, after: { lastCurated: '2026-07-01' } } },
    ]);
    await act(async () => { renderNotice(fetchFn); });

    await waitFor(() => {
      const notice = document.querySelector('[data-testid="cost-mode-drift-notice"]');
      expect(notice.textContent).toMatch(/keine änderung/i);
    });
  });

  it('AC4 — fehlendes lastCurated → „unbekannt" statt Crash', async () => {
    const fetchFn = makeSeqFetch([
      { body: { status: 'done', changed: true, before: {}, after: {} } },
    ]);
    await act(async () => { renderNotice(fetchFn); });

    await waitFor(() => {
      const ba = document.querySelector('[data-testid="cost-mode-drift-beforeafter"]');
      expect(ba).toBeTruthy();
      expect(ba.textContent).toMatch(/unbekannt/i);
    });
  });

  it('AC5 — failed → „Auffrischen fehlgeschlagen … läuft trotzdem weiter" (nicht blockierend)', async () => {
    const fetchFn = makeSeqFetch([
      { body: { status: 'running' } },
      { body: { status: 'failed' } },
    ]);
    await act(async () => { renderNotice(fetchFn); });

    await waitFor(() => {
      const notice = document.querySelector('[data-testid="cost-mode-drift-notice"]');
      expect(notice.textContent).toMatch(/fehlgeschlagen.*läuft trotzdem weiter/i);
    });
  });

  it('AC5 — 404/Nicht-200 wird NICHT endlos gepollt: Meldung wird ausgeblendet (Lesson)', async () => {
    const fetchFn = makeSeqFetch([{ status: 404, body: { error: 'Unknown checkId' } }]);
    await act(async () => { renderNotice(fetchFn); });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="cost-mode-drift-notice"]')).toBeNull();
    });
    // Kein weiteres Pollen nach dem 404 (genau ein Fetch).
    const checkCalls = fetchFn.mock.calls.filter((c) => CHECK_URL_RE.test(c[0]));
    expect(checkCalls).toHaveLength(1);
  });

  it('kein checkId → rendert nichts (kein Fetch)', () => {
    const fetchFn = jest.fn();
    render(React.createElement(CostModeDriftNotice, { checkId: null, fetchFn }));
    expect(document.querySelector('[data-testid="cost-mode-drift-notice"]')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
