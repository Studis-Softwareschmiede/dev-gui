/**
 * IdeaResolveModal.jsx — Explizite Auflösung „Idee auflösen" (ideen-inbox AC6, S-200).
 *
 * Finding 3 (S-200 Iteration 2 Review): die Spec nennt im „Neu zu bauen"-Abschnitt
 * explizit „Owner-Aktion + UI" für die Auflösung — bislang existierte nur der
 * Backend-Endpunkt (`POST .../ideas/:id/resolve`), aber kein GUI-Trigger. Diese
 * Komponente ist die minimale Resolve-UI (kein Polish): ein kleines Formular mit
 * zwei OPTIONALEN Feldern (resolved_story_ids, resolved_note).
 *
 * Covers (ideen-inbox):
 *   AC6 — Formular mit optionaler Komma-Liste `resolved_story_ids` + optionalem
 *          `resolved_note`. Absenden → POST .../ideas/:id/resolve. Bei Erfolg (200)
 *          schließt das Modal und ruft `onResolved(storyId)` — der Aufrufer (BoardView)
 *          markiert die Idee lokal als `Done` (verschwindet aus der „Idee"-Spalte).
 *          400/404 → Fehlermeldung inline, Modal bleibt offen (Owner kann korrigieren
 *          oder abbrechen).
 *
 * Nicht-Ziele (spiegelt Spec):
 *   Kein Agenten-Aufruf — reiner Board-Write (AC6 Contract, kein Agent-Dispatch).
 *   Keine Validierung der resolved_story_ids-Werte gegen echte Story-IDs im Frontend —
 *          das übernimmt serverseitig `BoardWriter.validateResolveInput()` (400 bei
 *          ungültigem Payload); dieses Modal übernimmt Feldfehler unverändert zur Anzeige.
 *
 * A11y (WCAG 2.1 AA, analog IdeaCaptureModal.jsx):
 *   - role="dialog" + aria-modal="true" + aria-labelledby.
 *   - Esc schließt, Fokus-Rückgabe an den Trigger-Button (triggerRef).
 *   - Erstes Feld erhält beim Öffnen den Fokus.
 *   - Sichtbarer Fokusring (kein outline:none); Touch-Targets ≥ 44 px.
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML.
 *   - Sanitisierung/Validierung liegt serverseitig (BoardWriter.validateResolveInput,
 *     resolveIdea) — dieses Modal übernimmt 400-Feldfehler unverändert zur Anzeige,
 *     erfindet keine eigene Validierungslogik.
 *
 * @param {{
 *   projectSlug: string,
 *   storyId: string,
 *   storyTitle?: string,
 *   onClose: () => void,
 *   onResolved: (storyId: string) => void,
 *   triggerRef?: React.RefObject,
 *   fetchFn?: Function,
 * }} props
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export function IdeaResolveModal({ projectSlug, storyId, storyTitle, onClose, onResolved, triggerRef, fetchFn }) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);

  const [resolvedStoryIdsText, setResolvedStoryIdsText] = useState('');
  const [resolvedNote, setResolvedNote] = useState('');
  const [saving, setSaving] = useState(false);
  /** @type {[{ field?: string, message: string }|null, Function]} */
  const [error, setError] = useState(null);

  const dialogRef = useRef(null);

  const handleClose = useCallback(() => {
    if (saving) return; // Doppel-Feuer-/Verlust-Schutz: kein Schließen während des Speicherns
    onClose();
    if (triggerRef?.current) triggerRef.current.focus();
  }, [saving, onClose, triggerRef]);

  // Fokus auf das erste Feld beim Öffnen; Esc schließt (analog IdeaCaptureModal).
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

  async function handleSubmit() {
    if (saving) return;
    setSaving(true);
    setError(null);

    // Komma-Liste → trimmed, nicht-leere Einträge; leer bleibt undefined (Feld optional).
    const ids = resolvedStoryIdsText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');

    const body = {
      ...(ids.length > 0 ? { resolved_story_ids: ids } : {}),
      ...(resolvedNote.trim() ? { resolved_note: resolvedNote.trim() } : {}),
    };

    let res;
    try {
      res = await fetch_(
        `/api/board/projects/${encodeURIComponent(projectSlug)}/ideas/${encodeURIComponent(storyId)}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
    } catch {
      setSaving(false);
      setError({ message: 'Netzwerkfehler — bitte erneut versuchen.' });
      return;
    }

    if (res.status === 200) {
      setSaving(false);
      onResolved(storyId);
      onClose();
      if (triggerRef?.current) triggerRef.current.focus();
      return;
    }

    if (res.status === 400) {
      let data = {};
      try { data = await res.json(); } catch { /* ignore — kein Body */ }
      setSaving(false);
      setError({ field: data.field, message: data.message ?? 'Idee ist nicht (mehr) auflösbar.' });
      return;
    }

    if (res.status === 404) {
      setSaving(false);
      setError({ message: 'Idee nicht gefunden.' });
      return;
    }

    setSaving(false);
    setError({ message: `Fehler beim Auflösen (HTTP ${res.status}).` });
  }

  const titleId = 'idea-resolve-modal-title';

  return (
    <>
      {/* Backdrop */}
      <div
        style={styles.backdrop}
        onClick={saving ? undefined : handleClose}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={styles.dialog}
        data-testid="idea-resolve-modal"
      >
        <h2 id={titleId} style={styles.heading}>Idee auflösen</h2>
        <p style={styles.hint}>
          {storyTitle ? `„${storyTitle}" ` : ''}wird auf Done gesetzt und mit den erzeugten Stories verlinkt (beides optional).
        </p>

        <label style={styles.label} htmlFor="idea-resolve-story-ids-input">
          Erzeugte Story-IDs (optional, kommagetrennt)
        </label>
        <input
          id="idea-resolve-story-ids-input"
          type="text"
          style={styles.input}
          value={resolvedStoryIdsText}
          onChange={(e) => setResolvedStoryIdsText(e.target.value)}
          placeholder="z.B. S-201, S-202"
          aria-label="Erzeugte Story-IDs"
          data-testid="idea-resolve-story-ids-input"
        />

        <label style={styles.label} htmlFor="idea-resolve-note-input">
          Notiz (optional)
        </label>
        <textarea
          id="idea-resolve-note-input"
          style={styles.textarea}
          value={resolvedNote}
          onChange={(e) => setResolvedNote(e.target.value)}
          rows={4}
          placeholder="z.B. Verweis auf die entstandene Spec…"
          aria-label="Auflösungs-Notiz"
          data-testid="idea-resolve-note-input"
        />

        {error && (
          <div role="alert" style={styles.error} data-testid="idea-resolve-error">
            {error.message}
          </div>
        )}

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={saving ? styles.btnDisabled : styles.btnPrimary}
            disabled={saving}
            aria-disabled={saving}
            onClick={handleSubmit}
            data-testid="idea-resolve-submit-btn"
          >
            {saving ? 'Löse auf…' : 'Auflösen'}
          </button>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleClose}
            data-testid="idea-resolve-cancel-btn"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </>
  );
}

// ── Styles (analog IdeaCaptureModal.jsx) ──────────────────────────────────────

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
    minWidth: 360,
    maxWidth: 480,
    maxHeight: '85vh',
    overflowY: 'auto',
    color: '#e5e7eb',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
  },

  heading: {
    margin: '0 0 4px',
    fontSize: 18,
    fontWeight: 700,
    color: '#f0f9ff',
  },

  hint: {
    margin: '0 0 16px',
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

  input: {
    width: '100%',
    background: '#111',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 14,
    padding: '9px 10px',
    marginBottom: 14,
    fontFamily: 'system-ui, sans-serif',
    boxSizing: 'border-box',
    minHeight: 40,
  },

  textarea: {
    width: '100%',
    minHeight: 84,
    background: '#111',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '8px 10px',
    marginBottom: 14,
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
