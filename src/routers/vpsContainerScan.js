/**
 * Router-Wrapper: Pro-Container Red-Team-Scan-Endpunkt (den bestehenden
 * HeadlessRedTeamRunner hinter dem confinierten Pro-Container-Endpunkt).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert:
 *   POST /api/vps/machines/:provider/*splat/containers/:containerId/scan
 *   GET  /api/vps/machines/:provider/*splat/containers/:containerId/scan/:jobId
 * (docs/specs/red-team-scan-per-container.md AC1, AC2, AC3, AC4, AC5, AC6, AC22)
 *
 * order 119 — vor vps.js (order 120), analog vpsContainers.js: der greedy
 * `DELETE /api/vps/machines/:provider/*splat`-Fallback in vps.js darf diese
 * spezifischeren `.../containers/:containerId/scan`-Routen nicht abfangen.
 */
import { vpsContainerScanRouter } from '../vpsContainerScanRouter.js';

export const order = 119;

/**
 * @param {{
 *   redTeamRunner: import('../HeadlessRedTeamRunner.js').HeadlessRedTeamRunner,
 *   vpsDockerControl: import('../deploy/VpsDockerControl.js').VpsDockerControl,
 *   vpsRegistry: import('../vps/VpsProviderRegistry.js').VpsProviderRegistry,
 *   vpsTargets: Map<string, { host: string, port?: number, targetUser: string }>,
 *   workspaceScanner: import('../WorkspaceScanner.js').WorkspaceScanner,
 *   scanResultStore?: object,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ redTeamRunner, vpsDockerControl, vpsRegistry, vpsTargets, workspaceScanner, scanResultStore }) {
  return vpsContainerScanRouter(redTeamRunner, {
    vpsDockerControl,
    vpsRegistry,
    vpsTargets,
    workspaceScanner,
    scanResultStore,
  });
}
