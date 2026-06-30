/**
 * BoardWriter — schmale, atomare Schreib-Boundary in board/stories/<id>.yaml (S-191, AC8).
 *
 * Einziger Schreibpfad des Taktgebers in Board-Dateien. Setzt AUSSCHLIESSLICH:
 *   - status        (→ immer der konstante Wert "Blocked")
 *   - blocked_reason
 *   - updated_at
 * Alle übrigen Felder (inkl. mehrzeiliger `notes`, Kommentare, Quoting-Stil,
 * Schlüssel-Reihenfolge) bleiben BYTE-GENAU erhalten.
 *
 * Design-Entscheidung (Line-Patch statt Parse+Reserialize):
 *   `BoardAggregator.parseYaml` ist ein read-only Parser für die Anzeige — ein
 *   vollständiger YAML-Roundtrip (parse → Objekt mutieren → re-stringify) würde
 *   Quoting-Stil, Block-Skalare (`notes: |`), Kommentare und Schlüssel-Reihenfolge
 *   zerstören. Stattdessen patcht dieses Modul nur die Zeilen-Spannen der drei
 *   erlaubten Top-Level-Schlüssel und lässt jede andere Zeile unverändert durch.
 *   `BoardAggregator` selbst bleibt strikt read-only — `BoardWriter` importiert
 *   nur die reine (IO-lose) Hilfsfunktion `parseBoardRoots` von dort, um die
 *   BOARD_ROOTS-Auflösung nicht zu duplizieren.
 *
 * Pfad-Sicherheit (kein User-Input als Pfad — Path-Traversal-Schutz):
 *   - `projectSlug` ist ein reiner Verzeichnisname (kein Pfad-Trenner, kein `..`,
 *     kein NUL-Byte) — wird NIE direkt in einen Pfad interpoliert, sondern erst
 *     nach Form-Validierung mit jedem BOARD_ROOTS-Eintrag verknüpft.
 *   - Für jeden Kandidaten wird `realpath()` aufgelöst und gegen die jeweilige
 *     (ebenfalls realpath-aufgelöste) BOARD_ROOTS-Schranke mit Trailing-Slash-
 *     Prefix-Vergleich geprüft (Muster: `src/workspacePath.js` `validateProjectPath`
 *     / `commandRouter.js`).
 *   - `storyId` wird auf ein enges Format geprüft (`^[A-Za-z0-9_-]+$`) und NIE
 *     direkt in einen Dateipfad eingesetzt — die Ziel-Datei wird stattdessen über
 *     den tatsächlichen `id:`-Inhalt jeder `*.yaml`-Datei im Stories-Verzeichnis
 *     gefunden (robuster als ein Dateinamens-Präfix-Match) und ihr realer Pfad
 *     erneut gegen die Stories-Verzeichnis-Schranke geprüft (Symlink-Schutz).
 *
 * Schreiben: atomar (tmp + rename, gleiches Verzeichnis/Filesystem), restriktive
 * Permissions (0600) — Muster: `src/NotificationSettingsStore.js`.
 *
 * @module BoardWriter
 */

import {
  readdir,
  readFile,
  writeFile,
  rename,
  chmod,
  unlink,
  realpath,
} from 'node:fs/promises';
import { join, dirname, basename, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseBoardRoots } from './BoardAggregator.js';

/** Die drei einzigen Felder, die BoardWriter jemals schreibt (AC8). */
export const ALLOWED_FIELDS = Object.freeze(['status', 'blocked_reason', 'updated_at']);

/** Story-ID-Format (z.B. "S-191") — eng gefasst, kein Pfad-Zeichen erlaubt. */
const STORY_ID_RE = /^[A-Za-z0-9_-]+$/;

/** ISO-8601 UTC-Zeitstempel-Format (wie von `Date.prototype.toISOString()` erzeugt). */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Typisierter Fehler für alle BoardWriter-Fehlschläge.
 */
export class BoardWriterError extends Error {
  /** @type {string} */
  errorClass;

  /**
   * @param {string} message
   * @param {string} errorClass
   */
  constructor(message, errorClass) {
    super(message);
    this.name = 'BoardWriterError';
    this.errorClass = errorClass;
  }
}

// ── Pure Helpers (kein IO — direkt unit-testbar) ──────────────────────────────

/**
 * Erkennt eine Top-Level-YAML-Schlüssel-Zeile: keine führende Einrückung,
 * `<key>:` gefolgt von optionalem Wert. Eingerückte Zeilen (Block-Skalar-
 * Fortsetzung, mehrzeilige Quoted-Skalare) erfüllen das NIE — sie gehören
 * zum vorherigen Top-Level-Schlüssel (gleiche Erkennung wie der Block-Skalar-
 * Parser in `BoardAggregator.parseYaml`).
 *
 * @param {string} line
 * @returns {string|null} Schlüsselname oder null wenn keine Top-Level-Zeile.
 */
function _topLevelKeyOf(line) {
  if (!line || line.length === 0) return null;
  const first = line[0];
  if (first === ' ' || first === '\t') return null;
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(\s.*)?$/);
  return m ? m[1] : null;
}

/**
 * Quotet einen String als YAML-Single-Quoted-Skalar (Standard-Escaping: `'` → `''`).
 * @param {string} value
 * @returns {string}
 */
function _yamlSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Formatiert den finalen Zeileninhalt für einen der drei erlaubten Felder.
 * `status` ist immer die kontrollierte Konstante "Blocked" (keine Sonderzeichen,
 * unquoted). `blocked_reason`/`updated_at` werden — konsistent mit bestehenden
 * gequoteten Feldern wie `created_at` im Schema — single-quoted geschrieben.
 *
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function _formatFieldValue(key, value) {
  if (key === 'status') return String(value);
  return _yamlSingleQuote(value);
}

/**
 * Patcht ausschließlich die in `fields` genannten Top-Level-Schlüssel im
 * übergebenen YAML-Inhalt — jede andere Zeile (inkl. mehrzeiliger Werte,
 * Kommentare, Leerzeilen, Schlüssel-Reihenfolge) bleibt byte-genau erhalten.
 *
 * Algorithmus: der Inhalt wird in "Segmente" zerlegt — jedes Segment beginnt
 * entweder bei einer Top-Level-Schlüssel-Zeile oder (für den Inhalt vor dem
 * ersten Schlüssel, z.B. `---`) am Dateianfang, und reicht bis zur nächsten
 * Top-Level-Schlüssel-Zeile. Segmente, deren Schlüssel in `fields` vorkommt,
 * werden durch genau EINE neue Zeile ersetzt; alle anderen Segmente werden
 * unverändert in die Ausgabe übernommen.
 *
 * @param {string} content  Roher YAML-Inhalt der Story-Datei.
 * @param {Record<string, string>} fields  Map erlaubter Feldname → Roh-Wert (unquoted).
 * @returns {string} Gepatchter Inhalt (gleiche Trailing-Newline-Konvention wie der Input).
 * @throws {BoardWriterError} bei nicht erlaubtem Feld, fehlendem/doppeltem
 *   Top-Level-Schlüssel oder einem Feldwert mit eingebetteten Steuerzeichen
 *   (YAML-Line-Injection-Schutz, Defense-in-Depth auf der öffentlichen API-Grenze).
 */
export function patchTopLevelFields(content, fields) {
  if (typeof content !== 'string') {
    throw new BoardWriterError('content muss ein String sein', 'invalid-content');
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.includes(key)) {
      throw new BoardWriterError(
        `Feld '${key}' ist nicht erlaubt (nur ${ALLOWED_FIELDS.join(', ')})`,
        'field-not-allowed',
      );
    }
    // Defense-in-Depth auf der öffentlichen API-Grenze: JEDER Feldwert wird
    // gegen eingebettete Steuerzeichen/Zeilenumbrüche geprüft — unabhängig
    // davon, ob der Wert quoted (blocked_reason/updated_at) oder unquoted
    // (status) geschrieben wird. Ohne diese Prüfung könnte ein unquoted Wert
    // mit eingebettetem `\n` eine zusätzliche YAML-Zeile injizieren.
    // eslint-disable-next-line no-control-regex
    if (typeof value !== 'string' || /[\x00-\x1f]/.test(value)) {
      throw new BoardWriterError(
        `Feldwert für '${key}' enthält ungültige Steuerzeichen/Zeilenumbrüche`,
        'invalid-field-value',
      );
    }
  }

  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hasTrailingNewline) lines.pop(); // letztes leeres Element nach split() bei Trailing-\n

  /** @type {Array<{ key: string|null, start: number, end: number }>} */
  const segments = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const key = _topLevelKeyOf(lines[i]);
    if (key) {
      if (current) segments.push(current);
      current = { key, start: i, end: i + 1 };
    } else if (current) {
      current.end = i + 1;
    } else {
      current = { key: null, start: i, end: i + 1 };
    }
  }
  if (current) segments.push(current);

  const foundKeys = new Set(segments.filter((s) => s.key).map((s) => s.key));
  for (const key of Object.keys(fields)) {
    if (!foundKeys.has(key)) {
      throw new BoardWriterError(
        `Feld '${key}' nicht als Top-Level-Schlüssel in der Story-Datei gefunden`,
        'field-not-found',
      );
    }
  }

  // Duplicate-Key-Guard: kommt ein zu patchender Top-Level-Schlüssel mehrfach
  // im Dokument vor, ist nicht eindeutig, welches Vorkommen "das" Feld ist —
  // statt still ALLE Vorkommen zu ersetzen, abbrechen.
  const keyCounts = new Map();
  for (const seg of segments) {
    if (seg.key) keyCounts.set(seg.key, (keyCounts.get(seg.key) ?? 0) + 1);
  }
  for (const key of Object.keys(fields)) {
    if ((keyCounts.get(key) ?? 0) > 1) {
      throw new BoardWriterError(
        `Top-Level-Schlüssel '${key}' kommt mehrfach in der Story-Datei vor — mehrdeutig, Schreiben abgebrochen`,
        'duplicate-key',
      );
    }
  }

  const outLines = [];
  for (const seg of segments) {
    if (seg.key && Object.prototype.hasOwnProperty.call(fields, seg.key)) {
      // Nur die Wert-Zeile(n) des Felds ersetzen. Trailing-Leerzeilen am Ende
      // des Segments gehören NICHT zum Feldwert, sondern sind reine
      // Formatierung zwischen diesem und dem nächsten Top-Level-Schlüssel —
      // unverändert durchreichen (sonst geht eine Leerzeile nach dem
      // gepatchten Feld verloren, siehe Lessons 2026-06-30).
      let blankTailStart = seg.end;
      while (blankTailStart - 1 > seg.start && lines[blankTailStart - 1] === '') {
        blankTailStart--;
      }
      outLines.push(`${seg.key}: ${_formatFieldValue(seg.key, fields[seg.key])}`);
      for (let i = blankTailStart; i < seg.end; i++) outLines.push(lines[i]);
    } else {
      for (let i = seg.start; i < seg.end; i++) outLines.push(lines[i]);
    }
  }

  return outLines.join('\n') + (hasTrailingNewline ? '\n' : '');
}

/**
 * Liest den Top-Level-`id:`-Wert aus rohem YAML-Inhalt (ohne vollen Parse).
 * Strippt umschließende einfache/doppelte Anführungszeichen.
 *
 * @param {string} content
 * @returns {string|null}
 */
function _extractTopLevelId(content) {
  if (typeof content !== 'string') return null;
  for (const line of content.split('\n')) {
    if (_topLevelKeyOf(line) !== 'id') continue;
    let v = line.slice(line.indexOf(':') + 1).trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return null;
}

// ── BoardWriter ────────────────────────────────────────────────────────────

/**
 * @param {object} [options]
 * @param {string} [options.boardRootsEnv]  Override für BOARD_ROOTS (Tests).
 * @param {object} [options.fsDeps]  Injectable FS-Helfer (Default: node:fs/promises).
 */
export class BoardWriter {
  /** @type {string[]} */
  #boardRoots;
  /** @type {object} */
  #fsDeps;

  constructor({ boardRootsEnv, fsDeps } = {}) {
    const envVal = boardRootsEnv ?? process.env.BOARD_ROOTS ?? '';
    this.#boardRoots = parseBoardRoots(envVal);
    this.#fsDeps = {
      readdir,
      readFile,
      writeFile,
      rename,
      chmod,
      unlink,
      realpath,
      ...fsDeps,
    };
  }

  /**
   * Setzt eine Story in `board/stories/<id>.yaml` auf `status: Blocked` +
   * `blocked_reason` + aktualisiertes `updated_at` — atomar, nur diese drei
   * Felder (AC8). Einziger Schreibpfad des Taktgebers in Board-Dateien.
   *
   * @param {object} params
   * @param {string} params.projectSlug   Repo-Verzeichnisname unter einem
   *   BOARD_ROOTS-Eintrag (kein Pfad — siehe Modul-Doku Pfad-Sicherheit).
   * @param {string} params.storyId       Story-ID, z.B. "S-191".
   * @param {string} params.blockedReason Nicht-leerer, einzeiliger Text.
   * @param {string} [params.now]         ISO-8601-Zeitstempel für `updated_at`
   *   (Default: `new Date().toISOString()`; injizierbar für deterministische Tests).
   * @returns {Promise<{ filePath: string }>}
   * @throws {BoardWriterError}
   */
  async setBlocked({ projectSlug, storyId, blockedReason, now }) {
    if (typeof blockedReason !== 'string' || blockedReason.trim() === '') {
      throw new BoardWriterError('blockedReason darf nicht leer sein', 'invalid-value');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(blockedReason)) {
      throw new BoardWriterError(
        'blockedReason darf keine Zeilenumbrüche/Steuerzeichen enthalten',
        'invalid-value',
      );
    }

    const updatedAt = now ?? new Date().toISOString();
    if (typeof updatedAt !== 'string' || !ISO_TIMESTAMP_RE.test(updatedAt)) {
      throw new BoardWriterError(`Ungültiges updated_at-Format: '${updatedAt}'`, 'invalid-value');
    }

    const repoPath = await this._resolveProjectPath(projectSlug);
    const storiesDir = join(repoPath, 'board', 'stories');
    const filePath = await this._findStoryFile(storiesDir, storyId);

    await this._patchFile(filePath, {
      status: 'Blocked',
      blocked_reason: blockedReason.trim(),
      updated_at: updatedAt,
    });

    return { filePath };
  }

  /**
   * Löst `projectSlug` sicher zu einem absoluten Repo-Pfad innerhalb eines
   * BOARD_ROOTS-Eintrags auf (Muster: `validateProjectPath` in `workspacePath.js`).
   *
   * @param {unknown} projectSlug
   * @returns {Promise<string>}
   * @throws {BoardWriterError}
   * @private
   */
  async _resolveProjectPath(projectSlug) {
    if (typeof projectSlug !== 'string' || projectSlug.trim() === '') {
      throw new BoardWriterError('projectSlug darf nicht leer sein', 'invalid-slug');
    }
    const slug = projectSlug.trim();
    if (
      slug.includes('/') ||
      slug.includes('\\') ||
      slug.includes('\x00') ||
      slug === '.' ||
      slug === '..'
    ) {
      throw new BoardWriterError(`Ungültiger projectSlug: '${slug}'`, 'invalid-slug');
    }

    for (const root of this.#boardRoots) {
      let realRoot;
      try {
        realRoot = await this.#fsDeps.realpath(root);
      } catch {
        continue; // BOARD_ROOTS-Eintrag selbst nicht zugänglich
      }

      const candidate = join(root, slug);
      let realCandidate;
      try {
        realCandidate = await this.#fsDeps.realpath(candidate);
      } catch {
        continue; // Projekt existiert unter dieser Wurzel nicht
      }

      const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
      const inside = realCandidate === realRoot || realCandidate.startsWith(prefix);
      if (!inside) continue; // Symlink-Flucht aus der Wurzel — überspringen

      try {
        await this.#fsDeps.readdir(join(realCandidate, 'board', 'stories'));
      } catch {
        continue; // kein gültiges Board-Projekt unter diesem Kandidaten
      }

      return realCandidate;
    }

    throw new BoardWriterError(
      `Projekt '${slug}' nicht unter BOARD_ROOTS gefunden`,
      'project-not-found',
    );
  }

  /**
   * Findet die Story-Datei zu `storyId` anhand ihres tatsächlichen `id:`-Inhalts
   * (nicht anhand des Dateinamens) und prüft den realen Pfad erneut gegen die
   * Stories-Verzeichnis-Schranke (Symlink-Schutz).
   *
   * @param {string} storiesDir
   * @param {unknown} storyId
   * @returns {Promise<string>} Realer, geprüfter Dateipfad.
   * @throws {BoardWriterError}
   * @private
   */
  async _findStoryFile(storiesDir, storyId) {
    if (typeof storyId !== 'string' || !STORY_ID_RE.test(storyId.trim())) {
      throw new BoardWriterError(`Ungültige storyId: '${storyId}'`, 'invalid-story-id');
    }
    const id = storyId.trim();

    let entries;
    try {
      entries = await this.#fsDeps.readdir(storiesDir, { withFileTypes: true });
    } catch {
      throw new BoardWriterError(
        `Stories-Verzeichnis nicht lesbar: ${storiesDir}`,
        'project-not-found',
      );
    }

    const yamlEntries = entries.filter(
      (e) => (typeof e.isFile !== 'function' || e.isFile()) && e.name.endsWith('.yaml'),
    );

    const matches = [];
    for (const entry of yamlEntries) {
      const fp = join(storiesDir, entry.name);
      let raw;
      try {
        raw = await this.#fsDeps.readFile(fp, 'utf8');
      } catch {
        continue;
      }
      if (_extractTopLevelId(raw) === id) matches.push(fp);
    }

    if (matches.length === 0) {
      throw new BoardWriterError(`Story '${id}' nicht gefunden in ${storiesDir}`, 'story-not-found');
    }
    if (matches.length > 1) {
      throw new BoardWriterError(
        `Story '${id}' ist nicht eindeutig (${matches.length} Dateien gefunden) — Schreiben abgebrochen`,
        'ambiguous-story',
      );
    }

    // Boundary-Re-Check (Symlink-Schutz): realer Dateipfad muss innerhalb storiesDir liegen.
    const realStoriesDir = await this.#fsDeps.realpath(storiesDir);
    const realFile = await this.#fsDeps.realpath(matches[0]);
    const prefix = realStoriesDir.endsWith(sep) ? realStoriesDir : realStoriesDir + sep;
    if (!realFile.startsWith(prefix)) {
      throw new BoardWriterError(
        `Story-Datei '${matches[0]}' liegt außerhalb des Stories-Verzeichnisses`,
        'outside-boundary',
      );
    }

    return realFile;
  }

  /**
   * Liest, patcht und schreibt die Story-Datei atomar (tmp + rename, 0600).
   *
   * @param {string} filePath
   * @param {Record<string, string>} fields
   * @returns {Promise<void>}
   * @throws {BoardWriterError}
   * @private
   */
  async _patchFile(filePath, fields) {
    let raw;
    try {
      raw = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch (err) {
      throw new BoardWriterError(`Story-Datei nicht lesbar: ${filePath} (${err.message})`, 'read-failed');
    }

    const patched = patchTopLevelFields(raw, fields);

    const dir = dirname(filePath);
    const tmpPath = join(dir, `.${basename(filePath)}.tmp.${randomBytes(4).toString('hex')}`);

    try {
      await this.#fsDeps.writeFile(tmpPath, patched, { encoding: 'utf8', mode: 0o600 });
      await this.#fsDeps.chmod(tmpPath, 0o600);
      await this.#fsDeps.rename(tmpPath, filePath);
    } catch (err) {
      await this.#fsDeps.unlink(tmpPath).catch(() => {});
      throw new BoardWriterError(`Atomar-Schreiben fehlgeschlagen: ${err.message}`, 'write-failed');
    }

    try {
      await this.#fsDeps.chmod(filePath, 0o600);
    } catch {
      // Non-fatal — Rechte der finalen Datei sind best-effort (rename behält tmp-Rechte ohnehin).
    }
  }
}
