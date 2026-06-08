/**
 * VpsDockerControl — einziger Ort für schreibende Docker-Kommandos auf einem VPS via SSH.
 *
 * Boundary-Vertrag (ADR-012):
 *   - Einziger Modul, der `docker pull/run/rm` auf einem VPS via SSH ausführt.
 *   - Read-only-Docker bleibt lokal beim `DockerReader`.
 *   - SSH-Verbindung + Private-Key store-intern über die VpsProvisioner-SSH-Linie (ADR-008).
 *   - Kein Secret (Private-Key, Token) in Argv/Log/Audit/Response.
 *
 * Methoden:
 *   - pull(vps, image)         — docker pull auf dem VPS
 *   - run(vps, image, hostname, opts?) — docker run mit Bindungs-Label + --restart unless-stopped
 *   - rm(vps, containerId)     — docker rm -f auf dem VPS
 *   - ps(vps)                  — laufende Container mit cloudflare.tunnel-hostname-Label
 *
 * SSH-Transport: ssh2 (analog VpsProvisioner — kein System-ssh binary nötig).
 *
 * Host-Port-Konvention (O3-Empfehlung, preview-Konvention):
 *   Erste freie ab 8080. Für `run()`: der Aufrufer kann den Host-Port explizit übergeben
 *   (opts.hostPort), andernfalls wird 8080 verwendet (Konvention für Erst-Deploy).
 *   Die Port-Auflösung (freier Port finden) ist Aufgabe des Aufrufers (DeployOrchestrator),
 *   der `ps()` auswertet, um einen freien Port zu wählen.
 *
 * Container-Port-Konvention: 8080 (App-Container-Port-Konvention; überschreibbar via opts.containerPort).
 *
 * Fehlerkategorien (maschinenlesbar, analog VpsProvisioner):
 *   - 'no-private-key'    → 422 (kein Private-Key für SSH-Benutzer gesetzt)
 *   - 'unreachable'       → 502 (SSH-Verbindung fehlgeschlagen oder Timeout)
 *   - 'auth-failed'       → 502 (SSH-Auth fehlgeschlagen)
 *   - 'host-key-mismatch' → 502 (Host-Key-Fingerprint-Mismatch)
 *   - 'docker-failed'     → 502 (docker-Kommando fehlgeschlagen auf VPS)
 *   - 'error'             → 500 (unerwarteter Fehler)
 *
 * @module VpsDockerControl
 */

import { Client } from 'ssh2';

/** SSH-Verbindungs-Timeout in ms. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Docker exec-Timeout in ms (Pull kann lange dauern). */
const PULL_TIMEOUT_MS = 300_000; // 5 Minuten

/** Standard-Timeout für Nicht-Pull-Kommandos. */
const EXEC_TIMEOUT_MS = 30_000;

/** Default Container-Port (App-Konvention). */
const DEFAULT_CONTAINER_PORT = 8080;

/** Default Host-Port-Start (preview-Konvention). */
const DEFAULT_HOST_PORT_START = 8080;

/**
 * @typedef {object} VpsTarget
 * @property {string}  host        - Hostname oder IP-Adresse des VPS
 * @property {number}  [port]      - SSH-Port (Default: 22)
 * @property {string}  targetUser  - SSH-Benutzer (z.B. "root", "alex")
 */

/**
 * @typedef {object} RunResult
 * @property {'ok'|'error'} result
 * @property {string}  [containerId]   - Container-ID bei Erfolg
 * @property {string}  [hostPort]      - tatsächlich verwendeter Host-Port
 * @property {string}  [reason]        - Fehlergrund ohne Geheim-Leak
 * @property {string}  [errorClass]    - maschinenlesbare Fehlerklasse
 */

/**
 * @typedef {object} PsEntry
 * @property {string}  containerId     - Container-ID (kurz)
 * @property {string}  image           - Image-Name
 * @property {string}  hostname        - cloudflare.tunnel-hostname-Label-Wert
 * @property {string}  status          - Container-Status (z.B. "Up 2 hours")
 * @property {number|null} hostPort    - gemappter Host-Port (aus Port-Mapping)
 */

/**
 * @typedef {object} PsResult
 * @property {'ok'|'error'} result
 * @property {PsEntry[]}    [containers]  - laufende managed Container bei Erfolg
 * @property {string}       [reason]      - Fehlergrund ohne Geheim-Leak
 * @property {string}       [errorClass]  - maschinenlesbare Fehlerklasse
 */

export class VpsDockerControl {
  /** @type {import('../CredentialStore.js').CredentialStore} */
  #credentialStore;

  /**
   * @param {import('../CredentialStore.js').CredentialStore} credentialStore
   */
  constructor(credentialStore) {
    if (!credentialStore || typeof credentialStore.getPlaintext !== 'function') {
      throw new Error('[VpsDockerControl] credentialStore ist Pflicht');
    }
    this.#credentialStore = credentialStore;
  }

  /**
   * Pullt ein Docker-Image auf dem VPS.
   *
   * @param {VpsTarget} vps
   * @param {string}    image
   * @param {object}    [opts]
   * @param {Function}  [opts._sshClientFactory] - Testbare SSH-Client-Fabrik (für Unit-Tests)
   * @returns {Promise<{ result: 'ok'|'error', reason?: string, errorClass?: string }>}
   */
  async pull(vps, image, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    // Security: image-Name wird per Shell-Single-Quote-Escaping in den Befehl eingebettet
    const escapedImage = shellEscape(image);
    const cmd = `docker pull ${escapedImage}`;

    try {
      await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: PULL_TIMEOUT_MS,
        sshClientFactory: opts._sshClientFactory,
      });
      return { result: 'ok' };
    } catch (err) {
      const errorClass = classifyError(err);
      return {
        result: 'error',
        reason: sanitizeErrorReason(errorClass),
        errorClass,
      };
    }
  }

  /**
   * Startet einen Container auf dem VPS mit Bindungs-Label und --restart unless-stopped.
   *
   * Label `cloudflare.tunnel-hostname=<hostname>` ist die maßgebliche Container↔Route-Bindung (AC2).
   *
   * @param {VpsTarget} vps
   * @param {string}    image
   * @param {string}    hostname    - Wert für Label cloudflare.tunnel-hostname (z.B. "app.example.com")
   * @param {object}    [opts]
   * @param {number}    [opts.hostPort]       - Host-Port (Default: 8080)
   * @param {number}    [opts.containerPort]  - Container-Port (Default: 8080)
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<RunResult>}
   */
  async run(vps, image, hostname, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    const hostPort = opts.hostPort ?? DEFAULT_HOST_PORT_START;
    const containerPort = opts.containerPort ?? DEFAULT_CONTAINER_PORT;

    // Security: alle Werte via Shell-Escaping absichern, bevor sie in den Befehl eingebettet werden
    const escapedImage = shellEscape(image);
    const escapedHostname = shellEscape(hostname);

    // docker run -d --label cloudflare.tunnel-hostname=<hostname> --restart unless-stopped
    //            -p <hostPort>:<containerPort> <image>
    const cmd = [
      'docker', 'run', '-d',
      '--label', `cloudflare.tunnel-hostname=${escapedHostname}`,
      '--restart', 'unless-stopped',
      '-p', `${hostPort}:${containerPort}`,
      escapedImage,
    ].join(' ');

    try {
      const stdout = await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        sshClientFactory: opts._sshClientFactory,
      });
      const containerId = stdout.trim();
      return { result: 'ok', containerId, hostPort };
    } catch (err) {
      const errorClass = classifyError(err);
      return {
        result: 'error',
        reason: sanitizeErrorReason(errorClass),
        errorClass,
      };
    }
  }

  /**
   * Entfernt einen Container auf dem VPS (docker rm -f).
   *
   * @param {VpsTarget} vps
   * @param {string}    containerId
   * @param {object}    [opts]
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<{ result: 'ok'|'error', reason?: string, errorClass?: string }>}
   */
  async rm(vps, containerId, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    // Security: containerId validieren (nur hex-Zeichen erlaubt)
    if (!isValidContainerId(containerId)) {
      return {
        result: 'error',
        reason: 'Ungültige Container-ID (nur alphanumerische Zeichen erlaubt)',
        errorClass: 'error',
      };
    }

    const cmd = `docker rm -f ${containerId}`;

    try {
      await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        sshClientFactory: opts._sshClientFactory,
      });
      return { result: 'ok' };
    } catch (err) {
      const errorClass = classifyError(err);
      return {
        result: 'error',
        reason: sanitizeErrorReason(errorClass),
        errorClass,
      };
    }
  }

  /**
   * Listet laufende Container mit cloudflare.tunnel-hostname-Label auf dem VPS.
   *
   * @param {VpsTarget} vps
   * @param {object}    [opts]
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<PsResult>}
   */
  async ps(vps, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return { result: 'error', ...privateKey.error };

    // docker ps filtert auf Label cloudflare.tunnel-hostname (Existenz des Labels),
    // gibt Tab-getrennte Felder aus: ID, Image, Ports, Status, Labels
    const cmd = [
      'docker', 'ps',
      '--filter', 'label=cloudflare.tunnel-hostname',
      '--format', '{{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}\t{{.Label "cloudflare.tunnel-hostname"}}',
    ].join(' ');

    try {
      const stdout = await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        sshClientFactory: opts._sshClientFactory,
      });
      const containers = parsePsOutput(stdout);
      return { result: 'ok', containers };
    } catch (err) {
      const errorClass = classifyError(err);
      return {
        result: 'error',
        reason: sanitizeErrorReason(errorClass),
        errorClass,
      };
    }
  }

  // ── Private Hilfsmethoden ──────────────────────────────────────────────────────

  /**
   * Lädt den SSH-Private-Key aus dem CredentialStore.
   * Klartext verlässt den Store nie Richtung HTTP/Log/Audit.
   *
   * @param {string} targetUser - SSH-Benutzer-Label
   * @returns {Promise<{ ok: true, value: string } | { ok: false, error: object }>}
   */
  async #loadPrivateKey(targetUser) {
    let privateKey;
    try {
      privateKey = await this.#credentialStore.getPlaintext(`ssh/${targetUser}/private_key`);
    } catch {
      return {
        ok: false,
        error: {
          result: 'error',
          reason: 'Private-Key-Store nicht lesbar',
          errorClass: 'error',
        },
      };
    }

    if (!privateKey) {
      return {
        ok: false,
        error: {
          result: 'error',
          reason: `Kein Private-Key für Benutzer "${targetUser}" hinterlegt`,
          errorClass: 'no-private-key',
        },
      };
    }

    return { ok: true, value: privateKey };
  }
}

// ── SSH-Kommando ausführen (module-private) ────────────────────────────────────

/**
 * Baut eine SSH-Verbindung auf und führt ein einzelnes Kommando aus.
 * Gibt stdout als String zurück; wirft bei Fehler.
 *
 * @param {object} params
 * @param {string}   params.privateKey
 * @param {string}   params.host
 * @param {number}   params.port
 * @param {string}   params.targetUser
 * @param {string}   params.command
 * @param {number}   params.timeoutMs
 * @param {Function} [params.sshClientFactory]
 * @returns {Promise<string>} stdout
 */
function runSshCommand(params) {
  const {
    privateKey, host, port, targetUser,
    command, timeoutMs,
    sshClientFactory,
  } = params;

  const clientFactory = sshClientFactory ?? (() => new Client());

  return new Promise((resolve, reject) => {
    const conn = clientFactory();
    let resolved = false;

    function safeReject(err) {
      if (!resolved) {
        resolved = true;
        try { conn.end(); } catch { /* ignore */ }
        reject(err);
      }
    }

    function safeResolve(value) {
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

      const execTimeout = setTimeout(() => {
        const err = new Error('SSH-Kommando-Timeout');
        err.code = 'ETIMEDOUT';
        safeReject(err);
      }, timeoutMs);

      conn.exec(command, { pty: false }, (execErr, stream) => {
        if (execErr) {
          clearTimeout(execTimeout);
          safeReject(execErr);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });

        stream.on('close', (code) => {
          clearTimeout(execTimeout);
          if (resolved) return;

          if (code !== 0) {
            // stderr wird NICHT weitergeleitet (könnte Secrets enthalten oder lange sein),
            // nur die Fehlerkategorie wird gemeldet
            const err = new Error(`docker-Kommando fehlgeschlagen (exit ${code})`);
            err.code = 'DOCKER_FAILED';
            // Interne Referenz für Debugging (nur im Prozess, nie in Response/Log):
            err._stderrLen = stderr.length;
            safeReject(err);
          } else {
            safeResolve(stdout);
          }
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(connectTimeout);
      safeReject(err);
    });

    conn.connect({
      host,
      port,
      username: targetUser,
      privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // TOFU: kein hostFingerprint für Docker-Operationen (VpsProvisioner-Linie)
      // Ein Operator, der strikte Host-Key-Verifikation will, kann VpsProvisioner
      // für einen vorangehenden Provision-Schritt verwenden.
    });
  });
}

// ── docker ps-Output parsen ────────────────────────────────────────────────────

/**
 * Parst die Ausgabe von `docker ps --format '{{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}\t{{.Label "cloudflare.tunnel-hostname"}}'`.
 *
 * @param {string} output
 * @returns {PsEntry[]}
 */
function parsePsOutput(output) {
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  const containers = [];

  for (const line of lines) {
    const parts = line.split('\t');
    const containerId = (parts[0] ?? '').trim();
    const image = (parts[1] ?? '').trim();
    const ports = (parts[2] ?? '').trim();
    const status = (parts[3] ?? '').trim();
    const hostname = (parts[4] ?? '').trim();

    if (!containerId) continue;

    // Ersten Host-Port aus Port-Mapping extrahieren (z.B. "0.0.0.0:8080->8080/tcp")
    const portMatch = ports.match(/(?:0\.0\.0\.0|:::?)?:?(\d+)->/);
    const hostPort = portMatch ? parseInt(portMatch[1], 10) : null;

    containers.push({ containerId, image, hostname, status, hostPort });
  }

  return containers;
}

// ── Shell-Escaping ─────────────────────────────────────────────────────────────

/**
 * Bettet einen Wert sicher in einen Shell-Befehl ein (Single-Quote-Escaping).
 * Genau das Muster wie in VpsProvisioner (Single-Quotes: ' → '\'').
 *
 * Sicherheits-Annahme: kein Newline-Injection möglich, da die Werte aus
 * validierten Quellen (CredentialStore, API-Requests) stammen.
 *
 * @param {string} value
 * @returns {string} - in Single-Quotes eingebetteter, escaped Wert
 */
function shellEscape(value) {
  // Single-Quote-Escaping: ' → '\''
  const escaped = String(value).replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

/**
 * Validiert eine Container-ID auf sichere Zeichen (nur alphanumerisch + Bindestrich).
 * Docker-Container-IDs sind hexadezimale Strings (kurz 12 Zeichen oder lang 64 Zeichen).
 * Container-Namen können alphanumerisch + Unterstriche + Bindestriche enthalten.
 *
 * @param {string} id
 * @returns {boolean}
 */
function isValidContainerId(id) {
  return typeof id === 'string' && id.length > 0 && /^[a-zA-Z0-9_-]+$/.test(id);
}

// ── Fehlerklassifizierung ──────────────────────────────────────────────────────

/**
 * Klassifiziert einen SSH/Docker-Fehler in eine maschinenlesbare Kategorie.
 * Analog VpsProvisioner.classifyError — geheimnis-frei.
 *
 * @param {Error} err
 * @returns {string}
 */
function classifyError(err) {
  const msg = (err.message ?? '').toLowerCase();
  const code = err.code ?? '';

  if (code === 'HOST_KEY_MISMATCH') return 'host-key-mismatch';
  if (code === 'DOCKER_FAILED') return 'docker-failed';
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
 * Private-Key, Tokens etc. erscheinen NICHT im reason.
 *
 * @param {string} errorClass
 * @returns {string}
 */
function sanitizeErrorReason(errorClass) {
  switch (errorClass) {
    case 'no-private-key':
      return 'Kein SSH-Private-Key für diesen Benutzer hinterlegt';
    case 'unreachable':
      return 'VPS-Ziel nicht erreichbar (Verbindung fehlgeschlagen oder Timeout)';
    case 'auth-failed':
      return 'SSH-Authentifizierung fehlgeschlagen (Private-Key abgelehnt oder Benutzer nicht gefunden)';
    case 'host-key-mismatch':
      return 'SSH-Host-Key-Fingerprint stimmt nicht mit dem erwarteten Wert überein';
    case 'docker-failed':
      return 'docker-Kommando auf VPS fehlgeschlagen';
    default:
      return 'VpsDockerControl: unerwarteter Fehler';
  }
}

