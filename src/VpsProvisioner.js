/**
 * VpsProvisioner — einziger Ort für SSH-Verbindungen zum VPS (ADR-008).
 *
 * Trägt einen hinterlegten Public-Key idempotent in `authorized_keys` eines VPS-Ziels ein.
 * Private-Key stammt store-intern aus dem CredentialStore — Klartext verlässt den Store
 * NIEMALS Richtung HTTP/Log/Audit.
 *
 * Transport: Node-Lib `ssh2` (kein Shell-Out, kein System-ssh-Binary erforderlich).
 * Begründung: Das Container-Image enthält KEINEN openssh-client (nur openssl, curl, git, jq).
 * `ssh2` ist self-contained, mockbar und provider-unabhängig.
 *
 * Host-Key-Verifikation (Policy — dokumentiert, kein stilles Ignorieren):
 *   Der SSH-Host-Key wird per SHA256-Fingerprint (Base64, wie ssh-keygen -l) geprüft,
 *   wenn `hostFingerprint` im Provision-Request übergeben wird.
 *   Ohne `hostFingerprint` wird der Hash im Audit-Eintrag geloggt (nicht geheim) und die
 *   Verbindung akzeptiert (TOFU-ähnlich). Dies ist für den ersten Connect vertretbar, wenn
 *   der Nutzer den Host kennt und die Verbindung identitäts-/rollengeschützt ist (AC10).
 *   Empfehlung: `hostFingerprint` im Provision-Request mitgeben für strenge Verifikation.
 *
 * Fehlerkategorien (für sinnvolles HTTP-Mapping im Router):
 *   - 'no-public-key'      → 422 (kein Public-Key für diesen Benutzer gesetzt)
 *   - 'no-private-key'     → 422 (kein Private-Key für diesen Benutzer gesetzt)
 *   - 'unreachable'        → 502 (Verbindung zum VPS fehlgeschlagen oder Timeout)
 *   - 'auth-failed'        → 502 (SSH-Auth mit hinterlegtem Key geschlagen)
 *   - 'host-key-mismatch'  → 502 (Host-Key-Fingerprint stimmt nicht überein)
 *   - 'error'              → 500 (unerwarteter Fehler)
 *
 * @module VpsProvisioner
 */

import { Client } from 'ssh2';
import { createHash } from 'node:crypto';

/** SSH-Verbindungs-Timeout in ms. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * @typedef {object} VpsTarget
 * @property {string}  host        - Hostname oder IP-Adresse des VPS
 * @property {number}  [port]      - SSH-Port (Default: 22)
 * @property {string}  targetUser  - Benutzer auf dem VPS (z.B. "root", "alex")
 */

/**
 * @typedef {object} ProvisionResult
 * @property {'added'|'already-present'|'error'} result
 * @property {string}  [reason]      - Fehlergrund ohne Geheim-Leak
 * @property {string}  [errorClass]  - Maschinenlesbare Fehlerklasse
 * @property {string}  [hostKeyHash] - SHA256-Fingerprint des Host-Keys (für Audit, nicht geheim)
 */

export class VpsProvisioner {
  /** @type {import('./CredentialStore.js').CredentialStore} */
  #credentialStore;

  /**
   * @param {import('./CredentialStore.js').CredentialStore} credentialStore
   */
  constructor(credentialStore) {
    if (!credentialStore || typeof credentialStore.getPublicKey !== 'function') {
      throw new Error('[VpsProvisioner] credentialStore ist Pflicht');
    }
    this.#credentialStore = credentialStore;
  }

  /**
   * Provisioniert den Public-Key eines SSH-Benutzers idempotent in `authorized_keys`
   * auf dem angegebenen VPS-Ziel.
   *
   * Nebenläufigkeit (S4 — bewusster Trade-off):
   *   Kein Mutex. Gleichzeitige Provisions desselben Keys können im Extremfall eine
   *   Duplikat-Zeile in authorized_keys erzeugen (race zwischen grep und append).
   *   Dies ist harmlos: ssh akzeptiert Duplikate, und der nächste idempotente Lauf
   *   erkennt den Key als "already-present". Für ein 1–2-Nutzer-Tool vertretbar.
   *
   * @param {string}    sshUser    - SSH-Benutzer-Label im CredentialStore (z.B. "root")
   * @param {VpsTarget} target     - VPS-Ziel mit host, port?, targetUser
   * @param {object}    [opts]
   * @param {string}    [opts.hostFingerprint] - Erwarteter SHA256-Fingerprint (Base64, ohne "SHA256:" Prefix)
   * @param {Function}  [opts._sshClientFactory] - Testbare SSH-Client-Fabrik (für Unit-Tests)
   * @returns {Promise<ProvisionResult>}
   */
  async provision(sshUser, target, opts = {}) {
    // ── 1. Public-Key laden (Klartext — nicht geheim) ──────────────────────────
    let publicKey;
    try {
      publicKey = await this.#credentialStore.getPublicKey(sshUser);
    } catch {
      return {
        result: 'error',
        reason: 'Public-Key-Store nicht lesbar',
        errorClass: 'error',
      };
    }

    if (!publicKey) {
      return {
        result: 'error',
        reason: `Kein Public-Key für Benutzer "${sshUser}" hinterlegt`,
        errorClass: 'no-public-key',
      };
    }

    // ── 2. Private-Key laden (store-intern — verlässt Store nie Richtung HTTP/Log) ─
    let privateKey;
    try {
      privateKey = await this.#credentialStore.getPlaintext(`ssh/${sshUser}/private_key`);
    } catch {
      return {
        result: 'error',
        reason: 'Private-Key-Store nicht lesbar',
        errorClass: 'error',
      };
    }

    if (!privateKey) {
      return {
        result: 'error',
        reason: `Kein Private-Key für Benutzer "${sshUser}" hinterlegt`,
        errorClass: 'no-private-key',
      };
    }

    // ── 3. SSH-Verbindung aufbauen + idempotent authorized_keys schreiben ──────
    const port = target.port ?? 22;
    const sshClientFactory = opts._sshClientFactory ?? (() => new Client());
    const hostFingerprint = opts.hostFingerprint ?? null;

    let hostKeyHashForAudit = null;

    try {
      const provisionResult = await connectAndProvision({
        publicKey,
        privateKey,
        host: target.host,
        port,
        targetUser: target.targetUser,
        hostFingerprint,
        sshClientFactory,
        onHostKey: (hash) => { hostKeyHashForAudit = hash; },
      });

      return {
        ...provisionResult,
        ...(hostKeyHashForAudit ? { hostKeyHash: hostKeyHashForAudit } : {}),
      };
    } catch (err) {
      const errorClass = classifyError(err);
      return {
        result: 'error',
        reason: sanitizeErrorReason(errorClass),
        errorClass,
        ...(hostKeyHashForAudit ? { hostKeyHash: hostKeyHashForAudit } : {}),
      };
    } finally {
      // Private-Key-Klartext wird durch den GC bereinigt — lokale Variable läuft hier aus dem Scope
    }
  }
}

// ── SSH-Connect + Provision (module-private) ───────────────────────────────────

/**
 * Baut eine SSH-Verbindung auf und schreibt den Public-Key idempotent in authorized_keys.
 *
 * Shell-Logik auf dem Server (atomar, keine Teil-Zustände):
 *   1. .ssh-Verzeichnis anlegen (mkdir -p, chmod 700)
 *   2. authorized_keys anlegen wenn nicht vorhanden (touch, chmod 600)
 *   3. Key per grep prüfen (exakter Match)
 *   4. Wenn nicht vorhanden: >> append
 *
 * Sicherheits-Hinweis: publicKey wird per Single-Quote-Escaped in die Shell-Command-Line
 * eingebettet — Newline-Injection wurde bereits beim PUT verhindert (sshKeysRouter AC4).
 *
 * @param {object} params
 * @returns {Promise<ProvisionResult>}
 */
function connectAndProvision(params) {
  const {
    publicKey, privateKey, host, port, targetUser,
    hostFingerprint, sshClientFactory, onHostKey,
  } = params;

  const sshDir = targetUser === 'root' ? '/root/.ssh' : `/home/${targetUser}/.ssh`;
  const akFile = `${sshDir}/authorized_keys`;

  // Single-Quote-Escaping: ' → '\''
  const pubKeyEscaped = publicKey.replace(/'/g, "'\\''");

  // Shell-Skript: idempotenter append via stdin (bash -s)
  const script = [
    'set -e',
    `SSH_DIR='${sshDir}'`,
    `AK_FILE='${akFile}'`,
    'mkdir -p "$SSH_DIR"',
    'chmod 700 "$SSH_DIR"',
    'touch "$AK_FILE"',
    'chmod 600 "$AK_FILE"',
    `if grep -qF '${pubKeyEscaped}' "$AK_FILE"; then`,
    '  echo "already-present"',
    'else',
    `  echo '${pubKeyEscaped}' >> "$AK_FILE"`,
    '  echo "added"',
    'fi',
  ].join('\n');

  return new Promise((resolve, reject) => {
    const conn = sshClientFactory();
    let resolved = false;

    function safeReject(err) {
      if (!resolved) {
        resolved = true;
        try { conn.end(); } catch { /* ignore */ }
        reject(err);
      }
    }

    const connectTimeout = setTimeout(() => {
      const err = new Error('SSH-Verbindungs-Timeout');
      err.code = 'ETIMEDOUT';
      safeReject(err);
    }, CONNECT_TIMEOUT_MS);

    conn.on('ready', () => {
      clearTimeout(connectTimeout);

      conn.exec('bash -s', { pty: false }, (execErr, stream) => {
        if (execErr) {
          safeReject(execErr);
          return;
        }

        let stdout = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', () => { /* stderr consumed but not propagated to avoid info leak */ });

        stream.on('close', (code) => {
          if (resolved) return;
          resolved = true;
          try { conn.end(); } catch { /* ignore */ }

          if (code !== 0) {
            const err = new Error(`Remote-Skript fehlgeschlagen (exit ${code})`);
            err.code = 'EXEC_FAILED';
            reject(err);
            return;
          }

          const output = stdout.trim();
          if (output === 'added' || output === 'already-present') {
            resolve({ result: output });
          } else {
            const err = new Error('Unerwartete Skript-Ausgabe');
            err.code = 'EXEC_FAILED';
            reject(err);
          }
        });

        // Skript über stdin übergeben
        stream.stdin.write(script);
        stream.stdin.end();
      });
    });

    conn.on('error', (err) => {
      clearTimeout(connectTimeout);
      safeReject(err);
    });

    // Host-Key-Verifikation (synchron — ssh2 erwartet sync return)
    const hostVerifier = (key) => {
      let hash = null;
      try {
        hash = createHash('sha256').update(key).digest('base64');
      } catch {
        // Fingerprint-Berechnung nicht kritisch — Verbindung trotzdem prüfen
      }

      if (hash) onHostKey(hash);

      if (hostFingerprint) {
        if (hash === hostFingerprint) {
          return true;
        }
        // Fingerprint-Mismatch → Verbindung ablehnen
        const fpErr = new Error('SSH-Host-Key-Fingerprint stimmt nicht überein (möglicher MITM)');
        fpErr.code = 'HOST_KEY_MISMATCH';
        // Wir müssen reject aufrufen, da ssh2 hostVerifier keine async-Fehler propagiert
        setTimeout(() => safeReject(fpErr), 0);
        return false;
      }

      // TOFU: kein Fingerprint konfiguriert → akzeptieren (Hash im Audit geloggt)
      return true;
    };

    conn.connect({
      host,
      port,
      username: targetUser,
      privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier,
    });
  });
}

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

/**
 * Klassifiziert einen SSH-Fehler in eine maschinenlesbare Kategorie.
 * Geheimnis-frei: analysiert nur Code + Nachrichtentext.
 *
 * @param {Error} err
 * @returns {string}
 */
function classifyError(err) {
  const msg = (err.message ?? '').toLowerCase();
  const code = err.code ?? '';

  if (code === 'HOST_KEY_MISMATCH') return 'host-key-mismatch';
  if (code === 'ETIMEDOUT' || msg.includes('timeout') || msg.includes('timed out')) return 'unreachable';
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNRESET'
  ) return 'unreachable';
  if (
    msg.includes('authentication') ||
    msg.includes('auth') ||
    msg.includes('permission denied') ||
    msg.includes('publickey')
  ) return 'auth-failed';
  if (msg.includes('handshake') || msg.includes('key exchange')) return 'unreachable';
  return 'error';
}

/**
 * Gibt einen sicheren Fehlergrund zurück ohne Geheim-Leak.
 * Private-Key, Passphrasen etc. erscheinen NICHT im reason.
 *
 * @param {string} errorClass
 * @returns {string}
 */
function sanitizeErrorReason(errorClass) {
  switch (errorClass) {
    case 'unreachable':
      return 'VPS-Ziel nicht erreichbar (Verbindung fehlgeschlagen oder Timeout)';
    case 'auth-failed':
      return 'SSH-Authentifizierung fehlgeschlagen (Private-Key abgelehnt oder Benutzer nicht gefunden)';
    case 'host-key-mismatch':
      return 'SSH-Host-Key-Fingerprint stimmt nicht mit dem erwarteten Wert überein';
    default:
      return 'Provisionierung fehlgeschlagen (unerwarteter Fehler)';
  }
}
