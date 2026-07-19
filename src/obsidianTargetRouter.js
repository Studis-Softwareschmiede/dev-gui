/**
 * obsidianTargetRouter — Express-Router für die Ziel-Repo-Vorbereitung des
 * Obsidian-Ingest (docs/specs/obsidian-question-catalog.md AC11/AC13/AC14, v3).
 *
 * Routes (hinter dem AccessGuard, wie alle /api/*, s. server.js):
 *   POST /api/obsidian-ingest/ensure-target        — { targetProjectSlug } →
 *     200 { status:'ready' }               — Checkout existiert bereits
 *                                             (bestehend gewählt ODER Namens-
 *                                             kollision), KEIN new-project.
 *     202 { status:'creating', jobId }     — Anlage über den bestehenden
 *                                             `HeadlessNewProjectRunner`
 *                                             gestartet (AC14).
 *     400 { error }                        — Slug fehlt/ungültige Form
 *                                             (Confinement, AC13) bzw. — nur
 *                                             im Anlage-Zweig — ungültiger
 *                                             Zeichensatz (AC13a).
 *     403 { error }                        — keine Berechtigung
 *                                             (CRED_ADMIN_EMAILS).
 *     404 { error }                        — Workspace nicht konfiguriert.
 *     409 { error }                        — Anlage für denselben Slug läuft
 *                                             bereits (kein Doppel-Start).
 *     503 { error }                        — Ziel-Repo-Vorbereitung/Runner
 *                                             nicht konfiguriert.
 *   GET  /api/obsidian-ingest/ensure-target/:jobId — Anlage-Status-Poll
 *     (In-Memory, kein persistiertes Mapping):
 *     200 { status:'creating'|'ready'|'failed', error? } | 404 { error }.
 *
 * Läuft VOR dem unveränderten `POST .../obsidian-ingest/start` (AC13/AC14) —
 * der Client ruft `start` erst NACH `status:'ready'` auf (sofort ODER nach
 * einem erfolgreichen `creating`→`ready`-Übergang). `start` selbst prüft die
 * Checkout-Existenz ohnehin erneut (AC9) — ein übersprungener
 * `ensure-target`-Aufruf kann also nie zu einem Start auf einem
 * nicht-existenten Checkout führen.
 *
 * Authz (Important-Fund — Muster `newProjectHeadlessRouter.js:70–84`,
 * dieselbe Endpunkt-Familie, `docs/architecture.md:641`): `checkMutationAuthz`
 * (CRED_ADMIN_EMAILS-Logik) VOR jedem `preparer.ensure()`-Aufruf — ohne
 * gesetzte Liste ist jede gültige Access-Identität berechtigt.
 *
 * Slug-Zeichensatz (S-387-Fund, Reihenfolge korrigiert): die enge
 * `APP_SLUG_RE`-Zeichensatz-Prüfung (identisch zu `newProjectHeadlessRouter.js`)
 * läuft NICHT mehr hier am Router — ein Vorab-Guard auf dem rohen
 * `targetProjectSlug` hätte auch Bestandsprojekte mit GitHub-konformem, aber
 * ausserhalb `APP_SLUG_RE` liegendem Namen (z.B. mit '.') blockiert, BEVOR
 * `ObsidianTargetPreparer#ensure()` die Existenz prüfen konnte (verletzte
 * AC13a). Der Router delegiert die komplette Slug-Validierung an
 * `preparer.ensure()`: dort läuft immer die `resolveProjectSlug`-Form-Prüfung
 * (Confinement, `/`/NUL/`.`/`..`), UND — ausschliesslich im Anlage-Zweig
 * (Checkout existiert nicht) — die enge `APP_SLUG_RE`-Prüfung als Defense in
 * Depth direkt am `claude -p`-Prompt-Sink (s. `ObsidianTargetPreparer.js`
 * Modul-Header)
 *
 * Security (Floor): keine Secrets/Host-Pfade in Response/Log; `jobId` ist
 * eine reine Korrelations-ID (`randomUUID()`), kein Secret.
 *
 * @module obsidianTargetRouter
 */

import { Router } from 'express';

/**
 * Checks whether the requesting identity is allowed to mutate
 * (CRED_ADMIN_EMAILS-logic — Muster `newProjectHeadlessRouter.js`).
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
 * @param {import('./ObsidianTargetPreparer.js').ObsidianTargetPreparer} preparer
 * @returns {import('express').Router}
 */
export function obsidianTargetRouter(preparer) {
  const router = Router();

  router.post('/api/obsidian-ingest/ensure-target', async (req, res) => {
    const identity = req.identity ?? null;

    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    if (!preparer || typeof preparer.ensure !== 'function') {
      return res.status(503).json({ error: 'Ziel-Repo-Vorbereitung nicht konfiguriert' });
    }
    const { targetProjectSlug } = req.body ?? {};

    // S-387-Fund (Reihenfolge, s. Modul-Header): KEINE eigene
    // Zeichensatz-Vorprüfung mehr hier — `preparer.ensure()` ist die alleinige
    // Quelle der Slug-Validierung (resolveProjectSlug-Form immer, die enge
    // APP_SLUG_RE-Prüfung ausschliesslich im Anlage-Zweig).
    const result = await preparer.ensure(targetProjectSlug, identity?.email ?? null);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    if (result.ready) {
      return res.status(200).json({ status: 'ready' });
    }
    return res.status(202).json({ status: 'creating', jobId: result.jobId });
  });

  router.get('/api/obsidian-ingest/ensure-target/:jobId', (req, res) => {
    if (!preparer || typeof preparer.getStatus !== 'function') {
      return res.status(503).json({ error: 'Ziel-Repo-Vorbereitung nicht konfiguriert' });
    }
    const job = preparer.getStatus(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Unknown jobId' });
    }
    const body = { status: job.status };
    if (job.error) body.error = job.error;
    return res.status(200).json(body);
  });

  return router;
}
