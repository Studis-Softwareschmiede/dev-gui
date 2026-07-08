/**
 * Router-Wrapper: Regressionstest-Suite-Liste (read-only, docs/specs/regression-run.md AC4/AC6).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/projects/:slug/regression-suites
 */
import { regressionSuitesRouter } from '../regressionSuitesRouter.js';

export const order = 96;

/**
 * @param {object} [_deps] - keine Boundary-Abhängigkeiten nötig (reiner FS-Scan über die validierte Slug-Auflösung).
 * @returns {import('express').Router}
 */
export function create(_deps) {
  return regressionSuitesRouter();
}
