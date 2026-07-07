/**
 * GitReadBoundary — read-only Git-Lesezugriff für den Taktgeber
 * (docs/specs/drain-origin-progress-sync.md AC1, AC2, Verträge §Git-Lesezugriff).
 *
 * Kapselt GENAU die vier Git-Operationen, die `ProjectDrain` braucht, um seinen
 * Board-Snapshot bei `merge_policy: pr`-Projekten aus dem `origin`-Stand statt
 * dem (ggf. staleren) lokalen Working-Tree abzuleiten — OHNE den Working-Tree
 * jemals zu mutieren:
 *   - `fetchOrigin(repoPath)`      — read-only `git fetch origin` (nur .git/refs).
 *   - `resolveTruthRef(repoPath)`  — bestimmt, ob `origin` strikt voraus ist
 *                                    (ancestry-basiert, `git merge-base
 *                                    --is-ancestor`).
 *   - `readFileAtRef(repoPath, ref, relPath)` — `git show <ref>:<relPath>`.
 *   - `listFilesAtRef(repoPath, ref, relDir)` — `git ls-tree -r --name-only
 *                                                 <ref> <relDir>`.
 *
 * Sicherheitsleitplanke (Trauma-Vorfall 2026-07-02, HART — Kern dieser Spec):
 *   Dieses Modul enthält AUSSCHLIESSLICH `fetch` (Refs) + read-only
 *   Objekt-Lese-Kommandos (`merge-base`, `show`, `ls-tree`, `rev-parse`). Es
 *   gibt HIER KEINEN Code-Pfad für `pull`/`merge`/`checkout`/`reset`/`clean`/
 *   `stash` — ein geteilter Working-Tree wird durch dieses Modul NIE
 *   verändert. Alle Git-Aufrufe laufen über `execFile` mit Array-Argumenten
 *   (kein Shell-String, keine Interpolation von Fremd-Eingaben) — `repoPath`
 *   stammt aus der bereits validierten Projekt-Auflösung (BoardAggregator-
 *   Index / BOARD_ROOTS), `ref`/`relPath` sind intern erzeugte, geprüfte Werte.
 *
 * Fehlerverhalten (non-fatal, degradierend — AC1/AC4):
 *   Jede Methode wirft NIE synchron unerwartet — Git-Fehler (kein Remote,
 *   kein Upstream, Timeout, Ref-Lese-Fehler) werden zu einem definierten
 *   Rückgabewert (`{ ok:false }` bzw. `null`) normalisiert. Der Aufrufer
 *   (`ProjectDrain`) entscheidet anhand dessen über Fallback auf den
 *   Working-Tree + `verified`-Status.
 *
 * @module GitReadBoundary
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, sep } from 'node:path';

const execFileAsync = promisify(execFile);

/** Timeout für `git fetch` (Netzwerk-Operation, kann langsam/hängend sein). */
export const GIT_FETCH_TIMEOUT_MS = 15_000;

/** Timeout für lokale, read-only Git-Objekt-Operationen (kein Netzwerk). */
export const GIT_LOCAL_TIMEOUT_MS = 5_000;

/**
 * Default exec: `execFile` mit Timeout, kein Shell-String (Sicherheits-Floor).
 * @param {string[]} args  Git-Subkommando + Argumente (OHNE das führende "git").
 * @param {{ cwd: string, timeout?: number }} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function defaultGitExec(args, { cwd, timeout }) {
  return execFileAsync('git', args, { cwd, timeout: timeout ?? GIT_LOCAL_TIMEOUT_MS, encoding: 'utf8' });
}

/**
 * @param {object} [deps]
 * @param {(args: string[], opts: { cwd: string, timeout?: number }) => Promise<{stdout:string,stderr:string}>} [deps.gitExec]
 *   injizierbar für Tests (Default: echter `git`-Kindprozess via `execFile`).
 */
export class GitReadBoundary {
  #gitExec;

  constructor({ gitExec } = {}) {
    this.#gitExec = gitExec ?? defaultGitExec;
  }

  /**
   * Read-only `git fetch origin` — aktualisiert ausschliesslich `.git/refs`,
   * berührt den Working-Tree NIE (AC1). Non-fatal: ein Fehler liefert
   * `{ ok:false }` statt zu werfen.
   *
   * Edge-Case "kein Remote konfiguriert" (Spec §Edge-Cases): existiert
   * `origin` gar nicht (kein Remote, kein Repo, ungewöhnlicher Zustand), gibt
   * es **keine** Fetch-Quelle, die staler sein könnte als der Working-Tree —
   * der Working-Tree ist dann bereits die Wahrheit und gilt **als verifiziert**
   * (`ok:true`, `fetched:false`). NUR ein tatsächlicher Fetch-FEHLER bei
   * vorhandenem Remote (offline/transient/Timeout) liefert `ok:false`
   * (unverifiziert, AC1/AC4) — sonst würde jedes Projekt ohne `origin`
   * (oder mit einem ungültigen `repoPath` in Tests) fälschlich dauerhaft als
   * unverifiziert gelten und nie mehr eskalieren können.
   *
   * @param {string} repoPath  absoluter Projektpfad.
   * @returns {Promise<{ ok: true, fetched: boolean } | { ok: false, reason: string }>}
   */
  async fetchOrigin(repoPath) {
    let hasOrigin;
    try {
      await this.#gitExec(['remote', 'get-url', 'origin'], { cwd: repoPath });
      hasOrigin = true;
    } catch {
      hasOrigin = false;
    }
    if (!hasOrigin) {
      // Kein Remote (oder repoPath ist gar kein Git-Repo) → Working-Tree ist
      // bereits die Wahrheit, kein Fetch nötig/möglich (Spec-Edge-Case).
      return { ok: true, fetched: false };
    }
    try {
      await this.#gitExec(['fetch', '--quiet', 'origin'], { cwd: repoPath, timeout: GIT_FETCH_TIMEOUT_MS });
      return { ok: true, fetched: true };
    } catch (err) {
      return { ok: false, reason: err && err.message ? String(err.message).slice(0, 300) : 'fetch failed' };
    }
  }

  /**
   * Truth-Ref-Auswahl (ancestry-basiert, AC2, Verträge §Git-Lesezugriff):
   * Existiert ein Remote-Tracking-Ref (`@{u}`) UND ist der lokale `HEAD` ein
   * ECHTER Vorfahr davon (`git merge-base --is-ancestor HEAD <ref>`, Exit 0)
   * UND `HEAD` != `<ref>` → `origin` ist strikt voraus, der Board-Snapshot
   * soll aus `<ref>` gelesen werden. Sonst (kein Upstream, `HEAD == origin`,
   * `HEAD` voraus, oder ein Lese-Fehler) → Working-Tree bleibt Quelle.
   *
   * Wirft NIE — jeder Fehlerpfad liefert `{ ahead:false, ref:null }`
   * (Fallback Working-Tree, Edge-Cases der Spec: kein Remote/kein Upstream/
   * detached HEAD/ungewöhnlicher Branch-Zustand).
   *
   * @param {string} repoPath
   * @returns {Promise<{ ahead: boolean, ref: string|null }>}
   */
  async resolveTruthRef(repoPath) {
    let upstreamRef;
    try {
      const { stdout } = await this.#gitExec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
        cwd: repoPath,
      });
      upstreamRef = stdout.trim();
    } catch {
      // Kein Upstream konfiguriert (oder detached HEAD) → Working-Tree bleibt Quelle.
      return { ahead: false, ref: null };
    }
    if (!upstreamRef) return { ahead: false, ref: null };

    let headRef;
    try {
      const { stdout } = await this.#gitExec(['rev-parse', 'HEAD'], { cwd: repoPath });
      headRef = stdout.trim();
    } catch {
      return { ahead: false, ref: null };
    }

    let upstreamSha;
    try {
      const { stdout } = await this.#gitExec(['rev-parse', upstreamRef], { cwd: repoPath });
      upstreamSha = stdout.trim();
    } catch {
      return { ahead: false, ref: null };
    }

    // HEAD == origin → kein "strikt voraus" (Working-Tree bleibt Quelle, korrekt).
    if (headRef === upstreamSha) return { ahead: false, ref: null };

    try {
      // Exit 0 = HEAD ist Vorfahr von upstreamSha ⇒ origin strikt voraus.
      await this.#gitExec(['merge-base', '--is-ancestor', headRef, upstreamSha], { cwd: repoPath });
      return { ahead: true, ref: upstreamRef };
    } catch {
      // Exit != 0 (HEAD nicht Vorfahr → lokal voraus/divergiert) ODER Kommando-
      // Fehler → NICHT als "origin voraus" werten (Working-Tree bleibt Quelle).
      return { ahead: false, ref: null };
    }
  }

  /**
   * Read-only Datei-Lese am Ref (`git show <ref>:<relPath>`, AC2 Verträge).
   * Existiert die Datei am Ref nicht (oder ein anderer Lese-Fehler) → `null`
   * (Edge-Case "Story existiert auf origin nicht" — kein Crash, wie ein
   * fehlendes fs-Readfile).
   *
   * @param {string} repoPath
   * @param {string} ref
   * @param {string} relPath  repo-relativer Pfad (Forward-Slash, git-intern).
   * @returns {Promise<string|null>}
   */
  async readFileAtRef(repoPath, ref, relPath) {
    try {
      const { stdout } = await this.#gitExec(['show', `${ref}:${relPath}`], { cwd: repoPath });
      return stdout;
    } catch {
      return null;
    }
  }

  /**
   * Read-only Datei-Aufzählung am Ref (`git ls-tree -r --name-only <ref>
   * <relDir>`, AC2 Verträge). Liefert repo-relative Pfade (Forward-Slash).
   * Existiert `relDir` am Ref nicht → leere Liste (kein Crash).
   *
   * @param {string} repoPath
   * @param {string} ref
   * @param {string} relDir  repo-relativer Verzeichnis-Pfad.
   * @returns {Promise<string[]>}
   */
  async listFilesAtRef(repoPath, ref, relDir) {
    try {
      const { stdout } = await this.#gitExec(['ls-tree', '-r', '--name-only', ref, relDir], { cwd: repoPath });
      return stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/** Default-Singleton (echter `git`-Kindprozess) — analog anderen Boundaries im Repo. */
export const gitReadBoundary = new GitReadBoundary();

/**
 * Baut eine `fsDeps`-kompatible Datei-Quelle (`readdir`/`readFile`), die
 * STATT des Working-Trees read-only aus einem Git-Ref liest (Snapshot-
 * Schnittstelle der Spec: `working-tree` ↔ `git-ref`, Verträge §Snapshot-
 * Schnittstelle). Deckt GENAU das Subset ab, das `BoardAggregator._readBoard`
 * + `computeStoryReadyStatus` brauchen (`readdir(dir, {withFileTypes:true})`,
 * `readFile(path, 'utf8')`) — die übrige `BoardAggregator`-Scan-/Ready-Logik
 * bleibt dadurch UNVERÄNDERT, nur die Datei-Quelle wird ausgetauscht.
 *
 * Pfade, die `_readBoard`/`computeStoryReadyStatus` übergeben, sind stets
 * ABSOLUTE Pfade unterhalb von `repoPath` (gebildet via `join(repoPath, …)`)
 * — diese Fabrik macht sie repo-relativ (Forward-Slash, git-intern) und
 * delegiert an `GitReadBoundary.readFileAtRef`/`listFilesAtRef`.
 *
 * @param {string} repoPath  absoluter Projektpfad (Basis für die Relativierung).
 * @param {string} ref       aufgelöster Truth-Ref (z.B. `origin/main`).
 * @param {GitReadBoundary} boundary
 * @returns {{ readdir: Function, readFile: Function }}
 */
export function createGitRefFsDeps(repoPath, ref, boundary) {
  const toRelPath = (absPath) => relative(repoPath, absPath).split(sep).join('/');

  return {
    /**
     * @param {string} dirPath  absoluter Pfad.
     * @param {{ withFileTypes?: boolean }} [opts]
     * @returns {Promise<Array<{ name: string, isFile: () => boolean, isDirectory: () => boolean, isSymbolicLink: () => boolean }>>}
     */
    async readdir(dirPath, opts = {}) {
      const relDir = toRelPath(dirPath);
      const files = await boundary.listFilesAtRef(repoPath, ref, relDir);
      // ls-tree -r liefert ausschliesslich BLOB-Pfade (Dateien, rekursiv) —
      // für die Zwecke von _readBoard genügt das: alle Aufrufer hier filtern
      // ohnehin nur auf Dateien (e.isFile() && e.name.endsWith('.yaml')), nie
      // auf Unterverzeichnisse. Ein leeres/nicht-existentes relDir → [].
      const prefix = relDir ? `${relDir}/` : '';
      const direntLike = files
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length))
        .filter((name) => name && !name.includes('/')) // nur direkte Kinder (keine tieferen Pfade)
        .map((name) => ({
          name,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        }));
      if (!opts.withFileTypes) return direntLike.map((d) => d.name);
      return direntLike;
    },

    /**
     * @param {string} filePath  absoluter Pfad.
     * @param {string} [_encoding]  ignoriert (immer utf8-String, wie `git show`).
     * @returns {Promise<string>}
     */
    async readFile(filePath, _encoding) {
      const relPath = toRelPath(filePath);
      const content = await boundary.readFileAtRef(repoPath, ref, relPath);
      if (content === null) {
        const err = new Error(`ENOENT: no such file at ref ${ref}: ${relPath}`);
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
  };
}
