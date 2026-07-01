/**
 * FlowRunner — injizierbares Interface für den Ausführungs-Schritt eines
 * `/flow`-Laufs, den `ProjectDrain` bislang hart über `CommandService`
 * anstieß (docs/specs/headless-parallel-drain.md AC4, AC5, AC6, AC13).
 *
 * `ProjectDrain` behält seine GESAMTE übrige Logik (Drain-Ziele/`ready`,
 * zustandsbasierte Abbruch-/Konvergenz-Regel, transitive-Sackgassen-
 * Konvergenz, Eskalation-auf-`Blocked`, Snapshot-Diff-Fortschritt,
 * Sicherheitsgürtel) unverändert — NUR "wie ein einzelner /flow-Lauf
 * gestartet + auf sein ECHTES Ende gewartet wird" läuft über dieses
 * Interface.
 *
 * Vertrag (sprach-neutral, siehe Spec „Verträge"):
 *   `startRun({ projectPath, command, identity?, args? })`
 *     → `{ ok: true, handle }` | `{ ok: false, reason: 'locked'|'busy'|'internal'|... }`
 *   `awaitCompletion(handle)`
 *     → `Promise<{ status: 'done'|'failed'|'auth-expired', ... }>`
 *
 * Zwei Implementierungen (AC4):
 *
 * 1. `InteractiveFlowRunner` (Default, heutiges Verhalten — AC6 „bit-
 *    identisch"): kapselt `CommandService.tryRun()` + das bestehende
 *    Idle-Completion-Polling (`getStatus()` bis nicht mehr `'running'`).
 *    `reason:'locked'|'busy'` bedeutet: der GLOBALE `CommandService`-
 *    `JobLock` wird von einem ANDEREN Projekt gehalten — `ProjectDrain`
 *    mappt das unverändert auf `command-channel-busy` (kein Regress am
 *    S-195-Fix, siehe `ProjectDrain.js` Modul-Doku).
 *
 * 2. `HeadlessFlowRunnerAdapter` (neu, S-212/S-213): kapselt
 *    `HeadlessFlowRunner.start()` (S-204) + Polling auf `getJob()` bis der
 *    Job das `close`-Event des Kindprozesses durchlaufen hat (kein
 *    PTY-Idle-Raten). `getJob().status` wird 1:1 durchgereicht
 *    (`'done'|'failed'|'auth-expired'`). Es gibt KEINEN globalen Lock im
 *    Headless-Pfad — `reason:'locked'` kann hier NUR auftreten, wenn das
 *    PROJEKTWEISE `ProjectJobLock` des `HeadlessFlowRunner` für DASSELBE
 *    Projekt bereits gehalten wird (praktisch ausgeschlossen, da
 *    `ProjectDrain` selbst schon ein eigenes projektweises Lock hält,
 *    bevor `#runLoop` überhaupt startet) — der globale
 *    `command-channel-busy`-Engpass entfällt dadurch strukturell im
 *    Headless-Modus (AC8, [[taktgeber-nachtwaechter]]).
 *
 * Security-Hygiene (Floor, kein Gold-Plating): `HeadlessFlowRunnerAdapter`
 * lehnt einen `command`, der nicht mit `/agent-flow:` beginnt, defensiv ab
 * (`reason:'internal'`) — falls ein künftiger, hier NICHT gebauter
 * Konfigurations-Speisepunkt (S-213) je einen Fremd-Befehl durchreichen
 * würde. `ProjectDrain` selbst übergibt hier immer `FLOW_COMMAND`
 * (`/agent-flow:flow`), dieser Guard greift also im aktuellen Scope nie,
 * ist aber Defense-in-Depth für den Adapter als solchen.
 *
 * @module FlowRunner
 */

/** Default Poll-Intervall (ms) für den interaktiven Adapter (identisch zum bisherigen ProjectDrain-Default). */
const DEFAULT_INTERACTIVE_POLL_INTERVAL_MS = 500;

/** Default Poll-Intervall (ms) für den headless-Adapter (Job läuft im Hintergrund, kein PTY-Idle-Takt nötig). */
const DEFAULT_HEADLESS_POLL_INTERVAL_MS = 2000;

/**
 * `InteractiveFlowRunner` — Adapter über `CommandService` (interaktiver
 * PTY-Pfad, S-196 Board-Knopf + Terminal). Verhalten bit-identisch zum
 * bisherigen `ProjectDrain#awaitCompletion`/`tryRun`-Pfad (AC6).
 */
export class InteractiveFlowRunner {
  #commandService;
  #sleepFn;
  #pollIntervalMs;

  /**
   * @param {object} [params]
   * @param {{ tryRun: Function, getStatus: () => { commandId: string|null, status: string|null } }} params.commandService
   * @param {(ms: number) => Promise<void>} [params.sleepFn]  injectable für Tests
   * @param {number} [params.pollIntervalMs]  default: DEFAULT_INTERACTIVE_POLL_INTERVAL_MS (500)
   */
  constructor({ commandService, sleepFn, pollIntervalMs = DEFAULT_INTERACTIVE_POLL_INTERVAL_MS } = {}) {
    this.#commandService = commandService;
    this.#sleepFn = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollIntervalMs = pollIntervalMs;
  }

  /**
   * Stößt `/agent-flow:flow` über `CommandService.tryRun()` an (heutiges
   * Verhalten, unverändert — inkl. `reason:'locked'|'busy'|'invalid'|
   * 'session-cap'|'internal'` je nach `CommandService`-Zustand).
   *
   * @param {{ projectPath: string, command: string, identity?: string|null }} params
   * @returns {{ ok: true, handle: { commandId: string|null } } | { ok: false, reason: string }}
   */
  startRun({ projectPath, command, identity = null }) {
    let result;
    try {
      result = this.#commandService.tryRun({ command, identity, projectPath });
    } catch {
      // Edge-Case „/flow wirft / Session nicht ready" → kein Crash, wie bisher.
      return { ok: false, reason: 'internal' };
    }
    if (!result || !result.ok) {
      return { ok: false, reason: result?.reason ?? 'internal' };
    }
    return { ok: true, handle: { commandId: result.commandId ?? null } };
  }

  /**
   * Wartet, bis der aktuell laufende Befehl in `CommandService` nicht mehr
   * `'running'` ist (Idle-Completion-Mechanismus von `CommandService`,
   * unverändert zum bisherigen `ProjectDrain#awaitCompletion`). Der
   * interaktive Pfad kennt keinen expliziten Erfolg/Fehlschlag-Status —
   * "nicht mehr running" wird als `'done'` normalisiert (`ProjectDrain`
   * wertet ohnehin nur den Board-Snapshot-Diff, nicht diesen Status).
   *
   * @param {{ commandId: string|null }} [_handle]  unbenutzt (CommandService
   *   verfolgt nur EINEN prozessweiten laufenden Befehl — kein Per-Handle-Status).
   * @returns {Promise<{ status: 'done' }>}
   */
  async awaitCompletion(_handle) {
    for (;;) {
      const status = this.#commandService.getStatus();
      if (!status || status.status !== 'running') return { status: 'done' };
      await this.#sleepFn(this.#pollIntervalMs);
    }
  }
}

/**
 * `HeadlessFlowRunnerAdapter` — Adapter über `HeadlessFlowRunner` (S-204,
 * `claude -p`-Kindprozess). „Auf Ende warten" = auf das ECHTE `close`-Event
 * des Kindprozesses, kein PTY-Idle-Poll (AC4).
 */
export class HeadlessFlowRunnerAdapter {
  #headlessRunner;
  #sleepFn;
  #pollIntervalMs;

  /**
   * @param {object} [params]
   * @param {{ start: Function, getJob: Function }} params.headlessRunner  z.B. `HeadlessFlowRunner`-Instanz (S-204)
   * @param {(ms: number) => Promise<void>} [params.sleepFn]  injectable für Tests
   * @param {number} [params.pollIntervalMs]  default: DEFAULT_HEADLESS_POLL_INTERVAL_MS (2000)
   */
  constructor({ headlessRunner, sleepFn, pollIntervalMs = DEFAULT_HEADLESS_POLL_INTERVAL_MS } = {}) {
    this.#headlessRunner = headlessRunner;
    this.#sleepFn = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollIntervalMs = pollIntervalMs;
  }

  /**
   * Startet einen headless-`/flow`-Lauf (`HeadlessFlowRunner.start()`).
   * `reason:'locked'` bedeutet hier: das PROJEKTWEISE `ProjectJobLock` des
   * Headless-Runners ist für DASSELBE Projekt bereits belegt (kein
   * globaler Engpass, AC8) — praktisch ausgeschlossen, da `ProjectDrain`
   * selbst bereits ein eigenes Projekt-Lock hält.
   *
   * @param {{ projectPath: string, command: string, identity?: string|null, args?: string[] }} params
   * @returns {{ ok: true, handle: { jobId: string } } | { ok: false, reason: string }}
   */
  startRun({ projectPath, command, args }) {
    // Security-Hygiene (Floor, s. Modul-Doku): defensiver Allowlist-Guard,
    // falls ein künftiger Speisepunkt (S-213) je einen Fremd-Befehl
    // durchreicht — ProjectDrain selbst übergibt hier immer FLOW_COMMAND.
    if (typeof command !== 'string' || !command.startsWith('/agent-flow:')) {
      return { ok: false, reason: 'internal' };
    }
    let result;
    try {
      result = this.#headlessRunner.start(projectPath, { command, args });
    } catch {
      return { ok: false, reason: 'internal' };
    }
    if (!result || !result.ok) {
      return { ok: false, reason: result?.reason ?? 'internal' };
    }
    return { ok: true, handle: { jobId: result.jobId } };
  }

  /**
   * Wartet auf das ECHTE Ende des headless-Kindprozesses: pollt
   * `getJob(jobId)` bis der Status nicht mehr `'running'` ist (der
   * zugrunde liegende `HeadlessFlowRunner` selbst wird erst durch das
   * `close`-Event des Kindprozesses terminal — kein Idle-Raten, AC4).
   * Terminal-Status wird 1:1 durchgereicht (`'done'|'failed'|'auth-expired'`).
   *
   * @param {{ jobId: string }} handle
   * @returns {Promise<{ status: 'done'|'failed'|'auth-expired', result?: string, error?: string, prHint?: string }>}
   */
  async awaitCompletion(handle) {
    for (;;) {
      const job = this.#headlessRunner.getJob(handle.jobId);
      if (!job || job.status !== 'running') {
        return {
          status: job?.status ?? 'failed',
          result: job?.result,
          error: job?.error,
          prHint: job?.prHint,
        };
      }
      await this.#sleepFn(this.#pollIntervalMs);
    }
  }
}
