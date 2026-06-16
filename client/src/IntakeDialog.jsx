/**
 * IntakeDialog.jsx — Fabric-Intake-Dialog (S-132, fabric-intake-dialog).
 *
 * AC1  — Dialog in zwei Modi: `new` (Projektidee/Vision, mehrzeilig, opt. Stack/Constraints)
 *         und `change` (Was soll sich ändern?, mehrzeilig, opt. Betroffener Bereich).
 *         Mehrzeilige Freitexterfassung via <textarea>.
 *         Beide Modi feuern `/agent-flow:requirement <text>` (S-133 ergänzt später das
 *         new-project-Pre-Trigger-Sequencing — Struktur dafür ist vorbereitet).
 * AC2b — Mehrzeiliger Text wird client-seitig zu einer einzigen Zeile kollabiert
 *         (alle Steuer-/Zeilenumbrüche → einzelne Spaces, getrimmt) bevor er an
 *         `/agent-flow:requirement` gehängt wird. Leerer Text → kein Request.
 * AC4  — Nach erfolgreichem Submit (202) wechselt die Ansicht in den Terminal-Pane
 *         (via onNavigate('factory')).
 * AC9  — Cost-Mode-Schalter für `requirement` analog zu TriggerPanel (4-Wege
 *         low-cost|balanced|max-quality|frontier, Default balanced → kein --cost-Flag).
 *         Shared via costMode.js (keine Duplikation).
 *
 * Design constraints (docs/design.md):
 *   - Dark-first, 8-pt Spacing-Skala, UI-Sans für Panels.
 *   - Status nie nur über Farbe (WCAG 2.1 AA); Labels vorhanden.
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
 * Covers (fabric-intake-dialog): AC1, AC2b, AC4, AC9
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

// ── IntakeDialog component ────────────────────────────────────────────────────

/**
 * IntakeDialog — structured intake for idea/change requests.
 *
 * @param {{
 *   mode: 'new' | 'change',
 *   onNavigate: (view: string) => void,
 *   fetchFn?: Function,
 *   projectPath?: string,
 * }} props
 *   mode        — 'new' (Projektidee) or 'change' (Änderungswunsch).
 *   onNavigate  — navigates to 'factory' after successful submit (AC4).
 *   fetchFn     — injectable for tests (default: global fetch).
 *   projectPath — when set, sent as projectPath in POST body for project-session routing.
 */
export function IntakeDialog({ mode = 'change', onNavigate, fetchFn, projectPath }) {
  // ── Field state ──────────────────────────────────────────────────────────
  /** Primary idea/change textarea */
  const [ideaText, setIdeaText]         = useState('');
  /** Optional secondary field (stack/constraints for 'new'; area for 'change') */
  const [optionalText, setOptionalText] = useState('');
  /** Cost-mode for requirement (AC9) — default 'balanced' → no flag */
  const [costMode, setCostMode]         = useState('balanced');

  // ── Submit state ─────────────────────────────────────────────────────────
  /** 'idle' | 'submitting' | 'error' */
  const [submitState, setSubmitState]   = useState('idle');
  /** Error message text */
  const [errorMsg, setErrorMsg]         = useState(null);

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

  // ── Derived labels ───────────────────────────────────────────────────────

  const isNew = mode === 'new';

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

  const submitLabel = isNew
    ? 'Idee erfassen'
    : 'Änderung erfassen';

  // ── Submit handler ───────────────────────────────────────────────────────

  /**
   * Compose the requirement command line:
   * 1. Collapse ideaText + optionalText to single lines (AC2b).
   * 2. Concatenate into one space-separated argument string.
   * 3. Prepend cost flag when not 'balanced' (AC9).
   *
   * Returns null when the result is empty (guard for AC2b: leerer Text → kein Request).
   *
   * @returns {string|null}
   */
  const composeCommand = useCallback(() => {
    const collapsed     = collapseToLine(ideaText);
    const collapsedOpt  = collapseToLine(optionalText);

    // Build the argument: primary text + optional text separated by a space.
    // Both are already single-line; join only when both non-empty.
    const parts = [collapsed, collapsedOpt].filter(Boolean);
    const argument = parts.join(' ');

    if (!argument) return null; // AC2b: leerer Text → kein Request

    const cost = costFlag(REQUIREMENT_CMD, costMode);
    return `${REQUIREMENT_CMD}${cost} ${argument}`;
  }, [ideaText, optionalText, costMode]);

  const handleSubmit = useCallback(async () => {
    const command = composeCommand();
    if (!command) return; // AC2b: guard — empty text

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
      // AC4: nach erfolgreichem Submit → Terminal-Pane
      setSubmitState('idle');
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
  }, [composeCommand, onNavigate, projectPath]);

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
        {/* I2: new-mode aria-live hint — bootstrap prerequisite (removed once S-133 lands) */}
        {isNew && (
          <div
            role="note"
            aria-live="polite"
            id="intake-new-bootstrap-hint"
            style={styles.bootstrapHint}
            data-testid="intake-new-bootstrap-hint"
          >
            Noch kein new-project-Bootstrap ausgelöst. Bitte zuerst im Trigger-Panel{' '}
            <code style={styles.inlineCode}>/agent-flow:new-project</code> starten, dann
            hier die Idee erfassen.
          </div>
        )}

        {/* Primary textarea — receives focus on mount (A11y) */}
        <label style={styles.label} htmlFor="intake-idea">
          {primaryLabel} <span style={styles.required}>(Pflicht)</span>
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
          aria-required="true"
          aria-describedby="intake-idea-hint"
          onChange={(e) => setIdeaText(e.target.value)}
        />
        <div id="intake-idea-hint" style={styles.hint}>
          Mehrere Zeilen möglich — wird beim Senden zu einer Zeile zusammengefasst.
        </div>

        {/* Optional secondary field — I3: aria-describedby analogous to primary */}
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

        {/* Cost-Mode switch (AC9) — requirement is cost-aware */}
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

        {/* Command preview (informational — shows what will be sent) */}
        {/* S1: use derived `command` constant instead of calling composeCommand() */}
        {command !== null && (
          <div style={styles.preview} aria-live="polite" data-testid="intake-preview">
            <span style={styles.previewLabel}>Befehl:</span>
            <code style={styles.previewCode}>{command}</code>
          </div>
        )}

        {/* Error message */}
        {submitState === 'error' && errorMsg && (
          <div
            role="alert"
            id="intake-error"
            style={styles.errorMsg}
          >
            {errorMsg}
          </div>
        )}

        {/* Submitting indicator */}
        {isSubmitting && (
          <div role="status" aria-live="polite" style={styles.statusMsg}>
            Wird gesendet …
          </div>
        )}

        {/* Submit button */}
        <div style={styles.buttonRow}>
          <button
            type="button"
            style={canSubmit ? styles.btnSubmit : styles.btnSubmitDisabled}
            disabled={!canSubmit}
            aria-disabled={!canSubmit}
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
        </div>
      </div>
    </section>
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
  hint: {
    fontSize: 11,
    color: '#6b7280',
    fontStyle: 'italic',
  },
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
};
