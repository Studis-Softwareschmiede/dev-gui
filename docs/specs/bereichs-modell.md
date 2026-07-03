---
id: bereichs-modell
title: Bereichs-Modell — board/areas.yaml lesen/schreiben + „Bereiche verwalten"-Dialog
status: active
area: board
version: 1
---

# Spec: Bereichs-Modell  (`bereichs-modell`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).
>
> **Leitidee (Owner-Ko-Design 2026-07-03).** Das Board zeigt die **Strukturkarte der App**: die Kacheln sind **Bereichs-Features** (dauerhafte App-Bereiche), **nicht** kurzlebige Auftrags-Features, die nach Erledigung archiviert werden. Bereiche sind langlebig; Storys/Ideen hängen darunter und werden erledigt/archiviert, die Bereichs-Kachel bleibt bestehen.

## Zweck
`dev-gui` liest die **durable Bereichsliste** eines Projekts aus `board/areas.yaml` (über den bestehenden Read-Aggregator) und macht sie als **dauerhafte Kacheln** (Bereichs-Features) im Studis-Kanban-Board sichtbar. Ein **„Bereiche verwalten"-Dialog** erlaubt Anlegen, Umbenennen und Umsortieren von Bereichen; Löschen ist **nur** möglich, wenn **keine** Storys/Specs mehr am Bereich hängen. Schreibzugriffe laufen über eine **schmale, atomare, auditierte Schreib-Boundary** (`AreaWriter`) — analog zum bestehenden `BoardWriter`.

> **Schema-Herkunft (textueller Verweis, KEIN cross-repo depends).** Das Schema von `board/areas.yaml` sowie das `area`-Feld auf Features/Storys und das `area`-Frontmatter auf Specs werden durch die **agent-flow-Schema-Specs zu `areas.yaml` / Bereichs-Features (Repo agent-flow)** definiert. Diese dev-gui-Spec **konsumiert und flächt** dieses Schema in der GUI — sie definiert es **nicht** neu. Ggf. noch offene agent-flow-Storys werden hier **nur textuell** referenziert (anderes Repo, kein `depends`).

## Kontext / Designentscheidungen

- **`board/areas.yaml` als Bereichsregister.** Erwartete, vom agent-flow-Schema vorgegebene Mindest-Form je Eintrag: `id` (kebab-case, stabil), `name` (Anzeigename), `order` (ganzzahlige Sortierung), optional `description`. Beispiel-Register (die vom Owner freigegebene initiale 11er-Liste für dieses Repo, angelegt durch die Migration [[bereichs-migration-dev-gui]], **nicht** durch diese Spec):
  `board` · `fabrik-arbeiten` · `nachtwaechter` · `einstellungen` · `vps` · `deployment` · `benachrichtigungen` · `obsidian` · `sicherung` · `spezifikation` · `retro-lernen`.
- **Bereich ↔ Bereichs-Feature (Kachel).** Jeder Bereich entspricht **einer** dauerhaften Kachel im Board. Ein Bereichs-Feature ist über sein additiv-optionales Feld `area: <area-id>` einem Bereich zugeordnet; die Kachel-Darstellung gruppiert nach Bereich. Bereichs-Features werden **nie** archiviert (die Kachel bleibt bestehen; siehe [[board-storys-archivieren]]).
- **`AreaWriter` als einziger Schreibpfad** für `board/areas.yaml` — atomar (tmp+rename, 0600), Audit-First, unter dem projektweiten `ProjectJobLock`; `BoardAggregator` bleibt **read-only** (ADR-005-Linie: `areas.yaml` ist projekt-eigene Board-Struktur, kein neuer Store).
- **Fehlende `areas.yaml` → leere Bereichsliste, kein Crash** (Abwärtskompatibilität mit Projekten ohne Bereiche; degradierende Standardansicht).

## Verhalten

### V1 — Bereiche lesen (BoardAggregator)
Der bestehende `BoardAggregator` liest je Projekt zusätzlich `board/areas.yaml` und liefert die Bereichsliste (je Bereich: `id`, `name`, `order`, optional `description`) **sortiert nach `order`** als Teil des Projekt-Index. Fehlt die Datei oder ist sie leer → leere Bereichsliste (kein Crash, kein Fehler). Ungültige/defekte Einträge werden übersprungen (best effort, geloggt), ohne den Gesamt-Index zu zerstören.

### V2 — Bereiche als dauerhafte Kacheln (Read-Model)
Der Projekt-Index verknüpft Bereiche mit ihren zugeordneten Bereichs-Features/Storys: je Bereich wird die Zahl **zugeordneter Storys** (bzw. der Roll-up-Fortschritt) sowie die Zugehörigkeit über `feature.area`/`story.area` ausgewiesen. Ein Bereich **ohne** angehängte Storys/Specs bleibt sichtbar (dauerhafte Kachel), ist aber als „leer" erkennbar (für die Lösch-Freigabe V5/AC5 relevant).

### V3 — Bereich anlegen (AreaWriter)
`AreaWriter.createArea({ projectSlug, name, description?, now? })` fügt `board/areas.yaml` einen neuen Bereich hinzu: generiert eine **stabile `id`** (kebab-case aus `name`, kollisionsfrei), setzt `order` ans Ende, schreibt **atomar** (tmp+rename, 0600). `name` wird getrimmt, nicht-leer und längenbegrenzt validiert. Duplikat-Name (case-insensitive) → Fehler (kein Doppel-Anlegen). Idempotenz nicht gefordert (Anlage erzeugt stets einen neuen Bereich, sofern Name frei).

### V4 — Bereich umbenennen + umsortieren (AreaWriter)
- `AreaWriter.renameArea({ projectSlug, id, name, now? })` ändert **nur** den `name` eines bestehenden Bereichs (die `id` bleibt **stabil** — keine Re-Verknüpfung nötig). Validierung wie V3.
- `AreaWriter.reorderAreas({ projectSlug, orderedIds, now? })` setzt die `order`-Werte gemäß der übergebenen ID-Reihenfolge. `orderedIds` muss **genau** die Menge der vorhandenen Bereichs-IDs sein (keine fehlenden/fremden IDs) → sonst Fehler. Atomarer Write.

### V5 — Bereich löschen — nur wenn leer (Lösch-Guard)
`AreaWriter.deleteArea({ projectSlug, id, now? })` entfernt einen Bereich **ausschließlich**, wenn **keine** Storys **und keine** Specs mehr an ihm hängen:
- **keine** Story/kein Feature mit `area === id` (weder aktiv noch archiviert),
- **keine** Spec mit `area: <id>` im Frontmatter (über den `DocsReader`, [[spec-bereich-filter]]).
Ist noch etwas zugeordnet → **harter Abbruch** mit Fehlerklasse `area-not-empty` (Anzahl gebundener Storys/Specs im Fehlerobjekt), **keine** Teil-Löschung. Sonst: Eintrag entfernen, verbleibende `order` bleiben lückentolerant gültig, atomarer Write.

### V6 — Endpunkte (Router)
Ein Bereichs-Router (oder Erweiterung des `boardRouter`) stellt bereit:
- `GET  /api/board/projects/:slug/areas` → Bereichsliste (Read, aus V1/V2).
- `POST /api/board/projects/:slug/areas` `{ name, description? }` → Anlegen (V3).
- `PATCH /api/board/projects/:slug/areas/:id` `{ name }` → Umbenennen (V4).
- `POST /api/board/projects/:slug/areas/reorder` `{ orderedIds }` → Umsortieren (V4).
- `DELETE /api/board/projects/:slug/areas/:id` → Löschen mit Guard (V5).
Alle **mutierenden** Endpunkte: hinter `accessGuard`, **Audit-First** (genau ein Audit-Eintrag je akzeptiertem Aufruf, vor dem Schreiben), kurz gehaltenes `ProjectJobLock` (`409` wenn belegt). Slug-/ID-Validierung wie der bestehende Board-Router (`resolveProjectSlug`/`validateProjectPath`, ID-Regex).

### V7 — „Bereiche verwalten"-Dialog (Frontend)
In der Board-Kopfleiste (neben Filter/„Alle einklappen"/Archiv-Aktion) erscheint eine Aktion **„Bereiche verwalten"**. Ein Klick öffnet ein **modales Dialog-Overlay** mit der nach `order` sortierten Bereichsliste. Der Dialog erlaubt:
- **Anlegen** (Name-Feld + „Hinzufügen" → `POST …/areas`),
- **Umbenennen** (Inline-Edit je Zeile → `PATCH …/areas/:id`),
- **Umsortieren** (Hoch/Runter-Buttons oder Drag → `POST …/areas/reorder`),
- **Löschen** (je Zeile; **deaktiviert** mit Hinweis, wenn Storys/Specs am Bereich hängen; sonst Bestätigungsabfrage → `DELETE …/areas/:id`).
Nach jeder erfolgreichen Mutation wird die Bereichsliste neu geladen (Rescan). Endpunkt-Fehler (`409`/`area-not-empty`/`5xx`) erscheinen **nicht-blockierend** inline, ohne die Ansicht zu zerstören. A11y: echte `button`-Elemente mit sprechenden `aria-label`, fokussiertes Dialog-Muster (`role="dialog"`, Fokusfalle/Esc, sichtbarer Fokusring), Bedeutung nicht allein über Farbe.

## Acceptance-Kriterien

- **AC1** — `BoardAggregator` liest je Projekt `board/areas.yaml` und liefert die Bereichsliste (`id`, `name`, `order`, optional `description`) sortiert nach `order` als Teil des Projekt-Index; fehlende/leere Datei → leere Liste (kein Crash); defekte Einzel-Einträge werden übersprungen, ohne den Index zu zerstören. *(V1)*
- **AC2** — Der Projekt-Index weist je Bereich die zugeordneten Storys (Roll-up/Anzahl über `feature.area`/`story.area`) aus; ein Bereich **ohne** angehängte Storys/Specs bleibt als dauerhafte Kachel sichtbar und ist als „leer" erkennbar. *(V2)*
- **AC3** — `AreaWriter.createArea` fügt `board/areas.yaml` einen neuen Bereich mit stabiler kebab-case-`id`, getrimmtem/validiertem `name` und `order` ans Ende hinzu (atomar, tmp+rename, 0600); leerer/zu langer Name → Validierungsfehler; case-insensitiver Duplikat-Name → Fehler ohne Anlage. *(V3)*
- **AC4** — `AreaWriter.renameArea` ändert nur den `name` (id bleibt stabil); `AreaWriter.reorderAreas` setzt `order` gemäß `orderedIds` und weist eine ID-Menge zurück, die nicht **genau** der vorhandenen entspricht; beide schreiben atomar. *(V4)*
- **AC5** — `AreaWriter.deleteArea` löscht einen Bereich **nur**, wenn **keine** Story/kein Feature (aktiv **oder** archiviert) mit `area === id` **und keine** Spec mit `area: <id>` existiert; andernfalls harter Abbruch `area-not-empty` (mit Anzahl gebundener Storys/Specs), keine Teil-Löschung; bei Erfolg atomarer Write, verbleibende `order` bleiben gültig. *(V5)*
- **AC6** — Die Bereichs-Endpunkte (`GET`/`POST`/`PATCH`/`POST …/reorder`/`DELETE`) verhalten sich gemäß V6: mutierende Aufrufe hinter `accessGuard`, Audit-First (genau ein Eintrag je akzeptiertem Aufruf), kurz gehaltenes `ProjectJobLock` (`409` belegt), Slug-/ID-Validierung wie der Board-Router (`404` bei unbekanntem Projekt/Bereich, `400` bei ungültiger Eingabe); einziger Schreibpfad bleibt `AreaWriter`, `BoardAggregator` bleibt read-only. *(V6)*
- **AC7** — Security/Robustheit: kein Board-/Areas-Schreibpfad außer `AreaWriter` (Pfad-/Slug-Sicherheit über die bestehende BOARD_ROOTS-Realpath-Schranke; kein Traversal aus `name`/`id`); atomare Einzeldatei-Writes; keine Secrets in Ausgabe/Log/Audit; ungültige Eingaben werden sauber abgewiesen (kein Crash). *(V3–V6)*
- **AC8** — Die Board-Aktion „Bereiche verwalten" öffnet ein modales Dialog-Overlay mit der nach `order` sortierten Bereichsliste und erlaubt Anlegen (Name → `POST`), Umbenennen (Inline → `PATCH`), Umsortieren (Hoch/Runter oder Drag → `reorder`) und Löschen (→ `DELETE` mit Bestätigung); nach jeder erfolgreichen Mutation wird die Liste neu geladen. *(V7)*
- **AC9** — Der Lösch-Button je Zeile ist **deaktiviert** (mit Hinweis), solange Storys/Specs am Bereich hängen; er ist nur bei einem leeren Bereich aktiv und öffnet dann eine Bestätigungsabfrage; `area-not-empty`/`409`/`5xx` erscheinen nicht-blockierend inline, ohne die Ansicht zu zerstören. *(V7, V5)*
- **AC10** — A11y (WCAG 2.1 AA): der Dialog ist ein fokussiertes Dialog-Muster (`role="dialog"`, Fokusfalle/Esc-Abbruch, Fokus-Rückgabe an den Auslöser, sichtbarer Fokusring); alle Aktionen sind echte `button`-Elemente mit sprechenden `aria-label`; Status/Fehler programmatisch zugeordnet, Bedeutung nicht allein über Farbe. *(V7)*

## Verträge

- **`GET /api/board/projects/:slug/areas`** → `200 { areas: Array<{ id, name, order, description?, storyCount?, specCount? }> }` (sortiert nach `order`). `404` bei unbekanntem/ungültigem Slug.
- **`POST /api/board/projects/:slug/areas`** `{ name: string, description?: string }` → `201 { id }` | `400 { field, message }` (leer/zu lang/Duplikat) | `409` (Lock) | `404`.
- **`PATCH /api/board/projects/:slug/areas/:id`** `{ name: string }` → `200 { id }` | `400` | `404` (Bereich unbekannt) | `409`.
- **`POST /api/board/projects/:slug/areas/reorder`** `{ orderedIds: string[] }` → `200 { areas }` | `400 { field, message }` (ID-Menge ≠ vorhandene) | `409` | `404`.
- **`DELETE /api/board/projects/:slug/areas/:id`** → `200 { deleted: id }` | `409 { error: 'area-not-empty', storyCount, specCount }` (noch belegt) | `409` (Lock) | `404`.
- **`areas.yaml`-Schema (konsumiert, vom agent-flow-Schema definiert):** Liste von `{ id: kebab-case-String, name: String, order: Int, description?: String }`. Fehlt die Datei → leere Liste.
- **`AreaWriter`-Boundary** (`src/AreaWriter.js`, analog `BoardWriter`): `createArea`/`renameArea`/`reorderAreas`/`deleteArea`; atomarer Write (tmp+rename, 0600) ausschließlich nach `board/areas.yaml`; nutzt die vorhandene BOARD_ROOTS-Realpath-Schranke.

## Edge-Cases & Fehlerverhalten
- **`areas.yaml` fehlt/leer/defekt** → leere Bereichsliste, kein Crash; die Board-Übersicht funktioniert weiter (degradiert ohne Bereichs-Gruppierung).
- **Löschen eines Bereichs mit gebundenen Storys/Specs** → `409 area-not-empty` (mit Zählern), keine Löschung; Button ist ohnehin deaktiviert (Doppelschutz Frontend + Backend).
- **Umbenennen auf Duplikat-Name** → `400`, keine Änderung.
- **`reorder` mit fehlender/fremder ID** → `400`, keine Änderung (kein Teilzustand).
- **Paralleler Taktgeber/Drain hält `ProjectJobLock`** → `409`, keine Teil-Mutation; Client zeigt nicht-blockierenden Hinweis.
- **Ungültiger Slug / Projekt außerhalb BOARD_ROOTS** → `404`, nie als Pfad interpretiert.

## NFRs
- **Datenintegrität:** atomare Einzeldatei-Writes für `areas.yaml`; `BoardAggregator` bleibt read-only.
- **Security (Floor):** Pfad-/Slug-Sicherheit über die bestehende BOARD_ROOTS-Realpath-Schranke; Audit-First; kein Secret-Leak; kein Traversal aus Nutzereingabe.
- **A11y/Design:** konsistent mit [[studis-kanban-board-ux]]/[[board-feature-collapse]] (Kopfleisten-Aktionen, Fokusringe, Text-Badges).

## Nicht-Ziele
- **Neu-Definition** des `areas.yaml`-Schemas oder des `area`-Felds (das definieren die agent-flow-Schema-Specs; hier nur Konsum/Fläche).
- **Migration** der Bestands-Features/Storys/Specs auf Bereiche (eigene Spec [[bereichs-migration-dev-gui]]).
- **Archiv-Umbau** auf Story-Ebene (eigene Spec [[board-storys-archivieren]]).
- **Umsortieren/Verschieben von Storys zwischen Bereichen im Verwalten-Dialog** (Story↔Bereich-Zuordnung passiert im Story-/Idee-Dialog, [[story-idee-bereich-zuordnung]]).

## Abhängigkeiten
- **dev-gui:** `src/BoardAggregator.js` (areas.yaml lesen + Read-Model), neuer `src/AreaWriter.js`, `src/boardRouter.js`/neuer Areas-Router, `server.js` (Wiring), `client/src/BoardView.jsx` (Aktion + „Bereiche verwalten"-Dialog).
- **Specs:** [[studis-kanban-board-ux]] (Board-Übersicht), [[board-feature-collapse]] (Kopfleiste), [[ideen-inbox]] (`BoardWriter`-Schreib-/Audit-Muster), [[board-storys-archivieren]] (Story-Archiv, Bereiche bleiben sichtbar), [[story-idee-bereich-zuordnung]] (Story↔Bereich im Dialog), [[spec-bereich-filter]] (`DocsReader` liest `area`-Frontmatter — für den Lösch-Guard), [[bereichs-migration-dev-gui]] (seedet die initiale 11er-Bereichsliste + `area`-Zuordnungen).
- **agent-flow (textueller Verweis, kein depends):** Schema-Specs zu `board/areas.yaml` / Bereichs-Features (Repo agent-flow) — definieren `areas.yaml`-Schema + `area`-Feld/Frontmatter.
