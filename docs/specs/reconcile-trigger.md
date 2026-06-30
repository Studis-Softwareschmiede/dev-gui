---
id: reconcile-trigger
title: Reconcile-Trigger — Button „Konzept/Spec nachziehen" im Spezifikation-Reiter
status: draft
version: 1
---

# Spec: Reconcile-Trigger  (`reconcile-trigger`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Ein **dünner** GUI-Auslöser im „Spezifikation"-Reiter eines Projekts startet den Fabrik-Befehl `/agent-flow:reconcile`, der die durable Doku (`docs/`) wieder mit Vorlage und Code in Deckung bringt. dev-gui ruft nur an (POST `/api/command`) — die gesamte Abgleich-Logik lebt in **agent-flow**. Das Muster ist identisch zu den bestehenden Buttons „Board abarbeiten" (`/agent-flow:flow`, [[autonome-board-abarbeitung]]) und „Änderung erfassen" (`/agent-flow:requirement`, [[fabric-intake-dialog]]).

## Verhalten
1. Im Reiter „Spezifikation" (`SpecView`, [[projekt-spezifikation-anzeige]]) erscheint ein Bereich mit Button **„Konzept/Spec nachziehen"** samt kurzem Hinweistext, der den ausgelösten Befehl `/agent-flow:reconcile` nennt.
2. **Bestätigungsdialog vor dem Start** (analog Flow-Button): da die Fabrik-Agenten die Doku **ändern** (Specs konvertieren, Konzept/Architektur nachziehen), öffnet ein Klick zuerst einen Bestätigungsdialog. Erst „Starten" löst aus; „Abbrechen" schließt ohne Wirkung.
3. **Auslösen.** Bestätigung POSTet `{ command: '/agent-flow:reconcile', projectPath }` an `/api/command` (projektgebundene Session, konsistent zu Flow/Intake). `projectPath` = das aktive Projekt (`projectSlug`/`activeRepo`).
4. **Concurrency-Sperre.** Läuft bereits ein Job (`GET /api/session` → `state:"busy"` **oder** Antwort `409`), ist der Button **deaktiviert** (disabled-Attribut **+** Text-Label, nie Farbe allein) und ein Lock-Hinweis sichtbar; ein Klick löst dann **keinen** POST aus.
5. **Erfolg (202).** Nach erfolgreichem Auslösen wechselt die Ansicht in den Terminal-/Arbeiten-Bereich (`onNavigate('factory')`), damit der Lauf live sichtbar ist — konsistent zum Flow-/Intake-Muster ([[fabric-intake-dialog]] AC8/AC4).
6. **Fehler.** `409`/`500`/Netzwerkfehler erzeugen eine sichtbare Fehler-/Status-Anzeige mit Reset-Möglichkeit; **kein** `onNavigate`, kein Crash.

## Acceptance-Kriterien
- **AC1** — Im Spezifikation-Reiter ist ein Button **„Konzept/Spec nachziehen"** (o.ä.) vorhanden; Touch-Target ≥ 44 px (WCAG 2.1 AA); ein sichtbarer Hinweistext nennt den ausgelösten Befehl `/agent-flow:reconcile`.
- **AC2** — Klick auf den Button (bei freier Session) öffnet einen **Bestätigungsdialog** (`role="dialog"`) mit Warntext, dass die Fabrik-Agenten die **Doku ändern**. Es wird **noch nichts** an `/api/command` gesendet.
- **AC3** — Im Dialog „Starten" POSTet **genau einmal** `{ command: '/agent-flow:reconcile', projectPath: <aktives Projekt> }` an `/api/command`; „Abbrechen" schließt den Dialog **ohne** POST.
- **AC4** — Bei aktivem Job (`GET /api/session` → `state:"busy"`) ist der Button **deaktiviert** (disabled-Attribut **+** zugängliches Label/Lock-Hinweis, das den Zustand per Text — nicht nur Farbe — vermittelt); ein Klick auf den deaktivierten Button öffnet **keinen** Dialog und löst **keinen** POST aus.
- **AC5** — Antwort `202` → `onNavigate('factory')` wird aufgerufen (Lauf live im Terminal); es bleibt **kein** stehengebliebenes „gestartet"-Element im Spezifikation-Reiter.
- **AC6** — Antwort `409` → sichtbare Fehler-/Status-Anzeige (Job läuft bereits); `onNavigate` wird **nicht** aufgerufen; kein Crash.
- **AC7** — Netzwerkfehler oder `500`/unerwarteter Status → sichtbare Fehler-Anzeige mit Reset-Möglichkeit; `onNavigate` wird **nicht** aufgerufen.

## Verträge
- `POST /api/command` `{command:"/agent-flow:reconcile", projectPath?:string}` → `202 {commandId, status}` | `400` (Allowlist/Sanitisierung) | `409` (Lock) | `500`. **Vertrag mit [[flow-trigger]]:** der Endpunkt, die Allowlist und die Sanitisierung sind **unverändert**; dieses Feature fügt nur einen weiteren Auslöser hinzu, der einen bereits-allowlisteten Befehl sendet.
- `GET /api/session` → `{state:"ready"|"busy", …}` — Quelle des Busy-/Lock-Zustands (Polling-Muster wie `TriggerPanel`/`FactoryWorkspace`).
- **Cross-Repo (SR3):** Der Befehl `/agent-flow:reconcile` **selbst** (Allowlist-Eintrag im dev-gui-Backend + die gesamte Abgleich-Logik) lebt in **agent-flow** (`docs/architecture/reconcile-subsystem.md`). dev-gui injiziert nur die fertige Befehlszeile; die Modell-/Logik-Auflösung liegt drüben. Die UI ist davon **entkoppelt** baubar und testbar (mockbarer `fetchFn`); kein dev-gui-Test hängt von einer realen agent-flow-Antwort ab.

## Edge-Cases & Fehlerverhalten
- Klick bei bereits busy-er Session → no-op (kein Dialog, kein POST), AC4.
- `409` trotz freiem UI-Zustand (Race) → Fehleranzeige, kein Navigate, AC6.
- Fehlt `projectSlug`/`activeRepo` → `projectPath` wird weggelassen; der Befehl läuft gegen die globale Session (Backwards-Compat zum bestehenden `/api/command`-Vertrag).
- Doppelklick auf „Starten" während `starting` → kein zweiter POST (Button im `starting`-Zustand gesperrt).

## NFRs
- **A11y (WCAG 2.1 AA):** Dialog mit `role="dialog"` + zugänglichem Namen; Button-Sperre via disabled-Attribut **und** Text-Label (nie Farbe allein); sichtbarer Fokusring (kein `outline:none`); Touch-Targets ≥ 44 px.
- **Sicherheit (Floor):** Kein neuer Backend-Endpunkt, keine neue Trust-Boundary — der Befehl ist bereits Server-seitig allowlistet/sanitisiert ([[flow-trigger]] AC2). Bestätigungsdialog verhindert versehentliches Auslösen eines doku-ändernden Laufs. Kein `dangerouslySetInnerHTML`, keine Secrets im Bundle.

## Nicht-Ziele
- Die Reconcile-**Logik** (Stufe 1 Form / Stufe 2 Inhalt, Diff-Freigabe, Logbuch `docs/spec-audit.md`) — liegt vollständig in agent-flow (`reconcile-subsystem.md`).
- Eintrag des Befehls in die Backend-Allowlist von dev-gui — eigenes Paket/Repo-Zuständigkeit (Vertrag mit [[flow-trigger]]); diese Spec deckt nur den Frontend-Auslöser.
- Fortschritts-/Ergebnisanzeige des Reconcile-Laufs über das Terminal hinaus.

## Abhängigkeiten
- [[projekt-spezifikation-anzeige]] (Reiter „Spezifikation"/`SpecView`, in den der Button gehängt wird).
- [[flow-trigger]] (POST `/api/command`, Allowlist, Sanitisierung, Session-Lock — unverändert genutzt).
- [[autonome-board-abarbeitung]] / [[fabric-intake-dialog]] (Button-/Bestätigungs-/Busy-Guard-Muster, das hier gespiegelt wird).
- **agent-flow** `docs/architecture/reconcile-subsystem.md` (Cross-Repo-Vertrag, SR3) — liefert den Befehl `/agent-flow:reconcile`.
