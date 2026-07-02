/**
 * RetroAutoQueue — serielle, globale FIFO-Warteschlange für automatisch
 * ausgelöste Retro-Läufe (docs/specs/retro-auto-queue.md, Kern-Anteil S-256:
 * AC1, AC2, AC3, AC4).
 *
 * Zweck (Spec §Zweck): automatisch ausgelöste Retro-Läufe ([[retro-auto-trigger]])
 * schreiben in eine **geteilte, globale** Lern-Ablage (`LEARNINGS.md` + globale
 * Knowledge-Packs im agent-flow-Repo, PR gegen agent-flow). Weil der Nachtwächter
 * mehrere Projekte **parallel** drainen kann, würden mehrere Retro-Läufe
 * gleichzeitig gegen dieselbe Ablage laufen (Merge-Konflikte, konkurrierende PRs).
 * Diese Klasse serialisiert sie **global**: zu **keinem Zeitpunkt** läuft mehr als
 * **ein** Retro-Lauf gleichzeitig — nicht projektweise, sondern global seriell,
 * weil die Ablage geteilt ist.
 *
 * Grenze dieses Board-Items (S-256): diese Klasse orchestriert **nur** die
 * Warteschlange (FIFO + Dedup + Status + Degradation, AC1–AC4). Die eigentliche
 * **headless** Retro-Ausführung (`claude -p '/agent-flow:retro --force'` über eine
 * eigene `HeadlessFlowRunner`-/`ProjectJobLock`-Instanz, Env-Allowlist, 401-Vorrang,
 * Timeout, Per-Lauf-Audit AC6 — Spec AC5/AC6) ist der **injizierte** `retroRunner`
 * und wird von der Folge-Story S-257 gebaut/verdrahtet. Diese Klasse ruft
 * ausschließlich die abstrakte Runner-Naht `run(projectPath) → Promise` auf.
 *
 * Runner-Kontrakt (`retroRunner`, von S-257 erfüllt):
 *   - `run(projectPath) → Promise<*>` — führt **einen** headless Retro-Lauf für das
 *     Repo aus und **resolved** bei Erfolg (echtes Prozess-Ende). Ein **Fehlschlag**
 *     (Timeout / Non-Zero-Exit / `auth-expired` / `spawn`-Fehler) wird als
 *     **Rejection** signalisiert. Der Runner ist selbst verantwortlich für sein
 *     Per-Lauf-Audit (AC6) und die Freigabe seines `ProjectJobLock` im `finally`
 *     (AC3, Runner-Seite). Diese Queue behandelt eine Rejection als „Lauf
 *     fehlgeschlagen" → sie **stoppt nicht**, sondern auditiert die Degradation
 *     (secret-frei) und fährt mit dem nächsten Repo fort.
 *
 * Security (Floor):
 *   - **Keine absoluten Host-Pfade / Secrets** in Audit/Log: der Audit-Eintrag bei
 *     Degradation nennt nur einen sanitisierten Repo-Slug (Basename, safe chars).
 *   - `getStatus()` ist read-only, ohne Seiteneffekte (AC4).
 *   - Kein Import/Mutation von `PtyManager`/`PtySessionRegistry`/`CommandService`
 *     (Trust-Boundary — die headless-Naht lebt im injizierten `retroRunner`).
 *
 * Injectable (Test-Entkopplung): `retroRunner` (Pflicht), `auditStore` (optional,
 * best-effort), `identity` (optional, Default `null` = System/auto).
 *
 * @module RetroAutoQueue
 */

import { basename } from 'node:path';

/**
 * Sanitisiert einen Repo-Pfad zu einem kurzen, secret-freien Slug für das
 * Audit-Log (Spec-NFR: **keine absoluten Host-Pfade** in Audit/Log). Nimmt den
 * Basename und beschränkt auf safe chars.
 *
 * @param {unknown} projectPath
 * @returns {string}
 */
export function repoSlug(projectPath) {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') return 'unknown';
  const base = basename(projectPath.trim());
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
  return safe || 'unknown';
}

export class RetroAutoQueue {
  /** @type {{ run: (projectPath: string) => Promise<*> }} */
  #retroRunner;
  /** @type {{ record: Function }|null} */
  #auditStore;
  /** @type {string|null} */
  #identity;

  /** FIFO der wartenden Repo-Pfade (AC1). @type {string[]} */
  #pending = [];
  /** Aktuell laufendes Repo (global genau eins) oder null. @type {string|null} */
  #active = null;
  /** Ein-Worker-Guard: verhindert einen zweiten parallelen Drain-Loop (AC1). */
  #draining = false;

  /**
   * @param {object} deps
   * @param {{ run: (projectPath: string) => Promise<*> }} deps.retroRunner
   *   Headless Retro-Runner (S-257). `run(projectPath)` führt **einen** Lauf aus,
   *   resolved bei Erfolg, **rejected** bei Fehlschlag. EIGENE `HeadlessFlowRunner`-/
   *   `ProjectJobLock`-Instanz + Per-Lauf-Audit (AC6) liegen im Runner, nicht hier.
   * @param {{ record: Function }} [deps.auditStore]  Degradations-Audit (AC3), best-effort.
   * @param {string|null} [deps.identity]  Audit-Identity (Default `null` = System/auto).
   */
  constructor({ retroRunner, auditStore, identity } = {}) {
    if (!retroRunner || typeof retroRunner.run !== 'function') {
      throw new Error('[RetroAutoQueue] retroRunner mit run(projectPath) → Promise ist Pflicht');
    }
    this.#retroRunner = retroRunner;
    this.#auditStore = auditStore ?? null;
    this.#identity = identity ?? null;
  }

  /**
   * Reiht ein Repo ein und startet die Abarbeitung, falls kein Worker läuft (AC1).
   * **Idempotent pro Repo** (AC2): ein bereits eingereihtes **oder** aktives Repo
   * wird nicht doppelt aufgenommen.
   *
   * @param {string} projectPath  validierter Projekt-Repo-Pfad (die Existenz-Prüfung
   *   liegt beim Runner — ein ungültiger Pfad lässt den Lauf scheitern, die Queue
   *   fährt fort, Spec §Edge-Cases).
   * @returns {void}
   */
  enqueue(projectPath) {
    if (typeof projectPath !== 'string' || projectPath.trim() === '') {
      throw new Error('[RetroAutoQueue] enqueue(projectPath) erfordert einen nicht-leeren String');
    }
    // Dedup (AC2): bereits pending ODER aktiv → idempotenter No-Op.
    if (this.isPendingOrActive(projectPath)) return;
    this.#pending.push(projectPath);
    // Worker starten, falls idle. #drain() ist selbst re-entrant-sicher (Guard).
    // Fire-and-forget: #drain() rejected nie (interne try/catch), der optionale
    // .catch() ist reine Tiefenverteidigung.
    this.#drain().catch(() => {});
  }

  /**
   * Dedup-Abfrage für den Auslöser (AC2, [[retro-auto-trigger]] AC5c): true, wenn
   * das Repo bereits eingereiht **oder** gerade aktiv ist.
   *
   * @param {string} projectPath
   * @returns {boolean}
   */
  isPendingOrActive(projectPath) {
    if (typeof projectPath !== 'string' || projectPath.trim() === '') return false;
    if (this.#active === projectPath) return true;
    return this.#pending.includes(projectPath);
  }

  /**
   * Read-only Snapshot ohne Seiteneffekte/Secrets (AC4).
   *
   * @returns {{ active: string|null, pending: string[] }}
   */
  getStatus() {
    return { active: this.#active, pending: [...this.#pending] };
  }

  // ── Worker (ein einziger, global seriell) ───────────────────────────────────

  /**
   * Der eine Worker: zieht das vorderste Repo, führt **einen** Retro-Lauf aus,
   * wartet dessen **echtes Ende** ab und zieht dann das nächste — bis die FIFO
   * leer ist (AC1). Re-entrant-sicher über `#draining`: ein zweiter Aufruf während
   * eines laufenden Drains ist ein No-Op (garantiert **einen** aktiven Lauf).
   *
   * Degradation (AC3): ein **fehlgeschlagener** Lauf (Runner-Rejection) stoppt die
   * Queue **nicht** — er wird secret-frei auditiert, danach folgt das nächste Repo.
   * Der Loop rejected nie nach außen (Robustheit).
   *
   * @returns {Promise<void>}
   */
  async #drain() {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#pending.length > 0) {
        const projectPath = this.#pending.shift();
        this.#active = projectPath;
        try {
          // Echtes Lauf-Ende abwarten → globale Serialisierung (AC1): erst danach
          // wird das nächste Repo gezogen. Nie zwei aktive Läufe gleichzeitig.
          await this.#retroRunner.run(projectPath);
        } catch {
          // AC3: Fehlschlag stoppt die Queue nicht — Degradation secret-frei
          // auditieren (nur Repo-Slug, kein Host-Pfad), dann weiter.
          this.#audit(`retro-auto-queue:run-failed repo=${repoSlug(projectPath)}`);
        } finally {
          this.#active = null;
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  /**
   * Best-effort Degradations-Audit (AC3). Ein Audit-Fehler darf den Worker nie
   * crashen. Keine Secrets/absoluten Host-Pfade im Kommando (nur Repo-Slug).
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
