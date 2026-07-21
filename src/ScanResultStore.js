/**
 * ScanResultStore.js — Persistente, größenbegrenzte Verlaufs-Ablage für
 * Pro-Container Red-Team-Scans, pro App (docs/specs/red-team-scan-per-container.md
 * AC7, AC8, AC9).
 *
 * Muster: `DrainReportStore.js` — EINE Plaintext-JSON-Datei unter
 * `${CRED_STORE_DIR}` (Betreiber-nahe Beobachtbarkeits-Ablage, ADR-005-Linie —
 * kein Fabrik-/Domänen-State), atomarer tmp+rename-Schreibzugriff, `0600`;
 * ohne `CRED_STORE_DIR` In-Memory-Degradation (kein Crash — NFR „Store-/
 * Schreibfehler sind best-effort/non-fatal“). Anders als `RegressionResultStore`
 * (JE LAUF eine eigene Datei — CTRF-JSON kann gross werden) reicht hier EINE
 * Sammel-Datei: ein Scan-Verlaufseintrag ist klein (Findings sind
 * Kurz-Metadaten, keine Screenshots/Traces/Videos).
 *
 * Datei: ${CRED_STORE_DIR}/scan-results.json  (Format: { scans: [...] })
 * Rechte: 0600
 * Schreiben: atomar (tmp + rename)
 *
 * Eintrag-Schema (AC7, verbindlich):
 *   { scanId, app, startedAt, finishedAt, ampel,
 *     findings: [{ id, severity, kind, testort, titel }],
 *     findingCount, reportRef, boardItemIds: [] }
 *   - `app` = Hostname/Slug der gescannten App (KEIN Host-Pfad).
 *   - `ampel` ∈ {gruen, gelb, rot} — IMMER deterministisch aus `findings`
 *     abgeleitet (AC9, `deriveAmpel()`); ein evtl. mitgegebener `input.ampel`
 *     wird ignoriert (single source of truth — kein zweiter, unabhängig
 *     driftender Ampel-Wert).
 *   - `findingCount` = `findings.length` — ebenfalls IMMER abgeleitet, kein
 *     separat gepflegter Zähler.
 *   - `severity` ∈ {low, medium, high, critical}; `testort` ∈ {direkt,
 *     öffentlich} (AC5-Vokabular). Ungültige/fehlende Werte werden beim
 *     Schreiben defensiv normalisiert (analog `DrainReportStore._normalizeStories`)
 *     — kein Crash durch einen malformten Eintrag.
 *   - `boardItemIds` startet als `[]`; AC17/S-405 schreibt hier später
 *     entstandene Board-IDs zurück (ausserhalb des Scopes dieser Story).
 *
 * scanId ≡ Runner-jobId (Korrelation zum `HeadlessRedTeamRunner`-Job,
 * AC1-AC3): der Aufrufer, der einen abgeschlossenen Lauf persistiert (diese
 * Schreib-Naht liegt AUSSERHALB dieser Story — S-402 implementiert nur
 * AC7/AC8/AC9, s. Story-Scope), übergibt die Runner-`jobId` als `scanId` —
 * dieselbe Korrelations-ID durchgängig für Start→Status→Verlauf.
 * `getByJobId()` ist deshalb ein reiner Alias auf `getByScanId()` (keine
 * zweite Index-Struktur nötig).
 *
 * Pro-App-Grenze (AC7): je `app` werden höchstens `MAX_SCANS_PER_APP` (30)
 * Verlaufseinträge gehalten — beim `record()` fallen die ältesten dieses
 * App-Slugs automatisch heraus (analog `DrainReportStore.MAX_REPORTS_PER_PROJECT`).
 *
 * Verlauf-Liste (AC8, `list()`) liefert NUR die kompakte Vertrags-Form
 * `{scanId,startedAt,ampel,findingCount,boardItemIds}` — OHNE `findings`
 * und OHNE `reportRef` ("ohne Rohbericht-Volltext"). Der Detail-Zugriff
 * (`getByScanId()`/`getByJobId()`) liefert den VOLLEN Datensatz inkl.
 * `findings`+`reportRef`.
 *
 * Nebenläufigkeit: `record()`-Aufrufe werden über eine In-Process-
 * Promise-Kette serialisiert (kein Read-Modify-Write-Race).
 *
 * Robustheit (NFR): Store-/Schreibfehler sind best-effort/non-fatal — ein
 * Scan darf durch fehlende Persistenz nie crashen. Ohne CRED_STORE_DIR
 * degradiert der Store auf reinen In-Memory-Betrieb.
 *
 * Security (Floor): keine Secrets/Tokens/absolute Host-Pfade in
 * Store/Response/Log; `app` wird gegen einen Hostname-/Slug-Form-Check
 * gehärtet; `scanId`/`jobId` bleiben reine Korrelations-IDs.
 *
 * @module ScanResultStore
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/** Harte Pro-App-Grenze (AC7): ältere Verlaufseinträge fallen beim Schreiben heraus. */
export const MAX_SCANS_PER_APP = 30;

/** Erlaubter Ampel-Wert (AC7/AC9). */
export const AMPEL_VALUES = Object.freeze(['gruen', 'gelb', 'rot']);

/** Erlaubter Severity-Wert (AC9). */
export const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);

/** Erlaubter Testort-Wert (AC5-Vokabular). */
export const TESTORTE = Object.freeze(['direkt', 'öffentlich']);

/**
 * Erlaubte `app`-Form: Hostname/Slug — Buchstaben, Ziffern, Punkt, Bindestrich,
 * Unterstrich; nicht leer, kein führendes/nachfolgendes Sonderzeichen. Deckt
 * sowohl einen Cloudflare-Hostname (`app.example.com`) als auch einen
 * einfachen Slug ab.
 */
export const APP_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/;

/**
 * @typedef {object} ScanFinding
 * @property {string} id
 * @property {'low'|'medium'|'high'|'critical'} severity
 * @property {string} kind
 * @property {'direkt'|'öffentlich'} testort
 * @property {string} titel
 *
 * @typedef {object} ScanResult
 * @property {string} scanId
 * @property {string} app          Hostname/Slug der gescannten App (kein Pfad)
 * @property {string} startedAt    ISO-8601
 * @property {string} finishedAt   ISO-8601
 * @property {'gruen'|'gelb'|'rot'} ampel  IMMER aus `findings` abgeleitet (AC9)
 * @property {ScanFinding[]} findings
 * @property {number} findingCount IMMER `findings.length`
 * @property {string|null} reportRef
 * @property {string[]} boardItemIds
 *
 * @typedef {object} ScanHistoryEntry  Kompakte Verlaufs-Form (AC8, `list()`)
 * @property {string} scanId
 * @property {string} startedAt
 * @property {'gruen'|'gelb'|'rot'} ampel
 * @property {number} findingCount
 * @property {string[]} boardItemIds
 */

/**
 * Liest den Pfad zur Verlaufs-Datei aus der Umgebung.
 * Pfad: ${CRED_STORE_DIR}/scan-results.json
 *
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveScanResultsFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'scan-results.json');
}

/**
 * Leitet die Ampel deterministisch aus einer (bereits normalisierten)
 * Findings-Liste ab (AC9): `gruen` = keine Befunde; `gelb` = ausschließlich
 * low/medium-Befunde; `rot` = mindestens ein high/critical-Befund.
 *
 * @param {ScanFinding[]} findings
 * @returns {'gruen'|'gelb'|'rot'}
 */
export function deriveAmpel(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) return 'gruen';
  const hasHighOrCritical = list.some((f) => f?.severity === 'high' || f?.severity === 'critical');
  return hasHighOrCritical ? 'rot' : 'gelb';
}

/**
 * Normalisiert EINEN Befund auf `{id,severity,kind,testort,titel}` — kein
 * Durchreichen beliebiger Felder (Security-/Daten-Hygiene, analog
 * `DrainReportStore._normalizeStories`). Ungültige/fehlende `severity`/
 * `testort` werden defensiv auf einen Default normalisiert (kein Crash durch
 * einen malformten Eintrag).
 *
 * @param {unknown} f
 * @returns {ScanFinding|null}
 */
function _normalizeFinding(f) {
  if (!f || typeof f !== 'object') return null;
  return {
    id: typeof f.id === 'string' && f.id ? f.id : randomUUID(),
    severity: SEVERITIES.includes(f.severity) ? f.severity : 'medium',
    kind: typeof f.kind === 'string' ? f.kind : '',
    testort: TESTORTE.includes(f.testort) ? f.testort : 'direkt',
    titel: typeof f.titel === 'string' ? f.titel : '',
  };
}

/**
 * @param {unknown} list
 * @returns {ScanFinding[]}
 */
function _normalizeFindings(list) {
  if (!Array.isArray(list)) return [];
  return list.map(_normalizeFinding).filter(Boolean);
}

/**
 * @param {unknown} list
 * @returns {string[]}
 */
function _normalizeBoardItemIds(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => typeof x === 'string' && x);
}

/**
 * Normalisiert einen roh geladenen/übergebenen Verlaufseintrag auf das
 * verbindliche Schema (AC7) — `ampel`/`findingCount` werden IMMER aus
 * `findings` abgeleitet (nie aus dem Input übernommen). Liefert `null` bei
 * fundamental ungültiger Form (kein Objekt / kein gültiger `app`-Slug) — der
 * Aufrufer überspringt diesen Eintrag dann (korruptes Datei-Set, Rest bleibt
 * lesbar).
 *
 * @param {unknown} raw
 * @returns {ScanResult|null}
 */
function _normalizeScan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.app !== 'string' || !APP_RE.test(raw.app)) return null;
  const findings = _normalizeFindings(raw.findings);
  return {
    scanId: typeof raw.scanId === 'string' && raw.scanId ? raw.scanId : randomUUID(),
    app: raw.app,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : '',
    ampel: deriveAmpel(findings),
    findings,
    findingCount: findings.length,
    reportRef: typeof raw.reportRef === 'string' && raw.reportRef ? raw.reportRef : null,
    boardItemIds: _normalizeBoardItemIds(raw.boardItemIds),
  };
}

/**
 * Deep-copy für read-only Semantik (verhindert externe Mutation des Caches).
 *
 * @param {ScanResult} scan
 * @returns {ScanResult}
 */
function _cloneScan(scan) {
  return {
    ...scan,
    findings: scan.findings.map((f) => ({ ...f })),
    boardItemIds: [...scan.boardItemIds],
  };
}

export class ScanResultStore {
  /** @type {ScanResult[]|null} In-Memory-Cache; null bis erstmals geladen. */
  #scans = null;
  /** @type {Promise<void>|null} einmaliger Lade-Vorgang (idempotent). */
  #loadPromise = null;
  /** @type {Promise<*>} Serialisierungs-Kette für record() (kein Read-Modify-Write-Race). */
  #queue = Promise.resolve();

  /**
   * Lädt die persistierten Verlaufseinträge einmalig in den In-Memory-Cache.
   * Fehlt die Datei (ENOENT) oder ist sie unlesbar/korrupt → leerer Cache
   * (kein Crash — die Ablage ist best-effort).
   *
   * @returns {Promise<void>}
   */
  async #ensureLoaded() {
    if (this.#scans !== null) return;
    if (!this.#loadPromise) this.#loadPromise = this.#load();
    await this.#loadPromise;
  }

  /** @returns {Promise<void>} */
  async #load() {
    const filePath = resolveScanResultsFilePath();
    if (!filePath) {
      // Kein CRED_STORE_DIR → reiner In-Memory-Betrieb (degradiert, non-fatal).
      this.#scans = [];
      return;
    }
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.scans) ? parsed.scans : [];
      this.#scans = list.map(_normalizeScan).filter(Boolean);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[ScanResultStore] Lesen fehlgeschlagen:', err.message);
      }
      this.#scans = [];
    }
  }

  /**
   * Legt einen Verlaufseintrag an (AC7): generiert `scanId` falls nicht
   * mitgegeben, leitet `ampel`/`findingCount` deterministisch aus `findings`
   * ab (AC9), schneidet je App-Slug auf die letzten `MAX_SCANS_PER_APP`
   * Einträge zurück und schreibt die Datei atomar. Serialisiert über eine
   * In-Process-Kette.
   *
   * @param {object} input
   * @param {string} [input.scanId] optional; wird generiert falls fehlend
   *   (Konvention: die Runner-`jobId` des zugehörigen Scan-Jobs).
   * @param {string} input.app Hostname/Slug der gescannten App — Pflicht.
   * @param {string} [input.startedAt]
   * @param {string} [input.finishedAt]
   * @param {ScanFinding[]} [input.findings]
   * @param {string} [input.reportRef]
   * @param {string[]} [input.boardItemIds]
   * @returns {Promise<ScanResult>} der geschriebene Verlaufseintrag.
   * @throws {Error} wenn `app` kein gültiger Hostname/Slug ist.
   */
  record(input) {
    const run = () => this.#doRecord(input);
    // .then(run, run): eine vorherige Rejection blockiert die Kette nicht.
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }

  /**
   * @param {object} input
   * @returns {Promise<ScanResult>}
   */
  async #doRecord(input) {
    if (typeof input?.app !== 'string' || !APP_RE.test(input.app)) {
      throw new Error('[ScanResultStore] Ungültiger app-Wert — Verlaufseintrag nicht geschrieben.');
    }

    await this.#ensureLoaded();

    const scanId = typeof input.scanId === 'string' && input.scanId ? input.scanId : randomUUID();
    const scan = _normalizeScan({ ...input, scanId });
    // _normalizeScan() liefert hier nie null (app bereits validiert oben).

    this.#scans.push(scan);

    // Pro-App-Rückschnitt (AC7): nur die letzten MAX_SCANS_PER_APP Einträge
    // DIESES App-Slugs behalten — analog DrainReportStore MAX_REPORTS_PER_PROJECT.
    const forApp = this.#scans.filter((s) => s.app === scan.app);
    if (forApp.length > MAX_SCANS_PER_APP) {
      const drop = new Set(forApp.slice(0, forApp.length - MAX_SCANS_PER_APP));
      this.#scans = this.#scans.filter((s) => !drop.has(s));
    }

    await this.#persist();
    return _cloneScan(scan);
  }

  /**
   * Liefert die Verlaufsliste einer App, kompakt (AC8, "ohne
   * Rohbericht-Volltext" — ohne `findings`/`reportRef`), absteigend nach
   * `startedAt` (jüngster zuerst). Ein ungültiger `app`-Wert → leere Liste
   * (kein Wurf).
   *
   * @param {string} app
   * @returns {Promise<ScanHistoryEntry[]>}
   */
  async list(app) {
    if (typeof app !== 'string' || !APP_RE.test(app)) return [];
    await this.#ensureLoaded();
    const scans = this.#scans.filter((s) => s.app === app);
    return [...scans]
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
      .map((s) => ({
        scanId: s.scanId,
        startedAt: s.startedAt,
        ampel: s.ampel,
        findingCount: s.findingCount,
        boardItemIds: [...s.boardItemIds],
      }));
  }

  /**
   * Liefert den VOLLEN Verlaufseintrag (AC8, Detail-Zugriff, inkl.
   * `findings`+`reportRef`) über die `scanId`, oder `null` wenn nicht
   * vorhanden.
   *
   * @param {string} scanId
   * @returns {Promise<ScanResult|null>}
   */
  async getByScanId(scanId) {
    if (typeof scanId !== 'string' || !scanId) return null;
    await this.#ensureLoaded();
    const found = this.#scans.find((s) => s.scanId === scanId);
    return found ? _cloneScan(found) : null;
  }

  /**
   * Alias auf `getByScanId()` — `scanId` und die Runner-`jobId` sind
   * dieselbe Korrelations-ID (s. Modul-Doku). Vom Status-Poll-Endpunkt
   * (`vpsContainerScanRouter.js` GET .../scan/:jobId, AC3) best-effort
   * genutzt, um `ampel`/`findings`/`reportRef` nachzuladen.
   *
   * @param {string} jobId
   * @returns {Promise<ScanResult|null>}
   */
  async getByJobId(jobId) {
    return this.getByScanId(jobId);
  }

  /**
   * Schreibt den aktuellen Cache atomar (tmp + rename, Muster
   * `DrainReportStore.#persist`). Ohne CRED_STORE_DIR → No-op (In-Memory-Betrieb).
   *
   * @returns {Promise<void>}
   */
  async #persist() {
    const filePath = resolveScanResultsFilePath();
    if (!filePath) return; // degradiert: nur In-Memory (best-effort, kein Crash)

    const json = JSON.stringify({ scans: this.#scans }, null, 2);
    const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');

    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      const e = new Error(`[ScanResultStore] Atomar-Schreiben fehlgeschlagen: ${err.message}`);
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
