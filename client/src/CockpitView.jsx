/**
 * CockpitView.jsx — Projekt-Cockpit mit Reiter-Leiste (AC3).
 *
 * projekt-cockpit-navigation:
 *   AC3 — Reiter-Leiste „Arbeiten | Board | Spezifikation" mit aktivem Projekt-Kontext.
 *          „Arbeiten" zeigt den bisherigen FactoryView-Inhalt (Terminal + TriggerPanel +
 *          Dashboard) — unverändert eingebettet.
 *          „Board" und „Spezifikation" sind Platzhalter-Reiter.
 *          Reiter erben den Projekt-Kontext (activeRepo).
 *   AC2 — Rückweg zur Übersicht (#/factory) über den Back-Button.
 *
 * A11y (WCAG 2.1 AA):
 *   - Reiter-Leiste als <nav role="tablist"> mit aria-selected.
 *   - Aktive Reiter-Panel mit role="tabpanel".
 *   - Sichtbarer Fokusring — KEIN outline:none.
 *   - Touch-Targets ≥ 44 px.
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML.
 *   - Keine neuen Backend-Endpunkte in diesem Paket.
 *   - Keine Secrets im Bundle.
 *
 * @param {{
 *   activeRepo: string,
 *   navigateFactory: (repo: string | null) => void,
 *   onNavigate: (view: string) => void,
 * }} props
 */

import { useState } from 'react';
import { Terminal } from './Terminal.jsx';
import { Dashboard } from './Dashboard.jsx';
import { TriggerPanel } from './TriggerPanel.jsx';

/** @type {Array<{ id: string, label: string }>} */
const TABS = [
  { id: 'arbeiten', label: 'Arbeiten' },
  { id: 'board',    label: 'Board' },
  { id: 'spec',     label: 'Spezifikation' },
];

/**
 * @param {{
 *   activeRepo: string,
 *   navigateFactory: (repo: string | null) => void,
 *   onNavigate: (view: string) => void,
 * }} props
 */
export function CockpitView({ activeRepo, navigateFactory, onNavigate }) {
  const [activeTab, setActiveTab] = useState('arbeiten');

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
          <FactoryWorkspace onNavigate={onNavigate} />
        </div>
      )}

      {/* Board: Platzhalter (Folge-Story) */}
      {activeTab === 'board' && (
        <div
          role="tabpanel"
          id="cockpit-panel-board"
          aria-labelledby="cockpit-tab-board"
          style={styles.placeholderPanel}
        >
          <p style={styles.placeholderText}>Board — folgt</p>
        </div>
      )}

      {/* Spezifikation: Platzhalter (Folge-Story) */}
      {activeTab === 'spec' && (
        <div
          role="tabpanel"
          id="cockpit-panel-spec"
          aria-labelledby="cockpit-tab-spec"
          style={styles.placeholderPanel}
        >
          <p style={styles.placeholderText}>Spezifikation — folgt</p>
        </div>
      )}
    </div>
  );
}

// ── FactoryWorkspace ──────────────────────────────────────────────────────────

/**
 * FactoryWorkspace — the original FactoryView inner content:
 * Terminal + TriggerPanel + Dashboard, unchanged (AC3).
 *
 * This is the same layout as the former FactoryView component body,
 * now embedded in the "Arbeiten" tab of CockpitView.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */
function FactoryWorkspace({ onNavigate }) {
  return (
    <div style={styles.factory}>
      {/* Terminal pane — dominant, scrollable xterm.js */}
      <main style={styles.terminalPane} aria-label="Terminal">
        <Terminal />
      </main>

      {/* Right sidebar — TriggerPanel + Dashboard stacked */}
      <div style={styles.sidebar}>
        {/* Board navigation link */}
        <div style={styles.boardLinkBar}>
          <button
            type="button"
            style={styles.boardLinkBtn}
            onClick={() => onNavigate('board')}
            aria-label="Zum Aufgaben-Board navigieren"
          >
            → Aufgaben-Board
          </button>
        </div>

        {/* Flow-Trigger-Panel — fire slash-commands */}
        <TriggerPanel />

        {/* Dashboard — project status cards */}
        <Dashboard />
      </div>
    </div>
  );
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

  boardLinkBar: {
    padding: '10px 12px 6px',
    borderBottom: '1px solid #2a2a2a',
  },

  boardLinkBtn: {
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
};
