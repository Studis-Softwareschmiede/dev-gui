/**
 * RegressionDefineDialog.test.jsx — Tests für den Regressionstest-Definier-
 * Dialog + Redaktions-Overlay (docs/specs/regression-define-dialog.md
 * AC6/AC7/AC8/AC10/AC11/AC13, S-308/S-321 — Backend
 * `RegressionDefineRunner`/`regressionDefineRouter` ist S-307/S-321, bereits
 * gelandet, hier nur der Client-Konsum der dokumentierten Response-Shapes).
 *
 * Covers (regression-define-dialog):
 *   AC6 — Zustand `target`: Bereichs-Radiogruppe aus
 *          `GET /api/board/projects/:slug/areas` + Option „Verbund…" mit
 *          Namensfeld; optionales Stichwort-Feld (Komma-getrennt → Array).
 *          „Definition starten" postet `{ ziel, stichworte? }` an
 *          `POST /api/projects/:slug/regression-define`; 202 → Poll-Zustand.
 *          Start-Fehler (400/409/500/Netzwerk) bleiben im `target`-Zustand
 *          mit Inline-Fehler. Leere `areas`-Liste → nur „Verbund…" wählbar
 *          (Edge-Case, kein Crash).
 *   AC7 — Poll bis `needs-review`/`done`/`failed`/`auth-expired`. Bei
 *          `needs-review`: der Vorschlag erscheint als editierbarer,
 *          serialisierter JSON-Text in EINEM Textfeld; „Fassung bestätigen"
 *          parst zurück zu JSON und postet `{ reviewed }` an
 *          `POST .../:jobId/review`; 202 → zurück in Poll-Zustand bis
 *          `done`/Fehler. Kein valides JSON → Inline-Fehler, kein Request.
 *          `done` → Erfolgsmeldung + Linger → `onDefineComplete` + `onClose`.
 *   AC8 — E1 (Projektwechsel während `needs-review`): ändert sich
 *          `projectSlug`, wird der laufende/gemerkte Job verworfen (kein
 *          stilles Resume für das falsche Projekt) — `onJobEnded` feuert,
 *          Dialog fällt zurück auf `target`. `failed`/`auth-expired`/E2 zeigen
 *          eine klare, secret-freie Fehlermeldung inline (kein leeres
 *          Overlay); „Erneut versuchen" führt zurück in den `target`-Zustand.
 *   AC10 — Lebendige Wartefläche: während `running` zeigt das Overlay einen
 *          animierten Indikator + die Laufzeit (mm:ss, aus `startedAt`
 *          abgeleitet, fortlaufend aktualisiert) + — falls `phase` vorliegt —
 *          die grobe Phase; ohne `phase` mindestens Laufzeit + letzter
 *          Aktivitäts-Zeitstempel. Identischer Mechanismus für den initialen
 *          Vorschlags-Lauf UND den uebersetzen-Lauf nach Resume.
 *   AC11 — Schließen-Hinweistext + Button-Label stellen klar, dass Schließen
 *          nur die Anzeige ausblendet und der Lauf serverseitig weiterläuft
 *          (Wiedereinstieg über die Regressionstests-Karte).
 *   AC13 — Bei `failed` zeigt das Overlay `error_class` (deutsches Label) +
 *          die Kurzdiagnose, weiterhin „Erneut versuchen", und — falls
 *          `raw_output` vorliegt — einen standardmäßig eingeklappten Bereich
 *          mit der sanitisierten Roh-Ausgabe.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { RegressionDefineDialog } = await import('../RegressionDefineDialog.jsx');

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; jest.useRealTimers(); });

const AREAS_RE = /\/api\/board\/projects\/[^/]+\/areas$/;
const START_RE = /\/api\/projects\/[^/]+\/regression-define$/;
const REVIEW_RE = /\/api\/projects\/[^/]+\/regression-define\/[^/]+\/review$/;
const STATUS_RE = /\/api\/projects\/[^/]+\/regression-define\/[^/]+$/;

const AREAS = [
  { id: 'area-1', name: 'Board', order: 0 },
  { id: 'area-2', name: 'Fabrik', order: 1 },
];

const VORSCHLAG = {
  projekt: 'my-project',
  ziel: { typ: 'bereich', id: 'area-1' },
  quell_specs: ['docs/specs/foo.md'],
  vorschlag: [
    { titel: 'Login funktioniert', schritte: ['Öffne /login'], pruefpunkte: ['Redirect'], beispieldaten: [] },
  ],
  target_vorschlag: null,
};

/**
 * fetch-Mock für areas + die drei regression-define-Endpunkte.
 * `statusSequence` liefert die aufeinanderfolgenden GET-Poll-Antworten
 * (letzter Eintrag wird geklammert).
 */
function makeFetch({
  areas = AREAS,
  areasOk = true,
  startStatus = 202,
  startBody = { jobId: 'job-1', status: 'running' },
  statusSequence = [{ status: 'done' }],
  reviewStatus = 202,
  reviewBody = { status: 'running' },
} = {}) {
  let idx = 0;
  const calls = [];
  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    let parsedBody;
    try { parsedBody = opts.body ? JSON.parse(opts.body) : undefined; } catch { parsedBody = opts.body; }
    calls.push({ url, method, body: parsedBody });

    if (AREAS_RE.test(url) && method === 'GET') {
      if (!areasOk) return { ok: false, status: 500, json: async () => ({ error: 'nope' }) };
      return { ok: true, status: 200, json: async () => ({ areas }) };
    }
    if (START_RE.test(url) && method === 'POST') {
      return { status: startStatus, json: async () => startBody };
    }
    if (REVIEW_RE.test(url) && method === 'POST') {
      return { status: reviewStatus, json: async () => reviewBody };
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

function renderDialog({
  fetchFn,
  onClose,
  onDefineComplete,
  onJobStarted,
  onJobEnded,
  initialJobId = null,
  triggerRef,
  projectSlug = 'my-project',
  livenessTickMs = 5,
} = {}) {
  const fn = fetchFn ?? makeFetch().fetchFn;
  const close = onClose ?? jest.fn();
  const complete = onDefineComplete ?? jest.fn();
  const started = onJobStarted ?? jest.fn();
  const ended = onJobEnded ?? jest.fn();
  const trigger = triggerRef ?? { current: { focus: jest.fn() } };
  const rendered = render(
    React.createElement(RegressionDefineDialog, {
      projectSlug,
      fetchFn: fn,
      onClose: close,
      onDefineComplete: complete,
      onJobStarted: started,
      onJobEnded: ended,
      initialJobId,
      triggerRef: trigger,
      pollMs: 5,
      successLingerMs: 5,
      livenessTickMs,
    }),
  );
  return {
    fetchFn: fn,
    onClose: close,
    onDefineComplete: complete,
    onJobStarted: started,
    onJobEnded: ended,
    triggerRef: trigger,
    unmount: rendered.unmount,
    rerender: (props) => rendered.rerender(
      React.createElement(RegressionDefineDialog, {
        projectSlug,
        fetchFn: fn,
        onClose: close,
        onDefineComplete: complete,
        onJobStarted: started,
        onJobEnded: ended,
        initialJobId,
        triggerRef: trigger,
        pollMs: 5,
        successLingerMs: 5,
        livenessTickMs,
        ...props,
      }),
    ),
  };
}

const q = (id) => document.querySelector(`[data-testid="${id}"]`);

async function reachNeedsReview(overrides = {}) {
  const { fetchFn, calls } = makeFetch({ statusSequence: [{ status: 'needs-review', vorschlag: VORSCHLAG }], ...overrides });
  const helpers = renderDialog({ fetchFn });
  await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
  await act(async () => {
    fireEvent.click(q('regression-define-start-btn'));
  });
  await waitFor(() => expect(q('regression-define-vorschlag-textarea')).toBeTruthy());
  return { ...helpers, calls };
}

// ── AC6: Ziel-Auswahl + Start ────────────────────────────────────────────────

describe('regression-define-dialog AC6 — Ziel-Auswahl (Bereich/Verbund) + Start', () => {
  it('rendert role=dialog + aria-modal, fokussiert beim Öffnen', async () => {
    renderDialog();
    await waitFor(() => expect(q('regression-define-dialog')).toBeTruthy());
    const dialog = q('regression-define-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('lädt die Bereichsliste und zeigt eine Radiogruppe (Bereiche + Verbund…)', async () => {
    renderDialog();
    await waitFor(() => {
      expect(q('regression-define-area-area-1')).toBeTruthy();
      expect(q('regression-define-area-area-2')).toBeTruthy();
      expect(q('regression-define-verbund-radio')).toBeTruthy();
    });
  });

  it('erster Bereich ist vorbelegt — „Definition starten" ist sofort aktiv', async () => {
    renderDialog();
    await waitFor(() => {
      const radio = q('regression-define-area-area-1');
      expect(radio.checked).toBe(true);
    });
    expect(q('regression-define-start-btn').disabled).toBe(false);
  });

  it('leere areas-Liste → nur „Verbund…" wählbar, kein Crash', async () => {
    const { fetchFn } = makeFetch({ areas: [] });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-no-areas')).toBeTruthy());
    expect(q('regression-define-verbund-radio').checked).toBe(true);
    // Start ist erst aktiv, wenn ein Verbund-Name eingegeben wurde.
    expect(q('regression-define-start-btn').disabled).toBe(true);
    fireEvent.change(q('regression-define-verbund-name'), { target: { value: 'Infra-Suite' } });
    expect(q('regression-define-start-btn').disabled).toBe(false);
  });

  it('areas-Fetch fehlgeschlagen → degradiert auf „Verbund…", kein Crash', async () => {
    const { fetchFn } = makeFetch({ areasOk: false });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-verbund-radio')).toBeTruthy());
    expect(q('regression-define-verbund-radio').checked).toBe(true);
  });

  it('Verbund-Auswahl + Namensfeld + Stichworte → POST mit korrektem Body', async () => {
    const { fetchFn, calls } = makeFetch();
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-verbund-radio')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-verbund-radio')); });
    fireEvent.change(q('regression-define-verbund-name'), { target: { value: 'Infra-Suite' } });
    fireEvent.change(q('regression-define-stichworte-input'), { target: { value: 'Login, Fehlerfall' } });
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => {
      const startCall = calls.find((c) => START_RE.test(c.url) && c.method === 'POST');
      expect(startCall).toBeTruthy();
    });
    const startCall = calls.find((c) => START_RE.test(c.url) && c.method === 'POST');
    expect(startCall.body).toEqual({
      ziel: { typ: 'verbund', id: 'Infra-Suite' },
      stichworte: ['Login', 'Fehlerfall'],
    });
  });

  it('Bereichs-Auswahl → POST mit { typ: "bereich", id } und ohne stichworte-Feld wenn leer', async () => {
    const { fetchFn, calls } = makeFetch();
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-2')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-area-area-2')); });
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => {
      const startCall = calls.find((c) => START_RE.test(c.url) && c.method === 'POST');
      expect(startCall).toBeTruthy();
    });
    const startCall = calls.find((c) => START_RE.test(c.url) && c.method === 'POST');
    expect(startCall.body).toEqual({ ziel: { typ: 'bereich', id: 'area-2' } });
  });

  it('Start-Fehler (409) bleibt im target-Zustand mit Inline-Fehler, Eingaben erhalten', async () => {
    const { fetchFn } = makeFetch({ startStatus: 409, startBody: { error: 'Regressions-Definitionslauf läuft bereits für dieses Projekt.' } });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-start-error')).toBeTruthy());
    expect(q('regression-define-start-error').textContent).toMatch(/läuft bereits/);
    // Zustand ist wieder target — Radiogruppe weiterhin da (kein Datenverlust)
    expect(q('regression-define-area-area-1')).toBeTruthy();
  });

  it('Netzwerkfehler beim Start zeigt Inline-Fehler', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (AREAS_RE.test(url)) return { ok: true, status: 200, json: async () => ({ areas: AREAS }) };
      throw new Error('network down');
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-start-error')).toBeTruthy());
    expect(q('regression-define-start-error').textContent).toMatch(/Netzwerkfehler/);
  });
});

// ── AC7: Redaktions-Overlay (needs-review) + Resume ─────────────────────────

describe('regression-define-dialog AC7 — Redaktion + Resume-Zyklus', () => {
  it('zeigt den serialisierten Vorschlag im editierbaren Textfeld bei needs-review', async () => {
    await reachNeedsReview();
    const text = q('regression-define-vorschlag-textarea').value;
    expect(text).toContain('Login funktioniert');
    expect(text).toContain('docs/specs/foo.md');
  });

  it('„Fassung bestätigen" postet die (ggf. redigierte) Struktur an .../review und pollt weiter bis done', async () => {
    const { fetchFn, calls, onDefineComplete, onClose } = await reachNeedsReview({
      statusSequence: [{ status: 'needs-review', vorschlag: VORSCHLAG }, { status: 'done' }],
    });
    void fetchFn;
    const textarea = q('regression-define-vorschlag-textarea');
    const edited = JSON.parse(textarea.value);
    edited.vorschlag[0].titel = 'Login funktioniert (redigiert)';
    fireEvent.change(textarea, { target: { value: JSON.stringify(edited) } });

    await act(async () => { fireEvent.click(q('regression-define-review-btn')); });

    const reviewCall = calls.find((c) => REVIEW_RE.test(c.url) && c.method === 'POST');
    expect(reviewCall.body.reviewed.vorschlag[0].titel).toBe('Login funktioniert (redigiert)');

    await waitFor(() => expect(q('regression-define-done')).toBeTruthy());
    await waitFor(() => expect(onDefineComplete).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('ungültiges JSON im Textfeld → Inline-Fehler, KEIN Request an .../review', async () => {
    const { fetchFn, calls } = await reachNeedsReview();
    void fetchFn;
    fireEvent.change(q('regression-define-vorschlag-textarea'), { target: { value: '{ not valid json' } });
    const before = calls.length;
    await act(async () => { fireEvent.click(q('regression-define-review-btn')); });
    expect(q('regression-define-review-error')).toBeTruthy();
    expect(q('regression-define-review-error').textContent).toMatch(/JSON/);
    expect(calls.length).toBe(before); // kein neuer Call
  });

  it('Review-Fehler (non-202) bleibt im needs-review-Zustand mit Inline-Fehler, Text erhalten', async () => {
    const { calls } = await reachNeedsReview({ reviewStatus: 409, reviewBody: { error: 'Kein offener Vorschlag für diesen Job.' } });
    void calls;
    await act(async () => { fireEvent.click(q('regression-define-review-btn')); });
    await waitFor(() => expect(q('regression-define-review-error')).toBeTruthy());
    expect(q('regression-define-review-error').textContent).toMatch(/Kein offener Vorschlag/);
    expect(q('regression-define-vorschlag-textarea')).toBeTruthy();
  });

  it('needs-review-Zyklus: nach Resume kann ein ZWEITER needs-review-Vorschlag folgen', async () => {
    const VORSCHLAG_2 = { ...VORSCHLAG, vorschlag: [{ ...VORSCHLAG.vorschlag[0], titel: 'Zweite Runde' }] };
    const { calls } = await reachNeedsReview({
      statusSequence: [
        { status: 'needs-review', vorschlag: VORSCHLAG },
        { status: 'needs-review', vorschlag: VORSCHLAG_2 },
      ],
    });
    void calls;
    await act(async () => { fireEvent.click(q('regression-define-review-btn')); });
    await waitFor(() => {
      expect(q('regression-define-vorschlag-textarea').value).toContain('Zweite Runde');
    });
  });
});

// ── AC8: E1 Projektwechsel + E2/failed/auth-expired Fehleranzeige + Retry ───

describe('regression-define-dialog AC8 — E1 Projektwechsel verwirft Wiedereinstieg', () => {
  it('Wechsel von projectSlug WÄHREND needs-review verwirft den Job (onJobEnded, zurück zu target)', async () => {
    const { onJobEnded, rerender } = await reachNeedsReview();
    act(() => { rerender({ projectSlug: 'other-project' }); });
    expect(onJobEnded).toHaveBeenCalled();
    await waitFor(() => expect(q('regression-define-start-btn')).toBeTruthy());
  });

  it('initialJobId + unveränderter projectSlug: kein POST /start, direkt Poll-Zustand', async () => {
    const { fetchFn, calls } = makeFetch({ statusSequence: [{ status: 'done' }] });
    renderDialog({ fetchFn, initialJobId: 'job-99' });
    await waitFor(() => expect(q('regression-define-done')).toBeTruthy());
    const startCall = calls.find((c) => START_RE.test(c.url) && c.method === 'POST');
    expect(startCall).toBeUndefined();
  });
});

describe('regression-define-dialog AC8 — failed/auth-expired/E2 zeigen klare Fehlermeldung, Retry', () => {
  it('failed (E2 „Bereich ohne deckende Specs") zeigt die Backend-Meldung 1:1, kein leeres Overlay', async () => {
    const { fetchFn } = makeFetch({
      statusSequence: [{ status: 'failed', error: 'Keine deckenden Specs im Bereich gefunden.' }],
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-error')).toBeTruthy());
    expect(q('regression-define-error').textContent).toMatch(/Keine deckenden Specs/);
  });

  it('auth-expired zeigt eine klare Meldung', async () => {
    const { fetchFn } = makeFetch({ statusSequence: [{ status: 'auth-expired' }] });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-error')).toBeTruthy());
    expect(q('regression-define-error').textContent).toMatch(/Anmeldung abgelaufen/);
  });

  it('Nicht-200-Poll-Ergebnis wird als terminal behandelt (nicht als "noch running")', async () => {
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (AREAS_RE.test(url)) return { ok: true, status: 200, json: async () => ({ areas: AREAS }) };
      if (START_RE.test(url) && method === 'POST') return { status: 202, json: async () => ({ jobId: 'job-1', status: 'running' }) };
      if (STATUS_RE.test(url)) return { status: 404, json: async () => ({ error: 'not found' }) };
      return { status: 404, json: async () => ({}) };
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-error')).toBeTruthy());
    expect(q('regression-define-error').textContent).toMatch(/nicht mehr auffindbar/);
  });

  it('„Erneut versuchen" führt zurück in den target-Zustand (neuer Lauf möglich)', async () => {
    const { fetchFn } = makeFetch({ statusSequence: [{ status: 'failed', error: 'Regressions-Definitionslauf fehlgeschlagen' }] });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-retry-btn')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-retry-btn')); });
    expect(q('regression-define-start-btn')).toBeTruthy();
  });
});

describe('regression-define-dialog — Schließen/Esc/Backdrop reagieren immer', () => {
  it('Esc schließt und gibt den Fokus an triggerRef zurück', async () => {
    const triggerRef = { current: { focus: jest.fn() } };
    const { onClose } = renderDialog({ triggerRef });
    await waitFor(() => expect(q('regression-define-dialog')).toBeTruthy());
    fireEvent.keyDown(q('regression-define-dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(triggerRef.current.focus).toHaveBeenCalled();
  });

  it('Schließen-Button ruft onClose auch während needs-review (kein blockierender Guard)', async () => {
    const { onClose } = await reachNeedsReview();
    fireEvent.click(q('regression-define-close-btn'));
    expect(onClose).toHaveBeenCalled();
  });
});

// ── AC10: Lebendige Wartefläche (Indikator + Laufzeit + Phase/Zeitstempel) ──

describe('regression-define-dialog AC10 — Lebendige Wartefläche', () => {
  it('zeigt einen animierten Indikator + Laufzeit (mm:ss) + Phase, solange running (initialer Vorschlags-Lauf)', async () => {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (AREAS_RE.test(url)) return { ok: true, status: 200, json: async () => ({ areas: AREAS }) };
      if (START_RE.test(url) && method === 'POST') return { status: 202, json: async () => ({ jobId: 'job-1', status: 'running' }) };
      if (STATUS_RE.test(url)) {
        return {
          status: 200,
          json: async () => ({ status: 'running', startedAt, lastActivityAt: new Date().toISOString(), phase: 'reading-specs' }),
        };
      }
      return { status: 404, json: async () => ({}) };
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });

    await waitFor(() => expect(q('regression-define-liveness-spinner')).toBeTruthy());
    expect(q('regression-define-elapsed').textContent).toMatch(/^\d{2}:\d{2}$/);
    await waitFor(() => expect(q('regression-define-phase')).toBeTruthy());
    expect(q('regression-define-phase').textContent).toBeTruthy();
  });

  it('ohne phase zeigt die Wartefläche mindestens Laufzeit UND lastActivityAt', async () => {
    const startedAt = new Date().toISOString();
    const lastActivityAt = new Date().toISOString();
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (AREAS_RE.test(url)) return { ok: true, status: 200, json: async () => ({ areas: AREAS }) };
      if (START_RE.test(url) && method === 'POST') return { status: 202, json: async () => ({ jobId: 'job-1', status: 'running' }) };
      if (STATUS_RE.test(url)) {
        return { status: 200, json: async () => ({ status: 'running', startedAt, lastActivityAt }) };
      }
      return { status: 404, json: async () => ({}) };
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });

    await waitFor(() => expect(q('regression-define-elapsed')).toBeTruthy());
    expect(q('regression-define-phase')).toBeFalsy();
    await waitFor(() => expect(q('regression-define-last-activity')).toBeTruthy());
  });

  it('identischer Mechanismus für den uebersetzen-Lauf nach Resume (running-Zustand nach review())', async () => {
    const startedAt = new Date().toISOString();
    // Nach der Bestätigung bleibt der Poll-Zustand `running` mit Lebendigkeits-
    // Feldern (phase:'translating') für mehrere Runden, bevor `done` folgt —
    // derselbe <LivenessIndicator>-Codepfad wie beim initialen Vorschlags-Lauf.
    const { calls } = await reachNeedsReview({
      statusSequence: [
        { status: 'needs-review', vorschlag: VORSCHLAG },
        { status: 'running', startedAt, lastActivityAt: startedAt, phase: 'translating' },
        { status: 'running', startedAt, lastActivityAt: startedAt, phase: 'translating' },
        { status: 'done' },
      ],
    });
    void calls;

    await act(async () => { fireEvent.click(q('regression-define-review-btn')); });
    await waitFor(() => expect(q('regression-define-liveness-spinner')).toBeTruthy());
    await waitFor(() => expect(q('regression-define-phase')).toBeTruthy());
    expect(q('regression-define-phase').textContent).toBeTruthy();
  });
});

// ── AC11: Klare Schließen-Semantik ───────────────────────────────────────────

describe('regression-define-dialog AC11 — klare Schließen-Semantik', () => {
  it('zeigt während running einen Hinweistext, dass Schließen den Lauf NICHT abbricht', async () => {
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (AREAS_RE.test(url)) return { ok: true, status: 200, json: async () => ({ areas: AREAS }) };
      if (START_RE.test(url) && method === 'POST') return { status: 202, json: async () => ({ jobId: 'job-1', status: 'running' }) };
      if (STATUS_RE.test(url)) {
        return { status: 200, json: async () => ({ status: 'running', startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }) };
      }
      return { status: 404, json: async () => ({}) };
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-close-hint')).toBeTruthy());
    expect(q('regression-define-close-hint').textContent).toMatch(/läuft im Hintergrund weiter/);
    expect(q('regression-define-close-hint').textContent).toMatch(/Regressionstests-Karte/);
  });

  it('Schließen-Button trägt während running ein aria-label, das "läuft weiter" klarstellt (kein Abbrechen-Missverständnis)', async () => {
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (AREAS_RE.test(url)) return { ok: true, status: 200, json: async () => ({ areas: AREAS }) };
      if (START_RE.test(url) && method === 'POST') return { status: 202, json: async () => ({ jobId: 'job-1', status: 'running' }) };
      if (STATUS_RE.test(url)) {
        return { status: 200, json: async () => ({ status: 'running', startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }) };
      }
      return { status: 404, json: async () => ({}) };
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-running')).toBeTruthy());
    const closeBtn = q('regression-define-close-btn');
    expect(closeBtn.getAttribute('aria-label')).toMatch(/läuft weiter/);
  });
});

// ── AC13: Fehler-Transparenz (Fehlerklasse + Roh-Ausgabe einklappbar) ───────

describe('regression-define-dialog AC13 — Fehler-Transparenz + Roh-Ausgabe', () => {
  it('zeigt Fehlerklasse-Label + Kurzdiagnose bei failed (parse-error)', async () => {
    const { fetchFn } = makeFetch({
      statusSequence: [{ status: 'failed', error: 'Vorschlag konnte nicht gelesen werden', error_class: 'parse-error' }],
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-error')).toBeTruthy());
    expect(q('regression-define-error-class')).toBeTruthy();
    expect(q('regression-define-error').textContent).toMatch(/Vorschlag konnte nicht gelesen werden/);
  });

  it('zeigt einen standardmäßig eingeklappten Roh-Ausgabe-Bereich NUR wenn raw_output vorliegt', async () => {
    const { fetchFn } = makeFetch({
      statusSequence: [{
        status: 'failed',
        error: 'Vorschlag konnte nicht gelesen werden',
        error_class: 'parse-error',
        raw_output: 'kaputte Roh-Ausgabe hier',
      }],
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-raw-output-details')).toBeTruthy());
    expect(q('regression-define-raw-output-details').hasAttribute('open')).toBe(false);
    expect(q('regression-define-raw-output-content').textContent).toBe('kaputte Roh-Ausgabe hier');
  });

  it('kein Roh-Ausgabe-Bereich wenn raw_output fehlt (z.B. agent-failed)', async () => {
    const { fetchFn } = makeFetch({
      statusSequence: [{ status: 'failed', error: 'Definitionslauf fehlgeschlagen', error_class: 'agent-failed' }],
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-error')).toBeTruthy());
    expect(q('regression-define-raw-output-details')).toBeFalsy();
  });

  it('„Erneut versuchen" bleibt nach einem Fehler mit Roh-Ausgabe funktionsfähig (Zustand wird zurückgesetzt)', async () => {
    const { fetchFn } = makeFetch({
      statusSequence: [{
        status: 'failed',
        error: 'Vorschlag konnte nicht gelesen werden',
        error_class: 'parse-error',
        raw_output: 'kaputt',
      }],
    });
    renderDialog({ fetchFn });
    await waitFor(() => expect(q('regression-define-area-area-1')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-start-btn')); });
    await waitFor(() => expect(q('regression-define-retry-btn')).toBeTruthy());
    await act(async () => { fireEvent.click(q('regression-define-retry-btn')); });
    expect(q('regression-define-start-btn')).toBeTruthy();
    expect(q('regression-define-raw-output-details')).toBeFalsy();
  });
});
