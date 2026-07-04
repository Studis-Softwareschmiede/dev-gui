/**
 * IdeaCaptureModal.jsx — Quick-Capture-Modal „Idee" (ideen-inbox AC3/AC4).
 *
 * Covers (ideen-inbox):
 *   AC4 — Modal mit Einzeiler-Titel (Pflicht) + optionalem mehrzeiligem
 *          Stichwort-Body. Bewusst minimal — kein Spec-/AC-Zwang. Leerer Titel
 *          → Speichern deaktiviert (spiegelt die AC3-Validierung serverseitig).
 *          Speichern → POST /api/board/projects/:slug/ideas; 201 → Modal
 *          schließt sofort. Die neue Karte erscheint beim nächsten Blick auf
 *          die „Idee"-Spalte automatisch (BoardAggregator-Watcher invalidiert
 *          den Index bei Dateiänderung, dev-gui-board-aggregator AC9 — kein
 *          zusätzlicher expliziter Rescan-Call nötig).
 *          400 (leerer/zu langer Titel oder Body) → Fehlermeldung inline,
 *          Modal bleibt offen (Owner kann korrigieren).
 *
 * Nicht-Ziele (S-199, spiegelt Spec):
 *   Kein Agenten-Aufruf, kein /flow/-Trigger — reiner Board-Write (AC3 Contract).
 *   Keine Besprechung/Beförderung (Karte-Klick → Dialog) — das ist S-200/AC5-AC6.
 *
 * A11y (WCAG 2.1 AA, analog TrainDialog.jsx):
 *   - role="dialog" + aria-modal="true" + aria-labelledby.
 *   - Esc schließt, Fokus-Rückgabe an den Trigger-Button (triggerRef).
 *   - Erstes Feld erhält beim Öffnen den Fokus.
 *   - Sichtbarer Fokusring (kein outline:none); Touch-Targets ≥ 44 px.
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML.
 *   - Sanitisierung/Längenlimits (Steuerzeichen, Längenlimit) liegen serverseitig
 *     (BoardWriter.createIdea, AC8) — dieses Modal übernimmt 400-Feldfehler
 *     unverändert zur Anzeige, erfindet keine eigene Validierungslogik.
 *
 * @param {{
 *   projectSlug: string,
 *   onClose: () => void,
 *   triggerRef?: React.RefObject,
 *   fetchFn?: Function,
 * }} props
 */

import { AreaSelect } from './AreaSelect.jsx';
import { useState, useEffect, useRef, useCallback } from 'react';

export function IdeaCaptureModal({ projectSlug, onClose, triggerRef, fetchFn }) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);

  const [title, setTitle] = useState('');
  // story-idee-bereich-zuordnung AC1/AC2 (S-291): Bereichs-Auswahl oberhalb des Titels.
  // areaReady=false (Load fehlgeschlagen) -> Bestands-Verhalten ohne Pflichtfeld.
  const [area, setArea] = useState(null);
  const [areaReady, setAreaReady] = useState(false);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  /** @type {[{ field?: string, message: string }|null, Function]} */
  const [error, setError] = useState(null);

  const dialogRef = useRef(null);

  const handleClose = useCallback(() => {
    if (saving) return; // Doppel-Feuer-/Verlust-Schutz: kein Schließen während des Speicherns
    onClose();
    if (triggerRef?.current) triggerRef.current.focus();
  }, [saving, onClose, triggerRef]);

  // Fokus auf das erste Feld beim Öffnen; Esc schließt (analog TrainDialog).
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

  // AC5-Anteil: mit funktionierender Bereichsliste ist Speichern ohne Bereich deaktiviert.
  const canSave = title.trim() !== '' && !saving && (!areaReady || area != null);

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);

    let res;
    try {
      res = await fetch_(`/api/board/projects/${encodeURIComponent(projectSlug)}/ideas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, ...(body.trim() ? { body } : {}), ...(area ? { area } : {}) }),
      });
    } catch {
      setSaving(false);
      setError({ message: 'Netzwerkfehler — bitte erneut versuchen.' });
      return;
    }

    if (res.status === 201) {
      setSaving(false);
      onClose();
      if (triggerRef?.current) triggerRef.current.focus();
      return;
    }

    if (res.status === 400) {
      let data = {};
      try { data = await res.json(); } catch { /* ignore — kein Body */ }
      setSaving(false);
      setError({ field: data.field, message: data.message ?? 'Ungültige Eingabe.' });
      return;
    }

    setSaving(false);
    setError({ message: `Fehler beim Anlegen (HTTP ${res.status}).` });
  }

  const titleId = 'idea-capture-modal-title';

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
        data-testid="idea-capture-modal"
      >
        <h2 id={titleId} style={styles.heading}>Idee erfassen</h2>
        <p style={styles.hint}>
          Stichworte in Sekunden ins Board werfen — kein Spec-/AC-Zwang.
        </p>

        {/* AC1: Bereichs-Dropdown OBERHALB des Titelfelds */}
        <AreaSelect
          projectSlug={projectSlug}
          value={area}
          onChange={setArea}
          onReady={setAreaReady}
          idPrefix="idea-capture-area"
          fetchFn={fetchFn}
        />

        <label style={styles.label} htmlFor="idea-capture-title-input">
          Titel
        </label>
        <input
          id="idea-capture-title-input"
          type="text"
          style={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="z.B. Dark-Mode für die Übersicht"
          aria-label="Titel der Idee"
          data-testid="idea-title-input"
        />

        <label style={styles.label} htmlFor="idea-capture-body-input">
          Stichworte (optional)
        </label>
        <textarea
          id="idea-capture-body-input"
          style={styles.textarea}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder="Freie Stichwort-Notizen…"
          aria-label="Stichwort-Body der Idee"
          data-testid="idea-body-input"
        />

        {error && (
          <div role="alert" style={styles.error} data-testid="idea-error">
            {error.message}
          </div>
        )}

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={canSave ? styles.btnPrimary : styles.btnDisabled}
            disabled={!canSave}
            aria-disabled={!canSave}
            onClick={handleSave}
            data-testid="idea-save-btn"
          >
            {saving ? 'Speichere…' : 'Speichern'}
          </button>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleClose}
            data-testid="idea-cancel-btn"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </>
  );
}

// ── Styles (analog TrainDialog.jsx) ───────────────────────────────────────────

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
    minHeight: 100,
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
