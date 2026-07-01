/**
 * @file HeadlessReconcileRunner.test.js — Unit tests for the headless
 * `claude -p` reconcile job runner.
 *
 * Covers (headless-reconcile-runner): AC1, AC2, AC3, AC4, AC5, AC6, AC7
 *
 *   AC1 — spawn args are an array (no shell string): ['-p','/agent-flow:reconcile',
 *         '--dangerously-skip-permissions']; cwd = the resolved project path.
 *   AC2 — CLAUDE_CODE_OAUTH_TOKEN present in child env (with value) iff set in
 *         the server process; ANTHROPIC_API_KEY never appears, even when set.
 *   AC3 — close(0) → job status deterministically 'done'; stdout/stderr are
 *         captured during the run (best-effort prHint extraction proves it).
 *   AC4 — exceeding timeoutMs → SIGTERM + job status 'failed' (timeout reason).
 *   AC5 — second start() for the SAME project path while running → rejected
 *         ('locked'); a DIFFERENT project path is not blocked; lock is released
 *         after job end AND after a forced exception (try/finally discipline).
 *   AC6 — 401 / "Invalid authentication credentials" in stdout/stderr (even with
 *         a clean exit 0) → 'auth-expired' (not 'done', not 'failed'), with the
 *         renewal hint; no token value ever appears in the job's error text.
 *   AC7 — structural regression guard: the runner module never imports
 *         PtyManager / PtySessionRegistry / CommandService (getrennter Pfad).
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
  HeadlessReconcileRunner,
  buildChildEnv,
  isAuthError,
  extractPrHint,
  AUTH_EXPIRED_MESSAGE,
} from '../src/HeadlessReconcileRunner.js';

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

describe('buildChildEnv — AC2: minimal allowlist + CLAUDE_CODE_OAUTH_TOKEN, never ANTHROPIC_API_KEY', () => {
  it('includes CLAUDE_CODE_OAUTH_TOKEN with its value when set', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test');
  });

  it('omits the key entirely when CLAUDE_CODE_OAUTH_TOKEN is not set (no empty entry)', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' });
    expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false);
  });

  it('never includes ANTHROPIC_API_KEY, even when set alongside CLAUDE_CODE_OAUTH_TOKEN', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value',
      ANTHROPIC_API_KEY: 'sk-secret-should-never-leak',
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-value');
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });

  it('never includes OPENAI_API_KEY', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', OPENAI_API_KEY: 'sk-openai-secret' });
    expect('OPENAI_API_KEY' in env).toBe(false);
  });

  it('carries base plumbing keys (PATH/HOME) when present', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', HOME: '/home/dev' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/dev');
  });
});

describe('isAuthError / extractPrHint — pure helpers (AC6/AC9)', () => {
  it('detects "401" in combined output', () => {
    expect(isAuthError(1, 'some prose 401 more text')).toBe(true);
  });

  it('detects "Invalid authentication credentials" (case-insensitive)', () => {
    expect(isAuthError(0, 'ERROR: invalid authentication credentials for claude')).toBe(true);
  });

  it('returns false when neither exit code nor output show an auth signature', () => {
    expect(isAuthError(1, 'some unrelated failure text')).toBe(false);
  });

  it('extracts a GitHub PR URL when present', () => {
    const hint = extractPrHint('Opened PR: https://github.com/acme/repo/pull/42 done.');
    expect(hint).toBe('https://github.com/acme/repo/pull/42');
  });

  it('falls back to a #number mention when no full URL is present', () => {
    expect(extractPrHint('See #123 for details.')).toBe('#123');
  });

  it('returns undefined (graceful absence) when nothing PR-related is found', () => {
    expect(extractPrHint('Nothing to see here.')).toBeUndefined();
  });
});

describe('HeadlessReconcileRunner — AC1: spawn args as array + resolved cwd', () => {
  it('spawns claude with argv array and cwd = resolved project path', () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const result = runner.start('/workspace/my-project');

    expect(result.ok).toBe(true);
    expect(typeof result.jobId).toBe('string');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(['-p', '/agent-flow:reconcile', '--dangerously-skip-permissions']);
    expect(opts.cwd).toBe('/workspace/my-project');
    expect(typeof opts.env).toBe('object');
  });
});

describe('HeadlessReconcileRunner — AC2: spawn env passthrough + trust boundary', () => {
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
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });
    runner.start('/workspace/proj-a');

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-live-test');
  });

  it('CLAUDE_CODE_OAUTH_TOKEN unset → key absent from child env (no empty entry)', () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });
    runner.start('/workspace/proj-b');

    const [, , opts] = spawnFn.mock.calls[0];
    expect('CLAUDE_CODE_OAUTH_TOKEN' in opts.env).toBe(false);
  });

  it('ANTHROPIC_API_KEY set in server process → NEVER appears in child env (trust boundary)', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-value';
    process.env.ANTHROPIC_API_KEY = 'sk-secret-must-not-leak';

    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });
    runner.start('/workspace/proj-c');

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-value');
    expect('ANTHROPIC_API_KEY' in opts.env).toBe(false);
    expect(JSON.stringify(opts.env)).not.toMatch(/sk-secret-must-not-leak/);
  });
});

describe('HeadlessReconcileRunner — AC3: process-exit = done (deterministic, no idle timer)', () => {
  it('close(0) sets job status to "done"; captured output is available (prHint extraction)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-done');
    expect(runner.getJob(jobId).status).toBe('running');

    child.stdout.emit('data', 'Reconcile finished. PR: https://github.com/acme/repo/pull/7\n');
    child.emit('close', 0);
    await tick();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('done');
    expect(job.prHint).toBe('https://github.com/acme/repo/pull/7');
  });

  it('drains stderr without throwing (no pipe blockage) even on a clean exit', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-stderr');
    expect(() => child.stderr.emit('data', 'some warning output\n')).not.toThrow();
    child.emit('close', 0);
    await tick();

    expect(runner.getJob(jobId).status).toBe('done');
  });
});

describe('HeadlessReconcileRunner — AC4: runaway timeout → SIGTERM + failed', () => {
  it('terminates the child and sets status "failed" after the timeout window', async () => {
    const child = makeFakeChild(); // never emits 'close' — simulates a runaway process
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 20 });

    const { jobId } = runner.start('/workspace/proj-timeout');

    await new Promise((r) => setTimeout(r, 60));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(typeof job.error).toBe('string');
  });

  it('kill on an already-exited process is a no-op — first terminal state wins (race edge-case)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 20 });

    const { jobId } = runner.start('/workspace/proj-race');
    // Process closes cleanly BEFORE the timeout fires.
    child.emit('close', 0);
    await new Promise((r) => setTimeout(r, 60)); // let the timeout window pass too

    const job = runner.getJob(jobId);
    // First terminal state (done) wins — no overwrite by the later timeout.
    expect(job.status).toBe('done');
  });
});

describe('HeadlessReconcileRunner — AC5: per-project lock + try/finally release', () => {
  it('rejects a second start() for the SAME project path while one is running', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const first = runner.start('/workspace/proj-lock');
    expect(first.ok).toBe(true);

    const second = runner.start('/workspace/proj-lock');
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('locked');
    // No second child was spawned for the rejected start.
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT block a start() for a DIFFERENT project path', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const a = runner.start('/workspace/proj-a-lock');
    const b = runner.start('/workspace/proj-b-lock');

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('releases the lock after the job ends — a new start() for the same path succeeds', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

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
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const first = runner.start('/workspace/proj-crash');
    expect(first.ok).toBe(true); // job accepted; failure happens inside the async run
    await tick();

    expect(runner.getJob(first.jobId).status).toBe('failed');

    // Lock must be free again — a second start for the same path now succeeds.
    const second = runner.start('/workspace/proj-crash');
    expect(second.ok).toBe(true);
  });
});

describe('HeadlessReconcileRunner — AC6: 401 detection → auth-expired (never done/failed)', () => {
  it('"401" in stdout with a CLEAN exit (0) → auth-expired, not done (401 takes precedence)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-401');
    child.stdout.emit('data', 'Error: request failed with status 401\n');
    child.emit('close', 0);
    await tick();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('auth-expired');
    expect(job.status).not.toBe('done');
    expect(job.error).toBe(AUTH_EXPIRED_MESSAGE);
    expect(job.error).toMatch(/claude setup-token/);
  });

  it('"Invalid authentication credentials" in stderr with a non-zero exit → auth-expired, not failed', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-401b');
    child.stderr.emit('data', 'Invalid authentication credentials\n');
    child.emit('close', 1);
    await tick();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('auth-expired');
    expect(job.status).not.toBe('failed');
  });

  it('never leaks a token value found in the captured output into the job error text', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-401c');
    child.stdout.emit('data', 'token=sk-ant-oat01-should-not-leak 401 Unauthorized\n');
    child.emit('close', 1);
    await tick();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('auth-expired');
    expect(job.error).not.toMatch(/sk-ant-oat01-should-not-leak/);
  });

  it('non-zero exit WITHOUT any 401 signature → generic failed (no auth-expired misclassification)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-plain-fail');
    child.stderr.emit('data', 'some unrelated error, no path or secret here\n');
    child.emit('close', 1);
    await tick();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).not.toMatch(/401|Invalid authentication credentials/i);
  });
});

describe('HeadlessReconcileRunner — Edge-Case: claude not in PATH (ENOENT)', () => {
  it('emits a generic "claude nicht verfügbar" failure, no crash, lock released', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessReconcileRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace/proj-enoent');
    const err = new Error('spawn claude ENOENT');
    err.code = 'ENOENT';
    child.emit('error', err);
    await tick();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/claude nicht verfügbar/);

    // Lock released — a retry for the same path is accepted.
    const retry = runner.start('/workspace/proj-enoent');
    expect(retry.ok).toBe(true);
  });
});

describe('HeadlessReconcileRunner — AC7: separated from the interactive PTY path', () => {
  it('src/HeadlessReconcileRunner.js does not import PtyManager, PtySessionRegistry, or CommandService', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/HeadlessReconcileRunner.js'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/PtyManager\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/PtySessionRegistry\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/CommandService\.js['"]/);
  });

  it('src/reconcileRouter.js does not import PtyManager, PtySessionRegistry, or CommandService', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/reconcileRouter.js'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/PtyManager\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/PtySessionRegistry\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/CommandService\.js['"]/);
  });
});
