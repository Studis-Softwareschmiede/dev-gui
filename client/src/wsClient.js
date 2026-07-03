/**
 * wsClient.js — WS connection module for /ws/terminal
 *
 * Pure, testable class (no xterm, no React, no DOM beyond WebSocket).
 * Responsibilities:
 *   - Connect / reconnect with exponential backoff
 *   - Expose connection status ('connecting' | 'connected' | 'disconnected')
 *   - Dispatch incoming server messages to registered listeners
 *   - Send input messages: { type: "input", data: string }
 *   - Send resize messages: { type: "resize", cols: int>0, rows: int>0 } (AC5)
 *
 * Server message protocol (consumed):
 *   { type: "output", data: string }
 *   { type: "state",  state: string }
 *   { type: "error",  errorClass: string, reason: string }  (vps-ssh-terminal AC4/AC9)
 *
 * Optional `openPayload` (vps-ssh-terminal AC2/AC5): if provided, sent as the
 * FIRST message on the socket as soon as it reaches OPEN — before any other
 * traffic (e.g. the resize event Terminal.jsx sends on 'connected' status).
 * `/ws/terminal` (Claude-Terminal) never passes this — behavior unchanged there.
 *
 * Security: no secrets baked in; WS URL derived from window.location (or
 * injected via constructor for testing). Input data is stringified — no
 * eval, no raw exec (security/R02, security/R03).
 */

export const WS_STATUS = /** @type {const} */ ({
  CONNECTING:    'connecting',
  CONNECTED:     'connected',
  DISCONNECTED:  'disconnected',
});

/** Backoff config (ms) */
const BACKOFF_BASE  = 500;
const BACKOFF_MAX   = 16_000;
const BACKOFF_JITTER = 200;

/**
 * TerminalConnection manages a single /ws/terminal WebSocket with
 * automatic reconnect + exponential backoff.
 *
 * @example
 *   const conn = new TerminalConnection('/ws/terminal');
 *   conn.onStatus(s => console.log('status:', s));
 *   conn.onMessage(msg => { if (msg.type === 'output') term.write(msg.data); });
 *   conn.connect();
 */
export class TerminalConnection {
  /** @type {WebSocket|null} */
  #ws = null;
  #url;
  #status = WS_STATUS.DISCONNECTED;
  #retryCount = 0;
  #retryTimer = null;
  #destroyed = false;

  /** @type {Set<(status: string) => void>} */
  #statusListeners = new Set();
  /** @type {Set<(msg: object) => void>} */
  #messageListeners = new Set();

  /** @type {object|null} sent verbatim (JSON-stringified) as the first message on open. */
  #openPayload;

  /**
   * @param {string} url  WS URL, e.g. 'ws://localhost:8080/ws/terminal'
   *                      or relative path '/ws/terminal' (will be resolved).
   * @param {{ WebSocket?: typeof WebSocket, openPayload?: object }} [opts]
   *   `WebSocket` — injection point for tests.
   *   `openPayload` (vps-ssh-terminal AC2/AC5) — optional handshake object sent as the
   *   first message once the socket opens (e.g. `{type:"open",provider,serverId,user}`).
   */
  constructor(url, opts = {}) {
    this.#url = url;
    // Allow injecting a fake WebSocket class for unit tests
    this._WS = opts.WebSocket ?? globalThis.WebSocket;
    this.#openPayload = opts.openPayload ?? null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** @returns {'connecting'|'connected'|'disconnected'} */
  get status() { return this.#status; }

  /** Register a listener for status changes. Returns unsubscribe fn. */
  onStatus(fn) {
    this.#statusListeners.add(fn);
    return () => this.#statusListeners.delete(fn);
  }

  /** Register a listener for parsed server messages. Returns unsubscribe fn. */
  onMessage(fn) {
    this.#messageListeners.add(fn);
    return () => this.#messageListeners.delete(fn);
  }

  /** Open the connection (or schedule reconnect if already connecting). */
  connect() {
    if (this.#destroyed) return;
    if (this.#ws && this.#ws.readyState === this._WS.OPEN) return;

    this.#clearRetryTimer();
    this.#openSocket();
  }

  /**
   * Send input to the server.
   * @param {string} data
   */
  send(data) {
    if (
      this.#ws === null ||
      this.#ws.readyState !== this._WS.OPEN ||
      typeof data !== 'string'
    ) return;
    this.#ws.send(JSON.stringify({ type: 'input', data }));
  }

  /**
   * Send a resize event to the server (AC5).
   * Only sent when the connection is open; cols/rows must be positive integers.
   * @param {number} cols
   * @param {number} rows
   */
  sendResize(cols, rows) {
    if (
      this.#ws === null ||
      this.#ws.readyState !== this._WS.OPEN
    ) return;
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) return;
    this.#ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  /** Permanently close this connection (no more reconnects). */
  destroy() {
    this.#destroyed = true;
    this.#clearRetryTimer();
    if (this.#ws) {
      // Remove listeners before close to avoid triggering reconnect
      this.#ws.onclose = null;
      this.#ws.onerror = null;
      this.#ws.close();
      this.#ws = null;
    }
    this.#setStatus(WS_STATUS.DISCONNECTED);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  #openSocket() {
    this.#setStatus(WS_STATUS.CONNECTING);
    let ws;
    try {
      ws = new this._WS(this.#url);
    } catch {
      // URL invalid or WebSocket unavailable — schedule retry
      this.#scheduleRetry();
      return;
    }
    this.#ws = ws;

    ws.onopen = () => {
      this.#retryCount = 0;
      // AC2/AC5 (vps-ssh-terminal): the open-handshake MUST be the very first message on
      // the wire — sent before the status flips to CONNECTED (which triggers Terminal.jsx's
      // own onStatus → sendResize call).
      if (this.#openPayload) {
        ws.send(JSON.stringify(this.#openPayload));
      }
      this.#setStatus(WS_STATUS.CONNECTED);
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        // Malformed JSON — ignore
        return;
      }
      if (msg === null || typeof msg !== 'object') return;
      for (const fn of this.#messageListeners) fn(msg);
    };

    ws.onerror = () => {
      // onerror always precedes onclose; let onclose handle reconnect
    };

    ws.onclose = () => {
      if (this.#destroyed) return;
      this.#ws = null;
      this.#setStatus(WS_STATUS.DISCONNECTED);
      this.#scheduleRetry();
    };
  }

  #setStatus(s) {
    if (this.#status === s) return;
    this.#status = s;
    for (const fn of this.#statusListeners) fn(s);
  }

  #scheduleRetry() {
    if (this.#destroyed) return;
    this.#setStatus(WS_STATUS.DISCONNECTED);
    const delay = Math.min(
      BACKOFF_BASE * 2 ** this.#retryCount + Math.random() * BACKOFF_JITTER,
      BACKOFF_MAX
    );
    this.#retryCount++;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (!this.#destroyed) {
        this.#setStatus(WS_STATUS.CONNECTING);
        this.#openSocket();
      }
    }, delay);
  }

  #clearRetryTimer() {
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Returns true iff v is a finite positive integer (AC5 client-side guard).
 * @param {unknown} v
 * @returns {boolean}
 */
function isPositiveInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}
