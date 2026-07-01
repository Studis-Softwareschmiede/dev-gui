/**
 * ProjectDrain.test.js — Unit-/Integrationstests für die ProjectDrain-Engine
 * (docs/specs/taktgeber-nachtwaechter.md).
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
 * Strategy:
 *   - Pure Helper-Funktionen (flattenProjectStories, isStaleInProgress,
 *     computeAliveStoryIds, couldBecomeReadyViaDepends, computeDrainState,
 *     snapshotsEqual, pickLongestUnmovedTarget) werden direkt mit
 *     Fixture-Objekten getestet (kein IO, volle Verzweigungsabdeckung inkl.
 *     Konvergenz-Sackgassen: mehrstufige tote Ketten, Zyklen, Selbst-Depend).
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
} from '../src/ProjectDrain.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';

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

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: [] });
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

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] });
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

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: [] });
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

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] });
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

      expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] });
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

      expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] });
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
    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 1, escalated: [] });
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
    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] });
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

    expect(result).toEqual({ stopped: true, reason: 'no-drain-target', flowRuns: 2, escalated: ['S-1'] });
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

    expect(result).toEqual({ stopped: true, reason: 'already-busy', flowRuns: 0, escalated: [] });
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
    expect(result).toEqual({ stopped: true, reason: 'scan-failed', flowRuns: 0, escalated: [] });
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

      expect(result).toEqual({ stopped: true, reason: 'command-channel-busy', flowRuns: 1, escalated: [] });
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
