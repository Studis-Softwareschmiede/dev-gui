/**
 * CockpitView.jsx — Projekt-Cockpit mit Reiter-Leiste.
 *
 * projekt-cockpit-navigation:
 *   AC3 — Reiter-Leiste „Arbeiten | Studis-Kanban-Board | Spezifikation" mit aktivem Projekt-Kontext.
 *          „Arbeiten" zeigt den bisherigen FactoryView-Inhalt (Terminal + TriggerPanel +
 *          Dashboard) — unverändert eingebettet.
 *          Reiter erben den Projekt-Kontext (activeRepo).
 *   AC2 — Rückweg zur Übersicht (#/factory) über den Back-Button.
 *
 * projekt-spezifikation-anzeige:
 *   AC4 — Reiter „Spezifikation" ersetzt den „folgt mit F-004"-Platzhalter:
 *          SpecView mit Navigation + gerendertem Markdown (markdownLite).
 *   AC5 — BoardView erhält openSpec-Callback: Klick auf Spec-Bezug öffnet
 *          den Spezifikation-Reiter und zeigt die jeweilige Datei.
 *
 * autonome-board-abarbeitung:
 *   AC2 — Im Reiter „Arbeiten" Knopf „Board abarbeiten", der mit
 *          Bestätigungsdialog /agent-flow:flow im Projekt-Terminal startet.
 *          Nutzt POST /api/command (bestehender CommandService-Mechanismus).
 *   AC3 — Hinweis: offene Fragen → Story auf Blocked statt raten.
 *
 * fabric-intake-dialog:
 *   AC8 — „Board abarbeiten"-Button (Phase B) löst /agent-flow:flow über
 *          POST /api/command aus und ist bei aktivem Job (Session state:"busy")
 *          deaktiviert (globales Lock-Modell, analog TriggerPanel). Nach
 *          erfolgreichem Auslösen (202) → onNavigate('factory') damit der
 *          Lauf live im Terminal sichtbar ist.
 *
 * A11y (WCAG 2.1 AA):
 *   - Reiter-Leiste als <nav role="tablist"> mit aria-selected.
 *   - Aktive Reiter-Panel mit role="tabpanel".
 *   - Sichtbarer Fokusring — KEIN outline:none.
 *   - Touch-Targets ≥ 44 px.
 *   - Button disabled via disabled-Attribut + Label (nie nur Farbe).
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML.
 *   - Keine neuen Backend-Endpunkte in diesem Paket.
 *   - Keine Secrets im Bundle.
 *   - Bestätigungsdialog verhindert versehentliches Auslösen.
 *
 * @param {{
 *   activeRepo: string,
 *   navigateFactory: (repo: string | null) => void,
 *   onNavigate: (view: string) => void,
 * }} props
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Terminal } from './Terminal.jsx';
import { Dashboard } from './Dashboard.jsx';
import { TriggerPanel } from './TriggerPanel.jsx';
import { BoardView } from './BoardView.jsx';
import { SpecView } from './SpecView.jsx';
import { IntakeDialog } from './IntakeDialog.jsx';

/** @type {Array<{ id: string, label: string }>} */
const TABS = [
  { id: 'arbeiten', label: 'Arbeiten' },
  { id: 'board',    label: 'Studis-Kanban-Board' },
  { id: 'spec',     label: 'Spezifikation' },
];

/**
 * @param {{
 *   activeRepo: string,
 *   navigateFactory: (repo: string | null) => void,
 *   onNavigate: (view: string) => void,
 * }} props
 */
export function CockpitView({ activeRepo, navigateFactory, onNavigate: _onNavigate }) {
  const [activeTab, setActiveTab] = useState('arbeiten');

  // AC5: Pfad der im Spezifikation-Reiter direkt zu öffnenden Datei
  // (wird gesetzt wenn BoardView auf einen Spec-Bezug klickt)
  // SpecView remountet bei Tab-Wechsel — kein Reset nötig.
  const [pendingSpecPath, setPendingSpecPath] = useState(null);

  // AC5: Callback für BoardView — öffnet Spezifikation-Reiter + setzt Pfad
  const openSpec = useCallback((relPath) => {
    setPendingSpecPath(relPath);
    setActiveTab('spec');
  }, []);

  return (
    <div style={styles.cockpit}>
      {/* Cockpit header: project name + back link */}
      <div style={styles.cockpitHeader}>
        <button
          type="button"
          style={styles.backBtn}
          onClick={() => navigateFactory(null)}
          aria-label="Zurück zur Repo-Übersicht"
        >
          ← Übersicht
        </button>
        <span style={styles.projectName} aria-label={`Aktives Projekt: ${activeRepo}`}>
          {activeRepo}
        </span>
      </div>

      {/* Tab bar (AC3) */}
      <div
        role="tablist"
        aria-label="Cockpit-Reiter"
        style={styles.tabBar}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`cockpit-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`cockpit-panel-${tab.id}`}
            style={{
              ...styles.tabBtn,
              ...(activeTab === tab.id ? styles.tabBtnActive : {}),
            }}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab panels (AC3) — only the active tab is mounted */}

      {/* Arbeiten: bisheriger FactoryView-Inhalt unverändert eingebettet */}
      {activeTab === 'arbeiten' && (
        <div
          role="tabpanel"
          id="cockpit-panel-arbeiten"
          aria-labelledby="cockpit-tab-arbeiten"
          style={styles.tabPanel}
        >
          <FactoryWorkspace activeRepo={activeRepo} onNavigate={_onNavigate} />
        </div>
      )}

      {/* Board: BoardView gefiltert auf das aktive Projekt (AC6 / S-113) */}
      {activeTab === 'board' && (
        <div
          role="tabpanel"
          id="cockpit-panel-board"
          aria-labelledby="cockpit-tab-board"
          style={styles.tabPanel}
        >
          <BoardView lockedProject={activeRepo} onOpenSpec={openSpec} />
        </div>
      )}

      {/* Spezifikation: SpecView (AC4 — F-004, ersetzt Platzhalter) */}
      {activeTab === 'spec' && (
        <div
          role="tabpanel"
          id="cockpit-panel-spec"
          aria-labelledby="cockpit-tab-spec"
          style={styles.tabPanel}
        >
          <SpecView
            projectSlug={activeRepo}
            initialPath={pendingSpecPath}
          />
        </div>
      )}
    </div>
  );
}

// ── FactoryWorkspace ──────────────────────────────────────────────────────────

/** Session poll interval in ms — matches TriggerPanel default (AC8). */
const SESSION_POLL_MS = 3_000;

/**
 * FactoryWorkspace — the original FactoryView inner content:
 * Terminal + TriggerPanel + Dashboard.
 *
 * Extended for AC4/S-111: passes project-scoped wsUrl to Terminal and
 * projectPath to TriggerPanel so commands run in the active project session.
 *
 * Extended for autonome-board-abarbeitung AC2/S-119:
 * Adds „Board abarbeiten"-Knopf with confirmation dialog that fires
 * /agent-flow:flow via POST /api/command (existing CommandService route).
 * AC3: Hinweis that unclear items → Blocked (not guessing).
 *
 * Extended for fabric-intake-dialog AC8/S-136:
 * The „Board abarbeiten"-Knopf is now also AC8-compliant: polls GET /api/session
 * (state:"busy") to derive busy state and disables the button when a job is
 * running. After 202, calls onNavigate('factory') so the run is visible live
 * in the Terminal pane (consistent with IntakeDialog/AC4 pattern).
 *
 * @param {{ activeRepo: string, fetchFn?: Function, pollInterval?: number }} props
 *   fetchFn      — injectable for tests (default: globalThis.fetch)
 *   pollInterval — session poll interval in ms (default: SESSION_POLL_MS, override for tests)
 */
function FactoryWorkspace({ activeRepo, fetchFn, onNavigate, pollInterval = SESSION_POLL_MS }) {
  // Build project-scoped WS URL: /ws/terminal?project=<encoded-path>
  // Terminal already resolves the protocol (ws/wss) from window.location —
  // we pass a full URL here so it is testable without DOM.
  const wsUrl = buildTerminalWsUrl(activeRepo);

  // ── Intake-Dialog state (C1 — fabric-intake-dialog AC1) ──────────────────
  /** Whether the change-intake dialog is open */
  const [intakeOpen, setIntakeOpen] = useState(false);

  const handleIntakeClose = useCallback(() => {
    setIntakeOpen(false);
  }, []);

  // AC4: after successful submit, navigate to factory (terminal pane)
  // and close the intake panel
  const handleIntakeNavigate = useCallback((view) => {
    setIntakeOpen(false);
    if (onNavigate) onNavigate(view);
  }, [onNavigate]);

  // ── Session busy state (AC8 fabric-intake-dialog) ─────────────────────────
  // Polls GET /api/session (state:"busy") to derive isRunning — same pattern
  // as TriggerPanel. Used to disable the „Board abarbeiten"-Button (AC8).
  /** 'idle' | 'running' — derived from GET /api/session state */
  const [sessionRunState, setSessionRunState] = useState('idle');

  // Stable ref so poll effect doesn't re-register on every render
  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  useEffect(() => {
    let cancelled = false;

    async function pollSession() {
      try {
        const res = await fetchFnRef.current('/api/session');
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) {
          setSessionRunState(json.state === 'busy' ? 'running' : 'idle');
        }
      } catch {
        // network error — keep current state
      }
    }

    pollSession();
    const timer = setInterval(pollSession, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollInterval]);

  const isSessionBusy = sessionRunState === 'running';

  // ── Board-abarbeiten state (AC2 autonome-board-abarbeitung / AC8 fabric-intake-dialog) ──
  /** 'idle' | 'confirm' | 'starting' | 'started' | 'error' */
  const [flowState, setFlowState] = useState('idle');
  const [flowError, setFlowError] = useState(null);

  // AC8: button is disabled when a session is busy (global lock model).
  // Also disabled when local flowState is in-progress (confirm/starting).
  const isBoardBtnDisabled = isSessionBusy || flowState === 'starting';

  const handleFlowClick = useCallback(() => {
    setFlowState('confirm');
    setFlowError(null);
  }, []);

  const handleFlowCancel = useCallback(() => {
    setFlowState('idle');
    setFlowError(null);
  }, []);

  const handleFlowConfirm = useCallback(async () => {
    setFlowState('starting');
    setFlowError(null);

    // Build request body — include projectPath for project-scoped session (AC5/S-111).
    const body = { command: '/agent-flow:flow' };
    if (activeRepo && typeof activeRepo === 'string' && activeRepo.trim()) {
      body.projectPath = activeRepo.trim();
    }

    const _fetch = fetchFnRef.current;
    let res;
    try {
      res = await _fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      setFlowState('error');
      setFlowError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      // AC8 (fabric-intake-dialog): navigate to terminal pane so run is visible.
      // Consistent with IntakeDialog/AC4 pattern (onNavigate('factory')).
      setFlowState('idle');
      setSessionRunState('running'); // optimistic update — poll will confirm
      if (onNavigate) onNavigate('factory');
      return;
    }
    if (res.status === 409) {
      // Job already running — reflect session state
      setSessionRunState('running');
      setFlowState('error');
      setFlowError('Ein Job läuft bereits — bitte warten.');
      return;
    }
    setFlowState('error');
    setFlowError(`Fehler beim Starten (HTTP ${res.status}).`);
  }, [activeRepo, onNavigate]);

  return (
    <div style={styles.factory}>
      {/* Terminal pane — dominant, scrollable xterm.js */}
      <main style={styles.terminalPane} aria-label="Terminal">
        <Terminal wsUrl={wsUrl} />
      </main>

      {/* Right sidebar — TriggerPanel + Dashboard stacked */}
      <div style={styles.sidebar}>
        {/* AC2 (autonome-board-abarbeitung): Board-abarbeiten Knopf */}
        <div style={styles.flowTriggerBox}>
          <div style={styles.flowTriggerHeader}>Board abarbeiten</div>
          <p style={styles.flowTriggerHint}>
            Startet <code style={styles.code}>/agent-flow:flow</code> im Projekt-Terminal.
            Offene Fragen oder Spec-Lücken → Story auf <strong>Blocked</strong> (statt raten).
          </p>

          {flowState === 'idle' && (
            <button
              type="button"
              style={isBoardBtnDisabled ? styles.btnFlowTriggerDisabled : styles.btnFlowTrigger}
              disabled={isBoardBtnDisabled}
              aria-disabled={isBoardBtnDisabled}
              onClick={isBoardBtnDisabled ? undefined : handleFlowClick}
              aria-label={
                isSessionBusy
                  ? 'Board abarbeiten — gesperrt (Job läuft)'
                  : 'Board abarbeiten starten — öffnet Bestätigungsdialog'
              }
              data-testid="flow-board-btn"
            >
              {isSessionBusy ? 'Board abarbeiten — gesperrt' : 'Board abarbeiten'}
            </button>
          )}

          {/* AC8 (fabric-intake-dialog): lock notice when session busy */}
          {isSessionBusy && flowState === 'idle' && (
            <div
              role="status"
              aria-live="polite"
              style={styles.lockNotice}
              data-testid="flow-board-lock-notice"
            >
              Ein Job läuft — Trigger gesperrt.
            </div>
          )}

          {/* AC2: Bestätigungsdialog — verhindert versehentlichen Start */}
          {flowState === 'confirm' && (
            <div
              role="dialog"
              aria-modal="false"
              aria-label="Board abarbeiten bestätigen"
              style={styles.confirmBox}
              data-testid="flow-confirm-dialog"
            >
              <p style={styles.confirmText}>
                Startet die autonome Abarbeitung des Boards: ein Agent schreibt Code
                und legt PRs an. Fortfahren?
              </p>
              <div style={styles.confirmBtns}>
                <button
                  type="button"
                  style={styles.btnConfirm}
                  onClick={handleFlowConfirm}
                  aria-label="Bestätigen — Board-Abarbeitung starten"
                  data-testid="flow-confirm-yes"
                >
                  Starten
                </button>
                <button
                  type="button"
                  style={styles.btnCancel}
                  onClick={handleFlowCancel}
                  aria-label="Abbrechen — kein Start"
                  data-testid="flow-confirm-no"
                >
                  Abbrechen
                </button>
              </div>
            </div>
          )}

          {flowState === 'starting' && (
            <div
              role="status"
              aria-live="polite"
              style={styles.flowStatus}
              data-testid="flow-starting"
            >
              Starte…
            </div>
          )}

          {/* 'started' state no longer shown — AC8: after 202 we navigate to terminal pane */}

          {flowState === 'error' && (
            <div
              role="alert"
              style={styles.flowStatusError}
              data-testid="flow-error"
            >
              {flowError}
              <button
                type="button"
                style={styles.btnFlowReset}
                onClick={() => setFlowState('idle')}
                aria-label="Fehlerstatus zurücksetzen"
                data-testid="flow-error-reset"
              >
                Zurücksetzen
              </button>
            </div>
          )}
        </div>

        {/* Intake-Dialog trigger (AC1 — fabric-intake-dialog, change mode) */}
        <div style={styles.intakeTriggerBox}>
          <div style={styles.flowTriggerHeader}>Änderung erfassen</div>
          <p style={styles.flowTriggerHint}>
            Beschreibe eine gewünschte Änderung — wird als{' '}
            <code style={styles.code}>/agent-flow:requirement</code> an den Agenten übergeben.
          </p>
          {!intakeOpen ? (
            <button
              type="button"
              style={styles.btnIntakeTrigger}
              onClick={() => setIntakeOpen(true)}
              aria-label="Änderungswunsch erfassen — öffnet Intake-Dialog"
              data-testid="intake-change-btn"
            >
              Änderung erfassen
            </button>
          ) : (
            <div style={styles.intakeDialogWrapper}>
              <div style={styles.intakeDialogHeader}>
                <span style={styles.intakeDialogTitle}>Änderungswunsch</span>
                <button
                  type="button"
                  style={styles.btnIntakeClose}
                  onClick={handleIntakeClose}
                  aria-label="Intake-Dialog schließen"
                  data-testid="intake-close-btn"
                >
                  ✕
                </button>
              </div>
              <IntakeDialog
                mode="change"
                projectPath={activeRepo}
                fetchFn={fetchFn}
                onNavigate={handleIntakeNavigate}
              />
            </div>
          )}
        </div>

        {/* Flow-Trigger-Panel — fire slash-commands in the active project session */}
        <TriggerPanel projectPath={activeRepo} />

        {/* Dashboard — project status cards */}
        <Dashboard />
      </div>
    </div>
  );
}

/**
 * Build a project-scoped WS URL for the terminal.
 * When activeRepo is provided, appends ?project=<encoded-path>.
 * Falls back to undefined (Terminal uses its default global session) when no
 * project is active or when running outside a browser context.
 *
 * Returns a full absolute WS URL:
 *   ws://host/ws/terminal?project=<encoded>   (http origin)
 *   wss://host/ws/terminal?project=<encoded>  (https origin)
 *
 * @param {string|null|undefined} activeRepo  Absolute project path or name
 * @returns {string|undefined}  Full absolute WS URL, or undefined (Terminal uses its default)
 */
function buildTerminalWsUrl(activeRepo) {
  if (!activeRepo || typeof window === 'undefined') return undefined; // SSR-safe no-op
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}/ws/terminal`;
  return `${base}?project=${encodeURIComponent(activeRepo)}`;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  cockpit: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    background: '#1a1a1a',
  },

  cockpitHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 16px',
    background: '#0d0d0d',
    borderBottom: '1px solid #2a2a2a',
    flexShrink: 0,
  },

  backBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    color: '#93c5fd',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 36,
    // Focus ring preserved (no outline:none)
  },

  projectName: {
    fontSize: 14,
    fontWeight: 700,
    color: '#e5e7eb',
    fontFamily: 'monospace',
  },

  tabBar: {
    display: 'flex',
    gap: 2,
    padding: '6px 16px 0',
    background: '#0d0d0d',
    borderBottom: '1px solid #2a2a2a',
    flexShrink: 0,
  },

  tabBtn: {
    background: 'transparent',
    borderTop: '1px solid transparent',
    borderRight: '1px solid transparent',
    borderBottom: '1px solid transparent',
    borderLeft: '1px solid transparent',
    color: '#9ca3af',
    fontSize: 13,
    cursor: 'pointer',
    padding: '8px 16px',
    borderRadius: '4px 4px 0 0',
    minHeight: 44,
    minWidth: 80,
    // Focus ring preserved (no outline:none)
  },

  tabBtnActive: {
    color: '#e5e7eb',
    background: '#1a1a1a',
    borderTopColor: '#2a2a2a',
    borderRightColor: '#2a2a2a',
    borderBottomColor: '#1a1a1a', // blends with panel background
    borderLeftColor: '#2a2a2a',
  },

  tabPanel: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },

  placeholderPanel: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  placeholderText: {
    // #9ca3af on #1a1a1a ≈ 5.1:1 contrast — WCAG AA compliant for 14px text
    color: '#9ca3af',
    fontSize: 15,
    fontStyle: 'italic',
    margin: 0,
  },

  // ── FactoryWorkspace inner layout (same as former FactoryView) ────────────

  factory: {
    display: 'flex',
    flexDirection: 'row',
    flex: 1,
    overflow: 'hidden',
    background: '#1a1a1a',
    flexWrap: 'wrap',
  },

  terminalPane: {
    flex: '1 1 400px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    order: 1,
  },

  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    flex: '0 0 auto',
    order: 2,
  },

  // ── Intake-Dialog trigger box (AC1 fabric-intake-dialog) ────────────────

  intakeTriggerBox: {
    padding: '12px 16px',
    background: '#0d0d0d',
    borderBottom: '1px solid #2a2a2a',
    minWidth: 240,
    maxWidth: 300,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  btnIntakeTrigger: {
    background: '#065f46',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved (no outline:none)
  },

  intakeDialogWrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },

  intakeDialogHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },

  intakeDialogTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: '#9ca3af',
  },

  btnIntakeClose: {
    background: 'transparent',
    border: '1px solid #374151',
    color: '#9ca3af',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer',
    minHeight: 28,
    // Focus ring preserved (no outline:none)
  },

  // ── Board abarbeiten box (AC2 autonome-board-abarbeitung) ─────────────────

  flowTriggerBox: {
    padding: '12px 16px',
    background: '#0d0d0d',
    borderBottom: '1px solid #2a2a2a',
    minWidth: 240,
    maxWidth: 300,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  flowTriggerHeader: {
    fontSize: 12,
    fontWeight: 700,
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },

  flowTriggerHint: {
    fontSize: 11,
    color: '#6b7280',
    margin: 0,
    lineHeight: 1.5,
  },

  code: {
    fontFamily: 'monospace',
    background: '#1a1a1a',
    padding: '0 3px',
    borderRadius: 2,
    fontSize: 10,
    color: '#93c5fd',
  },

  btnFlowTrigger: {
    background: '#1d4ed8',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved (no outline:none)
  },

  // AC8 (fabric-intake-dialog): disabled state when session busy
  btnFlowTriggerDisabled: {
    background: '#1e293b',
    color: '#64748b',
    border: 'none',
    borderRadius: 4,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed',
    minHeight: 44,
  },

  // AC8: lock notice text when session busy (supplements disabled button — not color alone)
  lockNotice: {
    fontSize: 11,
    color: '#fbbf24',
    fontStyle: 'italic',
  },

  confirmBox: {
    background: '#111',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  confirmText: {
    fontSize: 12,
    color: '#d1d5db',
    margin: 0,
    lineHeight: 1.5,
  },

  confirmBtns: {
    display: 'flex',
    gap: 8,
  },

  btnConfirm: {
    flex: 1,
    background: '#15803d',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
  },

  btnCancel: {
    flex: 1,
    background: 'transparent',
    color: '#9ca3af',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
  },

  btnFlowReset: {
    background: 'transparent',
    border: '1px solid #374151',
    color: '#9ca3af',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer',
    marginTop: 4,
    minHeight: 44,
    display: 'block',
  },

  flowStatus: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },

  flowStatusOk: {
    fontSize: 12,
    color: '#86efac',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },

  flowStatusError: {
    fontSize: 12,
    color: '#f87171',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },

};
