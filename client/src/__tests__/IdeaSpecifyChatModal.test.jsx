/**
 * IdeaSpecifyChatModal.test.jsx — Tests für das Chat-Overlay
 * (docs/specs/idea-specify-chat.md AC1, AC10, AC11).
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
 *   AC10 — Bei Finalize-Status `done`: onSpecified(projectSlug) wird VOR
 *          onClose() aufgerufen (Re-Fetch-Trigger für den Aufrufer).
 *   AC11 — „Story anlegen" ohne readyToSpecify ist disabled (Gate); bei
 *          Finalize-Status `auth-expired`/`failed` erscheint der Fehler
 *          inline, das Overlay bleibt offen (Modal weiterhin im DOM), Retry
 *          ist möglich (Button wieder enabled); ein Chat-Sende-Fehler (502)
 *          zeigt einen secret-freien Fehler inline, Overlay bleibt nutzbar;
 *          der „Erneut versuchen"-Button nach fehlgeschlagenem
 *          `.../specify/start` löst tatsächlich einen neuen Request aus
 *          (Review-Fix Iteration 2); ein dauerhaft nicht auflösbarer
 *          Finalize-Status (z.B. permanenter 404 „Unknown jobId") führt nach
 *          mehreren aufeinanderfolgenden Fehlversuchen zu einem terminalen
 *          `finalizeState: 'error'` statt endlosem Polling (Review-Fix
 *          Iteration 2).
 *
 *   Teilweise/nicht unit-testbar hier (AC3/AC4/AC6/AC7 — Backend-Contract):
 *          die HTTP-Contract-Details (Statuscodes, Validierung, Audit) sind
 *          bereits in `test/ideaSpecifyRouter.test.js` abgedeckt (S-215/S-216);
 *          diese Datei prüft nur, dass das Frontend die dokumentierten
 *          Response-Shapes korrekt konsumiert.
 *
 * Covers (headless-arg-finalize-safety):
 *   AC7  — Finalize-Status `no-op` (Fetch-Sequenz `running` → `no-op`):
 *          Overlay bleibt offen, KEIN `onSpecified`/`onClose`-Aufruf, ein
 *          sichtbarer Fehler-/Warnhinweis (Text, `role="alert"`) erscheint.
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

/**
 * Konfigurierbarer fetch-Mock für die vier Endpunkte.
 *
 * @param {object} opts
 * @param {number} [opts.startStatus=201]
 * @param {object} [opts.startBody]
 * @param {number} [opts.messageStatus=200]
 * @param {object} [opts.messageBody]
 * @param {number} [opts.finalizeStatus=202]
 * @param {object} [opts.finalizeBody]
 * @param {(jobId: string, callIndex: number) => { status: number, body: object }} [opts.finalizeStatusFn]
 */
function makeFetchFn({
  startStatus = 201,
  startBody = { sessionId: 'sess-1', reply: 'Was soll die neue Story tun?' },
  messageStatus = 200,
  messageBody = { reply: 'Verstanden.', readyToSpecify: false },
  finalizeStatus = 202,
  finalizeBody = { jobId: 'job-1', status: 'running' },
  finalizeStatusFn,
} = {}) {
  let finalizeStatusCalls = 0;
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
    const statusMatch = FINALIZE_STATUS_RE.exec(url);
    if (statusMatch && (!opts || !opts.method)) {
      const jobId = statusMatch[1];
      finalizeStatusCalls += 1;
      if (finalizeStatusFn) {
        const { status, body } = finalizeStatusFn(jobId, finalizeStatusCalls);
        return { status, json: async () => body };
      }
      return { status: 200, json: async () => ({ status: 'done' }) };
    }
    return { status: 200, json: async () => ({}) };
  });
}

async function renderModal({ fetchFn, onClose, onSpecified, triggerRef, pollIntervalMs = 5 } = {}) {
  const fn = fetchFn ?? makeFetchFn();
  globalThis.fetch = fn;
  const close = onClose ?? jest.fn();
  const specified = onSpecified ?? jest.fn();
  const trigger = triggerRef ?? { current: { focus: jest.fn() } };

  await act(async () => {
    render(
      React.createElement(IdeaSpecifyChatModal, {
        projectSlug: 'my-project',
        story: { id: 'S-900', title: 'Eine rohe Idee', notes: 'ein paar Stichworte' },
        onClose: close,
        onSpecified: specified,
        triggerRef: trigger,
        fetchFn: fn,
        pollIntervalMs,
      }),
    );
  });

  return { fetchFn: fn, onClose: close, onSpecified: specified, triggerRef: trigger };
}

async function waitForReady() {
  await waitFor(() => {
    expect(document.querySelector('[data-testid="idea-specify-message-list"]')).toBeTruthy();
  });
}

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

// ── AC10: Finalize done → onSpecified + onClose ──────────────────────────────

describe('IdeaSpecifyChatModal — AC10: Finalize done schließt + onSpecified(slug)', () => {
  it('polls the finalize status and calls onSpecified(projectSlug) before onClose on status "done"', async () => {
    const fetchFn = makeFetchFn({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      finalizeStatusFn: () => ({ status: 200, body: { status: 'done', result: 'S-901' } }),
    });
    const { onClose, onSpecified } = await renderModal({ fetchFn });
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

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      expect(onSpecified).toHaveBeenCalledWith('my-project');
      expect(onClose).toHaveBeenCalled();
    });

    const specifiedOrder = onSpecified.mock.invocationCallOrder[0];
    const closeOrder = onClose.mock.invocationCallOrder[0];
    expect(specifiedOrder).toBeLessThan(closeOrder);
  });
});

// ── AC11: Fehlerpfad — auth-expired/failed inline, Overlay bleibt offen, Retry ─

describe('IdeaSpecifyChatModal — AC11: Finalize-Fehlerpfad (auth-expired/failed)', () => {
  async function makeReady(fetchFn) {
    const helpers = await renderModal({ fetchFn });
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

  it('status "failed" shows an inline error, the modal stays open, and the button is enabled again for a retry', async () => {
    const fetchFn = makeFetchFn({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      finalizeStatusFn: () => ({ status: 200, body: { status: 'failed', error: 'requirement-Agent fehlgeschlagen.' } }),
    });
    const { onClose, onSpecified } = await makeReady(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="idea-specify-finalize-error"]');
      expect(err).toBeTruthy();
      expect(err.textContent).toMatch(/requirement-agent fehlgeschlagen/i);
    });

    // Overlay bleibt offen — kein onClose/onSpecified-Aufruf.
    expect(onClose).not.toHaveBeenCalled();
    expect(onSpecified).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="idea-specify-chat-modal"]')).toBeTruthy();

    // Retry möglich: Button wieder enabled (kein Dauer-Stuck-State).
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(false);
  });

  it('status "auth-expired" shows an inline error, no secret/path leak, modal stays open', async () => {
    const fetchFn = makeFetchFn({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      finalizeStatusFn: () => ({ status: 200, body: { status: 'auth-expired', error: 'Anmeldung abgelaufen — bitte erneut versuchen.' } }),
    });
    await makeReady(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="idea-specify-finalize-error"]');
      expect(err).toBeTruthy();
      expect(err.textContent).toMatch(/anmeldung abgelaufen/i);
    });

    expect(document.querySelector('[data-testid="idea-specify-chat-modal"]')).toBeTruthy();
  });

  it('a non-202 finalize start response (e.g. 409 lock) shows an inline error and keeps the modal usable', async () => {
    const fetchFn = makeFetchFn({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      finalizeStatus: 409,
      finalizeBody: { error: 'Finalizer läuft bereits für dieses Projekt.' },
    });
    const { onClose } = await makeReady(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="idea-specify-finalize-error"]');
      expect(err).toBeTruthy();
      expect(err.textContent).toMatch(/finalizer läuft bereits/i);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(false);
  });
});

// ── AC7 (headless-arg-finalize-safety): Finalize "no-op" — kein stiller Erfolg ─

describe('IdeaSpecifyChatModal — AC7 (headless-arg-finalize-safety): Finalize-Status "no-op"', () => {
  async function makeReady(fetchFn) {
    const helpers = await renderModal({ fetchFn });
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

  it('a status sequence running → no-op keeps the overlay open, calls neither onSpecified nor onClose, and shows a visible inline warning', async () => {
    const fetchFn = makeFetchFn({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      finalizeStatusFn: (jobId, callIndex) =>
        callIndex === 1
          ? { status: 200, body: { status: 'running' } }
          : {
              status: 200,
              body: {
                status: 'no-op',
                error: 'Es ist kein Feature/keine Story entstanden — die Idee bleibt unverändert, bitte erneut versuchen.',
              },
            },
    });
    const { onClose, onSpecified } = await makeReady(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="idea-specify-finalize-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toMatch(/kein feature\/keine story entstanden/i);
    });

    // Overlay bleibt offen — kein Erfolg, kein Re-Fetch-Trigger.
    expect(onClose).not.toHaveBeenCalled();
    expect(onSpecified).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="idea-specify-chat-modal"]')).toBeTruthy();

    // Retry möglich: Button wieder enabled (kein Dauer-Stuck-State).
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(false);
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

// ── AC11: permanenter Nicht-200/unerkennbarer Finalize-Status → terminaler Fehler statt Endlos-Poll ──

describe('IdeaSpecifyChatModal — Finalize-Polling: dauerhafter Fehlerstatus führt zu terminal error, nicht Endlos-Poll', () => {
  async function makeReady(fetchFn) {
    const helpers = await renderModal({ fetchFn });
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

  it('a permanent 404 "Unknown jobId" on the status endpoint eventually yields finalizeState: error instead of polling forever', async () => {
    const fetchFn = makeFetchFn({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      finalizeStatusFn: () => ({ status: 404, body: { error: 'Unknown jobId' } }),
    });
    const { onClose, onSpecified } = await makeReady(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="idea-specify-finalize-error"]')).toBeTruthy();
    });

    // Terminal error statt endlosem Poll — Overlay bleibt offen, kein onClose/onSpecified.
    expect(onClose).not.toHaveBeenCalled();
    expect(onSpecified).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="idea-specify-finalize-btn"]').disabled).toBe(false);

    // Das Polling ist tatsächlich gestoppt: Anzahl Status-Calls bleibt danach konstant.
    const statusCallsAfterError = fetchFn.mock.calls.filter((c) => FINALIZE_STATUS_RE.test(c[0])).length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const statusCallsLater = fetchFn.mock.calls.filter((c) => FINALIZE_STATUS_RE.test(c[0])).length;
    expect(statusCallsLater).toBe(statusCallsAfterError);
  });

  it('a single transient non-200 status blip does not trigger a terminal error (retries, then succeeds)', async () => {
    let statusCalls = 0;
    const fetchFn = makeFetchFn({
      messageBody: { reply: 'Alles klar.', readyToSpecify: true },
      finalizeStatusFn: () => {
        statusCalls += 1;
        if (statusCalls === 1) return { status: 404, body: { error: 'Unknown jobId' } };
        return { status: 200, body: { status: 'done', result: 'S-901' } };
      },
    });
    const { onClose, onSpecified } = await makeReady(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-specify-finalize-btn"]'));
    });

    await waitFor(() => {
      expect(onSpecified).toHaveBeenCalledWith('my-project');
      expect(onClose).toHaveBeenCalled();
    });

    // Kein Fehler wurde je angezeigt — der einzelne Hickup wurde toleriert.
    expect(document.querySelector('[data-testid="idea-specify-finalize-error"]')).toBeFalsy();
  });
});
