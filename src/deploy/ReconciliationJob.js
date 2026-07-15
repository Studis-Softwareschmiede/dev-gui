/**
 * ReconciliationJob — beidseitig selbst-heilender Container ↔ Route-Abgleich (ADR-013, Capability C).
 *
 * Architecture boundary: the ONLY place that orchestrates container↔route reconciliation.
 * Does NOT duplicate CloudflareApi mutation code — healing goes through the existing
 * DeployOrchestrator atomic route-add path (ADR-012, Schritt c only; no docker pull/run).
 *
 * Design:
 *   - Scheduler: node-internal midnight timer (UTC) in the always-on dev-gui process (ADR-002).
 *     No external cron, no new dependency. Skip-if-running lock prevents overlapping runs.
 *   - Per-VPS reconciliation:
 *     0. [vps-tunnel-drift-notify] Tunnel-Existenz-Check (AC1): wenn tunnelId gesetzt und
 *        nicht in listTunnels() → VPS als tunnel-missing markieren; fail-closed für Route-
 *        Konvergenz; ntfy-Push best-effort beim Übergang (AC3/AC4/AC5/AC6/AC7/AC8).
 *     1. VpsDockerControl.psAll() → managed containers (with cloudflare.tunnel-hostname label,
 *        laufend UND gestoppt, `docker ps -a`, v3 Datenverlust-Fix) and unmanaged containers
 *        (without the label, only reported). Managed-Prädikat: `hostname !== null`,
 *        unabhängig vom `state`. Laufend-Prädikat: `state === 'running'`.
 *        Stack-aware (AC13): psAll() also returns com.docker.compose.project label; internal
 *        stack containers (no cloudflare.tunnel-hostname) get hostname: null → reportedUnmanaged.
 *     2. CloudflareApi.listRoutes(tunnelId) → current routes.
 *     3. Orphaned routes (AC3/AC3b) — a route is orphaned only if NO managed container
 *        (running OR stopped) exists for that hostname AND it is not protected → remove via
 *        CloudflareApi (Audit-First). A stopped managed container protects its route just like
 *        a running one (v3 — stop is not undeploy).
 *     4. Managed containers without route: only a RUNNING managed container is healed
 *        (AC5, not protected) via DeployOrchestrator addRouteOnly() (Audit-First; shared path,
 *        no new Cloudflare mutation code here). A hostname with ONLY stopped managed
 *        containers and no route is NEVER healed (AC5d) — recorded as `stoppedSkipped`
 *        instead (conservative: "schützen ja, anlegen nein").
 *   - Ambiguity (AC7/AC7b) is decided by the count of RUNNING managed containers per hostname,
 *     not by the count of all (running+stopped) entries: exactly one running (+ any number of
 *     stopped zombies) is NOT ambiguous — the running one is authoritative, heal/protect proceed
 *     normally; two or more running containers on the same hostname → ambiguous, not healed.
 *     Stopped zombie containers are only reported, never auto-removed by the cron.
 *   - Stack-aware (AC13): public stack containers (with cloudflare.tunnel-hostname) are reconciled
 *     like single-image containers. Internal stack containers (without cloudflare.tunnel-hostname)
 *     always have hostname: null → they land in reportedUnmanaged, never routed, never orphaned.
 *     Multiple public hostnames per stack are each handled individually (one per container entry).
 *   - Fail-closed: if psAll() fails → skip that VPS entirely (neither delete nor heal).
 *   - Degradation per VPS/provider: errors don't abort the overall run.
 *   - ReconcileReport + ReconcileNotice: persisted via AuditStore (kein neuer Store, ADR-005-Linie).
 *
 * Tunnel-Drift-Push (vps-tunnel-drift-notify, Capability C):
 *   - Tunnel-Drift erkannt → ReconcileNotice kind=tunnel-missing (AC3) + optionaler ntfy-Push (AC4).
 *   - Push nur beim Übergang (AC6): Übergangszustand wird in einem Snapshot-File
 *     (${CRED_STORE_DIR}/tunnel-drift-snapshot.json) gespeichert → kein Re-Fire nach Neustart.
 *   - Best-effort: ntfy-Fehler bricht den Reconcile nicht ab (AC5).
 *   - Sicherheit: kein Tunnel-Token, kein SSH-Key, kein CF-API-Token in Push/Notice/Log (AC8).
 *
 * Security (Floor):
 *   - LockoutGuard-Hard-Block: protected hostnames are never deleted or healed (automatic via
 *     DeployOrchestrator reuse for heal; explicit guard for delete).
 *   - Audit-First for both delete and heal paths.
 *   - No secrets (SSH key, CF token) in Report, Notice, log, or any external channel.
 *
 * AC1  — node-internal scheduler, midnight UTC, no external cron/service.
 * AC2  — same reconcile() method invoked by cron and manual trigger; produces ReconcileReport.
 * AC3  — orphaned (no managed container, running or stopped, non-protected) routes → removed; idempotent.
 * AC3b — (v3, Datenverlust-Fix) stopped managed container + route → no-op, route/CNAME survive.
 * AC4  — protected routes never deleted.
 * AC5  — running managed container without route → healed via DeployOrchestrator addRouteOnly path.
 * AC5b — protected hostname on managed container → protectedSkipped, not healed.
 * AC5c — unmanaged container → only reportedUnmanaged, never healed.
 * AC5d — (v3) stopped managed container without route → never healed, `stoppedSkipped`.
 * AC6  — VPS/provider failures degrade, don't abort.
 * AC7  — psAll() failure → fail-closed; ambiguous binding (2+ running same hostname) → ambiguous, not healed.
 * AC7b — (v3) exactly one running + N stopped zombies on same hostname → not ambiguous, heal/protect
 *         proceed normally; zombies only reported, never auto-removed.
 * AC8  — ReconcileReport per run (incl. `stoppedSkipped[]`, additive); GET endpoints; Audit-First.
 * AC8b — ReconcileNotice per action; GET endpoint.
 * AC9  — LockoutGuard-Hard-Block + Audit-First via shared ADR-012 path.
 * AC13 — stack-aware: public stack containers (cloudflare.tunnel-hostname set) healed/deleted
 *         like single-image containers; internal stack containers (no cloudflare.tunnel-hostname)
 *         never routed, never orphaned (hostname: null → reportedUnmanaged); multiple public
 *         hostnames per stack each handled individually.
 * AC14 — all existing ADR-013 behaviors (AC3–AC9) remain unchanged; healing path remains the
 *         shared ADR-012 addRouteOnly path (no new Cloudflare mutation code, grep-verifiable).
 *
 * vps-tunnel-drift-notify:
 * AC1  — [drift] Tunnel-Existenz-Check je VPS via listTunnels (tunnelMissing-Prädikat).
 * AC2  — [drift] Tunnel-Drift → fail-closed für Route-Konvergenz dieses VPS; kein createTunnel.
 * AC3  — [drift] tunnelMissing:true im ReconcileReport; kind:tunnel-missing in ReconcileNotice.
 * AC4  — [drift] ntfy-Push via NotifyService.sendNotification wenn aktiviert + tunnel_missing-Event.
 * AC5  — [drift] Push best-effort; ntfy-Fehler bricht Reconcile nicht ab.
 * AC6  — [drift] Push nur beim Übergang; Snapshot-File verhindert Re-Fire nach Neustart.
 * AC7  — [drift] tunnel_missing in ALLOWED_EVENTS (NotificationSettingsStore), PUT-Validierung.
 * AC8  — [drift] Kein Tunnel-Token, SSH-Key, CF-Token in Push/Notice/Log (Security Floor).
 *
 * @module deploy/ReconciliationJob
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { catalogKey } from '../CredentialStore.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** AuditStore command prefix for reconcile actions. */
const AUDIT_PREFIX = 'reconcile';

/** AuditStore command for a ReconcileReport entry. */
const AUDIT_REPORT = 'reconcile:report';

/** AuditStore command for a ReconcileNotice entry. */
const AUDIT_NOTICE = 'reconcile:notice';

/**
 * Tunnel-Drift-Snapshot: Datei im CRED_STORE_DIR, die merkt welche VPSes bereits als
 * tunnel-missing gemeldet wurden → verhindert Re-Fire nach Neustart (AC6 vps-tunnel-drift-notify).
 *
 * Format: { tunnelMissing: { [vpsId]: true } }
 */
const TUNNEL_DRIFT_SNAPSHOT_FILE = 'tunnel-drift-snapshot.json';

/** Notification event key for tunnel missing drift (AC7 vps-tunnel-drift-notify). */
const EVENT_TUNNEL_MISSING = 'tunnel_missing';

// ── Tunnel-Drift-Snapshot Helpers ─────────────────────────────────────────────

/**
 * Liest den Pfad zur Tunnel-Drift-Snapshot-Datei aus der Umgebung.
 * @returns {string|null}
 */
function resolveTunnelDriftSnapshotPath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, TUNNEL_DRIFT_SNAPSHOT_FILE);
}

/**
 * Liest den persistierten Tunnel-Drift-Snapshot.
 * @returns {Promise<{ tunnelMissing: Record<string, boolean> }>}
 */
async function readTunnelDriftSnapshot() {
  const filePath = resolveTunnelDriftSnapshotPath();
  const empty = { tunnelMissing: {} };
  if (!filePath) return empty;

  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      tunnelMissing: (parsed.tunnelMissing && typeof parsed.tunnelMissing === 'object')
        ? parsed.tunnelMissing
        : {},
    };
  } catch {
    return empty;
  }
}

/**
 * Schreibt den Tunnel-Drift-Snapshot atomar.
 * @param {{ tunnelMissing: Record<string, boolean> }} snapshot
 */
async function writeTunnelDriftSnapshot(snapshot) {
  const filePath = resolveTunnelDriftSnapshotPath();
  if (!filePath) return;

  const json = JSON.stringify(snapshot, null, 2);
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');

  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, filePath);
  } catch {
    await unlink(tmpPath).catch(() => {});
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ReconcileReport
 * @property {string} ranAt             - ISO-8601 timestamp
 * @property {'cron'|'manual'} trigger
 * @property {VpsReconcileResult[]} perVps
 */

/**
 * @typedef {object} VpsReconcileResult
 * @property {string} vps
 * @property {string} [provider]
 * @property {number} checkedContainers - zählt laufende UND gestoppte managed Container (v3, AC8)
 * @property {string[]} createdRoutes
 * @property {string[]} removedRoutes
 * @property {string[]} protectedSkipped
 * @property {string[]} stoppedSkipped - (v3, additiv) Hostnames gestoppter managed Container ohne
 *   Route, deren Heilung übersprungen wurde (AC5d)
 * @property {string[]} reportedUnmanaged
 * @property {Array<{ scope: string, errorClass: string }>} errors
 * @property {boolean} [tunnelMissing] - true wenn der Cloudflare-Tunnel dieses VPS fehlt (vps-tunnel-drift-notify AC3)
 */

/**
 * @typedef {object} ReconcileNotice
 * @property {string} at
 * @property {'route-created'|'route-removed'|'protected-skipped'|'error'|'tunnel-missing'} kind
 * @property {string} vps
 * @property {string} [hostname]
 * @property {string} [detail]
 */

// ── ReconciliationJob ─────────────────────────────────────────────────────────

export class ReconciliationJob {
  /** @type {import('./VpsDockerControl.js').VpsDockerControl} */
  #dockerControl;

  /** @type {import('../cloudflare/CloudflareApi.js').CloudflareApi} */
  #cloudflareApi;

  /** @type {import('../cloudflare/LockoutGuard.js').LockoutGuard} */
  #lockoutGuard;

  /** @type {import('./DeployOrchestrator.js').DeployOrchestrator} */
  #orchestrator;

  /** @type {import('../AuditStore.js').AuditStore} */
  #auditStore;

  /**
   * Array of VPS configurations to reconcile.
   * Each entry: { vpsId: string, vps: VpsTarget, tunnelId: string }
   */
  #vpsConfigs;

  /** Skip-if-running lock (AC spec: skip-if-running). */
  #running = false;

  /** Scheduled midnight timer handle. */
  #timer = null;

  // ── Tunnel-Drift-Push deps (vps-tunnel-drift-notify, optional — best-effort) ──

  /**
   * sendNotification function (injectable for tests).
   * @type {import('../NotifyService.js').sendNotification|null}
   */
  #sendNotificationFn;

  /**
   * Reads current NotificationSettings (enabled, events, server, topic, priority).
   * @type {(() => Promise<import('../NotificationSettingsStore.js').NotificationSettings>)|null}
   */
  #readNotificationSettings;

  /**
   * CredentialStore for reading ntfy_token (optional; no token → push without auth).
   * @type {import('../CredentialStore.js').CredentialStore|null}
   */
  #credentialStore;

  /**
   * In-memory set of vpsIds currently in tunnel-missing drift state.
   * Populated from disk-snapshot on first use; tracks transition to avoid push-spam (AC6).
   * null = not yet loaded from disk.
   * @type {Set<string>|null}
   */
  #knownDriftVps = null;

  /**
   * @param {object} opts
   * @param {import('./VpsDockerControl.js').VpsDockerControl} opts.dockerControl
   * @param {import('../cloudflare/CloudflareApi.js').CloudflareApi} opts.cloudflareApi
   * @param {import('../cloudflare/LockoutGuard.js').LockoutGuard} opts.lockoutGuard
   * @param {import('./DeployOrchestrator.js').DeployOrchestrator} opts.orchestrator
   * @param {import('../AuditStore.js').AuditStore} opts.auditStore
   * @param {Array<{ vpsId: string, vps: object, tunnelId: string }>} opts.vpsConfigs
   * @param {import('../NotifyService.js').sendNotification} [opts.sendNotificationFn]
   *   Injectable ntfy-Versand-Funktion (default: NotifyService.sendNotification). Optional.
   * @param {() => Promise<import('../NotificationSettingsStore.js').NotificationSettings>} [opts.readNotificationSettings]
   *   Liest aktuelle Notification-Settings. Optional — ohne diese Dep kein ntfy-Push.
   * @param {import('../CredentialStore.js').CredentialStore} [opts.credentialStore]
   *   CredentialStore für ntfy_token. Optional.
   */
  constructor({
    dockerControl,
    cloudflareApi,
    lockoutGuard,
    orchestrator,
    auditStore,
    vpsConfigs,
    sendNotificationFn,
    readNotificationSettings,
    credentialStore,
  }) {
    if (!dockerControl || typeof dockerControl.psAll !== 'function') {
      throw new Error('[ReconciliationJob] dockerControl with psAll() ist Pflicht');
    }
    if (!cloudflareApi || typeof cloudflareApi.listRoutes !== 'function') {
      throw new Error('[ReconciliationJob] cloudflareApi mit listRoutes() ist Pflicht');
    }
    if (!lockoutGuard || typeof lockoutGuard.isProtected !== 'function') {
      throw new Error('[ReconciliationJob] lockoutGuard ist Pflicht');
    }
    if (!orchestrator || typeof orchestrator.addRouteOnly !== 'function') {
      throw new Error('[ReconciliationJob] orchestrator mit addRouteOnly() ist Pflicht');
    }
    if (!auditStore || typeof auditStore.record !== 'function') {
      throw new Error('[ReconciliationJob] auditStore ist Pflicht');
    }
    this.#dockerControl = dockerControl;
    this.#cloudflareApi = cloudflareApi;
    this.#lockoutGuard = lockoutGuard;
    this.#orchestrator = orchestrator;
    this.#auditStore = auditStore;
    this.#vpsConfigs = Array.isArray(vpsConfigs) ? vpsConfigs : [];

    // Optional Tunnel-Drift-Push deps (best-effort; fehlt → kein ntfy-Push, kein Crash)
    this.#sendNotificationFn = sendNotificationFn ?? null;
    this.#readNotificationSettings = readNotificationSettings ?? null;
    this.#credentialStore = credentialStore ?? null;
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────

  /**
   * Start the midnight scheduler (AC1 — node-internal timer, no external cron).
   * Timezone: UTC. Fires daily at 00:00 UTC.
   * Safe to call multiple times — only the last timer is kept.
   */
  startScheduler() {
    this.#scheduleNextMidnight();
  }

  /**
   * Stop the scheduler (for graceful shutdown).
   */
  stopScheduler() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Schedule the next midnight UTC tick.
   * Uses a single setTimeout chain (no setInterval, no drift accumulation).
   * Timezone is explicitly UTC (AC1 spec: "Zeitzone explizit dokumentiert").
   */
  #scheduleNextMidnight() {
    const now = new Date();
    // Next midnight UTC
    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0,
    ));
    const msUntilMidnight = next.getTime() - now.getTime();

    this.#timer = setTimeout(async () => {
      try {
        await this.reconcile('cron');
      } catch {
        // Error absorbed — cron must not crash the process
      }
      // Schedule next midnight after each tick
      this.#scheduleNextMidnight();
    }, msUntilMidnight);

    // Allow process to exit even if scheduler is running (unref the timer)
    if (this.#timer.unref) {
      this.#timer.unref();
    }
  }

  // ── Main reconcile ─────────────────────────────────────────────────────────

  /**
   * Run the full reconciliation across all configured VPS.
   *
   * Skip-if-running: if already running, returns null.
   * Produces exactly one ReconcileReport (AC8).
   *
   * @param {'cron'|'manual'} trigger
   * @returns {Promise<ReconcileReport|null>} null if skipped (already running)
   */
  async reconcile(trigger = 'manual') {
    // Skip-if-running (AC spec edge-case)
    if (this.#running) {
      return null;
    }
    this.#running = true;

    const ranAt = new Date().toISOString();
    const perVps = [];

    try {
      for (const config of this.#vpsConfigs) {
        const vpsResult = await this.#reconcileVps(config);
        perVps.push(vpsResult);
      }
    } finally {
      this.#running = false;
    }

    /** @type {ReconcileReport} */
    const report = { ranAt, trigger, perVps };

    // Persist report via AuditStore (AC8 — no new store; ADR-005-line)
    try {
      this.#auditStore.record({
        identity: null,
        command: `${AUDIT_REPORT}:${JSON.stringify(sanitizeReport(report))}`,
      });
    } catch {
      // Best-effort — report persistence failure must not abort the run
    }

    return report;
  }

  // ── Per-VPS reconciliation ─────────────────────────────────────────────────

  /**
   * Reconcile a single VPS: psAll() + listRoutes() → diff → heal/delete.
   *
   * @param {{ vpsId: string, vps: object, tunnelId: string }} config
   * @returns {Promise<VpsReconcileResult>}
   */
  async #reconcileVps({ vpsId, vps, tunnelId }) {
    const result = {
      vps: vpsId,
      checkedContainers: 0,
      createdRoutes: [],
      removedRoutes: [],
      protectedSkipped: [],
      stoppedSkipped: [],
      reportedUnmanaged: [],
      errors: [],
    };

    // ── Step 0: Tunnel-Existenz-Check (vps-tunnel-drift-notify AC1/AC2) ───────
    // Nur wenn eine tunnelId gespeichert ist. Kein Tunnel registriert → kein Drift-Check.
    // Cloudflare-Fehler → VPS degradierend (nicht als tunnel-missing melden; kein Fehlalarm, AC spec Edge-Cases).
    if (tunnelId) {
      const driftResult = await this.#checkTunnelDrift(vpsId, tunnelId);
      if (driftResult === 'missing') {
        // Tunnel fehlt → fail-closed für Route-Konvergenz (AC2); kein createTunnel; kein psAll
        result.tunnelMissing = true;
        result.errors.push({
          scope: `vps:${vpsId}:tunnel:${tunnelId}`,
          errorClass: 'tunnel-missing',
        });
        // ReconcileNotice (AC3 vps-tunnel-drift-notify)
        this.#persistNotice({
          kind: 'tunnel-missing',
          vps: vpsId,
          detail: sanitizeString(tunnelId),
        });
        // ntfy-Push best-effort, nur beim Übergang (AC4/AC5/AC6 vps-tunnel-drift-notify)
        // Transition-Management erfolgt in #sendTunnelDriftPush
        await this.#sendTunnelDriftPushIfTransition(vpsId);
        // Fail-closed: keine Route-Konvergenz für diesen VPS (AC2)
        return result;
      } else if (driftResult === 'cf-error') {
        // Cloudflare nicht konsultierbar → degradierend; kein Fehlalarm-Push (AC spec Edge-Cases)
        result.errors.push({
          scope: `vps:${vpsId}:tunnel-check:${tunnelId}`,
          errorClass: 'cloudflare-unavailable',
        });
        // Kein fail-closed auf Basis eines unprüfbaren Zustands — Route-Konvergenz läuft normal weiter
        // (Der Tunnel-Check-Fehler ist bereits im errors[]-Array vermerkt)
      } else if (driftResult === 'ok') {
        // Tunnel existiert → Drift aufgelöst: Snapshot aktualisieren wenn vorher als missing bekannt
        await this.#resolveTunnelDrift(vpsId);
      }
      // driftResult === 'no-tunnel-id': kein tunnelId → nicht möglich (Guard oben)
    }

    // ── Step 1: Read container state (fail-closed on error, AC7) ──────────────
    // psAll() returns managed (hostname set) AND unmanaged (hostname: null) containers.
    // Unmanaged containers are only reported (AC5c), never healed or removed.
    let psResult;
    try {
      psResult = await this.#dockerControl.psAll(vps);
    } catch (err) {
      result.errors.push({
        scope: `vps:${vpsId}:ps`,
        errorClass: err?.errorClass ?? 'error',
      });
      // Fail-closed: do not proceed with this VPS (AC7)
      return result;
    }

    if (!psResult || psResult.result !== 'ok') {
      result.errors.push({
        scope: `vps:${vpsId}:ps`,
        errorClass: psResult?.errorClass ?? 'error',
      });
      // Fail-closed: ps() failed — neither delete nor heal (AC7)
      return result;
    }

    const allContainers = psResult.containers ?? [];

    // Separate managed (hostname set via label) from unmanaged (hostname: null, AC5c)
    const managedContainers = allContainers.filter((c) => c.hostname !== null && c.hostname !== '');
    const unmanagedContainers = allContainers.filter((c) => c.hostname === null || c.hostname === '');

    // AC5c: report unmanaged containers — never heal, never rm
    for (const c of unmanagedContainers) {
      result.reportedUnmanaged.push(sanitizeString(`${c.containerId}:${c.image}:${c.status}`));
    }

    // checkedContainers counts ALL managed containers — running AND stopped (v3, AC8)
    result.checkedContainers = managedContainers.length;

    // Group ALL managed containers (running + stopped) by hostname — used for AC3/AC3b
    // (a stopped managed container still protects its route) and for picking the
    // representative container to report/heal.
    const hostnameToContainers = new Map();
    for (const c of managedContainers) {
      if (!hostnameToContainers.has(c.hostname)) {
        hostnameToContainers.set(c.hostname, []);
      }
      hostnameToContainers.get(c.hostname).push(c);
    }

    // Group only RUNNING managed containers by hostname — AC7b: ambiguity and healing are
    // decided by the RUNNING count, not by the total (running+stopped) count. This prevents
    // v3's `docker ps -a` read from turning a previously-invisible stopped zombie container
    // into a false "ambiguous" verdict that would block healing/protection forever.
    const hostnameToRunning = new Map();
    for (const c of managedContainers) {
      if (c.state !== 'running') continue;
      if (!hostnameToRunning.has(c.hostname)) {
        hostnameToRunning.set(c.hostname, []);
      }
      hostnameToRunning.get(c.hostname).push(c);
    }

    // AC7/AC7b: ambiguous only when TWO OR MORE running containers share the same hostname.
    const ambiguousHostnames = new Set();
    for (const [hostname, runningContainers] of hostnameToRunning) {
      if (runningContainers.length > 1) {
        ambiguousHostnames.add(hostname);
        result.errors.push({
          scope: `vps:${vpsId}:hostname:${hostname}:ambiguous`,
          errorClass: 'ambiguous',
        });
      }
    }

    // ── Step 2: Read route state (degrading on error, AC6) ────────────────────
    let routes;
    try {
      routes = await this.#cloudflareApi.listRoutes(tunnelId);
    } catch (err) {
      result.errors.push({
        scope: `vps:${vpsId}:cloudflare:${tunnelId}`,
        errorClass: err?.errorClass ?? 'cloudflare-unavailable',
      });
      // Degraded: cannot diff → skip this VPS (fail-closed variant for Cloudflare error)
      return result;
    }

    // Build sets for diffing
    const managedHostnames = new Set(managedContainers.map((c) => c.hostname));
    const routeHostnames = new Set(routes.map((r) => r.hostname));

    // ── Step 3: Orphaned routes (AC3/AC4) ────────────────────────────────────
    // Route without matching managed container AND not protected → remove
    for (const route of routes) {
      const { hostname } = route;

      // AC4: never delete protected routes
      if (this.#lockoutGuard.isProtected(hostname)) {
        continue;
      }

      if (!managedHostnames.has(hostname)) {
        // Orphaned non-protected route → remove
        await this.#removeOrphanedRoute(vpsId, tunnelId, hostname, result);
      }
    }

    // ── Step 4: Managed containers without routes (AC5/AC5b/AC5c/AC5d/AC7b) ────
    for (const [hostname] of hostnameToContainers) {
      // AC7/AC7b: skip ambiguous bindings (2+ RUNNING containers on same hostname)
      if (ambiguousHostnames.has(hostname)) {
        continue;
      }

      // Route already exists → no-op for this hostname (covers AC3b: a stopped managed
      // container with a route is left untouched — handled by Step 3 above; nothing to do here).
      if (routeHostnames.has(hostname)) {
        continue;
      }

      const runningContainers = hostnameToRunning.get(hostname) ?? [];
      if (runningContainers.length === 1) {
        // AC5/AC7b: exactly one running managed container (any number of stopped zombies
        // alongside it) without a route → heal via the running container.
        await this.#healMissingRoute(vpsId, vps, tunnelId, hostname, runningContainers[0], result);
      } else {
        // AC5d: no running managed container for this hostname (only stopped ones) and no
        // route → conservative, never healed. Recorded as stoppedSkipped, not an error.
        result.stoppedSkipped.push(hostname);
      }
    }

    return result;
  }

  // ── Orphaned route removal ─────────────────────────────────────────────────

  /**
   * Remove an orphaned (non-protected) route.
   * Audit-First before any mutation (AC9/AC8).
   *
   * @param {string} vpsId
   * @param {string} tunnelId
   * @param {string} hostname
   * @param {VpsReconcileResult} result
   */
  async #removeOrphanedRoute(vpsId, tunnelId, hostname, result) {
    // Audit-First (AC9)
    const auditCmd = `${AUDIT_PREFIX}:route-removed:${vpsId}:${hostname}`;
    try {
      this.#auditStore.record({ identity: null, command: auditCmd });
    } catch {
      result.errors.push({
        scope: `vps:${vpsId}:audit:${hostname}`,
        errorClass: 'audit-failed',
      });
      return; // Audit-First: if audit fails, skip mutation
    }

    try {
      await this.#cloudflareApi.removeRoute(tunnelId, hostname);
      result.removedRoutes.push(hostname);

      // CNAME mit-aufräumen (best-effort, analog undeploy): eine verwaiste Route hinterlässt
      // sonst einen verwaisten DNS-CNAME, der spätere Re-Deploys desselben Hostnamen als
      // Duplikat blockiert. Route ist bereits entfernt — ein DNS-Fehler darf den Reconcile
      // nicht abbrechen.
      try {
        const zoneId = await this.#cloudflareApi.resolveZoneForHostname(hostname);
        if (zoneId) {
          await this.#cloudflareApi.deleteDnsRecord(zoneId, hostname);
        }
      } catch {
        // best-effort — verwaister CNAME wird beim nächsten idempotenten Anlegen ohnehin überschrieben
      }

      // ReconcileNotice (AC8b)
      this.#persistNotice({
        kind: 'route-removed',
        vps: vpsId,
        hostname,
      });
    } catch (err) {
      if (err?.errorClass === 'protected-resource') {
        // LockoutGuard caught it at CloudflareApi level — treat as protected-skipped
        result.protectedSkipped.push(hostname);
        this.#persistNotice({ kind: 'protected-skipped', vps: vpsId, hostname });
      } else {
        result.errors.push({
          scope: `vps:${vpsId}:removeRoute:${hostname}`,
          errorClass: err?.errorClass ?? 'error',
        });
        this.#persistNotice({
          kind: 'error',
          vps: vpsId,
          hostname,
          detail: err?.errorClass ?? 'error',
        });
      }
    }
  }

  // ── Missing route healing ─────────────────────────────────────────────────

  /**
   * Heal a managed container without a route.
   * Routes through DeployOrchestrator.addRouteOnly() — the shared ADR-012 path.
   * No new CloudflareApi mutation code here (AC5, Grep-verifiable).
   *
   * @param {string} vpsId
   * @param {object} vps
   * @param {string} tunnelId
   * @param {string} hostname
   * @param {object} container
   * @param {VpsReconcileResult} result
   */
  async #healMissingRoute(vpsId, vps, tunnelId, hostname, container, result) {
    // AC5b: protected hostname → skip
    if (this.#lockoutGuard.isProtected(hostname)) {
      result.protectedSkipped.push(hostname);
      this.#persistNotice({ kind: 'protected-skipped', vps: vpsId, hostname });
      return;
    }

    // Audit-First (AC9)
    const auditCmd = `${AUDIT_PREFIX}:route-created:${vpsId}:${hostname}`;
    try {
      this.#auditStore.record({ identity: null, command: auditCmd });
    } catch {
      result.errors.push({
        scope: `vps:${vpsId}:audit:${hostname}`,
        errorClass: 'audit-failed',
      });
      return; // Audit-First: skip if audit fails
    }

    try {
      // AC5: Use the shared ADR-012 route-add path — no docker pull/run, route only
      const addResult = await this.#orchestrator.addRouteOnly({
        vps,
        tunnelId,
        hostname,
        hostPort: container.hostPort ?? 8080,
      });

      if (addResult.result === 'ok') {
        result.createdRoutes.push(hostname);
        this.#persistNotice({ kind: 'route-created', vps: vpsId, hostname });
      } else if (addResult.errorClass === 'protected-resource') {
        result.protectedSkipped.push(hostname);
        this.#persistNotice({ kind: 'protected-skipped', vps: vpsId, hostname });
      } else {
        result.errors.push({
          scope: `vps:${vpsId}:addRoute:${hostname}`,
          errorClass: addResult.errorClass ?? 'error',
        });
        this.#persistNotice({
          kind: 'error',
          vps: vpsId,
          hostname,
          detail: addResult.errorClass ?? 'error',
        });
      }
    } catch (err) {
      result.errors.push({
        scope: `vps:${vpsId}:addRoute:${hostname}`,
        errorClass: err?.errorClass ?? 'error',
      });
      this.#persistNotice({
        kind: 'error',
        vps: vpsId,
        hostname,
        detail: err?.errorClass ?? 'error',
      });
    }
  }

  // ── Tunnel-Drift-Erkennung + Push (vps-tunnel-drift-notify) ──────────────

  /**
   * Prüft ob der Cloudflare-Tunnel eines VPS existiert.
   *
   * Gibt zurück:
   *   'missing'  — tunnelId nicht in listTunnels() → Drift erkannt (AC1)
   *   'ok'       — tunnelId in listTunnels() → kein Drift
   *   'cf-error' — Cloudflare nicht konsultierbar → unbestimmter Zustand (kein Fehlalarm, AC spec Edge-Cases)
   *
   * Security: kein Token in Log/Return (AC8).
   *
   * @param {string} vpsId
   * @param {string} tunnelId
   * @returns {Promise<'missing'|'ok'|'cf-error'>}
   */
  async #checkTunnelDrift(vpsId, tunnelId) {
    try {
      // listTunnels() listet account-weit alle Tunnel — der übergebene Wert ist KEINE echte zoneId;
      // er wird intern nicht als Filter genutzt. Die Existenz-Prüfung erfolgt via Array.some(t => t.id === tunnelId).
      // (Konsistent mit deploymentsRouter-Konsument: auch dort listTunnels('') + Filter.)
      const tunnels = await this.#cloudflareApi.listTunnels(tunnelId);
      const exists = Array.isArray(tunnels) && tunnels.some((t) => t.id === tunnelId);
      return exists ? 'ok' : 'missing';
    } catch {
      // Cloudflare nicht konsultierbar → unbestimmt; kein Fehlalarm-Push (AC spec Edge-Cases)
      // Security: kein CF-Token, kein Fehler-Detail mit Geheimnis im Log
      console.warn(`[ReconciliationJob] Tunnel-Existenz-Check für VPS '${sanitizeString(vpsId)}' fehlgeschlagen (CF nicht erreichbar) — kein Fehlalarm`);
      return 'cf-error';
    }
  }

  /**
   * Lädt den Drift-Snapshot (lazy, einmalig pro Reconcile-Lauf-Lebensdauer).
   * Setzt #knownDriftVps aus Disk wenn noch nicht geladen.
   *
   * @returns {Promise<Set<string>>}
   */
  async #loadDriftSnapshot() {
    if (this.#knownDriftVps === null) {
      const snapshot = await readTunnelDriftSnapshot();
      this.#knownDriftVps = new Set(
        Object.entries(snapshot.tunnelMissing)
          .filter(([, v]) => v === true)
          .map(([k]) => k),
      );
    }
    return this.#knownDriftVps;
  }

  /**
   * Persistiert den aktuellen Drift-Snapshot auf Disk.
   * Best-effort: Schreib-Fehler werden geloggt, aber nicht geworfen.
   *
   * @returns {Promise<void>}
   */
  async #persistDriftSnapshot() {
    if (this.#knownDriftVps === null) return;
    const tunnelMissing = {};
    for (const vpsId of this.#knownDriftVps) {
      tunnelMissing[vpsId] = true;
    }
    try {
      await writeTunnelDriftSnapshot({ tunnelMissing });
    } catch {
      // Best-effort: kein Crash bei Schreib-Fehler
    }
  }

  /**
   * Sendet einen ntfy-Push für Tunnel-Drift, aber NUR beim Übergang
   * „Tunnel war da / unbekannt → jetzt missing" (AC6 vps-tunnel-drift-notify).
   *
   * Übergangs-Zustand: in #knownDriftVps (Set); wird auf Disk persistiert.
   * Best-effort: ntfy-Fehler bricht nichts ab (AC5).
   * Security: kein Tunnel-Token, kein CF-Token in Payload/Log (AC8).
   *
   * @param {string} vpsId
   * @returns {Promise<void>}
   */
  async #sendTunnelDriftPushIfTransition(vpsId) {
    const knownDrift = await this.#loadDriftSnapshot();

    // Übergang erkennen: war noch nicht als missing bekannt → erster Befund → Push
    const isTransition = !knownDrift.has(vpsId);

    // Zustand immer setzen (auch wenn push-Pfad nicht konfiguriert)
    knownDrift.add(vpsId);
    await this.#persistDriftSnapshot();

    if (!isTransition) {
      // Bereits als missing bekannt → kein Push-Sturm (AC6)
      return;
    }

    // ntfy-Push konfiguriert? (readNotificationSettings + sendNotificationFn erforderlich)
    if (!this.#readNotificationSettings || !this.#sendNotificationFn) {
      return;
    }

    let settings;
    try {
      settings = await this.#readNotificationSettings();
    } catch {
      // Settings-Lese-Fehler → kein Push, kein Crash (best-effort)
      return;
    }

    // AC4 vps-tunnel-drift-notify: Push nur wenn global enabled und tunnel_missing in events
    if (!settings.enabled) return;
    if (!Array.isArray(settings.events) || !settings.events.includes(EVENT_TUNNEL_MISSING)) return;

    // ntfy-Token store-intern (NIE in Payload/Log/Response)
    let token = null;
    if (this.#credentialStore) {
      try {
        token = await this.#credentialStore.getPlaintext(catalogKey('notifications', 'ntfy_token'));
      } catch {
        // Token-Lese-Fehler → Versand ohne Auth (best-effort)
      }
    }

    // AC8 Security: kein Tunnel-Token, kein CF-Token, kein SSH-Key in Payload
    // Nur nicht-geheime vpsId in der Nachricht (AC spec §Sicherheit)
    const slug = process.env.PROJECT_SLUG ?? 'dev-gui';
    const payload = {
      title: `⚠️ ${slug} · VPS ${sanitizeString(vpsId)}: Tunnel fehlt`,
      message: 'Der Cloudflare-Tunnel dieses VPS existiert nicht mehr — über \'Tunnel neu anlegen & bestücken\' wiederherstellen',
      tags: ['warning'],
    };

    // Versand best-effort (AC5)
    try {
      await this.#sendNotificationFn(
        {
          server: settings.server,
          topic: settings.topic,
          priority: settings.priority,
          token, // AC8: Token NIE im Log; nur im Authorization-Header (NotifyService-Contract)
        },
        payload,
      );
    } catch {
      // Best-effort: Versand-Fehler loggen, Reconcile läuft weiter (AC5)
      console.error(`[ReconciliationJob] Tunnel-Drift-Push für VPS '${sanitizeString(vpsId)}' fehlgeschlagen (best-effort)`);
    }
  }

  /**
   * Löst den Drift-Zustand für einen VPS auf (Tunnel wieder vorhanden).
   * Entfernt den VPS aus dem Snapshot-Set.
   * Der nächste Ausfall ist dann ein neuer Übergang und feuert erneut (AC6 spec).
   *
   * @param {string} vpsId
   * @returns {Promise<void>}
   */
  async #resolveTunnelDrift(vpsId) {
    const knownDrift = await this.#loadDriftSnapshot();
    if (knownDrift.has(vpsId)) {
      knownDrift.delete(vpsId);
      await this.#persistDriftSnapshot();
    }
  }

  // ── Notice persistence ────────────────────────────────────────────────────

  /**
   * Persist a ReconcileNotice via AuditStore (AC8b).
   * Best-effort — notice persistence failure is non-fatal.
   * No secrets in notice (AC9).
   *
   * @param {Omit<ReconcileNotice, 'at'>} notice
   */
  #persistNotice({ kind, vps, hostname, detail }) {
    /** @type {ReconcileNotice} */
    const notice = {
      at: new Date().toISOString(),
      kind,
      vps,
      // hostname ist optional (tunnel-missing notices sind VPS-scoped, nicht hostname-scoped)
      ...(hostname !== undefined ? { hostname } : {}),
      // S4: sanitizeString auf detail (Tiefenverteidigung — kein Secret im Notice-Log)
      ...(detail ? { detail: sanitizeString(detail) } : {}),
    };

    try {
      this.#auditStore.record({
        identity: null,
        command: `${AUDIT_NOTICE}:${JSON.stringify(notice)}`,
      });
    } catch {
      // Best-effort
    }
  }

  // ── Report/Notice reading ─────────────────────────────────────────────────

  /**
   * Read the last N ReconcileReports from the AuditStore.
   * Parses AUDIT_REPORT entries in reverse order.
   *
   * @param {number} [limit=20]
   * @returns {ReconcileReport[]}
   */
  getReports(limit = 20) {
    const all = this.#auditStore.getAll();
    const reports = [];
    for (let i = all.length - 1; i >= 0 && reports.length < limit; i--) {
      const entry = all[i];
      if (typeof entry.command === 'string' && entry.command.startsWith(`${AUDIT_REPORT}:`)) {
        try {
          const json = entry.command.slice(`${AUDIT_REPORT}:`.length);
          const report = JSON.parse(json);
          reports.push(report);
        } catch {
          // Skip malformed entries
        }
      }
    }
    return reports;
  }

  /**
   * Read the last N ReconcileNotices from the AuditStore.
   *
   * @param {number} [limit=50]
   * @returns {ReconcileNotice[]}
   */
  getNotices(limit = 50) {
    const all = this.#auditStore.getAll();
    const notices = [];
    for (let i = all.length - 1; i >= 0 && notices.length < limit; i--) {
      const entry = all[i];
      if (typeof entry.command === 'string' && entry.command.startsWith(`${AUDIT_NOTICE}:`)) {
        try {
          const json = entry.command.slice(`${AUDIT_NOTICE}:`.length);
          const notice = JSON.parse(json);
          notices.push(notice);
        } catch {
          // Skip malformed entries
        }
      }
    }
    return notices;
  }

  /**
   * Returns the last ReconcileReport, or null if none exists.
   * @returns {ReconcileReport|null}
   */
  getLastReport() {
    const reports = this.getReports(1);
    return reports.length > 0 ? reports[0] : null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sanitize a ReconcileReport to ensure no secrets are stored.
 * Removes any error detail that might contain token-like strings.
 *
 * @param {ReconcileReport} report
 * @returns {ReconcileReport}
 */
function sanitizeReport(report) {
  return {
    ranAt: report.ranAt,
    trigger: report.trigger,
    perVps: (report.perVps ?? []).map((v) => ({
      vps: v.vps,
      checkedContainers: v.checkedContainers,
      createdRoutes: v.createdRoutes ?? [],
      removedRoutes: v.removedRoutes ?? [],
      protectedSkipped: v.protectedSkipped ?? [],
      stoppedSkipped: v.stoppedSkipped ?? [],
      reportedUnmanaged: v.reportedUnmanaged ?? [],
      errors: (v.errors ?? []).map((e) => ({
        scope: sanitizeString(e.scope),
        errorClass: sanitizeString(e.errorClass),
      })),
      // vps-tunnel-drift-notify AC3: tunnelMissing im Report (keine Secrets — nur boolean)
      ...(v.tunnelMissing === true ? { tunnelMissing: true } : {}),
    })),
  };
}

/**
 * Strip token-like patterns from strings before they reach the audit log.
 * @param {string} s
 * @returns {string}
 */
function sanitizeString(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY[\s\S]*?END (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY/gi, '[KEY REDACTED]')
    .slice(0, 300);
}
