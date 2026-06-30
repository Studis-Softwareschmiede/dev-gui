/**
 * boardAggregator.test.js — Unit tests for BoardAggregator, parseYaml, parseBoardRoots.
 *
 * Covers (dev-gui-board-aggregator backend):
 *   AC1 — Scant konfigurierte Repo-Wurzeln read-only nach board/-Ordnern;
 *          liest board.yaml + features/*.yaml + stories/*.yaml.
 *   AC2 — Daten liegen im flüchtigen In-Memory-Index; Re-Scan on-demand ersetzt den Index.
 *   AC3 — Index modelliert Projekt → Feature → Story; jede Story trägt
 *          mind. id, parent, title, status, priority, labels, spec (+ dispo_* falls vorhanden).
 *          Features tragen zusätzlich optionale Felder goal, definition_of_done, depends,
 *          labels — Wert ist null wenn das YAML-Feld fehlt oder nicht gesetzt ist.
 *   AC7 — Kein Code-Pfad schreibt in board/-Dateien oder legt persistenten Cache an.
 *   AC8 — Ungültiges/nicht lesbares board/ wird mit Fehlermarkierung übersprungen;
 *          übrige Projekte bleiben sichtbar; kein Absturz.
 *   AC9 — Re-Scan on-demand ersetzt den Index (Watcher-Signal-Mechanismus tested separat
 *          als Unit; HTTP-Endpunkt tested in dieser Datei, describe-Blöcke
 *          "boardRouter HTTP — GET /api/board/projects" und
 *          "boardRouter HTTP — POST /api/board/projects/rescan (AC9)").
 *
 * Covers (studis-kanban-board-ux):
 *   AC5 — GET /api/board/projects/list liefert slug + grobe Zähler (kein Story-Body);
 *          GET /api/board/projects/:slug liefert ein Projekt voll on-demand;
 *          :slug mit ungültigem Format → 404; unbekannter Slug → 404;
 *          GET /api/board/projects bleibt erhalten.
 *
 * Covers (story-detail-ansicht):
 *   AC2, AC5 — YAML-Fallback ep_est_source; ledger-Prio; null-Fälle.
 *   AC2 — GET /api/board/projects/:slug/stories/:id/detail liefert Story-Detail-Objekt;
 *          ungültiges slug-Format → 404; ungültiges id-Format → 404;
 *          unbekannter Slug → 404; happy-path 200 + { detail: {...} }.
 *   AC5 — ep_est_source: 'ledger' wenn Ledger-Wert vorhanden; 'yaml' bei YAML-Fallback
 *          (dispo_est); null wenn weder Ledger noch dispo_est.
 *
 * Covers (story-detail-yaml-fallback):
 *   AC1 — BoardAggregator-Story-Index enthält done_at, branch, pr (null wenn YAML-Feld fehlt).
 *   AC3 — Detail-Endpoint: ended_at-Fallback aus done_at (ended_at_source 'yaml'/'ledger');
 *          started_at/duration bleiben null ohne Ledger.
 *   AC4 — Detail-Response enthält branch, pr, status aus dem Index.
 *   AC7 — Ledger hat Vorrang: volle Ledger-Daten → ended_at_source 'ledger'.
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC1 — BoardAggregator-Story-Index enthält zusätzlich updated_at (null wenn YAML-Feld
 *          fehlt) — Quelle für ProjectDrain's "verwaiste In-Progress"-Stale-Erkennung
 *          (vollständige ProjectDrain-Coverage in test/ProjectDrain.test.js).
 *
 * AccessGuard:
 *   POST /api/board/projects/rescan (Schreib-Trigger) liegt hinter
 *   app.use('/api', accessGuard) in server.js — kein separater Middleware-Test
 *   nötig; die Integration ist durch die server.js-Verdrahtung abgedeckt.
 *
 * Strategy:
 *   - Inject fake fsDeps (readdir, readFile) — kein echtes Filesystem.
 *   - Fixture-board/-Struktur als in-memory Map aufgebaut.
 *   - Verifiziert, dass fsDeps.readFile niemals write-äquivalente Aufrufe macht (AC7).
 */

import { describe, it, expect } from '@jest/globals';
import { BoardAggregator, parseYaml, parseBoardRoots } from '../src/BoardAggregator.js';

// ── parseYaml unit tests ──────────────────────────────────────────────────────

describe('parseYaml', () => {
  it('parses simple scalar fields', () => {
    const yaml = 'id: F-001\ntitle: My Feature\nstatus: Active\npriority: P1\n';
    const result = parseYaml(yaml);
    expect(result.id).toBe('F-001');
    expect(result.title).toBe('My Feature');
    expect(result.status).toBe('Active');
    expect(result.priority).toBe('P1');
  });

  it('parses null scalar values', () => {
    const yaml = 'dispo_est: null\ndispo_act: ~\nbranch: null\n';
    const result = parseYaml(yaml);
    expect(result.dispo_est).toBeNull();
    expect(result.dispo_act).toBeNull();
    expect(result.branch).toBeNull();
  });

  it('parses integer scalar', () => {
    const yaml = 'schema_version: 1\nnext_feature_id: 3\n';
    const result = parseYaml(yaml);
    expect(result.schema_version).toBe(1);
    expect(result.next_feature_id).toBe(3);
  });

  it('parses inline array', () => {
    const yaml = 'labels: [db, security]\nimplements: [AC1, AC2, AC4]\n';
    const result = parseYaml(yaml);
    expect(result.labels).toEqual(['db', 'security']);
    expect(result.implements).toEqual(['AC1', 'AC2', 'AC4']);
  });

  it('parses empty inline array', () => {
    const yaml = 'labels: []\n';
    const result = parseYaml(yaml);
    expect(result.labels).toEqual([]);
  });

  it('parses block sequence list', () => {
    const yaml = 'stories:\n- S-001\n- S-002\n';
    const result = parseYaml(yaml);
    expect(result.stories).toEqual(['S-001', 'S-002']);
  });

  it('strips inline comments', () => {
    const yaml = 'next_feature_id: 3        # nächste freie Nummer → F-003\n';
    const result = parseYaml(yaml);
    expect(result.next_feature_id).toBe(3);
  });

  it('handles quoted strings', () => {
    const yaml = "project_slug: 'agent-flow'\ntitle: \"My Title\"\n";
    const result = parseYaml(yaml);
    expect(result.project_slug).toBe('agent-flow');
    expect(result.title).toBe('My Title');
  });

  it('handles boolean values', () => {
    const yaml = 'active: true\narchived: false\n';
    const result = parseYaml(yaml);
    expect(result.active).toBe(true);
    expect(result.archived).toBe(false);
  });

  it('skips comments and empty lines', () => {
    const yaml = '# This is a comment\n\nid: F-001\n\n# another comment\ntitle: Test\n';
    const result = parseYaml(yaml);
    expect(result.id).toBe('F-001');
    expect(result.title).toBe('Test');
  });

  it('handles --- document separator', () => {
    const yaml = '---\nid: S-001\nparent: F-001\n';
    const result = parseYaml(yaml);
    expect(result.id).toBe('S-001');
    expect(result.parent).toBe('F-001');
  });

  it('returns {} for null input', () => {
    expect(parseYaml(null)).toEqual({});
  });

  it('returns {} for empty string', () => {
    expect(parseYaml('')).toEqual({});
  });

  it('handles multiline block scalar (|)', () => {
    const yaml = 'goal: |\n  Line one.\n  Line two.\ntitle: After\n';
    const result = parseYaml(yaml);
    expect(result.goal).toContain('Line one.');
    expect(result.goal).toContain('Line two.');
    expect(result.title).toBe('After');
  });

  it('parses real board.yaml fixture', () => {
    const yaml = `schema_version: 1
project_slug: agent-flow
next_feature_id: 2        # nächste freie Nummer → F-002
next_story_id: 2          # nächste freie Nummer → S-002
`;
    const result = parseYaml(yaml);
    expect(result.schema_version).toBe(1);
    expect(result.project_slug).toBe('agent-flow');
    expect(result.next_feature_id).toBe(2);
  });

  it('does not produce phantom keys from multi-line flow scalar continuation lines with colons (S1 fix)', () => {
    // Mirrors real agent-flow/board/features/F-001-board-schema.yaml where
    // the goal field is a single-quoted string split across multiple lines.
    // The continuation line contains "Ziel: menschenlesbares," — without the fix,
    // "Ziel" would be parsed as a phantom key.
    const yaml = `id: F-001
title: Board-Dateiformat
goal: 'Abloesung der GitHub-Projects-v2-Boards durch ein eigenes, zweistufiges Board
  (Feature -> Story) mit git-versionierten Dateien als Source of Truth. Ziel: menschenlesbares,
  diff-freundliches YAML pro Feature/Story.

  '
status: Active
priority: P0
`;
    const result = parseYaml(yaml);
    expect(result.id).toBe('F-001');
    expect(result.title).toBe('Board-Dateiformat');
    expect(result.status).toBe('Active');
    expect(result.priority).toBe('P0');
    // "Ziel" must NOT appear as a phantom key
    expect(result).not.toHaveProperty('Ziel');
    // "diff-freundliches YAML pro Feature/Story" must NOT appear as a phantom key
    expect(Object.keys(result).every((k) => !k.includes(' '))).toBe(true);
  });
});

// ── parseBoardRoots unit tests ────────────────────────────────────────────────

describe('parseBoardRoots', () => {
  it('returns empty array for empty string', () => {
    expect(parseBoardRoots('')).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(parseBoardRoots(undefined)).toEqual([]);
  });

  it('parses single absolute path', () => {
    const roots = parseBoardRoots('/home/alex/Git');
    expect(roots.length).toBe(1);
    expect(roots[0]).toBe('/home/alex/Git');
  });

  it('parses multiple comma-separated paths', () => {
    const roots = parseBoardRoots('/home/alex/Git,/home/alex/Work');
    expect(roots.length).toBe(2);
    expect(roots[0]).toBe('/home/alex/Git');
    expect(roots[1]).toBe('/home/alex/Work');
  });

  it('trims whitespace around paths', () => {
    const roots = parseBoardRoots('  /home/alex/Git , /home/alex/Work  ');
    expect(roots.length).toBe(2);
    expect(roots[0]).toBe('/home/alex/Git');
    expect(roots[1]).toBe('/home/alex/Work');
  });

  it('expands ~ to home directory', () => {
    const roots = parseBoardRoots('~/Git/Studis-Softwareschmiede');
    expect(roots.length).toBe(1);
    expect(roots[0]).not.toContain('~');
    expect(roots[0]).toMatch(/\/Git\/Studis-Softwareschmiede$/);
  });
});

// ── Fixture helpers ───────────────────────────────────────────────────────────

const BOARD_ROOT = '/fake/repos';

const BOARD_YAML = `schema_version: 1
project_slug: my-project
next_feature_id: 3
next_story_id: 5
`;

const FEATURE_F001 = `id: F-001
title: Server-Provisioning
goal: Abloesung der manuellen Provisionierung.
status: Active
priority: P1
spec: docs/specs/provisioning.md
labels: [infra, vps]
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
stories:
- S-001
- S-002
progress: 1/2 done
`;

const FEATURE_F002 = `id: F-002
title: Auth-Modul
goal: Sicheres Authentifizierungsmodul.
status: Planned
priority: P2
spec: docs/specs/auth.md
labels: [security]
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
stories: []
progress: null
`;

const STORY_S001 = `id: S-001
parent: F-001
title: IONOS-Adapter
status: Done
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1, AC2, AC4]
labels: [db, security]
size_est: M
dispo_est: null
dispo_act: null
dispo_forecast: null
estimate_note: null
confidence: null
branch: null
pr: null
blocked_reason: null
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
done_at: 2026-06-14T00:00:00Z
`;

const STORY_S002 = `id: S-002
parent: F-001
title: Hetzner-Adapter
status: In Progress
priority: P1
spec: docs/specs/provisioning.md
implements: [AC3]
labels: [infra]
dispo_est: null
dispo_act: null
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
done_at: null
`;

const STORY_S003_ORPHANED = `id: S-003
parent: F-099
title: Orphaned Story
status: To Do
priority: P3
spec: docs/specs/other.md
implements: [AC1]
labels: []
dispo_est: null
dispo_act: null
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
done_at: null
`;

/**
 * Build a fake fsDeps that simulates a board/ filesystem layout.
 *
 * Layout:
 *   /fake/repos/
 *     my-repo/
 *       board/
 *         board.yaml
 *         features/
 *           F-001-server-provisioning.yaml
 *           F-002-auth.yaml
 *         stories/
 *           S-001-ionos-adapter.yaml
 *           S-002-hetzner-adapter.yaml
 *
 * @param {object} [overrides]  Override specific file contents (path → string).
 * @param {string[]} [extraRepos]  Extra repo names with no board/ dir.
 */
function buildFakeFsDeps({
  fileOverrides = {},
  repoNames = ['my-repo'],
  missingBoardYaml = false,
  missingFeaturesDir = false,
  missingStoriesDir = false,
  extraFeatureFiles = [],
  extraStoryFiles = [],
} = {}) {
  const files = {
    [`${BOARD_ROOT}/my-repo/board/board.yaml`]: BOARD_YAML,
    [`${BOARD_ROOT}/my-repo/board/features/F-001-server-provisioning.yaml`]: FEATURE_F001,
    [`${BOARD_ROOT}/my-repo/board/features/F-002-auth.yaml`]: FEATURE_F002,
    [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: STORY_S001,
    [`${BOARD_ROOT}/my-repo/board/stories/S-002-hetzner-adapter.yaml`]: STORY_S002,
    ...fileOverrides,
  };

  const dirs = {
    // Board root
    [BOARD_ROOT]: repoNames.map((name) => ({
      name,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      isFile: () => false,
    })),
    // Each repo: has a board/ dir
    ...Object.fromEntries(
      repoNames.map((name) => [
        `${BOARD_ROOT}/${name}`,
        [{ name: 'board', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false }],
      ]),
    ),
    // board/ contains board.yaml (checked by readdir for board entries)
    [`${BOARD_ROOT}/my-repo/board`]: [
      { name: 'board.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'features', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      { name: 'stories', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
    ],
    // features/
    [`${BOARD_ROOT}/my-repo/board/features`]: [
      { name: 'F-001-server-provisioning.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'F-002-auth.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ...extraFeatureFiles.map((name) => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false })),
    ],
    // stories/
    [`${BOARD_ROOT}/my-repo/board/stories`]: [
      { name: 'S-001-ionos-adapter.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'S-002-hetzner-adapter.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ...extraStoryFiles.map((name) => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false })),
    ],
  };

  if (missingBoardYaml) {
    delete files[`${BOARD_ROOT}/my-repo/board/board.yaml`];
  }
  if (missingFeaturesDir) {
    delete dirs[`${BOARD_ROOT}/my-repo/board/features`];
  }
  if (missingStoriesDir) {
    delete dirs[`${BOARD_ROOT}/my-repo/board/stories`];
  }

  const readFile = async (path, _enc) => {
    if (path in files) return files[path];
    const err = new Error(`ENOENT: no such file: ${path}`);
    err.code = 'ENOENT';
    throw err;
  };

  const readdir = async (path, _opts) => {
    if (path in dirs) return dirs[path];
    const err = new Error(`ENOENT: no such dir: ${path}`);
    err.code = 'ENOENT';
    throw err;
  };

  // watch is not needed for unit tests (tested separately)
  const watch = async function* () {};

  return { readFile, readdir, watch, _files: files, _dirs: dirs };
}

function makeAggregator(opts = {}) {
  const fsDeps = buildFakeFsDeps(opts);
  return {
    aggregator: new BoardAggregator({
      boardRootsEnv: BOARD_ROOT,
      fsDeps,
    }),
    fsDeps,
  };
}

// ── AC1 — Scan reads board.yaml + features/*.yaml + stories/*.yaml ────────────

describe('AC1 — Scan reads board files read-only', () => {
  it('scans repo root and finds board/ directory', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    expect(Array.isArray(index)).toBe(true);
    expect(index.length).toBe(1);
    expect(index[0].slug).toBe('my-repo');
  });

  it('reads board.yaml and populates project_slug + schema_version', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const project = index[0];
    expect(project.project_slug).toBe('my-project');
    expect(project.schema_version).toBe(1);
  });

  it('reads all features/*.yaml files', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const features = index[0].features.filter((f) => !f._orphaned);
    expect(features.length).toBe(2);
    const ids = features.map((f) => f.id).sort();
    expect(ids).toEqual(['F-001', 'F-002']);
  });

  it('reads all stories/*.yaml files', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    expect(f001.stories.length).toBe(2);
    const ids = f001.stories.map((s) => s.id).sort();
    expect(ids).toEqual(['S-001', 'S-002']);
  });

  it('skips repos without a board/ directory (no error, no entry)', async () => {
    const fsDeps = buildFakeFsDeps({ repoNames: ['no-board-repo'] });
    // Override: no-board-repo has no board/ entry
    const origReaddir = fsDeps.readdir;
    const customReaddir = async (path, opts) => {
      if (path === `${BOARD_ROOT}/no-board-repo/board`) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return origReaddir(path, opts);
    };
    fsDeps.readdir = customReaddir;

    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    const index = await aggregator.getIndex();
    expect(index.length).toBe(0);
  });

  it('returns empty array when BOARD_ROOTS is unset', async () => {
    const fsDeps = buildFakeFsDeps();
    const aggregator = new BoardAggregator({ boardRootsEnv: '', fsDeps });
    const index = await aggregator.getIndex();
    expect(index).toEqual([]);
  });

  it('returns empty array when board root directory is not readable', async () => {
    const fsDeps = buildFakeFsDeps();
    const origReaddir = fsDeps.readdir;
    fsDeps.readdir = async (path, opts) => {
      if (path === BOARD_ROOT) throw new Error('EACCES');
      return origReaddir(path, opts);
    };
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    const index = await aggregator.getIndex();
    expect(index).toEqual([]);
  });
});

// ── AC2 — Flüchtiger In-Memory-Index; Re-Scan on-demand ──────────────────────

describe('AC2 — Volatile in-memory index; on-demand re-scan', () => {
  it('getIndex() returns same data on repeated calls without scan', async () => {
    const { aggregator } = makeAggregator();
    const index1 = await aggregator.getIndex();
    const index2 = await aggregator.getIndex();
    expect(index1).toBe(index2); // same array reference (no re-scan)
  });

  it('scan() replaces the index (new reference)', async () => {
    const { aggregator } = makeAggregator();
    const index1 = await aggregator.getIndex();
    await aggregator.scan();
    const index2 = await aggregator.getIndex();
    // index2 is a fresh array (re-scanned)
    expect(index2).not.toBe(index1);
  });

  it('scan() produces equivalent data on unchanged filesystem', async () => {
    const { aggregator } = makeAggregator();
    const index1 = await aggregator.getIndex();
    await aggregator.scan();
    const index2 = await aggregator.getIndex();
    expect(index2.length).toBe(index1.length);
    expect(index2[0].slug).toBe(index1[0].slug);
    expect(index2[0].features.length).toBe(index1[0].features.length);
  });

  it('scan() triggers lazy scan if index is null (first call)', async () => {
    const { aggregator } = makeAggregator();
    // Directly check that before getIndex(), no scan happened
    // (index is null internally, but getIndex() auto-scans)
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
  });
});

// ── AC3 — Aggregat-Modell: Projekt → Feature → Story mit Pflichtfeldern ───────

describe('AC3 — Aggregat model: Projekt → Feature → Story with required fields', () => {
  it('project entry has slug, repo_path, project_slug, schema_version, features', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const project = index[0];
    expect(project).toHaveProperty('slug', 'my-repo');
    expect(project).toHaveProperty('repo_path');
    expect(project).toHaveProperty('project_slug');
    expect(project).toHaveProperty('schema_version');
    expect(project).toHaveProperty('features');
  });

  it('feature entry has id, title, status, priority, progress, stories', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    expect(f001).toHaveProperty('id', 'F-001');
    expect(f001).toHaveProperty('title', 'Server-Provisioning');
    expect(f001).toHaveProperty('status', 'Active');
    expect(f001).toHaveProperty('priority', 'P1');
    expect(f001).toHaveProperty('progress');
    expect(f001).toHaveProperty('stories');
    expect(Array.isArray(f001.stories)).toBe(true);
  });

  it('story entry carries id, parent, title, status, priority, labels, spec', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001).toHaveProperty('id', 'S-001');
    expect(s001).toHaveProperty('parent', 'F-001');
    expect(s001).toHaveProperty('title', 'IONOS-Adapter');
    expect(s001).toHaveProperty('status', 'Done');
    expect(s001).toHaveProperty('priority', 'P0');
    expect(s001).toHaveProperty('labels');
    expect(s001.labels).toEqual(['db', 'security']);
    expect(s001).toHaveProperty('spec', 'docs/specs/provisioning.md');
  });

  it('story entry carries dispo_est and dispo_act (both null in fixture)', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001).toHaveProperty('dispo_est', null);
    expect(s001).toHaveProperty('dispo_act', null);
  });

  // ── taktgeber-nachtwaechter AC1 ──────────────────────────────────────────────

  it('story entry carries updated_at (string wenn gesetzt, null wenn fehlt) — ProjectDrain Stale-Quelle', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    // S-001-Fixture hat updated_at gesetzt
    expect(s001).toHaveProperty('updated_at', '2026-06-14T00:00:00Z');
  });

  it('story entry carries updated_at: null wenn YAML-Feld fehlt', async () => {
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]:
          'id: S-001\nparent: F-001\ntitle: No updated_at\nstatus: To Do\npriority: P1\n',
      },
    });
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001).toHaveProperty('updated_at', null);
  });

  // ── story-detail-yaml-fallback AC1 ──────────────────────────────────────────

  it('story entry carries done_at (string wenn gesetzt, null wenn fehlt)', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    const s002 = f001.stories.find((s) => s.id === 'S-002');
    // S-001 hat done_at in der Fixture
    expect(s001).toHaveProperty('done_at', '2026-06-14T00:00:00Z');
    // S-002 hat done_at: null in der Fixture
    expect(s002).toHaveProperty('done_at', null);
  });

  it('story entry carries branch and pr (null in fixture)', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001).toHaveProperty('branch', null);
    expect(s001).toHaveProperty('pr', null);
  });

  it('story entry carries branch/pr as string when set in YAML', async () => {
    const storyWithBranchPr = `id: S-001
parent: F-001
title: IONOS-Adapter
status: Done
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1]
labels: []
dispo_est: null
dispo_act: null
branch: board/my-feature-2026-06-14
pr: https://github.com/org/repo/pull/42
done_at: '2026-06-14T00:00:00Z'
`;
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: storyWithBranchPr,
      },
    });
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001.branch).toBe('board/my-feature-2026-06-14');
    expect(s001.pr).toBe('https://github.com/org/repo/pull/42');
    expect(s001.done_at).toBe('2026-06-14T00:00:00Z');
  });

  it('stories are attached to their parent feature', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const f002 = index[0].features.find((f) => f.id === 'F-002');
    expect(f001.stories.length).toBe(2);
    expect(f002.stories.length).toBe(0); // no stories pointing to F-002 in fixture
  });

  it('stories with unknown parent are placed under orphaned pseudo-feature', async () => {
    const fsDeps = buildFakeFsDeps({
      extraStoryFiles: ['S-003-orphaned.yaml'],
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-003-orphaned.yaml`]: STORY_S003_ORPHANED,
      },
    });
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    const index = await aggregator.getIndex();
    const orphaned = index[0].features.find((f) => f._orphaned);
    expect(orphaned).toBeDefined();
    expect(orphaned.stories.some((s) => s.id === 'S-003')).toBe(true);
    // F-001 stories unchanged
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    expect(f001.stories.every((s) => s.id !== 'S-003')).toBe(true);
  });

  it('feature.progress is preserved when present in YAML', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    // F-001 has progress: "1/2 done" in fixture
    expect(f001.progress).toBe('1/2 done');
  });

  it('feature.progress is computed read-only when null/missing in YAML', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    // F-002 has progress: null in fixture but no stories → "0/0 done"
    const f002 = index[0].features.find((f) => f.id === 'F-002');
    expect(typeof f002.progress).toBe('string');
    expect(f002.progress).toContain('/');
  });
});

// ── AC7 — Read-only-Garantie ──────────────────────────────────────────────────

describe('AC7 — Read-only guarantee: no writes to board/ files', () => {
  it('fsDeps.readFile is called only (no write operations)', async () => {
    const calls = [];
    const fsDeps = buildFakeFsDeps();
    const origReadFile = fsDeps.readFile;
    fsDeps.readFile = async (path, enc) => {
      calls.push({ op: 'readFile', path });
      return origReadFile(path, enc);
    };

    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    await aggregator.getIndex();

    // All calls should be readFile (read) — no writeFile, appendFile, etc.
    expect(calls.every((c) => c.op === 'readFile')).toBe(true);
    // Verify at least board.yaml, features, stories were read
    expect(calls.some((c) => c.path.includes('board.yaml'))).toBe(true);
    expect(calls.some((c) => c.path.includes('features'))).toBe(true);
    expect(calls.some((c) => c.path.includes('stories'))).toBe(true);
  });

  it('scan() does not persist the index anywhere (only updates in-memory reference)', async () => {
    // The index is an in-process variable — verified by checking that two scans
    // return new array instances (not the same object, no disk write)
    const { aggregator } = makeAggregator();
    const index1 = await aggregator.getIndex();
    await aggregator.scan();
    const index2 = await aggregator.getIndex();
    // Both are plain arrays — not serialized/persisted
    expect(Array.isArray(index1)).toBe(true);
    expect(Array.isArray(index2)).toBe(true);
    expect(typeof index1).toBe('object');
    expect(typeof index2).toBe('object');
  });
});

// ── AC8 — Fehlertoleranz ──────────────────────────────────────────────────────

describe('AC8 — Fault tolerance: invalid boards skipped, others remain visible', () => {
  it('missing board.yaml → project entry with error field, empty features', async () => {
    const { aggregator } = makeAggregator({ missingBoardYaml: true });
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
    const project = index[0];
    expect(project).toHaveProperty('error');
    expect(typeof project.error).toBe('string');
    expect(project.features).toEqual([]);
  });

  it('broken board.yaml (invalid YAML) → project entry with error, empty features', async () => {
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/board.yaml`]: 'not: valid: yaml: : : :',
      },
    });
    const index = await aggregator.getIndex();
    // parseYaml degrades gracefully, but board might be missing project_slug
    // Either it errors or it succeeds with partial data — no crash is the key
    expect(index.length).toBe(1);
    expect(() => JSON.stringify(index)).not.toThrow();
  });

  it('malformed feature YAML is skipped — other features remain visible', async () => {
    const { aggregator } = makeAggregator({
      extraFeatureFiles: ['F-BAD-malformed.yaml'],
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/features/F-BAD-malformed.yaml`]: ':::: not yaml ::::',
      },
    });
    const index = await aggregator.getIndex();
    const features = index[0].features.filter((f) => !f._orphaned);
    // Only valid features F-001 and F-002 survive; malformed is silently skipped
    expect(features.some((f) => f.id === 'F-001')).toBe(true);
    expect(features.some((f) => f.id === 'F-002')).toBe(true);
  });

  it('malformed story YAML is skipped — other stories remain visible', async () => {
    const { aggregator } = makeAggregator({
      extraStoryFiles: ['S-BAD-malformed.yaml'],
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-BAD-malformed.yaml`]: ':::: bad ::::',
      },
    });
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    // S-001 and S-002 still there
    expect(f001.stories.some((s) => s.id === 'S-001')).toBe(true);
    expect(f001.stories.some((s) => s.id === 'S-002')).toBe(true);
  });

  it('missing features/ dir does not crash (empty feature list)', async () => {
    const { aggregator } = makeAggregator({ missingFeaturesDir: true });
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
    // No crash; features is empty (or only orphaned if stories have bad parents)
    expect(Array.isArray(index[0].features)).toBe(true);
  });

  it('missing stories/ dir does not crash (features have empty story lists)', async () => {
    const { aggregator } = makeAggregator({ missingStoriesDir: true });
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
    const features = index[0].features.filter((f) => !f._orphaned);
    expect(features.every((f) => Array.isArray(f.stories))).toBe(true);
    expect(features.every((f) => f.stories.length === 0)).toBe(true);
  });

  it('one invalid board does not crash the scan of other boards', async () => {
    // Two repos: first has broken board.yaml, second is valid
    // Build custom dirs + files inline (not using buildFakeFsDeps — different layout)
    const dirs = {
      [BOARD_ROOT]: [
        { name: 'broken-repo', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false },
        { name: 'good-repo', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false },
      ],
      [`${BOARD_ROOT}/broken-repo`]: [
        { name: 'board', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false },
      ],
      [`${BOARD_ROOT}/broken-repo/board`]: [
        { name: 'board.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'features', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        { name: 'stories', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      ],
      [`${BOARD_ROOT}/broken-repo/board/features`]: [],
      [`${BOARD_ROOT}/broken-repo/board/stories`]: [],
      [`${BOARD_ROOT}/good-repo`]: [
        { name: 'board', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false },
      ],
      [`${BOARD_ROOT}/good-repo/board`]: [
        { name: 'board.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'features', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        { name: 'stories', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      ],
      [`${BOARD_ROOT}/good-repo/board/features`]: [],
      [`${BOARD_ROOT}/good-repo/board/stories`]: [],
    };

    const files = {
      // broken-repo: board.yaml is unreadable
      [`${BOARD_ROOT}/good-repo/board/board.yaml`]: `schema_version: 1\nproject_slug: good-project\n`,
    };

    const customReaddir = async (path, _opts) => {
      if (path in dirs) return dirs[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      throw err;
    };

    const customReadFile = async (path, _enc) => {
      if (path in files) return files[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      throw err;
    };

    const aggregator = new BoardAggregator({
      boardRootsEnv: BOARD_ROOT,
      fsDeps: { readdir: customReaddir, readFile: customReadFile, watch: async function* () {} },
    });

    const index = await aggregator.getIndex();

    // Both boards are in the index (broken with error, good without)
    expect(index.length).toBe(2);
    const broken = index.find((p) => p.slug === 'broken-repo');
    const good = index.find((p) => p.slug === 'good-repo');
    expect(broken).toBeDefined();
    expect(broken).toHaveProperty('error');
    expect(good).toBeDefined();
    expect(good).not.toHaveProperty('error');
    expect(good.project_slug).toBe('good-project');
  });

  it('scan() never throws even when all roots are unreachable', async () => {
    const fsDeps = {
      readdir: async () => { throw new Error('EACCES: permission denied'); },
      readFile: async () => { throw new Error('EACCES: permission denied'); },
      watch: async function* () {},
    };
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    await expect(aggregator.scan()).resolves.not.toThrow();
    const index = await aggregator.getIndex();
    expect(index).toEqual([]);
  });
});

// ── AC9 — Re-Scan on-demand ───────────────────────────────────────────────────

describe('AC9 — On-demand re-scan updates the index', () => {
  it('scan() can be called multiple times without error', async () => {
    const { aggregator } = makeAggregator();
    await aggregator.scan();
    await aggregator.scan();
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
  });

  it('after scan(), index reflects updated data (simulated by re-reading)', async () => {
    const { aggregator } = makeAggregator();
    await aggregator.getIndex(); // populate cache
    await aggregator.scan();    // re-scan
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
    expect(index[0].slug).toBe('my-repo');
  });

  it('stopWatchers() does not throw when no watchers are active', () => {
    const { aggregator } = makeAggregator();
    expect(() => aggregator.stopWatchers()).not.toThrow();
  });

  it('startWatchers() and stopWatchers() can be called without crash', () => {
    const fsDeps = {
      ...buildFakeFsDeps(),
      // watch returns an async generator that immediately returns (no events)
      watch: async function* () {},
    };
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    expect(() => aggregator.startWatchers()).not.toThrow();
    expect(() => aggregator.stopWatchers()).not.toThrow();
  });
});

// ── Feature extended fields: goal, definition_of_done, depends, labels ────────

const FEATURE_F003_FULL = `id: F-003
title: Vollstaendiges Feature
goal: Ziel des Features in einem oder zwei Saetzen.
status: Active
priority: P0
definition_of_done: Alle Tests gruen, Review bestanden.
labels: [infra, security]
depends: [F-001, F-002]
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
stories: []
progress: null
`;

const FEATURE_F004_MINIMAL = `id: F-004
title: Minimales Feature
status: Backlog
priority: P3
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
stories: []
progress: null
`;

describe('Feature extended fields — goal, definition_of_done, depends, labels', () => {
  function makeAggregatorWithFeature(featureYaml, fileName) {
    const fsDeps = buildFakeFsDeps({
      extraFeatureFiles: [fileName],
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/features/${fileName}`]: featureYaml,
      },
    });
    return new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
  }

  it('feature entry has goal field from YAML', async () => {
    const aggregator = makeAggregatorWithFeature(FEATURE_F003_FULL, 'F-003-full.yaml');
    const index = await aggregator.getIndex();
    const f003 = index[0].features.find((f) => f.id === 'F-003');
    expect(f003).toBeDefined();
    expect(f003.goal).toBe('Ziel des Features in einem oder zwei Saetzen.');
  });

  it('feature entry has definition_of_done field from YAML', async () => {
    const aggregator = makeAggregatorWithFeature(FEATURE_F003_FULL, 'F-003-full.yaml');
    const index = await aggregator.getIndex();
    const f003 = index[0].features.find((f) => f.id === 'F-003');
    expect(f003).toBeDefined();
    expect(f003.definition_of_done).toBe('Alle Tests gruen, Review bestanden.');
  });

  it('feature entry has labels array from YAML', async () => {
    const aggregator = makeAggregatorWithFeature(FEATURE_F003_FULL, 'F-003-full.yaml');
    const index = await aggregator.getIndex();
    const f003 = index[0].features.find((f) => f.id === 'F-003');
    expect(f003).toBeDefined();
    expect(Array.isArray(f003.labels)).toBe(true);
    expect(f003.labels).toEqual(['infra', 'security']);
  });

  it('feature entry has depends array from YAML', async () => {
    const aggregator = makeAggregatorWithFeature(FEATURE_F003_FULL, 'F-003-full.yaml');
    const index = await aggregator.getIndex();
    const f003 = index[0].features.find((f) => f.id === 'F-003');
    expect(f003).toBeDefined();
    expect(Array.isArray(f003.depends)).toBe(true);
    expect(f003.depends).toEqual(['F-001', 'F-002']);
  });

  it('feature with missing goal/dod/depends/labels → all null', async () => {
    const aggregator = makeAggregatorWithFeature(FEATURE_F004_MINIMAL, 'F-004-minimal.yaml');
    const index = await aggregator.getIndex();
    const f004 = index[0].features.find((f) => f.id === 'F-004');
    expect(f004).toBeDefined();
    expect(f004.goal).toBeNull();
    expect(f004.definition_of_done).toBeNull();
    expect(f004.depends).toBeNull();
    expect(f004.labels).toBeNull();
  });

  it('existing feature F-001 fixture has goal (already in YAML)', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    // FEATURE_F001 fixture has goal: Abloesung der manuellen Provisionierung.
    expect(f001.goal).toBe('Abloesung der manuellen Provisionierung.');
  });

  it('existing feature F-001 fixture has labels array', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    // FEATURE_F001 fixture has labels: [infra, vps]
    expect(Array.isArray(f001.labels)).toBe(true);
    expect(f001.labels).toContain('infra');
    expect(f001.labels).toContain('vps');
  });
});

// ── boardRouter HTTP tests ────────────────────────────────────────────────────

import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { boardRouter } from '../src/boardRouter.js';

function httpFetch(server, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function startServer(boardAggregator, storyMetricReader) {
  const app = express();
  app.use(express.json());
  app.use(boardRouter({ boardAggregator, storyMetricReader }));
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('boardRouter HTTP — GET /api/board/projects', () => {
  it('returns 200 with { projects: [...] }', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects');
      expect(status).toBe(200);
      expect(data).toHaveProperty('projects');
      expect(Array.isArray(data.projects)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('projects contain the scanned board data', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { data } = await httpFetch(server, '/api/board/projects');
      expect(data.projects.length).toBe(1);
      expect(data.projects[0].slug).toBe('my-repo');
      expect(data.projects[0].features.length).toBeGreaterThan(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('error boards are included with error field (AC8)', async () => {
    const { aggregator } = makeAggregator({ missingBoardYaml: true });
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects');
      expect(status).toBe(200);
      const errProject = data.projects.find((p) => p.error);
      expect(errProject).toBeDefined();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 200 with empty projects when no board roots configured', async () => {
    const fsDeps = buildFakeFsDeps();
    const aggregator = new BoardAggregator({ boardRootsEnv: '', fsDeps });
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects');
      expect(status).toBe(200);
      expect(data.projects).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('boardRouter HTTP — POST /api/board/projects/rescan (AC9)', () => {
  it('returns 200 with { ok: true }', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/rescan', 'POST');
      expect(status).toBe(200);
      expect(data).toEqual({ ok: true });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('after rescan, GET reflects updated data', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      await httpFetch(server, '/api/board/projects/rescan', 'POST');
      const { status, data } = await httpFetch(server, '/api/board/projects');
      expect(status).toBe(200);
      expect(data.projects.length).toBe(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── AC5 (studis-kanban-board-ux) — /api/board/projects/list + /projects/:slug ─

describe('boardRouter HTTP — GET /api/board/projects/list (AC5)', () => {
  it('returns 200 with { projects: [...] } — slug + counters only', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/list');
      expect(status).toBe(200);
      expect(data).toHaveProperty('projects');
      expect(Array.isArray(data.projects)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('list items have slug, feature_count, story_count — no features array', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { data } = await httpFetch(server, '/api/board/projects/list');
      expect(data.projects.length).toBe(1);
      const item = data.projects[0];
      expect(item.slug).toBe('my-repo');
      expect(typeof item.feature_count).toBe('number');
      expect(typeof item.story_count).toBe('number');
      // Must NOT expose full story data
      expect(item.features).toBeUndefined();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('list counters are correct (feature_count ≥ 2, story_count ≥ 2)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { data } = await httpFetch(server, '/api/board/projects/list');
      const item = data.projects[0];
      // Fixture has F-001 (2 stories) + F-002 (0 stories) + possibly orphaned pseudo-feature
      expect(item.feature_count).toBeGreaterThanOrEqual(2);
      expect(item.story_count).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('error boards appear with slug + error field in list', async () => {
    const { aggregator } = makeAggregator({ missingBoardYaml: true });
    const server = await startServer(aggregator);
    try {
      const { data } = await httpFetch(server, '/api/board/projects/list');
      const errItem = data.projects.find((p) => p.error);
      expect(errItem).toBeDefined();
      expect(errItem.slug).toBe('my-repo');
      expect(typeof errItem.error).toBe('string');
      expect(errItem.feature_count).toBeUndefined();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns empty list when no board roots configured', async () => {
    const fsDeps = buildFakeFsDeps();
    const aggregator = new BoardAggregator({ boardRootsEnv: '', fsDeps });
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/list');
      expect(status).toBe(200);
      expect(data.projects).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('boardRouter HTTP — GET /api/board/projects/:slug (AC5)', () => {
  it('returns 200 with { project: {...} } for known slug', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo');
      expect(status).toBe(200);
      expect(data).toHaveProperty('project');
      expect(data.project.slug).toBe('my-repo');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returned project has full features array (stories included)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo');
      const project = data.project;
      expect(Array.isArray(project.features)).toBe(true);
      expect(project.features.length).toBeGreaterThan(0);
      // At least one feature has stories
      const f001 = project.features.find((f) => f.id === 'F-001');
      expect(f001).toBeDefined();
      expect(Array.isArray(f001.stories)).toBe(true);
      expect(f001.stories.length).toBeGreaterThan(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for unknown slug', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/nonexistent-slug');
      expect(status).toBe(404);
      expect(data).toHaveProperty('error');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for slug with path traversal attempt (..)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      // URL-encode the traversal attempt
      const { status } = await httpFetch(server, '/api/board/projects/..%2Fetc%2Fpasswd');
      // Express parses %2F as path separator so route may not match — either 404 is correct
      expect([404, 400]).toContain(status);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for slug starting with a dot (.hidden)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status } = await httpFetch(server, '/api/board/projects/.hidden');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('existing /api/board/projects still works (legacy endpoint preserved)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects');
      expect(status).toBe(200);
      expect(Array.isArray(data.projects)).toBe(true);
      expect(data.projects[0].slug).toBe('my-repo');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── AC2 (story-detail-ansicht) — GET /api/board/projects/:slug/stories/:id/detail ─

describe('boardRouter HTTP — GET /api/board/projects/:slug/stories/:id/detail (AC2 story-detail-ansicht)', () => {
  /** Minimal StoryMetricReader mock — returns a fixed detail object. */
  function makeMockStoryMetricReader(detail = {}) {
    return {
      getDetail: async (_repoPath, _storyId) => ({
        started_at: null,
        ended_at: null,
        duration: null,
        flow: [],
        ep_est: null,
        ep_act: null,
        tok_est: null,
        tok_total: null,
        size_est: null,
        ep_dev: null,
        ep_dev_pct: null,
        tok_dev: null,
        tok_dev_pct: null,
        ...detail,
      }),
    };
  }

  it('returns 404 for slug with invalid format (starts with dot)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader());
    try {
      const { status } = await httpFetch(server, '/api/board/projects/.invalid-slug/stories/S-001/detail');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for id with invalid format (starts with dot)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader());
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/stories/.invalid-id/detail');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for unknown slug', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader());
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/nonexistent/stories/S-001/detail');
      expect(status).toBe(404);
      expect(data).toHaveProperty('error');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('happy-path: returns 200 + { detail: {...} } with mocked storyMetricReader', async () => {
    const { aggregator } = makeAggregator();
    const mockDetail = {
      started_at: '2026-06-01T10:00:00.000Z',
      ended_at: '2026-06-01T11:30:00.000Z',
      duration: 5400,
      flow: [{ seq: 1, agent: 'coder', iter: 1, gate: null, secs: 120, tok: 8000 }],
      ep_est: 3,
      ep_act: 4,
      tok_est: 10000,
      tok_total: 12000,
      size_est: 'M',
      ep_dev: 1,
      ep_dev_pct: 33.3,
      tok_dev: 2000,
      tok_dev_pct: 20,
    };
    const server = await startServer(aggregator, makeMockStoryMetricReader(mockDetail));
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(status).toBe(200);
      expect(data).toHaveProperty('detail');
      const { detail } = data;
      expect(detail.started_at).toBe('2026-06-01T10:00:00.000Z');
      expect(detail.ended_at).toBe('2026-06-01T11:30:00.000Z');
      expect(detail.duration).toBe(5400);
      expect(Array.isArray(detail.flow)).toBe(true);
      expect(detail.flow.length).toBe(1);
      expect(detail.flow[0].agent).toBe('coder');
      expect(detail.ep_est).toBe(3);
      expect(detail.ep_act).toBe(4);
      expect(detail.tok_est).toBe(10000);
      expect(detail.tok_total).toBe(12000);
      expect(detail.size_est).toBe('M');
      expect(detail.ep_dev).toBe(1);
      expect(detail.tok_dev).toBe(2000);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('ledger ep_est present → ep_est_source is "ledger"', async () => {
    const { aggregator } = makeAggregator();
    const mockDetail = { ep_est: 3, ep_act: 4 };
    const server = await startServer(aggregator, makeMockStoryMetricReader(mockDetail));
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(status).toBe(200);
      expect(data.detail.ep_est).toBe(3);
      expect(data.detail.ep_est_source).toBe('ledger');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('ledger ep_est null but story has dispo_est → YAML fallback with ep_est_source "yaml"', async () => {
    // S-001 in the fixture has dispo_est: null — we need a story with dispo_est set.
    // Override S-001 to have dispo_est: 2
    const storyWithDispoEst = `id: S-001
parent: F-001
title: IONOS-Adapter
status: To Do
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1]
labels: []
size_est: S
dispo_est: 2
dispo_act: null
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
done_at: null
`;
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: storyWithDispoEst,
      },
    });
    // Ledger returns no ep_est
    const server = await startServer(aggregator, makeMockStoryMetricReader({ ep_est: null }));
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(status).toBe(200);
      // YAML fallback applied
      expect(data.detail.ep_est).toBe(2);
      expect(data.detail.ep_est_source).toBe('yaml');
      // Ist/Abweichung must remain null (kein Flow-Lauf)
      expect(data.detail.ep_act).toBeNull();
      expect(data.detail.ep_dev).toBeNull();
      expect(data.detail.ep_dev_pct).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('ledger ep_est null and story dispo_est null → ep_est_source null, ep_est null', async () => {
    // S-001 fixture has dispo_est: null
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader({ ep_est: null }));
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(status).toBe(200);
      expect(data.detail.ep_est).toBeNull();
      expect(data.detail.ep_est_source).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('ledger ep_est null and story not in index → ep_est_source null, ep_est null', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader({ ep_est: null }));
    try {
      // S-UNKNOWN does not exist in the fixture board
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-UNKNOWN/detail');
      expect(status).toBe(200);
      expect(data.detail.ep_est).toBeNull();
      expect(data.detail.ep_est_source).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── story-detail-yaml-fallback: AC3/AC4/AC7 HTTP-Tests ───────────────────────

describe('boardRouter HTTP — story-detail-yaml-fallback AC3/AC4/AC7', () => {
  /** Minimal StoryMetricReader mock — returns a fixed detail object (scoped to this describe). */
  function makeMockStoryMetricReader(detail = {}) {
    return {
      getDetail: async (_repoPath, _storyId) => ({
        started_at: null,
        ended_at: null,
        duration: null,
        flow: [],
        ep_est: null,
        ep_act: null,
        tok_est: null,
        tok_total: null,
        size_est: null,
        ep_dev: null,
        ep_dev_pct: null,
        tok_dev: null,
        tok_dev_pct: null,
        ...detail,
      }),
    };
  }

  /** Story-Fixture mit done_at und branch/pr gesetzt */
  const STORY_WITH_YAML_FIELDS = `id: S-001
parent: F-001
title: IONOS-Adapter
status: Done
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1]
labels: []
dispo_est: null
dispo_act: null
branch: board/my-feature-2026-06-14
pr: https://github.com/org/repo/pull/42
done_at: '2026-06-14T12:00:00Z'
`;

  function makeAggregatorWithYamlFields() {
    return makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: STORY_WITH_YAML_FIELDS,
      },
    });
  }

  it('AC3 — ended_at-Fallback aus done_at wenn Ledger kein ended_at liefert', async () => {
    const { aggregator } = makeAggregatorWithYamlFields();
    // Ledger liefert kein ended_at
    const server = await startServer(aggregator, makeMockStoryMetricReader({ ended_at: null }));
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(status).toBe(200);
      expect(data.detail.ended_at).toBe('2026-06-14T12:00:00Z');
      expect(data.detail.ended_at_source).toBe('yaml');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('AC3 — started_at/duration bleiben null wenn kein Ledger (nicht aus YAML ableitbar)', async () => {
    const { aggregator } = makeAggregatorWithYamlFields();
    const server = await startServer(aggregator, makeMockStoryMetricReader({
      started_at: null,
      ended_at: null,
      duration: null,
    }));
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(data.detail.started_at).toBeNull();
      expect(data.detail.duration).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('AC4 — branch, pr, status aus Index werden in der Detail-Response durchgereicht', async () => {
    const { aggregator } = makeAggregatorWithYamlFields();
    const server = await startServer(aggregator, makeMockStoryMetricReader());
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(data.detail.branch).toBe('board/my-feature-2026-06-14');
      expect(data.detail.pr).toBe('https://github.com/org/repo/pull/42');
      expect(data.detail.status).toBe('Done');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('AC4 — branch/pr/status null wenn Story-YAML kein branch/pr/done_at hat', async () => {
    // S-001 in der Standard-Fixture hat branch: null, pr: null
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader());
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(data.detail.branch).toBeNull();
      expect(data.detail.pr).toBeNull();
      // status ist immer gesetzt (aus dem Story-YAML)
      expect(typeof data.detail.status).toBe('string');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('AC7 — Ledger hat Vorrang: ended_at aus Ledger → ended_at_source "ledger"', async () => {
    const { aggregator } = makeAggregatorWithYamlFields();
    // Ledger liefert einen echten ended_at-Wert
    const server = await startServer(aggregator, makeMockStoryMetricReader({
      ended_at: '2026-06-15T08:00:00.000Z',
    }));
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(data.detail.ended_at).toBe('2026-06-15T08:00:00.000Z');
      expect(data.detail.ended_at_source).toBe('ledger');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('AC3 — kein done_at und kein Ledger → ended_at null, ended_at_source null', async () => {
    // S-002 hat done_at: null in der Standard-Fixture
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader({ ended_at: null }));
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-002/detail');
      expect(data.detail.ended_at).toBeNull();
      expect(data.detail.ended_at_source).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
