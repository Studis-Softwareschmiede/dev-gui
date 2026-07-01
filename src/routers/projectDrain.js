/**
 * Router-Wrapper: manueller „Board abarbeiten"-Knopf → ProjectDrain-Engine.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/projects/:slug/drain + GET /api/projects/:slug/drain/:drainId
 * (headless-manual-drain AC1/AC2/AC3/AC4, ADR-017 — ersetzt den interaktiven
 * Pfad aus taktgeber-nachtwaechter AC12). Die In-Memory-Drain-Job-Registry
 * (AC4) lebt router-intern (Default-Instanz); kein Wiring nötig.
 */
import { projectDrainRouter } from '../projectDrainRouter.js';

export const order = 21;

/**
 * @param {{
 *   projectDrain: import('../ProjectDrain.js').ProjectDrain,
 *   commandService: import('../CommandService.js').CommandService,
 *   sessionRegistry: import('../PtySessionRegistry.js').PtySessionRegistry,
 *   manualDrainLock: import('../ProjectJobLock.js').ProjectJobLock,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ projectDrain, commandService, sessionRegistry, manualDrainLock }) {
  // headless-manual-drain AC2: die isProjectBusy-Prüfung MUSS gegen dieselbe
  // ProjectJobLock-Instanz laufen, die die dedizierte manuelle ProjectDrain-
  // Instanz als Session-Lock hält (via server.js injiziert) — sonst sieht der
  // Busy-Read den laufenden manuellen Drain nicht (→ Doppel-Start statt 409).
  return projectDrainRouter({ projectDrain, commandService, sessionRegistry }, { lock: manualDrainLock });
}
