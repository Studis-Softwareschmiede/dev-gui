/**
 * regressionDefineRouter — Express-Router für den Headless-
 * Regressionstest-Definier-Runner (docs/specs/regression-define-dialog.md
 * AC1, AC2, AC3, AC4, AC5).
 *
 * Routes (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/projects/:slug/regression-define             — startet den headless Definitions-Lauf
 *   GET  /api/projects/:slug/regression-define/:jobId       — Status + (bei needs-review) NL-Vorschlag
 *   POST /api/projects/:slug/regression-define/:jobId/review — redigierte Fassung → Resume
 *
 * Getrennt vom interaktiven PTY-Pfad — nutzt ausschließlich den neuen
 * `RegressionDefineRunner` (eigene `ProjectJobLock`-Instanz), keinen
 * `CommandService`/`PtyManager`-Import.
 *
 * Slug→Pfad-Auflösung (Muster `projectDrainRouter.js`, security/R02/R03):
 *   Der Client sendet einen Slug (Repo-Verzeichnisname), keinen absoluten
 *   Pfad. Erst `resolveProjectSlug` (Slug-Form-Check gegen Traversal), dann
 *   `validateProjectPath` (realpath-Containment gegen `WORKSPACE_DIR`) —
 *   identischer Auflösungspfad wie beim bestehenden Drain-/Command-Router.
 *
 * Eingabe-Vertrag (AC4): Body `{ ziel: { typ: "bereich"|"verbund", id }, stichworte?: [] }`.
 * `ziel` wird autoritativ serverseitig validiert (Defense in Depth, Router UND
 * Runner prüfen), bevor der Runner gestartet wird.
 *
 * Audit-First-Konvention (analog `obsidianIngestRouter`): Format-/Existenz-/
 * State-Vorprüfungen werden OHNE Audit abgelehnt; genau EIN Audit-Eintrag je
 * akzeptiertem Job-Start bzw. Review-Turn (Identität aus `req.identity`);
 * schlägt der Audit-Write fehl, wird die Aktion NICHT ausgeführt. Ende-/Fehler-
 * Audit je Lauf schreibt der `RegressionDefineRunner` selbst (AC5).
 *
 * Security (Floor): keine Secrets in Response/Log; `jobId` ist eine reine
 * Korrelations-ID (`randomUUID()` im Runner), kein Secret; `vorschlag`/`error`/
 * `result` kommen ausschließlich aus dem Runner (bereits secret-/pfad-frei).
 *
 * @module regressionDefineRouter
 */

import { Router } from 'express';
import { validateProjectPath, ProjectPathError, resolveProjectSlug } from './workspacePath.js';
import { validateZiel } from './RegressionDefineRunner.js';

/**
 * Extrahiert den identity-String aus `req.identity` (AccessGuard-Claim) — analog
 * `obsidianIngestRouter`/`projectDrainRouter`.
 * @param {object|null} identity
 * @returns {string|null}
 */
function _resolveIdentity(identity) {
  return identity?.email ?? null;
}

/**
 * @param {import('./RegressionDefineRunner.js').RegressionDefineRunner} runner
 * @param {object} [options]
 * @param {(path: string) => Promise<{ resolvedPath: string }>} [options.pathValidator]
 *   Injectable path validator (default: validateProjectPath). Inject a stub in tests.
 * @param {(slug: string|null) => string|null} [options.slugResolver]
 *   Injectable slug-to-path resolver (default: resolveProjectSlug).
 * @param {import('./AuditStore.js').AuditStore} [options.auditStore] - optional (AC5).
 * @returns {import('express').Router}
 */
export function regressionDefineRouter(runner, options = {}) {
  const _pathValidator = options.pathValidator ?? validateProjectPath;
  const _slugResolver = options.slugResolver ?? resolveProjectSlug;
  const _auditStore = options.auditStore ?? null;
  const router = Router();

  /**
   * Löst + validiert den Projekt-Slug auf (s. Modul-Kommentar).
   *
   * @param {string} rawSlug
   * @returns {Promise<{ ok: true, resolvedPath: string } | { ok: false, status: number, error: string }>}
   */
  async function resolveSlug(rawSlug) {
    try {
      const slugPath = _slugResolver(rawSlug);
      if (slugPath === null) {
        return { ok: false, status: 400, error: 'Invalid project slug' };
      }
      const { resolvedPath } = await _pathValidator(slugPath);
      return { ok: true, resolvedPath };
    } catch (err) {
      const reason = err instanceof ProjectPathError ? err.message : 'Invalid project path';
      return { ok: false, status: 400, error: `Invalid slug: ${reason}` };
    }
  }

  /**
   * POST /api/projects/:slug/regression-define
   * Body: { ziel: { typ: "bereich"|"verbund", id: string }, stichworte?: string[] }
   *
   * Responses:
   *   202 { jobId, status: "running" }
   *   400 { error }  — ungültiger Slug/Pfad ODER ungültiges `ziel`
   *   409 { error }  — Projekt-Sperre (bereits ein laufender/offener Definitions-Lauf)
   *   500 { error }  — Audit-Lesefehler (Aktion abgebrochen)
   */
  router.post('/api/projects/:slug/regression-define', async (req, res) => {
    const rawSlug = req.params.slug;
    const resolved = await resolveSlug(rawSlug);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error });
    }

    const { ziel, stichworte } = req.body ?? {};
    const validated = validateZiel(ziel);
    if (!validated.ok) {
      return res.status(400).json({ error: 'Invalid ziel: erwartet { typ: "bereich"|"verbund", id }' });
    }

    let stichworteList = [];
    if (stichworte !== undefined) {
      if (!Array.isArray(stichworte) || !stichworte.every((s) => typeof s === 'string')) {
        return res.status(400).json({ error: 'stichworte must be an array of strings' });
      }
      stichworteList = stichworte;
    }

    // Audit-First (genau EIN Eintrag je akzeptiertem Job-Start, AC5): schlägt
    // record() fehl, wird der Runner NICHT gestartet.
    const identity = _resolveIdentity(req.identity ?? null);
    if (_auditStore) {
      try {
        _auditStore.record({ identity, command: 'regression-define:start' });
      } catch (auditErr) {
        console.error('[regressionDefineRouter] Audit-Write fehlgeschlagen (start):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    const result = runner.start(resolved.resolvedPath, rawSlug, validated.ziel, stichworteList, { identity });
    if (!result.ok) {
      // Aktuell einzige Ablehnungs-Ursache: 'locked' (AC1/AC2, Parallel-Start).
      return res.status(409).json({ error: 'Regressions-Definitionslauf läuft bereits für dieses Projekt.' });
    }

    return res.status(202).json({ jobId: result.jobId, status: 'running' });
  });

  /**
   * GET /api/projects/:slug/regression-define/:jobId
   *
   * Responses:
   *   200 { status, vorschlag?, result?, error? }
   *        status ∈ {running, needs-review, done, failed, auth-expired};
   *        `vorschlag` nur bei needs-review (AC2). Secret-frei.
   *   400 { error }  — ungültiger Slug/Pfad
   *   404 { error }  — unbekannte jobId (auch nach Server-Neustart)
   */
  router.get('/api/projects/:slug/regression-define/:jobId', async (req, res) => {
    const resolved = await resolveSlug(req.params.slug);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error });
    }

    const job = runner.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown jobId' });
    }

    const body = { status: job.status };
    if (job.vorschlag !== undefined) body.vorschlag = job.vorschlag;
    if (job.result !== undefined) body.result = job.result;
    if (job.error !== undefined) body.error = job.error;

    return res.status(200).json(body);
  });

  /**
   * POST /api/projects/:slug/regression-define/:jobId/review
   * Body: { reviewed: <redigierte Vorschlags-Struktur> }
   *
   * Responses:
   *   202 { status: "running" }
   *   400 { error }  — ungültiger Slug/Pfad ODER `reviewed` fehlt/ungültig
   *   404 { error }  — unbekannte jobId
   *   409 { error }  — kein offener Vorschlag (Job nicht im needs-review-Zustand)
   *   500 { error }  — Audit-Write fehlgeschlagen (Aktion abgebrochen)
   */
  router.post('/api/projects/:slug/regression-define/:jobId/review', async (req, res) => {
    const resolved = await resolveSlug(req.params.slug);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error });
    }

    const { jobId } = req.params;
    const { reviewed } = req.body ?? {};

    // Format-Vorprüfung (ohne Audit): reviewed MUSS vorhanden sein.
    if (reviewed === undefined || reviewed === null) {
      return res.status(400).json({ error: 'reviewed is required' });
    }

    // Existenz-/State-Vorprüfung (ohne Audit): unbekannter Job → 404, kein
    // offener Vorschlag → 409 (analog obsidianIngestRouter).
    const job = runner.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown jobId' });
    }
    if (job.status !== 'needs-review') {
      return res.status(409).json({ error: 'Kein offener Vorschlag für diesen Job.' });
    }

    // Audit-First (genau EIN Eintrag je akzeptiertem Review-Turn, AC5).
    const identity = _resolveIdentity(req.identity ?? null);
    if (_auditStore) {
      try {
        _auditStore.record({ identity, command: `regression-define:review:${jobId}` });
      } catch (auditErr) {
        console.error('[regressionDefineRouter] Audit-Write fehlgeschlagen (review):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    const result = runner.review(jobId, reviewed);
    if (!result.ok) {
      switch (result.reason) {
        case 'not-found':
          return res.status(404).json({ error: 'Unknown jobId' });
        case 'not-waiting':
          return res.status(409).json({ error: 'Kein offener Vorschlag für diesen Job.' });
        default:
          return res.status(400).json({ error: 'Ungültige redigierte Fassung.' });
      }
    }

    return res.status(202).json({ status: 'running' });
  });

  return router;
}
