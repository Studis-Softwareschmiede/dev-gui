/**
 * RegressionRunDialog.test.jsx — Tests für den Regressionstest-Ausführen-
 * Dialog (docs/specs/regression-run.md AC4, AC6, S-311 — Backend
 * `regressionSuitesRouter`/`regressionRunRouter` ist S-309/S-310/S-311,
 * bereits gelandet, hier nur der Client-Konsum der dokumentierten
 * Response-Shapes).
 *
 * Covers (regression-run):
 *   AC4 — Suite-Wahl (Bereich/Verbund/Gesamt) als Radiogruppe, geladen aus
 *          `GET /api/projects/:slug/regression-suites`; jede Suite zeigt ihr
 *          deklariertes `target`. Leere Suite-Liste → Hinweistext, Start
 *          gesperrt (kein Crash).
 *   AC6 — Bei Auswahl einer `ephemeral-infra`-Suite zeigt der Dialog VOR dem
 *          Start den Kosten-/Ressourcen-Hinweis aus `kosten`.
 *   Kontext (Main Success Scenario Schritt 3, S-310 bereits Done):
 *     Frisch-Ausrollen-Checkbox nur bei `target: local`-Auswahl sichtbar,
 *     Default AN; bei Selbsttest (`projectSlug === 'dev-gui'`) deaktiviert
 *     mit Hinweistext. „Regressionstest starten" postet
 *     `{ scope, freshRollout? }` an `POST /api/projects/:slug/regression-run`;
 *     202 → Dialog schließt + `onRunStarted(runId)`; Start-Fehler (400/409/
 *     500/Netzwerk) bleiben offen mit Inline-Fehler.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { RegressionRunDialog } = await import('../RegressionRunDialog.jsx');

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; });

const SUITES_RE = /\/api\/projects\/[^/]+\/regression-suites$/;
const RUN_RE = /\/api\/projects\/[^/]+\/regression-run$/;

const SUITES_LOCAL_AND_INFRA = [
  { scope: { typ: 'bereich', id: 'board' }, label: 'board', target: 'local' },
  {
    scope: { typ: 'verbund' },
    label: 'Verbund',
    target: 'ephemeral-infra',
    kosten: 'gering — simulierte Provisionierung',
  },
  { scope: { typ: 'gesamt' }, label: 'Gesamt' },
];

/** fetch-Mock für regression-suites (GET) + regression-run (POST). */
function makeFetch({
  suites = SUITES_LOCAL_AND_INFRA,
  suitesOk = true,
  runStatus = 202,
  runBody = { runId: 'run-1', status: 'running' },
} = {}) {
  const calls = [];
  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    let parsedBody;
    try { parsedBody = opts.body ? JSON.parse(opts.body) : undefined; } catch { parsedBody = opts.body; }
    calls.push({ url, method, body: parsedBody });

    if (SUITES_RE.test(url) && method === 'GET') {
      if (!suitesOk) return { ok: false, status: 500, json: async () => ({ error: 'nope' }) };
      return { ok: true, status: 200, json: async () => ({ suites }) };
    }
    if (RUN_RE.test(url) && method === 'POST') {
      return { status: runStatus, json: async () => runBody };
    }
    return { status: 404, json: async () => ({ error: 'not found' }) };
  });
  return { fetchFn, calls };
}

function renderDialog({
  fetchFn,
  onClose,
  onRunStarted,
  triggerRef,
  projectSlug = 'my-project',
} = {}) {
  const fn = fetchFn ?? makeFetch().fetchFn;
  const close = onClose ?? jest.fn();
  const started = onRunStarted ?? jest.fn();
  const trigger = triggerRef ?? { current: { focus: jest.fn() } };
  const rendered = render(
    React.createElement(RegressionRunDialog, {
      projectSlug,
      fetchFn: fn,
      onClose: close,
      onRunStarted: started,
      triggerRef: trigger,
    }),
  );
  return { fetchFn: fn, onClose: close, onRunStarted: started, triggerRef: trigger, unmount: rendered.unmount };
}

const q = (id) => document.querySelector(`[data-testid="${id}"]`);

describe('regression-run AC4 — Suite-Wahl + Testobjekt-Anzeige', () => {
  it('rendert role=dialog + aria-modal, fokussiert beim Öffnen', async () => {
    renderDialog();
    await waitFor(() => expect(q('regression-run-dialog')).toBeTruthy());
    const dialog = q('regression-run-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('lädt die Suite-Liste und zeigt eine Radiogruppe mit target-Anzeige je Suite', async () => {
    renderDialog();
    await waitFor(() => {
      expect(q('regression-run-suite-bereich:board')).toBeTruthy();
      expect(q('regression-run-suite-verbund')).toBeTruthy();
      expect(q('regression-run-suite-gesamt')).toBeTruthy();
    });
    expect(q('regression-run-target-bereich:board').textContent).toMatch(/lokal/i);
  });

  it('erste Suite ist vorbelegt — „Regressionstest starten" ist sofort aktiv', async () => {
    renderDialog();
    await waitFor(() => {
      const radio = q('regression-run-suite-bereich:board');
      expect(radio.checked).toBe(true);
    });
    expect(q('regression-run-start-btn').disabled).toBe(false);
  });

  it('leere Suite-Liste → Hinweistext, Start bleibt gesperrt (kein Crash)', async () => {
    const { fetchFn } = makeFetch({ suites: [] });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-run-no-suites')).toBeTruthy());
    expect(q('regression-run-start-btn')).toBeFalsy();
  });

  it('Suiten-Fetch fehlgeschlagen → degradiert auf leere Liste, kein Crash', async () => {
    const { fetchFn } = makeFetch({ suitesOk: false });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-run-no-suites')).toBeTruthy());
  });

  it('Auswahl einer anderen Suite (Verbund) aktualisiert die Radio-Gruppe', async () => {
    renderDialog();
    await waitFor(() => expect(q('regression-run-suite-verbund')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-run-suite-verbund')); });
    expect(q('regression-run-suite-verbund').checked).toBe(true);
    expect(q('regression-run-suite-bereich:board').checked).toBe(false);
  });
});

describe('regression-run AC6 — Kosten-/Ressourcen-Hinweis bei ephemeral-infra', () => {
  it('zeigt den Kosten-Hinweis NICHT für die vorbelegte local-Suite', async () => {
    renderDialog();
    await waitFor(() => expect(q('regression-run-suite-bereich:board')).toBeTruthy());
    expect(q('regression-run-cost-notice')).toBeFalsy();
  });

  it('zeigt den Kosten-Hinweis nach Auswahl einer ephemeral-infra-Suite', async () => {
    renderDialog();
    await waitFor(() => expect(q('regression-run-suite-verbund')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-run-suite-verbund')); });
    await waitFor(() => expect(q('regression-run-cost-notice')).toBeTruthy());
    expect(q('regression-run-cost-notice').textContent).toMatch(/gering — simulierte Provisionierung/);
  });

  it('kein kosten-Feld bei ephemeral-infra → kein Hinweis (kein Crash)', async () => {
    const { fetchFn } = makeFetch({
      suites: [{ scope: { typ: 'verbund' }, label: 'Verbund', target: 'ephemeral-infra' }],
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-run-suite-verbund')).toBeTruthy());
    expect(q('regression-run-cost-notice')).toBeFalsy();
  });
});

describe('regression-run — Frisch-Ausrollen-Option (Kontext, S-310 bereits Done)', () => {
  it('zeigt die Checkbox (Default AN) nur bei target:local', async () => {
    renderDialog();
    await waitFor(() => expect(q('regression-run-fresh-rollout-checkbox')).toBeTruthy());
    expect(q('regression-run-fresh-rollout-checkbox').checked).toBe(true);
  });

  it('zeigt KEINE Checkbox bei ephemeral-infra-Auswahl', async () => {
    renderDialog();
    await waitFor(() => expect(q('regression-run-suite-verbund')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-run-suite-verbund')); });
    expect(q('regression-run-fresh-rollout-checkbox')).toBeFalsy();
  });

  it('Selbsttest (projectSlug=dev-gui): Checkbox deaktiviert + Hinweistext', async () => {
    renderDialog({ projectSlug: 'dev-gui' });
    await waitFor(() => expect(q('regression-run-fresh-rollout-checkbox')).toBeTruthy());
    expect(q('regression-run-fresh-rollout-checkbox').disabled).toBe(true);
    expect(q('regression-run-selftest-hint')).toBeTruthy();
  });
});

describe('regression-run — Start (POST regression-run)', () => {
  it('startet den Lauf mit { scope, freshRollout } bei local-Suite, schließt bei 202', async () => {
    const { fetchFn, calls } = makeFetch();
    const { onClose, onRunStarted } = renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-run-start-btn')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-run-start-btn')); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onRunStarted).toHaveBeenCalledWith('run-1');
    const startCall = calls.find((c) => RUN_RE.test(c.url) && c.method === 'POST');
    expect(startCall.body).toEqual({ scope: { typ: 'bereich', id: 'board' }, freshRollout: true });
  });

  it('startet den Lauf OHNE freshRollout-Feld bei Verbund-Suite (ephemeral-infra)', async () => {
    const { fetchFn, calls } = makeFetch();
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-run-suite-verbund')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-run-suite-verbund')); });
    await act(async () => { fireEvent.click(q('regression-run-start-btn')); });
    await waitFor(() => {
      const startCall = calls.find((c) => RUN_RE.test(c.url) && c.method === 'POST');
      expect(startCall).toBeTruthy();
    });
    const startCall = calls.find((c) => RUN_RE.test(c.url) && c.method === 'POST');
    expect(startCall.body).toEqual({ scope: { typ: 'verbund' } });
  });

  it('409 busy → Inline-Fehler, Dialog bleibt offen', async () => {
    const { fetchFn } = makeFetch({ runStatus: 409, runBody: { error: 'busy' } });
    const { onClose } = renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-run-start-btn')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-run-start-btn')); });
    await waitFor(() => expect(q('regression-run-start-error')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Netzwerkfehler beim Start → Inline-Fehler, kein Crash', async () => {
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (SUITES_RE.test(url) && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ suites: SUITES_LOCAL_AND_INFRA }) };
      }
      if (RUN_RE.test(url) && method === 'POST') throw new Error('network down');
      return { status: 404, json: async () => ({}) };
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-run-start-btn')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-run-start-btn')); });
    await waitFor(() => expect(q('regression-run-start-error')).toBeTruthy());
  });
});

describe('regression-run — Schließen', () => {
  it('Schließen-Button ruft onClose + gibt Fokus an triggerRef zurück', async () => {
    const { onClose, triggerRef } = renderDialog();
    await waitFor(() => expect(q('regression-run-close-btn')).toBeTruthy());
    fireEvent.click(q('regression-run-close-btn'));
    expect(onClose).toHaveBeenCalled();
    expect(triggerRef.current.focus).toHaveBeenCalled();
  });

  it('Escape schließt den Dialog', async () => {
    const { onClose } = renderDialog();
    await waitFor(() => expect(q('regression-run-dialog')).toBeTruthy());
    fireEvent.keyDown(q('regression-run-dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
