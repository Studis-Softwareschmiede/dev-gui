---
id: fabrik-arbeiten-layout
title: Fabrik „Arbeiten"-Tab — eingebettetes Claude-Terminal entfernen + Button-Spalte neu anordnen
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Fabrik „Arbeiten"-Tab-Layout (`fabrik-arbeiten-layout`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).
> Reiner **Frontend-/Layout-Change** — kein Backend, keine Boundary-Änderung.

## Zweck
Seit der Board-Drain **headless** läuft (ADR-017, [[headless-manual-drain]]) wird im „Arbeiten"-Reiter des Fabrik-/Projekt-Cockpits ([[projekt-cockpit-navigation]], `CockpitView.jsx`) **kein dominantes eingebettetes Claude-Terminal-Pane** mehr benötigt — der Board-Lauf erzeugt dort keine Live-Ausgabe mehr. Diese Spec **entfernt das dominante Terminal-Pane aus dem „Arbeiten"-Layout** und lässt die verbleibende **Aktions-/Button-Spalte** (Board abarbeiten + Cost-Mode, Idee, Neue Story, verschlankter Trigger) gemäß einem **Designer-Vorschlag** (`docs/design.md`) neu und aufgeräumt anordnen.

> **Doktrin bleibt gewahrt (keine ADR nötig):** Der interaktive PTY-Pfad (`PtyManager`/`CommandService`, [[terminal-bridge]]) bleibt vollständig bestehen — u.a. für die verschlankten interaktiven Befehle **adopt/preview/train/new-project + Kill-Switch** ([[headless-manual-drain]] AC8). Diese Spec entfernt nur das **dominante eingebettete Terminal aus dem „Arbeiten"-Layout**, nicht den interaktiven Pfad selbst; die Live-Ausgabe dieser Befehle muss erhalten bleiben (AC2). Dadurch entsteht **keine** Doktrin-Änderung an `.claude/CLAUDE.md`/`docs/architecture.md` (die Aussage „Rein interaktiv bleiben das Terminal + die verschlankte Befehls-Auslösung" gilt weiter).

> **Abgrenzung zu [[vps-ssh-terminal]]:** Das interaktive Arbeiten „auf einem Server" wandert als **SSH-Terminal** in die VPS-Ansicht ([[vps-ssh-terminal]]) — eine **eigene** Capability. Diese Spec hier betrifft **nur** das Aufräumen des Fabrik-„Arbeiten"-Reiters.

## Verhalten
1. Im „Arbeiten"-Reiter (`CockpitView.jsx`, gespeist aus `FactoryView.jsx`) wird das **dominante eingebettete Claude-Terminal-Pane** aus dem Standard-Layout entfernt; der Reiter zeigt die **Aktions-/Button-Spalte** als primären Inhalt.
2. Eine Checkbox **„Terminal einblenden"** (Default: **aus**) steuert eine Terminal-Fläche am **unteren Rand** des „Arbeiten"-Reiters, die die **Live-Ausgabe der verbleibenden interaktiven PTY-Befehle** (adopt/preview/train/new-project + Kill-Switch, [[headless-manual-drain]] AC8) zeigt. Ist die Checkbox aus, bleibt die Fläche ausgeblendet; ein bereits laufender interaktiver Befehl läuft im Backend **unverändert weiter** (kein Kill durch Ausblenden), nur seine Ausgabe ist bis zum Einblenden nicht sichtbar. Der interaktive PTY-Pfad bleibt funktional unverändert.
3. Die Button-Spalte (**Board abarbeiten** samt zugehörigem **Cost-Mode**-Dropdown, **Idee**, **Neue Story**, **verschlankter Trigger** adopt/preview/train/new-project + **Kill-Switch**) wird gemäß einem in `docs/design.md` festgehaltenen **Designer-Vorschlag** neu/aufgeräumt angeordnet. **Funktion und Verhalten jedes Buttons bleiben unverändert** — nur Anordnung/Optik ändern sich.
4. Layout und Zustände folgen dem Design-System (Dark-first, 8-pt-Spacing, Statusfarben mit Label/Icon) und sind responsiv (Desktop-zuerst; unter ~768 px stapelnd).

## Acceptance-Kriterien
- **AC1** — Im „Arbeiten"-Reiter (`CockpitView`/`FactoryView`) ist das **dominante eingebettete Claude-Terminal-Pane** aus dem Standard-Layout **entfernt**; der Reiter zeigt die neu angeordnete Aktions-/Button-Spalte als primären Inhalt. (Testbar: „Arbeiten"-Render enthält im Standardzustand **kein** dominantes Terminal-Pane mehr; die Buttons sind sichtbar.)
- **AC2** — Eine Checkbox **„Terminal einblenden"** (Default: **aus**) blendet am **unteren Rand** des „Arbeiten"-Reiters eine Terminal-Fläche mit der Live-Ausgabe der verbleibenden interaktiven PTY-Befehle (adopt/preview/train/new-project + Kill) ein/aus. Bei ausgeblendeter Fläche laufen aktive Befehle **unverändert im Backend weiter** (kein Kill durch Ausblenden); der interaktive PTY-Pfad (`PtyManager`/`CommandService`) ist funktional unverändert. (Testbar: Checkbox aus → keine Terminal-Fläche gerendert; Checkbox an → Fläche erscheint unten mit Live-Ausgabe; Umschalten der Checkbox beendet keine laufende Session.)
- **AC3** — Die Button-Spalte (Board abarbeiten + Cost-Mode, Idee, Neue Story, verschlankter Trigger, Kill) ist gemäß einem in `docs/design.md` dokumentierten **Designer-Vorschlag** neu angeordnet; **Funktion/Verhalten jedes Buttons bleiben unverändert** (Board-Drain-Trigger inkl. Cost-Mode-Body, Idee-Modal, Neue-Story-Chat, Trigger-Befehle, Kill). (Testbar: `docs/design.md` beschreibt das neue Arbeiten-Layout; alle bestehenden Button-Handler/Endpunkte werden weiterhin unverändert aufgerufen.)
- **AC4** — A11y/Responsive gemäß Design-System: Kontrast ≥ 4.5:1 (Text) / ≥ 3:1 (Status/große Elemente), sichtbarer Fokus, volle Tastatur-Navigation, Touch-Targets ≥ 44 px, Statusfarben nie als einzige Bedeutung (Label/Icon); Desktop-zuerst, unter ~768 px stapelnd. (Testbar: A11y-Checkliste/axe-Regeln auf den „Arbeiten"-Reiter grün; Buttons beschriftet.)
- **AC5** — Reiner Frontend-/Layout-Change: **keine** Backend-Endpunkte/Boundaries geändert, `PtyManager`/`CommandService` unberührt, **keine** Secrets im Bundle, kein `dangerouslySetInnerHTML`. (Testbar: Diff berührt nur Client-/`docs/`-Dateien; keine Server-Boundary-Änderung.)

## Verträge
- Konsumiert das bestehende Cockpit-Gerüst ([[projekt-cockpit-navigation]] `CockpitView.jsx`, `FactoryView.jsx`) + `TriggerPanel.jsx` (verschlankt, [[headless-manual-drain]] AC8) + `Terminal.jsx` (für die per Checkbox einblendbare Ausgabefläche am unteren Rand).
- **Keine** neuen/ geänderten Backend-Endpunkte. Die Button-Handler rufen unverändert ihre bestehenden Endpunkte (`POST …/drain` mit `costMode`, Idee-Capture, Neue-Story-Chat, `POST /api/command` für die Trigger-Befehle, Kill).
- Designer-Ergebnis wird in `docs/design.md` (Abschnitt „Arbeiten"-Layout) festgehalten (Anordnung/Hierarchie/Zustände der Button-Spalte).

## Edge-Cases & Fehlerverhalten
- Aktiver Job (Drain läuft / Command aktiv) → Button-Deaktivierung + Kill sichtbar bleiben unverändert erhalten (bestehendes Verhalten, [[headless-manual-drain]] AC6).
- Schmaler Viewport (< 768 px) → Button-Spalte stapelt lesbar/bedienbar (kein Overflow-Bruch).
- Interaktiver Befehl ausgelöst, Checkbox „Terminal einblenden" aus → Befehl läuft im Backend unverändert weiter, Ausgabe wird erst nach Aktivieren der Checkbox sichtbar (kein Verlust, nur verzögerte Sichtbarkeit); Umschalten der Checkbox beendet keine laufende Session.

## NFRs
- **A11y (WCAG 2.1 AA):** wie AC4.
- **Sicherheit (Floor):** keine Secrets im Frontend-Bundle/Log; kein neuer Endpunkt; interaktiver PTY-Pfad unverändert (kein neuer Schreibpfad).
- **Konsistenz:** Design-System-Tokens (Dark-first, 8-pt, Statusfarben mit Label/Icon) eingehalten.

## Nicht-Ziele
- **Änderung der Button-Funktionen** (Drain/Idee/Neue Story/Trigger/Kill bleiben verhaltensgleich — nur Anordnung/Optik).
- **Umbau des interaktiven PTY-/`CommandService`-Pfads** (bleibt bestehen, [[headless-manual-drain]] Nicht-Ziel).
- **SSH-Terminal / VPS-Arbeiten** → eigene Capability [[vps-ssh-terminal]].
- **Doktrin-/ADR-Änderung** — nicht nötig (der interaktive Pfad bleibt; s. Zweck).

## Abhängigkeiten
- [[headless-manual-drain]] (Trigger-Verschlankung AC8 + Cost-Mode am Board-Knopf AC5 — Grund, warum das dominante Terminal entfallen kann; die Button-Spalte, die neu angeordnet wird).
- [[projekt-cockpit-navigation]] (`CockpitView`/`FactoryView`-Reiter-Gerüst „Arbeiten").
- [[terminal-frontend]] / [[terminal-bridge]] (interaktiver PTY-Pfad bleibt für die verbleibenden Befehle; on-demand/freie Ausgabefläche).
- [[ideen-inbox]] (Idee-Button) · [[new-story-chat]] (Neue-Story-Button) — unverändert eingebunden.
- `docs/design.md` (Designer-Vorschlag für das neue „Arbeiten"-Layout).
