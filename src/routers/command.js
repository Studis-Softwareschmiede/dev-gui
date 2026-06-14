/**
 * Router-Wrapper: Command-Endpunkte.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/command, POST /api/command/cancel
 */
import { commandRouter } from '../commandRouter.js';

export const order = 20;

/**
 * @param {{ commandService: import('../CommandService.js').CommandService }} deps
 * @returns {import('express').Router}
 */
export function create({ commandService }) {
  return commandRouter(commandService);
}
