/**
 * DrainReportStore.js — Persistente, größenbegrenzte Abschlussbericht-Ablage
 * nach jedem Board-Drain (docs/specs/drain-completion-report.md AC3).
 *
 * Hält je Drain-Abschluss (Nacht- oder manueller Drain) EINEN kompakten,
 * secret-/pfad-freien Bericht. Muster: `TickerSettingsStore.js` /
 * `NotificationSettingsStore.js` — eine Plaintext-JSON-Datei unter
 * `${CRED_STORE_DIR}`, atomarer Schreibzugriff (tmp + rename). Bewusst KEIN
 * Reuse des `AuditStore` (append-only, unbegrenzt, projekt-übergreifend) — hier
 * ist eine harte Pro-Projekt-Grenze (letzte 30) ein Kernkriterium (AC3).
 *
 * Datei: ${CRED_STORE_DIR}/drain-reports.json  (Format: { reports: [...] })
 * Rechte: 0600 (konsistent restriktiv, obwohl nicht-geheim)
 * Schreiben: atomar (tmp + rename)
 *
 * Bericht-Schema (AC3/AC4, verbindlich; `budgetPauses` additiv seit
 * docs/specs/night-budget-guard.md AC12):
 *   { reportId, project, trigger, startedAt, finishedAt, reason, flowRuns,
 *     completed:[{id,title}], blocked:[{id,title}],
 *     budgetPauses:[{from,to,reason}] }
 *   - trigger ∈ { 'night', 'manual' }
 *   - project = Projekt-Slug (KEIN absoluter Pfad)
 *   - completed/blocked = { id, title } je Story (kein Pfad/Secret)
 *   - budgetPauses = { from: number, to: number|null, reason } je Budget-Pause
 *     (night-budget-guard AC12); `reason` ∈ 'reactive-limit'|'proactive-threshold';
 *     `to = null` bei sanftem Drain-Ende. Fehlt das Feld (Alt-Berichte vor
 *     S-275) → `[]` (rückwärtskompatibel, kein Crash).
 *
 * Pro-Projekt-Grenze: je Projekt-Slug werden höchstens
 * `MAX_REPORTS_PER_PROJECT` (30) Berichte gehalten — beim `record()` fallen die
 * ältesten dieses Projekts automatisch heraus. Die feste Grenze hält die Datei
 * dauerhaft klein (wenige KB, unabhängig von Projektzahl/Laufzeit).
 *
 * Nebenläufigkeit: Nacht- und manueller Drain teilen DIESELBE Instanz
 * (server.js). `record()`-Aufrufe werden über eine In-Process-Promise-Kette
 * serialisiert (kein Read-Modify-Write-Race innerhalb des Prozesses) und die
 * Datei atomar geschrieben (tmp + rename verhindert eine korrupte Datei).
 *
 * Robustheit (NFR): die Bericht-Erfassung ist best-effort — ein Store-/
 * Schreibfehler ist non-fatal (der Aufrufer kapselt `record()` in try/catch).
 * Ist `CRED_STORE_DIR` NICHT gesetzt, degradiert der Store auf reinen In-Memory-
 * Betrieb (Berichte im Prozess sichtbar, aber nicht persistiert) statt zu
 * werfen — der Drain darf durch fehlende Persistenz nie crashen.
 *
 * Security (Floor): keine absoluten Host-Pfade, Tokens oder Roh-Fehlertexte in
 * Store/Response/Log (nur Slug + Story-ID/Titel + Zähler); `project` wird gegen
 * einen Slug-Form-Check gehärtet, `completed`/`blocked` auf `{id,title}`
 * reduziert (kein Durchreichen beliebiger Felder).
 *
 * @module DrainReportStore
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/** Harte Pro-Projekt-Grenze (AC3): ältere Berichte fallen beim Schreiben heraus. */
export const MAX_REPORTS_PER_PROJECT = 30;

/** Erlaubter Trigger-Wert (AC3). */
export const TRIGGERS = Object.freeze(['night', 'manual']);

/** Erlaubter Budget-Pausen-Grund (night-budget-guard AC12). */
export const BUDGET_PAUSE_REASONS = Object.freeze(['reactive-limit', 'proactive-threshold']);

/** Erlaubter Projekt-Slug: nur Buchstaben, Ziffern, `-` und `_` (analog TickerSettingsStore). */
export const PROJECT_SLUG_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @typedef {object} DrainStory
 * @property {string} id
 * @property {string} title
 *
 * @typedef {object} BudgetPause
 * @property {number} from
 * @property {number|null} to
 * @property {'reactive-limit'|'proactive-threshold'} reason
 *
 * @typedef {object} DrainReport
 * @property {string} reportId
 * @property {string} project    Projekt-Slug (kein Pfad)
 * @property {'night'|'manual'} trigger
 * @property {string} startedAt  ISO-8601
 * @property {string} finishedAt ISO-8601
 * @property {string} reason
 * @property {number} flowRuns
 * @property {DrainStory[]} completed
 * @property {DrainStory[]} blocked
 * @property {BudgetPause[]} budgetPauses  night-budget-guard AC12; `[]` bei
 *   Alt-Berichten ohne das Feld (rückwärtskompatibel).
 */

/**
 * Liest den Pfad zur Bericht-Datei aus der Umgebung.
 * Pfad: ${CRED_STORE_DIR}/drain-reports.json
 *
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveReportFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'drain-reports.json');
}

/**
 * Normalisiert eine Story-Liste auf ausschließlich `{ id, title }` (kein
 * Durchreichen beliebiger Felder — Pfad-/Secret-Hygiene).
 *
 * @param {unknown} list
 * @returns {DrainStory[]}
 */
function _normalizeStories(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      id: typeof s.id === 'string' ? s.id : String(s.id ?? ''),
      title: typeof s.title === 'string' ? s.title : '',
    }));
}

/**
 * Normalisiert eine Budget-Pausen-Liste auf ausschließlich
 * `{ from, to, reason }` (night-budget-guard AC12) — kein Durchreichen
 * beliebiger Felder. Ein fehlendes/ungültiges `list` (Alt-Berichte ohne das
 * Feld, oder korrupte Daten) → `[]` (rückwärtskompatibel, kein Crash). Ein
 * Eintrag mit ungültigem `reason` wird verworfen (Security-/Daten-Hygiene).
 *
 * @param {unknown} list
 * @returns {import('./DrainReportStore.js').BudgetPause[]}
 */
function _normalizeBudgetPauses(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p === 'object' && BUDGET_PAUSE_REASONS.includes(p.reason))
    .map((p) => ({
      from: typeof p.from === 'number' ? p.from : 0,
      to: typeof p.to === 'number' ? p.to : null,
      reason: p.reason,
    }));
}

export class DrainReportStore {
  /** @type {DrainReport[]|null} In-Memory-Cache; null bis erstmals geladen. */
  #reports = null;
  /** @type {Promise<void>|null} einmaliger Lade-Vorgang (idempotent). */
  #loadPromise = null;
  /** @type {Promise<*>} Serialisierungs-Kette für record() (kein Read-Modify-Write-Race). */
  #queue = Promise.resolve();

  /**
   * Lädt die persistierten Berichte einmalig in den In-Memory-Cache.
   * Fehlt die Datei (ENOENT) oder ist sie unlesbar/korrupt → leerer Cache
   * (kein Crash — die Ablage ist best-effort).
   *
   * @returns {Promise<void>}
   */
  async #ensureLoaded() {
    if (this.#reports !== null) return;
    if (!this.#loadPromise) this.#loadPromise = this.#load();
    await this.#loadPromise;
  }

  /** @returns {Promise<void>} */
  async #load() {
    const filePath = resolveReportFilePath();
    if (!filePath) {
      // Kein CRED_STORE_DIR → reiner In-Memory-Betrieb (degradiert, non-fatal).
      this.#reports = [];
      return;
    }
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.reports) ? parsed.reports : [];
      this.#reports = list
        .filter((r) => r && typeof r === 'object' && typeof r.project === 'string')
        .map((r) => ({
          reportId: typeof r.reportId === 'string' ? r.reportId : randomUUID(),
          project: r.project,
          trigger: TRIGGERS.includes(r.trigger) ? r.trigger : 'manual',
          startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
          finishedAt: typeof r.finishedAt === 'string' ? r.finishedAt : '',
          reason: typeof r.reason === 'string' ? r.reason : '',
          flowRuns: Number.isFinite(r.flowRuns) ? r.flowRuns : 0,
          completed: _normalizeStories(r.completed),
          blocked: _normalizeStories(r.blocked),
          budgetPauses: _normalizeBudgetPauses(r.budgetPauses),
        }));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[DrainReportStore] Lesen fehlgeschlagen:', err.message);
      }
      this.#reports = [];
    }
  }

  /**
   * Legt einen Abschlussbericht an (AC3): generiert `reportId`, hängt ihn an,
   * schneidet je Projekt-Slug auf die letzten `MAX_REPORTS_PER_PROJECT` zurück
   * und schreibt die Datei atomar. Serialisiert über eine In-Process-Kette.
   *
   * @param {object} input
   * @param {string} input.project    Projekt-Slug (kein Pfad) — Pflicht.
   * @param {'night'|'manual'} input.trigger
   * @param {string} [input.startedAt]
   * @param {string} [input.finishedAt]
   * @param {string} [input.reason]
   * @param {number} [input.flowRuns]
   * @param {DrainStory[]} [input.completed]
   * @param {DrainStory[]} [input.blocked]
   * @param {import('./DrainReportStore.js').BudgetPause[]} [input.budgetPauses]
   *   night-budget-guard AC12; fehlend/ungültig → `[]`.
   * @returns {Promise<DrainReport>} der geschriebene Bericht.
   * @throws {Error} wenn `project` kein gültiger Slug oder `trigger` ungültig ist.
   */
  record(input) {
    const run = () => this.#doRecord(input);
    // .then(run, run): eine vorherige Rejection blockiert die Kette nicht.
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }

  /**
   * @param {object} input
   * @returns {Promise<DrainReport>}
   */
  async #doRecord(input) {
    const project = input?.project;
    if (typeof project !== 'string' || !PROJECT_SLUG_RE.test(project)) {
      throw new Error('[DrainReportStore] Ungültiger project-Slug — Bericht nicht geschrieben.');
    }
    const trigger = TRIGGERS.includes(input?.trigger) ? input.trigger : null;
    if (!trigger) {
      throw new Error('[DrainReportStore] Ungültiger trigger — erlaubt: night|manual.');
    }

    await this.#ensureLoaded();

    /** @type {DrainReport} */
    const report = {
      reportId: randomUUID(),
      project,
      trigger,
      startedAt: typeof input.startedAt === 'string' ? input.startedAt : '',
      finishedAt: typeof input.finishedAt === 'string' ? input.finishedAt : '',
      reason: typeof input.reason === 'string' ? input.reason : '',
      flowRuns: Number.isFinite(input.flowRuns) ? input.flowRuns : 0,
      completed: _normalizeStories(input.completed),
      blocked: _normalizeStories(input.blocked),
      budgetPauses: _normalizeBudgetPauses(input.budgetPauses),
    };

    this.#reports.push(report);

    // Pro-Projekt-Rückschnitt (AC3): nur die letzten MAX Berichte DIESES Slugs
    // behalten — die ältesten (früheste Einfüge-Reihenfolge) fallen heraus.
    const forProject = this.#reports.filter((r) => r.project === project);
    if (forProject.length > MAX_REPORTS_PER_PROJECT) {
      const drop = new Set(forProject.slice(0, forProject.length - MAX_REPORTS_PER_PROJECT));
      this.#reports = this.#reports.filter((r) => !drop.has(r));
    }

    await this.#persist();
    return report;
  }

  /**
   * Liefert die Berichte read-only, absteigend nach `finishedAt` (jüngster
   * zuerst), optional per Projekt-Slug gefiltert (AC4). Arbeitet ausschließlich
   * auf dem In-Memory-Cache — KEIN Datei-Zugriff pro Aufruf; ein
   * ungültiger/traversierender Slug hat daher keine Dateiwirkung (leere Liste).
   *
   * @param {{ project?: string }} [opts]
   * @returns {Promise<DrainReport[]>}
   */
  async list({ project } = {}) {
    await this.#ensureLoaded();
    let out = this.#reports;
    if (project !== undefined) {
      if (typeof project !== 'string' || !PROJECT_SLUG_RE.test(project)) return [];
      out = out.filter((r) => r.project === project);
    }
    // Absteigend nach finishedAt (ISO-8601 → lexikografisch = chronologisch).
    return [...out]
      .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : a.finishedAt > b.finishedAt ? -1 : 0))
      .map((r) => ({
        ...r,
        completed: [...r.completed],
        blocked: [...r.blocked],
        budgetPauses: [...r.budgetPauses],
      }));
  }

  /**
   * Schreibt den aktuellen Cache atomar (tmp + rename, Muster
   * `TickerSettingsStore.write`). Ohne CRED_STORE_DIR → No-op (In-Memory-Betrieb).
   *
   * @returns {Promise<void>}
   */
  async #persist() {
    const filePath = resolveReportFilePath();
    if (!filePath) return; // degradiert: nur In-Memory (best-effort, kein Crash)

    const json = JSON.stringify({ reports: this.#reports }, null, 2);
    const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');

    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      const e = new Error(`[DrainReportStore] Atomar-Schreiben fehlgeschlagen: ${err.message}`);
      e.code = err.code;
      throw e;
    }
    try {
      await chmod(filePath, 0o600);
    } catch {
      // Non-fatal
    }
  }
}
