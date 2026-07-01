/**
 * @file IdeaSpecifyFinalizer.test.js — Unit tests for the headless
 * `requirement`-Finalizer orchestrator (docs/specs/idea-specify-chat.md
 * AC6, AC7, AC8, AC9).
 *
 * Covers (idea-specify-chat): AC6, AC7, AC8, AC9
 *
 *   AC6 — `start(projectPath, { draftText, ideaStoryId, projectSlug })` calls
 *         the (wrapped) `HeadlessFlowRunner` with `{ command: '/agent-flow:requirement',
 *         args: [buildRequirementPrompt(...)] }` and propagates its
 *         `{ ok, jobId }` / `{ ok:false, reason:'locked' }` result unchanged.
 *         Lock-Trennung: the Finalizer's DEFAULT construction path (no `runner`
 *         injected) uses its OWN, independent `ProjectJobLock` instance — an
 *         unrelated `HeadlessFlowRunner` (e.g. Nacht-Drain) holding the lock for
 *         the SAME project path does NOT block it, and vice versa.
 *   AC7 — `getJob(jobId)` reads the underlying runner's job-registry entry;
 *         unknown jobId → `undefined`.
 *   AC8 — `buildRequirementPrompt()`: appends EXACTLY the two hints (a)/(b)
 *         after `draftText`, in order; graceful with missing/empty `draftText`.
 *   AC9 — Sicherheitsnetz: after the FIRST observation of `status: 'done'`,
 *         `BoardWriter.archiveSupersededIdea({ projectSlug, storyId })` is
 *         called exactly once; a `not-resolvable` `BoardWriterError` (agent
 *         already handled the idea itself) is swallowed as an expected no-op;
 *         any other error is swallowed best-effort (no crash); a still-`running`
 *         job never triggers the safety net; polling `getJob()` again after
 *         `done` does NOT re-trigger it.
 *
 * Pattern: injected `runner` stub (no real `HeadlessFlowRunner`/`claude -p` run)
 * for AC7/AC9; a REAL `HeadlessFlowRunner` with a fake `spawnFn` (pattern from
 * `HeadlessFlowRunner.test.js`) for the AC6 Lock-Trennung tests, so the actual
 * default-construction path (own `ProjectJobLock`) is genuinely exercised
 * without spawning a real `claude` process.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { HeadlessFlowRunner } from '../src/HeadlessFlowRunner.js';
import { BoardWriterError } from '../src/BoardWriter.js';
import { IdeaSpecifyFinalizer, buildRequirementPrompt, REQUIREMENT_COMMAND } from '../src/IdeaSpecifyFinalizer.js';

/** Fake child process — EventEmitter with stdout/stderr sub-emitters + a kill() spy (never closes). */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function fakeBoardWriter(archiveSupersededIdea = jest.fn().mockResolvedValue({ filePath: '/x' })) {
  return { archiveSupersededIdea };
}

// ── AC8: buildRequirementPrompt (pure) ───────────────────────────────────────

describe('buildRequirementPrompt — AC8: exactly two appended hints', () => {
  it('appends both hints after draftText, in order (a) no-questions, (b) reuse-idea', () => {
    const prompt = buildRequirementPrompt({ draftText: 'Build a dark-mode toggle.', ideaStoryId: 'S-900' });

    const draftIdx = prompt.indexOf('Build a dark-mode toggle.');
    const hintAIdx = prompt.indexOf('bitte nicht nachfragen');
    const hintBIdx = prompt.indexOf('Platzhalter-Idee S-900');

    expect(draftIdx).toBeGreaterThanOrEqual(0);
    expect(hintAIdx).toBeGreaterThan(draftIdx);
    expect(hintBIdx).toBeGreaterThan(hintAIdx);
    expect(prompt).toContain('board/stories/');
  });

  it('handles missing draftText gracefully (still includes both hints, no leading blank noise)', () => {
    const prompt = buildRequirementPrompt({ draftText: undefined, ideaStoryId: 'S-1' });
    expect(prompt).toContain('bitte nicht nachfragen');
    expect(prompt).toContain('Platzhalter-Idee S-1');
    expect(prompt.startsWith('\n')).toBe(false);
  });

  it('trims draftText whitespace', () => {
    const prompt = buildRequirementPrompt({ draftText: '   Some draft.   ', ideaStoryId: 'S-2' });
    expect(prompt.startsWith('Some draft.')).toBe(true);
  });
});

// ── AC6/AC8: start() wiring ───────────────────────────────────────────────────

describe('IdeaSpecifyFinalizer — AC6/AC8: start() wiring', () => {
  it('calls runner.start(projectPath, { command: REQUIREMENT_COMMAND, args: [prompt] })', () => {
    const runner = { start: jest.fn(() => ({ ok: true, jobId: 'job-1' })), getJob: jest.fn() };
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter() });

    const result = finalizer.start('/workspace/proj', {
      draftText: 'Build dark mode.',
      ideaStoryId: 'S-900',
      projectSlug: 'demo',
    });

    expect(result).toEqual({ ok: true, jobId: 'job-1' });
    expect(runner.start).toHaveBeenCalledTimes(1);
    const [path, overrides] = runner.start.mock.calls[0];
    expect(path).toBe('/workspace/proj');
    expect(overrides.command).toBe(REQUIREMENT_COMMAND);
    expect(overrides.args).toHaveLength(1);
    expect(overrides.args[0]).toContain('Build dark mode.');
    expect(overrides.args[0]).toContain('S-900');
  });

  it('propagates a locked result from the runner unchanged', () => {
    const runner = { start: jest.fn(() => ({ ok: false, reason: 'locked' })), getJob: jest.fn() };
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter() });

    const result = finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-1', projectSlug: 'demo' });
    expect(result).toEqual({ ok: false, reason: 'locked' });
  });
});

// ── AC6: Lock-Trennung (real HeadlessFlowRunner + fake spawnFn) ──────────────

describe('IdeaSpecifyFinalizer — AC6: Lock-Trennung (own ProjectJobLock, not shared with other headless boundaries)', () => {
  it('an unrelated HeadlessFlowRunner holding the lock for the SAME project path does NOT block the Finalizer', () => {
    const spawnFn = jest.fn(() => makeFakeChild());

    // Simulates an already-running OTHER headless boundary (e.g. the Nacht-Drain's
    // own `headlessFlowRunner` in server.js) holding the lock for this project.
    const otherRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
    expect(otherRunner.start('/workspace/shared-project').ok).toBe(true);

    // Finalizer's OWN default construction path (no `runner`/`lock` injected) —
    // must use its OWN, independent ProjectJobLock instance.
    const finalizer = new IdeaSpecifyFinalizer({ spawnFn, timeoutMs: 10_000, boardWriter: fakeBoardWriter() });

    const result = finalizer.start('/workspace/shared-project', {
      draftText: 'd',
      ideaStoryId: 'S-1',
      projectSlug: 'demo',
    });
    expect(result.ok).toBe(true);
  });

  it('the Finalizer holding a lock does NOT block an unrelated HeadlessFlowRunner for the SAME project path', () => {
    const spawnFn = jest.fn(() => makeFakeChild());

    const finalizer = new IdeaSpecifyFinalizer({ spawnFn, timeoutMs: 10_000, boardWriter: fakeBoardWriter() });
    expect(finalizer.start('/workspace/shared-project-2', { draftText: 'd', ideaStoryId: 'S-1', projectSlug: 'demo' }).ok).toBe(true);

    const otherRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
    expect(otherRunner.start('/workspace/shared-project-2').ok).toBe(true);
  });

  it('the Finalizer\'s own lock DOES block a second finalize start() for the SAME project path', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const finalizer = new IdeaSpecifyFinalizer({ spawnFn, timeoutMs: 10_000, boardWriter: fakeBoardWriter() });

    const first = finalizer.start('/workspace/proj-dup', { draftText: 'd', ideaStoryId: 'S-1', projectSlug: 'demo' });
    expect(first.ok).toBe(true);

    const second = finalizer.start('/workspace/proj-dup', { draftText: 'd', ideaStoryId: 'S-2', projectSlug: 'demo' });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('locked');
  });
});

// ── AC7: getJob() ─────────────────────────────────────────────────────────────

describe('IdeaSpecifyFinalizer — AC7: getJob() reads the underlying runner registry', () => {
  it('returns undefined for an unknown jobId', async () => {
    const runner = { start: jest.fn(), getJob: jest.fn(() => undefined) };
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter() });
    await expect(finalizer.getJob('unknown-job-id')).resolves.toBeUndefined();
  });

  it('returns the running job unchanged (no safety net for a non-done job)', async () => {
    const archiveSupersededIdea = jest.fn();
    const runner = { start: jest.fn(() => ({ ok: true, jobId: 'job-1' })), getJob: jest.fn(() => ({ status: 'running' })) };
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea) });

    await expect(finalizer.getJob('job-1')).resolves.toEqual({ status: 'running' });
    expect(archiveSupersededIdea).not.toHaveBeenCalled();
  });

  it('returns a failed/auth-expired job unchanged (no safety net for a non-done terminal status)', async () => {
    const archiveSupersededIdea = jest.fn();
    const runner = { getJob: jest.fn(() => ({ status: 'failed', error: 'Flow-Lauf fehlgeschlagen' })) };
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea) });

    await expect(finalizer.getJob('job-1')).resolves.toEqual({ status: 'failed', error: 'Flow-Lauf fehlgeschlagen' });
    expect(archiveSupersededIdea).not.toHaveBeenCalled();
  });
});

// ── AC9: Sicherheitsnetz ──────────────────────────────────────────────────────

describe('IdeaSpecifyFinalizer — AC9: Sicherheitsnetz nach Job-Status "done"', () => {
  function makeDoneRunner(jobId = 'job-42') {
    return { start: jest.fn(() => ({ ok: true, jobId })), getJob: jest.fn(() => ({ status: 'done', result: 'Flow abgeschlossen' })) };
  }

  it('calls archiveSupersededIdea({ projectSlug, storyId }) exactly once when the job is first observed done', async () => {
    const archiveSupersededIdea = jest.fn().mockResolvedValue({ filePath: '/x/board/stories/S-900.yaml' });
    const runner = makeDoneRunner();
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea) });

    const started = finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    expect(started.ok).toBe(true);

    const job = await finalizer.getJob(started.jobId);
    expect(job.status).toBe('done');
    expect(archiveSupersededIdea).toHaveBeenCalledTimes(1);
    expect(archiveSupersededIdea).toHaveBeenCalledWith({ projectSlug: 'demo', storyId: 'S-900' });

    // Polling again after "done" must NOT re-trigger the safety net.
    await finalizer.getJob(started.jobId);
    expect(archiveSupersededIdea).toHaveBeenCalledTimes(1);
  });

  it('a "not-resolvable" BoardWriterError (agent already handled the idea) is swallowed as a no-op', async () => {
    const archiveSupersededIdea = jest.fn().mockRejectedValue(new BoardWriterError('nicht mehr archivierbar', 'not-resolvable'));
    const runner = makeDoneRunner();
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea) });

    const started = finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    await expect(finalizer.getJob(started.jobId)).resolves.toEqual(expect.objectContaining({ status: 'done' }));
    expect(archiveSupersededIdea).toHaveBeenCalledTimes(1);
  });

  it('any other archiveSupersededIdea() error is swallowed best-effort — getJob still resolves, no crash', async () => {
    const archiveSupersededIdea = jest.fn().mockRejectedValue(new Error('disk full'));
    const runner = makeDoneRunner();
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea) });

    const started = finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    await expect(finalizer.getJob(started.jobId)).resolves.toEqual(expect.objectContaining({ status: 'done' }));
  });

  it('missing job-meta (jobId not started via this Finalizer instance) → safety net is a silent no-op', async () => {
    const archiveSupersededIdea = jest.fn();
    const runner = { getJob: jest.fn(() => ({ status: 'done', result: 'ok' })) };
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea) });

    await expect(finalizer.getJob('some-job-never-started-here')).resolves.toEqual(expect.objectContaining({ status: 'done' }));
    expect(archiveSupersededIdea).not.toHaveBeenCalled();
  });
});
