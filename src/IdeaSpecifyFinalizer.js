/**
 * IdeaSpecifyFinalizer — dünner Orchestrator für die Finalisierung eines
 * Idee-Specify-Chats über den echten `/agent-flow:requirement`-Agent, headless
 * (docs/specs/idea-specify-chat.md AC6, AC7, AC8, AC9; Sicherheitsnetz
 * GEHÄRTET durch docs/specs/headless-arg-finalize-safety.md AC4, AC5, AC6, AC8;
 * idea-keyed Status-Registry + synchrone `running`-Registrierung + Doppelstart-
 * Guard je Idee durch docs/specs/idea-specify-background-status.md AC1, AC7).
 *
 * Idea-keyed Sicht (idea-specify-background-status AC1): zusätzlich zur jobId-
 * basierten Registry der `HeadlessFlowRunner`-Instanz hält der Finalizer eine
 * `#lastJobByIdea`-Map (Schlüssel = `projectSlug` + `ideaStoryId`) mit dem
 * ZULETZT gestarteten Finalize-Job je Idee. Der Eintrag wird in `start()`
 * SYNCHRON (kein `await` zwischen Runner-`start()` und `set()`) mit Status
 * `running` gesetzt — reload-fest und unabhängig davon, ob der Client die
 * `202`-Antwort noch verarbeitet (das Overlay ist beim fire-and-forget-Klick
 * schon zu, idea-specify-chat AC10/AC14). Die Read-Sichten `jobsForProject()`/
 * `statusForIdea()` lesen den AKTUELLEN Status stets LIVE über `getJob()`
 * (inkl. Sicherheitsnetz-/`no-op`-Mapping), damit ein terminaler Job nicht als
 * stale `running` hängen bleibt. Der `no-op`-Terminalstatus (headless-arg-
 * finalize-safety AC5 — Idee bleibt sichtbar `Idee`) wird in der idea-keyed
 * Sicht auf `failed` gemappt: aus Board-/Reopen-Sicht ist er ein nicht-`done`,
 * retry-würdiges Ergebnis (Idee unverändert, erneut versuchen).
 *
 * KEIN neuer Runner-Typ (Nicht-Ziel, siehe Spec): nutzt ausschließlich den
 * bestehenden, bewährten `HeadlessFlowRunner` (S-212/S-213) — eine EIGENE
 * Instanz mit EIGENER `ProjectJobLock`-Instanz (Konstruktor-Default von
 * `HeadlessFlowRunner`, `new ProjectJobLock()`), bewusst getrennt von der
 * Flow-/Reconcile-/Nacht-Drain-Lock-Instanz (server.js hält je Boundary eine
 * eigene `HeadlessFlowRunner`, damit sich parallele headless-Läufe NIE
 * gegenseitig blockieren — analog dem bestehenden Nacht-Drain-Kommentar in
 * server.js).
 *
 * `start(projectPath, { draftText, ideaStoryId, projectSlug })` (jetzt ASYNC,
 * headless-arg-finalize-safety AC4):
 *   - Erfasst VOR dem eigentlichen Runner-Start einen **Baseline-Snapshot**
 *     der Board-/Spec-Artefakte des Projekts (`#artifactReader.snapshot()`)
 *     und legt ihn zusammen mit `projectPath`/`projectSlug`/`storyId` in
 *     `#jobMeta[jobId]` ab. Schlägt die Snapshot-Erfassung fehl (FS-Fehler),
 *     wird das best-effort geloggt und `baselineFailed: true` vermerkt — das
 *     Sicherheitsnetz behandelt das fail-safe als `no-op` (lieber eine
 *     sichtbare, nicht archivierte Idee als ein stiller Verlust).
 *   - Baut den Prompt über `buildRequirementPrompt()` (AC8 — genau zwei
 *     angehängte Hinweise, siehe dort) und startet
 *     `runner.start(projectPath, { command: '/agent-flow:requirement',
 *     args: [prompt] })`. Der zusammengesetzte Prompt ist die EINZIGE,
 *     sanitisierte argv-Übergabe an den `requirement`-Lauf (AC8) — argv als
 *     Array (kein Shell-String), identische Sicherheits-Eigenschaften wie
 *     `HeadlessFlowRunner`/`HeadlessRunnerCore` (security/R03).
 *   - `projectSlug` wird NICHT an den Runner weitergereicht (der braucht nur
 *     den bereits aufgelösten `projectPath`) — er wird ausschließlich für das
 *     Sicherheitsnetz (`BoardWriter.archiveSupersededIdea({ projectSlug, ... })`,
 *     AC9) intern vorgehalten (`#jobMeta`), da `BoardWriter` erneut per Slug
 *     auflöst (eigene Pfad-Sicherheits-Schranke, siehe `BoardWriter.js`).
 *
 * `getJob(jobId)` (AC7 — Status-Endpunkt-Quelle): liest den Job-Status aus der
 * `HeadlessFlowRunner`-Job-Registry. Sobald ein Job zum ERSTEN Mal als `done`
 * beobachtet wird, läuft EINMALIG (Race-frei über `#safetyNetChecked`-Set,
 * synchroner Check-and-flag VOR dem `await`, kein Interleaving in Node) das
 * Sicherheitsnetz (siehe `#runSafetyNet()`):
 *
 *   - **Fall (a)** — mindestens eine neue Story-/Feature-/Spec-Datei ist seit
 *     dem Baseline-Snapshot entstanden UND die Idee trägt (noch) `status: Idee`:
 *     `BoardWriter.archiveSupersededIdea()` patcht die Idee-Story auf
 *     `status: Done` (unverändertes Verhalten von idea-specify-chat AC9).
 *   - **Fall (b)** — die Idee ist NICHT mehr `status: Idee` (der Agent hat sie
 *     selbst übernommen/aufgelöst, best effort AC8) — egal ob dabei zusätzlich
 *     eine neue Datei entstand: erwartetes No-Op, Job bleibt `done` (echte
 *     Arbeit wurde geleistet). Wirft `archiveSupersededIdea()` in diesem Fall
 *     `not-resolvable`, wird das als erwartetes No-Op geschluckt.
 *   - **Fall (c)** — WEDER neue Datei entstanden NOCH Idee-Transformation
 *     (der reproduzierte Fehlerfall, headless-arg-finalize-safety AC5): KEINE
 *     Archivierung, die Idee bleibt sichtbar `Idee`. Der Job-Status wird für
 *     `getJob()` auf den eigenen Terminalstatus **`no-op`** gemappt (secret-
 *     freie Meldung, genau EIN `AuditStore`-Eintrag, AC6) — der zugrunde-
 *     liegende `HeadlessFlowRunner`/`HeadlessRunnerCore`-Job-Status selbst
 *     bleibt dabei unverändert `done` (Mapping ausschließlich hier).
 *   - Schlägt die Snapshot-/Status-Verifikation selbst fehl (FS-Fehler) →
 *     fail-safe wie Fall (c): `no-op` statt archivieren.
 *
 *   Jeder unerwartete `archiveSupersededIdea()`-Fehler (weder `not-resolvable`
 *   noch Erfolg) wird best-effort geloggt (kein Crash des Status-Endpunkts) —
 *   das Sicherheitsnetz ist ein Sicherheitsnetz, kein zusätzlicher Fehlerpfad
 *   für den Owner.
 *
 * Job-Registry: lebt in der injizierten/erzeugten `HeadlessFlowRunner`-Instanz
 * (In-Memory, geht bei Server-Neustart verloren — Nicht-Ziel, wie bei allen
 * bestehenden headless-Runnern). Der `no-op`-Status/Baseline-Snapshot lebt
 * ausschließlich in dieser `IdeaSpecifyFinalizer`-Instanz (`#jobMeta`/
 * `#noOpJobs`) — geht ebenfalls bei Neustart verloren (Nicht-Ziel).
 *
 * Security (Floor): kein Secret/Token/Host-Pfad in Logs; `runner`/`boardWriter`/
 * `artifactReader`/`auditStore` injizierbar (Test-Entkopplung, kein echter
 * `claude`-Lauf, kein echtes fs nötig). Der Default-`artifactReader` liest
 * ausschließlich innerhalb des bereits validierten `projectPath` (feste
 * Unterverzeichnisse `board/stories`, `board/features`, `docs/specs` — kein
 * Traversal möglich, AC4/AC8).
 *
 * @module IdeaSpecifyFinalizer
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HeadlessFlowRunner } from './HeadlessFlowRunner.js';
import { BoardWriter, BoardWriterError } from './BoardWriter.js';

/** Der einzige `/agent-flow:...`-Befehl, den dieser Finalizer je auslöst (AC6). */
export const REQUIREMENT_COMMAND = '/agent-flow:requirement';

/** AC8, Hinweis (a) — mildert das headless-Ohne-Rückfrage-Risiko (Spec §Verhalten Punkt 8). */
const NO_QUESTIONS_HINT =
  'Alle nötigen Informationen liegen bereits vor — bitte nicht nachfragen, sondern mit sinnvollen Annahmen weiterarbeiten.';

/**
 * AC8, Hinweis (b) — best effort, kein Garant (Spec §Verhalten Punkt 8).
 * @param {string} ideaStoryId
 * @returns {string}
 */
function _reuseIdeaHint(ideaStoryId) {
  return `Es existiert bereits eine Platzhalter-Idee ${ideaStoryId} in board/stories/. Übernimm nach Möglichkeit genau diese Story-ID/-Datei, statt eine neue anzulegen.`;
}

/**
 * Baut den `requirement`-Prompt: `draftText` + GENAU zwei angehängte Hinweise
 * (AC8). Der zusammengesetzte String ist die einzige, sanitisierte Argument-/
 * stdin-Übergabe an den headless `requirement`-Lauf — kein weiteres
 * Spec-Format-Wissen wird hier hinzugefügt (Nicht-Ziel, siehe Spec).
 *
 * @param {object} params
 * @param {unknown} params.draftText  Der vom Chat gelieferte, bereits vom
 *   Owner-Gespräch geschärfte Anforderungstext (idea-specify-chat AC5/AC13).
 * @param {unknown} params.ideaStoryId  Story-ID der Platzhalter-Idee, z.B. "S-900".
 * @returns {string}
 */
export function buildRequirementPrompt({ draftText, ideaStoryId }) {
  const trimmedDraft = typeof draftText === 'string' ? draftText.trim() : '';
  const parts = [trimmedDraft, NO_QUESTIONS_HINT, _reuseIdeaHint(String(ideaStoryId ?? ''))];
  return parts.filter((part) => part !== '').join('\n\n');
}

/**
 * Secret-freie No-Op-Meldung (headless-arg-finalize-safety AC5) — wird über
 * `getJob()` als `error`-Feld ausgeliefert, analog zu `failed`/`auth-expired`.
 */
export const NO_OP_MESSAGE =
  'Es ist kein Feature/keine Story entstanden — die Idee bleibt unverändert, bitte erneut versuchen.';

/** Die drei Artefakt-Verzeichnisse, deren Dateimenge der Baseline-Snapshot erfasst (AC4). */
const ARTIFACT_SUBDIRS = Object.freeze({
  stories: ['board', 'stories'],
  features: ['board', 'features'],
  specs: ['docs', 'specs'],
});

/**
 * Liest den Top-Level-Wert eines Skalar-Feldes aus rohem YAML-Inhalt (schmaler
 * Read-only-Parser, analog `BoardWriter.js`s privatem `_extractTopLevelField`,
 * hier bewusst dupliziert statt importiert — dieses Modul liest nur, es teilt
 * sich keine Schreib-Invarianten mit `BoardWriter`).
 *
 * @param {string} content
 * @param {string} key
 * @returns {string|null}
 */
function _extractYamlField(content, key) {
  for (const line of content.split('\n')) {
    if (!line || line[0] === ' ' || line[0] === '\t') continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(\s.*)?$/);
    if (!m || m[1] !== key) continue;
    let v = line.slice(line.indexOf(':') + 1).trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return null;
}

/**
 * Default-`artifactReader` (AC4/AC8): liest ausschließlich innerhalb des
 * bereits validierten `projectPath` — feste Unterverzeichnisse, kein
 * User-Input im Pfad, kein Traversal möglich.
 */
const DEFAULT_ARTIFACT_READER = {
  /**
   * Erfasst die Dateimenge je Artefakt-Verzeichnis (AC4). Ein fehlendes/nicht
   * lesbares Verzeichnis wird als leere Menge behandelt (best-effort, kein Crash).
   *
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

  /**
   * Liest den aktuellen `status:`-Wert der Story mit `id: storyId` unter
   * `board/stories/` — `null`, wenn nicht gefunden/nicht lesbar.
   *
   * @param {string} projectPath
   * @param {string} storyId
   * @returns {Promise<string|null>}
   */
  async readIdeaStatus(projectPath, storyId) {
    const storiesDir = join(projectPath, 'board', 'stories');
    let entries;
    try {
      entries = await readdir(storiesDir);
    } catch {
      return null;
    }
    for (const name of entries) {
      if (!name.endsWith('.yaml')) continue;
      let raw;
      try {
        raw = await readFile(join(storiesDir, name), 'utf8');
      } catch {
        continue;
      }
      if (_extractYamlField(raw, 'id') === storyId) {
        return _extractYamlField(raw, 'status');
      }
    }
    return null;
  },
};

/**
 * Vergleicht Baseline- gegen Nach-Snapshot: `true`, sobald mindestens EINE
 * Datei in irgendeinem Artefakt-Verzeichnis neu hinzugekommen ist (AC4).
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
 * IdeaSpecifyFinalizer — startet + überwacht genau EINEN headless
 * `requirement`-Lauf je `start()`-Aufruf und trägt das gehärtete
 * Sicherheitsnetz (headless-arg-finalize-safety AC4-AC6).
 */
export class IdeaSpecifyFinalizer {
  /** @type {{ start: Function, getJob: Function }} */
  #runner;
  /** @type {BoardWriter} */
  #boardWriter;
  /** @type {{ snapshot: Function, readIdeaStatus: Function }} */
  #artifactReader;
  /** @type {import('./AuditStore.js').AuditStore|null} */
  #auditStore;
  /**
   * @type {Map<string, { projectSlug: string, storyId: string, projectPath: string,
   *   baselineSnapshot: Record<string, Set<string>>|null, baselineFailed: boolean }>}
   * jobId -> Idee-/Snapshot-Kontext für das Sicherheitsnetz (AC4).
   */
  #jobMeta = new Map();
  /** @type {Set<string>} jobIds, für die das Sicherheitsnetz bereits (versucht) gelaufen ist — genau EINMAL je Job. */
  #safetyNetChecked = new Set();
  /** @type {Map<string, string>} jobId -> secret-freie No-Op-Meldung (AC5) — einmal gesetzt, bleibt stabil. */
  #noOpJobs = new Map();
  /**
   * @type {Map<string, { status: string, jobId: string, projectSlug: string, ideaStoryId: string }>}
   * Idea-keyed Sicht (idea-specify-background-status AC1): `#ideaKey(slug, id)` ->
   * ZULETZT gestarteter Finalize-Job dieser Idee. In-Memory (Verlust bei
   * Neustart = Nicht-Ziel, wie die jobId-Registry). Der gespeicherte `status`
   * ist der Registrierungs-Status (`running`); die Read-Sichten resolven den
   * aktuellen Status stets LIVE über `getJob()`.
   */
  #lastJobByIdea = new Map();

  /**
   * @param {object} [params]
   * @param {{ start: Function, getJob: Function }} [params.runner] - injectable
   *   Runner (default: EIGENE `HeadlessFlowRunner`-Instanz mit EIGENER,
   *   frischer `ProjectJobLock`-Instanz — Konstruktor-Default, s.o.). Inject ein
   *   Test-Double, um `HeadlessFlowRunner` selbst NICHT erneut zu testen (dessen
   *   eigene Testsuite deckt spawn/env/timeout/lock/close bereits ab).
   * @param {BoardWriter} [params.boardWriter] - injectable (default: `new BoardWriter()`).
   * @param {{ snapshot: Function, readIdeaStatus: Function }} [params.artifactReader] -
   *   injectable Board-/FS-Reader (AC4, Test-Entkopplung — Default: echtes fs
   *   innerhalb des validierten `projectPath`).
   * @param {import('./AuditStore.js').AuditStore} [params.auditStore] - injectable
   *   (AC6 — No-Op-Audit-Eintrag; ohne Injection wird kein Audit-Eintrag geschrieben).
   * @param {Function} [params.spawnFn] - nur wirksam wenn `runner` NICHT übergeben
   *   wird — durchgereicht an den intern erzeugten `HeadlessFlowRunner`
   *   (Test-Entkopplung: der ECHTE Default-Konstruktions-Pfad kann so mit einem
   *   Fake-`spawnFn` statt einem echten `claude`-Prozess geprüft werden — u.a.
   *   für die Lock-Trennungs-Tests).
   * @param {number} [params.timeoutMs] - nur wirksam wenn `runner` NICHT übergeben wird.
   * @param {import('./ProjectJobLock.js').ProjectJobLock} [params.lock] - nur
   *   wirksam wenn `runner` NICHT übergeben wird. Wird NIE von server.js gesetzt
   *   — der Konstruktor-Default von `HeadlessFlowRunner` (`new ProjectJobLock()`)
   *   garantiert bereits die geforderte Lock-Trennung (AC6); dieser Parameter
   *   existiert nur für Tests.
   */
  constructor({ runner, boardWriter, artifactReader, auditStore, spawnFn, timeoutMs, lock } = {}) {
    this.#runner = runner ?? new HeadlessFlowRunner({ command: REQUIREMENT_COMMAND, spawnFn, timeoutMs, lock });
    this.#boardWriter = boardWriter ?? new BoardWriter();
    this.#artifactReader = artifactReader ?? DEFAULT_ARTIFACT_READER;
    this.#auditStore = auditStore ?? null;
  }

  /**
   * Startet den headless `requirement`-Finalizer-Lauf (AC6, idea-specify-chat).
   * Erfasst VOR dem Runner-Start den Baseline-Snapshot (headless-arg-finalize-safety AC4).
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad
   *   (Router löst Slug→Pfad NICHT erneut auf — nutzt den bereits vertrauens-
   *   würdigen `repo_path` aus dem Board-Index, analog `boardRouter.js` .../discuss).
   * @param {object} params
   * @param {unknown} params.draftText
   * @param {string} params.ideaStoryId
   * @param {string} params.projectSlug - für das Sicherheitsnetz vorgehalten,
   *   NICHT an den Runner weitergereicht.
   * @returns {Promise<{ ok: true, jobId: string } | { ok: false, reason: 'locked'|'idea-locked' }>}
   */
  async start(projectPath, { draftText, ideaStoryId, projectSlug }) {
    const ideaKey = this.#ideaKey(projectSlug, ideaStoryId);

    // AC7 (idea-specify-background-status): höchstens EIN aktiver Finalize je
    // Idee. Läuft für dieselbe Idee bereits ein Job (`running`), wird der
    // zweite Start abgelehnt — SYNCHRON, BEVOR ein Kindprozess spawnt (kein
    // `await` vor dieser Prüfung) — zusätzlich zum projekt-weiten
    // `ProjectJobLock` des Runners (idea-specify-chat AC6).
    if (this.#hasRunningJobForIdea(ideaKey)) {
      return { ok: false, reason: 'idea-locked' };
    }

    let baselineSnapshot = null;
    let baselineFailed = false;
    try {
      baselineSnapshot = await this.#artifactReader.snapshot(projectPath);
    } catch (err) {
      baselineFailed = true;
      // Fail-safe (Spec-Edge-Case): eine fehlgeschlagene Baseline-Erfassung
      // führt später zu `no-op` statt einer möglichen Fehl-Archivierung.
      console.error('[IdeaSpecifyFinalizer] Baseline-Snapshot fehlgeschlagen (fail-safe: no-op):', err.message);
    }

    const prompt = buildRequirementPrompt({ draftText, ideaStoryId });
    const result = this.#runner.start(projectPath, { command: REQUIREMENT_COMMAND, args: [prompt] });
    if (result.ok) {
      this.#jobMeta.set(result.jobId, {
        projectSlug,
        storyId: ideaStoryId,
        projectPath,
        baselineSnapshot,
        baselineFailed,
      });
      // AC1 (idea-specify-background-status): idea-keyed `running`-Registrierung
      // SYNCHRON direkt nach dem Spawn-Start — kein `await` zwischen
      // `runner.start()` (spawnt den Kindprozess) und diesem `set()`, also
      // atomar aus Sicht jedes Beobachters (ein `jobs`-/`status`-Poll kann erst
      // laufen, nachdem `start()` awaited/zurückgekehrt ist). Damit ist der
      // Lauf reload-fest sichtbar, unabhängig von der Client-Verarbeitung der 202.
      this.#lastJobByIdea.set(ideaKey, {
        status: 'running',
        jobId: result.jobId,
        projectSlug,
        ideaStoryId,
      });
    }
    return result;
  }

  /**
   * Composite-Key der idea-keyed Registry: `projectSlug` + NUL + `ideaStoryId`.
   * Beide Bestandteile sind Router-validiert (SLUG_RE/STORY_ID_RE — kein
   * NUL-Byte) und werden NIE als Dateisystem-Pfad verwendet (reiner Map-Key).
   *
   * @param {string} projectSlug
   * @param {string} ideaStoryId
   * @returns {string}
   */
  #ideaKey(projectSlug, ideaStoryId) {
    return `${projectSlug}\u0000${ideaStoryId}`;
  }

  /**
   * `true`, wenn für die Idee bereits ein Job `running` ist (AC7). Liest den
   * AKTUELLEN Runner-Status SYNCHRON (kein Sicherheitsnetz nötig — `no-op`
   * betrifft nur `done`-Jobs, nie `running`). Ein terminaler/unbekannter
   * (nach Neustart weggefallener) Vor-Job zählt NICHT als laufend.
   *
   * @param {string} ideaKey
   * @returns {boolean}
   */
  #hasRunningJobForIdea(ideaKey) {
    const entry = this.#lastJobByIdea.get(ideaKey);
    if (!entry) return false;
    const job = this.#runner.getJob(entry.jobId);
    return job?.status === 'running';
  }

  /**
   * Liest den Job-Status (AC7) und löst — genau einmal je Job, beim ERSTEN
   * Beobachten von `status: 'done'` — das Sicherheitsnetz aus. Ergibt die
   * Verifikation Fall (c) (headless-arg-finalize-safety AC5), wird der
   * zurückgegebene Status auf `no-op` gemappt — der zugrundeliegende Runner-
   * Job-Status selbst bleibt unverändert `done`.
   *
   * @param {string} jobId
   * @returns {Promise<{ status: 'running'|'done'|'failed'|'auth-expired'|'no-op', result?: string, error?: string } | undefined>}
   */
  async getJob(jobId) {
    const job = this.#runner.getJob(jobId);
    if (!job) return undefined;

    // Synchroner Check-and-flag VOR dem `await` — Node ist single-threaded,
    // kein Interleaving zwischen zwei "gleichzeitigen" getJob()-Aufrufen für
    // denselben jobId (analog dem `settled`-Flag-Muster in HeadlessRunnerCore).
    if (job.status === 'done' && !this.#safetyNetChecked.has(jobId)) {
      this.#safetyNetChecked.add(jobId);
      await this.#runSafetyNet(jobId);
    }

    if (job.status === 'done' && this.#noOpJobs.has(jobId)) {
      return { ...job, status: 'no-op', error: this.#noOpJobs.get(jobId) };
    }

    return job;
  }

  /**
   * Idea-keyed Sicht aller NICHT-`done` Finalize-Jobs eines Projekts (idea-
   * specify-background-status AC2) — je Idee der letzte Job, sofern er noch
   * `running`/`failed`/`auth-expired` ist. `done`-Jobs werden ausgelassen (die
   * Idee-Karte ist dann ohnehin übernommen/archiviert). `no-op` wird auf
   * `failed` gemappt (Idee bleibt `Idee` → Fehler-Badge, AC4). Speist den
   * projektweiten Board-Hydration-/Polling-Endpunkt. Degradiert robust: ein
   * nach Neustart weggefallener Job (kein Runner-Eintrag) wird still ausgelassen.
   *
   * @param {string} projectSlug
   * @returns {Promise<Record<string, { status: 'running'|'failed'|'auth-expired', jobId: string, error?: string }>>}
   */
  async jobsForProject(projectSlug) {
    const jobs = {};
    for (const entry of this.#lastJobByIdea.values()) {
      if (entry.projectSlug !== projectSlug) continue;
      const view = await this.#ideaJobView(entry.jobId);
      if (!view || view.status === 'done') continue;
      jobs[entry.ideaStoryId] = view;
    }
    return jobs;
  }

  /**
   * Letzter bekannter Finalize-Job EINER Idee (idea-specify-background-status
   * AC2) — für das Overlay-Reopen. `done` bleibt erhalten (Reopen entscheidet:
   * `done`/`null` → frischer Chat-Einstieg, AC6); `no-op` → `failed`. `null`,
   * wenn nie ein Finalize für diese Idee lief ODER der Job-Eintrag nach einem
   * Neustart weggefallen ist.
   *
   * @param {string} projectSlug
   * @param {string} ideaStoryId
   * @returns {Promise<{ status: 'running'|'done'|'failed'|'auth-expired', jobId: string, error?: string } | null>}
   */
  async statusForIdea(projectSlug, ideaStoryId) {
    const entry = this.#lastJobByIdea.get(this.#ideaKey(projectSlug, ideaStoryId));
    if (!entry) return null;
    const view = await this.#ideaJobView(entry.jobId);
    return view ?? null;
  }

  /**
   * Baut die schmale idea-keyed Job-Sicht aus dem LIVE-Status (`getJob()`,
   * inkl. Sicherheitsnetz-/`no-op`-Mapping). `no-op` → `failed`. `null`, wenn
   * der Runner den Job nicht (mehr) kennt.
   *
   * @param {string} jobId
   * @returns {Promise<{ status: string, jobId: string, error?: string } | null>}
   */
  async #ideaJobView(jobId) {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const status = job.status === 'no-op' ? 'failed' : job.status;
    const view = { status, jobId };
    if (job.error !== undefined) view.error = job.error;
    return view;
  }

  /**
   * Sicherheitsnetz (headless-arg-finalize-safety AC4/AC5): verifiziert, ob
   * seit dem Baseline-Snapshot tatsächlich ein neues Board-/Spec-Artefakt
   * entstanden ist, BEVOR archiviert wird — Fall (a)/(b)/(c), siehe Modul-Doku.
   *
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  async #runSafetyNet(jobId) {
    const meta = this.#jobMeta.get(jobId);
    if (!meta || !meta.projectSlug || !meta.storyId) return;

    if (meta.baselineFailed) {
      this.#markNoOp(jobId, meta);
      return;
    }

    let afterSnapshot;
    try {
      afterSnapshot = await this.#artifactReader.snapshot(meta.projectPath);
    } catch (err) {
      console.error('[IdeaSpecifyFinalizer] Nach-Snapshot fehlgeschlagen (fail-safe: no-op):', err.message);
      this.#markNoOp(jobId, meta);
      return;
    }

    if (_hasNewArtifact(meta.baselineSnapshot, afterSnapshot)) {
      // Fall (a)/(b): mindestens eine neue Artefakt-Datei — archivieren
      // versuchen; `not-resolvable` (Idee nicht mehr `Idee`) ist Fall (b),
      // ein erwartetes No-Op.
      try {
        await this.#boardWriter.archiveSupersededIdea({
          projectSlug: meta.projectSlug,
          storyId: meta.storyId,
        });
      } catch (err) {
        if (err instanceof BoardWriterError && err.errorClass === 'not-resolvable') {
          // Fall (b): der Agent hat die Platzhalter-Idee bereits selbst
          // übernommen/aufgelöst (best effort) — kein zweiter Write nötig.
          return;
        }
        // Best-effort: kein Secret/Host-Pfad im Log (security/R01), kein Crash.
        console.error('[IdeaSpecifyFinalizer] Sicherheitsnetz-Archivierung fehlgeschlagen:', err.message);
      }
      return;
    }

    // Keine neue Artefakt-Datei — unterscheide Fall (b) (Idee wurde dennoch
    // vom Agenten transformiert) von Fall (c) (wirklich nichts passiert).
    let ideaStatus;
    try {
      ideaStatus = await this.#artifactReader.readIdeaStatus(meta.projectPath, meta.storyId);
    } catch (err) {
      console.error('[IdeaSpecifyFinalizer] Idee-Status-Lesung fehlgeschlagen (fail-safe: no-op):', err.message);
      this.#markNoOp(jobId, meta);
      return;
    }

    if (ideaStatus !== 'Idee') {
      // Fall (b): Idee nicht mehr `Idee` — echte Arbeit wurde geleistet, kein No-Op.
      return;
    }

    // Fall (c): weder neue Datei noch Idee-Transformation — kein Archivieren,
    // Idee bleibt sichtbar `Idee`, Job-Status wird auf `no-op` gemappt (AC5/AC6).
    this.#markNoOp(jobId, meta);
  }

  /**
   * Markiert einen Job als `no-op` (idempotent — nur beim ersten Aufruf wird
   * auditiert) und schreibt genau EINEN secret-freien `AuditStore`-Eintrag (AC6).
   *
   * @param {string} jobId
   * @param {{ projectSlug: string, storyId: string }} meta
   * @returns {void}
   */
  #markNoOp(jobId, meta) {
    if (this.#noOpJobs.has(jobId)) return;
    this.#noOpJobs.set(jobId, NO_OP_MESSAGE);

    if (this.#auditStore) {
      try {
        this.#auditStore.record({
          identity: null,
          command: `board:idea:specify:finalize:no-op:${meta.projectSlug}:${meta.storyId}`,
        });
      } catch (err) {
        console.error('[IdeaSpecifyFinalizer] Audit-Write (no-op) fehlgeschlagen:', err.message);
      }
    }
  }
}
