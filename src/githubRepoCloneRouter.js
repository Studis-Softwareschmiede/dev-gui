/**
 * githubRepoCloneRouter — POST /api/github/repos/clone
 *
 * Clones an existing Org repository into WORKSPACE_DIR.
 *
 * Security (AC3–AC6):
 *   - Hinter AccessGuard (in server.js — alle /api/* sind geschützt).
 *   - Identitäts-/Rollencheck via CRED_ADMIN_EMAILS (AC6 / ADR-007).
 *   - Audit-First: Intent-Eintrag VOR dem Klon-Aufruf (AC5).
 *   - Token erscheint NICHT in Response, Log, Audit, WS, URL, Argv oder persistierter origin-URL (AC3).
 *   - Eingabe-Validierung vor jedem Git-Aufruf (AC2).
 *
 * Response shape (201):
 *   { repo, status: "cloned", path }
 *
 * @module githubRepoCloneRouter
 */

import { Router } from 'express';
import { GitHubClonerError, validateRepoRef } from './GitHubCloner.js';

/**
 * Prüft ob die anfragende Identität klonen darf (AC6 / ADR-007 OA3).
 * Gleiche Logik wie githubReposRouter, credentialsRouter, sshKeysRouter.
 *
 * @param {object|null} identity - req.identity from AccessGuard
 * @returns {{ allowed: boolean }}
 */
function checkMutationAuthz(identity) {
  const adminEmails = process.env.CRED_ADMIN_EMAILS;
  if (!adminEmails || !adminEmails.trim()) {
    return { allowed: true };
  }
  const allowed = adminEmails
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const email = (identity?.email ?? '').toLowerCase();
  if (!email || !allowed.includes(email)) {
    return { allowed: false };
  }
  return { allowed: true };
}

/**
 * Creates the GitHub repo clone router.
 *
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {import('./GitHubCloner.js').GitHubCloner} githubCloner
 * @returns {import('express').Router}
 */
export function githubRepoCloneRouter(auditStore, githubCloner) {
  const router = Router();

  /**
   * POST /api/github/repos/clone
   * Clone an existing Org repository into WORKSPACE_DIR.
   *
   * Body: { repo: string, force?: boolean }
   *
   * Responses:
   *   201 { repo, status: "cloned", path }    — clone created
   *   409 { status: "already-present", path } — clone exists without force
   *   400 { error }                           — missing/invalid body
   *   403 { error }                           — no Access or not in CRED_ADMIN_EMAILS
   *   422 { error }                           — invalid repo reference
   *   404 { error }                           — repo not found / no access on GitHub
   *   500 { error }                           — audit failure / credential store / workspace
   *   502 { error }                           — git clone failed / network / GitHub error
   */
  router.post('/api/github/repos/clone', async (req, res) => {
    const identity = req.identity ?? null;

    // AC6: Identitäts-/Rollencheck — CRED_ADMIN_EMAILS-Logik (ADR-007)
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { repo, force } = req.body ?? {};

    // Validate repo ref before any filesystem or git call (AC2)
    const validation = validateRepoRef(repo);
    if (!validation.ok) {
      return res.status(422).json({ error: validation.error });
    }

    const repoName = validation.repoName;
    const forceFlag = Boolean(force);

    // AC5: Audit-First — Intent-Eintrag VOR dem Klon-Aufruf
    // Token erscheint NICHT im Audit (AC3/AC5)
    // Format: github:repo:clone:<repoName>:path:<repoName>
    const auditAction = `github:repo:clone:${repoName}:path:${repoName}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[githubRepoCloneRouter] Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Clone via GitHubCloner (Boundary — AC2, AC3)
    let result;
    try {
      result = await githubCloner.cloneRepo({ repoName, force: forceFlag });
    } catch (err) {
      // AC5: Outcome-Audit (Fehlschlag) — errorClass ist kontrollierter enum-String, kein Secret
      const errorClass = (err instanceof GitHubClonerError) ? err.errorClass : 'unexpected';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `github:repo:clone:${repoName}:path:${repoName}:failed:${errorClass}`,
        });
      } catch (auditErr) {
        console.error(
          '[githubRepoCloneRouter] Outcome-Audit-Write (Fehlschlag) fehlgeschlagen:',
          auditErr.message,
        );
      }

      if (err instanceof GitHubClonerError) {
        return mapClonerErrorToResponse(res, err, repoName);
      }
      const safeMsg = String(err.message).slice(0, 200);
      console.error('[githubRepoCloneRouter] Unexpected error:', safeMsg);
      return res.status(502).json({ error: 'Fehler beim Klonen des Repositories' });
    }

    // AC5: Outcome-Audit (Erfolg)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `github:repo:clone:${repoName}:path:${repoName}:success`,
      });
    } catch (auditErr) {
      console.error(
        '[githubRepoCloneRouter] Outcome-Audit-Write (Erfolg) fehlgeschlagen:',
        auditErr.message,
      );
    }

    // AC1: Response — { repo, status: "cloned", path }
    return res.status(201).json(result);
  });

  return router;
}

/**
 * Maps a GitHubClonerError to the appropriate HTTP response.
 * Token MUST NOT appear anywhere in the response body.
 *
 * @param {import('express').Response} res
 * @param {GitHubClonerError} err
 * @param {string} [repoName]  Validated repo name (used in 409 path field per AC4)
 */
function mapClonerErrorToResponse(res, err, repoName) {
  switch (err.errorClass) {
    case 'already-present':
      // AC4: Ziel existiert ohne force → 409; Spec-Vertrag: { status: "already-present", path }
      return res.status(409).json({ status: 'already-present', path: repoName ?? null });

    case 'traversal':
      // AC2: Path-traversal attempt
      return res.status(400).json({ error: err.message });

    case 'workspace-missing':
      // AC7: WORKSPACE_DIR fehlt/nicht konfiguriert
      return res.status(500).json({ error: err.message });

    case 'workspace-not-writable': {
      // AC5/AC7: WORKSPACE_DIR nicht schreibbar → Setup-Anleitung falls vorhanden
      const body = { error: err.message };
      if (err.setup) body.setup = err.setup;
      return res.status(500).json(body);
    }

    case 'repo-not-found':
      // AC7: Repo nicht gefunden / kein Zugriff
      return res.status(404).json({ error: err.message });

    case 'clone-failed': {
      // AC7: git clone fehlgeschlagen (Netz/Auth)
      // AC5: Setup-Anleitung wenn Ursache Schreibfehler ist
      const body = { error: err.message };
      if (err.setup) body.setup = err.setup;
      return res.status(502).json(body);
    }

    case 'credentials-incomplete':
    case 'credential-store-missing':
      // AC7: CredentialStore unvollständig
      return res.status(500).json({ error: err.message });

    case 'jwt-sign-failed':
      return res.status(500).json({
        error: 'GitHub-App-Konfiguration fehlerhaft. Prüfe den Private-Key im CredentialStore.',
      });

    case 'auth-failed':
      return res.status(502).json({
        error: 'GitHub-App-Authentifizierung fehlgeschlagen. Prüfe App-ID, Installation-ID und Private-Key.',
      });

    case 'network-error':
      return res.status(502).json({ error: err.message });

    case 'invalid-response':
      return res.status(502).json({ error: 'GitHub-API lieferte ungültige Antwort' });

    default:
      console.error('[githubRepoCloneRouter] Unbekannte errorClass:', err.errorClass, err.message);
      return res.status(502).json({ error: 'Fehler beim Klonen des Repositories' });
  }
}
