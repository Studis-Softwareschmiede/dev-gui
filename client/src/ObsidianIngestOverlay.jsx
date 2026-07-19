/**
 * ObsidianIngestOverlay.jsx — Fragenkatalog-Overlay für den headless Obsidian-
 * Ingest-Lauf (docs/specs/obsidian-question-catalog.md, UI-Anteile AC3/AC4/AC5/AC7
 * — Backend `ObsidianIngestRunner`/`obsidianIngestRouter` ist S-250, bereits
 * gelandet).
 *
 * A11y-/Struktur-Muster 1:1 aus `IdeaSpecifyChatModal.jsx` übernommen (Backdrop,
 * Fokus beim Öffnen, `Esc` schließt IMMER, Fokus-Rückgabe an `triggerRef`,
 * `mountedRef`-Guard gegen State-Updates nach Unmount, Retry-Token-Pattern
 * gegen den "Retry-Button löst useEffect nicht neu aus"-Fallstrick, expliziter
 * Nicht-200-Fehlerzweig im Poll-Loop statt stiller Endlos-"running"-Behandlung
 * — siehe .claude/lessons/coder.md 2026-07-01).
 *
 * ── Eigenständige, wiederverwendbare Komponente (Implementierungswahl) ──────
 * Diese Katalog-Variante ist als EIGENSTÄNDIGE Overlay-Komponente gebaut (statt
 * die bestehende `ObsidianImportSection` in GitHubView.jsx inline zu erweitern)
 * — analog zu `IdeaSpecifyChatModal`/`IdeaCaptureModal`: sie kapselt eine eigene,
 * mehrstufige State-Machine (start → poll → needs-answers ⇄ resume → done/error)
 * mit eigenem Prop-Vertrag, den ein Konsument (hier: GitHubView.jsx) andockt.
 * Eine reine Inline-Erweiterung der bereits recht großen `ObsidianImportSection`
 * hätte diese State-Machine mit der PTY-Trigger-Logik (obsidian-project-intake
 * AC3/AC5-AC7) vermischt — beide Pfade sind unabhängige Boundaries (eigener
 * Runner, eigenes Lock, eigener Endpunkt-Satz) und bleiben so klar getrennt.
 *
 * ── Primär-/Fallback-Entscheidung (Integration in GitHubView.jsx) ──────────
 * `docs/specs/obsidian-project-intake.md` AC3 beschreibt wörtlich den
 * bestehenden PTY-Trigger-Button ("„Auslösen" POSTet GENAU EINMAL … an
 * POST /api/command") — dieser Vertrag ist bereits gelandet + getestet
 * (`GitHubViewObsidianImport.test.jsx`) und wird von dieser Story NICHT
 * angetastet (kein Scope-Creep in eine fremde, bereits abgenommene AC).
 * `docs/specs/obsidian-question-catalog.md` selbst listet unter "Nicht-Ziele":
 * "Der Terminal-Handoff-Happy-Path (rein PTY, ohne strukturierten Katalog)
 * bleibt in [[obsidian-project-intake]]; diese Spec ist die richere, headless
 * Variante." — das bestätigt: beide Pfade bleiben NEBENEINANDER bestehen.
 * Entscheidung: In `ObsidianImportSection` wird ein ZWEITER, PRIMÄR gestylter
 * Button ("Strukturiert starten") ergänzt, der dieses Overlay öffnet — er ist
 * der empfohlene ("richere") Einstieg für die dritte Option, weil er Rückfragen
 * strukturiert statt nur als Terminal-Text zeigt. Der bestehende "Auslösen"-
 * Button (PTY, obsidian-project-intake AC3) bleibt als Fallback bestehen —
 * Logik/Verhalten UNVERÄNDERT (derselbe POST /api/command-Pfad, dieselben
 * Guards), nur visuell auf Sekundär-Button demotet (btnSecondary statt
 * btnPrimary), seit "Strukturiert starten" der primäre Einstieg ist (z.B.
 * für den Fall, dass der Owner den reinen Terminal-Stream bevorzugt oder der
 * PR #217-Vertrag noch nicht wie angenommen vorliegt, A1).
 *
 * ── Wiedereinstieg ohne neuen Backend-Endpunkt (AC7 "Wiedereinstieg möglich
 * solange Job läuft") ─────────────────────────────────────────────────────
 * Der Vertrag (`docs/specs/obsidian-question-catalog.md` §Verträge) hat KEINEN
 * projekt-keyed "letzter Job"-Endpunkt (anders als idea-specify-chat/
 * story-specify — bewusst außerhalb dieser Story's Scope, Backend ist S-250).
 * Damit ein Schließen+Wieder-Öffnen des Overlays trotzdem an denselben noch
 * laufenden Job andockt (statt einen zweiten `start()` zu versuchen, der wegen
 * des gehaltenen `ProjectJobLock` ohnehin `409` liefern würde), hält der
 * AUFRUFER (`ObsidianImportSection`) die zuletzt bekannte `jobId` ZUSAMMEN MIT
 * dem `projectFolderPath`, für den sie gestartet wurde (`ingestJob =
 * {jobId, projectFolderPath}`), und reicht `initialJobId` nur dann erneut
 * herein, wenn dieser Pfad noch dem aktuell gewählten Projekt entspricht
 * (Review-Fix Iteration 2, Important reviewer/R06 — ohne diese Kopplung
 * würde ein Auswahlwechsel auf ein ANDERES Projekt lautlos den alten Job
 * resumen statt einen neuen `start()` für das neu gewählte Projekt
 * auszulösen). Passt der Pfad, überspringt dieses Overlay den
 * `POST .../start` und pollt direkt weiter (kein neuer
 * Kindprozess, kein neuer Endpunkt, reine Client-State-Wiederverwendung).
 *
 * Covers (obsidian-question-catalog):
 *   AC10 — (v2, S-384) `POST .../obsidian-ingest/start` sendet `targetProjectSlug`
 *         zusätzlich zu `projectFolderPath` mit (reine Weiterreichung des vom
 *         Aufrufer bereits validiert ausgewählten Werts, kein eigenes
 *         Confinement hier — Server-seitige Auflösung/Validierung ist AC9,
 *         S-383, bereits gelandet). Ein non-202-Fehler (u.a. die neuen
 *         400/404-Texte aus AC9) wird 1:1 wie jeder andere Start-Fehler
 *         secret-frei inline gezeigt (bestehender AC7-Mechanismus, keine
 *         Sonderbehandlung nötig).
 *   AC3 — Overlay (Backdrop, Fokus beim Öffnen, `Esc` schließt, Fokus-Rückgabe
 *         an `triggerRef`), Katalog gruppiert nach `stage`, je Frage `frage`-
 *         Text + `quelle`-Kontext, `optionen` als Radiogruppe (sonst Freitext-
 *         Textarea); Pflicht-/Optional-Markierung als TEXT-Badge (nicht nur
 *         Farbe), aus dem `pflicht`-Feld des Katalogs (Default `true`).
 *   AC4  — „Antworten senden" ist erst aktiv, wenn jede Pflicht-Frage eine
 *         nicht-leere Antwort hat; Klick sendet `[{id, answer}]` (nur
 *         beantwortete Felder) an `POST .../obsidian-ingest/:jobId/answers`
 *         (Resume) und wechselt danach zurück in den Poll-Zustand.
 *   AC5  — Nach Resume pollt das Overlay `GET .../obsidian-ingest/:jobId`
 *         weiter: `needs-answers` → erneut Overlay mit dem NEUEN Katalog;
 *         `done` → Erfolgsmeldung, kurze Anzeigedauer (`successLingerMs`),
 *         dann `onIngestComplete` (Board-/`docs/`-Re-Fetch-Callback) +
 *         `onClose`.
 *   AC7  — `claude -p`-/Runner-Fehler (`failed`/`auth-expired`), ein nicht-
 *         parsbarer Katalog (kommt als `failed` vom Backend) sowie ein
 *         Netzwerk-/Start-Fehler zeigen einen klaren, secret-freien Fehler
 *         inline (Text 1:1 vom bereits secret-freien Backend-Contract);
 *         Overlay bleibt nutzbar, „Erneut versuchen" startet einen NEUEN Lauf
 *         (`retryToken`-Pattern, löst den `POST .../start`-Effect tatsächlich
 *         erneut aus — lessons 2026-07-01). Ein Antworten-Sende-Fehler
 *         (non-`202`) bleibt im `needs-answers`-Zustand (Katalog + bereits
 *         eingegebene Antworten bleiben erhalten) mit eigenem Inline-Fehler,
 *         kein Zustandswechsel. Schließen (X/`Esc`/Backdrop) reagiert in
 *         JEDEM Zustand sofort (kein blockierender Guard) und bricht den
 *         headless Lauf NICHT ab — er läuft detached weiter (Wiedereinstieg
 *         via `initialJobId`/`onJobStarted`, s.o.). Ein Nicht-200-Poll-Ergebnis
 *         (z.B. `404` nach Server-Neustart) wird explizit als Fehler behandelt,
 *         NICHT als "noch running" (lessons 2026-07-01).
 *
 * ── Component-Props-Vertrag ─────────────────────────────────────────────────
 * @param {{
 *   projectFolderPath: string,
 *   targetProjectSlug: string,
 *   onClose: () => void,
 *   triggerRef?: React.RefObject,
 *   fetchFn?: Function,
 *   initialJobId?: string|null,
 *   onJobStarted?: (jobId: string) => void,
 *   onJobEnded?: () => void,
 *   onIngestComplete?: () => void,
 *   pollMs?: number,
 *   successLingerMs?: number,
 * }} props
 *
 * - `projectFolderPath` — der vault-confined Projekt-Pfad (aus der bereits
 *   geladenen Liste in `ObsidianImportSection`, kein Freitext). Nur für einen
 *   FRISCHEN Start nötig (bei `initialJobId` wird kein `start()` aufgerufen).
 * - `targetProjectSlug` — das gewählte Ziel-Projekt-Repo (obsidian-question-
 *   catalog v2 AC9/AC10, S-384; aus der bereits geladenen Workspace-Repo-Liste
 *   in `ObsidianImportSection`, kein Freitext). Wird server-seitig via
 *   `resolveProjectSlug`/`validateProjectPath` aufgelöst und als `cwd` des
 *   Kindprozesses verwendet — ohne gültigen Wert antwortet der Server mit
 *   `400`/`404` (kein Runner-Start). Nur für einen FRISCHEN Start nötig.
 * - `onClose` — schließt das Overlay (X/`Esc`/Backdrop/nach `done`-Linger).
 *   Bricht den Lauf NICHT ab.
 * - `triggerRef` — optional; erhält beim Schließen den Fokus zurück (A11y).
 * - `fetchFn` — injectable `fetch` für Tests (default: `globalThis.fetch`).
 * - `initialJobId` — bekannte, noch laufende `jobId` (Wiedereinstieg, s.o.);
 *   `null`/`undefined` → frischer `POST .../start`-Lauf.
 * - `onJobStarted(jobId)` — nach erfolgreichem Start (Aufrufer merkt sich die
 *   `jobId` für einen künftigen Wiedereinstieg).
 * - `onJobEnded()` — bei terminalem Zustand (`done`/`failed`/`auth-expired`
 *   /nicht mehr auffindbar) — Aufrufer verwirft die gemerkte `jobId`.
 * - `onIngestComplete()` — bei `done` (Board-/`docs/`-Re-Fetch-Callback, AC5).
 * - `pollMs` — Poll-Intervall (default 2000; in Tests überschreibbar).
 * - `successLingerMs` — Anzeigedauer der Erfolgsmeldung vor dem Schließen
 *   (default 1200; in Tests überschreibbar).
 *
 * Security (Floor):
 *   - Kein `dangerouslySetInnerHTML` — Katalog-/Fehlertexte werden als reiner
 *     React-Text gerendert.
 *   - Kein Secret/Token/Host-Pfad im UI — Fehlertexte kommen 1:1 vom bereits
 *     secret-freien Backend-Contract (`obsidianIngestRouter.js`/
 *     `ObsidianIngestRunner.js`).
 *   - `projectFolderPath` wird NUR aus der vom Aufrufer bereits vault-
 *     confined geladenen Liste übernommen (kein Freitext-Feld in diesem
 *     Overlay).
 */

import { useState, useRef, useEffect, useCallback } from 'react';

/** Poll-Intervall (ms) für den Job-Status (überschreibbar via Prop `pollMs`). */
const OBSIDIAN_INGEST_POLL_MS = 2000;

/** Anzeigedauer der Erfolgsmeldung vor dem Schließen (überschreibbar). */
const OBSIDIAN_INGEST_SUCCESS_LINGER_MS = 1200;

export function ObsidianIngestOverlay({
  projectFolderPath,
  targetProjectSlug,
  onClose,
  triggerRef,
  fetchFn,
  initialJobId = null,
  onJobStarted,
  onJobEnded,
  onIngestComplete,
  pollMs = OBSIDIAN_INGEST_POLL_MS,
  successLingerMs = OBSIDIAN_INGEST_SUCCESS_LINGER_MS,
}) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);

  // 'starting' | 'running' | 'needs-answers' | 'submitting' | 'done' | 'error'
  const [phase, setPhase] = useState('starting');
  const [errorMsg, setErrorMsg] = useState('');
  const [catalog, setCatalog] = useState([]); // Array<{stage,id,frage,quelle,optionen?,pflicht}>
  const [answers, setAnswers] = useState({}); // { [id]: string }
  const [submitError, setSubmitError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  // Erhöht sich JEDES Mal, wenn ein neuer Poll-Loop-Durchlauf beginnen soll
  // (frischer Start, Wiedereinstieg, nach erfolgreichem Antworten-Resume).
  // Bewusst NICHT direkt an `phase` gekoppelt: ein `setInterval` mit sehr
  // kurzem `pollMs` (Tests) kann sonst VOR dem nächsten React-Re-Render (und
  // damit vor dem Effect-Cleanup) ein zweites Mal feuern und eine bereits
  // verarbeitete needs-answers/done-Antwort fälschlich ein zweites Mal
  // anwenden (Race, live per Test reproduziert) — der Poll-Effect stoppt sich
  // daher SELBST synchron via `stop()`, statt sich auf `phase` als Dependency
  // zu verlassen.
  const [pollGeneration, setPollGeneration] = useState(0);

  const jobIdRef = useRef(initialJobId ?? null);
  const dialogRef = useRef(null);

  // AC7: kein State-Update mehr nach Unmount (mirror IdeaSpecifyChatModal AC14).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleClose = useCallback(() => {
    // AC7: Schließen(X)/Esc/Backdrop reagieren IMMER — kein blockierender
    // Guard. Der Lauf wird NICHT abgebrochen (läuft detached weiter).
    onClose();
    if (triggerRef?.current) triggerRef.current.focus();
  }, [onClose, triggerRef]);

  // Fokus beim Öffnen; Esc schließt (analog IdeaSpecifyChatModal/IdeaResolveModal).
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

  // ── Start bzw. Wiedereinstieg (AC1 Aufrufer-seitig, AC7 Wiedereinstieg) ────
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (jobIdRef.current) {
        // Wiedereinstieg: bereits eine bekannte, laufende jobId — kein neuer
        // Start, direkt weiterpollen (AC7).
        if (!cancelled && mountedRef.current) {
          setPhase('running');
          setPollGeneration((g) => g + 1);
        }
        return;
      }

      setPhase('starting');
      setErrorMsg('');
      let res;
      try {
        res = await fetch_('/api/obsidian-ingest/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectFolderPath, targetProjectSlug }),
        });
      } catch {
        if (cancelled || !mountedRef.current) return;
        setPhase('error');
        setErrorMsg('Netzwerkfehler beim Starten — bitte erneut versuchen.');
        return;
      }
      if (cancelled || !mountedRef.current) return;

      if (res.status === 202) {
        let data = {};
        try { data = await res.json(); } catch { /* ignore */ }
        if (cancelled || !mountedRef.current) return;
        jobIdRef.current = data.jobId ?? null;
        if (!jobIdRef.current) {
          setPhase('error');
          setErrorMsg('Ingest-Lauf konnte nicht gestartet werden (keine jobId erhalten).');
          return;
        }
        onJobStarted?.(jobIdRef.current);
        setPhase('running');
        setPollGeneration((g) => g + 1);
        return;
      }

      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      if (cancelled || !mountedRef.current) return;
      setPhase('error');
      setErrorMsg(data.error ?? `Ingest-Lauf konnte nicht gestartet werden (HTTP ${res.status}).`);
    }

    boot();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryToken]);

  // ── Poll-Loop (AC5): running → needs-answers | done | failed/auth-expired ──
  // Läuft an, sobald `pollGeneration` sich erhöht (frischer Start,
  // Wiedereinstieg, nach erfolgreichem Antworten-Resume). Der Loop stoppt
  // sich SELBST synchron über `stop()` (lokale `stopped`-Flag + `clearInterval`
  // im selben Tick, in dem eine terminale/interrupt-Antwort verarbeitet wird)
  // — verlässt sich NICHT auf React's Re-Render/Effect-Cleanup-Timing, sonst
  // kann ein bereits laufender Interval-Tick bei sehr kurzem `pollMs` (Tests)
  // vor dem Cleanup nochmal feuern und dieselbe Antwort doppelt anwenden.
  useEffect(() => {
    if (pollGeneration === 0 || !jobIdRef.current) return;
    let stopped = false;
    let timer;

    function stop() {
      stopped = true;
      clearInterval(timer);
    }

    function terminalFailure(msg) {
      if (!mountedRef.current) return;
      jobIdRef.current = null; // Job ist terminal/verwaist — Retry startet neu.
      setPhase('error');
      setErrorMsg(msg);
      onJobEnded?.();
    }

    async function pollOnce() {
      if (stopped || !jobIdRef.current) return;
      let res;
      try {
        res = await fetch_(`/api/obsidian-ingest/${encodeURIComponent(jobIdRef.current)}`);
      } catch {
        return; // transienter Netzwerkfehler — nächste Runde erneut versuchen
      }
      if (stopped || !mountedRef.current) return;

      // lessons 2026-07-01: Nicht-200 NICHT wie "noch running" behandeln.
      if (res.status !== 200) {
        stop();
        terminalFailure('Ingest-Lauf nicht mehr auffindbar (evtl. Server-Neustart).');
        return;
      }

      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      if (stopped || !mountedRef.current) return;

      if (data.status === 'needs-answers') {
        stop();
        setCatalog(Array.isArray(data.catalog) ? data.catalog : []);
        setAnswers({});
        setSubmitError('');
        setPhase('needs-answers');
        return;
      }
      if (data.status === 'done') {
        stop();
        jobIdRef.current = null;
        setPhase('done');
        onJobEnded?.();
        return;
      }
      if (data.status === 'failed' || data.status === 'auth-expired') {
        stop();
        terminalFailure(
          data.error ??
            (data.status === 'auth-expired'
              ? 'Anmeldung abgelaufen — bitte erneut versuchen.'
              : 'Ingest-Lauf fehlgeschlagen — bitte erneut versuchen.'),
        );
        return;
      }
      // 'running' → weiterpollen.
    }

    pollOnce();
    timer = setInterval(pollOnce, pollMs);
    return () => { stopped = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollGeneration, pollMs]);

  // AC5 (done): kurze Erfolgsmeldung, dann Re-Fetch-Callback + Schließen.
  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(() => {
      if (!mountedRef.current) return;
      onIngestComplete?.();
      handleClose();
    }, successLingerMs);
    return () => clearTimeout(t);
  }, [phase, successLingerMs, onIngestComplete, handleClose]);

  // AC4: „Antworten senden" ist erst aktiv, wenn jede Pflicht-Frage
  // (`pflicht !== false`) eine nicht-leere Antwort hat.
  const canSubmit =
    phase === 'needs-answers' &&
    catalog.length > 0 &&
    catalog.every((q) => q.pflicht === false || (answers[q.id] ?? '').trim() !== '');

  const handleAnswerChange = useCallback((id, value) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }, []);

  // AC4/AC5: sendet nur beantwortete Felder als [{id, answer}], Resume via
  // POST .../answers; bei 202 zurück in den Poll-Zustand (AC5); ein
  // Sende-Fehler bleibt im needs-answers-Zustand (Katalog + Antworten
  // erhalten), Retry über denselben Button möglich (AC7).
  const handleSubmitAnswers = useCallback(async () => {
    if (!canSubmit || phase !== 'needs-answers') return;

    setPhase('submitting');
    setSubmitError('');

    const payload = catalog
      .map((q) => ({ id: q.id, answer: (answers[q.id] ?? '').trim() }))
      .filter((a) => a.answer !== '');

    let res;
    try {
      res = await fetch_(`/api/obsidian-ingest/${encodeURIComponent(jobIdRef.current)}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: payload }),
      });
    } catch {
      if (!mountedRef.current) return;
      setPhase('needs-answers');
      setSubmitError('Netzwerkfehler beim Senden — bitte erneut versuchen.');
      return;
    }
    if (!mountedRef.current) return;

    if (res.status === 202) {
      setPhase('running');
      setPollGeneration((g) => g + 1); // neuer Poll-Loop-Durchlauf (AC5).
      return;
    }

    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!mountedRef.current) return;
    setPhase('needs-answers');
    setSubmitError(data.error ?? `Antworten konnten nicht gesendet werden (HTTP ${res.status}).`);
  }, [canSubmit, phase, catalog, answers, fetch_]);

  const handleRetry = useCallback(() => {
    jobIdRef.current = null;
    setCatalog([]);
    setAnswers({});
    setSubmitError('');
    setRetryToken((t) => t + 1);
  }, []);

  const titleId = 'obsidian-ingest-overlay-title';
  const stages = groupByStage(catalog);

  return (
    <>
      {/* Backdrop — reagiert auf Klick immer (AC7, kein blockierender Guard). */}
      <div style={styles.backdrop} onClick={handleClose} aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={styles.dialog}
        data-testid="obsidian-ingest-overlay"
      >
        <h2 id={titleId} style={styles.heading}>Obsidian-Ingest — Fragenkatalog</h2>

        {phase === 'starting' && (
          <p role="status" aria-live="polite" style={styles.hint} data-testid="obsidian-ingest-starting">
            Ingest-Lauf wird gestartet…
          </p>
        )}

        {(phase === 'running') && (
          <p role="status" aria-live="polite" style={styles.hint} data-testid="obsidian-ingest-running">
            Notizen werden verarbeitet…
          </p>
        )}

        {phase === 'error' && (
          <div role="alert" style={styles.error} data-testid="obsidian-ingest-error">
            {errorMsg}
            <div style={styles.buttonRow}>
              <button
                type="button"
                style={styles.btnSecondary}
                onClick={handleRetry}
                data-testid="obsidian-ingest-retry-btn"
              >
                Erneut versuchen
              </button>
            </div>
          </div>
        )}

        {(phase === 'needs-answers' || phase === 'submitting') && (
          <>
            <p style={styles.hint}>
              Die Notizen enthalten offene Fragen — bitte gebündelt beantworten.
              Pflichtfragen sind markiert.
            </p>
            <div style={styles.stageList} data-testid="obsidian-ingest-catalog">
              {stages.map(({ stage, questions }) => (
                <section key={stage} style={styles.stageBlock} aria-labelledby={`stage-${slugify(stage)}`}>
                  <h3 id={`stage-${slugify(stage)}`} style={styles.stageHeading}>
                    {stage || 'Allgemein'}
                  </h3>
                  {questions.map((q) => (
                    <_QuestionField
                      key={q.id}
                      question={q}
                      value={answers[q.id] ?? ''}
                      onChange={(v) => handleAnswerChange(q.id, v)}
                      disabled={phase === 'submitting'}
                    />
                  ))}
                </section>
              ))}
            </div>

            {submitError && (
              <div role="alert" style={styles.error} data-testid="obsidian-ingest-submit-error">
                {submitError}
              </div>
            )}

            <div style={styles.buttonRow}>
              <button
                type="button"
                style={!canSubmit || phase === 'submitting' ? styles.btnDisabled : styles.btnPrimary}
                disabled={!canSubmit || phase === 'submitting'}
                aria-disabled={!canSubmit || phase === 'submitting'}
                onClick={handleSubmitAnswers}
                data-testid="obsidian-ingest-submit-btn"
              >
                {phase === 'submitting' ? 'Sende…' : 'Antworten senden'}
              </button>
            </div>
          </>
        )}

        {phase === 'done' && (
          <div role="status" aria-live="polite" style={styles.success} data-testid="obsidian-ingest-done">
            Ingest abgeschlossen ✓ — Board/Docs werden aktualisiert…
          </div>
        )}

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleClose}
            data-testid="obsidian-ingest-close-btn"
          >
            Schließen
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Gruppiert den Katalog nach `stage` (Reihenfolge = erstes Auftreten in `catalog`).
 * @param {Array<{stage:string}>} catalog
 * @returns {Array<{stage:string, questions:Array}>}
 */
function groupByStage(catalog) {
  const order = [];
  const map = new Map();
  for (const q of catalog) {
    const key = q.stage || 'Allgemein';
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key).push(q);
  }
  return order.map((stage) => ({ stage, questions: map.get(stage) }));
}

/** Grobe, ausschließlich für DOM-`id`-Erzeugung genutzte Slug-Funktion. */
function slugify(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'stage';
}

/**
 * Eine einzelne Katalog-Frage: `frage`-Text + `quelle`-Kontext + Pflicht-/
 * Optional-Badge (Text, nicht nur Farbe) + Auswahl (Radiogruppe bei `optionen`,
 * sonst Freitext-Textarea) — AC3.
 *
 * @param {{
 *   question: { stage:string, id:string, frage:string, quelle:string, optionen?:string[], pflicht:boolean },
 *   value: string,
 *   onChange: (value:string) => void,
 *   disabled?: boolean,
 * }} props
 */
function _QuestionField({ question, value, onChange, disabled }) {
  const required = question.pflicht !== false;
  const fieldId = `obsidian-ingest-q-${question.id}`;
  const hasOptions = Array.isArray(question.optionen) && question.optionen.length > 0;

  return (
    <div style={styles.questionBlock} data-testid="obsidian-ingest-question" data-question-id={question.id}>
      <div style={styles.questionHeader}>
        <span id={`${fieldId}-label`} style={styles.questionText}>{question.frage}</span>
        <span
          style={required ? styles.pflichtBadge : styles.optionalBadge}
          aria-label={required ? 'Pflichtfrage' : 'Optionale Frage'}
        >
          {required ? 'Pflicht' : 'Optional'}
        </span>
      </div>

      {question.quelle && (
        <p style={styles.questionSource}>{question.quelle}</p>
      )}

      {hasOptions ? (
        <div role="radiogroup" aria-labelledby={`${fieldId}-label`} style={styles.optionsGroup}>
          {question.optionen.map((opt, idx) => {
            const optId = `${fieldId}-opt-${idx}`;
            return (
              <label key={`${opt}-${idx}`} htmlFor={optId} style={styles.optionLabel}>
                <input
                  type="radio"
                  id={optId}
                  name={fieldId}
                  value={opt}
                  checked={value === opt}
                  disabled={disabled}
                  onChange={() => onChange(opt)}
                  data-testid={`obsidian-ingest-option-${question.id}`}
                />
                {' '}{opt}
              </label>
            );
          })}
        </div>
      ) : (
        <textarea
          id={fieldId}
          style={styles.textarea}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          aria-labelledby={`${fieldId}-label`}
          data-testid={`obsidian-ingest-freetext-${question.id}`}
        />
      )}
    </div>
  );
}

// ── Styles (analog IdeaSpecifyChatModal.jsx) ──────────────────────────────────

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
    minWidth: 460,
    maxWidth: 620,
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
  stageList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    marginBottom: 14,
  },
  stageBlock: {
    border: '1px solid #334155',
    borderRadius: 8,
    padding: '10px 12px',
  },
  stageHeading: {
    margin: '0 0 8px',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: '#93c5fd',
  },
  questionBlock: {
    marginBottom: 14,
  },
  questionHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  questionText: {
    fontSize: 14,
    fontWeight: 600,
    color: '#e5e7eb',
    lineHeight: 1.4,
  },
  questionSource: {
    margin: '2px 0 8px',
    fontSize: 12,
    fontStyle: 'italic',
    color: '#9ca3af',
  },
  // Text-Badges — nicht nur Farbe (AC3): eigener Text "Pflicht"/"Optional".
  // Kontrast: #fca5a5 on #2a1a1a ≈ 8.8:1 — WCAG AA (analog BoardView.jsx-
  // Konvention, Farbpaar dort ebenfalls für Fehler-/Pflicht-Badges genutzt).
  pflichtBadge: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: '#fca5a5',
    background: '#2a1a1a',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    padding: '2px 6px',
  },
  // Kontrast: #9ca3af on #1e293b ≈ 5.8:1 — WCAG AA.
  optionalBadge: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: '#9ca3af',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 4,
    padding: '2px 6px',
  },
  optionsGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  optionLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: '#e5e7eb',
    cursor: 'pointer',
  },
  textarea: {
    width: '100%',
    minHeight: 56,
    background: '#111',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '8px 10px',
    resize: 'vertical',
    fontFamily: 'system-ui, sans-serif',
    boxSizing: 'border-box',
  },
  success: {
    color: '#86efac',
    fontSize: 13,
    padding: '8px 10px',
    background: '#0f2417',
    borderRadius: 6,
    border: '1px solid #14532d',
    marginBottom: 12,
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
};
