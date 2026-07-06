---
id: cockpit-declutter
title: Cockpit entrümpeln — Trigger-Panel + Status-Dashboard aus dem „Arbeiten"-Reiter entfernen
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Cockpit entrümpeln (`cockpit-declutter`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).
> Reiner **Frontend-/Aufräum-Change** — kein neuer Backend-Endpunkt, keine Boundary-Änderung.

## Zweck
Das Projekt-Cockpit (`CockpitView` → `FactoryWorkspace`, Reiter „Arbeiten") wird verschlankt: das generische **Befehls-Trigger-Panel** (`TriggerPanel.jsx`) und die **Status-Dashboard-Kachel** (`Dashboard.jsx`) werden **restlos entfernt** (Komponente, Styles, Tests, tote Importe). Der Board-Drain läuft seit ADR-017 headless über den dedizierten „Board abarbeiten"-Knopf; das freistehende Trigger-Panel und die Projekt-Statusliste sind damit redundant bzw. woanders besser aufgehoben. Der einzige aus dem Trigger-Panel noch benötigte interaktive Weg — **Adopt** — wird durch [[neues-projekt-auswahl-dialog]] auf die Fabrik-Übersicht umgezogen; diese Spec deckt **nur die Entfernung** ab.

> **Supersedes-Bezug:** Diese Spec löst die Nennung von „**verschlanktem Trigger**" und „**Dashboard**" als Bestandteile der Aktions-/Button-Spalte in [[fabrik-arbeiten-layout]] AC2/AC3 ab (dort als Teil des `actionGrid` bzw. der Terminal-Live-Ausgabe „adopt/preview/train/new-project" gelistet). Der **„Terminal einblenden"-Mechanismus** (fabrik-arbeiten-layout AC2) und alle übrigen Aktions-Karten (Board abarbeiten + Cost-Mode, Idee, Neue Story) bleiben **unverändert**.

## Verhalten
1. Im „Arbeiten"-Reiter wird **kein** `TriggerPanel` mehr gerendert. Die Komponente `client/src/TriggerPanel.jsx`, ihre Styles und ihre Tests (`client/src/__tests__/TriggerPanel.test.jsx`) werden gelöscht; der Import + die Render-Stelle in `CockpitView.jsx` (`FactoryWorkspace`) entfallen.
2. Im „Arbeiten"-Reiter wird **keine** `Dashboard`-Kachel mehr gerendert. Die Komponente `client/src/Dashboard.jsx`, ihre Styles und ihre Tests (`client/src/__tests__/Dashboard.test.jsx`) werden gelöscht; der Import + die Render-Stelle in `CockpitView.jsx` entfallen.
3. **Keine toten Referenzen** bleiben zurück: nach der Entfernung existiert projektweit **kein** Import von `TriggerPanel`/`Dashboard` mehr (außer rein dokumentarische Modul-Kommentare, die mitentfernt/-aktualisiert werden), und der Client-Build/-Lint (`npm run lint`, `npm test`, `npm run build`) läuft grün.
4. **Backend-Endpunkt-Prüfung (Konsumenten-Gate).** Vor dem Entfernen eines Backend-Endpunkts wird per Suche über den **gesamten** Client- **und** Server-Code geprüft, ob noch ein anderer Konsument existiert. Ergebnis dieser Prüfung (verbindlich, siehe Verträge): **kein** Backend-Endpunkt wird in diesem Paket entfernt — alle von `TriggerPanel`/`Dashboard` genutzten Endpunkte haben weitere Konsumenten.
5. Die übrigen Inhalte des „Arbeiten"-Reiters (Board-abarbeiten-Knopf inkl. Cost-Mode + Drain-Status + Abschlussbericht, Idee-Quick-Capture, Neue-Story-Chat, „Terminal einblenden"-Checkbox + Terminal-Fläche) bleiben **funktional und visuell unverändert**.

## Acceptance-Kriterien
- **AC1** — `TriggerPanel` ist **restlos entfernt**: die Datei `client/src/TriggerPanel.jsx` samt ihrer Styles ist gelöscht, `client/src/__tests__/TriggerPanel.test.jsx` ist gelöscht, und `CockpitView.jsx` importiert/rendert `TriggerPanel` **nicht** mehr. (Testbar: `grep` nach `TriggerPanel` findet keinen Import/kein JSX-Tag mehr im Client-Code; der „Arbeiten"-Render enthält kein Trigger-Panel.)
- **AC2** — `Dashboard` ist **restlos entfernt**: die Datei `client/src/Dashboard.jsx` samt ihrer Styles ist gelöscht, `client/src/__tests__/Dashboard.test.jsx` ist gelöscht, und `CockpitView.jsx` importiert/rendert `Dashboard` **nicht** mehr. (Testbar: `grep` nach `Dashboard.jsx`/`<Dashboard` findet keinen Import/kein JSX-Tag mehr; der „Arbeiten"-Render enthält keine Status-Dashboard-Kachel.)
- **AC3** — Nach der Entfernung gibt es **keine toten Importe/Referenzen** und der Client baut/lintet/testet grün (`npm run lint`, `npm test`, `npm run build` fehlerfrei). Rein dokumentarische Verweise auf `TriggerPanel`/`Dashboard` in Modul-Kommentaren anderer Dateien werden mitentfernt oder als „entfernt (S-###)" aktualisiert, sodass kein Kommentar auf eine nicht mehr existierende Komponente als aktiven Bestandteil verweist. (Testbar: Build/Lint/Test grün; keine `import … from './TriggerPanel.jsx'`/`'./Dashboard.jsx'` mehr.)
- **AC4** — **Kein** Backend-Endpunkt wird entfernt. Die von den entfernten Komponenten genutzten Endpunkte (`GET /api/status`, `GET /api/session`, `POST /api/command`, `POST /api/command/cancel`) bleiben **unverändert** bestehen, weil jeder von ihnen weitere Konsumenten hat (siehe Verträge / Konsumenten-Matrix). (Testbar: Diff berührt **keine** Server-Router/Boundary-Datei; die vier Endpunkte existieren unverändert weiter; ihre bestehenden Tests bleiben grün.)
- **AC5** — Die verbleibenden Aktions-Karten des „Arbeiten"-Reiters (Board abarbeiten + Cost-Mode, Idee, Neue Story) und der „Terminal einblenden"-Mechanismus (fabrik-arbeiten-layout AC2) sind **funktional unverändert** — gleiche Handler, gleiche Endpunkte, gleiches Verhalten. (Testbar: die bestehenden CockpitView-Tests für Board-Drain/Idee/Neue-Story/Terminal-Toggle bleiben — abgesehen von entfernten Trigger-/Dashboard-Assertions — grün.)
- **AC6** — Reiner Frontend-/Aufräum-Change: **keine** Secrets im Bundle, **kein** `dangerouslySetInnerHTML`, keine neue Trust-Boundary. (Testbar: Diff enthält nur Client-/`docs/`-Dateien.)
- **AC7** — Owner-Entscheidung zu A1 (2026-07-06): `/agent-flow:preview` bekommt ein **neues Zuhause** statt ersatzlos zu entfallen — ein eigener, kleiner Button auf der **Fabrik-Übersicht** (neben den Projekt-Aktionen, außerhalb des entfernten `TriggerPanel`), der wahlweise `up`/`down`/`list`/`available` auslöst (Argument-Auswahl analog dem bisherigen `TriggerPanel`-Dropdown, minimal: Projekt + Modus). Nutzt denselben bestehenden `POST /api/command`-Pfad + die unveränderte Backend-Allowlist (AC4) — kein neuer Endpunkt. (Testbar: Fabrik-Übersicht rendert einen „Vorschau"-Button, Klick löst `POST /api/command` mit `/agent-flow:preview …` aus, Ergebnis/Fehler erscheinen inline.)

## Verträge
**Konsumenten-Matrix (Backend-Endpunkt-Prüfung, AC4 — verbindlich dokumentiert):**

| Endpunkt | genutzt von entfernter Komponente | **weitere** Konsumenten (⇒ bleibt) |
|---|---|---|
| `GET /api/status` | `Dashboard.jsx`, `TriggerPanel.jsx` (Projektliste) | **`ClaudeAuthBadge.jsx`** (claude-auth-health — der Endpunkt trägt zusätzlich den `claudeAuth`-Zustand; `src/statusRouter.js`). ⇒ **behalten** |
| `GET /api/session` | `TriggerPanel.jsx` (Busy-Poll) | `CockpitView.jsx` (`FactoryWorkspace` Busy-Poll für „Board abarbeiten"), `IntakeDialog`/`ObsidianImportSection`, neuer Adopt-Weg [[neues-projekt-auswahl-dialog]]. ⇒ **behalten** |
| `POST /api/command` | `TriggerPanel.jsx` (Befehls-Trigger) | `IntakeDialog.jsx` (new-project/requirement), `ObsidianImportSection` (from-notes), neuer Adopt-Weg [[neues-projekt-auswahl-dialog]]. ⇒ **behalten** |
| `POST /api/command/cancel` | `TriggerPanel.jsx` (Kill) | neuer Adopt-Weg [[neues-projekt-auswahl-dialog]] (Kill während des Adopt-Laufs); allgemeiner Kill-Switch [[flow-trigger]]. ⇒ **behalten** |

**Ergebnis:** Alle vier Endpunkte behalten mindestens einen Konsumenten → **kein Endpunkt wird entfernt**. Die Backend-Allowlist (`DEFAULT_ALLOWED_COMMANDS`, inkl. `/agent-flow:preview`) bleibt **unverändert** (Server ist autoritativ; Allowlist-Einträge sind billig und schaden nicht, auch wenn ein Frontend-Trigger wegfällt).

## Edge-Cases & Fehlerverhalten
- Ein anderer Test/Modul importiert versehentlich noch `TriggerPanel`/`Dashboard` → Build/Lint schlägt fehl (AC3 fängt das ab; solche Referenzen müssen mitentfernt werden).
- `costMode.js` (von `TriggerPanel` **und** `IntakeDialog`/CockpitView geteilt) bleibt **erhalten** — es hat weitere Nutzer; nur der `TriggerPanel`-Import darauf entfällt.
- Snapshot-/Integrationstests der „Arbeiten"-Ansicht, die Trigger/Dashboard erwarteten, werden entsprechend angepasst (die betroffenen Assertions entfernt), ohne die übrigen Assertions zu schwächen.

## NFRs
- **Sicherheit (Floor):** keine neuen Endpunkte, keine Boundary-Änderung, keine Secrets im Bundle. Der Wegfall des Frontend-Triggers reduziert die client-seitige Angriffsfläche (weniger frei komponierbare Befehlszeilen), ohne serverseitige Enforcement (Allowlist/Sanitisierung) zu verändern.
- **A11y (WCAG 2.1 AA):** unverändert für die verbleibenden Elemente; keine neuen interaktiven Elemente.

## Nicht-Ziele
- Der **Adopt-Weg** selbst (URL-Eingabe, Fork, Auslösung, Kill) — liegt in [[neues-projekt-auswahl-dialog]]. Diese Spec entfernt nur den alten Trigger-Einstieg; die Reihenfolge (Adopt zuerst re-homen, dann `TriggerPanel` entfernen) ist über die Board-Abhängigkeit ausgedrückt.
- Entfernen von Backend-Endpunkten (bewusst **nicht**, siehe AC4).
- Das **Team-Train-Panel** ([[retro-train-board-local]] / Teamseite) — unberührt.

## Offene Annahmen (mangels Rückfrage-Möglichkeit als Subagent gesetzt — vom Owner zu bestätigen)
- **A1 (`/agent-flow:preview` verliert seinen einzigen UI-Einstieg — vom Owner entschieden, 2026-07-06).** Der `TriggerPanel` war die **einzige** GUI-Stelle, die `/agent-flow:preview` (`up`/`down`/`list`/`available`) auslösen konnte. Owner-Entscheidung: **neuer eigener Button auf der Fabrik-Übersicht** (siehe AC7) — kein ersatzloser Wegfall. Diese Spec deckt damit sowohl die Entfernung (AC1–AC6) als auch das neue Zuhause (AC7) ab.
- **A2 (interaktives `requirement`/`train`-Freitextfeld im Cockpit entfällt).** Der freie `requirement`-/`train`-Trigger des `TriggerPanel` entfällt mit der Komponente; `requirement` bleibt über den Neue-Story-Chat + IntakeDialog erreichbar, `train` über die Teamseite. Kein Ersatz im Cockpit nötig (bewusst).

## Abhängigkeiten
- [[neues-projekt-auswahl-dialog]] — homt **Adopt** auf die Fabrik-Übersicht um; die `TriggerPanel`-Entfernungs-Story **hängt** davon ab (Adopt-Einstieg muss existieren, bevor der alte entfällt).
- [[fabrik-arbeiten-layout]] — dessen AC2/AC3-Nennung von „verschlanktem Trigger" + „Dashboard" wird hier abgelöst (der übrige Layout-Mechanismus bleibt).
- [[flow-trigger]] — Backend-Allowlist/Sanitisierung + `/api/command`(`/cancel`) bleiben unverändert.
- [[claude-auth-health]] — `ClaudeAuthBadge` als fortbestehender Konsument von `GET /api/status` (Grund, warum der Endpunkt bleibt).
