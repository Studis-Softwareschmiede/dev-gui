/**
 * nightwatch-lock-contention.integration.test.js — echte-Naht-Regressionstest
 * für den live-verifizierten CRITICAL-Bug (S-195 Review-Iteration 2, siehe
 * `.claude/lessons/coder.md` 2026-07-01, Eintrag "Scheduler mit maxParallel
 * über mehrere Projekte: mock-only ProjectDrain-Tests verfehlen den globalen
 * CommandService/JobLock-Flaschenhals").
 *
 * Bug (vor dem Fix): `NightWatchScheduler` startet bis zu `maxParallel`
 * parallele `ProjectDrain.drainProject()`-Läufe für VERSCHIEDENE Projekte,
 * aber `CommandService.tryRun()` serialisiert weiterhin über einen einzigen
 * PROZESSWEITEN `JobLock` (nicht den projektweisen `ProjectJobLock`, S-190).
 * Verliert ein Projekt das Rennen um den globalen Lock, bekommt es
 * wiederholt `{ok:false, reason:'locked'}` zurück — `ProjectDrain` wertete
 * das früher fälschlich als "kein Fortschritt" und eskalierte die legitime,
 * VÖLLIG UNVERÄNDERTE ready-Story dieses Projekts nach `escalationAttempts`
 * Läufen über `BoardWriter.setBlocked` auf `Blocked` — reine
 * Lock-Contention, keine echte Blockade (Board-Datenkorruption im
 * Standard-Nachtbetrieb, Default `maxParallel=3`).
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC9  — der Nachtwächter draint mehrere Projekte parallel (`maxParallel:2`).
 *   AC11 — bereits laufende Drains werden nicht abgebrochen, laufen zu Ende
 *          (hier: über mehrere aufeinanderfolgende Ticks hinweg vollständig
 *          abgearbeitet, kein Fehl-Blocked unterwegs).
 *   Regressionsschutz (kein eigener AC, Review-Iteration-2-Fund): ein
 *   `{ok:false, reason:'locked'}`-Ergebnis von `CommandService.tryRun()`
 *   darf NIEMALS `BoardWriter.setBlocked` für eine gesunde, unveränderte
 *   Drain-Ziel-Story auslösen — unabhängig von `escalationAttempts`.
 *
 * Strategy — ECHTE Naht, NICHT gemockt (genau die Naht, die die bisherige
 * `NightWatchScheduler.test.js`-Suite mit vollständig gemocktem
 * `ProjectDrain` verfehlt hat):
 *   - Echtes `CommandService` (src/CommandService.js) + echter, dedizierter
 *     `JobLock` (eigene Instanz, nicht der Prozess-Singleton — Test-Isolation).
 *   - Echtes `ProjectDrain` (src/ProjectDrain.js) + echtes `ProjectJobLock`.
 *   - Echter `BoardWriter` + echte `BoardAggregator` gegen ein temporäres
 *     `BOARD_ROOTS`-Verzeichnis (reale Dateien auf Disk, kein In-Memory-Fake).
 *   - Echter `NightWatchScheduler` (Ticks werden manuell ausgelöst, kein
 *     `setTimeout`-Ketten-Start nötig).
 *   - Einzige Fakes: die PTY selbst (kein echter node-pty-Prozess) — die
 *     Fake-PTY simuliert einen abgeschlossenen `/flow`-Lauf, indem sie beim
 *     `write()` synchron die Story-Datei DES JEWEILIGEN Projekts real auf
 *     Platte auf `Done` patcht (reales Board-Dateisystem, kein State-Mock).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';

import { CommandService } from '../src/CommandService.js';
import { JobLock } from '../src/JobLock.js';
import { ProjectDrain } from '../src/ProjectDrain.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';
import { BoardWriter } from '../src/BoardWriter.js';
import { BoardAggregator } from '../src/BoardAggregator.js';
import { NightWatchScheduler } from '../src/NightWatchScheduler.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake PTY (kein echter node-pty-Prozess) — nur write()/on()/off(), wie CommandService sie braucht. */
class FakePty {
  #listeners = new Map();

  constructor(onWrite) {
    this.onWrite = onWrite;
  }

  write(data) {
    this.onWrite(data);
  }

  on(event, cb) {
    this.#listeners.set(event, cb);
  }

  off(event, cb) {
    if (this.#listeners.get(event) === cb) this.#listeners.delete(event);
  }
}

/** Fake per-Projekt-Session-Registry — eine FakePty je projectPath (Muster: PtySessionRegistry-Interface). */
class FakeSessionRegistry {
  #ptys = new Map();

  constructor(onWrite) {
    this.onWrite = onWrite;
  }

  getOrCreate(projectPath) {
    const key = projectPath ?? '__global__';
    if (!this.#ptys.has(key)) {
      this.#ptys.set(key, new FakePty((data) => this.onWrite(projectPath, data)));
    }
    return this.#ptys.get(key);
  }

  hasSession(projectPath) {
    return this.#ptys.has(projectPath ?? '__global__');
  }
}

/** Simuliert einen abgeschlossenen /flow-Lauf: patcht die Story-Datei synchron auf Done. */
function markStoryDoneSync(storyFilePath) {
  const raw = readFileSync(storyFilePath, 'utf8');
  writeFileSync(storyFilePath, raw.replace('status: To Do', 'status: Done'), 'utf8');
}

function isStoryDone(storyFilePath) {
  return readFileSync(storyFilePath, 'utf8').includes('status: Done');
}

const SPEC_MD = ['---', 'status: active', '---', '', '# Dummy Spec', '', 'AC1 — dummy acceptance criterion.', ''].join(
  '\n',
);

async function makeProjectFixture(boardRootsDir, slug) {
  const repoPath = join(boardRootsDir, slug);
  const storiesDir = join(repoPath, 'board', 'stories');
  const featuresDir = join(repoPath, 'board', 'features');
  const specsDir = join(repoPath, 'docs', 'specs');
  await mkdir(storiesDir, { recursive: true });
  await mkdir(featuresDir, { recursive: true });
  await mkdir(specsDir, { recursive: true });

  await writeFile(join(repoPath, 'board', 'board.yaml'), `project_slug: ${slug}\nschema_version: 1\n`, 'utf8');
  await writeFile(join(featuresDir, 'F-1.yaml'), 'id: F-1\ntitle: Feature 1\nstatus: To Do\npriority: P1\n', 'utf8');
  await writeFile(join(specsDir, 'dummy.md'), SPEC_MD, 'utf8');

  const storyFilePath = join(storiesDir, 'S-1-beispiel.yaml');
  const storyYaml = [
    'id: S-1',
    'parent: F-1',
    "title: 'Beispiel-Story'",
    'status: To Do',
    'priority: P1',
    'spec: docs/specs/dummy.md',
    'implements: [AC1]',
    'depends: []',
    'blocked_reason: null',
    "updated_at: '2026-06-30T00:00:00Z'",
    '',
  ].join('\n');
  await writeFile(storyFilePath, storyYaml, 'utf8');

  return { repoPath, storyFilePath };
}

describe(
  'NightWatchScheduler + ProjectDrain + CommandService (real seam) — Lock-Contention-Regression ' +
    '(S-195 Review-Iteration 2, live verifiziert critical)',
  () => {
    let boardRootsDir;

    beforeEach(async () => {
      boardRootsDir = await mkdtemp(join(tmpdir(), 'nightwatch-lock-contention-'));
    });

    afterEach(async () => {
      await rm(boardRootsDir, { recursive: true, force: true });
    });

    it(
      'does NOT falsely Block either of two projects\' healthy ready stories due to global-lock ' +
        'contention, and both are drained (Done) over consecutive ticks',
      async () => {
        const projA = await makeProjectFixture(boardRootsDir, 'proj-a');
        const projB = await makeProjectFixture(boardRootsDir, 'proj-b');
        const storyFileByProject = new Map([
          [projA.repoPath, projA.storyFilePath],
          [projB.repoPath, projB.storyFilePath],
        ]);

        // Echter globaler JobLock (eigene Instanz — Test-Isolation, kein Prozess-Singleton).
        const globalLock = new JobLock();
        const sessionRegistry = new FakeSessionRegistry((projectPath) => {
          const storyFile = storyFileByProject.get(projectPath);
          if (storyFile) markStoryDoneSync(storyFile);
        });
        // Echtes CommandService — dieselbe Serialisierungs-Naht wie in Produktion
        // (Step 3 "Concurrency lock" in src/CommandService.js).
        const commandService = new CommandService({
          sessionRegistry,
          auditStore: { record: () => {} },
          lock: globalLock,
          idleMs: 20, // kurz, damit der Test nicht real 8s wartet
        });

        const boardAggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
        const boardWriter = new BoardWriter({ boardRootsEnv: boardRootsDir });

        // Spy um boardWriter.setBlocked, ohne das echte Schreiben zu verhindern —
        // die zentrale Assertion dieses Tests ist: dieser Spy wird NIE aufgerufen.
        const setBlockedCalls = [];
        const realSetBlocked = boardWriter.setBlocked.bind(boardWriter);
        boardWriter.setBlocked = async (args) => {
          setBlockedCalls.push(args);
          return realSetBlocked(args);
        };

        const projectLock = new ProjectJobLock();
        const projectDrain = new ProjectDrain({
          boardAggregator,
          commandService,
          boardWriter,
          lock: projectLock,
          escalationAttempts: 2, // niedrig gewählt — ohne den Fix würde bereits das eskalieren
          pollIntervalMs: 15,
          staleInProgressHours: 4,
        });

        // Spy um drainProject, um die tatsächlich aufgetretenen `reason`-Werte zu
        // beobachten (Beleg, dass die Contention im Test wirklich auftritt).
        const drainResults = [];
        const realDrainProject = projectDrain.drainProject.bind(projectDrain);
        projectDrain.drainProject = async (path, opts) => {
          const result = await realDrainProject(path, opts);
          drainResults.push({ path, ...result });
          return result;
        };

        const scheduler = new NightWatchScheduler({
          readSettings: async () => ({
            enabled: true,
            window: { start: '00:00', end: '23:59', timezone: 'UTC' },
            intervalMinutes: 15,
            maxParallel: 2,
            projects: 'all',
          }),
          boardAggregator,
          projectDrain,
          now: () => new Date('2026-06-30T12:00:00.000Z').getTime(),
        });

        // Mehrere aufeinanderfolgende Ticks (wie der reale setTimeout-Poll, hier
        // manuell getriggert) — mit kurzer Pause dazwischen, damit die
        // fire-and-forget-Drains jeder Runde vor dem nächsten Tick abschließen
        // können.
        for (let i = 0; i < 8; i += 1) {
          await scheduler.tick();
          await sleep(150);
          if (isStoryDone(projA.storyFilePath) && isStoryDone(projB.storyFilePath)) break;
        }
        await sleep(150); // letzte in-flight Drains sicher settlen lassen

        // ── Zentrale Regressions-Assertion ────────────────────────────────────
        // Die Board-Datenkorruption aus der Review-Iteration-2: KEINE der
        // beiden gesunden, unveränderten ready-Stories darf jemals über
        // "kein Fortschritt" auf Blocked gesetzt worden sein.
        expect(setBlockedCalls).toEqual([]);

        // Beleg, dass die Lock-Contention im Testlauf tatsächlich auftrat
        // (sonst wäre der Test kein echter Beweis für den Fix).
        expect(drainResults.some((r) => r.reason === 'command-channel-busy')).toBe(true);

        // Kein einziger drainProject()-Aufruf hat je eskaliert.
        expect(drainResults.every((r) => r.escalated.length === 0)).toBe(true);

        // Beide Projekte wurden über die aufeinanderfolgenden Ticks abgearbeitet
        // (Fortschritt fand trotz Lock-Contention statt — kein Deadlock, kein
        // dauerhaftes Verhungern eines Projekts).
        expect(isStoryDone(projA.storyFilePath)).toBe(true);
        expect(isStoryDone(projB.storyFilePath)).toBe(true);

        // Beide Locks sind am Ende wieder frei (kein Dauer-Lock).
        expect(projectLock.isHeld(projA.repoPath)).toBe(false);
        expect(projectLock.isHeld(projB.repoPath)).toBe(false);
      },
      15000,
    );
  },
);
