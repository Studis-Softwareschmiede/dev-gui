/**
 * NotificationWatcher — Board-Übergangserkennung + ntfy-Versand + SSE-Producer (S-184, S-286, AC6–AC9, AC8–AC12).
 *
 * Beobachtet aufeinanderfolgende Board-Scans (via BoardAggregator) und erkennt
 * Statuswechsel je Story. Feuert Notifications via NotifyService nur bei echten
 * Übergängen (AC6). Der erste Scan etabliert die Baseline ohne zu senden (AC7).
 *
 * Snapshot-Persistenz (AC6):
 *   Datei: ${CRED_STORE_DIR}/notification-watcher-snapshot.json
 *   Atomar geschrieben (tmp + rename). Überlebt Neustart der dev-gui.
 *   Format: { stories: { "<storyId>": "<status>" }, features: { "<featureId>": true } }
 *
 * Ereignis-Mapping (AC8):
 *   → Done         ⇒ story_done
 *   → Blocked      ⇒ story_blocked
 *   Feature komplett (alle Kind-Stories Done) ⇒ feature_done
 *
 * Gating (AC8):
 *   Notification wird ONLY gesendet wenn:
 *     - global enabled=true (aus NotificationSettingsStore)
 *     - das konkrete Ereignis in settings.events aktiviert ist
 *
 * Nachrichteninhalt (AC9):
 *   - story_done:    Titel „✅ <project-slug> · <id> fertig"   Body = Story-Titel
 *   - story_blocked: Titel „⛔ <project-slug> · <id> blockiert" Body = Story-Titel
 *   - feature_done:  Titel „✅ <project-slug> · <id> komplett"  Body = Feature-Titel
 *
 * SSE-Producer-Naht (board-live-sse S-286, AC8–AC12):
 *   Der Snapshot-Diff wird zusätzlich zur ntfy-Logik dazu genutzt, die Menge der
 *   Projekt-Slugs mit verändertem Story-Status-Abbild zu bestimmen (AC8). Für jedes
 *   solche Projekt wird genau ein `hub.broadcast({ slug })` aufgerufen (AC8).
 *   - AC9: Baseline-Scan (erster check) löst KEIN SSE-Event aus (AC9).
 *   - AC10: SSE-Invalidierung unabhängig vom ntfy-Gating (auch bei enabled=false).
 *   - AC11: Broadcast läuft auch über denselben Codepfad wie der periodische Check
 *           (auch nach explizitem rescan via POST /api/board/projects/rescan).
 *   - AC12: boardEventHub wird optional injiziert; fehlt er (null/undefined),
 *           degradiert der Watcher still (ntfy-Pfad unverändert, kein Crash).
 *
 * Edge-Cases (Spec §Edge-Cases):
 *   - enabled=false  → Snapshot WEITER AKTUALISIEREN, KEIN ntfy-Versand (aber SSE-Broadcast!)
 *   - Done→To Do→Done → erneuter Übergang feuert erneut (gewollt)
 *   - Mehrere Übergänge im selben Scan → je Übergang eine Notification (kein Verschlucken)
 *   - NotifyService-Fehler crasht den Watcher NICHT (best-effort, AC7)
 *   - Board-Scan-Fehler → kein Snapshot-Update für betroffene Items (AC7)
 *   - Broadcast-Fehler crasht weder check() noch den ntfy-Pfad (best-effort, AC10).
 *
 * Security (AC10 / security/R01):
 *   - Token NIE im Log oder in Output.
 *   - readNotificationSettings() / CredentialStore.getPlaintext() je check().
 *   - Broadcast enthält NUR { slug }, keine Board-Inhalte.
 *
 * @module NotificationWatcher
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sendNotification } from './NotifyService.js';
import { catalogKey } from './CredentialStore.js';

/** Interval between watcher checks in milliseconds (60 s). */
const WATCHER_INTERVAL_MS = 60_000;

/** Status-Werte die als "Done" gelten (muss mit BoardAggregator DONE_STATUSES übereinstimmen). */
const DONE_STATUS = 'Done';
/** Status-Wert der "Blocked" entspricht. */
const BLOCKED_STATUS = 'Blocked';

// ── Snapshot-Persistenz ────────────────────────────────────────────────────────

/**
 * Liest den Pfad zur Snapshot-Datei aus der Umgebung.
 * Pfad: ${CRED_STORE_DIR}/notification-watcher-snapshot.json
 *
 * @returns {string|null}
 */
export function resolveSnapshotFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'notification-watcher-snapshot.json');
}

/**
 * Liest den persistierten Snapshot vom Disk.
 * Gibt `{ snapshot, found }` zurück:
 *   - `found=true`:  Datei existiert und wurde erfolgreich gelesen → Baseline bereits établiert.
 *   - `found=false`: Datei fehlt (ENOENT) oder Parse-Fehler → nächster check() macht Baseline.
 *
 * @param {object} [fsDeps] - Injectable: { readFile }
 * @returns {Promise<{ snapshot: { stories: Record<string,string>, features: Record<string,boolean> }, found: boolean }>}
 */
export async function readSnapshot(fsDeps = { readFile }) {
  const filePath = resolveSnapshotFilePath();
  const empty = { stories: {}, features: {} };
  if (!filePath) return { snapshot: empty, found: false };

  try {
    const raw = await fsDeps.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      snapshot: {
        stories: typeof parsed.stories === 'object' && parsed.stories !== null ? parsed.stories : {},
        features: typeof parsed.features === 'object' && parsed.features !== null ? parsed.features : {},
      },
      found: true,
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Parse-Fehler o.ä. → loggen, Baseline wird erneut etabliert
      console.error('[NotificationWatcher] Snapshot lesen fehlgeschlagen:', err.message);
    }
    return { snapshot: empty, found: false };
  }
}

/**
 * Schreibt den Snapshot atomar auf Disk.
 *
 * @param {{ stories: Record<string,string>, features: Record<string,boolean> }} snapshot
 * @param {object} [fsDeps] - Injectable: { writeFile, rename, mkdir, chmod, unlink }
 * @returns {Promise<void>}
 */
export async function writeSnapshot(snapshot, fsDeps = { writeFile, rename, mkdir, chmod, unlink }) {
  const filePath = resolveSnapshotFilePath();
  if (!filePath) {
    // CRED_STORE_DIR nicht gesetzt → Warnung, kein Crash
    console.warn('[NotificationWatcher] CRED_STORE_DIR nicht gesetzt — Snapshot kann nicht persistiert werden.');
    return;
  }

  const json = JSON.stringify(snapshot, null, 2);
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');

  await fsDeps.mkdir(dirname(filePath), { recursive: true });

  try {
    await fsDeps.writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
    await fsDeps.chmod(tmpPath, 0o600);
    await fsDeps.rename(tmpPath, filePath);
  } catch (err) {
    await fsDeps.unlink(tmpPath).catch(() => {});
    console.error('[NotificationWatcher] Snapshot schreiben fehlgeschlagen:', err.message);
  }
}

// ── Nachrichteninhalt (AC9) ───────────────────────────────────────────────────

/**
 * Baut den Notification-Payload für ein Board-Ereignis.
 *
 * AC9: Nennt Projekt-Slug, Item-ID, Titel und Ereignistyp.
 *   story_done:    „✅ <slug> · <id> fertig"   / Story-Titel
 *   story_blocked: „⛔ <slug> · <id> blockiert" / Story-Titel
 *   feature_done:  „✅ <slug> · <id> komplett"  / Feature-Titel
 *
 * @param {string} eventType  - 'story_done' | 'story_blocked' | 'feature_done'
 * @param {string} slug       - Projekt-Slug
 * @param {string} itemId     - Story-ID oder Feature-ID
 * @param {string|null} title - Story- oder Feature-Titel
 * @returns {{ title: string, message: string, tags: string[] }}
 */
export function buildNotificationPayload(eventType, slug, itemId, title) {
  const itemTitle = title ?? itemId;

  switch (eventType) {
    case 'story_done':
      return {
        title: `✅ ${slug} · ${itemId} fertig`,
        message: itemTitle,
        tags: ['white_check_mark'],
      };
    case 'story_blocked':
      return {
        title: `⛔ ${slug} · ${itemId} blockiert`,
        message: itemTitle,
        tags: ['no_entry'],
      };
    case 'feature_done':
      return {
        title: `✅ ${slug} · ${itemId} komplett`,
        message: itemTitle,
        tags: ['white_check_mark', 'tada'],
      };
    default:
      return {
        title: `${slug} · ${itemId}`,
        message: itemTitle,
        tags: [],
      };
  }
}

// ── Übergangs-Erkennung ────────────────────────────────────────────────────────

/**
 * Erkennt Projekt-Slugs mit verändertem Story-Status-Abbild (für SSE-Invalidierung, AC8).
 *
 * AC8: Je check() bestimmt der Snapshot-Diff zusätzlich die Menge der Projekt-Slugs,
 * deren Story-Status-Abbild sich gegenüber dem vorherigen Snapshot geändert hat —
 * mindestens eine Story mit prev != curr ODER eine hinzugekommene/entfernte Story.
 *
 * @param {Array<import('./BoardAggregator.js').ProjectEntry|import('./BoardAggregator.js').ErrorEntry>} index
 * @param {{ stories: Record<string,string>, features: Record<string,boolean> }} oldSnapshot
 * @returns {Set<string>} — Set der Projekt-Slugs mit verändertem Abbild
 */
export function detectChangedProjects(index, oldSnapshot) {
  const changedSlugs = new Set();

  for (const project of index) {
    // Fehler-Boards nicht processieren
    if (project.error) continue;

    const slug = project.project_slug ?? project.slug;
    if (!slug) continue;

    // Sammle alle Stories für dieses Projekt im aktuellen Index
    const currentStories = new Set();
    for (const feature of project.features ?? []) {
      for (const story of feature.stories ?? []) {
        const storyKey = snapKey(slug, story.id);
        currentStories.add(storyKey);

        // Prüfe ob dieser Story-Status sich geändert hat
        const prevStatus = oldSnapshot.stories[storyKey];
        const currStatus = story.status;

        // Änderung erkannt?
        if (prevStatus !== currStatus) {
          changedSlugs.add(slug);
          break; // Ein Change pro Projekt genügt
        }
      }
      if (changedSlugs.has(slug)) break; // Schnell raus, wenn bereits geändert
    }

    // Falls Projekt im alten Snapshot Stories hatte, aber jetzt nicht mehr → Projekt hat sich geändert
    if (!changedSlugs.has(slug)) {
      for (const oldKey in oldSnapshot.stories) {
        if (oldKey.startsWith(`${slug}::`)) {
          if (!currentStories.has(oldKey)) {
            // Story wurde entfernt
            changedSlugs.add(slug);
            break;
          }
        }
      }
    }
  }

  return changedSlugs;
}

/**
 * Erkennt Übergänge zwischen dem alten Snapshot und dem aktuellen Board-Index.
 * Gibt eine Liste von Ereignissen zurück (noch KEIN Versand; kein Gating hier).
 *
 * Feature-"done" wird erkannt wenn ALLE direkten Kind-Stories Done sind UND
 * die Feature-ID noch nicht als done im Snapshot markiert war.
 *
 * @param {Array<import('./BoardAggregator.js').ProjectEntry|import('./BoardAggregator.js').ErrorEntry>} index
 * @param {{ stories: Record<string,string>, features: Record<string,boolean> }} oldSnapshot
 * @returns {{
 *   events: Array<{ eventType: string, slug: string, id: string, title: string|null }>,
 *   newSnapshot: { stories: Record<string,string>, features: Record<string,boolean> }
 * }}
 */
/**
 * Snapshot-Schlüssel mit Projekt-Namespace. Verhindert ID-Kollisionen, wenn mehrere
 * Projekte dieselbe Feature-/Story-ID tragen (z.B. dev-gui F-001 vs. agent-flow F-001) —
 * sonst kippt der Eintrag bei jedem Scan hin und her und feuert das Ereignis im
 * Watcher-Takt (jede Minute) erneut.
 *
 * @param {string} slug
 * @param {string} id
 * @returns {string}
 */
function snapKey(slug, id) {
  return `${slug ?? '?'}::${id}`;
}

export function detectTransitions(index, oldSnapshot) {
  const events = [];
  const newStories = { ...oldSnapshot.stories };
  const newFeatures = { ...oldSnapshot.features };

  for (const project of index) {
    // Fehler-Boards überspringen (kein Snapshot-Update für betroffene Items)
    if (project.error) continue;

    const slug = project.project_slug ?? project.slug;

    for (const feature of project.features ?? []) {
      // Verwaiste Stories (_orphaned pseudo-feature) überspringen bei Feature-done-Check
      const isOrphaned = feature._orphaned === true;

      for (const story of feature.stories ?? []) {
        const storyKey = snapKey(slug, story.id);
        const prevStatus = oldSnapshot.stories[storyKey];
        const currStatus = story.status;

        // Snapshot immer aktualisieren (auch bei enabled=false)
        newStories[storyKey] = currStatus ?? null;

        if (currStatus === DONE_STATUS && prevStatus !== DONE_STATUS && prevStatus !== undefined) {
          // → Done (echter Übergang, nicht Erststart)
          events.push({ eventType: 'story_done', slug, id: story.id, title: story.title });
        } else if (currStatus === BLOCKED_STATUS && prevStatus !== BLOCKED_STATUS && prevStatus !== undefined) {
          // → Blocked (echter Übergang, nicht Erststart)
          events.push({ eventType: 'story_blocked', slug, id: story.id, title: story.title });
        }
      }

      // Feature-done: nur für echte Features (nicht verwaiste), nur wenn alle Kinder Done
      if (!isOrphaned && feature.id) {
        const stories = feature.stories ?? [];
        if (stories.length > 0) {
          const allDone = stories.every((s) => s.status === DONE_STATUS);
          // Prüfe ob Feature-ID bereits im Snapshot bekannt ist (undefined = Erststart, kein Event)
          const featureKey = snapKey(slug, feature.id);
          const prevFeatureEntry = Object.prototype.hasOwnProperty.call(oldSnapshot.features, featureKey)
            ? oldSnapshot.features[featureKey]
            : undefined;

          // Snapshot immer aktualisieren
          newFeatures[featureKey] = allDone;

          if (allDone && prevFeatureEntry !== undefined && prevFeatureEntry !== true) {
            // Feature ist jetzt komplett, war vorher bekannt und noch NICHT komplett
            events.push({ eventType: 'feature_done', slug, id: feature.id, title: feature.title });
          }
        }
      }
    }
  }

  return { events, newSnapshot: { stories: newStories, features: newFeatures } };
}

/**
 * Erstellt den Baseline-Snapshot (alle aktuellen Status ohne Übergänge).
 * Wird beim ersten Scan aufgerufen — KEIN Versand.
 *
 * @param {Array<import('./BoardAggregator.js').ProjectEntry|import('./BoardAggregator.js').ErrorEntry>} index
 * @returns {{ stories: Record<string,string>, features: Record<string,boolean> }}
 */
export function buildBaseline(index) {
  const stories = {};
  const features = {};

  for (const project of index) {
    if (project.error) continue;

    const slug = project.project_slug ?? project.slug;

    for (const feature of project.features ?? []) {
      const isOrphaned = feature._orphaned === true;

      for (const story of feature.stories ?? []) {
        stories[snapKey(slug, story.id)] = story.status ?? null;
      }

      if (!isOrphaned && feature.id) {
        const fStories = feature.stories ?? [];
        features[snapKey(slug, feature.id)] = fStories.length > 0 && fStories.every((s) => s.status === DONE_STATUS);
      }
    }
  }

  return { stories, features };
}

// ── NotificationWatcher ───────────────────────────────────────────────────────

/**
 * NotificationWatcher — Board-Beobachter mit Übergangs-Erkennung + Versand + SSE-Producer.
 *
 * @param {object} deps
 * @param {import('./BoardAggregator.js').BoardAggregator} deps.boardAggregator
 * @param {import('./CredentialStore.js').CredentialStore} deps.credentialStore
 * @param {() => Promise<import('./NotificationSettingsStore.js').NotificationSettings>} deps.readNotificationSettings
 * @param {typeof sendNotification} [deps.sendNotificationFn] - Injectable für Tests
 * @param {object} [deps.fsDeps] - Injectable: { readFile, writeFile, rename, mkdir, chmod, unlink }
 * @param {number} [deps.intervalMs] - Check-Intervall in ms (default: 60 000)
 * @param {import('./BoardEventHub.js').BoardEventHub|null} [deps.boardEventHub] - Optional SSE-Producer (AC12); null-tolerant
 */
export class NotificationWatcher {
  #boardAggregator;
  #credentialStore;
  #readNotificationSettings;
  #sendNotificationFn;
  #fsDeps;
  #intervalMs;
  #boardEventHub;
  #intervalHandle = null;
  /**
   * Gibt an ob ein Snapshot von Disk geladen wurde (true = Baseline bereits établiert).
   * null = noch nicht initialisiert; false = kein Disk-Snapshot (nächster check() macht Baseline).
   */
  #baselineEstablished = null;
  /** In-memory Snapshot (letzter bekannter Zustand). */
  #snapshot = null;

  constructor({
    boardAggregator,
    credentialStore,
    readNotificationSettings,
    sendNotificationFn,
    fsDeps,
    intervalMs,
    boardEventHub,
  }) {
    this.#boardAggregator = boardAggregator;
    this.#credentialStore = credentialStore;
    this.#readNotificationSettings = readNotificationSettings;
    this.#sendNotificationFn = sendNotificationFn ?? sendNotification;
    this.#fsDeps = fsDeps ?? { readFile, writeFile, rename, mkdir, chmod, unlink };
    this.#intervalMs = intervalMs ?? WATCHER_INTERVAL_MS;
    this.#boardEventHub = boardEventHub; // AC12: optional, null-tolerant
  }

  /**
   * Startet den periodischen Watcher.
   * Der erste Check nach Start etabliert die Baseline (AC7).
   * Idempotent: mehrfache Aufrufe stoppen den vorherigen Timer.
   */
  start() {
    this.stop();
    // Erster Check sofort (Baseline)
    this.check().catch(() => {}); // best-effort: kein Crash
    this.#intervalHandle = setInterval(() => {
      this.check().catch(() => {}); // best-effort: kein Crash
    }, this.#intervalMs);
    // Unref: verhindert nicht Server-Shutdown
    if (this.#intervalHandle.unref) this.#intervalHandle.unref();
  }

  /**
   * Stoppt den periodischen Watcher.
   */
  stop() {
    if (this.#intervalHandle !== null) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
  }

  /**
   * Führt einen einmaligen Watcher-Check durch.
   * Kann auch manuell aufgerufen werden (z.B. nach einem expliziten rescan).
   *
   * - Erster Aufruf (kein Snapshot auf Disk): Baseline erstellen, KEIN Versand + KEIN SSE-Broadcast (AC7/AC9).
   * - Folgeaufrufe: Übergänge erkennen, Snapshot aktualisieren, Notifications senden (AC6/AC8/AC9).
   * - SSE-Invalidierung: nach Baseline unabhängig vom ntfy-Gating (AC10/AC12).
   * - enabled=false: Snapshot wird aktualisiert, ntfy NICHT versendet, aber SSE wird gebroadcasted (AC10).
   *
   * @returns {Promise<void>}
   */
  async check() {
    let index;
    try {
      index = await this.#boardAggregator.getIndex();
    } catch (err) {
      // Board-Scan-Fehler → kein Update, kein Versand (AC7 / Spec §Edge-Cases)
      console.error('[NotificationWatcher] Board-Scan fehlgeschlagen (kein Snapshot-Update):', err.message);
      return;
    }

    // Snapshot von Disk laden (nur beim allerersten check() nach Instanziierung)
    if (this.#baselineEstablished === null) {
      const { snapshot: diskSnapshot, found } = await readSnapshot(this.#fsDeps);
      this.#snapshot = diskSnapshot;
      // found=true  → Baseline existiert bereits (von einem früheren Lauf)
      // found=false → Erste Aktivierung / kein Snapshot-File → Baseline muss noch etabliert werden
      this.#baselineEstablished = found;
    }

    if (!this.#baselineEstablished) {
      // AC9: Erster Scan (kein Snapshot auf Disk) → Baseline ohne Versand und OHNE SSE-Broadcast
      const baseline = buildBaseline(index);
      this.#snapshot = baseline;
      this.#baselineEstablished = true;
      await writeSnapshot(baseline, this.#fsDeps);
      return; // KEIN SSE-Event auf Baseline
    }

    // Übergänge erkennen (ntfy-relevante Ereignisse)
    const { events, newSnapshot } = detectTransitions(index, this.#snapshot);

    // AC8: Projekte mit verändertem Story-Status-Abbild erkennen (für SSE-Producer)
    const changedProjects = detectChangedProjects(index, this.#snapshot);

    // Snapshot immer persistieren (auch bei enabled=false — Edge-Case Spec)
    this.#snapshot = newSnapshot;
    await writeSnapshot(newSnapshot, this.#fsDeps);

    // ── AC10/AC12: SSE-Invalidierung (unabhängig vom ntfy-Gating, best-effort) ──────
    // Der SSE-Broadcast-Pfad ist vollständig entkoppelt vom ntfy-Pfad.
    if (this.#boardEventHub && changedProjects.size > 0) {
      for (const slug of changedProjects) {
        try {
          this.#boardEventHub.broadcast({ slug });
        } catch (err) {
          // AC10: Broadcast-Fehler crasht weder check() noch den ntfy-Pfad
          console.error('[NotificationWatcher] SSE-Broadcast fehlgeschlagen (best-effort):', err.message);
        }
      }
    }

    // ── ntfy-Pfad (unverändert) ──────────────────────────────────────────────────────
    // Wenn keine Übergänge → nichts weiter zu tun
    if (events.length === 0) return;

    // Settings lesen (für Gating AC8)
    let settings;
    try {
      settings = await this.#readNotificationSettings();
    } catch (err) {
      console.error('[NotificationWatcher] Settings lesen fehlgeschlagen:', err.message);
      return; // Gating fehlgeschlagen → kein Versand
    }

    // AC8: enabled=false → Snapshot ist bereits aktuell, aber kein ntfy-Versand
    // (SSE wurde aber bereits oben gebroadcasted — AC10)
    if (!settings.enabled) return;

    // Token aus CredentialStore (NIE im Log)
    let token = null;
    try {
      if (this.#credentialStore) {
        token = await this.#credentialStore.getPlaintext(catalogKey('notifications', 'ntfy_token'));
      }
    } catch (err) {
      // Token-Lese-Fehler → kein Hard-Stop, Versand ohne Token
      console.error('[NotificationWatcher] Token-Lesen fehlgeschlagen:', err.message);
    }

    // Je Übergang eine Notification senden (kein Verschlucken — Spec §Edge-Cases)
    for (const event of events) {
      // AC8: Gating — nur wenn Ereignis in settings.events aktiviert
      if (!Array.isArray(settings.events) || !settings.events.includes(event.eventType)) {
        continue;
      }

      // AC9: Nachrichteninhalt
      const payload = buildNotificationPayload(event.eventType, event.slug, event.id, event.title);

      // Versand (best-effort — Fehler darf Watcher/Scan NICHT crashen)
      try {
        await this.#sendNotificationFn(
          {
            server: settings.server,
            topic: settings.topic,
            priority: settings.priority,
            token, // AC10: Token NIE im Log
          },
          payload,
        );
      } catch (err) {
        // best-effort: strukturiert loggen, weiter (AC7 / Spec §Verhalten 7)
        console.error('[NotificationWatcher] Versand fehlgeschlagen (best-effort):', err.message);
      }
    }
  }
}
