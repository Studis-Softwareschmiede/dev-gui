/**
 * Router-Wrapper: Session-Endpunkt.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/session
 *
 * reconcile-inline-feedback (S-205) AC6 — Vertragsänderung: `state` muss
 * `busy` melden, solange ein Command-Job in Flight ist (CommandService-Status
 * `running`), unabhängig vom reinen PTY-Lebenszyklus (`ptyManager.state`).
 * Vorher reflektierte diese Route nur den PTY-Zustand (starting/ready/stopped/
 * failed) — ein laufender Job wurde nie als `busy` sichtbar. `commandService`
 * ist optional (Rückwärtskompatibilität für Aufrufer ohne Command-Layer);
 * fehlt sie, bleibt das alte Verhalten (nur `ptyManager.state`) erhalten.
 */
import { Router } from 'express';

export const order = 25;

/**
 * @param {{
 *   ptyManager: import('../PtyManager.js').PtyManager,
 *   commandService?: import('../CommandService.js').CommandService,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ ptyManager, commandService }) {
  const router = Router();

  /**
   * GET /api/session → { state, restarts, startedAt }
   *
   * `state` ist `busy`, solange commandService.getStatus().status === 'running'
   * (S-205 AC6) — sonst der reine PTY-Lebenszyklus-Zustand (starting/ready/
   * stopped/failed), unverändert wie zuvor.
   */
  router.get('/api/session', (_req, res) => {
    const jobRunning = commandService?.getStatus?.().status === 'running';
    res.json({
      state: jobRunning ? 'busy' : ptyManager.state,
      restarts: ptyManager.restarts,
      startedAt: ptyManager.startedAt,
    });
  });

  return router;
}
