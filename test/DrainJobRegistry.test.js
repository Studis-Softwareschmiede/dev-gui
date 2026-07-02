/**
 * DrainJobRegistry.test.js — Unit-Tests der In-Memory-Drain-Job-Registry
 * (docs/specs/headless-manual-drain.md AC4).
 *
 * Covers (headless-manual-drain):
 *   AC4 — Registry-Verhalten (register→running, markDone→done+Ergebnis-
 *          Zusammenfassung, markFailed→failed+generischer Text, getJob→undefined
 *          für unbekannte drainId). Die HTTP-Naht (GET/POST, Status-Codes) ist
 *          zusätzlich in test/projectDrainRouter.test.js abgedeckt.
 *
 * Covers (drain-completion-report):
 *   AC7 — markDone() reicht `completed`/`blocked` (AC1-Felder aus
 *          `ProjectDrain.drainProject()`) unverändert im `result` durch, damit
 *          die manuelle Inline-Status-Fläche (CockpitView) sie ohne
 *          Zusatz-Request zeigen kann; fehlend/ungültig → `[]` (kein Crash).
 */

import { describe, it, expect } from '@jest/globals';
import { DrainJobRegistry, DRAIN_FAILURE_MESSAGE } from '../src/DrainJobRegistry.js';

describe('DrainJobRegistry (headless-manual-drain AC4)', () => {
  it('register() → status "running"', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    expect(reg.getJob('d1')).toEqual({ status: 'running' });
  });

  it('getJob() → undefined für unbekannte drainId (→ 404 auf HTTP-Ebene)', () => {
    const reg = new DrainJobRegistry();
    expect(reg.getJob('nope')).toBeUndefined();
  });

  it('markDone() → status "done" mit secret-freier Ergebnis-Zusammenfassung', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markDone('d1', { stopped: true, reason: 'no-drain-target', flowRuns: 3, escalated: ['S-7'] });
    expect(reg.getJob('d1')).toEqual({
      status: 'done',
      result: { reason: 'no-drain-target', flowRuns: 3, escalated: ['S-7'], completed: [], blocked: [] },
    });
  });

  it('markDone() normalisiert fehlende/ungültige Felder defensiv', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markDone('d1', {});
    expect(reg.getJob('d1')).toEqual({
      status: 'done',
      result: { reason: 'stopped', flowRuns: 0, escalated: [], completed: [], blocked: [] },
    });
  });

  it('markDone() ohne Argument (undefined) crasht nicht', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markDone('d1');
    expect(reg.getJob('d1')).toEqual({
      status: 'done',
      result: { reason: 'stopped', flowRuns: 0, escalated: [], completed: [], blocked: [] },
    });
  });

  // ── drain-completion-report AC7: completed/blocked durchgereicht ───────────

  it('markDone() reicht completed/blocked (drain-completion-report AC1) unverändert durch', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markDone('d1', {
      reason: 'no-drain-target',
      flowRuns: 2,
      escalated: [],
      completed: [{ id: 'S-1', title: 'Eins' }],
      blocked: [{ id: 'S-9', title: 'Neun' }],
    });
    expect(reg.getJob('d1').result.completed).toEqual([{ id: 'S-1', title: 'Eins' }]);
    expect(reg.getJob('d1').result.blocked).toEqual([{ id: 'S-9', title: 'Neun' }]);
  });

  it('markDone() normalisiert ungültige completed/blocked (kein Array) auf []', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markDone('d1', { reason: 'x', flowRuns: 0, completed: 'not-an-array', blocked: null });
    expect(reg.getJob('d1').result.completed).toEqual([]);
    expect(reg.getJob('d1').result.blocked).toEqual([]);
  });

  it('markFailed() → status "failed" mit generischem Default-Text (kein Roh-Fehler)', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markFailed('d1');
    expect(reg.getJob('d1')).toEqual({ status: 'failed', error: DRAIN_FAILURE_MESSAGE });
  });

  it('markDone()/markFailed() auf unbekannte drainId ist ein No-op (kein Eintrag entsteht)', () => {
    const reg = new DrainJobRegistry();
    reg.markDone('ghost', { reason: 'x' });
    reg.markFailed('ghost2');
    expect(reg.getJob('ghost')).toBeUndefined();
    expect(reg.getJob('ghost2')).toBeUndefined();
  });

  it('terminaler Zustand überschreibt running (running → done)', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    expect(reg.getJob('d1').status).toBe('running');
    reg.markDone('d1', { reason: 'no-drain-target', flowRuns: 1, escalated: [] });
    expect(reg.getJob('d1').status).toBe('done');
  });
});
