/**
 * FeatureDrainFlowRunner — `FlowRunner`-Interface-Implementierung (`startRun`/
 * `awaitCompletion`, s. `src/FlowRunner.js`) für den Feature-Drain-
 * Ausführungsschritt (docs/specs/feature-aware-drain.md AC1, AC4, AC5).
 *
 * `ProjectDrain` entscheidet je Runde feature-bewusst (`selectDrainMode()`,
 * `src/ProjectDrain.js`), OB ein Feature-Drain statt eines Einzel-`/flow`-Laufs
 * gebührt — dieser Runner implementiert NUR den Ausführungsschritt "Feature-
 * Drain starten + auf sein ECHTES Ende warten", analog zu
 * `HeadlessFlowRunnerAdapter` (headless-parallel-drain, `claude -p`-Pfad).
 *
 * Kindprozess: `bash <plugin-scripts-dir>/board-feature-drain.sh <F-###>`
 * (kein Container-Namens-Argument — Nicht-Ziel dieser Story, s. Spec §
 * Verhalten Punkt 4) — argv als **Array** (kein Shell-String), `cwd` =
 * `projectPath`, Child-Env über dieselbe Allowlist wie die `claude -p`-Runner
 * (`HeadlessRunnerCore.buildChildEnv`, KEIN `ANTHROPIC_API_KEY`/
 * `OPENAI_API_KEY` in der Child-Env, AC4-Floor). `F-###` wird gegen
 * `FEATURE_ID_RE` validiert (identisch zu `ProjectDrain.FEATURE_ID_RE`) UND
 * muss ein real existierendes Parent-Feature sein (`ProjectDrain` übergibt nur
 * `featureId`-Werte, die es selbst aus einem echten `project.features`-Eintrag
 * abgeleitet hat — Defense-in-Depth-Zweitprüfung hier).
 *
 * Skript-Lokalisierung (AC5): über den injizierten `pluginRootResolver`
 * (Vertrag identisch zu `AgentFlowReader.resolvePluginRootContaining`,
 * Plugin-Cache-Glob-Muster `ensure-gh-auth.sh`, `.claude/CLAUDE.md`) — liefert
 * er `null` (Skript in KEINER installierten Plugin-Version vorhanden), meldet
 * `startRun()` `{ok:false, reason:'feature-drain-unavailable'}`; `ProjectDrain`
 * fällt dann sauber auf den Einzel-`/flow`-Pfad zurück (graceful degradation,
 * kein Crash — AC5/E1).
 *
 * BEWUSSTE Cross-Repo-Lücke — `windowEndMs` (Nachtfenster-Ende) wird NICHT
 * durchgereicht (S-317 Review-Iteration 2): Spec §Verträge "Feature-Drain-
 * Start" fordert, das Nachtfenster-Ende ans Skript durchzureichen (analog dem
 * bestehenden `windowEndMs`-Pfad). Das aktuell installierte
 * `board-feature-drain.sh` (geprüft per Kopf-Kommentar UND grep nach
 * "window"/"fenster"/"--end", Stand 2026-07-07) unterstützt laut seiner
 * Usage-Zeile ausschließlich `<F-###> [<container-name>]` — KEINEN Parameter
 * für ein Fensterende. `startRun()` reicht `windowEndMs` deshalb bewusst NICHT
 * an den Kindprozess durch; sobald agent-flow einen solchen Parameter
 * einführt, muss diese Lücke geschlossen werden (Cross-Repo-Abhängigkeit,
 * s. Spec-Kopf "Umsetzbar erst nach agent-flow feature-batch-orchestration
 * v2"). Praktische Konsequenz: ein bereits laufender Feature-Drain
 * respektiert das Nachtfenster-Ende NICHT selbst — er läuft bis zu seinem
 * natürlichen Ende (Exit 0/3) durch. Das ist funktional DECKUNGSGLEICH mit
 * dem bestehenden "sanftes Ende"-Verhalten (AC9/Spec §Verhalten Punkt 9: "ein
 * bereits laufender Feature-Drain wird NICHT abgebrochen, sondern zu Ende
 * geführt") — die Lücke betrifft nur, dass das Skript sein eigenes Ende nicht
 * VORZEITIG an einer Story-Grenze innerhalb des Features ausrichten kann.
 *

 * Exit-Code-Mapping (`scripts/board-feature-drain.sh` Modul-Doku):
 *   0 → `done`     (Feature komplett gelandet, inkl. finalem Merge+Rollout)
 *   3 → `done`     ("wartet" — echte Blockade ODER Depends-Gate; das ist
 *                    KEIN Runner-Fehler im Sinne dieses Interfaces, sondern
 *                    ein Zwischenstand — `ProjectDrain`s Snapshot-Diff
 *                    entscheidet ohnehin über Fortschritt/Eskalation anhand
 *                    des BOARDS, nicht anhand des Exit-Codes. Ein Exit 3
 *                    ohne jede Board-Änderung zählt daher korrekt als
 *                    fortschrittsloser Lauf — wie jeder andere `/flow`-Lauf
 *                    ohne Board-Änderung auch, AC8.)
 *   sonst → `failed` (Absturz/Timeout — zählt wie ein gescheiterter
 *                    `/flow`-Lauf, AC8 Edge-Case "Kindprozess crasht/Timeout").
 *
 * Kein Timeout in dieser Story (bewusst, s. Spec §Ausführung + Nicht-Ziele):
 * ein Feature-Drain kann viele Story-Sitzungen sequenziell umfassen — die
 * Laufzeit ist proportional zur Story-Anzahl, kein sinnvoller globaler
 * Runaway-Wert. Ein hängender Kindprozess bleibt bis zum nächsten
 * Server-Neustart aktiv (identisch zum bestehenden Feature-Umsetzen-Button-
 * Runner, `src/FeatureDrainRunner.js`, das bewusst denselben Verzicht trifft).
 *
 * Cross-Boundary-Lock (S-317 Review-Iteration 2, .claude/lessons/coder.md
 * 2026-07-07): dieser Runner (ausgelöst von `ProjectDrain`/Nachtwächter) UND
 * der bestehende Feature-Umsetzen-Button (`src/FeatureDrainRunner.js`,
 * `src/routers/featureDrain.js`) können BEIDE denselben Kindprozess
 * `board-feature-drain.sh F-###` für dasselbe Feature starten — `ProjectDrain`s
 * eigenes `#lock` (projektweise) und der Button-Router prüfen sich NICHT
 * gegenseitig. Fix: `startRun()` erwirbt — falls ein `featureDrainLock`
 * injiziert ist — DENSELBEN feature-scoped Lock wie der Button-Router
 * (`ProjectJobLock`, Schlüssel `${projectSlug}:${featureId}`, identisch zu
 * `src/routers/featureDrain.js` `lockKey`). `server.js` injiziert dafür die
 * BEREITS bestehende `featureDrainLock`-Instanz (dieselbe, die der Router
 * nutzt) — kein zweiter Lock, echte gegenseitige Blockade. Ist der Lock schon
 * gehalten (gleich über welchen Weg), liefert `startRun()` `{ok:false,
 * reason:'feature-drain-locked'}`; `ProjectDrain` behandelt das wie
 * `command-channel-busy` (kein Runner-Fehler, kein Spin, keine Eskalation —
 * die nächste Runde versucht es erneut). Der Lock wird im `close`/`error`-
 * Handler freigegeben (analog `FeatureDrainRunner`, das denselben Lock im
 * eigenen `close`-Handler löst) — NICHT in `awaitCompletion()`, da der
 * Aufrufer (`ProjectDrain`) `awaitCompletion()` erst nach `startRun()`
 * aufruft und der Lock schon ab Start (nicht erst ab Warten) gegen den
 * anderen Pfad schützen muss. Ohne injizierten `featureDrainLock` (z.B. in
 * bestehenden Tests ohne diese Dependency) verhält sich `startRun()`
 * bit-identisch zum bisherigen Verhalten (kein Regress) — die Cross-Boundary-
 * Blockade ist dann schlicht nicht aktiv (nur in `server.js`-Produktions-
 * Verdrahtung relevant, wo die geteilte Instanz injiziert wird).
 *
 * Security (Floor): argv als Array (kein Shell-Interpolation), `F-###`
 * strikt validiert, Child-Env-Allowlist (kein API-Key), keine Secrets/Pfade
 * in Audit-Text.
 *
 * @module FeatureDrainFlowRunner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildChildEnv } from './HeadlessRunnerCore.js';

/** Identisch zu `ProjectDrain.FEATURE_ID_RE` (eigenständig gehalten — kein Zyklus-Import). */
export const FEATURE_ID_RE = /^F-\d+$/;

/** Default Poll-Intervall (ms) — der Kindprozess läuft im Hintergrund, kein PTY-Idle-Takt nötig. */
export const DEFAULT_POLL_INTERVAL_MS = 2000;

const GENERIC_FAILURE_MESSAGE = 'Feature-Drain fehlgeschlagen';
const UNAVAILABLE_REASON = 'feature-drain-unavailable';

export class FeatureDrainFlowRunner {
  #spawnFn;
  #pluginRootResolver;
  #auditStore;
  #sleepFn;
  #pollIntervalMs;
  #featureDrainLock;
  /** @type {Map<string, { status: 'running'|'done'|'failed', error?: string }>} */
  #jobs = new Map();

  /**
   * @param {object} params
   * @param {() => Promise<string|null>} params.pluginRootResolver — z.B.
   *   `() => agentFlowReader.resolvePluginRootContaining('scripts/board-feature-drain.sh')`.
   * @param {Function} [params.spawnFn] — injectable (Default `node:child_process` `spawn`).
   * @param {{ record: Function }} [params.auditStore] — optional, Start/Ende/Fehler je Lauf (AC4).
   * @param {(ms: number) => Promise<void>} [params.sleepFn] — injectable für Tests.
   * @param {number} [params.pollIntervalMs] — default DEFAULT_POLL_INTERVAL_MS (2000).
   * @param {import('./ProjectJobLock.js').ProjectJobLock} [params.featureDrainLock]
   *   Cross-Boundary-Lock (s. Modul-Doku) — DIESELBE Instanz, die
   *   `src/routers/featureDrain.js` (Feature-Umsetzen-Button) für den Schlüssel
   *   `${projectSlug}:${featureId}` nutzt. Optional — ohne ihn (z.B. in
   *   bestehenden Tests) ist die Cross-Boundary-Blockade ein No-op (kein
   *   Regress).
   */
  constructor({
    pluginRootResolver,
    spawnFn = nodeSpawn,
    auditStore,
    sleepFn,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    featureDrainLock,
  }) {
    this.#pluginRootResolver = pluginRootResolver;
    this.#spawnFn = spawnFn;
    this.#auditStore = auditStore ?? null;
    this.#sleepFn = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollIntervalMs = pollIntervalMs;
    this.#featureDrainLock = featureDrainLock ?? null;
  }

  /**
   * Startet einen Feature-Drain (`board-feature-drain.sh <F-###>`).
   *
   * Nimmt BEWUSST KEIN `windowEndMs` entgegen (s. Modul-Doku "BEWUSSTE
   * Cross-Repo-Lücke") — das installierte `board-feature-drain.sh` akzeptiert
   * aktuell keinen Parameter fürs Nachtfenster-Ende.
   *
   * @param {{ projectPath: string, projectSlug?: string|null, featureId: string, identity?: string|null }} params
   *   `projectSlug` — nötig für den Cross-Boundary-Lock-Schlüssel
   *   `${projectSlug}:${featureId}` (s. Modul-Doku). Fehlt er (z.B. Board-Scan
   *   fehlgeschlagen), wird der Lock-Schritt übersprungen (kein Crash) — der
   *   Aufrufer (`ProjectDrain`) übergibt `project.slug` aus dem letzten
   *   erfolgreichen Board-Scan.
   * @returns {Promise<{ ok: true, handle: { jobId: string } } | { ok: false, reason: string }>}
   */
  async startRun({ projectPath, projectSlug = null, featureId, identity = null }) {
    if (typeof featureId !== 'string' || !FEATURE_ID_RE.test(featureId)) {
      return { ok: false, reason: 'internal' };
    }

    // Cross-Boundary-Lock (S-317 Review-Iteration 2, s. Modul-Doku): derselbe
    // feature-scoped Lock wie der Feature-Umsetzen-Button-Router. Läuft
    // bereits ein Feature-Drain für dieses Feature (gleich über welchen Weg
    // gestartet), lehnt startRun() ab, statt einen zweiten Kindprozess zu
    // spawnen — der Aufrufer (ProjectDrain) behandelt das wie
    // `command-channel-busy` (kein Runner-Fehler, keine Eskalation).
    const lockKey = typeof projectSlug === 'string' && projectSlug ? `${projectSlug}:${featureId}` : null;
    if (this.#featureDrainLock && lockKey && !this.#featureDrainLock.tryAcquire(lockKey)) {
      return { ok: false, reason: 'feature-drain-locked' };
    }

    let pluginRoot;
    try {
      pluginRoot = await this.#pluginRootResolver();
    } catch {
      pluginRoot = null;
    }
    if (!pluginRoot) {
      // AC5: Skript in keiner installierten Plugin-Version vorhanden —
      // graceful degradation, ProjectDrain fällt auf Einzel-/flow zurück.
      if (this.#featureDrainLock && lockKey) this.#featureDrainLock.release(lockKey);
      return { ok: false, reason: UNAVAILABLE_REASON };
    }

    const scriptPath = join(pluginRoot, 'scripts', 'board-feature-drain.sh');
    const jobId = randomUUID();
    this.#jobs.set(jobId, { status: 'running' });

    const projectLabel = typeof projectPath === 'string' && projectPath ? basename(projectPath) : 'unknown';
    this.#audit(identity, `taktgeber:feature-drain-start project=${projectLabel} feature=${featureId} jobId=${jobId}`);

    const releaseLock = () => {
      if (this.#featureDrainLock && lockKey) this.#featureDrainLock.release(lockKey);
    };

    let child;
    try {
      // AC4: argv als Array (kein Shell-String), cwd=projectPath, Child-Env
      // über dieselbe Allowlist wie die claude-p-Runner (kein API-Key).
      child = this.#spawnFn('bash', [scriptPath, featureId], {
        cwd: projectPath,
        env: buildChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      this.#jobs.set(jobId, { status: 'failed', error: GENERIC_FAILURE_MESSAGE });
      this.#audit(identity, `taktgeber:feature-drain-failed project=${projectLabel} feature=${featureId} jobId=${jobId}`);
      releaseLock();
      return { ok: true, handle: { jobId } };
    }

    let outputTail = '';
    const appendOutput = (chunk) => {
      outputTail = (outputTail + chunk.toString('utf8')).slice(-2000);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    child.on('close', (code) => {
      // Exit 0 (Feature komplett) UND Exit 3 (wartet — echte Blockade/
      // Depends-Gate) sind beide KEIN Runner-Absturz — s. Modul-Doku
      // Exit-Code-Mapping. ProjectDrain entscheidet über Fortschritt/
      // Eskalation ausschließlich anhand des Board-Snapshot-Diffs (AC8).
      if (code === 0 || code === 3) {
        this.#jobs.set(jobId, { status: 'done' });
        this.#audit(identity, `taktgeber:feature-drain-done project=${projectLabel} feature=${featureId} jobId=${jobId} exitCode=${code}`);
      } else {
        this.#jobs.set(jobId, { status: 'failed', error: GENERIC_FAILURE_MESSAGE });
        this.#audit(identity, `taktgeber:feature-drain-failed project=${projectLabel} feature=${featureId} jobId=${jobId} exitCode=${code}`);
      }
      // best-effort: letzte Ausgabe wird bewusst NICHT auditiert (Secret-/
      // Pfad-Floor) — nur als internes Diagnose-Feld am Job-State gehalten.
      void outputTail;
      releaseLock();
    });

    child.on('error', () => {
      this.#jobs.set(jobId, { status: 'failed', error: GENERIC_FAILURE_MESSAGE });
      this.#audit(identity, `taktgeber:feature-drain-failed project=${projectLabel} feature=${featureId} jobId=${jobId}`);
      releaseLock();
    });

    return { ok: true, handle: { jobId } };
  }

  /**
   * Wartet auf das ECHTE Ende des Feature-Drain-Kindprozesses (`close`-Event
   * — kein Idle-/Rate-Timer, kein Timeout in dieser Story, s. Modul-Doku).
   *
   * @param {{ jobId: string }} handle
   * @returns {Promise<{ status: 'done'|'failed', error?: string }>}
   */
  async awaitCompletion(handle) {
    for (;;) {
      const job = this.#jobs.get(handle.jobId);
      if (!job || job.status !== 'running') {
        return { status: job?.status ?? 'failed', error: job?.error };
      }
      await this.#sleepFn(this.#pollIntervalMs);
    }
  }

  /**
   * Best-effort Audit-Eintrag (AC4). Secret-/pfad-frei (Projekt-Basename
   * statt absolutem Host-Pfad, kein Skript-Output im Audit-Text).
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
