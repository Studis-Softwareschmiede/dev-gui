/**
 * boardReadyStatus.test.js — Unit tests for computeStoryReadyStatus + BoardAggregator
 * ready/ready_reason field integration.
 *
 * Covers (autonome-board-abarbeitung):
 *   AC4 — BoardAggregator berechnet ready/ready_reason pro Story READ-ONLY nach genau
 *          diesen Regeln (konsistent mit agent-flow board ready-check):
 *          (1) status === "To Do"
 *          (2) spec gesetzt + Datei existiert + Frontmatter status: active
 *          (3) implements nicht leer + jede AC-Nummer in Spec-Datei vorhanden
 *          (4) depends leer ODER alle referenzierten Stories existieren + status Done
 *          (5) kein blocked_reason
 *
 *   Happy path: ready=true wenn alle 5 Regeln erfüllt.
 *   Not-ready paths: je eine Regel verletzt → ready=false mit Grund.
 *   Missing-file path: Spec-Datei fehlt → ready=false mit Grund, kein Crash.
 *   Non-To-Do stories: ready=false, ready_reason=null (not relevant).
 *   Error tolerance: fehlende Felder / Crashes → ready=false, kein Absturz.
 *
 *   Endpoint-Shape: _readBoard liefert stories mit ready/ready_reason-Feldern.
 */

import { describe, it, expect } from '@jest/globals';
import { computeStoryReadyStatus, BoardAggregator } from '../src/BoardAggregator.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal fake fsDeps for computeStoryReadyStatus tests.
 * Provides readFile that returns specContent for SPEC_PATH.
 */
function makeFsDeps({ specContent = null, throwOnRead = false } = {}) {
  return {
    readFile: async (path, _enc) => {
      if (throwOnRead) {
        const err = new Error(`ENOENT: ${path}`);
        err.code = 'ENOENT';
        throw err;
      }
      if (specContent !== null) return specContent;
      const err = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      throw err;
    },
    readdir: async () => [],
    watch: async function* () {},
  };
}

const REPO_PATH = '/fake/repo';
const SPEC_PATH = 'docs/specs/my-spec.md';

/** Minimal valid spec content with status: active and AC1, AC2 */
const VALID_SPEC = `---
id: my-spec
title: My Spec
status: active
---

## Acceptance-Kriterien
- **AC1** — something
- **AC2** — something else
`;

/** Spec with status: draft */
const DRAFT_SPEC = `---
id: my-spec
title: My Spec
status: draft
---
## AC1
`;

/** Spec without frontmatter status */
const NO_STATUS_SPEC = `# My Spec

## AC1 — something
`;

/** Base story that is fully ready */
function readyStory(overrides = {}) {
  return {
    id: 'S-001',
    status: 'To Do',
    spec: SPEC_PATH,
    implements: ['AC1', 'AC2'],
    depends: [],
    blocked_reason: null,
    ...overrides,
  };
}

/** Map of stories for depends-check */
function makeStoriesMap(entries = []) {
  return new Map(entries.map((s) => [s.id, s]));
}

// ── computeStoryReadyStatus unit tests ────────────────────────────────────────

describe('computeStoryReadyStatus — happy path', () => {
  it('returns ready=true when all 5 rules are satisfied', async () => {
    const story = readyStory();
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const allStoriesMap = makeStoriesMap([]);
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, allStoriesMap);
    expect(result.ready).toBe(true);
    expect(result.ready_reason).toBeNull();
  });

  it('returns ready=true when depends list contains Done stories', async () => {
    const story = readyStory({ depends: ['S-010', 'S-011'] });
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const allStoriesMap = makeStoriesMap([
      { id: 'S-010', status: 'Done' },
      { id: 'S-011', status: 'Done' },
    ]);
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, allStoriesMap);
    expect(result.ready).toBe(true);
    expect(result.ready_reason).toBeNull();
  });
});

describe('computeStoryReadyStatus — rule (1): status must be To Do', () => {
  it('returns ready=false, ready_reason=null for In Progress stories', async () => {
    const story = readyStory({ status: 'In Progress' });
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toBeNull(); // non-To-Do: null, not a "reason"
  });

  it('returns ready=false, ready_reason=null for Done stories', async () => {
    const story = readyStory({ status: 'Done' });
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toBeNull();
  });

  it('returns ready=false, ready_reason=null for Blocked stories (rule 1 — status ≠ To Do)', async () => {
    // Note: blocked_reason check (rule 5) only runs for To-Do stories;
    // here status is "Blocked" so rule 1 fires first (status ≠ To Do → not relevant).
    const story = readyStory({ status: 'Blocked', blocked_reason: 'waiting on owner' });
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toBeNull();
  });
});

describe('computeStoryReadyStatus — rule (5): no blocked_reason', () => {
  it('returns ready=false with reason when To-Do story has blocked_reason', async () => {
    const story = readyStory({ blocked_reason: 'waiting on external API docs' });
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toContain('blocked');
    expect(result.ready_reason).toContain('waiting on external API docs');
  });
});

describe('computeStoryReadyStatus — rule (2a): spec must be set', () => {
  it('returns ready=false when spec is null', async () => {
    const story = readyStory({ spec: null });
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toMatch(/spec/i);
  });

  it('returns ready=false when spec is empty string', async () => {
    const story = readyStory({ spec: '' });
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toMatch(/spec/i);
  });
});

describe('computeStoryReadyStatus — rule (2b): spec file must exist', () => {
  it('returns ready=false when spec file is missing (ENOENT)', async () => {
    const story = readyStory();
    const fsDeps = makeFsDeps({ throwOnRead: true }); // all reads throw ENOENT
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toMatch(/spec.*nicht gefunden|nicht gefunden.*spec/i);
  });
});

describe('computeStoryReadyStatus — rule (2b): spec frontmatter status must be active', () => {
  it('returns ready=false when spec has status: draft', async () => {
    const story = readyStory();
    const fsDeps = makeFsDeps({ specContent: DRAFT_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toMatch(/active|draft/i);
  });

  it('returns ready=false when spec has no frontmatter status', async () => {
    const story = readyStory();
    const fsDeps = makeFsDeps({ specContent: NO_STATUS_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toMatch(/active/i);
  });
});

describe('computeStoryReadyStatus — rule (3): implements non-empty + ACs in spec', () => {
  it('returns ready=false when implements is empty', async () => {
    const story = readyStory({ implements: [] });
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toMatch(/implements.*leer|leer.*implements/i);
  });

  it('returns ready=false when an AC-number is missing from the spec', async () => {
    const story = readyStory({ implements: ['AC1', 'AC99'] }); // AC99 not in VALID_SPEC
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toContain('AC99');
  });

  it('returns ready=true when all AC-numbers are present in the spec', async () => {
    const story = readyStory({ implements: ['AC1'] }); // AC1 present in VALID_SPEC
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(true);
  });
});

describe('computeStoryReadyStatus — rule (4): depends must be fulfilled', () => {
  it('returns ready=false when a depends story is missing', async () => {
    const story = readyStory({ depends: ['S-999'] }); // S-999 not in map
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toContain('S-999');
  });

  it('returns ready=false when a depends story is not Done', async () => {
    const story = readyStory({ depends: ['S-010'] });
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const allStoriesMap = makeStoriesMap([{ id: 'S-010', status: 'In Progress' }]);
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, allStoriesMap);
    expect(result.ready).toBe(false);
    expect(result.ready_reason).toContain('S-010');
  });

  it('returns ready=true when depends is empty', async () => {
    const story = readyStory({ depends: [] });
    const fsDeps = makeFsDeps({ specContent: VALID_SPEC });
    const result = await computeStoryReadyStatus(story, fsDeps, REPO_PATH, makeStoriesMap());
    expect(result.ready).toBe(true);
  });
});

// ── BoardAggregator integration: ready/ready_reason in _readBoard output ──────

const BOARD_YAML = `schema_version: 1
project_slug: test-project
next_feature_id: 2
next_story_id: 3
`;

const FEATURE_F001 = `id: F-001
title: Test Feature
status: Active
priority: P1
labels: []
stories: []
progress: null
`;

/**
 * Build a fake fsDeps for a minimal board with one feature and given stories.
 *
 * @param {Record<string,string>} extraFiles  Additional file path → content entries.
 */
function buildIntegrationFsDeps(extraFiles = {}) {
  const BOARD_ROOT = '/fake/repos';
  const REPO_NAME = 'test-repo';

  const files = {
    [`${BOARD_ROOT}/${REPO_NAME}/board/board.yaml`]: BOARD_YAML,
    [`${BOARD_ROOT}/${REPO_NAME}/board/features/F-001.yaml`]: FEATURE_F001,
    ...extraFiles,
  };

  const dirs = {
    [BOARD_ROOT]: [
      { name: REPO_NAME, isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false },
    ],
    [`${BOARD_ROOT}/${REPO_NAME}`]: [
      { name: 'board', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false },
    ],
    [`${BOARD_ROOT}/${REPO_NAME}/board`]: [
      { name: 'board.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'features', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      { name: 'stories', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
    ],
    [`${BOARD_ROOT}/${REPO_NAME}/board/features`]: [
      { name: 'F-001.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
    ],
    [`${BOARD_ROOT}/${REPO_NAME}/board/stories`]: Object.keys(extraFiles)
      .filter((p) => p.includes('/board/stories/'))
      .map((p) => {
        const name = p.split('/').pop();
        return { name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
      }),
  };

  return {
    readFile: async (path, _enc) => {
      if (path in files) return files[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      throw err;
    },
    readdir: async (path, _opts) => {
      if (path in dirs) return dirs[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      throw err;
    },
    watch: async function* () {},
  };
}

describe('BoardAggregator — stories carry ready/ready_reason fields (AC4)', () => {
  it('ready story gets ready=true', async () => {
    const SPEC_CONTENT = `---
status: active
---
## AC1 — something
`;
    const fsDeps = buildIntegrationFsDeps({
      '/fake/repos/test-repo/docs/specs/my.md': SPEC_CONTENT,
      '/fake/repos/test-repo/board/stories/S-001.yaml': `id: S-001
parent: F-001
title: Ready Story
status: To Do
priority: P1
spec: docs/specs/my.md
implements: [AC1]
depends: []
blocked_reason: null
labels: []
`,
    });
    const agg = new BoardAggregator({
      boardRootsEnv: '/fake/repos',
      fsDeps,
    });
    const index = await agg.getIndex();
    const stories = index[0].features[0].stories;
    expect(stories).toHaveLength(1);
    expect(stories[0].ready).toBe(true);
    expect(stories[0].ready_reason).toBeNull();
  });

  it('non-To-Do story gets ready=false, ready_reason=null', async () => {
    const fsDeps = buildIntegrationFsDeps({
      '/fake/repos/test-repo/board/stories/S-002.yaml': `id: S-002
parent: F-001
title: Done Story
status: Done
priority: P1
spec: docs/specs/my.md
implements: [AC1]
depends: []
blocked_reason: null
labels: []
`,
    });
    const agg = new BoardAggregator({
      boardRootsEnv: '/fake/repos',
      fsDeps,
    });
    const index = await agg.getIndex();
    const stories = index[0].features[0].stories;
    expect(stories[0].ready).toBe(false);
    expect(stories[0].ready_reason).toBeNull();
  });

  it('story with missing spec file gets ready=false with reason', async () => {
    const fsDeps = buildIntegrationFsDeps({
      '/fake/repos/test-repo/board/stories/S-003.yaml': `id: S-003
parent: F-001
title: Missing Spec Story
status: To Do
priority: P1
spec: docs/specs/missing.md
implements: [AC1]
depends: []
blocked_reason: null
labels: []
`,
      // Note: docs/specs/missing.md intentionally NOT in extraFiles
    });
    const agg = new BoardAggregator({
      boardRootsEnv: '/fake/repos',
      fsDeps,
    });
    const index = await agg.getIndex();
    const stories = index[0].features[0].stories;
    expect(stories[0].ready).toBe(false);
    expect(stories[0].ready_reason).toBeTruthy();
    expect(stories[0].ready_reason).toMatch(/nicht gefunden|missing/i);
  });

  it('blocked story gets ready=false with blocked reason', async () => {
    const SPEC_CONTENT = `---
status: active
---
## AC1 — something
`;
    const fsDeps = buildIntegrationFsDeps({
      '/fake/repos/test-repo/docs/specs/my.md': SPEC_CONTENT,
      '/fake/repos/test-repo/board/stories/S-004.yaml': `id: S-004
parent: F-001
title: Blocked Story
status: To Do
priority: P1
spec: docs/specs/my.md
implements: [AC1]
depends: []
blocked_reason: warte auf Entscheidung
labels: []
`,
    });
    const agg = new BoardAggregator({
      boardRootsEnv: '/fake/repos',
      fsDeps,
    });
    const index = await agg.getIndex();
    const stories = index[0].features[0].stories;
    expect(stories[0].ready).toBe(false);
    expect(stories[0].ready_reason).toContain('warte auf Entscheidung');
  });

  it('stories carry implements/depends/blocked_reason fields in endpoint shape', async () => {
    const fsDeps = buildIntegrationFsDeps({
      '/fake/repos/test-repo/board/stories/S-005.yaml': `id: S-005
parent: F-001
title: Shape Story
status: In Progress
priority: P1
spec: docs/specs/my.md
implements: [AC1, AC2]
depends: [S-001]
blocked_reason: null
labels: []
`,
    });
    const agg = new BoardAggregator({
      boardRootsEnv: '/fake/repos',
      fsDeps,
    });
    const index = await agg.getIndex();
    const story = index[0].features[0].stories[0];
    expect(story).toHaveProperty('implements');
    expect(story).toHaveProperty('depends');
    expect(story).toHaveProperty('blocked_reason');
    expect(story).toHaveProperty('ready');
    expect(story).toHaveProperty('ready_reason');
    expect(story.implements).toEqual(['AC1', 'AC2']);
    expect(story.depends).toEqual(['S-001']);
    expect(story.blocked_reason).toBeNull();
  });
});
