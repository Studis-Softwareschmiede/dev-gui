/**
 * Router-Wrapper: GitHub-Repo klonen.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/github/repos/clone
 */
import { githubRepoCloneRouter } from '../githubRepoCloneRouter.js';

export const order = 110;

/**
 * @param {{ auditStore: import('../AuditStore.js').AuditStore, githubCloner: import('../GitHubCloner.js').GitHubCloner }} deps
 * @returns {import('express').Router}
 */
export function create({ auditStore, githubCloner }) {
  return githubRepoCloneRouter(auditStore, githubCloner);
}
