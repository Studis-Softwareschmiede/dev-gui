/**
 * obsidianIngestRouter — Express-Router für den Headless-Obsidian-Ingest-Runner
 * (docs/specs/obsidian-question-catalog.md AC1, AC2, AC4, AC5, AC6, AC7).
 *
 * Routes (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/obsidian-ingest/start            — startet den headless from-notes-Lauf
 *   GET  /api/obsidian-ingest/:jobId           — Status + (bei needs-answers) Fragenkatalog
 *   POST /api/obsidian-ingest/:jobId/answers   — gebündelte Antworten zurück → Resume
 *
 * Getrennt vom interaktiven PTY-Pfad (AC1/AC6) — nutzt ausschließlich den neuen
 * `ObsidianIngestRunner` (eigene `ProjectJobLock`-Instanz), keinen
 * `CommandService`/`PtyManager`-Import.
 *
 * Pfad-Auflösung (vault-confined, security/R02/R03, Wiederverwendung — obsidian-
 * vault-config AC5, analog dem PTY-Trigger `/agent-flow:from-notes` in
 * `CommandService.js`: „vault-confined, never free text"): Der Client sendet
 * `projectFolderPath` als absoluten Pfad. Statt eines eigenen neuen Confinement-
 * Mechanismus wird der bereits konfigurierte Obsidian-Vault-Pfad gelesen
 * (`credentialStore.readObsidianVaultPath()`) und `listObsidianVaultProjects()`
 * (obsidianVaultPath.js) liefert die aktuell gültigen `<vault>/Projekte`-
 * Unterordner (bereits realpath-aufgelöst + Symlink-/Race-sicher confined,
 * obsidian-vault-config AC3/AC5). Der eingereichte `projectFolderPath` wird per
 * `realpath` aufgelöst und MUSS exakt einem dieser gelisteten Pfade entsprechen
 * — kein Freitext-Pfad gelangt ungeprüft in cwd/argv des Kindprozesses. Ist kein
 * Vault konfiguriert oder „Projekte" (mehr) nicht erreichbar → `404` (dieselbe
 * `ObsidianVaultPathError`-Fehlerklasse wie `GET .../obsidian-vault/projects`).
 * Der Projekt-Unterordner selbst wird nach der v3-Rangfolge (obsidian-vault-config
 * AC10: persistiert → Env `OBSIDIAN_PROJEKTE_SUBDIR` → Default „Projekte") aufgelöst
 * — derselbe wirksame Wert wie an den übrigen Verbrauchsstellen (AC2c/AC5).
 *
 * Audit-First-Konvention (analog `ideaSpecifyRouter`): Format-/Existenz-/State-
 * Vorprüfungen werden OHNE Audit abgelehnt; genau EIN Audit-Eintrag je
 * akzeptiertem Job-Start bzw. Antworten-Turn (Identität aus `req.identity`);
 * schlägt der Audit-Write fehl, wird die Aktion NICHT ausgeführt. Ende-/Fehler-
 * Audit je Lauf schreibt der `ObsidianIngestRunner` selbst (AC6).
 *
 * Security (Floor): keine Secrets in Response/Log; `jobId` ist eine reine
 * Korrelations-ID (`randomUUID()` im Runner), kein Secret; `catalog`/`error`/
 * `result` kommen ausschließlich aus dem Runner (bereits secret-/pfad-frei).
 *
 * @module obsidianIngestRouter
 */

import { Router } from 'express';
import { realpath as nodeRealpath } from 'node:fs/promises';
import {
  listObsidianVaultProjects,
  ObsidianVaultPathError,
  resolveEffectiveProjekteSubdir,
} from './obsidianVaultPath.js';

/**
 * Extrahiert den identity-String aus `req.identity` (AccessGuard-Claim) — analog
 * `ideaSpecifyRouter`/`boardRouter`.
 * @param {object|null} identity
 * @returns {string|null}
 */
function _resolveIdentity(identity) {
  return identity?.email ?? null;
}

/**
 * @param {import('./ObsidianIngestRunner.js').ObsidianIngestRunner} runner
 * @param {object} [options]
 * @param {import('./CredentialStore.js').CredentialStore} [options.credentialStore]
 *   Quelle des konfigurierten Vault-Pfads (`readObsidianVaultPath()`). Ohne
 *   Injektion gilt der Vault als nicht konfiguriert (404) — analog `null`-Fallback.
 * @param {(vaultPath: string) => Promise<Array<{name:string,path:string}>>} [options.listProjects]
 *   Injectable (default: listObsidianVaultProjects). Inject a stub in tests.
 * @param {(p: string) => Promise<string>} [options.realpath]
 *   Injectable (default: node:fs/promises.realpath). Inject a stub in tests.
 * @param {import('./AuditStore.js').AuditStore} [options.auditStore] - optional (AC6).
 * @returns {import('express').Router}
 */
export function obsidianIngestRouter(runner, options = {}) {
  const _credentialStore = options.credentialStore ?? null;
  const _listProjects = options.listProjects ?? listObsidianVaultProjects;
  const _realpath = options.realpath ?? nodeRealpath;
  const _auditStore = options.auditStore ?? null;
  const router = Router();

  /**
   * Löst + validiert `projectFolderPath` vault-confined auf (s. Modul-Kommentar).
   *
   * @param {unknown} projectFolderPath
   * @returns {Promise<{ ok: true, resolvedPath: string } | { ok: false, status: number, error: string }>}
   */
  async function resolveConfinedProjectPath(projectFolderPath) {
    if (typeof projectFolderPath !== 'string' || projectFolderPath.trim() === '') {
      return { ok: false, status: 400, error: 'projectFolderPath is required' };
    }

    let vaultPath;
    try {
      vaultPath = _credentialStore ? await _credentialStore.readObsidianVaultPath() : null;
    } catch (err) {
      console.error('[obsidianIngestRouter] Vault-Konfiguration nicht lesbar:', err.message);
      return { ok: false, status: 500, error: 'Obsidian-Vault-Konfiguration nicht erreichbar' };
    }
    if (!vaultPath || !vaultPath.trim()) {
      return { ok: false, status: 404, error: 'Obsidian-Vault ist nicht konfiguriert' };
    }

    // obsidian-vault-config v3 AC10: Rangfolge (persistiert → Env → Default) gilt
    // einheitlich auch am Ingest-Flow (dritte Verbrauchsstelle neben AC2c/AC5).
    let persistedSubdir;
    try {
      persistedSubdir = _credentialStore?.readObsidianProjekteSubdir
        ? await _credentialStore.readObsidianProjekteSubdir()
        : null;
    } catch {
      persistedSubdir = null;
    }
    const { effective: projekteSubdir } = resolveEffectiveProjekteSubdir({ persisted: persistedSubdir });

    let projects;
    try {
      projects = await _listProjects(vaultPath.trim(), { projekteSubdir });
    } catch (err) {
      if (err instanceof ObsidianVaultPathError) {
        // vault-unreachable / missing-projekte — Vault (mehr) nicht erreichbar
        // (auch Race), kein Crash (analog obsidianVaultPathRouter GET /projects).
        return { ok: false, status: 404, error: err.message };
      }
      console.error('[obsidianIngestRouter] Projekt-Auflistung fehlgeschlagen:', err.message);
      return { ok: false, status: 500, error: 'Projekt-Auflistung fehlgeschlagen' };
    }

    let resolved;
    try {
      resolved = await _realpath(projectFolderPath.trim());
    } catch {
      return { ok: false, status: 400, error: 'Invalid projectFolderPath: Pfad existiert nicht' };
    }

    const match = projects.some((p) => p.path === resolved);
    if (!match) {
      return {
        ok: false,
        status: 400,
        error: 'Invalid projectFolderPath: kein bekannter Projekt-Unterordner unter dem konfigurierten Obsidian-Vault',
      };
    }

    return { ok: true, resolvedPath: resolved };
  }

  /**
   * POST /api/obsidian-ingest/start
   * Body: { projectFolderPath: string }
   *
   * Responses:
   *   202 { jobId, status: "running" }
   *   400 { error }  — fehlender/ungültiger/nicht-gelisteter Pfad
   *   404 { error }  — Vault nicht konfiguriert / „Projekte" (mehr) nicht erreichbar
   *   409 { error }  — Projekt-Sperre (bereits ein laufender/offener Ingest-Lauf)
   *   500 { error }  — Vault-/Audit-Lesefehler (Aktion abgebrochen)
   */
  router.post('/api/obsidian-ingest/start', async (req, res) => {
    const { projectFolderPath } = req.body ?? {};

    const resolved = await resolveConfinedProjectPath(projectFolderPath);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error });
    }

    // Audit-First (genau EIN Eintrag je akzeptiertem Job-Start, AC6): schlägt
    // record() fehl, wird der Runner NICHT gestartet.
    const identity = _resolveIdentity(req.identity ?? null);
    if (_auditStore) {
      try {
        _auditStore.record({ identity, command: 'obsidian:ingest:start' });
      } catch (auditErr) {
        console.error('[obsidianIngestRouter] Audit-Write fehlgeschlagen (start):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    const result = runner.start(resolved.resolvedPath, { identity });
    if (!result.ok) {
      // Aktuell einzige Ablehnungs-Ursache: 'locked' (AC1/AC6, Parallel-Start).
      return res.status(409).json({ error: 'Obsidian-Ingest läuft bereits für dieses Projekt.' });
    }

    return res.status(202).json({ jobId: result.jobId, status: 'running' });
  });

  /**
   * GET /api/obsidian-ingest/:jobId
   *
   * Responses:
   *   200 { status, catalog?, result?, error? }
   *        status ∈ {running, needs-answers, done, failed, auth-expired};
   *        `catalog` nur bei needs-answers (AC2). Secret-frei.
   *   404 { error }  — unbekannte jobId (auch nach Server-Neustart)
   */
  router.get('/api/obsidian-ingest/:jobId', (req, res) => {
    const job = runner.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown jobId' });
    }

    const body = { status: job.status };
    if (job.catalog !== undefined) body.catalog = job.catalog;
    if (job.result !== undefined) body.result = job.result;
    if (job.error !== undefined) body.error = job.error;

    return res.status(200).json(body);
  });

  /**
   * POST /api/obsidian-ingest/:jobId/answers
   * Body: { answers: Array<{ id, answer }> }
   *
   * Responses:
   *   202 { status: "running" }
   *   400 { error }  — Antworten kein Array / Pflicht-Frage fehlt / unbekannte id
   *   404 { error }  — unbekannte jobId
   *   409 { error }  — kein offener Fragenkatalog (Job nicht im needs-answers-Zustand)
   *   500 { error }  — Audit-Write fehlgeschlagen (Aktion abgebrochen)
   */
  router.post('/api/obsidian-ingest/:jobId/answers', async (req, res) => {
    const { jobId } = req.params;
    const { answers } = req.body ?? {};

    // Format-Vorprüfung (ohne Audit): answers MUSS ein Array sein.
    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'answers must be an array of { id, answer }' });
    }

    // Existenz-/State-Vorprüfung (ohne Audit): unbekannter Job → 404, kein
    // offener Katalog → 409 (analog der Existenz-Checks in ideaSpecifyRouter).
    const job = runner.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown jobId' });
    }
    if (job.status !== 'needs-answers') {
      return res.status(409).json({ error: 'Kein offener Fragenkatalog für diesen Job.' });
    }

    // Audit-First (genau EIN Eintrag je akzeptiertem Antworten-Turn, AC6).
    const identity = _resolveIdentity(req.identity ?? null);
    if (_auditStore) {
      try {
        _auditStore.record({ identity, command: `obsidian:ingest:answers:${jobId}` });
      } catch (auditErr) {
        console.error('[obsidianIngestRouter] Audit-Write fehlgeschlagen (answers):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    // Autoritative Katalog-Validierung + Resume im Runner (Defense in Depth).
    const result = runner.answers(jobId, answers);
    if (!result.ok) {
      switch (result.reason) {
        case 'not-found':
          return res.status(404).json({ error: 'Unknown jobId' });
        case 'not-waiting':
          return res.status(409).json({ error: 'Kein offener Fragenkatalog für diesen Job.' });
        case 'unknown-id':
          return res.status(400).json({ error: 'Unbekannte Frage-ID in den Antworten.' });
        case 'missing-required':
          return res.status(400).json({ error: 'Nicht alle Pflicht-Fragen beantwortet.' });
        default:
          return res.status(400).json({ error: 'Ungültige Antworten.' });
      }
    }

    return res.status(202).json({ status: 'running' });
  });

  return router;
}
