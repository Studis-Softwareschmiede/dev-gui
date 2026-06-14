/**
 * Router-Wrapper: Workspace-Pfad-Konfiguration.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET/PUT/DELETE /api/settings/workspace-path
 */
import { workspacePathRouter } from '../workspacePathRouter.js';

export const order = 90;

/**
 * @param {{ credentialStore: import('../CredentialStore.js').CredentialStore, auditStore: import('../AuditStore.js').AuditStore }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore, auditStore }) {
  return workspacePathRouter(credentialStore, auditStore);
}
