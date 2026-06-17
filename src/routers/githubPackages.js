/**
 * Router-Wrapper: GHCR-Image-Liste — Container-Pakete + Tags aus GitHub Packages.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert:
 *   GET /api/github/packages          (AC2 — Image-Liste)
 *   GET /api/github/packages/:name/tags (AC3 — Tag-Liste)
 *
 * Spec: docs/specs/ghcr-image-list.md (AC1–AC5)
 */
import { githubPackagesRouter } from '../githubPackagesRouter.js';

export const order = 45;

/**
 * @param {{ githubPackagesReader: import('../GitHubPackagesReader.js').GitHubPackagesReader }} deps
 * @returns {import('express').Router}
 */
export function create({ githubPackagesReader }) {
  return githubPackagesRouter({ githubPackagesReader });
}
