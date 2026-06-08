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
 *     1. VpsDockerControl.ps() → managed containers (with cloudflare.tunnel-hostname label)
 *        and unmanaged containers (without the label, only reported).
 *     2. CloudflareApi.listRoutes(tunnelId) → current routes.
 *     3. Orphaned routes (no managed container, not protected) → remove via CloudflareApi (Audit-First).
 *     4. Managed containers without route (not protected) → add route via DeployOrchestrator
 *        addRouteOnly() (Audit-First; reuses shared path, no new Cloudflare mutation code here).
 *   - Fail-closed: if ps() fails → skip that VPS entirely (neither delete nor heal).
 *   - Ambiguous binding (two managed containers → same hostname) → not healed, flagged ambiguous.
 *   - Degradation per VPS/provider: errors don't abort the overall run.
 *   - ReconcileReport + ReconcileNotice: persisted via AuditStore (kein neuer Store, ADR-005-Linie).
 *
 * Security (Floor):
 *   - LockoutGuard-Hard-Block: protected hostnames are never deleted or healed (automatic via
 *     DeployOrchestrator reuse for heal; explicit guard for delete).
 *   - Audit-First for both delete and heal paths.
 *   - No secrets (SSH key, CF token) in Report, Notice, log, or any external channel.
 *
 * AC1  — node-internal scheduler, midnight UTC, no external cron/service.
 * AC2  — same reconcile() method invoked by cron and manual trigger; produces ReconcileReport.
 * AC3  — orphaned (non-protected) routes → removed; idempotent.
 * AC4  — protected routes never deleted.
 * AC5  — managed container without route → healed via DeployOrchestrator addRouteOnly path.
 * AC5b — protected hostname on managed container → protectedSkipped, not healed.
 * AC5c — unmanaged container → only reportedUnmanaged, never healed.
 * AC6  — VPS/provider failures degrade, don't abort.
 * AC7  — ps() failure → fail-closed; ambiguous binding → ambiguous, not healed.
 * AC8  — ReconcileReport per run; GET endpoints; Audit-First.
 * AC8b — ReconcileNotice per action; GET endpoint.
 * AC9  — LockoutGuard-Hard-Block + Audit-First via shared ADR-012 path.
 *
 * @module deploy/ReconciliationJob
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** AuditStore command prefix for reconcile actions. */
const AUDIT_PREFIX = 'reconcile';

/** AuditStore command for a ReconcileReport entry. */
const AUDIT_REPORT = 'reconcile:report';

/** AuditStore command for a ReconcileNotice entry. */
const AUDIT_NOTICE = 'reconcile:notice';

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
 * @property {number} checkedContainers
 * @property {string[]} createdRoutes
 * @property {string[]} removedRoutes
 * @property {string[]} protectedSkipped
 * @property {string[]} reportedUnmanaged
 * @property {Array<{ scope: string, errorClass: string }>} errors
 */

/**
 * @typedef {object} ReconcileNotice
 * @property {string} at
 * @property {'route-created'|'route-removed'|'protected-skipped'|'error'} kind
 * @property {string} vps
 * @property {string} hostname
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

  /**
   * @param {object} opts
   * @param {import('./VpsDockerControl.js').VpsDockerControl} opts.dockerControl
   * @param {import('../cloudflare/CloudflareApi.js').CloudflareApi} opts.cloudflareApi
   * @param {import('../cloudflare/LockoutGuard.js').LockoutGuard} opts.lockoutGuard
   * @param {import('./DeployOrchestrator.js').DeployOrchestrator} opts.orchestrator
   * @param {import('../AuditStore.js').AuditStore} opts.auditStore
   * @param {Array<{ vpsId: string, vps: object, tunnelId: string }>} opts.vpsConfigs
   */
  constructor({ dockerControl, cloudflareApi, lockoutGuard, orchestrator, auditStore, vpsConfigs }) {
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
   * Reconcile a single VPS: ps() + listRoutes() → diff → heal/delete.
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
      reportedUnmanaged: [],
      errors: [],
    };

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

    result.checkedContainers = managedContainers.length;

    // Detect ambiguous bindings: two managed containers on same VPS → same hostname (AC7)
    const hostnameToContainers = new Map();
    for (const c of managedContainers) {
      if (!hostnameToContainers.has(c.hostname)) {
        hostnameToContainers.set(c.hostname, []);
      }
      hostnameToContainers.get(c.hostname).push(c);
    }

    const ambiguousHostnames = new Set();
    for (const [hostname, containers] of hostnameToContainers) {
      if (containers.length > 1) {
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

    // ── Step 4: Managed containers without routes (AC5/AC5b/AC5c) ─────────────
    for (const [hostname, containers] of hostnameToContainers) {
      // AC7: skip ambiguous bindings
      if (ambiguousHostnames.has(hostname)) {
        continue;
      }

      if (!routeHostnames.has(hostname)) {
        // Managed container without route — heal it
        const container = containers[0];
        await this.#healMissingRoute(vpsId, vps, tunnelId, hostname, container, result);
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
      hostname,
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
      reportedUnmanaged: v.reportedUnmanaged ?? [],
      errors: (v.errors ?? []).map((e) => ({
        scope: sanitizeString(e.scope),
        errorClass: sanitizeString(e.errorClass),
      })),
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
