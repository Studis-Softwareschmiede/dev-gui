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
 * docs/specs/night-budget-guard.md AC12; `firstAt`/`lastAt`/`count` additiv
 * seit v2, AC8-AC10):
 *   { reportId, project, trigger, startedAt, finishedAt, reason, flowRuns,
 *     completed:[{id,title}], blocked:[{id,title}],
 *     budgetPauses:[{from,to,reason}], firstAt, lastAt, count }
 *   - trigger ∈ { 'night', 'manual' }
 *   - project = Projekt-Slug (KEIN absoluter Pfad)
 *   - completed/blocked = { id, title } je Story (kein Pfad/Secret)
 *   - budgetPauses = { from: number, to: number|null, reason } je Budget-Pause
 *     (night-budget-guard AC12); `reason` ∈ 'reactive-limit'|'proactive-threshold';
 *     `to = null` bei sanftem Drain-Ende. Fehlt das Feld (Alt-Berichte vor
 *     S-275) → `[]` (rückwärtskompatibel, kein Crash).
 *   - firstAt/lastAt/count (v2, AC8-AC10): bei einer verschmolzenen
 *     Leerlauf-Serie die Serien-Grenzen (`firstAt`=`startedAt` des ersten
 *     Laufs, `lastAt`=`finishedAt` des jüngsten Laufs) + Anzahl; bei
 *     nicht-aggregierten Berichten `count:1`, `firstAt=startedAt`,
 *     `lastAt=finishedAt`.
 *
 * Leerlauf-Bericht-Aggregation (v2, AC8-AC10, docs/specs/drain-completion-report.md):
 *   Ein Leerlauf-Bericht (`flowRuns===0 && reason==='no-drain-target'`) wird
 *   beim `record()` mit dem unmittelbar vorhergehenden Bericht DESSELBEN
 *   Projekts verschmolzen, sofern dieser ebenfalls ein Leerlauf-Bericht ist
 *   (AC8, Merge-on-persist) — statt N Einzeleinträgen entsteht EIN Eintrag mit
 *   `count`. Beim Laden bestehender Alt-Daten werden zusammenhängende
 *   Leerlauf-Serien je Projekt einmalig kompaktiert (AC9, idempotent). Ein
 *   nicht-leerer Bericht beendet eine Serie.
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
 * @property {string} firstAt   v2/AC8-AC10: Serien-Beginn (= startedAt bei
 *   nicht-aggregierten Berichten).
 * @property {string} lastAt    v2/AC8-AC10: Serien-Ende (= finishedAt bei
 *   nicht-aggregierten Berichten).
 * @property {number} count     v2/AC8-AC10: Anzahl verschmolzener Leerlauf-
 *   Berichte in dieser Serie (1 bei nicht-aggregierten Berichten).
 */

/**
 * Prüft, ob ein Bericht ein „Leerlauf-Bericht" ist (AC8): kein Board-Scan-
 * Ergebnis, `flowRuns===0` UND `reason==='no-drain-target'`. Nur diese Klasse
 * wird aggregiert — jeder andere Bericht bleibt ein Einzeleintrag.
 *
 * @param {{flowRuns?: number, reason?: string}|null|undefined} report
 * @returns {boolean}
 */
function _isIdleReport(report) {
  return !!report && report.flowRuns === 0 && report.reason === 'no-drain-target';
}

/**
 * Findet den Index des zeitlich jüngsten Berichts eines Projekts (nach
 * `lastAt`/`finishedAt`) — der „unmittelbar vorhergehende Bericht" für den
 * Merge-on-persist-Vergleich (AC8).
 *
 * @param {DrainReport[]} reports
 * @param {string} project
 * @returns {number} Index oder -1, wenn das Projekt noch keinen Bericht hat.
 */
function _findMostRecentIndexForProject(reports, project) {
  let bestIdx = -1;
  let bestTime = null;
  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    if (r.project !== project) continue;
    const t = r.lastAt || r.finishedAt || '';
    if (bestTime === null || t > bestTime) {
      bestTime = t;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Kompaktiert zusammenhängende Leerlauf-Serien je Projekt zu je einem
 * Eintrag (AC9, einmalige Migration beim Laden). Idempotent: bereits
 * kompaktierte Serien (1 Eintrag mit `count`) bleiben unverändert; nicht-
 * leere Berichte werden nicht angefasst. Die Reihenfolge nach `finishedAt`
 * bestimmt den Serien-Zusammenhang (je Projekt separat betrachtet).
 *
 * @param {DrainReport[]} reports
 * @returns {DrainReport[]}
 */
function _compactIdleSeries(reports) {
  const byProject = new Map();
  for (const r of reports) {
    if (!byProject.has(r.project)) byProject.set(r.project, []);
    byProject.get(r.project).push(r);
  }

  const result = [];
  for (const list of byProject.values()) {
    const sorted = [...list].sort((a, b) =>
      a.finishedAt < b.finishedAt ? -1 : a.finishedAt > b.finishedAt ? 1 : 0,
    );

    let run = [];
    const flushRun = () => {
      if (run.length === 0) return;
      const first = run[0];
      const last = run[run.length - 1];
      const totalCount = run.reduce(
        (sum, r) => sum + (typeof r.count === 'number' && r.count > 0 ? r.count : 1),
        0,
      );
      result.push({
        ...first,
        firstAt: first.firstAt || first.startedAt || '',
        lastAt: last.lastAt || last.finishedAt || '',
        finishedAt: last.finishedAt || first.finishedAt,
        count: totalCount,
      });
      run = [];
    };

    for (const r of sorted) {
      if (_isIdleReport(r)) {
        run.push(r);
      } else {
        flushRun();
        result.push({
          ...r,
          firstAt: r.firstAt || r.startedAt || '',
          lastAt: r.lastAt || r.finishedAt || '',
          count: typeof r.count === 'number' && r.count > 0 ? r.count : 1,
        });
      }
    }
    flushRun();
  }

  return result;
}

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
      const normalized = list
        .filter((r) => r && typeof r === 'object' && typeof r.project === 'string')
        .map((r) => {
          const startedAt = typeof r.startedAt === 'string' ? r.startedAt : '';
          const finishedAt = typeof r.finishedAt === 'string' ? r.finishedAt : '';
          return {
            reportId: typeof r.reportId === 'string' ? r.reportId : randomUUID(),
            project: r.project,
            trigger: TRIGGERS.includes(r.trigger) ? r.trigger : 'manual',
            startedAt,
            finishedAt,
            reason: typeof r.reason === 'string' ? r.reason : '',
            flowRuns: Number.isFinite(r.flowRuns) ? r.flowRuns : 0,
            completed: _normalizeStories(r.completed),
            blocked: _normalizeStories(r.blocked),
            budgetPauses: _normalizeBudgetPauses(r.budgetPauses),
            firstAt: typeof r.firstAt === 'string' ? r.firstAt : startedAt,
            lastAt: typeof r.lastAt === 'string' ? r.lastAt : finishedAt,
            count: Number.isFinite(r.count) && r.count > 0 ? r.count : 1,
          };
        });
      // AC9: einmalige Kompaktion zusammenhängender Leerlauf-Serien je Projekt
      // beim Laden — idempotent, nicht-leere Berichte bleiben unangetastet.
      this.#reports = _compactIdleSeries(normalized);
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
   * AC8 (v2): ist der neue Bericht ein Leerlauf-Bericht (`flowRuns===0 &&
   * reason==='no-drain-target'`) UND der unmittelbar vorhergehende Bericht
   * desselben Projekts ebenfalls ein Leerlauf-Bericht → beide werden
   * verschmolzen (statt eines neuen Eintrags), `count` erhöht sich, `firstAt`
   * bleibt, `lastAt`/`finishedAt` folgen dem neuen Lauf. Der 30er-Rückschnitt
   * greift danach unverändert.
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

    const startedAt = typeof input.startedAt === 'string' ? input.startedAt : '';
    const finishedAt = typeof input.finishedAt === 'string' ? input.finishedAt : '';
    const reason = typeof input.reason === 'string' ? input.reason : '';
    const flowRuns = Number.isFinite(input.flowRuns) ? input.flowRuns : 0;
    const isIdle = flowRuns === 0 && reason === 'no-drain-target';

    // AC8: Merge-on-persist — ein Leerlauf-Bericht verschmilzt mit dem
    // unmittelbar vorhergehenden Bericht DESSELBEN Projekts, sofern dieser
    // ebenfalls ein Leerlauf-Bericht ist, statt einen neuen Eintrag anzulegen.
    if (isIdle) {
      const prevIdx = _findMostRecentIndexForProject(this.#reports, project);
      const prev = prevIdx !== -1 ? this.#reports[prevIdx] : null;
      if (_isIdleReport(prev)) {
        /** @type {DrainReport} */
        const merged = {
          ...prev,
          finishedAt,
          lastAt: finishedAt,
          firstAt: prev.firstAt || prev.startedAt || startedAt,
          count: (typeof prev.count === 'number' && prev.count > 0 ? prev.count : 1) + 1,
        };
        this.#reports[prevIdx] = merged;
        await this.#persist();
        return merged;
      }
    }

    /** @type {DrainReport} */
    const report = {
      reportId: randomUUID(),
      project,
      trigger,
      startedAt,
      finishedAt,
      reason,
      flowRuns,
      completed: _normalizeStories(input.completed),
      blocked: _normalizeStories(input.blocked),
      budgetPauses: _normalizeBudgetPauses(input.budgetPauses),
      firstAt: startedAt,
      lastAt: finishedAt,
      count: 1,
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
