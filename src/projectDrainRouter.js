/**
 * projectDrainRouter — Express router: manueller „Board abarbeiten"-Knopf
 * gegen die ProjectDrain-Engine (docs/specs/taktgeber-nachtwaechter.md AC12).
 *
 * Route (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/projects/:slug/drain
 *
 * AC12 — der manuelle Knopf nutzt dieselbe `ProjectDrain`-Engine (S-192):
 * draint das EINE geöffnete Projekt SOFORT (kein Nachtfenster-Gate — das
 * betrifft nur `NightWatchScheduler`/S-195 und ist hier irrelevant),
 * Parallelität 1. `ProjectDrain` garantiert intern max. einen aktiven Drain
 * je Projektpfad über `ProjectJobLock`/`isProjectBusy` (AC6/AC7) — dieser
 * Router dupliziert die Lock-Erwerbslogik NICHT, sondern liest sie nur
 * lesend vor, um sofort einen passenden HTTP-Status zu liefern.
 *
 * Fire-and-forget (Spec „Definition" — der Drain läuft wiederholte
 * /flow-Runden, bis das Board keine offene Ziel-Story mehr hat):
 *   `ProjectDrain.drainProject()` kann potenziell über viele Minuten/Stunden
 *   laufen. Der HTTP-Request wartet NICHT auf das Ende des Drains — er startet
 *   den Drain (Promise wird bewusst NICHT awaited, nur mit `.catch()`
 *   gegen unhandled rejections abgesichert) und antwortet sofort mit
 *   `202 {drainId}`. Der Fortschritt bleibt weiterhin im Projekt-Terminal
 *   sichtbar: jeder /flow-Anstoß läuft über den bestehenden
 *   `CommandService`, der unverändert in dieselbe Projekt-PTY-Session
 *   schreibt (TerminalPane/WsGateway unberührt) — kein neuer
 *   Completion-Kanal, kein Nachtwächter-UI (S-197 bleibt Nicht-Ziel dieser
 *   Story), keine Statusabfrage über `drainId` (nicht gefordert von AC12).
 *
 * Slug→Pfad-Auflösung (Muster `commandRouter.js`, security/R02/R03):
 *   Der Client sendet einen Slug (Repo-Verzeichnisname), keinen absoluten
 *   Pfad. Erst `resolveProjectSlug` (Slug-Form-Check gegen Traversal), dann
 *   `validateProjectPath` (realpath-Containment gegen `WORKSPACE_DIR`) —
 *   identischer Auflösungspfad wie beim bestehenden `POST /api/command`.
 *   `ProjectDrain` matched den resultierenden Pfad intern gegen
 *   `BoardAggregator`-Einträge (`repo_path`); in diesem Deployment ist
 *   `BOARD_ROOTS == WORKSPACE_DIR` (docker-compose.yml), beide Bäume sind
 *   identisch.
 *
 * Concurrency (AC6/AC7, Wiederverwendung S-190 — KEIN eigener Lock):
 *   `isProjectBusy()` wird NUR lesend geprüft (Lock-Status + Command-Status +
 *   Session-Existenz), um sofort `409` zurückzugeben, wenn bereits gearbeitet
 *   wird. Der tatsächliche Lock-Erwerb (atomar, ohne `await` dazwischen)
 *   passiert ausschließlich INNERHALB von `ProjectDrain.drainProject()`
 *   selbst — kein doppelter Erwerbsversuch hier. Da zwischen dem
 *   Busy-Read und dem `drainProject()`-Aufruf in dieser Funktion kein
 *   `await` liegt, ist auch dieser Router-Check TOCTOU-frei (Node
 *   Single-Thread-Event-Loop — analog der Begründung in `ProjectDrain.js`).
 *
 * Security (Floor): keine Secrets in Response/Log; Pfad-Validierung wie
 * `commandRouter.js` (realpath-Containment gegen `WORKSPACE_DIR`); kein
 * direkter Shell-/Pfad-Sink; `drainId` ist eine reine Korrelations-ID
 * (`randomUUID()`), kein Secret.
 *
 * @module projectDrainRouter
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateProjectPath, ProjectPathError, resolveProjectSlug } from './workspacePath.js';
import { isProjectBusy } from './ProjectJobLock.js';

/**
 * @param {object} deps
 * @param {import('./ProjectDrain.js').ProjectDrain} [deps.projectDrain]
 * @param {{ getStatus: () => { status: string|null } }} [deps.commandService]  für isProjectBusy (AC7)
 * @param {{ hasSession: (p: string) => boolean }} [deps.sessionRegistry]        für isProjectBusy (AC7)
 * @param {object} [options]
 * @param {(path: string) => Promise<{ resolvedPath: string }>} [options.pathValidator]
 *   Injectable path validator (default: validateProjectPath). Inject a stub in tests.
 * @param {(slug: string|null) => string|null} [options.slugResolver]
 *   Injectable slug-to-path resolver (default: resolveProjectSlug).
 * @param {import('./ProjectJobLock.js').ProjectJobLock} [options.lock]
 *   Injectable lock for isProjectBusy (default: module singleton via isProjectBusy).
 * @returns {import('express').Router}
 */
export function projectDrainRouter(deps = {}, options = {}) {
  const { projectDrain, commandService, sessionRegistry } = deps;
  const _pathValidator = options.pathValidator ?? validateProjectPath;
  const _slugResolver = options.slugResolver ?? resolveProjectSlug;
  const _lock = options.lock;
  const router = Router();

  /**
   * POST /api/projects/:slug/drain
   *
   * Responses:
   *   202 { drainId }  — Drain gestartet (läuft im Hintergrund weiter, s. Modul-Doku)
   *   400 { error }    — ungültiger Slug/Pfad
   *   409 { error }    — Projekt bereits busy (AC6/AC7) — kein Doppel-Start
   *   500 { error }    — ProjectDrain-Engine nicht verdrahtet (Composition-Root-Fehler)
   */
  router.post('/api/projects/:slug/drain', async (req, res) => {
    const identity = req.identity ?? null;
    const rawSlug = req.params.slug;

    let resolvedPath;
    try {
      const slugPath = _slugResolver(rawSlug);
      if (slugPath === null) {
        return res.status(400).json({ error: 'Invalid project slug' });
      }
      const { resolvedPath: p } = await _pathValidator(slugPath);
      resolvedPath = p;
    } catch (err) {
      const reason = err instanceof ProjectPathError ? err.message : 'Invalid project path';
      return res.status(400).json({ error: `Invalid slug: ${reason}` });
    }

    if (!projectDrain) {
      return res.status(500).json({ error: 'Drain-Engine nicht verfügbar' });
    }

    // AC6/AC7: rein lesender Busy-Check — kein await zwischen diesem Check und
    // dem drainProject()-Aufruf unten (TOCTOU-frei, s. Modul-Doku).
    const busyOpts = { commandService, sessionRegistry };
    if (_lock) busyOpts.lock = _lock;
    if (isProjectBusy(resolvedPath, busyOpts)) {
      return res.status(409).json({ error: 'Projekt wird bereits bearbeitet — Drain nicht gestartet.' });
    }

    const drainId = randomUUID();
    // Fire-and-forget (Modul-Doku "Definition"): der Drain läuft potenziell
    // lange; die HTTP-Antwort wartet nicht auf sein Ende (AC12 "sofort").
    // ProjectDrain.drainProject() erwirbt/gibt das ProjectJobLock intern
    // selbst frei (try/finally) — kein zusätzliches Lock-Handling hier nötig.
    projectDrain.drainProject(resolvedPath, { identity }).catch((err) => {
      console.error(`[projectDrain] Drain fehlgeschlagen (drainId=${drainId}):`, err.message);
    });

    return res.status(202).json({ drainId });
  });

  return router;
}
