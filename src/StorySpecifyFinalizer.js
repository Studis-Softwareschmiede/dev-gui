/**
 * StorySpecifyFinalizer — schlanke „from scratch"-Schwester-Boundary des
 * `IdeaSpecifyFinalizer` für den Neue-Story-Chat (docs/specs/new-story-chat.md
 * AC4, AC5, AC8), erweitert um die Sichtbarkeit des Finalize-Laufs
 * (docs/specs/story-specify-finalize-visibility.md AC1, AC2, AC3).
 *
 * Diese Spec ist die „from scratch"-Variante von idea-specify-chat: Feature +
 * Story werden von Grund auf angelegt — es existiert KEINE vorgelagerte
 * Idee-Karte. Deshalb unterscheidet sich dieser Finalizer vom
 * `IdeaSpecifyFinalizer` durch:
 *   1. den **Prompt**: `buildRequirementPrompt()` hängt an den `draftText`
 *      AUSSCHLIESSLICH den „nicht-nachfragen"-Hinweis an — KEIN
 *      `ideaStoryId`-Übernahme-Hinweis (es gibt keine Platzhalter-Idee).
 *   2. das **fehlende `archiveSupersededIdea`-Sicherheitsnetz**: es existiert
 *      keine Idee-Story, die verwaisen könnte — also **KEIN `BoardWriter`,
 *      KEIN Schreibpfad**. Die No-Op-Erkennung ist rein **read-only**.
 *
 * ── Sichtbarkeit des Finalize-Laufs (story-specify-finalize-visibility) ──
 *
 * **No-Op-Erkennung read-only per Snapshot-Diff (AC1).** Ein headless
 * `/agent-flow:requirement`-Lauf kann sauber (Exit 0) enden, ohne etwas anzulegen
 * (z.B. transienter Auth-Aussetzer → der Agent gab nur Text aus). Der Runner
 * meldet dann `done`, obwohl **nichts** entstand — der stille blinde Fleck aus
 * dem Live-Test. Deshalb nimmt `start()` einen **read-only Snapshot** der
 * Story-/Feature-Datei-Menge des Projekts und bildet nach Runner-`done` den
 * **Diff**: kam **keine** neue Story (und **kein** neues Feature) hinzu →
 * Terminalstatus **`no-op`** (secret-freie Kurzmeldung); kam ≥1 neue Story/
 * neues Feature hinzu → `done`. **KEIN `BoardWriter`/Schreibpfad** (read-only,
 * ADR-005-Linie). Schlägt der Snapshot-Read fehl → **sichere Degradierung zu
 * `done`** (kein Crash, kein blockierter Lauf) — anders als beim
 * `IdeaSpecifyFinalizer`, dessen fail-safe zu `no-op` degradiert, um eine
 * verwaiste Idee zu schützen; hier existiert keine solche Idee (AC1).
 *
 * **Terminal-Status-Klassifizierung (AC2).** `getJob(jobId)` liefert
 * `status ∈ {running, done, no-op, failed, auth-expired}` mit `done`
 * **ausschließlich** bei tatsächlich angelegter Story (No-Op-Diff). Format
 * ansonsten 1:1 wie der bestehende idea-specify-/Reconcile-Status-Endpunkt;
 * secret-/token-/host-pfad-frei.
 *
 * **Projekt-keyed Last-Finalize-Registry (AC3).** Zusätzlich zur jobId-Registry
 * der `HeadlessFlowRunner`-Instanz hält der Finalizer eine `#lastJobByProject`-
 * Map (Schlüssel = `projectSlug`) mit dem ZULETZT gestarteten Finalize-Job je
 * Projekt. Der Eintrag wird in `start()` **synchron** (kein `await` zwischen
 * Runner-`start()` und `set()`) mit Status `running` gesetzt — reload-fest und
 * unabhängig davon, ob der Client die `202`-Antwort noch verarbeitet oder das
 * Overlay bereits geschlossen/neu geladen wurde. `lastForProject()` liest den
 * AKTUELLEN Status stets LIVE über `getJob()` (inkl. `no-op`-Mapping), damit ein
 * terminaler Job nicht als stale `running` hängen bleibt. In-Memory (Verlust bei
 * Server-Neustart = Nicht-Ziel, wie alle bestehenden Runner-Registries).
 *
 * KEIN neuer Runner-Typ (new-story-chat Nicht-Ziel / AC8): nutzt ausschließlich
 * den bestehenden `HeadlessFlowRunner` — eine EIGENE Instanz mit EIGENER
 * `ProjectJobLock`-Instanz (Konstruktor-Default von `HeadlessFlowRunner`,
 * `new ProjectJobLock()`), bewusst getrennt von Flow-/Reconcile-/Nacht-Drain-/
 * `IdeaSpecifyFinalizer`-Lock: server.js hält je Boundary eine eigene Instanz,
 * damit sich parallele headless-Läufe NIE gegenseitig blockieren (AC4 —
 * „getrennt von allen anderen Locks", sonst Selbstblockade). Ein zweiter
 * Finalize für DASSELBE Projekt wird über das projekt-weite `ProjectJobLock`
 * des Runners abgewiesen (`{ ok:false, reason:'locked' }` → Router-`409`).
 *
 * Security (Floor): der zusammengesetzte Prompt ist die EINZIGE, sanitisierte
 * argv-Übergabe an den `requirement`-Lauf (argv als Array, kein Shell-String —
 * identische Sicherheits-Eigenschaften wie `HeadlessFlowRunner`/
 * `HeadlessRunnerCore`, security/R03). Harter `ANTHROPIC_API_KEY`/
 * `OPENAI_API_KEY`-Block liegt im `HeadlessRunnerCore` (`buildChildEnv`). Kein
 * Secret/Token/Host-Pfad in Logs/Response — auch die No-Op-Kurzmeldung ist eine
 * feste, secret-freie Konstante. Der Default-`artifactReader` liest
 * ausschließlich innerhalb des bereits validierten `projectPath` (feste
 * Unterverzeichnisse `board/stories`, `board/features` — kein User-Input im
 * Pfad, kein Traversal möglich). `runner`/`artifactReader` injizierbar
 * (Test-Entkopplung, kein echter `claude`-Lauf, kein echtes fs nötig).
 *
 * @module StorySpecifyFinalizer
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HeadlessFlowRunner } from './HeadlessFlowRunner.js';

/** Der einzige `/agent-flow:...`-Befehl, den dieser Finalizer je auslöst (AC4). */
export const REQUIREMENT_COMMAND = '/agent-flow:requirement';

/**
 * new-story-chat AC4/Regel 6 — mildert das headless-Ohne-Rückfrage-Risiko
 * (Spec §Verhalten Punkt 6). Der EINZIGE angehängte Hinweis — bewusst OHNE
 * `ideaStoryId`-Übernahme-Hinweis (es existiert keine Platzhalter-Idee).
 */
const NO_QUESTIONS_HINT =
  'Alle nötigen Informationen liegen bereits vor — bitte nicht nachfragen, sondern mit sinnvollen Annahmen weiterarbeiten.';

/**
 * Secret-freie No-Op-Kurzmeldung (story-specify-finalize-visibility AC1) — wird
 * über `getJob()`/`lastForProject()` als `error`-Feld ausgeliefert, analog zu
 * `failed`/`auth-expired`. Feste Konstante, kein Runner-Output eingebettet.
 */
export const NO_OP_MESSAGE = 'Der Lauf hat keine Story angelegt — bitte erneut versuchen.';

/**
 * Die Artefakt-Verzeichnisse, deren Dateimenge der read-only Snapshot erfasst
 * (AC1). Story-IDs sind der primäre Erfolgs-Marker; ein neues Feature (ohne
 * neue Story) zählt ebenfalls als echte Arbeit (Spec V1: „keine neue Story
 * **und kein neues Feature**" → `no-op`).
 */
const ARTIFACT_SUBDIRS = Object.freeze({
  stories: ['board', 'stories'],
  features: ['board', 'features'],
});

/**
 * Default-`artifactReader` (AC1): read-only Snapshot der Datei-Menge je
 * Artefakt-Verzeichnis INNERHALB des bereits validierten `projectPath` — feste
 * Unterverzeichnisse, kein User-Input im Pfad, kein Traversal möglich. Ein
 * fehlendes/nicht lesbares Verzeichnis wird als leere Menge behandelt
 * (best-effort, kein Crash) — ein komplett fehlgeschlagener Read (throw) wird
 * vom Aufrufer als sichere Degradierung zu `done` behandelt (AC1).
 */
const DEFAULT_ARTIFACT_READER = {
  /**
   * @param {string} projectPath
   * @returns {Promise<Record<string, Set<string>>>}
   */
  async snapshot(projectPath) {
    const result = {};
    for (const [key, segments] of Object.entries(ARTIFACT_SUBDIRS)) {
      try {
        const entries = await readdir(join(projectPath, ...segments));
        result[key] = new Set(entries);
      } catch {
        result[key] = new Set();
      }
    }
    return result;
  },
};

/**
 * Vergleicht Baseline- gegen Nach-Snapshot: `true`, sobald mindestens EINE
 * Datei in irgendeinem Artefakt-Verzeichnis neu hinzugekommen ist (AC1 —
 * echte Arbeit → `done`). Kein `baseline` (Snapshot-Erfassung schlug fehl) →
 * `false` wird NICHT hier entschieden; der Aufrufer degradiert in dem Fall
 * separat sicher zu `done` (siehe `#runNoOpDiff`).
 *
 * @param {Record<string, Set<string>>|null} baseline
 * @param {Record<string, Set<string>>} after
 * @returns {boolean}
 */
function _hasNewArtifact(baseline, after) {
  if (!baseline) return false;
  for (const key of Object.keys(after)) {
    const beforeSet = baseline[key] ?? new Set();
    for (const name of after[key]) {
      if (!beforeSet.has(name)) return true;
    }
  }
  return false;
}

/**
 * Baut den `requirement`-Prompt: `draftText` + GENAU EIN angehängter Hinweis
 * (der „nicht-nachfragen"-Hinweis, AC4/Regel 6). KEIN Idee-Bezug (AC8) —
 * kein weiteres Spec-Format-Wissen wird hier hinzugefügt (Nicht-Ziel: Feature/
 * Story/Spec legt ausschließlich der `requirement`-Agent an).
 *
 * @param {object} params
 * @param {unknown} params.draftText  Der vom Chat gelieferte, bereits vom
 *   Owner-Gespräch geschärfte Anforderungstext (idea-specify-chat AC5/AC13).
 * @returns {string}
 */
export function buildRequirementPrompt({ draftText }) {
  const trimmedDraft = typeof draftText === 'string' ? draftText.trim() : '';
  return [trimmedDraft, NO_QUESTIONS_HINT].filter((part) => part !== '').join('\n\n');
}

/**
 * StorySpecifyFinalizer — startet genau EINEN headless `requirement`-Lauf je
 * `start()`-Aufruf, „from scratch" (ohne Idee-Bezug, ohne Sicherheitsnetz),
 * mit read-only No-Op-Erkennung + projekt-keyed Last-Finalize-Registry.
 */
export class StorySpecifyFinalizer {
  /** @type {{ start: Function, getJob: Function }} */
  #runner;
  /** @type {{ snapshot: Function }} */
  #artifactReader;
  /**
   * @type {Map<string, { projectPath: string, baselineSnapshot: Record<string, Set<string>>|null, baselineFailed: boolean }>}
   * jobId -> Snapshot-Kontext für den No-Op-Diff (AC1).
   */
  #jobMeta = new Map();
  /** @type {Set<string>} jobIds, für die der No-Op-Diff bereits (versucht) gelaufen ist — genau EINMAL je Job. */
  #noOpChecked = new Set();
  /** @type {Map<string, string>} jobId -> secret-freie No-Op-Meldung (AC1) — einmal gesetzt, bleibt stabil. */
  #noOpJobs = new Map();
  /**
   * @type {Map<string, { status: string, jobId: string }>}
   * Projekt-keyed Sicht (AC3): `projectSlug` -> ZULETZT gestarteter Finalize-Job
   * dieses Projekts. In-Memory (Verlust bei Neustart = Nicht-Ziel). Der
   * gespeicherte `status` ist der Registrierungs-Status (`running`); die
   * Read-Sicht `lastForProject()` resolved den aktuellen Status stets LIVE über
   * `getJob()`.
   */
  #lastJobByProject = new Map();

  /**
   * @param {object} [params]
   * @param {{ start: Function, getJob: Function }} [params.runner] - injectable
   *   Runner (default: EIGENE `HeadlessFlowRunner`-Instanz mit EIGENER,
   *   frischer `ProjectJobLock`-Instanz — Konstruktor-Default, s.o.). Inject ein
   *   Test-Double, um `HeadlessFlowRunner` selbst NICHT erneut zu testen (dessen
   *   eigene Testsuite deckt spawn/env/timeout/lock/close bereits ab).
   * @param {{ snapshot: Function }} [params.artifactReader] - injectable read-only
   *   Board-/FS-Reader (AC1, Test-Entkopplung — Default: echtes fs innerhalb des
   *   validierten `projectPath`).
   * @param {Function} [params.spawnFn] - nur wirksam wenn `runner` NICHT übergeben
   *   wird — durchgereicht an den intern erzeugten `HeadlessFlowRunner`
   *   (Test-Entkopplung: der ECHTE Default-Konstruktions-Pfad kann so mit einem
   *   Fake-`spawnFn` statt einem echten `claude`-Prozess geprüft werden — u.a.
   *   für die Lock-Trennungs-Tests).
   * @param {number} [params.timeoutMs] - nur wirksam wenn `runner` NICHT übergeben wird.
   * @param {import('./ProjectJobLock.js').ProjectJobLock} [params.lock] - nur
   *   wirksam wenn `runner` NICHT übergeben wird. Wird NIE von server.js gesetzt
   *   — der Konstruktor-Default von `HeadlessFlowRunner` (`new ProjectJobLock()`)
   *   garantiert bereits die geforderte Lock-Trennung (AC4); dieser Parameter
   *   existiert nur für Tests.
   */
  constructor({ runner, artifactReader, spawnFn, timeoutMs, lock } = {}) {
    this.#runner = runner ?? new HeadlessFlowRunner({ command: REQUIREMENT_COMMAND, spawnFn, timeoutMs, lock });
    this.#artifactReader = artifactReader ?? DEFAULT_ARTIFACT_READER;
  }

  /**
   * Startet den headless `requirement`-Finalizer-Lauf (AC4). Der zusammengesetzte
   * Prompt (`buildRequirementPrompt`) ist die einzige, sanitisierte argv-Übergabe.
   *
   * Erfasst VOR dem Runner-Start einen read-only Baseline-Snapshot der Story-/
   * Feature-Datei-Menge (AC1) und registriert den Job — direkt nach dem Spawn,
   * SYNCHRON (kein `await` dazwischen) — projekt-keyed mit `running` (AC3).
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad
   *   (Router löst Slug→Pfad NICHT erneut auf — nutzt den bereits vertrauens-
   *   würdigen `repo_path` aus dem Board-Index, analog `ideaSpecifyRouter`).
   * @param {object} params
   * @param {unknown} params.draftText
   * @param {string} [params.projectSlug] - Registry-Schlüssel (AC3). Ohne Slug
   *   wird nur die jobId-Registry gefüllt (kein projekt-keyed Eintrag).
   * @returns {Promise<{ ok: true, jobId: string } | { ok: false, reason: 'locked' }>}
   */
  async start(projectPath, { draftText, projectSlug }) {
    // AC1: read-only Baseline-Snapshot VOR dem Spawn. Schlägt er fehl, wird der
    // Job als `baselineFailed` markiert → der No-Op-Diff degradiert später
    // sicher zu `done` (KEIN Crash, KEIN blockierter Lauf).
    let baselineSnapshot = null;
    let baselineFailed = false;
    try {
      baselineSnapshot = await this.#artifactReader.snapshot(projectPath);
    } catch (err) {
      baselineFailed = true;
      console.error('[StorySpecifyFinalizer] Baseline-Snapshot fehlgeschlagen (degradiert zu done):', err.message);
    }

    const prompt = buildRequirementPrompt({ draftText });
    const result = this.#runner.start(projectPath, { command: REQUIREMENT_COMMAND, args: [prompt] });
    if (result.ok) {
      this.#jobMeta.set(result.jobId, { projectPath, baselineSnapshot, baselineFailed });
      // AC3: projekt-keyed `running`-Registrierung SYNCHRON direkt nach dem
      // Spawn-Start — kein `await` zwischen `runner.start()` (spawnt den
      // Kindprozess) und diesem `set()`, also atomar aus Sicht jedes Beobachters
      // (ein `lastForProject`-Poll kann erst laufen, nachdem `start()` awaited/
      // zurückgekehrt ist). Damit ist der Lauf reload-fest sichtbar, unabhängig
      // von der Client-Verarbeitung der 202.
      if (projectSlug) {
        this.#lastJobByProject.set(projectSlug, { status: 'running', jobId: result.jobId });
      }
    }
    return result;
  }

  /**
   * Liest den Job-Status (AC2) und löst — genau einmal je Job, beim ERSTEN
   * Beobachten von `status: 'done'` — den read-only No-Op-Diff aus (AC1). Kam
   * seit dem Baseline-Snapshot keine neue Story/kein neues Feature hinzu, wird
   * der zurückgegebene Status auf **`no-op`** gemappt — der zugrundeliegende
   * Runner-Job-Status selbst bleibt unverändert `done` (Mapping nur hier).
   *
   * @param {string} jobId
   * @returns {Promise<{ status: 'running'|'done'|'no-op'|'failed'|'auth-expired', result?: string, error?: string, prHint?: string } | undefined>}
   */
  async getJob(jobId) {
    const job = this.#runner.getJob(jobId);
    if (!job) return undefined;

    // Synchroner Check-and-flag VOR dem `await` — Node ist single-threaded,
    // kein Interleaving zwischen zwei "gleichzeitigen" getJob()-Aufrufen für
    // denselben jobId (analog dem `settled`-Flag-Muster in HeadlessRunnerCore).
    if (job.status === 'done' && !this.#noOpChecked.has(jobId)) {
      this.#noOpChecked.add(jobId);
      await this.#runNoOpDiff(jobId);
    }

    if (job.status === 'done' && this.#noOpJobs.has(jobId)) {
      return { ...job, status: 'no-op', error: this.#noOpJobs.get(jobId) };
    }

    return job;
  }

  /**
   * Letzter bekannter Finalize-Job EINES Projekts (AC3) — projekt-keyed, für den
   * Read-Endpunkt (Overlay-Reopen + Board-Hinweis). Der Status wird LIVE über
   * `getJob()` aufgelöst (inkl. `no-op`-Mapping), damit ein terminaler Job nicht
   * als stale `running` erscheint. `null`, wenn nie ein Finalize für dieses
   * Projekt lief ODER der Job-Eintrag nach einem Neustart weggefallen ist.
   *
   * @param {string} projectSlug
   * @returns {Promise<{ status: 'running'|'done'|'no-op'|'failed'|'auth-expired', jobId: string, error?: string } | null>}
   */
  async lastForProject(projectSlug) {
    const entry = this.#lastJobByProject.get(projectSlug);
    if (!entry) return null;

    const job = await this.getJob(entry.jobId);
    if (!job) return null;

    const view = { status: job.status, jobId: entry.jobId };
    if (job.error !== undefined) view.error = job.error;
    return view;
  }

  /**
   * Read-only No-Op-Diff (AC1): re-scannt die Story-/Feature-Datei-Menge und
   * vergleicht mit dem Baseline-Snapshot. Keine neue Datei → `no-op` markieren.
   * Fehlgeschlagene Baseline-/Nach-Snapshot-Erfassung → sichere Degradierung zu
   * `done` (kein `no-op`, kein Crash) — es gibt keine verwaiste Idee, die
   * geschützt werden müsste (Unterschied zum `IdeaSpecifyFinalizer`-Fail-safe).
   *
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  async #runNoOpDiff(jobId) {
    const meta = this.#jobMeta.get(jobId);
    // Kein Snapshot-Kontext (z.B. Job aus einer anderen Quelle) ODER Baseline-
    // Erfassung schlug fehl → sichere Degradierung zu `done`.
    if (!meta || meta.baselineFailed) return;

    let afterSnapshot;
    try {
      afterSnapshot = await this.#artifactReader.snapshot(meta.projectPath);
    } catch (err) {
      // AC1: Snapshot-Read schlägt fehl → sichere Degradierung zu `done`.
      console.error('[StorySpecifyFinalizer] Nach-Snapshot fehlgeschlagen (degradiert zu done):', err.message);
      return;
    }

    if (!_hasNewArtifact(meta.baselineSnapshot, afterSnapshot)) {
      // „durchgelaufen, aber nichts erzeugt" → No-Op (der gemeldete Bug).
      this.#noOpJobs.set(jobId, NO_OP_MESSAGE);
    }
  }
}
