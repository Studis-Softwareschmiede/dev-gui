/**
 * storyMetricReader.test.js — Unit tests for StoryMetricReader + parseJsonl + matchesStoryId.
 *
 * Covers (story-detail-ansicht):
 *   AC1 — Backend-Reader liefert zu einer Story aus dispatches.jsonl + items.jsonl:
 *          started_at (min ts), ended_at (max ts), duration, flow (seq-geordnet),
 *          ep_est / ep_act / tok_est / tok_total / size_est + Abweichungen.
 *          Fehlende Metrik → null, kein Crash.
 *
 * Covers (story-detail-yaml-fallback):
 *   AC2 — matchesStoryId: int/string-tolerantes ID-Matching.
 *          String-Gleichheit ("S-165" == "S-165") UND
 *          numerische Gleichheit (165 == "S-165" nach Normalisierung).
 *          Kein Pfad-Gebrauch von item/storyId.
 *          Integration in getDetail: Integer-Ledgerzeilen werden korrekt gefunden.
 *
 * Strategy:
 *   - Inject fake fsDeps (readFile) — kein echtes Filesystem.
 *   - Verify all fields on happy path.
 *   - Verify null / graceful-degradation on missing files.
 *   - Verify flow is sorted by seq.
 *   - matchesStoryId: reine Unit-Tests ohne FS.
 */

import { describe, it, expect } from '@jest/globals';
import { StoryMetricReader, parseJsonl, matchesStoryId } from '../src/StoryMetricReader.js';

// ── parseJsonl unit tests ──────────────────────────────────────────────────────

describe('parseJsonl', () => {
  it('parses valid JSON lines', () => {
    const content = '{"a":1}\n{"b":2}\n';
    expect(parseJsonl(content)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips empty lines', () => {
    const content = '{"a":1}\n\n{"b":2}';
    expect(parseJsonl(content)).toHaveLength(2);
  });

  it('skips invalid JSON lines without throwing', () => {
    const content = '{"a":1}\nBADJSON\n{"b":2}';
    expect(parseJsonl(content)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns [] for empty content', () => {
    expect(parseJsonl('')).toEqual([]);
    expect(parseJsonl(null)).toEqual([]);
  });

  it('skips non-object (primitive) JSON values like strings and numbers', () => {
    const content = '"string"\n42\nnull\n{"valid":true}';
    // primitive top-level values are skipped (typeof not 'object'); null also skipped
    const result = parseJsonl(content);
    expect(result.some((r) => r && r.valid === true)).toBe(true);
    expect(result.length).toBe(1);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO_PATH = '/fake/repo';

const DISPATCHES_LINES = [
  JSON.stringify({ ts: '2025-01-10T10:00:00.000Z', agent: 'coder',    seq: 1, iter: 1, gate: null,   secs: 120, tok: 800,  item: 'S-116' }),
  JSON.stringify({ ts: '2025-01-10T10:05:00.000Z', agent: 'reviewer', seq: 2, iter: 1, gate: 'PASS', secs:  60, tok: 400,  item: 'S-116' }),
  JSON.stringify({ ts: '2025-01-10T09:00:00.000Z', agent: 'other',    seq: 1, iter: 1, gate: null,   secs:  30, tok: 200,  item: 'S-999' }), // different story
].join('\n');

const ITEMS_LINES = [
  JSON.stringify({ id: 'S-116', ep_est: 3, ep_act: 4, tok_total: 1500, size_est: 'M' }),
  JSON.stringify({ id: 'S-999', ep_est: 1, ep_act: 1, tok_total:  200, size_est: 'S' }),
].join('\n');

/**
 * Build a fake fsDeps that serves DISPATCHES_LINES and ITEMS_LINES.
 *
 * @param {{ dispatches?: string|null, items?: string|null }} overrides
 */
function makeFsDeps({ dispatches = DISPATCHES_LINES, items = ITEMS_LINES } = {}) {
  return {
    readFile: async (filePath) => {
      if (filePath.endsWith('dispatches.jsonl')) {
        if (dispatches == null) throw new Error('ENOENT');
        return dispatches;
      }
      if (filePath.endsWith('items.jsonl')) {
        if (items == null) throw new Error('ENOENT');
        return items;
      }
      throw new Error(`Unexpected file: ${filePath}`);
    },
  };
}

// ── AC1: Happy path ────────────────────────────────────────────────────────────

describe('StoryMetricReader.getDetail — happy path (AC1)', () => {
  it('returns started_at as ISO string (min ts)', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.started_at).toBe('2025-01-10T10:00:00.000Z');
  });

  it('returns ended_at as ISO string (max ts)', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.ended_at).toBe('2025-01-10T10:05:00.000Z');
  });

  it('returns duration in seconds (max - min ts)', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    // 10:05 - 10:00 = 5 * 60 = 300 seconds
    expect(detail.duration).toBe(300);
  });

  it('returns flow sorted by seq with correct fields', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');

    expect(detail.flow).toHaveLength(2);
    expect(detail.flow[0].seq).toBe(1);
    expect(detail.flow[0].agent).toBe('coder');
    expect(detail.flow[0].iter).toBe(1);
    expect(detail.flow[0].gate).toBeNull();
    expect(detail.flow[0].secs).toBe(120);
    expect(detail.flow[0].tok).toBe(800);

    expect(detail.flow[1].seq).toBe(2);
    expect(detail.flow[1].agent).toBe('reviewer');
    expect(detail.flow[1].gate).toBe('PASS');
  });

  it('returns ep_est, ep_act from items.jsonl', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.ep_est).toBe(3);
    expect(detail.ep_act).toBe(4);
  });

  it('returns tok_total and size_est from items.jsonl', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.tok_total).toBe(1500);
    expect(detail.size_est).toBe('M');
  });

  it('returns tok_est from items.jsonl when field is present, null otherwise', async () => {
    // Fixture ITEMS_LINES has no tok_est field → must be null (not the dispatch sum)
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.tok_est).toBeNull();
  });

  it('returns tok_est value from items.jsonl when the field exists', async () => {
    const itemsWithTokEst = [
      JSON.stringify({ id: 'S-116', ep_est: 3, ep_act: 4, tok_est: 9000, tok_total: 1500, size_est: 'M' }),
      JSON.stringify({ id: 'S-999', ep_est: 1, ep_act: 1, tok_total: 200, size_est: 'S' }),
    ].join('\n');
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ items: itemsWithTokEst }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.tok_est).toBe(9000);
  });

  it('filters dispatches to only the requested story (S-116, not S-999)', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    // S-999 dispatch is at 09:00 — must NOT influence started_at of S-116
    expect(detail.started_at).not.toBe('2025-01-10T09:00:00.000Z');
    expect(detail.flow.every((f) => f.agent !== 'other')).toBe(true);
  });

  it('computes ep deviation (ep_act - ep_est)', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    // ep_act=4, ep_est=3 → dev=1
    expect(detail.ep_dev).toBe(1);
    // dev_pct = (1/3)*100 ≈ 33.3
    expect(detail.ep_dev_pct).toBeCloseTo(33.3, 0);
  });
});

// ── AC1: Fehlende Metrik → null, kein Crash ───────────────────────────────────

describe('StoryMetricReader.getDetail — fehlende Metrik → null, kein Crash (AC1)', () => {
  it('returns null started_at/ended_at/duration when dispatches.jsonl is missing', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ dispatches: null }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.started_at).toBeNull();
    expect(detail.ended_at).toBeNull();
    expect(detail.duration).toBeNull();
  });

  it('returns empty flow when dispatches.jsonl is missing', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ dispatches: null }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.flow).toEqual([]);
  });

  it('returns null ep_est/ep_act/tok_total/size_est when items.jsonl is missing', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ items: null }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.ep_est).toBeNull();
    expect(detail.ep_act).toBeNull();
    expect(detail.tok_total).toBeNull();
    expect(detail.size_est).toBeNull();
  });

  it('returns null deviations when items.jsonl is missing', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ items: null }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.ep_dev).toBeNull();
    expect(detail.ep_dev_pct).toBeNull();
    expect(detail.tok_dev).toBeNull();
    expect(detail.tok_dev_pct).toBeNull();
  });

  it('returns all-null detail when both files are missing — no crash', async () => {
    const reader = new StoryMetricReader({
      fsDeps: makeFsDeps({ dispatches: null, items: null }),
    });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    // Must not throw; all metric fields null
    expect(detail.started_at).toBeNull();
    expect(detail.ended_at).toBeNull();
    expect(detail.duration).toBeNull();
    expect(detail.flow).toEqual([]);
    expect(detail.ep_est).toBeNull();
    expect(detail.ep_act).toBeNull();
    expect(detail.tok_total).toBeNull();
    expect(detail.size_est).toBeNull();
    expect(detail.ep_dev).toBeNull();
  });

  it('returns null ep fields when story not found in items.jsonl', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-UNKNOWN');
    expect(detail.ep_est).toBeNull();
    expect(detail.ep_act).toBeNull();
  });

  it('returns null started_at when story has no dispatches', async () => {
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps() });
    const detail = await reader.getDetail(REPO_PATH, 'S-UNKNOWN');
    expect(detail.started_at).toBeNull();
    expect(detail.flow).toEqual([]);
  });

  it('handles dispatches with missing ts fields gracefully', async () => {
    const dispatches = JSON.stringify({ agent: 'coder', seq: 1, item: 'S-116' }); // no ts
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ dispatches }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    // ts missing → timestamps filtered out → null times
    expect(detail.started_at).toBeNull();
    expect(detail.ended_at).toBeNull();
    // flow still has the entry
    expect(detail.flow).toHaveLength(1);
    expect(detail.flow[0].agent).toBe('coder');
  });

  it('handles corrupted JSONL lines without crashing', async () => {
    const dispatches = [
      'NOTJSON',
      JSON.stringify({ ts: '2025-01-01T00:00:00.000Z', agent: 'coder', seq: 1, item: 'S-116', tok: 100 }),
    ].join('\n');
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ dispatches }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.flow).toHaveLength(1);
    expect(detail.started_at).toBe('2025-01-01T00:00:00.000Z');
  });
});

// ── AC1: Flow order ────────────────────────────────────────────────────────────

describe('StoryMetricReader.getDetail — flow seq order', () => {
  it('flow entries are sorted ascending by seq even when dispatches are unordered', async () => {
    const dispatches = [
      JSON.stringify({ ts: '2025-01-10T10:00:00.000Z', agent: 'reviewer', seq: 3, iter: 2, gate: 'PASS', secs: 60, tok: 400, item: 'S-116' }),
      JSON.stringify({ ts: '2025-01-10T09:55:00.000Z', agent: 'coder',    seq: 1, iter: 1, gate: null,   secs: 120, tok: 800, item: 'S-116' }),
      JSON.stringify({ ts: '2025-01-10T09:58:00.000Z', agent: 'coder',    seq: 2, iter: 2, gate: null,   secs: 90, tok: 600, item: 'S-116' }),
    ].join('\n');

    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ dispatches }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');

    expect(detail.flow.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(detail.flow.map((f) => f.agent)).toEqual(['coder', 'coder', 'reviewer']);
  });
});

// ── AC2 (story-detail-yaml-fallback): matchesStoryId ─────────────────────────

describe('matchesStoryId — AC2: int/string-tolerantes ID-Matching', () => {
  // String-Gleichheit
  it('matches same string "S-165"', () => {
    expect(matchesStoryId('S-165', 'S-165')).toBe(true);
  });

  it('does not match different strings "S-165" vs "S-166"', () => {
    expect(matchesStoryId('S-165', 'S-166')).toBe(false);
  });

  // Numerische Gleichheit: integer item gegen "S-N" storyId
  it('matches integer 165 against "S-165" (old integer ledger format)', () => {
    expect(matchesStoryId(165, 'S-165')).toBe(true);
  });

  it('matches integer 108 against "S-108"', () => {
    expect(matchesStoryId(108, 'S-108')).toBe(true);
  });

  it('matches integer 1 against "S-001" (leading-zero strip)', () => {
    expect(matchesStoryId(1, 'S-001')).toBe(true);
  });

  it('does not match integer 165 against "S-166"', () => {
    expect(matchesStoryId(165, 'S-166')).toBe(false);
  });

  it('matches bare numeric string "165" against "S-165"', () => {
    expect(matchesStoryId('165', 'S-165')).toBe(true);
  });

  // Null/Undefined-Robustheit
  it('returns false for null item', () => {
    expect(matchesStoryId(null, 'S-165')).toBe(false);
  });

  it('returns false for undefined item', () => {
    expect(matchesStoryId(undefined, 'S-165')).toBe(false);
  });

  it('returns false for non-numeric string "foo" against "S-165"', () => {
    expect(matchesStoryId('foo', 'S-165')).toBe(false);
  });
});

// ── AC2 Integration: getDetail mit Integer-item-Zeilen ───────────────────────

describe('StoryMetricReader.getDetail — AC2 int/string integration', () => {
  it('finds dispatch with integer item 116 when querying "S-116"', async () => {
    const dispatchLine = JSON.stringify({
      item: 116, ts: '2025-01-10T10:00:00.000Z', seq: 1, agent: 'coder', iter: 1, gate: null, secs: 60, tok: null,
    });
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ dispatches: dispatchLine, items: '' }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.started_at).not.toBeNull();
    expect(detail.flow).toHaveLength(1);
    expect(detail.flow[0].agent).toBe('coder');
  });

  it('finds items.jsonl row with integer id 116 when querying "S-116"', async () => {
    const itemLine = JSON.stringify({ id: 116, ep_est: 5, ep_act: 6, tok_total: 2000, size_est: 'L' });
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ dispatches: '', items: itemLine }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.ep_est).toBe(5);
    expect(detail.ep_act).toBe(6);
    expect(detail.tok_total).toBe(2000);
  });

  it('does NOT match dispatches with integer 117 when querying "S-116"', async () => {
    const dispatchLine = JSON.stringify({
      item: 117, ts: '2025-01-10T10:00:00.000Z', seq: 1, agent: 'coder', iter: 1, gate: null, secs: 60, tok: null,
    });
    const reader = new StoryMetricReader({ fsDeps: makeFsDeps({ dispatches: dispatchLine, items: '' }) });
    const detail = await reader.getDetail(REPO_PATH, 'S-116');
    expect(detail.started_at).toBeNull();
    expect(detail.flow).toHaveLength(0);
  });
});
