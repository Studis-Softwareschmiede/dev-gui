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
 * (`reason:'internal'`) — falls ein künftiger Konfigurations-Speisepunkt je
 * einen Fremd-Befehl durchreichen würde. `ProjectDrain` selbst übergibt hier
 * immer `FLOW_COMMAND` (`/agent-flow:flow`), dieser Guard greift also im
 * aktuellen Scope nie, ist aber Defense-in-Depth für den Adapter als solchen.
 *
 * Audit (S-213, docs/specs/headless-parallel-drain.md AC11): `HeadlessFlowRunnerAdapter`
 * ist im Headless-Modus der funktionale Ersatz für `CommandService`s Audit-Rolle
 * (`CommandService.tryRun()` auditiert heute JEDEN akzeptierten interaktiven
 * `/flow`-Anstoß, siehe `ProjectDrain.js` Modul-Doku „jeder /flow-Anstoß wird
 * bereits durch CommandService selbst auditiert"). Ein injizierter `auditStore`
 * erzeugt hier ANALOG je headless-Lauf **genau einen** Start- und **genau
 * einen** Ende(Erfolg)/Fehler-`AuditEntry` (AC11) — Korrelation über die
 * `jobId`, Identität + ein secret-/pfad-freies Projekt-Label (Basename statt
 * absolutem Host-Pfad, NFR „keine absoluten Host-Pfade in Audit/Log") werden
 * intern (Map `jobId → {identity, projectLabel}`) zwischen `startRun()` und
 * `awaitCompletion()` weitergereicht — die `handle`-Form selbst (`{jobId}`)
 * bleibt dabei unverändert (AC4-Vertrag, Rückwärtskompatibilität zu S-212).
 * `auditStore` ist optional — ohne ihn verhält sich der Adapter identisch zu
 * S-212 (kein Audit, kein Crash).
 *
 * `budget-limited` (S-270, docs/specs/headless-budget-limit-detection.md
 * AC4/AC5): `HeadlessFlowRunner.getJob()` kann jetzt zusätzlich zu
 * `'done'|'failed'|'auth-expired'` auch `'budget-limited'` liefern (Session-/
 * Usage-Limit-Meldung mit parsebarem Reset-Zeitpunkt erkannt). Der Adapter
 * reicht diesen Status samt `resetAt` (ms epoch) 1:1 durch — für alle anderen
 * Status bleibt `resetAt` `undefined`. Analog zum bestehenden
 * `headless-flow-failed`-Audit erzeugt der Adapter bei `budget-limited`
 * **genau einen** Ende-`AuditEntry` (`taktgeber:headless-flow-budget-limited`,
 * Reset-Zeit als ISO-8601, Projekt-Basename statt absolutem Pfad).
 *
 * @module FlowRunner
 */

import { basename } from 'node:path';

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
  #auditStore;
  /** @type {Map<string, { identity: string|null, projectLabel: string }>} jobId → Audit-Korrelation (AC11) */
  #jobAuditMeta = new Map();

  /**
   * @param {object} [params]
   * @param {{ start: Function, getJob: Function }} params.headlessRunner  z.B. `HeadlessFlowRunner`-Instanz (S-204)
   * @param {(ms: number) => Promise<void>} [params.sleepFn]  injectable für Tests
   * @param {number} [params.pollIntervalMs]  default: DEFAULT_HEADLESS_POLL_INTERVAL_MS (2000)
   * @param {{ record: Function }} [params.auditStore]  optional — je headless-Lauf Start/Ende/Fehler (AC11)
   */
  constructor({ headlessRunner, sleepFn, pollIntervalMs = DEFAULT_HEADLESS_POLL_INTERVAL_MS, auditStore } = {}) {
    this.#headlessRunner = headlessRunner;
    this.#sleepFn = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollIntervalMs = pollIntervalMs;
    this.#auditStore = auditStore ?? null;
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
  startRun({ projectPath, command, args, identity = null }) {
    // Security-Hygiene (Floor, s. Modul-Doku): defensiver Allowlist-Guard,
    // falls ein künftiger Speisepunkt je einen Fremd-Befehl durchreicht —
    // ProjectDrain selbst übergibt hier immer FLOW_COMMAND.
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
    // AC11: Start-Audit je headless-Lauf. Kein absoluter Host-Pfad im Audit-
    // Text (NFR) — nur der Basename (project-Label) statt `projectPath`.
    const projectLabel = typeof projectPath === 'string' && projectPath ? basename(projectPath) : 'unknown';
    this.#jobAuditMeta.set(result.jobId, { identity: identity ?? null, projectLabel });
    this.#audit(identity, `taktgeber:headless-flow-start project=${projectLabel} jobId=${result.jobId}`);
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
   * @returns {Promise<{ status: 'done'|'failed'|'auth-expired'|'budget-limited', result?: string, error?: string, prHint?: string, resetAt?: number }>}
   */
  async awaitCompletion(handle) {
    for (;;) {
      const job = this.#headlessRunner.getJob(handle.jobId);
      if (!job || job.status !== 'running') {
        const status = job?.status ?? 'failed';
        // AC11/S-270 AC5: Ende(Erfolg)/Fehler/Budget-Limit-Audit je headless-
        // Lauf — genau EIN AuditEntry, Korrelation über die beim startRun()
        // hinterlegte Meta (Identität + secret-/pfad-freies Projekt-Label).
        const meta = this.#jobAuditMeta.get(handle.jobId) ?? { identity: null, projectLabel: 'unknown' };
        this.#jobAuditMeta.delete(handle.jobId);
        if (status === 'done') {
          this.#audit(meta.identity, `taktgeber:headless-flow-done project=${meta.projectLabel} jobId=${handle.jobId}`);
        } else if (status === 'budget-limited') {
          // S-270 AC5: eigener, secret-/pfad-freier Audit-Zweig — Reset-Zeit
          // ISO-8601, kein absoluter Host-Pfad (Basename bereits in projectLabel).
          const resetAtIso = typeof job?.resetAt === 'number' ? new Date(job.resetAt).toISOString() : 'unknown';
          this.#audit(
            meta.identity,
            `taktgeber:headless-flow-budget-limited project=${meta.projectLabel} jobId=${handle.jobId} status=budget-limited resetAt=${resetAtIso}`,
          );
        } else {
          this.#audit(
            meta.identity,
            `taktgeber:headless-flow-failed project=${meta.projectLabel} jobId=${handle.jobId} status=${status}`,
          );
        }
        return {
          status,
          result: job?.result,
          error: job?.error,
          prHint: job?.prHint,
          resetAt: job?.resetAt,
        };
      }
      await this.#sleepFn(this.#pollIntervalMs);
    }
  }

  /**
   * Best-effort Audit-Eintrag (AC11). Ein Audit-Fehler darf einen headless-
   * Lauf nicht crashen (analog `ProjectDrain#auditRecord`/`NightWatchScheduler#audit`).
   * @param {string|null} identity
   * @param {string} command
   */
  #audit(identity, command) {
    if (!this.#auditStore) return;
    try {
      this.#auditStore.record({ identity: identity ?? null, command });
    } catch {
      // best-effort — kein Crash
    }
  }
}
