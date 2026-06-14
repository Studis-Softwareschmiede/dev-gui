/**
 * Router-Wrapper: Credential-Verwaltung.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET/PUT/DELETE /api/settings/credentials*
 */
import { credentialsRouter } from '../credentialsRouter.js';

export const order = 50;

/**
 * @param {{ credentialStore: import('../CredentialStore.js').CredentialStore, auditStore: import('../AuditStore.js').AuditStore }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore, auditStore }) {
  return credentialsRouter(credentialStore, auditStore);
}
