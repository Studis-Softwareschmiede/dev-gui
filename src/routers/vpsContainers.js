/**
 * Router-Wrapper: VPS-Container-Übersicht + Aktionen (vps-container-overview).
 * Factory-Signatur: create(deps) → Express Router
 *
 * Montiert:
 *   GET    /api/vps/machines/:provider/*splat/containers
 *   GET    /api/vps/machines/:provider/*splat/containers/:containerId/logs
 *   POST   /api/vps/machines/:provider/*splat/containers/:containerId/start
 *   POST   /api/vps/machines/:provider/*splat/containers/:containerId/stop
 *   POST   /api/vps/machines/:provider/*splat/containers/:containerId/restart
 *   DELETE /api/vps/machines/:provider/*splat/containers/:containerId
 *   POST   /api/vps/machines/:provider/*splat/containers/:containerId/update
 *
 * Implements: vps-container-overview AC8–AC12, container-image-update AC1–AC4/AC7/AC10–AC12
 */
import { vpsContainerRouter } from '../vpsContainerRouter.js';

/** Mountreihenfolge: VOR vps.js (order 120), damit /containers/:id-Routen
 * vor dem greedy DELETE /*splat in vpsRouter matched werden. */
export const order = 119;

/**
 * @param {{
 *   vpsDockerControl: import('../deploy/VpsDockerControl.js').VpsDockerControl,
 *   deployOrchestrator: import('../deploy/DeployOrchestrator.js').DeployOrchestrator,
 *   auditStore: import('../AuditStore.js').AuditStore,
 *   vpsRegistry: import('../vps/VpsProviderRegistry.js').VpsProviderRegistry,
 *   vpsTargets: Map<string, { host: string, port?: number, targetUser: string }>,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ vpsDockerControl, deployOrchestrator, auditStore, vpsRegistry, vpsTargets }) {
  return vpsContainerRouter({ vpsDockerControl, deployOrchestrator, auditStore, vpsRegistry, vpsTargets });
}
