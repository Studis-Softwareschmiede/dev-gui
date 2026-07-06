/**
 * FeatureDrainRegistry — persistente Status-Registry für Feature-Batch-Läufe
 * (feature-umsetzen-button, Owner-Auftrag 2026-07-06). Muster identisch zu
 * `DrainJobRegistry.js` (headless-manual-drain/drain-restart-robustness) —
 * eigene, getrennte Registry statt Wiederverwendung, da Feature-Batch-Läufe
 * eine andere Schlüsselform brauchen (Projekt+Feature statt nur Projekt) und
 * eine eigene, unabhängige Boundary sind (kein zweiter Codepfad in einer
 * bereits stark verzweigten Registry).
 *
 * Job-Key: `${projectSlug}:${featureId}` (z.B. "dev-gui:F-042") — höchstens
 * EIN laufender Batch je Feature (Dedup via `ProjectJobLock`, s. Router).
 *
 * Persistenz: Datei `${CRED_STORE_DIR}/feature-drain-jobs.json`, atomarer
 * tmp+rename-Schreibzugriff, Rechte 0600. Ohne `CRED_STORE_DIR` → reiner
 * In-Memory-Betrieb (kein Crash, keine Datei). Synchroner Ladevorgang im
 * Konstruktor (Muster `CredentialStore#loadMasterKeyFromFile`).
 *
 * @module FeatureDrainRegistry
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const STATUSES = Object.freeze(['running', 'done', 'failed']);
export const PROJECT_SLUG_RE = /^[A-Za-z0-9_-]+$/;
export const FEATURE_ID_RE = /^F-\d+$/;

export function resolveFeatureDrainFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'feature-drain-jobs.json');
}

function jobKey(projectSlug, featureId) {
  return `${projectSlug}:${featureId}`;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.project !== 'string' || !PROJECT_SLUG_RE.test(raw.project)) return null;
  if (typeof raw.featureId !== 'string' || !FEATURE_ID_RE.test(raw.featureId)) return null;
  if (!STATUSES.includes(raw.status)) return null;
  const entry = {
    project: raw.project,
    featureId: raw.featureId,
    status: raw.status,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
  };
  if (typeof raw.finishedAt === 'string') entry.finishedAt = raw.finishedAt;
  if (typeof raw.error === 'string') entry.error = raw.error;
  return entry;
}

export class FeatureDrainRegistry {
  #jobs = new Map();
  #filePath;
  #queue = Promise.resolve();

  constructor() {
    this.#filePath = resolveFeatureDrainFilePath();
    if (this.#filePath) this.#loadSync();
  }

  #loadSync() {
    let raw;
    try {
      raw = readFileSync(this.#filePath, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      for (const rawEntry of list) {
        const entry = normalizeEntry(rawEntry);
        if (entry) this.#jobs.set(jobKey(entry.project, entry.featureId), entry);
      }
    } catch (err) {
      console.error('[FeatureDrainRegistry] Lesen fehlgeschlagen:', err.message);
    }
  }

  #persist() {
    if (!this.#filePath) return Promise.resolve();
    this.#queue = this.#queue.then(() => {
      try {
        mkdirSync(dirname(this.#filePath), { recursive: true });
        const tmp = `${this.#filePath}.${randomBytes(6).toString('hex')}.tmp`;
        writeFileSync(tmp, JSON.stringify({ jobs: [...this.#jobs.values()] }, null, 2), { mode: 0o600 });
        renameSync(tmp, this.#filePath);
        chmodSync(this.#filePath, 0o600);
      } catch (err) {
        console.error('[FeatureDrainRegistry] Schreiben fehlgeschlagen:', err.message);
      }
    }, () => {});
    return this.#queue;
  }

  /**
   * Registriert einen frisch gestarteten Feature-Batch als `running`.
   * @param {string} projectSlug
   * @param {string} featureId
   * @returns {Promise<void>|undefined}
   */
  register(projectSlug, featureId) {
    if (!PROJECT_SLUG_RE.test(projectSlug) || !FEATURE_ID_RE.test(featureId)) return undefined;
    this.#jobs.set(jobKey(projectSlug, featureId), {
      project: projectSlug,
      featureId,
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    return this.#persist();
  }

  markDone(projectSlug, featureId) {
    const key = jobKey(projectSlug, featureId);
    const entry = this.#jobs.get(key);
    if (!entry) return undefined;
    entry.status = 'done';
    entry.finishedAt = new Date().toISOString();
    return this.#persist();
  }

  markFailed(projectSlug, featureId, error = 'Feature-Batch fehlgeschlagen') {
    const key = jobKey(projectSlug, featureId);
    const entry = this.#jobs.get(key);
    if (!entry) return undefined;
    entry.status = 'failed';
    entry.finishedAt = new Date().toISOString();
    entry.error = String(error).slice(0, 500);
    return this.#persist();
  }

  /** @returns {{status:string,startedAt:string,finishedAt?:string,error?:string}|null} */
  getJob(projectSlug, featureId) {
    const entry = this.#jobs.get(jobKey(projectSlug, featureId));
    return entry ? { ...entry } : null;
  }

  isRunning(projectSlug, featureId) {
    return this.getJob(projectSlug, featureId)?.status === 'running';
  }
}
