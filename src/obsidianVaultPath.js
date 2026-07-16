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
 *   (3) Zusätzliche fachliche Prüfung: der Vault MUSS einen **konfigurierbaren**
 *       Projekt-Unterordner (Verzeichnis, Default „Projekte", Mehrebenen-Segmente wie
 *       „300 Projekte/Studis Softwareschmiede" erlaubt — s. `OBSIDIAN_PROJEKTE_SUBDIR_ENV`,
 *       obsidian-vault-config v2/S-330) enthalten (AC2c) — die Auswahlgrundlage für den
 *       späteren Projekt-Anlage-Flow ([[obsidian-project-intake]], AC5/S-246).
 *
 * Security (Floor, hart):
 *   - Vault-Pfad ist KEIN Geheimnis → Klartext im meta-Block, nie in `entries` (AC4).
 *   - Bei gesetzter Schranke: realpath-Containment beider Seiten + Trailing-Slash-Prefix
 *     (Symlink-/`..`-Flucht wird erkannt und abgewiesen, AC3).
 *   - Der konfigurierte Projekt-Unterordner (Env, untrusted-nah) wird NACH Auflösung per
 *     `realpath` ebenfalls gegen den Vault-Pfad confined (gleiche Trailing-Slash-Prefix-
 *     Technik) — ein Segment mit `..`, das aus dem Vault hinausführt, wird abgewiesen
 *     (obsidian-vault-config v2/S-330).
 *   - Kein hartkodiertes Secret; der Pfad wird als Klartext-Betreiber-Info behandelt.
 *
 * `listObsidianVaultProjects` (obsidian-vault-config AC5, S-246) listet die direkten
 * Unterordner unter `<vault>/<konfigurierter Projekt-Unterordner>` — strikt auf diesen
 * Ordner confined (AC3):
 *   - Jeder Eintrag wird per `realpath` aufgelöst und gegen die `<vault>/<Projekt-Unterordner>`-
 *     Schranke geprüft (gleiche Trailing-Slash-Prefix-Technik wie oben) — ein Symlink, der aus
 *     dem Vault hinausführt, wird NICHT gelistet (still übersprungen, kein Fehler).
 *   - Nur Verzeichnisse (nach Symlink-Auflösung); keine Dateien, keine versteckten/Dot-Einträge.
 *   - Race-sicher: verschwindet der Vault/Projekt-Unterordner zwischen Config-Read und Listing
 *     (extern entfernt/unmounted), wird ein definierter Fehler geworfen (`vault-unreachable` /
 *     `missing-projekte`) — kein Crash. Ein einzelner Eintrag, der währenddessen verschwindet
 *     oder ein kaputter Symlink ist, wird übersprungen statt die ganze Liste scheitern zu lassen.
 *
 * @module obsidianVaultPath
 */

import { realpath, stat, access, constants, readdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';

/** Default-Name des Projekt-Unterordners im Vault (Rückwärtskompatibilität, obsidian-vault-config AC2c). */
export const PROJEKTE_SUBDIR = 'Projekte';

/**
 * Name der OPTIONALEN Env für ein konfigurierbares Projekt-Unterordner-Pfad-Segment
 * (obsidian-vault-config v2, S-330 — Owner-Vorfall 2026-07-08: der reale Vault hat keinen
 * Ordner „Projekte", sondern „300 Projekte/Studis Softwareschmiede/<Projekt>"). Muster
 * analog `OBSIDIAN_VAULT_MOUNT_ENV`. Ist sie gesetzt (nicht leer), ersetzt ihr getrimmter
 * Wert `PROJEKTE_SUBDIR` als Projekt-Unterordner-Segment; Mehrebenen-Segmente sind erlaubt
 * (`join()` verarbeitet sie transparent). Ist sie NICHT gesetzt, bleibt der Default
 * „Projekte" wirksam (Rückwärtskompatibilität — bestehende Deployments/Tests brechen nicht).
 */
export const OBSIDIAN_PROJEKTE_SUBDIR_ENV = 'OBSIDIAN_PROJEKTE_SUBDIR';

/**
 * Name der OPTIONALEN Mount-Root-Env (Containment-Schranke, analog `WORKSPACE_DIR`).
 * Ist sie gesetzt, wird der Vault-Pfad strikt auf diese Schranke confined (AC3).
 * Deploy-Zeit-Konfiguration (Volume-Mount) — s. obsidian-vault-config §Rahmen / A1.
 */
export const OBSIDIAN_VAULT_MOUNT_ENV = 'OBSIDIAN_VAULT_DIR';

/**
 * Liefert das effektive Projekt-Unterordner-Pfad-Segment (Env `OBSIDIAN_PROJEKTE_SUBDIR`
 * oder Default `PROJEKTE_SUBDIR`, obsidian-vault-config v2/S-330). Mehrebenen-Segmente
 * („300 Projekte/Studis Softwareschmiede") sind als String erlaubt — `join()` verarbeitet
 * sie transparent. Traversal-Schutz erfolgt NICHT hier (String-Ebene), sondern per
 * realpath-Confinement-Check am aufgelösten Ergebnis-Pfad (s. `validateObsidianVaultPath`
 * Schritt 5 / `listObsidianVaultProjects`) — dieselbe Technik wie für Projekt-Einträge (AC3).
 *
 * @param {object} [deps]
 * @param {string} [deps.projekteSubdir]  Override für Tests (statt Env).
 * @returns {string}
 */
export function resolveProjekteSubdir(deps = {}) {
  const raw = deps.projekteSubdir ?? process.env[OBSIDIAN_PROJEKTE_SUBDIR_ENV] ?? '';
  return raw && raw.trim() ? raw.trim() : PROJEKTE_SUBDIR;
}

/**
 * @typedef {'empty-path'|'outside-boundary'|'not-exists'|'not-directory'|'not-readable'|'missing-projekte'|'vault-unreachable'} ObsidianVaultPathErrorClass
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
 *   5. Pfad muss einen konfigurierbaren Projekt-Unterordner (Verzeichnis, Default „Projekte",
 *      Mehrebenen erlaubt, realpath-confined gegen den Vault) enthalten → `missing-projekte` (AC2c).
 *
 * @param {string} inputPath  Eingegebener Pfad (untrusted, aus HTTP-Body).
 * @param {object} [deps]     Injectable dependencies für Tests.
 * @param {Function} [deps.realpath]  `(p) => Promise<string>` — default: node:fs/promises.realpath
 * @param {Function} [deps.stat]      `(p) => Promise<Stats>`  — default: node:fs/promises.stat
 * @param {Function} [deps.access]    `(p, mode) => Promise<void>` — default: node:fs/promises.access
 * @param {string}   [deps.mountRoot] Override für OBSIDIAN_VAULT_DIR (Tests).
 * @param {string}   [deps.projekteSubdir] Override für OBSIDIAN_PROJEKTE_SUBDIR (Tests).
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

  // (5) Konfigurierbarer Projekt-Unterordner (Verzeichnis, Default „Projekte", Mehrebenen
  // erlaubt) — AC2c / obsidian-vault-config v2 (S-330). Das Segment stammt aus Env/Config
  // (untrusted-nah) — daher realpath-Confinement-Check gegen den Vault (`pathToCheck`),
  // gleiche Trailing-Slash-Prefix-Technik wie die Mount-Root-Schranke oben: ein Segment mit
  // `..`, das aus dem Vault hinausführt, wird abgewiesen, BEVOR es als gültig gilt.
  const projekteSubdir = resolveProjekteSubdir(deps);
  const projektePath = join(pathToCheck, projekteSubdir);

  let resolvedProjekte;
  try {
    resolvedProjekte = await _realpath(projektePath);
  } catch {
    throw new ObsidianVaultPathError(
      `Vault-Pfad '${inputPath.trim()}' enthält keinen Unterordner '${projekteSubdir}'`,
      'missing-projekte',
    );
  }

  const vaultPathPrefix = pathToCheck.endsWith(sep) ? pathToCheck : pathToCheck + sep;
  const projekteConfined =
    resolvedProjekte === pathToCheck || resolvedProjekte.startsWith(vaultPathPrefix);
  if (!projekteConfined) {
    throw new ObsidianVaultPathError(
      `Vault-Pfad '${inputPath.trim()}' enthält keinen Unterordner '${projekteSubdir}'`,
      'missing-projekte',
    );
  }

  let projekteStat;
  try {
    projekteStat = await _stat(resolvedProjekte);
  } catch {
    throw new ObsidianVaultPathError(
      `Vault-Pfad '${inputPath.trim()}' enthält keinen Unterordner '${projekteSubdir}'`,
      'missing-projekte',
    );
  }
  if (!projekteStat.isDirectory()) {
    throw new ObsidianVaultPathError(
      `'${projekteSubdir}' im Vault-Pfad '${inputPath.trim()}' ist kein Verzeichnis`,
      'missing-projekte',
    );
  }

  return { resolvedPath: pathToCheck };
}

/**
 * Listet die direkten Unterordner unter `<vault>/<Projekt-Unterordner>` (obsidian-vault-config
 * AC5, S-246). Der Projekt-Unterordner ist konfigurierbar (`OBSIDIAN_PROJEKTE_SUBDIR`, Default
 * „Projekte", Mehrebenen-Segmente wie „300 Projekte/Studis Softwareschmiede" erlaubt — v2/S-330).
 *
 * Confinement (AC3, hart): ZWEI Ebenen —
 *   (1) `<vault>/<Projekt-Unterordner>` selbst wird nach `realpath`-Auflösung gegen `vaultRoot`
 *       geprüft (Trailing-Slash-Prefix, wie in `validateObsidianVaultPath`) — ist das Segment
 *       SELBST ein Symlink (oder per `..` konstruiert), der aus dem Vault hinausführt (Race/
 *       externe Manipulation NACH dem Setzen bzw. böswillige Konfiguration), wird die gesamte
 *       Auflistung mit `missing-projekte` abgewiesen, BEVOR `readdir` je aufgerufen wird (sonst
 *       würde der komplette externe Zielordner gelistet).
 *   (2) jeder Eintrag UNTER `<vault>/<Projekt-Unterordner>` wird per `realpath` aufgelöst und
 *       MUSS innerhalb der (bereits confinierten) Schranke liegen. Ein Symlink, der aus dem
 *       Vault hinausführt, wird still übersprungen (nicht gelistet) — kein Fehler für die
 *       gesamte Liste.
 *
 * Filter (AC5): nur Verzeichnisse (nach Symlink-Auflösung); keine `.md`-Dateien, keine
 * versteckten/Dot-Ordner (Name beginnt mit `.`); stabil sortiert (nach `name`).
 *
 * Race-Sicherheit (Edge-Case): verschwindet der Vault selbst zwischen Config-Read und Listing
 * → `vault-unreachable`. Fehlt/ist-keine-Verzeichnis der Projekt-Unterordner (auch race, nach
 * dem Setzen extern entfernt) → `missing-projekte`. Ein einzelner Eintrag, der währenddessen
 * verschwindet oder ein kaputter Symlink ist, wird übersprungen statt die ganze Auflistung zu werfen.
 *
 * @param {string} vaultPath  Der konfigurierte (bereits validierte/persistierte) Vault-Pfad.
 * @param {object} [deps]     Injectable dependencies für Tests.
 * @param {Function} [deps.realpath]  default: node:fs/promises.realpath
 * @param {Function} [deps.stat]      default: node:fs/promises.stat
 * @param {Function} [deps.readdir]   default: node:fs/promises.readdir
 * @param {string}   [deps.projekteSubdir] Override für OBSIDIAN_PROJEKTE_SUBDIR (Tests).
 * @returns {Promise<Array<{ name: string, path: string }>>}
 * @throws {ObsidianVaultPathError} `vault-unreachable` | `missing-projekte`
 */
export async function listObsidianVaultProjects(vaultPath, deps = {}) {
  const _realpath = deps.realpath ?? realpath;
  const _stat = deps.stat ?? stat;
  const _readdir = deps.readdir ?? readdir;
  const projekteSubdir = resolveProjekteSubdir(deps);

  // Vault selbst muss (noch) erreichbar sein — Race: extern entfernt/unmounted.
  let vaultRoot;
  try {
    vaultRoot = await _realpath(vaultPath);
  } catch {
    throw new ObsidianVaultPathError(
      `Obsidian-Vault '${vaultPath}' ist nicht mehr erreichbar`,
      'vault-unreachable',
    );
  }

  // Konfigurierter Projekt-Unterordner muss existieren und ein Verzeichnis sein.
  const projektePath = join(vaultRoot, projekteSubdir);
  let projekteRoot;
  try {
    projekteRoot = await _realpath(projektePath);
  } catch {
    throw new ObsidianVaultPathError(
      `Vault enthält keinen Unterordner '${projekteSubdir}'`,
      'missing-projekte',
    );
  }

  // Confinement (AC3, hart): der Projekt-Unterordner selbst kann ein Symlink sein, der aus dem
  // Vault hinausführt (Race/externe Manipulation NACH dem Setzen), oder — bei Mehrebenen-
  // Segmenten — per `..` aus dem Vault konstruiert sein (v2/S-330) — projekteRoot MUSS
  // innerhalb vaultRoot liegen, sonst würde der komplette externe Zielordner gelistet
  // (security/R02).
  const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
  const projekteConfined = projekteRoot === vaultRoot || projekteRoot.startsWith(vaultPrefix);
  if (!projekteConfined) {
    throw new ObsidianVaultPathError(
      `Vault enthält keinen Unterordner '${projekteSubdir}'`,
      'missing-projekte',
    );
  }

  let projekteStat;
  try {
    projekteStat = await _stat(projekteRoot);
  } catch {
    throw new ObsidianVaultPathError(
      `Vault enthält keinen Unterordner '${projekteSubdir}'`,
      'missing-projekte',
    );
  }
  if (!projekteStat.isDirectory()) {
    throw new ObsidianVaultPathError(
      `'${projekteSubdir}' im Vault ist kein Verzeichnis`,
      'missing-projekte',
    );
  }

  let dirents;
  try {
    dirents = await _readdir(projekteRoot, { withFileTypes: true });
  } catch {
    // Race: Projekt-Unterordner zwischen stat() und readdir() entfernt.
    throw new ObsidianVaultPathError(
      `Vault enthält keinen Unterordner '${projekteSubdir}'`,
      'missing-projekte',
    );
  }

  const projektePrefix = projekteRoot.endsWith(sep) ? projekteRoot : projekteRoot + sep;
  const results = [];

  for (const dirent of dirents) {
    const name = dirent.name;

    // Keine versteckten/Dot-Ordner (auch keine Dot-Dateien) — AC5.
    if (name.startsWith('.')) continue;

    const entryPath = join(projekteRoot, name);

    // realpath auflösen — fängt Symlinks ab (Confinement) UND kaputte Symlinks/Races
    // (Eintrag wird zwischen readdir() und hier entfernt) → übersprungen, kein Fehler.
    let resolvedEntry;
    try {
      resolvedEntry = await _realpath(entryPath);
    } catch {
      continue;
    }

    // Confinement (AC3, hart): Eintrag muss innerhalb <vault>/<Projekt-Unterordner> liegen —
    // ein Symlink, der aus dem Vault hinausführt, wird NICHT gelistet.
    const isConfined = resolvedEntry === projekteRoot || resolvedEntry.startsWith(projektePrefix);
    if (!isConfined) continue;

    // Nur Verzeichnisse (nach Symlink-Auflösung); keine .md-Dateien.
    let entryStat;
    try {
      entryStat = await _stat(resolvedEntry);
    } catch {
      continue;
    }
    if (!entryStat.isDirectory()) continue;

    results.push({ name, path: resolvedEntry });
  }

  // Stabil sortiert (nach Name).
  results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return results;
}
