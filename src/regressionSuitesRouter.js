/**
 * regressionSuitesRouter — Read-only Endpunkt für die verfügbaren
 * Regressionstest-Suiten (Bereich / Verbund / Gesamt) eines Projekt-Klons,
 * inklusive deklariertem `target` + (bei `ephemeral-infra`) Kosten-/
 * Ressourcen-Hinweis (docs/specs/regression-run.md AC4, AC6).
 *
 * Reine Lese-Naht für den Ausführen-Dialog ([[regression-run]] S-311,
 * `client/src/RegressionRunDialog.jsx`) — kein Schreibpfad, kein
 * Scaffold-Anlegen.
 *
 * Route (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   GET /api/projects/:slug/regression-suites → { suites: [...] }
 *
 * Slug→Pfad-Auflösung (Muster `regressionRunRouter.js`/`projectDrainRouter.js`,
 * security/R02/R03): Client sendet einen Slug, keinen absoluten Pfad. Erst
 * `resolveProjectSlug` (Slug-Form-Check gegen Traversal), dann
 * `validateProjectPath` (realpath-Containment gegen `WORKSPACE_DIR`).
 *
 * Security (Floor): read-only, keine Mutation, kein AccessGuard-Bypass;
 * keine Secrets in Response/Log (Begleitbeschreibungen enthalten laut
 * Vertrag keine Secrets).
 *
 * @module regressionSuitesRouter
 */

import { Router } from 'express';
import { validateProjectPath, ProjectPathError, resolveProjectSlug } from './workspacePath.js';
import { readRegressionSuites } from './RegressionSuiteReader.js';

/**
 * @param {object} [options]
 * @param {(path: string) => Promise<{ resolvedPath: string }>} [options.pathValidator]
 *   Injectable path validator (default: validateProjectPath). Inject a stub in tests.
 * @param {(slug: string|null) => string|null} [options.slugResolver]
 *   Injectable slug-to-path resolver (default: resolveProjectSlug).
 * @param {Function} [options.suiteReader] - injectable (default: readRegressionSuites).
 * @returns {import('express').Router}
 */
export function regressionSuitesRouter(options = {}) {
  const _pathValidator = options.pathValidator ?? validateProjectPath;
  const _slugResolver = options.slugResolver ?? resolveProjectSlug;
  const _suiteReader = options.suiteReader ?? readRegressionSuites;
  const router = Router();

  /**
   * GET /api/projects/:slug/regression-suites
   *
   * Responses:
   *   200 { suites: [ { scope: { typ, id? }, label, target?, kosten?, entries? } ] }
   *   400 { error }  — ungültiger Slug/Pfad
   */
  router.get('/api/projects/:slug/regression-suites', async (req, res) => {
    const rawSlug = req.params.slug;
    let resolvedPath;
    try {
      const slugPath = _slugResolver(rawSlug);
      if (slugPath === null) {
        return res.status(400).json({ error: 'Invalid project slug' });
      }
      ({ resolvedPath } = await _pathValidator(slugPath));
    } catch (err) {
      const reason = err instanceof ProjectPathError ? err.message : 'Invalid project path';
      return res.status(400).json({ error: `Invalid slug: ${reason}` });
    }

    try {
      const result = await _suiteReader(resolvedPath);
      return res.status(200).json(result);
    } catch (err) {
      console.error('[regressionSuitesRouter] Suite-Liste konnte nicht gelesen werden:', err.message);
      return res.status(200).json({ suites: [] });
    }
  });

  return router;
}
