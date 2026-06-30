/**
 * PtySessionRegistry — manages multiple PTY sessions, one per project.
 *
 * Each session is keyed by the project path (an absolute filesystem path).
 * Sessions are created on first access and destroyed after an idle period
 * (no active WebSocket subscriber + no write activity).
 *
 * Config (env):
 *   SESSION_CAP       — max concurrent sessions (default: 5)
 *   SESSION_IDLE_MS   — idle timeout in ms before a session is auto-closed (default: 1800000 = 30 min)
 *
 * The original single-session behaviour is preserved via getDefault() / getOrCreate(null):
 * these return the "global" session that has no project path (cwd = process.cwd()).
 *
 * Security:
 *   - Project paths are never passed to a shell; they are used only as Map keys
 *     and as the `cwd` option to node-pty (which accepts an absolute path).
 *   - Session key is the raw project path string — callers must validate/normalise
 *     paths before passing them (e.g. via WorkspaceScanner / realpath).
 *   - No secret is logged; only path basename is emitted in debug logs.
 *
 * @module PtySessionRegistry
 */

import { EventEmitter } from 'node:events';
import { PtyManager } from './PtyManager.js';

/** Default maximum number of concurrent project sessions (excluding the global default). */
const DEFAULT_SESSION_CAP = 5;

/** Default idle timeout: 30 minutes in ms. */
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

/** Sentinel key for the global (no-project) session. */
const GLOBAL_KEY = '__global__';

/**
 * PtySessionRegistry manages one PTY session per project path.
 *
 * Usage:
 *   const registry = new PtySessionRegistry();
 *   registry.start();                              // start global session
 *   const session = registry.getOrCreate('/path/to/project');  // create/return project session
 *   const global  = registry.getDefault();         // global fallback session
 *   const active  = registry.hasSession('/path/to/project'); // non-mutating existence check
 */
export class PtySessionRegistry extends EventEmitter {
  /** @type {number} */
  #cap;
  /** @type {number} */
  #idleMs;
  /** @type {Map<string, SessionEntry>} */
  #sessions = new Map();
  /** @type {boolean} */
  #destroyed = false;

  // Spawn config forwarded to each PtyManager
  #cmd;
  #args;
  #restartMax;
  #restartWindowMs;

  /**
   * @param {object} [options]
   * @param {number} [options.cap]           Max project sessions (default: SESSION_CAP env or 5)
   * @param {number} [options.idleMs]        Idle-close timeout in ms (default: SESSION_IDLE_MS env or 1800000)
   * @param {string} [options.cmd]           Command to spawn (forwarded to PtyManager)
   * @param {string[]} [options.args]        Args to spawn (forwarded to PtyManager)
   * @param {number} [options.restartMax]    Max restarts (forwarded to PtyManager)
   * @param {number} [options.restartWindowMs] Restart window (forwarded to PtyManager)
   */
  constructor({
    cap,
    idleMs,
    cmd,
    args,
    restartMax,
    restartWindowMs,
  } = {}) {
    super();
    this.#cap = cap ?? parsePositiveInt(process.env.SESSION_CAP, DEFAULT_SESSION_CAP);
    this.#idleMs = idleMs ?? parsePositiveInt(process.env.SESSION_IDLE_MS, DEFAULT_SESSION_IDLE_MS);
    this.#cmd = cmd;
    this.#args = args;
    this.#restartMax = restartMax;
    this.#restartWindowMs = restartWindowMs;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Start the global (no-project) session immediately.
   * Mirrors the old PtyManager.start() call in server.js.
   */
  start() {
    const entry = this.#ensureSession(GLOBAL_KEY, undefined);
    entry.pty.start();
  }

  /**
   * Get the global (no-project) session.
   * Always available after start().
   * @returns {import('./PtyManager.js').PtyManager}
   */
  getDefault() {
    const entry = this.#sessions.get(GLOBAL_KEY);
    if (!entry) throw new Error('PtySessionRegistry: start() not called');
    return entry.pty;
  }

  /**
   * Get an existing project session, or create a new one.
   *
   * When projectPath is null/undefined/'', returns the global session (backward compat).
   * When the session cap is reached, returns null (caller should return 503).
   *
   * @param {string|null|undefined} projectPath  Absolute project directory path.
   * @returns {import('./PtyManager.js').PtyManager|null}
   */
  getOrCreate(projectPath) {
    if (this.#destroyed) return null;

    // Normalise: empty/null → global
    const key = toKey(projectPath);

    if (key === GLOBAL_KEY) {
      // Return global session (must exist after start())
      const entry = this.#sessions.get(GLOBAL_KEY);
      return entry ? entry.pty : null;
    }

    // Return existing session if present
    if (this.#sessions.has(key)) {
      const entry = this.#sessions.get(key);
      this.#resetIdleTimer(key, entry);
      return entry.pty;
    }

    // Check cap (global session does not count toward cap)
    const projectCount = this.#projectSessionCount();
    if (projectCount >= this.#cap) {
      return null; // Cap exceeded
    }

    // Create new project session
    const cwd = projectPath; // absolute path, used as spawn cwd
    const entry = this.#ensureSession(key, cwd);
    entry.pty.start();
    return entry.pty;
  }

  /**
   * Check whether a session currently exists for `projectPath`, WITHOUT
   * creating one (non-mutating, unlike `getOrCreate()`). Used by busy-
   * detection (`ProjectJobLock.isProjectBusy`,
   * docs/specs/taktgeber-nachtwaechter.md AC7) so checking "is this project
   * active?" never has the side effect of spawning a new PTY.
   *
   * The global key (null/undefined/''/whitespace-only) is intentionally
   * NOT considered a project session — always returns `false` for it, since
   * the global session is not project-scoped.
   *
   * @param {string|null|undefined} projectPath
   * @returns {boolean}
   */
  hasSession(projectPath) {
    const key = toKey(projectPath);
    if (key === GLOBAL_KEY) return false;
    return this.#sessions.has(key);
  }

  /**
   * Explicitly close (destroy) a project session.
   * No-op if session does not exist.
   *
   * @param {string} projectPath
   */
  closeSession(projectPath) {
    const key = toKey(projectPath);
    this.#destroySession(key);
  }

  /**
   * Destroy all sessions (graceful shutdown).
   */
  destroy() {
    this.#destroyed = true;
    for (const key of [...this.#sessions.keys()]) {
      this.#destroySession(key);
    }
  }

  /**
   * Return the number of currently active sessions (including global).
   * @returns {number}
   */
  get sessionCount() {
    return this.#sessions.size;
  }

  /**
   * Return the session cap (max project sessions, excluding global).
   * @returns {number}
   */
  get cap() {
    return this.#cap;
  }

  /**
   * Return the idle timeout in ms.
   * @returns {number}
   */
  get idleMs() {
    return this.#idleMs;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Create and register a new session entry.
   * Does NOT call pty.start() — caller must do that.
   *
   * @param {string} key
   * @param {string|undefined} cwd
   * @returns {SessionEntry}
   */
  #ensureSession(key, cwd) {
    const pty = new PtyManager({
      ...(this.#cmd !== undefined && { cmd: this.#cmd }),
      ...(this.#args !== undefined && { args: this.#args }),
      ...(this.#restartMax !== undefined && { restartMax: this.#restartMax }),
      ...(this.#restartWindowMs !== undefined && { restartWindowMs: this.#restartWindowMs }),
      ...(cwd !== undefined && { cwd }),
    });

    /** @type {SessionEntry} */
    const entry = {
      pty,
      idleTimer: null,
      cwd: cwd ?? null,
    };

    this.#sessions.set(key, entry);

    // Arm idle timer (not for global session — it lives forever)
    if (key !== GLOBAL_KEY && this.#idleMs > 0) {
      this.#resetIdleTimer(key, entry);
    }

    return entry;
  }

  /**
   * Reset (or arm) the idle timer for a session.
   * @param {string} key
   * @param {SessionEntry} entry
   */
  #resetIdleTimer(key, entry) {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
    }
    entry.idleTimer = setTimeout(() => {
      this.#destroySession(key);
    }, this.#idleMs);
    // Don't block process exit on this timer
    if (entry.idleTimer.unref) entry.idleTimer.unref();
  }

  /**
   * Destroy a single session and remove it from the map.
   * @param {string} key
   */
  #destroySession(key) {
    const entry = this.#sessions.get(key);
    if (!entry) return;

    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    try {
      entry.pty.destroy();
    } catch {
      // ignore — PTY may already be dead
    }

    this.#sessions.delete(key);
    this.emit('session-closed', key);
  }

  /**
   * Count project sessions (excludes global).
   * @returns {number}
   */
  #projectSessionCount() {
    let count = 0;
    for (const key of this.#sessions.keys()) {
      if (key !== GLOBAL_KEY) count += 1;
    }
    return count;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ pty: import('./PtyManager.js').PtyManager, idleTimer: NodeJS.Timeout|null, cwd: string|null }} SessionEntry
 */

/**
 * Normalise a project path to a Map key.
 * Empty/null/undefined → GLOBAL_KEY.
 *
 * @param {string|null|undefined} projectPath
 * @returns {string}
 */
function toKey(projectPath) {
  if (!projectPath || typeof projectPath !== 'string' || !projectPath.trim()) {
    return GLOBAL_KEY;
  }
  return projectPath.trim();
}

/**
 * Parse an env var as a positive integer with a fallback.
 * @param {string|undefined} raw
 * @param {number} defaultVal
 * @returns {number}
 */
function parsePositiveInt(raw, defaultVal) {
  if (raw === undefined || raw === null) return defaultVal;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultVal;
}
