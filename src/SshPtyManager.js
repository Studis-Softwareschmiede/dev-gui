/**
 * SshPtyManager — interaktive SSH-PTY-Bridge-Boundary (docs/specs/vps-ssh-terminal.md AC7/AC8/AC10).
 *
 * Geschwister-Boundary von `VpsProvisioner` (ADR-008/ADR-019): `VpsProvisioner` bleibt der
 * EINZIGE Ort für nicht-interaktive SSH-Kommandos (Node-Lib `ssh2`, für idempotentes
 * `authorized_keys`-Schreiben/-Entfernen + Verbindungstests). `SshPtyManager` ist der EINZIGE
 * Ort für interaktive SSH-PTY-Sitzungen (spawnt das echte `ssh`-Binary via `node-pty`, ADR-019
 * — begründet, weil eine volle interaktive Shell (vim/top/less/…) einen echten PTY-getriebenen
 * Client braucht, den `ssh2` nicht bietet). Zwei getrennte, je einzweckige SSH-Linien — kein
 * dritter, ungeschützter SSH-Pfad irgendwo sonst im Code.
 *
 * Jede `open()`-Sitzung = genau ein `ssh`-PTY (kein geteilter Broadcast wie beim Claude-
 * `PtyManager`). WS-Routing/Handshake-Parsing ist NICHT Teil dieser Klasse (docs/specs/
 * vps-ssh-terminal.md AC5/AC6/AC9 → S-263) — diese Boundary bietet nur die programmatische
 * `open({provider, serverId, user, onOutput, onState, onError}) → session`-API.
 *
 * Sicherheit (Floor, hart — AC8):
 *   - Der Private-Key kommt store-intern aus dem `CredentialStore` (`ssh/<user>/private_key`),
 *     wird NIE als HTTP-Antwort/Log/Audit/WS-Nutzlast zurückgegeben.
 *   - `ssh` braucht den Key als Datei (`-i <path>`) — die Datei wird TRANSIENT pro Sitzung in
 *     einem privaten Tempdir angelegt (mode 0600, kein Verzeichnis-Listing für andere User nötig,
 *     da uid-1000-only-Prozess), und bei Sitzungsende (close/Idle-Timeout/Fehler) ENTFERNT.
 *   - Der Key-Inhalt erscheint NIE im Argv (nur der Dateipfad wird an `ssh -i` übergeben).
 *
 * Host-Key-Policy (dokumentiert — AC10, HART, kein pauschales StrictHostKeyChecking=no):
 *   `-o StrictHostKeyChecking=accept-new` + `-o UserKnownHostsFile=<persistierter Pfad>`.
 *   Ein bislang unbekannter Host-Key wird beim ersten Connect akzeptiert und im persistierten
 *   `known_hosts` gemerkt (TOFU); ändert sich der Host-Key eines bereits bekannten Ziels
 *   danach, lehnt `ssh` die Verbindung ab (`REMOTE HOST IDENTIFICATION HAS CHANGED`) — wir
 *   klassifizieren das aus dem PTY-Output als `host-key-mismatch`, KEIN stiller Auto-Accept.
 *   `known_hosts` liegt im dedizierten Credential-Volume (`CRED_STORE_DIR`, node-owned, uid
 *   1000, mode 0700 laut Dockerfile) — persistiert über Container-Neustarts hinweg.
 *
 * Lebenszyklus / Cap (AC7):
 *   - `open()` validiert (User-Allowlist, Sitzungs-Cap, Ziel-Auflösung, Key-Vorhandensein)
 *     BEVOR irgendein PTY gespawnt wird — jede Ablehnung ist spawn-frei.
 *   - WS-Close (vom Aufrufer über `session.close()` signalisiert) ODER Idle-Timeout beendet
 *     den `ssh`-PTY (`kill()`) und räumt die transiente Key-Datei auf.
 *   - Eine konfigurierbare Obergrenze paralleler Sitzungen (`SSH_PTY_SESSION_CAP`) wird
 *     durchgesetzt; darüber → geheimnisfreie Ablehnung, kein Spawn, kein Ressourcen-Leck.
 *
 * Fehlerklassen (docs/specs/vps-ssh-terminal.md Verträge, alle geheimnisfrei):
 *   no-target | no-private-key | unreachable | auth-failed | host-key-mismatch | error
 *
 * @module SshPtyManager
 */

import { spawn as ptySpawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { open as fsOpen, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Erlaubte SSH-Ziel-User (AC6-Vorgriff — Boundary validiert unabhängig vom Aufrufer). */
const ALLOWED_USERS = ['root', 'alex'];

/** Default-Obergrenze paralleler ssh-PTY-Sitzungen (überschreibbar via SSH_PTY_SESSION_CAP). */
const DEFAULT_CAP = 5;

/** Default-Idle-Timeout in ms — 15 Minuten (überschreibbar via SSH_PTY_IDLE_TIMEOUT_MS). */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** SSH-Connect-Timeout in Sekunden (ssh -o ConnectTimeout=…). */
const SSH_CONNECT_TIMEOUT_S = 15;

/** Wie viele Bytes des PTY-Outputs für die Exit-Fehlerklassifikation vorgehalten werden. */
const CLASSIFY_BUFFER_LIMIT = 8192;

/**
 * Default-Credential-Volume-Pfad — identisch zum `CRED_STORE_DIR`-Default in
 * `CredentialStore.js` und zum Mountpoint in `docker-compose.yml`
 * (dediziertes `dev-gui-cred`-Volume, node-owned uid 1000, mode 0700 laut
 * Dockerfile). Nur als Fallback relevant, wenn `CRED_STORE_DIR` nicht gesetzt ist.
 */
const DEFAULT_CRED_STORE_DIR = '/home/node/.cred';

/**
 * @typedef {'no-target'|'no-private-key'|'unreachable'|'auth-failed'|'host-key-mismatch'|'error'} SshErrorClass
 */

/**
 * @typedef {object} SshSession
 * @property {string} id
 * @property {(data: string) => void} write
 * @property {(cols: number, rows: number) => void} resize
 * @property {() => Promise<void>} close
 */

export class SshPtyManager {
  /** @type {import('./CredentialStore.js').CredentialStore} */
  #credentialStore;

  /** @type {(provider: string, serverId: string) => Promise<{host: string, port?: number}|null>} */
  #resolveTarget;

  /** @type {Function} testbare PTY-Spawn-Fabrik (Default: node-pty spawn) */
  #spawnFn;

  /** @type {number} */
  #cap;

  /** @type {number} */
  #idleTimeoutMs;

  /** @type {string} Pfad zur persistierten known_hosts-Datei (AC10). */
  #knownHostsPath;

  /** @type {string} Verzeichnis für transiente Key-Dateien (AC8). */
  #tmpKeyDir;

  /** @type {Map<string, object>} sessionId → interner Sitzungs-State */
  #sessions = new Map();

  /**
   * @param {object} params
   * @param {import('./CredentialStore.js').CredentialStore} params.credentialStore
   * @param {(provider: string, serverId: string) => Promise<{host: string, port?: number}|null>} params.resolveTarget
   *   Serverseitige Ziel-Auflösung (docs/specs/vps-dynamic-ssh-targets.md `resolveVpsTarget`).
   *   `null` → `no-target`, kein Spawn. Der `targetUser` des aufgelösten Ziels wird NICHT
   *   verwendet — der SSH-User kommt ausschließlich aus dem `open()`-Parameter `user` (AC6).
   * @param {Function} [params.spawnFn] - Testbare PTY-Spawn-Fabrik (Default: `node-pty`.spawn).
   * @param {number} [params.cap] - Obergrenze paralleler Sitzungen (Default: SSH_PTY_SESSION_CAP env oder 5).
   * @param {number} [params.idleTimeoutMs] - Idle-Timeout in ms (Default: SSH_PTY_IDLE_TIMEOUT_MS env oder 900000).
   * @param {string} [params.knownHostsPath] - Pfad zur persistierten known_hosts-Datei (Default: <CRED_STORE_DIR>/ssh_known_hosts).
   * @param {string} [params.tmpKeyDir] - Verzeichnis für transiente Key-Dateien (Default: os.tmpdir()/devgui-ssh-pty-keys).
   */
  constructor({
    credentialStore,
    resolveTarget,
    spawnFn = ptySpawn,
    cap,
    idleTimeoutMs,
    knownHostsPath,
    tmpKeyDir,
  } = {}) {
    if (!credentialStore || typeof credentialStore.getPlaintext !== 'function') {
      throw new Error('[SshPtyManager] credentialStore ist Pflicht');
    }
    if (typeof resolveTarget !== 'function') {
      throw new Error('[SshPtyManager] resolveTarget ist Pflicht');
    }
    this.#credentialStore = credentialStore;
    this.#resolveTarget = resolveTarget;
    this.#spawnFn = spawnFn;
    this.#cap = parsePositiveInt(cap ?? process.env.SSH_PTY_SESSION_CAP, DEFAULT_CAP);
    this.#idleTimeoutMs = parsePositiveInt(
      idleTimeoutMs ?? process.env.SSH_PTY_IDLE_TIMEOUT_MS,
      DEFAULT_IDLE_TIMEOUT_MS,
    );
    this.#knownHostsPath = knownHostsPath
      ?? join(process.env.CRED_STORE_DIR?.trim() || DEFAULT_CRED_STORE_DIR, 'ssh_known_hosts');
    this.#tmpKeyDir = tmpKeyDir ?? join(tmpdir(), 'devgui-ssh-pty-keys');
  }

  /** Anzahl aktuell aktiver Sitzungen (für Cap-Tests/Diagnose). */
  get activeSessionCount() {
    return this.#sessions.size;
  }

  /**
   * Öffnet eine neue ssh-PTY-Sitzung für {provider, serverId, user}.
   * Validiert VOR jedem Spawn (User-Allowlist, Cap, Ziel-Auflösung, Key-Vorhandensein) —
   * jede Ablehnung ruft `onError(errorClass, reason)` auf und spawnt NICHTS (AC6/AC7/AC8).
   *
   * @param {object} params
   * @param {string} params.provider
   * @param {string} params.serverId
   * @param {string} params.user - MUSS "root" oder "alex" sein.
   * @param {(data: string) => void} params.onOutput - Byteweiser PTY-Output (ANSI erhalten).
   * @param {(state: 'connecting'|'connected'|'disconnected') => void} params.onState
   * @param {(errorClass: SshErrorClass, reason: string) => void} params.onError - Geheimnisfrei.
   * @returns {Promise<SshSession|null>} `null` wenn abgelehnt (kein Spawn erfolgt).
   */
  async open({ provider, serverId, user, onOutput, onState, onError }) {
    const emitError = (errorClass, reason) => {
      if (typeof onError === 'function') onError(errorClass, reason);
    };
    const emitState = (state) => {
      if (typeof onState === 'function') onState(state);
    };
    const emitOutput = (data) => {
      if (typeof onOutput === 'function') onOutput(data);
    };

    // ── 1. User-Allowlist (AC6-Vorgriff) — kein Spawn bei unbekanntem/leerem User ──
    if (typeof user !== 'string' || !ALLOWED_USERS.includes(user)) {
      emitError('error', 'Ungültiger SSH-Benutzer');
      return null;
    }

    // ── 2. Sitzungs-Cap (AC7) + SOFORTIGE synchrone Slot-Reservierung ──
    // Wichtig (Race-Fix, live reproduziert): der Cap-Check MUSS den Sitzungs-Slot
    // SYNCHRON reservieren, direkt im selben Tick wie die Prüfung — vor jedem
    // `await` (resolveTarget/getPlaintext/mkdir/writeTransientFile). Würde der
    // Record erst NACH diesen awaits in #sessions landen, sehen mehrere parallele
    // `open()`-Aufrufe (z.B. via Promise.all) alle denselben (noch leeren)
    // #sessions-Stand und die Cap-Prüfung greift nicht (Ressourcen-Erschöpfung).
    // Da JS-Funktionen synchron bis zum ersten `await` laufen, ist Cap-Check +
    // `#sessions.set(...)` hier eine atomare Einheit — kein anderer `open()`-Aufruf
    // kann dazwischen laufen.
    if (this.#sessions.size >= this.#cap) {
      emitError('error', 'Sitzungslimit erreicht');
      return null;
    }
    const sessionId = randomUUID();
    const record = {
      id: sessionId,
      pty: null,
      keyPath: null,
      closed: false,
      outputBuffer: '',
      idleTimer: null,
    };
    this.#sessions.set(sessionId, record);

    // Jeder Abbruchpfad AB HIER muss den reservierten Slot wieder freigeben.
    const abort = (errorClass, reason) => {
      this.#sessions.delete(sessionId);
      emitError(errorClass, reason);
      return null;
    };

    // ── 3. Ziel-Auflösung (resolveVpsTarget) — null → no-target, kein Spawn ──
    let target;
    try {
      target = await this.#resolveTarget(provider, serverId);
    } catch {
      target = null;
    }
    if (!target || !target.host) {
      return abort('no-target', 'SSH-Ziel nicht auflösbar');
    }

    // ── 4. Private-Key store-intern laden (AC8) — kein Spawn ohne Key ──
    let privateKey;
    try {
      privateKey = await this.#credentialStore.getPlaintext(`ssh/${user}/private_key`);
    } catch {
      privateKey = null;
    }
    if (!privateKey) {
      return abort('no-private-key', `Kein SSH-Private-Key für Benutzer "${user}" hinterlegt`);
    }

    // ── 5. Transiente Key-Datei anlegen (mode 0600, AC8) ──
    // Ab hier verlässt der Key-Klartext diese Funktion nicht mehr — nur der Pfad wird
    // an ssh übergeben (Argv enthält NIE den Key-Inhalt); `privateKey` wird nach diesem
    // Block nicht mehr gelesen.
    const keyPath = join(this.#tmpKeyDir, `${sessionId}.key`);
    try {
      await mkdir(this.#tmpKeyDir, { recursive: true, mode: 0o700 });
      await writeTransientFile(keyPath, privateKey);
    } catch {
      return abort('error', 'Transiente Key-Datei konnte nicht angelegt werden');
    }
    record.keyPath = keyPath;

    // known_hosts-Verzeichnis sicherstellen (persistiert, AC10) — best-effort.
    try {
      await mkdir(dirnameOf(this.#knownHostsPath), { recursive: true, mode: 0o700 });
    } catch (err) {
      // Degradierend — ssh selbst schlägt dann ggf. mit 'error' fehl (kein Crash hier).
      // Secret-frei geloggt (nur Fehlercode/-message, kein Pfadinhalt mit Nutzdaten).
      console.warn(
        '[SshPtyManager] known_hosts-Verzeichnis konnte nicht angelegt werden:',
        err?.code ?? err?.message ?? 'unbekannter Fehler',
      );
    }

    // ── 6. PTY spawnen (kein Key-Inhalt im Argv — nur der Dateipfad) ──
    const args = buildSshArgs({
      host: target.host,
      port: target.port ?? 22,
      user,
      keyPath,
      knownHostsPath: this.#knownHostsPath,
    });

    emitState('connecting');

    let pty;
    try {
      pty = this.#spawnFn('ssh', args, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        env: buildChildEnv(),
      });
    } catch {
      this.#sessions.delete(sessionId);
      await cleanupKeyFile(keyPath);
      emitError('error', 'ssh-Start fehlgeschlagen');
      return null;
    }

    record.pty = pty;

    const touchActivity = () => this.#scheduleIdleTimeout(record);

    pty.onData((data) => {
      emitOutput(data);
      record.outputBuffer = (record.outputBuffer + data).slice(-CLASSIFY_BUFFER_LIMIT);
      touchActivity();
    });

    pty.onExit(({ exitCode } = {}) => {
      if (record.closed) return;
      if (exitCode) {
        const errorClass = classifyExitOutput(record.outputBuffer);
        emitError(errorClass, sanitizeReason(errorClass));
      }
      this.#closeSession(sessionId, { killPty: false }).then(() => emitState('disconnected'));
    });

    emitState('connected');
    touchActivity();

    return {
      id: sessionId,
      write: (data) => {
        if (record.closed || typeof data !== 'string') return;
        record.pty.write(data);
        touchActivity();
      },
      resize: (cols, rows) => {
        if (record.closed || !isPositiveInt(cols) || !isPositiveInt(rows)) return;
        record.pty.resize(cols, rows);
        touchActivity();
      },
      close: async () => {
        await this.#closeSession(sessionId, { killPty: true });
        emitState('disconnected');
      },
    };
  }

  /**
   * Beendet eine Sitzung: killt den PTY (falls noch nötig), räumt die transiente
   * Key-Datei auf, löscht den Idle-Timer, entfernt den Session-Record.
   * Idempotent — ein zweiter Aufruf für dieselbe sessionId ist ein No-Op.
   *
   * @param {string} sessionId
   * @param {{killPty: boolean}} opts
   * @returns {Promise<void>}
   */
  async #closeSession(sessionId, { killPty }) {
    const record = this.#sessions.get(sessionId);
    if (!record || record.closed) return;
    record.closed = true;

    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = null;
    }

    if (killPty) {
      try {
        record.pty.kill();
      } catch {
        // Prozess evtl. bereits beendet — ignorieren.
      }
    }

    this.#sessions.delete(sessionId);
    await cleanupKeyFile(record.keyPath);
  }

  /**
   * Setzt den Idle-Timeout für eine Sitzung zurück (aufgerufen bei jeder Aktivität:
   * Input, Resize, Output vom PTY).
   * @param {object} record
   */
  #scheduleIdleTimeout(record) {
    if (record.closed) return;
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = setTimeout(() => {
      this.#closeSession(record.id, { killPty: true });
    }, this.#idleTimeoutMs);
    // Timer soll den Prozess nicht am Beenden hindern (Node-Test-Runner-Hygiene).
    if (typeof record.idleTimer.unref === 'function') record.idleTimer.unref();
  }
}

// ── Hilfsfunktionen (module-private) ────────────────────────────────────────────

/**
 * Baut die ssh-Argv-Liste. Enthält NIE Key-Inhalt — nur den Pfad zur transienten
 * Key-Datei (`-i`). Host-Key-Policy (AC10) explizit sichtbar im Aufruf:
 *   -o StrictHostKeyChecking=accept-new  → TOFU auf neue Hosts, Ablehnung bei Änderung.
 *   -o UserKnownHostsFile=<persistiert>  → kein Auto-Discard nach Prozessende.
 *   -o BatchMode=yes                     → kein Passwort-Fallback-Prompt (nur Key-Auth).
 *
 * @param {{host: string, port: number, user: string, keyPath: string, knownHostsPath: string}} p
 * @returns {string[]}
 */
function buildSshArgs({ host, port, user, keyPath, knownHostsPath }) {
  return [
    '-tt',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    `-o`, `UserKnownHostsFile=${knownHostsPath}`,
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    '-i', keyPath,
    '-p', String(port),
    `${user}@${host}`,
  ];
}

/**
 * Baut eine minimale, secret-freie Child-Env für den ssh-Prozess (Allowlist statt Spread —
 * analog PtyManager AC3: kein Secret aus dem Parent-Prozess leakt in den Kindprozess).
 * @returns {Record<string,string>}
 */
function buildChildEnv() {
  const ALLOWED_ENV_KEYS = ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  const env = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.TERM = 'xterm-color';
  return env;
}

/**
 * Klassifiziert einen fehlgeschlagenen ssh-Exit anhand des gepufferten PTY-Outputs.
 * Bewusst auf Standard-OpenSSH-Meldungen gestützt (geheimnisfrei — reiner Text-Match,
 * kein Secret im Buffer, da der Key-Inhalt nie in den PTY-Stream gelangt).
 *
 * @param {string} buffer
 * @returns {SshErrorClass}
 */
function classifyExitOutput(buffer) {
  const text = (buffer || '').toLowerCase();
  if (
    text.includes('remote host identification has changed') ||
    text.includes('host key verification failed')
  ) {
    return 'host-key-mismatch';
  }
  if (text.includes('permission denied') || text.includes('authentication failed')) {
    return 'auth-failed';
  }
  if (
    text.includes('connection refused') ||
    text.includes('no route to host') ||
    text.includes('could not resolve hostname') ||
    text.includes('connection timed out') ||
    text.includes('operation timed out') ||
    text.includes('network is unreachable')
  ) {
    return 'unreachable';
  }
  return 'error';
}

/**
 * Liefert eine geheimnisfreie, verständliche Fehlermeldung je Fehlerklasse.
 * @param {SshErrorClass} errorClass
 * @returns {string}
 */
function sanitizeReason(errorClass) {
  switch (errorClass) {
    case 'host-key-mismatch':
      return 'SSH-Host-Key hat sich geändert (möglicher MITM) — Verbindung abgelehnt';
    case 'auth-failed':
      return 'SSH-Authentifizierung fehlgeschlagen';
    case 'unreachable':
      return 'VPS-Ziel nicht erreichbar';
    default:
      return 'SSH-Sitzung unerwartet beendet';
  }
}

/**
 * Schreibt eine Datei mit exklusivem mode 0600 (analog CredentialStore-Konvention).
 * @param {string} path
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeTransientFile(path, content) {
  const fh = await fsOpen(path, 'w', 0o600);
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Entfernt die transiente Key-Datei. Idempotent — ENOENT wird ignoriert.
 * @param {string} keyPath
 * @returns {Promise<void>}
 */
async function cleanupKeyFile(keyPath) {
  try {
    await unlink(keyPath);
  } catch {
    // Datei evtl. bereits entfernt — kein Fehler.
  }
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function dirnameOf(filePath) {
  const idx = filePath.lastIndexOf('/');
  return idx <= 0 ? '/' : filePath.slice(0, idx);
}

/**
 * Parst einen env-/Options-Wert als positiven Integer, mit Fallback bei Absenz/NaN.
 * @param {string|number|undefined} raw
 * @param {number} defaultVal
 * @returns {number}
 */
function parsePositiveInt(raw, defaultVal) {
  if (raw === undefined || raw === null || raw === '') return defaultVal;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultVal;
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isPositiveInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}
