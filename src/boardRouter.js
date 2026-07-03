/**
 * boardRouter — board API routes (read-only, AC1-3, AC5, AC7-9 studis-kanban-board-ux;
 *               AC1-AC2, AC5 story-detail-ansicht)
 *
 * Exposes the in-memory Board-Aggregat as read-only JSON.
 *
 * Routes:
 *   GET /api/board/projects                          → { projects: [...] }  (full aggregat, legacy)
 *   GET /api/board/projects/list                     → { projects: [{slug,feature_count,story_count}] }
 *                                                      (leicht, KEIN Story-Scan — AC5)
 *   GET /api/board/projects/:slug                    → { project: {...} }  (ein Projekt voll, on-demand — AC5)
 *   GET /api/board/projects/:slug/areas              → { areas: [...] }  (Bereichsliste, read-only,
 *                                                      bereichs-modell AC1/AC2/V6, S-288)
 *   POST /api/board/projects/rescan                  → { ok: true }  (on-demand re-scan, AC9)
 *   GET /api/board/projects/:slug/stories/:id/detail → { detail: StoryDetail }  (read-only, lazy — AC2)
 *   POST /api/board/projects/:slug/ideas             → { storyId }  (Quick-Capture-Create, ideen-inbox AC3)
 *   POST /api/board/projects/:slug/ideas/:id/discuss → { sessionId }  (Besprechungs-Start, ideen-inbox AC5, S-200)
 *   POST /api/board/projects/:slug/ideas/:id/resolve → { storyId }  (explizite Auflösung, ideen-inbox AC6, S-200)
 *   POST /api/board/projects/:slug/archive-done      → { archivedFeatureCount, archivedStoryCount }
 *                                                      (erledigte Features archivieren, board-feature-archive AC4, S-232)
 *
 * AC5 (story-detail-ansicht — Vorab-Schätzungs-Fallback):
 *   Wenn items.jsonl für die Story kein ep_est/tok_est liefert, fällt die Soll-Ist-Ansicht
 *   für die Schätzung auf dispo_est (und tok_est_yaml falls im Story-YAML vorhanden) zurück.
 *   Die Herkunft wird als ep_est_source: 'yaml'|'ledger'|null im Detail-Objekt übermittelt.
 *   Ist/Abweichungs-Felder bleiben null, bis ein Flow-Lauf echte Werte schreibt.
 *
 * story-detail-yaml-fallback (AC3, AC4):
 *   AC3 — ended_at-Fallback: liefert Ledger kein ended_at, aber YAML ein done_at →
 *          ended_at = done_at, ended_at_source: 'yaml'. Sonst 'ledger'. Ohne beides: null.
 *          started_at/duration bleiben null ohne Ledger (nicht aus YAML ableitbar).
 *   AC4 — Neue Felder branch, pr, status aus dem Story-Index werden durchgereicht.
 *
 * ideen-inbox (AC3, AC4, AC7, AC8 — Quick-Capture):
 *   AC3 — POST /api/board/projects/:slug/ideas { title, body? } → 201 { storyId } legt
 *          über `BoardWriter.createIdea()` (Create-Pfad, S-199) ein Item mit
 *          `status: Idee` an — OHNE spec, OHNE implements. Token-frei (kein Agent).
 *          400 { field, message } bei leerem/zu langem Titel/Body. 404 bei unbekanntem
 *          Projekt-Slug (Format ODER nicht unter BOARD_ROOTS gefunden).
 *   AC7 — GENAU EIN Audit-Eintrag je Anlage — Audit-First (nach Validierung, VOR dem
 *          eigentlichen `createIdea()`-Aufruf), analog `assistRefineRouter` — eine
 *          400-Validierungsablehnung wird NIE auditiert (keine versuchte Aktion).
 *   AC8 — Einziger Schreibpfad ist `BoardWriter` (atomar, tmp+rename, Pfad-/Slug-
 *          Sicherheit siehe BoardWriter.js-Moduldoku); dieser Router selbst schreibt
 *          nichts. `BoardAggregator` bleibt unverändert read-only.
 *
 * ideen-inbox (AC5, AC6, AC7, AC8 — Besprechung + Auflösung, S-200):
 *   AC5 — POST .../ideas/:id/discuss → 200 { sessionId } startet/nutzt die interaktive
 *          PTY-Session des Projekts (`sessionRegistry.getOrCreate()`, DIESELBE Engine
 *          wie das „Arbeiten"-Terminal) und schreibt die Stichworte der Idee (Titel +
 *          Body/notes) als KONVERSATIONELLEN Gesprächs-Einstieg direkt in die Session
 *          (`pty.write()` — der GLEICHE Pfad wie freies Terminal-Tippen über
 *          `WsGateway#handleMessage`, NICHT `CommandService.tryRun()`/die Slash-
 *          Allowlist, KEIN `claude -p`). Der Seed wird sanitisiert (alle Steuerzeichen
 *          inkl. Zeilenumbrüche zu Leerzeichen kollabiert → GENAU EIN Submit-`\n` am
 *          Ende, siehe `buildDiscussSeed()`) — „keine zweite Submit-Zeile" (AC8).
 *          Ändert den Status der Idee NICHT (bleibt `Idee`). 400 { field: 'status' }
 *          wenn die Idee nicht (mehr) besprechbar ist (bereits aufgelöst/kein `Idee`-Item
 *          mehr). 404 bei unbekanntem Slug/Idee. 409 wenn bereits ein Command läuft
 *          (`commandService.getStatus().status === 'running'`, [[flow-trigger]] AC3 —
 *          globaler Lock, spiegelt `POST /api/command`s eigene 409-Semantik) ODER
 *          wenn das projektweite `ProjectJobLock` (`lock.tryAcquire(repoPath)`, Default:
 *          Singleton `projectJobLock`, geteilt mit `ProjectDrain`) bereits gehalten wird —
 *          schließt die Naht zum Taktgeber (der zwischen zwei `/flow`-Runden den globalen
 *          CommandService-Lock freigibt, aber sein `ProjectJobLock` für die gesamte
 *          Drain-Session hält) und schützt symmetrisch gegen zwei gleichzeitige discuss-
 *          Aufrufe fürs selbe Projekt. Das Lock wird nur kurz (Check+PTY-Write) gehalten,
 *          nicht für die Dauer des Gesprächs (coder-Lesson 2026-07-01).
 *   AC6 — POST .../ideas/:id/resolve { resolved_story_ids?, resolved_note? } → 200
 *          { storyId } setzt über `BoardWriter.resolveIdea()` (Resolve-Pfad, S-200) das
 *          Idee-Item auf `status: Done` + `resolved_at` (+ optional resolved_story_ids/
 *          resolved_note) — KEIN Agent-Dispatch. 400 { field } bei ungültigem Payload
 *          ODER bereits aufgelöstem/nicht-`Idee`-Item (`field: 'status'`). 404 bei
 *          unbekanntem Slug/Idee.
 *   AC7 — GENAU EIN Audit-Eintrag je discuss-Start bzw. je resolve — Audit-First
 *          (nach Validierung/Busy-Check, VOR der eigentlichen Aktion), analog AC3 oben.
 *   AC8 — `resolveIdea()` schreibt weiterhin ausschließlich über `BoardWriter` (atomar).
 *          Der Gesprächs-Seed (AC5) ist freier Text in die bestehende PTY — kein neuer
 *          Board-Schreibpfad, keine Slash-Allowlist-Umgehung.
 *
 * board-feature-archive (AC4, AC8 — erledigte Features archivieren, S-232):
 *   AC4 — POST /api/board/projects/:slug/archive-done archiviert alle aktuell
 *          archivierbaren Features (V1) über `BoardWriter.archiveDoneFeatures()`
 *          (einziger Schreibpfad). Reihenfolge: Slug-Format-Prüfung (404) →
 *          Projekt-Auflösung gegen den In-Memory-Index (404 wenn nicht unter
 *          BOARD_ROOTS) → `ProjectJobLock.tryAcquire(repoPath)` (409 wenn belegt —
 *          Taktgeber/Drain/andere Board-Schreibaktion) → Audit-First (GENAU EIN
 *          Eintrag, nach Slug-/Busy-Prüfung, VOR dem Schreiben) → archiveDoneFeatures()
 *          → 200 { archivedFeatureCount, archivedStoryCount } (0/0 ohne Fehler, wenn
 *          nichts archivierbar). Das Lock wird nur kurz (Check+Schreiben) gehalten und
 *          im finally wieder freigegeben (analog .../discuss).
 *   AC8 — Einziger Schreibpfad bleibt `BoardWriter` (atomar, Pfad-/Slug-Sicherheit
 *          per BOARD_ROOTS-Realpath-Schranke in BoardWriter.js); der Router selbst
 *          schreibt nichts. Slug wird gegen SLUG_RE geprüft und nur als Index-Lookup
 *          verwendet (nie als Pfad). Kein Secret in Ausgabe/Log; ungültige Eingaben
 *          werden sauber abgewiesen (kein Crash).
 *
 * bereichs-modell (S-288, Lese-Teil — AC1, AC2, GET-Vertrag aus V6):
 *   GET /api/board/projects/:slug/areas → 200 { areas: [{ id, name, order,
 *   description, storyCount }] } sortiert nach `order` (Sortierung + Roll-up
 *   kommen bereits so aus `BoardAggregator.getIndex()` — der Router liest nur
 *   read-only aus dem In-Memory-Index, kein zusätzlicher Scan/Schreibpfad). 404
 *   bei ungültigem Format ODER unbekanntem Slug (dieselbe SLUG_RE + Index-Lookup-
 *   Prüfung wie GET /api/board/projects/:slug). Rein lesend — kein accessGuard-
 *   mutierender Pfad nötig (wie alle übrigen GET-Board-Routen). `AreaWriter`/
 *   mutierende Endpunkte (POST/PATCH/DELETE/reorder) sind NICHT Teil dieser
 *   Story (Folge-Stories, [[bereichs-modell]] V3-V6).
 *
 * Security:
 *   - Read-only für alle GET-Routen (AC7 studis-kanban-board-ux).
 *   - :slug and :id parameters validated against regex before use as index lookup.
 *     slug is compared to in-memory index only (never used as filesystem path).
 *     id is compared as value only (never used as filesystem path — no traversal).
 *   - POST .../ideas: title/body werden ausschließlich über `BoardWriter.createIdea()`
 *     validiert/sanitisiert (Steuerzeichen-Schutz, Längenlimits) — kein Roh-Schreiben
 *     im Router; projectSlug läuft durch dieselbe BOARD_ROOTS-Realpath-Schranke wie
 *     `setBlocked` (siehe BoardWriter.js).
 *   - POST .../discuss: der Gesprächs-Seed wird VOR dem PTY-Write sanitisiert
 *     (`buildDiscussSeed()` kollabiert alle Steuerzeichen — kein Zeilenumbruch,
 *     keine zweite Submit-Zeile). Schreibt NICHT über `CommandService.tryRun()`/
 *     die Slash-Allowlist — reiner PTY-Freitext-Pfad, identisch zum Terminal-Tippen.
 *   - POST .../resolve: resolved_story_ids/resolved_note werden ausschließlich über
 *     `BoardWriter.validateResolveInput()`/`resolveIdea()` validiert/sanitisiert;
 *     kein Roh-Schreiben im Router.
 *   - POST .../archive-done: kein Request-Body; einziger Schreibpfad ist
 *     `BoardWriter.archiveDoneFeatures()` (atomar, BOARD_ROOTS-Realpath-Schranke).
 *     projectSlug läuft durch dieselbe SLUG_RE-Prüfung + In-Memory-Index-Auflösung
 *     wie die übrigen Routen (nie als Pfad). Kurzzeitiges ProjectJobLock (409).
 *   - Behind existing /api AccessGuard via server.js registration.
 *   - No secrets in output; no new authentication surface.
 *
 * @module boardRouter
 */

import { Router } from 'express';
import { BoardWriterError, validateIdeaInput, validateResolveInput } from './BoardWriter.js';
import { projectJobLock } from './ProjectJobLock.js';

/** Valid slug characters: alphanumeric, dash, underscore, dot. No leading slash. */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Valid story ID characters: alphanumeric, dash, underscore, dot.
 * Must start with alphanumeric. No path traversal possible.
 */
const STORY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Baut den konversationellen Gesprächs-Einstieg für die Besprechungs-Session
 * (ideen-inbox AC5/AC8, S-200) aus Titel + optionalem Body einer Idee.
 *
 * Kollabiert JEDES Steuerzeichen (inkl. `\n`/`\r`, C0, DEL, U+2028/U+2029) im
 * Titel/Body zu einem einzelnen Leerzeichen, BEVOR der Text in die interaktive
 * PTY geschrieben wird — ein mehrzeiliger Stichwort-Body (z.B. aus dem
 * Quick-Capture-Modal) würde sonst als mehrere Enter-Tastendrücke interpretiert
 * (jede PTY-Zeile = ein Submit) und die Nachricht vorzeitig/fragmentiert
 * abschicken. Der Aufrufer hängt GENAU EIN abschließendes `\n` an das
 * Rückgabe-Ergebnis an — „keine zweite Submit-Zeile" (AC8).
 *
 * Bewusst FREIER Gesprächstext (kein Slash-Befehl, keine Allowlist-Prüfung) —
 * geschrieben über denselben Pfad wie freies Terminal-Tippen (`pty.write()`,
 * analog `WsGateway#handleMessage`), NICHT über `CommandService.tryRun()`.
 *
 * @param {{ title: unknown, body?: unknown }} idea
 * @returns {string}
 */
export function buildDiscussSeed({ title, body }) {
  // eslint-disable-next-line no-control-regex
  const flatten = (s) => String(s).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const flatTitle = flatten(title ?? '');
  const parts = [`Lass uns die folgende Idee gemeinsam zu einer Anforderung schärfen: "${flatTitle}".`];
  if (body != null) {
    const flatBody = flatten(body);
    if (flatBody) parts.push(`Stichworte: ${flatBody}`);
  }
  return parts.join(' ');
}

/**
 * Findet einen Story-Eintrag (Idee ODER jede andere Story) im Board-Index
 * anhand ihrer ID — durchsucht alle Features EINSCHLIESSLICH der
 * `_orphaned`-Pseudo-Feature (Idee-Items haben typischerweise kein `parent`
 * und landen dort, siehe `BoardAggregator.js`).
 *
 * @param {object} project  Ein Eintrag aus `boardAggregator.getIndex()`.
 * @param {string} id
 * @returns {object|undefined}
 */
function _findStoryInProject(project, id) {
  return (project.features ?? [])
    .flatMap((f) => f.stories ?? [])
    .find((s) => String(s.id ?? '') === String(id));
}

/**
 * Extrahiert identity-String aus req.identity (AccessGuard-Claim) — analog
 * `assistRefineRouter`/`githubRepoCloneRouter`.
 * @param {object|null} identity
 * @returns {string|null}
 */
function _resolveIdentity(identity) {
  return identity?.email ?? null;
}

/**
 * Create the board router.
 *
 * @param {object} options
 * @param {import('./BoardAggregator.js').BoardAggregator} options.boardAggregator
 * @param {import('./StoryMetricReader.js').StoryMetricReader} options.storyMetricReader
 * @param {import('./NotificationWatcher.js').NotificationWatcher} [options.notificationWatcher]
 * @param {import('./BoardWriter.js').BoardWriter} [options.boardWriter]  Create-/Resolve-Pfad
 *   (ideen-inbox AC3/AC6).
 * @param {import('./AuditStore.js').AuditStore} [options.auditStore]  Audit je Anlage/Besprechung/
 *   Auflösung (ideen-inbox AC7).
 * @param {{ tryRun: Function, getStatus: () => { status: string|null } }} [options.commandService]
 *   Busy-Erkennung (`getStatus().status === 'running'`) für den Besprechungs-Start
 *   (ideen-inbox AC5, S-200 — [[flow-trigger]] AC3-Semantik).
 * @param {{ getOrCreate: (p: string|null) => object|null }} [options.sessionRegistry]
 *   Multi-Session-PTY-Registry — liefert/erzeugt die Projekt-Session für den
 *   Gesprächs-Seed (ideen-inbox AC5, S-200 — dieselbe Engine wie das Terminal).
 * @param {import('./ProjectJobLock.js').ProjectJobLock} [options.lock]  default: Singleton
 *   `projectJobLock` (S-190/S-192). Wird für den Besprechungs-Start (AC5) kurz
 *   (Check+PTY-Write) um `repoPath` gehalten — schließt die Naht zum Taktgeber/
 *   `ProjectDrain` (der dasselbe Lock für die GESAMTE Drain-Session hält, aber
 *   den globalen `CommandService`-Lock zwischen zwei `/flow`-Runden freigibt),
 *   siehe coder-Lesson 2026-07-01.
 * @returns {import('express').Router}
 */
export function boardRouter({
  boardAggregator,
  storyMetricReader,
  notificationWatcher,
  boardWriter,
  auditStore,
  commandService,
  sessionRegistry,
  lock = projectJobLock,
}) {
  const router = Router();

  /**
   * GET /api/board/projects
   *
   * Returns the current aggregated board index as JSON (full — all projects, all stories).
   * Triggers a scan on first call if the index is not yet populated.
   * Error entries (invalid boards) are included with an `error` field
   * and an empty `features` array (AC8).
   *
   * Response shape:
   * {
   *   projects: [
   *     {
   *       slug, repo_path, project_slug, schema_version,
   *       features: [
   *         { id, title, status, priority, progress,
   *           stories: [{ id, parent, title, status, priority, labels, spec, dispo_est, dispo_act }]
   *         }
   *       ]
   *     },
   *     { slug, repo_path, error, features: [] }   // error board
   *   ]
   * }
   */
  router.get('/api/board/projects', async (req, res) => {
    // board-feature-archive AC3/AC6 (V3): explizites `includeArchived`-Query-
    // Signal liefert archivierte Features/Stories zusätzlich (Default aus =
    // Standardansicht). Frontend „Archiv anzeigen"-Schalter (S-234) sendet
    // `?includeArchived=true`.
    const includeArchived = req.query.includeArchived === 'true';
    const projects = await boardAggregator.getIndex({ includeArchived });
    return res.json({ projects });
  });

  /**
   * GET /api/board/projects/list
   *
   * Lightweight project list — returns only slug + coarse counters per repo.
   * Does NOT trigger a full story-YAML scan; uses the already-built in-memory index
   * (which is populated by scan() on first access — that scan does read stories,
   * but list only returns the summary, making subsequent list calls cheap).
   *
   * Response shape:
   * {
   *   projects: [
   *     { slug, feature_count, story_count }  // healthy project
   *     { slug, error }                        // error project
   *   ]
   * }
   *
   * AC5 (studis-kanban-board-ux): getIndex() populates from board.yaml + files,
   * but list strips stories — only slug + counters reach the client.
   */
  router.get('/api/board/projects/list', async (_req, res) => {
    const projects = await boardAggregator.getIndex();
    const list = projects.map((p) => {
      if (p.error) {
        return { slug: p.slug, error: p.error };
      }
      const features = p.features ?? [];
      const feature_count = features.length;
      const story_count = features.reduce((acc, f) => acc + (f.stories ?? []).length, 0);
      return { slug: p.slug, feature_count, story_count };
    });
    return res.json({ projects: list });
  });

  /**
   * GET /api/board/projects/:slug
   *
   * Returns a single project (full data) by slug (on-demand, AC5).
   * The slug is validated and matched against the in-memory index — never used as a
   * filesystem path (security: no path traversal possible).
   *
   * Response: { project: { slug, repo_path, project_slug, schema_version, features: [...] } }
   * 404 if slug unknown or invalid.
   *
   * board-feature-archive AC3/AC6 (V3): mit `?includeArchived=true` werden
   * archivierte Features/Stories des Projekts zusätzlich, als `archived` markiert,
   * geliefert (Default aus = Standardansicht ohne Archivierte). Das Frontend
   * „Archiv anzeigen"-Schalter (S-234) nutzt dieses Signal read-only.
   */
  router.get('/api/board/projects/:slug', async (req, res) => {
    const { slug } = req.params;

    // Validate slug format — reject obviously invalid inputs early
    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const includeArchived = req.query.includeArchived === 'true';
    const projects = await boardAggregator.getIndex({ includeArchived });
    const project = projects.find((p) => p.slug === slug);

    if (!project) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    return res.json({ project });
  });

  /**
   * GET /api/board/projects/:slug/areas
   *
   * Returns the project's area list (bereichs-modell AC1/AC2, GET-Vertrag V6,
   * S-288) — read-only, from the already-scanned in-memory index (no extra
   * scan triggered). Sorted by `order` (BoardAggregator already sorts).
   *
   * Response: { areas: [{ id, name, order, description, storyCount }] }.
   * 404 if slug format is invalid or the project is unknown (same SLUG_RE +
   * index-lookup validation as GET /api/board/projects/:slug — slug is never
   * used as a filesystem path).
   */
  router.get('/api/board/projects/:slug/areas', async (req, res) => {
    const { slug } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);

    if (!project) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const areas = (project.areas ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      order: a.order,
      description: a.description,
      storyCount: a.storyCount,
    }));

    return res.json({ areas });
  });

  /**
   * POST /api/board/projects/rescan
   *
   * Triggers an on-demand re-scan of all configured board roots (AC9).
   * The new index is immediately available for the next GET request.
   *
   * Also triggers a NotificationWatcher check (S-184 AC6–AC9) after the scan,
   * so manual rescans immediately pick up status transitions.
   *
   * This route does NOT write to any board/ file (AC7 read-only guarantee).
   *
   * Response: { ok: true }
   */
  router.post('/api/board/projects/rescan', async (_req, res) => {
    await boardAggregator.scan();
    // S-184 AC6: Nach explizitem Rescan Watcher-Check auslösen (best-effort, kein Crash)
    if (notificationWatcher) {
      notificationWatcher.check().catch((err) => {
        console.error('[boardRouter] NotificationWatcher.check() fehlgeschlagen:', err.message);
      });
    }
    return res.json({ ok: true });
  });

  /**
   * GET /api/board/projects/:slug/stories/:id/detail
   *
   * Returns story detail metrics (AC2 story-detail-ansicht): Start/Ende/Dauer,
   * Agenten-Flow (seq-geordnet), Soll-Ist (ep_est/ep_act/tok/size_est + Abweichungen).
   *
   * Read-only, lazy (no scan triggered — StoryMetricReader reads on-demand).
   * Behind existing /api AccessGuard.
   *
   * Security:
   *   - :slug validated against SLUG_RE; matched against in-memory index (never used as path).
   *   - :id validated against STORY_ID_RE; used ONLY as a value to compare (never as path).
   *   - No path traversal possible: repo_path comes from trusted Board-Index.
   *
   * Response: { detail: StoryDetail }
   * 404 if slug unknown/invalid or id format invalid.
   * 200 with all-null fields if metrics files are missing (AC1 — no crash).
   */
  router.get('/api/board/projects/:slug/stories/:id/detail', async (req, res) => {
    const { slug, id } = req.params;

    // Validate slug format
    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    // Validate story id format (no traversal — pure value comparison downstream)
    if (!id || !STORY_ID_RE.test(id)) {
      return res.status(404).json({ error: 'Story nicht gefunden.' });
    }

    // Resolve repo_path from trusted in-memory index (slug never used as filesystem path)
    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);

    if (!project || project.error) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const repoPath = project.repo_path;

    // Read metrics (lazy, read-only); missing files → null fields, no crash (AC1)
    const detail = await storyMetricReader.getDetail(repoPath, id);

    // Suche den Story-Eintrag aus dem Index für YAML-Fallback-Felder
    const storyEntry = (project.features ?? [])
      .flatMap((f) => f.stories ?? [])
      .find((s) => String(s.id ?? '') === String(id));

    // AC5 (story-detail-ansicht) — Vorab-Schätzungs-Fallback:
    // Wenn der Ledger kein ep_est/tok_est liefert, fällt die Ansicht auf dispo_est
    // (und ein Token-Schätzfeld, falls im Story-YAML vorhanden) aus der Story-YAML zurück.
    // Ist-/Abweichungs-Felder bleiben null bis zum Flow-Lauf.
    // Herkunft: ep_est_source 'ledger'|'yaml'|null (null = keine Schätzung vorhanden).
    let ep_est_source = null;
    let ep_est = detail.ep_est;
    let tok_est = detail.tok_est;

    if (ep_est != null) {
      // Ledger hat einen Wert — Ledger hat Vorrang
      ep_est_source = 'ledger';
    } else {
      // Ledger hat kein ep_est — YAML-Fallback: dispo_est aus Story-Index
      const yamlEpEst = storyEntry?.dispo_est ?? null;
      if (yamlEpEst != null) {
        ep_est = yamlEpEst;
        ep_est_source = 'yaml';
        // Ist-/Abweichungs-Felder bleiben null (kein ep_act aus dem Ledger vorhanden)
      }
      // tok_est: YAML-Fallback nur wenn dort ein Token-Schätzfeld existiert.
      // Story-YAML hat aktuell kein eigenständiges Token-Schätzfeld (nur dispo_est in EP);
      // tok_est bleibt null (entspricht Spec: "falls in der YAML vorhanden").
      if (tok_est == null && storyEntry?.tok_est_yaml != null) {
        tok_est = storyEntry.tok_est_yaml;
      }
    }

    // story-detail-yaml-fallback AC3 — ended_at-Fallback aus done_at wenn Ledger leer:
    // Liefert der Ledger ein ended_at (aus Dispatches), hat Ledger Vorrang (AC7).
    // Sonst: done_at aus dem Story-Index verwenden wenn vorhanden.
    // started_at/duration bleiben null ohne Ledger (nicht aus YAML ableitbar).
    let ended_at = detail.ended_at;
    let ended_at_source = null;
    if (ended_at != null) {
      ended_at_source = 'ledger';
    } else {
      const yamlDoneAt = storyEntry?.done_at ?? null;
      if (yamlDoneAt != null) {
        ended_at = yamlDoneAt;
        ended_at_source = 'yaml';
      }
    }

    // story-detail-yaml-fallback AC4 — branch, pr, status aus Index durchreichen
    const branch = storyEntry?.branch ?? null;
    const pr = storyEntry?.pr ?? null;
    const status = storyEntry?.status ?? null;

    // Lauf-Metrik-Gate: Eine Story im Status "To Do" wurde nie gestartet und kann
    // daher keine Lauf-Daten (Start/Ende/Dauer/Agenten-Flow) haben. Das robuste ID-Matching
    // im StoryMetricReader (Zahl ↔ "S-###") könnte sonst alte Ledger-Zeilen einer
    // wiederverwendeten Nummer fälschlich dieser noch nicht umgesetzten Story zuordnen.
    // Schätzungen (ep_est/tok_est/size_est) bleiben sichtbar — sie sind Vorab-Werte, kein Lauf-Ist.
    const notStarted = status === 'To Do';
    const started_at = notStarted ? null : detail.started_at;
    const duration   = notStarted ? null : detail.duration;
    const flow       = notStarted ? [] : detail.flow;
    if (notStarted) {
      // Auch ein aus dem Ledger gezogenes ended_at unterdrücken (YAML-done_at gibt es bei To Do nicht).
      ended_at = null;
      ended_at_source = null;
    }

    const enrichedDetail = {
      ...detail,
      started_at,
      duration,
      flow,
      ep_est,
      tok_est,
      ep_est_source,
      ended_at,
      ended_at_source,
      branch,
      pr,
      status,
    };

    return res.json({ detail: enrichedDetail });
  });

  /**
   * POST /api/board/projects/:slug/ideas
   *
   * Quick-Capture-Create (ideen-inbox AC3/AC4/AC7/AC8): legt eine neue Story mit
   * `status: Idee` an — token-frei (kein Agent). Reihenfolge: Slug-Format-Prüfung →
   * Eingabe-Validierung (400, KEIN Audit — keine versuchte Aktion) → Audit-First
   * (genau EIN Eintrag, AC7) → `BoardWriter.createIdea()` (einziger Schreibpfad, AC8).
   *
   * Body: { title: string, body?: string }
   * Response 201: { storyId }
   * Response 400: { field, message }  (leerer/zu langer Titel oder Body)
   * Response 404: { error }           (Slug-Format ungültig ODER Projekt nicht unter BOARD_ROOTS)
   * Response 500: { error }           (Audit-/Schreibfehler — kein Secret-Leak, AC8 Edge-Case)
   */
  router.post('/api/board/projects/:slug/ideas', async (req, res) => {
    const { slug } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    if (!boardWriter) {
      console.error('[boardRouter] POST .../ideas: boardWriter nicht verdrahtet');
      return res.status(500).json({ error: 'Idee konnte nicht angelegt werden.' });
    }

    const { title, body } = req.body ?? {};

    // Validierung VOR dem Audit-Eintrag — eine abgelehnte Eingabe ist KEINE
    // versuchte Aktion und wird nicht auditiert. Dieselbe reine Funktion wie
    // `BoardWriter#createIdea` (Defense-in-Depth, kein doppelter Code).
    let validated;
    try {
      validated = validateIdeaInput({ title, body });
    } catch (err) {
      if (err instanceof BoardWriterError) {
        const field = err.errorClass === 'invalid-body' ? 'body' : 'title';
        return res.status(400).json({ field, message: err.message });
      }
      throw err;
    }

    // Audit-First (AC7 — GENAU EIN Eintrag je Anlage): schlägt record() fehl,
    // wird createIdea() NICHT aufgerufen (analog assistRefineRouter).
    if (auditStore) {
      try {
        auditStore.record({
          identity: _resolveIdentity(req.identity ?? null),
          command: `board:idea:create:${slug}`,
        });
      } catch (auditErr) {
        console.error('[boardRouter] Audit-Write fehlgeschlagen (POST .../ideas):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    let result;
    try {
      result = await boardWriter.createIdea({
        projectSlug: slug,
        title: validated.trimmedTitle,
        body: validated.normalizedBody,
      });
    } catch (err) {
      if (err instanceof BoardWriterError) {
        if (err.errorClass === 'invalid-title' || err.errorClass === 'invalid-body') {
          // Sollte durch die Vorab-Validierung bereits abgefangen sein — Defense-in-Depth.
          const field = err.errorClass === 'invalid-body' ? 'body' : 'title';
          return res.status(400).json({ field, message: err.message });
        }
        if (err.errorClass === 'invalid-slug' || err.errorClass === 'project-not-found') {
          return res.status(404).json({ error: 'Projekt nicht gefunden.' });
        }
        console.error('[boardRouter] createIdea fehlgeschlagen:', err.errorClass, err.message);
        return res.status(500).json({ error: 'Idee konnte nicht angelegt werden.' });
      }
      console.error('[boardRouter] createIdea unerwarteter Fehler:', err.message);
      return res.status(500).json({ error: 'Idee konnte nicht angelegt werden.' });
    }

    return res.status(201).json({ storyId: result.storyId });
  });

  /**
   * POST /api/board/projects/:slug/ideas/:id/discuss
   *
   * Besprechungs-Start (ideen-inbox AC5/AC7/AC8, S-200): startet/nutzt die
   * interaktive PTY-Session des Projekts und lädt die Stichworte der Idee als
   * konversationellen Gesprächs-Einstieg vor. Ändert den Status der Idee NICHT.
   *
   * Response 200: { sessionId }
   * Response 400: { field: 'status', message }  (Idee nicht (mehr) besprechbar)
   * Response 404: { error }  (Slug/Idee ungültig oder unbekannt)
   * Response 409: { error }  (ein Command läuft bereits — [[flow-trigger]] AC3)
   * Response 500/503: { error }  (Wiring fehlt / PTY-Write fehlgeschlagen / Session-Cap)
   */
  router.post('/api/board/projects/:slug/ideas/:id/discuss', async (req, res) => {
    const { slug, id } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }
    if (!id || !STORY_ID_RE.test(id)) {
      return res.status(404).json({ error: 'Idee nicht gefunden.' });
    }

    if (!commandService || !sessionRegistry) {
      console.error('[boardRouter] POST .../discuss: commandService/sessionRegistry nicht verdrahtet');
      return res.status(500).json({ error: 'Besprechung konnte nicht gestartet werden.' });
    }

    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);
    if (!project || project.error) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const storyEntry = _findStoryInProject(project, id);
    if (!storyEntry) {
      return res.status(404).json({ error: 'Idee nicht gefunden.' });
    }

    // Edge-Case (ideen-inbox.md): ein bereits aufgelöstes (oder aus anderem
    // Grund nicht-`Idee`-) Item ist nicht (mehr) besprechbar.
    if (storyEntry.status !== 'Idee') {
      return res.status(400).json({ field: 'status', message: 'Idee ist nicht (mehr) besprechbar.' });
    }

    const repoPath = project.repo_path;

    // Finding 1 (Iteration 2, coder-Lesson 2026-07-01): ProjectJobLock kurz
    // (Check+PTY-Write) um repoPath halten — schließt die Naht zum Taktgeber/
    // ProjectDrain (hält dasselbe Lock für die GESAMTE Drain-Session, gibt aber
    // den globalen CommandService-Lock zwischen zwei /flow-Runden frei) UND
    // schützt symmetrisch gegen zwei gleichzeitige discuss-Aufrufe fürs selbe
    // Projekt. Bewusst NICHT sessionRegistry.hasSession() (isProjectBusy)
    // übernehmen — das würde jede bereits offene Terminal-Session fälschlich
    // blockieren (der Owner hat die Projekt-Session evtl. schon offen).
    if (!lock.tryAcquire(repoPath)) {
      return res.status(409).json({ error: 'Projekt wird gerade vom Taktgeber oder einer anderen Besprechung bearbeitet.' });
    }

    try {
      // Busy-Check ([[flow-trigger]] AC3 — globaler Lock, spiegelt POST /api/command
      // 409-Semantik): kein Start bei laufendem Command, Idee bleibt unverändert.
      if (commandService.getStatus().status === 'running') {
        return res.status(409).json({ error: 'Ein Command läuft bereits.' });
      }

      const targetPty = sessionRegistry.getOrCreate(repoPath);
      if (!targetPty) {
        // Session-Cap erreicht (analog commandRouter/WsGateway) — kein AC-Vertrag
        // nennt diesen Fall explizit; degradiert graceful statt zu crashen.
        return res.status(503).json({ error: 'Session-Limit erreicht — bitte später erneut versuchen.' });
      }

      const seed = buildDiscussSeed({ title: storyEntry.title, body: storyEntry.notes });

      // Audit-First (AC7 — GENAU EIN Eintrag je Besprechungs-Start): schlägt
      // record() fehl, wird NICHT in die PTY geschrieben (kein nicht-auditierter Lauf).
      if (auditStore) {
        try {
          auditStore.record({
            identity: _resolveIdentity(req.identity ?? null),
            command: `board:idea:discuss:${slug}:${id}`,
          });
        } catch (auditErr) {
          console.error('[boardRouter] Audit-Write fehlgeschlagen (POST .../discuss):', auditErr.message);
          return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
        }
      }

      try {
        targetPty.write(`${seed}\n`);
      } catch (err) {
        console.error('[boardRouter] PTY-Write fehlgeschlagen (POST .../discuss):', err.message);
        return res.status(500).json({ error: 'Besprechung konnte nicht gestartet werden.' });
      }

      // sessionId: die Projekt-Session ist innerhalb der PtySessionRegistry eindeutig
      // über den (Slug-abgeleiteten) Projekt-Pfad identifiziert — der Slug ist dem
      // Client bereits bekannt und stabil je Projekt-Session (Interpretationsentscheidung,
      // siehe Handoff — kein separates Session-ID-Konzept in PtySessionRegistry).
      return res.status(200).json({ sessionId: slug });
    } finally {
      // Lock nur kurz halten (Check+Write) — das Gespräch selbst läuft danach
      // frei in der Terminal-Session, NICHT unter diesem Lock.
      lock.release(repoPath);
    }
  });

  /**
   * POST /api/board/projects/:slug/ideas/:id/resolve
   *
   * Explizite Auflösung (ideen-inbox AC6/AC7/AC8, S-200): setzt das Idee-Item
   * über `BoardWriter.resolveIdea()` auf `status: Done` + `resolved_at` (+
   * optional resolved_story_ids/resolved_note). KEIN Agent-Dispatch.
   *
   * Body: { resolved_story_ids?: string[], resolved_note?: string }
   * Response 200: { storyId }
   * Response 400: { field, message }  (ungültiger Payload ODER nicht (mehr) auflösbar)
   * Response 404: { error }  (Slug/Idee ungültig oder unbekannt)
   * Response 500: { error }  (Wiring fehlt / Audit-/Schreibfehler — kein Secret-Leak)
   */
  router.post('/api/board/projects/:slug/ideas/:id/resolve', async (req, res) => {
    const { slug, id } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }
    if (!id || !STORY_ID_RE.test(id)) {
      return res.status(404).json({ error: 'Idee nicht gefunden.' });
    }

    if (!boardWriter) {
      console.error('[boardRouter] POST .../resolve: boardWriter nicht verdrahtet');
      return res.status(500).json({ error: 'Idee konnte nicht aufgelöst werden.' });
    }

    const { resolved_story_ids: resolvedStoryIdsRaw, resolved_note: resolvedNoteRaw } = req.body ?? {};

    // Validierung VOR dem Audit-Eintrag — eine abgelehnte Eingabe ist KEINE
    // versuchte Aktion und wird nicht auditiert (Audit-First gilt nur für
    // tatsächlich versuchte Aktionen, analog POST .../ideas).
    let validated;
    try {
      validated = validateResolveInput({ resolvedStoryIds: resolvedStoryIdsRaw, resolvedNote: resolvedNoteRaw });
    } catch (err) {
      if (err instanceof BoardWriterError) {
        const field = err.errorClass === 'invalid-note' ? 'resolved_note' : 'resolved_story_ids';
        return res.status(400).json({ field, message: err.message });
      }
      throw err;
    }

    // Audit-First (AC7 — GENAU EIN Eintrag je Auflösung): schlägt record() fehl,
    // wird resolveIdea() NICHT aufgerufen.
    if (auditStore) {
      try {
        auditStore.record({
          identity: _resolveIdentity(req.identity ?? null),
          command: `board:idea:resolve:${slug}:${id}`,
        });
      } catch (auditErr) {
        console.error('[boardRouter] Audit-Write fehlgeschlagen (POST .../resolve):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    try {
      await boardWriter.resolveIdea({
        projectSlug: slug,
        storyId: id,
        resolvedStoryIds: validated.resolvedStoryIds,
        resolvedNote: validated.resolvedNote,
      });
    } catch (err) {
      if (err instanceof BoardWriterError) {
        if (err.errorClass === 'not-resolvable') {
          return res.status(400).json({ field: 'status', message: err.message });
        }
        if (err.errorClass === 'invalid-slug' || err.errorClass === 'project-not-found') {
          return res.status(404).json({ error: 'Projekt nicht gefunden.' });
        }
        if (err.errorClass === 'story-not-found' || err.errorClass === 'invalid-story-id') {
          return res.status(404).json({ error: 'Idee nicht gefunden.' });
        }
        console.error('[boardRouter] resolveIdea fehlgeschlagen:', err.errorClass, err.message);
        return res.status(500).json({ error: 'Idee konnte nicht aufgelöst werden.' });
      }
      console.error('[boardRouter] resolveIdea unerwarteter Fehler:', err.message);
      return res.status(500).json({ error: 'Idee konnte nicht aufgelöst werden.' });
    }

    return res.status(200).json({ storyId: id });
  });

  /**
   * POST /api/board/projects/:slug/archive-done
   *
   * Archiviert alle aktuell archivierbaren Features des Projekts (board-feature-archive
   * V1/V4, S-232) über den einzigen Schreibpfad `BoardWriter.archiveDoneFeatures()`.
   * Reihenfolge: Slug-Format (404) → Projekt-Auflösung gegen den In-Memory-Index
   * (404 wenn nicht unter BOARD_ROOTS) → ProjectJobLock kurz halten (409 wenn belegt) →
   * Audit-First (GENAU EIN Eintrag, nach Slug-/Busy-Prüfung, vor dem Schreiben) →
   * archiveDoneFeatures() → 200. Kein Request-Body.
   *
   * Response 200: { archivedFeatureCount, archivedStoryCount }  (0/0 wenn nichts
   *                archivierbar war — kein Fehler)
   * Response 404: { error }  (Slug-Format ungültig ODER Projekt nicht unter BOARD_ROOTS)
   * Response 409: { error }  (ProjectJobLock belegt — Taktgeber/Drain/andere Schreibaktion)
   * Response 500: { error }  (Wiring fehlt / Audit-/Schreibfehler — kein Secret-Leak)
   */
  router.post('/api/board/projects/:slug/archive-done', async (req, res) => {
    const { slug } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    if (!boardWriter) {
      console.error('[boardRouter] POST .../archive-done: boardWriter nicht verdrahtet');
      return res.status(500).json({ error: 'Features konnten nicht archiviert werden.' });
    }

    // Slug nur gegen den In-Memory-Index auflösen (nie als Pfad, AC8) — ein Slug,
    // der nicht (mehr) unter BOARD_ROOTS gescannt wurde, ist unbekannt → 404.
    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);
    if (!project || project.error) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const repoPath = project.repo_path;

    // Concurrency-Schutz (V4): ProjectJobLock kurz (Check+Schreiben) um repoPath
    // halten — 409, wenn der Taktgeber/Drain oder eine andere Board-Schreibaktion
    // (z.B. discuss) es bereits hält. Dieselbe Lock-Instanz wie .../discuss (Default:
    // Singleton projectJobLock), damit sich Board-Schreibaktionen gegenseitig sperren.
    if (!lock.tryAcquire(repoPath)) {
      return res.status(409).json({ error: 'Projekt wird gerade vom Taktgeber oder einer anderen Board-Aktion bearbeitet.' });
    }

    try {
      // Audit-First (AC4 — GENAU EIN Eintrag je Aufruf, nach Slug-/Busy-Prüfung,
      // VOR dem Schreiben): schlägt record() fehl, wird NICHT archiviert.
      if (auditStore) {
        try {
          auditStore.record({
            identity: _resolveIdentity(req.identity ?? null),
            command: `board:archive-done:${slug}`,
          });
        } catch (auditErr) {
          console.error('[boardRouter] Audit-Write fehlgeschlagen (POST .../archive-done):', auditErr.message);
          return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
        }
      }

      let result;
      try {
        result = await boardWriter.archiveDoneFeatures({ projectSlug: slug });
      } catch (err) {
        if (err instanceof BoardWriterError) {
          if (err.errorClass === 'invalid-slug' || err.errorClass === 'project-not-found') {
            return res.status(404).json({ error: 'Projekt nicht gefunden.' });
          }
          console.error('[boardRouter] archiveDoneFeatures fehlgeschlagen:', err.errorClass, err.message);
          return res.status(500).json({ error: 'Features konnten nicht archiviert werden.' });
        }
        console.error('[boardRouter] archiveDoneFeatures unerwarteter Fehler:', err.message);
        return res.status(500).json({ error: 'Features konnten nicht archiviert werden.' });
      }

      return res.status(200).json({
        archivedFeatureCount: result.archivedFeatureCount,
        archivedStoryCount: result.archivedStoryCount,
      });
    } finally {
      // Lock nur kurz halten (Check+Schreiben) — analog .../discuss, kein Deadlock.
      lock.release(repoPath);
    }
  });

  return router;
}
