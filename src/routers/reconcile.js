/**
 * Router-Wrapper: Headless-Reconcile-Runner-Endpunkte.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/reconcile, GET /api/reconcile/:jobId
 * (docs/specs/headless-reconcile-runner.md AC8, AC9)
 */
import { reconcileRouter } from '../reconcileRouter.js';

export const order = 52;

/**
 * @param {{
 *   reconcileRunner: import('../HeadlessReconcileRunner.js').HeadlessReconcileRunner,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ reconcileRunner }) {
  return reconcileRouter(reconcileRunner);
}
