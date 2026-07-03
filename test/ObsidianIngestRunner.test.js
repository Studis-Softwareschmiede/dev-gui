/**
 * @file ObsidianIngestRunner.test.js — unit tests for the headless
 * Obsidian-Ingest runner + its pure parsers + default claude adapter
 * (docs/specs/obsidian-question-catalog.md, docs/specs/questions-pending-notification.md).
 *
 * Covers (obsidian-question-catalog): AC1, AC2, AC4, AC5, AC6, AC7
 *
 *   AC1 — start() runs headless via an OWN, isolated ProjectJobLock instance; a
 *         run round settles into a terminal `done`/`failed`/`auth-expired` OR the
 *         non-terminal interrupt `needs-answers`. Lock held while running AND
 *         while a catalog is pending; released only on a terminal state (second
 *         start for the same project → locked; different project → not blocked).
 *   AC2 — needs-answers exposes the machine-readable catalog
 *         [{ stage, id, frage, quelle, optionen?, pflicht }] (markdown-fence-
 *         tolerant parse); an unparsable/broken outcome → `failed`, secret-free,
 *         no crash.
 *   AC4 — answers() enforces required-question coverage (missing-required /
 *         unknown-id / invalid → reason) and, on success, resumes the run.
 *   AC5 — after a resume round the runner reports the NEXT needs-answers catalog
 *         OR `done`.
 *   AC6 — Security floor: argv-array (no shell string), --dangerously-skip-permissions
 *         only in this headless path, ANTHROPIC_API_KEY/OPENAI_API_KEY blocked from
 *         child env, resume answers via STDIN (never argv); getJob() view is
 *         secret-free (no projectPath/sessionId/identity); job-end/error audited
 *         with identity + action.
 *   AC7 — error paths: runner error / unparsable catalog → secret-free `failed`
 *         error, no crash; answers on a non-waiting/unknown job → reason.
 *
 * Covers (questions-pending-notification): AC1, AC2 (gating itself in
 * test/DrainNotifier.test.js), AC4, AC5, AC6
 *
 *   AC1 — a needs-answers entry fires exactly one `notifier.notifyQuestionsPending`
 *         call; a NEW needs-answers entry after a resume fires a SECOND call; a
 *         run that goes straight to `done` never calls the notifier.
 *   AC4 — a throwing/rejecting injected notifier never crashes the runner — the
 *         job still reaches `needs-answers` with its catalog/lock intact.
 *   AC5 — no injected notifier (default `null`) → No-op, byte-identical behavior
 *         to the pre-S-279 runner (no crash, no call attempted).
 *   AC6 — the `label` passed to the notifier is the basename of the project path
 *         (never the full path); a path without a usable basename falls back to
 *         a generic placeholder, never an empty string / the raw path.
 *
 * The runner is exercised with an INJECTED runClaude adapter — no real `claude`
 * process (NFR „Entkopplung"). The default adapter's spawn/env/stdin/argv
 * security properties are covered separately via an injected spawnFn stub.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  ObsidianIngestRunner,
  parseIngestOutcome,
  validateAnswers,
  extractClaudeResult,
  defaultRunClaude,
  FROM_NOTES_COMMAND,
  RESUME_PROMPT,
  AUTH_EXPIRED_MESSAGE,
} from '../src/ObsidianIngestRunner.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';

/** Resolve pending microtasks so a fire-and-forget #runRound settles. */
function flush() {
  return new Promise((r) => setImmediate(r));
}

/**
 * A runClaude adapter that returns queued results in order and records the
 * arguments of each call (for resume/answers assertions).
 */
function makeSequencedRunClaude(results) {
  const calls = [];
  const queue = [...results];
  const fn = jest.fn(async (params) => {
    calls.push(params);
    return queue.shift() ?? { exitCode: 0, output: '{"status":"done"}', sessionId: undefined, authError: false };
  });
  fn.calls = calls;
  return fn;
}

const CATALOG_OUTPUT = JSON.stringify({
  status: 'needs-answers',
  catalog: [
    { stage: 'Notiz→Konzept', id: 'q1', frage: 'Welches Ziel?', quelle: 'note-1.md', optionen: ['A', 'B'] },
    { stage: 'Konzept→Spec', id: 'q2', frage: 'Optionaler Hinweis?', quelle: 'note-2.md', pflicht: false },
  ],
});

// ── Pure parser: parseIngestOutcome (AC2) ────────────────────────────────────

describe('parseIngestOutcome — AC2 machine-readable catalog', () => {
  it('parses status:"done"', () => {
    expect(parseIngestOutcome('{"status":"done"}')).toEqual({ status: 'done' });
  });

  it('parses a needs-answers catalog and normalises fields (pflicht defaults true)', () => {
    const out = parseIngestOutcome(CATALOG_OUTPUT);
    expect(out.status).toBe('needs-answers');
    expect(out.catalog).toHaveLength(2);
    expect(out.catalog[0]).toEqual({
      stage: 'Notiz→Konzept',
      id: 'q1',
      frage: 'Welches Ziel?',
      quelle: 'note-1.md',
      optionen: ['A', 'B'],
      pflicht: true,
    });
    // pflicht:false explicitly marks the question optional.
    expect(out.catalog[1].pflicht).toBe(false);
  });

  it('is markdown-fence tolerant (```json … ```)', () => {
    const fenced = '```json\n{"status":"done"}\n```';
    expect(parseIngestOutcome(fenced)).toEqual({ status: 'done' });
  });

  it('treats optional:true as an optional (non-pflicht) question', () => {
    const out = parseIngestOutcome(
      JSON.stringify({ status: 'needs-answers', catalog: [{ id: 'x', frage: 'f?', optional: true }] }),
    );
    expect(out.catalog[0].pflicht).toBe(false);
  });

  it('throws on unparsable JSON (AC2/AC7)', () => {
    expect(() => parseIngestOutcome('not json at all')).toThrow();
  });

  it('throws on unknown status', () => {
    expect(() => parseIngestOutcome('{"status":"weird"}')).toThrow();
  });

  it('throws on needs-answers with an empty/absent catalog', () => {
    expect(() => parseIngestOutcome('{"status":"needs-answers","catalog":[]}')).toThrow();
    expect(() => parseIngestOutcome('{"status":"needs-answers"}')).toThrow();
  });

  it('throws when a catalog question misses id/frage', () => {
    expect(() =>
      parseIngestOutcome('{"status":"needs-answers","catalog":[{"stage":"s"}]}'),
    ).toThrow();
  });
});

// ── Pure validator: validateAnswers (AC4) ────────────────────────────────────

describe('validateAnswers — AC4 required coverage', () => {
  const catalog = [
    { id: 'q1', pflicht: true },
    { id: 'q2', pflicht: false },
  ];

  it('accepts all required answered (optional omitted)', () => {
    const r = validateAnswers([{ id: 'q1', answer: 'ja' }], catalog);
    expect(r.ok).toBe(true);
    expect(r.answers).toEqual([{ id: 'q1', answer: 'ja' }]);
  });

  it('rejects a missing required answer', () => {
    const r = validateAnswers([{ id: 'q2', answer: 'x' }], catalog);
    expect(r).toEqual({ ok: false, reason: 'missing-required' });
  });

  it('rejects an empty/whitespace required answer', () => {
    const r = validateAnswers([{ id: 'q1', answer: '   ' }], catalog);
    expect(r).toEqual({ ok: false, reason: 'missing-required' });
  });

  it('rejects an unknown question id', () => {
    const r = validateAnswers([{ id: 'q1', answer: 'ja' }, { id: 'nope', answer: 'y' }], catalog);
    expect(r).toEqual({ ok: false, reason: 'unknown-id' });
  });

  it('rejects a non-array / malformed answer entry', () => {
    expect(validateAnswers('x', catalog)).toEqual({ ok: false, reason: 'invalid' });
    expect(validateAnswers([{ answer: 'no id' }], catalog)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('optional-only catalog accepts an empty answer set (edge-case)', () => {
    const r = validateAnswers([], [{ id: 'opt', pflicht: false }]);
    expect(r.ok).toBe(true);
  });
});

// ── extractClaudeResult ──────────────────────────────────────────────────────

describe('extractClaudeResult', () => {
  it('extracts result + session_id from the --output-format json wrapper', () => {
    const wrapper = JSON.stringify({ type: 'result', result: '{"status":"done"}', session_id: 'sess-9' });
    expect(extractClaudeResult(wrapper)).toEqual({ resultText: '{"status":"done"}', sessionId: 'sess-9' });
  });

  it('falls back to raw stdout when it is not a json wrapper', () => {
    expect(extractClaudeResult('raw text')).toEqual({ resultText: 'raw text', sessionId: undefined });
  });
});

// ── Runner state machine (AC1, AC2, AC4, AC5, AC7) ───────────────────────────

describe('ObsidianIngestRunner — start → needs-answers → resume → done', () => {
  it('AC1/AC2/AC5: exposes the catalog on needs-answers and reaches done after resume', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, output: '{"status":"done"}', sessionId: 'sess-1', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude });

    const started = runner.start('/workspace/proj', { identity: 'alex@x' });
    expect(started.ok).toBe(true);
    await flush();

    let job = runner.getJob(started.jobId);
    expect(job.status).toBe('needs-answers');
    expect(job.catalog).toHaveLength(2);
    // secret-free public view — no internal fields leaked (AC6).
    expect(job).not.toHaveProperty('projectPath');
    expect(job).not.toHaveProperty('sessionId');
    expect(job).not.toHaveProperty('identity');

    // First round used the from-notes command with the project path (AC1).
    expect(runClaude.calls[0].promptArg).toBe(`${FROM_NOTES_COMMAND} /workspace/proj`);
    expect(runClaude.calls[0].resumeSessionId).toBeUndefined();

    const answered = runner.answers(started.jobId, [{ id: 'q1', answer: 'Ziel X' }]);
    expect(answered.ok).toBe(true);
    await flush();

    // Resume round carried the session id + answers (AC4/AC5).
    expect(runClaude.calls[1].resumeSessionId).toBe('sess-1');
    expect(runClaude.calls[1].answers).toEqual([{ id: 'q1', answer: 'Ziel X' }]);

    job = runner.getJob(started.jobId);
    expect(job.status).toBe('done');
    expect(job.catalog).toBeUndefined();
    expect(job.result).toBeTruthy();
  });

  it('AC5: a resume round can surface the NEXT needs-answers catalog', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj');
    await flush();
    runner.answers(jobId, [{ id: 'q1', answer: 'a' }]);
    await flush();
    expect(runner.getJob(jobId).status).toBe('needs-answers');
  });
});

describe('ObsidianIngestRunner — lock lifecycle (AC1/AC6)', () => {
  it('holds the project lock while a catalog is pending; releases on terminal done', async () => {
    const lock = new ProjectJobLock();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, output: '{"status":"done"}', sessionId: 'sess-1', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude, lock });

    const first = runner.start('/workspace/proj');
    await flush();
    expect(runner.getJob(first.jobId).status).toBe('needs-answers');

    // Lock still held during needs-answers → a second start for the SAME project is rejected.
    const second = runner.start('/workspace/proj');
    expect(second).toEqual({ ok: false, reason: 'locked' });

    // A DIFFERENT project is not blocked (per-project lock, AC1).
    const other = runner.start('/workspace/other');
    expect(other.ok).toBe(true);

    // Resume to done → lock released → same project can start again.
    runner.answers(first.jobId, [{ id: 'q1', answer: 'a' }]);
    await flush();
    expect(runner.getJob(first.jobId).status).toBe('done');
    expect(runner.start('/workspace/proj').ok).toBe(true);
  });
});

describe('ObsidianIngestRunner — terminal error paths (AC2/AC7)', () => {
  it('auth-expired on a 401 signature, lock released', async () => {
    const lock = new ProjectJobLock();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 1, output: '', sessionId: undefined, authError: true },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude, lock });
    const { jobId } = runner.start('/workspace/proj');
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('auth-expired');
    expect(job.error).toBe(AUTH_EXPIRED_MESSAGE);
    expect(lock.isHeld('/workspace/proj')).toBe(false);
  });

  it('failed (secret-free) on a non-zero exit', async () => {
    const runClaude = makeSequencedRunClaude([{ exitCode: 2, output: '', authError: false }]);
    const runner = new ObsidianIngestRunner({ runClaude });
    const { jobId } = runner.start('/workspace/secret-path');
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).not.toMatch(/\/workspace\//);
  });

  it('failed on an unparsable catalog outcome (AC2/AC7)', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: 'this is not a catalog', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj');
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
    expect(runner.getJob(jobId).error).toBeTruthy();
  });

  it('failed (claude nicht verfügbar) on a spawn error', async () => {
    const runClaude = makeSequencedRunClaude([{ spawnError: true, exitCode: -1, output: '', authError: false }]);
    const runner = new ObsidianIngestRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj');
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
  });

  it('failed (Timeout) when the adapter reports timedOut', async () => {
    const runClaude = makeSequencedRunClaude([{ timedOut: true, exitCode: -1, output: '', authError: false }]);
    const runner = new ObsidianIngestRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj');
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
    expect(runner.getJob(jobId).error).toMatch(/Timeout/);
  });

  it('failed when the runClaude adapter itself throws (AC7, no crash)', async () => {
    const runClaude = jest.fn(async () => { throw new Error('boom'); });
    const runner = new ObsidianIngestRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj');
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
  });

  it('failed (secret-free) on resume when no claude session-id is known (AC7, no silent answer loss)', async () => {
    const lock = new ProjectJobLock();
    // needs-answers round WITHOUT a session-id → a resume would have no channel
    // to carry the answers; the runner must fail cleanly instead of running an
    // empty, answer-less prompt.
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: undefined, authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude, lock });
    const { jobId } = runner.start('/workspace/secret-path');
    await flush();
    expect(runner.getJob(jobId).status).toBe('needs-answers');

    const res = runner.answers(jobId, [{ id: 'q1', answer: 'A' }]);
    expect(res.ok).toBe(true); // accepted; the failure surfaces in the resume round
    await flush();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBeTruthy();
    expect(job.error).not.toMatch(/\/workspace\//);
    // exactly one runClaude call — the resume round never spawned.
    expect(runClaude.calls).toHaveLength(1);
    // terminal → lock released.
    expect(lock.isHeld('/workspace/secret-path')).toBe(false);
  });
});

describe('ObsidianIngestRunner — answers() guards (AC4/AC7)', () => {
  it('not-found for an unknown jobId', () => {
    const runner = new ObsidianIngestRunner({ runClaude: makeSequencedRunClaude([]) });
    expect(runner.answers('nope', [])).toEqual({ ok: false, reason: 'not-found' });
  });

  it('not-waiting when the job is not in needs-answers', async () => {
    const runClaude = makeSequencedRunClaude([{ exitCode: 0, output: '{"status":"done"}', authError: false }]);
    const runner = new ObsidianIngestRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj');
    await flush();
    expect(runner.getJob(jobId).status).toBe('done');
    expect(runner.answers(jobId, [])).toEqual({ ok: false, reason: 'not-waiting' });
  });

  it('missing-required / unknown-id validation against the pending catalog', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 's', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj');
    await flush();
    // q1 is required; answering only q2 (optional) → missing-required.
    expect(runner.answers(jobId, [{ id: 'q2', answer: 'x' }])).toEqual({ ok: false, reason: 'missing-required' });
    expect(runner.answers(jobId, [{ id: 'q1', answer: 'a' }, { id: 'ghost', answer: 'b' }]))
      .toEqual({ ok: false, reason: 'unknown-id' });
    // Job stays in needs-answers after a rejected submission (no state change).
    expect(runner.getJob(jobId).status).toBe('needs-answers');
  });
});

describe('ObsidianIngestRunner — audit (AC6)', () => {
  it('records a job-end audit with identity + action on done', async () => {
    const record = jest.fn();
    const runClaude = makeSequencedRunClaude([{ exitCode: 0, output: '{"status":"done"}', authError: false }]);
    const runner = new ObsidianIngestRunner({ runClaude, auditStore: { record } });
    runner.start('/workspace/proj', { identity: 'alex@x' });
    await flush();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ identity: 'alex@x', command: expect.stringContaining('obsidian:ingest:done') }),
    );
  });

  it('records a job-error audit on failed and never crashes on an audit throw', async () => {
    const record = jest.fn(() => { throw new Error('audit down'); });
    const runClaude = makeSequencedRunClaude([{ exitCode: 1, output: '', authError: false }]);
    const runner = new ObsidianIngestRunner({ runClaude, auditStore: { record } });
    const { jobId } = runner.start('/workspace/proj', { identity: 'alex@x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed'); // no crash despite audit throw
    expect(record).toHaveBeenCalled();
  });
});

// ── Default adapter security floor (AC6) ─────────────────────────────────────

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: jest.fn(), end: jest.fn() };
  child.kill = jest.fn();
  return child;
}

describe('defaultRunClaude — security floor (AC6)', () => {
  it('spawns an argv-array with --dangerously-skip-permissions + --output-format json, API keys blocked from env', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    try {
      const child = makeFakeChild();
      const spawnFn = jest.fn(() => child);
      const promise = defaultRunClaude({
        projectPath: '/workspace/proj',
        promptArg: `${FROM_NOTES_COMMAND} /workspace/proj`,
        spawnFn,
      });

      const [cmd, argv, opts] = spawnFn.mock.calls[0];
      expect(cmd).toBe('claude');
      expect(Array.isArray(argv)).toBe(true);
      expect(argv).toContain('-p');
      expect(argv).toContain('--dangerously-skip-permissions');
      expect(argv).toEqual(expect.arrayContaining(['--output-format', 'json']));
      // The prompt is one argv element (no shell string), and no API key in child env.
      expect(argv).toContain(`${FROM_NOTES_COMMAND} /workspace/proj`);
      expect(opts.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(opts.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(opts.cwd).toBe('/workspace/proj');

      // finish the process so the promise resolves.
      child.stdout.emit('data', JSON.stringify({ result: '{"status":"done"}', session_id: 's1' }));
      child.emit('close', 0);
      const res = await promise;
      expect(res).toMatchObject({ exitCode: 0, sessionId: 's1' });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('resume passes answers via STDIN (never argv) with --resume <session-id>', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const answers = [{ id: 'q1', answer: 'geheim-fachlich' }];
    const promise = defaultRunClaude({
      projectPath: '/workspace/proj',
      resumeSessionId: 'sess-77',
      answers,
      spawnFn,
    });

    const [, argv] = spawnFn.mock.calls[0];
    expect(argv).toEqual(expect.arrayContaining(['--resume', 'sess-77']));
    expect(argv).toContain(RESUME_PROMPT);
    // The answer text is NOT in argv — it goes via stdin (AC6).
    expect(argv.join(' ')).not.toContain('geheim-fachlich');
    expect(child.stdin.write).toHaveBeenCalledWith(JSON.stringify(answers), 'utf8');

    child.stdout.emit('data', JSON.stringify({ result: '{"status":"done"}', session_id: 'sess-77' }));
    child.emit('close', 0);
    await promise;
  });

  it('reports authError on a 401 stderr signature and never returns stderr text', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const promise = defaultRunClaude({ projectPath: '/workspace/proj', promptArg: 'x', spawnFn });
    child.stderr.emit('data', 'Invalid authentication credentials at /Users/secret/path');
    child.emit('close', 1);
    const res = await promise;
    expect(res.authError).toBe(true);
    expect(res.output).not.toMatch(/secret\/path/);
  });
});

// ── Fragen-offen-Push (questions-pending-notification AC1/AC4/AC5/AC6) ──────

describe('ObsidianIngestRunner — notifyQuestionsPending wiring (AC1/AC4/AC5/AC6)', () => {
  it('AC1: fires exactly one notify call on needs-answers, with basename label + catalog length', async () => {
    const notifyQuestionsPending = jest.fn(async () => {});
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude, notifier: { notifyQuestionsPending } });

    runner.start('/workspace/proj-a');
    await flush();

    expect(notifyQuestionsPending).toHaveBeenCalledTimes(1);
    expect(notifyQuestionsPending).toHaveBeenCalledWith({ label: 'proj-a', questionCount: 2 });
  });

  it('AC1: a run that goes straight to done never calls the notifier', async () => {
    const notifyQuestionsPending = jest.fn(async () => {});
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: '{"status":"done"}', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude, notifier: { notifyQuestionsPending } });

    runner.start('/workspace/proj-a');
    await flush();

    expect(notifyQuestionsPending).not.toHaveBeenCalled();
  });

  it('AC1: a resume that surfaces a NEW needs-answers catalog fires a SECOND notify call', async () => {
    const notifyQuestionsPending = jest.fn(async () => {});
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude, notifier: { notifyQuestionsPending } });

    const { jobId } = runner.start('/workspace/proj-a');
    await flush();
    expect(notifyQuestionsPending).toHaveBeenCalledTimes(1);

    runner.answers(jobId, [{ id: 'q1', answer: 'a' }]);
    await flush();
    expect(notifyQuestionsPending).toHaveBeenCalledTimes(2);
  });

  it('AC4: a throwing/rejecting notifier never crashes the runner — needs-answers still reached, lock held', async () => {
    const lock = new ProjectJobLock();
    const notifyQuestionsPending = jest.fn(async () => { throw new Error('ntfy kaputt'); });
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude, lock, notifier: { notifyQuestionsPending } });

    const { jobId } = runner.start('/workspace/proj-a');
    await flush();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('needs-answers');
    expect(job.catalog).toHaveLength(2);
    expect(lock.isHeld('/workspace/proj-a')).toBe(true);
    expect(notifyQuestionsPending).toHaveBeenCalledTimes(1);
  });

  it('AC5: no injected notifier (default) → No-op, no crash, needs-answers unaffected', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude });

    const { jobId } = runner.start('/workspace/proj-a');
    await flush();

    expect(runner.getJob(jobId).status).toBe('needs-answers');
  });

  it('AC6: passes the basename, never the full project path, as the label', async () => {
    const notifyQuestionsPending = jest.fn(async () => {});
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude, notifier: { notifyQuestionsPending } });

    runner.start('/workspace/secret-owner/my-project');
    await flush();

    const [args] = notifyQuestionsPending.mock.calls[0];
    expect(args.label).toBe('my-project');
    expect(args.label).not.toMatch(/secret-owner/);
    expect(args.label).not.toMatch(/\//);
  });

  it('AC6: a path without a usable basename falls back to a generic placeholder (never empty/raw path)', async () => {
    const notifyQuestionsPending = jest.fn(async () => {});
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: CATALOG_OUTPUT, sessionId: 'sess-1', authError: false },
    ]);
    const runner = new ObsidianIngestRunner({ runClaude, notifier: { notifyQuestionsPending } });

    // A trailing-slash-only path has no usable basename segment.
    runner.start('/');
    await flush();

    const [args] = notifyQuestionsPending.mock.calls[0];
    expect(args.label).toBeTruthy();
    expect(args.label).not.toBe('');
    expect(args.label).not.toBe('/');
  });
});
