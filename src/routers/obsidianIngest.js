/**
 * Router-Wrapper: Headless-Obsidian-Ingest-Runner-Endpunkte.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/obsidian-ingest/start, GET /api/obsidian-ingest/:jobId,
 *           POST /api/obsidian-ingest/:jobId/answers
 * (docs/specs/obsidian-question-catalog.md AC1, AC2, AC4, AC5, AC6, AC7)
 */
import { obsidianIngestRouter } from '../obsidianIngestRouter.js';

export const order = 92;

/**
 * @param {{
 *   obsidianIngestRunner: import('../ObsidianIngestRunner.js').ObsidianIngestRunner,
 *   credentialStore: import('../CredentialStore.js').CredentialStore,
 *   auditStore?: import('../AuditStore.js').AuditStore,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ obsidianIngestRunner, credentialStore, auditStore }) {
  return obsidianIngestRouter(obsidianIngestRunner, { credentialStore, auditStore });
}
