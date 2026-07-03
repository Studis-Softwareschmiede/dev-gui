/**
 * @file AutoRetroTrigger.test.js — Unit-Tests der Fälligkeits-Prüfung +
 * best-effort Auslösung an der Drain-Abschluss-Naht
 * (docs/specs/retro-auto-trigger.md, S-261).
 *
 * Covers (retro-auto-trigger): AC4, AC5, AC6, AC7
 *
 *   AC4 — best-effort/fire-and-forget: `notifyDrainComplete` gibt sofort synchron
 *         zurück und wirft NIE — ein Settings-Read-Fehler, ein werfender Queue-
 *         `enqueue`/`isPendingOrActive` oder ein Audit-Fehler crasht die Naht
 *         NICHT (kein unhandled reject). (Die Naht-Verdrahtung selbst ist in
 *         test/NightWatchScheduler.test.js + test/projectDrainRouter.test.js
 *         abgedeckt — hier die Trigger-Seite.)
 *   AC5 — `isRetroDue(projectPath, drainResult)` liefert `true` GENAU DANN, wenn
 *         (a) `readSettings().enabled === true` UND (b) `drainResult.flowRuns ≥ 1`
 *         UND (c) `queue.isPendingOrActive(projectPath) === false`. (a) false →
 *         false (kein Enqueue). (b) false (`flowRuns == 0`/fehlt) → false. (c)
 *         true (bereits eingereiht/laufend) → false. Settings-Read-Fehler → false.
 *   AC6 — bei `isRetroDue == true` wird das Repo GENAU EINMAL `enqueue`d (nicht
 *         direkt gestartet) + secret-freier Enqueue-Audit (nur Repo-Slug, kein
 *         Host-Pfad). Bei `isRetroDue == false` KEIN Enqueue. (`--force`/G3-Bypass
 *         sitzt im HeadlessRetroRunner, nicht hier — Nicht-Ziel dieser Boundary.)
 *   AC7 — Schalter aus (`enabled:false`, Default) → weder `isRetroDue` true noch
 *         Enqueue (heutiges Verhalten bleibt).
 *
 * Kein echter Retro-/`claude -p`-Lauf: die `queue` ist ein kontrollierbarer Stub
 * (die serielle Ausführung liegt in RetroAutoQueue/HeadlessRetroRunner — eigene
 * Tests; Trennung Policy/Mechanismus, Spec-Nicht-Ziel).
 */

import { describe, it, expect, jest } from '@jest/globals';
import { AutoRetroTrigger } from '../src/AutoRetroTrigger.js';

/** Flush aller pending Microtasks (der Enqueue läuft in einem abgekoppelten Microtask). */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Kontrollierbare Fake-Queue mit steuerbarem `isPendingOrActive`. */
function makeQueue({ pendingOrActive = false } = {}) {
  return {
    enqueue: jest.fn(),
    isPendingOrActive: jest.fn(() => pendingOrActive),
  };
}

function makeTrigger(overrides = {}) {
  const settings = overrides.settings ?? { enabled: true };
  const readSettings = overrides.readSettings ?? jest.fn(async () => settings);
  const queue = overrides.queue ?? makeQueue();
  const auditStore = overrides.auditStore ?? { record: jest.fn() };
  const trigger = new AutoRetroTrigger({
    readSettings,
    queue,
    auditStore,
    identity: overrides.identity ?? null,
  });
  return { trigger, readSettings, queue, auditStore };
}

// ── Konstruktor-Guards ──────────────────────────────────────────────────────────

describe('AutoRetroTrigger — Konstruktor-Guards', () => {
  it('wirft ohne readSettings-Funktion', () => {
    expect(() => new AutoRetroTrigger({ queue: makeQueue() })).toThrow(/readSettings/);
  });

  it('wirft ohne taugliche queue (enqueue/isPendingOrActive)', () => {
    expect(() => new AutoRetroTrigger({ readSettings: async () => ({ enabled: true }) })).toThrow(/queue/);
    expect(
      () => new AutoRetroTrigger({ readSettings: async () => ({ enabled: true }), queue: { enqueue: () => {} } }),
    ).toThrow(/queue/);
  });
});

// ── isRetroDue (AC5, AC7) ────────────────────────────────────────────────────────

describe('AutoRetroTrigger.isRetroDue (AC5, AC7)', () => {
  it('AC5 — true, wenn enabled==true UND flowRuns>=1 UND nicht pending/aktiv', async () => {
    const { trigger, queue } = makeTrigger({ settings: { enabled: true }, queue: makeQueue({ pendingOrActive: false }) });
    await expect(trigger.isRetroDue('/ws/proj-a', { flowRuns: 1 })).resolves.toBe(true);
    expect(queue.isPendingOrActive).toHaveBeenCalledWith('/ws/proj-a');
  });

  it('AC7 — enabled==false (Default) → false (kein Enqueue)', async () => {
    const { trigger, queue } = makeTrigger({ settings: { enabled: false } });
    await expect(trigger.isRetroDue('/ws/proj-a', { flowRuns: 5 })).resolves.toBe(false);
    // Bei ausgeschaltetem Schalter wird die Dedup-Abfrage gar nicht erst nötig.
    expect(queue.isPendingOrActive).not.toHaveBeenCalled();
  });

  it('AC5(b) — flowRuns==0 → false (nichts Neues zu destillieren)', async () => {
    const { trigger } = makeTrigger({ settings: { enabled: true } });
    await expect(trigger.isRetroDue('/ws/proj-a', { flowRuns: 0 })).resolves.toBe(false);
  });

  it('AC5(b) — fehlendes/ungültiges flowRuns → false', async () => {
    const { trigger } = makeTrigger({ settings: { enabled: true } });
    await expect(trigger.isRetroDue('/ws/proj-a', {})).resolves.toBe(false);
    await expect(trigger.isRetroDue('/ws/proj-a', { flowRuns: 'x' })).resolves.toBe(false);
    await expect(trigger.isRetroDue('/ws/proj-a', undefined)).resolves.toBe(false);
  });

  it('AC5(c) — bereits eingereiht/laufend → false (Dedup)', async () => {
    const { trigger } = makeTrigger({ settings: { enabled: true }, queue: makeQueue({ pendingOrActive: true }) });
    await expect(trigger.isRetroDue('/ws/proj-a', { flowRuns: 3 })).resolves.toBe(false);
  });

  it('AC5 — ungültiger projectPath → false', async () => {
    const { trigger } = makeTrigger({ settings: { enabled: true } });
    await expect(trigger.isRetroDue('', { flowRuns: 3 })).resolves.toBe(false);
    await expect(trigger.isRetroDue('   ', { flowRuns: 3 })).resolves.toBe(false);
    await expect(trigger.isRetroDue(null, { flowRuns: 3 })).resolves.toBe(false);
  });

  it('AC4/AC5 — Settings-Read-Fehler → false (non-fatal, kein Throw)', async () => {
    const { trigger } = makeTrigger({
      readSettings: jest.fn(async () => {
        throw new Error('read failed');
      }),
    });
    await expect(trigger.isRetroDue('/ws/proj-a', { flowRuns: 3 })).resolves.toBe(false);
  });

  it('AC4 — werfendes isPendingOrActive → false (non-fatal)', async () => {
    const queue = {
      enqueue: jest.fn(),
      isPendingOrActive: jest.fn(() => {
        throw new Error('dedup kaputt');
      }),
    };
    const { trigger } = makeTrigger({ settings: { enabled: true }, queue });
    await expect(trigger.isRetroDue('/ws/proj-a', { flowRuns: 3 })).resolves.toBe(false);
  });
});

// ── notifyDrainComplete → Enqueue (AC4, AC6, AC7) ──────────────────────────────────

describe('AutoRetroTrigger.notifyDrainComplete → Enqueue (AC4, AC6, AC7)', () => {
  it('AC6 — fällig → genau EIN enqueue(projectPath) + secret-freier Enqueue-Audit', async () => {
    const { trigger, queue, auditStore } = makeTrigger({ settings: { enabled: true } });
    trigger.notifyDrainComplete('/workspace/proj-a', { flowRuns: 2 });
    await flush();

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith('/workspace/proj-a');
    // Audit: nur der Repo-Slug (Basename), KEIN absoluter Host-Pfad.
    expect(auditStore.record).toHaveBeenCalledTimes(1);
    const auditArg = auditStore.record.mock.calls[0][0];
    expect(auditArg.command).toContain('repo=proj-a');
    expect(auditArg.command).not.toContain('/workspace/');
  });

  it('AC7 — Schalter aus → KEIN enqueue, KEIN Enqueue-Audit', async () => {
    const { trigger, queue, auditStore } = makeTrigger({ settings: { enabled: false } });
    trigger.notifyDrainComplete('/workspace/proj-a', { flowRuns: 9 });
    await flush();
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(auditStore.record).not.toHaveBeenCalled();
  });

  it('AC5(b)/AC6 — flowRuns==0 → KEIN enqueue', async () => {
    const { trigger, queue } = makeTrigger({ settings: { enabled: true } });
    trigger.notifyDrainComplete('/workspace/proj-a', { flowRuns: 0 });
    await flush();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('AC6 — bereits eingereiht/laufend → KEIN zweiter enqueue (Dedup)', async () => {
    const { trigger, queue } = makeTrigger({ settings: { enabled: true }, queue: makeQueue({ pendingOrActive: true }) });
    trigger.notifyDrainComplete('/workspace/proj-a', { flowRuns: 4 });
    await flush();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('AC4 — gibt sofort synchron zurück (fire-and-forget, blockiert nicht)', () => {
    const { trigger, queue } = makeTrigger({
      settings: { enabled: true },
      // readSettings, das nie resolved → notifyDrainComplete darf trotzdem sofort zurückkehren.
      readSettings: jest.fn(() => new Promise(() => {})),
    });
    // Kein await: der Aufruf kehrt synchron zurück, ohne auf den (hängenden) Read zu warten.
    expect(trigger.notifyDrainComplete('/workspace/proj-a', { flowRuns: 2 })).toBeUndefined();
    expect(queue.enqueue).not.toHaveBeenCalled(); // Read hängt → noch kein Enqueue
  });

  it('AC4 — Settings-Read-Fehler crasht die Naht NICHT (kein unhandled reject, kein Enqueue)', async () => {
    const { trigger, queue } = makeTrigger({
      readSettings: jest.fn(async () => {
        throw new Error('read failed');
      }),
    });
    expect(() => trigger.notifyDrainComplete('/workspace/proj-a', { flowRuns: 2 })).not.toThrow();
    await flush();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('AC4 — werfendes enqueue crasht die Naht NICHT (best-effort)', async () => {
    const queue = {
      enqueue: jest.fn(() => {
        throw new Error('enqueue kaputt');
      }),
      isPendingOrActive: jest.fn(() => false),
    };
    const { trigger } = makeTrigger({ settings: { enabled: true }, queue });
    expect(() => trigger.notifyDrainComplete('/workspace/proj-a', { flowRuns: 2 })).not.toThrow();
    await flush();
    expect(queue.enqueue).toHaveBeenCalledTimes(1); // versucht, aber der Fehler wird geschluckt
  });

  it('AC4/AC6 — werfender auditStore crasht die Naht NICHT; enqueue passiert trotzdem', async () => {
    const auditStore = {
      record: jest.fn(() => {
        throw new Error('audit kaputt');
      }),
    };
    const { trigger, queue } = makeTrigger({ settings: { enabled: true }, auditStore });
    expect(() => trigger.notifyDrainComplete('/workspace/proj-a', { flowRuns: 2 })).not.toThrow();
    await flush();
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('AC6 — ohne auditStore läuft der Enqueue unverändert (No-op-Audit)', async () => {
    const queue = makeQueue();
    const trigger = new AutoRetroTrigger({ readSettings: async () => ({ enabled: true }), queue });
    expect(() => trigger.notifyDrainComplete('/workspace/proj-a', { flowRuns: 2 })).not.toThrow();
    await flush();
    expect(queue.enqueue).toHaveBeenCalledWith('/workspace/proj-a');
  });
});
