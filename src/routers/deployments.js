/**
 * Router-Wrapper: Deploy-Lifecycle + Reconciliation + Stack-Deploy.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET/POST/DELETE /api/deployments*, POST /api/deployments/reconcile,
 *           GET /api/deployments/reconcile/*, GET/POST/PUT/DELETE /api/deployments/stacks*
 */
import { deploymentsRouter } from '../deploymentsRouter.js';
import { stacksRouter } from '../stacksRouter.js';
import { Router } from 'express';

export const order = 140;

/**
 * @param {{ deployOrchestrator: import('../deploy/DeployOrchestrator.js').DeployOrchestrator, auditStore: import('../AuditStore.js').AuditStore, vpsTargets: Map, reconciliationJob: import('../deploy/ReconciliationJob.js').ReconciliationJob, stackRegistry: import('../StackRegistry.js').StackRegistry, stackDeployOrchestrator: import('../deploy/StackDeployOrchestrator.js').StackDeployOrchestrator }} deps
 * @returns {import('express').Router}
 */
export function create({ deployOrchestrator, auditStore, vpsTargets, reconciliationJob, stackRegistry, stackDeployOrchestrator }) {
  const combined = Router();
  // Kein Pfad-Präfix nötig: `combined.use(router)` ohne Pfad-Argument streift KEINEN
  // Pfad-Prefix ab — Requests werden unverändert weitergereicht. Beide Sub-Router
  // (deploymentsRouter, stacksRouter) tragen ihre absoluten Pfade (/api/deployments*,
  // /api/deployments/stacks*) selbst. Das Ergebnis ist semantisch identisch zu zwei
  // separaten `app.use(deploymentsRouter(...))` + `app.use(stacksRouter(...))` in server.js,
  // fasst sie aber in einem einzigen Modul zusammen.
  combined.use(deploymentsRouter(deployOrchestrator, auditStore, vpsTargets, reconciliationJob));
  combined.use(stacksRouter(stackRegistry, auditStore, { stackDeployOrchestrator, vpsTargets }));
  return combined;
}
