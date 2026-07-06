---
id: neues-projekt-auswahl-dialog
title: „Neues Projekt"-Auswahl-Dialog (Neues Projekt · Aus Obsidian übernehmen · Adopt) auf der Fabrik-Übersicht
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: „Neues Projekt"-Auswahl-Dialog (`neues-projekt-auswahl-dialog`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Auf der **Fabrik-Übersicht** (`RepoOverview.jsx`, Route `#/factory` ohne aktives Projekt) ersetzt ein **Auswahl-Dialog** den bisherigen direkten Weg „+ Neues Projekt / Idee erfassen": statt sofort den Intake-Dialog zu öffnen, erscheint zuerst ein Dialog mit **drei Wegen**, ein Projekt in die Fabrik zu holen:

1. **„Neues Projekt"** → der bisherige Scaffold-Weg (`/agent-flow:new-project` + Idee via `/agent-flow:requirement`) — **unverändert** der bestehende `IntakeDialog` im `new`-Modus ([[fabric-intake-dialog]]).
2. **„Aus Obsidian übernehmen"** → der bestehende from-notes-Weg ([[obsidian-project-intake]] · [[obsidian-question-catalog]]) — die vorhandene `ObsidianImportSection` (heute in `GitHubView.jsx`) wird **hierher umgehängt**; **Verhalten, Guards und beide Pfade (strukturiert + PTY-Fallback) bleiben unverändert**, nur der Einstiegspunkt verschiebt sich von der GitHub-Seite auf die Fabrik-Übersicht.
3. **„Adopt"** → ein **neuer** Weg: eine **beliebige** GitHub-Repo-URL wird übernommen; fremde Repos werden gemäß dem `agent-flow:adopt`-Skill automatisch in die eigene Org geforkt und übernommen — ausgelöst über **dieselbe** abgesicherte Befehls-Mechanik wie der bisherige `TriggerPanel`-Weg (`POST /api/command` → PTY-`CommandService`, Kill via `POST /api/command/cancel`).

`train` bleibt **unverändert** auf der Teamseite ([[retro-train-board-local]]) und ist **nicht** Teil dieses Dialogs.

> **Supersedes-Bezug:** Der bisherige direkte „+ Neues Projekt / Idee erfassen"-Button ([[fabric-intake-dialog]] AC1, `RepoOverview`) öffnet ab jetzt zuerst diesen Auswahl-Dialog; der `IntakeDialog`-`new`-Modus selbst (Zwei-Trigger-Sequenz, Cost-Mode, „Let Claude proof") bleibt **unverändert** und wird über die „Neues Projekt"-Option erreicht. Der von [[obsidian-project-intake]] AC1 beschriebene **Mount-Ort** der from-notes-Option (bisher in der GitHub-„Neues Repo"-Sektion) wird durch diese Spec auf den Fabrik-Auswahl-Dialog verschoben; die dortigen **Verhaltens-/Guard-ACs (AC2–AC7) bleiben unverändert gültig**.

## Verhalten
### Auswahl-Dialog (Shell)
1. Auf der Fabrik-Übersicht öffnet der Einstiegs-Button (bisher „+ Neues Projekt / Idee erfassen") einen **Auswahl-Dialog** mit genau **drei** klar beschrifteten, gleichwertigen Optionen: **„Neues Projekt"**, **„Aus Obsidian übernehmen"**, **„Adopt"**. Jede Option trägt einen kurzen erklärenden Untertext. Der Dialog ist schließbar (Schließen-Button/Escape), ohne einen Weg auszulösen.
2. Auswahl **„Neues Projekt"** zeigt den bestehenden `IntakeDialog` im `new`-Modus **unverändert** (gleiche Props/Sequenz/Handler wie heute in `RepoOverview`); dessen Verhalten (Zwei-Trigger, Cost-Mode, Proof, Navigate) ist durch [[fabric-intake-dialog]] abgedeckt und wird hier **nicht** verändert.
3. Auswahl **„Aus Obsidian übernehmen"** zeigt die (umgezogene) `ObsidianImportSection`; deren Verhalten/Guards/beide Pfade sind durch [[obsidian-project-intake]] + [[obsidian-question-catalog]] abgedeckt und bleiben **unverändert** (kein Vault konfiguriert → deaktiviert mit Hinweis; Projektordner-Liste; „Strukturiert starten" + „Auslösen"; Busy-Guard; Overlay).
4. Auswahl **„Adopt"** zeigt den neuen Adopt-Weg (unten).

### Adopt-Weg
5. **URL-Eingabe.** Ein Textfeld nimmt eine **beliebige** GitHub-Repo-URL entgegen (nicht auf die eigene Org beschränkt). Die Eingabe wird client-seitig **validiert**: akzeptiert werden gültige GitHub-Repo-URLs der Form `https://github.com/<owner>/<repo>` (mit/ohne `.git`-Suffix, mit/ohne abschließendem `/`, `http`/`https`, optional `www.`). Ungültige Eingaben (kein GitHub-Host, fehlendes `owner`/`repo`, Leerstring) → sichtbare, textliche Validierungsmeldung; „Weiter/Übernehmen" bleibt deaktiviert.
6. **Fork-Einschätzung + Bestätigungs-Rückfrage.** Vor der Auslösung erscheint eine **Zusammenfassung**: die erkannte Quelle (`<owner>/<repo>`) und ob geforkt wird — **ja**, wenn `<owner>` **nicht** die eigene Org ist; **nein**, wenn das Repo bereits in der eigenen Org liegt. Die eigene Org wird aus einer bestehenden, nicht-geheimen Quelle bezogen (siehe Verträge / Offene Annahme A1). Erst nach expliziter Bestätigung wird ausgelöst (kein Auto-Start).
7. **Auslösung.** Bei Bestätigung POSTet der Weg **genau einmal** `{ command: '/agent-flow:adopt <arg>' }` an `POST /api/command` — über **dieselbe** Mechanik wie der bisherige `TriggerPanel`-Adopt (PTY-`CommandService`, Allowlist-Präfix `/agent-flow:adopt` bereits vorhanden, Sanitisierung unverändert [[flow-trigger]] AC2). `<arg>` ist die aus der URL abgeleitete, sanitisierte `<owner>/<repo>`-Kennung (kein roher Freitext; siehe Verträge / Offene Annahme A2).
8. **Busy-Sperre + Kill.** Läuft bereits ein Job (`GET /api/session` → `state:"busy"` **oder** Antwort `409`), ist „Auslösen" **deaktiviert** (disabled-Attribut **+** Text-/Lock-Hinweis, nie Farbe allein). Während des laufenden Adopt-Laufs ist ein **Kill**-Knopf aktiv, der `POST /api/command/cancel` auslöst (identisch zum bisherigen `TriggerPanel`-Kill).
9. **Rückmeldung.** Nach `202` zeigt der Weg einen **inline** sichtbaren Lauf-Status (textlich: „läuft" → „gestartet/fertig" bzw. Fehler) — analog zum bisherigen `TriggerPanel`-Statusmuster; `409` → „Ein Job läuft bereits"; `400`/`500`/Netzwerkfehler → sichtbare Fehlermeldung mit Reset. (Zur Live-Ausgabe des interaktiven Laufs siehe Offene Annahme A3.)

## Acceptance-Kriterien
- **AC1** — Der Fabrik-Übersichts-Einstieg öffnet einen **Auswahl-Dialog** mit genau **drei** beschrifteten Optionen („Neues Projekt", „Aus Obsidian übernehmen", „Adopt") statt direkt den Intake-Dialog. Der Dialog ist per Schließen-Affordanz schließbar, ohne einen Weg auszulösen; Touch-Targets ≥ 44 px, jede Option per Tastatur erreichbar, sichtbarer Fokusring. *(2)*
- **AC2** — Option **„Neues Projekt"** rendert den bestehenden `IntakeDialog` im `new`-Modus **unverändert** (gleiche Sequenz/Handler/Cost-Mode/Proof wie [[fabric-intake-dialog]]); es wird **kein** `IntakeDialog`-Verhalten geändert. *(2.1)*
- **AC3** — Option **„Aus Obsidian übernehmen"** rendert die von `GitHubView.jsx` **hierher umgezogene** `ObsidianImportSection`; deren Verhalten, Guards und **beide** Pfade (strukturiertes Fragenkatalog-Overlay + PTY-„Auslösen"-Fallback) sind **unverändert** ([[obsidian-project-intake]] AC1–AC7 + [[obsidian-question-catalog]]). In `GitHubView.jsx` ist die Sektion samt totem Import entfernt; die Obsidian-Tests werden auf den neuen Mount-Ort migriert (kein Test-Verlust). *(2.2)*
- **AC4** — Option **„Adopt"** bietet ein URL-Eingabefeld mit **Validierung**: nur gültige GitHub-Repo-URLs (`https?://[www.]github.com/<owner>/<repo>[.git][/]`) werden akzeptiert; ungültige/leere Eingabe → textliche Validierungsmeldung, „Weiter/Übernehmen" deaktiviert. *(3)*
- **AC5** — Vor der Auslösung zeigt der Adopt-Weg eine **Bestätigungs-Zusammenfassung** mit der erkannten Quelle `<owner>/<repo>` und einer klaren **„wird geforkt: ja/nein"**-Angabe (ja ⇔ `<owner>` ≠ eigene Org). Ausgelöst wird **erst** nach expliziter Bestätigung (kein Auto-Start). *(3)*
- **AC6** — Bei Bestätigung POSTet der Adopt-Weg **genau einmal** `{ command: '/agent-flow:adopt <owner/repo>' }` an `POST /api/command`; `<owner/repo>` ist die aus der URL abgeleitete, zu **einer** Zeile ohne Steuerzeichen kollabierte Kennung (kein roher Freitext). Allowlist-Präfix `/agent-flow:adopt` und Sanitisierung ([[flow-trigger]] AC2) bleiben **unverändert** genutzt. *(3)*
- **AC7** — Busy-Sperre + Kill: Bei `state:"busy"`/`409` ist „Auslösen" **deaktiviert** (disabled + Text-/Lock-Hinweis, nie nur Farbe); während des Laufs löst der **Kill**-Knopf `POST /api/command/cancel` aus. Antworten werden textlich zurückgemeldet: `202` → Lauf-Status inline; `409` → „Ein Job läuft bereits"; `400`/`500`/Netzwerkfehler → sichtbare Fehlermeldung mit Reset, kein Crash. *(3)*
- **AC8** — Reiner **Frontend**-Change ohne neuen Backend-Endpunkt und ohne Boundary-Änderung: genutzt werden ausschließlich die bestehenden `POST /api/command`, `POST /api/command/cancel`, `GET /api/session` und (für die eigene-Org-Ableitung) eine bereits vorhandene, nicht-geheime Quelle (siehe Verträge). Keine Secrets im Bundle, kein `dangerouslySetInnerHTML`. *(2/3)*

## Verträge
- **`POST /api/command`** (bestehend, [[flow-trigger]]) — **unverändert**; `{ command: "/agent-flow:adopt <owner/repo>", projectPath? }` → `202 { commandId, status }` | `400` (Allowlist/Sanitisierung) | `409` (Lock) | `500`. Allowlist-Präfix `/agent-flow:adopt` ist bereits gelistet (`DEFAULT_ALLOWED_COMMANDS`, `src/CommandService.js`) — **keine** Allowlist-Änderung nötig. `projectPath` wird beim Adopt weggelassen (globale Session, wie der bisherige `TriggerPanel`-Adopt).
- **`POST /api/command/cancel`** (bestehend) — Kill des laufenden Adopt-Laufs (Interrupt an die Session), unverändert.
- **`GET /api/session`** → `{ state: "ready"|"busy", … }` — Busy-/Lock-Quelle (Polling-Muster wie bisher `TriggerPanel`/`ObsidianImportSection`).
- **Eigene-Org-Ableitung (Fork-ja/nein, AC5):** die eigene Org (`Studis-Softwareschmiede`) wird aus einer bestehenden, **nicht-geheimen** Quelle bestimmt (z.B. der bereits gelieferten Org-Repo-/Workspace-Übersicht `GET /api/github/repos` bzw. dem daraus ersichtlichen Org-Namen), **nicht** aus einem neuen Secret/Endpunkt. Ist die eigene Org nicht sicher bestimmbar, wird konservativ **„wird geforkt: ja (sofern fremd)"** bzw. ein neutraler Hinweis angezeigt (kein Blockieren der Auslösung) — die tatsächliche Fork-Entscheidung trifft ohnehin der `agent-flow:adopt`-Skill serverseitig.
- **Cross-Repo (adopt-Skill):** Die **Fork-/Übernahme-Logik** (fremdes Repo → Fork in eigene Org → adopt) lebt **ausschließlich** im `agent-flow:adopt`-Skill; dev-gui **löst nur aus** und reicht die sanitisierte `<owner/repo>`-Kennung als **ein** Argument in den bestehenden, allowlist-geschützten Command-Kanal. Die UI ist davon **entkoppelt** baubar/testbar (mockbarer `fetchFn`).

## Edge-Cases & Fehlerverhalten
- URL mit Pfad-Zusatz (`/tree/main`, `/pull/1`, Query/Anchor) → die Validierung extrahiert `<owner>/<repo>` aus den ersten beiden Pfadsegmenten; überzählige Segmente werden ignoriert (oder, konservativer, als ungültig markiert — siehe Offene Annahme A2).
- `git@github.com:owner/repo.git` (SSH-Form) → **nicht** akzeptiert (nur `http(s)`-URLs, AC4); klare Validierungsmeldung.
- Groß-/Kleinschreibung von `<owner>` bei der Eigene-Org-Prüfung → case-insensitiv vergleichen.
- Klick auf „Auslösen" bei bereits busy-er Session (Race) → `409` → Fehleranzeige, kein zweiter POST (AC7).
- Doppelklick auf „Auslösen" → kein zweiter POST (Button während `starting` gesperrt).
- Dialog schließen während eines laufenden Adopt-Laufs → der Backend-Lauf läuft weiter (kein impliziter Kill durch Schließen); der Kill erfolgt nur über den expliziten Kill-Knopf.
- Obsidian-Option ohne konfigurierten Vault → deaktiviert + Hinweis (unverändert [[obsidian-project-intake]] AC1).

## NFRs
- **Sicherheit (Floor):** **kein** neuer Backend-Endpunkt, **keine** neue Trust-Boundary. Die Adopt-URL passiert die bestehende, unveränderte Sanitisierung ([[flow-trigger]] AC2); nur die abgeleitete `<owner/repo>`-Kennung (kein roher URL-Freitext mit Steuerzeichen) wird als **eine** Zeile gesendet. Server bleibt autoritativ (Allowlist + Sanitisierung). Keine Secrets im Bundle, kein `dangerouslySetInnerHTML`.
- **A11y (WCAG 2.1 AA):** Auswahl-Optionen + Adopt-Feld beschriftet, per Tastatur bedienbar, Button-Sperre via disabled-Attribut **und** Text-Label (nie Farbe allein), sichtbarer Fokusring, Touch-Targets ≥ 44 px; Validierungs-/Status-/Fehlermeldungen als `role="alert"`/`role="status"` mit Text (nicht nur Farbe).

## Nicht-Ziele
- Die **from-notes-Pipeline-Logik** + die **adopt-/Fork-Logik** — liegen vollständig in agent-flow (`obsidian-ingest-subsystem` bzw. `agent-flow:adopt`-Skill); dev-gui löst nur aus.
- Änderungen am `IntakeDialog`-`new`-Verhalten oder an der `ObsidianImportSection`-Logik (nur **Mount-Ort** wandert; Verhalten unverändert).
- Änderungen am `/api/command`-Endpunkt, an der Sanitisierung oder an der Backend-Allowlist (`/agent-flow:adopt` ist bereits gelistet).
- Das **Team-Train-Panel** / `train` auf der Teamseite — unberührt ([[retro-train-board-local]]).
- Entfernen von `TriggerPanel`/`Dashboard` aus dem Cockpit — eigene Spec [[cockpit-declutter]].

## Offene Annahmen (mangels Rückfrage-Möglichkeit als Subagent gesetzt — vom Owner zu bestätigen)
- **A1 (Eigene-Org-Quelle für Fork-ja/nein):** Die Fork-ja/nein-Anzeige (AC5) leitet die eigene Org aus einer **bereits vorhandenen, nicht-geheimen** Quelle ab (Org-Repo-Übersicht `GET /api/github/repos` bzw. bekannter Org-Name), **ohne** neuen Endpunkt/Secret. Ist sie nicht sicher bestimmbar, wird konservativ/neutral gemeldet, ohne die Auslösung zu blockieren (die echte Fork-Entscheidung liegt im adopt-Skill). Falls der Owner die Org fix verdrahten oder einen dedizierten Endpunkt wünscht, ist das eine kleine Folge-Änderung.
- **A2 (adopt-Argumentform):** dev-gui übergibt dem `agent-flow:adopt`-Skill die abgeleitete **`<owner>/<repo>`-Kennung** als Argument (konsistent mit dem bisherigen `TriggerPanel`-Adopt, der `owner/repo` sendete). Ob der adopt-Skill alternativ die **volle URL** als Argument bevorzugt, ist eine Skill-seitige Konvention (agent-flow); die UI-Validierung/Ableitung bleibt gleich, nur die gesendete Zeichenkette würde sich ändern. Konservativ werden URLs mit überzähligen Pfadsegmenten als **ungültig** behandelt (nur `…/<owner>/<repo>` akzeptiert), um Fehl-Adoptions zu vermeiden.
- **A3 (Live-Ausgabe des interaktiven Adopt-Laufs):** Der Adopt-Lauf ist interaktiv (PTY, kann Rückfragen stellen). Die Fabrik-Übersicht hat **kein** eingebettetes Terminal; wie der bisherige `TriggerPanel`-Adopt zeigt dieser Weg daher nur einen **inline-Status** (kein Live-Terminal an dieser Stelle). Rückfragen des adopt-Laufs erscheinen im projektgebundenen Terminal, sobald das Repo geklont/geöffnet ist bzw. über die bestehenden Terminal-Flächen. Falls der Owner eine Live-Ausgabe direkt im Dialog wünscht, ist das eine Folge-Capability (analog obsidian-question-catalog).

## Abhängigkeiten
- [[fabric-intake-dialog]] — die „Neues Projekt"-Option nutzt den bestehenden `IntakeDialog`-`new`-Modus (unverändert); der bisherige direkte Einstieg wird hinter den Auswahl-Dialog gelegt.
- [[obsidian-project-intake]] / [[obsidian-question-catalog]] — die „Aus Obsidian übernehmen"-Option ist die umgezogene `ObsidianImportSection`; Verhalten/Guards unverändert (nur Mount-Ort).
- [[flow-trigger]] — `POST /api/command`(`/cancel`), Allowlist (`/agent-flow:adopt` bereits gelistet), Sanitisierung, Session-Lock — unverändert genutzt.
- [[cockpit-declutter]] — entfernt den alten `TriggerPanel`-Adopt-Einstieg; dessen Entfernungs-Story **hängt** an der Adopt-Story dieser Spec (Adopt zuerst re-homen).
- **agent-flow** `agent-flow:adopt`-Skill (Cross-Repo) — liefert die Fork-/Übernahme-Logik.
