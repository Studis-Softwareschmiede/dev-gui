/**
 * Router-Wrapper: GitHub-Repos-Übersicht.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/github/repos (list)
 */
import { githubReposListRouter } from '../githubReposListRouter.js';

export const order = 40;

/**
 * @param {{ githubReader: import('../GitHubReader.js').GitHubReader }} deps
 * @returns {import('express').Router}
 */
export function create({ githubReader }) {
  return githubReposListRouter({ githubReader });
}
