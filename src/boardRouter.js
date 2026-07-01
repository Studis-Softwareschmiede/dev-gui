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
 *   POST /api/board/projects/rescan                  → { ok: true }  (on-demand re-scan, AC9)
 *   GET /api/board/projects/:slug/stories/:id/detail → { detail: StoryDetail }  (read-only, lazy — AC2)
 *   POST /api/board/projects/:slug/ideas             → { storyId }  (Quick-Capture-Create, ideen-inbox AC3)
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
 * Security:
 *   - Read-only für alle GET-Routen (AC7 studis-kanban-board-ux).
 *   - :slug and :id parameters validated against regex before use as index lookup.
 *     slug is compared to in-memory index only (never used as filesystem path).
 *     id is compared as value only (never used as filesystem path — no traversal).
 *   - POST .../ideas: title/body werden ausschließlich über `BoardWriter.createIdea()`
 *     validiert/sanitisiert (Steuerzeichen-Schutz, Längenlimits) — kein Roh-Schreiben
 *     im Router; projectSlug läuft durch dieselbe BOARD_ROOTS-Realpath-Schranke wie
 *     `setBlocked` (siehe BoardWriter.js).
 *   - Behind existing /api AccessGuard via server.js registration.
 *   - No secrets in output; no new authentication surface.
 *
 * @module boardRouter
 */

import { Router } from 'express';
import { BoardWriterError, validateIdeaInput } from './BoardWriter.js';

/** Valid slug characters: alphanumeric, dash, underscore, dot. No leading slash. */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Valid story ID characters: alphanumeric, dash, underscore, dot.
 * Must start with alphanumeric. No path traversal possible.
 */
const STORY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

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
 * @param {import('./BoardWriter.js').BoardWriter} [options.boardWriter]  Create-Pfad (ideen-inbox AC3).
 * @param {import('./AuditStore.js').AuditStore} [options.auditStore]  Audit je Anlage (ideen-inbox AC7).
 * @returns {import('express').Router}
 */
export function boardRouter({ boardAggregator, storyMetricReader, notificationWatcher, boardWriter, auditStore }) {
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
  router.get('/api/board/projects', async (_req, res) => {
    const projects = await boardAggregator.getIndex();
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
   */
  router.get('/api/board/projects/:slug', async (req, res) => {
    const { slug } = req.params;

    // Validate slug format — reject obviously invalid inputs early
    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);

    if (!project) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    return res.json({ project });
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

  return router;
}
