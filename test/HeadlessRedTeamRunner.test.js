/**
 * @file HeadlessRedTeamRunner.test.js — Unit tests for the headless
 * `claude -p` red-team job runner (docs/specs/red-team-tile.md AC1).
 *
 * Deckt ab:
 *   (a) start(path, {ziel:'foo', modus:'beide'}) spawnt `claude` mit `-p` und dem
 *       Prompt-argv, das `/agent-flow:red-team ziel=foo modus=beide` enthält.
 *   (b) ohne modus → nur `ziel=foo` im Prompt-argv.
 *   (c) Lock: zweiter start() auf denselben Pfad → { ok:false, reason:'locked' }.
 *   (d) Timeout-env RED_TEAM_TIMEOUT_MS wird berücksichtigt.
 *   (e) fehlendes `ziel` → TypeError.
 *
 * Pattern (aus HeadlessReconcileRunner.test.js übernommen): injectable `spawnFn`
 * liefert einen fake EventEmitter-Kindprozess (stdout/stderr sub-emitters +
 * kill() spy) — kein echter `claude`-Lauf.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  HeadlessRedTeamRunner,
  DEFAULT_RED_TEAM_TIMEOUT_MS,
} from '../src/HeadlessRedTeamRunner.js';

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

describe('HeadlessRedTeamRunner — AC1 (a): start with ziel + modus → prompt argv', () => {
  it('spawns claude with -p and a single prompt argv "/agent-flow:red-team ziel=foo modus=beide"', () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessRedTeamRunner({ spawnFn, timeoutMs: 10_000 });

    const result = runner.start('/workspace/my-project', { ziel: 'foo', modus: 'beide' });

    expect(result.ok).toBe(true);
    expect(typeof result.jobId).toBe('string');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(Array.isArray(args)).toBe(true);
    // command + args werden zu EINEM zusammenhängenden `-p`-argv-Element zusammengesetzt.
    expect(args).toEqual(['-p', '/agent-flow:red-team ziel=foo modus=beide', '--dangerously-skip-permissions']);
    expect(opts.cwd).toBe('/workspace/my-project');
    expect(typeof opts.env).toBe('object');
  });
});

describe('HeadlessRedTeamRunner — AC1 (b): start without modus → only ziel', () => {
  it('spawns a prompt argv "/agent-flow:red-team ziel=foo" (no modus segment)', () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessRedTeamRunner({ spawnFn, timeoutMs: 10_000 });

    const result = runner.start('/workspace/my-project', { ziel: 'foo' });

    expect(result.ok).toBe(true);
    const [, args] = spawnFn.mock.calls[0];
    expect(args).toEqual(['-p', '/agent-flow:red-team ziel=foo', '--dangerously-skip-permissions']);
    expect(args[1]).not.toMatch(/modus=/);
  });
});

describe('HeadlessRedTeamRunner — AC1 (c): per-project lock', () => {
  it('rejects a second start() for the SAME project path while one is running', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessRedTeamRunner({ spawnFn, timeoutMs: 10_000 });

    const first = runner.start('/workspace/proj-lock', { ziel: 'foo' });
    expect(first.ok).toBe(true);

    const second = runner.start('/workspace/proj-lock', { ziel: 'bar' });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('locked');
    // Kein zweiter Kindprozess für den abgewiesenen start.
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT block a start() for a DIFFERENT project path', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessRedTeamRunner({ spawnFn, timeoutMs: 10_000 });

    const a = runner.start('/workspace/proj-a-lock', { ziel: 'foo' });
    const b = runner.start('/workspace/proj-b-lock', { ziel: 'foo' });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('releases the lock after the job ends — a new start() for the same path succeeds', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessRedTeamRunner({ spawnFn, timeoutMs: 10_000 });

    const first = runner.start('/workspace/proj-reuse', { ziel: 'foo' });
    expect(first.ok).toBe(true);

    child.emit('close', 0);
    await tick();

    const second = runner.start('/workspace/proj-reuse', { ziel: 'foo' });
    expect(second.ok).toBe(true);
  });
});

describe('HeadlessRedTeamRunner — AC1 (d): RED_TEAM_TIMEOUT_MS env honoured', () => {
  const savedTimeout = process.env.RED_TEAM_TIMEOUT_MS;

  afterEach(() => {
    if (savedTimeout === undefined) delete process.env.RED_TEAM_TIMEOUT_MS;
    else process.env.RED_TEAM_TIMEOUT_MS = savedTimeout;
  });

  it('uses RED_TEAM_TIMEOUT_MS from the environment when no explicit timeoutMs is given', async () => {
    process.env.RED_TEAM_TIMEOUT_MS = '20'; // 20 ms → schneller Runaway-Abbruch
    const child = makeFakeChild(); // emittiert nie 'close' → simuliert einen hängenden Prozess
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessRedTeamRunner({ spawnFn }); // kein timeoutMs → env greift

    const { jobId } = runner.start('/workspace/proj-timeout', { ziel: 'foo' });

    await new Promise((r) => setTimeout(r, 60));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(typeof job.error).toBe('string');
  });

  it('falls back to DEFAULT_RED_TEAM_TIMEOUT_MS when the env var is unset', () => {
    delete process.env.RED_TEAM_TIMEOUT_MS;
    // Reiner Sanity-Check der Konstante — der Default-Pfad wird ohne env verwendet.
    expect(DEFAULT_RED_TEAM_TIMEOUT_MS).toBe(15 * 60 * 1000);
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessRedTeamRunner({ spawnFn });
    // Ein Start ohne env darf nicht sofort in den Timeout laufen (grosszügiger Default).
    const result = runner.start('/workspace/proj-default', { ziel: 'foo' });
    expect(result.ok).toBe(true);
  });
});

describe('HeadlessRedTeamRunner — AC1 (e): missing ziel → TypeError', () => {
  it('throws a TypeError when ziel is missing entirely', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessRedTeamRunner({ spawnFn, timeoutMs: 10_000 });

    expect(() => runner.start('/workspace/proj-no-ziel')).toThrow(TypeError);
    // Kein Kindprozess bei ungültigem Aufruf.
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('throws a TypeError when ziel is an empty string', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessRedTeamRunner({ spawnFn, timeoutMs: 10_000 });

    expect(() => runner.start('/workspace/proj-empty-ziel', { ziel: '' })).toThrow(TypeError);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
