/**
 * @file StorySpecifyFinalizer.test.js — Unit tests for the „from scratch"
 * headless `requirement`-Finalizer (docs/specs/new-story-chat.md AC4, AC5, AC8).
 *
 * Covers (new-story-chat): AC4, AC5, AC8
 *
 *   AC8 — `buildRequirementPrompt({ draftText })` appends EXACTLY ONE hint
 *         (the „nicht-nachfragen" hint) after `draftText` — and NO idea-reuse
 *         hint (no `Platzhalter-Idee`, no `board/stories/` reference); graceful
 *         with missing/empty `draftText`.
 *   AC4 — `start(projectPath, { draftText })` calls the (wrapped)
 *         `HeadlessFlowRunner` with `{ command: '/agent-flow:requirement',
 *         args: [buildRequirementPrompt(...)] }` and propagates its
 *         `{ ok, jobId }` / `{ ok:false, reason:'locked' }` result unchanged.
 *         Lock-Trennung: the DEFAULT construction path (no `runner` injected)
 *         uses its OWN, independent `ProjectJobLock` instance — an unrelated
 *         `HeadlessFlowRunner` holding the lock for the SAME project path does
 *         NOT block it, and vice versa.
 *   AC5 — `getJob(jobId)` reads the underlying runner's job-registry entry 1:1
 *         (no safety net, no `no-op` mapping); unknown jobId → `undefined`.
 *
 * Pattern: injected `runner` stub for the wiring/getJob tests; a REAL
 * `HeadlessFlowRunner` with a fake `spawnFn` (pattern from
 * `HeadlessFlowRunner.test.js`/`IdeaSpecifyFinalizer.test.js`) for the AC4
 * Lock-Trennung test, so the actual default-construction path (own
 * `ProjectJobLock`) is genuinely exercised without spawning a real `claude`
 * process.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { ProjectJobLock } from '../src/ProjectJobLock.js';
import {
  StorySpecifyFinalizer,
  buildRequirementPrompt,
  REQUIREMENT_COMMAND,
} from '../src/StorySpecifyFinalizer.js';

/** Fake child process — EventEmitter with stdout/stderr sub-emitters + a kill() spy (never closes). */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

// ── AC8: buildRequirementPrompt (pure) ───────────────────────────────────────

describe('buildRequirementPrompt — AC8: exactly ONE appended hint, no idea reference', () => {
  it('appends the no-questions hint after draftText — and NOTHING idea-specific', () => {
    const prompt = buildRequirementPrompt({ draftText: 'Build a dark-mode toggle.' });

    const draftIdx = prompt.indexOf('Build a dark-mode toggle.');
    const hintIdx = prompt.indexOf('bitte nicht nachfragen');

    expect(draftIdx).toBe(0);
    expect(hintIdx).toBeGreaterThan(draftIdx);
    // AC8: KEIN Idee-Bezug — kein Platzhalter-Idee-Hinweis, kein board/stories/-Verweis.
    expect(prompt).not.toContain('Platzhalter-Idee');
    expect(prompt).not.toContain('board/stories/');
    expect(prompt).not.toMatch(/S-\d+/);
  });

  it('handles missing draftText gracefully (still includes the hint, no leading blank noise)', () => {
    const prompt = buildRequirementPrompt({ draftText: undefined });
    expect(prompt).toContain('bitte nicht nachfragen');
    expect(prompt.startsWith('\n')).toBe(false);
    expect(prompt).not.toContain('Platzhalter-Idee');
  });

  it('trims draftText whitespace', () => {
    const prompt = buildRequirementPrompt({ draftText: '   Some draft.   ' });
    expect(prompt.startsWith('Some draft.')).toBe(true);
  });
});

// ── AC4: start() wiring ───────────────────────────────────────────────────────

describe('StorySpecifyFinalizer — AC4: start() wiring', () => {
  it('calls runner.start(projectPath, { command: REQUIREMENT_COMMAND, args: [prompt] })', () => {
    const runner = { start: jest.fn(() => ({ ok: true, jobId: 'job-1' })), getJob: jest.fn() };
    const finalizer = new StorySpecifyFinalizer({ runner });

    const result = finalizer.start('/workspace/proj', { draftText: 'Build dark mode.' });

    expect(result).toEqual({ ok: true, jobId: 'job-1' });
    expect(runner.start).toHaveBeenCalledTimes(1);
    const [projectPath, overrides] = runner.start.mock.calls[0];
    expect(projectPath).toBe('/workspace/proj');
    expect(overrides.command).toBe(REQUIREMENT_COMMAND);
    expect(Array.isArray(overrides.args)).toBe(true);
    expect(overrides.args).toHaveLength(1);
    expect(overrides.args[0]).toBe(buildRequirementPrompt({ draftText: 'Build dark mode.' }));
  });

  it('propagates a { ok:false, reason:"locked" } result unchanged', () => {
    const runner = { start: jest.fn(() => ({ ok: false, reason: 'locked' })), getJob: jest.fn() };
    const finalizer = new StorySpecifyFinalizer({ runner });

    const result = finalizer.start('/workspace/proj', { draftText: 'x' });
    expect(result).toEqual({ ok: false, reason: 'locked' });
  });

  it('AC4 Lock-Trennung: DEFAULT path uses its OWN ProjectJobLock — a foreign lock on the same path does NOT block it', () => {
    // Real HeadlessFlowRunner via the default construction path, with a fake
    // spawnFn (never closes) — exercises the genuine `new ProjectJobLock()`.
    const spawnFn = jest.fn(() => makeFakeChild());
    const finalizer = new StorySpecifyFinalizer({ spawnFn });

    const projectPath = '/workspace/shared';

    // A foreign runner (e.g. Nacht-Drain / ideaSpecifyFinalizer) holds ITS lock
    // for the SAME project path.
    const foreignLock = new ProjectJobLock();
    expect(foreignLock.tryAcquire(projectPath)).toBe(true);

    // The StorySpecifyFinalizer must still be able to start (own, independent lock).
    const result = finalizer.start(projectPath, { draftText: 'from scratch' });
    expect(result.ok).toBe(true);
    expect(typeof result.jobId).toBe('string');
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('AC4 Doppelstart fürs selbe Projekt: der EIGENE ProjectJobLock weist den zweiten Start ab (locked)', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const finalizer = new StorySpecifyFinalizer({ spawnFn });
    const projectPath = '/workspace/proj';

    const first = finalizer.start(projectPath, { draftText: 'a' });
    expect(first.ok).toBe(true);

    // Zweiter Start fürs selbe Projekt, während der erste (fake) Prozess noch läuft.
    const second = finalizer.start(projectPath, { draftText: 'b' });
    expect(second).toEqual({ ok: false, reason: 'locked' });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

// ── AC5: getJob() passthrough (no safety net, no no-op) ───────────────────────

describe('StorySpecifyFinalizer — AC5: getJob() 1:1 passthrough', () => {
  it('returns the runner job unchanged for each terminal status (no no-op mapping)', () => {
    const jobs = new Map([
      ['j-run', { status: 'running' }],
      ['j-done', { status: 'done', result: 'Flow abgeschlossen' }],
      ['j-fail', { status: 'failed', error: 'Flow-Lauf fehlgeschlagen' }],
      ['j-auth', { status: 'auth-expired', error: 'Auth abgelaufen' }],
    ]);
    const runner = { start: jest.fn(), getJob: jest.fn((id) => jobs.get(id)) };
    const finalizer = new StorySpecifyFinalizer({ runner });

    expect(finalizer.getJob('j-run')).toEqual({ status: 'running' });
    expect(finalizer.getJob('j-done')).toEqual({ status: 'done', result: 'Flow abgeschlossen' });
    expect(finalizer.getJob('j-fail')).toEqual({ status: 'failed', error: 'Flow-Lauf fehlgeschlagen' });
    expect(finalizer.getJob('j-auth')).toEqual({ status: 'auth-expired', error: 'Auth abgelaufen' });
  });

  it('returns undefined for an unknown jobId', () => {
    const runner = { start: jest.fn(), getJob: jest.fn(() => undefined) };
    const finalizer = new StorySpecifyFinalizer({ runner });
    expect(finalizer.getJob('nope')).toBeUndefined();
  });
});
