/**
 * LocalDockerControl — einzige schreibend-lokale Docker-Boundary (AC1, S-156).
 *
 * Boundary-Vertrag:
 *   - Einziger Ort für lokale schreibende Docker-Kommandos (run / inspect / rm).
 *   - Spricht den lokalen Docker-Daemon über DOCKER_HOST (socket-proxy) an, NICHT via SSH.
 *   - Der read-only DockerReader bleibt unberührt und unverändert.
 *   - Alle Kommandos werden als Argv-Array übergeben (kein Shell-Exec, kein Command-Injection).
 *   - Kein Secret / Token in Args / Log / Response.
 *
 * Test-Label-Konvention:
 *   Jeder Probe-Container trägt das Label `dev-gui.local-test=1` und
 *   einen pro-Aufruf eindeutigen Namen `dev-gui-local-test-<uuid>`.
 *   Nach dem Test existiert kein Container mit diesem Label mehr (Aufräum-Garantie, AC4).
 *
 * Port-Quelle: `docker inspect` `Config.ExposedPorts` (JSON-Format).
 *
 * Fehlerverhalten:
 *   - Docker nicht erreichbar → wirft einen klassierten Error ({ message, errorClass: 'docker-unreachable' })
 *   - Pull fehlgeschlagen → wirft ({ message, errorClass: 'pull-failed' })
 *   - Sonstige Exec-Fehler → errorClass: 'exec-error'
 *
 * @module LocalDockerControl
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Timeout für `docker pull` (5 Minuten). */
const PULL_TIMEOUT_MS = 300_000;

/** Timeout für run/inspect/rm. */
const EXEC_TIMEOUT_MS = 15_000;

/** Timeout für HTTP-Reachability-Probe (ms). */
const REACHABILITY_TIMEOUT_MS = 3_000;

/** Kurze Wartezeit nach Container-Start, bevor inspect + Reachability laufen (ms). */
const START_SETTLE_MS = 1_500;

/** Label aller Probe-Container — Aufräum-Anker (AC1, AC4). */
const TEST_LABEL_KEY = 'dev-gui.local-test';
const TEST_LABEL_VALUE = '1';

/**
 * @typedef {object} LocalTestReport
 * @property {boolean}  started       - Container hat gestartet (exitCode akzeptabel zum Zeitpunkt des Checks)
 * @property {boolean}  exitedEarly   - Container war beim Inspect-Zeitpunkt bereits gestoppt (Crash-Loop)
 * @property {number|null} hostPort   - gemappter Host-Port; null wenn kein exponierter Port
 * @property {number[]}  exposedPorts - alle exponierten Container-Ports (aus ExposedPorts)
 * @property {boolean}  reachable     - HTTP-GET gegen hostPort erfolgreich (jeder Statuscode = true)
 * @property {number}   durationMs    - Gesamtdauer in ms
 * @property {string}   [reason]      - Zusatzinfo (kein exponierter Port, Mehrdeutigkeit, Fehlergrund)
 */

/**
 * Default exec function — wraps child_process.execFile.
 * Argv-basiert, kein Shell-Exec (Security/R02).
 *
 * @param {string}   cmd
 * @param {string[]} args
 * @param {number}   timeoutMs
 * @returns {Promise<string>} stdout
 */
function defaultExec(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(err.message ?? 'execFile failed');
        e.stderr = stderr ?? '';
        e.stdout = stdout ?? '';
        e.code = err.code;
        return reject(e);
      }
      resolve(stdout ?? '');
    });
  });
}

/**
 * LocalDockerControl — schreibend-lokale Docker-Boundary (run/inspect/rm lokal).
 *
 * @param {object} [options]
 * @param {(cmd:string, args:string[], timeoutMs:number) => Promise<string>} [options.execFn]
 *   Injectable exec function — defaults to child_process.execFile.
 * @param {(url:string, timeoutMs:number) => Promise<{ok:boolean, status:number}>} [options.fetchFn]
 *   Injectable fetch function for reachability probes — defaults to node fetch.
 */
export class LocalDockerControl {
  #exec;
  #fetch;

  constructor({ execFn, fetchFn } = {}) {
    this.#exec = execFn ?? defaultExec;
    this.#fetch = fetchFn ?? defaultFetch;
  }

  /**
   * Führt einen vollständigen lokalen Probe-Lauf durch (AC2, AC3, AC4).
   *
   * Ablauf:
   *   1. docker pull image:tag
   *   2. docker run -d --rm --label dev-gui.local-test=1 --name <uuid> -P image:tag
   *   3. docker inspect → ExposedPorts + Laufstatus
   *   4. Best-Effort HTTP-Reachability gegen 127.0.0.1:<hostPort>
   *   5. docker rm -f <containerName> — immer (try/finally, AC4)
   *
   * @param {string} image   - ghcr-Image-Referenz (ohne Tag), z.B. "ghcr.io/org/app"
   * @param {string} tag     - Tag, z.B. "v1.2.0"
   * @returns {Promise<LocalTestReport>}
   * @throws {{ message: string, errorClass: string }} bei Pull-/Start-Fehler (Container evtl. nie erstellt)
   */
  async runProbe(image, tag) {
    const start = Date.now();
    const imageRef = `${image}:${tag}`;
    const containerName = `dev-gui-local-test-${randomUUID()}`;

    // Phase 1: docker pull (lokal via DOCKER_HOST)
    try {
      await this.#exec('docker', ['pull', imageRef], PULL_TIMEOUT_MS);
    } catch (err) {
      const durationMs = Date.now() - start;
      const pullError = new Error(`Pull fehlgeschlagen: ${sanitizeErrMsg(err?.message)}`);
      pullError.errorClass = 'pull-failed';
      pullError.durationMs = durationMs;
      throw pullError;
    }

    // Phase 2–5: run → inspect → reachability → rm (try/finally-Garantie, AC4)
    let containerStarted = false;
    try {
      // Phase 2: docker run -d --rm=false (wir räumen selbst auf) -P --label --name
      // --rm NICHT verwenden — wir brauchen inspect nach Crash, container bleibt in exited state
      try {
        await this.#exec(
          'docker',
          [
            'run', '-d',
            '-P',                               // ephemeral host-port mapping (zufällig)
            '--label', `${TEST_LABEL_KEY}=${TEST_LABEL_VALUE}`,
            '--name', containerName,
            '--restart', 'no',                  // kein Restart — Wegwerf-Container
            imageRef,
          ],
          EXEC_TIMEOUT_MS,
        );
        containerStarted = true;
      } catch (runErr) {
        const durationMs = Date.now() - start;
        const startError = new Error(`Container-Start fehlgeschlagen: ${sanitizeErrMsg(runErr?.message)}`);
        startError.errorClass = 'start-failed';
        startError.durationMs = durationMs;
        throw startError;
      }

      // Kurz warten — Container braucht einen Moment zum Initialisieren
      await sleep(START_SETTLE_MS);

      // Phase 3: docker inspect — ExposedPorts + Laufstatus
      let inspectData = null;
      try {
        const inspectOut = await this.#exec(
          'docker',
          ['inspect', '--format', '{{json .}}', containerName],
          EXEC_TIMEOUT_MS,
        );
        inspectData = JSON.parse(inspectOut.trim());
      } catch {
        // inspect fehlgeschlagen — Container wird trotzdem aufgeräumt
        inspectData = null;
      }

      const { started, exitedEarly, hostPort, exposedPorts, portReason } = parseInspectData(inspectData);

      // Phase 4: Best-Effort HTTP-Reachability
      let reachable = false;
      let reasonParts = [];
      if (portReason) reasonParts.push(portReason);

      if (hostPort !== null && started) {
        reachable = await this.#probeReachability(hostPort);
      }

      const durationMs = Date.now() - start;

      /** @type {LocalTestReport} */
      const report = {
        started,
        exitedEarly,
        hostPort,
        exposedPorts,
        reachable,
        durationMs,
      };
      if (reasonParts.length > 0) {
        report.reason = reasonParts.join('; ');
      }

      return report;
    } finally {
      // Phase 5: rm -f — immer, unabhängig von Erfolg/Fehler (AC4)
      if (containerStarted) {
        await this.#removeContainer(containerName);
      }
    }
  }

  /**
   * Entfernt den Container per `docker rm -f`.
   * Fehler werden geloggt aber nicht geworfen (Aufräumen darf den Fehler-Pfad nicht maskieren).
   *
   * @param {string} containerName
   */
  async #removeContainer(containerName) {
    try {
      await this.#exec('docker', ['rm', '-f', containerName], EXEC_TIMEOUT_MS);
    } catch (rmErr) {
      // Nur loggen, nie nach oben werfen — Aufräum-Fehler darf Ergebnis nicht verbergen
      console.error(
        `[LocalDockerControl] rm -f ${containerName} fehlgeschlagen:`,
        sanitizeErrMsg(rmErr?.message),
      );
    }
  }

  /**
   * HTTP-GET-Probe gegen 127.0.0.1:<port> (best-effort, AC3).
   * Jeder HTTP-Statuscode → true; Timeout/Refused → false.
   *
   * @param {number} port
   * @returns {Promise<boolean>}
   */
  async #probeReachability(port) {
    try {
      const result = await this.#fetch(`http://127.0.0.1:${port}/`, REACHABILITY_TIMEOUT_MS);
      return result.ok;
    } catch {
      return false;
    }
  }
}

// ── Parse-Helpers ─────────────────────────────────────────────────────────────

/**
 * Parst den JSON-Output von `docker inspect --format '{{json .}}'`.
 * Liefert: started, exitedEarly, hostPort, exposedPorts, portReason.
 *
 * @param {object|null} data
 * @returns {{ started: boolean, exitedEarly: boolean, hostPort: number|null, exposedPorts: number[], portReason: string|null }}
 */
function parseInspectData(data) {
  if (!data) {
    return {
      started: false,
      exitedEarly: false,
      hostPort: null,
      exposedPorts: [],
      portReason: 'docker inspect fehlgeschlagen',
    };
  }

  // Laufstatus
  const stateStatus = data?.State?.Status ?? '';
  const running = stateStatus === 'running';

  // exitedEarly: Container war schon gestoppt oder hat mit Exit-Code != 0 beendet
  const started = running || stateStatus === 'exited'; // hat zumindest angefangen
  const exitedEarly = !running && (stateStatus === 'exited' || stateStatus === 'dead');

  // ExposedPorts aus Config.ExposedPorts (z.B. {"8080/tcp":{}})
  const exposedPortsRaw = data?.Config?.ExposedPorts ?? {};
  const exposedPortKeys = Object.keys(exposedPortsRaw); // z.B. ["8080/tcp", "3000/tcp"]
  const exposedPorts = exposedPortKeys
    .map((k) => parseInt(k.split('/')[0], 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);


  // HostPort aus NetworkSettings.Ports (das echte Mapping)
  // Format: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "49153" }] }
  const portsMap = data?.NetworkSettings?.Ports ?? {};

  let hostPort = null;
  let portReason = null;

  if (exposedPorts.length === 0) {
    portReason = 'kein exponierter Port';
  } else {
    // Wähle den kleinsten exponierten Port und lies seinen gemappten Host-Port
    const primaryContainerPort = exposedPorts[0];
    const portKey = `${primaryContainerPort}/tcp`;
    const mapping = portsMap[portKey];
    const mappedPort = Array.isArray(mapping) && mapping.length > 0
      ? parseInt(mapping[0].HostPort, 10)
      : null;

    if (mappedPort && Number.isFinite(mappedPort)) {
      hostPort = mappedPort;
    } else if (hostPort === null) {
      portReason = `kein TCP-Port-Mapping in ExposedPorts (nur UDP?)`;
    }

    if (exposedPorts.length > 1) {
      const multiReason = `Mehrere exponierte Ports (${exposedPorts.join(', ')}); erster/kleinster (${primaryContainerPort}) wird probiert`;
      portReason = portReason ? `${portReason}; ${multiReason}` : multiReason;
    }
  }

  return { started, exitedEarly, hostPort, exposedPorts, portReason };
}

// ── Default-Fetch (node built-in, timeout via AbortController) ───────────────

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ok:boolean, status:number}>}
 */
async function defaultFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    // Jeder HTTP-Statuscode gilt als erreichbar (AC3)
    return { ok: true, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Entfernt Secret-ähnliche Muster aus Error-Messages (security/R01).
 * @param {string|undefined} msg
 * @returns {string}
 */
function sanitizeErrMsg(msg) {
  if (typeof msg !== 'string') return 'unbekannter Fehler';
  return msg
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/ghp_[A-Za-z0-9]+/g, '[TOKEN REDACTED]')
    .slice(0, 300);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
