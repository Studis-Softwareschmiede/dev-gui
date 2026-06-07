/**
 * githubReposRouter — POST /api/github/repos
 *
 * Delegates to GitHubWriter (the only mutating GitHub boundary).
 *
 * Routes:
 *   POST /api/github/repos → Create a new Org repository
 *
 * Security (AC3–AC5):
 *   - Hinter AccessGuard (in server.js — alle /api/* sind geschützt).
 *   - Identitäts-/Rollencheck via CRED_ADMIN_EMAILS (AC5 / ADR-007).
 *   - Audit-First: Audit-Eintrag VOR dem GitHub-Aufruf (AC4).
 *   - Token erscheint NICHT in Response, Log, Audit, WS, URL oder Argv (AC3).
 *   - Eingabe-Validierung vor jedem GitHub-Aufruf (AC6).
 *
 * Response shape (201):
 *   { name, fullName, htmlUrl, visibility }
 *
 * @module githubReposRouter
 */

import { Router } from 'express';
import { GitHubWriterError, validateRepoName, validateVisibility } from './GitHubWriter.js';

/**
 * Prüft ob die anfragende Identität mutieren darf (AC5 / ADR-007 OA3).
 * Wenn CRED_ADMIN_EMAILS gesetzt: nur gelistete E-Mails.
 * Wenn nicht gesetzt: jede gültige Access-Identität.
 *
 * Gleiche Logik wie credentialsRouter und sshKeysRouter (ADR-007).
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
 * Creates the GitHub repos router.
 *
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {GitHubWriter} githubWriter - Injectable for tests and production (injected by server.js)
 * @returns {import('express').Router}
 */
export function githubReposRouter(auditStore, githubWriter) {
  const router = Router();

  /**
   * POST /api/github/repos
   * Create a new Org repository.
   *
   * Body: { name: string, visibility?: "private"|"public", description?: string, autoInit?: boolean }
   *
   * Responses:
   *   201 { name, fullName, htmlUrl, visibility }  — Repo created
   *   400 { error }  — Missing/invalid body field
   *   403 { error }  — No Access or not in CRED_ADMIN_EMAILS allowlist
   *   409 { error }  — Repo name already exists in Org
   *   422 { error }  — GitHub validation error (name format, etc.)
   *   500 { error }  — Audit write failed / internal error / missing credentials
   *   502 { error }  — GitHub API unreachable / GitHub permission denied / network error
   */
  router.post('/api/github/repos', async (req, res) => {
    const identity = req.identity ?? null;

    // AC5: Identitäts-/Rollencheck — gleiche CRED_ADMIN_EMAILS-Logik wie ADR-007
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { name, visibility, description, autoInit } = req.body ?? {};

    // AC6: Eingabe-Validierung VOR jedem GitHub-Aufruf
    const nameVal = validateRepoName(name);
    if (!nameVal.ok) {
      return res.status(422).json({ error: nameVal.error });
    }

    const visVal = validateVisibility(visibility);
    if (!visVal.ok) {
      return res.status(422).json({ error: visVal.error });
    }

    const repoName = name.trim();
    const repoVisibility = visibility ?? 'private';

    // AC4: Audit-First — Eintrag VOR dem GitHub-Aufruf
    // Token erscheint NICHT im Audit (AC3/AC4)
    const auditAction = `github:repo:create:${repoName}:${repoVisibility}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[githubReposRouter] Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // GitHub-Aufruf via GitHubWriter (Boundary — AC2)
    let result;
    try {
      result = await githubWriter.createRepo({
        name: repoName,
        visibility: repoVisibility,
        description,
        autoInit,
      });
    } catch (err) {
      // AC4: Outcome-Audit (Fehlschlag) — errorClass ist kontrollierter enum-String, kein Secret
      const errorClass = (err instanceof GitHubWriterError) ? err.errorClass : 'unexpected';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `github:repo:create:${repoName}:failed:${errorClass}`,
        });
      } catch (auditErr) {
        console.error('[githubReposRouter] Outcome-Audit-Write (Fehlschlag) fehlgeschlagen:', auditErr.message);
      }

      if (err instanceof GitHubWriterError) {
        return mapWriterErrorToResponse(res, err);
      }
      // Unexpected error — cap message to avoid log flooding, no secret in log
      const safeMsg = String(err.message).slice(0, 200);
      console.error('[githubReposRouter] Unexpected error:', safeMsg);
      return res.status(502).json({ error: 'GitHub-API-Fehler beim Anlegen des Repositories' });
    }

    // AC4: Outcome-Audit (Erfolg)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `github:repo:create:${repoName}:success`,
      });
    } catch (auditErr) {
      console.error('[githubReposRouter] Outcome-Audit-Write (Erfolg) fehlgeschlagen:', auditErr.message);
    }

    // AC1: Strukturiertes Feedback — { name, fullName, htmlUrl, visibility }
    return res.status(201).json(result);
  });

  return router;
}

/**
 * Maps a GitHubWriterError to the appropriate HTTP response.
 * Token MUST NOT appear anywhere in the response body.
 *
 * @param {import('express').Response} res
 * @param {GitHubWriterError} err
 */
function mapWriterErrorToResponse(res, err) {
  switch (err.errorClass) {
    case 'validation-error':
      // Input validation (post-minting) or GitHub validation
      return res.status(422).json({ error: err.message });

    case 'name-conflict':
      return res.status(409).json({ error: err.message });

    case 'permission-denied':
      // GitHub 403 — App permission missing
      return res.status(502).json({ error: err.message });

    case 'credentials-incomplete':
    case 'credential-store-missing':
      // CredentialStore not configured — no secrets in message
      return res.status(500).json({ error: err.message });

    case 'jwt-sign-failed':
      // Private key in CredentialStore is broken — no key content in message
      return res.status(500).json({
        error: 'GitHub-App-Konfiguration fehlerhaft. Prüfe den Private-Key im CredentialStore.',
      });

    case 'auth-failed':
      return res.status(502).json({
        error: 'GitHub-App-Authentifizierung fehlgeschlagen. Prüfe App-ID, Installation-ID und Private-Key.',
      });

    case 'network-error':
      return res.status(502).json({ error: err.message });

    case 'not-found':
      return res.status(502).json({ error: err.message });

    case 'invalid-response':
      return res.status(502).json({ error: 'GitHub-API lieferte ungültige Antwort' });

    case 'github-error':
      return res.status(502).json({ error: err.message });

    default:
      console.error('[githubReposRouter] Unbekannte errorClass:', err.errorClass, err.message);
      return res.status(502).json({ error: 'GitHub-API-Fehler beim Anlegen des Repositories' });
  }
}
