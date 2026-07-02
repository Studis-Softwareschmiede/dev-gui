/**
 * obsidianVaultPathRouter — Express-Router für die Obsidian-Vault-Pfad-Konfiguration
 *                           (obsidian-vault-config AC1–AC4, AC6, AC7).
 *
 * Routes (alle hinter dem `/api`-AccessGuard in server.js):
 *   GET    /api/settings/obsidian-vault-path
 *     → 200 { vaultPath: string|null, configured: boolean, mountRoot?: string }
 *       Read-only; hinter Access-Mauer, kein zusätzlicher Rollencheck (AC7).
 *   PUT    /api/settings/obsidian-vault-path
 *     Body { path: string }
 *     → 200 { vaultPath, configured: true }   — Erfolg (AC1)
 *     → 422 { error, errorClass }             — Validierungsfehler (AC2/AC3); alter Wert unverändert
 *     → 403 { error }                         — keine Berechtigung (AC7)
 *     → 500 { error }                         — Audit/Store-Fehler
 *   DELETE /api/settings/obsidian-vault-path
 *     → 200 { vaultPath: null, configured: false }  — zurückgesetzt (AC1)
 *     → 403 { error }                               — keine Berechtigung (AC7)
 *     → 500 { error }                               — Audit/Store-Fehler
 *   GET    /api/settings/obsidian-vault/projects  (obsidian-vault-config AC5, S-246)
 *     → 200 { projects: Array<{ name, path }> }  — direkte Unterordner unter <vault>/Projekte,
 *       nur Verzeichnisse, keine Dot-Ordner, stabil sortiert; jeder `path` vault-confined (AC3).
 *     → 409 { configured: false }                — kein Vault konfiguriert
 *     → 404 { error }                             — Vault/„Projekte" (mehr) nicht erreichbar (Race/AC2)
 *       Read-only; hinter Access-Mauer, kein zusätzlicher Rollencheck (AC7).
 *
 * Muster: bewusst analog zu `workspacePathRouter.js` (workspace-path-config), aber:
 *   - Response-Shape `{ vaultPath, configured, mountRoot? }` (kein Env-Default-Effektivwert).
 *   - `mountRoot` nur wenn die OPTIONALE Schranke `OBSIDIAN_VAULT_DIR` gesetzt ist.
 *
 * Security (AC4/AC6/AC7):
 *   - Vault-Pfad ist KEIN Geheimnis — Klartext im meta-Block, nie in `entries` (AC4).
 *   - Mutierende Endpunkte hinter AccessGuard + CRED_ADMIN_EMAILS-Linie (AC7 / ADR-007).
 *   - Audit-First: Intent-Eintrag VOR Mutation; Audit-Write-Fehler → Mutation unterbleibt (AC6).
 *   - Pfad wird als Klartext-Betreiber-Info behandelt (kein Secret in Log/Audit/Response).
 *   - Projekt-Auflistung strikt auf `<vault>/Projekte` confined (Symlink-/Race-sicher, AC3/AC5).
 *
 * @module obsidianVaultPathRouter
 */

import { Router } from 'express';
import {
  validateObsidianVaultPath,
  ObsidianVaultPathError,
  resolveMountRoot,
  listObsidianVaultProjects,
} from './obsidianVaultPath.js';
import { toExternalBackup } from './CredentialStore.js';

/**
 * Prüft ob die anfragende Identität mutieren darf (AC7 / ADR-007).
 * Gleiche Logik wie alle anderen mutierenden Settings-Router: ist `CRED_ADMIN_EMAILS`
 * gesetzt, sind nur diese Identitäten berechtigt (sonst 403); ist sie leer, ist jede
 * (bereits durch die Access-Mauer authentifizierte) Identität berechtigt.
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
 * Baut das GET/Delete-Response-Objekt für einen (nicht-)konfigurierten Vault-Pfad.
 * `mountRoot` wird nur aufgenommen, wenn die optionale Schranke gesetzt ist.
 *
 * @param {string|null} vaultPath
 * @returns {{ vaultPath: string|null, configured: boolean, mountRoot?: string }}
 */
function buildStateBody(vaultPath) {
  const mountRoot = resolveMountRoot();
  const configured = Boolean(vaultPath && vaultPath.trim());
  return {
    vaultPath: configured ? vaultPath.trim() : null,
    configured,
    ...(mountRoot ? { mountRoot } : {}),
  };
}

/**
 * @param {import('./CredentialStore.js').CredentialStore} credentialStore
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {object} [deps]  Injectable dependencies für Tests.
 * @param {Function} [deps.validatePath]   Override für validateObsidianVaultPath (Tests).
 * @param {Function} [deps.listProjects]   Override für listObsidianVaultProjects (Tests).
 * @returns {import('express').Router}
 */
export function obsidianVaultPathRouter(credentialStore, auditStore, deps = {}) {
  const _validatePath = deps.validatePath ?? validateObsidianVaultPath;
  const _listProjects = deps.listProjects ?? listObsidianVaultProjects;
  const router = Router();

  /**
   * GET /api/settings/obsidian-vault-path — read-only Zustand (AC1).
   * Hinter Access-Mauer, kein zusätzlicher Rollencheck (AC7).
   */
  router.get('/api/settings/obsidian-vault-path', async (_req, res) => {
    try {
      const configured = await credentialStore.readObsidianVaultPath();
      return res.json(buildStateBody(configured));
    } catch (err) {
      console.error('[obsidianVaultPathRouter] GET failed:', err.message);
      return res.status(500).json({ error: 'Obsidian-Vault-Konfiguration nicht erreichbar' });
    }
  });

  /**
   * GET /api/settings/obsidian-vault/projects — Projekt-Unterordner unter <vault>/Projekte
   * (obsidian-vault-config AC5, S-246). Hinter Access-Mauer, kein zusätzlicher Rollencheck (AC7).
   * Read-only, keine Mutation, kein Audit nötig.
   */
  router.get('/api/settings/obsidian-vault/projects', async (_req, res) => {
    let vaultPath;
    try {
      vaultPath = await credentialStore.readObsidianVaultPath();
    } catch (err) {
      console.error('[obsidianVaultPathRouter] GET projects — Konfiguration nicht lesbar:', err.message);
      return res.status(500).json({ error: 'Obsidian-Vault-Konfiguration nicht erreichbar' });
    }

    if (!vaultPath || !vaultPath.trim()) {
      return res.status(409).json({ configured: false });
    }

    try {
      const projects = await _listProjects(vaultPath.trim());
      return res.json({ projects });
    } catch (err) {
      if (err instanceof ObsidianVaultPathError) {
        // vault-unreachable / missing-projekte: Vault bzw. „Projekte" (mehr) nicht erreichbar
        // (auch Race — extern entfernt/unmounted nach dem Setzen) → klarer 4xx, kein Crash.
        return res.status(404).json({ error: err.message });
      }
      console.error('[obsidianVaultPathRouter] GET projects unexpected error:', err.message);
      return res.status(500).json({ error: 'Projekt-Auflistung fehlgeschlagen' });
    }
  });

  /**
   * PUT /api/settings/obsidian-vault-path — Vault-Pfad setzen/ändern (AC1/AC2/AC3).
   * Body: { path: string }
   */
  router.put('/api/settings/obsidian-vault-path', async (req, res) => {
    const identity = req.identity ?? null;

    // AC7: Mutations-Autorisierung
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { path: inputPath } = req.body ?? {};

    // Basis-Validierung (leer/kein String) vor Audit — AC2 Edge-Case
    if (typeof inputPath !== 'string' || inputPath.trim() === '') {
      return res.status(422).json({ error: 'Pflichtfeld "path" fehlt oder ist leer' });
    }

    // Alten Wert lesen (für Audit alt→neu). Pfad ist kein Secret — Klartext erlaubt.
    let oldPath;
    try {
      oldPath = await credentialStore.readObsidianVaultPath();
    } catch {
      oldPath = null;
    }

    // AC6: Audit-First — Intent-Eintrag VOR Mutation; Audit-Fehler → Mutation unterbleibt.
    const intentAction = `obsidian-vault-path:set:from:${oldPath ?? 'unset'}:to:${inputPath.trim()}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: intentAction });
    } catch (auditErr) {
      console.error('[obsidianVaultPathRouter] Audit-Write (Intent) fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // AC2/AC3: Pfad validieren (Existenz, Verzeichnis, lesbar, „Projekte", Containment)
    let resolvedPath;
    try {
      const validated = await _validatePath(inputPath.trim());
      resolvedPath = validated.resolvedPath;
    } catch (err) {
      const errorClass = err instanceof ObsidianVaultPathError ? err.errorClass : 'unexpected';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `obsidian-vault-path:set:failed:${errorClass}`,
        });
      } catch {
        // Non-blocking Outcome-Audit
      }

      if (err instanceof ObsidianVaultPathError) {
        // AC2: klare, feldzugeordnete Meldung; bisher konfigurierter Wert bleibt unverändert
        // (keine Store-Mutation erfolgt). Die interne `errorClass` fließt in den Audit-Trail
        // (oben), NICHT in den Response-Body — Response-Shape spiegelt workspacePathRouter (`{ error }`).
        return res.status(422).json({ error: err.message });
      }
      console.error('[obsidianVaultPathRouter] PUT validate unexpected error:', err.message);
      return res.status(500).json({ error: 'Pfad-Validierung fehlgeschlagen' });
    }

    // AC4: Persistieren (Klartext-Metadatum im meta-Block)
    let writeResult;
    try {
      writeResult = await credentialStore.writeObsidianVaultPath(resolvedPath);
    } catch (err) {
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: 'obsidian-vault-path:set:failed:store-error',
        });
      } catch {
        // Non-blocking
      }
      console.error('[obsidianVaultPathRouter] PUT writeObsidianVaultPath failed:', err.message);
      return res.status(500).json({ error: 'Obsidian-Vault-Pfad konnte nicht gespeichert werden' });
    }

    // AC6: Outcome-Audit (Erfolg) — spiegelt alt→neu für Audit-Lesbarkeit
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `obsidian-vault-path:set:success:from:${oldPath ?? 'unset'}:to:${resolvedPath}`,
      });
    } catch (auditOutcomeErr) {
      console.error('[obsidianVaultPathRouter] Outcome-Audit (Erfolg) fehlgeschlagen:', auditOutcomeErr.message);
    }

    return res.json({
      vaultPath: resolvedPath,
      configured: true,
      ...(writeResult?.backup ? { backup: toExternalBackup(writeResult.backup) } : {}),
    });
  });

  /**
   * DELETE /api/settings/obsidian-vault-path — Konfiguration zurücksetzen (AC1).
   */
  router.delete('/api/settings/obsidian-vault-path', async (req, res) => {
    const identity = req.identity ?? null;

    // AC7: Mutations-Autorisierung
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Alten Wert lesen (für Audit alt→neu)
    let oldPath;
    try {
      oldPath = await credentialStore.readObsidianVaultPath();
    } catch {
      oldPath = null;
    }

    // AC6: Audit-First — Intent-Eintrag VOR Mutation
    const intentAction = `obsidian-vault-path:delete:from:${oldPath ?? 'unset'}:to:unset`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: intentAction });
    } catch (auditErr) {
      console.error('[obsidianVaultPathRouter] Audit-Write (Intent) fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    let deleteResult;
    try {
      deleteResult = await credentialStore.deleteObsidianVaultPath();
    } catch (err) {
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: 'obsidian-vault-path:delete:failed:store-error',
        });
      } catch {
        // Non-blocking
      }
      console.error('[obsidianVaultPathRouter] DELETE deleteObsidianVaultPath failed:', err.message);
      return res.status(500).json({ error: 'Obsidian-Vault-Pfad konnte nicht zurückgesetzt werden' });
    }

    // AC6: Outcome-Audit (Erfolg)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: 'obsidian-vault-path:delete:success',
      });
    } catch (auditOutcomeErr) {
      console.error('[obsidianVaultPathRouter] Outcome-Audit (Erfolg) fehlgeschlagen:', auditOutcomeErr.message);
    }

    return res.json({
      vaultPath: null,
      configured: false,
      ...(deleteResult?.backup ? { backup: toExternalBackup(deleteResult.backup) } : {}),
    });
  });

  return router;
}
