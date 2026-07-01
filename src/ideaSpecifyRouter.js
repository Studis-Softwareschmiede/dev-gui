/**
 * ideaSpecifyRouter — Express-Router für das Idee-Specify-Chat-Overlay
 * (docs/specs/idea-specify-chat.md AC3, AC4, AC5, AC13).
 *
 * Routes (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/board/projects/:slug/ideas/:id/specify/start   → 201 { sessionId, reply }
 *   POST /api/board/projects/:slug/ideas/:id/specify/message → 200 { reply, readyToSpecify, draftText? }
 *
 * NICHT Teil dieser Story (S-215) — kommt in S-216 (FOLGE-ITEM, GLEICHE Datei):
 *   POST /api/board/projects/:slug/ideas/:id/specify/finalize
 *   GET  /api/board/projects/:slug/ideas/:id/specify/finalize/:jobId
 * Diese Datei ist bewusst so aufgebaut (eigene Router-Instanz-Funktion,
 * `chatService`-Dependency getrennt von einem künftigen `finalizer`-Parameter),
 * dass S-216 hier zusätzliche Routen ergänzen kann, ohne die bestehenden
 * start/message-Handler umzubauen.
 *
 * Slug-/ID-Validierung: identisches Muster zu `boardRouter.js` (SLUG_RE/STORY_ID_RE,
 * Story-Lookup via `boardAggregator.getIndex()`) — Slug/ID werden NIE als
 * Dateisystem-Pfad verwendet, nur als Werte-Vergleich gegen den
 * vertrauenswürdigen In-Memory-Index (kein Traversal möglich).
 *
 * Audit-First-Konvention (analog `assistRefineRouter`/`boardRouter` discuss):
 *   1. Validierung (Format, Existenz, Status) — bei Ablehnung KEIN Audit.
 *   2. Genau EIN Audit-Eintrag je akzeptiertem Turn (start ODER message).
 *   3. Erst danach der eigentliche `IdeaSpecifyChatService`-Aufruf (`claude -p`).
 *
 * Security (Floor):
 *   - Hinter AccessGuard (server.js).
 *   - Nutzer-Text (message) geht ausschliesslich über `IdeaSpecifyChatService`
 *     → STDIN an `claude -p`, NIE als argv (security/R02).
 *   - Kein PTY-/CommandService-/HeadlessFlowRunner-Import — komplett getrennte
 *     Boundary (AC5/AC12).
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
 * @param {import('./AuditStore.js').AuditStore} [options.auditStore]
 * @returns {import('express').Router}
 */
export function ideaSpecifyRouter({ boardAggregator, chatService, auditStore }) {
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

  return router;
}
