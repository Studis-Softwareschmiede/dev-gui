/**
 * projectDrainRouter — Express router: manueller „Board abarbeiten"-Knopf
 * gegen die ProjectDrain-Engine (docs/specs/headless-manual-drain.md AC1/AC2/AC3/AC4;
 * ersetzt den bislang interaktiven Pfad, taktgeber-nachtwaechter AC12 →
 * superseded durch ADR-017).
 *
 * Routes (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/projects/:slug/drain            { costMode?: 'low-cost'|'balanced'|'max-quality'|'frontier' }
 *   GET  /api/projects/:slug/drain/:drainId   → Drain-Job-Status (AC4)
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
 * Board-Re-Fetch (Karten-Updates) + das Audit-Log sichtbar; zusätzlich über den
 * Drain-Job-Status (AC4): jeder gestartete Drain wird unter seiner `drainId` in
 * einer In-Memory-`DrainJobRegistry` geführt (`running`→`done`|`failed`);
 * `GET /api/projects/:slug/drain/:drainId` liest den Status (secret-/pfad-frei,
 * Format analog zum headless-Reconcile-Status). So sieht der Owner „läuft /
 * fertig / fehlgeschlagen" trotz fehlender Live-Ausgabe.
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
 * Cost-Mode-Frische-Prüfung beim Dispatch (cost-mode-model-check AC4/AC5):
 *   Unmittelbar bei der Cost-Mode-Übergabe an den Drain stößt der Endpunkt —
 *   sofern `costModeModelCheck` injiziert ist — dieselbe leichtgewichtige
 *   Frische-Prüfung an wie Boot/periodisch (S-211, `CostModeModelCheck.runCheck`).
 *   NICHT-BLOCKIEREND (AC5): der Drain wird VOR der Prüfung fire-and-forget
 *   gestartet — die Prüfung läuft danach und blockiert den Drain-Start nie; der
 *   Curator-Anstoß in `runCheck` ist ohnehin asynchron/best-effort (eigene
 *   Runner-/Lock-Instanz). Erkennt die Prüfung Drift, liefert sie eine `checkId`,
 *   die als optionales Feld `costModeCheckId` in die `202`-Antwort gereicht wird —
 *   das Frontend pollt damit `GET /api/cost-mode/check/:checkId` und zeigt die
 *   nicht-modale „Modell veraltet"-Meldung + Vorher/Nachher-Übersicht. Kein Drift
 *   / bereits laufender Curator (`skipped`) / fehlende Boundary → KEIN Feld
 *   (Frontend zeigt dann keine Meldung — stiller Normalfall, AC2-Analogon). Ein
 *   Fehler in der Prüfung darf die `202`-Antwort NIE verhindern (best-effort).
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
import { DrainJobRegistry } from './DrainJobRegistry.js';

/**
 * @param {object} deps
 * @param {import('./ProjectDrain.js').ProjectDrain} [deps.projectDrain]
 * @param {{ getStatus: () => { status: string|null } }} [deps.commandService]  für isProjectBusy (AC7)
 * @param {{ hasSession: (p: string) => boolean }} [deps.sessionRegistry]        für isProjectBusy (AC7)
 * @param {{ runCheck: (trigger?: string) => Promise<{ drift: boolean, checkId?: string }> }} [deps.costModeModelCheck]
 *   Cost-Mode-Frische-Prüfung beim Dispatch (cost-mode-model-check AC4/AC5,
 *   Wiederverwendung der S-211-Boundary). Optional — ohne sie läuft der Drain
 *   unverändert (kein `costModeCheckId` in der Antwort).
 * @param {object} [options]
 * @param {(path: string) => Promise<{ resolvedPath: string }>} [options.pathValidator]
 *   Injectable path validator (default: validateProjectPath). Inject a stub in tests.
 * @param {(slug: string|null) => string|null} [options.slugResolver]
 *   Injectable slug-to-path resolver (default: resolveProjectSlug).
 * @param {import('./ProjectJobLock.js').ProjectJobLock} [options.lock]
 *   Injectable lock for isProjectBusy (default: module singleton via isProjectBusy).
 * @param {import('./DrainJobRegistry.js').DrainJobRegistry} [options.jobRegistry]
 *   Injectable Drain-Job-Status-Registry (AC4). Default: eine eigene, router-
 *   interne In-Memory-Instanz — POST und GET teilen dieselbe Instanz.
 * @returns {import('express').Router}
 */
export function projectDrainRouter(deps = {}, options = {}) {
  const { projectDrain, commandService, sessionRegistry, costModeModelCheck } = deps;
  const _pathValidator = options.pathValidator ?? validateProjectPath;
  const _slugResolver = options.slugResolver ?? resolveProjectSlug;
  const _lock = options.lock;
  const _jobRegistry = options.jobRegistry ?? new DrainJobRegistry();
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
    // AC4: Drain sofort als `running` in der Job-Registry führen — noch VOR dem
    // fire-and-forget-Start, damit ein direkt danach eintreffender
    // `GET …/drain/:drainId` den Job garantiert sieht (kein Registrierungs-Race).
    _jobRegistry.register(drainId);

    // Fire-and-forget (Modul-Doku): der Drain läuft potenziell lange; die
    // HTTP-Antwort wartet nicht auf sein Ende. ProjectDrain.drainProject()
    // erwirbt/gibt das ProjectJobLock intern selbst frei (try/finally) — kein
    // zusätzliches Lock-Handling hier nötig. `args` (AC3): Cost-Mode-Flag,
    // gilt für ALLE Flow-Runden dieses Drains. Der Ausgang aktualisiert den
    // Registry-Status (AC4): resolved → `done` (mit secret-freier
    // Ergebnis-Zusammenfassung), rejected → `failed` (generischer Text; die
    // konkrete Fehlermeldung bleibt im Server-Log, nie in der Response).
    projectDrain.drainProject(resolvedPath, { identity, args: drainArgs })
      .then((result) => {
        _jobRegistry.markDone(drainId, result ?? {});
      })
      .catch((err) => {
        _jobRegistry.markFailed(drainId);
        console.error(`[projectDrain] Drain fehlgeschlagen (drainId=${drainId}):`, err.message);
      });

    // AC4/AC5 (cost-mode-model-check): Dispatch-Frische-Prüfung NACH dem bereits
    // (fire-and-forget) gestarteten Drain — der Drain läuft schon, die Prüfung
    // blockiert seinen Start nie (AC5). Bei erkanntem Drift liefert `runCheck`
    // eine `checkId`, die als optionales `costModeCheckId` in die 202-Antwort
    // wandert (Frontend pollt darüber den Status-Endpunkt). Kein Drift / bereits
    // laufender Curator (`skipped`, keine checkId) / fehlende Boundary → kein
    // Feld. Best-effort: ein Fehler hier darf die 202-Antwort nie verhindern.
    const body = { drainId };
    if (costModeModelCheck && typeof costModeModelCheck.runCheck === 'function') {
      try {
        const check = await costModeModelCheck.runCheck('dispatch');
        if (check && check.drift === true && typeof check.checkId === 'string' && check.checkId) {
          body.costModeCheckId = check.checkId;
        }
      } catch {
        // best-effort — die Frische-Prüfung ist rein additiv (AC5); kein Einfluss
        // auf den bereits gestarteten Drain und keine 202-Verhinderung.
      }
    }

    return res.status(202).json(body);
  });

  /**
   * GET /api/projects/:slug/drain/:drainId — Drain-Job-Status (AC4).
   *
   * Der Slug wird wie bei POST validiert (400 bei Traversal/Boundary), dient
   * hier aber nur der Konsistenz/Härtung — die `drainId` ist eine globale
   * Korrelations-ID; die Registry ist NICHT pro Slug partitioniert
   * (headless-manual-drain Verträge: 400 ungültiger Slug | 404 drainId
   * unbekannt).
   *
   * Responses:
   *   200 { status: 'running'|'done'|'failed', result?, error? }  — secret-/pfad-frei
   *   400 { error }  — ungültiger Slug/Pfad
   *   404 { error }  — unbekannte drainId (auch nach Server-Neustart, In-Memory)
   */
  router.get('/api/projects/:slug/drain/:drainId', async (req, res) => {
    try {
      const slugPath = _slugResolver(req.params.slug);
      if (slugPath === null) {
        return res.status(400).json({ error: 'Invalid project slug' });
      }
      await _pathValidator(slugPath);
    } catch (err) {
      const reason = err instanceof ProjectPathError ? err.message : 'Invalid project path';
      return res.status(400).json({ error: `Invalid slug: ${reason}` });
    }

    const job = _jobRegistry.getJob(req.params.drainId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown drainId' });
    }

    const body = { status: job.status };
    if (job.result !== undefined) body.result = job.result;
    if (job.error !== undefined) body.error = job.error;

    return res.status(200).json(body);
  });

  return router;
}
