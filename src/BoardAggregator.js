/**
 * BoardAggregator — read-only Multi-Repo-Scan + In-Memory-Index
 *                   (AC1: Scan, AC2: flüchtiger Index/Watcher, AC3: Aggregat-Modell,
 *                    AC7: Read-only-Garantie, AC8: Fehlertoleranz, AC9: Aktualität)
 *
 * story-detail-yaml-fallback:
 *   AC1 — Story-Index enthält done_at, branch, pr (null wenn YAML-Feld fehlt).
 *
 * taktgeber-nachtwaechter:
 *   AC1 — Story-Index enthält zusätzlich updated_at (null wenn YAML-Feld fehlt) — Quelle für
 *   ProjectDrain's "verwaiste In-Progress"-Stale-Erkennung (src/ProjectDrain.js).
 *
 * drain-origin-progress-sync:
 *   AC2/AC7 — `readProjectAt(slug, repoPath, { fsDeps })` liest EIN Projekt read-only,
 *   unabhängig vom In-Memory-`#index`, wahlweise aus einer alternativen Datei-Quelle
 *   (Default Working-Tree via `this.#fsDeps`, injizierbar: Git-Ref-Quelle via
 *   `createGitRefFsDeps`, `src/GitReadBoundary.js`). `_readBoard()`/`computeStoryReadyStatus()`
 *   bleiben unverändert — nur `readdir`/`readFile` werden ausgetauscht. `ProjectDrain`
 *   nutzt dies, um bei `merge_policy: pr`-Projekten mit verifiziert-vorauslaufendem
 *   `origin` den Board-Snapshot aus dem `origin`-Ref statt dem stalen Working-Tree
 *   abzuleiten (Truth-Ref-Auswahl, siehe dort).
 *
 * fswatcher-crash-hardening:
 *   AC1 — startWatchers()/_watchRoot() fängt JEDEN Watcher-Fehler ab (Bewaffnung UND
 *   Iteration) — kein Watcher-Fehler eskaliert zu einer uncaughtException.
 *   AC2 — ENOENT/scandir während des Beobachtens beendet den Watcher-Loop kontrolliert;
 *   der Prozess bleibt am Leben.
 *   AC3 — Verschwindende Wurzel → sauberes Schließen (Debounce-Timer gecleart, kein
 *   hängender Async-Iterator).
 *   AC4 — Re-Arm mit exponentiellem, begrenztem Backoff (REARM_INITIAL_DELAY_MS,
 *   REARM_BACKOFF_FACTOR, REARM_MAX_DELAY_MS); bei erfolgreicher Neu-Bewaffnung Backoff-
 *   Reset + Index EINMAL invalidiert (_armRoot()/_scheduleRearm()/_attemptRearm()).
 *   AC5 — stopWatchers() bricht anstehende Re-Arm-/Backoff-Timer ab; danach kein
 *   weiterer watch()-Aufruf mehr.
 *
 * fswatcher-crash-hardening V2 (S-320 — interne FSWatcher-'error'-Events + Scope-
 * Verengung, Vorfall 2026-07-07):
 *   AC8 — `watchWithErrorGuard()` (statt direkt `fs/promises.watch`) registriert
 *   einen expliziten `'error'`-Listener auf der von `node:fs.watch()` erzeugten
 *   `FSWatcher`-Instanz — ein `'error'`-Event einer INTERNEN (durch
 *   `recursive:true` unter Linux) angelegten Sub-Watcher-Instanz eskaliert dadurch
 *   nie mehr zur uncaughtException, sondern wird sauber in den Async-Iterator
 *   geroutet (bestehende AC1–AC5-Re-Arm-Disziplin greift unverändert).
 *   AC9 — `isWatchIgnoredEntry()`/`isWatchIgnoredPath()`: node_modules/.git/
 *   .claude (inkl. .claude/worktrees)/test/.tmp-* werden NIE beobachtet.
 *   Mechanik: `startWatchers()` bewaffnet je `BOARD_ROOTS`-Wurzel einen flachen
 *   Meta-Watch (`kind:'meta'`, erkennt neue/verschwindende Top-Level-Repo-
 *   Verzeichnisse) + `_syncRepoWatchers()` bewaffnet je NICHT-ignoriertem Repo
 *   gezielte rekursive Watches nur auf `<repo>/board` und `<repo>/docs/specs`
 *   (`kind:'subtree'`) — statt EINEM rekursiven Watch auf die gesamte Wurzel.
 *   AC10 — Index-Aktualität bleibt erhalten: Subtree-Watches invalidieren den
 *   Index wie bisher (debounced); der Meta-Watch selbst tut das nicht (nur
 *   Repo-/Unterbaum-Erkennung), invalidiert aber EINMAL beim Bewaffnen eines
 *   NEUEN Subtree-Watches (verpasst sonst ggf. das allererste Event eines
 *   frisch entstandenen `board`-Ordners, siehe `_syncRepoWatchers()`-Kommentar).
 *   AC11 — Regressionstest des Vorfalls 2026-07-07 (siehe test/boardAggregator.
 *   test.js + test/fixtures/fswatcher-regression-child.mjs).
 *
 * bereichs-modell (S-288, Lese-Teil):
 *   AC1 — Liest je Projekt zusätzlich `board/areas.yaml` (Liste von
 *   { id, name, order, description? }), sortiert nach `order`, als `areas` am
 *   Projekt-Index. Fehlende/leere Datei → leere Liste (kein Crash). Defekte
 *   Einzel-Einträge (fehlendes id/name, order kein Integer) werden übersprungen
 *   (best effort, geloggt via console.warn — secret-frei), ohne den restlichen
 *   Index zu zerstören. `BoardAggregator` bleibt read-only (kein Schreibpfad).
 *   AC2 — Jeder Bereich trägt zusätzlich `storyCount` (Roll-up/Anzahl aller
 *   Stories, deren `area` — oder, falls die Story selbst kein `area` trägt, das
 *   `area` des Eltern-Features — auf den Bereich zeigt). Ein Bereich ohne
 *   zugeordnete Storys bleibt sichtbar (`storyCount: 0`).
 *
 * run-state-live-view (S-316):
 *   AC1 — Liest je Projekt zusätzlich `board/runs/F-###/state.yaml` (ephemer, vom
 *   Feature-Drain geschrieben, `src/RunStateReader.js`) als `runs`-Liste am
 *   Projekt-Index an. Read-only (kein Schreibpfad nach `board/runs/`). Fehlt
 *   `board/runs/` → leere Liste, kein Crash.
 *   AC2 — Feldnamen gemäß agent-flow `feature-batch-orchestration` v2 (hier NICHT
 *   neu definiert, nur gemappt): feature, phase, currentStory, done/total, round,
 *   startedAt, lastError, isLastRun. Fehlende Einzelfelder → null.
 *   AC3 — Ein defektes/halb-geschriebenes state.yaml macht nur diesen einen
 *   Feature-Lauf unsichtbar (übersprungen, best-effort geloggt) — der restliche
 *   Run-State-Index UND der bestehende Board-Index bleiben intakt.
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

import { readdir, readFile, stat } from 'node:fs/promises';
import { watch as watchCallback, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { computeFeatureStatus } from './featureStatus.js';
import { readRunStates } from './RunStateReader.js';

// Re-export: computeFeatureStatus lebt seit board-filter-feature-status-consistency
// (S-241) als geteilte, dependency-freie Pure-Funktion in ./featureStatus.js (EINE
// logische Regel-Quelle, AC3 — auch von client/src/BoardView.jsx importiert). Der
// Re-Export hält den bestehenden Import-Pfad `from '../src/BoardAggregator.js'`
// (Tests, ggf. weitere Konsumenten) unverändert funktionsfähig.
export { computeFeatureStatus };

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

/**
 * Async-Iterator-Adapter um `node:fs`'s Callback-`watch()`-API (fswatcher-
 * crash-hardening V2 AC8).
 *
 * `node:fs/promises.watch({recursive:true})` deckt unter Linux via einen
 * NICHT-nativen, JS-emulierten rekursiven Watcher ab, der intern mehrere
 * echte `FSWatcher`-EventEmitter-Instanzen (eine pro Unterverzeichnis)
 * verwaltet. Emittiert eine DIESER internen Instanzen ein `'error'`-Event
 * (z.B. `ENOENT scandir` beim internen Nach-Bewaffnen eines verschwundenen
 * Unterverzeichnisses), wird dieses Event NICHT zuverlässig über den äußeren
 * Async-Iterator propagiert — es eskaliert stattdessen zu einer
 * `uncaughtException` (Vorfall 2026-07-07, `Emitted 'error' event on
 * FSWatcher instance`). Das bestehende `for await`-`try/catch` in
 * `_watchRoot()` (V1 AC1/AC2) greift für diesen Pfad strukturell nicht.
 *
 * Dieser Adapter nutzt stattdessen die Callback-API (`node:fs.watch`)
 * DIREKT und registriert einen EXPLIZITEN `'error'`-Listener auf der
 * zurückgegebenen `FSWatcher`-Instanz — ein `'error'`-Event mit
 * registriertem Listener wird NIE zur `uncaughtException` (Node-Kernverhalten
 * von `EventEmitter`). Der Fehler wird stattdessen in den Async-Iterator
 * geroutet (`next()` rejected), sodass das bestehende `try/catch` um
 * `for await` in `_watchRoot()` ihn wie jeden anderen Watcher-Fehler
 * behandelt (Re-Arm-mit-Backoff-Disziplin, AC3–AC5) — kein neues Verhalten,
 * nur ein zuverlässigerer Zubringer zum bereits gehärteten Pfad.
 *
 * Zusätzliche Absicherung (AC3 — Verschwindender Pfad): die reine Callback-
 * API meldet das Verschwinden der beobachteten Wurzel SELBST unter Linux
 * NICHT als `'error'`-Event (nur ein reguläres `'rename'`-Change-Event für
 * den Wurzel-Eintrag, live verifiziert) — anders als `fs/promises.watch()`,
 * dessen interne Emulation das über einen ENOENT/scandir-Fehler abbildet.
 * Nach jedem Change-Event wird deshalb (synchron, `existsSync`) geprüft, ob
 * die Wurzel noch existiert; ist sie verschwunden, wird der Iterator mit
 * einem synthetischen `ENOENT`-Fehler beendet — dieselbe Re-Arm-Disziplin
 * greift dann wie beim promise-API-Pfad.
 *
 * Signatur-kompatibel zu `fs/promises.watch(path, {recursive, signal}) →
 * AsyncIterable<{eventType, filename}>` (Verträge — injizierbare Watch-Quelle
 * bleibt unverändert austauschbar).
 *
 * Exportiert (zusätzlich zur internen Verwendung als `defaultFsDeps.watch`)
 * für einen direkten Integrationstest (AC8) — verifiziert den Adapter isoliert
 * gegen einen ECHTEN, von `node:fs.watch` erzeugten internen `'error'`-Event,
 * ohne den kompletten `BoardAggregator` inkl. Meta-/Subtree-Watch-Architektur
 * mit-testen zu müssen.
 *
 * @param {string} path
 * @param {{recursive?: boolean, signal?: AbortSignal, watchImpl?: Function}} [options]
 *   `watchImpl` — injizierbare `node:fs.watch`-Quelle (Default: das echte
 *   `node:fs.watch`). Rein zu Testzwecken (S-320 Review-Iteration 2, Finding
 *   #2): ESM-Modul-Namensraum-Objekte sind read-only, `jest.spyOn(fs, 'watch')`
 *   kann `node:fs` daher nicht mocken — ein Test, der den internen,
 *   registrierten `'error'`-Listener direkt auslösen will, braucht Zugriff auf
 *   die tatsächlich erzeugte `FSWatcher`-Instanz. Produktivpfad (`_watchRoot`
 *   → `#fsDeps.watch` → `watchWithErrorGuard`) übergibt `watchImpl` nie —
 *   Default bleibt das echte `node:fs.watch`, kein Verhaltensunterschied.
 * @returns {AsyncIterable<{eventType: string, filename: string|null}>}
 */
export function watchWithErrorGuard(path, options = {}) {
  const { recursive = false, signal, watchImpl = watchCallback } = options;
  return {
    [Symbol.asyncIterator]() {
      const queue = [];
      let pendingSettlers = null; // { resolve, reject }
      let finished = false;
      let finalError = null; // set when the watcher itself errored
      let watcher;

      try {
        watcher = watchImpl(path, { recursive, persistent: true });
      } catch (err) {
        // Synchronous throw at arm-time (e.g. path doesn't exist yet) — mirror
        // fs/promises.watch()'s contract: surface it from the FIRST next().
        finished = true;
        finalError = err;
      }

      const settleNext = (result) => {
        if (pendingSettlers) {
          const { resolve, reject } = pendingSettlers;
          pendingSettlers = null;
          if (result.error) reject(result.error);
          else resolve(result);
        } else {
          queue.push(result);
        }
      };

      if (watcher) {
        watcher.on('change', (eventType, filename) => {
          settleNext({ done: false, value: { eventType, filename } });
          // AC3: die Callback-API meldet ein Verschwinden der Wurzel selbst
          // nicht als Fehler — nachträgliche Existenzprüfung schließt diese
          // Lücke (siehe Doc-Kommentar oben). Nach `settleNext`, damit das
          // reguläre Change-Event selbst (z.B. das letzte "rename" des
          // Wurzel-Eintrags) noch konsumiert wird, bevor der Fehlerpfad greift.
          if (!finished && !existsSync(path)) {
            finished = true;
            const err = Object.assign(
              new Error(`ENOENT: no such file or directory, scandir '${path}'`),
              { code: 'ENOENT', syscall: 'scandir', path },
            );
            finalError = err;
            try {
              watcher.close();
            } catch {
              /* already closed */
            }
            settleNext({ done: true, error: err });
          }
        });
        // EXPLICIT error listener — the entire point of this adapter (AC8):
        // an 'error' event with a registered listener never becomes an
        // uncaughtException, regardless of which internal sub-watcher raised it.
        watcher.on('error', (err) => {
          finished = true;
          finalError = err;
          settleNext({ done: true, error: err });
        });

        const onAbort = () => {
          finished = true;
          try {
            watcher.close();
          } catch {
            /* already closed */
          }
          const abortErr = Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
          });
          settleNext({ done: true, error: abortErr });
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      return {
        next() {
          if (queue.length > 0) {
            const result = queue.shift();
            if (result.error) return Promise.reject(result.error);
            return Promise.resolve(result);
          }
          if (finished) {
            if (finalError) return Promise.reject(finalError);
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((resolve, reject) => {
            pendingSettlers = { resolve, reject };
          });
        },
        return() {
          finished = true;
          try {
            if (watcher) watcher.close();
          } catch {
            /* already closed */
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

/** Default FS dependencies (real node:fs/promises + error-guarded watch). */
const defaultFsDeps = {
  readdir,
  readFile,
  // fswatcher-crash-hardening V2 AC8: watchWithErrorGuard() statt direkt
  // fs/promises.watch — siehe Doc-Kommentar dort für die Begründung (interne
  // FSWatcher-'error'-Events crashen sonst am Async-Iterator vorbei).
  watch: watchWithErrorGuard,
  // fswatcher-crash-hardening: injizierbare Timer + Existenz-Prüfer (analog zum
  // fsDeps-Muster) für deterministische Re-Arm-/Backoff-Tests (AC4/AC5). Defaults
  // nutzen echte Timer bzw. node:fs/promises.stat.
  setTimeout: (...args) => globalThis.setTimeout(...args),
  clearTimeout: (...args) => globalThis.clearTimeout(...args),
  pathExists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
};

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

  // Quoted string — single or double.
  // Single-quoted YAML scalars use the standard doubled-quote escape for an
  // embedded `'` (`'` → `''`, written by `BoardWriter._yamlSingleQuote()`).
  // Strip the outer quotes, THEN unescape `''` back to `'` — otherwise a
  // title/body/blocked_reason with an apostrophe round-trips as `''` instead
  // of `'` (S-199 Iteration 2 fix; ONLY this single-quote unescape changes —
  // no other parse semantics touched, BoardAggregator stays read-only).
  if (t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }

  // Number (integer or float)
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return Number(t);
  }

  return t;
}

// ── areas.yaml-Parser (bereichs-modell AC1) ───────────────────────────────────
// `board/areas.yaml` ist — anders als board.yaml/features/*.yaml/stories/*.yaml —
// ein ROOT-LEVEL YAML-Liste von Mappings (`- id: ...\n  name: ...`), kein einzelnes
// Top-Level-Mapping-Dokument. `_parseYamlDoc()`/`parseYaml()` decken nur Letzteres
// ab — deshalb ein eigener, kleiner Parser, der pro Listen-Item denselben
// Scalar-/Kommentar-/Quoting-Regelsatz (`_parseYamlDoc`) wiederverwendet.

/**
 * Parse a root-level YAML list of mappings, e.g. `board/areas.yaml`:
 *   - id: board
 *     name: Board
 *     order: 1
 *     description: ...
 *   - id: fabrik-arbeiten
 *     ...
 *
 * Returns [] on any parse error or empty/blank input (never throws —
 * bereichs-modell AC1 Fehlertoleranz).
 *
 * @param {string} content
 * @returns {Array<Record<string, unknown>>}
 */
export function parseAreasYamlList(content) {
  if (!content || typeof content !== 'string') return [];
  const trimmed = content.trim();
  if (!trimmed) return [];
  try {
    return _parseYamlMappingList(trimmed);
  } catch {
    return [];
  }
}

/**
 * Internal: parse the trimmed body of a root-level YAML list-of-mappings.
 * @param {string} text
 * @returns {Array<Record<string, unknown>>}
 */
function _parseYamlMappingList(text) {
  const lines = text.split('\n');
  const items = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine === '---') {
      i++;
      continue;
    }

    const leadingSpaces = line.length - line.trimStart().length;
    const stripped = line.trimStart();

    if (!stripped.startsWith('- ') && stripped !== '-') {
      // Not a list item at this level — skip (defensive; malformed input).
      i++;
      continue;
    }

    const firstFieldRaw = stripped.startsWith('- ') ? stripped.slice(2) : '';
    const itemIndent = leadingSpaces + 2;
    const itemLines = [firstFieldRaw];
    i++;

    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; } // blank line inside an item — ignore
      const lLeading = l.length - l.trimStart().length;
      if (lLeading < itemIndent) break; // next item (or dedent) → this item ends
      itemLines.push(l.slice(itemIndent));
      i++;
    }

    items.push(_parseYamlDoc(itemLines.join('\n')));
  }

  return items;
}

/**
 * Validate + normalize raw `areas.yaml` list entries into area objects
 * (bereichs-modell AC1). Entries missing a non-empty `id`/`name` or with a
 * non-integer `order` are skipped (best effort, logged — AC1). `storyCount`
 * starts at 0 and is filled in by the caller (roll-up, AC2). Result is sorted
 * by `order` ascending.
 *
 * @param {Array<Record<string, unknown>>} rawList
 * @returns {Array<{id: string, name: string, order: number, description: string|null, storyCount: number}>}
 */
function _buildAreaEntries(rawList) {
  const areas = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') {
      console.warn('[BoardAggregator] Ungültiger areas.yaml-Eintrag übersprungen (kein Objekt).');
      continue;
    }
    const id = raw.id != null ? String(raw.id).trim() : '';
    const name = raw.name != null ? String(raw.name).trim() : '';
    const order = raw.order;
    if (!id || !name || typeof order !== 'number' || !Number.isInteger(order)) {
      console.warn(`[BoardAggregator] Ungültiger areas.yaml-Eintrag übersprungen (id="${id}").`);
      continue;
    }
    areas.push({
      id,
      name,
      order,
      description: raw.description != null ? String(raw.description) : null,
      storyCount: 0,
    });
  }
  areas.sort((a, b) => a.order - b.order);
  return areas;
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

// ── Feature-Status-Ableitung (read-only, Anzeige) — feature-status-derivation ──
// computeFeatureStatus lebt (seit S-241) in ./featureStatus.js — importiert +
// re-exportiert oben (Zeile ~46, EINE geteilte Regel-Quelle, AC3).

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

// ── Watcher-Re-Arm-Backoff (fswatcher-crash-hardening AC4) ────────────────────
// Feste, benannte Backoff-Parameter für den Watcher-Re-Arm nach Fehler/
// Verschwinden einer Wurzel: exponentiell wachsend, nach oben begrenzt (kein
// Busy-Loop, keine unbeschränkte Wiederholfrequenz).
const REARM_INITIAL_DELAY_MS = 500;
const REARM_BACKOFF_FACTOR = 2;
const REARM_MAX_DELAY_MS = 30_000;

// Bestehendes Debounce-Intervall der Index-Invalidierung bei Watcher-Events
// (unverändert, jetzt als benannte Konstante statt Magic Number).
const WATCH_DEBOUNCE_MS = 200;

// ── Watch-Scope-Verengung (fswatcher-crash-hardening V2 AC9) ──────────────────
// Flüchtige/irrelevante Unterbäume, die NIE beobachtet werden — sie erzeugen
// den Verschwinde-Churn (npm install, git-Operationen, Worktree-Anlage/-Entfernung,
// Jest-Testtempverzeichnisse), der interne FSWatcher-Instanzen (recursive:true,
// Linux) zum internen `ENOENT scandir` bringt (Vorfall 2026-07-07). EINE benannte,
// dokumentierte Modul-Konstante (statt über mehrere Stellen verstreuter Strings) —
// erweiterbar. Segment-Namen sind Verzeichnis-Basenames, `test/.tmp-*` ist ein
// Pfad-Präfix-Muster (Jest-Testtempverzeichnisse, siehe test/*.test.js `mkdtemp`-
// artige Hilfsfunktionen).
// AC9 verlangt wörtlich mindestens `test/.tmp-*`, `node_modules`, `.git`,
// `.claude/worktrees`. `.claude/worktrees` liegt unter `.claude/` — dieses wird
// hier pauschal als Ganzes ignoriert (auch andere `.claude/*`-Unterordner sind
// reine Tooling-/Session-Artefakte, kein Board-/Spec-relevanter Inhalt), was
// den geforderten `.claude/worktrees`-Fall mit abdeckt (jeder Vorfahre im Pfad
// ignoriert → gesamter Unterbaum ignoriert, siehe isWatchIgnoredPath()).
const WATCH_IGNORED_BASENAMES = new Set(['node_modules', '.git', '.claude']);

// Jest-Testtempverzeichnis-Präfix: `test/.tmp-<zufall>` (siehe Vorfall
// 2026-07-07, `test/.tmp-router-y8i8og6spkr`). Pfad-Segment-Paar: Parent-
// Basename `test`, Kind-Basename beginnt mit `.tmp-`.
const WATCH_IGNORED_TEST_TMP_PARENT = 'test';
const WATCH_IGNORED_TEST_TMP_PREFIX = '.tmp-';

/**
 * Reine Prüf-Funktion (unit-testbar, AC9): ist ein Verzeichnis-Basename —
 * relativ zu seinem direkten Eltern-Verzeichnis — Teil eines ignorierten,
 * flüchtigen/irrelevanten Unterbaums (`node_modules`, `.git`, `.claude`
 * inkl. `.claude/worktrees`, `test/.tmp-*`)?
 *
 * @param {string} basename  Name des Verzeichnis-Eintrags (kein Pfad).
 * @param {string} [parentBasename]  Basename des direkten Eltern-Verzeichnisses
 *   (für das `test/.tmp-*`-Muster relevant; bei Top-Level-Einträgen ohne
 *   bekannten Parent optional weglassbar).
 * @returns {boolean}
 */
export function isWatchIgnoredEntry(basename, parentBasename) {
  if (WATCH_IGNORED_BASENAMES.has(basename)) return true;
  if (
    parentBasename === WATCH_IGNORED_TEST_TMP_PARENT &&
    basename.startsWith(WATCH_IGNORED_TEST_TMP_PREFIX)
  ) {
    return true;
  }
  return false;
}

/**
 * Reine Prüf-Funktion (unit-testbar, AC9 — Spec-Testbeispiel
 * "`board/runs/F-070/state.yaml` → beobachtet"): ist ein — relativ zu einer
 * Watch-Wurzel gegebener — Pfad (POSIX- oder OS-Separator, beliebige Tiefe)
 * Teil eines ignorierten Unterbaums? Wendet `isWatchIgnoredEntry()` auf jedes
 * Pfad-Segment (mit seinem jeweiligen Vorgänger-Segment als Parent) an —
 * ignoriert, sobald IRGENDEIN Vorfahre im Pfad selbst ignoriert ist (z.B.
 * `node_modules/pkg/index.js`, `test/.tmp-abc/nested/file.txt`).
 *
 * Produktiv NICHT im Live-Event-Pfad verwendet: die gewählte Scope-Verengungs-
 * Mechanik (mehrere gezielte Unterbaum-Watches statt EIN rekursiver Watch +
 * Event-Filter, siehe `_syncRepoWatchers()`) verhindert bereits STRUKTURELL,
 * dass je ein Event aus einem ignorierten Unterbaum entsteht — ein
 * nachgelagerter Pfad-Filter ist dafür nicht nötig (`isWatchIgnoredEntry()`
 * allein genügt für die Top-Level-Verzeichnisfilterung in
 * `_syncRepoWatchers()`). Diese Funktion bleibt exportiert, weil sie als reine
 * Funktion Teil des von AC9 geforderten, unit-testbaren Vertrags ist
 * (Mehrsegment-Pfad-Beispiel) und als zukünftiger Baustein dient, sollte eine
 * spätere Änderung doch auf einen einzigen rekursiven Watch + Event-Filter
 * umsteigen müssen.
 *
 * @param {string} relativePath  Pfad relativ zur Watch-Wurzel, z.B. wie ihn
 *   `fsEvent.filename` aus `fs/promises.watch({recursive:true})` liefert.
 * @returns {boolean}
 */
export function isWatchIgnoredPath(relativePath) {
  if (!relativePath) return false;
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const parent = i > 0 ? segments[i - 1] : undefined;
    if (isWatchIgnoredEntry(segments[i], parent)) return true;
  }
  return false;
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
 *   Injectable filesystem helpers: { readdir, readFile, watch, setTimeout,
 *   clearTimeout, pathExists }. `setTimeout`/`clearTimeout`/`pathExists`
 *   (fswatcher-crash-hardening) drive the watcher re-arm/backoff and are
 *   injectable for deterministic tests, analog to `watch`. Merged over the
 *   real defaults (node:fs/promises + real timers) — a partial override (e.g.
 *   just { readdir, readFile, watch }, the pre-existing pattern) keeps real
 *   timers/pathExists for the fields it omits.
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
  /**
   * Memoized Standardansicht (archivierte Features/Stories ausgeblendet, AC3/V3).
   * Abgeleitet aus `#index`; wird bei jedem Index-Wechsel (scan/Watcher) verworfen,
   * damit wiederholte `getIndex()`-Aufrufe ohne Re-Scan dieselbe Referenz liefern
   * (AC2 — flüchtiger Index, kein Re-Scan bei wiederholtem Lesen).
   * @type {Array<ProjectEntry|ErrorEntry>|null}
   */
  #standardIndex = null;
  /**
   * Active watcher states (fswatcher-crash-hardening). V1: ein Eintrag je
   * `BOARD_ROOTS`-Wurzel. V2 (Scope-Verengung, AC9): pro `BOARD_ROOTS`-Wurzel
   * EIN nicht-rekursiver Meta-Watch (erkennt neue/verschwindende Top-Level-
   * Repo-Verzeichnisse) plus je erkanntem, nicht-ignoriertem Repo bis zu zwei
   * rekursive Unterbaum-Watches (`<repo>/board`, `<repo>/docs/specs`) — beide
   * nur, falls der jeweilige Unterbaum existiert. `node_modules`, `.git`,
   * `.claude` (inkl. `.claude/worktrees`) und `test/.tmp-*` werden dadurch nie
   * Teil eines beobachteten Verzeichnisbaums (kein interner FSWatcher entsteht
   * dort je). Jeder Eintrag: { root, kind: 'meta'|'subtree', ac: AbortController,
   * backoffDelay: number, rearmTimerId: *|null, stopped: boolean }.
   * @type {Array<object>}
   */
  #watchers = [];
  /**
   * Re-Entrancy-Schutz für `_syncRepoWatchers()` (fswatcher-crash-hardening
   * V2, S-320 Review-Finding #1). `_syncRepoWatchers(root)` liest
   * `activeSubtreeRoots` erst NACH mehreren `await`-Punkten
   * (`readdir`/`pathExists`-Schleife) — ohne Schutz könnten zwei überlappende
   * Aufrufe für dieselbe `root` (ausgelöst durch mehrere rohe Meta-Watch-
   * Events kurz hintereinander, z.B. `git clone`) denselben neu entstandenen
   * Subtree-Pfad beide als "noch nicht aktiv" sehen und je einen eigenen
   * Watcher-State pushen (doppelter FSWatcher + doppelter Debounce-Timer,
   * NFR-Verstoss "höchstens ein ausstehender Re-Arm-Timer je Wurzel").
   * Map: root → Promise der zuletzt gestarteten Sync-Kette. Ein Aufruf
   * während ein anderer für dieselbe Wurzel noch läuft, wird NICHT parallel
   * ausgeführt, sondern an die laufende Kette angehängt (chained), sodass
   * höchstens ein weiterer Sync-Durchlauf nachfolgt (kein Aufstauen).
   * @type {Map<string, Promise<void>>}
   */
  #syncInFlight = new Map();
  /**
   * Globaler Stop-Flag (fswatcher-crash-hardening V2, S-320 Review-Finding #2,
   * Iteration 2). `stopWatchers()` leert `#watchers` synchron — eine zu diesem
   * Zeitpunkt bereits laufende `_syncRepoWatchers()`-Kette (verkettet über
   * `#syncInFlight`, potenziell mehrere `await`-Punkte tief) hat darauf aber
   * KEINE Sichtbarkeit: sie würde nach dem `stopWatchers()`-Aufruf trotzdem zu
   * Ende laufen, einen frischen (`stopped: false`) Watcher-State pushen und via
   * `_armRoot()` bewaffnen — ein `watch()`-Aufruf NACH `stopWatchers()`,
   * Verstoss gegen AC5 ("kein weiterer watch()-Aufruf" nach Stop). Dieser Flag
   * wird von `stopWatchers()` gesetzt und von `_syncRepoWatchersOnce()`
   * unmittelbar VOR jedem State-Push/`_armRoot()`-Aufruf geprüft (sowohl vor
   * dem Bewaffnen neu erkannter Unterbäume als auch — implizit harmlos, da
   * `#watchers` dann leer ist — beim Aufräumen verschwundener). Wird erst
   * wieder auf `false` gesetzt, wenn `startWatchers()` neu gestartet wird.
   * @type {boolean}
   */
  #allStopped = false;

  constructor({ boardRootsEnv, fsDeps } = {}) {
    const envVal = boardRootsEnv ?? process.env.BOARD_ROOTS ?? '';
    this.#boardRoots = parseBoardRoots(envVal);
    // Merge (not replace): callers/tests overriding just { readdir, readFile, watch }
    // (pre-existing pattern) automatically keep real timers/pathExists for the new
    // re-arm/backoff machinery — no silent breakage of existing fsDeps overrides.
    this.#fsDeps = { ...defaultFsDeps, ...(fsDeps ?? {}) };
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

    // Atomically replace the index (+ verwerfe die abgeleitete Standardansicht).
    this.#index = projects;
    this.#standardIndex = null;
  }

  /**
   * Liest EIN Projekt read-only neu ein — unabhängig vom In-Memory-`#index`
   * (kein Seiteneffekt auf `scan()`/`getIndex()`) — wahlweise aus einer
   * ALTERNATIVEN Datei-Quelle (drain-origin-progress-sync AC2/AC7, Verträge
   * §Snapshot-Schnittstelle "working-tree ↔ git-ref").
   *
   * Wiederverwendet dieselbe `_readBoard()`-Scan-/`computeStoryReadyStatus()`-
   * Ready-Logik wie der reguläre Multi-Repo-Scan — NUR die `readdir`/
   * `readFile`-Implementierung wird ausgetauscht (Default: `this.#fsDeps`,
   * also der Working-Tree, bit-identisch zu `scan()`). `ProjectDrain` injiziert
   * hier bei einem verifiziert-vorauslaufenden `origin` eine Git-Ref-Datei-
   * Quelle (`createGitRefFsDeps`, `src/GitReadBoundary.js`) — read-only,
   * berührt niemals den Working-Tree.
   *
   * @param {string} slug      Repo-Verzeichnisname (Projekt-Slug).
   * @param {string} repoPath  Absoluter Projektpfad.
   * @param {{ fsDeps?: { readdir: Function, readFile: Function } }} [options]
   * @returns {Promise<ProjectEntry|ErrorEntry|null>}
   *   `null`, wenn unter `repoPath` kein `board/`-Verzeichnis existiert (bzw.
   *   bei der Git-Ref-Quelle: am gewählten Ref) — analog `scan()`s stillem
   *   Überspringen ohne `board/`-Ordner, kein Crash.
   */
  async readProjectAt(slug, repoPath, { fsDeps } = {}) {
    const effectiveFsDeps = fsDeps ?? this.#fsDeps;
    const boardDir = join(repoPath, 'board');
    try {
      await effectiveFsDeps.readdir(boardDir, { withFileTypes: true });
    } catch {
      return null; // kein board/-Verzeichnis (an dieser Quelle) — kein Fehler.
    }
    return this._readBoard(slug, repoPath, boardDir, effectiveFsDeps);
  }

  /**
   * Read a single board directory and return a ProjectEntry or ErrorEntry.
   *
   * @param {string} slug      Repo directory name (used as project slug).
   * @param {string} repoPath  Absolute path to the repo root.
   * @param {string} boardDir  Absolute path to the board/ directory.
   * @param {{ readdir: Function, readFile: Function }} [fsDeps]  Datei-Quelle
   *   (drain-origin-progress-sync AC2/Verträge §Snapshot-Schnittstelle):
   *   Default `this.#fsDeps` (Working-Tree). `readProjectAt()` kann hier eine
   *   Git-Ref-Datei-Quelle (`createGitRefFsDeps`, `src/GitReadBoundary.js`)
   *   injizieren — `_readBoard`/`computeStoryReadyStatus` bleiben dabei
   *   UNVERÄNDERT (nur `readdir`/`readFile` werden ausgetauscht).
   * @returns {Promise<ProjectEntry|ErrorEntry>}
   */
  async _readBoard(slug, repoPath, boardDir, fsDeps = this.#fsDeps) {
    // ── board.yaml ────────────────────────────────────────────────────────────
    const boardYamlPath = join(boardDir, 'board.yaml');
    let boardMeta;
    try {
      const raw = await fsDeps.readFile(boardYamlPath, 'utf8');
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
        areas: [],
        runs: [],
      };
    }

    // ── board/runs/F-###/state.yaml (run-state-live-view AC1/AC2/AC3) ────────
    // Read-only, fehlertolerant (siehe RunStateReader.js — nie throw). Nutzt
    // dieselbe fsDeps-Quelle (Working-Tree per Default, Git-Ref bei readProjectAt()).
    const runs = await readRunStates(repoPath, fsDeps);

    // ── areas.yaml (bereichs-modell AC1) ─────────────────────────────────────
    // Fehlende/leere Datei → leere Liste, kein Crash (Abwärtskompatibilität mit
    // Projekten ohne Bereiche).
    const areasYamlPath = join(boardDir, 'areas.yaml');
    let areasRawList;
    try {
      const areasRaw = await fsDeps.readFile(areasYamlPath, 'utf8');
      areasRawList = parseAreasYamlList(areasRaw);
    } catch {
      areasRawList = []; // missing/unreadable file → empty list, no crash (AC1)
    }
    const areas = _buildAreaEntries(areasRawList);

    // ── features/*.yaml ───────────────────────────────────────────────────────
    const featuresDir = join(boardDir, 'features');
    let featureFiles = [];
    try {
      const fentries = await fsDeps.readdir(featuresDir, { withFileTypes: true });
      featureFiles = fentries
        .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
        .map((e) => join(featuresDir, e.name));
    } catch {
      // features/ missing → empty (still a valid board if board.yaml is ok)
    }

    const featuresMap = new Map(); // id → FeatureEntry
    for (const fp of featureFiles) {
      try {
        const raw = await fsDeps.readFile(fp, 'utf8');
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
          // board-feature-archive AC3: In-place-Archiv-Flag (additiv/optional).
          // Fehlt das YAML-Feld → archived: false (nicht archiviert). Standardansicht
          // (getIndex ohne includeArchived) blendet archived===true aus.
          archived: data.archived === true,
          archived_at: data.archived_at != null ? String(data.archived_at) : null,
          // bereichs-modell AC2: additiv-optionale Bereichs-Zuordnung des Features
          // (agent-flow-Schema `feature.area`) — Fallback für Stories ohne eigenes
          // `area`-Feld beim Roll-up. null wenn nicht gesetzt.
          area: data.area != null ? String(data.area) : null,
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
      const sentries = await fsDeps.readdir(storiesDir, { withFileTypes: true });
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
        const raw = await fsDeps.readFile(sp, 'utf8');
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
          // ideen-inbox AC5: Stichwort-Body einer Idee (aus createIdea()/S-199 notes-Feld) —
          // wird als Gesprächs-Einstieg für die Besprechungs-Session (POST .../discuss)
          // wiederverwendet. null wenn kein notes-Feld gesetzt ist.
          notes: data.notes != null ? String(data.notes) : null,
          dispo_est: data.dispo_est ?? null,
          dispo_act: data.dispo_act ?? null,
          // taktgeber-nachtwaechter AC1: letzter Änderungszeitstempel (story.schema.json
          // "updated_at", Pflichtfeld) — Quelle für die "verwaiste In-Progress"-Stale-Erkennung
          // (Drain-Ziel (b)) und für ProjectDrain-Fortschritts-/Eskalations-Tracking.
          updated_at: data.updated_at != null ? String(data.updated_at) : null,
          // story-detail-yaml-fallback AC1: YAML-Felder für Fallback
          done_at: data.done_at != null ? String(data.done_at) : null,
          branch: data.branch != null ? String(data.branch) : null,
          pr: data.pr != null ? String(data.pr) : null,
          // board-feature-archive AC3: In-place-Archiv-Flag (additiv/optional).
          // Fehlt das YAML-Feld → archived: false. Standardansicht blendet
          // archived===true aus (auch einzeln-archivierte Stories — Randfall V3).
          archived: data.archived === true,
          archived_at: data.archived_at != null ? String(data.archived_at) : null,
          // bereichs-modell AC2: additiv-optionale Bereichs-Zuordnung der Story
          // (agent-flow-Schema `story.area`). null wenn nicht gesetzt — dann fällt
          // der Roll-up auf das `area` des Eltern-Features zurück (siehe unten).
          area: data.area != null ? String(data.area) : null,
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
        const result = await computeStoryReadyStatus(story, fsDeps, repoPath, allStoriesMap);
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
      // feature-status-derivation V5/AC5: Feature-Status IMMER live aus den
      // Kind-Stories ableiten (V1–V4/V6) — überschreibt das persistierte YAML-
      // status:-Feld bedingungslos (für die Anzeige nicht mehr gelesen). Read-only:
      // reine In-Memory-Berechnung, kein Board-Datei-Schreibvorgang. Gilt nur für
      // echte Features; das _orphaned-Pseudo-Feature wird unten mit status:null
      // ohne Ableitung angehängt (AC7).
      feature.status = computeFeatureStatus(feature.stories);
    }

    // ── bereichs-modell AC2 — Roll-up: storyCount je Bereich ─────────────────
    // Ein Bereich zählt jede Story, deren eigenes `area`-Feld auf ihn zeigt;
    // hat die Story kein eigenes `area`, fällt der Roll-up auf das `area` des
    // Eltern-Features zurück (`feature.area`). Ohne Treffer bleibt der Bereich
    // sichtbar mit `storyCount: 0` (leerer, aber dauerhafter Bereich).
    if (areas.length > 0) {
      const areaIds = new Set(areas.map((a) => a.id));
      const counts = new Map();
      for (const story of allStoriesList) {
        const parentFeature = story.parent ? featuresMap.get(story.parent) : null;
        const effectiveArea = story.area ?? parentFeature?.area ?? null;
        if (effectiveArea && areaIds.has(effectiveArea)) {
          counts.set(effectiveArea, (counts.get(effectiveArea) ?? 0) + 1);
        }
      }
      for (const area of areas) {
        area.storyCount = counts.get(area.id) ?? 0;
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
      areas,
      runs,
    };
  }

  /**
   * Return the current in-memory index. If not yet scanned, triggers a scan first.
   *
   * board-feature-archive AC3 (V3): In der Standardansicht (`includeArchived`
   * false, Default) werden Features mit `archived: true` (und deren Stories)
   * ausgeblendet — sie erscheinen weder in der Feature-Liste noch in den
   * Zählern/Rollups. Eine einzeln `archived: true` markierte Story (deren Feature
   * sichtbar bliebe — Randfall) wird ebenfalls ausgeblendet; der Feature-Rollup
   * wird dann aus den verbleibenden (sichtbaren) Stories neu berechnet. Mit
   * `includeArchived: true` wird der vollständige Index geliefert — archivierte
   * Features/Stories tragen dabei `archived: true` + `archived_at` (durchgereicht).
   *
   * Der interne `#index` bleibt stets vollständig (inkl. Archivierte); die
   * Standardansicht ist eine gefilterte, nicht-mutierende Kopie.
   *
   * @param {{ includeArchived?: boolean }} [options]
   * @returns {Promise<Array<ProjectEntry|ErrorEntry>>}
   */
  async getIndex({ includeArchived = false } = {}) {
    if (this.#index === null) {
      await this.scan();
    }
    if (includeArchived) {
      return this.#index;
    }
    // Standardansicht memoisieren: wiederholte getIndex()-Aufrufe ohne Re-Scan
    // liefern dieselbe Referenz (AC2), die abgeleitete Sicht wird bei Index-Wechsel
    // (scan/Watcher) verworfen.
    if (this.#standardIndex === null) {
      this.#standardIndex = this.#index.map((project) => this._filterArchived(project));
    }
    return this.#standardIndex;
  }

  /**
   * Build a standard-view copy of a project entry with archived features/stories
   * removed (board-feature-archive AC3/V3). Non-mutating: the internal `#index`
   * keeps the full data. Error entries pass through unchanged.
   *
   * @param {ProjectEntry|ErrorEntry} project
   * @returns {ProjectEntry|ErrorEntry}
   * @private
   */
  _filterArchived(project) {
    if (project.error) return project; // Fehler-Board (features: []) unverändert.

    const features = [];
    for (const feature of project.features ?? []) {
      // Archiviertes Feature (samt Stories) komplett aus der Standardansicht.
      if (feature.archived === true) continue;

      const stories = feature.stories ?? [];
      const visibleStories = stories.filter((s) => s.archived !== true);
      if (visibleStories.length === stories.length) {
        // Nichts entfernt → Feature unverändert übernehmen (Original-Rollup bleibt,
        // inkl. eines evtl. aus dem YAML gelesenen progress-Werts).
        features.push(feature);
      } else {
        // Einzeln-archivierte Story entfernt (Randfall) → Rollup aus den sichtbaren
        // Stories neu berechnen, damit Zähler/Rollup keine Archivierten zählen (V3).
        features.push({
          ...feature,
          stories: visibleStories,
          progress: computeRollup(visibleStories),
        });
      }
    }

    // bereichs-modell AC2: `storyCount` je Bereich analog zu feature.progress
    // aus den sichtbaren (nicht-archivierten) Stories neu berechnen — sonst
    // zählt die Standardansicht auch archivierte Stories mit (leerer Bereich
    // wäre dann nicht als leer erkennbar, siehe AC2).
    const areasList = project.areas ?? [];
    let areas = areasList;
    if (areasList.length > 0) {
      const areaIds = new Set(areasList.map((a) => a.id));
      const counts = new Map();
      for (const feature of features) {
        for (const story of feature.stories ?? []) {
          const effectiveArea = story.area ?? feature.area ?? null;
          if (effectiveArea && areaIds.has(effectiveArea)) {
            counts.set(effectiveArea, (counts.get(effectiveArea) ?? 0) + 1);
          }
        }
      }
      areas = areasList.map((area) => ({ ...area, storyCount: counts.get(area.id) ?? 0 }));
    }

    return { ...project, features, areas };
  }

  /**
   * Start filesystem watchers for each board root directory.
   * On any change inside a watched, index-relevant subtree (`board/**`
   * inkl. `board/runs/`, `docs/specs/**` — AC10), the index is invalidated
   * and will be re-scanned on the next getIndex() call (AC9 — lazy re-scan).
   *
   * Scope-Verengung (fswatcher-crash-hardening V2 AC9): statt EINES rekursiven
   * Watchers auf die gesamte `BOARD_ROOTS`-Wurzel wird je Wurzel ein flacher
   * Meta-Watch (erkennt Top-Level-Repo-Verzeichnisse) plus je erkanntem Repo
   * gezielte rekursive Watches auf `<repo>/board` und `<repo>/docs/specs`
   * bewaffnet — `isWatchIgnoredEntry()` filtert Repo-Kandidaten wie
   * `node_modules`/`.git`/`.claude` bereits auf Top-Level-Ebene aus, sodass für
   * diese Unterbäume NIE ein interner FSWatcher entsteht (der ursächliche
   * Crash-Vektor aus dem Vorfall 2026-07-07, AC8).
   *
   * Hardening (fswatcher-crash-hardening AC1–AC5, AC8): every watcher error —
   * whether thrown synchronously at arm-time or during iteration (e.g.
   * ENOENT/scandir on a disappearing root, or an internal FSWatcher `'error'`
   * event) — is caught. The watcher is then re-armed once the root exists
   * again, using an exponential, capped backoff (never a busy-loop).
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
    // Re-Start nach einem vorherigen stopWatchers()-Aufruf muss den globalen
    // Stop-Flag wieder freigeben (S-320 Review-Finding #2) — sonst würde jede
    // neue Bewaffnung in `_syncRepoWatchersOnce()` sofort wieder unterdrückt.
    this.#allStopped = false;

    for (const root of this.#boardRoots) {
      // Meta-Watch: flach (nicht rekursiv) auf die BOARD_ROOTS-Wurzel selbst —
      // erkennt neu geklonte/entfernte Top-Level-Repo-Verzeichnisse und
      // resynchronisiert daraufhin die Unterbaum-Watches (AC10: neue Repos
      // bleiben auffindbar, kein Regress gegenüber dem V1-Rundum-Watch).
      const metaState = this._createWatcherState(root, 'meta');
      this.#watchers.push(metaState);
      this._armRoot(metaState, /* isRearm */ false);

      // Initiale Unterbaum-Watches für bereits vorhandene Repos.
      this._syncRepoWatchers(root).catch(() => { /* defensiv, AC1 */ });
    }
  }

  /**
   * Build a fresh watcher-state object (fswatcher-crash-hardening).
   * @param {string} root
   * @param {'meta'|'subtree'} kind
   * @returns {object}
   */
  _createWatcherState(root, kind) {
    return {
      root,
      kind,
      ac: new AbortController(),
      backoffDelay: REARM_INITIAL_DELAY_MS,
      rearmTimerId: null,
      stopped: false,
    };
  }

  /**
   * Resynchronize the set of subtree watchers (`<repo>/board`,
   * `<repo>/docs/specs`) for a single BOARD_ROOTS root against the current
   * top-level directory listing (fswatcher-crash-hardening V2 AC9/AC10).
   *
   * Called once at startWatchers() and again every time the root's flat
   * meta-watch observes a top-level change (new/removed repo directory) —
   * i.e. potentially from MULTIPLE overlapping event sources for the SAME
   * root in quick succession (raw, undebounced meta-watch events AND the
   * meta-watch's own re-arm). Re-Entrancy-Schutz (S-320 Review-Finding #1):
   * überlappende Aufrufe für dieselbe `root` werden über `#syncInFlight`
   * serialisiert (verkettet), statt parallel dieselbe
   * `activeSubtreeRoots`-Momentaufnahme zu lesen — sonst könnten zwei
   * gleichzeitige Aufrufe denselben neu entstandenen Subtree-Pfad beide als
   * "noch nicht aktiv" sehen und je einen eigenen Watcher-State pushen
   * (doppelter FSWatcher + doppelter Debounce-Timer auf demselben Pfad).
   *
   * Idempotent: repos/subtrees that already have an active watcher state are
   * left untouched; watchers for repos that disappeared are stopped.
   *
   * Never throws (AC1 discipline — errors are swallowed, best-effort).
   *
   * @param {string} root
   * @returns {Promise<void>}
   */
  _syncRepoWatchers(root) {
    // Verkette an die zuletzt für diese Wurzel gestartete Sync-Kette — egal
    // ob sie noch läuft oder bereits erledigt ist. `.catch()` verhindert eine
    // unhandled rejection, falls ein vorheriger Durchlauf (obwohl
    // `_syncRepoWatchersOnce` selbst nie wirft) doch einmal fehlschlägt.
    const previous = this.#syncInFlight.get(root) ?? Promise.resolve();
    const next = previous
      .catch(() => { /* defensiv — ein vorheriger Fehler blockiert die Kette nicht */ })
      .then(() => this._syncRepoWatchersOnce(root));
    this.#syncInFlight.set(root, next);
    return next;
  }

  /**
   * Der eigentliche (nicht re-entrant-geschützte) Sync-Durchlauf — nur über
   * `_syncRepoWatchers()` aufzurufen, welches überlappende Aufrufe für
   * dieselbe `root` serialisiert (siehe dort).
   *
   * @param {string} root
   * @returns {Promise<void>}
   */
  async _syncRepoWatchersOnce(root) {
    let entries;
    try {
      entries = await this.#fsDeps.readdir(root, { withFileTypes: true });
    } catch {
      // Wurzel (noch) nicht lesbar — der Meta-Watch-Re-Arm kümmert sich um
      // die Wiederkehr; hier best-effort, kein Fehler.
      return;
    }

    // S-320 Review-Finding #2 (Iteration 2, AC5): läuft diese Sync-Kette noch
    // nach einem zwischenzeitlichen `stopWatchers()`-Aufruf zu Ende, darf KEIN
    // frischer Watcher-State mehr gepusht/bewaffnet werden — sonst entsteht
    // ein `watch()`-Aufruf nach dem Stop. Der `readdir()`-Await oben ist genau
    // der Re-Entrancy-Punkt, an dem `stopWatchers()` dazwischenkommen kann.
    if (this.#allStopped) return;

    const desiredSubtreeRoots = new Set();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (isWatchIgnoredEntry(entry.name)) continue;

      const repoPath = join(root, entry.name);
      for (const sub of ['board', join('docs', 'specs')]) {
        const subtreeRoot = join(repoPath, sub);
        if (await this.#fsDeps.pathExists(subtreeRoot)) {
          desiredSubtreeRoots.add(subtreeRoot);
        }
      }
    }

    // Erneute Prüfung nach dem zweiten Re-Entrancy-Punkt oben (die
    // `pathExists()`-Await-Schleife) — `stopWatchers()` kann auch zwischen
    // dem `readdir()`- und dem `pathExists()`-Await dazwischenkommen.
    if (this.#allStopped) return;

    // Bereits aktive Subtree-Watches, die zu dieser BOARD_ROOTS-Wurzel gehören.
    const activeSubtreeRoots = new Set(
      this.#watchers
        .filter((s) => s.kind === 'subtree' && s.parentRoot === root && !s.stopped)
        .map((s) => s.root),
    );

    // Neue Unterbäume bewaffnen. Zusätzlich EINMAL den Index invalidieren
    // (AC10): das Erkennen eines neu entstandenen `board`/`docs/specs`-
    // Unterbaums liegt zeitlich (Meta-Watch-Debounce/Event-Latenz) hinter dem
    // Moment, in dem er entstanden ist — ohne diese Invalidierung könnte der
    // NEUE Subtree-Watch erst NACH bereits erfolgten Schreibvorgängen bewaffnet
    // werden und deren allererstes Event verpassen (z.B. Repo + board/ + erste
    // board.yaml in einem Rutsch angelegt). Ein frischer Scan holt den
    // aktuellen Stand in jedem Fall nach.
    if (desiredSubtreeRoots.size > 0) {
      let sawNewSubtree = false;
      for (const subtreeRoot of desiredSubtreeRoots) {
        if (activeSubtreeRoots.has(subtreeRoot)) continue;
        sawNewSubtree = true;
        const state = this._createWatcherState(subtreeRoot, 'subtree');
        state.parentRoot = root;
        this.#watchers.push(state);
        this._armRoot(state, /* isRearm */ false);
      }
      if (sawNewSubtree) {
        this.#index = null;
        this.#standardIndex = null;
      }
    }

    // Verschwundene Unterbäume (Repo entfernt / board-Ordner gelöscht) sauber
    // stoppen — kein Zombie-Watcher, kein Timer-Leak.
    for (const state of this.#watchers) {
      if (state.kind !== 'subtree' || state.parentRoot !== root || state.stopped) continue;
      if (desiredSubtreeRoots.has(state.root)) continue;
      state.stopped = true;
      if (state.rearmTimerId !== null) {
        this.#fsDeps.clearTimeout(state.rearmTimerId);
        state.rearmTimerId = null;
      }
      try { state.ac.abort(); } catch { /* ignore */ }
    }
    this.#watchers = this.#watchers.filter(
      (s) => !(s.kind === 'subtree' && s.parentRoot === root && s.stopped),
    );
  }

  /**
   * Arm (or re-arm) the watcher for a single root's watcher state.
   * Fire-and-forget — never throws / never leaves an unhandled rejection (AC1).
   *
   * On a successful RE-arm (isRearm === true), the backoff is reset and the
   * index is invalidated exactly once (AC4). When the watch loop subsequently
   * ends (error, disappearance, or a clean abort from stopWatchers()), either
   * schedules the next backoff re-arm or — on AbortError — does nothing (AC5).
   *
   * @param {object} state  Watcher state (see #watchers doc).
   * @param {boolean} isRearm  Whether this is a re-arm attempt after a failure.
   * @returns {void}
   */
  _armRoot(state, isRearm) {
    if (state.stopped) return;

    if (isRearm) {
      console.warn(`[BoardAggregator] Re-Arm-Versuch für Watcher-Wurzel "${state.root}"`);
    }

    const onArmed = () => {
      if (state.stopped) return;
      if (isRearm) {
        // AC4: erfolgreiche Neu-Bewaffnung → Backoff zurücksetzen + Index EINMAL
        // invalidieren (nächster getIndex()/scan() liest neu).
        state.backoffDelay = REARM_INITIAL_DELAY_MS;
        if (state.kind === 'meta') {
          // Meta-Watch-Re-Arm: sofort einmalig resynchronisieren (nicht erst
          // auf das nächste Top-Level-Event warten) — deckt AC10 im
          // Regressionsfall "Wurzel verschwindet und kommt wieder" ab.
          this._syncRepoWatchers(state.root).catch(() => { /* defensiv, AC1 */ });
        } else {
          this.#index = null;
          this.#standardIndex = null;
        }
      }
    };

    // Meta-Watch (nicht-rekursiv, Top-Level einer BOARD_ROOTS-Wurzel): jedes
    // Event resynct die Repo-Unterbaum-Watches (neue/entfernte Repos, AC10).
    // Subtree-Watch (rekursiv auf <repo>/board bzw. <repo>/docs/specs): jedes
    // Event invalidiert — debounced — den Index (bestehendes V1-Verhalten).
    const onEvent =
      state.kind === 'meta'
        ? () => {
            this._syncRepoWatchers(state.root).catch(() => { /* defensiv, AC1 */ });
          }
        : undefined;

    this._watchRoot(state.root, state.ac.signal, onArmed, onEvent, state.kind === 'meta')
      .then((outcome) => {
        if (state.stopped) return;
        if (outcome.aborted) return; // AC5: sauberer Stop via stopWatchers() — kein Re-Arm
        this._scheduleRearm(state);
      })
      .catch(() => {
        // Defensiv — _watchRoot() wirft nie, aber AC1 verlangt: kein Watcher-Fehler
        // eskaliert, unter keinen Umständen.
      });
  }

  /**
   * Schedule the next re-arm attempt for a root, honoring the exponential,
   * capped backoff (AC4). At most one pending re-arm timer per root (Edge-Case:
   * schnelle Lösch-/Neuanlege-Zyklen stauen keine parallelen Timer auf).
   *
   * @param {object} state
   * @returns {void}
   */
  _scheduleRearm(state) {
    if (state.stopped) return;
    if (state.rearmTimerId !== null) return; // höchstens ein ausstehender Timer je Wurzel

    const delay = state.backoffDelay;
    state.backoffDelay = Math.min(state.backoffDelay * REARM_BACKOFF_FACTOR, REARM_MAX_DELAY_MS);

    state.rearmTimerId = this.#fsDeps.setTimeout(() => {
      state.rearmTimerId = null;
      this._attemptRearm(state).catch(() => { /* defensiv, AC1 */ });
    }, delay);
  }

  /**
   * Fires when a backoff delay elapses: checks whether the root exists again
   * and either re-arms the watcher or schedules the next (grown) backoff round.
   *
   * @param {object} state
   * @returns {Promise<void>}
   */
  async _attemptRearm(state) {
    if (state.stopped) return;

    let exists;
    try {
      exists = await this.#fsDeps.pathExists(state.root);
    } catch {
      exists = false;
    }
    if (state.stopped) return;

    if (!exists) {
      // Pfad weiterhin nicht da (Edge-Case: dauerhaft fehlende Wurzel) — Backoff
      // läuft bis zur Obergrenze und verweilt dort, kein Busy-Loop.
      this._scheduleRearm(state);
      return;
    }

    this._armRoot(state, /* isRearm */ true);
  }

  /**
   * Watch a single root directory for changes.
   * On change: invalidate the index (next getIndex() will re-scan).
   *
   * Every error is caught here — both a synchronous throw at arm-time
   * (`this.#fsDeps.watch(...)`) and an error thrown while iterating (AC1/AC2).
   * A disappearing root closes the watcher cleanly: the debounce timer is
   * cleared and the async iterator ends (AC3) — no process exit, no hang.
   *
   * @param {string} root
   * @param {AbortSignal} signal
   * @param {() => void} [onArmed]  Called synchronously right after a
   *   successful `fsDeps.watch()` call (before the async iterator is consumed).
   * @param {() => void} [onEvent]  Called for every raw fs event (undebounced),
   *   in ADDITION to the default debounced index-invalidation. Used by the
   *   flat meta-watch to resync repo subtree watchers (AC9/AC10). Errors
   *   thrown by `onEvent` are swallowed (AC1 discipline).
   * @param {boolean} [flat]  When true, watches non-recursively (meta-watch,
   *   top-level only — AC9 Scope-Verengung) and does NOT invalidate the index
   *   itself (only subtree watches are index-relevant, AC10).
   * @returns {Promise<{armed: boolean, aborted: boolean}>}
   *   `armed` — whether `fsDeps.watch()` succeeded (constructed an iterator).
   *   `aborted` — whether the loop ended via the expected AbortError from
   *   `stopWatchers()` (clean stop, no re-arm).
   */
  async _watchRoot(root, signal, onArmed, onEvent, flat = false) {
    let watcher;
    try {
      watcher = this.#fsDeps.watch(root, { recursive: !flat, signal });
    } catch (err) {
      if (err && err.name === 'AbortError') return { armed: false, aborted: true };
      this._logWatchIssue(root, err, 'Bewaffnung fehlgeschlagen');
      return { armed: false, aborted: false };
    }

    if (typeof onArmed === 'function') onArmed();

    let debounceTimer = null;
    try {
      for await (const fsEvent of watcher) {
        void fsEvent; // consume event — only the change signal matters
        if (typeof onEvent === 'function') {
          try {
            onEvent();
          } catch {
            /* defensiv — AC1: kein Watcher-Fehlerpfad eskaliert */
          }
        }
        if (flat) continue; // Meta-Watch invalidiert den Index nicht selbst (AC10)
        // Invalidate index — will be re-scanned on next getIndex()
        if (debounceTimer !== null) this.#fsDeps.clearTimeout(debounceTimer);
        debounceTimer = this.#fsDeps.setTimeout(() => {
          this.#index = null;
          this.#standardIndex = null;
          debounceTimer = null;
        }, WATCH_DEBOUNCE_MS);
      }
      // Iterator ended without throwing (e.g. a finite test double) — treat like
      // a disappearance: close cleanly, let the caller decide on re-arm (AC3).
      return { armed: true, aborted: false };
    } catch (err) {
      // AbortError is the expected, clean stop from stopWatchers() (AC5). Any
      // other error (ENOENT/scandir on a disappearing root, or a generic error
      // without a `code`) is re-armable — never rethrown to the process (AC2).
      // This ALSO covers an internal FSWatcher 'error' event surfaced through
      // the async-iterator boundary (AC8) — see class-level doc for why this
      // alone was insufficient before the V2 scope narrowing (AC9) removed the
      // churn-prone subtrees from ever being watched in the first place.
      if (err && err.name === 'AbortError') {
        return { armed: true, aborted: true };
      }
      this._logWatchIssue(root, err, 'Watcher beendet');
      return { armed: true, aborted: false };
    } finally {
      if (debounceTimer !== null) this.#fsDeps.clearTimeout(debounceTimer);
    }
  }

  /**
   * Knapp, secret-freies Logging für Watcher-Fehler (NFR Beobachtbarkeit).
   * Wird nur je tatsächlichem Fehler-/Beendigungs-Ereignis aufgerufen — nicht
   * pro Backoff-Tick — um einen Log-Sturm zu vermeiden.
   *
   * @param {string} root
   * @param {unknown} err
   * @param {string} context
   * @returns {void}
   */
  _logWatchIssue(root, err, context) {
    const code = err && err.code ? ` (${err.code})` : '';
    const message = err && err.message ? err.message : String(err);
    console.warn(`[BoardAggregator] Watcher ${context} für "${root}"${code}: ${message}`);
  }

  /**
   * Stop all active filesystem watchers — including any pending backoff/re-arm
   * timers (AC5). After this call, no further `watch()` call and no re-arm
   * happens for any previously started root.
   * @returns {void}
   */
  stopWatchers() {
    // S-320 Review-Finding #2 (Iteration 2, AC5): globaler Stop-Flag zuerst
    // setzen — jede noch laufende `_syncRepoWatchersOnce()`-Kette (verkettet
    // über `#syncInFlight`, mit `await`-Punkten hinter denen wir hier keine
    // Sichtbarkeit haben) prüft ihn vor jedem State-Push/`_armRoot()`-Aufruf
    // und bricht dann still ab, statt einen frischen Watcher zu bewaffnen.
    this.#allStopped = true;
    for (const state of this.#watchers) {
      state.stopped = true;
      if (state.rearmTimerId !== null) {
        this.#fsDeps.clearTimeout(state.rearmTimerId);
        state.rearmTimerId = null;
      }
      try { state.ac.abort(); } catch { /* ignore */ }
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
 *   features: FeatureEntry[],
 *   areas: AreaEntry[],
 *   runs: RunEntry[]
 * }} ProjectEntry
 *
 * @typedef {{
 *   slug: string,
 *   repo_path: string,
 *   error: string,
 *   features: [],
 *   areas: [],
 *   runs: []
 * }} ErrorEntry
 *
 * @typedef {{
 *   feature: string,
 *   phase: string|null,
 *   currentStory: string|null,
 *   done: number|null,
 *   total: number|null,
 *   round: number|null,
 *   startedAt: string|null,
 *   lastError: string|null,
 *   isLastRun: boolean
 * }} RunEntry
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
 *   archived: boolean,
 *   archived_at: string|null,
 *   area: string|null,
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
 *   updated_at: string|null,
 *   done_at: string|null,
 *   branch: string|null,
 *   pr: string|null,
 *   archived: boolean,
 *   archived_at: string|null,
 *   area: string|null,
 *   ready: boolean,
 *   ready_reason: string|null
 * }} StoryEntry
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   order: number,
 *   description: string|null,
 *   storyCount: number
 * }} AreaEntry
 */
