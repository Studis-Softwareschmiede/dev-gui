/**
 * TokenUsageMeter — read-only, home-confined Output-Token-Verbrauchsmessung
 * aus Claude-Code-Session-Transcripts (docs/specs/token-usage-meter.md AC1–AC6).
 *
 * Liest rekursiv alle `*.jsonl` unter `${HOME}/.claude/projects/` (A1, A4 —
 * konto-weit über ALLE Projekt-Unterordner, nicht nur ein einzelnes Projekt,
 * weil mehrere parallele headless-`claude -p`-Sessions ein Abo-Token teilen)
 * und summiert `message.usage.output_tokens` über alle Assistenten-Events
 * (`type === 'assistant'`) mit `timestamp ≥ sinceMs` (A2, A3).
 *
 * Bewusst NUR Messung, KEINE Policy (Zweck-Abschnitt der Spec): kennt weder
 * Budget noch Schwelle noch Pause — [[night-budget-guard]] konsumiert den
 * Messwert und entscheidet.
 *
 * Zeilenform (angenommen, A2/Vertrag — live gegen ein echtes Transcript
 * dieses Repos verifiziert): JSON-Lines, relevante Felder je Zeile:
 *   - `type` — nur `"assistant"`-Events tragen `usage` (User-/System-Events
 *     nicht); alle anderen Werte/fehlendes Feld → 0-Beitrag, nicht gezählt.
 *   - `timestamp` — ISO-8601; nicht parsebar UND `sinceMs` gesetzt → Event
 *     zählt nicht (A3, defensiv: lieber untermessen als fensterfremd zählen).
 *   - `message.usage.output_tokens` — int; fehlt/kein Int → 0-Beitrag,
 *     kein NaN in der Summe (AC4). Input-/Cache-Tokens werden NIE gezählt
 *     (dokumentierte, konservative Wahl, A2 — Nicht-Ziel jeder Erweiterung).
 *
 * Robustheit (AC4): eine nicht-JSON-parsebare Zeile, eine Zeile ohne
 * `usage`/`output_tokens`, eine unlesbare Datei oder ein fehlendes
 * Basis-Verzeichnis führen NIE zu einem Crash — die betroffene Einheit
 * trägt `0` bei; fehlendes Verzeichnis → `{outputTokens:0, filesScanned:0,
 * entriesCounted:0}`.
 *
 * Traversierung (Muster `AgentFlowReader#walkMd`): `fs.readdir(...,
 * {withFileTypes:true})` liefert für Symlink-Einträge `isDirectory()`/
 * `isFile()` beide `false` (roher Dirent-Typ, nicht das aufgelöste Ziel) —
 * Symlinks werden dadurch nie traversiert/gelesen, kein Ausbruch aus
 * `baseDir`. Zusätzliche Defense-in-Depth: jeder Dateipfad wird vor dem
 * Lesen gegen `resolve(baseDir) + sep` re-validiert (AC5).
 *
 * Performance (AC5): `*.jsonl`-Dateien werden zeilenweise/streamend
 * verarbeitet (`fs.createReadStream` + `node:readline`), kein Voll-Laden
 * mehrerer MB in einen String.
 *
 * Sicherheit (Floor, AC5): der Meter liest NIE Prompt-/Antwort-Inhalte aus
 * und gibt/loggt sie nie — ausschließlich numerische `usage`-Felder und
 * Zeitstempel werden inspiziert, die Rückgabe enthält ausschließlich Zahlen
 * (keine Pfade, keine Inhalte). Rein lesend, keine Seiteneffekte.
 *
 * @module TokenUsageMeter
 */

import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/** Default-Basisverzeichnis: `${HOME}/.claude/projects/` (A1). */
export function defaultBaseDir() {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Listet rekursiv alle `*.jsonl`-Dateien unter `dir` (absolute Pfade).
 * Unlesbare Verzeichnisse degradieren zu einer leeren Liste (AC4) statt zu
 * werfen. Symlink-Einträge werden nie traversiert (siehe Modul-Doku).
 * @param {string} dir
 * @param {{ readdir: Function }} fsDeps
 * @returns {Promise<string[]>}
 */
async function walkJsonl(dir, fsDeps) {
  let entries;
  try {
    entries = await fsDeps.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkJsonl(fullPath, fsDeps);
      results.push(...sub);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Wertet eine einzelne Transcript-Zeile auf ihren Output-Token-Beitrag aus
 * (AC2, AC4). Wirft nie.
 * @param {string} line
 * @param {number|null|undefined} sinceMs
 * @returns {{ counted: boolean, outputTokens: number }}
 */
function parseTranscriptLine(line, sinceMs) {
  const trimmed = line.trim();
  if (!trimmed) return { counted: false, outputTokens: 0 };

  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return { counted: false, outputTokens: 0 };
  }
  if (!entry || typeof entry !== 'object' || entry.type !== 'assistant') {
    return { counted: false, outputTokens: 0 };
  }

  if (sinceMs !== null && sinceMs !== undefined) {
    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) return { counted: false, outputTokens: 0 };
  }

  const raw = entry.message?.usage?.output_tokens;
  const outputTokens = Number.isFinite(raw) ? raw : 0;
  return { counted: true, outputTokens };
}

/**
 * @typedef {{ outputTokens: number, filesScanned: number, entriesCounted: number }} TokenUsage
 */

/**
 * TokenUsageMeter — liest Claude-Session-Transcripts read-only und liefert
 * den Output-Token-Verbrauch innerhalb eines optionalen Zeitfensters.
 */
export class TokenUsageMeter {
  #baseDir;
  #fsDeps;

  /**
   * @param {object} [opts]
   * @param {string} [opts.baseDir]  Basisverzeichnis (Default `${HOME}/.claude/projects/`,
   *   A1). Injizierbar für Tests (AC6) — kein Freitext-/Traversal-Pfad von
   *   außen, da diese Story keinen HTTP-Endpunkt exponiert.
   * @param {{ readdir?: Function, stat?: Function, createReadStream?: Function }} [opts.fsDeps]
   *   Injizierbare Lese-Primitive für Tests. Default: echte `node:fs`-Äquivalente.
   */
  constructor({ baseDir, fsDeps = {} } = {}) {
    this.#baseDir = baseDir ?? defaultBaseDir();
    this.#fsDeps = { readdir, stat, createReadStream, ...fsDeps };
  }

  /**
   * Liest rekursiv alle `*.jsonl` unter `baseDir`, summiert die Output-Tokens
   * aller Assistenten-Events mit `timestamp ≥ sinceMs` (AC1, AC2, AC3).
   * @param {{ sinceMs?: number|null }} [opts]
   * @returns {Promise<TokenUsage>}
   */
  async getUsage({ sinceMs = null } = {}) {
    const empty = { outputTokens: 0, filesScanned: 0, entriesCounted: 0 };

    let baseStat;
    try {
      baseStat = await this.#fsDeps.stat(this.#baseDir);
    } catch {
      return empty; // fehlendes/unlesbares Basis-Verzeichnis (AC4, Edge-Case A1)
    }
    if (!baseStat.isDirectory()) return empty;

    const confinedBase = resolve(this.#baseDir) + sep;
    const files = await walkJsonl(this.#baseDir, this.#fsDeps);

    let outputTokens = 0;
    let filesScanned = 0;
    let entriesCounted = 0;

    for (const filePath of files) {
      // Defense-in-Depth (AC5): niemals einen Pfad außerhalb baseDir lesen.
      if (!resolve(filePath).startsWith(confinedBase)) continue;

      const result = await this.#scanFile(filePath, sinceMs);
      if (result === null) continue; // unlesbare Datei → übersprungen (AC4)
      filesScanned += 1;
      outputTokens += result.outputTokens;
      entriesCounted += result.entriesCounted;
    }

    return { outputTokens, filesScanned, entriesCounted };
  }

  /**
   * Scannt eine einzelne `.jsonl`-Datei zeilenweise/streamend (AC5).
   * @param {string} filePath
   * @param {number|null|undefined} sinceMs
   * @returns {Promise<{ outputTokens: number, entriesCounted: number } | null>}
   *   `null` bei unlesbarer Datei (AC4).
   */
  #scanFile(filePath, sinceMs) {
    return new Promise((resolveScan) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolveScan(value);
      };

      let stream;
      try {
        stream = this.#fsDeps.createReadStream(filePath, { encoding: 'utf8' });
      } catch {
        finish(null);
        return;
      }
      stream.on('error', () => finish(null));

      let outputTokens = 0;
      let entriesCounted = 0;
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const { counted, outputTokens: contribution } = parseTranscriptLine(line, sinceMs);
        if (counted) {
          entriesCounted += 1;
          outputTokens += contribution;
        }
      });
      rl.on('close', () => finish({ outputTokens, entriesCounted }));
      rl.on('error', () => finish(null));
    });
  }
}
