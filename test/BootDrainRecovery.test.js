/**
 * BootDrainRecovery.test.js — Unit-Tests des Boot-Wiederanlaufs verwaister Drains
 * (docs/specs/drain-restart-robustness.md AC5–AC8, S-283).
 *
 * Covers (drain-restart-robustness):
 *   AC5 — Dedup pro `(project, trigger)`: mehrere verwaiste Einträge desselben
 *          Projekts/Triggers ⇒ genau ein Wiederanlauf-Drain (`groupOrphansByProjectTrigger`
 *          + `run()` ruft `drainProject()` je Gruppe genau einmal).
 *   AC6 — Manueller Orphan: automatischer Wiederanlauf über die manuelle
 *          `ProjectDrain`-Instanz, Replay der persistierten `args` 1:1, frischer
 *          `running`-Eintrag (neue `drainId`); vorherige lesende `isProjectBusy`-
 *          Prüfung (busy → kein Doppel-Start, kein `drainProject()`-Aufruf).
 *   AC7 — Nacht-Orphan: Wiederanlauf über die Nacht-`ProjectDrain`-Instanz NUR
 *          wenn Boot-Zeitpunkt im Nachtfenster UND Nacht-Modus aktiv UND Auth
 *          nicht `expired`; sonst kein Boot-Lauf (kein `drainProject()`-Aufruf).
 *   AC8 — Best-effort/degradierend: ein Fehler bei Slug-Auflösung/Pfad-
 *          Validierung/Store-I/O/Drain-Start wird pro Projekt gefangen, die
 *          übrigen Projekte laufen weiter; `run()` wirft nie; leeres
 *          Orphan-Array ⇒ idempotenter No-op (kein Aufruf irgendeiner Boundary).
 *
 * Kein echter `claude -p`-Lauf — `manualProjectDrain`/`nightProjectDrain` sind
 * vollständig gemockt (NFR Testbarkeit).
 *
 * @module BootDrainRecovery.test
 */

import { jest } from '@jest/globals';
import { BootDrainRecovery, groupOrphansByProjectTrigger } from '../src/BootDrainRecovery.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';

function makeRegistry() {
  return {
    register: jest.fn(() => Promise.resolve()),
    markDone: jest.fn(() => Promise.resolve()),
    markFailed: jest.fn(() => Promise.resolve()),
  };
}

function makeProjectDrain(result = { reason: 'no-drain-target', flowRuns: 0 }) {
  return { drainProject: jest.fn(() => Promise.resolve(result)) };
}

describe('groupOrphansByProjectTrigger (AC5)', () => {
  it('gruppiert nach (project, trigger); mehrere Einträge desselben Projekts/Triggers -> nur einer bleibt (letzter gewinnt)', () => {
    const entries = [
      { drainId: 'a', project: 'proj1', trigger: 'manual', args: ['--cost', 'low-cost'] },
      { drainId: 'b', project: 'proj1', trigger: 'manual', args: ['--cost', 'frontier'] },
      { drainId: 'c', project: 'proj2', trigger: 'night' },
      { drainId: 'd', project: 'proj1', trigger: 'night' },
    ];
    const { manual, night } = groupOrphansByProjectTrigger(entries);
    expect(manual.size).toBe(1);
    expect(manual.get('proj1').drainId).toBe('b'); // letzter gewinnt
    expect(night.size).toBe(2);
    expect(night.get('proj2').drainId).toBe('c');
    expect(night.get('proj1').drainId).toBe('d');
  });

  it('überspringt Einträge ohne gültigen project-String oder mit unbekanntem trigger', () => {
    const entries = [
      { drainId: 'a', project: '', trigger: 'manual' },
      { drainId: 'b', project: 'proj1', trigger: 'unknown' },
      { drainId: 'c', trigger: 'manual' },
      null,
    ];
    const { manual, night } = groupOrphansByProjectTrigger(entries);
    expect(manual.size).toBe(0);
    expect(night.size).toBe(0);
  });

  it('nicht-Array Input -> leere Maps (defensiv)', () => {
    const { manual, night } = groupOrphansByProjectTrigger(undefined);
    expect(manual.size).toBe(0);
    expect(night.size).toBe(0);
  });
});

describe('BootDrainRecovery — Manueller Orphan (AC6)', () => {
  it('startet automatisch einen Wiederanlauf über manualProjectDrain, repliziert args 1:1, registriert einen frischen running-Eintrag', async () => {
    const drainJobRegistry = makeRegistry();
    const manualProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain,
      nightProjectDrain: makeProjectDrain(),
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
      now: () => 1000,
    });

    await recovery.run([
      { drainId: 'old-1', project: 'my-repo', trigger: 'manual', args: ['--cost', 'frontier'], status: 'aborted' },
    ]);

    expect(manualProjectDrain.drainProject).toHaveBeenCalledTimes(1);
    expect(manualProjectDrain.drainProject).toHaveBeenCalledWith('/workspace/my-repo', expect.objectContaining({ args: ['--cost', 'frontier'] }));

    expect(drainJobRegistry.register).toHaveBeenCalledTimes(1);
    const [newDrainId, meta] = drainJobRegistry.register.mock.calls[0];
    expect(newDrainId).not.toBe('old-1'); // frische drainId
    expect(meta).toEqual(expect.objectContaining({ project: 'my-repo', trigger: 'manual', args: ['--cost', 'frontier'] }));
  });

  it('markiert den neuen Eintrag done/failed passend zum drainProject()-Ausgang', async () => {
    const drainJobRegistry = makeRegistry();
    const okDrain = makeProjectDrain({ reason: 'no-drain-target', flowRuns: 2 });
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain: okDrain,
      nightProjectDrain: makeProjectDrain(),
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
    });
    await recovery.run([{ project: 'ok-repo', trigger: 'manual', status: 'aborted' }]);
    // drainProject() resolved -> markDone async (Promise-Chain), einmal awaiten:
    await new Promise((r) => setImmediate(r));
    expect(drainJobRegistry.markDone).toHaveBeenCalledTimes(1);

    const failDrain = { drainProject: jest.fn(() => Promise.reject(new Error('boom'))) };
    const recovery2 = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain: failDrain,
      nightProjectDrain: makeProjectDrain(),
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
    });
    await recovery2.run([{ project: 'fail-repo', trigger: 'manual', status: 'aborted' }]);
    await new Promise((r) => setImmediate(r));
    expect(drainJobRegistry.markFailed).toHaveBeenCalledTimes(1);
  });

  it('isProjectBusy=true (Lock bereits gehalten) -> kein Doppel-Start, kein drainProject()-Aufruf, keine Registrierung', async () => {
    const lock = new ProjectJobLock();
    lock.tryAcquire('/workspace/busy-repo');
    const drainJobRegistry = makeRegistry();
    const manualProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain,
      nightProjectDrain: makeProjectDrain(),
      manualDrainLock: lock,
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
    });

    await recovery.run([{ project: 'busy-repo', trigger: 'manual', status: 'aborted' }]);

    expect(manualProjectDrain.drainProject).not.toHaveBeenCalled();
    expect(drainJobRegistry.register).not.toHaveBeenCalled();
  });

  it('kein manualDrainLock injiziert -> keine Busy-Vorabprüfung, Wiederanlauf läuft trotzdem (Tiefenverteidigung entfällt, kein Crash)', async () => {
    const drainJobRegistry = makeRegistry();
    const manualProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain,
      nightProjectDrain: makeProjectDrain(),
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
    });
    await recovery.run([{ project: 'no-lock-repo', trigger: 'manual', status: 'aborted' }]);
    expect(manualProjectDrain.drainProject).toHaveBeenCalledTimes(1);
  });
});

describe('BootDrainRecovery — Nacht-Orphan (AC7)', () => {
  const withinWindowSettings = { enabled: true, window: { start: '23:00', end: '07:00', timezone: 'UTC' } };
  // 02:00 UTC liegt innerhalb 23:00-07:00
  const nowWithinWindow = () => Date.parse('2026-07-03T02:00:00Z');

  it('startet den Nacht-Wiederanlauf über nightProjectDrain wenn Fenster+Nacht-Modus+Auth alle passen', async () => {
    const drainJobRegistry = makeRegistry();
    const nightProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain: makeProjectDrain(),
      nightProjectDrain,
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
      readSettings: async () => withinWindowSettings,
      claudeAuthHealthService: { getState: () => ({ claudeAuth: 'ok' }) },
      now: nowWithinWindow,
    });

    await recovery.run([{ project: 'night-repo', trigger: 'night', args: ['--cost', 'balanced'], status: 'aborted' }]);

    expect(nightProjectDrain.drainProject).toHaveBeenCalledTimes(1);
    expect(nightProjectDrain.drainProject).toHaveBeenCalledWith('/workspace/night-repo', expect.objectContaining({ args: ['--cost', 'balanced'] }));
    expect(drainJobRegistry.register).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ project: 'night-repo', trigger: 'night' }));
  });

  it('AUSSERHALB des Nachtfensters -> KEIN Boot-Lauf (kein drainProject()-Aufruf, kein neuer Registry-Eintrag)', async () => {
    const drainJobRegistry = makeRegistry();
    const nightProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain: makeProjectDrain(),
      nightProjectDrain,
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
      readSettings: async () => withinWindowSettings,
      claudeAuthHealthService: { getState: () => ({ claudeAuth: 'ok' }) },
      now: () => Date.parse('2026-07-03T12:00:00Z'), // 12:00 UTC liegt AUSSERHALB 23:00-07:00
    });

    await recovery.run([{ project: 'night-repo', trigger: 'night', status: 'aborted' }]);

    expect(nightProjectDrain.drainProject).not.toHaveBeenCalled();
    expect(drainJobRegistry.register).not.toHaveBeenCalled();
  });

  it('Nacht-Modus DEAKTIVIERT (enabled:false) -> KEIN Boot-Lauf, obwohl Zeit im Fenster liegt', async () => {
    const drainJobRegistry = makeRegistry();
    const nightProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain: makeProjectDrain(),
      nightProjectDrain,
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
      readSettings: async () => ({ ...withinWindowSettings, enabled: false }),
      claudeAuthHealthService: { getState: () => ({ claudeAuth: 'ok' }) },
      now: nowWithinWindow,
    });

    await recovery.run([{ project: 'night-repo', trigger: 'night', status: 'aborted' }]);
    expect(nightProjectDrain.drainProject).not.toHaveBeenCalled();
  });

  it('Auth EXPIRED -> KEIN Boot-Lauf, obwohl Zeit im Fenster liegt und Nacht-Modus aktiv ist', async () => {
    const drainJobRegistry = makeRegistry();
    const nightProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain: makeProjectDrain(),
      nightProjectDrain,
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
      readSettings: async () => withinWindowSettings,
      claudeAuthHealthService: { getState: () => ({ claudeAuth: 'expired' }) },
      now: nowWithinWindow,
    });

    await recovery.run([{ project: 'night-repo', trigger: 'night', status: 'aborted' }]);
    expect(nightProjectDrain.drainProject).not.toHaveBeenCalled();
  });

  it('ohne claudeAuthHealthService injiziert -> Auth-Gate blockiert nicht (nur Fenster+enabled zaehlen)', async () => {
    const drainJobRegistry = makeRegistry();
    const nightProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain: makeProjectDrain(),
      nightProjectDrain,
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
      readSettings: async () => withinWindowSettings,
      now: nowWithinWindow,
    });

    await recovery.run([{ project: 'night-repo', trigger: 'night', status: 'aborted' }]);
    expect(nightProjectDrain.drainProject).toHaveBeenCalledTimes(1);
  });

  it('readSettings() wirft -> Gate defensiv geschlossen (kein Boot-Lauf, kein Crash)', async () => {
    const drainJobRegistry = makeRegistry();
    const nightProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain: makeProjectDrain(),
      nightProjectDrain,
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
      readSettings: async () => { throw new Error('store unreachable'); },
      claudeAuthHealthService: { getState: () => ({ claudeAuth: 'ok' }) },
      now: nowWithinWindow,
    });

    await expect(recovery.run([{ project: 'night-repo', trigger: 'night', status: 'aborted' }])).resolves.toBeUndefined();
    expect(nightProjectDrain.drainProject).not.toHaveBeenCalled();
  });
});

describe('BootDrainRecovery — Dedup (AC5) & Kombination manual+night', () => {
  it('je distinktem Projekt+Trigger genau ein drainProject()-Aufruf, auch bei mehreren Orphans desselben Projekts/Triggers', async () => {
    const drainJobRegistry = makeRegistry();
    const manualProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain,
      nightProjectDrain: makeProjectDrain(),
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
    });

    await recovery.run([
      { project: 'dup-repo', trigger: 'manual', args: ['--cost', 'low-cost'], status: 'aborted' },
      { project: 'dup-repo', trigger: 'manual', args: ['--cost', 'max-quality'], status: 'aborted' },
      { project: 'dup-repo', trigger: 'manual', args: ['--cost', 'frontier'], status: 'aborted' },
    ]);

    expect(manualProjectDrain.drainProject).toHaveBeenCalledTimes(1);
    // letzter Eintrag gewinnt (jüngste Registrierung)
    expect(manualProjectDrain.drainProject).toHaveBeenCalledWith('/workspace/dup-repo', expect.objectContaining({ args: ['--cost', 'frontier'] }));
  });

  it('Projekt mit sowohl manual- als auch night-Orphan -> je ein Wiederanlauf über die jeweils passende Engine (im Fenster)', async () => {
    const drainJobRegistry = makeRegistry();
    const manualProjectDrain = makeProjectDrain();
    const nightProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain,
      nightProjectDrain,
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
      readSettings: async () => ({ enabled: true, window: { start: '23:00', end: '07:00', timezone: 'UTC' } }),
      claudeAuthHealthService: { getState: () => ({ claudeAuth: 'ok' }) },
      now: () => Date.parse('2026-07-03T02:00:00Z'),
    });

    await recovery.run([
      { project: 'both-repo', trigger: 'manual', status: 'aborted' },
      { project: 'both-repo', trigger: 'night', status: 'aborted' },
    ]);

    expect(manualProjectDrain.drainProject).toHaveBeenCalledTimes(1);
    expect(nightProjectDrain.drainProject).toHaveBeenCalledTimes(1);
  });
});

describe('BootDrainRecovery — Best-effort/Degradation (AC8)', () => {
  it('leeres Orphan-Array -> idempotenter No-op (keine Boundary aufgerufen)', async () => {
    const drainJobRegistry = makeRegistry();
    const manualProjectDrain = makeProjectDrain();
    const nightProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({ drainJobRegistry, manualProjectDrain, nightProjectDrain });

    await expect(recovery.run([])).resolves.toBeUndefined();
    expect(manualProjectDrain.drainProject).not.toHaveBeenCalled();
    expect(nightProjectDrain.drainProject).not.toHaveBeenCalled();
    expect(drainJobRegistry.register).not.toHaveBeenCalled();
  });

  it('nicht mehr auflösbarer Slug (resolveProjectSlug wirft) -> Projekt übersprungen, kein Crash, andere Projekte laufen weiter', async () => {
    const drainJobRegistry = makeRegistry();
    const manualProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain,
      nightProjectDrain: makeProjectDrain(),
      resolveProjectSlug: (slug) => {
        if (slug === 'gone-repo') throw new Error('slug invalid');
        return `/workspace/${slug}`;
      },
      validateProjectPath: async (p) => ({ resolvedPath: p }),
    });

    await recovery.run([
      { project: 'gone-repo', trigger: 'manual', status: 'aborted' },
      { project: 'healthy-repo', trigger: 'manual', status: 'aborted' },
    ]);

    expect(manualProjectDrain.drainProject).toHaveBeenCalledTimes(1);
    expect(manualProjectDrain.drainProject).toHaveBeenCalledWith('/workspace/healthy-repo', expect.anything());
  });

  it('validateProjectPath() wirft (Repo entfernt) -> Projekt übersprungen, kein Crash', async () => {
    const drainJobRegistry = makeRegistry();
    const manualProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain,
      nightProjectDrain: makeProjectDrain(),
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async () => { throw new Error('ENOENT'); },
    });

    await expect(recovery.run([{ project: 'removed-repo', trigger: 'manual', status: 'aborted' }])).resolves.toBeUndefined();
    expect(manualProjectDrain.drainProject).not.toHaveBeenCalled();
  });

  it('Registry register() wirft -> Wiederanlauf läuft trotzdem weiter (best-effort), kein Crash', async () => {
    const drainJobRegistry = makeRegistry();
    drainJobRegistry.register = jest.fn(() => { throw new Error('write failed'); });
    const manualProjectDrain = makeProjectDrain();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain,
      nightProjectDrain: makeProjectDrain(),
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
    });

    await expect(recovery.run([{ project: 'repo', trigger: 'manual', status: 'aborted' }])).resolves.toBeUndefined();
    expect(manualProjectDrain.drainProject).toHaveBeenCalledTimes(1);
  });

  it('projectDrain fehlt (nicht injiziert) für einen Trigger -> dieser Trigger wird übersprungen, kein Crash', async () => {
    const drainJobRegistry = makeRegistry();
    const recovery = new BootDrainRecovery({
      drainJobRegistry,
      manualProjectDrain: null,
      nightProjectDrain: null,
      resolveProjectSlug: (slug) => `/workspace/${slug}`,
      validateProjectPath: async (p) => ({ resolvedPath: p }),
      readSettings: async () => ({ enabled: true, window: { start: '23:00', end: '07:00', timezone: 'UTC' } }),
      claudeAuthHealthService: { getState: () => ({ claudeAuth: 'ok' }) },
      now: () => Date.parse('2026-07-03T02:00:00Z'),
    });

    await expect(
      recovery.run([
        { project: 'a', trigger: 'manual', status: 'aborted' },
        { project: 'b', trigger: 'night', status: 'aborted' },
      ]),
    ).resolves.toBeUndefined();
    expect(drainJobRegistry.register).not.toHaveBeenCalled();
  });

  it('run() wirft nie, selbst bei einem unerwarteten synchronen Fehler in einer injizierten Dependency', async () => {
    const recovery = new BootDrainRecovery({
      drainJobRegistry: makeRegistry(),
      manualProjectDrain: makeProjectDrain(),
      nightProjectDrain: makeProjectDrain(),
      resolveProjectSlug: () => { throw new Error('unexpected'); },
      validateProjectPath: async (p) => ({ resolvedPath: p }),
    });
    await expect(recovery.run([{ project: 'x', trigger: 'manual', status: 'aborted' }])).resolves.toBeUndefined();
  });
});
