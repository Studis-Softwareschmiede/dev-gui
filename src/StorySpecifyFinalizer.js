/**
 * StorySpecifyFinalizer — schlanke „from scratch"-Schwester-Boundary des
 * `IdeaSpecifyFinalizer` für den Neue-Story-Chat (docs/specs/new-story-chat.md
 * AC4, AC5, AC8).
 *
 * Diese Spec ist die „from scratch"-Variante von idea-specify-chat: Feature +
 * Story werden von Grund auf angelegt — es existiert KEINE vorgelagerte
 * Idee-Karte. Deshalb unterscheidet sich dieser Finalizer vom
 * `IdeaSpecifyFinalizer` (new-story-chat AC8) NUR durch:
 *   1. den **Prompt**: `buildRequirementPrompt()` hängt an den `draftText`
 *      AUSSCHLIESSLICH den „nicht-nachfragen"-Hinweis an — KEIN
 *      `ideaStoryId`-Übernahme-Hinweis (es gibt keine Platzhalter-Idee).
 *   2. das **fehlende `archiveSupersededIdea`-Sicherheitsnetz**: es existiert
 *      keine Idee-Story, die verwaisen könnte — also KEIN Baseline-Snapshot,
 *      KEIN `no-op`-Mapping, KEIN `BoardWriter`-Nachlauf. `getJob()` reicht den
 *      Runner-Status 1:1 durch (Status ∈ {running,done,failed,auth-expired},
 *      AC5).
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
 * Job-Registry: lebt in der injizierten/erzeugten `HeadlessFlowRunner`-Instanz
 * (In-Memory, geht bei Server-Neustart verloren — Nicht-Ziel, wie bei allen
 * bestehenden headless-Runnern).
 *
 * Security (Floor): der zusammengesetzte Prompt ist die EINZIGE, sanitisierte
 * argv-Übergabe an den `requirement`-Lauf (argv als Array, kein Shell-String —
 * identische Sicherheits-Eigenschaften wie `HeadlessFlowRunner`/
 * `HeadlessRunnerCore`, security/R03). Harter `ANTHROPIC_API_KEY`/
 * `OPENAI_API_KEY`-Block liegt im `HeadlessRunnerCore` (`buildChildEnv`). Kein
 * Secret/Token/Host-Pfad in Logs/Response. `runner` injizierbar
 * (Test-Entkopplung, kein echter `claude`-Lauf nötig).
 *
 * @module StorySpecifyFinalizer
 */

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
 * `start()`-Aufruf, „from scratch" (ohne Idee-Bezug, ohne Sicherheitsnetz).
 */
export class StorySpecifyFinalizer {
  /** @type {{ start: Function, getJob: Function }} */
  #runner;

  /**
   * @param {object} [params]
   * @param {{ start: Function, getJob: Function }} [params.runner] - injectable
   *   Runner (default: EIGENE `HeadlessFlowRunner`-Instanz mit EIGENER,
   *   frischer `ProjectJobLock`-Instanz — Konstruktor-Default, s.o.). Inject ein
   *   Test-Double, um `HeadlessFlowRunner` selbst NICHT erneut zu testen (dessen
   *   eigene Testsuite deckt spawn/env/timeout/lock/close bereits ab).
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
  constructor({ runner, spawnFn, timeoutMs, lock } = {}) {
    this.#runner = runner ?? new HeadlessFlowRunner({ command: REQUIREMENT_COMMAND, spawnFn, timeoutMs, lock });
  }

  /**
   * Startet den headless `requirement`-Finalizer-Lauf (AC4). Der zusammengesetzte
   * Prompt (`buildRequirementPrompt`) ist die einzige, sanitisierte argv-Übergabe.
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad
   *   (Router löst Slug→Pfad NICHT erneut auf — nutzt den bereits vertrauens-
   *   würdigen `repo_path` aus dem Board-Index, analog `ideaSpecifyRouter`).
   * @param {object} params
   * @param {unknown} params.draftText
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath, { draftText }) {
    const prompt = buildRequirementPrompt({ draftText });
    return this.#runner.start(projectPath, { command: REQUIREMENT_COMMAND, args: [prompt] });
  }

  /**
   * Liest den Job-Status (AC5) — 1:1 aus der `HeadlessFlowRunner`-Job-Registry.
   * KEIN Sicherheitsnetz, KEIN `no-op`-Mapping (es gibt keine Idee, die
   * verwaisen könnte) — Format identisch zum idea-specify-/Reconcile-Status.
   *
   * @param {string} jobId
   * @returns {{ status: 'running'|'done'|'failed'|'auth-expired', result?: string, error?: string, prHint?: string } | undefined}
   */
  getJob(jobId) {
    return this.#runner.getJob(jobId);
  }
}
