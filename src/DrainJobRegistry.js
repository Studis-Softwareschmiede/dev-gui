/**
 * DrainJobRegistry — In-Memory-Status-Registry für manuelle Headless-Drains
 * (docs/specs/headless-manual-drain.md AC4).
 *
 * Der manuelle „Board abarbeiten"-Knopf startet den Drain fire-and-forget
 * (`POST /api/projects/:slug/drain`, headless-manual-drain AC1) und erhält
 * sofort eine `drainId` zurück — es gibt KEINE Live-Terminal-Ausgabe mehr
 * (bewusstes Restrisiko, AC1/AC6). Damit der Owner trotzdem „läuft / fertig /
 * fehlgeschlagen" sieht, wird jeder gestartete Drain hier unter seiner
 * `drainId` geführt; `GET /api/projects/:slug/drain/:drainId` liest den Status.
 *
 * Muster: analog zur In-Memory Job-Registry der headless-Runner
 * (`HeadlessRunnerCore.#jobs`, docs/specs/headless-reconcile-runner.md /
 * `IdeaSpecifyFinalizer`). Hier eigenständig, weil der manuelle Drain
 * fire-and-forget über den Router läuft (kein eigener Runner-Wrapper) — die
 * Registry lebt daher neben dem Router, nicht im `ProjectDrain`/Runner.
 *
 * Status-Modell (AC4):
 *   - `running` — Drain gestartet, `drainProject()`-Promise noch offen.
 *   - `done`    — `drainProject()` resolved (Drain sauber konvergiert/gestoppt);
 *                 `result` trägt eine kompakte, secret-/pfad-freie Zusammenfassung
 *                 (`reason`, `flowRuns`, `escalated`) — alles aus dem Drain-Ergebnis,
 *                 keine Pfade/Tokens.
 *   - `failed`  — `drainProject()` rejected; `error` ist ein GENERISCHER,
 *                 secret-/pfad-freier Text (die konkrete Fehlermeldung bleibt im
 *                 Server-Log, landet NIE in der Response).
 *
 * In-Memory (Nicht-Ziel: keine persistente Historie) — geht bei Server-Neustart
 * verloren; eine dann unbekannte `drainId` liefert `404` (AC4 Edge-Case).
 *
 * Security (Floor): `drainId` ist eine reine Korrelations-ID (`randomUUID()`),
 * kein Secret; `result`/`error` sind bewusst secret-/pfad-frei gehalten.
 *
 * @module DrainJobRegistry
 */

/** Generischer, secret-/pfad-freier Fehlertext für einen rejecteten Drain. */
export const DRAIN_FAILURE_MESSAGE = 'Drain-Lauf fehlgeschlagen';

/**
 * @typedef {object} DrainJobState
 * @property {'running'|'done'|'failed'} status
 * @property {{ reason: string, flowRuns: number, escalated: string[],
 *              completed: Array<{id:string,title:string}>,
 *              blocked: Array<{id:string,title:string}> }} [result]  nur bei `done`
 *   `completed`/`blocked` (drain-completion-report AC1/AC7): Stories, die während
 *   des Drains nach `Done` bzw. `Blocked` übergingen — durchgereicht aus dem
 *   `ProjectDrain.drainProject()`-Ergebnis, damit die manuelle Inline-Status-
 *   Fläche (CockpitView, AC7a) sie ohne Zusatz-Request anzeigen kann.
 * @property {string} [error]  generischer, secret-freier Text, nur bei `failed`
 */

export class DrainJobRegistry {
  /** @type {Map<string, DrainJobState>} */
  #jobs = new Map();

  /**
   * Registriert einen frisch gestarteten Drain als `running`.
   * @param {string} drainId
   */
  register(drainId) {
    this.#jobs.set(drainId, { status: 'running' });
  }

  /**
   * Markiert einen Drain als `done` mit kompakter, secret-/pfad-freier
   * Ergebnis-Zusammenfassung. No-op, wenn die `drainId` unbekannt ist
   * (defensiv — sollte nach `register()` nie vorkommen).
   *
   * @param {string} drainId
   * @param {{ reason?: string, flowRuns?: number, escalated?: string[],
   *           completed?: Array<{id:string,title:string}>,
   *           blocked?: Array<{id:string,title:string}> }} [result]
   *   Drain-Ergebnis (`ProjectDrain.drainProject()`-Rückgabe). Nur die
   *   secret-freien Felder werden übernommen. `completed`/`blocked`
   *   (drain-completion-report AC1) werden defensiv auf Arrays normalisiert
   *   (fehlend/ungültig → `[]`, kein Crash).
   */
  markDone(drainId, result = {}) {
    if (!this.#jobs.has(drainId)) return;
    this.#jobs.set(drainId, {
      status: 'done',
      result: {
        reason: typeof result.reason === 'string' ? result.reason : 'stopped',
        flowRuns: Number.isFinite(result.flowRuns) ? result.flowRuns : 0,
        escalated: Array.isArray(result.escalated) ? result.escalated : [],
        completed: Array.isArray(result.completed) ? result.completed : [],
        blocked: Array.isArray(result.blocked) ? result.blocked : [],
      },
    });
  }

  /**
   * Markiert einen Drain als `failed` mit einem generischen, secret-freien
   * Text. No-op bei unbekannter `drainId`.
   * @param {string} drainId
   * @param {string} [error]  default: DRAIN_FAILURE_MESSAGE (kein Roh-Fehlertext!)
   */
  markFailed(drainId, error = DRAIN_FAILURE_MESSAGE) {
    if (!this.#jobs.has(drainId)) return;
    this.#jobs.set(drainId, { status: 'failed', error });
  }

  /**
   * Liest den aktuellen Status eines Drains (AC4).
   * @param {string} drainId
   * @returns {DrainJobState | undefined}  undefined → unbekannte drainId (→ 404)
   */
  getJob(drainId) {
    return this.#jobs.get(drainId);
  }
}
