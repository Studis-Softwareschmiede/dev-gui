/**
 * IdeaSpecifyChatModal.jsx — Chat-Overlay über dem Board, um eine Idee
 * (`story.status === 'Idee'`) im Multi-Turn-Gespräch mit Claude zu schärfen
 * und am Ende automatisch ein Feature + eine `To Do`-Story anzulegen
 * (docs/specs/idea-specify-chat.md AC1, AC10, AC11, AC14 — v2 fire-and-forget).
 *
 * A11y-/Struktur-Muster aus `IdeaResolveModal.jsx` übernommen (Backdrop,
 * Fokus-Management beim Öffnen, `Esc` schließt, Fokus-Rückgabe an
 * `triggerRef`), aber statt Formularfeldern rendert dieses Modal eine
 * Chat-Bubble-Liste. Owner- und Claude-Turns sind NICHT nur über Farbe
 * unterscheidbar: jede Bubble trägt zusätzlich ein textuelles Label
 * ("Du"/"Claude") UND eine unterschiedliche Ausrichtung (Owner rechts,
 * Claude links) — siehe `_MessageBubble`.
 *
 * Dieses Modal ist reines Overlay (kein Tab-Wechsel-Code) — das Board bleibt
 * hinter dem Backdrop sichtbar. Die Verdrahtung (Trigger auf Idee-Karte +
 * „Spezifizieren"-Button in `BoardView.jsx`) ist NICHT Teil dieser Story
 * (S-218, Folge-Item) — dieses Modal definiert nur den Props-Vertrag, den
 * S-218 als Konsument verwendet.
 *
 * ── v2 (S-229) — Fire-and-forget + „Schließen reagiert immer" ─────────────
 * AC10/AC11/AC14 sind in v2 der Spec revidiert:
 *   - „Story anlegen" ist FIRE-AND-FORGET: sobald der Finalize-Start mit
 *     `202 { jobId }` bestätigt ist, schließt das Overlay SOFORT (`onClose`) —
 *     es wird im UI weder gewartet noch gepollt. Der frühere overlay-gebundene
 *     Status-Poll-`useEffect` (bis `status !== 'running'`) ist ENTFERNT; der
 *     Job läuft im Backend detached weiter (AC10).
 *   - „Schließen"(X), `Esc` und Backdrop-Klick rufen `onClose` IMMER auf —
 *     der frühere blockierende Guard (`if (sending || finalizeState === …)`)
 *     ist ENTFERNT (AC14). Ein noch laufender Chat-Send/Finalize-Start wird
 *     NICHT abgebrochen; ein nach Unmount auflaufender `message`-Fetch löst
 *     dank `mountedRef`-Guard KEINEN State-Update mehr aus (AC14).
 *   - Nur ein SYNCHRONER Fehlschlag des Finalize-STARTS (non-`202`: `409`
 *     Lock, `400` kein `readyToSpecify`, Netzwerkfehler) hält das Overlay
 *     offen + zeigt den Fehler inline + erlaubt Retry (AC11). Der Ausgang des
 *     bereits gestarteten (detachten) Jobs wird NICHT mehr im Overlay
 *     angezeigt — dafür der Board-Zustand (AC15/AC16, Watcher = S-230/AC17).
 *
 * ── Component-Props-Vertrag (verbindlich für S-218 als Konsument) ──────────
 * @param {{
 *   projectSlug: string,
 *   story: { id: string, title?: string, notes?: string },
 *   onClose: () => void,
 *   triggerRef?: React.RefObject,
 *   fetchFn?: Function,
 * }} props
 *
 * - `projectSlug` — Board-Projekt-Slug (für alle vier Endpunkte).
 * - `story` — die Idee (`id` Pflicht; `title`/`notes` nur für die Überschrift,
 *   der eigentliche Seed passiert serverseitig in `.../specify/start`).
 * - `onClose` — schließt das Overlay (Abbrechen, Esc, Backdrop-Klick, sowie
 *   fire-and-forget nach bestätigtem Finalize-Start `202`).
 * - `triggerRef` — optional; erhält beim Schließen (Esc/Abbrechen/202)
 *   den Fokus zurück (A11y, analog `IdeaResolveModal`).
 * - `fetchFn` — injectable `fetch` für Tests (default: `globalThis.fetch`).
 *
 * Hinweis: der bisherige `onSpecified(projectSlug)`-Prop entfällt in v2 — es
 *   gibt keinen overlay-gebundenen `done`-Zeitpunkt mehr, an dem das Modal ein
 *   Board-Re-Fetch anstoßen könnte. Das automatische Re-Fetch bei Job-Ende ist
 *   in die overlay-unabhängige Folge-Story S-230 (AC17,
 *   [[idea-specify-background-status]]) ausgelagert. Ein von einem Alt-Aufrufer
 *   weiterhin übergebener `onSpecified`-Prop wird ignoriert (React verwirft
 *   unbekannte Props einer Funktionskomponente).
 *
 * Covers (idea-specify-chat):
 *   AC1  — Chat-Overlay (Modal, Backdrop, Fokus beim Öffnen, Esc schließt,
 *          Fokus-Rückgabe an triggerRef, Bubble-Liste mit Owner-/
 *          Claude-Unterscheidung nicht nur über Farbe).
 *   AC10 — Fire-and-forget: „Story anlegen" setzt genau EIN
 *          POST .../specify/finalize ab; bei `202 { jobId }` schließt das
 *          Overlay SOFORT (`onClose`), OHNE Warten/Pollen. Kein Poll-Loop mehr.
 *   AC11 — Non-`202`-Finalize-Start (`409`/`400`/Netzwerkfehler) → Fehler
 *          inline, Overlay bleibt offen, Retry möglich; „Story anlegen" ohne
 *          `readyToSpecify` ist deaktiviert; ein Chat-Fehler (502) zeigt einen
 *          klaren, secret-freien Fehler, Overlay bleibt nutzbar.
 *   AC14 — „Schließen"(X)/`Esc`/Backdrop rufen `onClose` IMMER auf (kein
 *          blockierender Guard mehr), auch während `sending`/Finalize-Start;
 *          Fokus-Rückgabe an `triggerRef`; ein nach Unmount auflaufender
 *          `message`-Fetch löst dank `mountedRef`-Guard KEINEN State-Update aus.
 *   AC3/AC4/AC6 (Backend, hier nur als Client-Aufrufer) — nicht separat
 *          unit-getestet in dieser Datei (Backend-Contract-Tests leben in
 *          `test/ideaSpecifyRouter.test.js`); hier wird nur das
 *          Frontend-Verhalten gegen den dokumentierten Response-Shape geprüft.
 *   AC15/AC16 — by-design: das Overlay zeigt den Job-Ausgang nach dem
 *          fire-and-forget-Schließen NICHT mehr an; der durable Signalweg ist
 *          der Board-Zustand (kein overlay-seitiger Code hier). Das
 *          overlay-unabhängige Re-Fetch/der Status-Watcher ist S-230 (AC17).
 *          Nicht in dieser Datei unit-getestet (kein Overlay-Code).
 *   AC7 (idea-specify-chat, Status-Endpunkt) — der GET-Status-Poll entfällt
 *          im Overlay mit fire-and-forget; im Modal nicht mehr aufgerufen.
 *
 * Nicht-Ziele (spiegelt Spec):
 *   Kein Tab-Wechsel-Code, keine BoardView-Verdrahtung (S-218).
 *   Keine Anzeige von `draftText` (nicht von der Spec verlangt — nur Server-
 *   seitig relevant für den Finalize-Prompt).
 *   Keine overlay-interne Anzeige des Finalize-Ausgangs nach fire-and-forget
 *   (AC16 — Board-Zustand ist der Signalweg; Watcher = S-230).
 *
 * Security (Floor):
 *   - Kein `dangerouslySetInnerHTML` — Chat-Text wird als reiner React-Text
 *     gerendert (kein XSS über Claude- oder Owner-Text möglich).
 *   - Kein Secret/Token im Fehlertext — Fehlermeldungen kommen 1:1 vom
 *     bereits secret-freien Backend-Contract (`ideaSpecifyRouter.js`).
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export function IdeaSpecifyChatModal({
  projectSlug,
  story,
  onClose,
  triggerRef,
  fetchFn,
}) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);
  const storyId = story?.id;

  // ── Init (POST .../specify/start) ─────────────────────────────────────────
  const [initState, setInitState] = useState('loading'); // 'loading'|'ready'|'error'
  const [initError, setInitError] = useState('');
  const [sessionId, setSessionId] = useState(null);
  // Retry-Zähler: erhöht sich bei jedem "Erneut versuchen"-Klick und steht im
  // Dependency-Array des Init-Effects, damit der Retry den Fetch tatsächlich
  // neu auslöst (Review-Fix Iteration 2, Important 1).
  const [initRetryToken, setInitRetryToken] = useState(0);

  // ── Chat ───────────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState([]); // [{ role: 'owner'|'claude', text }]
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState('');
  const [readyToSpecify, setReadyToSpecify] = useState(false);
  const [draftText, setDraftText] = useState(undefined);

  // ── Finalize (v2 — fire-and-forget: nur der Start-Request, kein Poll-Loop) ─
  // 'idle'    — noch nicht abgeschickt / nach non-202-Fehler wieder bereit
  // 'submitting' — Finalize-Start-Request unterwegs (Button „Lege Story an…")
  // 'error'   — synchroner Start-Fehlschlag (non-202); Overlay bleibt offen
  const [finalizeState, setFinalizeState] = useState('idle');
  const [finalizeError, setFinalizeError] = useState('');

  const dialogRef = useRef(null);

  // AC14: ein nach dem Schließen/Unmount noch auflaufender in-flight-Fetch
  // (Chat-Send oder Finalize-Start) darf KEINEN State-Update auf der
  // unmounteten Komponente mehr auslösen. `mountedRef` wird beim Unmount auf
  // false gesetzt und vor jedem post-await-setState geprüft.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleClose = useCallback(() => {
    // AC14: „Schließen"(X)/Esc/Backdrop reagieren IMMER — der frühere
    // blockierende Guard (`if (sending || finalizeState === 'running') return;`)
    // ist bewusst entfernt (er ließ das Overlay bei laufendem Send/Finalize
    // still „aufgehängt" wirken). Ein in-flight Chat-Send oder ein bereits
    // gestarteter Finalize-Job wird NICHT abgebrochen — er läuft detached
    // weiter; der `mountedRef`-Guard verhindert nur State-Updates nach Unmount.
    onClose();
    if (triggerRef?.current) triggerRef.current.focus();
  }, [onClose, triggerRef]);

  // Fokus beim Öffnen; Esc schließt (analog IdeaResolveModal).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll('input, textarea, button:not([disabled])');
    if (focusable.length > 0) focusable[0].focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') handleClose();
    }
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // AC1/AC3: seedet die Session beim Öffnen (POST .../specify/start).
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setInitState('loading');
      setInitError('');
      let res;
      try {
        res = await fetch_(
          `/api/board/projects/${encodeURIComponent(projectSlug)}/ideas/${encodeURIComponent(storyId)}/specify/start`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
        );
      } catch {
        if (!cancelled) {
          setInitState('error');
          setInitError('Netzwerkfehler — bitte erneut versuchen.');
        }
        return;
      }
      if (cancelled) return;

      if (res.status === 201) {
        let data = {};
        try { data = await res.json(); } catch { /* ignore */ }
        setSessionId(data.sessionId);
        setMessages([{ role: 'claude', text: data.reply ?? '' }]);
        setInitState('ready');
        return;
      }

      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      setInitState('error');
      setInitError(data.message ?? data.error ?? `Chat konnte nicht gestartet werden (HTTP ${res.status}).`);
    }

    init();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug, storyId, initRetryToken]);

  async function handleSend() {
    const text = inputText.trim();
    if (!text || sending || !sessionId) return;

    setSending(true);
    setChatError('');
    setMessages((prev) => [...prev, { role: 'owner', text }]);
    setInputText('');

    let res;
    try {
      res = await fetch_(
        `/api/board/projects/${encodeURIComponent(projectSlug)}/ideas/${encodeURIComponent(storyId)}/specify/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, message: text }),
        },
      );
    } catch {
      if (!mountedRef.current) return; // AC14: kein State-Update nach Unmount
      setSending(false);
      setChatError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }

    if (res.status === 200) {
      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      if (!mountedRef.current) return; // AC14: kein State-Update nach Unmount
      setMessages((prev) => [...prev, { role: 'claude', text: data.reply ?? '' }]);
      setReadyToSpecify(Boolean(data.readyToSpecify));
      if (data.draftText !== undefined) setDraftText(data.draftText);
      setSending(false);
      return;
    }

    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!mountedRef.current) return; // AC14: kein State-Update nach Unmount
    setSending(false);
    setChatError(data.message ?? data.error ?? `Nachricht konnte nicht gesendet werden (HTTP ${res.status}).`);
  }

  // AC10 (v2 — fire-and-forget): genau EIN POST .../specify/finalize; bei
  // bestätigtem Start (`202 { jobId }`) schließt das Overlay SOFORT (`onClose`),
  // OHNE zu warten oder zu pollen — der Finalize-Kindprozess läuft im Backend
  // detached weiter. Nur ein SYNCHRONER Start-Fehlschlag (non-202: 409 Lock,
  // 400 kein readyToSpecify, Netzwerkfehler) hält das Overlay offen + zeigt den
  // Fehler inline + erlaubt Retry (AC11).
  async function handleFinalize() {
    if (!readyToSpecify || finalizeState === 'submitting' || !sessionId) return;

    setFinalizeState('submitting');
    setFinalizeError('');

    let res;
    try {
      res = await fetch_(
        `/api/board/projects/${encodeURIComponent(projectSlug)}/ideas/${encodeURIComponent(storyId)}/specify/finalize`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) },
      );
    } catch {
      if (!mountedRef.current) return; // AC14: kein State-Update nach Unmount
      setFinalizeState('error');
      setFinalizeError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      // Job bestätigt gestartet → fire-and-forget: Overlay sofort schließen.
      // Der `mountedRef`-Guard fängt den Fall ab, dass der Owner das Overlay
      // (X/Esc/Backdrop) bereits geschlossen hat, während der Start-Request
      // unterwegs war — dann kein doppeltes onClose.
      if (!mountedRef.current) return;
      handleClose();
      return;
    }

    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!mountedRef.current) return; // AC14: kein State-Update nach Unmount
    setFinalizeState('error');
    setFinalizeError(data.message ?? data.error ?? `Finalisierung konnte nicht gestartet werden (HTTP ${res.status}).`);
  }

  const titleId = 'idea-specify-chat-modal-title';
  const finalizeDisabled = !readyToSpecify || finalizeState === 'submitting' || initState !== 'ready';

  return (
    <>
      {/* Backdrop — Board bleibt dahinter sichtbar (AC1: kein Tab-Sprung, Overlay über dem Board). */}
      <div style={styles.backdrop} onClick={handleClose} aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={styles.dialog}
        data-testid="idea-specify-chat-modal"
      >
        <h2 id={titleId} style={styles.heading}>Idee spezifizieren</h2>
        {story?.title && <p style={styles.hint}>„{story.title}"</p>}

        {initState === 'loading' && (
          <p style={styles.hint} data-testid="idea-specify-init-loading">Chat wird gestartet…</p>
        )}

        {initState === 'error' && (
          <div role="alert" style={styles.error} data-testid="idea-specify-init-error">
            {initError}
            <div style={styles.buttonRow}>
              <button
                type="button"
                style={styles.btnSecondary}
                onClick={() => setInitRetryToken((t) => t + 1)}
                data-testid="idea-specify-init-retry-btn"
              >
                Erneut versuchen
              </button>
            </div>
          </div>
        )}

        {initState === 'ready' && (
          <>
            <div style={styles.messageList} data-testid="idea-specify-message-list">
              {messages.map((m, i) => (
                <_MessageBubble key={i} role={m.role} text={m.text} />
              ))}
            </div>

            {chatError && (
              <div role="alert" style={styles.error} data-testid="idea-specify-chat-error">
                {chatError}
              </div>
            )}

            {/* draftText wird NICHT angezeigt (nicht von der Spec verlangt — nur
                serverseitig für den Finalize-Prompt relevant); hier nur als
                verstecktes Element gehalten, damit der State (Story-Notes: state
                muss draftText tragen) nachvollziehbar/testbar bleibt. */}
            {draftText !== undefined && (
              <div data-testid="idea-specify-draft-text" style={styles.visuallyHidden}>{draftText}</div>
            )}

            <textarea
              style={styles.textarea}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              rows={3}
              placeholder="Antwort an Claude…"
              aria-label="Nachricht an Claude"
              disabled={sending}
              data-testid="idea-specify-input"
            />

            <div style={styles.buttonRow}>
              <button
                type="button"
                style={!inputText.trim() || sending ? styles.btnDisabled : styles.btnSecondary}
                disabled={!inputText.trim() || sending}
                onClick={handleSend}
                data-testid="idea-specify-send-btn"
              >
                {sending ? 'Sende…' : 'Senden'}
              </button>

              <button
                type="button"
                style={finalizeDisabled ? styles.btnDisabled : styles.btnPrimary}
                disabled={finalizeDisabled}
                aria-disabled={finalizeDisabled}
                onClick={handleFinalize}
                data-testid="idea-specify-finalize-btn"
              >
                {finalizeState === 'submitting' ? 'Lege Story an…' : 'Story anlegen'}
              </button>
            </div>

            {finalizeState === 'error' && (
              <div role="alert" style={styles.error} data-testid="idea-specify-finalize-error">
                {finalizeError}
              </div>
            )}
          </>
        )}

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleClose}
            data-testid="idea-specify-close-btn"
          >
            Schließen
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Eine einzelne Chat-Bubble. Owner-/Claude-Turns sind NICHT nur über Farbe
 * unterscheidbar: zusätzliches Text-Label ("Du"/"Claude") + unterschiedliche
 * Ausrichtung (Owner rechts, Claude links) — AC1.
 *
 * @param {{ role: 'owner'|'claude', text: string }} props
 */
function _MessageBubble({ role, text }) {
  const isOwner = role === 'owner';
  return (
    <div
      style={{ ...styles.bubbleRow, justifyContent: isOwner ? 'flex-end' : 'flex-start' }}
      data-testid="idea-specify-message"
      data-role={role}
    >
      <div style={isOwner ? styles.bubbleOwner : styles.bubbleClaude}>
        <span style={styles.bubbleLabel}>{isOwner ? 'Du' : 'Claude'}</span>
        <div style={styles.bubbleText}>{text}</div>
      </div>
    </div>
  );
}

// ── Styles (analog IdeaResolveModal.jsx) ──────────────────────────────────────

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    zIndex: 999,
  },

  dialog: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 1000,
    background: '#1a1a1a',
    border: '1px solid #374151',
    borderRadius: 10,
    padding: '24px 28px',
    minWidth: 420,
    maxWidth: 560,
    maxHeight: '85vh',
    overflowY: 'auto',
    color: '#e5e7eb',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex',
    flexDirection: 'column',
  },

  heading: {
    margin: '0 0 4px',
    fontSize: 18,
    fontWeight: 700,
    color: '#f0f9ff',
  },

  hint: {
    margin: '0 0 12px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },

  messageList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    marginBottom: 14,
    maxHeight: 320,
    overflowY: 'auto',
    padding: '4px 2px',
  },

  bubbleRow: {
    display: 'flex',
    width: '100%',
  },

  bubbleOwner: {
    maxWidth: '80%',
    background: '#1d4ed8',
    color: '#ffffff',
    borderRadius: '10px 10px 2px 10px',
    padding: '8px 12px',
  },

  bubbleClaude: {
    maxWidth: '80%',
    background: '#1e293b',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: '10px 10px 10px 2px',
    padding: '8px 12px',
  },

  bubbleLabel: {
    display: 'block',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    opacity: 0.75,
    marginBottom: 2,
  },

  bubbleText: {
    whiteSpace: 'pre-wrap',
    fontSize: 14,
    lineHeight: 1.45,
  },

  textarea: {
    width: '100%',
    minHeight: 64,
    background: '#111',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '8px 10px',
    marginBottom: 12,
    resize: 'vertical',
    fontFamily: 'system-ui, sans-serif',
    boxSizing: 'border-box',
  },

  error: {
    color: '#f87171',
    fontSize: 13,
    padding: '8px 10px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    marginBottom: 12,
  },

  buttonRow: {
    display: 'flex',
    gap: 10,
    justifyContent: 'flex-end',
    marginTop: 4,
  },

  btnPrimary: {
    minHeight: 44,
    padding: '10px 20px',
    background: '#1d4ed8',
    color: '#ffffff',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },

  btnSecondary: {
    minHeight: 44,
    padding: '10px 20px',
    background: '#1e293b',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },

  btnDisabled: {
    minHeight: 44,
    padding: '10px 20px',
    background: '#1e293b',
    color: '#4b5563',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'not-allowed',
  },

  visuallyHidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
  },
};
