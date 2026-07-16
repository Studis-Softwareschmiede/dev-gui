/**
 * RegressionResultView.test.jsx — Tests für die Regressions-Ergebnis-Ansicht
 * (docs/specs/regression-result-view.md AC3-AC6, S-314 — Backend Read-API
 * `src/routers/regressionRuns.js` ist S-313, bereits gelandet, hier nur der
 * Client-Konsum der dokumentierten Response-Shapes).
 *
 * Covers (regression-result-view):
 *   AC3 — Lauf-Liste je Projekt (Datum, Suite, grün/rot, Dauer, Testfall-
 *          Zähler `passed/total`), jüngste zuerst (Store-Reihenfolge
 *          übernommen, nicht neu sortiert); grün/rot mit Icon + Text + Farbe
 *          (nie Farbe allein, WCAG 2.1 AA).
 *   AC4 — Einfacher grün/rot-Trend je Suite: Abfolge der letzten Läufe DIESER
 *          Suite (aus der Liste gruppiert). Suite mit nur einem Lauf → Trend
 *          zeigt genau diesen einen Zustand (Edge-Case).
 *   AC5 — Drilldown: Klick auf einen Lauf lädt
 *          `GET .../regression-runs/:runId` und zeigt die Testfälle aus
 *          `ctrf.results.tests[]` (Name + grün/rot + Fehlermeldung bei Rot).
 *          Unlesbares/unerwartetes CTRF-Format → degradierte Meldung statt
 *          Crash.
 *   AC2/AC6 (S-328) — Debug-Artefakte (HTML-Report-Link inkl. Trace-Viewer,
 *          Screenshot-Galerie je Testfall, Video je Testfall) sind für JEDEN
 *          Status (grün UND rot) zugänglich, solange die jeweils benötigte
 *          Artefakt-Referenz vorhanden ist. Review-Fix Iteration 2: ZWEI
 *          GETRENNTE Gates, weil `htmlReport`/`testResults` Store-seitig
 *          unabhängig voneinander kopiert werden (Teilzustand möglich) —
 *          Report-Link hängt NUR an `run.artifacts.htmlReport`; Galerie/Video
 *          hängen NUR an `run.artifacts.testResults` (die Attachments liegen
 *          unter `test-results/`). Fehlt `testResults` (nie erfasst /
 *          geprunt), zeigt die Ansicht — nur wenn Testfälle überhaupt
 *          Attachments referenzieren — einen Hinweis „Screenshots/Video
 *          nicht mehr vorhanden." statt toter `<img>`-URLs; fehlt (nur)
 *          `htmlReport`, entfällt nur der Report-Link, unabhängig von der
 *          Galerie.
 *   AC7 (S-326) — Frühausfall-Darstellung: ein Lauf mit `status:
 *          "precondition-error"|"error"` erscheint als eigener dritter
 *          Zustand „⚠ Nicht ausgeführt" (NIE grün/NIE rot) in Liste UND
 *          Drilldown; `reason` erscheint im Drilldown als Fehlgrund-Text
 *          (`role="alert"`); fehlt `reason` → generischer Hinweis; kein
 *          Artefakt-Link, keine Testfall-Liste; im Suite-Trend eigenes
 *          ⚠-Zeichen statt ✓.
 *
 * Edge-Cases (Spec):
 *   - Keine Läufe → „Noch kein Regressionstest gelaufen." (kein Fehler).
 *   - CTRF-Details unlesbar/teilweise → Lauf bleibt in der Liste, Drilldown
 *     zeigt degradierte Meldung statt Crash.
 *   - Frühausfall-Lauf ohne `reason` (S-326) → generischer Hinweis „Kein
 *     Fehlgrund hinterlegt.".
 *   - Suite hat ausschließlich Frühausfall-Läufe (S-326) → reine ⚠-Kette.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { RegressionResultView } = await import('../RegressionResultView.jsx');

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; });

const LIST_RE = /\/api\/projects\/[^/]+\/regression-runs$/;
const RUN_RE = /\/api\/projects\/[^/]+\/regression-runs\/([^/]+)$/;

const RUN_PASSED = {
  runId: 'run-2',
  suite: 'board',
  scopeTyp: 'bereich',
  status: 'passed',
  startedAt: '2026-07-08T10:00:00.000Z',
  durationMs: 4200,
  counts: { passed: 5, failed: 0, total: 5 },
};
const RUN_FAILED = {
  runId: 'run-1',
  suite: 'board',
  scopeTyp: 'bereich',
  status: 'failed',
  startedAt: '2026-07-07T10:00:00.000Z',
  durationMs: 6100,
  counts: { passed: 3, failed: 2, total: 5 },
  // Review-Fix Iteration 2: htmlReport UND testResults gesetzt (Regelfall,
  // vollständige Artefakt-Ablage) — die Teilzustand-Tests (nur EIN Teil)
  // überschreiben `artifacts` gezielt.
  artifacts: { htmlReport: 'playwright-report', testResults: 'test-results' },
};
// AC7 (S-326): Frühausfall-Datensatz — kein CTRF, ctrf:null, reason gesetzt.
const RUN_NOT_RUN = {
  runId: 'run-4',
  suite: 'vps',
  scopeTyp: 'bereich',
  status: 'precondition-error',
  startedAt: '2026-07-09T08:00:00.000Z',
  durationMs: 120,
  counts: { passed: 0, failed: 0, total: 0 },
  reason: 'Applikation lokal nicht gestartet',
  ctrf: null,
};

/**
 * @param {{ runs?: Array, listOk?: boolean, runDetails?: Record<string, object>, runOk?: boolean }} opts
 */
function makeFetch({
  runs = [RUN_PASSED, RUN_FAILED],
  listOk = true,
  runDetails = {},
  runOk = true,
} = {}) {
  const calls = [];
  const fetchFn = jest.fn(async (url) => {
    calls.push(url);
    if (LIST_RE.test(url)) {
      if (!listOk) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return { ok: true, status: 200, json: async () => ({ runs }) };
    }
    const runMatch = url.match(RUN_RE);
    if (runMatch) {
      if (!runOk) return { ok: false, status: 404, json: async () => ({ error: 'nicht gefunden' }) };
      const runId = runMatch[1];
      const run = runDetails[runId];
      return { ok: true, status: 200, json: async () => ({ run }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'unbekannt' }) };
  });
  fetchFn.calls = calls;
  return fetchFn;
}

async function renderView(fetchFn, props = {}) {
  const onClose = jest.fn();
  render(
    React.createElement(RegressionResultView, {
      projectSlug: 'my-project',
      onClose,
      fetchFn,
      ...props,
    }),
  );
  await act(async () => { await Promise.resolve(); });
  return { onClose };
}

// ── AC3: Lauf-Liste ─────────────────────────────────────────────────────────

describe('RegressionResultView — AC3: Lauf-Liste', () => {
  it('renders the run list with date, suite, status (icon+text), duration and passed/total', async () => {
    const fetchFn = makeFetch();
    await renderView(fetchFn);

    const list = document.querySelector('[data-testid="regression-result-list"]');
    expect(list).toBeTruthy();
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(2);

    // jüngste zuerst — Store liefert bereits in dieser Reihenfolge, Liste übernimmt sie unverändert.
    expect(items[0].textContent).toMatch(/board/);
    expect(items[0].textContent).toMatch(/5\/5 bestanden/);
    expect(items[1].textContent).toMatch(/3\/5 bestanden/);
  });

  it('status badge shows icon AND text (never color alone) for passed and failed', async () => {
    const fetchFn = makeFetch();
    await renderView(fetchFn);

    const badges = document.querySelectorAll('[data-testid="regression-result-status-badge"]');
    expect(badges.length).toBeGreaterThanOrEqual(2);
    const passedBadge = Array.from(badges).find((b) => b.dataset.status === 'passed');
    const failedBadge = Array.from(badges).find((b) => b.dataset.status === 'failed');
    expect(passedBadge.textContent).toMatch(/✓/);
    expect(passedBadge.textContent).toMatch(/Erfolgreich/);
    expect(failedBadge.textContent).toMatch(/✗/);
    expect(failedBadge.textContent).toMatch(/Fehlgeschlagen/);
  });

  it('shows duration formatted (seconds for >=1000ms)', async () => {
    const fetchFn = makeFetch();
    await renderView(fetchFn);
    const list = document.querySelector('[data-testid="regression-result-list"]');
    expect(list.textContent).toMatch(/4\.2 s/);
    expect(list.textContent).toMatch(/6\.1 s/);
  });

  it('Edge-Case: keine Läufe → Hinweistext, kein Fehler', async () => {
    const fetchFn = makeFetch({ runs: [] });
    await renderView(fetchFn);
    const empty = document.querySelector('[data-testid="regression-result-empty"]');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toMatch(/Noch kein Regressionstest gelaufen\./);
  });

  it('Edge-Case: Liste nicht erreichbar (500) → degradiert auf leere Liste, kein Crash', async () => {
    const fetchFn = makeFetch({ listOk: false });
    await renderView(fetchFn);
    const empty = document.querySelector('[data-testid="regression-result-empty"]');
    expect(empty).toBeTruthy();
  });
});

// ── AC4: grün/rot-Trend je Suite ────────────────────────────────────────────

describe('RegressionResultView — AC4: grün/rot-Trend je Suite', () => {
  it('renders one trend entry per suite with the sequence of that suite\'s runs', async () => {
    const fetchFn = makeFetch();
    await renderView(fetchFn);

    const trend = document.querySelector('[data-testid="regression-result-trend-board"]');
    expect(trend).toBeTruthy();
    const dots = trend.querySelectorAll('[data-testid="regression-result-trend"] > span[aria-hidden="true"]');
    expect(dots).toHaveLength(2);
    // jüngster Lauf zuerst (RUN_PASSED), dann RUN_FAILED.
    expect(dots[0].textContent).toBe('✓');
    expect(dots[1].textContent).toBe('✗');
  });

  it('Edge-Case: Suite mit nur einem Lauf zeigt genau diesen einen Zustand', async () => {
    const fetchFn = makeFetch({ runs: [RUN_PASSED] });
    await renderView(fetchFn);
    const trend = document.querySelector('[data-testid="regression-result-trend-board"]');
    const dots = trend.querySelectorAll('[data-testid="regression-result-trend"] > span[aria-hidden="true"]');
    expect(dots).toHaveLength(1);
    expect(dots[0].textContent).toBe('✓');
  });

  it('groups distinct suites separately', async () => {
    const otherSuiteRun = { ...RUN_PASSED, runId: 'run-3', suite: 'vps' };
    const fetchFn = makeFetch({ runs: [otherSuiteRun, RUN_PASSED, RUN_FAILED] });
    await renderView(fetchFn);
    expect(document.querySelector('[data-testid="regression-result-trend-board"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="regression-result-trend-vps"]')).toBeTruthy();
  });
});

// ── AC5: Drilldown ───────────────────────────────────────────────────────────

describe('RegressionResultView — AC5: Drilldown', () => {
  it('clicking a run loads and shows its test cases (name + status + message on failure)', async () => {
    const fetchFn = makeFetch({
      runDetails: {
        'run-1': {
          ...RUN_FAILED,
          ctrf: {
            results: {
              tests: [
                { name: 'login works', status: 'passed' },
                { name: 'checkout fails', status: 'failed', message: 'Timeout waiting for selector' },
              ],
            },
          },
        },
      },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-testcases"]')).toBeTruthy();
    });

    const testcases = document.querySelector('[data-testid="regression-result-testcases"]');
    expect(testcases.textContent).toMatch(/login works/);
    expect(testcases.textContent).toMatch(/checkout fails/);
    const message = document.querySelector('[data-testid="regression-result-testcase-message"]');
    expect(message.textContent).toMatch(/Timeout waiting for selector/);
  });

  it('back button returns to the run list', async () => {
    const fetchFn = makeFetch({
      runDetails: {
        'run-2': { ...RUN_PASSED, ctrf: { results: { tests: [{ name: 'a', status: 'passed' }] } } },
      },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-2"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-drilldown"]')).toBeTruthy();
    });

    fireEvent.click(document.querySelector('[data-testid="regression-result-drilldown-back"]'));
    expect(document.querySelector('[data-testid="regression-result-list"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="regression-result-drilldown"]')).toBeNull();
  });

  it('Edge-Case: CTRF unlesbar/unerwartetes Format → degradierte Meldung statt Crash', async () => {
    const fetchFn = makeFetch({
      runDetails: {
        'run-1': { ...RUN_FAILED, ctrf: { unexpected: 'shape' } },
      },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-ctrf-degraded"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="regression-result-testcases"]')).toBeNull();
  });

  it('Edge-Case: Einzel-Lauf-Fetch schlägt fehl (404/Netzwerk) → Inline-Fehler, kein Crash', async () => {
    const fetchFn = makeFetch({ runOk: false });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-drilldown-error"]')).toBeTruthy();
    });
  });
});

// ── AC2/AC6 (S-328): Debug-Artefakte bei JEDEM Status, gated auf Vorhandensein ──

describe('RegressionResultView — AC2/AC6 (S-328): Debug-Artefakt-Zugriff bei jedem Status', () => {
  it('shows the artifact link for a failed run with artifacts', async () => {
    const fetchFn = makeFetch({
      runDetails: {
        'run-1': { ...RUN_FAILED, ctrf: { results: { tests: [] } } },
      },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      const link = document.querySelector('[data-testid="regression-result-artifact-link"]');
      expect(link).toBeTruthy();
      expect(link.getAttribute('href')).toMatch(/\/regression-runs\/run-1\/artifacts\//);
    });
  });

  it('S-328: also shows the artifact link for a PASSED run with artifacts (Rot-Only-Gate ist aufgehoben)', async () => {
    const passedWithArtifacts = { ...RUN_PASSED, artifacts: { htmlReport: 'playwright-report' } };
    const fetchFn = makeFetch({
      runDetails: {
        'run-2': { ...passedWithArtifacts, ctrf: { results: { tests: [{ name: 'a', status: 'passed' }] } } },
      },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-2"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      const link = document.querySelector('[data-testid="regression-result-artifact-link"]');
      expect(link).toBeTruthy();
      expect(link.getAttribute('href')).toMatch(/\/regression-runs\/run-2\/artifacts\//);
    });
  });

  it('does NOT show the artifact link for a run WITHOUT artifacts (kein toter Link), no hint when no attachments referenced', async () => {
    const fetchFn = makeFetch({
      runDetails: {
        'run-2': { ...RUN_PASSED, ctrf: { results: { tests: [{ name: 'a', status: 'passed' }] } } },
      },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-2"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-testcases"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="regression-result-artifact-link"]')).toBeNull();
    expect(document.querySelector('[data-testid="regression-result-artifacts-pruned"]')).toBeNull();
  });

  it('Edge-Case (gepruneter Lauf): keine artifacts, aber Testfälle referenzieren Attachments → Hinweis statt totem Link/toter Galerie', async () => {
    const fetchFn = makeFetch({
      runDetails: {
        'run-2': {
          ...RUN_PASSED,
          ctrf: {
            results: {
              tests: [{ name: 'a', status: 'passed', attachments: [{ name: 'screenshot', contentType: 'image/png', path: 'test-results/a/screenshot.png' }] }],
            },
          },
        },
      },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-2"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-artifacts-pruned"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="regression-result-artifacts-pruned"]').textContent).toMatch(/Screenshots\/Video nicht mehr vorhanden/);
    expect(document.querySelector('[data-testid="regression-result-artifact-link"]')).toBeNull();
    expect(document.querySelector('[data-testid="regression-result-screenshot"]')).toBeNull();
  });

  // ── Review-Fix Iteration 2: htmlReport/testResults sind ZWEI unabhängige
  //    Gates (Store kopiert beide separat, best-effort je Teil) ────────────

  it('Teilzustand: NUR testResults (kein htmlReport) → Galerie sichtbar, KEIN Report-Link', async () => {
    const fetchFn = makeFetch({
      runDetails: {
        'run-1': {
          ...RUN_FAILED,
          artifacts: { testResults: 'test-results' },
          ctrf: {
            results: {
              tests: [{ name: 'checkout fails', status: 'failed', attachments: [{ name: 's', contentType: 'image/png', path: 'test-results/checkout/shot.png' }] }],
            },
          },
        },
      },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-screenshot"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="regression-result-artifact-link"]')).toBeNull();
    expect(document.querySelector('[data-testid="regression-result-artifacts-pruned"]')).toBeNull();
  });

  it('Teilzustand: NUR htmlReport (kein testResults) → Report-Link sichtbar, KEINE Galerie (Hinweis statt totem <img>)', async () => {
    const fetchFn = makeFetch({
      runDetails: {
        'run-1': {
          ...RUN_FAILED,
          artifacts: { htmlReport: 'playwright-report' },
          ctrf: {
            results: {
              tests: [{ name: 'checkout fails', status: 'failed', attachments: [{ name: 's', contentType: 'image/png', path: 'test-results/checkout/shot.png' }] }],
            },
          },
        },
      },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      const link = document.querySelector('[data-testid="regression-result-artifact-link"]');
      expect(link).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="regression-result-screenshot"]')).toBeNull();
    expect(document.querySelector('[data-testid="regression-result-artifacts-pruned"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="regression-result-artifacts-pruned"]').textContent).toMatch(/Screenshots\/Video nicht mehr vorhanden/);
  });
});

// ── AC6 (S-328): Screenshot-Galerie ─────────────────────────────────────────

describe('RegressionResultView — AC6 (S-328): Screenshot-Galerie', () => {
  const runWithScreenshot = {
    ...RUN_FAILED,
    ctrf: {
      results: {
        tests: [
          {
            name: 'checkout fails',
            status: 'failed',
            message: 'Timeout waiting for selector',
            attachments: [
              { name: 'screenshot', contentType: 'image/png', path: 'test-results/checkout/screenshot.png' },
            ],
          },
        ],
      },
    },
  };

  it('renders an inline <img> per image/* attachment with a meaningful alt text', async () => {
    const fetchFn = makeFetch({ runDetails: { 'run-1': runWithScreenshot } });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-screenshot"]')).toBeTruthy();
    });

    const img = document.querySelector('[data-testid="regression-result-screenshot"]');
    expect(img.getAttribute('src')).toBe('/api/projects/my-project/regression-runs/run-1/artifacts/test-results/checkout/screenshot.png');
    expect(img.getAttribute('alt')).toMatch(/checkout fails/);
    expect(img.getAttribute('alt')).toMatch(/Screenshot/);
  });

  it('encodes each path segment of the attachment path (no client-side path building beyond that)', async () => {
    const runWithSpecialPath = {
      ...RUN_FAILED,
      ctrf: {
        results: {
          tests: [{
            name: 'a',
            status: 'failed',
            attachments: [{ name: 's', contentType: 'image/png', path: 'test-results/a b/shot #1.png' }],
          }],
        },
      },
    };
    const fetchFn = makeFetch({ runDetails: { 'run-1': runWithSpecialPath } });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      const img = document.querySelector('[data-testid="regression-result-screenshot"]');
      expect(img).toBeTruthy();
      expect(img.getAttribute('src')).toBe('/api/projects/my-project/regression-runs/run-1/artifacts/test-results/a%20b/shot%20%231.png');
    });
  });

  it('renders no screenshot for a test case without attachments', async () => {
    const fetchFn = makeFetch({ runDetails: { 'run-1': { ...RUN_FAILED, ctrf: { results: { tests: [{ name: 'a', status: 'passed' }] } } } } });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-testcases"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="regression-result-screenshot"]')).toBeNull();
  });
});

// ── AC6 (S-328): Video ───────────────────────────────────────────────────────

describe('RegressionResultView — AC6 (S-328): Video', () => {
  it('renders a <video controls> for a video/webm attachment', async () => {
    const runWithVideo = {
      ...RUN_FAILED,
      ctrf: {
        results: {
          tests: [{
            name: 'checkout fails',
            status: 'failed',
            attachments: [{ name: 'video', contentType: 'video/webm', path: 'test-results/checkout/video.webm' }],
          }],
        },
      },
    };
    const fetchFn = makeFetch({ runDetails: { 'run-1': runWithVideo } });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-video"]')).toBeTruthy();
    });
    const video = document.querySelector('[data-testid="regression-result-video"]');
    expect(video.hasAttribute('controls')).toBe(true);
    const source = video.querySelector('source');
    expect(source.getAttribute('src')).toBe('/api/projects/my-project/regression-runs/run-1/artifacts/test-results/checkout/video.webm');
  });

  it('Edge-Case: kein Video-Attachment vorhanden → kein toter Player', async () => {
    const fetchFn = makeFetch({
      runDetails: {
        'run-1': { ...RUN_FAILED, ctrf: { results: { tests: [{ name: 'a', status: 'failed', attachments: [{ name: 's', contentType: 'image/png', path: 'x.png' }] }] } } },
      },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-1"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-screenshot"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="regression-result-video"]')).toBeNull();
  });
});

// ── AC7 (S-326): Frühausfall-Darstellung ────────────────────────────────────

describe('RegressionResultView — AC7 (S-326): Frühausfall-Darstellung', () => {
  it('list + trend: ein precondition-error/error-Lauf zeigt "⚠ Nicht ausgeführt" — nie grün, nie rot', async () => {
    const fetchFn = makeFetch({ runs: [RUN_NOT_RUN] });
    await renderView(fetchFn);

    const badge = document.querySelector('[data-testid="regression-result-status-badge"][data-status="not-run"]');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toMatch(/⚠/);
    expect(badge.textContent).toMatch(/Nicht ausgeführt/);

    const trend = document.querySelector('[data-testid="regression-result-trend-vps"]');
    const dots = trend.querySelectorAll('[data-testid="regression-result-trend"] > span[aria-hidden="true"]');
    expect(dots).toHaveLength(1);
    expect(dots[0].textContent).toBe('⚠');
  });

  it('Edge-Case: Suite hat ausschließlich Frühausfall-Läufe → reine ⚠-Kette (weder grün noch rot)', async () => {
    const secondNotRun = { ...RUN_NOT_RUN, runId: 'run-5', status: 'error', startedAt: '2026-07-08T08:00:00.000Z' };
    const fetchFn = makeFetch({ runs: [secondNotRun, RUN_NOT_RUN] });
    await renderView(fetchFn);

    const trend = document.querySelector('[data-testid="regression-result-trend-vps"]');
    const dots = trend.querySelectorAll('[data-testid="regression-result-trend"] > span[aria-hidden="true"]');
    expect(dots).toHaveLength(2);
    expect(Array.from(dots).every((d) => d.textContent === '⚠')).toBe(true);
  });

  it('Drilldown: reason erscheint als Fehlgrund-Text (role=alert), kein Artefakt-Link, keine Testfall-Liste', async () => {
    const fetchFn = makeFetch({
      runs: [RUN_NOT_RUN],
      runDetails: { 'run-4': RUN_NOT_RUN },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-4"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="regression-result-not-run-reason"]')).toBeTruthy();
    });

    const reasonEl = document.querySelector('[data-testid="regression-result-not-run-reason"]');
    expect(reasonEl.textContent).toBe('Applikation lokal nicht gestartet');
    expect(reasonEl.getAttribute('role')).toBe('alert');
    expect(document.querySelector('[data-testid="regression-result-artifact-link"]')).toBeNull();
    expect(document.querySelector('[data-testid="regression-result-testcases"]')).toBeNull();
    expect(document.querySelector('[data-testid="regression-result-ctrf-empty"]')).toBeNull();
    expect(document.querySelector('[data-testid="regression-result-ctrf-degraded"]')).toBeNull();
  });

  it('Edge-Case: Frühausfall-Lauf ohne reason → generischer Hinweis "Kein Fehlgrund hinterlegt."', async () => {
    const noReasonRun = { ...RUN_NOT_RUN, reason: undefined };
    const fetchFn = makeFetch({
      runs: [noReasonRun],
      runDetails: { 'run-4': noReasonRun },
    });
    await renderView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="regression-result-run-run-4"]'));
      await Promise.resolve();
    });
    await waitFor(() => {
      const reasonEl = document.querySelector('[data-testid="regression-result-not-run-reason"]');
      expect(reasonEl).toBeTruthy();
      expect(reasonEl.textContent).toBe('Kein Fehlgrund hinterlegt.');
    });
  });
});

// ── Dialog-Grundverhalten (Muster RegressionRunDialog) ──────────────────────

describe('RegressionResultView — Dialog-Grundverhalten', () => {
  it('Esc closes the view', async () => {
    const fetchFn = makeFetch();
    const { onClose } = await renderView(fetchFn);
    const dialog = document.querySelector('[data-testid="regression-result-view"]');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('close button closes the view', async () => {
    const fetchFn = makeFetch();
    const { onClose } = await renderView(fetchFn);
    fireEvent.click(document.querySelector('[data-testid="regression-result-close-btn"]'));
    expect(onClose).toHaveBeenCalled();
  });
});
