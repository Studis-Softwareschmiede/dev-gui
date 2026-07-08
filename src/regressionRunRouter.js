/**
 * regressionRunRouter — Express-Router für den deterministischen
 * Regressionstest-Ausführen-Runner (docs/specs/regression-run.md AC1, AC2,
 * AC3, AC5, AC7, AC8, AC9).
 *
 * Frisch-Ausrollen & Selbsttest (AC7, AC8, S-310): `freshRollout` (Body) wird
 * 1:1 an `runner.start()` durchgereicht — die eigentliche Rollout-/
 * Selbsttest-Logik lebt vollständig im `RegressionRunner` (kein zweiter
 * Entscheidungsort für den Selbsttest-Skip).
 *
 * Routes (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/projects/:slug/regression-run             — startet einen Regressionslauf
 *   GET  /api/projects/:slug/regression-run/:runId       — Lauf-Status
 *
 * Getrennt vom interaktiven PTY-Pfad UND von allen `claude -p`-Runnern — nutzt
 * ausschließlich `RegressionRunner` (eigene `ProjectJobLock`-Instanz, KEIN
 * `claude`-Kindprozess, Grep-prüfbar).
 *
 * Slug→Pfad-Auflösung (Muster `projectDrainRouter.js`/`regressionDefineRouter.js`,
 * security/R02/R03): Client sendet einen Slug, keinen absoluten Pfad. Erst
 * `resolveProjectSlug` (Slug-Form-Check gegen Traversal), dann
 * `validateProjectPath` (realpath-Containment gegen `WORKSPACE_DIR`).
 *
 * Access/Rolle (AC3): Mutation (`POST`) ist zusätzlich identitäts-/
 * rollengeschützt (`CRED_ADMIN_EMAILS`-Linie, gleiche Logik wie
 * `deploymentsRouter`/`vpsContainerRouter`, ADR-007) — 403 ohne Berechtigung.
 * `GET` (Status lesen) ist NICHT rollengeschützt (read-only, analog
 * `regressionDefineRouter`/`projectDrainRouter` GET-Routen).
 *
 * Busy-Check (AC2): startet nur, wenn (a) kein Drain (manuell/Nacht) UND kein
 * anderer Regressionslauf desselben Projekts aktiv ist — `isProjectBusy()`
 * gegen den Drain-/Session-/Command-Status GEPRÜFT MIT dem
 * `RegressionRunner`-EIGENEN Lock als `lock`-Override (ein bereits laufender
 * Regressionslauf desselben Projekts wird so ebenfalls als busy erkannt,
 * OHNE dass ein Drain-Lock existieren muss). TOCTOU-frei: kein `await`
 * zwischen dem Busy-Read und `runner.start()`.
 *
 * Audit-First (AC3): genau EIN Audit-Eintrag je akzeptiertem Lauf-Start
 * (Identität aus `req.identity`) — VOR `runner.start()`. Schlägt der
 * Audit-Write fehl, wird der Lauf NICHT gestartet. Ende-/Fehler-Audit
 * schreibt der `RegressionRunner` selbst.
 *
 * Security (Floor): keine Secrets in Response/Log; `runId` ist eine reine
 * Korrelations-ID (`randomUUID()` im Runner), kein Secret.
 *
 * @module regressionRunRouter
 */

import { Router } from 'express';
import { validateProjectPath, ProjectPathError, resolveProjectSlug } from './workspacePath.js';
import { isProjectBusy } from './ProjectJobLock.js';
import { validateScope } from './RegressionRunner.js';

/**
 * Prüft ob die anfragende Identität mutieren darf (`CRED_ADMIN_EMAILS`-Logik,
 * AC3, identische Logik wie `deploymentsRouter`/`vpsContainerRouter`, ADR-007).
 * Ist `CRED_ADMIN_EMAILS` nicht gesetzt, ist jede authentifizierte Identität
 * zugelassen (Access-Guard bleibt die einzige Schranke — Fail-Open für
 * unkonfigurierte Deployments, wie bei den Schwester-Routern).
 *
 * @param {object|null} identity - `req.identity` (AccessGuard-Claim)
 * @returns {{ allowed: boolean }}
 */
function checkMutationAuthz(identity) {
  const adminEmails = process.env.CRED_ADMIN_EMAILS;
  if (!adminEmails || !adminEmails.trim()) {
    return { allowed: true };
  }
  const allowed = adminEmails
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const email = (identity?.email ?? '').toLowerCase();
  if (!email || !allowed.includes(email)) {
    return { allowed: false };
  }
  return { allowed: true };
}

/**
 * Extrahiert den identity-String aus `req.identity` (AccessGuard-Claim) —
 * analog `regressionDefineRouter`/`projectDrainRouter`.
 * @param {object|null} identity
 * @returns {string|null}
 */
function _resolveIdentity(identity) {
  return identity?.email ?? null;
}

/**
 * @param {import('./RegressionRunner.js').RegressionRunner} runner
 * @param {object} [options]
 * @param {(path: string) => Promise<{ resolvedPath: string }>} [options.pathValidator]
 *   Injectable path validator (default: validateProjectPath). Inject a stub in tests.
 * @param {(slug: string|null) => string|null} [options.slugResolver]
 *   Injectable slug-to-path resolver (default: resolveProjectSlug).
 * @param {import('./AuditStore.js').AuditStore} [options.auditStore] - optional (AC3).
 * @param {{ getStatus: () => { status: string|null } }} [options.commandService]  für isProjectBusy (AC2)
 * @param {{ hasSession: (p: string) => boolean }} [options.sessionRegistry]        für isProjectBusy (AC2)
 * @param {import('./ProjectJobLock.js').ProjectJobLock} [options.drainLock]
 *   Injectable Drain-Lock für isProjectBusy (default: module singleton `projectJobLock`).
 * @returns {import('express').Router}
 */
export function regressionRunRouter(runner, options = {}) {
  const _pathValidator = options.pathValidator ?? validateProjectPath;
  const _slugResolver = options.slugResolver ?? resolveProjectSlug;
  const _auditStore = options.auditStore ?? null;
  const _commandService = options.commandService;
  const _sessionRegistry = options.sessionRegistry;
  const _drainLock = options.drainLock;
  const router = Router();

  /**
   * Löst + validiert den Projekt-Slug auf (s. Modul-Kommentar).
   *
   * @param {string} rawSlug
   * @returns {Promise<{ ok: true, resolvedPath: string } | { ok: false, status: number, error: string }>}
   */
  async function resolveSlug(rawSlug) {
    try {
      const slugPath = _slugResolver(rawSlug);
      if (slugPath === null) {
        return { ok: false, status: 400, error: 'Invalid project slug' };
      }
      const { resolvedPath } = await _pathValidator(slugPath);
      return { ok: true, resolvedPath };
    } catch (err) {
      const reason = err instanceof ProjectPathError ? err.message : 'Invalid project path';
      return { ok: false, status: 400, error: `Invalid slug: ${reason}` };
    }
  }

  /**
   * POST /api/projects/:slug/regression-run
   * Body: { scope: { typ: "bereich"|"verbund"|"gesamt", id?: string }, freshRollout?: boolean }
   *
   * `freshRollout` (AC7, S-310, Default serverseitig `false` — der Dialog
   * schickt explizit `true`, wenn die UI-Option "Neustes Image vor dem Lauf
   * ausrollen" aktiv ist, Default AN im Dialog selbst): wird 1:1 an
   * `runner.start()` durchgereicht. Der Runner selbst erzwingt den
   * Selbsttest-Skip (AC8, dev-gui) — server-seitig, unabhängig vom hier
   * übergebenen Wert (Edge-Case „Selbsttest mit aktivierter Option via
   * direktem API-Aufruf").
   *
   * Responses:
   *   202 { runId, status: "running" }
   *   400 { error }  — ungültiger Slug/Pfad ODER ungültiges `scope`
   *   403 { error }  — keine Berechtigung (AC3)
   *   409 { error: "busy" }  — Drain/Lauf desselben Projekts aktiv (AC2)
   *   500 { error }  — Audit-Write fehlgeschlagen (Aktion abgebrochen) ODER Runner nicht verdrahtet
   */
  router.post('/api/projects/:slug/regression-run', async (req, res) => {
    const identity = req.identity ?? null;

    // AC3: Identitäts-/Rollenschutz.
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const rawSlug = req.params.slug;
    const resolved = await resolveSlug(rawSlug);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error });
    }

    const { scope, freshRollout } = req.body ?? {};
    const validated = validateScope(scope);
    if (!validated.ok) {
      return res.status(400).json({ error: 'Invalid scope: erwartet { typ: "bereich"|"verbund"|"gesamt", id? }' });
    }

    if (!runner) {
      return res.status(500).json({ error: 'Regressions-Runner nicht verfügbar' });
    }

    // AC2: Busy-Check — kein Drain (manuell/Nacht) UND kein anderer
    // Regressionslauf desselben Projekts aktiv. `lock`-Override auf das
    // RUNNER-EIGENE ProjectJobLock erkennt zusätzlich einen bereits laufenden
    // Regressionslauf desselben Projekts (kein Doppel-Start). Kein `await`
    // zwischen diesem Check und `runner.start()` unten (TOCTOU-frei).
    const busyOpts = { commandService: _commandService, sessionRegistry: _sessionRegistry };
    if (_drainLock) busyOpts.lock = _drainLock;
    if (isProjectBusy(resolved.resolvedPath, busyOpts) || runner.isRunning(resolved.resolvedPath)) {
      return res.status(409).json({ error: 'busy' });
    }

    // Audit-First (genau EIN Eintrag je akzeptiertem Lauf-Start, AC3): schlägt
    // record() fehl, wird der Runner NICHT gestartet.
    const identityStr = _resolveIdentity(identity);
    if (_auditStore) {
      try {
        _auditStore.record({ identity: identityStr, command: `regression-run:start:${rawSlug}` });
      } catch (auditErr) {
        console.error('[regressionRunRouter] Audit-Write fehlgeschlagen (start):', auditErr.message);
        return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
      }
    }

    const result = runner.start(resolved.resolvedPath, rawSlug, validated.scope, {
      identity: identityStr,
      freshRollout: Boolean(freshRollout),
    });
    if (!result.ok) {
      // Aktuell einzige Ablehnungs-Ursache: 'locked' (Race zwischen Busy-Check
      // und start(), extrem selten dank TOCTOU-Freiheit oben).
      return res.status(409).json({ error: 'busy' });
    }

    return res.status(202).json({ runId: result.runId, status: 'running' });
  });

  /**
   * GET /api/projects/:slug/regression-run/:runId
   *
   * Responses:
   *   200 { status, target?, suite, counts?, durationMs?, reason? }  — secret-frei
   *   400 { error }  — ungültiger Slug/Pfad
   *   404 { error }  — unbekannte runId
   */
  router.get('/api/projects/:slug/regression-run/:runId', async (req, res) => {
    const resolved = await resolveSlug(req.params.slug);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error });
    }

    if (!runner) {
      return res.status(404).json({ error: 'Unknown runId' });
    }

    const run = runner.getRun(req.params.runId);
    if (!run) {
      return res.status(404).json({ error: 'Unknown runId' });
    }

    return res.status(200).json(run);
  });

  return router;
}
