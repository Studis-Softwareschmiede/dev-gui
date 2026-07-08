/**
 * RegressionRunner — deterministischer Regressionstest-Runner (`npx playwright
 * test`, KEIN Agent, KEIN `claude`-Kindprozess) mit eigenem `ProjectJobLock`,
 * Busy-Check, local-Erreichbarkeitsprüfung und Ergebnis-Übergabe an den
 * `RegressionResultStore` (docs/specs/regression-run.md AC1, AC2, AC3, AC5, AC9).
 *
 * Zentraler Unterschied zu ALLEN anderen Runnern in diesem Repo (Grep-prüfbar):
 * dieses Modul importiert/spawnt **kein** `claude` — es startet ausschließlich
 * `npx playwright test` im Projekt-Klon. Kein API-Key, kein
 * `HeadlessRunnerCore`/`buildChildEnv`-Import (der ist `claude`-spezifisch).
 *
 * Eigener Boundary (AC1):
 *   - EIGENE, isolierte `ProjectJobLock`-Instanz (Konstruktor-Default
 *     `new ProjectJobLock()`) — getrennt von ALLEN `claude -p`-Runnern
 *     (Nacht-Drain/manueller Drain/Reconcile/Finalizer/Auto-Retro/
 *     ObsidianIngestRunner/RegressionDefineRunner). Ein laufender
 *     Definitions-/Drain-Lauf blockiert einen Regressionslauf NICHT über
 *     dieses Lock — die Busy-Prüfung gegen Drains läuft separat (AC2, s.u.).
 *   - Audit-First: der AUFRUFENDE Router schreibt den Start-Audit-Eintrag VOR
 *     `start()` (Muster `regressionDefineRouter`); dieses Modul selbst
 *     auditiert Ende/Fehler (secret-frei).
 *   - Entkoppelter Runaway-Timeout (`REGRESSION_RUN_TIMEOUT_MS`, eigenständig,
 *     NICHT an `REGRESSION_DEFINE_TIMEOUT_MS` o.ä. gekoppelt — ein Playwright-
 *     Lauf hat ein anderes Zeitprofil als ein `claude`-Definitions-Turn).
 *
 * Busy-Check (AC2): `isProjectBusy()` (ProjectJobLock.js) wird VOM ROUTER rein
 * lesend geprüft (Drain-Lock + Command-Status + Session-Existenz) UND
 * zusätzlich gegen das EIGENE `RegressionRunner`-Lock (ein zweiter
 * Regressionslauf desselben Projekts) — kein Doppel-Start, kein Doppel-Trigger.
 *
 * Security/Access (AC3): dieser Runner selbst prüft KEINE Identität/Rolle —
 * das ist Router-Verantwortung (gleiche `CRED_ADMIN_EMAILS`-Logik wie
 * `deploymentsRouter`/`vpsContainerRouter`, s. `regressionRunRouter.js`).
 * Kein Secret/Token in Job-Status, Log oder Audit.
 *
 * Testobjekt/`target`-Auflösung + local-Erreichbarkeit (AC5, agent-flow
 * `regression-runner` AC6): der Runner selbst entscheidet NICHT, welche Suite
 * welches `target` deklariert (das lebt in der Begleitbeschreibung, AC4/AC6
 * sind spätere Storys/Frontend, s. Spec-Nicht-Ziele dieser Story) — er prüft
 * VOR jedem Lauf, der `local`-Suiten enthalten KANN (Bereich/Verbund/Gesamt,
 * konservativ: immer), ob die lokale Applikation erreichbar ist:
 * `http://127.0.0.1:<port>/`, Port aus `.claude/profile.md` (`preview_port`,
 * Fallback `container_port`) des Projekt-Klons. Nicht erreichbar → sofortiger
 * `precondition-error` MIT Grund „Applikation lokal nicht gestartet" — KEIN
 * Playwright-Start (kein roter Testlauf für einen Vorbedingungsfehler).
 * Frisch-Ausrollen (AC7) und der Selbsttest-Sonderfall (AC8) sind bewusst
 * NICHT Teil dieser Story (S-310, s. Feature-Dossier) — dieser Runner führt
 * defensiv IMMER die reine Erreichbarkeitsprüfung durch, ohne recreate.
 *
 * Ausführung & Ergebnis-Übergabe (AC9): `npx playwright test <scopePath>` wird
 * als Array-argv gestartet (kein Shell-String, security/R03), `cwd` = der
 * bereits validierte, absolute Projekt-Pfad. Scope→Pfad-Zuordnung (Layout
 * gemäß agent-flow `regression-playwright-conventions` AC2):
 *   - `bereich`  → `tests/regression/<id>`      (Verzeichnis, alle Suiten darin)
 *   - `verbund`  → `tests/regression/verbund`   (EIN gemeinsames Verzeichnis für
 *                   alle Verbund-Suiten — der `verbund`-Name selektiert keine
 *                   eigene Unter-Datei, weil das Layout keinen weiteren
 *                   Namens-Unterordner vorsieht; s. SPEC-LÜCKE-Hinweis im
 *                   Handoff)
 *   - `gesamt`   → `tests/regression`           (gesamter Baum)
 * Nach Abschluss liest der Runner das CTRF-JSON-Ergebnis aus
 * `test-results/ctrf-report.json` (Default-Ausgabepfad des Referenz-Templates
 * `templates/_shared/regression/playwright.config.ts`,
 * `playwright-ctrf-json-reporter` mit `outputDir: 'test-results'`) und übergibt
 * EINEN aggregierten Lauf-Datensatz an `RegressionResultStore.record()` (A1:
 * „Gesamt" = ein Datensatz, `suite`-Label = gewählter Scope). Debug-Artefakte
 * (`playwright-report/`) werden NUR bei `status:'failed'` referenziert
 * (RegressionResultStore AC3) — dieser Runner reicht dafür nur den relativen
 * Pfad `playwright-report` durch (Existenz wird vom Store/Frontend nicht
 * geprüft, best-effort-Referenz).
 *
 * Kein Projekt-Klon / kein Playwright-Grundgerüst (Edge-Case, Spec §Edge-Cases):
 *   fehlt `tests/regression` im Klon → `error` mit dem Grund „kein
 *   Regressions-Grundgerüst" statt eines Crashs.
 *
 * @module RegressionRunner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectJobLock } from './ProjectJobLock.js';

/** Eigenständiger, entkoppelter Runaway-Timeout (Default 15 min — ein Playwright-Lauf kann mehrere Minuten dauern). */
export const DEFAULT_REGRESSION_RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** Timeout für die local-Erreichbarkeitsprüfung (ms). */
const REACHABILITY_TIMEOUT_MS = 3_000;

/** Relativer Pfad des Regressions-Testbaums im Projekt-Klon (agent-flow `regression-playwright-conventions` AC2). */
export const REGRESSION_TESTS_ROOT = 'tests/regression';

/** Relativer Pfad des CTRF-JSON-Ergebnisses (Referenz-Template `outputDir: 'test-results'`, Default-Dateiname des Reporters). */
export const CTRF_RESULT_PATH = 'test-results/ctrf-report.json';

/** Relativer Pfad des HTML-Reports (nur referenziert, nicht geprüft — RegressionResultStore AC3). */
export const HTML_REPORT_PATH = 'playwright-report';

// ── Secret-freie Meldungstexte ────────────────────────────────────────────────
const PRECONDITION_MESSAGE = 'Applikation lokal nicht gestartet';
const NO_SCAFFOLD_MESSAGE = 'kein Regressions-Grundgerüst';
const GENERIC_FAILURE_MESSAGE = 'Regressionslauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Regressionslauf abgebrochen (Timeout)';
const NOT_AVAILABLE_MESSAGE = 'npx nicht verfügbar';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Regressions-Runner';
const NO_CTRF_MESSAGE = 'Regressionslauf beendet, aber kein CTRF-Ergebnis gefunden';

/**
 * Validiert den Ausführen-Scope (Vertrag `regression-run.md` §Verträge).
 * Reine Funktion, vom Router UND vom Runner autoritativ genutzt (Defense in Depth).
 *
 * @param {unknown} scope
 * @returns {{ ok: true, scope: { typ: 'bereich'|'verbund'|'gesamt', id?: string } } | { ok: false, reason: string }}
 */
export function validateScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return { ok: false, reason: 'invalid' };
  }
  if (scope.typ !== 'bereich' && scope.typ !== 'verbund' && scope.typ !== 'gesamt') {
    return { ok: false, reason: 'invalid-typ' };
  }
  if (scope.typ === 'gesamt') {
    return { ok: true, scope: { typ: 'gesamt' } };
  }
  const id = typeof scope.id === 'string' ? scope.id.trim() : '';
  if (id === '') {
    return { ok: false, reason: 'missing-id' };
  }
  return { ok: true, scope: { typ: scope.typ, id } };
}

/**
 * Baut den relativen Playwright-Test-Pfad für einen validierten Scope (agent-flow
 * `regression-playwright-conventions` AC2 Layout). `verbund` hat KEINEN eigenen
 * Unter-Namensordner je Verbund-Name — alle Verbund-Suiten liegen gemeinsam
 * unter `tests/regression/verbund` (Layout-Vertrag; s. Modul-Doku SPEC-LÜCKE-Hinweis).
 *
 * @param {{ typ: 'bereich'|'verbund'|'gesamt', id?: string }} scope
 * @returns {string} relativer Pfad ab dem Projekt-Root.
 */
export function scopeToTestPath(scope) {
  if (scope.typ === 'bereich') return `${REGRESSION_TESTS_ROOT}/${scope.id}`;
  if (scope.typ === 'verbund') return `${REGRESSION_TESTS_ROOT}/verbund`;
  return REGRESSION_TESTS_ROOT;
}

/**
 * Liest `preview_port` (Fallback: `container_port`) aus `.claude/profile.md`
 * des Projekt-Klons (Muster `templates/_shared/regression/run-regression.sh`).
 * Liefert `null`, wenn die Datei fehlt oder kein Port auffindbar ist (kein Crash).
 *
 * @param {string} projectPath - absoluter, validierter Projekt-Pfad.
 * @param {{ readFile?: Function }} [deps] - injectable fs-Dep für Tests.
 * @returns {Promise<number|null>}
 */
export async function readLocalPreviewPort(projectPath, { readFile: readFileFn = readFile } = {}) {
  let content;
  try {
    content = await readFileFn(join(projectPath, '.claude/profile.md'), 'utf8');
  } catch {
    return null;
  }
  const previewMatch = content.match(/^preview_port:\s*(\d+)\s*$/m);
  if (previewMatch) return Number(previewMatch[1]);
  const containerMatch = content.match(/^container_port:\s*(\d+)\s*$/m);
  if (containerMatch) return Number(containerMatch[1]);
  return null;
}

/**
 * Best-effort HTTP-Erreichbarkeitsprüfung gegen `http://127.0.0.1:<port>/`
 * (Muster `LocalDockerControl#probeReachability`). Jeder HTTP-Statuscode zählt
 * als erreichbar; Timeout/Refused → false.
 *
 * @param {number} port
 * @param {{ fetchFn?: Function }} [deps] - injectable fetch für Tests.
 * @returns {Promise<boolean>}
 */
export async function probeLocalReachability(port, { fetchFn } = {}) {
  const _fetch = fetchFn ?? defaultFetchProbe;
  try {
    return await _fetch(`http://127.0.0.1:${port}/`, REACHABILITY_TIMEOUT_MS);
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function defaultFetchProbe(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal });
    return true; // jeder Statuscode gilt als erreichbar (AC5)
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liest + parst das CTRF-JSON-Ergebnis aus dem Projekt-Klon. Liefert `null`
 * bei fehlender/korrupter Datei (kein Crash — der Aufrufer mappt das auf
 * einen definierten Fehlerzustand).
 *
 * @param {string} projectPath
 * @param {{ readFile?: Function }} [deps]
 * @returns {Promise<object|null>}
 */
export async function readCtrfResult(projectPath, { readFile: readFileFn = readFile } = {}) {
  try {
    const raw = await readFileFn(join(projectPath, CTRF_RESULT_PATH), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extrahiert `{passed,failed,total}` + Gesamt-Status aus einem CTRF-JSON-Objekt
 * (`results.summary.{tests,passed,failed}`, CTRF-Standardschema). Tolerant
 * gegenüber fehlenden Feldern (defensiv, kein Crash bei abweichendem Schema).
 *
 * @param {object|null} ctrf
 * @returns {{ counts: { passed: number, failed: number, total: number }, status: 'passed'|'failed' }}
 */
export function summarizeCtrf(ctrf) {
  const summary = ctrf?.results?.summary ?? {};
  const passed = Number.isFinite(summary.passed) ? summary.passed : 0;
  const failed = Number.isFinite(summary.failed) ? summary.failed : 0;
  const total = Number.isFinite(summary.tests) ? summary.tests : passed + failed;
  return {
    counts: { passed, failed, total },
    status: failed > 0 ? 'failed' : 'passed',
  };
}

/**
 * Default `npx playwright test`-Adapter (AC1/AC9): startet den Kindprozess als
 * Array-argv (kein Shell-String, security/R03), `cwd` = Projekt-Pfad. KEIN
 * `claude`, KEIN API-Key, KEINE HeadlessRunnerCore-Env-Übernahme nötig — die
 * Kind-Env ist die volle Prozess-Env (Playwright/Node brauchen z.B. `PATH`,
 * `HOME`; Secrets für Testläufe werden — analog `run-regression.sh` AC9 — zur
 * Laufzeit aus der Umgebung übernommen, nie aus Test-/Datendateien gelesen;
 * dieser Runner persistiert nichts davon).
 *
 * @param {object} params
 * @param {string} params.projectPath
 * @param {string} params.testPath - relativer Pfad (Verzeichnis/Datei) an `npx playwright test`.
 * @param {string} [params.baseUrl] - REGRESSION_BASE_URL (nur bei `local`, Playwright-Config-Konvention).
 * @param {number} [params.timeoutMs]
 * @param {Function} [params.spawnFn] - injectable (default node:child_process spawn).
 * @returns {Promise<{ exitCode: number|null, spawnError?: boolean, timedOut?: boolean }>}
 */
export function defaultRunPlaywright({
  projectPath,
  testPath,
  baseUrl,
  timeoutMs = DEFAULT_REGRESSION_RUN_TIMEOUT_MS,
  spawnFn = nodeSpawn,
}) {
  return new Promise((resolve) => {
    const argv = ['playwright', 'test', testPath];

    let settled = false;
    let timeoutHandle;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const env = { ...process.env };
    if (baseUrl) env.REGRESSION_BASE_URL = baseUrl;

    try {
      child = spawnFn('npx', argv, {
        cwd: projectPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish({ exitCode: -1, spawnError: true });
      return;
    }

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      finish({ exitCode: -1, timedOut: true });
    }, timeoutMs);

    // stdout/stderr draining (keine Pipe-Blockade) — Inhalt wird nicht
    // ausgewertet, das Ergebnis kommt aus dem CTRF-JSON (readCtrfResult).
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});

    child.on('close', (code) => {
      finish({ exitCode: code });
    });

    child.on('error', (err) => {
      finish({ exitCode: -1, spawnError: true, notFound: err?.code === 'ENOENT' });
    });
  });
}

/**
 * RegressionRunner — deterministischer `npx playwright test`-Runner + In-Memory
 * Job-Registry (docs/specs/regression-run.md AC1, AC2, AC3, AC5, AC9).
 */
export class RegressionRunner {
  /** @type {(params: object) => Promise<object>} */
  #runPlaywright;
  /** @type {ProjectJobLock} */
  #lock;
  /** @type {number} */
  #timeoutMs;
  /** @type {import('./AuditStore.js').AuditStore|null} */
  #auditStore;
  /** @type {import('./RegressionResultStore.js').RegressionResultStore|null} */
  #resultStore;
  /** @type {(projectPath: string, deps?: object) => Promise<number|null>} */
  #readPort;
  /** @type {(port: number, deps?: object) => Promise<boolean>} */
  #probeReachability;
  /** @type {(projectPath: string, deps?: object) => Promise<object|null>} */
  #readCtrf;
  /** @type {Function} injectable readFile (fürs "kein Grundgerüst"-Vorprüfen) */
  #readFile;
  /**
   * @type {Map<string, {
   *   status: 'running'|'passed'|'failed'|'precondition-error'|'error',
   *   target?: string, suite: string, scopeTyp: string,
   *   counts?: { passed: number, failed: number, total: number },
   *   durationMs?: number, reason?: string,
   *   projectPath: string, projekt: string, identity: string|null,
   * }>}
   */
  #jobs = new Map();

  /**
   * @param {object} [params]
   * @param {Function} [params.runPlaywright] - injectable Adapter (default: defaultRunPlaywright).
   * @param {ProjectJobLock} [params.lock] - injectable Lock (default: EIGENE, isolierte Instanz).
   * @param {number} [params.timeoutMs] - default: env REGRESSION_RUN_TIMEOUT_MS oder Default.
   * @param {import('./AuditStore.js').AuditStore} [params.auditStore] - optional (Ende/Fehler-Audit).
   * @param {import('./RegressionResultStore.js').RegressionResultStore} [params.resultStore] - optional (AC9).
   * @param {Function} [params.spawnFn] - nur wirksam wenn `runPlaywright` NICHT übergeben wird.
   * @param {Function} [params.readPort] - injectable (default: readLocalPreviewPort).
   * @param {Function} [params.probeReachability] - injectable (default: probeLocalReachability).
   * @param {Function} [params.readCtrf] - injectable (default: readCtrfResult).
   * @param {Function} [params.readFile] - injectable fs.readFile (Grundgerüst-Vorprüfung).
   */
  constructor({
    runPlaywright,
    lock,
    timeoutMs,
    auditStore,
    resultStore,
    spawnFn,
    readPort,
    probeReachability,
    readCtrf,
    readFile: readFileFn,
  } = {}) {
    this.#timeoutMs = timeoutMs ?? (Number(process.env.REGRESSION_RUN_TIMEOUT_MS) || DEFAULT_REGRESSION_RUN_TIMEOUT_MS);
    this.#runPlaywright =
      runPlaywright ?? ((params) => defaultRunPlaywright({ ...params, timeoutMs: this.#timeoutMs, spawnFn }));
    this.#lock = lock ?? new ProjectJobLock();
    this.#auditStore = auditStore ?? null;
    this.#resultStore = resultStore ?? null;
    this.#readPort = readPort ?? readLocalPreviewPort;
    this.#probeReachability = probeReachability ?? probeLocalReachability;
    this.#readCtrf = readCtrf ?? readCtrfResult;
    this.#readFile = readFileFn ?? readFile;
  }

  /**
   * Prüft, ob DIESES Runner-eigene Lock für ein Projekt bereits gehalten wird —
   * für den Busy-Check des Routers (AC2, "kein anderer Regressionslauf
   * desselben Projekts aktiv").
   *
   * @param {string} projectPath
   * @returns {boolean}
   */
  isRunning(projectPath) {
    return this.#lock.isHeld(projectPath);
  }

  /**
   * Startet einen Regressionslauf für ein Projekt (AC1/AC2/AC9). Erwirbt das
   * EIGENE, isolierte `ProjectJobLock` — freigegeben erst bei einem
   * terminalen Zustand.
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad.
   * @param {string} projekt - Projekt-Slug (für den Ergebnis-Store, AC9).
   * @param {{ typ: 'bereich'|'verbund'|'gesamt', id?: string }} scope - validierter Scope.
   * @param {object} [meta]
   * @param {string|null} [meta.identity] - für das Ende-/Fehler-Audit.
   * @returns {{ ok: true, runId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath, projekt, scope, { identity = null } = {}) {
    if (!this.#lock.tryAcquire(projectPath)) {
      return { ok: false, reason: 'locked' };
    }
    const runId = randomUUID();
    // A1: "Gesamt" (und ebenso bereich/verbund) = EIN Lauf-Datensatz;
    // `suite`-Label = gewählter Scope (bereich-id / verbund-name / "Gesamt").
    const suiteLabel = scope.typ === 'gesamt' ? 'Gesamt' : scope.id;
    this.#jobs.set(runId, {
      status: 'running',
      suite: suiteLabel,
      scopeTyp: scope.typ,
      projectPath,
      projekt,
      identity: identity ?? null,
    });

    // Fire-and-forget: der Lauf kann mehrere Minuten dauern; der Aufrufer
    // (Router) wartet nicht.
    this.#runLifecycle(runId, scope).catch(() => {
      // #runLifecycle fängt selbst alle Fehler ab (Sicherheitsnetz).
    });
    return { ok: true, runId };
  }

  /**
   * Liest die ÖFFENTLICHE Sicht auf einen Lauf (Vertrag §Verträge GET) —
   * secret-frei, ohne interne Felder (`projectPath`/`identity`).
   *
   * @param {string} runId
   * @returns {object|undefined}
   */
  getRun(runId) {
    const job = this.#jobs.get(runId);
    if (!job) return undefined;
    const view = { status: job.status, suite: job.suite };
    if (job.target !== undefined) view.target = job.target;
    if (job.counts !== undefined) view.counts = job.counts;
    if (job.durationMs !== undefined) view.durationMs = job.durationMs;
    if (job.reason !== undefined) view.reason = job.reason;
    return view;
  }

  /**
   * Führt EINEN Regressionslauf vollständig aus: local-Erreichbarkeitsprüfung
   * (AC5, nur bei potenziell `local`-Scopes — konservativ: immer, da diese
   * Story kein `target`-Lesen je Suite umfasst, s. Nicht-Ziele/AC4 spätere
   * Story), `npx playwright test`, CTRF-Auswertung, Ergebnis-Übergabe (AC9).
   *
   * @param {string} runId
   * @param {{ typ: 'bereich'|'verbund'|'gesamt', id?: string }} scope
   * @returns {Promise<void>}
   */
  async #runLifecycle(runId, scope) {
    const job = this.#jobs.get(runId);
    if (!job) return;
    const start = Date.now();

    // Edge-Case: kein Projekt-Klon-Grundgerüst (tests/regression fehlt) →
    // klarer Fehler statt Crash/rotem Lauf.
    const testPath = scopeToTestPath(scope);
    const scaffoldExists = await this.#checkScaffold(job.projectPath);
    if (!scaffoldExists) {
      this.#finish(runId, 'error', { reason: NO_SCAFFOLD_MESSAGE, durationMs: Date.now() - start });
      return;
    }

    // AC5: local-Erreichbarkeitsprüfung VOR jedem Lauf (konservativ — diese
    // Story liest `target` je Suite noch nicht, s. Modul-Doku/Nicht-Ziele).
    const port = await this.#readPort(job.projectPath, { readFile: this.#readFile });
    let baseUrl;
    if (port !== null) {
      const reachable = await this.#probeReachability(port);
      if (!reachable) {
        this.#finish(runId, 'precondition-error', { reason: PRECONDITION_MESSAGE, target: 'local', durationMs: Date.now() - start });
        return;
      }
      baseUrl = `http://127.0.0.1:${port}`;
    }

    let res;
    try {
      res = await this.#runPlaywright({ projectPath: job.projectPath, testPath, baseUrl });
    } catch {
      this.#finish(runId, 'error', { reason: INTERNAL_FAILURE_MESSAGE, durationMs: Date.now() - start });
      return;
    }

    if (res?.spawnError) {
      const reason = res.notFound ? NOT_AVAILABLE_MESSAGE : GENERIC_FAILURE_MESSAGE;
      this.#finish(runId, 'error', { reason, durationMs: Date.now() - start });
      return;
    }
    if (res?.timedOut) {
      this.#finish(runId, 'error', { reason: TIMEOUT_FAILURE_MESSAGE, durationMs: Date.now() - start });
      return;
    }

    const ctrf = await this.#readCtrf(job.projectPath, { readFile: this.#readFile });
    if (!ctrf) {
      this.#finish(runId, 'error', { reason: NO_CTRF_MESSAGE, durationMs: Date.now() - start });
      return;
    }

    const { counts, status } = summarizeCtrf(ctrf);
    const durationMs = Date.now() - start;

    // AC9: Ergebnis-Übergabe an den Store (S-312) — EIN aggregierter Datensatz.
    await this.#persistResult(job, { status, counts, ctrf, durationMs });

    this.#finish(runId, status, { counts, durationMs, target: baseUrl ? 'local' : undefined });
  }

  /**
   * Prüft, ob der Projekt-Klon ein Regressions-Grundgerüst hat
   * (`tests/regression`-Verzeichnis existiert). Best-effort — ein Lesefehler
   * zählt als "fehlt" (kein Crash).
   *
   * @param {string} projectPath
   * @returns {Promise<boolean>}
   */
  async #checkScaffold(projectPath) {
    try {
      await this.#readFile(join(projectPath, REGRESSION_TESTS_ROOT), 'utf8');
      return true; // ein Verzeichnis als 'utf8' zu lesen wirft (EISDIR) — s.u.
    } catch (err) {
      // EISDIR: der Pfad existiert UND ist ein Verzeichnis → Grundgerüst da.
      // ENOENT/anderes: kein Grundgerüst.
      return err?.code === 'EISDIR';
    }
  }

  /**
   * Übergibt EINEN aggregierten Lauf-Datensatz an den `RegressionResultStore`
   * (AC9, best-effort — ein Store-Fehler crasht den Runner nicht, der
   * Lauf-Status selbst bleibt korrekt, nur die Persistenz kann fehlen).
   *
   * @param {{ projekt: string, suite: string, scopeTyp: string }} job
   * @param {{ status: 'passed'|'failed', counts: object, ctrf: object, durationMs: number }} outcome
   */
  async #persistResult(job, { status, counts, ctrf, durationMs }) {
    if (!this.#resultStore || typeof this.#resultStore.record !== 'function') return;
    try {
      const input = {
        projekt: job.projekt,
        suite: job.suite,
        scopeTyp: job.scopeTyp,
        status,
        startedAt: new Date(Date.now() - durationMs).toISOString(),
        durationMs,
        counts,
        ctrf,
      };
      // RegressionResultStore AC3: Debug-Artefakte NUR bei status:'failed'.
      if (status === 'failed') {
        input.artifacts = { htmlReport: HTML_REPORT_PATH };
      }
      await this.#resultStore.record(input);
    } catch (err) {
      console.error('[RegressionRunner] Ergebnis-Übergabe fehlgeschlagen:', err.message);
    }
  }

  /**
   * Setzt einen Lauf terminal, gibt das Lock frei (immer) und schreibt genau
   * EINEN Ende-/Fehler-Audit-Eintrag (secret-frei).
   *
   * @param {string} runId
   * @param {'passed'|'failed'|'precondition-error'|'error'} status
   * @param {{ counts?: object, durationMs?: number, reason?: string, target?: string }} patch
   */
  #finish(runId, status, patch) {
    const job = this.#jobs.get(runId);
    if (!job) return;
    job.status = status;
    if (patch.counts !== undefined) job.counts = patch.counts;
    if (patch.durationMs !== undefined) job.durationMs = patch.durationMs;
    if (patch.reason !== undefined) job.reason = patch.reason;
    if (patch.target !== undefined) job.target = patch.target;

    // Lock IMMER freigeben (terminaler Zustand).
    this.#lock.release(job.projectPath);

    if (status === 'passed') {
      this.#audit(job.identity, `regression-run:done:${runId}`);
    } else {
      this.#audit(job.identity, `regression-run:error:${runId}:${status}`);
    }
  }

  /**
   * Best-effort Audit. Ein Audit-Fehler crasht den Runner nie (analog
   * `RegressionDefineRunner#audit`).
   * @param {string|null} identity
   * @param {string} command
   */
  #audit(identity, command) {
    if (!this.#auditStore) return;
    try {
      this.#auditStore.record({ identity: identity ?? null, command });
    } catch {
      // best-effort — kein Crash, kein Secret im Log.
    }
  }
}
