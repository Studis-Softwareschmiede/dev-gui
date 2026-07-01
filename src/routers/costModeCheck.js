/**
 * Router-Wrapper: Cost-Mode-Modellprüfung Status-Endpunkt.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/cost-mode/check/:checkId
 * (docs/specs/cost-mode-model-check.md AC7)
 */
import { costModeCheckRouter } from '../costModeCheckRouter.js';

export const order = 53;

/**
 * @param {{
 *   costModeModelCheck: import('../CostModeModelCheck.js').CostModeModelCheck,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ costModeModelCheck }) {
  return costModeCheckRouter(costModeModelCheck);
}
