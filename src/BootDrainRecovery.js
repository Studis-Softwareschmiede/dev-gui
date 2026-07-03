/**
 * BootDrainRecovery — Boot-Wiederanlauf verwaister Drains
 * (docs/specs/drain-restart-robustness.md AC5–AC8, S-283).
 *
 * Konsumiert die von `DrainJobRegistry#reconcileOrphans()` beim Boot
 * zurückgegebenen, gerade als `aborted` markierten Einträge (AC4, bereits
 * S-282) und stößt je **distinktem** Projekt **genau einen** idempotenten
 * Wiederanlauf-Drain an — `ProjectDrain` re-scannt das Board selbst und
 * konvergiert (ein bereits leergezogenes Board ⇒ harmloser No-op, AC8).
 *
 * Dedup (AC5): Gruppierung nach `(project, trigger)` — mehrere verwaiste
 * Einträge desselben Projekts/Triggers ⇒ EIN Wiederanlauf. Ein Projekt mit
 * SOWOHL einem verwaisten `manual`- ALS AUCH einem verwaisten `night`-Eintrag
 * bekommt bis zu zwei Wiederanläufe (je EINEN pro Trigger, unterschiedliche
 * `ProjectDrain`-Instanzen/Engines — kein Widerspruch zu "genau einen je
 * Projekt", das sich auf "je Projekt UND Trigger" bezieht, s. AC6/AC7-Text).
 *
 * Manueller Orphan (AC6/A2/A3): automatisch (ohne Bestätigung) über die
 * MANUELLE `ProjectDrain`-Instanz, unter Replay der persistierten
 * `args`/`costMode` 1:1; vorher eine LESENDE `isProjectBusy`-Prüfung gegen
 * die manuelle Lock-Instanz (busy → kein Doppel-Start, Edge-Case "Nacht-
 * Wiederanlauf desselben Projekts startete zuerst").
 *
 * Nacht-Orphan (AC7/A1): nur über die NACHT-`ProjectDrain`-Instanz, wenn
 * der Boot-Zeitpunkt **innerhalb** des Nachtfensters liegt UND der
 * Nacht-Modus aktiviert ist UND `ClaudeAuthHealthService.getState()` nicht
 * `expired` meldet — sonst bleibt der Eintrag `aborted` (bereits durch
 * `reconcileOrphans()` gesetzt) und der reguläre Scheduler-Tick übernimmt im
 * nächsten Fenster (kein separater Boot-Lauf).
 *
 * Best-effort/degradierend (AC8): jeder Fehler (Slug→Pfad-Auflösung,
 * Pfad-Validierung, Store-I/O, Drain-Start) wird EINZELN je Projekt gefangen
 * — ein nicht mehr auflösbarer Slug (Repo entfernt) wird übersprungen, die
 * übrigen Projekte laufen weiter; der gesamte `run()`-Aufruf wirft NIE
 * (zusätzliche Tiefenverteidigung, damit der Server-Boot unter keinen
 * Umständen crasht). Kein Restart von in DIESER Boot-Runde neu gestarteten
 * Läufen — `run()` konsumiert ausschließlich die ÜBERGEBENEN Orphan-Einträge
 * (ein einmaliger Snapshot aus `reconcileOrphans()`, NICHT erneut abgefragt).
 *
 * Wiederverwendung (keine neue Kindprozess-/Lock-/Persistenz-Disziplin):
 *   `DrainJobRegistry` (register/markDone/markFailed — dieselbe geteilte
 *   Instanz wie Nacht-/manueller Drain), `ProjectDrain.drainProject()`
 *   (unverändert), `resolveProjectSlug`/`validateProjectPath`
 *   (`workspacePath.js`, identischer Auflösungspfad wie `projectDrainRouter`),
 *   `isProjectBusy`/`ProjectJobLock` (`ProjectJobLock.js`), `isWithinWindow`
 *   (`NightWatchScheduler.js`), `ClaudeAuthHealthService`, `AuditStore` (ein
 *   secret-freier Eintrag je Wiederanlauf-Start, NUR Slug + Trigger).
 *
 * Security (Floor): keine Secrets/Roh-Fehlertexte im Audit-Log; Slug→Pfad
 * ausschließlich über die validierte `resolveProjectSlug`+`validateProjectPath`-
 * Kette (realpath-Containment gegen `WORKSPACE_DIR`) — kein Freitext-Pfad aus
 * der persistierten Registry-Datei.
 *
 * Testbarkeit (NFR): injizierbare Uhr (`now`), injizierbare
 * `resolveProjectSlug`/`validateProjectPath`-Funktionen, gemockte
 * `ProjectDrain`/`DrainJobRegistry`/`readSettings`/`claudeAuthHealthService` —
 * kein echter `claude -p`-Lauf im Test-Gate.
 *
 * @module BootDrainRecovery
 */

import { randomUUID } from 'node:crypto';
import { resolveProjectSlug as defaultResolveProjectSlug, validateProjectPath as defaultValidateProjectPath } from './workspacePath.js';
import { isProjectBusy } from './ProjectJobLock.js';
import { isWithinWindow } from './NightWatchScheduler.js';

/**
 * Gruppiert verwaiste Registry-Einträge nach `(project, trigger)` (AC5,
 * reine Hilfsfunktion, direkt unit-testbar). Mehrere Einträge desselben
 * Projekts/Triggers ⇒ nur der ZULETZT iterierte Eintrag bleibt (jüngste
 * Registrierung, `Map`-Iterationsreihenfolge = Einfüge-/Registry-Reihenfolge).
 * Einträge ohne gültigen (nicht-leeren String) `project` oder mit unbekanntem
 * `trigger` werden übersprungen (defensiv — sollte wegen der
 * `DrainJobRegistry`-eigenen Validierung beim Laden nie vorkommen).
 *
 * @param {Array<{project?: string, trigger?: string}>} orphanEntries
 * @returns {{ manual: Map<string, object>, night: Map<string, object> }}
 */
export function groupOrphansByProjectTrigger(orphanEntries) {
  const manual = new Map();
  const night = new Map();
  if (!Array.isArray(orphanEntries)) return { manual, night };
  for (const entry of orphanEntries) {
    if (!entry || typeof entry.project !== 'string' || entry.project === '') continue;
    if (entry.trigger === 'manual') {
      manual.set(entry.project, entry);
    } else if (entry.trigger === 'night') {
      night.set(entry.project, entry);
    }
  }
  return { manual, night };
}

export class BootDrainRecovery {
  #drainJobRegistry;
  #manualProjectDrain;
  #nightProjectDrain;
  #manualDrainLock;
  #commandService;
  #sessionRegistry;
  #resolveProjectSlug;
  #validateProjectPath;
  #readSettings;
  #claudeAuthHealthService;
  #auditStore;
  #identity;
  #now;

  /**
   * @param {object} deps
   * @param {import('./DrainJobRegistry.js').DrainJobRegistry} [deps.drainJobRegistry]
   *   Geteilte, datei-persistierte Registry (dieselbe Instanz wie Nacht-/
   *   manueller Drain) — für den frischen `running`-Eintrag je Wiederanlauf
   *   + die terminale Markierung (`markDone`/`markFailed`).
   * @param {{ drainProject: (path: string, opts?: object) => Promise<object> }} [deps.manualProjectDrain]
   *   Die DEDIZIERTE manuelle `ProjectDrain`-Instanz (AC6).
   * @param {{ drainProject: (path: string, opts?: object) => Promise<object> }} [deps.nightProjectDrain]
   *   Die SEPARATE Nacht-`ProjectDrain`-Instanz (AC7).
   * @param {import('./ProjectJobLock.js').ProjectJobLock} [deps.manualDrainLock]
   *   Dieselbe Session-Lock-Instanz, die `manualProjectDrain` hält — für die
   *   lesende `isProjectBusy`-Vorabprüfung (AC6). Ohne sie wird NICHT
   *   vorab geprüft (der interne Busy-/Lock-Check in `drainProject()` selbst
   *   greift trotzdem — reine Tiefenverteidigung entfällt dann).
   * @param {{ getStatus: () => { status: string|null } }} [deps.commandService]
   *   Zusätzliches Busy-Signal (analog `projectDrainRouter`s `isProjectBusy`-
   *   Aufruf) — optional, ohne es trägt nur der Lock zum Busy-Ergebnis bei.
   * @param {{ hasSession: (p: string) => boolean }} [deps.sessionRegistry]
   *   Zusätzliches Busy-Signal (analog `projectDrainRouter`) — optional.
   * @param {(slug: string|null) => string|null} [deps.resolveProjectSlug]
   *   Default: `resolveProjectSlug` aus `workspacePath.js`.
   * @param {(path: string) => Promise<{resolvedPath: string}>} [deps.validateProjectPath]
   *   Default: `validateProjectPath` aus `workspacePath.js`.
   * @param {() => Promise<import('./TickerSettingsStore.js').TickerSettings>} [deps.readSettings]
   *   Nachtwächter-Settings-Quelle (AC7-Gating: `enabled` + `window`).
   * @param {{ getState: () => { claudeAuth: 'ok'|'expired'|'unknown' } }} [deps.claudeAuthHealthService]
   *   Auth-Gate für den Nacht-Wiederanlauf (AC7).
   * @param {{ record: Function }} [deps.auditStore]
   *   Je Wiederanlauf-Start EIN secret-freier Audit-Eintrag (nur Slug + Trigger).
   * @param {string|null} [deps.identity]  auslösende Identität (Audit + Drain-Weiterreichung).
   * @param {() => number} [deps.now]  injizierbare Uhr (ms epoch), Default `Date.now`.
   */
  constructor({
    drainJobRegistry,
    manualProjectDrain,
    nightProjectDrain,
    manualDrainLock,
    commandService,
    sessionRegistry,
    resolveProjectSlug,
    validateProjectPath,
    readSettings,
    claudeAuthHealthService,
    auditStore,
    identity = null,
    now,
  } = {}) {
    this.#drainJobRegistry = drainJobRegistry ?? null;
    this.#manualProjectDrain = manualProjectDrain ?? null;
    this.#nightProjectDrain = nightProjectDrain ?? null;
    this.#manualDrainLock = manualDrainLock ?? null;
    this.#commandService = commandService ?? null;
    this.#sessionRegistry = sessionRegistry ?? null;
    this.#resolveProjectSlug = resolveProjectSlug ?? defaultResolveProjectSlug;
    this.#validateProjectPath = validateProjectPath ?? defaultValidateProjectPath;
    this.#readSettings = readSettings ?? null;
    this.#claudeAuthHealthService = claudeAuthHealthService ?? null;
    this.#auditStore = auditStore ?? null;
    this.#identity = identity;
    this.#now = now ?? (() => Date.now());
  }

  /**
   * Führt den Boot-Wiederanlauf EINMALIG für die übergebenen Orphan-Einträge
   * aus (AC5–AC8). Wirft NIE (Tiefenverteidigung zusätzlich zu den je-Projekt
   * gefangenen Fehlern — der Server-Boot darf unter keinen Umständen crashen).
   *
   * @param {Array<object>} orphanEntries  Rückgabe von `DrainJobRegistry#reconcileOrphans()`.
   * @returns {Promise<void>}
   */
  async run(orphanEntries) {
    try {
      const { manual, night } = groupOrphansByProjectTrigger(orphanEntries);

      // AC6: manueller Orphan → automatisch, sofort (kein Fenster-/Auth-Gate).
      for (const [project, entry] of manual) {
        await this.#restartOne({ project, entry, trigger: 'manual', projectDrain: this.#manualProjectDrain, checkBusy: true });
      }

      // AC7: Nacht-Orphan → nur innerhalb des Nachtfensters + Nacht-Modus aktiv + Auth nicht expired.
      if (night.size > 0) {
        const gateOpen = await this.#evaluateNightGate();
        if (gateOpen) {
          for (const [project, entry] of night) {
            await this.#restartOne({ project, entry, trigger: 'night', projectDrain: this.#nightProjectDrain, checkBusy: false });
          }
        }
        // sonst: kein Boot-Lauf — die Einträge bleiben `aborted` (bereits durch
        // reconcileOrphans() gesetzt), der reguläre Scheduler-Tick übernimmt.
      }
    } catch {
      // AC8: best-effort/degradierend — der Server-Boot darf nie crashen.
    }
  }

  /**
   * AC7-Gate: Boot-Zeitpunkt im Nachtfenster UND Nacht-Modus aktiv UND Auth
   * nicht `expired`. Jeder Lese-/Zugriffsfehler schließt das Gate defensiv
   * (kein Boot-Lauf statt eines Fehlalarm-Starts) — best-effort (AC8).
   *
   * @returns {Promise<boolean>}
   */
  async #evaluateNightGate() {
    if (!this.#readSettings) return false;
    let settings;
    try {
      settings = await this.#readSettings();
    } catch {
      return false;
    }
    if (!settings?.enabled) return false;
    if (!isWithinWindow(this.#now(), settings.window ?? {})) return false;
    if (this.#claudeAuthHealthService) {
      let state;
      try {
        state = this.#claudeAuthHealthService.getState();
      } catch {
        return false;
      }
      if (state?.claudeAuth === 'expired') return false;
    }
    return true;
  }

  /**
   * Stößt EINEN Wiederanlauf-Drain für ein Projekt an (AC6/AC7/AC8). Jeder
   * Fehler (Slug-Auflösung, Pfad-Validierung, Registry-I/O) wird EINZELN
   * gefangen — ein Fehl-Projekt überspringt sich selbst, ohne die übrigen
   * Projekte zu beeinträchtigen (AC8).
   *
   * @param {object} args
   * @param {string} args.project  Projekt-Slug (aus dem verwaisten Eintrag).
   * @param {{ args?: string[] }} args.entry  der verwaiste Registry-Eintrag (für den args-Replay, A3).
   * @param {'manual'|'night'} args.trigger
   * @param {{ drainProject: Function }|null} args.projectDrain  die zuständige ProjectDrain-Instanz.
   * @param {boolean} args.checkBusy  ob vorher lesend `isProjectBusy` geprüft wird (AC6).
   */
  async #restartOne({ project, entry, trigger, projectDrain, checkBusy }) {
    if (!projectDrain || typeof projectDrain.drainProject !== 'function') return;

    let resolvedPath;
    try {
      const slugPath = this.#resolveProjectSlug(project);
      if (slugPath === null) return; // sollte für einen persistierten Slug nie vorkommen
      const { resolvedPath: p } = await this.#validateProjectPath(slugPath);
      resolvedPath = p;
    } catch {
      // AC8: Slug löst nicht mehr auf (Repo entfernt/umbenannt) → übersprungen.
      return;
    }

    if (checkBusy && this.#manualDrainLock) {
      try {
        const busyOpts = { lock: this.#manualDrainLock };
        if (this.#commandService) busyOpts.commandService = this.#commandService;
        if (this.#sessionRegistry) busyOpts.sessionRegistry = this.#sessionRegistry;
        if (isProjectBusy(resolvedPath, busyOpts)) return; // AC6: kein Doppel-Start
      } catch {
        return; // best-effort — ein Busy-Check-Fehler löst KEINEN Start aus (konservativ)
      }
    }

    const replayArgs = Array.isArray(entry?.args) ? entry.args : [];
    const drainId = randomUUID();
    const startedAt = new Date(this.#now()).toISOString();

    if (this.#drainJobRegistry && typeof this.#drainJobRegistry.register === 'function') {
      try {
        const p = this.#drainJobRegistry.register(drainId, { project, trigger, args: replayArgs, startedAt });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        // best-effort — ein Registrierungsfehler darf den Wiederanlauf nicht verhindern.
      }
    }

    this.#audit(`boot-drain-restart trigger=${trigger} project=${project}`);

    try {
      projectDrain
        .drainProject(resolvedPath, { identity: this.#identity, args: replayArgs })
        .then((result) => this.#markDone(drainId, result ?? {}))
        .catch(() => this.#markFailed(drainId));
    } catch {
      // best-effort — ein synchroner Start-Fehler darf den Boot nicht crashen.
      this.#markFailed(drainId);
    }
  }

  /** @param {string} drainId @param {object} result */
  #markDone(drainId, result) {
    if (!this.#drainJobRegistry || typeof this.#drainJobRegistry.markDone !== 'function') return;
    try {
      const p = this.#drainJobRegistry.markDone(drainId, result ?? {});
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // best-effort
    }
  }

  /** @param {string} drainId */
  #markFailed(drainId) {
    if (!this.#drainJobRegistry || typeof this.#drainJobRegistry.markFailed !== 'function') return;
    try {
      const p = this.#drainJobRegistry.markFailed(drainId);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // best-effort
    }
  }

  /**
   * Best-effort Audit-Eintrag — NUR Slug + Trigger (kein Pfad, kein Secret,
   * NFR-Floor der Spec). Ein Audit-Fehler darf den Wiederanlauf nicht verhindern.
   * @param {string} command
   */
  #audit(command) {
    if (!this.#auditStore) return;
    try {
      this.#auditStore.record({ identity: this.#identity, command });
    } catch {
      // best-effort
    }
  }
}
