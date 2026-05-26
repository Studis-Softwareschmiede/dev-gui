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
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node-pty';

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

  constructor({
    cmd = process.env.SESSION_CMD ?? 'claude',
    args = parseArgs(process.env.SESSION_ARGS),
    restartMax = parsePositiveInt(process.env.RESTART_MAX, 5),
    restartWindowMs = parsePositiveInt(process.env.RESTART_WINDOW_MS, 60_000),
  } = {}) {
    super();
    this.#cmd = cmd;
    this.#args = args;
    this.#restartMax = restartMax;
    this.#restartWindowMs = restartWindowMs;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  get state() { return this.#state; }
  get restarts() { return this.#restarts; }
  get startedAt() { return this.#startedAt; }

  /** Expose spawn config for testing (AC3). Read-only view. */
  get spawnConfig() {
    return { cmd: this.#cmd, args: [...this.#args] };
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
    const ALLOWED_ENV_KEYS = [
      'PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
      'USER', 'LOGNAME', 'SHELL', 'TZ',
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
        cols: 220,
        rows: 50,
        env: childEnv,
        // cwd defaults to process.cwd() — fine for claude
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
