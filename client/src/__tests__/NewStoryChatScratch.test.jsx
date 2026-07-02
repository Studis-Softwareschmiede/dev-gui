/**
 * NewStoryChatScratch.test.jsx — Tests für den „scratch"-Modus des
 * `IdeaSpecifyChatModal` (docs/specs/new-story-chat.md AC1, AC6, AC7).
 *
 * Der scratch-Modus ist die „from scratch"-Variante (ohne Idee-Karte): Start-
 * Feld statt Auto-Seed, Endpunkt-Basis `.../story-specify`, Finalize POLLT den
 * Job-Status bis Terminal (kein fire-and-forget wie der idea-Modus).
 *
 * Covers (new-story-chat):
 *   AC1 — „Neue Story" öffnet DASSELBE Overlay (scratch-Modus): role=dialog +
 *          aria-modal; zeigt ZUERST ein Start-Feld (Titel + optionale
 *          Stichworte) OHNE Auto-Start; Absenden POSTet
 *          `.../story-specify/start { initialText }` (Titel+Body verkettet) und
 *          startet den Chat (Claude-Bubble, data-role); Esc schließt + Fokus-
 *          Rückgabe an triggerRef.
 *   AC6 — Finalize pollt `GET .../finalize/:jobId`; bei `done` erscheint die
 *          Erfolgsmeldung, danach onSpecified(projectSlug) (Board-Re-Fetch) +
 *          onClose. Es wird tatsächlich der Status-Endpunkt abgefragt.
 *   AC7 — bei `failed`/`auth-expired` Fehler inline (secret-frei aus Backend-
 *          Contract), Overlay bleibt offen, Retry möglich (neuer Finalize-POST);
 *          „Story anlegen" ohne readyToSpecify ist deaktiviert; ein Chat-`502`
 *          zeigt einen secret-freien Fehler, Overlay bleibt nutzbar.
 *
 * Covers (story-specify-finalize-visibility, S-240):
 *   AC5 — no-op im scratch-Finalize-Poll hält das Overlay OFFEN (kein
 *          onSpecified/onClose, kein Erfolgs-Banner), zeigt einen inline-Fehler
 *          + Retry; no-op ohne error-Feld fällt auf eine fixe, secret-freie
 *          Meldung zurück. Reopen fragt den PROJEKT-keyed Status
 *          (GET .../story-specify/finalize) ab: running → Story-Erstellungs-
 *          Banner; no-op/failed → Fehler-Banner (secret-frei, kein job.error);
 *          null/done → kein Banner; Endpunkt-Fehler → still degradiert.
 *          (AC6 Board-Hinweis lebt in BoardView + BoardView.test.jsx.)
 *
 *   Teilweise/nicht hier unit-getestet:
 *          - AC2–AC5 (Backend-Contract: Statuscodes, Validierung, Audit, Lock,
 *            Job-Registry) leben in test/storySpecifyRouter.test.js /
 *            test/StorySpecifyFinalizer.test.js; hier nur der Client-Konsum der
 *            dokumentierten Response-Shapes.
 *          - Sidebar-Button-Ersatz („Änderung erfassen" → „Neue Story") +
 *            Modal-Verdrahtung: CockpitNewStory.test.jsx (AC1, CockpitView-Ebene).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { IdeaSpecifyChatModal } = await import('../IdeaSpecifyChatModal.jsx');

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; jest.useRealTimers(); });

const START_RE = /\/story-specify\/start$/;
const MESSAGE_RE = /\/story-specify\/message$/;
const FINALIZE_RE = /\/story-specify\/finalize$/;
const FINALIZE_STATUS_RE = /\/story-specify\/finalize\/[^/]+$/;

/**
 * fetch-Mock für die vier scratch-Endpunkte. `statusSequence` liefert die
 * aufeinanderfolgenden Poll-Antworten (letzter Eintrag wird geklammert).
 */
function makeScratchFetch({
  startStatus = 201,
  startBody = { sessionId: 'sess-1', reply: 'Worum soll die neue Story gehen?' },
  messageStatus = 200,
  messageBody = { reply: 'Verstanden.', readyToSpecify: false },
  finalizeStatus = 202,
  finalizeBody = { jobId: 'job-1', status: 'running' },
  statusSequence = [{ status: 'done' }],
  reopenJob = null, // GET .../story-specify/finalize (projekt-keyed Reopen, S-240)
} = {}) {
  let statusIdx = 0;
  return jest.fn(async (url, opts) => {
    if (FINALIZE_STATUS_RE.test(url) && (!opts || opts.method === undefined)) {
      const s = statusSequence[Math.min(statusIdx, statusSequence.length - 1)];
      statusIdx += 1;
      return { status: 200, json: async () => s };
    }
    if (START_RE.test(url) && opts?.method === 'POST') {
      return { status: startStatus, json: async () => startBody };
    }
    if (MESSAGE_RE.test(url) && opts?.method === 'POST') {
      return { status: messageStatus, json: async () => messageBody };
    }
    if (FINALIZE_RE.test(url) && opts?.method === 'POST') {
      return { status: finalizeStatus, json: async () => finalizeBody };
    }
    // GET .../story-specify/finalize (projekt-keyed Reopen-Status, S-240 AC5).
    if (FINALIZE_RE.test(url) && (!opts || opts.method === undefined)) {
      return { status: 200, json: async () => ({ job: reopenJob }) };
    }
    return { status: 200, json: async () => ({}) };
  });
}

function renderScratch({ fetchFn, onClose, onSpecified, triggerRef } = {}) {
  const fn = fetchFn ?? makeScratchFetch();
  globalThis.fetch = fn;
  const close = onClose ?? jest.fn();
  const specified = onSpecified ?? jest.fn();
  const trigger = triggerRef ?? { current: { focus: jest.fn() } };
  render(
    React.createElement(IdeaSpecifyChatModal, {
      mode: 'scratch',
      projectSlug: 'my-project',
      onClose: close,
      onSpecified: specified,
      triggerRef: trigger,
      fetchFn: fn,
      finalizePollMs: 5,
      successLingerMs: 5,
    }),
  );
  return { fetchFn: fn, onClose: close, onSpecified: specified, triggerRef: trigger };
}

const q = (id) => document.querySelector(`[data-testid="${id}"]`);

/** Öffnet das Overlay, füllt Titel, startet den Chat (bis Bubble-Liste da). */
async function startChat(helpers, { title = 'Export als CSV', body = '' } = {}) {
  await act(async () => {
    fireEvent.change(q('new-story-title-input'), { target: { value: title } });
    if (body) fireEvent.change(q('new-story-body-input'), { target: { value: body } });
  });
  await act(async () => { fireEvent.click(q('new-story-start-btn')); });
  await waitFor(() => expect(q('idea-specify-message-list')).toBeTruthy());
  return helpers;
}

/** Treibt den Chat bis readyToSpecify (Finalize-Button enabled). */
async function driveReady(fetchFn) {
  const helpers = renderScratch({ fetchFn });
  await startChat(helpers);
  await act(async () => {
    fireEvent.change(q('idea-specify-input'), { target: { value: 'Das ist alles.' } });
  });
  await act(async () => { fireEvent.click(q('idea-specify-send-btn')); });
  await waitFor(() => expect(q('idea-specify-finalize-btn').disabled).toBe(false));
  return helpers;
}

// ── AC1: Start-Feld + Seed + Chat ─────────────────────────────────────────────

describe('scratch — AC1: Start-Feld, kein Auto-Start, Seed über initialText', () => {
  it('renders as role=dialog with aria-modal and shows the start-field first (no auto start)', async () => {
    const { fetchFn } = renderScratch();
    const modal = q('idea-specify-chat-modal');
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(q('new-story-compose')).toBeTruthy();
    // kein /start bevor das Start-Feld abgesendet wurde
    expect(fetchFn.mock.calls.some((c) => START_RE.test(c[0]))).toBe(false);
  });

  it('start-button is disabled until a title is entered', async () => {
    renderScratch();
    expect(q('new-story-start-btn').disabled).toBe(true);
    await act(async () => {
      fireEvent.change(q('new-story-title-input'), { target: { value: 'X' } });
    });
    expect(q('new-story-start-btn').disabled).toBe(false);
  });

  it('submitting the start-field POSTs .../story-specify/start with initialText and renders the Claude opening bubble', async () => {
    const helpers = renderScratch();
    await startChat(helpers, { title: 'Export als CSV' });
    const startCall = helpers.fetchFn.mock.calls.find((c) => START_RE.test(c[0]));
    expect(startCall).toBeTruthy();
    expect(startCall[1].method).toBe('POST');
    expect(JSON.parse(startCall[1].body)).toEqual({ initialText: 'Export als CSV' });

    const bubbles = document.querySelectorAll('[data-testid="idea-specify-message"]');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].getAttribute('data-role')).toBe('claude');
  });

  it('combines title + optional keyword body into initialText', async () => {
    const helpers = renderScratch();
    await startChat(helpers, { title: 'Titel', body: 'Stichworte' });
    const startCall = helpers.fetchFn.mock.calls.find((c) => START_RE.test(c[0]));
    expect(JSON.parse(startCall[1].body)).toEqual({ initialText: 'Titel\n\nStichworte' });
  });

  it('Esc closes the overlay and returns focus to the trigger', async () => {
    const trigger = { current: { focus: jest.fn() } };
    const { onClose } = renderScratch({ triggerRef: trigger });
    await act(async () => {
      fireEvent.keyDown(q('idea-specify-chat-modal'), { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger.current.focus).toHaveBeenCalledTimes(1);
  });
});

// ── AC6: Finalize pollt bis done → Erfolg + onSpecified + Close ────────────────

describe('scratch — AC6: Finalize pollt bis done', () => {
  it('polls the status endpoint; on done shows success, then calls onSpecified + onClose', async () => {
    const fetchFn = makeScratchFetch({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      statusSequence: [{ status: 'running' }, { status: 'done' }],
    });
    const helpers = await driveReady(fetchFn);

    await act(async () => { fireEvent.click(q('idea-specify-finalize-btn')); });

    // Erfolgsmeldung erscheint (kurz), dann onSpecified + onClose (fire-and-forget-frei)
    await waitFor(() => expect(helpers.onSpecified).toHaveBeenCalledWith('my-project'));
    expect(helpers.onClose).toHaveBeenCalled();

    // Der Status-Endpunkt wurde tatsächlich gepollt (kein fire-and-forget).
    expect(fetchFn.mock.calls.some((c) => FINALIZE_STATUS_RE.test(c[0]))).toBe(true);
    // Genau EIN Finalize-Start-POST.
    const finalizePosts = fetchFn.mock.calls.filter((c) => FINALIZE_RE.test(c[0]) && c[1]?.method === 'POST');
    expect(finalizePosts).toHaveLength(1);
  });
});

// ── AC7: Fehler-/Randpfade ────────────────────────────────────────────────────

describe('scratch — AC7: Fehler-/Randpfade', () => {
  it('„Story anlegen" is disabled while readyToSpecify is false', async () => {
    const helpers = renderScratch();
    await startChat(helpers);
    // Noch keine Nachricht gesendet → readyToSpecify false → Finalize disabled.
    expect(q('idea-specify-finalize-btn').disabled).toBe(true);
  });

  it('a finalize job that ends failed shows an inline, secret-free error; overlay stays open; retry re-posts finalize', async () => {
    const fetchFn = makeScratchFetch({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      statusSequence: [{ status: 'failed', error: 'requirement-Agent abgebrochen.' }],
    });
    const helpers = await driveReady(fetchFn);

    await act(async () => { fireEvent.click(q('idea-specify-finalize-btn')); });

    await waitFor(() => expect(q('idea-specify-finalize-error')).toBeTruthy());
    expect(q('idea-specify-finalize-error').textContent).toMatch(/requirement-Agent abgebrochen/);
    // Overlay bleibt offen, kein Close.
    expect(helpers.onClose).not.toHaveBeenCalled();
    expect(q('idea-specify-chat-modal')).toBeTruthy();

    // Retry: Button wieder enabled → erneuter Finalize-POST.
    await waitFor(() => expect(q('idea-specify-finalize-btn').disabled).toBe(false));
    await act(async () => { fireEvent.click(q('idea-specify-finalize-btn')); });
    await waitFor(() => {
      const posts = fetchFn.mock.calls.filter((c) => FINALIZE_RE.test(c[0]) && c[1]?.method === 'POST');
      expect(posts.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('auth-expired terminal status surfaces an inline error, overlay stays usable', async () => {
    const fetchFn = makeScratchFetch({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      statusSequence: [{ status: 'auth-expired' }],
    });
    const helpers = await driveReady(fetchFn);

    await act(async () => { fireEvent.click(q('idea-specify-finalize-btn')); });

    await waitFor(() => expect(q('idea-specify-finalize-error')).toBeTruthy());
    expect(q('idea-specify-finalize-error').textContent).toMatch(/abgelaufen/i);
    expect(helpers.onClose).not.toHaveBeenCalled();
  });

  it('a chat message 502 shows a secret-free error inline and the overlay stays usable', async () => {
    const fetchFn = makeScratchFetch({
      messageStatus: 502,
      messageBody: { error: 'claude -p unavailable or failed' },
    });
    const helpers = renderScratch({ fetchFn });
    await startChat(helpers);

    await act(async () => {
      fireEvent.change(q('idea-specify-input'), { target: { value: 'Es soll X tun.' } });
    });
    await act(async () => { fireEvent.click(q('idea-specify-send-btn')); });

    await waitFor(() => expect(q('idea-specify-chat-error')).toBeTruthy());
    expect(q('idea-specify-chat-error').textContent).toMatch(/claude -p unavailable/);
    // Overlay weiter nutzbar: Eingabefeld vorhanden + wieder aktiv.
    expect(q('idea-specify-input')).toBeTruthy();
    expect(q('idea-specify-input').disabled).toBe(false);
  });

  it('a failed .../story-specify/start keeps the overlay usable and „Erneut versuchen" re-posts start', async () => {
    const fetchFn = makeScratchFetch({ startStatus: 502, startBody: { error: 'claude -p unavailable or failed' } });
    const helpers = renderScratch({ fetchFn });
    await act(async () => {
      fireEvent.change(q('new-story-title-input'), { target: { value: 'Export' } });
    });
    await act(async () => { fireEvent.click(q('new-story-start-btn')); });

    await waitFor(() => expect(q('idea-specify-init-error')).toBeTruthy());
    expect(q('idea-specify-init-error').textContent).toMatch(/claude -p unavailable/);

    await act(async () => { fireEvent.click(q('idea-specify-init-retry-btn')); });
    await waitFor(() => {
      const starts = helpers.fetchFn.mock.calls.filter((c) => START_RE.test(c[0]));
      expect(starts.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ── story-specify-finalize-visibility AC5 (S-240): no-op + Reopen-Hydration ────

const REOPEN_RE = /\/story-specify\/finalize$/; // GET (projekt-keyed) — kein jobId

describe('story-specify-finalize-visibility AC5 — no-op darf NICHT schließen', () => {
  it('a no-op terminal status keeps the overlay OPEN (no onSpecified/onClose), shows an inline error, retry possible', async () => {
    const fetchFn = makeScratchFetch({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      statusSequence: [{ status: 'running' }, { status: 'no-op', error: 'Der Lauf hat keine Story angelegt — bitte erneut versuchen.' }],
    });
    const helpers = await driveReady(fetchFn);

    await act(async () => { fireEvent.click(q('idea-specify-finalize-btn')); });

    // no-op → inline-Fehler, Overlay bleibt OFFEN, KEIN Erfolgs-/Schließ-Pfad.
    await waitFor(() => expect(q('idea-specify-finalize-error')).toBeTruthy());
    expect(q('idea-specify-finalize-error').textContent).toMatch(/keine Story angelegt/);
    expect(helpers.onSpecified).not.toHaveBeenCalled();
    expect(helpers.onClose).not.toHaveBeenCalled();
    expect(q('idea-specify-chat-modal')).toBeTruthy();
    // Kein Erfolgs-Banner (no-op ist KEIN done).
    expect(q('new-story-finalize-success')).toBeFalsy();

    // Retry: Button wieder enabled → erneuter Finalize-POST.
    await waitFor(() => expect(q('idea-specify-finalize-btn').disabled).toBe(false));
    await act(async () => { fireEvent.click(q('idea-specify-finalize-btn')); });
    await waitFor(() => {
      const posts = fetchFn.mock.calls.filter((c) => FINALIZE_RE.test(c[0]) && c[1]?.method === 'POST');
      expect(posts.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('a no-op without an error message falls back to a fixed, secret-free message', async () => {
    const fetchFn = makeScratchFetch({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      statusSequence: [{ status: 'no-op' }],
    });
    const helpers = await driveReady(fetchFn);
    await act(async () => { fireEvent.click(q('idea-specify-finalize-btn')); });
    await waitFor(() => expect(q('idea-specify-finalize-error')).toBeTruthy());
    expect(q('idea-specify-finalize-error').textContent).toMatch(/keine Story angelegt/);
    expect(helpers.onClose).not.toHaveBeenCalled();
  });
});

describe('story-specify-finalize-visibility AC5 — Reopen zieht projekt-keyed Status inline nach', () => {
  it('reopen with a running job shows the running banner AND fetches the projekt-keyed endpoint', async () => {
    const fetchFn = makeScratchFetch({ reopenJob: { status: 'running', jobId: 'job-9' } });
    renderScratch({ fetchFn });
    await waitFor(() => expect(q('idea-specify-reopen-running')).toBeTruthy());
    expect(q('idea-specify-reopen-running').textContent).toMatch(/Story-Erstellungs-Lauf läuft noch/);
    // Der PROJEKT-keyed Endpunkt (ohne jobId) wurde abgefragt.
    const reopenGets = fetchFn.mock.calls.filter(
      (c) => REOPEN_RE.test(c[0]) && (!c[1] || c[1].method === undefined),
    );
    expect(reopenGets.length).toBeGreaterThanOrEqual(1);
  });

  it('reopen with a no-op job shows the failed banner (retry-würdiger Fehlausgang)', async () => {
    const fetchFn = makeScratchFetch({ reopenJob: { status: 'no-op', jobId: 'job-8' } });
    renderScratch({ fetchFn });
    await waitFor(() => expect(q('idea-specify-reopen-failed')).toBeTruthy());
    expect(q('idea-specify-reopen-failed').textContent).toMatch(/Story-Erstellung ist fehlgeschlagen/);
    // Kein job.error gerendert (secret-frei — fixer Banner-Text).
    expect(q('idea-specify-reopen-failed').textContent).not.toMatch(/job-8/);
  });

  it('reopen with a failed job shows the failed banner', async () => {
    const fetchFn = makeScratchFetch({ reopenJob: { status: 'failed', jobId: 'job-7' } });
    renderScratch({ fetchFn });
    await waitFor(() => expect(q('idea-specify-reopen-failed')).toBeTruthy());
  });

  it('reopen with null/done shows NO banner (frischer Einstieg)', async () => {
    const fetchFn = makeScratchFetch({ reopenJob: null });
    renderScratch({ fetchFn });
    // Compose-Feld ist da; kein Reopen-Banner.
    await waitFor(() => expect(q('new-story-compose')).toBeTruthy());
    expect(q('idea-specify-reopen-running')).toBeFalsy();
    expect(q('idea-specify-reopen-failed')).toBeFalsy();
  });

  it('degrades silently when the reopen status endpoint errors (no banner, compose usable)', async () => {
    const fetchFn = jest.fn(async (url, opts) => {
      if (REOPEN_RE.test(url) && (!opts || opts.method === undefined)) {
        throw new Error('network');
      }
      return { status: 200, json: async () => ({}) };
    });
    renderScratch({ fetchFn });
    await waitFor(() => expect(q('new-story-compose')).toBeTruthy());
    expect(q('idea-specify-reopen-running')).toBeFalsy();
    expect(q('idea-specify-reopen-failed')).toBeFalsy();
  });
});
