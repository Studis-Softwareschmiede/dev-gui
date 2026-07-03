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
 *
 * Reused (unmodified default behavior) by VpsView's SSH-terminal panel
 * (docs/specs/vps-ssh-terminal.md AC2/AC3/AC4) via two additive, opt-in props:
 *   - `wsUrl` (pre-existing) — overridden to `/ws/vps-terminal`.
 *   - `openPayload` (new) — sent as the first WS message once open
 *     (`{type:"open",provider,serverId,user}`); undefined for `/ws/terminal`
 *     (Claude-Terminal) — its behavior is unchanged.
 *   `{type:"error"}` messages are written into the terminal output AND into a
 *   dedicated `role="alert"` element (AC4, WCAG AA — spec NFR "Fehlermeldung als
 *   role=alert"; xterm's canvas output is not exposed to assistive tech). The
 *   alert element is always present in the DOM (empty/hidden by default) — for
 *   the Claude-Terminal usage it is simply never populated, so this is dormant
 *   there, same as the xterm-output branch above.
 *
 *   Note: the module's export surface (`Terminal` only) is intentionally kept
 *   unchanged — several existing test files fully replace this module via
 *   `jest.unstable_mockModule('../Terminal.jsx', () => ({ Terminal: () => null }))`.
 *   VpsView.jsx therefore keeps its own tiny copy of the WS-URL-resolving helper
 *   instead of importing one from here (avoids breaking those mocks on any future
 *   export addition here).
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
 * Not exported (see module-doc note above) — VpsView.jsx keeps its own copy.
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
 * @param {{ wsUrl?: string, openPayload?: object }} props
 *   wsUrl defaults to resolveWsUrl('/ws/terminal') — override in tests/storybook.
 *   openPayload (vps-ssh-terminal AC2/AC5) — optional handshake object sent as the FIRST
 *     message once the WS opens, e.g. `{type:"open",provider,serverId,user}`. Undefined for
 *     the Claude-Terminal usage (`/ws/terminal`) — behavior there is unchanged.
 */
export function Terminal({ wsUrl, openPayload }) {
  const containerRef = useRef(null);
  const xtermRef     = useRef(null);
  const fitRef       = useRef(null);
  const connRef      = useRef(null);
  const statusRef    = useRef(null);
  // vps-ssh-terminal AC4 / WCAG AA (spec NFR "Fehlermeldung als role=alert"): a dedicated,
  // always-present-but-empty role="alert" element — xterm renders to a <canvas>, which is
  // not exposed to assistive tech, so the error text ALSO needs a real accessible node next
  // to the xterm.write() call (which stays, for sighted terminal users following the stream).
  const errorAlertRef = useRef(null);
  // vps-ssh-terminal AC4: tracks whether this socket EVER reached CONNECTED. If the very
  // first attempt fails (never opens) the only possible cause in this app is the AccessGuard
  // WS-upgrade rejection (raw HTTP 403, see src/AccessGuard.js createWsAccessGuard) — every
  // other error class (no-target/no-private-key/unreachable/auth-failed/host-key-mismatch)
  // is reported via a post-connect `{type:"error"}` message, never by the transport failing
  // to open at all. Only relevant when `openPayload` is set (VPS-terminal usage).
  const hasConnectedOnceRef = useRef(false);
  const shownForbiddenRef   = useRef(false);

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

  /**
   * Show a message in the role="alert" element (vps-ssh-terminal AC4, WCAG AA).
   * Hidden (no text, display:none) when called with an empty/falsy text.
   */
  const showErrorAlert = useCallback((text) => {
    const el = errorAlertRef.current;
    if (!el) return;
    el.textContent = text ?? '';
    el.style.display = text ? 'block' : 'none';
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
    const conn = new TerminalConnection(url, { openPayload });
    connRef.current = conn;

    setStatusDisplay(WS_STATUS.CONNECTING);

    conn.onStatus((s) => {
      setStatusDisplay(s);
      // AC5: send initial resize when connection first becomes open, so the
      // PTY is immediately sized to the real xterm dimensions.
      if (s === WS_STATUS.CONNECTED) {
        hasConnectedOnceRef.current = true;
        conn.sendResize(xterm.cols, xterm.rows);
      } else if (
        // vps-ssh-terminal AC4: first-ever connect attempt failed → the only cause on
        // this endpoint is the AccessGuard WS-upgrade 403 (see comment above). Shown
        // once (not on every backoff retry) — only for VPS-terminal usage (openPayload set).
        s === WS_STATUS.DISCONNECTED
        && openPayload
        && !hasConnectedOnceRef.current
        && !shownForbiddenRef.current
      ) {
        shownForbiddenRef.current = true;
        const forbiddenText = 'Keine Berechtigung — Verbindung wurde abgelehnt.';
        xterm.write(`\r\n\x1b[31m${forbiddenText}\x1b[0m\r\n`);
        showErrorAlert(forbiddenText); // WCAG AA (AC4) — xterm's canvas isn't AT-accessible
      }
    });

    conn.onMessage((msg) => {
      if (msg.type === 'output' && typeof msg.data === 'string') {
        xterm.write(msg.data);
      } else if (msg.type === 'error') {
        // vps-ssh-terminal AC4: geheimnisfreie Fehlermeldung in genau diesem Fenster.
        // `/ws/terminal` (Claude-Terminal) sendet nie 'error' — kein Verhaltens-Regress dort.
        const reason = typeof msg.reason === 'string' ? msg.reason : 'Fehler';
        const errorText = `[${msg.errorClass ?? 'error'}] ${reason}`;
        xterm.write(`\r\n\x1b[31m${errorText}\x1b[0m\r\n`);
        showErrorAlert(errorText); // WCAG AA (AC4) — xterm's canvas isn't AT-accessible
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

      {/* vps-ssh-terminal AC4 (WCAG AA — spec NFR "Fehlermeldung als role=alert"): dedicated
          AT-accessible error node — empty/hidden by default, populated via showErrorAlert()
          alongside the xterm.write() call above. Always present but inert for the
          Claude-Terminal usage (never populated there). */}
      <div
        ref={errorAlertRef}
        role="alert"
        style={styles.errorAlert}
      />

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
  // vps-ssh-terminal AC4 (WCAG AA) — hidden by default (showErrorAlert() reveals it);
  // small visual footprint, real text is what matters for assistive tech.
  errorAlert: {
    display: 'none',
    padding: '2px 8px',
    fontSize: '11px',
    fontFamily: 'monospace',
    color: '#fca5a5',
    background: '#2c0000',
    borderBottom: '1px solid #7f1d1d',
  },
};
