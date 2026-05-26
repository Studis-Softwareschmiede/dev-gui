/**
 * dev-gui backend entrypoint.
 * Starts on port 8080 (or $PORT).
 *
 * Routes implemented here (AC1–AC4 scope):
 *   GET /api/session  → { state, restarts, startedAt }
 *   WS  /ws/terminal  → PtyManager bridge
 */

import { createServer } from 'node:http';
import express from 'express';
import { PtyManager } from './src/PtyManager.js';
import { WsGateway } from './src/WsGateway.js';

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
app.use(express.json());

// ── PtyManager ────────────────────────────────────────────────────────────
const ptyManager = new PtyManager();
ptyManager.start();

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * AC1: GET /api/session → { state, restarts, startedAt }
 */
app.get('/api/session', (_req, res) => {
  res.json({
    state: ptyManager.state,
    restarts: ptyManager.restarts,
    startedAt: ptyManager.startedAt,
  });
});

// ── HTTP + WS server ──────────────────────────────────────────────────────
const server = createServer(app);

// AC2: WebSocket gateway
new WsGateway(server, ptyManager);

server.listen(PORT, () => {
  // No secrets logged — only port
  console.log(`dev-gui listening on :${PORT}`);
});

// Graceful shutdown
function shutdown() {
  ptyManager.destroy();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
