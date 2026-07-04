/**
 * storySpecifyRouter — Express-Router für den Neue-Story-Chat („from scratch",
 * ohne Idee-Karte) — docs/specs/new-story-chat.md AC2, AC3, AC4, AC5, AC8.
 *
 * Routes (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/board/projects/:slug/story-specify/start          → 201 { sessionId, reply }
 *   POST /api/board/projects/:slug/story-specify/message        → 200 { reply, readyToSpecify, draftText? }
 *   POST /api/board/projects/:slug/story-specify/finalize       → 202 { jobId, status: 'running' }
 *   GET  /api/board/projects/:slug/story-specify/finalize       → 200 { job | null }
 *   GET  /api/board/projects/:slug/story-specify/finalize/:jobId → 200 { status, result?, error? }
 *
 * Finalize-Sichtbarkeit (docs/specs/story-specify-finalize-visibility.md AC2/AC3/AC4):
 *   - der per-Job-Status (`.../finalize/:jobId`) trägt jetzt zusätzlich `no-op`
 *     im Wertebereich (der `StorySpecifyFinalizer` erkennt read-only per
 *     Snapshot-Diff einen „durchgelaufen, aber nichts angelegt"-Lauf);
 *   - der neue projekt-keyed Read (`GET .../finalize`) liefert den ZULETZT
 *     bekannten Finalize-Job DIESES Projekts (token-/secret-frei) für das
 *     Overlay-Reopen + den Board-Hinweis;
 *   - der POST `.../finalize` registriert den Job projekt-keyed SYNCHRON mit
 *     `running` vor dem Kindprozess-Spawn (reload-fest, im `StorySpecifyFinalizer`).
 *
 * Verhältnis zu `ideaSpecifyRouter` (new-story-chat AC8 — Wiederverwendung, kein
 * Fork): dieselbe Chat-Boundary (`IdeaSpecifyChatService`, unverändert), aber
 * OHNE Idee-Karte — der Chat wird durch ein freies Start-Feld (`initialText`)
 * geseedet statt aus Titel+Notes einer Idee. Die Finalisierung nutzt den
 * `StorySpecifyFinalizer` (eigener `HeadlessFlowRunner` + eigenes
 * `ProjectJobLock`, „from scratch"-Prompt OHNE Idee-Hinweis, KEIN
 * `archiveSupersededIdea`-Netz).
 *
 * Slug-Validierung: identisches Muster zu `ideaSpecifyRouter`/`boardRouter.js`
 * (SLUG_RE, Projekt-Lookup via `boardAggregator.getIndex()`). Der Slug wird NIE
 * als Dateisystem-Pfad verwendet, nur als Werte-Vergleich gegen den
 * vertrauenswürdigen In-Memory-Index (kein Traversal möglich). Für `finalize`
 * wird der bereits vertrauenswürdige `project.repo_path` aus demselben Index als
 * `projectPath` an den `StorySpecifyFinalizer` durchgereicht.
 *
 * Audit-First-Konvention (analog `ideaSpecifyRouter`):
 *   1. Validierung (Format, Existenz, Gate) — bei Ablehnung KEIN Audit.
 *   2. Genau EIN Audit-Eintrag je akzeptiertem Turn/Job-Start.
 *   3. Erst danach der eigentliche Service-/Finalizer-Aufruf.
 *
 * Security (Floor):
 *   - Hinter AccessGuard (server.js).
 *   - Nutzer-Text (initialText/message) geht ausschliesslich über
 *     `IdeaSpecifyChatService` → STDIN an `claude -p`, NIE als argv (security/R02).
 *   - `initialText`/`message` sind längenbegrenzt (Schutz vor Riesen-Payload).
 *   - Kein PTY-/CommandService-Import — komplett getrennte Boundary.
 *   - Keine Secrets/Token/Host-Pfade in Log/Audit/Response.
 *
 * @module storySpecifyRouter
 */

import { Router } from 'express';
import { sanitizeAreaId, BoardWriterError } from './BoardWriter.js';

/** Valid slug characters: alphanumeric, dash, underscore, dot. No leading slash. */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Längenlimit für `initialText`/`message` (new-story-chat AC2/Edge-Cases —
 * Schutz vor Riesen-Payload). Grosszügig bemessen (ein Start-Feld/Chat-Turn ist
 * typischerweise wenige Sätze), aber hart begrenzt.
 */
const MAX_TEXT_LENGTH = 10_000;

/**
 * In-Memory-Store für area-Zuordnungen pro Chat-Session
 * (story-idee-bereich-zuordnung AC5) — für die Durchreichung des area-Hinweises
 * vom start zum finalize.
 * @type {Map<string, string|null>} sessionId → area-id (or null if not set)
 */
const sessionAreaMap = new Map();

/**
 * Extrahiert identity-String aus req.identity (AccessGuard-Claim) — analog
 * `ideaSpecifyRouter`/`boardRouter.js`.
 * @param {object|null} identity
 * @returns {string|null}
 */
function _resolveIdentity(identity) {
  return identity?.email ?? null;
}

/**
 * Create the story-specify router.
 *
 * @param {object} options
 * @param {import('./BoardAggregator.js').BoardAggregator} options.boardAggregator
 * @param {import('./IdeaSpecifyChatService.js').IdeaSpecifyChatService} options.chatService
 *   — DIESELBE Chat-Boundary wie idea-specify (unverändert wiederverwendet, AC8).
 * @param {import('./StorySpecifyFinalizer.js').StorySpecifyFinalizer} [options.finalizer]
 * @param {import('./AuditStore.js').AuditStore} [options.auditStore]
 * @returns {import('express').Router}
 */
export function storySpecifyRouter({ boardAggregator, chatService, finalizer, auditStore }) {
  const router = Router();

  /**
   * POST /api/board/projects/:slug/story-specify/start
   *
   * Legt eine neue serverseitige Chat-Session an und seedet sie mit dem freien
   * Start-Feld-Text (`initialText`, AC2). Die erste `reply` ist Claudes
   * Eröffnungs-Turn.
   *
   * Body: { initialText: string }
   * Response 201: { sessionId, reply }
   * Response 400: { field: 'initialText', message }  (leer/whitespace/zu lang)
   * Response 404: { error }  (Projekt unbekannt / ungültiges Slug-Format)
   * Response 502: { error }  (claude -p-Fehler, secret-frei)
   */
  router.post('/api/board/projects/:slug/story-specify/start', async (req, res) => {
    const { slug } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    if (!chatService) {
      console.error('[storySpecifyRouter] POST .../story-specify/start: chatService nicht verdrahtet');
      return res.status(500).json({ error: 'Chat konnte nicht gestartet werden.' });
    }

    const { initialText, area } = req.body ?? {};

    // Validierung VOR dem Audit-Eintrag (Audit-First-Konvention).
    if (typeof initialText !== 'string' || initialText.trim() === '') {
      return res.status(400).json({ field: 'initialText', message: 'initialText must be a non-empty string' });
    }
    if (initialText.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ field: 'initialText', message: `initialText must be at most ${MAX_TEXT_LENGTH} characters` });
    }

    // AC5: Bereichs-Validierung (story-idee-bereich-zuordnung AC5, AC6)
    let sanitizedArea = null;
    if (area != null) {
      try {
        sanitizedArea = sanitizeAreaId(area);
      } catch (err) {
        if (err instanceof BoardWriterError) {
          return res.status(400).json({ field: 'area', message: err.message });
        }
        throw err;
      }
    }

    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);
    if (!project || project.error) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    // AC6: Zusätzliche Validierung gegen board/areas.yaml (wenn area gesetzt ist)
    if (sanitizedArea) {
      const areaExists = (project.areas ?? []).some((a) => a.id === sanitizedArea);
      if (!areaExists) {
        return res.status(400).json({
          field: 'area',
          message: `Bereich '${sanitizedArea}' existiert nicht.`,
        });
      }
    }

    // Audit-First (genau EIN Eintrag je akzeptiertem Turn): schlägt record()
    // fehl, wird der claude-Aufruf NICHT gestartet.
    if (auditStore) {
      try {
        auditStore.record({
          identity: _resolveIdentity(req.identity ?? null),
          command: `board:story:specify:start:${slug}`,
        });
      } catch (auditErr) {
        console.error('[storySpecifyRouter] Audit-Write fehlgeschlagen (POST .../story-specify/start):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    // „scratch"-Seed (AC2): das freie Start-Feld seedet den ersten Turn. Der
    // `IdeaSpecifyChatService` wird UNVERÄNDERT genutzt (AC8) — der Start-Text
    // wird als Titel-Seed übergeben (buildSeedMessage), der komplette Verlauf
    // geht via stdin an `claude -p`, nie als argv.
    const result = await chatService.start({ title: initialText.trim(), repoContext: slug });

    if (!result.ok) {
      // 502 — claude -p nicht verfügbar oder Fehler (secret-frei, kein stderr-Leak)
      return res.status(502).json({ error: result.message ?? 'claude -p unavailable or failed' });
    }

    // AC5: area im sessionAreaMap speichern für später (beim finalize)
    if (sanitizedArea) {
      sessionAreaMap.set(result.sessionId, sanitizedArea);
    }

    return res.status(201).json({ sessionId: result.sessionId, reply: result.reply });
  });

  /**
   * POST /api/board/projects/:slug/story-specify/message
   *
   * Hängt die Nutzer-Nachricht an die serverseitig gehaltene Session-Historie an
   * und liefert Claudes nächsten Turn (AC3). Der Client übermittelt NUR die neue
   * Nachricht — nicht die ganze Historie.
   *
   * Body: { sessionId: string, message: string }
   * Response 200: { reply, readyToSpecify, draftText? }
   * Response 400: { field, message }  (fehlende/ungültige/zu lange sessionId/message)
   * Response 404: { error }  (Session unbekannt / ungültiges Slug-Format)
   * Response 502: { error }  (claude -p-Fehler, secret-frei)
   */
  router.post('/api/board/projects/:slug/story-specify/message', async (req, res) => {
    const { slug } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    if (!chatService) {
      console.error('[storySpecifyRouter] POST .../story-specify/message: chatService nicht verdrahtet');
      return res.status(500).json({ error: 'Nachricht konnte nicht verarbeitet werden.' });
    }

    const { sessionId, message } = req.body ?? {};

    // Validierung VOR dem Audit-Eintrag (Audit-First-Konvention).
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return res.status(400).json({ field: 'sessionId', message: 'sessionId must be a non-empty string' });
    }
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ field: 'message', message: 'message must be a non-empty string' });
    }
    if (message.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ field: 'message', message: `message must be at most ${MAX_TEXT_LENGTH} characters` });
    }

    // AC3: 404 bei unbekannter/abgelaufener Session — geprüft VOR dem Audit.
    if (!chatService.hasSession(sessionId)) {
      return res.status(404).json({ error: 'Session nicht gefunden.' });
    }

    if (auditStore) {
      try {
        auditStore.record({
          identity: _resolveIdentity(req.identity ?? null),
          command: `board:story:specify:message:${slug}`,
        });
      } catch (auditErr) {
        console.error('[storySpecifyRouter] Audit-Write fehlgeschlagen (POST .../story-specify/message):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    const result = await chatService.message({ sessionId, message });

    if (!result.ok) {
      if (result.reason === 'session-not-found') {
        // Defense-in-Depth: bereits oben via hasSession() abgefangen.
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

  /**
   * POST /api/board/projects/:slug/story-specify/finalize
   *
   * Startet den „from scratch"-Finalizer (AC4) — nur zulässig, wenn der Chat
   * zuvor `readyToSpecify` gemeldet hat (Gate, gelesen über
   * `chatService.getSessionState()`, NICHT aus dem Request-Body).
   *
   * Body: { sessionId: string }
   * Response 202: { jobId, status: 'running' }
   * Response 400: { field, message }  (fehlende sessionId ODER kein readyToSpecify)
   * Response 404: { error }  (Projekt/Session unbekannt)
   * Response 409: { error }  (Finalizer-Lock für dieses Projekt bereits belegt)
   */
  router.post('/api/board/projects/:slug/story-specify/finalize', async (req, res) => {
    const { slug } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    if (!chatService || !finalizer) {
      console.error('[storySpecifyRouter] POST .../story-specify/finalize: chatService/finalizer nicht verdrahtet');
      return res.status(500).json({ error: 'Finalisierung konnte nicht gestartet werden.' });
    }

    const { sessionId } = req.body ?? {};

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

    // AC4-Gate: kein readyToSpecify → 400 (Button im Frontend deaktiviert —
    // dieser Check schützt gegen einen dennoch abgesetzten Request).
    const sessionState = chatService.getSessionState(sessionId);
    if (!sessionState || sessionState.readyToSpecify !== true) {
      return res.status(400).json({
        field: 'readyToSpecify',
        message: 'Chat ist noch nicht bereit zur Finalisierung (readyToSpecify fehlt).',
      });
    }

    // Audit-First (genau EIN Eintrag je akzeptiertem Finalize-Start).
    if (auditStore) {
      try {
        auditStore.record({
          identity: _resolveIdentity(req.identity ?? null),
          command: `board:story:specify:finalize:${slug}`,
        });
      } catch (auditErr) {
        console.error('[storySpecifyRouter] Audit-Write fehlgeschlagen (POST .../story-specify/finalize):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    // AC3 (story-specify-finalize-visibility): der Finalizer registriert den Job
    // projekt-keyed SYNCHRON mit `running` vor dem Spawn — dafür braucht er den
    // (bereits SLUG_RE-validierten) `slug` als Registry-Schlüssel. `start()` ist
    // async (read-only Baseline-Snapshot vor dem Spawn, AC1) → hier awaiten.
    // AC5: area aus sessionAreaMap lesen (gespeichert beim start)
    const area = sessionAreaMap.get(sessionId);
    const result = await finalizer.start(project.repo_path, {
      draftText: sessionState.draftText,
      projectSlug: slug,
      area,
    });

    if (!result.ok) {
      // `locked` → projekt-weiter ProjectJobLock des Runners (AC4-Edge-Case:
      // parallele Finalize fürs selbe Projekt).
      return res.status(409).json({ error: 'Finalizer läuft bereits für dieses Projekt.' });
    }

    return res.status(202).json({ jobId: result.jobId, status: 'running' });
  });

  /**
   * GET /api/board/projects/:slug/story-specify/finalize
   *
   * Letzter bekannter Finalize-Job DIESES Projekts (projekt-keyed) — für das
   * Overlay-Reopen + den Board-Hinweis (story-specify-finalize-visibility AC4).
   * Token-frei (KEIN Agenten-Dispatch, KEINE Board-Schreibaktion, KEIN Audit),
   * secret-/token-/host-pfad-frei. Der Status wird im Finalizer LIVE aufgelöst
   * (inkl. `no-op`-Mapping), damit ein terminaler Job nicht als stale `running`
   * erscheint.
   *
   * Response 200: { job: { status: 'running'|'done'|'no-op'|'failed'|'auth-expired', jobId, error? } | null }
   * Response 404: { error }  (Projekt unbekannt / ungültiges Slug-Format)
   */
  router.get('/api/board/projects/:slug/story-specify/finalize', async (req, res) => {
    const { slug } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    if (!finalizer) {
      console.error('[storySpecifyRouter] GET .../story-specify/finalize: finalizer nicht verdrahtet');
      return res.status(500).json({ error: 'Status konnte nicht gelesen werden.' });
    }

    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);
    if (!project || project.error) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const job = await finalizer.lastForProject(slug);
    return res.status(200).json({ job });
  });

  /**
   * GET /api/board/projects/:slug/story-specify/finalize/:jobId
   *
   * Liest den Job-Status (AC2) — Format 1:1 wie der idea-specify-/Reconcile-
   * Status-Endpunkt. Der Wertebereich ist um `no-op` ergänzt (status ∈
   * {running,done,no-op,failed,auth-expired}): der `StorySpecifyFinalizer`
   * erkennt read-only per Snapshot-Diff einen „durchgelaufen, aber nichts
   * angelegt"-Lauf und mappt ihn auf `no-op` (story-specify-finalize-visibility
   * AC1/AC2). `done` ausschließlich bei tatsächlich angelegter Story.
   *
   * Response 200: { status, result?, error? }
   * Response 404: { error }  (unbekannte jobId, auch nach Server-Neustart)
   */
  router.get('/api/board/projects/:slug/story-specify/finalize/:jobId', async (req, res) => {
    if (!finalizer) {
      console.error('[storySpecifyRouter] GET .../story-specify/finalize/:jobId: finalizer nicht verdrahtet');
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
