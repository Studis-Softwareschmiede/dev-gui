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
 * Datensatz-Schema (AC1, verbindlich):
 *   { runId, projekt, suite, scopeTyp: "bereich"|"verbund"|"gesamt",
 *     status: "passed"|"failed", startedAt, durationMs,
 *     counts:{passed,failed,total}, ctrf: <CTRF-JSON>,
 *     artifacts?: { htmlReport, traces } }
 *   - `artifacts` NUR bei `status:"failed"` (AC3) — grüne Läufe halten nur
 *     CTRF-JSON + Metadaten (keine schweren Artefakte).
 *   - `projekt` = Projekt-Slug (kein absoluter Pfad).
 *
 * Ablage: ${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>.json
 * Rechte: 0600
 * Schreiben: atomar (tmp + rename)
 *
 * Retention (AC2): je Projekt werden höchstens `MAX_RUNS_PER_PROJECT` (50)
 * Läufe behalten — beim `record()` fallen ältere Läufe DIESES Projekts
 * automatisch heraus (Auto-Prune, idempotent), inkl. ihrer Dateien.
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
 * persistiert) statt zu werfen.
 *
 * Security (Floor): keine Secrets/Tokens in Datensatz/Response/Log; `projekt`
 * wird gegen einen Slug-Form-Check gehärtet (kein Pfad-Traversal); das
 * CTRF-JSON wird unverändert übernommen (Security-Verantwortung für dessen
 * Inhalt liegt beim Runner, agent-flow `regression-runner` AC9).
 *
 * @module RegressionResultStore
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/** Harte Pro-Projekt-Grenze (AC2): ältere Läufe fallen beim Schreiben heraus. */
export const MAX_RUNS_PER_PROJECT = 50;

/** Erlaubter Scope-Typ-Wert (Vertrag, spec §Verträge). */
export const SCOPE_TYPES = Object.freeze(['bereich', 'verbund', 'gesamt']);

/** Erlaubter Status-Wert (AC1/AC3). */
export const STATUSES = Object.freeze(['passed', 'failed']);

/** Erlaubter Projekt-Slug: nur Buchstaben, Ziffern, `-` und `_` (analog DrainReportStore). */
export const PROJECT_SLUG_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @typedef {object} RegressionCounts
 * @property {number} passed
 * @property {number} failed
 * @property {number} total
 *
 * @typedef {object} RegressionArtifacts
 * @property {string} [htmlReport]
 * @property {string} [traces]
 *
 * @typedef {object} RegressionRun
 * @property {string} runId
 * @property {string} projekt   Projekt-Slug (kein Pfad)
 * @property {string} suite
 * @property {'bereich'|'verbund'|'gesamt'} scopeTyp
 * @property {'passed'|'failed'} status
 * @property {string} startedAt ISO-8601
 * @property {number} durationMs
 * @property {RegressionCounts} counts
 * @property {*} ctrf CTRF-JSON, unverändert übernommen
 * @property {RegressionArtifacts} [artifacts] NUR bei status:"failed"
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
 * Normalisiert die Artefakt-Referenz auf `{htmlReport?,traces?}` — nur
 * String-Pfade, kein Durchreichen beliebiger Felder.
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
  if (typeof artifacts.traces === 'string' && artifacts.traces) {
    out.traces = artifacts.traces;
  }
  // Edge-Case: Artefakte fehlen bei einem roten Lauf → kein artifacts-Feld, kein Fehler.
  return Object.keys(out).length > 0 ? out : undefined;
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
   * mitgegeben, hält `artifacts` nur bei `status:"failed"` (AC3), schneidet
   * je Projekt-Slug auf die letzten `MAX_RUNS_PER_PROJECT` zurück (AC2,
   * Auto-Prune inkl. Artefakte, AC3) und schreibt die Datei atomar.
   * Serialisiert über eine In-Process-Kette.
   *
   * @param {object} input
   * @param {string} input.projekt Projekt-Slug (kein Pfad) — Pflicht.
   * @param {string} [input.runId] optional; wird generiert falls fehlend.
   * @param {string} input.suite
   * @param {'bereich'|'verbund'|'gesamt'} input.scopeTyp
   * @param {'passed'|'failed'} input.status
   * @param {string} [input.startedAt]
   * @param {number} [input.durationMs]
   * @param {RegressionCounts} [input.counts]
   * @param {*} input.ctrf CTRF-JSON, unverändert übernommen.
   * @param {RegressionArtifacts} [input.artifacts] nur bei status:"failed" wirksam.
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
      throw new Error('[RegressionResultStore] Ungültiger status — erlaubt: passed|failed.');
    }

    await this.#ensureLoaded();

    /** @type {RegressionRun} */
    const run = {
      runId: typeof input.runId === 'string' && input.runId ? input.runId : randomUUID(),
      projekt,
      suite: typeof input.suite === 'string' ? input.suite : '',
      scopeTyp,
      status,
      startedAt: typeof input.startedAt === 'string' ? input.startedAt : '',
      durationMs: Number.isFinite(input.durationMs) ? input.durationMs : 0,
      counts: _normalizeCounts(input.counts),
      ctrf: input.ctrf ?? null,
    };
    // AC3: Debug-Artefakte NUR bei status:"failed".
    if (status === 'failed') {
      const artifacts = _normalizeArtifacts(input.artifacts);
      if (artifacts) run.artifacts = artifacts;
    }

    const existing = this.#runsByProject.get(projekt) ?? [];
    const updated = [...existing, run];
    this.#runsByProject.set(projekt, updated);

    // Auto-Prune (AC2): nur die letzten MAX_RUNS_PER_PROJECT Läufe DIESES
    // Projekts behalten — die ältesten (früheste Einfüge-Reihenfolge) fallen
    // heraus, inkl. ihrer Dateien (AC3, keine verwaisten Artefakte).
    let toDelete = [];
    if (updated.length > MAX_RUNS_PER_PROJECT) {
      toDelete = updated.slice(0, updated.length - MAX_RUNS_PER_PROJECT);
      this.#runsByProject.set(projekt, updated.slice(updated.length - MAX_RUNS_PER_PROJECT));
    }

    await this.#persistRun(projekt, run);
    for (const old of toDelete) {
      await this.#deleteRunFile(projekt, old.runId);
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
   * CTRF-JSON + Artefakt-Referenz bei roten Läufen), oder null wenn nicht
   * vorhanden bzw. Slug ungültig.
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
   * Entfernt die persistierte Datei eines geprunten Laufs (AC3: keine
   * verwaisten Artefakte-Referenzen — die referenzierten Artefakt-Dateien
   * selbst liegen außerhalb dieses Stores beim Runner, hier wird nur der
   * Lauf-Datensatz selbst entfernt). Best-effort, non-fatal bei Fehlschlag.
   *
   * @param {string} projekt
   * @param {string} runId
   * @returns {Promise<void>}
   */
  async #deleteRunFile(projekt, runId) {
    const projectDir = _resolveProjectDir(projekt);
    if (!projectDir) return;
    const filePath = join(projectDir, `${runId}.json`);
    await rm(filePath, { force: true }).catch((err) => {
      console.error('[RegressionResultStore] Prune-Löschen fehlgeschlagen:', err.message);
    });
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
    ctrf: raw.ctrf ?? null,
  };
  if (raw.status === 'failed') {
    const artifacts = _normalizeArtifacts(raw.artifacts);
    if (artifacts) run.artifacts = artifacts;
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
