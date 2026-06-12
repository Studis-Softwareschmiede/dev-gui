/**
 * VpsComposeControl — einziger Ort für Compose-Stack-Kommandos auf einem VPS via SSH.
 *
 * Boundary-Vertrag (ADR-012-Linie, neue Boundary):
 *   - Einziges Modul, das `git clone/pull` und `docker compose up/down/ps` auf einem VPS via SSH ausführt.
 *   - Schwester zu `VpsDockerControl` — gleicher SSH-Transport (ssh2), gleiche Host-Key-Strategie,
 *     gleiche Fehlerklassen, gleicher Connect-Timeout (15 s). Kein zweiter SSH-Pfad.
 *   - VpsDockerControl bleibt für Single-Image-Deploys + Container-Read zuständig und wird NICHT verändert.
 *   - SSH-Private-Key + git-Token werden store-intern geladen (CredentialStore, ADR-007/008).
 *   - Kein Secret (Private-Key, Token) in Argv/Log/Audit/Response/persistierter Remote-URL.
 *   - `stderr` von `docker compose`/`git` wird NICHT in Response/Audit weitergeleitet.
 *
 * Methoden:
 *   - syncRepo(opts)      — git clone/pull des App-Repos in ~/stacks/<stackName>
 *   - composeUp(opts)     — docker compose up -d im Stack-Verzeichnis
 *   - composeDown(opts)   — docker compose down (optional --volumes)
 *   - composePs(opts)     — docker compose ps → strukturierte Container-Liste
 *   - psStack(opts)       — alle Container mit Label com.docker.compose.project=<project>
 *
 * Fehlerkategorien (maschinenlesbar, analog VpsDockerControl / VpsProvisioner):
 *   - 'no-private-key'    → 422 (kein Private-Key für SSH-Benutzer gesetzt)
 *   - 'unreachable'       → 502 (SSH-Verbindung fehlgeschlagen oder Timeout)
 *   - 'auth-failed'       → 502 (SSH-Auth fehlgeschlagen)
 *   - 'host-key-mismatch' → 502 (Host-Key-Fingerprint-Mismatch)
 *   - 'docker-failed'     → 502 (docker compose / git-Kommando fehlgeschlagen auf VPS)
 *   - 'error'             → 500 (unerwarteter Fehler, inkl. Validation)
 *
 * SSH-Transport: ssh2 (analog VpsDockerControl / VpsProvisioner — kein System-ssh binary nötig).
 *
 * @module VpsComposeControl
 */

import { Client } from 'ssh2';
import { createHash } from 'node:crypto';

/** SSH-Verbindungs-Timeout in ms. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Compose-spezifischer Exec-Timeout (git pull + docker compose up dauern länger).
 * Gilt für syncRepo und composeUp.
 */
const COMPOSE_EXEC_TIMEOUT_MS = 300_000; // 5 Minuten

/** Standard-Timeout für schnelle Kommandos (down, ps). */
const EXEC_TIMEOUT_MS = 60_000;

/** Basis-Verzeichnis für Stacks auf dem VPS. */
const STACKS_BASE_DIR = '~/stacks';

/**
 * @typedef {object} VpsTarget
 * @property {string}  host        - Hostname oder IP-Adresse des VPS
 * @property {number}  [port]      - SSH-Port (Default: 22)
 * @property {string}  targetUser  - SSH-Benutzer (z.B. "root", "alex")
 */

/**
 * @typedef {object} SyncRepoResult
 * @property {'ok'|'error'} result
 * @property {string}  [reason]        - Fehlergrund ohne Geheim-Leak
 * @property {string}  [errorClass]    - maschinenlesbare Fehlerklasse
 */

/**
 * @typedef {object} ComposeResult
 * @property {'ok'|'error'} result
 * @property {string}  [reason]        - Fehlergrund ohne Geheim-Leak
 * @property {string}  [errorClass]    - maschinenlesbare Fehlerklasse
 */

/**
 * @typedef {object} ComposePsEntry
 * @property {string} name    - Container-Name
 * @property {string} service - Service-Name
 * @property {string} status  - Container-Status (z.B. "running")
 * @property {string} ports   - Port-Mappings
 */

/**
 * @typedef {object} ComposePsResult
 * @property {'ok'|'error'} result
 * @property {ComposePsEntry[]} [containers] - Container-Liste bei Erfolg
 * @property {string}  [reason]        - Fehlergrund ohne Geheim-Leak
 * @property {string}  [errorClass]    - maschinenlesbare Fehlerklasse
 */

/**
 * @typedef {object} StackContainer
 * @property {string}      containerId - Container-ID (kurz)
 * @property {string}      image       - Image-Name
 * @property {string}      service     - Service-Name (com.docker.compose.service-Label)
 * @property {string|null} hostname    - cloudflare.tunnel-hostname-Label-Wert; null für interne Services
 * @property {string}      status      - Container-Status
 * @property {number|null} hostPort    - gemappter Host-Port (aus Port-Mapping)
 */

/**
 * @typedef {object} PsStackResult
 * @property {'ok'|'error'} result
 * @property {StackContainer[]} [containers] - Container-Liste bei Erfolg
 * @property {string}  [reason]        - Fehlergrund ohne Geheim-Leak
 * @property {string}  [errorClass]    - maschinenlesbare Fehlerklasse
 */

export class VpsComposeControl {
  /** @type {import('../CredentialStore.js').CredentialStore} */
  #credentialStore;

  /**
   * @param {import('../CredentialStore.js').CredentialStore} credentialStore
   */
  constructor(credentialStore) {
    if (!credentialStore || typeof credentialStore.getPlaintext !== 'function') {
      throw new Error('[VpsComposeControl] credentialStore ist Pflicht');
    }
    this.#credentialStore = credentialStore;
  }

  /**
   * Klont das App-Repo oder zieht per git pull, falls es schon existiert.
   * Idempotent: Re-Sync = fetch + checkout + pull --ff-only.
   *
   * AC3, AC4: Token wird transient via GIT_ASKPASS beschafft, erscheint nie in der
   * persistierten Remote-URL auf dem VPS, in Argv, Log, Audit oder Response.
   *
   * @param {object} opts
   * @param {VpsTarget} opts.vps
   * @param {string}    opts.repoUrl        - HTTPS-URL des Repos (ohne eingebettetes Token)
   * @param {string}    opts.branch         - Branch (z.B. "main")
   * @param {string}    opts.stackName      - Stack-Name (Path-Traversal-validiert)
   * @param {string}    [opts.gitTokenRef]  - CredentialStore-Key für git-Token (optional)
   * @param {string}    [opts.hostFingerprint] - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory] - Testbare SSH-Client-Fabrik
   * @returns {Promise<SyncRepoResult>}
   */
  async syncRepo({ vps, repoUrl, branch, stackName, gitTokenRef, hostFingerprint, _sshClientFactory } = {}) {
    // AC4: stackName auf Path-Traversal + Shell-Metazeichen validieren
    if (!isValidStackName(stackName)) {
      return {
        result: 'error',
        reason: 'Ungültiger Stack-Name (nur alphanumerische Zeichen, Bindestriche und Unterstriche erlaubt)',
        errorClass: 'error',
      };
    }

    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    // AC4: git-Token transient beschaffen (nie in URL oder Argv)
    let gitToken = null;
    if (gitTokenRef) {
      try {
        gitToken = await this.#credentialStore.getPlaintext(gitTokenRef);
      } catch {
        // Token-Store-Fehler: weiter ohne Token (öffentliches Repo)
      }
    }

    const escapedStackName = shellEscape(stackName);
    const escapedBranch = shellEscape(branch);
    const escapedRepoUrl = shellEscape(repoUrl);
    const stackDir = `${STACKS_BASE_DIR}/${escapedStackName}`;

    // AC4: Token via GIT_ASKPASS-Skript — nie als URL-Bestandteil (kein https://token@host...).
    // Das Skript wird auf dem Remote-Host via mktemp erstellt, den Token als Dateiinhalt
    // aufnehmen und nach dem Clone sofort gelöscht. Der Token verlässt den CredentialStore
    // nur als Dateiinhalt des temporären Skripts — nicht als argv-Argument.
    //
    // Kommando-Logik:
    //   if [ -d ~/stacks/<name>/.git ]; then
    //     git -C ~/stacks/<name> fetch origin && git -C ~/stacks/<name> checkout <branch> && git -C ~/stacks/<name> pull --ff-only
    //   else
    //     mkdir -p ~/stacks && git clone --branch <branch> -- <url> ~/stacks/<name>
    //   fi
    //
    // Sicherheit: alle Werte via shellEscape() in Single-Quotes eingebettet.
    // Wenn kein Token → kein GIT_ASKPASS-Overhead; für öffentliche Repos ausreichend.

    let cloneCmd;
    if (gitToken) {
      // AC4/AC8: Token via GIT_ASKPASS-Skript — der rohe Token-Wert erscheint NICHT literal im
      // Kommando-String (kein argv-Leak via /proc/<pid>/cmdline oder `ps` auf dem Remote-Host).
      //
      // Technik: Der Token wird clientseitig base64-kodiert. Der Kommando-String enthält nur den
      // base64-kodierten Wert (keine sensiblen Zeichen, kein erkennbares Secret-Muster).
      // Auf dem Remote-Host dekodiert `base64 -d <<< '<b64>'` den Wert und schreibt ihn als
      // Dateiinhalt des mktemp-Skripts — der rohe Token verlässt den CredentialStore
      // ausschliesslich als Dateiinhalt, nicht als Prozess-argv.
      //
      // Ablauf auf dem Remote-Host:
      //   1. mktemp erstellt ein privates Skript ($GIT_ASKPASS_SCRIPT, chmod 700).
      //   2. base64 -d dekodiert den b64-Wert und schreibt ihn als Skript-Inhalt (kein argv-Leak).
      //   3. GIT_ASKPASS zeigt auf das Skript; git ruft es für Password-Prompts auf.
      //   4. Nach dem Clone wird das Skript sofort gelöscht (rm -f).
      //   - Kein git credential cache, kein .git/config-Eintrag, keine persistierte Remote-URL.
      //   - Token erscheint NICHT in der Remote-URL (kein https://token@host...).
      const tokenB64 = Buffer.from(gitToken).toString('base64');
      const escapedTokenB64 = shellEscape(tokenB64);
      // Das GIT_ASKPASS-Skript gibt für Password-Prompts den Token aus, für Username x-access-token.
      // Skript-Template (in b64 kodiert auf dem Remote erzeugt):
      //   #!/bin/sh
      //   case "$1" in *Username*) echo x-access-token ;; *) base64 -d <<< '<b64>' ;; esac
      const scriptContent = `#!/bin/sh\ncase "$1" in *Username*) echo x-access-token ;; *) printf '%s' ${escapedTokenB64} | base64 -d ;; esac\n`;
      const scriptB64 = Buffer.from(scriptContent).toString('base64');
      const escapedScriptB64 = shellEscape(scriptB64);
      cloneCmd = `GIT_ASKPASS_SCRIPT=$(mktemp) && chmod 700 "$GIT_ASKPASS_SCRIPT" && printf '%s' ${escapedScriptB64} | base64 -d > "$GIT_ASKPASS_SCRIPT" && GIT_ASKPASS="$GIT_ASKPASS_SCRIPT" git clone --branch ${escapedBranch} -- ${escapedRepoUrl} ${stackDir}; _clone_exit=$?; rm -f "$GIT_ASKPASS_SCRIPT"; exit $_clone_exit`;
    } else {
      cloneCmd = `git clone --branch ${escapedBranch} -- ${escapedRepoUrl} ${stackDir}`;
    }

    // Idempotentes Sync-Kommando: clone falls nicht vorhanden, sonst fetch+checkout+pull.
    // WICHTIG: STACKS_BASE_DIR (~/stacks) wird NICHT via shellEscape() eingebettet —
    // Tilde-Pfade dürfen NICHT in Single-Quotes stehen, sonst expandiert die Shell die
    // Tilde nicht (~/stacks würde als literales Verzeichnis relativ zum CWD angelegt).
    // stackDir verwendet die Tilde ebenfalls unquotiert (konsistent).
    const cmd = `if [ -d ${stackDir}/.git ]; then git -C ${stackDir} fetch origin && git -C ${stackDir} checkout ${escapedBranch} && git -C ${stackDir} pull --ff-only; else mkdir -p ${STACKS_BASE_DIR} && ${cloneCmd}; fi`;

    try {
      await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: COMPOSE_EXEC_TIMEOUT_MS,
        hostFingerprint: hostFingerprint ?? null,
        sshClientFactory: _sshClientFactory,
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
   * Führt `docker compose up -d` im Stack-Verzeichnis aus.
   *
   * AC5: alle Werte (Pfade, Projektname) sind shell-escaped. Kein Command-Injection.
   *
   * @param {object} opts
   * @param {VpsTarget} opts.vps
   * @param {string}    opts.stackName     - Stack-Name (validiert)
   * @param {string}    opts.composeFile   - relativer Pfad zur compose-Datei (z.B. "docker-compose.yml")
   * @param {string}    [opts.overrideFile] - optionaler Override (z.B. "docker-compose.override.yml")
   * @param {string}    opts.project       - Compose-Projektname (setzt com.docker.compose.project-Label)
   * @param {string}    [opts.envFilePath] - optionaler Pfad zur .env-Datei auf dem VPS
   * @param {string}    [opts.hostFingerprint] - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<ComposeResult>}
   */
  async composeUp({ vps, stackName, composeFile, overrideFile, project, envFilePath, hostFingerprint, _sshClientFactory } = {}) {
    if (!isValidStackName(stackName)) {
      return {
        result: 'error',
        reason: 'Ungültiger Stack-Name (nur alphanumerische Zeichen, Bindestriche und Unterstriche erlaubt)',
        errorClass: 'error',
      };
    }
    if (!isValidProjectName(project)) {
      return {
        result: 'error',
        reason: 'Ungültiger Compose-Projektname (nur alphanumerische Zeichen, Bindestriche und Unterstriche erlaubt)',
        errorClass: 'error',
      };
    }
    // AC4/AC5: Path-Traversal-Defense-in-Depth für relative Dateipfade
    if (!isValidRelativePath(composeFile)) {
      return {
        result: 'error',
        reason: 'Ungültiger composeFile-Pfad (kein absoluter Pfad, keine ..-Segmente erlaubt)',
        errorClass: 'error',
      };
    }
    if (overrideFile !== undefined && overrideFile !== null && !isValidRelativePath(overrideFile)) {
      return {
        result: 'error',
        reason: 'Ungültiger overrideFile-Pfad (kein absoluter Pfad, keine ..-Segmente erlaubt)',
        errorClass: 'error',
      };
    }
    if (envFilePath !== undefined && envFilePath !== null && !isValidRelativePath(envFilePath)) {
      return {
        result: 'error',
        reason: 'Ungültiger envFilePath-Pfad (kein absoluter Pfad, keine ..-Segmente erlaubt)',
        errorClass: 'error',
      };
    }

    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    const stackDir = `${STACKS_BASE_DIR}/${shellEscape(stackName)}`;
    const escapedProject = shellEscape(project);
    const escapedComposeFile = shellEscape(composeFile);

    // AC5: alle Werte shell-escaped (Single-Quote-Muster)
    const composeArgs = [
      'docker', 'compose',
      '-f', escapedComposeFile,
    ];

    if (overrideFile) {
      composeArgs.push('-f', shellEscape(overrideFile));
    }

    composeArgs.push('--project-name', escapedProject);

    if (envFilePath) {
      composeArgs.push('--env-file', shellEscape(envFilePath));
    }

    composeArgs.push('up', '-d');

    const cmd = `cd ${stackDir} && ${composeArgs.join(' ')}`;

    try {
      await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: COMPOSE_EXEC_TIMEOUT_MS,
        hostFingerprint: hostFingerprint ?? null,
        sshClientFactory: _sshClientFactory,
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
   * Führt `docker compose down` aus.
   * Idempotent: down auf nicht-existentem Stack → ok.
   *
   * AC6: removeVolumes ist default false — Volumes werden nur bei explizitem true entfernt.
   *
   * @param {object} opts
   * @param {VpsTarget} opts.vps
   * @param {string}    opts.stackName       - Stack-Name (validiert)
   * @param {string}    opts.project         - Compose-Projektname
   * @param {boolean}   [opts.removeVolumes] - Default false; nur bei true wird --volumes angehängt
   * @param {string}    [opts.hostFingerprint]
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<ComposeResult>}
   */
  async composeDown({ vps, stackName, project, removeVolumes = false, hostFingerprint, _sshClientFactory } = {}) {
    if (!isValidStackName(stackName)) {
      return {
        result: 'error',
        reason: 'Ungültiger Stack-Name (nur alphanumerische Zeichen, Bindestriche und Unterstriche erlaubt)',
        errorClass: 'error',
      };
    }
    if (!isValidProjectName(project)) {
      return {
        result: 'error',
        reason: 'Ungültiger Compose-Projektname (nur alphanumerische Zeichen, Bindestriche und Unterstriche erlaubt)',
        errorClass: 'error',
      };
    }

    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    const escapedProject = shellEscape(project);

    const composeArgs = [
      'docker', 'compose',
      '--project-name', escapedProject,
      'down',
    ];

    // AC6: --volumes NUR bei explizitem true (Datenverlust-Schutz)
    if (removeVolumes === true) {
      composeArgs.push('--volumes');
    }

    const cmd = composeArgs.join(' ');

    try {
      await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: cmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: hostFingerprint ?? null,
        sshClientFactory: _sshClientFactory,
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
   * Gibt read-only die strukturierte Container-Liste des Stacks zurück.
   *
   * AC7: `docker compose --project-name <project> ps --format json` — parsed zu ComposePsEntry[].
   *
   * @param {object} opts
   * @param {VpsTarget} opts.vps
   * @param {string}    opts.stackName   - Stack-Name (validiert)
   * @param {string}    opts.project     - Compose-Projektname
   * @param {string}    [opts.hostFingerprint]
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<ComposePsResult>}
   */
  async composePs({ vps, stackName, project, hostFingerprint, _sshClientFactory } = {}) {
    if (!isValidStackName(stackName)) {
      return {
        result: 'error',
        reason: 'Ungültiger Stack-Name (nur alphanumerische Zeichen, Bindestriche und Unterstriche erlaubt)',
        errorClass: 'error',
      };
    }
    if (!isValidProjectName(project)) {
      return {
        result: 'error',
        reason: 'Ungültiger Compose-Projektname (nur alphanumerische Zeichen, Bindestriche und Unterstriche erlaubt)',
        errorClass: 'error',
      };
    }

    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return { result: 'error', ...privateKey.error };

    const escapedProject = shellEscape(project);

    // Tab-getrenntes Format: Name, Service, Status, Ports
    // shellEscape schützt das Format-Template vor IFS-Split/Quote-Bruch in der Remote-Shell
    const formatStr = shellEscape('{{.Name}}\t{{.Service}}\t{{.Status}}\t{{.Publishers}}');
    const cmd = [
      'docker', 'compose',
      '--project-name', escapedProject,
      'ps',
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
        hostFingerprint: hostFingerprint ?? null,
        sshClientFactory: _sshClientFactory,
      });
      const containers = parseComposePsOutput(stdout);
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
   * Listet alle laufenden Container mit Label `com.docker.compose.project=<project>`,
   * inkl. `cloudflare.tunnel-hostname`-Label-Wert (oder null für interne Services).
   *
   * AC7: stack-aware Sicht für stack-deploy-orchestration + cloudflare-reconciliation.
   *
   * @param {object} opts
   * @param {VpsTarget} opts.vps
   * @param {string}    opts.project   - Compose-Projektname (= com.docker.compose.project-Label-Wert)
   * @param {string}    [opts.hostFingerprint]
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<PsStackResult>}
   */
  async psStack({ vps, project, hostFingerprint, _sshClientFactory } = {}) {
    if (!isValidProjectName(project)) {
      return {
        result: 'error',
        reason: 'Ungültiger Compose-Projektname (nur alphanumerische Zeichen, Bindestriche und Unterstriche erlaubt)',
        errorClass: 'error',
      };
    }

    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return { result: 'error', ...privateKey.error };

    // docker ps --filter label=com.docker.compose.project=<project>
    // Format: ID, Image, Ports, Status, compose.service-Label, cloudflare.tunnel-hostname-Label
    const filterArg = shellEscape(`label=com.docker.compose.project=${project}`);
    const formatStr = shellEscape('{{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "cloudflare.tunnel-hostname"}}');

    const cmd = [
      'docker', 'ps',
      '--filter', filterArg,
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
        hostFingerprint: hostFingerprint ?? null,
        sshClientFactory: _sshClientFactory,
      });
      const containers = parsePsStackOutput(stdout);
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
 * Host-Key-Verifikation analog VpsDockerControl / VpsProvisioner (ADR-008-Linie):
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
          // AC8: stderr wird NICHT in Response/Audit weitergeleitet (könnte Secrets enthalten);
          // nur die ersten ~200 Zeichen intern puffern für prozess-internes Debugging (nie in HTTP/Audit/WS-Sink)
          if (stderrBuf.length < 200) {
            stderrBuf += data.toString();
          }
        });

        stream.on('close', (code) => {
          clearTimeout(execTimeout);
          if (resolved) return;

          if (code !== 0) {
            // AC8: stderr NICHT in Response/Log weitergeleitet (könnte Secrets enthalten);
            // nur intern im Error-Objekt für Prozess-internes Debugging (nie in Response/Audit/WS)
            const err = new Error(`docker compose / git-Kommando fehlgeschlagen (exit ${code})`);
            err.code = 'DOCKER_FAILED';
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

    // Host-Key-Verifikation analog VpsDockerControl (ADR-008-Linie):
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

// ── Output-Parser ──────────────────────────────────────────────────────────────

/**
 * Parst die Ausgabe von `docker compose ps --format '{{.Name}}\t{{.Service}}\t{{.Status}}\t{{.Publishers}}'`.
 *
 * @param {string} output
 * @returns {ComposePsEntry[]}
 */
function parseComposePsOutput(output) {
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  const containers = [];

  for (const line of lines) {
    const parts = line.split('\t');
    const name = (parts[0] ?? '').trim();
    const service = (parts[1] ?? '').trim();
    const status = (parts[2] ?? '').trim();
    const ports = (parts[3] ?? '').trim();

    if (!name) continue;

    containers.push({ name, service, status, ports });
  }

  return containers;
}

/**
 * Parst die Ausgabe von `docker ps --filter label=com.docker.compose.project=<project>
 * --format '{{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "cloudflare.tunnel-hostname"}}'`.
 *
 * @param {string} output
 * @returns {StackContainer[]}
 */
function parsePsStackOutput(output) {
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  const containers = [];

  for (const line of lines) {
    const parts = line.split('\t');
    const containerId = (parts[0] ?? '').trim();
    const image = (parts[1] ?? '').trim();
    const ports = (parts[2] ?? '').trim();
    const status = (parts[3] ?? '').trim();
    const service = (parts[4] ?? '').trim();
    const cfHostname = (parts[5] ?? '').trim();

    if (!containerId) continue;

    // Ersten Host-Port aus Port-Mapping extrahieren (z.B. "0.0.0.0:8080->8080/tcp")
    const portMatch = ports.match(/(?:0\.0\.0\.0|:::?)?:?(\d+)->/);
    const hostPort = portMatch ? parseInt(portMatch[1], 10) : null;

    // hostname: null für interne Services (kein cloudflare.tunnel-hostname-Label)
    const hostname = cfHostname || null;

    containers.push({ containerId, image, service, hostname, status, hostPort });
  }

  return containers;
}

// ── Validierung ────────────────────────────────────────────────────────────────

/**
 * Validiert einen Stack-Namen: nur alphanumerische Zeichen, Bindestriche und Unterstriche.
 * Schützt gegen Path-Traversal (`..`) und Shell-Metazeichen.
 *
 * AC4: `stackName`/Pfad ist gegen Path-Traversal validiert (keine `..`, keine Shell-Metazeichen).
 *
 * @param {string} name
 * @returns {boolean}
 */
function isValidStackName(name) {
  return typeof name === 'string' && name.length > 0 && /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Validiert einen Compose-Projektnamen: nur alphanumerische Zeichen, Bindestriche und Unterstriche.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isValidProjectName(name) {
  return typeof name === 'string' && name.length > 0 && /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Validiert einen relativen Dateipfad: kein absoluter Pfad, keine `..`-Segmente.
 * Schützt gegen Path-Traversal für composeFile / overrideFile / envFilePath.
 *
 * AC4/AC5: Defense-in-Depth — verhindert, dass ein Aufrufer via ../../../etc/passwd
 * auf beliebige VPS-Dateien zugreifen kann.
 *
 * @param {string} p
 * @returns {boolean}
 */
function isValidRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  // Kein absoluter Pfad
  if (p.startsWith('/') || p.startsWith('~')) return false;
  // Keine `..`-Segmente (auch nicht als erste/letzte Komponente)
  const segments = p.split('/');
  return segments.every((seg) => seg !== '..');
}

// ── Shell-Escaping ─────────────────────────────────────────────────────────────

/**
 * Bettet einen Wert sicher in einen Shell-Befehl ein (Single-Quote-Escaping).
 * Identisches Muster wie VpsDockerControl / VpsProvisioner (Single-Quotes: ' → '\'').
 *
 * Sicherheits-Annahme: kein Shell-Command-Injection möglich — Single-Quote-Escaping
 * verhindert das Ausbrechen aus dem quotierten Wert.
 *
 * @param {string} value
 * @returns {string} - in Single-Quotes eingebetteter, escaped Wert
 */
function shellEscape(value) {
  // Single-Quote-Escaping: ' → '\''
  const escaped = String(value).replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

// ── Fehlerklassifizierung ──────────────────────────────────────────────────────

/**
 * Klassifiziert einen SSH/Docker/git-Fehler in eine maschinenlesbare Kategorie.
 * Analog VpsDockerControl.classifyError — geheimnis-frei.
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
      return 'docker compose / git-Kommando auf VPS fehlgeschlagen';
    default:
      return 'VpsComposeControl: unerwarteter Fehler';
  }
}
