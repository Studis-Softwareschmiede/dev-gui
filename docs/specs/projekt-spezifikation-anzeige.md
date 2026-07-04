---
id: projekt-spezifikation-anzeige
title: Projekt-Spezifikation — Repo-Doku (README/Konzept/Architektur/Specs) im Studis-Kanban-Board
status: active
area: spezifikation
version: 1
---

# Spec: Projekt-Spezifikation anzeigen  (`projekt-spezifikation-anzeige`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge. status: draft — erst nach Owner-Review auf active.
>
> **Zweck.** Die durable Doku eines Repos — README, Konzept (Schicht 1), Architektur/Data-Model/Design (Schicht 2), Specs (Schicht 3) — **lesbar im dev-gui** machen, eng verzahnt mit dem Studis-Kanban-Board (Stories ↔ Specs).

## Lösungsvorschlag / Designentscheidungen (zur Owner-Bestätigung)

- **WO — keine neue Kachel.** Die Doku lebt **im geöffneten Projekt des Studis-Kanban-Boards** als zweiter Reiter „Spezifikation" neben „Board". Begründung: Specs sind ohnehin **pro Projekt** und **mit Stories verknüpft** (jede Story zeigt auf `docs/specs/<x>.md`). Das Board lädt eh pro Projekt (Lazy-Load, [[studis-kanban-board-ux]]) — die Doku gehört genau dorthin. Kein neuer Einstiegspunkt.
- **WIE — zweispaltig.** Links eine **Navigation** (gruppiert nach Schicht: Konzept · Architektur · Specs · README/Sonstige), rechts der **gerenderte Markdown-Inhalt** (vorhandener `markdownLite.jsx`).
- **NAVIGATION — bidirektional.** (a) Vom Board: Klick auf den Spec-Bezug einer Story öffnet die Spec im Reiter. (b) Optional Rückverweis: Spec → welche Stories implementieren sie.
- **FILTER.** Nach **Doku-Typ** (Konzept/Architektur/Spec/README) und **Spec-Status** (draft/active/superseded — aus dem Frontmatter). Bei 56 Specs (dev-gui) nötig.
- **QUELLE/PERSISTENZ.** Die `.md`-Dateien im Repo, **read-only** gelesen. Neuer `DocsReader` (analog RetroReader/AgentFlowReader). **Lazy pro Projekt** (konsistent mit dem Board-Lazy-Load) — nicht alle Repos vorab.
- **FLOW.** Reine Anzeige. Geschrieben wird die Doku von requirement/architekt/designer via PR (unverändert).

## Verhalten

### V1 — DocsReader (Backend)
Liest je Projekt: `README.md`, `docs/*.md`, `docs/specs/*.md` und (falls Ordner) `docs/architecture/*.md`. Parst bei Specs das Frontmatter (`id`, `title`, `status`, `version`). Liefert eine **Struktur** (Liste mit Pfad, Titel, Typ/Schicht, status) — ohne die vollen Inhalte. Fehlende Doku → leere Struktur, kein Crash.

### V2 — API (Backend, lazy + read-only)
- `GET /api/board/projects/:slug/docs` → die Doku-Struktur (Navigation/Metadaten) eines Projekts.
- `GET /api/board/projects/:slug/docs/raw?path=<relpfad>` → Roh-Markdown EINER Datei. **Pfad-Sicherheit:** nur Dateien unterhalb von `README.md`/`docs/` des Projekts; kein `..`-Traversal. Hinter `accessGuard`.

### V3 — Reiter „Spezifikation" (Frontend)
Im geöffneten Projekt ein Reiter neben „Board". Links Navigationsbaum (Schicht-Gruppen), rechts gerendertes Markdown (`markdownLite.jsx`). Ladezustand (aria-busy) beim Nachladen einer Datei.

### V4 — Story ↔ Spec-Verknüpfung (Frontend)
Im Board-Reiter: der Spec-Bezug einer Story (z.B. „Spec: docs/specs/x.md") ist klickbar und öffnet die Datei im Spezifikation-Reiter. (Optional: Spec-Detail zeigt rückverweisend die implementierenden Stories.)

### V5 — Filter (Frontend)
Im Spezifikation-Reiter Filter nach Doku-Typ (Konzept/Architektur/Spec/README) + Spec-Status (draft/active/superseded). Mehrfachauswahl konsistent zum Board-Filter-Muster.

## Acceptance-Kriterien

- **AC1** — `DocsReader` liefert je Projekt eine Doku-Struktur (Pfad, Titel, Typ/Schicht, Spec-status aus Frontmatter) für README + docs/*.md + docs/specs/*.md (+ docs/architecture/* falls Ordner); fehlende Doku → leer, kein Crash. *(V1)*
- **AC2** — `GET …/:slug/docs` liefert die Struktur; `GET …/:slug/docs/raw?path=` liefert Roh-Markdown einer Datei; beides read-only, lazy, hinter accessGuard. *(V2)*
- **AC3** — Pfad-Sicherheit: nur Dateien unter README/docs des Projekts; `..`/absolute Pfade abgewiesen. *(V2)*
- **AC4** — Reiter „Spezifikation" im geöffneten Projekt: Navigation (Schicht-Gruppen) links, gerendertes Markdown rechts, Ladezustand. *(V3)*
- **AC5** — Story-Spec-Bezug ist klickbar und öffnet die Spec im Spezifikation-Reiter. *(V4)*
- **AC6** — Filter nach Doku-Typ + Spec-Status (Mehrfachauswahl). *(V5)*

## Nicht-Ziele
- Editieren der Doku aus der GUI (read-only; Pflege via PR).
- Volltextsuche (kann Folge-Feature sein).

## Abhängigkeiten
- Baut auf [[studis-kanban-board-ux]] (Lazy-Load pro Projekt, Projekt-Öffnen) + [[dev-gui-board-aggregator]] auf.
- `client/src/markdownLite.jsx` (Renderer, vorhanden), neuer `src/DocsReader.js`, `src/boardRouter.js`/neuer Router, `client/src/BoardView.jsx` (Reiter).
