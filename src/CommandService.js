/**
 * CommandService — the sole write-path into the PTY from outside (AC1–AC3, AC5, AC6).
 *
 * Responsibilities:
 *   1. Allowlist validation: only commands whose first token is in ALLOWED_COMMANDS.
 *   2. Sanitization: reject any command containing control characters (including \n/\r).
 *   3. Concurrency guard: integrate jobLock — max 1 running command (process-global).
 *   4. Audit: every accepted command produces exactly one AuditStore entry.
 *      If record() throws the command is NOT executed and the lock is released.
 *   5. PTY injection: write sanitized `command\n` to the PTY via PtyManager.
 *   6. Completion detection: idle-timer approach — when the PTY produces no output
 *      for COMMAND_IDLE_MS (default 8000 ms), the command is considered done and the
 *      lock is released. Cancel route short-circuits by sending Ctrl-C and releasing.
 *
 * Completion model (precisified — see also docs/specs/flow-trigger.md AC6):
 *   After a command is accepted, CommandService listens to PtyManager's 'output' events.
 *   Each output chunk resets the idle timer (COMMAND_IDLE_MS). When the quiet period
 *   elapses with no new output, the command transitions to 'done' and the lock is
 *   released. Cancel (AC5) short-circuits this: it sends Ctrl-C, sets status to
 *   'cancelled', and releases the lock immediately regardless of the idle timer.
 *
 * Multi-session extension (AC5 / S-112):
 *   When a PtySessionRegistry is provided (via `sessionRegistry` constructor param),
 *   tryRun() accepts an optional `projectPath` parameter.  The command is written to
 *   the session for that project path; if the session cap is exceeded, tryRun()
 *   returns { ok: false, reason: 'session-cap' }.
 *   When no registry is provided, the legacy single-session behaviour is preserved
 *   (backward compat).
 *
 * Security (Floor):
 *   - security/R02: untrusted command string validated (allowlist + control-char check)
 *     before any write to the PTY sink. Nothing raw is ever passed to a shell.
 *   - security/R04: all routes are behind AccessGuard (applied in server.js); this
 *     service trusts req.identity is already set by the guard.
 *   - projectPath is NOT passed to a shell; it is only used as a session key.
 *   - No secrets are stored, logged, or returned.
 *
 * Config (env):
 *   COMMAND_IDLE_MS  — quiet-period in ms after which a running command is considered
 *                      done and the lock released (default: 8000). Override in tests
 *                      with a short value (e.g. 200).
 */

import { jobLock } from './JobLock.js';

/**
 * Default allowlist of permitted command first-tokens (AC2).
 * Only plugin-namespaced `/agent-flow:<skill>` prefixes are accepted.
 * Un-namespaced commands like `/flow` or `/preview` → rejected with 400.
 * Configurable at construction time.
 */
export const DEFAULT_ALLOWED_COMMANDS = [
  '/agent-flow:flow',
  '/agent-flow:adopt',
  '/agent-flow:preview',
  '/agent-flow:requirement',
  '/agent-flow:train',
];

/**
 * Valid cost-mode values for the `--cost <mode>` flag (AC8).
 * Mirrors agent-flow `knowledge/model-tiers.md`. Configuration, not scattered.
 * @type {string[]}
 */
export const COST_MODES = ['low-cost', 'balanced', 'max-quality', 'frontier'];

/** Default idle period (ms) — see module doc above. */
const DEFAULT_IDLE_MS = 8_000;

/**
 * Sanitize a command string (AC2 / security/R02).
 *
 * Returns `null` when the command must be rejected; returns the trimmed command
 * otherwise. Callers MUST check the return value.
 *
 * Reject conditions:
 *   - Not a string, or empty / whitespace-only string.
 *   - Contains any control character (U+0000–U+001F, U+007F), including
 *     \n (0x0a) and \r (0x0d). This prevents injecting a second line into
 *     the PTY regardless of how the string is constructed.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function sanitizeCommand(raw) {
  if (typeof raw !== 'string') return null;
  // Reject control characters on the RAW string BEFORE trimming.
  // This ensures that a trailing \r (e.g. "/flow\r") is caught even though
  // String.prototype.trim() would silently strip it. Prevents newline/CR injection.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(raw)) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed;
}

/**
 * Check whether the first token of `command` is in the allowlist (AC2).
 *
 * @param {string} command  Already sanitized (non-empty, no control chars).
 * @param {string[]} allowlist
 * @returns {boolean}
 */
export function isAllowed(command, allowlist) {
  const firstToken = command.split(/\s+/)[0];
  return allowlist.includes(firstToken);
}

/**
 * Validate any `--cost <mode>` flag embedded in the command (AC8).
 *
 * Command-agnostic: scans all tokens. When a `--cost` token appears, the
 * immediately following token MUST be one of COST_MODES; otherwise the
 * command is rejected. A trailing `--cost` with no value is rejected too.
 * Commands without a `--cost` flag always pass (backwards-compat).
 *
 * @param {string} command  Already sanitized (non-empty, no control chars).
 * @param {string[]} [modes=COST_MODES]
 * @returns {boolean} true when there is no invalid cost flag.
 */
export function hasValidCostFlag(command, modes = COST_MODES) {
  const tokens = command.split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === '--cost') {
      const value = tokens[i + 1];
      if (value === undefined || !modes.includes(value)) return false;
    }
  }
  return true;
}

/**
 * CommandService — stateful single-instance service.
 *
 * Expected lifecycle: one shared instance per process, shared across routes.
 */
export class CommandService {
  /** @type {import('./PtyManager.js').PtyManager|null} legacy single-session PTY */
  #pty;
  /**
   * Optional multi-session registry (AC5 / S-112).
   * When set, tryRun() resolves the PTY from the registry using projectPath.
   * @type {import('./PtySessionRegistry.js').PtySessionRegistry|null}
   */
  #registry;
  /** @type {import('./AuditStore.js').AuditStore} */
  #audit;
  /** @type {import('./JobLock.js').JobLock} */
  #lock;
  /** @type {string[]} */
  #allowlist;
  /** @type {string[]} */
  #costModes;
  /** @type {number} */
  #idleMs;

  // ── Running command state ────────────────────────────────────────────────
  /** @type {string|null} commandId of the currently running command */
  #currentId = null;
  /** @type {'running'|'done'|'cancelled'|null} */
  #currentStatus = null;
  /** @type {NodeJS.Timeout|null} */
  #idleTimer = null;
  /** @type {((data: string) => void)|null} active output listener for idle reset */
  #outputListener = null;
  /** @type {import('./PtyManager.js').PtyManager|null} PTY used by the running command */
  #currentPty = null;

  /**
   * @param {object} params
   * @param {import('./PtyManager.js').PtyManager} [params.ptyManager]
   *   Single-session PTY (legacy mode). Used when sessionRegistry is not provided.
   * @param {import('./PtySessionRegistry.js').PtySessionRegistry} [params.sessionRegistry]
   *   Multi-session registry (AC5 / S-112). When provided, projectPath in tryRun()
   *   selects the target session.
   * @param {import('./AuditStore.js').AuditStore} params.auditStore
   * @param {import('./JobLock.js').JobLock} [params.lock]     injectable for tests
   * @param {string[]} [params.allowlist]
   * @param {string[]} [params.costModes]  valid --cost values (default: COST_MODES)
   * @param {number} [params.idleMs]  quiet-period ms (default: env COMMAND_IDLE_MS || 8000)
   */
  constructor({ ptyManager, sessionRegistry, auditStore, lock = jobLock, allowlist = DEFAULT_ALLOWED_COMMANDS, costModes = COST_MODES, idleMs } = {}) {
    this.#pty = ptyManager ?? null;
    this.#registry = sessionRegistry ?? null;
    this.#audit = auditStore;
    this.#lock = lock;
    this.#allowlist = allowlist;
    this.#costModes = costModes;
    this.#idleMs = idleMs ?? parsePositiveInt(process.env.COMMAND_IDLE_MS, DEFAULT_IDLE_MS);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Attempt to run a command in the PTY session.
   *
   * @param {object} params
   * @param {unknown} params.command   - Raw command string from the request body.
   * @param {string|null|object} params.identity - Identity from AccessGuard.
   * @param {string|null|undefined} [params.projectPath] - Project path for multi-session
   *   routing (AC5 / S-112). When provided with a sessionRegistry, the command is
   *   written to the session for this project. Ignored in legacy single-session mode.
   *
   * @returns {{ ok: true, commandId: string, status: 'running' }}
   *        | { ok: false, reason: 'invalid'|'locked'|'session-cap'|'internal' }
   */
  tryRun({ command, identity, projectPath }) {
    // Step 1: Sanitize (security/R02, AC2)
    const sanitized = sanitizeCommand(command);
    if (sanitized === null) {
      return { ok: false, reason: 'invalid' };
    }

    // Step 2: Allowlist check (AC2)
    if (!isAllowed(sanitized, this.#allowlist)) {
      return { ok: false, reason: 'invalid' };
    }

    // Step 2b: Cost-mode flag validation (AC8) — reject malformed --cost <mode>
    if (!hasValidCostFlag(sanitized, this.#costModes)) {
      return { ok: false, reason: 'invalid' };
    }

    // Step 2c: Resolve target PTY (AC5 / S-112 multi-session extension)
    // When a sessionRegistry is available, look up/create the session for projectPath.
    // Fall back to the legacy single-session #pty when no registry is configured.
    let targetPty;
    if (this.#registry) {
      targetPty = this.#registry.getOrCreate(projectPath ?? null);
      if (!targetPty) {
        return { ok: false, reason: 'session-cap' };
      }
    } else {
      targetPty = this.#pty;
    }

    // Step 3: Concurrency lock (AC3)
    if (!this.#lock.tryAcquire()) {
      return { ok: false, reason: 'locked' };
    }

    // Step 4: Audit — must succeed before PTY write (AC6)
    // AccessGuard sets req.identity = { email } object; dev-bypass may produce
    // { email: 'dev@local' }; null-safe extraction.
    const identityStr = resolveIdentity(identity);
    try {
      this.#audit.record({ identity: identityStr, command: sanitized });
    } catch {
      // Audit failed → do NOT execute, release lock immediately (AC6 failure path)
      this.#lock.release();
      return { ok: false, reason: 'invalid' };
    }

    // Step 5: Write to PTY — exactly one line (AC1, security/R02)
    // `sanitized` has no control chars; we append exactly one \n.
    // Guard: if pty.write() throws (PTY destroyed/closed), release the lock
    // immediately so future commands are not permanently blocked.
    try {
      targetPty.write(sanitized + '\n');
    } catch {
      this.#lock.release();
      return { ok: false, reason: 'internal' };
    }

    // Step 6: Track running state + arm idle timer for completion detection
    const commandId = generateId();
    this.#currentId = commandId;
    this.#currentStatus = 'running';
    this.#currentPty = targetPty;
    this.#armIdleTimer();

    return { ok: true, commandId, status: 'running' };
  }

  /**
   * Cancel the running command: send Ctrl-C to the PTY, transition to
   * 'cancelled', and release the lock (AC5).
   *
   * @returns {{ cancelled: boolean }}
   */
  cancel() {
    if (this.#currentStatus !== 'running') {
      return { cancelled: false };
    }
    // Disarm timer before sending Ctrl-C to avoid a race where the interrupt
    // output triggers the timer path concurrently.
    this.#disarmIdleTimer();
    // Send interrupt (Ctrl-C = 0x03) to the PTY (AC5)
    // Use #currentPty (set in tryRun) so cancel targets the same session that
    // received the command, whether that is the global session or a project session.
    const ptyToCancel = this.#currentPty ?? this.#pty;
    ptyToCancel?.write('\x03');
    this.#currentStatus = 'cancelled';
    this.#lock.release();
    return { cancelled: true };
  }

  /**
   * Returns the current command status (for /api/session consumers).
   * @returns {{ commandId: string|null, status: 'running'|'done'|'cancelled'|null }}
   */
  getStatus() {
    return { commandId: this.#currentId, status: this.#currentStatus };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Arm the idle timer and attach an output listener that resets it on each
   * PTY output chunk while a command is running.
   */
  #armIdleTimer() {
    // Safety: disarm any previously lingering timer (shouldn't happen, but be safe)
    this.#disarmIdleTimer();

    // Capture the target PTY at arm-time (set in tryRun() before #armIdleTimer() is called).
    const listenPty = this.#currentPty ?? this.#pty;

    const onOutput = () => {
      if (this.#currentStatus === 'running') {
        // Reset the countdown on every output chunk
        clearTimeout(this.#idleTimer);
        this.#idleTimer = setTimeout(() => this.#onIdleExpired(onOutput, listenPty), this.#idleMs);
      }
    };
    this.#outputListener = onOutput;
    // Listen on the current session's PTY for output (AC5 multi-session)
    listenPty.on('output', onOutput);

    // Arm initial timer
    this.#idleTimer = setTimeout(() => this.#onIdleExpired(onOutput, listenPty), this.#idleMs);
  }

  /**
   * Called when the idle period elapses without any PTY output.
   * @param {Function} onOutput  the listener to detach
   * @param {import('./PtyManager.js').PtyManager} listenPty  the PTY the listener is attached to
   */
  #onIdleExpired(onOutput, listenPty) {
    listenPty.off('output', onOutput);
    this.#outputListener = null;
    this.#idleTimer = null;
    if (this.#currentStatus === 'running') {
      this.#currentStatus = 'done';
      this.#currentPty = null;
      this.#lock.release();
    }
  }

  /** Disarm the idle timer and detach the output listener. */
  #disarmIdleTimer() {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#outputListener !== null) {
      const detachPty = this.#currentPty ?? this.#pty;
      detachPty?.off('output', this.#outputListener);
      this.#outputListener = null;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a simple sequential commandId (process-scoped). */
let _idCounter = 0;
function generateId() {
  _idCounter += 1;
  return `cmd-${_idCounter}`;
}

/**
 * Resolve an identity value from AccessGuard to a string or null.
 * AccessGuard sets req.identity = { email: string|null }.
 * Dev bypass sets { email: 'dev@local' }.
 *
 * @param {unknown} identity
 * @returns {string|null}
 */
function resolveIdentity(identity) {
  if (identity === null || identity === undefined) return null;
  if (typeof identity === 'string') return identity;
  if (typeof identity === 'object' && 'email' in identity) {
    const email = identity.email;
    return typeof email === 'string' ? email : null;
  }
  return null;
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
