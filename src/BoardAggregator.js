/**
 * BoardAggregator — read-only Multi-Repo-Scan + In-Memory-Index
 *                   (AC1: Scan, AC2: flüchtiger Index/Watcher, AC3: Aggregat-Modell,
 *                    AC7: Read-only-Garantie, AC8: Fehlertoleranz, AC9: Aktualität)
 *
 * Scannt die konfigurierten Repo-Wurzeln (BOARD_ROOTS env-Variable) read-only nach
 * board/-Ordnern und liest je Repo:
 *   - board/board.yaml               (Projekt-Meta)
 *   - board/features/F-*.yaml        (Feature-YAMLs)
 *   - board/stories/S-*.yaml         (Story-YAMLs)
 *
 * Der resultierende Index modelliert die Hierarchie:
 *   Projekt (= Repo-Slug) → Feature → Story
 *
 * Design:
 *   - Read-only: KEIN Schreiben in board/-Dateien, kein persistenter Cache (AC7).
 *   - Ein ungültiges/fehlendes Board wird mit Fehlermarkierung übersprungen (AC8).
 *   - Re-Scan on-demand via scan() oder durch einen optionalen fs.watch()-Watcher (AC9).
 *   - Symlinks beim Scan werden ignoriert (kein Endlos-Scan).
 *   - Injectable fsDeps für Tests (kein echtes Filesystem nötig).
 *
 * Konfiguration:
 *   BOARD_ROOTS — Komma-getrennte Liste von Wurzel-Verzeichnissen, unter denen
 *                 board/-Ordner gesucht werden. Tilde (~) wird zu $HOME expandiert.
 *                 Beispiel: "~/Git/Studis-Softwareschmiede"
 *                 (entspricht spec board-aggregator Config: board_roots)
 *
 * Security:
 *   - Liest ausschliesslich aus den konfigurierten Board-Roots.
 *   - Kein User-Input wird als Pfad verwendet — Scan basiert auf Filesystem-Listing.
 *   - Kein Secret in Output; keine Schreibzugriffe.
 *
 * @module BoardAggregator
 */

import { readdir, readFile, watch } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

// ── Ready-Status Berechnung (AC4 — autonome-board-abarbeitung) ────────────────

/**
 * Parse the frontmatter `status:` field from a Markdown file.
 * Returns the trimmed value string, or null when not found.
 * Never throws (error tolerance).
 *
 * @param {string} content  Raw Markdown/YAML string.
 * @returns {string|null}
 */
function _parseFrontmatterStatus(content) {
  if (!content || typeof content !== 'string') return null;
  // Frontmatter is between the first two "---" lines.
  const lines = content.split('\n');
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (i === 0 && trimmed === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && trimmed === '---') {
      break; // end of frontmatter
    }
    if (inFrontmatter) {
      const m = trimmed.match(/^status\s*:\s*(.+)$/);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/**
 * Compute ready status for a single story.
 *
 * Rules (authoritative — must be consistent with agent-flow board ready-check):
 *   A story is `ready` iff ALL:
 *     (1) status === "To Do"
 *     (2) `spec` set + spec file exists in repo + frontmatter `status: active`
 *     (3) `implements` non-empty + every AC-nr from implements appears in the spec file
 *     (4) `depends` empty OR every referenced story exists AND has status "Done"
 *     (5) no `blocked_reason`
 *
 * Non-To-Do stories: ready=false, ready_reason=null (not relevant).
 * Missing files/fields → ready=false with a reason string, no crash.
 *
 * @param {object} story  Story data object (after parsing).
 * @param {object} fsDeps  Injectable { readFile }.
 * @param {string} repoPath  Absolute path to the repo root (for spec file resolution).
 * @param {Map<string, {status: string}>} allStoriesMap  id → { status } for depends-check.
 * @returns {Promise<{ ready: boolean, ready_reason: string|null }>}
 */
export async function computeStoryReadyStatus(story, fsDeps, repoPath, allStoriesMap) {
  // Non-To-Do stories: not relevant (no check needed)
  if (story.status !== 'To Do') {
    return { ready: false, ready_reason: null };
  }

  // Rule (5): blocked_reason
  if (story.blocked_reason) {
    return { ready: false, ready_reason: `blocked: ${story.blocked_reason}` };
  }

  // Rule (2a): spec field must be set
  if (!story.spec) {
    return { ready: false, ready_reason: 'spec nicht gesetzt' };
  }

  // Rule (2b): spec file must exist + frontmatter status: active
  const specPath = join(repoPath, story.spec);
  let specContent;
  try {
    specContent = await fsDeps.readFile(specPath, 'utf8');
  } catch {
    return { ready: false, ready_reason: `spec-Datei nicht gefunden: ${story.spec}` };
  }
  const specFmStatus = _parseFrontmatterStatus(specContent);
  if (!specFmStatus || specFmStatus.toLowerCase() !== 'active') {
    return { ready: false, ready_reason: `spec-Status nicht active (ist: ${specFmStatus ?? 'nicht gesetzt'})` };
  }

  // Rule (3): implements non-empty + every AC-nr present in spec file
  const implements_ = Array.isArray(story.implements) ? story.implements : [];
  if (implements_.length === 0) {
    return { ready: false, ready_reason: 'implements leer' };
  }
  for (const ac of implements_) {
    const acStr = String(ac);
    // Check raw presence of "AC<n>" in the spec file content
    if (!specContent.includes(acStr)) {
      return { ready: false, ready_reason: `AC-Nummer nicht in Spec gefunden: ${acStr}` };
    }
  }

  // Rule (4): depends empty OR all referenced stories exist + status Done
  const depends = Array.isArray(story.depends) ? story.depends.filter(Boolean) : [];
  for (const depId of depends) {
    const dep = allStoriesMap.get(String(depId));
    if (!dep) {
      return { ready: false, ready_reason: `abhängige Story existiert nicht: ${depId}` };
    }
    if (dep.status !== 'Done') {
      return { ready: false, ready_reason: `abhängige Story nicht Done: ${depId} (${dep.status})` };
    }
  }

  return { ready: true, ready_reason: null };
}

/** Default FS dependencies (real node:fs/promises). */
const defaultFsDeps = { readdir, readFile, watch };

// ── Simple YAML parser für Board-Dateien ─────────────────────────────────────
// Die board/-YAMLs sind einfach strukturiert (Schlüssel-Wert, Inline-Arrays,
// Block-Listen, skalare Typen). Eine vollständige YAML-Library ist nicht verfügbar;
// dieser Parser deckt genau das im Schema verwendete Subset ab.

/**
 * Parse a subset of YAML sufficient for board/*.yaml files.
 *
 * Supported:
 *   - Scalar values (string, number, boolean, null)
 *   - Inline arrays: [a, b, c]
 *   - Block sequences: lines starting with "- "
 *   - Multi-line block scalars (folded > / literal |) — collapsed to one string
 *   - Comments (#) on their own line
 *   - null/~ for null values
 *
 * Returns {} on parse error (never throws — AC8 Fehlertoleranz).
 *
 * @param {string} content  Raw YAML string.
 * @returns {Record<string, unknown>}
 */
export function parseYaml(content) {
  if (!content || typeof content !== 'string') return {};

  try {
    return _parseYamlDoc(content.trim());
  } catch {
    return {};
  }
}

/**
 * Internal YAML document parser.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function _parseYamlDoc(text) {
  const lines = text.split('\n');
  const result = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Skip empty lines and comments
    if (!trimmed || trimmed.trimStart().startsWith('#')) {
      i++;
      continue;
    }

    // YAML document separator
    if (trimmed === '---') {
      i++;
      continue;
    }

    // Key: value line
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const afterColon = trimmed.slice(colonIdx + 1);
    const valueStr = afterColon.trimStart();

    // Guard: a valid YAML key never contains spaces.
    // Continuation lines of multi-line flow scalars (e.g. quoted strings that wrap
    // across several lines) may contain " word: word" patterns — those must NOT be
    // treated as keys, otherwise they produce phantom key entries (S1 fix).
    if (!key || key.includes(' ')) {
      i++;
      continue;
    }

    // Block scalar indicator: | or >
    if (valueStr === '|' || valueStr === '>' || valueStr.startsWith('| ') || valueStr.startsWith('> ')) {
      // Collect following indented lines
      i++;
      const scalarLines = [];
      while (i < lines.length) {
        const sl = lines[i];
        // A block scalar ends when a line at root indent (no leading space) appears
        if (sl.length > 0 && sl[0] !== ' ' && sl[0] !== '\t') break;
        scalarLines.push(sl.trimEnd());
        i++;
      }
      // Strip leading indent (determined by first non-empty line)
      let indent = Infinity;
      for (const sl of scalarLines) {
        if (!sl.trim()) continue;
        const leadingSpaces = sl.length - sl.trimStart().length;
        if (leadingSpaces < indent) indent = leadingSpaces;
      }
      if (indent === Infinity) indent = 0;
      const cleaned = scalarLines.map((sl) => sl.slice(Math.min(indent, sl.length)));
      result[key] = cleaned.join('\n').trim();
      continue;
    }

    // Block sequence: value is empty, next lines start with "- "
    if (valueStr === '' && i + 1 < lines.length) {
      const nextLine = lines[i + 1] ?? '';
      const nextTrimmed = nextLine.trimStart();
      if (nextTrimmed.startsWith('- ') || nextTrimmed === '-') {
        // Collect list items
        i++;
        const items = [];
        while (i < lines.length) {
          const itemLine = lines[i];
          if (!itemLine.trim()) { i++; continue; }
          const itemTrimmed = itemLine.trimStart();
          if (!itemTrimmed.startsWith('- ') && itemTrimmed !== '-') break;
          const itemVal = itemTrimmed.startsWith('- ') ? itemTrimmed.slice(2).trim() : '';
          items.push(_parseScalar(itemVal));
          i++;
        }
        result[key] = items;
        continue;
      }
    }

    // Inline array: [a, b, c]
    if (valueStr.startsWith('[')) {
      result[key] = _parseInlineArray(valueStr);
      i++;
      continue;
    }

    // Scalar value
    // Strip inline comment (# after a space, not inside quotes)
    const stripped = _stripInlineComment(valueStr);
    result[key] = _parseScalar(stripped);
    i++;
  }

  return result;
}

/**
 * Parse an inline YAML array: [a, b, c]
 * @param {string} s
 * @returns {Array}
 */
function _parseInlineArray(s) {
  const inner = s.replace(/^\[/, '').replace(/\].*$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map((item) => _parseScalar(item.trim()));
}

/**
 * Strip trailing inline comment from a scalar value string.
 * Only strips " #..." that occurs after a space (not inside quoted strings).
 * @param {string} s
 * @returns {string}
 */
function _stripInlineComment(s) {
  // Find " #" pattern that is NOT inside single or double quotes
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && c === '#' && i > 0 && s[i - 1] === ' ') {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

/**
 * Parse a scalar YAML value to its JS equivalent.
 * @param {string} s  Raw string value (possibly quoted).
 * @returns {string|number|boolean|null}
 */
function _parseScalar(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();

  // null / ~
  if (t === 'null' || t === '~' || t === '') return null;

  // boolean
  if (t === 'true') return true;
  if (t === 'false') return false;

  // Quoted string — single or double
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }

  // Number (integer or float)
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return Number(t);
  }

  return t;
}

// ── Rollup-Berechnung (read-only, Anzeige) ────────────────────────────────────

/** Story-Status-Werte die als "done" gelten */
const DONE_STATUSES = new Set(['Done']);

/**
 * Compute a display rollup string from story status counts.
 * Format: "N/T done · X in progress"
 *
 * @param {Array<{ status: string }>} stories
 * @returns {string}
 */
function computeRollup(stories) {
  if (!stories || stories.length === 0) return '0/0 done';
  const total = stories.length;
  const done = stories.filter((s) => DONE_STATUSES.has(s.status)).length;
  const inProgress = stories.filter((s) => s.status === 'In Progress').length;
  let s = `${done}/${total} done`;
  if (inProgress > 0) s += ` · ${inProgress} in progress`;
  return s;
}

// ── Tilde-Expansion ───────────────────────────────────────────────────────────

/**
 * Expand a leading ~ to the user's home directory.
 * @param {string} p
 * @returns {string}
 */
function expandTilde(p) {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~' + sep)) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/**
 * Parse the BOARD_ROOTS environment variable (or override) into an array of
 * absolute directory paths.
 *
 * Format: comma-separated list of paths (tilde expansion applied).
 *
 * @param {string|undefined} envValue
 * @returns {string[]}
 */
export function parseBoardRoots(envValue) {
  if (!envValue || !envValue.trim()) return [];
  return envValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => resolve(expandTilde(p)));
}

// ── BoardAggregator ───────────────────────────────────────────────────────────

/**
 * BoardAggregator scans configured repo roots for board/ directories and builds
 * a volatile in-memory index: Projekt → Feature → Story.
 *
 * @param {object} [options]
 * @param {string} [options.boardRootsEnv]
 *   Override for the BOARD_ROOTS env variable value (for tests).
 * @param {object} [options.fsDeps]
 *   Injectable filesystem helpers: { readdir, readFile, watch }.
 *   Defaults to real node:fs/promises.
 */
export class BoardAggregator {
  /** @type {string[]} */
  #boardRoots;
  /** @type {object} */
  #fsDeps;
  /**
   * In-memory index: array of project entries (with error markers for invalid boards).
   * @type {Array<ProjectEntry|ErrorEntry>|null}
   */
  #index = null;
  /** Active watchers (AbortController per watched path). */
  #watchers = [];

  constructor({ boardRootsEnv, fsDeps } = {}) {
    const envVal = boardRootsEnv ?? process.env.BOARD_ROOTS ?? '';
    this.#boardRoots = parseBoardRoots(envVal);
    this.#fsDeps = fsDeps ?? defaultFsDeps;
  }

  /**
   * Trigger a full re-scan and replace the in-memory index.
   * Safe to call multiple times; each call replaces the index atomically.
   * Never throws (AC8 — errors per-board, not global).
   *
   * @returns {Promise<void>}
   */
  async scan() {
    const projects = [];

    for (const root of this.#boardRoots) {
      let repoEntries;
      try {
        repoEntries = await this.#fsDeps.readdir(root, { withFileTypes: true });
      } catch {
        // Root not readable — skip silently (not an error in the board sense)
        continue;
      }

      for (const entry of repoEntries) {
        // Skip non-directories and symlinks (AC edge-case: symlinks ignored)
        if (!entry.isDirectory()) continue;
        if (entry.isSymbolicLink()) continue;

        const repoPath = join(root, entry.name);
        const boardDir = join(repoPath, 'board');

        // Check whether a board/ directory exists (just try to readdir it)
        try {
          await this.#fsDeps.readdir(boardDir, { withFileTypes: true });
        } catch {
          // No board/ directory — skip (not an error, AC spec: "kein Board-Projekt, übersprungen")
          continue;
        }

        // Try to read the board — any failure → ErrorEntry (AC8)
        const projectResult = await this._readBoard(entry.name, repoPath, boardDir);
        projects.push(projectResult);
      }
    }

    // Atomically replace the index
    this.#index = projects;
  }

  /**
   * Read a single board directory and return a ProjectEntry or ErrorEntry.
   *
   * @param {string} slug      Repo directory name (used as project slug).
   * @param {string} repoPath  Absolute path to the repo root.
   * @param {string} boardDir  Absolute path to the board/ directory.
   * @returns {Promise<ProjectEntry|ErrorEntry>}
   */
  async _readBoard(slug, repoPath, boardDir) {
    // ── board.yaml ────────────────────────────────────────────────────────────
    const boardYamlPath = join(boardDir, 'board.yaml');
    let boardMeta;
    try {
      const raw = await this.#fsDeps.readFile(boardYamlPath, 'utf8');
      boardMeta = parseYaml(raw);
      if (!boardMeta || typeof boardMeta !== 'object') {
        throw new Error('board.yaml parsed to non-object');
      }
    } catch (err) {
      return {
        slug,
        repo_path: repoPath,
        error: `board.yaml fehlt oder ungültig: ${err.message}`,
        features: [],
      };
    }

    // ── features/*.yaml ───────────────────────────────────────────────────────
    const featuresDir = join(boardDir, 'features');
    let featureFiles = [];
    try {
      const fentries = await this.#fsDeps.readdir(featuresDir, { withFileTypes: true });
      featureFiles = fentries
        .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
        .map((e) => join(featuresDir, e.name));
    } catch {
      // features/ missing → empty (still a valid board if board.yaml is ok)
    }

    const featuresMap = new Map(); // id → FeatureEntry
    for (const fp of featureFiles) {
      try {
        const raw = await this.#fsDeps.readFile(fp, 'utf8');
        const data = parseYaml(raw);
        if (!data || typeof data !== 'object' || !data.id) continue;
        featuresMap.set(String(data.id), {
          id: String(data.id),
          title: data.title ?? null,
          status: data.status ?? null,
          priority: data.priority ?? null,
          progress: data.progress ?? null, // may be stale/missing → recalc later
          goal: data.goal ?? null,
          definition_of_done: data.definition_of_done ?? null,
          depends: Array.isArray(data.depends) ? data.depends.map(String) : null,
          labels: Array.isArray(data.labels) ? data.labels.map(String) : null,
          stories: [],
        });
      } catch {
        // Skip malformed feature files — no crash (AC8)
      }
    }

    // ── stories/*.yaml ────────────────────────────────────────────────────────
    const storiesDir = join(boardDir, 'stories');
    let storyFiles = [];
    try {
      const sentries = await this.#fsDeps.readdir(storiesDir, { withFileTypes: true });
      storyFiles = sentries
        .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
        .map((e) => join(storiesDir, e.name));
    } catch {
      // stories/ missing → empty
    }

    /** @type {StoryEntry[]} */
    const orphanedStories = [];
    /** @type {StoryEntry[]} all parsed stories, for depends-check later */
    const allStoriesList = [];

    for (const sp of storyFiles) {
      try {
        const raw = await this.#fsDeps.readFile(sp, 'utf8');
        const data = parseYaml(raw);
        if (!data || typeof data !== 'object' || !data.id) continue;

        const story = {
          id: String(data.id),
          parent: data.parent != null ? String(data.parent) : null,
          title: data.title ?? null,
          status: data.status ?? null,
          priority: data.priority ?? null,
          labels: Array.isArray(data.labels) ? data.labels.map(String) : [],
          spec: data.spec ?? null,
          implements: Array.isArray(data.implements) ? data.implements.map(String) : [],
          depends: Array.isArray(data.depends) ? data.depends.map(String).filter(Boolean) : [],
          blocked_reason: data.blocked_reason != null ? String(data.blocked_reason) : null,
          dispo_est: data.dispo_est ?? null,
          dispo_act: data.dispo_act ?? null,
          // ready/ready_reason computed below after all stories are parsed
          ready: false,
          ready_reason: null,
        };

        allStoriesList.push(story);

        const parentId = story.parent;
        if (parentId && featuresMap.has(parentId)) {
          featuresMap.get(parentId).stories.push(story);
        } else {
          // Parent doesn't exist → orphaned (AC spec edge-case)
          orphanedStories.push(story);
        }
      } catch {
        // Skip malformed story files — no crash (AC8)
      }
    }

    // ── Ready-Status berechnen (AC4 — autonome-board-abarbeitung) ────────────
    // Build id→{status} map for depends-checks (all stories across all features + orphaned)
    const allStoriesMap = new Map(allStoriesList.map((s) => [s.id, s]));
    for (const story of allStoriesList) {
      try {
        const result = await computeStoryReadyStatus(story, this.#fsDeps, repoPath, allStoriesMap);
        story.ready = result.ready;
        story.ready_reason = result.ready_reason;
      } catch {
        // Error tolerance: keep ready=false (already default)
      }
    }

    // ── Rollup: recompute progress read-only (AC5 / V5) ─────────────────────
    for (const feature of featuresMap.values()) {
      if (!feature.progress || feature.progress === null) {
        // Missing or stale → recalculate from child stories (read-only, no file write)
        feature.progress = computeRollup(feature.stories);
      }
    }

    // ── Orphaned stories: add as a pseudo-feature if any ─────────────────────
    const features = [...featuresMap.values()];
    if (orphanedStories.length > 0) {
      features.push({
        id: '_orphaned',
        title: 'Verwaiste Stories',
        status: null,
        priority: null,
        progress: null,
        goal: null,
        definition_of_done: null,
        depends: null,
        labels: null,
        stories: orphanedStories,
        _orphaned: true,
      });
    }

    return {
      slug,
      repo_path: repoPath,
      project_slug: boardMeta.project_slug ?? slug,
      schema_version: boardMeta.schema_version ?? null,
      features,
    };
  }

  /**
   * Return the current in-memory index. If not yet scanned, triggers a scan first.
   *
   * @returns {Promise<Array<ProjectEntry|ErrorEntry>>}
   */
  async getIndex() {
    if (this.#index === null) {
      await this.scan();
    }
    return this.#index;
  }

  /**
   * Start filesystem watchers for each board root directory.
   * On any change inside a watched board root, the index is invalidated and
   * will be re-scanned on the next getIndex() call (AC9 — lazy re-scan).
   *
   * Note: fs.watch() is used with a debounce to avoid thrashing on rapid file saves.
   * The injected fsDeps.watch must match the node:fs/promises.watch signature.
   *
   * Safe to call multiple times — stops previous watchers first.
   *
   * @returns {void}
   */
  startWatchers() {
    this.stopWatchers();

    for (const root of this.#boardRoots) {
      const ac = new AbortController();
      this.#watchers.push(ac);

      // Start watcher in background — errors are caught and ignored (AC8)
      this._watchRoot(root, ac.signal).catch(() => {});
    }
  }

  /**
   * Watch a single root directory for changes.
   * On change: invalidate the index (next getIndex() will re-scan).
   *
   * @param {string} root
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async _watchRoot(root, signal) {
    let watcher;
    try {
      watcher = this.#fsDeps.watch(root, { recursive: true, signal });
    } catch {
      return;
    }

    let debounceTimer = null;
    try {
      for await (const fsEvent of watcher) {
        void fsEvent; // consume event — only the change signal matters
        // Invalidate index — will be re-scanned on next getIndex()
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.#index = null;
          debounceTimer = null;
        }, 200);
      }
    } catch (err) {
      // AbortError is expected on stopWatchers() — any other error: silently stop
      if (err && err.name !== 'AbortError') {
        // ignore
      }
    } finally {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    }
  }

  /**
   * Stop all active filesystem watchers.
   * @returns {void}
   */
  stopWatchers() {
    for (const ac of this.#watchers) {
      try { ac.abort(); } catch { /* ignore */ }
    }
    this.#watchers = [];
  }
}

/**
 * @typedef {{
 *   slug: string,
 *   repo_path: string,
 *   project_slug: string,
 *   schema_version: number|null,
 *   features: FeatureEntry[]
 * }} ProjectEntry
 *
 * @typedef {{
 *   slug: string,
 *   repo_path: string,
 *   error: string,
 *   features: []
 * }} ErrorEntry
 *
 * @typedef {{
 *   id: string,
 *   title: string|null,
 *   status: string|null,
 *   priority: string|null,
 *   progress: string|null,
 *   goal: string|null,
 *   definition_of_done: string|null,
 *   depends: string[]|null,
 *   labels: string[]|null,
 *   stories: StoryEntry[]
 * }} FeatureEntry
 *
 * @typedef {{
 *   id: string,
 *   parent: string|null,
 *   title: string|null,
 *   status: string|null,
 *   priority: string|null,
 *   labels: string[],
 *   spec: string|null,
 *   implements: string[],
 *   depends: string[],
 *   blocked_reason: string|null,
 *   dispo_est: *,
 *   dispo_act: *,
 *   ready: boolean,
 *   ready_reason: string|null
 * }} StoryEntry
 */
