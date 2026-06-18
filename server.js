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
 *   GET  /api/settings/credential-status          → { state, hasEncryptedEntries } (credential-bootstrap-status #184)
 *   POST /api/settings/credential-unlock          → { ok, state? } (credential-unlock-dialog #185)
 *   GET/PUT/DELETE /api/settings/ssh-keys*             → SSH-Key-Verwaltung (settings-ssh-keys Stufe A)
 *   POST /api/settings/ssh-keys/:user/provision        → VPS-Provisionierung (settings-ssh-keys Stufe B, #47)
 *   POST /api/settings/ssh-keys/:user/generate         → ed25519-Keypair erzeugen (ssh-key-generation AC1–AC7, #115)
 *   GET  /api/settings/ssh-keys/:user/private-key/export → Private-Key-Export (ssh-key-generation AC4, #115)
 *   POST /api/settings/ssh-keys/:user/rotate           → vollautomatische additive SSH-Key-Rotation (ssh-key-rotation AC1–AC8, #118)
 *   GET/PUT/DELETE /api/settings/workspace-path   → Workspace-Pfad-Konfiguration (workspace-path-config #85)
 *   GET  /api/settings/workspace-health           → { overall, checks, counts } (workspace-health-hinweis AC2)
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
 *   DELETE /api/deployments/stacks/:stackName                 → { stackName, status } (stack-deploy-orchestration AC1/AC2, Registry-only)
 *   POST   /api/deployments/stacks/:stackName/deploy          → { result, stack? } (stack-deploy-orchestration AC6/AC7/AC10/AC11)
 *   DELETE /api/deployments/stacks/:stackName/undeploy        → { result, reason? } (stack-deploy-orchestration AC8/AC10/AC11)
 *   GET    /api/deployments/stacks/:stackName/status          → StackStatus (stack-deploy-orchestration AC9)
 *   POST   /api/settings/backup-restore                        → { ok: true, manifest? } — Restore aus Backup-Artefakt (S-142 AC13–AC16)
 *   GET    /api/version                                        → { version } — image build timestamp (build-version)
 *   GET    /api/team                                           → { agents:[...], skills:[...], knowledge:[...] } (team-view-backend AC1)
 *   GET    /api/team/:kind/:id                                 → { ...meta, body } (team-view-backend AC4)
 *   GET    /api/retro/runs                                     → { runs:[...] } (retro-view-backend AC1)
 *   GET    /api/retro/runs/:slug                               → { slug, date, source, statusMix, agents:[…], skills:[…], knowledge:[…] } (retro-view-backend AC5)
 *   GET    /api/retro/cards                                    → { cards: { [status]: Card[] } } (retro-train-board-local AC2)
 *   GET    /api/retro/trend?category=<knowledge|agents|skills> → { category, lanes:[…], runs:[…], empty?, placeholder? } (retro-trend-backend AC1)
 *   GET    /api/board/projects                                → { projects:[…] } (dev-gui-board-aggregator AC1-3,AC7-9)
 *   POST   /api/board/projects/rescan                         → { ok: true } (dev-gui-board-aggregator AC9)
 *   GET    /api/board/projects/:slug/docs                         → { docs:[…] } (projekt-spezifikation-anzeige AC1,AC2)
 *   GET    /api/board/projects/:slug/docs/raw?path=<relpfad>      → Roh-Markdown (projekt-spezifikation-anzeige AC2,AC3)
 *   GET    /api/board/projects/:slug/stories/:id/detail            → { detail: StoryDetail } (story-detail-ansicht AC2)
 *   POST   /api/assist/refine                                      → { refinedText, openQuestions[], notes? } (fabric-intake-dialog AC5,AC7,AC10)
 *   WS   /ws/terminal                             → PtyManager bridge (guarded by AccessGuard)
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PtySessionRegistry } from './src/PtySessionRegistry.js';
import { WsGateway } from './src/WsGateway.js';
import { assertAccessConfig, createAccessGuard, createWsAccessGuard } from './src/AccessGuard.js';
import { AuditStore } from './src/AuditStore.js';
import { CommandService } from './src/CommandService.js';
import { GitHubReader } from './src/GitHubReader.js';
import { GitHubAppTokenProvider } from './src/GitHubAppTokenProvider.js';
import { GitHubPackagesReader } from './src/GitHubPackagesReader.js';
import { DockerReader } from './src/DockerReader.js';
import { CredentialStore } from './src/CredentialStore.js';
import { GitHubWriter } from './src/GitHubWriter.js';
import { WorkspaceScanner } from './src/WorkspaceScanner.js';
import { WorkspaceMutator } from './src/WorkspaceMutator.js';
import { GitHubCloner } from './src/GitHubCloner.js';
import { buildWorkspaceRootResolver } from './src/workspacePath.js';
import { VpsProviderRegistry } from './src/vps/VpsProviderRegistry.js';
import { CloudflareApi } from './src/cloudflare/CloudflareApi.js';
import { LockoutGuard } from './src/cloudflare/LockoutGuard.js';
import { VpsDockerControl } from './src/deploy/VpsDockerControl.js';
import { DeployOrchestrator } from './src/deploy/DeployOrchestrator.js';
import { ReconciliationJob } from './src/deploy/ReconciliationJob.js';
import { AgentFlowReader } from './src/AgentFlowReader.js';
import { RetroReader } from './src/RetroReader.js';
import { StackRegistry } from './src/StackRegistry.js';
import { VpsComposeControl } from './src/deploy/VpsComposeControl.js';
import { StackDeployOrchestrator } from './src/deploy/StackDeployOrchestrator.js';
import { BitwardenMasterKeyService } from './src/BitwardenMasterKeyService.js';
import { BoardAggregator } from './src/BoardAggregator.js';
import { DocsReader } from './src/DocsReader.js';
import { StoryMetricReader } from './src/StoryMetricReader.js';
import { WorkspaceHealthChecker } from './src/WorkspaceHealthChecker.js';
import { AssistService } from './src/AssistService.js';
import { mountRouters } from './src/routerLoader.js';

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

// ── AC1/AC5: Apply AccessGuard to every /api/* route ─────────────────────────
// MUSS vor mountRouters() stehen — Reihenfolge-Invariante (AC5).
const accessGuard = createAccessGuard();
app.use('/api', accessGuard);

// ── Boundary-/Dependency-Konstruktion (Composition-Root) ─────────────────────
// server.js bleibt Composition-Root: baut alle Boundaries und übergibt sie
// via deps an den Auto-Loader. Kein globaler Service-Locator.

export const auditStore = new AuditStore();

// ── PtySessionRegistry (AC4 / S-111) ─────────────────────────────────────────
// Multi-session: one PTY per project, keyed by absolute project path.
// Global (no-project) session preserved for backward compat.
const ptyRegistry = new PtySessionRegistry();
ptyRegistry.start(); // start global session

// ── CommandService ────────────────────────────────────────────────────────────
const commandService = new CommandService({ sessionRegistry: ptyRegistry, auditStore });

// ── GitHub / Docker Reader ────────────────────────────────────────────────────
// AC5 (github-app-token-unification): GitHubReader is wired through the cached
// App-Token-Provider.  The GH_TOKEN/GITHUB_TOKEN PAT is no longer the primary
// read path — the App Identity covers both reads and writes.
const githubAppTokenProvider = new GitHubAppTokenProvider({ credentialStore });
const githubReader = new GitHubReader({ tokenProvider: () => githubAppTokenProvider.getToken() });
const githubPackagesReader = new GitHubPackagesReader({ tokenProvider: () => githubAppTokenProvider.getToken() });
const dockerReader = new DockerReader();

// ── Workspace ─────────────────────────────────────────────────────────────────
const githubWriter = new GitHubWriter({ credentialStore });
const resolveWorkspaceRoot = buildWorkspaceRootResolver(credentialStore);
const workspaceScanner = new WorkspaceScanner({ workspaceRootResolver: resolveWorkspaceRoot });
const workspaceMutator = new WorkspaceMutator({ workspaceRootResolver: resolveWorkspaceRoot });
const githubCloner = new GitHubCloner({ credentialStore, workspaceRootResolver: resolveWorkspaceRoot });

// ── Cloudflare ────────────────────────────────────────────────────────────────
// CloudflareApi wird vor VpsProviderRegistry instanziiert, damit sie als
// Dependency für die Tunnel-Provisionierung beim VPS-Create (S-152) injiziert
// werden kann.
const cloudflareApi = new CloudflareApi({ credentialStore });

// ── VPS ───────────────────────────────────────────────────────────────────────
// cloudflareApi wird injiziert für Tunnel-Provisionierung beim Create (S-152 AC5–AC10).
// Wenn Cloudflare nicht konfiguriert ist, läuft VPS-Create ohne Tunnel (AC9).
const vpsRegistry = new VpsProviderRegistry({ credentialStore, cloudflareApi });

// ── Deploy ────────────────────────────────────────────────────────────────────
const lockoutGuard = new LockoutGuard();
const vpsDockerControl = new VpsDockerControl(credentialStore);
const deployOrchestrator = new DeployOrchestrator({
  dockerControl: vpsDockerControl,
  cloudflareApi,
  lockoutGuard,
});
const vpsTargets = buildVpsTargetsFromEnv(process.env.VPS_TARGETS);

// ── ReconciliationJob (Capability C, ADR-013) ─────────────────────────────
const reconcileVpsConfigs = buildReconcileVpsConfigs(vpsTargets, process.env.RECONCILE_TUNNEL_IDS);
const reconciliationJob = new ReconciliationJob({
  dockerControl: vpsDockerControl,
  cloudflareApi,
  lockoutGuard,
  orchestrator: deployOrchestrator,
  auditStore,
  vpsConfigs: reconcileVpsConfigs,
});
reconciliationJob.startScheduler();

// ── Stack ─────────────────────────────────────────────────────────────────────
const stackRegistry = new StackRegistry(credentialStore);
const vpsComposeControl = new VpsComposeControl(credentialStore);
const stackDeployOrchestrator = new StackDeployOrchestrator({
  composeControl: vpsComposeControl,
  orchestrator: deployOrchestrator,
  cloudflareApi,
  lockoutGuard,
});

// ── Bitwarden Unlock ──────────────────────────────────────────────────────────
const bitwardenMasterKeyService = new BitwardenMasterKeyService({
  credentialStore,
  auditStore,
});

// ── Team / Retro ──────────────────────────────────────────────────────────────
const agentFlowReader = new AgentFlowReader();
const retroReader = new RetroReader({
  pluginRootResolver: () => agentFlowReader.resolvePluginRoot(),
});

// ── Board-Aggregator (read-only Multi-Repo-Scan, AC1-3 + AC7-9) ──────────────
const boardAggregator = new BoardAggregator();
boardAggregator.startWatchers();

// ── AC4 (workspace-health-hinweis): Start-Log-Warnung bei Fehlkonfiguration ──
// Einmalig beim Boot — nie Start-Abbruch (try/catch), kein Secret im Log.
try {
  const bootHealthChecker = new WorkspaceHealthChecker({
    listClonesFn: () => workspaceScanner.listClones(),
    getIndexFn: () => boardAggregator.getIndex(),
  });
  const health = await bootHealthChecker.check();
  if (health.overall !== 'ok') {
    for (const c of health.checks) {
      if (c.status !== 'ok') {
        const fixPart = c.fix ? ` → Fix: ${c.fix}` : '';
        console.warn(`[workspace-health] ${c.key}: ${c.status.toUpperCase()} — ${c.message}${fixPart}`);
      }
    }
  }
} catch (bootHealthErr) {
  console.warn('[workspace-health] Boot-Check fehlgeschlagen (nicht kritisch):', bootHealthErr.message);
}

// ── DocsReader (read-only Projekt-Doku, AC1-3 projekt-spezifikation-anzeige) ──
const docsReader = new DocsReader();

// ── StoryMetricReader (read-only, AC1-2 story-detail-ansicht) ────────────────
const storyMetricReader = new StoryMetricReader();

// ── AssistService (zustandsloser claude -p one-shot, fabric-intake-dialog AC5) ──
// Kein JobLock — unabhängig von laufendem Flow-Command (AC5, AC7).
const assistService = new AssistService();

// ── deps-Objekt: alle Boundaries für den Auto-Loader ─────────────────────────
// Expose ptyManager for routers that reference it (e.g. session.js reads state/restarts/startedAt).
// These routers operate on the global (no-project) session, which preserves backward compat.
const ptyManager = ptyRegistry.getDefault();
const deps = {
  auditStore,
  ptyManager,
  commandService,
  githubReader,
  githubPackagesReader,
  dockerReader,
  credentialStore,
  bitwardenMasterKeyService,
  githubWriter,
  workspaceScanner,
  workspaceMutator,
  resolveWorkspaceRoot,
  githubCloner,
  vpsRegistry,
  cloudflareApi,
  deployOrchestrator,
  vpsDockerControl,
  vpsTargets,
  reconciliationJob,
  stackRegistry,
  stackDeployOrchestrator,
  agentFlowReader,
  retroReader,
  boardAggregator,
  docsReader,
  storyMetricReader,
  assistService,
};

// ── AC1/AC2: Auto-Discovery + Mount aller API-Router ─────────────────────────
// AccessGuard (oben) greift bereits; mountRouters() montiert alphabetisch-nach-order.
// Kein manuelles pro-Router import/app.use() nötig — neuer Endpunkt = neue Datei.
await mountRouters(app, deps);

// ── AC5: SPA-Catch-All NACH allen API-Routern ─────────────────────────────────
// Reihenfolge-Invariante: API-404 wird NICHT maskiert (AC5).
// express 5 (path-to-regexp 8): Wildcards müssen benannt sein — '*' → '/*splat'.
// '/*splat' matcht NICHT die Root '/', die liefert express.static (index.html) aus.
app.get('/*splat', (_req, res) => {
  res.sendFile(join(CLIENT_DIST, 'index.html'));
});

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = createServer(app);

// ── AC1: WS upgrade interceptor (guards /ws/terminal before handshake) ────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
// AC4/S-111: pass ptyRegistry (PtySessionRegistry) to WsGateway for per-project routing.
new WsGateway(wss, ptyRegistry);

const wsGuard = createWsAccessGuard(wss);

server.on('upgrade', (req, socket, head) => {
  // AC8 (S-124): match on pathname only, not the full URL including query-string.
  // A request to /ws/terminal?project=<x> must not be rejected before the handshake.
  // Guard against malformed req.url: if new URL throws, fall through to destroy().
  let pathname;
  try {
    pathname = new URL(req.url, 'ws://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname === '/ws/terminal') {
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
  boardAggregator.stopWatchers();
  ptyRegistry.destroy(); // destroy all sessions (global + project sessions)
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
