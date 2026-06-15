---
id: autonome-board-abarbeitung
title: Autonome Board-Abarbeitung — agent-ready Items, /flow aus dev-gui, Blocked statt Raten
status: active
version: 1
---

# Spec: Autonome Board-Abarbeitung  (`autonome-board-abarbeitung`)

> **Konzept-only** (status: draft). Umsetzung betrifft agent-flow (`/flow`, board-cli) + dev-gui (Start-Knopf + Blocked-Sicht).
>
> **Zweck.** Das Board so füllen + definieren, dass man **in einem neuen Terminal** sagen kann „arbeite ab" und ein **frischer Agent** (`/flow` via dev-gui) die Stories **selbstständig** umsetzt — ohne Vorwissen. Offene Fragen → Story auf **Blocked** (statt raten).

## Lösungsvorschlag

### 1. Definition-of-Ready (das Kernstück)
Eine Story ist **„ready"** für autonome Abarbeitung, wenn sie self-contained ist:
- `spec` zeigt auf eine existierende, `active` Datei; `implements` nennt AC-Nummern, die in der Spec existieren (board-lint prüft das schon).
- AC sind **testbar** formuliert (der tester kann sie prüfen).
- `depends` vollständig + auflösbar; Reihenfolge klar.
- Repo-/Scope-Kontext eindeutig (welches Repo, welche Dateien grob).
- Keine offene Owner-Frage im Body.
Neuer Check **`board ready`** (board-cli) listet nicht-ready To-Do-Items mit Grund → vor dem autonomen Lauf grün.

### 2. Autonomer /flow aus dem dev-gui-Cockpit
Im Cockpit-Reiter „Arbeiten" (F-005) ein Knopf/Befehl „Board abarbeiten" → startet `/agent-flow:flow` im Projekt-Terminal. `/flow` zieht `board next` (ready To-Do, depends erfüllt) und fährt coder→reviewer→tester→land je Story, bis das Board leer ist (nutzt das bereits gebaute flow-board-backend).

### 3. Blocked statt Raten (existiert im /flow-Vertrag)
Trifft `/flow` auf eine Spec-Lücke / offene Frage / Schleife (N=3), setzt es die Story auf **Blocked** + `blocked_reason` statt zu raten. Im dev-gui ist die Blocked-Spalte mit Grund sichtbar (Owner klärt, setzt zurück auf To Do).

### 4. Weiteres
- estimator schätzt vorab (size/EP) — große/unsichere Items (XL) bekommen einen Split-Hinweis (besser abarbeitbar).
- F-006 (Abarbeitungs-Strategie) liefert Reihenfolge/Parallelität; diese Spec liefert die „Item-Reife".

## Acceptance-Kriterien
- **AC1** — `board ready` meldet je To-Do-Item, ob es ready ist (spec/AC/depends/Scope erfüllt), sonst Grund; Exit ≠ 0 bei nicht-ready Items (optional Gate vor autonomem Lauf). *(1)*
- **AC2** — Aus dem dev-gui-Cockpit „Arbeiten" lässt sich `/flow` für das aktive Projekt starten; es arbeitet ready To-Do-Stories autonom ab (board next-Loop). *(2)*
- **AC3** — Bei Unklarheit setzt `/flow` die Story auf Blocked + Grund (kein Raten); im dev-gui sichtbar. *(3)*
- **AC4** — Board zeigt Ready-/Blocked-Status (nicht-ready bzw. blockierte Items erkennbar + Grund). *(1,3)*

## Nicht-Ziele
- Vollautonomes Mergen ohne jegliche Gates (Review/Test-Gates bleiben).

## Abhängigkeiten
- agent-flow: `skills/flow`, [[board-cli]] (neuer `ready`-Check), [[estimator]]; baut auf [[board-abarbeitungs-strategie]] auf.
- dev-gui: Cockpit „Arbeiten"-Start (F-005) + Blocked/Ready-Anzeige im Board.
