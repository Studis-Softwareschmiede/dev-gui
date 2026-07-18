/**
 * @file RegressionRunner.test.js — unit tests for the deterministic
 * Regressionstest-Runner + its pure helpers (docs/specs/regression-run.md).
 *
 * Covers (regression-run): AC1, AC2, AC5, AC7, AC8, AC9, AC10, AC11, AC12
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
 *   AC7 — Frisch-Ausrollen: bei `freshRollout:true` + injizierter
 *         `dockerControl` + auffindbarem `image` in `.claude/profile.md` wird
 *         `dockerControl.pullAndRecreate()` VOR der Erreichbarkeitsprüfung
 *         aufgerufen (pull+recreate, s. LocalDockerControl.test.js für die
 *         "niemals restart"-Garantie); Pull-/Start-Fehler → `error`;
 *         Readiness-Timeout → `precondition-error`; ohne `dockerControl`
 *         oder ohne `image` degradiert der Runner auf die reine
 *         Erreichbarkeitsprüfung (kein Crash). `containerName` wird per
 *         `deriveContainerNameFromImage` aus dem letzten Segment von
 *         `rolloutConfig.image` abgeleitet und lowercased (agent-flow
 *         `/preview up`-Konvention, SKILL.md §Variablen) — NICHT aus dem
 *         rohen, case-erhaltenden `job.projekt`-Slug (Review-Fix Iteration 2:
 *         sonst trifft `pullAndRecreate` bei Repo-Namen mit Großbuchstaben am
 *         laufenden Preview-Container vorbei).
 *   AC8 — Selbsttest-Sonderfall (Projekt-Slug `dev-gui` via `isSelfProject`):
 *         `freshRollout:true` wird server-seitig HART ignoriert, wenn
 *         `projekt === 'dev-gui'` — `dockerControl.pullAndRecreate` wird NIE
 *         aufgerufen, auch nicht bei explizit gesetztem `freshRollout`.
 *   AC9 — Ein Lauf führt `npx playwright test <scopePath>` aus (scopeToTestPath:
 *         bereich → tests/regression/<id>, verbund → tests/regression/verbund,
 *         gesamt → tests/regression); nach Abschluss wird GENAU EIN
 *         aggregierter Datensatz (A1) an resultStore.record() übergeben
 *         (counts aus dem CTRF-Summary, status passed/failed via
 *         summarizeCtrf()). `artifactsSourceDir` wird IMMER (unabhängig vom
 *         Status) als `job.projectPath` mitgegeben — S-327: der Runner selbst
 *         baut keine `artifacts`-Referenz mehr, das entscheidet ausschließlich
 *         der `RegressionResultStore` (s. RegressionResultStore.test.js AC3).
 *   AC10 (S-326) — JEDER terminale Zustand (auch ein Frühausfall OHNE CTRF:
 *         kein Grundgerüst, precondition-error, Rollout-Fehler, kein CTRF,
 *         npx fehlt, nicht unterstütztes Testobjekt) übergibt strukturell
 *         GENAU EINEN Datensatz an resultStore.record() — `ctrf:null` (KEIN
 *         synthetisches Ersatz-CTRF), `counts:{0,0,0}`, `reason` gesetzt. Ein
 *         Store-Fehler verhindert den Lauf-Abschluss/die Lock-Freigabe nie.
 *   AC11 (S-326) — Testobjekt-Weiche: `target` wird über die injizierbare
 *         `readSuites`-Boundary (Default: `readRegressionSuites`) aufgelöst.
 *         `gesamt` → IMMER `local` (readSuites wird dafür NICHT aufgerufen).
 *         `bereich`/`verbund` mit deklariertem `target:"local"` → bestehender
 *         lokaler Pfad; `ephemeral-infra` → eigener Ausführungspfad (AC12,
 *         s.u.); `url`/unbekannter Wert → SOFORTIGER `error` „Testobjekt
 *         `<target>` wird noch nicht unterstützt" (nur bekannte Werte
 *         wörtlich in der Meldung, sonst generisch), OHNE Playwright-Start/
 *         local-Prüfung; kein deklariertes `target` (Suite nicht gefunden/
 *         Lesefehler) → konservativ `local`.
 *   AC12 (S-362) — `ephemeral-infra`-Ausführungspfad: der Lauf startet
 *         Playwright (KEINE local-Erreichbarkeitsprüfung, KEIN Frisch-
 *         Ausrollen — beides AC5/AC7-exklusiv für `local`), setzt aber
 *         `REGRESSION_BASE_URL` analog zum lokalen Pfad (dieselbe
 *         `readPort`-Auflösung), da bestehende `ephemeral-infra`-Suiten
 *         (`tests/regression/vps/*.spec.ts`) über die lokal laufende
 *         Applikation navigieren und ihr eigenes `rtest-*`-Wegwerf-Ziel
 *         SELBST provisionieren/abbauen (Fixture-Teardown, agent-flow
 *         `regression-playwright-conventions` AC4 — dev-gui definiert die
 *         Infra-Leitplanken nicht neu). Der Runner garantiert ZUSÄTZLICH
 *         (`finally`, unabhängig von passed/failed/error/Timeout) einen
 *         best-effort Sweep aller `rtest-*`-benannten Maschinen über die
 *         injizierte `vpsRegistry` (Sicherheitsnetz für den Fall, dass der
 *         Runner-eigene Timeout-Kill den In-Test-Teardown verhindert hat) —
 *         ohne injizierte `vpsRegistry` degradiert der Sweep auf No-op.
 *
 * Edge-Cases: kein Projekt-Grundgerüst (tests/regression fehlt) → `error`
 * "kein Regressions-Grundgerüst", kein Playwright-Start. Kein CTRF-Ergebnis
 * nach einem (vermeintlich grünen) Lauf → `error`, kein Crash. npx nicht
 * verfügbar (ENOENT) → `error`, sanfter Fehlertext.
 *
 * Test-Fallstrick (verifiziert, .claude/lessons/tester.md 2026-07-06 +
 * Story-Notiz S-326): die Suite-Lese-Boundary (`readSuites`) MUSS in JEDEM
 * Test, der einen `bereich`/`verbund`-Scope startet, hermetisch gemockt
 * werden (leere Suite-Liste → target 'local') — sonst macht die default
 * `readRegressionSuites` echtes Datei-IO gegen einen nicht existierenden
 * Test-Pfad, was den fire-and-forget-Lauf (nur über `flush()`/2
 * setImmediate-Ticks abgewartet) latent nichtdeterministisch macht. `gesamt`-
 * Scopes sind davon NICHT betroffen (die Weiche ruft `readSuites` für
 * `gesamt` gar nicht erst auf).
 *
 * AC1 Grep-Verifikation (security-relevant): dieses Modul importiert NICHT
 * `HeadlessRunnerCore.js` und ruft nirgends `spawn('claude', ...)` auf — nur
 * `spawn('npx', ['playwright', 'test', ...], ...)`. Ein expliziter Test unten
 * liest den Quelltext und prüft das per grep-artigem String-Check.
 *
 * Covers (regression-failed-notification.md, S-315) — Producer-Naht:
 *   AC2 — Ein injizierter `notifier.notifyRegressionFailed` wird GENAU EINMAL
 *         aufgerufen, wenn der Lauf mit `status:"failed"` (echte rote
 *         Testfälle, `summarizeCtrf()`) endet; bei `status:"passed"` NIE
 *         aufgerufen; bei `precondition-error`/`error` (kein Grundgerüst,
 *         kein CTRF, npx fehlt) NIE aufgerufen (diese Pfade erreichen
 *         `summarizeCtrf()` strukturell nicht).
 *   AC3 — `notifyRegressionFailed` wird mit `{projekt, suite, failed, total}`
 *         aus den CTRF-Zählern + dem Lauf-Kontext aufgerufen.
 *   Best-effort: ein werfender/rejectender `notifier.notifyRegressionFailed`
 *         lässt den Lauf-Abschluss (`#finish`/Lock-Freigabe/Store-Record)
 *         NICHT scheitern; ohne injizierten `notifier` (Default) kein Crash.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
  RegressionRunner,
  validateScope,
  scopeToTestPath,
  readLocalPreviewPort,
  readLocalRolloutConfig,
  deriveContainerNameFromImage,
  isSelfProject,
  SELF_PROJECT_SLUG,
  probeLocalReachability,
  readCtrfResult,
  summarizeCtrf,
  defaultRunPlaywright,
  buildUnsupportedTargetMessage,
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

  // ── readLocalRolloutConfig + isSelfProject (pure) ──────────────────────────
  describe('readLocalRolloutConfig', () => {
    it('liest image + container_port aus .claude/profile.md', async () => {
      const readFile = jest.fn(async () => 'image: ghcr.io/org/app\ncontainer_port: 8080\n');
      const cfg = await readLocalRolloutConfig('/ws/proj', { readFile });
      expect(cfg).toEqual({ image: 'ghcr.io/org/app', containerPort: 8080 });
    });

    it('liefert containerPort:null wenn container_port fehlt', async () => {
      const readFile = jest.fn(async () => 'image: ghcr.io/org/app\n');
      const cfg = await readLocalRolloutConfig('/ws/proj', { readFile });
      expect(cfg).toEqual({ image: 'ghcr.io/org/app', containerPort: null });
    });

    it('liefert null wenn kein image auffindbar ist oder profile.md fehlt', async () => {
      const readFileNoImage = jest.fn(async () => 'container_port: 8080\n');
      expect(await readLocalRolloutConfig('/ws/proj', { readFile: readFileNoImage })).toBeNull();

      const readFileMissing = jest.fn(async () => { throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); });
      expect(await readLocalRolloutConfig('/ws/proj', { readFile: readFileMissing })).toBeNull();
    });
  });

  describe('deriveContainerNameFromImage (AC7 — /preview up-Konvention: letztes Segment, lowercase)', () => {
    it('leitet das letzte Image-Segment lowercase ab (Großbuchstaben-Repo-Name)', () => {
      expect(deriveContainerNameFromImage('ghcr.io/studis-softwareschmiede/Sandbox-2')).toBe('sandbox-2');
    });

    it('bereits-lowercase Image bleibt unverändert', () => {
      expect(deriveContainerNameFromImage('ghcr.io/org/app')).toBe('app');
    });

    it('gemischter Case über mehrere Segmente — nur das letzte Segment zählt', () => {
      expect(deriveContainerNameFromImage('ghcr.io/Studis-Softwareschmiede/Spoon-Knife')).toBe('spoon-knife');
    });
  });

  describe('isSelfProject', () => {
    it('true für den dev-gui-Slug, false für alle anderen', () => {
      expect(isSelfProject(SELF_PROJECT_SLUG)).toBe(true);
      expect(isSelfProject('dev-gui')).toBe(true);
      expect(isSelfProject('some-other-project')).toBe(false);
    });
  });

  // ── AC7: Frisch-Ausrollen (pull + recreate VOR der Erreichbarkeitsprüfung) ─
  describe('AC7 — Frisch-Ausrollen', () => {
    function readFileWithProfile({ image = 'ghcr.io/org/app', containerPort = 8080, previewPort = 8080 } = {}) {
      return jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) {
          return `image: ${image}\ncontainer_port: ${containerPort}\npreview_port: ${previewPort}\n`;
        }
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) {
          return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        }
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
    }

    it('freshRollout:true + dockerControl -> pullAndRecreate() wird VOR der Erreichbarkeitsprüfung aufgerufen', async () => {
      const callOrder = [];
      const pullAndRecreate = jest.fn(async ({ image, containerName, hostPort, containerPort }) => {
        callOrder.push('pullAndRecreate');
        expect(image).toBe('ghcr.io/org/app');
        // containerName wird aus dem IMAGE abgeleitet (letztes Segment,
        // lowercase — /preview up-Konvention), NICHT aus dem job.projekt-Slug
        // ('dev-other'). Beide sind hier zufällig lowercase-only, s. eigener
        // Testfall unten für den entscheidenden Großbuchstaben-Fall.
        expect(containerName).toBe('app');
        expect(hostPort).toBe(8080);
        expect(containerPort).toBe(8080);
        return { ready: true, durationMs: 10 };
      });
      const probeReachability = jest.fn(async () => {
        callOrder.push('probeReachability');
        return true;
      });
      const runPlaywright = jest.fn(async () => ({ exitCode: 0 }));
      const runner = new RegressionRunner({
        runPlaywright,
        readFile: readFileWithProfile(),
        probeReachability,
        dockerControl: { pullAndRecreate },
      });

      const { runId } = runner.start('/ws/dev-other', 'dev-other', { typ: 'gesamt' }, { freshRollout: true });
      await flush();

      expect(pullAndRecreate).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['pullAndRecreate', 'probeReachability']);
      expect(runner.getRun(runId).status).toBe('passed');
    });

    it('containerName wird aus dem letzten Image-Segment lowercase abgeleitet — NICHT aus dem case-erhaltenden projekt-Slug (Review-Fix Iteration 2, /preview up-Konvention SKILL.md §Variablen)', async () => {
      // Repo/Slug mit Großbuchstaben ("Sandbox-2") — job.projekt trägt den
      // rohen, case-erhaltenden URL-/Board-Slug. Die Image-Referenz hat
      // ebenfalls ein gemischtes letztes Segment ("Sandbox-2"). Der
      // tatsächlich laufende Preview-Container heißt gemäß agent-flow
      // `/preview up` IMMER "sandbox-2" (tr 'A-Z' 'a-z') — pullAndRecreate()
      // MUSS also mit containerName:'sandbox-2' aufgerufen werden, sonst
      // trifft `docker rm -f` den bestehenden Container nicht (No-Op) und
      // `docker run --name` legt einen zweiten, parallelen Container an.
      const pullAndRecreate = jest.fn(async ({ containerName }) => {
        expect(containerName).toBe('sandbox-2');
        return { ready: true, durationMs: 10 };
      });
      const readFile = readFileWithProfile({ image: 'ghcr.io/studis-softwareschmiede/Sandbox-2' });
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile,
        probeReachability: jest.fn(async () => true),
        dockerControl: { pullAndRecreate },
      });

      // job.projekt ('Sandbox-2') bewusst NICHT lowercase — reproduziert den
      // case-erhaltenden rawSlug aus regressionRunRouter.js.
      const { runId } = runner.start('/ws/Sandbox-2', 'Sandbox-2', { typ: 'gesamt' }, { freshRollout: true });
      await flush();

      expect(pullAndRecreate).toHaveBeenCalledTimes(1);
      expect(runner.getRun(runId).status).toBe('passed');
    });

    it('freshRollout:false (Default) -> pullAndRecreate() wird NICHT aufgerufen', async () => {
      const pullAndRecreate = jest.fn(async () => ({ ready: true, durationMs: 1 }));
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile: readFileWithProfile(),
        probeReachability: jest.fn(async () => true),
        dockerControl: { pullAndRecreate },
      });

      runner.start('/ws/dev-other', 'dev-other', { typ: 'gesamt' });
      await flush();

      expect(pullAndRecreate).not.toHaveBeenCalled();
    });

    it('kein image in profile.md -> Frisch-Ausrollen best-effort übersprungen (kein Fehler, Lauf läuft weiter)', async () => {
      const pullAndRecreate = jest.fn();
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) return 'preview_port: 8080\n'; // kein image
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile,
        probeReachability: jest.fn(async () => true),
        dockerControl: { pullAndRecreate },
      });

      const { runId } = runner.start('/ws/dev-other', 'dev-other', { typ: 'gesamt' }, { freshRollout: true });
      await flush();

      expect(pullAndRecreate).not.toHaveBeenCalled();
      expect(runner.getRun(runId).status).toBe('passed');
    });

    it('ohne injizierte dockerControl -> Frisch-Ausrollen übersprungen, kein Crash', async () => {
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile: readFileWithProfile(),
        probeReachability: jest.fn(async () => true),
        // kein dockerControl injiziert
      });

      const { runId } = runner.start('/ws/dev-other', 'dev-other', { typ: 'gesamt' }, { freshRollout: true });
      await flush();

      expect(runner.getRun(runId).status).toBe('passed');
    });

    it('pullAndRecreate() wirft (Pull-/Start-Fehler) -> status error, KEIN Playwright-Start', async () => {
      const pullAndRecreate = jest.fn(async () => {
        const err = new Error('Pull fehlgeschlagen');
        err.errorClass = 'pull-failed';
        throw err;
      });
      const runPlaywright = jest.fn();
      const runner = new RegressionRunner({
        runPlaywright,
        readFile: readFileWithProfile(),
        dockerControl: { pullAndRecreate },
      });

      const { runId } = runner.start('/ws/dev-other', 'dev-other', { typ: 'gesamt' }, { freshRollout: true });
      await flush();

      const run = runner.getRun(runId);
      expect(run.status).toBe('error');
      expect(run.reason).toMatch(/Frisch-Ausrollen/);
      expect(runPlaywright).not.toHaveBeenCalled();
    });

    it('pullAndRecreate() liefert ready:false (Readiness-Timeout) -> precondition-error, KEIN Playwright-Start (Edge-Case)', async () => {
      const pullAndRecreate = jest.fn(async () => ({ ready: false, durationMs: 60000 }));
      const runPlaywright = jest.fn();
      const runner = new RegressionRunner({
        runPlaywright,
        readFile: readFileWithProfile(),
        dockerControl: { pullAndRecreate },
      });

      const { runId } = runner.start('/ws/dev-other', 'dev-other', { typ: 'gesamt' }, { freshRollout: true });
      await flush();

      const run = runner.getRun(runId);
      expect(run.status).toBe('precondition-error');
      expect(runPlaywright).not.toHaveBeenCalled();
    });
  });

  // ── AC8: Selbsttest-Sonderfall (dev-gui) ───────────────────────────────────
  describe('AC8 — Selbsttest-Sonderfall: Frisch-Ausrollen server-seitig hart übersprungen', () => {
    it('projekt === "dev-gui" + freshRollout:true -> pullAndRecreate() wird NIE aufgerufen', async () => {
      const pullAndRecreate = jest.fn(async () => ({ ready: true, durationMs: 1 }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) return 'image: ghcr.io/studis-softwareschmiede/dev-gui\ncontainer_port: 8080\npreview_port: 8080\n';
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile,
        probeReachability: jest.fn(async () => true),
        dockerControl: { pullAndRecreate },
      });

      // Edge-Case Spec §Edge-Cases: "Selbsttest mit aktivierter Frisch-
      // Ausrollen-Option (z.B. über direkten API-Aufruf)" -> serverseitig
      // ignoriert, unabhängig vom übergebenen freshRollout:true.
      const { runId } = runner.start('/ws/dev-gui', SELF_PROJECT_SLUG, { typ: 'gesamt' }, { freshRollout: true });
      await flush();

      expect(pullAndRecreate).not.toHaveBeenCalled();
      expect(runner.getRun(runId).status).toBe('passed'); // Lauf läuft trotzdem (gegen die laufende Instanz)
    });

    it('ein ANDERES Projekt mit demselben freshRollout:true ist NICHT betroffen (kein globaler Skip)', async () => {
      const pullAndRecreate = jest.fn(async () => ({ ready: true, durationMs: 1 }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) return 'image: ghcr.io/org/other\ncontainer_port: 8080\npreview_port: 8080\n';
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile,
        probeReachability: jest.fn(async () => true),
        dockerControl: { pullAndRecreate },
      });

      runner.start('/ws/other-project', 'other-project', { typ: 'gesamt' }, { freshRollout: true });
      await flush();

      expect(pullAndRecreate).toHaveBeenCalledTimes(1);
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
      // AC11-Weiche: hermetisch gemockte Suite-Lese-Boundary (leere Liste ->
      // target 'local' -> unverändertes Bestandsverhalten) — verhindert
      // echtes Datei-IO über die default readRegressionSuites (s. Datei-Header
      // Test-Fallstrick-Hinweis).
      const readSuites = jest.fn(async () => ({ suites: [] }));
      return new RegressionRunner({ runPlaywright, readFile, resultStore, readSuites });
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
      // S-327: der Runner selbst baut KEINE artifacts-Referenz mehr — er
      // übergibt nur den Projekt-Klon-Pfad, der Store entscheidet (AC3).
      expect(input.artifacts).toBeUndefined();
      expect(input.artifactsSourceDir).toBe('/ws/dev-gui');

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

    it('roter Lauf (failed>0) -> status failed + artifactsSourceDir gesetzt (S-327: Store entscheidet über artifacts)', async () => {
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
      expect(record.mock.calls[0][0].artifacts).toBeUndefined();
      expect(record.mock.calls[0][0].artifactsSourceDir).toBe('/ws/dev-gui');
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

  // ── regression-failed-notification AC2/AC3 (S-315): Producer-Naht ─────────
  describe('regression-failed-notification AC2/AC3 — notifier.notifyRegressionFailed Producer-Naht', () => {
    function makeRunner({ notifier, exitCode = 1, summary = { tests: 3, passed: 2, failed: 1 }, resultStore } = {}) {
      const runPlaywright = jest.fn(async () => ({ exitCode }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) {
          return JSON.stringify({ results: { summary } });
        }
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      // AC11-Weiche: hermetisch gemockte Suite-Lese-Boundary (s. makeGreenSetup oben).
      const readSuites = jest.fn(async () => ({ suites: [] }));
      return new RegressionRunner({
        runPlaywright,
        readFile,
        notifier,
        resultStore: resultStore ?? { record: jest.fn(async (i) => i) },
        readSuites,
      });
    }

    it('roter Lauf (status:"failed") ruft notifier.notifyRegressionFailed GENAU EINMAL mit {projekt,suite,failed,total}', async () => {
      const notifyRegressionFailed = jest.fn(async () => {});
      const runner = makeRunner({ notifier: { notifyRegressionFailed } });

      runner.start('/ws/dev-gui', 'dev-gui', { typ: 'bereich', id: 'fabrik-arbeiten' });
      await flush();

      expect(notifyRegressionFailed).toHaveBeenCalledTimes(1);
      expect(notifyRegressionFailed).toHaveBeenCalledWith({
        projekt: 'dev-gui',
        suite: 'fabrik-arbeiten',
        failed: 1,
        total: 3,
      });
    });

    it('grüner Lauf (status:"passed") ruft notifyRegressionFailed NIE auf', async () => {
      const notifyRegressionFailed = jest.fn(async () => {});
      const runner = makeRunner({
        notifier: { notifyRegressionFailed },
        exitCode: 0,
        summary: { tests: 2, passed: 2, failed: 0 },
      });

      runner.start('/ws/dev-gui', 'dev-gui', { typ: 'gesamt' });
      await flush();

      expect(notifyRegressionFailed).not.toHaveBeenCalled();
    });

    it('precondition-error (Applikation lokal nicht gestartet) ruft notifyRegressionFailed NIE auf', async () => {
      const notifyRegressionFailed = jest.fn(async () => {});
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) return 'preview_port: 4173\n';
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runPlaywright = jest.fn();
      const probeReachability = jest.fn(async () => false);
      const runner = new RegressionRunner({
        runPlaywright,
        readFile,
        probeReachability,
        notifier: { notifyRegressionFailed },
      });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      expect(runner.getRun(runId).status).toBe('precondition-error');
      expect(runPlaywright).not.toHaveBeenCalled();
      expect(notifyRegressionFailed).not.toHaveBeenCalled();
    });

    it('error (kein Projekt-Grundgerüst) ruft notifyRegressionFailed NIE auf', async () => {
      const notifyRegressionFailed = jest.fn(async () => {});
      const readFile = jest.fn(async () => { throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); });
      const runner = new RegressionRunner({ runPlaywright: jest.fn(), readFile, notifier: { notifyRegressionFailed } });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      expect(runner.getRun(runId).status).toBe('error');
      expect(notifyRegressionFailed).not.toHaveBeenCalled();
    });

    it('ein werfender/rejectender notifier.notifyRegressionFailed lässt den Lauf-Abschluss nicht scheitern', async () => {
      const notifyRegressionFailed = jest.fn(async () => { throw new Error('push kaputt'); });
      const record = jest.fn(async (i) => i);
      const runner = makeRunner({ notifier: { notifyRegressionFailed }, resultStore: { record } });

      const { runId } = runner.start('/ws/dev-gui', 'dev-gui', { typ: 'gesamt' });
      await flush();

      // Lauf schließt trotzdem korrekt ab (Lock frei, Store geschrieben, Status gesetzt).
      expect(runner.getRun(runId).status).toBe('failed');
      expect(record).toHaveBeenCalledTimes(1);
      expect(runner.isRunning('/ws/dev-gui')).toBe(false);
    });

    it('ohne injizierten notifier (Default) kein Crash bei rotem Lauf', async () => {
      const runner = makeRunner({}); // notifier undefined
      const { runId } = runner.start('/ws/dev-gui', 'dev-gui', { typ: 'gesamt' });
      await flush();
      expect(runner.getRun(runId).status).toBe('failed');
    });
  });

  // ── buildUnsupportedTargetMessage (pure, Datenhygiene AC11) ────────────────
  describe('buildUnsupportedTargetMessage — Datenhygiene (nur bekannte Werte wörtlich)', () => {
    it('bekannte Werte (aktuell: url) werden wörtlich in die Meldung übernommen', () => {
      expect(buildUnsupportedTargetMessage('url')).toBe('Testobjekt url wird noch nicht unterstützt');
    });

    it('"ephemeral-infra" ist seit AC12/S-362 kein unbekanntes Testobjekt mehr — hat aber keinen eigenen Eintrag in dieser Meldungs-Datenhygiene (der Wert läuft über #runEphemeralInfra, nicht über diese Funktion)', () => {
      expect(buildUnsupportedTargetMessage('ephemeral-infra')).toBe('Testobjekt wird noch nicht unterstützt');
    });

    it('ein unbekannter/roher Wert erzeugt eine generische Meldung (kein Fremd-String-Durchreichen)', () => {
      expect(buildUnsupportedTargetMessage('some-garbage-value')).toBe('Testobjekt wird noch nicht unterstützt');
      expect(buildUnsupportedTargetMessage(undefined)).toBe('Testobjekt wird noch nicht unterstützt');
    });
  });

  // ── AC11: Testobjekt-Weiche (target über readSuites, dieselbe Lese-Boundary) ──
  describe('AC11 — Testobjekt-Weiche (target)', () => {
    function readFileScaffoldOnly() {
      return jest.fn(async (p) => {
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); // kein profile.md -> kein local-Check
      });
    }

    it('"gesamt"-Scope ruft readSuites NIE auf und läuft IMMER über den local-Pfad (Bestandsverhalten, AC11 letzter Satz)', async () => {
      const readSuites = jest.fn(async () => ({ suites: [] }));
      const runPlaywright = jest.fn(async () => ({ exitCode: 0 }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({ runPlaywright, readFile, readSuites });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      expect(readSuites).not.toHaveBeenCalled();
      expect(runPlaywright).toHaveBeenCalledTimes(1);
      expect(runner.getRun(runId).status).toBe('passed');
    });

    it('bereich-Scope mit deklariertem target:"local" -> bestehender lokaler Pfad (Playwright läuft)', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'fabrik-arbeiten' }, label: 'fabrik-arbeiten', target: 'local' }],
      }));
      const runPlaywright = jest.fn(async () => ({ exitCode: 0 }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({ runPlaywright, readFile, readSuites });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'fabrik-arbeiten' });
      await flush();

      expect(readSuites).toHaveBeenCalledWith('/ws/proj');
      expect(runPlaywright).toHaveBeenCalledTimes(1);
      expect(runner.getRun(runId).status).toBe('passed');
    });

    it('verbund-Scope mit target:"url" -> sofortiger error mit dem deklarierten Wert in der Meldung', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'verbund' }, label: 'Verbund', target: 'url' }],
      }));
      const runPlaywright = jest.fn();
      const runner = new RegressionRunner({ runPlaywright, readFile: readFileScaffoldOnly(), readSuites });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'verbund', id: 'irrelevant' });
      await flush();

      const run = runner.getRun(runId);
      expect(run.status).toBe('error');
      expect(run.reason).toBe('Testobjekt url wird noch nicht unterstützt');
      expect(runPlaywright).not.toHaveBeenCalled();
    });

    it('ein unbekannter/roher target-Wert -> sofortiger error mit GENERISCHER Meldung (kein Fremd-String im reason)', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'fabrik-arbeiten' }, label: 'fabrik-arbeiten', target: 'irgendwas-kaputtes' }],
      }));
      const runPlaywright = jest.fn();
      const runner = new RegressionRunner({ runPlaywright, readFile: readFileScaffoldOnly(), readSuites });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'fabrik-arbeiten' });
      await flush();

      const run = runner.getRun(runId);
      expect(run.status).toBe('error');
      expect(run.reason).toBe('Testobjekt wird noch nicht unterstützt');
      expect(run.reason).not.toMatch(/irgendwas-kaputtes/);
      expect(run.target).toBeUndefined(); // Datenhygiene: kein unbekannter Rohwert im view
      expect(runPlaywright).not.toHaveBeenCalled();
    });

    it('kein deklariertes target (Suite nicht gefunden, leere Liste) -> konservativ local, Lauf läuft weiter', async () => {
      const readSuites = jest.fn(async () => ({ suites: [] }));
      const runPlaywright = jest.fn(async () => ({ exitCode: 0 }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({ runPlaywright, readFile, readSuites });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'unbekannter-bereich' });
      await flush();

      expect(runPlaywright).toHaveBeenCalledTimes(1);
      expect(runner.getRun(runId).status).toBe('passed');
    });

    it('readSuites wirft (Lesefehler) -> konservativ local, kein Crash', async () => {
      const readSuites = jest.fn(async () => { throw new Error('fs kaputt'); });
      const runPlaywright = jest.fn(async () => ({ exitCode: 0 }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({ runPlaywright, readFile, readSuites });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'x' });
      await flush();

      expect(runPlaywright).toHaveBeenCalledTimes(1);
      expect(runner.getRun(runId).status).toBe('passed');
    });

    it('ein nicht unterstütztes Testobjekt ruft notifyRegressionFailed NIE auf (regression-failed-notification AC2/AC3)', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'url' }],
      }));
      const notifyRegressionFailed = jest.fn(async () => {});
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(),
        readFile: readFileScaffoldOnly(),
        readSuites,
        notifier: { notifyRegressionFailed },
      });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
      await flush();

      expect(runner.getRun(runId).status).toBe('error');
      expect(notifyRegressionFailed).not.toHaveBeenCalled();
    });
  });

  // ── AC12: ephemeral-infra-Ausführungspfad (S-362) ──────────────────────────
  describe('AC12 — ephemeral-infra-Ausführungspfad (Playwright läuft, garantiertes Cleanup)', () => {
    function readFileScaffoldAndPort({ previewPort = 8080 } = {}) {
      return jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) return `preview_port: ${previewPort}\n`;
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
    }

    it('startet Playwright OHNE local-Erreichbarkeitsprüfung/Frisch-Ausrollen, setzt REGRESSION_BASE_URL analog local', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
      }));
      const runPlaywright = jest.fn(async ({ baseUrl, testPath }) => {
        expect(baseUrl).toBe('http://127.0.0.1:8080');
        expect(testPath).toBe('tests/regression/vps');
        return { exitCode: 0 };
      });
      const probeReachability = jest.fn(); // AC5: darf NIE aufgerufen werden
      const pullAndRecreate = jest.fn(); // AC7: darf NIE aufgerufen werden (lokal-exklusiv)
      const runner = new RegressionRunner({
        runPlaywright,
        readFile: readFileScaffoldAndPort(),
        readSuites,
        probeReachability,
        dockerControl: { pullAndRecreate },
      });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' }, { freshRollout: true });
      await flush();

      expect(runPlaywright).toHaveBeenCalledTimes(1);
      expect(probeReachability).not.toHaveBeenCalled();
      expect(pullAndRecreate).not.toHaveBeenCalled();
      const run = runner.getRun(runId);
      expect(run.status).toBe('passed');
      expect(run.target).toBe('ephemeral-infra');
    });

    it('kein Port auffindbar -> Playwright läuft trotzdem, ohne REGRESSION_BASE_URL (kein Crash)', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
      }));
      const runPlaywright = jest.fn(async ({ baseUrl }) => {
        expect(baseUrl).toBeUndefined();
        return { exitCode: 0 };
      });
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 1, passed: 1, failed: 0 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({ runPlaywright, readFile, readSuites });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
      await flush();

      expect(runPlaywright).toHaveBeenCalledTimes(1);
      expect(runner.getRun(runId).status).toBe('passed');
    });

    it('garantiertes Cleanup: fegt bei einem GRÜNEN Lauf ausschließlich rtest-*-Maschinen, andere Namen bleiben unberührt (Produktiv-Allowlist)', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
      }));
      const del = jest.fn(async () => ({ result: 'ok' }));
      const vpsRegistry = {
        listAllMachines: jest.fn(async () => ({
          machines: [
            { provider: 'hetzner', serverId: '1', name: 'rtest-regression-test-vps' },
            { provider: 'hetzner', serverId: '2', name: 'produktiv-server' },
          ],
        })),
        delete: del,
      };
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile: readFileScaffoldAndPort(),
        readSuites,
        vpsRegistry,
      });

      runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
      await flush();

      expect(vpsRegistry.listAllMachines).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledWith('hetzner', '1', 'rtest-regression-test-vps');
    });

    it.each([
      ['error (interner Fehler, runPlaywright wirft)', () => { throw new Error('boom'); }],
      ['error (spawnError)', async () => ({ exitCode: -1, spawnError: true })],
      ['error (Timeout)', async () => ({ exitCode: -1, timedOut: true })],
      ['error (kein CTRF)', async () => ({ exitCode: 0 })],
    ])('garantiertes Cleanup läuft auch bei %s', async (_label, runPlaywrightImpl) => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
      }));
      const del = jest.fn(async () => ({ result: 'ok' }));
      const vpsRegistry = {
        listAllMachines: jest.fn(async () => ({ machines: [{ provider: 'hetzner', serverId: '9', name: 'rtest-orphan' }] })),
        delete: del,
      };
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); // kein CTRF -> deckt auch den "kein CTRF"-Fall
      });
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(runPlaywrightImpl),
        readFile,
        readSuites,
        vpsRegistry,
      });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
      await flush();

      expect(runner.getRun(runId).status).toBe('error');
      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledWith('hetzner', '9', 'rtest-orphan');
    });

    it('rotem Lauf (failed>0) -> notifyRegressionFailed wird aufgerufen UND Cleanup läuft dennoch', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
      }));
      const notifyRegressionFailed = jest.fn(async () => {});
      const del = jest.fn(async () => ({ result: 'ok' }));
      const vpsRegistry = {
        listAllMachines: jest.fn(async () => ({ machines: [{ provider: 'hetzner', serverId: '9', name: 'rtest-orphan' }] })),
        delete: del,
      };
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        if (String(p).endsWith(CTRF_RESULT_PATH)) return JSON.stringify({ results: { summary: { tests: 2, passed: 1, failed: 1 } } });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 1 })),
        readFile,
        readSuites,
        vpsRegistry,
        notifier: { notifyRegressionFailed },
      });

      runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
      await flush();

      expect(notifyRegressionFailed).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledTimes(1);
    });

    it('ohne injizierte vpsRegistry (Default) -> Cleanup best-effort übersprungen, kein Crash', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
      }));
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile: readFileScaffoldAndPort(),
        readSuites,
        // kein vpsRegistry injiziert
      });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
      await flush();

      expect(runner.getRun(runId).status).toBe('passed');
    });

    it('listAllMachines() wirft (Listing-Fehler) -> kein Crash, Lauf-Status bleibt korrekt', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
      }));
      const vpsRegistry = { listAllMachines: jest.fn(async () => { throw new Error('API kaputt'); }), delete: jest.fn() };
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile: readFileScaffoldAndPort(),
        readSuites,
        vpsRegistry,
      });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
      await flush();

      expect(runner.getRun(runId).status).toBe('passed');
      expect(vpsRegistry.delete).not.toHaveBeenCalled();
    });

    it('delete() wirft für eine Maschine -> Sweep macht best-effort mit der nächsten weiter, kein Crash', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
      }));
      const del = jest.fn(async (provider, serverId) => {
        if (serverId === '1') throw new Error('delete kaputt');
        return { result: 'ok' };
      });
      const vpsRegistry = {
        listAllMachines: jest.fn(async () => ({
          machines: [
            { provider: 'hetzner', serverId: '1', name: 'rtest-a' },
            { provider: 'hetzner', serverId: '2', name: 'rtest-b' },
          ],
        })),
        delete: del,
      };
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile: readFileScaffoldAndPort(),
        readSuites,
        vpsRegistry,
      });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
      await flush();

      expect(runner.getRun(runId).status).toBe('passed');
      expect(del).toHaveBeenCalledTimes(2); // beide versucht, trotz Fehler bei der ersten
    });

    it('getRun() zeigt target:"ephemeral-infra" bei einem terminalen Zustand (GET-Vertrag)', async () => {
      const readSuites = jest.fn(async () => ({
        suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
      }));
      const record = jest.fn(async (i) => i);
      const runner = new RegressionRunner({
        runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
        readFile: readFileScaffoldAndPort(),
        readSuites,
        resultStore: { record },
      });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
      await flush();

      expect(runner.getRun(runId)).toMatchObject({ status: 'passed', target: 'ephemeral-infra' });
      // AC9: der resultStore-Datensatz selbst trägt (S-327-Bestandsverhalten)
      // keinen `target`-Key — nur die flüchtige GET-Sicht tut das.
      expect(record.mock.calls[0][0].status).toBe('passed');
      expect(record.mock.calls[0][0].target).toBeUndefined();
    });

    // ── Review-Fix Iteration 2: Sweep MUSS VOR der Lock-Freigabe laufen ──────
    describe('Reihenfolge: Sicherheitsnetz-Sweep VOR Lock-Freigabe (kein Race mit einem Folgelauf)', () => {
      it('Erfolgspfad: Lock bleibt gehalten, solange der Sweep (listAllMachines) noch aussteht — erst danach frei', async () => {
        const readSuites = jest.fn(async () => ({
          suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
        }));
        let resolveList;
        const vpsRegistry = {
          listAllMachines: jest.fn(() => new Promise((r) => { resolveList = r; })),
          delete: jest.fn(async () => ({ result: 'ok' })),
        };
        const runner = new RegressionRunner({
          runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
          readFile: readFileScaffoldAndPort(),
          readSuites,
          vpsRegistry,
        });

        const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
        // Genug Ticks, damit Playwright/CTRF-Auswertung durchgelaufen sind und
        // der Sweep gestartet (listAllMachines aufgerufen), aber NICHT
        // aufgelöst wurde.
        await flush();
        await flush();

        expect(vpsRegistry.listAllMachines).toHaveBeenCalledTimes(1);
        // Sweep hängt noch -> #finish wurde NOCH NICHT aufgerufen -> Lock hält,
        // Status noch "running".
        expect(runner.isRunning('/ws/proj')).toBe(true);
        expect(runner.getRun(runId).status).toBe('running');

        resolveList({ machines: [] });
        await flush();
        await flush();

        expect(runner.isRunning('/ws/proj')).toBe(false);
        expect(runner.getRun(runId).status).toBe('passed');
      });

      it('Fehlerpfad (spawnError): Lock bleibt gehalten, solange der Sweep aussteht — erst danach frei', async () => {
        const readSuites = jest.fn(async () => ({
          suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
        }));
        let resolveList;
        const vpsRegistry = {
          listAllMachines: jest.fn(() => new Promise((r) => { resolveList = r; })),
          delete: jest.fn(async () => ({ result: 'ok' })),
        };
        const readFile = jest.fn(async (p) => {
          if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
          if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
          throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        });
        const runner = new RegressionRunner({
          runPlaywright: jest.fn(async () => ({ exitCode: -1, spawnError: true })),
          readFile,
          readSuites,
          vpsRegistry,
        });

        const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
        await flush();
        await flush();

        expect(vpsRegistry.listAllMachines).toHaveBeenCalledTimes(1);
        expect(runner.isRunning('/ws/proj')).toBe(true);
        expect(runner.getRun(runId).status).toBe('running');

        resolveList({ machines: [] });
        await flush();
        await flush();

        expect(runner.isRunning('/ws/proj')).toBe(false);
        expect(runner.getRun(runId).status).toBe('error');
      });

      it('Fehlerpfad (interner Fehler, runPlaywright wirft): Lock bleibt gehalten, solange der Sweep aussteht', async () => {
        const readSuites = jest.fn(async () => ({
          suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
        }));
        let resolveList;
        const vpsRegistry = {
          listAllMachines: jest.fn(() => new Promise((r) => { resolveList = r; })),
          delete: jest.fn(async () => ({ result: 'ok' })),
        };
        const readFile = jest.fn(async (p) => {
          if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
          if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
          throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        });
        const runner = new RegressionRunner({
          runPlaywright: jest.fn(async () => { throw new Error('boom'); }),
          readFile,
          readSuites,
          vpsRegistry,
        });

        const { runId } = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
        await flush();
        await flush();

        expect(runner.isRunning('/ws/proj')).toBe(true);
        expect(runner.getRun(runId).status).toBe('running');

        resolveList({ machines: [] });
        await flush();
        await flush();

        expect(runner.isRunning('/ws/proj')).toBe(false);
        expect(runner.getRun(runId).status).toBe('error');
      });

      it('ein sofort gestarteter Folgelauf desselben Projekts wird abgelehnt (locked), solange der Sweep der Vorrunde noch läuft', async () => {
        const readSuites = jest.fn(async () => ({
          suites: [{ scope: { typ: 'bereich', id: 'vps' }, label: 'vps', target: 'ephemeral-infra' }],
        }));
        let resolveList;
        const vpsRegistry = {
          listAllMachines: jest.fn(() => new Promise((r) => { resolveList = r; })),
          delete: jest.fn(async () => ({ result: 'ok' })),
        };
        const runner = new RegressionRunner({
          runPlaywright: jest.fn(async () => ({ exitCode: 0 })),
          readFile: readFileScaffoldAndPort(),
          readSuites,
          vpsRegistry,
        });

        runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
        await flush();
        await flush();

        // Sweep der ersten Runde hängt noch -> ein zweiter start() fürs
        // selbe Projekt MUSS als "locked" abgelehnt werden (kein Race, in dem
        // der Folgelauf eine frische rtest-*-Maschine anlegt, die der noch
        // laufende Sweep dann versehentlich mitlöscht).
        const res2 = runner.start('/ws/proj', 'proj', { typ: 'bereich', id: 'vps' });
        expect(res2).toEqual({ ok: false, reason: 'locked' });

        resolveList({ machines: [] });
        await flush();
        await flush();

        expect(runner.isRunning('/ws/proj')).toBe(false);
      });
    });
  });

  // ── AC10: Diagnose-Pflicht bei Frühausfall — strukturelle Persistenz über #finish ──
  describe('AC10 — Diagnose-Pflicht: JEDER terminale Zustand persistiert genau EINEN Datensatz', () => {
    it('kein Grundgerüst -> resultStore.record() mit status:"error", ctrf:null, counts 0/0/0, reason gesetzt', async () => {
      const record = jest.fn(async (i) => i);
      const readFile = jest.fn(async () => { throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); });
      const runner = new RegressionRunner({ runPlaywright: jest.fn(), readFile, resultStore: { record } });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      expect(runner.getRun(runId).status).toBe('error');
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({
        status: 'error',
        ctrf: null,
        counts: { passed: 0, failed: 0, total: 0 },
        reason: 'kein Regressions-Grundgerüst',
      });
      expect(record.mock.calls[0][0].artifacts).toBeUndefined();
    });

    it('precondition-error (local nicht erreichbar) -> resultStore.record() mit status/reason/ctrf:null', async () => {
      const record = jest.fn(async (i) => i);
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) return 'preview_port: 8080\n';
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const probeReachability = jest.fn(async () => false);
      const runner = new RegressionRunner({ runPlaywright: jest.fn(), readFile, probeReachability, resultStore: { record } });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      expect(runner.getRun(runId).status).toBe('precondition-error');
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({
        status: 'precondition-error',
        ctrf: null,
        counts: { passed: 0, failed: 0, total: 0 },
        reason: 'Applikation lokal nicht gestartet',
      });
    });

    it('Lock wird VOR dem Store-Schreibzugriff freigegeben — ein NIE auflösendes record() hält das Lock nicht', async () => {
      const neverResolves = jest.fn(() => new Promise(() => {})); // hängt für immer
      const readFile = jest.fn(async () => { throw Object.assign(new Error('enoent'), { code: 'ENOENT' }); });
      const runner = new RegressionRunner({ runPlaywright: jest.fn(), readFile, resultStore: { record: neverResolves } });

      runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      // Status bereits terminal UND Lock frei, OBWOHL record() nie auflöst.
      expect(runner.isRunning('/ws/proj')).toBe(false);
      expect(neverResolves).toHaveBeenCalledTimes(1);
    });

    it('kein CTRF nach dem Lauf -> resultStore.record() mit status:"error", ctrf:null, counts 0/0/0', async () => {
      const record = jest.fn(async (i) => i);
      const runPlaywright = jest.fn(async () => ({ exitCode: 0 }));
      const readFile = jest.fn(async (p) => {
        if (String(p).endsWith('.claude/profile.md')) throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
        if (String(p).endsWith('tests/regression')) throw Object.assign(new Error('is a dir'), { code: 'EISDIR' });
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      });
      const runner = new RegressionRunner({ runPlaywright, readFile, resultStore: { record } });

      const { runId } = runner.start('/ws/proj', 'proj', { typ: 'gesamt' });
      await flush();

      expect(runner.getRun(runId).status).toBe('error');
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({ status: 'error', ctrf: null, counts: { passed: 0, failed: 0, total: 0 } });
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
