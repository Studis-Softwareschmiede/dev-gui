/**
 * FeatureDrainRunner.test.js — Unit-Tests für den Feature-Batch-Spawn-Wrapper
 * (feature-umsetzen-button, Owner-Auftrag 2026-07-06).
 *
 * Covers: register vor Spawn, Skript-Pfad + Argumente korrekt zusammengebaut
 * (mit/ohne appName), close(0)->markDone+Lock-Release, close(3)->markFailed
 * mit Blockade-Text+Lock-Release, close(1)->markFailed generisch+Lock-Release,
 * spawn-error->markFailed+Lock-Release.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { FeatureDrainRunner } from '../src/FeatureDrainRunner.js';

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeDeps() {
  const registry = {
    register: jest.fn(),
    markDone: jest.fn(),
    markFailed: jest.fn(),
  };
  const lock = { release: jest.fn() };
  const spawned = { child: null, cmd: null, args: null, opts: null };
  const spawnFn = jest.fn((cmd, args, opts) => {
    spawned.cmd = cmd; spawned.args = args; spawned.opts = opts;
    spawned.child = makeChild();
    return spawned.child;
  });
  return { registry, lock, spawnFn, spawned };
}

describe('FeatureDrainRunner', () => {
  it('registriert VOR dem Spawn und baut Skript-Pfad + Argumente korrekt zusammen (mit appName)', () => {
    const { registry, lock, spawnFn, spawned } = makeDeps();
    const runner = new FeatureDrainRunner({ registry, lock, spawnFn });
    runner.start({
      projectSlug: 'dev-gui', repoPath: '/repo/dev-gui', featureId: 'F-042',
      appName: 'dev-gui-dev-gui-1', agentFlowScriptsDir: '/plugin/scripts',
    });
    expect(registry.register).toHaveBeenCalledWith('dev-gui', 'F-042');
    expect(spawned.cmd).toBe('bash');
    expect(spawned.args).toEqual(['/plugin/scripts/board-feature-drain.sh', 'F-042', 'dev-gui-dev-gui-1']);
    expect(spawned.opts.cwd).toBe('/repo/dev-gui');
  });

  it('ohne appName: nur Skript + Feature-ID als Argumente', () => {
    const { registry, lock, spawnFn, spawned } = makeDeps();
    const runner = new FeatureDrainRunner({ registry, lock, spawnFn });
    runner.start({ projectSlug: 'dev-gui', repoPath: '/repo', featureId: 'F-001', agentFlowScriptsDir: '/plugin/scripts' });
    expect(spawned.args).toEqual(['/plugin/scripts/board-feature-drain.sh', 'F-001']);
  });

  it('close(0) -> markDone + Lock-Release', () => {
    const { registry, lock, spawnFn, spawned } = makeDeps();
    const runner = new FeatureDrainRunner({ registry, lock, spawnFn });
    runner.start({ projectSlug: 'dev-gui', repoPath: '/repo', featureId: 'F-001', agentFlowScriptsDir: '/s' });
    spawned.child.emit('close', 0);
    expect(registry.markDone).toHaveBeenCalledWith('dev-gui', 'F-001');
    expect(lock.release).toHaveBeenCalledWith('dev-gui:F-001');
  });

  it('close(3) -> markFailed mit Blockade-Text + Lock-Release (kein Fehlschlag im engeren Sinn)', () => {
    const { registry, lock, spawnFn, spawned } = makeDeps();
    const runner = new FeatureDrainRunner({ registry, lock, spawnFn });
    runner.start({ projectSlug: 'dev-gui', repoPath: '/repo', featureId: 'F-001', agentFlowScriptsDir: '/s' });
    spawned.child.emit('close', 3);
    expect(registry.markFailed).toHaveBeenCalledWith('dev-gui', 'F-001', expect.stringContaining('blockiert'));
    expect(lock.release).toHaveBeenCalledWith('dev-gui:F-001');
  });

  it('close(1) -> markFailed generisch + Lock-Release', () => {
    const { registry, lock, spawnFn, spawned } = makeDeps();
    const runner = new FeatureDrainRunner({ registry, lock, spawnFn });
    runner.start({ projectSlug: 'dev-gui', repoPath: '/repo', featureId: 'F-001', agentFlowScriptsDir: '/s' });
    spawned.child.emit('close', 1);
    expect(registry.markFailed).toHaveBeenCalledWith('dev-gui', 'F-001', expect.stringContaining('1'));
    expect(lock.release).toHaveBeenCalledWith('dev-gui:F-001');
  });

  it('spawn-error -> markFailed + Lock-Release', () => {
    const { registry, lock, spawnFn, spawned } = makeDeps();
    const runner = new FeatureDrainRunner({ registry, lock, spawnFn });
    runner.start({ projectSlug: 'dev-gui', repoPath: '/repo', featureId: 'F-001', agentFlowScriptsDir: '/s' });
    spawned.child.emit('error', new Error('ENOENT'));
    expect(registry.markFailed).toHaveBeenCalledWith('dev-gui', 'F-001', expect.stringContaining('ENOENT'));
    expect(lock.release).toHaveBeenCalledWith('dev-gui:F-001');
  });

  it('close(1) mit stderr-Ausgabe -> markFailed enthält den Ausgabe-Ausschnitt (2026-07-06-Vorfall)', () => {
    const { registry, lock, spawnFn, spawned } = makeDeps();
    const runner = new FeatureDrainRunner({ registry, lock, spawnFn });
    runner.start({ projectSlug: 'dev-gui', repoPath: '/repo', featureId: 'F-001', agentFlowScriptsDir: '/s' });
    spawned.child.stderr.emit('data', Buffer.from('ModuleNotFoundError: No module named \'yaml\'\n'));
    spawned.child.emit('close', 1);
    expect(registry.markFailed).toHaveBeenCalledWith('dev-gui', 'F-001', expect.stringContaining('ModuleNotFoundError'));
  });

  it('Ausgabe-Ausschnitt wird auf 2000 Zeichen gedeckelt (kein unbegrenzter Speicherverbrauch)', () => {
    const { registry, lock, spawnFn, spawned } = makeDeps();
    const runner = new FeatureDrainRunner({ registry, lock, spawnFn });
    runner.start({ projectSlug: 'dev-gui', repoPath: '/repo', featureId: 'F-001', agentFlowScriptsDir: '/s' });
    spawned.child.stdout.emit('data', Buffer.from('x'.repeat(5000)));
    spawned.child.emit('close', 1);
    const [, , message] = registry.markFailed.mock.calls[0];
    expect(message.length).toBeLessThanOrEqual(2000 + 'Exit-Code 1 — '.length);
  });
});
