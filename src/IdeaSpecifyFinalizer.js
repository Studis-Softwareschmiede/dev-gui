/**
 * IdeaSpecifyFinalizer — dünner Orchestrator für die Finalisierung eines
 * Idee-Specify-Chats über den echten `/agent-flow:requirement`-Agent, headless
 * (docs/specs/idea-specify-chat.md AC6, AC7, AC8, AC9).
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
 * `start(projectPath, { draftText, ideaStoryId, projectSlug })`:
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
 * Sicherheitsnetz (AC9): `BoardWriter.archiveSupersededIdea()` patcht die
 * ursprüngliche Idee-Story auf `status: Done` — ABER NUR, wenn sie noch
 * `status: Idee` trägt. Wirft `archiveSupersededIdea()` `not-resolvable`
 * (Item ist nicht mehr `Idee` — der Agent hat die Platzhalter-Idee bereits
 * selbst übernommen/aufgelöst, best effort AC8), ist das ein ERWARTETES No-Op,
 * kein Fehler. Jeder andere Fehler wird best-effort geloggt (kein Crash des
 * Status-Endpunkts) — das Sicherheitsnetz ist ein Sicherheitsnetz, kein
 * zusätzlicher Fehlerpfad für den Owner.
 *
 * Job-Registry: lebt in der injizierten/erzeugten `HeadlessFlowRunner`-Instanz
 * (In-Memory, geht bei Server-Neustart verloren — Nicht-Ziel, wie bei allen
 * bestehenden headless-Runnern).
 *
 * Security (Floor): kein Secret/Token/Host-Pfad in Logs; `runner`/`boardWriter`
 * injizierbar (Test-Entkopplung, kein echter `claude`-Lauf, kein echtes fs nötig).
 *
 * @module IdeaSpecifyFinalizer
 */

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
 * IdeaSpecifyFinalizer — startet + überwacht genau EINEN headless
 * `requirement`-Lauf je `start()`-Aufruf und trägt das AC9-Sicherheitsnetz.
 */
export class IdeaSpecifyFinalizer {
  /** @type {{ start: Function, getJob: Function }} */
  #runner;
  /** @type {BoardWriter} */
  #boardWriter;
  /** @type {Map<string, { projectSlug: string, storyId: string }>} jobId -> Idee-Kontext für das Sicherheitsnetz (AC9). */
  #jobMeta = new Map();
  /** @type {Set<string>} jobIds, für die das Sicherheitsnetz bereits (versucht) gelaufen ist — genau EINMAL je Job. */
  #safetyNetChecked = new Set();

  /**
   * @param {object} [params]
   * @param {{ start: Function, getJob: Function }} [params.runner] - injectable
   *   Runner (default: EIGENE `HeadlessFlowRunner`-Instanz mit EIGENER,
   *   frischer `ProjectJobLock`-Instanz — Konstruktor-Default, s.o.). Inject ein
   *   Test-Double, um `HeadlessFlowRunner` selbst NICHT erneut zu testen (dessen
   *   eigene Testsuite deckt spawn/env/timeout/lock/close bereits ab).
   * @param {BoardWriter} [params.boardWriter] - injectable (default: `new BoardWriter()`).
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
  constructor({ runner, boardWriter, spawnFn, timeoutMs, lock } = {}) {
    this.#runner = runner ?? new HeadlessFlowRunner({ command: REQUIREMENT_COMMAND, spawnFn, timeoutMs, lock });
    this.#boardWriter = boardWriter ?? new BoardWriter();
  }

  /**
   * Startet den headless `requirement`-Finalizer-Lauf (AC6).
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad
   *   (Router löst Slug→Pfad NICHT erneut auf — nutzt den bereits vertrauens-
   *   würdigen `repo_path` aus dem Board-Index, analog `boardRouter.js` .../discuss).
   * @param {object} params
   * @param {unknown} params.draftText
   * @param {string} params.ideaStoryId
   * @param {string} params.projectSlug - für das Sicherheitsnetz (AC9) vorgehalten,
   *   NICHT an den Runner weitergereicht.
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath, { draftText, ideaStoryId, projectSlug }) {
    const prompt = buildRequirementPrompt({ draftText, ideaStoryId });
    const result = this.#runner.start(projectPath, { command: REQUIREMENT_COMMAND, args: [prompt] });
    if (result.ok) {
      this.#jobMeta.set(result.jobId, { projectSlug, storyId: ideaStoryId });
    }
    return result;
  }

  /**
   * Liest den Job-Status (AC7) und löst — genau einmal je Job, beim ERSTEN
   * Beobachten von `status: 'done'` — das AC9-Sicherheitsnetz aus.
   *
   * @param {string} jobId
   * @returns {Promise<{ status: 'running'|'done'|'failed'|'auth-expired', result?: string, error?: string } | undefined>}
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

    return job;
  }

  /**
   * Sicherheitsnetz (AC9): patcht die ursprüngliche Idee-Story auf `status: Done`,
   * FALLS sie noch `status: Idee` trägt. `not-resolvable` (Item ist nicht mehr
   * `Idee`) ist ein erwartetes No-Op — jeder andere Fehler wird best-effort
   * geloggt, ohne den Status-Endpunkt crashen zu lassen.
   *
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  async #runSafetyNet(jobId) {
    const meta = this.#jobMeta.get(jobId);
    if (!meta || !meta.projectSlug || !meta.storyId) return;

    try {
      await this.#boardWriter.archiveSupersededIdea({
        projectSlug: meta.projectSlug,
        storyId: meta.storyId,
      });
    } catch (err) {
      if (err instanceof BoardWriterError && err.errorClass === 'not-resolvable') {
        // Erwartetes No-Op: der Agent hat die Platzhalter-Idee bereits selbst
        // übernommen/aufgelöst (best effort, AC8) — kein zweiter Write nötig.
        return;
      }
      // Best-effort: kein Secret/Host-Pfad im Log (security/R01), kein Crash.
      console.error('[IdeaSpecifyFinalizer] Sicherheitsnetz-Archivierung fehlgeschlagen:', err.message);
    }
  }
}
