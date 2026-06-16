/**
 * BitwardenMasterKeyService — einzige Komponente, die mit Bitwarden spricht (ADR-014).
 *
 * Beschafft den `DEVGUI_CRED_MASTER_KEY` aus Bitwarden:
 *   - Login mit E-Mail + Master-Passwort (+ 2FA falls nötig + E-Mail-OTP falls nötig) via Bitwarden-CLI `bw`
 *   - Liest ein vorhandenes Master-Key-Item aus (→ AC2)
 *   - Erstellt — nach explizitem Bestätigungs-Flag — ein neues Item mit Zufalls-Key (→ AC4)
 *   - Übergibt den Key store-intern an CredentialStore.unlock() (→ AC2/AC7)
 *   - Verwirft die transiente Bitwarden-Sitzung nach Gebrauch (→ AC9)
 *
 * Security-Anforderungen (AC6 — KRITISCH):
 *   - Bitwarden-Login-Daten erscheinen NIEMALS in Prozess-Argv (kein bw --password=...)
 *   - Passwort wird via BW_PASSWORD Env-Var an `bw` übergeben
 *   - BW_SESSION-Token wird als Env-Var weitergereicht (nie als Arg)
 *   - E-Mail-OTP-Code wird via PTY-Write übergeben — NICHT als Arg (AC7 bitwarden-new-device-otp)
 *   - Master-Key erscheint NIEMALS in Log/Audit/Response/WS/Frontend
 *   - stderr von `bw` wird NICHT in Response/Log weitergeleitet (könnte Secrets enthalten)
 *
 * New-Device-Verification (bitwarden-new-device-otp, single-process, AC10/AC11):
 *   - bw CLI liest New-Device-OTP via inquirer-Prompt — erfordert einen echten TTY
 *   - Daher wird `bw login` via node-pty (Pseudo-Terminal) ausgeführt
 *   - Single-Process-Modell (AC10): Request 1 startet PTY, hält ihn bei OTP-Prompt offen;
 *     Request 2 schreibt OTP in DENSELBEN Prozess — kein zweiter Spawn
 *   - State-Handle (#ptySessionMap) ist geheimsnisfrei (kein Passwort/Token im Handle)
 *   - Bei 2FA/TOTP-Prompt: wird bereits via --code-Arg übergeben (bw inquirer-Prompt übersprungen)
 *   - PTY-Output wird NICHT geloggt (echot Eingaben zurück → Secret-Leak-Risiko)
 *   - Cleanup (AC11): Timeout + sauberes Kill bei Erfolg/Fehler/Timeout/Abbruch
 *
 * Audit-First (AC8):
 *   - Vor jeder Beschaffungs-Aktion ein Audit-Eintrag (Identität, Aktion, Zeit) OHNE Werte
 *   - Schlägt der Audit-Write fehl, unterbleibt die Aktion
 *
 * Dependency-Injection (testbar ohne echtes `bw`):
 *   - `_spawnBw` kann via opts injiziert werden (Mock für nicht-interaktive bw-Kommandos)
 *   - `_spawnBwPty` kann via opts injiziert werden (Mock für den interaktiven PTY-Login, TOTP-Pfad)
 *   - `_spawnBwPtySession` kann via opts injiziert werden (Mock für Two-Phase-PTY, AC10/AC11)
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
 * Timeout für PTY-Login in Millisekunden.
 * Verhindert Hängenbleiben wenn ein erwarteter Prompt ausbleibt.
 */
const PTY_LOGIN_TIMEOUT_MS = 30_000;

/**
 * Timeout für eine offene PTY-Session im OTP-Wartezustand (AC11).
 * Nach diesem Intervall wird die Session beendet und aufgeräumt.
 * Wert: 3 Minuten — genug Zeit für den Nutzer, den Code einzugeben;
 * kurz genug, um verwaiste Prozesse zu verhindern.
 */
const PTY_OTP_SESSION_TIMEOUT_MS = 3 * 60 * 1000; // 3 Minuten

/**
 * Bekannte inquirer-Prompt-Texte der bw-CLI (case-insensitiv verglichen).
 * New-Device-Prompt: "New device verification required. Enter OTP sent to login email:"
 * Wird verwendet um den PTY-Output zu klassifizieren.
 *
 * Jedes Muster hier ist für sich allein ausreichend präzise, mit einer Ausnahme:
 * 'check your email' ist zu allgemein — es wird nur in Kombination mit einem
 * New-Device-Keyword als Treffer gewertet (siehe isNewDevicePrompt).
 */
const NEW_DEVICE_PROMPT_PATTERNS = [
  'new device verification',
  'device verification required',
  'otp sent to login email',
  'enter otp sent to login email',
];

/**
 * Phrase, die nur in Kombination mit einem weiteren New-Device-Keyword als Muster gilt.
 * Verhindert false-positives bei generischen E-Mail-Hinweisen ohne Device-Kontext.
 */
const NEW_DEVICE_COMPOUND_KEYWORD = 'check your email';

/**
 * Weitere New-Device-Keywords, die in Kombination mit NEW_DEVICE_COMPOUND_KEYWORD
 * einen positiven Treffer ergeben.
 */
const NEW_DEVICE_COMPOUND_PARTNERS = ['device', 'verification', 'otp'];

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
    case 'email-otp-required':
      return 'Bitwarden: New-Device-Verification erforderlich — Einmalcode per E-Mail eingeben';
    case 'email-otp-invalid':
      return 'Bitwarden: E-Mail-OTP-Code ungültig oder abgelaufen';
    case 'bw-unreachable':
      return 'Bitwarden-Dienst nicht erreichbar oder CLI nicht gefunden';
    case 'item-create-failed':
      return 'Bitwarden-Item konnte nicht angelegt werden';
    default:
      return 'BitwardenMasterKeyService: unerwarteter Fehler';
  }
}

/**
 * Klassifiziert einen bw-CLI-Fehler anhand von Output-Mustern (PTY-Output oder stderr).
 * Analysiert NUR strukturelle Muster — gibt NIEMALS den Rohtext zurück.
 *
 * @param {string} output   - PTY-Output oder stderr-Buffer (nur intern — nie nach außen)
 * @param {number} exitCode - Exit-Code des Prozesses
 * @returns {string}        - maschinenlesbare Fehlerklasse
 */
function classifyBwError(output, exitCode) {
  const s = (output ?? '').toLowerCase();

  // Exit 127 = Binary nicht gefunden
  if (exitCode === 127 || s.includes('command not found')) {
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

  // New-Device-Verification (E-Mail-OTP): ZUERST prüfen (vor TOTP-2FA und auth-failed).
  // bw CLI schreibt den inquirer-Prompt-Text via PTY, bevor es den Code liest.
  // Wenn kein Code übergeben (keine PTY-Write), schlägt bw mit diesem Muster fehl.
  // Unterscheidbar von TOTP-2FA durch "new device", "device verification", "check your email".
  if (
    s.includes('new device verification') ||
    s.includes('device verification required') ||
    s.includes('device-verification') ||
    s.includes('check your email') ||
    (s.includes('verification') && s.includes('otp sent to login email'))
  ) {
    // Wenn der Code übergeben wurde aber abgelaufen/falsch → 'email-otp-invalid'.
    // Tritt auf wenn bw nach dem Einreichen des Codes mit Fehler antwortet.
    if (s.includes('invalid') || s.includes('incorrect') || s.includes('expired') || s.includes('wrong')) {
      return 'email-otp-invalid';
    }
    return 'email-otp-required';
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
 * Prüft ob ein PTY-Output-Chunk einen New-Device-OTP-Prompt enthält.
 * Case-insensitiv, tolerant gegen leichte Wording-Varianten.
 * NICHT anfällig für false-positive bei TOTP-2FA (andere Keywords).
 *
 * 'check your email' wird nur in Kombination mit einem weiteren New-Device-Keyword
 * gewertet (z.B. 'device', 'verification', 'otp') — verhindert false-positives.
 *
 * @param {string} text - PTY-Output-Chunk (NICHT loggen — könnte echoed Input enthalten)
 * @returns {boolean}
 */
function isNewDevicePrompt(text) {
  const lower = text.toLowerCase();
  if (NEW_DEVICE_PROMPT_PATTERNS.some((p) => lower.includes(p))) {
    return true;
  }
  // 'check your email' gilt nur in Kombination mit einem weiteren New-Device-Keyword
  if (
    lower.includes(NEW_DEVICE_COMPOUND_KEYWORD) &&
    NEW_DEVICE_COMPOUND_PARTNERS.some((kw) => lower.includes(kw))
  ) {
    return true;
  }
  return false;
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
   * Injizierbare Spawn-Funktion für nicht-interaktive `bw`-Befehle (für Unit-Tests mockbar).
   * Signatur: (args: string[], opts: { env: object, input?: string }) => Promise<{ stdout: string, stderr: string, exitCode: number }>
   *
   * @type {Function}
   */
  #spawnBw;

  /**
   * Injizierbare PTY-Login-Funktion für den interaktiven `bw login`-Befehl (für Unit-Tests mockbar).
   * Signatur: (args: string[], opts: { env: object, emailOtp?: string }) => Promise<{ stdout: string, output: string, exitCode: number }>
   *
   * `output` enthält den zusammengefassten PTY-Output (intern für Klassifizierung — NIEMALS loggen/ausgeben).
   * `stdout` enthält den Session-Token wenn der Login erfolgreich war.
   *
   * Wird weiterhin für den TOTP-2FA-Pfad und nicht-OTP-Logins verwendet (Regression-Schutz).
   *
   * @type {Function}
   */
  #spawnBwPty;

  /**
   * Injizierbare Two-Phase-PTY-Session-Funktion für den single-process OTP-Fluss (AC10/AC11).
   *
   * Signatur: (args: string[], env: object) =>
   *   Promise<
   *     | { phase: 'done', stdout: string, output: string, exitCode: number }
   *     | { phase: 'awaiting-otp', writeOtp(code: string): Promise<{ stdout: string, output: string, exitCode: number }>, cleanup(): void }
   *   >
   *
   * - 'done': Login abgeschlossen ohne OTP-Prompt (kein New-Device-Prompt erkannt).
   * - 'awaiting-otp': New-Device-Prompt erkannt; PTY-Prozess läuft noch offen.
   *   `writeOtp(code)` schreibt den Code in denselben Prozess und liefert das End-Ergebnis.
   *   `cleanup()` beendet den Prozess ohne OTP-Einreichung (für Timeout/Abbruch).
   *
   * AC10: Es wird KEIN zweiter `bw login`-Prozess gestartet um den OTP-Code zu prüfen.
   * AC11: cleanup() ist idempotent; PTY-Prozess hinterlässt keinen Zombie.
   *
   * @type {Function}
   */
  #spawnBwPtySession;

  /**
   * Offene PTY-Sessions im OTP-Wartezustand (AC10/AC11, single-process).
   *
   * Schlüssel: identity-String (CRED_ADMIN-E-Mail oder null → 'anon').
   * Wert: { writeOtp, cleanup, timeoutHandle }
   *
   * Security: kein Passwort/Secret im Handle gespeichert — nur Prozess-Handle + Callbacks.
   * Cleanup: bei Erfolg, Fehler, Timeout oder zweitem Versuch derselben identity sauber räumen.
   *
   * @type {Map<string, { writeOtp: Function, cleanup: Function, timeoutHandle: NodeJS.Timeout }>}
   */
  #ptySessionMap = new Map();

  /**
   * Gehaltene bw-Sessions nach acquire→not-found (AC10/AC11).
   *
   * Schlüssel: identity-String (E-Mail oder null → 'anon').
   * Wert: { sessionToken: string, timeoutHandle: NodeJS.Timeout }
   *
   * Security: nur der Session-Token wird gespeichert — KEIN Passwort, kein OTP, kein Key.
   * Der Token ist transient: er wird nach create+unlock+logout oder nach Timeout verworfen.
   * Cleanup: bei createMasterKey (Erfolg/Fehler), bei Timeout, bei neuem acquire für dieselbe
   * identity (vorheriger Handle wird überschrieben) → kein Leak, kein verwaister Prozess.
   *
   * @type {Map<string, { sessionToken: string, timeoutHandle: NodeJS.Timeout }>}
   */
  #acquireSessionMap = new Map();

  /**
   * Timeout für gehaltene acquire→not-found-Session (AC11).
   * Injizierbar für Tests (sehr kurze Timeouts).
   * @type {number}
   */
  #acquireSessionTimeoutMs;

  constructor({ credentialStore, auditStore, itemName, _spawnBw, _spawnBwPty, _spawnBwPtySession, _acquireSessionTimeoutMs } = {}) {
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
    this.#spawnBwPty = _spawnBwPty ?? spawnBwPtyDefault;
    this.#spawnBwPtySession = _spawnBwPtySession ?? spawnBwPtySessionDefault;
    this.#acquireSessionTimeoutMs = _acquireSessionTimeoutMs ?? PTY_OTP_SESSION_TIMEOUT_MS;
  }

  /**
   * Beschafft den Master-Key aus Bitwarden.
   *
   * Ablauf:
   *   1. Audit-Eintrag (login-attempt) — AC8
   *   2. Bitwarden-Login via PTY → BW_SESSION
   *   3. Audit-Eintrag (key-read) — AC8
   *   4. Item lesen → geheimer Wert
   *   5. Key store-intern an CredentialStore.unlock() — AC2
   *   6. Bitwarden-Sitzung beenden (bw logout) — AC9
   *
   * AC3: Existiert kein Item → { status: 'not-found' } (KEIN automatisches Erstellen)
   * AC6: Bitwarden-Daten erscheinen NICHT in Argv/Log/Audit/Response
   *
   * @param {object} params
   * @param {string} params.email        - Bitwarden E-Mail (wird NICHT geloggt)
   * @param {string} params.password     - Bitwarden Master-Passwort (wird NICHT geloggt)
   * @param {string} [params.twofa]      - Optionaler 2FA-Code (wird NICHT geloggt, AC6-Ausnahme: als --code-Arg)
   * @param {string} [params.emailOtp]   - Optionaler E-Mail-OTP-Code für New-Device-Verification (via PTY-Write, NICHT als Arg)
   * @param {string|null} params.identity - Access-Identität für Audit
   * @returns {Promise<{ status: 'found' } | { status: 'not-found' } | { status: 'error', errorClass: string, reason: string }>}
   */
  async acquireMasterKey({ email, password, twofa, emailOtp, identity } = {}) {
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

    // ── AC1: Bitwarden-Login via PTY (Credentials via stdin/env, NICHT via Argv) ────
    let sessionToken;
    try {
      sessionToken = await this.#bwLogin({ email, password, twofa, emailOtp, identity });
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
      if (err.bwNotFound) {
        // AC10/AC9: Item nicht gefunden → Session NICHT sofort beenden.
        // Die etablierte bw-Sitzung wird in einem geheimnisfreien Handle gehalten,
        // damit createMasterKey die Session wiederverwenden kann (kein zweiter bw-Login).
        // Timeout (AC11): nach #acquireSessionTimeoutMs wird die Session beendet + aufgeräumt.
        const sessionKey = identity ?? 'anon';
        // Alten Handle für dieselbe identity aufräumen + alten Session-Token ausloggen (AC11)
        // Fire-and-forget: Best-effort logout des alten Tokens bei Parallel-Acquire.
        this.#cleanupAcquireSessionWithLogout(sessionKey).catch(() => {});
        const timeoutHandle = setTimeout(() => {
          // Fire-and-forget: Best-effort logout bei Timeout (AC11).
          // Fehler im Logout werden ignoriert (kein Crash des Timer-Callbacks).
          this.#cleanupAcquireSessionWithLogout(sessionKey).catch(() => {});
        }, this.#acquireSessionTimeoutMs);
        this.#acquireSessionMap.set(sessionKey, { sessionToken, timeoutHandle });
        return { status: 'not-found' };
      }
      await this.#bwLogout(sessionToken);
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
   * @param {string} params.email        - Bitwarden E-Mail
   * @param {string} params.password     - Bitwarden Master-Passwort
   * @param {string} [params.twofa]      - Optionaler 2FA-Code
   * @param {string} [params.emailOtp]   - Optionaler E-Mail-OTP-Code für New-Device-Verification (via PTY-Write, NICHT als Arg)
   * @param {string|null} params.identity - Access-Identität für Audit
   * @returns {Promise<{ status: 'created' } | { status: 'error', errorClass: string, reason: string }>}
   */
  async createMasterKey({ email, password, twofa, emailOtp, identity } = {}) {
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

    // ── AC10: Session-Wiederverwendung (acquire→not-found gehaltene Session) ──
    // Wenn acquireMasterKey zuvor not-found zurückgegeben hat, wurde die bw-Session
    // in #acquireSessionMap gehalten — dieselbe Session hier für bw create nutzen,
    // damit KEIN zweiter bw-Login (und kein zweiter OTP-Request) nötig ist.
    const sessionKey = identity ?? 'anon';
    const heldHandle = this.#acquireSessionMap.get(sessionKey);
    let sessionToken;

    if (heldHandle) {
      // Gehaltene Session gefunden → direkt verwenden (AC10: kein zweiter bw login)
      sessionToken = heldHandle.sessionToken;
      // Handle sofort entfernen + Timeout stoppen (AC11: kein Leak)
      this.#cleanupAcquireSession(sessionKey);
    } else {
      // Keine gehaltene Session (Timeout abgelaufen / kein vorheriges acquire not-found).
      // AC11: KEIN stiller Re-Login mit Alt-Daten → klassifizierter Fehler.
      // Ausnahme: Wenn Login-Daten + ggf. OTP vorhanden sind, kann ein frischer Login
      // versucht werden (regulärer Pfad für den Fall, dass create direkt ohne acquire
      // aufgerufen wird — kein erzwungener Fehler, da der Aufrufer alle Daten hat).
      try {
        sessionToken = await this.#bwLogin({ email, password, twofa, emailOtp, identity });
      } catch (err) {
        const errorClass = err.bwErrorClass ?? 'error';
        return {
          status: 'error',
          errorClass,
          reason: sanitizeErrorReason(errorClass),
        };
      }
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
   * Führt `bw login` via PTY aus und gibt den Session-Token zurück.
   *
   * AC6-KRITISCH: Passwort wird via Env übergeben — NICHT via Argv oder PTY-Write.
   * Der Login-Befehl:
   *   bw login <email> --passwordenv BW_PASSWORD --raw [--code <2fa>]
   *
   * Single-Process-OTP-Fluss (AC10/AC11):
   *   - Kein emailOtp + kein offener Handle: startet PTY via #spawnBwPtySession.
   *     - Kein OTP-Prompt → Login direkt abgeschlossen (non-OTP-Pfad).
   *     - OTP-Prompt erkannt → PTY bleibt offen, Handle wird in #ptySessionMap gespeichert.
   *       Wirft mit bwErrorClass='email-otp-required' — der Aufrufer kann erneut mit emailOtp kommen.
   *   - Mit emailOtp + offener Handle: schreibt OTP in denselben PTY — KEIN neuer Spawn.
   *   - Mit emailOtp + KEIN Handle (Timeout abgelaufen): wirft mit 'email-otp-required' (frischer Start nötig).
   *
   * TOTP-2FA-Pfad (AC4, Regression-Schutz):
   *   - twofa ist gesetzt → läuft weiter via #spawnBwPty (bestehender Pfad, unverändert).
   *
   * AC6-AUSNAHME (dokumentiert in Spec #183 AC6): Der kurzlebige TOTP-2FA-Code darf als
   * `--code`-Argument übergeben werden, weil `bw login` keine Env/stdin-Alternative
   * für diesen Parameter bietet. Der Code ist einmalig (30s gültig), replay-geschützt
   * und nach dem Login verbraucht — kein dauerhaftes Geheimnis.
   * Master-Passwort und Session-Token bleiben strikt Env-only.
   *
   * @param {object} params
   * @param {string} params.email
   * @param {string} params.password
   * @param {string} [params.twofa]
   * @param {string} [params.emailOtp]    - E-Mail-OTP für New-Device-Verification (via PTY-Write, AC7)
   * @param {string|null} params.identity - Identität für Session-Map-Key (niemals geloggt)
   * @returns {Promise<string>} BW_SESSION-Token
   */
  async #bwLogin({ email, password, twofa, emailOtp, identity }) {
    // AC6: Args enthalten KEIN Passwort — Passwort via env (BW_PASSWORD)
    const args = ['login', email, '--passwordenv', 'BW_PASSWORD', '--raw'];

    // AC6-Ausnahme (Spec #183 AC6): TOTP-Code als --code-Arg — bw bietet keine Env/stdin-Alternative.
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

    // ── Single-Process-OTP-Pfad (AC10/AC11) ──────────────────────────────────
    // Nur wenn kein TOTP-2FA-Code übergeben wird (TOTP und Email-OTP schließen sich aus, Spec §4).
    if (!twofa) {
      const sessionKey = identity ?? 'anon';

      if (emailOtp) {
        // Request 2: OTP vorhanden → in offenen Prozess schreiben (KEIN neuer Spawn, AC10).
        const handle = this.#ptySessionMap.get(sessionKey);

        if (!handle) {
          // Kein offener Prozess (Timeout abgelaufen oder nie gestartet) — AC11.
          // NICHT stillschweigend einen neuen Prozess starten (Spec: Vertrag "Prozess-State").
          const err = new Error('Kein offener OTP-Prozess für diese Identität (Timeout oder neuer Versuch nötig)');
          err.bwErrorClass = 'email-otp-required';
          throw err;
        }

        // Handle gefunden: OTP in denselben PTY schreiben → auf Ergebnis warten.
        // AC11: Handle NACH dem OTP-Write aufräumen (Timeout clearen; Map-Eintrag entfernen).
        // Cleanup JETZT: Timeout stoppen + Map-Eintrag entfernen, aber PTY-Prozess läuft weiter
        // (handle.cleanup() wird NICHT aufgerufen — writeOtp braucht den offenen Prozess).
        this.#ptySessionMap.delete(sessionKey);
        if (handle.timeoutHandle !== null && handle.timeoutHandle !== undefined) {
          clearTimeout(handle.timeoutHandle);
        }

        let result;
        // Phase-2-Timeout (30 s): Wenn bw nach dem OTP-Write hängt (Netz/unerwarteter Prompt),
        // würde writeOtp dauerhaft unresolved bleiben → Zombie-PTY + hängender HTTP-Handler (AC11).
        // Promise.race bricht das writeOtp-Promise nach PTY_LOGIN_TIMEOUT_MS ab und räumt auf.
        let phase2TimeoutHandle = null;
        const phase2TimeoutPromise = new Promise((_res, rej) => {
          phase2TimeoutHandle = setTimeout(() => {
            rej(Object.assign(new Error('Phase-2-OTP-Timeout: bw hat nach OTP-Write nicht reagiert'), { bwErrorClass: 'error' }));
          }, PTY_LOGIN_TIMEOUT_MS);
        });
        try {
          // AC7: emailOtp NICHT in Argv — writeOtp schreibt via PTY-Write.
          // PTY_LOGIN_TIMEOUT_MS = 30 000 ms — verhindert dauerhaftes Hängen nach OTP-Write (AC11).
          result = await Promise.race([handle.writeOtp(emailOtp), phase2TimeoutPromise]);
        } catch (writeErr) {
          // Prozess auch bei Fehler/Timeout sauber beenden (AC11)
          try { handle.cleanup(); } catch { /* ignorieren */ }
          const err = writeErr.bwErrorClass
            ? writeErr
            : Object.assign(new Error('PTY-OTP-Write fehlgeschlagen'), { bwErrorClass: 'error' });
          throw err;
        } finally {
          clearTimeout(phase2TimeoutHandle);
        }
        // Nach dem OTP-Write: PTY-Prozess ist beendet (handle.writeOtp wartet auf PTY-Exit).
        // Kein explizites cleanup() nötig — der Prozess hat sich selbst beendet.

        if (result.exitCode !== 0) {
          // AC7-KRITISCH: result.output NICHT loggen
          const errorClass = classifyBwError(result.output, result.exitCode);
          const err = new Error(`bw login (OTP-Phase) fehlgeschlagen (exit ${result.exitCode})`);
          err.bwErrorClass = errorClass;
          throw err;
        }

        const token = result.stdout.trim();
        if (!token) {
          const err = new Error('bw login (OTP-Phase): kein Session-Token erhalten');
          err.bwErrorClass = 'error';
          throw err;
        }
        return token;
      }

      // Request 1: Kein emailOtp → PTY starten, auf OTP-Prompt oder Abschluss warten.
      const phase = await this.#spawnBwPtySession(args, env);

      if (phase.phase === 'awaiting-otp') {
        // New-Device-Prompt erkannt: PTY offen halten.
        // Zwei parallele Versuche derselben identity: alten Handle zuerst sauber räumen (AC11).
        if (this.#ptySessionMap.has(sessionKey)) {
          this.#cleanupPtySession(sessionKey);
        }

        // Timeout: nach PTY_OTP_SESSION_TIMEOUT_MS den Prozess beenden + aufräumen (AC11).
        const timeoutHandle = setTimeout(() => {
          if (this.#ptySessionMap.has(sessionKey)) {
            this.#cleanupPtySession(sessionKey);
          }
        }, PTY_OTP_SESSION_TIMEOUT_MS);

        this.#ptySessionMap.set(sessionKey, {
          writeOtp: phase.writeOtp,
          cleanup: phase.cleanup,
          timeoutHandle,
        });

        // Aufrufer bekommt email-otp-required → Dialog zeigt OTP-Feld.
        const err = new Error('New-Device-Verification erforderlich — bitte OTP eingeben');
        err.bwErrorClass = 'email-otp-required';
        throw err;
      }

      // phase === 'done': Login ohne OTP-Prompt abgeschlossen (z.B. bekanntes Gerät).
      const { stdout, output, exitCode } = phase;
      if (exitCode !== 0) {
        const errorClass = classifyBwError(output, exitCode);
        const err = new Error(`bw login fehlgeschlagen (exit ${exitCode})`);
        err.bwErrorClass = errorClass;
        throw err;
      }

      const doneToken = stdout.trim();
      if (!doneToken) {
        const err = new Error('bw login: kein Session-Token erhalten');
        err.bwErrorClass = 'error';
        throw err;
      }
      return doneToken;
    }

    // ── TOTP-2FA-Pfad (AC4, Regression-Schutz, unveränderter bisheriger Pfad) ──
    // AC7 (bitwarden-new-device-otp): emailOtp hier nie übergeben (twofa schließt email-otp aus).
    const { stdout, output, exitCode } = await this.#spawnBwPty(args, { env, emailOtp: undefined });

    if (exitCode !== 0) {
      // AC7-KRITISCH: output NICHT loggen (kann echoed Eingaben/PTY-Echo enthalten)
      const errorClass = classifyBwError(output, exitCode);
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
   * Räumt eine offene PTY-Session auf (AC11).
   * Idempotent: mehrfacher Aufruf ist sicher.
   *
   * @param {string} sessionKey - Schlüssel in #ptySessionMap
   */
  #cleanupPtySession(sessionKey) {
    const handle = this.#ptySessionMap.get(sessionKey);
    if (!handle) return;
    this.#ptySessionMap.delete(sessionKey);
    // Timeout abbrechen
    if (handle.timeoutHandle !== null && handle.timeoutHandle !== undefined) {
      clearTimeout(handle.timeoutHandle);
    }
    // PTY-Prozess beenden
    try {
      handle.cleanup();
    } catch {
      // Prozess möglicherweise bereits beendet — ignorieren
    }
  }

  /**
   * Räumt eine gehaltene acquire-Session auf, OHNE bw logout zu rufen (AC11).
   * Stoppt nur den Timeout + entfernt den Map-Eintrag.
   * Wird intern verwendet wenn der Caller die Session selbst übernimmt.
   *
   * @param {string} sessionKey
   */
  #cleanupAcquireSession(sessionKey) {
    const handle = this.#acquireSessionMap.get(sessionKey);
    if (!handle) return;
    this.#acquireSessionMap.delete(sessionKey);
    if (handle.timeoutHandle !== null && handle.timeoutHandle !== undefined) {
      clearTimeout(handle.timeoutHandle);
    }
  }

  /**
   * Räumt eine gehaltene acquire-Session auf UND ruft bw logout (AC11, Timeout-Pfad).
   * Verwendet bei Timeout und beim Überschreiben eines alten Handles.
   *
   * @param {string} sessionKey
   */
  async #cleanupAcquireSessionWithLogout(sessionKey) {
    const handle = this.#acquireSessionMap.get(sessionKey);
    if (!handle) return;
    this.#acquireSessionMap.delete(sessionKey);
    if (handle.timeoutHandle !== null && handle.timeoutHandle !== undefined) {
      clearTimeout(handle.timeoutHandle);
    }
    // AC9/AC11: Session beenden — kein dauerhaft offenes Vault
    await this.#bwLogout(handle.sessionToken);
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

// ── Standard-Spawn-Implementierung (echter bw-CLI-Aufruf, nicht-interaktiv) ──────

/**
 * Führt `bw <args>` als Subprozess aus (ohne TTY — für nicht-interaktive Kommandos).
 *
 * AC6-KRITISCH:
 *   - Geheimnisse (Passwort, Session-Token) werden via `opts.env` übergeben — NICHT als Argv.
 *   - `stdin` (opts.input) wird für JSON-Payloads genutzt — ebenfalls kein Argv.
 *   - stderr wird NICHT in Response/Log weitergegeben (könnte Credentials enthalten).
 *
 * Nur für nicht-interaktive Kommandos (bw get, bw encode, bw create, bw logout).
 * Für `bw login` muss spawnBwPtyDefault verwendet werden (node-pty).
 *
 * @param {string[]} args    - Argumente (ohne 'bw'); dürfen KEINE Geheimnisse enthalten
 * @param {object}   opts
 * @param {object}   opts.env    - Env-Vars des Subprozesses (enthält Credentials wie BW_SESSION)
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

// ── PTY-Spawn-Implementierung (echter bw-Login via node-pty) ─────────────────────

/**
 * Führt `bw login <args>` via node-pty aus — gibt dem Prozess einen echten TTY.
 *
 * Warum PTY: bw-CLI nutzt inquirer für interaktive Prompts (New-Device-OTP, ggf. 2FA).
 * Inquirer erkennt non-TTY-stdin und gibt Prompts nicht aus → kein Prompt-Detection möglich.
 * Mit node-pty sieht bw/inquirer einen echten TTY → Prompts erscheinen im PTY-Output.
 *
 * Security-Protokoll:
 *   - PTY-Output wird NICHT geloggt — er kann echoed Input enthalten (OTP-Code-Echo)
 *   - Nur der letzte Zeileninhalt (Session-Token) wird als `stdout` zurückgegeben
 *   - `output` wird nur intern zur Fehlerklassifizierung verwendet — nie nach außen
 *   - Timeout (PTY_LOGIN_TIMEOUT_MS) verhindert Hängenbleiben
 *   - PTY-Prozess wird nach Abschluss oder Timeout sauber beendet
 *
 * Prompt-Handling:
 *   - New-Device-Prompt erkannt (isNewDevicePrompt) + emailOtp vorhanden → PTY-Write
 *   - New-Device-Prompt erkannt + kein emailOtp → PTY läuft bis Timeout/Exit → classifyBwError
 *   - Kein Prompt im Output → Login lief non-interaktiv durch (Passwort via env, kein 2FA-Prompt)
 *
 * @param {string[]} args    - Login-Argumente (ohne 'bw'); dürfen KEINE Geheimnisse enthalten
 * @param {object}   opts
 * @param {object}   opts.env       - Env-Vars des Subprozesses (enthält BW_PASSWORD)
 * @param {string}   [opts.emailOtp] - E-Mail-OTP für New-Device-Verification (via PTY-Write)
 * @returns {Promise<{ stdout: string, output: string, exitCode: number }>}
 *   stdout: letzter non-empty Zeileninhalt (Session-Token bei Erfolg)
 *   output: akkumulierter PTY-Output (NUR intern für Klassifizierung — NIEMALS loggen)
 */
async function spawnBwPtyDefault(args, { env, emailOtp } = {}) {
  const { spawn: ptySpawn } = await import('node-pty');

  return new Promise((resolve) => {
    let ptyProcess = null;
    let outputBuf = '';   // AC7-KRITISCH: NIEMALS loggen — kann echoed OTP enthalten
    let otpWritten = false;
    let settled = false;
    let timeoutHandle = null;

    /**
     * Sauber beenden und Ergebnis zurückgeben.
     * @param {{ stdout: string, output: string, exitCode: number }} result
     */
    function settle(result) {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      // Sauberes Cleanup des PTY-Prozesses — kein Hängenbleiben
      try {
        ptyProcess?.kill();
      } catch {
        // Prozess möglicherweise bereits beendet
      }
      resolve(result);
    }

    // Timeout: verhindert dauerhaftes Hängenbleiben wenn Prompt ausbleibt
    timeoutHandle = setTimeout(() => {
      // Timeout-Klassifizierung: wenn New-Device-Muster im Output → email-otp-required
      // (Prompt erschien, aber kein Code übergeben → Timeout = 'kein Code'-Situation)
      // Sonst: Auth-Fehler oder bw-unreachable
      settle({
        stdout: '',
        output: outputBuf, // intern für classifyBwError
        exitCode: 1,       // nicht-null = Fehler
      });
    }, PTY_LOGIN_TIMEOUT_MS);

    let spawnError = null;
    try {
      ptyProcess = ptySpawn('bw', args, {
        name: 'xterm',
        cols: 80,
        rows: 24,
        // AC6: Sauber isolierte Umgebung — nur übergebene env-Vars (kein Parent-Leak)
        env: { ...env },
      });
    } catch (err) {
      // Spawn-Fehler (binary nicht gefunden etc.)
      spawnError = err;
    }

    if (spawnError) {
      settle({
        stdout: '',
        output: spawnError.message ?? 'pty spawn error',
        exitCode: 127,
      });
      return;
    }

    // PTY-Output empfangen und auf Prompts scannen
    // AC7-KRITISCH: outputBuf NICHT loggen (kann echoed OTP/Passwort enthalten)
    ptyProcess.onData((data) => {
      // Pufferung auf 2000 Zeichen begrenzen — verhindert Memory-Exhaustion
      // (weniger als spawnBwDefault's 500-Byte-Limit, aber für Prompt-Detection ausreichend)
      if (outputBuf.length < 2000) {
        outputBuf += data;
      }

      // New-Device-OTP-Prompt erkannt?
      if (!otpWritten && isNewDevicePrompt(outputBuf)) {
        if (emailOtp) {
          // AC7: OTP via PTY-Write — NICHT als Arg; NICHT geloggt
          otpWritten = true;
          // PTY echot den geschriebenen Text zurück → outputBuf enthält danach den OTP-Code.
          // AC7-KRITISCH: outputBuf NIEMALS loggen nach diesem Punkt.
          ptyProcess.write(emailOtp + '\r');
        }
        // Kein emailOtp → kein Write → bw läuft weiter bis Timeout oder Exit
        // → classifyBwError erkennt New-Device-Muster im outputBuf → 'email-otp-required'
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      // Session-Token ist die letzte non-empty Zeile des PTY-Outputs.
      // bw login --raw schreibt nur den Token auf stdout (eine Zeile).
      // Im PTY-Output sind ANSI-Sequenzen und Prompt-Texte enthalten;
      // der Token ist typischerweise die letzte nicht-leere Zeile nach dem letzten Prompt.
      // Wir extrahieren ihn aus dem rohen Output-Buffer.
      const sessionToken = extractSessionToken(outputBuf);

      settle({
        stdout: sessionToken,
        output: outputBuf, // intern für classifyBwError — NIEMALS nach außen
        exitCode: exitCode ?? 1,
      });
    });
  });
}

// ── Two-Phase-PTY-Session-Implementierung (single-process OTP-Fluss, AC10/AC11) ────

/**
 * Führt `bw login <args>` via node-pty in einem zwei-phasigen, langlebigen Prozess aus.
 *
 * Phase 1 (kein emailOtp): PTY startet und läuft bis zum New-Device-Prompt oder Login-Ende.
 *   - Kein OTP-Prompt: resolves { phase: 'done', stdout, output, exitCode }
 *   - OTP-Prompt erkannt: resolves { phase: 'awaiting-otp', writeOtp, cleanup }
 *     → PTY-Prozess bleibt OFFEN; writeOtp() schreibt OTP + wartet auf PTY-Exit.
 *     → cleanup() beendet den Prozess ohne OTP-Einreichung.
 *
 * Phase 2 (via writeOtp(code)):
 *   - Schreibt den OTP-Code in denselben offenen PTY-Prozess.
 *   - Resolves { stdout, output, exitCode } nach PTY-Exit.
 *
 * Security:
 *   - PTY-Output (outputBuf) wird NIEMALS geloggt — enthält echoed Eingaben.
 *   - writeOtp() übergibt den Code per PTY-Write — NICHT als Arg (AC7).
 *   - cleanup() ist idempotent (AC11).
 *
 * AC10: Es gibt genau einen ptySpawn-Aufruf für den gesamten OTP-Zyklus.
 * AC11: Timeout + sauberes Kill in der aufrufenden Schicht (#cleanupPtySession).
 *
 * @param {string[]} args  - Login-Argumente (ohne 'bw'); dürfen KEINE Geheimnisse enthalten
 * @param {object}   env   - Env-Vars des Subprozesses (enthält BW_PASSWORD)
 * @returns {Promise<
 *   | { phase: 'done', stdout: string, output: string, exitCode: number }
 *   | { phase: 'awaiting-otp', writeOtp(code: string): Promise<{ stdout: string, output: string, exitCode: number }>, cleanup(): void }
 * >}
 */
async function spawnBwPtySessionDefault(args, env) {
  const { spawn: ptySpawn } = await import('node-pty');

  // ── Phase-1-Promise: resolves wenn OTP-Prompt erkannt ODER Prozess beendet ──
  return new Promise((resolvePhase1) => {
    let ptyProcess = null;
    let outputBuf = '';   // AC7-KRITISCH: NIEMALS loggen — kann echoed OTP/Passwort enthalten
    let phase1Settled = false;

    // Phase-2-Resolver: gesetzt wenn OTP-Prompt erkannt; resolves nach PTY-Exit
    let phase2Resolve = null;

    /**
     * Beendet den PTY-Prozess sauber (idempotent, AC11).
     */
    function killPty() {
      try {
        ptyProcess?.kill();
      } catch {
        // Prozess möglicherweise bereits beendet
      }
    }

    /**
     * Phase-1-Auflösung: Login abgeschlossen ohne OTP-Prompt.
     * @param {{ stdout: string, output: string, exitCode: number }} result
     */
    function settlePhase1Done(result) {
      if (phase1Settled) return;
      phase1Settled = true;
      killPty();
      resolvePhase1({ phase: 'done', ...result });
    }

    /**
     * Phase-1-Auflösung: OTP-Prompt erkannt, PTY offen halten.
     * Gibt writeOtp + cleanup zurück — PTY läuft weiter.
     */
    function settlePhase1AwaitingOtp() {
      if (phase1Settled) return;
      phase1Settled = true;

      /**
       * Phase 2: OTP in denselben PTY schreiben (AC10 — kein neuer Spawn).
       * AC7: code via PTY-Write — NICHT als Arg.
       * @param {string} code - E-Mail-OTP-Code (nach Gebrauch verworfen)
       * @returns {Promise<{ stdout: string, output: string, exitCode: number }>}
       */
      const writeOtp = (code) => new Promise((resolve, reject) => {
        phase2Resolve = resolve;
        try {
          // AC7: OTP via PTY-Write — NIEMALS als Arg/Env/Log
          ptyProcess.write(code + '\r');
        } catch (err) {
          phase2Resolve = null; // Zustands-Konsistenz: kein No-op-Resolve bei späterem onExit
          reject(err);
        }
      });

      /**
       * Prozess ohne OTP-Einreichung beenden (Timeout/Abbruch, AC11).
       * Idempotent.
       */
      const cleanup = () => {
        killPty();
        // Falls phase2 auf Antwort wartet: nie auflösen (GC-safe, da handle aus Map entfernt)
      };

      resolvePhase1({ phase: 'awaiting-otp', writeOtp, cleanup });
    }

    let spawnError = null;
    try {
      ptyProcess = ptySpawn('bw', args, {
        name: 'xterm',
        cols: 80,
        rows: 24,
        // AC6: Sauber isolierte Umgebung — nur übergebene env-Vars (kein Parent-Leak)
        env: { ...env },
      });
    } catch (err) {
      spawnError = err;
    }

    if (spawnError) {
      resolvePhase1({
        phase: 'done',
        stdout: '',
        output: spawnError.message ?? 'pty spawn error',
        exitCode: 127,
      });
      return;
    }

    // Phase-1-Timeout: verhindert dauerhaftes Hängenbleiben bei ausbleibendem Prompt
    const phase1TimeoutHandle = setTimeout(() => {
      // Nach Timeout: als 'done' mit exitCode=1 auflösen → classifyBwError greift
      settlePhase1Done({ stdout: '', output: outputBuf, exitCode: 1 });
    }, PTY_LOGIN_TIMEOUT_MS);

    // PTY-Output empfangen + auf New-Device-Prompt scannen
    // AC7-KRITISCH: outputBuf NICHT loggen (kann echoed OTP/Passwort enthalten)
    ptyProcess.onData((data) => {
      if (outputBuf.length < 4096) {
        outputBuf += data;
      }

      // New-Device-OTP-Prompt erkannt?
      if (!phase1Settled && isNewDevicePrompt(outputBuf)) {
        clearTimeout(phase1TimeoutHandle);
        settlePhase1AwaitingOtp();
        // PTY läuft weiter — Phase 2 wartet auf OTP-Write
        return;
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      clearTimeout(phase1TimeoutHandle);

      const sessionToken = extractSessionToken(outputBuf);
      const result = {
        stdout: sessionToken,
        output: outputBuf, // intern für classifyBwError — NIEMALS nach außen
        exitCode: exitCode ?? 1,
      };

      if (!phase1Settled) {
        // Phase 1 noch aktiv: Login ohne OTP-Prompt abgeschlossen
        settlePhase1Done(result);
      } else if (phase2Resolve) {
        // Phase 2 aktiv: OTP eingeschickt, Prozess beendet → Phase-2-Promise auflösen
        const p2Resolve = phase2Resolve;
        phase2Resolve = null;
        p2Resolve(result);
      }
      // Sonst: cleanup() wurde aufgerufen → phase2Resolve ist null → nichts zu tun
    });
  });
}

/**
 * Extrahiert den Session-Token aus dem PTY-Output von `bw login --raw`.
 *
 * bw login --raw schreibt den Session-Token als letzte Textzeile (nach allen Prompts).
 * Im PTY-Output sind ANSI-Escape-Sequenzen und Prompt-Texte enthalten.
 * Der Token besteht aus Base64-URL-sicheren Zeichen — typischerweise 100–200 Zeichen lang.
 *
 * Strategie: alle Zeilen durchsuchen, die wie ein Bitwarden-Session-Token aussehen.
 * Bitwarden-Session-Tokens sind Base64-kodierte JWTs oder ähnliche Strings.
 * Mindestlänge: 32 Zeichen (kurze Tokens sind kein Session-Token).
 *
 * AC7-KRITISCH: Diese Funktion gibt NUR den Token zurück — nie den gesamt-Output.
 *
 * @param {string} rawOutput - Roher PTY-Output (NICHT loggen)
 * @returns {string} Session-Token oder leerer String
 */
function extractSessionToken(rawOutput) {
  // ANSI-Escape-Sequenzen entfernen (PTY-Output enthält Cursor-Steuerung etc.)
  // eslint-disable-next-line no-control-regex
  const stripped = rawOutput.replace(/\x1b\[[0-9;]*[mGKHFABCDEJhlr]/g, '').replace(/\r/g, '');

  // Zeilen von hinten durchsuchen — Token ist die letzte relevante Zeile
  const lines = stripped.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // Session-Token: mindestens 32 Zeichen, nur Base64/URL-sichere Zeichen + Punkte (JWT)
    // Kein Leerzeichen, keine ANSI-Reste, keine Prompt-Texte
    if (line.length >= 32 && /^[A-Za-z0-9+/=._-]+$/.test(line)) {
      return line;
    }
  }
  return '';
}
