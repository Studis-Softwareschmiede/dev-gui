/**
 * RegressionDefineRunner — headless `claude -p '/agent-flow:regression-define …'`-
 * Kindprozess-Runner MIT strukturiertem Interrupt/Resume-Rückkanal
 * (docs/specs/regression-define-dialog.md AC1, AC2, AC3, AC4, AC5).
 *
 * Muster: 1:1 die State-Machine von `ObsidianIngestRunner` (`needs-answers` →
 * hier `needs-review`), aber mit anderem Nutzlast-Schema (NL-Vorschlag statt
 * Fragenkatalog) und anderem Slash-Command. EIN Definitions-Lauf je Runde
 * endet in EINEM von zwei strukturierten Zuständen:
 *   - `done`         — die bestätigte Fassung wurde in Testdatei + Datentabelle
 *                       übersetzt (Auslieferung als PR/Commit, agent-flow-seitig),
 *                       terminal.
 *   - `needs-review` — ein maschinenlesbarer NL-Vorschlag liegt an (Interrupt,
 *                       NICHT terminal); der Lauf wird über `review()` mit der
 *                       redigierten Fassung fortgesetzt (Resume desselben
 *                       claude-Session-Kontexts via `--resume <session-id>`).
 *
 * Getrennt vom interaktiven PTY-Pfad: dieses Modul importiert/mutiert WEDER
 * `PtyManager` NOCH `PtySessionRegistry` NOCH den `CommandService`-Schreibpfad.
 * Eigene, EIGENSTÄNDIGE `ProjectJobLock`-Instanz (Konstruktor-Default
 * `new ProjectJobLock()`) — bewusst getrennt von ALLEN anderen headless-Locks
 * (Nacht-Drain/manueller Drain/Reconcile-Runner/`IdeaSpecifyFinalizer`/
 * Auto-Retro/`ObsidianIngestRunner`), AC1.
 *
 * Lock-Lebenszyklus (AC2, Edge-Case „Parallel-Start fürs selbe Projekt"):
 *   Das projektweise Lock wird bei `start()` erworben und erst bei einem
 *   TERMINALEN Zustand (`done`/`failed`/`auth-expired`) in try/finally wieder
 *   freigegeben. Während `running` UND während `needs-review` (pausierter,
 *   noch offener Lauf) bleibt es gehalten — ein zweiter `start()` fürs selbe
 *   Projekt liefert daher `{ ok:false, reason:'locked' }` (→ Router 409).
 *
 * Security (Floor, AC1/AC5):
 *   - Tool-fähiger Pfad: `claude -p` als Array-argv (kein Shell-String,
 *     security/R03), `--dangerously-skip-permissions` ausschließlich hier.
 *   - `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` werden NIE in die Child-Env übernommen
 *     (harter Block via `buildChildEnv()` aus `HeadlessRunnerCore.js`).
 *   - Die redigierte Fassung der Resume-Runde geht via STDIN an `claude`, NIE
 *     als roher Shell-String/argv-Interpolation (AC3).
 *   - Kein Token-Wert und kein absoluter Host-Pfad in Logs/Fehlermeldungen/
 *     Response; `vorschlag`/`error`/`result` sind secret-frei.
 *   - Auditiert (AC5): Job-Ende (`done`) + Job-Fehler (`failed`/`auth-expired`)
 *     mit Identität (aus `start()`) + Aktion; der Job-START + die REVIEW-Aktion
 *     werden vom Router auditiert (Identität aus `req.identity`).
 *
 * Job-Registry: In-Memory (Map jobId → JobState), geht bei Server-Neustart
 * verloren (Nicht-Ziel: keine persistente Job-/Vorschlags-Historie).
 *
 * Injectable (Test-Entkopplung): `runClaude`-Adapter — kein Test benötigt einen
 * echten `claude`-Lauf; der Default-Adapter (`defaultRunClaude`) kapselt
 * spawn/env/session-id/auth-Erkennung.
 *
 * Lebendigkeits-Felder (v2, AC9): `startedAt` (Laufbeginn der aktuellen Runde,
 * bei Resume neu gesetzt — „beide `running`-Phasen" AC10) und
 * `lastActivityAt` (bei jedem Zustands-/Fortschritts-Update aktualisiert:
 * Rundenstart, `needs-review`-Interrupt, terminaler Abschluss). `phase` ist
 * best-effort und aus einer festen Menge (`session-start`|`reading-specs`|
 * `drafting`|`translating`) — hier grob aus dem Runden-Typ abgeleitet (Initial-
 * Runde: `session-start`→`drafting`; Resume-Runde: `translating`), NICHT aus
 * echtem Agent-Fortschritt (kein Rateergebnis über die tatsächliche
 * Fortschritts-Tiefe hinaus, s. `phase`-Zuweisung in `#runRound`).
 *
 * Fehlerklasse + sanitisierte Roh-Ausgabe (v2, AC12): jeder terminale `failed`-
 * Zustand trägt `error_class` aus fester Menge (`parse-error`|`no-session`|
 * `agent-failed`|`timeout`). NUR im Parse-/Format-Fehlerpfad der Finalausgabe
 * (`parseRegressionDefineOutcome()`-Wurf) liefert der Job zusätzlich die
 * serverseitig secret-gefilterte Roh-Finalausgabe (`raw_output`,
 * `sanitizeRawOutput()`) — Trust-Boundary: Tokens/API-Keys/OAuth-Tokens/
 * Host-Pfade werden VOR dem Ablegen im Job entfernt, bevor die Job-Sicht sie
 * verlässt.
 *
 * @module RegressionDefineRunner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ProjectJobLock } from './ProjectJobLock.js';
import { buildChildEnv, isAuthError, AUTH_EXPIRED_MESSAGE } from './HeadlessRunnerCore.js';

/** Fest verdrahteter Definier-Befehl (regression-define-dialog AC1). */
export const REGRESSION_DEFINE_COMMAND = '/agent-flow:regression-define';

/** Default Runaway-Timeout je Runde (ein Definitions-Lauf kann mehrere Minuten dauern). */
export const DEFAULT_REGRESSION_DEFINE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

// Re-Export für Aufrufer/Tests (gleiche Semantik wie in den Geschwister-Runnern).
export { buildChildEnv, isAuthError, AUTH_EXPIRED_MESSAGE };

/** Kurzer, secret-freier argv-Prompt für die Resume-Runde — die redigierte
 * Fassung selbst geht via STDIN (AC3), nie als argv/Shell-String. */
export const RESUME_PROMPT_MODE = 'uebersetzen';

// ── Secret-freie Meldungstexte ────────────────────────────────────────────────
const GENERIC_FAILURE_MESSAGE = 'Regressions-Definitionslauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Regressions-Definitionslauf abgebrochen (Timeout)';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Regressions-Definitions-Runner';
const NOT_AVAILABLE_MESSAGE = 'claude nicht verfügbar';
const UNPARSABLE_MESSAGE = 'Vorschlag konnte nicht gelesen werden';
const NO_SESSION_MESSAGE = 'Regressions-Definitionslauf kann nicht fortgesetzt werden';
const DONE_RESULT_MESSAGE = 'Regressionstest-Definition abgeschlossen';

// ── Fehlerklassen (AC12, feste Menge) ─────────────────────────────────────────
export const ERROR_CLASS_PARSE = 'parse-error';
export const ERROR_CLASS_NO_SESSION = 'no-session';
export const ERROR_CLASS_AGENT_FAILED = 'agent-failed';
export const ERROR_CLASS_TIMEOUT = 'timeout';

// ── Phasen (AC9, feste Menge, best-effort) ────────────────────────────────────
export const PHASE_SESSION_START = 'session-start';
export const PHASE_READING_SPECS = 'reading-specs';
export const PHASE_DRAFTING = 'drafting';
export const PHASE_TRANSLATING = 'translating';

/**
 * Filtert die Roh-Finalausgabe secret-frei (AC12 Trust-Boundary): entfernt
 * alles, was wie ein Token/API-Key/OAuth-Token oder ein absoluter Host-Pfad
 * aussieht, BEVOR die Ausgabe im Job abgelegt wird (nie ungefiltert an die
 * Job-Sicht durchgereicht). Muster analog `GitHubCloner.js#sanitizeErrorMessage`.
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeRawOutput(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{30,}/g, '[REDACTED]')
    .replace(/ghs_[A-Za-z0-9]{30,}/g, '[REDACTED]')
    .replace(/gho_[A-Za-z0-9]{30,}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^@\s]*@/g, 'https://[REDACTED]@')
    .replace(/-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g, '[REDACTED-PEM]')
    .replace(/\/(?:home|Users|workspace)\/[^\s"'`)]+/g, '[REDACTED-PATH]')
    .slice(0, 4000);
}

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
 * Baut das `ziel`-Argument des Eingabe-Vertrags (AC4): `bereich=<id>` oder
 * `verbund=<name>`. Reine Funktion (kein Seiteneffekt), von `start()` und den
 * Tests genutzt.
 *
 * @param {{ typ: 'bereich'|'verbund', id: string }} ziel
 * @returns {string}
 * @throws {Error} bei unbekanntem `typ` (Aufrufer validiert vorher autoritativ).
 */
export function zielToArg(ziel) {
  if (!ziel || typeof ziel !== 'object') throw new Error('ziel must be an object');
  if (ziel.typ === 'bereich') return `bereich=${ziel.id}`;
  if (ziel.typ === 'verbund') return `verbund=${ziel.id}`;
  throw new Error(`unknown ziel.typ: ${String(ziel?.typ)}`);
}

/**
 * Validiert das eingereichte `ziel` (AC4/AC6-Eingabe-Vertrag). Reine Funktion,
 * vom Router UND vom Runner autoritativ genutzt (Defense in Depth).
 *
 * @param {unknown} ziel
 * @returns {{ ok: true, ziel: { typ: 'bereich'|'verbund', id: string } } | { ok: false, reason: string }}
 */
export function validateZiel(ziel) {
  if (!ziel || typeof ziel !== 'object' || Array.isArray(ziel)) {
    return { ok: false, reason: 'invalid' };
  }
  if (ziel.typ !== 'bereich' && ziel.typ !== 'verbund') {
    return { ok: false, reason: 'invalid-typ' };
  }
  const id = typeof ziel.id === 'string' ? ziel.id.trim() : '';
  if (id === '') {
    return { ok: false, reason: 'missing-id' };
  }
  return { ok: true, ziel: { typ: ziel.typ, id } };
}

/**
 * Normalisiert einen einzelnen Vorschlags-Eintrag auf das Vertrags-Schema
 * `{ titel, schritte, pruefpunkte, beispieldaten }` (regression-define-dialog
 * §Verträge, lose gekoppelt an agent-flow `regression-define`). Unbekannte
 * Felder werden verworfen (Whitelist).
 *
 * @param {unknown} v
 * @returns {{ titel: string, schritte: string[], pruefpunkte: string[], beispieldaten: unknown[] }}
 * @throws {Error} wenn `titel` fehlt (nicht-parsbarer Vorschlag).
 */
function normalizeVorschlagEntry(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('vorschlag entry is not an object');
  }
  const titel = typeof v.titel === 'string' ? v.titel.trim() : '';
  if (titel === '') {
    throw new Error('vorschlag entry missing titel');
  }
  return {
    titel,
    schritte: Array.isArray(v.schritte) ? v.schritte.map((s) => String(s)) : [],
    pruefpunkte: Array.isArray(v.pruefpunkte) ? v.pruefpunkte.map((s) => String(s)) : [],
    beispieldaten: Array.isArray(v.beispieldaten) ? v.beispieldaten : [],
  };
}

/**
 * Parst den strukturierten Definitions-Ausgang aus dem `result`-Text (AC2,
 * Markdown-Fence-tolerant, analog `ObsidianIngestRunner.parseIngestOutcome`).
 * Erwartet ein JSON-Objekt `{ status: 'needs-review'|'done', projekt?, ziel?,
 * quell_specs?, vorschlag?: [...], target_vorschlag? }`.
 *
 * E2 (Bereich ohne deckende Specs): der Agent liefert `status:'failed'` mit
 * einem `reason`-Text — das Overlay zeigt die Meldung statt eines leeren/
 * erfundenen Vorschlags (kein Artefakt).
 *
 * @param {string} raw
 * @returns {{ status: 'done' }
 *          | { status: 'needs-review', vorschlag: object }
 *          | { status: 'failed', reason: string }}
 * @throws {Error} bei ungültigem JSON, unbekanntem `status` oder leerem/kaputtem
 *   `needs-review`-Vorschlag (→ Runner mappt auf `failed`, secret-frei).
 */
export function parseRegressionDefineOutcome(raw) {
  let parsed;
  try {
    const fenceMatch = String(raw ?? '').match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : String(raw ?? '').trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    const objectMatch = String(raw ?? '').match(/\{[\s\S]*\}/);
    if (!objectMatch) throw new Error('regression-define output is not valid JSON');
    parsed = JSON.parse(objectMatch[0]); // wirft bei kaputtem Objekt → Aufrufer fängt
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('regression-define output is not an object');
  }

  const status = parsed.status;
  if (status === 'done' || status === 'complete') {
    return { status: 'done' };
  }
  if (status === 'failed') {
    // E2 — Bereich ohne deckende Specs (oder anderer agent-flow-seitiger
    // Abbruchgrund): secret-freier, klarer Grund statt eines Crashs.
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() !== ''
      ? parsed.reason.trim()
      : 'Regressions-Definitionslauf ohne Ergebnis abgebrochen';
    return { status: 'failed', reason };
  }
  if (status === 'needs-review') {
    if (!Array.isArray(parsed.vorschlag) || parsed.vorschlag.length === 0) {
      throw new Error('needs-review without a non-empty vorschlag');
    }
    const vorschlag = {
      projekt: typeof parsed.projekt === 'string' ? parsed.projekt : '',
      ziel: parsed.ziel && typeof parsed.ziel === 'object' ? parsed.ziel : null,
      quell_specs: Array.isArray(parsed.quell_specs) ? parsed.quell_specs.map((s) => String(s)) : [],
      vorschlag: parsed.vorschlag.map(normalizeVorschlagEntry),
      target_vorschlag: typeof parsed.target_vorschlag === 'string' ? parsed.target_vorschlag : null,
    };
    return { status: 'needs-review', vorschlag };
  }
  throw new Error(`unknown regression-define status: ${String(status)}`);
}

// ── Default claude-Adapter ────────────────────────────────────────────────────

/**
 * Default `runClaude`-Adapter (AC1/AC3): fährt einen `claude -p`-Kindprozess
 * für eine Definitions-Runde (Initial ODER Resume) und liefert das
 * strukturierte Rundenergebnis. Kapselt spawn/env/timeout/session-id/
 * auth-Erkennung, sodass der Runner selbst prozess-frei testbar bleibt.
 *
 * Security (Floor, AC1/AC3):
 *   - argv als Array (kein Shell-String, security/R03); `--dangerously-skip-permissions`
 *     ausschließlich hier.
 *   - `buildChildEnv()` blockt `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` hart.
 *   - Resume-Nutzlast (redigierte Fassung) via STDIN (nie argv/Shell);
 *     `--resume <session-id>` argv.
 *   - stderr wird gedraint (Pipe-Blockade), aber NICHT in Fehlermeldungen geleakt.
 *
 * @param {object} params
 * @param {string} params.projectPath - validierter absoluter cwd.
 * @param {string} [params.promptArg] - Initial-Runde: EIN zusammenhängendes
 *   argv-Element (`'<command> modus=vorschlag projekt=<repo> (bereich=<id>|verbund=<name>) [stichworte=...]'`).
 * @param {string} [params.resumeSessionId] - Resume-Runde: claude session-id.
 * @param {unknown} [params.reviewed] - redigierte Fassung (Resume via STDIN).
 * @param {number} [params.timeoutMs]
 * @param {Function} [params.spawnFn] - injectable (default node:child_process spawn).
 * @returns {Promise<{ exitCode: number|null, output: string, sessionId: string|undefined,
 *                     authError: boolean, spawnError?: boolean, timedOut?: boolean }>}
 */
export function defaultRunClaude({
  projectPath,
  promptArg,
  resumeSessionId,
  reviewed,
  timeoutMs = DEFAULT_REGRESSION_DEFINE_TIMEOUT_MS,
  spawnFn = nodeSpawn,
}) {
  return new Promise((resolve) => {
    const isResume = typeof resumeSessionId === 'string' && resumeSessionId !== '';
    const resumePromptArg = `${REGRESSION_DEFINE_COMMAND} modus=${RESUME_PROMPT_MODE}`;
    const argv = ['-p', isResume ? resumePromptArg : String(promptArg ?? '')];
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

    // Resume: die redigierte Fassung NUR via STDIN (AC3), nie als argv.
    if (isResume) {
      try { child.stdin?.write(JSON.stringify(reviewed ?? null), 'utf8'); } catch { /* stdin ggf. schon zu */ }
    }
    child.stdin?.end();
  });
}

/**
 * RegressionDefineRunner — Kindprozess-Runner + In-Memory Job-Registry mit
 * Interrupt/Resume-Zustandsmaschine.
 */
export class RegressionDefineRunner {
  /** @type {(params: object) => Promise<object>} */
  #runClaude;
  /** @type {ProjectJobLock} */
  #lock;
  /** @type {number} */
  #timeoutMs;
  /** @type {import('./AuditStore.js').AuditStore|null} */
  #auditStore;
  /** @type {() => number} injectable Uhr (Test-Entkopplung, default Date.now). */
  #now;
  /**
   * @type {Map<string, {
   *   status: 'running'|'needs-review'|'done'|'failed'|'auth-expired',
   *   vorschlag?: object, result?: string, error?: string, error_class?: string,
   *   raw_output?: string, phase?: string,
   *   projectPath: string, projekt: string, sessionId?: string, identity: string|null,
   *   startedAt: string, lastActivityAt: string,
   * }>}
   */
  #jobs = new Map();

  /**
   * @param {object} [params]
   * @param {Function} [params.runClaude] - injectable Adapter (default: defaultRunClaude).
   * @param {ProjectJobLock} [params.lock] - injectable Lock (default: EIGENE, isolierte Instanz).
   * @param {number} [params.timeoutMs] - je-Runde-Timeout (default: env REGRESSION_DEFINE_TIMEOUT_MS oder Default).
   * @param {import('./AuditStore.js').AuditStore} [params.auditStore] - optional (AC5: Ende/Fehler-Audit).
   * @param {Function} [params.spawnFn] - nur wirksam wenn `runClaude` NICHT übergeben wird
   *   (durchgereicht an den intern erzeugten Default-Adapter — Test-Entkopplung).
   * @param {() => number} [params.now] - injectable Uhr (AC9, default Date.now — Test-Entkopplung).
   */
  constructor({ runClaude, lock, timeoutMs, auditStore, spawnFn, now } = {}) {
    this.#timeoutMs = timeoutMs ?? (Number(process.env.REGRESSION_DEFINE_TIMEOUT_MS) || DEFAULT_REGRESSION_DEFINE_TIMEOUT_MS);
    this.#runClaude =
      runClaude ?? ((params) => defaultRunClaude({ ...params, timeoutMs: this.#timeoutMs, spawnFn }));
    this.#lock = lock ?? new ProjectJobLock();
    this.#auditStore = auditStore ?? null;
    this.#now = now ?? (() => Date.now());
  }

  /**
   * Startet einen Regressions-Definitions-Lauf für ein Projekt (AC1/AC4).
   * Erwirbt das projektweise Lock; freigegeben erst bei einem terminalen
   * Zustand.
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad.
   * @param {string} projekt - Projekt-Slug/Name (Eingabe-Vertrag an den Agenten, AC4).
   * @param {{ typ: 'bereich'|'verbund', id: string }} ziel - validiertes Ziel (AC4).
   * @param {string[]} [stichworte] - optionale Owner-Stichworte (AC4/AC6).
   * @param {object} [meta]
   * @param {string|null} [meta.identity] - für das Ende-/Fehler-Audit (AC5).
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath, projekt, ziel, stichworte = [], { identity = null } = {}) {
    if (!this.#lock.tryAcquire(projectPath)) {
      return { ok: false, reason: 'locked' };
    }
    const jobId = randomUUID();
    const nowIso = new Date(this.#now()).toISOString();
    this.#jobs.set(jobId, {
      status: 'running',
      projectPath,
      projekt,
      identity: identity ?? null,
      sessionId: undefined,
      startedAt: nowIso,
      lastActivityAt: nowIso,
      phase: PHASE_SESSION_START,
    });

    const zielArg = zielToArg(ziel);
    const stichworteArg = Array.isArray(stichworte) && stichworte.length > 0
      ? ` stichworte=${stichworte.join(',')}`
      : '';
    const promptArg = `${REGRESSION_DEFINE_COMMAND} modus=vorschlag projekt=${projekt} ${zielArg}${stichworteArg}`;

    // Fire-and-forget: der Lauf kann lange dauern; der Aufrufer wartet nicht.
    this.#runRound(jobId, { resume: false, promptArg }).catch(() => {
      // #runRound fängt selbst alle Fehler ab (Sicherheitsnetz gegen unhandled rejection).
    });
    return { ok: true, jobId };
  }

  /**
   * Liest die ÖFFENTLICHE Sicht auf einen Job (AC1/AC2/AC5/AC9/AC12) —
   * secret-frei, ohne interne Felder (`projectPath`/`sessionId`/`identity`).
   * `vorschlag` nur bei `needs-review`. `startedAt`/`lastActivityAt` immer
   * (AC9); `phase` nur wenn ermittelbar (kein Rateergebnis). `error_class` bei
   * jedem `failed`; `raw_output` NUR im Parse-/Format-Fehlerpfad (AC12).
   *
   * @param {string} jobId
   * @returns {{ status: string, vorschlag?: object, result?: string, error?: string,
   *   error_class?: string, raw_output?: string, startedAt?: string,
   *   lastActivityAt?: string, phase?: string } | undefined}
   */
  getJob(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) return undefined;
    const view = { status: job.status };
    if (job.vorschlag !== undefined) view.vorschlag = job.vorschlag;
    if (job.result !== undefined) view.result = job.result;
    if (job.error !== undefined) view.error = job.error;
    if (job.error_class !== undefined) view.error_class = job.error_class;
    if (job.raw_output !== undefined) view.raw_output = job.raw_output;
    if (job.startedAt !== undefined) view.startedAt = job.startedAt;
    if (job.lastActivityAt !== undefined) view.lastActivityAt = job.lastActivityAt;
    if (job.phase !== undefined) view.phase = job.phase;
    return view;
  }

  /**
   * Reicht die redigierte, bestätigte Fassung in einen `needs-review`-Job
   * zurück und setzt den Lauf fort (AC3, Resume via STDIN).
   *
   * @param {string} jobId
   * @param {unknown} reviewed - die redigierte Vorschlags-Struktur (beliebig,
   *   wird ungeprüft an den Agenten via STDIN durchgereicht — Edge-Case
   *   "Beispieldaten entfernt" ist explizit erlaubt, s. Spec).
   * @returns {{ ok: true } | { ok: false, reason: 'not-found'|'not-waiting'|'invalid' }}
   */
  review(jobId, reviewed) {
    const job = this.#jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not-found' };
    if (job.status !== 'needs-review') return { ok: false, reason: 'not-waiting' };
    if (reviewed === undefined || reviewed === null) {
      return { ok: false, reason: 'invalid' };
    }

    // Resume: zurück auf `running`, Vorschlag/Fehler löschen, nächste Runde anstoßen.
    // AC9/AC10: neue Runde → frischer `startedAt` (Laufzeitanzeige startet neu,
    // "identisch für beide running-Phasen"), `lastActivityAt` sofort mitziehen,
    // grobe Phase `translating` für die Resume-Runde.
    const nowIso = new Date(this.#now()).toISOString();
    job.status = 'running';
    job.vorschlag = undefined;
    job.error = undefined;
    job.error_class = undefined;
    job.raw_output = undefined;
    job.startedAt = nowIso;
    job.lastActivityAt = nowIso;
    job.phase = PHASE_TRANSLATING;
    this.#runRound(jobId, { resume: true, reviewed }).catch(() => {});
    return { ok: true };
  }

  /**
   * Führt EINE Definitions-Runde aus (Initial ODER Resume) und aktualisiert
   * den Job auf `needs-review` (Interrupt, Lock bleibt gehalten) ODER einen
   * terminalen Zustand (`done`/`failed`/`auth-expired`, Lock-Freigabe + Audit).
   *
   * @param {string} jobId
   * @param {{ resume: boolean, promptArg?: string, reviewed?: unknown }} opts
   * @returns {Promise<void>}
   */
  async #runRound(jobId, { resume, promptArg, reviewed }) {
    const job = this.#jobs.get(jobId);
    if (!job) return;

    // Resume ohne bekannte claude-Session-id: ein `--resume`-loser Lauf ohne
    // Prompt würde die redigierte Fassung still verschlucken (kein
    // Rückkanal). Stattdessen definierter, secret-freier `failed`-Zustand
    // (Lock-Freigabe + Audit via #finish), Retry über einen neuen Lauf möglich.
    if (resume && !job.sessionId) {
      this.#finish(jobId, 'failed', { error: NO_SESSION_MESSAGE, error_class: ERROR_CLASS_NO_SESSION });
      return;
    }

    // AC9: sobald der Kindprozess tatsächlich läuft, grobe Phase auf
    // "reading-specs" fortschreiben (Initial-Runde) — Resume-Runde bleibt bei
    // `translating` (in review() bereits gesetzt).
    this.#touch(jobId, { phase: resume ? PHASE_TRANSLATING : PHASE_READING_SPECS });

    let res;
    try {
      res = await this.#runClaude({
        projectPath: job.projectPath,
        promptArg: resume ? undefined : promptArg,
        resumeSessionId: resume ? job.sessionId : undefined,
        reviewed,
      });
    } catch {
      this.#finish(jobId, 'failed', { error: INTERNAL_FAILURE_MESSAGE, error_class: ERROR_CLASS_AGENT_FAILED });
      return;
    }

    if (res?.authError) {
      this.#finish(jobId, 'auth-expired', { error: AUTH_EXPIRED_MESSAGE });
      return;
    }
    if (res?.spawnError) {
      this.#finish(jobId, 'failed', { error: NOT_AVAILABLE_MESSAGE, error_class: ERROR_CLASS_AGENT_FAILED });
      return;
    }
    if (res?.timedOut) {
      this.#finish(jobId, 'failed', { error: TIMEOUT_FAILURE_MESSAGE, error_class: ERROR_CLASS_TIMEOUT });
      return;
    }
    if (res?.exitCode !== 0) {
      this.#finish(jobId, 'failed', { error: GENERIC_FAILURE_MESSAGE, error_class: ERROR_CLASS_AGENT_FAILED });
      return;
    }

    // AC9: Ausgabe liegt vor, wird jetzt in ein Ergebnis übersetzt.
    this.#touch(jobId, { phase: resume ? PHASE_TRANSLATING : PHASE_DRAFTING });

    let outcome;
    try {
      outcome = parseRegressionDefineOutcome(res.output);
    } catch {
      // Nicht-parsbarer/kaputter Vorschlags-Ausgang → definierter Fehlerzustand,
      // secret-frei, Retry möglich (AC2). AC12: Fehlerklasse `parse-error` +
      // serverseitig secret-gefilterte Roh-Finalausgabe (falls vorhanden).
      const sanitized = sanitizeRawOutput(res.output);
      this.#finish(jobId, 'failed', {
        error: UNPARSABLE_MESSAGE,
        error_class: ERROR_CLASS_PARSE,
        ...(sanitized !== '' ? { raw_output: sanitized } : {}),
      });
      return;
    }

    if (outcome.status === 'failed') {
      // E2 — Bereich ohne deckende Specs (oder anderer agent-flow-seitiger
      // Abbruchgrund): klare Meldung statt eines leeren/erfundenen Vorschlags.
      this.#finish(jobId, 'failed', { error: outcome.reason, error_class: ERROR_CLASS_AGENT_FAILED });
      return;
    }

    if (outcome.status === 'needs-review') {
      // Interrupt — NICHT terminal, Lock bleibt gehalten (kein Freigeben/Audit).
      const current = this.#jobs.get(jobId);
      if (!current) return;
      current.status = 'needs-review';
      current.vorschlag = outcome.vorschlag;
      current.result = undefined;
      current.error = undefined;
      current.error_class = undefined;
      current.raw_output = undefined;
      current.lastActivityAt = new Date(this.#now()).toISOString();
      current.phase = undefined;
      // session-id für die nächste Resume-Runde merken (falls der Adapter eine liefert).
      if (res.sessionId) current.sessionId = res.sessionId;
      return;
    }

    // done — terminal.
    this.#finish(jobId, 'done', { result: DONE_RESULT_MESSAGE });
  }

  /**
   * Aktualisiert `lastActivityAt` (immer) und optional `phase` eines noch
   * laufenden Jobs (AC9, best-effort Lebendigkeits-Update während einer
   * Runde). No-op wenn der Job inzwischen verschwunden ist (defensive).
   *
   * @param {string} jobId
   * @param {{ phase?: string }} [patch]
   */
  #touch(jobId, { phase } = {}) {
    const job = this.#jobs.get(jobId);
    if (!job) return;
    job.lastActivityAt = new Date(this.#now()).toISOString();
    if (phase !== undefined) job.phase = phase;
  }

  /**
   * Setzt einen Job terminal, gibt das projektweise Lock frei (immer) und
   * schreibt genau EINEN Ende-/Fehler-Audit-Eintrag (AC5). AC9:
   * `lastActivityAt` wird beim Abschluss mitgezogen, `phase` entfällt
   * (terminal, keine laufende Phase mehr). AC12: `error_class`/`raw_output`
   * werden 1:1 durchgereicht (nur bei `failed` gesetzt, s. Aufrufer).
   *
   * @param {string} jobId
   * @param {'done'|'failed'|'auth-expired'} status
   * @param {{ result?: string, error?: string, error_class?: string, raw_output?: string }} patch
   */
  #finish(jobId, status, patch) {
    const job = this.#jobs.get(jobId);
    if (!job) return;
    job.status = status;
    job.vorschlag = undefined;
    job.result = patch.result;
    job.error = patch.error;
    job.error_class = patch.error_class;
    job.raw_output = patch.raw_output;
    job.lastActivityAt = new Date(this.#now()).toISOString();
    job.phase = undefined;

    // Lock IMMER freigeben (terminaler Zustand).
    this.#lock.release(job.projectPath);

    if (status === 'done') {
      this.#audit(job.identity, `regression-define:done:${jobId}`);
    } else {
      this.#audit(job.identity, `regression-define:error:${jobId}:${status}`);
    }
  }

  /**
   * Best-effort Audit (AC5). Ein Audit-Fehler crasht den Runner nie (analog
   * `ObsidianIngestRunner#audit`).
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
