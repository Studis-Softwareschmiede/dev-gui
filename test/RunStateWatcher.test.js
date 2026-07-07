/**
 * RunStateWatcher.test.js — Unit tests for RunStateWatcher
 * (run-state-live-view AC4, AC5, S-316)
 *
 * Covers (run-state-live-view):
 *   AC4 — Jede Schreiboperation des Feature-Drains an state.yaml führt (über den
 *          periodischen Snapshot-Diff, analog NotificationWatcher) zu genau EINEM
 *          BoardEventHub.broadcast({ slug }) je betroffenem Projekt.
 *   AC5 — Das Frame bleibt { slug } (getestet via boardEventHub-Mock-Argument);
 *          der Producer feuert NICHT im Ruhezustand (keine Änderung → kein
 *          Broadcast) und NICHT beim Baseline-/Erst-Scan.
 *
 * Strategy: mock boardAggregator.getIndex() + mock boardEventHub.broadcast().
 * No real timers used in the check()-level tests (start()/stop() interval
 * plumbing is trivial and shares the well-tested NotificationWatcher pattern).
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  RunStateWatcher,
  buildRunStateSnapshot,
  detectRunStateChanges,
} from '../src/RunStateWatcher.js';

function makeIndexEntry(slug, runs) {
  return { slug, project_slug: slug, error: null, runs };
}

function run(overrides = {}) {
  return {
    feature: 'F-069',
    phase: 'story',
    currentStory: 'S-1',
    done: 1,
    total: 5,
    round: 1,
    startedAt: '2026-07-07T00:00:00Z',
    lastError: null,
    isLastRun: false,
    ...overrides,
  };
}

describe('buildRunStateSnapshot', () => {
  it('produces an empty fingerprint for a project with no runs', () => {
    const index = [makeIndexEntry('dev-gui', [])];
    const snap = buildRunStateSnapshot(index);
    expect(snap).toEqual({ 'dev-gui': '' });
  });

  it('produces a non-empty, stable fingerprint for a project with runs', () => {
    const index = [makeIndexEntry('dev-gui', [run()])];
    const snap1 = buildRunStateSnapshot(index);
    const snap2 = buildRunStateSnapshot(index);
    expect(snap1['dev-gui']).not.toBe('');
    expect(snap1['dev-gui']).toBe(snap2['dev-gui']);
  });

  it('skips error entries', () => {
    const index = [{ slug: 'broken', error: 'board.yaml fehlt', runs: [] }];
    const snap = buildRunStateSnapshot(index);
    expect(snap).toEqual({});
  });
});

describe('detectRunStateChanges', () => {
  it('detects a project whose fingerprint changed', () => {
    const changed = detectRunStateChanges({ 'dev-gui': 'a' }, { 'dev-gui': 'b' });
    expect(changed.has('dev-gui')).toBe(true);
    expect(changed.size).toBe(1);
  });

  it('ignores a project with an unchanged fingerprint', () => {
    const changed = detectRunStateChanges({ 'dev-gui': 'a' }, { 'dev-gui': 'a' });
    expect(changed.size).toBe(0);
  });

  it('detects a newly appeared project (run started)', () => {
    const changed = detectRunStateChanges({}, { 'dev-gui': 'a' });
    expect(changed.has('dev-gui')).toBe(true);
  });

  it('detects a project whose runs disappeared (run finished/last-run compacted)', () => {
    const changed = detectRunStateChanges({ 'dev-gui': 'a' }, { 'dev-gui': '' });
    expect(changed.has('dev-gui')).toBe(true);
  });
});

describe('RunStateWatcher.check() — AC5: Baseline-Scan löst KEIN Broadcast aus', () => {
  it('the first check() establishes the baseline without broadcasting', async () => {
    const boardEventHub = { broadcast: jest.fn() };
    const boardAggregator = {
      getIndex: jest.fn(async () => [makeIndexEntry('dev-gui', [run()])]),
    };
    const watcher = new RunStateWatcher({ boardAggregator, boardEventHub });

    await watcher.check();

    expect(boardEventHub.broadcast).not.toHaveBeenCalled();
  });
});

describe('RunStateWatcher.check() — AC4: Änderung löst genau EINEN Broadcast je Projekt aus', () => {
  it('a changed run-state triggers exactly one broadcast({ slug }) for that project', async () => {
    const boardEventHub = { broadcast: jest.fn() };
    let index = [makeIndexEntry('dev-gui', [run({ done: 1 })])];
    const boardAggregator = { getIndex: jest.fn(async () => index) };
    const watcher = new RunStateWatcher({ boardAggregator, boardEventHub });

    await watcher.check(); // baseline
    expect(boardEventHub.broadcast).not.toHaveBeenCalled();

    index = [makeIndexEntry('dev-gui', [run({ done: 2 })])]; // Feature-Drain schrieb state.yaml
    await watcher.check();

    expect(boardEventHub.broadcast).toHaveBeenCalledTimes(1);
    expect(boardEventHub.broadcast).toHaveBeenCalledWith({ slug: 'dev-gui' });
  });

  it('multiple changed projects each get their own broadcast', async () => {
    const boardEventHub = { broadcast: jest.fn() };
    let index = [
      makeIndexEntry('dev-gui', [run({ done: 1 })]),
      makeIndexEntry('agent-flow', [run({ done: 1 })]),
    ];
    const boardAggregator = { getIndex: jest.fn(async () => index) };
    const watcher = new RunStateWatcher({ boardAggregator, boardEventHub });

    await watcher.check(); // baseline

    index = [
      makeIndexEntry('dev-gui', [run({ done: 2 })]),
      makeIndexEntry('agent-flow', [run({ done: 1 })]), // unchanged
    ];
    await watcher.check();

    expect(boardEventHub.broadcast).toHaveBeenCalledTimes(1);
    expect(boardEventHub.broadcast).toHaveBeenCalledWith({ slug: 'dev-gui' });
  });
});

describe('RunStateWatcher.check() — AC5: Ruhezustand feuert nicht', () => {
  it('an unchanged run-state does not broadcast on the second check', async () => {
    const boardEventHub = { broadcast: jest.fn() };
    const boardAggregator = {
      getIndex: jest.fn(async () => [makeIndexEntry('dev-gui', [run()])]),
    };
    const watcher = new RunStateWatcher({ boardAggregator, boardEventHub });

    await watcher.check(); // baseline
    await watcher.check(); // no change

    expect(boardEventHub.broadcast).not.toHaveBeenCalled();
  });
});

describe('RunStateWatcher.check() — Fehlertoleranz', () => {
  it('a board-scan error does not crash check() and does not broadcast', async () => {
    const boardEventHub = { broadcast: jest.fn() };
    const boardAggregator = {
      getIndex: jest.fn(async () => {
        throw new Error('scan failed');
      }),
    };
    const watcher = new RunStateWatcher({ boardAggregator, boardEventHub });

    await expect(watcher.check()).resolves.toBeUndefined();
    expect(boardEventHub.broadcast).not.toHaveBeenCalled();
  });

  it('a broadcast error for one project does not stop broadcasting to others', async () => {
    let index = [
      makeIndexEntry('dev-gui', [run({ done: 1 })]),
      makeIndexEntry('agent-flow', [run({ done: 1 })]),
    ];
    const boardAggregator = { getIndex: jest.fn(async () => index) };
    const boardEventHub = {
      broadcast: jest.fn(({ slug }) => {
        if (slug === 'dev-gui') throw new Error('write failed');
      }),
    };
    const watcher = new RunStateWatcher({ boardAggregator, boardEventHub });
    await watcher.check(); // baseline

    index = [
      makeIndexEntry('dev-gui', [run({ done: 2 })]),
      makeIndexEntry('agent-flow', [run({ done: 2 })]),
    ];
    await expect(watcher.check()).resolves.toBeUndefined();

    expect(boardEventHub.broadcast).toHaveBeenCalledWith({ slug: 'dev-gui' });
    expect(boardEventHub.broadcast).toHaveBeenCalledWith({ slug: 'agent-flow' });
  });

  it('is null-tolerant when boardEventHub is not provided', async () => {
    let index = [makeIndexEntry('dev-gui', [run({ done: 1 })])];
    const boardAggregator = { getIndex: jest.fn(async () => index) };
    const watcher = new RunStateWatcher({ boardAggregator, boardEventHub: null });

    await watcher.check(); // baseline
    index = [makeIndexEntry('dev-gui', [run({ done: 2 })])];
    await expect(watcher.check()).resolves.toBeUndefined();
  });
});

describe('RunStateWatcher — start()/stop() lifecycle', () => {
  it('start() schedules periodic checks and stop() clears them (no crash, idempotent)', () => {
    jest.useFakeTimers();
    const boardEventHub = { broadcast: jest.fn() };
    const boardAggregator = { getIndex: jest.fn(async () => []) };
    const watcher = new RunStateWatcher({ boardAggregator, boardEventHub, intervalMs: 1000 });

    watcher.start();
    watcher.stop();
    watcher.stop(); // idempotent — no throw

    jest.useRealTimers();
  });
});
