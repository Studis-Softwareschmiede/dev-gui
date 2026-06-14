/**
 * Router-Wrapper: Workspace-Repos.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/workspace/repos, POST /api/workspace/repos/pull, POST /api/workspace/repos/delete
 */
import { workspaceReposRouter } from '../workspaceReposRouter.js';

export const order = 100;

/**
 * @param {{ workspaceScanner: import('../WorkspaceScanner.js').WorkspaceScanner, auditStore: import('../AuditStore.js').AuditStore, workspaceMutator: import('../WorkspaceMutator.js').WorkspaceMutator, credentialStore: import('../CredentialStore.js').CredentialStore }} deps
 * @returns {import('express').Router}
 */
export function create({ workspaceScanner, auditStore, workspaceMutator, credentialStore }) {
  return workspaceReposRouter(workspaceScanner, auditStore, workspaceMutator, credentialStore);
}
