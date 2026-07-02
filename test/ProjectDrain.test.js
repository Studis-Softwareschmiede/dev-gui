/**
 * ProjectDrain.test.js — Unit-/Integrationstests für die ProjectDrain-Engine
 * (docs/specs/taktgeber-nachtwaechter.md, docs/specs/headless-parallel-drain.md,
 * docs/specs/headless-manual-drain.md, docs/specs/drain-completion-report.md).
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC1 — drainProject() stößt /agent-flow:flow wiederholt an, solange mind.
 *          eine Drain-Ziel-Story existiert (ready To Do ODER verwaiste
 *          In Progress, älter als staleInProgressHours); Done/Blocked/Idee/
 *          nicht-ready To Do sind nie Ziel.
 *   AC2 — Abbruch-/Konvergenz-Regel (zustandsbasiert): stoppt nur wenn KEIN
 *          Drain-Ziel mehr existiert UND keine To Do-Story durch
 *          Vorgänger-Fertigstellung ready werden kann; depends-only-wartende
 *          Stories werden automatisch mitgezogen; ein dauerhaft feststeckender
 *          Vorgänger (Blocked/Idee/fehlt) verhindert ewiges Weiterlaufen
 *          (Konvergenz-Garantie). Zusätzlich (Iteration 3, Regressionsschutz
 *          für den live-verifizierten Endlosschleifen-Bug): `computeAliveStoryIds`
 *          wird direkt getestet (mehrstufige tote Ketten ≥2 Hops, echter
 *          Zyklus, Selbst-Depend, fehlende depends-ID — alle NICHT lebendig;
 *          Diamant mit Done-Wurzel als Positiv-Kontrolle — alle lebendig),
 *          ebenso `couldBecomeReadyViaDepends` für dieselben transitiven
 *          Fälle, plus ein `drainProject()`-Integrationstest, der eine tote
 *          Kette/einen Zyklus schnell mit `reason:'no-drain-target'` und
 *          freigegebenem Lock terminiert (statt zu hängen). Der unabhängige
 *          Sicherheitsgürtel (`safetyMaxNoProgressRounds`/
 *          `DEFAULT_SAFETY_MAX_NO_PROGRESS_ROUNDS`/`reason:'safety-stop-no-
 *          progress'`, Defense-in-Depth-Backstop) wird eigenständig erzwungen
 *          (boardWriter.setBlocked wirft → Eskalation kann nie greifen →
 *          Backstop bricht nach `safetyMaxNoProgressRounds` Runden ab, Lock
 *          freigegeben, kein Hang).
 *   AC3 — Nicht-Drain-Ziele (Blocked, Idee, nicht-ready To Do, Done) werden
 *          nie als Ziel gewählt und außerhalb der Eskalation nie verändert.
 *   AC4 — Eskalation: nach escalationAttempts aufeinanderfolgenden
 *          fortschrittslosen Läufen wird die am längsten unbewegte
 *          Drain-Ziel-Story über BoardWriter.setBlocked auf Blocked gesetzt
 *          (blocked_reason "Taktgeber: Nx kein Fortschritt"), Zähler wird
 *          zurückgesetzt; nicht-ready To Do/Idee werden nie eskaliert.
 *   AC5 — Fortschritt = jede Status-/Ready-Änderung zwischen zwei
 *          Board-Scans (Snapshot-Diff, Muster NotificationWatcher); bei
 *          Fortschritt wird der kein-Fortschritt-Zähler zurückgesetzt.
 *   AC6/AC7 (Wiederverwendung S-190) — pro Projekt höchstens ein aktiver
 *          Drain (ProjectJobLock + isProjectBusy); kein Doppel-Trigger; Lock
 *          wird IMMER freigegeben (try/finally), auch bei Scan-/Flow-Fehlern.
 *   AC18 — jeder Drain-Start und jede Eskalation-auf-Blocked erzeugt genau
 *          einen AuditEntry (AuditStore.record); "jeder /flow-Anstoß" wird
 *          bereits durch CommandService selbst auditiert (nicht hier
 *          dupliziert — siehe CommandService.test.js AC1).
 *   AC9/AC11 (S-195 Review-Iteration 2, Regressionsschutz für den
 *          live-verifizierten Critical-Bug "Fehl-Blocked durch globale
 *          Lock-Contention") — wenn CommandService.tryRun() {ok:false,
 *          reason:'locked'|'busy'} liefert (der PROZESSWEITE CommandService-
 *          JobLock wird von einem ANDEREN Projekt gehalten, kein /flow-Lauf
 *          fand statt), stoppt drainProject() sofort mit reason
 *          'command-channel-busy' — KEIN Eskalations-Zähler-Increment, KEIN
 *          boardWriter.setBlocked, auch nicht über viele aufeinanderfolgende
 *          scheduler-artige drainProject()-Aufrufe hinweg. Der echte-Naht-
 *          Regressionstest (Scheduler+Drain+echter CommandService+echter
 *          globaler JobLock+echtes ProjectJobLock+BoardWriter gegen ein
 *          tmp-Board, ≥2 Projekte, maxParallel:2) lebt separat in
 *          test/nightwatch-lock-contention.integration.test.js (siehe dort).
 *
 * Covers (headless-parallel-drain):
 *   AC5 — der Ausführungs-Schritt in #runLoop läuft über das injizierte
 *          FlowRunner-Interface statt hart über CommandService; ein
 *          injizierter Fake-FlowRunner (custom startRun/awaitCompletion)
 *          UND ein injizierter HeadlessFlowRunnerAdapter (echte Klasse aus
 *          src/FlowRunner.js, gegen einen Fake-Headless-Runner) draint
 *          korrekt — Ziel-Auswahl/Konvergenz/Eskalation/Snapshot-Diff
 *          funktionieren identisch mit beiden Adaptern (siehe describe-Block
 *          "FlowRunner-Injection" unten). Die adapter-eigenen Unit-Tests
 *          (InteractiveFlowRunner/HeadlessFlowRunnerAdapter isoliert,
 *          AC4/AC13) leben in test/FlowRunner.test.js.
 *   AC6 — ohne injizierten flowRunner baut der Konstruktor per Default einen
 *          InteractiveFlowRunner um `commandService` — ALLE bestehenden
 *          Tests oben (die nur `commandService` übergeben, kein `flowRunner`)
 *          belegen dies bereits: unverändertes Verhalten ist der Beweis für
 *          "bit-identisch zu heute" (kein separater Regressionstest nötig,
 *          identische Assertions wie vor S-212).
 *
 * Covers (headless-manual-drain):
 *   AC3 — drainProject({ args }) reicht die per-Drain-argv (z.B. ['--cost',
 *          <mode>]) an JEDEN `flowRunner.startRun({ args })`-Aufruf durch —
 *          gilt für ALLE Flow-Runden desselben Drains (siehe describe-Block
 *          "FlowRunner-Injection", Test "passes per-drain args"). Die
 *          Cost-Mode-Validierung + das Enum-Mapping (balanced → kein Flag)
 *          leben auf HTTP-Ebene in test/projectDrainRouter.test.js (AC3); die
 *          reale headless-Verdrahtung (dedizierte Instanz + eigener Lock, AC1/AC2)
 *          in server.js.
 *
 * Covers (board-status-verworfen):
 *   AC5 — Regressions-Invariante: eine Story mit status 'Verworfen' ist nie
 *          "lebendig" (computeAliveStoryIds) und nie ein Drain-Ziel
 *          (computeDrainState) — wird wie Blocked/Idee übersprungen. Kein
 *          Code-Delta in src/ProjectDrain.js für diese Story; der Test belegt
 *          nur die bereits bestehende `status !== 'To Do' && status !== 'In
 *          Progress'`-Invariante bleibt für den neuen Statuswert gültig.
 *
 * Covers (drain-completion-report):
 *   AC1 — drainProject() liefert zusätzlich `completed: [{id,title}]` (Stories,
 *          die während des Drains von To Do/In Progress nach Done übergingen)
 *          und `blocked: [{id,title}]` (Stories, die nach Blocked übergingen —
 *          Obermenge von `escalated`), abgeleitet aus Anfangs-/End-Snapshot
 *          (`computeCompletedBlocked`, pure-helper-Tests + Integration in JEDEM
 *          drainProject()-toEqual oben). Die bestehenden Felder (stopped,
 *          reason, flowRuns, escalated) bleiben unverändert — die aktualisierten
 *          exakten toEqual-Assertions oben belegen additiv completed/blocked
 *          neben den unveränderten Feldern (kein Regress). Titel = Board-Titel,
 *          kein Pfad/Secret.
 *   AC2 — Randfälle (leere completed/blocked, kein Crash): flowRuns==0
 *          (sofortige Konvergenz), reason=='scan-failed', reason==
 *          'command-channel-busy', reason=='already-busy', Projekt ohne Board;
 *          eine Story To Do→In Progress (nicht Done) erscheint in KEINER Liste;
 *          fehlender/nicht-String-Titel → title:''. Siehe describe-Block
 *          "computeCompletedBlocked (drain-completion-report AC1/AC2)" +
 *          "drainProject — completed/blocked Snapshot-Diff (AC1/AC2)".
 *
 * Strategy:
 *   - Pure Helper-Funktionen (flattenProjectStories, isStaleInProgress,
 *     computeAliveStoryIds, couldBecomeReadyViaDepends, computeDrainState,
 *     snapshotsEqual, pickLongestUnmovedTarget, computeCompletedBlocked)
 *     werden direkt mit Fixture-Objekten getestet (kein IO, volle
 *     Verzweigungsabdeckung inkl. Konvergenz-Sackgassen: mehrstufige tote
 *     Ketten, Zyklen, Selbst-Depend; sowie der Anfangs-/End-Snapshot-Diff für
 *     completed/blocked, drain-completion-report AC1/AC2).
 *   - ProjectDrain selbst wird gegen schlanke, skriptbare Test-Doubles
 *     getestet: ein mutierbarer In-Memory-"Board"-Zustand (Stories als
 *     Plain-Objects, Struktur wie BoardAggregator.ProjectEntry), ein
 *     FakeCommandService dessen tryRun() pro Aufruf einen injizierbaren
 *     Callback ausführt (simuliert die Wirkung eines /flow-Laufs auf den
 *     Board-Zustand), ein FakeBoardWriter der setBlocked() gegen denselben
 *     Board-Zustand ausführt, und ein echtes ProjectJobLock (kein Mock —
 *     Lock-Freigabe-Disziplin ist nur gegen den echten Lock-Zustand
 *     aussagekräftig prüfbar).
 */

import { describe, it, expect } from '@jest/globals';
import {
  ProjectDrain,
  FLOW_COMMAND,
  DEFAULT_STALE_IN_PROGRESS_HOURS,
  DEFAULT_ESCALATION_ATTEMPTS,
  DEFAULT_SAFETY_MAX_NO_PROGRESS_ROUNDS,
  flattenProjectStories,
  isStaleInProgress,
  computeAliveStoryIds,
  couldBecomeReadyViaDepends,
  computeDrainState,
  snapshotsEqual,
  pickLongestUnmovedTarget,
  computeCompletedBlocked,
} from '../src/ProjectDrain.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';
import { HeadlessFlowRunnerAdapter } from '../src/FlowRunner.js';

const PROJECT_PATH = '/workspace/my-project';
const PROJECT_SLUG = 'my-project';

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeStory(overrides) {
  return {
    id: overrides.id,
    parent: 'F-001',
    title: overrides.id,
    status: overrides.status,
    priority: 'P1',
    labels: [],
    spec: 'docs/specs/x.md',
    implements: ['AC1'],
    depends: overrides.depends ?? [],
    blocked_reason: overrides.blocked_reason ?? null,
    dispo_est: null,
    dispo_act: null,
    updated_at: overrides.updated_at ?? null,
    done_at: null,
    branch: null,
    pr: null,
    ready: overrides.ready ?? false,
    ready_reason: overrides.ready_reason ?? null,
  };
}

function makeProject(slug, repoPath, stories) {
  return {
    slug,
    repo_path: repoPath,
    project_slug: slug,
    schema_version: 1,
    features: [{ id: 'F-001', title: 'F-001', status: null, priority: null, progress: null, stories }],
  };
}

function findStory(project, id) {
  for (const feature of project.features) {
    const s = feature.stories.find((st) => st.id === id);
    if (s) return s;
  }
  return null;
}

/** storyId → story Map (Eingabe-Shape von couldBecomeReadyViaDepends/computeAliveStoryIds). */
function byId(...stories) {
  return new Map(stories.map((s) => [s.id, s]));
}

/** Mutable shared board state + a BoardAggregator-shaped stub over it. */
function makeBoard(stories) {
  const project = makeProject(PROJECT_SLUG, PROJECT_PATH, stories);
  const state = { projects: [project] };
  const boardAggregator = {
    scanCount: 0,
    async scan() {
      this.scanCount += 1;
    },
    async getIndex() {
      return state.projects;
    },
  };
  return { state, project, boardAggregator };
}

/**
 * FakeCommandService — tryRun() invokes an injectable per-call callback
 * (simulates a /flow run's effect on the board) and returns ok:true unless
 * the callback explicitly returns a rejection. getStatus() reports 'done'
 * immediately after a successful tryRun (fast, deterministic tests — the
 * actual idle-completion polling loop is covered separately below).
 */
class FakeCommandService {
  constructor(onRun) {
    this.onRun = onRun;
    this.calls = [];
    this._status = { commandId: null, status: null };
  }

  tryRun(args) {
    this.calls.push(args);
    const result = this.onRun ? this.onRun(this.calls.length, args) : undefined;
    if (result && result.ok === false) {
      return result;
    }
    this._status = { commandId: `cmd-${this.calls.length}`, status: 'done' };
    return { ok: true, commandId: this._status.commandId, status: 'running' };
  }

  getStatus() {
    return this._status;
  }
}

/** FakeBoardWriter — setBlocked() mutates the shared board state directly. */
class FakeBoardWriter {
  constructor(state, { throwOnSet = false } = {}) {
    this.state = state;
    this.throwOnSet = throwOnSet;
    this.calls = [];
  }

  async setBlocked({ projectSlug, storyId, blockedReason }) {
    this.calls.push({ projectSlug, storyId, blockedReason });
    if (this.throwOnSet) throw new Error('simulated write failure');
    for (const project of this.state.projects) {
      if (project.slug !== projectSlug) continue;
      const story = findStory(project, storyId);
      if (story) {
        story.status = 'Blocked';
        story.blocked_reason = blockedReason;
        story.ready = false;
        story.ready_reason = null;
      }
    }
  }
}

class FakeAuditStore {
  constructor() {
    this.entries = [];
  }

  record({ identity, command }) {
    const entry = { identity, command };
    this.entries.push(entry);
    return entry;
  }
}

const NOW_MS = Date.parse('2026-06-30T12:00:00Z');

// ── Pure helpers ───────────────────────────────────────────────────────────────

describe('flattenProjectStories', () => {
  it('flattens all stories across all features (incl. _orphaned pseudo-feature)', () => {
    const s1 = makeStory({ id: 'S-1', status: 'To Do' });
    const s2 = makeStory({ id: 'S-2', status: 'Done' });
    const project = {
      features: [
        { id: 'F-001', stories: [s1] },
        { id: '_orphaned', stories: [s2], _orphaned: true },
      ],
    };
    expect(flattenProjectStories(project)).toEqual([s1, s2]);
  });

  it('returns [] for null project or missing features', () => {
    expect(flattenProjectStories(null)).toEqual([]);
    expect(flattenProjectStories({})).toEqual([]);
  });
});

describe('isStaleInProgress (AC1 Drain-Ziel (b))', () => {
  it('is true when In Progress and updated_at is older than staleInProgressHours', () => {
    const story = makeStory({ id: 'S-1', status: 'In Progress', updated_at: '2026-06-30T07:00:00Z' }); // 5h before NOW_MS
    expect(isStaleInProgress(story, NOW_MS, 4)).toBe(true);
  });

  it('is false when In Progress but within staleInProgressHours (fresh, actively worked)', () => {
    const story = makeStory({ id: 'S-1', status: 'In Progress', updated_at: '2026-06-30T11:00:00Z' }); // 1h before
    expect(isStaleInProgress(story, NOW_MS, 4)).toBe(false);
  });

  it('is false exactly at the threshold (strict > , not >=)', () => {
    const story = makeStory({ id: 'S-1', status: 'In Progress', updated_at: '2026-06-30T08:00:00Z' }); // exactly 4h
    expect(isStaleInProgress(story, NOW_MS, 4)).toBe(false);
  });

  it('is false for non-In-Progress status regardless of age', () => {
    const story = makeStory({ id: 'S-1', status: 'To Do', updated_at: '2020-01-01T00:00:00Z' });
    expect(isStaleInProgress(story, NOW_MS, 4)).toBe(false);
  });

  it('is false (defensive) when updated_at is missing', () => {
    const story = makeStory({ id: 'S-1', status: 'In Progress', updated_at: null });
    expect(isStaleInProgress(story, NOW_MS, 4)).toBe(false);
  });

  it('is false (defensive) when updated_at is unparsable', () => {
    const story = makeStory({ id: 'S-1', status: 'In Progress', updated_at: 'not-a-date' });
    expect(isStaleInProgress(story, NOW_MS, 4)).toBe(false);
  });
});

describe('couldBecomeReadyViaDepends (AC2 Konvergenz-Regel)', () => {
  it('is true when the only unmet depend is still alive (To Do)', () => {
    const dep = makeStory({ id: 'S-1', status: 'To Do', ready: false });
    const story = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready: false,
      ready_reason: 'abhängige Story nicht Done: S-1',
      depends: ['S-1'],
    });
    expect(couldBecomeReadyViaDepends(story, byId(dep, story))).toBe(true);
  });

  it('is true when the only unmet depend is still alive (In Progress)', () => {
    const dep = makeStory({ id: 'S-1', status: 'In Progress' });
    const story = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready_reason: 'abhängige Story nicht Done: S-1',
      depends: ['S-1'],
    });
    expect(couldBecomeReadyViaDepends(story, byId(dep, story))).toBe(true);
  });

  it('is false when the unmet depend is Blocked (dead end — convergence guarantee)', () => {
    const dep = makeStory({ id: 'S-1', status: 'Blocked' });
    const story = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready_reason: 'abhängige Story nicht Done: S-1',
      depends: ['S-1'],
    });
    expect(couldBecomeReadyViaDepends(story, byId(dep, story))).toBe(false);
  });

  it('is false when the unmet depend is Idee (dead end)', () => {
    const dep = makeStory({ id: 'S-1', status: 'Idee' });
    const story = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready_reason: 'abhängige Story nicht Done: S-1',
      depends: ['S-1'],
    });
    expect(couldBecomeReadyViaDepends(story, byId(dep, story))).toBe(false);
  });

  // board-status-verworfen AC5 (S-242): 'Verworfen' ist wie Blocked/Idee ein
  // dauerhafter Sackgassen-Status — kein neuer Code, nur Regressions-Beleg.
  it('is false when the unmet depend is Verworfen (dead end, board-status-verworfen AC5)', () => {
    const dep = makeStory({ id: 'S-1', status: 'Verworfen' });
    const story = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready_reason: 'abhängige Story nicht Done: S-1',
      depends: ['S-1'],
    });
    expect(couldBecomeReadyViaDepends(story, byId(dep, story))).toBe(false);
  });

  it('is false when the unmet depend does not exist (dead end)', () => {
    const story = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready_reason: 'abhängige Story nicht Done: S-1',
      depends: ['S-1'],
    });
    expect(couldBecomeReadyViaDepends(story, byId(story))).toBe(false);
  });

  it('is false when ready is already true', () => {
    const story = makeStory({ id: 'S-2', status: 'To Do', ready: true });
    expect(couldBecomeReadyViaDepends(story, byId(story))).toBe(false);
  });

  it('is false when blocked_reason is set', () => {
    const story = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready_reason: 'abhängige Story nicht Done: S-1',
      depends: ['S-1'],
      blocked_reason: 'manual hold',
    });
    expect(couldBecomeReadyViaDepends(story, byId(story))).toBe(false);
  });

  it('is false when ready_reason is for a non-depends reason (spec/implements)', () => {
    const story = makeStory({ id: 'S-2', status: 'To Do', ready_reason: 'spec nicht gesetzt' });
    expect(couldBecomeReadyViaDepends(story, byId(story))).toBe(false);
  });

  it('is true only when ALL unmet depends are alive (mixed Done + alive)', () => {
    const dep1 = makeStory({ id: 'S-1', status: 'Done' });
    const dep2 = makeStory({ id: 'S-0', status: 'To Do' });
    const story = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready_reason: 'abhängige Story nicht Done: S-0',
      depends: ['S-1', 'S-0'],
    });
    expect(couldBecomeReadyViaDepends(story, byId(dep1, dep2, story))).toBe(true);
  });

  it('is false when one of several unmet depends is a dead end (mixed alive + Blocked)', () => {
    const dep1 = makeStory({ id: 'S-1', status: 'To Do' });
    const dep2 = makeStory({ id: 'S-0', status: 'Blocked' });
    const story = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready_reason: 'abhängige Story nicht Done: S-0',
      depends: ['S-1', 'S-0'],
    });
    expect(couldBecomeReadyViaDepends(story, byId(dep1, dep2, story))).toBe(false);
  });
});

describe('computeAliveStoryIds / couldBecomeReadyViaDepends — transitive Sackgassen & Zyklen (S-192 Iteration 2/3, Regressionsschutz für den live-verifizierten Endlosschleifen-Bug)', () => {
  it('multi-hop dead chain (≥2 hops): Blocked ← To Do ← To Do — none become alive, neither waiter could become ready', () => {
    const sa = makeStory({ id: 'S-A', status: 'Blocked', blocked_reason: 'manual' });
    const sb = makeStory({
      id: 'S-B',
      status: 'To Do',
      ready: false,
      ready_reason: 'abhängige Story nicht Done: S-A',
      depends: ['S-A'],
    });
    const sc = makeStory({
      id: 'S-C',
      status: 'To Do',
      ready: false,
      ready_reason: 'abhängige Story nicht Done: S-B',
      depends: ['S-B'],
    });
    const storiesById = byId(sa, sb, sc);

    const alive = computeAliveStoryIds([sa, sb, sc], storiesById);

    expect(alive.has('S-A')).toBe(false);
    expect(alive.has('S-B')).toBe(false);
    expect(alive.has('S-C')).toBe(false);
    expect(couldBecomeReadyViaDepends(sb, storiesById)).toBe(false);
    expect(couldBecomeReadyViaDepends(sc, storiesById)).toBe(false);
  });

  it('genuine cycle S-1 ⇄ S-2 (both To Do, mutual depends) — neither becomes alive', () => {
    const s1 = makeStory({
      id: 'S-1',
      status: 'To Do',
      ready: false,
      ready_reason: 'abhängige Story nicht Done: S-2',
      depends: ['S-2'],
    });
    const s2 = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready: false,
      ready_reason: 'abhängige Story nicht Done: S-1',
      depends: ['S-1'],
    });
    const storiesById = byId(s1, s2);

    const alive = computeAliveStoryIds([s1, s2], storiesById);

    expect(alive.has('S-1')).toBe(false);
    expect(alive.has('S-2')).toBe(false);
    expect(couldBecomeReadyViaDepends(s1, storiesById)).toBe(false);
    expect(couldBecomeReadyViaDepends(s2, storiesById)).toBe(false);
  });

  it('self-depend S-1 → S-1 — never becomes alive', () => {
    const s1 = makeStory({
      id: 'S-1',
      status: 'To Do',
      ready: false,
      ready_reason: 'abhängige Story nicht Done: S-1',
      depends: ['S-1'],
    });
    const storiesById = byId(s1);

    const alive = computeAliveStoryIds([s1], storiesById);

    expect(alive.has('S-1')).toBe(false);
    expect(couldBecomeReadyViaDepends(s1, storiesById)).toBe(false);
  });

  it('missing depends-id (references a non-existent story) — treated as a dead end, never alive', () => {
    const s1 = makeStory({
      id: 'S-1',
      status: 'To Do',
      ready: false,
      ready_reason: 'abhängige Story nicht Done: S-ghost',
      depends: ['S-ghost'],
    });
    const storiesById = byId(s1); // 'S-ghost' intentionally absent

    const alive = computeAliveStoryIds([s1], storiesById);

    expect(alive.has('S-1')).toBe(false);
    expect(couldBecomeReadyViaDepends(s1, storiesById)).toBe(false);
  });

  it('positive control: diamond with a Done root (A=Done; B,C depend on A; D depends on B+C) — all alive, D could become ready', () => {
    const a = makeStory({ id: 'S-A', status: 'Done' });
    const b = makeStory({
      id: 'S-B',
      status: 'To Do',
      ready: false,
      ready_reason: 'abhängige Story nicht Done: S-A',
      depends: ['S-A'],
    });
    const c = makeStory({
      id: 'S-C',
      status: 'To Do',
      ready: false,
      ready_reason: 'abhängige Story nicht Done: S-A',
      depends: ['S-A'],
    });
    const d = makeStory({
      id: 'S-D',
      status: 'To Do',
      ready: false,
      ready_reason: 'abhängige Story nicht Done: S-B',
      depends: ['S-B', 'S-C'],
    });
    const storiesById = byId(a, b, c, d);

    const alive = computeAliveStoryIds([a, b, c, d], storiesById);

    expect(alive.has('S-A')).toBe(true);
    expect(alive.has('S-B')).toBe(true);
    expect(alive.has('S-C')).toBe(true);
    expect(alive.has('S-D')).toBe(true);
    // A Done predecessor counts as fulfilled, NOT dead — couldBecomeReadyViaDepends
    // must return true for D (both B and C are alive, neither is a dead end).
    expect(couldBecomeReadyViaDepends(d, storiesById)).toBe(true);
  });
});

describe('computeDrainState (AC1/AC2/AC3)', () => {
  it('selects ready To Do + stale In Progress as targets; excludes everything else', () => {
    const readyTodo = makeStory({ id: 'S-1', status: 'To Do', ready: true });
    const notReadyTodo = makeStory({ id: 'S-2', status: 'To Do', ready: false, ready_reason: 'spec nicht gesetzt' });
    const staleInProgress = makeStory({ id: 'S-3', status: 'In Progress', updated_at: '2026-06-30T00:00:00Z' });
    const freshInProgress = makeStory({ id: 'S-4', status: 'In Progress', updated_at: '2026-06-30T11:30:00Z' });
    const blocked = makeStory({ id: 'S-5', status: 'Blocked', blocked_reason: 'x' });
    const idea = makeStory({ id: 'S-6', status: 'Idee' });
    const done = makeStory({ id: 'S-7', status: 'Done' });
    const project = makeProject('p', '/p', [readyTodo, notReadyTodo, staleInProgress, freshInProgress, blocked, idea, done]);

    const { targets, couldBecomeReady, snapshot } = computeDrainState(project, NOW_MS, 4);

    expect(targets.map((s) => s.id).sort()).toEqual(['S-1', 'S-3']);
    expect(couldBecomeReady).toBe(false);
    expect(snapshot.size).toBe(7);
    expect(snapshot.get('S-1')).toEqual({ status: 'To Do', ready: true });
  });

  it('couldBecomeReady true when a non-ready To Do hangs solely on an alive predecessor', () => {
    const dep = makeStory({ id: 'S-1', status: 'In Progress', updated_at: '2026-06-30T11:30:00Z' }); // fresh, not a target
    const waiting = makeStory({
      id: 'S-2',
      status: 'To Do',
      ready_reason: 'abhängige Story nicht Done: S-1',
      depends: ['S-1'],
    });
    const project = makeProject('p', '/p', [dep, waiting]);
    const { targets, couldBecomeReady } = computeDrainState(project, NOW_MS, 4);
    expect(targets).toEqual([]);
    expect(couldBecomeReady).toBe(true);
  });

  it('returns empty targets + couldBecomeReady=false for a null project (board-scan failure)', () => {
    const { targets, couldBecomeReady, snapshot } = computeDrainState(null, NOW_MS, 4);
    expect(targets).toEqual([]);
    expect(couldBecomeReady).toBe(false);
    expect(snapshot.size).toBe(0);
  });

  // board-status-verworfen AC5 (S-242): Regressions-Invariante — eine
  // 'Verworfen'-Story ist nie ein Drain-Ziel, genau wie Blocked/Idee/Done.
  it('AC5 (board-status-verworfen): excludes a Verworfen story from targets, same as Blocked/Idee/Done', () => {
    const verworfen = makeStory({ id: 'S-8', status: 'Verworfen' });
    const readyTodo = makeStory({ id: 'S-1', status: 'To Do', ready: true });
    const project = makeProject('p', '/p', [verworfen, readyTodo]);

    const { targets } = computeDrainState(project, NOW_MS, 4);

    expect(targets.map((s) => s.id)).toEqual(['S-1']);
  });
});

describe('snapshotsEqual (AC5 Fortschritts-Erkennung)', () => {
  it('true for identical maps', () => {
    const a = new Map([['S-1', { status: 'To Do', ready: true }]]);
    const b = new Map([['S-1', { status: 'To Do', ready: true }]]);
    expect(snapshotsEqual(a, b)).toBe(true);
  });

  it('false when a status changed', () => {
    const a = new Map([['S-1', { status: 'To Do', ready: true }]]);
    const b = new Map([['S-1', { status: 'In Progress', ready: false }]]);
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it('false when ready flipped (same status)', () => {
    const a = new Map([['S-1', { status: 'To Do', ready: false }]]);
    const b = new Map([['S-1', { status: 'To Do', ready: true }]]);
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it('false when a story appeared', () => {
    const a = new Map([['S-1', { status: 'To Do', ready: true }]]);
    const b = new Map([
      ['S-1', { status: 'To Do', ready: true }],
      ['S-2', { status: 'To Do', ready: true }],
    ]);
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it('false when a story disappeared', () => {
    const a = new Map([
      ['S-1', { status: 'To Do', ready: true }],
      ['S-2', { status: 'To Do', ready: true }],
    ]);
    const b = new Map([['S-1', { status: 'To Do', ready: true }]]);
    expect(snapshotsEqual(a, b)).toBe(false);
  });
});

describe('pickLongestUnmovedTarget (AC4)', () => {
  it('picks the target with the smallest (oldest) lastChangeRound', () => {
    const s1 = makeStory({ id: 'S-1', status: 'To Do', ready: true });
    const s2 = makeStory({ id: 'S-2', status: 'To Do', ready: true });
    const lastChangeRound = new Map([
      ['S-1', 1],
      ['S-2', 3],
    ]);
    expect(pickLongestUnmovedTarget([s1, s2], lastChangeRound)).toBe(s1);
  });

  it('breaks ties deterministically by smallest id', () => {
    const s2 = makeStory({ id: 'S-2', status: 'To Do', ready: true });
    const s1 = makeStory({ id: 'S-1', status: 'To Do', ready: true });
    const lastChangeRound = new Map([
      ['S-2', 1],
      ['S-1', 1],
    ]);
    expect(pickLongestUnmovedTarget([s2, s1], lastChangeRound)).toBe(s1);
  });

  it('treats an untracked target as round 0 (oldest)', () => {
    const tracked = makeStory({ id: 'S-1', status: 'To Do', ready: true });
    const untracked = makeStory({ id: 'S-2', status: 'To Do', ready: true });
    const lastChangeRound = new Map([['S-1', 1]]);
    expect(pickLongestUnmovedTarget([tracked, untracked], lastChangeRound)).toBe(untracked);
  });

  it('returns null for an empty target list', () => {
    expect(pickLongestUnmovedTarget([], new Map())).toBeNull();
  });
});

// ── ProjectDrain — integration ─────────────────────────────────────────────────

describe('computeCompletedBlocked (drain-completion-report AC1/AC2)', () => {
  /** initialStatuses-Map-Helfer (storyId → Status VOR der ersten Runde). */
  function initial(entries) {
    return new Map(Object.entries(entries));
  }

  it('reports a To Do → Done transition in completed (id + Board-title), nothing in blocked', () => {
    const endProject = makeProject(PROJECT_SLUG, PROJECT_PATH, [
      { ...makeStory({ id: 'S-1', status: 'Done' }), title: 'Erste Story' },
    ]);
    const { completed, blocked } = computeCompletedBlocked(initial({ 'S-1': 'To Do' }), endProject);
    expect(completed).toEqual([{ id: 'S-1', title: 'Erste Story' }]);
    expect(blocked).toEqual([]);
  });

  it('reports an In Progress → Done transition in completed', () => {
    const endProject = makeProject(PROJECT_SLUG, PROJECT_PATH, [makeStory({ id: 'S-1', status: 'Done' })]);
    const { completed, blocked } = computeCompletedBlocked(initial({ 'S-1': 'In Progress' }), endProject);
    expect(completed).toEqual([{ id: 'S-1', title: 'S-1' }]);
    expect(blocked).toEqual([]);
  });

  it('reports a → Blocked transition in blocked (superset of escalated: /flow-set Blocked too)', () => {
    const endProject = makeProject(PROJECT_SLUG, PROJECT_PATH, [makeStory({ id: 'S-1', status: 'Blocked' })]);
    const { completed, blocked } = computeCompletedBlocked(initial({ 'S-1': 'To Do' }), endProject);
    expect(completed).toEqual([]);
    expect(blocked).toEqual([{ id: 'S-1', title: 'S-1' }]);
  });

  it('AC2: a To Do → In Progress story (not Done) appears in NEITHER list', () => {
    const endProject = makeProject(PROJECT_SLUG, PROJECT_PATH, [makeStory({ id: 'S-1', status: 'In Progress' })]);
    const { completed, blocked } = computeCompletedBlocked(initial({ 'S-1': 'To Do' }), endProject);
    expect(completed).toEqual([]);
    expect(blocked).toEqual([]);
  });

  it('does not report a story that was ALREADY Done/Blocked at the start (no transition)', () => {
    const endProject = makeProject(PROJECT_SLUG, PROJECT_PATH, [
      makeStory({ id: 'S-1', status: 'Done' }),
      makeStory({ id: 'S-2', status: 'Blocked' }),
    ]);
    const { completed, blocked } = computeCompletedBlocked(initial({ 'S-1': 'Done', 'S-2': 'Blocked' }), endProject);
    expect(completed).toEqual([]);
    expect(blocked).toEqual([]);
  });

  it('AC2: returns empty lists when the end project is null (scan failed / no board) — no crash', () => {
    const { completed, blocked } = computeCompletedBlocked(initial({ 'S-1': 'To Do' }), null);
    expect(completed).toEqual([]);
    expect(blocked).toEqual([]);
  });

  it('falls back to title:"" when the end story has a missing/non-string title (no crash)', () => {
    const s1 = makeStory({ id: 'S-1', status: 'Done' });
    delete s1.title;
    const s2 = makeStory({ id: 'S-2', status: 'Blocked' });
    s2.title = 42; // non-string
    const endProject = makeProject(PROJECT_SLUG, PROJECT_PATH, [s1, s2]);
    const { completed, blocked } = computeCompletedBlocked(initial({ 'S-1': 'To Do', 'S-2': 'To Do' }), endProject);
    expect(completed).toEqual([{ id: 'S-1', title: '' }]);
    expect(blocked).toEqual([{ id: 'S-2', title: '' }]);
  });

  it('ignores a story that did not exist in the initial snapshot (no observable transition)', () => {
    const endProject = makeProject(PROJECT_SLUG, PROJECT_PATH, [makeStory({ id: 'S-new', status: 'Done' })]);
    const { completed, blocked } = computeCompletedBlocked(initial({}), endProject);
    expect(completed).toEqual([]);
    expect(blocked).toEqual([]);
  });

  it('reports completed AND blocked together in one run (mixed board), preserving board order', () => {
    const endProject = makeProject(PROJECT_SLUG, PROJECT_PATH, [
      makeStory({ id: 'S-1', status: 'Done' }),
      makeStory({ id: 'S-2', status: 'Blocked' }),
      makeStory({ id: 'S-3', status: 'In Progress' }), // still working → neither
      makeStory({ id: 'S-4', status: 'Done' }),
    ]);
    const { completed, blocked } = computeCompletedBlocked(
      initial({ 'S-1': 'To Do', 'S-2': 'In Progress', 'S-3': 'To Do', 'S-4': 'To Do' }),
      endProject,
    );
    expect(completed).toEqual([
      { id: 'S-1', title: 'S-1' },
      { id: 'S-4', title: 'S-4' },
    ]);
    expect(blocked).toEqual([{ id: 'S-2', title: 'S-2' }]);
  });
});

describe('ProjectDrain.drainProject — completed/blocked Snapshot-Diff (drain-completion-report AC1/AC2)', () => {
  it('AC1: reports completed for a To Do → Done story AND blocked for a /flow-set Blocked story in the SAME drain (blocked ⊇ escalated)', async () => {
    const { state, boardAggregator } = makeBoard([
      { ...makeStory({ id: 'S-1', status: 'To Do', ready: true }), title: 'Feature A' },
      { ...makeStory({ id: 'S-2', status: 'To Do', ready: true }), title: 'Feature B' },
    ]);
    // Round 1 drains S-1 → Done. Round 2 drains S-2 but /flow itself sets it
    // Blocked (NOT via Taktgeber-escalation) — proves `blocked` is a superset
    // of `escalated` (which stays empty here).
    const commandService = new FakeCommandService((callIndex) => {
      const project = state.projects[0];
      if (callIndex === 1) {
        const s1 = findStory(project, 'S-1');
        s1.status = 'Done';
        s1.ready = false;
      } else {
        const s2 = findStory(project, 'S-2');
        s2.status = 'Blocked';
        s2.ready = false;
        s2.blocked_reason = '/flow: self-blocked';
      }
    });
    const drain = new ProjectDrain({ boardAggregator, commandService, lock: new ProjectJobLock(), now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result.reason).toBe('no-drain-target');
    expect(result.escalated).toEqual([]); // no Taktgeber-escalation happened
    expect(result.completed).toEqual([{ id: 'S-1', title: 'Feature A' }]);
    expect(result.blocked).toEqual([{ id: 'S-2', title: 'Feature B' }]); // superset of escalated
  });

  it('AC2: a story that only moves To Do → In Progress (never Done) appears in neither completed nor blocked', async () => {
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'To Do', ready: true }),
      makeStory({ id: 'S-2', status: 'To Do', ready: true }),
    ]);
    const commandService = new FakeCommandService((callIndex) => {
      const project = state.projects[0];
      if (callIndex === 1) {
        // S-1 completes; S-2 merely enters In Progress (a fresh, non-stale one
        // so it is not a target and the loop converges).
        findStory(project, 'S-1').status = 'Done';
        findStory(project, 'S-1').ready = false;
        const s2 = findStory(project, 'S-2');
        s2.status = 'In Progress';
        s2.ready = false;
        s2.updated_at = new Date(NOW_MS).toISOString(); // fresh → not a stale target
      }
    });
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      lock: new ProjectJobLock(),
      staleInProgressHours: 4,
      now: () => NOW_MS,
    });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result.reason).toBe('no-drain-target');
    expect(result.completed).toEqual([{ id: 'S-1', title: 'S-1' }]);
    expect(result.blocked).toEqual([]); // S-2 is In Progress, not Done/Blocked
  });
});

describe('ProjectDrain.drainProject — AC1/AC2: drains until empty', () => {
  it('triggers /agent-flow:flow once per ready To Do target until none remain', async () => {
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'To Do', ready: true }),
      makeStory({ id: 'S-2', status: 'To Do', ready: true }),
    ]);
    const commandService = new FakeCommandService((callIndex) => {
      const project = state.projects[0];
      const id = callIndex === 1 ? 'S-1' : 'S-2';
      const story = findStory(project, id);
      story.status = 'Done';
      story.ready = false;
    });
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      lock: new ProjectJobLock(),
      now: () => NOW_MS,
    });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: [], completed: [{ id: 'S-1', title: 'S-1' }, { id: 'S-2', title: 'S-2' }], blocked: [] });
    expect(commandService.calls).toEqual([
      { command: FLOW_COMMAND, identity: null, projectPath: PROJECT_PATH },
      { command: FLOW_COMMAND, identity: null, projectPath: PROJECT_PATH },
    ]);
  });

  it('returns immediately with flowRuns:0 when the board has no drain target at all', async () => {
    const { boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'Done' }),
      makeStory({ id: 'S-2', status: 'Blocked', blocked_reason: 'x' }),
      makeStory({ id: 'S-3', status: 'Idee' }),
      makeStory({ id: 'S-4', status: 'To Do', ready: false, ready_reason: 'spec nicht gesetzt' }),
    ]);
    const commandService = new FakeCommandService();
    const drain = new ProjectDrain({ boardAggregator, commandService, lock: new ProjectJobLock(), now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [], completed: [], blocked: [] });
    expect(commandService.calls).toHaveLength(0);
  });

  it('AC3: never targets/touches Blocked, Idee, Done or non-ready To Do stories', async () => {
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-target', status: 'To Do', ready: true }),
      makeStory({ id: 'S-blocked', status: 'Blocked', blocked_reason: 'x' }),
      makeStory({ id: 'S-idea', status: 'Idee' }),
      makeStory({ id: 'S-done', status: 'Done' }),
      makeStory({ id: 'S-notready', status: 'To Do', ready: false, ready_reason: 'spec nicht gesetzt' }),
    ]);
    const commandService = new FakeCommandService((callIndex) => {
      const project = state.projects[0];
      findStory(project, 'S-target').status = 'Done';
      void callIndex;
    });
    const drain = new ProjectDrain({ boardAggregator, commandService, lock: new ProjectJobLock(), now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result.flowRuns).toBe(1);
    expect(result.escalated).toEqual([]);
    const project = state.projects[0];
    expect(findStory(project, 'S-blocked').status).toBe('Blocked');
    expect(findStory(project, 'S-idea').status).toBe('Idee');
    expect(findStory(project, 'S-done').status).toBe('Done');
    expect(findStory(project, 'S-notready').status).toBe('To Do');
  });

  it('AC2: depends-only-waiting To Do is automatically pulled in once its predecessor finishes', async () => {
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'To Do', ready: true }),
      makeStory({
        id: 'S-2',
        status: 'To Do',
        ready: false,
        ready_reason: 'abhängige Story nicht Done: S-1',
        depends: ['S-1'],
      }),
    ]);
    const commandService = new FakeCommandService((callIndex) => {
      const project = state.projects[0];
      if (callIndex === 1) {
        // Round 1: /flow finishes S-1; BoardAggregator would now recompute
        // S-2.ready=true (its only depend is Done) — simulated here.
        findStory(project, 'S-1').status = 'Done';
        findStory(project, 'S-1').ready = false;
        const s2 = findStory(project, 'S-2');
        s2.ready = true;
        s2.ready_reason = null;
      } else {
        findStory(project, 'S-2').status = 'Done';
        findStory(project, 'S-2').ready = false;
      }
    });
    const drain = new ProjectDrain({ boardAggregator, commandService, lock: new ProjectJobLock(), now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: [], completed: [{ id: 'S-1', title: 'S-1' }, { id: 'S-2', title: 'S-2' }], blocked: [] });
  });

  it('AC2 Konvergenz: never loops forever when the only waiter depends on a dead-end (Blocked) predecessor', async () => {
    const { boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'Blocked', blocked_reason: 'manual' }),
      makeStory({
        id: 'S-2',
        status: 'To Do',
        ready: false,
        ready_reason: 'abhängige Story nicht Done: S-1',
        depends: ['S-1'],
      }),
    ]);
    const commandService = new FakeCommandService();
    const drain = new ProjectDrain({ boardAggregator, commandService, lock: new ProjectJobLock(), now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [], completed: [], blocked: [] });
    expect(commandService.calls).toHaveLength(0);
  });

  it(
    'AC2 Konvergenz: a transitive ≥2-hop dead chain (Blocked ← To Do ← To Do) terminates fast with no-drain-target and a released lock',
    async () => {
      const { boardAggregator } = makeBoard([
        makeStory({ id: 'S-A', status: 'Blocked', blocked_reason: 'manual' }),
        makeStory({
          id: 'S-B',
          status: 'To Do',
          ready: false,
          ready_reason: 'abhängige Story nicht Done: S-A',
          depends: ['S-A'],
        }),
        makeStory({
          id: 'S-C',
          status: 'To Do',
          ready: false,
          ready_reason: 'abhängige Story nicht Done: S-B',
          depends: ['S-B'],
        }),
      ]);
      const commandService = new FakeCommandService();
      const lock = new ProjectJobLock();
      const drain = new ProjectDrain({ boardAggregator, commandService, lock, now: () => NOW_MS });

      const result = await drain.drainProject(PROJECT_PATH);

      expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [], completed: [], blocked: [] });
      expect(commandService.calls).toHaveLength(0);
      expect(lock.isHeld(PROJECT_PATH)).toBe(false);
    },
    3000,
  );

  it(
    'AC2 Konvergenz: a genuine cycle (S-1 ⇄ S-2) terminates fast with no-drain-target and a released lock',
    async () => {
      const { boardAggregator } = makeBoard([
        makeStory({
          id: 'S-1',
          status: 'To Do',
          ready: false,
          ready_reason: 'abhängige Story nicht Done: S-2',
          depends: ['S-2'],
        }),
        makeStory({
          id: 'S-2',
          status: 'To Do',
          ready: false,
          ready_reason: 'abhängige Story nicht Done: S-1',
          depends: ['S-1'],
        }),
      ]);
      const commandService = new FakeCommandService();
      const lock = new ProjectJobLock();
      const drain = new ProjectDrain({ boardAggregator, commandService, lock, now: () => NOW_MS });

      const result = await drain.drainProject(PROJECT_PATH);

      expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [], completed: [], blocked: [] });
      expect(commandService.calls).toHaveLength(0);
      expect(lock.isHeld(PROJECT_PATH)).toBe(false);
    },
    3000,
  );

  it('AC1: a stale (orphaned) In Progress story is drained as a target', async () => {
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'In Progress', updated_at: '2026-06-30T00:00:00Z' }), // 12h old
    ]);
    const commandService = new FakeCommandService(() => {
      findStory(state.projects[0], 'S-1').status = 'Done';
    });
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      lock: new ProjectJobLock(),
      staleInProgressHours: 4,
      now: () => NOW_MS,
    });

    const result = await drain.drainProject(PROJECT_PATH);
    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 1, escalated: [], completed: [{ id: 'S-1', title: 'S-1' }], blocked: [] });
  });

  it('a fresh (non-stale) In Progress story is never targeted', async () => {
    const { boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'In Progress', updated_at: '2026-06-30T11:30:00Z' }), // 30min old
    ]);
    const commandService = new FakeCommandService();
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      lock: new ProjectJobLock(),
      staleInProgressHours: 4,
      now: () => NOW_MS,
    });

    const result = await drain.drainProject(PROJECT_PATH);
    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [], completed: [], blocked: [] });
  });
});

describe('ProjectDrain.drainProject — AC4/AC5: escalation after consecutive no-progress runs', () => {
  it('escalates the single target to Blocked after escalationAttempts consecutive no-progress runs', async () => {
    const { state, boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const commandService = new FakeCommandService(); // never mutates the board → never progresses
    const boardWriter = new FakeBoardWriter(state);
    const auditStore = new FakeAuditStore();
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      boardWriter,
      auditStore,
      lock: new ProjectJobLock(),
      escalationAttempts: 2,
      now: () => NOW_MS,
    });

    const result = await drain.drainProject(PROJECT_PATH, { identity: 'alex@example.com' });

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: ['S-1'], completed: [], blocked: [{ id: 'S-1', title: 'S-1' }] });
    expect(boardWriter.calls).toEqual([
      { projectSlug: PROJECT_SLUG, storyId: 'S-1', blockedReason: 'Taktgeber: 2x kein Fortschritt' },
    ]);
    const story = findStory(state.projects[0], 'S-1');
    expect(story.status).toBe('Blocked');
    expect(story.blocked_reason).toBe('Taktgeber: 2x kein Fortschritt');
  });

  it('progress resets the no-progress counter (no premature escalation)', async () => {
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'To Do', ready: true }),
      makeStory({ id: 'S-2', status: 'To Do', ready: true }),
    ]);
    // Round 1: no-op (no progress, count=1). Round 2: S-2 progresses to Done
    // (resets counter to 0). Round 3+: no-op again. With escalationAttempts=2
    // escalation only fires after round 3+4 (two FRESH consecutive no-progress
    // runs following the reset), not right after round 1+3.
    const boardWriter = new FakeBoardWriter(state);
    const commandService = new FakeCommandService((callIndex) => {
      if (callIndex === 2) {
        findStory(state.projects[0], 'S-2').status = 'Done';
        findStory(state.projects[0], 'S-2').ready = false;
      }
    });
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      boardWriter,
      lock: new ProjectJobLock(),
      escalationAttempts: 2,
      now: () => NOW_MS,
    });

    const result = await drain.drainProject(PROJECT_PATH);

    // Escalation only triggers once on round 4 (rounds 3+4 are the first
    // consecutive no-progress streak after the round-2 reset).
    expect(result.escalated).toEqual(['S-1']);
    expect(boardWriter.calls).toHaveLength(1);
  });

  it('breaks ties deterministically (smallest id) when multiple targets are equally unmoved', async () => {
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-2', status: 'To Do', ready: true }),
      makeStory({ id: 'S-1', status: 'To Do', ready: true }),
    ]);
    const commandService = new FakeCommandService(); // no progress ever
    const boardWriter = new FakeBoardWriter(state);
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      boardWriter,
      lock: new ProjectJobLock(),
      escalationAttempts: 1, // every no-progress round escalates immediately
      now: () => NOW_MS,
    });

    await drain.drainProject(PROJECT_PATH);

    // Round 1: both S-1/S-2 tied (never moved) → smallest id (S-1) wins.
    // Round 2: S-1 is now Blocked, only S-2 remains → escalated next.
    expect(boardWriter.calls).toHaveLength(2);
    expect(boardWriter.calls[0].storyId).toBe('S-1');
    expect(boardWriter.calls[1].storyId).toBe('S-2');
  });

  it('never escalates a non-ready To Do (AC4 explicit exclusion) — waits for the fresh predecessor to go stale, then drains it', async () => {
    // X (S-2) is a non-ready To Do that hangs solely on Y (S-1), a FRESH
    // (not-yet-stale) In Progress predecessor — couldBecomeReady=true, zero
    // current targets. Real wall-clock time advances by 1h per round (`now`
    // is mutable, like it genuinely would in production where each /flow
    // round takes real time via CommandService's idle-completion) — after
    // staleInProgressHours (4h default) Y itself becomes a real Drain-Ziel
    // and gets drained; X is mitgezogen once Y finishes. Neither S-1 nor
    // S-2 is ever escalated (no-progress never reaches escalationAttempts
    // because each round's clock-advance flips Y's staleness — a real
    // observable state change — well before the threshold).
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'In Progress', updated_at: '2026-06-30T11:55:00Z' }), // 5 min before NOW_MS
      makeStory({
        id: 'S-2',
        status: 'To Do',
        ready: false,
        ready_reason: 'abhängige Story nicht Done: S-1',
        depends: ['S-1'],
      }),
    ]);
    let clockMs = NOW_MS;
    const commandService = new FakeCommandService((callIndex) => {
      clockMs += 60 * 60 * 1000; // +1h real time per /flow round
      if (callIndex === 5) {
        // By now S-1 has crossed the staleInProgressHours threshold and is a
        // real Drain-Ziel — this round's /flow call drains it.
        const s1 = findStory(state.projects[0], 'S-1');
        s1.status = 'Done';
        const s2 = findStory(state.projects[0], 'S-2');
        s2.ready = true;
        s2.ready_reason = null;
      } else if (callIndex === 6) {
        findStory(state.projects[0], 'S-2').status = 'Done';
        findStory(state.projects[0], 'S-2').ready = false;
      }
    });
    const boardWriter = new FakeBoardWriter(state);
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      boardWriter,
      lock: new ProjectJobLock(),
      escalationAttempts: 3,
      staleInProgressHours: 4,
      now: () => clockMs,
    });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result.reason).toBe('no-drain-target');
    expect(result.escalated).toEqual([]); // never escalated — resolved via staleness instead
    expect(boardWriter.calls).toHaveLength(0);
    const s1 = findStory(state.projects[0], 'S-1');
    expect(s1.status).toBe('Done');
  });
});

describe('ProjectDrain.drainProject — Sicherheitsgürtel (Defense-in-Depth-Backstop, safety-stop-no-progress)', () => {
  it(
    'aborts with safety-stop-no-progress after safetyMaxNoProgressRounds rounds when escalation can never succeed (boardWriter.setBlocked throws) — lock released, no hang',
    async () => {
      const { boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
      const commandService = new FakeCommandService(); // never mutates the board → never progresses
      const boardWriter = { setBlocked: async () => { throw new Error('simulated permanent write failure'); } };
      const lock = new ProjectJobLock();
      const drain = new ProjectDrain({
        boardAggregator,
        commandService,
        boardWriter,
        lock,
        escalationAttempts: 2,
        safetyMaxNoProgressRounds: 3, // small injected value — do not run all 50 default rounds
        now: () => NOW_MS,
      });

      const result = await drain.drainProject(PROJECT_PATH);

      expect(result.stopped).toBe(true);
      expect(result.reason).toBe('safety-stop-no-progress');
      expect(result.escalated).toEqual([]); // escalation attempted but always failed (write threw)
      expect(lock.isHeld(PROJECT_PATH)).toBe(false);
    },
    3000,
  );

  it(
    'aborts with safety-stop-no-progress when no boardWriter is configured at all (escalation can never fire)',
    async () => {
      const { boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
      const commandService = new FakeCommandService(); // never mutates the board → never progresses
      const lock = new ProjectJobLock();
      const drain = new ProjectDrain({
        boardAggregator,
        commandService,
        // boardWriter intentionally omitted
        lock,
        escalationAttempts: 2,
        safetyMaxNoProgressRounds: 3,
        now: () => NOW_MS,
      });

      const result = await drain.drainProject(PROJECT_PATH);

      expect(result.reason).toBe('safety-stop-no-progress');
      expect(result.escalated).toEqual([]);
      expect(lock.isHeld(PROJECT_PATH)).toBe(false);
    },
    3000,
  );

  it('exposes the documented default safety backstop constant', () => {
    expect(DEFAULT_SAFETY_MAX_NO_PROGRESS_ROUNDS).toBe(50);
  });
});

describe('ProjectDrain.drainProject — AC6/AC7: concurrency + lock discipline', () => {
  it('rejects with already-busy when the project lock is already held', async () => {
    const { boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const commandService = new FakeCommandService();
    const lock = new ProjectJobLock();
    lock.tryAcquire(PROJECT_PATH);
    const drain = new ProjectDrain({ boardAggregator, commandService, lock, now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result).toEqual({ stopped: true, reason: 'already-busy', flowRuns: 0, escalated: [], completed: [], blocked: [] });
    expect(commandService.calls).toHaveLength(0);
    lock.release(PROJECT_PATH);
  });

  it('rejects with already-busy when an active session exists for the project (no double-trigger)', async () => {
    const { boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const commandService = new FakeCommandService();
    const sessionRegistry = { hasSession: (p) => p === PROJECT_PATH };
    const lock = new ProjectJobLock();
    const drain = new ProjectDrain({ boardAggregator, commandService, sessionRegistry, lock, now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result.reason).toBe('already-busy');
    expect(lock.isHeld(PROJECT_PATH)).toBe(false); // never acquired
  });

  it('releases the lock even when the board scan fails (no permanent lock, reason distinguishes scan-failed from a genuinely empty board)', async () => {
    const boardAggregator = {
      async scan() {
        throw new Error('fs blew up');
      },
      async getIndex() {
        return [];
      },
    };
    const commandService = new FakeCommandService();
    const lock = new ProjectJobLock();
    const drain = new ProjectDrain({ boardAggregator, commandService, lock, now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    // scan() throwing is a transient/operational failure, not "board genuinely
    // has no drain target" — #findProject distinguishes both via its scanFailed
    // flag so a later scheduler (S-195) can retry instead of treating the
    // project as permanently empty (see ProjectDrain module doc + spec
    // taktgeber-nachtwaechter.md "Engine-Schnittstelle").
    expect(result).toEqual({ stopped: true, reason: 'scan-failed', flowRuns: 0, escalated: [], completed: [], blocked: [] });
    expect(lock.isHeld(PROJECT_PATH)).toBe(false);
    // Lock is acquirable again immediately afterwards
    expect(lock.tryAcquire(PROJECT_PATH)).toBe(true);
    lock.release(PROJECT_PATH);
  });

  it('releases the lock even when commandService.tryRun throws (no crash, counted as no-progress)', async () => {
    const { state, boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const commandService = {
      tryRun: () => {
        throw new Error('PTY exploded');
      },
      getStatus: () => ({ commandId: null, status: null }),
    };
    const boardWriter = new FakeBoardWriter(state);
    const lock = new ProjectJobLock();
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      boardWriter,
      lock,
      escalationAttempts: 1,
      now: () => NOW_MS,
    });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result.flowRuns).toBe(1);
    expect(result.escalated).toEqual(['S-1']);
    expect(lock.isHeld(PROJECT_PATH)).toBe(false);
  });
});

describe(
  'ProjectDrain.drainProject — Lock-Contention gegen den globalen CommandService-JobLock ' +
    '(S-195 Review-Iteration 2, live verifiziert critical: reason "locked" darf NICHT als ' +
    'kein-Fortschritt gezählt werden, siehe .claude/lessons/coder.md 2026-07-01)',
  () => {
    it('stops immediately with reason "command-channel-busy", no spin, no escalation, when tryRun() reports the global lock is held by another project', async () => {
      const { state, boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
      const commandService = {
        tryRun: () => ({ ok: false, reason: 'locked' }),
        getStatus: () => ({ commandId: null, status: null }),
      };
      const boardWriter = new FakeBoardWriter(state);
      const lock = new ProjectJobLock();
      const drain = new ProjectDrain({
        boardAggregator,
        commandService,
        boardWriter,
        lock,
        escalationAttempts: 1, // deliberately low — if the bug regresses, this would escalate on round 1
        now: () => NOW_MS,
      });

      const result = await drain.drainProject(PROJECT_PATH);

      expect(result).toEqual({ stopped: true, reason: 'command-channel-busy', flowRuns: 1, escalated: [], completed: [], blocked: [] });
      // The healthy, unchanged ready story must NEVER be escalated to Blocked —
      // this is exactly the corruption the reviewer live-reproduced.
      expect(boardWriter.calls).toEqual([]);
      expect(findStory(state.projects[0], 'S-1').status).toBe('To Do');
      expect(findStory(state.projects[0], 'S-1').blocked_reason).toBeNull();
      // Own ProjectJobLock is released (project remains a candidate for the next tick).
      expect(lock.isHeld(PROJECT_PATH)).toBe(false);
    });

    it('treats reason "busy" the same way as "locked" (defensive — CommandService today only returns "locked")', async () => {
      const { state, boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
      const commandService = {
        tryRun: () => ({ ok: false, reason: 'busy' }),
        getStatus: () => ({ commandId: null, status: null }),
      };
      const boardWriter = new FakeBoardWriter(state);
      const drain = new ProjectDrain({
        boardAggregator,
        commandService,
        boardWriter,
        lock: new ProjectJobLock(),
        escalationAttempts: 1,
        now: () => NOW_MS,
      });

      const result = await drain.drainProject(PROJECT_PATH);

      expect(result.reason).toBe('command-channel-busy');
      expect(result.escalated).toEqual([]);
      expect(boardWriter.calls).toEqual([]);
    });

    it('across many repeated scheduler-style drainProject() calls (simulating consecutive ticks), a permanently contended project never accumulates escalation and never touches the story', async () => {
      const { state, boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
      const commandService = {
        tryRun: () => ({ ok: false, reason: 'locked' }),
        getStatus: () => ({ commandId: null, status: null }),
      };
      const boardWriter = new FakeBoardWriter(state);
      const lock = new ProjectJobLock();
      const drain = new ProjectDrain({
        boardAggregator,
        commandService,
        boardWriter,
        lock,
        escalationAttempts: 2,
        now: () => NOW_MS,
      });

      // Simulate 10 consecutive scheduler ticks, each starting a fresh drainProject()
      // call for this project (as NightWatchScheduler does once the previous drain's
      // promise has settled — see NightWatchScheduler.js #startDrain/#activeDrains).
      for (let i = 0; i < 10; i += 1) {
        const result = await drain.drainProject(PROJECT_PATH);
        expect(result.reason).toBe('command-channel-busy');
        expect(result.escalated).toEqual([]);
      }

      expect(boardWriter.calls).toEqual([]);
      expect(findStory(state.projects[0], 'S-1').status).toBe('To Do');
      expect(lock.isHeld(PROJECT_PATH)).toBe(false);
    });
  },
);

describe('ProjectDrain.drainProject — AC18: audit', () => {
  it('records exactly one drain-start entry and one escalation entry', async () => {
    const { state, boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const commandService = new FakeCommandService();
    const boardWriter = new FakeBoardWriter(state);
    const auditStore = new FakeAuditStore();
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      boardWriter,
      auditStore,
      lock: new ProjectJobLock(),
      escalationAttempts: 1,
      now: () => NOW_MS,
    });

    await drain.drainProject(PROJECT_PATH, { identity: 'alex@example.com' });

    expect(auditStore.entries).toHaveLength(2);
    expect(auditStore.entries[0].identity).toBe('alex@example.com');
    expect(auditStore.entries[0].command).toContain('drain-start');
    expect(auditStore.entries[0].command).toContain(PROJECT_PATH);
    expect(auditStore.entries[1].command).toContain('escalate');
    expect(auditStore.entries[1].command).toContain('S-1');
  });

  it('does not record a drain-start entry when rejected as already-busy', async () => {
    const { boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const commandService = new FakeCommandService();
    const lock = new ProjectJobLock();
    lock.tryAcquire(PROJECT_PATH);
    const auditStore = new FakeAuditStore();
    const drain = new ProjectDrain({ boardAggregator, commandService, lock, auditStore, now: () => NOW_MS });

    await drain.drainProject(PROJECT_PATH);

    expect(auditStore.entries).toHaveLength(0);
    lock.release(PROJECT_PATH);
  });

  it('a throwing AuditStore does not crash the drain (best-effort)', async () => {
    const { boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'Done' })]);
    const commandService = new FakeCommandService();
    const auditStore = { record: () => { throw new Error('audit down'); } };
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      auditStore,
      lock: new ProjectJobLock(),
      now: () => NOW_MS,
    });

    await expect(drain.drainProject(PROJECT_PATH)).resolves.toEqual({
      stopped: true,
      reason: 'no-drain-target',
      flowRuns: 0,
      escalated: [],
      completed: [],
      blocked: [],
    });
  });
});

describe('ProjectDrain — idle-completion polling (CommandService completion model)', () => {
  it('polls getStatus() via the injected sleepFn until status leaves "running"', async () => {
    let pollCount = 0;
    let started = false; // getStatus() must report idle (not 'running') BEFORE tryRun() is ever called
    const statuses = ['running', 'running', 'done'];
    const commandService = {
      tryRun: () => {
        started = true;
        return { ok: true, commandId: 'cmd-1', status: 'running' };
      },
      getStatus: () =>
        started
          ? { commandId: 'cmd-1', status: statuses[Math.min(pollCount, statuses.length - 1)] }
          : { commandId: null, status: null },
    };
    const sleepCalls = [];
    const sleepFn = async (ms) => {
      sleepCalls.push(ms);
      pollCount += 1;
    };
    // Force exactly one round by making the board already empty of targets
    // AFTER the (single) flow run — board starts with a target so the loop
    // enters once, awaits completion, then converges.
    const { state } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const drain = new ProjectDrain({
      boardAggregator: {
        scan: async () => {},
        getIndex: async () => {
          // After polling completes, mark the story Done so the loop stops.
          if (pollCount >= 2) findStory(state.projects[0], 'S-1').status = 'Done';
          return state.projects;
        },
      },
      commandService,
      lock: new ProjectJobLock(),
      pollIntervalMs: 50,
      sleepFn,
      now: () => NOW_MS,
    });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(sleepCalls).toEqual([50, 50]);
    expect(result.flowRuns).toBe(1);
    expect(result.reason).toBe('no-drain-target');
  });
});

describe('ProjectDrain — defaults', () => {
  it('exposes the documented default constants', () => {
    expect(FLOW_COMMAND).toBe('/agent-flow:flow');
    expect(DEFAULT_STALE_IN_PROGRESS_HOURS).toBe(4);
    expect(DEFAULT_ESCALATION_ATTEMPTS).toBe(3);
  });

  it('falls back to defaults for non-positive staleInProgressHours/escalationAttempts', async () => {
    const { boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'Done' })]);
    const commandService = new FakeCommandService();
    const drain = new ProjectDrain({
      boardAggregator,
      commandService,
      lock: new ProjectJobLock(),
      staleInProgressHours: 0,
      escalationAttempts: -1,
      now: () => NOW_MS,
    });
    // No throw at construction time; defaults silently applied.
    const result = await drain.drainProject(PROJECT_PATH);
    expect(result.reason).toBe('no-drain-target');
  });
});

// ── FlowRunner-Injection (headless-parallel-drain AC5/AC6) ────────────────────

describe('ProjectDrain — FlowRunner-Injection (headless-parallel-drain AC5/AC6)', () => {
  /**
   * FakeFlowRunner — duck-typed `FlowRunner` (startRun/awaitCompletion), NOT
   * a CommandService. Proves #runLoop genuinely goes through the injected
   * interface rather than any CommandService-shaped object (AC5: "über das
   * Interface statt über ein hart verdrahtetes CommandService").
   */
  class FakeFlowRunner {
    constructor(onRun) {
      this.onRun = onRun;
      this.calls = [];
    }

    startRun({ projectPath, command, identity }) {
      this.calls.push({ projectPath, command, identity });
      const result = this.onRun ? this.onRun(this.calls.length) : undefined;
      if (result && result.ok === false) return result;
      return { ok: true, handle: { runId: this.calls.length } };
    }

    async awaitCompletion() {
      return { status: 'done' };
    }
  }

  /**
   * FakeHeadlessRunner — mirrors the `HeadlessFlowRunner` (S-204) API
   * (`start(projectPath, {command, args}) → {ok,jobId}`,
   * `getJob(jobId) → {status,...}`). Mutates the board synchronously inside
   * `start()` and marks the job `'done'` immediately (deterministic tests,
   * analogous to `FakeCommandService` above) — the real async/close-event
   * semantics are covered separately in test/HeadlessFlowRunner.test.js and
   * test/FlowRunner.test.js (AC1-AC4/AC13).
   */
  class FakeHeadlessRunner {
    constructor(onRun) {
      this.onRun = onRun;
      this.calls = [];
      this.jobs = new Map();
    }

    start(projectPath, { command, args }) {
      this.calls.push({ projectPath, command, args });
      const jobId = `job-${this.calls.length}`;
      const runResult = this.onRun ? this.onRun(this.calls.length) : undefined;
      if (runResult && runResult.ok === false) return runResult;
      this.jobs.set(jobId, { status: 'done', result: 'Flow abgeschlossen' });
      return { ok: true, jobId };
    }

    getJob(jobId) {
      return this.jobs.get(jobId);
    }
  }

  it('drains via an injected custom FlowRunner (not a CommandService) — targets/escalation/snapshot unaffected', async () => {
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'To Do', ready: true }),
      makeStory({ id: 'S-2', status: 'To Do', ready: true }),
    ]);
    const flowRunner = new FakeFlowRunner((callIndex) => {
      const project = state.projects[0];
      const id = callIndex === 1 ? 'S-1' : 'S-2';
      findStory(project, id).status = 'Done';
      findStory(project, id).ready = false;
    });
    const drain = new ProjectDrain({ boardAggregator, flowRunner, lock: new ProjectJobLock(), now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: [], completed: [{ id: 'S-1', title: 'S-1' }, { id: 'S-2', title: 'S-2' }], blocked: [] });
    expect(flowRunner.calls).toEqual([
      { projectPath: PROJECT_PATH, command: FLOW_COMMAND, identity: null },
      { projectPath: PROJECT_PATH, command: FLOW_COMMAND, identity: null },
    ]);
  });

  it('passes per-drain args to every startRun() call (headless-manual-drain AC3: --cost durchgereicht an ALLE Flow-Runden)', async () => {
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'To Do', ready: true }),
      makeStory({ id: 'S-2', status: 'To Do', ready: true }),
    ]);
    // Capturing runner: hält den VOLLEN startRun-Payload inkl. args fest.
    const capturedCalls = [];
    const flowRunner = {
      startRun(payload) {
        capturedCalls.push(payload);
        const project = state.projects[0];
        const id = capturedCalls.length === 1 ? 'S-1' : 'S-2';
        findStory(project, id).status = 'Done';
        findStory(project, id).ready = false;
        return { ok: true, handle: { runId: capturedCalls.length } };
      },
      async awaitCompletion() {
        return { status: 'done' };
      },
    };
    const drain = new ProjectDrain({ boardAggregator, flowRunner, lock: new ProjectJobLock(), now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH, { identity: 'alex@example.com', args: ['--cost', 'low-cost'] });

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: [], completed: [{ id: 'S-1', title: 'S-1' }, { id: 'S-2', title: 'S-2' }], blocked: [] });
    // AC3: JEDE Flow-Runde erhält dieselben per-Drain-args.
    expect(capturedCalls).toEqual([
      { projectPath: PROJECT_PATH, command: FLOW_COMMAND, identity: 'alex@example.com', args: ['--cost', 'low-cost'] },
      { projectPath: PROJECT_PATH, command: FLOW_COMMAND, identity: 'alex@example.com', args: ['--cost', 'low-cost'] },
    ]);
  });

  it('defaults args to [] when drainProject() is called without args (AC3: balanced/kein Flag)', async () => {
    const { state, boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const capturedCalls = [];
    const flowRunner = {
      startRun(payload) {
        capturedCalls.push(payload);
        findStory(state.projects[0], 'S-1').status = 'Done';
        findStory(state.projects[0], 'S-1').ready = false;
        return { ok: true, handle: { runId: 1 } };
      },
      async awaitCompletion() {
        return { status: 'done' };
      },
    };
    const drain = new ProjectDrain({ boardAggregator, flowRunner, lock: new ProjectJobLock(), now: () => NOW_MS });

    await drain.drainProject(PROJECT_PATH);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].args).toEqual([]);
  });

  it('escalates via an injected custom FlowRunner exactly like the default interactive adapter (AC5: escalation logic unaffected by the adapter)', async () => {
    const { state, boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const flowRunner = new FakeFlowRunner(); // never mutates the board → never progresses
    const boardWriter = new FakeBoardWriter(state);
    const drain = new ProjectDrain({
      boardAggregator,
      flowRunner,
      boardWriter,
      lock: new ProjectJobLock(),
      escalationAttempts: 2,
      now: () => NOW_MS,
    });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: ['S-1'], completed: [], blocked: [{ id: 'S-1', title: 'S-1' }] });
    expect(findStory(state.projects[0], 'S-1').status).toBe('Blocked');
  });

  it('maps an injected FlowRunner\'s reason "locked"/"busy" to "command-channel-busy" generically (not CommandService-specific — same contract for any adapter)', async () => {
    const { state, boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const flowRunner = { startRun: () => ({ ok: false, reason: 'locked' }), awaitCompletion: async () => ({ status: 'done' }) };
    const boardWriter = new FakeBoardWriter(state);
    const drain = new ProjectDrain({
      boardAggregator,
      flowRunner,
      boardWriter,
      lock: new ProjectJobLock(),
      escalationAttempts: 1,
      now: () => NOW_MS,
    });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result).toEqual({ stopped: true, reason: 'command-channel-busy', flowRuns: 1, escalated: [], completed: [], blocked: [] });
    expect(boardWriter.calls).toEqual([]);
  });

  it('drains via an injected real HeadlessFlowRunnerAdapter (S-212 headless path) — convergence + progress detection work identically to the interactive default', async () => {
    const { state, boardAggregator } = makeBoard([
      makeStory({ id: 'S-1', status: 'To Do', ready: true }),
      makeStory({
        id: 'S-2',
        status: 'To Do',
        ready: false,
        ready_reason: 'abhängige Story nicht Done: S-1',
        depends: ['S-1'],
      }),
    ]);
    const headlessRunner = new FakeHeadlessRunner((callIndex) => {
      const project = state.projects[0];
      if (callIndex === 1) {
        findStory(project, 'S-1').status = 'Done';
        findStory(project, 'S-1').ready = false;
        const s2 = findStory(project, 'S-2');
        s2.ready = true;
        s2.ready_reason = null;
      } else {
        findStory(project, 'S-2').status = 'Done';
        findStory(project, 'S-2').ready = false;
      }
    });
    const flowRunner = new HeadlessFlowRunnerAdapter({ headlessRunner, sleepFn: async () => {} });
    const drain = new ProjectDrain({ boardAggregator, flowRunner, lock: new ProjectJobLock(), now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: [], completed: [{ id: 'S-1', title: 'S-1' }, { id: 'S-2', title: 'S-2' }], blocked: [] });
    // drainProject() ohne `args` reicht per Default `args: []` durch (headless-manual-drain
    // AC3) — verhaltensgleich zu „kein Flag" (HeadlessRunnerCore behandelt [] wie ohne args).
    expect(headlessRunner.calls).toEqual([
      { projectPath: PROJECT_PATH, command: FLOW_COMMAND, args: [] },
      { projectPath: PROJECT_PATH, command: FLOW_COMMAND, args: [] },
    ]);
  });

  it('never escalates a permanently-dead-end story through the headless adapter either (transitive Konvergenz-Regel is adapter-independent)', async () => {
    const { boardAggregator } = makeBoard([
      makeStory({ id: 'S-A', status: 'Blocked', blocked_reason: 'manual' }),
      makeStory({
        id: 'S-B',
        status: 'To Do',
        ready: false,
        ready_reason: 'abhängige Story nicht Done: S-A',
        depends: ['S-A'],
      }),
    ]);
    const headlessRunner = new FakeHeadlessRunner();
    const flowRunner = new HeadlessFlowRunnerAdapter({ headlessRunner, sleepFn: async () => {} });
    const drain = new ProjectDrain({ boardAggregator, flowRunner, lock: new ProjectJobLock(), now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [], completed: [], blocked: [] });
    expect(headlessRunner.calls).toHaveLength(0);
  });

  it('AC6: without an injected flowRunner, the default InteractiveFlowRunner is built around commandService — isProjectBusy() still consults commandService.getStatus() independently of the execution step', async () => {
    const { boardAggregator } = makeBoard([makeStory({ id: 'S-1', status: 'To Do', ready: true })]);
    const commandService = new FakeCommandService();
    commandService._status = { commandId: 'external-cmd', status: 'running' }; // some OTHER command is running
    const drain = new ProjectDrain({ boardAggregator, commandService, lock: new ProjectJobLock(), now: () => NOW_MS });

    const result = await drain.drainProject(PROJECT_PATH);

    // isProjectBusy() sees commandService.getStatus().status==='running' and
    // rejects before the execution step is ever reached (AC7 busy-check is
    // untouched by the FlowRunner-Injection, exactly as documented).
    expect(result).toEqual({ stopped: true, reason: 'already-busy', flowRuns: 0, escalated: [], completed: [], blocked: [] });
    expect(commandService.calls).toHaveLength(0);
  });
});
