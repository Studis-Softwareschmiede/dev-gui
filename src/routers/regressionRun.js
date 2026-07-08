/**
 * Router-Wrapper: deterministischer Regressionstest-Ausführen-Runner-Endpunkt.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/projects/:slug/regression-run,
 *           GET  /api/projects/:slug/regression-run/:runId
 * (docs/specs/regression-run.md AC1, AC2, AC3, AC5, AC9)
 */
import { regressionRunRouter } from '../regressionRunRouter.js';

export const order = 95;

/**
 * @param {{
 *   regressionRunner: import('../RegressionRunner.js').RegressionRunner,
 *   auditStore?: import('../AuditStore.js').AuditStore,
 *   commandService?: { getStatus: () => { status: string|null } },
 *   sessionRegistry?: { hasSession: (p: string) => boolean },
 *   manualDrainLock?: import('../ProjectJobLock.js').ProjectJobLock,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ regressionRunner, auditStore, commandService, sessionRegistry, manualDrainLock }) {
  // AC2 Busy-Check: `manualDrainLock` ist dieselbe Instanz, die die dedizierte
  // manuelle ProjectDrain-Instanz als Session-Lock hält (server.js) — sonst
  // sieht der Busy-Read einen laufenden manuellen Drain nicht (Muster
  // projectDrain.js Router). `sessionRegistry` (ptyRegistry) deckt zusätzlich
  // den Nacht-Drain ab (PTY-Session-Attach während des Nacht-Drains).
  return regressionRunRouter(regressionRunner, {
    auditStore,
    commandService,
    sessionRegistry,
    drainLock: manualDrainLock,
  });
}
