/**
 * RepoSizeScanner — Pfad-confined, rekursiver Verzeichnis-Scan für lokale Klone.
 * (docs/specs/repo-size-badge.md AC1, AC2)
 *
 * Vermisst einen Klon (aufgelöst über dieselbe geteilte Workspace-Auflösung wie
 * WorkspaceScanner/WorkspaceMutator) und liefert Größen in Bytes, aufgeteilt in
 * drei Buckets: `git`, `artifacts`, `workspace` (Rest), sowie `total`.
 *
 * Buckets (AC1):
 *   - `git`: Top-Level-`.git`-Verzeichnis (exkl. verschachtelte .git-Einträge).
 *   - `artifacts`: rekursive Summe aller Verzeichnisse mit Basisname in
 *     {node_modules, build, dist, .next, coverage, .claude/worktrees} an
 *     beliebiger Tiefe. Ein `.git` INNERHALB .claude/worktrees zählt zu
 *     artifacts, nicht zu git.
 *   - `workspace`: Rest (Gesamtverzeichnis − git − artifacts).
 *   - `total`: git + artifacts + workspace = volle Belegung des Klon-Ordners.
 *
 * Sicherheit (AC2):
 *   - Der aufgelöste Klon-Pfad muss strikt innerhalb des Effektivwerts
 *     WORKSPACE_DIR liegen (realpath-Check, Symlinks nicht verfolgt).
 *   - Traversal via `..`, absoluter Pfad oder Symlink-Flucht → Abweisung ohne
 *     Walk außerhalb des Mounts.
 *   - Beim rekursiven Walk werden Symlinks nicht verfolgt (Link-Eintrag selbst
 *     zählt zu seiner Parent-Kategorie, Ziel wird nie betreten).
 *
 * Implementation (Byte-Konsistenz):
 *   - Durchgehend: tatsächliche Datei-Byte-Größe (file.size aus stat), nicht
 *     Disk-Allocation (no apparent/allocated-Mischung).
 *   - Artefakt-Verzeichnis wird als Ganzes zugeordnet, nicht zusätzlich in
 *     workspace durchlaufen (keine Doppelzählung).
 *   - Verzeichnis-Größe selbst (Inode, Metadaten) wird bei `readdir`-Stat
 *     mitgerechnet — die gängige Praxis für Disk-Belags-Messung.
 *
 * @module RepoSizeScanner
 */

import { realpath, stat, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

/** Feste Artefakt-Namensliste (rekursiv an beliebiger Tiefe) — nur single-segment Basenames. */
const ARTIFACT_BASENAMES = new Set([
  'node_modules',
  'build',
  'dist',
  '.next',
  'coverage',
]);

/**
 * Prüft, ob ein Verzeichnis-Basename oder ein relativer Pfad zum Artefakt-Bucket gehört.
 *
 * @param {string} basename  Der Basisname des Verzeichnisses.
 * @param {string} [relativePathFromRoot]  Der relative Pfad ab Scan-Root (z.B. '.claude/worktrees').
 * @returns {boolean}
 */
function isArtifactBasename(basename, relativePathFromRoot = '') {
  // Single-segment Basenames
  if (ARTIFACT_BASENAMES.has(basename)) {
    return true;
  }
  // Zwei-Segment-Pfade wie '.claude/worktrees' — an beliebiger Tiefe
  // Normalisiere zu Forward-Slashes (Spec nutzt /, path.join nutzt sep der Plattform)
  const normalizedPath = relativePathFromRoot.replace(/\\/g, '/');
  if (normalizedPath === '.claude/worktrees' || normalizedPath.endsWith('/.claude/worktrees')) {
    return true;
  }
  return false;
}

/**
 * Berechnet rekursiv die Größe eines Verzeichnisses, aufgeteilt in Buckets.
 * (Standalone-Funktion für Testbarkeit)
 *
 * Rückgabe: `{ git, artifacts, workspace }`
 * - `git`: Größe des Top-Level-`.git` (nur wenn parentIsRoot=true und basename='.git')
 * - `artifacts`: Summe aller Verzeichnisse mit Artefakt-Basename + deren Kinder
 * - `workspace`: Rest (alles außer git und artifacts)
 *
 * @param {string} dirPath       Absoluter Pfad zum Verzeichnis.
 * @param {object} [opts]
 * @param {boolean} [opts.parentIsRoot] Ob dieses Verz. ein direktes Kind des Klons ist.
 * @param {string} [opts.basename] Der Basename dieses Verzeichnisses.
 * @param {string} [opts.relativePathFromRoot] Der relative Pfad ab Scan-Root (für .claude/worktrees-Erkennung).
 * @param {object} [opts.fsDeps] Injectable FS-Fns ({stat, readdir}); default: node:fs/promises.
 * @returns {Promise<{ git: number, artifacts: number, workspace: number }>}
 */
async function scanDirInternal(
  dirPath,
  { parentIsRoot = false, basename = '', relativePathFromRoot = '', fsDeps = { stat, readdir } } = {},
) {
  const result = { git: 0, artifacts: 0, workspace: 0 };

  // Wenn dieser Verzeichnis-Name ein Artefakt ist → alles darunter zu artifacts, nicht weiter durchlaufen.
  if (isArtifactBasename(basename, relativePathFromRoot)) {
    try {
      const dirStat = await fsDeps.stat(dirPath);
      result.artifacts = dirStat.size; // Verzeichnis-Inode selbst
      const entries = await fsDeps.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        const entryStat = await fsDeps.stat(entryPath, { bigint: false });
        result.artifacts += entryStat.size;
        // Rekursiv für Subdirs (aber nicht traversieren, nur Sum)
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          const subResultRelativePath = relativePathFromRoot
            ? join(relativePathFromRoot, entry.name)
            : entry.name;
          const subResult = await scanDirInternal(entryPath, {
            parentIsRoot: false,
            basename: entry.name,
            relativePathFromRoot: subResultRelativePath,
            fsDeps,
          });
          result.artifacts += subResult.artifacts + subResult.workspace + subResult.git;
        }
      }
    } catch {
      // Best-effort: Fehler bei Artefakt-Dir → dessen Größe wird
      // konservativ vernachlässigt (nicht in sum aufgenommen)
    }
    return result;
  }

  // Sonst: durchlaufen und Einträge kategorisieren
  try {
    const dirStat = await fsDeps.stat(dirPath);
    // Verzeichnis-Inode selbst zu workspace (oder git wenn Top-Level-.git)
    if (parentIsRoot && basename === '.git') {
      result.git = dirStat.size;
    } else {
      result.workspace = dirStat.size;
    }

    // Einträge lesen
    let entries;
    try {
      entries = await fsDeps.readdir(dirPath, { withFileTypes: true });
    } catch {
      // readdir fehlgeschlagen → wir haben nur Verzeichnis-Inode selbst, fertig
      return result;
    }

    // Jeder Eintrag durchlaufen
    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);
      let entryStat;

      // stat() ohne FOLLOW_SYMLINKS (default) — symlinks zählen, aber nicht verfolgen
      try {
        entryStat = await fsDeps.stat(entryPath);
      } catch {
        // Fehler bei stat (Zugriff verweigert, etc.) → überspringen
        continue;
      }

      const size = entryStat.size;

      // Symlinks: zählen, nicht verfolgen
      if (entry.isSymbolicLink()) {
        // Symlink-Inode zählt, aber wir traversieren nicht (kein rekursiver Aufruf)
        if (parentIsRoot && basename === '.git') {
          result.git += size;
        } else {
          result.workspace += size;
        }
        continue;
      }

      // Verzeichnisse: rekursiv
      if (entry.isDirectory()) {
        const subRelativePath = relativePathFromRoot
          ? join(relativePathFromRoot, entry.name)
          : entry.name;
        const subResult = await scanDirInternal(entryPath, {
          parentIsRoot: false,
          basename: entry.name,
          relativePathFromRoot: subRelativePath,
          fsDeps,
        });

        if (parentIsRoot && basename === '.git') {
          result.git += subResult.git + subResult.artifacts + subResult.workspace;
        } else {
          // Normal: .git zu git, andere Artefakte zu artifacts, Rest zu workspace
          result.git += subResult.git;
          result.artifacts += subResult.artifacts;
          result.workspace += subResult.workspace;
        }
      } else {
        // Dateien: Größe zu entsprechendem Bucket
        if (parentIsRoot && basename === '.git') {
          result.git += size;
        } else {
          result.workspace += size;
        }
      }
    }
  } catch {
    // Best-effort: top-level stat fehlgeschlagen → keine Größe, aber kein Crash
  }

  return result;
}

/**
 * RepoSizeScanner — misst einen lokalen Klon.
 *
 * @param {object} [options]
 * @param {Function} [options.workspaceRootResolver]
 *   Optionaler async Resolver wie WorkspaceScanner:
 *   `() => Promise<{ path: string, source: string }>`.
 *   Wenn nicht gesetzt: wird process.env.WORKSPACE_DIR genutzt.
 * @param {object} [options.fsDeps]
 *   Injectable FS-Fns für Tests: `{ stat, readdir }`.
 */
export class RepoSizeScanner {
  #workspaceRootResolver;
  #fsDeps;

  constructor({ workspaceRootResolver, fsDeps } = {}) {
    this.#workspaceRootResolver = workspaceRootResolver ?? null;
    this.#fsDeps = fsDeps ?? { stat, readdir };
  }

  /**
   * Scannt einen Klon-Ordner und liefert Größen in Bytes.
   *
   * @param {string} repoSlug  Direkt-Unter­ordner-Name des Klon unter WORKSPACE_DIR
   *   (z.B. "dev-gui"). **Kein** absoluter Pfad, kein Traversal-String.
   * @returns {Promise<{ total: number, git: number, artifacts: number, workspace: number }>}
   * @throws {Error} wenn Slug traversal-verdächtig ist oder Klon nicht existiert.
   */
  async scan(repoSlug) {
    // Slug validieren: keine Pfad-Komponenten
    if (typeof repoSlug !== 'string' || !repoSlug.trim()) {
      throw new Error('[RepoSizeScanner] Slug erforderlich');
    }

    const slug = repoSlug.trim();
    if (slug.includes('/') || slug === '.' || slug === '..') {
      throw new Error(
        '[RepoSizeScanner] Ungültiger Slug — keine Pfad-Komponenten erlaubt',
      );
    }

    // Workspace-Root auflösen
    let workspaceRoot;
    if (this.#workspaceRootResolver) {
      try {
        const resolved = await this.#workspaceRootResolver();
        workspaceRoot = resolved.path ?? '';
      } catch {
        throw new Error('[RepoSizeScanner] Workspace-Root-Auflösung fehlgeschlagen');
      }
    } else {
      workspaceRoot = process.env.WORKSPACE_DIR ?? '';
    }

    if (!workspaceRoot) {
      throw new Error('[RepoSizeScanner] WORKSPACE_DIR nicht konfiguriert');
    }

    // Klon-Pfad konstruieren
    const clonePath = join(workspaceRoot.trim(), slug);

    // realpath-Check: muss strikt innerhalb WORKSPACE_DIR liegen
    let resolvedRoot;
    let resolvedClone;

    try {
      resolvedRoot = await realpath(workspaceRoot.trim());
    } catch {
      throw new Error('[RepoSizeScanner] WORKSPACE_DIR existiert nicht');
    }

    try {
      resolvedClone = await realpath(clonePath);
    } catch {
      throw new Error(`[RepoSizeScanner] Klon-Ordner existiert nicht: ${slug}`);
    }

    // Boundary-Check: resolvedClone muss innerhalb resolvedRoot liegen
    const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    const isInside =
      resolvedClone === resolvedRoot || resolvedClone.startsWith(rootPrefix);

    if (!isInside) {
      throw new Error(
        `[RepoSizeScanner] Klon liegt außerhalb WORKSPACE_DIR: ${slug}`,
      );
    }

    // Klon-Verzeichnis ist Verzeichnis?
    let cloneStat;
    try {
      cloneStat = await this.#fsDeps.stat(resolvedClone);
    } catch {
      throw new Error(`[RepoSizeScanner] Klon ist kein Verzeichnis: ${slug}`);
    }

    if (!cloneStat.isDirectory()) {
      throw new Error(`[RepoSizeScanner] Klon ist kein Verzeichnis: ${slug}`);
    }

    // Scan durchführen (als Root-Scan)
    const buckets = await this.#scanDirAsRoot(resolvedClone);

    return {
      total: buckets.git + buckets.artifacts + buckets.workspace,
      git: buckets.git,
      artifacts: buckets.artifacts,
      workspace: buckets.workspace,
    };
  }

  /**
   * Scannt ein Verzeichnis als Klon-Root (parentIsRoot=true für Kinder).
   * Interne Hilfsfunktion.
   *
   * @param {string} dirPath
   * @returns {Promise<{ git: number, artifacts: number, workspace: number }>}
   */
  async #scanDirAsRoot(dirPath) {
    const result = { git: 0, artifacts: 0, workspace: 0 };

    try {
      const dirStat = await this.#fsDeps.stat(dirPath);
      result.workspace = dirStat.size; // Root-Verz.-Inode selbst

      let entries;
      try {
        entries = await this.#fsDeps.readdir(dirPath, { withFileTypes: true });
      } catch {
        return result; // readdir fehlgeschlagen → nur Inode-Größe
      }

      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);

        let entryStat;
        try {
          entryStat = await this.#fsDeps.stat(entryPath);
        } catch {
          continue;
        }

        // Symlinks: zählen, nicht verfolgen
        if (entry.isSymbolicLink()) {
          result.workspace += entryStat.size;
          continue;
        }

        // Verzeichnisse: rekursiv scannen
        if (entry.isDirectory()) {
          const subResult = await scanDirInternal(entryPath, {
            parentIsRoot: true,
            basename: entry.name,
            relativePathFromRoot: entry.name,
            fsDeps: this.#fsDeps,
          });
          result.git += subResult.git;
          result.artifacts += subResult.artifacts;
          result.workspace += subResult.workspace;
        } else {
          // Dateien
          result.workspace += entryStat.size;
        }
      }
    } catch {
      // top-level stat fehlgeschlagen → leere Buckets (best-effort)
    }

    return result;
  }
}

// Export für Tests
export { scanDirInternal as _scanDirInternal };

/**
 * Leichtgewichtige Existenz-/Confinement-Prüfung eines Klon-Ordners, ohne einen
 * vollen rekursiven Scan anzustoßen (S-298 AC7 — Refresh-Endpunkt validiert den
 * Slug, bevor er einen Hintergrund-Job triggert).
 *
 * WICHTIG (Fix S-298 CHANGES-REQUIRED, coder/R03-Vorfall 2026-07-06):
 * `workspaceRootResolver()` liefert `{ path, source }` (S-047/RepoSizeScanner-
 * Konvention, siehe `resolveWorkspaceRoot()`-Doku in workspacePath.js) — NIE das
 * Rückgabeobjekt selbst als Pfad verwenden, sondern immer `.path` entnehmen.
 *
 * @param {{ slug: string, workspaceRootResolver?: Function, fsDeps?: { stat?: Function, realpath?: Function } }} params
 * @returns {Promise<boolean>} true nur wenn der Klon-Ordner existiert UND strikt
 *   innerhalb des aufgelösten Workspace-Roots liegt (realpath-Check, Symlink-sicher).
 */
export async function cloneExists({ slug, workspaceRootResolver, fsDeps = {} }) {
  if (typeof slug !== 'string' || !slug.trim()) return false;
  const cleanSlug = slug.trim();
  if (cleanSlug.includes('/') || cleanSlug === '.' || cleanSlug === '..') return false;
  if (!workspaceRootResolver) return false;

  const doRealpath = fsDeps.realpath ?? realpath;
  const doStat = fsDeps.stat ?? stat;

  let workspaceRoot;
  try {
    // Fix: `.path` entnehmen — der Resolver liefert { path, source }, nicht den Pfad direkt.
    const resolved = await workspaceRootResolver();
    workspaceRoot = resolved?.path ?? '';
  } catch {
    return false;
  }
  if (!workspaceRoot.trim()) return false;

  let resolvedRoot;
  try {
    resolvedRoot = await doRealpath(workspaceRoot.trim());
  } catch {
    return false;
  }

  const clonePath = join(workspaceRoot.trim(), cleanSlug);
  let resolvedClone;
  try {
    resolvedClone = await doRealpath(clonePath);
  } catch {
    return false; // Klon existiert nicht
  }

  // Confinement: Klon muss strikt innerhalb des Roots liegen (Symlink-Flucht-Schutz).
  const confinedRoot = resolvedRoot + sep;
  if (!(resolvedClone + sep).startsWith(confinedRoot)) return false;

  try {
    const st = await doStat(resolvedClone);
    return st.isDirectory();
  } catch {
    return false;
  }
}
