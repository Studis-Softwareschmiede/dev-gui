/**
 * App.jsx — Root application shell.
 *
 * Composes Terminal (dominant, left/main) + TriggerPanel + Dashboard (sidebars, right).
 * Layout: side-by-side on desktop (≥ 768 px); stacked (panels above Terminal)
 * on narrow viewports (< 768 px) per docs/design.md.
 *
 * Terminal pane is dominant — takes available space.
 * TriggerPanel and Dashboard panels are fixed-width sidebars.
 */

import { Terminal } from './Terminal.jsx';
import { Dashboard } from './Dashboard.jsx';
import { TriggerPanel } from './TriggerPanel.jsx';

export function App() {
  return (
    <div style={styles.shell}>
      {/* Terminal pane — dominant, scrollable xterm.js */}
      <main style={styles.terminalPane} aria-label="Terminal">
        <Terminal />
      </main>

      {/* Right sidebar — TriggerPanel + Dashboard stacked */}
      <div style={styles.sidebar}>
        {/* Flow-Trigger-Panel — fire slash-commands */}
        <TriggerPanel />

        {/* Dashboard — project status cards */}
        <Dashboard />
      </div>
    </div>
  );
}

const styles = {
  shell: {
    display: 'flex',
    flexDirection: 'row',
    height: '100%',
    overflow: 'hidden',
    background: '#1a1a1a',
    // On narrow viewports (< 768 px) the browser wraps via flex-wrap below.
    // We rely on media-query-in-JS via a style element in index.html for the
    // 768-px breakpoint; the component itself uses flexWrap to allow stacking.
    flexWrap: 'wrap',
  },
  terminalPane: {
    flex: '1 1 400px',   // grows; minimum 400 px before wrapping
    minWidth: 0,          // allows flex child to shrink below content size
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    // On narrow viewports this wraps below the sidebar panels
    order: 1,
  },
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    flex: '0 0 auto',
    order: 2,
  },
};
