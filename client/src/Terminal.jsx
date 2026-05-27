/**
 * Terminal.jsx — xterm.js terminal pane component.
 *
 * Wires TerminalConnection ↔ xterm.js Terminal.
 * Renders connection status (label + icon) — never by color alone (a11y).
 *
 * Design constraints (docs/design.md):
 *   - Dark-first; monospace in terminal pane
 *   - Status label + icon (not color alone) — WCAG 2.1 AA
 *   - Terminal focusable + escapable (no focus trap)
 *   - Scrollback bounded (configured via SCROLLBACK_LIMIT)
 */

import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalConnection, WS_STATUS } from './wsClient.js';
import '@xterm/xterm/css/xterm.css';

// Scrollback bound — no unbounded growth (spec edge-case)
const SCROLLBACK_LIMIT = 2000;

/**
 * Status metadata: label + icon (a11y) + color hint (supplemental only).
 * Primary status indication is always label+icon — never color alone.
 */
const STATUS_META = {
  [WS_STATUS.CONNECTED]:    { label: 'verbunden',  icon: '✓', color: '#4ade80' },
  [WS_STATUS.CONNECTING]:   { label: 'verbinde …', icon: '↻', color: '#fbbf24' },
  [WS_STATUS.DISCONNECTED]: { label: 'getrennt',   icon: '✕', color: '#f87171' },
};

/**
 * Build a WS URL from a relative path such as '/ws/terminal'.
 * Handles http→ws and https→wss.
 * @param {string} path
 * @returns {string}
 */
function resolveWsUrl(path) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

/**
 * Terminal pane — displays live PTY output and relays input.
 *
 * @param {{ wsUrl?: string }} props
 *   wsUrl defaults to resolveWsUrl('/ws/terminal') — override in tests/storybook.
 */
export function Terminal({ wsUrl }) {
  const containerRef = useRef(null);
  const xtermRef     = useRef(null);
  const fitRef       = useRef(null);
  const connRef      = useRef(null);
  const statusRef    = useRef(null);

  /** Update the status DOM element directly (no React re-render needed). */
  const setStatusDisplay = useCallback((status) => {
    const el = statusRef.current;
    if (!el) return;
    const meta = STATUS_META[status] ?? STATUS_META[WS_STATUS.DISCONNECTED];
    el.textContent = `${meta.icon} ${meta.label}`;
    el.dataset.status = status;
    // Color is a supplemental hint — label+icon are the primary a11y indicator
    el.style.color = meta.color;
  }, []);

  useEffect(() => {
    // ── xterm setup ────────────────────────────────────────────────────
    const xterm = new XTerm({
      theme: {
        background: '#1a1a1a',
        foreground: '#d4d4d4',
        cursor:     '#d4d4d4',
      },
      fontFamily: 'monospace',
      fontSize: 14,
      scrollback: SCROLLBACK_LIMIT,
      allowProposedApi: false,
    });
    xtermRef.current = xterm;

    const fit = new FitAddon();
    fitRef.current = fit;
    xterm.loadAddon(fit);

    if (containerRef.current) {
      xterm.open(containerRef.current);

      // WCAG 2.1 SC 2.1.2 (No Keyboard Trap): xterm.js calls preventDefault() on
      // Tab keydown internally, which prevents the browser's Tab-navigation from
      // leaving the terminal. Returning false from this handler tells xterm to skip
      // the event entirely → the browser handles Tab normally → focus can leave.
      xterm.attachCustomKeyEventHandler((ev) => {
        if (ev.type === 'keydown' && ev.key === 'Tab') return false;
        return true;
      });

      fit.fit();
    }

    // ── WS connection ──────────────────────────────────────────────────
    const url = wsUrl ?? resolveWsUrl('/ws/terminal');
    const conn = new TerminalConnection(url);
    connRef.current = conn;

    setStatusDisplay(WS_STATUS.CONNECTING);

    conn.onStatus((s) => {
      setStatusDisplay(s);
      // AC5: send initial resize when connection first becomes open, so the
      // PTY is immediately sized to the real xterm dimensions.
      if (s === WS_STATUS.CONNECTED) {
        conn.sendResize(xterm.cols, xterm.rows);
      }
    });

    conn.onMessage((msg) => {
      if (msg.type === 'output' && typeof msg.data === 'string') {
        xterm.write(msg.data);
      }
      // 'state' messages (session state) are informational — not rendered here
    });

    conn.connect();

    // ── Input relay ────────────────────────────────────────────────────
    // AC2: keystrokes → WS input
    xterm.onData((data) => conn.send(data));

    // ── Resize handling ────────────────────────────────────────────────
    // AC5: propagate container-size changes to PTY via resize messages.
    // ResizeObserver may be unavailable in test environments.
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      ro = new ResizeObserver(() => {
        try {
          fit.fit();
          conn.sendResize(xterm.cols, xterm.rows);
        } catch { /* container may not be ready */ }
      });
      ro.observe(containerRef.current);
    }

    // ── Cleanup ────────────────────────────────────────────────────────
    return () => {
      ro?.disconnect();
      conn.destroy();
      xterm.dispose();
    };
  }, []); // mount once — connection lifecycle tied to component mount

  return (
    <div style={styles.wrapper}>
      {/* A11y: status label + icon, not color alone (design.md / spec NFR) */}
      <div
        ref={statusRef}
        role="status"
        aria-live="polite"
        aria-label="Verbindungs-Status"
        style={styles.statusBar}
        data-status={WS_STATUS.CONNECTING}
      >
        {STATUS_META[WS_STATUS.CONNECTING].icon} {STATUS_META[WS_STATUS.CONNECTING].label}
      </div>

      {/*
        Terminal container.
        xterm's own canvas is focusable inside it.
        Browser Tab-navigation can leave the terminal because attachCustomKeyEventHandler
        returns false for Tab keydown events, preventing xterm from calling
        preventDefault() on them (WCAG 2.1 SC 2.1.2 — No Keyboard Trap).
      */}
      <div
        ref={containerRef}
        style={styles.terminal}
        aria-label="Terminal"
      />
    </div>
  );
}

const styles = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: '#1a1a1a',
    fontFamily: 'monospace',
  },
  statusBar: {
    padding: '4px 8px',
    fontSize: '12px',
    fontFamily: 'monospace',
    color: '#d4d4d4',
    background: '#111',
    borderBottom: '1px solid #333',
    userSelect: 'none',
    // Base color — status-specific tints applied via statusColorMap in setStatusDisplay
  },
  terminal: {
    flex: 1,
    overflow: 'hidden',
    padding: '4px',
  },
};
