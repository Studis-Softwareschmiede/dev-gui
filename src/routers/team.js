/**
 * Router-Wrapper: Team-Ansicht.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/team, GET /api/team/:kind/:id
 */
import { teamRouter } from '../teamRouter.js';

export const order = 160;

/**
 * @param {{ agentFlowReader: import('../AgentFlowReader.js').AgentFlowReader }} deps
 * @returns {import('express').Router}
 */
export function create({ agentFlowReader }) {
  return teamRouter({ agentFlowReader });
}
