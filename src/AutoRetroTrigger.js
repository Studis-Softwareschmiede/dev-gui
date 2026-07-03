/**
 * AutoRetroTrigger — Fälligkeits-Prüfung + best-effort Auslösung eines
 * automatischen Retro-Laufs an der Drain-Abschluss-Naht (Nacht **und** manuell)
 * (docs/specs/retro-auto-trigger.md, S-261: AC4, AC5, AC6, AC7).
 *
 * Zweck (Spec §Verhalten, „Fälligkeits-Prüfung + Auslösung"): an **derselben**
 * Stelle, an der ein Drain abschließt und seinen Abschlussbericht schreibt
 * ([[drain-completion-report]] — `NightWatchScheduler#startDrain`-Abschluss für
 * Nacht-Läufe, `projectDrainRouter`-`.then(result)` für manuelle Läufe), wird
 * nach dem Abschluss der Auto-Retro-Check angestoßen. Ist der Lauf fällig, wird
 * das gerade gedrainte Projekt-Repo in die serielle Auto-Retro-Warteschlange
 * ([[retro-auto-queue]], `RetroAutoQueue`) **eingereiht** — **nicht** direkt
 * gestartet.
 *
 * Cross-Trigger-Einheitlichkeit (AC6/AC7): **beide** Auslöser (Nacht + manuell)
 * bekommen in `server.js` **dieselbe** `AutoRetroTrigger`-Instanz injiziert und
 * rufen **denselben** `isRetroDue`-Check gegen **dieselbe** `RetroAutoQueue`-
 * Instanz auf — kein zweiter Codepfad, keine Divergenz.
 *
 * Best-effort / fire-and-forget (AC4, strikt): `notifyDrainComplete()` gibt
 * **sofort synchron** zurück (der eigentliche Settings-Read + Enqueue läuft in
 * einem abgekoppelten Microtask) und wirft **nie** — es darf den Drain-Abschluss,
 * den `NightWatchScheduler`-Tick oder die HTTP-`202`-Antwort **weder blockieren
 * noch crashen**. Jeder Fehler (Settings-Read-Fehler, Queue nicht verdrahtet,
 * Audit-Fehler) ist **non-fatal** → kein Enqueue, Drain-Abschluss unberührt.
 *
 * Fälligkeits-Regel (AC5, `isRetroDue`) — **true genau dann**, wenn ALLE gelten:
 *   (a) der Schalter ist **an** (`readSettings().enabled === true`), **und**
 *   (b) der abgeschlossene Drain hat **echte Arbeit** geleistet
 *       (`drainResult.flowRuns >= 1`) — ein sofort ohne `/flow`-Runde
 *       konvergierter Drain (`flowRuns == 0`) ist **nicht** fällig, **und**
 *   (c) für **dasselbe** Projekt-Repo ist aktuell **kein** Auto-Retro bereits
 *       **eingereiht oder laufend** (Dedup, `RetroAutoQueue.isPendingOrActive`).
 *   Ist (a) false (Schalter aus, Default) → `false` (kein Enqueue, heutiges
 *   Verhalten, AC7). Ist (b) false → `false`.
 *
 * Nicht-Ziele (Spec): **keine** Ausführungs-/Serialisierungslogik hier — die
 * liegt in [[retro-auto-queue]] (Trennung Policy/Mechanismus). `--force`
 * (G3-Cooldown-Bypass) sitzt fest im `HeadlessRetroRunner` hinter der Queue.
 * G1 (Qualitätsschwelle, agent-flow) bleibt in **allen** Fällen unberührt.
 *
 * Security (Floor): `readSettings` liefert nur den nicht-geheimen `enabled`-Bool;
 * **keine** Secrets in Audit/Log — der Enqueue-Audit-Eintrag nennt ausschließlich
 * einen sanitisierten Repo-Slug (`repoSlug`, Basename + safe chars), keinen
 * absoluten Host-Pfad.
 *
 * @module AutoRetroTrigger
 */

import { repoSlug } from './RetroAutoQueue.js';

export class AutoRetroTrigger {
  /** @type {() => Promise<{ enabled: boolean }>} */
  #readSettings;
  /** @type {{ enqueue: Function, isPendingOrActive: Function }} */
  #queue;
  /** @type {{ record: Function }|null} */
  #auditStore;
  /** @type {string|null} */
  #identity;

  /**
   * @param {object} deps
   * @param {() => Promise<{ enabled: boolean }>} deps.readSettings
   *   Settings-Quelle (`RetroAutoSettingsStore.read`) — liefert `{ enabled }`
   *   (Default `enabled:false`, auch bei fehlender/korrupter Datei — kein Crash).
   * @param {{ enqueue: (p: string) => void, isPendingOrActive: (p: string) => boolean }} deps.queue
   *   Serielle Auto-Retro-Warteschlange (`RetroAutoQueue`, S-256). **Dieselbe**
   *   Instanz für Nacht- UND manuellen Auslöser (AC6/AC7).
   * @param {{ record: Function }} [deps.auditStore]  best-effort Enqueue-Audit (secret-frei).
   * @param {string|null} [deps.identity]  Audit-Identity (Default `null` = System/auto).
   */
  constructor({ readSettings, queue, auditStore, identity } = {}) {
    if (typeof readSettings !== 'function') {
      throw new Error('[AutoRetroTrigger] readSettings() → Promise<{enabled}> ist Pflicht');
    }
    if (!queue || typeof queue.enqueue !== 'function' || typeof queue.isPendingOrActive !== 'function') {
      throw new Error('[AutoRetroTrigger] queue mit enqueue()/isPendingOrActive() ist Pflicht');
    }
    this.#readSettings = readSettings;
    this.#queue = queue;
    this.#auditStore = auditStore ?? null;
    this.#identity = identity ?? null;
  }

  /**
   * Fälligkeits-Prüfung (AC5). Liefert `true` **genau dann**, wenn Schalter an
   * (a) UND `flowRuns >= 1` (b) UND kein Auto-Retro für dieses Repo eingereiht/
   * laufend (c). Jeder interne Fehler (Settings-Read-Fehler, Dedup-Abfrage-
   * Fehler) wird als **nicht fällig** (`false`) gewertet — non-fatal, kein
   * Enqueue (Spec §Edge-Cases „Fehler im Auto-Retro-Check → non-fatal").
   *
   * @param {string} projectPath  Projekt-Repo-Pfad (Queue-Dedup-Schlüssel).
   * @param {{ flowRuns?: number }} drainResult  Drain-Ergebnis (nur `flowRuns` relevant).
   * @returns {Promise<boolean>}
   */
  async isRetroDue(projectPath, drainResult) {
    // (a) Schalter — aus/Default oder Read-Fehler → nicht fällig (AC7, Edge-Case).
    let settings;
    try {
      settings = await this.#readSettings();
    } catch {
      return false;
    }
    if (!settings || settings.enabled !== true) return false;

    // (b) echte Arbeit — flowRuns >= 1 (flowRuns==0 → nicht fällig).
    const flowRuns = drainResult?.flowRuns;
    if (!Number.isFinite(flowRuns) || flowRuns < 1) return false;

    // (c) Dedup — gültiger Pfad UND nicht bereits eingereiht/laufend.
    if (typeof projectPath !== 'string' || projectPath.trim() === '') return false;
    try {
      if (this.#queue.isPendingOrActive(projectPath)) return false;
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Best-effort/fire-and-forget Auslösung an der Drain-Abschluss-Naht (AC4/AC6).
   * Gibt **sofort synchron** zurück und wirft **nie** — der Settings-Read +
   * Enqueue läuft in einem abgekoppelten Microtask. Ist der Lauf fällig
   * (`isRetroDue == true`), wird das Repo **genau einmal** eingereiht
   * (`enqueue`, Dedup in (c) verhindert Doppel-Enqueue) und der Enqueue
   * secret-frei auditiert. Andernfalls passiert **nichts** (kein Enqueue, AC7).
   *
   * @param {string} projectPath  gerade gedrainter Projekt-Repo-Pfad.
   * @param {{ flowRuns?: number }} drainResult  Drain-Ergebnis (`flowRuns`).
   * @returns {void}
   */
  notifyDrainComplete(projectPath, drainResult) {
    try {
      // Abgekoppelter Microtask: blockiert den Aufrufer (Drain-Naht/HTTP) nie;
      // ein Rejection wird geschluckt (best-effort, AC4 „crasht nie").
      Promise.resolve()
        .then(async () => {
          const due = await this.isRetroDue(projectPath, drainResult);
          if (!due) return;
          this.#queue.enqueue(projectPath);
          this.#audit(`retro-auto:enqueued repo=${repoSlug(projectPath)}`);
        })
        .catch(() => {});
    } catch {
      // Ein synchroner Fehler (praktisch unmöglich) darf die Naht nie crashen.
    }
  }

  /**
   * Best-effort Enqueue-Audit (secret-frei, nur Repo-Slug). Ein Audit-Fehler darf
   * die Auslösung nie crashen.
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
