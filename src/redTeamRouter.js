/**
 * redTeamRouter — Express router für den Headless-Red-Team-Runner
 * (docs/specs/red-team-tile.md AC2, AC3, AC4, AC5, AC10).
 *
 * Routes (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   GET  /api/red-team/targets  — Allowlist-Schnittmenge (VPS-laufend ∩ eigenes Repo)
 *   POST /api/red-team          — startet einen Red-Team-Job (nur für Allowlist-Ziele)
 *   GET  /api/red-team/:jobId   — liefert den aktuellen Job-Status
 *
 * Getrennt vom interaktiven PTY-Pfad — nutzt ausschliesslich den
 * `HeadlessRedTeamRunner`, keinen `CommandService`/`PtyManager`-Import
 * (Muster `reconcileRouter.js`).
 *
 * Allowlist (konstruktiv erzwungen, kein Freitext-Ziel, security/R04 Default-deny):
 * Zulässige Ziele = Schnittmenge aus „läuft als Container auf einem konfigurierten
 * VPS" (`vpsDockerControl.psAll`, `state === 'running'`) ∩ „ist ein eigenes Repo im
 * Workspace" (`workspaceScanner.listClones()`). Der `GET /targets`-Endpunkt liefert
 * genau diese Schnittmenge; der `POST`-Start prüft die Auswahl **erneut** gegen
 * dieselbe Berechnung (Defense in Depth) — ein Ziel ausserhalb → 403, kein Lauf.
 *
 * Slug→Pfad-Auflösung (Muster `reconcileRouter.js`, security/R02/R03): Der Client
 * sendet einen Slug (Repo-Verzeichnisname), keinen absoluten Pfad. Erst
 * `resolveProjectSlug` (Slug-Form-Check gegen Traversal), dann `validateProjectPath`
 * (realpath-Containment gegen `WORKSPACE_DIR`).
 *
 * Security (Floor, AC10): keine Secrets/absolute Host-Pfade in Response/Log; `jobId`
 * ist eine reine Korrelations-ID (`randomUUID()` im Runner), kein Secret; das
 * Allowlist-Gate greift serverseitig (nicht nur UI).
 *
 * @module redTeamRouter
 */

import { Router } from 'express';
import { validateProjectPath, resolveProjectSlug } from './workspacePath.js';

const VALID_MODUS = new Set(['durch-cloudflare', 'direkt', 'beide']);
const DEFAULT_MODUS = 'direkt';

/**
 * Leitet den Image-Repo-Namen aus einer Container-Image-Referenz ab:
 * letztes Pfadsegment ohne Registry-Präfix und ohne `:tag`/`@digest`.
 *
 * Beispiele:
 *   ghcr.io/org/dev-gui:sha        → dev-gui
 *   ghcr.io/org/dev-gui@sha256:ab… → dev-gui
 *   localhost:5000/foo/bar:latest  → bar
 *   dev-gui                        → dev-gui
 *
 * @param {string} image
 * @returns {string} Repo-Name (leer bei leerer/ungültiger Eingabe)
 */
export function imageRepoName(image) {
  if (typeof image !== 'string' || image.trim() === '') return '';
  // Digest abschneiden (@sha256:…), dann letztes '/'-Segment, dann Tag (:…) entfernen.
  const noDigest = image.split('@')[0];
  const lastSeg = noDigest.split('/').pop() ?? '';
  return lastSeg.split(':')[0];
}

/**
 * Enumeriert die konfigurierten VPS-SSH-Ziele aus dynamischer Quelle
 * (`vpsRegistry.listTargetRecords()`) + Env-Quelle (`vpsTargets`-Map),
 * dedupliziert nach host:port:targetUser.
 *
 * @param {object} deps
 * @returns {Promise<Array<{ host: string, port: number, targetUser: string }>>}
 */
async function listVpsTargets({ vpsRegistry, vpsTargets } = {}) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (!t || !t.host) return;
    const key = `${t.host}:${t.port ?? 22}:${t.targetUser ?? 'root'}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ host: t.host, port: t.port ?? 22, targetUser: t.targetUser ?? 'root' });
  };

  if (vpsRegistry && typeof vpsRegistry.listTargetRecords === 'function') {
    try {
      const records = await vpsRegistry.listTargetRecords();
      for (const r of records ?? []) push(r);
    } catch {
      // Degradierend — dynamische Quelle nicht kritisch, Env-Quelle bleibt.
    }
  }
  if (vpsTargets && typeof vpsTargets.values === 'function') {
    for (const t of vpsTargets.values()) push(t);
  }
  return out;
}

/**
 * Berechnet die Allowlist-Schnittmenge (VPS-laufend ∩ eigenes Repo).
 *
 * Robust: ein fehlschlagendes `psAll` eines einzelnen Ziels wird übersprungen
 * (kippt nicht den ganzen Endpunkt); ein Fehler von `listClones` ergibt eine
 * leere Repo-Liste. Leere Schnittmenge ist gültig.
 *
 * @param {object} deps { vpsDockerControl, vpsRegistry, vpsTargets, workspaceScanner }
 * @returns {Promise<Array<{ slug: string, image: string, state: string, repo: string, originUrl: string|null, edgeUrl: string|null }>>}
 *   `originUrl`/`edgeUrl` sind server-intern (POST-only) und werden nie an den Client geleakt.
 */
async function computeAllowlist(deps = {}) {
  const { vpsDockerControl, workspaceScanner } = deps;

  // (1) laufende Container über alle konfigurierten VPS-Ziele sammeln.
  const runningContainers = [];
  if (vpsDockerControl && typeof vpsDockerControl.psAll === 'function') {
    const targets = await listVpsTargets(deps);
    for (const target of targets) {
      let result;
      try {
        result = await vpsDockerControl.psAll(target);
      } catch {
        continue; // Ein fehlschlagendes Ziel darf den Endpunkt nicht kippen.
      }
      if (!result || result.result !== 'ok') continue;
      for (const c of result.containers ?? []) {
        if (c && c.state === 'running') runningContainers.push({ ...c, _vpsHost: target.host });
      }
    }
  }

  // (3) eigene Repos im Workspace holen.
  let clones = [];
  if (workspaceScanner && typeof workspaceScanner.listClones === 'function') {
    try {
      clones = (await workspaceScanner.listClones()) ?? [];
    } catch {
      clones = [];
    }
  }

  // (4) Schnittmenge: Repo-name (ci) == laufender-Container-Image-Repo ODER hostname.
  const targets = [];
  for (const repo of clones) {
    const name = repo && typeof repo.name === 'string' ? repo.name : '';
    if (!name) continue;
    const nameLc = name.toLowerCase();
    const match = runningContainers.find((c) => {
      const repoName = imageRepoName(c.image).toLowerCase();
      const hostname = typeof c.hostname === 'string' ? c.hostname.toLowerCase() : '';
      return repoName === nameLc || hostname === nameLc;
    });
    if (match) {
      // Origin-URL nur bilden, wenn Host UND Port auflösbar sind (Guard-Voraussetzung
      // im POST, AC12/AC13). edgeUrl (öffentliche/Cloudflare-URL) in dieser Iteration null.
      // Host-Whitespace-Härtung: ein (fehlkonfigurierter) Host mit Leerzeichen würde den
      // Leerzeichen-Guard des Runners als TypeError auslösen → hier lieber originUrl=null
      // (→ sauberer 409 statt Express-500).
      const hostOk = typeof match._vpsHost === 'string'
        && match._vpsHost.trim() !== ''
        && !/\s/.test(match._vpsHost);
      const originUrl = (hostOk && match.hostPort != null)
        ? ('http://' + match._vpsHost + ':' + match.hostPort)
        : null;
      targets.push({ slug: name, image: match.image, state: match.state, repo: name, originUrl, edgeUrl: null });
    }
  }
  return targets;
}

/**
 * @param {import('./HeadlessRedTeamRunner.js').HeadlessRedTeamRunner} runner
 * @param {{
 *   vpsDockerControl?: import('./deploy/VpsDockerControl.js').VpsDockerControl,
 *   vpsRegistry?: import('./vps/VpsProviderRegistry.js').VpsProviderRegistry,
 *   vpsTargets?: Map<string, { host: string, port?: number, targetUser: string }>,
 *   workspaceScanner?: import('./WorkspaceScanner.js').WorkspaceScanner,
 * }} [deps]
 *   Boundaries für die Allowlist-Berechnung (AC2/AC3).
 * @param {object} [options]
 * @param {(path: string) => Promise<{ resolvedPath: string }>} [options.pathValidator]
 *   Injectable path validator (default: validateProjectPath). Inject a stub in tests.
 * @param {(slug: string|null, deps?: object) => string|null} [options.slugResolver]
 *   Injectable slug-to-path resolver (default: resolveProjectSlug).
 * @returns {import('express').Router}
 */
export function redTeamRouter(runner, deps = {}, options = {}) {
  const _pathValidator = options.pathValidator ?? validateProjectPath;
  const _slugResolver = options.slugResolver ?? resolveProjectSlug;
  const router = Router();

  /**
   * GET /api/red-team/targets
   * → 200 { targets: [{ slug, image, state, repo }] }  (leere Liste gültig, AC2/AC8)
   */
  router.get('/api/red-team/targets', async (_req, res) => {
    // Fail-closed + kein Stack-Leak (AC10): ein Fehler bei der Ermittlung ⇒ leere
    // Allowlist (nichts autorisiert), nie ein 500 mit internem Detail an den Client.
    let targets;
    try {
      targets = await computeAllowlist(deps);
    } catch {
      targets = [];
    }
    // originUrl/edgeUrl bleiben server-intern (POST-only) — nie an den Client leaken (AC12/AC13).
    const publicTargets = targets.map((t) => ({ slug: t.slug, image: t.image, state: t.state, repo: t.repo }));
    return res.status(200).json({ targets: publicTargets });
  });

  /**
   * POST /api/red-team
   * Body: { projectSlug: string, modus?: "durch-cloudflare"|"direkt"|"beide" }
   *
   * Responses:
   *   202 { jobId, status: "running" }
   *   400 { error }  — fehlender/ungültiger/Traversal-Slug
   *   403 { error }  — projectSlug nicht in der Allowlist-Schnittmenge (Default deny)
   *   409 { error }  — Projekt-Sperre (bereits ein laufender Red-Team-Job)
   */
  router.post('/api/red-team', async (req, res) => {
    const { projectSlug, modus } = req.body ?? {};

    // (a) kein/leerer projectSlug → 400 (der Headless-Runner ist stets projektgebunden).
    if (typeof projectSlug !== 'string' || projectSlug.trim() === '') {
      return res.status(400).json({ error: 'projectSlug is required' });
    }

    // (b) Allowlist-Gate (serverseitig, Defense in Depth, security/R04): das Ziel
    // muss in derselben Schnittmenge liegen, die GET /targets liefert — sonst 403.
    // computeAllowlist explizit gekapselt (fail-closed): ein Fehler bei der Ermittlung
    // ⇒ 403, kein Start, kein Stack-Leak an den Client (AC10).
    let allowlist;
    try {
      allowlist = await computeAllowlist(deps);
    } catch {
      return res.status(403).json({ error: 'projectSlug is not an authorized red-team target' });
    }
    const slugLc = projectSlug.trim().toLowerCase();
    const matched = allowlist.find((t) => t.slug.toLowerCase() === slugLc);
    if (!matched) {
      return res.status(403).json({ error: 'projectSlug is not an authorized red-team target' });
    }
    // Ab hier ausschliesslich den KANONISCHEN Allowlist-Slug verwenden (VPS ∩ Repo-geprüft) —
    // keine Case-/Whitespace-Drift des Client-Werts in die Pfad-Auflösung oder den claude -p-Prompt.
    const canonicalSlug = matched.slug;

    // (c) Slug→Pfad-Auflösung + Boundary-Containment (Traversal/ungültig → 400).
    // Fehlertext bleibt PFAD-FREI (AC10 — keine absoluten Host-Pfade/WORKSPACE_DIR in der Response).
    let resolvedPath;
    try {
      const slugPath = _slugResolver(canonicalSlug);
      if (slugPath === null) {
        return res.status(400).json({ error: 'Invalid projectSlug' });
      }
      const { resolvedPath: p } = await _pathValidator(slugPath);
      resolvedPath = p;
    } catch {
      return res.status(400).json({ error: 'Invalid projectSlug' });
    }

    // (d) modus validieren — nur bekannte Werte, sonst Default `direkt`.
    const resolvedModus = VALID_MODUS.has(modus) ? modus : DEFAULT_MODUS;

    // (d2) Guard: Modi mit Origin-Ziel (`direkt`/`beide`) brauchen eine auflösbare
    // Origin-URL. Fehlt sie (VPS-Host/Port nicht ableitbar) → 409, kein stiller Fehllauf.
    // (`durch-cloudflare` braucht die Origin-URL nicht; edgeUrl in dieser Iteration null.)
    if ((resolvedModus === 'direkt' || resolvedModus === 'beide') && matched.originUrl == null) {
      return res.status(409).json({ error: 'Ziel-URL nicht auflösbar (VPS-Host/Port fehlt) — Lauf nicht gestartet' });
    }

    // (d3) Guard: Modi mit Edge-/Cloudflare-Ziel (`durch-cloudflare`/`beide`) brauchen eine
    // öffentliche Edge-URL. Sie wird in dieser Iteration nicht aufgelöst (edgeUrl null) →
    // symmetrischer 409 statt stillem No-Target-Lauf; nur `direkt` ist derzeit scharf lauffähig.
    if ((resolvedModus === 'durch-cloudflare' || resolvedModus === 'beide') && matched.edgeUrl == null) {
      return res.status(409).json({ error: "Cloudflare-/Edge-URL für dieses Ziel nicht verfügbar — bitte Modus 'direkt' verwenden" });
    }

    // (e) Runner starten — argv als Array im Runner (kein Shell-String, R03).
    const result = runner.start(resolvedPath, {
      ziel: canonicalSlug,
      modus: resolvedModus,
      url: matched.originUrl,
      urlEdge: matched.edgeUrl,
    });
    if (!result.ok) {
      // Aktuell einzige Ablehnungs-Ursache: 'locked'.
      return res.status(409).json({ error: 'Red-team already running for this project' });
    }

    return res.status(202).json({ jobId: result.jobId, status: 'running' });
  });

  /**
   * GET /api/red-team/:jobId
   * → 200 { status, result?, error?, prHint? }; 404 { error } bei unbekannter jobId.
   */
  router.get('/api/red-team/:jobId', (req, res) => {
    const job = runner.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown jobId' });
    }

    const body = { status: job.status };
    if (job.result !== undefined) body.result = job.result;
    if (job.error !== undefined) body.error = job.error;
    if (job.prHint !== undefined) body.prHint = job.prHint;

    return res.status(200).json(body);
  });

  return router;
}
