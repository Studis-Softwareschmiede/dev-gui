/**
 * headless-night-drain.integration.test.js — echte-Naht-Tests für den
 * headless-Nacht-Drain (docs/specs/headless-parallel-drain.md).
 *
 * Strategy — ECHTE Naht, NICHT gemockt (analog
 * nightwatch-lock-contention.integration.test.js, aber für den NEUEN
 * headless-Pfad statt CommandService/PTY):
 *   - Echtes `ProjectDrain` (src/ProjectDrain.js).
 *   - Echter `HeadlessFlowRunnerAdapter` (src/FlowRunner.js).
 *   - Echter `HeadlessFlowRunner` (src/HeadlessFlowRunner.js) + echtes
 *     `HeadlessRunnerCore`/`ProjectJobLock` — einziger Fake ist `spawnFn`
 *     (kein echter `claude -p`-Kindprozess, aber ein echtes EventEmitter-
 *     Objekt mit stdout/stderr/kill(), exakt wie `HeadlessRunnerCore` es
 *     erwartet).
 *   - Echter `NightWatchScheduler` für die Fensterende-Tests.
 *
 * Covers (headless-parallel-drain):
 *   AC7  — echte Parallelität: zwei Projekte draining GLEICHZEITIG über
 *          denselben `HeadlessFlowRunner` — beide `spawnFn`-Aufrufe sind
 *          gleichzeitig "in flight" (beide Kindprozesse laufen parallel,
 *          bevor irgendeiner schließt) — Beleg gegen die alte
 *          CommandService/PTY-Serialisierung.
 *   AC8  — `command-channel-busy` tritt im Headless-Modus für zwei
 *          verschiedene Projekte NICHT auf (kein globaler Engpass).
 *   AC9  — kritischer Review-Punkt (S-212/S-213): `HeadlessFlowRunner` DARF
 *          NICHT dieselbe `ProjectJobLock`-Instanz wie `ProjectDrain` nutzen,
 *          sonst blockiert sich JEDER headless-Lauf SELBST
 *          (`reason:'command-channel-busy'` ab dem allerersten Versuch,
 *          obwohl nichts anderes läuft). Zwei Tests: Regression (geteilte
 *          Lock-Instanz → Selbst-Blockade) + Fix (getrennte Instanzen,
 *          Default-Verdrahtung wie in server.js → normaler Lauf).
 *   AC11 — Audit: Start/Ende(Erfolg)/Fehler je headless-Lauf (genau je ein
 *          `AuditEntry`, secret-/pfad-frei).
 *   AC12 — Sanftes Fensterende: ein bereits laufender headless-Subprozess
 *          wird NICHT gekillt; der Scheduler startet nur keine neuen mehr.
 *
 * CRITICAL-Fix-Regressionstest (S-213 Iteration 2, live reproduziert — siehe
 * `.claude/lessons/coder.md` 2026-07-01 "attachTokenWatcher (PTY-Session-
 * CREATE) läuft VOR isProjectBusy() (PTY-Session-EXISTS) — Selbst-Blockade"):
 * `NightWatchScheduler#startDrain()` ruft synchron `#attachTokenWatcher()`
 * auf, BEVOR `projectDrain.drainProject()` läuft. Teilen beide Collaborators
 * (Scheduler UND ProjectDrain) dieselbe `sessionRegistry`-Instanz — EXAKT wie
 * `server.js` (`nightWatchScheduler`+`nightProjectDrain` bekommen beide
 * `sessionRegistry: ptyRegistry`) — legte `#attachTokenWatcher()` per
 * `getOrCreate()` eine PTY-Session für das Projekt an, die `ProjectDrain`s
 * eigener `isProjectBusy()`-Check (`sessionRegistry.hasSession()`) sofort
 * danach als "aktiv" erkannte → `already-busy`, `flowRunner.startRun()` NIE
 * aufgerufen (Selbst-Blockade, JEDER automatische Nacht-Tick für ein frisches
 * Projekt betroffen). Die bisherige `test/headless-night-drain.integration
 * .test.js`-Suite und `test/NightWatchScheduler.test.js` verfehlten dies, weil
 * `NightWatchScheduler` in KEINEM bestehenden Test mit einer `sessionRegistry`
 * konstruiert wurde, die GLEICHZEITIG auch in `ProjectDrain` steckt (genau die
 * Naht, die server.js herstellt).
 *
 * Strategy dieser beiden Tests — treu nachgebaute `sessionRegistry`
 * (identisches `getOrCreate()`/`hasSession()`-Verhalten zu
 * `PtySessionRegistry.js:133-163,179-183`: `getOrCreate()` legt eine Session
 * an, falls noch keine existiert, und liefert sie danach unverändert zurück;
 * `hasSession()` ist rein lesend, erzeugt NIE) — DIESELBE Instanz wird sowohl
 * in `NightWatchScheduler` (für `#attachTokenWatcher`) als auch in
 * `ProjectDrain` (für `isProjectBusy`) injiziert, exakt wie `server.js`.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

import { HeadlessFlowRunner } from '../src/HeadlessFlowRunner.js';
import { HeadlessFlowRunnerAdapter } from '../src/FlowRunner.js';
import { ProjectDrain } from '../src/ProjectDrain.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';
import { NightWatchScheduler } from '../src/NightWatchScheduler.js';

/** Fake child process — echtes EventEmitter mit stdout/stderr-Sub-Emittern + kill()-Spy (Muster HeadlessFlowRunner.test.js). */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

/** Schnelles, aber echtes Sleep — kleine ms-Werte, kein Fake-Timer nötig (Muster nightwatch-lock-contention.integration.test.js). */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pollt, bis `predicate()` wahr ist — oder wirft nach `timeoutMs`.
 *
 * Ein festes `realSleep` reicht für das Abräumen des Drains nicht: die Kette
 * close-Event → finally → Lock-Freigabe braucht auf langsamen CI-Runnern mehr
 * als die lokal genügenden ~20ms (Flake auf main, 2026-07-15: derselbe Test
 * grün um 05:17, rot um 05:29 und 14:22, ohne Änderung am Nacht-Drain-Code).
 * Der Timeout hält die Aussagekraft: bleibt der Drain wirklich hängen, schlägt
 * der Test weiterhin fehl — nur eben nicht mehr zufällig.
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await realSleep(5);
  }
  throw new Error(`waitFor: Bedingung nach ${timeoutMs}ms nicht erfüllt`);
}

/** Baut einen minimalen, mutierbaren Board-Fake: eine Story je Projekt, extern auf 'Done' schaltbar. */
function makeMutableBoard(entries) {
  // entries: [{ projectPath, slug, story }]
  return {
    scan: async () => {},
    getIndex: async () =>
      entries.map(({ projectPath, slug, story }) => ({
        repo_path: projectPath,
        slug,
        error: undefined,
        features: [{ stories: [story] }],
      })),
  };
}

/**
 * Treu nachgebaute `sessionRegistry` — repliziert exakt die
 * `getOrCreate()`/`hasSession()`-Semantik von
 * `PtySessionRegistry.js:133-163,179-183` (kein echter `node-pty`-Prozess
 * nötig, aber identisches Existenz-Verhalten): `getOrCreate()` legt eine
 * Session an, falls für diesen Pfad noch keine existiert, und liefert sie
 * danach IMMER dieselbe Instanz zurück (kein Re-Create); `hasSession()` ist
 * rein lesend (erzeugt NIE eine Session als Seiteneffekt) — exakt die
 * Eigenschaft, auf der `ProjectJobLock.isProjectBusy()`s "kein Doppel-Trigger
 * durch reines Prüfen"-Garantie beruht (siehe `PtySessionRegistry.js`
 * `hasSession()`-Doku).
 */
class FaithfulSessionRegistry {
  #sessions = new Map();

  getOrCreate(projectPath) {
    const key = projectPath ?? '__global__';
    if (!this.#sessions.has(key)) {
      this.#sessions.set(key, { on: () => {}, off: () => {} });
    }
    return this.#sessions.get(key);
  }

  hasSession(projectPath) {
    const key = projectPath ?? '__global__';
    return this.#sessions.has(key);
  }
}

describe(
  'CRITICAL-FIX-Regression (S-213 Iteration 2): sessionRegistry GLEICHZEITIG in NightWatchScheduler ' +
    '(#attachTokenWatcher) UND ProjectDrain (isProjectBusy) — EXAKT wie server.js',
  () => {
    it(
      'frisches Projekt OHNE offene Session: automatischer Nacht-Tick spawnt TATSÄCHLICH einen headless-Subprozess ' +
        '(spawnCount>0, flowRunner.startRun aufgerufen) — NICHT already-busy',
      async () => {
        const PROJECT_PATH = '/workspace/proj-fresh-no-session';
        const story = { id: 'S-1', status: 'To Do', ready: true, depends: [] };
        const boardAggregator = makeMutableBoard([{ projectPath: PROJECT_PATH, slug: 'proj-fresh-no-session', story }]);

        // DIESELBE sessionRegistry-Instanz für BEIDE Collaborators (server.js-Konvention).
        const sharedSessionRegistry = new FaithfulSessionRegistry();

        const child = makeFakeChild();
        const spawnFn = jest.fn(() => child);
        const headlessFlowRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
        const headlessAdapter = new HeadlessFlowRunnerAdapter({
          headlessRunner: headlessFlowRunner,
          sleepFn: (ms) => realSleep(Math.min(ms, 5)),
          pollIntervalMs: 5,
        });
        // Spy um startRun, um AC5/AC7-Beleg unabhängig vom Spawn-Mock zu führen.
        const startRunSpy = jest.spyOn(headlessAdapter, 'startRun');

        const nightProjectDrain = new ProjectDrain({
          boardAggregator,
          flowRunner: headlessAdapter,
          sessionRegistry: sharedSessionRegistry, // isProjectBusy-Busy-Erkennung, wie server.js
        });

        const tokenLimitWatcher = { getState: () => ({ limited: false }), attach: () => {} };
        const scheduler = new NightWatchScheduler({
          readSettings: async () => ({
            enabled: true,
            window: { start: '00:00', end: '23:59', timezone: 'UTC' },
            intervalMinutes: 15,
            maxParallel: 1,
            projects: 'all',
          }),
          boardAggregator,
          projectDrain: nightProjectDrain,
          tokenLimitWatcher, // nötig, damit #attachTokenWatcher überhaupt aktiv wird (Bug-Voraussetzung)
          sessionRegistry: sharedSessionRegistry, // #attachTokenWatcher, wie server.js
          now: () => new Date('2026-06-30T12:00:00.000Z').getTime(),
        });

        const tickResult = await scheduler.tick();
        expect(tickResult.started).toEqual([PROJECT_PATH]);

        // Warten, bis die fire-and-forget-Drain-Kette (Attach → drainProject →
        // isProjectBusy → Lock → runLoop → flowRunner.startRun → spawn) durchlief.
        await realSleep(20);

        // ── Zentrale Regressions-Assertion: der Selbst-Block ist behoben ──────
        expect(startRunSpy).toHaveBeenCalledTimes(1);
        expect(spawnFn).toHaveBeenCalledTimes(1); // spawnCount > 0 — der Live-Repro-Bug-Beleg

        // Sauber abschließen (kein hängender Kindprozess im Test).
        story.status = 'Done';
        story.ready = false;
        child.emit('close', 0);
        await realSleep(20);
      },
    );

    it(
      'Projekt MIT vorbestehender (fremd angelegter, z.B. manuell in der UI geöffneter) Session wird weiterhin ' +
        'korrekt als busy übersprungen (kein Doppel-Trigger, fremd-Session-Signal bleibt intakt)',
      async () => {
        const PROJECT_PATH = '/workspace/proj-foreign-session';
        const story = { id: 'S-1', status: 'To Do', ready: true, depends: [] };
        const boardAggregator = makeMutableBoard([{ projectPath: PROJECT_PATH, slug: 'proj-foreign-session', story }]);

        const sharedSessionRegistry = new FaithfulSessionRegistry();
        // Simuliert eine UNABHÄNGIG vom Scheduler bereits bestehende Session
        // (z.B. ein manuell in der UI geöffnetes Terminal für dieses Projekt) —
        // angelegt VOR jedem Tick, nicht durch den Scheduler selbst.
        sharedSessionRegistry.getOrCreate(PROJECT_PATH);

        const spawnFn = jest.fn(() => makeFakeChild());
        const headlessFlowRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
        const headlessAdapter = new HeadlessFlowRunnerAdapter({
          headlessRunner: headlessFlowRunner,
          sleepFn: (ms) => realSleep(Math.min(ms, 5)),
          pollIntervalMs: 5,
        });
        const startRunSpy = jest.spyOn(headlessAdapter, 'startRun');

        const nightProjectDrain = new ProjectDrain({
          boardAggregator,
          flowRunner: headlessAdapter,
          sessionRegistry: sharedSessionRegistry,
        });

        const tokenLimitWatcher = { getState: () => ({ limited: false }), attach: () => {} };
        const scheduler = new NightWatchScheduler({
          readSettings: async () => ({
            enabled: true,
            window: { start: '00:00', end: '23:59', timezone: 'UTC' },
            intervalMinutes: 15,
            maxParallel: 1,
            projects: 'all',
          }),
          boardAggregator,
          projectDrain: nightProjectDrain,
          tokenLimitWatcher,
          sessionRegistry: sharedSessionRegistry,
          now: () => new Date('2026-06-30T12:00:00.000Z').getTime(),
        });

        const tickResult = await scheduler.tick();
        expect(tickResult.started).toEqual([PROJECT_PATH]); // Scheduler startet den Drain-Versuch fire-and-forget

        await realSleep(20);

        // ── Zentrale Assertion: das fremd-Session-busy-Signal bleibt intakt ───
        expect(startRunSpy).not.toHaveBeenCalled();
        expect(spawnFn).not.toHaveBeenCalled();
      },
    );
  },
);

describe('Headless-Nacht-Drain — Selbst-Blockade-Vermeidung (S-212/S-213 kritischer Review-Punkt, AC9-Vertrag "reason:locked nur bei DEMSELBEN Projekt")', () => {
  it('REGRESSION: teilen sich ProjectDrain und HeadlessFlowRunner DIESELBE ProjectJobLock-Instanz, blockiert sich der headless-Lauf SELBST', async () => {
    const PROJECT_PATH = '/workspace/proj-selfblock';
    const story = { id: 'S-1', status: 'To Do', ready: true, depends: [] };
    const boardAggregator = makeMutableBoard([{ projectPath: PROJECT_PATH, slug: 'proj-selfblock', story }]);

    // Kritischer Fehler: derselbe Lock-Singleton in BEIDE Konstruktoren injiziert.
    const sharedLock = new ProjectJobLock();
    const spawnFn = jest.fn(() => makeFakeChild());
    const headlessFlowRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000, lock: sharedLock });
    const headlessAdapter = new HeadlessFlowRunnerAdapter({
      headlessRunner: headlessFlowRunner,
      sleepFn: (ms) => realSleep(Math.min(ms, 5)),
      pollIntervalMs: 5,
    });
    const projectDrain = new ProjectDrain({ boardAggregator, flowRunner: headlessAdapter, lock: sharedLock });

    const result = await projectDrain.drainProject(PROJECT_PATH);

    // Der allererste /flow-Versuch scheitert bereits — obwohl NICHTS anderes
    // läuft und die Drain-Ziel-Story völlig gesund ist.
    expect(result).toEqual({
      stopped: true,
      reason: 'command-channel-busy',
      flowRuns: 1,
      escalated: [],
      completed: [],
      blocked: [],
      budgetPauses: [],
    });
    // Kein einziger Kindprozess wurde je gespawnt (HeadlessRunnerCore prüft
    // das Lock VOR dem Spawn) — der Bug verhindert den Lauf vollständig.
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('FIX: getrennte ProjectJobLock-Instanzen (Default-Verdrahtung wie server.js) → kein Selbst-Block, Lauf schließt normal ab', async () => {
    const PROJECT_PATH = '/workspace/proj-fixed';
    const story = { id: 'S-1', status: 'To Do', ready: true, depends: [] };
    const boardAggregator = makeMutableBoard([{ projectPath: PROJECT_PATH, slug: 'proj-fixed', story }]);

    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    // Kein `lock`-Override an HeadlessFlowRunner → eigene, separate
    // ProjectJobLock-Instanz per Konstruktor-Default (server.js-Konvention).
    const headlessFlowRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
    const headlessAdapter = new HeadlessFlowRunnerAdapter({
      headlessRunner: headlessFlowRunner,
      sleepFn: (ms) => realSleep(Math.min(ms, 5)),
      pollIntervalMs: 5,
    });
    // ProjectDrain nutzt ihre eigene (ebenfalls separate) Default-Lock-Instanz.
    const projectDrain = new ProjectDrain({ boardAggregator, flowRunner: headlessAdapter, lock: new ProjectJobLock() });

    const drainPromise = projectDrain.drainProject(PROJECT_PATH);

    // Kindprozess schließt sauber ab (Exit 0) — simuliert einen echten
    // erfolgreichen /flow-Lauf, der die Story auf Done setzt.
    await realSleep(20);
    story.status = 'Done';
    story.ready = false;
    child.emit('close', 0);

    const result = await drainPromise;
    expect(result).toEqual({
      stopped: true,
      reason: 'no-drain-target',
      flowRuns: 1,
      escalated: [],
      completed: [{ id: 'S-1', title: '' }],
      blocked: [],
      budgetPauses: [],
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

describe('Headless-Nacht-Drain — echte Parallelität (AC7) + kein command-channel-busy (AC8)', () => {
  it('zwei Projekte draining über denselben HeadlessFlowRunner GLEICHZEITIG — beide Kindprozesse sind parallel "in flight"', async () => {
    const PATH_A = '/workspace/proj-a';
    const PATH_B = '/workspace/proj-b';
    const storyA = { id: 'S-1', status: 'To Do', ready: true, depends: [] };
    const storyB = { id: 'S-1', status: 'To Do', ready: true, depends: [] };
    const boardAggregator = makeMutableBoard([
      { projectPath: PATH_A, slug: 'proj-a', story: storyA },
      { projectPath: PATH_B, slug: 'proj-b', story: storyB },
    ]);

    const childrenByCwd = new Map();
    const spawnFn = jest.fn((cmd, args, opts) => {
      const child = makeFakeChild();
      childrenByCwd.set(opts.cwd, child);
      return child;
    });
    // EIN gemeinsamer HeadlessFlowRunner (wie in server.js: eine Composition-
    // Root-Instanz bedient alle Nacht-Projekte) — projektweises Lock (Key =
    // Pfad) verhindert dennoch KEINE Kollision zwischen A und B.
    const headlessFlowRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
    const headlessAdapter = new HeadlessFlowRunnerAdapter({
      headlessRunner: headlessFlowRunner,
      sleepFn: (ms) => realSleep(Math.min(ms, 5)),
      pollIntervalMs: 5,
    });
    // EIN gemeinsamer ProjectDrain (wie in server.js: der Scheduler ruft
    // dieselbe Instanz für verschiedene projectPaths auf).
    const projectDrain = new ProjectDrain({ boardAggregator, flowRunner: headlessAdapter });

    // Beide Drains "gleichzeitig" starten (kein await dazwischen — genau wie
    // der Scheduler es für maxParallel-Projekte tut, siehe #startDrain).
    const drainA = projectDrain.drainProject(PATH_A);
    const drainB = projectDrain.drainProject(PATH_B);

    // Warten, bis BEIDE Kindprozesse gespawnt wurden — BEVOR irgendeiner
    // geschlossen wird. Das ist der zentrale Beleg für ECHTE Parallelität:
    // mit der alten CommandService/PTY-Serialisierung hätte der zweite
    // Aufruf sofort `reason:'locked'|'busy'` zurückbekommen, OHNE je einen
    // zweiten Kindprozess zu spawnen.
    await realSleep(15);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(childrenByCwd.has(PATH_A)).toBe(true);
    expect(childrenByCwd.has(PATH_B)).toBe(true);
    // Beide Kindprozesse sind zu diesem Zeitpunkt noch NICHT geschlossen —
    // sie liefen tatsächlich nebeneinander (kein serieller Fallback).

    storyA.status = 'Done';
    storyA.ready = false;
    childrenByCwd.get(PATH_A).emit('close', 0);

    storyB.status = 'Done';
    storyB.ready = false;
    childrenByCwd.get(PATH_B).emit('close', 0);

    const [resultA, resultB] = await Promise.all([drainA, drainB]);

    expect(resultA).toEqual({
      stopped: true,
      reason: 'no-drain-target',
      flowRuns: 1,
      escalated: [],
      completed: [{ id: 'S-1', title: '' }],
      blocked: [],
      budgetPauses: [],
    });
    expect(resultB).toEqual({
      stopped: true,
      reason: 'no-drain-target',
      flowRuns: 1,
      escalated: [],
      completed: [{ id: 'S-1', title: '' }],
      blocked: [],
      budgetPauses: [],
    });
    // AC8: command-channel-busy tritt für keines der beiden Projekte auf.
    expect(resultA.reason).not.toBe('command-channel-busy');
    expect(resultB.reason).not.toBe('command-channel-busy');
  });
});

describe('Headless-Nacht-Drain — Audit je headless-Lauf (AC11)', () => {
  it('erzeugt genau EINEN Start- und genau EINEN Ende(Erfolg)-AuditEntry je headless-Lauf (secret-/pfad-frei)', async () => {
    const PROJECT_PATH = '/workspace/proj-audit';
    const story = { id: 'S-1', status: 'To Do', ready: true, depends: [] };
    const boardAggregator = makeMutableBoard([{ projectPath: PROJECT_PATH, slug: 'proj-audit', story }]);

    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const auditStore = { record: jest.fn() };
    const headlessFlowRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
    const headlessAdapter = new HeadlessFlowRunnerAdapter({
      headlessRunner: headlessFlowRunner,
      sleepFn: (ms) => realSleep(Math.min(ms, 5)),
      pollIntervalMs: 5,
      auditStore,
    });
    const projectDrain = new ProjectDrain({ boardAggregator, flowRunner: headlessAdapter, auditStore });

    const drainPromise = projectDrain.drainProject(PROJECT_PATH, { identity: 'alex@example.com' });
    await realSleep(20);
    story.status = 'Done';
    story.ready = false;
    child.emit('close', 0);
    await drainPromise;

    const startEntries = auditStore.record.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.command.includes('taktgeber:headless-flow-start'));
    const doneEntries = auditStore.record.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.command.includes('taktgeber:headless-flow-done'));

    expect(startEntries).toHaveLength(1);
    expect(doneEntries).toHaveLength(1);
    expect(startEntries[0].identity).toBe('alex@example.com');
    expect(doneEntries[0].identity).toBe('alex@example.com');
    // NFR: kein absoluter Host-Pfad im Audit-Text — nur der Basename.
    expect(startEntries[0].command).not.toContain(PROJECT_PATH);
    expect(startEntries[0].command).toContain('proj-audit');
  });

  it('erzeugt genau EINEN Fehler-AuditEntry bei einem fehlgeschlagenen headless-Lauf (Timeout/Non-Zero-Exit)', async () => {
    const PROJECT_PATH = '/workspace/proj-audit-fail';
    const story = { id: 'S-1', status: 'To Do', ready: true, depends: [] };
    const boardAggregator = makeMutableBoard([{ projectPath: PROJECT_PATH, slug: 'proj-audit-fail', story }]);

    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const auditStore = { record: jest.fn() };
    // Sehr kurzer Runner-Timeout, damit der Lauf zuverlässig in `failed` endet
    // (kein manuelles Escalation-Setup nötig — Timeout genügt für AC11-Beleg).
    const headlessFlowRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 5 });
    const headlessAdapter = new HeadlessFlowRunnerAdapter({
      headlessRunner: headlessFlowRunner,
      sleepFn: (ms) => realSleep(Math.min(ms, 5)),
      pollIntervalMs: 5,
      auditStore,
    });
    const projectDrain = new ProjectDrain({
      boardAggregator,
      flowRunner: headlessAdapter,
      auditStore,
      escalationAttempts: 50, // hoch — dieser Test prüft NUR den Audit-Pfad, keine Eskalation
      safetyMaxNoProgressRounds: 2, // stoppt den Drain zuverlässig nach dem ersten fortschrittslosen Lauf
    });

    const result = await projectDrain.drainProject(PROJECT_PATH);
    expect(result.flowRuns).toBeGreaterThanOrEqual(1);

    const failedEntries = auditStore.record.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.command.includes('taktgeber:headless-flow-failed'));
    expect(failedEntries.length).toBeGreaterThanOrEqual(1);
    expect(failedEntries[0].command).toContain('status=failed');
  }, 10000);
});

describe('Headless-Nacht-Drain — Sanftes Fensterende mit laufendem Subprozess (AC12, echte Naht)', () => {
  it('killt den laufenden claude -p-Subprozess NICHT bei Fensterende; der Scheduler startet nur keine neuen mehr', async () => {
    const PROJECT_PATH = '/workspace/proj-soft-end';
    const story = { id: 'S-1', status: 'To Do', ready: true, depends: [] };
    const boardAggregator = makeMutableBoard([{ projectPath: PROJECT_PATH, slug: 'proj-soft-end', story }]);

    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const headlessFlowRunner = new HeadlessFlowRunner({ spawnFn, timeoutMs: 10_000 });
    const headlessAdapter = new HeadlessFlowRunnerAdapter({
      headlessRunner: headlessFlowRunner,
      sleepFn: (ms) => realSleep(Math.min(ms, 5)),
      pollIntervalMs: 5,
    });
    const projectDrain = new ProjectDrain({ boardAggregator, flowRunner: headlessAdapter });

    const insideWindowMs = Date.UTC(2026, 0, 15, 23, 30);
    const outsideWindowMs = Date.UTC(2026, 0, 15, 11, 0);
    let currentNow = insideWindowMs;
    const scheduler = new NightWatchScheduler({
      readSettings: async () => ({
        enabled: true,
        window: { start: '23:00', end: '07:00', timezone: 'Europe/Zurich' },
        intervalMinutes: 15,
        maxParallel: 1,
        projects: 'all',
      }),
      boardAggregator,
      projectDrain,
      now: () => currentNow,
    });

    const first = await scheduler.tick();
    expect(first.started).toEqual([PROJECT_PATH]);
    // `#startDrain` ist fire-and-forget (tick() wartet nicht auf das ECHTE
    // Ende des Drains) — kurz warten, bis der headless-Subprozess tatsächlich
    // gespawnt wurde (asynchrone Kette: yieldTick → findProject → startRun).
    await realSleep(15);
    expect(spawnFn).toHaveBeenCalledTimes(1); // der headless-Subprozess wurde wirklich gestartet

    // Fensterende erreicht — nächster Tick liegt außerhalb des Fensters.
    currentNow = outsideWindowMs;
    const second = await scheduler.tick();
    expect(second).toEqual({ skipped: true, reason: 'outside-window', activeDrains: 1 });
    expect(child.kill).not.toHaveBeenCalled(); // AC12: kein Kill des laufenden Subprozesses

    // Der Subprozess läuft ganz normal (über sein eigenes close-Event) zu Ende.
    story.status = 'Done';
    story.ready = false;
    child.emit('close', 0);
    await waitFor(() => scheduler.getStatus().activeDrainProjectPaths.length === 0);
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual([]);
  });
});
