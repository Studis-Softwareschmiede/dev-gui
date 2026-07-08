/**
 * @file RegressionSuiteReader.test.js — Unit-Tests für den Regressionstest-
 * Suite-Scanner (docs/specs/regression-run.md AC4, AC6).
 *
 * Covers (regression-run):
 *   AC4 — `readRegressionSuites()` liefert je Bereichs-/Verbund-Verzeichnis
 *         einen Suite-Eintrag mit dem aus der Begleitbeschreibung gelesenen
 *         `target` (`local | ephemeral-infra | url`).
 *   AC6 — Bei `target: ephemeral-infra` wird zusätzlich der `kosten`-Hinweis
 *         aus der Begleitbeschreibung durchgereicht.
 *
 * Zusätzlich getestet (Kontext, nicht überinterpretiert — Main Success
 * Scenario Schritt 1): ein synthetischer „Gesamt"-Eintrag wird ergänzt, wenn
 * mindestens eine reale Suite existiert; leerer/fehlender Baum → leere Liste
 * (kein Crash, Edge-Case-Verhalten der Spec).
 */

import { describe, it, expect } from '@jest/globals';
import { readRegressionSuites, parseSuiteFrontmatter } from '../src/RegressionSuiteReader.js';

/** Baut injectable fsDeps aus einer Verzeichnis-Struktur { [absPath]: { isDirectory, isFile, name } | fileContent }. */
function makeFsDeps({ dirs = {}, files = {} }) {
  const readdir = async (path) => {
    const entries = dirs[path];
    if (!entries) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return entries;
  };
  const readFile = async (path) => {
    if (!(path in files)) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return files[path];
  };
  return { readdir, readFile };
}

function direntDir(name) {
  return { name, isDirectory: () => true, isFile: () => false };
}
function direntFile(name) {
  return { name, isDirectory: () => false, isFile: () => true };
}

describe('RegressionSuiteReader — regression-run.md', () => {
  describe('parseSuiteFrontmatter', () => {
    it('parst target/kosten/url aus einem --- begrenzten Frontmatter-Block', () => {
      const content = '---\ntitle: X\ntarget: ephemeral-infra\nkosten: gering — simuliert\n---\n\n# Body';
      expect(parseSuiteFrontmatter(content)).toEqual({
        title: 'X',
        target: 'ephemeral-infra',
        kosten: 'gering — simuliert',
      });
    });

    it('liefert {} bei fehlendem Frontmatter (kein Crash)', () => {
      expect(parseSuiteFrontmatter('# Nur Markdown, kein Frontmatter')).toEqual({});
    });
  });

  describe('AC4 — target je Suite', () => {
    it('bereich-Verzeichnis mit .md-Begleitbeschreibung liefert deren target', async () => {
      const deps = makeFsDeps({
        dirs: {
          '/proj/tests/regression': [direntDir('board')],
          '/proj/tests/regression/board': [direntFile('example.md'), direntFile('example.spec.ts')],
        },
        files: {
          '/proj/tests/regression/board/example.md': '---\ntarget: local\n---\n# Board',
        },
      });
      const result = await readRegressionSuites('/proj', deps);
      const bereich = result.suites.find((s) => s.scope.typ === 'bereich' && s.scope.id === 'board');
      expect(bereich).toBeDefined();
      expect(bereich.target).toBe('local');
      expect(bereich.label).toBe('board');
    });

    it('verbund-Verzeichnis liefert eigenen Suite-Eintrag + entries-Liste', async () => {
      const deps = makeFsDeps({
        dirs: {
          '/proj/tests/regression': [direntDir('verbund')],
          '/proj/tests/regression/verbund': [direntFile('infra.md')],
        },
        files: {
          '/proj/tests/regression/verbund/infra.md':
            '---\ntarget: ephemeral-infra\nkosten: gering — simuliert\n---\n# Infra',
        },
      });
      const result = await readRegressionSuites('/proj', deps);
      const verbund = result.suites.find((s) => s.scope.typ === 'verbund');
      expect(verbund).toBeDefined();
      expect(verbund.target).toBe('ephemeral-infra');
      expect(verbund.entries).toEqual([
        { file: 'infra.md', target: 'ephemeral-infra', kosten: 'gering — simuliert' },
      ]);
    });

    it('target: url wird unverändert durchgereicht', async () => {
      const deps = makeFsDeps({
        dirs: {
          '/proj/tests/regression': [direntDir('preview')],
          '/proj/tests/regression/preview': [direntFile('smoke.md')],
        },
        files: {
          '/proj/tests/regression/preview/smoke.md': '---\ntarget: url\nurl: https://preview.example.com\n---\n',
        },
      });
      const result = await readRegressionSuites('/proj', deps);
      const bereich = result.suites.find((s) => s.scope.typ === 'bereich' && s.scope.id === 'preview');
      expect(bereich.target).toBe('url');
      expect(bereich.kosten).toBeUndefined();
    });
  });

  describe('AC6 — Kosten-/Ressourcen-Hinweis bei ephemeral-infra', () => {
    it('bereich mit target:ephemeral-infra + kosten liefert den Hinweis', async () => {
      const deps = makeFsDeps({
        dirs: {
          '/proj/tests/regression': [direntDir('infra-bereich')],
          '/proj/tests/regression/infra-bereich': [direntFile('a.md')],
        },
        files: {
          '/proj/tests/regression/infra-bereich/a.md':
            '---\ntarget: ephemeral-infra\nkosten: hoch — 3 VMs für 10min\n---\n',
        },
      });
      const result = await readRegressionSuites('/proj', deps);
      const bereich = result.suites.find((s) => s.scope.typ === 'bereich' && s.scope.id === 'infra-bereich');
      expect(bereich.kosten).toBe('hoch — 3 VMs für 10min');
    });

    it('target:local liefert KEINEN kosten-Hinweis, auch wenn im Frontmatter vorhanden', async () => {
      const deps = makeFsDeps({
        dirs: {
          '/proj/tests/regression': [direntDir('board')],
          '/proj/tests/regression/board': [direntFile('a.md')],
        },
        files: {
          '/proj/tests/regression/board/a.md': '---\ntarget: local\nkosten: sollte ignoriert werden\n---\n',
        },
      });
      const result = await readRegressionSuites('/proj', deps);
      const bereich = result.suites.find((s) => s.scope.typ === 'bereich' && s.scope.id === 'board');
      expect(bereich.kosten).toBeUndefined();
    });

    it('Gesamt-Eintrag aggregiert kosten-Hinweise aus enthaltenen ephemeral-infra-Suiten', async () => {
      const deps = makeFsDeps({
        dirs: {
          '/proj/tests/regression': [direntDir('board'), direntDir('verbund')],
          '/proj/tests/regression/board': [direntFile('a.md')],
          '/proj/tests/regression/verbund': [direntFile('infra.md')],
        },
        files: {
          '/proj/tests/regression/board/a.md': '---\ntarget: local\n---\n',
          '/proj/tests/regression/verbund/infra.md': '---\ntarget: ephemeral-infra\nkosten: gering\n---\n',
        },
      });
      const result = await readRegressionSuites('/proj', deps);
      const gesamt = result.suites.find((s) => s.scope.typ === 'gesamt');
      expect(gesamt).toBeDefined();
      expect(gesamt.kosten).toBe('gering');
    });
  });

  describe('Edge-Cases', () => {
    it('kein tests/regression-Verzeichnis → leere Liste (kein Crash)', async () => {
      const deps = makeFsDeps({ dirs: {}, files: {} });
      const result = await readRegressionSuites('/proj', deps);
      expect(result.suites).toEqual([]);
    });

    it('leeres tests/regression-Verzeichnis (keine Bereiche/Verbund) → leere Liste, kein Gesamt-Eintrag', async () => {
      const deps = makeFsDeps({ dirs: { '/proj/tests/regression': [] }, files: {} });
      const result = await readRegressionSuites('/proj', deps);
      expect(result.suites).toEqual([]);
    });

    it('Bereichs-Verzeichnis ohne .md-Dateien wird übersprungen', async () => {
      const deps = makeFsDeps({
        dirs: {
          '/proj/tests/regression': [direntDir('empty-bereich')],
          '/proj/tests/regression/empty-bereich': [direntFile('a.spec.ts')],
        },
        files: {},
      });
      const result = await readRegressionSuites('/proj', deps);
      expect(result.suites).toEqual([]);
    });
  });
});
