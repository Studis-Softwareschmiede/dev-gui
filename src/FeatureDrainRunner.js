/**
 * FeatureDrainRunner — spawnt `scripts/board-feature-drain.sh <F-###>
 * [<container>]` als eigenständigen Kindprozess (feature-umsetzen-button,
 * Owner-Auftrag 2026-07-06). Kein `claude -p`-Direktaufruf hier — das Skript
 * ist rein deterministisches Bash/Python (agent-flow L3-Erweiterung,
 * `docs/specs/feature-batch-orchestration.md`) und spawnt intern selbst
 * `claude -p /agent-flow:flow --parent <F-###>` je Story. Läuft potenziell
 * lange (mehrere Story-Sitzungen nacheinander) — bewusst KEIN Timeout
 * (anders als die claude-p-Runner in `HeadlessRunnerCore.js`), da die
 * Laufzeit von der Story-Anzahl des Features abhängt.
 *
 * Fire-and-forget: `start()` gibt sofort zurück (registriert in
 * `FeatureDrainRegistry` als `running`), der Prozess läuft im Hintergrund
 * weiter; `exit`/`error` aktualisiert die Registry auf `done`/`failed`.
 *
 * @module FeatureDrainRunner
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';

export class FeatureDrainRunner {
  #spawnFn;
  #registry;
  #auditStore;
  #lock;

  /**
   * @param {{ registry: import('./FeatureDrainRegistry.js').FeatureDrainRegistry,
   *   lock: import('./ProjectJobLock.js').ProjectJobLock,
   *   auditStore?: import('./AuditStore.js').AuditStore, spawnFn?: Function }} params
   *   `lock` — dieselbe Instanz, gegen die der Router `tryAcquire()` vor dem
   *   Start prüft (featureDrainLock, server.js) — wird HIER im close/error-
   *   Handler freigegeben, nicht im Router (Router kehrt sofort zurück,
   *   der Lock muss aber für die gesamte, potenziell lange Batch-Laufzeit
   *   gehalten bleiben).
   */
  constructor({ registry, lock, auditStore = null, spawnFn = nodeSpawn }) {
    this.#registry = registry;
    this.#lock = lock;
    this.#auditStore = auditStore;
    this.#spawnFn = spawnFn;
  }

  /**
   * @param {{ projectSlug: string, repoPath: string, featureId: string, appName?: string, agentFlowScriptsDir: string }} params
   *   `agentFlowScriptsDir` = Pfad zum agent-flow-Plugin-`scripts/`-Verzeichnis
   *   (Plugin liefert `board-feature-drain.sh` — dev-gui hat keine eigene Kopie).
   * @returns {void}
   */
  start({ projectSlug, repoPath, featureId, appName, agentFlowScriptsDir }) {
    this.#registry.register(projectSlug, featureId);
    this.#auditStore?.record({
      identity: null,
      command: `feature-batch start ${projectSlug} ${featureId}`,
    });

    const scriptPath = join(agentFlowScriptsDir, 'board-feature-drain.sh');
    const args = [scriptPath, featureId];
    if (appName) args.push(appName);

    const child = this.#spawnFn('bash', args, {
      cwd: repoPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 2026-07-06-Vorfall: ein Exit-Code allein (z.B. "Exit-Code 1") reichte
    // dem Owner nicht, um die Ursache zu verstehen — manuelles Debugging im
    // Container war nötig, um "ModuleNotFoundError: yaml" zu finden. Jetzt
    // wird der letzte Ausgabe-Ausschnitt (stdout+stderr, gedeckelt) mit
    // erfasst, damit ein Fehlschlag ohne Container-Zugriff diagnostizierbar
    // ist. Secret-frei: das Skript selbst gibt keine Secrets aus (Bash/Git/
    // gh-Meldungen), aber vorsorglich gedeckelt (letzte 2000 Zeichen).
    let outputTail = '';
    const appendOutput = (chunk) => {
      outputTail = (outputTail + chunk.toString('utf8')).slice(-2000);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    const lockKey = `${projectSlug}:${featureId}`;
    child.on('error', (err) => {
      this.#registry.markFailed(projectSlug, featureId, `Start fehlgeschlagen: ${err.message}`);
      this.#lock.release(lockKey);
    });
    child.on('close', (code) => {
      if (code === 0) {
        this.#registry.markDone(projectSlug, featureId);
      } else if (code === 3) {
        // board-feature-drain.sh Exit 3 — Feature wartet (kein Fehler im
        // engeren Sinn: entweder eine echte Blockade oder ein noch offenes
        // Depends-Gate). Owner-Feedback 2026-07-06 (dritte Runde): der Button
        // sprang zuvor lautlos zurück auf "Umsetzen" mit einer generischen
        // Meldung, ohne zu erklären, WORAUF genau gewartet wird — jetzt wird
        // die tatsächliche Skript-Ausgabe (z.B. "WARTET: S-901 wartet auf
        // S-800 (To Do, gehört zu F-002)") durchgereicht.
        const tail = outputTail.trim();
        this.#registry.markFailed(projectSlug, featureId, tail || 'Feature wartet');
      } else {
        const tail = outputTail.trim();
        this.#registry.markFailed(projectSlug, featureId, `Exit-Code ${code}${tail ? ` — ${tail}` : ''}`);
      }
      this.#lock.release(lockKey);
    });
  }
}
