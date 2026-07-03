/**
 * ObsidianIngestRunner — headless `claude -p '/agent-flow:from-notes …'`-
 * Kindprozess-Runner MIT strukturiertem Interrupt/Resume-Rückkanal
 * (docs/specs/obsidian-question-catalog.md AC1, AC2, AC4, AC5, AC6, AC7).
 *
 * Anders als die bestehenden fire-and-forget-Runner (`HeadlessReconcileRunner`/
 * `HeadlessFlowRunner`, bei denen `close` = terminal `done`) endet EIN Ingest-
 * Lauf je Runde in EINEM von zwei strukturierten Zuständen:
 *   - `done`          — Pipeline durch (Board/`docs/` aktualisiert), terminal.
 *   - `needs-answers` — ein maschinenlesbarer Fragenkatalog liegt an (Interrupt,
 *                       NICHT terminal); der Lauf wird über `answers()` mit den
 *                       gesammelten Antworten fortgesetzt (Resume desselben
 *                       claude-Session-Kontexts via `--resume <session-id>`).
 *
 * Getrennt vom interaktiven PTY-Pfad (analog HeadlessReconcileRunner AC7): dieses
 * Modul importiert/mutiert WEDER `PtyManager` NOCH `PtySessionRegistry` NOCH den
 * `CommandService`-Schreibpfad. Eigene, EIGENSTÄNDIGE `ProjectJobLock`-Instanz
 * (Konstruktor-Default `new ProjectJobLock()`) — bewusst getrennt von Flow-/
 * Reconcile-/Nacht-Drain-/Finalizer-Lock (AC1/AC6, sonst Selbstblockade).
 *
 * Lock-Lebenszyklus (AC1/AC6, Edge-Case „Parallel-Start fürs selbe Projekt"):
 *   Das projektweise Lock wird bei `start()` erworben und erst bei einem
 *   TERMINALEN Zustand (`done`/`failed`/`auth-expired`) in try/finally wieder
 *   freigegeben. Während `running` UND während `needs-answers` (pausierter,
 *   noch offener Lauf) bleibt es gehalten — ein zweiter `start()` fürs selbe
 *   Projekt liefert daher `{ ok:false, reason:'locked' }` (→ Router 409), ohne
 *   andere headless-Pfade zu berühren.
 *
 * Security (Floor, AC6):
 *   - Tool-fähiger Pfad: `claude -p` als Array-argv (kein Shell-String,
 *     security/R03), `--dangerously-skip-permissions` ausschließlich hier.
 *   - `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` werden NIE in die Child-Env übernommen
 *     (harter Block via `buildChildEnv()` aus `HeadlessRunnerCore.js`).
 *   - Der Antwort-Text der Resume-Runde geht via STDIN an `claude`, NIE als
 *     roher Shell-String/argv-Interpolation (AC6).
 *   - Kein Token-Wert und kein absoluter Host-Pfad in Logs/Fehlermeldungen/
 *     Response; `catalog`/`error`/`result` sind secret-frei.
 *   - Auditiert (AC6): Job-Ende (`done`) + Job-Fehler (`failed`/`auth-expired`)
 *     mit Identität (aus `start()`) + Aktion; der Job-START + die ANTWORTEN-
 *     Aktion werden vom Router auditiert (Identität aus `req.identity`).
 *
 * Job-Registry: In-Memory (Map jobId → JobState), geht bei Server-Neustart
 * verloren (Nicht-Ziel: keine persistente Job-/Katalog-Historie).
 *
 * Injectable (Test-Entkopplung, NFR „Entkopplung"): `runClaude`-Adapter — kein
 * Test benötigt einen echten `claude`-Lauf; der Default-Adapter
 * (`defaultRunClaude`) kapselt spawn/env/session-id/auth-Erkennung.
 *
 * Fragen-offen-Push (docs/specs/questions-pending-notification.md, S-279:
 * AC1/AC2/AC3/AC4/AC5): optionaler injizierter `notifier` (Muster `auditStore`
 * — Default `null` → No-op, AC5 Default-Regress). An der `needs-answers`-
 * Setzstelle in `#runRound` — NACH dem Setzen von `status`/`catalog` — wird
 * best-effort GENAU EIN `notifier.notifyQuestionsPending({ label, questionCount })`
 * ausgelöst (try/catch, non-fatal, AC4); ein Fehler/fehlender Notifier beeinflusst
 * weder den `needs-answers`-Zustand noch das Lock. `label` ist der Basename des
 * Projektpfads (NIE der volle Host-Pfad, AC6) mit defensivem Fallback bei
 * fehlendem Basename.
 *
 * @module ObsidianIngestRunner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { ProjectJobLock } from './ProjectJobLock.js';
import { buildChildEnv, isAuthError, AUTH_EXPIRED_MESSAGE } from './HeadlessRunnerCore.js';

/** Fest verdrahteter Ingest-Befehl (obsidian-project-intake AC4/S-248 Allowlist). */
export const FROM_NOTES_COMMAND = '/agent-flow:from-notes';

/** Default Runaway-Timeout je Runde (ein Ingest-Schritt kann mehrere Minuten dauern). */
export const DEFAULT_INGEST_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

// Re-Export für Aufrufer/Tests (gleiche Semantik wie in den Geschwister-Runnern).
export { buildChildEnv, isAuthError, AUTH_EXPIRED_MESSAGE };

/** Kurzer, secret-freier argv-Prompt für die Resume-Runde — die Antworten selbst
 * gehen via STDIN (AC6), nie als argv/Shell-String. */
export const RESUME_PROMPT =
  'Continue the interrupted ingest with the answers provided on stdin.';

// ── Secret-freie Meldungstexte ────────────────────────────────────────────────
const GENERIC_FAILURE_MESSAGE = 'Obsidian-Ingest-Lauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Obsidian-Ingest-Lauf abgebrochen (Timeout)';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Obsidian-Ingest-Runner';
const NOT_AVAILABLE_MESSAGE = 'claude nicht verfügbar';
const UNPARSABLE_MESSAGE = 'Fragenkatalog konnte nicht gelesen werden';
const NO_SESSION_MESSAGE = 'Obsidian-Ingest-Lauf kann nicht fortgesetzt werden';
const DONE_RESULT_MESSAGE = 'Obsidian-Ingest abgeschlossen';

/** Fallback-Label für den Fragen-offen-Push, falls kein verwertbarer Basename
 * ermittelt werden kann (questions-pending-notification AC6, Edge-Case). */
const QUESTIONS_PENDING_FALLBACK_LABEL = 'Projekt';

// ── Reine Parser (testbar ohne Prozess) ───────────────────────────────────────

/**
 * Extrahiert das `result`/`session_id` aus der `--output-format json`-Ausgabe
 * von `claude -p`. Tolerant: ist die Ausgabe kein JSON-Wrapper (z.B. Roh-Text
 * in einem Test-Double), wird der Roh-stdout als `resultText` und `sessionId`
 * `undefined` zurückgegeben.
 *
 * @param {string} stdout
 * @returns {{ resultText: string, sessionId: string|undefined }}
 */
export function extractClaudeResult(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? '').trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const resultText = typeof parsed.result === 'string' ? parsed.result : String(stdout ?? '');
      const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
      return { resultText, sessionId };
    }
  } catch {
    // Kein JSON-Wrapper — Roh-stdout durchreichen.
  }
  return { resultText: String(stdout ?? ''), sessionId: undefined };
}

/**
 * Normalisiert eine einzelne Katalog-Frage auf das Vertrags-Schema
 * `{ stage, id, frage, quelle, optionen?, pflicht }` (obsidian-question-catalog
 * §Verträge). Unbekannte Felder werden verworfen (Whitelist). `pflicht`
 * defaultet auf `true` (Pflicht-Frage), sofern der Katalog nicht ausdrücklich
 * `pflicht: false` ODER `optional: true` liefert (AC4-Server-Validierung).
 *
 * @param {unknown} q
 * @returns {{ stage: string, id: string, frage: string, quelle: string, optionen?: string[], pflicht: boolean }}
 * @throws {Error} wenn `id`/`frage` fehlen (nicht-parsbarer Katalog).
 */
function normalizeQuestion(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) {
    throw new Error('catalog question is not an object');
  }
  const id = typeof q.id === 'string' ? q.id.trim() : '';
  const frage = typeof q.frage === 'string' ? q.frage : '';
  if (id === '' || frage.trim() === '') {
    throw new Error('catalog question missing id/frage');
  }
  const normalized = {
    stage: typeof q.stage === 'string' ? q.stage : '',
    id,
    frage,
    quelle: typeof q.quelle === 'string' ? q.quelle : '',
    // Pflicht = true, außer explizit als optional markiert (pflicht:false ODER optional:true).
    pflicht: !(q.pflicht === false || q.optional === true),
  };
  if (Array.isArray(q.optionen)) {
    normalized.optionen = q.optionen.map((o) => String(o));
  }
  return normalized;
}

/**
 * Parst den strukturierten Ingest-Ausgang aus dem `result`-Text (AC2,
 * Markdown-Fence-tolerant, analog `IdeaSpecifyChatService.parseClaudeOutput`).
 * Erwartet ein JSON-Objekt `{ status: 'needs-answers'|'done', catalog?: [...] }`.
 *
 * @param {string} raw
 * @returns {{ status: 'done' } | { status: 'needs-answers', catalog: Array<object> }}
 * @throws {Error} bei ungültigem JSON, unbekanntem `status` oder leerem/kaputtem
 *   `needs-answers`-Katalog (→ Runner mappt auf `failed`, secret-frei).
 */
export function parseIngestOutcome(raw) {
  let parsed;
  try {
    const fenceMatch = String(raw ?? '').match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : String(raw ?? '').trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    const objectMatch = String(raw ?? '').match(/\{[\s\S]*\}/);
    if (!objectMatch) throw new Error('ingest output is not valid JSON');
    parsed = JSON.parse(objectMatch[0]); // wirft bei kaputtem Objekt → Aufrufer fängt
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('ingest output is not an object');
  }

  const status = parsed.status;
  if (status === 'done' || status === 'complete') {
    return { status: 'done' };
  }
  if (status === 'needs-answers') {
    if (!Array.isArray(parsed.catalog) || parsed.catalog.length === 0) {
      throw new Error('needs-answers without a non-empty catalog');
    }
    const catalog = parsed.catalog.map(normalizeQuestion);
    return { status: 'needs-answers', catalog };
  }
  throw new Error(`unknown ingest status: ${String(status)}`);
}

/**
 * Validiert die eingereichten Antworten gegen den aktuellen Katalog (AC4).
 * Reine Funktion (kein Seiteneffekt) — der Runner ruft sie autoritativ auf,
 * unabhängig von etwaigen Router-Vorprüfungen (Defense in Depth).
 *
 * @param {unknown} answers
 * @param {Array<{ id: string, pflicht: boolean }>} catalog
 * @returns {{ ok: true, answers: Array<{ id: string, answer: string }> }
 *          | { ok: false, reason: 'invalid'|'unknown-id'|'missing-required' }}
 */
export function validateAnswers(answers, catalog) {
  if (!Array.isArray(answers)) return { ok: false, reason: 'invalid' };

  const byId = new Map(catalog.map((q) => [q.id, q]));
  const provided = new Map();
  for (const a of answers) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    if (!byId.has(a.id)) return { ok: false, reason: 'unknown-id' };
    provided.set(a.id, typeof a.answer === 'string' ? a.answer : String(a.answer ?? ''));
  }

  // Jede Pflicht-Frage muss eine nicht-leere Antwort haben (AC4).
  for (const q of catalog) {
    if (q.pflicht === false) continue; // optional
    const ans = provided.get(q.id);
    if (ans === undefined || ans.trim() === '') {
      return { ok: false, reason: 'missing-required' };
    }
  }

  const normalized = answers.map((a) => ({
    id: a.id,
    answer: typeof a.answer === 'string' ? a.answer : String(a.answer ?? ''),
  }));
  return { ok: true, answers: normalized };
}

// ── Default claude-Adapter ────────────────────────────────────────────────────

/**
 * Default `runClaude`-Adapter (AC6): fährt einen `claude -p`-Kindprozess für
 * eine Ingest-Runde (Initial ODER Resume) und liefert das strukturierte
 * Rundenergebnis. Kapselt spawn/env/timeout/session-id/auth-Erkennung, sodass
 * der Runner selbst prozess-frei testbar bleibt.
 *
 * Security (Floor, AC6):
 *   - argv als Array (kein Shell-String, security/R03); `--dangerously-skip-permissions`
 *     ausschließlich hier.
 *   - `buildChildEnv()` blockt `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` hart.
 *   - Resume-Antworten via STDIN (nie argv/Shell); `--resume <session-id>` argv.
 *   - stderr wird gedraint (Pipe-Blockade), aber NICHT in Fehlermeldungen geleakt.
 *
 * @param {object} params
 * @param {string} params.projectPath - validierter absoluter cwd.
 * @param {string} [params.promptArg] - Initial-Runde: `'<command> <path>'` (ein argv-Element).
 * @param {string} [params.resumeSessionId] - Resume-Runde: claude session-id.
 * @param {Array<{id:string,answer:string}>} [params.answers] - Resume-Antworten (via STDIN).
 * @param {number} [params.timeoutMs]
 * @param {Function} [params.spawnFn] - injectable (default node:child_process spawn).
 * @returns {Promise<{ exitCode: number|null, output: string, sessionId: string|undefined,
 *                     authError: boolean, spawnError?: boolean, timedOut?: boolean }>}
 */
export function defaultRunClaude({
  projectPath,
  promptArg,
  resumeSessionId,
  answers,
  timeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
  spawnFn = nodeSpawn,
}) {
  return new Promise((resolve) => {
    const isResume = typeof resumeSessionId === 'string' && resumeSessionId !== '';
    const argv = ['-p', isResume ? RESUME_PROMPT : String(promptArg ?? '')];
    if (isResume) argv.push('--resume', resumeSessionId);
    argv.push('--dangerously-skip-permissions', '--output-format', 'json');

    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeoutHandle;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    try {
      child = spawnFn('claude', argv, {
        cwd: projectPath,
        env: buildChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finish({ exitCode: -1, output: '', sessionId: undefined, authError: false, spawnError: true });
      return;
    }

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      finish({ exitCode: -1, output: '', sessionId: undefined, authError: false, timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      const combined = `${stdout}\n${stderr}`;
      const authError = isAuthError(code, combined);
      const { resultText, sessionId } = extractClaudeResult(stdout);
      finish({ exitCode: code, output: resultText, sessionId, authError });
    });

    child.on('error', () => {
      // Nur generischer Flag-Rückgabewert — kein Pfad-/Umgebungs-Leak (security/R01).
      finish({ exitCode: -1, output: '', sessionId: undefined, authError: false, spawnError: true });
    });

    // Resume: die gesammelten Antworten NUR via STDIN (AC6), nie als argv.
    if (isResume) {
      try { child.stdin?.write(JSON.stringify(answers ?? []), 'utf8'); } catch { /* stdin ggf. schon zu */ }
    }
    child.stdin?.end();
  });
}

/**
 * ObsidianIngestRunner — Kindprozess-Runner + In-Memory Job-Registry mit
 * Interrupt/Resume-Zustandsmaschine.
 */
export class ObsidianIngestRunner {
  /** @type {(params: object) => Promise<object>} */
  #runClaude;
  /** @type {ProjectJobLock} */
  #lock;
  /** @type {number} */
  #timeoutMs;
  /** @type {import('./AuditStore.js').AuditStore|null} */
  #auditStore;
  /** @type {{ notifyQuestionsPending: (args: { label: string, questionCount?: number }) => Promise<void> }|null} */
  #notifier;
  /**
   * @type {Map<string, {
   *   status: 'running'|'needs-answers'|'done'|'failed'|'auth-expired',
   *   catalog?: Array<object>, result?: string, error?: string,
   *   projectPath: string, sessionId?: string, identity: string|null,
   * }>}
   */
  #jobs = new Map();

  /**
   * @param {object} [params]
   * @param {Function} [params.runClaude] - injectable Adapter (default: defaultRunClaude).
   * @param {ProjectJobLock} [params.lock] - injectable Lock (default: EIGENE, isolierte Instanz).
   * @param {number} [params.timeoutMs] - je-Runde-Timeout (default: env INGEST_TIMEOUT_MS oder Default).
   * @param {import('./AuditStore.js').AuditStore} [params.auditStore] - optional (AC6: Ende/Fehler-Audit).
   * @param {Function} [params.spawnFn] - nur wirksam wenn `runClaude` NICHT übergeben wird
   *   (durchgereicht an den intern erzeugten Default-Adapter — Test-Entkopplung).
   * @param {{ notifyQuestionsPending: Function }} [params.notifier] - optional
   *   (questions-pending-notification AC1/AC5, Default `null` → No-op, kein
   *   Einfluss auf Lock/Zustandsmaschine).
   */
  constructor({ runClaude, lock, timeoutMs, auditStore, spawnFn, notifier } = {}) {
    this.#timeoutMs = timeoutMs ?? (Number(process.env.INGEST_TIMEOUT_MS) || DEFAULT_INGEST_TIMEOUT_MS);
    this.#runClaude =
      runClaude ?? ((params) => defaultRunClaude({ ...params, timeoutMs: this.#timeoutMs, spawnFn }));
    this.#lock = lock ?? new ProjectJobLock();
    this.#auditStore = auditStore ?? null;
    this.#notifier = notifier ?? null;
  }

  /**
   * Startet einen Obsidian-Ingest-Lauf für ein Projekt (AC1). Erwirbt das
   * projektweise Lock; freigegeben erst bei einem terminalen Zustand.
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-/Notiz-Pfad.
   * @param {object} [meta]
   * @param {string|null} [meta.identity] - für das Ende-/Fehler-Audit (AC6).
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath, { identity = null } = {}) {
    if (!this.#lock.tryAcquire(projectPath)) {
      return { ok: false, reason: 'locked' };
    }
    const jobId = randomUUID();
    this.#jobs.set(jobId, {
      status: 'running',
      projectPath,
      identity: identity ?? null,
      sessionId: undefined,
    });
    // Fire-and-forget: der Lauf kann lange dauern; der Aufrufer wartet nicht.
    this.#runRound(jobId, { resume: false }).catch(() => {
      // #runRound fängt selbst alle Fehler ab (Sicherheitsnetz gegen unhandled rejection).
    });
    return { ok: true, jobId };
  }

  /**
   * Liest die ÖFFENTLICHE Sicht auf einen Job (AC1/AC2/AC5) — secret-frei, ohne
   * interne Felder (`projectPath`/`sessionId`/`identity`). `catalog` nur bei
   * `needs-answers`.
   *
   * @param {string} jobId
   * @returns {{ status: string, catalog?: Array<object>, result?: string, error?: string } | undefined}
   */
  getJob(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) return undefined;
    const view = { status: job.status };
    if (job.catalog !== undefined) view.catalog = job.catalog;
    if (job.result !== undefined) view.result = job.result;
    if (job.error !== undefined) view.error = job.error;
    return view;
  }

  /**
   * Reicht die gebündelten Antworten in einen `needs-answers`-Job zurück und
   * setzt den Lauf fort (AC4/AC5, Resume). Validiert autoritativ gegen den
   * aktuellen Katalog (Defense in Depth, unabhängig von Router-Vorprüfungen).
   *
   * @param {string} jobId
   * @param {unknown} answers - erwartet `Array<{ id, answer }>`.
   * @returns {{ ok: true } | { ok: false, reason: 'not-found'|'not-waiting'|'invalid'|'unknown-id'|'missing-required' }}
   */
  answers(jobId, answers) {
    const job = this.#jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not-found' };
    if (job.status !== 'needs-answers') return { ok: false, reason: 'not-waiting' };

    const validated = validateAnswers(answers, job.catalog ?? []);
    if (!validated.ok) return validated;

    // Resume: zurück auf `running`, Katalog/Fehler löschen, nächste Runde anstoßen.
    job.status = 'running';
    job.catalog = undefined;
    job.error = undefined;
    this.#runRound(jobId, { resume: true, answers: validated.answers }).catch(() => {});
    return { ok: true };
  }

  /**
   * Führt EINE Ingest-Runde aus (Initial ODER Resume) und aktualisiert den Job
   * auf `needs-answers` (Interrupt, Lock bleibt gehalten) ODER einen terminalen
   * Zustand (`done`/`failed`/`auth-expired`, Lock-Freigabe + Audit).
   *
   * @param {string} jobId
   * @param {{ resume: boolean, answers?: Array<object> }} opts
   * @returns {Promise<void>}
   */
  async #runRound(jobId, { resume, answers }) {
    const job = this.#jobs.get(jobId);
    if (!job) return;

    // Resume ohne bekannte claude-Session-id: ein `--resume`-loser Lauf ohne
    // Prompt würde die gesammelten Antworten still verschlucken (kein
    // Rückkanal). Stattdessen definierter, secret-freier `failed`-Zustand
    // (Lock-Freigabe + Audit via #finish), Retry über einen neuen Lauf möglich.
    if (resume && !job.sessionId) {
      this.#finish(jobId, 'failed', { error: NO_SESSION_MESSAGE });
      return;
    }

    const promptArg = resume ? undefined : `${FROM_NOTES_COMMAND} ${job.projectPath}`;

    let res;
    try {
      res = await this.#runClaude({
        projectPath: job.projectPath,
        promptArg,
        resumeSessionId: resume ? job.sessionId : undefined,
        answers,
      });
    } catch {
      this.#finish(jobId, 'failed', { error: INTERNAL_FAILURE_MESSAGE });
      return;
    }

    if (res?.authError) {
      this.#finish(jobId, 'auth-expired', { error: AUTH_EXPIRED_MESSAGE });
      return;
    }
    if (res?.spawnError) {
      this.#finish(jobId, 'failed', { error: NOT_AVAILABLE_MESSAGE });
      return;
    }
    if (res?.timedOut) {
      this.#finish(jobId, 'failed', { error: TIMEOUT_FAILURE_MESSAGE });
      return;
    }
    if (res?.exitCode !== 0) {
      this.#finish(jobId, 'failed', { error: GENERIC_FAILURE_MESSAGE });
      return;
    }

    let outcome;
    try {
      outcome = parseIngestOutcome(res.output);
    } catch {
      // Nicht-parsbarer/kaputter Katalog-Ausgang → definierter Fehlerzustand,
      // secret-frei, Retry möglich (AC2/AC7). Kein Crash.
      this.#finish(jobId, 'failed', { error: UNPARSABLE_MESSAGE });
      return;
    }

    if (outcome.status === 'needs-answers') {
      // Interrupt — NICHT terminal, Lock bleibt gehalten (kein Freigeben/Audit).
      const current = this.#jobs.get(jobId);
      if (!current) return;
      current.status = 'needs-answers';
      current.catalog = outcome.catalog;
      current.result = undefined;
      current.error = undefined;
      // session-id für die nächste Resume-Runde merken (falls der Adapter eine liefert).
      if (res.sessionId) current.sessionId = res.sessionId;

      // questions-pending-notification AC1/AC4: best-effort GENAU EIN Push je
      // Eintritt in needs-answers — NACH dem Setzen von status/catalog, sodass
      // der Push-Ausgang den Zustand/das Lock NIE beeinflusst. No-op ohne
      // injizierten Notifier (AC5).
      try {
        await this.#notifier?.notifyQuestionsPending({
          label: this.#safeLabel(current.projectPath),
          questionCount: outcome.catalog.length,
        });
      } catch (err) {
        // Best-effort — crasht die Interrupt-Zustandsmaschine nie (AC4). Secret-frei.
        console.error('[ObsidianIngestRunner] questions_pending-Push fehlgeschlagen (best-effort):', err?.message ?? String(err));
      }
      return;
    }

    // done — terminal.
    this.#finish(jobId, 'done', { result: DONE_RESULT_MESSAGE });
  }

  /**
   * Setzt einen Job terminal, gibt das projektweise Lock frei (immer) und
   * schreibt genau EINEN Ende-/Fehler-Audit-Eintrag (AC6).
   *
   * @param {string} jobId
   * @param {'done'|'failed'|'auth-expired'} status
   * @param {{ result?: string, error?: string }} patch
   */
  #finish(jobId, status, patch) {
    const job = this.#jobs.get(jobId);
    if (!job) return;
    job.status = status;
    job.catalog = undefined;
    job.result = patch.result;
    job.error = patch.error;

    // Lock IMMER freigeben (terminaler Zustand).
    this.#lock.release(job.projectPath);

    if (status === 'done') {
      this.#audit(job.identity, `obsidian:ingest:done:${jobId}`);
    } else {
      this.#audit(job.identity, `obsidian:ingest:error:${jobId}:${status}`);
    }
  }

  /**
   * Ermittelt das secret-/pfad-freie Push-Label (questions-pending-notification
   * AC3/AC6): Basename des Projektpfads, NIE der volle Host-Pfad. Fällt bei
   * einem nicht-verwertbaren Basename (leer, kaputter Pfad) defensiv auf einen
   * generischen Platzhalter zurück — der volle Pfad wird NIE zurückgegeben.
   * @param {string} projectPath
   * @returns {string}
   */
  #safeLabel(projectPath) {
    let label;
    try {
      label = basename(String(projectPath ?? ''));
    } catch {
      label = '';
    }
    return label || QUESTIONS_PENDING_FALLBACK_LABEL;
  }

  /**
   * Best-effort Audit (AC6). Ein Audit-Fehler crasht den Runner nie (analog
   * `HeadlessFlowRunnerAdapter#audit`).
   * @param {string|null} identity
   * @param {string} command
   */
  #audit(identity, command) {
    if (!this.#auditStore) return;
    try {
      this.#auditStore.record({ identity: identity ?? null, command });
    } catch {
      // best-effort — kein Crash, kein Secret im Log.
    }
  }
}
