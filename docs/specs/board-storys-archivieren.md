---
id: board-storys-archivieren
title: Archiv-Umbau — „Erledigte Storys archivieren" (Story-Ebene), Bereichs-Kacheln bleiben sichtbar
status: active
area: board
version: 1
---

# Spec: Archiv-Umbau auf Story-Ebene  (`board-storys-archivieren`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).
>
> **Supersedet den Feature-Ebenen-Archivpfad aus [[board-feature-archive]]** (dessen V4/V5-Button + Endpoint „erledigte **Features** archivieren"). Die byte-genau/atomar/idempotenten Schreib-Primitive (V2/AC2) und der `includeArchived`-Aggregatorfilter (V3/AC3) aus [[board-feature-archive]] werden **wiederverwendet** — nur die **Archiv-Einheit** wechselt von Feature auf **Story**. Bestehende feature-archivierte Bestände bleiben **kompatibel** (V5/AC5).

## Zweck
Mit den **Bereichs-Features** ([[bereichs-modell]]) sind die Board-Kacheln **dauerhafte App-Bereiche** — sie werden **nie** archiviert. Archiviert werden nur noch **erledigte Storys** (die kurzlebigen Arbeitspakete). Der bestehende Knopf **„Erledigte Features archivieren"** wird darum auf **„Erledigte Storys archivieren"** umgestellt: er entfernt **terminale Storys** (`Done`/`Verworfen`) aus der Standardansicht (in-place `archived`-Flag, kein Datenverlust), **ohne** die Bereichs-Kachel (das Bereichs-Feature) auszublenden. So bleibt das Board als **Strukturkarte** vollständig sichtbar, während erledigte Arbeit aufgeräumt wird.

## Kontext / Designentscheidungen
- **Archiv-Einheit = Story** (nicht mehr Feature). Ein Bereichs-Feature (Kachel) wird **nie** archiviert; es bleibt sichtbar, auch wenn **alle** seine Storys archiviert sind (dann als „leere"/aufgeräumte Kachel).
- **In-place-Flag, byte-genau, atomar, idempotent** — identische Primitive wie [[board-feature-archive]] V2/AC2 (`archived: true` + `archived_at` als Top-Level-Story-Feld; Story-`status` bleibt unverändert `Done`/`Verworfen`; `estimator`/`retro` lesen weiter am Ort).
- **`board/board.yaml` wird NICHT verändert** (keine Referenz-Umbauten).
- **Abwärtskompatibilität:** vorhandene feature-archivierte Bestände (`archived: true` auf **Feature**-YAMLs aus [[board-feature-archive]]) bleiben gültig — der Aggregator behandelt sowohl feature- als auch story-archivierte Einträge korrekt (V5).

## Verhalten

### V1 — Archivierbarkeits-Kriterium (Story-Ebene)
Eine Story ist **archivierbar** genau dann, wenn:
- ihr `status` **terminal** ist (`Done` **oder** `Verworfen`, konsistent mit [[board-feature-archive]] V7/[[board-status-verworfen]]), **und**
- sie **nicht bereits** archiviert ist (`archived` nicht `true`).
Nicht-terminale Storys (`Idee`/`To Do`/`In Progress`/`Blocked`/`In Review`) und bereits archivierte werden **nicht** angefasst. Das Kriterium stützt sich auf den tatsächlichen Story-`status`.

### V2 — Archiv-Schreibpfad (in-place, atomar, idempotent)
Eine neue Methode `BoardWriter.archiveDoneStories({ projectSlug, now? })` archiviert **alle aktuell archivierbaren Storys** des Projekts. Für jede solche Story patcht sie die **Story-YAML**: setzt/ergänzt `archived: true` + `archived_at: <ISO-8601-UTC>` + `updated_at`; der Story-`status` bleibt **unverändert**. Alle übrigen Zeilen (mehrzeilige Werte, Quoting, Schlüssel-Reihenfolge) bleiben **byte-genau** erhalten (Line-Patch/Append, Muster `patchTopLevelFields({allowAppend:true})`). Jede Datei wird **atomar** (tmp+rename, 0600) geschrieben. **Feature-YAMLs und `board/board.yaml` werden NICHT verändert.** Idempotent: bereits archivierte Storys werden übersprungen (kein zweites `archived_at`).

### V3 — Aggregator blendet archivierte Storys aus (Standardansicht) — Bereiche/Features bleiben sichtbar
Der Aggregat-Index schließt in der **Standardansicht** Storys mit `archived: true` aus (weder in Story-Listen noch in Zählern/Rollups). **Features/Bereiche bleiben sichtbar**, auch wenn **alle** ihre Storys archiviert sind (dauerhafte Kachel; Roll-up zeigt dann z.B. „0 offen / alle archiviert"). Ein `includeArchived`-Signal (Query/Option, wiederverwendet aus [[board-feature-archive]] V3) liefert archivierte Storys **zusätzlich**, klar als `archived` markiert.

### V4 — Endpoint + Button + Bestätigungsabfrage
- `POST /api/board/projects/:slug/archive-done-stories` archiviert alle aktuell archivierbaren Storys (V1) über V2. **Audit-First** (genau ein Eintrag je Aufruf), kurz gehaltenes `ProjectJobLock` (`409` belegt), Antwort `200 { archivedStoryCount }` (`0` ohne Fehler, wenn nichts archivierbar), `404` bei unbekanntem/ungültigem Slug.
- In der Board-Kopfleiste heißt der bisherige Knopf jetzt **„Erledigte Storys archivieren"**. Er ist **deaktiviert**, wenn keine Story archivierbar ist; sonst öffnet ein Klick eine **Bestätigungsabfrage** mit der **Anzahl betroffener Storys** (aus den geladenen Board-Daten nach V1 berechnet, z.B. „14 erledigte Storys werden archiviert. Sie verschwinden aus der Übersicht, bleiben aber gespeichert. Die Bereichs-Kacheln bleiben sichtbar."). **Abbrechen** → keine Aktion. **Bestätigen** → `POST …/archive-done-stories`; nach Erfolg wird die Übersicht neu geladen (archivierte Storys verschwinden, Kacheln bleiben). Fehler (`409`/`5xx`) nicht-blockierend gemeldet.
- Der **„Archiv anzeigen"-Schalter** (aus [[board-feature-archive]] V6, Default aus) blendet archivierte Storys read-only + klar markiert wieder ein (via `includeArchived`).

### V5 — Abwärtskompatibilität mit feature-archivierten Beständen
Der Aggregator behandelt **beide** Archiv-Formen korrekt: (a) story-archivierte Storys (`archived: true` auf Story-YAML, dieser Spec) werden ausgeblendet; (b) bestehende **feature-archivierte** Features (`archived: true` auf Feature-YAML aus [[board-feature-archive]]) bleiben — wie bisher — mitsamt ihren Storys aus der Standardansicht ausgeblendet (kein Bruch bestehender Bestände). Der **neue** Archiv-Knopf schreibt **ausschließlich** auf Story-Ebene; er erzeugt **keine** neuen feature-archivierten Einträge. Ein Re-Archivieren wandelt bestehende feature-archivierte Bestände **nicht** zwangsweise um (kein Migrationszwang an dieser Stelle).

## Acceptance-Kriterien

- **AC1** — `BoardWriter` bestimmt die archivierbaren Storys eines Projekts exakt nach V1: `status` ∈ {`Done`,`Verworfen`} UND nicht bereits archiviert; nicht-terminale und bereits archivierte Storys werden NICHT angefasst. *(V1)*
- **AC2** — `BoardWriter.archiveDoneStories` setzt in jeder archivierbaren Story-YAML `archived: true` + `archived_at` (+ `updated_at`), lässt den Story-`status` unverändert, erhält alle übrigen Zeilen byte-genau, schreibt atomar (tmp+rename, 0600) und verändert **weder** Feature-YAMLs **noch** `board/board.yaml`; wiederholter Aufruf ist idempotent (kein zweites `archived_at`). *(V2)*
- **AC3** — Der Aggregator-Standardindex enthält keine Storys mit `archived: true` (auch nicht in Zählern/Rollups), **aber** Features/Bereiche bleiben sichtbar, auch wenn alle ihre Storys archiviert sind; mit `includeArchived` werden archivierte Storys zusätzlich, als `archived` markiert, geliefert. *(V3)*
- **AC4** — `POST /api/board/projects/:slug/archive-done-stories` archiviert alle archivierbaren Storys, schreibt genau EINEN Audit-Eintrag (Audit-First), hält kurz das `ProjectJobLock` (`409` belegt), antwortet `200 { archivedStoryCount }` (`0` ohne Fehler wenn nichts archivierbar), `404` bei unbekanntem/ungültigem Slug; einziger Schreibpfad bleibt `BoardWriter`. *(V4)*
- **AC5** — Abwärtskompatibilität: der Aggregator blendet **sowohl** story-archivierte Storys **als auch** bestehende feature-archivierte Features (aus [[board-feature-archive]]) korrekt aus der Standardansicht aus; der neue Knopf schreibt ausschließlich auf Story-Ebene und erzeugt keine neuen feature-archivierten Einträge; bestehende feature-archivierte Bestände bleiben unverändert gültig. *(V5)*
- **AC6** — Der Board-Knopf heißt **„Erledigte Storys archivieren"**, ist deaktiviert wenn nichts archivierbar ist; sonst öffnet ein Klick eine Bestätigungsabfrage mit der **Anzahl betroffener Storys** und dem Hinweis, dass die Bereichs-Kacheln sichtbar bleiben; Abbrechen ändert nichts; Bestätigen ruft den Endpoint auf und lädt die Übersicht neu (archivierte Storys verschwinden, Kacheln bleiben); Endpoint-Fehler werden nicht-blockierend gemeldet. *(V4)*
- **AC7** — Der „Archiv anzeigen"-Schalter (Default aus, aus [[board-feature-archive]] V6) blendet archivierte Storys read-only + klar markiert ein (via `includeArchived`); ausgeschaltet gilt die Standardansicht. *(V4)*
- **AC8** — A11y (WCAG 2.1 AA): Knopf + Schalter sind echte `button`/Toggle-Elemente mit sprechendem `aria-label`; die Bestätigungsabfrage ist ein fokussiertes Dialog-Muster (`role="dialog"`, Fokusfalle/Esc-Abbruch, sichtbarer Fokusring); Bedeutung nicht allein über Farbe. *(V4)*
- **AC9** — Security/Robustheit: kein neuer Schreibpfad außer `BoardWriter` (Pfad-/Slug-Sicherheit per BOARD_ROOTS-Realpath-Schranke); kein `dangerouslySetInnerHTML`; keine Secrets in Ausgabe/Log/Audit; ungültige Eingaben werden sauber abgewiesen (kein Crash). *(alle)*

## Verträge

- **Endpoint:** `POST /api/board/projects/:slug/archive-done-stories`
  - Request: kein/leerer Body. `:slug` gegen `SLUG_RE` geprüft, nur gegen den In-Memory-Index aufgelöst (nie als Pfad).
  - Response `200`: `{ "archivedStoryCount": <int> }`.
  - `404 { error }` (Slug ungültig ODER Projekt nicht unter BOARD_ROOTS), `409 { error }` (`ProjectJobLock` belegt), `500 { error }` (Audit-/Schreibfehler — kein Secret-Leak).
- **Aggregator:** `getIndex({ includeArchived?: boolean })` (wiederverwendet aus [[board-feature-archive]]) — Standard `false` = ohne archivierte Storys; `true` = archivierte Storys zusätzlich, je Story `archived`/`archived_at` durchgereicht. Features/Bereiche bleiben in beiden Fällen sichtbar (außer bestehende feature-archivierte, V5).
- **YAML-Schema (additiv, optional, wie [[board-feature-archive]]):** Story-YAML erhält `archived: <bool>` + `archived_at: <ISO-8601-UTC>`. Fehlen sie, gilt `archived: false`.
- **`BoardWriter.archiveDoneStories({ projectSlug, now? })`** → `{ archivedStoryCount, archivedStoryIds }`. Einziger Schreibpfad; nutzt die vorhandenen Helfer (`patchTopLevelFields({allowAppend:true})`, `_atomicWrite`, `_resolveProjectPath`).

## Edge-Cases & Fehlerverhalten
- **Keine archivierbare Story** → Knopf deaktiviert; Endpoint (falls dennoch aufgerufen) antwortet `200 { 0 }`, kein Fehler.
- **Feature mit gemischten Storys (Done + To Do)** → nur die terminalen Storys werden archiviert; die Kachel + offene Storys bleiben sichtbar.
- **Feature, dessen Storys ALLE archiviert werden** → Kachel bleibt sichtbar (dauerhaftes Bereichs-Feature), Roll-up zeigt „alle archiviert".
- **Bereits archivierte Story** → übersprungen (idempotent), zählt nicht erneut.
- **Bestehendes feature-archiviertes Feature** → bleibt aus der Standardansicht ausgeblendet (V5), unangetastet.
- **Paralleler Taktgeber/Drain hält `ProjectJobLock`** → `409`, keine Teil-Archivierung; nicht-blockierender Hinweis.
- **Einzelne Story-Datei nicht patchbar** (`archived`-Schlüssel-Kollision) → diese Story wird übersprungen + geloggt; die übrigen werden dennoch archiviert (best effort, kein Gesamt-Absturz).

## NFRs
- **Datenintegrität:** atomare Einzeldatei-Writes; `estimator`/`retro` bleiben funktionsfähig (Story-Dateien bleiben am Ort, `status` unverändert).
- **Security (Floor):** Pfad-/Slug-Sicherheit über BOARD_ROOTS-Realpath-Schranke; Audit-First; kein Secret-Leak.
- **A11y/Design:** konsistent mit [[studis-kanban-board-ux]]/[[board-feature-collapse]]/[[board-feature-archive]].

## Nicht-Ziele
- **Archivieren von Bereichs-Features/Kacheln** (bewusst ausgeschlossen — Kacheln sind dauerhaft).
- **Zwangs-Migration** bestehender feature-archivierter Bestände auf Story-Ebene (kompatibel belassen; optionale Bereinigung ist [[bereichs-migration-dev-gui]]).
- **Hard-Delete** von Board-Dateien (estimator/retro-Datengrundlage).
- **Entarchivieren/Restore** aus der GUI (mögliches Folge-Feature).
- **Umbau der `board/board.yaml`-Referenzlisten**.

## Abhängigkeiten
- **dev-gui:** `src/BoardWriter.js` (neue `archiveDoneStories()`-Methode), `src/BoardAggregator.js` (Story-Ebenen-`archived`-Filter + Feature/Bereich-bleibt-sichtbar), `src/boardRouter.js` (`POST …/archive-done-stories`), `server.js` (Wiring), `client/src/BoardView.jsx` (Knopf-Umbenennung + Bestätigungsabfrage + Archiv-Schalter).
- **Specs:** [[board-feature-archive]] (supersedet dessen Feature-Archivpfad; wiederverwendet Schreib-Primitive + `includeArchived`), [[bereichs-modell]] (dauerhafte Bereichs-Kacheln), [[board-status-verworfen]] (terminaler Status `Verworfen`), [[studis-kanban-board-ux]]/[[board-feature-collapse]] (Kopfleiste), [[ideen-inbox]] (`BoardWriter`-Boundary).
