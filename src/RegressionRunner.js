/**
 * RegressionRunner — deterministischer Regressionstest-Runner (`npx playwright
 * test`, KEIN Agent, KEIN `claude`-Kindprozess) mit eigenem `ProjectJobLock`,
 * Busy-Check, local-Erreichbarkeitsprüfung, Frisch-Ausrollen + Selbsttest-Skip
 * und Ergebnis-Übergabe an den `RegressionResultStore`
 * (docs/specs/regression-run.md AC1, AC2, AC3, AC5, AC7, AC8, AC9).
 *
 * Producer-Naht (docs/specs/regression-failed-notification.md AC1–AC4, S-315):
 * bei Lauf-Abschluss mit `status:"failed"` (aus `summarizeCtrf()`, ECHTE rote
 * Testfälle) stößt dieses Modul best-effort GENAU EINEN `regression_failed`-
 * Push über den injizierten `notifier` (`DrainNotifier#notifyRegressionFailed`,
 * GETEILTE Instanz — kein neuer Notify-Pfad) an. `precondition-error`/`error`
 * (Vorbedingungs-/Runner-Fehler, keine Test-Regression) lösen NIE einen Push
 * aus — diese Zustände erreichen den Notify-Aufruf strukturell nicht (nur der
 * `summarizeCtrf()`-Pfad tut es, s. `#runLifecycle`). Ohne injizierten
 * `notifier` degradiert der Runner auf reines Lauf-Ergebnis ohne Push (kein
 * Crash, Default-Regress).
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
 * Frisch-Ausrollen & Selbsttest (AC7, AC8, S-310): bei `target: local` UND
 * `freshRollout: true` UND NICHT Selbsttest zieht der Runner VOR der
 * Erreichbarkeitsprüfung das aktuelle ghcr-Image des Projekts und erstellt den
 * lokalen Container NEU (pull + recreate, niemals `restart`) über die
 * bestehende `LocalDockerControl#pullAndRecreate`-Methode (Wiederverwendung
 * der cicd/preview-Rollout-Mechanik, kein neuer Rollout-Pfad) — danach erst
 * die lauf-übliche Erreichbarkeitsprüfung (AC5). Selbsttest-Sonderfall (AC8):
 * ist das Testobjekt-Projekt (`projekt`-Slug, s. `start()`) DIESES Projekt
 * (dev-gui, Selbst-Erkennung über `SELF_PROJECT_SLUG`), wird Frisch-Ausrollen
 * SERVERSEITIG hart übersprungen — unabhängig vom übergebenen `freshRollout`-
 * Wert (Edge-Case „Selbsttest mit aktivierter Option via direktem API-Aufruf")
 * — ein recreate würde den eigenen Runner-Prozess mitsamt Lauf beenden. Ohne
 * injizierte `dockerControl` (Default: keine) wird Frisch-Ausrollen ebenfalls
 * übersprungen (kein Crash, degradiert auf reine Erreichbarkeitsprüfung).
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
 * (`playwright-report/`, `test-results/`) werden NICHT mehr referenziert,
 * sondern vom Store selbst aus dem Projekt-Klon in seine eigene Lauf-Ablage
 * KOPIERT (S-327, docs/specs/regression-result-store.md AC3) — dieser Runner
 * übergibt dafür nur den validierten, absoluten Projekt-Klon-Pfad
 * (`artifactsSourceDir: job.projectPath`); OB + welche Artefakte tatsächlich
 * behalten werden (Rot/Grün-Default, Retention), entscheidet ausschließlich
 * der Store — dieser Runner selbst unterscheidet dafür nicht mehr nach Status.
 *
 * Kein Projekt-Klon / kein Playwright-Grundgerüst (Edge-Case, Spec §Edge-Cases):
 *   fehlt `tests/regression` im Klon → `error` mit dem Grund „kein
 *   Regressions-Grundgerüst" statt eines Crashs.
 *
 * Diagnose-Pflicht bei Frühausfall (AC10, S-326): `#finish` ist die EINZIGE
 * Naht zu einem terminalen Zustand (`passed`/`failed`/`precondition-error`/
 * `error`) UND persistiert selbst — strukturell, nicht per Aufzählung: jeder
 * künftige Frühausgang, der `#finish` ruft, bekommt die Persistenz automatisch
 * mit, ohne dass ein Aufrufer daran denken muss. Reihenfolge in `#finish`:
 * (1) Status setzen, (2) Lock freigeben, (3) Audit, (4) best-effort
 * Store-Schreibzugriff — Lock-Freigabe VOR dem Store-Schreibzugriff, damit ein
 * hängender/fehlschlagender Store NIE ein Lock hält. Ohne CTRF (Frühausfall)
 * wird `ctrf: null` übergeben (KEIN synthetisches Ersatz-CTRF,
 * [[regression-result-store]] AC1b) — `reason` ist bei `precondition-error`/
 * `error` gesetzt, bei `passed`/`failed` abwesend. Ein Store-Fehler verhindert
 * den Lauf-Abschluss nie (best-effort, s. `#persistToStore`).
 *
 * Testobjekt-Weiche (AC11, S-326): VOR dem lokalen Pfad löst `#resolveTarget`
 * das je Scope deklarierte `target` über DIESELBE Lese-Boundary wie der
 * Ausführen-Dialog (`RegressionSuiteReader#readRegressionSuites`, AC4/AC6 —
 * kein zweiter Parser). `gesamt` mischt Testobjekte und läuft IMMER über den
 * local-Pfad (Bestandsverhalten, AC11 letzter Satz) — dafür wird
 * `readRegressionSuites` gar nicht erst aufgerufen (kein unnötiges Datei-IO).
 * Für `bereich`/`verbund` gilt: kein deklariertes `target` (fehlende/unlesbare
 * Begleitbeschreibung, Suite nicht gefunden) → konservativ `local`
 * (unverändertes Bestandsverhalten); `local` → bestehender lokaler Pfad
 * (AC5/AC7/AC8); jeder andere Wert (`ephemeral-infra`/`url`/ein unbekannter
 * String) → SOFORTIGER, persistierter `error` „Testobjekt `<target>` wird
 * noch nicht unterstützt" — OHNE Provisionierung, OHNE Playwright-Start, OHNE
 * die local-Erreichbarkeitsprüfung. Ein Fallback auf den local-Pfad ist
 * ausgeschlossen (verifizierter Befund 2026-07-08: die vps-Suite durchlief
 * fälschlich die local-Prüfung und meldete einen irreführenden
 * Vorbedingungs-Fehler). Datenhygiene: `target` kommt aus einer Repo-Datei,
 * die dieser Runner nicht kontrolliert — nur die drei bekannten Werte
 * (`local`/`ephemeral-infra`/`url`) werden wörtlich in die Meldung
 * übernommen, ein unbekannter Wert erzeugt eine generische Meldung
 * (`buildUnsupportedTargetMessage`).
 *
 * @module RegressionRunner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectJobLock } from './ProjectJobLock.js';
import { readRegressionSuites } from './RegressionSuiteReader.js';

/** Eigenständiger, entkoppelter Runaway-Timeout (Default 15 min — ein Playwright-Lauf kann mehrere Minuten dauern). */
export const DEFAULT_REGRESSION_RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** Timeout für die local-Erreichbarkeitsprüfung (ms). */
const REACHABILITY_TIMEOUT_MS = 3_000;

/** Relativer Pfad des Regressions-Testbaums im Projekt-Klon (agent-flow `regression-playwright-conventions` AC2). */
export const REGRESSION_TESTS_ROOT = 'tests/regression';

/** Relativer Pfad des CTRF-JSON-Ergebnisses (Referenz-Template `outputDir: 'test-results'`, Default-Dateiname des Reporters). */
export const CTRF_RESULT_PATH = 'test-results/ctrf-report.json';

/**
 * Selbsttest-Erkennung (AC8, Annahme A2 der Spec): Projekt-Slug, unter dem
 * dieser Runner-Prozess selbst läuft (`package.json` `name`, s. `.claude/profile.md`
 * dieses Repos). Ist das Testobjekt DIESER Slug, wird Frisch-Ausrollen
 * server-seitig hart übersprungen (ein recreate würde den eigenen Prozess
 * mitsamt Lauf beenden).
 */
export const SELF_PROJECT_SLUG = 'dev-gui';

// ── Secret-freie Meldungstexte ────────────────────────────────────────────────
const PRECONDITION_MESSAGE = 'Applikation lokal nicht gestartet';
const NO_SCAFFOLD_MESSAGE = 'kein Regressions-Grundgerüst';
const GENERIC_FAILURE_MESSAGE = 'Regressionslauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Regressionslauf abgebrochen (Timeout)';
const NOT_AVAILABLE_MESSAGE = 'npx nicht verfügbar';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Regressions-Runner';
const NO_CTRF_MESSAGE = 'Regressionslauf beendet, aber kein CTRF-Ergebnis gefunden';
const ROLLOUT_FAILURE_MESSAGE = 'Frisch-Ausrollen fehlgeschlagen';
const ROLLOUT_NOT_READY_MESSAGE = 'Applikation lokal nicht gestartet';

/**
 * Bekannte, bereits im Testobjekt-Modell definierte, aber (noch) nicht
 * gebaute `target`-Werte (AC11, A3/A4) — dürfen wörtlich in die
 * Fehlermeldung übernommen werden (Datenhygiene: nur bekannte Werte).
 */
const KNOWN_UNSUPPORTED_TARGETS = new Set(['ephemeral-infra', 'url']);

/**
 * Baut die secret-freie „noch nicht unterstützt"-Meldung für ein deklariertes,
 * aber (noch) nicht gebautes Testobjekt (AC11). `target` kommt aus einer
 * Repo-Datei, die dieser Runner nicht kontrolliert — nur die bekannten Werte
 * (`ephemeral-infra`/`url`) werden wörtlich übernommen; ein unbekannter/
 * unerwarteter Wert erzeugt eine generische Meldung (keine Übernahme
 * beliebiger Fremd-Strings in die Diagnose).
 *
 * @param {string} target
 * @returns {string}
 */
export function buildUnsupportedTargetMessage(target) {
  if (KNOWN_UNSUPPORTED_TARGETS.has(target)) {
    return `Testobjekt ${target} wird noch nicht unterstützt`;
  }
  return 'Testobjekt wird noch nicht unterstützt';
}

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
 * Liest `image` + `container_port` aus `.claude/profile.md` des Projekt-Klons
 * (agent-flow `/preview up`-Konvention, s. Modul-Doku AC7) — für das
 * Frisch-Ausrollen (`pullAndRecreate`). Liefert `null`, wenn `image` fehlt
 * (kein Crash — Frisch-Ausrollen wird dann übersprungen).
 *
 * @param {string} projectPath - absoluter, validierter Projekt-Pfad.
 * @param {{ readFile?: Function }} [deps] - injectable fs-Dep für Tests.
 * @returns {Promise<{ image: string, containerPort: number } | null>}
 */
export async function readLocalRolloutConfig(projectPath, { readFile: readFileFn = readFile } = {}) {
  let content;
  try {
    content = await readFileFn(join(projectPath, '.claude/profile.md'), 'utf8');
  } catch {
    return null;
  }
  const imageMatch = content.match(/^image:\s*(\S+)\s*$/m);
  if (!imageMatch) return null;
  const containerMatch = content.match(/^container_port:\s*(\d+)\s*$/m);
  return {
    image: imageMatch[1],
    containerPort: containerMatch ? Number(containerMatch[1]) : null,
  };
}

/**
 * Selbsttest-Erkennung (AC8, Annahme A2): ist das Testobjekt-Projekt
 * (`projekt`-Slug) DIESER Runner-Prozess selbst?
 *
 * @param {string} projekt - Projekt-Slug (s. `start()`).
 * @returns {boolean}
 */
export function isSelfProject(projekt) {
  return projekt === SELF_PROJECT_SLUG;
}

/**
 * Leitet den Docker-Container-Namen aus einer Image-Referenz ab — exakt die
 * agent-flow `/preview up`-Konvention (`skills/preview/SKILL.md` Abschnitt
 * „Variablen": `app` ← letztes Segment der Image-Referenz, **kleingeschrieben**
 * `tr 'A-Z' 'a-z'`; GitHub erlaubt Großbuchstaben im Repo-Namen, Docker NICHT
 * — Beispiel `Spoon-Knife → spoon-knife`). MUSS für `pullAndRecreate()`
 * verwendet werden statt des rohen, case-erhaltenden `projekt`-Slugs — sonst
 * trifft `docker rm -f` keinen existierenden Preview-Container (No-Op) und
 * `docker run --name` legt einen zweiten, parallelen Container an.
 *
 * @param {string} image - z.B. `ghcr.io/studis-softwareschmiede/Sandbox-2`.
 * @returns {string} letztes `/`-Segment, lowercase — z.B. `sandbox-2`.
 */
export function deriveContainerNameFromImage(image) {
  const lastSegment = String(image).split('/').pop();
  return lastSegment.toLowerCase();
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
  /** @type {(projectPath: string, deps?: object) => Promise<{image:string,containerPort:number|null}|null>} */
  #readRolloutConfig;
  /** @type {import('./deploy/LocalDockerControl.js').LocalDockerControl|null} injectable (AC7, Default: kein Frisch-Ausrollen) */
  #dockerControl;
  /** @type {import('./DrainNotifier.js').DrainNotifier|null} injectable (regression-failed-notification AC1–AC4, Default: kein Push) */
  #notifier;
  /** @type {(projectPath: string, deps?: object) => Promise<{suites: Array<object>}>} injectable (AC11 — dieselbe Lese-Boundary wie der Ausführen-Dialog, Default: readRegressionSuites) */
  #readSuites;
  /**
   * @type {Map<string, {
   *   status: 'running'|'passed'|'failed'|'precondition-error'|'error',
   *   target?: string, suite: string, scopeTyp: string,
   *   counts?: { passed: number, failed: number, total: number },
   *   durationMs?: number, reason?: string,
   *   projectPath: string, projekt: string, identity: string|null,
   *   freshRollout: boolean,
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
   * @param {Function} [params.readRolloutConfig] - injectable (default: readLocalRolloutConfig, AC7).
   * @param {import('./deploy/LocalDockerControl.js').LocalDockerControl} [params.dockerControl] - injectable (AC7; ohne → kein Frisch-Ausrollen möglich, degradiert).
   * @param {import('./DrainNotifier.js').DrainNotifier} [params.notifier] - injectable (regression-failed-notification AC1–AC4; ohne → kein Push, degradiert).
   * @param {Function} [params.readSuites] - injectable (AC11, default: readRegressionSuites — dieselbe Lese-Boundary wie der Ausführen-Dialog, AC4/AC6).
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
    readRolloutConfig,
    dockerControl,
    notifier,
    readSuites,
  } = {}) {
    this.#timeoutMs = timeoutMs ?? (Number(process.env.REGRESSION_RUN_TIMEOUT_MS) || DEFAULT_REGRESSION_RUN_TIMEOUT_MS);
    this.#readRolloutConfig = readRolloutConfig ?? readLocalRolloutConfig;
    this.#dockerControl = dockerControl ?? null;
    this.#runPlaywright =
      runPlaywright ?? ((params) => defaultRunPlaywright({ ...params, timeoutMs: this.#timeoutMs, spawnFn }));
    this.#lock = lock ?? new ProjectJobLock();
    this.#auditStore = auditStore ?? null;
    this.#resultStore = resultStore ?? null;
    this.#readPort = readPort ?? readLocalPreviewPort;
    this.#probeReachability = probeReachability ?? probeLocalReachability;
    this.#readCtrf = readCtrf ?? readCtrfResult;
    this.#readFile = readFileFn ?? readFile;
    this.#notifier = notifier ?? null;
    this.#readSuites = readSuites ?? readRegressionSuites;
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
   * @param {string} projekt - Projekt-Slug (für den Ergebnis-Store, AC9; auch Selbsttest-Erkennung, AC8).
   * @param {{ typ: 'bereich'|'verbund'|'gesamt', id?: string }} scope - validierter Scope.
   * @param {object} [meta]
   * @param {string|null} [meta.identity] - für das Ende-/Fehler-Audit.
   * @param {boolean} [meta.freshRollout] - AC7: pull+recreate vor der Suite (nur `target: local`,
   *   server-seitig IGNORIERT bei Selbsttest — AC8).
   * @returns {{ ok: true, runId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath, projekt, scope, { identity = null, freshRollout = false } = {}) {
    if (!this.#lock.tryAcquire(projectPath)) {
      return { ok: false, reason: 'locked' };
    }
    const runId = randomUUID();
    // A1: "Gesamt" (und ebenso bereich/verbund) = EIN Lauf-Datensatz;
    // `suite`-Label = gewählter Scope (bereich-id / verbund-name / "Gesamt").
    const suiteLabel = scope.typ === 'gesamt' ? 'Gesamt' : scope.id;
    // AC8: Selbsttest-Sonderfall — Frisch-Ausrollen server-seitig hart
    // übersprungen, UNABHÄNGIG vom übergebenen freshRollout-Wert (Edge-Case
    // „Selbsttest mit aktivierter Option via direktem API-Aufruf").
    const effectiveFreshRollout = Boolean(freshRollout) && !isSelfProject(projekt);
    this.#jobs.set(runId, {
      status: 'running',
      suite: suiteLabel,
      scopeTyp: scope.typ,
      projectPath,
      projekt,
      identity: identity ?? null,
      freshRollout: effectiveFreshRollout,
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
   * Führt EINEN Regressionslauf vollständig aus: Testobjekt-Weiche (AC11),
   * local-Erreichbarkeitsprüfung (AC5), `npx playwright test`,
   * CTRF-Auswertung, Ergebnis-Übergabe (AC9, strukturell über `#finish`,
   * AC10).
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

    // AC11: Testobjekt-Weiche VOR dem lokalen Pfad — dieselbe Lese-Boundary
    // wie der Ausführen-Dialog (kein zweiter Parser). Ein deklariertes,
    // (noch) nicht gebautes Testobjekt endet SOFORT als `error`, ohne
    // Provisionierung/Playwright-Start/local-Erreichbarkeitsprüfung.
    const target = await this.#resolveTarget(job.projectPath, scope);
    if (target !== 'local') {
      this.#finish(runId, 'error', {
        reason: buildUnsupportedTargetMessage(target),
        ...(KNOWN_UNSUPPORTED_TARGETS.has(target) ? { target } : {}),
        durationMs: Date.now() - start,
      });
      return;
    }

    // AC5: local-Erreichbarkeitsprüfung VOR jedem local-Lauf.
    const port = await this.#readPort(job.projectPath, { readFile: this.#readFile });
    let baseUrl;
    if (port !== null) {
      // AC7: Frisch-Ausrollen VOR der Erreichbarkeitsprüfung (pull + recreate,
      // niemals restart) — nur wenn angefordert (start()-Aufrufer hat AC8
      // bereits serverseitig erzwungen: job.freshRollout ist bei Selbsttest
      // immer false) UND eine dockerControl injiziert ist (sonst degradiert
      // auf die reine Erreichbarkeitsprüfung, kein Crash).
      if (job.freshRollout && this.#dockerControl) {
        const rolloutOutcome = await this.#performFreshRollout(job, port);
        if (rolloutOutcome && !rolloutOutcome.ok) {
          this.#finish(runId, rolloutOutcome.status, {
            reason: rolloutOutcome.reason,
            target: 'local',
            durationMs: Date.now() - start,
          });
          return;
        }
      }

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

    // regression-failed-notification AC2/AC3: NUR bei status:"failed" (echte
    // rote Testfälle, aus summarizeCtrf()) — NIE bei precondition-error/error
    // (die erreichen diesen Codepfad ohnehin nie, s. Modul-Doku #runLifecycle).
    // Best-effort, non-fatal (DrainNotifier#notifyRegressionFailed wirft nie).
    if (status === 'failed') {
      this.#notifyRegressionFailed(job, counts);
    }

    // AC9/AC10: Ergebnis-Übergabe geschieht strukturell über #finish (EIN
    // aggregierter Datensatz, A1) — #finish selbst darf NICHT notifizieren
    // (s. Modul-Doku, Notify-Naht bleibt strukturell auf summarizeCtrf()
    // beschränkt).
    this.#finish(runId, status, { counts, durationMs, target: 'local', ctrf });
  }

  /**
   * Löst das für den gewählten Scope deklarierte `target` auf (AC11) — über
   * DIESELBE Lese-Boundary wie der Ausführen-Dialog (`readRegressionSuites`,
   * AC4/AC6, kein zweiter Parser). `gesamt` mischt Testobjekte und läuft
   * IMMER über den local-Pfad (Bestandsverhalten, AC11 letzter Satz) —
   * `readRegressionSuites` wird dafür gar nicht erst aufgerufen. Fehlt das
   * `target` (keine/unlesbare Begleitbeschreibung, Suite nicht (mehr)
   * gefunden, Lesefehler) → konservativ `'local'`.
   *
   * @param {string} projectPath
   * @param {{ typ: 'bereich'|'verbund'|'gesamt', id?: string }} scope
   * @returns {Promise<string>} `'local'` oder der roh deklarierte `target`-Wert.
   */
  async #resolveTarget(projectPath, scope) {
    if (scope.typ === 'gesamt') return 'local';
    let result;
    try {
      result = await this.#readSuites(projectPath);
    } catch {
      return 'local'; // Lesefehler -> konservativ local (AC11)
    }
    const suites = Array.isArray(result?.suites) ? result.suites : [];
    const match = suites.find((s) => {
      if (!s?.scope || s.scope.typ !== scope.typ) return false;
      return scope.typ === 'bereich' ? s.scope.id === scope.id : true;
    });
    return match?.target ?? 'local'; // kein target deklariert -> konservativ local (AC11)
  }

  /**
   * Stößt best-effort GENAU EINEN `regression_failed`-Push an
   * (regression-failed-notification AC1–AC4). No-op ohne injizierten
   * `#notifier` (Default-Regress, degradiert auf reines Lauf-Ergebnis ohne
   * Push). Fire-and-forget — ein Fehler des Notifiers darf den Lauf-Abschluss
   * nie beeinträchtigen (der Notifier selbst fängt bereits alle Fehler,
   * dieser Wrapper ist zusätzliche Tiefenverteidigung).
   *
   * @param {{ projekt: string, suite: string }} job
   * @param {{ failed: number, total: number }} counts
   */
  #notifyRegressionFailed(job, counts) {
    if (!this.#notifier || typeof this.#notifier.notifyRegressionFailed !== 'function') return;
    try {
      this.#notifier
        .notifyRegressionFailed({ projekt: job.projekt, suite: job.suite, failed: counts.failed, total: counts.total })
        .catch((err) => {
          console.error('[RegressionRunner] regression_failed-Push fehlgeschlagen (best-effort):', err?.message ?? String(err));
        });
    } catch (err) {
      console.error('[RegressionRunner] regression_failed-Push fehlgeschlagen (best-effort):', err?.message ?? String(err));
    }
  }

  /**
   * Frisch-Ausrollen (AC7): liest `image`/`container_port` aus dem
   * Projekt-Profil und ruft `LocalDockerControl#pullAndRecreate` (bestehende
   * cicd/preview-Rollout-Mechanik, kein neuer Rollout-Pfad). Kein `image`
   * auffindbar → best-effort übersprungen (kein Fehler, degradiert auf reine
   * Erreichbarkeitsprüfung — Edge-Case „kein Profil"). Pull-/Start-Fehler →
   * `error` mit Grund; Readiness-Timeout → `precondition-error` (Edge-Cases
   * §Spec). Der Container-Name wird NICHT aus dem rohen, case-erhaltenden
   * `job.projekt`-Slug übernommen, sondern aus `rolloutConfig.image` exakt
   * nach der `/preview up`-Konvention abgeleitet (`deriveContainerNameFromImage`,
   * letztes Image-Segment, lowercase) — sonst greift `pullAndRecreate` bei
   * Projekten mit Großbuchstaben im Repo-Namen am laufenden Preview-Container
   * vorbei (Review-Fix S-310 Iteration 2).
   *
   * @param {{ projectPath: string, projekt: string }} job
   * @param {number} port - `preview_port` (Host-Port).
   * @returns {Promise<{ ok: true } | { ok: false, status: 'error'|'precondition-error', reason: string } | undefined>}
   */
  async #performFreshRollout(job, port) {
    const rolloutConfig = await this.#readRolloutConfig(job.projectPath, { readFile: this.#readFile });
    if (!rolloutConfig || !rolloutConfig.image) {
      // Kein Profil/kein image auffindbar — best-effort übersprungen, kein Crash.
      return undefined;
    }
    try {
      const { ready } = await this.#dockerControl.pullAndRecreate({
        image: rolloutConfig.image,
        containerName: deriveContainerNameFromImage(rolloutConfig.image),
        hostPort: port,
        containerPort: rolloutConfig.containerPort ?? port,
      });
      if (!ready) {
        return { ok: false, status: 'precondition-error', reason: ROLLOUT_NOT_READY_MESSAGE };
      }
      return { ok: true };
    } catch (err) {
      const reason = err?.errorClass ? `${ROLLOUT_FAILURE_MESSAGE}: ${err.errorClass}` : ROLLOUT_FAILURE_MESSAGE;
      return { ok: false, status: 'error', reason };
    }
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
   * Übergibt EINEN Lauf-Datensatz an den `RegressionResultStore` (AC9/AC10,
   * best-effort — ein Store-Fehler crasht den Runner nicht, der Lauf-Status
   * selbst bleibt korrekt, nur die Persistenz kann fehlen). Wird
   * AUSSCHLIESSLICH von `#finish` gerufen (strukturelle Garantie AC10: JEDER
   * terminale Zustand — auch ein Frühausfall ohne CTRF — landet hier genau
   * einmal). Ohne CTRF (Frühausfall) wird `ctrf: null` übergeben (KEIN
   * synthetisches Ersatz-CTRF, [[regression-result-store]] AC1b); `reason`
   * wird NUR bei `precondition-error`/`error` gesetzt.
   *
   * S-327: `artifactsSourceDir` wird IMMER (unabhängig vom Status) als der
   * validierte, absolute Projekt-Klon-Pfad übergeben — der Store entscheidet
   * selbst (Rot/Grün-Default, `REGRESSION_KEEP_ARTIFACTS_ON_PASS`, Retention),
   * ob + welche Artefakte er daraus in seine eigene Lauf-Ablage kopiert
   * (docs/specs/regression-result-store.md AC3). Dieser Runner selbst baut
   * KEINE `artifacts`-Referenz mehr.
   *
   * @param {{ projekt: string, suite: string, scopeTyp: string, projectPath: string }} job
   * @param {'passed'|'failed'|'precondition-error'|'error'} status
   * @param {{ counts?: object, ctrf?: object, durationMs?: number, reason?: string }} patch
   */
  async #persistToStore(job, status, { counts, ctrf, durationMs, reason }) {
    if (!this.#resultStore || typeof this.#resultStore.record !== 'function') return;
    try {
      const input = {
        projekt: job.projekt,
        suite: job.suite,
        scopeTyp: job.scopeTyp,
        status,
        startedAt: new Date(Date.now() - (durationMs ?? 0)).toISOString(),
        durationMs: durationMs ?? 0,
        counts: counts ?? { passed: 0, failed: 0, total: 0 },
        // AC10/AC1b: kein CTRF bei einem Frühausfall -> ctrf:null, KEIN
        // synthetisches Ersatz-CTRF.
        ctrf: ctrf ?? null,
        // S-327: artifactsSourceDir IMMER übergeben — der Store entscheidet
        // selbst über Kopie/Retention/Relativierung. Der Runner baut keine
        // artifacts-Referenz mehr (bei Frühausfall existiert im Klon ohnehin
        // kein playwright-report/ — fs.cp ist best-effort, kein Crash).
        artifactsSourceDir: job.projectPath,
      };
      // AC1b: reason NUR bei precondition-error/error (bei passed/failed abwesend).
      if ((status === 'precondition-error' || status === 'error') && reason) {
        input.reason = reason;
      }
      await this.#resultStore.record(input);
    } catch (err) {
      console.error('[RegressionRunner] Ergebnis-Übergabe fehlgeschlagen:', err?.message ?? String(err));
    }
  }

  /**
   * Setzt einen Lauf terminal, gibt das Lock frei (immer), schreibt genau
   * EINEN Ende-/Fehler-Audit-Eintrag (secret-frei) und übergibt best-effort
   * GENAU EINEN Datensatz an den `RegressionResultStore` (AC10, S-326) —
   * strukturell für JEDEN terminalen Zustand, auch ohne CTRF (Frühausfall).
   * Reihenfolge (bindend, Modul-Doku): Status → Lock-Freigabe → Audit →
   * Store — Lock-Freigabe VOR dem best-effort-Store-Schreibzugriff, damit ein
   * hängender/fehlschlagender Store NIE ein Lock hält. `#finish` selbst
   * notifiziert NIE (die Notify-Naht bleibt strukturell auf den
   * `summarizeCtrf()`-Erfolgspfad in `#runLifecycle` beschränkt,
   * regression-failed-notification AC2/AC3).
   *
   * @param {string} runId
   * @param {'passed'|'failed'|'precondition-error'|'error'} status
   * @param {{ counts?: object, ctrf?: object, durationMs?: number, reason?: string, target?: string }} patch
   */
  #finish(runId, status, patch) {
    const job = this.#jobs.get(runId);
    if (!job) return;
    job.status = status;
    if (patch.counts !== undefined) job.counts = patch.counts;
    if (patch.durationMs !== undefined) job.durationMs = patch.durationMs;
    if (patch.reason !== undefined) job.reason = patch.reason;
    if (patch.target !== undefined) job.target = patch.target;

    // Lock IMMER freigeben (terminaler Zustand) — VOR dem Store-Schreibzugriff.
    this.#lock.release(job.projectPath);

    if (status === 'passed') {
      this.#audit(job.identity, `regression-run:done:${runId}`);
    } else {
      this.#audit(job.identity, `regression-run:error:${runId}:${status}`);
    }

    // AC10: strukturelle, ausnahmslose Diagnose-Pflicht — best-effort, ein
    // Store-Fehler darf den Lauf-Abschluss (bereits oben erfolgt) nie
    // verhindern.
    this.#persistToStore(job, status, patch).catch(() => {
      // #persistToStore fängt selbst bereits alle Fehler ab (Sicherheitsnetz).
    });
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
