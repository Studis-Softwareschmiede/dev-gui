/**
 * costModeCheckRouter — Express-Router für den Status-Endpunkt der
 * Cost-Mode-Modellprüfung (docs/specs/cost-mode-model-check.md AC7).
 *
 * Route (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   GET /api/cost-mode/check/:checkId
 *     → 200 { status: 'running'|'done'|'failed', changed?, before?, after? }
 *     → 404 { error }  (unbekannte checkId — auch nach Server-Neustart/Registry-Verlust)
 *
 * Der OPTIONALE manuelle POST-Anstoß (`POST /api/cost-mode/check`) ist bewusst
 * NICHT Teil dieser Story (Kern S-211): die Boot-/periodischen Auslöser brauchen
 * ihn nicht (interner Tick, `CostModeModelCheck.start()`), und der Dispatch-/
 * Frontend-Anteil (AC4/AC5) ist Folge-Story S-228. Kein Gold-Plating (coder/R01).
 *
 * Getrennt vom interaktiven PTY-Pfad — nutzt ausschließlich die
 * `CostModeModelCheck`-Registry, keinen `CommandService`/`PtyManager`-Import.
 *
 * Security (Floor): keine Secrets in Response/Log; `checkId` ist eine reine
 * Korrelations-ID (`randomUUID()`), kein Secret; `before`/`after` enthalten nur
 * das nicht-geheime `last_curated`-Datum (secret-/pfad-frei aus der Registry).
 *
 * @module costModeCheckRouter
 */

import { Router } from 'express';

/**
 * @param {import('./CostModeModelCheck.js').CostModeModelCheck} costModeModelCheck
 * @returns {import('express').Router}
 */
export function costModeCheckRouter(costModeModelCheck) {
  const router = Router();

  /**
   * GET /api/cost-mode/check/:checkId
   *
   * Responses:
   *   200 { status, changed?, before?, after? }
   *   404 { error }  — unbekannte checkId
   */
  router.get('/api/cost-mode/check/:checkId', (req, res) => {
    const check = costModeModelCheck.getCheck(req.params.checkId);
    if (!check) {
      return res.status(404).json({ error: 'Unknown checkId' });
    }

    const body = { status: check.status };
    if (check.changed !== undefined) body.changed = check.changed;
    if (check.before !== undefined) body.before = check.before;
    if (check.after !== undefined) body.after = check.after;

    return res.status(200).json(body);
  });

  return router;
}
