/**
 * IdeaSpecifyChatModal.test.jsx — Tests für das Chat-Overlay
 * (docs/specs/idea-specify-chat.md AC1, AC10, AC11, AC14 — v2 fire-and-forget).
 *
 * Isoliert getestet (ohne BoardView — die Verdrahtung ist S-218, Folge-Item),
 * analog dem "IdeaCaptureModal (isoliert)"-Muster in IdeaCaptureModal.test.jsx.
 *
 * Covers (idea-specify-chat):
 *   AC1  — Chat-Overlay öffnet (role=dialog, aria-modal), seedet über
 *          POST .../specify/start, rendert die Bubble-Liste mit Owner-/
 *          Claude-Unterscheidung nicht nur über Farbe (data-role-Attribut +
 *          textuelles Label), Fokus beim Öffnen, Esc schließt + Fokus-
 *          Rückgabe an triggerRef.
 *   AC10 — Fire-and-forget: „Story anlegen" (nur bei readyToSpecify) setzt
 *          genau EIN POST .../specify/finalize ab; bei `202 { jobId }` schließt
 *          das Overlay SOFORT (onClose) + Fokus-Rückgabe an triggerRef, OHNE
 *          jeglichen Status-GET (kein Poll-Loop mehr).
 *   AC11 — „Story anlegen" ohne readyToSpecify ist disabled (Gate); ein
 *          SYNCHRONER Finalize-Start-Fehlschlag (non-202: 409 Lock, 400 kein
 *          readyToSpecify, Netzwerkfehler) erscheint inline, das Overlay bleibt
 *          offen (Modal weiterhin im DOM) + secret-frei, Retry ist möglich
 *          (Button wieder enabled); ein Chat-Sende-Fehler (502) zeigt einen
 *          secret-freien Fehler inline, Overlay bleibt nutzbar; der „Erneut
 *          versuchen"-Button nach fehlgeschlagenem .../specify/start löst
 *          tatsächlich einen neuen Request aus (Review-Fix Iteration 2).
 *   AC14 — „Schließen"(X)/Esc/Backdrop rufen onClose IMMER auf — auch während
 *          ein Chat-Send unterwegs ist (sending) oder ein Finalize-Start in
 *          flight ist (submitting); der frühere blockierende Guard ist
 *          entfernt. Fokus-Rückgabe an triggerRef. Ein nach dem Unmount noch
 *          auflaufender in-flight-Fetch (message/finalize) löst KEINEN
 *          State-Update und KEIN (doppeltes) onClose mehr aus (mountedRef-Guard).
 *
 * Covers (idea-specify-background-status, S-230):
 *   AC6  — Reopen-Inline-Status: beim Öffnen wird GET …/ideas/:id/specify/status
 *          abgefragt; running → Banner „läuft noch…" + „Story anlegen" deaktiviert
 *          (auch bei readyToSpecify); failed/auth-expired → Fehler-Banner + Retry
 *          über den normalen „Story anlegen"-Pfad; null/done → kein Banner,
 *          normaler Chat-Einstieg; Status-GET-Netzwerkfehler degradiert still.
 *
 *   Teilweise/nicht unit-testbar hier:
 *          - AC3/AC4/AC6 (Backend-Contract): Statuscodes, Validierung, Audit
 *            sind in `test/ideaSpecifyRouter.test.js` abgedeckt (S-215/S-216);
 *            diese Datei prüft nur, dass das Frontend die dokumentierten
 *            Response-Shapes korrekt konsumiert.
 *          - AC7 (idea-specify-chat, Status-Endpunkt): der GET-Status-Poll
 *            entfällt im Overlay mit fire-and-forget — im Modal nicht mehr
 *            aufgerufen (hier nur negativ geprüft: kein Status-GET nach 202).
 *          - AC15/AC16 (Ausgang via Board-Zustand): by-design KEIN Overlay-Code
 *            mehr — der durable Signalweg ist der Board-Zustand; das
 *            overlay-unabhängige Re-Fetch/der Status-Watcher ist S-230 (AC17).
 *            Kein Modal-Verhalten hier testbar.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { IdeaSpecifyChatModal } = await import('../IdeaSpecifyChatModal.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; jest.useRealTimers(); });

const START_RE = /\/specify\/start$/;
const MESSAGE_RE = /\/specify\/message$/;
const FINALIZE_RE = /\/specify\/finalize$/;
const FINALIZE_STATUS_RE = /\/specify\/finalize\/([^/]+)$/;
// idea-specify-background-status AC6 (S-230): Reopen-Status-GET (idea-keyed).
const STATUS_RE = /\/specify\/status$/;

/** Externally-resolvable promise, für in-flight-Fetch-Szenarien (AC14). */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Konfigurierbarer fetch-Mock für die drei im Overlay genutzten Endpunkte
 * (start/message/finalize). Der Finalize-Status-GET wird — anders als vor der
 * v2-Umstellung — NICHT mehr modelliert: das Overlay pollt nach dem
 * fire-and-forget-Schließen keinen Job-Status mehr (AC10).
 *
 * @param {object} opts
 * @param {number} [opts.startStatus=201]
 * @param {object} [opts.startBody]
 * @param {number} [opts.messageStatus=200]
 * @param {object} [opts.messageBody]
 * @param {number} [opts.finalizeStatus=202]
 * @param {object} [opts.finalizeBody]
 */
function makeFetchFn({
  startStatus = 201,
  startBody = { sessionId: 'sess-1', reply: 'Was soll die neue Story tun?' },
  messageStatus = 200,
  messageBody = { reply: 'Verstanden.', readyToSpecify: false },
  finalizeStatus = 202,
  finalizeBody = { jobId: 'job-1', status: 'running' },
  // idea-specify-background-status AC6 (S-230): letzter Finalize-Job dieser Idee,
  // den der Reopen-Status-GET liefert (null/done → normaler Chat-Einstieg).
  statusJob = null,
} = {}) {
  return jest.fn(async (url, opts) => {
    if (START_RE.test(url) && opts?.method === 'POST') {
      return { status: startStatus, json: async () => startBody };
    }
    if (MESSAGE_RE.test(url) && opts?.method === 'POST') {
      return { status: messageStatus, json: async () => messageBody };
    }
    if (FINALIZE_RE.test(url) && opts?.method === 'POST') {
      return { status: finalizeStatus, json: async () => finalizeBody };
    }
    // GET .../specify/status (AC6) — kein method (default GET).
    if (STATUS_RE.test(url) && (!opts || !opts.method || opts.method === 'GET')) {
      return { status: 200, json: async () => ({ job: statusJob }) };
    }
    return { status: 200, json: async () => ({}) };
  });
}

async function renderModal({ fetchFn, onClose, triggerRef } = {}) {
  const fn = fetchFn ?? makeFetchFn();
  globalThis.fetch = fn;
  const close = onClose ?? jest.fn();
  const trigger = triggerRef ?? { current: { focus: jest.fn() } };

  let result;
  await act(async () => {
    result = render(
      React.createElement(IdeaSpecifyChatModal, {
        projectSlug: 'my-project',
        story: { id: 'S-900', title: 'Eine rohe Idee', notes: 'ein paar Stichworte' },
        onClose: close,
        triggerRef: trigger,
        fetchFn: fn,
      }),
    );
  });

  return { fetchFn: fn, onClose: close, triggerRef: trigger, unmount: result.unmount };
}

async function waitForReady() {
  await waitFor(() => {
    expect(document.querySelector('[data-testid="idea-specify-message-list"]')).toBeTruthy();
  });
}

/** Treibt den Chat bis `readyToSpecify: true` (Finalize-Button enabled). */
async function makeReady(opts = {}) {
  const helpers = await renderModal(opts);
  await waitForReady();

  await act(async () => {
    fireEvent.change(document.querySelector('[data-testid="idea-specify-input"]'), {
      target: { value: 'Das ist alles.' },
    });
  });
  await act(async () => {
    fireEvent.click(document.querySelector('[data-testid="idea-specify-send-btn"]'));
  });
  await waitFor(() => {
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(false);
  });
  return helpers;
}

const READY_MSG = { reply: 'Alles klar.', readyToSpecify: true };

// ── AC1: Grundstruktur, Seed, Bubble-Unterscheidung ──────────────────────────

describe('IdeaSpecifyChatModal — AC1: Overlay-Grundstruktur', () => {
  it('renders as role=dialog with aria-modal=true', async () => {
    await renderModal();
    const modal = document.querySelector('[data-testid="idea-specify-chat-modal"]');
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
  });

  it('seeds the conversation via POST .../specify/start and renders the opening reply as a Claude bubble', async () => {
    const { fetchFn } = await renderModal();
    await waitForReady();

    const startCall = fetchFn.mock.calls.find((c) => START_RE.test(c[0]));
    expect(startCall).toBeTruthy();
    expect(startCall[1].method).toBe('POST');

    const bubbles = document.querySelectorAll('[data-testid="idea-specify-message"]');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].getAttribute('data-role')).toBe('claude');
    expect(bubbles[0].textContent).toMatch(/was soll die neue story tun/i);
  });

  it('owner and claude bubbles are distinguishable via data-role AND a textual label (not color alone)', async () => {
    const fetchFn = makeFetchFn({ messageBody: { reply: 'Danke.', readyToSpecify: false } });
    await renderModal({ fetchFn });
    await waitForReady();

    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-specify-input"]'), {
        target: { value: 'Es soll X tun.' },
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-send-btn"]'));
    });

    await waitFor(() => {
      const bubbles = document.querySelectorAll('[data-testid="idea-specify-message"]');
      expect(bubbles).toHaveLength(3); // Seed-Claude-Bubble + Owner-Turn + Claude-Antwort
    });

    const bubbles = document.querySelectorAll('[data-testid="idea-specify-message"]');
    expect(bubbles[0].getAttribute('data-role')).toBe('claude'); // Seed-Turn
    expect(bubbles[0].textContent).toMatch(/claude/i); // textual label
    expect(bubbles[1].getAttribute('data-role')).toBe('owner');
    expect(bubbles[1].textContent).toMatch(/du/i); // textual label
    expect(bubbles[2].getAttribute('data-role')).toBe('claude');
    expect(bubbles[2].textContent).toMatch(/claude/i);
  });
});

// ── AC1: Fokusführung ─────────────────────────────────────────────────────────

describe('IdeaSpecifyChatModal — AC1: Fokusführung (Esc + Fokus-Rückgabe)', () => {
  it('Escape closes the modal (onClose called)', async () => {
    const { onClose } = await renderModal();
    await waitForReady();

    await act(async () => {
      fireEvent.keyDown(document.querySelector('[data-testid="idea-specify-chat-modal"]'), { key: 'Escape' });
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('Escape returns focus to the triggerRef element', async () => {
    const triggerRef = { current: { focus: jest.fn() } };
    await renderModal({ triggerRef });
    await waitForReady();

    await act(async () => {
      fireEvent.keyDown(document.querySelector('[data-testid="idea-specify-chat-modal"]'), { key: 'Escape' });
    });

    expect(triggerRef.current.focus).toHaveBeenCalled();
  });

  it('clicking "Schließen" also calls onClose and returns focus to triggerRef', async () => {
    const triggerRef = { current: { focus: jest.fn() } };
    const { onClose } = await renderModal({ triggerRef });
    await waitForReady();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-close-btn"]'));
    });

    expect(onClose).toHaveBeenCalled();
    expect(triggerRef.current.focus).toHaveBeenCalled();
  });
});

// ── AC11: readyToSpecify-Gating ───────────────────────────────────────────────

describe('IdeaSpecifyChatModal — AC11: „Story anlegen" nur mit readyToSpecify', () => {
  it('"Story anlegen" is disabled while readyToSpecify is false', async () => {
    await renderModal();
    await waitForReady();

    const btn = document.querySelector('[data-testid="idea-specify-finalize-btn"]');
    expect(btn.disabled).toBe(true);
  });

  it('clicking the disabled "Story anlegen"-Button does not POST .../specify/finalize', async () => {
    const { fetchFn } = await renderModal();
    await waitForReady();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    const finalizeCalls = fetchFn.mock.calls.filter((c) => FINALIZE_RE.test(c[0]));
    expect(finalizeCalls).toHaveLength(0);
  });

  it('"Story anlegen" becomes enabled once the chat reports readyToSpecify: true', async () => {
    const fetchFn = makeFetchFn({ messageBody: { reply: 'Alles klar.', readyToSpecify: true, draftText: 'Fertige Anforderung.' } });
    await renderModal({ fetchFn });
    await waitForReady();

    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-specify-input"]'), {
        target: { value: 'Das ist alles.' },
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-send-btn"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(false);
    });
  });
});

// ── AC10: Fire-and-forget — 202 schließt das Overlay sofort, kein Poll ────────

describe('IdeaSpecifyChatModal — AC10: Fire-and-forget (202 → sofort onClose, kein Poll)', () => {
  it('a 202 finalize start immediately closes the overlay (onClose) and returns focus to triggerRef', async () => {
    const triggerRef = { current: { focus: jest.fn() } };
    const fetchFn = makeFetchFn({
      messageBody: READY_MSG,
      finalizeStatus: 202,
      finalizeBody: { jobId: 'job-1', status: 'running' },
    });
    const { onClose } = await makeReady({ fetchFn, triggerRef });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(triggerRef.current.focus).toHaveBeenCalled();
  });

  it('fires EXACTLY one POST .../specify/finalize and never polls the status endpoint (no Poll-Loop)', async () => {
    const fetchFn = makeFetchFn({
      messageBody: READY_MSG,
      finalizeStatus: 202,
      finalizeBody: { jobId: 'job-1', status: 'running' },
    });
    const { onClose } = await makeReady({ fetchFn });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });

    // Kurz warten, um sicherzugehen, dass KEIN nachgelagerter Status-Poll läuft.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

    const finalizePosts = fetchFn.mock.calls.filter(
      (c) => FINALIZE_RE.test(c[0]) && c[1]?.method === 'POST',
    );
    const statusGets = fetchFn.mock.calls.filter(
      (c) => FINALIZE_STATUS_RE.test(c[0]) && (!c[1] || !c[1].method),
    );
    expect(finalizePosts).toHaveLength(1);
    expect(statusGets).toHaveLength(0);
  });
});

// ── AC11: Finalize-START-Fehlerpfad (non-202) — inline, Overlay bleibt offen ──

describe('IdeaSpecifyChatModal — AC11: Finalize-Start-Fehlschlag (non-202) hält das Overlay offen', () => {
  it('a 409 lock response shows an inline error, keeps the modal open, and allows a retry (button re-enabled)', async () => {
    const fetchFn = makeFetchFn({
      messageBody: READY_MSG,
      finalizeStatus: 409,
      finalizeBody: { error: 'Finalizer läuft bereits für dieses Projekt.' },
    });
    const { onClose } = await makeReady({ fetchFn });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="idea-specify-finalize-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toMatch(/finalizer läuft bereits/i);
    });

    // Overlay bleibt offen — KEIN onClose (Fire-and-forget greift nur bei 202).
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="idea-specify-chat-modal"]')).toBeTruthy();
    // Retry möglich: Button wieder enabled (kein Dauer-Stuck-State).
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(false);
  });

  it('a 400 (no readyToSpecify) response shows an inline error and keeps the modal open, no secret/path leak', async () => {
    const fetchFn = makeFetchFn({
      messageBody: READY_MSG,
      finalizeStatus: 400,
      finalizeBody: { field: 'readyToSpecify', message: 'Die Idee ist noch nicht bereit zum Spezifizieren.' },
    });
    const { onClose } = await makeReady({ fetchFn });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="idea-specify-finalize-error"]');
      expect(err).toBeTruthy();
      expect(err.textContent).toMatch(/noch nicht bereit/i);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="idea-specify-finalize-error"]').textContent)
      .not.toMatch(/token|secret|\/Users\//i);
    expect(document.querySelector('[data-testid="idea-specify-chat-modal"]')).toBeTruthy();
  });

  it('a network failure on the finalize start shows an inline error and keeps the modal open + retryable', async () => {
    const fetchFn = jest.fn(async (url, opts) => {
      if (START_RE.test(url) && opts?.method === 'POST') {
        return { status: 201, json: async () => ({ sessionId: 'sess-1', reply: 'hi' }) };
      }
      if (MESSAGE_RE.test(url) && opts?.method === 'POST') {
        return { status: 200, json: async () => READY_MSG };
      }
      if (FINALIZE_RE.test(url) && opts?.method === 'POST') {
        throw new TypeError('Failed to fetch');
      }
      return { status: 200, json: async () => ({}) };
    });
    const { onClose } = await makeReady({ fetchFn });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="idea-specify-finalize-error"]');
      expect(err).toBeTruthy();
      expect(err.textContent).toMatch(/netzwerkfehler/i);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(false);
  });
});

// ── AC14: „Schließen" reagiert IMMER (auch während sending/submitting) ────────

describe('IdeaSpecifyChatModal — AC14: Schließen reagiert immer', () => {
  it('clicking "Schließen" WHILE a chat send is still in flight (sending) closes the overlay (onClose)', async () => {
    const msg = deferred();
    const fetchFn = jest.fn(async (url, opts) => {
      if (START_RE.test(url) && opts?.method === 'POST') {
        return { status: 201, json: async () => ({ sessionId: 'sess-1', reply: 'hi' }) };
      }
      if (MESSAGE_RE.test(url) && opts?.method === 'POST') {
        return msg.promise; // bleibt in flight → sending bleibt true
      }
      return { status: 200, json: async () => ({}) };
    });
    const { onClose, triggerRef } = await renderModal({ fetchFn });
    await waitForReady();

    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-specify-input"]'), {
        target: { value: 'Eine Nachricht.' },
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-send-btn"]'));
    });
    // Send ist in flight — der Button zeigt „Sende…" (sending === true).
    expect(document.querySelector('[data-testid="idea-specify-send-btn"]').textContent).toMatch(/sende/i);

    // Trotz laufendem Send MUSS „Schließen" reagieren (kein blockierender Guard).
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-close-btn"]'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(triggerRef.current.focus).toHaveBeenCalled();

    // Aufräumen: den in-flight-Send auflösen (Component ist noch gemountet).
    await act(async () => {
      msg.resolve({ status: 200, json: async () => ({ reply: 'ok', readyToSpecify: false }) });
    });
  });

  it('Escape closes the overlay WHILE a finalize start is still in flight (submitting)', async () => {
    const fin = deferred();
    const fetchFn = jest.fn(async (url, opts) => {
      if (START_RE.test(url) && opts?.method === 'POST') {
        return { status: 201, json: async () => ({ sessionId: 'sess-1', reply: 'hi' }) };
      }
      if (MESSAGE_RE.test(url) && opts?.method === 'POST') {
        return { status: 200, json: async () => READY_MSG };
      }
      if (FINALIZE_RE.test(url) && opts?.method === 'POST') {
        return fin.promise; // bleibt in flight → submitting bleibt true
      }
      return { status: 200, json: async () => ({}) };
    });
    const { onClose } = await makeReady({ fetchFn });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });
    // Finalize-Start in flight — der Button zeigt „Lege Story an…" (submitting).
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').textContent).toMatch(/lege story an/i);

    await act(async () => {
      fireEvent.keyDown(document.querySelector('[data-testid="idea-specify-chat-modal"]'), { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Aufräumen: den in-flight-Finalize-Start auflösen.
    await act(async () => {
      fin.resolve({ status: 202, json: async () => ({ jobId: 'job-1', status: 'running' }) });
    });
  });

  it('an in-flight finalize start that resolves AFTER unmount neither throws nor calls onClose (mountedRef guard)', async () => {
    const fin = deferred();
    const fetchFn = jest.fn(async (url, opts) => {
      if (START_RE.test(url) && opts?.method === 'POST') {
        return { status: 201, json: async () => ({ sessionId: 'sess-1', reply: 'hi' }) };
      }
      if (MESSAGE_RE.test(url) && opts?.method === 'POST') {
        return { status: 200, json: async () => READY_MSG };
      }
      if (FINALIZE_RE.test(url) && opts?.method === 'POST') {
        return fin.promise;
      }
      return { status: 200, json: async () => ({}) };
    });
    const { onClose, unmount } = await makeReady({ fetchFn });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    // Parent entfernt das Overlay, WÄHREND der Finalize-Start noch unterwegs ist.
    await act(async () => { unmount(); });

    // Jetzt kommt die 202 zurück — der mountedRef-Guard MUSS das
    // fire-and-forget-onClose unterdrücken (Component ist bereits unmounted).
    await act(async () => {
      fin.resolve({ status: 202, json: async () => ({ jobId: 'job-1', status: 'running' }) });
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});

// ── AC11: Chat-Fehlerpfad (claude -p 502) ────────────────────────────────────

describe('IdeaSpecifyChatModal — AC11: Chat-Sende-Fehler (claude -p 502) bleibt nutzbar', () => {
  it('a 502 on .../specify/message shows an inline chat error, keeps the modal open and usable', async () => {
    const fetchFn = makeFetchFn({ messageStatus: 502, messageBody: { error: 'claude -p unavailable or failed' } });
    await renderModal({ fetchFn });
    await waitForReady();

    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-specify-input"]'), {
        target: { value: 'Noch eine Nachricht.' },
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-send-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="idea-specify-chat-error"]');
      expect(err).toBeTruthy();
      expect(err.textContent).toMatch(/claude -p unavailable/i);
    });

    // Kein Secret/Pfad-Leak — nur der secret-freie Backend-Fehlertext.
    expect(document.querySelector('[data-testid="idea-specify-chat-error"]').textContent).not.toMatch(/token|secret|\/Users\//i);
    expect(document.querySelector('[data-testid="idea-specify-chat-modal"]')).toBeTruthy();

    // Der Input bleibt bedienbar für einen erneuten Versuch.
    expect(document.querySelector('[data-testid="idea-specify-send-btn"]').disabled).toBe(true); // leer nach vorherigem Send
    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-specify-input"]'), {
        target: { value: 'Retry.' },
      });
    });
    expect(document.querySelector('[data-testid="idea-specify-send-btn"]').disabled).toBe(false);
  });
});

// ── AC1: init-Fehlerpfad (POST .../specify/start schlägt fehl) ───────────────

describe('IdeaSpecifyChatModal — Init-Fehlerpfad (.../specify/start)', () => {
  it('a 502 on .../specify/start shows an inline error with a retry option, modal stays open', async () => {
    const fetchFn = makeFetchFn({ startStatus: 502, startBody: { error: 'claude -p unavailable or failed' } });
    await renderModal({ fetchFn });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="idea-specify-init-error"]')).toBeTruthy();
    });

    expect(document.querySelector('[data-testid="idea-specify-init-error"]').textContent).toMatch(/claude -p unavailable/i);
    expect(document.querySelector('[data-testid="idea-specify-init-retry-btn"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="idea-specify-chat-modal"]')).toBeTruthy();
  });

  it('clicking "Erneut versuchen" actually re-triggers POST .../specify/start (Review-Fix: retry was previously a no-op)', async () => {
    // Erster Call schlägt fehl (502), jeder weitere Call auf .../specify/start
    // gelingt (201) — so lässt sich beobachten, ob der Retry-Klick wirklich
    // einen NEUEN Fetch auslöst statt nur den State kosmetisch umzuschalten.
    let startCalls = 0;
    const fetchFn = jest.fn(async (url, opts) => {
      if (START_RE.test(url) && opts?.method === 'POST') {
        startCalls += 1;
        if (startCalls === 1) {
          return { status: 502, json: async () => ({ error: 'claude -p unavailable or failed' }) };
        }
        return { status: 201, json: async () => ({ sessionId: 'sess-retry', reply: 'Los geht' }) };
      }
      return { status: 200, json: async () => ({}) };
    });

    await renderModal({ fetchFn });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="idea-specify-init-error"]')).toBeTruthy();
    });
    expect(startCalls).toBe(1);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-init-retry-btn"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="idea-specify-message-list"]')).toBeTruthy();
    });

    // Der Retry hat tatsächlich einen zweiten Request ausgelöst, und dieser
    // ist erfolgreich in den 'ready'-State gemündet (kein Dauer-Stuck-State).
    expect(startCalls).toBe(2);
    expect(document.querySelector('[data-testid="idea-specify-init-error"]')).toBeFalsy();
    const bubbles = document.querySelectorAll('[data-testid="idea-specify-message"]');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].textContent).toMatch(/los geht/i);
  });
});

// ── AC6 (idea-specify-background-status, S-230): Reopen zeigt letzten Status inline ─

describe('IdeaSpecifyChatModal — AC6 (S-230): Reopen-Inline-Status', () => {
  it('fragt beim Öffnen GET …/specify/status ab', async () => {
    const { fetchFn } = await renderModal();
    await waitForReady();
    const statusCall = fetchFn.mock.calls.find(
      ([u, o]) => STATUS_RE.test(u) && (!o || !o.method || o.method === 'GET'),
    );
    expect(statusCall).toBeTruthy();
  });

  it('running-Job → Status-Banner „läuft noch…" UND „Story anlegen" deaktiviert (kein zweiter Lauf), auch bei readyToSpecify', async () => {
    const fetchFn = makeFetchFn({
      statusJob: { status: 'running', jobId: 'j1' },
      messageBody: READY_MSG,
    });
    await renderModal({ fetchFn });
    await waitForReady();

    await waitFor(() => {
      expect(document.querySelector('[data-testid="idea-specify-reopen-running"]')).toBeTruthy();
    });
    const banner = document.querySelector('[data-testid="idea-specify-reopen-running"]');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
    expect(banner.textContent).toMatch(/läuft noch/i);

    // Chat bis readyToSpecify treiben …
    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-specify-input"]'), {
        target: { value: 'fertig' },
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-send-btn"]'));
    });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="idea-specify-message"]').length).toBeGreaterThanOrEqual(3);
    });
    // … trotzdem bleibt „Story anlegen" wegen laufendem Job deaktiviert (AC6).
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(true);
  });

  it('failed-Job → Fehler-Banner + Retry über normalen „Story anlegen"-Pfad (nach Ready enabled, 202 schließt)', async () => {
    const fetchFn = makeFetchFn({
      statusJob: { status: 'failed', jobId: 'j1' },
      messageBody: READY_MSG,
    });
    const { onClose } = await makeReady({ fetchFn });

    const banner = document.querySelector('[data-testid="idea-specify-reopen-failed"]');
    expect(banner).toBeTruthy();
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toMatch(/fehlgeschlagen/i);

    // Retry ist möglich: „Story anlegen" ist bei failed NICHT gesperrt.
    const finalizeBtn = document.querySelector('[data-testid="idea-specify-finalize-btn"]');
    expect(finalizeBtn.disabled).toBe(false);

    await act(async () => { fireEvent.click(finalizeBtn); });
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
  });

  it('auth-expired-Job → derselbe Fehler-Banner', async () => {
    const fetchFn = makeFetchFn({ statusJob: { status: 'auth-expired', jobId: 'j1' } });
    await renderModal({ fetchFn });
    await waitForReady();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="idea-specify-reopen-failed"]')).toBeTruthy();
    });
  });

  it('null-Job → kein Banner, normaler Chat-Einstieg (Finalize nach Ready nutzbar)', async () => {
    const fetchFn = makeFetchFn({ statusJob: null, messageBody: READY_MSG });
    await makeReady({ fetchFn });
    expect(document.querySelector('[data-testid="idea-specify-reopen-running"]')).toBeNull();
    expect(document.querySelector('[data-testid="idea-specify-reopen-failed"]')).toBeNull();
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(false);
  });

  it('done-Job → kein Banner (normaler Chat-Einstieg, Finalize nicht gesperrt)', async () => {
    const fetchFn = makeFetchFn({ statusJob: { status: 'done', jobId: 'j1' }, messageBody: READY_MSG });
    await makeReady({ fetchFn });
    expect(document.querySelector('[data-testid="idea-specify-reopen-running"]')).toBeNull();
    expect(document.querySelector('[data-testid="idea-specify-reopen-failed"]')).toBeNull();
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(false);
  });

  it('Status-GET-Netzwerkfehler degradiert still (kein Banner, Chat nutzbar)', async () => {
    const fetchFn = jest.fn(async (url, opts) => {
      if (STATUS_RE.test(url) && (!opts || !opts.method || opts.method === 'GET')) {
        throw new Error('network');
      }
      if (START_RE.test(url)) {
        return { status: 201, json: async () => ({ sessionId: 'sess-1', reply: 'Los.' }) };
      }
      return { status: 200, json: async () => ({}) };
    });
    await renderModal({ fetchFn });
    await waitForReady();
    expect(document.querySelector('[data-testid="idea-specify-reopen-running"]')).toBeNull();
    expect(document.querySelector('[data-testid="idea-specify-reopen-failed"]')).toBeNull();
    expect(document.querySelector('[data-testid="idea-specify-message-list"]')).toBeTruthy();
  });
});
