/**
 * FactoryView.jsx — Fabrik-Ansicht (AC2, AC7).
 *
 * Composes the existing Terminal-Pane, Flow-Trigger-Panel and Status-Dashboard
 * unchanged — no functional loss versus the previous single-view layout.
 *
 * The persistent NavBar (from AppShell) sits above this view and provides
 * navigation to other views and back to the panel, satisfying AC4.
 *
 * Layout: side-by-side on desktop (≥ 768 px); stacked (panels above Terminal)
 * on narrow viewports (< 768 px) per docs/design.md.
 */

import { Terminal } from './Terminal.jsx';
import { Dashboard } from './Dashboard.jsx';
import { TriggerPanel } from './TriggerPanel.jsx';

/**
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function FactoryView({ onNavigate }) {
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

const styles = {
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
