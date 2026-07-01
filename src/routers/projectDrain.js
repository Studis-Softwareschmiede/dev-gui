/**
 * Router-Wrapper: manueller „Board abarbeiten"-Knopf → ProjectDrain-Engine.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/projects/:slug/drain (taktgeber-nachtwaechter AC12)
 */
import { projectDrainRouter } from '../projectDrainRouter.js';

export const order = 21;

/**
 * @param {{
 *   projectDrain: import('../ProjectDrain.js').ProjectDrain,
 *   commandService: import('../CommandService.js').CommandService,
 *   sessionRegistry: import('../PtySessionRegistry.js').PtySessionRegistry,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ projectDrain, commandService, sessionRegistry }) {
  return projectDrainRouter({ projectDrain, commandService, sessionRegistry });
}
