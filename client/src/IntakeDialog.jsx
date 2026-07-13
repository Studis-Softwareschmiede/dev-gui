/**
 * IntakeDialog.jsx — Fabric-Intake-Dialog (S-132 + S-133, fabric-intake-dialog).
 *
 * AC1  — Dialog in zwei Modi: `new` (Projektidee/Vision, mehrzeilig, opt. Stack/Constraints)
 *         und `change` (Was soll sich ändern?, mehrzeilig, opt. Betroffener Bereich).
 *         Mehrzeilige Freitexterfassung via <textarea>.
 * AC2  — Modus-abhängige Trigger-Zahl (S-133):
 *         `change`: ein Trigger `/agent-flow:requirement <text>`.
 *         `new`: zwei sequentielle, je vom Nutzer bestätigte Trigger:
 *           Schritt 1 (newStep='trigger1') — `/agent-flow:new-project` (ohne Idee-Argument).
 *           Schritt 2 (newStep='trigger2') — `/agent-flow:requirement <text>` mit der
 *             im Dialog vorab gehaltenen Idee.
 *         Kein Auto-Chaining: Trigger 2 erst nach expliziter Nutzer-Bestätigung.
 *         Die Schritt-Nummer wird via newStep/onNewStepChange nach außen geliftet
 *         (RepoOverview hält den State damit er den Pane-Wechsel überlebt).
 * AC2b — Mehrzeiliger Text wird client-seitig zu einer einzigen Zeile kollabiert
 *         (alle Steuer-/Zeilenumbrüche → einzelne Spaces, getrimmt) bevor er an
 *         `/agent-flow:requirement` gehängt wird. Leerer Text → kein Request.
 * AC4  — Nach erfolgreichem Submit (202) wechselt die Ansicht in den Terminal-Pane
 *         (via onNavigate('factory')). Gilt für beide Trigger (S-133).
 * AC6  — „Let Claude proof"-Button pro Freitextfeld (primär + optional).
 *         Klick → POST /api/assist/refine { text, kind } → 200 { refinedText, openQuestions[] }.
 *         refinedText wird editierbar angezeigt; „Übernehmen" ersetzt den Feldinhalt.
 *         openQuestions als zugängliche <ul>-Liste (Frage + Begründung + optionale Optionen).
 *         Leer-Guard: leerer/whitespace-only Text → Button disabled (kein Request).
 *         Ladetindikator während des Requests; 400/502 → klare Fehlermeldung, Text unverändert.
 *         Proof-Pfad ist UNABHÄNGIG vom Submit (kein Lock, keine Submit-Logik-Änderung).
 * AC9  — Cost-Mode-Schalter für `requirement` (4-Wege
 *         low-cost|balanced|max-quality|frontier, Default balanced → kein --cost-Flag).
 *         Shared via costMode.js (keine Duplikation).
 *         `new-project` (wie `adopt`) bietet keinen Cost-Mode (nicht cost-aware).
 *
 * Design constraints (docs/design.md):
 *   - Dark-first, 8-pt Spacing-Skala, UI-Sans für Panels.
 *   - Status nie nur über Farbe (WCAG 2.1 AA); Labels vorhanden; Schritt-Status
 *     über Text + visuelle Affordanz (nicht nur Farbe).
 *   - Touch-Targets ≥ 44 px; sichtbarer Fokusring (kein outline:none).
 *   - Fokusführung: primäre textarea erhält Fokus beim Öffnen des Dialogs.
 *
 * Security (Floor):
 *   - Keine Secrets im Client (security/R01).
 *   - Text wird als JSON-Feld an POST /api/command gesendet; Server ist
 *     authoritative (Allowlist + Sanitisierung).
 *   - React escaped alle string-Renders per Default (security/R02).
 *   - Input wird client-seitig bereinigt (collapseToLine) — keine Steuerzeichen.
 *
 * Covers (fabric-intake-dialog): AC1, AC2, AC2b, AC4, AC6, AC9
 *
 * @module IntakeDialog
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { COST_MODES, COST_MODE_INFO, costFlag, collapseToLine } from './costMode.js';

// ── Fetch with timeout helper ─────────────────────────────────────────────────

/**
 * Wraps a fetchFn call with an AbortController timeout.
 *
 * @param {Function} fetchFn   The underlying fetch function.
 * @param {string}   url       Request URL.
 * @param {object}   [opts]    Fetch options.
 * @param {number}   [ms=5000] Timeout in milliseconds.
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(fetchFn, url, opts = {}, ms = 5_000) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), ms);
  return fetchFn(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(timerId)
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** The command prefix for requirement (cost-aware). */
const REQUIREMENT_CMD = '/agent-flow:requirement';

/** The command for new-project bootstrap (NOT cost-aware; no Idee-Argument). */
const NEW_PROJECT_CMD = '/agent-flow:new-project';

/**
 * Headless-Anlage-Endpunkt (per-app-gpg-passphrase-provisioning AC12/AC13,
 * F-073/S-343) — der PRIMÄRE Weg, Schritt 1 (Bootstrap) auszulösen. Der
 * bestehende `/agent-flow:new-project`-Trigger über POST /api/command (oben,
 * `composeCommand`/`handleSubmit`) bleibt als technischer PTY-Fallback
 * UNVERÄNDERT bestehen (AC14) — nur als Standard demotet (Muster S-251).
 */
const NEW_PROJECT_START_ENDPOINT = '/api/new-project/start';

/**
 * App-Slug-Validierung (AC13) — Zeichensatz/Länge identisch zu `gpgBwItem`/
 * `APP_SLUG_RE` im Backend (`PerAppGpgProvisioningService`/`deploymentsRouter.js`/
 * `newProjectHeadlessRouter.js`): nur alphanumerisch, `_`/`-`, max. 128 Zeichen.
 * Defense in depth (Server bleibt autoritativ) — der Slug steht damit VOR dem
 * Scaffold fest und versorgt die `GPG_PASS_FILE`-Kette (AC5) vor GE4.
 */
const APP_SLUG_CLIENT_RE = /^[A-Za-z0-9_-]+$/;
const MAX_APP_SLUG_LEN = 128;

// ── IntakeDialog component ────────────────────────────────────────────────────

/**
 * IntakeDialog — structured intake for idea/change requests.
 *
 * @param {{
 *   mode: 'new' | 'change',
 *   onNavigate: (view: string) => void,
 *   fetchFn?: Function,
 *   projectPath?: string,
 *   newStep?: 'trigger1' | 'trigger2',
 *   onNewStepChange?: (step: 'trigger1' | 'trigger2') => void,
 *   heldIdeaText?: string,
 *   onIdeaTextChange?: (text: string) => void,
 * }} props
 *   mode              — 'new' (Projektidee) or 'change' (Änderungswunsch).
 *   onNavigate        — navigates to 'factory' after successful submit (AC4).
 *   fetchFn           — injectable for tests (default: global fetch).
 *   projectPath       — when set, sent as projectPath in POST body for project-session routing.
 *   newStep           — (new-mode only) current sequencing step: 'trigger1' (new-project)
 *                       or 'trigger2' (requirement). Lifted to parent so it survives
 *                       pane-switches (AC4 + AC2 state persistence across mount/unmount).
 *   onNewStepChange   — called when the step advances to 'trigger2' after Trigger 1 202.
 *   heldIdeaText      — (new-mode only) ideaText held in parent across remounts.
 *   onIdeaTextChange  — called when ideaText changes in new-mode so parent can hold it.
 */
export function IntakeDialog({
  mode = 'change',
  onNavigate,
  fetchFn,
  projectPath,
  newStep = 'trigger1',
  onNewStepChange,
  heldIdeaText,
  onIdeaTextChange,
}) {
  const isNew = mode === 'new';

  // ── Field state ──────────────────────────────────────────────────────────
  /**
   * Primary idea/change textarea.
   * In new-mode, initial value comes from heldIdeaText (parent-held across remounts).
   */
  const [ideaText, setIdeaText]         = useState(heldIdeaText ?? '');
  /** Optional secondary field (stack/constraints for 'new'; area for 'change') */
  const [optionalText, setOptionalText] = useState('');
  /** Cost-mode for requirement (AC9) — default 'balanced' → no flag */
  const [costMode, setCostMode]         = useState('balanced');

  // Sync ideaText changes back to parent in new-mode (for survival across remounts).
  const handleIdeaTextChange = useCallback((val) => {
    setIdeaText(val);
    if (isNew && onIdeaTextChange) onIdeaTextChange(val);
  }, [isNew, onIdeaTextChange]);

  // ── Proof handlers (AC6) ─────────────────────────────────────────────────

  /**
   * Resolve the `kind` parameter for /api/assist/refine based on dialog mode (AC6).
   * new-mode → 'idea'; change-mode → 'change'.
   */
  const proofKind = isNew ? 'idea' : 'change';

  /**
   * Handle "Let Claude proof" for the primary field (AC6).
   * Leer-Guard: no-op when text collapses to empty.
   */
  const handlePrimaryProof = useCallback(async () => {
    const trimmed = ideaText.trim();
    if (!trimmed) return; // Leer-Guard (AC6)

    setPrimaryProofState('loading');
    setPrimaryProofError(null);
    setPrimaryProofResult(null);

    let res;
    try {
      res = await fetchWithTimeout(
        fetchFnRef.current,
        '/api/assist/refine',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed, kind: proofKind }),
        },
        30_000, // claude -p can take longer than command POST
      );
    } catch {
      setPrimaryProofState('error');
      setPrimaryProofError('Netzwerkfehler beim Proof-Aufruf. Bitte erneut versuchen.');
      return;
    }

    if (res.status === 200) {
      let data;
      try { data = await res.json(); } catch {
        setPrimaryProofState('error');
        setPrimaryProofError('Ungültige Antwort vom Server.');
        return;
      }
      setPrimaryProofResult(data);
      setPrimaryRefinedEdit(data.refinedText ?? '');
      setPrimaryProofState('done');
      return;
    }

    // 400 / 502 → Fehlermeldung, Feldinhalt bleibt unverändert (AC6)
    if (res.status === 400) {
      setPrimaryProofState('error');
      setPrimaryProofError('Ungültige Anfrage (400). Bitte Inhalt prüfen.');
      return;
    }
    if (res.status === 502) {
      setPrimaryProofState('error');
      setPrimaryProofError('Proof-Dienst nicht verfügbar (502). Bitte später erneut versuchen.');
      return;
    }
    setPrimaryProofState('error');
    setPrimaryProofError('Serverfehler beim Proof-Aufruf. Bitte erneut versuchen.');
  }, [ideaText, proofKind]);

  /**
   * Handle "Let Claude proof" for the optional field (AC6).
   * Leer-Guard: no-op when text collapses to empty.
   */
  const handleOptionalProof = useCallback(async () => {
    const trimmed = optionalText.trim();
    if (!trimmed) return; // Leer-Guard (AC6)

    setOptionalProofState('loading');
    setOptionalProofError(null);
    setOptionalProofResult(null);

    let res;
    try {
      res = await fetchWithTimeout(
        fetchFnRef.current,
        '/api/assist/refine',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed, kind: proofKind }),
        },
        30_000,
      );
    } catch {
      setOptionalProofState('error');
      setOptionalProofError('Netzwerkfehler beim Proof-Aufruf. Bitte erneut versuchen.');
      return;
    }

    if (res.status === 200) {
      let data;
      try { data = await res.json(); } catch {
        setOptionalProofState('error');
        setOptionalProofError('Ungültige Antwort vom Server.');
        return;
      }
      setOptionalProofResult(data);
      setOptionalRefinedEdit(data.refinedText ?? '');
      setOptionalProofState('done');
      return;
    }

    if (res.status === 400) {
      setOptionalProofState('error');
      setOptionalProofError('Ungültige Anfrage (400). Bitte Inhalt prüfen.');
      return;
    }
    if (res.status === 502) {
      setOptionalProofState('error');
      setOptionalProofError('Proof-Dienst nicht verfügbar (502). Bitte später erneut versuchen.');
      return;
    }
    setOptionalProofState('error');
    setOptionalProofError('Serverfehler beim Proof-Aufruf. Bitte erneut versuchen.');
  }, [optionalText, proofKind]);

  // ── Proof state (AC6) ────────────────────────────────────────────────────
  /**
   * Proof state per field: 'idle' | 'loading' | 'done' | 'error'.
   * 'primary' = primary idea/change textarea; 'optional' = secondary textarea.
   */
  const [primaryProofState, setPrimaryProofState]     = useState('idle');
  /** Proof error message for primary field */
  const [primaryProofError, setPrimaryProofError]     = useState(null);
  /** Parsed result from /api/assist/refine for primary field */
  const [primaryProofResult, setPrimaryProofResult]   = useState(null);
  /** Editable refinedText for primary field (user can tweak before adopting) */
  const [primaryRefinedEdit, setPrimaryRefinedEdit]   = useState('');

  const [optionalProofState, setOptionalProofState]   = useState('idle');
  const [optionalProofError, setOptionalProofError]   = useState(null);
  const [optionalProofResult, setOptionalProofResult] = useState(null);
  const [optionalRefinedEdit, setOptionalRefinedEdit] = useState('');

  // ── Submit state ─────────────────────────────────────────────────────────
  /** 'idle' | 'submitting' | 'error' */
  const [submitState, setSubmitState]   = useState('idle');
  /** Error message text */
  const [errorMsg, setErrorMsg]         = useState(null);

  // ── Headless-Bootstrap-State (per-app-gpg-passphrase-provisioning AC12/AC13,
  // F-073/S-343) — NUR in new-mode Schritt 1 relevant; unabhängig vom PTY-
  // Fallback-Submit-State oben (getrennte Zustände, kein Vermischen). ────────
  /** App-Name / Ziel-Slug (AC13, vorab erfasst — vor dem Scaffold). */
  const [appSlug, setAppSlug]                     = useState('');
  /** 'idle' | 'submitting' | 'error' */
  const [headlessSubmitState, setHeadlessSubmitState] = useState('idle');
  const [headlessErrorMsg, setHeadlessErrorMsg]       = useState(null);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const primaryRef   = useRef(null); // primary textarea — receives focus on mount
  const fetchFnRef   = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  // AC1: Focus primary textarea on mount (A11y — Fokusführung beim Öffnen)
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  // ── Derived step info (AC2 — new mode two-trigger sequencing) ─────────────

  /**
   * In new-mode, we are in Schritt 1 (bootstrap) or Schritt 2 (requirement).
   * In change-mode, there is only one trigger so this is always effectively 'trigger2'
   * semantics (requirement), but the variable is not used in change-mode branches.
   */
  const isStep1 = isNew && newStep === 'trigger1';

  const primaryLabel    = isNew
    ? 'Projektidee / Vision'
    : 'Was soll sich ändern?';

  const primaryPlaceholder = isNew
    ? 'Beschreibe deine Projektidee oder Vision …'
    : 'Beschreibe, was sich ändern soll …';

  const optionalLabel   = isNew
    ? 'Stack-Wunsch / Constraints'
    : 'Betroffener Bereich';

  const optionalPlaceholder = isNew
    ? 'z. B. TypeScript, React, PostgreSQL …'
    : 'z. B. Auth-Modul, API-Schicht …';

  /**
   * Submit-button label is step-dependent in new-mode (AC2):
   *   Schritt 1: "Bootstrap starten" → fires /agent-flow:new-project
   *   Schritt 2: "Idee übergeben"   → fires /agent-flow:requirement <text>
   *   change:    "Änderung erfassen" (unchanged)
   */
  const submitLabel = isNew
    ? (isStep1 ? 'Bootstrap starten' : 'Idee übergeben')
    : 'Änderung erfassen';

  // ── Submit handler ───────────────────────────────────────────────────────

  /**
   * Compose the command line for the current step (AC2, AC2b):
   *
   * new-mode, Schritt 1 (trigger1):
   *   → `/agent-flow:new-project`  (NO argument; Stack-Rückfragen im Terminal)
   *   → Always non-null (no text required).
   *
   * new-mode, Schritt 2 (trigger2) / change-mode:
   *   1. Collapse ideaText + optionalText to single lines (AC2b).
   *   2. Concatenate into one space-separated argument string.
   *   3. Prepend cost flag when not 'balanced' (AC9).
   *   → Returns null when the collapsed text is empty (leerer Text → kein Request).
   *
   * @returns {string|null}
   */
  const composeCommand = useCallback(() => {
    // Schritt 1 in new-mode: just bootstrap, no argument.
    if (isStep1) {
      return NEW_PROJECT_CMD;
    }

    // Schritt 2 (new-mode) or change-mode: requirement with collapsed text.
    const collapsed     = collapseToLine(ideaText);
    const collapsedOpt  = collapseToLine(optionalText);

    // Build the argument: primary text + optional text separated by a space.
    // Both are already single-line; join only when both non-empty.
    const parts = [collapsed, collapsedOpt].filter(Boolean);
    const argument = parts.join(' ');

    if (!argument) return null; // AC2b: leerer Text → kein Request

    const cost = costFlag(REQUIREMENT_CMD, costMode);
    return `${REQUIREMENT_CMD}${cost} ${argument}`;
  }, [isStep1, ideaText, optionalText, costMode]);

  const handleSubmit = useCallback(async () => {
    const command = composeCommand();
    if (!command) return; // AC2b: guard — empty text (only applies in step2/change)

    setSubmitState('submitting');
    setErrorMsg(null);

    // Build POST body; include projectPath when set (backward compat when absent).
    const body = { command };
    if (projectPath && typeof projectPath === 'string' && projectPath.trim()) {
      body.projectPath = projectPath.trim();
    }

    let res;
    try {
      res = await fetchWithTimeout(fetchFnRef.current, '/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      setSubmitState('error');
      setErrorMsg('Netzwerkfehler beim Senden. Bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      setSubmitState('idle');
      // AC4: nach erfolgreichem Submit → Terminal-Pane (für jeden Trigger)
      // AC2: In new-mode Schritt 1: Schritt auf trigger2 voranschreiten + navigieren.
      //      Der User kehrt zum Dialog zurück wenn er Schritt 2 auslösen will.
      //      In new-mode Schritt 2 / change-mode: direkt navigieren.
      if (isStep1 && onNewStepChange) {
        onNewStepChange('trigger2');
      }
      onNavigate('factory');
      return;
    }

    if (res.status === 409) {
      setSubmitState('error');
      setErrorMsg('Ein Job läuft bereits. Bitte warten bis der aktuelle Lauf abgeschlossen ist.');
      return;
    }

    if (res.status === 400) {
      let detail = 'Ungültiger Befehl.';
      try {
        const json = await res.json();
        if (json?.reason) detail = `Ungültiger Befehl: ${json.reason}`;
      } catch { /* ignore parse error */ }
      setSubmitState('error');
      setErrorMsg(detail);
      return;
    }

    setSubmitState('error');
    setErrorMsg('Serverfehler. Bitte erneut versuchen.');
  }, [composeCommand, isStep1, onNewStepChange, onNavigate, projectPath]);

  // ── Headless-Bootstrap-Handler (per-app-gpg-passphrase-provisioning AC12/
  // AC13/AC15, F-073/S-343) — PRIMÄRER Weg für Schritt 1. Erfasst/validiert
  // den App-Slug VOR dem Scaffold (AC13) und startet den headless
  // `HeadlessNewProjectRunner` (POST /api/new-project/start), der an seinem
  // erfolgreichen Abschluss GENAU EINMAL die Auto-Provisionierung auslöst
  // (AC15, server-seitig — s. `newProjectHeadlessRouter.js`). ────────────────

  const appSlugTrimmed = appSlug.trim();
  const appSlugValid =
    appSlugTrimmed.length > 0 &&
    appSlugTrimmed.length <= MAX_APP_SLUG_LEN &&
    APP_SLUG_CLIENT_RE.test(appSlugTrimmed);

  const isHeadlessSubmitting = headlessSubmitState === 'submitting';

  const handleHeadlessBootstrap = useCallback(async () => {
    if (!appSlugValid || isHeadlessSubmitting) return; // Guard: kein Doppel-POST

    setHeadlessSubmitState('submitting');
    setHeadlessErrorMsg(null);

    let res;
    try {
      res = await fetchWithTimeout(fetchFnRef.current, NEW_PROJECT_START_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: appSlugTrimmed }),
      });
    } catch {
      setHeadlessSubmitState('error');
      setHeadlessErrorMsg('Netzwerkfehler beim Senden. Bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      setHeadlessSubmitState('idle');
      // AC2/S-133-Muster: nach erfolgreichem Bootstrap-Start Schritt 2 freigeben
      // + navigieren (identisch zum bisherigen PTY-Fallback-Verhalten, nur der
      // Transport ist headless statt PTY).
      if (onNewStepChange) onNewStepChange('trigger2');
      onNavigate('factory');
      return;
    }

    if (res.status === 403) {
      setHeadlessSubmitState('error');
      setHeadlessErrorMsg('Keine Berechtigung für diese Aktion.');
      return;
    }

    if (res.status === 400) {
      let detail = 'Ungültiger App-Name.';
      try {
        const json = await res.json();
        if (json?.error) detail = json.error;
      } catch { /* ignore parse error */ }
      setHeadlessSubmitState('error');
      setHeadlessErrorMsg(detail);
      return;
    }

    if (res.status === 503) {
      setHeadlessSubmitState('error');
      setHeadlessErrorMsg('Headless-Anlage aktuell nicht verfügbar — bitte den Terminal-Fallback nutzen.');
      return;
    }

    setHeadlessSubmitState('error');
    setHeadlessErrorMsg('Serverfehler. Bitte erneut versuchen.');
  }, [appSlugValid, appSlugTrimmed, isHeadlessSubmitting, onNewStepChange, onNavigate]);

  // ── Derived: can submit? ─────────────────────────────────────────────────

  const isSubmitting = submitState === 'submitting';
  // S1: derive command once per render (avoids multiple composeCommand() calls below)
  const command      = composeCommand();
  const canSubmit    = !isSubmitting && command !== null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <section
      style={styles.dialog}
      aria-label={isNew ? 'Neue Projektidee erfassen' : 'Änderungswunsch erfassen'}
    >
      {/* Header */}
      <header style={styles.header}>
        <span style={styles.title}>
          {isNew ? 'Neue Projektidee' : 'Änderungswunsch'}
        </span>
        {/* Mode badge — text label (not color alone; AC design.md) */}
        <span
          style={isNew ? styles.badgeNew : styles.badgeChange}
          aria-label={`Modus: ${isNew ? 'neues Projekt' : 'Änderung'}`}
        >
          {isNew ? 'new' : 'change'}
        </span>
      </header>

      <div style={styles.body}>
        {/* AC2 (S-133): new-mode two-step sequence indicator.
            Schritt-Status: text + visual affordanz (WCAG — nie nur über Farbe).
            Replaces the S-132 aria-live bootstrap hint placeholder. */}
        {isNew && (
          <div
            role="status"
            aria-live="polite"
            id="intake-new-sequence-status"
            style={isStep1 ? styles.sequenceStep1 : styles.sequenceStep2}
            data-testid="intake-new-sequence-status"
          >
            {isStep1 ? (
              <>
                <strong>Schritt 1 von 2 — Bootstrap:</strong>{' '}
                <code style={styles.inlineCode}>/agent-flow:new-project</code> starten.
                Erfasse zuerst deine Idee unten, dann klicke „Bootstrap starten".
                Der Agent stellt Stack-Rückfragen direkt im Terminal.
              </>
            ) : (
              <>
                <strong>Schritt 2 von 2 — Idee übergeben:</strong>{' '}
                Bootstrap abgeschlossen. Klicke „Idee übergeben" um{' '}
                <code style={styles.inlineCode}>/agent-flow:requirement</code> mit deiner Idee zu starten.
              </>
            )}
          </div>
        )}

        {/* per-app-gpg-passphrase-provisioning AC13 (F-073/S-343): App-Name /
            Ziel-Slug wird VORAB im Dialog erfasst + validiert, damit er vor
            dem Scaffold feststeht (versorgt die GPG_PASS_FILE-Kette vor GE4).
            NUR in Schritt 1 relevant — Schritt 2/change-mode brauchen keinen Slug. */}
        {isStep1 && (
          <>
            <label style={styles.label} htmlFor="intake-app-slug">
              App-Name / Ziel-Slug <span style={styles.required}>(Pflicht)</span>
            </label>
            <input
              id="intake-app-slug"
              type="text"
              style={styles.textInput}
              placeholder="z. B. mein-neues-projekt"
              value={appSlug}
              disabled={isHeadlessSubmitting}
              aria-disabled={isHeadlessSubmitting}
              aria-describedby="intake-app-slug-hint"
              aria-invalid={appSlug.trim().length > 0 && !appSlugValid}
              onChange={(e) => setAppSlug(e.target.value)}
              data-testid="intake-app-slug-input"
            />
            <div id="intake-app-slug-hint" style={styles.hint}>
              Nur Buchstaben/Ziffern/„_"/„-", max. {MAX_APP_SLUG_LEN} Zeichen — legt den
              Ziel-Repo-Namen fest, bevor der Scaffold headless startet.
            </div>
            {appSlug.trim().length > 0 && !appSlugValid && (
              <div role="alert" style={styles.errorMsg} data-testid="intake-app-slug-error">
                Ungültiger App-Name — nur Buchstaben, Ziffern, „_" und „-", max. {MAX_APP_SLUG_LEN} Zeichen.
              </div>
            )}
          </>
        )}

        {/* Primary textarea — receives focus on mount (A11y).
            In new-mode step 1: erfasse Idee vorab, wird nach Bootstrap in Schritt 2 gesendet.
            In new-mode step 2 / change-mode: text required for submit. */}
        <label style={styles.label} htmlFor="intake-idea">
          {primaryLabel}{' '}
          {/* In new-mode step 1, text is not required for trigger 1 but is for trigger 2 */}
          {isStep1
            ? <span style={styles.optional}>(für Schritt 2 vorab erfassen)</span>
            : <span style={styles.required}>(Pflicht)</span>
          }
        </label>
        <textarea
          id="intake-idea"
          ref={primaryRef}
          style={styles.textarea}
          placeholder={primaryPlaceholder}
          value={ideaText}
          rows={6}
          disabled={isSubmitting}
          aria-disabled={isSubmitting}
          aria-required={isStep1 ? 'false' : 'true'}
          aria-describedby="intake-idea-hint"
          onChange={(e) => handleIdeaTextChange(e.target.value)}
        />
        <div id="intake-idea-hint" style={styles.hint}>
          {isStep1
            ? 'Idee hier erfassen — wird nach dem Bootstrap-Schritt als Argument an requirement übergeben.'
            : 'Mehrere Zeilen möglich — wird beim Senden zu einer Zeile zusammengefasst.'
          }
        </div>

        {/* AC6 — „Let Claude proof"-Button for primary field.
            Leer-Guard: disabled when field empty/whitespace-only.
            Race-Guard: disabled while loading (prevents double-POST on double-click).
            Independent from Submit (no Lock, no submit-logic change). */}
        <ProofButton
          fieldId="primary"
          disabled={!ideaText.trim() || isSubmitting || primaryProofState === 'loading'}
          loading={primaryProofState === 'loading'}
          onProof={handlePrimaryProof}
        />

        {/* AC6 — Proof result panel for primary field */}
        {(primaryProofState === 'done' || primaryProofState === 'error') && (
          <ProofResultPanel
            fieldId="primary"
            proofState={primaryProofState}
            proofError={primaryProofError}
            proofResult={primaryProofResult}
            refinedEdit={primaryRefinedEdit}
            onRefinedEditChange={setPrimaryRefinedEdit}
            onAdopt={() => {
              handleIdeaTextChange(primaryRefinedEdit);
              setPrimaryProofState('idle');
              setPrimaryProofResult(null);
            }}
          />
        )}

        {/* Optional secondary field — I3: aria-describedby analogous to primary.
            Hidden in new-mode step 1 (only the idea matters for step 2; optional
            fields are for step 2 / change-mode). */}
        {!isStep1 && (
          <>
            <label style={styles.label} htmlFor="intake-optional">
              {optionalLabel} <span style={styles.optional}>(optional)</span>
            </label>
            <textarea
              id="intake-optional"
              style={styles.textarea}
              placeholder={optionalPlaceholder}
              value={optionalText}
              rows={2}
              disabled={isSubmitting}
              aria-disabled={isSubmitting}
              aria-describedby="intake-optional-hint"
              onChange={(e) => setOptionalText(e.target.value)}
            />
            {/* I3: hint div with id for aria-describedby */}
            <div id="intake-optional-hint" style={styles.hint}>
              Ergänzende Angaben — optional, wird mit dem Haupttext zusammengefasst.
            </div>

            {/* AC6 — „Let Claude proof"-Button for optional field.
                Race-Guard: disabled while loading (prevents double-POST on double-click). */}
            <ProofButton
              fieldId="optional"
              disabled={!optionalText.trim() || isSubmitting || optionalProofState === 'loading'}
              loading={optionalProofState === 'loading'}
              onProof={handleOptionalProof}
            />

            {/* AC6 — Proof result panel for optional field */}
            {(optionalProofState === 'done' || optionalProofState === 'error') && (
              <ProofResultPanel
                fieldId="optional"
                proofState={optionalProofState}
                proofError={optionalProofError}
                proofResult={optionalProofResult}
                refinedEdit={optionalRefinedEdit}
                onRefinedEditChange={setOptionalRefinedEdit}
                onAdopt={() => {
                  setOptionalText(optionalRefinedEdit);
                  setOptionalProofState('idle');
                  setOptionalProofResult(null);
                }}
              />
            )}
          </>
        )}

        {/* Cost-Mode switch (AC9) — requirement is cost-aware.
            new-project (like adopt) is NOT cost-aware → only show in step 2 / change-mode. */}
        {!isStep1 && (
          <>
            <label style={styles.label} htmlFor="intake-cost">
              Cost-Mode <span style={styles.optional}>(Token-Hebel)</span>
            </label>
            <select
              id="intake-cost"
              style={styles.select}
              value={costMode}
              disabled={isSubmitting}
              aria-disabled={isSubmitting}
              aria-describedby="intake-cost-info"
              onChange={(e) => setCostMode(e.target.value)}
            >
              {COST_MODES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            {/* S2: id="intake-cost-info" so select's aria-describedby links here */}
            <div id="intake-cost-info" style={styles.costInfo} aria-live="polite" data-testid="intake-cost-info">
              <span>{COST_MODE_INFO[costMode].models} · {COST_MODE_INFO[costMode].price} /MTok</span>
              <span style={styles.costDisclaimer}>
                Abo-Betrieb — keine Direktkosten pro Token; Werte nur relative Tier-Schwere.
              </span>
            </div>
          </>
        )}

        {/* Command preview (informational — shows what will be sent) */}
        {/* S1: use derived `command` constant instead of calling composeCommand() */}
        {command !== null && (
          <div style={styles.preview} aria-live="polite" data-testid="intake-preview">
            <span style={styles.previewLabel}>Befehl:</span>
            <code style={styles.previewCode}>{command}</code>
          </div>
        )}

        {/* per-app-gpg-passphrase-provisioning AC12/AC13/AC15 (F-073/S-343):
            headless Bootstrap — PRIMÄRER Weg für Schritt 1. Eigener,
            getrennter Fehler-/Status-Block (nicht mit dem PTY-Fallback
            unten vermischt). */}
        {isStep1 && headlessSubmitState === 'error' && headlessErrorMsg && (
          <div role="alert" id="intake-headless-error" style={styles.errorMsg} data-testid="intake-headless-error">
            {headlessErrorMsg}
          </div>
        )}
        {isStep1 && isHeadlessSubmitting && (
          <div role="status" aria-live="polite" style={styles.statusMsg}>
            Anlage wird headless gestartet …
          </div>
        )}

        {/* Error message (PTY-Fallback-Pfad) */}
        {submitState === 'error' && errorMsg && (
          <div
            role="alert"
            id="intake-error"
            style={styles.errorMsg}
          >
            {errorMsg}
          </div>
        )}

        {/* Submitting indicator (PTY-Fallback-Pfad) */}
        {isSubmitting && (
          <div role="status" aria-live="polite" style={styles.statusMsg}>
            Wird gesendet …
          </div>
        )}

        {/* Submit button(s) — label is step-dependent in new-mode (AC2).
            In step 1: zwei Wege — PRIMÄR headless (AC12/AC13), sekundär der
            unveränderte PTY-Fallback (AC14, Muster S-251). In step 2/change-mode:
            unveränderter Einzel-Button (kein headless-Pfad für requirement/change). */}
        <div style={styles.buttonRow}>
          {isStep1 ? (
            <button
              type="button"
              style={appSlugValid && !isHeadlessSubmitting ? styles.btnSubmit : styles.btnSubmitDisabled}
              disabled={!appSlugValid || isHeadlessSubmitting}
              aria-label={
                isHeadlessSubmitting
                  ? 'Projekt anlegen — wird gestartet'
                  : !appSlugValid
                  ? 'Projekt anlegen — App-Name erforderlich'
                  : 'Projekt anlegen'
              }
              onClick={handleHeadlessBootstrap}
              data-testid="intake-headless-bootstrap-btn"
            >
              {isHeadlessSubmitting ? 'Wird gestartet …' : 'Projekt anlegen'}
            </button>
          ) : (
            <button
              type="button"
              style={canSubmit ? styles.btnSubmit : styles.btnSubmitDisabled}
              disabled={!canSubmit}
              aria-label={
                isSubmitting
                  ? `${submitLabel} — wird gesendet`
                  : !command
                  ? `${submitLabel} — Idee/Text fehlt`
                  : submitLabel
              }
              onClick={handleSubmit}
            >
              {isSubmitting ? 'Wird gesendet …' : submitLabel}
            </button>
          )}
        </div>

        {/* AC14: PTY-Fallback für Schritt 1 — Logik/Guards/Endpunkt (handleSubmit,
            POST /api/command, /agent-flow:new-project ohne Argument) UNVERÄNDERT,
            nur als sekundärer, demoteter Weg dargestellt (Muster S-251). */}
        {isStep1 && (
          <>
            <div style={styles.hint}>
              Technischer Fallback: startet interaktiv im Terminal (Stack-Rückfragen dort).
            </div>
            <div style={styles.buttonRow}>
              <button
                type="button"
                style={canSubmit ? styles.btnFallback : styles.btnSubmitDisabled}
                disabled={!canSubmit}
                aria-label={
                  isSubmitting
                    ? `${submitLabel} — wird gesendet`
                    : !command
                    ? `${submitLabel} — Idee/Text fehlt`
                    : `${submitLabel} (Terminal-Fallback)`
                }
                onClick={handleSubmit}
              >
                {isSubmitting ? 'Wird gesendet …' : submitLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ── ProofButton component (AC6) ───────────────────────────────────────────────

/**
 * „Let Claude proof"-Button for a single field (AC6).
 *
 * @param {{
 *   fieldId: 'primary' | 'optional',
 *   disabled: boolean,
 *   loading: boolean,
 *   onProof: () => void,
 * }} props
 */
function ProofButton({ fieldId, disabled, loading, onProof }) {
  const label = loading
    ? 'Let Claude proof — wird geladen …'
    : 'Let Claude proof';

  return (
    <button
      type="button"
      style={disabled ? styles.btnProofDisabled : styles.btnProof}
      disabled={disabled}
      aria-label={`${label} (${fieldId === 'primary' ? 'Hauptfeld' : 'Optionales Feld'})`}
      data-testid={`proof-btn-${fieldId}`}
      onClick={onProof}
    >
      {loading ? 'Wird geprüft …' : 'Let Claude proof'}
    </button>
  );
}

// ── ProofResultPanel component (AC6) ─────────────────────────────────────────

/**
 * Displays the result (or error) of a "Let Claude proof" call (AC6).
 *
 * refinedText is shown in an editable textarea; „Übernehmen" adopts it
 * into the source field.
 * openQuestions are rendered as a semantic <ul> list (not just visual).
 * Error messages use role="alert" and include text + icon (not color alone).
 *
 * @param {{
 *   fieldId: 'primary' | 'optional',
 *   proofState: 'done' | 'error',
 *   proofError: string|null,
 *   proofResult: {refinedText:string, openQuestions:Array, notes?:string}|null,
 *   refinedEdit: string,
 *   onRefinedEditChange: (val: string) => void,
 *   onAdopt: () => void,
 * }} props
 */
function ProofResultPanel({
  fieldId,
  proofState,
  proofError,
  proofResult,
  refinedEdit,
  onRefinedEditChange,
  onAdopt,
}) {
  const refinedId     = `proof-refined-${fieldId}`;
  const questionsId   = `proof-questions-${fieldId}`;
  const errorId       = `proof-error-${fieldId}`;
  const panelTestId   = `proof-result-${fieldId}`;

  return (
    <div
      style={styles.proofResultPanel}
      aria-live="polite"
      aria-atomic="false"
      data-testid={panelTestId}
    >
      <div style={styles.proofResultHeader}>
        <span style={styles.proofResultTitle}>Claude Proof</span>
        {proofState === 'error' && (
          <span style={styles.proofErrorBadge} aria-hidden="true">Fehler</span>
        )}
        {proofState === 'done' && (
          <span style={styles.proofDoneBadge} aria-hidden="true">Fertig</span>
        )}
      </div>

      {/* Error state — role=alert, text label (not color alone, design.md) */}
      {proofState === 'error' && proofError && (
        <div
          role="alert"
          id={errorId}
          style={styles.proofErrorMsg}
          data-testid={`proof-error-${fieldId}`}
        >
          <span aria-hidden="true">&#x26A0; </span>
          {proofError}
        </div>
      )}

      {/* Done state — refinedText (editable) + openQuestions list */}
      {proofState === 'done' && proofResult && (
        <>
          {/* refinedText — editable textarea so user can adjust before adopting */}
          <label style={styles.proofLabel} htmlFor={refinedId}>
            Verfeinerte Formulierung <span style={styles.optional}>(bearbeitbar)</span>
          </label>
          <textarea
            id={refinedId}
            style={styles.proofRefinedTextarea}
            value={refinedEdit}
            rows={4}
            aria-describedby={questionsId}
            data-testid={`proof-refined-${fieldId}`}
            onChange={(e) => onRefinedEditChange(e.target.value)}
          />
          {/* „Übernehmen"-Button — replaces source field content (AC6) */}
          <button
            type="button"
            style={styles.btnAdopt}
            aria-label={`Verfeinerten Text ins ${fieldId === 'primary' ? 'Hauptfeld' : 'optionale Feld'} übernehmen`}
            data-testid={`proof-adopt-${fieldId}`}
            onClick={onAdopt}
          >
            Übernehmen
          </button>

          {/* openQuestions — semantic <ul> list (not just visual, AC6 + A11y) */}
          {proofResult.openQuestions && proofResult.openQuestions.length > 0 && (
            <div id={questionsId} style={styles.proofQuestionsBox}>
              <p style={styles.proofQuestionsTitle}>
                Offene Rückfragen:
              </p>
              <ul
                style={styles.proofQuestionsList}
                aria-label="Offene Rückfragen"
                data-testid={`proof-questions-${fieldId}`}
              >
                {proofResult.openQuestions.map((q, i) => (
                  <li
                    key={q.question}
                    style={styles.proofQuestionItem}
                    data-testid={`proof-question-item-${fieldId}-${i}`}
                  >
                    <span style={styles.proofQuestionText}>{q.question}</span>
                    {q.why && (
                      <span style={styles.proofQuestionWhy}>
                        {' — '}{q.why}
                      </span>
                    )}
                    {q.options && q.options.length > 0 && (
                      <ul style={styles.proofQuestionOptions} aria-label="Optionen">
                        {q.options.map((opt) => (
                          <li key={opt} style={styles.proofQuestionOption}>{opt}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Styles (inline, dark-first, 8-pt Skala) ──────────────────────────────────

const styles = {
  dialog: {
    display: 'flex',
    flexDirection: 'column',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
    color: '#d4d4d4',
    maxWidth: 560,
    width: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderBottom: '1px solid #2a2a2a',
    background: '#0d0d0d',
    borderRadius: '8px 8px 0 0',
  },
  title: {
    fontWeight: 700,
    fontSize: 15,
    color: '#e5e7eb',
    flex: 1,
  },
  badgeNew: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 6px',
    background: '#1e3a5f',
    color: '#93c5fd',
    borderRadius: 4,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  badgeChange: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 6px',
    background: '#1a2e1a',
    color: '#86efac',
    borderRadius: 4,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  body: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  label: {
    fontSize: 12,
    color: '#9ca3af',
    marginBottom: 2,
  },
  required: {
    fontSize: 11,
    color: '#f87171',
  },
  optional: {
    fontSize: 11,
    color: '#9ca3af',
  },
  textarea: {
    background: '#1e1e1e',
    color: '#d4d4d4',
    border: '1px solid #333',
    borderRadius: 4,
    padding: '8px',
    fontSize: 13,
    fontFamily: 'system-ui, sans-serif',
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
    lineHeight: 1.5,
    // Focus ring preserved — no outline:none (design.md / coder lessons)
  },
  /** App-Slug-Eingabefeld (AC13, per-app-gpg-passphrase-provisioning) — single-line. */
  textInput: {
    background: '#1e1e1e',
    color: '#d4d4d4',
    border: '1px solid #333',
    borderRadius: 4,
    padding: '8px',
    fontSize: 13,
    fontFamily: 'system-ui, sans-serif',
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 44,
    // Focus ring preserved — no outline:none (design.md / coder lessons)
  },
  hint: {
    fontSize: 11,
    color: '#6b7280',
    fontStyle: 'italic',
  },
  /**
   * AC2 (S-133): two-step sequence status boxes.
   * Step 1 (bootstrap): amber — prominent, action required.
   * Step 2 (requirement): teal — confirms bootstrap done, proceed to idea.
   * Both use text + background pattern (not color alone; WCAG — never status by color only).
   */
  sequenceStep1: {
    padding: '8px 10px',
    background: '#1a1400',
    border: '1px solid #3a2f00',
    borderRadius: 4,
    color: '#fbbf24',
    fontSize: 12,
    lineHeight: 1.5,
    marginBottom: 4,
  },
  sequenceStep2: {
    padding: '8px 10px',
    background: '#0d1f1a',
    border: '1px solid #0f3d2e',
    borderRadius: 4,
    color: '#6ee7b7',
    fontSize: 12,
    lineHeight: 1.5,
    marginBottom: 4,
  },
  /** @deprecated S-132 placeholder — replaced by sequenceStep1/sequenceStep2 (S-133) */
  bootstrapHint: {
    padding: '8px 10px',
    background: '#1a1400',
    border: '1px solid #3a2f00',
    borderRadius: 4,
    color: '#fbbf24',
    fontSize: 12,
    lineHeight: 1.5,
    marginBottom: 4,
  },
  inlineCode: {
    fontFamily: 'monospace',
    fontSize: 11,
    background: '#2a2200',
    padding: '0 3px',
    borderRadius: 2,
    color: '#fde68a',
  },
  select: {
    background: '#1e1e1e',
    color: '#d4d4d4',
    border: '1px solid #333',
    borderRadius: 4,
    padding: '6px 8px',
    fontSize: 13,
    width: '100%',
    cursor: 'pointer',
  },
  costInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    marginTop: 4,
    marginBottom: 4,
    fontSize: 11,
    color: '#9ca3af',
  },
  costDisclaimer: {
    fontSize: 10,
    color: '#6b7280',
    fontStyle: 'italic',
  },
  preview: {
    padding: '6px 8px',
    background: '#0d0d0d',
    border: '1px solid #1e293b',
    borderRadius: 4,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    marginTop: 4,
  },
  previewLabel: {
    fontSize: 10,
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  previewCode: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#93c5fd',
    wordBreak: 'break-all',
  },
  errorMsg: {
    padding: '8px',
    background: '#1f0f0f',
    border: '1px solid #3f1010',
    borderRadius: 4,
    color: '#f87171',
    fontSize: 12,
  },
  statusMsg: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },
  buttonRow: {
    display: 'flex',
    gap: 8,
    marginTop: 8,
  },
  btnSubmit: {
    flex: 1,
    padding: '10px 16px',
    background: '#1d4ed8',
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved — no outline:none (design.md)
  },
  btnSubmitDisabled: {
    flex: 1,
    padding: '10px 16px',
    background: '#1e293b',
    color: '#64748b',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed',
    minHeight: 44,
  },
  /** Demoteter PTY-Fallback-Button (AC14, Muster S-251 — sekundär, nicht mehr Standard). */
  btnFallback: {
    flex: 1,
    padding: '10px 16px',
    background: 'transparent',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved — no outline:none (design.md)
  },

  // ── AC6 Proof styles ───────────────────────────────────────────────────────

  /** „Let Claude proof"-Button — enabled */
  btnProof: {
    padding: '5px 10px',
    background: '#1a2a1a',
    color: '#86efac',
    border: '1px solid #2d5a2d',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    alignSelf: 'flex-start',
    minHeight: 32,
  },
  /** „Let Claude proof"-Button — disabled */
  btnProofDisabled: {
    padding: '5px 10px',
    background: '#161616',
    color: '#4b5563',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'not-allowed',
    alignSelf: 'flex-start',
    minHeight: 32,
  },
  /** Container for the proof result panel */
  proofResultPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '10px 12px',
    background: '#0d1a0d',
    border: '1px solid #1e3b1e',
    borderRadius: 4,
    marginTop: 2,
  },
  proofResultHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  proofResultTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    flex: 1,
  },
  proofDoneBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '1px 5px',
    background: '#1a3a1a',
    color: '#86efac',
    borderRadius: 3,
  },
  proofErrorBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '1px 5px',
    background: '#2a0f0f',
    color: '#f87171',
    borderRadius: 3,
  },
  /** Error message in proof panel — uses text label, not color alone (design.md) */
  proofErrorMsg: {
    padding: '6px 8px',
    background: '#1f0f0f',
    border: '1px solid #3f1010',
    borderRadius: 4,
    color: '#f87171',
    fontSize: 12,
  },
  proofLabel: {
    fontSize: 11,
    color: '#9ca3af',
    marginBottom: 2,
  },
  /** Editable textarea for refinedText (AC6 — editierbar) */
  proofRefinedTextarea: {
    background: '#1a2a1a',
    color: '#d4d4d4',
    border: '1px solid #2d5a2d',
    borderRadius: 4,
    padding: '6px 8px',
    fontSize: 12,
    fontFamily: 'system-ui, sans-serif',
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
    lineHeight: 1.5,
  },
  /** „Übernehmen"-Button — adopts refinedText into source field */
  btnAdopt: {
    padding: '5px 12px',
    background: '#1d4ed8',
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    alignSelf: 'flex-start',
    minHeight: 32,
  },
  /** Box wrapping the openQuestions list */
  proofQuestionsBox: {
    marginTop: 4,
  },
  /** Heading for the openQuestions list */
  proofQuestionsTitle: {
    fontSize: 11,
    color: '#9ca3af',
    fontWeight: 600,
    marginBottom: 4,
    marginTop: 0,
  },
  /**
   * Semantic <ul> list for openQuestions (AC6 — zugängliche Liste, nicht nur visuell).
   * list-style preserved so screen-readers announce list semantics.
   */
  proofQuestionsList: {
    margin: 0,
    paddingLeft: 18,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  proofQuestionItem: {
    fontSize: 12,
    color: '#d4d4d4',
    lineHeight: 1.5,
  },
  proofQuestionText: {
    fontWeight: 500,
  },
  proofQuestionWhy: {
    color: '#9ca3af',
    fontSize: 11,
    fontStyle: 'italic',
  },
  /** Nested <ul> for options within a question (AC6 — optionale Antwort-Optionen) */
  proofQuestionOptions: {
    marginTop: 4,
    paddingLeft: 16,
    listStyle: 'disc',
  },
  proofQuestionOption: {
    fontSize: 11,
    color: '#9ca3af',
  },
};
