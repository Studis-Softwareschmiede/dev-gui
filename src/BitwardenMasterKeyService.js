/**
 * BitwardenMasterKeyService — einzige Komponente, die mit Bitwarden spricht (ADR-014).
 *
 * Beschafft den `DEVGUI_CRED_MASTER_KEY` aus Bitwarden:
 *   - Login mit E-Mail + Master-Passwort (+ 2FA falls nötig) via Bitwarden-CLI `bw`
 *   - Liest ein vorhandenes Master-Key-Item aus (→ AC2)
 *   - Erstellt — nach explizitem Bestätigungs-Flag — ein neues Item mit Zufalls-Key (→ AC4)
 *   - Übergibt den Key store-intern an CredentialStore.unlock() (→ AC2/AC7)
 *   - Verwirft die transiente Bitwarden-Sitzung nach Gebrauch (→ AC9)
 *
 * Security-Anforderungen (AC6 — KRITISCH):
 *   - Bitwarden-Login-Daten erscheinen NIEMALS in Prozess-Argv (kein bw --password=...)
 *   - Passwort wird via stdin (pipe) an `bw` übergeben
 *   - BW_SESSION-Token wird als Env-Var weitergereicht (nie als Arg)
 *   - Master-Key erscheint NIEMALS in Log/Audit/Response/WS/Frontend
 *   - stderr von `bw` wird NICHT in Response/Log weitergeleitet (könnte Secrets enthalten)
 *
 * Audit-First (AC8):
 *   - Vor jeder Beschaffungs-Aktion ein Audit-Eintrag (Identität, Aktion, Zeit) OHNE Werte
 *   - Schlägt der Audit-Write fehl, unterbleibt die Aktion
 *
 * Dependency-Injection (testbar ohne echtes `bw`):
 *   - `_spawnBw` kann via opts injiziert werden (Mock für Unit-Tests)
 *   - Kein echter Bitwarden-Netzwerkaufruf in Tests
 *
 * @module BitwardenMasterKeyService
 */

import { randomBytes } from 'node:crypto';

/** Default Bitwarden Item-Name für den Master-Key (überschreibbar via BW_ITEM_NAME env) */
const DEFAULT_ITEM_NAME = process.env.BW_ITEM_NAME ?? 'dev-gui-master-key';

/** Mindest-Entropie für generierten Key (Bytes) — AC4 */
const MIN_KEY_BYTES = 32;

/**
 * Gibt einen sicheren Fehlergrund zurück — ohne Geheimnis-Leak.
 * stderr von `bw` wird NIEMALS direkt zurückgegeben (könnte Passwort o.Ä. enthalten).
 *
 * @param {string} errorClass
 * @returns {string}
 */
function sanitizeErrorReason(errorClass) {
  switch (errorClass) {
    case 'auth-failed':
      return 'Bitwarden-Authentifizierung fehlgeschlagen (E-Mail oder Master-Passwort falsch)';
    case 'twofa-required':
      return 'Bitwarden: Zwei-Faktor-Authentifizierung erforderlich';
    case 'twofa-invalid':
      return 'Bitwarden: Zwei-Faktor-Code ungültig oder abgelaufen';
    case 'bw-unreachable':
      return 'Bitwarden-Dienst nicht erreichbar oder CLI nicht gefunden';
    case 'item-create-failed':
      return 'Bitwarden-Item konnte nicht angelegt werden';
    default:
      return 'BitwardenMasterKeyService: unerwarteter Fehler';
  }
}

/**
 * Klassifiziert einen bw-CLI-Fehler anhand von stderr-Mustern.
 * Analysiert NUR strukturelle Muster — gibt NIEMALS den stderr-Rohtext zurück.
 *
 * @param {string} stderr   - stderr-Buffer des bw-Prozesses (nur intern — nie nach außen)
 * @param {number} exitCode - Exit-Code des Prozesses
 * @returns {string}        - maschinenlesbare Fehlerklasse
 */
function classifyBwError(stderr, exitCode) {
  const s = (stderr ?? '').toLowerCase();

  // Exit 127 = Binary nicht gefunden
  if (exitCode === 127 || s.includes('command not found') || s.includes('not found')) {
    return 'bw-unreachable';
  }

  // Netzwerk-/Server-Fehler
  if (
    s.includes('econnrefused') ||
    s.includes('enotfound') ||
    s.includes('econnreset') ||
    s.includes('network') ||
    s.includes('failed to connect') ||
    s.includes('timeout') ||
    s.includes('getaddrinfo')
  ) {
    return 'bw-unreachable';
  }

  // 2FA-Fehler: ERST prüfen (bevor allgemeines auth-failed greift)
  if (s.includes('two-step') || s.includes('2fa') || s.includes('two factor') || s.includes('login with api')) {
    // Unklar ob 2FA nötig oder falscher Code → prüfen anhand von "required" / "invalid"
    if (s.includes('required') || s.includes('missing')) {
      return 'twofa-required';
    }
    if (s.includes('invalid') || s.includes('incorrect') || s.includes('wrong')) {
      return 'twofa-invalid';
    }
    return 'twofa-required';
  }

  // Auth-Fehler: 2FA-required ggf. ohne explizites Keyword
  // "Username or password is incorrect" → auth-failed
  if (
    s.includes('username or password') ||
    s.includes('invalid master password') ||
    s.includes('authentication failed') ||
    s.includes('unauthorized') ||
    s.includes('invalid credentials')
  ) {
    return 'auth-failed';
  }

  // Exit non-zero bei Login = wahrscheinlich auth-failed
  if (exitCode !== 0) {
    return 'auth-failed';
  }

  return 'error';
}

/**
 * BitwardenMasterKeyService
 *
 * Einziger Ort, der mit Bitwarden spricht (Boundary-Disziplin, ADR-014-Linie).
 */
export class BitwardenMasterKeyService {
  /** @type {import('./CredentialStore.js').CredentialStore} */
  #credentialStore;

  /** @type {import('./AuditStore.js').AuditStore} */
  #auditStore;

  /** @type {string} Item-Name in Bitwarden */
  #itemName;

  /**
   * Injizierbare Spawn-Funktion für `bw` (für Unit-Tests mockbar).
   * Signatur: (args: string[], opts: { env: object, input?: string }) => Promise<{ stdout: string, stderr: string, exitCode: number }>
   *
   * @type {Function}
   */
  #spawnBw;

  /**
   * @param {object} params
   * @param {import('./CredentialStore.js').CredentialStore} params.credentialStore
   * @param {import('./AuditStore.js').AuditStore} params.auditStore
   * @param {string} [params.itemName]     - Bitwarden Item-Name (Default: BW_ITEM_NAME env oder 'dev-gui-master-key')
   * @param {Function} [params._spawnBw]  - Testbare Spawn-Funktion (Default: echter bw-CLI-Aufruf)
   */
  constructor({ credentialStore, auditStore, itemName, _spawnBw } = {}) {
    if (!credentialStore || typeof credentialStore.unlock !== 'function') {
      throw new Error('[BitwardenMasterKeyService] credentialStore ist Pflicht');
    }
    if (!auditStore || typeof auditStore.record !== 'function') {
      throw new Error('[BitwardenMasterKeyService] auditStore ist Pflicht');
    }
    this.#credentialStore = credentialStore;
    this.#auditStore = auditStore;
    this.#itemName = itemName ?? DEFAULT_ITEM_NAME;
    this.#spawnBw = _spawnBw ?? spawnBwDefault;
  }

  /**
   * Beschafft den Master-Key aus Bitwarden.
   *
   * Ablauf:
   *   1. Audit-Eintrag (login-attempt) — AC8
   *   2. Bitwarden-Login → BW_SESSION
   *   3. Audit-Eintrag (key-read) — AC8
   *   4. Item lesen → geheimer Wert
   *   5. Key store-intern an CredentialStore.unlock() — AC2
   *   6. Bitwarden-Sitzung beenden (bw logout) — AC9
   *
   * AC3: Existiert kein Item → { status: 'not-found' } (KEIN automatisches Erstellen)
   * AC6: Bitwarden-Daten erscheinen NICHT in Argv/Log/Audit/Response
   *
   * @param {object} params
   * @param {string} params.email     - Bitwarden E-Mail (wird NICHT geloggt)
   * @param {string} params.password  - Bitwarden Master-Passwort (wird NICHT geloggt)
   * @param {string} [params.twofa]   - Optionaler 2FA-Code (wird NICHT geloggt)
   * @param {string|null} params.identity - Access-Identität für Audit
   * @returns {Promise<{ status: 'found' } | { status: 'not-found' } | { status: 'error', errorClass: string, reason: string }>}
   */
  async acquireMasterKey({ email, password, twofa, identity } = {}) {
    // ── AC8: Audit-First (login-attempt) — OHNE Credentials ─────────────────
    try {
      this.#auditStore.record({
        identity: identity ?? null,
        command: 'bitwarden:login-attempt',
      });
    } catch {
      // AC8: Audit-Write fehlgeschlagen → Aktion unterbleibt
      return {
        status: 'error',
        errorClass: 'error',
        reason: 'Audit-Write fehlgeschlagen — Aktion abgebrochen',
      };
    }

    // ── AC1: Bitwarden-Login (Credentials via stdin/env, NICHT via Argv) ────
    let sessionToken;
    try {
      sessionToken = await this.#bwLogin({ email, password, twofa });
    } catch (err) {
      const errorClass = err.bwErrorClass ?? 'error';
      return {
        status: 'error',
        errorClass,
        reason: sanitizeErrorReason(errorClass),
      };
    }

    // ── AC8: Audit-First (key-read) — OHNE Key-Wert ─────────────────────────
    try {
      this.#auditStore.record({
        identity: identity ?? null,
        command: `bitwarden:key-read:${this.#itemName}`,
      });
    } catch {
      // Audit-Write fehlgeschlagen → Aktion unterbleibt; Session aufräumen
      await this.#bwLogout(sessionToken);
      return {
        status: 'error',
        errorClass: 'error',
        reason: 'Audit-Write fehlgeschlagen — Aktion abgebrochen',
      };
    }

    // ── AC2/AC3: Master-Key-Item lesen ───────────────────────────────────────
    let keyValue;
    try {
      keyValue = await this.#bwGetItemPassword(sessionToken, this.#itemName);
    } catch (err) {
      await this.#bwLogout(sessionToken);
      if (err.bwNotFound) {
        return { status: 'not-found' };
      }
      return {
        status: 'error',
        errorClass: 'error',
        reason: sanitizeErrorReason('error'),
      };
    }

    // ── AC9: Sitzung beenden ─────────────────────────────────────────────────
    await this.#bwLogout(sessionToken);

    // ── Leer/Null-Wert = not-found (Edge-Case aus Spec) ─────────────────────
    if (!keyValue || !keyValue.trim()) {
      return { status: 'not-found' };
    }

    // ── AC2/AC7: Key store-intern übergeben — erscheint NICHT in Response ───
    const unlockResult = await this.#credentialStore.unlock(keyValue, { persist: true });
    if (!unlockResult.ok) {
      // AC7: Falscher Key → Ablehnung ohne .env-Persistenz
      return {
        status: 'error',
        errorClass: 'error',
        reason: sanitizeErrorReason('error'),
      };
    }

    // AC2: Response enthält KEINEN Key-Wert — nur Status
    return { status: 'found' };
  }

  /**
   * Erzeugt einen kryptographisch sicheren Zufalls-Key und legt ihn als neues Bitwarden-Item an.
   * Nur nach explizitem Aufruf (Bestätigungs-Flag liegt beim Aufrufer) — AC4.
   *
   * AC4: Kein automatisches Erstellen ohne expliziten Aufruf dieser Methode.
   * AC9: Sitzung wird danach verworfen.
   *
   * @param {object} params
   * @param {string} params.email     - Bitwarden E-Mail
   * @param {string} params.password  - Bitwarden Master-Passwort
   * @param {string} [params.twofa]   - Optionaler 2FA-Code
   * @param {string|null} params.identity - Access-Identität für Audit
   * @returns {Promise<{ status: 'created' } | { status: 'error', errorClass: string, reason: string }>}
   */
  async createMasterKey({ email, password, twofa, identity } = {}) {
    // ── AC8: Audit-First (key-create) — OHNE Werte ──────────────────────────
    try {
      this.#auditStore.record({
        identity: identity ?? null,
        command: `bitwarden:key-create:${this.#itemName}`,
      });
    } catch {
      return {
        status: 'error',
        errorClass: 'error',
        reason: 'Audit-Write fehlgeschlagen — Aktion abgebrochen',
      };
    }

    // ── AC1: Bitwarden-Login ─────────────────────────────────────────────────
    let sessionToken;
    try {
      sessionToken = await this.#bwLogin({ email, password, twofa });
    } catch (err) {
      const errorClass = err.bwErrorClass ?? 'error';
      return {
        status: 'error',
        errorClass,
        reason: sanitizeErrorReason(errorClass),
      };
    }

    // ── AC4: Kryptographisch sicherer Zufalls-Key (≥ 32 Byte) ───────────────
    const newKey = randomBytes(MIN_KEY_BYTES).toString('base64');

    // ── AC4: Item in Bitwarden anlegen ───────────────────────────────────────
    try {
      await this.#bwCreateItem(sessionToken, this.#itemName, newKey);
    } catch {
      await this.#bwLogout(sessionToken);
      return {
        status: 'error',
        errorClass: 'item-create-failed',
        reason: sanitizeErrorReason('item-create-failed'),
      };
    }

    // ── AC9: Sitzung beenden ─────────────────────────────────────────────────
    await this.#bwLogout(sessionToken);

    // ── AC7: Key store-intern übergeben — erscheint NICHT in Response ────────
    const unlockResult = await this.#credentialStore.unlock(newKey, { persist: true });
    if (!unlockResult.ok) {
      // Spec Edge-Case: Item angelegt aber unlock fehlgeschlagen
      return {
        status: 'error',
        errorClass: 'error',
        reason: sanitizeErrorReason('error'),
      };
    }

    // AC4: Response enthält KEINEN Key-Wert — nur Status
    return { status: 'created' };
  }

  // ── Private Bitwarden-CLI-Methoden ────────────────────────────────────────────

  /**
   * Führt `bw login` aus und gibt den Session-Token zurück.
   *
   * AC6-KRITISCH: Passwort wird via Env übergeben — NICHT via Argv.
   * Der Login-Befehl für E-Mail+Passwort+optional 2FA:
   *   bw login <email> --passwordenv BW_PASSWORD [--code <2fa>]
   * Das Passwort kommt aus der Env-Var BW_PASSWORD des Subprozesses (nie als Arg).
   *
   * AC6-AUSNAHME (dokumentiert in Spec AC6): Der kurzlebige TOTP-2FA-Code darf als
   * `--code`-Argument übergeben werden, weil `bw login` keine Env/stdin-Alternative
   * für diesen Parameter bietet. Der Code ist einmalig (30s gültig), replay-geschützt
   * und nach dem Login verbraucht — kein dauerhaftes Geheimnis.
   * Master-Passwort und Session-Token bleiben strikt Env-only.
   *
   * @param {object} params
   * @param {string} params.email
   * @param {string} params.password
   * @param {string} [params.twofa]
   * @returns {Promise<string>} BW_SESSION-Token
   */
  async #bwLogin({ email, password, twofa }) {
    // AC6: Args enthalten KEIN Passwort — Passwort via env (BW_PASSWORD)
    const args = ['login', email, '--passwordenv', 'BW_PASSWORD', '--raw'];

    // AC6-Ausnahme (Spec AC6): TOTP-Code als --code-Arg — bw bietet keine Env/stdin-Alternative.
    // Einmalig (30s), replay-geschützt, nach Login verbraucht → kein dauerhaftes Geheimnis.
    if (twofa) {
      args.push('--code', twofa);
    }

    // AC6: Passwort als Env-Var des Subprozesses — nie in Argv
    const env = {
      BW_PASSWORD: password,
      // Sauber isolierte Umgebung (kein ANTHROPIC_API_KEY etc. aus dem Parent-Prozess)
      HOME: process.env.HOME ?? '/home/node',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    };

    const { stdout, stderr, exitCode } = await this.#spawnBw(args, { env });

    if (exitCode !== 0) {
      const errorClass = classifyBwError(stderr, exitCode);
      const err = new Error(`bw login fehlgeschlagen (exit ${exitCode})`);
      err.bwErrorClass = errorClass;
      throw err;
    }

    const token = stdout.trim();
    if (!token) {
      const err = new Error('bw login: kein Session-Token erhalten');
      err.bwErrorClass = 'error';
      throw err;
    }

    return token;
  }

  /**
   * Liest das Passwort-Feld eines Bitwarden-Items.
   *
   * AC6: BW_SESSION via env (nie in Argv).
   * Wirft mit bwNotFound=true wenn das Item nicht existiert.
   *
   * @param {string} sessionToken  - BW_SESSION
   * @param {string} itemName      - Item-Name in Bitwarden
   * @returns {Promise<string>}    - Passwort-Feld des Items
   */
  async #bwGetItemPassword(sessionToken, itemName) {
    // bw get password <name> --session <token>
    // AC6: Session-Token als Env-Var — nie im Argv-Array
    // (bw unterstützt --session als Arg ODER BW_SESSION als env; wir nutzen env)
    const args = ['get', 'password', itemName];

    const env = {
      BW_SESSION: sessionToken,
      HOME: process.env.HOME ?? '/home/node',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    };

    const { stdout, stderr, exitCode } = await this.#spawnBw(args, { env });

    if (exitCode !== 0) {
      // "Not found" = Item nicht vorhanden
      const s = (stderr ?? '').toLowerCase();
      if (s.includes('not found') || s.includes('no item') || stdout.includes('null')) {
        const err = new Error('Bitwarden-Item nicht gefunden');
        err.bwNotFound = true;
        throw err;
      }
      const err = new Error(`bw get password fehlgeschlagen (exit ${exitCode})`);
      err.bwErrorClass = 'error';
      throw err;
    }

    return stdout.trim();
  }

  /**
   * Legt ein neues Login-Item in Bitwarden an.
   *
   * AC6: BW_SESSION via env. Key-Wert via stdin (bw encode + bw create).
   * AC4: Kein Teil-Zustand — schlägt der Create fehl, bleibt Bitwarden Source of Truth.
   *
   * Technik: `bw item template` + JSON-Manipulation + `bw encode` + `bw create item`
   * Das Item-JSON enthält den Key-Wert im password-Feld.
   * Das JSON wird via stdin an `bw encode` übergeben, um keine Klartext-Werte in Argv zu haben.
   *
   * @param {string} sessionToken
   * @param {string} itemName
   * @param {string} keyValue  - der Key-Wert (wird NICHT in Argv exponiert)
   */
  async #bwCreateItem(sessionToken, itemName, keyValue) {
    // Bitwarden-Item als JSON (Login-Typ, keine Collections/Folder erforderlich)
    // https://bitwarden.com/help/cli/#create
    const itemJson = JSON.stringify({
      type: 1,            // Login
      name: itemName,
      login: {
        username: '',
        password: keyValue,
        uris: [],
      },
      notes: null,
      fields: [],
    });

    const env = {
      BW_SESSION: sessionToken,
      HOME: process.env.HOME ?? '/home/node',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    };

    // Schritt 1: JSON via stdin base64-enkodieren (bw encode liest von stdin)
    const encodeResult = await this.#spawnBw(['encode'], { env, input: itemJson });
    if (encodeResult.exitCode !== 0) {
      const err = new Error('bw encode fehlgeschlagen');
      err.bwErrorClass = 'item-create-failed';
      throw err;
    }

    const encodedItem = encodeResult.stdout.trim();

    // Schritt 2: Item anlegen — encodedItem via stdin (kein Key-Wert in Argv)
    const createResult = await this.#spawnBw(['create', 'item'], {
      env,
      input: encodedItem,
    });

    if (createResult.exitCode !== 0) {
      const err = new Error('bw create item fehlgeschlagen');
      err.bwErrorClass = 'item-create-failed';
      throw err;
    }
  }

  /**
   * Beendet die Bitwarden-Sitzung (bw logout).
   * AC9: transiente Sitzung verwerfen — kein dauerhaft entsperrtes Vault.
   * Best-effort: Fehler werden geloggt aber nicht propagiert.
   *
   * @param {string} sessionToken
   */
  async #bwLogout(sessionToken) {
    try {
      const env = {
        BW_SESSION: sessionToken,
        HOME: process.env.HOME ?? '/home/node',
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      };
      await this.#spawnBw(['logout'], { env });
    } catch {
      // Best-effort — Fehler beim Logout nicht propagieren
    }
  }
}

// ── Standard-Spawn-Implementierung (echter bw-CLI-Aufruf) ─────────────────────

/**
 * Führt `bw <args>` als Subprozess aus.
 *
 * AC6-KRITISCH:
 *   - Geheimnisse (Passwort, Session-Token) werden via `opts.env` (Umgebung des Subprozesses)
 *     übergeben — NICHT als Argv-Argumente.
 *   - `stdin` (opts.input) wird für JSON-Payloads genutzt — ebenfalls kein Argv.
 *   - Der Parent-Prozess-Argv ist NIEMALS sichtbar (Node-Prozess spawnt eigenen Subprozess).
 *   - stderr wird NICHT in Response/Log weitergegeben (könnte Credentials enthalten).
 *
 * @param {string[]} args    - Argumente (ohne 'bw'); dürfen KEINE Geheimnisse enthalten
 * @param {object}   opts
 * @param {object}   opts.env    - Env-Vars des Subprozesses (enthält Credentials wie BW_PASSWORD)
 * @param {string}   [opts.input] - stdin-Input (für bw encode / bw create)
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
async function spawnBwDefault(args, { env, input } = {}) {
  const { spawn } = await import('node:child_process');

  return new Promise((resolve) => {
    // AC6: Kein Secret in args — parent PATH + env des Subprozesses liefern Credentials
    const child = spawn('bw', args, {
      // Sauber isolierte Umgebung (kein Leak aus dem Parent-Prozess-Env)
      env: { ...env },
      // stdin: 'pipe' ermöglicht input-Übergabe; 'ignore' wenn kein input
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderrBuf = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      // AC6: stderr intern puffern für Fehlerklassifizierung — NIEMALS in Response/Log/Audit weitergeben
      if (stderrBuf.length < 500) {
        stderrBuf += data.toString();
      }
    });

    // AC6: Falls input (für bw encode / bw create item) → via stdin übergeben (nie als Arg)
    if (input !== undefined && input !== null) {
      child.stdin.write(input);
    }
    child.stdin.end();

    child.on('close', (exitCode) => {
      resolve({
        stdout,
        stderr: stderrBuf,
        exitCode: exitCode ?? 1,
      });
    });

    child.on('error', (err) => {
      // Spawn-Fehler (binary nicht gefunden etc.)
      resolve({
        stdout: '',
        stderr: err.message ?? 'spawn error',
        exitCode: 127,
      });
    });
  });
}
