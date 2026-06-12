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
 *   GET/PUT/DELETE /api/settings/ssh-keys*             → SSH-Key-Verwaltung (settings-ssh-keys Stufe A)
 *   POST /api/settings/ssh-keys/:user/provision        → VPS-Provisionierung (settings-ssh-keys Stufe B, #47)
 *   POST /api/settings/ssh-keys/:user/generate         → ed25519-Keypair erzeugen (ssh-key-generation AC1–AC7, #115)
 *   GET  /api/settings/ssh-keys/:user/private-key/export → Private-Key-Export (ssh-key-generation AC4, #115)
 *   POST /api/settings/ssh-keys/:user/rotate           → vollautomatische additive SSH-Key-Rotation (ssh-key-rotation AC1–AC8, #118)
 *   GET/PUT/DELETE /api/settings/workspace-path   → Workspace-Pfad-Konfiguration (workspace-path-config #85)
 *   POST /api/github/repos                        → Org-Repo anlegen (github-repo-create #59)
 *   GET  /api/workspace/repos                     → { repos: [...] } — live WORKSPACE_DIR scan (workspace-repos AC1, AC2)
 *   POST /api/workspace/repos/pull                → { name, status: "pulled" } — pull clone (workspace-repos AC3, AC4, AC7, AC8)
 *   POST /api/workspace/repos/delete              → { name, status: "deleted" } — delete clone (workspace-repos AC5, AC7, AC8)
 *   POST /api/github/repos/clone                  → { repo, status: "cloned", path } — lokalen Klon anlegen (github-repo-clone #61)
 *   GET  /api/vps/providers                       → [{ id, configured, capabilities }] (vps-provider-boundary AC2)
 *   GET  /api/vps/machines                        → { machines, providerErrors? } (vps-provider-boundary AC3/AC4)
 *   POST /api/vps/machines/:provider              → { result, machine? } — Create-from-scratch (vps-provider-boundary AC7/AC8)
 *   POST /api/vps/machines/:provider/:serverId/start → { result, reason? } (vps-provider-boundary AC5/AC6)
 *   POST /api/vps/machines/:provider/:serverId/stop  → { result, reason? } (vps-provider-boundary AC5/AC6)
 *   GET    /api/cloudflare/zones                                → { configured, zones:[...], errors? } (view-cloudflare AC4)
 *   GET    /api/cloudflare/zones/:zoneId/tunnels               → { tunnels:[...], routes:[...], errors? } (view-cloudflare AC4)
 *   DELETE /api/cloudflare/tunnels/:tunnelId/routes/:hostname  → { result, reason? } (view-cloudflare AC5/AC6/AC9)
 *   DELETE /api/cloudflare/tunnels/:tunnelId                   → { result, reason? } (view-cloudflare AC5/AC6/AC9)
 *   GET    /api/deployments                                    → { deployments:[...], errors? } (deploy-lifecycle AC3)
 *   POST   /api/deployments                                    → { result, deployment?, reason? } (deploy-lifecycle AC3/AC4)
 *   DELETE /api/deployments/:vps/:hostname                     → { result, reason? } (deploy-lifecycle AC5/AC6)
 *   POST   /api/deployments/reconcile                          → { result, report? } (cloudflare-reconciliation AC2)
 *   GET    /api/deployments/reconcile/last                     → ReconcileReport|{} (cloudflare-reconciliation AC8)
 *   GET    /api/deployments/reconcile/reports?limit=N          → ReconcileReport[] (cloudflare-reconciliation AC8)
 *   GET    /api/deployments/reconcile/notices?limit=N          → ReconcileNotice[] (cloudflare-reconciliation AC8b)
 *   GET    /api/deployments/stacks                            → { stacks: StackDefinition[] } (stack-deploy-orchestration AC1)
 *   GET    /api/deployments/stacks/:stackName                 → StackDefinition | 404 (stack-deploy-orchestration AC1)
 *   POST   /api/deployments/stacks                            → { stackName, updatedAt } (stack-deploy-orchestration AC1/AC2)
 *   PUT    /api/deployments/stacks/:stackName                 → { stackName, updatedAt } (stack-deploy-orchestration AC1/AC2)
 *   DELETE /api/deployments/stacks/:stackName                 → { stackName, status } (stack-deploy-orchestration AC1/AC2)
 *   GET    /api/version                                        → { version } — image build timestamp (build-version)
 *   GET    /api/team                                           → { agents:[...], skills:[...], knowledge:[...] } (team-view-backend AC1)
 *   GET    /api/team/:kind/:id                                 → { ...meta, body } (team-view-backend AC4)
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
import { workspacePathRouter } from './src/workspacePathRouter.js';
import { buildWorkspaceRootResolver } from './src/workspacePath.js';
import { VpsProviderRegistry } from './src/vps/VpsProviderRegistry.js';
import { vpsRouter } from './src/vpsRouter.js';
import { CloudflareApi } from './src/cloudflare/CloudflareApi.js';
import { LockoutGuard } from './src/cloudflare/LockoutGuard.js';
import { cloudflareRouter } from './src/cloudflareRouter.js';
import { VpsDockerControl } from './src/deploy/VpsDockerControl.js';
import { DeployOrchestrator } from './src/deploy/DeployOrchestrator.js';
import { ReconciliationJob } from './src/deploy/ReconciliationJob.js';
import { deploymentsRouter } from './src/deploymentsRouter.js';
import { versionRouter } from './src/versionRouter.js';
import { AgentFlowReader } from './src/AgentFlowReader.js';
import { teamRouter } from './src/teamRouter.js';
import { StackRegistry } from './src/StackRegistry.js';
import { stacksRouter } from './src/stacksRouter.js';

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

// ── Workspace-Pfad-Konfiguration (workspace-path-config AC2–AC9) ──────────────
app.use(workspacePathRouter(credentialStore, auditStore));

// ── Workspace-Root-Resolver (gemeinsame Quelle der Wahrheit — AC5, AC9) ───────
// Pro Operation aufgelöst (nicht beim Boot eingefroren).
const resolveWorkspaceRoot = buildWorkspaceRootResolver(credentialStore);

// ── Workspace Repos route (workspace-repos AC1, AC2, AC3, AC4, AC5, AC7, AC8) ──
const workspaceScanner = new WorkspaceScanner({ workspaceRootResolver: resolveWorkspaceRoot });
const workspaceMutator = new WorkspaceMutator({ workspaceRootResolver: resolveWorkspaceRoot });
app.use(workspaceReposRouter(workspaceScanner, auditStore, workspaceMutator, credentialStore));

// ── GitHub Repo Clone route (github-repo-clone #61) ───────────────────────────
const githubCloner = new GitHubCloner({ credentialStore, workspaceRootResolver: resolveWorkspaceRoot });
app.use(githubRepoCloneRouter(auditStore, githubCloner));

// ── VPS Provider Boundary (vps-provider-boundary #95) ─────────────────────────
const vpsRegistry = new VpsProviderRegistry({ credentialStore });
app.use(vpsRouter(vpsRegistry, auditStore));

// ── Cloudflare API Boundary (view-cloudflare #107/#108, ADR-010/011) ─────────
const cloudflareApi = new CloudflareApi({ credentialStore });
app.use(cloudflareRouter(cloudflareApi, auditStore));

// ── Deploy Boundary (deploy-lifecycle #110, ADR-012) ─────────────────────────
const lockoutGuard = new LockoutGuard();
const vpsDockerControl = new VpsDockerControl(credentialStore);
const deployOrchestrator = new DeployOrchestrator({
  dockerControl: vpsDockerControl,
  cloudflareApi,
  lockoutGuard,
});
// VPS-Target-Map: configured VPS targets from environment (comma-separated).
// Format: VPS_TARGETS="id1=host:user,id2=host:user" or empty (start with empty map).
// The map keys are the vpsId strings sent by the frontend.
const vpsTargets = buildVpsTargetsFromEnv(process.env.VPS_TARGETS);

// ── ReconciliationJob (Capability C, ADR-013) ─────────────────────────────
// Midnight UTC scheduler (node-internal, no external cron; AC1).
// VPS configs: combine vpsTargets map with RECONCILE_TUNNEL_ID from env.
// Format: RECONCILE_TUNNEL_IDS="vps-id1=tunnelId1,vps-id2=tunnelId2"
const reconcileVpsConfigs = buildReconcileVpsConfigs(vpsTargets, process.env.RECONCILE_TUNNEL_IDS);
const reconciliationJob = new ReconciliationJob({
  dockerControl: vpsDockerControl,
  cloudflareApi,
  lockoutGuard,
  orchestrator: deployOrchestrator,
  auditStore,
  vpsConfigs: reconcileVpsConfigs,
});
// Start the midnight scheduler in the always-on process (ADR-002, AC1)
reconciliationJob.startScheduler();

app.use(deploymentsRouter(deployOrchestrator, auditStore, vpsTargets, reconciliationJob));

// ── Stack-Registry (stack-deploy-orchestration #160, AC1/AC2) ─────────────────
const stackRegistry = new StackRegistry(credentialStore);
app.use(stacksRouter(stackRegistry, auditStore));

// ── Build-Version endpoint (build-version) ────────────────────────────────────
app.use(versionRouter());

// ── Team-Ansicht (team-view-backend AC1, AC4, AC9) ────────────────────────────
const agentFlowReader = new AgentFlowReader();
app.use(teamRouter({ agentFlowReader }));

/**
 * Build the VPS-Target map from an environment variable.
 *
 * Format: "id1=user@host:22,id2=user@host" (comma-separated; port is optional, defaults to 22)
 * Example: "vps-1=root@1.2.3.4:22,vps-2=root@5.6.7.8"
 *
 * Returns an empty Map if the env var is unset or empty (all deploy calls will 422).
 * Secrets (SSH private keys) are stored in the CredentialStore, NOT here.
 *
 * @param {string|undefined} envValue
 * @returns {Map<string, { host: string, port: number, targetUser: string }>}
 */
function buildVpsTargetsFromEnv(envValue) {
  const map = new Map();
  if (!envValue || !envValue.trim()) return map;

  for (const entry of envValue.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const id = trimmed.slice(0, eqIdx).trim();
    const target = trimmed.slice(eqIdx + 1).trim();
    // target format: user@host or user@host:port
    const atIdx = target.indexOf('@');
    if (atIdx < 1) continue;
    const targetUser = target.slice(0, atIdx);
    const hostPort = target.slice(atIdx + 1);
    const colonIdx = hostPort.lastIndexOf(':');
    let host, port;
    if (colonIdx > 0) {
      host = hostPort.slice(0, colonIdx);
      const p = parseInt(hostPort.slice(colonIdx + 1), 10);
      port = Number.isFinite(p) ? p : 22;
    } else {
      host = hostPort;
      port = 22;
    }
    if (id && host && targetUser) {
      map.set(id, { host, port, targetUser });
    }
  }
  return map;
}

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

/**
 * Build the ReconciliationJob VPS config list from the existing vpsTargets map
 * and the RECONCILE_TUNNEL_IDS environment variable.
 *
 * Format: "vps-id1=tunnelId1,vps-id2=tunnelId2"
 * Only VPS IDs that appear in BOTH vpsTargets AND RECONCILE_TUNNEL_IDS are included.
 * Returns empty array if RECONCILE_TUNNEL_IDS is unset (reconcile skips all VPS).
 *
 * @param {Map<string, object>} targets
 * @param {string|undefined} envValue
 * @returns {Array<{ vpsId: string, vps: object, tunnelId: string }>}
 */
function buildReconcileVpsConfigs(targets, envValue) {
  if (!envValue || !envValue.trim()) return [];
  const configs = [];
  for (const entry of envValue.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const vpsId = trimmed.slice(0, eqIdx).trim();
    const tunnelId = trimmed.slice(eqIdx + 1).trim();
    if (!vpsId || !tunnelId) continue;
    const vps = targets.get(vpsId);
    if (vps) {
      configs.push({ vpsId, vps, tunnelId });
    }
  }
  return configs;
}

// Graceful shutdown
function shutdown() {
  reconciliationJob.stopScheduler();
  ptyManager.destroy();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
