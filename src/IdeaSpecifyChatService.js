/**
 * IdeaSpecifyChatService — zustandsloser, tool-loser Multi-Turn `claude -p`-Chat
 * für das Idee-Specify-Overlay (docs/specs/idea-specify-chat.md AC3, AC4, AC5, AC6, AC13).
 *
 * Kapselt den Turn-für-Turn `claude -p`-Aufruf für die Router-Endpunkte
 * `POST .../specify/start` und `POST .../specify/message`. Diese Boundary ist
 * bewusst vom PTY-Pfad UND vom tool-fähigen `HeadlessFlowRunner` getrennt
 * (docs/specs/idea-specify-chat.md §Architektur-Hinweis, AC12/ADR-016):
 *   - Kein Import von `PtyManager`/`PtySessionRegistry`/`CommandService`.
 *   - Kein `ProjectJobLock` — belegt den PTY-Job-Lock NICHT (AC5): ein parallel
 *     laufender Flow-Command bleibt unberührt.
 *   - Jeder Turn ist ein zustandsloser one-shot-Kindprozess, TOOL-LOS (KEIN
 *     `--dangerously-skip-permissions`, anders als `HeadlessFlowRunner`/
 *     `HeadlessReconcileRunner`).
 *
 * Session-Historie (AC13): serverseitig in-memory (`Map sessionId -> { turns, repoContext,
 * readyToSpecify, draftText }`), analog dem Job-Registry-Muster der bestehenden
 * Runner. Der KOMPLETTE bisherige Gesprächsverlauf geht bei JEDEM Turn erneut in
 * den `claude -p`-Aufruf ein (via stdin) — kein Kontextverlust über mehrere Turns.
 * Verlust bei Server-Neustart ist ein bewusstes Nicht-Ziel (wie bei den
 * bestehenden Runnern).
 *
 * `getSessionState(sessionId)` (S-216, AC6): liest den ZULETZT bekannten
 * `readyToSpecify`/`draftText`-Zustand einer Session — `POST .../specify/finalize`
 * erhält vom Client NUR `{ sessionId }` (kein `draftText`/`readyToSpecify` im
 * Body, siehe Verträge), der `ideaSpecifyRouter`-Finalize-Handler liest den
 * Gate-Zustand + den Prompt-Baustoff für den `IdeaSpecifyFinalizer` ausschließlich
 * über diese Methode.
 *
 * Security (Floor):
 *   - security/R01: kein Secret hartkodiert; kein Secret in Logs/Response.
 *   - security/R02: der komplette Gesprächsverlauf geht via STDIN an claude,
 *     NIEMALS als Prozess-Argument (AC5) — Command-Injection-Vermeidung.
 *   - `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` werden NIE in die Child-Env übernommen
 *     (harter Block, AC5) — wiederverwendet `buildChildEnv()` aus
 *     `HeadlessRunnerCore.js` (bereits security-geprüfte Allowlist).
 *   - Kein Shell-Interpolation; Argumente als Array an `spawn` (security/R03).
 *
 * Injectable (AC5): `runClaude`-Funktion kann im Test ersetzt werden — kein
 * echter `claude`-Aufruf nötig.
 *
 * @module IdeaSpecifyChatService
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildChildEnv } from './HeadlessRunnerCore.js';

/** Timeout-Fenster laut Spec: 30-60s je Turn (zustandsloser one-shot). */
export const DEFAULT_CHAT_TIMEOUT_MS = 45_000;

/**
 * System-Prompt für claude -p. Instruiert Claude, Rückfragen zu stellen, bis
 * die Anforderung vollständig ist, und dann strukturiertes JSON zu liefern (AC5).
 * Der Gesprächsverlauf (inkl. Owner-Text) kommt via stdin — niemals im
 * System-Prompt hartkodiert (security/R02).
 */
const SYSTEM_PROMPT = `You are a requirements analyst helping an Owner turn a rough software feature idea into a complete, specify-ready requirement through a short multi-turn conversation.
You will receive the full conversation so far via stdin (lines prefixed "Owner:" or "Claude:"), ending with the Owner's latest input.
Your task each turn:
1. If important information is still missing (goal, scope, key behaviour, acceptance criteria), ask ONE focused clarifying question as "reply" and set readyToSpecify to false.
2. Once the requirement is complete enough to hand to an engineering team, set readyToSpecify to true, set "reply" to a short confirmation message for the Owner, and include a "draftText" field: a clear, prompt-ready description of the finalized requirement (goal + scope + key behaviour).

Respond ONLY with valid JSON matching this schema (no markdown, no explanation outside JSON):
{
  "reply": "...",
  "readyToSpecify": true|false,
  "draftText": "..."
}
Omit "draftText" (or leave it an empty string) while readyToSpecify is false.`;

/**
 * Baut die stdin-Übergabe: der komplette Gesprächsverlauf als lesbares
 * Transkript ("Owner: ..." / "Claude: ...") plus optionaler Projekt-Kontext.
 * Der Owner-/Verlaufstext geht ausschliesslich hierüber an claude — NIE als argv.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} history
 * @param {string} [repoContext]
 * @returns {string}
 */
function buildTranscript(history, repoContext) {
  const lines = (history ?? []).map(
    (turn) => `${turn.role === 'assistant' ? 'Claude' : 'Owner'}: ${turn.content}`,
  );
  const contextNote = repoContext ? `\n\n(Project: ${repoContext})` : '';
  return `${lines.join('\n')}${contextNote}`;
}

/**
 * Default `runClaude` implementation — nutzt `claude -p` via spawn.
 *
 * Design:
 *   - Der komplette Gesprächsverlauf wird via STDIN übergeben (security/R02, AC5).
 *   - Tool-los: KEIN `--dangerously-skip-permissions` (anders als HeadlessFlowRunner).
 *   - Kein `cwd`-Override — reiner Text-Chat, kein Repo-Zugriff nötig.
 *   - Child-Env: `buildChildEnv()` (harter ANTHROPIC_API_KEY/OPENAI_API_KEY-Block, AC5).
 *   - Timeout: 30-60s-Fenster (Default 45s) — zustandsloser one-shot je Turn.
 *
 * @param {object} params
 * @param {Array<{role: 'user'|'assistant', content: string}>} params.history
 * @param {string} [params.repoContext]
 * @returns {Promise<string>} Rohe stdout-Ausgabe von claude
 */
export async function defaultRunClaude({ history, repoContext }) {
  const stdinContent = buildTranscript(history, repoContext);

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', SYSTEM_PROMPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildChildEnv(),
    });

    let stdout = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    // stderr wird gedraint (verhindert Pipe-Blockade), aber NICHT gespeichert —
    // kein Pfad-/Umgebungs-Leak in Fehlermeldungen (security/R01).
    child.stderr.resume();

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude -p timed out after ${DEFAULT_CHAT_TIMEOUT_MS / 1000} s`));
    }, DEFAULT_CHAT_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (code !== 0) {
        // Kein stderr in der Fehlermeldung (mögliche Pfad-/Umgebungs-Leaks)
        reject(new Error(`claude -p exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });

    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      if (err.code === 'ENOENT') {
        reject(new Error('claude is not available in PATH'));
      } else {
        reject(new Error('Failed to start claude'));
      }
    });

    // Gesprächsverlauf via STDIN — NIEMALS als argv (AC5, security/R02).
    child.stdin.write(stdinContent, 'utf8');
    child.stdin.end();
  });
}

/**
 * Baut die Seed-Nachricht für den Session-Start aus Titel + optionalen Notes
 * der Idee (AC3 — die erste `reply` ist Claudes Eröffnungs-Turn).
 *
 * @param {{ title: unknown, notes?: unknown }} idea
 * @returns {string}
 */
export function buildSeedMessage({ title, notes }) {
  const parts = [`Idea title: ${String(title ?? '').trim()}`];
  if (notes != null && String(notes).trim() !== '') {
    parts.push(`Notes: ${String(notes).trim()}`);
  }
  return parts.join('\n');
}

/**
 * Parse die JSON-Ausgabe von claude (Markdown-Fence-tolerant, analog
 * `AssistService.parseClaudeOutput`).
 *
 * @param {string} raw
 * @returns {{ reply: string, readyToSpecify: boolean, draftText?: string }}
 * @throws {Error} bei ungültigem JSON oder fehlendem `reply`
 */
export function parseClaudeOutput(raw) {
  let parsed;
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    const objectMatch = raw.match(/\{[\s\S]*\}/);
    if (!objectMatch) {
      throw new Error('claude output is not valid JSON');
    }
    try {
      parsed = JSON.parse(objectMatch[0]);
    } catch {
      throw new Error('claude output is not valid JSON');
    }
  }

  if (typeof parsed.reply !== 'string') {
    throw new Error('claude output missing reply');
  }

  const readyToSpecify = parsed.readyToSpecify === true;

  return {
    reply: parsed.reply,
    readyToSpecify,
    ...(typeof parsed.draftText === 'string' ? { draftText: parsed.draftText } : {}),
  };
}

/**
 * IdeaSpecifyChatService — Boundary für den zustandslosen Multi-Turn-Chat.
 *
 * Analog zu `AssistService` (injectable spawn): `runClaude` kann im Test durch
 * einen Stub ersetzt werden. Die Session-Historie lebt ausschliesslich in dieser
 * Instanz (`Map sessionId -> { turns, repoContext }`) — kein persistenter Speicher.
 */
export class IdeaSpecifyChatService {
  /** @type {(params: {history: Array<object>, repoContext?: string}) => Promise<string>} */
  #runClaude;

  /**
   * @type {Map<string, {
   *   turns: Array<{role:string, content:string}>,
   *   repoContext?: string,
   *   readyToSpecify: boolean,
   *   draftText?: string,
   * }>}
   * `readyToSpecify`/`draftText` spiegeln IMMER den letzten Turn dieser Session
   * (idea-specify-chat AC6): `POST .../specify/finalize` erhält vom Client NUR
   * `{ sessionId }` (kein `draftText`/`readyToSpecify` im Body) — der Router
   * liest den finalize-Gate-Zustand über `getSessionState()` aus dieser
   * serverseitig gehaltenen Historie, nicht aus dem Request.
   */
  #sessions = new Map();

  /**
   * @param {object} [params]
   * @param {Function} [params.runClaude]
   *   Injectable claude-Runner. Default: defaultRunClaude (echter spawn).
   *   Signatur: ({ history, repoContext? }) => Promise<string>
   */
  constructor({ runClaude } = {}) {
    this.#runClaude = runClaude ?? defaultRunClaude;
  }

  /**
   * Prüft, ob eine sessionId einer bekannten, laufenden Chat-Session entspricht
   * (AC4 — 404 bei unbekannter/abgelaufener Session).
   *
   * @param {unknown} sessionId
   * @returns {boolean}
   */
  hasSession(sessionId) {
    return typeof sessionId === 'string' && this.#sessions.has(sessionId);
  }

  /**
   * Startet eine neue Chat-Session (AC3): seedet mit Titel + Notes der Idee und
   * liefert Claudes Eröffnungs-Turn.
   *
   * @param {object} params
   * @param {unknown} params.title
   * @param {unknown} [params.notes]
   * @param {string} [params.repoContext]
   * @returns {Promise<{ ok: true, sessionId: string, reply: string }
   *                  | { ok: false, reason: 'claude-error', message?: string }>}
   */
  async start({ title, notes, repoContext }) {
    const seedContent = buildSeedMessage({ title, notes });
    const history = [{ role: 'user', content: seedContent }];

    let raw;
    try {
      raw = await this.#runClaude({ history, repoContext });
    } catch {
      return { ok: false, reason: 'claude-error', message: 'claude -p unavailable or failed' };
    }

    let parsed;
    try {
      parsed = parseClaudeOutput(raw);
    } catch {
      return { ok: false, reason: 'claude-error', message: 'claude returned unexpected output format' };
    }

    const sessionId = randomUUID();
    this.#sessions.set(sessionId, {
      turns: [...history, { role: 'assistant', content: parsed.reply }],
      repoContext,
      readyToSpecify: parsed.readyToSpecify,
      draftText: parsed.draftText,
    });

    return { ok: true, sessionId, reply: parsed.reply };
  }

  /**
   * Hängt eine neue Nutzer-Nachricht an die serverseitig gehaltene
   * Session-Historie an und liefert Claudes nächsten Turn (AC4, AC13).
   *
   * Die Historie wird NUR bei Erfolg committet (transaktional) — schlägt der
   * claude-Aufruf fehl, bleibt die Session-Historie unverändert (kein
   * verdoppelter Turn bei einem clientseitigen Retry mit derselben Nachricht).
   *
   * @param {object} params
   * @param {unknown} params.sessionId
   * @param {unknown} params.message
   * @returns {Promise<{ ok: true, reply: string, readyToSpecify: boolean, draftText?: string }
   *                  | { ok: false, reason: 'invalid-message' | 'session-not-found' | 'claude-error', message?: string }>}
   */
  async message({ sessionId, message }) {
    if (typeof message !== 'string' || message.trim() === '') {
      return { ok: false, reason: 'invalid-message' };
    }
    if (!this.hasSession(sessionId)) {
      return { ok: false, reason: 'session-not-found' };
    }

    const session = this.#sessions.get(sessionId);
    const candidateHistory = [...session.turns, { role: 'user', content: message.trim() }];

    let raw;
    try {
      raw = await this.#runClaude({ history: candidateHistory, repoContext: session.repoContext });
    } catch {
      return { ok: false, reason: 'claude-error', message: 'claude -p unavailable or failed' };
    }

    let parsed;
    try {
      parsed = parseClaudeOutput(raw);
    } catch {
      return { ok: false, reason: 'claude-error', message: 'claude returned unexpected output format' };
    }

    // Commit erst NACH erfolgreichem Aufruf (AC13 — kein Verlust über mehrere Turns).
    session.turns = [...candidateHistory, { role: 'assistant', content: parsed.reply }];
    session.readyToSpecify = parsed.readyToSpecify;
    session.draftText = parsed.draftText;

    return {
      ok: true,
      reply: parsed.reply,
      readyToSpecify: parsed.readyToSpecify,
      ...(parsed.draftText !== undefined ? { draftText: parsed.draftText } : {}),
    };
  }

  /**
   * Liest den zuletzt bekannten Finalize-Gate-Zustand einer Session (idea-specify-chat
   * AC6) — `POST .../specify/finalize` sendet nur `{ sessionId }`, kein
   * `draftText`/`readyToSpecify`; der Router prüft das Gate + baut den
   * `requirement`-Prompt über DIESE serverseitig gehaltene Historie.
   *
   * @param {unknown} sessionId
   * @returns {{ readyToSpecify: boolean, draftText?: string } | undefined}
   *   `undefined` bei unbekannter/abgelaufener Session (AC4-Analog).
   */
  getSessionState(sessionId) {
    if (!this.hasSession(sessionId)) return undefined;
    const session = this.#sessions.get(sessionId);
    return {
      readyToSpecify: session.readyToSpecify === true,
      ...(session.draftText !== undefined ? { draftText: session.draftText } : {}),
    };
  }
}
