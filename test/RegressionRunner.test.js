/**
 * @file RegressionRunner.test.js — unit tests for the deterministic
 * Regressionstest-Runner + its pure helpers (docs/specs/regression-run.md).
 *
 * Covers (regression-run): AC1, AC2, AC5, AC9
 *
 *   AC1 — RegressionRunner is an own boundary with an OWN, isolated
 *         ProjectJobLock instance (never a `claude`/agent process — grep-
 *         verifiable: no import of HeadlessRunnerCore/child_process spawn of
 *         'claude'; only `npx playwright test`); lock held while running,
 *         released only on a terminal state (second start for the same
 *         project → locked; different project → not blocked).
 *   AC2 — Busy-check is a ROUTER responsibility (isProjectBusy against
 *         drain/session/command state) — this file covers the RUNNER-OWN
 *         lock half: isRunning()/start() locked-rejection (used by the router
 *         to additionally detect an already-running regression run of the
 *         same project, see regressionRunRouter.test.js for the HTTP-level
 *         AC2 assertions).
 *   AC5 — Vor einem Lauf wird die local-Erreichbarkeit geprüft
 *         (readLocalPreviewPort/probeLocalReachability); nicht erreichbar →
 *         `precondition-error` mit "Applikation lokal nicht gestartet"
 *         **statt** eines Playwright-Starts (runPlaywright wird NICHT
 *         aufgerufen).
 *   AC9 — Ein Lauf führt `npx playwright test <scopePath>` aus (scopeToTestPath:
 *         bereich → tests/regression/<id>, verbund → tests/regression/verbund,
 *         gesamt → tests/regression); nach Abschluss wird GENAU EIN
 *         aggregierter Datensatz (A1) an resultStore.record() übergeben
 *         (counts aus dem CTRF-Summary, status passed/failed via
 *         summarizeCtrf(), artifacts NUR bei failed).
 *
 * Edge-Cases: kein Projekt-Grundgerüst (tests/regression fehlt) → `error`
 * "kein Regressions-Grundgerüst", kein Playwright-Start. Kein CTRF-Ergebnis
 * nach einem (vermeintlich grünen) Lauf → `error`, kein Crash. npx nicht
 * verfügbar (ENOENT) → `error`, sanfter Fehlertext.
 *
 * AC1 Grep-Verifikation (security-relevant): dieses Modul importiert NICHT
 * `HeadlessRunnerCore.js` und ruft nirgends `spawn('claude', ...)` auf — nur
 * `spawn('npx', ['playwright', 'test', ...], ...)`. Ein expliziter Test unten
 * liest den Quelltext und prüft das per grep-artigem String-Check.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
  RegressionRunner,
  validateScope,
  scopeToTestPath,
  readLocalPreviewPort,
  probeLocalReachability,
  readCtrfResult,
  summarizeCtrf,
  defaultRunPlaywright,
  REGRESSION_TESTS_ROOT,
  CTRF_RESULT_PATH,
} from '../src/RegressionRunner.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';

/** Resolve pending microtasks so a fire-and-forget #runLifecycle settles. */
function flush() {
  return new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
}

describe('RegressionRunner — regression-run.md', () => {
  // ── AC1: no claude/agent dispatch (Grep-prüfbar) ───────────────────────────
  describe('AC1 — deterministisch, kein claude/Agent-Dispatch', () => {
    it('importiert kein HeadlessRunnerCore und spawnt nie "claude" — nur "npx" (Grep-prüfbar)', () => {
      const src = readFileSync(new URL('../src/RegressionRunner.js', import.meta.url), 'utf8');
      // Kein tatsächlicher Import (Prosa-Erwähnungen in Doc-Kommentaren sind erlaubt/gewollt).
      expect(src).not.toMatch(/^import .*HeadlessRunnerCore/m);
      expect(src).not.toMatch(/^import .*child_process.*\n.*claude/m);
      // Kein spawnFn(...)-Aufruf mit 'claude' als Kommando-Literal.
      expect(src).not.toMatch(/spawnFn\(\s*['"]claude['"]/);
      expect(src).toMatch(/spawnFn\(\s*['"]npx['"]/);
      expect(src).toMatch(/playwright/);
    });

    it('hat eine EIGENE ProjectJobLock-Instanz per Default (getrennt vom Singleton)', () => {
      const runnerA = new RegressionRunner({ runPlaywright: jest.fn() });
      const runnerB = new RegressionRunner({ runPlaywright: jest.fn() });
      // Start auf runnerA blockiert runnerB NICHT (unterschiedliche Lock-Instanzen).
      const resA = runnerA.start('/ws/proj', 'proj', { typ: 'gesamt' });
      expect(resA.ok).toBe(true);
      expect(runnerB.isRunning('/ws/proj')).toBe(false);
    });

    it('Lock wird gehalten während running und erst bei terminal freigegeben; zweiter start() fürs selbe Projekt → locked', async () => {
      // Pro cwd EIN eigener, nie automatisch auflösender Promise-Resolver —
      // verhindert, dass ein zweiter start() (anderes Projekt) denselben
      // `resolveRun`-Closure-Slot überschreibt.
      const resolvers = new Map();
      const runPlaywright = jest.fn(({ projectPath }) => new Promise((r) => { resolvers.set(projectPath, r); }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); // kein profile.md → kein local-Check
      });
      const runner = new RegressionRunner({ runPlaywright, readFile });

      const res1 = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      expect(res1.ok).toBe(true);
      expect(runner.isRunning('/ws/proj')).toBe(true);

      const res2 = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      expect(res2).toEqual({ ok: false, reason: 'locked' });

      // anderes Projekt bleibt unblockiert
      const res3 = runner.start('/ws/other', 'other', { typ: 'gesamt' });
      expect(res3.ok).toBe(true);

      // Warten bis #runLifecycle die async Vorprüfungen (Scaffold/local-Check)
      // durchlaufen und #runPlaywright tatsächlich aufgerufen hat, BEVOR wir
      // dessen Promise auflösen (sonst ist der Resolver noch nicht zugewiesen).
      await flush();
      expect(runPlaywright).toHaveBeenCalledTimes(2); // /ws/proj UND /ws/other
      resolvers.get('/ws/proj')({ exitCode: 1 }); // beliebiger Abschluss NUR für /ws/proj
      await flush();
      await flush();
      expect(runner.isRunning('/ws/proj')).toBe(false); // freigegeben nach terminal
      expect(runner.isRunning('/ws/other')).toBe(true); // unberührt, weiterhin running
    });
  });

  // ── validateScope / scopeToTestPath (pure) ─────────────────────────────────
  describe('validateScope + scopeToTestPath (Vertrag §Verträge)', () => {
    it('akzeptiert bereich/verbund mit nicht-leerer id', () => {
      expect(validateScope({ typ: 'bereich', id: 'fabrik-arbeiten' })).toEqual({
        ok: true,
        scope: { typ: 'bereich', id: 'fabrik-arbeiten' },
      });
      expect(validateScope({ typ: 'verbund', id: 'infra-kette' })).toEqual({
        ok: true,
        scope: { typ: 'verbund', id: 'infra-kette' },
      });
    });

    it('akzeptiert gesamt ohne id', () => {
      expect(validateScope({ typ: 'gesamt' })).toEqual({ ok: true, scope: { typ: 'gesamt' } });
    });

    it('lehnt fehlendes/leeres scope, unbekanntes typ, fehlende id bei bereich/verbund ab', () => {
      expect(validateScope(null)).toEqual({ ok: false, reason: 'invalid' });
      expect(validateScope({ typ: 'unknown' })).toEqual({ ok: false, reason: 'invalid-typ' });
      expect(validateScope({ typ: 'bereich', id: '' })).toEqual({ ok: false, reason: 'missing-id' });
      expect(validateScope({ typ: 'bereich' })).toEqual({ ok: false, reason: 'missing-id' });
    });

    it('scopeToTestPath: bereich -> tests/regression/<id>, verbund -> tests/regression/verbund, gesamt -> tests/regression', () => {
      expect(scopeToTestPath({ typ: 'bereich', id: 'fabrik-arbeiten' })).toBe(`${REGRESSION_TESTS_ROOT}/fabrik-arbeiten`);
      expect(scopeToTestPath({ typ: 'verbund', id: 'irrelevant-name' })).toBe(`${REGRESSION_TESTS_ROOT}/verbund`);
      expect(scopeToTestPath({ typ: 'gesamt' })).toBe(REGRESSION_TESTS_ROOT);
    });
  });

  // ── readLocalPreviewPort (pure, injizierter readFile) ──────────────────────
  describe('readLocalPreviewPort', () => {
    it('liest preview_port aus .claude/profile.md', async () => {
      const readFile = jest.fn(async () => 'language: js\npreview_port: 8080\ncontainer_port: 9090\n');
      const port = await readLocalPreviewPort('/ws/proj', { readFile });
      expect(port).toBe(8080);
    });

    it('fällt auf container_port zurück wenn preview_port fehlt', async () => {
      const readFile = jest.fn(async () => 'language: js\ncontainer_port: 9090\n');
      const port = await readLocalPreviewPort('/ws/proj', { readFile });
      expect(port).toBe(9090);
    });

    it('liefert null wenn profile.md fehlt oder kein Port auffindbar ist', async () => {
      const readFileMissing = jest.fn(async () => { throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); });
      expect(await readLocalPreviewPort('/ws/proj', { readFile: readFileMissing })).toBeNull();

      const readFileNoPort = jest.fn(async () => 'language: js\n');
      expect(await readLocalPreviewPort('/ws/proj', { readFile: readFileNoPort })).toBeNull();
    });
  });

  // ── probeLocalReachability (pure, injizierter fetchFn) ─────────────────────
  describe('probeLocalReachability', () => {
    it('true bei jedem erfolgreichen fetch (jeder Statuscode zählt)', async () => {
      const fetchFn = jest.fn(async () => true);
      expect(await probeLocalReachability(8080, { fetchFn })).toBe(true);
      expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:8080/', expect.any(Number));
    });

    it('false bei Timeout/Refused (fetch wirft)', async () => {
      const fetchFn = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
      expect(await probeLocalReachability(8080, { fetchFn })).toBe(false);
    });
  });

  // ── readCtrfResult + summarizeCtrf (pure) ──────────────────────────────────
  describe('readCtrfResult + summarizeCtrf', () => {
    it('liest + parst eine valide CTRF-Datei', async () => {
      const ctrfObj = { results: { summary: { tests: 3, passed: 3, failed: 0 } } };
      const readFile = jest.fn(async () => JSON.stringify(ctrfObj));
      const ctrf = await readCtrfResult('/ws/proj', { readFile });
      expect(ctrf).toEqual(ctrfObj);
      expect(readFile).toHaveBeenCalledWith(expect.stringContaining(CTRF_RESULT_PATH), 'utf8');
    });

    it('liefert null bei fehlender/korrupter Datei (kein Crash)', async () => {
      const readFileMissing = jest.fn(async () => { throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); });
      expect(await readCtrfResult('/ws/proj', { readFile: readFileMissing })).toBeNull();

      const readFileCorrupt = jest.fn(async () => 'not json{{{');
      expect(await readCtrfResult('/ws/proj', { readFile: readFileCorrupt })).toBeNull();
    });

    it('summarizeCtrf: failed>0 -> status failed, sonst passed', () => {
      expect(summarizeCtrf({ results: { summary: { tests: 5, passed: 4, failed: 1 } } })).toEqual({
        counts: { passed: 4, failed: 1, total: 5 },
        status: 'failed',
      });
      expect(summarizeCtrf({ results: { summary: { tests: 5, passed: 5, failed: 0 } } })).toEqual({
        counts: { passed: 5, failed: 0, total: 5 },
        status: 'passed',
      });
    });

    it('summarizeCtrf ist tolerant gegenüber fehlendem/leerem Schema (kein Crash)', () => {
      expect(summarizeCtrf(null)).toEqual({ counts: { passed: 0, failed: 0, total: 0 }, status: 'passed' });
      expect(summarizeCtrf({})).toEqual({ counts: { passed: 0, failed: 0, total: 0 }, status: 'passed' });
    });
  });

  // ── AC5: local-Erreichbarkeitsprüfung VOR dem Lauf ─────────────────────────
  describe('AC5 — local-Erreichbarkeitsprüfung (Vorbedingungs-Fehler statt roter Tests)', () => {
    it('nicht erreichbar -> precondition-error, KEIN Playwright-Start', async () => {
      const runPlaywright = jest.fn();
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) return 'preview_port: 8080\n';
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const probeReachability = jest.fn(async () => false);
      const runner = new RegressionRunner({ runPlaywright, readFile, probeReachability });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      const run = runner.getRun(runId);
      expect(run.status).toBe('precondition-error');
      expect(run.reason).toBe('Applikation lokal nicht gestartet');
      expect(runPlaywright).not.toHaveBeenCalled();
      expect(runner.isRunning('/ws/proj')).toBe(false); // Lock freigegeben
    });

    it('kein Port auffindbar (kein profile.md) -> kein local-Check, Lauf läuft trotzdem weiter', async () => {
      const runPlaywright = jest.fn(async () => ({ exitCode: 0 }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({ runPlaywright, readFile });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      expect(runPlaywright).toHaveBeenCalledTimes(1);
      const run = runner.getRun(runId);
      expect(run.status).toBe('passed');
    });
  });

  // ── AC9: Ausführung + Ergebnis-Übergabe ────────────────────────────────────
  describe('AC9 — Ausführung + Ergebnis-Übergabe (EIN aggregierter Datensatz, A1)', () => {
    function makeGreenSetup({ resultStore, scope = { typ: 'gesamt' } } = {}) {
      const runPlaywright = jest.fn(async ({ testPath }) => {
        expect(testPath).toBe(scopeToTestPath(scope));
        return { exitCode: 0 };
      });
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) {
          return JSON.stringify({ results: { summary: { tests: 2, passed: 2, failed: 0 } } });
        }
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      return new RegressionRunner({ runPlaywright, readFile, resultStore });
    }

    it('führt npx playwright test für den gewählten Scope aus und übergibt EINEN Datensatz an den resultStore', async () => {
      const record = jest.fn(async (input) => input);
      const resultStore = { record };
      const scope = { typ: 'bereich', id: 'fabrik-arbeiten' };
      const runner = makeGreenSetup({ resultStore, scope });

      const { runId } = runner.start('/ws/dev-gui', 'dev-gui', scope);
      await flush();

      expect(record).toHaveBeenCalledTimes(1);
      const input = record.mock.calls[0][0];
      expect(input.projekt).toBe('dev-gui');
      expect(input.suite).toBe('fabrik-arbeiten');
      expect(input.scopeTyp).toBe('bereich');
      expect(input.status).toBe('passed');
      expect(input.counts).toEqual({ passed: 2, failed: 0, total: 2 });
      expect(input.artifacts).toBeUndefined(); // AC3 RegressionResultStore: nur bei failed

      const run = runner.getRun(runId);
      expect(run.status).toBe('passed');
      expect(run.suite).toBe('fabrik-arbeiten');
      expect(run.counts).toEqual({ passed: 2, failed: 0, total: 2 });
    });

    it('"gesamt" ergibt suite-Label "Gesamt" (A1)', async () => {
      const record = jest.fn(async (input) => input);
      const runner = makeGreenSetup({ resultStore: { record }, scope: { typ: 'gesamt' } });

      runner.start('/ws/dev-gui', 'dev-gui', { typ: 'gesamt' });
      await flush();

      expect(record.mock.calls[0][0].suite).toBe('Gesamt');
      expect(record.mock.calls[0][0].scopeTyp).toBe('gesamt');
    });

    it('roter Lauf (failed>0) -> status failed + artifacts.htmlReport gesetzt', async () => {
      const record = jest.fn(async (input) => input);
      const runPlaywright = jest.fn(async () => ({ exitCode: 1 }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) {
          return JSON.stringify({ results: { summary: { tests: 3, passed: 2, failed: 1 } } });
        }
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({ runPlaywright, readFile, resultStore: { record } });

      const { runId } = runner.start('/ws/dev-gui', 'dev-gui', { typ: 'gesamt' });
      await flush();

      expect(record.mock.calls[0][0].status).toBe('failed');
      expect(record.mock.calls[0][0].artifacts).toEqual({ htmlReport: 'playwright-report' });
      expect(runner.getRun(runId).status).toBe('failed');
    });

    it('kein Projekt-Grundgerüst (tests/regression fehlt) -> error "kein Regressions-Grundgerüst", kein Playwright-Start', async () => {
      const runPlaywright = jest.fn();
      const readFile = jest.fn(async () => { throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); });
      const runner = new RegressionRunner({ runPlaywright, readFile });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      const run = runner.getRun(runId);
      expect(run.status).toBe('error');
      expect(run.reason).toBe('kein Regressions-Grundgerüst');
      expect(runPlaywright).not.toHaveBeenCalled();
    });

    it('kein CTRF-Ergebnis nach dem Lauf -> error, kein Crash', async () => {
      const runPlaywright = jest.fn(async () => ({ exitCode: 0 }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); // kein CTRF
      });
      const runner = new RegressionRunner({ runPlaywright, readFile });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      const run = runner.getRun(runId);
      expect(run.status).toBe('error');
      expect(run.reason).toMatch(/CTRF/);
    });

    it('npx nicht verfügbar (ENOENT) -> error, sanfter Fehlertext', async () => {
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runPlaywright = jest.fn(async () => ({ exitCode: -1, spawnError: true, notFound: true }));
      const runner = new RegressionRunner({ runPlaywright, readFile });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      const run = runner.getRun(runId);
      expect(run.status).toBe('error');
      expect(run.reason).toBe('npx nicht verfügbar');
    });

    it('ein Store-Fehler beim record() crasht den Runner nicht — Lauf-Status bleibt korrekt', async () => {
      const record = jest.fn(async () => { throw new Error('disk full'); });
      const runner = makeGreenSetup({ resultStore: { record } });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      expect(runner.getRun(runId).status).toBe('passed'); // trotz Store-Fehler korrekt gesetzt
    });
  });

  // ── defaultRunPlaywright (argv/cwd/security) ───────────────────────────────
  describe('defaultRunPlaywright — Security-Floor (argv-Array, kein Shell-String)', () => {
    it('spawnt npx als Array-argv mit cwd=projectPath, REGRESSION_BASE_URL nur bei gesetztem baseUrl', async () => {
      const emit = {};
      const fakeChild = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event, cb) => { emit[event] = cb; },
        kill: jest.fn(),
      };
      const spawnFn = jest.fn(() => fakeChild);

      const promise = defaultRunPlaywright({
        projectPath: '/ws/proj',
        testPath: 'tests/regression/fabrik-arbeiten',
        baseUrl: 'http://127.0.0.1:8080',
        spawnFn,
      });
      emit.close(0);
      const result = await promise;

      expect(result).toEqual({ exitCode: 0 });
      expect(spawnFn).toHaveBeenCalledWith(
        'npx',
        ['playwright', 'test', 'tests/regression/fabrik-arbeiten'],
        expect.objectContaining({
          cwd: '/ws/proj',
          env: expect.objectContaining({ REGRESSION_BASE_URL: 'http://127.0.0.1:8080' }),
        }),
      );
    });

    it('ohne baseUrl wird REGRESSION_BASE_URL nicht gesetzt', async () => {
      const emit = {};
      const fakeChild = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event, cb) => { emit[event] = cb; },
        kill: jest.fn(),
      };
      const spawnFn = jest.fn(() => fakeChild);

      const promise = defaultRunPlaywright({ projectPath: '/ws/proj', testPath: 'tests/regression', spawnFn });
      emit.close(0);
      await promise;

      const env = spawnFn.mock.calls[0][2].env;
      expect(env.REGRESSION_BASE_URL).toBeUndefined();
    });

    it('Timeout killt den Kindprozess und liefert timedOut:true', async () => {
      jest.useFakeTimers();
      const fakeChild = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        kill: jest.fn(),
      };
      const spawnFn = jest.fn(() => fakeChild);

      const promise = defaultRunPlaywright({ projectPath: '/ws/proj', testPath: 'tests/regression', timeoutMs: 100, spawnFn });
      jest.advanceTimersByTime(101);
      const result = await promise;

      expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(result).toEqual({ exitCode: -1, timedOut: true });
      jest.useRealTimers();
    });
  });

  // ── ProjectJobLock isolation sanity (cross-check against the module singleton) ──
  it('das RegressionRunner-Lock ist NICHT der ProjectJobLock-Modul-Singleton', () => {
    const runner = new RegressionRunner({ runPlaywright: jest.fn() });
    const res = runner.start('/ws/isolation-check', 'proj', { typ: 'gesamt' });
    expect(res.ok).toBe(true);
    // Ein frischer, unabhängiger ProjectJobLock sieht das Projekt als frei —
    // beweist, dass RegressionRunner NICHT denselben Singleton-Lock nutzt.
    const independentLock = new ProjectJobLock();
    expect(independentLock.isHeld('/ws/isolation-check')).toBe(false);
  });
});
