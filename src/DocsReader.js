/**
 * DocsReader — Projekt-Dokumentation (README + docs/) lesen und strukturieren.
 *
 * Liest je Projekt (AC1 — projekt-spezifikation-anzeige):
 *   - README.md                  (Typ: readme)
 *   - docs/*.md                  (Typ: konzept oder architektur, je nach Dateiname)
 *   - docs/specs/*.md            (Typ: spec; Frontmatter id/title/status/version geparst)
 *   - docs/architecture/*.md     (Typ: architektur; nur wenn Ordner existiert)
 *
 * Gibt eine Liste von DocEntry-Objekten zurück (Pfad, Titel, Typ, Status).
 * Kein Crash bei fehlender Doku — leere Liste.
 * Kein Lesen des Dateiinhalts in der Struktur-Liste (lazy — Inhalt nur via getRaw()).
 *
 * Security (AC3 — Pfad-Sicherheit):
 *   Kein User-Input fließt in Pfadkonstruktion beim Scannen (basiert auf readdir).
 *   getRaw() akzeptiert einen relpfad und prüft: kein `..`, kein absoluter Pfad,
 *   realpath-Containment im Projekt-Root.
 *
 * Injectable fsDeps für Tests (analog BoardAggregator/RetroReader).
 *
 * @module DocsReader
 */

import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, sep, isAbsolute } from 'node:path';

/** Default FS dependencies (real node:fs/promises). */
const defaultFsDeps = { readFile, readdir, realpath };

// ── Typ-Konstanten ─────────────────────────────────────────────────────────────

/** @typedef {'readme'|'konzept'|'architektur'|'spec'} DocType */

/**
 * @typedef {object} DocEntry
 * @property {string}       path    Relativer Pfad ab Projekt-Root (z.B. "docs/specs/foo.md")
 * @property {string}       title   Titel (aus Frontmatter oder Dateiname ohne .md)
 * @property {DocType}      type    Typ/Schicht der Datei
 * @property {string|null}  status  Spec-Status aus Frontmatter (nur bei type=spec), sonst null
 * @property {string|null}  id      Spec-ID aus Frontmatter (nur bei type=spec), sonst null
 * @property {number|null}  version Spec-Version aus Frontmatter (nur bei type=spec), sonst null
 */

// ── Frontmatter-Parser ─────────────────────────────────────────────────────────

/**
 * Parst YAML-Frontmatter aus einem Markdown-String.
 * Erkennt den Block zwischen zwei `---`-Zeilen am Anfang der Datei.
 * Gibt ein Objekt mit den geparsten Schlüsseln zurück (nur skalare String/Number-Werte).
 * Bei fehlendem oder fehlerhaftem Frontmatter → leeres Objekt.
 *
 * @param {string} markdown
 * @returns {{ id?: string, title?: string, status?: string, version?: number }}
 */
export function parseFrontmatter(markdown) {
  if (typeof markdown !== 'string') return {};
  const lines = markdown.split('\n');
  if (lines[0].trim() !== '---') return {};

  const fm = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;

    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    if (!key) continue;

    // Entferne Anführungszeichen
    let val = rawVal;
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    // Versuche als Number
    if (/^-?\d+(\.\d+)?$/.test(val)) {
      fm[key] = Number(val);
    } else {
      fm[key] = val;
    }
  }
  return fm;
}

// ── Dateiname → Titel ─────────────────────────────────────────────────────────

/**
 * Leitet einen Anzeigetitel aus dem Dateinamen ab (ohne Pfad, ohne .md).
 * Bindestriche/Unterstriche werden nicht ersetzt (Originalnamen beibehalten).
 *
 * @param {string} filename  Nur Dateiname (z.B. "architecture.md")
 * @returns {string}
 */
function filenameToTitle(filename) {
  return filename.replace(/\.md$/i, '');
}

// ── Dateiname → Typ ───────────────────────────────────────────────────────────

/**
 * Leitet den Typ einer Datei aus ihrem Pfad ab.
 *
 * - docs/specs/*.md → 'spec'
 * - docs/architecture/*.md → 'architektur'
 * - docs/concept*.md / docs/data-model*.md / docs/design*.md → 'konzept'
 * - docs/*.md (sonstige) → 'architektur' (Schicht-2-Dokumente)
 * - README.md → 'readme'
 *
 * @param {string} relPath  Relativer Pfad ab Projekt-Root
 * @returns {DocType}
 */
function inferType(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  if (norm === 'README.md' || norm.toLowerCase() === 'readme.md') return 'readme';
  if (norm.startsWith('docs/specs/')) return 'spec';
  if (norm.startsWith('docs/architecture/')) return 'architektur';
  // docs/*.md — Unterscheidung: konzept vs architektur nach Dateiname
  const basename = norm.split('/').pop() || '';
  const lc = basename.toLowerCase();
  if (lc === 'concept.md' || lc.startsWith('concept') ||
      lc === 'data-model.md' || lc.startsWith('data-model') ||
      lc === 'design.md' || lc.startsWith('design')) {
    return 'konzept';
  }
  return 'architektur';
}

// ── DocsReader ────────────────────────────────────────────────────────────────

/**
 * DocsReader — liest Projekt-Doku-Struktur + Rohdaten.
 *
 * @param {object} [fsDeps]  Injectable FS-Dependencies für Tests.
 * @param {Function} [fsDeps.readFile]
 * @param {Function} [fsDeps.readdir]
 * @param {Function} [fsDeps.realpath]
 */
export class DocsReader {
  /** @type {typeof defaultFsDeps} */
  #fsDeps;

  constructor(fsDeps = defaultFsDeps) {
    this.#fsDeps = { ...defaultFsDeps, ...fsDeps };
  }

  // ── getDocs ──────────────────────────────────────────────────────────────────

  /**
   * Liest die Doku-Struktur eines Projekts (AC1).
   * Gibt eine Liste von DocEntry-Objekten zurück — ohne Dateiinhalte.
   * Fehlende Doku → leere Liste, kein Crash.
   *
   * @param {string} repoPath  Absoluter Pfad zum Projekt-Root.
   * @returns {Promise<DocEntry[]>}
   */
  async getDocs(repoPath) {
    if (!repoPath || typeof repoPath !== 'string') return [];

    /** @type {DocEntry[]} */
    const entries = [];

    // ── README.md ──────────────────────────────────────────────────────────────
    const readmePath = join(repoPath, 'README.md');
    try {
      await this.#fsDeps.readFile(readmePath, 'utf8');
      entries.push({
        path: 'README.md',
        title: 'README',
        type: 'readme',
        status: null,
        area: null,
        id: null,
        version: null,
      });
    } catch {
      // README fehlt → überspringen
    }

    // ── docs/*.md ──────────────────────────────────────────────────────────────
    const docsDir = join(repoPath, 'docs');
    try {
      const docsEntries = await this.#fsDeps.readdir(docsDir, { withFileTypes: true });
      for (const e of docsEntries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        const relPath = `docs/${e.name}`;
        entries.push({
          path: relPath,
          title: filenameToTitle(e.name),
          type: inferType(relPath),
          status: null,
          area: null,
          id: null,
          version: null,
        });
      }
    } catch {
      // docs/ fehlt → überspringen
    }

    // ── docs/specs/*.md ────────────────────────────────────────────────────────
    const specsDir = join(repoPath, 'docs', 'specs');
    try {
      const specsEntries = await this.#fsDeps.readdir(specsDir, { withFileTypes: true });
      for (const e of specsEntries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        const relPath = `docs/specs/${e.name}`;
        // Frontmatter parsen (lazy: Datei lesen aber Inhalt nicht im Entry speichern)
        let fm = {};
        try {
          const raw = await this.#fsDeps.readFile(join(repoPath, relPath), 'utf8');
          fm = parseFrontmatter(raw);
        } catch {
          // Frontmatter-Fehler → leere Felder
        }
        entries.push({
          path: relPath,
          title: (typeof fm.title === 'string' && fm.title) ? fm.title : filenameToTitle(e.name),
          type: 'spec',
          status: (typeof fm.status === 'string' && fm.status) ? fm.status : null,
          // spec-bereichs-filter AC1 (S-295): area-Frontmatter durchreichen; fehlt es -> null.
          area: (typeof fm.area === 'string' && fm.area) ? fm.area : null,
          id: (typeof fm.id === 'string' && fm.id) ? fm.id : null,
          version: (typeof fm.version === 'number') ? fm.version : null,
        });
      }
    } catch {
      // docs/specs/ fehlt → überspringen
    }

    // ── docs/architecture/*.md (falls Ordner existiert) ───────────────────────
    const archDir = join(repoPath, 'docs', 'architecture');
    try {
      const archEntries = await this.#fsDeps.readdir(archDir, { withFileTypes: true });
      for (const e of archEntries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        const relPath = `docs/architecture/${e.name}`;
        entries.push({
          path: relPath,
          title: filenameToTitle(e.name),
          type: 'architektur',
          status: null,
          area: null,
          id: null,
          version: null,
        });
      }
    } catch {
      // docs/architecture/ fehlt → überspringen (kein Pflicht-Ordner)
    }

    return entries;
  }

  // ── getRaw ───────────────────────────────────────────────────────────────────

  /**
   * Liest den Roh-Markdown-Inhalt einer Datei (AC2 + AC3).
   *
   * Pfad-Sicherheit (AC3):
   *   - Absoluter Pfad → abgewiesen
   *   - `..`-Segment → abgewiesen (syntaktisch)
   *   - realpath-Containment: der aufgelöste Pfad muss innerhalb repoPath liegen
   *
   * @param {string} repoPath  Absoluter Pfad zum Projekt-Root.
   * @param {string} relPath   Relativer Pfad (aus dem Client, untrusted).
   * @returns {Promise<{ content: string } | { error: string, code: 'traversal'|'not-found' }>}
   */
  async getRaw(repoPath, relPath) {
    // (1) relPath muss ein nicht-leerer String sein
    if (!relPath || typeof relPath !== 'string' || relPath.trim() === '') {
      return { error: 'path parameter required', code: 'traversal' };
    }

    const trimmed = relPath.trim();

    // (2) Kein absoluter Pfad
    if (isAbsolute(trimmed)) {
      return { error: 'absolute path not allowed', code: 'traversal' };
    }

    // (3) Kein `..`-Segment (syntaktisch — frühe Ablehnung vor realpath)
    const segments = trimmed.replace(/\\/g, '/').split('/');
    if (segments.some((seg) => seg === '..')) {
      return { error: 'path traversal not allowed', code: 'traversal' };
    }

    // (4) Kombiniere mit repoPath
    const candidatePath = join(repoPath, trimmed);

    // (5) realpath-Containment: löst Symlinks auf und prüft, ob der reale Pfad
    //     innerhalb repoPath liegt (Trailing-Slash-Prefix-Check).
    let resolvedCandidate;
    try {
      resolvedCandidate = await this.#fsDeps.realpath(candidatePath);
    } catch {
      // Datei existiert nicht → not-found
      return { error: 'file not found', code: 'not-found' };
    }

    // Auch repoPath auflösen (Symlinks im Root)
    let resolvedRoot;
    try {
      resolvedRoot = await this.#fsDeps.realpath(repoPath);
    } catch {
      return { error: 'project root not accessible', code: 'traversal' };
    }

    const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    const isContained =
      resolvedCandidate === resolvedRoot ||
      resolvedCandidate.startsWith(rootPrefix);

    if (!isContained) {
      return { error: 'path traversal not allowed', code: 'traversal' };
    }

    // (6) Datei lesen
    try {
      const content = await this.#fsDeps.readFile(resolvedCandidate, 'utf8');
      return { content };
    } catch {
      return { error: 'file not found', code: 'not-found' };
    }
  }
}
