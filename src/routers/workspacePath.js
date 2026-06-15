/**
 * Router-Wrapper: Workspace-Pfad-Konfiguration + Workspace-Health (workspace-health-hinweis AC2).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET/PUT/DELETE /api/settings/workspace-path
 *           GET            /api/settings/workspace-health
 */
import { workspacePathRouter } from '../workspacePathRouter.js';
import { WorkspaceHealthChecker } from '../WorkspaceHealthChecker.js';

export const order = 90;

/**
 * @param {{
 *   credentialStore: import('../CredentialStore.js').CredentialStore,
 *   auditStore: import('../AuditStore.js').AuditStore,
 *   workspaceScanner: import('../WorkspaceScanner.js').WorkspaceScanner,
 *   boardAggregator: import('../BoardAggregator.js').BoardAggregator,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore, auditStore, workspaceScanner, boardAggregator }) {
  const healthChecker = new WorkspaceHealthChecker({
    listClonesFn: () => workspaceScanner.listClones(),
    getIndexFn: () => boardAggregator.getIndex(),
  });
  return workspacePathRouter(credentialStore, auditStore, { healthChecker });
}
