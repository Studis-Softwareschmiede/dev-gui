/**
 * RepoOverview.jsx — Repo-Übersicht der lokalen Klone (AC1).
 *
 * projekt-cockpit-navigation:
 *   AC1 — Zeigt die Liste der lokalen Klone aus GET /api/workspace/repos:
 *          je Repo Name, Branch, dirty-Status, letzter Commit. Read-only.
 *          Loading-, Error- und Empty-State vorhanden.
 *   AC2 — Klick auf einen Repo-Eintrag setzt den Projekt-Kontext via navigateFactory(name).
 *
 * fabric-intake-dialog:
 *   AC1 — „Neues Projekt / Idee erfassen"-Button öffnet IntakeDialog (mode="new").
 *          onNavigate('factory') nach erfolgreichem Submit (AC4).
 *   AC2 — new-mode zwei-Trigger-Sequenz: newStep und heldIdeaText werden im Parent
 *          gehalten (nicht nur lokal im Dialog), damit sie den Pane-Wechsel nach
 *          Terminal (onNavigate('factory')) überleben. IntakeDialog nimmt diese Props
 *          entgegen und ruft onNewStepChange/onIdeaTextChange bei Änderungen.
 *          Nach Abschluss von Trigger 2 (und bei explizitem Schließen) wird der
 *          Sequenz-State zurückgesetzt (resetNewSequence), damit ein erneutes Öffnen
 *          sauber in Schritt 1 startet (kein Bootstrap-Skip bei Wiedereröffnung).
 *
 * A11y (WCAG 2.1 AA):
 *   - <main> mit aria-label.
 *   - aria-busy / aria-live für Ladezustand.
 *   - Sichtbarer Fokusring — KEIN outline:none.
 *   - Touch-Targets ≥ 44 px für den Auswahl-Button.
 *   - Status/Dirty-Badge: Text + Farbe (Bedeutung nicht allein über Farbe).
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML.
 *   - Nur /api/workspace/repos (hinter AccessGuard).
 *   - Keine Secrets im Bundle.
 *
 * taktgeber-nachtwaechter (S-197 — AC17):
 *   Kompakte Statusanzeige (`NightWatchStatusBadge`, eigenständige Komponente, additiv
 *   eingebunden) in der Header-Zeile: aktiv/pausiert, im/außerhalb Fenster, aktuell
 *   laufende Drains.
 *
 * claude-auth-health (S-209 — AC5):
 *   Panel-Badge (`ClaudeAuthBadge`, eigenständige Komponente, additiv eingebunden)
 *   in derselben Header-Zeile: „Claude-Auth: ok/abgelaufen/unbekannt", bei
 *   abgelaufen mit Erneuerungs-Hinweis (`claude setup-token`).
 *
 * @param {{
 *   navigateFactory: (repo: string | null) => void,
 *   onNavigate?: (view: string) => void,
 *   fetchFn?: typeof fetch,
 * }} props
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { IntakeDialog } from './IntakeDialog.jsx';
import { NightWatchStatusBadge } from './NightWatchStatusBadge.jsx';
import { ClaudeAuthBadge } from './ClaudeAuthBadge.jsx';

/**
 * @param {{
 *   navigateFactory: (repo: string | null) => void,
 *   onNavigate?: (view: string) => void,
 *   fetchFn?: typeof fetch,
 * }} props
 */
export function RepoOverview({ navigateFactory, onNavigate, fetchFn }) {
  const [loadState, setLoadState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [loadError, setLoadError] = useState('');
  const [repos, setRepos] = useState([]);

  // ── Intake-Dialog state (AC1, AC2 — fabric-intake-dialog, new mode) ────────
  const [intakeNewOpen, setIntakeNewOpen] = useState(false);

  /**
   * AC2 (S-133): two-trigger sequence step for new-mode.
   * Held in parent (not in IntakeDialog) so it survives unmounting when the
   * user navigates to the Terminal pane after Trigger 1 (onNavigate → remount).
   * @type {'trigger1' | 'trigger2'}
   */
  const [newStep, setNewStep] = useState('trigger1');

  /**
   * AC2 (S-133): ideaText held in parent across remounts.
   * The user enters their idea in step 1 and it must still be available for
   * step 2 after the Bootstrap pane-switch (dialog unmounts on navigate).
   * @type {string}
   */
  const [heldIdeaText, setHeldIdeaText] = useState('');

  const handleIntakeNewOpen = useCallback(() => {
    setIntakeNewOpen(true);
  }, []);

  /**
   * Reset the new-mode sequence state to its initial values.
   * Called after Trigger 2 completes (dialog closes) and on explicit close,
   * so a re-opened dialog always starts clean in step 1 with an empty field
   * (AC2 — prevents Bootstrap-skip on repeated use, seen-in: S-133 I1).
   */
  const resetNewSequence = useCallback(() => {
    setNewStep('trigger1');
    setHeldIdeaText('');
  }, []);

  const handleIntakeNewClose = useCallback(() => {
    setIntakeNewOpen(false);
    // Reset sequence so a future re-open starts in step 1 (AC2, I1).
    resetNewSequence();
  }, [resetNewSequence]);

  /**
   * AC2 (S-133): signals that the step just advanced (Trigger 1 → Trigger 2).
   * Used to distinguish "keep open after trigger1" from "close after trigger2"
   * inside handleIntakeNewNavigate where React state batching prevents reading
   * the freshly-set newStep value synchronously.
   */
  const stepJustAdvancedRef = useRef(false);

  const handleIntakeNewStepChange = useCallback((step) => {
    setNewStep(step);
    // Signal to handleIntakeNewNavigate that the step just advanced
    // (Trigger 1 completed → keep dialog open).
    stepJustAdvancedRef.current = true;
  }, []);

  /**
   * AC4 (S-133): called by IntakeDialog after each successful 202.
   *
   * After Trigger 1 (new-project): onNewStepChange has already advanced
   * stepJustAdvancedRef to true BEFORE this callback fires. Keep dialog OPEN
   * (user needs to trigger step 2 once bootstrap is done in the terminal).
   * onNavigate navigates to factory terminal pane (AC4).
   *
   * After Trigger 2 (requirement): stepJustAdvancedRef is false.
   * Close dialog + navigate, then reset sequence so re-opening starts clean
   * (AC2, I1 — prevents stale step/idea on repeated use).
   */
  const handleIntakeNewNavigate = useCallback((view) => {
    const justAdvanced = stepJustAdvancedRef.current;
    stepJustAdvancedRef.current = false; // reset for next call

    if (!justAdvanced) {
      // Trigger 2 (requirement) completed → close dialog and reset sequence.
      setIntakeNewOpen(false);
      resetNewSequence();
    }
    // For Trigger 1: dialog stays open (justAdvanced=true), user sees step 2.
    if (onNavigate) onNavigate(view);
  }, [onNavigate, resetNewSequence]);

  // Load once on mount (AC1)
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError('');

    fetch('/api/workspace/repos')
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        // API returns array directly or wrapped in { repos: [...] }
        const list = Array.isArray(data) ? data : (data.repos ?? []);
        setRepos(list);
        setLoadState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err.message || 'Netzwerkfehler');
        setLoadState('error');
      });

    return () => { cancelled = true; };
  }, []); // mount once

  const isEmpty = loadState === 'ok' && repos.length === 0;
  const hasRepos = loadState === 'ok' && repos.length > 0;

  return (
    <main style={styles.main} aria-label="Repo-Übersicht">
      <div style={styles.headerRow}>
        <h1 style={styles.h1}>Fabrik — Projekt wählen</h1>
        {/* taktgeber-nachtwaechter S-197 AC17: kompakte Statusanzeige */}
        <NightWatchStatusBadge fetchFn={fetchFn} />
        {/* claude-auth-health S-209 AC5: Panel-Badge Claude-Auth ok/abgelaufen/unbekannt */}
        <ClaudeAuthBadge fetchFn={fetchFn} />
        {/* AC1 fabric-intake-dialog: new-mode trigger */}
        {!intakeNewOpen ? (
          <button
            type="button"
            style={styles.btnNewProject}
            onClick={handleIntakeNewOpen}
            aria-label="Neues Projekt / Idee erfassen — öffnet Intake-Dialog"
            data-testid="intake-new-btn"
          >
            + Neues Projekt / Idee erfassen
          </button>
        ) : (
          <button
            type="button"
            style={styles.btnNewProjectClose}
            onClick={handleIntakeNewClose}
            aria-label="Intake-Dialog schließen"
            data-testid="intake-new-close-btn"
          >
            ✕ Schließen
          </button>
        )}
      </div>

      {/* Intake-Dialog (new mode) — visible when intakeNewOpen.
          AC2 (S-133): newStep and heldIdeaText are held here (parent) so they
          survive when IntakeDialog unmounts/remounts during navigation.
          onNewStepChange and onIdeaTextChange lift state back to parent. */}
      {intakeNewOpen && (
        <div style={styles.intakeNewWrapper} data-testid="intake-new-dialog-wrapper">
          <IntakeDialog
            mode="new"
            onNavigate={handleIntakeNewNavigate}
            newStep={newStep}
            onNewStepChange={handleIntakeNewStepChange}
            heldIdeaText={heldIdeaText}
            onIdeaTextChange={setHeldIdeaText}
          />
        </div>
      )}

      {/* Loading */}
      {loadState === 'loading' && (
        <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
          Lade lokale Repos…
        </div>
      )}

      {/* Error */}
      {loadState === 'error' && (
        <div role="alert" style={styles.errorMsg}>
          Fehler beim Laden der Repos: {loadError}
        </div>
      )}

      {/* Empty */}
      {isEmpty && (
        <div role="status" style={styles.statusMsg}>
          Keine lokalen Klone gefunden.
        </div>
      )}

      {/* Repo list (AC1) */}
      {hasRepos && (
        <ul style={styles.repoList} role="list" aria-label="Lokale Repos">
          {repos.map((repo) => (
            <RepoItem
              key={repo.name}
              repo={repo}
              onSelect={() => navigateFactory(repo.name)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

// ── RepoItem ─────────────────────────────────────────────────────────────────

/**
 * Single repo row — activatable via click and keyboard (AC1 + AC2).
 *
 * @param {{
 *   repo: {
 *     name: string,
 *     branch: string | null,
 *     dirty: boolean,
 *     lastCommit: { hash: string, subject: string, date: string } | null,
 *   },
 *   onSelect: () => void,
 * }} props
 */
function RepoItem({ repo, onSelect }) {
  const { name, branch, dirty, lastCommit } = repo;

  // lastCommit ist ein Objekt {hash, subject, date} oder null (Worktrees/leere
  // Repos liefern null) — niemals direkt in JSX rendern (React-Crash).
  const commitText = lastCommit
    ? `${lastCommit.hash} · ${lastCommit.subject}`
    : '—';

  return (
    <li role="listitem" style={styles.repoItem}>
      <button
        type="button"
        style={styles.repoBtn}
        onClick={onSelect}
        aria-label={`Projekt ${name} öffnen`}
        data-repo={name}
      >
        {/* Repo name */}
        <span style={styles.repoName}>{name}</span>

        {/* Branch */}
        <span style={styles.repoBranch} aria-label={`Branch: ${branch ?? '—'}`}>
          {branch ?? '—'}
        </span>

        {/* Dirty badge */}
        <span
          style={dirty ? styles.dirtyBadge : styles.cleanBadge}
          aria-label={dirty ? 'Uncommittete Änderungen vorhanden' : 'Sauber'}
        >
          {dirty ? 'dirty' : 'clean'}
        </span>

        {/* Last commit */}
        <span style={styles.lastCommit} aria-label={`Letzter Commit: ${commitText}`}>
          {commitText}
        </span>
      </button>
    </li>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '20px 24px',
    background: '#1a1a1a',
    color: '#e5e7eb',
  },

  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 20,
    flexShrink: 0,
  },

  h1: {
    margin: 0,
    fontSize: 24,
    fontWeight: 700,
    color: '#e5e7eb',
    flexShrink: 0,
  },

  btnNewProject: {
    background: '#065f46',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    flexShrink: 0,
    // Focus ring preserved (no outline:none)
  },

  btnNewProjectClose: {
    background: 'transparent',
    color: '#9ca3af',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '8px 16px',
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
    flexShrink: 0,
  },

  intakeNewWrapper: {
    marginBottom: 20,
    maxWidth: 560,
  },

  statusMsg: {
    color: '#9ca3af',
    fontSize: 14,
    padding: '16px 0',
  },

  errorMsg: {
    color: '#f87171',
    fontSize: 14,
    padding: '12px 16px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    marginBottom: 16,
  },

  repoList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  repoItem: {
    // semantic list-item wrapper
  },

  repoBtn: {
    display: 'grid',
    gridTemplateColumns: 'minmax(160px, 1fr) auto auto minmax(120px, 1fr)',
    alignItems: 'center',
    gap: 16,
    width: '100%',
    minHeight: 56,
    padding: '12px 20px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    cursor: 'pointer',
    textAlign: 'left',
    color: '#d4d4d4',
    // Focus ring preserved (no outline:none — WCAG 2.1 SC 2.4.7)
  },

  repoName: {
    fontSize: 15,
    fontWeight: 700,
    color: '#e5e7eb',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  repoBranch: {
    fontSize: 12,
    color: '#93c5fd',
    fontFamily: 'monospace',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 10,
    padding: '2px 8px',
    flexShrink: 0,
  },

  dirtyBadge: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#2a1a1a',
    color: '#fde68a',
    border: '1px solid #78350f',
    flexShrink: 0,
  },

  cleanBadge: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#1a2a1a',
    color: '#86efac',
    border: '1px solid #14532d',
    flexShrink: 0,
  },

  lastCommit: {
    fontSize: 12,
    color: '#9ca3af',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};
