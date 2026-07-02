/**
 * HeadlessRetroRunner — headless Ausführungs-Naht für einen automatisch
 * ausgelösten Retro-Lauf (`claude -p '/agent-flow:retro --force'`), als
 * Queue-Worker-Runner hinter der `RetroAutoQueue` (docs/specs/retro-auto-queue.md,
 * S-257: AC5, AC6).
 *
 * Naht (Grenze S-256 ⇄ S-257): die `RetroAutoQueue` (S-256) ruft an ihrem
 * injizierten `retroRunner` **ausschließlich** `run(projectPath) → Promise` auf:
 *   - **resolve** = Lauf erfolgreich beendet (echtes Prozess-Ende, `close`-Event
 *     → Job-Status `done`).
 *   - **reject** = Fehlschlag (Timeout / Non-Zero-Exit / `auth-expired` /
 *     `spawn`-Fehler / `locked`). Die Queue behandelt eine Rejection als
 *     Degradation (AC3): sie stoppt **nicht**, auditiert secret-frei und fährt
 *     mit dem nächsten Repo fort.
 *
 * Diese Klasse kapselt die headless-Ausführung, die die Spec §Naht ausdrücklich
 * INNERHALB des `run()` verortet: `HeadlessFlowRunner.start()`/`getJob()`,
 * `close`-Event als einzige Fertig-Quelle, das Per-Lauf-Audit (AC6) und die
 * `ProjectJobLock`-Freigabe im `finally` (letztere liegt bereits im
 * `HeadlessRunnerCore`, das die Sperre in seinem eigenen try/finally freigibt).
 *
 * Eigene Runner-/Lock-Instanz (AC5): der Default-`runner` ist eine **eigene**
 * `HeadlessFlowRunner`-Instanz mit ihrer **eigenen**, frischen `ProjectJobLock`-
 * Instanz (Konstruktor-Default `new ProjectJobLock()` in HeadlessFlowRunner.js)
 * — bewusst getrennt von Nacht-Drain, manuellem Drain, Reconcile-Runner,
 * `IdeaSpecifyFinalizer`, `StorySpecifyFinalizer` und `CostModeModelCheck`, sonst
 * würde ein paralleler headless-Lauf für dasselbe Projekt fälschlich blockiert
 * (Fremd-/Selbstblockade-Vermeidung, analog den bestehenden Runner-Kommentaren
 * in server.js). Befehl fest `/agent-flow:retro`, Arg fest `--force` (G3-Cooldown-
 * Bypass für den automatischen Auslöser, [[retro-auto-trigger]]).
 *
 * Eigener, entkoppelter Timeout (Spec §Verträge): großzügig, da ein Retro-Lauf
 * mit Clustering/Dedup/PR-Öffnung dauert — NICHT an den Reconcile-Default
 * gekoppelt. Konfigurierbar über `RETRO_HEADLESS_TIMEOUT_MS` (Env, ms), Default
 * `DEFAULT_RETRO_HEADLESS_TIMEOUT_MS`. Der Timeout selbst lebt im
 * `HeadlessRunnerCore` (SIGTERM → Job-Status `failed`), daher terminiert das
 * Status-Polling in `#awaitTerminal()` stets (kein zusätzlicher Timer hier).
 *
 * Security (Floor):
 *   - Env-Allowlist + `CLAUDE_CODE_OAUTH_TOKEN`; **harter** `ANTHROPIC_API_KEY`/
 *     `OPENAI_API_KEY`-Block — vollständig im `HeadlessRunnerCore` (Trust-Boundary).
 *   - argv als Array (kein Shell-String), `--dangerously-skip-permissions` nur im
 *     getrennten headless-Pfad — ebenfalls im Core.
 *   - **Keine** Secrets/Token/absoluten Host-Pfade in Audit/Log: der Audit-Eintrag
 *     nennt nur einen sanitisierten Repo-Slug (`repoSlug`, Basename + safe chars).
 *   - Kein Import/Mutation von `PtyManager`/`PtySessionRegistry`/`CommandService`
 *     (Trust-Boundary — reiner headless-Pfad).
 *
 * Injectable (Test-Entkopplung, Spec §NFR Testbarkeit): `runner` (Default eigene
 * `HeadlessFlowRunner`-Instanz), `auditStore`, `identity`, `pollIntervalMs`;
 * `spawnFn`/`timeoutMs`/`lock` werden — sofern kein `runner` übergeben ist — an
 * den intern erzeugten `HeadlessFlowRunner` durchgereicht (so kann der ECHTE
 * Default-Pfad mit einem Fake-`spawnFn` statt einem echten `claude`-Prozess
 * geprüft werden). **Kein** echter `claude -p`-Live-Lauf im Test-Gate.
 *
 * @module HeadlessRetroRunner
 */

import { HeadlessFlowRunner } from './HeadlessFlowRunner.js';
import { repoSlug } from './RetroAutoQueue.js';

/** Der einzige `/agent-flow:...`-Befehl, den dieser Runner je auslöst (AC5). */
export const RETRO_COMMAND = '/agent-flow:retro';

/** Fest verdrahtetes Arg: G3-Cooldown-Bypass für den automatischen Auslöser (AC5). */
export const RETRO_FORCE_ARG = '--force';

/**
 * Default Runaway-Timeout für einen headless Retro-Lauf (Spec §Verträge) —
 * großzügig, da ein Retro-Lauf mit Clustering/Dedup/PR-Öffnung dauert.
 * Eigenständig über `RETRO_HEADLESS_TIMEOUT_MS` (ms) konfigurierbar, NICHT an
 * `DEFAULT_RECONCILE_TIMEOUT_MS`/`FLOW_HEADLESS_TIMEOUT_MS` gekoppelt.
 */
export const DEFAULT_RETRO_HEADLESS_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

/** Poll-Intervall (ms) für die `getJob()`-Statusabfrage bis Terminalstatus. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Audit-Kommando-Präfixe (secret-frei, nur Repo-Slug wird angehängt, AC6). */
const AUDIT_START = 'retro-auto:run-start';
const AUDIT_DONE = 'retro-auto:run-done';
const AUDIT_FAILED = 'retro-auto:run-failed';

export class HeadlessRetroRunner {
  /** @type {{ start: Function, getJob: Function }} */
  #runner;
  /** @type {{ record: Function }|null} */
  #auditStore;
  /** @type {string|null} */
  #identity;
  /** @type {number} */
  #pollIntervalMs;

  /**
   * @param {object} [deps]
   * @param {{ start: Function, getJob: Function }} [deps.runner] - injectable Runner
   *   (Default: EIGENE `HeadlessFlowRunner`-Instanz mit EIGENER, frischer
   *   `ProjectJobLock`-Instanz, fest auf `/agent-flow:retro --force`). Inject ein
   *   Test-Double, um `HeadlessFlowRunner` selbst NICHT erneut zu testen.
   * @param {{ record: Function }} [deps.auditStore] - Per-Lauf-Audit (AC6), best-effort.
   * @param {string|null} [deps.identity] - Audit-Identity (Default `null` = System/auto).
   * @param {number} [deps.pollIntervalMs] - Poll-Intervall der Status-Abfrage (ms).
   * @param {Function} [deps.spawnFn] - nur wirksam ohne `runner`: an den intern
   *   erzeugten `HeadlessFlowRunner` durchgereicht (Test-Entkopplung).
   * @param {number} [deps.timeoutMs] - nur wirksam ohne `runner`: Runaway-Timeout.
   * @param {import('./ProjectJobLock.js').ProjectJobLock} [deps.lock] - nur wirksam
   *   ohne `runner`; wird NIE von server.js gesetzt (der HeadlessFlowRunner-Default
   *   `new ProjectJobLock()` garantiert bereits die Lock-Trennung, AC5) — nur Tests.
   */
  constructor({ runner, auditStore, identity, pollIntervalMs, spawnFn, timeoutMs, lock } = {}) {
    this.#runner =
      runner ??
      new HeadlessFlowRunner({
        command: RETRO_COMMAND,
        args: [RETRO_FORCE_ARG],
        spawnFn,
        timeoutMs:
          timeoutMs ?? (Number(process.env.RETRO_HEADLESS_TIMEOUT_MS) || DEFAULT_RETRO_HEADLESS_TIMEOUT_MS),
        lock,
      });
    this.#auditStore = auditStore ?? null;
    this.#identity = identity ?? null;
    this.#pollIntervalMs = pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Führt **einen** headless Retro-Lauf für ein Repo aus (AC5/AC6) und ist die
   * einzige von der `RetroAutoQueue` aufgerufene Naht (`run(projectPath) →
   * Promise`).
   *
   * Ablauf:
   *   1. **Start-Audit** (AC6, genau EIN Eintrag).
   *   2. `HeadlessFlowRunner.start()` → spawnt `claude -p '/agent-flow:retro
   *      --force' --dangerously-skip-permissions` (argv-Array, Env-Allowlist,
   *      API-Key-Block, eigener `ProjectJobLock`, alles im `HeadlessRunnerCore`).
   *   3. `getJob()` pollen, bis Terminalstatus (`done`/`failed`/`auth-expired`)
   *      — das `close`-Event ist die einzige Fertig-Quelle; der Timeout im Core
   *      garantiert, dass ein hängender Lauf terminal wird (SIGTERM → `failed`).
   *   4. `done` → **Ende-Audit** (AC6) + **resolve**. Sonst → **Fehler-Audit**
   *      (AC6) + **reject** (Queue behandelt das als Degradation, AC3).
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad.
   * @returns {Promise<void>} resolve bei Erfolg, reject bei Fehlschlag.
   */
  async run(projectPath) {
    if (typeof projectPath !== 'string' || projectPath.trim() === '') {
      throw new Error('[HeadlessRetroRunner] run(projectPath) erfordert einen nicht-leeren String');
    }
    const slug = repoSlug(projectPath);

    // AC6: Start-Audit — genau EIN Eintrag je Lauf, secret-frei (nur Slug).
    this.#audit(`${AUDIT_START} repo=${slug}`);

    let started;
    try {
      started = this.#runner.start(projectPath, { command: RETRO_COMMAND, args: [RETRO_FORCE_ARG] });
    } catch {
      // Synchroner Start-Fehler (selten) → Fehlschlag; Queue fährt fort (AC3).
      this.#audit(`${AUDIT_FAILED} repo=${slug}`);
      throw new Error(`Retro-Lauf konnte nicht gestartet werden (${slug})`);
    }

    if (!started || started.ok !== true) {
      // `locked`: bei EIGENER Lock-Instanz + globaler Serialisierung der Queue
      // sollte das nie auftreten; defensiv als Fehlschlag behandeln (AC3).
      this.#audit(`${AUDIT_FAILED} repo=${slug}`);
      throw new Error(`Retro-Lauf abgelehnt (reason=${started?.reason ?? 'unknown'}) für ${slug}`);
    }

    const job = await this.#awaitTerminal(started.jobId);

    if (job.status === 'done') {
      // AC6: Ende-Audit (Erfolg) — genau EIN Eintrag.
      this.#audit(`${AUDIT_DONE} repo=${slug}`);
      return;
    }

    // failed / auth-expired / unbekannt → AC6: Fehler-Audit (genau EIN Eintrag),
    // dann reject. Der geworfene Fehler ist secret-frei (nur Slug + Status).
    this.#audit(`${AUDIT_FAILED} repo=${slug}`);
    throw new Error(`Retro-Lauf fehlgeschlagen (${slug}, status=${job.status})`);
  }

  /**
   * Pollt `getJob()`, bis ein Terminalstatus erreicht ist. Terminiert stets, weil
   * der Core-Timeout einen hängenden Lauf nach `timeoutMs` auf `failed` setzt.
   * Ein nach einem Neustart weggefallener Job (`undefined`) wird als Fehlschlag
   * gewertet (kein Endlos-Poll).
   *
   * @param {string} jobId
   * @returns {Promise<{ status: string }>}
   */
  async #awaitTerminal(jobId) {
    for (;;) {
      const job = this.#runner.getJob(jobId);
      if (!job) return { status: 'failed' };
      if (job.status !== 'running') return job;
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  /**
   * Non-blocking Sleep; der Timer wird `unref()`t, damit er einen Shutdown nicht
   * offen hält (Spec §NFR Robustheit).
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
   * Best-effort Per-Lauf-Audit (AC6). Ein Audit-Fehler darf den Lauf nie crashen.
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
