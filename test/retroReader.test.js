/**
 * retroReader.test.js — Unit tests for RetroReader, parseLearningsTable,
 *                        groupIntoRuns, buildRunReport, deriveSource, categoriseEntry.
 *
 * Covers (retro-view-backend):
 *   AC1 — getRuns() returns { runs: [...] } with correct shape; sorted descending by date.
 *   AC2 — Rows with same PR slug are grouped into exactly one run; date = most recent.
 *   AC3 — source badge derived correctly from slug prefix (retro/, train/, teamLeader/, team-add/, other).
 *   AC4 — Categories derived from Pack/Skill; multi-path entries counted in each matched category.
 *   AC5 — getRunReport() returns correct shape with id/rule/status/provenance/metric.
 *   AC6 — Metric join from baseline.json.defect_rates by rule_id; null when no match.
 *   AC7 — Phase 0: missing baseline.json / empty / n_items:0 / no defect_rates → 200 with metric:null.
 *   AC8 — (tested in retroRouter.test.js for HTTP level; here: slug validation helper).
 *   AC9 — Missing LEARNINGS.md → getRuns() returns { runs: [] }; getRunReport() returns null.
 *
 * Strategy:
 *   - Inject fake fsDeps (readFile) to avoid any real filesystem access.
 *   - Test exported helpers (deriveSource, categoriseEntry, parseLearningsTable, etc.) as units.
 *   - Test RetroReader via injected pluginRootResolver + fsDeps.
 */

import { describe, it, expect } from '@jest/globals';
import {
  deriveSource,
  categoriseEntry,
  parseLearningsTable,
  groupIntoRuns,
  buildRunReport,
  RetroReader,
} from '../src/RetroReader.js';

// ── Fixture helpers ────────────────────────────────────────────────────────────

const PLUGIN_ROOT = '/fake/plugin';

/**
 * Build a fake fsDeps.readFile that returns content for known paths, or throws ENOENT.
 *
 * @param {Record<string, string>} fileMap  path → content
 */
function buildFakeFsDeps(fileMap = {}) {
  return {
    readFile: async (path, _enc) => {
      if (path in fileMap) return fileMap[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

function makeRetroReader({ fileMap = {}, root = PLUGIN_ROOT } = {}) {
  const fsDeps = buildFakeFsDeps(fileMap);
  return new RetroReader({
    fsDeps,
    pluginRootResolver: async () => root,
  });
}

// Typical LEARNINGS.md fixture (plain paths, no backticks — kept for parser structure tests)
const LEARNINGS_CONTENT = `# LEARNINGS

| ID | Datum | Pack/Skill | Regel | Quelle | PR | Status |
|---|---|---|---|---|---|---|
| R01 | 2025-01-15 | agents/coder.md | Coder rule one | agents/coder.md | retro/PR-Q001 | Merged |
| R02 | 2025-01-15 | knowledge/js.md | JS knowledge rule | knowledge/js.md | retro/PR-Q001 | Merged |
| R03 | 2025-02-10 | skills/deploy/SKILL.md | Deploy skill rule | skills/deploy/SKILL.md | train/PR-Q002 | Proposed |
| R04 | 2025-03-01 | agents/orchestrator.md + knowledge/cicd.md | Multi-path rule | agents/orchestrator.md | teamLeader/PR-Q003 | Merged |
`;

/**
 * Real-format LEARNINGS.md fixture: backtick-wrapped paths, ` + `-separated,
 * brace-expansion, parenthesised prose. Mirrors the actual LEARNINGS.md format.
 */
const LEARNINGS_CONTENT_REAL = `# LEARNINGS

| ID | Datum | Pack/Skill | Regel | Quelle | PR | Status |
|---|---|---|---|---|---|---|
| R10 | 2025-05-01 | \`agents/cicd.md\` + \`knowledge/cicd.md\` + \`skills/cicd/SKILL.md\` + \`AGENTS.md\` + \`CONCEPT.md\` + \`skills/flow/SKILL.md\` | Multi-path all three cats | agents/cicd.md | retro/PR-R001 | Merged |
| R11 | 2025-05-01 | \`knowledge/java.md\` | Single knowledge | knowledge/java.md | retro/PR-R001 | Merged |
| R12 | 2025-05-02 | \`knowledge/frameworks/angular-21.md\` | Nested knowledge | knowledge/angular.md | train/PR-R002 | Proposed |
| R13 | 2025-05-03 | agents/{coder,reviewer}.md | Brace-expansion agents | agents/coder.md | train/PR-R002 | Proposed |
| R14 | 2025-05-04 | skills/{adopt,new-project}/SKILL.md | Brace-expansion skills | skills/adopt/SKILL.md | train/PR-R003 | Merged |
| R15 | 2025-05-05 | (Wartezimmer → Ziel bei 2. Beleg: agents/tester.md + agents/reviewer.md + knowledge/css.md) | Prose with paths | agents/tester.md | teamLeader/PR-R004 | Proposed |
| R16 | 2025-05-06 | (Wartezimmer) | Pure waiting room — no paths | — | teamLeader/PR-R004 | Proposed |
| R17 | 2025-05-07 | AGENTS.md + CONCEPT.md | No category prefixes | AGENTS.md | retro/PR-R005 | Merged |
`;

const BASELINE_CONTENT = JSON.stringify({
  n_items: 4,
  retro_effectiveness: 0.85,
  defect_rates: {
    R01: { rate_per_100ep: 1.5, baseline: 2.0, neu: 1.5, status: 'improved' },
    R03: { rate_per_100ep: 0.5, baseline: 1.0, neu: 0.5, status: 'improved' },
  },
});

// ── AC3 — deriveSource ────────────────────────────────────────────────────────

describe('AC3 — deriveSource: slug prefix → source badge', () => {
  it('retro/* → retro', () => {
    expect(deriveSource('retro/PR-Q001-coder')).toBe('retro');
  });

  it('train/* → train', () => {
    expect(deriveSource('train/PR-Q002')).toBe('train');
  });

  it('teamLeader/* → teamLeader', () => {
    expect(deriveSource('teamLeader/PR-Q003')).toBe('teamLeader');
  });

  it('team-add/* → teamLeader', () => {
    expect(deriveSource('team-add/PR-Q004')).toBe('teamLeader');
  });

  it('feat/* → other', () => {
    expect(deriveSource('feat/my-feature')).toBe('other');
  });

  it('empty slug → other', () => {
    expect(deriveSource('')).toBe('other');
  });

  it('null → other', () => {
    expect(deriveSource(null)).toBe('other');
  });

  it('case-insensitive: RETRO/* → retro', () => {
    expect(deriveSource('RETRO/pr-q001')).toBe('retro');
  });

  it('case-insensitive: TRAIN/* → train', () => {
    expect(deriveSource('TRAIN/pr-q001')).toBe('train');
  });

  it('case-insensitive: TEAMLEADER/* → teamLeader', () => {
    expect(deriveSource('TEAMLEADER/pr-q001')).toBe('teamLeader');
  });

  it('case-insensitive: TEAM-ADD/* → teamLeader', () => {
    expect(deriveSource('TEAM-ADD/pr-q001')).toBe('teamLeader');
  });

  it('no trailing slash match — "retro" without slash → other', () => {
    expect(deriveSource('retro')).toBe('other');
  });
});

// ── AC4 — categoriseEntry ─────────────────────────────────────────────────────

describe('AC4 — categoriseEntry: Pack/Skill path → categories', () => {
  it('agents/* → {agents}', () => {
    const cats = categoriseEntry('agents/coder.md');
    expect(cats.has('agents')).toBe(true);
    expect(cats.has('skills')).toBe(false);
    expect(cats.has('knowledge')).toBe(false);
  });

  it('skills/* → {skills}', () => {
    const cats = categoriseEntry('skills/deploy/SKILL.md');
    expect(cats.has('skills')).toBe(true);
    expect(cats.has('agents')).toBe(false);
  });

  it('knowledge/* → {knowledge}', () => {
    const cats = categoriseEntry('knowledge/js.md');
    expect(cats.has('knowledge')).toBe(true);
  });

  it('multi-path with all three categories → {agents, skills, knowledge}', () => {
    const cats = categoriseEntry('agents/cicd.md + knowledge/cicd.md + skills/cicd/SKILL.md');
    expect(cats.has('agents')).toBe(true);
    expect(cats.has('knowledge')).toBe(true);
    expect(cats.has('skills')).toBe(true);
  });

  it('multi-path with agents + knowledge only', () => {
    const cats = categoriseEntry('agents/orchestrator.md + knowledge/cicd.md');
    expect(cats.has('agents')).toBe(true);
    expect(cats.has('knowledge')).toBe(true);
    expect(cats.has('skills')).toBe(false);
  });

  it('unknown prefix → empty Set (no invented category)', () => {
    const cats = categoriseEntry('some/unknown/path.md');
    expect(cats.size).toBe(0);
  });

  it('empty string → empty Set', () => {
    expect(categoriseEntry('').size).toBe(0);
  });

  it('null → empty Set', () => {
    expect(categoriseEntry(null).size).toBe(0);
  });
});

// ── AC4 — categoriseEntry: REAL FORMAT (backtick-wrapped, brace, prose) ──────

describe('AC4 — categoriseEntry: real LEARNINGS.md format', () => {
  it('backtick-wrapped agents path → {agents}', () => {
    const cats = categoriseEntry('`agents/cicd.md`');
    expect(cats.has('agents')).toBe(true);
    expect(cats.has('skills')).toBe(false);
    expect(cats.has('knowledge')).toBe(false);
  });

  it('backtick-wrapped knowledge path → {knowledge}', () => {
    const cats = categoriseEntry('`knowledge/java.md`');
    expect(cats.has('knowledge')).toBe(true);
    expect(cats.has('agents')).toBe(false);
    expect(cats.has('skills')).toBe(false);
  });

  it('backtick-wrapped nested knowledge path → {knowledge}', () => {
    const cats = categoriseEntry('`knowledge/frameworks/angular-21.md`');
    expect(cats.has('knowledge')).toBe(true);
  });

  it('multi-path backtick ` + ` separated with all three cats → {agents, skills, knowledge}', () => {
    const cell = '`agents/cicd.md` + `knowledge/cicd.md` + `skills/cicd/SKILL.md` + `AGENTS.md` + `CONCEPT.md` + `skills/flow/SKILL.md`';
    const cats = categoriseEntry(cell);
    expect(cats.has('agents')).toBe(true);
    expect(cats.has('knowledge')).toBe(true);
    expect(cats.has('skills')).toBe(true);
  });

  it('brace-expansion agents/{coder,reviewer}.md → {agents}', () => {
    const cats = categoriseEntry('agents/{coder,reviewer}.md');
    expect(cats.has('agents')).toBe(true);
    expect(cats.has('skills')).toBe(false);
    expect(cats.has('knowledge')).toBe(false);
  });

  it('brace-expansion skills/{adopt,new-project}/SKILL.md → {skills}', () => {
    const cats = categoriseEntry('skills/{adopt,new-project}/SKILL.md');
    expect(cats.has('skills')).toBe(true);
    expect(cats.has('agents')).toBe(false);
    expect(cats.has('knowledge')).toBe(false);
  });

  it('prose with paths in parens → {agents, knowledge}', () => {
    const cell = '(Wartezimmer → Ziel bei 2. Beleg: agents/tester.md + agents/reviewer.md + knowledge/css.md)';
    const cats = categoriseEntry(cell);
    expect(cats.has('agents')).toBe(true);
    expect(cats.has('knowledge')).toBe(true);
    expect(cats.has('skills')).toBe(false);
  });

  it('pure (Wartezimmer) — no paths → empty Set (nothing invented)', () => {
    const cats = categoriseEntry('(Wartezimmer)');
    expect(cats.size).toBe(0);
  });

  it('(Wartezimmer → Ziel: ...) without category paths → empty Set', () => {
    const cats = categoriseEntry('(Wartezimmer → Ziel bei 2. Beleg: AGENTS.md + CONCEPT.md)');
    expect(cats.size).toBe(0);
  });

  it('AGENTS.md + CONCEPT.md (no category prefix) → empty Set', () => {
    // AGENTS.md does not have a leading category segment like agents/…
    const cats = categoriseEntry('AGENTS.md + CONCEPT.md');
    expect(cats.size).toBe(0);
  });

  it('does not match "useragents/" as agents (guard against false prefix match)', () => {
    const cats = categoriseEntry('useragents/foo.md');
    expect(cats.has('agents')).toBe(false);
  });

  it('counts > 0 for real fixture row R10 (all three categories)', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT_REAL);
    const r10 = rows.find((r) => r.id === 'R10');
    const cats = categoriseEntry(r10.packSkill);
    expect(cats.has('agents')).toBe(true);
    expect(cats.has('knowledge')).toBe(true);
    expect(cats.has('skills')).toBe(true);
  });

  it('counts > 0 for real fixture row R11 (knowledge only)', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT_REAL);
    const r11 = rows.find((r) => r.id === 'R11');
    const cats = categoriseEntry(r11.packSkill);
    expect(cats.has('knowledge')).toBe(true);
    expect(cats.has('agents')).toBe(false);
    expect(cats.has('skills')).toBe(false);
  });

  it('R16 (Wartezimmer) → empty Set — no category invented', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT_REAL);
    const r16 = rows.find((r) => r.id === 'R16');
    expect(categoriseEntry(r16.packSkill).size).toBe(0);
  });
});

// ── AC4 — counts with real-format fixture ────────────────────────────────────

describe('AC4 — groupIntoRuns + buildRunReport: real-format fixture counts > 0', () => {
  it('retro/PR-R001 has agents=1, knowledge=2, skills=1 (backtick multi-path + single)', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT_REAL);
    const runs = groupIntoRuns(rows);
    const run = runs.find((r) => r.slug === 'retro/PR-R001');
    // R10: agents + knowledge + skills; R11: knowledge
    expect(run.counts.agents).toBe(1);
    expect(run.counts.knowledge).toBe(2);
    expect(run.counts.skills).toBe(1);
  });

  it('train/PR-R002 has knowledge=1, agents=1 (nested knowledge + brace agents)', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT_REAL);
    const runs = groupIntoRuns(rows);
    const run = runs.find((r) => r.slug === 'train/PR-R002');
    // R12: knowledge; R13: agents
    expect(run.counts.knowledge).toBe(1);
    expect(run.counts.agents).toBe(1);
    expect(run.counts.skills).toBe(0);
  });

  it('teamLeader/PR-R004 has agents=1, knowledge=1, skills=0, zero for Wartezimmer row', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT_REAL);
    const runs = groupIntoRuns(rows);
    const run = runs.find((r) => r.slug === 'teamLeader/PR-R004');
    // R15: agents + knowledge (prose); R16: Wartezimmer → nothing
    expect(run.counts.agents).toBe(1);
    expect(run.counts.knowledge).toBe(1);
    expect(run.counts.skills).toBe(0);
  });

  it('retro/PR-R005 has all zeros (no category paths in AGENTS.md+CONCEPT.md)', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT_REAL);
    const runs = groupIntoRuns(rows);
    const run = runs.find((r) => r.slug === 'retro/PR-R005');
    expect(run.counts.agents).toBe(0);
    expect(run.counts.skills).toBe(0);
    expect(run.counts.knowledge).toBe(0);
  });

  it('buildRunReport for real fixture run R10 places entry in agents + knowledge + skills', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT_REAL);
    const r10rows = rows.filter((r) => r.pr === 'retro/PR-R001');
    const { agents, skills, knowledge } = buildRunReport(r10rows, null);
    // R10 must appear in all three
    expect(agents.some((e) => e.id === 'R10')).toBe(true);
    expect(skills.some((e) => e.id === 'R10')).toBe(true);
    expect(knowledge.some((e) => e.id === 'R10')).toBe(true);
    // R11 must appear only in knowledge
    expect(knowledge.some((e) => e.id === 'R11')).toBe(true);
    expect(agents.some((e) => e.id === 'R11')).toBe(false);
  });
});

// ── parseLearningsTable ───────────────────────────────────────────────────────

describe('parseLearningsTable', () => {
  it('parses normal table rows', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    expect(rows.length).toBe(4);
  });

  it('row has correct field names', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    const r = rows[0];
    expect(r).toHaveProperty('id', 'R01');
    expect(r).toHaveProperty('datum', '2025-01-15');
    expect(r).toHaveProperty('packSkill', 'agents/coder.md');
    expect(r).toHaveProperty('regel', 'Coder rule one');
    expect(r).toHaveProperty('quelle', 'agents/coder.md');
    expect(r).toHaveProperty('pr', 'retro/PR-Q001');
    expect(r).toHaveProperty('status', 'Merged');
  });

  it('skips header row (ID | Datum | …)', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    expect(rows.find((r) => r.id.toLowerCase() === 'id')).toBeUndefined();
  });

  it('skips separator rows (---|---)', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    // If separator rows were parsed they would have values like '---'
    expect(rows.find((r) => /^[-\s:]*$/.test(r.id))).toBeUndefined();
  });

  it('skips rows with wrong column count (malformed lines — no crash)', () => {
    const malformed = `| R01 | 2025-01-15 | agents/coder.md | Rule text | Quelle | PR-001 | Merged |\n| BAD | only three cols |\n`;
    const rows = parseLearningsTable(malformed);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('R01');
  });

  it('skips rows with empty PR column', () => {
    const content = `| ID | Datum | Pack/Skill | Regel | Quelle | PR | Status |\n|---|---|---|---|---|---|---|\n| R01 | 2025-01-15 | agents/a.md | Rule | Quelle |  | Merged |\n`;
    const rows = parseLearningsTable(content);
    expect(rows.length).toBe(0);
  });

  it('returns empty array for null input', () => {
    expect(parseLearningsTable(null)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseLearningsTable('')).toEqual([]);
  });

  it('returns empty array when no data rows (only header + separator)', () => {
    const content = `| ID | Datum | Pack/Skill | Regel | Quelle | PR | Status |\n|---|---|---|---|---|---|---|\n`;
    expect(parseLearningsTable(content)).toEqual([]);
  });
});

// ── AC2 — groupIntoRuns ───────────────────────────────────────────────────────

describe('AC2 — groupIntoRuns: same PR slug → one run', () => {
  it('groups rows with same slug into one run', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    const runs = groupIntoRuns(rows);
    const slugs = runs.map((r) => r.slug);
    // retro/PR-Q001 appears twice in the fixture → one run
    expect(slugs.filter((s) => s === 'retro/PR-Q001').length).toBe(1);
  });

  it('produces correct number of runs (3 distinct slugs in fixture)', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    const runs = groupIntoRuns(rows);
    expect(runs.length).toBe(3);
  });

  it('date = most recent date in the group', () => {
    const rows = [
      { id: 'A', datum: '2025-01-10', packSkill: '', regel: '', quelle: '', pr: 'retro/PR-X', status: 'Merged' },
      { id: 'B', datum: '2025-01-20', packSkill: '', regel: '', quelle: '', pr: 'retro/PR-X', status: 'Merged' },
    ];
    const runs = groupIntoRuns(rows);
    expect(runs[0].date).toBe('2025-01-20');
  });

  it('single-row run has correct date', () => {
    const rows = [
      { id: 'A', datum: '2025-03-05', packSkill: 'agents/a.md', regel: 'Rule', quelle: 'agents/a.md', pr: 'retro/PR-Y', status: 'Proposed' },
    ];
    const runs = groupIntoRuns(rows);
    expect(runs[0].date).toBe('2025-03-05');
  });

  it('statusMix aggregates stati per run', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    const runs = groupIntoRuns(rows);
    const run001 = runs.find((r) => r.slug === 'retro/PR-Q001');
    expect(run001.statusMix).toEqual({ Merged: 2 });
  });
});

// ── AC1 — Overview shape + sort ──────────────────────────────────────────────

describe('AC1 — groupIntoRuns: correct shape + descending date sort', () => {
  it('run has slug, date, source, counts, statusMix', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    const runs = groupIntoRuns(rows);
    for (const run of runs) {
      expect(run).toHaveProperty('slug');
      expect(run).toHaveProperty('date');
      expect(run).toHaveProperty('source');
      expect(run).toHaveProperty('counts');
      expect(run).toHaveProperty('statusMix');
    }
  });

  it('run.counts has agents, skills, knowledge', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    const runs = groupIntoRuns(rows);
    for (const run of runs) {
      expect(run.counts).toHaveProperty('agents');
      expect(run.counts).toHaveProperty('skills');
      expect(run.counts).toHaveProperty('knowledge');
    }
  });

  it('run does NOT include rule/id/provenance (no detail fields in overview — AC1)', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    const runs = groupIntoRuns(rows);
    for (const run of runs) {
      expect(run).not.toHaveProperty('rule');
      expect(run).not.toHaveProperty('agents');
      expect(run).not.toHaveProperty('skills');
      expect(run).not.toHaveProperty('knowledge');
    }
  });

  it('runs are sorted descending by date', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    const runs = groupIntoRuns(rows);
    const dates = runs.map((r) => r.date);
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    expect(dates).toEqual(sorted);
  });

  it('returns empty array for zero rows', () => {
    expect(groupIntoRuns([])).toEqual([]);
  });
});

// ── AC4 — counts in overview ─────────────────────────────────────────────────

describe('AC4 — counts reflect category assignments', () => {
  it('agents count is correct for retro/PR-Q001 (1 agents/* row)', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    const runs = groupIntoRuns(rows);
    const run = runs.find((r) => r.slug === 'retro/PR-Q001');
    expect(run.counts.agents).toBe(1);   // R01: agents/coder.md
    expect(run.counts.knowledge).toBe(1); // R02: knowledge/js.md
    expect(run.counts.skills).toBe(0);
  });

  it('multi-path entry (agents + knowledge) counted in both categories', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT);
    const runs = groupIntoRuns(rows);
    const run = runs.find((r) => r.slug === 'teamLeader/PR-Q003');
    // R04: agents/orchestrator.md + knowledge/cicd.md
    expect(run.counts.agents).toBe(1);
    expect(run.counts.knowledge).toBe(1);
    expect(run.counts.skills).toBe(0);
  });

  it('unknown prefix entries add 0 to any category', () => {
    const rows = [
      { id: 'X', datum: '2025-01-01', packSkill: 'some/other/path.md', regel: 'r', quelle: 'q', pr: 'other/PR-ZZZ', status: 'Proposed' },
    ];
    const runs = groupIntoRuns(rows);
    expect(runs[0].counts.agents).toBe(0);
    expect(runs[0].counts.skills).toBe(0);
    expect(runs[0].counts.knowledge).toBe(0);
  });
});

// ── AC5/AC6 — buildRunReport ──────────────────────────────────────────────────

describe('AC5 — buildRunReport: entry shape', () => {
  const rows = parseLearningsTable(LEARNINGS_CONTENT).filter((r) => r.pr === 'retro/PR-Q001');

  it('agents array contains entry with correct fields', () => {
    const { agents } = buildRunReport(rows, null);
    expect(agents.length).toBe(1);
    const e = agents[0];
    expect(e).toHaveProperty('id', 'R01');
    expect(e).toHaveProperty('rule', 'Coder rule one');
    expect(e).toHaveProperty('status', 'Merged');
    expect(e).toHaveProperty('provenance', 'agents/coder.md');
    expect(e).toHaveProperty('metric');
  });

  it('knowledge array contains entry with correct fields', () => {
    const { knowledge } = buildRunReport(rows, null);
    expect(knowledge.length).toBe(1);
    expect(knowledge[0]).toHaveProperty('id', 'R02');
    expect(knowledge[0]).toHaveProperty('rule', 'JS knowledge rule');
  });

  it('skills array is empty when no skills/* rows', () => {
    const { skills } = buildRunReport(rows, null);
    expect(skills).toEqual([]);
  });
});

describe('AC6 — buildRunReport: metric join from defect_rates', () => {
  const rows = parseLearningsTable(LEARNINGS_CONTENT).filter((r) => r.pr === 'retro/PR-Q001');
  const defectRates = JSON.parse(BASELINE_CONTENT).defect_rates;

  it('metric is joined when rule_id exists in defect_rates', () => {
    const { agents } = buildRunReport(rows, defectRates);
    // R01 has a defect_rate entry
    const e = agents.find((x) => x.id === 'R01');
    expect(e.metric).not.toBeNull();
    expect(e.metric).toHaveProperty('rate_per_100ep', 1.5);
    expect(e.metric).toHaveProperty('baseline', 2.0);
    expect(e.metric).toHaveProperty('neu', 1.5);
    expect(e.metric).toHaveProperty('status', 'improved');
  });

  it('metric is null when rule_id not in defect_rates', () => {
    const { knowledge } = buildRunReport(rows, defectRates);
    // R02 has no defect_rate entry
    const e = knowledge.find((x) => x.id === 'R02');
    expect(e.metric).toBeNull();
  });

  it('metric is null for all entries when defectRates is null (Phase 0)', () => {
    const { agents, skills, knowledge } = buildRunReport(rows, null);
    for (const e of [...agents, ...skills, ...knowledge]) {
      expect(e.metric).toBeNull();
    }
  });
});

describe('AC4 — buildRunReport: multi-path entry in multiple category arrays', () => {
  it('entry with agents + knowledge appears in both arrays', () => {
    const rows = parseLearningsTable(LEARNINGS_CONTENT).filter((r) => r.pr === 'teamLeader/PR-Q003');
    const { agents, knowledge, skills } = buildRunReport(rows, null);
    // R04: agents/orchestrator.md + knowledge/cicd.md
    expect(agents.length).toBe(1);
    expect(knowledge.length).toBe(1);
    expect(agents[0].id).toBe('R04');
    expect(knowledge[0].id).toBe('R04');
    expect(skills.length).toBe(0);
  });
});

// ── RetroReader.getRuns() ─────────────────────────────────────────────────────

describe('RetroReader.getRuns()', () => {
  it('AC1 — returns { runs: [...] } with correct shape', async () => {
    const reader = makeRetroReader({
      fileMap: { [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT },
    });
    const result = await reader.getRuns();
    expect(result).toHaveProperty('runs');
    expect(Array.isArray(result.runs)).toBe(true);
    expect(result.runs.length).toBe(3);
  });

  it('AC1 — overview does not include rule/agents/skills/knowledge detail fields', async () => {
    const reader = makeRetroReader({
      fileMap: { [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT },
    });
    const { runs } = await reader.getRuns();
    for (const run of runs) {
      expect(run).not.toHaveProperty('rule');
      expect(run).not.toHaveProperty('agents');
      expect(run).not.toHaveProperty('skills');
      expect(run).not.toHaveProperty('knowledge');
    }
  });

  it('AC9 — LEARNINGS.md missing → 200 with empty runs', async () => {
    const reader = makeRetroReader({ fileMap: {} });
    const result = await reader.getRuns();
    expect(result).toEqual({ runs: [] });
  });

  it('AC9 — LEARNINGS.md has no data rows → empty runs', async () => {
    const reader = makeRetroReader({
      fileMap: {
        [`${PLUGIN_ROOT}/LEARNINGS.md`]: `| ID | Datum | Pack/Skill | Regel | Quelle | PR | Status |\n|---|---|---|---|---|---|---|\n`,
      },
    });
    const result = await reader.getRuns();
    expect(result).toEqual({ runs: [] });
  });

  it('no crash when pluginRootResolver returns null', async () => {
    const reader = new RetroReader({ pluginRootResolver: async () => null });
    const result = await reader.getRuns();
    expect(result).toEqual({ runs: [] });
  });

  it('no crash when pluginRootResolver throws', async () => {
    const reader = new RetroReader({ pluginRootResolver: async () => { throw new Error('no root'); } });
    const result = await reader.getRuns();
    expect(result).toEqual({ runs: [] });
  });
});

// ── RetroReader.getRunReport() ────────────────────────────────────────────────

describe('RetroReader.getRunReport()', () => {
  it('AC5 — returns correct report shape for existing slug', async () => {
    const reader = makeRetroReader({
      fileMap: {
        [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT,
        [`${PLUGIN_ROOT}/.claude/metrics/baseline.json`]: BASELINE_CONTENT,
      },
    });
    const report = await reader.getRunReport('retro/PR-Q001');
    expect(report).not.toBeNull();
    expect(report).toHaveProperty('slug', 'retro/PR-Q001');
    expect(report).toHaveProperty('date', '2025-01-15');
    expect(report).toHaveProperty('source', 'retro');
    expect(report).toHaveProperty('statusMix');
    expect(report).toHaveProperty('agents');
    expect(report).toHaveProperty('skills');
    expect(report).toHaveProperty('knowledge');
  });

  it('AC5 — each entry has id, rule, status, provenance, metric', async () => {
    const reader = makeRetroReader({
      fileMap: {
        [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT,
        [`${PLUGIN_ROOT}/.claude/metrics/baseline.json`]: BASELINE_CONTENT,
      },
    });
    const report = await reader.getRunReport('retro/PR-Q001');
    for (const entry of [...report.agents, ...report.skills, ...report.knowledge]) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('rule');
      expect(entry).toHaveProperty('status');
      expect(entry).toHaveProperty('provenance');
      expect(entry).toHaveProperty('metric');
    }
  });

  it('AC6 — metric joined when rule_id found in defect_rates', async () => {
    const reader = makeRetroReader({
      fileMap: {
        [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT,
        [`${PLUGIN_ROOT}/.claude/metrics/baseline.json`]: BASELINE_CONTENT,
      },
    });
    const report = await reader.getRunReport('retro/PR-Q001');
    const r01 = report.agents.find((e) => e.id === 'R01');
    expect(r01.metric).not.toBeNull();
    expect(r01.metric.rate_per_100ep).toBe(1.5);
  });

  it('AC6 — metric null when rule_id not in defect_rates', async () => {
    const reader = makeRetroReader({
      fileMap: {
        [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT,
        [`${PLUGIN_ROOT}/.claude/metrics/baseline.json`]: BASELINE_CONTENT,
      },
    });
    const report = await reader.getRunReport('retro/PR-Q001');
    const r02 = report.knowledge.find((e) => e.id === 'R02');
    expect(r02.metric).toBeNull();
  });

  it('AC7 — missing baseline.json → 200 with metric: null everywhere', async () => {
    const reader = makeRetroReader({
      fileMap: { [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT },
      // no baseline.json
    });
    const report = await reader.getRunReport('retro/PR-Q001');
    expect(report).not.toBeNull();
    for (const entry of [...report.agents, ...report.skills, ...report.knowledge]) {
      expect(entry.metric).toBeNull();
    }
  });

  it('AC7 — empty baseline.json → metric: null everywhere', async () => {
    const reader = makeRetroReader({
      fileMap: {
        [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT,
        [`${PLUGIN_ROOT}/.claude/metrics/baseline.json`]: '',
      },
    });
    const report = await reader.getRunReport('retro/PR-Q001');
    expect(report).not.toBeNull();
    for (const entry of [...report.agents, ...report.skills, ...report.knowledge]) {
      expect(entry.metric).toBeNull();
    }
  });

  it('AC7 — baseline.json with n_items:0 → metric: null everywhere', async () => {
    const reader = makeRetroReader({
      fileMap: {
        [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT,
        [`${PLUGIN_ROOT}/.claude/metrics/baseline.json`]: JSON.stringify({ n_items: 0, defect_rates: {} }),
      },
    });
    const report = await reader.getRunReport('retro/PR-Q001');
    expect(report).not.toBeNull();
    for (const entry of [...report.agents, ...report.skills, ...report.knowledge]) {
      expect(entry.metric).toBeNull();
    }
  });

  it('AC7 — baseline.json without defect_rates → metric: null everywhere', async () => {
    const reader = makeRetroReader({
      fileMap: {
        [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT,
        [`${PLUGIN_ROOT}/.claude/metrics/baseline.json`]: JSON.stringify({ n_items: 5, retro_effectiveness: 0.9 }),
      },
    });
    const report = await reader.getRunReport('retro/PR-Q001');
    expect(report).not.toBeNull();
    for (const entry of [...report.agents, ...report.skills, ...report.knowledge]) {
      expect(entry.metric).toBeNull();
    }
  });

  it('AC9 — LEARNINGS.md missing → getRunReport returns null (404-ready)', async () => {
    const reader = makeRetroReader({ fileMap: {} });
    const report = await reader.getRunReport('retro/PR-Q001');
    expect(report).toBeNull();
  });

  it('AC9 — valid slug but not in LEARNINGS rows → null (404-ready)', async () => {
    const reader = makeRetroReader({
      fileMap: { [`${PLUGIN_ROOT}/LEARNINGS.md`]: LEARNINGS_CONTENT },
    });
    const report = await reader.getRunReport('retro/PR-NOT-FOUND');
    expect(report).toBeNull();
  });

  it('no crash when pluginRootResolver returns null', async () => {
    const reader = new RetroReader({ pluginRootResolver: async () => null });
    const report = await reader.getRunReport('retro/PR-Q001');
    expect(report).toBeNull();
  });
});
