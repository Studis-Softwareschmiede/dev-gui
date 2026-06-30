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
 *   - probe(vps, opts?)        — Bereitschafts-Probe: { state: "unreachable"|"provisioning"|"ready" }
 *   - pull(vps, image)         — docker pull auf dem VPS
 *   - run(vps, image, hostname, opts?) — docker run mit Bindungs-Label + --restart unless-stopped
 *   - rm(vps, containerId)     — docker rm -f auf dem VPS
 *   - ps(vps)                  — laufende Container mit cloudflare.tunnel-hostname-Label
 *   - psAll(vps)               — alle laufenden Container; managed (mit Label) + unmanaged (ohne Label, hostname: null)
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
import { createHash } from 'node:crypto';
import { isValidHostname } from './hostnameSanitizer.js';

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
 * @property {string}      containerId   - Container-ID (kurz)
 * @property {string}      [name]        - Docker-Container-Name (aus {{.Names}}); nur in psAll() gefüllt
 * @property {string}      image         - Image-Name
 * @property {string|null} hostname      - cloudflare.tunnel-hostname-Label-Wert; null für unmanaged Container
 * @property {string}      status        - Container-Status (z.B. "Up 2 hours")
 * @property {number|null} hostPort      - gemappter Host-Port (aus Port-Mapping)
 * @property {string|null} composeProject - com.docker.compose.project-Label-Wert; null für Non-Stack-Container.
 *   Nur in psAll() ausgefüllt (für stack-aware Reconciliation, AC13).
 *   Interne Stack-Container (hostname: null, composeProject: <name>) werden nie geroutet
 *   und nie als verwaist gewertet — sie landen in reportedUnmanaged.
 */

/**
 * @typedef {object} PsResult
 * @property {'ok'|'error'} result
 * @property {PsEntry[]}    [containers]  - laufende managed Container bei Erfolg
 * @property {string}       [reason]      - Fehlergrund ohne Geheim-Leak
 * @property {string}       [errorClass]  - maschinenlesbare Fehlerklasse
 */

/**
 * @typedef {'unreachable'|'provisioning'|'ready'} ProbeState
 */

/**
 * @typedef {object} ProbeResult
 * @property {ProbeState} state   - Bereitschaftszustand des VPS
 * @property {string}     [reason] - neutrale, secret-freie Begründung (kein Host/Key/Token)
 */

/**
 * Kanonischer Bereitschafts-Probe-Befehl (Spec §2, AC2/AC3).
 * Prüft drei Bedingungen:
 *   1. cloud-init fertig (/var/lib/cloud/instance/boot-finished)
 *   2. Docker läuft (docker info exit 0; Fehler → /dev/null; kein DOCKER_FAILED)
 *   3. mindestens ein cloudflared-Container mit Status "running"
 * stdout READY → ready; stdout NOTREADY → provisioning.
 * SSH-Fehler → unreachable (nie provisioning, nie Fehler).
 */
const PROBE_COMMAND =
  'test -f /var/lib/cloud/instance/boot-finished && docker info >/dev/null 2>&1 && docker ps --filter name=cloudflared --filter status=running -q | grep -q . && echo READY || echo NOTREADY';

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
   * Readiness-Probe (AC1–AC3, AC13/vps-readiness-gate): ermittelt den Bereitschaftszustand
   * des VPS in EINER SSH-Session mit dem kanonischen Befehl (Spec §2).
   *
   * Zustand:
   *   - "ready"       — stdout enthält "READY" (cloud-init + Docker + cloudflared bereit)
   *   - "provisioning"— stdout enthält "NOTREADY" oder unerwartetes stdout (konservativ)
   *   - "unreachable" — SSH-Connect-Fehler / Auth-Fehler / Timeout
   *
   * Sicherheit (AC13):
   *   - SSH-Private-Key store-intern, NIE in Argv/Log/Audit/Response.
   *   - reason enthält keinen Host, Key oder Token.
   *   - probe() wirft NIE (jeder Fehler → definierter Zustand).
   *
   * @param {VpsTarget} vps
   * @param {object}    [opts]
   * @param {string}    [opts.hostFingerprint]    - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory] - testbare SSH-Client-Fabrik (für Unit-Tests)
   * @returns {Promise<ProbeResult>}
   */
  async probe(vps, opts = {}) {
    // probe() wirft NIE — alle Fehler werden auf einen Zustand abgebildet
    let privateKey;
    try {
      const loaded = await this.#loadPrivateKey(vps.targetUser);
      if (!loaded.ok) {
        // Kein Private-Key → VPS nicht erreichbar (kann keine SSH-Verbindung aufbauen)
        return { state: 'unreachable', reason: 'Kein SSH-Private-Key hinterlegt' };
      }
      privateKey = loaded.value;
    } catch {
      return { state: 'unreachable', reason: 'SSH-Key-Store nicht lesbar' };
    }

    try {
      const stdout = await runSshCommand({
        privateKey,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: PROBE_COMMAND,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: opts.hostFingerprint ?? null,
        sshClientFactory: opts._sshClientFactory,
      });

      const trimmed = stdout.trim();
      if (trimmed === 'READY') {
        return { state: 'ready' };
      }
      // NOTREADY oder unerwartetes stdout → provisioning (konservativ: nie fälschlich ready)
      return { state: 'provisioning', reason: 'VPS wird noch eingerichtet (cloud-init / Docker / cloudflared)' };
    } catch (err) {
      // SSH-Fehler: classifyError, dann unreachable oder provisioning
      const errorClass = classifyError(err);
      if (errorClass === 'docker-failed') {
        // exit != 0 trotz /dev/null-Umleitung: konservativ provisioning (kein DOCKER_FAILED)
        // (der PROBE_COMMAND selbst hat exit 0 — dieser Pfad ist eine Absicherung)
        return { state: 'provisioning', reason: 'VPS wird noch eingerichtet (cloud-init / Docker / cloudflared)' };
      }
      // Connect-Fehler / Auth-Fehler / Timeout / host-key-mismatch → unreachable
      return { state: 'unreachable', reason: 'VPS nicht erreichbar (SSH-Verbindung fehlgeschlagen)' };
    }
  }

  /**
   * Ermittelt die exponierten Ports eines Images via `docker inspect` auf dem VPS (AC13).
   *
   * Gibt die ExposedPorts-Keys zurück (z.B. ["8080/tcp", "3000/tcp"]).
   * Bei Fehler → leeres Array (Caller nutzt Fallback).
   *
   * @param {VpsTarget} vps
   * @param {string}    image
   * @param {object}    [opts]
   * @param {string}    [opts.hostFingerprint]
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<{ result: 'ok'|'error', ports?: string[], reason?: string, errorClass?: string }>}
   */
  async inspect(vps, image, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return { result: 'error', ports: [], ...privateKey.error };

    // Security: image-Name via Shell-Escaping absichern
    const escapedImage = shellEscape(image);
    // docker inspect --format '{{json .Config.ExposedPorts}}' returns JSON like {"8080/tcp":{}}
    const cmd = `docker inspect --format '{{json .Config.ExposedPorts}}' ${escapedImage}`;

    try {
      const stdout = await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: opts.hostFingerprint ?? null,
        sshClientFactory: opts._sshClientFactory,
      });
      // Parse JSON output; null means no ExposedPorts
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        return { result: 'ok', ports: [] };
      }
      if (!parsed || typeof parsed !== 'object') {
        return { result: 'ok', ports: [] };
      }
      const ports = Object.keys(parsed);
      return { result: 'ok', ports };
    } catch (err) {
      const errorClass = classifyError(err);
      return {
        result: 'error',
        ports: [],
        reason: sanitizeErrorReason(errorClass),
        errorClass,
      };
    }
  }

  /**
   * Pullt ein Docker-Image auf dem VPS.
   *
   * @param {VpsTarget} vps
   * @param {string}    image
   * @param {object}    [opts]
   * @param {string}    [opts.hostFingerprint]    - SHA-256-Fingerprint für Host-Key-Verifikation
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
        hostFingerprint: opts.hostFingerprint ?? null,
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
   * @param {number}    [opts.hostPort]           - Host-Port (Default: 8080)
   * @param {number}    [opts.containerPort]      - Container-Port (Default: 8080)
   * @param {string}    [opts.hostFingerprint]    - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<RunResult>}
   */
  async run(vps, image, hostname, opts = {}) {
    // Security: hostname auf DNS-Zeichensatz validieren bevor er in Shell-Kommandos eingebettet wird
    if (!isValidHostname(hostname)) {
      return {
        result: 'error',
        reason: 'Ungültiger Hostname (nur DNS-Zeichen erlaubt: a-z A-Z 0-9 . - _)',
        errorClass: 'error',
      };
    }

    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    const hostPort = opts.hostPort ?? DEFAULT_HOST_PORT_START;
    const containerPort = opts.containerPort ?? DEFAULT_CONTAINER_PORT;

    // Security: alle Werte via Shell-Escaping absichern, bevor sie in den Befehl eingebettet werden
    const escapedImage = shellEscape(image);
    // Den gesamten KEY=VALUE-Block als eine Shell-Einheit quoten, damit Sonderzeichen im Hostname
    // (z.B. Punkte, Bindestriche) nicht als Shell-Metazeichen interpretiert werden.
    // kein Shell-Command-Injection möglich (Single-Quote-Escaping schützt vor Injection).
    const escapedLabel = shellEscape(`cloudflare.tunnel-hostname=${hostname}`);

    // docker run -d --label cloudflare.tunnel-hostname=<hostname> --restart unless-stopped
    //            -p <hostPort>:<containerPort> <image>
    const cmd = [
      'docker', 'run', '-d',
      '--label', escapedLabel,
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
        hostFingerprint: opts.hostFingerprint ?? null,
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
   * @param {string}    [opts.hostFingerprint]    - SHA-256-Fingerprint für Host-Key-Verifikation
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
        hostFingerprint: opts.hostFingerprint ?? null,
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
   * Startet einen bereits vorhandenen Container auf dem VPS (docker start).
   *
   * @param {VpsTarget} vps
   * @param {string}    containerId
   * @param {object}    [opts]
   * @param {string}    [opts.hostFingerprint]    - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<{ result: 'ok'|'error', reason?: string, errorClass?: string }>}
   */
  async start(vps, containerId, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    // Security: containerId validieren (nur alphanumerische Zeichen + Bindestrich erlaubt)
    if (!isValidContainerId(containerId)) {
      return {
        result: 'error',
        reason: 'Ungültige Container-ID (nur alphanumerische Zeichen erlaubt)',
        errorClass: 'error',
      };
    }

    const cmd = `docker start ${containerId}`;

    try {
      await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: opts.hostFingerprint ?? null,
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
   * Stoppt einen laufenden Container auf dem VPS (docker stop).
   *
   * @param {VpsTarget} vps
   * @param {string}    containerId
   * @param {object}    [opts]
   * @param {string}    [opts.hostFingerprint]    - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<{ result: 'ok'|'error', reason?: string, errorClass?: string }>}
   */
  async stop(vps, containerId, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    // Security: containerId validieren
    if (!isValidContainerId(containerId)) {
      return {
        result: 'error',
        reason: 'Ungültige Container-ID (nur alphanumerische Zeichen erlaubt)',
        errorClass: 'error',
      };
    }

    const cmd = `docker stop ${containerId}`;

    try {
      await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: opts.hostFingerprint ?? null,
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
   * Startet einen Container neu (docker restart).
   *
   * @param {VpsTarget} vps
   * @param {string}    containerId
   * @param {object}    [opts]
   * @param {string}    [opts.hostFingerprint]    - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<{ result: 'ok'|'error', reason?: string, errorClass?: string }>}
   */
  async restart(vps, containerId, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    // Security: containerId validieren
    if (!isValidContainerId(containerId)) {
      return {
        result: 'error',
        reason: 'Ungültige Container-ID (nur alphanumerische Zeichen erlaubt)',
        errorClass: 'error',
      };
    }

    const cmd = `docker restart ${containerId}`;

    try {
      await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: opts.hostFingerprint ?? null,
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
   * Liest die letzten N Zeilen des Container-Logs read-only (docker logs --tail N).
   *
   * Kein Secret-Leak: stdout/stderr des Kommandos werden als Log-Zeilen zurückgegeben;
   * der SSH-Private-Key erscheint NICHT in der Response.
   *
   * @param {VpsTarget} vps
   * @param {string}    containerId
   * @param {object}    [opts]
   * @param {number}    [opts.tail]              - Anzahl der letzten Zeilen (Default: 100)
   * @param {string}    [opts.hostFingerprint]   - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<{ result: 'ok'|'error', lines?: string[], reason?: string, errorClass?: string }>}
   */
  async logs(vps, containerId, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return { result: 'error', ...privateKey.error };

    // Security: containerId validieren
    if (!isValidContainerId(containerId)) {
      return {
        result: 'error',
        reason: 'Ungültige Container-ID (nur alphanumerische Zeichen erlaubt)',
        errorClass: 'error',
      };
    }

    const tail = (Number.isFinite(opts.tail) && opts.tail > 0) ? Math.min(opts.tail, 1000) : 100;
    // docker logs gibt stdout UND stderr des Containers aus — beide Streams sind Log-Inhalt
    // (nicht Backend-Secrets). Das `2>&1` leitet stderr → stdout, damit wir alles per stdout lesen.
    const cmd = `docker logs --tail ${tail} ${containerId} 2>&1`;

    try {
      const stdout = await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: opts.hostFingerprint ?? null,
        sshClientFactory: opts._sshClientFactory,
      });
      const lines = stdout.split('\n').filter((l) => l !== '');
      return { result: 'ok', lines };
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
   * @param {string}    [opts.hostFingerprint]    - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<PsResult>}
   */
  async ps(vps, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return { result: 'error', ...privateKey.error };

    // docker ps filtert auf Label cloudflare.tunnel-hostname (Existenz des Labels),
    // gibt Tab-getrennte Felder aus: ID, Image, Ports, Status, Labels
    // Security: Format-String enthält Tabs und Double-Quotes — shellEscape() schützt vor
    // IFS-Split (Tabs) und Quote-Bruch in strikten Shells (analog escapedImage/escapedLabel).
    const formatStr = shellEscape('{{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}\t{{.Label "cloudflare.tunnel-hostname"}}');
    const cmd = [
      'docker', 'ps',
      '--filter', 'label=cloudflare.tunnel-hostname',
      '--format', formatStr,
    ].join(' ');

    try {
      const stdout = await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: opts.hostFingerprint ?? null,
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

  /**
   * Listet ALLE laufenden Container auf dem VPS — managed (mit cloudflare.tunnel-hostname-Label)
   * und unmanaged (ohne das Label).
   *
   * Managed Container haben `hostname` gesetzt (aus dem Label).
   * Unmanaged Container haben `hostname: null`.
   *
   * Stack-aware (AC13): gibt zusätzlich das `com.docker.compose.project`-Label aus
   * (`composeProject`-Feld in PsEntry). Interne Stack-Container (kein
   * cloudflare.tunnel-hostname, aber com.docker.compose.project gesetzt) erhalten
   * `hostname: null` und landen in `reportedUnmanaged` — sie werden nie geroutet und
   * nie als verwaist gewertet.
   *
   * Additiv zu ps() — bestehende ps()-Aufrufer sind nicht betroffen.
   *
   * @param {VpsTarget} vps
   * @param {object}    [opts]
   * @param {string}    [opts.hostFingerprint]    - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<PsResult>}
   */
  async psAll(vps, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return { result: 'error', ...privateKey.error };

    // docker ps ohne --filter gibt alle laufenden Container zurück.
    // Format: ID, Names, Image, Ports, Status, Label cloudflare.tunnel-hostname, Label com.docker.compose.project
    // Der Label-Wert ist leer ("") für Container ohne das jeweilige Label.
    // I1: {{.Names}} liefert den lesbaren Container-Namen (z.B. "my-app_web_1").
    // AC13: com.docker.compose.project-Label für stack-aware Reconciliation mitgelesen.
    const formatStr = shellEscape('{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}\t{{.Label "cloudflare.tunnel-hostname"}}\t{{.Label "com.docker.compose.project"}}');
    const cmd = [
      'docker', 'ps',
      '--format', formatStr,
    ].join(' ');

    try {
      const stdout = await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: opts.hostFingerprint ?? null,
        sshClientFactory: opts._sshClientFactory,
      });
      // parsePsAllOutput markiert Container ohne Label mit hostname: null (unmanaged); füllt name-Feld (I1)
      const containers = parsePsAllOutput(stdout);
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

  /**
   * Schreibt das Cloudflare-Tunnel-Token in /etc/cloudflared/env auf dem VPS und
   * startet den cloudflared-Docker-Container neu (S-187 AC3/AC4, Token-Floor).
   *
   * Security-Floor (AC4, HART):
   *   - Das Tunnel-Token erscheint NIEMALS in Argv/Log/Audit/Response.
   *   - Das Token fließt ausschließlich als Dateiinhalt via stdin (bash -s Muster,
   *     analog VpsProvisioner authorized_keys). Kein Token in der Kommandozeile.
   *   - Der Dateiinhalt (env-file) wird NICHT geloggt.
   *
   * Mechanik:
   *   1. bash -s liest ein Shell-Skript von stdin.
   *   2. Das Skript erhält das Token via Shell-Variable (stdin-sicher: Token nie in exec-Argv).
   *   3. mkdir -p /etc/cloudflared; printf '%s\n' "TUNNEL_TOKEN=$TOKEN" > /etc/cloudflared/env
   *   4. chmod 600 /etc/cloudflared/env; chown root:root /etc/cloudflared/env
   *   5. docker restart cloudflared
   *
   * Das Token-Einbetten per Heredoc/printf in das Skript (das via stdin übergeben wird)
   * ist sicher: es erscheint NICHT als Prozess-Argv — nur als Skript-Body auf stdin.
   *
   * @param {VpsTarget} vps
   * @param {string}    tunnelToken  - Cloudflare Tunnel-Token (Geheimnis, NIE loggen)
   * @param {object}    [opts]
   * @param {string}    [opts.hostFingerprint]    - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<{ result: 'ok'|'error', reason?: string, errorClass?: string }>}
   */
  async pushTunnelEnvFile(vps, tunnelToken, opts = {}) {
    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    // Security-Floor: Token NIEMALS in Argv. Stattdessen: bash -s liest Skript von stdin.
    // Das Skript bettet das Token in einen printf-Befehl ein — das Token ist im Skript-Body
    // (stdin-Datenstrom), nicht im exec-Argv. Kein `echo $TOKEN` in runcmd/Log.
    //
    // Single-Quote-Escaping: Wenn das Token ein Einfach-Anführungszeichen enthält,
    // muss es escaped werden: ' → '\''. Cloudflare-Tokens bestehen aus Base64-ähnlichen
    // Zeichen (keine Sonderzeichen erwartet), aber defensive Escaping ist Pflicht.
    const escapedToken = String(tunnelToken).replace(/'/g, "'\\''");

    // Shell-Skript: über stdin übergeben, Token NICHT in Argv
    // Token-Floor: `printf '%s\n' '...'` ist KEIN Argv-Token für den SSH-exec-Befehl (bash -s);
    // der SSH-exec-Argv ist nur "bash -s". Das Token erscheint ausschließlich im stdin-Body.
    const script = [
      'set -e',
      'mkdir -p /etc/cloudflared',
      // Token via printf-Literal (stdin-Body, nie Argv) in die env-Datei schreiben.
      // printf statt echo: kein Trailing-Newline-Problem, kein Interpretation von Escape-Sequences.
      `printf 'TUNNEL_TOKEN=%s\\n' '${escapedToken}' > /etc/cloudflared/env`,
      'chmod 600 /etc/cloudflared/env',
      'chown root:root /etc/cloudflared/env',
      // cloudflared-Container NEU ERSTELLEN (rm + run), NICHT `docker restart`:
      // `docker restart` liest die `--env-file` NICHT neu ein (env wird nur bei `docker run`
      // geladen) — das neue Token bliebe sonst unwirksam und der Tunnel `inactive`.
      // Run-Kommando = CloudInitBuilder v5 (--network host, --env-file). Token NICHT in Argv:
      // es kommt ausschließlich aus der zuvor geschriebenen env-Datei (Token-Floor gewahrt).
      'docker rm -f cloudflared 2>/dev/null || true',
      'docker run -d --name cloudflared --restart unless-stopped --network host --env-file /etc/cloudflared/env cloudflare/cloudflared:latest tunnel --no-autoupdate run',
    ].join('\n');

    try {
      await runSshScript({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        script,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: opts.hostFingerprint ?? null,
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
 * Host-Key-Verifikation analog VpsProvisioner (ADR-008-Linie):
 *   - Bei gesetztem `hostFingerprint`: SHA-256-Fingerprint berechnen + vergleichen;
 *     Mismatch → HOST_KEY_MISMATCH-Fehler.
 *   - Ohne `hostFingerprint`: TOFU — Host-Key wird akzeptiert (erster Connect).
 *   Der Fingerprint wird NICHT in Response/Argv/Log exponiert.
 *
 * @param {object} params
 * @param {string}   params.privateKey
 * @param {string}   params.host
 * @param {number}   params.port
 * @param {string}   params.targetUser
 * @param {string}   params.command
 * @param {number}   params.timeoutMs
 * @param {string}   [params.hostFingerprint] - SHA-256-Fingerprint (Base64, ohne "SHA256:" Prefix)
 * @param {Function} [params.sshClientFactory]
 * @returns {Promise<string>} stdout
 */
function runSshCommand(params) {
  const {
    privateKey, host, port, targetUser,
    command, timeoutMs,
    hostFingerprint = null,
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
        let stderrBuf = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => {
          // S1: ersten ~200 Zeichen intern puffern für WARN-Log (nie in HTTP/Audit/WS-Sink)
          if (stderrBuf.length < 200) {
            stderrBuf += data.toString();
          }
        });

        stream.on('close', (code) => {
          clearTimeout(execTimeout);
          if (resolved) return;

          if (code !== 0) {
            // stderr wird NICHT in Response/Log weitergeleitet (könnte Secrets enthalten);
            // nur die ersten Zeichen landen intern im Error-Objekt für Prozess-internes Debugging
            const err = new Error(`docker-Kommando fehlgeschlagen (exit ${code})`);
            err.code = 'DOCKER_FAILED';
            // Interne Referenz für Debugging (nur im Prozess, nie in Response/Audit/WS):
            err._stderrHint = stderrBuf.slice(0, 200);
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

    // Host-Key-Verifikation analog VpsProvisioner (ADR-008-Linie):
    // SHA-256-Fingerprint berechnen (synchron — ssh2 erwartet sync return);
    // Fingerprint wird NICHT in Response/Argv/Log exponiert.
    const hostVerifier = (key) => {
      let hash = null;
      try {
        hash = createHash('sha256').update(key).digest('base64');
      } catch {
        // Fingerprint-Berechnung nicht kritisch — Verifikation weiterführen
      }

      if (hostFingerprint) {
        if (hash === hostFingerprint) {
          return true;
        }
        // Fingerprint-Mismatch → Verbindung ablehnen
        const fpErr = new Error('SSH-Host-Key-Fingerprint stimmt nicht überein (möglicher MITM)');
        fpErr.code = 'HOST_KEY_MISMATCH';
        // setTimeout nötig, da ssh2 hostVerifier keine async-Fehler propagiert
        setTimeout(() => safeReject(fpErr), 0);
        return false;
      }

      // TOFU: kein Fingerprint konfiguriert → akzeptieren
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

// ── SSH-Skript ausführen via stdin (module-private) ───────────────────────────

/**
 * Baut eine SSH-Verbindung auf und führt ein Shell-Skript über stdin aus (bash -s).
 *
 * Security-Floor (S-187 AC4):
 *   - Das Skript (inkl. Token-Inhalten) wird via stdin übergeben — NIEMALS als Argv.
 *   - Der exec()-Argv ist nur "bash -s"; der Skript-Body ist ein Datenstrom.
 *   - Kein Secret erscheint in Argv/Log/Error-Meldungen.
 *
 * Analog VpsProvisioner.#addAuthorizedKey (bash -s + stdin.write(script)).
 *
 * @param {object} params
 * @param {string}   params.privateKey
 * @param {string}   params.host
 * @param {number}   params.port
 * @param {string}   params.targetUser
 * @param {string}   params.script      - Shell-Skript (wird über stdin übergeben)
 * @param {number}   params.timeoutMs
 * @param {string}   [params.hostFingerprint]
 * @param {Function} [params.sshClientFactory]
 * @returns {Promise<string>} stdout
 */
function runSshScript(params) {
  const {
    privateKey, host, port, targetUser,
    script, timeoutMs,
    hostFingerprint = null,
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

      // "bash -s": Skript wird über stdin übergeben — Token NIE in Argv
      conn.exec('bash -s', { pty: false }, (execErr, stream) => {
        if (execErr) {
          clearTimeout(execTimeout);
          safeReject(execErr);
          return;
        }

        let stdout = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', () => { /* stderr consumed but not propagated (Security-Floor: könnte Token enthalten) */ });

        stream.on('close', (code) => {
          clearTimeout(execTimeout);
          if (resolved) return;

          if (code !== 0) {
            const err = new Error(`Remote-Skript fehlgeschlagen (exit ${code})`);
            err.code = 'DOCKER_FAILED';
            safeReject(err);
          } else {
            safeResolve(stdout);
          }
        });

        // Skript via stdin übergeben — Token erscheint NICHT in exec-Argv
        stream.stdin.write(script);
        stream.stdin.end();
      });
    });

    conn.on('error', (err) => {
      clearTimeout(connectTimeout);
      safeReject(err);
    });

    const hostVerifier = (key) => {
      let hash = null;
      try {
        hash = createHash('sha256').update(key).digest('base64');
      } catch {
        // Fingerprint-Berechnung nicht kritisch
      }

      if (hostFingerprint) {
        if (hash === hostFingerprint) return true;
        const fpErr = new Error('SSH-Host-Key-Fingerprint stimmt nicht überein (möglicher MITM)');
        fpErr.code = 'HOST_KEY_MISMATCH';
        setTimeout(() => safeReject(fpErr), 0);
        return false;
      }
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

    // composeProject: null — ps() filtert auf managed Container (cloudflare.tunnel-hostname-Label);
    // das com.docker.compose.project-Label ist im ps()-Format-String nicht enthalten.
    // Feld wird explizit auf null gesetzt, damit PsEntry-Typedef (string|null) immer erfüllt ist.
    containers.push({ containerId, image, hostname, status, hostPort, composeProject: null });
  }

  return containers;
}

/**
 * Parst die Ausgabe von `docker ps --format '...'` für ALLE Container (kein Label-Filter).
 * Container mit cloudflare.tunnel-hostname-Label → hostname = Label-Wert (managed).
 * Container OHNE das Label → hostname = null (unmanaged).
 *
 * I1 (name-Feld): Format enthält {{.Names}} → lesbarer Container-Name in PsEntry.name.
 * AC13 (stack-aware): parst zusätzlich das com.docker.compose.project-Label.
 * Interne Stack-Container haben hostname: null (kein cloudflare.tunnel-hostname) aber
 * composeProject gesetzt — sie werden von ReconciliationJob nie geroutet/als verwaist gewertet.
 *
 * Format-Reihenfolge: ID\tNames\tImage\tPorts\tStatus\tCF-Label\tCompose-Label
 *
 * @param {string} output
 * @returns {PsEntry[]}
 */
function parsePsAllOutput(output) {
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  const containers = [];

  for (const line of lines) {
    const parts = line.split('\t');
    const containerId = (parts[0] ?? '').trim();
    const name = (parts[1] ?? '').trim() || undefined; // I1: lesbarer Name; undefined wenn leer
    const image = (parts[2] ?? '').trim();
    const ports = (parts[3] ?? '').trim();
    const status = (parts[4] ?? '').trim();
    const cfLabelValue = (parts[5] ?? '').trim();
    const composeProjValue = (parts[6] ?? '').trim();

    if (!containerId) continue;

    // Ersten Host-Port aus Port-Mapping extrahieren
    const portMatch = ports.match(/(?:0\.0\.0\.0|:::?)?:?(\d+)->/);
    const hostPort = portMatch ? parseInt(portMatch[1], 10) : null;

    // hostname: null markiert unmanaged Container (kein cloudflare.tunnel-hostname-Label)
    const hostname = cfLabelValue || null;

    // composeProject: null für Non-Stack-Container (kein com.docker.compose.project-Label)
    // AC13: interne Stack-Container haben composeProject gesetzt, aber hostname: null
    const composeProject = composeProjValue || null;

    const entry = { containerId, image, hostname, status, hostPort, composeProject };
    if (name) entry.name = name; // I1: nur setzen wenn vorhanden
    containers.push(entry);
  }

  return containers;
}

// ── Shell-Escaping ─────────────────────────────────────────────────────────────

/**
 * Bettet einen Wert sicher in einen Shell-Befehl ein (Single-Quote-Escaping).
 * Genau das Muster wie in VpsProvisioner (Single-Quotes: ' → '\'').
 *
 * Sicherheits-Annahme: kein Shell-Command-Injection möglich — Single-Quote-Escaping
 * verhindert das Ausbrechen aus dem quotierten Wert. (Hinweis: Newlines sind in
 * Single-Quotes syntaktisch legal; der Schutz betrifft Command-Injection, nicht Newlines.)
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

