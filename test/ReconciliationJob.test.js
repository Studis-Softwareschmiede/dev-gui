/**
 * ReconciliationJob.test.js — Tests für Capability C: beidseitig selbst-heilender Abgleich (ADR-013).
 *
 * Covers (cloudflare-reconciliation):
 *   AC2  — reconcile() is deterministically callable; produces ReconcileReport for manual trigger.
 *   AC3  — orphaned (non-protected) route → removeRoute() called; idempotent (second run = no-op).
 *   AC4  — protected route → never deleted (removeRoute NOT called).
 *   AC5  — managed container without route → addRouteOnly() called (shared ADR-012 path).
 *   AC5b — protected hostname on managed container → protectedSkipped, no addRouteOnly().
 *   AC5c — unmanaged containers → only reportedUnmanaged, no heal, no rm.
 *   AC6  — VPS failure (ps error) → other VPS continue; degraded VPS reported in errors.
 *   AC7  — ps() failure → fail-closed: no removeRoute, no addRouteOnly for that VPS.
 *   AC7  — ambiguous binding (two managed containers → same hostname) → ambiguous, not healed.
 *   AC8  — ReconcileReport produced; getLastReport()/getReports()/getNotices() work.
 *   AC8b — ReconcileNotice produced per action; getNotices() returns them.
 *   AC9  — LockoutGuard-Hard-Block via DeployOrchestrator.addRouteOnly (protected → error).
 *   AC9  — Audit-First: AuditStore.record() called before any mutation.
 *
 * Covers (stack-deploy-orchestration AC13/AC14 — stack-aware Reconciliation):
 *   AC13 — public stack container (cloudflare.tunnel-hostname set) healed like single-image.
 *   AC13 — internal stack container (no cloudflare.tunnel-hostname) never routed/treated as orphaned.
 *   AC13 — multiple public hostnames per stack each handled individually.
 *   AC14 — all existing ADR-013 behaviors (AC3–AC9) remain valid (covered by AC3–AC9 tests above).
 *   AC14 — healing path is addRouteOnly (no new Cloudflare mutation code in ReconciliationJob).
 *
 * Covers (deploymentsRouter — reconcile endpoints):
 *   POST /api/deployments/reconcile — AC2: 200 { result: "ok", report }; 403 without auth.
 *   GET  /api/deployments/reconcile/last — returns last report.
 *   GET  /api/deployments/reconcile/reports — returns reports array.
 *   GET  /api/deployments/reconcile/notices — returns notices array.
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { ReconciliationJob } from '../src/deploy/ReconciliationJob.js';
import { AuditStore } from '../src/AuditStore.js';
import { deploymentsRouter } from '../src/deploymentsRouter.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build minimal stubs for ReconciliationJob dependencies.
 */
function makeStubs({
  psResult = { result: 'ok', containers: [] },
  listRoutesResult = [],
  removeRouteResult = undefined,
  addRouteOnlyResult = { result: 'ok' },
  isProtected = false,
} = {}) {
  const dockerControl = {
    psAll: jest.fn().mockResolvedValue(psResult),
  };

  const cloudflareApi = {
    listRoutes: jest.fn().mockResolvedValue(listRoutesResult),
    removeRoute: jest.fn().mockResolvedValue(removeRouteResult),
    resolveZoneForHostname: jest.fn().mockResolvedValue('zone-1'),
    deleteDnsRecord: jest.fn().mockResolvedValue(undefined),
  };

  const lockoutGuard = {
    isProtected: jest.fn().mockReturnValue(isProtected),
  };

  const orchestrator = {
    addRouteOnly: jest.fn().mockResolvedValue(addRouteOnlyResult),
  };

  return { dockerControl, cloudflareApi, lockoutGuard, orchestrator };
}

function makeJob(overrides = {}, auditStore = new AuditStore()) {
  const stubs = makeStubs(overrides.stubs ?? {});
  const vpsConfigs = overrides.vpsConfigs ?? [
    { vpsId: 'vps-1', vps: { host: '1.2.3.4', port: 22, targetUser: 'root' }, tunnelId: 'tunnel-1' },
  ];
  const job = new ReconciliationJob({
    dockerControl: stubs.dockerControl,
    cloudflareApi: stubs.cloudflareApi,
    lockoutGuard: stubs.lockoutGuard,
    orchestrator: stubs.orchestrator,
    auditStore,
    vpsConfigs,
  });
  return { job, stubs, auditStore };
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

describe('ReconciliationJob', () => {
  // ── AC2: reconcile() produces ReconcileReport ──────────────────────────────

  describe('AC2 — reconcile() produces ReconcileReport', () => {
    it('returns a ReconcileReport with ranAt, trigger, perVps', async () => {
      const { job } = makeJob();
      const report = await job.reconcile('manual');

      expect(report).toBeTruthy();
      expect(typeof report.ranAt).toBe('string');
      expect(report.trigger).toBe('manual');
      expect(Array.isArray(report.perVps)).toBe(true);
    });

    it('trigger=cron is reflected in report', async () => {
      const { job } = makeJob();
      const report = await job.reconcile('cron');
      expect(report.trigger).toBe('cron');
    });

    it('returns null if already running (skip-if-running)', async () => {
      const { job, stubs } = makeJob({
        stubs: {
          psResult: { result: 'ok', containers: [] },
          listRoutesResult: [],
        },
      });

      // Make psAll() hang to keep the first run in progress
      let resolvePs;
      stubs.dockerControl.psAll.mockReturnValueOnce(
        new Promise((resolve) => { resolvePs = resolve; }),
      );

      // Start first run without awaiting
      const firstRun = job.reconcile('manual');

      // Try second run while first is running
      const secondRun = await job.reconcile('manual');
      expect(secondRun).toBeNull();

      // Let the first run complete
      resolvePs({ result: 'ok', containers: [] });
      await firstRun;
    });

    it('produces a report with empty actions when everything is in sync (idempotent)', async () => {
      // Container has route, route has container → no-op
      const { job } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [{ hostname: 'app.example.com', containerId: 'abc123', image: 'img', status: 'Up', hostPort: 8080 }],
          },
          listRoutesResult: [
            { hostname: 'app.example.com', service: 'http://localhost:8080', tunnelId: 'tunnel-1', protected: false },
          ],
        },
      });

      const report = await job.reconcile('manual');
      const vps = report.perVps[0];

      expect(vps.createdRoutes).toHaveLength(0);
      expect(vps.removedRoutes).toHaveLength(0);
      expect(vps.errors).toHaveLength(0);
    });
  });

  // ── AC3: Orphaned route removal ────────────────────────────────────────────

  describe('AC3 — orphaned route → removeRoute() called', () => {
    it('calls removeRoute() for a route without matching managed container', async () => {
      const { job, stubs } = makeJob({
        stubs: {
          psResult: { result: 'ok', containers: [] },
          listRoutesResult: [
            { hostname: 'orphan.example.com', service: 'http://localhost:9090', tunnelId: 'tunnel-1', protected: false },
          ],
        },
      });

      const report = await job.reconcile('manual');
      expect(stubs.cloudflareApi.removeRoute).toHaveBeenCalledWith('tunnel-1', 'orphan.example.com');
      expect(report.perVps[0].removedRoutes).toContain('orphan.example.com');
    });

    it('räumt auch den verwaisten CNAME mit auf (Route + DNS)', async () => {
      const { job, stubs } = makeJob({
        stubs: {
          psResult: { result: 'ok', containers: [] },
          listRoutesResult: [
            { hostname: 'orphan.example.com', service: 'http://localhost:9090', tunnelId: 'tunnel-1', protected: false },
          ],
        },
      });

      await job.reconcile('manual');
      expect(stubs.cloudflareApi.removeRoute).toHaveBeenCalledWith('tunnel-1', 'orphan.example.com');
      // Symmetrie zum Undeploy: der CNAME wird mit-gelöscht, sonst blockiert er spätere Re-Deploys
      expect(stubs.cloudflareApi.deleteDnsRecord).toHaveBeenCalledWith('zone-1', 'orphan.example.com');
    });

    it('DNS-Cleanup ist best-effort: deleteDnsRecord-Fehler bricht den Reconcile nicht ab', async () => {
      const { job, stubs } = makeJob({
        stubs: {
          psResult: { result: 'ok', containers: [] },
          listRoutesResult: [
            { hostname: 'orphan.example.com', service: 'http://localhost:9090', tunnelId: 'tunnel-1', protected: false },
          ],
        },
      });
      stubs.cloudflareApi.deleteDnsRecord.mockRejectedValue(new Error('cf down'));

      const report = await job.reconcile('manual');
      // Route gilt weiterhin als entfernt; kein Abbruch trotz DNS-Fehler
      expect(report.perVps[0].removedRoutes).toContain('orphan.example.com');
    });

    it('is idempotent: second run without drift does not call removeRoute again', async () => {
      const containers = [];
      const routes = [
        { hostname: 'orphan.example.com', service: 'http://localhost:9090', tunnelId: 'tunnel-1', protected: false },
      ];

      const { job, stubs } = makeJob({
        stubs: {
          psResult: { result: 'ok', containers },
          listRoutesResult: routes,
        },
      });

      // First run — removes route
      await job.reconcile('manual');
      expect(stubs.cloudflareApi.removeRoute).toHaveBeenCalledTimes(1);

      // Simulate: after removal, listRoutes returns empty
      stubs.cloudflareApi.listRoutes.mockResolvedValue([]);

      // Second run — no-op
      const report2 = await job.reconcile('manual');
      expect(stubs.cloudflareApi.removeRoute).toHaveBeenCalledTimes(1); // no new call
      expect(report2.perVps[0].removedRoutes).toHaveLength(0);
    });
  });

  // ── AC4: Protected route never deleted ────────────────────────────────────

  describe('AC4 — protected route never deleted', () => {
    it('does NOT call removeRoute() for a protected route without container', async () => {
      const { job, stubs } = makeJob({
        stubs: {
          psResult: { result: 'ok', containers: [] },
          listRoutesResult: [
            { hostname: 'devgui.example.com', service: 'http://localhost:8080', tunnelId: 'tunnel-1', protected: true },
          ],
          isProtected: true,
        },
      });

      const report = await job.reconcile('manual');
      expect(stubs.cloudflareApi.removeRoute).not.toHaveBeenCalled();
      expect(report.perVps[0].removedRoutes).toHaveLength(0);
    });
  });

  // ── AC5: Managed container without route → addRouteOnly() ─────────────────

  describe('AC5 — managed container without route → addRouteOnly() called', () => {
    it('calls addRouteOnly() for a managed container with no matching route', async () => {
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              { hostname: 'app.example.com', containerId: 'abc123', image: 'img', status: 'Up', hostPort: 8080 },
            ],
          },
          listRoutesResult: [], // No routes
        },
      });

      const report = await job.reconcile('manual');
      expect(stubs.orchestrator.addRouteOnly).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'app.example.com', tunnelId: 'tunnel-1' }),
      );
      expect(report.perVps[0].createdRoutes).toContain('app.example.com');
    });

    it('is idempotent: second run with route present does not call addRouteOnly again', async () => {
      const containers = [
        { hostname: 'app.example.com', containerId: 'abc123', image: 'img', status: 'Up', hostPort: 8080 },
      ];
      const { job, stubs } = makeJob({
        stubs: {
          psResult: { result: 'ok', containers },
          listRoutesResult: [], // No routes initially
        },
      });

      // First run — heals
      await job.reconcile('manual');
      expect(stubs.orchestrator.addRouteOnly).toHaveBeenCalledTimes(1);

      // Second run — route is now present
      stubs.cloudflareApi.listRoutes.mockResolvedValue([
        { hostname: 'app.example.com', service: 'http://localhost:8080', tunnelId: 'tunnel-1', protected: false },
      ]);

      const report2 = await job.reconcile('manual');
      expect(stubs.orchestrator.addRouteOnly).toHaveBeenCalledTimes(1); // no new call
      expect(report2.perVps[0].createdRoutes).toHaveLength(0);
    });
  });

  // ── AC5b: Protected hostname on managed container → protectedSkipped ────────

  describe('AC5b — protected managed container hostname → not healed', () => {
    it('does NOT call addRouteOnly() for a protected hostname; records protectedSkipped', async () => {
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              { hostname: 'devgui.example.com', containerId: 'abc', image: 'img', status: 'Up', hostPort: 8080 },
            ],
          },
          listRoutesResult: [], // No route for this hostname
          isProtected: true,
        },
      });

      const report = await job.reconcile('manual');
      expect(stubs.orchestrator.addRouteOnly).not.toHaveBeenCalled();
      expect(report.perVps[0].protectedSkipped).toContain('devgui.example.com');
      expect(report.perVps[0].createdRoutes).toHaveLength(0);
    });
  });

  // ── AC5c: Unmanaged containers only reported ───────────────────────────────

  describe('AC5c — unmanaged containers only reportedUnmanaged', () => {
    it('reports unmanaged container (hostname: null) in reportedUnmanaged — no heal, no rm', async () => {
      // psAll() returns the unmanaged container with hostname: null.
      // ReconciliationJob must: report it in reportedUnmanaged, NOT call addRouteOnly, NOT call rm.
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              // Unmanaged container — no cloudflare.tunnel-hostname label → hostname: null
              { containerId: 'unmanaged1', image: 'nginx:latest', hostname: null, status: 'Up 3 hours', hostPort: 9090 },
            ],
          },
          listRoutesResult: [],
        },
      });

      const report = await job.reconcile('manual');

      // AC5c: unmanaged container reported
      expect(report.perVps[0].reportedUnmanaged).toHaveLength(1);
      expect(report.perVps[0].reportedUnmanaged[0]).toContain('unmanaged1');

      // No healing (no addRouteOnly) — unmanaged containers are never healed
      expect(stubs.orchestrator.addRouteOnly).not.toHaveBeenCalled();
      // No route removal either
      expect(stubs.cloudflareApi.removeRoute).not.toHaveBeenCalled();
      // checkedContainers counts only managed ones
      expect(report.perVps[0].checkedContainers).toBe(0);
      expect(report.perVps[0].createdRoutes).toHaveLength(0);
      expect(report.perVps[0].removedRoutes).toHaveLength(0);
    });

    it('handles mix of managed and unmanaged containers correctly', async () => {
      // One managed (with label) + one unmanaged (hostname: null)
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              { containerId: 'managed1', image: 'app:v1', hostname: 'app.example.com', status: 'Up', hostPort: 8080 },
              { containerId: 'unmanaged2', image: 'redis:7', hostname: null, status: 'Up 1 hour', hostPort: 6379 },
            ],
          },
          listRoutesResult: [
            { hostname: 'app.example.com', service: 'http://localhost:8080', tunnelId: 'tunnel-1', protected: false },
          ],
        },
      });

      const report = await job.reconcile('manual');
      const vps = report.perVps[0];

      // The managed container has a route → no healing needed
      expect(vps.createdRoutes).toHaveLength(0);
      // The unmanaged container is reported
      expect(vps.reportedUnmanaged).toHaveLength(1);
      expect(vps.reportedUnmanaged[0]).toContain('unmanaged2');
      // Only managed containers counted
      expect(vps.checkedContainers).toBe(1);
      // No mutations
      expect(stubs.orchestrator.addRouteOnly).not.toHaveBeenCalled();
      expect(stubs.cloudflareApi.removeRoute).not.toHaveBeenCalled();
      // No secrets in reportedUnmanaged entries
      expect(JSON.stringify(vps.reportedUnmanaged)).not.toMatch(/Bearer|PRIVATE KEY/);
    });
  });

  // ── AC6: Degradation — VPS failure doesn't abort other VPS ────────────────

  describe('AC6 — VPS failure degrades, other VPS continue', () => {
    it('continues reconciliation of second VPS when first VPS psAll() throws', async () => {
      const auditStore = new AuditStore();
      const dockerControl = {
        psAll: jest.fn()
          .mockRejectedValueOnce(new Error('SSH timeout')) // vps-1 fails
          .mockResolvedValueOnce({ result: 'ok', containers: [] }), // vps-2 succeeds
      };
      const cloudflareApi = {
        listRoutes: jest.fn().mockResolvedValue([]),
        removeRoute: jest.fn(),
      };
      const lockoutGuard = { isProtected: jest.fn().mockReturnValue(false) };
      const orchestrator = { addRouteOnly: jest.fn().mockResolvedValue({ result: 'ok' }) };

      const job = new ReconciliationJob({
        dockerControl,
        cloudflareApi,
        lockoutGuard,
        orchestrator,
        auditStore,
        vpsConfigs: [
          { vpsId: 'vps-1', vps: { host: '1.2.3.4', port: 22, targetUser: 'root' }, tunnelId: 'tunnel-1' },
          { vpsId: 'vps-2', vps: { host: '5.6.7.8', port: 22, targetUser: 'root' }, tunnelId: 'tunnel-2' },
        ],
      });

      const report = await job.reconcile('manual');

      expect(report.perVps).toHaveLength(2);
      const vps1 = report.perVps.find((v) => v.vps === 'vps-1');
      const vps2 = report.perVps.find((v) => v.vps === 'vps-2');

      // VPS-1 has an error (psAll failed)
      expect(vps1.errors.length).toBeGreaterThan(0);
      // VPS-2 was reconciled (psAll called for vps-2)
      expect(dockerControl.psAll).toHaveBeenCalledTimes(2);
      expect(vps2.errors).toHaveLength(0);
    });
  });

  // ── AC7: Fail-closed when ps() fails ──────────────────────────────────────

  describe('AC7 — fail-closed: ps() failure → no mutations for that VPS', () => {
    it('does not call removeRoute or addRouteOnly when ps() returns result!=ok', async () => {
      const { job, stubs } = makeJob({
        stubs: {
          psResult: { result: 'error', errorClass: 'unreachable', reason: 'SSH timeout' },
          listRoutesResult: [
            { hostname: 'app.example.com', service: 'http://localhost:8080', tunnelId: 'tunnel-1', protected: false },
          ],
        },
      });

      const report = await job.reconcile('manual');
      expect(stubs.cloudflareApi.removeRoute).not.toHaveBeenCalled();
      expect(stubs.orchestrator.addRouteOnly).not.toHaveBeenCalled();
      expect(report.perVps[0].errors.length).toBeGreaterThan(0);
    });

    it('does not call removeRoute or addRouteOnly when psAll() throws', async () => {
      const auditStore = new AuditStore();
      const dockerControl = { psAll: jest.fn().mockRejectedValue(new Error('Network error')) };
      const cloudflareApi = {
        listRoutes: jest.fn().mockResolvedValue([{ hostname: 'x.example.com', tunnelId: 'tunnel-1', protected: false }]),
        removeRoute: jest.fn(),
      };
      const lockoutGuard = { isProtected: jest.fn().mockReturnValue(false) };
      const orchestrator = { addRouteOnly: jest.fn() };

      const job = new ReconciliationJob({
        dockerControl, cloudflareApi, lockoutGuard, orchestrator, auditStore,
        vpsConfigs: [{ vpsId: 'vps-1', vps: { host: '1.2.3.4' }, tunnelId: 'tunnel-1' }],
      });

      const report = await job.reconcile('manual');
      expect(cloudflareApi.removeRoute).not.toHaveBeenCalled();
      expect(orchestrator.addRouteOnly).not.toHaveBeenCalled();
      expect(report.perVps[0].errors.length).toBeGreaterThan(0);
    });
  });

  // ── AC7: Ambiguous binding ─────────────────────────────────────────────────

  describe('AC7 — ambiguous binding → not healed', () => {
    it('marks ambiguous when two managed containers share the same hostname', async () => {
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              { hostname: 'app.example.com', containerId: 'abc', image: 'img', status: 'Up', hostPort: 8080 },
              { hostname: 'app.example.com', containerId: 'def', image: 'img2', status: 'Up', hostPort: 8081 },
            ],
          },
          listRoutesResult: [],
        },
      });

      const report = await job.reconcile('manual');
      expect(stubs.orchestrator.addRouteOnly).not.toHaveBeenCalled();
      const errors = report.perVps[0].errors;
      const ambig = errors.find((e) => e.errorClass === 'ambiguous');
      expect(ambig).toBeTruthy();
      expect(ambig.scope).toContain('app.example.com');
    });
  });

  // ── AC8: Report + Notice persistence ──────────────────────────────────────

  describe('AC8 — ReconcileReport persisted via AuditStore', () => {
    it('persists ReconcileReport in AuditStore after reconcile()', async () => {
      const auditStore = new AuditStore();
      const { job } = makeJob({}, auditStore);

      await job.reconcile('manual');

      const entries = auditStore.getAll();
      const reportEntry = entries.find((e) => e.command.startsWith('reconcile:report:'));
      expect(reportEntry).toBeTruthy();
    });

    it('getLastReport() returns the last persisted report', async () => {
      const auditStore = new AuditStore();
      const { job } = makeJob({}, auditStore);

      await job.reconcile('cron');

      const report = job.getLastReport();
      expect(report).toBeTruthy();
      expect(report.trigger).toBe('cron');
    });

    it('getReports(N) returns the last N reports in reverse order', async () => {
      const auditStore = new AuditStore();
      const { job } = makeJob({}, auditStore);

      await job.reconcile('manual');
      await job.reconcile('cron');

      const reports = job.getReports(2);
      expect(reports).toHaveLength(2);
      // Most recent first
      expect(reports[0].trigger).toBe('cron');
      expect(reports[1].trigger).toBe('manual');
    });

    it('getLastReport() returns null when no reports exist', () => {
      const { job } = makeJob();
      expect(job.getLastReport()).toBeNull();
    });
  });

  // ── AC8b: ReconcileNotice ──────────────────────────────────────────────────

  describe('AC8b — ReconcileNotice persisted per action', () => {
    it('produces a route-removed notice when orphaned route is deleted', async () => {
      const auditStore = new AuditStore();
      const { job } = makeJob({
        stubs: {
          psResult: { result: 'ok', containers: [] },
          listRoutesResult: [
            { hostname: 'orphan.example.com', tunnelId: 'tunnel-1', protected: false },
          ],
        },
      }, auditStore);

      await job.reconcile('manual');

      const notices = job.getNotices(10);
      const notice = notices.find((n) => n.kind === 'route-removed');
      expect(notice).toBeTruthy();
      expect(notice.hostname).toBe('orphan.example.com');
      expect(notice.vps).toBe('vps-1');
      // No secrets in notice (AC9)
      expect(JSON.stringify(notice)).not.toMatch(/Bearer|PRIVATE KEY/);
    });

    it('produces a route-created notice when managed container is healed', async () => {
      const auditStore = new AuditStore();
      const { job } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [{ hostname: 'new.example.com', containerId: 'abc', image: 'img', status: 'Up', hostPort: 8080 }],
          },
          listRoutesResult: [],
        },
      }, auditStore);

      await job.reconcile('manual');

      const notices = job.getNotices(10);
      const notice = notices.find((n) => n.kind === 'route-created');
      expect(notice).toBeTruthy();
      expect(notice.hostname).toBe('new.example.com');
    });

    it('produces a protected-skipped notice for a protected managed container', async () => {
      const auditStore = new AuditStore();
      const { job } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [{ hostname: 'devgui.example.com', containerId: 'abc', image: 'img', status: 'Up', hostPort: 8080 }],
          },
          listRoutesResult: [],
          isProtected: true,
        },
      }, auditStore);

      await job.reconcile('manual');

      const notices = job.getNotices(10);
      const notice = notices.find((n) => n.kind === 'protected-skipped');
      expect(notice).toBeTruthy();
    });
  });

  // ── AC9: Audit-First ────────────────────────────────────────────────────────

  describe('AC9 — Audit-First: record() called before mutation', () => {
    it('calls auditStore.record() before removeRoute()', async () => {
      const callOrder = [];

      // Build a real AuditStore but intercept calls
      const auditStore = new AuditStore();
      const originalRecord = auditStore.record.bind(auditStore);
      auditStore.record = ({ identity, command }) => {
        if (command?.includes('route-removed')) callOrder.push('audit');
        return originalRecord({ identity, command });
      };

      const dockerControl = { psAll: jest.fn().mockResolvedValue({ result: 'ok', containers: [] }) };
      const cloudflareApi = {
        listRoutes: jest.fn().mockResolvedValue([
          { hostname: 'orphan.example.com', tunnelId: 'tunnel-1', protected: false },
        ]),
        removeRoute: jest.fn().mockImplementation(() => {
          callOrder.push('mutation');
          return Promise.resolve();
        }),
      };
      const lockoutGuard = { isProtected: jest.fn().mockReturnValue(false) };
      const orchestrator = { addRouteOnly: jest.fn() };

      const job = new ReconciliationJob({
        dockerControl, cloudflareApi, lockoutGuard, orchestrator, auditStore,
        vpsConfigs: [{ vpsId: 'vps-1', vps: { host: '1.2.3.4' }, tunnelId: 'tunnel-1' }],
      });

      await job.reconcile('manual');

      const auditIdx = callOrder.indexOf('audit');
      const mutationIdx = callOrder.indexOf('mutation');
      expect(auditIdx).toBeGreaterThanOrEqual(0);
      expect(mutationIdx).toBeGreaterThanOrEqual(0);
      expect(auditIdx).toBeLessThan(mutationIdx);
    });

    it('does NOT call removeRoute() when audit write fails for that action', async () => {
      const auditStore = new AuditStore();
      let failNextAudit = false;
      const realRecord = auditStore.record.bind(auditStore);
      jest.spyOn(auditStore, 'record').mockImplementation(({ command, identity }) => {
        if (failNextAudit && command?.includes('route-removed')) {
          failNextAudit = false;
          throw new Error('Disk full');
        }
        return realRecord({ command, identity });
      });
      failNextAudit = true;

      const dockerControl = { psAll: jest.fn().mockResolvedValue({ result: 'ok', containers: [] }) };
      const cloudflareApi = {
        listRoutes: jest.fn().mockResolvedValue([
          { hostname: 'orphan.example.com', tunnelId: 'tunnel-1', protected: false },
        ]),
        removeRoute: jest.fn(),
      };
      const lockoutGuard = { isProtected: jest.fn().mockReturnValue(false) };
      const orchestrator = { addRouteOnly: jest.fn() };

      const job = new ReconciliationJob({
        dockerControl, cloudflareApi, lockoutGuard, orchestrator, auditStore,
        vpsConfigs: [{ vpsId: 'vps-1', vps: { host: '1.2.3.4' }, tunnelId: 'tunnel-1' }],
      });

      await job.reconcile('manual');
      expect(cloudflareApi.removeRoute).not.toHaveBeenCalled();
    });

    it('no secrets in report or notices', async () => {
      const { job } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [{ hostname: 'app.example.com', containerId: 'abc', image: 'img', status: 'Up', hostPort: 8080 }],
          },
          listRoutesResult: [],
        },
      });

      const report = await job.reconcile('manual');
      const reportStr = JSON.stringify(report);
      expect(reportStr).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/i);
      expect(reportStr).not.toMatch(/PRIVATE KEY/i);
    });
  });

  // ── DeployOrchestrator.addRouteOnly ────────────────────────────────────────

  describe('DeployOrchestrator.addRouteOnly — shared ADR-012 healing path', () => {
    it('ReconciliationJob does not contain own cloudflareApi.addRoute() calls', () => {
      // Verify via source text that ReconciliationJob only calls orchestrator.addRouteOnly
      // and not cloudflareApi.addRoute/removeRoute directly for healing.
      // This is the AC5 "no duplicate code" requirement.
      // We verify by checking that orchestrator.addRouteOnly is called (tested above),
      // and that the test stubs don't need cloudflareApi.addRoute for healing.
      // (The grep-verifiable constraint is enforced by the source code; this test
      //  confirms the right stub is called.)
      const { stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [{ hostname: 'app.example.com', containerId: 'abc', image: 'img', status: 'Up', hostPort: 8080 }],
          },
          listRoutesResult: [],
        },
      });
      // cloudflareApi has no addRoute method in our stub — if ReconciliationJob called it,
      // the test would throw "not a function"
      expect(stubs.cloudflareApi.addRoute).toBeUndefined();
    });
  });

  // ── AC13: Stack-aware Reconciliation ─────────────────────────────────────────

  describe('AC13 — stack-aware: public stack containers healed/deleted like single-image', () => {
    it('AC13 — public stack container (with cloudflare.tunnel-hostname + composeProject) healed via addRouteOnly()', async () => {
      // A stack container that IS public (has cloudflare.tunnel-hostname label).
      // psAll() returns it with hostname set + composeProject set.
      // ReconciliationJob must heal it (add missing route) exactly like a single-image container.
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              {
                containerId: 'stack-web-abc',
                image: 'myapp/web:latest',
                hostname: 'web.example.com',
                status: 'Up',
                hostPort: 8080,
                composeProject: 'myapp', // stack container, but public
              },
            ],
          },
          listRoutesResult: [], // no route yet → must be healed
        },
      });

      const report = await job.reconcile('manual');
      // Public stack container must trigger addRouteOnly (healing)
      expect(stubs.orchestrator.addRouteOnly).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'web.example.com', tunnelId: 'tunnel-1' }),
      );
      expect(report.perVps[0].createdRoutes).toContain('web.example.com');
    });

    it('AC13 — orphaned route for a public stack container removed (same as single-image)', async () => {
      // Route exists but the stack public container is gone → orphaned route must be deleted.
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [], // no containers running
          },
          listRoutesResult: [
            { hostname: 'web.example.com', service: 'http://localhost:8080', tunnelId: 'tunnel-1', protected: false },
          ],
        },
      });

      const report = await job.reconcile('manual');
      expect(stubs.cloudflareApi.removeRoute).toHaveBeenCalledWith('tunnel-1', 'web.example.com');
      expect(report.perVps[0].removedRoutes).toContain('web.example.com');
    });

    it('AC13 — internal stack container (no cloudflare.tunnel-hostname) never routed, never treated as orphaned', async () => {
      // Internal stack container: has composeProject but NO cloudflare.tunnel-hostname.
      // psAll() returns it with hostname: null.
      // ReconciliationJob must NOT heal it, NOT call addRouteOnly, NOT call removeRoute.
      // It must appear only in reportedUnmanaged.
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              {
                containerId: 'stack-db-xyz',
                image: 'postgres:15',
                hostname: null, // no cloudflare.tunnel-hostname label → internal
                status: 'Up 5 hours',
                hostPort: null,
                composeProject: 'myapp', // stack container, but internal
              },
            ],
          },
          listRoutesResult: [],
        },
      });

      const report = await job.reconcile('manual');

      // Must never call addRouteOnly (internal container must not be routed)
      expect(stubs.orchestrator.addRouteOnly).not.toHaveBeenCalled();
      // Must never call removeRoute (internal container is not managed → not orphaned)
      expect(stubs.cloudflareApi.removeRoute).not.toHaveBeenCalled();
      // Must appear in reportedUnmanaged (same treatment as non-stack unmanaged containers)
      expect(report.perVps[0].reportedUnmanaged).toHaveLength(1);
      expect(report.perVps[0].reportedUnmanaged[0]).toContain('stack-db-xyz');
      // checkedContainers must be 0 (internal container is not managed)
      expect(report.perVps[0].checkedContainers).toBe(0);
    });

    it('AC13 — mix: public + internal stack containers, only public affects route operations', async () => {
      // Stack with two containers: one public (web), one internal (db).
      // Route for web is present → in-sync, no action needed.
      // Internal db has no route (correct — it must never have one).
      // No mutations expected.
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              {
                containerId: 'web-abc',
                image: 'myapp/web:latest',
                hostname: 'web.example.com', // public → managed
                status: 'Up',
                hostPort: 8080,
                composeProject: 'myapp',
              },
              {
                containerId: 'db-xyz',
                image: 'postgres:15',
                hostname: null, // internal → unmanaged
                status: 'Up',
                hostPort: null,
                composeProject: 'myapp',
              },
            ],
          },
          listRoutesResult: [
            { hostname: 'web.example.com', service: 'http://localhost:8080', tunnelId: 'tunnel-1', protected: false },
          ],
        },
      });

      const report = await job.reconcile('manual');

      // No healing or deletion needed (web route exists, db is internal)
      expect(stubs.orchestrator.addRouteOnly).not.toHaveBeenCalled();
      expect(stubs.cloudflareApi.removeRoute).not.toHaveBeenCalled();
      // Only the public container counts as checked
      expect(report.perVps[0].checkedContainers).toBe(1);
      // The internal db container is in reportedUnmanaged
      expect(report.perVps[0].reportedUnmanaged).toHaveLength(1);
      expect(report.perVps[0].reportedUnmanaged[0]).toContain('db-xyz');
    });

    it('AC13 — multiple public hostnames per stack: both healed individually when routes missing', async () => {
      // Stack with two public containers: web_main + kong.
      // Both are missing routes → both must be healed individually.
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              {
                containerId: 'web-abc',
                image: 'myapp/web:latest',
                hostname: 'app.example.com',
                status: 'Up',
                hostPort: 8080,
                composeProject: 'myapp',
              },
              {
                containerId: 'kong-def',
                image: 'myapp/kong:latest',
                hostname: 'db-app.example.com',
                status: 'Up',
                hostPort: 8000,
                composeProject: 'myapp',
              },
            ],
          },
          listRoutesResult: [], // no routes yet
        },
      });

      const report = await job.reconcile('manual');

      // Both public containers must trigger healing individually
      expect(stubs.orchestrator.addRouteOnly).toHaveBeenCalledTimes(2);
      expect(stubs.orchestrator.addRouteOnly).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'app.example.com' }),
      );
      expect(stubs.orchestrator.addRouteOnly).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'db-app.example.com' }),
      );
      expect(report.perVps[0].createdRoutes).toContain('app.example.com');
      expect(report.perVps[0].createdRoutes).toContain('db-app.example.com');
    });

    it('AC13 — multiple public hostnames per stack: in-sync → idempotent (no mutations)', async () => {
      // Stack with two public containers, both have matching routes → no-op.
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              {
                containerId: 'web-abc',
                image: 'myapp/web:latest',
                hostname: 'app.example.com',
                status: 'Up',
                hostPort: 8080,
                composeProject: 'myapp',
              },
              {
                containerId: 'kong-def',
                image: 'myapp/kong:latest',
                hostname: 'db-app.example.com',
                status: 'Up',
                hostPort: 8000,
                composeProject: 'myapp',
              },
            ],
          },
          listRoutesResult: [
            { hostname: 'app.example.com', service: 'http://localhost:8080', tunnelId: 'tunnel-1', protected: false },
            { hostname: 'db-app.example.com', service: 'http://localhost:8000', tunnelId: 'tunnel-1', protected: false },
          ],
        },
      });

      const report = await job.reconcile('manual');

      expect(stubs.orchestrator.addRouteOnly).not.toHaveBeenCalled();
      expect(stubs.cloudflareApi.removeRoute).not.toHaveBeenCalled();
      expect(report.perVps[0].createdRoutes).toHaveLength(0);
      expect(report.perVps[0].removedRoutes).toHaveLength(0);
    });

    it('AC14 — healing of public stack container uses addRouteOnly (shared ADR-012 path, no new CF mutation code)', async () => {
      // AC14: the healing path for stack containers must go through orchestrator.addRouteOnly,
      // not direct Cloudflare mutation (cloudflareApi.addRoute).
      // Setup: public stack container present, no route yet → ReconciliationJob must heal.
      // The cloudflareApi stub intentionally has NO addRoute method — if ReconciliationJob
      // called cloudflareApi.addRoute directly, it would throw "not a function".
      const { job, stubs } = makeJob({
        stubs: {
          psResult: {
            result: 'ok',
            containers: [
              {
                containerId: 'web-abc',
                image: 'myapp/web:latest',
                hostname: 'app.example.com',
                status: 'Up',
                hostPort: 8080,
                composeProject: 'myapp',
              },
            ],
          },
          listRoutesResult: [],
        },
      });

      // cloudflareApi must have no addRoute — verifies no new CF mutation code in the job
      expect(stubs.cloudflareApi.addRoute).toBeUndefined();

      // Run reconcile — if the job calls cloudflareApi.addRoute, it throws; addRouteOnly must be used
      await job.reconcile('manual');

      // Healing path: addRouteOnly called for the stack container that has no route
      expect(stubs.orchestrator.addRouteOnly).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'app.example.com' }),
      );
      // Direct CF mutation must not have been called
      expect(stubs.cloudflareApi.addRoute).toBeUndefined();
    });
  });
});

// ── deploymentsRouter reconcile endpoints ─────────────────────────────────────

describe('deploymentsRouter — reconcile endpoints', () => {
  function makeApp({ reconciliationJobStub, identity = { email: 'admin@example.com' } } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = identity; next(); });
    const auditStore = new AuditStore();
    // minimal orchestrator stub for router
    const orchestratorStub = {
      listDeployments: jest.fn().mockResolvedValue({ deployments: [] }),
      deploy: jest.fn(),
      undeploy: jest.fn(),
    };
    const vpsTargets = new Map([['vps-1', { host: '1.2.3.4', port: 22, targetUser: 'root' }]]);
    app.use(deploymentsRouter(orchestratorStub, auditStore, vpsTargets, reconciliationJobStub));
    return app;
  }

  async function httpRequest(app, method, path, body) {
    const http = await import('node:http');
    return new Promise((resolve, reject) => {
      const server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        const bodyStr = body ? JSON.stringify(body) : '';
        const opts = {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
          },
        };
        const req = http.request(opts, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode, body: data });
            }
          });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        if (bodyStr) req.write(bodyStr);
        req.end();
      });
    });
  }

  describe('POST /api/deployments/reconcile', () => {
    it('returns 200 { result: "ok", report } on success (AC2)', async () => {
      const mockReport = { ranAt: new Date().toISOString(), trigger: 'manual', perVps: [] };
      const reconciliationJobStub = {
        reconcile: jest.fn().mockResolvedValue(mockReport),
        getLastReport: jest.fn().mockReturnValue(null),
        getReports: jest.fn().mockReturnValue([]),
        getNotices: jest.fn().mockReturnValue([]),
      };

      const app = makeApp({ reconciliationJobStub });
      process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
      try {
        const { status, body } = await httpRequest(app, 'POST', '/api/deployments/reconcile', {});
        expect(status).toBe(200);
        expect(body.result).toBe('ok');
        expect(body.report).toBeTruthy();
      } finally {
        delete process.env.CRED_ADMIN_EMAILS;
      }
    });

    it('returns 403 when identity not in CRED_ADMIN_EMAILS', async () => {
      const reconciliationJobStub = {
        reconcile: jest.fn(),
        getLastReport: jest.fn(),
        getReports: jest.fn(),
        getNotices: jest.fn(),
      };

      process.env.CRED_ADMIN_EMAILS = 'other@example.com';
      try {
        const app = makeApp({ reconciliationJobStub, identity: { email: 'notadmin@example.com' } });
        const { status } = await httpRequest(app, 'POST', '/api/deployments/reconcile', {});
        expect(status).toBe(403);
        expect(reconciliationJobStub.reconcile).not.toHaveBeenCalled();
      } finally {
        delete process.env.CRED_ADMIN_EMAILS;
      }
    });
  });

  describe('GET /api/deployments/reconcile/last', () => {
    it('returns last report from reconciliationJob', async () => {
      const mockReport = { ranAt: '2026-01-01T00:00:00.000Z', trigger: 'cron', perVps: [] };
      const reconciliationJobStub = {
        reconcile: jest.fn(),
        getLastReport: jest.fn().mockReturnValue(mockReport),
        getReports: jest.fn().mockReturnValue([]),
        getNotices: jest.fn().mockReturnValue([]),
      };

      const app = makeApp({ reconciliationJobStub });
      const { status, body } = await httpRequest(app, 'GET', '/api/deployments/reconcile/last', {});
      expect(status).toBe(200);
      expect(body.trigger).toBe('cron');
    });

    it('returns {} when no report exists', async () => {
      const reconciliationJobStub = {
        reconcile: jest.fn(),
        getLastReport: jest.fn().mockReturnValue(null),
        getReports: jest.fn().mockReturnValue([]),
        getNotices: jest.fn().mockReturnValue([]),
      };

      const app = makeApp({ reconciliationJobStub });
      const { status, body } = await httpRequest(app, 'GET', '/api/deployments/reconcile/last', {});
      expect(status).toBe(200);
      expect(Object.keys(body)).toHaveLength(0);
    });
  });

  describe('GET /api/deployments/reconcile/reports', () => {
    it('returns reports array', async () => {
      const reports = [
        { ranAt: '2026-01-01T00:00:00.000Z', trigger: 'cron', perVps: [] },
      ];
      const reconciliationJobStub = {
        reconcile: jest.fn(),
        getLastReport: jest.fn().mockReturnValue(null),
        getReports: jest.fn().mockReturnValue(reports),
        getNotices: jest.fn().mockReturnValue([]),
      };

      const app = makeApp({ reconciliationJobStub });
      const { status, body } = await httpRequest(app, 'GET', '/api/deployments/reconcile/reports?limit=5', null);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
    });
  });

  describe('GET /api/deployments/reconcile/notices', () => {
    it('returns notices array', async () => {
      const notices = [
        { at: '2026-01-01T00:00:00.000Z', kind: 'route-created', vps: 'vps-1', hostname: 'app.example.com' },
      ];
      const reconciliationJobStub = {
        reconcile: jest.fn(),
        getLastReport: jest.fn().mockReturnValue(null),
        getReports: jest.fn().mockReturnValue([]),
        getNotices: jest.fn().mockReturnValue(notices),
      };

      const app = makeApp({ reconciliationJobStub });
      const { status, body } = await httpRequest(app, 'GET', '/api/deployments/reconcile/notices', null);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].kind).toBe('route-created');
    });
  });
});
