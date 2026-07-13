/**
 * newProjectHeadlessRouter — Express router für die headless Anlage-Auslöser
 * der Fabrik-Übersicht (docs/specs/per-app-gpg-passphrase-provisioning.md
 * AC12–AC15, ADR-021 in docs/architecture.md; F-073/S-343).
 *
 * Routes (hinter dem globalen `/api`-AccessGuard, server.js):
 *   POST /api/new-project/start   — { app } → startet den headless
 *     `/agent-flow:new-project <app>`-Scaffold + im Erfolgsfall GENAU EINMAL
 *     die per-App-GPG-Passphrasen-Auto-Provisionierung, via
 *     `HeadlessNewProjectRunner#runWithAutoProvisioning` (AC13/AC15 — die
 *     EINZIGE aufzurufende Naht, s. `HeadlessNewProjectRunner.js`-Modul-Header
 *     + F-073-Handoff-Notiz S-336). Fire-and-forget aus HTTP-Sicht: die
 *     Antwort wartet NICHT auf den vollständigen (potenziell minutenlangen)
 *     Scaffold-Lauf — Audit/Ergebnis-Introspektion liegen bereits in
 *     `HeadlessNewProjectRunner`/`PerAppGpgProvisioningService` (AC9, secret-
 *     frei); ein zusätzlicher Job-Status-Poll-Endpunkt ist in dieser Story
 *     nicht angefordert (coder/R01 — kein Gold-Plating).
 *   POST /api/adopt/start         — { ownerRepo } → startet den headless
 *     `/agent-flow:adopt <ownerRepo>`-Lauf via `HeadlessAdoptRunner`
 *     (AC12/AC14). **Keine** Auto-Provisionierungs-Kopplung — `/adopt` hat
 *     keinen deterministischen GE4-Zeitpunkt (Skill §2g: „.env.gpg optional,
 *     kein GE4-Zwang"); adoptierte Apps nutzen den bestehenden Nach-
 *     Provisionierungs-Knopf (AC7, S-337). `HeadlessAdoptRunner#start()` ist
 *     synchron fire-and-forget (Muster `core.start()`) — ein bereits
 *     laufender Adopt-Job liefert `409`.
 *
 * Beide Wege lösen den bestehenden interaktiven PTY-`/api/command`-Trigger
 * NICHT ab — dieser bleibt als technischer Fallback vollständig unverändert
 * bestehen (AC14; dieses Modul importiert/mutiert WEDER `PtyManager` NOCH
 * `PtySessionRegistry` NOCH den `CommandService`-Schreibpfad, Trust-Boundary).
 *
 * Sperre: `HeadlessNewProjectRunner`/`HeadlessAdoptRunner` halten je eine
 * EIGENE `ProjectJobLock`-Instanz (server.js) — getrennt von allen anderen
 * headless-Runnern (Muster ADR-017).
 *
 * Authz (Muster `deploymentsRouter.js`, dieselbe F-073-Endpunkt-Familie):
 * `checkMutationAuthz` (CRED_ADMIN_EMAILS-Logik) — ohne gesetzte Liste ist
 * jede gültige Access-Identität berechtigt (identisch zu den GPG-Provisionierungs-/
 * Rotations-Endpunkten).
 *
 * Security (Floor): kein Secret in Response/Log; App-Slug/Owner-Repo werden
 * server-seitig validiert (untrusted Input vor jedem Sink — Spawn-cwd/-argv),
 * bevor sie an einen Runner gereicht werden.
 *
 * @module newProjectHeadlessRouter
 */

import { Router } from 'express';
import { stat as nodeStat } from 'node:fs/promises';

/** Zeichensatz/Länge für den App-Slug — identisch zur Konvention in
 * `PerAppGpgProvisioningService`/`deploymentsRouter.js` (`gpgBwItem`, AC13). */
const APP_SLUG_RE = /^[A-Za-z0-9_-]+$/;
const MAX_APP_SLUG_LEN = 128;

/** `<owner>/<repo>`-Form — identisch zur clientseitigen Ableitung in
 * `AdoptSection.jsx#parseGithubRepoUrl` (owner/repo-Gruppen, mit '/' verbunden).
 * Repo-Segment schließt einen führenden Punkt sowie `..` aus (kein
 * Traversal-/Versteckdatei-artiges Segment, reviewer-Suggestion S-343). */
const OWNER_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;
const MAX_OWNER_REPO_LEN = 200;

/**
 * Checks whether the requesting identity is allowed to mutate
 * (CRED_ADMIN_EMAILS-logic — Muster deploymentsRouter.js/credentialsRouter.js).
 *
 * @param {object|null} identity - req.identity from AccessGuard
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
 * Löst die effektive Workspace-Root auf und verifiziert, dass sie als
 * Verzeichnis existiert (server-seitige Konfiguration, kein untrusted Client-
 * Pfad — daher genügt ein einfacher Existenz-Check ohne Boundary-Prüfung wie
 * bei `validateProjectPath`, das für CLIENT-gelieferte Pfade gedacht ist).
 *
 * @param {() => Promise<{ path: string, source: string }>} workspaceRootResolver
 * @param {(p: string) => Promise<import('node:fs').Stats>} statFn
 * @returns {Promise<string|null>} der Workspace-Root-Pfad oder `null` wenn nicht konfiguriert/erreichbar.
 */
async function resolveWorkspaceRootDir(workspaceRootResolver, statFn) {
  if (typeof workspaceRootResolver !== 'function') return null;
  let resolved;
  try {
    resolved = await workspaceRootResolver();
  } catch {
    return null;
  }
  const path = resolved?.path;
  if (!path || typeof path !== 'string' || !path.trim()) return null;
  try {
    const s = await statFn(path);
    if (!s.isDirectory()) return null;
  } catch {
    return null;
  }
  return path;
}

/**
 * @param {import('./HeadlessNewProjectRunner.js').HeadlessNewProjectRunner} newProjectRunner
 * @param {import('./HeadlessAdoptRunner.js').HeadlessAdoptRunner} adoptRunner
 * @param {object} [options]
 * @param {() => Promise<{ path: string, source: string }>} options.workspaceRootResolver
 *   Effektivwert-Resolver (Muster `buildWorkspaceRootResolver`, `workspacePath.js`).
 * @param {(p: string) => Promise<import('node:fs').Stats>} [options.statFn] - injectable (Tests).
 * @returns {import('express').Router}
 */
export function newProjectHeadlessRouter(newProjectRunner, adoptRunner, options = {}) {
  const { workspaceRootResolver, statFn = nodeStat } = options;
  const router = Router();

  /**
   * POST /api/new-project/start
   * Body: { app: string }
   *
   * Responses:
   *   202 { status: "started" }
   *   400 { error }  — app fehlt/ungültig
   *   403 { error }  — nicht in CRED_ADMIN_EMAILS
   *   503 { error }  — Runner nicht konfiguriert / Workspace-Root nicht erreichbar
   */
  router.post('/api/new-project/start', async (req, res) => {
    const identity = req.identity ?? null;

    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { app } = req.body ?? {};
    if (
      typeof app !== 'string' ||
      !app.trim() ||
      app.trim().length > MAX_APP_SLUG_LEN ||
      !APP_SLUG_RE.test(app.trim())
    ) {
      return res.status(400).json({ error: 'app fehlt oder enthält ungültige Zeichen' });
    }

    if (!newProjectRunner || typeof newProjectRunner.runWithAutoProvisioning !== 'function') {
      return res.status(503).json({ error: 'Headless-new-project-Runner nicht konfiguriert' });
    }

    const workspaceRoot = await resolveWorkspaceRootDir(workspaceRootResolver, statFn);
    if (!workspaceRoot) {
      return res.status(503).json({ error: 'Workspace-Root nicht konfiguriert oder nicht erreichbar' });
    }

    const slug = app.trim();
    // AC13/AC15: der vorab erfasste, validierte Slug geht als EINZIGES argv-
    // Element an den Scaffold; `runWithAutoProvisioning` ist die EINZIGE Naht,
    // die Provisionierung UND Scaffold komponiert (S-336). Fire-and-forget aus
    // HTTP-Sicht (s. Modul-Header) — Fehler sind bereits secret-frei auditiert.
    newProjectRunner
      .runWithAutoProvisioning(slug, workspaceRoot, { args: [slug], identity: identity?.email ?? null })
      .catch(() => {
        // best-effort — kein unhandled rejection; Ergebnis liegt im Audit-Trail.
      });

    return res.status(202).json({ status: 'started' });
  });

  /**
   * POST /api/adopt/start
   * Body: { ownerRepo: string }  — Form `<owner>/<repo>`
   *
   * Responses:
   *   202 { status: "started", jobId }
   *   400 { error }  — ownerRepo fehlt/ungültig
   *   403 { error }  — nicht in CRED_ADMIN_EMAILS
   *   409 { error }  — bereits ein laufender Adopt-Job
   *   503 { error }  — Runner nicht konfiguriert / Workspace-Root nicht erreichbar
   */
  router.post('/api/adopt/start', async (req, res) => {
    const identity = req.identity ?? null;

    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { ownerRepo } = req.body ?? {};
    if (
      typeof ownerRepo !== 'string' ||
      !ownerRepo.trim() ||
      ownerRepo.trim().length > MAX_OWNER_REPO_LEN ||
      !OWNER_REPO_RE.test(ownerRepo.trim())
    ) {
      return res.status(400).json({ error: 'ownerRepo fehlt oder enthält ungültige Zeichen' });
    }

    if (!adoptRunner || typeof adoptRunner.start !== 'function') {
      return res.status(503).json({ error: 'Headless-Adopt-Runner nicht konfiguriert' });
    }

    const workspaceRoot = await resolveWorkspaceRootDir(workspaceRootResolver, statFn);
    if (!workspaceRoot) {
      return res.status(503).json({ error: 'Workspace-Root nicht konfiguriert oder nicht erreichbar' });
    }

    const result = adoptRunner.start(workspaceRoot, { args: [ownerRepo.trim()] });
    if (!result.ok) {
      return res.status(409).json({ error: 'Ein Adopt-Lauf läuft bereits' });
    }

    return res.status(202).json({ status: 'started', jobId: result.jobId });
  });

  return router;
}
