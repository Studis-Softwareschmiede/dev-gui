/**
 * App.jsx — Root application shell.
 *
 * Composes Terminal (dominant, left/main) + Dashboard (sidebar, right).
 * Layout: side-by-side on desktop (≥ 768 px); stacked (Dashboard above Terminal)
 * on narrow viewports (< 768 px) per docs/design.md.
 *
 * Terminal pane is dominant — takes available space.
 * Dashboard panel is fixed-width sidebar.
 */

import { Terminal } from './Terminal.jsx';
import { Dashboard } from './Dashboard.jsx';

export function App() {
  return (
    <div style={styles.shell}>
      {/* Dashboard sidebar — project status cards */}
      <Dashboard />

      {/* Terminal pane — dominant, scrollable xterm.js */}
      <main style={styles.terminalPane} aria-label="Terminal">
        <Terminal />
      </main>
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
  },
};
