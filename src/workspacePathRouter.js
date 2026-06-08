/**
 * workspacePathRouter — Express-Router für Workspace-Pfad-Konfiguration (workspace-path-config AC2–AC9).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/settings/workspace-path
 *     → 200 { effectivePath: string|null, source: "configured"|"env-default", mountRoot: string }
 *       Read-only; hinter Access-Mauer, kein zusätzlicher Rollencheck.
 *   PUT    /api/settings/workspace-path
 *     → 200 { effectivePath, source: "configured" }     — Erfolg
 *     → 422 { error }                                   — Validierungsfehler (AC2/AC3)
 *     → 403 { error }                                   — keine Berechtigung (AC8)
 *     → 500 { error }                                   — Audit/Store-Fehler
 *   DELETE /api/settings/workspace-path
 *     → 200 { effectivePath, source: "env-default" }    — zurückgesetzt auf Env-Default
 *     → 403 { error }                                   — keine Berechtigung (AC8)
 *     → 500 { error }                                   — Audit/Store-Fehler
 *
 * Security (ADR-007):
 *   - Workspace-Pfad ist kein Geheimnis — Klartext im meta-Block (AC6).
 *   - Mutierende Endpunkte hinter AccessGuard + CRED_ADMIN_EMAILS-Linie (AC8).
 *   - Audit-First: Intent-Eintrag VOR Mutation; Audit-Write-Fehler → Mutation unterbleibt (AC7).
 *   - Eingabe-Validierung: Containment in WORKSPACE_DIR, Existenz, Verzeichnis, schreibbar (AC2/AC3).
 *   - Pfad nie geloggt ausser als Klartext-Betreiber-Info — kein Secret.
 *   - Alle Mutations erzeugen Audit-Einträge mit alt→neu (AC7, Spec: Identität, Aktion, alt→neu, Zeit).
 *
 * @module workspacePathRouter
 */

import { Router } from 'express';
import { validateWorkspacePath, WorkspacePathError } from './workspacePath.js';

/**
 * Prüft ob die anfragende Identität mutieren darf (AC8 / ADR-007 OA3).
 * Gleiche Logik wie alle anderen mutierende Settings-Router.
 *
 * @param {import('./AccessGuard.js').Identity|null} identity
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
 * @param {import('./CredentialStore.js').CredentialStore} credentialStore
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {object} [deps]  Injectable dependencies für Tests.
 * @param {Function} [deps.validatePath]  Override für validateWorkspacePath (für Tests).
 * @returns {import('express').Router}
 */
export function workspacePathRouter(credentialStore, auditStore, deps = {}) {
  const _validatePath = deps.validatePath ?? validateWorkspacePath;
  const router = Router();

  /**
   * GET /api/settings/workspace-path
   * Gibt den aktuell wirksamen Workspace-Root zurück (konfiguriert oder Env-Fallback).
   * Read-only; hinter Access-Mauer, kein zusätzlicher Rollencheck (AC8 — nur mutierende EPs geschützt).
   *
   * Response: 200 { effectivePath: string|null, source: "configured"|"env-default", mountRoot: string }
   */
  router.get('/api/settings/workspace-path', async (_req, res) => {
    try {
      const configured = await credentialStore.readWorkspacePath();
      const mountRoot = process.env.WORKSPACE_DIR ?? '';

      if (configured && configured.trim()) {
        return res.json({
          effectivePath: configured.trim(),
          source: 'configured',
          mountRoot,
        });
      }

      return res.json({
        effectivePath: mountRoot || null,
        source: 'env-default',
        mountRoot,
      });
    } catch (err) {
      console.error('[workspacePathRouter] GET failed:', err.message);
      return res.status(500).json({ error: 'Workspace-Pfad-Konfiguration nicht erreichbar' });
    }
  });

  /**
   * PUT /api/settings/workspace-path
   * Setzt oder überschreibt den Workspace-Root-Pfad.
   * Body: { path: string }
   *
   * Responses:
   *   200 { effectivePath, source: "configured" }  — Erfolg
   *   403 { error }  — keine Berechtigung (AC8)
   *   422 { error }  — Validierungsfehler (AC2/AC3: außerhalb Schranke, nicht-existent, kein Verzeichnis, nicht schreibbar)
   *   500 { error }  — Audit-Write fehlgeschlagen oder Store nicht erreichbar
   */
  router.put('/api/settings/workspace-path', async (req, res) => {
    const identity = req.identity ?? null;

    // AC8: Mutations-Autorisierung
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { path: inputPath } = req.body ?? {};

    // Basis-Validierung (leer/kein String) vor Audit
    if (typeof inputPath !== 'string' || inputPath.trim() === '') {
      return res.status(422).json({ error: 'Pflichtfeld "path" fehlt oder ist leer' });
    }

    // Alten Wert lesen (für Audit alt→neu)
    let oldPath;
    try {
      oldPath = await credentialStore.readWorkspacePath();
    } catch {
      oldPath = null;
    }

    // AC7: Audit-First — Intent-Eintrag VOR Mutation
    // Pfad ist kein Secret — Klartext im Audit erlaubt
    const auditAction = `workspace-path:set:from:${oldPath ?? 'unset'}:to:${inputPath.trim()}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[workspacePathRouter] Audit-Write (Intent) fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // AC2/AC3: Pfad validieren (Containment, Existenz, Verzeichnis, schreibbar)
    let resolvedPath;
    try {
      const validated = await _validatePath(inputPath.trim());
      resolvedPath = validated.resolvedPath;
    } catch (err) {
      // Outcome-Audit (Fehlschlag)
      const errorClass = (err instanceof WorkspacePathError) ? err.errorClass : 'unexpected';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `workspace-path:set:failed:${errorClass}`,
        });
      } catch {
        // Non-blocking
      }

      if (err instanceof WorkspacePathError) {
        return res.status(422).json({ error: err.message });
      }
      console.error('[workspacePathRouter] PUT validate unexpected error:', err.message);
      return res.status(500).json({ error: 'Pfad-Validierung fehlgeschlagen' });
    }

    // Persistieren
    try {
      await credentialStore.writeWorkspacePath(resolvedPath);
    } catch (err) {
      // Outcome-Audit (Store-Fehler)
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `workspace-path:set:failed:store-error`,
        });
      } catch {
        // Non-blocking
      }
      console.error('[workspacePathRouter] PUT writeWorkspacePath failed:', err.message);
      return res.status(500).json({ error: 'Workspace-Pfad konnte nicht gespeichert werden' });
    }

    // AC7: Outcome-Audit (Erfolg) — spiegelt alt→neu für bessere Audit-Lesbarkeit
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `workspace-path:set:success:from:${oldPath ?? 'unset'}:to:${resolvedPath}`,
      });
    } catch (auditOutcomeErr) {
      console.error('[workspacePathRouter] Outcome-Audit-Write (Erfolg) fehlgeschlagen:', auditOutcomeErr.message);
    }

    return res.json({ effectivePath: resolvedPath, source: 'configured' });
  });

  /**
   * DELETE /api/settings/workspace-path
   * Entfernt den konfigurierten Workspace-Root-Pfad → Effektivwert fällt auf Env-Default zurück.
   *
   * Responses:
   *   200 { effectivePath, source: "env-default" }  — zurückgesetzt
   *   403 { error }  — keine Berechtigung (AC8)
   *   500 { error }  — Audit-Write fehlgeschlagen oder Store nicht erreichbar
   */
  router.delete('/api/settings/workspace-path', async (req, res) => {
    const identity = req.identity ?? null;

    // AC8: Mutations-Autorisierung
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Alten Wert lesen (für Audit alt→neu)
    let oldPath;
    try {
      oldPath = await credentialStore.readWorkspacePath();
    } catch {
      oldPath = null;
    }

    // AC7: Audit-First — Intent-Eintrag VOR Mutation
    const auditAction = `workspace-path:delete:from:${oldPath ?? 'unset'}:to:env-default`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[workspacePathRouter] Audit-Write (Intent) fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Konfiguration löschen
    try {
      await credentialStore.deleteWorkspacePath();
    } catch (err) {
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `workspace-path:delete:failed:store-error`,
        });
      } catch {
        // Non-blocking
      }
      console.error('[workspacePathRouter] DELETE deleteWorkspacePath failed:', err.message);
      return res.status(500).json({ error: 'Workspace-Pfad konnte nicht zurückgesetzt werden' });
    }

    // AC7: Outcome-Audit (Erfolg)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `workspace-path:delete:success`,
      });
    } catch (auditOutcomeErr) {
      console.error('[workspacePathRouter] Outcome-Audit-Write (Erfolg) fehlgeschlagen:', auditOutcomeErr.message);
    }

    const mountRoot = process.env.WORKSPACE_DIR ?? '';
    return res.json({
      effectivePath: mountRoot || null,
      source: 'env-default',
    });
  });

  return router;
}
