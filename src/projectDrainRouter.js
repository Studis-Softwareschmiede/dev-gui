/**
 * projectDrainRouter — Express router: manueller „Board abarbeiten"-Knopf
 * gegen die ProjectDrain-Engine (docs/specs/headless-manual-drain.md AC1/AC2/AC3;
 * ersetzt den bislang interaktiven Pfad, taktgeber-nachtwaechter AC12 →
 * superseded durch ADR-017).
 *
 * Route (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/projects/:slug/drain  { costMode?: 'low-cost'|'balanced'|'max-quality'|'frontier' }
 *
 * HEADLESS-Ausführung (ADR-017, headless-manual-drain AC1): der manuelle Knopf
 * fährt den Drain über eine DEDIZIERTE, headless verdrahtete `ProjectDrain`-
 * Instanz (`HeadlessFlowRunnerAdapter` um eine eigene `HeadlessFlowRunner`-
 * Instanz mit eigener `ProjectJobLock`-Instanz — Verdrahtung in `server.js`).
 * Der Flow-Schritt jeder Drain-Runde ist damit ein `claude -p '/agent-flow:flow …'`-
 * Kindprozess (KEIN PTY-Write, KEIN globaler PTY-Lock). Der interaktive
 * `CommandService`-/PTY-Pfad wird für den Flow-Schritt NICHT mehr benutzt —
 * dieser Router kennt den Ausführungspfad aber gar nicht: er reicht nur den
 * injizierten `projectDrain` an. Dieselbe Router-Logik bliebe daher auch mit
 * einer interaktiv verdrahteten `ProjectDrain`-Instanz korrekt.
 *
 * KEIN Live-Terminal (headless-manual-drain AC1/Restrisiko): ein headless-Drain
 * schreibt NICHT in die interaktive PTY-Session — es erscheint keine
 * Live-Ausgabe im Terminal-Pane. Fortschritt/Ergebnis werden über den
 * Board-Re-Fetch (Karten-Updates) + das Audit-Log sichtbar; der Drain-Job-
 * Status über `drainId` (`GET …/drain/:drainId`) ist eine SEPARATE Story
 * (headless-manual-drain AC4) und hier NICHT gebaut — die POST-Route liefert
 * `drainId` bereits als Korrelations-ID zurück.
 *
 * Cost-Mode (headless-manual-drain AC3): der Endpunkt akzeptiert optional
 * `{ costMode }` (Enum `low-cost|balanced|max-quality|frontier`, geteilt mit
 * flow-trigger AC8 via `COST_MODES` aus `CommandService.js` — NICHT dupliziert).
 * Validierung ist serverseitig autoritativ: ein ungültiger Modus → `400`, KEIN
 * Drain-Start. `balanced` (Default) bzw. fehlend → KEIN Flag; `low-cost|
 * max-quality|frontier` → `['--cost', <mode>]` wird als per-Drain-`args` an
 * `projectDrain.drainProject({ args })` durchgereicht und gilt für ALLE
 * Flow-Runden dieses Drains. Der Runner reicht das Arg nur durch — die
 * Modell-Auflösung liegt in agent-flow (flow-trigger AC8/AC9).
 *
 * Fire-and-forget (der Drain läuft wiederholte /flow-Runden, bis das Board
 * keine offene Ziel-Story mehr hat):
 *   `ProjectDrain.drainProject()` kann potenziell über viele Minuten/Stunden
 *   laufen. Der HTTP-Request wartet NICHT auf das Ende des Drains — er startet
 *   den Drain (Promise wird bewusst NICHT awaited, nur mit `.catch()`
 *   gegen unhandled rejections abgesichert) und antwortet sofort mit
 *   `202 {drainId}`.
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
 * Concurrency (headless-manual-drain AC2 — KEIN eigener Lock-Erwerb hier):
 *   `isProjectBusy()` wird NUR lesend geprüft (Lock-Status + Command-Status +
 *   Session-Existenz), um sofort `409` zurückzugeben, wenn bereits gearbeitet
 *   wird — ein zweiter manueller Drain fürs selbe Projekt startet so nicht
 *   doppelt. Der geprüfte `lock` MUSS dieselbe `ProjectJobLock`-Instanz sein,
 *   die die dedizierte manuelle `ProjectDrain`-Instanz als Session-Lock hält
 *   (via `options.lock` injiziert, `server.js`) — sonst würde der Busy-Read
 *   den laufenden manuellen Drain nicht sehen. Der tatsächliche Lock-Erwerb
 *   (atomar, ohne `await` dazwischen) passiert ausschließlich INNERHALB von
 *   `ProjectDrain.drainProject()` selbst. Da zwischen dem Busy-Read und dem
 *   `drainProject()`-Aufruf in dieser Funktion kein `await` liegt, ist auch
 *   dieser Router-Check TOCTOU-frei (Node Single-Thread-Event-Loop).
 *
 * Security (Floor): keine Secrets in Response/Log; Pfad-Validierung wie
 * `commandRouter.js` (realpath-Containment gegen `WORKSPACE_DIR`); kein
 * direkter Shell-/Pfad-Sink; `costMode` gegen das feste Enum validiert (keine
 * Weiterreichung eines beliebigen argv-Werts); `drainId` ist eine reine
 * Korrelations-ID (`randomUUID()`), kein Secret.
 *
 * @module projectDrainRouter
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateProjectPath, ProjectPathError, resolveProjectSlug } from './workspacePath.js';
import { isProjectBusy } from './ProjectJobLock.js';
import { COST_MODES } from './CommandService.js';

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
   * POST /api/projects/:slug/drain  { costMode?: 'low-cost'|'balanced'|'max-quality'|'frontier' }
   *
   * Responses:
   *   202 { drainId }  — Drain gestartet (headless, läuft im Hintergrund weiter, s. Modul-Doku)
   *   400 { error }    — ungültiger Slug/Pfad ODER ungültiger costMode (AC3)
   *   409 { error }    — Projekt bereits busy (AC2) — kein Doppel-Start
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

    // AC3: optionaler Cost-Mode → serverseitig autoritativ gegen das feste Enum
    // validiert (geteilt mit flow-trigger AC8). `balanced`/fehlend → KEIN Flag;
    // sonst `['--cost', <mode>]` als per-Drain-args. Ungültig → 400, KEIN Start.
    const rawCostMode = req.body?.costMode;
    let drainArgs = [];
    if (rawCostMode !== undefined && rawCostMode !== null && rawCostMode !== '') {
      if (typeof rawCostMode !== 'string' || !COST_MODES.includes(rawCostMode)) {
        return res.status(400).json({ error: 'Invalid costMode' });
      }
      if (rawCostMode !== 'balanced') {
        drainArgs = ['--cost', rawCostMode];
      }
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
    // Fire-and-forget (Modul-Doku): der Drain läuft potenziell lange; die
    // HTTP-Antwort wartet nicht auf sein Ende. ProjectDrain.drainProject()
    // erwirbt/gibt das ProjectJobLock intern selbst frei (try/finally) — kein
    // zusätzliches Lock-Handling hier nötig. `args` (AC3): Cost-Mode-Flag,
    // gilt für ALLE Flow-Runden dieses Drains.
    projectDrain.drainProject(resolvedPath, { identity, args: drainArgs }).catch((err) => {
      console.error(`[projectDrain] Drain fehlgeschlagen (drainId=${drainId}):`, err.message);
    });

    return res.status(202).json({ drainId });
  });

  return router;
}
