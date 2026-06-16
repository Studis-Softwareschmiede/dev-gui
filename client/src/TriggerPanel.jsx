/**
 * TriggerPanel.jsx — Flow-Trigger-Panel component (AC4, AC7).
 *
 * Lets the user compose and fire an allowlisted slash-command via
 * POST /api/command {command}. Derives running/idle state from
 * GET /api/session (state:"busy") and from 202/409 responses.
 *
 * Command-aware composition (AC4, AC7):
 *   Each `/agent-flow:*` command exposes only the valid sub-commands/args
 *   (per the Befehls-Katalog in docs/specs/flow-trigger.md). The panel
 *   composes the full single-line command string and POSTs it to /api/command.
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
 *   - Client catalog is UX only; server is the enforcement boundary (#8)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { COST_MODES, COST_MODE_INFO, COST_AWARE_COMMANDS, costFlag } from './costMode.js';

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

// ── Command catalog (AC4, AC7) ────────────────────────────────────────────────

/**
 * Plugin-namespaced allowlist (mirrors server AC2; server is authoritative).
 * @type {string[]}
 */
const ALLOWED_COMMANDS = [
  '/agent-flow:flow',
  '/agent-flow:adopt',
  '/agent-flow:new-project',
  '/agent-flow:preview',
  '/agent-flow:requirement',
  '/agent-flow:train',
];

/** Sub-commands for `preview` that require a <repo> argument. */
const PREVIEW_REPO_SUBS = ['up', 'down'];
/** All valid preview sub-commands. */
const PREVIEW_SUBS = ['up', 'down', 'list', 'available'];

/** Session poll interval in ms */
const SESSION_POLL_MS = 3_000;

// ── Compose the command line (AC7) ────────────────────────────────────────────

/**
 * Build the full command string from the current UI selections.
 * Returns null when a required field is missing (caller must not fire).
 *
 * @param {string}      cmd       Selected command, e.g. '/agent-flow:preview'
 * @param {string}      subCmd    Selected sub-command (preview only)
 * @param {string}      repoArg   Selected/typed repo (preview up/down or adopt)
 * @param {string}      freeArg   Free-text argument (requirement/train)
 * @param {string}      costMode  Selected cost-mode (flow/requirement/train)
 * @returns {string|null}
 */
function composeCommand(cmd, subCmd, repoArg, freeArg, costMode) {
  // Cost flag sits directly after the prefix, before any sub/arg/free-text (AC9).
  const cost = costFlag(cmd, costMode);

  switch (cmd) {
    case '/agent-flow:flow':
      return `${cmd}${cost}`;

    case '/agent-flow:new-project':
      // No argument, no cost-mode (analogous to adopt — not cost-aware). AC3/AC9.
      return cmd;

    case '/agent-flow:adopt': {
      const repo = repoArg.trim();
      if (!repo) return null; // required — AC7
      return `${cmd} ${repo}`;
    }

    case '/agent-flow:preview': {
      const needsRepo = PREVIEW_REPO_SUBS.includes(subCmd);
      if (needsRepo) {
        const repo = repoArg.trim();
        if (!repo) return null; // required — AC7
        return `${cmd} ${subCmd} ${repo}`;
      }
      // list / available — no argument
      return `${cmd} ${subCmd}`;
    }

    case '/agent-flow:requirement': {
      const text = freeArg.trim();
      return text ? `${cmd}${cost} ${text}` : `${cmd}${cost}`;
    }

    case '/agent-flow:train': {
      const text = freeArg.trim();
      return text ? `${cmd}${cost} ${text}` : `${cmd}${cost}`;
    }

    default:
      return null;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * TriggerPanel — compose and fire plugin-namespaced slash-commands.
 *
 * @param {{
 *   pollInterval?: number,
 *   fetchFn?: Function,
 *   projectPath?: string,
 * }} props
 *   pollInterval — override for tests (default: SESSION_POLL_MS)
 *   fetchFn      — override for tests (default: global fetch)
 *   projectPath  — when set (from Cockpit activeRepo), sent as projectPath in POST /api/command
 *                  so the command runs in the correct project session (AC5/S-111).
 *                  When absent or empty, the global session is used (backward compat).
 */
export function TriggerPanel({ pollInterval = SESSION_POLL_MS, fetchFn, projectPath }) {
  /** 'idle' | 'running' */
  const [runState, setRunState]     = useState('idle');
  /** Currently selected command */
  const [cmd, setCmd]               = useState(ALLOWED_COMMANDS[0]);
  /** Sub-command for preview */
  const [previewSub, setPreviewSub] = useState(PREVIEW_SUBS[0]);
  /** Repo selection (preview up/down or adopt owner/repo) */
  const [repoArg, setRepoArg]       = useState('');
  /** Free-text argument (requirement / train) */
  const [freeArg, setFreeArg]       = useState('');
  /** Cost-mode for agent-dispatching commands (flow/requirement/train) — AC9 */
  const [costMode, setCostMode]     = useState('balanced');
  /** Project list from /api/status for repo selects */
  const [projects, setProjects]     = useState(null); // null = loading / unavailable
  /** UI message for validation errors or status */
  const [message, setMessage]       = useState(null);
  /** 'error' | 'info' | null */
  const [msgType, setMsgType]       = useState(null);

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

  // ── Fetch project list for repo selects ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function fetchProjects() {
      try {
        const res = await fetchWithTimeout(fetchFnRef.current, '/api/status');
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && Array.isArray(json?.projects)) {
          setProjects(json.projects.map((p) => p.name));
        }
      } catch {
        // unavailable — fall back to free-text (graceful)
      }
    }

    fetchProjects();
  }, []); // one-shot on mount — fetchFnRef is a stable ref, no dep needed

  // ── Derived state ────────────────────────────────────────────────────────

  const isRunning = runState === 'running';

  // Determine whether the current selection needs a repo control
  const needsRepo =
    (cmd === '/agent-flow:preview' && PREVIEW_REPO_SUBS.includes(previewSub)) ||
    cmd === '/agent-flow:adopt';

  // Whether the current command supports the cost-mode switch (AC9)
  const isCostAware = COST_AWARE_COMMANDS.includes(cmd);

  // Composed command line — null means "required field missing → Senden disabled"
  const composed = composeCommand(cmd, previewSub, repoArg, freeArg, costMode);
  const canFire  = !isRunning && composed !== null;

  // ── Fire command ─────────────────────────────────────────────────────────
  const handleFire = useCallback(async () => {
    const command = composeCommand(cmd, previewSub, repoArg, freeArg, costMode);
    if (!command) return; // AC7: guard — required field missing
    setMessage(null);
    setMsgType(null);

    // Build request body: include projectPath when set (AC5/S-111 multi-session routing).
    // Backward compat: omit projectPath when absent/empty → global session.
    const body = { command };
    if (projectPath && typeof projectPath === 'string' && projectPath.trim()) {
      body.projectPath = projectPath.trim();
    }

    let res;
    try {
      res = await fetchWithTimeout(fetchFnRef.current, '/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
  }, [cmd, previewSub, repoArg, freeArg, costMode, projectPath]);

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

  const triggerLabel = isRunning ? '⚙ Läuft — gesperrt' : null;

  // ── Render ────────────────────────────────────────────────────────────────

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
          onChange={(e) => {
            setCmd(e.target.value);
            setRepoArg('');
            setFreeArg('');
          }}
        >
          {ALLOWED_COMMANDS.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {/* Cost-mode switch — only for agent-dispatching commands (AC9) */}
        {isCostAware && (
          <>
            <label style={styles.label} htmlFor="trigger-cost">
              Cost-Mode <span style={styles.optional}>(Token-Hebel)</span>
            </label>
            <select
              id="trigger-cost"
              style={styles.select}
              value={costMode}
              disabled={isRunning}
              aria-disabled={isRunning}
              onChange={(e) => setCostMode(e.target.value)}
            >
              {COST_MODES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <div style={styles.costInfo} aria-live="polite" data-testid="cost-info">
              <span>{COST_MODE_INFO[costMode].models} · {COST_MODE_INFO[costMode].price} /MTok</span>
              <span style={styles.costDisclaimer}>
                ⚠ Abo-Betrieb — keine Direktkosten pro Token; Werte nur relative Tier-Schwere.
              </span>
            </div>
          </>
        )}

        {/* ── Command-aware controls (AC4) ─────────────────────────────── */}

        {/* preview — sub-command select + optional repo select */}
        {cmd === '/agent-flow:preview' && (
          <>
            <label style={styles.label} htmlFor="trigger-preview-sub">
              Sub-Befehl
            </label>
            <select
              id="trigger-preview-sub"
              style={styles.select}
              value={previewSub}
              disabled={isRunning}
              aria-disabled={isRunning}
              onChange={(e) => {
                setPreviewSub(e.target.value);
                setRepoArg('');
              }}
            >
              {PREVIEW_SUBS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            {/* repo select — only for up/down (required) */}
            {PREVIEW_REPO_SUBS.includes(previewSub) && (
              <>
                <label style={styles.label} htmlFor="trigger-repo">
                  Repo <span style={styles.required}>(Pflicht)</span>
                </label>
                {projects !== null && projects.length > 0 ? (
                  <select
                    id="trigger-repo"
                    style={styles.select}
                    value={repoArg}
                    disabled={isRunning}
                    aria-disabled={isRunning}
                    onChange={(e) => setRepoArg(e.target.value)}
                  >
                    <option value="">— wählen —</option>
                    {projects.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="trigger-repo"
                    type="text"
                    style={styles.input}
                    placeholder="Repo-Name"
                    value={repoArg}
                    disabled={isRunning}
                    aria-disabled={isRunning}
                    onChange={(e) => setRepoArg(e.target.value)}
                  />
                )}
              </>
            )}
          </>
        )}

        {/* adopt — owner/repo text input (required) */}
        {cmd === '/agent-flow:adopt' && (
          <>
            <label style={styles.label} htmlFor="trigger-adopt-repo">
              owner/repo <span style={styles.required}>(Pflicht)</span>
            </label>
            <input
              id="trigger-adopt-repo"
              type="text"
              style={styles.input}
              placeholder="octocat/Hello-World"
              value={repoArg}
              disabled={isRunning}
              aria-disabled={isRunning}
              onChange={(e) => setRepoArg(e.target.value)}
            />
          </>
        )}

        {/* requirement — optional free-text */}
        {cmd === '/agent-flow:requirement' && (
          <>
            <label style={styles.label} htmlFor="trigger-free-arg">
              Kontext <span style={styles.optional}>(optional)</span>
            </label>
            <input
              id="trigger-free-arg"
              type="text"
              style={styles.input}
              placeholder="Feature / Kontext-Text"
              value={freeArg}
              disabled={isRunning}
              aria-disabled={isRunning}
              onChange={(e) => setFreeArg(e.target.value)}
            />
          </>
        )}

        {/* train — optional free-text (lang|domain) */}
        {cmd === '/agent-flow:train' && (
          <>
            <label style={styles.label} htmlFor="trigger-free-arg">
              Sprache / Domäne <span style={styles.optional}>(optional)</span>
            </label>
            <input
              id="trigger-free-arg"
              type="text"
              style={styles.input}
              placeholder="security, js, …"
              value={freeArg}
              disabled={isRunning}
              aria-disabled={isRunning}
              onChange={(e) => setFreeArg(e.target.value)}
            />
          </>
        )}

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
            style={canFire ? styles.btnPrimary : styles.btnPrimaryDisabled}
            disabled={!canFire}
            aria-disabled={!canFire}
            aria-label={
              isRunning
                ? 'Befehl senden — gesperrt (Job läuft)'
                : needsRepo && !repoArg.trim()
                ? 'Befehl senden — Repo fehlt'
                : `Befehl senden: ${composed ?? cmd}`
            }
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
  required: {
    fontSize: 11,
    color: '#f87171',
  },
  costInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    marginTop: 4,
    marginBottom: 2,
    fontSize: 11,
    color: '#9ca3af',
  },
  costDisclaimer: {
    fontSize: 10,
    color: '#6b7280',
    fontStyle: 'italic',
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
