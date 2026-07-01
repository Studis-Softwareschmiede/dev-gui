/**
 * @file IdeaSpecifyFinalizer.test.js — Unit tests for the headless
 * `requirement`-Finalizer orchestrator (docs/specs/idea-specify-chat.md
 * AC6, AC7, AC8, AC9; hardened safety net per
 * docs/specs/headless-arg-finalize-safety.md AC4, AC5, AC6, AC8).
 *
 * Covers (idea-specify-chat): AC6, AC7, AC8, AC9
 * Covers (headless-arg-finalize-safety): AC4, AC5, AC6, AC8
 *
 *   AC6 (idea-specify-chat) — `start(projectPath, { draftText, ideaStoryId, projectSlug })`
 *         calls the (wrapped) `HeadlessFlowRunner` with `{ command: '/agent-flow:requirement',
 *         args: [buildRequirementPrompt(...)] }` and propagates its
 *         `{ ok, jobId }` / `{ ok:false, reason:'locked' }` result unchanged
 *         (now via a resolved Promise — `start()` is async since S-220, AC4).
 *         Lock-Trennung: the Finalizer's DEFAULT construction path (no `runner`
 *         injected) uses its OWN, independent `ProjectJobLock` instance — an
 *         unrelated `HeadlessFlowRunner` (e.g. Nacht-Drain) holding the lock for
 *         the SAME project path does NOT block it, and vice versa.
 *   AC7 (idea-specify-chat) — `getJob(jobId)` reads the underlying runner's
 *         job-registry entry; unknown jobId → `undefined`.
 *   AC8 (idea-specify-chat) — `buildRequirementPrompt()`: appends EXACTLY the
 *         two hints (a)/(b) after `draftText`, in order; graceful with
 *         missing/empty `draftText`.
 *   AC9 (idea-specify-chat) / AC4-AC6 (headless-arg-finalize-safety) —
 *         Sicherheitsnetz: after the FIRST observation of `status: 'done'`,
 *         the Finalizer verifies against a Baseline-Snapshot (captured in
 *         `start()`, BEFORE the runner is started) whether a new Board-/Spec-
 *         artifact actually appeared:
 *           - Fall (a) — new artifact AND idea still `status: Idee` →
 *             `BoardWriter.archiveSupersededIdea({ projectSlug, storyId })` is
 *             called exactly once, job stays `done`.
 *           - Fall (b) — idea NOT (anymore) `status: Idee` (agent handled it
 *             itself) — regardless of a new artifact — expected no-op
 *             archiving (`not-resolvable` swallowed, OR no archiving attempt
 *             at all when no new artifact appeared but the idea is no longer
 *             `Idee`), job stays `done`.
 *           - Fall (c) — NEITHER a new artifact NOR an idea transformation →
 *             NO archiving call at all; `getJob()` maps the returned status to
 *             the Finalizer-own terminal status `no-op` (AC5) with a secret-
 *             free `error` message, and fires exactly ONE `AuditStore` entry
 *             (AC6). The underlying runner job status itself stays `done`.
 *           - A failed Baseline-/Nach-Snapshot read is fail-safe → `no-op`
 *             (AC8 — im Zweifel NICHT archivieren).
 *         Race-freedom (unchanged): a still-`running` job never triggers the
 *         safety net; polling `getJob()` again after `done` does NOT re-run it
 *         (idempotent no-op mapping/audit).
 *
 * Pattern: injected `runner` stub (no real `HeadlessFlowRunner`/`claude -p` run)
 * for AC7/AC9/AC4-AC6, plus an injected `artifactReader` stub (no real fs) for
 * the Fall (a)/(b)/(c) verification tests; a REAL `HeadlessFlowRunner` with a
 * fake `spawnFn` (pattern from `HeadlessFlowRunner.test.js`) for the AC6
 * Lock-Trennung tests, so the actual default-construction path (own
 * `ProjectJobLock`) is genuinely exercised without spawning a real `claude`
 * process (the DEFAULT `artifactReader` is used there too — it reads a
 * non-existent fake project path and fails-safe to empty snapshots, which is
 * fine since those tests don't assert on the safety net).
 */

import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { HeadlessFlowRunner } from '../src/HeadlessFlowRunner.js';
import { BoardWriterError } from '../src/BoardWriter.js';
import {
  IdeaSpecifyFinalizer,
  buildRequirementPrompt,
  REQUIREMENT_COMMAND,
  NO_OP_MESSAGE,
} from '../src/IdeaSpecifyFinalizer.js';

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

/**
 * Stub `artifactReader` (headless-arg-finalize-safety AC4) — `snapshot()` is
 * called TWICE per finalize lifecycle (once in `start()` for the baseline,
 * once in `#runSafetyNet()` for the after-state); `snapshots` supplies the
 * return value for each successive call (last entry repeats if exhausted).
 * `readIdeaStatus()` returns `ideaStatus` (default `'Idee'`) unless `readIdeaStatusImpl`
 * is provided.
 *
 * @param {object} [opts]
 * @param {Array<Record<string, Set<string>>>} [opts.snapshots]
 * @param {string|null} [opts.ideaStatus]
 * @param {Function} [opts.snapshotImpl] - overrides `snapshots`-based sequencing entirely.
 * @param {Function} [opts.readIdeaStatusImpl]
 */
function makeArtifactReader({
  snapshots = [{ stories: new Set() }, { stories: new Set() }],
  ideaStatus = 'Idee',
  snapshotImpl,
  readIdeaStatusImpl,
} = {}) {
  let call = 0;
  const snapshot =
    snapshotImpl ??
    jest.fn(async () => {
      const idx = Math.min(call, snapshots.length - 1);
      call += 1;
      return snapshots[idx];
    });
  const readIdeaStatus = readIdeaStatusImpl ?? jest.fn(async () => ideaStatus);
  return { snapshot, readIdeaStatus };
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
  it('calls runner.start(projectPath, { command: REQUIREMENT_COMMAND, args: [prompt] })', async () => {
    const runner = { start: jest.fn(() => ({ ok: true, jobId: 'job-1' })), getJob: jest.fn() };
    const finalizer = new IdeaSpecifyFinalizer({
      runner,
      boardWriter: fakeBoardWriter(),
      artifactReader: makeArtifactReader(),
    });

    const result = await finalizer.start('/workspace/proj', {
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

  it('propagates a locked result from the runner unchanged', async () => {
    const runner = { start: jest.fn(() => ({ ok: false, reason: 'locked' })), getJob: jest.fn() };
    const finalizer = new IdeaSpecifyFinalizer({
      runner,
      boardWriter: fakeBoardWriter(),
      artifactReader: makeArtifactReader(),
    });

    const result = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-1', projectSlug: 'demo' });
    expect(result).toEqual({ ok: false, reason: 'locked' });
  });

  it('captures the baseline snapshot BEFORE calling runner.start() (AC4)', async () => {
    const callOrder = [];
    const runner = {
      start: jest.fn(() => {
        callOrder.push('runner.start');
        return { ok: true, jobId: 'job-1' };
      }),
      getJob: jest.fn(),
    };
    const snapshot = jest.fn(async () => {
      callOrder.push('snapshot');
      return { stories: new Set() };
    });
    const finalizer = new IdeaSpecifyFinalizer({
      runner,
      boardWriter: fakeBoardWriter(),
      artifactReader: { snapshot, readIdeaStatus: jest.fn(async () => 'Idee') },
    });

    await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-1', projectSlug: 'demo' });

    expect(callOrder).toEqual(['snapshot', 'runner.start']);
  });
});

// ── AC6: Lock-Trennung (real HeadlessFlowRunner + fake spawnFn) ──────────────

describe('IdeaSpecifyFinalizer — AC6: Lock-Trennung (own ProjectJobLock, not shared with other headless boundaries)', () => {
  it('an unrelated HeadlessFlowRunner holding the lock for the SAME project path does NOT block the Finalizer', async () => {
    const spawnFn = jest.fn(() => makeFakeChild());

    // Simulates an already-running OTHER headless boundary (e.g. the Nacht-Drain's
    // own `headlessFlowRunner` in server.js) holding the lock for this project.
    const otherRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
    expect(otherRunner.start('/workspace/shared-project').ok).toBe(true);

    // Finalizer's OWN default construction path (no `runner`/`lock` injected) —
    // must use its OWN, independent ProjectJobLock instance.
    const finalizer = new IdeaSpecifyFinalizer({ spawnFn, timeoutMs: 10_000, boardWriter: fakeBoardWriter() });

    const result = await finalizer.start('/workspace/shared-project', {
      draftText: 'd',
      ideaStoryId: 'S-1',
      projectSlug: 'demo',
    });
    expect(result.ok).toBe(true);
  });

  it('the Finalizer holding a lock does NOT block an unrelated HeadlessFlowRunner for the SAME project path', async () => {
    const spawnFn = jest.fn(() => makeFakeChild());

    const finalizer = new IdeaSpecifyFinalizer({ spawnFn, timeoutMs: 10_000, boardWriter: fakeBoardWriter() });
    const started = await finalizer.start('/workspace/shared-project-2', { draftText: 'd', ideaStoryId: 'S-1', projectSlug: 'demo' });
    expect(started.ok).toBe(true);

    const otherRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
    expect(otherRunner.start('/workspace/shared-project-2').ok).toBe(true);
  });

  it('the Finalizer\'s own lock DOES block a second finalize start() for the SAME project path', async () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const finalizer = new IdeaSpecifyFinalizer({ spawnFn, timeoutMs: 10_000, boardWriter: fakeBoardWriter() });

    const first = await finalizer.start('/workspace/proj-dup', { draftText: 'd', ideaStoryId: 'S-1', projectSlug: 'demo' });
    expect(first.ok).toBe(true);

    const second = await finalizer.start('/workspace/proj-dup', { draftText: 'd', ideaStoryId: 'S-2', projectSlug: 'demo' });
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

  it('missing job-meta (jobId not started via this Finalizer instance) → safety net is a silent no-op-of-the-archiving-attempt, status stays "done"', async () => {
    const archiveSupersededIdea = jest.fn();
    const runner = { getJob: jest.fn(() => ({ status: 'done', result: 'ok' })) };
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea) });

    await expect(finalizer.getJob('some-job-never-started-here')).resolves.toEqual(expect.objectContaining({ status: 'done' }));
    expect(archiveSupersededIdea).not.toHaveBeenCalled();
  });
});

// ── AC4/AC9: Fall (a) — neues Artefakt + Idee noch "Idee" → archivieren ──────

describe('IdeaSpecifyFinalizer — Fall (a): new artifact AND idea still "Idee" → archives, stays "done"', () => {
  function makeDoneRunner(jobId = 'job-42') {
    return { start: jest.fn(() => ({ ok: true, jobId })), getJob: jest.fn(() => ({ status: 'done', result: 'Flow abgeschlossen' })) };
  }

  it('calls archiveSupersededIdea({ projectSlug, storyId }) exactly once when a new story file appeared since the baseline', async () => {
    const archiveSupersededIdea = jest.fn().mockResolvedValue({ filePath: '/x/board/stories/S-900.yaml' });
    const runner = makeDoneRunner();
    const artifactReader = makeArtifactReader({
      snapshots: [
        { stories: new Set(['S-900.yaml']) }, // baseline (in start())
        { stories: new Set(['S-900.yaml', 'S-901.yaml']) }, // after (in #runSafetyNet)
      ],
    });
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    expect(started.ok).toBe(true);

    const job = await finalizer.getJob(started.jobId);
    expect(job.status).toBe('done');
    expect(archiveSupersededIdea).toHaveBeenCalledTimes(1);
    expect(archiveSupersededIdea).toHaveBeenCalledWith({ projectSlug: 'demo', storyId: 'S-900' });

    // Polling again after "done" must NOT re-trigger the safety net.
    await finalizer.getJob(started.jobId);
    expect(archiveSupersededIdea).toHaveBeenCalledTimes(1);
  });

  it('detects a new artifact in ANY of the three watched dirs (features/specs), not just stories', async () => {
    const archiveSupersededIdea = jest.fn().mockResolvedValue({ filePath: '/x' });
    const runner = makeDoneRunner();
    const artifactReader = makeArtifactReader({
      snapshots: [
        { stories: new Set(), features: new Set(), specs: new Set() },
        { stories: new Set(), features: new Set(['F-010.yaml']), specs: new Set() },
      ],
    });
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    await finalizer.getJob(started.jobId);
    expect(archiveSupersededIdea).toHaveBeenCalledTimes(1);
  });
});

// ── AC4/AC9: Fall (b) — Idee bereits transformiert → No-Op wie bisher, "done" ─

describe('IdeaSpecifyFinalizer — Fall (b): idea no longer "Idee" → expected no-op archiving, stays "done"', () => {
  function makeDoneRunner(jobId = 'job-42') {
    return { start: jest.fn(() => ({ ok: true, jobId })), getJob: jest.fn(() => ({ status: 'done', result: 'Flow abgeschlossen' })) };
  }

  it('a "not-resolvable" BoardWriterError (agent already handled the idea, new artifact present) is swallowed as a no-op — status stays "done"', async () => {
    const archiveSupersededIdea = jest.fn().mockRejectedValue(new BoardWriterError('nicht mehr archivierbar', 'not-resolvable'));
    const runner = makeDoneRunner();
    const artifactReader = makeArtifactReader({
      snapshots: [{ stories: new Set() }, { stories: new Set(['S-901.yaml']) }],
    });
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    await expect(finalizer.getJob(started.jobId)).resolves.toEqual(expect.objectContaining({ status: 'done' }));
    expect(archiveSupersededIdea).toHaveBeenCalledTimes(1);
  });

  it('no new artifact but the idea is no longer "Idee" (agent transformed it directly) → NO archiving attempt, stays "done", no no-op', async () => {
    const archiveSupersededIdea = jest.fn();
    const runner = makeDoneRunner();
    const artifactReader = makeArtifactReader({
      snapshots: [{ stories: new Set(['S-900.yaml']) }, { stories: new Set(['S-900.yaml']) }],
      ideaStatus: 'Done',
    });
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    const job = await finalizer.getJob(started.jobId);

    expect(job.status).toBe('done');
    expect(job.status).not.toBe('no-op');
    expect(archiveSupersededIdea).not.toHaveBeenCalled();
  });

  it('any other archiveSupersededIdea() error (new artifact present) is swallowed best-effort — getJob still resolves "done", no crash', async () => {
    const archiveSupersededIdea = jest.fn().mockRejectedValue(new Error('disk full'));
    const runner = makeDoneRunner();
    const artifactReader = makeArtifactReader({
      snapshots: [{ stories: new Set() }, { stories: new Set(['S-901.yaml']) }],
    });
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    await expect(finalizer.getJob(started.jobId)).resolves.toEqual(expect.objectContaining({ status: 'done' }));
  });
});

// ── AC5/AC6: Fall (c) — weder neues Artefakt noch Idee-Transformation → "no-op" ─

describe('IdeaSpecifyFinalizer — Fall (c): neither new artifact nor idea transformation → "no-op" status, no archiving, exactly one audit entry', () => {
  function makeDoneRunner(jobId = 'job-42') {
    return { start: jest.fn(() => ({ ok: true, jobId })), getJob: jest.fn(() => ({ status: 'done', result: 'Flow abgeschlossen' })) };
  }

  it('maps the returned status to "no-op" with a secret-free error message; archiveSupersededIdea is never called', async () => {
    const archiveSupersededIdea = jest.fn();
    const runner = makeDoneRunner();
    const artifactReader = makeArtifactReader({
      snapshots: [{ stories: new Set(['S-900.yaml']) }, { stories: new Set(['S-900.yaml']) }],
      ideaStatus: 'Idee',
    });
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    const job = await finalizer.getJob(started.jobId);

    expect(job.status).toBe('no-op');
    expect(job.error).toBe(NO_OP_MESSAGE);
    expect(job.error).not.toMatch(/token|secret|\/Users\//i);
    expect(archiveSupersededIdea).not.toHaveBeenCalled();
  });

  it('the underlying runner job status itself remains "done" — mapping happens only in getJob(), and repeated polling stays "no-op" (idempotent)', async () => {
    const runner = makeDoneRunner();
    const artifactReader = makeArtifactReader({
      snapshots: [{ stories: new Set() }, { stories: new Set() }],
      ideaStatus: 'Idee',
    });
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    await finalizer.getJob(started.jobId);

    // underlying runner.getJob() itself is untouched (still returns 'done').
    expect(runner.getJob(started.jobId).status).toBe('done');

    // repeated polling keeps returning 'no-op' consistently.
    const secondPoll = await finalizer.getJob(started.jobId);
    expect(secondPoll.status).toBe('no-op');
  });

  it('fires exactly ONE AuditStore entry for the no-op case (AC6) — a second poll does not audit again', async () => {
    const runner = makeDoneRunner();
    const artifactReader = makeArtifactReader({
      snapshots: [{ stories: new Set() }, { stories: new Set() }],
      ideaStatus: 'Idee',
    });
    const auditStore = { record: jest.fn() };
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(), artifactReader, auditStore });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    await finalizer.getJob(started.jobId);
    await finalizer.getJob(started.jobId);
    await finalizer.getJob(started.jobId);

    expect(auditStore.record).toHaveBeenCalledTimes(1);
    const [entry] = auditStore.record.mock.calls[0];
    expect(entry.command).not.toMatch(/token|secret|\/Users\//i);
  });

  it('does NOT throw when no auditStore is injected (audit is optional, best-effort)', async () => {
    const runner = makeDoneRunner();
    const artifactReader = makeArtifactReader({
      snapshots: [{ stories: new Set() }, { stories: new Set() }],
      ideaStatus: 'Idee',
    });
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    await expect(finalizer.getJob(started.jobId)).resolves.toEqual(expect.objectContaining({ status: 'no-op' }));
  });
});

// ── AC8 (headless-arg-finalize-safety): fail-safe bei Snapshot-Fehlern ───────

describe('IdeaSpecifyFinalizer — fail-safe: a failed baseline/after snapshot read never archives, maps to "no-op"', () => {
  function makeDoneRunner(jobId = 'job-42') {
    return { start: jest.fn(() => ({ ok: true, jobId })), getJob: jest.fn(() => ({ status: 'done', result: 'Flow abgeschlossen' })) };
  }

  it('a failing baseline snapshot in start() results in "no-op" (never archives), best-effort logged, no crash', async () => {
    const archiveSupersededIdea = jest.fn();
    const runner = makeDoneRunner();
    const artifactReader = {
      snapshot: jest.fn().mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue({ stories: new Set() }),
      readIdeaStatus: jest.fn(async () => 'Idee'),
    };
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    expect(started.ok).toBe(true);

    const job = await finalizer.getJob(started.jobId);
    expect(job.status).toBe('no-op');
    expect(archiveSupersededIdea).not.toHaveBeenCalled();
  });

  it('a failing "after" snapshot in the safety net results in "no-op" (never archives), no crash', async () => {
    const archiveSupersededIdea = jest.fn();
    const runner = makeDoneRunner();
    let call = 0;
    const artifactReader = {
      snapshot: jest.fn(async () => {
        call += 1;
        if (call === 1) return { stories: new Set() }; // baseline in start()
        throw new Error('ENOENT'); // after-snapshot in #runSafetyNet fails
      }),
      readIdeaStatus: jest.fn(async () => 'Idee'),
    };
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    const job = await finalizer.getJob(started.jobId);

    expect(job.status).toBe('no-op');
    expect(archiveSupersededIdea).not.toHaveBeenCalled();
  });

  it('a failing readIdeaStatus() (no new artifact) results in "no-op" (fail-safe), no crash', async () => {
    const archiveSupersededIdea = jest.fn();
    const runner = makeDoneRunner();
    const artifactReader = makeArtifactReader({
      snapshots: [{ stories: new Set() }, { stories: new Set() }],
      readIdeaStatusImpl: jest.fn().mockRejectedValue(new Error('read failed')),
    });
    const finalizer = new IdeaSpecifyFinalizer({ runner, boardWriter: fakeBoardWriter(archiveSupersededIdea), artifactReader });

    const started = await finalizer.start('/workspace/proj', { draftText: 'd', ideaStoryId: 'S-900', projectSlug: 'demo' });
    const job = await finalizer.getJob(started.jobId);

    expect(job.status).toBe('no-op');
    expect(archiveSupersededIdea).not.toHaveBeenCalled();
  });
});
