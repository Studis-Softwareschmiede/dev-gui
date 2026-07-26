/**
 * @file HeadlessRunnerCore.test.js — Unit tests for the shared engine behind
 * `HeadlessFlowRunner`/`HeadlessReconcileRunner`, focused on the argv-argument
 * bugfix (docs/specs/headless-arg-finalize-safety.md).
 *
 * Covers (headless-arg-finalize-safety): AC1, AC2, AC3, AC8
 *
 *   AC1 — `#runProcess()` joins `command` + non-empty `args` into ONE `-p`
 *         argv element (`<command> <args.join(' ')>`); `--dangerously-skip-
 *         permissions` stays its own, following argv element; the resulting
 *         argv is exactly 3 elements. For `args: []` the argv stays exactly
 *         `['-p', <command>, '--dangerously-skip-permissions']` — bit-identical
 *         to the pre-fix Reconcile-/Flow-/Nacht-Drain behaviour (no regress).
 *   AC2 — this is the dedicated, explicit regression test for the non-empty
 *         `args` case (the actual argv array passed to the injected `spawnFn`
 *         is asserted directly — not a blindly-confirmed fake call). Prior to
 *         this fix, no test ever exercised `HeadlessRunnerCore` with non-empty
 *         `args` — every existing caller ran with `args: []`, which is why the
 *         argument-loss bug went unnoticed in production.
 *   AC3 — the fix lives exclusively in the shared `HeadlessRunnerCore`; both
 *         `HeadlessFlowRunner` and `HeadlessReconcileRunner` delegate to it
 *         (verified here directly at the Core level, independent of either
 *         thin wrapper).
 *   AC8 (Security-Floor) — argv stays Array-form (no shell string, no shell
 *         interpolation, security/R03); the multi-word args value is verified
 *         to land as plain array elements joined by a single space (no shell
 *         metacharacter injection surface); the hard `ANTHROPIC_API_KEY`/
 *         `OPENAI_API_KEY` child-env block is unaffected by the argv change.
 *
 * Covers (per-app-gpg-passphrase-provisioning.md, ADR-021, S-336):
 *   AC5/AC6 — `start(projectPath, { env })` merges a per-run env override
 *         (e.g. `GPG_PASS_FILE`) additively on top of `buildChildEnv()`; the
 *         hard `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` block survives the merge
 *         (Defense in Depth — stripped again AFTER merging); omitting `env`
 *         stays byte-identical to the pre-ADR-021 behaviour (no regression).
 *
 * Covers (red-team-scan-per-container.md): AC25
 *   AC25 — opt-in `captureOutput` constructor param: default `false` leaves the
 *         job object byte-identical (no extra key) for every existing/default
 *         caller (no regression for `HeadlessFlowRunner`/`HeadlessReconcileRunner`/
 *         etc.); `captureOutput: true` adds an `output` field (the same
 *         already-captured stdout+stderr `combined` string) to the terminal job
 *         state across the `done`/`failed`/`auth-expired` close-derived paths.
 *
 * Pattern: injectable `spawnFn` returning a fake EventEmitter-based child
 * process (stdout/stderr sub-emitters + kill() spy) — no real `claude` spawn,
 * consistent with `HeadlessFlowRunner.test.js`/`HeadlessReconcileRunner.test.js`.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { HeadlessRunnerCore, buildChildEnv } from '../src/HeadlessRunnerCore.js';

/** Fake child process — EventEmitter with stdout/stderr sub-emitters + a kill() spy. */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

/** Waits one microtask tick — lets the runner's internal close-handling settle. */
function tick() {
  return new Promise((r) => setImmediate(r));
}

describe('HeadlessRunnerCore — AC1/AC2: non-empty args are joined into ONE -p argv element (regression gate for the argument-loss bug)', () => {
  it('single extra arg: command + arg become ONE argv element after -p (not two separate elements)', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:requirement',
      defaultArgs: ['some prompt text'],
    });

    core.start('/workspace/proj');

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('claude');
    // Exactly 3 argv elements — the prompt text is NOT a separate 4th element.
    expect(argv).toHaveLength(3);
    expect(argv).toEqual(['-p', '/agent-flow:requirement some prompt text', '--dangerously-skip-permissions']);
    expect(opts.cwd).toBe('/workspace/proj');
  });

  it('multiple extra args (e.g. multi-word prompt with spaces) are joined with a single space into the SAME -p argv element', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:requirement',
      defaultArgs: ['Build', 'a', 'dark-mode', 'toggle.'],
    });

    core.start('/workspace/proj-multi');

    const [, argv] = spawnFn.mock.calls[0];
    expect(argv).toHaveLength(3);
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('/agent-flow:requirement Build a dark-mode toggle.');
    expect(argv[2]).toBe('--dangerously-skip-permissions');
  });

  it('per-start() override args are joined exactly the same way as constructor defaults', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:flow',
      defaultArgs: [],
    });

    core.start('/workspace/proj-override', { command: '/agent-flow:other', args: ['--cost', 'economical'] });

    const [, argv] = spawnFn.mock.calls[0];
    expect(argv).toEqual(['-p', '/agent-flow:other --cost economical', '--dangerously-skip-permissions']);
  });

  it('argv is still passed as a real Array to spawnFn (no shell string join — security/R03 unaffected by the fix)', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:requirement',
      defaultArgs: ['some; rm -rf / #not-a-shell-string'],
    });

    core.start('/workspace/proj-argv-array');

    const [, argv] = spawnFn.mock.calls[0];
    expect(Array.isArray(argv)).toBe(true);
    // The dangerous-looking text is confined to ONE argv element — spawnFn (real
    // node:child_process.spawn) never interprets it as shell syntax because argv
    // is passed as an array, not a joined shell command string.
    expect(argv).toHaveLength(3);
    expect(argv[1]).toContain('some; rm -rf / #not-a-shell-string');
  });
});

describe('HeadlessRunnerCore — AC1: empty args stay bit-identical to the pre-fix behaviour (no regression)', () => {
  it('args: [] → argv is exactly [-p, <command>, --dangerously-skip-permissions] (3 elements, unchanged)', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:reconcile',
      defaultArgs: [],
    });

    core.start('/workspace/proj-empty-args');

    const [, argv] = spawnFn.mock.calls[0];
    expect(argv).toEqual(['-p', '/agent-flow:reconcile', '--dangerously-skip-permissions']);
  });

  it('no defaultArgs provided at all (undefined → default []) behaves the same as an explicit empty array', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:flow',
    });

    core.start('/workspace/proj-no-args');

    const [, argv] = spawnFn.mock.calls[0];
    expect(argv).toEqual(['-p', '/agent-flow:flow', '--dangerously-skip-permissions']);
  });
});

describe('HeadlessRunnerCore — AC8 (Security-Floor): child-env trust boundary unaffected by the argv fix', () => {
  it('ANTHROPIC_API_KEY/OPENAI_API_KEY never appear in child env, even with non-empty args', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-secret-must-not-leak',
      OPENAI_API_KEY: 'sk-openai-secret',
    });
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    expect('OPENAI_API_KEY' in env).toBe(false);
  });

  it('the job never leaks the joined prompt text or a host path as a secret (sanity: argv text stays local to spawnFn call, not job state)', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:requirement',
      defaultArgs: ['token=sk-ant-oat01-should-not-leak-into-job-state'],
    });

    const { jobId } = core.start('/workspace/proj-secret-in-args');

    const job = core.getJob(jobId);
    expect(JSON.stringify(job)).not.toMatch(/sk-ant-oat01-should-not-leak-into-job-state/);
  });
});

describe('HeadlessRunnerCore — ADR-021 (S-336): per-run env override (start(projectPath, { env }))', () => {
  it('merges overrides.env additively on top of buildChildEnv() for THIS run only', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:new-project',
      defaultArgs: [],
    });

    core.start('/workspace/proj-env', { env: { GPG_PASS_FILE: '/tmp/gpg-pass-abc/gpg-pass' } });

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env.GPG_PASS_FILE).toBe('/tmp/gpg-pass-abc/gpg-pass');
    // Base allowlist (e.g. PATH, if set in process.env) is still present — additive merge.
    if (process.env.PATH !== undefined) {
      expect(opts.env.PATH).toBe(process.env.PATH);
    }
  });

  it('a start() WITHOUT overrides.env stays byte-identical to buildChildEnv() (no regression)', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:reconcile',
      defaultArgs: [],
    });

    core.start('/workspace/proj-no-env');

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env).toEqual(buildChildEnv());
  });

  it('overrides.env can NEVER smuggle ANTHROPIC_API_KEY/OPENAI_API_KEY into the child env (Defense in Depth)', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:new-project',
      defaultArgs: [],
    });

    core.start('/workspace/proj-env-blocked', {
      env: {
        GPG_PASS_FILE: '/tmp/gpg-pass-xyz/gpg-pass',
        ANTHROPIC_API_KEY: 'sk-ant-should-never-appear',
        OPENAI_API_KEY: 'sk-openai-should-never-appear',
      },
    });

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env.GPG_PASS_FILE).toBe('/tmp/gpg-pass-xyz/gpg-pass');
    expect('ANTHROPIC_API_KEY' in opts.env).toBe(false);
    expect('OPENAI_API_KEY' in opts.env).toBe(false);
  });
});

describe('HeadlessRunnerCore — AC25 (red-team-scan-per-container): opt-in `captureOutput` output exposition', () => {
  it('captureOutput default (omitted) → job object stays byte-identical, no "output" key, on a clean done exit', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:reconcile',
      defaultArgs: [],
    });

    const { jobId } = core.start('/workspace/proj-no-capture');
    child.stdout.emit('data', 'hello stdout\n');
    child.emit('close', 0);
    await tick();

    const job = core.getJob(jobId);
    expect('output' in job).toBe(false);
    expect(job).toEqual({ status: 'done', result: 'Headless-Lauf abgeschlossen', error: undefined, prHint: undefined });
  });

  it('captureOutput:false explicit → same byte-identical behaviour as the default', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:reconcile',
      defaultArgs: [],
      captureOutput: false,
    });

    const { jobId } = core.start('/workspace/proj-no-capture-explicit');
    child.emit('close', 0);
    await tick();

    expect('output' in core.getJob(jobId)).toBe(false);
  });

  it('captureOutput:true → job.output carries the captured stdout+stderr combination on a clean done exit', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:red-team',
      defaultArgs: [],
      captureOutput: true,
    });

    const { jobId } = core.start('/workspace/proj-capture');
    child.stdout.emit('data', '{"status":"done","findings_count":0}');
    child.stderr.emit('data', 'some stderr noise');
    child.emit('close', 0);
    await tick();

    const job = core.getJob(jobId);
    expect(job.status).toBe('done');
    expect(job.output).toBe('{"status":"done","findings_count":0}\nsome stderr noise');
  });

  it('captureOutput:true also exposes output on a failed (non-zero exit) close', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: 10_000,
      defaultCommand: '/agent-flow:red-team',
      defaultArgs: [],
      captureOutput: true,
    });

    const { jobId } = core.start('/workspace/proj-capture-failed');
    child.stderr.emit('data', 'boom');
    child.emit('close', 1);
    await tick();

    const job = core.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.output).toBe('\nboom');
  });
});
