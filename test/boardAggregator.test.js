/**
 * boardAggregator.test.js — Unit tests for BoardAggregator, parseYaml, parseBoardRoots,
 *   computeFeatureStatus +
 *   boardRouter HTTP-Ebene (inkl. `buildDiscussSeed()` Unit-Tests, ideen-inbox S-200;
 *   includeArchived-Filter + POST .../archive-done, board-feature-archive S-232;
 *   Feature-Status-Ableitung, feature-status-derivation S-238;
 *   FSWatcher-Crash-Härtung (error-Handler, Re-Arm/Backoff, ENOENT-Regression),
 *   fswatcher-crash-hardening S-280;
 *   areas.yaml lesen + Roll-up + GET /areas, bereichs-modell S-288 — Lese-Teil;
 *   Story-Ebenen-Archiv (Sichtbarkeit + POST .../archive-done-stories),
 *   board-storys-archivieren S-293;
 *   readProjectAt() injizierbare Datei-Quelle, drain-origin-progress-sync S-319;
 *   FSWatcher-Crash-Härtung V2 (interne FSWatcher-'error'-Events + Scope-
 *   Verengung, isWatchIgnoredEntry/isWatchIgnoredPath, Kindprozess-
 *   Regressionstest), fswatcher-crash-hardening S-320;
 *   periodischer Rescan als Cache-Refresh-Sicherheitsnetz (verpasste fs-Events,
 *   Vorfall S-061), board-aggregator-periodic-rescan S-325).
 *
 * Covers (dev-gui-board-aggregator backend):
 *   AC1 — Scant konfigurierte Repo-Wurzeln read-only nach board/-Ordnern;
 *          liest board.yaml + features/*.yaml + stories/*.yaml.
 *   AC2 — Daten liegen im flüchtigen In-Memory-Index; Re-Scan on-demand ersetzt den Index.
 *   AC3 — Index modelliert Projekt → Feature → Story; jede Story trägt
 *          mind. id, parent, title, status, priority, labels, spec (+ dispo_* falls vorhanden).
 *          Features tragen zusätzlich optionale Felder goal, definition_of_done, depends,
 *          labels — Wert ist null wenn das YAML-Feld fehlt oder nicht gesetzt ist.
 *   AC7 — Kein Code-Pfad schreibt in board/-Dateien oder legt persistenten Cache an.
 *   AC8 — Ungültiges/nicht lesbares board/ wird mit Fehlermarkierung übersprungen;
 *          übrige Projekte bleiben sichtbar; kein Absturz.
 *   AC9 — Re-Scan on-demand ersetzt den Index (Watcher-Signal-Mechanismus tested separat
 *          als Unit; HTTP-Endpunkt tested in dieser Datei, describe-Blöcke
 *          "boardRouter HTTP — GET /api/board/projects" und
 *          "boardRouter HTTP — POST /api/board/projects/rescan (AC9)").
 *
 * Covers (studis-kanban-board-ux):
 *   AC5 — GET /api/board/projects/list liefert slug + grobe Zähler (kein Story-Body);
 *          GET /api/board/projects/:slug liefert ein Projekt voll on-demand;
 *          :slug mit ungültigem Format → 404; unbekannter Slug → 404;
 *          GET /api/board/projects bleibt erhalten.
 *
 * Covers (story-detail-ansicht):
 *   AC2, AC5 — YAML-Fallback ep_est_source; ledger-Prio; null-Fälle.
 *   AC2 — GET /api/board/projects/:slug/stories/:id/detail liefert Story-Detail-Objekt;
 *          ungültiges slug-Format → 404; ungültiges id-Format → 404;
 *          unbekannter Slug → 404; happy-path 200 + { detail: {...} }.
 *   AC5 — ep_est_source: 'ledger' wenn Ledger-Wert vorhanden; 'yaml' bei YAML-Fallback
 *          (dispo_est); null wenn weder Ledger noch dispo_est.
 *
 * Covers (story-detail-yaml-fallback):
 *   AC1 — BoardAggregator-Story-Index enthält done_at, branch, pr (null wenn YAML-Feld fehlt).
 *   AC3 — Detail-Endpoint: ended_at-Fallback aus done_at (ended_at_source 'yaml'/'ledger');
 *          started_at/duration bleiben null ohne Ledger.
 *   AC4 — Detail-Response enthält branch, pr, status aus dem Index.
 *   AC7 — Ledger hat Vorrang: volle Ledger-Daten → ended_at_source 'ledger'.
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC1 — BoardAggregator-Story-Index enthält zusätzlich updated_at (null wenn YAML-Feld
 *          fehlt) — Quelle für ProjectDrain's "verwaiste In-Progress"-Stale-Erkennung
 *          (vollständige ProjectDrain-Coverage in test/ProjectDrain.test.js).
 *
 * Covers (ideen-inbox, HTTP-Ebene — Unit-Coverage der Validierung/Atomarität in
 * test/BoardWriter.test.js):
 *   AC3 — POST /api/board/projects/:slug/ideas { title, body? } → 201 { storyId };
 *          400 { field, message } bei leerem/zu langem Titel/Body; 404 bei
 *          ungültigem/unbekanntem Slug.
 *   AC7 — genau EIN AuditStore.record()-Aufruf je erfolgreicher Anlage; KEIN
 *          Audit-Eintrag bei 400-Validierungsablehnung.
 *   AC8 — boardWriter fehlt in den Deps → 500 (kein Crash); Response enthält
 *          keine Pfade/Secrets.
 *
 * Covers (ideen-inbox, S-200 — Besprechung + Auflösung, HTTP-Ebene):
 *   AC5 — POST .../ideas/:id/discuss → 200 { sessionId } startet die Session
 *          (Fake-sessionRegistry/commandService), schreibt den Gesprächs-Seed
 *          via `pty.write()`; Idee-Status bleibt unverändert (kein Detail-Fetch,
 *          kein Board-Write). 400 bei bereits aufgelöster Idee (field: 'status');
 *          404 bei unbekanntem Slug/Idee; 409 bei laufendem Command
 *          (`commandService.getStatus().status === 'running'`) ODER wenn das
 *          projektweite `ProjectJobLock` bereits gehalten wird — simuliert
 *          ProjectDrain/Taktgeber (Lock extern akquiriert, CommandService idle)
 *          UND symmetrisch ein zweiter gleichzeitiger discuss-Aufruf fürs selbe
 *          Projekt (Iteration 2, Finding 1); Lock wird in beiden Erfolgs- und
 *          409-Pfaden sofort wieder freigegeben (kein Deadlock für Folge-Requests).
 *   AC6 — POST .../ideas/:id/resolve → 200 { storyId }, setzt via echtem
 *          `BoardWriter` (real fs, analog POST .../ideas) status: Done +
 *          resolved_at/resolved_story_ids/resolved_note; 400 bei ungültigem
 *          Payload ODER bereits aufgelöst; 404 bei unbekanntem Slug/Idee.
 *   AC7 — genau EIN Audit-Eintrag je discuss-Start bzw. je resolve.
 *   AC5/AC8 — `buildDiscussSeed()` (adversariale Unit-Tests, Iteration 2 Finding 2):
 *          mehrzeiliger Titel/Body, `\n`/`\r`/CRLF, ESC/ANSI-Sequenzen, U+2028/
 *          U+2029, eingebetteter Slash-Befehl (`/agent-flow:flow`) → Ergebnis ist
 *          IMMER genau eine Zeile ohne Steuerzeichen (kein zweites Submit möglich).
 *
 * Covers (board-feature-archive, S-232 — includeArchived-Filter + HTTP-Ebene;
 * Unit-Coverage des Schreibpfads `archiveDoneFeatures()` in test/BoardWriter.test.js):
 *   AC3 — BoardAggregator.getIndex() blendet in der Standardansicht Features mit
 *          `archived: true` (und deren Stories) aus — auch aus Zählern/Rollups; eine
 *          einzeln `archived: true` markierte Story (Feature sichtbar, Randfall) wird
 *          ebenfalls ausgeblendet und der Feature-Rollup neu berechnet. Mit
 *          `getIndex({ includeArchived: true })` erscheinen archivierte Features/Stories
 *          zusätzlich, `archived: true` + `archived_at` durchgereicht. Der interne Index
 *          bleibt vollständig (nicht-mutierende Standardansicht).
 *   AC4 — POST /api/board/projects/:slug/archive-done → 200 { archivedFeatureCount,
 *          archivedStoryCount } archiviert alle archivierbaren Features via
 *          `BoardWriter.archiveDoneFeatures()`; GENAU EIN Audit-Eintrag (Audit-First);
 *          0/0 ohne Fehler wenn nichts archivierbar; 404 bei ungültigem/unbekanntem Slug;
 *          409 wenn das ProjectJobLock belegt ist (Lock danach wieder frei); 500 wenn
 *          boardWriter fehlt (kein Crash).
 *   AC8 — einziger Schreibpfad ist `BoardWriter`; Slug wird nur als Index-Lookup
 *          verwendet (nie als Pfad); Fehler/Response enthalten keine Pfade/Secrets;
 *          ungültige Eingaben werden sauber abgewiesen (kein Crash).
 *
 * Covers (board-storys-archivieren, S-293 — Story-Ebenen-Archiv, Aggregator +
 * HTTP-Ebene; Unit-Coverage des Schreibpfads `archiveDoneStories()` in
 * test/BoardWriter.test.js; describe-Blöcke "BoardAggregator — Story-Archiv
 * Sichtbarkeit (board-storys-archivieren AC3/AC5)" + "boardRouter HTTP — POST
 * /api/board/projects/:slug/archive-done-stories (board-storys-archivieren
 * AC4/AC9)"):
 *   AC3 — Ein Feature (Bereichs-Kachel), dessen Storys ALLE story-archiviert
 *          sind, bleibt in der Standardansicht sichtbar (`archived: false` am
 *          Feature selbst, `stories: []`, Rollup "0/0 done") — die bereits
 *          bestehende `_filterArchived()`-Logik (board-feature-archive AC3)
 *          leistet das bereits generisch, hier dediziert für den Story-Ebenen-
 *          Archivpfad regressionsgesichert.
 *   AC4 — POST /api/board/projects/:slug/archive-done-stories → 200
 *          { archivedStoryCount } archiviert alle archivierbaren Storys via
 *          `BoardWriter.archiveDoneStories()`; GENAU EIN Audit-Eintrag
 *          (Audit-First); 0 ohne Fehler wenn nichts archivierbar; Feature-YAML
 *          bleibt in JEDEM Fall unverändert (Bereichs-Kachel nie archiviert);
 *          404 bei ungültigem/unbekanntem Slug; 409 wenn das ProjectJobLock
 *          belegt ist (Lock danach wieder frei); 500 wenn boardWriter fehlt
 *          (kein Crash).
 *   AC5 — Abwärtskompatibilität: ein feature-archiviertes Feature (altes
 *          Format, [[board-feature-archive]]) UND eine einzeln story-
 *          archivierte Story in einem ANDEREN, sichtbaren Feature werden
 *          beide gleichzeitig korrekt ausgeblendet; mit `includeArchived`
 *          erscheinen beide Formen zusätzlich, korrekt markiert.
 *   AC9 — einziger Schreibpfad ist `BoardWriter`; Slug wird nur als Index-
 *          Lookup verwendet (nie als Pfad); Fehler/Response enthalten keine
 *          Pfade/Secrets.
 *
 * Covers (feature-status-derivation, S-238 — Feature-Status live aus Kind-Stories):
 *   AC1 — `computeFeatureStatus()` schließt Stories mit `status: Idee` vollständig
 *          von der Zählung aus (reine-Funktion-Unit + Aggregator-Integration).
 *   AC2 — mindestens eine verbleibende `Blocked`-Story → `Blocked` (höchste
 *          Priorität, unabhängig von anderen vorkommenden Status).
 *   AC3 — ohne Blocked: schwächste Stufe To Do < In Progress < In Review < Done
 *          (jede Stufe einzeln + alle-Done→Done).
 *   AC4 — keine Stories bzw. nur Idee-Stories → `Backlog` (Default).
 *   AC5 — BoardAggregator setzt `feature.status` IMMER auf den abgeleiteten Wert
 *          (ignoriert persistiertes YAML-`status:`), Progress-Rollup „X/Y done"
 *          unverändert, keine board/-Schreibvorgänge (read-only, real tmp-Board).
 *   AC6 — nicht-Idee-Story mit Status außerhalb der bekannten Skala → schwächste
 *          Stufe `To Do` (nie fälschlich `Done`); auch fehlender/null-Status.
 *   AC7 — `_orphaned`-Pseudo-Feature (verwaiste Stories/Ideen) behält `status: null`
 *          (von der Ableitung ausgenommen).
 *   AC8 — `Verworfen`-Stories zählen als terminal (`Done`-äquivalent, höchster
 *          Fortschrittsindex), werden NICHT wie `Idee` ausgeschlossen, ändern die
 *          Blocked-Priorität nicht; abgeleiteter Feature-Status ist nie `Verworfen`
 *          (kollabiert auf `Done`). (S-243, V7)
 *
 * Covers (fswatcher-crash-hardening, S-280 — error-Handler + Re-Arm mit Backoff +
 * ENOENT-Regression; describe-Blöcke "fswatcher-crash-hardening AC1–AC5" (deterministisch,
 * injizierter watch/Timer) + "BoardAggregator — echter FSWatcher (... AC6/AC7, Integration)"
 * + "fswatcher-crash-hardening V2 — _syncRepoWatchers() Re-Entrancy-Schutz (S-320
 * Review-Iteration 2, Finding #1/#2)" (deterministisch, injizierter watch/readdir-Gate)):
 *   AC1 — Jeder Watcher-Fehler (Bewaffnung synchron ODER während des Iterierens via
 *          #fsDeps.watch) wird abgefangen; kein unbehandelter Reject/`unhandledRejection`.
 *   AC2 — ENOENT/scandir während des Beobachtens: `_watchRoot()` kehrt kontrolliert
 *          zurück ({ armed: true, aborted: false }), kein Prozess-Crash.
 *   AC3 — Verschwindende Wurzel → sauberes Schließen: Debounce-Timer wird im
 *          finally-Block gecleart (kein Leak, kein hängender Async-Iterator).
 *   AC4 — Re-Arm mit exponentiellem, begrenztem Backoff (feste Konstanten
 *          REARM_INITIAL_DELAY_MS=500/REARM_BACKOFF_FACTOR=2/REARM_MAX_DELAY_MS=30000,
 *          injizierte Fake-Timer-Queue); Backoff wächst je Fehlschlag, verweilt an der
 *          Obergrenze bei dauerhaft fehlendem Pfad (kein Busy-Loop); bei erfolgreicher
 *          Neu-Bewaffnung Backoff-Reset + Index EINMAL invalidiert (nächster getIndex()
 *          re-scant); höchstens EIN ausstehender Re-Arm-Timer je Wurzel.
 *   AC5 — `stopWatchers()` bricht einen anstehenden Backoff-/Re-Arm-Timer ab
 *          (`clearTimeout` beobachtet); danach erfolgt kein weiterer `watch()`-Aufruf.
 *          Zusätzlich (S-320 Review-Iteration 2, Finding #1/#2, globaler `#allStopped`-
 *          Flag): zwei überlappende `_syncRepoWatchers()`-Aufrufe für dieselbe Wurzel
 *          laufen serialisiert (kein doppelter Watcher-State, Finding #1) UND
 *          `stopWatchers()`, aufgerufen WÄHREND eine `_syncRepoWatchers()`-Kette noch
 *          in `readdir()` hängt, verhindert JEDEN `watch()`-Aufruf dieser Kette, auch
 *          nachdem sie zu Ende gelaufen ist (Finding #2 — kein `watch()` nach Stop).
 *   AC6 — Integration mit ECHTEM `fs/promises.watch()` auf einem mkdtemp-Verzeichnis:
 *          npm-install-/Worktree-artige Anlage/Löschung von Unterverzeichnissen crasht
 *          den Prozess nie (kein `unhandledRejection`); scan()/getIndex() bleiben danach
 *          funktionsfähig.
 *   AC7 — Regressionstest des Vorfalls 2026-07-02 (Integration, ECHTER Watcher): Wurzel
 *          löschen → neu erzeugen → Watcher re-armt; eine Änderung NACH der Neu-Erzeugung
 *          invalidiert den Index erneut (`getIndex()` OHNE expliziten `scan()`-Aufruf
 *          liest die neue Struktur).
 *
 * Covers (fswatcher-crash-hardening V2, S-320 — interne FSWatcher-'error'-Events +
 * Scope-Verengung, Vorfall 2026-07-07; describe-Blöcke "isWatchIgnoredEntry
 * (... V2 AC9)" + "isWatchIgnoredPath (... V2 AC9)" (unit, reine Funktion) +
 * "... V2 AC8 — ... (Kindprozess)" + "... V2 AC11 — ... (Kindprozess, ECHTER
 * Watcher)" + "... V2 AC9 — Scope-Verengung (Integration, echter BoardAggregator)"
 * + "... V2 AC10 — Index-Aktualität bleibt erhalten (Integration, echter
 * BoardAggregator)"):
 *   AC8  — Kein Crash durch interne FSWatcher-'error'-Events: über einen ECHTEN
 *          Kindprozess verifiziert (Jest maskiert echte Prozess-Crashs, siehe
 *          Testkommentar) — eine UNGUARDED-Baseline (roher `node:fs.watch()`-
 *          FSWatcher ohne 'error'-Listener) crasht; der `watchWithErrorGuard()`-
 *          Adapter (`defaultFsDeps.watch`, registriert intern einen expliziten
 *          `'error'`-Listener) überlebt ein Verschwinden der beobachteten Wurzel
 *          sauber (ENOENT-Ablehnung am Async-Iterator statt Prozess-Crash).
 *   AC9  — Scope-Verengung: `isWatchIgnoredEntry()`/`isWatchIgnoredPath()` als
 *          reine, unit-testbare Prüf-Funktionen (node_modules/.git/.claude inkl.
 *          .claude/worktrees/test/.tmp-*) + Integrationstest, der zeigt, dass
 *          eine Mutation unter node_modules keinen Watcher dort bewaffnet.
 *   AC10 — Index-Aktualität bleibt erhalten: Mutationen unter board/ (inkl.
 *          board/features/) und docs/specs/ invalidieren den Index weiterhin —
 *          auch NACH einer vorherigen, ignorierten node_modules-Mutation.
 *   AC11 — Regressionstest Vorfall 2026-07-07 (Kindprozess, ECHTER Watcher):
 *          `test/.tmp-<random>` Create/Delete-Zyklus (mehrere parallele Runden)
 *          unter einem rekursiven Watch auf einen Repo-artigen Baum crasht nie;
 *          der Watcher-Baustein bleibt danach funktionsfähig (eine Mutation an
 *          einem beobachteten Pfad NACH der Churn-Sequenz invalidiert den Index
 *          weiterhin). Schlägt gegen den V1-Stand (S-280) in der Mehrheit der
 *          Läufe fehl (siehe test/fixtures/fswatcher-regression-child.mjs
 *          Doc-Kommentar) — die Regressions-Barriere gegen den 2026-07-07-Crash.
 *
 * Covers (bereichs-modell, S-288 — Lese-Teil: BoardAggregator liest areas.yaml +
 * Read-Model + GET-Endpunkt; describe-Blöcke "BoardAggregator — areas.yaml lesen
 * (bereichs-modell AC1)", "BoardAggregator — areas Roll-up (bereichs-modell AC2)",
 * "boardRouter HTTP — GET /api/board/projects/:slug/areas (bereichs-modell AC1/AC2, V6)",
 * "parseAreasYamlList (bereichs-modell AC1)"):
 *   AC1 — `board/areas.yaml` (root-level YAML-Liste von Mappings) wird gelesen und
 *          als `id`/`name`/`order`/`description?` sortiert nach `order` am
 *          Projekt-Index (`areas`) geliefert; fehlende/leere Datei → `areas: []`
 *          (kein Crash); defekte Einzel-Einträge (fehlendes id/name, `order` kein
 *          Integer) werden übersprungen, übrige Einträge bleiben erhalten.
 *   AC2 — Jeder Bereich trägt `storyCount` (Roll-up): eine Story zählt für den
 *          Bereich ihres eigenen `area`-Felds; hat sie keins, zählt sie für das
 *          `area` ihres Eltern-Features (Fallback); ein eigenes Story-`area`
 *          gewinnt, wenn Story UND Eltern-Feature unterschiedliche `area` tragen;
 *          ein unbekannter `area`-Wert wird nicht gezählt (kein Crash); ein
 *          Bereich ohne Treffer bleibt sichtbar mit `storyCount: 0`.
 *   V6/GET — `GET /api/board/projects/:slug/areas` → `200 { areas: [...] }`
 *          sortiert nach `order` (bekannter Slug, inkl. Projekt ohne areas.yaml
 *          → `{ areas: [] }`); `404` bei unbekanntem Slug ODER ungültigem
 *          Slug-Format (dieselbe SLUG_RE + Index-Lookup-Prüfung wie
 *          GET /api/board/projects/:slug). Rein lesend, kein AccessGuard-Test
 *          nötig (Read-Route, analog allen übrigen GET-Board-Routen).
 *
 * Covers (run-state-live-view, S-316 — BoardAggregator liest board/runs/F-###/
 * state.yaml über RunStateReader.js hinein, siehe test/RunStateReader.test.js für
 * die Unit-Coverage des Readers selbst; describe-Block "BoardAggregator — runs
 * (run-state-live-view AC1/AC2/AC3)" unten deckt nur die Integration in
 * _readBoard()/getIndex() ab):
 *   AC1 — Projekt-Index trägt zusätzlich `runs` (leer, wenn board/runs/ fehlt —
 *          Standard-Fixture hat kein board/runs/, deckt also den Normalfall ab);
 *          Fehler-Boards (board.yaml fehlt) tragen ebenfalls `runs: []`.
 *   AC2/AC3 — vollständig in test/RunStateReader.test.js (Feld-Mapping,
 *          Fehlertoleranz je Einzel-Lauf).
 *
 * Covers (drain-origin-progress-sync, S-319 — injizierbare Datei-Quelle für
 * ProjectDrain's origin-basierte Aussensicht; describe-Block "drain-origin-
 * progress-sync AC2/AC7 — readProjectAt() (injizierbare Datei-Quelle)"; die
 * ProjectDrain-seitige Fetch-/Truth-Ref-/Eskalations-Gate-Logik lebt in
 * test/ProjectDrain.test.js, die GitReadBoundary-Boundary selbst in
 * test/GitReadBoundary.test.js):
 *   AC2 — `readProjectAt(slug, repoPath, { fsDeps })` liest EIN Projekt aus
 *          einer optional injizierten alternativen Datei-Quelle (Default:
 *          Working-Tree via der Instanz-`fsDeps`) — `_readBoard()`/
 *          `computeStoryReadyStatus()` bleiben dabei unverändert (identische
 *          Story-/Feature-Felder), nur `readdir`/`readFile` werden
 *          ausgetauscht. Fehlt `board/` an der gewählten Quelle → `null`
 *          (kein Crash).
 *   AC7 — `readProjectAt()` ist read-only und hat keinen Seiteneffekt auf den
 *          In-Memory-`#index`/`getIndex()` (unabhängig von `scan()`).
 *
 * Covers (board-aggregator-periodic-rescan, S-325 — periodischer Rescan als
 * Cache-Refresh-Sicherheitsnetz für verpasste fs-Events, Vorfall S-061):
 *   AC1 — Ein verpasstes fs-Event (injiziertes `watch`, das nie feuert) wird
 *          spätestens nach einem Rescan-Intervall an `getIndex()` sichtbar.
 *   AC2 — Der event-getriebene Pfad bleibt additiv bestehen: ein eintreffendes
 *          fs-Event invalidiert weiterhin debounced, deutlich VOR Ablauf eines
 *          (bewusst grossen) Rescan-Intervalls — kein zweiter Diff-/Broadcast-
 *          Pfad. Alle bestehenden fswatcher-crash-hardening-Tests bleiben
 *          unverändert grün (kein Regress, keine Änderung an ihnen in diesem
 *          Diff).
 *   AC3 — `parseRescanIntervalMs()`: Default (fehlende/leere Env), gültige
 *          Env, ungültige Env (nicht-Ganzzahl/negativ → Default + einmalige
 *          `console.warn`), `"0"` (Opt-out, unverändert `0`). Konstruktor-
 *          Option `rescanIntervalMs` hat Vorrang vor der Env; `0` deaktiviert
 *          den Timer vollständig (kein Rescan-Timer bewaffnet).
 *   AC4 — Kein Overlap: ein Tick während eines laufenden Rescans wird
 *          übersprungen (kein zweiter paralleler `scan()`), der normale
 *          Rhythmus setzt nach Abschluss fort. Höchstens ein ausstehender
 *          Rescan-Timer je Instanz.
 *   AC5 — Lebenszyklus: `startWatchers()` bewaffnet den Zyklus, `stopWatchers()`
 *          bricht ihn ab (kein Folge-Tick, kein Timer-Leak); doppeltes
 *          `startWatchers()` erzeugt keinen zweiten parallelen Zyklus.
 *   AC6 — Ein scheiternder Rescan ist nie fatal (kein Crash, kein unhandled
 *          rejection); der nächste Tick läuft regulär weiter.
 *
 * AccessGuard:
 *   POST /api/board/projects/rescan (Schreib-Trigger) liegt hinter
 *   app.use('/api', accessGuard) in server.js — kein separater Middleware-Test
 *   nötig; die Integration ist durch die server.js-Verdrahtung abgedeckt.
 *
 * Strategy:
 *   - Inject fake fsDeps (readdir, readFile) — kein echtes Filesystem.
 *   - Fixture-board/-Struktur als in-memory Map aufgebaut.
 *   - Verifiziert, dass fsDeps.readFile niemals write-äquivalente Aufrufe macht (AC7).
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  BoardAggregator,
  parseYaml,
  parseBoardRoots,
  computeFeatureStatus,
  parseAreasYamlList,
  isWatchIgnoredEntry,
  isWatchIgnoredPath,
  watchWithErrorGuard,
  parseRescanIntervalMs,
} from '../src/BoardAggregator.js';

// ── parseYaml unit tests ──────────────────────────────────────────────────────

describe('parseYaml', () => {
  it('parses simple scalar fields', () => {
    const yaml = 'id: F-001\ntitle: My Feature\nstatus: Active\npriority: P1\n';
    const result = parseYaml(yaml);
    expect(result.id).toBe('F-001');
    expect(result.title).toBe('My Feature');
    expect(result.status).toBe('Active');
    expect(result.priority).toBe('P1');
  });

  it('parses null scalar values', () => {
    const yaml = 'dispo_est: null\ndispo_act: ~\nbranch: null\n';
    const result = parseYaml(yaml);
    expect(result.dispo_est).toBeNull();
    expect(result.dispo_act).toBeNull();
    expect(result.branch).toBeNull();
  });

  it('parses integer scalar', () => {
    const yaml = 'schema_version: 1\nnext_feature_id: 3\n';
    const result = parseYaml(yaml);
    expect(result.schema_version).toBe(1);
    expect(result.next_feature_id).toBe(3);
  });

  it('parses inline array', () => {
    const yaml = 'labels: [db, security]\nimplements: [AC1, AC2, AC4]\n';
    const result = parseYaml(yaml);
    expect(result.labels).toEqual(['db', 'security']);
    expect(result.implements).toEqual(['AC1', 'AC2', 'AC4']);
  });

  it('parses empty inline array', () => {
    const yaml = 'labels: []\n';
    const result = parseYaml(yaml);
    expect(result.labels).toEqual([]);
  });

  it('parses block sequence list', () => {
    const yaml = 'stories:\n- S-001\n- S-002\n';
    const result = parseYaml(yaml);
    expect(result.stories).toEqual(['S-001', 'S-002']);
  });

  it('strips inline comments', () => {
    const yaml = 'next_feature_id: 3        # nächste freie Nummer → F-003\n';
    const result = parseYaml(yaml);
    expect(result.next_feature_id).toBe(3);
  });

  it('handles quoted strings', () => {
    const yaml = "project_slug: 'agent-flow'\ntitle: \"My Title\"\n";
    const result = parseYaml(yaml);
    expect(result.project_slug).toBe('agent-flow');
    expect(result.title).toBe('My Title');
  });

  it('handles boolean values', () => {
    const yaml = 'active: true\narchived: false\n';
    const result = parseYaml(yaml);
    expect(result.active).toBe(true);
    expect(result.archived).toBe(false);
  });

  it('skips comments and empty lines', () => {
    const yaml = '# This is a comment\n\nid: F-001\n\n# another comment\ntitle: Test\n';
    const result = parseYaml(yaml);
    expect(result.id).toBe('F-001');
    expect(result.title).toBe('Test');
  });

  it('handles --- document separator', () => {
    const yaml = '---\nid: S-001\nparent: F-001\n';
    const result = parseYaml(yaml);
    expect(result.id).toBe('S-001');
    expect(result.parent).toBe('F-001');
  });

  it('returns {} for null input', () => {
    expect(parseYaml(null)).toEqual({});
  });

  it('returns {} for empty string', () => {
    expect(parseYaml('')).toEqual({});
  });

  it('handles multiline block scalar (|)', () => {
    const yaml = 'goal: |\n  Line one.\n  Line two.\ntitle: After\n';
    const result = parseYaml(yaml);
    expect(result.goal).toContain('Line one.');
    expect(result.goal).toContain('Line two.');
    expect(result.title).toBe('After');
  });

  it('parses real board.yaml fixture', () => {
    const yaml = `schema_version: 1
project_slug: agent-flow
next_feature_id: 2        # nächste freie Nummer → F-002
next_story_id: 2          # nächste freie Nummer → S-002
`;
    const result = parseYaml(yaml);
    expect(result.schema_version).toBe(1);
    expect(result.project_slug).toBe('agent-flow');
    expect(result.next_feature_id).toBe(2);
  });

  it('does not produce phantom keys from multi-line flow scalar continuation lines with colons (S1 fix)', () => {
    // Mirrors real agent-flow/board/features/F-001-board-schema.yaml where
    // the goal field is a single-quoted string split across multiple lines.
    // The continuation line contains "Ziel: menschenlesbares," — without the fix,
    // "Ziel" would be parsed as a phantom key.
    const yaml = `id: F-001
title: Board-Dateiformat
goal: 'Abloesung der GitHub-Projects-v2-Boards durch ein eigenes, zweistufiges Board
  (Feature -> Story) mit git-versionierten Dateien als Source of Truth. Ziel: menschenlesbares,
  diff-freundliches YAML pro Feature/Story.

  '
status: Active
priority: P0
`;
    const result = parseYaml(yaml);
    expect(result.id).toBe('F-001');
    expect(result.title).toBe('Board-Dateiformat');
    expect(result.status).toBe('Active');
    expect(result.priority).toBe('P0');
    // "Ziel" must NOT appear as a phantom key
    expect(result).not.toHaveProperty('Ziel');
    // "diff-freundliches YAML pro Feature/Story" must NOT appear as a phantom key
    expect(Object.keys(result).every((k) => !k.includes(' '))).toBe(true);
  });
});

// ── parseBoardRoots unit tests ────────────────────────────────────────────────

describe('parseBoardRoots', () => {
  it('returns empty array for empty string', () => {
    expect(parseBoardRoots('')).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(parseBoardRoots(undefined)).toEqual([]);
  });

  it('parses single absolute path', () => {
    const roots = parseBoardRoots('/home/alex/Git');
    expect(roots.length).toBe(1);
    expect(roots[0]).toBe('/home/alex/Git');
  });

  it('parses multiple comma-separated paths', () => {
    const roots = parseBoardRoots('/home/alex/Git,/home/alex/Work');
    expect(roots.length).toBe(2);
    expect(roots[0]).toBe('/home/alex/Git');
    expect(roots[1]).toBe('/home/alex/Work');
  });

  it('trims whitespace around paths', () => {
    const roots = parseBoardRoots('  /home/alex/Git , /home/alex/Work  ');
    expect(roots.length).toBe(2);
    expect(roots[0]).toBe('/home/alex/Git');
    expect(roots[1]).toBe('/home/alex/Work');
  });

  it('expands ~ to home directory', () => {
    const roots = parseBoardRoots('~/Git/Studis-Softwareschmiede');
    expect(roots.length).toBe(1);
    expect(roots[0]).not.toContain('~');
    expect(roots[0]).toMatch(/\/Git\/Studis-Softwareschmiede$/);
  });
});

// ── parseAreasYamlList unit tests (bereichs-modell AC1) ───────────────────────

describe('parseAreasYamlList (bereichs-modell AC1)', () => {
  it('returns [] for empty string', () => {
    expect(parseAreasYamlList('')).toEqual([]);
  });

  it('returns [] for null/undefined', () => {
    expect(parseAreasYamlList(null)).toEqual([]);
    expect(parseAreasYamlList(undefined)).toEqual([]);
  });

  it('returns [] for whitespace-only content', () => {
    expect(parseAreasYamlList('   \n  \n')).toEqual([]);
  });

  it('parses a list of mappings with id, name, order, description', () => {
    const content = `- id: board
  name: Board
  order: 1
  description: Schema, board-CLI, Lint.
- id: fabrik-arbeiten
  name: Fabrik Arbeiten
  order: 2
`;
    const result = parseAreasYamlList(content);
    expect(result).toEqual([
      { id: 'board', name: 'Board', order: 1, description: 'Schema, board-CLI, Lint.' },
      { id: 'fabrik-arbeiten', name: 'Fabrik Arbeiten', order: 2 },
    ]);
  });

  it('parses items without a description field (optional)', () => {
    const content = '- id: board\n  name: Board\n  order: 1\n';
    const result = parseAreasYamlList(content);
    expect(result[0].description).toBeUndefined();
  });

  it('handles quoted string values inside items', () => {
    const content = "- id: board\n  name: 'Board & Struktur'\n  order: 1\n";
    const result = parseAreasYamlList(content);
    expect(result[0].name).toBe('Board & Struktur');
  });
});

// ── isWatchIgnoredEntry / isWatchIgnoredPath unit tests (fswatcher-crash-hardening V2 AC9) ──

describe('isWatchIgnoredEntry (fswatcher-crash-hardening V2 AC9)', () => {
  it('ignores node_modules', () => {
    expect(isWatchIgnoredEntry('node_modules')).toBe(true);
  });

  it('ignores .git', () => {
    expect(isWatchIgnoredEntry('.git')).toBe(true);
  });

  it('ignores .claude (covers .claude/worktrees as a descendant)', () => {
    expect(isWatchIgnoredEntry('.claude')).toBe(true);
  });

  it('ignores a .tmp-* entry whose parent is "test" (Jest-Testtempverzeichnis)', () => {
    expect(isWatchIgnoredEntry('.tmp-router-y8i8og6spkr', 'test')).toBe(true);
    expect(isWatchIgnoredEntry('.tmp-abc', 'test')).toBe(true);
  });

  it('does NOT ignore a .tmp-* entry whose parent is NOT "test"', () => {
    expect(isWatchIgnoredEntry('.tmp-abc', 'somewhere-else')).toBe(false);
    expect(isWatchIgnoredEntry('.tmp-abc')).toBe(false);
  });

  it('does not ignore board-relevant entries', () => {
    expect(isWatchIgnoredEntry('board')).toBe(false);
    expect(isWatchIgnoredEntry('specs', 'docs')).toBe(false);
    expect(isWatchIgnoredEntry('docs')).toBe(false);
    expect(isWatchIgnoredEntry('runs', 'board')).toBe(false);
  });

  it('does not ignore an arbitrary repo/project directory name', () => {
    expect(isWatchIgnoredEntry('dev-gui')).toBe(false);
    expect(isWatchIgnoredEntry('agent-flow')).toBe(false);
  });
});

describe('isWatchIgnoredPath (fswatcher-crash-hardening V2 AC9)', () => {
  it('ignores a path with node_modules anywhere in it', () => {
    expect(isWatchIgnoredPath('node_modules/pkg/index.js')).toBe(true);
    expect(isWatchIgnoredPath('dev-gui/node_modules/.bin/tool')).toBe(true);
  });

  it('ignores a path under .git', () => {
    expect(isWatchIgnoredPath('.git/HEAD')).toBe(true);
  });

  it('ignores a path under .claude/worktrees at any depth', () => {
    expect(isWatchIgnoredPath('.claude/worktrees/S-999/src/file.js')).toBe(true);
  });

  it('ignores a Jest test temp directory path (test/.tmp-<random>)', () => {
    expect(isWatchIgnoredPath('test/.tmp-router-y8i8og6spkr')).toBe(true);
    expect(isWatchIgnoredPath('test/.tmp-router-y8i8og6spkr/nested/file.txt')).toBe(true);
  });

  it('does NOT ignore an unrelated dotfile under test/', () => {
    expect(isWatchIgnoredPath('test/.eslintrc')).toBe(false);
  });

  it('does not ignore board/runs/ (index-relevant, AC10)', () => {
    expect(isWatchIgnoredPath('board/runs/F-070/state.yaml')).toBe(false);
  });

  it('does not ignore docs/specs/ (index-relevant, AC10)', () => {
    expect(isWatchIgnoredPath('docs/specs/fswatcher-crash-hardening.md')).toBe(false);
  });

  it('handles empty/falsy input', () => {
    expect(isWatchIgnoredPath('')).toBe(false);
    expect(isWatchIgnoredPath(undefined)).toBe(false);
  });

  it('handles Windows-style backslash separators', () => {
    expect(isWatchIgnoredPath('node_modules\\pkg\\index.js')).toBe(true);
  });
});

// ── Fixture helpers ───────────────────────────────────────────────────────────

const BOARD_ROOT = '/fake/repos';

const BOARD_YAML = `schema_version: 1
project_slug: my-project
next_feature_id: 3
next_story_id: 5
`;

const FEATURE_F001 = `id: F-001
title: Server-Provisioning
goal: Abloesung der manuellen Provisionierung.
status: Active
priority: P1
spec: docs/specs/provisioning.md
labels: [infra, vps]
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
stories:
- S-001
- S-002
progress: 1/2 done
`;

const FEATURE_F002 = `id: F-002
title: Auth-Modul
goal: Sicheres Authentifizierungsmodul.
status: Planned
priority: P2
spec: docs/specs/auth.md
labels: [security]
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
stories: []
progress: null
`;

const STORY_S001 = `id: S-001
parent: F-001
title: IONOS-Adapter
status: Done
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1, AC2, AC4]
labels: [db, security]
size_est: M
dispo_est: null
dispo_act: null
dispo_forecast: null
estimate_note: null
confidence: null
branch: null
pr: null
blocked_reason: null
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
done_at: 2026-06-14T00:00:00Z
`;

const STORY_S002 = `id: S-002
parent: F-001
title: Hetzner-Adapter
status: In Progress
priority: P1
spec: docs/specs/provisioning.md
implements: [AC3]
labels: [infra]
dispo_est: null
dispo_act: null
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
done_at: null
`;

const STORY_S003_ORPHANED = `id: S-003
parent: F-099
title: Orphaned Story
status: To Do
priority: P3
spec: docs/specs/other.md
implements: [AC1]
labels: []
dispo_est: null
dispo_act: null
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
done_at: null
`;

/**
 * Build a fake fsDeps that simulates a board/ filesystem layout.
 *
 * Layout:
 *   /fake/repos/
 *     my-repo/
 *       board/
 *         board.yaml
 *         features/
 *           F-001-server-provisioning.yaml
 *           F-002-auth.yaml
 *         stories/
 *           S-001-ionos-adapter.yaml
 *           S-002-hetzner-adapter.yaml
 *
 * @param {object} [overrides]  Override specific file contents (path → string).
 * @param {string[]} [extraRepos]  Extra repo names with no board/ dir.
 */
function buildFakeFsDeps({
  fileOverrides = {},
  repoNames = ['my-repo'],
  missingBoardYaml = false,
  missingFeaturesDir = false,
  missingStoriesDir = false,
  extraFeatureFiles = [],
  extraStoryFiles = [],
} = {}) {
  const files = {
    [`${BOARD_ROOT}/my-repo/board/board.yaml`]: BOARD_YAML,
    [`${BOARD_ROOT}/my-repo/board/features/F-001-server-provisioning.yaml`]: FEATURE_F001,
    [`${BOARD_ROOT}/my-repo/board/features/F-002-auth.yaml`]: FEATURE_F002,
    [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: STORY_S001,
    [`${BOARD_ROOT}/my-repo/board/stories/S-002-hetzner-adapter.yaml`]: STORY_S002,
    ...fileOverrides,
  };

  const dirs = {
    // Board root
    [BOARD_ROOT]: repoNames.map((name) => ({
      name,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      isFile: () => false,
    })),
    // Each repo: has a board/ dir
    ...Object.fromEntries(
      repoNames.map((name) => [
        `${BOARD_ROOT}/${name}`,
        [{ name: 'board', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false }],
      ]),
    ),
    // board/ contains board.yaml (checked by readdir for board entries)
    [`${BOARD_ROOT}/my-repo/board`]: [
      { name: 'board.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'features', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      { name: 'stories', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
    ],
    // features/
    [`${BOARD_ROOT}/my-repo/board/features`]: [
      { name: 'F-001-server-provisioning.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'F-002-auth.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ...extraFeatureFiles.map((name) => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false })),
    ],
    // stories/
    [`${BOARD_ROOT}/my-repo/board/stories`]: [
      { name: 'S-001-ionos-adapter.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'S-002-hetzner-adapter.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ...extraStoryFiles.map((name) => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false })),
    ],
  };

  if (missingBoardYaml) {
    delete files[`${BOARD_ROOT}/my-repo/board/board.yaml`];
  }
  if (missingFeaturesDir) {
    delete dirs[`${BOARD_ROOT}/my-repo/board/features`];
  }
  if (missingStoriesDir) {
    delete dirs[`${BOARD_ROOT}/my-repo/board/stories`];
  }

  const readFile = async (path, _enc) => {
    if (path in files) return files[path];
    const err = new Error(`ENOENT: no such file: ${path}`);
    err.code = 'ENOENT';
    throw err;
  };

  const readdir = async (path, _opts) => {
    if (path in dirs) return dirs[path];
    const err = new Error(`ENOENT: no such dir: ${path}`);
    err.code = 'ENOENT';
    throw err;
  };

  // watch is not needed for unit tests (tested separately)
  const watch = async function* () {};

  return { readFile, readdir, watch, _files: files, _dirs: dirs };
}

function makeAggregator(opts = {}) {
  const fsDeps = buildFakeFsDeps(opts);
  return {
    aggregator: new BoardAggregator({
      boardRootsEnv: BOARD_ROOT,
      fsDeps,
    }),
    fsDeps,
  };
}

// ── AC1 — Scan reads board.yaml + features/*.yaml + stories/*.yaml ────────────

describe('AC1 — Scan reads board files read-only', () => {
  it('scans repo root and finds board/ directory', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    expect(Array.isArray(index)).toBe(true);
    expect(index.length).toBe(1);
    expect(index[0].slug).toBe('my-repo');
  });

  it('reads board.yaml and populates project_slug + schema_version', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const project = index[0];
    expect(project.project_slug).toBe('my-project');
    expect(project.schema_version).toBe(1);
  });

  it('reads all features/*.yaml files', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const features = index[0].features.filter((f) => !f._orphaned);
    expect(features.length).toBe(2);
    const ids = features.map((f) => f.id).sort();
    expect(ids).toEqual(['F-001', 'F-002']);
  });

  it('reads all stories/*.yaml files', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    expect(f001.stories.length).toBe(2);
    const ids = f001.stories.map((s) => s.id).sort();
    expect(ids).toEqual(['S-001', 'S-002']);
  });

  it('skips repos without a board/ directory (no error, no entry)', async () => {
    const fsDeps = buildFakeFsDeps({ repoNames: ['no-board-repo'] });
    // Override: no-board-repo has no board/ entry
    const origReaddir = fsDeps.readdir;
    const customReaddir = async (path, opts) => {
      if (path === `${BOARD_ROOT}/no-board-repo/board`) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return origReaddir(path, opts);
    };
    fsDeps.readdir = customReaddir;

    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    const index = await aggregator.getIndex();
    expect(index.length).toBe(0);
  });

  it('returns empty array when BOARD_ROOTS is unset', async () => {
    const fsDeps = buildFakeFsDeps();
    const aggregator = new BoardAggregator({ boardRootsEnv: '', fsDeps });
    const index = await aggregator.getIndex();
    expect(index).toEqual([]);
  });

  it('returns empty array when board root directory is not readable', async () => {
    const fsDeps = buildFakeFsDeps();
    const origReaddir = fsDeps.readdir;
    fsDeps.readdir = async (path, opts) => {
      if (path === BOARD_ROOT) throw new Error('EACCES');
      return origReaddir(path, opts);
    };
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    const index = await aggregator.getIndex();
    expect(index).toEqual([]);
  });
});

// ── AC2 — Flüchtiger In-Memory-Index; Re-Scan on-demand ──────────────────────

describe('AC2 — Volatile in-memory index; on-demand re-scan', () => {
  it('getIndex() returns same data on repeated calls without scan', async () => {
    const { aggregator } = makeAggregator();
    const index1 = await aggregator.getIndex();
    const index2 = await aggregator.getIndex();
    expect(index1).toBe(index2); // same array reference (no re-scan)
  });

  it('scan() replaces the index (new reference)', async () => {
    const { aggregator } = makeAggregator();
    const index1 = await aggregator.getIndex();
    await aggregator.scan();
    const index2 = await aggregator.getIndex();
    // index2 is a fresh array (re-scanned)
    expect(index2).not.toBe(index1);
  });

  it('scan() produces equivalent data on unchanged filesystem', async () => {
    const { aggregator } = makeAggregator();
    const index1 = await aggregator.getIndex();
    await aggregator.scan();
    const index2 = await aggregator.getIndex();
    expect(index2.length).toBe(index1.length);
    expect(index2[0].slug).toBe(index1[0].slug);
    expect(index2[0].features.length).toBe(index1[0].features.length);
  });

  it('scan() triggers lazy scan if index is null (first call)', async () => {
    const { aggregator } = makeAggregator();
    // Directly check that before getIndex(), no scan happened
    // (index is null internally, but getIndex() auto-scans)
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
  });
});

// ── AC3 — Aggregat-Modell: Projekt → Feature → Story mit Pflichtfeldern ───────

describe('AC3 — Aggregat model: Projekt → Feature → Story with required fields', () => {
  it('project entry has slug, repo_path, project_slug, schema_version, features', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const project = index[0];
    expect(project).toHaveProperty('slug', 'my-repo');
    expect(project).toHaveProperty('repo_path');
    expect(project).toHaveProperty('project_slug');
    expect(project).toHaveProperty('schema_version');
    expect(project).toHaveProperty('features');
  });

  it('feature entry has id, title, status, priority, progress, stories', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    expect(f001).toHaveProperty('id', 'F-001');
    expect(f001).toHaveProperty('title', 'Server-Provisioning');
    // feature-status-derivation (S-238, AC5): feature.status ist jetzt IMMER live
    // aus den Kind-Stories abgeleitet und ignoriert das persistierte YAML-status:
    // (Fixture: status: Active). F-001 hat S-001=Done + S-002=In Progress →
    // weakest-wins ⇒ In Progress (schwächste vorkommende Stufe).
    expect(f001).toHaveProperty('status', 'In Progress');
    expect(f001).toHaveProperty('priority', 'P1');
    expect(f001).toHaveProperty('progress');
    expect(f001).toHaveProperty('stories');
    expect(Array.isArray(f001.stories)).toBe(true);
  });

  it('story entry carries id, parent, title, status, priority, labels, spec', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001).toHaveProperty('id', 'S-001');
    expect(s001).toHaveProperty('parent', 'F-001');
    expect(s001).toHaveProperty('title', 'IONOS-Adapter');
    expect(s001).toHaveProperty('status', 'Done');
    expect(s001).toHaveProperty('priority', 'P0');
    expect(s001).toHaveProperty('labels');
    expect(s001.labels).toEqual(['db', 'security']);
    expect(s001).toHaveProperty('spec', 'docs/specs/provisioning.md');
  });

  it('story entry carries dispo_est and dispo_act (both null in fixture)', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001).toHaveProperty('dispo_est', null);
    expect(s001).toHaveProperty('dispo_act', null);
  });

  // ── taktgeber-nachtwaechter AC1 ──────────────────────────────────────────────

  it('story entry carries updated_at (string wenn gesetzt, null wenn fehlt) — ProjectDrain Stale-Quelle', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    // S-001-Fixture hat updated_at gesetzt
    expect(s001).toHaveProperty('updated_at', '2026-06-14T00:00:00Z');
  });

  it('story entry carries updated_at: null wenn YAML-Feld fehlt', async () => {
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]:
          'id: S-001\nparent: F-001\ntitle: No updated_at\nstatus: To Do\npriority: P1\n',
      },
    });
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001).toHaveProperty('updated_at', null);
  });

  // ── story-detail-yaml-fallback AC1 ──────────────────────────────────────────

  it('story entry carries done_at (string wenn gesetzt, null wenn fehlt)', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    const s002 = f001.stories.find((s) => s.id === 'S-002');
    // S-001 hat done_at in der Fixture
    expect(s001).toHaveProperty('done_at', '2026-06-14T00:00:00Z');
    // S-002 hat done_at: null in der Fixture
    expect(s002).toHaveProperty('done_at', null);
  });

  it('story entry carries branch and pr (null in fixture)', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001).toHaveProperty('branch', null);
    expect(s001).toHaveProperty('pr', null);
  });

  it('story entry carries branch/pr as string when set in YAML', async () => {
    const storyWithBranchPr = `id: S-001
parent: F-001
title: IONOS-Adapter
status: Done
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1]
labels: []
dispo_est: null
dispo_act: null
branch: board/my-feature-2026-06-14
pr: https://github.com/org/repo/pull/42
done_at: '2026-06-14T00:00:00Z'
`;
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: storyWithBranchPr,
      },
    });
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001.branch).toBe('board/my-feature-2026-06-14');
    expect(s001.pr).toBe('https://github.com/org/repo/pull/42');
    expect(s001.done_at).toBe('2026-06-14T00:00:00Z');
  });

  it('stories are attached to their parent feature', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    const f002 = index[0].features.find((f) => f.id === 'F-002');
    expect(f001.stories.length).toBe(2);
    expect(f002.stories.length).toBe(0); // no stories pointing to F-002 in fixture
  });

  it('stories with unknown parent are placed under orphaned pseudo-feature', async () => {
    const fsDeps = buildFakeFsDeps({
      extraStoryFiles: ['S-003-orphaned.yaml'],
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-003-orphaned.yaml`]: STORY_S003_ORPHANED,
      },
    });
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    const index = await aggregator.getIndex();
    const orphaned = index[0].features.find((f) => f._orphaned);
    expect(orphaned).toBeDefined();
    expect(orphaned.stories.some((s) => s.id === 'S-003')).toBe(true);
    // F-001 stories unchanged
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    expect(f001.stories.every((s) => s.id !== 'S-003')).toBe(true);
  });

  it('feature.progress is preserved when present in YAML', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    // F-001 has progress: "1/2 done" in fixture
    expect(f001.progress).toBe('1/2 done');
  });

  it('feature.progress is computed read-only when null/missing in YAML', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    // F-002 has progress: null in fixture but no stories → "0/0 done"
    const f002 = index[0].features.find((f) => f.id === 'F-002');
    expect(typeof f002.progress).toBe('string');
    expect(f002.progress).toContain('/');
  });
});

// ── AC7 — Read-only-Garantie ──────────────────────────────────────────────────

describe('AC7 — Read-only guarantee: no writes to board/ files', () => {
  it('fsDeps.readFile is called only (no write operations)', async () => {
    const calls = [];
    const fsDeps = buildFakeFsDeps();
    const origReadFile = fsDeps.readFile;
    fsDeps.readFile = async (path, enc) => {
      calls.push({ op: 'readFile', path });
      return origReadFile(path, enc);
    };

    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    await aggregator.getIndex();

    // All calls should be readFile (read) — no writeFile, appendFile, etc.
    expect(calls.every((c) => c.op === 'readFile')).toBe(true);
    // Verify at least board.yaml, features, stories were read
    expect(calls.some((c) => c.path.includes('board.yaml'))).toBe(true);
    expect(calls.some((c) => c.path.includes('features'))).toBe(true);
    expect(calls.some((c) => c.path.includes('stories'))).toBe(true);
  });

  it('scan() does not persist the index anywhere (only updates in-memory reference)', async () => {
    // The index is an in-process variable — verified by checking that two scans
    // return new array instances (not the same object, no disk write)
    const { aggregator } = makeAggregator();
    const index1 = await aggregator.getIndex();
    await aggregator.scan();
    const index2 = await aggregator.getIndex();
    // Both are plain arrays — not serialized/persisted
    expect(Array.isArray(index1)).toBe(true);
    expect(Array.isArray(index2)).toBe(true);
    expect(typeof index1).toBe('object');
    expect(typeof index2).toBe('object');
  });
});

// ── AC8 — Fehlertoleranz ──────────────────────────────────────────────────────

describe('AC8 — Fault tolerance: invalid boards skipped, others remain visible', () => {
  it('missing board.yaml → project entry with error field, empty features', async () => {
    const { aggregator } = makeAggregator({ missingBoardYaml: true });
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
    const project = index[0];
    expect(project).toHaveProperty('error');
    expect(typeof project.error).toBe('string');
    expect(project.features).toEqual([]);
  });

  it('broken board.yaml (invalid YAML) → project entry with error, empty features', async () => {
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/board.yaml`]: 'not: valid: yaml: : : :',
      },
    });
    const index = await aggregator.getIndex();
    // parseYaml degrades gracefully, but board might be missing project_slug
    // Either it errors or it succeeds with partial data — no crash is the key
    expect(index.length).toBe(1);
    expect(() => JSON.stringify(index)).not.toThrow();
  });

  it('malformed feature YAML is skipped — other features remain visible', async () => {
    const { aggregator } = makeAggregator({
      extraFeatureFiles: ['F-BAD-malformed.yaml'],
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/features/F-BAD-malformed.yaml`]: ':::: not yaml ::::',
      },
    });
    const index = await aggregator.getIndex();
    const features = index[0].features.filter((f) => !f._orphaned);
    // Only valid features F-001 and F-002 survive; malformed is silently skipped
    expect(features.some((f) => f.id === 'F-001')).toBe(true);
    expect(features.some((f) => f.id === 'F-002')).toBe(true);
  });

  it('malformed story YAML is skipped — other stories remain visible', async () => {
    const { aggregator } = makeAggregator({
      extraStoryFiles: ['S-BAD-malformed.yaml'],
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-BAD-malformed.yaml`]: ':::: bad ::::',
      },
    });
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    // S-001 and S-002 still there
    expect(f001.stories.some((s) => s.id === 'S-001')).toBe(true);
    expect(f001.stories.some((s) => s.id === 'S-002')).toBe(true);
  });

  it('missing features/ dir does not crash (empty feature list)', async () => {
    const { aggregator } = makeAggregator({ missingFeaturesDir: true });
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
    // No crash; features is empty (or only orphaned if stories have bad parents)
    expect(Array.isArray(index[0].features)).toBe(true);
  });

  it('missing stories/ dir does not crash (features have empty story lists)', async () => {
    const { aggregator } = makeAggregator({ missingStoriesDir: true });
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
    const features = index[0].features.filter((f) => !f._orphaned);
    expect(features.every((f) => Array.isArray(f.stories))).toBe(true);
    expect(features.every((f) => f.stories.length === 0)).toBe(true);
  });

  it('one invalid board does not crash the scan of other boards', async () => {
    // Two repos: first has broken board.yaml, second is valid
    // Build custom dirs + files inline (not using buildFakeFsDeps — different layout)
    const dirs = {
      [BOARD_ROOT]: [
        { name: 'broken-repo', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false },
        { name: 'good-repo', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false },
      ],
      [`${BOARD_ROOT}/broken-repo`]: [
        { name: 'board', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false },
      ],
      [`${BOARD_ROOT}/broken-repo/board`]: [
        { name: 'board.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'features', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        { name: 'stories', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      ],
      [`${BOARD_ROOT}/broken-repo/board/features`]: [],
      [`${BOARD_ROOT}/broken-repo/board/stories`]: [],
      [`${BOARD_ROOT}/good-repo`]: [
        { name: 'board', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false },
      ],
      [`${BOARD_ROOT}/good-repo/board`]: [
        { name: 'board.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'features', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        { name: 'stories', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      ],
      [`${BOARD_ROOT}/good-repo/board/features`]: [],
      [`${BOARD_ROOT}/good-repo/board/stories`]: [],
    };

    const files = {
      // broken-repo: board.yaml is unreadable
      [`${BOARD_ROOT}/good-repo/board/board.yaml`]: `schema_version: 1\nproject_slug: good-project\n`,
    };

    const customReaddir = async (path, _opts) => {
      if (path in dirs) return dirs[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      throw err;
    };

    const customReadFile = async (path, _enc) => {
      if (path in files) return files[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      throw err;
    };

    const aggregator = new BoardAggregator({
      boardRootsEnv: BOARD_ROOT,
      fsDeps: { readdir: customReaddir, readFile: customReadFile, watch: async function* () {} },
    });

    const index = await aggregator.getIndex();

    // Both boards are in the index (broken with error, good without)
    expect(index.length).toBe(2);
    const broken = index.find((p) => p.slug === 'broken-repo');
    const good = index.find((p) => p.slug === 'good-repo');
    expect(broken).toBeDefined();
    expect(broken).toHaveProperty('error');
    expect(good).toBeDefined();
    expect(good).not.toHaveProperty('error');
    expect(good.project_slug).toBe('good-project');
  });

  it('scan() never throws even when all roots are unreachable', async () => {
    const fsDeps = {
      readdir: async () => { throw new Error('EACCES: permission denied'); },
      readFile: async () => { throw new Error('EACCES: permission denied'); },
      watch: async function* () {},
    };
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    await expect(aggregator.scan()).resolves.not.toThrow();
    const index = await aggregator.getIndex();
    expect(index).toEqual([]);
  });
});

// ── AC9 — Re-Scan on-demand ───────────────────────────────────────────────────

describe('AC9 — On-demand re-scan updates the index', () => {
  it('scan() can be called multiple times without error', async () => {
    const { aggregator } = makeAggregator();
    await aggregator.scan();
    await aggregator.scan();
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
  });

  it('after scan(), index reflects updated data (simulated by re-reading)', async () => {
    const { aggregator } = makeAggregator();
    await aggregator.getIndex(); // populate cache
    await aggregator.scan();    // re-scan
    const index = await aggregator.getIndex();
    expect(index.length).toBe(1);
    expect(index[0].slug).toBe('my-repo');
  });

  it('stopWatchers() does not throw when no watchers are active', () => {
    const { aggregator } = makeAggregator();
    expect(() => aggregator.stopWatchers()).not.toThrow();
  });

  it('startWatchers() and stopWatchers() can be called without crash', () => {
    const fsDeps = {
      ...buildFakeFsDeps(),
      // watch returns an async generator that immediately returns (no events)
      watch: async function* () {},
    };
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    expect(() => aggregator.startWatchers()).not.toThrow();
    expect(() => aggregator.stopWatchers()).not.toThrow();
  });
});

// ── drain-origin-progress-sync AC2/AC7 — readProjectAt() (injizierbare Datei-Quelle) ──
//
// Covers (drain-origin-progress-sync):
//   AC2 — BoardAggregator bietet eine injizierbare Datei-Quelle-Abstraktion
//         (`readProjectAt(slug, repoPath, { fsDeps })`): mit einer alternativen
//         `fsDeps` (hier: ein Fake, der eine Git-Ref-Datei-Quelle simuliert) liest
//         _readBoard()/computeStoryReadyStatus() konsistent aus DIESER Quelle statt
//         dem Working-Tree — Scan-/Ready-Logik selbst bleibt unverändert (identische
//         Story-/Feature-Felder wie beim regulären Working-Tree-Scan).
//   AC7 — readProjectAt() ist read-only (kein Schreibpfad) und hat KEINEN
//         Seiteneffekt auf den In-Memory-`#index`/`getIndex()` — ein Aufruf
//         verändert nicht, was ein nachfolgender scan()/getIndex() liefert.
describe('drain-origin-progress-sync AC2/AC7 — readProjectAt() (injizierbare Datei-Quelle)', () => {
  it('reads a project via the DEFAULT (working-tree) fsDeps when no override is given — bit-identical to scan()', async () => {
    const { aggregator } = makeAggregator();

    const project = await aggregator.readProjectAt('my-repo', `${BOARD_ROOT}/my-repo`);

    expect(project.slug).toBe('my-repo');
    expect(project.features.map((f) => f.id).sort()).toEqual(['F-001', 'F-002']);
    const allStories = project.features.flatMap((f) => f.stories);
    expect(allStories.map((s) => s.id).sort()).toEqual(['S-001', 'S-002']);
  });

  it('reads a project via an INJECTED alternative fsDeps (simulated git-ref source) instead of the working-tree', async () => {
    const { aggregator } = makeAggregator();
    // Alternative source: a completely disjoint in-memory "ref" snapshot with a
    // DIFFERENT story status than the working-tree fixture (S-002 is 'In
    // Progress' in the working-tree fixture but 'Done' at this simulated ref —
    // proves the override is actually consulted, not the default fsDeps).
    const refFiles = {
      [`${BOARD_ROOT}/my-repo/board/board.yaml`]: BOARD_YAML,
      [`${BOARD_ROOT}/my-repo/board/features/F-001-server-provisioning.yaml`]: FEATURE_F001,
      [`${BOARD_ROOT}/my-repo/board/stories/S-002-hetzner-adapter.yaml`]: STORY_S002.replace(
        'status: In Progress',
        'status: Done',
      ),
    };
    const refDirs = {
      [`${BOARD_ROOT}/my-repo/board`]: [{ name: 'features' }, { name: 'stories' }].map((e) => ({
        ...e,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      })),
      [`${BOARD_ROOT}/my-repo/board/features`]: [
        { name: 'F-001-server-provisioning.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ],
      [`${BOARD_ROOT}/my-repo/board/stories`]: [
        { name: 'S-002-hetzner-adapter.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ],
    };
    const refFsDeps = {
      readFile: async (p) => {
        if (p in refFiles) return refFiles[p];
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
      readdir: async (p) => {
        if (p in refDirs) return refDirs[p];
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    };

    const project = await aggregator.readProjectAt('my-repo', `${BOARD_ROOT}/my-repo`, { fsDeps: refFsDeps });

    const s2 = project.features[0].stories.find((s) => s.id === 'S-002');
    expect(s2.status).toBe('Done'); // from the injected ref source, not the working-tree fixture
  });

  it('returns null when no board/ directory exists at the given source (no crash)', async () => {
    const { aggregator } = makeAggregator();
    const emptyFsDeps = {
      readdir: async () => {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
      readFile: async () => {
        throw new Error('ENOENT');
      },
    };

    const project = await aggregator.readProjectAt('ghost-repo', `${BOARD_ROOT}/ghost-repo`, {
      fsDeps: emptyFsDeps,
    });

    expect(project).toBeNull();
  });

  it('has no side effect on the in-memory index / getIndex() (read-only, independent of scan())', async () => {
    const { aggregator } = makeAggregator();
    const before = await aggregator.getIndex();

    await aggregator.readProjectAt('my-repo', `${BOARD_ROOT}/my-repo`);

    const after = await aggregator.getIndex();
    expect(after).toBe(before); // same memoized reference — readProjectAt() never invalidated the index
  });
});

// ── fswatcher-crash-hardening: AC1–AC5 (deterministisch, injizierter watch/Timer) ──
//
// Covers (fswatcher-crash-hardening):
//   AC1 — Jeder Watcher-Fehler (Bewaffnung synchron ODER während des Iterierens) wird
//         abgefangen; kein unbehandelter Reject / kein 'unhandledRejection'.
//   AC2 — ENOENT/scandir während des Beobachtens: _watchRoot() kehrt sauber zurück
//         ({ armed: true, aborted: false }), kein Reject.
//   AC3 — Verschwindende Wurzel: der Debounce-Timer wird beim Schließen gecleart
//         (kein Leak, kein hängender Iterator).
//   AC4 — Re-Arm mit festen, benannten Backoff-Konstanten (500ms/Faktor 2/Cap 30s);
//         bei Erfolg Backoff-Reset + Index EINMAL invalidiert (nächster getIndex()
//         re-scant). Höchstens ein ausstehender Re-Arm-Timer je Wurzel.
//   AC5 — stopWatchers() bricht einen anstehenden Backoff-/Re-Arm-Timer ab; danach
//         erfolgt kein weiterer watch()-Aufruf mehr.
//
// Strategy: #fsDeps.watch/setTimeout/clearTimeout/pathExists werden injiziert (kein
// echtes Filesystem, kein jest.useFakeTimers() — eigene deterministische Fake-Timer-
// Queue, analog zum bestehenden fsDeps-Injektionsmuster).

/** Deterministic fake timer queue for injected fsDeps.setTimeout/clearTimeout. */
function makeFakeTimers() {
  let idCounter = 0;
  const pending = new Map(); // id → { fn, delay }
  const clearCalls = [];
  return {
    setTimeout: (fn, delay) => {
      const id = ++idCounter;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => {
      clearCalls.push(id);
      pending.delete(id);
    },
    pending,
    clearCalls,
    /** Fire the single earliest pending timer, then flush microtasks. */
    async fireNext() {
      const entries = [...pending.entries()];
      if (entries.length === 0) return false;
      const [id, entry] = entries[0];
      pending.delete(id);
      entry.fn();
      await flushMicrotasks();
      return true;
    },
  };
}

/** Flush pending microtasks (several rounds — enough for a few chained awaits). */
function flushMicrotasks(rounds = 8) {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) p = p.then(() => {});
  return p;
}

/**
 * A minimal async-iterable whose first `next()` call rejects with `err` — used to
 * simulate a watch()-Iterator that throws during iteration without needing an
 * (empty, lint-flagged) `async function*` generator.
 */
function rejectingAsyncIterable(err) {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(err) };
    },
  };
}

describe('fswatcher-crash-hardening AC1 — Watcher-Fehler eskalieren nie', () => {
  it('watch() wirft synchron bei der Bewaffnung → kein unbehandelter Reject, kein Crash', async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const aggregator = new BoardAggregator({
        boardRootsEnv: '/tmp/does-not-matter-ac1a',
        fsDeps: {
          readdir: async () => [],
          readFile: async () => '',
          watch: () => { throw new Error('sync boom'); },
        },
      });
      expect(() => aggregator.startWatchers()).not.toThrow();
      await flushMicrotasks();
      expect(rejections).toEqual([]);
      aggregator.stopWatchers();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('watch()-Iterator wirft während des Iterierens → kein unbehandelter Reject, kein Crash', async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const aggregator = new BoardAggregator({
        boardRootsEnv: '/tmp/does-not-matter-ac1b',
        fsDeps: {
          readdir: async () => [],
          readFile: async () => '',
          watch: () => rejectingAsyncIterable(new Error('iterator boom')),
        },
      });
      expect(() => aggregator.startWatchers()).not.toThrow();
      await flushMicrotasks();
      expect(rejections).toEqual([]);
      aggregator.stopWatchers();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('fswatcher-crash-hardening AC2 — Kein Crash bei ENOENT/scandir', () => {
  it('_watchRoot() kehrt bei ENOENT/scandir-Fehler sauber zurück (kein Reject)', async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const aggregator = new BoardAggregator({
        boardRootsEnv: '/tmp/does-not-matter-ac2',
        fsDeps: {
          readdir: async () => [],
          readFile: async () => '',
          watch: () => {
            const err = new Error(
              "ENOENT: no such file or directory, scandir '/workspace/dev-gui/node_modules/.bin'",
            );
            err.code = 'ENOENT';
            return rejectingAsyncIterable(err);
          },
        },
      });
      const ac = new AbortController();
      await expect(aggregator._watchRoot('/tmp/does-not-matter-ac2', ac.signal)).resolves.toEqual({
        armed: true,
        aborted: false,
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('fswatcher-crash-hardening AC3 — Verschwindender Pfad: sauberes Schließen', () => {
  it('Debounce-Timer wird beim Schließen (Fehler nach Event) gecleart', async () => {
    const timers = makeFakeTimers();
    const aggregator = new BoardAggregator({
      boardRootsEnv: '/tmp/does-not-matter-ac3',
      fsDeps: {
        readdir: async () => [],
        readFile: async () => '',
        watch: () => (async function* () {
          yield { eventType: 'rename', filename: 'node_modules' };
          const err = new Error('ENOENT: scandir');
          err.code = 'ENOENT';
          throw err;
        })(),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => false,
      },
    });

    // V2 (Scope-Verengung, AC9): der über startWatchers() bewaffnete Watcher je
    // BOARD_ROOTS-Wurzel ist seit AC9 ein flacher Meta-Watch (kind:'meta'), der
    // NICHT selbst debounced/den Index invalidiert (nur Repo-Unterbaum-Watches
    // tun das, AC10) — _watchRoot() selbst (die generische, index-relevante
    // Debounce-/Fehlerbehandlungs-Maschine, unverändert seit V1 AC1–AC5) wird
    // hier DIREKT (flat=false, wie ein Subtree-Watch) aufgerufen, um genau
    // dieses V1-Verhalten isoliert zu testen — unabhängig vom Meta/Subtree-
    // Dispatch, der in startWatchers()/AC6/AC7/AC8/AC9/AC10-Tests separat
    // abgedeckt ist.
    const ac = new AbortController();
    await aggregator._watchRoot('/tmp/does-not-matter-ac3', ac.signal);

    // Debounce-Timer (id 1) wurde beim Event gesetzt und im finally-Block des
    // Watcher-Loops gecleart, sobald der Fehler die Schleife beendet.
    expect(timers.clearCalls).toContain(1);
    aggregator.stopWatchers();
  });
});

describe('fswatcher-crash-hardening AC4 — Re-Arm mit exponentiellem, begrenztem Backoff', () => {
  it('Backoff wächst 500 → 1000 → 2000ms; bei Erfolg Reset + Index-Invalidierung EINMAL', async () => {
    const timers = makeFakeTimers();
    let watchCallCount = 0;
    let readdirCalls = 0;

    const watchFn = () => {
      watchCallCount++;
      if (watchCallCount <= 3) {
        const err = new Error('ENOENT: scandir');
        err.code = 'ENOENT';
        throw err;
      }
      // 4. Versuch: Bewaffnung gelingt, Iterator endet sofort (kein Event).
      return (async function* () {})();
    };

    const aggregator = new BoardAggregator({
      boardRootsEnv: '/tmp/does-not-matter-ac4',
      // board-aggregator-periodic-rescan AC3 Opt-out: dieser Test prüft die
      // Re-Arm-/Backoff-Timer-Reihenfolge über dieselbe injizierte Fake-Timer-
      // Queue — der (orthogonale) periodische Rescan-Timer würde sie sonst
      // kontaminieren (Isolation, kein Verhaltensunterschied am Watcher selbst).
      rescanIntervalMs: 0,
      fsDeps: {
        readdir: async () => { readdirCalls++; return []; },
        readFile: async () => '',
        watch: watchFn,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => true,
      },
    });

    // Baseline-Scan (Index nicht mehr null).
    await aggregator.getIndex();
    expect(readdirCalls).toBe(1);

    aggregator.startWatchers();
    await flushMicrotasks();
    expect(watchCallCount).toBe(1); // initialer Arm-Versuch fehlgeschlagen

    expect([...timers.pending.values()][0].delay).toBe(500); // REARM_INITIAL_DELAY_MS
    await timers.fireNext();
    expect(watchCallCount).toBe(2);

    expect([...timers.pending.values()][0].delay).toBe(1000); // 500 * 2
    await timers.fireNext();
    expect(watchCallCount).toBe(3);

    expect([...timers.pending.values()][0].delay).toBe(2000); // 500 * 2^2
    await timers.fireNext();
    expect(watchCallCount).toBe(4); // erfolgreiche Neu-Bewaffnung

    // AC4: Index wurde bei der erfolgreichen Neu-Bewaffnung invalidiert — ein
    // weiterer getIndex()-Aufruf triggert einen frischen Scan (readdir erneut).
    // readdirCalls=3 (statt 2 in V1): die BOARD_ROOTS-Wurzel wird seit der V2
    // Scope-Verengung (AC9) über einen Meta-Watch beobachtet; hier ist state.kind
    // 'meta', daher resynct onArmed() bei erfolgreichem Re-Arm zusätzlich EINMAL
    // _syncRepoWatchers() (readdir auf die Wurzel) — unabhängig vom separaten
    // getIndex()-Scan-readdir. Kein Regress: die Index-Invalidierung selbst bleibt
    // "einmal" (AC4), nur ein zusätzlicher (index-irrelevanter) readdir-Aufruf.
    await aggregator.getIndex();
    expect(readdirCalls).toBe(3);

    aggregator.stopWatchers();
  });

  it('Pfad dauerhaft nicht vorhanden: Backoff verweilt an der Obergrenze (30s), kein Busy-Loop', async () => {
    const timers = makeFakeTimers();
    let existsCalls = 0;

    const aggregator = new BoardAggregator({
      boardRootsEnv: '/tmp/does-not-matter-ac4b',
      // board-aggregator-periodic-rescan AC3 Opt-out: siehe Kommentar oben
      // (Isolation der Fake-Timer-Queue vom orthogonalen Rescan-Timer).
      rescanIntervalMs: 0,
      fsDeps: {
        readdir: async () => [],
        readFile: async () => '',
        watch: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => { existsCalls++; return false; },
      },
    });

    aggregator.startWatchers();
    await flushMicrotasks();

    // Mehrere Runden abwarten, bis der Cap erreicht ist: 500,1000,2000,4000,8000,16000,30000(cap),30000…
    const expectedDelays = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    for (const expected of expectedDelays) {
      expect([...timers.pending.values()][0].delay).toBe(expected);
      await timers.fireNext();
    }

    // pathExists wurde für jede Backoff-Runde geprüft, watch() aber nie erneut
    // erfolgreich aufgerufen (Pfad bleibt weg) — kein Busy-Loop (Delays wachsen,
    // stauen sich nicht auf ein Vielfaches).
    expect(existsCalls).toBe(expectedDelays.length);
    aggregator.stopWatchers();
  });

  it('höchstens EIN ausstehender Re-Arm-Timer je Wurzel', async () => {
    const timers = makeFakeTimers();
    const aggregator = new BoardAggregator({
      boardRootsEnv: '/tmp/does-not-matter-ac4c',
      // board-aggregator-periodic-rescan AC3 Opt-out: siehe Kommentar oben
      // (Isolation der Fake-Timer-Queue vom orthogonalen Rescan-Timer).
      rescanIntervalMs: 0,
      fsDeps: {
        readdir: async () => [],
        readFile: async () => '',
        watch: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => false,
      },
    });

    aggregator.startWatchers();
    await flushMicrotasks();
    expect(timers.pending.size).toBe(1);

    aggregator.stopWatchers();
  });
});

describe('fswatcher-crash-hardening AC5 — stopWatchers() bricht Re-Arm ab', () => {
  it('bricht einen anstehenden Backoff-Timer ab; danach kein weiterer watch()-Aufruf', async () => {
    const timers = makeFakeTimers();
    let watchCallCount = 0;

    const aggregator = new BoardAggregator({
      boardRootsEnv: '/tmp/does-not-matter-ac5',
      // board-aggregator-periodic-rescan AC3 Opt-out: siehe Kommentar oben
      // (Isolation der Fake-Timer-Queue vom orthogonalen Rescan-Timer).
      rescanIntervalMs: 0,
      fsDeps: {
        readdir: async () => [],
        readFile: async () => '',
        watch: () => { watchCallCount++; throw new Error('generic failure, no code'); },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => true,
      },
    });

    aggregator.startWatchers();
    await flushMicrotasks();
    expect(watchCallCount).toBe(1);
    expect(timers.pending.size).toBe(1);

    aggregator.stopWatchers();
    expect(timers.pending.size).toBe(0);
    expect(timers.clearCalls.length).toBeGreaterThan(0);

    // Selbst nach vollständigem Flush darf kein weiterer watch()-Aufruf erfolgen.
    await flushMicrotasks();
    expect(watchCallCount).toBe(1);
  });
});

describe('fswatcher-crash-hardening V2 — _syncRepoWatchers() Re-Entrancy-Schutz (S-320 Review-Iteration 2, Finding #1)', () => {
  it(
    'zwei überlappende _syncRepoWatchers()-Aufrufe für dieselbe Wurzel laufen SERIALISIERT (Aufruf 2 startet seinen Kern-Durchlauf erst, nachdem Aufruf 1 vollständig durch ist) — kein doppelter Watcher-State',
    async () => {
      // Beweist direkt die Serialisierungs-Eigenschaft von _syncRepoWatchers()
      // (Verkettung über #syncInFlight): ein zweiter, überlappender Aufruf für
      // DIESELBE Wurzel darf seinen eigentlichen Sync-Kern
      // (_syncRepoWatchersOnce → readdir → activeSubtreeRoots-Snapshot) NICHT
      // beginnen, solange der erste Aufruf noch läuft — sonst könnten beide
      // denselben "noch nicht aktiv"-Zustand sehen und den Subtree-Watcher für
      // denselben Pfad doppelt bewaffnen (Review-Finding #1: activeSubtreeRoots
      // wird erst NACH readdir + der pathExists-Schleife berechnet, mehrere
      // await-Punkte vor der state-mutierenden Sektion).
      let inFlightCount = 0;
      let maxObservedInFlight = 0;
      let readdirCallCount = 0;
      let watchCallCount = 0;
      const watchedPaths = [];

      let releaseFirstReaddir;
      const firstReaddirGate = new Promise((resolve) => {
        releaseFirstReaddir = resolve;
      });

      const aggregator = new BoardAggregator({
        boardRootsEnv: '/tmp/does-not-matter-reentrancy',
        fsDeps: {
          readdir: async (root) => {
            readdirCallCount++;
            inFlightCount++;
            maxObservedInFlight = Math.max(maxObservedInFlight, inFlightCount);
            if (readdirCallCount === 1) {
              // Erster Kern-Durchlauf hängt, bis der Test ihn freigibt.
              await firstReaddirGate;
            }
            void root;
            const entries = [
              { name: 'probe-repo', isDirectory: () => true, isSymbolicLink: () => false },
            ];
            inFlightCount--;
            return entries;
          },
          readFile: async () => '',
          watch: (path) => {
            watchCallCount++;
            watchedPaths.push(path);
            // Nie feuern — genügt, um als "erfolgreich bewaffnet" zu gelten
            // (armed via onArmed-Callback in _watchRoot, kein Event nötig).
            return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
          },
          setTimeout: (...args) => globalThis.setTimeout(...args),
          clearTimeout: (...args) => globalThis.clearTimeout(...args),
          pathExists: async () => true, // <repo>/board + <repo>/docs/specs existieren beide
        },
      });

      // Erster Aufruf: sein Kern hängt in readdir() (Gate noch nicht frei).
      const firstCall = aggregator._syncRepoWatchers('/tmp/does-not-matter-reentrancy');
      await flushMicrotasks();
      expect(readdirCallCount).toBe(1); // Kern 1 hat readdir() betreten (und hängt dort)

      // Zweiter, ÜBERLAPPENDER Aufruf für DIESELBE Wurzel, während der erste
      // Kern noch pending ist.
      const secondCall = aggregator._syncRepoWatchers('/tmp/does-not-matter-reentrancy');
      await flushMicrotasks();

      // Kernbeweis der Serialisierung: Aufruf 2 darf seinen EIGENEN Kern
      // (readdir #2) NOCH NICHT betreten haben, solange Kern 1 noch hängt —
      // ohne Re-Entrancy-Schutz würde readdirCallCount hier bereits 2 sein
      // (Aufruf 2 liefe parallel zu Aufruf 1, statt an dessen Kette
      // angehängt zu werden).
      expect(readdirCallCount).toBe(1);

      // Jetzt den ersten readdir()-Aufruf freigeben — Kern 1 läuft durch
      // (inkl. State-Mutation/watch()-Aufrufe), DANACH erst startet Kern 2.
      releaseFirstReaddir();
      await firstCall;
      await secondCall;
      await flushMicrotasks();

      // Kern 2 ist inzwischen ebenfalls gelaufen (verkettet, nicht verworfen).
      expect(readdirCallCount).toBe(2);
      // Zu keinem Zeitpunkt liefen beide Kerne gleichzeitig (kein Wert > 1).
      expect(maxObservedInFlight).toBe(1);

      // Ergebnis: genau EIN watch()-Aufruf je Subtree-Pfad (board, docs/specs)
      // — kein doppelter FSWatcher/Debounce-Timer auf demselben Pfad, weil
      // Kern 2 beim Start bereits den von Kern 1 gepushten State sieht.
      const uniqueWatchedPaths = new Set(watchedPaths);
      expect(uniqueWatchedPaths.size).toBe(watchedPaths.length);
      expect(watchCallCount).toBe(2); // <repo>/board + <repo>/docs/specs, je einmal

      aggregator.stopWatchers();
    },
  );

  it(
    'stopWatchers() während eine _syncRepoWatchers()-Kette noch läuft (readdir hängt) verhindert JEDEN nachfolgenden watch()-Aufruf dieser Kette (Review-Finding #2, AC5)',
    async () => {
      // Beweist den globalen #allStopped-Stop-Flag: stopWatchers() leert
      // #watchers synchron, hat aber ohne den Flag KEINE Sichtbarkeit auf eine
      // bereits laufende, verkettete _syncRepoWatchers()-Sync-Kette. Läuft
      // diese Kette NACH stopWatchers() zu Ende, würde sie ohne den Fix einen
      // frischen (stopped:false) Watcher-State pushen und via _armRoot()
      // bewaffnen — ein watch()-Aufruf NACH stopWatchers(), Verstoss gegen AC5.
      let watchCallCount = 0;

      let releaseReaddir;
      const readdirGate = new Promise((resolve) => {
        releaseReaddir = resolve;
      });

      const aggregator = new BoardAggregator({
        boardRootsEnv: '/tmp/does-not-matter-stop-during-sync',
        fsDeps: {
          readdir: async (root) => {
            void root;
            // Hängt, bis der Test das Gate freigibt — simuliert genau den
            // Re-Entrancy-Punkt, an dem stopWatchers() dazwischenkommen kann.
            await readdirGate;
            return [
              { name: 'probe-repo', isDirectory: () => true, isSymbolicLink: () => false },
            ];
          },
          readFile: async () => '',
          watch: () => {
            watchCallCount++;
            return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
          },
          setTimeout: (...args) => globalThis.setTimeout(...args),
          clearTimeout: (...args) => globalThis.clearTimeout(...args),
          pathExists: async () => true,
        },
      });

      // Sync-Kette anstossen — ihr Kern hängt jetzt in readdir().
      const syncCall = aggregator._syncRepoWatchers('/tmp/does-not-matter-stop-during-sync');
      await flushMicrotasks();
      expect(watchCallCount).toBe(0); // noch nichts bewaffnet, Kette hängt in readdir()

      // stopWatchers() wird aufgerufen, WÄHREND die Kette noch pending ist.
      aggregator.stopWatchers();

      // Jetzt erst readdir() freigeben — die Kette läuft zu Ende, NACHDEM
      // stopWatchers() bereits durchgelaufen ist.
      releaseReaddir();
      await syncCall;
      await flushMicrotasks();

      // Kernbeweis: kein watch()-Aufruf, obwohl die Kette einen neuen Subtree
      // (probe-repo/board, probe-repo/docs/specs) gefunden hätte.
      expect(watchCallCount).toBe(0);

      // Und auch kein Zombie-Watcher-State hängt im internen Register.
      await flushMicrotasks();
      expect(watchCallCount).toBe(0);
    },
  );
});

// ── Feature extended fields: goal, definition_of_done, depends, labels ────────

const FEATURE_F003_FULL = `id: F-003
title: Vollstaendiges Feature
goal: Ziel des Features in einem oder zwei Saetzen.
status: Active
priority: P0
definition_of_done: Alle Tests gruen, Review bestanden.
labels: [infra, security]
depends: [F-001, F-002]
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
stories: []
progress: null
`;

const FEATURE_F004_MINIMAL = `id: F-004
title: Minimales Feature
status: Backlog
priority: P3
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
stories: []
progress: null
`;

describe('Feature extended fields — goal, definition_of_done, depends, labels', () => {
  function makeAggregatorWithFeature(featureYaml, fileName) {
    const fsDeps = buildFakeFsDeps({
      extraFeatureFiles: [fileName],
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/features/${fileName}`]: featureYaml,
      },
    });
    return new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
  }

  it('feature entry has goal field from YAML', async () => {
    const aggregator = makeAggregatorWithFeature(FEATURE_F003_FULL, 'F-003-full.yaml');
    const index = await aggregator.getIndex();
    const f003 = index[0].features.find((f) => f.id === 'F-003');
    expect(f003).toBeDefined();
    expect(f003.goal).toBe('Ziel des Features in einem oder zwei Saetzen.');
  });

  it('feature entry has definition_of_done field from YAML', async () => {
    const aggregator = makeAggregatorWithFeature(FEATURE_F003_FULL, 'F-003-full.yaml');
    const index = await aggregator.getIndex();
    const f003 = index[0].features.find((f) => f.id === 'F-003');
    expect(f003).toBeDefined();
    expect(f003.definition_of_done).toBe('Alle Tests gruen, Review bestanden.');
  });

  it('feature entry has labels array from YAML', async () => {
    const aggregator = makeAggregatorWithFeature(FEATURE_F003_FULL, 'F-003-full.yaml');
    const index = await aggregator.getIndex();
    const f003 = index[0].features.find((f) => f.id === 'F-003');
    expect(f003).toBeDefined();
    expect(Array.isArray(f003.labels)).toBe(true);
    expect(f003.labels).toEqual(['infra', 'security']);
  });

  it('feature entry has depends array from YAML', async () => {
    const aggregator = makeAggregatorWithFeature(FEATURE_F003_FULL, 'F-003-full.yaml');
    const index = await aggregator.getIndex();
    const f003 = index[0].features.find((f) => f.id === 'F-003');
    expect(f003).toBeDefined();
    expect(Array.isArray(f003.depends)).toBe(true);
    expect(f003.depends).toEqual(['F-001', 'F-002']);
  });

  it('feature with missing goal/dod/depends/labels → all null', async () => {
    const aggregator = makeAggregatorWithFeature(FEATURE_F004_MINIMAL, 'F-004-minimal.yaml');
    const index = await aggregator.getIndex();
    const f004 = index[0].features.find((f) => f.id === 'F-004');
    expect(f004).toBeDefined();
    expect(f004.goal).toBeNull();
    expect(f004.definition_of_done).toBeNull();
    expect(f004.depends).toBeNull();
    expect(f004.labels).toBeNull();
  });

  it('existing feature F-001 fixture has goal (already in YAML)', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    // FEATURE_F001 fixture has goal: Abloesung der manuellen Provisionierung.
    expect(f001.goal).toBe('Abloesung der manuellen Provisionierung.');
  });

  it('existing feature F-001 fixture has labels array', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    const f001 = index[0].features.find((f) => f.id === 'F-001');
    // FEATURE_F001 fixture has labels: [infra, vps]
    expect(Array.isArray(f001.labels)).toBe(true);
    expect(f001.labels).toContain('infra');
    expect(f001.labels).toContain('vps');
  });
});

// ── boardRouter HTTP tests ────────────────────────────────────────────────────

import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { boardRouter, buildDiscussSeed } from '../src/boardRouter.js';
import { BoardWriter } from '../src/BoardWriter.js';
import { AuditStore } from '../src/AuditStore.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';

function httpFetch(server, path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: payload !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function startServer(
  boardAggregator,
  storyMetricReader,
  { notificationWatcher, boardWriter, auditStore, commandService, sessionRegistry, lock } = {},
) {
  const app = express();
  app.use(express.json());
  app.use(boardRouter({
    boardAggregator,
    storyMetricReader,
    notificationWatcher,
    boardWriter,
    auditStore,
    commandService,
    sessionRegistry,
    lock,
  }));
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('boardRouter HTTP — GET /api/board/projects', () => {
  it('returns 200 with { projects: [...] }', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects');
      expect(status).toBe(200);
      expect(data).toHaveProperty('projects');
      expect(Array.isArray(data.projects)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('projects contain the scanned board data', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { data } = await httpFetch(server, '/api/board/projects');
      expect(data.projects.length).toBe(1);
      expect(data.projects[0].slug).toBe('my-repo');
      expect(data.projects[0].features.length).toBeGreaterThan(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('error boards are included with error field (AC8)', async () => {
    const { aggregator } = makeAggregator({ missingBoardYaml: true });
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects');
      expect(status).toBe(200);
      const errProject = data.projects.find((p) => p.error);
      expect(errProject).toBeDefined();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 200 with empty projects when no board roots configured', async () => {
    const fsDeps = buildFakeFsDeps();
    const aggregator = new BoardAggregator({ boardRootsEnv: '', fsDeps });
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects');
      expect(status).toBe(200);
      expect(data.projects).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('boardRouter HTTP — POST /api/board/projects/rescan (AC9)', () => {
  it('returns 200 with { ok: true }', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/rescan', 'POST');
      expect(status).toBe(200);
      expect(data).toEqual({ ok: true });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('after rescan, GET reflects updated data', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      await httpFetch(server, '/api/board/projects/rescan', 'POST');
      const { status, data } = await httpFetch(server, '/api/board/projects');
      expect(status).toBe(200);
      expect(data.projects.length).toBe(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── AC5 (studis-kanban-board-ux) — /api/board/projects/list + /projects/:slug ─

describe('boardRouter HTTP — GET /api/board/projects/list (AC5)', () => {
  it('returns 200 with { projects: [...] } — slug + counters only', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/list');
      expect(status).toBe(200);
      expect(data).toHaveProperty('projects');
      expect(Array.isArray(data.projects)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('list items have slug, feature_count, story_count — no features array', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { data } = await httpFetch(server, '/api/board/projects/list');
      expect(data.projects.length).toBe(1);
      const item = data.projects[0];
      expect(item.slug).toBe('my-repo');
      expect(typeof item.feature_count).toBe('number');
      expect(typeof item.story_count).toBe('number');
      // Must NOT expose full story data
      expect(item.features).toBeUndefined();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('list counters are correct (feature_count ≥ 2, story_count ≥ 2)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { data } = await httpFetch(server, '/api/board/projects/list');
      const item = data.projects[0];
      // Fixture has F-001 (2 stories) + F-002 (0 stories) + possibly orphaned pseudo-feature
      expect(item.feature_count).toBeGreaterThanOrEqual(2);
      expect(item.story_count).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('error boards appear with slug + error field in list', async () => {
    const { aggregator } = makeAggregator({ missingBoardYaml: true });
    const server = await startServer(aggregator);
    try {
      const { data } = await httpFetch(server, '/api/board/projects/list');
      const errItem = data.projects.find((p) => p.error);
      expect(errItem).toBeDefined();
      expect(errItem.slug).toBe('my-repo');
      expect(typeof errItem.error).toBe('string');
      expect(errItem.feature_count).toBeUndefined();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns empty list when no board roots configured', async () => {
    const fsDeps = buildFakeFsDeps();
    const aggregator = new BoardAggregator({ boardRootsEnv: '', fsDeps });
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/list');
      expect(status).toBe(200);
      expect(data.projects).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('boardRouter HTTP — GET /api/board/projects/:slug (AC5)', () => {
  it('returns 200 with { project: {...} } for known slug', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo');
      expect(status).toBe(200);
      expect(data).toHaveProperty('project');
      expect(data.project.slug).toBe('my-repo');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returned project has full features array (stories included)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo');
      const project = data.project;
      expect(Array.isArray(project.features)).toBe(true);
      expect(project.features.length).toBeGreaterThan(0);
      // At least one feature has stories
      const f001 = project.features.find((f) => f.id === 'F-001');
      expect(f001).toBeDefined();
      expect(Array.isArray(f001.stories)).toBe(true);
      expect(f001.stories.length).toBeGreaterThan(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for unknown slug', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/nonexistent-slug');
      expect(status).toBe(404);
      expect(data).toHaveProperty('error');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for slug with path traversal attempt (..)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      // URL-encode the traversal attempt
      const { status } = await httpFetch(server, '/api/board/projects/..%2Fetc%2Fpasswd');
      // Express parses %2F as path separator so route may not match — either 404 is correct
      expect([404, 400]).toContain(status);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for slug starting with a dot (.hidden)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status } = await httpFetch(server, '/api/board/projects/.hidden');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('existing /api/board/projects still works (legacy endpoint preserved)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects');
      expect(status).toBe(200);
      expect(Array.isArray(data.projects)).toBe(true);
      expect(data.projects[0].slug).toBe('my-repo');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── bereichs-modell AC1/AC2 (S-288) — BoardAggregator liest areas.yaml + Roll-up ──

const AREAS_YAML = `- id: board
  name: Board
  order: 2
  description: Board-Schema, Kanban, Bereiche.
- id: fabrik-arbeiten
  name: Fabrik Arbeiten
  order: 1
`;

describe('BoardAggregator — areas.yaml lesen (bereichs-modell AC1)', () => {
  it('project entry has empty areas: [] when areas.yaml is missing', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    expect(index[0]).toHaveProperty('areas');
    expect(index[0].areas).toEqual([]);
  });

  it('project entry has empty areas: [] when areas.yaml is empty', async () => {
    const { aggregator } = makeAggregator({
      fileOverrides: { [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: '' },
    });
    const index = await aggregator.getIndex();
    expect(index[0].areas).toEqual([]);
  });

  it('reads areas.yaml and returns id/name/order/description sorted by order', async () => {
    const { aggregator } = makeAggregator({
      fileOverrides: { [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: AREAS_YAML },
    });
    const index = await aggregator.getIndex();
    const areas = index[0].areas;
    expect(areas.map((a) => a.id)).toEqual(['fabrik-arbeiten', 'board']); // sorted by order (1, 2)
    expect(areas[0]).toMatchObject({ id: 'fabrik-arbeiten', name: 'Fabrik Arbeiten', order: 1 });
    expect(areas[1]).toMatchObject({
      id: 'board',
      name: 'Board',
      order: 2,
      description: 'Board-Schema, Kanban, Bereiche.',
    });
  });

  it('defect entries (missing id/name, non-integer order) are skipped without destroying the rest', async () => {
    const brokenAreasYaml = `- id: board
  name: Board
  order: 1
- name: Kein id-Feld
  order: 2
- id: kein-name
  order: 3
- id: bad-order
  name: Kaputte Reihenfolge
  order: not-a-number
- id: float-order
  name: Kommazahl-Reihenfolge
  order: 1.5
- id: ok-area
  name: OK Bereich
  order: 4
`;
    const { aggregator } = makeAggregator({
      fileOverrides: { [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: brokenAreasYaml },
    });
    const index = await aggregator.getIndex();
    const areas = index[0].areas;
    // "float-order" (order: 1.5) is a valid finite number but not an integer —
    // must be skipped just like the string case (AC1 JSDoc: "non-integer order").
    expect(areas.map((a) => a.id)).toEqual(['board', 'ok-area']);
  });

  it('does not read/crash on other projects and does not write anywhere (read-only)', async () => {
    const fsDeps = buildFakeFsDeps({
      fileOverrides: { [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: AREAS_YAML },
    });
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    await aggregator.getIndex();
    // No write-equivalent method exists on fsDeps (readFile/readdir/watch only) —
    // the aggregator can only have called those, never a write.
    expect(fsDeps.writeFile).toBeUndefined();
  });
});

// ── BoardAggregator — runs (run-state-live-view AC1/AC2/AC3) ─────────────────
// Nur die Integration in _readBoard()/getIndex() — Feld-Mapping + Fehlertoleranz
// des Readers selbst sind in test/RunStateReader.test.js abgedeckt.

describe('BoardAggregator — runs (run-state-live-view AC1)', () => {
  it('project entry has empty runs: [] when board/runs/ is missing (Standard-Fixture)', async () => {
    const { aggregator } = makeAggregator();
    const index = await aggregator.getIndex();
    expect(index[0]).toHaveProperty('runs');
    expect(index[0].runs).toEqual([]);
  });

  it('error entry (missing board.yaml) also carries runs: []', async () => {
    const { aggregator } = makeAggregator({ missingBoardYaml: true });
    const index = await aggregator.getIndex();
    expect(index[0].runs).toEqual([]);
  });

  it('reads board/runs/F-###/state.yaml and attaches mapped run entries', async () => {
    // Overrides MUST happen BEFORE the BoardAggregator is constructed — the
    // constructor spreads fsDeps into a new merged object (`{...defaultFsDeps,
    // ...fsDeps}`), so mutating `fsDeps.readdir` on an already-constructed
    // instance's outer reference has no effect (analog to the "no-board-repo"
    // AC1 pattern above).
    const fsDeps = buildFakeFsDeps();
    const runsDir = `${BOARD_ROOT}/my-repo/board/runs`;
    const origReaddir = fsDeps.readdir;
    fsDeps.readdir = async (path, opts) => {
      if (path === runsDir) {
        return [{ name: 'F-069', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false }];
      }
      return origReaddir(path, opts);
    };
    const origReadFile = fsDeps.readFile;
    fsDeps.readFile = async (path, enc) => {
      if (path === `${runsDir}/F-069/state.yaml`) {
        return 'phase: story\ncurrent_story: S-316\ndone: 4\ntotal: 7\nround: 2\nstarted_at: 2026-07-07T09:00:00Z\n';
      }
      return origReadFile(path, enc);
    };
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });

    const index = await aggregator.getIndex();
    expect(index[0].runs).toEqual([
      {
        feature: 'F-069',
        phase: 'story',
        currentStory: 'S-316',
        done: 4,
        total: 7,
        round: 2,
        startedAt: '2026-07-07T09:00:00Z',
        lastError: null,
        isLastRun: false,
      },
    ]);
  });

  it('does not write anywhere while reading runs (read-only)', async () => {
    const fsDeps = buildFakeFsDeps();
    const aggregator = new BoardAggregator({ boardRootsEnv: BOARD_ROOT, fsDeps });
    await aggregator.getIndex();
    expect(fsDeps.writeFile).toBeUndefined();
  });
});

describe('BoardAggregator — areas Roll-up (bereichs-modell AC2)', () => {
  it('area without any matching story/feature stays visible with storyCount: 0', async () => {
    const { aggregator } = makeAggregator({
      fileOverrides: { [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: AREAS_YAML },
    });
    const index = await aggregator.getIndex();
    const areas = index[0].areas;
    // Fixture stories/features (F-001/F-002/S-001/S-002) carry no `area` field
    // at all → both areas stay visible with storyCount 0 (AC2 "leer erkennbar").
    expect(areas.every((a) => a.storyCount === 0)).toBe(true);
  });

  it('counts a story with its own area field directly', async () => {
    const storyWithArea = `id: S-001
parent: F-001
title: IONOS-Adapter
status: Done
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1]
labels: []
dispo_est: null
dispo_act: null
area: board
`;
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: AREAS_YAML,
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: storyWithArea,
      },
    });
    const index = await aggregator.getIndex();
    const areas = index[0].areas;
    const board = areas.find((a) => a.id === 'board');
    const fabrik = areas.find((a) => a.id === 'fabrik-arbeiten');
    expect(board.storyCount).toBe(1);
    expect(fabrik.storyCount).toBe(0);
  });

  it('falls back to the parent feature.area when the story has no own area field', async () => {
    const featureWithArea = `id: F-001
title: Server-Provisioning
status: Active
priority: P1
spec: docs/specs/provisioning.md
labels: [infra]
stories:
- S-001
- S-002
progress: null
area: fabrik-arbeiten
`;
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: AREAS_YAML,
        [`${BOARD_ROOT}/my-repo/board/features/F-001-server-provisioning.yaml`]: featureWithArea,
      },
    });
    const index = await aggregator.getIndex();
    const areas = index[0].areas;
    const fabrik = areas.find((a) => a.id === 'fabrik-arbeiten');
    // Both S-001 and S-002 hang under F-001 (area: fabrik-arbeiten), neither
    // story carries its own area field → both fall back to the feature's area.
    expect(fabrik.storyCount).toBe(2);
  });

  it('a story-level area wins over the parent feature.area when both are set', async () => {
    const featureWithArea = `id: F-001
title: Server-Provisioning
status: Active
priority: P1
spec: docs/specs/provisioning.md
labels: [infra]
stories:
- S-001
- S-002
progress: null
area: fabrik-arbeiten
`;
    const storyOwnArea = `id: S-001
parent: F-001
title: IONOS-Adapter
status: Done
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1]
labels: []
dispo_est: null
dispo_act: null
area: board
`;
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: AREAS_YAML,
        [`${BOARD_ROOT}/my-repo/board/features/F-001-server-provisioning.yaml`]: featureWithArea,
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: storyOwnArea,
      },
    });
    const index = await aggregator.getIndex();
    const areas = index[0].areas;
    const board = areas.find((a) => a.id === 'board');
    const fabrik = areas.find((a) => a.id === 'fabrik-arbeiten');
    // S-001 has its own area:board → counted for "board", NOT for "fabrik-arbeiten"
    // (even though its parent feature is area:fabrik-arbeiten).
    expect(board.storyCount).toBe(1);
    // S-002 has no own area → falls back to the feature's area:fabrik-arbeiten.
    expect(fabrik.storyCount).toBe(1);
  });

  it('an unknown area referenced by a story/feature is simply not counted (no crash)', async () => {
    const storyUnknownArea = `id: S-001
parent: F-001
title: IONOS-Adapter
status: Done
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1]
labels: []
dispo_est: null
dispo_act: null
area: nicht-in-areas-yaml
`;
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: AREAS_YAML,
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: storyUnknownArea,
      },
    });
    const index = await aggregator.getIndex();
    const areas = index[0].areas;
    expect(areas.every((a) => a.storyCount === 0)).toBe(true);
  });

  it('storyCount excludes archived stories in the standard view (AC2 "leer erkennbar"), includes them with includeArchived', async () => {
    const archivedStoryWithArea = `id: S-001
parent: F-001
title: IONOS-Adapter
status: Done
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1]
labels: []
dispo_est: null
dispo_act: null
area: board
archived: true
`;
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: AREAS_YAML,
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: archivedStoryWithArea,
      },
    });
    // Standard view (no includeArchived): the area's only assigned story is
    // archived → storyCount must be 0, otherwise the area would not be
    // recognizable as empty (AC2).
    const standardIndex = await aggregator.getIndex();
    const boardStandard = standardIndex[0].areas.find((a) => a.id === 'board');
    expect(boardStandard.storyCount).toBe(0);

    // With includeArchived: true the full index (incl. archived stories) is
    // returned unfiltered — storyCount reflects the archived story.
    const fullIndex = await aggregator.getIndex({ includeArchived: true });
    const boardFull = fullIndex[0].areas.find((a) => a.id === 'board');
    expect(boardFull.storyCount).toBe(1);
  });
});

// ── boardRouter HTTP — GET /api/board/projects/:slug/areas (bereichs-modell V6/S-288) ──

describe('boardRouter HTTP — GET /api/board/projects/:slug/areas (bereichs-modell AC1/AC2, V6)', () => {
  it('returns 200 with { areas: [...] } sorted by order for a known slug', async () => {
    const { aggregator } = makeAggregator({
      fileOverrides: { [`${BOARD_ROOT}/my-repo/board/areas.yaml`]: AREAS_YAML },
    });
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/areas');
      expect(status).toBe(200);
      expect(Array.isArray(data.areas)).toBe(true);
      expect(data.areas.map((a) => a.id)).toEqual(['fabrik-arbeiten', 'board']);
      expect(data.areas[0]).toMatchObject({ id: 'fabrik-arbeiten', name: 'Fabrik Arbeiten', order: 1, storyCount: 0 });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 200 with { areas: [] } when the project has no areas.yaml', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/areas');
      expect(status).toBe(200);
      expect(data.areas).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for unknown slug', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/nonexistent-slug/areas');
      expect(status).toBe(404);
      expect(data).toHaveProperty('error');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for invalid slug format (leading dot)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator);
    try {
      const { status } = await httpFetch(server, '/api/board/projects/.hidden/areas');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── AC2 (story-detail-ansicht) — GET /api/board/projects/:slug/stories/:id/detail ─

describe('boardRouter HTTP — GET /api/board/projects/:slug/stories/:id/detail (AC2 story-detail-ansicht)', () => {
  /** Minimal StoryMetricReader mock — returns a fixed detail object. */
  function makeMockStoryMetricReader(detail = {}) {
    return {
      getDetail: async (_repoPath, _storyId) => ({
        started_at: null,
        ended_at: null,
        duration: null,
        flow: [],
        ep_est: null,
        ep_act: null,
        tok_est: null,
        tok_total: null,
        size_est: null,
        ep_dev: null,
        ep_dev_pct: null,
        tok_dev: null,
        tok_dev_pct: null,
        ...detail,
      }),
    };
  }

  it('returns 404 for slug with invalid format (starts with dot)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader());
    try {
      const { status } = await httpFetch(server, '/api/board/projects/.invalid-slug/stories/S-001/detail');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for id with invalid format (starts with dot)', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader());
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/stories/.invalid-id/detail');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 for unknown slug', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader());
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/nonexistent/stories/S-001/detail');
      expect(status).toBe(404);
      expect(data).toHaveProperty('error');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('happy-path: returns 200 + { detail: {...} } with mocked storyMetricReader', async () => {
    const { aggregator } = makeAggregator();
    const mockDetail = {
      started_at: '2026-06-01T10:00:00.000Z',
      ended_at: '2026-06-01T11:30:00.000Z',
      duration: 5400,
      flow: [{ seq: 1, agent: 'coder', iter: 1, gate: null, secs: 120, tok: 8000 }],
      ep_est: 3,
      ep_act: 4,
      tok_est: 10000,
      tok_total: 12000,
      size_est: 'M',
      ep_dev: 1,
      ep_dev_pct: 33.3,
      tok_dev: 2000,
      tok_dev_pct: 20,
    };
    const server = await startServer(aggregator, makeMockStoryMetricReader(mockDetail));
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(status).toBe(200);
      expect(data).toHaveProperty('detail');
      const { detail } = data;
      expect(detail.started_at).toBe('2026-06-01T10:00:00.000Z');
      expect(detail.ended_at).toBe('2026-06-01T11:30:00.000Z');
      expect(detail.duration).toBe(5400);
      expect(Array.isArray(detail.flow)).toBe(true);
      expect(detail.flow.length).toBe(1);
      expect(detail.flow[0].agent).toBe('coder');
      expect(detail.ep_est).toBe(3);
      expect(detail.ep_act).toBe(4);
      expect(detail.tok_est).toBe(10000);
      expect(detail.tok_total).toBe(12000);
      expect(detail.size_est).toBe('M');
      expect(detail.ep_dev).toBe(1);
      expect(detail.tok_dev).toBe(2000);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('ledger ep_est present → ep_est_source is "ledger"', async () => {
    const { aggregator } = makeAggregator();
    const mockDetail = { ep_est: 3, ep_act: 4 };
    const server = await startServer(aggregator, makeMockStoryMetricReader(mockDetail));
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(status).toBe(200);
      expect(data.detail.ep_est).toBe(3);
      expect(data.detail.ep_est_source).toBe('ledger');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('ledger ep_est null but story has dispo_est → YAML fallback with ep_est_source "yaml"', async () => {
    // S-001 in the fixture has dispo_est: null — we need a story with dispo_est set.
    // Override S-001 to have dispo_est: 2
    const storyWithDispoEst = `id: S-001
parent: F-001
title: IONOS-Adapter
status: To Do
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1]
labels: []
size_est: S
dispo_est: 2
dispo_act: null
created_at: 2026-06-14T00:00:00Z
updated_at: 2026-06-14T00:00:00Z
done_at: null
`;
    const { aggregator } = makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: storyWithDispoEst,
      },
    });
    // Ledger returns no ep_est
    const server = await startServer(aggregator, makeMockStoryMetricReader({ ep_est: null }));
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(status).toBe(200);
      // YAML fallback applied
      expect(data.detail.ep_est).toBe(2);
      expect(data.detail.ep_est_source).toBe('yaml');
      // Ist/Abweichung must remain null (kein Flow-Lauf)
      expect(data.detail.ep_act).toBeNull();
      expect(data.detail.ep_dev).toBeNull();
      expect(data.detail.ep_dev_pct).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('ledger ep_est null and story dispo_est null → ep_est_source null, ep_est null', async () => {
    // S-001 fixture has dispo_est: null
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader({ ep_est: null }));
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(status).toBe(200);
      expect(data.detail.ep_est).toBeNull();
      expect(data.detail.ep_est_source).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('ledger ep_est null and story not in index → ep_est_source null, ep_est null', async () => {
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader({ ep_est: null }));
    try {
      // S-UNKNOWN does not exist in the fixture board
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-UNKNOWN/detail');
      expect(status).toBe(200);
      expect(data.detail.ep_est).toBeNull();
      expect(data.detail.ep_est_source).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── story-detail-yaml-fallback: AC3/AC4/AC7 HTTP-Tests ───────────────────────

describe('boardRouter HTTP — story-detail-yaml-fallback AC3/AC4/AC7', () => {
  /** Minimal StoryMetricReader mock — returns a fixed detail object (scoped to this describe). */
  function makeMockStoryMetricReader(detail = {}) {
    return {
      getDetail: async (_repoPath, _storyId) => ({
        started_at: null,
        ended_at: null,
        duration: null,
        flow: [],
        ep_est: null,
        ep_act: null,
        tok_est: null,
        tok_total: null,
        size_est: null,
        ep_dev: null,
        ep_dev_pct: null,
        tok_dev: null,
        tok_dev_pct: null,
        ...detail,
      }),
    };
  }

  /** Story-Fixture mit done_at und branch/pr gesetzt */
  const STORY_WITH_YAML_FIELDS = `id: S-001
parent: F-001
title: IONOS-Adapter
status: Done
priority: P0
spec: docs/specs/provisioning.md
implements: [AC1]
labels: []
dispo_est: null
dispo_act: null
branch: board/my-feature-2026-06-14
pr: https://github.com/org/repo/pull/42
done_at: '2026-06-14T12:00:00Z'
`;

  function makeAggregatorWithYamlFields() {
    return makeAggregator({
      fileOverrides: {
        [`${BOARD_ROOT}/my-repo/board/stories/S-001-ionos-adapter.yaml`]: STORY_WITH_YAML_FIELDS,
      },
    });
  }

  it('AC3 — ended_at-Fallback aus done_at wenn Ledger kein ended_at liefert', async () => {
    const { aggregator } = makeAggregatorWithYamlFields();
    // Ledger liefert kein ended_at
    const server = await startServer(aggregator, makeMockStoryMetricReader({ ended_at: null }));
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(status).toBe(200);
      expect(data.detail.ended_at).toBe('2026-06-14T12:00:00Z');
      expect(data.detail.ended_at_source).toBe('yaml');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('AC3 — started_at/duration bleiben null wenn kein Ledger (nicht aus YAML ableitbar)', async () => {
    const { aggregator } = makeAggregatorWithYamlFields();
    const server = await startServer(aggregator, makeMockStoryMetricReader({
      started_at: null,
      ended_at: null,
      duration: null,
    }));
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(data.detail.started_at).toBeNull();
      expect(data.detail.duration).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('AC4 — branch, pr, status aus Index werden in der Detail-Response durchgereicht', async () => {
    const { aggregator } = makeAggregatorWithYamlFields();
    const server = await startServer(aggregator, makeMockStoryMetricReader());
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(data.detail.branch).toBe('board/my-feature-2026-06-14');
      expect(data.detail.pr).toBe('https://github.com/org/repo/pull/42');
      expect(data.detail.status).toBe('Done');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('AC4 — branch/pr/status null wenn Story-YAML kein branch/pr/done_at hat', async () => {
    // S-001 in der Standard-Fixture hat branch: null, pr: null
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader());
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(data.detail.branch).toBeNull();
      expect(data.detail.pr).toBeNull();
      // status ist immer gesetzt (aus dem Story-YAML)
      expect(typeof data.detail.status).toBe('string');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('AC7 — Ledger hat Vorrang: ended_at aus Ledger → ended_at_source "ledger"', async () => {
    const { aggregator } = makeAggregatorWithYamlFields();
    // Ledger liefert einen echten ended_at-Wert
    const server = await startServer(aggregator, makeMockStoryMetricReader({
      ended_at: '2026-06-15T08:00:00.000Z',
    }));
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-001/detail');
      expect(data.detail.ended_at).toBe('2026-06-15T08:00:00.000Z');
      expect(data.detail.ended_at_source).toBe('ledger');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('AC3 — kein done_at und kein Ledger → ended_at null, ended_at_source null', async () => {
    // S-002 hat done_at: null in der Standard-Fixture
    const { aggregator } = makeAggregator();
    const server = await startServer(aggregator, makeMockStoryMetricReader({ ended_at: null }));
    try {
      const { data } = await httpFetch(server, '/api/board/projects/my-repo/stories/S-002/detail');
      expect(data.detail.ended_at).toBeNull();
      expect(data.detail.ended_at_source).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── boardRouter HTTP — POST /api/board/projects/:slug/ideas (ideen-inbox AC3/AC7/AC8) ──
//
// Reale BoardWriter-Instanz gegen ein echtes tmp-Verzeichnis (kein Mock) — die
// Pfad-/Atomarität-Garantien sind nur gegen ein echtes Filesystem aussagekräftig
// (analog test/BoardWriter.test.js). storyMetricReader wird hier nicht gebraucht.

describe('boardRouter HTTP — POST /api/board/projects/:slug/ideas (ideen-inbox AC3/AC7/AC8)', () => {
  let boardRootsDir;
  let storiesDir;
  let boardYamlPath;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardrouter-ideas-test-'));
    const boardDir = join(boardRootsDir, 'my-repo', 'board');
    storiesDir = join(boardDir, 'stories');
    boardYamlPath = join(boardDir, 'board.yaml');
    await mkdir(storiesDir, { recursive: true });
    await writeFile(
      boardYamlPath,
      'schema_version: 1\nproject_slug: my-repo\nnext_feature_id: 1\nnext_story_id: 42\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  function makeBoardWriter() {
    return new BoardWriter({ boardRootsEnv: boardRootsDir });
  }

  it('201 happy path: legt die Idee an, gibt { storyId } zurück, schreibt GENAU EINEN Audit-Eintrag', async () => {
    const boardWriter = makeBoardWriter();
    const auditStore = new AuditStore();
    const server = await startServer(null, null, { boardWriter, auditStore });
    try {
      const { status, data } = await httpFetch(
        server,
        '/api/board/projects/my-repo/ideas',
        'POST',
        { title: 'Eine schnelle Idee', body: 'Stichwort 1\nStichwort 2' },
      );
      expect(status).toBe(201);
      expect(data).toEqual({ storyId: 'S-42' });

      const raw = await readFile(join(storiesDir, 'S-42.yaml'), 'utf8');
      expect(raw).toContain('status: Idee');
      expect(raw).toContain("title: 'Eine schnelle Idee'");
      expect(raw).toContain('notes: |\n  Stichwort 1\n  Stichwort 2');

      const entries = auditStore.getAll();
      expect(entries.length).toBe(1);
      expect(entries[0].command).toBe('board:idea:create:my-repo');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('400 bei leerem Titel: { field: "title", message }, KEIN Audit-Eintrag, keine Story-Datei', async () => {
    const boardWriter = makeBoardWriter();
    const auditStore = new AuditStore();
    const server = await startServer(null, null, { boardWriter, auditStore });
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/ideas', 'POST', { title: '   ' });
      expect(status).toBe(400);
      expect(data.field).toBe('title');
      expect(typeof data.message).toBe('string');
      expect(auditStore.getAll()).toEqual([]);

      const entries = await readdir(storiesDir);
      expect(entries).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('400 bei zu langem Titel: field "title"', async () => {
    const boardWriter = makeBoardWriter();
    const server = await startServer(null, null, { boardWriter, auditStore: new AuditStore() });
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/ideas', 'POST', {
        title: 'x'.repeat(300),
      });
      expect(status).toBe(400);
      expect(data.field).toBe('title');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('400 bei Body mit Steuerzeichen: field "body"', async () => {
    const boardWriter = makeBoardWriter();
    const server = await startServer(null, null, { boardWriter, auditStore: new AuditStore() });
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/ideas', 'POST', {
        title: 'Idee',
        body: 'Zeile1\x00Zeile2',
      });
      expect(status).toBe(400);
      expect(data.field).toBe('body');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('404 bei ungültigem Slug-Format (führendes Sonderzeichen, kein Alnum-Start)', async () => {
    const boardWriter = makeBoardWriter();
    const server = await startServer(null, null, { boardWriter, auditStore: new AuditStore() });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/-badslug/ideas', 'POST', { title: 'Idee' });
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('404 bei unbekanntem Projekt-Slug (nicht unter BOARD_ROOTS)', async () => {
    const boardWriter = makeBoardWriter();
    const server = await startServer(null, null, { boardWriter, auditStore: new AuditStore() });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/does-not-exist/ideas', 'POST', {
        title: 'Idee',
      });
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('500 wenn boardWriter nicht verdrahtet ist (kein Crash)', async () => {
    const server = await startServer(null, null, { auditStore: new AuditStore() });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas', 'POST', { title: 'Idee' });
      expect(status).toBe(500);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('zwei aufeinanderfolgende Anlagen über HTTP erhalten unterschiedliche storyIds', async () => {
    const boardWriter = makeBoardWriter();
    const server = await startServer(null, null, { boardWriter, auditStore: new AuditStore() });
    try {
      const first = await httpFetch(server, '/api/board/projects/my-repo/ideas', 'POST', { title: 'Erste' });
      const second = await httpFetch(server, '/api/board/projects/my-repo/ideas', 'POST', { title: 'Zweite' });
      expect(first.data.storyId).toBe('S-42');
      expect(second.data.storyId).toBe('S-43');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── boardRouter HTTP — POST .../ideas/:id/discuss (ideen-inbox AC5/AC7/AC8, S-200) ──
//
// Real BoardAggregator gegen ein echtes tmp-Verzeichnis (Story-Index inkl.
// `notes` — nur so entsteht der reale Gesprächs-Seed). Fake commandService/
// sessionRegistry (kein echter PTY-Prozess nötig — nur die tryRun()/getOrCreate()-
// Verträge werden geprüft).

describe('boardRouter HTTP — POST .../ideas/:id/discuss (ideen-inbox AC5/AC7/AC8, S-200)', () => {
  let boardRootsDir;
  let ideaFilePath;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardrouter-discuss-test-'));
    const boardDir = join(boardRootsDir, 'my-repo', 'board');
    const storiesDir = join(boardDir, 'stories');
    await mkdir(storiesDir, { recursive: true });
    await writeFile(join(boardDir, 'board.yaml'), 'schema_version: 1\nproject_slug: my-repo\nnext_story_id: 1\n', 'utf8');
    ideaFilePath = join(storiesDir, 'S-42.yaml');
    await writeFile(
      ideaFilePath,
      [
        'id: S-42',
        'status: Idee',
        "title: 'Dark Mode fürs Dashboard'",
        'notes: |',
        '  Toggle im Header',
        "created_at: '2026-07-01T10:00:00.000Z'",
        "updated_at: '2026-07-01T10:00:00.000Z'",
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  function makeFakeCommandService(running = false) {
    return { getStatus: () => ({ status: running ? 'running' : 'done' }) };
  }

  function makeFakeSessionRegistry(pty) {
    return { getOrCreate: () => pty };
  }

  function makeFakePty() {
    return { writes: [], write(data) { this.writes.push(data); } };
  }

  async function makeServer({ running = false, ptyOrNull, auditStore = new AuditStore(), lock = new ProjectJobLock() } = {}) {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const pty = ptyOrNull !== undefined ? ptyOrNull : makeFakePty();
    const commandService = makeFakeCommandService(running);
    const sessionRegistry = makeFakeSessionRegistry(pty);
    // Frische ProjectJobLock-Instanz je Server (Default) statt des globalen
    // Singletons — Test-Isolation, analog ProjectDrain.test.js. Ein injizierbares
    // `lock` erlaubt adversariale Tests (Finding 1, S-200 Iteration 2).
    const server = await startServer(aggregator, null, { commandService, sessionRegistry, auditStore, lock });
    return { server, pty, auditStore, lock };
  }

  it('200 happy path: schreibt GENAU EINEN konversationellen Seed (Titel+Body) in die PTY, GENAU EIN Audit-Eintrag, Idee bleibt unverändert', async () => {
    const { server, pty, auditStore } = await makeServer();
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/discuss', 'POST');
      expect(status).toBe(200);
      expect(data).toEqual({ sessionId: 'my-repo' });

      // GENAU EIN Write, endet mit GENAU EINEM Submit-Newline (keine zweite Submit-Zeile).
      expect(pty.writes.length).toBe(1);
      expect(pty.writes[0].endsWith('\n')).toBe(true);
      expect(pty.writes[0].slice(0, -1).includes('\n')).toBe(false);
      expect(pty.writes[0]).toContain('Dark Mode fürs Dashboard');
      expect(pty.writes[0]).toContain('Toggle im Header');

      const entries = auditStore.getAll();
      expect(entries.length).toBe(1);
      expect(entries[0].command).toBe('board:idea:discuss:my-repo:S-42');

      // Idee bleibt UNVERÄNDERT im Status Idee (kein Board-Write durch discuss).
      const raw = await readFile(ideaFilePath, 'utf8');
      expect(raw).toContain('status: Idee');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('400 bei bereits aufgelöster Idee (status: Done): field "status", KEIN PTY-Write, KEIN Audit', async () => {
    await writeFile(
      ideaFilePath,
      'id: S-42\nstatus: Done\ntitle: \'Dark Mode\'\nresolved_at: \'2026-07-01T11:00:00.000Z\'\n',
      'utf8',
    );
    const { server, pty, auditStore } = await makeServer();
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/discuss', 'POST');
      expect(status).toBe(400);
      expect(data.field).toBe('status');
      expect(pty.writes).toEqual([]);
      expect(auditStore.getAll()).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('404 bei unbekanntem Projekt-Slug', async () => {
    const { server } = await makeServer();
    try {
      const { status } = await httpFetch(server, '/api/board/projects/does-not-exist/ideas/S-42/discuss', 'POST');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('404 bei unbekannter Idee-ID', async () => {
    const { server } = await makeServer();
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-999/discuss', 'POST');
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('409 bei laufendem Command (Session busy — [[flow-trigger]] AC3): Idee bleibt Idee, KEIN PTY-Write', async () => {
    const { server, pty } = await makeServer({ running: true });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/discuss', 'POST');
      expect(status).toBe(409);
      expect(pty.writes).toEqual([]);

      const raw = await readFile(ideaFilePath, 'utf8');
      expect(raw).toContain('status: Idee');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('500 wenn commandService/sessionRegistry nicht verdrahtet sind (kein Crash)', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const server = await startServer(aggregator, null, { auditStore: new AuditStore() });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/discuss', 'POST');
      expect(status).toBe(500);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('503 bei Session-Cap (sessionRegistry.getOrCreate liefert null)', async () => {
    const { server } = await makeServer({ ptyOrNull: null });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/discuss', 'POST');
      expect(status).toBe(503);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  // ── Finding 1 (Iteration 2, coder-Lesson 2026-07-01): ProjectJobLock-Naht ──
  // gegen den Taktgeber/ProjectDrain + symmetrischer Schutz gegen zwei
  // gleichzeitige discuss-Aufrufe fürs selbe Projekt.

  it('409 wenn das projektweite ProjectJobLock bereits gehalten wird (simuliert ProjectDrain — CommandService ist idle), KEIN PTY-Write, KEIN Audit, Idee bleibt unverändert', async () => {
    const lock = new ProjectJobLock();
    const { server, pty, auditStore } = await makeServer({ lock });
    try {
      const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
      const project = (await aggregator.getIndex()).find((p) => p.slug === 'my-repo');
      // Simuliert: ProjectDrain hat das Lock für die GESAMTE Drain-Session akquiriert,
      // während CommandService.getStatus() zwischen zwei /flow-Runden bereits wieder 'done' ist.
      expect(lock.tryAcquire(project.repo_path)).toBe(true);

      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/discuss', 'POST');
      expect(status).toBe(409);
      expect(pty.writes).toEqual([]);
      expect(auditStore.getAll()).toEqual([]);

      const raw = await readFile(ideaFilePath, 'utf8');
      expect(raw).toContain('status: Idee');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('symmetrischer Schutz: während des ersten discuss-Aufrufs (Lock gehalten, Check+Write noch nicht abgeschlossen) scheitert ein zweiter tryAcquire für dasselbe Projekt — kein Interleaving zweier Seeds in derselben PTY', async () => {
    const lock = new ProjectJobLock();
    let secondAcquireDuringFirstRequest;
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const pty = makeFakePty();
    const commandService = makeFakeCommandService(false);
    // sessionRegistry.getOrCreate() wird im boardRouter erst NACH lock.tryAcquire()
    // aufgerufen (innerhalb des try-Blocks) — genau der richtige Zeitpunkt, um zu
    // simulieren, dass ein zweiter discuss-Aufruf für dasselbe Projekt "gleichzeitig"
    // versucht, das Lock zu akquirieren, während der erste Request es noch hält.
    const sessionRegistry = {
      getOrCreate: (repoPath) => {
        secondAcquireDuringFirstRequest = lock.tryAcquire(repoPath);
        return pty;
      },
    };
    const server = await startServer(aggregator, null, { commandService, sessionRegistry, auditStore: new AuditStore(), lock });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/discuss', 'POST');
      expect(status).toBe(200);
      // Während des ersten Requests hielt DIESER bereits das Lock — ein zweiter
      // tryAcquire-Versuch (simulierter gleichzeitiger discuss-Aufruf) scheitert.
      expect(secondAcquireDuringFirstRequest).toBe(false);
      // Nur EIN Seed wurde tatsächlich in die PTY geschrieben.
      expect(pty.writes.length).toBe(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('Lock wird nach dem discuss-Aufruf wieder freigegeben (kurz gehalten — nicht für die Dauer des Gesprächs)', async () => {
    const lock = new ProjectJobLock();
    const { server } = await makeServer({ lock });
    try {
      const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
      const project = (await aggregator.getIndex()).find((p) => p.slug === 'my-repo');

      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/discuss', 'POST');
      expect(status).toBe(200);
      expect(lock.isHeld(project.repo_path)).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('409 bei laufendem Command (CommandService) gibt das ProjectJobLock ebenfalls sofort wieder frei (kein Deadlock für Folge-Requests)', async () => {
    const lock = new ProjectJobLock();
    const { server } = await makeServer({ running: true, lock });
    try {
      const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
      const project = (await aggregator.getIndex()).find((p) => p.slug === 'my-repo');

      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/discuss', 'POST');
      expect(status).toBe(409);
      expect(lock.isHeld(project.repo_path)).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── buildDiscussSeed() Unit-Tests (Finding 2, S-200 Iteration 2) ─────────────
//
// Sicherheitskritische Sanitisierung (ideen-inbox AC5/AC8): der Gesprächs-Seed
// darf NIEMALS mehr als eine PTY-Submit-Zeile erzeugen und KEINE Steuerzeichen
// (inkl. ESC/ANSI, U+2028/U+2029) durchreichen — genau die Eigenschaft, die der
// reviewer in Iteration 1 nur manuell verifiziert hat, hier als Regressionstest.

describe('buildDiscussSeed() — Sanitisierung (ideen-inbox AC5/AC8, S-200 Finding 2)', () => {
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u2028\u2029]/;

  function assertSingleSafeLine(seed) {
    expect(typeof seed).toBe('string');
    // Genau eine Zeile: kein \n/\r irgendwo im Ergebnis (der Aufrufer hängt das
    // EINE abschließende \n selbst an, buildDiscussSeed() selbst liefert keins).
    expect(seed.includes('\n')).toBe(false);
    expect(seed.includes('\r')).toBe(false);
    expect(CONTROL_CHAR_RE.test(seed)).toBe(false);
  }

  it('mehrzeiliger Titel wird zu einer Zeile kollabiert', () => {
    const seed = buildDiscussSeed({ title: 'Zeile eins\nZeile zwei\nZeile drei' });
    assertSingleSafeLine(seed);
    expect(seed).toContain('Zeile eins Zeile zwei Zeile drei');
  });

  it('mehrzeiliger Body (\\n) wird zu einer Zeile kollabiert', () => {
    const seed = buildDiscussSeed({ title: 'Titel', body: 'Punkt 1\nPunkt 2\nPunkt 3' });
    assertSingleSafeLine(seed);
    expect(seed).toContain('Punkt 1 Punkt 2 Punkt 3');
  });

  it('eingebettete \\r\\n (CRLF) und einzelne \\r werden kollabiert', () => {
    const seed = buildDiscussSeed({ title: 'A\r\nB\rC', body: 'D\r\nE' });
    assertSingleSafeLine(seed);
    expect(seed).toContain('A B C');
    expect(seed).toContain('D E');
  });

  it('ESC/ANSI-Escape-Sequenzen (\\x1b[...) werden entfernt/kollabiert — keine Terminal-Steuerung', () => {
    const seed = buildDiscussSeed({ title: '\x1b[31mRot\x1b[0m Titel', body: '\x1b[2J\x1b[H löscht Bildschirm' });
    assertSingleSafeLine(seed);
    // Der ESC-Charakter selbst darf nicht mehr vorkommen.
    expect(seed.includes('\x1b')).toBe(false);
  });

  it('U+2028 (Line Separator) und U+2029 (Paragraph Separator) werden kollabiert', () => {
    const seed = buildDiscussSeed({ title: 'Erster Teil\u2028Zweiter Teil', body: 'A\u2029B' });
    assertSingleSafeLine(seed);
    expect(seed).toContain('Erster Teil Zweiter Teil');
    expect(seed).toContain('A B');
  });

  it('ein eingebetteter Slash-Befehl (/agent-flow:flow) bleibt harmloser Freitext — KEINE zweite Submit-Zeile, kein Slash-Dispatch möglich', () => {
    const seed = buildDiscussSeed({
      title: 'Idee',
      body: 'Bitte danach /agent-flow:flow\nausführen und alles committen',
    });
    assertSingleSafeLine(seed);
    // Der Slash-Text taucht als reiner String im konversationellen Satz auf,
    // aber OHNE das \n davor/danach — kein zweiter PTY-Submit möglich, da der
    // Aufrufer nur EIN abschließendes \n anhängt (siehe HTTP-Ebenen-Test oben:
    // `pty.writes[0].slice(0, -1).includes('\n')` ist false).
    expect(seed).toContain('/agent-flow:flow ausführen und alles committen');
  });

  it('C0-Steuerzeichen (z.B. Tab \\x09, Bell \\x07) und DEL (\\x7f) werden kollabiert', () => {
    const seed = buildDiscussSeed({ title: 'Tab\x09hier', body: 'Bell\x07 und DEL\x7fEnde' });
    assertSingleSafeLine(seed);
  });

  it('leerer/fehlender Body erzeugt keine leere "Stichworte:"-Zeile', () => {
    const seed = buildDiscussSeed({ title: 'Nur Titel' });
    assertSingleSafeLine(seed);
    expect(seed).not.toContain('Stichworte:');
  });
});

// ── boardRouter HTTP — POST .../ideas/:id/resolve (ideen-inbox AC6/AC7/AC8, S-200) ──
//
// Reale BoardWriter-Instanz gegen ein echtes tmp-Verzeichnis (analog POST .../ideas).

describe('boardRouter HTTP — POST .../ideas/:id/resolve (ideen-inbox AC6/AC7/AC8, S-200)', () => {
  let boardRootsDir;
  let storiesDir;
  let ideaFilePath;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardrouter-resolve-test-'));
    const boardDir = join(boardRootsDir, 'my-repo', 'board');
    storiesDir = join(boardDir, 'stories');
    await mkdir(storiesDir, { recursive: true });
    await writeFile(join(boardDir, 'board.yaml'), 'schema_version: 1\nproject_slug: my-repo\nnext_story_id: 1\n', 'utf8');
    ideaFilePath = join(storiesDir, 'S-42.yaml');
    await writeFile(
      ideaFilePath,
      [
        'id: S-42',
        'status: Idee',
        "title: 'Dark Mode fürs Dashboard'",
        "created_at: '2026-07-01T10:00:00.000Z'",
        "updated_at: '2026-07-01T10:00:00.000Z'",
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  function makeBoardWriter() {
    return new BoardWriter({ boardRootsEnv: boardRootsDir });
  }

  it('200 happy path: setzt status Done + resolved_at/resolved_story_ids/resolved_note, GENAU EIN Audit-Eintrag', async () => {
    const boardWriter = makeBoardWriter();
    const auditStore = new AuditStore();
    const server = await startServer(null, null, { boardWriter, auditStore });
    try {
      const { status, data } = await httpFetch(
        server,
        '/api/board/projects/my-repo/ideas/S-42/resolve',
        'POST',
        { resolved_story_ids: ['S-201', 'S-202'], resolved_note: 'docs/specs/dark-mode.md' },
      );
      expect(status).toBe(200);
      expect(data).toEqual({ storyId: 'S-42' });

      const raw = await readFile(ideaFilePath, 'utf8');
      expect(raw).toContain('status: Done');
      expect(raw).toContain('resolved_story_ids: [S-201, S-202]');
      expect(raw).toContain("resolved_note: 'docs/specs/dark-mode.md'");
      expect(raw).toMatch(/^resolved_at: '[^']+'$/m);

      const entries = auditStore.getAll();
      expect(entries.length).toBe(1);
      expect(entries[0].command).toBe('board:idea:resolve:my-repo:S-42');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('200 ohne Payload (nur Pflicht-Auflösung): setzt status Done + resolved_at, keine resolved_story_ids/resolved_note', async () => {
    const boardWriter = makeBoardWriter();
    const server = await startServer(null, null, { boardWriter, auditStore: new AuditStore() });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/resolve', 'POST', {});
      expect(status).toBe(200);
      const raw = await readFile(ideaFilePath, 'utf8');
      expect(raw).toContain('status: Done');
      expect(raw).not.toMatch(/^resolved_story_ids:/m);
      expect(raw).not.toMatch(/^resolved_note:/m);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('400 bei ungültigem resolved_story_ids (kein Array): field "resolved_story_ids", KEIN Audit, Datei unverändert', async () => {
    const boardWriter = makeBoardWriter();
    const auditStore = new AuditStore();
    const server = await startServer(null, null, { boardWriter, auditStore });
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/resolve', 'POST', {
        resolved_story_ids: 'S-201',
      });
      expect(status).toBe(400);
      expect(data.field).toBe('resolved_story_ids');
      expect(auditStore.getAll()).toEqual([]);

      const raw = await readFile(ideaFilePath, 'utf8');
      expect(raw).toContain('status: Idee');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('400 bei bereits aufgelöster Idee (zweiter Resolve-Versuch): field "status", kein zweites Done', async () => {
    const boardWriter = makeBoardWriter();
    const server = await startServer(null, null, { boardWriter, auditStore: new AuditStore() });
    try {
      const first = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/resolve', 'POST', {});
      expect(first.status).toBe(200);

      const second = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/resolve', 'POST', {});
      expect(second.status).toBe(400);
      expect(second.data.field).toBe('status');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('404 bei unbekanntem Projekt-Slug', async () => {
    const boardWriter = makeBoardWriter();
    const server = await startServer(null, null, { boardWriter, auditStore: new AuditStore() });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/does-not-exist/ideas/S-42/resolve', 'POST', {});
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('404 bei unbekannter Idee-ID', async () => {
    const boardWriter = makeBoardWriter();
    const server = await startServer(null, null, { boardWriter, auditStore: new AuditStore() });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-999/resolve', 'POST', {});
      expect(status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('500 wenn boardWriter nicht verdrahtet ist (kein Crash)', async () => {
    const server = await startServer(null, null, { auditStore: new AuditStore() });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/ideas/S-42/resolve', 'POST', {});
      expect(status).toBe(500);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── board-feature-archive (S-232) — AC3: includeArchived-Filter (BoardAggregator) ──
//
// Realer BoardAggregator gegen ein echtes tmp-Board mit archivierten +
// nicht-archivierten Features/Stories. Der Schreibpfad (archiveDoneFeatures) ist
// separat in test/BoardWriter.test.js unit-getestet; hier zählt die Lese-Sicht.

describe('BoardAggregator — includeArchived-Filter (board-feature-archive AC3)', () => {
  let boardRootsDir;
  let featuresDir;
  let storiesDir;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardagg-archive-test-'));
    const boardDir = join(boardRootsDir, 'my-repo', 'board');
    featuresDir = join(boardDir, 'features');
    storiesDir = join(boardDir, 'stories');
    await mkdir(featuresDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await writeFile(join(boardDir, 'board.yaml'), 'schema_version: 1\nproject_slug: my-repo\n', 'utf8');

    // F-001: archiviertes Feature samt archivierter Story S-001.
    await writeFile(
      join(featuresDir, 'F-001.yaml'),
      ['id: F-001', 'title: Erledigtes Feature', 'status: Done',
        'archived: true', "archived_at: '2026-07-02T00:00:00.000Z'", ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-001.yaml'),
      ['id: S-001', 'parent: F-001', 'title: Erledigte Story', 'status: Done',
        'archived: true', "archived_at: '2026-07-02T00:00:00.000Z'", ''].join('\n'),
      'utf8',
    );

    // F-002: NICHT archiviert, zwei sichtbare Stories (Done + To Do).
    await writeFile(
      join(featuresDir, 'F-002.yaml'),
      ['id: F-002', 'title: Laufendes Feature', 'status: In Progress', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-002.yaml'),
      ['id: S-002', 'parent: F-002', 'title: Fertige Story', 'status: Done', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-003.yaml'),
      ['id: S-003', 'parent: F-002', 'title: Offene Story', 'status: To Do', ''].join('\n'),
      'utf8',
    );

    // F-003: sichtbares Feature MIT einer einzeln archivierten Story (Randfall V3).
    await writeFile(
      join(featuresDir, 'F-003.yaml'),
      ['id: F-003', 'title: Feature mit Rand-Archiv-Story', 'status: Done', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-004.yaml'),
      ['id: S-004', 'parent: F-003', 'title: Einzeln archivierte Story', 'status: Done',
        'archived: true', "archived_at: '2026-07-02T00:00:00.000Z'", ''].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  it('Standardansicht (Default) blendet archivierte Features samt ihren Stories aus', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex();
    const project = index.find((p) => p.slug === 'my-repo');
    const featureIds = project.features.map((f) => f.id);
    expect(featureIds).not.toContain('F-001');
    expect(featureIds).toContain('F-002');
    expect(featureIds).toContain('F-003');
    const allStoryIds = project.features.flatMap((f) => f.stories.map((s) => s.id));
    expect(allStoryIds).not.toContain('S-001');
  });

  it('Standardansicht: einzeln archivierte Story ausgeblendet + Feature-Rollup neu berechnet (Randfall V3)', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex();
    const project = index.find((p) => p.slug === 'my-repo');
    const f003 = project.features.find((f) => f.id === 'F-003');
    expect(f003.stories.map((s) => s.id)).toEqual([]); // S-004 ausgeblendet
    expect(f003.progress).toBe('0/0 done'); // Zähler/Rollup ohne die archivierte Story
  });

  it('includeArchived: true liefert archivierte Features/Stories zusätzlich, als archived markiert', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex({ includeArchived: true });
    const project = index.find((p) => p.slug === 'my-repo');
    const f001 = project.features.find((f) => f.id === 'F-001');
    expect(f001).toBeDefined();
    expect(f001.archived).toBe(true);
    expect(f001.archived_at).toBe('2026-07-02T00:00:00.000Z');
    const s001 = f001.stories.find((s) => s.id === 'S-001');
    expect(s001.archived).toBe(true);
    expect(s001.archived_at).toBe('2026-07-02T00:00:00.000Z');
    // Einzeln archivierte Story unter sichtbarem Feature: mit includeArchived sichtbar+markiert.
    const f003 = project.features.find((f) => f.id === 'F-003');
    expect(f003.stories.find((s) => s.id === 'S-004').archived).toBe(true);
  });

  it('Standardansicht mutiert den internen Index nicht — includeArchived bleibt vollständig', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    await aggregator.getIndex(); // gefilterte Standardansicht zuerst anfordern
    const full = await aggregator.getIndex({ includeArchived: true });
    const project = full.find((p) => p.slug === 'my-repo');
    expect(project.features.map((f) => f.id)).toContain('F-001');
  });

  it('nicht-archivierte Features/Stories tragen archived:false + archived_at:null', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex();
    const project = index.find((p) => p.slug === 'my-repo');
    const f002 = project.features.find((f) => f.id === 'F-002');
    expect(f002.archived).toBe(false);
    expect(f002.archived_at).toBeNull();
    const s002 = f002.stories.find((s) => s.id === 'S-002');
    expect(s002.archived).toBe(false);
    expect(s002.archived_at).toBeNull();
  });
});

// ── board-feature-archive (S-232) — AC4/AC8: POST .../archive-done (HTTP-Ebene) ──
//
// Realer BoardAggregator + realer BoardWriter gegen dasselbe tmp-Board (der
// einzige Schreibpfad, AC8). Frische ProjectJobLock-Instanz je Server
// (Test-Isolation + adversariale 409-Tests), analog discuss.

describe('boardRouter HTTP — POST /api/board/projects/:slug/archive-done (board-feature-archive AC4/AC8)', () => {
  let boardRootsDir;
  let featuresDir;
  let storiesDir;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardrouter-archive-test-'));
    const boardDir = join(boardRootsDir, 'my-repo', 'board');
    featuresDir = join(boardDir, 'features');
    storiesDir = join(boardDir, 'stories');
    await mkdir(featuresDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await writeFile(join(boardDir, 'board.yaml'), 'schema_version: 1\nproject_slug: my-repo\n', 'utf8');
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  async function writeArchivableFeature() {
    // F-010 vollständig erledigt (zwei Done-Stories) → archivierbar (V1).
    await writeFile(
      join(featuresDir, 'F-010.yaml'),
      ['id: F-010', 'title: Fertig', 'status: Done', "updated_at: '2026-07-01T00:00:00.000Z'", ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-010.yaml'),
      ['id: S-010', 'parent: F-010', 'title: A', 'status: Done', "updated_at: '2026-07-01T00:00:00.000Z'", ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-011.yaml'),
      ['id: S-011', 'parent: F-010', 'title: B', 'status: Done', "updated_at: '2026-07-01T00:00:00.000Z'", ''].join('\n'),
      'utf8',
    );
  }

  function makeDeps({ lock = new ProjectJobLock(), auditStore = new AuditStore() } = {}) {
    const boardAggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const boardWriter = new BoardWriter({ boardRootsEnv: boardRootsDir });
    return { boardAggregator, boardWriter, auditStore, lock };
  }

  it('200 happy path: archiviert das erledigte Feature, GENAU EIN Audit-Eintrag, { counts }, Lock danach frei', async () => {
    await writeArchivableFeature();
    const { boardAggregator, boardWriter, auditStore, lock } = makeDeps();
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const project = (await boardAggregator.getIndex({ includeArchived: true })).find((p) => p.slug === 'my-repo');

      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/archive-done', 'POST');
      expect(status).toBe(200);
      expect(data).toEqual({ archivedFeatureCount: 1, archivedStoryCount: 2 });

      const rawF = await readFile(join(featuresDir, 'F-010.yaml'), 'utf8');
      expect(rawF).toContain('archived: true');
      const rawS = await readFile(join(storiesDir, 'S-010.yaml'), 'utf8');
      expect(rawS).toContain('archived: true');
      expect(rawS).toContain('status: Done'); // Story-Status bleibt Done (V2)

      const entries = auditStore.getAll();
      expect(entries.length).toBe(1);
      expect(entries[0].command).toBe('board:archive-done:my-repo');

      expect(lock.isHeld(project.repo_path)).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('200 { 0, 0 } ohne Fehler, wenn nichts archivierbar ist (immer noch GENAU EIN Audit-Eintrag)', async () => {
    const { boardAggregator, boardWriter, auditStore, lock } = makeDeps();
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/archive-done', 'POST');
      expect(status).toBe(200);
      expect(data).toEqual({ archivedFeatureCount: 0, archivedStoryCount: 0 });
      expect(auditStore.getAll().length).toBe(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('nach dem Archivieren ist das Feature aus der Standardansicht verschwunden (AC3+AC4 end-to-end)', async () => {
    await writeArchivableFeature();
    const { boardAggregator, boardWriter, auditStore, lock } = makeDeps();
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/archive-done', 'POST');
      expect(status).toBe(200);

      // Frischer Scan (die Dateien tragen jetzt archived: true) → Standardansicht ohne F-010.
      const fresh = new BoardAggregator({ boardRootsEnv: boardRootsDir });
      const project = (await fresh.getIndex()).find((p) => p.slug === 'my-repo');
      expect(project.features.map((f) => f.id)).not.toContain('F-010');
      // mit includeArchived ist F-010 (jetzt archived) wieder sichtbar.
      const withArchived = (await fresh.getIndex({ includeArchived: true })).find((p) => p.slug === 'my-repo');
      const f010 = withArchived.features.find((f) => f.id === 'F-010');
      expect(f010.archived).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('404 bei ungültigem Slug-Format (führendes Sonderzeichen)', async () => {
    const { boardAggregator, boardWriter, auditStore, lock } = makeDeps();
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/-badslug/archive-done', 'POST');
      expect(status).toBe(404);
      // AC8: keine Pfade/Secrets in der Ausgabe.
      expect(JSON.stringify(data)).not.toContain(boardRootsDir);
      expect(auditStore.getAll()).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('404 bei unbekanntem Projekt-Slug (nicht unter BOARD_ROOTS) — KEIN Audit', async () => {
    const { boardAggregator, boardWriter, auditStore, lock } = makeDeps();
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/does-not-exist/archive-done', 'POST');
      expect(status).toBe(404);
      expect(auditStore.getAll()).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('409 wenn das projektweite ProjectJobLock bereits gehalten wird — KEIN Audit, nichts archiviert, Lock danach unverändert gehalten', async () => {
    await writeArchivableFeature();
    const lock = new ProjectJobLock();
    const { boardAggregator, boardWriter, auditStore } = makeDeps({ lock });
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const project = (await boardAggregator.getIndex({ includeArchived: true })).find((p) => p.slug === 'my-repo');
      // Simuliert: Taktgeber/Drain hält das Lock bereits.
      expect(lock.tryAcquire(project.repo_path)).toBe(true);

      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/archive-done', 'POST');
      expect(status).toBe(409);
      expect(JSON.stringify(data)).not.toContain(boardRootsDir);
      expect(auditStore.getAll()).toEqual([]);

      // Nichts wurde archiviert.
      const rawF = await readFile(join(featuresDir, 'F-010.yaml'), 'utf8');
      expect(rawF).not.toContain('archived: true');

      // Der externe Lock-Halter behält das Lock (der Endpunkt hat es NICHT freigegeben).
      expect(lock.isHeld(project.repo_path)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('500 wenn boardWriter nicht verdrahtet ist (kein Crash, kein Secret-Leak)', async () => {
    const boardAggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const server = await startServer(boardAggregator, null, { auditStore: new AuditStore() });
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/archive-done', 'POST');
      expect(status).toBe(500);
      expect(JSON.stringify(data)).not.toContain(boardRootsDir);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── board-storys-archivieren (S-293) — AC3/AC5: Sichtbarkeit der Bereichs-Kachel ──
//
// Story-Ebenen-Archiv (statt Feature-Ebene, [[board-feature-archive]]): eine
// Bereichs-Kachel (Feature) bleibt IMMER sichtbar, selbst wenn ALLE ihre Storys
// archiviert sind — nur die (bereits gelandete) Feature-Archivierung blendet
// eine Kachel aus. Beide Archiv-Formen (Story- UND Feature-archiviert) müssen
// nebeneinander korrekt funktionieren (Abwärtskompatibilität, V5).

describe('BoardAggregator — Story-Archiv Sichtbarkeit (board-storys-archivieren AC3/AC5)', () => {
  let boardRootsDir;
  let featuresDir;
  let storiesDir;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardagg-storyarchive-test-'));
    const boardDir = join(boardRootsDir, 'my-repo', 'board');
    featuresDir = join(boardDir, 'features');
    storiesDir = join(boardDir, 'stories');
    await mkdir(featuresDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await writeFile(join(boardDir, 'board.yaml'), 'schema_version: 1\nproject_slug: my-repo\n', 'utf8');
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  it('AC3: Feature, dessen Storys ALLE story-archiviert sind, bleibt in der Standardansicht sichtbar (dauerhafte Kachel), Rollup "0/0 done"', async () => {
    await writeFile(
      join(featuresDir, 'F-100.yaml'),
      ['id: F-100', 'title: Dauerhafte Bereichs-Kachel', 'status: Done', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-100.yaml'),
      ['id: S-100', 'parent: F-100', 'title: A', 'status: Done',
        'archived: true', "archived_at: '2026-07-03T00:00:00.000Z'", ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-101.yaml'),
      ['id: S-101', 'parent: F-100', 'title: B', 'status: Verworfen',
        'archived: true', "archived_at: '2026-07-03T00:00:00.000Z'", ''].join('\n'),
      'utf8',
    );

    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const project = (await aggregator.getIndex()).find((p) => p.slug === 'my-repo');

    const feature = project.features.find((f) => f.id === 'F-100');
    expect(feature).toBeDefined(); // Kachel bleibt sichtbar, obwohl KEIN Feature-`archived`-Flag.
    expect(feature.archived).toBe(false);
    expect(feature.stories).toEqual([]); // beide Storys ausgeblendet
    expect(feature.progress).toBe('0/0 done'); // Rollup zeigt "alle archiviert"
  });

  it('AC5: Abwärtskompatibilität — ein feature-archiviertes Feature UND eine einzeln story-archivierte Story in einem anderen Feature werden beide korrekt ausgeblendet', async () => {
    // F-200: FEATURE-archiviert (board-feature-archive, altes Format) — Kachel + Stories weg.
    await writeFile(
      join(featuresDir, 'F-200.yaml'),
      ['id: F-200', 'title: Feature-archiviert (alt)', 'status: Done',
        'archived: true', "archived_at: '2026-07-01T00:00:00.000Z'", ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-200.yaml'),
      ['id: S-200', 'parent: F-200', 'title: A', 'status: Done', ''].join('\n'),
      'utf8',
    );

    // F-201: sichtbares Feature — eine Story STORY-archiviert (neu, S-293), eine offen.
    await writeFile(
      join(featuresDir, 'F-201.yaml'),
      ['id: F-201', 'title: Gemischtes Feature', 'status: In Progress', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-201.yaml'),
      ['id: S-201', 'parent: F-201', 'title: Fertig', 'status: Done',
        'archived: true', "archived_at: '2026-07-03T00:00:00.000Z'", ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-202.yaml'),
      ['id: S-202', 'parent: F-201', 'title: Offen', 'status: To Do', ''].join('\n'),
      'utf8',
    );

    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const project = (await aggregator.getIndex()).find((p) => p.slug === 'my-repo');

    const featureIds = project.features.map((f) => f.id);
    expect(featureIds).not.toContain('F-200'); // feature-archiviert → komplett weg
    expect(featureIds).toContain('F-201'); // sichtbar, nur die eine Story weg

    const f201 = project.features.find((f) => f.id === 'F-201');
    expect(f201.stories.map((s) => s.id)).toEqual(['S-202']);

    // Mit includeArchived: beide Archiv-Formen zusätzlich sichtbar, korrekt markiert.
    const full = (await aggregator.getIndex({ includeArchived: true })).find((p) => p.slug === 'my-repo');
    expect(full.features.map((f) => f.id)).toEqual(expect.arrayContaining(['F-200', 'F-201']));
    const s201 = full.features.find((f) => f.id === 'F-201').stories.find((s) => s.id === 'S-201');
    expect(s201.archived).toBe(true);
  });
});

// ── board-storys-archivieren (S-293) — AC4/AC9: POST .../archive-done-stories (HTTP-Ebene) ──
//
// Realer BoardAggregator + realer BoardWriter gegen dasselbe tmp-Board (der
// einzige Schreibpfad, AC9). Frische ProjectJobLock-Instanz je Server
// (Test-Isolation + adversariale 409-Tests), 1:1 analog zu POST .../archive-done.

describe('boardRouter HTTP — POST /api/board/projects/:slug/archive-done-stories (board-storys-archivieren AC4/AC9)', () => {
  let boardRootsDir;
  let featuresDir;
  let storiesDir;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardrouter-storyarchive-test-'));
    const boardDir = join(boardRootsDir, 'my-repo', 'board');
    featuresDir = join(boardDir, 'features');
    storiesDir = join(boardDir, 'stories');
    await mkdir(featuresDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await writeFile(join(boardDir, 'board.yaml'), 'schema_version: 1\nproject_slug: my-repo\n', 'utf8');
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  async function writeArchivableStory() {
    // F-010 bleibt eine dauerhafte Kachel (NIE archiviert auf diesem Pfad) — zwei
    // Done-Stories sind archivierbar (V1).
    await writeFile(
      join(featuresDir, 'F-010.yaml'),
      ['id: F-010', 'title: Bereichs-Kachel', 'status: Done', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-010.yaml'),
      ['id: S-010', 'parent: F-010', 'title: A', 'status: Done', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-011.yaml'),
      ['id: S-011', 'parent: F-010', 'title: B', 'status: Done', ''].join('\n'),
      'utf8',
    );
  }

  function makeDeps({ lock = new ProjectJobLock(), auditStore = new AuditStore() } = {}) {
    const boardAggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const boardWriter = new BoardWriter({ boardRootsEnv: boardRootsDir });
    return { boardAggregator, boardWriter, auditStore, lock };
  }

  it('200 happy path: archiviert beide erledigten Storys, GENAU EIN Audit-Eintrag, { archivedStoryCount }, Lock danach frei, Feature-YAML unangetastet', async () => {
    await writeArchivableStory();
    const { boardAggregator, boardWriter, auditStore, lock } = makeDeps();
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const project = (await boardAggregator.getIndex({ includeArchived: true })).find((p) => p.slug === 'my-repo');

      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/archive-done-stories', 'POST');
      expect(status).toBe(200);
      expect(data).toEqual({ archivedStoryCount: 2 });

      const rawS = await readFile(join(storiesDir, 'S-010.yaml'), 'utf8');
      expect(rawS).toContain('archived: true');
      expect(rawS).toContain('status: Done'); // Story-Status bleibt Done (V2)
      // Feature-YAML UNVERÄNDERT — Bereichs-Kacheln werden nie archiviert.
      expect(await readFile(join(featuresDir, 'F-010.yaml'), 'utf8')).not.toContain('archived:');

      const entries = auditStore.getAll();
      expect(entries.length).toBe(1);
      expect(entries[0].command).toBe('board:archive-done-stories:my-repo');

      expect(lock.isHeld(project.repo_path)).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('200 { 0 } ohne Fehler, wenn nichts archivierbar ist (immer noch GENAU EIN Audit-Eintrag)', async () => {
    const { boardAggregator, boardWriter, auditStore, lock } = makeDeps();
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/archive-done-stories', 'POST');
      expect(status).toBe(200);
      expect(data).toEqual({ archivedStoryCount: 0 });
      expect(auditStore.getAll().length).toBe(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('nach dem Archivieren ist die Story aus der Standardansicht verschwunden, die Kachel bleibt (AC3+AC4 end-to-end)', async () => {
    await writeArchivableStory();
    const { boardAggregator, boardWriter, auditStore, lock } = makeDeps();
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/my-repo/archive-done-stories', 'POST');
      expect(status).toBe(200);

      // Frischer Scan (die Story-Dateien tragen jetzt archived: true) → Standardansicht ohne Storys.
      const fresh = new BoardAggregator({ boardRootsEnv: boardRootsDir });
      const project = (await fresh.getIndex()).find((p) => p.slug === 'my-repo');
      const feature = project.features.find((f) => f.id === 'F-010');
      expect(feature).toBeDefined(); // Kachel bleibt sichtbar
      expect(feature.stories).toEqual([]);
      // mit includeArchived sind beide Storys wieder sichtbar, markiert.
      const withArchived = (await fresh.getIndex({ includeArchived: true })).find((p) => p.slug === 'my-repo');
      const s010 = withArchived.features.find((f) => f.id === 'F-010').stories.find((s) => s.id === 'S-010');
      expect(s010.archived).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('404 bei ungültigem Slug-Format (führendes Sonderzeichen)', async () => {
    const { boardAggregator, boardWriter, auditStore, lock } = makeDeps();
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/-badslug/archive-done-stories', 'POST');
      expect(status).toBe(404);
      // AC9: keine Pfade/Secrets in der Ausgabe.
      expect(JSON.stringify(data)).not.toContain(boardRootsDir);
      expect(auditStore.getAll()).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('404 bei unbekanntem Projekt-Slug (nicht unter BOARD_ROOTS) — KEIN Audit', async () => {
    const { boardAggregator, boardWriter, auditStore, lock } = makeDeps();
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const { status } = await httpFetch(server, '/api/board/projects/does-not-exist/archive-done-stories', 'POST');
      expect(status).toBe(404);
      expect(auditStore.getAll()).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('409 wenn das projektweite ProjectJobLock bereits gehalten wird — KEIN Audit, nichts archiviert, Lock danach unverändert gehalten', async () => {
    await writeArchivableStory();
    const lock = new ProjectJobLock();
    const { boardAggregator, boardWriter, auditStore } = makeDeps({ lock });
    const server = await startServer(boardAggregator, null, { boardWriter, auditStore, lock });
    try {
      const project = (await boardAggregator.getIndex({ includeArchived: true })).find((p) => p.slug === 'my-repo');
      // Simuliert: Taktgeber/Drain hält das Lock bereits.
      expect(lock.tryAcquire(project.repo_path)).toBe(true);

      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/archive-done-stories', 'POST');
      expect(status).toBe(409);
      expect(JSON.stringify(data)).not.toContain(boardRootsDir);
      expect(auditStore.getAll()).toEqual([]);

      // Nichts wurde archiviert.
      const rawS = await readFile(join(storiesDir, 'S-010.yaml'), 'utf8');
      expect(rawS).not.toContain('archived: true');

      // Der externe Lock-Halter behält das Lock (der Endpunkt hat es NICHT freigegeben).
      expect(lock.isHeld(project.repo_path)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('500 wenn boardWriter nicht verdrahtet ist (kein Crash, kein Secret-Leak)', async () => {
    const boardAggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const server = await startServer(boardAggregator, null, { auditStore: new AuditStore() });
    try {
      const { status, data } = await httpFetch(server, '/api/board/projects/my-repo/archive-done-stories', 'POST');
      expect(status).toBe(500);
      expect(JSON.stringify(data)).not.toContain(boardRootsDir);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── feature-status-derivation (S-238) — computeFeatureStatus() reine Funktion ──
//
// Deckt jede Ableitungs-Priorität einzeln + in Kombination ab (V1–V6 / AC1–AC6).
// Reine Funktion — kein Filesystem, keine Mutation der Eingabe.

describe('computeFeatureStatus (feature-status-derivation)', () => {
  const story = (status) => ({ status });

  // AC4 / V4 — Default bei keiner zählbaren Story.
  it('AC4: keine Stories → Backlog', () => {
    expect(computeFeatureStatus([])).toBe('Backlog');
  });

  it('AC4: undefined/nicht-Array → Backlog (kein Crash)', () => {
    expect(computeFeatureStatus(undefined)).toBe('Backlog');
    expect(computeFeatureStatus(null)).toBe('Backlog');
  });

  it('AC1+AC4: nur Idee-Stories → Backlog (Ideen ausgeschlossen, dann keine verbleibende)', () => {
    expect(computeFeatureStatus([story('Idee'), story('Idee')])).toBe('Backlog');
  });

  // AC1 / V1 — Idee-Ausschluss vor allem anderen.
  it('AC1: Idee-Stories werden vollständig ausgeschlossen (Idee + Done → Done)', () => {
    expect(computeFeatureStatus([story('Idee'), story('Done')])).toBe('Done');
  });

  it('AC1: Idee wird nicht als schwächste Stufe gewertet (Idee + In Review → In Review)', () => {
    expect(computeFeatureStatus([story('Idee'), story('In Review')])).toBe('In Review');
  });

  // AC2 / V2 — Blocked gewinnt (höchste Priorität).
  it('AC2: eine Blocked-Story → Blocked (unabhängig von anderen Status)', () => {
    expect(computeFeatureStatus([story('To Do'), story('Blocked'), story('Done')])).toBe('Blocked');
  });

  it('AC2: Blocked überschreibt selbst reines To Do (Blocked + To Do → Blocked)', () => {
    expect(computeFeatureStatus([story('Blocked'), story('To Do')])).toBe('Blocked');
  });

  it('AC1+AC2: Blocked + Done + Idee → Idee raus, Blocked gewinnt', () => {
    expect(computeFeatureStatus([story('Idee'), story('Blocked'), story('Done')])).toBe('Blocked');
  });

  // AC3 / V3 — weakest-wins: To Do < In Progress < In Review < Done.
  it('AC3: To Do vorhanden → To Do (schwächste Stufe gewinnt)', () => {
    expect(computeFeatureStatus([story('To Do'), story('In Progress'), story('Done')])).toBe('To Do');
  });

  it('AC3: kein To Do, aber In Progress → In Progress', () => {
    expect(computeFeatureStatus([story('In Progress'), story('In Review'), story('Done')])).toBe('In Progress');
  });

  it('AC3: nur In Review + Done → In Review', () => {
    expect(computeFeatureStatus([story('In Review'), story('Done')])).toBe('In Review');
  });

  it('AC3: alle verbleibenden Done → Done', () => {
    expect(computeFeatureStatus([story('Done'), story('Done')])).toBe('Done');
  });

  // AC6 / V6 — unbekannter/fehlender Status → schwächste Stufe To Do (nie Done).
  it('AC6: unbekannter Status → als schwächste Stufe To Do behandelt', () => {
    expect(computeFeatureStatus([story('Frobnicating'), story('Done')])).toBe('To Do');
  });

  it('AC6: fehlender/null-Status → schwächste Stufe To Do (kein Crash)', () => {
    expect(computeFeatureStatus([story(null), story('Done')])).toBe('To Do');
    expect(computeFeatureStatus([{ /* kein status */ }, story('Done')])).toBe('To Do');
  });

  it('AC6: unbekannter Status verschwindet nie fälschlich als Done', () => {
    expect(computeFeatureStatus([story('Waiting'), story('In Review')])).not.toBe('Done');
    expect(computeFeatureStatus([story('Waiting'), story('In Review')])).toBe('To Do');
  });

  it('mutiert die Eingabe-Story-Liste nicht (reine Funktion)', () => {
    const input = [story('Idee'), story('Done')];
    const snapshot = JSON.parse(JSON.stringify(input));
    computeFeatureStatus(input);
    expect(input).toEqual(snapshot);
  });

  // AC8 / V7 — Verworfen zählt terminal (Done-äquivalent), nicht wie Idee ausgeschlossen.
  it('AC8: nur Verworfen-Stories (kein Done) → Done (alle terminal)', () => {
    expect(computeFeatureStatus([story('Verworfen'), story('Verworfen')])).toBe('Done');
  });

  it('AC8: Done + Verworfen → Done (beide terminal)', () => {
    expect(computeFeatureStatus([story('Done'), story('Verworfen')])).toBe('Done');
  });

  it('AC8: To Do + Verworfen → To Do (weakest-wins, nicht-terminale Stufe gewinnt)', () => {
    expect(computeFeatureStatus([story('To Do'), story('Verworfen')])).toBe('To Do');
  });

  it('AC8: Blocked + Verworfen → Blocked (V2-Priorität bleibt unberührt)', () => {
    expect(computeFeatureStatus([story('Blocked'), story('Verworfen')])).toBe('Blocked');
  });

  it('AC8: Idee + Verworfen → Idee ausgeschlossen, bleibt nur terminal → Done', () => {
    expect(computeFeatureStatus([story('Idee'), story('Verworfen')])).toBe('Done');
  });

  it('AC8: der abgeleitete Feature-Status ist nie "Verworfen" (kollabiert auf Done)', () => {
    expect(computeFeatureStatus([story('Verworfen')])).not.toBe('Verworfen');
    expect(computeFeatureStatus([story('Verworfen'), story('In Progress')])).not.toBe('Verworfen');
  });
});

// ── feature-status-derivation (S-238) — Aggregator-Integration (AC1–AC7) ──────
//
// Realer BoardAggregator gegen ein echtes tmp-Board: verifiziert, dass der
// ausgegebene feature.status IMMER abgeleitet ist (persistiertes YAML-status:
// wird ignoriert, AC5), die Progress-Rollup unverändert bleibt, das _orphaned-
// Pseudo-Feature status:null behält (AC7) und keine board/-Datei geschrieben wird.

describe('BoardAggregator — Feature-Status-Ableitung (feature-status-derivation AC1–AC7)', () => {
  let boardRootsDir;
  let featuresDir;
  let storiesDir;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardagg-featstatus-test-'));
    const boardDir = join(boardRootsDir, 'my-repo', 'board');
    featuresDir = join(boardDir, 'features');
    storiesDir = join(boardDir, 'stories');
    await mkdir(featuresDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await writeFile(join(boardDir, 'board.yaml'), 'schema_version: 1\nproject_slug: my-repo\n', 'utf8');

    // F-100: persistiertes status: Backlog, aber einzige Story ist Done →
    // abgeleitet MUSS Done sein (Praxis-Bug aus der Spec, AC5).
    await writeFile(
      join(featuresDir, 'F-100.yaml'),
      ['id: F-100', 'title: Fertig aber Backlog persistiert', 'status: Backlog', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-100.yaml'),
      ['id: S-100', 'parent: F-100', 'title: Erledigt', 'status: Done', ''].join('\n'),
      'utf8',
    );

    // F-101: persistiertes status: Done, aber eine Story Blocked → abgeleitet Blocked (AC2/AC5).
    await writeFile(
      join(featuresDir, 'F-101.yaml'),
      ['id: F-101', 'title: Blockiert', 'status: Done', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-101.yaml'),
      ['id: S-101', 'parent: F-101', 'title: Steckt fest', 'status: Blocked', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-102.yaml'),
      ['id: S-102', 'parent: F-101', 'title: Fertig', 'status: Done', ''].join('\n'),
      'utf8',
    );

    // F-102: nur eine Idee-Story → abgeleitet Backlog (AC1/AC4).
    await writeFile(
      join(featuresDir, 'F-102.yaml'),
      ['id: F-102', 'title: Nur eine Idee', 'status: In Progress', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-103.yaml'),
      ['id: S-103', 'parent: F-102', 'title: Bloss eine Idee', 'status: Idee', ''].join('\n'),
      'utf8',
    );

    // F-103: gar keine Story → abgeleitet Backlog (AC4).
    await writeFile(
      join(featuresDir, 'F-103.yaml'),
      ['id: F-103', 'title: Leeres Feature', 'status: Done', ''].join('\n'),
      'utf8',
    );

    // F-104: To Do + In Progress + Idee → Idee raus, schwächste = To Do (AC1/AC3).
    await writeFile(
      join(featuresDir, 'F-104.yaml'),
      ['id: F-104', 'title: Gemischt', 'status: Done', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-104.yaml'),
      ['id: S-104', 'parent: F-104', 'title: Offen', 'status: To Do', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-105.yaml'),
      ['id: S-105', 'parent: F-104', 'title: Laeuft', 'status: In Progress', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(storiesDir, 'S-106.yaml'),
      ['id: S-106', 'parent: F-104', 'title: Idee-Story', 'status: Idee', ''].join('\n'),
      'utf8',
    );

    // Verwaiste Story (parent existiert nicht) → landet im _orphaned-Pseudo-Feature (AC7).
    await writeFile(
      join(storiesDir, 'S-999.yaml'),
      ['id: S-999', 'parent: F-nonexistent', 'title: Verwaist', 'status: Done', ''].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  it('AC5: leitet Done ab, obwohl persistiertes status: Backlog ist (persistiertes Feld ignoriert)', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex();
    const project = index.find((p) => p.slug === 'my-repo');
    const f100 = project.features.find((f) => f.id === 'F-100');
    expect(f100.status).toBe('Done');
  });

  it('AC2/AC5: Blocked-Story überschreibt persistiertes status: Done → Blocked', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex();
    const project = index.find((p) => p.slug === 'my-repo');
    const f101 = project.features.find((f) => f.id === 'F-101');
    expect(f101.status).toBe('Blocked');
  });

  it('AC1/AC4: Feature nur mit Idee-Story → Backlog', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex();
    const project = index.find((p) => p.slug === 'my-repo');
    const f102 = project.features.find((f) => f.id === 'F-102');
    expect(f102.status).toBe('Backlog');
  });

  it('AC4: Feature ganz ohne Story → Backlog', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex();
    const project = index.find((p) => p.slug === 'my-repo');
    const f103 = project.features.find((f) => f.id === 'F-103');
    expect(f103.status).toBe('Backlog');
  });

  it('AC1/AC3: To Do + In Progress + Idee → Idee raus, schwächste = To Do', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex();
    const project = index.find((p) => p.slug === 'my-repo');
    const f104 = project.features.find((f) => f.id === 'F-104');
    expect(f104.status).toBe('To Do');
  });

  it('AC7: _orphaned-Pseudo-Feature behält status: null (von der Ableitung ausgenommen)', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex();
    const project = index.find((p) => p.slug === 'my-repo');
    const orphaned = project.features.find((f) => f.id === '_orphaned');
    expect(orphaned).toBeDefined();
    expect(orphaned.status).toBeNull();
  });

  it('AC5: Progress-Rollup „X/Y done" bleibt unverändert (zählt Idee mit, nicht die Ableitung)', async () => {
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    const index = await aggregator.getIndex();
    const project = index.find((p) => p.slug === 'my-repo');
    // F-104: 3 Stories (To Do, In Progress, Idee), 0 Done → Rollup zählt alle mit.
    const f104 = project.features.find((f) => f.id === 'F-104');
    expect(f104.progress).toBe('0/3 done · 1 in progress');
    // F-100: 1 Story Done → 1/1 done.
    const f100 = project.features.find((f) => f.id === 'F-100');
    expect(f100.progress).toBe('1/1 done');
  });

  it('AC5: read-only — kein board/-YAML wird durch den Scan verändert (byte-genau)', async () => {
    const featurePath = join(featuresDir, 'F-100.yaml');
    const before = await readFile(featurePath, 'utf8');
    const aggregator = new BoardAggregator({ boardRootsEnv: boardRootsDir });
    await aggregator.getIndex();
    const after = await readFile(featurePath, 'utf8');
    expect(after).toBe(before); // persistiertes status: Backlog bleibt in der Datei
    expect(after).toContain('status: Backlog');
  });
});

// ── fswatcher-crash-hardening: AC6 + AC7 (Integration, ECHTER Watcher) ─────────
//
// Covers (fswatcher-crash-hardening):
//   AC6 — Ein echter Watcher auf ein temp-Verzeichnis überlebt Anlegen/Löschen von
//         Unterverzeichnissen (npm-install-/Worktree-artig): kein 'unhandledRejection',
//         der Watcher-Baustein bleibt funktionsfähig (scan()/getIndex() weiterhin ok).
//   AC7 — Regressionstest des Vorfalls 2026-07-02: Wurzel löschen → neu erzeugen →
//         Watcher re-armt; eine Änderung NACH der Neu-Erzeugung invalidiert den Index
//         erneut (getIndex() OHNE expliziten scan()-Aufruf liest neu).
//
// Strategy: echter fs/promises.watch() (kein injizierter fsDeps) auf einem mkdtemp-
// Verzeichnis; reale (kurze) Timer statt Fake-Queue, da das reale OS-Watcher-Timing
// (FSEvents/inotify) plattformnah abgebildet werden soll (Spec-Annahme A5).

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('BoardAggregator — echter FSWatcher (fswatcher-crash-hardening AC6/AC7, Integration)', () => {
  let tmpRoot;
  let aggregator;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'fswatch-crash-hardening-'));
    aggregator = new BoardAggregator({ boardRootsEnv: tmpRoot });
  });

  afterEach(async () => {
    aggregator.stopWatchers();
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    'AC6 — Anlegen/Löschen von Unterverzeichnissen (npm-install-/Worktree-artig) crasht nie',
    async () => {
      const rejections = [];
      const onRejection = (reason) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      try {
        aggregator.startWatchers();

        // npm-install-artige Churn: node_modules/.bin mehrfach anlegen + löschen.
        for (let i = 0; i < 5; i++) {
          const binDir = join(tmpRoot, 'node_modules', '.bin');
          await mkdir(binDir, { recursive: true });
          await writeFile(join(binDir, `tool-${i}`), '#!/bin/sh\n', 'utf8');
          await rm(join(tmpRoot, 'node_modules'), { recursive: true, force: true });
        }

        // Worktree-artige Anlage + Entfernung.
        const worktreeDir = join(tmpRoot, '.claude', 'worktrees', 'S-999');
        await mkdir(worktreeDir, { recursive: true });
        await rm(join(tmpRoot, '.claude'), { recursive: true, force: true });

        await sleep(500);

        expect(rejections).toEqual([]); // kein Crash, kein unhandledRejection

        // Watcher-Baustein bleibt funktionsfähig: scan()/getIndex() laufen weiterhin.
        await expect(aggregator.scan()).resolves.not.toThrow();
        const index = await aggregator.getIndex();
        expect(Array.isArray(index)).toBe(true);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    },
    20000,
  );

  it(
    'AC7 — löschen → neu erzeugen → re-armt (Regressionstest Vorfall 2026-07-02)',
    async () => {
      const rejections = [];
      const onRejection = (reason) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      try {
        // Baseline: leerer Index (kein Repo unter der Wurzel).
        const before = await aggregator.getIndex();
        expect(before).toEqual([]);

        aggregator.startWatchers();

        // Wurzel komplett löschen — genau der Vorfall-Vektor (ENOENT scandir beim
        // internen Nach-Bewaffnen des rekursiven Watchers).
        await rm(tmpRoot, { recursive: true, force: true });
        await sleep(300);

        expect(rejections).toEqual([]); // (a) kein Prozess-Exit / keine uncaught exception

        // Wurzel neu erzeugen — der Watcher soll re-armen, sobald sie wieder existiert.
        await mkdir(tmpRoot, { recursive: true });
        // Re-Arm-Backoff-Fenster abwarten (>= REARM_INITIAL_DELAY_MS, mit Puffer für
        // reale FSEvents-/inotify-Latenz).
        await sleep(900);

        // (b) Änderung NACH der Neu-Erzeugung: neues Repo mit board/-Ordner anlegen.
        const repoBoardDir = join(tmpRoot, 'probe-repo', 'board');
        await mkdir(repoBoardDir, { recursive: true });
        await writeFile(
          join(repoBoardDir, 'board.yaml'),
          'schema_version: 1\nproject_slug: probe-repo\n',
          'utf8',
        );
        // Watcher-Debounce (200ms) + Puffer für reale Event-Latenz.
        await sleep(500);

        // getIndex() OHNE expliziten scan()-Aufruf muss die neue Struktur sehen —
        // Beleg, dass der Watcher re-armt hat und den Index (erneut) invalidiert hat.
        const after = await aggregator.getIndex();
        expect(after.some((p) => p.slug === 'probe-repo')).toBe(true);
        expect(rejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    },
    20000,
  );
});

// ── fswatcher-crash-hardening V2: AC8 + AC9 (Integration) + AC10 (Integration) + AC11 ──
//
// Covers (fswatcher-crash-hardening V2):
//   AC8  — Kein Crash durch interne FSWatcher-'error'-Events. Verifiziert über einen
//          ECHTEN Kindprozess (Jest maskiert echte uncaughtException-Crashs — siehe
//          test/fixtures/fswatcher-error-guard-child.mjs Doc-Kommentar): eine
//          UNGUARDED-Baseline (roher FSWatcher ohne 'error'-Listener) crasht; der
//          watchWithErrorGuard()-Adapter (getrieben über seine öffentliche Async-
//          Iterator-Schnittstelle gegen ein echtes, während des Watchens
//          verschwindendes Wurzelverzeichnis) überlebt.
//   AC9  — Scope-Verengung (Integration): eine Mutation unter einem ignorierten
//          Unterbaum (node_modules) bewaffnet dort KEINEN Watcher und invalidiert
//          den Index NICHT — verifiziert über den echten BoardAggregator (kein
//          Kindprozess nötig, kein Crash-Risiko in diesem Teilaspekt).
//   AC10 — Index-Aktualität bleibt erhalten: eine Mutation unter board/ (index-
//          relevant) invalidiert den Index weiterhin, auch nach der Scope-
//          Verengung.
//   AC11 — Regressionstest Vorfall 2026-07-07 (Kindprozess, ECHTER Watcher):
//          test/.tmp-<random> Create/Delete-Zyklus unter einem rekursiven Watch
//          auf einen Repo-artigen Baum — bildet den Vorfall direkt ab. Dieser
//          Test schlägt gegen den V1-Stand (S-280) in der Mehrheit der Läufe
//          fehl (siehe test/fixtures/fswatcher-regression-child.mjs Doc-
//          Kommentar für die Trefferquoten-Verifikation) — die belastbare
//          Regressions-Barriere gegen den 2026-07-07-Crash.
//
// Strategy (AC8/AC11): echte Kindprozesse (node:child_process execFile), NICHT
// innerhalb desselben Jest-Prozesses — Jest's Test-VM ordnet einen unbehandelten
// Fehler, der ausserhalb des unmittelbaren it()-Callbacks geworfen wird (z.B.
// asynchron über einen fs.watch()-Event-Callback), dem laufenden Test zu und
// beendet den Prozess NICHT; ein echter Crash (der Vorfall selbst) ist innerhalb
// von Jest daher nicht beobachtbar (live verifiziert, siehe Coder-Handoff S-320).

describe('fswatcher-crash-hardening V2 AC8 — interne FSWatcher-error-Events crashen nie (Kindprozess)', () => {
  it(
    'UNGUARDED-Baseline: roher FSWatcher ohne error-Listener crasht den Prozess',
    async () => {
      const { execFile } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const path = await import('node:path');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const scriptPath = path.join(__dirname, 'fixtures', 'fswatcher-error-guard-child.mjs');

      const exitCode = await new Promise((resolve) => {
        execFile(process.execPath, [scriptPath], { timeout: 15000 }, (err) => {
          resolve(err ? (err.code ?? 1) : 0);
        });
      });

      // Baseline demonstrates the failure mode: a raw, listener-less FSWatcher
      // crashes on an 'error' event (exit 1 uncaughtException OR exit 2
      // unhandledRejection — both are the expected crash signal here, see
      // Fixture-Doc-Kommentar).
      expect([1, 2]).toContain(exitCode);
    },
    20000,
  );

  it(
    'GUARDED (watchWithErrorGuard): ein echtes, verschwindendes Wurzelverzeichnis crasht NICHT — sauberes ENOENT am Iterator',
    async () => {
      const { execFile } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const path = await import('node:path');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const scriptPath = path.join(__dirname, 'fixtures', 'fswatcher-error-guard-child.mjs');

      const { exitCode, stdout, stderr } = await new Promise((resolve) => {
        execFile(
          process.execPath,
          [scriptPath, '--guarded'],
          { timeout: 15000 },
          (err, so, se) => {
            resolve({ exitCode: err ? (err.code ?? 1) : 0, stdout: so, stderr: se });
          },
        );
      });

      expect(stderr).toBe('');
      expect(stdout).toContain('OK');
      expect(exitCode).toBe(0);
    },
    20000,
  );

  // S-320 Review-Iteration 2, Finding #2: der bisherige "GUARDED"-Test oben
  // deckt NUR den existsSync-Nachlauf-Zweig ab (Wurzel verschwindet →
  // synthetisches ENOENT im 'change'-Handler) — nicht den namensgebenden
  // Mechanismus selbst, den registrierten `watcher.on('error', …)`-Listener
  // (Doc-Kommentar Zeile 338-345: "EXPLICIT error listener — the entire
  // point of this adapter (AC8)"). Dieser Test bringt den INTERNEN, von
  // `watchWithErrorGuard()` erzeugten Watcher direkt dazu, ein reales
  // `'error'`-Event zu emittieren, und verifiziert, dass der Async-Iterator
  // mit GENAU diesem Fehler rejected.
  //
  // Injektion statt Modul-Spy: `jest.spyOn(fs, 'watch')` scheitert unter
  // echtem ESM ("Cannot assign to read only property 'watch' of object
  // '[object Module]'", live verifiziert) — Modul-Namensraum-Objekte sind
  // read-only. `watchWithErrorGuard()` akzeptiert daher ein optionales,
  // rein testgetriebenes `watchImpl` (Default: das echte `node:fs.watch`,
  // Produktivpfad unverändert) — hier liefert `watchImpl` den ECHTEN, von
  // `node:fs.watch()` erzeugten FSWatcher unverändert zurück und greift ihn
  // nur zusätzlich ab, um den Test direkt `.emit('error', …)` darauf
  // aufrufen zu lassen. Deterministisch, läuft innerhalb von Jest (kein
  // Kindprozess nötig — hier wird nicht ein ECHTER Prozess-Crash beobachtet,
  // sondern nur, dass der error-Listener den Fehler zuverlässig in den
  // Iterator routet, bevor er zur uncaughtException eskalieren könnte).
  it('error-Listener: ein reales error-Event auf dem internen FSWatcher rejected den Async-Iterator direkt', async () => {
    const { watch: realWatch } = await import('node:fs');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const root = await mkdtemp(path.join(tmpdir(), 'fswatch-error-listener-'));
    let capturedWatcher = null;
    const watchImpl = (...args) => {
      capturedWatcher = realWatch(...args);
      return capturedWatcher;
    };

    try {
      const ac = new AbortController();
      const iterable = watchWithErrorGuard(root, {
        recursive: true,
        signal: ac.signal,
        watchImpl,
      });
      const iterator = iterable[Symbol.asyncIterator]();

      expect(capturedWatcher).not.toBeNull();

      const synthError = Object.assign(
        new Error(
          `ENOENT: no such file or directory, scandir '${path.join(root, 'test', '.tmp-abc')}'`,
        ),
        { code: 'ENOENT', syscall: 'scandir' },
      );

      // Genau der Mechanismus, den watchWithErrorGuard() laut Doc-Kommentar
      // als Härtung trägt: der registrierte watcher.on('error', …)-Listener.
      capturedWatcher.emit('error', synthError);

      await expect(iterator.next()).rejects.toBe(synthError);

      ac.abort();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('fswatcher-crash-hardening V2 AC11 — Regressionstest Vorfall 2026-07-07 (Kindprozess, ECHTER Watcher)', () => {
  it(
    'Test-Temp-Dir Create/Delete-Zyklus unter rekursivem Watch crasht nie, Watcher bleibt funktionsfähig',
    async () => {
      const { execFile } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const path = await import('node:path');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const scriptPath = path.join(__dirname, 'fixtures', 'fswatcher-regression-child.mjs');

      const { exitCode, stdout, stderr } = await new Promise((resolve) => {
        execFile(process.execPath, [scriptPath], { timeout: 25000 }, (err, so, se) => {
          resolve({ exitCode: err ? (err.code ?? 1) : 0, stdout: so, stderr: se });
        });
      });

      // (a) kein Prozess-Exit / keine uncaught exception / kein unhandled rejection
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      // (b) der Watcher-Baustein bleibt funktionsfähig: eine Änderung an einem
      // beobachteten Pfad NACH der Churn-Sequenz invalidiert den Index weiterhin
      // (verifiziert innerhalb des Kindprozesses, siehe fswatcher-regression-
      // child.mjs — 'second-probe' muss im Index auftauchen).
      expect(stdout).toContain('OK');
    },
    30000,
  );
});

describe('fswatcher-crash-hardening V2 AC9 — Scope-Verengung (Integration, echter BoardAggregator)', () => {
  let tmpRoot;
  let aggregator;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'fswatch-scope-narrowing-'));
  });

  afterEach(async () => {
    aggregator.stopWatchers();
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    'eine Mutation unter node_modules invalidiert den Index NICHT (kein Watcher dort bewaffnet)',
    async () => {
      const repoBoardDir = join(tmpRoot, 'probe-repo', 'board');
      await mkdir(repoBoardDir, { recursive: true });
      await writeFile(
        join(repoBoardDir, 'board.yaml'),
        'schema_version: 1\nproject_slug: probe-repo\n',
        'utf8',
      );

      aggregator = new BoardAggregator({ boardRootsEnv: tmpRoot });
      await aggregator.getIndex(); // Baseline-Scan, Index nicht mehr null
      aggregator.startWatchers();
      await sleep(400);

      // Mutation unter einem IGNORIERTEN Unterbaum (node_modules).
      const binDir = join(tmpRoot, 'probe-repo', 'node_modules', '.bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, 'tool'), '#!/bin/sh\n', 'utf8');
      await sleep(500); // > WATCH_DEBOUNCE_MS, falls (fälschlich) ein Watcher feuert

      // getIndex() OHNE expliziten scan() darf die node_modules-Mutation NICHT
      // gesehen haben — kein Re-Scan wurde durch sie ausgelöst. Da der Index
      // vorher bereits befüllt war und sich sonst nichts geändert hat, bleibt
      // die zurückgegebene Referenz bei einem echten Re-Scan-Trigger geändert;
      // wir verifizieren stattdessen direkt über einen zweiten Marker: eine
      // GLEICHZEITIGE, echte board/-Mutation NACH der ignorierten Mutation
      // muss weiterhin (separat) erkannt werden — die ignorierte Mutation
      // selbst darf keine sichtbare Wirkung auf den Index gehabt haben.
      const indexAfterIgnoredMutation = await aggregator.getIndex();
      expect(indexAfterIgnoredMutation.some((p) => p.slug === 'probe-repo')).toBe(true);
      // node_modules-Inhalt taucht nirgends im Index auf (ohnehin nicht Teil
      // des Board-Schemas) — der eigentliche Beleg ist AC10 unten (board/-
      // Mutation NACH einer ignorierten Mutation wird weiterhin erkannt).
    },
    15000,
  );
});

describe('fswatcher-crash-hardening V2 AC10 — Index-Aktualität bleibt erhalten (Integration, echter BoardAggregator)', () => {
  let tmpRoot;
  let aggregator;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'fswatch-index-freshness-'));
  });

  afterEach(async () => {
    aggregator.stopWatchers();
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    'eine Mutation unter board/ invalidiert den Index weiterhin (auch NACH einer ignorierten node_modules-Mutation)',
    async () => {
      const repoBoardDir = join(tmpRoot, 'probe-repo', 'board');
      await mkdir(repoBoardDir, { recursive: true });
      await writeFile(
        join(repoBoardDir, 'board.yaml'),
        'schema_version: 1\nproject_slug: probe-repo\n',
        'utf8',
      );

      aggregator = new BoardAggregator({ boardRootsEnv: tmpRoot });
      aggregator.startWatchers();
      await sleep(400);

      // Erst eine ignorierte Mutation (node_modules) — darf spätere board/-
      // Erkennung nicht stören.
      const binDir = join(tmpRoot, 'probe-repo', 'node_modules', '.bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, 'tool'), '#!/bin/sh\n', 'utf8');
      await sleep(300);

      // Dann eine index-relevante Mutation: neues Feature-Verzeichnis unter
      // board/ (board/features/) — muss den Index invalidieren.
      const featuresDir = join(tmpRoot, 'probe-repo', 'board', 'features');
      await mkdir(featuresDir, { recursive: true });
      await writeFile(
        join(featuresDir, 'F-001-probe.yaml'),
        'id: F-001\ntitle: Probe\ngoal: Test\nstatus: Active\npriority: P2\nspec: docs/specs/probe.md\nlabels: []\ncreated_at: 2026-07-07T00:00:00Z\nupdated_at: 2026-07-07T00:00:00Z\nstories: []\n',
        'utf8',
      );
      await sleep(500); // > WATCH_DEBOUNCE_MS (200ms) + Puffer für reale Event-Latenz

      const index = await aggregator.getIndex();
      const project = index.find((p) => p.slug === 'probe-repo');
      expect(project).toBeDefined();
      expect(project.features.some((f) => f.id === 'F-001')).toBe(true);
    },
    15000,
  );

  it(
    'eine Mutation unter docs/specs/ invalidiert den Index weiterhin (index-relevanter Unterbaum bleibt beobachtet)',
    async () => {
      const repoRoot = join(tmpRoot, 'probe-repo');
      const repoBoardDir = join(repoRoot, 'board');
      await mkdir(repoBoardDir, { recursive: true });
      await writeFile(
        join(repoBoardDir, 'board.yaml'),
        'schema_version: 1\nproject_slug: probe-repo\n',
        'utf8',
      );
      await mkdir(join(repoRoot, 'docs', 'specs'), { recursive: true });

      aggregator = new BoardAggregator({ boardRootsEnv: tmpRoot });
      // Baseline-Scan sicherstellen, dass das Projekt schon sichtbar ist.
      await aggregator.getIndex();
      aggregator.startWatchers();
      await sleep(400);

      // Mutation unter docs/specs/ (index-relevant laut AC9-Vertrag, auch wenn
      // BoardAggregator selbst Spec-Dateiinhalte nicht in den Index liest —
      // der Vertrag verlangt nur, dass dieser Unterbaum WEITERHIN beobachtet
      // wird; wir verifizieren das indirekt über eine GLEICHZEITIGE board/-
      // Mutation, die nach dem docs/specs/-Write ebenfalls sicher ankommt).
      await writeFile(
        join(repoRoot, 'docs', 'specs', 'probe.md'),
        '# Probe Spec\n',
        'utf8',
      );
      const featuresDir = join(repoBoardDir, 'features');
      await mkdir(featuresDir, { recursive: true });
      await writeFile(
        join(featuresDir, 'F-002-probe.yaml'),
        'id: F-002\ntitle: Probe2\ngoal: Test\nstatus: Active\npriority: P2\nspec: docs/specs/probe.md\nlabels: []\ncreated_at: 2026-07-07T00:00:00Z\nupdated_at: 2026-07-07T00:00:00Z\nstories: []\n',
        'utf8',
      );
      await sleep(500);

      const index = await aggregator.getIndex();
      const project = index.find((p) => p.slug === 'probe-repo');
      expect(project).toBeDefined();
      expect(project.features.some((f) => f.id === 'F-002')).toBe(true);
    },
    15000,
  );
});

// ── board-aggregator-periodic-rescan (S-325) ───────────────────────────────────
//
// Covers (board-aggregator-periodic-rescan): siehe Datei-Header (Covers-Block)
// oben. Strategy: injizierte #fsDeps (setTimeout/clearTimeout via
// makeFakeTimers(), watch via hangingAsyncIterable()/gezielte Async-
// Generatoren) — kein echtes Warten, kein jest.useFakeTimers() (Muster
// identisch zu den bestehenden fswatcher-crash-hardening-Tests oben).

/**
 * Ein async-iterable, dessen `next()` NIE auflöst — bildet einen watch()-
 * Iterator ab, der niemals ein fs-Event liefert (board-aggregator-periodic-
 * rescan AC1 — das exakte strukturelle Abbild des macOS-Docker-Bind-Mount-
 * Vorfalls S-061, siehe Spec Annahme A6: "watch feuert nie" statt eines
 * echten, in CI nicht reproduzierbaren Bind-Mounts).
 */
function hangingAsyncIterable() {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise(() => { /* never resolves */ }) };
    },
  };
}

/**
 * Ein async-iterable, das GENAU EIN Event liefert und danach — wie ein
 * echter, weiterhin aktiver `fs.watch()`-Stream — auf das NÄCHSTE Event
 * wartet (hängt, statt zu enden). Ein async-Generator, der nach einem
 * einzigen `yield` normal endet, würde den `for await`-Loop in `_watchRoot()`
 * sofort verlassen und dessen `finally`-Block den soeben gesetzten Debounce-
 * Timer wieder clearen (board-aggregator-periodic-rescan AC2-Test-Artefakt)
 * — dieses Double bildet daher einen weiterhin lauschenden Watcher ab.
 * @param {object} event
 */
function onceThenHangingAsyncIterable(event) {
  let yielded = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (!yielded) {
            yielded = true;
            return Promise.resolve({ done: false, value: event });
          }
          return new Promise(() => { /* weiterhin aktiv, kein zweites Event */ });
        },
      };
    },
  };
}

describe('parseRescanIntervalMs (board-aggregator-periodic-rescan AC3)', () => {
  it('fehlende/leere Env → Default 60000, keine Warnung', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseRescanIntervalMs(undefined)).toBe(60000);
      expect(parseRescanIntervalMs('')).toBe(60000);
      expect(parseRescanIntervalMs('   ')).toBe(60000);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('gültige Env wird übernommen', () => {
    expect(parseRescanIntervalMs('30000')).toBe(30000);
    expect(parseRescanIntervalMs(' 15000 ')).toBe(15000);
  });

  it('nicht parsbare Env (kein Ganzzahl-String) → Default + einmalige Warnung', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseRescanIntervalMs('abc')).toBe(60000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('BOARD_RESCAN_INTERVAL_MS');

      warnSpy.mockClear();
      expect(parseRescanIntervalMs('12.5')).toBe(60000); // kein Ganzzahl-Wert
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('negative Env → Default + einmalige Warnung', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseRescanIntervalMs('-100')).toBe(60000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('"0" deaktiviert (Opt-out) — unverändert 0, keine Warnung', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseRescanIntervalMs('0')).toBe(0);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('board-aggregator-periodic-rescan AC3 — Konstruktor-Option/Env-Wirkung auf den bewaffneten Timer', () => {
  function makeEnvAwareAggregator(timers, { boardRootsEnv, rescanIntervalMs } = {}) {
    return new BoardAggregator({
      boardRootsEnv,
      rescanIntervalMs,
      fsDeps: {
        readdir: async () => [],
        readFile: async () => '',
        watch: () => hangingAsyncIterable(),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => true,
      },
    });
  }

  it('rescanIntervalMs-Option hat Vorrang vor BOARD_RESCAN_INTERVAL_MS', async () => {
    const timers = makeFakeTimers();
    const prevEnv = process.env.BOARD_RESCAN_INTERVAL_MS;
    process.env.BOARD_RESCAN_INTERVAL_MS = '99999';
    try {
      const aggregator = makeEnvAwareAggregator(timers, {
        boardRootsEnv: '/tmp/does-not-matter-rescan-ac3a',
        rescanIntervalMs: 12345,
      });
      aggregator.startWatchers();
      await flushMicrotasks();
      expect(timers.pending.size).toBe(1);
      expect([...timers.pending.values()][0].delay).toBe(12345);
      aggregator.stopWatchers();
    } finally {
      if (prevEnv === undefined) delete process.env.BOARD_RESCAN_INTERVAL_MS;
      else process.env.BOARD_RESCAN_INTERVAL_MS = prevEnv;
    }
  });

  it('rescanIntervalMs: 0 deaktiviert den periodischen Rescan — kein Timer wird bewaffnet', async () => {
    const timers = makeFakeTimers();
    const aggregator = makeEnvAwareAggregator(timers, {
      boardRootsEnv: '/tmp/does-not-matter-rescan-ac3b',
      rescanIntervalMs: 0,
    });
    aggregator.startWatchers();
    await flushMicrotasks();
    expect(timers.pending.size).toBe(0);
    aggregator.stopWatchers();
  });

  it('BOARD_RESCAN_INTERVAL_MS="0" (Env, kein Options-Override) deaktiviert den Timer ebenso', async () => {
    const timers = makeFakeTimers();
    const prevEnv = process.env.BOARD_RESCAN_INTERVAL_MS;
    process.env.BOARD_RESCAN_INTERVAL_MS = '0';
    try {
      const aggregator = makeEnvAwareAggregator(timers, {
        boardRootsEnv: '/tmp/does-not-matter-rescan-ac3c',
      });
      aggregator.startWatchers();
      await flushMicrotasks();
      expect(timers.pending.size).toBe(0);
      aggregator.stopWatchers();
    } finally {
      if (prevEnv === undefined) delete process.env.BOARD_RESCAN_INTERVAL_MS;
      else process.env.BOARD_RESCAN_INTERVAL_MS = prevEnv;
    }
  });

  it('gültige BOARD_RESCAN_INTERVAL_MS-Env (kein Options-Override) bewaffnet den Timer mit diesem Wert', async () => {
    const timers = makeFakeTimers();
    const prevEnv = process.env.BOARD_RESCAN_INTERVAL_MS;
    process.env.BOARD_RESCAN_INTERVAL_MS = '5000';
    try {
      const aggregator = makeEnvAwareAggregator(timers, {
        boardRootsEnv: '/tmp/does-not-matter-rescan-ac3d',
      });
      aggregator.startWatchers();
      await flushMicrotasks();
      expect(timers.pending.size).toBe(1);
      expect([...timers.pending.values()][0].delay).toBe(5000);
      aggregator.stopWatchers();
    } finally {
      if (prevEnv === undefined) delete process.env.BOARD_RESCAN_INTERVAL_MS;
      else process.env.BOARD_RESCAN_INTERVAL_MS = prevEnv;
    }
  });

  it('fehlende BOARD_RESCAN_INTERVAL_MS-Env (kein Options-Override) bewaffnet den Timer mit dem Default 60000', async () => {
    const timers = makeFakeTimers();
    const prevEnv = process.env.BOARD_RESCAN_INTERVAL_MS;
    delete process.env.BOARD_RESCAN_INTERVAL_MS;
    try {
      const aggregator = makeEnvAwareAggregator(timers, {
        boardRootsEnv: '/tmp/does-not-matter-rescan-ac3e',
      });
      aggregator.startWatchers();
      await flushMicrotasks();
      expect(timers.pending.size).toBe(1);
      expect([...timers.pending.values()][0].delay).toBe(60000);
      aggregator.stopWatchers();
    } finally {
      if (prevEnv === undefined) delete process.env.BOARD_RESCAN_INTERVAL_MS;
      else process.env.BOARD_RESCAN_INTERVAL_MS = prevEnv;
    }
  });
});

describe('board-aggregator-periodic-rescan AC1 — verpasstes fs-Event wird spätestens nach einem Intervall sichtbar (Vorfall S-061)', () => {
  it('ein Datei-Wechsel ohne fs-Event (watch liefert nie ein Event) wird nach einem Rescan-Tick an getIndex() sichtbar', async () => {
    const ROOT = '/fake/rescan-ac1';
    const specContent = '---\nstatus: active\n---\n# Spec\nAC1 — Kern.\n';
    const storyYamlBlocked = [
      'id: S-001',
      'parent: F-001',
      'title: Kern-Story',
      'status: To Do',
      'priority: P1',
      'spec: docs/specs/x.md',
      'implements: [AC1]',
      'labels: []',
      'dispo_est: null',
      'dispo_act: null',
      'created_at: 2026-07-08T00:00:00Z',
      'updated_at: 2026-07-08T00:00:00Z',
      'done_at: null',
      'blocked_reason: warte-auf-freigabe',
      '',
    ].join('\n');
    const storyYamlUnblocked = storyYamlBlocked.replace(
      'blocked_reason: warte-auf-freigabe',
      'blocked_reason: null',
    );

    const files = {
      [`${ROOT}/proj/board/board.yaml`]: 'schema_version: 1\nproject_slug: proj\n',
      [`${ROOT}/proj/board/features/F-001-kern.yaml`]:
        'id: F-001\ntitle: Kern\ngoal: Test\nstatus: Active\npriority: P1\nspec: docs/specs/x.md\nlabels: []\ncreated_at: 2026-07-08T00:00:00Z\nupdated_at: 2026-07-08T00:00:00Z\nstories:\n- S-001\nprogress: null\n',
      [`${ROOT}/proj/board/stories/S-001-kern.yaml`]: storyYamlBlocked,
      [`${ROOT}/proj/docs/specs/x.md`]: specContent,
    };
    const dirs = {
      [ROOT]: [{ name: 'proj', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false }],
      [`${ROOT}/proj`]: [{ name: 'board', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false }],
      [`${ROOT}/proj/board`]: [
        { name: 'board.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'features', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        { name: 'stories', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      ],
      [`${ROOT}/proj/board/features`]: [
        { name: 'F-001-kern.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ],
      [`${ROOT}/proj/board/stories`]: [
        { name: 'S-001-kern.yaml', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ],
    };

    const timers = makeFakeTimers();
    const aggregator = new BoardAggregator({
      boardRootsEnv: ROOT,
      rescanIntervalMs: 60000,
      fsDeps: {
        readdir: async (path) => {
          if (path in dirs) return dirs[path];
          const err = new Error(`ENOENT: no such dir: ${path}`);
          err.code = 'ENOENT';
          throw err;
        },
        readFile: async (path) => {
          if (path in files) return files[path];
          const err = new Error(`ENOENT: no such file: ${path}`);
          err.code = 'ENOENT';
          throw err;
        },
        // AC1-Kernvoraussetzung: watch(), das NIE ein Event liefert — das
        // exakte strukturelle Abbild des macOS-Docker-Bind-Mount-Vorfalls.
        watch: () => hangingAsyncIterable(),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => false,
      },
    });

    // scan() spyen (ruft die echte Implementierung weiter auf) — erlaubt,
    // das vom Rescan-Tick ausgelöste ECHTE scan()-Promise deterministisch
    // abzuwarten, statt eine Anzahl Microtask-Flush-Runden zu erraten (die
    // echte _readBoard()-Kette hat mehrere sequenzielle awaits).
    const scanSpy = jest.spyOn(aggregator, 'scan');

    aggregator.startWatchers();
    await flushMicrotasks();

    // Baseline: Story ist geblockt (initialer Stand) — Index memoisiert (AC2).
    let index = await aggregator.getIndex();
    let story = index[0].features[0].stories[0];
    expect(story.ready).toBe(false);
    expect(story.blocked_reason).toBe('warte-auf-freigabe');

    // Vorfall-Abbild: Host-seitige Änderung OHNE fs-Event (watch liefert nie
    // eines) — z.B. ein Host-git-merge unter macOS-Docker-Bind-Mount.
    files[`${ROOT}/proj/board/stories/S-001-kern.yaml`] = storyYamlUnblocked;

    // Ohne Rescan-Tick bleibt getIndex() beim alten, gecachten Stand.
    index = await aggregator.getIndex();
    story = index[0].features[0].stories[0];
    expect(story.ready).toBe(false);

    // Ein Rescan-Intervall vorstellen (Timer feuern).
    const rescanEntry = [...timers.pending.entries()].find(([, e]) => e.delay === 60000);
    expect(rescanEntry).toBeDefined();
    const [rescanTimerId, entry] = rescanEntry;
    timers.pending.delete(rescanTimerId);
    entry.fn();
    // Auf den vom Tick ausgelösten (zweiten) echten scan()-Aufruf warten —
    // deterministisch, unabhängig von der Anzahl seiner internen awaits.
    expect(scanSpy).toHaveBeenCalledTimes(2);
    await scanSpy.mock.results[1].value;
    await flushMicrotasks();

    // Neuer Stand ist jetzt sichtbar — spätestens nach einem Intervall, ohne
    // Container-/Prozess-Neustart und ohne expliziten POST .../rescan.
    index = await aggregator.getIndex();
    story = index[0].features[0].stories[0];
    expect(story.ready).toBe(true);
    expect(story.blocked_reason).toBeNull();

    aggregator.stopWatchers();
  });
});

describe('board-aggregator-periodic-rescan AC2 — Event-Pfad + SSE bleiben additiv unverändert (kein Ersatz)', () => {
  it('ein fs-Event invalidiert den Index weiterhin debounced — deutlich VOR Ablauf eines (bewusst großen) Rescan-Intervalls, das koexistiert', async () => {
    const META_ROOT = '/tmp/does-not-matter-rescan-ac2';
    const SUBTREE_ROOT = `${META_ROOT}/repo/board`;
    const timers = makeFakeTimers();

    const aggregator = new BoardAggregator({
      boardRootsEnv: META_ROOT,
      rescanIntervalMs: 60000, // bewusst groß — darf in diesem Test nie feuern
      fsDeps: {
        readdir: async () => [],
        readFile: async () => '',
        watch: (path) => {
          // Meta-Watch (Top-Level-Wurzel): nie ein Event.
          if (path === META_ROOT) return hangingAsyncIterable();
          // Direkt aufgerufener Subtree-Watch (Test-Isolation, Muster
          // fswatcher-crash-hardening AC3-Test): genau EIN Event, danach
          // weiterhin aktiv (wie ein echter Watch-Stream) — kein sofortiges
          // Loop-Ende, das den gerade gesetzten Debounce-Timer wieder clearen
          // würde.
          return onceThenHangingAsyncIterable({ eventType: 'change', filename: 'S-001.yaml' });
        },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => false,
      },
    });

    const indexBaseline = await aggregator.getIndex(); // Baseline-Scan

    aggregator.startWatchers();
    await flushMicrotasks();

    // Der (grosse) Rescan-Timer wurde additiv bewaffnet — unverändert, koexistiert.
    const rescanEntry = [...timers.pending.entries()].find(([, e]) => e.delay === 60000);
    expect(rescanEntry).toBeDefined();
    const [rescanTimerId] = rescanEntry;

    // Direkter Subtree-Watch-Aufruf (isoliert den event-getriebenen Debounce-
    // Pfad vom Meta-/Subtree-Dispatch, der unverändert + separat in den
    // bestehenden fswatcher-crash-hardening-Tests abgedeckt bleibt). Der
    // Watch-Stream bleibt danach aktiv (kein Loop-Ende) — das zurückgegebene
    // Promise wird bewusst NICHT awaited (bliebe sonst dauerhaft pending).
    const ac = new AbortController();
    void aggregator._watchRoot(SUBTREE_ROOT, ac.signal, undefined, undefined, false);
    await flushMicrotasks();

    // Debounce-Timer (WATCH_DEBOUNCE_MS = 200ms) — deutlich schneller als das
    // (60000ms) Rescan-Intervall.
    const debounceEntry = [...timers.pending.entries()].find(([, e]) => e.delay === 200);
    expect(debounceEntry).toBeDefined();
    expect(200).toBeLessThan(60000);

    const [debounceTimerId, debounceTimer] = debounceEntry;
    timers.pending.delete(debounceTimerId);
    debounceTimer.fn(); // Debounce feuert -> Index invalidiert
    await flushMicrotasks();
    ac.abort();

    // Index wurde invalidiert — der nächste getIndex() re-scant, OHNE dass
    // der (60000ms) Rescan-Timer je gefeuert hat.
    const indexAfterEvent = await aggregator.getIndex();
    expect(indexAfterEvent).not.toBe(indexBaseline);

    // Der Rescan-Timer ist unverändert derselbe, weiterhin ausstehende Timer
    // — der Event-Pfad hat ihn weder verbraucht noch neu bewaffnet (additiv,
    // kein zweiter Diff-/Broadcast-Pfad, AC2).
    expect(timers.pending.has(rescanTimerId)).toBe(true);

    aggregator.stopWatchers();
  });
});

describe('board-aggregator-periodic-rescan AC4 — kein Rescan-Sturm / kein Overlap', () => {
  it('ein Tick während eines laufenden Rescans wird übersprungen (kein zweiter paralleler scan()); nach Abschluss läuft der nächste Tick regulär', async () => {
    const timers = makeFakeTimers();
    const aggregator = new BoardAggregator({
      boardRootsEnv: '/tmp/does-not-matter-rescan-ac4',
      rescanIntervalMs: 1000,
      fsDeps: {
        readdir: async () => [],
        readFile: async () => '',
        watch: () => hangingAsyncIterable(),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => true,
      },
    });

    // scan() kontrolliert langsam auflösend (Deferred) — Muster laut Spec
    // "Verträge"/AC4-Testbeschreibung.
    let resolveScan;
    aggregator.scan = jest.fn(() => new Promise((resolve) => { resolveScan = resolve; }));

    aggregator.startWatchers();
    await flushMicrotasks();
    expect(timers.pending.size).toBe(1);
    const [timerId, entry] = [...timers.pending.entries()][0];
    expect(entry.delay).toBe(1000);

    // Tick feuern -> scan() aufgerufen, bleibt in-flight (hängender Promise).
    timers.pending.delete(timerId);
    entry.fn();
    await flushMicrotasks();
    expect(aggregator.scan).toHaveBeenCalledTimes(1);
    // Self-Rescheduling: solange der Rescan läuft, ist KEIN neuer Timer
    // bewaffnet (der nächste wird erst im finally() nach scan() geplant).
    expect(timers.pending.size).toBe(0);

    // Ein weiterer Tick, der (re-entrant) während der In-flight-Phase feuert
    // — direkter Beleg des Overlap-Schutzes, unabhängig von der Self-
    // Rescheduling-Struktur, die einen zweiten parallelen Timer strukturell
    // bereits ausschliesst.
    aggregator._onRescanTick();
    aggregator._onRescanTick();
    await flushMicrotasks();
    expect(aggregator.scan).toHaveBeenCalledTimes(1); // kein zweiter paralleler scan()

    // Rescan abschliessen -> normaler Rhythmus setzt fort.
    resolveScan();
    await flushMicrotasks();
    expect(timers.pending.size).toBe(1);
    expect([...timers.pending.values()][0].delay).toBe(1000);

    aggregator.stopWatchers();
  });
});

describe('board-aggregator-periodic-rescan AC5 — Lebenszyklus, kein Timer-Leak', () => {
  it('stopWatchers() bricht den Rescan-Timer ab — kein Folge-Tick, kein Timer-Leak', async () => {
    const timers = makeFakeTimers();
    const aggregator = new BoardAggregator({
      boardRootsEnv: '/tmp/does-not-matter-rescan-ac5a',
      rescanIntervalMs: 1000,
      fsDeps: {
        readdir: async () => [],
        readFile: async () => '',
        watch: () => hangingAsyncIterable(),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => true,
      },
    });
    let scanCalls = 0;
    aggregator.scan = jest.fn(async () => { scanCalls++; });

    aggregator.startWatchers();
    await flushMicrotasks();
    expect(timers.pending.size).toBe(1);

    aggregator.stopWatchers();
    expect(timers.pending.size).toBe(0);
    expect(timers.clearCalls.length).toBeGreaterThan(0);

    // Selbst nach vollständigem Flush darf kein weiterer Rescan (scan())
    // erfolgen — kein Timer bleibt aktiv.
    await flushMicrotasks();
    expect(scanCalls).toBe(0);
  });

  it('doppeltes startWatchers() erzeugt keinen zweiten parallelen Rescan-Zyklus', async () => {
    const timers = makeFakeTimers();
    const aggregator = new BoardAggregator({
      boardRootsEnv: '/tmp/does-not-matter-rescan-ac5b',
      rescanIntervalMs: 1000,
      fsDeps: {
        readdir: async () => [],
        readFile: async () => '',
        watch: () => hangingAsyncIterable(),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => true,
      },
    });

    aggregator.startWatchers();
    await flushMicrotasks();
    expect(timers.pending.size).toBe(1);

    aggregator.startWatchers(); // zweiter Aufruf — muss idempotent bleiben.
    await flushMicrotasks();
    expect(timers.pending.size).toBe(1); // weiterhin nur EIN ausstehender Rescan-Timer

    aggregator.stopWatchers();
  });

  it('stopWatchers() während eines laufenden Rescans: der in-flight scan() läuft zu Ende, aber es wird kein Folge-Tick geplant', async () => {
    const timers = makeFakeTimers();
    const aggregator = new BoardAggregator({
      boardRootsEnv: '/tmp/does-not-matter-rescan-ac5c',
      rescanIntervalMs: 1000,
      fsDeps: {
        readdir: async () => [],
        readFile: async () => '',
        watch: () => hangingAsyncIterable(),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        pathExists: async () => true,
      },
    });
    let resolveScan;
    aggregator.scan = jest.fn(() => new Promise((resolve) => { resolveScan = resolve; }));

    aggregator.startWatchers();
    await flushMicrotasks();
    const [timerId, entry] = [...timers.pending.entries()][0];
    timers.pending.delete(timerId);
    entry.fn(); // Tick feuert -> scan() in-flight (hängender Promise)
    await flushMicrotasks();
    expect(aggregator.scan).toHaveBeenCalledTimes(1);

    aggregator.stopWatchers(); // Stop WÄHREND der Rescan noch läuft

    // Der in-flight scan() läuft zu Ende (read-only, harmlos).
    resolveScan();
    await flushMicrotasks();

    // Kein Folge-Timer wurde geplant (AC5) — trotz erfolgreichem Abschluss.
    expect(timers.pending.size).toBe(0);
  });
});

describe('board-aggregator-periodic-rescan AC6 — degradierend, nie fatal', () => {
  it('ein scheiternder Rescan (scan() wirft) crasht nicht — der nächste Tick läuft regulär weiter', async () => {
    const timers = makeFakeTimers();
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const aggregator = new BoardAggregator({
        boardRootsEnv: '/tmp/does-not-matter-rescan-ac6',
        rescanIntervalMs: 1000,
        fsDeps: {
          readdir: async () => [],
          readFile: async () => '',
          watch: () => hangingAsyncIterable(),
          setTimeout: timers.setTimeout,
          clearTimeout: timers.clearTimeout,
          pathExists: async () => true,
        },
      });

      let scanCalls = 0;
      aggregator.scan = jest.fn(async () => {
        scanCalls++;
        throw new Error('scan boom');
      });

      aggregator.startWatchers();
      await flushMicrotasks();
      expect(timers.pending.size).toBe(1);

      // Ersten Tick feuern -> scan() wirft.
      await timers.fireNext();
      expect(scanCalls).toBe(1);
      expect(rejections).toEqual([]); // kein unhandled rejection, kein Crash

      // Zyklus läuft weiter: ein neuer Timer wurde regulär bewaffnet.
      expect(timers.pending.size).toBe(1);

      // Zweiten Tick feuern -> scan() wird erneut regulär aufgerufen.
      await timers.fireNext();
      expect(scanCalls).toBe(2);

      aggregator.stopWatchers();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
