/**
 * workspacePath — gemeinsame Effektivwert-Auflösung für den Workspace-Root.
 *
 * Design-Entscheidung (Resolver-Strategie):
 *   Ein eigenständiges Modul `src/workspacePath.js` kapselt die einzige Quelle der
 *   Wahrheit: `effektiver Workspace-Root = konfigurierter Wert ?? process.env.WORKSPACE_DIR`.
 *   Die drei Boundaries (GitHubCloner, WorkspaceScanner, WorkspaceMutator) erhalten den
 *   Resolver per Konstruktor-Injektion (optionaler `resolveWorkspaceRoot`-Parameter),
 *   sodass Tests ohne echten CredentialStore arbeiten können und der env-Fallback das
 *   alte Verhalten für unkonfigurierte Deployments erhält (AC9).
 *
 *   Der Resolver wird **pro Operation** aufgerufen (nicht beim Boot eingefroren) — AC5.
 *
 * Validierungslogik (für PUT /api/settings/workspace-path):
 *   Ein eingegebener Pfad muss:
 *     (a) innerhalb der gemounteten Schranke `WORKSPACE_DIR` liegen (Modell a) —
 *         Path-Traversal-/Symlink-sicher via realpath-Containment + parent-Prefix-Vergleich
 *         mit Trailing-Slash (gleiche Härte wie WorkspaceMutator AC4/AC5).
 *     (b) existieren und ein Verzeichnis sein.
 *     (c) für uid-1000 schreibbar sein.
 *
 * Security (Floor):
 *   - Pfad ist kein Geheimnis — Klartext im meta-Block, nie in entries (AC6, ADR-007).
 *   - Traversal/Symlink-Schutz analog WorkspaceMutator/GitHubCloner (security/R03).
 *   - Kein hartkodiertes Secret (security/R01).
 *
 * @module workspacePath
 */

import { realpath, stat, access, constants } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// ── meta-Block-Schlüssel (ADR-007) ────────────────────────────────────────────
// Dieser String muss mit WORKSPACE_PATH_META_KEY in CredentialStore.js übereinstimmen.
// Er ist hier nur für den Router (Read-Zugriff via CredentialStore-API) referenziert;
// CredentialStore selbst definiert den Schlüssel intern (keine zirkuläre Abhängigkeit).

// ── Fehlerklassen ─────────────────────────────────────────────────────────────

/**
 * @typedef {'outside-boundary'|'not-exists'|'not-directory'|'not-writable'|'empty-path'} WorkspacePathErrorClass
 */

/**
 * Typed error for workspace path validation failures.
 */
export class WorkspacePathError extends Error {
  /** @type {WorkspacePathErrorClass} */
  errorClass;

  /**
   * @param {string} message
   * @param {WorkspacePathErrorClass} errorClass
   */
  constructor(message, errorClass) {
    super(message);
    this.name = 'WorkspacePathError';
    this.errorClass = errorClass;
  }
}

// ── Effektivwert-Resolver ─────────────────────────────────────────────────────

/**
 * Baut eine Resolver-Funktion für den effektiven Workspace-Root.
 *
 * Der Resolver wird **pro Operation** aufgerufen:
 *   `effektiver Root = konfigurierter Pfad ?? process.env.WORKSPACE_DIR ?? ''`
 *
 * Rückgabe:
 *   `{ path: string, source: 'configured'|'env-default' }`
 *
 * @param {import('./CredentialStore.js').CredentialStore|null} credentialStore
 *   Wenn null → immer env-Fallback (für unkonfigurierte Tests / Dev-Umgebungen ohne Store).
 * @returns {() => Promise<{ path: string, source: 'configured'|'env-default' }>}
 */
export function buildWorkspaceRootResolver(credentialStore) {
  return async function resolveWorkspaceRoot() {
    if (credentialStore) {
      try {
        const storeData = await credentialStore.readWorkspacePath();
        if (storeData && typeof storeData === 'string' && storeData.trim()) {
          return { path: storeData.trim(), source: 'configured' };
        }
      } catch {
        // Store nicht erreichbar → env-Fallback, kein Crash
      }
    }
    return {
      path: process.env.WORKSPACE_DIR ?? '',
      source: 'env-default',
    };
  };
}

// ── Validierung (Modell a) ────────────────────────────────────────────────────

/**
 * Validiert einen konfigurierten Workspace-Pfad gegen die gemountete Schranke.
 *
 * Regeln (Modell a, AC2/AC3):
 *   1. Pfad darf nicht leer/whitespace sein.
 *   2. Pfad muss via `realpath()` innerhalb der gemounteten Schranke `WORKSPACE_DIR` liegen
 *      (= `WORKSPACE_DIR` selbst ODER Unterordner).
 *   3. Pfad muss existieren und ein Verzeichnis sein.
 *   4. Pfad muss für uid-1000 schreibbar sein.
 *
 * Traversal-/Symlink-Schutz: Wir lösen BEIDE Seiten via `realpath()` auf (mounting boundary
 * und eingegebener Pfad), damit Symlinks, `..`, absolute Pfade und andere Bypass-Versuche
 * erkannt werden. Danach: Prefix-Check mit Trailing-Slash (nicht `startsWith` ohne Trailing-
 * Slash — sonst würde `/workspace-evil` für `/workspace`-Schranke durchgehen).
 *
 * @param {string} inputPath    Der eingegebene Pfad (untrusted, aus HTTP-Body).
 * @param {object} [deps]       Injectable dependencies für Tests.
 * @param {Function} [deps.realpath]  `(p) => Promise<string>` — default: node:fs/promises.realpath
 * @param {Function} [deps.stat]      `(p) => Promise<Stats>` — default: node:fs/promises.stat
 * @param {Function} [deps.access]    `(p, mode) => Promise<void>` — default: node:fs/promises.access
 * @returns {Promise<{ resolvedPath: string }>} Normalisierter realer Pfad bei Erfolg.
 * @throws {WorkspacePathError} bei Validierungsfehler.
 */
export async function validateWorkspacePath(inputPath, deps = {}) {
  const _realpath = deps.realpath ?? realpath;
  const _stat = deps.stat ?? stat;
  const _access = deps.access ?? access;

  // (1) Leer/whitespace
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new WorkspacePathError(
      'Pfad darf nicht leer sein',
      'empty-path',
    );
  }

  const normalized = resolve(inputPath.trim());

  // (2) Schranke auflösen (WORKSPACE_DIR via realpath)
  // deps.mountRoot ermöglicht Injektion in Tests (robuster bei parallelen Test-Workern).
  const mountRoot = deps.mountRoot ?? process.env.WORKSPACE_DIR ?? '';
  if (!mountRoot || !mountRoot.trim()) {
    // Ohne Schranke: kein Container-Containment möglich — Fehler
    // (Rand-Fall: WORKSPACE_DIR nicht gesetzt, Pfad gesetzt → 422)
    throw new WorkspacePathError(
      'WORKSPACE_DIR ist nicht als gemountete Schranke konfiguriert — Pfad kann nicht validiert werden',
      'outside-boundary',
    );
  }

  let resolvedMountRoot;
  try {
    resolvedMountRoot = await _realpath(mountRoot.trim());
  } catch {
    throw new WorkspacePathError(
      `Gemountete Schranke WORKSPACE_DIR '${mountRoot}' existiert nicht oder ist nicht zugänglich`,
      'outside-boundary',
    );
  }

  // (2b) Eingegebenen Pfad via realpath auflösen (muss existieren → falls nicht: not-exists)
  // TOCTOU-Randfall: schlägt realpath fehl (Pfad existiert noch nicht), wird der syntaktisch
  // normalisierte Pfad für den Boundary-Check verwendet. `resolvedPath` im Rückgabewert ist
  // dann der normalisierte Pfad — korrekt für den Anwendungsfall (stat schlägt gleich nach),
  // aber nicht per realpath-Dereferenzierung bestätigt. Das ist akzeptabel: der folgende
  // stat()-Aufruf schlägt als not-exists fehl bevor der Pfad wirksam gesetzt werden kann.
  let resolvedInput;
  try {
    resolvedInput = await _realpath(normalized);
  } catch {
    // realpath scheitert wenn Pfad nicht existiert → wir prüfen das gleich mit stat
    // Für den Traversal-Check nutzen wir den syntaktisch normalisierten Pfad
    resolvedInput = null;
  }

  // Traversal-Check: resolvedInput (wenn auflösbar) ODER normalized gegen die Schranke.
  // Prüfe, ob der Pfad innerhalb der Schranke liegt — mit Trailing-Slash (Prefix-Sicherheit).
  const mountPrefix = resolvedMountRoot.endsWith(sep)
    ? resolvedMountRoot
    : resolvedMountRoot + sep;

  const pathToCheck = resolvedInput ?? normalized;

  // Der Pfad darf entweder gleich der Schranke sein oder darunter liegen
  const isInsideBoundary =
    pathToCheck === resolvedMountRoot ||
    pathToCheck.startsWith(mountPrefix);

  if (!isInsideBoundary) {
    throw new WorkspacePathError(
      `Pfad '${inputPath.trim()}' liegt außerhalb der gemounteten Schranke WORKSPACE_DIR ('${mountRoot}') — ` +
      'Pfad nicht im Container erreichbar / außerhalb des gemounteten Workspace',
      'outside-boundary',
    );
  }

  // (3) Existenz + Verzeichnis-Check
  let statResult;
  try {
    statResult = await _stat(pathToCheck);
  } catch {
    throw new WorkspacePathError(
      `Pfad '${inputPath.trim()}' existiert nicht`,
      'not-exists',
    );
  }

  if (!statResult.isDirectory()) {
    throw new WorkspacePathError(
      `Pfad '${inputPath.trim()}' ist kein Verzeichnis (Datei gefunden)`,
      'not-directory',
    );
  }

  // (4) Schreibbar für uid-1000
  try {
    await _access(pathToCheck, constants.W_OK);
  } catch {
    throw new WorkspacePathError(
      `Pfad '${inputPath.trim()}' ist nicht schreibbar`,
      'not-writable',
    );
  }

  return { resolvedPath: pathToCheck };
}
