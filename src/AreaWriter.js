/**
 * AreaWriter — schmale, atomare Schreib-Boundary für `board/areas.yaml`
 * (bereichs-modell AC3-AC7, S-289). Analog `BoardWriter`: BOARD_ROOTS-Realpath-
 * Schranke, atomarer Write (tmp+rename, 0600). Audit-First bleibt Aufgabe des
 * Routers (dieses Modul führt selbst keinen Audit-Write aus — reiner
 * Schreibpfad, analog `BoardWriter`).
 *
 * Vier Methoden, vier enge Verträge (V3-V5 bereichs-modell.md):
 *
 *   `createArea({ projectSlug, name, description?, now? })` (AC3) fügt
 *   `board/areas.yaml` einen neuen Eintrag mit stabiler kebab-case-`id`
 *   (kollisionsfrei aus `name` abgeleitet, `_slugify()`), getrimmtem/
 *   validiertem `name` und `order` ans Ende (max. bestehende `order` + 1,
 *   oder 1 bei leerer Liste) hinzu. Leerer/zu langer `name` →
 *   `invalid-name`; case-insensitiver Duplikat-`name` → `duplicate-name`
 *   (kein Anlegen).
 *
 *   `renameArea({ projectSlug, id, name, now? })` (AC4) ändert AUSSCHLIESSLICH
 *   den `name` eines bestehenden Eintrags — `id`/`order`/`description` bleiben
 *   unverändert. Gleiche Validierung wie `createArea` (Duplikat-Check
 *   schließt den umzubenennenden Eintrag selbst aus). Unbekannte `id` →
 *   `area-not-found`.
 *
 *   `reorderAreas({ projectSlug, orderedIds, now? })` (AC4) setzt `order`
 *   gemäß der Reihenfolge in `orderedIds` (1-basiert). `orderedIds` MUSS
 *   genau die Menge der vorhandenen Bereichs-IDs sein (keine fehlende, keine
 *   fremde, keine doppelte ID) — sonst `invalid-order-ids`, KEIN Teil-Schreiben.
 *
 *   `deleteArea({ projectSlug, id, now? })` (AC5) entfernt einen Eintrag NUR,
 *   wenn weder ein Feature/eine Story (aktiv ODER archiviert — beide bleiben
 *   als Datei liegen, ein Scan aller `board/features/*.yaml` +
 *   `board/stories/*.yaml` deckt daher automatisch beide Zustände ab) mit
 *   eigenem `area === id` NOCH eine Spec mit `area: <id>` im Frontmatter
 *   existiert. Ist etwas gebunden → harter Abbruch `area-not-empty` mit
 *   `err.details = { storyCount, specCount }` (KEINE Teil-Löschung).
 *   `storyCount` fasst — konsistent mit dem `Verträge`-Abschnitt der Spec, der
 *   nur `storyCount`/`specCount` (kein separates `featureCount`) kennt —
 *   Features UND Storys mit eigenem `area === id` zusammen (ein Feature mit
 *   `area === id` blockiert die Löschung genauso wie eine einzelne Story mit
 *   eigenem `area === id`; das deckt sich mit dem Roll-up-Fallback in
 *   `BoardAggregator` — Stories ohne eigenes `area` erben es dort vom
 *   Eltern-Feature, das dann selbst bereits als "gebunden" gezählt wird).
 *
 * Schema (konsumiert, NICHT neu definiert — Nicht-Ziel bereichs-modell.md):
 *   `board/areas.yaml` ist eine root-level YAML-Liste von Mappings:
 *     - id: <kebab-case>
 *       name: '<Anzeigename>'
 *       order: <Integer>
 *       description: '<optional>'
 *   Gelesen über `parseAreasYamlList()` (BoardAggregator.js, geteilter Parser
 *   mit dem Read-Aggregator). Da `AreaWriter` der EINZIGE Schreibpfad ist
 *   (kein manuelles Ko-Editieren erwartet, siehe Moduldoku bereichs-modell.md),
 *   liest/serialisiert dieses Modul die Datei vollständig neu (kein Line-Patch
 *   wie bei `BoardWriter`s Story-Dateien, die von Menschen mitgepflegt werden)
 *   — ein Eintrag, der die Mindest-Form (nicht-leere `id`/`name`, Integer
 *   `order`) nicht erfüllt, wird best-effort übersprungen (identische
 *   Toleranz wie der Read-Pfad, `BoardAggregator._buildAreaEntries`).
 *
 * Pfad-Sicherheit (identisch zu `BoardWriter.js` — siehe dort für die volle
 * Begründung): `projectSlug` wird nie direkt in einen Pfad interpoliert,
 * sondern erst nach Form-Validierung gegen jeden BOARD_ROOTS-Eintrag per
 * `realpath()` geprüft (Trailing-Slash-Prefix-Vergleich, Symlink-Schutz).
 * Verzeichnis-Listings (`board/features`, `board/stories`, `docs/specs` für
 * den Lösch-Guard) prüfen jede Datei zusätzlich per `realpath()` gegen ihr
 * jeweiliges Verzeichnis (Symlink-Flucht-Schutz, analog
 * `BoardWriter._listBoardYamlFiles`).
 *
 * Schreiben: atomar (tmp + rename, gleiches Verzeichnis), restriktive
 * Permissions (0600) — Muster: `BoardWriter.js`/`NotificationSettingsStore.js`.
 *
 * @module AreaWriter
 */

import { readdir, readFile, writeFile, rename, chmod, unlink, realpath } from 'node:fs/promises';
import { join, dirname, basename, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseBoardRoots, parseAreasYamlList, parseYaml } from './BoardAggregator.js';
import { parseFrontmatter } from './DocsReader.js';

/** Längenlimit für `name` (AC3/AC4) — kurzer Anzeigename, analog Titel-Limits anderswo. */
export const AREA_NAME_MAX_LENGTH = 100;

/** Längenlimit für `description` (AC3/AC4) — optionaler, einzeiliger Hinweistext. */
export const AREA_DESCRIPTION_MAX_LENGTH = 500;

/** Kebab-case-Format für Bereichs-IDs — vom Router auch zur `:id`-Pfadparameter-Prüfung genutzt. */
export const AREA_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Obergrenze für die Kollisions-Suffix-Suche bei `_slugify()` (defensiv, unerreichbar im Normalfall). */
const MAX_SLUG_COLLISION_ATTEMPTS = 1000;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u2028\u2029]/;

/**
 * Typisierter Fehler für alle AreaWriter-Fehlschläge. `details` (optional)
 * trägt zusätzliche, strukturierte Payload-Felder — aktuell nur für
 * `area-not-empty` genutzt (`{ storyCount, specCount }`, AC5/Verträge).
 */
export class AreaWriterError extends Error {
  /** @type {string} */
  errorClass;
  /** @type {object|undefined} */
  details;

  /**
   * @param {string} message
   * @param {string} errorClass
   * @param {object} [details]
   */
  constructor(message, errorClass, details) {
    super(message);
    this.name = 'AreaWriterError';
    this.errorClass = errorClass;
    if (details) this.details = details;
  }
}

// ── Pure Helpers (kein IO — direkt unit-testbar) ──────────────────────────────

/**
 * Quotet einen String als YAML-Single-Quoted-Skalar (Standard-Escaping: `'` → `''`).
 * @param {string} value
 * @returns {string}
 */
function _yamlSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Leitet eine kebab-case-ID aus einem Anzeigenamen ab (AC3). Deutsche Umlaute
 * werden vor der Diakritika-Entfernung transliteriert (ä→ae, ö→oe, ü→ue,
 * ß→ss), damit "Öffentlichkeit" nicht zu "ffentlichkeit" verstümmelt wird.
 * Alles andere außer `[a-z0-9]` wird zu einem einzelnen Trennstrich
 * kollabiert; führende/nachgestellte Striche werden entfernt. Ein leeres
 * Ergebnis (z.B. Name besteht nur aus Emoji/Symbolen) fällt auf den
 * Platzhalter `bereich` zurück.
 *
 * @param {string} name
 * @returns {string}
 */
function _slugifyBase(name) {
  const UMLAUT_MAP = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };
  let s = String(name).replace(/[äöüÄÖÜß]/g, (ch) => UMLAUT_MAP[ch] ?? ch);
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'bereich';
}

/**
 * Erzeugt eine kollisionsfreie kebab-case-`id` (AC3): hängt bei Kollision mit
 * einer bereits vorhandenen ID `-2`, `-3`, … an, bis eine freie ID gefunden ist.
 *
 * @param {string} name
 * @param {Set<string>} existingIds
 * @returns {string}
 * @throws {AreaWriterError} `id-generation-exhausted` (defensiv, praktisch unerreichbar)
 */
function _generateAreaId(name, existingIds) {
  const base = _slugifyBase(name);
  if (!existingIds.has(base)) return base;
  for (let n = 2; n <= MAX_SLUG_COLLISION_ATTEMPTS; n++) {
    const candidate = `${base}-${n}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new AreaWriterError(
    `Konnte nach ${MAX_SLUG_COLLISION_ATTEMPTS} Versuchen keine freie Bereichs-ID ableiten`,
    'id-generation-exhausted',
  );
}

/**
 * Reine Eingabe-Validierung für `name` (AC3/AC4) — kein IO. Vom Router VOR
 * dem Audit-Eintrag wiederverwendbar (Audit-First-Muster, analog
 * `BoardWriter.validateIdeaInput`).
 *
 * @param {unknown} name
 * @returns {string} getrimmter, validierter Name.
 * @throws {AreaWriterError} `invalid-name`
 */
export function validateAreaName(name) {
  if (typeof name !== 'string') {
    throw new AreaWriterError('name muss ein String sein', 'invalid-name');
  }
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new AreaWriterError('name darf nicht leer sein', 'invalid-name');
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new AreaWriterError('name darf keine Steuerzeichen/Zeilenumbrüche enthalten', 'invalid-name');
  }
  if (trimmed.length > AREA_NAME_MAX_LENGTH) {
    throw new AreaWriterError(`name überschreitet Längenlimit (${AREA_NAME_MAX_LENGTH})`, 'invalid-name');
  }
  return trimmed;
}

/**
 * Reine Eingabe-Validierung für `description` (AC3, optional) — kein IO.
 *
 * @param {unknown} [description]
 * @returns {string|null}
 * @throws {AreaWriterError} `invalid-description`
 */
export function validateAreaDescription(description) {
  if (description == null) return null;
  if (typeof description !== 'string') {
    throw new AreaWriterError('description muss ein String sein', 'invalid-description');
  }
  const trimmed = description.trim();
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new AreaWriterError(
      'description darf keine Steuerzeichen/Zeilenumbrüche enthalten',
      'invalid-description',
    );
  }
  if (trimmed.length > AREA_DESCRIPTION_MAX_LENGTH) {
    throw new AreaWriterError(
      `description überschreitet Längenlimit (${AREA_DESCRIPTION_MAX_LENGTH})`,
      'invalid-description',
    );
  }
  return trimmed === '' ? null : trimmed;
}

/**
 * Reine Eingabe-Validierung für `orderedIds` (AC4, `reorderAreas`) — prüft
 * nur die FORM (Array von nicht-leeren Strings) — der eigentliche
 * Mengen-Abgleich gegen die vorhandenen IDs passiert in `reorderAreas()`
 * selbst (braucht den aktuellen Datei-Inhalt).
 *
 * @param {unknown} orderedIds
 * @returns {string[]}
 * @throws {AreaWriterError} `invalid-order-ids`
 */
export function validateOrderedIds(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new AreaWriterError('orderedIds muss ein nicht-leeres Array sein', 'invalid-order-ids');
  }
  const out = [];
  for (const raw of orderedIds) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new AreaWriterError('orderedIds enthält einen ungültigen Eintrag', 'invalid-order-ids');
    }
    out.push(raw.trim());
  }
  return out;
}

/**
 * Serialisiert die normalisierte Bereichsliste als root-level YAML-Liste von
 * Mappings (Format wie `BoardAggregator.parseAreasYamlList()` erwartet).
 * `id` wird unquoted geschrieben (immer kebab-case, kein Sonderzeichen —
 * durch `_slugifyBase()`/`AREA_ID_RE` garantiert). `name`/`description`
 * werden single-quoted (Standard-Escaping) geschrieben, analog
 * `BoardWriter._yamlSingleQuote()`.
 *
 * @param {Array<{ id: string, name: string, order: number, description: string|null }>} areas
 * @returns {string}
 */
function _serializeAreasYaml(areas) {
  const lines = [];
  for (const a of areas) {
    lines.push(`- id: ${a.id}`);
    lines.push(`  name: ${_yamlSingleQuote(a.name)}`);
    lines.push(`  order: ${a.order}`);
    if (a.description != null && a.description !== '') {
      lines.push(`  description: ${_yamlSingleQuote(a.description)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Normalisiert einen rohen `areas.yaml`-Listen-Eintrag (best effort — siehe
 * Moduldoku "Schema"). Ungültige Einträge (fehlendes `id`/`name`, `order`
 * kein Integer) werden mit `null` markiert und vom Aufrufer übersprungen
 * (kein Crash, konsistent mit `BoardAggregator._buildAreaEntries`).
 *
 * @param {unknown} raw
 * @returns {{ id: string, name: string, order: number, description: string|null }|null}
 */
function _normalizeAreaEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id != null ? String(raw.id).trim() : '';
  const name = raw.name != null ? String(raw.name).trim() : '';
  const order = raw.order;
  if (!id || !name || typeof order !== 'number' || !Number.isInteger(order)) return null;
  return {
    id,
    name,
    order,
    description: raw.description != null ? String(raw.description) : null,
  };
}

// ── AreaWriter ─────────────────────────────────────────────────────────────

/**
 * @param {object} [options]
 * @param {string} [options.boardRootsEnv]  Override für BOARD_ROOTS (Tests).
 * @param {object} [options.fsDeps]  Injectable FS-Helfer (Default: node:fs/promises).
 */
export class AreaWriter {
  /** @type {string[]} */
  #boardRoots;
  /** @type {object} */
  #fsDeps;

  constructor({ boardRootsEnv, fsDeps } = {}) {
    const envVal = boardRootsEnv ?? process.env.BOARD_ROOTS ?? '';
    this.#boardRoots = parseBoardRoots(envVal);
    this.#fsDeps = { readdir, readFile, writeFile, rename, chmod, unlink, realpath, ...fsDeps };
  }

  /**
   * Legt einen neuen Bereich an (AC3, V3).
   *
   * @param {object} params
   * @param {string} params.projectSlug
   * @param {string} params.name  Wird intern erneut über `validateAreaName()` geprüft (Defense-in-Depth).
   * @param {string} [params.description]
   * @returns {Promise<{ id: string }>}
   * @throws {AreaWriterError}
   */
  async createArea({ projectSlug, name, description }) {
    const trimmedName = validateAreaName(name);
    const normalizedDescription = validateAreaDescription(description);

    const repoPath = await this._resolveProjectPath(projectSlug);
    const filePath = join(repoPath, 'board', 'areas.yaml');
    const areas = await this._readAreas(filePath);

    const duplicate = areas.some((a) => a.name.toLowerCase() === trimmedName.toLowerCase());
    if (duplicate) {
      throw new AreaWriterError(`Bereichsname '${trimmedName}' ist bereits vergeben`, 'duplicate-name');
    }

    const existingIds = new Set(areas.map((a) => a.id));
    const id = _generateAreaId(trimmedName, existingIds);
    const maxOrder = areas.reduce((max, a) => Math.max(max, a.order), 0);

    areas.push({ id, name: trimmedName, order: maxOrder + 1, description: normalizedDescription });
    await this._atomicWrite(filePath, _serializeAreasYaml(areas));

    return { id };
  }

  /**
   * Benennt einen bestehenden Bereich um — NUR `name` ändert sich, `id`
   * bleibt stabil (AC4, V4).
   *
   * @param {object} params
   * @param {string} params.projectSlug
   * @param {string} params.id
   * @param {string} params.name
   * @returns {Promise<{ id: string }>}
   * @throws {AreaWriterError}
   */
  async renameArea({ projectSlug, id, name }) {
    const trimmedName = validateAreaName(name);
    if (typeof id !== 'string' || id.trim() === '') {
      throw new AreaWriterError('id darf nicht leer sein', 'invalid-id');
    }
    const targetId = id.trim();

    const repoPath = await this._resolveProjectPath(projectSlug);
    const filePath = join(repoPath, 'board', 'areas.yaml');
    const areas = await this._readAreas(filePath);

    const idx = areas.findIndex((a) => a.id === targetId);
    if (idx === -1) {
      throw new AreaWriterError(`Bereich '${targetId}' nicht gefunden`, 'area-not-found');
    }

    const duplicate = areas.some(
      (a, i) => i !== idx && a.name.toLowerCase() === trimmedName.toLowerCase(),
    );
    if (duplicate) {
      throw new AreaWriterError(`Bereichsname '${trimmedName}' ist bereits vergeben`, 'duplicate-name');
    }

    areas[idx] = { ...areas[idx], name: trimmedName };
    await this._atomicWrite(filePath, _serializeAreasYaml(areas));

    return { id: targetId };
  }

  /**
   * Setzt `order` gemäß der Reihenfolge in `orderedIds` (AC4, V4).
   * `orderedIds` muss GENAU die Menge der vorhandenen Bereichs-IDs sein
   * (keine fehlende/fremde/doppelte ID) — sonst kein Schreiben (Atomarität:
   * entweder alle Positionen werden neu gesetzt, oder gar keine).
   *
   * @param {object} params
   * @param {string} params.projectSlug
   * @param {string[]} params.orderedIds
   * @returns {Promise<{ areas: Array<{ id: string, name: string, order: number, description: string|null }> }>}
   * @throws {AreaWriterError}
   */
  async reorderAreas({ projectSlug, orderedIds }) {
    const normalizedOrderedIds = validateOrderedIds(orderedIds);

    const repoPath = await this._resolveProjectPath(projectSlug);
    const filePath = join(repoPath, 'board', 'areas.yaml');
    const areas = await this._readAreas(filePath);

    const existingIds = new Set(areas.map((a) => a.id));
    const orderedIdSet = new Set(normalizedOrderedIds);

    const sameSize = existingIds.size === orderedIdSet.size && normalizedOrderedIds.length === orderedIdSet.size;
    const sameMembers = sameSize && normalizedOrderedIds.every((id) => existingIds.has(id));
    if (!sameSize || !sameMembers) {
      throw new AreaWriterError(
        'orderedIds muss exakt die Menge der vorhandenen Bereichs-IDs sein (keine fehlende/fremde/doppelte ID)',
        'invalid-order-ids',
      );
    }

    const byId = new Map(areas.map((a) => [a.id, a]));
    const reordered = normalizedOrderedIds.map((id, i) => ({ ...byId.get(id), order: i + 1 }));

    await this._atomicWrite(filePath, _serializeAreasYaml(reordered));

    return { areas: reordered };
  }

  /**
   * Löscht einen Bereich — NUR wenn kein Feature/keine Story (aktiv ODER
   * archiviert) mit eigenem `area === id` und keine Spec mit
   * `area: <id>`-Frontmatter existiert (AC5, V5). Sonst harter Abbruch
   * `area-not-empty` mit `err.details = { storyCount, specCount }`.
   *
   * @param {object} params
   * @param {string} params.projectSlug
   * @param {string} params.id
   * @returns {Promise<{ id: string }>}
   * @throws {AreaWriterError}
   */
  async deleteArea({ projectSlug, id }) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new AreaWriterError('id darf nicht leer sein', 'invalid-id');
    }
    const targetId = id.trim();

    const repoPath = await this._resolveProjectPath(projectSlug);
    const filePath = join(repoPath, 'board', 'areas.yaml');
    const areas = await this._readAreas(filePath);

    const idx = areas.findIndex((a) => a.id === targetId);
    if (idx === -1) {
      throw new AreaWriterError(`Bereich '${targetId}' nicht gefunden`, 'area-not-found');
    }

    const storyCount = await this._countBoundBoardItems(repoPath, targetId);
    const specCount = await this._countBoundSpecs(repoPath, targetId);

    if (storyCount > 0 || specCount > 0) {
      throw new AreaWriterError(
        `Bereich '${targetId}' enthält noch gebundene Storys/Specs — Löschen abgebrochen`,
        'area-not-empty',
        { storyCount, specCount },
      );
    }

    const remaining = areas.filter((_, i) => i !== idx);
    await this._atomicWrite(filePath, _serializeAreasYaml(remaining));

    return { id: targetId };
  }

  // ── Interne Helfer ─────────────────────────────────────────────────────────

  /**
   * Liest + normalisiert die aktuelle Bereichsliste. Fehlende Datei → `[]`
   * (kein Crash, AC1-Verhalten aus dem Read-Pfad gespiegelt). Ungültige
   * Einzel-Einträge werden übersprungen (best effort, siehe Moduldoku).
   *
   * @param {string} filePath
   * @returns {Promise<Array<{ id: string, name: string, order: number, description: string|null }>>}
   * @private
   */
  async _readAreas(filePath) {
    let raw;
    try {
      raw = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch {
      return [];
    }
    const rawList = parseAreasYamlList(raw);
    const out = [];
    for (const entry of rawList) {
      const normalized = _normalizeAreaEntry(entry);
      if (normalized) out.push(normalized);
    }
    return out;
  }

  /**
   * Zählt Feature-/Story-YAML-Dateien mit eigenem `area === areaId`
   * (AC5-Lösch-Guard). Scannt `board/features/` UND `board/stories/` —
   * archivierte Einträge bleiben als Datei liegen (kein separates
   * Archiv-Verzeichnis), ein einfacher Scan deckt daher automatisch
   * "aktiv ODER archiviert" ab. Fehlendes Verzeichnis → 0 (kein Crash).
   *
   * @param {string} repoPath
   * @param {string} areaId
   * @returns {Promise<number>}
   * @private
   */
  async _countBoundBoardItems(repoPath, areaId) {
    const featuresDir = join(repoPath, 'board', 'features');
    const storiesDir = join(repoPath, 'board', 'stories');
    const [featureCount, storyCount] = await Promise.all([
      this._countYamlFilesWithArea(featuresDir, areaId),
      this._countYamlFilesWithArea(storiesDir, areaId),
    ]);
    return featureCount + storyCount;
  }

  /**
   * @param {string} dir
   * @param {string} areaId
   * @returns {Promise<number>}
   * @private
   */
  async _countYamlFilesWithArea(dir, areaId) {
    let entries;
    try {
      entries = await this.#fsDeps.readdir(dir, { withFileTypes: true });
    } catch {
      return 0; // Verzeichnis fehlt → 0 (kein Crash).
    }

    let realDir;
    try {
      realDir = await this.#fsDeps.realpath(dir);
    } catch {
      return 0;
    }
    const prefix = realDir.endsWith(sep) ? realDir : realDir + sep;

    let count = 0;
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
      const parsed = parseYaml(raw);
      if (parsed.area != null && String(parsed.area) === areaId) count++;
    }
    return count;
  }

  /**
   * Zählt `docs/specs/*.md`-Dateien mit `area: <areaId>` im Frontmatter
   * (AC5-Lösch-Guard, [[spec-bereich-filter]]). Fehlendes Verzeichnis → 0.
   *
   * @param {string} repoPath
   * @param {string} areaId
   * @returns {Promise<number>}
   * @private
   */
  async _countBoundSpecs(repoPath, areaId) {
    const specsDir = join(repoPath, 'docs', 'specs');
    let entries;
    try {
      entries = await this.#fsDeps.readdir(specsDir, { withFileTypes: true });
    } catch {
      return 0;
    }

    let realDir;
    try {
      realDir = await this.#fsDeps.realpath(specsDir);
    } catch {
      return 0;
    }
    const prefix = realDir.endsWith(sep) ? realDir : realDir + sep;

    let count = 0;
    for (const entry of entries) {
      if (typeof entry.isFile === 'function' && !entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;

      const candidate = join(specsDir, entry.name);
      let realFile;
      try {
        realFile = await this.#fsDeps.realpath(candidate);
      } catch {
        continue;
      }
      if (!realFile.startsWith(prefix)) continue;

      let raw;
      try {
        raw = await this.#fsDeps.readFile(realFile, 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(raw);
      if (fm.area != null && String(fm.area) === areaId) count++;
    }
    return count;
  }

  /**
   * Löst `projectSlug` sicher zu einem absoluten Repo-Pfad innerhalb eines
   * BOARD_ROOTS-Eintrags auf — identische Logik zu `BoardWriter._resolveProjectPath`.
   *
   * @param {unknown} projectSlug
   * @returns {Promise<string>}
   * @throws {AreaWriterError}
   * @private
   */
  async _resolveProjectPath(projectSlug) {
    if (typeof projectSlug !== 'string' || projectSlug.trim() === '') {
      throw new AreaWriterError('projectSlug darf nicht leer sein', 'invalid-slug');
    }
    const slug = projectSlug.trim();
    if (slug.includes('/') || slug.includes('\\') || slug.includes('\x00') || slug === '.' || slug === '..') {
      throw new AreaWriterError(`Ungültiger projectSlug: '${slug}'`, 'invalid-slug');
    }

    for (const root of this.#boardRoots) {
      let realRoot;
      try {
        realRoot = await this.#fsDeps.realpath(root);
      } catch {
        continue;
      }

      const candidate = join(root, slug);
      let realCandidate;
      try {
        realCandidate = await this.#fsDeps.realpath(candidate);
      } catch {
        continue;
      }

      const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
      const inside = realCandidate === realRoot || realCandidate.startsWith(prefix);
      if (!inside) continue;

      try {
        await this.#fsDeps.readdir(join(realCandidate, 'board', 'stories'));
      } catch {
        continue;
      }

      return realCandidate;
    }

    throw new AreaWriterError(`Projekt '${slug}' nicht unter BOARD_ROOTS gefunden`, 'project-not-found');
  }

  /**
   * Schreibt `content` atomar (tmp + rename, gleiches Verzeichnis, Mode 0600).
   *
   * @param {string} filePath
   * @param {string} content
   * @returns {Promise<void>}
   * @throws {AreaWriterError}
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
      throw new AreaWriterError(`Atomar-Schreiben fehlgeschlagen: ${err.message}`, 'write-failed');
    }

    try {
      await this.#fsDeps.chmod(filePath, 0o600);
    } catch {
      // Non-fatal — Rechte der finalen Datei sind best-effort (rename behält tmp-Rechte ohnehin).
    }
  }
}
