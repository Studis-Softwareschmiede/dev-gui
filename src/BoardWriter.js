/**
 * BoardWriter — schmale, atomare Schreib-Boundary in board/stories/<id>.yaml (S-191, AC8;
 * erweitert um den Create-Pfad in S-199, ideen-inbox AC3/AC4/AC7/AC8; erweitert um den
 * Resolve-Pfad in S-200, ideen-inbox AC6/AC8).
 *
 * Einziger Schreibpfad in Board-Dateien. Vier Methoden, vier enge Verträge:
 *
 *   `setBlocked()` (Taktgeber-Eskalation, S-191) patcht eine BESTEHENDE Story-Datei
 *   und setzt AUSSCHLIESSLICH:
 *     - status        (→ immer der konstante Wert "Blocked")
 *     - blocked_reason
 *     - updated_at
 *   Alle übrigen Felder (inkl. mehrzeiliger `notes`, Kommentare, Quoting-Stil,
 *   Schlüssel-Reihenfolge) bleiben BYTE-GENAU erhalten.
 *
 *   `createIdea()` (Quick-Capture, S-199) legt eine NEUE Story-Datei
 *   `board/stories/S-<n>.yaml` an (status: Idee, title, optional notes) — OHNE
 *   `spec`, OHNE `implements` — und zählt `next_story_id` in `board/board.yaml`
 *   atomar hoch. Token-frei (kein Agenten-Aufruf). Eine In-Process-Mutex
 *   (Promise-Chain, `#createIdeaLock`) serialisiert parallele Aufrufe derselben
 *   `BoardWriter`-Instanz, damit zwei nahezu gleichzeitige Anlagen INNERHALB
 *   DIESES PROZESSES nie dieselbe `next_story_id` lesen, bevor die erste sie
 *   hochgezählt hat.
 *
 *   `resolveIdea()` (explizite Owner-Auflösung, S-200, ideen-inbox AC6) patcht
 *   eine BESTEHENDE `Idee`-Story-Datei und setzt AUSSCHLIESSLICH:
 *     - status              (→ immer der konstante Wert "Done")
 *     - updated_at
 *     - resolved_at
 *     - resolved_story_ids  (optional — nur gesetzt wenn übergeben)
 *     - resolved_note       (optional — nur gesetzt wenn übergeben)
 *   `resolved_at`/`resolved_story_ids`/`resolved_note` existieren in einer frisch
 *   über `createIdea()` angelegten Story-Datei noch NICHT als Top-Level-Schlüssel
 *   (siehe Story-Schema, ideen-inbox.md) — `patchTopLevelFields()` wird daher mit
 *   `{ allowAppend: true }` aufgerufen: fehlende Ziel-Felder werden ans Dateiende
 *   angehängt statt (wie bei `setBlocked()`) einen `field-not-found`-Fehler zu
 *   werfen. Nur `Idee`-Items sind auflösbar (Guard: aktueller `status`-Wert muss
 *   exakt `'Idee'` sein) — ein bereits `Done`/aufgelöstes Item wirft
 *   `not-resolvable` (Router mappt auf `400 { field: 'status' }`, kein zweites
 *   `Done`, idempotenz-tolerant gegenüber Doppel-Klick).
 *
 *   `archiveSupersededIdea()` (Sicherheitsnetz nach headless-`requirement`-Lauf,
 *   S-216, idea-specify-chat AC9) patcht eine BESTEHENDE `Idee`-Story-Datei
 *   AUSSCHLIESSLICH wie `resolveIdea()`, aber mit einem FESTEN
 *   `resolved_note: 'superseded-by-specify'` (`SUPERSEDED_BY_SPECIFY_NOTE`,
 *   keine Nutzer-Eingabe) statt optionaler Owner-Felder. Gleicher Guard (nur
 *   `status: Idee` ist archivierbar, sonst `not-resolvable`) — der aufrufende
 *   `IdeaSpecifyFinalizer` behandelt `not-resolvable` als No-Op (der
 *   `requirement`-Agent hat die Platzhalter-Idee bereits selbst übernommen/
 *   aufgelöst, best effort AC8, kein zweiter Write nötig).
 *
 *   `archiveDoneFeatures()` (In-place-Feature-Archiv, S-236/S-244, board-feature-archive
 *   AC1/AC2/AC8/AC9) archiviert ALLE aktuell archivierbaren Features eines Projekts.
 *   Ein Feature ist archivierbar (V1, ab V7/AC9 auf terminal erweitert), wenn es
 *   ≥1 Story hat, JEDE seiner Stories **terminal** ist (`status: Done` ODER
 *   `status: Verworfen`) UND es nicht bereits `archived: true` ist (das Pseudo-
 *   Feature `_orphaned` ist per Definition keine Datei und daher nie betroffen).
 *   Für jedes solche Feature patcht die Methode `archived: true` + `archived_at`
 *   (+ aktualisiertes `updated_at`) in das Feature-YAML UND in jede zugehörige
 *   Story-YAML — der Story-`status` bleibt UNVERÄNDERT (`Done` bleibt `Done`,
 *   `Verworfen` bleibt `Verworfen`). Alle übrigen
 *   Zeilen bleiben byte-genau erhalten (Line-Patch via
 *   `patchTopLevelFields({ allowAppend: true })` — `archived`/`archived_at`
 *   existieren in Bestandsdateien i.d.R. noch nicht und werden angehängt).
 *   `board/board.yaml` wird NICHT verändert. Der Vorgang ist idempotent: bereits
 *   archivierte Features werden von V1 ausgeschlossen, bereits archivierte
 *   Einzel-Stories werden übersprungen (kein zweites `archived_at`). Innerhalb
 *   eines Features werden ZUERST die Stories geschrieben, DANN das Feature-YAML —
 *   so bleibt ein Feature bei einem Abbruch mitten im Lauf NICHT als `archived`
 *   markiert, während einzelne Stories es noch nicht sind; ein Re-Run holt die
 *   Rest-Stories nach und markiert das Feature erst zum Schluss. Fehler beim
 *   Patchen EINES Features (z.B. `duplicate-key`) überspringen nur dieses eine
 *   Feature (best effort, kein Gesamt-Abbruch — Edge-Case-Vorgabe der Spec) und
 *   fließen nicht in die Zähler ein.
 *
 *   `archiveDoneStories()` (Story-Ebenen-Archiv, S-293, board-storys-archivieren
 *   AC1/AC2/AC9) archiviert ALLE aktuell archivierbaren Storys eines Projekts —
 *   supersedet den Feature-Ebenen-Archivpfad aus [[board-feature-archive]] als
 *   Standard-Archivknopf (dessen Schreib-Primitive werden 1:1 wiederverwendet,
 *   `archiveDoneFeatures()` bleibt unverändert bestehen für Abwärtskompatibilität,
 *   S-293/V5). Eine Story ist archivierbar, wenn ihr `status` **terminal** ist
 *   (`Done` ODER `Verworfen`) UND sie nicht bereits `archived: true` ist — UNABHÄNGIG
 *   vom Zustand ihres Eltern-Features/-Bereichs (Bereichs-Kacheln werden NIE
 *   archiviert). Patcht je archivierbarer Story `archived: true` + `archived_at`
 *   (+ aktualisiertes `updated_at`) — der Story-`status` bleibt UNVERÄNDERT.
 *   Alle übrigen Zeilen bleiben byte-genau erhalten (`patchTopLevelFields({
 *   allowAppend: true })`, wiederverwendet aus `_writeArchiveFlag()`).
 *   **Feature-YAMLs und `board/board.yaml` werden NICHT verändert** (anders als
 *   `archiveDoneFeatures()` — auf Story-Ebene gibt es kein Feature-Flag zu setzen).
 *   Idempotent: bereits archivierte Storys werden übersprungen (kein zweites
 *   `archived_at`). Best effort: schlägt das Patchen EINER Story fehl (z.B.
 *   `duplicate-key`), wird nur diese Story übersprungen + geloggt (secret-frei) —
 *   die übrigen werden dennoch archiviert, kein Gesamt-Abbruch.
 *
 *   **Cross-Prozess-Risiko (KORRIGIERT, S-199 Iteration 2):** `board/board.yaml`
 *   und `board/stories/` werden NICHT nur von dieser `BoardWriter`-Instanz
 *   geschrieben — das externe `board`-CLI (agent-flow, Bash+PyYAML,
 *   `board story add`) liest/schreibt denselben `next_story_id`-Zähler in
 *   derselben Datei, OHNE jede Lock-Koordination (verifiziert: das CLI-Skript
 *   kennt keinerlei Lock-Mechanismus). Die frühere Behauptung "Server ist
 *   Singleton-Prozess, kein Cross-Prozess-Lock nötig" war daher FALSCH — der
 *   In-Process-Mutex schützt NUR gegen parallele Aufrufe dieser einen Instanz,
 *   nicht gegen das CLI oder eine zweite dev-gui-Instanz. Die read-modify-write-
 *   Sequenz auf `next_story_id` selbst bleibt ein theoretisches Cross-Prozess-
 *   Rennen (ein geteilter Lock mit dem Bash/Python-CLI wäre riskant, da dieses
 *   Repo das CLI-Skript nicht mitkontrolliert). Um trotzdem GARANTIERT nie eine
 *   bestehende Story-Datei still zu überschreiben, schreibt `createIdea()` die
 *   finale Story-Datei über ein EXKLUSIVES Create (`_exclusiveCreate()`: tmp-
 *   Datei + `link()` statt blindem `rename()` — `link()` scheitert mit `EEXIST`
 *   wenn das Ziel bereits existiert). Bei einer Kollision wird `next_story_id`
 *   frisch aus `board.yaml` gelesen und mit der nächsten freien ID erneut
 *   versucht (begrenzte Retry-Schleife, `MAX_ID_ALLOCATION_RETRIES`) — eine
 *   Kollision führt so NIE zu stillem Datenverlust, sondern höchstens zu einem
 *   übersprungenen ID-Wert (unschädlich, IDs müssen nicht lückenlos sein).
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
  link,
  chmod,
  unlink,
  realpath,
} from 'node:fs/promises';
import { join, dirname, basename, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseBoardRoots } from './BoardAggregator.js';

/** Die drei einzigen Felder, die `setBlocked()` jemals patcht (AC8). */
export const ALLOWED_FIELDS = Object.freeze([
  'status',
  'blocked_reason',
  'updated_at',
  // ideen-inbox AC6/AC8 (S-200) — zusätzlich erlaubte Felder für `resolveIdea()`.
  // Erweitert nur die Allowlist von `patchTopLevelFields()` — `setBlocked()` übergibt
  // weiterhin ausschließlich seine eigenen drei Felder oben, unverändertes Verhalten.
  'resolved_at',
  'resolved_story_ids',
  'resolved_note',
  // board-feature-archive AC2/AC8 (S-236) — zusätzlich erlaubte Felder für
  // `archiveDoneFeatures()`. Wieder nur eine Erweiterung der Allowlist; die
  // bestehenden Methoden übergeben diese Felder nie, ihr Verhalten bleibt
  // unverändert.
  'archived',
  'archived_at',
]);

/** Story-ID-Format (z.B. "S-191") — eng gefasst, kein Pfad-Zeichen erlaubt. */
const STORY_ID_RE = /^[A-Za-z0-9_-]+$/;

/** ISO-8601 UTC-Zeitstempel-Format (wie von `Date.prototype.toISOString()` erzeugt). */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Titel-Längenlimit für `createIdea` (ideen-inbox AC3/AC8 — Schutz vor Riesen-Payloads). */
export const IDEA_TITLE_MAX_LENGTH = 200;

/** Body/Notes-Längenlimit für `createIdea` (ideen-inbox AC3/AC8). */
export const IDEA_BODY_MAX_LENGTH = 4000;

/** Top-Level `next_story_id:`-Zeile in board/board.yaml (unverschachtelt, Zeilenanfang). */
const NEXT_STORY_ID_RE = /^next_story_id:[ \t]*(\d+)[ \t]*$/m;

/**
 * Steuerzeichen-Verbot für den (einzeiligen) Titel — keine Ausnahme, auch kein
 * Tab/Newline. Zusätzlich zu den C0-Steuerzeichen: `\x7f` (DEL) und die
 * Unicode-Zeilentrenner U+2028/U+2029 (werden von manchen Renderern wie ein
 * Zeilenumbruch behandelt, obwohl sie kein C0-Steuerzeichen sind).
 */
// eslint-disable-next-line no-control-regex
const TITLE_CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u2028\u2029]/;

/**
 * Steuerzeichen-Verbot für den (mehrzeiligen) Body — `\n` ist erlaubt (Stichwort-Body
 * ist bewusst mehrzeilig), alle anderen C0-Steuerzeichen sind verboten (Zeilen-
 * Injection-Schutz analog `patchTopLevelFields`, `\r` wird vor der Prüfung zu `\n`
 * normalisiert). Zusätzlich verboten: `\x7f` (DEL) und U+2028/U+2029 (Konsistenz
 * mit `TITLE_CONTROL_CHAR_RE`).
 */
// eslint-disable-next-line no-control-regex
const BODY_CONTROL_CHAR_RE = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f\u2028\u2029]/;

/**
 * Obergrenze für Retry-Versuche bei `createIdea()`, wenn die allokierte
 * Story-ID mit einer bereits existierenden Datei kollidiert (Cross-Prozess-
 * Kollision mit einem parallelen Schreiber, z.B. dem board-CLI). Verhindert
 * eine unbegrenzte Schleife bei einem pathologisch aus dem Takt geratenen
 * `next_story_id`-Zähler.
 */
const MAX_ID_ALLOCATION_RETRIES = 10;

/** Längenlimit für `resolved_note` (ideen-inbox AC6/AC8, S-200) — optionaler,
 *  einzeiliger Verweis auf Spec/Kontext der Auflösung. */
export const RESOLVED_NOTE_MAX_LENGTH = 500;

/** Obergrenze für die Anzahl verlinkter Story-IDs bei `resolveIdea()` (ideen-inbox
 *  AC6/AC8, S-200) — Schutz vor Riesen-Payloads, analog Titel-/Body-Limits. */
export const RESOLVE_STORY_IDS_MAX_COUNT = 50;

/** Fester `resolved_note`-Wert für `archiveSupersededIdea()` (idea-specify-chat
 *  AC9) — im Unterschied zu `resolveIdea()` KEINE Nutzer-Eingabe, sondern eine
 *  konstante Markierung, dass der Finalizer die Idee automatisch archiviert hat. */
export const SUPERSEDED_BY_SPECIFY_NOTE = 'superseded-by-specify';

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
 * Formatiert den finalen Zeileninhalt für eines der erlaubten Felder.
 * `status` ist immer eine kontrollierte Konstante ("Blocked"/"Done", keine
 * Sonderzeichen, unquoted). `resolved_story_ids` wird als bereits vorformatierter
 * YAML-Flow-Sequence-String übergeben (`_formatResolvedStoryIds()`, z.B.
 * `[S-201, S-202]`) — ebenfalls unquoted geschrieben. `archived` ist ein
 * kontrollierter YAML-Boolean (immer die Konstante "true", board-feature-archive
 * AC2) — ebenfalls unquoted, damit `BoardAggregator.parseYaml` es als echten
 * Boolean statt als String "'true'" liest. Alle übrigen Felder
 * (`blocked_reason`/`updated_at`/`resolved_at`/`resolved_note`/`archived_at`)
 * werden — konsistent mit bestehenden gequoteten Feldern wie `created_at` im
 * Schema — single-quoted geschrieben.
 *
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function _formatFieldValue(key, value) {
  if (key === 'status' || key === 'resolved_story_ids' || key === 'archived') return String(value);
  return _yamlSingleQuote(value);
}

/**
 * Formatiert eine Liste von Story-IDs als YAML-Flow-Sequence (ideen-inbox AC6,
 * S-200) — z.B. `['S-201', 'S-202']` → `"[S-201, S-202]"`. IDs sind bereits
 * gegen `STORY_ID_RE` geprüft (kein Sonderzeichen, kein Quoting nötig).
 *
 * @param {string[]} ids
 * @returns {string}
 */
function _formatResolvedStoryIds(ids) {
  return `[${ids.join(', ')}]`;
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
 * @param {object} [options]
 * @param {boolean} [options.allowAppend=false]  Wenn `true` (ideen-inbox AC6,
 *   `resolveIdea()`, S-200): ein in `fields` genanntes Feld, das NICHT als
 *   Top-Level-Schlüssel existiert, wird als NEUE Zeile ans Dateiende angehängt,
 *   statt (Default-Verhalten, unverändert für `setBlocked()`) einen
 *   `field-not-found`-Fehler zu werfen.
 * @returns {string} Gepatchter Inhalt (gleiche Trailing-Newline-Konvention wie der Input).
 * @throws {BoardWriterError} bei nicht erlaubtem Feld, fehlendem/doppeltem
 *   Top-Level-Schlüssel (außer bei `allowAppend: true`) oder einem Feldwert mit
 *   eingebetteten Steuerzeichen (YAML-Line-Injection-Schutz, Defense-in-Depth
 *   auf der öffentlichen API-Grenze).
 */
export function patchTopLevelFields(content, fields, { allowAppend = false } = {}) {
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
  /** @type {string[]} Felder, die (nur bei allowAppend) ans Ende angehängt werden. */
  const missingKeys = [];
  for (const key of Object.keys(fields)) {
    if (!foundKeys.has(key)) {
      if (allowAppend) {
        missingKeys.push(key);
        continue;
      }
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

  // allowAppend (ideen-inbox AC6, resolveIdea(), S-200): Felder, die nicht als
  // Top-Level-Schlüssel existierten, werden als neue Zeilen ans Ende angehängt —
  // in der Reihenfolge, in der sie in `fields` übergeben wurden.
  for (const key of missingKeys) {
    outLines.push(`${key}: ${_formatFieldValue(key, fields[key])}`);
  }

  return outLines.join('\n') + (hasTrailingNewline ? '\n' : '');
}

/**
 * Liest den Wert eines beliebigen Top-Level-Schlüssels aus rohem YAML-Inhalt
 * (ohne vollen Parse). Strippt umschließende einfache/doppelte Anführungszeichen.
 * Nur für einzeilige Skalar-Werte gedacht (z.B. `id`, `status`) — KEIN Block-
 * Skalar-/Listen-Support (siehe `parseYaml` in BoardAggregator.js für den vollen
 * Read-Parser).
 *
 * @param {string} content
 * @param {string} key
 * @returns {string|null}
 */
function _extractTopLevelField(content, key) {
  if (typeof content !== 'string') return null;
  for (const line of content.split('\n')) {
    if (_topLevelKeyOf(line) !== key) continue;
    let v = line.slice(line.indexOf(':') + 1).trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return null;
}

/**
 * Liest den Top-Level-`id:`-Wert aus rohem YAML-Inhalt.
 * @param {string} content
 * @returns {string|null}
 */
function _extractTopLevelId(content) {
  return _extractTopLevelField(content, 'id');
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
  /**
   * In-Process-Mutex (Promise-Chain) für `createIdea()` — serialisiert parallele
   * Aufrufe derselben Instanz, damit die next_story_id-Read-Modify-Write-Sequenz
   * nie interleaved (S-199, ideen-inbox AC3/AC8).
   * @type {Promise<void>}
   */
  #createIdeaLock = Promise.resolve();

  constructor({ boardRootsEnv, fsDeps } = {}) {
    const envVal = boardRootsEnv ?? process.env.BOARD_ROOTS ?? '';
    this.#boardRoots = parseBoardRoots(envVal);
    this.#fsDeps = {
      readdir,
      readFile,
      writeFile,
      rename,
      link,
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
   * Explizite Auflösung eines `Idee`-Items (ideen-inbox AC6/AC8, S-200): patcht
   * eine BESTEHENDE Story-Datei mit `status: Idee` auf `status: Done` und
   * ergänzt `resolved_at` (+ optional `resolved_story_ids`/`resolved_note`).
   * `updated_at` wird ebenfalls aktualisiert (Konsistenz mit `setBlocked()`).
   *
   * Guard: nur Items mit aktuellem `status: Idee` sind auflösbar — ein bereits
   * `Done`/aufgelöstes (oder aus anderem Grund nicht-`Idee`) Item wirft
   * `not-resolvable` (idempotenz-tolerant gegenüber Doppel-Klick, KEIN zweites
   * `Done`, Edge-Case ideen-inbox.md). Das bloße Öffnen der Besprechung
   * (`discuss()`, AC5) ruft diese Methode NIE auf — die Auflösung ist eine
   * separate, explizite Owner-Aktion (dieser Router-Endpunkt wird nie aus dem
   * `discuss`-Pfad heraus aufgerufen).
   *
   * @param {object} params
   * @param {string} params.projectSlug   Repo-Verzeichnisname unter einem
   *   BOARD_ROOTS-Eintrag (kein Pfad — siehe Modul-Doku Pfad-Sicherheit).
   * @param {string} params.storyId       Story-ID des Idee-Items, z.B. "S-200".
   * @param {string[]} [params.resolvedStoryIds]  IDs der erzeugten To-Do-Story(s)
   *   (bereits validiert — `validateResolveInput()`), optional.
   * @param {string|null} [params.resolvedNote]  Optionaler einzeiliger Verweis
   *   (bereits validiert), optional.
   * @param {string} [params.now]  ISO-8601-Zeitstempel für `updated_at`/`resolved_at`
   *   (Default: `new Date().toISOString()`; injizierbar für deterministische Tests).
   * @returns {Promise<{ filePath: string }>}
   * @throws {BoardWriterError}
   */
  async resolveIdea({ projectSlug, storyId, resolvedStoryIds = [], resolvedNote = null, now }) {
    const timestamp = now ?? new Date().toISOString();
    if (typeof timestamp !== 'string' || !ISO_TIMESTAMP_RE.test(timestamp)) {
      throw new BoardWriterError(`Ungültiges Zeitstempel-Format: '${timestamp}'`, 'invalid-value');
    }

    const repoPath = await this._resolveProjectPath(projectSlug);
    const storiesDir = join(repoPath, 'board', 'stories');
    const filePath = await this._findStoryFile(storiesDir, storyId);

    let raw;
    try {
      raw = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch (err) {
      throw new BoardWriterError(`Story-Datei nicht lesbar: ${filePath} (${err.message})`, 'read-failed');
    }

    const currentStatus = _extractTopLevelField(raw, 'status');
    if (currentStatus !== 'Idee') {
      throw new BoardWriterError(
        `Story '${storyId}' ist nicht (mehr) auflösbar (aktueller Status: '${currentStatus ?? 'unbekannt'}')`,
        'not-resolvable',
      );
    }

    /** @type {Record<string, string>} */
    const fields = {
      status: 'Done',
      updated_at: timestamp,
      resolved_at: timestamp,
    };
    if (Array.isArray(resolvedStoryIds) && resolvedStoryIds.length > 0) {
      fields.resolved_story_ids = _formatResolvedStoryIds(resolvedStoryIds);
    }
    if (resolvedNote) {
      fields.resolved_note = resolvedNote;
    }

    // allowAppend: resolved_at/resolved_story_ids/resolved_note existieren in
    // einem frisch über createIdea() angelegten Item noch NICHT als Top-Level-
    // Schlüssel — anhängen statt field-not-found zu werfen (siehe Modul-Doku).
    const patched = patchTopLevelFields(raw, fields, { allowAppend: true });
    await this._atomicWrite(filePath, patched);

    return { filePath };
  }

  /**
   * Sicherheitsnetz-Archivierung einer superseded Idee (idea-specify-chat AC9):
   * patcht eine BESTEHENDE Story-Datei, die nach einem abgeschlossenen
   * `requirement`-Finalizer-Lauf WEITERHIN `status: Idee` trägt (der Agent hat
   * die Platzhalter-Idee nicht wie erhofft übernommen, best effort AC8), auf
   * `status: Done` + ein FESTES `resolved_note: 'superseded-by-specify'`
   * (+ `resolved_at`/`updated_at`). Anders als `resolveIdea()` (Owner-Aktion mit
   * optionalen Nutzer-Feldern) ist `resolved_note` hier IMMER die Konstante
   * `SUPERSEDED_BY_SPECIFY_NOTE` — keine Nutzer-Eingabe.
   *
   * Patch-Muster 1:1 von `resolveIdea()` übernommen (gleicher Guard: nur ein
   * Item mit aktuellem `status: Idee` ist archivierbar — ein bereits archiviertes/
   * übernommenes Item wirft `not-resolvable`; der `IdeaSpecifyFinalizer` behandelt
   * das als No-Op — der Agent hat die Idee bereits selbst korrekt aufgelöst/
   * übernommen, kein zweiter Write nötig).
   *
   * @param {object} params
   * @param {string} params.projectSlug   Repo-Verzeichnisname unter einem
   *   BOARD_ROOTS-Eintrag (kein Pfad — siehe Modul-Doku Pfad-Sicherheit).
   * @param {string} params.storyId       Story-ID des Idee-Items, z.B. "S-900".
   * @param {string} [params.now]  ISO-8601-Zeitstempel für `updated_at`/`resolved_at`
   *   (Default: `new Date().toISOString()`; injizierbar für deterministische Tests).
   * @returns {Promise<{ filePath: string }>}
   * @throws {BoardWriterError}
   */
  async archiveSupersededIdea({ projectSlug, storyId, now }) {
    const timestamp = now ?? new Date().toISOString();
    if (typeof timestamp !== 'string' || !ISO_TIMESTAMP_RE.test(timestamp)) {
      throw new BoardWriterError(`Ungültiges Zeitstempel-Format: '${timestamp}'`, 'invalid-value');
    }

    const repoPath = await this._resolveProjectPath(projectSlug);
    const storiesDir = join(repoPath, 'board', 'stories');
    const filePath = await this._findStoryFile(storiesDir, storyId);

    let raw;
    try {
      raw = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch (err) {
      throw new BoardWriterError(`Story-Datei nicht lesbar: ${filePath} (${err.message})`, 'read-failed');
    }

    const currentStatus = _extractTopLevelField(raw, 'status');
    if (currentStatus !== 'Idee') {
      throw new BoardWriterError(
        `Story '${storyId}' ist nicht (mehr) archivierbar (aktueller Status: '${currentStatus ?? 'unbekannt'}')`,
        'not-resolvable',
      );
    }

    /** @type {Record<string, string>} */
    const fields = {
      status: 'Done',
      updated_at: timestamp,
      resolved_at: timestamp,
      resolved_note: SUPERSEDED_BY_SPECIFY_NOTE,
    };

    // allowAppend: resolved_at/resolved_note existieren in einem frisch über
    // createIdea() angelegten Item noch NICHT als Top-Level-Schlüssel —
    // anhängen statt field-not-found zu werfen (siehe resolveIdea()/Modul-Doku).
    const patched = patchTopLevelFields(raw, fields, { allowAppend: true });
    await this._atomicWrite(filePath, patched);

    return { filePath };
  }

  /**
   * Archiviert ALLE aktuell archivierbaren Features eines Projekts in-place
   * (board-feature-archive AC1/AC2/AC8/AC9, S-236/S-244). Kein Hard-Delete, kein
   * Verschieben — nur ein additives Flag (`archived: true` + `archived_at`) im
   * Feature-YAML UND in jeder zugehörigen Story-YAML; der Story-`status` bleibt
   * unverändert (`Done` bleibt `Done`, `Verworfen` bleibt `Verworfen`),
   * `board/board.yaml` bleibt unangetastet. Einziger Schreibpfad (nutzt
   * `_resolveProjectPath`/`patchTopLevelFields`/`_atomicWrite`).
   *
   * Archivierbarkeits-Kriterium (V1, ab V7/AC9 auf terminal erweitert) je
   * Feature: ≥1 Story UND jede Story **terminal** (`status: Done` ODER
   * `status: Verworfen`) UND Feature nicht bereits `archived: true`. Nicht
   * archiviert werden daher Features mit ≥1 nicht-terminaler Story, Features
   * ohne Stories, das Pseudo-Feature `_orphaned` (existiert nur im Aggregator,
   * nie als Datei) und bereits archivierte Features. Idempotent: bereits
   * archivierte Einzel-Stories
   * werden übersprungen (kein zweites `archived_at`).
   *
   * Best effort (Edge-Case-Vorgabe der Spec): schlägt das Patchen EINES Features
   * fehl (z.B. `duplicate-key`), wird nur dieses Feature übersprungen und geloggt
   * (ohne Secrets) — die übrigen werden dennoch archiviert, kein Gesamt-Abbruch.
   * Reihenfolge je Feature: erst alle Stories, dann das Feature-YAML (Re-Run-
   * sicher — siehe Modul-Doku).
   *
   * @param {object} params
   * @param {string} params.projectSlug  Repo-Verzeichnisname unter einem
   *   BOARD_ROOTS-Eintrag (kein Pfad — siehe Modul-Doku Pfad-Sicherheit).
   * @param {string} [params.now]  ISO-8601-Zeitstempel für `archived_at`/`updated_at`
   *   (Default: `new Date().toISOString()`; injizierbar für deterministische Tests).
   * @returns {Promise<{ archivedFeatureCount: number, archivedStoryCount: number, archivedFeatureIds: string[] }>}
   * @throws {BoardWriterError} bei ungültigem Zeitstempel/Slug oder unbekanntem Projekt.
   */
  async archiveDoneFeatures({ projectSlug, now }) {
    const timestamp = now ?? new Date().toISOString();
    if (typeof timestamp !== 'string' || !ISO_TIMESTAMP_RE.test(timestamp)) {
      throw new BoardWriterError(`Ungültiges Zeitstempel-Format: '${timestamp}'`, 'invalid-value');
    }

    const repoPath = await this._resolveProjectPath(projectSlug);
    const featuresDir = join(repoPath, 'board', 'features');
    const storiesDir = join(repoPath, 'board', 'stories');

    const featureFiles = await this._listBoardYamlFiles(featuresDir);
    const storyFiles = await this._listBoardYamlFiles(storiesDir);

    // Stories nach ihrem parent-Feature gruppieren. Stories ohne (auflösbares)
    // parent-Feld sind verwaist (Pseudo-Feature `_orphaned`) und werden nie
    // archiviert (V1).
    /** @type {Map<string, Array<{ filePath: string, raw: string }>>} */
    const storiesByParent = new Map();
    for (const sf of storyFiles) {
      const parent = _extractTopLevelField(sf.raw, 'parent');
      if (!parent) continue;
      if (!storiesByParent.has(parent)) storiesByParent.set(parent, []);
      storiesByParent.get(parent).push(sf);
    }

    let archivedFeatureCount = 0;
    let archivedStoryCount = 0;
    /** @type {string[]} */
    const archivedFeatureIds = [];

    for (const feature of featureFiles) {
      // Defensive: ein Feature namens `_orphaned` wäre nur eine Datei mit exakt
      // dieser id — das Pseudo-Feature des Aggregators ist es nie. Trotzdem
      // konsistent mit V1 explizit ausschließen.
      if (feature.id === '_orphaned') continue;

      // V1: nicht bereits archiviert.
      if (_extractTopLevelField(feature.raw, 'archived') === 'true') continue;

      const stories = storiesByParent.get(feature.id) ?? [];
      // V1: mindestens eine Story.
      if (stories.length === 0) continue;
      // V1/V7 (AC9): jede Story ist terminal (`Done` ODER `Verworfen` — Won't-Do
      // zählt wie erledigt, siehe board-status-verworfen). Kriterium stützt sich
      // auf den tatsächlichen Story-Status, nicht auf feature.status.
      const allTerminal = stories.every((s) => {
        const status = _extractTopLevelField(s.raw, 'status');
        return status === 'Done' || status === 'Verworfen';
      });
      if (!allTerminal) continue;

      // Archivierbar → Schreibpfad (best effort je Feature).
      try {
        let patchedStoriesInFeature = 0;
        // Stories ZUERST (Re-Run-sichere Reihenfolge — siehe Modul-Doku).
        for (const s of stories) {
          // Idempotenz: bereits archivierte Einzel-Story überspringen (kein
          // zweites archived_at).
          if (_extractTopLevelField(s.raw, 'archived') === 'true') continue;
          await this._writeArchiveFlag(s.filePath, s.raw, timestamp);
          patchedStoriesInFeature++;
        }
        // Feature-YAML zum Schluss markieren.
        await this._writeArchiveFlag(feature.filePath, feature.raw, timestamp);

        archivedStoryCount += patchedStoriesInFeature;
        archivedFeatureCount++;
        archivedFeatureIds.push(feature.id);
      } catch (err) {
        // Best effort: nur dieses Feature überspringen, kein Gesamt-Abbruch
        // (Edge-Case-Vorgabe). Kein Secret im Log — nur Feature-id + errorClass.
        console.warn(
          `archiveDoneFeatures: Feature '${feature.id}' übersprungen ` +
            `(${err instanceof BoardWriterError ? err.errorClass : 'unbekannter Fehler'})`,
        );
      }
    }

    return { archivedFeatureCount, archivedStoryCount, archivedFeatureIds };
  }

  /**
   * Archiviert ALLE aktuell archivierbaren Storys eines Projekts in-place
   * (board-storys-archivieren AC1/AC2/AC9, S-293). Kein Hard-Delete, kein
   * Verschieben — nur ein additives Flag (`archived: true` + `archived_at`) je
   * Story-YAML; der Story-`status` bleibt unverändert (`Done` bleibt `Done`,
   * `Verworfen` bleibt `Verworfen`). **Feature-YAMLs und `board/board.yaml`
   * werden NICHT verändert** (im Unterschied zu `archiveDoneFeatures()`) —
   * Bereichs-Kacheln (Features) werden auf diesem Pfad nie archiviert (V1).
   * Einziger Schreibpfad (nutzt `_resolveProjectPath`/`_listBoardYamlFiles`/
   * `_writeArchiveFlag`, dieselben Primitive wie `archiveDoneFeatures()`).
   *
   * Archivierbarkeits-Kriterium (V1) je Story: `status` terminal (`Done` ODER
   * `Verworfen`) UND nicht bereits `archived: true`. Nicht-terminale und
   * bereits archivierte Storys werden nicht angefasst — unabhängig vom
   * Zustand ihres Eltern-Features/-Bereichs.
   *
   * Best effort (Edge-Case-Vorgabe der Spec): schlägt das Patchen EINER Story
   * fehl (z.B. `duplicate-key`), wird nur diese Story übersprungen und geloggt
   * (ohne Secrets) — die übrigen werden dennoch archiviert, kein Gesamt-Abbruch.
   *
   * @param {object} params
   * @param {string} params.projectSlug  Repo-Verzeichnisname unter einem
   *   BOARD_ROOTS-Eintrag (kein Pfad — siehe Modul-Doku Pfad-Sicherheit).
   * @param {string} [params.now]  ISO-8601-Zeitstempel für `archived_at`/`updated_at`
   *   (Default: `new Date().toISOString()`; injizierbar für deterministische Tests).
   * @returns {Promise<{ archivedStoryCount: number, archivedStoryIds: string[] }>}
   * @throws {BoardWriterError} bei ungültigem Zeitstempel/Slug oder unbekanntem Projekt.
   */
  async archiveDoneStories({ projectSlug, now }) {
    const timestamp = now ?? new Date().toISOString();
    if (typeof timestamp !== 'string' || !ISO_TIMESTAMP_RE.test(timestamp)) {
      throw new BoardWriterError(`Ungültiges Zeitstempel-Format: '${timestamp}'`, 'invalid-value');
    }

    const repoPath = await this._resolveProjectPath(projectSlug);
    const storiesDir = join(repoPath, 'board', 'stories');

    const storyFiles = await this._listBoardYamlFiles(storiesDir);

    let archivedStoryCount = 0;
    /** @type {string[]} */
    const archivedStoryIds = [];

    for (const story of storyFiles) {
      // V1: nicht bereits archiviert.
      if (_extractTopLevelField(story.raw, 'archived') === 'true') continue;
      // V1: status terminal (Done ODER Verworfen, konsistent mit
      // archiveDoneFeatures()/board-status-verworfen).
      const status = _extractTopLevelField(story.raw, 'status');
      if (status !== 'Done' && status !== 'Verworfen') continue;

      try {
        await this._writeArchiveFlag(story.filePath, story.raw, timestamp);
        archivedStoryCount++;
        archivedStoryIds.push(story.id);
      } catch (err) {
        // Best effort: nur diese Story überspringen, kein Gesamt-Abbruch
        // (Edge-Case-Vorgabe). Kein Secret im Log — nur Story-id + errorClass.
        console.warn(
          `archiveDoneStories: Story '${story.id}' übersprungen ` +
            `(${err instanceof BoardWriterError ? err.errorClass : 'unbekannter Fehler'})`,
        );
      }
    }

    return { archivedStoryCount, archivedStoryIds };
  }

  /**
   * Patcht `archived: true` + `archived_at` + aktualisiertes `updated_at` in den
   * übergebenen (bereits gelesenen) YAML-Inhalt und schreibt die Datei atomar
   * (board-feature-archive AC2; wiederverwendet von `archiveDoneStories()`,
   * board-storys-archivieren AC2, S-293 — geteilte Schreib-Primitive über
   * Feature- UND Story-YAMLs hinweg). `allowAppend`, weil `archived`/
   * `archived_at` in Bestandsdateien i.d.R. noch nicht als Top-Level-Schlüssel
   * existieren.
   *
   * @param {string} filePath
   * @param {string} raw  Bereits gelesener YAML-Inhalt der Datei.
   * @param {string} timestamp  ISO-8601 (bereits validiert).
   * @returns {Promise<void>}
   * @throws {BoardWriterError} (z.B. `duplicate-key`) — vom Aufrufer best-effort behandelt.
   * @private
   */
  async _writeArchiveFlag(filePath, raw, timestamp) {
    const patched = patchTopLevelFields(
      raw,
      { archived: 'true', archived_at: timestamp, updated_at: timestamp },
      { allowAppend: true },
    );
    await this._atomicWrite(filePath, patched);
  }

  /**
   * Listet alle `*.yaml`-Dateien eines Board-Verzeichnisses (features/ oder
   * stories/), liest ihren Inhalt und extrahiert die `id`. Jede Datei wird per
   * `realpath()` gegen die Verzeichnis-Schranke geprüft (Symlink-Schutz, analog
   * `_findStoryFile`). Ein fehlendes Verzeichnis (z.B. features/ nicht angelegt)
   * liefert eine leere Liste (kein Fehler). Dateien ohne `id` oder außerhalb der
   * Schranke werden still übersprungen.
   *
   * @param {string} dir  Absoluter Pfad (board/features oder board/stories).
   * @returns {Promise<Array<{ filePath: string, raw: string, id: string }>>}
   * @private
   */
  async _listBoardYamlFiles(dir) {
    let entries;
    try {
      entries = await this.#fsDeps.readdir(dir, { withFileTypes: true });
    } catch {
      return []; // Verzeichnis fehlt (z.B. features/ nicht angelegt) → leer.
    }

    let realDir;
    try {
      realDir = await this.#fsDeps.realpath(dir);
    } catch {
      return [];
    }
    const prefix = realDir.endsWith(sep) ? realDir : realDir + sep;

    /** @type {Array<{ filePath: string, raw: string, id: string }>} */
    const out = [];
    for (const entry of entries) {
      if (typeof entry.isFile === 'function' && !entry.isFile()) continue;
      if (!entry.name.endsWith('.yaml')) continue;

      const candidate = join(dir, entry.name);
      let realFile;
      try {
        realFile = await this.#fsDeps.realpath(candidate);
      } catch {
        continue;
      }
      if (!realFile.startsWith(prefix)) continue; // Symlink-Flucht → überspringen.

      let raw;
      try {
        raw = await this.#fsDeps.readFile(realFile, 'utf8');
      } catch {
        continue;
      }
      const id = _extractTopLevelId(raw);
      if (!id) continue;
      out.push({ filePath: realFile, raw, id });
    }
    return out;
  }

  /**
   * Quick-Capture-Create-Pfad (ideen-inbox AC3/AC4/AC7/AC8): legt eine neue
   * `board/stories/S-<n>.yaml` mit `status: Idee`, `title` und optional `notes`
   * (Body) an — OHNE `spec`, OHNE `implements`. Die Story-ID wird atomar aus
   * `board/board.yaml` (`next_story_id`) allokiert + hochgezählt. Token-frei
   * (kein Agenten-Aufruf).
   *
   * Reihenfolge: `next_story_id` wird ZUERST hochgezählt (ID reserviert), DANN
   * die Story-Datei EXKLUSIV angelegt (`_exclusiveCreate()` — schlägt mit
   * `EEXIST`/`id-collision` fehl statt still zu überschreiben, siehe Modul-Doku
   * Cross-Prozess-Risiko). Kollidiert die allokierte ID mit einer bereits
   * bestehenden Datei (z.B. vom parallelen board-CLI angelegt), wird
   * `next_story_id` frisch gelesen und mit der nächsten freien ID erneut
   * versucht (`MAX_ID_ALLOCATION_RETRIES`) — NIE stilles Überschreiben. Eine
   * In-Process-Mutex (`#createIdeaLock`) serialisiert zusätzlich parallele
   * Aufrufe dieser Instanz (siehe Modul-Doku).
   *
   * @param {object} params
   * @param {string} params.projectSlug  Repo-Verzeichnisname unter einem
   *   BOARD_ROOTS-Eintrag (kein Pfad — siehe Modul-Doku Pfad-Sicherheit).
   * @param {string} params.title  Einzeiler-Titel, getrimmt nicht-leer,
   *   ≤ `IDEA_TITLE_MAX_LENGTH`, keine Steuerzeichen/Zeilenumbrüche.
   * @param {string} [params.body]  Optionaler mehrzeiliger Stichwort-Body
   *   (→ `notes`), ≤ `IDEA_BODY_MAX_LENGTH`, keine Steuerzeichen außer `\n`.
   * @param {string} [params.now]  ISO-8601-Zeitstempel für `created_at`/`updated_at`
   *   (Default: `new Date().toISOString()`; injizierbar für deterministische Tests).
   * @returns {Promise<{ storyId: string, filePath: string }>}
   * @throws {BoardWriterError}
   */
  async createIdea({ projectSlug, title, body, now }) {
    // Eingabe-Validierung VOR der Mutex-Warteschlange (billig, kein IO — schnell
    // scheitern statt einen invaliden Aufruf in die Warteschlange zu stellen).
    // Reine Funktion (siehe unten) — der Router nutzt dieselbe Funktion VOR dem
    // Audit-Eintrag, damit ungültige Eingaben nie auditiert werden (Audit-First
    // gilt nur für tatsächlich versuchte Aktionen, nicht für 400-Validierung).
    const { trimmedTitle, normalizedBody, timestamp } = validateIdeaInput({ title, body, now });

    const run = this.#createIdeaLock.then(() =>
      this._createIdeaLocked({ projectSlug, trimmedTitle, normalizedBody, timestamp }),
    );
    // Lock-Chain läuft immer weiter, auch wenn dieser Aufruf scheitert — sonst
    // blockiert ein Fehlschlag alle folgenden createIdea()-Aufrufe für immer.
    this.#createIdeaLock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * Führt den eigentlichen Create-IO-Pfad aus — läuft ausschließlich innerhalb
   * der `#createIdeaLock`-Warteschlange.
   *
   * @param {object} params
   * @param {string} params.projectSlug
   * @param {string} params.trimmedTitle
   * @param {string|null} params.normalizedBody
   * @param {string} params.timestamp
   * @returns {Promise<{ storyId: string, filePath: string }>}
   * @throws {BoardWriterError}
   * @private
   */
  async _createIdeaLocked({ projectSlug, trimmedTitle, normalizedBody, timestamp }) {
    const repoPath = await this._resolveProjectPath(projectSlug);
    const boardDir = join(repoPath, 'board');
    const storiesDir = join(boardDir, 'stories');
    const boardYamlPath = join(boardDir, 'board.yaml');

    let lastCollisionErr = null;

    for (let attempt = 0; attempt < MAX_ID_ALLOCATION_RETRIES; attempt++) {
      let boardRaw;
      try {
        boardRaw = await this.#fsDeps.readFile(boardYamlPath, 'utf8');
      } catch (err) {
        throw new BoardWriterError(`board.yaml nicht lesbar: ${err.message}`, 'board-yaml-read-failed');
      }

      const match = boardRaw.match(NEXT_STORY_ID_RE);
      if (!match) {
        throw new BoardWriterError(
          'next_story_id in board.yaml nicht gefunden/ungültig',
          'invalid-board-yaml',
        );
      }
      const allocatedNumber = Number(match[1]);
      const storyId = `S-${allocatedNumber}`;
      const targetFileName = `${storyId}.yaml`;
      const filePath = join(storiesDir, targetFileName);

      // next_story_id ZUERST atomar hochzählen (ID reserviert) — siehe
      // Methoden-Doku + Modul-Doku "Cross-Prozess-Risiko". Das Read-Modify-
      // Write auf board.yaml selbst hat weiterhin ein theoretisches Cross-
      // Prozess-Fenster — der nachfolgende EXKLUSIVE Story-Create verhindert
      // aber garantiert stilles Überschreiben bei einer Kollision.
      const patchedBoardYaml = boardRaw.replace(NEXT_STORY_ID_RE, `next_story_id: ${allocatedNumber + 1}`);
      await this._atomicWrite(boardYamlPath, patchedBoardYaml);

      const storyContent = _formatIdeaStoryYaml({
        storyId,
        title: trimmedTitle,
        notes: normalizedBody,
        timestamp,
      });

      try {
        await this._exclusiveCreate(filePath, storyContent);
        return { storyId, filePath };
      } catch (err) {
        if (err instanceof BoardWriterError && err.errorClass === 'id-collision') {
          // Ein anderer Schreiber (paralleler Prozess, z.B. board-CLI, oder
          // eine vorab von "fremder Hand" angelegte Datei) hat dieselbe ID
          // bereits belegt — NICHT still überschreiben, sondern next_story_id
          // frisch lesen und mit der nächsten freien ID erneut versuchen.
          lastCollisionErr = err;
          continue;
        }
        throw err;
      }
    }

    throw new BoardWriterError(
      `Konnte nach ${MAX_ID_ALLOCATION_RETRIES} Versuchen keine freie Story-ID allokieren ` +
        `(wiederholte Kollision mit einem parallelen Schreiber): ${lastCollisionErr?.message ?? ''}`,
      'id-allocation-exhausted',
    );
  }

  /**
   * Schreibt `content` EXKLUSIV nach `filePath` — schlägt mit `id-collision`
   * fehl, wenn `filePath` bereits existiert, statt ihn still zu überschreiben
   * (Cross-Prozess-Kollisionsschutz, S-199 Iteration 2 — siehe Modul-Doku).
   * Nutzt tmp-Datei + `link()` (statt `rename()`): `rename()` überschreibt ein
   * bestehendes Ziel klaglos, `link()` scheitert dagegen mit `EEXIST`.
   *
   * @param {string} filePath
   * @param {string} content
   * @returns {Promise<void>}
   * @throws {BoardWriterError} `id-collision` wenn `filePath` bereits
   *   existiert, sonst `write-failed`.
   * @private
   */
  async _exclusiveCreate(filePath, content) {
    const dir = dirname(filePath);
    const tmpPath = join(dir, `.${basename(filePath)}.tmp.${randomBytes(4).toString('hex')}`);

    try {
      await this.#fsDeps.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
      await this.#fsDeps.chmod(tmpPath, 0o600);
      await this.#fsDeps.link(tmpPath, filePath);
    } catch (err) {
      await this.#fsDeps.unlink(tmpPath).catch(() => {});
      if (err && err.code === 'EEXIST') {
        throw new BoardWriterError(`Story-Datei existiert bereits: ${basename(filePath)}`, 'id-collision');
      }
      throw new BoardWriterError(`Exklusives Anlegen fehlgeschlagen: ${err.message}`, 'write-failed');
    }

    await this.#fsDeps.unlink(tmpPath).catch(() => {});

    try {
      await this.#fsDeps.chmod(filePath, 0o600);
    } catch {
      // Non-fatal — Rechte der finalen Datei sind best-effort.
    }
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
    await this._atomicWrite(filePath, patched);
  }

  /**
   * Schreibt `content` atomar (tmp + rename, gleiches Verzeichnis, Mode 0600) nach
   * `filePath` — geteilte Grundlage für `setBlocked()` (Patch einer bestehenden
   * Datei) und `createIdea()` (neue Story-Datei + `board.yaml`-Zähler-Update).
   *
   * @param {string} filePath
   * @param {string} content
   * @returns {Promise<void>}
   * @throws {BoardWriterError}
   * @private
   */
  async _atomicWrite(filePath, content) {
    const dir = dirname(filePath);
    const tmpPath = join(dir, `.${basename(filePath)}.tmp.${randomBytes(4).toString('hex')}`);

    try {
      await this.#fsDeps.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
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

/**
 * Reine Eingabe-Validierung für `createIdea` (kein IO, keine Instanz nötig).
 * Vom Router (`boardRouter.js`) VOR dem Audit-Eintrag wiederverwendet, damit
 * eine 400-Validierungsablehnung NIE auditiert wird (Audit-First gilt nur für
 * tatsächlich versuchte Aktionen) — `BoardWriter#createIdea` ruft dieselbe
 * Funktion intern erneut auf (Defense-in-Depth, günstig).
 *
 * @param {object} params
 * @param {unknown} params.title
 * @param {unknown} [params.body]
 * @param {unknown} [params.now]
 * @returns {{ trimmedTitle: string, normalizedBody: string|null, timestamp: string }}
 * @throws {BoardWriterError}
 */
export function validateIdeaInput({ title, body, now }) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new BoardWriterError('title darf nicht leer sein', 'invalid-title');
  }
  const trimmedTitle = title.trim();
  if (TITLE_CONTROL_CHAR_RE.test(trimmedTitle)) {
    throw new BoardWriterError(
      'title darf keine Steuerzeichen/Zeilenumbrüche enthalten',
      'invalid-title',
    );
  }
  if (trimmedTitle.length > IDEA_TITLE_MAX_LENGTH) {
    throw new BoardWriterError(
      `title überschreitet Längenlimit (${IDEA_TITLE_MAX_LENGTH})`,
      'invalid-title',
    );
  }

  let normalizedBody = null;
  if (body != null) {
    if (typeof body !== 'string') {
      throw new BoardWriterError('body muss ein String sein', 'invalid-body');
    }
    // \r\n / einzelne \r → \n normalisieren (Browser-Textarea-Line-Endings).
    const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (BODY_CONTROL_CHAR_RE.test(normalized)) {
      throw new BoardWriterError('body enthält ungültige Steuerzeichen', 'invalid-body');
    }
    if (normalized.length > IDEA_BODY_MAX_LENGTH) {
      throw new BoardWriterError(
        `body überschreitet Längenlimit (${IDEA_BODY_MAX_LENGTH})`,
        'invalid-body',
      );
    }
    normalizedBody = normalized.trim() === '' ? null : normalized;
  }

  const timestamp = now ?? new Date().toISOString();
  if (typeof timestamp !== 'string' || !ISO_TIMESTAMP_RE.test(timestamp)) {
    throw new BoardWriterError(`Ungültiges Zeitstempel-Format: '${timestamp}'`, 'invalid-value');
  }

  return { trimmedTitle, normalizedBody, timestamp };
}

/**
 * Reine Eingabe-Validierung für `resolveIdea` (ideen-inbox AC6/AC8, S-200) —
 * kein IO, keine Instanz nötig. Vom Router (`boardRouter.js`) VOR dem
 * Audit-Eintrag wiederverwendet (Audit-First — analog `validateIdeaInput`).
 *
 * @param {object} [params]
 * @param {unknown} [params.resolvedStoryIds]  Optionales Array von Story-IDs.
 * @param {unknown} [params.resolvedNote]  Optionaler einzeiliger Verweis.
 * @returns {{ resolvedStoryIds: string[], resolvedNote: string|null }}
 * @throws {BoardWriterError} `invalid-story-ids` bzw. `invalid-note`.
 */
export function validateResolveInput({ resolvedStoryIds, resolvedNote } = {}) {
  const normalizedIds = [];
  if (resolvedStoryIds != null) {
    if (!Array.isArray(resolvedStoryIds)) {
      throw new BoardWriterError('resolved_story_ids muss ein Array sein', 'invalid-story-ids');
    }
    if (resolvedStoryIds.length > RESOLVE_STORY_IDS_MAX_COUNT) {
      throw new BoardWriterError(
        `resolved_story_ids überschreitet Längenlimit (${RESOLVE_STORY_IDS_MAX_COUNT})`,
        'invalid-story-ids',
      );
    }
    for (const raw of resolvedStoryIds) {
      if (typeof raw !== 'string' || !STORY_ID_RE.test(raw.trim())) {
        throw new BoardWriterError(
          `Ungültige Story-ID in resolved_story_ids: '${raw}'`,
          'invalid-story-ids',
        );
      }
      normalizedIds.push(raw.trim());
    }
  }

  let normalizedNote = null;
  if (resolvedNote != null) {
    if (typeof resolvedNote !== 'string') {
      throw new BoardWriterError('resolved_note muss ein String sein', 'invalid-note');
    }
    const trimmed = resolvedNote.trim();
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f\u2028\u2029]/.test(trimmed)) {
      throw new BoardWriterError(
        'resolved_note darf keine Steuerzeichen/Zeilenumbrüche enthalten',
        'invalid-note',
      );
    }
    if (trimmed.length > RESOLVED_NOTE_MAX_LENGTH) {
      throw new BoardWriterError(
        `resolved_note überschreitet Längenlimit (${RESOLVED_NOTE_MAX_LENGTH})`,
        'invalid-note',
      );
    }
    normalizedNote = trimmed === '' ? null : trimmed;
  }

  return { resolvedStoryIds: normalizedIds, resolvedNote: normalizedNote };
}

/**
 * Formatiert den Inhalt einer neuen `Idee`-Story-Datei (ideen-inbox AC3, Story-
 * Schema-Tabelle): `id`, `status: Idee`, `title` (single-quoted), optional
 * `notes` (Literal-Block-Skalar `|`) und `created_at`/`updated_at`. Bewusst
 * OHNE `spec`/`implements` (Contract: "nicht gesetzt").
 *
 * @param {object} params
 * @param {string} params.storyId
 * @param {string} params.title  Bereits getrimmt + validiert (kein Steuerzeichen).
 * @param {string|null} params.notes  Bereits normalisiert + validiert, oder null.
 * @param {string} params.timestamp  ISO-8601, für created_at UND updated_at.
 * @returns {string}
 */
function _formatIdeaStoryYaml({ storyId, title, notes, timestamp }) {
  const lines = [`id: ${storyId}`, 'status: Idee', `title: ${_yamlSingleQuote(title)}`];

  if (notes) {
    lines.push('notes: |');
    for (const l of notes.split('\n')) {
      lines.push(l.length ? `  ${l}` : '');
    }
  }

  lines.push(`created_at: ${_yamlSingleQuote(timestamp)}`);
  lines.push(`updated_at: ${_yamlSingleQuote(timestamp)}`);

  return `${lines.join('\n')}\n`;
}
