/**
 * KnowledgeSourceService — zustandsloser Web-fähiger Quellen-Such-Helfer (AC3, AC11, AC12, AC15).
 *
 * Kapselt den `claude -p`-Aufruf für `POST /api/assist/knowledge-sources`.
 * Diese Boundary ist bewusst von AssistService GETRENNT (Doktrin-Auflagen A2):
 *   - AssistService bleibt tool-/netz-los (kein kind-Switch).
 *   - KnowledgeSourceService ist der EINZIGE Ort mit WebSearch-Capability.
 *   - PTY-/Flow-Pfad bleibt unberührt.
 *
 * Architektur-Auflagen (team-knowledge-add.md, bindend):
 *   A2 — Eigener Service, KEIN kind-Switch in AssistService.
 *   A3 — claude -p mit exklusiv --allowedTools WebSearch (KEIN WebFetch).
 *   A6 — Audit-Eintrag je akzeptiertem Aufruf (wird im Router geschrieben, Audit-First).
 *   A7 — Timeout 60 s + max. 1 Retry, dann { ok:false, reason:'claude-error' }, kein Crash.
 *
 * Security (Floor):
 *   - security/R01: kein Secret hartkodiert; kein Secret in Logs/Response.
 *   - security/R02: `description` via STDIN an claude, NIEMALS als Prozess-Argument (AC9).
 *   - security/R03: Argumente als Array an spawn/execFile, kein Shell-Interpolation.
 *   - Keine Pfad-/Secret-Leaks in Fehlermeldungen.
 *
 * Injectable (AC11): `runClaude`-Funktion kann im Test ersetzt werden
 * → kein echter claude-Aufruf nötig.
 *
 * @module KnowledgeSourceService
 */

import { spawn } from 'node:child_process';

/** Weiches Längenlimit für description (Zeichen) — A7. */
export const DESCRIPTION_MAX_LENGTH = 2000;

/**
 * System-Prompt für claude -p.
 * Instruiert Claude, strukturiertes JSON zurückzugeben.
 * Nutzer-Beschreibung kommt via stdin — niemals im Prompt hartkodiert (security/R02).
 */
const SYSTEM_PROMPT = `You are an expert knowledge curator. The user will describe a knowledge domain they want to add as a "Knowledge Space" for a software development team.

Your task: search the web and identify the most official, authoritative, and up-to-date documentation sources for this knowledge domain.

Respond ONLY with valid JSON matching this schema (no markdown fences, no explanation outside JSON):
{
  "suggestedPackId": "<canonical-pack-id>",
  "suggestedType": "<language|framework|build|migration|security|other>",
  "sources": [
    { "title": "...", "url": "https://...", "why": "..." }
  ],
  "notes": "..."
}

Rules:
- suggestedPackId: use canonical form: language → <name>, framework → <name>@<major>, build → build/<name>, migration → migration/<name>[@<major>].
- suggestedType: one of the listed values.
- sources: 2–6 entries, only https:// URLs, official docs/specs/repos. No blogs, no aggregators.
- notes: optional short note about the domain or sources.
- The "notes" field is optional.
- Only return JSON. No prose before or after.`;

/** Timeout in Millisekunden für einen claude-Aufruf (A7). */
const CLAUDE_TIMEOUT_MS = 60_000;

/**
 * Default `runClaude` implementation — nutzt `claude -p` via spawn.
 *
 * Design:
 *   - description wird via STDIN übergeben (security/R02, AC9 — nicht in argv).
 *   - --allowedTools WebSearch exklusiv (A3 — KEIN WebFetch, kein Schreib-/FS-Tool).
 *   - Timeout 60 s (A7).
 *   - Bei Fehler/Nicht-verfügbarkeit: Fehler werfen → Service liefert claude-error.
 *
 * @param {object} params
 * @param {string} params.description  - Nutzer-Beschreibung (via STDIN übergeben)
 * @returns {Promise<string>} Rohe stdout-Ausgabe von claude
 */
export async function defaultRunClaude({ description }) {
  // Beschreibung kommt via STDIN — nie als argv (security/R02)
  const stdinContent = description;

  return new Promise((resolve, reject) => {
    // A3: --allowedTools WebSearch exklusiv (KEIN WebFetch, KEIN anderes Tool)
    // Array-Argumente (security/R03 — kein Shell-Interpolation)
    const child = spawn(
      'claude',
      ['-p', SYSTEM_PROMPT, '--allowedTools', 'WebSearch'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    // stderr wird gedraint (verhindert Pipe-Blockade), aber NICHT gespeichert —
    // kein Pfad-/Umgebungs-Leak in Fehlermeldungen (security/R01).
    child.stderr.resume();

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('claude -p timed out after 60 s'));
    }, CLAUDE_TIMEOUT_MS);

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
      // Nur generische Meldung — kein Pfad-/Umgebungs-Leak (security/R01)
      if (err.code === 'ENOENT') {
        reject(new Error('claude is not available in PATH'));
      } else {
        reject(new Error('Failed to start claude'));
      }
    });

    // Beschreibung via STDIN — NIEMALS als argv (AC9, security/R02)
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
 * @returns {{ suggestedPackId: string, suggestedType: string, sources: Array<{title:string,url:string,why:string}>, notes?: string }}
 * @throws {Error} bei ungültigem JSON oder fehlendem suggestedPackId
 */
export function parseClaudeOutput(raw) {
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

  if (typeof parsed.suggestedPackId !== 'string') {
    throw new Error('claude output missing suggestedPackId');
  }

  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const suggestedType = typeof parsed.suggestedType === 'string' ? parsed.suggestedType : 'other';

  return {
    suggestedPackId: parsed.suggestedPackId,
    suggestedType,
    sources,
    ...(typeof parsed.notes === 'string' ? { notes: parsed.notes } : {}),
  };
}

/**
 * KnowledgeSourceService — Boundary für den web-fähigen Quellen-Such-Helfer.
 *
 * Analog zu AssistService (injectable runClaude): `runClaude` kann im Test
 * durch einen Stub ersetzt werden — kein echter claude-Aufruf nötig.
 *
 * Diese Boundary ist bewusst von AssistService getrennt (A2):
 *   - Andere Capability (Web-Suche vs. Text-Proofing).
 *   - Anderes Schema (sources[] vs. refinedText/openQuestions).
 *   - Anderes Risikoprofil (WebSearch-Tool, Timeout 60 s).
 */
export class KnowledgeSourceService {
  /** @type {(params: {description:string}) => Promise<string>} */
  #runClaude;

  /**
   * @param {object} [params]
   * @param {Function} [params.runClaude]
   *   Injectable claude-Runner. Default: defaultRunClaude (echter spawn).
   *   Signatur: ({ description }) => Promise<string>
   */
  constructor({ runClaude } = {}) {
    this.#runClaude = runClaude ?? defaultRunClaude;
  }

  /**
   * Validiert Eingabe und führt den claude-p-Aufruf durch (A7: max. 1 Retry).
   *
   * @param {object} params
   * @param {unknown} params.description  - Nutzer-Beschreibung (muss non-empty string sein)
   * @returns {Promise<
   *   { ok: true, suggestedPackId: string, suggestedType: string, sources: Array<{title:string,url:string,why:string}>, notes?: string }
   *   | { ok: false, reason: 'invalid-description' | 'claude-error', message?: string }
   * >}
   */
  async findSources({ description }) {
    // Validierung: description muss non-empty string sein
    if (typeof description !== 'string' || description.trim() === '') {
      return { ok: false, reason: 'invalid-description' };
    }

    // Weiches Längenlimit (A7)
    const trimmedDesc = description.trim().slice(0, DESCRIPTION_MAX_LENGTH);

    // claude -p aufrufen mit max. 1 Retry (A7)
    let raw;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        raw = await this.#runClaude({ description: trimmedDesc });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        // Kein zweiter Versuch nach Success — nur bei Fehler retry
      }
    }

    if (lastError !== null && raw === undefined) {
      // Fehler von claude (nicht verfügbar, Exit-Code != 0, Timeout) — kein Secret-Leak
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
