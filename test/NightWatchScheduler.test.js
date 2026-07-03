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
 *   AC17 — `getStatus()` (S-197, Erweiterungspunkt für die Statusanzeige):
 *          rein lesender Snapshot der aktuell aktiven Drain-Projektpfade
 *          (leer ohne aktive Drains; enthält genau die laufenden Pfade;
 *          Einträge verschwinden nach Abschluss des jeweiligen Drains).
 *
 *   Zusätzlich (Story-Vorgabe, Konsum von TokenLimitWatcher S-193 — AC13/14
 *   selbst bleiben dort implementiert): Token-Limit-Pause (bis Reset+1min,
 *   danach normaler Drain-Start im selben Tick) und `exceeds-window` →
 *   `token-limit-stop` (kein Board-Scan/Drain in diesem Tick, Audit-Dedupe
 *   pro `resetAt`). `#attachTokenWatcher`: Attach nur einmal pro
 *   PTY-Instanz (Objekt-Identität), erneuter Attach bei Session-Neuerstellung.
 *   NICHT-ERZEUGEND (S-213 CRITICAL-Fix Iteration 2, headless-parallel-drain
 *   AC7): Attach findet NUR statt, wenn `sessionRegistry.hasSession()`
 *   bereits `true` ist — NIE via `getOrCreate()` selbst eine PTY-Session
 *   anlegen (sonst Selbst-Blockade über `ProjectDrain#isProjectBusy()`, siehe
 *   `.claude/lessons/coder.md` 2026-07-01). Die ECHTE Naht (beide
 *   Collaborators teilen dieselbe `sessionRegistry`-Instanz, exakt wie
 *   `server.js`) lebt als eigener Regressionstest in
 *   test/headless-night-drain.integration.test.js.
 *
 * Covers (headless-parallel-drain):
 *   AC9 — Auth-Vorabprüfung: `claudeAuthHealthService.getState().claudeAuth
 *         === 'expired'` → dieser Tick startet KEINE neuen Drains (Board-Scan
 *         + `projectDrain.drainProject()` werden gar nicht erst aufgerufen)
 *         + EIN Audit-Eintrag (Dedupe über mehrere Ticks hinweg, analog
 *         `token-limit-stop`). `'ok'`/`'unknown'` blockieren nicht (kein
 *         Fehlalarm-Stop). Kein injizierter `claudeAuthHealthService` →
 *         Scheduler läuft unverändert ohne Auth-Gate (Rückwärtskompatibilität).
 *   Die ECHTE Naht (Scheduler + ProjectDrain + HeadlessFlowRunnerAdapter +
 *   HeadlessFlowRunner, AC7/AC8/AC11/AC12 — real-parallelism-Beleg + Selbst-
 *   Blockade-Vermeidung) lebt in
 *   test/headless-night-drain.integration.test.js (echte Prozess-Naht, kein
 *   ProjectDrain-Mock — dieselbe Konvention wie
 *   nightwatch-lock-contention.integration.test.js).
 *
 * Covers (cost-mode-model-check, S-228):
 *   AC4 — Dispatch-Frische-Prüfung vor dem Nacht-Drain: pro gestartetem Drain
 *         wird `costModeModelCheck.runCheck('dispatch')` genau einmal aufgerufen.
 *   AC5 — nicht-blockierend: die Prüfung wird fire-and-forget angestoßen (nicht
 *         awaitet) — ein werfendes/hängendes `runCheck` verhindert den
 *         Drain-Start NIE (drainProject wird trotzdem aufgerufen). Kein
 *         injizierter `costModeModelCheck` → Scheduler läuft unverändert (No-op).
 *
 * Covers (drain-completion-report, S-254):
 *   AC6 — je abgeschlossenem Nacht-Drain wird GENAU EIN Bericht (`trigger:'night'`)
 *         in die geteilte DrainReportStore-Instanz geschrieben: der Slug (kein
 *         Pfad), Start-/Endzeit (injizierte Uhr), reason/flowRuns sowie die
 *         completed/blocked-Stories aus dem Drain-Ergebnis. Ein rejecteter Drain
 *         crasht den Scheduler NICHT und schreibt einen secret-freien
 *         `reason:'drain-failed'`-Bericht (kein Roh-Fehlertext). Ein werfender
 *         Store (`record` rejected/throws) crasht den Scheduler ebenfalls nicht
 *         (best-effort). Kein injizierter Store → Scheduler läuft unverändert
 *         (No-op). Der DrainReportStore-Baustein selbst ist zusätzlich unit-
 *         getestet in test/DrainReportStore.test.js.
 *
 * Covers (retro-auto-trigger, S-261):
 *   AC4 — nach JEDEM abgeschlossenen Nacht-Drain wird der Auto-Retro-Check an der
 *         Drain-Abschluss-Naht best-effort/fire-and-forget angestoßen
 *         (`autoRetroTrigger.notifyDrainComplete(projectPath, drainResult)`) —
 *         mit dem echten Drain-Ergebnis (inkl. `flowRuns`); ein werfender Trigger
 *         crasht den Scheduler NICHT (Drain-Eintrag wird sauber abgeräumt). Kein
 *         injizierter `autoRetroTrigger` → Scheduler läuft unverändert (No-op).
 *   AC6 — der Auslöser erhält den absoluten Repo-Pfad als Dedup-/Runner-Schlüssel;
 *         die eigentliche Fälligkeits-/Enqueue-Logik (isRetroDue) ist in
 *         test/AutoRetroTrigger.test.js unit-getestet (kein zweiter Codepfad:
 *         dieselbe Instanz wie der manuelle Drain — server.js-Verdrahtung).
 *
 * Covers (drain-restart-robustness, S-282):
 *   AC3 — je gestartetem Nacht-Drain wird GENAU EIN `register(drainId,
 *         {project,trigger:'night',startedAt})` an die geteilte
 *         `DrainJobRegistry` gerufen (neue `drainId` je Drain); bei Abschluss
 *         (resolve/reject) `markDone`/`markFailed` mit DERSELBEN `drainId`.
 *         `#activeDrains` bleibt davon vollständig unberührt (additiv). Ein
 *         werfender/rejectender Registry-Aufruf crasht den Scheduler NICHT
 *         (Drain-Eintrag wird sauber abgeräumt). Ohne Slug → keine
 *         Registrierung (kein leerer/ungültiger Slug in der Persistenz). Kein
 *         injizierter `drainJobRegistry` → Scheduler läuft unverändert (No-op).
 *         Der `DrainJobRegistry`-Baustein selbst (Persistenz, `reconcileOrphans`,
 *         AC1/AC2/AC4) ist zusätzlich unit-getestet in
 *         test/DrainJobRegistry.test.js.
 *
 * Covers (night-budget-guard, S-274/S-275):
 *   AC10 — `#runTick` bestimmt je Tick `computeWindowEndMs(nowMs, window)`
 *          und reicht das Ergebnis als `opts.windowEndMs` an JEDEN in diesem
 *          Tick frisch gestarteten `projectDrain.drainProject()`-Aufruf
 *          weiter (über-Mitternacht- UND normales Fenster geprüft) — die
 *          konkrete `BudgetGuard`-Injektion selbst (server.js-Verdrahtung)
 *          lebt außerhalb dieser Unit-Test-Datei (kein `claude`-Lauf/IO
 *          hier nötig, Testbarkeits-NFR der Spec).
 *   AC12 — `#recordNightReport` reicht `result.budgetPauses` additiv an
 *          `DrainReportStore.record()` durch (Nacht-Drain persistiert die
 *          Budget-Pausen); fehlt das Feld im Drain-Ergebnis (z.B. der
 *          `drain-failed`-Zweig) → `[]` (kein Crash, kein Regress an den
 *          bestehenden Report-Feldern).
 *
 * Covers (drain-done-notification, S-277):
 *   AC4 — je abgeschlossenem Projekt-Drain (resolve UND reject, symmetrisch
 *         zu `#recordNightReport`/`#notifyAutoRetro`) wird best-effort
 *         `drainNotifier.notifyDrainDone({ slug, result })` mit dem bereits
 *         abgeleiteten Projekt-Slug (kein Pfad) aufgerufen; ein werfender
 *         Notifier crasht den Scheduler NICHT (Drain-Eintrag wird sauber
 *         abgeräumt). Kein injizierter `drainNotifier` → Scheduler läuft
 *         unverändert (No-op). Das Gating selbst (flowRuns/enabled/events) ist
 *         in test/DrainNotifier.test.js unit-getestet (kein zweiter Codepfad —
 *         dieselbe Instanz wie der manuelle Drain, server.js-Verdrahtung).
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
    claudeAuthHealthService: overrides.claudeAuthHealthService,
    costModeModelCheck: overrides.costModeModelCheck,
    drainReportStore: overrides.drainReportStore,
    autoRetroTrigger: overrides.autoRetroTrigger,
    drainNotifier: overrides.drainNotifier,
    drainJobRegistry: overrides.drainJobRegistry,
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

// ── Cost-Mode-Dispatch-Frische-Prüfung (cost-mode-model-check AC4/AC5, S-228) ──

describe('NightWatchScheduler — Cost-Mode-Frische-Prüfung vor dem Nacht-Drain (cost-mode-model-check AC4/AC5)', () => {
  it('AC4 — runCheck("dispatch") wird pro gestartetem Drain genau einmal aufgerufen', async () => {
    const runCheck = jest.fn(async () => ({ drift: false, reason: 'fresh' }));
    const { scheduler, projectDrain } = makeScheduler({
      costModeModelCheck: { runCheck },
      settings: makeSettings({ maxParallel: 2 }),
    });

    const result = await scheduler.tick();

    expect(result.started).toHaveLength(2);
    expect(projectDrain.drainProject).toHaveBeenCalledTimes(2);
    // Genau ein runCheck('dispatch') je gestartetem Drain.
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(runCheck).toHaveBeenCalledWith('dispatch');
  });

  it('AC5 — nicht-blockierend: ein werfendes runCheck verhindert den Drain-Start NICHT', async () => {
    const runCheck = jest.fn(() => { throw new Error('curator boom'); });
    const { scheduler, projectDrain } = makeScheduler({
      costModeModelCheck: { runCheck },
      settings: makeSettings({ maxParallel: 2 }),
    });

    const result = await scheduler.tick();

    expect(result.started).toHaveLength(2);
    expect(projectDrain.drainProject).toHaveBeenCalledTimes(2);
    expect(runCheck).toHaveBeenCalledTimes(2);
  });

  it('AC5 — nicht-blockierend: ein rejectendes runCheck-Promise crasht den Tick nicht', async () => {
    const runCheck = jest.fn(async () => { throw new Error('async boom'); });
    const { scheduler, projectDrain } = makeScheduler({
      costModeModelCheck: { runCheck },
      settings: makeSettings({ maxParallel: 1 }),
    });

    const result = await scheduler.tick();
    await flush();

    expect(result.started).toHaveLength(1);
    expect(projectDrain.drainProject).toHaveBeenCalledTimes(1);
  });

  it('ohne injizierten costModeModelCheck läuft der Scheduler unverändert (No-op)', async () => {
    const { scheduler, projectDrain } = makeScheduler({ settings: makeSettings({ maxParallel: 2 }) });
    const result = await scheduler.tick();
    expect(result.started).toHaveLength(2);
    expect(projectDrain.drainProject).toHaveBeenCalledTimes(2);
  });
});

// ── windowEndMs-Weiterreichung (night-budget-guard AC10, S-274) ────────────────

describe('NightWatchScheduler — windowEndMs-Weiterreichung an drainProject (night-budget-guard AC10)', () => {
  it('über-Mitternacht-Fenster: jeder gestartete Drain erhält das für "jetzt" gültige windowEndMs', async () => {
    // 15. Jan 2026, 23:30 UTC = 00:30 CET, 16. Jan → Morgen-Hälfte des
    // 23:00–07:00-Fensters → Fensterende liegt noch "heute" (16. Jan, 07:00 CET).
    const nowMs = Date.UTC(2026, 0, 15, 23, 30);
    const window = makeWindow(); // 23:00–07:00, Europe/Zurich
    const expectedWindowEndMs = computeWindowEndMs(nowMs, window);
    expect(expectedWindowEndMs).not.toBeNull();

    const { scheduler, projectDrain } = makeScheduler({
      nowMs,
      settings: makeSettings({ window, maxParallel: 2 }),
    });
    const result = await scheduler.tick();

    expect(result.started).toHaveLength(2);
    expect(projectDrain.drainProject).toHaveBeenCalledWith(
      '/workspace/proj-a',
      expect.objectContaining({ windowEndMs: expectedWindowEndMs }),
    );
    expect(projectDrain.drainProject).toHaveBeenCalledWith(
      '/workspace/proj-b',
      expect.objectContaining({ windowEndMs: expectedWindowEndMs }),
    );
  });

  it('normales (nicht über-Mitternacht) Fenster: windowEndMs weiterhin korrekt durchgereicht', async () => {
    const nowMs = Date.UTC(2026, 0, 15, 11, 0); // 12:00 CET
    const window = makeWindow({ start: '08:00', end: '17:00' });
    const expectedWindowEndMs = computeWindowEndMs(nowMs, window);
    expect(expectedWindowEndMs).not.toBeNull();

    const { scheduler, projectDrain } = makeScheduler({
      nowMs,
      settings: makeSettings({ window, maxParallel: 1 }),
    });
    const result = await scheduler.tick();

    expect(result.started).toHaveLength(1);
    expect(projectDrain.drainProject).toHaveBeenCalledWith(
      '/workspace/proj-a',
      expect.objectContaining({ windowEndMs: expectedWindowEndMs }),
    );
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

// ── Auth-Vorabprüfung (headless-parallel-drain AC9) ─────────────────────────────

describe('NightWatchScheduler — Auth-Vorabprüfung (headless-parallel-drain AC9)', () => {
  it('kein claudeAuthHealthService injiziert → Scheduler läuft unverändert ohne Auth-Gate', async () => {
    const { scheduler, projectDrain } = makeScheduler({ claudeAuthHealthService: undefined });
    const result = await scheduler.tick();
    expect(result.started.length).toBeGreaterThan(0);
    expect(projectDrain.drainProject).toHaveBeenCalled();
  });

  it('claudeAuth: "ok" → normaler Ablauf, keine Blockade', async () => {
    const claudeAuthHealthService = { getState: jest.fn(() => ({ claudeAuth: 'ok', lastCheckedAt: '2026-01-15T00:00:00.000Z' })) };
    const { scheduler, projectDrain } = makeScheduler({ claudeAuthHealthService });
    const result = await scheduler.tick();
    expect(result.started.length).toBeGreaterThan(0);
    expect(projectDrain.drainProject).toHaveBeenCalled();
  });

  it('claudeAuth: "unknown" → normaler Ablauf (kein Fehlalarm-Stop)', async () => {
    const claudeAuthHealthService = { getState: jest.fn(() => ({ claudeAuth: 'unknown', lastCheckedAt: null })) };
    const { scheduler, projectDrain } = makeScheduler({ claudeAuthHealthService });
    const result = await scheduler.tick();
    expect(result.started.length).toBeGreaterThan(0);
    expect(projectDrain.drainProject).toHaveBeenCalled();
  });

  it('claudeAuth: "expired" → keine neuen Drains, kein Board-Scan, Audit-Eintrag', async () => {
    const claudeAuthHealthService = {
      getState: jest.fn(() => ({ claudeAuth: 'expired', lastCheckedAt: '2026-01-15T00:00:00.000Z' })),
    };
    const { scheduler, projectDrain, boardAggregator, auditStore } = makeScheduler({ claudeAuthHealthService });
    const result = await scheduler.tick();
    expect(result).toEqual({ skipped: true, reason: 'auth-expired', activeDrains: 0 });
    expect(boardAggregator.getIndex).not.toHaveBeenCalled();
    expect(projectDrain.drainProject).not.toHaveBeenCalled();
    expect(auditStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('taktgeber:auth-expired-skip') }),
    );
  });

  it('expired über mehrere Ticks mit unverändertem Zustand → nur EIN Audit-Eintrag (kein Spam)', async () => {
    const claudeAuthHealthService = { getState: jest.fn(() => ({ claudeAuth: 'expired', lastCheckedAt: null })) };
    const { scheduler, auditStore } = makeScheduler({ claudeAuthHealthService });
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    const expiredEntries = auditStore.record.mock.calls.filter(([entry]) =>
      entry.command.includes('taktgeber:auth-expired-skip'),
    );
    expect(expiredEntries).toHaveLength(1);
  });

  it('expired → ok → erneut expired: der zweite expired-Zustand wird wieder auditiert (Dedupe-Reset)', async () => {
    let state = { claudeAuth: 'expired', lastCheckedAt: null };
    const claudeAuthHealthService = { getState: jest.fn(() => state) };
    const { scheduler, auditStore } = makeScheduler({ claudeAuthHealthService });

    await scheduler.tick(); // expired #1 → auditiert
    state = { claudeAuth: 'ok', lastCheckedAt: null };
    await scheduler.tick(); // ok → Dedupe zurückgesetzt
    state = { claudeAuth: 'expired', lastCheckedAt: null };
    await scheduler.tick(); // expired #2 → erneut auditiert

    const expiredEntries = auditStore.record.mock.calls.filter(([entry]) =>
      entry.command.includes('taktgeber:auth-expired-skip'),
    );
    expect(expiredEntries).toHaveLength(2);
  });

  it('Auth-Gate greift NACH dem Fenster-Check (außerhalb des Fensters bleibt "outside-window", nicht "auth-expired")', async () => {
    const claudeAuthHealthService = { getState: jest.fn(() => ({ claudeAuth: 'expired', lastCheckedAt: null })) };
    const outsideWindowMs = Date.UTC(2026, 0, 15, 11, 0);
    const { scheduler } = makeScheduler({ claudeAuthHealthService, nowMs: outsideWindowMs });
    const result = await scheduler.tick();
    expect(result).toEqual({ skipped: true, reason: 'outside-window', activeDrains: 0 });
    // Das Auth-Gate wurde erst gar nicht ausgewertet (Fenster-Check hat bereits gestoppt).
    expect(claudeAuthHealthService.getState).not.toHaveBeenCalled();
  });
});

describe('NightWatchScheduler — TokenLimitWatcher-Attach an PTY-Sessions (NICHT-ERZEUGEND, S-213 CRITICAL-Fix Iteration 2)', () => {
  it('attacht den Watcher genau einmal pro PTY-Instanz beim Drain-Start — NUR wenn bereits eine Session existiert (hasSession:true)', async () => {
    const ptyA = { on: jest.fn(), off: jest.fn() };
    // hasSession:true simuliert eine UNABHÄNGIG vom Scheduler bereits bestehende
    // (z.B. manuell in der UI geöffnete) Session — genau der Fall, in dem
    // Attach weiterhin stattfinden soll.
    const sessionRegistry = { hasSession: jest.fn(() => true), getOrCreate: jest.fn(() => ptyA) };
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
    expect(sessionRegistry.hasSession).toHaveBeenCalledWith('/workspace/proj-a');
    expect(tokenLimitWatcher.attach).toHaveBeenCalledTimes(1);
    expect(tokenLimitWatcher.attach).toHaveBeenCalledWith(ptyA);

    // Drain beendet, gleiche PTY-Instanz beim nächsten Tick → KEIN erneuter Attach.
    projectDrain.resolve('/workspace/proj-a');
    await flush();
    await scheduler.tick();
    expect(tokenLimitWatcher.attach).toHaveBeenCalledTimes(1);
  });

  it('attacht erneut, wenn die Session neu erstellt wurde (andere PTY-Instanz, weiterhin hasSession:true)', async () => {
    const ptyA1 = { on: jest.fn(), off: jest.fn() };
    const ptyA2 = { on: jest.fn(), off: jest.fn() };
    let current = ptyA1;
    const sessionRegistry = { hasSession: jest.fn(() => true), getOrCreate: jest.fn(() => current) };
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

  it(
    'CRITICAL-FIX (S-213 Iteration 2): hasSession:false (frisches Projekt OHNE offene Session) → ' +
      'KEIN getOrCreate()-Aufruf, KEIN Attach — Selbst-Blockade-Vermeidung (kein Session-CREATE durch den Scheduler selbst)',
    async () => {
      const sessionRegistry = { hasSession: jest.fn(() => false), getOrCreate: jest.fn() };
      const tokenLimitWatcher = { getState: jest.fn(() => ({ limited: false })), attach: jest.fn() };
      const projectDrain = makeControllableProjectDrain();
      const { scheduler } = makeScheduler({
        tokenLimitWatcher,
        sessionRegistry,
        projectDrain,
        settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
      });

      await scheduler.tick();
      expect(sessionRegistry.hasSession).toHaveBeenCalledWith('/workspace/proj-a');
      // Der zentrale Fix-Beleg: getOrCreate() (Session-CREATE) wird NIE aufgerufen.
      expect(sessionRegistry.getOrCreate).not.toHaveBeenCalled();
      expect(tokenLimitWatcher.attach).not.toHaveBeenCalled();
    },
  );
});

describe('DEFAULT_INTERVAL_MINUTES', () => {
  it('entspricht dem TickerSettingsStore-Default (15)', () => {
    expect(DEFAULT_INTERVAL_MINUTES).toBe(15);
  });
});

// ── getStatus() (S-197, AC17 — Erweiterungspunkt für die Statusanzeige) ─────────

describe('NightWatchScheduler.getStatus() (S-197 AC17)', () => {
  it('keine aktiven Drains → leere Liste', () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.getStatus()).toEqual({ activeDrainProjectPaths: [] });
  });

  it('während laufender Drains → activeDrainProjectPaths enthält genau die aktiven Projektpfade', async () => {
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({ projectDrain, settings: makeSettings({ maxParallel: 2 }) });

    await scheduler.tick();
    expect(scheduler.getStatus().activeDrainProjectPaths.sort()).toEqual(
      ['/workspace/proj-a', '/workspace/proj-b'].sort(),
    );

    // Nach Abschluss eines Drains wird er aus dem Status entfernt (asynchron über .finally()).
    projectDrain.resolve('/workspace/proj-a');
    await flush();
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual(['/workspace/proj-b']);
  });
});

// ── Nacht-Abschlussbericht (drain-completion-report S-254 AC6) ──────────────────

describe('NightWatchScheduler — Abschlussbericht je Nacht-Drain (drain-completion-report AC6)', () => {
  function makeReportStore() {
    const records = [];
    return {
      records,
      record: jest.fn(async (r) => {
        records.push(r);
        return { ...r, reportId: 'rep-' + records.length };
      }),
    };
  }

  it('schreibt bei Abschluss GENAU EINEN Bericht (trigger:night) mit Slug + completed/blocked', async () => {
    const drainReportStore = makeReportStore();
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      drainReportStore,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    // Noch kein Bericht, solange der Drain läuft.
    expect(drainReportStore.record).not.toHaveBeenCalled();

    projectDrain.resolve('/workspace/proj-a', {
      stopped: true,
      reason: 'no-drain-target',
      flowRuns: 3,
      escalated: ['S-9'],
      completed: [{ id: 'S-1', title: 'Story eins' }],
      blocked: [{ id: 'S-9', title: 'Story neun' }],
    });
    await flush();

    expect(drainReportStore.record).toHaveBeenCalledTimes(1);
    const report = drainReportStore.records[0];
    expect(report.project).toBe('proj-a');
    expect(report.trigger).toBe('night');
    expect(report.reason).toBe('no-drain-target');
    expect(report.flowRuns).toBe(3);
    expect(report.completed).toEqual([{ id: 'S-1', title: 'Story eins' }]);
    expect(report.blocked).toEqual([{ id: 'S-9', title: 'Story neun' }]);
    expect(typeof report.startedAt).toBe('string');
    expect(typeof report.finishedAt).toBe('string');
    // Security-Floor: kein absoluter Pfad im Bericht.
    expect(JSON.stringify(report)).not.toContain('/workspace/');
  });

  it('ein rejecteter Drain crasht den Scheduler NICHT und schreibt einen secret-freien drain-failed-Bericht', async () => {
    const drainReportStore = makeReportStore();
    const drainProject = {
      drainProject: jest.fn(async () => {
        throw new Error('geheimer /pfad/mit/secret Fehler');
      }),
    };
    const { scheduler } = makeScheduler({
      projectDrain: drainProject,
      drainReportStore,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await expect(scheduler.tick()).resolves.toBeTruthy();
    await flush();

    expect(drainReportStore.record).toHaveBeenCalledTimes(1);
    const report = drainReportStore.records[0];
    expect(report.project).toBe('proj-a');
    expect(report.trigger).toBe('night');
    expect(report.reason).toBe('drain-failed');
    expect(report.completed).toEqual([]);
    expect(report.blocked).toEqual([]);
    // Kein Roh-Fehlertext/Secret im Bericht.
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(JSON.stringify(report)).not.toContain('/pfad/');
  });

  it('ein werfender/rejectender Store crasht den Scheduler NICHT (best-effort)', async () => {
    const drainReportStore = {
      record: jest.fn(async () => {
        throw new Error('Store kaputt');
      }),
    };
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      drainReportStore,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    projectDrain.resolve('/workspace/proj-a');
    // Der Drain-Eintrag verschwindet trotz Store-Fehler sauber (kein unhandled reject).
    await flush();
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual([]);
  });

  it('ohne injizierten Store läuft der Scheduler unverändert (No-op)', async () => {
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });
    await scheduler.tick();
    projectDrain.resolve('/workspace/proj-a');
    await flush();
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual([]);
  });

  it('night-budget-guard AC12 — reicht budgetPauses aus dem Drain-Ergebnis additiv an den Bericht durch', async () => {
    const drainReportStore = makeReportStore();
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      drainReportStore,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    projectDrain.resolve('/workspace/proj-a', {
      stopped: true,
      reason: 'budget-window-end',
      flowRuns: 1,
      escalated: [],
      completed: [],
      blocked: [],
      budgetPauses: [{ from: 1000, to: null, reason: 'proactive-threshold' }],
    });
    await flush();

    expect(drainReportStore.record).toHaveBeenCalledTimes(1);
    const report = drainReportStore.records[0];
    expect(report.budgetPauses).toEqual([{ from: 1000, to: null, reason: 'proactive-threshold' }]);
  });

  it('night-budget-guard AC12 — fehlendes budgetPauses im Drain-Ergebnis (drain-failed) → [] im Bericht', async () => {
    const drainReportStore = makeReportStore();
    const drainProject = {
      drainProject: jest.fn(async () => {
        throw new Error('geheimer /pfad/mit/secret Fehler');
      }),
    };
    const { scheduler } = makeScheduler({
      projectDrain: drainProject,
      drainReportStore,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    await flush();

    expect(drainReportStore.record).toHaveBeenCalledTimes(1);
    const report = drainReportStore.records[0];
    expect(report.budgetPauses).toEqual([]);
  });
});

// ── Auto-Retro-Auslösung an der Nacht-Drain-Abschluss-Naht (retro-auto-trigger S-261 AC4/AC6) ──

describe('NightWatchScheduler — Auto-Retro-Auslösung an der Drain-Abschluss-Naht (retro-auto-trigger AC4/AC6)', () => {
  function makeAutoRetroTrigger() {
    return { notifyDrainComplete: jest.fn() };
  }

  it('AC4/AC6 — nach dem abgeschlossenen Drain wird notifyDrainComplete mit Pfad + echtem Ergebnis (flowRuns) angestoßen', async () => {
    const autoRetroTrigger = makeAutoRetroTrigger();
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      autoRetroTrigger,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    // Solange der Drain läuft, wird der Auto-Retro-Check NICHT angestoßen.
    expect(autoRetroTrigger.notifyDrainComplete).not.toHaveBeenCalled();

    projectDrain.resolve('/workspace/proj-a', {
      stopped: true,
      reason: 'no-drain-target',
      flowRuns: 2,
      escalated: [],
      completed: [{ id: 'S-1' }],
      blocked: [],
    });
    await flush();

    expect(autoRetroTrigger.notifyDrainComplete).toHaveBeenCalledTimes(1);
    const [projectPath, drainResult] = autoRetroTrigger.notifyDrainComplete.mock.calls[0];
    expect(projectPath).toBe('/workspace/proj-a');
    expect(drainResult.flowRuns).toBe(2);
  });

  it('AC4 — ein rejecteter Drain stößt notifyDrainComplete mit flowRuns:0 an (symmetrisch, kein Enqueue nachgelagert)', async () => {
    const autoRetroTrigger = makeAutoRetroTrigger();
    const drainProject = {
      drainProject: jest.fn(async () => {
        throw new Error('drain kaputt');
      }),
    };
    const { scheduler } = makeScheduler({
      projectDrain: drainProject,
      autoRetroTrigger,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await expect(scheduler.tick()).resolves.toBeTruthy();
    await flush();

    expect(autoRetroTrigger.notifyDrainComplete).toHaveBeenCalledTimes(1);
    const [projectPath, drainResult] = autoRetroTrigger.notifyDrainComplete.mock.calls[0];
    expect(projectPath).toBe('/workspace/proj-a');
    expect(drainResult.flowRuns).toBe(0);
  });

  it('AC4 — ein werfender autoRetroTrigger crasht den Scheduler NICHT (best-effort, Drain-Eintrag sauber abgeräumt)', async () => {
    const autoRetroTrigger = {
      notifyDrainComplete: jest.fn(() => {
        throw new Error('trigger kaputt');
      }),
    };
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      autoRetroTrigger,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    projectDrain.resolve('/workspace/proj-a', { stopped: true, reason: 'no-drain-target', flowRuns: 1 });
    await flush();

    expect(autoRetroTrigger.notifyDrainComplete).toHaveBeenCalledTimes(1);
    // Trotz Trigger-Fehler: der Drain-Eintrag verschwindet sauber (kein unhandled reject, kein Crash).
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual([]);
  });

  it('AC4 — ohne injizierten autoRetroTrigger läuft der Scheduler unverändert (No-op, kein Crash)', async () => {
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });
    await scheduler.tick();
    projectDrain.resolve('/workspace/proj-a', { stopped: true, reason: 'no-drain-target', flowRuns: 1 });
    await flush();
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual([]);
  });
});

// ── Drain-Fertig-Push an der Nacht-Drain-Abschluss-Naht (drain-done-notification S-277 AC4) ──

describe('NightWatchScheduler — Drain-Fertig-Push an der Drain-Abschluss-Naht (drain-done-notification AC4)', () => {
  function makeDrainNotifier() {
    return { notifyDrainDone: jest.fn(async () => {}) };
  }

  it('AC4 — nach dem abgeschlossenen Drain wird notifyDrainDone mit Slug + echtem Ergebnis angestoßen', async () => {
    const drainNotifier = makeDrainNotifier();
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      drainNotifier,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    expect(drainNotifier.notifyDrainDone).not.toHaveBeenCalled();

    projectDrain.resolve('/workspace/proj-a', {
      stopped: true,
      reason: 'no-drain-target',
      flowRuns: 2,
      escalated: [],
      completed: [{ id: 'S-1' }],
      blocked: [],
    });
    await flush();

    expect(drainNotifier.notifyDrainDone).toHaveBeenCalledTimes(1);
    const [args] = drainNotifier.notifyDrainDone.mock.calls[0];
    expect(args.slug).toBe('proj-a'); // der bereits abgeleitete Projekt-Slug, KEIN Pfad
    expect(args.result.flowRuns).toBe(2);
    expect(args.result.completed).toEqual([{ id: 'S-1' }]);
  });

  it('AC4 — ein rejecteter Drain stößt notifyDrainDone mit flowRuns:0 an (symmetrisch, Gating lebt im Notifier)', async () => {
    const drainNotifier = makeDrainNotifier();
    const projectDrain = {
      drainProject: jest.fn(async () => {
        throw new Error('drain kaputt');
      }),
    };
    const { scheduler } = makeScheduler({
      projectDrain,
      drainNotifier,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await expect(scheduler.tick()).resolves.toBeTruthy();
    await flush();

    expect(drainNotifier.notifyDrainDone).toHaveBeenCalledTimes(1);
    const [args] = drainNotifier.notifyDrainDone.mock.calls[0];
    expect(args.slug).toBe('proj-a');
    expect(args.result.flowRuns).toBe(0);
  });

  it('AC4 — ein werfender drainNotifier crasht den Scheduler NICHT (best-effort, Drain-Eintrag sauber abgeräumt)', async () => {
    const drainNotifier = {
      notifyDrainDone: jest.fn(() => {
        throw new Error('notifier kaputt');
      }),
    };
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      drainNotifier,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    projectDrain.resolve('/workspace/proj-a', { stopped: true, reason: 'no-drain-target', flowRuns: 1 });
    await flush();

    expect(drainNotifier.notifyDrainDone).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual([]);
  });

  it('AC4 — ohne injizierten drainNotifier läuft der Scheduler unverändert (No-op, kein Crash)', async () => {
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });
    await scheduler.tick();
    projectDrain.resolve('/workspace/proj-a', { stopped: true, reason: 'no-drain-target', flowRuns: 1 });
    await flush();
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual([]);
  });
});

// ── Nacht-Drain-Registrierung in der geteilten persistenten Registry (drain-restart-robustness AC3, S-282) ──

describe('NightWatchScheduler — Registrierung in der geteilten DrainJobRegistry (drain-restart-robustness AC3)', () => {
  function makeJobRegistry() {
    const jobs = new Map();
    return {
      jobs,
      register: jest.fn((drainId, meta) => {
        jobs.set(drainId, { ...meta, status: 'running' });
      }),
      markDone: jest.fn((drainId, result) => {
        const existing = jobs.get(drainId);
        jobs.set(drainId, { ...existing, status: 'done', result });
      }),
      markFailed: jest.fn((drainId) => {
        const existing = jobs.get(drainId);
        jobs.set(drainId, { ...existing, status: 'failed' });
      }),
    };
  }

  it('registriert einen gestarteten Nacht-Drain mit trigger:night + Projekt-Slug, VOR dem Abschluss', async () => {
    const drainJobRegistry = makeJobRegistry();
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      drainJobRegistry,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();

    expect(drainJobRegistry.register).toHaveBeenCalledTimes(1);
    const [drainId, meta] = drainJobRegistry.register.mock.calls[0];
    expect(typeof drainId).toBe('string');
    expect(drainId.length).toBeGreaterThan(0);
    expect(meta.project).toBe('proj-a');
    expect(meta.trigger).toBe('night');
    expect(typeof meta.startedAt).toBe('string');
    // Noch kein terminaler Aufruf, solange der Drain läuft.
    expect(drainJobRegistry.markDone).not.toHaveBeenCalled();
    expect(drainJobRegistry.markFailed).not.toHaveBeenCalled();

    projectDrain.resolve('/workspace/proj-a', { stopped: true, reason: 'no-drain-target', flowRuns: 1 });
    await flush();
  });

  it('markiert den Registry-Eintrag bei erfolgreichem Abschluss als done, mit derselben drainId', async () => {
    const drainJobRegistry = makeJobRegistry();
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      drainJobRegistry,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    const [drainId] = drainJobRegistry.register.mock.calls[0];

    projectDrain.resolve('/workspace/proj-a', { stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: [] });
    await flush();

    expect(drainJobRegistry.markDone).toHaveBeenCalledTimes(1);
    const [doneDrainId, result] = drainJobRegistry.markDone.mock.calls[0];
    expect(doneDrainId).toBe(drainId);
    expect(result.flowRuns).toBe(2);
    expect(drainJobRegistry.markFailed).not.toHaveBeenCalled();
  });

  it('markiert den Registry-Eintrag bei rejectetem Drain als failed, mit derselben drainId', async () => {
    const drainJobRegistry = makeJobRegistry();
    const projectDrain = {
      drainProject: jest.fn(async () => {
        throw new Error('drain kaputt');
      }),
    };
    const { scheduler } = makeScheduler({
      projectDrain,
      drainJobRegistry,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await expect(scheduler.tick()).resolves.toBeTruthy();
    const [drainId] = drainJobRegistry.register.mock.calls[0];
    await flush();

    expect(drainJobRegistry.markFailed).toHaveBeenCalledTimes(1);
    const [failedDrainId] = drainJobRegistry.markFailed.mock.calls[0];
    expect(failedDrainId).toBe(drainId);
    expect(drainJobRegistry.markDone).not.toHaveBeenCalled();
  });

  it('#activeDrains bleibt von der Registrierung unberührt (rein additive Erfassung)', async () => {
    const drainJobRegistry = makeJobRegistry();
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      drainJobRegistry,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await scheduler.tick();
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual(['/workspace/proj-a']);

    projectDrain.resolve('/workspace/proj-a', { stopped: true, reason: 'no-drain-target', flowRuns: 1 });
    await flush();
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual([]);
  });

  it('ein werfender register()/markDone() crasht den Scheduler NICHT (best-effort)', async () => {
    const drainJobRegistry = {
      register: jest.fn(() => {
        throw new Error('registry kaputt');
      }),
      markDone: jest.fn(() => {
        throw new Error('registry kaputt');
      }),
      markFailed: jest.fn(() => {
        throw new Error('registry kaputt');
      }),
    };
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      drainJobRegistry,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await expect(scheduler.tick()).resolves.toBeTruthy();
    projectDrain.resolve('/workspace/proj-a', { stopped: true, reason: 'no-drain-target', flowRuns: 1 });
    await expect(flush()).resolves.not.toThrow();

    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual([]);
  });

  it('ohne Projekt-Slug wird NICHT registriert (kein leerer/ungültiger Slug in der Persistenz)', async () => {
    const drainJobRegistry = makeJobRegistry();
    const projectDrain = makeControllableProjectDrain();
    // Fixture-Projekt ohne project_slug/slug (defensiv — s. #startDrain-Aufrufer).
    const index = [{ repo_path: '/workspace/no-slug-proj', error: undefined }];
    const { scheduler } = makeScheduler({
      projectDrain,
      drainJobRegistry,
      index,
      settings: makeSettings({ maxParallel: 1, projects: 'all' }),
    });

    await scheduler.tick();

    expect(drainJobRegistry.register).not.toHaveBeenCalled();

    projectDrain.resolve('/workspace/no-slug-proj', { stopped: true, reason: 'no-drain-target', flowRuns: 0 });
    await flush();
  });

  it('ohne injizierten drainJobRegistry läuft der Scheduler unverändert (No-op, kein Crash)', async () => {
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      settings: makeSettings({ maxParallel: 1, projects: ['proj-a'] }),
    });

    await expect(scheduler.tick()).resolves.toBeTruthy();
    projectDrain.resolve('/workspace/proj-a', { stopped: true, reason: 'no-drain-target', flowRuns: 1 });
    await expect(flush()).resolves.not.toThrow();
    expect(scheduler.getStatus().activeDrainProjectPaths).toEqual([]);
  });

  it('zwei parallele Nacht-Drains bekommen je EINE eigene, unterschiedliche drainId', async () => {
    const drainJobRegistry = makeJobRegistry();
    const projectDrain = makeControllableProjectDrain();
    const { scheduler } = makeScheduler({
      projectDrain,
      drainJobRegistry,
      settings: makeSettings({ maxParallel: 2, projects: ['proj-a', 'proj-b'] }),
    });

    await scheduler.tick();

    expect(drainJobRegistry.register).toHaveBeenCalledTimes(2);
    const [drainIdA] = drainJobRegistry.register.mock.calls[0];
    const [drainIdB] = drainJobRegistry.register.mock.calls[1];
    expect(drainIdA).not.toBe(drainIdB);

    projectDrain.resolve('/workspace/proj-a', { stopped: true, reason: 'no-drain-target', flowRuns: 0 });
    projectDrain.resolve('/workspace/proj-b', { stopped: true, reason: 'no-drain-target', flowRuns: 0 });
    await flush();
  });
});
