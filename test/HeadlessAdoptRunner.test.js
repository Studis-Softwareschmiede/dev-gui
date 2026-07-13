/**
 * @file HeadlessAdoptRunner.test.js — Unit tests for the headless
 * `/agent-flow:adopt <owner/repo>` job runner.
 *
 * Covers (per-app-gpg-passphrase-provisioning.md, F-073/S-343):
 *   AC12 — `start(projectPath, { args })` spawns `claude -p '/agent-flow:adopt
 *          <owner/repo>' --dangerously-skip-permissions` (argv-Array, kein
 *          Shell-String), `cwd` = der übergebene (Workspace-Root-)Pfad, über
 *          eine EIGENE `ProjectJobLock`-Instanz (zwei Instanzen blockieren sich
 *          NICHT beim selben Pfad — Fremd-/Selbstblockade-Vermeidung).
 *          Fire-and-forget: `start()` liefert synchron `{ok, jobId}` bzw.
 *          `{ok:false, reason:'locked'}` — kein Warten auf den Lauf.
 *   AC14 — Struktur-Regressionsschutz: der Runner importiert/mutiert weder
 *          `PtyManager` noch `PtySessionRegistry` noch `CommandService` (der
 *          bestehende PTY-Fallback in AdoptSection.jsx bleibt unangetastet).
 *
 * `HeadlessRunnerCore` (spawn/env/timeout/lock/close-Semantik, 401-Erkennung
 * etc.) ist bereits vollständig in `test/HeadlessRunnerCore.test.js` /
 * `test/HeadlessReconcileRunner.test.js` abgedeckt — dieser Test fokussiert
 * NUR auf die Adopt-spezifische Verdrahtung (Befehl, Argument-Durchreichung,
 * eigene Lock-Instanz), keine Duplikation der Core-Tests (targeted self-test).
 *
 * Pattern: injectable `spawnFn` returning a fake EventEmitter-based child
 * process (stdout/stderr sub-emitters + kill() spy) — no real `claude` spawn.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadlessAdoptRunner, ADOPT_COMMAND } from '../src/HeadlessAdoptRunner.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../');

/** Fake child process — EventEmitter with stdout/stderr sub-emitters + a kill() spy. */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function tick() {
  return new Promise((r) => setImmediate(r));
}

describe('HeadlessAdoptRunner — AC12: spawn argv + cwd + argument passthrough', () => {
  it('spawns claude with the adopt command + owner/repo joined into ONE -p prompt arg, cwd = projectPath', () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessAdoptRunner({ spawnFn, timeoutMs: 10_000 });

    const result = runner.start('/workspace', { args: ['acme/some-repo'] });

    expect(result.ok).toBe(true);
    expect(typeof result.jobId).toBe('string');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual(['-p', `${ADOPT_COMMAND} acme/some-repo`, '--dangerously-skip-permissions']);
    expect(opts.cwd).toBe('/workspace');
  });

  it('close(0) → job status "done"', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessAdoptRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace', { args: ['acme/other-repo'] });
    child.emit('close', 0);
    await tick();

    expect(runner.getJob(jobId).status).toBe('done');
  });

  it('non-zero exit → job status "failed"', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessAdoptRunner({ spawnFn, timeoutMs: 10_000 });

    const { jobId } = runner.start('/workspace', { args: ['acme/broken-repo'] });
    child.emit('close', 1);
    await tick();

    expect(runner.getJob(jobId).status).toBe('failed');
  });
});

describe('HeadlessAdoptRunner — per-project lock (own instance, no cross-blocking)', () => {
  it('rejects a second start() for the SAME projectPath while one is running (locked)', () => {
    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessAdoptRunner({ spawnFn, timeoutMs: 10_000 });

    const first = runner.start('/workspace', { args: ['acme/repo-a'] });
    expect(first.ok).toBe(true);

    const second = runner.start('/workspace', { args: ['acme/repo-b'] });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('locked');
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('constructor defaults to its OWN fresh ProjectJobLock instance — a lock held by an unrelated runner does not block it', () => {
    const foreignLock = new ProjectJobLock();
    foreignLock.tryAcquire('/workspace'); // simulate an unrelated headless runner holding a lock

    const spawnFn = jest.fn(() => makeFakeChild());
    const runner = new HeadlessAdoptRunner({ spawnFn, timeoutMs: 10_000 }); // no `lock` injected → own instance

    const result = runner.start('/workspace', { args: ['acme/repo-c'] });
    expect(result.ok).toBe(true);
  });
});

describe('HeadlessAdoptRunner — AC14: separated from the interactive PTY path', () => {
  it('src/HeadlessAdoptRunner.js does not import PtyManager, PtySessionRegistry, or CommandService', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/HeadlessAdoptRunner.js'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/PtyManager\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/PtySessionRegistry\.js['"]/);
    expect(source).not.toMatch(/from ['"]\.\/CommandService\.js['"]/);
  });
});
