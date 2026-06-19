---
id: board-feature-collapse
title: Board — Features ein-/ausklappen (Stories verstecken, Alle-Toggle, Zustand merken)
status: draft
version: 1
---

# Spec: Board — Features ein-/ausklappen  (`board-feature-collapse`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge. Source of Truth für coder/tester/reviewer.
>
> **Erweitert [[studis-kanban-board-ux]].** Reine Frontend-/Anzeige-Verbesserung der Board-Ansicht (`BoardView`). Kein Backend, kein neuer Endpunkt.

## Zweck

Im Board liegen alle Features **offen** mit ihren Story-Spalten untereinander. Bei vielen Features/Stories muss man weit scrollen, um an ein bestimmtes Feature zu kommen. Diese Spec macht **jedes Feature ein-/ausklappbar** (eingeklappt verschwinden die Stories, nur der Feature-Kopf bleibt) und ergänzt einen **„Alle ein-/ausklappen"-Schalter**. Der Auf-/Zu-Zustand wird **pro Projekt im Browser gemerkt**.

## Kontext / Befund (bindend)

- **Heutiger Stand** (`client/src/BoardView.jsx`, `FeatureRow`): Der Klick auf den Feature-Titel öffnet/schließt nur das **Detail-Panel** (Ziel/DoD). Die **Story-Status-Spalten sind immer sichtbar** — daher die lange Seite.
- **Owner-Entscheidungen 2026-06-19:**
  - **Default = „Gemischt":** erledigte Features eingeklappt, aktive ausgeklappt.
  - **Zustand merken:** pro Projekt im `localStorage`, über Neuladen + Projektwechsel hinweg.
- **Nur Anzeige.** Keine Board-Daten werden geändert; kein neuer API-Aufruf.

## Verhalten

### V1 — Feature ein-/ausklappen (Stories verstecken)
Jede Feature-Zeile bekommt einen **Auf-/Zu-Schalter** im Kopf (Chevron ▸/▾). 
- **Eingeklappt:** die Story-Status-Spalten (und das Detail-Panel) sind ausgeblendet; sichtbar bleibt nur der **Feature-Kopf** (Titel, Status-Badge, Fortschrittsbalken).
- **Ausgeklappt:** Story-Spalten wie heute sichtbar.
Der Schalter ist der primäre Kopf-Affordance (Klick auf Titel/Chevron = ein-/ausklappen).

### V2 — Detail-Panel (Ziel/DoD) entkoppeln
Das bisherige Ziel/DoD-Detail-Panel bleibt erhalten, bekommt aber einen **eigenen, separaten** kleinen Schalter im Kopf (z.B. „Details"/ⓘ), damit Titel-Klick = Einklappen und Detail unabhängig sind. Bei eingeklapptem Feature ist der Detail-Schalter ausgeblendet (nichts anzuzeigen).

### V3 — Default-Zustand „Gemischt" (ohne gespeicherten Stand)
Liegt für ein Feature **kein** gespeicherter Zustand vor, gilt:
- **eingeklappt**, wenn das Feature erledigt ist (Fortschritt `done == total` bei `total > 0`, oder `status` ∈ {Done, Archived}),
- **ausgeklappt** sonst.

### V4 — „Alle ein-/ausklappen" (global)
In der Board-Kopfleiste ein Schalter **„Alle einklappen" / „Alle ausklappen"**, der alle Features des aktuellen Projekts auf einmal zu-/aufklappt und den gespeicherten Zustand entsprechend setzt.

### V5 — Zustand merken (localStorage, pro Projekt)
Der Auf-/Zu-Zustand wird je Projekt-Slug im `localStorage` gespeichert (z.B. Key `boardview.collapsed.<slug>` → Liste der eingeklappten Feature-IDs). Beim Laden:
- gespeicherter Feature-Zustand vorhanden → diesen verwenden;
- sonst → Default „Gemischt" (V3).
Neue, noch nicht gespeicherte Features folgen dem Default. Fehlt/ist `localStorage` defekt → stiller Rückfall auf Default, kein Crash.

### V6 — Filter-Wechselwirkung
Ist ein **einschränkender Filter** aktiv (Status-/Label-Filter weicht vom Default ab) und ein **eingeklapptes** Feature hätte **passende** Stories, wird es zur Anzeige **temporär ausgeklappt dargestellt**, damit Treffer nicht „im Eingeklappten verschwinden". Diese temporäre Aufklappung **überschreibt den gespeicherten Zustand nicht** (nach Filter-Reset gilt wieder der gemerkte Zustand).

## Acceptance-Kriterien

- **AC1** — Jede Feature-Zeile hat einen Auf-/Zu-Schalter; eingeklappt sind die Story-Spalten ausgeblendet und nur der Kopf (Titel/Status/Fortschritt) sichtbar; ausgeklappt sind die Stories wie bisher sichtbar. *(V1)*
- **AC2** — Das Ziel/DoD-Detail-Panel ist über einen separaten Schalter erreichbar (entkoppelt vom Einklappen) und bei eingeklapptem Feature ausgeblendet. *(V2)*
- **AC3** — Ohne gespeicherten Zustand sind erledigte Features (done==total, total>0, oder Status Done/Archived) eingeklappt, übrige ausgeklappt. *(V3)*
- **AC4** — Ein „Alle ein-/ausklappen"-Schalter klappt alle Features des Projekts auf einmal zu/auf und setzt den gemerkten Zustand. *(V4)*
- **AC5** — Der Auf-/Zu-Zustand wird pro Projekt im localStorage gemerkt und beim erneuten Laden/Projektwechsel angewendet; defektes/fehlendes localStorage → stiller Default, kein Crash. *(V5)*
- **AC6** — Bei aktivem einschränkendem Filter werden eingeklappte Features mit passenden Stories temporär ausgeklappt dargestellt, ohne den gespeicherten Zustand zu überschreiben. *(V6)*
- **AC7** — A11y (WCAG 2.1 AA): Auf-/Zu-Schalter sind `button` mit `aria-expanded` + `aria-controls` auf die Story-Region; Tastatur (Enter/Space); sichtbarer Fokusring (kein `outline:none`); Chevron `aria-hidden`. *(V1, V2, V4)*
- **AC8** — Keine Backend-Änderung, kein neuer/zusätzlicher API-Aufruf; kein `dangerouslySetInnerHTML`; keine Secrets. *(alle)*

## Verträge

- **Keine API-Änderung.** Genutzt wird ausschließlich die bestehende Board-Liste (`/api/board/projects…`), die Feature+Stories bereits liefert.
- **localStorage:** Key `boardview.collapsed.<slug>` → JSON (z.B. `{ "collapsed": ["F-012","F-018"] }`). Reine UI-Persistenz; kein Secret, keine Story-Inhalte.
- **Rollup/Status** für die „Gemischt"-Entscheidung stammen aus den bereits vorhandenen Feldern (`computeRollup`, `feature.status`).

## Edge-Cases & Fehlerverhalten

- **Feature ohne Stories** → Einklappen wirkt wie heute (zeigt „Keine Stories"); collapse blendet den Hinweis mit aus.
- **localStorage gesperrt/voll/defekt** → Default „Gemischt", kein Crash (AC5).
- **Feature später hinzugekommen** (noch nicht gespeichert) → Default-Regel (V3).
- **Filter aktiv, Feature eingeklappt, keine Treffer** → bleibt eingeklappt (kein unnötiges Aufklappen).
- **„Alle ausklappen" bei aktivem Filter** → globaler Zustand gesetzt; Filter-Sicht unverändert.

## NFRs

- **Performance:** rein clientseitiges Ein-/Ausblenden; eingeklappte Features rendern ihre Story-Spalten nicht (kürzere DOM-Liste bei großen Boards).
- **A11y/Design:** konsistent mit [[studis-kanban-board-ux]] und dem bestehenden Chevron-Muster der Feature-Detail-Anzeige.

## Nicht-Ziele

- **Story-Ebene einzeln einklappen** (nur Feature-Ebene; Stories verschwinden gesammelt mit dem Feature).
- **Serverseitige/teamweite Persistenz** (bewusst nur lokal im Browser).
- **Änderung der Board-Daten oder der Status-Spalten-Logik.**

## Abhängigkeiten

- **dev-gui:** `client/src/BoardView.jsx` (`FeatureRow` + Board-Kopfleiste), localStorage-Helfer.
- **Specs:** [[studis-kanban-board-ux]] (Basis), [[story-detail-ansicht]] (Detail-Drilldown bleibt unberührt).
