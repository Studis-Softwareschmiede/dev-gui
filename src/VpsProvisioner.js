/**
 * VpsProvisioner — einziger Ort für SSH-Verbindungen zum VPS (ADR-008).
 *
 * Trägt einen hinterlegten Public-Key idempotent in `authorized_keys` eines VPS-Ziels ein,
 * entfernt einen bestimmten Public-Key aus `authorized_keys` (Key-Rotation) und testet
 * eine SSH-Verbindung mit einem angegebenen Private-Key (Verbindungstest vor Rotation).
 * Private-Key stammt store-intern aus dem CredentialStore — Klartext verlässt den Store
 * NIEMALS Richtung HTTP/Log/Audit.
 *
 * Transport: Node-Lib `ssh2` (kein Shell-Out, kein System-ssh-Binary erforderlich).
 * Begründung: Das Container-Image enthält KEINEN openssh-client (nur openssl, curl, git, jq).
 * `ssh2` ist self-contained, mockbar und provider-unabhängig.
 *
 * Host-Key-Verifikation (Policy — dokumentiert, kein stilles Ignorieren):
 *   Der SSH-Host-Key wird per SHA256-Fingerprint (Base64, wie ssh-keygen -l) geprüft,
 *   wenn `hostFingerprint` im Request übergeben wird.
 *   Ohne `hostFingerprint` wird der Hash im Audit-Eintrag geloggt (nicht geheim) und die
 *   Verbindung akzeptiert (TOFU-ähnlich). Dies ist für den ersten Connect vertretbar, wenn
 *   der Nutzer den Host kennt und die Verbindung identitäts-/rollengeschützt ist (AC10).
 *   Empfehlung: `hostFingerprint` mitgeben für strenge Verifikation.
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

/**
 * @typedef {object} RemoveKeyResult
 * @property {'removed'|'already-absent'|'error'} result
 * @property {string}  [reason]      - Fehlergrund ohne Geheim-Leak
 * @property {string}  [errorClass]  - Maschinenlesbare Fehlerklasse
 * @property {string}  [hostKeyHash] - SHA256-Fingerprint des Host-Keys (für Audit, nicht geheim)
 */

/**
 * @typedef {object} TestConnectionResult
 * @property {boolean} ok
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
   * Trägt einen Public-Key idempotent in `authorized_keys` auf dem VPS-Ziel ein.
   * Key-als-Argument-Variante (ADR-008-Erweiterung): nimmt `publicKey` und `privateKey`
   * direkt als Argument entgegen, zieht sie NICHT aus dem Store.
   * Wird von #118 (Rotation-Orchestrierung) genutzt, da dort neuer und alter Key
   * gleichzeitig benötigt werden.
   *
   * @param {object}  params
   * @param {string}  params.host
   * @param {number}  [params.port]
   * @param {string}  params.targetUser
   * @param {string}  params.publicKey       - Public-Key-Klartext (nicht geheim)
   * @param {string}  params.privateKey      - Private-Key-Klartext (store-intern, niemals loggen)
   * @param {string}  [params.hostFingerprint]
   * @param {Function} [params._sshClientFactory] - Testbare SSH-Client-Fabrik
   * @returns {Promise<ProvisionResult>}
   */
  async addAuthorizedKey(params) {
    const {
      host, targetUser, publicKey, privateKey,
      port: rawPort, hostFingerprint = null,
      _sshClientFactory,
    } = params;

    const port = rawPort ?? 22;
    const sshClientFactory = _sshClientFactory ?? (() => new Client());

    let hostKeyHashForAudit = null;

    try {
      const provisionResult = await connectAndProvision({
        publicKey,
        privateKey,
        host,
        port,
        targetUser,
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
    }
  }

  /**
   * Entfernt einen bestimmten Public-Key aus `authorized_keys` auf dem VPS-Ziel.
   * Matching über den normalisierten Key-Blob (type, base64) — Kommentar und Options-Prefix
   * werden ignoriert (ADR-008-Erweiterung, data-model.md SshPublicKey-Matching).
   * Entfernt ALLE Zeilen mit passendem Blob (Duplikat-tolerant).
   * Lässt jede andere Zeile bytegenau stehen.
   * Schreibt authorized_keys atomar (Tempfile + chmod 600 + mv).
   * Idempotent: Blob nicht vorhanden → result:"already-absent", kein Fehler.
   * Fail-closed: kann die Datei nicht zuverlässig gelesen/gefiltert/geschrieben werden → result:"error".
   *
   * @param {object}  params
   * @param {string}  params.host
   * @param {number}  [params.port]
   * @param {string}  params.targetUser
   * @param {string}  params.publicKey       - Public-Key zum Entfernen (nicht geheim)
   * @param {string}  params.privateKey      - Private-Key für die SSH-Verbindung (store-intern, niemals loggen)
   * @param {string}  [params.hostFingerprint]
   * @param {Function} [params._sshClientFactory] - Testbare SSH-Client-Fabrik
   * @returns {Promise<RemoveKeyResult>}
   */
  async removeAuthorizedKey(params) {
    const {
      host, targetUser, publicKey, privateKey,
      port: rawPort, hostFingerprint = null,
      _sshClientFactory,
    } = params;

    const port = rawPort ?? 22;
    const sshClientFactory = _sshClientFactory ?? (() => new Client());

    // Extrahiere (type, blob) aus dem übergebenen publicKey
    const keyIdentity = extractKeyIdentity(publicKey);
    if (!keyIdentity) {
      return {
        result: 'error',
        reason: 'Ungültiges Public-Key-Format — (type, blob) nicht extrahierbar',
        errorClass: 'error',
      };
    }

    let hostKeyHashForAudit = null;

    try {
      const removeResult = await connectAndRemoveKey({
        keyIdentity,
        privateKey,
        host,
        port,
        targetUser,
        hostFingerprint,
        sshClientFactory,
        onHostKey: (hash) => { hostKeyHashForAudit = hash; },
      });

      return {
        ...removeResult,
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
    }
  }

  /**
   * Testet eine SSH-Verbindung mit dem angegebenen Private-Key.
   * ok:true NUR bei erfolgreichem Auth-Handshake (ready) UND `true`-Kommando exit 0.
   * Jeder andere Ausgang → ok:false (kein false-positive).
   * Kein Schreibzugriff, keine Mutation der Ziel-Datei.
   * privateKey verlässt das Backend NIEMALS Richtung Response/Log/Audit/WS.
   *
   * @param {object}  params
   * @param {string}  params.host
   * @param {number}  [params.port]
   * @param {string}  params.targetUser
   * @param {string}  params.privateKey      - Private-Key-Klartext (store-intern, niemals loggen)
   * @param {string}  [params.hostFingerprint]
   * @param {Function} [params._sshClientFactory] - Testbare SSH-Client-Fabrik
   * @returns {Promise<TestConnectionResult>}
   */
  async testConnection(params) {
    const {
      host, targetUser, privateKey,
      port: rawPort, hostFingerprint = null,
      _sshClientFactory,
    } = params;

    const port = rawPort ?? 22;
    const sshClientFactory = _sshClientFactory ?? (() => new Client());

    let hostKeyHashForAudit = null;

    try {
      const testResult = await connectAndTest({
        privateKey,
        host,
        port,
        targetUser,
        hostFingerprint,
        sshClientFactory,
        onHostKey: (hash) => { hostKeyHashForAudit = hash; },
      });

      return {
        ...testResult,
        ...(hostKeyHashForAudit ? { hostKeyHash: hostKeyHashForAudit } : {}),
      };
    } catch (err) {
      const errorClass = classifyError(err);
      return {
        ok: false,
        reason: sanitizeErrorReason(errorClass),
        errorClass,
        ...(hostKeyHashForAudit ? { hostKeyHash: hostKeyHashForAudit } : {}),
      };
    }
  }

  /**
   * Provisioniert den Public-Key eines SSH-Benutzers idempotent in `authorized_keys`
   * auf dem angegebenen VPS-Ziel.
   * Store-ziehende Variante (Rückwärtskompatibilität für die #47-Route).
   * Zieht Public-Key und Private-Key store-intern aus dem CredentialStore.
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

    // ── 3. Delegiere an key-als-Argument-Primitiv ─────────────────────────────
    return this.addAuthorizedKey({
      host: target.host,
      port: target.port,
      targetUser: target.targetUser,
      publicKey,
      privateKey,
      hostFingerprint: opts.hostFingerprint,
      _sshClientFactory: opts._sshClientFactory,
    });
  }
}

// ── SSH-Connect-Basis-Hilfsfunktion (module-private) ──────────────────────────

/**
 * Baut eine SSH-Verbindung auf und ruft onReady(conn, safeReject, done) auf.
 * Gemeinsamer Verbindungs-/Timeout-/Host-Key-Pfad für alle drei Primitive —
 * kein zweiter SSH-Pfad (ADR-008-Erweiterung, architecture/R08-1 + ADR-008/R01).
 *
 * @param {object}   params
 * @param {string}   params.privateKey
 * @param {string}   params.host
 * @param {number}   params.port
 * @param {string}   params.targetUser
 * @param {string|null} params.hostFingerprint
 * @param {Function} params.sshClientFactory
 * @param {Function} params.onHostKey         - Callback (hash: string) → void
 * @param {Function} params.onReady           - Callback (conn, safeReject, markDone) → void
 * @returns {Promise<void>}
 */
function sshConnect(params) {
  const {
    privateKey, host, port, targetUser,
    hostFingerprint, sshClientFactory, onHostKey, onReady,
  } = params;

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

    function markDone(value) {
      if (!resolved) {
        resolved = true;
        try { conn.end(); } catch { /* ignore */ }
        resolve(value);
      }
    }

    const connectTimeout = setTimeout(() => {
      const err = new Error('SSH-Verbindungs-Timeout');
      err.code = 'ETIMEDOUT';
      safeReject(err);
    }, CONNECT_TIMEOUT_MS);

    conn.on('ready', () => {
      clearTimeout(connectTimeout);
      onReady(conn, safeReject, markDone);
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

  return sshConnect({
    privateKey,
    host,
    port,
    targetUser,
    hostFingerprint,
    sshClientFactory,
    onHostKey,
    onReady(conn, safeReject, markDone) {
      conn.exec('bash -s', { pty: false }, (execErr, stream) => {
        if (execErr) {
          safeReject(execErr);
          return;
        }

        let stdout = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', () => { /* stderr consumed but not propagated to avoid info leak */ });

        stream.on('close', (code) => {
          if (code !== 0) {
            const err = new Error(`Remote-Skript fehlgeschlagen (exit ${code})`);
            err.code = 'EXEC_FAILED';
            safeReject(err);
            return;
          }

          const output = stdout.trim();
          if (output === 'added' || output === 'already-present') {
            markDone({ result: output });
          } else {
            const err = new Error('Unerwartete Skript-Ausgabe');
            err.code = 'EXEC_FAILED';
            safeReject(err);
          }
        });

        // Skript über stdin übergeben
        stream.stdin.write(script);
        stream.stdin.end();
      });
    },
  });
}

// ── SSH-Connect + Remove Key (module-private) ─────────────────────────────────

/**
 * Baut eine SSH-Verbindung auf und entfernt einen bestimmten Key aus authorized_keys.
 *
 * Shell-Logik auf dem Server (atomar, fail-closed):
 *   Liest authorized_keys, filtert alle Zeilen mit passendem (type, blob) heraus,
 *   schreibt die gefilterte Datei atomar über ein Tempfile (chmod 600 + mv).
 *   KEIN in-place sed (nicht atomar, Regex-Injection-Risiko, adv. kein openssh-client).
 *
 * Matching: Zeile wird in Tokens aufgeteilt; das erste Token das mit 'ssh-' oder
 * 'ecdsa-' beginnt ist der type, das nächste der blob. Options-Prefix und Kommentar
 * werden ignoriert (data-model.md SshPublicKey-Matching).
 *
 * @param {object} params
 * @returns {Promise<RemoveKeyResult>}
 */
function connectAndRemoveKey(params) {
  const {
    keyIdentity, privateKey, host, port, targetUser,
    hostFingerprint, sshClientFactory, onHostKey,
  } = params;

  const sshDir = targetUser === 'root' ? '/root/.ssh' : `/home/${targetUser}/.ssh`;
  const akFile = `${sshDir}/authorized_keys`;

  // Single-Quote-Escaping für type und blob
  const typeEscaped = keyIdentity.type.replace(/'/g, "'\\''");
  const blobEscaped = keyIdentity.blob.replace(/'/g, "'\\''");

  // Shell-Skript: liest authorized_keys, filtert Blob-Matches, schreibt atomar
  // Das Skript:
  //   1. Gibt "already-absent" aus wenn authorized_keys nicht existiert
  //   2. Filtert alle Zeilen, deren (type, blob) dem Ziel entspricht
  //   3. Wenn keine Zeile entfernt wurde → "already-absent" (TMP verwerfen, Originaldatei unangetastet)
  //   4. Sonst: atomar über Tempfile schreiben (chmod 600, mv) → "removed"
  //   set -e: jeder Fehler bricht das Skript ab (fail-closed)
  //
  // Signal-Mechanik: awk zählt entfernte Zeilen intern und signalisiert das Ergebnis
  //   über seinen Exit-Code (END { exit (removed > 0 ? 0 : 1) }).
  //   Die Shell-Bedingung "if awk ...; then" ist unter set -e sicher (non-zero in if-Bedingung
  //   löst kein set-e-Abbruch aus). Dadurch entfällt der frühere wc-c-Byte-Vergleich, der bei
  //   Dateien ohne trailing newline einen Off-by-One-Fehler hatte (awk ORS hängt \n an).
  //
  //   Hinweis trailing newline: awk's print fügt ORS (\n) an jede Ausgabezeile an. Wenn die
  //   Originaldatei kein trailing newline hatte und Zeilen übrig bleiben, erhält die
  //   zurückgeschriebene Datei ein abschließendes \n. Das ist OpenSSH-konform (authorized_keys
  //   erlaubt trailing newlines) und im Einklang mit der Spec (bytegenau bedeutet hier: alle
  //   anderen Keys erhalten, kein Inhalt verändert — ein hinzugefügtes \n ist akzeptiert).
  const script = [
    'set -e',
    `AK_FILE='${akFile}'`,
    `KEY_TYPE='${typeEscaped}'`,
    `KEY_BLOB='${blobEscaped}'`,
    // Wenn Datei nicht existiert → already-absent
    'if [ ! -f "$AK_FILE" ]; then echo "already-absent"; exit 0; fi',
    // Temporäre Datei im selben Verzeichnis (atomares mv)
    `TMP_FILE='${akFile}.tmp.$$'`,
    // Filterlogik: Token-basiertes Matching (ignoriert Options-Prefix und Kommentar)
    // awk zählt entfernte Zeilen in `removed`; END gibt Exit-Code 0 (≥1 entfernt) oder 1 (nichts entfernt).
    // "if awk ...; then" ist unter set -e sicher — non-zero in einer if-Bedingung löst keinen Abbruch aus.
    'if awk -v type="$KEY_TYPE" -v blob="$KEY_BLOB" \'',
    '{',
    '  found = 0',
    '  for (i = 1; i <= NF; i++) {',
    '    if ($i == type && $(i+1) == blob) { found = 1; break }',
    '  }',
    '  if (found) { removed++ } else { print }',
    '}',
    'END { exit (removed > 0 ? 0 : 1) }',
    '\' "$AK_FILE" > "$TMP_FILE"; then',
    // awk exit 0 → mindestens eine Zeile entfernt → atomar ersetzen
    '  chmod 600 "$TMP_FILE"',
    '  mv "$TMP_FILE" "$AK_FILE"',
    '  echo "removed"',
    'else',
    // awk exit 1 → kein Match → TMP verwerfen, Originaldatei unangetastet
    '  rm -f "$TMP_FILE"',
    '  echo "already-absent"',
    'fi',
  ].join('\n');

  return sshConnect({
    privateKey,
    host,
    port,
    targetUser,
    hostFingerprint,
    sshClientFactory,
    onHostKey,
    onReady(conn, safeReject, markDone) {
      conn.exec('bash -s', { pty: false }, (execErr, stream) => {
        if (execErr) {
          safeReject(execErr);
          return;
        }

        let stdout = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', () => { /* stderr consumed but not propagated to avoid info leak */ });

        stream.on('close', (code) => {
          if (code !== 0) {
            const err = new Error(`Remote-Skript fehlgeschlagen (exit ${code})`);
            err.code = 'EXEC_FAILED';
            safeReject(err);
            return;
          }

          const output = stdout.trim();
          if (output === 'removed' || output === 'already-absent') {
            markDone({ result: output });
          } else {
            const err = new Error('Unerwartete Skript-Ausgabe');
            err.code = 'EXEC_FAILED';
            safeReject(err);
          }
        });

        stream.stdin.write(script);
        stream.stdin.end();
      });
    },
  });
}

// ── SSH-Connect + Test Connection (module-private) ────────────────────────────

/**
 * Baut eine SSH-Verbindung auf und prüft ob Auth + `true`-Kommando erfolgreich ist.
 * ok:true NUR bei ready (Auth ok) UND exit 0 des `true`-Befehls.
 * Keine Schreiboperation, keine Mutation.
 *
 * @param {object} params
 * @returns {Promise<TestConnectionResult>}
 */
function connectAndTest(params) {
  const {
    privateKey, host, port, targetUser,
    hostFingerprint, sshClientFactory, onHostKey,
  } = params;

  return sshConnect({
    privateKey,
    host,
    port,
    targetUser,
    hostFingerprint,
    sshClientFactory,
    onHostKey,
    onReady(conn, safeReject, markDone) {
      // Auth war erfolgreich (ready feuert nach erfolgreichem Handshake).
      // Zusätzlich: `true`-Kommando ausführen und auf exit 0 prüfen (Absicherung gegen
      // Auth-Akzeptanz-ohne-Shell-Zugang, ADR-008-Erweiterung Option-Achse 2).
      conn.exec('true', { pty: false }, (execErr, stream) => {
        if (execErr) {
          safeReject(execErr);
          return;
        }

        stream.on('data', () => { /* stdout ignorieren — nur exit code relevant */ });
        stream.stderr.on('data', () => { /* stderr consumed but not propagated */ });

        stream.on('close', (code) => {
          if (code === 0) {
            markDone({ ok: true });
          } else {
            // Non-zero exit → ok:false (kein false-positive, ADR-008-Erweiterung)
            markDone({ ok: false, reason: 'Verbindungstest-Kommando fehlgeschlagen', errorClass: 'error' });
          }
        });
      });
    },
  });
}

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

/**
 * Extrahiert die Key-Identität (type, blob) aus einem OpenSSH-Public-Key-String.
 * Ignoriert Options-Prefix und Kommentar (data-model.md SshPublicKey-Matching).
 * Sucht das erste Token das mit 'ssh-' oder 'ecdsa-' beginnt als type,
 * das folgende Token als blob.
 *
 * @param {string} publicKey
 * @returns {{ type: string, blob: string }|null}
 */
function extractKeyIdentity(publicKey) {
  if (!publicKey || typeof publicKey !== 'string') return null;

  const tokens = publicKey.trim().split(/\s+/);

  // Suche das erste Token, das ein bekanntes SSH-Key-Type-Präfix hat
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (
      t.startsWith('ssh-') ||
      t.startsWith('ecdsa-') ||
      t.startsWith('sk-ssh-') ||
      t.startsWith('sk-ecdsa-')
    ) {
      const blob = tokens[i + 1];
      if (blob && blob.length > 0) {
        return { type: t, blob };
      }
    }
  }

  return null;
}

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
