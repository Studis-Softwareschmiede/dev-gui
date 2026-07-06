/**
 * NewProjectChooserDialog.jsx — Auswahl-Dialog-Shell für den Fabrik-Übersichts-
 * Einstieg (docs/specs/neues-projekt-auswahl-dialog.md, S-302, AC1/AC2/AC8).
 *
 * Ersetzt den bisherigen direkten Sprung von „+ Neues Projekt / Idee erfassen"
 * in den `IntakeDialog`-`new`-Modus: der Button öffnet zuerst DIESEN
 * Auswahl-Dialog mit genau drei gleichwertigen Optionen — „Neues Projekt",
 * „Aus Obsidian übernehmen", „Adopt". A11y-/Struktur-Muster (Backdrop, Fokus
 * beim Öffnen, `Esc` schließt, Fokus-Rückgabe an `triggerRef`) 1:1 aus
 * `ObsidianIngestOverlay.jsx` übernommen.
 *
 * Scope dieser Story (S-302, `implements: [AC1, AC2, AC8]`):
 *   - AC1: die Drei-Optionen-Shell selbst (schließbar, A11y).
 *   - AC2: Option „Neues Projekt" rendert den bestehenden `IntakeDialog` im
 *          `new`-Modus unverändert (gleiche Props/Sequenz/Handler wie zuvor
 *          direkt in RepoOverview).
 *   - AC8 (NFR): reiner Frontend-Change, keine neue Boundary.
 *
 * NICHT Scope dieser Story (Folge-Story S-303, `depends: [S-302]`):
 *   - AC3 — die vollständige Migration von `ObsidianImportSection` aus
 *     `GitHubView.jsx` hierher (inkl. Entfernen der Sektion dort + Test-
 *     Migration). Diese Story bindet die bereits eigenständige, getestete
 *     Komponente (S-300) hier zusätzlich lesend ein — `GitHubView.jsx` bleibt
 *     unverändert (Verhalten dort bleibt bestehen, kein Verlust).
 *   - AC4–AC7 — die inhaltliche Detail-UX des Adopt-Wegs. Die bereits
 *     eigenständige, getestete `AdoptSection`-Komponente (S-301) wird hier nur
 *     EINGEBUNDEN (Mount-Punkt), ihr Verhalten ist durch AdoptSection.test.jsx
 *     abgedeckt.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   fetchFn?: typeof fetch,
 *   triggerRef?: React.RefObject,
 *   renderNewProject: () => React.ReactNode,
 *   onSelectNewProject?: () => void,
 * }} props
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ObsidianImportSection } from './ObsidianImportSection.jsx';
import { AdoptSection } from './AdoptSection.jsx';

/**
 * NewProjectChooserDialog — Drei-Wege-Auswahl (AC1) + „Neues Projekt"-Mount
 * (AC2) + Obsidian-/Adopt-Einbindung (bestehende, eigenständige Komponenten).
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   fetchFn?: typeof fetch,
 *   triggerRef?: React.RefObject,
 *   renderNewProject: () => React.ReactNode,
 *   onSelectNewProject?: () => void,
 *   onNavigate?: (view: string) => void,
 * }} props
 */
export function NewProjectChooserDialog({
  open,
  onClose,
  fetchFn,
  triggerRef,
  renderNewProject,
  onSelectNewProject,
  onNavigate,
}) {
  /** 'choice' | 'new' | 'obsidian' | 'adopt' */
  const [selected, setSelected] = useState('choice');
  const dialogRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Reset back to the choice screen whenever the dialog (re-)opens.
  useEffect(() => {
    if (open) setSelected('choice');
  }, [open]);

  /**
   * AC2: Auswahl „Neues Projekt" öffnet den IntakeDialog SOFORT (kein
   * zusätzlicher Zwischenklick) — der Parent (RepoOverview) hält den
   * eigentlichen `intakeNewOpen`-State weiterhin selbst (unverändert AC2).
   */
  const handleSelectNewProject = useCallback(() => {
    setSelected('new');
    if (onSelectNewProject) onSelectNewProject();
  }, [onSelectNewProject]);

  const handleClose = useCallback(() => {
    // AC1: schließbar, ohne einen Weg auszulösen — kein Trigger hier, nur close.
    onClose();
    if (triggerRef?.current) triggerRef.current.focus();
  }, [onClose, triggerRef]);

  // Fokus beim Öffnen; Esc schließt (Muster: ObsidianIngestOverlay.jsx).
  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const focusable = dialog.querySelectorAll('input, textarea, button:not([disabled]), [tabindex]');
    if (focusable.length > 0) focusable[0].focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') handleClose();
    }
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose, selected]);

  if (!open) return null;

  const titleId = 'new-project-chooser-title';

  return (
    <>
      {/* Backdrop — schließt bei Klick (Muster ObsidianIngestOverlay). */}
      <div style={styles.backdrop} onClick={handleClose} aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={styles.dialog}
        data-testid="new-project-chooser-dialog"
      >
        <div style={styles.headerRow}>
          <h2 id={titleId} style={styles.heading}>Projekt in die Fabrik holen</h2>
          <button
            type="button"
            style={styles.btnClose}
            onClick={handleClose}
            aria-label="Auswahl-Dialog schließen"
            data-testid="chooser-close-btn"
          >
            ✕
          </button>
        </div>

        {selected === 'choice' && (
          <div style={styles.optionList} role="list" aria-label="Wege, ein Projekt in die Fabrik zu holen">
            <ChoiceOption
              testId="chooser-option-new"
              title="Neues Projekt"
              subtitle="Idee erfassen — Scaffold + Requirement-Lauf starten."
              onSelect={handleSelectNewProject}
            />
            <ChoiceOption
              testId="chooser-option-obsidian"
              title="Aus Obsidian übernehmen"
              subtitle="Projektordner aus dem konfigurierten Obsidian-Vault übernehmen."
              onSelect={() => setSelected('obsidian')}
            />
            <ChoiceOption
              testId="chooser-option-adopt"
              title="Adopt"
              subtitle="Eine bestehende GitHub-Repo-URL übernehmen (Fork bei Bedarf)."
              onSelect={() => setSelected('adopt')}
            />
          </div>
        )}

        {selected !== 'choice' && (
          <button
            type="button"
            style={styles.btnBack}
            onClick={() => setSelected('choice')}
            aria-label="Zurück zur Auswahl"
            data-testid="chooser-back-btn"
          >
            ← Zurück zur Auswahl
          </button>
        )}

        {/* AC2: „Neues Projekt" — bestehender IntakeDialog new-Modus, unverändert. */}
        {selected === 'new' && (
          <div data-testid="chooser-new-project-mount">
            {renderNewProject()}
          </div>
        )}

        {/* Bestehende, eigenständige Komponente (S-300) — Mount-Ort-Einbindung. */}
        {selected === 'obsidian' && (
          <div data-testid="chooser-obsidian-mount">
            <ObsidianImportSection fetchFn={fetchFn} onNavigate={onNavigate} />
          </div>
        )}

        {/* Bestehende, eigenständige Komponente (S-301) — Mount-Ort-Einbindung. */}
        {selected === 'adopt' && (
          <div data-testid="chooser-adopt-mount">
            <AdoptSection fetchFn={fetchFn} />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Eine der drei gleichwertigen Auswahl-Optionen (AC1): Touch-Target ≥ 44 px,
 * Tastatur-erreichbar (natives <button>), sichtbarer Fokusring (kein
 * outline:none).
 *
 * @param {{ testId: string, title: string, subtitle: string, onSelect: () => void }} props
 */
function ChoiceOption({ testId, title, subtitle, onSelect }) {
  return (
    <button
      type="button"
      role="listitem"
      style={styles.optionBtn}
      onClick={onSelect}
      data-testid={testId}
      aria-label={`${title} — ${subtitle}`}
    >
      <span style={styles.optionTitle}>{title}</span>
      <span style={styles.optionSubtitle}>{subtitle}</span>
    </button>
  );
}

// ── Styles (Muster: ObsidianIngestOverlay.jsx) ───────────────────────────────

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
    minWidth: 480,
    maxWidth: 640,
    maxHeight: '85vh',
    overflowY: 'auto',
    color: '#e5e7eb',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  heading: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    color: '#f0f9ff',
  },
  btnClose: {
    background: 'transparent',
    color: '#9ca3af',
    border: '1px solid #374151',
    borderRadius: 4,
    minWidth: 44,
    minHeight: 44,
    fontSize: 16,
    cursor: 'pointer',
    flexShrink: 0,
    // Focus ring preserved (no outline:none — WCAG 2.1 SC 2.4.7)
  },
  btnBack: {
    alignSelf: 'flex-start',
    background: 'transparent',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 4,
    padding: '8px 14px',
    fontSize: 13,
    minHeight: 44,
    cursor: 'pointer',
    // Focus ring preserved (no outline:none)
  },
  optionList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  optionBtn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    width: '100%',
    minHeight: 56,
    padding: '12px 16px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left',
    color: '#e5e7eb',
    // Focus ring preserved (no outline:none — WCAG 2.1 SC 2.4.7)
  },
  optionTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: '#f0f9ff',
  },
  optionSubtitle: {
    fontSize: 12,
    color: '#9ca3af',
    lineHeight: 1.4,
  },
};
