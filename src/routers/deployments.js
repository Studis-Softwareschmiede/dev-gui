/**
 * Router-Wrapper: Deploy-Lifecycle + Reconciliation + Stack-Deploy + Lokaler Image-Test (S-156)
 *                 + Readiness-Endpunkt (S-180 AC7–AC8)
 *                 + VPS-Tunnel-Read-Model (S-185 AC7)
 *                 + Tunnel-Selbstheilung Phase 1+2 (S-187 AC1–5, AC11, AC12).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET/POST/DELETE /api/deployments*, POST /api/deployments/reconcile,
 *           GET /api/deployments/reconcile/*, GET/POST/PUT/DELETE /api/deployments/stacks*,
 *           POST /api/deployments/local-test,
 *           GET  /api/deployments/readiness?vps=<vpsId>              [READ-ONLY, S-180]
 *           GET  /api/deployments/vps-tunnel-status                   [READ-ONLY, S-185 AC7]
 *           POST /api/deployments/vps/:vpsId/tunnel/recreate          [MUTATION, S-187]
 */
import { deploymentsRouter } from '../deploymentsRouter.js';
import { stacksRouter } from '../stacksRouter.js';
import { Router } from 'express';

export const order = 140;

/**
 * @param {{ deployOrchestrator: import('../deploy/DeployOrchestrator.js').DeployOrchestrator, auditStore: import('../AuditStore.js').AuditStore, vpsTargets: Map, reconciliationJob: import('../deploy/ReconciliationJob.js').ReconciliationJob, stackRegistry: import('../StackRegistry.js').StackRegistry, stackDeployOrchestrator: import('../deploy/StackDeployOrchestrator.js').StackDeployOrchestrator, localDockerControl: import('../deploy/LocalDockerControl.js').LocalDockerControl, vpsRegistry: import('../vps/VpsProviderRegistry.js').VpsProviderRegistry, vpsDockerControl: import('../deploy/VpsDockerControl.js').VpsDockerControl, cloudflareApi: import('../cloudflare/CloudflareApi.js').CloudflareApi, tunnelHealService: import('../deploy/TunnelHealService.js').TunnelHealService }} deps
 * @returns {import('express').Router}
 */
export function create({ deployOrchestrator, auditStore, vpsTargets, reconciliationJob, stackRegistry, stackDeployOrchestrator, localDockerControl, vpsRegistry, vpsDockerControl, cloudflareApi, tunnelHealService, bitwardenDeployAccessStore, bitwardenDeployLoginService }) {
  const combined = Router();
  // Kein Pfad-Präfix nötig: `combined.use(router)` ohne Pfad-Argument streift KEINEN
  // Pfad-Prefix ab — Requests werden unverändert weitergereicht. Beide Sub-Router
  // (deploymentsRouter, stacksRouter) tragen ihre absoluten Pfade (/api/deployments*,
  // /api/deployments/stacks*) selbst. Das Ergebnis ist semantisch identisch zu zwei
  // separaten `app.use(deploymentsRouter(...))` + `app.use(stacksRouter(...))` in server.js,
  // fasst sie aber in einem einzigen Modul zusammen.
  // S-167 AC3: vpsRegistry wird weitergereicht für dynamische VPS-Ziel-Auflösung im Dropdown.
  // S-180 AC7: vpsDockerControl wird weitergereicht für Readiness-Probe (read-only, kein Audit).
  // S-185 AC7: cloudflareApi wird weitergereicht für VPS-Tunnel-Read-Model (read-only, kein Audit).
  // S-187 AC1–5,11,12: tunnelHealService für Tunnel-Selbstheilung Phase 1+2.
  // F-072/S-334: deploy-Zugangs-Store + Login-Dienst für Guard + per-App-GPG-Passphrase-Injektion.
  combined.use(deploymentsRouter(deployOrchestrator, auditStore, vpsTargets, reconciliationJob, localDockerControl, vpsRegistry, vpsDockerControl, cloudflareApi, tunnelHealService, bitwardenDeployAccessStore, bitwardenDeployLoginService));
  combined.use(stacksRouter(stackRegistry, auditStore, { stackDeployOrchestrator, vpsTargets }));
  return combined;
}
