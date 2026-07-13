/**
 * dev-gui backend entrypoint.
 * Starts on port 8080 (or $PORT).
 *
 * Routes:
 *   GET  /                    → React SPA (client/dist) — public, no Access required
 *   GET  /api/status                              → { projects:[...], previews:[...], claudeAuth, lastCheckedAt } (claude-auth-health AC4)
 *   GET  /api/session                             → { state, restarts, startedAt }
 *   GET  /api/audit                               → [{time, identity, command}]
 *   POST /api/command                             → inject slash-command into PTY session
 *   POST /api/command/cancel                      → send Ctrl-C, cancel running command
 *   POST /api/projects/:slug/drain                 → { drainId } | 400 (costMode) | 409 (busy) — manueller „Board abarbeiten"-Knopf: HEADLESS via dedizierter ProjectDrain-Instanz + Cost-Mode (headless-manual-drain AC1/AC2/AC3, ADR-017)
 *   GET  /api/drain-reports[?project=<slug>]       → { reports: [...] } — Drain-Abschlussberichte, absteigend nach finishedAt (drain-completion-report AC4)
 *   GET  /api/projects/:slug/regression-runs       → { runs: [...] } (ohne ctrf) — Regressionsläufe, absteigend nach startedAt (regression-result-store AC4, S-312)
 *   GET  /api/projects/:slug/regression-runs/:runId → { run } | 404 — Einzel-Lauf inkl. ctrf + artifacts bei Rot (regression-result-store AC4, S-312)
 *   GET/PUT /api/settings/retro-auto                → { enabled } — globaler Auto-Retro-Schalter (retro-auto-trigger S-259 AC1/AC2)
 *   GET/PUT /api/settings/ticker                   → Nachtwächter-Settings (taktgeber-nachtwaechter S-194 AC15/AC16)
 *   GET  /api/settings/ticker/status               → { enabled, window, withinWindow, activeDrains } — Statusanzeige (taktgeber-nachtwaechter S-197 AC17)
 *   GET/PUT/DELETE /api/settings/credentials*     → Credential-Verwaltung (settings-credentials)
 *   GET  /api/settings/credential-status          → { state, hasEncryptedEntries } (credential-bootstrap-status #184)
 *   POST /api/settings/credential-unlock          → { ok, state? } (credential-unlock-dialog #185)
 *   GET/PUT/DELETE /api/settings/ssh-keys*             → SSH-Key-Verwaltung (settings-ssh-keys Stufe A)
 *   POST /api/settings/ssh-keys/:user/provision        → VPS-Provisionierung (settings-ssh-keys Stufe B, #47)
 *   POST /api/settings/ssh-keys/:user/generate         → ed25519-Keypair erzeugen (ssh-key-generation AC1–AC7, #115)
 *   GET  /api/settings/ssh-keys/:user/private-key/export → Private-Key-Export (ssh-key-generation AC4, #115)
 *   POST /api/settings/ssh-keys/:user/rotate           → vollautomatische additive SSH-Key-Rotation (ssh-key-rotation AC1–AC8, #118)
 *   GET/PUT/DELETE /api/settings/workspace-path   → Workspace-Pfad-Konfiguration (workspace-path-config #85)
 *   GET/PUT/DELETE /api/settings/obsidian-vault-path → Obsidian-Vault-Pfad-Konfiguration (obsidian-vault-config S-245)
 *   GET  /api/settings/obsidian-vault/projects     → { projects: [{name,path}] } — Projekt-Unterordner (obsidian-vault-config AC5, S-246)
 *   POST /api/obsidian-ingest/start                → { jobId, status } | 400/404/409 — headless from-notes-Katalog-Lauf (obsidian-question-catalog AC1, S-250)
 *   GET  /api/obsidian-ingest/:jobId               → { status, catalog?, result?, error? } | 404 — Status + Fragenkatalog (obsidian-question-catalog AC2/AC5, S-250)
 *   POST /api/obsidian-ingest/:jobId/answers       → { status } | 400/404/409 — Antworten zurück, Resume (obsidian-question-catalog AC4, S-250)
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
 *   GET    /api/deployments/vps-tunnel-status                  → [{ vpsId, tunnelId, tunnelPresent }] (vps-tunnel-existence-gate S-185 AC7)
 *   POST   /api/deployments/vps/:vpsId/tunnel/recreate        → { result, report } [MUTATION, S-187 AC1–5,11,12 + S-188 AC6–8]
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
 *   POST   /api/board/projects/:slug/ideas                         → { storyId } — Quick-Capture, status: Idee (ideen-inbox S-199 AC3)
 *   POST   /api/board/projects/:slug/ideas/:id/discuss              → { sessionId } — interaktive PTY-Besprechung + Gesprächs-Seed (ideen-inbox S-200 AC5)
 *   POST   /api/board/projects/:slug/ideas/:id/resolve              → { storyId } — Idee → Done + resolved_at/resolved_story_ids (ideen-inbox S-200 AC6)
 *   POST   /api/board/projects/:slug/ideas/:id/specify/start        → { sessionId, reply } — Chat-Session-Start, mit Titel/Notes geseedet (idea-specify-chat S-215 AC3)
 *   POST   /api/board/projects/:slug/ideas/:id/specify/message      → { reply, readyToSpecify, draftText? } — nächster Chat-Turn (idea-specify-chat S-215 AC4,AC13)
 *   POST   /api/board/projects/:slug/ideas/:id/specify/finalize     → { jobId, status:"running" } | 400/404/409 — headless requirement-Finalizer (idea-specify-chat S-216 AC6)
 *   GET    /api/board/projects/:slug/ideas/:id/specify/finalize/:jobId → { status, result?, error? } | 404 (idea-specify-chat S-216 AC7)
 *   POST   /api/assist/refine                                      → { refinedText, openQuestions[], notes? } (fabric-intake-dialog AC5,AC7,AC10)
 *   POST   /api/reconcile                                          → { jobId, status:"running" } | 409 (busy) | 400 (invalid slug) — Headless-Reconcile-Runner (headless-reconcile-runner AC8)
 *   GET    /api/reconcile/:jobId                                   → { status, result?, error?, prHint? } | 404 (headless-reconcile-runner AC9)
 *   POST   /api/assist/knowledge-sources                          → { ok, suggestedPackId, suggestedType, sources[], notes? } (team-knowledge-add AC3,AC6,AC11-AC15)
 *   GET    /api/settings/notifications                             → Settings inkl. has_token (push-notifications S-183 AC2)
 *   PUT    /api/settings/notifications                             → Settings speichern mit Validierung (push-notifications S-183 AC2)
 *   POST   /api/settings/notifications/test                        → { ok, error? } Test-Versand (push-notifications S-182 AC5)
 *   WS   /ws/terminal                             → PtyManager bridge (guarded by AccessGuard)
 *   WS   /ws/vps-terminal                         → SshPtyManager bridge — {type:"open",provider,serverId,user} Handshake, root|alex-only, AccessGuard + CRED_ADMIN_EMAILS-Rollenschutz + Audit-First (vps-ssh-terminal AC5/AC6/AC9, S-263)
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
import { CredentialStore, catalogKey } from './src/CredentialStore.js';
import { GitHubWriter } from './src/GitHubWriter.js';
import { WorkspaceScanner } from './src/WorkspaceScanner.js';
import { WorkspaceMutator } from './src/WorkspaceMutator.js';
import { GitHubCloner } from './src/GitHubCloner.js';
import { buildWorkspaceRootResolver } from './src/workspacePath.js';
import { VpsProviderRegistry } from './src/vps/VpsProviderRegistry.js';
import { resolveVpsTarget } from './src/vpsContainerRouter.js';
import { SshPtyManager } from './src/SshPtyManager.js';
import { VpsTerminalGateway, checkVpsTerminalAuthz } from './src/VpsTerminalGateway.js';
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
import { LocalDockerControl } from './src/deploy/LocalDockerControl.js';
import { TunnelHealService } from './src/deploy/TunnelHealService.js';
import { BitwardenMasterKeyService } from './src/BitwardenMasterKeyService.js';
import { BoardAggregator } from './src/BoardAggregator.js';
import { DocsReader } from './src/DocsReader.js';
import { StoryMetricReader } from './src/StoryMetricReader.js';
import { WorkspaceHealthChecker } from './src/WorkspaceHealthChecker.js';
import { AssistService } from './src/AssistService.js';
import { IdeaSpecifyChatService } from './src/IdeaSpecifyChatService.js';
import { IdeaSpecifyFinalizer } from './src/IdeaSpecifyFinalizer.js';
import { StorySpecifyFinalizer } from './src/StorySpecifyFinalizer.js';
import { HeadlessReconcileRunner } from './src/HeadlessReconcileRunner.js';
import { ObsidianIngestRunner } from './src/ObsidianIngestRunner.js';
import { RegressionDefineRunner } from './src/RegressionDefineRunner.js';
import { RegressionRunner } from './src/RegressionRunner.js';
import { ClaudeAuthHealthService } from './src/ClaudeAuthHealthService.js';
import { KnowledgeSourceService } from './src/KnowledgeSourceService.js';
import { read as readNotificationSettings, migrateEventDefaults } from './src/NotificationSettingsStore.js';
import { read as readTickerSettings } from './src/TickerSettingsStore.js';
import { NotificationWatcher } from './src/NotificationWatcher.js';
import { RunStateWatcher } from './src/RunStateWatcher.js';
import { sendNotification } from './src/NotifyService.js';
import { DrainNotifier } from './src/DrainNotifier.js';
import { ProjectDrain } from './src/ProjectDrain.js';
import { BoardWriter } from './src/BoardWriter.js';
import { AreaWriter } from './src/AreaWriter.js';
import { TokenLimitWatcher } from './src/TokenLimitWatcher.js';
import { NightWatchScheduler } from './src/NightWatchScheduler.js';
import { TokenUsageMeter } from './src/TokenUsageMeter.js';
import { BudgetGuard, BUDGET_RESUME_BUFFER_MS } from './src/BudgetGuard.js';
import { DrainReportStore } from './src/DrainReportStore.js';
import { BitwardenDeployAccessStore } from './src/BitwardenDeployAccessStore.js';
import { BitwardenDeployLoginService } from './src/BitwardenDeployLoginService.js';
import { PerAppGpgProvisioningService } from './src/PerAppGpgProvisioningService.js';
import { PerAppGpgRotationService } from './src/PerAppGpgRotationService.js';
import { RegressionResultStore } from './src/RegressionResultStore.js';
import { DrainJobRegistry } from './src/DrainJobRegistry.js';
import { FeatureDrainRegistry } from './src/FeatureDrainRegistry.js';
import { FeatureDrainRunner } from './src/FeatureDrainRunner.js';
import { BootDrainRecovery } from './src/BootDrainRecovery.js';
import { HeadlessFlowRunner } from './src/HeadlessFlowRunner.js';
import { HeadlessFlowRunnerAdapter } from './src/FlowRunner.js';
import { FeatureDrainFlowRunner } from './src/FeatureDrainFlowRunner.js';
import { ProjectJobLock } from './src/ProjectJobLock.js';
import { CostModeModelCheck } from './src/CostModeModelCheck.js';
import { HeadlessRetroRunner } from './src/HeadlessRetroRunner.js';
import { RetroAutoQueue } from './src/RetroAutoQueue.js';
import { AutoRetroTrigger } from './src/AutoRetroTrigger.js';
import { read as readRetroAutoSettings } from './src/RetroAutoSettingsStore.js';
import { BoardEventHub } from './src/BoardEventHub.js';
import { RepoSizeScanner } from './src/RepoSizeScanner.js';
import { RepoSizeStore } from './src/RepoSizeStore.js';
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

// ── Notification-Event-Defaults-Migration (notification-event-defaults AC3/AC4) ──
// Genau einmal beim Server-Start, VOR jedem Lesen/Verwenden der Notification-Settings.
// Best-effort — migrateEventDefaults() wirft nie nach außen (kein Boot-Abbruch möglich).
await migrateEventDefaults().catch((err) => {
  console.error('[server] migrateEventDefaults fehlgeschlagen (best-effort, kein Boot-Abbruch):', err.message);
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
// S-185: vpsRegistry wird für Tunnel-Mismatch/-Missing-Gate (AC5/AC6) mitgegeben.
const deployOrchestrator = new DeployOrchestrator({
  dockerControl: vpsDockerControl,
  cloudflareApi,
  lockoutGuard,
  vpsRegistry,
});
const vpsTargets = buildVpsTargetsFromEnv(process.env.VPS_TARGETS);

// ── SSH-PTY-Bridge (vps-ssh-terminal AC7/AC8/AC10, S-262, ADR-019) ─────────────
// Geschwister-Boundary von VpsProvisioner (ADR-008): interaktive ssh-PTY-Sitzungen
// statt nicht-interaktiver ssh2-Kommandos. `resolveVpsTarget` (dieselbe Auflösung
// wie das Deploy-/Container-Übersicht-Ziel, S-167) wird als Adapter injiziert —
// der `targetUser` des aufgelösten Ziels wird NICHT verwendet, der SSH-User kommt
// ausschließlich aus dem WS-Handshake (AC6, S-263 — kein WS-Routing hier).
const sshPtyManager = new SshPtyManager({
  credentialStore,
  resolveTarget: (provider, serverId) => resolveVpsTarget(provider, serverId, vpsRegistry, vpsTargets),
});

// ── ReconciliationJob (Capability C, ADR-013) ─────────────────────────────
// S-167 AC6: Vereinigung dynamischer Target-Records (aus persistierten Create-Datensätzen)
// und Env-Konfiguration (RECONCILE_TUNNEL_IDS). Env gewinnt bei Kollision.
const reconcileVpsConfigs = await buildReconcileVpsConfigsDynamic(
  vpsTargets,
  process.env.RECONCILE_TUNNEL_IDS,
  vpsRegistry,
);
const reconciliationJob = new ReconciliationJob({
  dockerControl: vpsDockerControl,
  cloudflareApi,
  lockoutGuard,
  orchestrator: deployOrchestrator,
  auditStore,
  vpsConfigs: reconcileVpsConfigs,
  sendNotificationFn: sendNotification,
  readNotificationSettings,
  credentialStore,
});
reconciliationJob.startScheduler();

// ── Lokaler Image-Test (S-156, AC1–AC5) ───────────────────────────────────────
// Schreibend-lokale Docker-Boundary (run/inspect/rm lokal via DOCKER_HOST).
// Read-only DockerReader bleibt unberührt.
const localDockerControl = new LocalDockerControl();

// ── Tunnel-Selbstheilung (S-187 AC1–5, AC11, AC12 + S-188 AC6–10) ───────────
// TunnelHealService orchestriert Phase 1 (CF + CredentialStore) + Phase 2 (SSH-Token-Push)
// + Phase 3 (Routen bestücken via geteiltem addRouteOnly-Pfad, S-188 AC6).
// Token NIE in Argv/Log/Audit/Response (AC4/AC11 HART).
const tunnelHealService = new TunnelHealService({
  cloudflareApi,
  vpsDockerControl,
  credentialStore,
  deployOrchestrator, // S-188 AC6: geteilter ADR-012 addRouteOnly-Pfad
});

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

// ── ClaudeAuthHealthService (Boot- + periodische Auth-Probe, claude-auth-health AC1–AC6) ──
// Getrennt vom interaktiven PTY-Pfad (analog HeadlessReconcileRunner AC7) — eigener
// kurzlebiger claude-Kindprozess. start() ist fire-and-forget (blockiert den Boot nie,
// Edge-Case "Probe-Fehler beim Boot"); stop() in shutdown() unten. Vorgezogen (vor dem
// Taktgeber-Block) — S-213 AC9: der NightWatchScheduler braucht diese Instanz für seine
// Auth-Vorabprüfung.
const claudeAuthHealthService = new ClaudeAuthHealthService();

// ── Taktgeber/Nachtwächter (taktgeber-nachtwaechter.md) ───────────────────────
// ProjectDrain (S-192) + BoardWriter (S-191) + TokenLimitWatcher (S-193) +
// NightWatchScheduler (S-195, AC9–AC11): zieht die bereits gebauten Bausteine
// zu einem periodischen Nachtfenster-Job zusammen. sessionRegistry=ptyRegistry
// deckt sowohl die Busy-Erkennung (AC7, ProjectDrain) als auch den
// Token-Limit-Watcher-Attach je Projekt-Session ab (S-195, konto-weit).
const boardWriter = new BoardWriter();
// bereichs-modell AC3-AC7 (S-289): einziger Schreibpfad für board/areas.yaml
// (create/rename/reorder/delete) — dieselbe BOARD_ROOTS-Realpath-Schranke wie
// BoardWriter, aber eine eigene, schmalere Boundary-Klasse (kein Story-Datei-
// Zugriff nötig).
const areaWriter = new AreaWriter();
// ── Manueller „Board abarbeiten"-Knopf: HEADLESS (ADR-017, docs/specs/headless-manual-drain.md AC1/AC2/AC3) ──
// Seit ADR-017 (Owner-Entscheidung 2026-07-01) läuft der manuelle Knopf NICHT
// mehr interaktiv über den PTY-`CommandService`, sondern headless — analog zum
// Nacht-Drain (unten): eine DEDIZIERTE `ProjectDrain`-Instanz mit einem
// `HeadlessFlowRunnerAdapter` um eine EIGENE `HeadlessFlowRunner`-Instanz. Der
// Flow-Schritt jeder Drain-Runde ist damit ein `claude -p '/agent-flow:flow …'`-
// Kindprozess (kein PTY-Write, kein globaler PTY-Lock, AC1).
//
// Lock-Trennung (AC2 — sonst Selbst-/Fremdblockade):
//   - `manualHeadlessFlowRunner` bekommt per Default (`new HeadlessFlowRunner()`)
//     seine EIGENE `ProjectJobLock`-Instanz für den per-Runden-Lock — getrennt
//     vom Nacht-Drain-Runner, Reconcile-Runner und IdeaSpecifyFinalizer.
//   - `manualDrainLock` ist die EIGENE Session-Lock-Instanz dieser ProjectDrain-
//     Instanz — bewusst NICHT der `projectJobLock`-Singleton (den der Nacht-
//     Drain als Session-Lock hält). Dadurch blockiert ein laufender Nacht-/
//     Finalize-/Reconcile-Lauf fürs selbe Projekt den manuellen Drain NICHT
//     strukturell über einen geteilten Lock (und umgekehrt).
//   - Dieselbe `manualDrainLock`-Instanz wird zusätzlich in den
//     projectDrainRouter injiziert (deps unten), damit dessen `isProjectBusy`-
//     Vorabprüfung den laufenden manuellen Drain sieht → ein zweiter manueller
//     Drain fürs selbe Projekt liefert `409` (AC2).
// `commandService` wird NUR für die `isProjectBusy()`-Busy-Erkennung gehalten
// (aktive PTY-Session/Command), NICHT für den Ausführungs-Schritt.
// ── Repo-Größen-Anzeige (repo-size-badge AC4-AC8, S-298) ─────────────────────
// Eigene ProjectJobLock-Instanz (Dedup je Klon-Slug, getrennt von allen anderen
// Locks) — ein zweiter Refresh-Trigger während eines laufenden Scans koalesziert.
const repoSizeScanner = new RepoSizeScanner({ workspaceRootResolver: resolveWorkspaceRoot });
const repoSizeStore = new RepoSizeStore();
const repoSizeRefreshLock = new ProjectJobLock();

const manualDrainLock = new ProjectJobLock();
const manualHeadlessFlowRunner = new HeadlessFlowRunner();
const manualHeadlessFlowRunnerAdapter = new HeadlessFlowRunnerAdapter({
  headlessRunner: manualHeadlessFlowRunner,
  auditStore, // AC1: Start/Ende(Erfolg)/Fehler je headless-Lauf (keine Secrets/Pfade)
});
// ── Feature-Umsetzen-Button: ProjectJobLock (vorgezogen — S-317 Review-
// Iteration 2 braucht dieselbe Instanz bereits für die untenstehende
// `FeatureDrainFlowRunner`-Konstruktion, s. Cross-Boundary-Lock-Kommentar). ──
// Eigene Registry (`featureDrainRegistry`, weiter unten konstruiert, näher an
// ihrem restlichen Feature-Umsetzen-Button-Kontext) — der Lock selbst muss
// aber HIER schon existieren.
const featureDrainLock = new ProjectJobLock();
// ── Feature-Ebenen-Auswahl (docs/specs/feature-aware-drain.md AC1/AC4/AC5) ──
// EINE geteilte `FeatureDrainFlowRunner`-Instanz für BEIDE Drain-Instanzen
// (manuell + Nacht). Skript-Lokalisierung über denselben Plugin-Cache-Glob-
// Mechanismus wie der Feature-Umsetzen-Button (AC5,
// `agentFlowReader.resolvePluginRootContaining`) — fehlt das Skript in jeder
// installierten Plugin-Version, liefert `startRun()`
// `{ok:false, reason:'feature-drain-unavailable'}` und `ProjectDrain` fällt
// pro Runde sauber auf den Einzel-/flow-Pfad zurück (kein Crash).
// Cross-Boundary-Lock (S-317 Review-Iteration 2, .claude/lessons/coder.md
// 2026-07-07): `featureDrainLock` ist DIESELBE Instanz, die
// `src/routers/featureDrain.js` (Feature-Umsetzen-Button) für den
// `${projectSlug}:${featureId}`-Lock nutzt — verhindert einen parallelen
// Start von `board-feature-drain.sh F-###` für dasselbe Feature über beide
// unabhängigen Wege (Button UND Taktgeber/manueller Drain).
const featureDrainFlowRunner = new FeatureDrainFlowRunner({
  pluginRootResolver: () => agentFlowReader.resolvePluginRootContaining('scripts/board-feature-drain.sh'),
  auditStore,
  featureDrainLock,
});
const projectDrain = new ProjectDrain({
  boardAggregator,
  commandService,
  boardWriter,
  sessionRegistry: ptyRegistry,
  auditStore,
  flowRunner: manualHeadlessFlowRunnerAdapter,
  featureDrainFlowRunner,
  lock: manualDrainLock,
});

// ── Headless-Nacht-Drain (S-213, docs/specs/headless-parallel-drain.md AC7/AC9/AC11) ──
// EIGENE HeadlessFlowRunner-Instanz mit ihrer EIGENEN, eigenständigen
// ProjectJobLock-Instanz (Konstruktor-Default `new ProjectJobLock()` in
// HeadlessFlowRunner.js) — bewusst NICHT die `projectJobLock`-Singleton-
// Instanz, die `ProjectDrain` für die Dauer der GESAMTEN Drain-Session hält.
// Würde derselbe Lock-Singleton in BEIDE injiziert, würde JEDER headless-Lauf
// sich SELBST blockieren (`reason:'locked'`), weil ProjectDrain das
// projektweise Lock schon hält, bevor `#runLoop` überhaupt den ersten
// `/flow`-Anstoß versucht (S-212-Review-Kritikpunkt).
const headlessFlowRunner = new HeadlessFlowRunner();
const headlessFlowRunnerAdapter = new HeadlessFlowRunnerAdapter({
  headlessRunner: headlessFlowRunner,
  auditStore, // AC11: Start/Ende(Erfolg)/Fehler je headless-Lauf
});
// ── BudgetGuard (night-budget-guard AC9–AC11, S-274) ─────────────────────────
// Nacht-Budget-Schutz — NUR in die Nacht-Drain-`ProjectDrain`-Instanz
// injiziert (Story-Scope AC9: "in die Nacht-Drain-ProjectDrain-Instanz"; der
// manuelle Drain bleibt unberührt, kein zweiter Config-Pfad in dieser Story).
// `budgetResumeBufferMs` per Env konfigurierbar (AC10), entkoppelt vom
// 1-Min-`TokenLimitWatcher`-Puffer — DIESELBE env-abgeleitete Zahl wird
// unten AUCH an `nightProjectDrain` (`deps.budgetResumeBufferMs`, reaktiver
// Pfad) gereicht, damit reaktiver und proaktiver Pfad nicht auseinanderdriften
// (siehe BudgetGuard.js Modul-Doku).
const budgetResumeBufferMs = Number(process.env.BUDGET_RESUME_BUFFER_MS) || BUDGET_RESUME_BUFFER_MS;
const budgetGuard = new BudgetGuard({
  tokenUsageMeter: new TokenUsageMeter(),
  readSettings: readTickerSettings,
  budgetResumeBufferMs,
});
// SEPARATE ProjectDrain-Instanz ausschließlich für den Nachtwächter — nutzt
// denselben commandService NUR für die bestehende `isProjectBusy()`-Erkennung
// (AC6/AC7 taktgeber-nachtwaechter, unverändert), der Ausführungs-Schritt
// selbst läuft über den headless-Adapter (AC5/AC7 headless-parallel-drain).
const nightProjectDrain = new ProjectDrain({
  boardAggregator,
  commandService,
  boardWriter,
  sessionRegistry: ptyRegistry,
  auditStore,
  flowRunner: headlessFlowRunnerAdapter,
  featureDrainFlowRunner, // feature-aware-drain AC1: geteilte Instanz, s.o.
  budgetGuard, // night-budget-guard AC9: proaktive Schwellen-Prüfung vor jeder Flow-Runde
  budgetResumeBufferMs, // night-budget-guard AC10: reaktiver Puffer, dieselbe env-Zahl wie budgetGuard
});
const tokenLimitWatcher = new TokenLimitWatcher();
// ── CostModeModelCheck (Boot + periodische + Dispatch-Cost-Mode-Modellprüfung,
// cost-mode-model-check AC1–AC7) — VOR dem NightWatchScheduler konstruiert, da
// dieser die Boundary für seine Dispatch-Frische-Prüfung (AC4/AC5) braucht. ──
// Liest READ-ONLY das Frische-Signal (`last_curated`) der agent-flow-Matrix
// (`knowledge/model-tiers.md`) über den bereits vorhandenen `agentFlowReader`-
// Plugin-Root-Resolver; bei Drift stößt sie den Curator headless an
// (`claude -p '/agent-flow:train model-tiers'`). EIGENE HeadlessFlowRunner-
// Instanz mit ihrer EIGENEN ProjectJobLock-Instanz (Konstruktor-Default in
// HeadlessFlowRunner.js) — bewusst getrennt von Nacht-Drain/Reconcile/
// Finalizer/manuellem Drain (AC7-Isolation, sonst Fremd-/Selbstblockade).
// dev-gui MUTIERT die Matrix NICHT (A2/A3 — nur Anstoß + read-only Signal).
const costModeModelCheck = new CostModeModelCheck({
  pluginRootResolver: () => agentFlowReader.resolvePluginRoot(),
  flowRunner: new HeadlessFlowRunner(),
  auditStore,
});
// ── DrainReportStore (drain-completion-report AC3/AC5/AC6) ───────────────────
// Persistente, größenbegrenzte Abschlussbericht-Ablage (letzte 30 je Projekt,
// ${CRED_STORE_DIR}/drain-reports.json, atomarer Schreibzugriff). EINE geteilte
// Instanz für BEIDE Auslöser: Nacht-Drain (NightWatchScheduler, trigger:'night')
// UND manueller Drain (projectDrainRouter via deps, trigger:'manual') — sowie
// read-only für GET /api/drain-reports (drainReports.js Router).
const drainReportStore = new DrainReportStore();

// ── BitwardenDeployAccessStore (deploy-bitwarden-gpg-injection F-072, S-331) ──
// Eigener 0600-Speicher (${CRED_STORE_DIR}/bitwarden-deploy-access.json) für den
// UNBEAUFSICHTIGTEN Bitwarden-Zugang der Deploy-Rolle (Variante B). Bewusst
// AUSSERHALB des CredentialStore (Henne-Ei: der Store wird durch den aus Bitwarden
// bezogenen Master-Key entsperrt — der Zugang zu Bitwarden kann daher nicht dort
// liegen). Write-only nach außen; Klartext nur intern für den Login-Dienst (S-332).
const bitwardenDeployAccessStore = new BitwardenDeployAccessStore();

// ── BitwardenDeployLoginService (deploy-bitwarden-gpg-injection F-072, S-332) ──
// Unbeaufsichtigter Bitwarden-Login (API-Key, kein OTP) + Item-Read. Nutzt den
// Zugangs-Speicher oben; isoliert je Lauf via eigenem BITWARDENCLI_APPDATA_DIR.
// Konsument: der Prüf-Endpunkt (POST .../validate) und der Deploy-Guard (S-334).
const bitwardenDeployLoginService = new BitwardenDeployLoginService({
  accessStore: bitwardenDeployAccessStore,
  auditStore,
});

// ── PerAppGpgProvisioningService (per-app-gpg-passphrase-provisioning F-073, S-335) ──
// Kern-Dienst der per-App-GPG-Passphrasen-Provisionierung: idempotente Anlage von
// `env.gpg-passphrase-<app>` in Bitwarden. Nutzt AUSSCHLIESSLICH die Session des
// bestehenden bitwardenDeployLoginService (kein zweiter bw-Login-/Spawn-Pfad) —
// Konsument: POST /api/deployments/:app/gpg-provision (deploymentsRouter, AC10).
const perAppGpgProvisioningService = new PerAppGpgProvisioningService({
  deployLoginService: bitwardenDeployLoginService,
  auditStore,
});

// ── PerAppGpgRotationService (per-app-gpg-passphrase-rotation F-073, S-338) ──
// Zwei-Phasen-Rotation (Kandidat/Beweis-Runde → Umschalten) der per-App-GPG-
// Passphrase. Nutzt AUSSCHLIESSLICH die Session des bestehenden
// bitwardenDeployLoginService (kein zweiter bw-Login-/Spawn-Pfad) UND
// AUSSCHLIESSLICH den bestehenden workspaceMutator (pullClone/commitAndPushFile,
// kein zweiter git-Spawn-Pfad) — credentialStore fürs Token-Minting (Git-Push).
// Konsument: POST /api/deployments/:app/gpg-rotate/{start,commit,discard-previous}
// (deploymentsRouter, AC1-AC7/AC10-AC13).
const perAppGpgRotationService = new PerAppGpgRotationService({
  deployLoginService: bitwardenDeployLoginService,
  auditStore,
  workspaceMutator,
  credentialStore,
  workspaceRootResolver: resolveWorkspaceRoot,
});

// ── DrainNotifier (drain-done-notification AC1–AC7, S-277) ──────────────────
// EIN Produzent für ALLE Notify-Nähte (Nacht-Drain/manueller Drain/
// Regressionslauf-Abschluss) — GETEILTE Instanz, kein zweiter Config-/
// Token-Pfad. Dieselbe Config-/Token-Quelle wie der `NotificationWatcher`
// (`readNotificationSettings` + CredentialStore-Token unter demselben
// Integration/Name-Paar) — nur der Versand-Weg ist neu. VOR dem
// RegressionRunner UND dem NightWatchScheduler konstruiert, da beide die
// Instanz für ihre jeweilige Abschluss-Naht brauchen (regression-failed-
// notification AC1–AC4, S-315; drain-done-notification AC4/AC6).
const drainNotifier = new DrainNotifier({
  getNotificationConfig: readNotificationSettings,
  getToken: () => credentialStore.getPlaintext(catalogKey('notifications', 'ntfy_token')),
  sendNotificationFn: sendNotification,
});

// ── RegressionResultStore (regression-result-store AC1-AC5, S-312) ──────────
// Persistente, größenbegrenzte Regressionslauf-Ablage (letzte 50 je Projekt,
// ${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>.json, atomarer
// Schreibzugriff, Debug-Artefakte nur bei roten Läufen). Read-only für
// GET /api/projects/:slug/regression-runs[/:runId] (regressionRuns.js Router).
// Der Schreibpfad (record()) wird vom künftigen Regressionslauf-Runner
// ([[regression-run]], S-309) aufgerufen — hier nur das Fundament.
const regressionResultStore = new RegressionResultStore();

// ── RegressionRunner (deterministischer `npx playwright test`-Runner,
// docs/specs/regression-run.md AC1, AC2, AC3, AC5, AC9, S-309; AC7, AC8,
// S-310; regression-failed-notification AC1–AC4, S-315) ────────────────────
// EIGENE, isolierte `ProjectJobLock`-Instanz (Konstruktor-Default
// `new ProjectJobLock()` in RegressionRunner.js) — bewusst getrennt von ALLEN
// `claude -p`-Runnern (Nacht-Drain/manueller Drain/Reconcile/Finalizer/
// Auto-Retro/ObsidianIngestRunner/RegressionDefineRunner). Zentraler
// Unterschied zu diesen: dieser Runner spawnt KEIN `claude` — ausschließlich
// `npx playwright test` (Grep-prüfbar, kein API-Key). `auditStore` +
// `resultStore` injiziert (Ende-/Fehler-Audit secret-frei; CTRF-Ergebnis-
// Übergabe an die S-312-Ablage, AC9). `dockerControl` = dieselbe
// `LocalDockerControl`-Instanz wie die lokale Image-Test-Boundary (S-156) —
// Frisch-Ausrollen (AC7) nutzt deren NEUE `pullAndRecreate()`-Methode, kein
// zweiter Docker-Boundary-Pfad. Selbsttest-Skip (AC8, dev-gui) ist
// server-seitig im Runner selbst erzwungen (SELF_PROJECT_SLUG), unabhängig
// vom übergebenen `freshRollout`-Wert. `notifier` = GETEILTE `DrainNotifier`-
// Instanz (s.o.) — bei Lauf-Abschluss mit status:"failed" best-effort GENAU
// EIN `regression_failed`-Push (kein zweiter Notify-Pfad).
const regressionRunner = new RegressionRunner({
  auditStore,
  resultStore: regressionResultStore,
  dockerControl: localDockerControl,
  notifier: drainNotifier,
});

// ── DrainJobRegistry (drain-restart-robustness AC1–AC4, S-281/S-282) ────────
// EINE geteilte, datei-persistierte Instanz (${CRED_STORE_DIR}/drain-jobs.json)
// für BEIDE Auslöser: manueller Drain (projectDrain.js Router, trigger:'manual',
// AC1/AC2) UND Nacht-Drain (NightWatchScheduler unten, trigger:'night', AC3) —
// kein zweiter Datei-/Config-Pfad. Boot-Orphan-Markierung (AC4): unmittelbar
// nach dem Konstruieren wird JEDER noch-`running`-Eintrag (aus einem früheren
// Prozess-Leben — sein `claude -p`-Kindprozess starb mit dem alten Prozess) auf
// `aborted` gesetzt und persistiert; `GET .../drain/:drainId` liefert danach
// `200 {status:'aborted'}` statt `404` (Monitoring nicht mehr blind). Idempotent
// (ein zweiter Aufruf/Boot lässt bereits-terminale Einträge unangetastet).
// Best-effort — ein Fehler hier darf den Server-Boot NIE crashen. Die
// zurückgegebenen Orphan-Einträge werden unten (nach Konstruktion von
// manualProjectDrain/nightProjectDrain/nightWatchScheduler) an
// `BootDrainRecovery` (drain-restart-robustness AC5–AC8, S-283) übergeben.
const drainJobRegistry = new DrainJobRegistry();

// ── Feature-Umsetzen-Button (feature-umsetzen-button, Owner-Auftrag 2026-07-06) ──
// Eigene Registry — Dedup je Projekt+Feature über `featureDrainLock` (bereits
// weiter oben konstruiert, s. Cross-Boundary-Lock-Kommentar bei
// `featureDrainFlowRunner`) — getrennt von allen anderen headless-Boundaries
// (kein zweiter Codepfad in einer bestehenden Registry). FeatureDrainRunner
// spawnt scripts/board-feature-drain.sh aus dem agent-flow-Plugin
// (agentFlowReader, bereits oben instanziiert) direkt als Kindprozess — kein
// claude-p-Runner, das Skript selbst spawnt intern je Story
// `claude -p /agent-flow:flow`.
const featureDrainRegistry = new FeatureDrainRegistry();
const featureDrainRunner = new FeatureDrainRunner({ registry: featureDrainRegistry, lock: featureDrainLock, auditStore });
let orphanedDrains = [];
try {
  orphanedDrains = drainJobRegistry.reconcileOrphans();
} catch (err) {
  console.error('[server] DrainJobRegistry-Boot-Reconcile fehlgeschlagen:', err.message);
}

// ── Auto-Retro: serielle Queue + headless Runner + Auslöse-Trigger ────────────
// (retro-auto-queue AC5/AC6 S-256/S-257 + retro-auto-trigger AC4–AC7 S-261).
// VOR dem NightWatchScheduler konstruiert, weil dieser den `autoRetroTrigger` für
// seine Drain-Abschluss-Naht (AC4) braucht — dieselbe Instanz wird zusätzlich in
// den manuellen projectDrainRouter injiziert (deps unten), sodass BEIDE Auslöser
// denselben `isRetroDue`-Check gegen dieselbe `RetroAutoQueue` fahren (AC6/AC7,
// kein zweiter Codepfad).
//
// `retroAutoQueue`: EIN Worker, global serialisiert (schützt die geteilte
// Lern-Ablage `LEARNINGS.md`/globale Packs vor konkurrierenden Läufen/PRs). Der
// `HeadlessRetroRunner` kapselt die headless-Ausführung
// (`claude -p '/agent-flow:retro --force'`) über eine EIGENE `HeadlessFlowRunner`-
// Instanz mit EIGENER, frischer `ProjectJobLock`-Instanz (Konstruktor-Default in
// HeadlessRetroRunner.js/HeadlessFlowRunner.js) — bewusst getrennt von ALLEN
// anderen headless-Locks (Nacht-Drain, manueller Drain, Reconcile, Finalizer,
// costModeModelCheck), sonst würde ein paralleler Lauf für dasselbe Projekt
// fälschlich blockiert. `auditStore` injiziert (AC6: Start/Ende/Fehler je Lauf,
// secret-frei). `retroAutoQueue` wird zusätzlich exportiert (Boundary-Referenz).
//
// `autoRetroTrigger` (S-261): reine Policy — `isRetroDue` (Schalter AN +
// flowRuns≥1 + Dedup) + best-effort/fire-and-forget `enqueue`. `readSettings` ist
// `RetroAutoSettingsStore.read` (nicht-geheimer `enabled`-Bool, Default false =
// heutiges Verhalten). KEINE Ausführungs-/Serialisierungslogik hier (die liegt in
// der Queue); `--force`/G3-Bypass sitzt fest im Runner. G1 bleibt unberührt.
export const retroAutoQueue = new RetroAutoQueue({
  retroRunner: new HeadlessRetroRunner({ auditStore }),
  auditStore,
});
const autoRetroTrigger = new AutoRetroTrigger({
  readSettings: readRetroAutoSettings,
  queue: retroAutoQueue,
  auditStore, // AC6: secret-freier Enqueue-Audit (nur Repo-Slug)
});

const nightWatchScheduler = new NightWatchScheduler({
  readSettings: readTickerSettings,
  boardAggregator,
  projectDrain: nightProjectDrain,
  tokenLimitWatcher,
  sessionRegistry: ptyRegistry,
  auditStore,
  claudeAuthHealthService, // S-213 AC9: Auth-Vorabprüfung vor jedem Nacht-Tick
  costModeModelCheck, // cost-mode-model-check AC4/AC5: Dispatch-Frische-Prüfung vor jedem Nacht-Drain-Start
  drainReportStore, // drain-completion-report AC6: je Nacht-Drain genau ein Bericht (trigger:'night')
  autoRetroTrigger, // retro-auto-trigger AC4/AC6: nach jedem Nacht-Drain isRetroDue → ggf. enqueue
  drainNotifier, // drain-done-notification AC4/AC6: je Nacht-Drain best-effort GENAU EIN Push
  drainJobRegistry, // drain-restart-robustness AC3: je Nacht-Drain in der geteilten Registry geführt (trigger:'night')
});
// Immer gestartet — tick() selbst prüft `enabled` (AC16: enabled=false → idle,
// analog NotificationWatcher.start(), das ebenfalls unbedingt läuft).
nightWatchScheduler.start();

// ── Boot-Wiederanlauf verwaister Drains (drain-restart-robustness AC5–AC8, S-283) ──
// Konsumiert die von `drainJobRegistry.reconcileOrphans()` oben (BEIM Boot,
// vor der Konstruktion dieser Boundaries) zurückgegebenen, bereits als
// `aborted` markierten Einträge (AC4, S-282) — EINMALIG, HIER (nach
// manualProjectDrain/nightProjectDrain/nightWatchScheduler/drainJobRegistry).
// Je distinktem Projekt+Trigger GENAU EIN idempotenter Wiederanlauf-Drain:
// manuelle Orphans automatisch (args/costMode-Replay, AC6) über `projectDrain`
// (dieselbe DEDIZIERTE manuelle Instanz + `manualDrainLock` für die lesende
// isProjectBusy-Vorabprüfung); Nacht-Orphans NUR fenster-/nacht-modus-/
// auth-gated (AC7) über `nightProjectDrain`. Best-effort/degradierend (AC8) —
// `run()` wirft nie; NICHT awaited (fire-and-forget, blockiert den Boot nie).
const bootDrainRecovery = new BootDrainRecovery({
  drainJobRegistry,
  manualProjectDrain: projectDrain,
  nightProjectDrain,
  manualDrainLock,
  commandService,
  sessionRegistry: ptyRegistry,
  readSettings: readTickerSettings,
  claudeAuthHealthService,
  auditStore,
});
bootDrainRecovery.run(orphanedDrains).catch((err) => {
  console.error('[server] Boot-Drain-Wiederanlauf fehlgeschlagen:', err.message);
});

// ── BoardEventHub (board-live-sse AC1-AC7) ────────────────────────────────────
// In-process Pub/Sub für SSE-Invalidierungs-Events. Wird vom boardEventsRouter
// (GET /api/board/events) als dep injiziert. Der NotificationWatcher wird in
// Story 2 optional als Producer an diese Instanz ankoppelt (AC12: null-tolerant).
const boardEventHub = new BoardEventHub();

// ── NotificationWatcher (push-notifications S-184 AC6–AC9 + board-live-sse S-286 AC8–AC12) ────
// Hängt am Board-Scan-Ergebnis; check() wird periodisch aufgerufen.
// rescan-Router ruft notificationWatcher.check() nach boardAggregator.scan() auf
// (via deps — kein separates Polling, nutzt vorhandenen Scan).
// AC12: boardEventHub wird optional injiziert (null-tolerant degradation).
const notificationWatcher = new NotificationWatcher({
  boardAggregator,
  credentialStore,
  readNotificationSettings,
  boardEventHub, // AC12: Optional SSE-Producer
});

// ── RunStateWatcher (run-state-live-view AC4/AC5, S-316) ─────────────────────
// Eigener, von NotificationWatcher entkoppelter Producer: erkennt Änderungen an
// `board/runs/F-###/state.yaml` (Feature-Drain-Fortschritt) — unabhängig von
// Story-Status-Übergängen — und broadcastet je betroffenem Projekt genau EIN
// `{ slug }`-Invalidierungs-Signal über dieselbe BoardEventHub-Instanz (kein
// neuer Auth-/Transport-Weg, kein zweites Frame-Format).
const runStateWatcher = new RunStateWatcher({
  boardAggregator,
  boardEventHub,
});

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

// ── IdeaSpecifyChatService (zustandsloser Multi-Turn claude -p-Chat, idea-specify-chat AC5) ──
// Eigene, schmale Boundary (analog AssistService/KnowledgeSourceService) — TOOL-LOS,
// kein ProjectJobLock, belegt den PTY-Job-Lock NICHT. Session-Historie lebt in-memory
// in dieser einen Instanz (Map sessionId -> turns[], AC13).
const ideaSpecifyChatService = new IdeaSpecifyChatService();

// ── IdeaSpecifyFinalizer (headless requirement-Finalizer, idea-specify-chat AC6/AC7/AC8/AC9) ──
// Dünner Orchestrator um eine EIGENE `HeadlessFlowRunner`-Instanz mit EIGENER,
// frischer `ProjectJobLock`-Instanz (Konstruktor-Default in HeadlessFlowRunner.js)
// — bewusst getrennt von `headlessFlowRunner` (Nacht-Drain, oben) UND von
// `reconcileRunner` (unten): jede headless-Boundary hält ihre eigene Lock-
// Instanz, sonst würde ein laufender Nacht-Drain/Reconcile-Lauf für dasselbe
// Projekt einen parallelen Idee-Specify-Finalize-Lauf fälschlich blockieren
// (Selbstblockade-Vermeidung, analog dem Nacht-Drain-Kommentar oben).
// Nutzt die bereits vorhandene `boardWriter`-Instanz (S-191, oben) für das
// Sicherheitsnetz. `auditStore` injiziert (headless-arg-finalize-safety AC6) —
// genau EIN Audit-Eintrag, wenn das gehärtete Sicherheitsnetz einen Lauf als
// `no-op` erkennt (weder neues Artefakt noch Idee-Transformation).
const ideaSpecifyFinalizer = new IdeaSpecifyFinalizer({ boardWriter, auditStore });

// ── StorySpecifyFinalizer (headless requirement-Finalizer „from scratch", new-story-chat AC4/AC5/AC8) ──
// Schlanke Schwester-Boundary des IdeaSpecifyFinalizer für den Neue-Story-Chat:
// EIGENE `HeadlessFlowRunner`-Instanz mit EIGENER, frischer `ProjectJobLock`-
// Instanz (Konstruktor-Default in HeadlessFlowRunner.js) — bewusst getrennt von
// ALLEN anderen headless-Locks (Nacht-Drain, Reconcile, ideaSpecifyFinalizer),
// sonst würde ein paralleler Lauf für dasselbe Projekt fälschlich blockiert
// (Selbstblockade-Vermeidung, analog dem ideaSpecifyFinalizer-Kommentar oben).
// Unterschied zum ideaSpecifyFinalizer (new-story-chat AC8): „from scratch"-
// Prompt OHNE Idee-Übernahme-Hinweis + KEIN archiveSupersededIdea-Netz — daher
// KEIN boardWriter nötig. Kein Audit hier (der Router auditiert den Job-Start).
// Finalize-Sichtbarkeit (story-specify-finalize-visibility.md AC1-AC3): der
// Finalizer erkennt read-only per Snapshot-Diff einen „durchgelaufen, aber
// nichts angelegt"-Lauf (→ Terminalstatus `no-op`, KEIN BoardWriter) und hält
// eine projekt-keyed Last-Finalize-Registry (synchrone `running`-Registrierung
// vor dem Spawn) für den Read-Endpunkt `GET .../story-specify/finalize` (AC4).
const storySpecifyFinalizer = new StorySpecifyFinalizer();

// ── HeadlessReconcileRunner (getrennter claude -p-Kindprozess, headless-reconcile-runner AC1–AC7) ──
// Bewusst vom interaktiven PTY-Pfad (CommandService/PtyManager/PtySessionRegistry)
// getrennt (AC7) — eigene ProjectJobLock-Instanz, kein Idle-/Rate-Timer.
const reconcileRunner = new HeadlessReconcileRunner();

// ── ObsidianIngestRunner (headless from-notes-Katalog-Lauf mit Interrupt/Resume,
// docs/specs/obsidian-question-catalog.md AC1, AC2, AC4, AC5, AC6, AC7) ──
// EIGENE, isolierte ProjectJobLock-Instanz (Konstruktor-Default `new ProjectJobLock()`
// in ObsidianIngestRunner.js) — bewusst getrennt von ALLEN anderen headless-Locks
// (Nacht-Drain, manueller Drain, Reconcile, Finalizer, CostModeModelCheck,
// Auto-Retro), sonst würde ein paralleler Lauf für dasselbe Projekt fälschlich
// blockiert (Selbstblockade-Vermeidung, analog dem Nacht-Drain-Kommentar oben).
// KEIN neuer Runner-TYP im Sinne einer neuen Kindprozess-/Env-/Lock-Disziplin —
// wiederverwendet dieselben `HeadlessRunnerCore.js`-Primitive (buildChildEnv/
// isAuthError/AUTH_EXPIRED_MESSAGE, ProjectJobLock) wie `HeadlessFlowRunner`;
// NUR die state machine (Interrupt `needs-answers` + `--resume`-Fortsetzung via
// STDIN) ist neu, weil `HeadlessFlowRunner` (fire-and-forget bis `done`) dafür
// keine Naht bietet (docs/specs/obsidian-question-catalog.md §Nicht-Ziele).
// `auditStore` injiziert (AC6: Job-Ende/-Fehler, secret-frei). `notifier:
// drainNotifier` (questions-pending-notification AC1–AC5, S-279): GETEILTE
// Instanz mit derselben Config-/Token-/Versand-Boundary wie `drain_done`
// (bereits weiter oben, vor dem NightWatchScheduler, konstruiert) — best-effort
// GENAU EIN Push je Eintritt in `needs-answers`, kein zweiter Notifier-Codepfad.
const obsidianIngestRunner = new ObsidianIngestRunner({ auditStore, notifier: drainNotifier });

// ── RegressionDefineRunner (headless Regressionstest-Definier-Lauf mit
// Interrupt/Resume, docs/specs/regression-define-dialog.md AC1-AC5, S-307) ──
// EIGENE, isolierte ProjectJobLock-Instanz (Konstruktor-Default
// `new ProjectJobLock()` in RegressionDefineRunner.js) — bewusst getrennt von
// ALLEN anderen headless-Locks (Nacht-Drain, manueller Drain, Reconcile,
// Finalizer, CostModeModelCheck, Auto-Retro, ObsidianIngestRunner), sonst
// würde ein paralleler Lauf für dasselbe Projekt fälschlich blockiert
// (Selbstblockade-Vermeidung, analog dem ObsidianIngestRunner-Kommentar oben).
// KEIN neuer Runner-TYP — wiederverwendet dieselben `HeadlessRunnerCore.js`-
// Primitive (buildChildEnv/isAuthError/AUTH_EXPIRED_MESSAGE, ProjectJobLock);
// NUR die state machine (Interrupt `needs-review` + `--resume`-Fortsetzung via
// STDIN) ist analog `ObsidianIngestRunner` neu. `auditStore` injiziert (AC5:
// Job-Ende/-Fehler, secret-frei).
const regressionDefineRunner = new RegressionDefineRunner({ auditStore });

// ── Auto-Retro-Boundaries (retro-auto-queue S-256/S-257 + retro-auto-trigger
// S-261) sind bereits weiter oben (vor dem NightWatchScheduler, der den
// `autoRetroTrigger` für seine Drain-Abschluss-Naht AC4 braucht) konstruiert:
// `retroAutoQueue` (export) + `autoRetroTrigger`. Hier keine erneute Konstruktion.

// ── CostModeModelCheck starten (cost-mode-model-check AC1–AC3/AC6/AC7) ──
// Die Instanz wurde bereits weiter oben (im Taktgeber-Block, vor dem
// NightWatchScheduler — der sie für seine Dispatch-Frische-Prüfung AC4/AC5
// braucht) konstruiert; hier nur noch gestartet.
// Immer gestartet — Boot-Check fire-and-forget (blockiert den Boot nie, AC1) +
// periodische Kette; stiller Normalfall bei frischem Signal (AC2). stop() in
// shutdown() unten.
costModeModelCheck.start();

// claudeAuthHealthService-Instanz wurde bereits weiter oben (vor dem
// Taktgeber-Block, S-213 AC9) konstruiert — hier nur noch fire-and-forget
// gestartet (blockiert den Boot nie, Edge-Case "Probe-Fehler beim Boot"),
// stop() in shutdown() unten.
claudeAuthHealthService.start();

// ── KnowledgeSourceService (web-fähiger Quellen-Such-Helfer, team-knowledge-add AC11) ──
// Bewusste zweite headless-Ausnahme (Doktrin A1/A2): eigene Boundary,
// claude -p mit --allowedTools WebSearch exklusiv (A3), kein JobLock, auditiert (A6).
// AssistService bleibt tool-/netz-los (kein kind-Switch).
const knowledgeSourceService = new KnowledgeSourceService();

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
  // vps-ssh-terminal AC7/AC8/AC10 (S-262): Boundary-Instanz für die künftige
  // WS-Route (S-263) — hier NUR verdrahtet, kein Router mountet sie bislang.
  sshPtyManager,
  reconciliationJob,
  localDockerControl,
  tunnelHealService,
  stackRegistry,
  stackDeployOrchestrator,
  agentFlowReader,
  retroReader,
  boardAggregator,
  docsReader,
  storyMetricReader,
  repoSizeScanner,
  repoSizeStore,
  repoSizeRefreshLock,
  featureDrainRegistry,
  featureDrainRunner,
  featureDrainLock,
  assistService,
  knowledgeSourceService,
  // headless-reconcile-runner AC1-AC9: getrennter claude -p-Kindprozess-Runner
  // für POST /api/reconcile + GET /api/reconcile/:jobId (reconcile.js Router).
  reconcileRunner,
  // obsidian-question-catalog AC1/AC2/AC4-AC7: headless from-notes-Katalog-Runner
  // mit Interrupt(needs-answers)/Resume-Protokoll für POST .../obsidian-ingest/start
  // + GET .../obsidian-ingest/:jobId + POST .../obsidian-ingest/:jobId/answers
  // (obsidianIngest.js Router). credentialStore (oben) liest den konfigurierten
  // Vault-Pfad für die vault-confined Pfad-Auflösung (obsidian-vault-config AC5).
  obsidianIngestRunner,
  // regression-define-dialog AC1-AC5 (S-307): headless Regressionstest-Definier-
  // Runner mit Interrupt(needs-review)/Resume-Protokoll für
  // POST /api/projects/:slug/regression-define +
  // GET /api/projects/:slug/regression-define/:jobId +
  // POST /api/projects/:slug/regression-define/:jobId/review
  // (regressionDefine.js Router). Slug→Pfad-Auflösung analog projectDrainRouter.
  regressionDefineRunner,
  // regression-run AC1-AC3/AC5/AC9 (S-309): deterministischer `npx playwright
  // test`-Runner (KEIN claude/Agent, Grep-prüfbar) für
  // POST /api/projects/:slug/regression-run +
  // GET /api/projects/:slug/regression-run/:runId (regressionRun.js Router).
  // Busy-Check (AC2) nutzt dieselben commandService/sessionRegistry/
  // manualDrainLock-Instanzen wie projectDrain.js Router (bereits oben/unten
  // als deps-Top-Level-Keys vorhanden) — kein zweiter Wiring-Pfad.
  regressionRunner,
  // cost-mode-model-check AC7: CostModeModelCheck-Registry für den Status-
  // Endpunkt GET /api/cost-mode/check/:checkId (costModeCheck.js Router).
  costModeModelCheck,
  // claude-auth-health AC4: Zustand für GET /api/status (statusRouter, angegliedert
  // an die bestehende Route, kein dedizierter Endpunkt).
  claudeAuthHealthService,
  // S-183 AC1/AC2: NotificationSettingsStore als Config-Provider für notificationSettings-Router (AC5).
  // Ersetzt den Default-Provider (enabled=false/leer) — der Test-Endpunkt liest jetzt echte Settings.
  getNotificationConfig: readNotificationSettings,
  // S-184 AC6–AC9: NotificationWatcher für rescan-Router (nach explizitem Rescan sofort prüfen).
  notificationWatcher,
  // S-194 AC15/AC16: TickerSettingsStore-Reader als Konfig-Quelle für künftige Konsumenten
  // (S-195 NightWatchScheduler, S-192 Status-Widget) — analog readNotificationSettings.
  readTickerSettings,
  // S-195 AC9–AC11: NightWatchScheduler-Instanz für künftige Statusanzeige (S-197).
  nightWatchScheduler,
  // board-live-sse AC1-AC7 (S-285): BoardEventHub für GET /api/board/events (boardEventsRouter).
  // In-process Pub/Sub für SSE-Invalidierungs-Events (Slug-Signals). Der NotificationWatcher
  // wird in Story 2 optional als Producer verdrahtet (AC12: null-tolerant).
  boardEventHub,
  // headless-manual-drain AC1/AC2/AC3 (ADR-017): DEDIZIERTE headless ProjectDrain-
  // Instanz + ihre EIGENE Session-Lock-Instanz (manualDrainLock) + sessionRegistry
  // (Busy-Erkennung) für den manuellen „Board abarbeiten"-Knopf (projectDrainRouter).
  // manualDrainLock MUSS dieselbe Instanz sein, die projectDrain als Session-Lock
  // hält — sonst sieht der Router-Busy-Read den laufenden Drain nicht (AC2).
  projectDrain,
  manualDrainLock,
  // drain-completion-report AC4/AC5: geteilte DrainReportStore-Instanz —
  // read-only für GET /api/drain-reports (drainReports.js) UND Schreibpfad für
  // den manuellen Drain (projectDrain.js Router, trigger:'manual').
  drainReportStore,
  // deploy-bitwarden-gpg-injection F-072/S-331: 0600-Zugangs-Speicher für den
  // unbeaufsichtigten Bitwarden-Deploy-Zugang (Variante B). Vom Auto-Loader an
  // bitwardenDeployAccess.js (GET/PUT/DELETE /api/settings/deploy-access) gereicht.
  bitwardenDeployAccessStore,
  // deploy-bitwarden-gpg-injection F-072/S-332: unbeaufsichtigter Login-Dienst
  // (API-Key + Unlock, Item-Read). Vom Auto-Loader an bitwardenDeployAccess.js
  // (POST .../validate) und später an den Deploy-Guard (S-334) gereicht.
  bitwardenDeployLoginService,
  // per-app-gpg-passphrase-provisioning F-073/S-335: Kern-Provisionierungsdienst
  // (idempotente env.gpg-passphrase-<app>-Anlage). Vom Auto-Loader an
  // deployments.js (POST /api/deployments/:app/gpg-provision, AC10) gereicht.
  perAppGpgProvisioningService,
  // per-app-gpg-passphrase-rotation F-073/S-338: Zwei-Phasen-Rotations-Dienst
  // (Kandidat/Beweis-Runde → Umschalten → manuelle Entsorgung). Vom Auto-Loader
  // an deployments.js (POST /api/deployments/:app/gpg-rotate/*) gereicht.
  perAppGpgRotationService,
  // regression-result-store AC4 (S-312): RegressionResultStore für
  // GET /api/projects/:slug/regression-runs[/:runId] (regressionRuns.js Router).
  regressionResultStore,
  // retro-auto-trigger AC4–AC7: GETEILTE AutoRetroTrigger-Instanz (dieselbe wie
  // der Nacht-Drain oben) — der manuelle projectDrain.js Router stößt bei
  // Drain-Abschluss best-effort den Auto-Retro-Check an (isRetroDue → ggf.
  // enqueue in die geteilte retroAutoQueue). Kein zweiter Codepfad (AC6/AC7).
  autoRetroTrigger,
  // drain-done-notification AC3/AC6: GETEILTE DrainNotifier-Instanz (dieselbe wie
  // der Nacht-Drain oben) — der manuelle projectDrain.js Router stößt bei
  // Drain-Abschluss best-effort GENAU EINEN Drain-Fertig-Push an. Kein zweiter
  // Config-/Token-Pfad.
  drainNotifier,
  // drain-restart-robustness AC2/AC3/AC4 (S-282): GETEILTE DrainJobRegistry-
  // Instanz (dieselbe wie der Nacht-Drain oben) — der manuelle projectDrain.js
  // Router führt seine Job-Status-Einträge darüber statt einer eigenen,
  // router-internen Default-Instanz (kein zweiter Datei-Pfad; der Boot-Orphan-
  // Reconcile oben wirkt dadurch auf BEIDE Trigger).
  drainJobRegistry,
  sessionRegistry: ptyRegistry,
  // S-199 (ideen-inbox AC3/AC7/AC8): BoardWriter-Create-Pfad für den
  // Quick-Capture-Endpunkt (boardRouter POST .../ideas). Instanz existiert
  // bereits (S-191, oben) — hier zusätzlich für den Router-Auto-Loader verdrahtet.
  // S-200 (ideen-inbox AC5/AC6): boardWriter (Resolve-Pfad) sowie das oben
  // bereits vorhandene commandService/sessionRegistry (ptyRegistry) werden vom
  // Router-Auto-Loader zusätzlich an boardRouter (POST .../discuss, .../resolve)
  // durchgereicht — keine neue Instanz, keine zusätzliche server.js-Verdrahtung.
  boardWriter,
  // bereichs-modell AC3-AC7 (S-289): AreaWriter für die mutierenden Bereichs-
  // Endpunkte (boardRouter POST/PATCH/DELETE .../areas[...]) — einziger
  // Schreibpfad für board/areas.yaml, BoardAggregator bleibt read-only.
  areaWriter,
  // S-215 (idea-specify-chat AC3/AC4/AC5/AC13): IdeaSpecifyChatService für den
  // Multi-Turn-Chat-Router (ideaSpecify.js, POST .../specify/start + .../specify/message).
  ideaSpecifyChatService,
  // S-216 (idea-specify-chat AC6/AC7/AC8/AC9): IdeaSpecifyFinalizer für
  // POST .../specify/finalize + GET .../specify/finalize/:jobId (ideaSpecify.js).
  ideaSpecifyFinalizer,
  // S-226 (new-story-chat AC4/AC5/AC8) + S-239 (story-specify-finalize-visibility
  // AC1-AC4): StorySpecifyFinalizer für den Neue-Story-Chat „from scratch" —
  // POST .../story-specify/finalize + GET .../story-specify/finalize (projekt-keyed)
  // + GET .../story-specify/finalize/:jobId (storySpecify.js). Der Chat-Router
  // (storySpecify.js start/message) nutzt DIESELBE ideaSpecifyChatService-Instanz
  // (oben) — kein neuer Chat-Service (AC8).
  storySpecifyFinalizer,
};

// ── AC1/AC2: Auto-Discovery + Mount aller API-Router ─────────────────────────
// AccessGuard (oben) greift bereits; mountRouters() montiert alphabetisch-nach-order.
// Kein manuelles pro-Router import/app.use() nötig — neuer Endpunkt = neue Datei.
await mountRouters(app, deps);

// ── NotificationWatcher starten (S-184 AC6–AC9) ───────────────────────────────
// Muss NACH mountRouters() starten (Router sind gemountet; Board-Scan kann sofort laufen).
// Erster check() etabliert Baseline (AC7).
notificationWatcher.start();

// ── RunStateWatcher starten (run-state-live-view AC4/AC5, S-316) ─────────────
// Immer gestartet — der erste Check etabliert die Baseline ohne Broadcast (AC5).
runStateWatcher.start();

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

// ── WS /ws/vps-terminal (vps-ssh-terminal AC5/AC6/AC9, S-263) ────────────────
// Getrennte WebSocketServer-Instanz (eigener noServer-Server, kein geteilter
// Broadcast mit dem Claude-Terminal — jede WS = genau eine SSH-Sitzung, Isolation
// von PtyManager/WsGateway laut Spec-NFR). Rollenschutz (CRED_ADMIN_EMAILS,
// checkVpsTerminalAuthz) läuft im Upgrade-Interceptor VOR dem Handshake
// (postAuthCheck) — eine unautorisierte Verbindung erreicht die Gateway-Ebene nie.
const wssVpsTerminal = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
new VpsTerminalGateway(wssVpsTerminal, sshPtyManager, { auditStore });

const wsVpsTerminalGuard = createWsAccessGuard(wssVpsTerminal, {
  postAuthCheck: (req) => checkVpsTerminalAuthz(req.identity).allowed,
});

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
  } else if (pathname === '/ws/vps-terminal') {
    wsVpsTerminalGuard(req, socket, head);
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

/**
 * Vereinigte Reconcile-Konfiguration: dynamische Target-Records ⊕ Env (S-167 AC6).
 *
 * Basis ist die Env-Konfiguration (RECONCILE_TUNNEL_IDS — Env gewinnt bei Kollision).
 * Zusätzlich werden persistierte Target-Records aus der VpsProviderRegistry einbezogen,
 * sofern sie eine tunnelId tragen und noch nicht durch die Env abgedeckt sind.
 *
 * Degradierend: Fehler beim Laden der dynamischen Records → nur Env-Konfiguration.
 * Kein neuer RECONCILE_TUNNEL_IDS-Env-Eintrag nötig für dynamische VPS (AC6).
 *
 * @param {Map<string, object>} targets - Env-vpsTargets (VPS_TARGETS)
 * @param {string|undefined} envValue   - RECONCILE_TUNNEL_IDS-Env-String
 * @param {import('./src/vps/VpsProviderRegistry.js').VpsProviderRegistry} [registry]
 * @returns {Promise<Array<{ vpsId: string, vps: object, tunnelId: string }>>}
 */
async function buildReconcileVpsConfigsDynamic(targets, envValue, registry) {
  // Env-Konfiguration als Basis (Env gewinnt bei Kollision)
  const envConfigs = buildReconcileVpsConfigs(targets, envValue);
  const envVpsIds = new Set(envConfigs.map((c) => c.vpsId));

  // Dynamische Target-Records einbeziehen (S-167 AC6)
  const dynamicConfigs = [];
  if (registry && typeof registry.listTargetRecords === 'function') {
    try {
      const records = await registry.listTargetRecords();
      for (const record of records) {
        const vpsId = record._vpsId;
        // Nur einbeziehen wenn: nicht bereits durch Env abgedeckt, tunnelId vorhanden
        if (!vpsId || envVpsIds.has(vpsId) || !record.tunnelId) continue;
        // VPS-Ziel aus dem Record aufbauen (security: kein Key/Token)
        const vps = {
          host: record.host ?? null,
          port: record.port ?? 22,
          targetUser: record.targetUser ?? 'root',
        };
        dynamicConfigs.push({ vpsId, vps, tunnelId: record.tunnelId });
      }
    } catch (err) {
      // Degradierend: Fehler beim Laden → nur Env-Konfiguration nutzen
      // Security: err.message darf kein Token enthalten (VpsProviderRegistry-Floor)
      const safeMsg = String(err?.message ?? '').slice(0, 200);
      console.warn('[buildReconcileVpsConfigsDynamic] Dynamische Datensätze konnten nicht geladen werden (best-effort):', safeMsg);
    }
  }

  return [...envConfigs, ...dynamicConfigs];
}

// Graceful shutdown
function shutdown() {
  reconciliationJob.stopScheduler();
  nightWatchScheduler.stop();
  costModeModelCheck.stop();
  claudeAuthHealthService.stop();
  boardAggregator.stopWatchers();
  notificationWatcher.stop();
  runStateWatcher.stop();
  boardEventHub.shutdown();
  ptyRegistry.destroy(); // destroy all sessions (global + project sessions)
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
