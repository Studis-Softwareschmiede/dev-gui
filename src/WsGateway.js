/**
 * WsGateway — WebSocket /ws/terminal bridge.
 *
 * Accepts a pre-created WebSocketServer (noServer mode) so that the HTTP
 * upgrade interceptor in server.js can apply AccessGuard before the handshake
 * is handed off to the WS server.
 *
 * Client → Server: { type: "input",  data: string }
 *                  { type: "resize", cols: int>0, rows: int>0 }
 * Server → Client: { type: "output", data: string }
 *                  { type: "state",  state: SessionState }
 *
 * On new connection: scrollback replay is sent as { type: "output" } before
 * live streaming begins (AC6).
 *
 * Multi-session routing (AC4 / S-111):
 *   When a PtySessionRegistry is passed instead of a PtyManager, the gateway
 *   resolves the correct session per connection via the `?project=<encoded-path>`
 *   query parameter on the WebSocket upgrade URL.  When no project param is
 *   present (or an empty value), the global/default session is used (backward
 *   compat).
 *
 *   If getOrCreate() returns null (session cap reached), the connection is
 *   immediately closed with a 1013 (Try Again Later) status code.
 *
 * Security: input data validated (string only); resize dims validated (positive
 * int delegated to PtyManager.resize); no secret logged; project path is NOT
 * logged (only used as a session key).
 */

import { WebSocket } from 'ws';
import { SESSION_STATES } from './PtyManager.js';
import { validateProjectPath, ProjectPathError, resolveProjectSlug } from './workspacePath.js';

export class WsGateway {
  /** @type {import('ws').WebSocketServer} */
  #wss;
  /**
   * Either a single PtyManager (legacy) or a PtySessionRegistry (multi-session).
   * @type {import('./PtyManager.js').PtyManager | import('./PtySessionRegistry.js').PtySessionRegistry}
   */
  #backend;
  /** @type {boolean} whether #backend is a PtySessionRegistry */
  #isRegistry;
  /**
   * Workspace-path validator used before getOrCreate() in multi-session mode.
   * Injectable for tests (avoids real filesystem calls).
   * @type {(path: string) => Promise<{ resolvedPath: string }>}
   */
  #pathValidator;
  /**
   * Slug-to-path resolver used to translate a client slug to an absolute path
   * before boundary validation.  Injectable for tests.
   * @type {(slug: string|null, deps?: object) => string|null}
   */
  #slugResolver;

  /**
   * @param {import('ws').WebSocketServer} wss   Pre-created WebSocketServer instance
   * @param {import('./PtyManager.js').PtyManager | import('./PtySessionRegistry.js').PtySessionRegistry} backend
   *   Either a PtyManager (single-session, backward compat) or a PtySessionRegistry
   *   (multi-session, AC4).
   * @param {object} [options]
   * @param {(path: string) => Promise<{ resolvedPath: string }>} [options.pathValidator]
   *   Injectable path validator for multi-session mode (default: validateProjectPath).
   *   Inject a stub in tests to avoid real filesystem calls.
   * @param {(slug: string|null, deps?: object) => string|null} [options.slugResolver]
   *   Injectable slug-to-path resolver (default: resolveProjectSlug).
   *   Translates a client-supplied slug to WORKSPACE_DIR/slug before boundary validation.
   */
  constructor(wss, backend, options = {}) {
    this.#backend = backend;
    this.#wss = wss;
    this.#pathValidator = options.pathValidator ?? validateProjectPath;
    this.#slugResolver = options.slugResolver ?? resolveProjectSlug;
    // Detect registry by duck-typing: registries expose getOrCreate()
    this.#isRegistry = typeof backend.getOrCreate === 'function';

    // Server-level error handler — prevents unhandled 'error' from crashing the process.
    // Log only code/name; never stream content (js/R02).
    this.#wss.on('error', (err) => {
      console.error('[WsGateway] server error:', err.code ?? err.name);
    });

    if (this.#isRegistry) {
      // Multi-session: each connection gets its own session; no process-level broadcast.
      this.#wss.on('connection', (ws, req) => this.#onConnectionMulti(ws, req));
    } else {
      // Single-session (legacy): broadcast PTY output to all connected clients.
      const pty = /** @type {import('./PtyManager.js').PtyManager} */ (backend);
      this.#wss.on('connection', (ws) => this.#onConnectionSingle(ws, pty));

      pty.on('output', (data) => {
        this.#broadcast({ type: 'output', data });
      });
      pty.on('state', (state) => {
        this.#broadcast({ type: 'state', state });
      });
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Handle a new connection in single-session (legacy) mode.
   * @param {import('ws').WebSocket} ws
   * @param {import('./PtyManager.js').PtyManager} pty
   */
  #onConnectionSingle(ws, pty) {
    ws.on('error', (err) => {
      console.error('[WsGateway] socket error:', err.code ?? err.name);
    });

    // AC6: replay buffered scrollback to the newly connected client.
    const buffered = pty.scrollback;
    if (buffered.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: buffered }));
    }

    ws.send(JSON.stringify({ type: 'state', state: pty.state }));

    ws.on('message', (raw) => this.#handleMessage(raw, ws, pty));
  }

  /**
   * Handle a new connection in multi-session mode (AC4).
   * Resolves the project session from the ?project query param.
   * @param {import('ws').WebSocket} ws
   * @param {import('http').IncomingMessage} req
   */
  async #onConnectionMulti(ws, req) {
    const registry = /** @type {import('./PtySessionRegistry.js').PtySessionRegistry} */ (this.#backend);

    // Register error handler immediately — must be first so it catches errors
    // even if we close early (e.g. cap or boundary rejection path).
    ws.on('error', (err) => {
      console.error('[WsGateway] socket error:', err.code ?? err.name);
    });

    // Extract project slug from query string (?project=<slug>) and resolve to absolute path.
    // V8b: client sends a slug (repo name), not an absolute path.  resolveProjectSlug()
    // prepends WORKSPACE_DIR before validateProjectPath() runs the boundary check.
    const rawSlug = extractProjectParam(req.url);

    // Resolve slug → absolute path (null for global session).
    let projectPath;
    if (rawSlug !== null) {
      try {
        projectPath = this.#slugResolver(rawSlug);
      } catch (err) {
        // Slug form is invalid (e.g. contains '/', is '..' etc.) — reject with 1008.
        ws.close(1008, err instanceof ProjectPathError ? err.message : 'Invalid project slug');
        return;
      }
    } else {
      projectPath = null;
    }

    // Workspace-boundary validation (security/R02/R03 — Path-Traversal via spawn-cwd).
    // Only validate when a non-null projectPath is supplied (null → global session, no cwd set).
    if (projectPath !== null) {
      try {
        await this.#pathValidator(projectPath);
      } catch (err) {
        // Reject with 1008 (Policy Violation) for out-of-boundary or missing paths.
        ws.close(1008, err instanceof ProjectPathError ? err.message : 'Invalid project path');
        return;
      }
    }

    // Resolve session — creates if needed, or returns global for empty path
    const pty = registry.getOrCreate(projectPath);

    if (!pty) {
      // Session cap reached — reject with 1013 (Try Again Later)
      ws.close(1013, 'Session cap reached');
      return;
    }

    // Replay scrollback for this session
    const buffered = pty.scrollback;
    if (buffered.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: buffered }));
    }

    ws.send(JSON.stringify({ type: 'state', state: pty.state }));

    // Attach per-connection listeners that forward this session's output to this socket only
    const onOutput = (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    };
    const onState = (state) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'state', state }));
      }
    };

    pty.on('output', onOutput);
    pty.on('state', onState);

    // Clean up listeners when the socket closes
    ws.on('close', () => {
      pty.off('output', onOutput);
      pty.off('state', onState);
    });

    ws.on('message', (raw) => this.#handleMessage(raw, ws, pty));
  }

  /**
   * Handle an incoming message from a client, writing to the given pty.
   * Shared by single- and multi-session paths.
   * @param {Buffer|string} raw
   * @param {import('ws').WebSocket} ws
   * @param {import('./PtyManager.js').PtyManager} pty
   */
  #handleMessage(raw, ws, pty) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // Malformed JSON — ignore (security/R02)
      return;
    }

    if (msg === null || typeof msg !== 'object') return;

    // AC5: handle resize messages
    if (msg.type === 'resize') {
      // Validation delegated to PtyManager.resize (ignores invalid values — no crash)
      pty.resize(msg.cols, msg.rows);
      return;
    }

    // Validate: only accept input messages with string data (security/R02)
    if (msg.type !== 'input' || typeof msg.data !== 'string') {
      return;
    }

    // Edge-case (spec): not ready → drop input rather than crash
    if (
      pty.state === SESSION_STATES.FAILED ||
      pty.state === SESSION_STATES.STOPPED
    ) {
      ws.send(JSON.stringify({ type: 'state', state: pty.state }));
      return;
    }

    pty.write(msg.data);
  }

  /**
   * Broadcast a message object to all connected clients.
   * Used only in single-session mode.
   * @param {object} msg
   */
  #broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const client of this.#wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extract and decode the `?project=` query parameter from a WebSocket upgrade URL.
 * Returns null when the param is absent or empty.
 *
 * Security: the value is NOT used in any filesystem operation here; it is only
 * used as a key for session lookup in PtySessionRegistry. Filesystem-level path
 * validation is the caller's responsibility (WorkspaceScanner / realpath).
 *
 * @param {string|undefined|null} url  e.g. "/ws/terminal?project=%2Fhome%2Fuser%2Frepo"
 * @returns {string|null}
 */
export function extractProjectParam(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    // Use URL constructor with a dummy base to parse relative URLs
    const parsed = new URL(url, 'ws://localhost');
    const val = parsed.searchParams.get('project');
    return val && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}
