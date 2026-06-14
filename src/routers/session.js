/**
 * Router-Wrapper: Session-Endpunkt.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/session
 */
import { Router } from 'express';

export const order = 25;

/**
 * @param {{ ptyManager: import('../PtyManager.js').PtyManager }} deps
 * @returns {import('express').Router}
 */
export function create({ ptyManager }) {
  const router = Router();

  /**
   * GET /api/session → { state, restarts, startedAt }
   */
  router.get('/api/session', (_req, res) => {
    res.json({
      state: ptyManager.state,
      restarts: ptyManager.restarts,
      startedAt: ptyManager.startedAt,
    });
  });

  return router;
}
