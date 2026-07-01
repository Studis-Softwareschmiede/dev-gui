/**
 * ideaSpecifyRouter — Express-Router für das Idee-Specify-Chat-Overlay
 * (docs/specs/idea-specify-chat.md AC3, AC4, AC5, AC6, AC7, AC8, AC9, AC13;
 * idea-keyed Status-Reads + differenzierter Doppelstart-409 durch
 * docs/specs/idea-specify-background-status.md AC2, AC7, AC8).
 *
 * Routes (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/board/projects/:slug/ideas/:id/specify/start           → 201 { sessionId, reply }
 *   POST /api/board/projects/:slug/ideas/:id/specify/message         → 200 { reply, readyToSpecify, draftText? }
 *   POST /api/board/projects/:slug/ideas/:id/specify/finalize        → 202 { jobId, status: 'running' }  (S-216, AC6;
 *        409 differenziert: projekt-weiter Lock ('locked') ODER idea-keyed Doppelstart ('idea-locked'),
 *        idea-specify-background-status AC7)
 *   GET  /api/board/projects/:slug/ideas/:id/specify/finalize/:jobId → 200 { status, result?, error? }   (S-216, AC7;
 *        status ∈ {running,done,failed,auth-expired,no-op} seit S-220/headless-arg-finalize-safety AC5 —
 *        `no-op` wird vom `IdeaSpecifyFinalizer` gemappt, hier nur unverändert durchgereicht)
 *   GET  /api/board/projects/:slug/specify/jobs                      → 200 { jobs: { [ideaStoryId]: {...} } }
 *        (idea-specify-background-status AC2 — nur nicht-`done`; Board-Hydration/Polling; token-/secret-frei)
 *   GET  /api/board/projects/:slug/ideas/:id/specify/status          → 200 { job | null }
 *        (idea-specify-background-status AC2 — letzter Job dieser Idee; Overlay-Reopen; token-/secret-frei)
 *
 * S-216 (FOLGE-ITEM, GLEICHE Datei) ergänzt die beiden `finalize`-Routen unten,
 * OHNE die bestehenden `start`/`message`-Handler umzubauen — die Datei war
 * dafür bereits vorbereitet (eigene `chatService`-Dependency getrennt vom
 * neuen `finalizer`-Parameter).
 *
 * Slug-/ID-Validierung: identisches Muster zu `boardRouter.js` (SLUG_RE/STORY_ID_RE,
 * Story-Lookup via `boardAggregator.getIndex()`) — Slug/ID werden NIE als
 * Dateisystem-Pfad verwendet, nur als Werte-Vergleich gegen den
 * vertrauenswürdigen In-Memory-Index (kein Traversal möglich). Für `finalize`
 * wird der bereits vertrauenswürdige `project.repo_path` aus demselben Index
 * als `projectPath` an den `IdeaSpecifyFinalizer` durchgereicht (identisches
 * Muster zu `boardRouter.js` `.../discuss` — KEINE erneute
 * `resolveProjectSlug`/`validateProjectPath`-Auflösung nötig).
 *
 * Audit-First-Konvention (analog `assistRefineRouter`/`boardRouter` discuss):
 *   1. Validierung (Format, Existenz, Status/Gate) — bei Ablehnung KEIN Audit.
 *   2. Genau EIN Audit-Eintrag je akzeptiertem Turn/Job-Start (start, message
 *      ODER finalize).
 *   3. Erst danach der eigentliche `IdeaSpecifyChatService`- bzw.
 *      `IdeaSpecifyFinalizer`-Aufruf.
 *
 * `finalize`-Gate (AC6): nur zulässig, wenn der Chat zuvor `readyToSpecify`
 * gemeldet hat — gelesen über `chatService.getSessionState(sessionId)` (S-216),
 * NICHT aus dem Request-Body (der Client sendet nur `{ sessionId }`, siehe
 * Verträge). Fehlt das Gate (kein `readyToSpecify`) → `400`; belegtes
 * `IdeaSpecifyFinalizer`-Lock für dasselbe Projekt → `409`.
 *
 * Security (Floor):
 *   - Hinter AccessGuard (server.js).
 *   - Nutzer-Text (message) geht ausschliesslich über `IdeaSpecifyChatService`
 *     → STDIN an `claude -p`, NIE als argv (security/R02).
 *   - Kein PTY-/CommandService-Import — komplett getrennte Boundary (AC5/AC12).
 *     `IdeaSpecifyFinalizer` (S-216) nutzt intern den tool-fähigen
 *     `HeadlessFlowRunner` MIT eigener `ProjectJobLock`-Instanz (AC6) — bewusst
 *     eine andere Boundary als der tool-lose Chat-Pfad oben.
 *   - Keine Secrets in Log/Audit/Response.
 *
 * @module ideaSpecifyRouter
 */

import { Router } from 'express';

/** Valid slug characters: alphanumeric, dash, underscore, dot. No leading slash. */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Valid story ID characters: alphanumeric, dash, underscore, dot.
 * Must start with alphanumeric. No path traversal possible.
 */
const STORY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Findet einen Story-Eintrag (Idee ODER jede andere Story) im Board-Index
 * anhand ihrer ID — durchsucht alle Features EINSCHLIESSLICH der
 * `_orphaned`-Pseudo-Feature (Idee-Items landen dort typischerweise, siehe
 * `BoardAggregator.js`). 1:1 dasselbe Muster wie `boardRouter.js#_findStoryInProject`.
 *
 * @param {object} project Ein Eintrag aus `boardAggregator.getIndex()`.
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
 * `boardRouter.js`/`assistRefineRouter`.
 * @param {object|null} identity
 * @returns {string|null}
 */
function _resolveIdentity(identity) {
  return identity?.email ?? null;
}

/**
 * Create the idea-specify router.
 *
 * @param {object} options
 * @param {import('./BoardAggregator.js').BoardAggregator} options.boardAggregator
 * @param {import('./IdeaSpecifyChatService.js').IdeaSpecifyChatService} options.chatService
 * @param {import('./IdeaSpecifyFinalizer.js').IdeaSpecifyFinalizer} [options.finalizer] - S-216, AC6/AC7.
 * @param {import('./AuditStore.js').AuditStore} [options.auditStore]
 * @returns {import('express').Router}
 */
export function ideaSpecifyRouter({ boardAggregator, chatService, finalizer, auditStore }) {
  const router = Router();

  /**
   * POST /api/board/projects/:slug/ideas/:id/specify/start
   *
   * Legt eine neue serverseitige Chat-Session an und seedet sie mit Titel +
   * Notes der Idee (AC3). Die erste `reply` ist Claudes Eröffnungs-Turn.
   *
   * Response 201: { sessionId, reply }
   * Response 400: { field: 'status', message }  (Item ist keine besprechbare Idee)
   * Response 404: { error }  (Projekt/Idee unbekannt)
   * Response 502: { error }  (claude -p-Fehler, secret-frei)
   */
  router.post('/api/board/projects/:slug/ideas/:id/specify/start', async (req, res) => {
    const { slug, id } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }
    if (!id || !STORY_ID_RE.test(id)) {
      return res.status(404).json({ error: 'Idee nicht gefunden.' });
    }

    if (!chatService) {
      console.error('[ideaSpecifyRouter] POST .../specify/start: chatService nicht verdrahtet');
      return res.status(500).json({ error: 'Chat konnte nicht gestartet werden.' });
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

    // AC3 Edge-Case: Item ist keine (mehr) besprechbare Idee.
    if (storyEntry.status !== 'Idee') {
      return res.status(400).json({ field: 'status', message: 'Idee ist nicht (mehr) besprechbar.' });
    }

    // Audit-First (genau EIN Eintrag je akzeptiertem Turn, AC5): schlägt
    // record() fehl, wird der claude-Aufruf NICHT gestartet.
    if (auditStore) {
      try {
        auditStore.record({
          identity: _resolveIdentity(req.identity ?? null),
          command: `board:idea:specify:start:${slug}:${id}`,
        });
      } catch (auditErr) {
        console.error('[ideaSpecifyRouter] Audit-Write fehlgeschlagen (POST .../specify/start):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    const result = await chatService.start({
      title: storyEntry.title,
      notes: storyEntry.notes,
      repoContext: slug,
    });

    if (!result.ok) {
      // 502 — claude -p nicht verfügbar oder Fehler (secret-frei, kein stderr-Leak)
      return res.status(502).json({ error: result.message ?? 'claude -p unavailable or failed' });
    }

    return res.status(201).json({ sessionId: result.sessionId, reply: result.reply });
  });

  /**
   * POST /api/board/projects/:slug/ideas/:id/specify/message
   *
   * Hängt die Nutzer-Nachricht an die serverseitig gehaltene Session-Historie
   * an und liefert Claudes nächsten Turn (AC4, AC13). Der Client übermittelt
   * NUR die neue Nachricht — nicht die ganze Historie.
   *
   * Body: { sessionId: string, message: string }
   * Response 200: { reply, readyToSpecify, draftText? }
   * Response 400: { field, message }  (fehlende/ungültige sessionId oder message)
   * Response 404: { error }  (Projekt/Idee/Session unbekannt)
   * Response 502: { error }  (claude -p-Fehler, secret-frei)
   */
  router.post('/api/board/projects/:slug/ideas/:id/specify/message', async (req, res) => {
    const { slug, id } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }
    if (!id || !STORY_ID_RE.test(id)) {
      return res.status(404).json({ error: 'Idee nicht gefunden.' });
    }

    if (!chatService) {
      console.error('[ideaSpecifyRouter] POST .../specify/message: chatService nicht verdrahtet');
      return res.status(500).json({ error: 'Nachricht konnte nicht verarbeitet werden.' });
    }

    const { sessionId, message } = req.body ?? {};

    // Validierung VOR dem Audit-Eintrag — eine abgelehnte Eingabe ist KEINE
    // versuchte Aktion und wird nicht auditiert (Audit-First-Konvention).
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return res.status(400).json({ field: 'sessionId', message: 'sessionId must be a non-empty string' });
    }
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ field: 'message', message: 'message must be a non-empty string' });
    }

    // AC4: 404 bei unbekannter/abgelaufener Session — geprüft VOR dem Audit
    // (analog Existenz-Checks bei .../specify/start).
    if (!chatService.hasSession(sessionId)) {
      return res.status(404).json({ error: 'Session nicht gefunden.' });
    }

    if (auditStore) {
      try {
        auditStore.record({
          identity: _resolveIdentity(req.identity ?? null),
          command: `board:idea:specify:message:${slug}:${id}`,
        });
      } catch (auditErr) {
        console.error('[ideaSpecifyRouter] Audit-Write fehlgeschlagen (POST .../specify/message):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    const result = await chatService.message({ sessionId, message });

    if (!result.ok) {
      if (result.reason === 'session-not-found') {
        // Defense-in-Depth: bereits oben via hasSession() abgefangen — Race-Fenster
        // praktisch ausgeschlossen (Node ist single-threaded, keine Multi-Prozess-
        // Nebenläufigkeit auf derselben Map), aber ein sauberer 404 statt 502.
        return res.status(404).json({ error: 'Session nicht gefunden.' });
      }
      // 502 — claude -p nicht verfügbar oder Fehler (secret-frei, kein stderr-Leak)
      return res.status(502).json({ error: result.message ?? 'claude -p unavailable or failed' });
    }

    return res.status(200).json({
      reply: result.reply,
      readyToSpecify: result.readyToSpecify,
      ...(result.draftText !== undefined ? { draftText: result.draftText } : {}),
    });
  });

  // ── S-216: Finalize-Endpunkte (AC6, AC7, AC8, AC9) ─────────────────────────

  /**
   * POST /api/board/projects/:slug/ideas/:id/specify/finalize
   *
   * Startet den headless `requirement`-Finalizer (AC6) — nur zulässig, wenn
   * der Chat zuvor `readyToSpecify` gemeldet hat (Gate, gelesen über
   * `chatService.getSessionState()`, NICHT aus dem Request-Body).
   *
   * Body: { sessionId: string }
   * Response 202: { jobId, status: 'running' }
   * Response 400: { field, message }  (fehlende/ungültige sessionId ODER kein readyToSpecify)
   * Response 404: { error }  (Projekt/Idee/Session unbekannt)
   * Response 409: { error }  (Finalizer-Lock für dieses Projekt bereits belegt)
   */
  router.post('/api/board/projects/:slug/ideas/:id/specify/finalize', async (req, res) => {
    const { slug, id } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }
    if (!id || !STORY_ID_RE.test(id)) {
      return res.status(404).json({ error: 'Idee nicht gefunden.' });
    }

    if (!chatService || !finalizer) {
      console.error('[ideaSpecifyRouter] POST .../specify/finalize: chatService/finalizer nicht verdrahtet');
      return res.status(500).json({ error: 'Finalisierung konnte nicht gestartet werden.' });
    }

    const { sessionId } = req.body ?? {};

    // Validierung VOR dem Audit-Eintrag (Audit-First-Konvention).
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return res.status(400).json({ field: 'sessionId', message: 'sessionId must be a non-empty string' });
    }

    if (!chatService.hasSession(sessionId)) {
      return res.status(404).json({ error: 'Session nicht gefunden.' });
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

    // AC6-Gate: kein readyToSpecify → 400 (Button ist im Frontend deaktiviert,
    // AC11 — dieser Check schützt gegen einen dennoch abgesetzten Request).
    const sessionState = chatService.getSessionState(sessionId);
    if (!sessionState || sessionState.readyToSpecify !== true) {
      return res.status(400).json({
        field: 'readyToSpecify',
        message: 'Chat ist noch nicht bereit zur Finalisierung (readyToSpecify fehlt).',
      });
    }

    // Audit-First (genau EIN Eintrag je akzeptiertem Finalize-Start): schlägt
    // record() fehl, wird der Finalizer NICHT gestartet.
    if (auditStore) {
      try {
        auditStore.record({
          identity: _resolveIdentity(req.identity ?? null),
          command: `board:idea:specify:finalize:${slug}:${id}`,
        });
      } catch (auditErr) {
        console.error('[ideaSpecifyRouter] Audit-Write fehlgeschlagen (POST .../specify/finalize):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    const result = await finalizer.start(project.repo_path, {
      draftText: sessionState.draftText,
      ideaStoryId: id,
      projectSlug: slug,
    });

    if (!result.ok) {
      // Zwei Ablehnungs-Ursachen, beide 409 (idea-specify-background-status AC7):
      //   'locked'      → projekt-weiter ProjectJobLock des Runners (idea-specify-chat AC6).
      //   'idea-locked' → für DIESE Idee läuft bereits ein Finalize (idea-keyed Guard).
      const error =
        result.reason === 'idea-locked'
          ? 'Für diese Idee läuft bereits ein Spezifizieren-Lauf.'
          : 'Finalizer läuft bereits für dieses Projekt.';
      return res.status(409).json({ error });
    }

    return res.status(202).json({ jobId: result.jobId, status: 'running' });
  });

  /**
   * GET /api/board/projects/:slug/specify/jobs
   *
   * Idea-keyed Status aller NICHT-`done` Finalize-Jobs eines Projekts
   * (idea-specify-background-status AC2) — für Board-Hydration + leichtes
   * Polling der Idee-Badges (AC3/AC5). Token-frei (KEIN Agenten-Dispatch, KEINE
   * Board-Schreibaktion, KEIN Audit), secret-/token-/host-pfad-frei (AC8).
   *
   * Response 200: { jobs: { [ideaStoryId]: { status: 'running'|'failed'|'auth-expired', jobId, error? } } }
   * Response 404: { error }  (Projekt unbekannt / ungültiges Slug-Format)
   */
  router.get('/api/board/projects/:slug/specify/jobs', async (req, res) => {
    const { slug } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    if (!finalizer) {
      console.error('[ideaSpecifyRouter] GET .../specify/jobs: finalizer nicht verdrahtet');
      return res.status(500).json({ error: 'Status konnte nicht gelesen werden.' });
    }

    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);
    if (!project || project.error) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const jobs = await finalizer.jobsForProject(slug);
    return res.status(200).json({ jobs });
  });

  /**
   * GET /api/board/projects/:slug/ideas/:id/specify/status
   *
   * Letzter bekannter Finalize-Job EINER Idee (idea-specify-background-status
   * AC2) — für das Overlay-Reopen (AC6). Token-frei (KEIN Agenten-Dispatch,
   * KEINE Board-Schreibaktion, KEIN Audit), secret-/token-/host-pfad-frei (AC8).
   *
   * Response 200: { job: { status: 'running'|'done'|'failed'|'auth-expired', jobId, error? } | null }
   * Response 404: { error }  (Projekt/Idee unbekannt / ungültiges Format)
   */
  router.get('/api/board/projects/:slug/ideas/:id/specify/status', async (req, res) => {
    const { slug, id } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }
    if (!id || !STORY_ID_RE.test(id)) {
      return res.status(404).json({ error: 'Idee nicht gefunden.' });
    }

    if (!finalizer) {
      console.error('[ideaSpecifyRouter] GET .../specify/status: finalizer nicht verdrahtet');
      return res.status(500).json({ error: 'Status konnte nicht gelesen werden.' });
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

    const job = await finalizer.statusForIdea(slug, id);
    return res.status(200).json({ job });
  });

  /**
   * GET /api/board/projects/:slug/ideas/:id/specify/finalize/:jobId
   *
   * Liest den Job-Status (AC7) — Format 1:1 wie der bestehende headless-
   * Reconcile-Status-Endpunkt (`reconcileRouter.js`). Der `no-op`-Statuswert
   * (headless-arg-finalize-safety AC5/AC6) wird vom `IdeaSpecifyFinalizer`
   * selbst gemappt — dieser Router-Handler reicht ihn nur unverändert durch,
   * kein struktureller Umbau nötig.
   *
   * Response 200: { status, result?, error? }  (status ∈ {running,done,failed,auth-expired,no-op})
   * Response 404: { error }  (unbekannte jobId, auch nach Server-Neustart)
   */
  router.get('/api/board/projects/:slug/ideas/:id/specify/finalize/:jobId', async (req, res) => {
    if (!finalizer) {
      console.error('[ideaSpecifyRouter] GET .../specify/finalize/:jobId: finalizer nicht verdrahtet');
      return res.status(500).json({ error: 'Status konnte nicht gelesen werden.' });
    }

    const job = await finalizer.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown jobId' });
    }

    const body = { status: job.status };
    if (job.result !== undefined) body.result = job.result;
    if (job.error !== undefined) body.error = job.error;

    return res.status(200).json(body);
  });

  return router;
}
