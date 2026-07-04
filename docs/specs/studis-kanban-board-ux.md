---
id: studis-kanban-board-ux
title: Studis-Kanban-Board — UX-Verbesserungen (Default-Filter, Filter-Dropdown, Lazy-Load, Umbenennung)
status: active
area: board
version: 2
---

# Spec: Studis-Kanban-Board — UX-Verbesserungen  (`studis-kanban-board-ux`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge. Source of Truth für coder/tester/reviewer.
>
> **Zweck.** Bündelt mehrere Verbesserungen an der Board-Ansicht des dev-gui (bisher „Board"/„Aufgaben-Board") und benennt sie konsistent **„Studis-Kanban-Board"**. status: draft — erst nach Owner-Review auf active.

## Kontext / Designentscheidungen (Vorschläge zur Owner-Bestätigung)

- **Umbenennung „Studis-Kanban-Board"** durchgängig (View-Titel, Fabrik-Link, viewRegistry-Label, aria-Labels).
- **Status-Filter — Default „alle ausgewählt".** Beim Öffnen sind alle 5 Story-Status angehakt (= alles sichtbar); der Nutzer **entfernt** nur, was er ausblenden will. Mentales Modell: Haken = sichtbar. *(Owner-Wunsch)*
- **Edge-Verhalten „keine angehakt" (Vorschlag):** Sind alle Haken entfernt, zeigt das Board nichts + einen Hinweis „Kein Status gewählt — bitte mindestens einen wählen". (Klares Modell statt „leer = alles", weil das nach dem Default-alle-Modell widersprüchlich wäre.)
- **Filter als aufklappbares Dropdown (Vorschlag: Klick statt Hover).** Die Status-Kästchen sind nicht mehr permanent sichtbar, sondern hinter einem Button „Status ▾", der ein Popover öffnet. **Empfehlung: per Klick öffnen, nicht per Hover** — Hover-Menüs sind auf Touch-Geräten unbedienbar und für Screenreader/Tastatur problematisch. Schließt bei Außenklick/Esc. *(Owner wünschte Hover; ich empfehle Klick — bitte bestätigen.)*
- **Lazy-Load — erst Projektliste, dann Projekt on-demand.** Das Board öffnet mit einer **leichten Projektliste** (Repos + grobe Zähler, OHNE Stories zu scannen). Klick auf ein Projekt lädt **nur dieses** Projekt voll und zeigt es. **Bewertung: guter, skalierender Vorschlag — kein Over-Engineering.** Bei vielen/großen Repos vermeidet das spürbare Latenz beim Öffnen. *(Owner-Wunsch, von mir bestätigt.)*

## Verhalten

### V1 — Umbenennung
Alle nutzersichtbaren Stellen, die das Board benennen, lauten „Studis-Kanban-Board" (View-Überschrift, Fabrik-Kachel-Link, viewRegistry-`tile`/Label falls vorhanden, aria-label des Haupt-Containers). Die Route-id (`board`) bleibt technisch unverändert.

### V2 — Status-Filter Default „alle ausgewählt"
Beim Mount sind alle fünf Story-Status (To Do, In Progress, Blocked, In Review, Done) ausgewählt; alle Stories sichtbar. Deselektieren eines Status blendet dessen Spalte/Karten aus.

### V3 — Leer-Auswahl-Hinweis
Sind alle Status deselektiert, wird kein Story angezeigt, stattdessen ein `role="status"`-Hinweis „Kein Status gewählt". Ein „Alle"-Schnellschalter (an/aus) ist optional.

### V4 — Status-Filter als Dropdown/Popover
Der Status-Filter wird als Button „Status (n/5) ▾" dargestellt, der ein Popover mit den Checkboxen öffnet (Klick-Toggle). Popover schließt bei Außenklick und Esc; Button trägt `aria-expanded`/`aria-controls`. (Projekt-/Label-Filter analog optional.)

### V5 — Lazy-Load Backend
Zwei Pfade statt eines Voll-Scans:
- **Projektliste:** liefert je Repo nur `slug` + grobe Zähler (z.B. #Features, #Stories) — **ohne** alle Story-YAMLs zu parsen (nur board.yaml / Verzeichniszählung).
- **Einzelprojekt:** lädt + parst **ein** Projekt on-demand (voller Scan dieses Repos).
Endpunkte: `GET /api/board/projects/list` (leicht) + `GET /api/board/projects/:slug` (voll). Der bestehende `GET /api/board/projects` bleibt erhalten oder wird intern auf die Einzel-Variante abgebildet.

### V6 — Lazy-Load Frontend
Das Studis-Kanban-Board öffnet mit der Projektliste (Auswahl). Erst ein Klick auf ein Projekt lädt dessen Daten (`/projects/:slug`) und zeigt **nur dieses** Projekt (Feature→Story-Kanban). Wechsel zurück zur Liste möglich. Ladezustand (aria-busy) während des Nachladens.

### V7 — Status-Filter „Alle/Keine"-Umschalter (fortgeschrieben v2)
Im Status-Filter-Popover (V4, Checkbox-Liste Idee / To Do / In Progress / Blocked / In Review / Done) steht **ganz oben** — vor den einzelnen Status-Checkboxen — ein **Toggle-Button „Alle/Keine"**, der mit einem Klick den Gesamtzustand umschaltet:
- Sind **aktuell alle** Status ausgewählt → Klick **wählt alle ab** (leere Auswahl; greift dann V3-Leer-Hinweis).
- Sind **nicht alle** ausgewählt (keiner oder ein Teil) → Klick **wählt alle aus** (Default-Zustand, alles sichtbar).

Das Verhalten ist also „falls alle an → alle aus, sonst alle an". Der Button ist visuell **leicht nach links versetzt** gegenüber den darunterliegenden Checkbox-Einträgen, um ihn optisch als **übergeordnete Aktion** abzusetzen. Er trägt einen sprechenden Zustand (z.B. Label/`aria-pressed` bzw. ein `aria-label`, das die auszuführende Aktion nennt) und ist per Tastatur bedienbar (Teil der Popover-Tab-Ordnung, sichtbarer Fokusring). Reine Frontend-Änderung im bestehenden `FilterBar`-Popover; kein neuer API-Aufruf, keine Board-Daten-Änderung.

## Acceptance-Kriterien

- **AC1** — Alle nutzersichtbaren Board-Bezeichnungen lauten „Studis-Kanban-Board" (View-Titel, Fabrik-Link, Label/aria); Route-id `board` unverändert. *(V1)*
- **AC2** — Status-Filter ist beim Öffnen mit allen 5 Status vorausgewählt; alles sichtbar; Deselektion blendet aus. *(V2)*
- **AC3** — Alle Status deselektiert → keine Stories + `role="status"`-Hinweis „Kein Status gewählt". *(V3)*
- **AC4** — Status-Filter ist ein per Klick auf-/zuklappbares Popover (Button „Status (n/5) ▾"), nicht permanent sichtbar; schließt bei Außenklick + Esc; aria-expanded/-controls korrekt. *(V4)*
- **AC5** — `GET /api/board/projects/list` liefert je Repo nur slug + grobe Zähler ohne Story-Scan; `GET /api/board/projects/:slug` liefert ein Projekt voll on-demand. *(V5)*
- **AC6** — Das Board öffnet mit der Projektliste; Klick auf ein Projekt lädt + zeigt nur dieses (mit Ladezustand); Rückweg zur Liste vorhanden. *(V6)*
- **AC7** — Im Status-Filter-Popover steht oberhalb der einzelnen Status-Checkboxen ein „Alle/Keine"-Toggle-Button, der bei „alle ausgewählt" → alle abwählt und sonst (keiner/teilweise) → alle auswählt; er ist optisch leicht nach links versetzt gegenüber den Checkboxen, trägt einen sprechenden Zustand (Label/`aria-pressed`/`aria-label`), ist tastaturbedienbar mit sichtbarem Fokusring; keine neue API, keine Board-Daten-Änderung. *(V7)*

## Nicht-Ziele
- Schreibpfad aus der GUI (Board bleibt read-only).
- Änderung des board/-Dateiformats.

## Offene Punkte (Owner-Entscheidung)
- V4: **Klick vs. Hover** zum Öffnen des Filter-Popovers (Empfehlung: Klick).
- V3: Verhalten bei „keine angehakt" (Empfehlung: Hinweis statt „= alle").

## Abhängigkeiten
- `src/BoardAggregator.js`, `src/boardRouter.js`, `client/src/BoardView.jsx`, `client/src/FactoryView.jsx`, `client/src/viewRegistry.js`.
- Baut auf [[dev-gui-board-aggregator]] (Scan/Index) auf.
