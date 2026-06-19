/**
 * Router-Wrapper: Deploy-Lifecycle + Reconciliation + Stack-Deploy + Lokaler Image-Test (S-156)
 *                 + Readiness-Endpunkt (S-180 AC7–AC8).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET/POST/DELETE /api/deployments*, POST /api/deployments/reconcile,
 *           GET /api/deployments/reconcile/*, GET/POST/PUT/DELETE /api/deployments/stacks*,
 *           POST /api/deployments/local-test,
 *           GET  /api/deployments/readiness?vps=<vpsId>  [READ-ONLY, S-180]
 */
import { deploymentsRouter } from '../deploymentsRouter.js';
import { stacksRouter } from '../stacksRouter.js';
import { Router } from 'express';

export const order = 140;

/**
 * @param {{ deployOrchestrator: import('../deploy/DeployOrchestrator.js').DeployOrchestrator, auditStore: import('../AuditStore.js').AuditStore, vpsTargets: Map, reconciliationJob: import('../deploy/ReconciliationJob.js').ReconciliationJob, stackRegistry: import('../StackRegistry.js').StackRegistry, stackDeployOrchestrator: import('../deploy/StackDeployOrchestrator.js').StackDeployOrchestrator, localDockerControl: import('../deploy/LocalDockerControl.js').LocalDockerControl, vpsRegistry: import('../vps/VpsProviderRegistry.js').VpsProviderRegistry, vpsDockerControl: import('../deploy/VpsDockerControl.js').VpsDockerControl }} deps
 * @returns {import('express').Router}
 */
export function create({ deployOrchestrator, auditStore, vpsTargets, reconciliationJob, stackRegistry, stackDeployOrchestrator, localDockerControl, vpsRegistry, vpsDockerControl }) {
  const combined = Router();
  // Kein Pfad-Präfix nötig: `combined.use(router)` ohne Pfad-Argument streift KEINEN
  // Pfad-Prefix ab — Requests werden unverändert weitergereicht. Beide Sub-Router
  // (deploymentsRouter, stacksRouter) tragen ihre absoluten Pfade (/api/deployments*,
  // /api/deployments/stacks*) selbst. Das Ergebnis ist semantisch identisch zu zwei
  // separaten `app.use(deploymentsRouter(...))` + `app.use(stacksRouter(...))` in server.js,
  // fasst sie aber in einem einzigen Modul zusammen.
  // S-167 AC3: vpsRegistry wird weitergereicht für dynamische VPS-Ziel-Auflösung im Dropdown.
  // S-180 AC7: vpsDockerControl wird weitergereicht für Readiness-Probe (read-only, kein Audit).
  combined.use(deploymentsRouter(deployOrchestrator, auditStore, vpsTargets, reconciliationJob, localDockerControl, vpsRegistry, vpsDockerControl));
  combined.use(stacksRouter(stackRegistry, auditStore, { stackDeployOrchestrator, vpsTargets }));
  return combined;
}
