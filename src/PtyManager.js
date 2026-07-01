/**
 * PtyManager — owns exactly one interactive PTY session.
 *
 * Configurable via env:
 *   SESSION_CMD   — command to spawn (default: "claude")
 *   SESSION_ARGS  — JSON array of additional args (default: [])
 *   RESTART_MAX   — max restarts per window (default: 5)
 *   RESTART_WINDOW_MS — window in ms (default: 60000)
 *
 * Security: ANTHROPIC_API_KEY is explicitly deleted from the child env
 * (AC3). No secret is logged.
 *
 * Multi-session extension (AC4): the `cwd` constructor option sets the
 * working directory of the spawned process.  When undefined, the process
 * inherits the server's cwd (backward-compatible default).
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node-pty';

// Ring-buffer capacity in bytes (AC6)
const SCROLLBACK_BYTE_LIMIT = 64 * 1024;

// Session states (spec: starting → ready ⇄ busy, stopped, failed)
export const SESSION_STATES = /** @type {const} */ ({
  STARTING: 'starting',
  READY: 'ready',
  BUSY: 'busy',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

/**
 * @typedef {'starting'|'ready'|'busy'|'stopped'|'failed'} SessionState
 */

export class PtyManager extends EventEmitter {
  /** @type {SessionState} */
  #state = SESSION_STATES.STARTING;
  /** @type {number} */
  #restarts = 0;
  /** @type {Date|null} */
  #startedAt = null;
  /** @type {import('node-pty').IPty|null} */
  #pty = null;
  /** @type {number[]} restart timestamps (ms) for window check */
  #restartTimestamps = [];
  /** @type {boolean} */
  #destroyed = false;

  // Config (read once at construction, never from runtime input)
  #cmd;
  #args;
  #restartMax;
  #restartWindowMs;
  /** @type {string|undefined} cwd for the spawned process (AC4 multi-session) */
  #cwd;

  // AC6: bounded ring buffer of recent PTY output
  // Stored as an array of strings; total byte length tracked separately.
  /** @type {string[]} */
  #scrollback = [];
  /** @type {number} */
  #scrollbackBytes = 0;

  constructor({
    cmd = process.env.SESSION_CMD ?? 'claude',
    args = parseArgs(process.env.SESSION_ARGS),
    restartMax = parsePositiveInt(process.env.RESTART_MAX, 5),
    restartWindowMs = parsePositiveInt(process.env.RESTART_WINDOW_MS, 60_000),
    cwd = undefined,
  } = {}) {
    super();
    this.#cmd = cmd;
    this.#args = args;
    this.#restartMax = restartMax;
    this.#restartWindowMs = restartWindowMs;
    this.#cwd = cwd;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  get state() { return this.#state; }
  get restarts() { return this.#restarts; }
  get startedAt() { return this.#startedAt; }

  /** Expose spawn config for testing (AC3). Read-only view. */
  get spawnConfig() {
    return { cmd: this.#cmd, args: [...this.#args], cwd: this.#cwd };
  }

  /**
   * Return a snapshot of the current scrollback buffer as a single string (AC6).
   * Safe to call from WsGateway on new-connection replay.
   * @returns {string}
   */
  get scrollback() {
    return this.#scrollback.join('');
  }

  /**
   * Resize the PTY to the given dimensions (AC5).
   * Validates that cols and rows are positive integers; silently ignores invalid values.
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) return;
    if (this.#pty) {
      this.#pty.resize(cols, rows);
    }
  }

  start() {
    if (this.#destroyed) throw new Error('PtyManager already destroyed');
    this.#spawn();
  }

  /**
   * Write input data to the PTY (AC2).
   * Validated: only string data accepted; silently dropped when no PTY.
   * @param {string} data
   */
  write(data) {
    if (typeof data !== 'string') return;
    if (this.#pty && this.#state !== SESSION_STATES.FAILED) {
      this.#pty.write(data);
    }
  }

  /** Graceful teardown — no restart after this. */
  destroy() {
    this.#destroyed = true;
    this.#setState(SESSION_STATES.STOPPED);
    this.#killPty();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  #spawn() {
    if (this.#destroyed) return;

    // Build a clean child env from an explicit allowlist (security/R01 — AC3).
    // Never spread process.env: parent secrets must not leak into the child PTY.
    //
    // Two categories are on the list:
    //   (a) Pure shell/locale plumbing — needed by any interactive process.
    //   (b) Skill-Bridge vars — explicitly required by /agent-flow:* skills that
    //       run inside the claude session:
    //       • DOCKER_HOST      — points the `docker` CLI at the socket-proxy
    //                            (not a secret, just an address); without it the
    //                            CLI defaults to /var/run/docker.sock which is
    //                            not mounted (by design, see hardening AC4).
    //       • GPG_PASSPHRASE   — used by ensure-gh-auth.sh / load-env.sh to
    //                            decrypt the plugin's `.env.gpg` and mint a
    //                            fresh GitHub-App token mid-session (token TTL
    //                            ~1h). Yes, a secret — but skills already read
    //                            the contents of `.env.gpg`, so the passphrase
    //                            is not "more secret" than what it unlocks.
    //       • CLAUDE_CODE_OAUTH_TOKEN — langlebiges Claude-Code-Auth-Token
    //                            (docs/specs/claude-code-oauth-token.md AC2).
    //                            Das ist die Auth des Agenten SELBST (Abo-
    //                            OAuth), keine server-only-Plattform-Config —
    //                            bewusst durchgereicht, damit die gespawnte
    //                            `claude`-Session headless funktioniert.
    //
    // Explicitly NOT on the list (server-only, must not leak to the agent):
    //   ACCESS_TEAM_DOMAIN, ACCESS_AUD, ANTHROPIC_API_KEY, OPENAI_API_KEY,
    //   NODE_ENV, DEV_NO_ACCESS, GH_TOKEN, GITHUB_TOKEN (cleared at boot anyway).
    //   ANTHROPIC_API_KEY/OPENAI_API_KEY stay blocked even though
    //   CLAUDE_CODE_OAUTH_TOKEN is now allowed — both conditions hold at once
    //   (AC3 trust-boundary).
    const ALLOWED_ENV_KEYS = [
      'PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
      'USER', 'LOGNAME', 'SHELL', 'TZ',
      // Skill-Bridge:
      'DOCKER_HOST', 'GPG_PASSPHRASE', 'CLAUDE_CODE_OAUTH_TOKEN',
    ];
    const childEnv = {};
    for (const key of ALLOWED_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        childEnv[key] = process.env[key];
      }
    }
    // SESSION_CMD-related vars the session legitimately needs
    if (process.env.SESSION_CMD !== undefined) childEnv.SESSION_CMD = process.env.SESSION_CMD;
    if (process.env.SESSION_ARGS !== undefined) childEnv.SESSION_ARGS = process.env.SESSION_ARGS;

    this.#startedAt = new Date();
    this.#setState(SESSION_STATES.STARTING);

    let pty;
    try {
      pty = spawn(this.#cmd, this.#args, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        env: childEnv,
        // cwd: undefined → inherits process.cwd() (backward compat).
        // When set (AC4 multi-session), the PTY starts in the project directory.
        ...(this.#cwd !== undefined && { cwd: this.#cwd }),
      });
    } catch {
      // spawn failed (e.g. command not found) — treat as unexpected exit
      this.#handleExit();
      return;
    }

    this.#pty = pty;

    pty.onData((data) => {
      // AC2: broadcast raw output (ANSI preserved) — never logged as secret
      this.emit('output', data);

      // AC6: accumulate into bounded ring buffer
      this.#appendScrollback(data);

      // Heuristic: detect claude prompt → transition to ready
      // We transition to ready once we see output (stub/real alike).
      // A more sophisticated implementation would parse the prompt;
      // for AC1 ("reaches ready without input") this suffices with any
      // command that produces output.
      if (this.#state === SESSION_STATES.STARTING) {
        this.#setState(SESSION_STATES.READY);
      }
    });

    pty.onExit(() => {
      this.#pty = null;
      if (!this.#destroyed) {
        this.#handleExit();
      }
    });
  }

  #handleExit() {
    if (this.#destroyed) return;

    const now = Date.now();
    // Prune timestamps outside window
    this.#restartTimestamps = this.#restartTimestamps.filter(
      (t) => now - t < this.#restartWindowMs,
    );

    if (this.#restartTimestamps.length >= this.#restartMax) {
      // AC4: cap exceeded → failed
      this.#setState(SESSION_STATES.FAILED);
      return;
    }

    // Record this restart attempt
    this.#restartTimestamps.push(now);
    this.#restarts += 1;
    this.#setState(SESSION_STATES.STARTING);
    this.#spawn();
  }

  #setState(newState) {
    this.#state = newState;
    // AC2: push state change to listeners (WS-Gateway re-broadcasts)
    this.emit('state', newState);
  }

  #killPty() {
    try {
      this.#pty?.kill();
    } catch {
      // ignore — process may already be dead
    }
    this.#pty = null;
  }

  /**
   * Append a chunk to the scrollback ring buffer (AC6).
   * Drops oldest chunks until total size stays within SCROLLBACK_BYTE_LIMIT.
   * @param {string} chunk
   */
  #appendScrollback(chunk) {
    this.#scrollback.push(chunk);
    this.#scrollbackBytes += chunk.length;

    // Evict oldest chunks until we are within the limit
    while (this.#scrollbackBytes > SCROLLBACK_BYTE_LIMIT && this.#scrollback.length > 0) {
      const evicted = this.#scrollback.shift();
      this.#scrollbackBytes -= evicted.length;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse an env var as a non-negative integer, falling back to `defaultVal`
 * when the raw value is absent, non-numeric, non-finite, or negative.
 * Prevents NaN-based bypass of the restart cap (AC4).
 * @param {string|undefined} raw
 * @param {number} defaultVal
 * @returns {number}
 */
function parsePositiveInt(raw, defaultVal) {
  if (raw === undefined || raw === null) return defaultVal;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultVal;
}

/**
 * Parse SESSION_ARGS env var (JSON array) safely.
 * Returns [] on any invalid input.
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseArgs(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
  } catch {
    // invalid JSON — ignore
  }
  return [];
}

/**
 * Returns true iff v is a finite integer > 0 (AC5 resize validation).
 * Rejects 0, negatives, floats, NaN, Infinity, non-numbers.
 * @param {unknown} v
 * @returns {boolean}
 */
function isPositiveInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}
