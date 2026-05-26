/**
 * dev-gui backend entrypoint.
 * Starts on port 8080 (or $PORT).
 *
 * Routes:
 *   GET  /api/status          → { projects:[{name,openItems,lastCi}], previews:[{name,url,status}] }
 *   GET  /api/session         → { state, restarts, startedAt }
 *   GET  /api/audit           → [{time, identity, command}]
 *   POST /api/command         → inject slash-command into PTY session
 *   POST /api/command/cancel  → send Ctrl-C, cancel running command
 *   WS   /ws/terminal         → PtyManager bridge (guarded by AccessGuard)
 */

import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PtyManager } from './src/PtyManager.js';
import { WsGateway } from './src/WsGateway.js';
import { assertAccessConfig, createAccessGuard, createWsAccessGuard } from './src/AccessGuard.js';
import { AuditStore, auditRouter } from './src/AuditStore.js';
import { CommandService } from './src/CommandService.js';
import { commandRouter } from './src/commandRouter.js';
import { GitHubReader } from './src/GitHubReader.js';
import { DockerReader } from './src/DockerReader.js';
import { statusRouter } from './src/statusRouter.js';

const PORT = Number(process.env.PORT ?? 8080);

// ── AC2: Fail-Fast — abort before binding if Access config is missing in prod ──
assertAccessConfig();

const app = express();
app.use(express.json());

// ── AC1: Apply AccessGuard to every /api/* route ──────────────────────────────
const accessGuard = createAccessGuard();
app.use('/api', accessGuard);

// ── AC3: Audit store + endpoint ───────────────────────────────────────────────
export const auditStore = new AuditStore();
app.use(auditRouter(auditStore));

// ── PtyManager ────────────────────────────────────────────────────────────────
const ptyManager = new PtyManager();
ptyManager.start();

// ── CommandService + Routes ───────────────────────────────────────────────────
const commandService = new CommandService({ ptyManager, auditStore });
app.use(commandRouter(commandService));

// ── Status route (AC1/AC2/AC4) ────────────────────────────────────────────────
const githubReader = new GitHubReader();
const dockerReader = new DockerReader();
app.use(statusRouter({ githubReader, dockerReader }));

/**
 * GET /api/session → { state, restarts, startedAt }
 */
app.get('/api/session', (_req, res) => {
  res.json({
    state: ptyManager.state,
    restarts: ptyManager.restarts,
    startedAt: ptyManager.startedAt,
  });
});

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = createServer(app);

// ── AC1: WS upgrade interceptor (guards /ws/terminal before handshake) ────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
new WsGateway(wss, ptyManager);

const wsGuard = createWsAccessGuard(wss);

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/terminal') {
    wsGuard(req, socket, head);
  } else {
    socket.destroy();
  }
});

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
