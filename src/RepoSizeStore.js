/**
 * RepoSizeStore — Persistente Repo-Größen-Ablage (docs/specs/repo-size-badge.md AC3).
 *
 * Hält je Klon-Slug EINEN letzten Messwert: { total, git, artifacts, workspace, measuredAt }.
 * Muster: `DrainReportStore.js` / `TickerSettingsStore.js` — eine Plaintext-JSON-Datei
 * unter `${CRED_STORE_DIR}`, atomarer Schreibzugriff (tmp + rename).
 *
 * Datei: ${CRED_STORE_DIR}/repo-sizes.json
 * Rechte: 0600 (konsistent restriktiv, obwohl nicht-geheim)
 * Schreiben: atomar (tmp + rename)
 *
 * Größen-Schema (AC3, verbindlich):
 *   { total: number, git: number, artifacts: number, workspace: number, measuredAt: string|null }
 *   - total, git, artifacts, workspace = Bytes (konsistent, tatsächliche Datei-Größen)
 *   - measuredAt = ISO-8601-Zeitstempel oder null (wenn nie vermessen)
 *   - Slug-Schlüssel: reiner Repo-Name (kein per-Request-Dateipfad daraus)
 *
 * Persistenz & Robustheit:
 *   - Bei erstem `record()`: keine Größe-Limit pro Klon (im Gegensatz zu DrainReportStore).
 *     Die Ablage wird nur durch die Anzahl Repos groß — normalerweise < 50 Klone.
 *   - Fehlt `${CRED_STORE_DIR}` → In-Memory-Degradation (kein Crash).
 *   - Ein Schreib-Fehler ist non-fatal (best-effort).
 *
 * Nebenläufigkeit:
 *   - `record()`-Aufrufe werden über eine In-Process-Promise-Kette serialisiert
 *     (kein Read-Modify-Write-Race innerhalb des Prozesses).
 *   - Datei wird atomar geschrieben (tmp + rename verhindert korrupte Datei).
 *
 * Security (Floor):
 *   - Keine absoluten Host-Pfade, Tokens oder Roh-Fehlertexte in Store/Response/Log.
 *   - Slug wird gegen einen einfachen Form-Check gehärtet (nur [A-Za-z0-9_-]).
 *   - `record()` akzeptiert nur eindeutige Zahlen für Größen.
 *
 * @module RepoSizeStore
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Erlaubter Slug-Format: nur Buchstaben, Ziffern, `-` und `_` (analog DrainReportStore). */
export const REPO_SLUG_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @typedef {object} RepoSize
 * @property {number} total      Gesamtgröße (git + artifacts + workspace), in Bytes.
 * @property {number} git        `.git`-Verzeichnis-Größe, in Bytes.
 * @property {number} artifacts  Summe aller Artefakt-Verzeichnisse, in Bytes.
 * @property {number} workspace  Arbeitsstand (Code/Docs), in Bytes.
 * @property {string|null} measuredAt  ISO-8601-Zeitstempel oder null.
 */

/**
 * Liest den Pfad zur Größen-Datei aus der Umgebung.
 * Pfad: ${CRED_STORE_DIR}/repo-sizes.json
 *
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveSizeFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'repo-sizes.json');
}

export class RepoSizeStore {
  /** @type {Map<string, RepoSize>|null} In-Memory-Cache; null bis erstmals geladen. */
  #sizes = null;
  /** @type {Promise<void>|null} einmaliger Lade-Vorgang (idempotent). */
  #loadPromise = null;
  /** @type {Promise<*>} Serialisierungs-Kette für record() (kein Read-Modify-Write-Race). */
  #queue = Promise.resolve();

  /**
   * Lädt die persistierten Größen einmalig in den In-Memory-Cache.
   * Fehlt die Datei (ENOENT) oder ist sie unlesbar/korrupt → leerer Cache
   * (kein Crash — die Ablage ist best-effort).
   *
   * @returns {Promise<void>}
   */
  async #ensureLoaded() {
    if (this.#sizes !== null) return;
    if (!this.#loadPromise) this.#loadPromise = this.#load();
    await this.#loadPromise;
  }

  /** @returns {Promise<void>} */
  async #load() {
    const filePath = resolveSizeFilePath();
    if (!filePath) {
      // Kein CRED_STORE_DIR → reiner In-Memory-Betrieb (degradiert, non-fatal).
      this.#sizes = new Map();
      return;
    }
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const data = parsed?.sizes ?? {};
      this.#sizes = new Map();

      // Jeder Eintrag validieren und laden
      for (const [slug, value] of Object.entries(data)) {
        if (typeof slug === 'string' && REPO_SLUG_RE.test(slug) && value && typeof value === 'object') {
          const size = {
            total: Number.isFinite(value.total) ? value.total : 0,
            git: Number.isFinite(value.git) ? value.git : 0,
            artifacts: Number.isFinite(value.artifacts) ? value.artifacts : 0,
            workspace: Number.isFinite(value.workspace) ? value.workspace : 0,
            measuredAt:
              typeof value.measuredAt === 'string' ? value.measuredAt : null,
          };
          this.#sizes.set(slug, size);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[RepoSizeStore] Lesen fehlgeschlagen:', err.message);
      }
      this.#sizes = new Map();
    }
  }

  /**
   * Speichert einen Messwert (AC3): stempelt `measuredAt` mit ISO-Zeitstempel,
   * speichert atomar und serialisiert über eine In-Process-Kette.
   *
   * @param {string} repoSlug  Klon-Slug (kein Pfad) — Pflicht, validiert.
   * @param {{ total: number, git: number, artifacts: number, workspace: number }} buckets
   * @returns {Promise<RepoSize>} der gespeicherte Messwert.
   * @throws {Error} wenn Slug ungültig ist oder Größen nicht-finite Zahlen sind.
   */
  record(repoSlug, buckets) {
    const run = () => this.#doRecord(repoSlug, buckets);
    // .then(run, run): eine vorherige Rejection blockiert die Kette nicht.
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }

  /**
   * @param {string} repoSlug
   * @param {object} buckets
   * @returns {Promise<RepoSize>}
   */
  async #doRecord(repoSlug, buckets) {
    const slug = repoSlug?.toString().trim();
    if (typeof slug !== 'string' || !REPO_SLUG_RE.test(slug)) {
      throw new Error('[RepoSizeStore] Ungültiger repo-Slug — kein Datensatz geschrieben.');
    }

    // Größen validieren
    const total = buckets?.total ?? 0;
    const git = buckets?.git ?? 0;
    const artifacts = buckets?.artifacts ?? 0;
    const workspace = buckets?.workspace ?? 0;

    if (!Number.isFinite(total) || !Number.isFinite(git) ||
        !Number.isFinite(artifacts) || !Number.isFinite(workspace)) {
      throw new Error('[RepoSizeStore] Größen-Werte müssen finite Zahlen sein.');
    }

    await this.#ensureLoaded();

    /** @type {RepoSize} */
    const size = {
      total,
      git,
      artifacts,
      workspace,
      measuredAt: new Date().toISOString(),
    };

    this.#sizes.set(slug, size);

    await this.#persist();
    return size;
  }

  /**
   * Liefert einen Messwert read-only für einen Slug (AC3), oder null wenn nicht
   * vorhanden. Arbeitet ausschließlich auf dem In-Memory-Cache — KEIN Datei-
   * Zugriff pro Aufruf; ein ungültiger/traversierender Slug hat daher keine
   * Dateiwirkung (null).
   *
   * @param {string} repoSlug
   * @returns {Promise<RepoSize|null>}
   */
  async get(repoSlug) {
    const slug = repoSlug?.toString().trim();
    if (typeof slug !== 'string' || !REPO_SLUG_RE.test(slug)) {
      return null; // Ungültiger Slug → kein Eintrag
    }

    await this.#ensureLoaded();
    const size = this.#sizes.get(slug);
    if (!size) return null;

    // Deep copy für read-only Semantik
    return { ...size };
  }

  /**
   * Liefert alle Messwerte read-only (AC3).
   *
   * @returns {Promise<Map<string, RepoSize>>} Map von Slug → Messwert (deep copy).
   */
  async list() {
    await this.#ensureLoaded();
    const result = new Map();
    for (const [slug, size] of this.#sizes) {
      result.set(slug, { ...size });
    }
    return result;
  }

  /**
   * Schreibt den aktuellen Cache atomar (tmp + rename, Muster DrainReportStore).
   * Ohne CRED_STORE_DIR → No-op (In-Memory-Betrieb).
   *
   * @returns {Promise<void>}
   */
  async #persist() {
    const filePath = resolveSizeFilePath();
    if (!filePath) return; // degradiert: nur In-Memory (best-effort, kein Crash)

    // Map in Objekt konvertieren
    const sizes = {};
    for (const [slug, size] of this.#sizes) {
      sizes[slug] = size;
    }

    const json = JSON.stringify({ sizes }, null, 2);
    const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');

    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      const e = new Error(`[RepoSizeStore] Atomar-Schreiben fehlgeschlagen: ${err.message}`);
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
