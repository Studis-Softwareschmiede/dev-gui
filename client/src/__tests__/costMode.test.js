/**
 * costMode.test.js — Unit tests for the shared cost-mode module.
 *
 * Covers (fabric-intake-dialog): AC2b, AC9
 *   AC2b — collapseToLine: multiline → single line; whitespace trimmed;
 *           no control characters in output; null/undefined handled.
 *   AC9  — costFlag: balanced → no flag; non-balanced cost-aware command → flag;
 *           non-cost-aware command → no flag regardless of mode.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { collapseToLine, costFlag, COST_MODES, COST_AWARE_COMMANDS } from '../costMode.js';

describe('collapseToLine — AC2b text normalisation', () => {
  it('returns empty string for empty input', () => {
    expect(collapseToLine('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(collapseToLine('   \n  \t  ')).toBe('');
  });

  it('trims leading and trailing whitespace', () => {
    expect(collapseToLine('  hello  ')).toBe('hello');
  });

  it('collapses newlines to single spaces', () => {
    expect(collapseToLine('line1\nline2\nline3')).toBe('line1 line2 line3');
  });

  it('collapses carriage returns + newlines (\\r\\n) to single spaces', () => {
    expect(collapseToLine('line1\r\nline2\r\nline3')).toBe('line1 line2 line3');
  });

  it('collapses tab characters to single spaces', () => {
    expect(collapseToLine('word1\tword2\tword3')).toBe('word1 word2 word3');
  });

  it('collapses multiple consecutive whitespace to a single space', () => {
    expect(collapseToLine('hello    world')).toBe('hello world');
  });

  it('collapses mixed whitespace (spaces, tabs, newlines) to single spaces', () => {
    const input = '  Hallo   Welt\r\nNoch eine Zeile\t\tTabulator  ';
    expect(collapseToLine(input)).toBe('Hallo Welt Noch eine Zeile Tabulator');
  });

  it('does not contain newlines in the output', () => {
    const result = collapseToLine('a\nb\nc');
    expect(result).not.toMatch(/\n|\r/);
  });

  it('does not contain tab characters in the output', () => {
    const result = collapseToLine('a\tb\tc');
    expect(result).not.toMatch(/\t/);
  });

  it('handles null/undefined gracefully', () => {
    expect(collapseToLine(null)).toBe('');
    expect(collapseToLine(undefined)).toBe('');
  });

  it('returns unchanged single-line text (no collapse needed)', () => {
    expect(collapseToLine('This is a single line')).toBe('This is a single line');
  });
});

describe('costFlag — AC9 cost flag composition', () => {
  it('returns "" for balanced (default — no flag emitted)', () => {
    expect(costFlag('/agent-flow:requirement', 'balanced')).toBe('');
    expect(costFlag('/agent-flow:flow', 'balanced')).toBe('');
    expect(costFlag('/agent-flow:train', 'balanced')).toBe('');
  });

  it('returns "" for undefined/empty cost mode (treated as balanced)', () => {
    expect(costFlag('/agent-flow:requirement', '')).toBe('');
    expect(costFlag('/agent-flow:requirement', undefined)).toBe('');
  });

  it('returns " --cost low-cost" for low-cost on cost-aware command', () => {
    expect(costFlag('/agent-flow:requirement', 'low-cost')).toBe(' --cost low-cost');
  });

  it('returns " --cost max-quality" for max-quality on cost-aware command', () => {
    expect(costFlag('/agent-flow:requirement', 'max-quality')).toBe(' --cost max-quality');
  });

  it('returns " --cost frontier" for frontier on cost-aware command', () => {
    expect(costFlag('/agent-flow:requirement', 'frontier')).toBe(' --cost frontier');
  });

  it('returns "" for non-cost-aware commands regardless of mode', () => {
    expect(costFlag('/agent-flow:new-project', 'frontier')).toBe('');
    expect(costFlag('/agent-flow:adopt', 'max-quality')).toBe('');
    expect(costFlag('/agent-flow:preview', 'low-cost')).toBe('');
  });
});

describe('COST_MODES and COST_AWARE_COMMANDS exports', () => {
  it('exports 4 cost modes', () => {
    expect(COST_MODES).toHaveLength(4);
    expect(COST_MODES).toContain('balanced');
    expect(COST_MODES).toContain('low-cost');
    expect(COST_MODES).toContain('max-quality');
    expect(COST_MODES).toContain('frontier');
  });

  it('exports requirement and flow as cost-aware', () => {
    expect(COST_AWARE_COMMANDS).toContain('/agent-flow:requirement');
    expect(COST_AWARE_COMMANDS).toContain('/agent-flow:flow');
    expect(COST_AWARE_COMMANDS).toContain('/agent-flow:train');
  });
});
