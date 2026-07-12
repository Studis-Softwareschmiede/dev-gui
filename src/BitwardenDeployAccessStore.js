/**
 * BitwardenDeployAccessStore — eigener 0600-Speicher für den UNBEAUFSICHTIGTEN
 * Bitwarden-Zugang der Deploy-Rolle (Variante B).
 *
 * Warum ein EIGENER Speicher (nicht CredentialStore) — Henne-Ei (Spec §2, AC4):
 * Der `CredentialStore` wird durch den Master-Key entsperrt, und der Master-Key
 * kommt aus Bitwarden. Der Bitwarden-ZUGANG selbst (API-Key + Master-Passwort)
 * kann daher NICHT im `CredentialStore` liegen — ohne diesen Zugang ist der Store
 * gar nicht entsperrt. Er lebt deshalb hier, außerhalb, in einer eigenen Datei.
 *
 * Datei: ${CRED_STORE_DIR}/bitwarden-deploy-access.json
 * Rechte: 0600. Schreiben: atomar (tmp + rename), Muster `DrainReportStore`.
 * Ohne CRED_STORE_DIR: reine In-Memory-Degradation (kein Crash) + Warn-Log;
 * `getStatus().persisted === false` (Spec AC1).
 *
 * Boundary-Vertrag (write-only nach außen, Spec S1/AC2/AC3):
 *   - `getStatus()` liefert je Feld NUR `{ set, updatedAt? }` + aggregiertes `ready`.
 *     KEIN Klartext.
 *   - `getAccessForLogin()` ist ausschließlich für interne Konsumenten
 *     (BitwardenDeployLoginService) — Klartext verlässt den Store NICHT Richtung
 *     HTTP/Log/Audit.
 *
 * Sicherheit (Spec S6): Der Inhalt ist at rest bewusst klartext-nah — es gibt
 * keinen Master-Key, um ihn zu schützen (das ist ja gerade der Zugang zu jenem
 * Key). Nur für LOKALEN Betrieb akzeptiert; 0600 begrenzt den Zugriff auf den
 * Datei-Eigentümer.
 *
 * @module BitwardenDeployAccessStore
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Erlaubte Feldnamen. `server_url` ist optional (Default beim Login-Dienst);
 * die drei anderen sind für `ready` erforderlich (Spec AC2).
 */
export const ACCESS_FIELDS = Object.freeze([
  'server_url',
  'client_id',
  'client_secret',
  'master_password',
]);

/** Felder, die für `ready` (unbeaufsichtigter Login möglich) gesetzt sein müssen. */
export const REQUIRED_FOR_READY = Object.freeze([
  'client_id',
  'client_secret',
  'master_password',
]);

/** Maximale Länge eines Zugangs-Werts (Bytes). Großzügig, aber begrenzt. */
export const MAX_ACCESS_VALUE_BYTES = 4096;

/**
 * Pfad zur Zugangs-Datei: ${CRED_STORE_DIR}/bitwarden-deploy-access.json
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveAccessFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'bitwarden-deploy-access.json');
}

export class BitwardenDeployAccessStore {
  /**
   * In-Memory-Cache. `null` bis erstmals geladen.
   * Schema: { [field]: { value: string, updatedAt: string } }
   * @type {Record<string, { value: string, updatedAt: string }>|null}
   */
  #fields = null;
  /** @type {Promise<void>|null} */
  #loadPromise = null;
  /** @type {Promise<*>} Serialisierungs-Kette (kein Read-Modify-Write-Race). */
  #queue = Promise.resolve();

  /** @returns {Promise<void>} */
  async #ensureLoaded() {
    if (this.#fields !== null) return;
    if (!this.#loadPromise) this.#loadPromise = this.#load();
    await this.#loadPromise;
  }

  /** @returns {Promise<void>} */
  async #load() {
    const filePath = resolveAccessFilePath();
    if (!filePath) {
      console.warn('[BitwardenDeployAccessStore] CRED_STORE_DIR nicht gesetzt — In-Memory-Betrieb (nicht persistiert).');
      this.#fields = {};
      return;
    }
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const src = (parsed && typeof parsed.fields === 'object' && parsed.fields) || {};
      /** @type {Record<string, { value: string, updatedAt: string }>} */
      const out = {};
      for (const name of ACCESS_FIELDS) {
        const entry = src[name];
        if (entry && typeof entry === 'object' && typeof entry.value === 'string') {
          out[name] = {
            value: entry.value,
            updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
          };
        }
      }
      this.#fields = out;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // KEIN Roh-Inhalt/Wert ins Log (Security) — nur der Fehlercode/-text.
        console.error('[BitwardenDeployAccessStore] Lesen fehlgeschlagen:', err.message);
      }
      this.#fields = {};
    }
  }

  /**
   * Status-Ansicht (write-only, Spec AC2). Liefert je Feld nur, OB es gesetzt ist
   * und wann zuletzt — NIE den Wert.
   *
   * @returns {Promise<{
   *   persisted: boolean,
   *   ready: boolean,
   *   fields: Record<string, { set: boolean, updatedAt: string|null }>
   * }>}
   */
  async getStatus() {
    await this.#ensureLoaded();
    /** @type {Record<string, { set: boolean, updatedAt: string|null }>} */
    const fields = {};
    for (const name of ACCESS_FIELDS) {
      const entry = this.#fields[name];
      fields[name] = {
        set: Boolean(entry && entry.value),
        updatedAt: entry && entry.updatedAt ? entry.updatedAt : null,
      };
    }
    const ready = REQUIRED_FOR_READY.every((name) => Boolean(this.#fields[name]?.value));
    return {
      persisted: resolveAccessFilePath() !== null,
      ready,
      fields,
    };
  }

  /**
   * Setzt/überschreibt genau ein Feld (Spec AC3). Serialisiert über die Kette.
   *
   * @param {string} name  einer aus ACCESS_FIELDS
   * @param {string} value Klartext (wird NUR persistiert, nie geloggt)
   * @returns {Promise<{ set: boolean, updatedAt: string|null }>} Status DIESES Felds
   * @throws {Error} bei ungültigem Feldnamen, leerem Wert oder Längenlimit.
   */
  setField(name, value) {
    const run = () => this.#doSetField(name, value);
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }

  /** @returns {Promise<{ set: boolean, updatedAt: string|null }>} */
  async #doSetField(name, value) {
    if (!ACCESS_FIELDS.includes(name)) {
      throw new Error('unknown-field');
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('empty-value');
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_ACCESS_VALUE_BYTES) {
      throw new Error('value-too-long');
    }

    await this.#ensureLoaded();
    const updatedAt = new Date().toISOString();
    this.#fields[name] = { value, updatedAt };
    await this.#persist();
    return { set: true, updatedAt };
  }

  /**
   * Entfernt genau ein Feld (Spec AC3). Idempotent.
   *
   * @param {string} name
   * @returns {Promise<{ set: boolean, updatedAt: null }>}
   * @throws {Error} bei ungültigem Feldnamen.
   */
  clearField(name) {
    const run = () => this.#doClearField(name);
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }

  /** @returns {Promise<{ set: boolean, updatedAt: null }>} */
  async #doClearField(name) {
    if (!ACCESS_FIELDS.includes(name)) {
      throw new Error('unknown-field');
    }
    await this.#ensureLoaded();
    if (this.#fields[name]) {
      delete this.#fields[name];
      await this.#persist();
    }
    return { set: false, updatedAt: null };
  }

  /**
   * Liefert den Zugang im Klartext — NUR für interne Konsumenten
   * (BitwardenDeployLoginService, Spec AC3). Niemals über HTTP/Log/Audit.
   *
   * @returns {Promise<{
   *   ready: boolean,
   *   serverUrl: string|null,
   *   clientId: string|null,
   *   clientSecret: string|null,
   *   masterPassword: string|null
   * }>}
   */
  async getAccessForLogin() {
    await this.#ensureLoaded();
    const ready = REQUIRED_FOR_READY.every((name) => Boolean(this.#fields[name]?.value));
    return {
      ready,
      serverUrl: this.#fields.server_url?.value ?? null,
      clientId: this.#fields.client_id?.value ?? null,
      clientSecret: this.#fields.client_secret?.value ?? null,
      masterPassword: this.#fields.master_password?.value ?? null,
    };
  }

  /**
   * Schreibt den Cache atomar (tmp + rename, 0600). Ohne CRED_STORE_DIR → No-op.
   * @returns {Promise<void>}
   */
  async #persist() {
    const filePath = resolveAccessFilePath();
    if (!filePath) return; // degradiert: nur In-Memory

    const json = JSON.stringify({ version: 1, fields: this.#fields }, null, 2);
    const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');

    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      const e = new Error(`[BitwardenDeployAccessStore] Atomar-Schreiben fehlgeschlagen: ${err.message}`);
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
