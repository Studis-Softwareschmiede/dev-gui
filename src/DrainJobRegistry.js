/**
 * DrainJobRegistry — persistente Status-Registry für Headless-Drains
 * (docs/specs/headless-manual-drain.md AC4; datei-basiert persistiert seit
 * docs/specs/drain-restart-robustness.md AC1/AC2).
 *
 * Der manuelle „Board abarbeiten"-Knopf startet den Drain fire-and-forget
 * (`POST /api/projects/:slug/drain`, headless-manual-drain AC1) und erhält
 * sofort eine `drainId` zurück — es gibt KEINE Live-Terminal-Ausgabe mehr
 * (bewusstes Restrisiko, AC1/AC6). Damit der Owner trotzdem „läuft / fertig /
 * fehlgeschlagen" sieht, wird jeder gestartete Drain hier unter seiner
 * `drainId` geführt; `GET /api/projects/:slug/drain/:drainId` liest den Status.
 *
 * Persistenz (drain-restart-robustness AC1/AC2, Muster `DrainReportStore`):
 *   Datei: `${CRED_STORE_DIR}/drain-jobs.json`, Format `{ jobs: [DrainJobEntry] }`.
 *   Atomarer Schreibzugriff (tmp + rename), Rechte `0600`. Der initiale Ladevorgang
 *   passiert SYNCHRON im Konstruktor (`readFileSync`, Muster
 *   `CredentialStore#loadMasterKeyFromFile`) — damit bleiben `register()`/
 *   `markDone()`/`markFailed()`/`getJob()` synchron nutzbar (kein API-Bruch für
 *   bestehende Aufrufer, die diese Methoden ohne `await` aufrufen, s.
 *   `projectDrainRouter.js`) und ein direkt nach `register()` eintreffender
 *   `GET .../drain/:drainId` sieht den Job garantiert (kein Registrierungs-Race,
 *   In-Memory-Map wird synchron aktualisiert). Das Schreiben nach jeder Änderung
 *   läuft dagegen asynchron/best-effort im Hintergrund (fire-and-forget,
 *   In-Process-Serialisierungs-Kette gegen Read-Modify-Write-Race, analog
 *   `DrainReportStore.record()`).
 *
 *   Ist `CRED_STORE_DIR` NICHT gesetzt, degradiert die Registry auf reinen
 *   In-Memory-Betrieb (heutiges Verhalten) — kein Crash, keine Datei. Eine
 *   korrupte/unlesbare Datei bzw. einzelne korrupte Einträge führen ebenfalls
 *   nicht zum Crash (defensiv übersprungen/leerer Cache).
 *
 * Eintrag-Schema (`DrainJobEntry`, secret-/pfad-frei — drain-restart-robustness
 * AC1/AC2): `{ drainId, project (Slug), trigger:'night'|'manual',
 * status:'running'|'done'|'failed'|'aborted', args?:string[], startedAt,
 * finishedAt?, result?, error? }` — `project` wird gegen einen Slug-Form-Check
 * gehärtet (`PROJECT_SLUG_RE`, analog `DrainReportStore.PROJECT_SLUG_RE`); KEINE
 * absoluten Host-Pfade/Tokens/Roh-Fehlertexte. `result`/`error` sind bereits
 * secret-/pfad-frei (s.u.) und werden mitpersistiert, damit `getJob()` nach
 * einem Neustart weiterhin den vollständigen Status eines bereits terminalen
 * Drains liefert. `status:'aborted'` ist Teil des Enums (additiv für die
 * Boot-Orphan-Markierung einer Folge-Story, docs/specs/drain-restart-robustness.md
 * AC4/AC5 — hier NICHT implementiert, nur das Schema lässt den Wert bereits zu).
 *
 * Status-Modell (headless-manual-drain AC4):
 *   - `running` — Drain gestartet, `drainProject()`-Promise noch offen.
 *   - `done`    — `drainProject()` resolved (Drain sauber konvergiert/gestoppt);
 *                 `result` trägt eine kompakte, secret-/pfad-freie Zusammenfassung
 *                 (`reason`, `flowRuns`, `escalated`) — alles aus dem Drain-Ergebnis,
 *                 keine Pfade/Tokens.
 *   - `failed`  — `drainProject()` rejected; `error` ist ein GENERISCHER,
 *                 secret-/pfad-freier Text (die konkrete Fehlermeldung bleibt im
 *                 Server-Log, landet NIE in der Response).
 *   - `aborted` — verwaister Eintrag (Boot-Wiederanlauf-Folge-Story, hier nur
 *                 Schema-seitig vorgesehen, keine Erzeugung in dieser Story).
 *
 * Vertragsformat `GET /api/projects/:slug/drain/:drainId` bleibt UNVERÄNDERT
 * (`200 {status,result?,error?}` | `404` | `400`, drain-restart-robustness AC2) —
 * `getJob()` liefert weiterhin ausschließlich `{status, result?, error?}`.
 *
 * Security (Floor): `drainId` ist eine reine Korrelations-ID (`randomUUID()`),
 * kein Secret; `result`/`error` sind bewusst secret-/pfad-frei gehalten; die
 * Persistenz schreibt nie einen absoluten Host-Pfad oder Roh-Fehlertext.
 *
 * @module DrainJobRegistry
 */

import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Generischer, secret-/pfad-freier Fehlertext für einen rejecteten Drain. */
export const DRAIN_FAILURE_MESSAGE = 'Drain-Lauf fehlgeschlagen';

/** Erlaubter Trigger-Wert (drain-restart-robustness AC1). */
export const TRIGGERS = Object.freeze(['night', 'manual']);

/** Erlaubte Status-Werte (drain-restart-robustness AC1; 'aborted' additiv für Folge-Story). */
export const STATUSES = Object.freeze(['running', 'done', 'failed', 'aborted']);

/** Erlaubter Projekt-Slug: nur Buchstaben, Ziffern, `-` und `_` (analog DrainReportStore). */
export const PROJECT_SLUG_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @typedef {object} DrainJobResult
 * @property {string} reason
 * @property {number} flowRuns
 * @property {string[]} escalated
 * @property {Array<{id:string,title:string}>} completed
 * @property {Array<{id:string,title:string}>} blocked
 *
 * @typedef {object} DrainJobEntry
 * @property {string} drainId
 * @property {string} project        Projekt-Slug (kein Pfad)
 * @property {'night'|'manual'} trigger
 * @property {'running'|'done'|'failed'|'aborted'} status
 * @property {string[]} [args]
 * @property {string} startedAt      ISO-8601
 * @property {string} [finishedAt]   ISO-8601
 * @property {DrainJobResult} [result]  nur bei `done`
 * @property {string} [error]           nur bei `failed`, generischer Text
 *
 * @typedef {object} DrainJobState
 * @property {'running'|'done'|'failed'|'aborted'} status
 * @property {DrainJobResult} [result]  nur bei `done`
 * @property {string} [error]  generischer, secret-freier Text, nur bei `failed`
 */

/**
 * Liest den Pfad zur Job-Datei aus der Umgebung.
 * Pfad: ${CRED_STORE_DIR}/drain-jobs.json
 *
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveDrainJobsFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'drain-jobs.json');
}

/**
 * Normalisiert/validiert einen rohen Eintrag aus der persistierten Datei.
 * Ein einzelner korrupter/ungültiger Eintrag wird übersprungen (defensiv) statt
 * die gesamte Datei zu verwerfen.
 *
 * @param {unknown} raw
 * @returns {DrainJobEntry|null}
 */
function _normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.drainId !== 'string' || !raw.drainId) return null;
  if (typeof raw.project !== 'string' || !PROJECT_SLUG_RE.test(raw.project)) return null;
  if (!TRIGGERS.includes(raw.trigger)) return null;
  if (!STATUSES.includes(raw.status)) return null;

  /** @type {DrainJobEntry} */
  const entry = {
    drainId: raw.drainId,
    project: raw.project,
    trigger: raw.trigger,
    status: raw.status,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
  };
  if (Array.isArray(raw.args)) {
    const args = raw.args.filter((a) => typeof a === 'string');
    if (args.length > 0) entry.args = args;
  }
  if (typeof raw.finishedAt === 'string') entry.finishedAt = raw.finishedAt;
  if (raw.result && typeof raw.result === 'object') {
    entry.result = {
      reason: typeof raw.result.reason === 'string' ? raw.result.reason : 'stopped',
      flowRuns: Number.isFinite(raw.result.flowRuns) ? raw.result.flowRuns : 0,
      escalated: Array.isArray(raw.result.escalated) ? raw.result.escalated : [],
      completed: Array.isArray(raw.result.completed) ? raw.result.completed : [],
      blocked: Array.isArray(raw.result.blocked) ? raw.result.blocked : [],
    };
  }
  if (typeof raw.error === 'string') entry.error = raw.error;
  return entry;
}

export class DrainJobRegistry {
  /** @type {Map<string, DrainJobEntry>} */
  #jobs = new Map();

  /** @type {string|null} */
  #filePath;

  /** @type {Promise<*>} Serialisierungs-Kette für Schreibzugriffe (kein Race). */
  #queue = Promise.resolve();

  constructor() {
    this.#filePath = resolveDrainJobsFilePath();
    if (this.#filePath) this.#loadSync();
  }

  /**
   * Lädt die persistierte Datei SYNCHRON beim Konstruieren (Muster
   * `CredentialStore#loadMasterKeyFromFile`) — Fehlt die Datei (ENOENT) oder ist
   * sie unlesbar/korrupt → leerer Cache (kein Crash — best-effort).
   */
  #loadSync() {
    let raw;
    try {
      raw = readFileSync(this.#filePath, 'utf8');
    } catch {
      // ENOENT (noch keine Datei) oder anderer Lesefehler → leerer Cache.
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      for (const rawEntry of list) {
        const entry = _normalizeEntry(rawEntry);
        if (entry) this.#jobs.set(entry.drainId, entry);
      }
    } catch (err) {
      // Korrupte Datei → leerer Cache (kein Crash — best-effort).
      console.error('[DrainJobRegistry] Lesen fehlgeschlagen:', err.message);
    }
  }

  /**
   * Registriert einen frisch gestarteten Drain als `running` und persistiert ihn
   * best-effort (drain-restart-robustness AC2).
   *
   * @param {string} drainId
   * @param {{ project?: string, trigger?: 'night'|'manual', args?: string[], startedAt?: string }} [meta]
   *   `project` = Projekt-Slug (kein Pfad); ein ungültiger Slug wird defensiv
   *   NICHT persistiert (leerer String) statt einen Traversal-/Pfad-Wert in die
   *   Datei zu schreiben. `trigger` fehlend/ungültig → Default `'manual'`
   *   (bestehende Aufrufer ohne `meta`, s. headless-manual-drain AC4, bleiben
   *   kompatibel). `startedAt` fehlend → aktueller Zeitstempel.
   * @returns {Promise<void>|undefined}  die (fire-and-forget) Persist-Promise —
   *   bestehende Aufrufer (Router) ignorieren den Rückgabewert unverändert;
   *   Tests können optional `await`en, um auf das Schreiben zu warten.
   */
  register(drainId, meta = {}) {
    const project = typeof meta.project === 'string' && PROJECT_SLUG_RE.test(meta.project)
      ? meta.project
      : '';
    const trigger = TRIGGERS.includes(meta.trigger) ? meta.trigger : 'manual';
    const startedAt = typeof meta.startedAt === 'string' ? meta.startedAt : new Date().toISOString();

    /** @type {DrainJobEntry} */
    const entry = { drainId, project, trigger, status: 'running', startedAt };
    if (Array.isArray(meta.args)) {
      const args = meta.args.filter((a) => typeof a === 'string');
      if (args.length > 0) entry.args = args;
    }

    this.#jobs.set(drainId, entry);
    return this.#persist();
  }

  /**
   * Markiert einen Drain als `done` mit kompakter, secret-/pfad-freier
   * Ergebnis-Zusammenfassung und persistiert terminal (best-effort). No-op,
   * wenn die `drainId` unbekannt ist (defensiv — sollte nach `register()` nie
   * vorkommen).
   *
   * @param {string} drainId
   * @param {{ reason?: string, flowRuns?: number, escalated?: string[],
   *           completed?: Array<{id:string,title:string}>,
   *           blocked?: Array<{id:string,title:string}> }} [result]
   *   Drain-Ergebnis (`ProjectDrain.drainProject()`-Rückgabe). Nur die
   *   secret-freien Felder werden übernommen. `completed`/`blocked`
   *   (drain-completion-report AC1) werden defensiv auf Arrays normalisiert
   *   (fehlend/ungültig → `[]`, kein Crash).
   * @returns {Promise<void>|undefined}
   */
  markDone(drainId, result = {}) {
    const existing = this.#jobs.get(drainId);
    if (!existing) return undefined;
    this.#jobs.set(drainId, {
      ...existing,
      status: 'done',
      finishedAt: new Date().toISOString(),
      result: {
        reason: typeof result.reason === 'string' ? result.reason : 'stopped',
        flowRuns: Number.isFinite(result.flowRuns) ? result.flowRuns : 0,
        escalated: Array.isArray(result.escalated) ? result.escalated : [],
        completed: Array.isArray(result.completed) ? result.completed : [],
        blocked: Array.isArray(result.blocked) ? result.blocked : [],
      },
    });
    return this.#persist();
  }

  /**
   * Markiert einen Drain als `failed` mit einem generischen, secret-freien
   * Text und persistiert terminal (best-effort). No-op bei unbekannter `drainId`.
   * @param {string} drainId
   * @param {string} [error]  default: DRAIN_FAILURE_MESSAGE (kein Roh-Fehlertext!)
   * @returns {Promise<void>|undefined}
   */
  markFailed(drainId, error = DRAIN_FAILURE_MESSAGE) {
    const existing = this.#jobs.get(drainId);
    if (!existing) return undefined;
    this.#jobs.set(drainId, {
      ...existing,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error,
    });
    return this.#persist();
  }

  /**
   * Liest den aktuellen Status eines Drains (headless-manual-drain AC4).
   * Vertragsformat unverändert (drain-restart-robustness AC2): ausschließlich
   * `{status, result?, error?}` — interne Felder (`project`/`trigger`/`args`/
   * `startedAt`) werden NICHT nach außen gereicht.
   *
   * @param {string} drainId
   * @returns {DrainJobState | undefined}  undefined → unbekannte drainId (→ 404)
   */
  getJob(drainId) {
    const entry = this.#jobs.get(drainId);
    if (!entry) return undefined;
    /** @type {DrainJobState} */
    const state = { status: entry.status };
    if (entry.result !== undefined) state.result = entry.result;
    if (entry.error !== undefined) state.error = entry.error;
    return state;
  }

  /**
   * Schreibt den aktuellen Job-Cache atomar (tmp + rename, Muster
   * `DrainReportStore#persist`) — best-effort/fire-and-forget, serialisiert über
   * eine In-Process-Kette (kein Read-Modify-Write-Race). Ohne `CRED_STORE_DIR`
   * → No-op (In-Memory-Betrieb). Ein Schreibfehler ist non-fatal (nur geloggt).
   *
   * @returns {Promise<void>}
   */
  #persist() {
    if (!this.#filePath) return; // degradiert: nur In-Memory (best-effort, kein Crash)
    this.#queue = this.#queue.then(() => this.#doPersist(), () => this.#doPersist());
    return this.#queue;
  }

  /** @returns {Promise<void>} */
  async #doPersist() {
    const filePath = this.#filePath;
    const jobs = [...this.#jobs.values()];
    const json = JSON.stringify({ jobs }, null, 2);
    const tmpPath = `${filePath}.tmp.${randomBytes(4).toString('hex')}`;

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, filePath);
      await chmod(filePath, 0o600).catch(() => {});
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      // Non-fatal — der Drain-/Registry-Ablauf darf durch einen Schreibfehler nie stören.
      console.error('[DrainJobRegistry] Atomar-Schreiben fehlgeschlagen:', err.message);
    }
  }
}
