/**
 * RetroReader — Retro-Sichtbarkeit Backend-Boundary (read-only, AC1–AC10 retro-view-backend).
 *
 * Reads two files from the resolved agent-flow Plugin-Root:
 *   - LEARNINGS.md         — Markdown table: ID | Datum | Pack/Skill | Regel | Quelle | PR | Status
 *   - .claude/metrics/baseline.json — Metric matrix (Phase 0: may be missing/empty/no defect_rates)
 *
 * Plugin-Root resolution: reuses AgentFlowReader.resolvePluginRoot() via an injected resolver
 * (same ENV-Override AGENT_FLOW_PLUGIN_ROOT → newest cache directory logic).
 *
 * Injectable fsDeps for tests (same pattern as AgentFlowReader).
 *
 * Security:
 *   - Reads ONLY LEARNINGS.md and .claude/metrics/baseline.json of the resolved plugin root.
 *   - Slug parameters are validated by retroRouter before being passed here.
 *   - No secrets in output; no writes; no executions.
 *
 * @module RetroReader
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Default FS dependencies (real node:fs/promises). */
const defaultFsDeps = { readFile };

/**
 * Derive the source badge from a slug prefix.
 * Case-insensitive, prefix-only, no filesystem access.
 *
 * @param {string} slug
 * @returns {'retro'|'train'|'teamLeader'|'other'}
 */
export function deriveSource(slug) {
  if (!slug || typeof slug !== 'string') return 'other';
  const lower = slug.toLowerCase();
  if (lower.startsWith('retro/')) return 'retro';
  if (lower.startsWith('train/')) return 'train';
  if (lower.startsWith('teamleader/') || lower.startsWith('team-add/')) return 'teamLeader';
  return 'other';
}

/**
 * Categorise an entry based on the Pack/Skill column value.
 *
 * Searches the entire cell string for occurrences of the path segments
 * `agents/`, `skills/`, or `knowledge/` using a regex that requires each
 * segment to begin after a non-word boundary (prevents false matches like
 * "useragents/"). Works correctly with:
 *   - Backtick-wrapped paths:  `agents/cicd.md` + `knowledge/cicd.md`
 *   - Brace-expansion:         agents/{coder,reviewer}.md
 *   - Prose/parentheses:       (Wartezimmer → Ziel: agents/tester.md)
 *   - Plain paths (no backticks): agents/coder.md
 *
 * Returns a Set of zero or more of: 'agents', 'skills', 'knowledge'.
 *
 * @param {string} packSkill  Raw value from the Pack/Skill column.
 * @returns {Set<'agents'|'skills'|'knowledge'>}
 */
export function categoriseEntry(packSkill) {
  const cats = new Set();
  if (!packSkill || typeof packSkill !== 'string') return cats;

  // Match category path-segments that are NOT preceded by an alphanumeric character
  // (prevents "useragents/" from matching as "agents/").
  const CATEGORY_RE = /(?:^|[^A-Za-z0-9])(agents|skills|knowledge)\//gi;
  let match;
  while ((match = CATEGORY_RE.exec(packSkill)) !== null) {
    cats.add(match[1].toLowerCase());
  }
  return cats;
}

/**
 * Parse a LEARNINGS.md Markdown table into an array of row objects.
 *
 * Expected column order: ID | Datum | Pack/Skill | Regel | Quelle | PR | Status
 * (7 columns after the leading pipe). Rows with wrong column count are silently
 * skipped (AC robustness — malformed lines, no crash).
 *
 * Only lines that:
 *   - Start with '|' (data rows, not headers/separators)
 *   - Are NOT separator rows (cells containing only dashes/colons/spaces)
 *   - Have exactly 7 data columns (excluding leading/trailing empty segments)
 *
 * @param {string} content  Raw file content.
 * @returns {Array<{ id, datum, packSkill, regel, quelle, pr, status }>}
 */
export function parseLearningsTable(content) {
  if (!content || typeof content !== 'string') return [];

  const rows = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;

    // Split by pipe, drop leading/trailing empty segments from surrounding pipes
    const parts = line.split('|').slice(1, -1).map((c) => c.trim());

    // Skip separator rows (cells containing only dashes/colons/spaces)
    if (parts.every((p) => /^[-:\s]*$/.test(p))) continue;

    // Expected: exactly 7 columns — ID | Datum | Pack/Skill | Regel | Quelle | PR | Status
    if (parts.length !== 7) continue;

    const [id, datum, packSkill, regel, quelle, pr, status] = parts;

    // Skip header rows (where id column looks like a header label)
    if (id.toLowerCase() === 'id') continue;

    // Skip rows where PR (column index 5) is empty — no slug to group by
    if (!pr) continue;

    rows.push({ id, datum, packSkill, regel, quelle, pr, status });
  }
  return rows;
}

/**
 * Group parsed LEARNINGS rows into runs (grouped by PR slug).
 *
 * AC2: All rows with the same PR slug → one run.
 * AC3: source derived from slug prefix.
 * AC4: category counts per run.
 *
 * @param {Array<{ id, datum, packSkill, regel, quelle, pr, status }>} rows
 * @returns {Array<RunSummary>}   Sorted descending by date, stable secondary sort by slug.
 */
export function groupIntoRuns(rows) {
  /** @type {Map<string, { slug, dates: string[], rows: Array }>} */
  const bySlug = new Map();

  for (const row of rows) {
    const slug = row.pr;
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { slug, dates: [], rows: [] });
    }
    bySlug.get(slug).dates.push(row.datum);
    bySlug.get(slug).rows.push(row);
  }

  const runs = [];
  for (const { slug, dates, rows: runRows } of bySlug.values()) {
    // date = most recent / lexicographically largest date in the group (AC2: jüngste/erste)
    const date = dates.slice().sort((a, b) => b.localeCompare(a))[0] ?? '';
    const source = deriveSource(slug);

    // counts: how many unique entries touch each category
    const agentsCount    = runRows.filter((r) => categoriseEntry(r.packSkill).has('agents')).length;
    const skillsCount    = runRows.filter((r) => categoriseEntry(r.packSkill).has('skills')).length;
    const knowledgeCount = runRows.filter((r) => categoriseEntry(r.packSkill).has('knowledge')).length;

    // statusMix aggregation
    const statusMix = {};
    for (const row of runRows) {
      const s = row.status || 'Unknown';
      statusMix[s] = (statusMix[s] ?? 0) + 1;
    }

    runs.push({
      slug,
      date,
      source,
      counts: { agents: agentsCount, skills: skillsCount, knowledge: knowledgeCount },
      statusMix,
    });
  }

  // AC1: descending by date; stable secondary sort by slug
  runs.sort((a, b) => {
    const dc = b.date.localeCompare(a.date);
    if (dc !== 0) return dc;
    return a.slug.localeCompare(b.slug);
  });

  return runs;
}

/**
 * Build the detailed report entries for a single run, grouped by category.
 *
 * AC5: each entry has { id, rule, status, provenance, metric }.
 * AC6: metric joined from baseline.json.defect_rates by rule_id (= entry id column).
 * AC4: one logical row may appear in multiple category arrays.
 *
 * @param {Array<{ id, datum, packSkill, regel, quelle, pr, status }>} runRows
 * @param {object|null} defectRates  baseline.json.defect_rates map (or null for Phase 0).
 * @returns {{ agents: Array, skills: Array, knowledge: Array }}
 */
export function buildRunReport(runRows, defectRates) {
  const agents    = [];
  const skills    = [];
  const knowledge = [];

  for (const row of runRows) {
    const cats = categoriseEntry(row.packSkill);

    // AC6: metric join via rule_id (= id column of the LEARNINGS row)
    let metric = null;
    if (defectRates && row.id && defectRates[row.id]) {
      const dr = defectRates[row.id];
      metric = {
        rate_per_100ep: dr.rate_per_100ep ?? null,
        baseline:       dr.baseline       ?? null,
        neu:            dr.neu            ?? null,
        status:         dr.status         ?? null,
      };
    }

    const entry = {
      id:          row.id,
      rule:        row.regel,
      status:      row.status,
      provenance:  row.quelle,
      metric,
    };

    if (cats.has('agents'))    agents.push(entry);
    if (cats.has('skills'))    skills.push(entry);
    if (cats.has('knowledge')) knowledge.push(entry);
  }

  return { agents, skills, knowledge };
}

/**
 * RetroReader reads LEARNINGS.md and baseline.json from the plugin root.
 *
 * @param {object} [options]
 * @param {object} [options.fsDeps]
 *   Injectable filesystem helpers: { readFile }.
 *   Defaults to real node:fs/promises.
 * @param {Function} [options.pluginRootResolver]
 *   Async () => string|null — returns the plugin root path.
 *   In production: the resolver from AgentFlowReader is passed in.
 *   In tests: a custom resolver pointing at a fixture directory.
 */
export class RetroReader {
  #fsDeps;
  #pluginRootResolver;

  constructor({ fsDeps, pluginRootResolver } = {}) {
    this.#fsDeps = fsDeps ?? defaultFsDeps;
    this.#pluginRootResolver = pluginRootResolver ?? (() => Promise.resolve(null));
  }

  /**
   * Read and parse LEARNINGS.md. Returns empty array on any error (AC9).
   *
   * @returns {Promise<Array<{ id, datum, packSkill, regel, quelle, pr, status }>>}
   */
  async #readLearnings(root) {
    const filePath = join(root, 'LEARNINGS.md');
    let content;
    try {
      content = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch {
      return [];
    }
    return parseLearningsTable(content);
  }

  /**
   * Read and parse .claude/metrics/baseline.json.
   * Returns null on any error (missing, empty, parse failure — Phase 0, AC7).
   *
   * @returns {Promise<object|null>}
   */
  async #readBaseline(root) {
    const filePath = join(root, '.claude', 'metrics', 'baseline.json');
    let raw;
    try {
      raw = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    if (!raw || !raw.trim()) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    // Phase 0: n_items:0 or missing defect_rates → treat as no metrics
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.n_items === 0) return null;
    if (!parsed.defect_rates || typeof parsed.defect_rates !== 'object') return null;

    return parsed;
  }

  /**
   * GET /api/retro/runs — returns the overview of all runs (AC1).
   *
   * @returns {Promise<{ runs: Array<RunSummary> }>}
   */
  async getRuns() {
    const root = await this.#pluginRootResolver().catch(() => null);
    if (!root) {
      return { runs: [] };
    }
    const rows = await this.#readLearnings(root);
    const runs = groupIntoRuns(rows);
    return { runs };
  }

  /**
   * GET /api/retro/runs/:slug — returns the full report for one run (AC5).
   *
   * @param {string} slug  Pre-validated slug.
   * @returns {Promise<object|null>}  null = not found (404).
   */
  async getRunReport(slug) {
    const root = await this.#pluginRootResolver().catch(() => null);
    if (!root) return null;

    const rows = await this.#readLearnings(root);
    const runRows = rows.filter((r) => r.pr === slug);
    if (runRows.length === 0) return null;

    // date = most recent date in run
    const dates = runRows.map((r) => r.datum).sort((a, b) => b.localeCompare(a));
    const date = dates[0] ?? '';
    const source = deriveSource(slug);

    // statusMix
    const statusMix = {};
    for (const row of runRows) {
      const s = row.status || 'Unknown';
      statusMix[s] = (statusMix[s] ?? 0) + 1;
    }

    // AC7: baseline may be null (Phase 0 — no crash, metric: null throughout)
    const baseline = await this.#readBaseline(root);
    const defectRates = baseline?.defect_rates ?? null;

    const { agents, skills, knowledge } = buildRunReport(runRows, defectRates);

    return { slug, date, source, statusMix, agents, skills, knowledge };
  }
}
