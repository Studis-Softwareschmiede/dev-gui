/**
 * workspaceReposRouter — Express router for the Workspace Repos API (AC1, AC2, AC3, AC4, AC5, AC7, AC8).
 *
 * Routes (behind the AccessGuard middleware mounted in server.js):
 *   GET  /api/workspace/repos
 *     → 200 { repos: [{ name, branch, dirty, lastCommit, originUrl }] }
 *       credential-free originUrl (AC2)
 *   POST /api/workspace/repos/pull
 *     → 200 { name, status: "pulled", summary? } on success
 *     → 400 { error } on traversal/invalid name (AC4)
 *     → 403 { error } without CRED_ADMIN_EMAILS permission (AC8)
 *     → 404 { error } when the clone does not exist
 *     → 409 { error } when git pull detects a conflict / dirty state
 *     → 500 { error } on audit-write failure (Audit-First, AC7) or credential error
 *     → 502 { error } when git pull fails (network/auth) — no secret in response (AC3)
 *   POST /api/workspace/repos/delete
 *     → 200 { name, status: "deleted" } on success
 *     → 400 { error } on traversal/invalid name
 *     → 403 { error } without CRED_ADMIN_EMAILS permission (AC8)
 *     → 404 { error } when the clone does not exist
 *     → 500 { error } on audit-write failure (Audit-First, AC7)
 *
 * Security:
 *   - AccessGuard is applied upstream (in server.js) — req.identity is set.
 *   - PULL and DELETE are identitäts-/rollengeschützt via CRED_ADMIN_EMAILS (AC8).
 *   - Pull: token minted transiently IMMEDIATELY BEFORE git pull; never in response/audit/argv (AC3).
 *   - Path traversal + symlink-flucht protection in WorkspaceMutator (AC4, AC5).
 *   - Audit-First: intent entry BEFORE mutation, outcome after (AC7).
 *   - No secrets logged (security/R01).
 *
 * @module workspaceReposRouter
 */

import { Router } from 'express';
import { WorkspaceMutatorError } from './WorkspaceMutator.js';
import { mintInstallationToken } from './githubAppToken.js';

/**
 * Prüft ob die anfragende Identität mutieren darf (AC8 / ADR-007 OA3).
 * Wenn CRED_ADMIN_EMAILS gesetzt: nur gelistete E-Mails.
 * Wenn nicht gesetzt: jede gültige Access-Identität.
 *
 * Identische Logik wie githubReposRouter und credentialsRouter (ADR-007).
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
 * Create and return the workspace repos router.
 *
 * @param {import('./WorkspaceScanner.js').WorkspaceScanner} workspaceScanner
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {import('./WorkspaceMutator.js').WorkspaceMutator} workspaceMutator
 * @param {import('./CredentialStore.js').CredentialStore} [credentialStore]
 *   Required for the pull endpoint (token minting). If omitted, pull returns 500.
 * @returns {import('express').Router}
 */
export function workspaceReposRouter(workspaceScanner, auditStore, workspaceMutator, credentialStore) {
  const router = Router();

  /**
   * GET /api/workspace/repos
   *
   * Lists all local git clones in WORKSPACE_DIR live from the filesystem.
   *
   * Responses:
   *   200 { repos: [{ name, branch, dirty, lastCommit, originUrl }] }
   *       — always 200; WORKSPACE_DIR missing/empty → repos: []
   */
  router.get('/api/workspace/repos', async (_req, res) => {
    try {
      const repos = await workspaceScanner.listClones();
      return res.json({ repos });
    } catch (err) {
      // Unexpected error — degrade to empty list, never expose internals
      console.error('[workspaceReposRouter] listClones failed:', err.message);
      return res.json({ repos: [] });
    }
  });

  /**
   * POST /api/workspace/repos/pull
   *
   * Runs git pull in a named clone strictly within WORKSPACE_DIR (AC3, AC4).
   * Token minted transiently IMMEDIATELY BEFORE git pull (AC3).
   * Audit-First: intent entry before pull, outcome after (AC7).
   * Identitäts-/rollengeschützt via CRED_ADMIN_EMAILS (AC8).
   *
   * Body: { name: string }
   *
   * Responses:
   *   200 { name, status: "pulled", summary? }  — success
   *   400 { error }                              — traversal / invalid name (AC4)
   *   403 { error }                              — no permission (AC8)
   *   404 { error }                              — clone not found
   *   409 { error }                              — conflict / dirty state
   *   500 { error }                              — audit-write failure (AC7) or credential error
   *   502 { error }                              — git pull failed (no secret in response, AC3)
   */
  router.post('/api/workspace/repos/pull', async (req, res) => {
    const identity = req.identity ?? null;

    // AC8: Identitäts-/Rollencheck — CRED_ADMIN_EMAILS-Logik (ADR-007)
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { name } = req.body ?? {};

    // Basic input validation before audit
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'Pflichtfeld "name" fehlt oder ist leer' });
    }

    const cloneName = name.trim();

    // AC7: Audit-First — Intent-Eintrag VOR dem Pull
    // cloneName is a safe string (no secret, no token — AC3)
    const auditIntent = `workspace:repo:pull:${cloneName}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditIntent });
    } catch (auditErr) {
      console.error('[workspaceReposRouter] Audit-Write (Intent) fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Build the token-mint function for this request.
    // The token is minted INSIDE pullClone() immediately before git pull (AC3).
    // We keep the credentialStore reference here (not the token) — token never leaves the boundary.
    // Uses the shared mintInstallationToken helper (I1 — consolidates all three consumers).
    function mintTokenFn() {
      if (!credentialStore) {
        return Promise.reject(new Error('CredentialStore nicht konfiguriert'));
      }
      return mintInstallationToken(credentialStore);
    }

    // AC3, AC4: Pull strikt innerhalb WORKSPACE_DIR; token transient in WorkspaceMutator
    let pullResult;
    try {
      pullResult = await workspaceMutator.pullClone(cloneName, mintTokenFn);
    } catch (err) {
      // AC7: Outcome-Audit (Fehlschlag) — no token/secret in audit entry (AC3)
      const errorClass = (err instanceof WorkspaceMutatorError) ? err.errorClass : 'unexpected';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `workspace:repo:pull:${cloneName}:failed:${errorClass}`,
        });
      } catch (auditOutcomeErr) {
        console.error(
          '[workspaceReposRouter] Outcome-Audit-Write (Fehlschlag) fehlgeschlagen:',
          auditOutcomeErr.message,
        );
      }

      if (err instanceof WorkspaceMutatorError) {
        if (err.errorClass === 'traversal' || err.errorClass === 'workspace-unset') {
          return res.status(400).json({ error: err.message });
        }
        if (err.errorClass === 'not-found') {
          return res.status(404).json({ error: err.message });
        }
        if (err.errorClass === 'credentials-missing') {
          return res.status(500).json({ error: err.message });
        }
        // S1: no-remote → 409 (no remote configured for this clone)
        if (err.errorClass === 'no-remote') {
          return res.status(409).json({ error: err.message });
        }
        if (err.errorClass === 'pull-failed') {
          // Check for merge conflict / dirty state indicators → 409
          const msg = err.message ?? '';
          if (
            msg.includes('conflict') ||
            msg.includes('Conflict') ||
            msg.includes('uncommitted') ||
            msg.includes('Please commit') ||
            msg.includes('Please stash') ||
            msg.includes('merge conflict') ||
            msg.includes('overwritten by merge')
          ) {
            return res.status(409).json({ error: err.message });
          }
          // General git pull failure → 502 (no secret leak — AC3)
          return res.status(502).json({ error: err.message });
        }
        return res.status(502).json({ error: err.message });
      }

      // Unexpected error — never expose internals (AC3: no secret leak)
      const safeMsg = String(err?.message ?? '').slice(0, 200);
      console.error('[workspaceReposRouter] Unexpected pull error:', safeMsg);
      return res.status(502).json({ error: 'git pull fehlgeschlagen' });
    }

    // AC7: Outcome-Audit (Erfolg) — path included, no token (AC3)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `workspace:repo:pull:${cloneName}:success`,
      });
    } catch (auditOutcomeErr) {
      console.error(
        '[workspaceReposRouter] Outcome-Audit-Write (Erfolg) fehlgeschlagen:',
        auditOutcomeErr.message,
      );
    }

    const response = { name: cloneName, status: 'pulled' };
    if (pullResult?.summary) {
      response.summary = pullResult.summary;
    }
    return res.json(response);
  });

  /**
   * POST /api/workspace/repos/delete
   *
   * Deletes a local clone strictly within WORKSPACE_DIR (AC5).
   * Audit-First: intent entry before deletion, outcome after (AC7).
   * Identitäts-/rollengeschützt via CRED_ADMIN_EMAILS (AC8).
   *
   * Body: { name: string }
   *
   * Responses:
   *   200 { name, status: "deleted" }  — success
   *   400 { error }                    — traversal / invalid name
   *   403 { error }                    — no permission (AC8)
   *   404 { error }                    — clone not found in WORKSPACE_DIR
   *   500 { error }                    — audit-write failure (AC7 Audit-First)
   */
  router.post('/api/workspace/repos/delete', async (req, res) => {
    const identity = req.identity ?? null;

    // AC8: Identitäts-/Rollencheck — CRED_ADMIN_EMAILS-Logik (ADR-007)
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { name } = req.body ?? {};

    // Basic input validation before audit
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'Pflichtfeld "name" fehlt oder ist leer' });
    }

    const cloneName = name.trim();

    // AC7: Audit-First — Intent-Eintrag VOR der Löschung
    // cloneName is a safe string (no secret, no token)
    const auditIntent = `workspace:repo:delete:${cloneName}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditIntent });
    } catch (auditErr) {
      console.error('[workspaceReposRouter] Audit-Write (Intent) fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // AC5: Löschen strikt innerhalb WORKSPACE_DIR (WorkspaceMutator kapselt den Schutz)
    try {
      await workspaceMutator.deleteClone(cloneName);
    } catch (err) {
      // AC7: Outcome-Audit (Fehlschlag)
      const errorClass = (err instanceof WorkspaceMutatorError) ? err.errorClass : 'unexpected';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `workspace:repo:delete:${cloneName}:failed:${errorClass}`,
        });
      } catch (auditOutcomeErr) {
        console.error(
          '[workspaceReposRouter] Outcome-Audit-Write (Fehlschlag) fehlgeschlagen:',
          auditOutcomeErr.message,
        );
      }

      if (err instanceof WorkspaceMutatorError) {
        if (err.errorClass === 'traversal' || err.errorClass === 'workspace-unset') {
          return res.status(400).json({ error: err.message });
        }
        if (err.errorClass === 'not-found') {
          return res.status(404).json({ error: err.message });
        }
        // rm-failed or other MutatorError
        return res.status(500).json({ error: err.message });
      }

      // Unexpected error — never expose internals
      const safeMsg = String(err?.message ?? '').slice(0, 200);
      console.error('[workspaceReposRouter] Unexpected delete error:', safeMsg);
      return res.status(500).json({ error: 'Löschen fehlgeschlagen' });
    }

    // AC7: Outcome-Audit (Erfolg)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `workspace:repo:delete:${cloneName}:success`,
      });
    } catch (auditOutcomeErr) {
      console.error(
        '[workspaceReposRouter] Outcome-Audit-Write (Erfolg) fehlgeschlagen:',
        auditOutcomeErr.message,
      );
    }

    return res.json({ name: cloneName, status: 'deleted' });
  });

  return router;
}
