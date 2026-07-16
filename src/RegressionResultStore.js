/**
 * RegressionResultStore.js — Persistente, größenbegrenzte Regressionslauf-Ablage
 * (docs/specs/regression-result-store.md AC1-AC5).
 *
 * Hält je Regressionslauf ([[regression-run]]) EINEN Datensatz mit dem
 * CTRF-JSON-Ergebnis + Metadaten. Muster: `DrainReportStore.js` — datei-basiert
 * unter `${CRED_STORE_DIR}` (Betreiber-nahe Beobachtbarkeits-Ablage, ADR-005-
 * Linie — kein Fabrik-/Domänen-State), atomarer tmp+rename-Schreibzugriff,
 * `0600`; ohne `CRED_STORE_DIR` In-Memory-Degradation (kein Crash).
 *
 * Abweichend von `DrainReportStore` (EINE Sammel-Datei) liegt hier JE LAUF eine
 * eigene Datei unter `${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>.json`
 * — CTRF-JSON-Ergebnisse können deutlich größer werden als ein Drain-Bericht,
 * und ein korruptes/teilweises Datei-Set darf nur DIESEN einen Lauf betreffen
 * (Edge-Case AC: „Rest bleibt lesbar“), nicht die gesamte Sammlung.
 *
 * Datensatz-Schema (AC1/AC1b, verbindlich):
 *   { runId, projekt, suite, scopeTyp: "bereich"|"verbund"|"gesamt",
 *     status: "passed"|"failed"|"precondition-error"|"error", startedAt,
 *     durationMs, counts:{passed,failed,total}, ctrf: <CTRF-JSON>|null,
 *     reason?: string, artifacts?: { htmlReport, testResults } }
 *   - `artifacts` KANN bei JEDEM Status vorkommen (S-327 — die frühere
 *     „nur bei Rot“-Regel ist aufgehoben, s. „Artefakte kopieren“ unten).
 *   - `projekt` = Projekt-Slug (kein absoluter Pfad).
 *   - Frühausfall-Datensatz (AC1b, S-326): bei `status:"precondition-error"|
 *     "error"` ist `ctrf: null` (KEIN synthetisches Ersatz-CTRF), `counts`
 *     `{0,0,0}` und `reason` eine secret-freie Kurzbegründung (fehlt sie im
 *     Input, bleibt der Datensatz ohne `reason`, kein Crash). Bei
 *     `status:"passed"|"failed"` ist `reason` abwesend.
 *
 * Ablage: ${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>.json
 * Rechte: 0600
 * Schreiben: atomar (tmp + rename)
 *
 * Artefakte kopieren (S-327, wesentlicher Befund der Vorklärung 2026-07-16):
 * Playwright-Debug-Artefakte (`playwright-report/`, `test-results/`) liegen im
 * PROJEKT-KLON und werden dort vom NÄCHSTEN Lauf überschrieben — eine reine
 * Pfad-REFERENZ (wie bis S-326) ist deshalb nach dem Folgelauf falsch. Dieser
 * Store KOPIERT die Artefakte deshalb beim `record()` (best-effort, `fs.cp`
 * rekursiv) aus dem übergebenen `artifactsSourceDir` (Projekt-Klon-Root) in
 * seine EIGENE Lauf-Ablage `${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>/`
 * — unter Beibehaltung der Klon-Ordnernamen (`playwright-report/`,
 * `test-results/`). Das im CTRF-JSON enthaltene `tests[].attachments[].path`
 * (vom Reporter `playwright-ctrf-json-reporter` mit ABSOLUTEN Pfaden gesetzt)
 * wird dabei auf einen zur Lauf-Artefakt-Ablage RELATIVEN Pfad umgeschrieben
 * (Security-Floor: kein absoluter Server-Pfad in der Response) — DIESE
 * Relativierung läuft IMMER, sobald `artifactsSourceDir` übergeben wird
 * (unabhängig von Status und `REGRESSION_KEEP_ARTIFACTS_ON_PASS`); NUR die
 * eigentliche Datei-Kopie ist an die Rot/Grün-Default-Entscheidung gekoppelt
 * (Review-Fix Iteration 2 — sonst bliebe `ctrf` bei abgeschalteten
 * Grün-Artefakten mit absoluten Pfaden stehen und würde über GET .../:runId
 * geleakt). Da die
 * Klon-Ordnernamen erhalten bleiben, ist der umgeschriebene Pfad ohne weitere
 * Umrechnung der Rest-Pfad des Artefakt-Endpunkts (`regressionRuns.js`, Naht
 * für [[regression-result-view]]/S-328). Attachments AUSSERHALB des
 * Projekt-Klons (kein gültiger absoluter Pfad unter `artifactsSourceDir`)
 * werden NICHT durchgereicht (gefiltert). Ein Kopier-Fehler (z.B. Quellordner
 * fehlt) ist best-effort/non-fatal — der Lauf-Datensatz selbst geht dadurch
 * NIE verloren, es fehlt lediglich der jeweilige `artifacts`-Schlüssel.
 *
 * Zwei getrennte Retentions (Owner-Entscheidung 2026-07-16, Plattenbremse):
 *   - Lauf-Retention      `MAX_RUNS_PER_PROJECT` (50, AC2, unverändert) —
 *     Datensätze (CTRF-JSON + Metadaten, klein).
 *   - Artefakt-Retention  `REGRESSION_ARTIFACT_RETENTION` (Default 10, AC3) —
 *     die schwereren Artefakt-Ordner. Gedeckelt auf höchstens die
 *     Lauf-Retention (ein größerer Wert wird auf 50 begrenzt).
 * Auto-Prune (idempotent, bei jedem `record()`):
 *   - Lauf 1..Artefakt-Retention (jüngste): Datensatz + Artefakte.
 *   - Lauf jenseits der Artefakt-Retention, aber innerhalb der Lauf-Retention:
 *     Datensatz bleibt, der Artefakt-Ordner wird entfernt UND die
 *     `artifacts`-Referenz aus dem Datensatz entfernt (keine toten
 *     Referenzen, keine verwaisten Ordner).
 *   - Lauf jenseits der Lauf-Retention: Datensatz + Artefakte komplett weg.
 * Artefakte bei GRÜN (AC3): Default AN — abschaltbar via
 * `REGRESSION_KEEP_ARTIFACTS_ON_PASS=false` (dann: Artefakte nur bei Rot,
 * das frühere Verhalten). Bei `status:"failed"` werden Artefakte IMMER
 * versucht (unabhängig von diesem Schalter).
 *
 * Nebenläufigkeit: `record()`-Aufrufe werden je Store-Instanz über eine
 * In-Process-Promise-Kette serialisiert (kein Read-Modify-Write-Race);
 * verschiedene Projekte kollidieren ohnehin nie (getrennte Unterordner).
 *
 * Robustheit (NFR): Store-/Schreibfehler sind best-effort möglich — ein
 * einzelner korrupter/unvollständiger Lauf-Datensatz wird beim Laden
 * übersprungen (degradierend), der Rest bleibt lesbar (kein Crash der
 * gesamten Liste). Ist `CRED_STORE_DIR` NICHT gesetzt, degradiert der Store
 * auf reinen In-Memory-Betrieb (Läufe im Prozess sichtbar, aber nicht
 * persistiert, KEINE Artefakt-Kopie möglich) statt zu werfen.
 *
 * Security (Floor): keine Secrets/Tokens in Datensatz/Response/Log; `projekt`
 * wird gegen einen Slug-Form-Check gehärtet (kein Pfad-Traversal), `runId`
 * ebenso vor jeder Artefakt-Ordner-Auflösung; das CTRF-JSON wird unverändert
 * übernommen (Security-Verantwortung für dessen Inhalt liegt beim Runner,
 * agent-flow `regression-runner` AC9) — NUR die Attachment-Pfade werden
 * relativiert (s.o.), keine absoluten Server-Pfade in Response/Datei.
 *
 * @module RegressionResultStore
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink, readdir, rm, cp } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/** Harte Pro-Projekt-Grenze (AC2): ältere Läufe fallen beim Schreiben heraus. */
export const MAX_RUNS_PER_PROJECT = 50;

/** Default Artefakt-Retention je Projekt (AC3, Owner-Entscheidung 2026-07-16). */
export const DEFAULT_ARTIFACT_RETENTION = 10;

/** Ordnername des HTML-Reports im Projekt-Klon (agent-flow `regression-playwright-conventions` AC6/Layout). */
export const HTML_REPORT_DIRNAME = 'playwright-report';

/** Ordnername der Testergebnis-/Attachment-Ablage im Projekt-Klon (CTRF-JSON + Screenshots/Traces/Videos je Test). */
export const TEST_RESULTS_DIRNAME = 'test-results';

/** Erlaubter Scope-Typ-Wert (Vertrag, spec §Verträge). */
export const SCOPE_TYPES = Object.freeze(['bereich', 'verbund', 'gesamt']);

/** Erlaubter Status-Wert (AC1/AC1b/AC3) — identisch zu den terminalen Zuständen des GET-Vertrags ([[regression-run]] §Verträge). */
export const STATUSES = Object.freeze(['passed', 'failed', 'precondition-error', 'error']);

/** Erlaubter Projekt-Slug: nur Buchstaben, Ziffern, `-` und `_` (analog DrainReportStore). */
export const PROJECT_SLUG_RE = /^[A-Za-z0-9_-]+$/;

/** Erlaubte `runId`-Zeichen (defensiv vor jedem Pfad-Sink, das aus `runId` einen Ordner-/Dateinamen baut). */
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @typedef {object} RegressionCounts
 * @property {number} passed
 * @property {number} failed
 * @property {number} total
 *
 * @typedef {object} RegressionArtifacts
 * @property {string} [htmlReport]
 * @property {string} [testResults]
 *
 * @typedef {object} RegressionRun
 * @property {string} runId
 * @property {string} projekt   Projekt-Slug (kein Pfad)
 * @property {string} suite
 * @property {'bereich'|'verbund'|'gesamt'} scopeTyp
 * @property {'passed'|'failed'|'precondition-error'|'error'} status
 * @property {string} startedAt ISO-8601
 * @property {number} durationMs
 * @property {RegressionCounts} counts
 * @property {*|null} ctrf CTRF-JSON, Attachment-Pfade relativiert (s. Modul-Doku);
 *   `null` bei einem Frühausfall-Datensatz (AC1b, KEIN synthetisches Ersatz-CTRF)
 * @property {string} [reason] NUR bei status:"precondition-error"|"error" (AC1b)
 * @property {RegressionArtifacts} [artifacts] Referenz auf die Lauf-eigene Artefakt-Ablage (jeder Status, S-327)
 */

/**
 * Liest das Basisverzeichnis der Regressionslauf-Ablage aus der Umgebung.
 * Pfad: ${CRED_STORE_DIR}/regression-runs
 *
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveRegressionRunsDir() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'regression-runs');
}

/**
 * Liefert das Projekt-Unterverzeichnis für einen validierten Slug, oder null
 * (kein CRED_STORE_DIR ODER ungültiger Slug).
 *
 * @param {string} projekt
 * @returns {string|null}
 */
function _resolveProjectDir(projekt) {
  const base = resolveRegressionRunsDir();
  if (!base) return null;
  if (typeof projekt !== 'string' || !PROJECT_SLUG_RE.test(projekt)) return null;
  return join(base, projekt);
}

/**
 * Liest die konfigurierte Artefakt-Retention (AC3, `REGRESSION_ARTIFACT_RETENTION`,
 * Default `DEFAULT_ARTIFACT_RETENTION`), gedeckelt auf höchstens die
 * Lauf-Retention (`MAX_RUNS_PER_PROJECT`) — ein größerer/ungültiger Wert wird
 * begrenzt bzw. verworfen (kein Crash durch Tippfehler in der Env).
 *
 * @returns {number}
 */
function _resolveArtifactRetention() {
  const raw = Number(process.env.REGRESSION_ARTIFACT_RETENTION);
  const value = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ARTIFACT_RETENTION;
  return Math.min(value, MAX_RUNS_PER_PROJECT);
}

/**
 * Entscheidet, ob für einen Lauf mit gegebenem Status Artefakte versucht
 * werden sollen (AC3): bei `failed` IMMER; bei `passed` per Default AN,
 * abschaltbar via `REGRESSION_KEEP_ARTIFACTS_ON_PASS=false`.
 *
 * @param {'passed'|'failed'} status
 * @returns {boolean}
 */
function _shouldAttemptArtifacts(status) {
  if (status === 'failed') return true;
  return process.env.REGRESSION_KEEP_ARTIFACTS_ON_PASS !== 'false';
}

/**
 * Normalisiert die Zähler auf `{passed,failed,total}` (Security-/Daten-Hygiene
 * — kein Durchreichen beliebiger Felder).
 *
 * @param {unknown} counts
 * @returns {RegressionCounts}
 */
function _normalizeCounts(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  return {
    passed: Number.isFinite(c.passed) ? c.passed : 0,
    failed: Number.isFinite(c.failed) ? c.failed : 0,
    total: Number.isFinite(c.total) ? c.total : 0,
  };
}

/**
 * Normalisiert die Artefakt-Referenz auf `{htmlReport?,testResults?}` — nur
 * String-Pfade, kein Durchreichen beliebiger Felder. Wird NUR beim Laden
 * einer bereits persistierten Datei angewandt (Defensive gegen ein
 * korruptes/fremd geschriebenes Datei-Set) — beim `record()` selbst baut
 * `#captureArtifacts` das Feld direkt aus den festen Ordnernamen.
 *
 * @param {unknown} artifacts
 * @returns {RegressionArtifacts|undefined}
 */
function _normalizeArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== 'object') return undefined;
  const out = {};
  if (typeof artifacts.htmlReport === 'string' && artifacts.htmlReport) {
    out.htmlReport = artifacts.htmlReport;
  }
  if (typeof artifacts.testResults === 'string' && artifacts.testResults) {
    out.testResults = artifacts.testResults;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Relativiert EINEN CTRF-Attachment-Eintrag gegen `sourceDir` (Projekt-Klon-
 * Root) — oder liefert `null`, wenn der Eintrag nicht durchgereicht werden
 * darf (kein String-Pfad, kein absoluter Pfad, oder außerhalb `sourceDir`).
 * Security-Floor: kein absoluter Server-Pfad im Ergebnis.
 *
 * @param {{name?: string, contentType?: string, path?: string}} attachment
 * @param {string} sourceDir
 * @returns {{name?: string, contentType?: string, path: string}|null}
 */
function _relativizeAttachment(attachment, sourceDir) {
  const p = attachment?.path;
  if (typeof p !== 'string' || !p || !isAbsolute(p)) return null;
  const rel = relative(sourceDir, p);
  if (!rel || rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return { ...attachment, path: rel };
}

/**
 * Schreibt eine (deep-geklonte) Kopie des CTRF-JSON mit relativierten
 * `tests[].attachments[].path`-Einträgen (s. Modul-Doku „Artefakte
 * kopieren“). Tolerant gegenüber abweichendem/fehlendem Schema (kein Crash).
 *
 * @param {*} ctrf
 * @param {string} sourceDir
 * @returns {*}
 */
function _rewriteCtrfAttachments(ctrf, sourceDir) {
  if (!ctrf || typeof ctrf !== 'object') return ctrf;
  const tests = ctrf?.results?.tests;
  if (!Array.isArray(tests)) return ctrf;
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(ctrf));
  } catch {
    return ctrf; // nicht serialisierbar (sollte nie vorkommen) → unverändert lassen
  }
  for (const test of clone.results.tests) {
    if (!Array.isArray(test.attachments)) continue;
    test.attachments = test.attachments
      .map((a) => _relativizeAttachment(a, sourceDir))
      .filter(Boolean);
  }
  return clone;
}

export class RegressionResultStore {
  /**
   * @type {Map<string, RegressionRun[]>|null} In-Memory-Cache je Projekt-Slug;
   *   null bis erstmals geladen.
   */
  #runsByProject = null;
  /** @type {Promise<void>|null} einmaliger Lade-Vorgang (idempotent). */
  #loadPromise = null;
  /** @type {Promise<*>} Serialisierungs-Kette für record() (kein Read-Modify-Write-Race). */
  #queue = Promise.resolve();

  /**
   * Lädt alle persistierten Läufe einmalig in den In-Memory-Cache. Fehlt das
   * Basisverzeichnis (ENOENT) → leerer Cache (kein Crash — best-effort). Ein
   * korruptes/teilweises Datei-Set EINES Laufs wird übersprungen, der Rest
   * bleibt lesbar (Edge-Case AC).
   *
   * @returns {Promise<void>}
   */
  async #ensureLoaded() {
    if (this.#runsByProject !== null) return;
    if (!this.#loadPromise) this.#loadPromise = this.#load();
    await this.#loadPromise;
  }

  /** @returns {Promise<void>} */
  async #load() {
    this.#runsByProject = new Map();
    const base = resolveRegressionRunsDir();
    if (!base) return; // Kein CRED_STORE_DIR → reiner In-Memory-Betrieb (degradiert, non-fatal).

    let projectDirs;
    try {
      projectDirs = await readdir(base, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[RegressionResultStore] Basisverzeichnis nicht lesbar:', err.message);
      }
      return;
    }

    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const projekt = entry.name;
      if (!PROJECT_SLUG_RE.test(projekt)) continue; // defensiv, sollte nie vorkommen

      const projectPath = join(base, projekt);
      let files;
      try {
        files = await readdir(projectPath);
      } catch {
        continue; // Verzeichnis nicht lesbar → dieses Projekt überspringen (Rest bleibt lesbar)
      }

      const runs = [];
      for (const filename of files) {
        if (!filename.endsWith('.json') || filename.includes('.tmp.')) continue;
        try {
          const raw = await readFile(join(projectPath, filename), 'utf8');
          const parsed = JSON.parse(raw);
          const run = _normalizeRun(parsed, projekt);
          if (run) runs.push(run);
        } catch {
          // Korruptes/teilweises Datei-Set → dieser Datensatz wird übersprungen
          // (Edge-Case AC), Rest bleibt lesbar. Kein Roh-Fehlertext mit Pfad im Log.
          console.error(
            `[RegressionResultStore] Lauf-Datensatz übersprungen (korrupt): ${filename}`,
          );
        }
      }
      this.#runsByProject.set(projekt, runs);
    }
  }

  /**
   * Legt einen Lauf-Datensatz an (AC1): generiert `runId` falls nicht
   * mitgegeben, kopiert (best-effort) Debug-Artefakte aus `artifactsSourceDir`
   * in die eigene Lauf-Ablage (AC3, Modul-Doku „Artefakte kopieren“),
   * schneidet je Projekt-Slug auf die letzten `MAX_RUNS_PER_PROJECT` Läufe
   * (AC2) UND die letzten `REGRESSION_ARTIFACT_RETENTION` Artefakt-Ordner
   * zurück (AC3, Auto-Prune) und schreibt die Datei atomar. Serialisiert
   * über eine In-Process-Kette.
   *
   * @param {object} input
   * @param {string} input.projekt Projekt-Slug (kein Pfad) — Pflicht.
   * @param {string} [input.runId] optional; wird generiert falls fehlend.
   * @param {string} input.suite
   * @param {'bereich'|'verbund'|'gesamt'} input.scopeTyp
   * @param {'passed'|'failed'|'precondition-error'|'error'} input.status
   * @param {string} [input.startedAt]
   * @param {number} [input.durationMs]
   * @param {RegressionCounts} [input.counts]
   * @param {*|null} [input.ctrf] CTRF-JSON (Attachment-Pfade werden relativiert, s. Modul-Doku); `null`/fehlend bei Frühausfall (AC1b).
   * @param {string} [input.reason] secret-freie Kurzbegründung — nur bei status:"precondition-error"|"error" wirksam (AC1b).
   * @param {string} [input.artifactsSourceDir] absoluter Projekt-Klon-Pfad, aus dem
   *   `playwright-report/`/`test-results/` kopiert werden (best-effort, wenn vorhanden).
   * @returns {Promise<RegressionRun>} der geschriebene Lauf.
   * @throws {Error} wenn `projekt` kein gültiger Slug, `scopeTyp`/`status` ungültig ist.
   */
  record(input) {
    const run = () => this.#doRecord(input);
    // .then(run, run): eine vorherige Rejection blockiert die Kette nicht.
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }

  /**
   * @param {object} input
   * @returns {Promise<RegressionRun>}
   */
  async #doRecord(input) {
    const projekt = input?.projekt;
    if (typeof projekt !== 'string' || !PROJECT_SLUG_RE.test(projekt)) {
      throw new Error('[RegressionResultStore] Ungültiger projekt-Slug — Lauf nicht geschrieben.');
    }
    const scopeTyp = SCOPE_TYPES.includes(input?.scopeTyp) ? input.scopeTyp : null;
    if (!scopeTyp) {
      throw new Error('[RegressionResultStore] Ungültiger scopeTyp — erlaubt: bereich|verbund|gesamt.');
    }
    const status = STATUSES.includes(input?.status) ? input.status : null;
    if (!status) {
      throw new Error('[RegressionResultStore] Ungültiger status — erlaubt: passed|failed|precondition-error|error.');
    }

    await this.#ensureLoaded();

    const runId = typeof input.runId === 'string' && input.runId ? input.runId : randomUUID();

    /** @type {RegressionRun} */
    const run = {
      runId,
      projekt,
      suite: typeof input.suite === 'string' ? input.suite : '',
      scopeTyp,
      status,
      startedAt: typeof input.startedAt === 'string' ? input.startedAt : '',
      durationMs: Number.isFinite(input.durationMs) ? input.durationMs : 0,
      counts: _normalizeCounts(input.counts),
      // AC1b: Frühausfall (precondition-error/error) trägt IMMER ctrf:null —
      // KEIN synthetisches Ersatz-CTRF, auch wenn der Aufrufer fälschlich
      // eines mitgäbe.
      ctrf: status === 'precondition-error' || status === 'error' ? null : (input.ctrf ?? null),
    };

    const sourceDir =
      typeof input.artifactsSourceDir === 'string' && input.artifactsSourceDir
        ? input.artifactsSourceDir
        : null;

    // Security-Floor (AC5, HART — unabhängig von Status/Retention-Flag): die
    // CTRF-Attachment-Pfade werden relativiert, SOBALD ein sourceDir vorliegt
    // — auch wenn KEINE Artefakte kopiert werden (z.B. status:"passed" +
    // REGRESSION_KEEP_ARTIFACTS_ON_PASS=false). Ohne diese Entkopplung bliebe
    // der rohe Reporter-Output mit ABSOLUTEN Server-Pfaden im persistierten
    // Datensatz stehen und würde über GET .../:runId geleakt (Review-Fix
    // Iteration 2 — Critical).
    if (sourceDir) {
      run.ctrf = _rewriteCtrfAttachments(run.ctrf, sourceDir);
    }

    // AC3 (S-327): NUR die eigentliche Datei-Kopie bleibt hinter Rot/Grün-
    // Default + Retention-Flag gegated — die Pfad-Relativierung oben nicht.
    if (sourceDir && _shouldAttemptArtifacts(status) && RUN_ID_RE.test(runId)) {
      const artifacts = await this.#copyArtifacts(projekt, runId, sourceDir);
      if (artifacts) run.artifacts = artifacts;
    }
    // AC1b: reason NUR bei precondition-error/error (bei passed/failed abwesend).
    if ((status === 'precondition-error' || status === 'error') && typeof input.reason === 'string' && input.reason) {
      run.reason = input.reason;
    }

    const existing = this.#runsByProject.get(projekt) ?? [];
    const updated = [...existing, run];
    this.#runsByProject.set(projekt, updated);

    // Lauf-Retention (AC2, unverändert): höchstens MAX_RUNS_PER_PROJECT
    // Datensätze DIESES Projekts — die ältesten fallen komplett heraus
    // (inkl. ihrer Artefakte, keine verwaisten Ordner).
    let toDelete = [];
    if (updated.length > MAX_RUNS_PER_PROJECT) {
      toDelete = updated.slice(0, updated.length - MAX_RUNS_PER_PROJECT);
      this.#runsByProject.set(projekt, updated.slice(updated.length - MAX_RUNS_PER_PROJECT));
    }

    await this.#persistRun(projekt, run);
    for (const old of toDelete) {
      await this.#deleteRun(projekt, old.runId);
    }

    // Artefakt-Retention (AC3, NEU, Auto-Prune): schwerere Artefakte werden
    // enger begrenzt als die Lauf-Retention — Läufe jenseits der
    // Artefakt-Retention (aber noch innerhalb der Lauf-Retention) behalten
    // nur den Datensatz, ihr Artefakt-Ordner + die `artifacts`-Referenz
    // fallen weg (keine toten Referenzen, keine verwaisten Ordner).
    const kept = this.#runsByProject.get(projekt) ?? [];
    const artifactRetention = _resolveArtifactRetention();
    if (kept.length > artifactRetention) {
      const beyondArtifactWindow = kept.slice(0, kept.length - artifactRetention);
      for (const old of beyondArtifactWindow) {
        if (!old.artifacts) continue;
        delete old.artifacts;
        await this.#removeArtifactDir(projekt, old.runId);
        await this.#persistRun(projekt, old); // Datensatz ohne artifacts neu schreiben (Referenz konsistent).
      }
    }

    return run;
  }

  /**
   * Liefert die Lauf-Liste eines Projekts read-only, absteigend nach
   * `startedAt` (jüngster zuerst) — AC4. Ein ungültiger/traversierender Slug
   * → leere Liste (KEIN Dateizugriff).
   *
   * @param {string} projekt
   * @returns {Promise<RegressionRun[]>}
   */
  async list(projekt) {
    if (typeof projekt !== 'string' || !PROJECT_SLUG_RE.test(projekt)) return [];
    await this.#ensureLoaded();
    const runs = this.#runsByProject.get(projekt) ?? [];
    return [...runs]
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
      .map((r) => _cloneRun(r));
  }

  /**
   * Liefert einen Einzel-Lauf read-only (AC4, inkl. Testfall-Details aus dem
   * CTRF-JSON + Artefakt-Referenz, sofern (noch) vorhanden), oder null wenn
   * nicht vorhanden bzw. Slug ungültig.
   *
   * @param {string} projekt
   * @param {string} runId
   * @returns {Promise<RegressionRun|null>}
   */
  async get(projekt, runId) {
    if (typeof projekt !== 'string' || !PROJECT_SLUG_RE.test(projekt)) return null;
    if (typeof runId !== 'string' || !runId) return null;
    await this.#ensureLoaded();
    const runs = this.#runsByProject.get(projekt) ?? [];
    const found = runs.find((r) => r.runId === runId);
    return found ? _cloneRun(found) : null;
  }

  /**
   * Liefert den absoluten Pfad der Lauf-eigenen Artefakt-Ablage
   * (`${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>`) — für den
   * Artefakt-Zugriffs-Endpunkt (`regressionRuns.js`, [[regression-result-view]]
   * AC2). `null` ohne CRED_STORE_DIR oder bei ungültigem `projekt`-/`runId`-Slug
   * (kein Dateizugriff, kein Leak). Prüft NICHT, ob der Ordner existiert —
   * das übernimmt der Aufrufer (realpath/stat, 404 bei Fehlschlag).
   *
   * @param {string} projekt
   * @param {string} runId
   * @returns {string|null}
   */
  resolveArtifactDir(projekt, runId) {
    const projectDir = _resolveProjectDir(projekt);
    if (!projectDir) return null;
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null;
    return join(projectDir, runId);
  }

  /**
   * Kopiert (best-effort) `playwright-report/`+`test-results/` aus
   * `sourceDir` in die Lauf-eigene Artefakt-Ablage (Modul-Doku „Artefakte
   * kopieren“). Reine Datei-Kopie — die CTRF-Attachment-Relativierung läuft
   * SEPARAT und IMMER in `#doRecord` (Security-Floor AC5, unabhängig davon,
   * ob diese Methode überhaupt aufgerufen wird — Review-Fix Iteration 2).
   * Ohne `CRED_STORE_DIR` (In-Memory-Betrieb) wird NICHT kopiert (keine
   * Ablage vorhanden).
   *
   * @param {string} projekt
   * @param {string} runId
   * @param {string} sourceDir absoluter Projekt-Klon-Pfad.
   * @returns {Promise<RegressionArtifacts|undefined>}
   */
  async #copyArtifacts(projekt, runId, sourceDir) {
    const projectDir = _resolveProjectDir(projekt);
    if (!projectDir) {
      return undefined;
    }
    const runArtifactDir = join(projectDir, runId);

    const artifacts = {};
    if (await this.#copyArtifactSubdir(sourceDir, runArtifactDir, HTML_REPORT_DIRNAME)) {
      artifacts.htmlReport = HTML_REPORT_DIRNAME;
    }
    if (await this.#copyArtifactSubdir(sourceDir, runArtifactDir, TEST_RESULTS_DIRNAME)) {
      artifacts.testResults = TEST_RESULTS_DIRNAME;
    }
    return Object.keys(artifacts).length > 0 ? artifacts : undefined;
  }

  /**
   * Kopiert EINEN Unterordner (`playwright-report`/`test-results`) rekursiv
   * aus `sourceDir` in `runArtifactDir` — best-effort: fehlt der Quellordner
   * (ENOENT, z.B. Runner lieferte keinen HTML-Report), gilt das als "nicht
   * kopiert" (kein Fehler, kein Absturz — Edge-Case AC „Artefakte fehlen“).
   *
   * @param {string} sourceDir
   * @param {string} runArtifactDir
   * @param {string} dirname
   * @returns {Promise<boolean>} true bei erfolgreicher Kopie.
   */
  async #copyArtifactSubdir(sourceDir, runArtifactDir, dirname) {
    const src = join(sourceDir, dirname);
    const dest = join(runArtifactDir, dirname);
    try {
      await cp(src, dest, { recursive: true });
      return true;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[RegressionResultStore] Artefakt-Kopie fehlgeschlagen (${dirname}):`, err.message);
      }
      return false;
    }
  }

  /**
   * Entfernt die Lauf-eigene Artefakt-Ablage (rekursiv, best-effort,
   * non-fatal bei Fehlschlag) — für Prune (Artefakt- oder Lauf-Retention).
   *
   * @param {string} projekt
   * @param {string} runId
   * @returns {Promise<void>}
   */
  async #removeArtifactDir(projekt, runId) {
    const dir = this.resolveArtifactDir(projekt, runId);
    if (!dir) return;
    await rm(dir, { recursive: true, force: true }).catch((err) => {
      console.error('[RegressionResultStore] Artefakt-Ordner-Löschen fehlgeschlagen:', err.message);
    });
  }

  /**
   * Schreibt EINEN Lauf-Datensatz atomar (tmp + rename) unter
   * `${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>.json`. Ohne
   * CRED_STORE_DIR → No-op (In-Memory-Betrieb).
   *
   * @param {string} projekt
   * @param {RegressionRun} run
   * @returns {Promise<void>}
   */
  async #persistRun(projekt, run) {
    const projectDir = _resolveProjectDir(projekt);
    if (!projectDir) return; // degradiert: nur In-Memory (best-effort, kein Crash)

    const filePath = join(projectDir, `${run.runId}.json`);
    const json = JSON.stringify(run, null, 2);
    const tmpPath = join(projectDir, `${run.runId}.json.tmp.${randomBytes(4).toString('hex')}`);

    await mkdir(projectDir, { recursive: true });
    try {
      await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      const e = new Error(`[RegressionResultStore] Atomar-Schreiben fehlgeschlagen: ${err.message}`);
      e.code = err.code;
      throw e;
    }
    try {
      await chmod(filePath, 0o600);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Entfernt einen geprunten Lauf vollständig: den persistierten
   * Lauf-Datensatz UND seine Artefakt-Ablage (keine verwaisten Dateien/
   * Ordner). Best-effort, non-fatal bei Fehlschlag.
   *
   * @param {string} projekt
   * @param {string} runId
   * @returns {Promise<void>}
   */
  async #deleteRun(projekt, runId) {
    const projectDir = _resolveProjectDir(projekt);
    if (projectDir) {
      const filePath = join(projectDir, `${runId}.json`);
      await rm(filePath, { force: true }).catch((err) => {
        console.error('[RegressionResultStore] Prune-Löschen fehlgeschlagen:', err.message);
      });
    }
    await this.#removeArtifactDir(projekt, runId);
  }
}

/**
 * Normalisiert einen roh geladenen/übergebenen Lauf-Datensatz auf das
 * verbindliche Schema (AC1). Liefert `null` bei fundamental ungültiger Form
 * (kein Objekt / fehlende Pflichtfelder) — der Aufrufer überspringt diesen
 * Datensatz dann (Edge-Case AC: korruptes/teilweises Datei-Set).
 *
 * @param {unknown} raw
 * @param {string} projekt Erwarteter Projekt-Slug (Ordner-Herkunft).
 * @returns {RegressionRun|null}
 */
function _normalizeRun(raw, projekt) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.runId !== 'string' || !raw.runId) return null;
  if (!STATUSES.includes(raw.status)) return null;
  const scopeTyp = SCOPE_TYPES.includes(raw.scopeTyp) ? raw.scopeTyp : 'gesamt';

  /** @type {RegressionRun} */
  const run = {
    runId: raw.runId,
    projekt,
    suite: typeof raw.suite === 'string' ? raw.suite : '',
    scopeTyp,
    status: raw.status,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    durationMs: Number.isFinite(raw.durationMs) ? raw.durationMs : 0,
    counts: _normalizeCounts(raw.counts),
    // AC1b: Frühausfall-Datensatz trägt IMMER ctrf:null beim Rückladen.
    ctrf: raw.status === 'precondition-error' || raw.status === 'error' ? null : (raw.ctrf ?? null),
  };
  // AC3 (S-327): artifacts kann bei JEDEM Status vorkommen (frühere
  // "nur bei failed"-Gate beim Laden entfernt).
  const artifacts = _normalizeArtifacts(raw.artifacts);
  if (artifacts) run.artifacts = artifacts;
  // AC1b (S-326): reason NUR bei precondition-error/error; Edge-Case "ohne reason" →
  // Datensatz bleibt gültig, reason fehlt einfach (kein Crash).
  if ((raw.status === 'precondition-error' || raw.status === 'error') && typeof raw.reason === 'string' && raw.reason) {
    run.reason = raw.reason;
  }
  return run;
}

/**
 * Deep-copy für read-only Semantik (verhindert externe Mutation des Caches).
 *
 * @param {RegressionRun} run
 * @returns {RegressionRun}
 */
function _cloneRun(run) {
  const clone = {
    ...run,
    counts: { ...run.counts },
    ctrf: run.ctrf && typeof run.ctrf === 'object' ? JSON.parse(JSON.stringify(run.ctrf)) : run.ctrf,
  };
  if (run.artifacts) clone.artifacts = { ...run.artifacts };
  return clone;
}
