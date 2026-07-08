/**
 * Router: Regressionslauf-Ergebnisse + Debug-Artefakt-Zugriff
 * (docs/specs/regression-result-store.md AC4, docs/specs/regression-result-view.md AC1/AC2).
 *
 * GET /api/projects/:slug/regression-runs
 *   → 200 { runs: [ { runId, projekt, suite, scopeTyp, status, startedAt,
 *          durationMs, counts:{passed,failed,total}, artifacts? } ] }
 *   Liste je Projekt, absteigend nach `startedAt` (jüngster zuerst). Das
 *   `ctrf`-Feld wird in der LISTE bewusst NICHT mitgeschickt (kann groß sein) —
 *   Testfall-Details liefert der Einzel-Lauf-Endpunkt.
 *
 * GET /api/projects/:slug/regression-runs/:runId
 *   → 200 { run: { ...,  ctrf: <CTRF-JSON> } }  (inkl. Testfall-Details)
 *   → 404 { error }  wenn Lauf nicht gefunden / Slug ungültig
 *
 * Ein ungültiger/traversierender `:slug` → leere Liste bzw. 404 (KEIN
 * Dateizugriff): der Store validiert den Slug ohnehin selbst, arbeitet aber
 * nur auf seinem In-Memory-Cache.
 *
 * GET /api/projects/:slug/regression-runs/:runId/artifacts/*splat
 *   (regression-result-view AC2/Verträge) — dient EINE Datei aus der
 *   Artefakt-Ablage des Laufs aus (z.B. `index.html`/Assets des Playwright-
 *   HTML-Reports). NUR verfügbar wenn:
 *     (a) der Lauf existiert UND `status === "failed"` (grüne/nicht-existente
 *         Läufe → 404, kein Leak, kein toter Link — Edge-Case §Spec),
 *     (b) der Lauf `artifacts.htmlReport` referenziert (relativer Pfad,
 *         RegressionRunner schreibt aktuell nur diesen; `artifacts.traces`
 *         ist im Schema vorgesehen, wird vom Runner aber (noch) nicht befüllt
 *         — kein Nutzungsfall dafür in diesem Item, kein Gold-Plating).
 *   Pfad-Auflösung (Security, Path-Traversal/Symlink-Härtung):
 *     `artifacts.htmlReport` ist ein RELATIVER Pfad, referenziert gegen den
 *     Projekt-Klon (`WORKSPACE_DIR/<slug>` — derselbe Ort, unter dem der
 *     `RegressionRunner` `npx playwright test` ausführt, s. RegressionRunner.js
 *     Modul-Doku). Der Store selbst validiert diesen String NICHT strukturell
 *     (Vertrauensgrenze, s. Store-Doku) — dieser Endpunkt härtet daher SELBST:
 *       1. `:slug` → Projekt-Pfad über `slugResolver`/`pathValidator`
 *          (Muster `regressionRunRouter.js`, realpath-Containment gegen
 *          `WORKSPACE_DIR`).
 *       2. Artefakt-Basisordner = `resolve(projectPath, run.artifacts.htmlReport)`,
 *          RE-geprüft gegen `projectPath` (Präfix-Check mit Trailing-Slash) —
 *          ein manipulierter/traversierender `artifacts.htmlReport`-String
 *          (z.B. `../../etc`) kann so NICHT aus dem Projekt-Klon ausbrechen.
 *       3. Das Wildcard-Segment (`*splat`, Datei INNERHALB des HTML-Reports)
 *          wird ebenso aufgelöst + gegen den Artefakt-Basisordner (Schritt 2)
 *          re-geprüft (Präfix-Check) — verhindert `..`-Traversal im
 *          Client-gelieferten Rest-Pfad selbst.
 *       4. `realpath()` auf die finale Datei löst Symlinks auf; das Ergebnis
 *          wird EIN drittes Mal gegen den Artefakt-Basisordner geprüft (kein
 *          Symlink-Ausbruch aus der Ablage heraus).
 *     Jede der drei Stufen schlägt bei Verletzung mit 404 fehl (kein Leak
 *     über unterschiedliche Fehlercodes).
 *   → 200 <Datei-Bytes>  (Content-Type via `res.sendFile`, extension-basiert)
 *   → 404 { error }  Lauf nicht gefunden, Lauf nicht rot, kein `htmlReport`,
 *                     Pfad außerhalb der Ablage, Datei existiert nicht.
 *
 * Security (Floor): keine Secrets/absoluten Pfade in der Response — der
 * RegressionResultStore hält nur Slug/Suite/Status/Zähler/CTRF-JSON/
 * Artefakt-Pfad-Referenzen (Runner-Verantwortung, keine Secrets darin,
 * agent-flow `regression-runner` AC9). Read-only, hinter dem globalen
 * AccessGuard auf `/api/*` (server.js).
 *
 * Factory-Signatur: create(deps) → Express Router
 *
 * @module regressionRuns
 */

import { Router } from 'express';
import { resolve as resolvePath, sep } from 'node:path';
import { realpath as realpathFn, stat as statFn } from 'node:fs/promises';
import { validateProjectPath, ProjectPathError, resolveProjectSlug } from '../workspacePath.js';

export const order = 94;

/**
 * Prüft, ob `candidate` gleich `baseDir` ist oder darunter liegt
 * (Trailing-Slash-Präfix-Vergleich — Muster `workspacePath.js`).
 *
 * @param {string} candidate
 * @param {string} baseDir
 * @returns {boolean}
 */
function _isInside(candidate, baseDir) {
  const prefix = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  return candidate === baseDir || candidate.startsWith(prefix);
}

/**
 * @param {{
 *   regressionResultStore?: import('../RegressionResultStore.js').RegressionResultStore,
 *   pathValidator?: (path: string) => Promise<{ resolvedPath: string }>,
 *   slugResolver?: (slug: string|null) => string|null,
 *   realpath?: (p: string) => Promise<string>,
 *   stat?: (p: string) => Promise<import('node:fs').Stats>,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({
  regressionResultStore,
  pathValidator = validateProjectPath,
  slugResolver = resolveProjectSlug,
  realpath = realpathFn,
  stat = statFn,
} = {}) {
  const router = Router();

  /**
   * GET /api/projects/:slug/regression-runs
   *
   * Responses:
   *   200 { runs: [...] }  — absteigend nach startedAt, ohne `ctrf`-Feld
   *   500 { error }        — Store-Lesefehler (best-effort — sollte nicht vorkommen)
   */
  router.get('/api/projects/:slug/regression-runs', async (req, res) => {
    const { slug } = req.params;

    if (!regressionResultStore || typeof regressionResultStore.list !== 'function') {
      // Composition-Root-Fehler / Store nicht verdrahtet → leere Liste (defensiv).
      return res.json({ runs: [] });
    }

    try {
      const runs = await regressionResultStore.list(slug);
      // Listen-Response bewusst ohne `ctrf` (kann groß sein) — Details liefert
      // der Einzel-Lauf-Endpunkt.
      const summary = runs.map(({ ctrf: _ctrf, ...rest }) => rest);
      return res.json({ runs: summary });
    } catch (err) {
      console.error('[regressionRuns] list fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Regressionsläufe konnten nicht geladen werden.' });
    }
  });

  /**
   * GET /api/projects/:slug/regression-runs/:runId
   *
   * Responses:
   *   200 { run: {...} }  — inkl. `ctrf` (Testfall-Details) + `artifacts` bei Rot
   *   404 { error }       — Lauf nicht gefunden / Slug ungültig
   *   500 { error }       — Store-Lesefehler
   */
  router.get('/api/projects/:slug/regression-runs/:runId', async (req, res) => {
    const { slug, runId } = req.params;

    if (!regressionResultStore || typeof regressionResultStore.get !== 'function') {
      return res.status(404).json({ error: 'Lauf nicht gefunden.' });
    }

    try {
      const run = await regressionResultStore.get(slug, runId);
      if (!run) {
        return res.status(404).json({ error: 'Lauf nicht gefunden.' });
      }
      return res.json({ run });
    } catch (err) {
      console.error('[regressionRuns] get fehlgeschlagen:', err.message);
      return res.status(500).json({ error: 'Regressionslauf konnte nicht geladen werden.' });
    }
  });

  /**
   * GET /api/projects/:slug/regression-runs/:runId/artifacts/*splat
   * (regression-result-view AC2 — Debug-Artefakt-Zugriff, nur bei roten Läufen)
   *
   * Responses:
   *   200 <Datei-Bytes>  — Content-Type via `res.sendFile` (extension-basiert)
   *   404 { error }      — Lauf nicht gefunden / nicht rot / kein htmlReport /
   *                         Slug ungültig / Pfad außerhalb der Ablage / Datei fehlt
   */
  router.get('/api/projects/:slug/regression-runs/:runId/artifacts/*splat', async (req, res) => {
    const { slug, runId } = req.params;
    const notFound = () => res.status(404).json({ error: 'Artefakt nicht gefunden.' });

    if (!regressionResultStore || typeof regressionResultStore.get !== 'function') {
      return notFound();
    }

    let run;
    try {
      run = await regressionResultStore.get(slug, runId);
    } catch (err) {
      console.error('[regressionRuns] artifact get fehlgeschlagen:', err.message);
      return notFound();
    }

    // AC2: nur rote Läufe haben Artefakte; unbekannter/grüner Lauf → 404 (kein Leak).
    if (!run || run.status !== 'failed' || !run.artifacts?.htmlReport) {
      return notFound();
    }

    // Schritt 1: Slug → validierter, absoluter Projekt-Pfad (Muster regressionRunRouter.js).
    let projectPath;
    try {
      const slugPath = slugResolver(slug);
      if (slugPath === null) return notFound();
      ({ resolvedPath: projectPath } = await pathValidator(slugPath));
    } catch (err) {
      if (!(err instanceof ProjectPathError)) {
        console.error('[regressionRuns] artifact Projekt-Pfad-Auflösung fehlgeschlagen:', err.message);
      }
      return notFound();
    }

    // Schritt 2: Artefakt-Basisordner (run.artifacts.htmlReport, relativ) auflösen
    // + gegen den Projekt-Pfad re-prüfen — verhindert Ausbruch via manipuliertem
    // Store-Datensatz (Vertrauensgrenze, s. Modul-Doku).
    const artifactBaseDir = resolvePath(projectPath, run.artifacts.htmlReport);
    if (!_isInside(artifactBaseDir, projectPath)) {
      return notFound();
    }

    // Schritt 3: Wildcard-Rest-Pfad (Datei INNERHALB des HTML-Reports) auflösen
    // + gegen den Artefakt-Basisordner re-prüfen (verhindert `..` im Client-Pfad).
    const splatSegments = Array.isArray(req.params.splat) ? req.params.splat : [req.params.splat];
    const requestedRelative = splatSegments.filter(Boolean).join('/') || 'index.html';
    const candidatePath = resolvePath(artifactBaseDir, requestedRelative);
    if (!_isInside(candidatePath, artifactBaseDir)) {
      return notFound();
    }

    // Schritt 4: realpath() löst Symlinks auf — Ergebnis EIN drittes Mal gegen
    // den Artefakt-Basisordner geprüft (kein Symlink-Ausbruch aus der Ablage).
    let realFilePath;
    try {
      realFilePath = await realpath(candidatePath);
    } catch {
      return notFound(); // Datei existiert nicht
    }
    let realBaseDir;
    try {
      realBaseDir = await realpath(artifactBaseDir);
    } catch {
      return notFound(); // Artefakt-Ablage selbst existiert nicht (mehr)
    }
    if (!_isInside(realFilePath, realBaseDir)) {
      return notFound();
    }

    let fileStat;
    try {
      fileStat = await stat(realFilePath);
    } catch {
      return notFound();
    }
    if (!fileStat.isFile()) {
      return notFound();
    }

    res.sendFile(realFilePath, (err) => {
      if (err && !res.headersSent) {
        notFound();
      }
    });
  });

  return router;
}
