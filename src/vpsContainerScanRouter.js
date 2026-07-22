/**
 * vpsContainerScanRouter — Pro-Container Red-Team-Scan-Endpunkt.
 *
 * Implements: docs/specs/red-team-scan-per-container.md AC1, AC2, AC3, AC4, AC5, AC6, AC7,
 * AC8, AC9, AC16, AC17, AC22.
 *
 * Routes (hinter AccessGuard, s. server.js):
 *   POST /api/vps/machines/:provider/*splat/containers/:containerId/scan
 *     → 202 { jobId, status:'running' }
 *     → 409 { errorClass:'scan-in-progress' }   — bereits ein laufender Scan für DIESEN Container
 *     → 422 { errorClass:'not-scannable' }       — nicht managed, nicht laufend, Ziel/Repo nicht auflösbar
 *     → 400 { error }                             — ungültige Route (provider/serverId/containerId)
 *   GET  /api/vps/machines/:provider/*splat/containers/:containerId/scan/:jobId
 *     → 200 { status, phase, ampel?, findings?, reportRef? }
 *     → 404 { error }                             — unbekannte jobId (auch: jobId gehört zu einem
 *                                                    ANDEREN Container — kein Cross-Container-Leak)
 *   GET  /api/vps/machines/:provider/*splat/containers/:containerId/scans   (AC8, S-402)
 *     → 200 { scans: [{ scanId, startedAt, ampel, findingCount, boardItemIds }] }
 *       (neueste zuerst, ohne Rohbericht-Volltext; nicht auflösbarer Container/kein Store
 *       → 200 { scans: [] }, best-effort/non-fatal — kein zweiter Fehlercode für einen
 *       read-only Verlauf-Endpunkt)
 *     → 400 { error }                             — ungültige Route (provider/serverId/containerId)
 *   GET  /api/vps/machines/:provider/*splat/scans/:scanId                  (AC8, S-402)
 *     → 200 { scan: { scanId, app, startedAt, finishedAt, ampel, findings, findingCount,
 *              reportRef, boardItemIds } }
 *     → 404 { error }                             — unbekannte scanId
 *     → 400 { error }                             — ungültige Route (provider/serverId)
 *   POST /api/vps/machines/:provider/*splat/scans/:scanId/board             (AC16/AC17, S-405)
 *     Body: { findingIds: string[] }
 *     → 200 { created:[{findingId,boardId}], skipped:[{findingId,boardId}] }
 *       — legt GENAU die ausgewählten (noch nicht übertragenen) Befunde als
 *       neue Board-Items an (BoardWriter.createIdea(), `status: Idee`); ein
 *       bereits übertragener Befund (Finding trägt bereits `boardId`) wird
 *       NICHT erneut angelegt, sondern als `skipped` mit der bestehenden
 *       Board-ID gemeldet (Idempotenz, AC16/AC20). Unbekannte `findingIds`
 *       (kein Treffer in `scan.findings`) werden still ignoriert (kein
 *       Erfinden von Findings). Entstandene Board-IDs werden best-effort in
 *       den Store zurückgeschrieben (AC17, `scanResultStore.recordBoardTransfer()`).
 *     → 400 { error }                             — `findingIds` leer/kein Array
 *     → 404 { error }                             — unbekannte scanId (kein Store/kein Treffer)
 *     → 422 { errorClass:'not-scannable' }         — Scan hat keinen `repoSlug`
 *       (der Workspace-Repo-Slug, der Board-Items zugeordnet werden — s.
 *       `ScanResultStore.js` Moduldoku "Präzisierung") ODER kein `boardWriter`
 *       verdrahtet — NUR wenn tatsächlich neue Items angelegt werden müssten
 *       (reine Idempotenz-Treffer brauchen keinen `repoSlug`).
 *
 * Kein neuer Runner (AC1): dieser Router dockt den **bestehenden** `HeadlessRedTeamRunner`
 * (F-090/F-091, unverändert) an — Runner-Semantik (eigene `ProjectJobLock`-Instanz, `close`-
 * Event als einzige Fertig-Quelle, Runaway-Timeout, secret-freies Audit, argv-Array,
 * `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block) bleibt unangetastet.
 *
 * Container-/VPS-Target-Auflösung: wiederverwendet `resolveVpsTarget` +
 * `validateProvider`/`validateContainerId`/`extractServerId` aus `vpsContainerRouter.js` —
 * keine zweite Wahrheit für Provider-/ServerId-/ContainerId-Form-Checks (AC6).
 *
 * Ziel-Confinement (AC4, sicherheitskritisch): die beiden Scan-Ziele werden AUSSCHLIESSLICH
 * server-seitig aus dem aufgelösten `ContainerEntry` + VPS-Target gebaut:
 *   - direkt   = `http://<vpsTarget.host>:<container.hostPort>`
 *   - öffentlich = `https://<container.hostname>`
 * Es gibt KEIN Freitext-URL-Feld und KEINEN URL-Request-Parameter — weder `req.body` noch
 * `req.query` werden für die Ziel-Bildung an irgendeiner Stelle gelesen (Default-deny durch
 * Konstruktion, nicht durch nachträgliches Filtern eines Client-Werts).
 *
 * cwd-Auflösung (Spawn-Verzeichnis des `claude -p`-Kindprozesses): der Container wird über
 * `imageRepoName(container.image)` bzw. `container.hostname` auf einen Workspace-Klon
 * gemappt (identische Matching-Logik wie `redTeamRouter.js#computeAllowlist` — der
 * kachel-Vorgänger dieses Features, hier NICHT abgebaut, s. S-408). Kein Match → 422
 * not-scannable (der Server kann ohne aufgelöstes cwd keinen Lauf starten). Die Wahl von
 * cwd = Repo-Verzeichnis (statt eines generischen Workspace-Roots) ist bewusst: sie gibt
 * jedem Container/Repo ein EIGENES `ProjectJobLock`-Schlüssel-Verzeichnis, sodass ein
 * laufender Scan für Container A einen parallelen Scan für Container B (anderes Repo)
 * NICHT blockiert (AC5 — zwei unabhängige Testorte/Container, kein Cross-Blocking über
 * einen geteilten cwd).
 *
 * Job-Registrierung (AC2/AC3): der Runner selbst kennt nur eine globale, jobId-keyed
 * In-Memory-Registry ohne Container-Bezug. Dieser Router hält zusätzlich eine In-Memory-
 * Map `containerKey → jobId` (letzter gestarteter Scan je Container), um (a) "läuft
 * bereits ein Scan für DIESEN Container" (AC2/409) präzise zu erkennen (nicht nur über
 * den gröberen Repo-Level-Lock des Runners) und (b) die jobId↔containerId-Bindung für den
 * Status-Poll (AC3) zu prüfen. Geht bei Server-Neustart verloren (kein Ziel: persistente
 * Job-Historie, s. Spec-Edge-Case "Server-Neustart während Lauf").
 *
 * scanResultStore (S-402, AC7/AC8/AC9): dieselbe Boundary, mit zwei Zwecken — (a) am
 * Status-Poll (AC3) weiterhin NUR defensiv/best-effort verdrahtet: `ampel`/`findings`/
 * `reportRef` werden nachgeladen, sofern ein echter Store existiert und einen Treffer
 * liefert; ohne Store (oder bei einem Store-Fehler) bleiben diese Felder schlicht abwesend
 * (laut AC3-Contract optional); (b) für die Verlauf-Lese-Endpunkte (AC8) ist der Store die
 * primäre Datenquelle — `list(app)` (kompakte Historie je Container/App, "app" =
 * `container.hostname`) und `getByScanId(scanId)`/`getByJobId(jobId)` (Detail). Fehlt der
 * Store oder liefert er einen Fehler, antworten auch diese Endpunkte best-effort (leere
 * Liste bzw. 404) statt zu crashen (Robustheit-NFR).
 *
 * **Offene Folge-Naht (S-403 Review-Fund, Iteration 2 — bewusst NICHT in diesem Router
 * geschlossen):** der ursprüngliche Plan war, `scanResultStore.record()` am Status-Poll
 * bei `status:'done'` mit `findings: []` aufzurufen. Das wurde verworfen: der wieder-
 * verwendete `HeadlessRedTeamRunner`/`HeadlessRunnerCore` legt die erfasste stdout/stderr-
 * Ausgabe NICHT im Job-Objekt ab (nur `status`/`result`/`error`/`prHint`) — ein Findings-
 * Parser aus dem Runner-Output ist mit dem heutigen Core-Vertrag NICHT baubar. Ein
 * `record()` mit hartkodiert leeren `findings` hätte für JEDEN abgeschlossenen Lauf
 * dauerhaft `ampel:'gruen'` ("keine Befunde") persistiert — für ein Sicherheitswerkzeug
 * eine aktiv irreführende "alles sicher"-Aussage, unabhängig vom tatsächlichen Lauf-
 * Ergebnis, und macht den gesamten Verlauf (S-402/S-404) wertlos. Der Status-Endpunkt
 * liefert deshalb weiterhin NUR `status`/`phase`/`reportRef?` ohne Ampel-/Findings-
 * Behauptung, bis eine echte Findings-Extraktion existiert (Core müsste die erfasste
 * Ausgabe im Job-Objekt exponieren + ein Parser-Vertrag für `/agent-flow:red-team`-Output
 * definiert werden — Folge-Story). `reportRef` bleibt trotzdem ohne Store nutzbar: fällt
 * mangels Store-Treffer auf den vom Runner bereits extrahierten `job.prHint` zurück (s.
 * unten, AC12-Bericht-Link funktioniert unabhängig von der offenen Findings-Naht).
 *
 * Security (Floor, AC22): keine Secrets/Tokens/absolute Host-Pfade in Response/Log; `jobId`
 * ist eine reine Korrelations-ID (`randomUUID()` im Runner); argv bleibt Array (kein Shell-
 * Interpolation, s. Runner); Confinement server-seitig (s.o.); `ANTHROPIC_API_KEY`/
 * `OPENAI_API_KEY`-Block kommt aus `HeadlessRunnerCore` (unverändert).
 *
 * @module vpsContainerScanRouter
 */

import { Router } from 'express';
import {
  resolveVpsTarget,
  validateProvider,
  validateContainerId,
  extractServerId,
} from './vpsContainerRouter.js';
import { imageRepoName } from './redTeamRouter.js';
import { validateProjectPath, resolveProjectSlug } from './workspacePath.js';
import { BoardWriterError, IDEA_TITLE_MAX_LENGTH } from './BoardWriter.js';

/**
 * Baut den zusammengesetzten Container-Schlüssel. containerId allein ist über mehrere
 * Provider/VPS-Server hinweg nicht eindeutig — daher composite über provider+serverId+containerId.
 *
 * @param {string} provider
 * @param {string} serverId
 * @param {string} containerId
 * @returns {string}
 */
function containerKey(provider, serverId, containerId) {
  return `${provider}::${serverId}::${containerId}`;
}

/**
 * Bildet den internen Runner-Status auf den nach AC3 zulässigen Status-Enum ab
 * ({running, done, failed, auth-expired}). `budget-limited` (headless-budget-limit-detection,
 * ein Core-Status eines anderen Runner-Nutzers) wird hier defensiv auf `failed` gemappt —
 * der Vertrag dieser Story kennt nur die vier genannten Werte (Spec-Präzisierung s. §AC3).
 *
 * @param {string} coreStatus
 * @returns {'running'|'done'|'failed'|'auth-expired'}
 */
function mapStatus(coreStatus) {
  if (coreStatus === 'running' || coreStatus === 'done' || coreStatus === 'auth-expired') {
    return coreStatus;
  }
  return 'failed';
}

/**
 * Ermittelt den Workspace-Repo-Slug für einen Container: Match über den Image-Repo-Namen
 * ODER den Hostname gegen `workspaceScanner.listClones()` (identische Logik wie
 * `redTeamRouter.js#computeAllowlist`).
 *
 * @param {{ image: string, hostname: string|null }} container
 * @param {{ listClones?: () => Promise<Array<{name:string}>> }} [workspaceScanner]
 * @returns {Promise<string|null>}
 */
async function resolveRepoSlug(container, workspaceScanner) {
  if (!workspaceScanner || typeof workspaceScanner.listClones !== 'function') return null;
  let clones;
  try {
    clones = (await workspaceScanner.listClones()) ?? [];
  } catch {
    return null;
  }
  const imageRepoLc = imageRepoName(container.image).toLowerCase();
  const hostnameLc = typeof container.hostname === 'string' ? container.hostname.toLowerCase() : '';
  for (const repo of clones) {
    const name = repo && typeof repo.name === 'string' ? repo.name : '';
    if (!name) continue;
    const nameLc = name.toLowerCase();
    if (nameLc === imageRepoLc || (hostnameLc && nameLc === hostnameLc)) {
      return name;
    }
  }
  return null;
}

/**
 * Baut den Board-Item-Titel für einen übertragenen Befund (AC16) — gekappt auf
 * `IDEA_TITLE_MAX_LENGTH` (defensiv, `BoardWriter.createIdea()` würde einen zu
 * langen Titel sonst mit `invalid-title` ablehnen).
 *
 * @param {{ id: string, kind: string, titel: string }} finding
 * @returns {string}
 */
function _findingBoardTitle(finding) {
  const label = finding.titel || finding.kind || finding.id;
  return `Red-Team-Befund: ${label}`.slice(0, IDEA_TITLE_MAX_LENGTH);
}

/**
 * Baut den Board-Item-Body für einen übertragenen Befund (AC16) — Details +
 * betroffene App/URL + Referenz auf den Scan (Nutzer-Kontext für die neue Story).
 *
 * @param {{ severity: string, kind: string, testort: string }} finding
 * @param {{ app: string, scanId: string, reportRef: string|null }} scan
 * @returns {string}
 */
function _findingBoardBody(finding, scan) {
  const lines = [
    `Schweregrad: ${finding.severity}`,
    `Art: ${finding.kind || '–'}`,
    `Testort: ${finding.testort}`,
    `Betroffene App: ${scan.app}`,
    `Scan-Referenz: ${scan.scanId}`,
  ];
  if (scan.reportRef) lines.push(`Bericht: ${scan.reportRef}`);
  return lines.join('\n');
}

/**
 * @param {import('./HeadlessRedTeamRunner.js').HeadlessRedTeamRunner} runner
 * @param {{
 *   vpsDockerControl?: import('./deploy/VpsDockerControl.js').VpsDockerControl,
 *   vpsRegistry?: import('./vps/VpsProviderRegistry.js').VpsProviderRegistry,
 *   vpsTargets?: Map<string, { host: string, port?: number, targetUser: string }>,
 *   workspaceScanner?: import('./WorkspaceScanner.js').WorkspaceScanner,
 *   scanResultStore?: {
 *     getByJobId?: (jobId:string) => Promise<object|null>,
 *     getByScanId?: (scanId:string) => Promise<object|null>,
 *     recordBoardTransfer?: (input: { scanId:string, transfers: Array<{findingId:string,boardId:string}> }) => Promise<object|null>,
 *   },
 *   boardWriter?: import('./BoardWriter.js').BoardWriter,
 * }} [deps]
 * @param {object} [options]
 * @param {(path: string) => Promise<{ resolvedPath: string }>} [options.pathValidator]
 *   Injectable path validator (default: validateProjectPath). Inject a stub in tests.
 * @param {(slug: string|null, deps?: object) => string|null} [options.slugResolver]
 *   Injectable slug-to-path resolver (default: resolveProjectSlug).
 * @returns {import('express').Router}
 */
export function vpsContainerScanRouter(runner, deps = {}, options = {}) {
  const { vpsDockerControl, vpsRegistry, vpsTargets, workspaceScanner, scanResultStore, boardWriter } = deps;
  const _pathValidator = options.pathValidator ?? validateProjectPath;
  const _slugResolver = options.slugResolver ?? resolveProjectSlug;
  const router = Router();

  /** containerKey → jobId (letzter gestarteter Scan je Container). */
  const activeJobs = new Map();
  /** jobId → containerKey (Rückbindung für den Status-Poll, AC3). */
  const jobContainer = new Map();

  // ── POST .../containers/:containerId/scan ───────────────────────────────────

  router.post('/api/vps/machines/:provider/*splat/containers/:containerId/scan', async (req, res) => {
    const providerVal = validateProvider(req.params.provider);
    if (!providerVal.ok) {
      return res.status(400).json({ error: providerVal.error });
    }
    const provider = req.params.provider;

    const serverIdResult = extractServerId(req.params.splat);
    if (!serverIdResult.ok) {
      return res.status(400).json({ error: serverIdResult.error });
    }
    const serverId = serverIdResult.serverId;

    const containerIdVal = validateContainerId(req.params.containerId);
    if (!containerIdVal.ok) {
      return res.status(400).json({ error: containerIdVal.error });
    }
    const containerId = req.params.containerId.trim();

    const key = containerKey(provider, serverId, containerId);

    // AC2 — bereits laufender Scan für DIESEN Container → 409 (Default-deny, kein Doppel-Lauf).
    // Blocking-Bedingung wird aus DERSELBEN Quelle wie der GET-Statuspoll (mapStatus()) abgeleitet
    // — keine zweite, unabhängig gepflegte Terminal-Status-Menge, die vom Core-Enum wegdriften
    // kann (Review-Fix: `budget-limited` fehlte in einer vorherigen separaten Menge und hielt den
    // Container fälschlich dauerhaft gesperrt, obwohl der ProjectJobLock längst frei war).
    const existingJobId = activeJobs.get(key);
    if (existingJobId) {
      const existingJob = runner.getJob(existingJobId);
      if (existingJob && mapStatus(existingJob.status) === 'running') {
        return res.status(409).json({ errorClass: 'scan-in-progress' });
      }
    }

    const vpsTarget = await resolveVpsTarget(provider, serverId, vpsRegistry, vpsTargets);
    if (!vpsTarget) {
      return res.status(422).json({ errorClass: 'not-scannable' });
    }

    let psResult;
    try {
      psResult = await vpsDockerControl.psAll(vpsTarget);
    } catch {
      return res.status(422).json({ errorClass: 'not-scannable' });
    }
    if (!psResult || psResult.result !== 'ok') {
      return res.status(422).json({ errorClass: 'not-scannable' });
    }

    const container = (psResult.containers ?? []).find((c) => c.containerId === containerId);
    if (!container) {
      return res.status(422).json({ errorClass: 'not-scannable' });
    }

    // AC2 — nur managed (hostname !== null) + laufend (state === 'running').
    if (container.hostname == null || container.state !== 'running') {
      return res.status(422).json({ errorClass: 'not-scannable' });
    }

    // AC4 — Ziele AUSSCHLIESSLICH server-seitig aus VPS-Target + ContainerEntry ableiten.
    // Kein req.body/req.query-Zugriff für die Ziel-Bildung an dieser oder jeder anderen
    // Stelle dieses Handlers — ein mitgesendeter URL-Wert wird konstruktiv nie gelesen.
    const hostOk = typeof vpsTarget.host === 'string' && vpsTarget.host.trim() !== '' && !/\s/.test(vpsTarget.host);
    if (!hostOk || container.hostPort == null) {
      return res.status(422).json({ errorClass: 'not-scannable' });
    }
    const directUrl = `http://${vpsTarget.host}:${container.hostPort}`;
    const publicUrl = `https://${container.hostname}`;

    // cwd: Container → Workspace-Repo-Slug (AC1/AC5 — eigener Lock-Schlüssel je Repo/Container).
    const repoSlug = await resolveRepoSlug(container, workspaceScanner);
    if (!repoSlug) {
      return res.status(422).json({ errorClass: 'not-scannable' });
    }
    let resolvedPath;
    try {
      const slugPath = _slugResolver(repoSlug);
      if (slugPath === null) {
        return res.status(422).json({ errorClass: 'not-scannable' });
      }
      const { resolvedPath: p } = await _pathValidator(slugPath);
      resolvedPath = p;
    } catch {
      return res.status(422).json({ errorClass: 'not-scannable' });
    }

    // AC1/AC5 — Runner starten: ziel/modus/url/url_edge server-seitig gesetzt, argv-Array
    // im Runner (kein Shell-String, security/R03). modus ist immer 'beide' (zwei Testorte,
    // ein Lauf — kein Client-Override, AC5).
    const result = runner.start(resolvedPath, {
      ziel: repoSlug,
      modus: 'beide',
      url: directUrl,
      urlEdge: publicUrl,
    });
    if (!result.ok) {
      // Aktuell einzige Ablehnungs-Ursache: 'locked' (Runner-eigener Repo-Level-Lock).
      return res.status(409).json({ errorClass: 'scan-in-progress' });
    }

    activeJobs.set(key, result.jobId);
    jobContainer.set(result.jobId, key);

    return res.status(202).json({ jobId: result.jobId, status: 'running' });
  });

  // ── GET .../containers/:containerId/scan/:jobId ─────────────────────────────

  router.get('/api/vps/machines/:provider/*splat/containers/:containerId/scan/:jobId', async (req, res) => {
    const provider = req.params.provider;
    const rawServerId = Array.isArray(req.params.splat) ? req.params.splat.join('/') : String(req.params.splat ?? '');
    const serverId = rawServerId.trim();
    const containerId = String(req.params.containerId ?? '').trim();
    const { jobId } = req.params;

    const key = containerKey(provider, serverId, containerId);

    // 404 sowohl bei unbekannter jobId als auch wenn die jobId zu einem ANDEREN Container
    // gehört (kein Cross-Container-Leak über eine erratene/kopierte jobId).
    if (jobContainer.get(jobId) !== key) {
      return res.status(404).json({ error: 'Unknown jobId' });
    }

    const job = runner.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown jobId' });
    }

    const status = mapStatus(job.status);
    // AC3 — phase: der wiederverwendete Runner ist ein opaker Kindprozess ohne Zwischen-
    // Fortschritts-Signal (nur `close` als Fertig-Quelle, s. HeadlessRunnerCore). Coarse
    // Mapping laut Spec-Präzisierung: 'direkt' während des Laufs, 'fertig' im Terminalzustand.
    const phase = status === 'running' ? 'direkt' : 'fertig';
    const body = { status, phase };

    // scanResultStore (S-402, defensiv/best-effort, AC6): ampel/findings/reportRef nur wenn
    // ein echter Store existiert UND einen Eintrag zu dieser jobId liefert. Ein Store-Fehler
    // darf den Status-Poll nie crashen lassen (NFR Robustheit). Kein record()-Aufruf hier
    // (Review-Fund S-403 Iteration 2, s. Moduldoku oben) — solange keine echte Findings-
    // Extraktion existiert, bleiben ampel/findings ohne Store-Treffer bewusst abwesend
    // (kein irreführendes "gruen").
    if (scanResultStore && typeof scanResultStore.getByJobId === 'function') {
      try {
        const stored = await scanResultStore.getByJobId(jobId);
        if (stored) {
          if (stored.ampel !== undefined) body.ampel = stored.ampel;
          if (stored.findings !== undefined) body.findings = stored.findings;
          if (stored.reportRef !== undefined) body.reportRef = stored.reportRef;
        }
      } catch {
        // best-effort — kein Crash, Felder bleiben abwesend (optional laut AC3-Contract).
      }
    }

    // AC12-Bericht-Link bleibt auch OHNE Store/Findings-Naht nutzbar: fällt bei sauberem
    // Abschluss (status:'done') mangels Store-Treffer auf den vom Runner bereits
    // extrahierten PR-/Protokoll-Hinweis zurück (Review-Fund S-403 Iteration 2 — der
    // Bericht-Link darf nicht an der offenen Findings-Naht hängen). Auf `done` begrenzt
    // — konsistent mit ampel/findings, die ebenfalls nur bei sauberem Abschluss eine
    // Aussage treffen (der Core setzt `prHint` ohnehin nur im `done`-Pfad, s.
    // `HeadlessRunnerCore`, dies ist Defense in Depth für die Response-Form).
    if (status === 'done' && body.reportRef === undefined && typeof job.prHint === 'string' && job.prHint) {
      body.reportRef = job.prHint;
    }

    return res.status(200).json(body);
  });

  // ── GET .../containers/:containerId/scans (AC8, S-402) ───────────────────────

  router.get('/api/vps/machines/:provider/*splat/containers/:containerId/scans', async (req, res) => {
    const providerVal = validateProvider(req.params.provider);
    if (!providerVal.ok) {
      return res.status(400).json({ error: providerVal.error });
    }
    const provider = req.params.provider;

    const serverIdResult = extractServerId(req.params.splat);
    if (!serverIdResult.ok) {
      return res.status(400).json({ error: serverIdResult.error });
    }
    const serverId = serverIdResult.serverId;

    const containerIdVal = validateContainerId(req.params.containerId);
    if (!containerIdVal.ok) {
      return res.status(400).json({ error: containerIdVal.error });
    }
    const containerId = req.params.containerId.trim();

    // Read-only Verlauf-Endpunkt (AC8): jede Auflösungs-Lücke (kein Store, kein VPS-Ziel,
    // Container nicht (mehr) gefunden, unmanaged Container ohne hostname, Store-Fehler)
    // führt best-effort auf eine LEERE Liste — kein zweiter Fehlercode neben dem bereits
    // etablierten 400 (ungültige Route). Robustheit-NFR: ein Verlauf-Abruf darf nie crashen.
    if (!scanResultStore || typeof scanResultStore.list !== 'function') {
      return res.status(200).json({ scans: [] });
    }

    const vpsTarget = await resolveVpsTarget(provider, serverId, vpsRegistry, vpsTargets);
    if (!vpsTarget) {
      return res.status(200).json({ scans: [] });
    }

    let psResult;
    try {
      psResult = await vpsDockerControl.psAll(vpsTarget);
    } catch {
      return res.status(200).json({ scans: [] });
    }
    const container = (psResult?.containers ?? []).find((c) => c.containerId === containerId);
    if (!container || !container.hostname) {
      return res.status(200).json({ scans: [] });
    }

    try {
      const scans = await scanResultStore.list(container.hostname);
      return res.status(200).json({ scans });
    } catch {
      return res.status(200).json({ scans: [] });
    }
  });

  // ── GET .../scans/:scanId (AC8, S-402) — Detail, containerId-unabhängig (scanId ist ─────
  // ── bereits global eindeutig, s. ScanResultStore) ────────────────────────────────────────

  router.get('/api/vps/machines/:provider/*splat/scans/:scanId', async (req, res) => {
    const providerVal = validateProvider(req.params.provider);
    if (!providerVal.ok) {
      return res.status(400).json({ error: providerVal.error });
    }

    const serverIdResult = extractServerId(req.params.splat);
    if (!serverIdResult.ok) {
      return res.status(400).json({ error: serverIdResult.error });
    }

    const { scanId } = req.params;

    if (!scanResultStore || typeof scanResultStore.getByScanId !== 'function') {
      return res.status(404).json({ error: 'Unknown scanId' });
    }

    let scan;
    try {
      scan = await scanResultStore.getByScanId(scanId);
    } catch {
      return res.status(404).json({ error: 'Unknown scanId' });
    }
    if (!scan) {
      return res.status(404).json({ error: 'Unknown scanId' });
    }

    return res.status(200).json({ scan });
  });

  // ── POST .../scans/:scanId/board (AC16/AC17, S-405) — Befunde → Board ────────

  router.post('/api/vps/machines/:provider/*splat/scans/:scanId/board', async (req, res) => {
    const providerVal = validateProvider(req.params.provider);
    if (!providerVal.ok) {
      return res.status(400).json({ error: providerVal.error });
    }

    const serverIdResult = extractServerId(req.params.splat);
    if (!serverIdResult.ok) {
      return res.status(400).json({ error: serverIdResult.error });
    }

    const { scanId } = req.params;

    // AC16 — leere/ungültige Auswahl → 400 (kein Auto-Anlegen, s. Nicht-Ziele).
    const rawFindingIds = req.body?.findingIds;
    const findingIds = Array.isArray(rawFindingIds)
      ? rawFindingIds.filter((x) => typeof x === 'string' && x)
      : [];
    if (findingIds.length === 0) {
      return res.status(400).json({ error: 'findingIds darf nicht leer sein' });
    }

    if (!scanResultStore || typeof scanResultStore.getByScanId !== 'function') {
      return res.status(404).json({ error: 'Unknown scanId' });
    }

    let scan;
    try {
      scan = await scanResultStore.getByScanId(scanId);
    } catch {
      return res.status(404).json({ error: 'Unknown scanId' });
    }
    if (!scan) {
      return res.status(404).json({ error: 'Unknown scanId' });
    }

    // Nur tatsächlich in DIESEM Scan vorhandene Befunde verarbeiten (kein
    // Erfinden von Findings, s. Nicht-Ziele) — unbekannte findingIds werden
    // still ignoriert (weder created noch skipped).
    const findingsById = new Map(scan.findings.map((f) => [f.id, f]));
    const requested = findingIds.map((id) => findingsById.get(id)).filter(Boolean);

    const created = [];
    const skipped = [];
    const toCreate = [];
    for (const finding of requested) {
      if (finding.boardId) {
        // AC16/AC20 — Idempotenz: bereits übertragen, nicht erneut anlegen.
        skipped.push({ findingId: finding.id, boardId: finding.boardId });
      } else {
        toCreate.push(finding);
      }
    }

    if (toCreate.length > 0) {
      // AC16 — projectSlug: der zum Scan-Zeitpunkt ermittelte Workspace-Repo-Slug
      // (s. ScanResultStore.js Moduldoku "Präzisierung"). Fehlt er (älterer/
      // unvollständiger Eintrag) oder ist kein boardWriter verdrahtet, können
      // NEUE Befunde keinem Board zugeordnet werden — reine Idempotenz-Treffer
      // oben brauchen das nicht und wurden bereits berechnet.
      if (!scan.repoSlug || !boardWriter) {
        return res.status(422).json({ errorClass: 'not-scannable' });
      }

      for (const finding of toCreate) {
        let storyId;
        try {
          const result = await boardWriter.createIdea({
            projectSlug: scan.repoSlug,
            title: _findingBoardTitle(finding),
            body: _findingBoardBody(finding, scan),
          });
          storyId = result.storyId;
        } catch (err) {
          // best-effort (analog BoardWriter.archiveDoneFeatures()): ein
          // fehlgeschlagener Einzel-Transfer bricht die übrigen nicht ab, kein
          // Secret/Pfad im Log (AC22).
          console.warn(
            `vpsContainerScanRouter: Board-Übertrag für Befund '${finding.id}' fehlgeschlagen ` +
              `(${err instanceof BoardWriterError ? err.errorClass : 'unbekannter Fehler'})`,
          );
          continue;
        }
        created.push({ findingId: finding.id, boardId: storyId });
      }

      // AC17 — Board-IDs best-effort zurückschreiben (Grundlage für AC15/AC20).
      // Ein Schreibfehler hier darf die Response nicht kippen — die Board-Items
      // sind zu diesem Zeitpunkt bereits real angelegt (Robustheit-NFR).
      if (created.length > 0 && typeof scanResultStore.recordBoardTransfer === 'function') {
        try {
          await scanResultStore.recordBoardTransfer({
            scanId,
            transfers: created.map((c) => ({ findingId: c.findingId, boardId: c.boardId })),
          });
        } catch {
          // best-effort — s.o.
        }
      }
    }

    return res.status(200).json({ created, skipped });
  });

  return router;
}
