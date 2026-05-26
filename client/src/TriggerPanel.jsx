/**
 * TriggerPanel.jsx — Flow-Trigger-Panel component (AC4).
 *
 * Lets the user compose and fire an allowlisted slash-command via
 * POST /api/command {command}. Derives running/idle state from
 * GET /api/session (state:"busy") and from 202/409 responses.
 *
 * When a job is running:
 *   - trigger controls are disabled (disabled attr + lock label)
 *   - Kill button (POST /api/command/cancel) is enabled
 *
 * When idle (state:"ready"):
 *   - trigger controls enabled, Kill button disabled
 *
 * Design constraints (docs/design.md):
 *   - Dark-first; UI-Sans for panels
 *   - Status conveyed by label — never color alone (WCAG 2.1 AA)
 *   - Buttons have accessible names; disabled state via disabled attr + label
 *   - Kill button clearly distinct (amber color, separate label)
 *   - 8-pt spacing scale
 *
 * Security:
 *   - No secrets in client (security/R01)
 *   - Command string sent as JSON to our backend which sanitises/allowlists
 *   - React escapes all string renders by default (security/R02)
 *   - Client mirrors allowlist for UX only; server is the enforcement boundary
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Fetch with timeout helper ─────────────────────────────────────────────────

/**
 * Wraps a fetchFn call with an AbortController timeout.
 * On abort/timeout the returned promise rejects with an AbortError.
 *
 * @param {Function} fetchFn   The underlying fetch function.
 * @param {string}   url       Request URL.
 * @param {object}   [opts]    Fetch options (method, headers, body, …).
 * @param {number}   [ms=5000] Timeout in milliseconds.
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(fetchFn, url, opts = {}, ms = 5_000) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), ms);
  return fetchFn(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(timerId)
  );
}

/**
 * Allowlist mirrored from server for UX (server enforces authoritatively).
 * @type {string[]}
 */
const ALLOWED_COMMANDS = ['/flow', '/adopt', '/preview', '/requirement', '/train'];

/** Session poll interval in ms */
const SESSION_POLL_MS = 3_000;

/**
 * TriggerPanel — compose and fire allowlisted slash-commands.
 *
 * @param {{
 *   pollInterval?: number,
 *   fetchFn?: Function,
 * }} props
 *   pollInterval — override for tests (default: SESSION_POLL_MS)
 *   fetchFn      — override for tests (default: global fetch)
 */
export function TriggerPanel({ pollInterval = SESSION_POLL_MS, fetchFn }) {
  /** 'idle' | 'running' */
  const [runState, setRunState]   = useState('idle');
  /** Optional argument text (e.g. project name / issue ref) */
  const [arg, setArg]             = useState('');
  /** Currently selected command from ALLOWED_COMMANDS */
  const [cmd, setCmd]             = useState(ALLOWED_COMMANDS[0]);
  /** UI message for validation errors or status */
  const [message, setMessage]     = useState(null);
  /** 'error' | 'info' | null */
  const [msgType, setMsgType]     = useState(null);

  // Stable ref so poll effect doesn't re-register on every render
  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  // ── Poll /api/session to derive running state ────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetchWithTimeout(fetchFnRef.current, '/api/session');
        if (!res.ok) return; // ignore transient errors — keep current state
        const json = await res.json();
        if (!cancelled) {
          setRunState(json.state === 'busy' ? 'running' : 'idle');
        }
      } catch {
        // network error or timeout — keep current state
      }
    }

    poll();
    const timer = setInterval(poll, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollInterval]);

  // ── Fire command ─────────────────────────────────────────────────────────
  const handleFire = useCallback(async () => {
    const command = arg.trim() ? `${cmd} ${arg.trim()}` : cmd;
    setMessage(null);
    setMsgType(null);

    let res;
    try {
      res = await fetchWithTimeout(fetchFnRef.current, '/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
    } catch {
      setMessage('Netzwerkfehler beim Senden des Befehls.');
      setMsgType('error');
      return;
    }

    if (res.status === 202) {
      setRunState('running');
      setMessage(null);
      setMsgType(null);
      return;
    }

    if (res.status === 409) {
      // Already running — reflect state
      setRunState('running');
      setMessage('Ein Job läuft bereits.');
      setMsgType('info');
      return;
    }

    if (res.status === 400) {
      let detail = 'Ungültiger Befehl.';
      try {
        const json = await res.json();
        if (json?.reason) detail = `Ungültiger Befehl: ${json.reason}`;
      } catch { /* ignore parse error */ }
      setMessage(detail);
      setMsgType('error');
      return;
    }

    // 500 or unexpected
    setMessage('Serverfehler. Bitte erneut versuchen.');
    setMsgType('error');
  }, [cmd, arg]);

  // ── Kill ─────────────────────────────────────────────────────────────────
  const handleKill = useCallback(async () => {
    setMessage(null);
    setMsgType(null);

    let res;
    try {
      res = await fetchWithTimeout(fetchFnRef.current, '/api/command/cancel', { method: 'POST' });
    } catch {
      setMessage('Netzwerkfehler beim Abbrechen.');
      setMsgType('error');
      return;
    }

    if (res.ok) {
      setRunState('idle');
      setMessage(null);
      setMsgType(null);
    } else {
      setMessage('Abbrechen fehlgeschlagen — bitte erneut versuchen.');
      setMsgType('error');
    }
  }, []);

  const isRunning    = runState === 'running';
  const triggerLabel = isRunning ? '⚙ Läuft — gesperrt' : null;

  return (
    <aside style={styles.panel} aria-label="Flow-Trigger">
      <header style={styles.panelHeader}>
        <span style={styles.panelTitle}>Trigger</span>
        {isRunning && (
          <span
            role="status"
            aria-live="polite"
            aria-label="Job läuft"
            style={styles.runningBadge}
          >
            <span aria-hidden="true">⚙</span>
            {' '}läuft
          </span>
        )}
      </header>

      <div style={styles.body}>
        {/* Command selector */}
        <label style={styles.label} htmlFor="trigger-cmd">
          Befehl
        </label>
        <select
          id="trigger-cmd"
          style={styles.select}
          value={cmd}
          disabled={isRunning}
          aria-disabled={isRunning}
          onChange={(e) => setCmd(e.target.value)}
        >
          {ALLOWED_COMMANDS.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {/* Argument input */}
        <label style={styles.label} htmlFor="trigger-arg">
          Argument <span style={styles.optional}>(optional)</span>
        </label>
        <input
          id="trigger-arg"
          type="text"
          style={styles.input}
          placeholder="Projekt / Issue-Ref"
          value={arg}
          disabled={isRunning}
          aria-disabled={isRunning}
          onChange={(e) => setArg(e.target.value)}
        />

        {/* Lock notice — supplemental text when disabled (not color alone) */}
        {isRunning && triggerLabel && (
          <div style={styles.lockNotice} aria-live="polite">
            {triggerLabel}
          </div>
        )}

        {/* Message area */}
        {message && (
          <div
            role="alert"
            style={msgType === 'error' ? styles.errorMsg : styles.infoMsg}
          >
            {message}
          </div>
        )}

        {/* Action buttons */}
        <div style={styles.buttonRow}>
          <button
            type="button"
            style={isRunning ? styles.btnPrimaryDisabled : styles.btnPrimary}
            disabled={isRunning}
            aria-disabled={isRunning}
            aria-label={isRunning ? 'Befehl senden — gesperrt (Job läuft)' : `Befehl senden: ${cmd}`}
            onClick={handleFire}
          >
            Senden
          </button>

          {/* Kill button — clearly distinct: amber, always shown, active only when running */}
          <button
            type="button"
            style={isRunning ? styles.btnKill : styles.btnKillDisabled}
            disabled={!isRunning}
            aria-disabled={!isRunning}
            aria-label={isRunning ? 'Laufenden Job abbrechen (Kill)' : 'Kill — kein Job läuft'}
            onClick={handleKill}
          >
            Kill
          </button>
        </div>
      </div>
    </aside>
  );
}

// ── Styles (inline, dark-first, 8-pt scale) ──────────────────────────────────

const styles = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    background: '#111',
    borderLeft: '1px solid #2a2a2a',
    minWidth: 240,
    maxWidth: 300,
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
    color: '#d4d4d4',
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    borderBottom: '1px solid #2a2a2a',
    background: '#0d0d0d',
    position: 'sticky',
    top: 0,
    zIndex: 1,
  },
  panelTitle: {
    fontWeight: 600,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#9ca3af',
  },
  runningBadge: {
    color: '#fbbf24',
    fontSize: 12,
    fontWeight: 500,
  },
  body: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  label: {
    fontSize: 12,
    color: '#9ca3af',
    marginBottom: 2,
  },
  optional: {
    fontSize: 11,
    color: '#9ca3af',
  },
  select: {
    background: '#1e1e1e',
    color: '#d4d4d4',
    border: '1px solid #333',
    borderRadius: 4,
    padding: '6px 8px',
    fontSize: 13,
    width: '100%',
    cursor: 'pointer',
  },
  input: {
    background: '#1e1e1e',
    color: '#d4d4d4',
    border: '1px solid #333',
    borderRadius: 4,
    padding: '6px 8px',
    fontSize: 13,
    width: '100%',
    boxSizing: 'border-box',
  },
  lockNotice: {
    fontSize: 11,
    color: '#fbbf24',
    fontStyle: 'italic',
  },
  errorMsg: {
    padding: '6px 8px',
    background: '#1f0f0f',
    border: '1px solid #3f1010',
    borderRadius: 4,
    color: '#f87171',
    fontSize: 12,
  },
  infoMsg: {
    padding: '6px 8px',
    background: '#1a1500',
    border: '1px solid #3a2f00',
    borderRadius: 4,
    color: '#fbbf24',
    fontSize: 12,
  },
  buttonRow: {
    display: 'flex',
    gap: 8,
    marginTop: 8,
  },
  btnPrimary: {
    flex: 1,
    padding: '8px 12px',
    background: '#1d4ed8',
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnPrimaryDisabled: {
    flex: 1,
    padding: '8px 12px',
    background: '#1e293b',
    color: '#64748b',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed',
    minHeight: 44,
  },
  btnKill: {
    padding: '8px 16px',
    background: '#92400e',
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnKillDisabled: {
    padding: '8px 16px',
    background: '#1e1e1e',
    color: '#4b5563',
    border: '1px solid #333',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'not-allowed',
    minHeight: 44,
  },
};
