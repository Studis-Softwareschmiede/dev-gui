/**
 * AssistService — zustandsloser Proof-Helfer (AC5, AC7, AC10).
 *
 * Kapselt den `claude -p`-Aufruf für `POST /api/assist/refine`.
 * Diese Boundary ist bewusst vom PTY-Pfad getrennt (Doktrin-Ausnahme laut
 * docs/specs/fabric-intake-dialog.md §Architektur-Hinweis, AC11):
 *   - Der PTY-/Flow-Pfad (CommandService + PtyManager) bleibt unverändert.
 *   - AssistService läuft HEADLESS (claude -p), EINMALIG, ohne JobLock.
 *
 * Security (Floor):
 *   - security/R01: kein Secret hartkodiert; kein Secret in Logs/Response.
 *   - security/R02: `text` via STDIN an claude, NIEMALS als Prozess-Argument (AC7).
 *   - security/R03: kein Shell-Interpolation; Argumente als Array an spawn/execFile.
 *   - Keine Pfad-/Secret-Leaks in Fehlermeldungen (AC10).
 *
 * Injectable (AC5): `runClaude`-Funktion kann im Test ersetzt werden
 * → kein echter claude-Aufruf nötig.
 *
 * @module AssistService
 */

import { spawn } from 'node:child_process';

/**
 * Gültige kind-Werte (AC10 — unbekanntes kind → 400, kein claude-Aufruf).
 * @type {string[]}
 */
export const VALID_KINDS = ['idea', 'change'];

/**
 * System-Prompt für claude -p.
 * Instruiert Claude, strukturiertes JSON zurückzugeben (AC5).
 * Nutzer-Text kommt via stdin — niemals im Prompt hartkodiert (security/R02).
 */
const SYSTEM_PROMPT = `You are a helpful assistant that refines user input for software project intake.
The user will provide a text describing a project idea or a change request.
Your task:
1. Rewrite the text as a clear, concise, prompt-ready description (refinedText).
2. List any open questions that need clarification (openQuestions).
3. Each question must have: question (string), why (string, optional), options (string[], optional).

Respond ONLY with valid JSON matching this schema (no markdown, no explanation outside JSON):
{
  "refinedText": "...",
  "openQuestions": [
    { "question": "...", "why": "...", "options": ["...", "..."] }
  ],
  "notes": "..."
}
The "notes" field is optional. Keep refinedText concise and actionable.`;

/**
 * Default `runClaude` implementation — nutzt `claude -p` via spawn.
 *
 * Design:
 *   - text wird via STDIN übergeben (security/R02, AC7 — nicht in argv).
 *   - `--output-format json` ist NICHT verfügbar in allen claude-Versionen;
 *     stattdessen instruieren wir claude via System-Prompt zur JSON-Ausgabe.
 *   - Timeout: 30 s (zustandsloser one-shot — keine interaktive Session).
 *   - Bei Fehler/Nicht-verfügbarkeit: Fehler werfen → Router liefert 502 (AC10).
 *
 * @param {object} params
 * @param {string} params.text       - Nutzer-Text (via STDIN übergeben)
 * @param {string} params.kind       - 'idea' | 'change' (für den Prompt-Kontext)
 * @param {string} [params.repoContext] - optionaler Repo-Kontext
 * @returns {Promise<string>} Rohe stdout-Ausgabe von claude
 */
export async function defaultRunClaude({ text, kind, repoContext }) {
  const contextNote = repoContext ? `\n\nRepository context: ${repoContext}` : '';
  const kindNote = kind === 'idea'
    ? 'This is a new project idea.'
    : 'This is a change request for an existing project.';

  // Prompt wird als stdin übergeben — kein Nutzer-Text in argv (security/R02)
  const stdinContent = `${kindNote}${contextNote}\n\n---\n${text}`;

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', SYSTEM_PROMPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // PATH-Erweiterung wird nicht gesetzt — claude muss im PATH sein (AC10)
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('claude -p timed out after 30 s'));
    }, 30_000);

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
      // Nur generische Meldung — kein Pfad-/Umgebungs-Leak (AC10, security/R01)
      if (err.code === 'ENOENT') {
        reject(new Error('claude is not available in PATH'));
      } else {
        reject(new Error('Failed to start claude'));
      }
    });

    // Text via STDIN — NIEMALS als argv (AC7, security/R02)
    child.stdin.write(stdinContent, 'utf8');
    child.stdin.end();
  });
}

/**
 * Parse die JSON-Ausgabe von claude.
 *
 * Robust: extrahiert JSON aus möglichem umgebenden Text (falls claude
 * trotz Prompt-Instruktion Markdown-Fences o.ä. voranstellt).
 *
 * @param {string} raw
 * @returns {{ refinedText: string, openQuestions: Array<{question:string, why?:string, options?:string[]}>, notes?: string }}
 * @throws {Error} bei ungültigem JSON oder fehlendem refinedText
 */
export function parseClaudeOutput(raw) {
  // Versuche direkt zu parsen
  let parsed;
  try {
    // Extrahiere JSON aus ```json ... ``` oder ``` ... ``` falls vorhanden
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    // Fallback: versuche erstes { ... } Segment zu finden
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

  if (typeof parsed.refinedText !== 'string') {
    throw new Error('claude output missing refinedText');
  }

  const openQuestions = Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [];

  return {
    refinedText: parsed.refinedText,
    openQuestions,
    ...(typeof parsed.notes === 'string' ? { notes: parsed.notes } : {}),
  };
}

/**
 * AssistService — Boundary für den zustandslosen claude-p-Proof-Helfer.
 *
 * Analog zu DockerReader (injectable exec) und BitwardenMasterKeyService
 * (injectable spawn): `runClaude` kann im Test durch einen Stub ersetzt werden.
 */
export class AssistService {
  /** @type {(params: {text:string, kind:string, repoContext?:string}) => Promise<string>} */
  #runClaude;

  /**
   * @param {object} [params]
   * @param {Function} [params.runClaude]
   *   Injectable claude-Runner. Default: defaultRunClaude (echter spawn).
   *   Signatur: ({ text, kind, repoContext? }) => Promise<string>
   */
  constructor({ runClaude } = {}) {
    this.#runClaude = runClaude ?? defaultRunClaude;
  }

  /**
   * Validiert Eingabe und führt den claude-p-Aufruf durch.
   *
   * @param {object} params
   * @param {unknown} params.text         - Nutzer-Text (muss non-empty string sein)
   * @param {unknown} params.kind         - 'idea' | 'change'
   * @param {string} [params.repoContext] - optionaler Repo-Kontext
   * @returns {Promise<{ ok: true, refinedText: string, openQuestions: Array, notes?: string }
   *                  | { ok: false, reason: 'invalid-text' | 'invalid-kind' | 'claude-error', message?: string }>}
   */
  async refine({ text, kind, repoContext }) {
    // Validierung: text muss non-empty string sein (AC10 → 400)
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, reason: 'invalid-text' };
    }

    // Validierung: kind muss in Allowlist sein (AC10 → 400)
    if (!VALID_KINDS.includes(kind)) {
      return { ok: false, reason: 'invalid-kind' };
    }

    // claude -p aufrufen (AC5 — zustandslos, kein JobLock)
    let raw;
    try {
      raw = await this.#runClaude({ text: text.trim(), kind, repoContext });
    } catch {
      // Fehler von claude (nicht verfügbar, Exit-Code != 0, Timeout) → 502 (AC10)
      // Kein Durchreichen der Fehler-Details (mögliche Pfad-/Umgebungs-Leaks)
      return { ok: false, reason: 'claude-error', message: 'claude -p unavailable or failed' };
    }

    // Ausgabe parsen
    let result;
    try {
      result = parseClaudeOutput(raw);
    } catch {
      return { ok: false, reason: 'claude-error', message: 'claude returned unexpected output format' };
    }

    return { ok: true, ...result };
  }
}
