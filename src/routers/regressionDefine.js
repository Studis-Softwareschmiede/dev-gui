/**
 * Router-Wrapper: Headless-Regressionstest-Definier-Runner-Endpunkte.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/projects/:slug/regression-define,
 *           GET /api/projects/:slug/regression-define/:jobId,
 *           POST /api/projects/:slug/regression-define/:jobId/review
 * (docs/specs/regression-define-dialog.md AC1, AC2, AC3, AC4, AC5)
 */
import { regressionDefineRouter } from '../regressionDefineRouter.js';

export const order = 93;

/**
 * @param {{
 *   regressionDefineRunner: import('../RegressionDefineRunner.js').RegressionDefineRunner,
 *   auditStore?: import('../AuditStore.js').AuditStore,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ regressionDefineRunner, auditStore }) {
  return regressionDefineRouter(regressionDefineRunner, { auditStore });
}
