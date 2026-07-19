/**
 * HeadlessNewProjectRunner — headless Ausführungs-Naht für den `new-project`-
 * Scaffold-Kindprozess (`claude -p '/agent-flow:new-project …'`), gebaut als
 * die EINE server-seitige Naht der per-App-GPG-Passphrasen-Auto-Provisionierung
 * (ADR-021, docs/specs/per-app-gpg-passphrase-provisioning.md AC4-AC6).
 *
 * Neunter benannter headless-Baustein der ADR-016-Linie (`.claude/CLAUDE.md`).
 * Dünner Wrapper um `HeadlessRunnerCore` (analog `HeadlessReconcileRunner`/
 * `HeadlessFlowRunner`/`HeadlessRetroRunner`):
 *   - Kindprozess: `claude -p '/agent-flow:new-project [...args]' --dangerously-
 *     skip-permissions` als Array-argv (kein Shell-String, security/R03), `cwd`
 *     = aufgelöster, validierter Projekt-Pfad.
 *   - **Eigene** `ProjectJobLock`-Instanz — bewusst getrennt von Nacht-/
 *     manuellem Drain / Reconcile / Retro / `IdeaSpecifyFinalizer` /
 *     `ObsidianIngestRunner` (Fremd-/Selbstblockade-Vermeidung).
 *   - `close`-Event als einzige Fertig-Quelle, eigener Runaway-Timeout.
 *   - Env-Allowlist + `CLAUDE_CODE_OAUTH_TOKEN`; harter `ANTHROPIC_API_KEY`/
 *     `OPENAI_API_KEY`-Block (Trust-Boundary, `HeadlessRunnerCore`).
 *   - **Pro-Lauf-Env-Override** (`run(projectPath, { env })`): reicht z.B.
 *     `GPG_PASS_FILE=<pfad>` NUR für DIESEN Lauf additiv in die Child-Env
 *     (`HeadlessRunnerCore` AC-Erweiterung ADR-021) — der `PerAppGpgProvisioning
 *     Service#withScaffoldPassphrase`-Aufrufer mappt `fn({ gpgPassFilePath })`
 *     genau hierauf.
 *   - **`runWithAutoProvisioning(app, projectPath, opts)` — die Naht INNERHALB
 *     des Runners (AC4/AC15, ADR-021 „Der Runner … ruft an seinem erfolgreichen
 *     Abschluss withScaffoldPassphrase … auf"):** kapselt exakt die Komposition
 *     `provisioningService.withScaffoldPassphrase(app, (args) => this.run(...))`
 *     — `fn` reicht ein evtl. `gpgPassFilePath` additiv als `GPG_PASS_FILE` an
 *     `run()` durch. Die Bitwarden-Item-Anlage feuert dadurch genau EINMAL, NUR
 *     wenn `run()` erfolgreich auflöst (Erfolgs-Hook); rejected `run()` → KEIN
 *     Aufruf (kein Teil-Zustand, S-336-AC4/AC5/AC6 in
 *     `PerAppGpgProvisioningService#withScaffoldPassphrase` bereits verifiziert).
 *     `provisioningService` ist ein injizierter, optionaler Konstruktor-Dep —
 *     ohne ihn liefert `runWithAutoProvisioning()` `{ result: 'failed' }`
 *     (Wiring-Fehler, kein Crash). **Scope-Hinweis (S-336 vs. S-343):** diese
 *     Methode ist die vollständige server-seitige Naht selbst — WER sie mit
 *     welchem `app`/`projectPath` aufruft (die drei Anlage-Wege der
 *     `NewProjectChooserDialog`, HTTP-Endpunkt, Frontend-Dialog-Vorab-Erfassung
 *     des Slugs) ist die separate Folge-Story S-343 (AC12-AC14) — dort entsteht
 *     der erste Produktivcode-Aufrufer dieser Methode.
 *
 * Getrennt vom interaktiven PTY-Pfad: dieses Modul importiert/mutiert WEDER
 * `PtyManager` NOCH `PtySessionRegistry` NOCH den `CommandService`-Schreibpfad
 * (Trust-Boundary, Grep — der bestehende interaktive `new-project`-Trigger
 * bleibt unverändert bestehen, ADR-021 „Warum NICHT der interaktive PTY-Pfad").
 *
 * `run(projectPath, { env, args })` ist die awaitbare Naht (Muster
 * `HeadlessRetroRunner#run`): **resolve** = Scaffold erfolgreich beendet
 * (`close`-Event, Job-Status `done`); **reject** = Fehlschlag (Timeout /
 * Non-Zero-Exit / `auth-expired` / `budget-limited` / Start-Ablehnung
 * `locked`). Per-Lauf-Audit bei Start/Ende/Fehler (secret-frei, nur
 * sanitisierter Repo-Slug — wiederverwendet `repoSlug()` aus
 * `RetroAutoQueue.js`, kein zweiter Sanitizer).
 *
 * Job-Registry: In-Memory (Map jobId → JobState), geht bei Server-Neustart
 * verloren (Nicht-Ziel: keine persistente Job-Historie — analog allen
 * Geschwister-Runnern).
 *
 * Security (Floor):
 *   - Kein Token-Wert, keine Passphrase und kein absoluter Host-Pfad in
 *     Logs/Audit/Fehlermeldungen.
 *   - argv als Array, kein Shell-Interpolation (security/R03).
 *   - `--dangerously-skip-permissions` ausschließlich hier (getrennter
 *     headless-Pfad, wie alle Geschwister-Runner).
 *
 * Injectable (Test-Entkopplung): `spawnFn` (Default `node:child_process`
 * `spawn`), `auditStore`, `identity`, `pollIntervalMs` — kein Test benötigt
 * einen echten `claude`-Lauf.
 *
 * @module HeadlessNewProjectRunner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { ProjectJobLock } from './ProjectJobLock.js';
import { HeadlessRunnerCore } from './HeadlessRunnerCore.js';
import { repoSlug } from './RetroAutoQueue.js';

/** Der einzige `/agent-flow:...`-Befehl, den dieser Runner je auslöst. */
export const NEW_PROJECT_COMMAND = '/agent-flow:new-project';

/**
 * Default Runaway-Timeout für einen headless `new-project`-Scaffold-Lauf —
 * eigenständig über `NEW_PROJECT_HEADLESS_TIMEOUT_MS` (Env, ms) konfigurierbar,
 * NICHT an Reconcile-/Flow-/Retro-Timeout gekoppelt (analog allen Geschwistern).
 */
export const DEFAULT_NEW_PROJECT_HEADLESS_TIMEOUT_MS = 60 * 60 * 1000; // 1h

/** Poll-Intervall (ms) für die `getJob()`-Statusabfrage bis Terminalstatus. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Generischer, secret-freier Fehlertext für nicht-401 Exit-Fehler. */
const GENERIC_FAILURE_MESSAGE = 'Projekt-Scaffold fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Projekt-Scaffold abgebrochen (Timeout)';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im New-Project-Runner';
const DONE_RESULT_MESSAGE = 'Projekt-Scaffold abgeschlossen';

/** Audit-Kommando-Präfixe (secret-frei, nur Repo-Slug wird angehängt). */
const AUDIT_START = 'new-project-headless:run-start';
const AUDIT_DONE = 'new-project-headless:run-done';
const AUDIT_FAILED = 'new-project-headless:run-failed';

export class HeadlessNewProjectRunner {
  /** @type {HeadlessRunnerCore} */
  #core;
  /** @type {{ record: Function }|null} */
  #auditStore;
  /** @type {string|null} */
  #identity;
  /** @type {number} */
  #pollIntervalMs;
  /** @type {{ withScaffoldPassphrase: Function }|null} */
  #provisioningService;

  /**
   * @param {object} [deps]
   * @param {Function} [deps.spawnFn] - injectable spawn (default: node:child_process spawn).
   * @param {number} [deps.timeoutMs] - Runaway-Timeout (default: NEW_PROJECT_HEADLESS_TIMEOUT_MS
   *   env oder DEFAULT_NEW_PROJECT_HEADLESS_TIMEOUT_MS).
   * @param {ProjectJobLock} [deps.lock] - injectable Lock-Instanz (Default: EIGENE, frische
   *   `ProjectJobLock`-Instanz — bewusst getrennt von allen anderen headless-Runnern).
   * @param {{ record: Function }} [deps.auditStore] - Per-Lauf-Audit, best-effort.
   * @param {string|null} [deps.identity] - Audit-Identity (Default `null` = System/auto).
   * @param {number} [deps.pollIntervalMs] - Poll-Intervall der Status-Abfrage (ms).
   * @param {{ withScaffoldPassphrase: Function }} [deps.provisioningService] - injizierter
   *   `PerAppGpgProvisioningService` (AC4/AC15-Naht, `runWithAutoProvisioning()`) — optional,
   *   nur nötig wenn `runWithAutoProvisioning()` verwendet wird (Default `null`).
   */
  constructor({
    spawnFn = nodeSpawn,
    timeoutMs,
    lock = new ProjectJobLock(),
    auditStore,
    identity,
    pollIntervalMs,
    provisioningService,
  } = {}) {
    this.#core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs:
        timeoutMs ?? (Number(process.env.NEW_PROJECT_HEADLESS_TIMEOUT_MS) || DEFAULT_NEW_PROJECT_HEADLESS_TIMEOUT_MS),
      lock,
      defaultCommand: NEW_PROJECT_COMMAND,
      defaultArgs: [],
      messages: {
        genericFailure: GENERIC_FAILURE_MESSAGE,
        timeoutFailure: TIMEOUT_FAILURE_MESSAGE,
        internalFailure: INTERNAL_FAILURE_MESSAGE,
        doneResult: DONE_RESULT_MESSAGE,
      },
    });
    this.#auditStore = auditStore ?? null;
    this.#identity = identity ?? null;
    this.#pollIntervalMs = pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#provisioningService = provisioningService ?? null;
  }

  /**
   * Führt **einen** headless `new-project`-Scaffold-Lauf für ein Projekt aus
   * und wartet auf den Terminalstatus (awaitbarer Erfolg — ADR-021). Dies ist
   * die Naht, auf die `PerAppGpgProvisioningService#withScaffoldPassphrase`s
   * `fn({ gpgPassFilePath })` mappt: `env: { GPG_PASS_FILE: gpgPassFilePath }`.
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad.
   * @param {object} [opts]
   * @param {Record<string,string>} [opts.env] - additiver Pro-Lauf-Env-Override
   *   (z.B. `{ GPG_PASS_FILE: '<pfad>' }`) — der Pfad selbst ist nicht-geheim,
   *   der Datei-Inhalt ist `0600` (Aufrufer-Verantwortung).
   * @param {string[]} [opts.args] - Extra-argv für DIESEN Lauf (Default: keine).
   * @returns {Promise<void>} resolve bei Erfolg, reject bei Fehlschlag.
   */
  async run(projectPath, { env, args } = {}) {
    if (typeof projectPath !== 'string' || projectPath.trim() === '') {
      throw new Error('[HeadlessNewProjectRunner] run(projectPath) erfordert einen nicht-leeren String');
    }
    const slug = repoSlug(projectPath);

    this.#audit(`${AUDIT_START} repo=${slug}`);

    let started;
    try {
      started = this.#core.start(projectPath, { command: NEW_PROJECT_COMMAND, args, env });
    } catch {
      // Synchroner Start-Fehler (selten) → Fehlschlag.
      this.#audit(`${AUDIT_FAILED} repo=${slug}`);
      throw new Error(`Scaffold-Lauf konnte nicht gestartet werden (${slug})`);
    }

    if (!started || started.ok !== true) {
      // `locked`: eigene, frische Lock-Instanz je Aufrufer — sollte im Normalfall
      // nicht auftreten; defensiv als Fehlschlag behandeln.
      this.#audit(`${AUDIT_FAILED} repo=${slug}`);
      throw new Error(`Scaffold-Lauf abgelehnt (reason=${started?.reason ?? 'unknown'}) für ${slug}`);
    }

    const job = await this.#awaitTerminal(started.jobId);

    if (job.status === 'done') {
      this.#audit(`${AUDIT_DONE} repo=${slug}`);
      return;
    }

    // failed / auth-expired / budget-limited / unbekannt → Fehler-Audit, reject.
    this.#audit(`${AUDIT_FAILED} repo=${slug}`);
    throw new Error(`Scaffold-Lauf fehlgeschlagen (${slug}, status=${job.status})`);
  }

  /**
   * Die AC4/AC15-Naht INNERHALB des Runners (ADR-021 „Der Runner … ruft an
   * seinem erfolgreichen Abschluss `withScaffoldPassphrase` … auf"): führt
   * EINEN `run()`-Lauf aus und löst — NUR bei dessen Erfolg — genau EINMAL die
   * Auto-Provisionierung der per-App-GPG-Passphrase aus. Komponiert
   * `provisioningService.withScaffoldPassphrase(app, fn)` (Passphrase VOR dem
   * Scaffold, `GPG_PASS_FILE` additiv in die Child-Env, Bitwarden-Item NACH
   * Scaffold-Erfolg) mit `run()` als `fn` — ein fehlgeschlagener/rejecteter
   * `run()`-Lauf löst KEINEN Provisionierungs-Aufruf aus (kein Teil-Zustand,
   * S-336-AC4/AC5/AC6 bereits in `PerAppGpgProvisioningService` verifiziert).
   *
   * **Scope-Hinweis (S-336 vs. S-343):** diese Methode IST die vollständige
   * server-seitige Naht — sie hat aktuell noch KEINEN Produktivcode-Aufrufer;
   * die Verdrahtung der drei Anlage-Wege (`NewProjectChooserDialog`: „Neues
   * Projekt"/„Aus Obsidian"/„Adopt", inkl. Vorab-Erfassung des Ziel-Slugs im
   * Dialog, AC13) auf diese Methode ist die separate Folge-Story S-343
   * (AC12-AC14) — bewusster, von `architekt`/Owner gedeckter Zuschnitt.
   *
   * @param {string} app - Ziel-Slug (identisch zu `projectPath`s Repo-Slug —
   *   Aufrufer-Verantwortung, analog `gpgBwItem`-Konvention).
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad.
   * @param {object} [opts]
   * @param {string[]} [opts.args] - Extra-argv für DIESEN `run()`-Lauf (Default: keine).
   * @param {string|null} [opts.identity] - Audit-Identity für die Provisionierung
   *   (Default: die Runner-eigene `identity` aus dem Konstruktor).
   * Rückgabe wird UNVERÄNDERT vom `provisioningService.withScaffoldPassphrase()`-
   * Promise durchgereicht — inklusive dessen `scaffoldOk`-Flag (S-387-Fund,
   * `docs/specs/obsidian-question-catalog.md` AC14), das zuverlässig anzeigt,
   * ob der `fn`-Aufruf (dieser `run()`-Lauf) selbst erfolgreich war,
   * UNABHÄNGIG vom `result`-Wert (der auch die Bitwarden-Teil-Ergebnisse nach
   * erfolgreichem Scaffold codiert).
   *
   * @returns {Promise<{ result: 'created'|'already-exists'|'access-not-ready'|'failed', scaffoldOk: boolean, reason?: string }>}
   */
  async runWithAutoProvisioning(app, projectPath, { args, identity } = {}) {
    if (!this.#provisioningService || typeof this.#provisioningService.withScaffoldPassphrase !== 'function') {
      return { result: 'failed', scaffoldOk: false, reason: 'Interner Fehler — kein Provisionierungs-Dienst konfiguriert' };
    }
    return this.#provisioningService.withScaffoldPassphrase(
      app,
      ({ gpgPassFilePath } = {}) =>
        this.run(projectPath, { env: gpgPassFilePath ? { GPG_PASS_FILE: gpgPassFilePath } : undefined, args }),
      { identity: identity ?? this.#identity },
    );
  }

  /**
   * Liest den aktuellen Status eines Jobs (Poll-fähig, analog Geschwister-Runnern).
   * @param {string} jobId
   * @returns {{ status: string, result?: string, error?: string, prHint?: string } | undefined}
   */
  getJob(jobId) {
    return this.#core.getJob(jobId);
  }

  /**
   * Pollt `getJob()`, bis ein Terminalstatus erreicht ist. Terminiert stets,
   * weil der Core-Timeout einen hängenden Lauf nach `timeoutMs` auf `failed`
   * setzt. Ein nach einem Neustart weggefallener Job wird als Fehlschlag gewertet.
   * @param {string} jobId
   * @returns {Promise<{ status: string }>}
   */
  async #awaitTerminal(jobId) {
    for (;;) {
      const job = this.#core.getJob(jobId);
      if (!job) return { status: 'failed' };
      if (job.status !== 'running') return job;
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  /**
   * Non-blocking Sleep; der Timer wird `unref()`t, damit er einen Shutdown
   * nicht offen hält.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  #sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  /**
   * Best-effort Per-Lauf-Audit. Ein Audit-Fehler darf den Lauf nie crashen.
   * Kommando ist secret-frei (nur Repo-Slug, kein Host-Pfad/Token).
   * @param {string} command
   */
  #audit(command) {
    if (!this.#auditStore) return;
    try {
      this.#auditStore.record({ identity: this.#identity, command });
    } catch {
      // best-effort — kein Crash
    }
  }
}
