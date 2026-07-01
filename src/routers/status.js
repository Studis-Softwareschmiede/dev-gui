/**
 * Router-Wrapper: Status-Endpunkt.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/status
 *
 * claudeAuthHealthService (claude-auth-health AC4, optional — graceful degradation
 * auf 'unknown'/null im statusRouter, falls nicht verdrahtet).
 */
import { statusRouter } from '../statusRouter.js';

export const order = 30;

/**
 * @param {{
 *   githubReader: import('../GitHubReader.js').GitHubReader,
 *   dockerReader: import('../DockerReader.js').DockerReader,
 *   claudeAuthHealthService?: import('../ClaudeAuthHealthService.js').ClaudeAuthHealthService,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ githubReader, dockerReader, claudeAuthHealthService }) {
  return statusRouter({ githubReader, dockerReader, claudeAuthHealthService });
}
