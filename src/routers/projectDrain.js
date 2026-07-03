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
 *   costModeModelCheck: import('../CostModeModelCheck.js').CostModeModelCheck,
 *   drainReportStore: import('../DrainReportStore.js').DrainReportStore,
 *   autoRetroTrigger: import('../AutoRetroTrigger.js').AutoRetroTrigger,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ projectDrain, commandService, sessionRegistry, manualDrainLock, costModeModelCheck, drainReportStore, autoRetroTrigger }) {
  // headless-manual-drain AC2: die isProjectBusy-Prüfung MUSS gegen dieselbe
  // ProjectJobLock-Instanz laufen, die die dedizierte manuelle ProjectDrain-
  // Instanz als Session-Lock hält (via server.js injiziert) — sonst sieht der
  // Busy-Read den laufenden manuellen Drain nicht (→ Doppel-Start statt 409).
  //
  // cost-mode-model-check AC4/AC5: `costModeModelCheck` (dieselbe S-211-Boundary-
  // Instanz, in server.js verdrahtet) wird zusätzlich injiziert — der Router
  // stößt bei der Cost-Mode-Übergabe die Dispatch-Frische-Prüfung an (nicht-
  // blockierend) und reicht bei Drift die checkId ans Frontend durch.
  //
  // drain-completion-report AC5: `drainReportStore` (geteilte Instanz mit dem
  // Nacht-Drain, in server.js verdrahtet) — der Router schreibt bei Drain-
  // Abschluss best-effort GENAU EINEN Bericht (`trigger:'manual'`).
  //
  // retro-auto-trigger AC4–AC7: `autoRetroTrigger` (GETEILTE Instanz mit dem
  // Nacht-Drain, in server.js verdrahtet) — der Router stößt bei Drain-Abschluss
  // best-effort/fire-and-forget den Auto-Retro-Check an (isRetroDue → ggf. enqueue
  // in die geteilte RetroAutoQueue). Derselbe Check + dieselbe Queue wie nachts
  // (kein zweiter Codepfad, AC6/AC7).
  return projectDrainRouter(
    { projectDrain, commandService, sessionRegistry, costModeModelCheck, drainReportStore, autoRetroTrigger },
    { lock: manualDrainLock },
  );
}
