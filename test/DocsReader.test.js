/**
 * DocsReader.test.js — Unit tests for DocsReader (src/DocsReader.js).
 *
 * Covers (projekt-spezifikation-anzeige):
 *   AC1 — getDocs() liefert Doku-Struktur (Pfad, Titel, Typ, Spec-Status aus Frontmatter)
 *          für README + docs/*.md + docs/specs/*.md (+ docs/architecture/* falls Ordner);
 *          fehlende Doku → leer, kein Crash.
 *   AC2 — getRaw() liefert Roh-Markdown einer Datei (Inhalt korrekt).
 *   AC3 — Pfad-Sicherheit: absolute Pfade abgewiesen; ..-Segmente abgewiesen;
 *          Symlink-Traversal (realpath außerhalb repoPath) abgewiesen;
 *          gültige Pfade innerhalb repoPath → Inhalt geliefert.
 *
 * Strategy:
 *   Inject fake fsDeps (readFile, readdir, realpath) — kein echtes Filesystem.
 *   Alle Fixture-Daten in-memory aufgebaut (coder.md Lesson 2026-06-13:
 *   Stichprobe-Realismus: Frontmatter mit '---'-Block, wie in realen Specs).
 */

import { describe, it, expect } from '@jest/globals';
import { DocsReader, parseFrontmatter } from '../src/DocsReader.js';

// ── Hilfsfunktion: fsDeps-Stub aus einem In-Memory-Filesystem aufbauen ────────

/**
 * Baut einen fsDeps-Stub aus einem flachen Map<string, string> (Pfad → Inhalt).
 * readdir gibt für jeden Verzeichnispfad die passenden Datei-Einträge zurück.
 * realpath gibt den Pfad unverändert zurück (kein Symlink-Auflösung nötig im Basis-Fall).
 *
 * @param {Record<string, string>} files  Pfad → Inhalt
 * @param {string} [realRepoPath]         Optional: Realpath des repoPath
 * @returns {object} fsDeps-Stub
 */
function buildFsDeps(files, realRepoPath) {
  return {
    readFile: async (p) => {
      const norm = p.replace(/\\/g, '/');
      if (norm in files) return files[norm];
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
      err.code = 'ENOENT';
      throw err;
    },
    readdir: async (dir, opts) => {
      const norm = dir.replace(/\\/g, '/') + '/';
      const entries = [];
      for (const fp of Object.keys(files)) {
        if (!fp.startsWith(norm)) continue;
        const rest = fp.slice(norm.length);
        if (rest.includes('/')) continue; // nur direkte Kinder
        const name = rest;
        if (opts?.withFileTypes) {
          entries.push({ name, isFile: () => true, isDirectory: () => false });
        } else {
          entries.push(name);
        }
      }
      if (entries.length === 0) {
        const err = new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return entries;
    },
    realpath: async (p) => {
      // Wenn ein spezieller realRepoPath für den repoPath selbst übergeben wurde
      if (realRepoPath && p === realRepoPath) return realRepoPath;
      // Kandidat-Pfad: nur zurückgeben wenn er in den bekannten Dateien vorkommt
      const norm = p.replace(/\\/g, '/');
      if (norm in files || Object.keys(files).some((f) => f.startsWith(norm + '/'))) {
        return p;
      }
      const err = new Error(`ENOENT: no such file or directory, lstat '${p}'`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses id/title/status/version aus einem Spec-Frontmatter', () => {
    const md = `---
id: foo-spec
title: Foo Spezifikation
status: active
version: 2
---

# Inhalt`;
    const fm = parseFrontmatter(md);
    expect(fm.id).toBe('foo-spec');
    expect(fm.title).toBe('Foo Spezifikation');
    expect(fm.status).toBe('active');
    expect(fm.version).toBe(2);
  });

  it('gibt leeres Objekt bei fehlendem --- zurück', () => {
    const fm = parseFrontmatter('# Kein Frontmatter\n');
    expect(fm).toEqual({});
  });

  it('parst Werte in Anführungszeichen', () => {
    const md = `---\ntitle: "Quoted Title"\n---\n`;
    expect(parseFrontmatter(md).title).toBe('Quoted Title');
  });

  it('parst einzelne Anführungszeichen', () => {
    const md = `---\nstatus: 'draft'\n---\n`;
    expect(parseFrontmatter(md).status).toBe('draft');
  });

  it('gibt leeres Objekt bei null/undefined zurück', () => {
    expect(parseFrontmatter(null)).toEqual({});
    expect(parseFrontmatter(undefined)).toEqual({});
  });
});

// ── DocsReader.getDocs — AC1 ──────────────────────────────────────────────────

describe('DocsReader.getDocs — AC1', () => {
  const REPO = '/workspace/myproject';

  it('gibt leere Liste zurück wenn Repo-Root keine Doku enthält', async () => {
    const fsDeps = buildFsDeps({});
    const reader = new DocsReader(fsDeps);
    const docs = await reader.getDocs(REPO);
    expect(docs).toEqual([]);
  });

  it('liefert README.md als type:readme', async () => {
    const fsDeps = buildFsDeps({ [`${REPO}/README.md`]: '# Hello' });
    const reader = new DocsReader(fsDeps);
    const docs = await reader.getDocs(REPO);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ path: 'README.md', title: 'README', type: 'readme', status: null });
  });

  it('liefert docs/*.md — concept.md als konzept, architecture.md als architektur', async () => {
    const files = {
      [`${REPO}/docs/concept.md`]: '# Konzept',
      [`${REPO}/docs/architecture.md`]: '# Arch',
    };
    const fsDeps = buildFsDeps(files);
    const reader = new DocsReader(fsDeps);
    const docs = await reader.getDocs(REPO);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain('docs/concept.md');
    expect(paths).toContain('docs/architecture.md');
    const concept = docs.find((d) => d.path === 'docs/concept.md');
    const arch    = docs.find((d) => d.path === 'docs/architecture.md');
    expect(concept.type).toBe('konzept');
    expect(arch.type).toBe('architektur');
  });

  it('liefert docs/specs/*.md als type:spec mit Frontmatter', async () => {
    const specContent = `---
id: foo-spec
title: Foo Spezifikation
status: active
version: 1
---
# Inhalt`;
    const files = { [`${REPO}/docs/specs/foo.md`]: specContent };
    const fsDeps = buildFsDeps(files);
    const reader = new DocsReader(fsDeps);
    const docs = await reader.getDocs(REPO);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      path: 'docs/specs/foo.md',
      title: 'Foo Spezifikation',
      type: 'spec',
      status: 'active',
      id: 'foo-spec',
      version: 1,
    });
  });

  it('liefert docs/architecture/*.md als type:architektur (falls Ordner existiert)', async () => {
    const files = { [`${REPO}/docs/architecture/framework-build.md`]: '# Build' };
    const fsDeps = buildFsDeps(files);
    const reader = new DocsReader(fsDeps);
    const docs = await reader.getDocs(REPO);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      path: 'docs/architecture/framework-build.md',
      type: 'architektur',
    });
  });

  it('überspringt fehlende Ordner ohne Crash (fehlende Doku → leer)', async () => {
    // Kein Fehler, auch wenn README/docs/docs/specs/docs/architecture alle fehlen
    const fsDeps = buildFsDeps({});
    const reader = new DocsReader(fsDeps);
    const docs = await reader.getDocs(REPO);
    expect(Array.isArray(docs)).toBe(true);
    expect(docs).toHaveLength(0);
  });

  it('liefert Dateinamen als Titel wenn kein Frontmatter-title vorhanden', async () => {
    const files = { [`${REPO}/docs/specs/my-feature.md`]: '# Kein Frontmatter\n' };
    const fsDeps = buildFsDeps(files);
    const reader = new DocsReader(fsDeps);
    const docs = await reader.getDocs(REPO);
    expect(docs[0].title).toBe('my-feature');
    expect(docs[0].status).toBeNull();
  });

  it('gibt leere Liste bei ungültigem repoPath zurück', async () => {
    const fsDeps = buildFsDeps({});
    const reader = new DocsReader(fsDeps);
    expect(await reader.getDocs(null)).toEqual([]);
    expect(await reader.getDocs('')).toEqual([]);
    expect(await reader.getDocs(42)).toEqual([]);
  });

  it('Stichprobe-Realismus: reales Frontmatter-Format (Spec-Datei mit YAML-Block)', async () => {
    // Simulation einer echten Spec wie projekt-spezifikation-anzeige.md
    const specContent = `---
id: projekt-spezifikation-anzeige
title: Projekt-Spezifikation — Repo-Doku
status: active
version: 1
---

# Spec: Projekt-Spezifikation anzeigen

> **Schicht 3 von 3.**`;
    const files = { [`${REPO}/docs/specs/projekt-spezifikation-anzeige.md`]: specContent };
    const fsDeps = buildFsDeps(files);
    const reader = new DocsReader(fsDeps);
    const docs = await reader.getDocs(REPO);
    expect(docs[0].id).toBe('projekt-spezifikation-anzeige');
    expect(docs[0].title).toBe('Projekt-Spezifikation — Repo-Doku');
    expect(docs[0].status).toBe('active');
    expect(docs[0].version).toBe(1);
  });
});

// ── DocsReader.getRaw — AC2 + AC3 ────────────────────────────────────────────

describe('DocsReader.getRaw — AC2: Dateiinhalt lesen', () => {
  const REPO = '/workspace/myproject';

  it('gibt Inhalt von README.md zurück', async () => {
    const files = { [`${REPO}/README.md`]: '# Hello World' };
    const fsDeps = buildFsDeps(files);
    const reader = new DocsReader(fsDeps);
    const result = await reader.getRaw(REPO, 'README.md');
    expect(result.error).toBeUndefined();
    expect(result.content).toBe('# Hello World');
  });

  it('gibt Inhalt einer Spec zurück', async () => {
    const content = '---\nid: foo\n---\n# Foo';
    const files = { [`${REPO}/docs/specs/foo.md`]: content };
    const fsDeps = buildFsDeps(files);
    const reader = new DocsReader(fsDeps);
    const result = await reader.getRaw(REPO, 'docs/specs/foo.md');
    expect(result.content).toBe(content);
  });

  it('gibt not-found zurück wenn Datei nicht existiert', async () => {
    const fsDeps = buildFsDeps({});
    const reader = new DocsReader(fsDeps);
    const result = await reader.getRaw(REPO, 'README.md');
    expect(result.code).toBe('not-found');
  });
});

describe('DocsReader.getRaw — AC3: Pfad-Sicherheit', () => {
  const REPO = '/workspace/myproject';

  it('weist absoluten Pfad ab', async () => {
    const fsDeps = buildFsDeps({});
    const reader = new DocsReader(fsDeps);
    const result = await reader.getRaw(REPO, '/etc/passwd');
    expect(result.code).toBe('traversal');
    expect(result.error).toMatch(/absolute/);
  });

  it('weist Pfad mit ..-Segment ab', async () => {
    const fsDeps = buildFsDeps({});
    const reader = new DocsReader(fsDeps);
    const result = await reader.getRaw(REPO, '../../../etc/passwd');
    expect(result.code).toBe('traversal');
    expect(result.error).toMatch(/traversal/);
  });

  it('weist Pfad mit eingebettetem .. ab (docs/../../../etc/passwd)', async () => {
    const fsDeps = buildFsDeps({});
    const reader = new DocsReader(fsDeps);
    const result = await reader.getRaw(REPO, 'docs/../../../etc/passwd');
    expect(result.code).toBe('traversal');
  });

  it('weist leeren Pfad ab', async () => {
    const fsDeps = buildFsDeps({});
    const reader = new DocsReader(fsDeps);
    const result = await reader.getRaw(REPO, '');
    expect(result.code).toBe('traversal');
  });

  it('weist null-Pfad ab', async () => {
    const fsDeps = buildFsDeps({});
    const reader = new DocsReader(fsDeps);
    const result = await reader.getRaw(REPO, null);
    expect(result.code).toBe('traversal');
  });

  it('weist Symlink-Traversal ab (realpath zeigt außerhalb repoPath)', async () => {
    // realpath für die Datei gibt einen Pfad AUSSERHALB des Repos zurück
    const fsDeps = {
      readFile: async () => { throw new Error('ENOENT'); },
      readdir: async () => { throw new Error('ENOENT'); },
      realpath: async (p) => {
        // repoPath selbst → korrekt
        if (p === REPO) return REPO;
        // Kandidat-Pfad → Symlink-Traversal außerhalb
        return '/etc/passwd';
      },
    };
    const reader = new DocsReader(fsDeps);
    const result = await reader.getRaw(REPO, 'docs/link.md');
    expect(result.code).toBe('traversal');
    expect(result.error).toMatch(/traversal/);
  });

  it('erlaubt gültige Datei innerhalb repoPath', async () => {
    const files = { [`${REPO}/docs/concept.md`]: '# Konzept' };
    const fsDeps = buildFsDeps(files);
    const reader = new DocsReader(fsDeps);
    const result = await reader.getRaw(REPO, 'docs/concept.md');
    expect(result.content).toBe('# Konzept');
    expect(result.error).toBeUndefined();
  });
});


// ── spec-bereichs-filter AC1 (S-295): area-Frontmatter-Durchreichung ──────────
describe('DocsReader area-Frontmatter (spec-bereichs-filter AC1, S-295)', () => {
  it('reicht area aus dem Spec-Frontmatter durch; fehlend -> null', async () => {
    const files = {
      '/repo/docs/specs/mit-area.md': "---\nid: mit-area\ntitle: Mit\nstatus: active\narea: board\n---\n# x\n",
      '/repo/docs/specs/ohne-area.md': "---\nid: ohne-area\ntitle: Ohne\nstatus: active\n---\n# y\n",
    };
    const reader = new DocsReader({
      readdir: async (dir, _o) => {
        if (String(dir).endsWith('docs/specs')) {
          return Object.keys(files).map((p) => ({ name: p.split('/').pop(), isFile: () => true, isDirectory: () => false }));
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      readFile: async (p) => {
        const hit = files[String(p)];
        if (hit == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return hit;
      },
    });
    const entries = await reader.getDocs('/repo');
    const mit = entries.find((e) => e.id === 'mit-area');
    const ohne = entries.find((e) => e.id === 'ohne-area');
    expect(mit.area).toBe('board');
    expect(ohne.area).toBeNull();
  });
});
