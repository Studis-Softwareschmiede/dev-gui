/**
 * obsidianVaultPath — Validierung des konfigurierbaren Obsidian-Vault-Pfads
 *                     (obsidian-vault-config AC2/AC3).
 *
 * Muster: bewusst analog zu `src/workspacePath.js` (nicht-geheime Pfad-Konfiguration,
 * Traversal-/Symlink-Schutz), aber mit drei fachlichen Unterschieden:
 *
 *   (1) Der Vault-Pfad hat KEINEN Env-Default-Fallback — er ist entweder konfiguriert
 *       oder nicht (kein `WORKSPACE_DIR`-Äquivalent als Effektivwert). Die Effektivwert-
 *       Auflösung entfällt daher; der Router liest den konfigurierten Wert direkt.
 *
 *   (2) Die Mount-Root-Schranke ist OPTIONAL (obsidian-vault-config §Rahmen + AC3):
 *       ist die Env `OBSIDIAN_VAULT_DIR` gesetzt, gilt sie als harte Containment-Schranke
 *       (Modell a, Path-Traversal-/Symlink-sicher — gleiche Härte wie WorkspaceMutator);
 *       ist sie NICHT gesetzt, gilt allein „lesbar aus Backend-Sicht" als wirksame Prüfung
 *       (kein Container-Containment möglich, aber kein Fehler).
 *
 *   (3) Zusätzliche fachliche Prüfung: der Vault MUSS einen Unterordner „Projekte"
 *       (Verzeichnis) enthalten (AC2c) — die Auswahlgrundlage für den späteren
 *       Projekt-Anlage-Flow ([[obsidian-project-intake]], AC5/S-246).
 *
 * Security (Floor, hart):
 *   - Vault-Pfad ist KEIN Geheimnis → Klartext im meta-Block, nie in `entries` (AC4).
 *   - Bei gesetzter Schranke: realpath-Containment beider Seiten + Trailing-Slash-Prefix
 *     (Symlink-/`..`-Flucht wird erkannt und abgewiesen, AC3).
 *   - Kein hartkodiertes Secret; der Pfad wird als Klartext-Betreiber-Info behandelt.
 *
 * @module obsidianVaultPath
 */

import { realpath, stat, access, constants } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';

/** Name des geforderten Unterordners im Vault (obsidian-vault-config AC2c). */
export const PROJEKTE_SUBDIR = 'Projekte';

/**
 * Name der OPTIONALEN Mount-Root-Env (Containment-Schranke, analog `WORKSPACE_DIR`).
 * Ist sie gesetzt, wird der Vault-Pfad strikt auf diese Schranke confined (AC3).
 * Deploy-Zeit-Konfiguration (Volume-Mount) — s. obsidian-vault-config §Rahmen / A1.
 */
export const OBSIDIAN_VAULT_MOUNT_ENV = 'OBSIDIAN_VAULT_DIR';

/**
 * @typedef {'empty-path'|'outside-boundary'|'not-exists'|'not-directory'|'not-readable'|'missing-projekte'} ObsidianVaultPathErrorClass
 */

/**
 * Typisierter Fehler für Vault-Pfad-Validierungsfehler.
 * Der Router mappt jede Instanz auf `422` mit feldzugeordneter Meldung (AC2/AC3).
 */
export class ObsidianVaultPathError extends Error {
  /** @type {ObsidianVaultPathErrorClass} */
  errorClass;

  /**
   * @param {string} message
   * @param {ObsidianVaultPathErrorClass} errorClass
   */
  constructor(message, errorClass) {
    super(message);
    this.name = 'ObsidianVaultPathError';
    this.errorClass = errorClass;
  }
}

/**
 * Liefert die aktive Mount-Root-Schranke (falls per Env gesetzt), sonst null.
 * Nur zur UI-Orientierung im GET-Endpunkt (`mountRoot?`) und für den Containment-Check.
 *
 * @param {object} [deps]
 * @param {string} [deps.mountRoot]  Override für Tests (statt Env).
 * @returns {string|null}
 */
export function resolveMountRoot(deps = {}) {
  const raw = deps.mountRoot ?? process.env[OBSIDIAN_VAULT_MOUNT_ENV] ?? '';
  return raw && raw.trim() ? raw.trim() : null;
}

/**
 * Validiert einen einzugebenden Obsidian-Vault-Pfad (AC2/AC3).
 *
 * Regeln (Reihenfolge):
 *   1. Pfad darf nicht leer/whitespace sein → `empty-path`.
 *   2. Ist `OBSIDIAN_VAULT_DIR` gesetzt: Containment-Check (realpath beide Seiten,
 *      Trailing-Slash-Prefix). Außerhalb / Symlink-Flucht → `outside-boundary` (AC3).
 *      Ist die Env NICHT gesetzt: Schritt 2 entfällt (kein Container-Containment).
 *   3. Pfad muss existieren und ein Verzeichnis sein → `not-exists` / `not-directory`.
 *   4. Pfad muss lesbar sein (Backend-uid, R_OK) → `not-readable`.
 *   5. Pfad muss einen Unterordner „Projekte" (Verzeichnis) enthalten → `missing-projekte` (AC2c).
 *
 * @param {string} inputPath  Eingegebener Pfad (untrusted, aus HTTP-Body).
 * @param {object} [deps]     Injectable dependencies für Tests.
 * @param {Function} [deps.realpath]  `(p) => Promise<string>` — default: node:fs/promises.realpath
 * @param {Function} [deps.stat]      `(p) => Promise<Stats>`  — default: node:fs/promises.stat
 * @param {Function} [deps.access]    `(p, mode) => Promise<void>` — default: node:fs/promises.access
 * @param {string}   [deps.mountRoot] Override für OBSIDIAN_VAULT_DIR (Tests).
 * @returns {Promise<{ resolvedPath: string }>}  Kanonischer (realpath-aufgelöster) Pfad bei Erfolg.
 * @throws {ObsidianVaultPathError} bei Validierungsfehler — bisher konfigurierter Wert bleibt unberührt.
 */
export async function validateObsidianVaultPath(inputPath, deps = {}) {
  const _realpath = deps.realpath ?? realpath;
  const _stat = deps.stat ?? stat;
  const _access = deps.access ?? access;

  // (1) Leer/whitespace
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new ObsidianVaultPathError('Pfad darf nicht leer sein', 'empty-path');
  }

  const normalized = resolve(inputPath.trim());

  // Eingegebenen Pfad via realpath auflösen (fängt Symlinks + `..` ab; schlägt fehl wenn
  // nicht existent → dann greift der stat()-Check unten als klarer `not-exists`).
  let resolvedInput;
  try {
    resolvedInput = await _realpath(normalized);
  } catch {
    resolvedInput = null;
  }
  const pathToCheck = resolvedInput ?? normalized;

  // (2) OPTIONALE Containment-Schranke (AC3) — nur wenn OBSIDIAN_VAULT_DIR gesetzt ist.
  const mountRoot = resolveMountRoot(deps);
  if (mountRoot) {
    let resolvedMountRoot;
    try {
      resolvedMountRoot = await _realpath(mountRoot);
    } catch {
      throw new ObsidianVaultPathError(
        `Gemountete Schranke ${OBSIDIAN_VAULT_MOUNT_ENV} ('${mountRoot}') existiert nicht oder ist nicht zugänglich`,
        'outside-boundary',
      );
    }

    // Trailing-Slash-Prefix (nicht nacktes startsWith — sonst würde `/vault-evil`
    // für die Schranke `/vault` fälschlich durchgehen).
    const mountPrefix = resolvedMountRoot.endsWith(sep) ? resolvedMountRoot : resolvedMountRoot + sep;
    const isInsideBoundary =
      pathToCheck === resolvedMountRoot || pathToCheck.startsWith(mountPrefix);

    if (!isInsideBoundary) {
      throw new ObsidianVaultPathError(
        `Pfad '${inputPath.trim()}' liegt außerhalb der gemounteten Schranke ${OBSIDIAN_VAULT_MOUNT_ENV} ('${mountRoot}') — ` +
        'Pfad nicht im Container erreichbar / außerhalb des gemounteten Vault-Roots',
        'outside-boundary',
      );
    }
  }

  // (3) Existenz + Verzeichnis
  let statResult;
  try {
    statResult = await _stat(pathToCheck);
  } catch {
    throw new ObsidianVaultPathError(`Pfad '${inputPath.trim()}' existiert nicht`, 'not-exists');
  }
  if (!statResult.isDirectory()) {
    throw new ObsidianVaultPathError(
      `Pfad '${inputPath.trim()}' ist kein Verzeichnis (Datei gefunden)`,
      'not-directory',
    );
  }

  // (4) Lesbar (Backend-uid)
  try {
    await _access(pathToCheck, constants.R_OK);
  } catch {
    throw new ObsidianVaultPathError(`Pfad '${inputPath.trim()}' ist nicht lesbar`, 'not-readable');
  }

  // (5) Unterordner „Projekte" (Verzeichnis) — AC2c
  const projektePath = join(pathToCheck, PROJEKTE_SUBDIR);
  let projekteStat;
  try {
    projekteStat = await _stat(projektePath);
  } catch {
    throw new ObsidianVaultPathError(
      `Vault-Pfad '${inputPath.trim()}' enthält keinen Unterordner '${PROJEKTE_SUBDIR}'`,
      'missing-projekte',
    );
  }
  if (!projekteStat.isDirectory()) {
    throw new ObsidianVaultPathError(
      `'${PROJEKTE_SUBDIR}' im Vault-Pfad '${inputPath.trim()}' ist kein Verzeichnis`,
      'missing-projekte',
    );
  }

  return { resolvedPath: pathToCheck };
}
