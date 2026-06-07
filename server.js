/**
 * dev-gui backend entrypoint.
 * Starts on port 8080 (or $PORT).
 *
 * Routes:
 *   GET  /                    → React SPA (client/dist) — public, no Access required
 *   GET  /api/status                              → { projects:[...], previews:[...] }
 *   GET  /api/session                             → { state, restarts, startedAt }
 *   GET  /api/audit                               → [{time, identity, command}]
 *   POST /api/command                             → inject slash-command into PTY session
 *   POST /api/command/cancel                      → send Ctrl-C, cancel running command
 *   GET/PUT/DELETE /api/settings/credentials*     → Credential-Verwaltung (settings-credentials)
 *   GET/PUT/DELETE /api/settings/ssh-keys*        → SSH-Key-Verwaltung (settings-ssh-keys Stufe A)
 *   POST /api/settings/ssh-keys/:user/provision   → 501 (Stufe B, folgt in #47)
 *   POST /api/github/repos                        → Org-Repo anlegen (github-repo-create #59)
 *   GET  /api/workspace/repos                     → { repos: [...] } — live WORKSPACE_DIR scan (workspace-repos AC1, AC2)
 *   POST /api/workspace/repos/delete              → { name, status: "deleted" } — delete clone (workspace-repos AC5, AC7, AC8)
 *   POST /api/github/repos/clone                  → { repo, status: "cloned", path } — lokalen Klon anlegen (github-repo-clone #61)
 *   WS   /ws/terminal                             → PtyManager bridge (guarded by AccessGuard)
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
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
import { githubReposListRouter } from './src/githubReposListRouter.js';
import { CredentialStore } from './src/CredentialStore.js';
import { credentialsRouter } from './src/credentialsRouter.js';
import { sshKeysRouter } from './src/sshKeysRouter.js';
import { githubReposRouter } from './src/githubReposRouter.js';
import { GitHubWriter } from './src/GitHubWriter.js';
import { WorkspaceScanner } from './src/WorkspaceScanner.js';
import { WorkspaceMutator } from './src/WorkspaceMutator.js';
import { workspaceReposRouter } from './src/workspaceReposRouter.js';
import { GitHubCloner } from './src/GitHubCloner.js';
import { githubRepoCloneRouter } from './src/githubRepoCloneRouter.js';

const PORT = Number(process.env.PORT ?? 8080);

// Resolve client/dist relative to this file (works from any cwd)
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = join(__dirname, 'client', 'dist');

// ── AC2: Fail-Fast — abort before binding if Access config is missing in prod ──
assertAccessConfig();

// ── Credential Store (ADR-007) — Fail-Fast wenn Store vorhanden aber Key fehlt ──
const credentialStore = new CredentialStore();
// assertCredentialConfig() is async; run it and exit on error before listen()
await credentialStore.assertCredentialConfig().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

const app = express();
app.use(express.json({ limit: '100kb' }));

// ── Static frontend (AC1 / deployment spec) ───────────────────────────────────
// Serve the built React app at /. All /api/* and /ws/terminal are handled
// below and remain behind the AccessGuard. The SPA fallback (catch-all) is
// registered AFTER all API routes so it never masks an API 404.
app.use(express.static(CLIENT_DIST));

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

// ── GitHub repos list (github-repos-overview AC1/AC2/AC6) ─────────────────────
app.use(githubReposListRouter({ githubReader }));

// ── Credentials route (settings-credentials) ─────────────────────────────────
app.use(credentialsRouter(credentialStore, auditStore));

// ── SSH-Keys route (settings-ssh-keys Stufe A) ────────────────────────────────
app.use(sshKeysRouter(credentialStore, auditStore));

// ── GitHub Repos write route (github-repo-create #59) ────────────────────────
const githubWriter = new GitHubWriter({ credentialStore });
app.use(githubReposRouter(auditStore, githubWriter));

// ── Workspace Repos route (workspace-repos AC1, AC2, AC5, AC7, AC8) ─────────
const workspaceScanner = new WorkspaceScanner();
const workspaceMutator = new WorkspaceMutator();
app.use(workspaceReposRouter(workspaceScanner, auditStore, workspaceMutator));

// ── GitHub Repo Clone route (github-repo-clone #61) ───────────────────────────
const githubCloner = new GitHubCloner({ credentialStore });
app.use(githubRepoCloneRouter(auditStore, githubCloner));

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

// ── SPA fallback: serve index.html for any non-API route ─────────────────────
// Registered after all /api/* routes so API 404s are not masked.
// /ws/terminal is handled via the upgrade event, not Express routing.
// express 5 (path-to-regexp 8): Wildcards müssen benannt sein — '*' → '/*splat'.
// '/*splat' matcht NICHT die Root '/', die liefert express.static (index.html) aus.
app.get('/*splat', (_req, res) => {
  res.sendFile(join(CLIENT_DIST, 'index.html'));
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
