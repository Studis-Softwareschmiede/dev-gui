/**
 * reconcileRouter — Express router für den Headless-Reconcile-Runner
 * (docs/specs/headless-reconcile-runner.md AC8, AC9).
 *
 * Routes (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/reconcile          — startet einen Reconcile-Job für ein Projekt
 *   GET  /api/reconcile/:jobId   — liefert den aktuellen Job-Status
 *
 * Getrennt vom interaktiven PTY-Pfad (AC7) — nutzt ausschliesslich den neuen
 * `HeadlessReconcileRunner`, keinen `CommandService`/`PtyManager`-Import.
 *
 * Slug→Pfad-Auflösung (Muster `commandRouter.js`/`projectDrainRouter.js`,
 * security/R02/R03): Der Client sendet einen Slug (Repo-Verzeichnisname),
 * keinen absoluten Pfad. Erst `resolveProjectSlug` (Slug-Form-Check gegen
 * Traversal), dann `validateProjectPath` (realpath-Containment gegen
 * `WORKSPACE_DIR`) — identischer Auflösungspfad wie beim bestehenden
 * `POST /api/command`.
 *
 * Kein `projectSlug`-Fallback auf eine globale Session (anders als
 * `/api/command`): der Headless-Runner ist stets projektgebunden (Edge-Case,
 * AC8) — ein leerer/fehlender Slug ist immer 400.
 *
 * Security (Floor): keine Secrets in Response/Log; `jobId` ist eine reine
 * Korrelations-ID (`randomUUID()` im Runner), kein Secret; `error`/`result`
 * kommen ausschliesslich aus dem Runner (bereits secret-/pfad-frei, AC9).
 *
 * @module reconcileRouter
 */

import { Router } from 'express';
import { validateProjectPath, ProjectPathError, resolveProjectSlug } from './workspacePath.js';

/**
 * @param {import('./HeadlessReconcileRunner.js').HeadlessReconcileRunner} runner
 * @param {object} [options]
 * @param {(path: string) => Promise<{ resolvedPath: string }>} [options.pathValidator]
 *   Injectable path validator (default: validateProjectPath). Inject a stub in tests.
 * @param {(slug: string|null, deps?: object) => string|null} [options.slugResolver]
 *   Injectable slug-to-path resolver (default: resolveProjectSlug).
 * @returns {import('express').Router}
 */
export function reconcileRouter(runner, options = {}) {
  const _pathValidator = options.pathValidator ?? validateProjectPath;
  const _slugResolver = options.slugResolver ?? resolveProjectSlug;
  const router = Router();

  /**
   * POST /api/reconcile
   * Body: { projectSlug: string }
   *
   * Responses:
   *   202 { jobId, status: "running" }
   *   400 { error }  — fehlender/ungültiger/Traversal-Slug
   *   409 { error }  — Projekt-Sperre (bereits ein laufender Reconcile-Job)
   */
  router.post('/api/reconcile', async (req, res) => {
    const { projectSlug } = req.body ?? {};

    // Edge-Case: kein projectSlug → 400 (der Headless-Runner ist stets
    // projektgebunden, anders als der globale /api/command-Fallback).
    if (typeof projectSlug !== 'string' || projectSlug.trim() === '') {
      return res.status(400).json({ error: 'projectSlug is required' });
    }

    let resolvedPath;
    try {
      const slugPath = _slugResolver(projectSlug);
      // Defensive: with the real resolveProjectSlug() this branch is unreachable here,
      // since the empty/non-string projectSlug case is already rejected above (line ~61) —
      // resolveProjectSlug() only returns null for null/undefined/empty input. Kept as a
      // guard against an injected/mocked slugResolver (tests) that returns null.
      if (slugPath === null) {
        return res.status(400).json({ error: 'Invalid project slug' });
      }
      const { resolvedPath: p } = await _pathValidator(slugPath);
      resolvedPath = p;
    } catch (err) {
      const reason = err instanceof ProjectPathError ? err.message : 'Invalid project path';
      return res.status(400).json({ error: `Invalid projectSlug: ${reason}` });
    }

    const result = runner.start(resolvedPath);
    if (!result.ok) {
      // Aktuell einzige Ablehnungs-Ursache: 'locked' (AC5/AC8).
      return res.status(409).json({ error: 'Reconcile already running for this project' });
    }

    return res.status(202).json({ jobId: result.jobId, status: 'running' });
  });

  /**
   * GET /api/reconcile/:jobId
   *
   * Responses:
   *   200 { status, result?, error?, prHint? }
   *   404 { error }  — unbekannte jobId (auch nach Server-Neustart, AC9 Edge-Case)
   */
  router.get('/api/reconcile/:jobId', (req, res) => {
    const job = runner.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown jobId' });
    }

    const body = { status: job.status };
    if (job.result !== undefined) body.result = job.result;
    if (job.error !== undefined) body.error = job.error;
    if (job.prHint !== undefined) body.prHint = job.prHint;

    return res.status(200).json(body);
  });

  return router;
}
