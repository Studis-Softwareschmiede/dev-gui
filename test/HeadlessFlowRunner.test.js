/**
 * @file HeadlessFlowRunner.test.js — Unit tests for the headless `claude -p`
 * runner with a configurable command (Default `/agent-flow:flow`).
 *
 * Covers (headless-parallel-drain): AC1, AC2, AC3, AC13
 * Covers (headless-arg-finalize-safety): AC1, AC2, AC3
 *
 *   AC1 — spawn args are an array (no shell string): ['-p', <command>,
 *         '--dangerously-skip-permissions', ...extraArgs]; default command is
 *         `/agent-flow:flow` (not reconcile); cwd = the given project path;
 *         env/auth-boundary/close/lock/job-registry semantics match
 *         HeadlessReconcileRunner 1:1 (shared HeadlessRunnerCore).
 *   AC2 — command is injectable (constructor default AND per-start override,
 *         e.g. extra `--cost <mode>` args) — not hard-wired to reconcile;
 *         HeadlessReconcileRunner keeps its exact prior behaviour (regression
 *         guard, separate describe block below).
 *   AC3 — own, much more generous configurable timeout (FLOW_HEADLESS_TIMEOUT_MS),
 *         independent of DEFAULT_RECONCILE_TIMEOUT_MS; timeout → SIGTERM + failed.
 *   AC13 — gate = unit tests with a mocked spawnFn (no real `claude -p` run).
 *
 *   headless-arg-finalize-safety AC1/AC2/AC3 — non-empty `args` (constructor
 *   default AND per-start override) are joined into the SAME single `-p` argv
 *   element as `command` (`<command> <args.join(' ')>`), never as separate argv
 *   elements — the argument-loss bug this spec fixes centrally in the shared
 *   `HeadlessRunnerCore` (see below, dedicated `HeadlessRunnerCore.test.js` for
 *   the core-level regression gate).
 *
 * Pattern: injectable `spawnFn` returning a fake EventEmitter-based child
 * process (stdout/stderr sub-emitters + kill() spy) — no real `claude` spawn.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HeadlessFlowRunner,
  DEFAULT_FLOW_COMMAND,
  DEFAULT_FLOW_HEADLESS_TIMEOUT_MS,
  buildChildEnv,
} from '../src/HeadlessFlowRunner.js';
import { DEFAULT_RECONCILE_TIMEOUT_MS } from '../src/HeadlessReconcileRunner.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../');

/** Fake child process — EventEmitter with stdout/stderr sub-emitters + a kill() spy. */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

/** Waits one microtask tick — lets the runner's internal finally/lock-release run. */
function tick() {
  return new Promise((r) => setImmediate(r));
}

describe('HeadlessFlowRunner — AC1: configurable command, default /agent-flow:flow, argv array', () => {
  it('spawns claude with the default /flow command (not reconcile) as argv array', () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    const result = runner.start('/workspace/my-project');

    expect(result.ok).toBe(true);
    expect(typeof result.jobId).toBe('string');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(['-p', '/agent-flow:flow', '--dangerously-skip-permissions']);
    expect(DEFAULT_FLOW_COMMAND).toBe('/agent-flow:flow');
    expect(opts.cwd).toBe('/workspace/my-project');
    expect(typeof opts.env).toBe('object');
  });

  it('appends configurable extra args (e.g. --cost <mode>) joined into the SAME -p argv element as the command (headless-arg-finalize-safety AC1)', () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000, args: ['--cost', 'balanced'] });

    runner.start('/workspace/my-project');

    const [, args] = spawnFn.mock.calls[0];
    // command + args are ONE argv element after '-p' — `claude -p` only accepts a
    // single prompt argument; anything passed as a separate argv element would be
    // silently dropped (docs/specs/headless-arg-finalize-safety.md AC1).
    expect(args).toEqual(['-p', '/agent-flow:flow --cost balanced', '--dangerously-skip-permissions']);
  });

  it('allows overriding command + args per start() call (not just constructor default) — still joined into one -p argv element', () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    runner.start('/workspace/my-project', { command: '/agent-flow:other', args: ['--cost', 'economical'] });

    const [, args] = spawnFn.mock.calls[0];
    expect(args).toEqual(['-p', '/agent-flow:other --cost economical', '--dangerously-skip-permissions']);
  });
});

describe('HeadlessFlowRunner — AC1/AC2: env allowlist + trust boundary (shared with reconcile)', () => {
  const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  });

  it('CLAUDE_CODE_OAUTH_TOKEN set in server process → appears in child env with value', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-live-test';
    delete process.env.ANTHROPIC_API_KEY;

    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
    runner.start('/workspace/proj-a');

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-live-test');
  });

  it('ANTHROPIC_API_KEY set in server process → NEVER appears in child env (trust boundary)', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-value';
    process.env.ANTHROPIC_API_KEY = 'sk-secret-must-not-leak';

    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
    runner.start('/workspace/proj-b');

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-value');
    expect('ANTHROPIC_API_KEY' in opts.env).toBe(false);
    expect(JSON.stringify(opts.env)).not.toMatch(/sk-secret-must-not-leak/);
  });

  it('OPENAI_API_KEY never appears in child env either', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', OPENAI_API_KEY: 'sk-openai-secret' });
    expect('OPENAI_API_KEY' in env).toBe(false);
  });
});

describe('HeadlessFlowRunner — 401 precedence over clean exit 0 (auth-expired)', () => {
  it('"401" in stdout with a CLEAN exit (0) → auth-expired, not done', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-401');
    child.stdout.emit('data', 'Error: request failed with status 401\n');
    child.emit('close', 0);
    await tick();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('auth-expired');
    expect(job.status).not.toBe('done');
  });

  it('non-zero exit WITHOUT any 401 signature → generic failed (no auth-expired misclassification)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-plain-fail');
    child.stderr.emit('data', 'some unrelated error, no path or secret here\n');
    child.emit('close', 1);
    await tick();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).not.toMatch(/401|Invalid authentication credentials/i);
  });
});

describe('HeadlessFlowRunner — close-event = only completion source (AC1)', () => {
  it('close(0) sets job status to "done" deterministically (no idle timer)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-done');
    expect(runner.getJob(jobId).status).toBe('running');

    child.emit('close', 0);
    await tick();

    expect(runner.getJob(jobId).status).toBe('done');
  });
});

describe('HeadlessFlowRunner — AC3: own, much larger, independent timeout default', () => {
  it('DEFAULT_FLOW_HEADLESS_TIMEOUT_MS is deliberately much larger than DEFAULT_RECONCILE_TIMEOUT_MS', () => {
    expect(DEFAULT_FLOW_HEADLESS_TIMEOUT_MS).toBeGreaterThan(DEFAULT_RECONCILE_TIMEOUT_MS);
    // Not accidentally coupled to (equal to / derived from) the reconcile constant.
    expect(DEFAULT_FLOW_HEADLESS_TIMEOUT_MS).not.toBe(DEFAULT_RECONCILE_TIMEOUT_MS);
  });

  it('exceeding timeoutMs → SIGTERM + job status "failed"', async () => {
    const child = makeFakeChild(); // never emits 'close' — simulates a runaway process
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 20 });

    const { jobId } = runner.start('/workspace/proj-timeout');

    await new Promise((r) => setTimeout(r, 60));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(typeof job.error).toBe('string');
  });

  it('honours the FLOW_HEADLESS_TIMEOUT_MS env var when no explicit timeoutMs is passed', async () => {
    const saved = process.env.FLOW_HEADLESS_TIMEOUT_MS;
    process.env.FLOW_HEADLESS_TIMEOUT_MS = '25';
    try {
      const child = makeFakeChild();
      const spawnFn = jest.fn(() => child);
      const runner = new HeadlessFlowRunner({ spawnFn });

      const { jobId } = runner.start('/workspace/proj-env-timeout');
      await new Promise((r) => setTimeout(r, 70));

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(runner.getJob(jobId).status).toBe('failed');
    } finally {
      if (saved === undefined) delete process.env.FLOW_HEADLESS_TIMEOUT_MS;
      else process.env.FLOW_HEADLESS_TIMEOUT_MS = saved;
    }
  });

  it('kill on an already-exited process is a no-op — first terminal state wins (race edge-case)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 20 });

    const { jobId } = runner.start('/workspace/proj-race');
    child.emit('close', 0);
    await new Promise((r) => setTimeout(r, 60));

    expect(runner.getJob(jobId).status).toBe('done');
  });
});

describe('HeadlessFlowRunner — ProjectJobLock: per-project lock + finally release (AC1)', () => {
  it('rejects a second start() for the SAME project path while one is running', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    const first = runner.start('/workspace/proj-lock');
    expect(first.ok).toBe(true);

    const second = runner.start('/workspace/proj-lock');
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('locked');
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT block a start() for a DIFFERENT project path', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    const a = runner.start('/workspace/proj-a-lock');
    const b = runner.start('/workspace/proj-b-lock');

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('releases the lock after the job ends — a new start() for the same path succeeds', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    const first = runner.start('/workspace/proj-reuse');
    expect(first.ok).toBe(true);

    child.emit('close', 0);
    await tick();

    const second = runner.start('/workspace/proj-reuse');
    expect(second.ok).toBe(true);
  });

  it('releases the lock even when the runner throws mid-flight (crash/exception discipline)', async () => {
    const spawnFn = jest.fn(() => {
      throw new Error('forced spawn exception');
    });
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    const first = runner.start('/workspace/proj-crash');
    expect(first.ok).toBe(true); // job accepted; failure happens inside the async run
    await tick();

    expect(runner.getJob(first.jobId).status).toBe('failed');

    const second = runner.start('/workspace/proj-crash');
    expect(second.ok).toBe(true);
  });
});

describe('HeadlessFlowRunner — Job-Registry: getJob(jobId) shape', () => {
  it('getJob returns undefined for an unknown jobId', () => {
    const runner = new HeadlessFlowRunner({ spawnFn: jest.fn(() => makeFakeChild()), timeoutMs: 10_000 });
    expect(runner.getJob('unknown-job-id')).toBeUndefined();
  });

  it('getJob returns {status:"running"} immediately after start()', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-registry');
    expect(runner.getJob(jobId)).toEqual(
      expect.objectContaining({ status: 'running' }),
    );
  });
});

describe('HeadlessFlowRunner — Edge-Case: claude not in PATH (ENOENT)', () => {
  it('emits a generic "claude nicht verfügbar" failure, no crash, lock released', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-enoent');
    const err = new Error('spawn claude ENOENT');
    err.code = 'ENOENT';
    child.emit('error', err);
    await tick();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/claude nicht verfügbar/);

    const retry = runner.start('/workspace/proj-enoent');
    expect(retry.ok).toBe(true);
  });
});

describe('HeadlessFlowRunner — separated from the interactive PTY path', () => {
  it('src/HeadlessFlowRunner.js does not import PtyManager, PtySessionRegistry, or CommandService', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/HeadlessFlowRunner.js'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/PtyManager\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/PtySessionRegistry\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/CommandService\.js['"]/);
  });

  it('src/HeadlessRunnerCore.js does not import PtyManager, PtySessionRegistry, or CommandService', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/HeadlessRunnerCore.js'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/PtyManager\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/PtySessionRegistry\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/CommandService\.js['"]/);
  });
});
