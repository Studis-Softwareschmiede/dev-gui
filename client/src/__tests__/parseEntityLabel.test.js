/**
 * parseEntityLabel.test.js — Unit tests for parseEntityLabel helper.
 *
 * Covers (team-entity-icons, Etappe 3):
 *   AC12 — Label-Parsing: agent:<id> → {kind:'agent',id}; skill → skill;
 *           knowledge → knowledge; no entity label → null; precedence (first
 *           matching label wins); robust split (id may contain ':'); empty/null
 *           labels do not crash.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { parseEntityLabel }     from '../icons/parseEntityLabel.js';

// ── Basic kind parsing ────────────────────────────────────────────────────────

describe('parseEntityLabel — basic kind/id extraction', () => {
  it('parses "agent:coder" → {kind:"agent", id:"coder"}', () => {
    expect(parseEntityLabel(['agent:coder'])).toEqual({ kind: 'agent', id: 'coder' });
  });

  it('parses "skill:flow" → {kind:"skill", id:"flow"}', () => {
    expect(parseEntityLabel(['skill:flow'])).toEqual({ kind: 'skill', id: 'flow' });
  });

  it('parses "knowledge:js" → {kind:"knowledge", id:"js"}', () => {
    expect(parseEntityLabel(['knowledge:js'])).toEqual({ kind: 'knowledge', id: 'js' });
  });

  it('parses "agent:reviewer" → {kind:"agent", id:"reviewer"}', () => {
    expect(parseEntityLabel(['agent:reviewer'])).toEqual({ kind: 'agent', id: 'reviewer' });
  });
});

// ── No match → null ───────────────────────────────────────────────────────────

describe('parseEntityLabel — no entity label → null', () => {
  it('returns null for an empty array', () => {
    expect(parseEntityLabel([])).toBeNull();
  });

  it('returns null when no label has an entity kind', () => {
    expect(parseEntityLabel(['frontend', 'auth', 'ci'])).toBeNull();
  });

  it('returns null when labels is null', () => {
    expect(parseEntityLabel(null)).toBeNull();
  });

  it('returns null when labels is undefined', () => {
    expect(parseEntityLabel(undefined)).toBeNull();
  });

  it('returns null when labels is not an array (e.g. a string)', () => {
    expect(parseEntityLabel('agent:coder')).toBeNull();
  });
});

// ── Precedence: first matching label wins ────────────────────────────────────

describe('parseEntityLabel — precedence (first matching label)', () => {
  it('when first label matches, returns it (ignores later matching labels)', () => {
    const result = parseEntityLabel(['agent:coder', 'skill:flow']);
    expect(result).toEqual({ kind: 'agent', id: 'coder' });
  });

  it('when first label does not match, returns the first that does', () => {
    const result = parseEntityLabel(['frontend', 'skill:flow', 'agent:coder']);
    expect(result).toEqual({ kind: 'skill', id: 'flow' });
  });

  it('skips non-entity labels until a match is found', () => {
    const result = parseEntityLabel(['ci', 'devops', 'knowledge:spring-boot']);
    expect(result).toEqual({ kind: 'knowledge', id: 'spring-boot' });
  });
});

// ── Robust split: id may contain ':' ────────────────────────────────────────

describe('parseEntityLabel — robust split (id may contain colons)', () => {
  it('splits only at the FIRST colon — id may contain further colons', () => {
    expect(parseEntityLabel(['knowledge:frameworks:spring-boot-3']))
      .toEqual({ kind: 'knowledge', id: 'frameworks:spring-boot-3' });
  });

  it('handles "agent:team:lead" — id is "team:lead"', () => {
    expect(parseEntityLabel(['agent:team:lead']))
      .toEqual({ kind: 'agent', id: 'team:lead' });
  });
});

// ── Edge cases: broken/empty labels ─────────────────────────────────────────

describe('parseEntityLabel — edge cases (broken/empty labels)', () => {
  it('skips labels that are empty strings', () => {
    expect(parseEntityLabel(['', 'agent:coder'])).toEqual({ kind: 'agent', id: 'coder' });
  });

  it('skips labels with no colon at all', () => {
    expect(parseEntityLabel(['agentcoder', 'skill:test'])).toEqual({ kind: 'skill', id: 'test' });
  });

  it('skips label where colon is the first character (":agent")', () => {
    expect(parseEntityLabel([':agent', 'agent:coder'])).toEqual({ kind: 'agent', id: 'coder' });
  });

  it('skips "agent:" (empty id after colon)', () => {
    expect(parseEntityLabel(['agent:', 'skill:flow'])).toEqual({ kind: 'skill', id: 'flow' });
  });

  it('skips "agent:" alone → null', () => {
    expect(parseEntityLabel(['agent:'])).toBeNull();
  });

  it('skips non-string entries in the array without crashing', () => {
    expect(parseEntityLabel([42, null, 'agent:coder'])).toEqual({ kind: 'agent', id: 'coder' });
  });

  it('skips label with unknown kind even if it has a colon', () => {
    expect(parseEntityLabel(['feature:login', 'agent:coder'])).toEqual({ kind: 'agent', id: 'coder' });
  });

  it('returns null for ["feature:login"] (unknown kind)', () => {
    expect(parseEntityLabel(['feature:login'])).toBeNull();
  });
});
