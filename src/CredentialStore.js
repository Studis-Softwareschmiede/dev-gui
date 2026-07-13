/**
 * CredentialStore — einziger Lese-/Schreibpfad zu `secrets.enc.json`.
 *
 * Persistiert Credentials at rest via AES-256-GCM (Node `crypto`).
 * Master-Key aus Env `DEVGUI_CRED_MASTER_KEY` (bzw. `DEVGUI_CRED_MASTER_KEY_FILE`),
 * per scrypt zu 32-Byte-AES-Schlüssel abgeleitet.
 * Deprecated-Fallback: `CRED_MASTER_KEY` / `CRED_MASTER_KEY_FILE` (Warn-Log, kein Wert).
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
import { readFile, rename, mkdir, open, stat, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { decrypt as gpgDecrypt } from './BackupCrypto.js';
import { readFileSync } from 'node:fs';
import { runBackup, resolveBackupDir, resolveRetentionCount } from './BackupEngine.js';
import { resolveOffHostConfigAsync } from './BackupUploader.js';
import { write as writeBackupConfig } from './BackupConfigStore.js';

const scryptAsync = promisify(scrypt);

// ── Katalog bekannter Credential-Felder (ADR-007) ─────────────────────────────
export const CREDENTIAL_CATALOG = {
  github: ['app_id', 'installation_id', 'private_key'],
  cloudflare: ['api_token', 'account_id'],
  vps: ['hetzner_api_token', 'ionos_api_token', 'hostinger_api_token'],
  // S-141: Off-Host-Backup Remote-Zugangsdaten (write-only, AC9)
  // S3-kompatibel (S3-only seit S-160): s3_access_key, s3_secret_key
  'backup-remote': ['s3_access_key', 's3_secret_key'],
  // S-182: ntfy-Zugriffs-Token (verschlüsselt, write-only, AC1/AC10 push-notifications)
  notifications: ['ntfy_token'],
};

/** Maximale Länge eines Credential-Werts (Bytes). */
const MAX_VALUE_BYTES = 65536; // 64 KiB

/** meta-Block-Schlüssel für den konfigurierten Workspace-Root (workspace-path-config, AC4/AC6). */
const WORKSPACE_PATH_META_KEY = 'settings/workspace-path';

/** meta-Block-Schlüssel für den konfigurierten Obsidian-Vault-Pfad (obsidian-vault-config, AC4). */
const OBSIDIAN_VAULT_PATH_META_KEY = 'settings/obsidian-vault-path';

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

// ── Backup-Ergebnis-Helfer ────────────────────────────────────────────────────

/**
 * Erstellt die nach-außen (HTTP) sichere Ansicht eines Backup-Ergebnisses.
 * Entfernt `localPath` (interner Volume-Pfad, S-1 / S-140): dieser gehört nicht ins Frontend.
 *
 * @param {{ local: string, offHost: string, localPath?: string, errorClass?: string, message?: string } | undefined} backup
 * @returns {{ local: string, offHost: string, errorClass?: string, message?: string } | undefined}
 */
export function toExternalBackup(backup) {
  if (!backup) return undefined;
  // eslint-disable-next-line no-unused-vars
  const { localPath: _localPath, ...external } = backup;
  return external;
}

// ── CredentialStore ────────────────────────────────────────────────────────────

export class CredentialStore {
  /** @type {string} Pfad zur secrets.enc.json */
  #filePath;

  /** @type {string|null} Master-Key-Rohwert (aus Env oder Runtime-unlock) */
  #masterKeyRaw = null;

  /**
   * Quelle des aktuell geladenen Master-Keys (credential-key-status-transparency AC2–AC4).
   * "auto"   — beim Boot aus Env/`.env` geladen.
   * "manual" — zur Laufzeit per unlock() gesetzt.
   * "none"   — kein Key geladen (Store locked).
   * Wird NIEMALS nach außen als Wert weitergegeben — nur als Enum.
   * @type {"auto"|"manual"|"none"}
   */
  #keySource = 'none';

  /** @type {Promise<void>|null} Schreib-Mutex */
  #writeLock = null;

  /**
   * Pfad zur .env-Datei für DEVGUI_CRED_MASTER_KEY-Persistenz (AC5/AC6).
   * Default: Projekt-Root/.env (Verzeichnis neben server.js).
   * Überschreibbar via opts.envPath (für Tests) oder CRED_ENV_PATH (Env).
   * @type {string}
   */
  #envPath;

  /**
   * Verzeichnis für lokale Backup-Artefakte (S-140 AC3).
   * Überschreibbar via opts.backupDir (für Tests) oder CRED_BACKUP_DIR (Env).
   * Default: <CRED_STORE_DIR>/backups
   * @type {string}
   */
  #backupDir;

  /**
   * Maximale Anzahl lokaler Backup-Artefakte vor Retention-Aufräumen (S-140 AC5).
   * @type {number}
   */
  #backupRetentionCount;

  /**
   * Flag: Deprecation-Warnung für alten Key-Namen wurde bereits geloggt (einmalig pro Prozessstart).
   * @type {boolean}
   */
  static #deprecationWarned = false;

  /**
   * Setzt das Deprecation-Warn-Flag zurück.
   * ONLY FOR TESTING — erlaubt saubere Test-Isolation.
   * @internal
   */
  static _resetDeprecationWarned() {
    CredentialStore.#deprecationWarned = false;
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.dir]               - Verzeichnis (default: CRED_STORE_DIR env, oder /home/node/.cred)
   * @param {string} [opts.masterKey]         - Master-Key (für Tests injizierbar; sonst aus Env)
   * @param {string} [opts.envPath]           - Pfad zur .env-Datei (default: Projekt-Root/.env)
   * @param {string} [opts.backupDir]         - Backup-Verzeichnis (für Tests; default: dir/backups)
   * @param {number} [opts.backupRetention]   - Max. Anzahl lokaler Backups (für Tests; default: 10)
   */
  constructor(opts = {}) {
    // AC16 (S-139): Speicherpfad: opts.dir > CRED_STORE_DIR > /home/node/.cred (neues dediziertes Volume)
    const dir = opts.dir
      ?? (process.env.CRED_STORE_DIR && process.env.CRED_STORE_DIR.trim()
        ? process.env.CRED_STORE_DIR.trim()
        : '/home/node/.cred');
    this.#filePath = join(dir, 'secrets.enc.json');

    // .env-Pfad: opts.envPath > CRED_ENV_PATH > Projekt-Root/.env (neben server.js)
    if (opts.envPath !== undefined) {
      this.#envPath = opts.envPath;
    } else if (process.env.CRED_ENV_PATH && process.env.CRED_ENV_PATH.trim()) {
      this.#envPath = process.env.CRED_ENV_PATH.trim();
    } else {
      // Projekt-Root = zwei Verzeichnisse über dieser Datei (src/ → /)
      const srcDir = dirname(new URL(import.meta.url).pathname);
      this.#envPath = join(srcDir, '..', '.env');
    }

    if (opts.masterKey !== undefined) {
      // Injizierter Key (Tests): gilt als "auto" (Boot-Pfad-Analogie)
      this.#masterKeyRaw = opts.masterKey;
      this.#keySource = opts.masterKey ? 'auto' : 'none';
    } else {
      // AC14 (S-139): process.env-Keys haben höchste Priorität; erst dann Datei-Reload
      this.#masterKeyRaw = this.#loadMasterKeyFromEnv();

      // AC13/AC14/AC15 (S-139): Boot-Reload aus CRED_ENV_PATH-Datei, falls Env leer
      if (!this.#masterKeyRaw) {
        this.#masterKeyRaw = this.#loadMasterKeyFromFile();
      }

      // AC2: Key aus Env/Boot-Reload → keySource "auto"; kein Key → "none"
      this.#keySource = this.#masterKeyRaw ? 'auto' : 'none';
    }

    // S-140: Backup-Verzeichnis + Retention-Konfiguration
    if (opts.backupDir !== undefined) {
      this.#backupDir = opts.backupDir;
    } else {
      this.#backupDir = resolveBackupDir(dir);
    }
    this.#backupRetentionCount = opts.backupRetention !== undefined
      ? opts.backupRetention
      : resolveRetentionCount();
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
      console.warn('[CredentialStore] Kein DEVGUI_CRED_MASTER_KEY gesetzt (Dev-Modus) — Credential-Store inaktiv');
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
        '[CredentialStore] secrets.enc.json enthält verschlüsselte Einträge, aber kein Master-Key gefunden. ' +
        'Prozess wird abgebrochen (Fail-Fast). Env-Var DEVGUI_CRED_MASTER_KEY setzen.',
      );
    }
  }

  /**
   * Boot-Reload (AC13/AC14/AC15 — S-139): Liest den Master-Key synchron aus
   * der Datei unter CRED_ENV_PATH, falls process.env-Keys leer/ungesetzt sind.
   *
   * Format: Datei enthält Zeilen; es wird die erste Zeile mit dem Prefix
   *   `DEVGUI_CRED_MASTER_KEY=` (primär) oder `CRED_MASTER_KEY=` (Alt-Name)
   * gesucht; der Wert danach ist der Key.
   *
   * AC13: Nur aufgerufen wenn DEVGUI_CRED_MASTER_KEY und CRED_MASTER_KEY in
   *       process.env leer/ungesetzt sind (Env-Priorität — AC14 gewährleistet
   *       durch Aufrufreihenfolge in constructor).
   * AC15: Fehlende Datei / keine passende Zeile → null (kein Crash).
   *       Key-Wert wird NICHT geloggt (Security-Floor AC7/§8).
   *
   * @returns {string|null}
   */
  #loadMasterKeyFromFile() {
    const envPath = this.#envPath;
    let content;
    try {
      content = readFileSync(envPath, 'utf8');
    } catch {
      // AC15: Datei fehlt → kein Crash, null zurückgeben
      return null;
    }

    const lines = content.split('\n');
    let key = null;

    for (const line of lines) {
      // Primärer Name (neuer Name, höchste Priorität in der Datei)
      if (line.startsWith('DEVGUI_CRED_MASTER_KEY=')) {
        const val = line.slice('DEVGUI_CRED_MASTER_KEY='.length).trim();
        if (val) {
          key = val;
          break;
        }
      }
    }

    // Alt-Name — nur wenn Primärname nicht gefunden
    if (!key) {
      for (const line of lines) {
        if (line.startsWith('CRED_MASTER_KEY=')) {
          const val = line.slice('CRED_MASTER_KEY='.length).trim();
          if (val) {
            key = val;
            break;
          }
        }
      }
    }

    // AC15: Key-Wert NICHT loggen (Security-Floor)
    return key;
  }

  /**
   * Liest den Master-Key synchron aus Env-Vars (nur direkter Wert, nicht FILE).
   *
   * Prioritätskette (AC1–AC3):
   *   1. DEVGUI_CRED_MASTER_KEY  (neuer Name, höchste Priorität)
   *   2. [DEVGUI_CRED_MASTER_KEY_FILE — lazy in #ensureKey()]
   *   3. CRED_MASTER_KEY          (deprecated, Warn-Log ohne Wert)
   *   4. [CRED_MASTER_KEY_FILE    — lazy in #ensureKey()]
   *
   * AC7: Der Key-Wert erscheint NICHT im Log — nur der Env-Var-Name.
   * AC3: Ist DEVGUI_CRED_MASTER_KEY gesetzt, wird das alte CRED_MASTER_KEY ignoriert.
   *
   * @returns {string|null}
   */
  #loadMasterKeyFromEnv() {
    // AC1: Neuer primärer Name
    const newDirect = process.env.DEVGUI_CRED_MASTER_KEY;
    if (newDirect && newDirect.trim()) {
      return newDirect.trim();
    }

    // DEVGUI_CRED_MASTER_KEY_FILE — lazy in #ensureKey()

    // AC2/AC3: Deprecated Fallback — nur wenn KEIN neuer Key gesetzt ist
    const oldDirect = process.env.CRED_MASTER_KEY;
    if (oldDirect && oldDirect.trim()) {
      // AC2: Genau eine Warnung pro Prozessstart (kein Log-Spam pro Request)
      if (!CredentialStore.#deprecationWarned) {
        CredentialStore.#deprecationWarned = true;
        // AC7: Wert wird NICHT geloggt — nur der Name der veralteten Variable
        console.warn(
          '[CredentialStore] DEPRECATION: CRED_MASTER_KEY ist veraltet. ' +
          'Bitte auf DEVGUI_CRED_MASTER_KEY umstellen. ' +
          'Der Store-Key wird übergangsweise akzeptiert.',
        );
      }
      return oldDirect.trim();
    }

    // CRED_MASTER_KEY_FILE — lazy in #ensureKey()
    return null;
  }

  /**
   * Liefert den Master-Key-Rohwert (lädt *_FILE-Varianten falls nötig).
   *
   * Prioritätskette (lazy Teil — nach #loadMasterKeyFromEnv):
   *   2. DEVGUI_CRED_MASTER_KEY_FILE
   *   4. CRED_MASTER_KEY_FILE (deprecated, Warn-Log ohne Wert)
   *
   * AC7: Key-Wert erscheint NICHT im Fehlertext.
   * AC4 (Spec): DEVGUI_CRED_MASTER_KEY_FILE-Fehler → harter Fehler, kein stilles Fallback auf alten Namen.
   *
   * @returns {Promise<string>}
   */
  async #ensureKey() {
    if (this.#masterKeyRaw) return this.#masterKeyRaw;

    // AC1: DEVGUI_CRED_MASTER_KEY_FILE (zweite Priorität nach dem direkten Wert)
    const newKeyFile = process.env.DEVGUI_CRED_MASTER_KEY_FILE;
    if (newKeyFile && newKeyFile.trim()) {
      try {
        const content = await readFile(newKeyFile.trim(), 'utf8');
        const key = content.trim();
        if (key) {
          this.#masterKeyRaw = key;
          return key;
        }
      } catch (err) {
        // AC4 (Spec): Datei gesetzt aber nicht lesbar → harter Fehler, kein Fallback auf alten Namen
        // AC7: Datei-Inhalt / Key-Wert erscheint NICHT im Fehlertext
        throw new Error(`[CredentialStore] DEVGUI_CRED_MASTER_KEY_FILE konnte nicht gelesen werden: ${err.message}`, { cause: err });
      }
    }

    // AC2: Deprecated CRED_MASTER_KEY_FILE — nur wenn kein neuer FILE-Key gesetzt
    if (!newKeyFile || !newKeyFile.trim()) {
      const oldKeyFile = process.env.CRED_MASTER_KEY_FILE;
      if (oldKeyFile && oldKeyFile.trim()) {
        // AC2: Einmalige Deprecation-Warnung (kein Log-Spam)
        if (!CredentialStore.#deprecationWarned) {
          CredentialStore.#deprecationWarned = true;
          // AC7: Wert wird NICHT geloggt — nur der Name der veralteten Variable
          console.warn(
            '[CredentialStore] DEPRECATION: CRED_MASTER_KEY_FILE ist veraltet. ' +
            'Bitte auf DEVGUI_CRED_MASTER_KEY_FILE umstellen. ' +
            'Der Store-Key wird übergangsweise akzeptiert.',
          );
        }
        try {
          const content = await readFile(oldKeyFile.trim(), 'utf8');
          const key = content.trim();
          if (key) {
            this.#masterKeyRaw = key;
            return key;
          }
        } catch (err) {
          // AC7: Key-Wert erscheint NICHT im Fehlertext
          throw new Error(`[CredentialStore] CRED_MASTER_KEY_FILE konnte nicht gelesen werden: ${err.message}`, { cause: err });
        }
      }
    }

    throw new Error('[CredentialStore] Kein Master-Key konfiguriert (DEVGUI_CRED_MASTER_KEY / DEVGUI_CRED_MASTER_KEY_FILE)');
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
   * Gibt den serialisierten JSON-String zurück (für den Backup-Hook, S-140 AC1).
   *
   * @param {object} data
   * @returns {Promise<string>} Serialisierter Store-Inhalt (für Backup-Artefakt)
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

    // Rückgabe des serialisierten Inhalts für den Backup-Hook (S-140 AC1)
    return json;
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

  // ── .env-Persistenz (AC5/AC6) ───────────────────────────────────────────────

  /**
   * Schreibt `DEVGUI_CRED_MASTER_KEY=<value>` atomar in die .env-Datei (AC5/AC6).
   * - Bestehende Zeilen bleiben erhalten.
   * - Vorhandene `CRED_MASTER_KEY=`-Zeilen (alt) UND `DEVGUI_CRED_MASTER_KEY=`-Zeilen (neu)
   *   werden BEIDE entfernt, dann nur der neue Name geschrieben (AC5: kein Duplikat, keine stale Altzeile).
   * - Schreibt in tmp-Datei + rename (atomar, AC6).
   * - Setzt Dateirechte 0600 (AC5).
   * - Der Key-Wert wird NICHT geloggt (AC7).
   *
   * @param {string} key  - Der Master-Key-Rohwert (wird NICHT geloggt)
   * @returns {Promise<void>}
   */
  async #persistKeyToEnv(key) {
    const envPath = this.#envPath;
    const tmpPath = `${envPath}.cred-tmp`;

    // Bestehenden Inhalt lesen (tolerant wenn Datei noch nicht existiert)
    let existing = '';
    try {
      existing = await readFile(envPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`[CredentialStore] .env konnte nicht gelesen werden: ${err.message}`, { cause: err });
      }
      // ENOENT → leerer Inhalt, wird neu angelegt
    }

    // AC5: Zeilen filtern — BEIDE Schlüsselnamen (alt + neu) entfernen, damit kein Duplikat
    // und keine konkurrierende Altzeile beim nächsten Boot entsteht.
    // split('\n') auf 'a\nb\n' ergibt ['a','b',''] — das trailing '' nicht mitnehmen.
    const lines = existing.split('\n').filter(
      (line) => !line.startsWith('CRED_MASTER_KEY=') && !line.startsWith('DEVGUI_CRED_MASTER_KEY='),
    );

    // Trailing-Leerzeile (von split auf trailing-newline) entfernen, damit kein Doppel-Newline entsteht
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    // AC5: Neue Zeile mit neuem Namen hinzufügen (Key-Wert nicht geloggt — AC7)
    lines.push(`DEVGUI_CRED_MASTER_KEY=${key}`);

    // Datei endet mit \n (Unix-Konvention)
    const newContent = lines.join('\n') + '\n';

    // Atomar schreiben (tmp + rename, AC6) + 0600 (AC5)
    const envDir = dirname(envPath);
    try {
      await mkdir(envDir, { recursive: true });
    } catch {
      // Ignorieren wenn Verzeichnis schon existiert
    }

    let fd;
    try {
      fd = await open(tmpPath, 'w', 0o600);
      await fd.writeFile(newContent, 'utf8');
      await fd.sync();
    } finally {
      if (fd) await fd.close();
    }

    // rename: atomar (AC6)
    await rename(tmpPath, envPath);
    // Sicherstellen dass mode korrekt ist auch nach rename (AC5)
    await chmod(envPath, 0o600);
  }

  // ── Backup-Hook (S-140/S-141) ───────────────────────────────────────────────

  /**
   * Erzeugt ein lokales Backup-Artefakt nach erfolgreichem Store-Write und lädt
   * es ggf. an ein Off-Host-Ziel hoch (S-141 AC8–AC10).
   *
   * - Backup-Fehler rollt den Store-Write NICHT zurück (AC4).
   * - Passphrase (Master-Key) wird NICHT geloggt, nicht in Argv (AC7).
   * - Remote-Creds werden aus dem CredentialStore gelesen (AC9) und erscheinen
   *   NIEMALS in Logs, Responses, WS oder Argv.
   * - Remote-Fehler führen nicht zum Crash (AC10).
   *
   * Muss innerhalb des Write-Locks aufgerufen werden, NACHDEM #writeStore() erfolgreich war.
   *
   * @param {string} storeBlob - Inhalt von secrets.enc.json (bereits serialisiert, atomar geschrieben)
   * @param {object|null} [offHostConfigOverride] - Test-Override für Off-Host-Config (null = disabled)
   * @returns {Promise<{ local: 'ok'|'failed', offHost: 'ok'|'failed'|'disabled', localPath?: string, errorClass?: string, message?: string }>}
   */
  async #runBackupHook(storeBlob, offHostConfigOverride) {
    // Kein Master-Key → kein Backup möglich (Store müsste entsperrt sein für Store-Writes)
    if (!this.#masterKeyRaw) {
      return { local: 'failed', offHost: 'disabled', errorClass: 'backup-failed', message: '[BackupEngine] Kein Master-Key verfügbar (Store gesperrt)' };
    }

    // AC17 (S-147) + I-1 Fix: Off-Host-Config ZUERST auflösen — bevor Creds gelesen werden.
    // In Production ist offHostConfigOverride immer undefined; null = Test-Override (disabled).
    // resolveOffHostConfigAsync() liest BackupConfigStore (JSON) mit Env-Fallback, damit
    // UI-Config-Änderungen (S-143) wirksam sind ohne BACKUP_OFFHOST_*-Env-Vars.
    // Wird hier (nicht in BackupEngine) aufgerufen, damit wir wissen ob Off-Host aktiv ist,
    // bevor wir unnötig Creds entschlüsseln.
    const resolvedConfig = offHostConfigOverride === null
      ? null
      : (offHostConfigOverride !== undefined ? offHostConfigOverride : await resolveOffHostConfigAsync());

    // AC9 (S-141): Remote-Zugangsdaten aus dem CredentialStore lesen (entschlüsselt zur Laufzeit).
    // Sie erscheinen NIEMALS in Logs/Responses/WS/Argv/Bundle.
    // NUR lesen wenn Off-Host wirklich aktiv ist (resolvedConfig !== null) — kein unnötiger Entschlüsselungsaufwand.
    let offHostCreds = {};
    if (resolvedConfig) {
      try {
        const storeData = await this.#readStore();
        if (storeData && storeData.kdf) {
          const salt = Buffer.from(storeData.kdf.salt, 'base64');
          const aesKey = await this.#deriveKey(this.#masterKeyRaw, salt);

          const _readCredSafe = (key) => {
            try {
              const entry = storeData.entries?.[key];
              if (!entry) return null;
              return this.#decrypt(aesKey, entry);
            } catch {
              // Entschlüsselungsfehler → ignorieren, kein Cred verfügbar
              return null;
            }
          };

          // AC9: Creds werden NUR zur Laufzeit entschlüsselt, nie persistiert/geloggt
          // S3-only seit S-160 (sftp_password/sftp_private_key entfernt)
          const accessKey = _readCredSafe('credentials/backup-remote/s3_access_key');
          const secretKey = _readCredSafe('credentials/backup-remote/s3_secret_key');

          offHostCreds = {
            ...(accessKey ? { accessKey } : {}),
            ...(secretKey ? { secretKey } : {}),
          };
        }
      } catch {
        // AC10: Fehler beim Lesen der Creds → Upload wird mit leeren Creds versucht
        // (wird scheitern und offHost: 'failed' zurückgeben — lokale Kopie bleibt)
        offHostCreds = {};
      }
    }

    // AC7: masterKeyRaw wird an BackupEngine weitergegeben, erscheint aber NICHT in Logs/Argv
    // AC9: offHostCreds werden NICHT geloggt (BackupUploader/BackupEngine halten das ein)
    // I-1/I-3: resolvedConfig (nicht der rohe Override) wird übergeben — BackupEngine ruft
    // resolveOffHostConfig() nicht nochmals auf; Fehlerpfade in BackupEngine nutzen denselben Wert.
    return runBackup({
      masterKeyRaw: this.#masterKeyRaw,
      storeFilePath: this.#filePath,
      backupDir: this.#backupDir,
      retentionCount: this.#backupRetentionCount,
      storeBlob,
      offHostConfig: resolvedConfig,
      offHostCreds,
    });
  }

  // ── Öffentliche API ──────────────────────────────────────────────────────────

  // ── Lock-State API (AC1/AC3/AC4/AC8) ────────────────────────────────────────

  /**
   * Gibt zurück ob der Store aktuell entsperrt ist.
   * @returns {boolean}
   */
  isUnlocked() {
    return this.#masterKeyRaw !== null;
  }

  /**
   * Gibt den Lock-Zustand zurück — ohne Schlüssel/Klartext (AC8).
   *
   * Erweitert um keySource (credential-key-status-transparency AC1–AC4):
   *   "auto"   — Key beim Boot aus Env/`.env` geladen.
   *   "manual" — Key zur Laufzeit per unlock() gesetzt.
   *   "none"   — kein Key geladen (state: "locked").
   *
   * Konsistenz-Garantie: state:"locked" ⇒ keySource:"none" (AC4).
   * keySource enthält NIEMALS den Schlüssel-/Klartext-Wert (AC7).
   *
   * @returns {Promise<{ state: "locked"|"unlocked", hasEncryptedEntries: boolean, keySource: "auto"|"manual"|"none" }>}
   */
  async getLockState() {
    const state = this.#masterKeyRaw !== null ? 'unlocked' : 'locked';
    const storeData = await this.#readStore();
    const hasEncryptedEntries =
      storeData?.kdf != null && Object.keys(storeData?.entries ?? {}).length > 0;

    // AC4: locked ⇒ keySource muss "none" sein (Konsistenz-Invariante)
    // AC7: keySource ist reines Enum — kein Wert enthalten
    // Edge-case: unbekannter/leerer interner Marker bei geladenem Key → defensiv "auto" (Spec § Edge-Cases)
    let keySource;
    if (state === 'locked') {
      keySource = 'none';
    } else if (this.#keySource === 'manual') {
      keySource = 'manual';
    } else {
      // "auto" oder unbekannter Marker bei geladenem Key → defensiv "auto"
      keySource = 'auto';
    }

    return { state, hasEncryptedEntries, keySource };
  }

  /**
   * Entsperrt den Store zur Laufzeit (AC3/AC4).
   *
   * Ablauf:
   *   1. Validiert den Key gegen vorhandene verschlüsselte Einträge (AC4).
   *   2. Persistiert den Key in `.env` (AC5/AC6) — wenn `persist=true` (default).
   *   3. Lädt den Key in den laufenden Prozess (AC3).
   *
   * Der Key-Wert erscheint NIE in einem Log, Response oder Fehlertext (AC7).
   *
   * @param {string} key  - Der Master-Key-Rohwert (wird NICHT geloggt)
   * @param {object} [opts]
   * @param {boolean} [opts.persist=true]  - Key in .env persistieren. Wenn false: kein
   *   Reboot-Überleben — nach Prozess-Neustart ist der Store wieder gesperrt.
   * @returns {Promise<{ ok: true } | { ok: false, reason: "invalid-key"|"invalid-key-format"|"persist-failed"|"empty-key" }>}
   */
  async unlock(key, { persist = true } = {}) {
    // Leerer/whitespace Key
    if (!key || typeof key !== 'string' || !key.trim()) {
      return { ok: false, reason: 'empty-key' };
    }

    // Eingebettetes Newline/CR im Key korrumpiert .env (I1 — ein solcher Key erzeugt
    // zwei .env-Zeilen → späterer Boot liest nur Prefix → silent Key-Mismatch).
    if (/[\r\n]/.test(key)) {
      return { ok: false, reason: 'invalid-key-format' };
    }

    const trimmedKey = key.trim();

    // Validierung gegen vorhandene Einträge (AC4)
    const storeData = await this.#readStore();
    const hasEncryptedEntries =
      storeData?.kdf != null && Object.keys(storeData?.entries ?? {}).length > 0;

    if (hasEncryptedEntries) {
      // Probe-Entschlüsselung: ersten Eintrag versuchen
      const firstEntryKey = Object.keys(storeData.entries)[0];
      const firstEntry = storeData.entries[firstEntryKey];
      const salt = Buffer.from(storeData.kdf.salt, 'base64');
      let aesKey;
      try {
        aesKey = await this.#deriveKey(trimmedKey, salt);
      } catch {
        return { ok: false, reason: 'invalid-key' };
      }
      try {
        this.#decrypt(aesKey, firstEntry);
      } catch {
        // GCM-Tag-Fehler → falscher Key (AC4)
        return { ok: false, reason: 'invalid-key' };
      }
    }
    // Kein verschlüsselter Eintrag → jeder nicht-leere Key akzeptierbar (frischer Store)

    // Persistenz (AC5/AC6) — im Write-Lock (S1: konsistent mit secrets.enc.json-Schreibpfad)
    if (persist) {
      try {
        await this.#withWriteLock(() => this.#persistKeyToEnv(trimmedKey));
      } catch {
        // Persistenz fehlgeschlagen → in-memory trotzdem entsperren,
        // aber Aufrufer über fehlende Persistenz informieren (kein Key-Leak im Fehler)
        this.#masterKeyRaw = trimmedKey;
        // AC3 (credential-key-status-transparency): Runtime-unlock → keySource "manual"
        this.#keySource = 'manual';
        return { ok: false, reason: 'persist-failed' };
      }
    }

    // Key in den laufenden Prozess laden (AC3)
    this.#masterKeyRaw = trimmedKey;
    // AC3 (credential-key-status-transparency): Runtime-unlock → keySource "manual" (ohne Neustart)
    this.#keySource = 'manual';
    return { ok: true };
  }

  // ── Öffentliche API (Credentials) ───────────────────────────────────────────

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
   * Enthält Backup-Ergebnis als `backup`-Feld (S-140 AC6).
   *
   * @param {string} storeKey
   * @param {string} plaintext
   * @returns {Promise<{ status: 'set', updatedAt: string, backup: BackupResult }>}
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

      // S-140 AC1: Backup nach erfolgreichem Store-Write (im Write-Lock)
      const storeBlob = await this.#writeStore(storeData);
      const backup = await this.#runBackupHook(storeBlob);

      // AC4: backup-Fehler rollt Store-Write NICHT zurück
      return { status: 'set', updatedAt, backup };
    });
  }

  /**
   * Löscht einen Credential-Eintrag. Idempotent (kein Fehler wenn nicht vorhanden).
   * Enthält Backup-Ergebnis als `backup`-Feld (S-140 AC6).
   *
   * @param {string} storeKey
   * @returns {Promise<{ status: 'unset', backup?: BackupResult }>}
   */
  async delete(storeKey) {
    return this.#withWriteLock(async () => {
      const storeData = await this.#readStore();
      if (!storeData || !storeData.entries[storeKey]) {
        // Kein Write → kein Backup-Trigger (AC1: nur nach erfolgreichem Write)
        return { status: 'unset' };
      }

      delete storeData.entries[storeKey];

      // S-140 AC1: Backup nach erfolgreichem Store-Write (im Write-Lock)
      const storeBlob = await this.#writeStore(storeData);
      const backup = await this.#runBackupHook(storeBlob);

      // AC4: backup-Fehler rollt Store-Write NICHT zurück
      return { status: 'unset', backup };
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
      const storeBlob = await this.#writeStore(storeData);
      const backup = await this.#runBackupHook(storeBlob);
      return { updatedAt, backup };
    });
  }

  /**
   * Löscht den Public-Key eines SSH-Benutzers. Idempotent.
   *
   * @param {string} user
   * @returns {Promise<{ backup?: BackupResult }>}
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
      if (!storeData?.meta?.[metaKey]) return {};
      delete storeData.meta[metaKey];
      const storeBlob = await this.#writeStore(storeData);
      const backup = await this.#runBackupHook(storeBlob);
      return { backup };
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
   * @returns {Promise<{ updatedAt: string, backup: BackupResult }>}
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
      const storeBlob = await this.#writeStore(storeData);
      const backup = await this.#runBackupHook(storeBlob);
      return { updatedAt, backup };
    });
  }

  /**
   * Löscht den konfigurierten Workspace-Root-Pfad. Idempotent.
   *
   * @returns {Promise<{ backup?: BackupResult }>}
   */
  async deleteWorkspacePath() {
    return this.#withWriteLock(async () => {
      const storeData = await this.#readStore();
      if (!storeData?.meta?.[WORKSPACE_PATH_META_KEY]) return {};
      delete storeData.meta[WORKSPACE_PATH_META_KEY];
      const storeBlob = await this.#writeStore(storeData);
      const backup = await this.#runBackupHook(storeBlob);
      return { backup };
    });
  }

  // ── Obsidian-Vault-Pfad-API (obsidian-vault-config — nicht-geheime Betreiber-Konfiguration) ─

  /**
   * Gibt den konfigurierten Obsidian-Vault-Pfad zurück (Klartext-Metadatum, AC4).
   * Gibt null zurück wenn nicht konfiguriert.
   *
   * @returns {Promise<string|null>}
   */
  async readObsidianVaultPath() {
    const storeData = await this.#readStore();
    return storeData?.meta?.[OBSIDIAN_VAULT_PATH_META_KEY]?.value ?? null;
  }

  /**
   * Persistiert den konfigurierten Obsidian-Vault-Pfad (Klartext-Metadatum, nicht geheim, AC4).
   * Der Wert lebt im `meta`-Block, NIE im verschlüsselten `entries`-Secret-Block.
   *
   * @param {string} absPath  Bereits validierter absoluter Pfad.
   * @returns {Promise<{ updatedAt: string, backup: BackupResult }>}
   */
  async writeObsidianVaultPath(absPath) {
    if (typeof absPath !== 'string' || absPath.trim() === '') {
      throw new Error('[CredentialStore] writeObsidianVaultPath: absPath darf nicht leer sein');
    }
    const updatedAt = new Date().toISOString();
    return this.#withWriteLock(async () => {
      let storeData = await this.#readStore();
      if (!storeData) {
        storeData = { version: 1, entries: {}, meta: {} };
      }
      if (!storeData.meta) storeData.meta = {};
      storeData.meta[OBSIDIAN_VAULT_PATH_META_KEY] = { value: absPath.trim(), updatedAt };
      const storeBlob = await this.#writeStore(storeData);
      const backup = await this.#runBackupHook(storeBlob);
      return { updatedAt, backup };
    });
  }

  /**
   * Löscht den konfigurierten Obsidian-Vault-Pfad. Idempotent (AC1 — zurücksetzen).
   *
   * @returns {Promise<{ backup?: BackupResult }>}
   */
  async deleteObsidianVaultPath() {
    return this.#withWriteLock(async () => {
      const storeData = await this.#readStore();
      if (!storeData?.meta?.[OBSIDIAN_VAULT_PATH_META_KEY]) return {};
      delete storeData.meta[OBSIDIAN_VAULT_PATH_META_KEY];
      const storeBlob = await this.#writeStore(storeData);
      const backup = await this.#runBackupHook(storeBlob);
      return { backup };
    });
  }

  // ── Stack-Registry-API (stack-deploy-orchestration — nicht-geheime Betreiber-Konfiguration) ─

  /**
   * Listet alle Stack-Definitionen aus dem meta-Block.
   * Gibt [{ value, updatedAt }]-Einträge zurück (Klartext-JSON-Strings, nicht geheim).
   *
   * @returns {Promise<Array<{ value: string, updatedAt: string }>>}
   */
  async listStackMeta() {
    const storeData = await this.#readStore();
    const meta = storeData?.meta ?? {};
    const result = [];
    for (const [key, entry] of Object.entries(meta)) {
      if (key.startsWith('stacks/')) {
        result.push({ value: entry.value, updatedAt: entry.updatedAt });
      }
    }
    return result;
  }

  /**
   * Liest den JSON-String einer Stack-Definition aus dem meta-Block.
   * Gibt null zurück wenn nicht vorhanden.
   *
   * @param {string} stackName - Stack-Name (bereits validiert)
   * @returns {Promise<string|null>}
   */
  async getStackMeta(stackName) {
    const storeData = await this.#readStore();
    const metaKey = `stacks/${stackName}`;
    return storeData?.meta?.[metaKey]?.value ?? null;
  }

  /**
   * Setzt oder überschreibt eine Stack-Definition im meta-Block (Klartext, nicht geheim).
   *
   * @param {string} stackName  - Stack-Name (bereits validiert)
   * @param {string} jsonValue  - JSON-serialisierte StackDefinition
   * @param {string} updatedAt  - ISO-Timestamp
   * @returns {Promise<{ backup: BackupResult }>}
   */
  async setStackMeta(stackName, jsonValue, updatedAt) {
    const metaKey = `stacks/${stackName}`;
    return this.#withWriteLock(async () => {
      let storeData = await this.#readStore();
      if (!storeData) {
        storeData = { version: 1, entries: {}, meta: {} };
      }
      if (!storeData.meta) storeData.meta = {};
      storeData.meta[metaKey] = { value: jsonValue, updatedAt };
      const storeBlob = await this.#writeStore(storeData);
      const backup = await this.#runBackupHook(storeBlob);
      return { backup };
    });
  }

  /**
   * Löscht eine Stack-Definition aus dem meta-Block. Idempotent.
   *
   * @param {string} stackName - Stack-Name (bereits validiert)
   * @returns {Promise<{ backup?: BackupResult }>}
   */
  async deleteStackMeta(stackName) {
    const metaKey = `stacks/${stackName}`;
    return this.#withWriteLock(async () => {
      const storeData = await this.#readStore();
      if (!storeData?.meta?.[metaKey]) return {};
      delete storeData.meta[metaKey];
      const storeBlob = await this.#writeStore(storeData);
      const backup = await this.#runBackupHook(storeBlob);
      return { backup };
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

  // ── Restore (S-142 AC13–AC16) ────────────────────────────────────────────────

  /**
   * Stellt den Credential-Store aus einem verschlüsselten Backup-Artefakt wieder her.
   *
   * Ablauf:
   *   1. Confirm-Flag prüfen — ohne Bestätigung kein Überschreiben (AC14).
   *   2. GPG-decrypt des Artefakts mit dem geladenen Master-Key (AC13/AC15).
   *   3. Artefakt parsen + Manifest-Version prüfen (Edge-Case: inkompatible Version).
   *   4. Blob (secrets.enc.json-Inhalt) validieren (muss gültiges JSON mit kdf-Feld sein).
   *   5. Atomares Zurückschreiben: tmp + fsync + rename (AC15: kein Teil-Überschreiben).
   *   6. Store-Reload: Master-Key bleibt im Speicher; der Store ist sofort nutzbar (AC13).
   *
   * Security-Floor (AC15/AC16):
   *   - Passphrase (Master-Key) NICHT in Logs/Argv/Response.
   *   - Entschlüsselter Klartext bleibt NICHT als Datei liegen (nur in-memory, dann direkt
   *     ins tmp-File — kein explizites temp-File für entschlüsselten Inhalt).
   *   - Schreiben ERST nach erfolgreichem Decrypt: bei Fehler bleibt alter Store intakt.
   *   - Fehlermeldungen sind geheimnisfrei (errorClass statt Details).
   *
   * @param {Buffer} artefactBuffer - Verschlüsseltes GPG-Artefakt (als Buffer)
   * @param {object} [opts]
   * @param {boolean} [opts.confirm=false] - Explizite Überschreib-Bestätigung (AC14)
   * @returns {Promise<{
   *   ok: true,
   *   manifest: object
   * } | {
   *   ok: false,
   *   errorClass: 'confirm-required'|'no-master-key'|'gpg-decrypt-failed'|'restore-invalid'|'restore-write-failed',
   *   error: string
   * }>}
   */
  async restore(artefactBuffer, { confirm = false } = {}) {
    // AC14: Ohne explizite Bestätigung kein Überschreiben
    if (!confirm) {
      return {
        ok: false,
        errorClass: 'confirm-required',
        error: 'Überschreib-Bestätigung fehlt (confirm: true erforderlich).',
      };
    }

    // AC15: Master-Key muss verfügbar sein
    if (!this.#masterKeyRaw) {
      return {
        ok: false,
        errorClass: 'no-master-key',
        error: 'Kein Master-Key geladen (Store gesperrt).',
      };
    }

    // AC15: GPG-decrypt mit geladenem Master-Key (Passphrase via stdin — AC7/Floor)
    let decryptedBuf;
    try {
      decryptedBuf = await gpgDecrypt(this.#masterKeyRaw, artefactBuffer);
    } catch {
      // AC15: GPG-Fehler (falscher Key / korruptes Artefakt) → Fehler-Klasse, kein Secret im Text
      return {
        ok: false,
        errorClass: 'gpg-decrypt-failed',
        error: 'GPG-Entschlüsselung fehlgeschlagen (falscher Master-Key oder korruptes Artefakt).',
      };
    }

    // Artefakt parsen (muss JSON mit { manifest, blob } sein)
    let artefact;
    try {
      artefact = JSON.parse(decryptedBuf.toString('utf8'));
    } catch {
      return {
        ok: false,
        errorClass: 'restore-invalid',
        error: 'Artefakt ist kein gültiges JSON.',
      };
    }

    // Manifest + Blob validieren
    if (!artefact || typeof artefact !== 'object' || !artefact.manifest || typeof artefact.blob !== 'string') {
      return {
        ok: false,
        errorClass: 'restore-invalid',
        error: 'Artefakt-Format ungültig (fehlende manifest/blob-Felder).',
      };
    }

    // Edge-Case: inkompatible Backup-Schema-Version
    const { BACKUP_SCHEMA_VERSION } = await import('./BackupEngine.js');
    const manifestVersion = artefact.manifest?.schemaVersion;
    if (typeof manifestVersion === 'number' && manifestVersion > BACKUP_SCHEMA_VERSION) {
      return {
        ok: false,
        errorClass: 'restore-invalid',
        error: `Artefakt-Schema-Version ${manifestVersion} ist neuer als die unterstützte Version ${BACKUP_SCHEMA_VERSION}.`,
      };
    }

    // Blob muss gültiges JSON mit kdf-Feld sein (Grundvalidierung)
    let blobParsed;
    try {
      blobParsed = JSON.parse(artefact.blob);
    } catch {
      return {
        ok: false,
        errorClass: 'restore-invalid',
        error: 'Blob im Artefakt ist kein gültiges JSON.',
      };
    }

    if (!blobParsed || typeof blobParsed !== 'object') {
      return {
        ok: false,
        errorClass: 'restore-invalid',
        error: 'Blob im Artefakt hat kein gültiges Store-Format.',
      };
    }

    // kdf-Guard: Blob muss ein kdf-Feld enthalten (Grundvalidierung des Store-Formats).
    // Ein leerer Blob ({}) ohne kdf würde sonst akzeptiert und zurückgeschrieben — der
    // alte Store bleibt intakt, wenn wir hier früh abbrechen.
    if (!blobParsed?.kdf) {
      return {
        ok: false,
        errorClass: 'restore-invalid',
        error: 'Blob im Artefakt enthält kein kdf-Feld (kein gültiges Store-Format).',
      };
    }

    // AC15: Atomares Zurückschreiben — Schreiben ERST nach erfolgreichem Decrypt.
    // tmp + fsync + rename: kein Teil-Überschreiben bei Crash/Fehler.
    return this.#withWriteLock(async () => {
      const tmp = `${this.#filePath}.restore-tmp`;
      const dir = this.#filePath.replace(/\/[^/]+$/, '');

      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });

        const json = artefact.blob; // bereits validiertes JSON-String
        let fd;
        try {
          fd = await open(tmp, 'w', 0o600);
          await fd.writeFile(json, 'utf8');
          await fd.sync();
        } finally {
          if (fd) await fd.close();
        }

        await rename(tmp, this.#filePath);

        // Floor: kein entschlüsselter Klartext bleibt als Datei liegen
        // (tmp wurde direkt zu filePath umbenannt — kein separates Klartext-File)

        // AC22/AC23 (S-148): Ziel-Config aus dem Artefakt zurückschreiben (best-effort).
        // Enthält das Artefakt ein `config`-Feld, wird es atomar über BackupConfigStore
        // zurückgeschrieben. Schlägt nur das Config-Zurückschreiben fehl, gilt der
        // Store-Restore weiterhin als erfolgreich (Credentials haben Vorrang — AC23).
        // AC24: Artefakt ohne `config`-Feld → kein Config-Schreiben, kein Fehler.
        let configWarning;
        if (artefact.config && typeof artefact.config === 'object') {
          try {
            await writeBackupConfig(artefact.config);
          } catch (configErr) {
            // AC23: Config-Schreib-Fehler bricht Store-Restore NICHT ab (best-effort)
            configWarning = `[CredentialStore] Backup-Ziel-Config aus Artefakt konnte nicht zurückgeschrieben werden: ${configErr.message}`;
            console.error(configWarning);
          }
        }

        return { ok: true, manifest: artefact.manifest, ...(configWarning ? { configWarning } : {}) };
      } catch {
        // AC15: bei Schreib-Fehler den tmp aufräumen (best-effort)
        try {
          await unlink(tmp);
        } catch { /* ignore */ }

        return {
          ok: false,
          errorClass: 'restore-write-failed',
          error: 'Schreiben des wiederhergestellten Stores fehlgeschlagen.',
        };
      }
    });
  }

  // ── Master-Key-Rotation (credential-key-rotation, S-083 Kern — AC1-AC3/AC7-AC10) ────

  /**
   * Schreibt `data` atomar (tmp + fsync) in eine eigene Rotations-Zwischendatei
   * (`secrets.enc.json.rotate-tmp`) — OHNE sie über das Original zu `rename()`n.
   * Der Aufrufer (rotate()) entscheidet nach erfolgreicher Round-trip-Verifikation
   * separat über den finalen atomaren Swap (AC1 Schritt (b)/(d)).
   *
   * @param {object} data
   * @returns {Promise<string>} Pfad der geschriebenen Rotations-Zwischendatei
   */
  async #writeRotateTmp(data) {
    const tmpPath = `${this.#filePath}.rotate-tmp`;
    const dir = this.#filePath.replace(/\/[^/]+$/, '');

    await mkdir(dir, { recursive: true, mode: 0o700 });

    const json = JSON.stringify(data, null, 2);

    let fd;
    try {
      fd = await open(tmpPath, 'w', 0o600);
      await fd.writeFile(json, 'utf8');
      await fd.sync();
    } finally {
      if (fd) await fd.close();
    }

    return tmpPath;
  }

  /**
   * Räumt eine verwaiste `secrets.enc.json.rotate-tmp`-Datei auf (best-effort).
   * Edge-Case (Spec §Edge-Cases): Crash zwischen Schritt (b) und (d) einer
   * vorherigen Rotation lässt eine solche Datei zurück, während das Original
   * unangetastet bleibt. Fehlende Datei ist kein Fehler (ENOENT wird geschluckt).
   *
   * @returns {Promise<void>}
   */
  async #cleanupRotateTmp() {
    const tmpPath = `${this.#filePath}.rotate-tmp`;
    try {
      await unlink(tmpPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // AC9/Floor: keine Werte im Log — nur die Fehlerklasse
        console.error('[CredentialStore] Aufräumen der verwaisten rotate-tmp-Datei fehlgeschlagen:', err.constructor?.name ?? 'Error');
      }
    }
  }

  /**
   * Räumt eine verwaiste `secrets.enc.json.rotate-tmp`-Datei auf. Öffentlicher
   * Boot-Hook (server.js ruft dies einmalig beim Start auf — Spec-Edge-Case
   * "nächster Start/Lauf räumt die tmp-Datei auf"). rotate() selbst räumt vor
   * jedem eigenen Lauf zusätzlich auf (Edge-Case "nächster ... Lauf").
   *
   * @returns {Promise<void>}
   */
  async cleanupOrphanedRotateTmp() {
    await this.#cleanupRotateTmp();
  }

  /**
   * Rotiert den Master-Key (credential-key-rotation AC1-AC3/AC7-AC10, S-083 Kern).
   *
   * Ablauf, strikt in dieser Reihenfolge:
   *   (a) Entschlüsseln aller Einträge mit dem AKTUELL AKTIVEN (alten) Key (in-memory).
   *   (b) Verschlüsseln aller Einträge mit dem NEUEN Key in eine NEUE Datei
   *       (`secrets.enc.json.rotate-tmp`, frischer Salt/KDF-Block, frische IVs je Eintrag).
   *   (c) Round-trip-Verifikation: die neue Datei wird mit dem NEUEN Key vollständig
   *       zurückgelesen/entschlüsselt und jeder Eintrag wertgleich gegen den Klartext
   *       aus (a) verglichen.
   *   (d) Atomarer Swap: `rename()` der neuen Datei über das Original — ERST nach
   *       grüner Verifikation (Commit-Punkt, ADR-007 tmp+fsync+rename-Linie).
   *
   * Scheitert (a)-(c) ⇒ KEIN Swap: `secrets.enc.json` und `.env` bleiben unverändert,
   * der alte Key bleibt aktiv (AC3, vollständig umkehrbar).
   *
   * Hat der Store aktuell KEINE verschlüsselten Einträge, entfällt die Datei-Rotation
   * (a)-(d) — es gibt nichts, das re-verschlüsselt werden müsste (AC1 "alle Einträge"
   * ist mit 0 Einträgen trivial erfüllt); der neue Key wird trotzdem aktiviert.
   *
   * `.env`-Persistenz (AC7) geschieht ERST NACH einem grünen Swap (bzw. nach der
   * datei-losen Aktivierung im 0-Einträge-Fall). Schlägt NUR die Persistenz fehl,
   * ist der neue Key bereits in-memory aktiv (die Datei erwartet ab dem Swap
   * ausschließlich den neuen Key — ein Rückfall auf den alten Key ist nicht mehr
   * möglich) — der Aufrufer wird über `reason:'persist-failed'` informiert
   * (kein stiller Verlust, Spec-Edge-Case).
   *
   * Gibt NIEMALS einen Key-Wert zurück (AC9); `reason` ist sanitisiert (Enum, kein Wert).
   * Rotiert AUSSCHLIESSLICH `DEVGUI_CRED_MASTER_KEY` — `GPG_PASSPHRASE`/`.env.gpg`
   * werden von dieser Methode nicht berührt (AC10).
   *
   * @param {string} newKey - Der neue Master-Key-Rohwert (wird NICHT geloggt)
   * @returns {Promise<
   *   { ok: true, swapped: true } |
   *   { ok: false, reason: 'empty-key'|'invalid-key-format'|'no-master-key'|'same-key'|
   *       'decrypt-failed'|'encrypt-failed'|'verification-failed'|'swap-failed'|'persist-failed',
   *     swapped: boolean }
   * >}
   */
  async rotate(newKey) {
    if (!newKey || typeof newKey !== 'string' || !newKey.trim()) {
      return { ok: false, reason: 'empty-key', swapped: false };
    }
    // Eingebettetes Newline/CR im Key würde die .env-Zeile korrumpieren (analog unlock()).
    if (/[\r\n]/.test(newKey)) {
      return { ok: false, reason: 'invalid-key-format', swapped: false };
    }
    const trimmedNew = newKey.trim();

    // AC10: Rotation setzt einen aktiven Key voraus (nur DEVGUI_CRED_MASTER_KEY wird rotiert).
    if (!this.#masterKeyRaw) {
      return { ok: false, reason: 'no-master-key', swapped: false };
    }
    const oldKey = this.#masterKeyRaw;

    // Edge-Case (Spec §Edge-Cases): neuer Key == alter Key ⇒ klare Ablehnung
    // (keine sinnlose Re-Encryption).
    if (trimmedNew === oldKey) {
      return { ok: false, reason: 'same-key', swapped: false };
    }

    return this.#withWriteLock(async () => {
      // Edge-Case: verwaiste rotate-tmp-Datei aus einem vorherigen, abgebrochenen
      // Lauf VOR dieser Rotation aufräumen ("nächster ... Lauf räumt auf").
      await this.#cleanupRotateTmp();

      const storeData = await this.#readStore();
      const hasEntries = storeData?.kdf != null && Object.keys(storeData?.entries ?? {}).length > 0;

      if (hasEntries) {
        // (a) Entschlüsseln aller Einträge mit dem alten Key
        const oldSalt = Buffer.from(storeData.kdf.salt, 'base64');
        let oldAesKey;
        try {
          oldAesKey = await this.#deriveKey(oldKey, oldSalt);
        } catch {
          return { ok: false, reason: 'decrypt-failed', swapped: false };
        }

        const plaintexts = {};
        try {
          for (const [entryKey, entry] of Object.entries(storeData.entries)) {
            plaintexts[entryKey] = this.#decrypt(oldAesKey, entry);
          }
        } catch {
          // Manipuliertes Store (GCM-Tag falsch) oder inkonsistenter aktiver Key
          // ⇒ harter Fehler in (a), kein Swap (Spec §Edge-Cases).
          return { ok: false, reason: 'decrypt-failed', swapped: false };
        }

        // (b) Verschlüsseln mit dem neuen Key in eine NEUE Datei — frischer Salt/KDF, frische IVs
        const newSalt = randomBytes(32);
        const newKdf = { algo: 'scrypt', salt: newSalt.toString('base64'), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
        let newAesKey;
        try {
          newAesKey = await this.#deriveKey(trimmedNew, newSalt);
        } catch {
          return { ok: false, reason: 'encrypt-failed', swapped: false };
        }

        const newEntries = {};
        for (const [entryKey, plaintext] of Object.entries(plaintexts)) {
          const encrypted = this.#encrypt(newAesKey, plaintext);
          newEntries[entryKey] = { ...encrypted, updatedAt: storeData.entries[entryKey].updatedAt };
        }

        const newStoreData = {
          version: storeData.version ?? 1,
          kdf: newKdf,
          entries: newEntries,
          ...(storeData.meta ? { meta: storeData.meta } : {}),
        };

        let tmpPath;
        try {
          tmpPath = await this.#writeRotateTmp(newStoreData);
        } catch {
          await this.#cleanupRotateTmp();
          return { ok: false, reason: 'encrypt-failed', swapped: false };
        }

        // (c) Round-trip-Verifikation: neue Datei mit neuem Key vollständig zurücklesen
        let verifyOk = true;
        try {
          const verifyRaw = await readFile(tmpPath, 'utf8');
          const verifyParsed = JSON.parse(verifyRaw);
          const verifySalt = Buffer.from(verifyParsed.kdf.salt, 'base64');
          const verifyAesKey = await this.#deriveKey(trimmedNew, verifySalt);
          for (const [entryKey, expectedPlaintext] of Object.entries(plaintexts)) {
            const verifyEntry = verifyParsed.entries?.[entryKey];
            if (!verifyEntry) {
              verifyOk = false;
              break;
            }
            const decrypted = this.#decrypt(verifyAesKey, verifyEntry);
            if (decrypted !== expectedPlaintext) {
              verifyOk = false;
              break;
            }
          }
        } catch {
          verifyOk = false;
        }

        if (!verifyOk) {
          // Kein Swap — verwaiste tmp-Datei aufräumen, alter Zustand bleibt vollständig aktiv (AC2/AC3).
          await this.#cleanupRotateTmp();
          return { ok: false, reason: 'verification-failed', swapped: false };
        }

        // (d) Atomarer Swap — ERST nach grüner Verifikation (Commit-Punkt, ADR-007).
        try {
          await rename(tmpPath, this.#filePath);
        } catch {
          await this.#cleanupRotateTmp();
          return { ok: false, reason: 'swap-failed', swapped: false };
        }
      }

      // AC7: .env-Persistenz + Prozess-Übergabe ERST NACH grünem Swap (bzw. nach der
      // datei-losen Aktivierung im 0-Einträge-Fall). Ab hier erwartet die Datei
      // (falls hasEntries) ausschließlich den neuen Key — masterKeyRaw MUSS
      // unabhängig vom Persistenz-Ausgang aktualisiert werden (kein Rückfall möglich).
      let persistOk = true;
      try {
        await this.#persistKeyToEnv(trimmedNew);
      } catch {
        persistOk = false;
      }

      this.#masterKeyRaw = trimmedNew;
      // Runtime-Rotation (kein Boot-Reload) → keySource "manual" (analog unlock()).
      this.#keySource = 'manual';

      if (!persistOk) {
        return { ok: false, reason: 'persist-failed', swapped: true };
      }

      return { ok: true, swapped: true };
    });
  }
}
