/**
 * ObsidianTargetPreparer — server-seitige Ziel-Repo-Vorbereitung für den
 * Obsidian-Ingest (docs/specs/obsidian-question-catalog.md AC11/AC13/AC14, v3).
 *
 * Stellt VOR dem (unveränderten) `POST .../obsidian-ingest/start`-Aufruf
 * sicher, dass `WORKSPACE_DIR/<targetProjectSlug>` existiert:
 *   - existiert der Checkout bereits (bestehendes Ziel gewählt ODER der
 *     eingegebene Name kollidiert mit einem Bestand) → direkt verwenden,
 *     KEIN `new-project`-Lauf (AC13a, AC11 — leere/kein-Treffer-Projektliste
 *     ist hier kein Blocker, der Anlage-Zweig unten deckt den Fall).
 *   - fehlt er (neuer, noch nicht existierender Name) → Anlage über den
 *     BESTEHENDEN `HeadlessNewProjectRunner` — DIESELBE Naht wie
 *     `POST /api/new-project/start` (`newProjectHeadlessRouter.js`):
 *     `runWithAutoProvisioning(slug, workspaceRoot, { args: [slug], identity })`
 *     (ADR-021/`per-app-gpg-passphrase-provisioning.md` AC4/AC12/AC15 — die
 *     AUSSCHLIESSLICHE Naht, die Scaffold + per-App-GPG-Passphrasen-Auto-
 *     Provisionierung komponiert; `run()` direkt aufzurufen würde die
 *     Auto-Provisionierung für diesen Anlage-Weg umgehen). `cwd` = der
 *     Workspace-ROOT (nicht der noch nicht existierende Ziel-Ordner selbst),
 *     `slug` als einziges argv-Element; das Scaffold legt `<slug>` innerhalb
 *     dieses `cwd` selbst an. KEIN neuer Kindprozess-/Anlage-Mechanismus, KEIN
 *     Nachbau (AC14, Nicht-Ziele).
 *
 * Anlage-Erfolg/-Fehlschlag (AC14) wird NICHT aus dem `result`-Wert von
 * `runWithAutoProvisioning` geraten (der bildet die GPG-Provisionierung ab,
 * nicht den Scaffold) — `result !== 'failed'` ist KEIN zuverlässiger
 * Scaffold-Erfolgs-Indikator (S-387-Fund):
 * `PerAppGpgProvisioningService#withScaffoldPassphrase` schluckt in seinen
 * Fallback-Zweigen (Zugang unready / Item-Kollision) einen Scaffold-Fehlschlag
 * best-effort und liefert trotzdem `access-not-ready`/`already-exists`;
 * umgekehrt liefert es `failed`, wenn NACH einem erfolgreichen Scaffold nur
 * der nachgelagerte Bitwarden-Schritt scheitert. Maßgeblich ist ausschließlich
 * das explizite, nicht überladene `scaffoldOk`-Flag der Rückgabe (`true`
 * genau dann, wenn der `fn`-Aufruf — dieser Scaffold-Lauf — selbst
 * erfolgreich durchlief, unabhängig vom Bitwarden-Teilergebnis).
 *
 * Slug-Form-Validierung (AC13/0c) über den injizierten `slugResolver`
 * (Default `resolveProjectSlug`, `workspacePath.js`) — identisches
 * Confinement-Muster wie `obsidianIngestRouter#resolveTargetRepo` (AC9) —
 * läuft für JEDEN Slug (Bestand UND Anlage). PLUS eine enge
 * Zeichensatz-Prüfung (`APP_SLUG_RE`, identisch zu `newProjectHeadlessRouter.js`),
 * da `resolveProjectSlug` nur `/`, NUL, `.`/`..` blockt, aber
 * Leerzeichen/Zeilenumbrüche durchlässt — die sonst ungefiltert in den
 * `claude -p`-Prompt eines `--dangerously-skip-permissions`-Laufs gelangen
 * würden (`HeadlessRunnerCore#runProcess`, `promptArg = \`${command}
 * ${args.join(' ')}\``). **Reihenfolge (S-387-Fund, AC13a):** diese enge
 * Zeichensatz-Prüfung läuft NACH dem Existenz-Check und AUSSCHLIESSLICH im
 * Anlage-Zweig (Checkout existiert NICHT) — sie darf Bestandsprojekte mit
 * GitHub-konformen, aber ausserhalb `APP_SLUG_RE` liegenden Namen (z.B. mit
 * `.`) nicht blockieren; der Zeichensatz ist nur für den `argv`-Sink des
 * NEUEN Scaffold-Laufs sicherheitsrelevant, nicht für einen bereits
 * existierenden, per `resolveProjectSlug` bereits Confinement-geprüften
 * Checkout. Diese Prüfung läuft NICHT mehr redundant im Router (s.
 * `obsidianTargetRouter.js` — dort nur noch die dünne, generische
 * `resolveProjectSlug`-Form-Prüfung via `ensure()`s eigenem 400-Zweig);
 * fehlender/leerer/formwidriger Slug → definierter Fehler, KEIN
 * `new-project`- und KEIN Ingest-Start (der nachgelagerte, unveränderte
 * `start`-Endpunkt prüft die Checkout-Existenz ohnehin selbst erneut, AC9 —
 * ein übersprungener `ensure-target`-Aufruf kann daher nie zu einem Start auf
 * einem nicht-existenten Checkout führen).
 *
 * Reihenfolge/Doppel-Start (AC14): `ensure()` prüft die Checkout-Existenz
 * SEQUENTIELL, bevor ein Anlage-Lauf getriggert wird; für denselben Slug
 * verhindert eine eigene In-Memory-Registry (`#activeBySlug`) einen zweiten
 * `new-project`-Lauf, solange der erste noch nicht terminal ist (`409`,
 * secret-frei) — zusätzlich zur bestehenden `HeadlessNewProjectRunner`-
 * eigenen `ProjectJobLock`-Instanz (server.js). **TOCTOU-Fix (S-387-Fund,
 * Iteration 4):** der `#activeBySlug.has()`-Check UND die reservierende
 * `#activeBySlug.set()` laufen SYNCHRON, direkt hintereinander, OHNE einen
 * dazwischenliegenden `await` — sonst könnten zwei fast-gleichzeitige
 * `ensure()`-Aufrufe für denselben neuen Slug beide den Check passieren und
 * `runWithAutoProvisioning` doppelt auslösen (Race-Fenster war der frühere
 * `await resolveWorkspaceRootDir` ZWISCHEN Check und Reservierung).
 *
 * Job-Registry: In-Memory (Map jobId → { slug, status, error }), geht bei
 * Server-Neustart verloren (Nicht-Ziel, analog allen Geschwister-Runnern).
 *
 * Security (Floor): keine Secrets/Host-Pfade in Fehlertexten; `slug` wird nie
 * roh interpoliert — nur als argv-Element an den bereits gehärteten
 * `HeadlessNewProjectRunner` gereicht (argv-Array, kein Shell-String) UND vor
 * jeder Weitergabe gegen `APP_SLUG_RE` geprüft (Prompt-Injection-Hygiene).
 *
 * @module ObsidianTargetPreparer
 */

import { randomUUID } from 'node:crypto';
import { stat as nodeStat } from 'node:fs/promises';
import { resolveProjectSlug, validateProjectPath, ProjectPathError } from './workspacePath.js';

/** Secret-/pfad-freier Fehlertext bei fehlgeschlagener Anlage (AC14). */
const CREATION_FAILED_MESSAGE = 'Projekt-Anlage fehlgeschlagen';

/** Zeichensatz/Länge für den Anlage-Slug — identisch zu `APP_SLUG_RE` in
 * `newProjectHeadlessRouter.js` (Defense in Depth: Router UND Preparer prüfen
 * unabhängig; `resolveProjectSlug` allein lässt Leerzeichen/Zeilenumbrüche
 * durch, die den `claude -p`-Prompt-Sink kontaminieren könnten). */
const APP_SLUG_RE = /^[A-Za-z0-9_-]+$/;
const MAX_APP_SLUG_LEN = 128;

/**
 * Löst die effektive Workspace-Root auf und verifiziert, dass sie als
 * Verzeichnis existiert (server-seitige Konfiguration, kein untrusted
 * Client-Pfad — daher genügt ein einfacher Existenz-Check ohne Boundary-
 * Prüfung. Muster identisch zu
 * `newProjectHeadlessRouter.js#resolveWorkspaceRootDir`).
 *
 * @param {() => Promise<{ path: string, source: string }>} workspaceRootResolver
 * @param {(p: string) => Promise<import('node:fs').Stats>} statFn
 * @returns {Promise<string|null>}
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

export class ObsidianTargetPreparer {
  /** @type {{ runWithAutoProvisioning: Function }|null} */
  #newProjectRunner;
  /** @type {(slug: string|null) => string|null} */
  #slugResolver;
  /** @type {(path: string) => Promise<{ resolvedPath: string }>} */
  #pathValidator;
  /** @type {(() => Promise<{ path: string, source: string }>)|null} */
  #workspaceRootResolver;
  /** @type {(p: string) => Promise<import('node:fs').Stats>} */
  #statFn;
  /** @type {Map<string, { slug: string, status: 'creating'|'ready'|'failed', error?: string }>} */
  #jobs = new Map();
  /** @type {Map<string, string>} slug -> in-flight jobId (AC14 Doppel-Start-Schutz) */
  #activeBySlug = new Map();

  /**
   * @param {object} [deps]
   * @param {{ runWithAutoProvisioning: Function }} [deps.newProjectRunner] - der bestehende
   *   `HeadlessNewProjectRunner` (ADR-021-Naht, `runWithAutoProvisioning`).
   * @param {(slug: string|null) => string|null} [deps.slugResolver] - default `resolveProjectSlug`.
   * @param {(path: string) => Promise<{ resolvedPath: string }>} [deps.pathValidator] - default `validateProjectPath`.
   * @param {() => Promise<{ path: string, source: string }>} [deps.workspaceRootResolver]
   * @param {(p: string) => Promise<import('node:fs').Stats>} [deps.statFn] - default node:fs/promises.stat.
   */
  constructor({ newProjectRunner, slugResolver, pathValidator, workspaceRootResolver, statFn } = {}) {
    this.#newProjectRunner = newProjectRunner ?? null;
    this.#slugResolver = slugResolver ?? resolveProjectSlug;
    this.#pathValidator = pathValidator ?? validateProjectPath;
    this.#workspaceRootResolver = workspaceRootResolver ?? null;
    this.#statFn = statFn ?? nodeStat;
  }

  /**
   * Stellt sicher, dass ein Ziel-Repo für `targetProjectSlug` existiert
   * (AC11/AC13/AC14).
   *
   * @param {unknown} targetProjectSlug
   * @param {string|null} [identity] - Audit-Identity für die Auto-
   *   Provisionierung (Muster `newProjectHeadlessRouter.js`,
   *   `identity?.email ?? null`).
   * @returns {Promise<
   *   { ok: true, ready: true } |
   *   { ok: true, ready: false, jobId: string } |
   *   { ok: false, status: number, error: string }
   * >}
   */
  async ensure(targetProjectSlug, identity = null) {
    let slugPath;
    try {
      slugPath = this.#slugResolver(typeof targetProjectSlug === 'string' ? targetProjectSlug : null);
    } catch (err) {
      const reason = err instanceof ProjectPathError ? err.message : 'Invalid targetProjectSlug';
      return { ok: false, status: 400, error: `Invalid targetProjectSlug: ${reason}` };
    }
    if (slugPath === null) {
      return { ok: false, status: 400, error: 'targetProjectSlug is required' };
    }
    const slug = targetProjectSlug.trim();

    // AC13a/AC11 (Reihenfolge S-387-Fund): existiert der Checkout bereits
    // (bestehend gewählt ODER Namens-Kollision mit einem Bestand) → direkt
    // verwenden, KEIN new-project-Lauf UND KEIN APP_SLUG_RE-Zeichensatz-Guard
    // (Bestandsprojekte mit GitHub-konformem, aber ausserhalb APP_SLUG_RE
    // liegendem Namen — z.B. mit '.' — bleiben wählbar, s. Modul-Header).
    // Fehlt der Checkout (not-exists/not-directory) → weiter zur
    // Anlage unten (kein return in diesem Zweig des catch-Blocks).
    try {
      await this.#pathValidator(slugPath);
      return { ok: true, ready: true };
    } catch (err) {
      const isMissing = err instanceof ProjectPathError && (err.errorClass === 'not-exists' || err.errorClass === 'not-directory');
      if (!isMissing) {
        const isBoundary = err instanceof ProjectPathError && err.errorClass === 'outside-boundary';
        return isBoundary
          ? { ok: false, status: 404, error: 'Workspace nicht konfiguriert — Ziel-Projekt-Repo nicht erreichbar' }
          : { ok: false, status: 400, error: 'Invalid targetProjectSlug' };
      }
    }

    // Critical-Fund (security/R02/R03) — NUR im Anlage-Zweig (Checkout fehlt):
    // `resolveProjectSlug` blockt nur '/', NUL, '.'/'..' — Leerzeichen/
    // Zeilenumbrüche passieren und würden ungefiltert in den `claude -p`-
    // Prompt-Sink von `HeadlessRunnerCore#runProcess` gelangen (der NUR im
    // Anlage-Zweig erreicht wird — Defense in Depth am tatsächlichen Sink).
    if (slug.length > MAX_APP_SLUG_LEN || !APP_SLUG_RE.test(slug)) {
      return { ok: false, status: 400, error: 'targetProjectSlug enthält ungültige Zeichen' };
    }

    // AC14: kein Doppel-Start für denselben Slug — solange eine Anlage
    // läuft, liefert ein zweiter ensure()-Aufruf 409 statt eines zweiten
    // new-project-Laufs.
    //
    // S-387-Fund (Iteration 4, TOCTOU-Race): die Reservierung
    // (`#activeBySlug.set`) MUSS SYNCHRON, OHNE einen dazwischenliegenden
    // `await`, direkt neben diesem `has()`-Check erfolgen. Lag zwischen
    // Check und Reservierung ein `await` (vormals `resolveWorkspaceRootDir`),
    // konnten zwei fast-gleichzeitige `ensure()`-Aufrufe für denselben neuen
    // Slug BEIDE den `has()`-Check passieren (das offene Fenster war genau
    // dieser `await`) und `runWithAutoProvisioning` doppelt auslösen — der
    // Verlierer erhielt dann fälschlich `failed`, obwohl die Anlage
    // tatsächlich erfolgreich lief. `randomUUID()` + beide `Map#set`-Aufrufe
    // sind synchron — es liegt daher KEIN await zwischen `has()` und `set()`.
    if (this.#activeBySlug.has(slug)) {
      return { ok: false, status: 409, error: 'Projekt-Anlage läuft bereits für dieses Ziel.' };
    }

    if (!this.#newProjectRunner || typeof this.#newProjectRunner.runWithAutoProvisioning !== 'function') {
      return { ok: false, status: 503, error: 'Projekt-Anlage-Runner nicht konfiguriert' };
    }

    const jobId = randomUUID();
    this.#jobs.set(jobId, { slug, status: 'creating' });
    this.#activeBySlug.set(slug, jobId);

    // ERST NACH der synchronen Reservierung darf ein await folgen. Schlägt
    // dieser Schritt fehl (workspaceRoot nicht erreichbar), ist das ein
    // Früh-Ausstieg VOR dem eigentlichen Anlage-Trigger — die Reservierung
    // wird dafür sauber wieder freigegeben (kein verwaister Lock-Eintrag).
    const workspaceRoot = await resolveWorkspaceRootDir(this.#workspaceRootResolver, this.#statFn);
    if (!workspaceRoot) {
      this.#jobs.delete(jobId);
      this.#activeBySlug.delete(slug);
      return { ok: false, status: 404, error: 'Workspace nicht konfiguriert oder nicht erreichbar' };
    }

    // AC14: strikt sequentiell — dieser Lauf muss erfolgreich terminieren,
    // bevor der (unveränderte) start-Endpunkt für denselben Slug eine
    // existierende Checkout-Verzeichnis vorfindet. Fire-and-forget aus
    // HTTP-Sicht (Muster `newProjectHeadlessRouter.js`/`ObsidianIngestRunner`
    // Poll-Status) — der Aufrufer pollt `getStatus(jobId)` bis Terminalstatus.
    //
    // WICHTIG: `runWithAutoProvisioning` ist die ADR-021-Naht (AC4/AC12/AC15)
    // — NICHT `run()` direkt, sonst würde dieser Anlage-Weg die per-App-GPG-
    // Passphrasen-Auto-Provisionierung umgehen (S-387 führt hier erstmals
    // einen echten Scaffold-Aufruf für den Obsidian-Weg ein).
    this.#newProjectRunner
      .runWithAutoProvisioning(slug, workspaceRoot, { args: [slug], identity })
      .then((result) => {
        // AC14-Gate: ensure() muss wissen, ob der Checkout jetzt existiert —
        // NICHT, ob die GPG-Provisionierung selbst erfolgreich war (s.
        // Modul-Header). `result?.scaffoldOk === true` ist der EINZIGE
        // zuverlässige Indikator (S-387-Fund) — `result !== 'failed'` deckt
        // NICHT beide Fehlrichtungen ab (Fallback-Zweige schlucken
        // Scaffold-Fehlschläge; ein reiner Bitwarden-Fehlschlag NACH
        // erfolgreichem Scaffold liefert `failed` trotz `scaffoldOk: true`).
        const scaffoldSucceeded = result?.scaffoldOk === true;
        this.#jobs.set(
          jobId,
          scaffoldSucceeded ? { slug, status: 'ready' } : { slug, status: 'failed', error: CREATION_FAILED_MESSAGE },
        );
      })
      .catch(() => {
        // AC14: definierter, secret-/pfad-freier Fehlertext — KEIN start.
        this.#jobs.set(jobId, { slug, status: 'failed', error: CREATION_FAILED_MESSAGE });
      })
      .finally(() => {
        if (this.#activeBySlug.get(slug) === jobId) this.#activeBySlug.delete(slug);
      });

    return { ok: true, ready: false, jobId };
  }

  /**
   * Liest den aktuellen Anlage-Status eines Vorbereitungs-Jobs (Poll-fähig).
   * @param {string} jobId
   * @returns {{ slug: string, status: 'creating'|'ready'|'failed', error?: string }|null}
   */
  getStatus(jobId) {
    return this.#jobs.get(jobId) ?? null;
  }
}
