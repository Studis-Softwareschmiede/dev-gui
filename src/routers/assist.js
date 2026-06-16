/**
 * Router-Wrapper: Assist-Refine-Endpunkt.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/assist/refine
 *
 * Hinter /api AccessGuard (via server.js-Verdrahtung).
 * Zustandsloser claude -p one-shot (kein PTY-JobLock).
 * Spec: docs/specs/fabric-intake-dialog.md AC5, AC7, AC10.
 */
import { assistRefineRouter } from '../assistRefineRouter.js';

export const order = 50;

/**
 * @param {{
 *   assistService: import('../AssistService.js').AssistService,
 *   auditStore: import('../AuditStore.js').AuditStore,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ assistService, auditStore }) {
  return assistRefineRouter(assistService, auditStore);
}
