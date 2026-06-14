/**
 * Router-Wrapper: Status-Endpunkt.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/status
 */
import { statusRouter } from '../statusRouter.js';

export const order = 30;

/**
 * @param {{ githubReader: import('../GitHubReader.js').GitHubReader, dockerReader: import('../DockerReader.js').DockerReader }} deps
 * @returns {import('express').Router}
 */
export function create({ githubReader, dockerReader }) {
  return statusRouter({ githubReader, dockerReader });
}
