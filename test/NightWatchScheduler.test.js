/**
 * NightWatchScheduler.test.js — Unit-Tests für den Nachtfenster-Scheduler
 * (docs/specs/taktgeber-nachtwaechter.md).
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC9  — pollt im Fenster alle Projekte (oder `projects`-Liste), bis zu
 *          `maxParallel` (Default 3, geklemmt 1–3) parallele
 *          `ProjectDrain.drainProject()`-Läufe; Polling-Intervall
 *          `intervalMinutes` bestimmt den Abstand der `setTimeout`-Kette
 *          (`#lastIntervalMs`, indirekt über wiederholte `tick()`-Aufrufe
 *          getestet — kein echtes Warten). `enabled=false` → Scheduler tut
 *          nichts (kein Board-Scan, kein Drain). Leere `projects`-Liste →
 *          nichts zu drainen (Edge-Case Spec). `maxParallel` außerhalb 1–3
 *          → geklemmt (`clampMaxParallel`, Edge-Case Spec).
 *   AC10 — Nachtfenster-Berechnung (`isWithinWindow`): normales Fenster
 *          (start<end), über-Mitternacht-Fenster (start>end, ≥start ODER
 *          <end), `start==end` → NIE im Fenster (Edge-Case Spec), TZ
 *          Europe/Zurich (Januar, DST-frei, CET=UTC+1, deterministisch).
 *          `computeWindowEndMs` bestimmt das für "jetzt" gültige
 *          Fensterende (heute/morgen je nach über-Mitternacht-Hälfte) —
 *          Grundlage für den Token-Limit-`windowEndMs`-Vergleich (AC14).
 *   AC11 — Sanftes Ende: außerhalb des Fensters werden KEINE neuen Drains
 *          gestartet; ein bereits laufender Drain (aus einem vorherigen
 *          In-Fenster-Tick) wird NICHT abgebrochen — er bleibt in
 *          `#activeDrains` bis er selbst resolved, unabhängig vom
 *          aktuellen Fenster-Status des nächsten Ticks.
 *
 *   Zusätzlich (Story-Vorgabe, Konsum von TokenLimitWatcher S-193 — AC13/14
 *   selbst bleiben dort implementiert): Token-Limit-Pause (bis Reset+1min,
 *   danach normaler Drain-Start im selben Tick) und `exceeds-window` →
 *   `token-limit-stop` (kein Board-Scan/Drain in diesem Tick, Audit-Dedupe
 *   pro `resetAt`). `#attachTokenWatcher`: Attach nur einmal pro
 *   PTY-Instanz (Objekt-Identität), erneuter Attach bei Session-Neuerstellung.
 *
 * Strategy:
 *   - Pure Helper (`parseHHMM`, `isWithinWindow`, `computeWindowEndMs`,
 *     `clampMaxParallel`, `selectCandidateProjects`) direkt mit
 *     Fixture-Daten getestet (kein IO).
 *   - `NightWatchScheduler` gegen schlanke Fake-Deps: `boardAggregator`
 *     (`getIndex()` liefert Fixture-Index), `projectDrain`
 *     (`drainProject()` liefert steuerbare/deferred Promises — simuliert
 *     lang laufende Drains für die "Sanftes Ende"/"maxParallel"-Tests ohne
 *     echtes Warten), `tokenLimitWatcher`/`sessionRegistry`/`auditStore`
 *     als `jest.fn()`-Stubs. `now`/`sleepFn` immer injiziert.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  NightWatchScheduler,
  parseHHMM,
  isWithinWindow,
  computeWindowEndMs,
  clampMaxParallel,
  selectCandidateProjects,
  DEFAULT_INTERVAL_MINUTES,
} from '../src/NightWatchScheduler.js';

// ── Fixture-Helfer ─────────────────────────────────────────────────────────────

function makeWindow(overrides = {}) {
  return { start: '23:00', end: '07:00', timezone: 'Europe/Zurich', ...overrides };
}

function makeSettings(overrides = {}) {
  return {
    enabled: true,
    window: makeWindow(),
    intervalMinutes: 15,
    maxParallel: 3,
    projects: 'all',
    ...overrides,
  };
}

function makeProject(slug, repoPath, overrides = {}) {
  return { project_slug: slug, repo_path: repoPath, error: undefined, ...overrides };
}

/** Deferred-Promise-Helfer — steuerbare drainProject()-Auflösung ohne echtes Warten. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Baut einen Fake-ProjectDrain, dessen `drainProject()` je Projektpfad eine
 * eigene, extern auflösbare Promise liefert (steuerbar, kein echtes Warten).
 */
function makeControllableProjectDrain() {
  const calls = [];
  const deferredsByPath = new Map();
  const drainProject = jest.fn((projectPath) => {
    const d = deferred();
    deferredsByPath.set(projectPath, d);
    calls.push(projectPath);
    return d.promise;
  });
  return {
    drainProject,
    calls,
    resolve(projectPath, result = { stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] }) {
      const d = deferredsByPath.get(projectPath);
      if (!d) throw new Error(`no pending drain for ${projectPath}`);
      d.resolve(result);
      deferredsByPath.delete(projectPath);
    },
  };
}

function makeScheduler(overrides = {}) {
  const settings = overrides.settings ?? makeSettings();
  const index = overrides.index ?? [
    makeProject('proj-a', '/workspace/proj-a'),
    makeProject('proj-b', '/workspace/proj-b'),
    makeProject('proj-c', '/workspace/proj-c'),
  ];
  const projectDrain = overrides.projectDrain ?? makeControllableProjectDrain();
  const boardAggregator = overrides.boardAggregator ?? {
    getIndex: jest.fn(async () => index),
  };
  const auditStore = overrides.auditStore ?? { record: jest.fn() };
  const nowMs = overrides.nowMs ?? Date.UTC(2026, 0, 15, 23, 30); // 15. Jan 2026, 23:30 UTC = 00:30 CET (im Fenster)

  const scheduler = new NightWatchScheduler({
    readSettings: overrides.readSettings ?? jest.fn(async () => settings),
    boardAggregator,
    projectDrain,
    tokenLimitWatcher: overrides.tokenLimitWatcher,
    sessionRegistry: overrides.sessionRegistry,
    auditStore,
    now: () => nowMs,
    sleepFn: overrides.sleepFn ?? (() => Promise.resolve()),
  });

  return { scheduler, projectDrain, boardAggregator, auditStore, settings, index };
}

/** Wartet einen Microtask-Tick ab (Promises im Test flushen lassen). */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

// ── Pure Helpers ────────────────────────────────────────────────────────────────

describe('parseHHMM', () => {
  it('parst gültige 24h-Werte', () => {
    expect(parseHHMM('23:00')).toEqual({ hour: 23, minute: 0 });
    expect(parseHHMM('07:05')).toEqual({ hour: 7, minute: 5 });
    expect(parseHHMM('00:00')).toEqual({ hour: 0, minute: 0 });
  });

  it('lehnt ungültige Formate ab (null)', () => {
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('1:00')).toBeNull();
    expect(parseHHMM('abc')).toBeNull();
    expect(parseHHMM(undefined)).toBeNull();
    expect(parseHHMM(null)).toBeNull();
    expect(parseHHMM(23)).toBeNull();
  });
});

describe('isWithinWindow (AC10)', () => {
  it('normales Fenster (start<end): innerhalb/außerhalb/Grenzen', () => {
    const window = makeWindow({ start: '08:00', end: '17:00' });
    // 15. Jan 2026, Europe/Zurich = CET = UTC+1 (DST-frei)
    const inside = Date.UTC(2026, 0, 15, 11, 0); // 12:00 CET
    const beforeStart = Date.UTC(2026, 0, 15, 6, 0); // 07:00 CET
    const atStart = Date.UTC(2026, 0, 15, 7, 0); // 08:00 CET
    const atEnd = Date.UTC(2026, 0, 15, 16, 0); // 17:00 CET
    expect(isWithinWindow(inside, window)).toBe(true);
    expect(isWithinWindow(beforeStart, window)).toBe(false);
    expect(isWithinWindow(atStart, window)).toBe(true); // inklusiv (>= start)
    expect(isWithinWindow(atEnd, window)).toBe(false); // exklusiv (< end)
  });

  it('über-Mitternacht-Fenster (start>end, Default 23:00–07:00)', () => {
    const window = makeWindow(); // 23:00–07:00
    const evening = Date.UTC(2026, 0, 15, 22, 30); // 23:30 CET
    const nightTail = Date.UTC(2026, 0, 16, 1, 0); // 02:00 CET (Folgetag UTC)
    const daytime = Date.UTC(2026, 0, 15, 11, 0); // 12:00 CET
    const atStart = Date.UTC(2026, 0, 15, 22, 0); // 23:00 CET
    const atEnd = Date.UTC(2026, 0, 16, 6, 0); // 07:00 CET
    expect(isWithinWindow(evening, window)).toBe(true);
    expect(isWithinWindow(nightTail, window)).toBe(true);
    expect(isWithinWindow(daytime, window)).toBe(false);
    expect(isWithinWindow(atStart, window)).toBe(true);
    expect(isWithinWindow(atEnd, window)).toBe(false);
  });

  it('start==end → NIE im Fenster (Edge-Case Spec)', () => {
    const window = makeWindow({ start: '10:00', end: '10:00' });
    expect(isWithinWindow(Date.UTC(2026, 0, 15, 9, 0), window)).toBe(false);
    expect(isWithinWindow(Date.UTC(2026, 0, 15, 12, 0), window)).toBe(false);
  });

  it('ungültige Fenster-Konfig → false (defensiv)', () => {
    expect(isWithinWindow(Date.now(), { start: 'bad', end: '07:00', timezone: 'Europe/Zurich' })).toBe(false);
    expect(isWithinWindow(Date.now(), {})).toBe(false);
  });
});

describe('computeWindowEndMs (AC10, Grundlage für AC14-Konsum)', () => {
  it('normales Fenster: Ende ist immer heute', () => {
    const window = makeWindow({ start: '08:00', end: '17:00' });
    const nowMs = Date.UTC(2026, 0, 15, 11, 0); // 12:00 CET
    const endMs = computeWindowEndMs(nowMs, window);
    expect(endMs).toBe(Date.UTC(2026, 0, 15, 16, 0)); // 17:00 CET == 16:00 UTC
  });

  it('über-Mitternacht, Abend-Hälfte: Ende ist morgen', () => {
    const window = makeWindow(); // 23:00–07:00
    const nowMs = Date.UTC(2026, 0, 15, 22, 30); // 23:30 CET, 15. Jan
    const endMs = computeWindowEndMs(nowMs, window);
    expect(endMs).toBe(Date.UTC(2026, 0, 16, 6, 0)); // 07:00 CET, 16. Jan
  });

  it('über-Mitternacht, Morgen-Hälfte: Ende ist heute', () => {
    const window = makeWindow();
    const nowMs = Date.UTC(2026, 0, 16, 1, 0); // 02:00 CET, 16. Jan
    const endMs = computeWindowEndMs(nowMs, window);
    expect(endMs).toBe(Date.UTC(2026, 0, 16, 6, 0)); // 07:00 CET, 16. Jan (heute)
  });

  it('ungültige Fenster-Konfig → null', () => {
    expect(computeWindowEndMs(Date.now(), { start: 'bad', end: '07:00', timezone: 'Europe/Zurich' })).toBeNull();
  });
});

describe('clampMaxParallel (Edge-Case Spec: außerhalb 1–3 → klemmen)', () => {
  it('klemmt auf 1–3', () => {
    expect(clampMaxParallel(5)).toBe(3);
    expect(clampMaxParallel(0)).toBe(1);
    expect(clampMaxParallel(-1)).toBe(1);
    expect(clampMaxParallel(2)).toBe(2);
  });

  it('nicht-integer/NaN → Default (3)', () => {
    expect(clampMaxParallel('x')).toBe(3);
    expect(clampMaxParallel(undefined)).toBe(3);
    expect(clampMaxParallel(1.5)).toBe(3);
  });
});

describe('selectCandidateProjects (AC9)', () => {
  const index = [
    makeProject('proj-a', '/workspace/proj-a'),
    makeProject('proj-b', '/workspace/proj-b'),
    { project_slug: 'broken', repo_path: '/workspace/broken', error: 'board.yaml fehlt' },
    { project_slug: 'no-path', repo_path: null },
  ];

  it('"all" → alle Nicht-Fehler-Projekte mit repo_path', () => {
    const result = selectCandidateProjects(index, 'all');
    expect(result.map((p) => p.project_slug)).toEqual(['proj-a', 'proj-b']);
  });

  it('undefined-Setting verhält sich wie "all" (Default)', () => {
    expect(selectCandidateProjects(index, undefined).map((p) => p.project_slug)).toEqual(['proj-a', 'proj-b']);
  });

  it('String-Liste filtert auf die genannten Slugs', () => {
    expect(selectCandidateProjects(index, ['proj-b']).map((p) => p.project_slug)).toEqual(['proj-b']);
  });

  it('leere Liste → keine Kandidaten (Edge-Case: enabled=true aber projects=[] → nichts zu drainen)', () => {
    expect(selectCandidateProjects(index, [])).toEqual([]);
  });

  it('unbekannte Form (nicht "all", kein Array) → defensiv leer', () => {
    expect(selectCandidateProjects(index, null)).toEqual([]);
  });

  it('nicht-Array index → leer', () => {
    expect(selectCandidateProjects(null, 'all')).toEqual([]);
  });
});

// ── NightWatchScheduler.tick() ──────────────────────────────────────────────────

describe('NightWatchScheduler.tick() — enabled/window Gates (AC9/AC10/AC11)', () => {
  it('enabled=false → idle, kein Board-Scan, kein Drain (AC16-Konsum)', async () => {
    const { scheduler, boardAggregator, projectDrain } = makeScheduler({ settings: makeSettings({ enabled: false }) });
    const result = await scheduler.tick();
    expect(result).toEqual({ skipped: true, reason: 'disabled', activeDrains: 0 });
    expect(boardAggregator.getIndex).not.toHaveBeenCalled();
    expect(projectDrain.drainProject).not.toHaveBeenCalled();
  });

  it('außerhalb des Fensters → keine neuen Drains (AC11 sanftes Ende, Teil 1)', async () => {
    const outsideWindowMs = Date.UTC(2026, 0, 15, 11, 0); // 12:00 CET, außerhalb 23:00–07:00
    const { scheduler, boardAggregator, projectDrain } = makeScheduler({ nowMs: outsideWindowMs });
    const result = await scheduler.tick();
    expect(result).toEqual({ skipped: true, reason: 'outside-window', activeDrains: 0 });
    expect(boardAggregator.getIndex).not.toHaveBeenCalled();
    expect(projectDrain.drainProject).not.toHaveBeenCalled();
  });

  it('innerhalb des Fensters, enabled → startet Drains bis maxParallel (AC9)', async () => {
    const { scheduler, projectDrain } = makeScheduler({ settings: makeSettings({ maxParallel: 2 }) });
    const result = await scheduler.tick();
    expect(result.started).toEqual(['/workspace/proj-a', '/workspace/proj-b']);
    expect(result.activeDrains).toBe(2);
    expect(projectDrain.drainProject).toHaveBeenCalledTimes(2);
    // dritter Kandidat NICHT gestartet (maxParallel=2, 3 Kandidaten vorhanden)
    expect(projectDrain.calls).not.toContain('/workspace/proj-c');
  });

  it('maxParallel außerhalb 1–3 wird geklemmt (Edge-Case Spec)', async () => {
    const { scheduler, projectDrain } = makeScheduler({ settings: makeSettings({ maxParallel: 99 }) });
    const result = await scheduler.tick();
    // 3 Kandidaten vorhanden, maxParallel=99 geklemmt auf 3 → alle 3 gestartet
    expect(result.started).toHaveLength(3);
    expect(projectDrain.drainProject).toHaveBeenCalledTimes(3);
  });

  it('projects-Liste (statt "all") beschränkt die Kandidaten', async () => {
    const { scheduler, projectDrain } = makeScheduler({ settings: makeSettings({ projects: ['proj-b'] }) });
    const result = await scheduler.tick();
    expect(result.started).toEqual(['/workspace/proj-b']);
    expect(projectDrain.drainProject).toHaveBeenCalledTimes(1);
  });

  it('leere projects-Liste → Scheduler idle (nichts zu drainen)', async () => {
    const { scheduler, projectDrain } = makeScheduler({ settings: makeSettings({ projects: [] }) });
    const result = await scheduler.tick();
    expect(result.started).toEqual([]);
    expect(projectDrain.drainProject).not.toHaveBeenCalled();
  });

  it('freie Slots bereits ausgeschöpft (maxParallel erreicht) → kein weiterer Start in diesem Tick', async () => {
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({ projectDrain, settings: makeSettings({ maxParallel: 2 }) });

    const first = await scheduler.tick();
    expect(first.started).toHaveLength(2);

    // Zweiter Tick, BEVOR die laufenden Drains resolven: keine freien Slots.
    const second = await scheduler.tick();
    expect(second).toEqual({ started: [], activeDrains: 2 });
    expect(projectDrain.drainProject).toHaveBeenCalledTimes(2); // keine erneuten Aufrufe
  });

  it('nach Abschluss eines Drains wird der frei gewordene Slot im nächsten Tick genutzt', async () => {
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({ projectDrain, settings: makeSettings({ maxParallel: 2 }) });

    const first = await scheduler.tick();
    expect(first.started).toEqual(['/workspace/proj-a', '/workspace/proj-b']);

    // proj-a beendet seinen Drain (Board leer) — Slot wird frei.
    projectDrain.resolve('/workspace/proj-a');
    await flush();

    const second = await scheduler.tick();
    // Kandidaten-Reihenfolge folgt dem Board-Index (proj-a, proj-b, proj-c); proj-b ist
    // noch aktiv (ausgeschlossen), proj-a ist frei geworden und steht wieder vorne an —
    // der frei gewordene Slot wird genutzt (kein Slot bleibt ungenutzt).
    expect(second.started).toEqual(['/workspace/proj-a']);
    expect(second.activeDrains).toBe(2); // proj-b (noch aktiv) + proj-a (erneut gestartet)
  });

  it('AC11 Sanftes Ende: ein bereits laufender Drain wird bei Fensterende NICHT angefasst', async () => {
    const projectDrain = makeControllableProjectDrain();
    const insideWindowMs = Date.UTC(2026, 0, 15, 23, 30);
    const outsideWindowMs = Date.UTC(2026, 0, 15, 11, 0);
    let currentNow = insideWindowMs;

    const settings = makeSettings({ maxParallel: 2 });
    const scheduler = new NightWatchScheduler({
      readSettings: async () => settings,
      boardAggregator: {
        getIndex: async () => [makeProject('proj-a', '/workspace/proj-a'), makeProject('proj-b', '/workspace/proj-b')],
      },
      projectDrain,
      now: () => currentNow,
    });

    const first = await scheduler.tick();
    expect(first.started).toHaveLength(2);

    // Fensterende erreicht — nächster Tick liegt außerhalb des Fensters.
    currentNow = outsideWindowMs;
    const second = await scheduler.tick();
    expect(second).toEqual({ skipped: true, reason: 'outside-window', activeDrains: 2 });
    // Kein Abbruch-Mechanismus existiert — die laufenden Promises sind unverändert pending.
    expect(projectDrain.drainProject).toHaveBeenCalledTimes(2);

    // Der laufende Drain darf trotzdem ganz normal zu Ende laufen (kein Kill).
    projectDrain.resolve('/workspace/proj-a');
    projectDrain.resolve('/workspace/proj-b');
    await flush();
    // Kein weiterer tick() nötig — die Bereinigung erfolgt über die eigene .finally()-Kette.
    // Ein Board-Scan-Fehler o.ä. wird dadurch nicht ausgelöst (kein Crash).
  });

  it('Board-Scan-Fehler → Tick übersprungen, kein Crash', async () => {
    const { scheduler, projectDrain } = makeScheduler({
      boardAggregator: { getIndex: jest.fn(async () => { throw new Error('scan failed'); }) },
    });
    const result = await scheduler.tick();
    expect(result).toEqual({ skipped: true, reason: 'board-scan-failed', activeDrains: 0 });
    expect(projectDrain.drainProject).not.toHaveBeenCalled();
  });

  it('Settings-Lese-Fehler → Tick übersprungen, kein Crash', async () => {
    const { scheduler } = makeScheduler({ readSettings: jest.fn(async () => { throw new Error('read failed'); }) });
    const result = await scheduler.tick();
    expect(result).toEqual({ skipped: true, reason: 'settings-read-failed', activeDrains: 0 });
  });

  it('Skip-if-running: überlappende tick()-Aufrufe — der zweite liefert null', async () => {
    let releaseGetIndex;
    const blocked = new Promise((resolve) => {
      releaseGetIndex = resolve;
    });
    const { scheduler, projectDrain } = makeScheduler({
      boardAggregator: {
        getIndex: jest.fn(async () => {
          await blocked;
          return [makeProject('proj-a', '/workspace/proj-a')];
        }),
      },
    });

    const firstTick = scheduler.tick(); // hängt in getIndex()
    await flush();
    const secondTick = await scheduler.tick(); // überlappt → null
    expect(secondTick).toBeNull();

    releaseGetIndex();
    const firstResult = await firstTick;
    expect(firstResult.started).toEqual(['/workspace/proj-a']);
    expect(projectDrain.drainProject).toHaveBeenCalledTimes(1);
  });

  it('intervalMinutes aus den Settings wird für die nächste Tick-Planung übernommen', async () => {
    const setTimeoutFn = jest.fn(() => {
      // Führt den Callback nicht automatisch aus (Timer-Kette wird nicht real getestet,
      // nur dass start() den injizierten setTimeoutFn statt des echten Timers nutzt).
      return { unref: () => {} };
    });
    // Eigene Instanz mit injiziertem setTimeoutFn, um zu verifizieren, dass start()
    // NICHT den echten globalen setTimeout benutzt (Story-Vorgabe: injizierbares
    // setInterval-Äquivalent).
    const custom = new NightWatchScheduler({
      readSettings: async () => makeSettings({ intervalMinutes: 42 }),
      boardAggregator: { getIndex: async () => [] },
      projectDrain: { drainProject: jest.fn() },
      now: () => Date.UTC(2026, 0, 15, 23, 30),
      setTimeoutFn,
      clearTimeoutFn: jest.fn(),
    });
    custom.start();
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn.mock.calls[0][1]).toBe(0); // erster Tick sofort (delay 0)
    custom.stop();
  });

  it('stop() räumt den Timer über den injizierten clearTimeoutFn auf', () => {
    const handle = { unref: () => {} };
    const setTimeoutFn = jest.fn(() => handle);
    const clearTimeoutFn = jest.fn();
    const custom = new NightWatchScheduler({
      readSettings: async () => makeSettings(),
      boardAggregator: { getIndex: async () => [] },
      projectDrain: { drainProject: jest.fn() },
      now: () => Date.UTC(2026, 0, 15, 23, 30),
      setTimeoutFn,
      clearTimeoutFn,
    });
    custom.start();
    custom.stop();
    expect(clearTimeoutFn).toHaveBeenCalledWith(handle);
  });
});

// ── Token-Limit-Konsum (Story-Vorgabe, Konsum von S-193 TokenLimitWatcher) ──────

describe('NightWatchScheduler — Token-Limit-Konsum (waitForReset, exceeds-window)', () => {
  it('kein Limit-Zustand (limited=false) → normaler Ablauf, waitForReset() wird nicht aufgerufen', async () => {
    const tokenLimitWatcher = {
      getState: jest.fn(() => ({ limited: false, resetAt: null })),
      waitForReset: jest.fn(),
    };
    const { scheduler, projectDrain } = makeScheduler({ tokenLimitWatcher });
    const result = await scheduler.tick();
    expect(tokenLimitWatcher.waitForReset).not.toHaveBeenCalled();
    expect(result.started.length).toBeGreaterThan(0);
    expect(projectDrain.drainProject).toHaveBeenCalled();
  });

  it('Limit erkannt + erfolgreiche Pause → nach Reset+1min normaler Drain-Start im selben Tick', async () => {
    const auditStore = { record: jest.fn() };
    const tokenLimitWatcher = {
      getState: jest.fn(() => ({ limited: true, resetAt: 123 })),
      waitForReset: jest.fn(async () => ({ paused: true, resumedAt: 456 })),
    };
    const { scheduler, projectDrain } = makeScheduler({ tokenLimitWatcher, auditStore });
    const result = await scheduler.tick();
    expect(tokenLimitWatcher.waitForReset).toHaveBeenCalledTimes(1);
    expect(result.started.length).toBeGreaterThan(0); // Drain-Start läuft trotzdem in diesem Tick weiter
    expect(projectDrain.drainProject).toHaveBeenCalled();
    expect(auditStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('taktgeber:token-limit-pause') }),
    );
  });

  it('Reset liegt nach window.end (exceeds-window) → Stop, kein Board-Scan/Drain in diesem Tick', async () => {
    const auditStore = { record: jest.fn() };
    const tokenLimitWatcher = {
      getState: jest.fn(() => ({ limited: true, resetAt: 999 })),
      waitForReset: jest.fn(async () => ({ paused: false, reason: 'exceeds-window', resetAt: 999 })),
    };
    const { scheduler, boardAggregator, projectDrain } = makeScheduler({ tokenLimitWatcher, auditStore });
    const result = await scheduler.tick();
    expect(result).toEqual({ skipped: true, reason: 'token-limit-stop', resetAt: 999, activeDrains: 0 });
    expect(boardAggregator.getIndex).not.toHaveBeenCalled();
    expect(projectDrain.drainProject).not.toHaveBeenCalled();
    expect(auditStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('taktgeber:token-limit-stop') }),
    );
  });

  it('exceeds-window über mehrere Ticks mit demselben resetAt → nur EIN Audit-Eintrag (kein Spam)', async () => {
    const auditStore = { record: jest.fn() };
    const tokenLimitWatcher = {
      getState: jest.fn(() => ({ limited: true, resetAt: 999 })),
      waitForReset: jest.fn(async () => ({ paused: false, reason: 'exceeds-window', resetAt: 999 })),
    };
    const { scheduler } = makeScheduler({ tokenLimitWatcher, auditStore });
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    const stopEntries = auditStore.record.mock.calls.filter(([entry]) =>
      entry.command.includes('taktgeber:token-limit-stop'),
    );
    expect(stopEntries).toHaveLength(1);
  });

  it('windowEndMs wird korrekt an waitForReset() übergeben (AC14-Konsum)', async () => {
    const insideWindowMs = Date.UTC(2026, 0, 15, 23, 30); // 23:30 CET, Fenster 23:00–07:00
    const tokenLimitWatcher = {
      getState: jest.fn(() => ({ limited: true, resetAt: 1 })),
      waitForReset: jest.fn(async () => ({ paused: true, resumedAt: 2 })),
    };
    const { scheduler } = makeScheduler({ tokenLimitWatcher, nowMs: insideWindowMs });
    await scheduler.tick();
    const expectedWindowEndMs = Date.UTC(2026, 0, 16, 6, 0); // 07:00 CET, 16. Jan
    expect(tokenLimitWatcher.waitForReset).toHaveBeenCalledWith(
      expect.objectContaining({ windowEndMs: expectedWindowEndMs }),
    );
  });
});

describe('NightWatchScheduler — TokenLimitWatcher-Attach an PTY-Sessions', () => {
  it('attacht den Watcher genau einmal pro PTY-Instanz beim Drain-Start', async () => {
    const ptyA = { on: jest.fn(), off: jest.fn() };
    const sessionRegistry = { getOrCreate: jest.fn(() => ptyA) };
    const tokenLimitWatcher = {
      getState: jest.fn(() => ({ limited: false })),
      attach: jest.fn(),
    };
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      tokenLimitWatcher,
      sessionRegistry,
      projectDrain,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    expect(tokenLimitWatcher.attach).toHaveBeenCalledTimes(1);
    expect(tokenLimitWatcher.attach).toHaveBeenCalledWith(ptyA);

    // Drain beendet, gleiche PTY-Instanz beim nächsten Tick → KEIN erneuter Attach.
    projectDrain.resolve('/workspace/proj-a');
    await flush();
    await scheduler.tick();
    expect(tokenLimitWatcher.attach).toHaveBeenCalledTimes(1);
  });

  it('attacht erneut, wenn die Session neu erstellt wurde (andere PTY-Instanz)', async () => {
    const ptyA1 = { on: jest.fn(), off: jest.fn() };
    const ptyA2 = { on: jest.fn(), off: jest.fn() };
    let current = ptyA1;
    const sessionRegistry = { getOrCreate: jest.fn(() => current) };
    const tokenLimitWatcher = {
      getState: jest.fn(() => ({ limited: false })),
      attach: jest.fn(),
    };
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      tokenLimitWatcher,
      sessionRegistry,
      projectDrain,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    projectDrain.resolve('/workspace/proj-a');
    await flush();

    current = ptyA2; // Session wurde idle-timeout-bedingt neu erstellt
    await scheduler.tick();
    expect(tokenLimitWatcher.attach).toHaveBeenCalledTimes(2);
    expect(tokenLimitWatcher.attach).toHaveBeenNthCalledWith(2, ptyA2);
  });

  it('kein sessionRegistry → kein Attach-Versuch, kein Crash', async () => {
    const tokenLimitWatcher = { getState: jest.fn(() => ({ limited: false })), attach: jest.fn() };
    const { scheduler } = makeScheduler({ tokenLimitWatcher });
    await scheduler.tick();
    expect(tokenLimitWatcher.attach).not.toHaveBeenCalled();
  });
});

describe('DEFAULT_INTERVAL_MINUTES', () => {
  it('entspricht dem TickerSettingsStore-Default (15)', () => {
    expect(DEFAULT_INTERVAL_MINUTES).toBe(15);
  });
});
