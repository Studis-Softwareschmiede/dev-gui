/**
 * CredentialStore — einziger Lese-/Schreibpfad zu `secrets.enc.json`.
 *
 * Persistiert Credentials at rest via AES-256-GCM (Node `crypto`).
 * Master-Key aus Env `CRED_MASTER_KEY` (optional `CRED_MASTER_KEY_FILE`),
 * per scrypt zu 32-Byte-AES-Schlüssel abgeleitet.
 *
 * Boundary-Vertrag (write-only nach außen):
 *   - `list()` / `getMeta(key)` liefern nur Metadaten (status, masked, updatedAt).
 *   - `getPlaintext(key)` ist ausschließlich für interne Konsumenten (z.B. VpsProvisioner).
 *   - Klartext verlässt den Store NICHT Richtung HTTP/Log/Audit.
 *
 * SSH-Key-Unterstützung (ADR-007 / ADR-008):
 *   - Public-Keys: Klartext-Metadatum im `meta`-Block (nicht verschlüsselt, nicht geheim).
 *   - Private-Keys: verschlüsselt in `entries` unter Schema `ssh/<user>/private_key`.
 *   - API: getPublicKey(user), setPublicKey(user, key), deletePublicKey(user),
 *           listSshKeys() → [{ user, publicKey?, privateKeyStatus }]
 *
 * Datei-Schema (ADR-007):
 * {
 *   "version": 1,
 *   "kdf": { "algo": "scrypt", "salt": "<b64>", "N": 16384, "r": 8, "p": 1 },
 *   "entries": {
 *     "credentials/<integration>/<name>": { "iv": "<b64>", "tag": "<b64>", "ct": "<b64>", "updatedAt": "<iso>" },
 *     "ssh/<user>/private_key":          { "iv": "<b64>", "tag": "<b64>", "ct": "<b64>", "updatedAt": "<iso>" }
 *   },
 *   "meta": {
 *     "ssh/<user>/public_key": { "value": "<openssh-pubkey>", "updatedAt": "<iso>" }
 *   }
 * }
 *
 * Security (ADR-007 / security/R01 / security/R06):
 *   - Master-Key nie geloggt oder persistiert.
 *   - GCM-Tag wird bei Lesen verifiziert; Manipulation → harter Fehler.
 *   - Atomares Schreiben (tmp + fsync + rename).
 *   - Schreib-Mutex verhindert race conditions bei konkurrenten Requests.
 *   - Fail-Fast in Prod: existiert Store aber kein Key → Prozess bricht ab.
 *
 * @module CredentialStore
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, rename, mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';

const scryptAsync = promisify(scrypt);

// ── Katalog bekannter Credential-Felder (ADR-007) ─────────────────────────────
export const CREDENTIAL_CATALOG = {
  github: ['app_id', 'installation_id', 'private_key'],
  cloudflare: ['api_token', 'account_id'],
  vps: ['hetzner_api_token'],
};

/** Maximale Länge eines Credential-Werts (Bytes). */
const MAX_VALUE_BYTES = 65536; // 64 KiB

/** meta-Block-Schlüssel für den konfigurierten Workspace-Root (workspace-path-config, AC4/AC6). */
const WORKSPACE_PATH_META_KEY = 'settings/workspace-path';

/** Erlaubte Zeichen für misc-Schlüsselnamen. */
const MISC_NAME_RE = /^[a-zA-Z0-9_\-.:@]+$/;

/** Maximale Länge eines misc-Schlüsselnamens. */
const MAX_MISC_NAME_LEN = 128;

/** Erlaubte Zeichen für SSH-Benutzer-Labels (sync mit sshKeysRouter). */
const USER_LABEL_RE = /^[a-zA-Z0-9_\-.:@]+$/;

/** Maximale Länge eines SSH-Benutzer-Labels. */
const MAX_USER_LABEL_LEN = 64;

/** scrypt-Parameter (ADR-007). */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;


/**
 * Baut den Speicher-Key für einen bekannten Katalog-Eintrag.
 * @param {string} integration
 * @param {string} name
 * @returns {string}
 */
export function catalogKey(integration, name) {
  return `credentials/${integration}/${name}`;
}

/**
 * Prüft ob integration+name im Katalog oder misc ist.
 * Gibt { ok: true, storeKey } oder { ok: false, error } zurück.
 *
 * @param {string} integration
 * @param {string} name
 * @returns {{ ok: boolean, storeKey?: string, error?: string }}
 */
export function resolveKey(integration, name) {
  if (!integration || !name) {
    return { ok: false, error: 'integration und name sind Pflicht' };
  }

  if (integration === 'misc') {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_MISC_NAME_LEN) {
      return { ok: false, error: `misc-Name muss 1–${MAX_MISC_NAME_LEN} Zeichen lang sein` };
    }
    if (!MISC_NAME_RE.test(name)) {
      return { ok: false, error: 'misc-Name enthält unerlaubte Zeichen (erlaubt: a-z A-Z 0-9 _ - . : @)' };
    }
    return { ok: true, storeKey: `credentials/misc/${name}` };
  }

  const known = CREDENTIAL_CATALOG[integration];
  if (!known) {
    return { ok: false, error: `Unbekannte Integration: ${integration}` };
  }
  if (!known.includes(name)) {
    return { ok: false, error: `Unbekanntes Feld '${name}' für Integration '${integration}'` };
  }
  return { ok: true, storeKey: `credentials/${integration}/${name}` };
}

// ── CredentialStore ────────────────────────────────────────────────────────────

export class CredentialStore {
  /** @type {string} Pfad zur secrets.enc.json */
  #filePath;

  /** @type {string|null} Master-Key-Rohwert (aus Env) */
  #masterKeyRaw = null;

  /** @type {Promise<void>|null} Schreib-Mutex */
  #writeLock = null;

  /**
   * @param {object} [opts]
   * @param {string} [opts.dir]         - Verzeichnis (default: /home/node/.claude/dev-gui)
   * @param {string} [opts.masterKey]   - Master-Key (für Tests injizierbar; sonst aus Env)
   */
  constructor(opts = {}) {
    const dir = opts.dir ?? '/home/node/.claude/dev-gui';
    this.#filePath = join(dir, 'secrets.enc.json');

    if (opts.masterKey !== undefined) {
      this.#masterKeyRaw = opts.masterKey;
    } else {
      this.#masterKeyRaw = this.#loadMasterKeyFromEnv();
    }
  }

  /**
   * Fail-Fast-Prüfung: In Produktion muss der Key vorhanden sein, wenn
   * der Store bereits existiert. Wirf einen Fehler, wenn nicht.
   * Analog zu `assertAccessConfig`.
   *
   * @returns {Promise<void>}
   */
  async assertCredentialConfig() {
    const isProd = process.env.NODE_ENV === 'production';
    const devBypass = process.env.DEV_NO_ACCESS === '1' && !isProd;

    if (devBypass && !this.#masterKeyRaw) {
      // Dev-Fallback: kein Key gesetzt, kein Store erwartet — OK, warn
      console.warn('[CredentialStore] Kein CRED_MASTER_KEY gesetzt (Dev-Modus) — Credential-Store inaktiv');
      return;
    }

    // Prüfen ob Store-Datei existiert und verschlüsselte Einträge enthält
    let hasEncryptedEntries = false;
    try {
      await stat(this.#filePath);
      // Datei existiert — prüfen ob verschlüsselte entries vorhanden sind
      try {
        const raw = await readFile(this.#filePath, 'utf8');
        const parsed = JSON.parse(raw);
        hasEncryptedEntries = parsed?.kdf != null && Object.keys(parsed?.entries ?? {}).length > 0;
      } catch {
        // Unlesbarer Store → ebenfalls Fail-Fast (ADR-007: kein stilles Fallback)
        hasEncryptedEntries = true;
      }
    } catch {
      // ENOENT: kein Store → kein Problem
    }

    if (hasEncryptedEntries && !this.#masterKeyRaw) {
      throw new Error(
        '[CredentialStore] secrets.enc.json enthält verschlüsselte Einträge, aber CRED_MASTER_KEY fehlt. ' +
        'Prozess wird abgebrochen (Fail-Fast). Env-Var CRED_MASTER_KEY setzen.',
      );
    }
  }

  /**
   * Liest den Master-Key aus Env-Vars.
   * Vorrang: CRED_MASTER_KEY > CRED_MASTER_KEY_FILE
   * @returns {string|null}
   */
  #loadMasterKeyFromEnv() {
    const direct = process.env.CRED_MASTER_KEY;
    if (direct && direct.trim()) {
      return direct.trim();
    }
    // CRED_MASTER_KEY_FILE: Datei-Inhalt wird lazy gelesen (synchron im Konstruktor nicht möglich)
    // — wird in #ensureKey() nachgeladen
    return null;
  }

  /**
   * Liefert den Master-Key-Rohwert (lädt CRED_MASTER_KEY_FILE falls nötig).
   * @returns {Promise<string>}
   */
  async #ensureKey() {
    if (this.#masterKeyRaw) return this.#masterKeyRaw;

    // Versuche CRED_MASTER_KEY_FILE
    const keyFile = process.env.CRED_MASTER_KEY_FILE;
    if (keyFile && keyFile.trim()) {
      try {
        const content = await readFile(keyFile.trim(), 'utf8');
        const key = content.trim();
        if (key) {
          this.#masterKeyRaw = key;
          return key;
        }
      } catch (err) {
        throw new Error(`[CredentialStore] CRED_MASTER_KEY_FILE konnte nicht gelesen werden: ${err.message}`, { cause: err });
      }
    }

    throw new Error('[CredentialStore] Kein Master-Key konfiguriert (CRED_MASTER_KEY / CRED_MASTER_KEY_FILE)');
  }

  /**
   * Leitet den 32-Byte-AES-Key aus dem Master-Key + Salt (scrypt) ab.
   * @param {string} masterKeyRaw
   * @param {Buffer} salt
   * @returns {Promise<Buffer>}
   */
  async #deriveKey(masterKeyRaw, salt) {
    return scryptAsync(masterKeyRaw, salt, KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
  }

  /**
   * Verschlüsselt einen Klartext-String mit dem gegebenen AES-Key.
   * Gibt { iv, tag, ct } als Base64-Strings zurück.
   *
   * @param {Buffer} aesKey
   * @param {string} plaintext
   * @returns {{ iv: string, tag: string, ct: string }}
   */
  #encrypt(aesKey, plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
    };
  }

  /**
   * Entschlüsselt einen Eintrag mit dem gegebenen AES-Key.
   * Wirft bei GCM-Tag-Fehler (manipulierte Datei).
   *
   * @param {Buffer} aesKey
   * @param {{ iv: string, tag: string, ct: string }} entry
   * @returns {string} Klartext
   */
  #decrypt(aesKey, entry) {
    const iv = Buffer.from(entry.iv, 'base64');
    const tag = Buffer.from(entry.tag, 'base64');
    const ct = Buffer.from(entry.ct, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    try {
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString('utf8');
    } catch {
      throw new Error('[CredentialStore] GCM-Tag-Verifikation fehlgeschlagen — Datei manipuliert oder Key falsch');
    }
  }

  /**
   * Liest und parsed die Store-Datei.
   * Gibt `null` zurück wenn die Datei nicht existiert (leerer Store).
   *
   * @returns {Promise<object|null>}
   */
  async #readStore() {
    try {
      const raw = await readFile(this.#filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`[CredentialStore] Store-Datei konnte nicht gelesen werden: ${err.message}`, { cause: err });
    }
  }

  /**
   * Schreibt den Store atomar (tmp + fsync + rename).
   *
   * @param {object} data
   */
  async #writeStore(data) {
    const tmp = `${this.#filePath}.tmp`;
    const dir = this.#filePath.replace(/\/[^/]+$/, '');

    // Verzeichnis idempotent anlegen (mode 0700)
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const json = JSON.stringify(data, null, 2);

    // Schreiben + fsync + rename (atomar)
    let fd;
    try {
      fd = await open(tmp, 'w', 0o600);
      await fd.writeFile(json, 'utf8');
      await fd.sync();
    } finally {
      if (fd) await fd.close();
    }

    await rename(tmp, this.#filePath);
  }

  /**
   * Schreib-Mutex: serialisiert konkurrierende Schreibzugriffe.
   * @param {() => Promise<void>} fn
   */
  async #withWriteLock(fn) {
    while (this.#writeLock) {
      await this.#writeLock;
    }
    let resolve;
    this.#writeLock = new Promise((r) => { resolve = r; });
    try {
      return await fn();
    } finally {
      this.#writeLock = null;
      resolve();
    }
  }

  // ── Öffentliche API ──────────────────────────────────────────────────────────

  /**
   * Listet alle bekannten Credential-Felder (Katalog + misc-Einträge im Store)
   * mit Metadaten. Gibt NIEMALS Klartext zurück.
   *
   * @returns {Promise<Array<{ integration: string, name: string, status: 'set'|'unset', masked?: string, updatedAt?: string }>>}
   */
  async list() {
    const storeData = await this.#readStore();
    const entries = storeData?.entries ?? {};

    const result = [];

    // Katalog-Felder
    for (const [integration, fields] of Object.entries(CREDENTIAL_CATALOG)) {
      for (const name of fields) {
        const key = `credentials/${integration}/${name}`;
        const entry = entries[key];
        if (entry) {
          result.push({
            integration,
            name,
            status: 'set',
            masked: '•••• gesetzt',
            updatedAt: entry.updatedAt,
          });
        } else {
          result.push({ integration, name, status: 'unset' });
        }
      }
    }

    // ssh/-Einträge bewusst ausgelassen (→ listSshKeys())
    // misc-Einträge aus dem Store
    for (const key of Object.keys(entries)) {
      if (key.startsWith('credentials/misc/')) {
        const name = key.slice('credentials/misc/'.length);
        const entry = entries[key];
        result.push({
          integration: 'misc',
          name,
          status: 'set',
          masked: '•••• gesetzt',
          updatedAt: entry.updatedAt,
        });
      }
    }

    return result;
  }

  /**
   * Gibt Metadaten eines einzelnen Eintrags zurück. Niemals Klartext.
   *
   * @param {string} storeKey
   * @returns {Promise<{ status: 'set'|'unset', masked?: string, updatedAt?: string }>}
   */
  async getMeta(storeKey) {
    const storeData = await this.#readStore();
    const entry = storeData?.entries?.[storeKey];
    if (!entry) return { status: 'unset' };
    return { status: 'set', masked: '•••• gesetzt', updatedAt: entry.updatedAt };
  }

  /**
   * Gibt den Klartext-Wert zurück — NUR für interne Konsumenten (z.B. VpsProvisioner).
   * NICHT für HTTP-Handler verwenden.
   *
   * @param {string} storeKey
   * @returns {Promise<string|null>} Klartext oder null wenn nicht gesetzt
   */
  async getPlaintext(storeKey) {
    const masterKeyRaw = await this.#ensureKey();
    const storeData = await this.#readStore();
    if (!storeData) return null;

    const entry = storeData.entries?.[storeKey];
    if (!entry) return null;

    const salt = Buffer.from(storeData.kdf.salt, 'base64');
    const aesKey = await this.#deriveKey(masterKeyRaw, salt);
    return this.#decrypt(aesKey, entry);
  }

  /**
   * Setzt oder überschreibt einen Credential-Wert.
   * Gibt Metadaten zurück (niemals Klartext).
   *
   * @param {string} storeKey
   * @param {string} plaintext
   * @returns {Promise<{ status: 'set', updatedAt: string }>}
   */
  async set(storeKey, plaintext) {
    if (typeof plaintext !== 'string' || plaintext.trim() === '') {
      throw new Error('[CredentialStore] Wert darf nicht leer sein');
    }
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_VALUE_BYTES) {
      throw new Error(`[CredentialStore] Wert überschreitet Längenlimit (${MAX_VALUE_BYTES} Bytes)`);
    }

    const masterKeyRaw = await this.#ensureKey();

    return this.#withWriteLock(async () => {
      // Store lesen (oder neu erstellen)
      let storeData = await this.#readStore();

      let salt;
      if (!storeData || !storeData.kdf) {
        // Neuer Store (oder nur Meta-Datei ohne kdf): Salt generieren
        salt = randomBytes(32);
        const kdf = {
          algo: 'scrypt',
          salt: salt.toString('base64'),
          N: SCRYPT_N,
          r: SCRYPT_R,
          p: SCRYPT_P,
        };
        if (!storeData) {
          storeData = { version: 1, kdf, entries: {} };
        } else {
          storeData.kdf = kdf;
          if (!storeData.entries) storeData.entries = {};
        }
      } else {
        salt = Buffer.from(storeData.kdf.salt, 'base64');
      }

      const aesKey = await this.#deriveKey(masterKeyRaw, salt);
      const encrypted = this.#encrypt(aesKey, plaintext);
      const updatedAt = new Date().toISOString();

      storeData.entries[storeKey] = { ...encrypted, updatedAt };

      await this.#writeStore(storeData);

      return { status: 'set', updatedAt };
    });
  }

  /**
   * Löscht einen Credential-Eintrag. Idempotent (kein Fehler wenn nicht vorhanden).
   *
   * @param {string} storeKey
   * @returns {Promise<{ status: 'unset' }>}
   */
  async delete(storeKey) {
    return this.#withWriteLock(async () => {
      const storeData = await this.#readStore();
      if (!storeData || !storeData.entries[storeKey]) {
        return { status: 'unset' };
      }

      delete storeData.entries[storeKey];
      await this.#writeStore(storeData);
      return { status: 'unset' };
    });
  }

  // ── SSH-Key-spezifische API (ADR-007 / ADR-008) ──────────────────────────────

  /**
   * Gibt den Public-Key eines SSH-Benutzers zurück (Klartext — nicht geheim).
   * Gibt null zurück wenn nicht gesetzt.
   *
   * @param {string} user  - Benutzer-Label (z.B. "root", "alex")
   * @returns {Promise<string|null>}
   */
  async getPublicKey(user) {
    const storeData = await this.#readStore();
    const metaKey = `ssh/${user}/public_key`;
    return storeData?.meta?.[metaKey]?.value ?? null;
  }

  /**
   * Setzt oder überschreibt den Public-Key eines SSH-Benutzers (Klartext-Metadatum).
   * Gibt Metadaten zurück.
   *
   * @param {string} user      - Benutzer-Label
   * @param {string} publicKey - OpenSSH-Public-Key-String
   * @returns {Promise<{ updatedAt: string }>}
   */
  async setPublicKey(user, publicKey) {
    // I2: Defense-in-Depth — Benutzer-Label intern validieren
    if (typeof user !== 'string' || user.length === 0 || user.length > MAX_USER_LABEL_LEN) {
      throw new Error(`[CredentialStore] Ungültiges Benutzer-Label (Länge 1–${MAX_USER_LABEL_LEN})`);
    }
    if (!USER_LABEL_RE.test(user)) {
      throw new Error('[CredentialStore] Benutzer-Label enthält unerlaubte Zeichen (erlaubt: a-z A-Z 0-9 _ - . : @)');
    }
    const metaKey = `ssh/${user}/public_key`;
    const updatedAt = new Date().toISOString();

    return this.#withWriteLock(async () => {
      let storeData = await this.#readStore();
      if (!storeData) {
        // Initialen Store-Rahmen anlegen (ohne kdf/entries — kein Key nötig für reine Meta-Operationen)
        storeData = { version: 1, entries: {}, meta: {} };
      }
      if (!storeData.meta) storeData.meta = {};
      storeData.meta[metaKey] = { value: publicKey, updatedAt };
      await this.#writeStore(storeData);
      return { updatedAt };
    });
  }

  /**
   * Löscht den Public-Key eines SSH-Benutzers. Idempotent.
   *
   * @param {string} user
   * @returns {Promise<void>}
   */
  async deletePublicKey(user) {
    // I2: Defense-in-Depth — Benutzer-Label intern validieren
    if (typeof user !== 'string' || user.length === 0 || user.length > MAX_USER_LABEL_LEN) {
      throw new Error(`[CredentialStore] Ungültiges Benutzer-Label (Länge 1–${MAX_USER_LABEL_LEN})`);
    }
    if (!USER_LABEL_RE.test(user)) {
      throw new Error('[CredentialStore] Benutzer-Label enthält unerlaubte Zeichen (erlaubt: a-z A-Z 0-9 _ - . : @)');
    }
    const metaKey = `ssh/${user}/public_key`;
    return this.#withWriteLock(async () => {
      const storeData = await this.#readStore();
      if (!storeData?.meta?.[metaKey]) return;
      delete storeData.meta[metaKey];
      await this.#writeStore(storeData);
    });
  }

  // ── Workspace-Pfad-API (workspace-path-config — nicht-geheime Betreiber-Konfiguration) ─

  /**
   * Gibt den konfigurierten Workspace-Root-Pfad zurück (Klartext-Metadatum).
   * Gibt null zurück wenn nicht konfiguriert.
   *
   * @returns {Promise<string|null>}
   */
  async readWorkspacePath() {
    const storeData = await this.#readStore();
    return storeData?.meta?.[WORKSPACE_PATH_META_KEY]?.value ?? null;
  }

  /**
   * Persistiert den konfigurierten Workspace-Root-Pfad (Klartext-Metadatum, nicht geheim).
   *
   * @param {string} absPath  Bereits validierter absoluter Pfad.
   * @returns {Promise<{ updatedAt: string }>}
   */
  async writeWorkspacePath(absPath) {
    if (typeof absPath !== 'string' || absPath.trim() === '') {
      throw new Error('[CredentialStore] writeWorkspacePath: absPath darf nicht leer sein');
    }
    const updatedAt = new Date().toISOString();
    return this.#withWriteLock(async () => {
      let storeData = await this.#readStore();
      if (!storeData) {
        storeData = { version: 1, entries: {}, meta: {} };
      }
      if (!storeData.meta) storeData.meta = {};
      storeData.meta[WORKSPACE_PATH_META_KEY] = { value: absPath.trim(), updatedAt };
      await this.#writeStore(storeData);
      return { updatedAt };
    });
  }

  /**
   * Löscht den konfigurierten Workspace-Root-Pfad. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async deleteWorkspacePath() {
    return this.#withWriteLock(async () => {
      const storeData = await this.#readStore();
      if (!storeData?.meta?.[WORKSPACE_PATH_META_KEY]) return;
      delete storeData.meta[WORKSPACE_PATH_META_KEY];
      await this.#writeStore(storeData);
    });
  }

  /**
   * Listet alle SSH-Benutzer (union aus Public-Key-Einträgen + Private-Key-Einträgen).
   * Gibt je Benutzer { user, publicKey?, privateKeyStatus, privateKeyUpdatedAt? } zurück.
   * Private-Key-Klartext wird NIEMALS zurückgegeben.
   *
   * @returns {Promise<Array<{ user: string, publicKey?: string, publicKeyUpdatedAt?: string, privateKeyStatus: 'set'|'unset', privateKeyUpdatedAt?: string }>>}
   */
  async listSshKeys() {
    const storeData = await this.#readStore();
    const entries = storeData?.entries ?? {};
    const meta = storeData?.meta ?? {};

    const users = new Set();

    // Benutzer aus Public-Key-Meta
    for (const key of Object.keys(meta)) {
      if (key.startsWith('ssh/') && key.endsWith('/public_key')) {
        users.add(key.slice('ssh/'.length, -'/public_key'.length));
      }
    }

    // Benutzer aus Private-Key-Entries
    for (const key of Object.keys(entries)) {
      if (key.startsWith('ssh/') && key.endsWith('/private_key')) {
        users.add(key.slice('ssh/'.length, -'/private_key'.length));
      }
    }

    const result = [];
    for (const user of [...users].sort()) {
      const pubMetaKey = `ssh/${user}/public_key`;
      const privEntryKey = `ssh/${user}/private_key`;
      const pubMeta = meta[pubMetaKey];
      const privEntry = entries[privEntryKey];

      result.push({
        user,
        ...(pubMeta ? { publicKey: pubMeta.value, publicKeyUpdatedAt: pubMeta.updatedAt } : {}),
        privateKeyStatus: privEntry ? 'set' : 'unset',
        ...(privEntry ? { privateKeyUpdatedAt: privEntry.updatedAt } : {}),
      });
    }

    return result;
  }
}
