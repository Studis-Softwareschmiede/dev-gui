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
 * GET /api/projects/:slug/regression-runs/:runId/artifacts/{*splat}
 *   (regression-result-view AC2/Verträge) — dient EINE Datei aus der
 *   Lauf-EIGENEN Artefakt-Ablage aus (z.B. `index.html`/Assets des
 *   Playwright-HTML-Reports, oder eine per CTRF-Attachment referenzierte
 *   Datei unter `test-results/…`). NUR verfügbar wenn:
 *     (a) der Lauf existiert (S-328: die frühere `status === "failed"`-
 *         Beschränkung ist AUFGEHOBEN — grüne Läufe liefern seit S-327
 *         ebenfalls Artefakte, s. RegressionResultStore.js „Artefakte bei
 *         GRÜN (AC3)"; unbekannte Läufe → 404, kein Leak, kein toter Link),
 *     (b) der Lauf MINDESTENS EINEN Artefakt-Teil referenziert —
 *         `artifacts.htmlReport` UND/ODER `artifacts.testResults` (Review-Fix
 *         Iteration 2: `#copyArtifacts` im Store kopiert beide Ordner
 *         UNABHÄNGIG voneinander, je best-effort — ein abgebrochener/
 *         getimeouteter Lauf kann `testResults` OHNE `htmlReport` haben, s.
 *         RegressionResultStore.js/regression-result-store.md Edge-Case).
 *         Fehlen BEIDE (nie erfasst / komplett geprunt, s.
 *         regression-result-store.md AC3), gibt es NICHTS auszuliefern →
 *         404 (kein toter Link, regression-result-view Edge-Case „gepruneter
 *         Lauf"). Der Default-Pfad OHNE Rest-Segment (Schritt 2 unten)
 *         braucht zusätzlich SPEZIFISCH `htmlReport` (kein Report-Index ohne
 *         Report-Ordner) — ein Rest-Pfad-Zugriff (Attachment-Datei) braucht
 *         das nicht, die Existenz der Datei selbst entscheidet Schritt 3.
 *   Pfad-Auflösung (Security, Path-Traversal/Symlink-Härtung — S-327: die
 *   Basis ist seit dieser Story die STORE-EIGENE Lauf-Ablage
 *   `${CRED_STORE_DIR}/regression-runs/<slug>/<runId>/`, NICHT mehr der
 *   Projekt-Klon (der wird vom nächsten Lauf überschrieben — s. Store-Doku
 *   „wesentlicher Befund"). CTRF-Attachment-Pfade sind bereits relativ zu
 *   GENAU dieser Ablage (Store relativiert sie beim Ablegen), ein
 *   Rest-Pfad-Segment (`*splat`) adressiert eine solche Datei daher OHNE
 *   Umrechnung direkt. Die dreistufige Härtung bleibt inhaltlich erhalten,
 *   jetzt gegen die neue Basis:
 *     1. Artefakt-Basisordner = `regressionResultStore.resolveArtifactDir(slug, runId)`
 *        — validiert `slug`/`runId` selbst (Slug-Form-Check), `null` ohne
 *        CRED_STORE_DIR → 404 (kein Dateizugriff).
 *     2. OHNE Rest-Pfad (Default, Rückwärtskompatibilität zum bisherigen
 *        `/artifacts/`-Aufruf) wird der HTML-Report-Index angefordert
 *        (`<htmlReport>/index.html`, 404 falls `htmlReport` fehlt) — der
 *        Report-Unterordner selbst wird VOR der Verwendung gegen den
 *        Artefakt-Basisordner re-geprüft: ein korrupter/manipulierter
 *        `artifacts.htmlReport`-Datensatz (Store validiert diesen String
 *        NICHT strukturell, Vertrauensgrenze) kann so NICHT aus der Ablage
 *        ausbrechen. MIT explizitem Rest-Pfad wird direkt gegen den
 *        Artefakt-Basisordner aufgelöst + re-geprüft (Präfix-Check) —
 *        verhindert `..`-Traversal im Client-gelieferten Rest-Pfad selbst
 *        (unabhängig davon, ob `htmlReport` gesetzt ist).
 *     3. `realpath()` auf die finale Datei löst Symlinks auf; das Ergebnis
 *        wird EIN weiteres Mal gegen den (realen) Artefakt-Basisordner
 *        geprüft (kein Symlink-Ausbruch aus der Ablage heraus).
 *     Jede Stufe schlägt bei Verletzung mit 404 fehl (kein Leak über
 *     unterschiedliche Fehlercodes).
 *   → 200 <Datei-Bytes>  (Content-Type via `res.sendFile`, extension-basiert)
 *   → 404 { error }  Lauf nicht gefunden, kein Artefakt-Teil referenziert,
 *                     Default-Pfad ohne `htmlReport`, Pfad außerhalb der
 *                     Ablage, Datei existiert nicht.
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
 *   realpath?: (p: string) => Promise<string>,
 *   stat?: (p: string) => Promise<import('node:fs').Stats>,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({
  regressionResultStore,
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
   * GET /api/projects/:slug/regression-runs/:runId/artifacts/{*splat}
   * (regression-result-view AC2 — Debug-Artefakt-Zugriff, S-328: bei JEDEM
   * Status verfügbar, sofern die Artefakt-Ablage des Laufs noch existiert)
   *
   * `{*splat}` (statt `*splat`) — S-327 Fix eines vorbestehenden, von dieser
   * Story unabhängigen Latent-Bugs: in Express 5/path-to-regexp v8 matcht ein
   * REQUIRED-Wildcard `*splat` KEINE Anfrage ohne Rest-Segment (weder mit noch
   * ohne trailing slash) — der einzige echte Aufrufer (`RegressionResultView.jsx`,
   * `href=".../artifacts/"` ohne Rest-Pfad) lief dadurch seit Express 5 IMMER
   * ins Leere (404 direkt von Express, vor diesem Handler). `{*splat}` ist der
   * OPTIONALE Wildcard (matcht auch `.../artifacts/` mit leerem Rest-Segment)
   * — notwendig, damit der in dieser Story neu gebaute Default-Pfad (Schritt 2
   * unten) überhaupt erreichbar ist.
   *
   * Responses:
   *   200 <Datei-Bytes>  — Content-Type via `res.sendFile` (extension-basiert)
   *   404 { error }      — Lauf nicht gefunden / weder htmlReport noch
   *                         testResults referenziert (nie erfasst oder
   *                         komplett geprunt) / Default-Pfad ohne htmlReport
   *                         / Slug ungültig / Pfad außerhalb der Ablage /
   *                         Datei fehlt
   */
  router.get('/api/projects/:slug/regression-runs/:runId/artifacts/{*splat}', async (req, res) => {
    const { slug, runId } = req.params;
    const notFound = () => res.status(404).json({ error: 'Artefakt nicht gefunden.' });

    if (
      !regressionResultStore ||
      typeof regressionResultStore.get !== 'function' ||
      typeof regressionResultStore.resolveArtifactDir !== 'function'
    ) {
      return notFound();
    }

    let run;
    try {
      run = await regressionResultStore.get(slug, runId);
    } catch (err) {
      console.error('[regressionRuns] artifact get fehlgeschlagen:', err.message);
      return notFound();
    }

    // AC2 (regression-result-view, S-328): Artefakte sind bei JEDEM Status
    // verfügbar (grün UND rot) — die frühere Rot-Only-Bedingung ist
    // aufgehoben. Gate hier bewusst ENTKOPPELT von `htmlReport` allein
    // (Review-Fix Iteration 2): `#copyArtifacts` (RegressionResultStore.js)
    // kopiert `playwright-report/` (→ htmlReport) und `test-results/`
    // (→ testResults, enthält die CTRF-Attachment-Dateien/Screenshots/
    // Videos) in ZWEI unabhängigen, je für sich best-effort scheiternden
    // `cp()`-Aufrufen — ein abgebrochener/getimeouteter Lauf kann
    // `testResults` OHNE `htmlReport` haben (Report wird erst am Lauf-Ende
    // geschrieben, s. regression-result-store.md Edge-Case). Ohne Lauf ODER
    // ganz ohne `artifacts`-Referenz (nie erfasst / komplett von der
    // Artefakt-Retention geprunt, s. regression-result-store.md AC3) → 404
    // (kein Leak, kein toter Link). Welcher Teil (`htmlReport`/`testResults`)
    // für die konkrete Anfrage tatsächlich gebraucht wird, entscheidet der
    // Pfad-Zweig unten.
    if (!run || (!run.artifacts?.htmlReport && !run.artifacts?.testResults)) {
      return notFound();
    }

    // Schritt 1 (S-327): Artefakt-Basisordner ist die STORE-EIGENE Lauf-Ablage
    // (nicht mehr der Projekt-Klon) — der Store validiert slug/runId selbst.
    const artifactBaseDir = regressionResultStore.resolveArtifactDir(slug, runId);
    if (!artifactBaseDir) {
      return notFound();
    }

    const splatSegments = Array.isArray(req.params.splat) ? req.params.splat : [req.params.splat];
    const requestedRelative = splatSegments.filter(Boolean).join('/');

    let candidatePath;
    if (requestedRelative) {
      // Expliziter Rest-Pfad (z.B. eine CTRF-Attachment-Datei unter
      // test-results/…) — bereits relativ zur Artefakt-Ablage selbst
      // (s. Store-Doku „Artefakte kopieren"), gegen diese re-geprüft
      // (verhindert `..`-Traversal im Client-Pfad).
      candidatePath = resolvePath(artifactBaseDir, requestedRelative);
      if (!_isInside(candidatePath, artifactBaseDir)) {
        return notFound();
      }
    } else {
      // Schritt 2: kein Rest-Pfad → Default ist der HTML-Report-Index
      // (Rückwärtskompatibilität zum bisherigen `/artifacts/`-Aufruf) — dafür
      // wird `htmlReport` SPEZIFISCH gebraucht (Review-Fix Iteration 2: ein
      // Teilzustand mit nur `testResults` hat keinen Report-Index-Kandidaten).
      if (!run.artifacts?.htmlReport) {
        return notFound();
      }
      // Der Report-Unterordner wird VOR der Verwendung re-geprüft — ein
      // korrupter/manipulierter `artifacts.htmlReport`-Datensatz (Store
      // validiert diesen String nicht strukturell, Vertrauensgrenze) kann so
      // NICHT aus der Ablage ausbrechen.
      const htmlReportDir = resolvePath(artifactBaseDir, run.artifacts.htmlReport);
      if (!_isInside(htmlReportDir, artifactBaseDir)) {
        return notFound();
      }
      candidatePath = resolvePath(htmlReportDir, 'index.html');
    }

    // Schritt 3: realpath() löst Symlinks auf — Ergebnis EIN weiteres Mal
    // gegen den (realen) Artefakt-Basisordner geprüft (kein Symlink-Ausbruch
    // aus der Ablage).
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
