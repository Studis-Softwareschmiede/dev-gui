/**
 * Router-Wrapper: GitHub-Repos schreiben (Repo anlegen).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/github/repos
 */
import { githubReposRouter } from '../githubReposRouter.js';

export const order = 80;

/**
 * @param {{ auditStore: import('../AuditStore.js').AuditStore, githubWriter: import('../GitHubWriter.js').GitHubWriter }} deps
 * @returns {import('express').Router}
 */
export function create({ auditStore, githubWriter }) {
  return githubReposRouter(auditStore, githubWriter);
}
