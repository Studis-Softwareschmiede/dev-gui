/**
 * GitSyncBoundary — eng begrenzte Git-Schreib-Boundary für den Vorbedingungs-
 * Sync des Ausführungs-Klons (docs/specs/drain-clone-precondition-sync.md
 * AC1–AC6, Verträge §Git-Zugriff).
 *
 * BEWUSST getrennt von `GitReadBoundary` (drain-origin-progress-sync): deren
 * Modul-Doktrin garantiert „KEIN Code-Pfad für pull/merge/checkout/reset/
 * clean/stash" — die bleibt unangetastet. DIESES Modul kapselt GENAU die vier
 * zusätzlichen Operationen, die der einmalige Vorbedingungs-Sync braucht:
 *   - `statusPorcelain(repoPath)`            — `git status --porcelain` (read-only).
 *   - `diffFile(repoPath, relPath)`          — `git diff -- <datei>` (read-only).
 *   - `checkoutFile(repoPath, relPath)`      — `git checkout -- <datei>` (die
 *     EINZIGE verwerfende Operation; der Aufrufer ruft sie AUSSCHLIESSLICH für
 *     eng-signierte EIGENE Taktgeber-Artefakte auf, A1 der Spec).
 *   - `mergeFfOnly(repoPath, ref)`           — `git merge --ff-only <ref>`
 *     (fast-forward-only, NIE Merge-Commit/Rebase/Reset, A3 der Spec).
 *
 * Sicherheitsleitplanke (Trauma-Vorfall 2026-07-02): KEIN `reset --hard`,
 * KEIN `clean`, KEIN `rebase`, KEIN `stash` — solche Pfade existieren hier
 * strukturell nicht. Alle Aufrufe via `execFile` mit Array-Argumenten (kein
 * Shell-String); `repoPath` stammt aus der validierten Projekt-Auflösung,
 * `relPath` aus dem eigenen `status --porcelain`-Ergebnis (repo-relativ).
 * `relPath` wird zusätzlich mit `--`-Trenner übergeben (keine Options-
 * Injektion über Dateinamen).
 *
 * Fehlerverhalten: non-fatal — jede Methode normalisiert Git-Fehler auf einen
 * definierten Rückgabewert (`{ ok:false }`/`null`), der Aufrufer
 * (`ProjectDrain#syncCloneToOrigin`) mappt das auf die Spec-Ausgänge.
 *
 * @module GitSyncBoundary
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Timeout für lokale Git-Operationen (kein Netzwerk). */
export const GIT_SYNC_LOCAL_TIMEOUT_MS = 10_000;

/**
 * @param {string[]} args
 * @param {{ cwd: string, timeout?: number }} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function defaultGitExec(args, { cwd, timeout }) {
  return execFileAsync('git', args, { cwd, timeout: timeout ?? GIT_SYNC_LOCAL_TIMEOUT_MS, encoding: 'utf8' });
}

/**
 * @param {object} [deps]
 * @param {(args: string[], opts: { cwd: string, timeout?: number }) => Promise<{stdout:string,stderr:string}>} [deps.gitExec]
 *   injizierbar für Tests (Default: echter `git`-Kindprozess via `execFile`).
 */
export class GitSyncBoundary {
  #gitExec;

  constructor({ gitExec } = {}) {
    this.#gitExec = gitExec ?? defaultGitExec;
  }

  /**
   * `git status --porcelain` → Liste `{ code, relPath }` (repo-relative
   * Pfade). Fehler → `null` (Aufrufer behandelt als „Status unbestimmbar" →
   * konservativ kein Sync).
   *
   * @param {string} repoPath
   * @returns {Promise<Array<{ code: string, relPath: string }>|null>}
   */
  async statusPorcelain(repoPath) {
    try {
      const { stdout } = await this.#gitExec(['status', '--porcelain'], { cwd: repoPath });
      return stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => ({ code: line.slice(0, 2), relPath: line.slice(3).trim() }));
    } catch {
      return null;
    }
  }

  /**
   * `git diff -- <relPath>` (unstaged Diff der Datei) → Diff-Text oder `null`
   * bei Fehler.
   *
   * @param {string} repoPath
   * @param {string} relPath
   * @returns {Promise<string|null>}
   */
  async diffFile(repoPath, relPath) {
    try {
      const { stdout } = await this.#gitExec(['diff', '--', relPath], { cwd: repoPath });
      return stdout;
    } catch {
      return null;
    }
  }

  /**
   * `git checkout -- <relPath>` — verwirft die uncommitteten Änderungen GENAU
   * dieser Datei. Der Aufrufer garantiert per Signatur-Prüfung (A1), dass es
   * sich um ein EIGENES Taktgeber-Artefakt handelt.
   *
   * @param {string} repoPath
   * @param {string} relPath
   * @returns {Promise<{ ok: boolean }>}
   */
  async checkoutFile(repoPath, relPath) {
    try {
      await this.#gitExec(['checkout', '--', relPath], { cwd: repoPath });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Upstream-Ref des aktuellen Branches (`@{u}`, z.B. `origin/main`) —
   * `null`, wenn keiner konfiguriert ist (detached HEAD / kein Upstream).
   *
   * @param {string} repoPath
   * @returns {Promise<string|null>}
   */
  async upstreamRef(repoPath) {
    try {
      const { stdout } = await this.#gitExec(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        { cwd: repoPath },
      );
      const ref = stdout.trim();
      return ref === '' ? null : ref;
    } catch {
      return null;
    }
  }

  /**
   * `git merge --ff-only <ref>` — bringt den aktuellen Branch fast-forward-only
   * auf `<ref>` (typisch das Upstream-Ref aus `resolveTruthRef`). Nicht
   * ff-baubar oder anderer Fehler → `{ ok:false }` (der Aufrufer mappt auf
   * `clone-diverged`).
   *
   * @param {string} repoPath
   * @param {string} ref
   * @returns {Promise<{ ok: boolean }>}
   */
  async mergeFfOnly(repoPath, ref) {
    try {
      await this.#gitExec(['merge', '--ff-only', '--quiet', ref], { cwd: repoPath });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
}

/** Default-Singleton (echter `git`-Kindprozess) — injizierbar für Tests. */
export const gitSyncBoundary = new GitSyncBoundary();
