/**
 * RunStateWatcher.js — SSE-Producer für Run-State-Änderungen (run-state-live-view
 * AC4, AC5)
 *
 * Beobachtet periodisch (analog `NotificationWatcher`) den bereits von
 * `BoardAggregator` gescannten Index und erkennt, welche Projekte ein
 * VERÄNDERTES `runs`-Abbild haben (`board/runs/F-###/state.yaml`-Inhalt, siehe
 * `src/RunStateReader.js`). Für jedes betroffene Projekt wird GENAU EIN
 * `BoardEventHub.broadcast({ slug })` ausgelöst — dieselbe, bestehende
 * SSE-Infrastruktur wie `NotificationWatcher` (kein neuer Auth-/Transport-Weg,
 * kein zweites Frame-Format).
 *
 * HARTES Owner-AC (AC4): jede Schreiboperation des Feature-Drains an
 * state.yaml führt — ohne manuellen Refresh — zu einem Broadcast. Da der
 * Feature-Drain typischerweise NICHT im selben Prozess läuft, verlässt sich
 * dieser Watcher auf einen periodischen Snapshot-Diff (Muster
 * `NotificationWatcher`) statt auf einen dedizierten `fs.watch`-Callback pro
 * state.yaml — `BoardAggregator`s bestehender `fs.watch()`-Watcher (rekursiv je
 * Board-Root) invalidiert ohnehin den In-Memory-Index bei JEDER Änderung
 * innerhalb des Repos (inkl. `board/runs/`), sodass der nächste periodische
 * Check dieses Watchers frische Daten sieht.
 *
 * AC5: Der Producer feuert NICHT im Ruhezustand (nur bei tatsächlicher
 * Run-State-Änderung) und NICHT beim Baseline-/Erst-Scan (analog
 * `NotificationWatcher` AC7/AC9).
 *
 * Fehlertoleranz: Board-Scan-Fehler oder Broadcast-Fehler crashen den Watcher
 * nie (best-effort, degradierend — analog `NotificationWatcher`).
 *
 * @module RunStateWatcher
 */

/** Default-Check-Intervall in Millisekunden. */
const WATCHER_INTERVAL_MS = 15_000;

/**
 * Baut einen stabilen Fingerabdruck-String für die `runs`-Liste eines Projekts —
 * für den reinen Änderungsvergleich (kein Persistieren, kein Secret-Inhalt).
 *
 * @param {Array<import('./BoardAggregator.js').RunEntry>} runs
 * @returns {string}
 */
function fingerprintRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return '';
  return runs
    .map((r) =>
      [
        r.feature,
        r.phase,
        r.currentStory,
        r.done,
        r.total,
        r.round,
        r.startedAt,
        r.lastError,
        r.isLastRun,
      ].join('|')
    )
    .sort() // Reihenfolge im Verzeichnis-Listing ist nicht signifikant
    .join('::');
}

/**
 * Berechnet je Projekt-Slug den aktuellen Run-State-Fingerabdruck.
 *
 * @param {Array<import('./BoardAggregator.js').ProjectEntry|import('./BoardAggregator.js').ErrorEntry>} index
 * @returns {Record<string, string>}
 */
export function buildRunStateSnapshot(index) {
  const snapshot = {};
  for (const project of index) {
    if (project.error) continue;
    const slug = project.project_slug ?? project.slug;
    if (!slug) continue;
    snapshot[slug] = fingerprintRuns(project.runs);
  }
  return snapshot;
}

/**
 * Erkennt Projekt-Slugs, deren Run-State-Fingerabdruck sich gegenüber dem
 * vorherigen Snapshot geändert hat (AC5: nur bei tatsächlicher Änderung).
 *
 * @param {Record<string, string>} oldSnapshot
 * @param {Record<string, string>} newSnapshot
 * @returns {Set<string>}
 */
export function detectRunStateChanges(oldSnapshot, newSnapshot) {
  const changed = new Set();
  const allSlugs = new Set([...Object.keys(oldSnapshot), ...Object.keys(newSnapshot)]);
  for (const slug of allSlugs) {
    if (oldSnapshot[slug] !== newSnapshot[slug]) {
      changed.add(slug);
    }
  }
  return changed;
}

/**
 * RunStateWatcher — periodischer Board-Beobachter, der Run-State-Änderungen
 * (board/runs/F-###/state.yaml) erkennt und je betroffenem Projekt genau einen
 * SSE-Broadcast auslöst.
 *
 * @param {object} deps
 * @param {import('./BoardAggregator.js').BoardAggregator} deps.boardAggregator
 * @param {import('./BoardEventHub.js').BoardEventHub|null} [deps.boardEventHub] — null-tolerant.
 * @param {number} [deps.intervalMs] — Check-Intervall in ms (Default 15 000).
 */
export class RunStateWatcher {
  #boardAggregator;
  #boardEventHub;
  #intervalMs;
  #intervalHandle = null;
  /** @type {Record<string,string>|null} null = Baseline noch nicht etabliert. */
  #snapshot = null;

  constructor({ boardAggregator, boardEventHub, intervalMs }) {
    this.#boardAggregator = boardAggregator;
    this.#boardEventHub = boardEventHub ?? null;
    this.#intervalMs = intervalMs ?? WATCHER_INTERVAL_MS;
  }

  /**
   * Startet den periodischen Watcher. Der erste Check etabliert die Baseline
   * (kein Broadcast, AC5). Idempotent: mehrfache Aufrufe stoppen den vorherigen Timer.
   */
  start() {
    this.stop();
    this.check().catch(() => {}); // best-effort: kein Crash
    this.#intervalHandle = setInterval(() => {
      this.check().catch(() => {}); // best-effort: kein Crash
    }, this.#intervalMs);
    if (this.#intervalHandle.unref) this.#intervalHandle.unref();
  }

  /** Stoppt den periodischen Watcher. */
  stop() {
    if (this.#intervalHandle !== null) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
  }

  /**
   * Führt einen einmaligen Check durch. Kann auch manuell aufgerufen werden
   * (z.B. nach einem expliziten rescan, analog NotificationWatcher).
   *
   * @returns {Promise<void>}
   */
  async check() {
    let index;
    try {
      index = await this.#boardAggregator.getIndex();
    } catch (err) {
      // Board-Scan-Fehler → kein Update, kein Broadcast (Fehlertoleranz).
      console.error('[RunStateWatcher] Board-Scan fehlgeschlagen (kein Update):', err.message);
      return;
    }

    const newSnapshot = buildRunStateSnapshot(index);

    if (this.#snapshot === null) {
      // AC5: Baseline-/Erst-Scan → KEIN Broadcast.
      this.#snapshot = newSnapshot;
      return;
    }

    const changed = detectRunStateChanges(this.#snapshot, newSnapshot);
    this.#snapshot = newSnapshot;

    if (!this.#boardEventHub || changed.size === 0) return;

    for (const slug of changed) {
      try {
        this.#boardEventHub.broadcast({ slug });
      } catch (err) {
        // Broadcast-Fehler crasht den Watcher nie (best-effort, degradierend).
        console.error('[RunStateWatcher] SSE-Broadcast fehlgeschlagen (best-effort):', err.message);
      }
    }
  }
}
