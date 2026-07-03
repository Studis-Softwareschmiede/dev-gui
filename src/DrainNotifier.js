/**
 * DrainNotifier — genau EIN ntfy-Push je abgeschlossenem Board-Drain mit
 * kompakter Bilanz (docs/specs/drain-done-notification.md, S-277: AC1–AC7).
 *
 * Erweitert um `notifyQuestionsPending()` (docs/specs/questions-pending-notification.md,
 * S-279: AC1–AC6) — GETEILTER Notifier-Baustein (derselbe Config-/Token-/
 * Versand-Pfad wie `notifyDrainDone`, kein zweiter Codepfad). Sendet best-effort
 * GENAU EINEN Push je Eintritt des `ObsidianIngestRunner` in den Interrupt-
 * Zustand `needs-answers` (Meldeklasse „Eingabe zwingend nötig", A2/AC3: Label
 * = Basename des Projektpfads, NIE der volle Host-Pfad). Gating (AC2): No-op
 * wenn Config `enabled=false` ODER `questions_pending` nicht in `events`.
 * Best-effort/non-fatal wie `notifyDrainDone` (AC4): jeder Fehler wird
 * gefangen und secret-frei geloggt, `notifyQuestionsPending()` wirft NIE.
 *
 * Zweck (Spec §Zweck): statt vieler Einzel-Story-Pushes erhält der Owner
 * **genau einen** Push je qualifiziertem Drain-Ende — für BEIDE Drain-Auslöser
 * (manueller „Board abarbeiten"-Knopf UND Nachtwächter-Drain). Ein eigener
 * Produzent, der **nicht** über die Board-Übergangs-Erkennung des
 * `NotificationWatcher` ([[push-notifications]] AC6) läuft (AC5: kein
 * Doppelfeuern mit `story_done`).
 *
 * Gating (AC1, A1/A2): No-op wenn
 *   - `result.flowRuns <= 0` (Leerlauf-Drain, A1) ODER
 *   - die Notification-Config `enabled=false` liefert ODER
 *   - `drain_done` nicht in `config.events` enthalten ist.
 * Sonst: genau EIN Versand via `sendNotificationFn` ([[push-notifications]] AC4).
 *
 * Bilanz-Payload (AC2, A2/A3): Titel „🏁 <slug>: X Done, Y Blocked" mit
 * `X = completed.length`, `Y = blocked.length`; bei nicht-leerem
 * `result.budgetPauses` zusätzlich „ · Z Budget-Pausen". `<slug>` ist der
 * Projekt-Slug (nie ein absoluter Pfad, A3). `budgetPauses` wird defensiv
 * gelesen — fehlt es (heutiger Zustand, solange [[night-budget-guard]] nicht
 * gelandet ist), entfällt der Zusatz (vorwärtskompatibel, keine harte
 * Abhängigkeit).
 *
 * Best-effort/non-fatal (AC3/AC4/AC5): jeder Fehler (Config-Lesefehler,
 * Token-Lesefehler, Netz-/Non-2xx-Fehler des Versands) wird gefangen und
 * secret-frei geloggt — `notifyDrainDone()` wirft NIE. Weder der Drain-
 * Abschluss noch der Bericht-Write noch der Auto-Retro-Check noch der
 * Scheduler dürfen dadurch beeinträchtigt werden.
 *
 * Security (AC7, Floor, hart): weder Push noch Log noch Fehlermeldung
 * enthalten den ntfy-Token, einen absoluten Host-Pfad oder ein Secret — nur
 * der Slug + die Bilanz-Zähler. Der Token bleibt store-intern (nur im
 * `Authorization`-Header von `sendNotificationFn`, s. `NotifyService.js`).
 *
 * @module DrainNotifier
 */

/** ntfy-Tag für Drain-Fertig-Pushes (Implementierungswahl, s. Spec §Verträge). */
const DRAIN_DONE_TAGS = ['checkered_flag'];

/** ntfy-Tag für Fragen-offen-Pushes (questions-pending-notification §Verträge). */
const QUESTIONS_PENDING_TAGS = ['question'];

/** Fallback-Label, falls kein verwertbarer Basename ermittelt werden kann (AC6, Edge-Case). */
const QUESTIONS_PENDING_FALLBACK_LABEL = 'Projekt';

/**
 * Baut den Bilanz-Payload für einen qualifizierten Drain-Abschluss (AC2).
 *
 * @param {string} slug  Projekt-Slug (A3, kein Pfad).
 * @param {{ completed?: object[], blocked?: object[], budgetPauses?: object[] }} result
 * @returns {{ title: string, message: string, tags: string[] }}
 */
export function buildDrainDonePayload(slug, result) {
  const completedCount = Array.isArray(result?.completed) ? result.completed.length : 0;
  const blockedCount = Array.isArray(result?.blocked) ? result.blocked.length : 0;
  const budgetPauses = Array.isArray(result?.budgetPauses) ? result.budgetPauses : [];

  let title = `🏁 ${slug}: ${completedCount} Done, ${blockedCount} Blocked`;
  if (budgetPauses.length > 0) {
    title += ` · ${budgetPauses.length} Budget-Pausen`;
  }

  let message = `${slug}: ${completedCount} erledigt, ${blockedCount} blockiert`;
  if (budgetPauses.length > 0) {
    message += `, ${budgetPauses.length} Budget-Pause(n)`;
  }

  return { title, message, tags: [...DRAIN_DONE_TAGS] };
}

/**
 * Baut den Fragen-offen-Payload (questions-pending-notification AC3).
 * Secret-/pfad-frei: `label` ist bereits der Basename (nie ein Pfad), ein
 * leeres/fehlendes Label fällt defensiv auf einen generischen Platzhalter
 * zurück (AC6, Edge-Case „kein verwertbarer Basename").
 *
 * @param {string} label - Basename des Projektpfads (A2, nie der volle Pfad).
 * @param {number} [questionCount] - Anzahl offener Fragen (`catalog.length`, optional).
 * @returns {{ title: string, message: string, tags: string[] }}
 */
export function buildQuestionsPendingPayload(label, questionCount) {
  const safeLabel = typeof label === 'string' && label.trim() !== '' ? label.trim() : QUESTIONS_PENDING_FALLBACK_LABEL;
  const hasCount = Number.isFinite(questionCount) && questionCount > 0;

  const title = `❓ ${safeLabel}: Fragen offen`;
  const message = hasCount
    ? `${safeLabel}: ${questionCount} offene Frage(n) warten auf Antwort.`
    : `${safeLabel}: Ein Fragenkatalog wartet auf Antwort.`;

  return { title, message, tags: [...QUESTIONS_PENDING_TAGS] };
}

export class DrainNotifier {
  /** @type {() => Promise<{ enabled: boolean, server: string, topic: string, priority?: number|null, events: string[] }>} */
  #getNotificationConfig;
  /** @type {() => Promise<string|null>} */
  #getToken;
  /** @type {(config: object, payload: object) => Promise<*>} */
  #sendNotificationFn;

  /**
   * @param {object} deps
   * @param {() => Promise<object>} deps.getNotificationConfig
   *   Config-Provider (dieselbe Quelle wie `NotificationWatcher`,
   *   `NotificationSettingsStore.read`) — liefert `{ enabled, server, topic,
   *   priority, events }`.
   * @param {() => Promise<string|null>} deps.getToken
   *   Token-Getter (CredentialStore-Lesen, dieselbe Quelle wie
   *   `NotificationWatcher` — NIE im Log).
   * @param {(config: object, payload: object) => Promise<*>} deps.sendNotificationFn
   *   Versand-Funktion ([[push-notifications]] AC4, `NotifyService.sendNotification`).
   */
  constructor({ getNotificationConfig, getToken, sendNotificationFn } = {}) {
    this.#getNotificationConfig = getNotificationConfig;
    this.#getToken = getToken;
    this.#sendNotificationFn = sendNotificationFn;
  }

  /**
   * Sendet best-effort GENAU EINE Drain-Fertig-Notification (AC1/AC2/AC3/AC4).
   * No-op wenn `result.flowRuns <= 0` (A1) ODER Config `enabled=false` ODER
   * `drain_done` nicht in `events`. Wirft NIE — jeder Fehler wird gefangen und
   * secret-frei geloggt (AC5/AC7).
   *
   * @param {{ slug: string, result: object }} args
   * @returns {Promise<void>}
   */
  async notifyDrainDone({ slug, result } = {}) {
    try {
      const flowRuns = result?.flowRuns;
      if (!Number.isFinite(flowRuns) || flowRuns <= 0) return; // A1: Leerlauf-Drain → kein Push

      if (typeof this.#getNotificationConfig !== 'function' || typeof this.#sendNotificationFn !== 'function') {
        return; // AC6: fehlende Boundary → No-op (Default-Regress)
      }

      let config;
      try {
        config = await this.#getNotificationConfig();
      } catch (err) {
        console.error('[DrainNotifier] Config lesen fehlgeschlagen (best-effort, kein Push):', err.message);
        return;
      }

      if (!config?.enabled) return; // Gating
      if (!Array.isArray(config.events) || !config.events.includes('drain_done')) return; // Gating

      let token = null;
      if (typeof this.#getToken === 'function') {
        try {
          token = await this.#getToken();
        } catch (err) {
          // Token-Lese-Fehler → kein Hard-Stop, Versand ohne Token (analog NotificationWatcher).
          console.error('[DrainNotifier] Token-Lesen fehlgeschlagen:', err.message);
        }
      }

      const payload = buildDrainDonePayload(slug, result);

      try {
        await this.#sendNotificationFn(
          {
            server: config.server,
            topic: config.topic,
            priority: config.priority,
            token, // AC7: Token NIE im Log
          },
          payload,
        );
      } catch (err) {
        console.error('[DrainNotifier] Versand fehlgeschlagen (best-effort):', err.message);
      }
    } catch (err) {
      // Tiefenverteidigung: darf den Drain-Abschluss/Scheduler NIE crashen (AC3/AC4/AC5).
      console.error('[DrainNotifier] Unerwarteter Fehler (best-effort, kein Crash):', err?.message ?? String(err));
    }
  }

  /**
   * Sendet best-effort GENAU EINEN Fragen-offen-Push, wenn ein
   * `ObsidianIngestRunner`-Job in `needs-answers` wechselt
   * (questions-pending-notification AC1/AC2/AC3/AC4). No-op wenn Config
   * `enabled=false` ODER `questions_pending` nicht in `events` (AC2) ODER die
   * Boundary (`getNotificationConfig`/`sendNotificationFn`) nicht injiziert
   * ist (AC5, Default-Regress). Wirft NIE — jeder Fehler wird gefangen und
   * secret-frei geloggt (AC4/AC6).
   *
   * @param {{ label: string, questionCount?: number }} args
   * @returns {Promise<void>}
   */
  async notifyQuestionsPending({ label, questionCount } = {}) {
    try {
      if (typeof this.#getNotificationConfig !== 'function' || typeof this.#sendNotificationFn !== 'function') {
        return; // AC5: fehlende Boundary → No-op (Default-Regress)
      }

      let config;
      try {
        config = await this.#getNotificationConfig();
      } catch (err) {
        console.error('[DrainNotifier] Config lesen fehlgeschlagen (best-effort, kein Push):', err.message);
        return;
      }

      if (!config?.enabled) return; // Gating (AC2)
      if (!Array.isArray(config.events) || !config.events.includes('questions_pending')) return; // Gating (AC2)

      let token = null;
      if (typeof this.#getToken === 'function') {
        try {
          token = await this.#getToken();
        } catch (err) {
          // Token-Lese-Fehler → kein Hard-Stop, Versand ohne Token (analog notifyDrainDone).
          console.error('[DrainNotifier] Token-Lesen fehlgeschlagen:', err.message);
        }
      }

      const payload = buildQuestionsPendingPayload(label, questionCount);

      try {
        await this.#sendNotificationFn(
          {
            server: config.server,
            topic: config.topic,
            priority: config.priority,
            token, // AC6: Token NIE im Log
          },
          payload,
        );
      } catch (err) {
        console.error('[DrainNotifier] Versand fehlgeschlagen (best-effort):', err.message);
      }
    } catch (err) {
      // Tiefenverteidigung: darf den ObsidianIngestRunner NIE crashen (AC4).
      console.error('[DrainNotifier] Unerwarteter Fehler (best-effort, kein Crash):', err?.message ?? String(err));
    }
  }
}
