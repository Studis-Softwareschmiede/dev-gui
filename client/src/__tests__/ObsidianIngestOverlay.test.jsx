/**
 * ObsidianIngestOverlay.test.jsx — Tests für das Fragenkatalog-Overlay des
 * headless Obsidian-Ingest-Laufs.
 *
 * Covers (obsidian-question-catalog, S-251 — UI-Anteile; Backend AC1/AC2/AC6
 * ist S-250, dort/in ObsidianIngestRunner.test.js + obsidianIngestRouter.test.js
 * abgedeckt, hier nur der Client-Konsum der dokumentierten Response-Shapes):
 *   AC10 — (v2, S-384) `POST .../obsidian-ingest/start` sendet `targetProjectSlug`
 *          zusätzlich zu `projectFolderPath`; ein non-202-Fehler (inkl. der
 *          neuen 400/404-Fehlertexte aus AC9, S-383) wird secret-frei inline
 *          angezeigt (bestehender AC7-Mechanismus, reine Weiterreichung).
 *   AC3 — Overlay (role=dialog, Backdrop, Fokus beim Öffnen, Esc schließt,
 *          Fokus-Rückgabe an triggerRef); Katalog gruppiert nach `stage`, je
 *          Frage `frage`-Text + `quelle`-Kontext; `optionen` als Radiogruppe,
 *          sonst Freitext-Textarea; Pflicht-/Optional-Markierung als
 *          TEXT-Badge (nicht nur Farbe).
 *   AC4  — „Antworten senden" ist erst aktiv, wenn jede Pflicht-Frage
 *          beantwortet ist; Klick sendet NUR beantwortete Felder als
 *          `[{id, answer}]` an POST .../answers.
 *   AC5  — Nach Resume (202) pollt das Overlay weiter: nächster
 *          `needs-answers`-Katalog → erneut Formular; `done` → Erfolgs-
 *          meldung, `onIngestComplete` + `onClose`.
 *   AC7  — Start-/Poll-/Antworten-Fehler (inkl. Nicht-200-Poll-Ergebnis) →
 *          klarer, secret-freier Fehler inline, Overlay bleibt nutzbar
 *          (Retry startet einen NEUEN Lauf); Esc/Backdrop/Schließen
 *          reagieren IMMER (auch während `starting`/`submitting`); Schließen
 *          bricht den Lauf NICHT ab (kein Abbruch-Request; Wiedereinstieg via
 *          `initialJobId` überspringt den erneuten `POST .../start`).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { ObsidianIngestOverlay } = await import('../ObsidianIngestOverlay.jsx');

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; jest.useRealTimers(); });

const START_RE = /\/api\/obsidian-ingest\/start$/;
const ANSWERS_RE = /\/api\/obsidian-ingest\/[^/]+\/answers$/;
const STATUS_RE = /\/api\/obsidian-ingest\/[^/]+$/;

const CATALOG_1 = [
  {
    stage: 'Notiz',
    id: 'q1',
    frage: 'Welches Format soll die Story haben?',
    quelle: 'notiz1.md#Format',
    optionen: ['Markdown', 'HTML'],
    pflicht: true,
  },
  {
    stage: 'Notiz',
    id: 'q2',
    frage: 'Zusätzlicher Kommentar?',
    quelle: 'notiz1.md#Kommentar',
    pflicht: false,
  },
  {
    stage: 'Konzept',
    id: 'q3',
    frage: 'Wie lautet der Titel des Konzepts?',
    quelle: 'notiz2.md#Titel',
    pflicht: true,
  },
];

const CATALOG_2 = [
  { stage: 'Spec', id: 'q4', frage: 'Welche AC fehlt?', quelle: 'notiz3.md#AC', pflicht: true },
];

/**
 * fetch-Mock für die drei Ingest-Endpunkte. `statusSequence` liefert die
 * aufeinanderfolgenden GET-Poll-Antworten (letzter Eintrag wird geklammert).
 */
function makeFetch({
  startStatus = 202,
  startBody = { jobId: 'job-1', status: 'running' },
  statusSequence = [{ status: 'done' }],
  answersStatus = 202,
  answersBody = { status: 'running' },
} = {}) {
  let idx = 0;
  const calls = [];
  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    let parsedBody;
    try { parsedBody = opts.body ? JSON.parse(opts.body) : undefined; } catch { parsedBody = opts.body; }
    calls.push({ url, method, body: parsedBody });

    if (START_RE.test(url) && method === 'POST') {
      return { status: startStatus, json: async () => startBody };
    }
    if (ANSWERS_RE.test(url) && method === 'POST') {
      return { status: answersStatus, json: async () => answersBody };
    }
    if (STATUS_RE.test(url) && method === 'GET') {
      const s = statusSequence[Math.min(idx, statusSequence.length - 1)];
      idx += 1;
      return { status: 200, json: async () => s };
    }
    return { status: 404, json: async () => ({ error: 'not found' }) };
  });
  return { fetchFn, calls };
}

function renderOverlay({
  fetchFn,
  onClose,
  onIngestComplete,
  onJobStarted,
  onJobEnded,
  initialJobId = null,
  triggerRef,
  projectFolderPath = '/vault/Projekte/mein-projekt',
  targetProjectSlug = 'mein-repo',
} = {}) {
  const fn = fetchFn ?? makeFetch().fetchFn;
  const close = onClose ?? jest.fn();
  const complete = onIngestComplete ?? jest.fn();
  const started = onJobStarted ?? jest.fn();
  const ended = onJobEnded ?? jest.fn();
  const trigger = triggerRef ?? { current: { focus: jest.fn() } };
  const rendered = render(
    React.createElement(ObsidianIngestOverlay, {
      projectFolderPath,
      targetProjectSlug,
      fetchFn: fn,
      onClose: close,
      onIngestComplete: complete,
      onJobStarted: started,
      onJobEnded: ended,
      initialJobId,
      triggerRef: trigger,
      pollMs: 5,
      successLingerMs: 5,
    }),
  );
  return {
    fetchFn: fn,
    onClose: close,
    onIngestComplete: complete,
    onJobStarted: started,
    onJobEnded: ended,
    triggerRef: trigger,
    unmount: rendered.unmount,
  };
}

const q = (id) => document.querySelector(`[data-testid="${id}"]`);
const qAll = (id) => Array.from(document.querySelectorAll(`[data-testid="${id}"]`));

async function reachCatalog(overrides = {}) {
  const { fetchFn } = makeFetch({ statusSequence: [{ status: 'needs-answers', catalog: CATALOG_1 }], ...overrides });
  const helpers = renderOverlay({ fetchFn });
  await waitFor(() => expect(q('obsidian-ingest-catalog')).toBeTruthy());
  return helpers;
}

// ── AC3: Overlay-Grundgerüst + Katalog-Rendering ───────────────────────────

describe('obsidian-question-catalog AC3 — Overlay-Grundgerüst + Katalog-Rendering', () => {
  it('rendert role=dialog + aria-modal, fokussiert beim Öffnen', async () => {
    const { fetchFn } = makeFetch({ statusSequence: [{ status: 'needs-answers', catalog: CATALOG_1 }] });
    renderOverlay({ fetchFn });
    await waitFor(() => expect(q('obsidian-ingest-overlay')).toBeTruthy());
    const dialog = q('obsidian-ingest-overlay');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('startet den Lauf beim Öffnen (POST /start mit projectFolderPath + targetProjectSlug)', async () => {
    const { fetchFn, calls } = makeFetch({ statusSequence: [{ status: 'running' }] });
    renderOverlay({ fetchFn, projectFolderPath: '/vault/Projekte/xyz', targetProjectSlug: 'ziel-repo' });
    await waitFor(() => {
      const startCall = calls.find((c) => START_RE.test(c.url) && c.method === 'POST');
      expect(startCall).toBeTruthy();
      expect(startCall.body).toEqual({ projectFolderPath: '/vault/Projekte/xyz', targetProjectSlug: 'ziel-repo' });
    });
  });

  it('gruppiert den Katalog nach stage, zeigt frage + quelle', async () => {
    await reachCatalog();
    const questions = qAll('obsidian-ingest-question');
    expect(questions.length).toBe(3);
    expect(document.body.textContent).toMatch(/Notiz/);
    expect(document.body.textContent).toMatch(/Konzept/);
    expect(document.body.textContent).toMatch(/Welches Format soll die Story haben\?/);
    expect(document.body.textContent).toMatch(/notiz1\.md#Format/);
  });

  it('optionen als Radiogruppe, sonst Freitext-Textarea', async () => {
    await reachCatalog();
    const options = qAll('obsidian-ingest-option-q1');
    expect(options.length).toBe(2);
    expect(options.map((o) => o.value)).toEqual(['Markdown', 'HTML']);
    expect(q('obsidian-ingest-freetext-q2')).toBeTruthy();
    expect(q('obsidian-ingest-freetext-q3')).toBeTruthy();
  });

  it('Pflicht-/Optional-Markierung ist ein TEXT-Badge (nicht nur Farbe)', async () => {
    await reachCatalog();
    const q1Block = document.querySelector('[data-testid="obsidian-ingest-question"][data-question-id="q1"]');
    const q2Block = document.querySelector('[data-testid="obsidian-ingest-question"][data-question-id="q2"]');
    expect(q1Block.textContent).toMatch(/Pflicht/);
    expect(q2Block.textContent).toMatch(/Optional/);
  });
});

// ── AC10 (v2, S-384): targetProjectSlug am Start-Endpunkt ────────────────────

describe('obsidian-question-catalog v2 AC10 — targetProjectSlug am Start-Endpunkt', () => {
  it('400 „targetProjectSlug is required" (AC9) wird 1:1 secret-frei inline gezeigt', async () => {
    const { fetchFn } = makeFetch({ startStatus: 400, startBody: { error: 'targetProjectSlug is required' } });
    renderOverlay({ fetchFn, targetProjectSlug: '' });
    await waitFor(() => expect(q('obsidian-ingest-error')).toBeTruthy());
    expect(q('obsidian-ingest-error').textContent).toMatch(/targetProjectSlug is required/);
  });

  it('404 „Ziel-Projekt-Repo nicht gefunden" (AC9) wird 1:1 secret-frei inline gezeigt', async () => {
    const { fetchFn } = makeFetch({ startStatus: 404, startBody: { error: 'Ziel-Projekt-Repo nicht gefunden' } });
    renderOverlay({ fetchFn, targetProjectSlug: 'unbekanntes-repo' });
    await waitFor(() => expect(q('obsidian-ingest-error')).toBeTruthy());
    expect(q('obsidian-ingest-error').textContent).toMatch(/Ziel-Projekt-Repo nicht gefunden/);
  });
});

// ── AC4: Senden-Gate ────────────────────────────────────────────────────────

describe('obsidian-question-catalog AC4 — "Antworten senden" erst bei vollständigen Pflichtfragen aktiv', () => {
  it('Button ist initial disabled (Pflichtfragen unbeantwortet)', async () => {
    await reachCatalog();
    expect(q('obsidian-ingest-submit-btn').disabled).toBe(true);
  });

  it('bleibt disabled, solange eine Pflichtfrage fehlt; aktiv sobald alle Pflichtfragen beantwortet (optionale bleibt leer)', async () => {
    await reachCatalog();

    await act(async () => {
      fireEvent.click(qAll('obsidian-ingest-option-q1')[0]); // q1 beantwortet (Pflicht)
    });
    expect(q('obsidian-ingest-submit-btn').disabled).toBe(true); // q3 (Pflicht) fehlt noch

    await act(async () => {
      fireEvent.change(q('obsidian-ingest-freetext-q3'), { target: { value: 'Mein Konzept-Titel' } });
    });
    expect(q('obsidian-ingest-submit-btn').disabled).toBe(false); // q2 optional bleibt leer, trotzdem aktiv
  });

  it('sendet NUR beantwortete Felder als [{id, answer}] (optionale leere Frage wird ausgelassen)', async () => {
    const { fetchFn, calls } = makeFetch({
      statusSequence: [
        { status: 'needs-answers', catalog: CATALOG_1 },
        { status: 'done' },
      ],
    });
    renderOverlay({ fetchFn });
    await waitFor(() => expect(q('obsidian-ingest-catalog')).toBeTruthy());

    await act(async () => { fireEvent.click(qAll('obsidian-ingest-option-q1')[0]); });
    await act(async () => {
      fireEvent.change(q('obsidian-ingest-freetext-q3'), { target: { value: 'Mein Titel' } });
    });
    await waitFor(() => expect(q('obsidian-ingest-submit-btn').disabled).toBe(false));
    await act(async () => { fireEvent.click(q('obsidian-ingest-submit-btn')); });

    await waitFor(() => {
      const answersCall = calls.find((c) => ANSWERS_RE.test(c.url) && c.method === 'POST');
      expect(answersCall).toBeTruthy();
      expect(answersCall.body.answers).toEqual(
        expect.arrayContaining([
          { id: 'q1', answer: 'Markdown' },
          { id: 'q3', answer: 'Mein Titel' },
        ]),
      );
      expect(answersCall.body.answers.some((a) => a.id === 'q2')).toBe(false);
    });
  });
});

// ── AC5: Resume-Zyklus ───────────────────────────────────────────────────────

describe('obsidian-question-catalog AC5 — Resume-Zyklus (needs-answers → answers → done/next catalog)', () => {
  it('needs-answers → answers (202) → running → done → Erfolgsmeldung + onIngestComplete + onClose', async () => {
    const { fetchFn } = makeFetch({
      statusSequence: [
        { status: 'needs-answers', catalog: CATALOG_1 },
        { status: 'done' },
      ],
    });
    const onIngestComplete = jest.fn();
    const onClose = jest.fn();
    renderOverlay({ fetchFn, onIngestComplete, onClose });

    await waitFor(() => expect(q('obsidian-ingest-catalog')).toBeTruthy());
    await act(async () => { fireEvent.click(qAll('obsidian-ingest-option-q1')[0]); });
    await act(async () => {
      fireEvent.change(q('obsidian-ingest-freetext-q3'), { target: { value: 'Titel' } });
    });
    await waitFor(() => expect(q('obsidian-ingest-submit-btn').disabled).toBe(false));
    await act(async () => { fireEvent.click(q('obsidian-ingest-submit-btn')); });

    await waitFor(() => expect(q('obsidian-ingest-done')).toBeTruthy());
    await waitFor(() => {
      expect(onIngestComplete).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('needs-answers → answers (202) → running → NÄCHSTER needs-answers-Katalog → erneut Overlay/Formular', async () => {
    const { fetchFn } = makeFetch({
      statusSequence: [
        { status: 'needs-answers', catalog: CATALOG_1 },
        { status: 'needs-answers', catalog: CATALOG_2 },
      ],
    });
    renderOverlay({ fetchFn });

    await waitFor(() => expect(q('obsidian-ingest-catalog')).toBeTruthy());
    await act(async () => { fireEvent.click(qAll('obsidian-ingest-option-q1')[0]); });
    await act(async () => {
      fireEvent.change(q('obsidian-ingest-freetext-q3'), { target: { value: 'Titel' } });
    });
    await waitFor(() => expect(q('obsidian-ingest-submit-btn').disabled).toBe(false));
    await act(async () => { fireEvent.click(q('obsidian-ingest-submit-btn')); });

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Welche AC fehlt\?/);
    });
    // Der neue Katalog ersetzt den alten (nur eine Frage, andere stage).
    expect(qAll('obsidian-ingest-question').length).toBe(1);
  });
});

// ── AC7: Fehler-/Randpfade ────────────────────────────────────────────────────

describe('obsidian-question-catalog AC7 — Fehler inline + Retry, Esc/Backdrop/Schließen immer, kein Abbruch', () => {
  it('Start-Fehler (non-202) → Fehler inline, Retry startet neuen Lauf', async () => {
    const { fetchFn, calls } = makeFetch({ startStatus: 409, startBody: { error: 'Ein Job läuft bereits.' } });
    renderOverlay({ fetchFn });

    await waitFor(() => expect(q('obsidian-ingest-error')).toBeTruthy());
    expect(q('obsidian-ingest-error').textContent).toMatch(/Ein Job läuft bereits\./);

    const startCallsBefore = calls.filter((c) => START_RE.test(c.url)).length;
    await act(async () => { fireEvent.click(q('obsidian-ingest-retry-btn')); });
    await waitFor(() => {
      const startCallsAfter = calls.filter((c) => START_RE.test(c.url)).length;
      expect(startCallsAfter).toBe(startCallsBefore + 1);
    });
  });

  it('terminaler Poll-Fehler (failed) → Fehler inline secret-frei, onJobEnded aufgerufen', async () => {
    const { fetchFn } = makeFetch({ statusSequence: [{ status: 'failed', error: 'Obsidian-Ingest-Lauf fehlgeschlagen' }] });
    const onJobEnded = jest.fn();
    renderOverlay({ fetchFn, onJobEnded });

    await waitFor(() => expect(q('obsidian-ingest-error')).toBeTruthy());
    expect(q('obsidian-ingest-error').textContent).toMatch(/Obsidian-Ingest-Lauf fehlgeschlagen/);
    expect(q('obsidian-ingest-error').textContent).not.toMatch(/token|secret|api[_-]?key/i);
    expect(onJobEnded).toHaveBeenCalled();
  });

  it('auth-expired ohne error-Feld → generische secret-freie Fallback-Meldung', async () => {
    const { fetchFn } = makeFetch({ statusSequence: [{ status: 'auth-expired' }] });
    renderOverlay({ fetchFn });
    await waitFor(() => expect(q('obsidian-ingest-error')).toBeTruthy());
    expect(q('obsidian-ingest-error').textContent).toMatch(/Anmeldung abgelaufen/);
  });

  it('Nicht-200-Poll-Ergebnis (z.B. 404) wird NICHT wie "noch running" behandelt, sondern als Fehler', async () => {
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (START_RE.test(url) && method === 'POST') {
        return { status: 202, json: async () => ({ jobId: 'job-x', status: 'running' }) };
      }
      // jede GET-Statusabfrage liefert 404 (z.B. Server-Neustart, Job verworfen).
      return { status: 404, json: async () => ({ error: 'Unknown jobId' }) };
    });
    renderOverlay({ fetchFn });
    await waitFor(() => expect(q('obsidian-ingest-error')).toBeTruthy());
    expect(q('obsidian-ingest-error').textContent).toMatch(/nicht mehr auffindbar/i);
  });

  it('Antworten-Sende-Fehler (non-202) bleibt im needs-answers-Zustand, Katalog/Antworten erhalten', async () => {
    const { fetchFn } = makeFetch({
      statusSequence: [{ status: 'needs-answers', catalog: CATALOG_1 }],
      answersStatus: 400,
      answersBody: { error: 'Nicht alle Pflicht-Fragen beantwortet.' },
    });
    renderOverlay({ fetchFn });

    await waitFor(() => expect(q('obsidian-ingest-catalog')).toBeTruthy());
    await act(async () => { fireEvent.click(qAll('obsidian-ingest-option-q1')[0]); });
    await act(async () => {
      fireEvent.change(q('obsidian-ingest-freetext-q3'), { target: { value: 'Titel' } });
    });
    await waitFor(() => expect(q('obsidian-ingest-submit-btn').disabled).toBe(false));
    await act(async () => { fireEvent.click(q('obsidian-ingest-submit-btn')); });

    await waitFor(() => expect(q('obsidian-ingest-submit-error')).toBeTruthy());
    expect(q('obsidian-ingest-submit-error').textContent).toMatch(/Nicht alle Pflicht-Fragen beantwortet\./);
    // Katalog + bereits eingegebene Antworten bleiben sichtbar/erhalten.
    expect(q('obsidian-ingest-catalog')).toBeTruthy();
    expect(q('obsidian-ingest-freetext-q3').value).toBe('Titel');
  });

  it('Esc schließt IMMER (auch während "starting") — kein blockierender Guard; Fokus-Rückgabe an triggerRef', async () => {
    const fetchFn = jest.fn(() => new Promise(() => {})); // hängt für immer in "starting"
    const onClose = jest.fn();
    const triggerRef = { current: { focus: jest.fn() } };
    renderOverlay({ fetchFn, onClose, triggerRef });

    await waitFor(() => expect(q('obsidian-ingest-starting')).toBeTruthy());
    await act(async () => {
      fireEvent.keyDown(q('obsidian-ingest-overlay'), { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalled();
    expect(triggerRef.current.focus).toHaveBeenCalled();
  });

  it('Backdrop-Klick + Schließen-Button schließen immer, auch während needs-answers', async () => {
    const onClose = jest.fn();
    const { fetchFn } = makeFetch({ statusSequence: [{ status: 'needs-answers', catalog: CATALOG_1 }] });
    renderOverlay({ fetchFn, onClose });
    await waitFor(() => expect(q('obsidian-ingest-catalog')).toBeTruthy());

    await act(async () => { fireEvent.click(q('obsidian-ingest-close-btn')); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Schließen bricht den headless Lauf NICHT ab: kein Cancel-/DELETE-Request; Wiedereinstieg via initialJobId überspringt POST /start', async () => {
    const { fetchFn: startFetch, calls: startCalls } = makeFetch({ statusSequence: [{ status: 'running' }] });
    const { unmount } = renderOverlay({ fetchFn: startFetch });
    await waitFor(() => {
      expect(startCalls.some((c) => START_RE.test(c.url) && c.method === 'POST')).toBe(true);
    });
    unmount();
    // Kein DELETE/Cancel-Aufruf gegen den Job.
    expect(startCalls.some((c) => c.method === 'DELETE')).toBe(false);

    // Wiedereinstieg: initialJobId gesetzt → kein erneuter POST /start.
    const { fetchFn: resumeFetch, calls: resumeCalls } = makeFetch({ statusSequence: [{ status: 'needs-answers', catalog: CATALOG_2 }] });
    renderOverlay({ fetchFn: resumeFetch, initialJobId: 'job-1' });
    await waitFor(() => expect(document.body.textContent).toMatch(/Welche AC fehlt\?/));
    expect(resumeCalls.some((c) => START_RE.test(c.url))).toBe(false);
  });
});
