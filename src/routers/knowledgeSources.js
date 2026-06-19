/**
 * Router-Wrapper: Knowledge-Source-Endpunkt.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/assist/knowledge-sources
 *
 * Hinter /api AccessGuard (via server.js-Verdrahtung).
 * Zustandsloser claude -p one-shot (kein PTY-JobLock).
 * Spec: docs/specs/team-knowledge-add.md AC3, AC6, AC11, AC12, AC14, AC15.
 *
 * Architektur-Auflagen (bindend):
 *   A2 — KnowledgeSourceService (eigene Boundary, AssistService unverändert).
 *   A3 — claude -p mit --allowedTools WebSearch exklusiv.
 *   A6 — Audit-Eintrag hinter AccessGuard.
 */
import { knowledgeSourceRouter } from '../knowledgeSourceRouter.js';

export const order = 51;

/**
 * @param {{
 *   knowledgeSourceService: import('../KnowledgeSourceService.js').KnowledgeSourceService,
 *   auditStore: import('../AuditStore.js').AuditStore,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ knowledgeSourceService, auditStore }) {
  return knowledgeSourceRouter(knowledgeSourceService, auditStore);
}
