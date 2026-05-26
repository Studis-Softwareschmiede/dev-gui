/**
 * WsGateway — WebSocket /ws/terminal bridge (AC2).
 *
 * Client → Server: { type: "input", data: string }
 * Server → Client: { type: "output", data: string }
 *                  { type: "state",  state: SessionState }
 *
 * Security: input data validated (string only); no secret logged.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { SESSION_STATES } from './PtyManager.js';

export class WsGateway {
  /** @type {import('ws').WebSocketServer} */
  #wss;
  /** @type {import('./PtyManager.js').PtyManager} */
  #pty;

  /**
   * @param {import('http').Server} httpServer
   * @param {import('./PtyManager.js').PtyManager} ptyManager
   */
  constructor(httpServer, ptyManager) {
    this.#pty = ptyManager;

    this.#wss = new WebSocketServer({
      server: httpServer,
      path: '/ws/terminal',
      // DoS hygiene: reject messages larger than 64 KiB (js/R02 suggestion).
      // claude terminal input is keystroke-sized; 64 KiB is already generous.
      maxPayload: 64 * 1024,
    });

    // Server-level error handler — prevents unhandled 'error' from crashing the process.
    // Log only code/name; never stream content (js/R02).
    this.#wss.on('error', (err) => {
      console.error('[WsGateway] server error:', err.code ?? err.name);
    });

    this.#wss.on('connection', (ws) => this.#onConnection(ws));

    // Broadcast PTY output to all connected clients (AC2)
    ptyManager.on('output', (data) => {
      this.#broadcast({ type: 'output', data });
    });

    // Broadcast state changes (AC2)
    ptyManager.on('state', (state) => {
      this.#broadcast({ type: 'state', state });
    });
  }

  // ── Private ────────────────────────────────────────────────────────────

  #onConnection(ws) {
    // Per-socket error handler: log minimally, never log stream content (js/R02).
    ws.on('error', (err) => {
      // Use err.code (e.g. ECONNRESET) not err.message — avoids any chance of
      // leaking stream content through error text.
      console.error('[WsGateway] socket error:', err.code ?? err.name);
    });

    // Send current state immediately on connect
    ws.send(JSON.stringify({ type: 'state', state: this.#pty.state }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        // Malformed JSON — ignore (security/R02)
        return;
      }

      // Validate: only accept input messages with string data (security/R02)
      if (
        msg === null ||
        typeof msg !== 'object' ||
        msg.type !== 'input' ||
        typeof msg.data !== 'string'
      ) {
        return;
      }

      // Edge-case (spec): not ready → drop input rather than crash (AC2 + spec edge-cases)
      if (
        this.#pty.state === SESSION_STATES.FAILED ||
        this.#pty.state === SESSION_STATES.STOPPED
      ) {
        ws.send(JSON.stringify({ type: 'state', state: this.#pty.state }));
        return;
      }

      this.#pty.write(msg.data);
    });
  }

  /**
   * Broadcast a message object to all connected clients.
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
