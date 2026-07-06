/**
 * RepoSizeScanner.test.js — Unit-Tests für rekursiven Verzeichnis-Scan mit Bucket-Zuordnung
 * (docs/specs/repo-size-badge.md AC1, AC2)
 *
 * Covers:
 *   AC1  — Drei-Bucket-Aufteilung (git, artifacts, workspace) mit korrekter Größensumme
 *          Artefakt-Verzeichnisse (node_modules, .claude/worktrees, etc.) an beliebiger Tiefe
 *          werden vollständig dem artifacts-Bucket zugeordnet, keine Doppelzählung
 *   AC2  — Pfad-/Symlink-Schutz: realpath-Check auf WORKSPACE_DIR-Boundary,
 *          Symlinks nicht verfolgt, kein Dateisystem-Walk außerhalb des Mounts
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoSizeScanner } from '../src/RepoSizeScanner.js';

// ── Hilfsfunktionen ──────────────────────────────────────────────────────

/**
 * Erzeugt eine Test-Fixture mit Workspace-Root und Test-Repo.
 * Rückgabe: { workspaceRoot, repoPath, cleanup, writeFixedFile }
 */
async function createTestFixture(repoName = 'test-repo') {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'repo-size-scanner-ws-'));
  const repoPath = join(workspaceRoot, repoName);
  await mkdir(repoPath);

  const cleanup = () => rm(workspaceRoot, { recursive: true, force: true });

  const writeFixedFile = async (dirPath, name, sizeBytes) => {
    const content = Buffer.alloc(sizeBytes, 'a');
    await writeFile(join(dirPath, name), content);
  };

  return { workspaceRoot, repoPath, cleanup, writeFixedFile };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('RepoSizeScanner', () => {
  let fixture;

  beforeEach(async () => {
    fixture = await createTestFixture();
  });

  afterEach(async () => {
    if (fixture?.cleanup) {
      await fixture.cleanup();
    }
  });

  describe('AC1: Drei-Bucket-Aufteilung', () => {
    it('should measure .git directory separately', async () => {
      const { workspaceRoot, repoPath, writeFixedFile } = fixture;

      // Struktur: repo/.git/HEAD + src/index.js
      await mkdir(join(repoPath, '.git'));
      await writeFixedFile(join(repoPath, '.git'), 'HEAD', 100);
      await mkdir(join(repoPath, 'src'));
      await writeFixedFile(join(repoPath, 'src'), 'index.js', 50);

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      const result = await scanner.scan('test-repo');

      // .git sollte ~100 Bytes enthalten
      expect(result.git).toBeGreaterThanOrEqual(100);
      // src/index.js sollte im workspace-Bucket sein
      expect(result.workspace).toBeGreaterThanOrEqual(50);
      expect(result.artifacts).toBe(0);
      expect(result.total).toBe(result.git + result.artifacts + result.workspace);
    });

    it('should detect single-segment artifacts (node_modules) at arbitrary depth', async () => {
      const { workspaceRoot, repoPath, writeFixedFile } = fixture;

      // Struktur: repo/node_modules + repo/src/node_modules + repo/code.js
      await mkdir(join(repoPath, 'node_modules', 'pkg'), { recursive: true });
      await writeFixedFile(join(repoPath, 'node_modules', 'pkg'), 'index.js', 200);

      await mkdir(join(repoPath, 'src', 'node_modules', 'pkg2'), { recursive: true });
      await writeFixedFile(join(repoPath, 'src', 'node_modules', 'pkg2'), 'index.js', 150);

      await writeFixedFile(repoPath, 'code.js', 75);

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      const result = await scanner.scan('test-repo');

      // Beide node_modules sollten in artifacts sein
      expect(result.artifacts).toBeGreaterThanOrEqual(200 + 150);
      expect(result.workspace).toBeGreaterThanOrEqual(75);
      expect(result.git).toBe(0);
    });

    it('should detect .claude/worktrees at root level', async () => {
      const { workspaceRoot, repoPath, writeFixedFile } = fixture;

      // Struktur: repo/.claude/worktrees/wt1/file.txt + repo/src/index.js
      await mkdir(join(repoPath, '.claude', 'worktrees', 'wt1'), { recursive: true });
      await writeFixedFile(join(repoPath, '.claude', 'worktrees', 'wt1'), 'file.txt', 300);

      await mkdir(join(repoPath, 'src'));
      await writeFixedFile(join(repoPath, 'src'), 'index.js', 50);

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      const result = await scanner.scan('test-repo');

      // .claude/worktrees sollte in artifacts sein
      expect(result.artifacts).toBeGreaterThanOrEqual(300);
      expect(result.workspace).toBeGreaterThanOrEqual(50);
      expect(result.git).toBe(0);
    });

    it('should detect .claude/worktrees at nested depth (BUG-FIX)', async () => {
      const { workspaceRoot, repoPath, writeFixedFile } = fixture;

      // REGRESSION CASE: .claude/worktrees ist NICHT direkt unter Root, sondern verschachtelt
      // Struktur: repo/sub/.claude/worktrees/wt1/file.txt + repo/code.js
      await mkdir(join(repoPath, 'sub', '.claude', 'worktrees', 'wt1'), { recursive: true });
      await writeFixedFile(join(repoPath, 'sub', '.claude', 'worktrees', 'wt1'), 'file.txt', 400);

      await writeFixedFile(repoPath, 'code.js', 60);

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      const result = await scanner.scan('test-repo');

      // Die verschachtelte .claude/worktrees sollte JETZT in artifacts sein (BUG-FIX)
      expect(result.artifacts).toBeGreaterThanOrEqual(400);
      expect(result.workspace).toBeGreaterThanOrEqual(60);
      expect(result.git).toBe(0);
    });

    it('should not have false positives (foo.claude/worktrees should NOT match)', async () => {
      const { workspaceRoot, repoPath, writeFixedFile } = fixture;

      // Struktur: repo/foo.claude/worktrees/file.txt + repo/code.js
      // "foo.claude/worktrees" sollte NICHT als .claude/worktrees erkannt werden
      await mkdir(join(repoPath, 'foo.claude', 'worktrees'), { recursive: true });
      await writeFixedFile(join(repoPath, 'foo.claude', 'worktrees'), 'file.txt', 250);

      await writeFixedFile(repoPath, 'code.js', 40);

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      const result = await scanner.scan('test-repo');

      // foo.claude/worktrees ist KEIN Artifact — muss in workspace sein
      expect(result.artifacts).toBe(0);
      expect(result.workspace).toBeGreaterThanOrEqual(250 + 40);
      expect(result.git).toBe(0);
    });

    it('should count .git inside .claude/worktrees as artifacts, not as git bucket', async () => {
      const { workspaceRoot, repoPath, writeFixedFile } = fixture;

      // Struktur:
      //   repo/
      //     .git/HEAD
      //     .claude/worktrees/wt1/.git/HEAD + file.txt
      await mkdir(join(repoPath, '.git'));
      await writeFixedFile(join(repoPath, '.git'), 'HEAD', 100);

      await mkdir(join(repoPath, '.claude', 'worktrees', 'wt1', '.git'), { recursive: true });
      await writeFixedFile(join(repoPath, '.claude', 'worktrees', 'wt1', '.git'), 'HEAD', 50);
      await writeFixedFile(join(repoPath, '.claude', 'worktrees', 'wt1'), 'file.txt', 200);

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      const result = await scanner.scan('test-repo');

      // Top-level .git → git bucket
      expect(result.git).toBeGreaterThanOrEqual(100);

      // Everything inside .claude/worktrees (including its .git) → artifacts bucket
      expect(result.artifacts).toBeGreaterThanOrEqual(200 + 50);

      // Workspace contains root dir inode (no other files/dirs at root level besides .git/.claude/worktrees)
      expect(result.workspace).toBeGreaterThanOrEqual(0);
    });

    it('should compute total = git + artifacts + workspace', async () => {
      const { workspaceRoot, repoPath, writeFixedFile } = fixture;

      // Struktur:
      //   repo/
      //     .git/file
      //     node_modules/file
      //     src/code.js
      await mkdir(join(repoPath, '.git'));
      await writeFixedFile(join(repoPath, '.git'), 'file', 100);

      await mkdir(join(repoPath, 'node_modules'));
      await writeFixedFile(join(repoPath, 'node_modules'), 'file', 200);

      await mkdir(join(repoPath, 'src'));
      await writeFixedFile(join(repoPath, 'src'), 'code.js', 150);

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      const result = await scanner.scan('test-repo');

      // Die Summe sollte mindestens die Summe aller expliziten Dateien sein
      expect(result.total).toBeGreaterThanOrEqual(100 + 200 + 150);
      expect(result.total).toBe(result.git + result.artifacts + result.workspace);
    });
  });

  describe('AC2: Pfad-/Symlink-Schutz', () => {
    it('should reject traversal attempts (..)', async () => {
      const { workspaceRoot } = fixture;

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      await expect(scanner.scan('..')).rejects.toThrow(
        /Ungültiger Slug — keine Pfad-Komponenten erlaubt/,
      );
    });

    it('should reject absolute paths', async () => {
      const { workspaceRoot } = fixture;

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      await expect(scanner.scan('/etc/passwd')).rejects.toThrow(
        /Ungültiger Slug — keine Pfad-Komponenten erlaubt/,
      );
    });

    it('should reject slugs with path separators', async () => {
      const { workspaceRoot } = fixture;

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      await expect(scanner.scan('sub/dir/file')).rejects.toThrow(
        /Ungültiger Slug — keine Pfad-Komponenten erlaubt/,
      );
    });

    it('should reject non-existent repos', async () => {
      const { workspaceRoot } = fixture;

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      await expect(scanner.scan('non-existent-repo')).rejects.toThrow(
        /Klon-Ordner existiert nicht/,
      );
    });

    it('should not follow a symlink pointing outside WORKSPACE_DIR (no escape, no size contribution)', async () => {
      const { workspaceRoot, repoPath, writeFixedFile } = fixture;

      // Ziel AUSSERHALB des Workspace-Roots, mit signifikanter Größe — würde die
      // Summe verfälschen, wenn der Walk dem Symlink folgen würde.
      const outsideDir = await mkdtemp(join(tmpdir(), 'repo-size-scanner-outside-'));
      await writeFixedFile(outsideDir, 'secret-large-file.bin', 5_000_000);

      const linkPath = join(repoPath, 'escape-link');
      await symlink(outsideDir, linkPath, 'dir');

      // Referenzgröße: derselbe Klon ohne den Symlink.
      await writeFixedFile(repoPath, 'normal-file.txt', 1000);

      const scanner = new RepoSizeScanner({
        workspaceRootResolver: async () => ({ path: workspaceRoot }),
      });

      const result = await scanner.scan('test-repo');

      // Der Symlink selbst (Metadaten) darf mitgezählt werden, aber NICHT sein
      // Ziel — die Summe darf nicht in Richtung der 5MB-Außendatei ausschlagen.
      expect(result.total).toBeLessThan(100_000);

      await rm(outsideDir, { recursive: true, force: true });
    });
  });
});
