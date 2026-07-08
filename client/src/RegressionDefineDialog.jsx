/**
 * RegressionDefineDialog.jsx — Definier-Dialog + Redaktions-Overlay für den
 * headless Regressionstest-Definitions-Lauf (docs/specs/regression-define-dialog.md
 * AC6, AC7, AC8 — Backend `RegressionDefineRunner`/`regressionDefineRouter` ist
 * S-307, bereits gelandet).
 *
 * State-Machine + Poll-/Retry-Muster 1:1 aus `ObsidianIngestOverlay.jsx`
 * übernommen (Backdrop, `role="dialog"` + `aria-modal`, Fokus beim Öffnen,
 * `Esc` schließt IMMER, Fokus-Rückgabe an `triggerRef`, `mountedRef`-Guard
 * gegen State-Updates nach Unmount, `pollGeneration`-Zähler statt `phase` als
 * Poll-Effect-Dependency gegen Doppel-Fire, expliziter Nicht-200-Poll-Zweig
 * als terminal statt „noch running" — .claude/lessons/coder.md 2026-07-01).
 * Zwei zusätzliche Zustände VOR dem Poll-Loop (`target` / `starting`) für die
 * Ziel-Auswahl (Bereich/Verbund), die es im Obsidian-Vorbild nicht gibt.
 *
 * State-Machine: target → starting → running ⇄ needs-review → submitting → done | error
 *
 * Covers (regression-define-dialog):
 *   AC6 — Schritt 1 (Zustand `target`): Bereichs-Auswahl aus
 *         `GET /api/board/projects/:slug/areas` (Bereichs-`id` + Name) ALS
 *         Radiogruppe PLUS die Option „Verbund…" mit freiem Namensfeld;
 *         optionales Stichwort-Feld (Freitext, Komma-getrennt → Array).
 *         Bestätigen ("Definition starten") postet
 *         `POST /api/projects/:slug/regression-define` mit
 *         `{ ziel: { typ, id }, stichworte? }` → 202 `{ jobId, status:"running" }`
 *         schaltet auf den Poll-Zustand (`running`). Schlägt der Start fehl
 *         (400/409/500/Netzwerk), bleibt der Dialog im `target`-Zustand mit
 *         Inline-Fehler (Eingaben bleiben erhalten, kein Datenverlust).
 *         `board/areas.yaml` fehlt/leer (Edge-Case §Edge-Cases) → Bereichs-
 *         Radiogruppe entfällt, nur „Verbund…" bleibt wählbar (kein Crash).
 *   AC7 — Poll `GET /api/projects/:slug/regression-define/:jobId` bis
 *         `needs-review`/`done`/`failed`/`auth-expired`. Bei `needs-review`
 *         zeigt das Overlay den NL-Vorschlag (`vorschlag`-Array:
 *         titel/schritte/pruefpunkte/beispieldaten, plus `quell_specs`/
 *         `target_vorschlag`) in EINEM großen, editierbaren Textfeld (der
 *         serialisierte, vom Owner frei redigierbare Vorschlag — Muster
 *         "editierbares Textfeld" aus ObsidianIngestOverlay, hier bewusst EIN
 *         Feld statt Feld-für-Feld-Formular, da der Vertrag keine feste
 *         Feldstruktur für die Redaktion vorschreibt). Bestätigen
 *         („Fassung bestätigen") parst den Text zurück zu JSON und schickt
 *         `POST .../:jobId/review` mit `{ reviewed: <redigierte Struktur> }`
 *         (Resume via STDIN, backend-seitig) → 202 `{status:"running"}` →
 *         zurück in den Poll-Zustand bis `done`/Fehler. Ist der redigierte
 *         Text kein valides JSON, bleibt der Dialog im `needs-review`-Zustand
 *         mit Inline-Fehler (kein Request, keine Datenverlust).
 *         `done` → Erfolgsmeldung + kurzer Linger (`successLingerMs`), dann
 *         `onDefineComplete` + `onClose`.
 *   AC8 — E1 (Projektwechsel während `needs-review`): der Aufrufer
 *         (`CockpitView.jsx`) hält den Wiedereinstiegs-Job
 *         (`{jobId, ziel}`-Äquivalent: hier `{jobId, projectSlug}`) NUR für
 *         das Projekt, für das er gestartet wurde — analog
 *         `ObsidianImportSection` `ingestJob`/`ingestJobMatchesSelection`.
 *         Wechselt `projectSlug` (Prop) gegenüber dem Job, für den
 *         `initialJobId` galt, wird das gemerkte `initialJobId` verworfen
 *         (kein stilles Resume des falschen Jobs) — geprüft per `useEffect`
 *         auf `projectSlug`-Änderung, identisch zum Obsidian-Muster (der
 *         Aufrufer trägt die eigentliche Zustands-Kopplung; diese Komponente
 *         selbst prüft defensiv NOCHMAL: ändert sich `projectSlug` WÄHREND
 *         die Komponente gemountet bleibt, wird der laufende Poll gestoppt
 *         und der Job als verworfen behandelt — Defense in Depth). E2
 *         (Bereich ohne deckende Specs) und `failed`/`auth-expired` zeigen
 *         eine klare, secret-freie Fehlermeldung (Text 1:1 vom Backend-
 *         Contract) statt eines leeren Overlays; „Erneut versuchen" springt
 *         zurück in den `target`-Zustand (neuer Lauf möglich).
 *
 * ── Component-Props-Vertrag ─────────────────────────────────────────────────
 * @param {{
 *   projectSlug: string,
 *   onClose: () => void,
 *   triggerRef?: React.RefObject,
 *   fetchFn?: Function,
 *   initialJobId?: string|null,
 *   onJobStarted?: (jobId: string) => void,
 *   onJobEnded?: () => void,
 *   onDefineComplete?: () => void,
 *   pollMs?: number,
 *   successLingerMs?: number,
 * }} props
 *
 * - `projectSlug` — das aktive Projekt (Cockpit-Kontext); Änderung während
 *   `needs-review` verwirft einen laufenden Wiedereinstieg (AC8/E1).
 * - `onClose` — schließt den Dialog (X/`Esc`/Backdrop/nach `done`-Linger).
 *   Bricht den headless Lauf NICHT ab (läuft detached weiter, Wiedereinstieg
 *   via `initialJobId` möglich — Muster ObsidianIngestOverlay).
 * - `triggerRef` — optional; erhält beim Schließen den Fokus zurück (A11y).
 * - `fetchFn` — injectable `fetch` für Tests (default: `globalThis.fetch`).
 * - `initialJobId` — bekannte, noch laufende `jobId` (Wiedereinstieg);
 *   `null`/`undefined` → frischer Ziel-Auswahl-Zustand (`target`).
 * - `onJobStarted(jobId)` — nach erfolgreichem Start (Aufrufer merkt sich die
 *   `jobId` gekoppelt an `projectSlug` für einen künftigen Wiedereinstieg).
 * - `onJobEnded()` — bei terminalem Zustand (`done`/`failed`/`auth-expired`/
 *   nicht mehr auffindbar) — Aufrufer verwirft die gemerkte `jobId`.
 * - `onDefineComplete()` — bei `done` (optionaler Re-Fetch-Callback).
 * - `pollMs` — Poll-Intervall (default 2000; in Tests überschreibbar).
 * - `successLingerMs` — Anzeigedauer der Erfolgsmeldung vor dem Schließen
 *   (default 1200; in Tests überschreibbar).
 *
 * Security (Floor):
 *   - Kein `dangerouslySetInnerHTML` — Vorschlags-/Fehlertexte werden als
 *     reiner React-Text bzw. in einem `<textarea>` gerendert.
 *   - Kein Secret/Token/Host-Pfad im UI — Fehlertexte kommen 1:1 vom bereits
 *     secret-freien Backend-Contract (`regressionDefineRouter.js`/
 *     `RegressionDefineRunner.js`).
 *   - `ziel.id` (Bereich) stammt ausschließlich aus der geladenen
 *     `areas`-Liste (kein Freitext); nur die Verbund-Variante ist Freitext
 *     (Eingabe-Vertrag AC4 lässt Verbund-Namen als String explizit zu).
 */

import { useState, useRef, useEffect, useCallback } from 'react';

/** Poll-Intervall (ms) für den Job-Status (überschreibbar via Prop `pollMs`). */
const REGRESSION_DEFINE_POLL_MS = 2000;

/** Anzeigedauer der Erfolgsmeldung vor dem Schließen (überschreibbar). */
const REGRESSION_DEFINE_SUCCESS_LINGER_MS = 1200;

/** Radiogruppen-Sentinel für die "Verbund…"-Option (analog AreaSelect NEW_SENTINEL-Muster). */
const VERBUND_SENTINEL = '__verbund__';

export function RegressionDefineDialog({
  projectSlug,
  onClose,
  triggerRef,
  fetchFn,
  initialJobId = null,
  onJobStarted,
  onJobEnded,
  onDefineComplete,
  pollMs = REGRESSION_DEFINE_POLL_MS,
  successLingerMs = REGRESSION_DEFINE_SUCCESS_LINGER_MS,
}) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);

  // 'target' | 'starting' | 'running' | 'needs-review' | 'submitting' | 'done' | 'error'
  const [phase, setPhase] = useState(initialJobId ? 'running' : 'target');
  const [errorMsg, setErrorMsg] = useState('');

  // ── Zustand `target` (AC6) ────────────────────────────────────────────────
  const [areas, setAreas] = useState(null); // null = lädt/fehlgeschlagen, [] = leer
  const [zielTyp, setZielTyp] = useState(null); // 'bereich' | 'verbund' | null (noch keine Auswahl)
  const [bereichId, setBereichId] = useState('');
  const [verbundName, setVerbundName] = useState('');
  const [stichworteText, setStichworteText] = useState('');
  const [startError, setStartError] = useState('');

  // ── Zustand `needs-review` (AC7) ─────────────────────────────────────────
  const [vorschlagText, setVorschlagText] = useState('');
  const [reviewError, setReviewError] = useState('');

  // Analog ObsidianIngestOverlay: bewusst NICHT direkt an `phase` gekoppelt
  // (Race bei sehr kurzem pollMs in Tests, s. dortiger Kommentar). Anders als
  // dort gibt es hier keinen separaten "boot"-Effect, der einen eigenen
  // Retry-Token bräuchte — `handleRetry` setzt `phase` direkt auf `target`
  // zurück (frische Ziel-Auswahl), das genügt um den Formular-Zustand zu lösen.
  const [pollGeneration, setPollGeneration] = useState(initialJobId ? 1 : 0);

  const jobIdRef = useRef(initialJobId ?? null);
  const projectSlugAtJobStartRef = useRef(initialJobId ? projectSlug : null);
  const dialogRef = useRef(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleClose = useCallback(() => {
    onClose();
    if (triggerRef?.current) triggerRef.current.focus();
  }, [onClose, triggerRef]);

  // Fokus beim Öffnen; Esc schließt (analog ObsidianIngestOverlay).
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

  // AC8/E1: Projektwechsel während eines laufenden/gemerkten Jobs verwirft
  // den Wiedereinstieg (Defense in Depth — der primäre Guard sitzt beim
  // Aufrufer, analog ObsidianImportSection `ingestJobMatchesSelection`).
  useEffect(() => {
    if (jobIdRef.current && projectSlugAtJobStartRef.current !== null
        && projectSlugAtJobStartRef.current !== projectSlug) {
      jobIdRef.current = null;
      projectSlugAtJobStartRef.current = null;
      onJobEnded?.();
      if (mountedRef.current) {
        setPhase('target');
        setPollGeneration(0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug]);

  // AC6: Bereichsliste laden (board/areas.yaml über den bestehenden Read-
  // Endpunkt). Leer/Fehler → nur „Verbund…" bleibt wählbar (Edge-Case).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch_(`/api/board/projects/${encodeURIComponent(projectSlug)}/areas`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data?.areas) ? data.areas : [];
        if (cancelled || !mountedRef.current) return;
        setAreas(list);
        if (list.length > 0) {
          setZielTyp('bereich');
          setBereichId(list[0].id);
        } else {
          setZielTyp('verbund');
        }
      } catch {
        if (cancelled || !mountedRef.current) return;
        setAreas([]);
        setZielTyp('verbund');
      }
    }
    if (phase === 'target') load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug, phase]);

  // ── Start (AC6): POST .../regression-define ─────────────────────────────
  const canStart =
    phase === 'target' &&
    ((zielTyp === 'bereich' && bereichId !== '') || (zielTyp === 'verbund' && verbundName.trim() !== ''));

  const handleStart = useCallback(async () => {
    if (!canStart) return;
    setPhase('starting');
    setStartError('');

    const ziel = zielTyp === 'bereich'
      ? { typ: 'bereich', id: bereichId }
      : { typ: 'verbund', id: verbundName.trim() };
    const stichworte = stichworteText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');

    let res;
    try {
      res = await fetch_(`/api/projects/${encodeURIComponent(projectSlug)}/regression-define`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stichworte.length > 0 ? { ziel, stichworte } : { ziel }),
      });
    } catch {
      if (!mountedRef.current) return;
      setPhase('target');
      setStartError('Netzwerkfehler beim Starten — bitte erneut versuchen.');
      return;
    }
    if (!mountedRef.current) return;

    if (res.status === 202) {
      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      if (!data.jobId) {
        setPhase('target');
        setStartError('Definitionslauf konnte nicht gestartet werden (keine jobId erhalten).');
        return;
      }
      jobIdRef.current = data.jobId;
      projectSlugAtJobStartRef.current = projectSlug;
      onJobStarted?.(data.jobId);
      setPhase('running');
      setPollGeneration((g) => g + 1);
      return;
    }

    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    setPhase('target');
    setStartError(data.error ?? `Definitionslauf konnte nicht gestartet werden (HTTP ${res.status}).`);
  }, [canStart, zielTyp, bereichId, verbundName, stichworteText, projectSlug, fetch_, onJobStarted]);

  // ── Poll-Loop (AC7): running → needs-review | done | failed/auth-expired ──
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
      jobIdRef.current = null;
      projectSlugAtJobStartRef.current = null;
      setPhase('error');
      setErrorMsg(msg);
      onJobEnded?.();
    }

    async function pollOnce() {
      if (stopped || !jobIdRef.current) return;
      let res;
      try {
        res = await fetch_(
          `/api/projects/${encodeURIComponent(projectSlug)}/regression-define/${encodeURIComponent(jobIdRef.current)}`,
        );
      } catch {
        return; // transienter Netzwerkfehler — nächste Runde erneut versuchen
      }
      if (stopped || !mountedRef.current) return;

      // lessons 2026-07-01: Nicht-200 NICHT wie "noch running" behandeln.
      if (res.status !== 200) {
        stop();
        terminalFailure('Definitionslauf nicht mehr auffindbar (evtl. Server-Neustart).');
        return;
      }

      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      if (stopped || !mountedRef.current) return;

      if (data.status === 'needs-review') {
        stop();
        setVorschlagText(JSON.stringify(data.vorschlag ?? {}, null, 2));
        setReviewError('');
        setPhase('needs-review');
        return;
      }
      if (data.status === 'done') {
        stop();
        jobIdRef.current = null;
        projectSlugAtJobStartRef.current = null;
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
              : 'Definitionslauf fehlgeschlagen — bitte erneut versuchen.'),
        );
        return;
      }
      // 'running' → weiterpollen.
    }

    pollOnce();
    timer = setInterval(pollOnce, pollMs);
    return () => { stopped = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollGeneration, pollMs, projectSlug]);

  // AC7 (done): kurze Erfolgsmeldung, dann Re-Fetch-Callback + Schließen.
  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(() => {
      if (!mountedRef.current) return;
      onDefineComplete?.();
      handleClose();
    }, successLingerMs);
    return () => clearTimeout(t);
  }, [phase, successLingerMs, onDefineComplete, handleClose]);

  // ── Review-Bestätigung (AC7): POST .../:jobId/review ─────────────────────
  const handleSubmitReview = useCallback(async () => {
    if (phase !== 'needs-review') return;

    let reviewed;
    try {
      reviewed = JSON.parse(vorschlagText);
    } catch {
      setReviewError('Die Fassung ist kein gültiges JSON — bitte korrigieren.');
      return;
    }

    setPhase('submitting');
    setReviewError('');

    let res;
    try {
      res = await fetch_(
        `/api/projects/${encodeURIComponent(projectSlug)}/regression-define/${encodeURIComponent(jobIdRef.current)}/review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewed }),
        },
      );
    } catch {
      if (!mountedRef.current) return;
      setPhase('needs-review');
      setReviewError('Netzwerkfehler beim Senden — bitte erneut versuchen.');
      return;
    }
    if (!mountedRef.current) return;

    if (res.status === 202) {
      setPhase('running');
      setPollGeneration((g) => g + 1);
      return;
    }

    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!mountedRef.current) return;
    setPhase('needs-review');
    setReviewError(data.error ?? `Fassung konnte nicht gesendet werden (HTTP ${res.status}).`);
  }, [phase, vorschlagText, projectSlug, fetch_]);

  const handleRetry = useCallback(() => {
    jobIdRef.current = null;
    projectSlugAtJobStartRef.current = null;
    setVorschlagText('');
    setReviewError('');
    setStartError('');
    setPollGeneration(0);
    setPhase('target');
  }, []);

  const titleId = 'regression-define-dialog-title';

  return (
    <>
      <div style={styles.backdrop} onClick={handleClose} aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={styles.dialog}
        data-testid="regression-define-dialog"
      >
        <h2 id={titleId} style={styles.heading}>Regressionstest definieren</h2>

        {phase === 'target' && (
          <>
            <p style={styles.hint}>
              Ziel wählen — der Definitions-Lauf schlägt daraus Schritte, Prüfpunkte
              und Beispieldaten vor.
            </p>

            {areas === null && (
              <p role="status" aria-live="polite" style={styles.hint} data-testid="regression-define-areas-loading">
                Bereiche werden geladen…
              </p>
            )}

            {areas !== null && (
              <div role="radiogroup" aria-label="Ziel der Regressionstest-Definition" style={styles.optionsGroup}>
                {areas.length === 0 && (
                  <p style={styles.hint} data-testid="regression-define-no-areas">
                    Keine Bereiche vorhanden — nur „Verbund…" wählbar.
                  </p>
                )}
                {areas.map((a) => (
                  <label key={a.id} style={styles.optionLabel}>
                    <input
                      type="radio"
                      name="regression-define-ziel"
                      value={a.id}
                      checked={zielTyp === 'bereich' && bereichId === a.id}
                      onChange={() => { setZielTyp('bereich'); setBereichId(a.id); }}
                      data-testid={`regression-define-area-${a.id}`}
                    />
                    {' '}{a.name}
                  </label>
                ))}
                <label style={styles.optionLabel}>
                  <input
                    type="radio"
                    name="regression-define-ziel"
                    value={VERBUND_SENTINEL}
                    checked={zielTyp === 'verbund'}
                    onChange={() => setZielTyp('verbund')}
                    data-testid="regression-define-verbund-radio"
                  />
                  {' '}Verbund…
                </label>
                {zielTyp === 'verbund' && (
                  <input
                    type="text"
                    style={styles.input}
                    value={verbundName}
                    onChange={(e) => setVerbundName(e.target.value)}
                    placeholder="Name des Verbunds"
                    aria-label="Name des Verbunds"
                    data-testid="regression-define-verbund-name"
                  />
                )}
              </div>
            )}

            <label style={styles.label} htmlFor="regression-define-stichworte">
              Stichworte (optional, Komma-getrennt)
            </label>
            <input
              id="regression-define-stichworte"
              type="text"
              style={styles.input}
              value={stichworteText}
              onChange={(e) => setStichworteText(e.target.value)}
              placeholder="z.B. Login, Fehlerfall"
              data-testid="regression-define-stichworte-input"
            />

            {startError && (
              <div role="alert" style={styles.error} data-testid="regression-define-start-error">
                {startError}
              </div>
            )}

            <div style={styles.buttonRow}>
              <button
                type="button"
                style={canStart ? styles.btnPrimary : styles.btnDisabled}
                disabled={!canStart}
                aria-disabled={!canStart}
                onClick={handleStart}
                data-testid="regression-define-start-btn"
              >
                Definition starten
              </button>
            </div>
          </>
        )}

        {phase === 'starting' && (
          <p role="status" aria-live="polite" style={styles.hint} data-testid="regression-define-starting">
            Definitionslauf wird gestartet…
          </p>
        )}

        {phase === 'running' && (
          <p role="status" aria-live="polite" style={styles.hint} data-testid="regression-define-running">
            Bereich wird analysiert — Vorschlag wird erstellt…
          </p>
        )}

        {phase === 'error' && (
          <div role="alert" style={styles.error} data-testid="regression-define-error">
            {errorMsg}
            <div style={styles.buttonRow}>
              <button
                type="button"
                style={styles.btnSecondary}
                onClick={handleRetry}
                data-testid="regression-define-retry-btn"
              >
                Erneut versuchen
              </button>
            </div>
          </div>
        )}

        {(phase === 'needs-review' || phase === 'submitting') && (
          <>
            <p style={styles.hint}>
              Vorschlag prüfen und bei Bedarf direkt im Textfeld anpassen (Schritte,
              Prüfpunkte, Beispieldaten). Bestätigen übersetzt die Fassung in eine
              Testdatei.
            </p>
            <label style={styles.label} htmlFor="regression-define-vorschlag">
              Vorschlag (editierbar)
            </label>
            <textarea
              id="regression-define-vorschlag"
              style={styles.textarea}
              value={vorschlagText}
              onChange={(e) => setVorschlagText(e.target.value)}
              disabled={phase === 'submitting'}
              rows={16}
              data-testid="regression-define-vorschlag-textarea"
            />

            {reviewError && (
              <div role="alert" style={styles.error} data-testid="regression-define-review-error">
                {reviewError}
              </div>
            )}

            <div style={styles.buttonRow}>
              <button
                type="button"
                style={phase === 'submitting' ? styles.btnDisabled : styles.btnPrimary}
                disabled={phase === 'submitting'}
                aria-disabled={phase === 'submitting'}
                onClick={handleSubmitReview}
                data-testid="regression-define-review-btn"
              >
                {phase === 'submitting' ? 'Sende…' : 'Fassung bestätigen'}
              </button>
            </div>
          </>
        )}

        {phase === 'done' && (
          <div role="status" aria-live="polite" style={styles.success} data-testid="regression-define-done">
            Definition abgeschlossen ✓ — Testdatei wird erstellt…
          </div>
        )}

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleClose}
            data-testid="regression-define-close-btn"
          >
            Schließen
          </button>
        </div>
      </div>
    </>
  );
}

// ── Styles (analog ObsidianIngestOverlay.jsx/IdeaCaptureModal.jsx) ──────────

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
    maxWidth: 640,
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
  label: {
    display: 'block',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: '#9ca3af',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  optionsGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 14,
  },
  optionLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: '#e5e7eb',
    cursor: 'pointer',
  },
  input: {
    width: '100%',
    background: '#111',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 14,
    padding: '9px 10px',
    marginBottom: 14,
    marginTop: 6,
    fontFamily: 'system-ui, sans-serif',
    boxSizing: 'border-box',
    minHeight: 40,
  },
  textarea: {
    width: '100%',
    minHeight: 260,
    background: '#111',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '8px 10px',
    marginBottom: 12,
    resize: 'vertical',
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
