/**
 * BitwardenDeployLoginService — unbeaufsichtigter Bitwarden-Login für die
 * Deploy-Rolle (Variante B, Spec docs/specs/deploy-bitwarden-gpg-injection.md,
 * F-072/S-332).
 *
 * Anders als der interaktive `BitwardenMasterKeyService` (E-Mail + Master-Passwort
 * + ggf. OTP via PTY) meldet sich dieser Dienst **per API-Key** an
 * (`bw login --apikey`) und entsperrt dann mit dem Master-Passwort
 * (`bw unlock --passwordenv`). Der API-Key-Login umgeht Bitwardens 2FA/OTP →
 * kein Prompt, kein PTY, voll unbeaufsichtigt (Spec AC8).
 *
 * Isolation: jeder Lauf nutzt ein EIGENES, temporäres
 * `BITWARDENCLI_APPDATA_DIR` — dadurch kollidiert er weder mit dem interaktiven
 * Master-Key-Pfad noch mit parallelen Deploys, und „already logged in"-Zustände
 * entstehen gar nicht erst. Das Verzeichnis wird nach Gebrauch entfernt.
 *
 * Security (Spec S1/S2/S4):
 *   - Client-Secret, Master-Passwort, Session-Token gehen NUR via Env an `bw`
 *     (BW_CLIENTID/BW_CLIENTSECRET/BW_PASSWORD/BW_SESSION) — NIE als Argv.
 *   - Item-Werte (Passphrasen) erscheinen NIEMALS in Log/Audit/Response.
 *   - stderr von `bw` wird NIE durchgereicht (könnte Geheimnisse enthalten) —
 *     nur zur internen Fehlerklassifizierung gepuffert.
 *   - Audit-First vor validate/fetch (ohne Werte).
 *
 * Item-Anlage (per-app-gpg-passphrase-provisioning, F-073/S-335):
 *   Die Session (`openSession()`) bietet zusätzlich `itemExists(itemName)` und
 *   `createItem(itemName, password)` — genutzt vom `PerAppGpgProvisioningService`
 *   für die idempotente Anlage von `env.gpg-passphrase-<app>`-Items. Bleibt
 *   dieselbe (einzige) Bitwarden-sprechende Boundary (kein zweiter Login-/
 *   Spawn-Pfad) — `createItem` nutzt dieselbe encode+create-Technik wie
 *   `BitwardenMasterKeyService#bwCreateItem` (Werte nur via stdin, nie Argv).
 *
 * Feld-Lese/Schreib-Naht (per-app-gpg-passphrase-rotation, F-073/S-338):
 *   Die Session bietet zusätzlich `readItemFields(itemName)` (liest aktives
 *   Passwortfeld + die Custom-Felder `naechste`/`vorherige`) und
 *   `updateItemFields(itemName, { password?, naechste?, vorherige? })`
 *   (get-modify-encode-edit — `bw get item` → JSON mutieren → `bw encode`
 *   (stdin) → `bw edit item <id>` (stdin)). `undefined` = Feld unverändert
 *   lassen, `null` = Custom-Feld entfernen (Rollback/Entsorgung, AC5/AC13).
 *   Genutzt vom `PerAppGpgRotationService` — dieselbe (einzige) bw-sprechende
 *   Boundary, kein zweiter Spawn-Pfad.
 *
 * @module BitwardenDeployLoginService
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Erlaubte Fehlerklassen (Spec AC10) — nach außen nur diese, nie Rohtext. */
export const DEPLOY_LOGIN_ERROR_CLASSES = Object.freeze([
  'access-incomplete',
  'auth-failed',
  'unlock-failed',
  'bw-unreachable',
  'item-not-found',
  // per-app-gpg-passphrase-provisioning (F-073/S-335): idempotente Item-Anlage
  // via `bw encode` + `bw create item` (Technik wiederverwendet aus
  // BitwardenMasterKeyService#bwCreateItem) — Anlage-Fehler bekommt eine eigene
  // Klasse (kein Rohtext-Leak, S1).
  'item-create-failed',
  // per-app-gpg-passphrase-rotation (F-073/S-338): get-modify-encode-edit einer
  // BESTEHENDEN Item-Instanz (Feld-Lese-/Schreibfehler, ungültige JSON-Antwort,
  // `bw edit item` fehlgeschlagen) — eigene Klasse (kein Rohtext-Leak, S1).
  'item-update-failed',
  'error',
]);

/**
 * Klassifiziert einen bw-Fehler anhand struktureller Muster (nie Rohtext zurück).
 * @param {string} output   stdout+stderr-Puffer (nur intern)
 * @param {number} exitCode
 * @param {'login'|'unlock'|'get'|'config'} step
 * @returns {string} Fehlerklasse
 */
function classify(output, exitCode, step) {
  const s = (output ?? '').toLowerCase();
  if (exitCode === 127 || s.includes('command not found')) return 'bw-unreachable';
  if (
    s.includes('econnrefused') || s.includes('enotfound') || s.includes('econnreset') ||
    s.includes('getaddrinfo') || s.includes('network') || s.includes('failed to connect') ||
    s.includes('timeout') || s.includes('socket hang up')
  ) {
    return 'bw-unreachable';
  }
  if (step === 'login') return 'auth-failed';       // API-Key falsch/abgelehnt
  if (step === 'unlock') return 'unlock-failed';     // Master-Passwort falsch
  return 'error';
}

export class BitwardenDeployLoginService {
  /** @type {import('./BitwardenDeployAccessStore.js').BitwardenDeployAccessStore} */
  #accessStore;
  /** @type {import('./AuditStore.js').AuditStore} */
  #auditStore;
  /** @type {Function} injizierbare Spawn-Funktion (Tests) */
  #spawnBw;

  /**
   * @param {object} deps
   * @param {import('./BitwardenDeployAccessStore.js').BitwardenDeployAccessStore} deps.accessStore
   * @param {import('./AuditStore.js').AuditStore} deps.auditStore
   * @param {Function} [deps._spawnBw] Signatur: (args, { env, input? }) => Promise<{stdout,stderr,exitCode}>
   */
  constructor({ accessStore, auditStore, _spawnBw } = {}) {
    if (!accessStore || typeof accessStore.getAccessForLogin !== 'function') {
      throw new Error('[BitwardenDeployLoginService] accessStore ist Pflicht');
    }
    if (!auditStore || typeof auditStore.record !== 'function') {
      throw new Error('[BitwardenDeployLoginService] auditStore ist Pflicht');
    }
    this.#accessStore = accessStore;
    this.#auditStore = auditStore;
    this.#spawnBw = _spawnBw ?? spawnBwDefault;
  }

  /**
   * Prüft den hinterlegten Zugang durch einen Probe-Login+Unlock (Spec AC10/AC7).
   * @param {{ identity?: string|null }} [opts]
   * @returns {Promise<{ ok: true } | { ok: false, errorClass: string }>}
   */
  async validateAccess({ identity } = {}) {
    try {
      this.#auditStore.record({ identity: identity ?? null, command: 'deploy-access:validate' });
    } catch {
      return { ok: false, errorClass: 'error' };
    }

    const access = await this.#accessStore.getAccessForLogin();
    if (!access.ready) return { ok: false, errorClass: 'access-incomplete' };

    let session = null;
    try {
      session = await this.#openSession(access);
      return { ok: true };
    } catch (err) {
      return { ok: false, errorClass: err.deployErrorClass ?? 'error' };
    } finally {
      if (session) await session.close();
    }
  }

  /**
   * Öffnet eine Deploy-Session (login+unlock) für EINEN Vorgang (Spec AC11).
   * Erlaubt, in einem Lauf mehrere Items zu lesen; danach `close()` aufrufen.
   * Der fetch-Audit (mit Item-Name) liegt beim Aufrufer (fetchItemPassword bzw.
   * der Deploy-Guard S-334) — daher nimmt diese Methode keine identity entgegen.
   *
   * @returns {Promise<{
   *   readItemPassword(itemName: string): Promise<string>,
   *   itemExists(itemName: string): Promise<boolean>,
   *   createItem(itemName: string, password: string): Promise<void>,
   *   close(): Promise<void>,
   * }>}
   * @throws {Error} mit `deployErrorClass` (access-incomplete|auth-failed|unlock-failed|bw-unreachable)
   */
  async openSession() {
    const access = await this.#accessStore.getAccessForLogin();
    if (!access.ready) {
      const err = new Error('Deploy-Zugang unvollständig');
      err.deployErrorClass = 'access-incomplete';
      throw err;
    }
    return this.#openSession(access);
  }

  /**
   * Bequemer Einzelabruf: login+unlock, ein Item lesen, wieder schließen.
   * @param {string} itemName
   * @param {{ identity?: string|null }} [opts]
   * @returns {Promise<string>} Passphrase (Klartext — nur an internen Aufrufer)
   * @throws {Error} mit `deployErrorClass`
   */
  async fetchItemPassword(itemName, { identity } = {}) {
    try {
      this.#auditStore.record({ identity: identity ?? null, command: `deploy-access:item-read:${sanitizeItemLabel(itemName)}` });
    } catch {
      const err = new Error('Audit-Write fehlgeschlagen');
      err.deployErrorClass = 'error';
      throw err;
    }
    const session = await this.openSession();
    try {
      return await session.readItemPassword(itemName);
    } finally {
      await session.close();
    }
  }

  // ── intern ────────────────────────────────────────────────────────────────

  /**
   * Etabliert eine isolierte bw-Session (eigenes APPDATA_DIR, config→login→unlock).
   * @param {{ serverUrl: string|null, clientId: string, clientSecret: string, masterPassword: string }} access
   * @returns {Promise<{
   *   readItemPassword(itemName: string): Promise<string>,
   *   itemExists(itemName: string): Promise<boolean>,
   *   createItem(itemName: string, password: string): Promise<void>,
   *   close(): Promise<void>,
   * }>}
   */
  async #openSession(access) {
    const appDataDir = await mkdtemp(join(tmpdir(), 'bw-deploy-'));
    const baseEnv = {
      BITWARDENCLI_APPDATA_DIR: appDataDir,
      HOME: process.env.HOME ?? '/home/node',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    };

    const cleanup = async () => {
      try { await this.#spawnBw(['logout'], { env: { ...baseEnv } }); } catch { /* best-effort */ }
      await rm(appDataDir, { recursive: true, force: true }).catch(() => {});
    };

    try {
      // Optional: Server-URL setzen (Argv ist kein Geheimnis)
      if (access.serverUrl) {
        const r = await this.#spawnBw(['config', 'server', access.serverUrl], { env: { ...baseEnv } });
        if (r.exitCode !== 0) {
          throw makeErr(classify(r.stdout + r.stderr, r.exitCode, 'config'));
        }
      }

      // API-Key-Login (Secrets via Env, nicht Argv) — kein OTP/2FA (Spec AC8)
      const loginEnv = { ...baseEnv, BW_CLIENTID: access.clientId, BW_CLIENTSECRET: access.clientSecret };
      const loginRes = await this.#spawnBw(['login', '--apikey'], { env: loginEnv });
      if (loginRes.exitCode !== 0) {
        throw makeErr(classify(loginRes.stdout + loginRes.stderr, loginRes.exitCode, 'login'));
      }

      // Unlock mit Master-Passwort (Env) → Session-Token (--raw)
      const unlockEnv = { ...baseEnv, BW_PASSWORD: access.masterPassword };
      const unlockRes = await this.#spawnBw(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], { env: unlockEnv });
      if (unlockRes.exitCode !== 0 || !unlockRes.stdout.trim()) {
        throw makeErr(classify(unlockRes.stdout + unlockRes.stderr, unlockRes.exitCode || 1, 'unlock'));
      }
      const session = unlockRes.stdout.trim();

      return {
        readItemPassword: async (itemName) => {
          const env = { ...baseEnv, BW_SESSION: session };
          const res = await this.#spawnBw(['get', 'password', itemName], { env });
          if (res.exitCode !== 0) {
            const s = ((res.stdout ?? '') + (res.stderr ?? '')).toLowerCase();
            if (s.includes('not found') || s.includes('no item') || s.includes('more than one')) {
              throw makeErr('item-not-found');
            }
            throw makeErr(classify(res.stdout + res.stderr, res.exitCode, 'get'));
          }
          return res.stdout.trim();
        },
        // per-app-gpg-passphrase-provisioning (F-073/S-335 AC2): Existenz-Check VOR
        // jeder Anlage — `bw get item <name>` statt `get password`, damit KEIN
        // fremder Passphrasen-Wert transient gelesen werden muss. exitCode 0 → true;
        // ein "not found"/"no item"-Muster → false (kein Item); jeder andere Fehler
        // wird klassifiziert weitergeworfen (kein Rohtext, S1).
        itemExists: async (itemName) => {
          const env = { ...baseEnv, BW_SESSION: session };
          const res = await this.#spawnBw(['get', 'item', itemName], { env });
          if (res.exitCode === 0) return true;
          const s = ((res.stdout ?? '') + (res.stderr ?? '')).toLowerCase();
          if (s.includes('not found') || s.includes('no item')) {
            return false;
          }
          throw makeErr(classify(res.stdout + res.stderr, res.exitCode, 'get'));
        },
        // per-app-gpg-passphrase-provisioning (F-073/S-335 AC1/AC2): idempotente
        // Item-Anlage — Technik wiederverwendet aus BitwardenMasterKeyService
        // #bwCreateItem (Item-Template → JSON → `bw encode` via stdin → `bw create
        // item` via stdin). Der Passphrasen-Wert erscheint NIE im Argv (S2).
        createItem: async (itemName, password) => {
          const itemJson = JSON.stringify({
            type: 1, // Login
            name: itemName,
            login: { username: '', password, uris: [] },
            notes: null,
            fields: [],
          });
          const env = { ...baseEnv, BW_SESSION: session };
          const encodeRes = await this.#spawnBw(['encode'], { env, input: itemJson });
          if (encodeRes.exitCode !== 0) {
            throw makeErr('item-create-failed');
          }
          const encodedItem = encodeRes.stdout.trim();
          const createRes = await this.#spawnBw(['create', 'item'], { env, input: encodedItem });
          if (createRes.exitCode !== 0) {
            throw makeErr('item-create-failed');
          }
        },
        // per-app-gpg-passphrase-rotation (F-073/S-338 AC1): liest das aktive
        // Passwortfeld + die Custom-Felder `naechste`/`vorherige` einer
        // BESTEHENDEN Item-Instanz. Rückgabe ist Klartext (Passphrasen!) — NUR
        // an interne Aufrufer (PerAppGpgRotationService), NIE Richtung HTTP/Log.
        readItemFields: async (itemName) => {
          const env = { ...baseEnv, BW_SESSION: session };
          const res = await this.#spawnBw(['get', 'item', itemName], { env });
          if (res.exitCode !== 0) {
            const s = ((res.stdout ?? '') + (res.stderr ?? '')).toLowerCase();
            if (s.includes('not found') || s.includes('no item')) {
              throw makeErr('item-not-found');
            }
            throw makeErr(classify(res.stdout + res.stderr, res.exitCode, 'get'));
          }
          let item;
          try {
            item = JSON.parse(res.stdout);
          } catch {
            throw makeErr('item-update-failed');
          }
          const fields = Array.isArray(item?.fields) ? item.fields : [];
          const findField = (name) => fields.find((f) => f && f.name === name)?.value ?? null;
          return {
            id: typeof item?.id === 'string' ? item.id : null,
            password: item?.login?.password ?? null,
            naechste: findField('naechste'),
            vorherige: findField('vorherige'),
          };
        },
        // per-app-gpg-passphrase-rotation (F-073/S-338 AC1/AC4/AC5/AC13):
        // get-modify-encode-edit einer BESTEHENDEN Item-Instanz — `bw get item`
        // → JSON mutieren (Passwortfeld + Custom-Felder `naechste`/`vorherige`)
        // → `bw encode` (stdin) → `bw edit item <id>` (stdin). Werte NIEMALS im
        // Argv (S2). `mutations.<key> === undefined` → Feld unverändert lassen;
        // `mutations.<key> === null` → Custom-Feld ENTFERNEN (Rollback/AC5/AC13).
        // Unberührte Felder (inkl. fremde Custom-Felder) bleiben unverändert,
        // weil das VOLLE Item-JSON gelesen, punktuell mutiert und zurückgeschrieben
        // wird (kein Überschreiben mit einem Teil-Objekt).
        updateItemFields: async (itemName, mutations = {}) => {
          const env = { ...baseEnv, BW_SESSION: session };
          const getRes = await this.#spawnBw(['get', 'item', itemName], { env });
          if (getRes.exitCode !== 0) {
            const s = ((getRes.stdout ?? '') + (getRes.stderr ?? '')).toLowerCase();
            if (s.includes('not found') || s.includes('no item')) {
              throw makeErr('item-not-found');
            }
            throw makeErr(classify(getRes.stdout + getRes.stderr, getRes.exitCode, 'get'));
          }
          let item;
          try {
            item = JSON.parse(getRes.stdout);
          } catch {
            throw makeErr('item-update-failed');
          }
          if (!item || typeof item.id !== 'string' || !item.id) {
            throw makeErr('item-update-failed');
          }

          if (Object.prototype.hasOwnProperty.call(mutations, 'password') && mutations.password !== undefined) {
            item.login = item.login ?? {};
            item.login.password = mutations.password;
          }

          const fields = Array.isArray(item.fields) ? [...item.fields] : [];
          for (const key of ['naechste', 'vorherige']) {
            if (!Object.prototype.hasOwnProperty.call(mutations, key)) continue;
            const value = mutations[key];
            const idx = fields.findIndex((f) => f && f.name === key);
            if (value === undefined) continue; // unverändert
            if (value === null) {
              if (idx >= 0) fields.splice(idx, 1); // Custom-Feld entfernen
            } else if (idx >= 0) {
              fields[idx] = { ...fields[idx], value, type: 1 };
            } else {
              fields.push({ name: key, value, type: 1 }); // type 1 = Hidden
            }
          }
          item.fields = fields;

          const itemJson = JSON.stringify(item);
          const encodeRes = await this.#spawnBw(['encode'], { env, input: itemJson });
          if (encodeRes.exitCode !== 0) {
            throw makeErr('item-update-failed');
          }
          const encodedItem = encodeRes.stdout.trim();
          const editRes = await this.#spawnBw(['edit', 'item', item.id], { env, input: encodedItem });
          if (editRes.exitCode !== 0) {
            throw makeErr('item-update-failed');
          }
        },
        close: cleanup,
      };
    } catch (err) {
      // Bei Fehler in der Etablierung: aufräumen und weiterwerfen
      await cleanup();
      throw err;
    }
  }
}

/** Baut einen Fehler mit deployErrorClass. */
function makeErr(errorClass) {
  const err = new Error(`bw-deploy: ${errorClass}`);
  err.deployErrorClass = DEPLOY_LOGIN_ERROR_CLASSES.includes(errorClass) ? errorClass : 'error';
  return err;
}

/** Item-Label fürs Audit auf sichere Zeichen begrenzen (kein Wert, nur Name). */
function sanitizeItemLabel(name) {
  return String(name ?? '').replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);
}

/**
 * Standard-Spawn für nicht-interaktive `bw`-Kommandos (Muster BitwardenMasterKeyService).
 * Secrets kommen ausschließlich via opts.env; stderr wird intern gepuffert, nie geloggt.
 *
 * @param {string[]} args   Argumente ohne 'bw'; dürfen KEINE Geheimnisse enthalten
 * @param {{ env: object, input?: string }} opts
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
async function spawnBwDefault(args, { env, input } = {}) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('bw', args, { env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < 1000) stderr += d.toString(); });
    if (input !== undefined && input !== null) child.stdin.write(input);
    child.stdin.end();
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    child.on('error', (err) => resolve({ stdout: '', stderr: err.message ?? 'spawn error', exitCode: 127 }));
  });
}
