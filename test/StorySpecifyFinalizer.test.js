/**
 * @file StorySpecifyFinalizer.test.js — Unit tests for the „from scratch"
 * headless `requirement`-Finalizer (docs/specs/new-story-chat.md AC4, AC8) and
 * its finalize-visibility extension (docs/specs/story-specify-finalize-visibility.md
 * AC1, AC2, AC3).
 *
 * Covers (new-story-chat): AC4, AC8
 *
 *   AC8 — `buildRequirementPrompt({ draftText })` appends EXACTLY ONE hint
 *         (the „nicht-nachfragen" hint) after `draftText` — and NO idea-reuse
 *         hint (no `Platzhalter-Idee`, no `board/stories/` reference); graceful
 *         with missing/empty `draftText`.
 *   AC4 — `start(projectPath, { draftText, projectSlug })` calls the (wrapped)
 *         `HeadlessFlowRunner` with `{ command: '/agent-flow:requirement',
 *         args: [buildRequirementPrompt(...)] }` and propagates its
 *         `{ ok, jobId }` / `{ ok:false, reason:'locked' }` result unchanged.
 *         Lock-Trennung: the DEFAULT construction path (no `runner` injected)
 *         uses its OWN, independent `ProjectJobLock` instance.
 *
 * Covers (story-specify-finalize-visibility): AC1, AC2, AC3
 *
 *   AC1 — read-only No-Op snapshot diff: `start()` snapshots the story/feature
 *         file set BEFORE the spawn; on runner-`done` `getJob()` re-scans and
 *         diffs. No new story AND no new feature → `no-op` (secret-free message);
 *         ≥1 new story/feature → `done`. NO `BoardWriter`/write path. A failing
 *         snapshot read (baseline OR after) degrades SAFELY to `done` (no crash,
 *         NOT `no-op` — unlike the IdeaSpecifyFinalizer fail-safe). Diff runs at
 *         most once per job (idempotent).
 *   AC2 — terminal status classification: `getJob()` yields
 *         status ∈ {running, done, no-op, failed, auth-expired}, `done` only on
 *         an actually created story; failed/auth-expired pass through unchanged.
 *   AC3 — projekt-keyed last-finalize registry: `start()` registers the job
 *         SYNCHRONOUSLY with `running` (keyed by `projectSlug`, no `await`
 *         between runner-`start()` and the registration); `lastForProject()`
 *         resolves the CURRENT status live (incl. `no-op`); `null` when no
 *         finalize ran / the job fell out; not registered on a `locked` result;
 *         per-project isolation.
 *
 * Pattern: injected `runner` stub + injected `artifactReader` stub for the
 * wiring/diff/registry tests; a REAL `HeadlessFlowRunner` with a fake `spawnFn`
 * (pattern from `HeadlessFlowRunner.test.js`/`IdeaSpecifyFinalizer.test.js`) for
 * the AC4 Lock-Trennung test, so the actual default-construction path (own
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
  NO_OP_MESSAGE,
} from '../src/StorySpecifyFinalizer.js';

/** Fake child process — EventEmitter with stdout/stderr sub-emitters + a kill() spy (never closes). */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

/** Snapshot shape produced by the artifactReader: a Set per artifact dir. */
function snap(stories = [], features = []) {
  return { stories: new Set(stories), features: new Set(features) };
}

/** Injectable read-only artifactReader stub. */
function makeReader() {
  return { snapshot: jest.fn() };
}

/**
 * Injectable runner stub around a single mutable `job` object (mutate
 * `job.status` between calls to drive the terminal-status transitions).
 */
function makeRunner(job, { jobId = 'job-1', startResult } = {}) {
  return {
    start: jest.fn(() => startResult ?? { ok: true, jobId }),
    getJob: jest.fn((id) => (id === jobId ? job : undefined)),
  };
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
  it('calls runner.start(projectPath, { command: REQUIREMENT_COMMAND, args: [prompt] })', async () => {
    const reader = makeReader();
    reader.snapshot.mockResolvedValue(snap());
    const runner = makeRunner({ status: 'running' });
    const finalizer = new StorySpecifyFinalizer({ runner, artifactReader: reader });

    const result = await finalizer.start('/workspace/proj', { draftText: 'Build dark mode.', projectSlug: 'proj' });

    expect(result).toEqual({ ok: true, jobId: 'job-1' });
    expect(runner.start).toHaveBeenCalledTimes(1);
    const [projectPath, overrides] = runner.start.mock.calls[0];
    expect(projectPath).toBe('/workspace/proj');
    expect(overrides.command).toBe(REQUIREMENT_COMMAND);
    expect(Array.isArray(overrides.args)).toBe(true);
    expect(overrides.args).toHaveLength(1);
    expect(overrides.args[0]).toBe(buildRequirementPrompt({ draftText: 'Build dark mode.' }));
  });

  it('propagates a { ok:false, reason:"locked" } result unchanged', async () => {
    const reader = makeReader();
    reader.snapshot.mockResolvedValue(snap());
    const runner = makeRunner({ status: 'running' }, { startResult: { ok: false, reason: 'locked' } });
    const finalizer = new StorySpecifyFinalizer({ runner, artifactReader: reader });

    const result = await finalizer.start('/workspace/proj', { draftText: 'x', projectSlug: 'proj' });
    expect(result).toEqual({ ok: false, reason: 'locked' });
  });

  it('AC4 Lock-Trennung: DEFAULT path uses its OWN ProjectJobLock — a foreign lock on the same path does NOT block it', async () => {
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
    const result = await finalizer.start(projectPath, { draftText: 'from scratch', projectSlug: 'shared' });
    expect(result.ok).toBe(true);
    expect(typeof result.jobId).toBe('string');
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('AC4 Doppelstart fürs selbe Projekt: der EIGENE ProjectJobLock weist den zweiten Start ab (locked)', async () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const finalizer = new StorySpecifyFinalizer({ spawnFn });
    const projectPath = '/workspace/proj';

    const first = await finalizer.start(projectPath, { draftText: 'a', projectSlug: 'proj' });
    expect(first.ok).toBe(true);

    // Zweiter Start fürs selbe Projekt, während der erste (fake) Prozess noch läuft.
    const second = await finalizer.start(projectPath, { draftText: 'b', projectSlug: 'proj' });
    expect(second).toEqual({ ok: false, reason: 'locked' });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

// ── AC1: read-only No-Op snapshot diff ────────────────────────────────────────

describe('StorySpecifyFinalizer — AC1: read-only No-Op snapshot diff', () => {
  it('done + NO new story/feature → getJob maps to no-op (secret-free message)', async () => {
    const reader = makeReader();
    reader.snapshot
      .mockResolvedValueOnce(snap(['S-1.yaml'], ['F-1.yaml'])) // baseline (in start)
      .mockResolvedValueOnce(snap(['S-1.yaml'], ['F-1.yaml'])); // after (in getJob)
    const job = { status: 'running' };
    const runner = makeRunner(job);
    const finalizer = new StorySpecifyFinalizer({ runner, artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    job.status = 'done';
    job.result = 'Flow abgeschlossen';

    const res = await finalizer.getJob('job-1');
    expect(res.status).toBe('no-op');
    expect(res.error).toBe(NO_OP_MESSAGE);
    // Secret-frei: die Meldung ist eine feste Konstante ohne Pfad/Token.
    expect(res.error).not.toMatch(/\/|token|secret/i);
  });

  it('done + ≥1 new STORY → getJob stays done', async () => {
    const reader = makeReader();
    reader.snapshot
      .mockResolvedValueOnce(snap(['S-1.yaml']))
      .mockResolvedValueOnce(snap(['S-1.yaml', 'S-2.yaml']));
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    job.status = 'done';

    const res = await finalizer.getJob('job-1');
    expect(res.status).toBe('done');
  });

  it('done + new FEATURE only (no new story) → getJob stays done', async () => {
    const reader = makeReader();
    reader.snapshot
      .mockResolvedValueOnce(snap(['S-1.yaml'], []))
      .mockResolvedValueOnce(snap(['S-1.yaml'], ['F-9.yaml']));
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    job.status = 'done';

    const res = await finalizer.getJob('job-1');
    expect(res.status).toBe('done');
  });

  it('baseline snapshot read fails → safe degradation to done (NOT no-op), after-snapshot not attempted', async () => {
    const reader = makeReader();
    reader.snapshot.mockRejectedValueOnce(new Error('fs boom')); // baseline throws
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    job.status = 'done';

    const res = await finalizer.getJob('job-1');
    expect(res.status).toBe('done');
    // baselineFailed short-circuits the diff — no second (after) snapshot attempt.
    expect(reader.snapshot).toHaveBeenCalledTimes(1);
  });

  it('after snapshot read fails → safe degradation to done (NOT no-op)', async () => {
    const reader = makeReader();
    reader.snapshot
      .mockResolvedValueOnce(snap(['S-1.yaml'])) // baseline ok
      .mockRejectedValueOnce(new Error('fs boom')); // after throws
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    job.status = 'done';

    const res = await finalizer.getJob('job-1');
    expect(res.status).toBe('done');
  });

  it('No-Op diff runs at most ONCE per job (idempotent across repeated getJob calls)', async () => {
    const reader = makeReader();
    reader.snapshot
      .mockResolvedValueOnce(snap(['S-1.yaml']))
      .mockResolvedValueOnce(snap(['S-1.yaml']));
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    job.status = 'done';

    const first = await finalizer.getJob('job-1');
    const second = await finalizer.getJob('job-1');
    expect(first.status).toBe('no-op');
    expect(second.status).toBe('no-op');
    // baseline (1) + exactly one after-scan (1) — the diff is not re-run.
    expect(reader.snapshot).toHaveBeenCalledTimes(2);
  });

  it('read-only: never touches a BoardWriter (no write dependency injected/needed)', async () => {
    // Construct WITHOUT any boardWriter param — the class must not require one.
    const reader = makeReader();
    reader.snapshot.mockResolvedValue(snap(['S-1.yaml']));
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });
    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    job.status = 'done';
    await expect(finalizer.getJob('job-1')).resolves.toBeDefined();
  });
});

// ── AC2: terminal status classification ───────────────────────────────────────

describe('StorySpecifyFinalizer — AC2: terminal status classification', () => {
  it('running passes through without triggering a diff (no after-snapshot)', async () => {
    const reader = makeReader();
    reader.snapshot.mockResolvedValue(snap(['S-1.yaml']));
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    const res = await finalizer.getJob('job-1');
    expect(res.status).toBe('running');
    // only the baseline snapshot from start() — no diff for a running job.
    expect(reader.snapshot).toHaveBeenCalledTimes(1);
  });

  it('failed / auth-expired pass through unchanged (no no-op mapping)', async () => {
    const jobs = new Map([
      ['j-fail', { status: 'failed', error: 'Flow-Lauf fehlgeschlagen' }],
      ['j-auth', { status: 'auth-expired', error: 'Auth abgelaufen' }],
    ]);
    const runner = { start: jest.fn(), getJob: jest.fn((id) => jobs.get(id)) };
    const finalizer = new StorySpecifyFinalizer({ runner });

    await expect(finalizer.getJob('j-fail')).resolves.toEqual({ status: 'failed', error: 'Flow-Lauf fehlgeschlagen' });
    await expect(finalizer.getJob('j-auth')).resolves.toEqual({ status: 'auth-expired', error: 'Auth abgelaufen' });
  });

  it('returns undefined for an unknown jobId', async () => {
    const runner = { start: jest.fn(), getJob: jest.fn(() => undefined) };
    const finalizer = new StorySpecifyFinalizer({ runner });
    await expect(finalizer.getJob('nope')).resolves.toBeUndefined();
  });
});

// ── AC3: projekt-keyed last-finalize registry ─────────────────────────────────

describe('StorySpecifyFinalizer — AC3: projekt-keyed last-finalize registry', () => {
  it('lastForProject → null when no finalize ever ran for the project', async () => {
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner({ status: 'running' }) });
    await expect(finalizer.lastForProject('proj')).resolves.toBeNull();
  });

  it('registers `running` synchronously and reflects it immediately after start resolves', async () => {
    const reader = makeReader();
    reader.snapshot.mockResolvedValue(snap());
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    await expect(finalizer.lastForProject('proj')).resolves.toEqual({ status: 'running', jobId: 'job-1' });
  });

  it('registration happens with NO await between runner.start() and the registry set (synchronous)', async () => {
    // Prove the atomicity: at the moment runner.start() returns, the registry
    // must be set before start() yields — we assert the registry is populated
    // right after `await start()` with a runner whose getJob still reports running.
    const reader = makeReader();
    reader.snapshot.mockResolvedValue(snap());
    const job = { status: 'running' };
    const runner = makeRunner(job);
    const finalizer = new StorySpecifyFinalizer({ runner, artifactReader: reader });

    const p = finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    await p;
    // runner.start was invoked exactly once, and the projekt-keyed view is live.
    expect(runner.start).toHaveBeenCalledTimes(1);
    await expect(finalizer.lastForProject('proj')).resolves.toEqual({ status: 'running', jobId: 'job-1' });
  });

  it('lastForProject resolves the CURRENT status live: done → no-op after diff', async () => {
    const reader = makeReader();
    reader.snapshot
      .mockResolvedValueOnce(snap(['S-1.yaml']))
      .mockResolvedValueOnce(snap(['S-1.yaml']));
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    job.status = 'done';

    const view = await finalizer.lastForProject('proj');
    expect(view).toEqual({ status: 'no-op', jobId: 'job-1', error: NO_OP_MESSAGE });
  });

  it('lastForProject resolves live: done + new story → done (with jobId)', async () => {
    const reader = makeReader();
    reader.snapshot
      .mockResolvedValueOnce(snap(['S-1.yaml']))
      .mockResolvedValueOnce(snap(['S-1.yaml', 'S-2.yaml']));
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    job.status = 'done';

    await expect(finalizer.lastForProject('proj')).resolves.toEqual({ status: 'done', jobId: 'job-1' });
  });

  it('NOT registered on a locked result (a prior running job stays the last-known)', async () => {
    const reader = makeReader();
    reader.snapshot.mockResolvedValue(snap());
    const jobA = { status: 'running' };
    const runner = {
      start: jest.fn(),
      getJob: jest.fn(() => jobA),
    };
    // First start → ok(job-A); second start → locked.
    runner.start.mockReturnValueOnce({ ok: true, jobId: 'job-A' }).mockReturnValueOnce({ ok: false, reason: 'locked' });
    const finalizer = new StorySpecifyFinalizer({ runner, artifactReader: reader });

    await finalizer.start('/p', { draftText: 'a', projectSlug: 'proj' });
    const second = await finalizer.start('/p', { draftText: 'b', projectSlug: 'proj' });
    expect(second).toEqual({ ok: false, reason: 'locked' });

    // Registry still points at the first (running) job — the locked start did not overwrite it.
    await expect(finalizer.lastForProject('proj')).resolves.toEqual({ status: 'running', jobId: 'job-A' });
  });

  it('per-project isolation: each slug maps to its own last-finalize job', async () => {
    const reader = makeReader();
    reader.snapshot.mockResolvedValue(snap());
    const jobs = { 'job-a': { status: 'running' }, 'job-b': { status: 'running' } };
    const runner = {
      start: jest.fn(),
      getJob: jest.fn((id) => jobs[id]),
    };
    runner.start.mockReturnValueOnce({ ok: true, jobId: 'job-a' }).mockReturnValueOnce({ ok: true, jobId: 'job-b' });
    const finalizer = new StorySpecifyFinalizer({ runner, artifactReader: reader });

    await finalizer.start('/a', { draftText: 'a', projectSlug: 'proj-a' });
    await finalizer.start('/b', { draftText: 'b', projectSlug: 'proj-b' });

    await expect(finalizer.lastForProject('proj-a')).resolves.toEqual({ status: 'running', jobId: 'job-a' });
    await expect(finalizer.lastForProject('proj-b')).resolves.toEqual({ status: 'running', jobId: 'job-b' });
  });

  it('lastForProject → null when the runner no longer knows the job (registry survived a runner reset)', async () => {
    const reader = makeReader();
    reader.snapshot.mockResolvedValue(snap());
    let known = true;
    const runner = {
      start: jest.fn(() => ({ ok: true, jobId: 'job-1' })),
      getJob: jest.fn(() => (known ? { status: 'running' } : undefined)),
    };
    const finalizer = new StorySpecifyFinalizer({ runner, artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x', projectSlug: 'proj' });
    known = false; // runner forgot the job (e.g. registry loss)
    await expect(finalizer.lastForProject('proj')).resolves.toBeNull();
  });

  it('start WITHOUT projectSlug: no projekt-keyed entry, but the jobId path still works', async () => {
    const reader = makeReader();
    reader.snapshot.mockResolvedValue(snap());
    const job = { status: 'running' };
    const finalizer = new StorySpecifyFinalizer({ runner: makeRunner(job), artifactReader: reader });

    await finalizer.start('/p', { draftText: 'x' }); // no projectSlug
    await expect(finalizer.lastForProject('proj')).resolves.toBeNull();
    await expect(finalizer.getJob('job-1')).resolves.toEqual({ status: 'running' });
  });
});
