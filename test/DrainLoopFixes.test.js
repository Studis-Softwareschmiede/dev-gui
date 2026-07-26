/**
 * DrainLoopFixes.test.js — Tests für die drei Vorfalls-Specs vom 2026-07-26
 * („Taktgeber-Endlosschleife"):
 *
 * Covers (drain-escalation-effectiveness, S-420):
 *   AC1/AC5 — origin-ref-Quelle + nie sichtbar werdende Eskalation → der Drain
 *          terminiert in ENDLICHER, gebundener Rundenzahl mit dem neuen
 *          terminalen `reason: 'escalation-ineffective'` (der Vorfall ist
 *          strukturell reproduziert und terminiert jetzt). Kein unbedingter
 *          Sicherheitsgürtel-Reset mehr nach `#escalate`.
 *   AC3 — im origin-ref-Quellenmodus wird KEIN `BoardWriter.setBlocked`
 *          ausgeführt (keine Dirty-Leiche, keine fälschlich blockierte Story)
 *          + Audit `escalation-skipped … origin-ref-source`.
 *   AC4 — `pickLongestUnmovedTarget(targets, lastChangeRound, escalatedIds)`
 *          wählt bereits (versucht) eskalierte IDs nie erneut.
 *
 * Covers (drain-stop-control, S-421):
 *   AC1 — DrainAbortRegistry: register/signal/isAborted/unregister; signal()
 *          liefert true nur bei aktivem Eintrag.
 *   AC2 — `drainProject({ abortSignal })`: gesetztes Signal beendet die
 *          Schleife am Rundenanfang mit `reason:'aborted'`; Lock freigegeben;
 *          ohne Signal bit-identisches Verhalten (belegt durch die bestehende
 *          Suite test/ProjectDrain.test.js).
 *   AC3/AC4 — POST /api/projects/:slug/drain/:drainId/stop → 202 bei aktivem
 *          Drain (+ DrainJobRegistry-Eintrag `aborted`), 404 sonst, 400 bei
 *          ungültigem Slug.
 *   AC5 — DrainJobRegistry: `markDone` überschreibt `aborted` nie; ein
 *          `result.reason==='aborted'` wird terminal als `aborted` gehalten.
 *   AC6 — `reconcileOrphans()` gibt einen bewusst gestoppten (`aborted`)
 *          Drain NICHT als Orphan zurück (kein Boot-Wiederanlauf).
 *   AC8 — NightWatchScheduler registriert je Nacht-Drain das Abort-Handle in
 *          der geteilten Registry und reicht `abortSignal` an drainProject.
 *
 * Covers (drain-clone-precondition-sync, S-423):
 *   AC2 — eigene Taktgeber-Artefakte (exakte setBlocked-Signatur) werden per
 *          `checkout -- <datei>` verworfen; fremde Änderungen NIE.
 *   AC3 — fremder Dirty-Rest → terminaler Stop `reason:'clone-dirty'`, kein
 *          Flow-Anstoß.
 *   AC4 — nicht fast-forward-baubar → `reason:'clone-diverged'`.
 *   AC5 — kein Remote → No-Op-Sync, Drain läuft normal.
 *   (Signatur-Erkennung: `isTaktgeberBlockedArtifactDiff` pure-function.)
 */

import express from 'express';
import { jest } from '@jest/globals';
import {
  ProjectDrain,
  pickLongestUnmovedTarget,
  isTaktgeberBlockedArtifactDiff,
} from '../src/ProjectDrain.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';
import { DrainAbortRegistry, createAbortHandle } from '../src/DrainAbortRegistry.js';
import { DrainJobRegistry } from '../src/DrainJobRegistry.js';
import { projectDrainRouter } from '../src/projectDrainRouter.js';
import { NightWatchScheduler } from '../src/NightWatchScheduler.js';

const PROJECT_SLUG = 'my-project';
const PROJECT_PATH = '/workspace/my-project';
const NOW_MS = Date.UTC(2026, 6, 26, 12, 0);

function makeStory(id, overrides = {}) {
  return {
    id,
    title: id,
    status: 'To Do',
    ready: true,
    ready_reason: null,
    blocked_reason: null,
    depends: null,
    ...overrides,
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

/**
 * Dual-Source-Board (Muster test/ProjectDrain.test.js): `scan()/getIndex()` =
 * Working-Tree-Stand; `readProjectAt(..., { fsDeps })` = origin-Ref-Stand
 * (nur wenn ProjectDrain den origin-ref-Pfad gewählt hat).
 */
function makeDualSourceBoard({ workingTreeStories, refStories }) {
  const workingTreeProject = makeProject(PROJECT_SLUG, PROJECT_PATH, workingTreeStories);
  const refProject = makeProject(PROJECT_SLUG, PROJECT_PATH, refStories);
  return {
    workingTreeProject,
    refProject,
    boardAggregator: {
      async scan() {},
      async getIndex() {
        return [workingTreeProject];
      },
      async readProjectAt(_slug, _repoPath, { fsDeps } = {}) {
        return fsDeps ? refProject : workingTreeProject;
      },
    },
  };
}

class FakeGitReadBoundary {
  constructor({ fetchResult = { ok: true, fetched: true }, truthRef = { ahead: false, ref: null } } = {}) {
    this.fetchResult = fetchResult;
    this.truthRef = truthRef;
  }

  async fetchOrigin() {
    return this.fetchResult;
  }

  async resolveTruthRef() {
    return this.truthRef;
  }
}

/** Skriptbares Double für GitSyncBoundary (status/diff/checkout/upstream/ff). */
class FakeGitSyncBoundary {
  constructor({ statusEntries = [], diffs = {}, upstream = 'origin/main', ffOk = true } = {}) {
    this.statusEntries = statusEntries; // Array ODER Array<Array> (je Aufruf)
    this.diffs = diffs;
    this.upstream = upstream;
    this.ffOk = ffOk;
    this.checkoutCalls = [];
    this.mergeCalls = [];
    this.statusCallCount = 0;
  }

  async statusPorcelain() {
    const entries = Array.isArray(this.statusEntries[0]) || this.statusEntries.length === 0
      ? this.statusEntries[Math.min(this.statusCallCount, this.statusEntries.length - 1)] ?? []
      : this.statusEntries;
    this.statusCallCount += 1;
    return Array.isArray(entries) ? entries : [];
  }

  async diffFile(_repo, relPath) {
    return this.diffs[relPath] ?? '';
  }

  async checkoutFile(_repo, relPath) {
    this.checkoutCalls.push(relPath);
    return { ok: true };
  }

  async upstreamRef() {
    return this.upstream;
  }

  async mergeFfOnly(_repo, ref) {
    this.mergeCalls.push(ref);
    return { ok: this.ffOk };
  }
}

class FakeAuditStore {
  constructor() {
    this.entries = [];
  }

  record({ identity, command }) {
    this.entries.push({ identity, command });
  }
}

/** FlowRunner-Fake, der nie Fortschritt am Board erzeugt. */
function makeFruitlessFlowRunner() {
  return {
    startRun() {
      return { ok: true, handle: {} };
    },
    async awaitCompletion() {
      return { status: 'done' };
    },
  };
}

const TAKTGEBER_DIFF = [
  'diff --git a/board/stories/S-1.yaml b/board/stories/S-1.yaml',
  '--- a/board/stories/S-1.yaml',
  '+++ b/board/stories/S-1.yaml',
  '@@ -3,3 +3,3 @@',
  "-status: 'To Do'",
  '+status: Blocked',
  '-blocked_reason: null',
  "+blocked_reason: 'Taktgeber: 3x kein Fortschritt'",
  '-updated_at: 2026-07-20T00:00:00Z',
  '+updated_at: 2026-07-26T00:00:00Z',
].join('\n');

// ── isTaktgeberBlockedArtifactDiff (drain-clone-precondition-sync A1/AC2) ────

describe('isTaktgeberBlockedArtifactDiff', () => {
  it('erkennt die exakte setBlocked-Signatur (status+blocked_reason+updated_at)', () => {
    expect(isTaktgeberBlockedArtifactDiff(TAKTGEBER_DIFF)).toBe(true);
  });

  it('lehnt Diffs mit JEDER anderen geänderten Zeile ab (fremde Änderung)', () => {
    const foreign = `${TAKTGEBER_DIFF}\n-title: Alt\n+title: Neu`;
    expect(isTaktgeberBlockedArtifactDiff(foreign)).toBe(false);
  });

  it('lehnt Nicht-Taktgeber-blocked_reason und Nicht-Blocked-Status ab', () => {
    expect(
      isTaktgeberBlockedArtifactDiff('-status: To Do\n+status: Blocked\n-blocked_reason: null\n+blocked_reason: Manuell'),
    ).toBe(false);
    expect(
      isTaktgeberBlockedArtifactDiff("-status: To Do\n+status: Done\n+blocked_reason: 'Taktgeber: 3x kein Fortschritt'"),
    ).toBe(false);
    expect(isTaktgeberBlockedArtifactDiff('')).toBe(false);
    expect(isTaktgeberBlockedArtifactDiff(null)).toBe(false);
  });
});

// ── pickLongestUnmovedTarget mit Eskalations-Cap (AC4) ───────────────────────

describe('pickLongestUnmovedTarget — Per-Story-Eskalations-Cap (drain-escalation-effectiveness AC4)', () => {
  it('wählt bereits (versucht) eskalierte IDs nie erneut', () => {
    const targets = [makeStory('S-1'), makeStory('S-2')];
    const rounds = new Map([
      ['S-1', 1],
      ['S-2', 2],
    ]);
    expect(pickLongestUnmovedTarget(targets, rounds).id).toBe('S-1');
    expect(pickLongestUnmovedTarget(targets, rounds, new Set(['S-1'])).id).toBe('S-2');
    expect(pickLongestUnmovedTarget(targets, rounds, new Set(['S-1', 'S-2']))).toBeNull();
  });
});

// ── Vorfalls-Reproduktion: origin-ref + unwirksame Eskalation (AC1/AC3/AC5) ──

describe('drainProject — gebundene Terminierung bei unwirksamer Eskalation (drain-escalation-effectiveness AC1/AC3/AC5/AC6)', () => {
  function makeIncidentDrain({ escalationAttempts = 1, stories = ['S-1', 'S-2'] } = {}) {
    const refStories = stories.map((id) => makeStory(id));
    const { boardAggregator } = makeDualSourceBoard({
      workingTreeStories: stories.map((id) => makeStory(id)),
      refStories,
    });
    const boardWriterCalls = [];
    const auditStore = new FakeAuditStore();
    const drain = new ProjectDrain({
      boardAggregator,
      flowRunner: makeFruitlessFlowRunner(),
      boardWriter: {
        async setBlocked(args) {
          boardWriterCalls.push(args);
        },
      },
      auditStore,
      lock: new ProjectJobLock(),
      // origin strikt voraus → Snapshot-Quelle origin-ref (der Vorfalls-Modus).
      gitReadBoundary: new FakeGitReadBoundary({ truthRef: { ahead: true, ref: 'origin/main' } }),
      gitSyncBoundary: new FakeGitSyncBoundary(),
      escalationAttempts,
      now: () => NOW_MS,
      sleepFn: () => Promise.resolve(),
    });
    return { drain, boardWriterCalls, auditStore };
  }

  it('terminiert endlich mit reason "escalation-ineffective" — der Vorfall 2026-07-26 läuft nicht mehr endlos', async () => {
    const { drain, boardWriterCalls, auditStore } = makeIncidentDrain();

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result.reason).toBe('escalation-ineffective');
    expect(result.stopped).toBe(true);
    // AC3: im origin-ref-Modus wird NIE geschrieben (keine Dirty-Leiche).
    expect(boardWriterCalls).toHaveLength(0);
    // escalated (Bericht) bleibt leer — kein wirksamer Blocked-Übergang.
    expect(result.escalated).toEqual([]);
    // AC3-Audit: je unterlassener Eskalation ein Eintrag mit Grund.
    const skips = auditStore.entries.filter((e) => e.command.includes('escalation-skipped'));
    expect(skips.length).toBeGreaterThanOrEqual(1);
    expect(skips[0].command).toContain('origin-ref-source');
    const ineffective = auditStore.entries.filter((e) => e.command.includes('escalation-ineffective'));
    expect(ineffective).toHaveLength(1);
  }, 15000);

  it('Rundenzahl ist hart gebunden (O(#Ziele × escalationAttempts)) — kein 149-Sessions-Loop', async () => {
    let runs = 0;
    const refStories = [makeStory('S-1'), makeStory('S-2'), makeStory('S-3')];
    const { boardAggregator } = makeDualSourceBoard({
      workingTreeStories: refStories.map((s) => ({ ...s })),
      refStories,
    });
    const drain = new ProjectDrain({
      boardAggregator,
      flowRunner: {
        startRun() {
          runs += 1;
          return { ok: true, handle: {} };
        },
        async awaitCompletion() {
          return { status: 'done' };
        },
      },
      boardWriter: { async setBlocked() {} },
      lock: new ProjectJobLock(),
      gitReadBoundary: new FakeGitReadBoundary({ truthRef: { ahead: true, ref: 'origin/main' } }),
      gitSyncBoundary: new FakeGitSyncBoundary(),
      escalationAttempts: 2,
      now: () => NOW_MS,
      sleepFn: () => Promise.resolve(),
    });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result.reason).toBe('escalation-ineffective');
    // 3 Ziele × 2 Versuche + Terminierungs-Runde — großzügige, aber HARTE Schranke.
    expect(runs).toBeLessThanOrEqual(3 * 2 + 2);
  }, 15000);
});

// ── DrainAbortRegistry (drain-stop-control AC1) ──────────────────────────────

describe('DrainAbortRegistry (drain-stop-control AC1)', () => {
  it('register/signal/isAborted/unregister — Treffer nur bei aktivem Eintrag', () => {
    const registry = new DrainAbortRegistry();
    const handle = createAbortHandle();
    expect(registry.signal('unknown')).toBe(false);

    registry.register('d-1', handle);
    expect(registry.isAborted('d-1')).toBe(false);
    expect(registry.signal('d-1')).toBe(true);
    expect(registry.isAborted('d-1')).toBe(true);
    expect(handle.isAborted()).toBe(true);

    registry.unregister('d-1');
    expect(registry.signal('d-1')).toBe(false);
    expect(registry.isAborted('d-1')).toBe(false);
  });
});

// ── Kooperativer Abbruch in der Drain-Schleife (AC2) ─────────────────────────

describe('drainProject({ abortSignal }) — kooperativer Abbruch (drain-stop-control AC2)', () => {
  it('gesetztes Signal beendet die Schleife am Rundenanfang mit reason "aborted"; Lock frei', async () => {
    const handle = createAbortHandle();
    const stories = [makeStory('S-1')];
    const { boardAggregator } = makeDualSourceBoard({ workingTreeStories: stories, refStories: stories });
    const lock = new ProjectJobLock();
    let runs = 0;
    const drain = new ProjectDrain({
      boardAggregator,
      flowRunner: {
        startRun() {
          runs += 1;
          // Abbruch WÄHREND der laufenden Runde signalisieren — die Runde
          // läuft zu Ende (A1), der Rundenanfang der Folge-Runde greift.
          handle.abort();
          return { ok: true, handle: {} };
        },
        async awaitCompletion() {
          return { status: 'done' };
        },
      },
      lock,
      gitReadBoundary: new FakeGitReadBoundary({ fetchResult: { ok: true, fetched: false } }),
      gitSyncBoundary: new FakeGitSyncBoundary(),
      now: () => NOW_MS,
      sleepFn: () => Promise.resolve(),
    });

    const result = await drain.drainProject(PROJECT_PATH, { abortSignal: handle });

    expect(result.reason).toBe('aborted');
    expect(result.stopped).toBe(true);
    expect(runs).toBe(1); // die laufende Runde wurde zu Ende geführt, keine weitere gestartet
    expect(lock.isHeld(PROJECT_PATH)).toBe(false);
  }, 15000);
});

// ── DrainJobRegistry: aborted terminal (AC4/AC5/AC6) ─────────────────────────

describe('DrainJobRegistry — aborted ist terminal (drain-stop-control AC4/AC5/AC6)', () => {
  it('markAborted setzt terminal; markDone/markFailed überschreiben nie', () => {
    const registry = new DrainJobRegistry();
    registry.register('d-1', { project: 'my-project', trigger: 'manual' });
    registry.markAborted('d-1');
    expect(registry.getJob('d-1').status).toBe('aborted');

    registry.markDone('d-1', { reason: 'no-drain-target' });
    expect(registry.getJob('d-1').status).toBe('aborted');
    registry.markFailed('d-1');
    expect(registry.getJob('d-1').status).toBe('aborted');
  });

  it('markDone mit result.reason "aborted" hält den Status aborted (nie done)', () => {
    const registry = new DrainJobRegistry();
    registry.register('d-2', { project: 'my-project', trigger: 'night' });
    registry.markDone('d-2', { reason: 'aborted', flowRuns: 1 });
    expect(registry.getJob('d-2').status).toBe('aborted');
  });

  it('reconcileOrphans() gibt aborted-Einträge NICHT als Orphan zurück (kein Boot-Wiederanlauf, AC6)', () => {
    const registry = new DrainJobRegistry();
    registry.register('d-stopped', { project: 'my-project', trigger: 'manual' });
    registry.markAborted('d-stopped');
    registry.register('d-crashed', { project: 'other', trigger: 'manual' });

    const orphans = registry.reconcileOrphans();

    const ids = orphans.map((o) => o.drainId);
    expect(ids).toContain('d-crashed'); // echter running-Orphan → Recovery
    expect(ids).not.toContain('d-stopped'); // bewusst gestoppt → KEIN Wiederanlauf
  });
});

// ── Stop-Endpunkt (AC3/AC4) ──────────────────────────────────────────────────

describe('POST /api/projects/:slug/drain/:drainId/stop (drain-stop-control AC3/AC4)', () => {
  function makeApp({ abortRegistry, jobRegistry } = {}) {
    const app = express();
    app.use(express.json());
    app.use(
      projectDrainRouter(
        {
          projectDrain: { drainProject: async () => ({ stopped: true, reason: 'no-drain-target', flowRuns: 0 }) },
          commandService: { getStatus: () => ({ status: 'idle' }) },
          sessionRegistry: { hasSession: () => false },
          abortRegistry,
        },
        {
          slugResolver: (slug) => (slug === 'my-project' ? PROJECT_PATH : null),
          pathValidator: async (p) => ({ resolvedPath: p }),
          jobRegistry,
        },
      ),
    );
    return app;
  }

  function request(app, method, path) {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, async () => {
        const port = server.address().port;
        try {
          const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
          const body = await res.json().catch(() => null);
          resolve({ status: res.status, body });
        } catch (err) {
          reject(err);
        } finally {
          server.close();
        }
      });
    });
  }

  it('202 + Registry-Eintrag aborted bei aktivem Drain; Signal gesetzt', async () => {
    const abortRegistry = new DrainAbortRegistry();
    const jobRegistry = new DrainJobRegistry();
    const handle = createAbortHandle();
    abortRegistry.register('d-live', handle);
    jobRegistry.register('d-live', { project: 'my-project', trigger: 'manual' });

    const res = await request(makeApp({ abortRegistry, jobRegistry }), 'POST', '/api/projects/my-project/drain/d-live/stop');

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ drainId: 'd-live', status: 'aborting' });
    expect(handle.isAborted()).toBe(true);
    expect(jobRegistry.getJob('d-live').status).toBe('aborted');
  });

  it('404 bei unbekannter/fertiger drainId; 400 bei ungültigem Slug', async () => {
    const abortRegistry = new DrainAbortRegistry();
    const app = makeApp({ abortRegistry, jobRegistry: new DrainJobRegistry() });

    const notFound = await request(app, 'POST', '/api/projects/my-project/drain/gone/stop');
    expect(notFound.status).toBe(404);

    const badSlug = await request(app, 'POST', '/api/projects/unknown/drain/x/stop');
    expect(badSlug.status).toBe(400);
  });
});

// ── Nacht-Drain-Teilnahme (AC8) ──────────────────────────────────────────────

describe('NightWatchScheduler — Abort-Handle-Registrierung (drain-stop-control AC8)', () => {
  it('registriert je Nacht-Drain ein Handle unter der drainId und reicht abortSignal durch', async () => {
    const registered = [];
    const abortRegistry = {
      register: (drainId, handle) => registered.push({ drainId, handle }),
      unregister: jest.fn(),
    };
    const drainCalls = [];
    const scheduler = new NightWatchScheduler({
      readSettings: async () => ({
        enabled: true,
        window: { start: '22:00', end: '06:00', timezone: 'Europe/Zurich' },
        intervalMinutes: 15,
        maxParallel: 3,
        projects: 'all',
      }),
      boardAggregator: {
        getIndex: async () => [{ project_slug: 'proj-a', repo_path: '/workspace/proj-a', error: undefined }],
      },
      projectDrain: {
        drainProject: async (path, opts) => {
          drainCalls.push({ path, opts });
          return { stopped: true, reason: 'no-drain-target', flowRuns: 0, escalated: [] };
        },
      },
      drainJobRegistry: new DrainJobRegistry(),
      abortRegistry,
      now: () => Date.UTC(2026, 0, 15, 23, 30), // 00:30 CET — im Nachtfenster
      sleepFn: () => Promise.resolve(),
    });

    await scheduler.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(drainCalls).toHaveLength(1);
    expect(registered).toHaveLength(1);
    expect(typeof registered[0].drainId).toBe('string');
    expect(drainCalls[0].opts.abortSignal).toBe(registered[0].handle);
  });
});

// ── Vorbedingungs-Sync (drain-clone-precondition-sync AC2/AC3/AC4/AC5) ───────

describe('drainProject — Vorbedingungs-Sync des Klons (drain-clone-precondition-sync)', () => {
  function makeSyncDrain({ gitSyncBoundary, fetchResult = { ok: true, fetched: true } }) {
    const stories = [makeStory('S-1', { status: 'Done' })]; // keine Targets → schnelles reguläres Ende
    const { boardAggregator } = makeDualSourceBoard({ workingTreeStories: stories, refStories: stories });
    const auditStore = new FakeAuditStore();
    const drain = new ProjectDrain({
      boardAggregator,
      flowRunner: makeFruitlessFlowRunner(),
      lock: new ProjectJobLock(),
      auditStore,
      gitReadBoundary: new FakeGitReadBoundary({ fetchResult }),
      gitSyncBoundary,
      now: () => NOW_MS,
      sleepFn: () => Promise.resolve(),
    });
    return { drain, auditStore };
  }

  it('AC2: eigene Taktgeber-Artefakte werden bereinigt (checkout NUR dieser Dateien), fremde nie', async () => {
    const sync = new FakeGitSyncBoundary({
      statusEntries: [
        [
          { code: ' M', relPath: 'board/stories/S-389.yaml' },
          { code: ' M', relPath: 'src/foo.js' },
        ],
        [{ code: ' M', relPath: 'src/foo.js' }], // nach Bereinigung: fremder Rest
      ],
      diffs: { 'board/stories/S-389.yaml': TAKTGEBER_DIFF },
    });
    const { drain, auditStore } = makeSyncDrain({ gitSyncBoundary: sync });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(sync.checkoutCalls).toEqual(['board/stories/S-389.yaml']); // NIE src/foo.js
    // fremder Rest → clone-dirty (AC3), kein Flow-Anstoß.
    expect(result.reason).toBe('clone-dirty');
    expect(result.flowRuns).toBe(0);
    const dirtyAudit = auditStore.entries.find((e) => e.command.includes('outcome=clone-dirty'));
    expect(dirtyAudit).toBeDefined();
    expect(dirtyAudit.command).toContain('src/foo.js'); // Repo-relativer Pfad im Audit
    expect(dirtyAudit.command).not.toContain('/workspace/'); // kein Host-Absolutpfad
  });

  it('AC4: nicht ff-baubar → reason "clone-diverged", kein Flow-Anstoß', async () => {
    const sync = new FakeGitSyncBoundary({ statusEntries: [], ffOk: false });
    const { drain } = makeSyncDrain({ gitSyncBoundary: sync });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result.reason).toBe('clone-diverged');
    expect(result.flowRuns).toBe(0);
    expect(sync.mergeCalls).toEqual(['origin/main']);
  });

  it('AC1/AC4: sauberer Klon + origin voraus → ff-merge, Drain läuft regulär weiter', async () => {
    const sync = new FakeGitSyncBoundary({ statusEntries: [], ffOk: true });
    const stories = [makeStory('S-1', { status: 'Done' })];
    const { boardAggregator } = makeDualSourceBoard({ workingTreeStories: stories, refStories: stories });
    const auditStore = new FakeAuditStore();
    const drain = new ProjectDrain({
      boardAggregator,
      flowRunner: makeFruitlessFlowRunner(),
      lock: new ProjectJobLock(),
      auditStore,
      gitReadBoundary: new FakeGitReadBoundary({
        fetchResult: { ok: true, fetched: true },
        truthRef: { ahead: true, ref: 'origin/main' },
      }),
      gitSyncBoundary: sync,
      now: () => NOW_MS,
      sleepFn: () => Promise.resolve(),
    });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(sync.mergeCalls).toEqual(['origin/main']);
    expect(result.reason).toBe('no-drain-target'); // regulärer Weiterlauf nach Sync
    expect(auditStore.entries.some((e) => e.command.includes('outcome=synced-ff'))).toBe(true);
  });

  it('AC5: kein Remote → No-Op-Sync, Drain läuft normal (kein Write)', async () => {
    const sync = new FakeGitSyncBoundary();
    const { drain, auditStore } = makeSyncDrain({
      gitSyncBoundary: sync,
      fetchResult: { ok: true, fetched: false },
    });

    const result = await drain.drainProject(PROJECT_PATH);

    expect(result.reason).toBe('no-drain-target');
    expect(sync.checkoutCalls).toEqual([]);
    expect(sync.mergeCalls).toEqual([]);
    expect(auditStore.entries.some((e) => e.command.includes('outcome=no-remote'))).toBe(true);
  });
});
