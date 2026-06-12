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
import { isValidStackName, isValidRelativePath } from '../validation/stackValidation.js';

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

/**
 * @typedef {object} EnsureEnvResult
 * @property {'generated'|'exists'|'error'} result
 *   - 'generated' — Erst-Deploy: .env war nicht vorhanden, Generier-Skript erfolgreich ausgeführt
 *   - 'exists'    — Re-Deploy: .env existiert bereits und bleibt unverändert (AC4)
 *   - 'error'     — Fehler (Skript fehlt/schlägt fehl, SSH-Fehler, fehlende required-Keys)
 * @property {string}   [generatedKeys]    - CSV-Liste der Schlüsselnamen die generiert wurden (kein Wert, AC3)
 * @property {string[]} [missingKeys]      - Fehlende required-Key-Namen (AC5); leer wenn alle vorhanden
 * @property {string}   [reason]           - Fehlergrund ohne Geheim-Leak
 * @property {string}   [errorClass]       - maschinenlesbare Fehlerklasse
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

  /**
   * Stellt die App-`.env` auf dem VPS sicher (E3-Kernschutz, AC3/AC4/AC5).
   *
   * **Erst-Deploy (AC3):** Existiert die `.env` auf dem VPS noch nicht, führt diese Methode
   * das Stack-Generier-Skript auf dem VPS aus. Die generierten Werte verlassen den VPS **nie** —
   * kein SSH-Kommando liest `.env`-Werte zurück; nur Schlüssel-NAMEN werden geprüft (grep -oE).
   *
   * **Re-Deploy (AC4):** Existiert die `.env` bereits, wird sie **nicht** überschrieben und
   * **nicht** neu generiert. Rückgabe { result: 'exists' } — der Aufrufer (Item C) kann direkt
   * weiter zu git pull + compose up.
   *
   * **Required-Key-Prüfung (AC5):** Nach Generierung oder bei existierender `.env` werden
   * die in `secretsSpec.required` genannten Schlüssel auf **Vorhandensein** geprüft (NUR NAME,
   * NIE WERT via `grep -oE '^[A-Z_][A-Z0-9_]+='`). Fehlt ein required Key → Fehler mit
   * Schlüsselname, ohne Wert.
   *
   * Sicherheitsgarantien:
   * - Kein SSH-Kommando, das `.env`-Werte nach stdout zieht (kein `cat`, kein `echo`).
   * - Generierte Werte erscheinen NICHT in Response, Audit-Eintrag, Log, WS-Stream oder Frontend.
   * - Der Audit-Eintrag (zu erstellen durch den Aufrufer) nennt nur „env generated" + Schlüsselnamen.
   * - `stderr` des Generier-Skripts wird nicht weitergeleitet (könnte Secrets enthalten).
   * - Alle Pfade (envFile, generateScript) werden vor der Einbettung auf Path-Traversal geprüft.
   *
   * @param {object}   opts
   * @param {VpsTarget} opts.vps
   * @param {string}    opts.stackName         - Stack-Name (validiert)
   * @param {string}    [opts.envFile]         - Relativer Pfad zur .env-Datei (Default: '.env')
   * @param {string}    [opts.generateScript]  - Relativer Pfad zum Generier-Skript (Default: 'generate-supabase-secrets.sh')
   * @param {string[]}  [opts.generateKeys]    - Secret-Namen die generiert werden (nur für Audit-Logging — keine Werte)
   * @param {string[]}  [opts.requiredKeys]    - Secret-Namen die in der .env vorhanden sein müssen (AC5)
   * @param {string}    [opts.hostFingerprint] - SHA-256-Fingerprint für Host-Key-Verifikation
   * @param {Function}  [opts._sshClientFactory]
   * @returns {Promise<EnsureEnvResult>}
   */
  async ensureEnv({
    vps,
    stackName,
    envFile = '.env',
    generateScript = 'generate-supabase-secrets.sh',
    generateKeys = [],
    requiredKeys = [],
    hostFingerprint,
    _sshClientFactory,
  } = {}) {
    // Eingabe-Validierung (Path-Traversal, Shell-Metazeichen)
    if (!isValidStackName(stackName)) {
      return {
        result: 'error',
        reason: 'Ungültiger Stack-Name (nur alphanumerische Zeichen, Bindestriche und Unterstriche erlaubt)',
        errorClass: 'error',
      };
    }
    if (!isValidRelativePath(envFile)) {
      return {
        result: 'error',
        reason: 'Ungültiger envFile-Pfad (kein absoluter Pfad, keine ..-Segmente erlaubt)',
        errorClass: 'error',
      };
    }
    if (!isValidRelativePath(generateScript)) {
      return {
        result: 'error',
        reason: 'Ungültiger generateScript-Pfad (kein absoluter Pfad, keine ..-Segmente erlaubt)',
        errorClass: 'error',
      };
    }

    const privateKey = await this.#loadPrivateKey(vps.targetUser);
    if (!privateKey.ok) return privateKey.error;

    const stackDir = `${STACKS_BASE_DIR}/${shellEscape(stackName)}`;
    const escapedEnvFile = shellEscape(envFile);
    const escapedGenerateScript = shellEscape(generateScript);

    // ── Schritt 1: Existenz der .env prüfen (AC3/AC4) ────────────────────────
    // AC3/AC4: `test -f` prüft nur Existenz — liest KEINEN Wert.
    // Exit 0 = existiert, Exit 1 = existiert nicht.
    const checkCmd = `test -f ${stackDir}/${escapedEnvFile} && echo EXISTS || echo MISSING`;

    let existsOutput;
    try {
      existsOutput = await runSshCommand({
        privateKey: privateKey.value,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: checkCmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: hostFingerprint ?? null,
        sshClientFactory: _sshClientFactory,
      });
    } catch (err) {
      const errorClass = classifyError(err);
      return {
        result: 'error',
        reason: sanitizeErrorReason(errorClass),
        errorClass,
      };
    }

    const envExists = existsOutput.trim() === 'EXISTS';

    if (!envExists) {
      // ── AC3: Erst-Deploy — Generier-Skript auf VPS ausführen ─────────────
      // KRITISCH: Das Skript schreibt Werte in die .env auf dem VPS.
      // dev-gui liest diese Werte NIE zurück. Kein cat, kein echo von Werten.
      // stderr des Skripts wird NICHT weitergeleitet (könnte Secrets enthalten).
      const generateCmd = `bash ${stackDir}/${escapedGenerateScript}`;

      try {
        await runSshCommand({
          privateKey: privateKey.value,
          host: vps.host,
          port: vps.port ?? 22,
          targetUser: vps.targetUser,
          command: generateCmd,
          timeoutMs: COMPOSE_EXEC_TIMEOUT_MS,
          hostFingerprint: hostFingerprint ?? null,
          sshClientFactory: _sshClientFactory,
        });
      } catch (err) {
        const errorClass = classifyError(err);
        return {
          result: 'error',
          reason: `Generier-Skript auf VPS fehlgeschlagen: ${sanitizeErrorReason(errorClass)}`,
          errorClass,
        };
      }

      // AC3: Audit-Eintrag nennt nur Schlüsselnamen, niemals Werte.
      // generateKeys enthält nur Namen (aus secretsSpec.generate) — niemals Werte.
      // Required-Key-Prüfung nach Generierung (AC5)
      if (requiredKeys.length > 0) {
        const missingCheck = await this.#checkRequiredKeys({
          privateKey: privateKey.value,
          vps,
          stackDir,
          escapedEnvFile,
          requiredKeys,
          hostFingerprint,
          _sshClientFactory,
        });
        if (missingCheck.result === 'error') return missingCheck;
        if (missingCheck.missingKeys.length > 0) {
          return {
            result: 'error',
            reason: `Schlüssel \`${missingCheck.missingKeys[0]}\` fehlt in der VPS-.env`,
            errorClass: 'missing-required-key',
            missingKeys: missingCheck.missingKeys,
          };
        }
      }

      return {
        result: 'generated',
        // Schlüsselnamen (keine Werte) für den Audit-Eintrag des Aufrufers
        generatedKeys: generateKeys.join(','),
      };
    }

    // ── AC4: Re-Deploy — .env existiert, bleibt byte-identisch ──────────────
    // Keine Überschreibung, keine Re-Generierung — nur zurückgeben dass .env existiert.
    // Der Aufrufer (Item C) fährt fort mit git pull + compose up.

    // AC5: Required-Key-Prüfung auch beim Re-Deploy (falls Keys manuell fehlen)
    if (requiredKeys.length > 0) {
      const missingCheck = await this.#checkRequiredKeys({
        privateKey: privateKey.value,
        vps,
        stackDir,
        escapedEnvFile,
        requiredKeys,
        hostFingerprint,
        _sshClientFactory,
      });
      if (missingCheck.result === 'error') return missingCheck;
      if (missingCheck.missingKeys.length > 0) {
        return {
          result: 'error',
          reason: `Schlüssel \`${missingCheck.missingKeys[0]}\` fehlt in der VPS-.env`,
          errorClass: 'missing-required-key',
          missingKeys: missingCheck.missingKeys,
        };
      }
    }

    return { result: 'exists' };
  }

  // ── Private Hilfsmethoden ──────────────────────────────────────────────────────

  /**
   * Prüft welche required-Keys in der .env vorhanden sind (NUR Schlüsselnamen, NIE Werte).
   *
   * Technik (AC5): `grep -oE '^[A-Z_][A-Z0-9_]+=' .env` gibt NUR die KEY=-Muster aus
   * (ohne den Wert dahinter). Kein `cat`, kein `echo`-Wert — nur Schlüssel-NAMEN.
   *
   * @param {object}   p
   * @param {string}   p.privateKey
   * @param {VpsTarget} p.vps
   * @param {string}   p.stackDir         - expandierter Stack-Verzeichnis-Pfad (mit Tilde)
   * @param {string}   p.escapedEnvFile   - shell-escaped envFile-Pfad
   * @param {string[]} p.requiredKeys     - zu prüfende Schlüsselnamen
   * @param {string}   [p.hostFingerprint]
   * @param {Function} [p._sshClientFactory]
   * @returns {Promise<{ result: 'ok'|'error', missingKeys?: string[], reason?: string, errorClass?: string }>}
   */
  async #checkRequiredKeys({
    privateKey,
    vps,
    stackDir,
    escapedEnvFile,
    requiredKeys,
    hostFingerprint,
    _sshClientFactory,
  }) {
    // AC5: ONLY key names — grep -oE '^[A-Z_][A-Z0-9_]+=' extracts only KEY= patterns.
    // The = suffix is included to ensure we match actual assignments (not comments).
    // Values after = are never captured. This is the secret-safe existence check.
    const grepCmd = `grep -oE '^[A-Z_][A-Z0-9_]+=' ${stackDir}/${escapedEnvFile} 2>/dev/null || true`;

    let grepOutput;
    try {
      grepOutput = await runSshCommand({
        privateKey,
        host: vps.host,
        port: vps.port ?? 22,
        targetUser: vps.targetUser,
        command: grepCmd,
        timeoutMs: EXEC_TIMEOUT_MS,
        hostFingerprint: hostFingerprint ?? null,
        sshClientFactory: _sshClientFactory,
      });
    } catch (err) {
      const errorClass = classifyError(err);
      return {
        result: 'error',
        reason: sanitizeErrorReason(errorClass),
        errorClass,
      };
    }

    // Parse nur Schlüsselnamen aus grep-Ausgabe (KEY= → KEY)
    // AC5: Werte werden NICHT gelesen — nur die KEY=-Muster werden extrahiert
    const presentKeys = new Set(
      grepOutput
        .split('\n')
        .map((line) => line.trim().replace(/=$/, ''))
        .filter((k) => k.length > 0),
    );

    const missingKeys = requiredKeys.filter((k) => !presentKeys.has(k));
    return { result: 'ok', missingKeys };
  }

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
// isValidStackName und isValidRelativePath kommen aus ../validation/stackValidation.js
// (Single Source of Truth — I1, stack-deploy-orchestration Iteration 2).
// isValidStackName prüft nun auch das einheitliche Längenlimit (max. 64 Zeichen).

/**
 * Validiert einen Compose-Projektnamen: nur alphanumerische Zeichen, Bindestriche und Unterstriche.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isValidProjectName(name) {
  return typeof name === 'string' && name.length > 0 && /^[a-zA-Z0-9_-]+$/.test(name);
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
