/**
 * Router-Wrapper: Headless-Red-Team-Runner-Endpunkte.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/red-team/targets, POST /api/red-team, GET /api/red-team/:jobId
 * (docs/specs/red-team-tile.md AC2, AC3, AC4, AC5)
 *
 * order 53 — nach reconcile (52), damit die Router-Reihenfolge-Invarianten
 * von server.js unberührt bleiben (AC5).
 */
import { redTeamRouter } from '../redTeamRouter.js';

export const order = 53;

/**
 * @param {{
 *   redTeamRunner: import('../HeadlessRedTeamRunner.js').HeadlessRedTeamRunner,
 *   vpsDockerControl: import('../deploy/VpsDockerControl.js').VpsDockerControl,
 *   vpsRegistry: import('../vps/VpsProviderRegistry.js').VpsProviderRegistry,
 *   vpsTargets: Map<string, { host: string, port?: number, targetUser: string }>,
 *   workspaceScanner: import('../WorkspaceScanner.js').WorkspaceScanner,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ redTeamRunner, vpsDockerControl, vpsRegistry, vpsTargets, workspaceScanner }) {
  return redTeamRouter(redTeamRunner, { vpsDockerControl, vpsRegistry, vpsTargets, workspaceScanner });
}
