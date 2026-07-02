---
id: obsidian-sync-trigger
title: Obsidian-Sync-Trigger — Button „Notizen-Stand abgleichen" im Spezifikation-Reiter
status: active
version: 1
spec_format: use-case-2.0
---

# Spec: Obsidian-Sync-Trigger (`obsidian-sync-trigger`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` — hartes Drift-Gate.

## Zweck
Ein **dünner** GUI-Auslöser im „Spezifikation"-Reiter eines Projekts startet den Re-Sync-Modus der Fabrik-Pipeline (`/agent-flow:from-notes --sync <ordner>`), der **Widersprüche** zwischen dem aktuellen **Notiz-Stand** (Obsidian-Vault) und dem aktuellen **Konzept-/Spezifikations-Stand** (`docs/`) aufzeigt — **ohne Blind-Overwrite**. Das Muster ist **bewusst identisch** zum bestehenden „Konzept/Spec nachziehen"-Button ([[reconcile-trigger]]) im selben Reiter: dev-gui **löst nur aus** (`POST /api/command`) — die gesamte Abgleich-/Anzeige-Logik lebt in **agent-flow** (`obsidian-ingest-subsystem.md`, `--sync`-Modus, PR #217). Diese Capability ist bewusst **niedriger priorisiert** („später") als die Anlage aus Notizen ([[obsidian-project-intake]]).

## Verhalten
1. Im Reiter „Spezifikation" (`SpecView`, [[projekt-spezifikation-anzeige]]) erscheint — **neben/analog** zum „Konzept/Spec nachziehen"-Button ([[reconcile-trigger]]) — ein Button **„Notizen-Stand abgleichen" (Obsidian-Sync)** samt kurzem Hinweistext, der den ausgelösten Befehl `/agent-flow:from-notes --sync` nennt und klarstellt: **zeigt Widersprüche an, überschreibt nicht blind**.
2. Der Button ist nur sinnvoll, wenn ein **Vault konfiguriert** ist ([[obsidian-vault-config]] `configured: true`); ist keiner konfiguriert, ist der Button **deaktiviert** (disabled-Attribut **+** Text-Hinweis auf die Einstellungen, nie nur Farbe).
3. **Bestätigungsdialog vor dem Start** (analog [[reconcile-trigger]] AC2): ein Klick öffnet zuerst einen Bestätigungsdialog (`role="dialog"`), der klarstellt, dass ein Abgleich-Lauf startet (Widersprüche werden **angezeigt**, nichts wird blind überschrieben). Erst „Starten" löst aus; „Abbrechen" schließt ohne Wirkung.
4. **Auslösen.** Bestätigung POSTet **genau einmal** `{ command: '/agent-flow:from-notes --sync <path>', projectPath }` an `POST /api/command`. `<path>` = der zum aktiven Projekt gehörende Vault-Projektordner (s. Annahme A1); die bestehende Sanitisierung ([[flow-trigger]] AC2) bleibt die Enforcement-Grenze.
5. **Concurrency-Sperre.** Läuft bereits ein Job (`GET /api/session` → `state:"busy"` **oder** `409`), ist der Button **deaktiviert** (disabled **+** Text-Label/Lock-Hinweis, nie Farbe allein); ein Klick löst dann **keinen** POST aus.
6. **Erfolg (202).** Nach erfolgreichem Auslösen wechselt die Ansicht in den Terminal-/Arbeiten-Bereich (`onNavigate('factory')`), damit der Abgleich-Lauf **live** sichtbar ist und die aufgezeigten Widersprüche erscheinen — konsistent zu [[reconcile-trigger]] AC5.
7. **Fehler.** `400` (Allowlist/Sanitisierung), `409` (Lock), `500`/Netzwerkfehler → sichtbare Fehler-/Status-Anzeige mit Reset-Möglichkeit; **kein** `onNavigate`, kein Crash.

## Acceptance-Kriterien
- **AC1** — Im Spezifikation-Reiter ist ein Button **„Notizen-Stand abgleichen" (Obsidian-Sync)** vorhanden (neben „Konzept/Spec nachziehen"); Touch-Target ≥ 44 px; ein sichtbarer Hinweistext nennt den Befehl `/agent-flow:from-notes --sync` **und** stellt klar: zeigt Widersprüche an, überschreibt nicht blind. Ist kein Vault konfiguriert, ist der Button **deaktiviert** (disabled **+** Text-Hinweis, nicht nur Farbe). *(1,2)*
- **AC2** — Klick (bei freier Session + konfiguriertem Vault) öffnet einen **Bestätigungsdialog** (`role="dialog"`) mit dem Hinweis, dass ein Abgleich-Lauf startet (kein Blind-Overwrite); es wird **noch nichts** an `/api/command` gesendet. *(3)*
- **AC3** — Im Dialog „Starten" POSTet **genau einmal** `{ command: '/agent-flow:from-notes --sync <path>', projectPath: <aktives Projekt> }` an `/api/command`; „Abbrechen" schließt ohne POST. *(4)*
- **AC4** — `/agent-flow:from-notes` (inkl. `--sync`-Variante) ist in der **Backend-Allowlist** (`DEFAULT_ALLOWED_COMMANDS`) zulässig; ein Trigger mit diesem Präfix wird akzeptiert (`202`). (Der Allowlist-Basiseintrag stammt aus [[obsidian-project-intake]] AC4; diese Spec stellt sicher, dass die **`--sync`-Variante** die Sanitisierung/Allowlist unverändert passiert.) *(4)*
- **AC5** — Bei aktivem Job (`GET /api/session` → `state:"busy"`) ist der Button **deaktiviert** (disabled **+** zugängliches Label/Lock-Hinweis per Text, nicht nur Farbe); ein Klick öffnet **keinen** Dialog und löst **keinen** POST aus. *(5)*
- **AC6** — Antwort `202` → `onNavigate('factory')` (Lauf live im Terminal, Widersprüche sichtbar); kein stehengebliebenes „gestartet"-Element im Spezifikation-Reiter. *(6)*
- **AC7** — Antwort `409` → sichtbare Fehler-/Status-Anzeige (Job läuft bereits), **kein** `onNavigate`, kein Crash. Netzwerkfehler/`400`/`500` → sichtbare Fehler-Anzeige mit Reset, **kein** `onNavigate`. *(7)*

## Verträge
- **`POST /api/command`** (bestehend, [[flow-trigger]]) — **unverändert**; nutzt den Allowlist-Eintrag `/agent-flow:from-notes` aus [[obsidian-project-intake]] AC4 (inkl. `--sync`-Argument). `{ command: "/agent-flow:from-notes --sync <path>", projectPath?: string }` → `202 { commandId, status }` | `400` | `409` | `500`.
- **`GET /api/settings/obsidian-vault-path`** ([[obsidian-vault-config]]) — Quelle des „Vault konfiguriert"-Zustands für die Button-Aktivierung.
- **`GET /api/session`** → `{ state: "ready"|"busy", … }` — Busy-/Lock-Zustand (Polling-Muster wie [[reconcile-trigger]]).
- **Cross-Repo (SR3):** Die gesamte `--sync`-**Logik** (Widerspruchserkennung Notiz↔`docs/`, Anzeige, kein Blind-Overwrite) lebt in **agent-flow** (`obsidian-ingest-subsystem.md`, PR #217); der Allowlist-Eintrag ist dev-gui-lokale Backend-Konfiguration. UI entkoppelt baubar/testbar (mockbarer `fetchFn`).

## Edge-Cases & Fehlerverhalten
- Kein Vault konfiguriert → Button deaktiviert (AC1), kein POST.
- Klick bei bereits busy-er Session → no-op (kein Dialog, kein POST), AC5.
- `409` trotz freiem UI-Zustand (Race) → Fehleranzeige, kein Navigate, AC7.
- Doppelklick auf „Starten" während `starting` → kein zweiter POST (Button gesperrt).
- Fehlt `projectSlug`/`activeRepo` → `projectPath` wird weggelassen (Backwards-Compat, wie [[reconcile-trigger]]).
- Kann der Vault-Projektordner für das aktive Projekt nicht bestimmt werden (Annahme A1 offen) → klare Fehleranzeige, kein POST.

## NFRs
- **A11y (WCAG 2.1 AA):** Dialog mit `role="dialog"` + zugänglichem Namen; Button-Sperre via disabled-Attribut **und** Text-Label (nie Farbe allein); sichtbarer Fokusring; Touch-Targets ≥ 44 px.
- **Sicherheit (Floor):** **kein** neuer Backend-Endpunkt, **keine** neue Trust-Boundary — der Befehl durchläuft die bestehende, unveränderte Sanitisierung ([[flow-trigger]] AC2) und den Allowlist-Eintrag aus [[obsidian-project-intake]]. Bestätigungsdialog verhindert versehentliches Auslösen. Kein `dangerouslySetInnerHTML`, keine Secrets im Bundle.

## Nicht-Ziele
- Die `--sync`-**Logik** (Widerspruchserkennung, Anzeige-Aufbereitung, kein Blind-Overwrite) — liegt vollständig in agent-flow (`obsidian-ingest-subsystem.md`).
- Eine **strukturierte, in-GUI Widerspruchs-/Diff-Anzeige** über das Terminal hinaus — bewusst **Nicht-Ziel** dieser dünnen Trigger-Spec (mögliche Folge-Anforderung, analog dazu wie [[obsidian-question-catalog]] den Fragenkatalog anreichert). Hier: Auslösen + Live-Terminal.
- Änderungen am `/api/command`-Endpunkt, an der Sanitisierung oder am generischen TriggerPanel-Befehlskatalog von [[flow-trigger]] (der Allowlist-Eintrag stammt aus [[obsidian-project-intake]]).

## Abhängigkeiten
- [[projekt-spezifikation-anzeige]] (Reiter „Spezifikation"/`SpecView`, in den der Button gehängt wird).
- [[reconcile-trigger]] (Button-/Bestätigungs-/Busy-Guard-/Navigate-Muster im selben Reiter — hier 1:1 gespiegelt).
- [[obsidian-vault-config]] (Vault-konfiguriert-Zustand für die Aktivierung). **Depends-on.**
- [[obsidian-project-intake]] (Allowlist-Basiseintrag `/agent-flow:from-notes`). **Depends-on.**
- [[flow-trigger]] (POST `/api/command`, Allowlist, Sanitisierung, Session-Lock — unverändert genutzt).
- **agent-flow** `docs/architecture/obsidian-ingest-subsystem.md` (PR #217, `--sync`-Modus, SR3) — liefert den Befehl.

## Offene Annahmen (mangels Rückfrage-Möglichkeit als Subagent gesetzt — vom Owner bestätigbar)
- **A1 (Projekt↔Vault-Ordner-Zuordnung):** Der `--sync`-Lauf braucht den zum aktiven Projekt gehörenden Vault-Projektordner. Wie dieser bestimmt wird (gemerkt bei der Anlage aus [[obsidian-project-intake]], per Namensgleichheit, oder erneute Auswahl im Dialog), ist offen und hängt am agent-flow-`--sync`-Vertrag (PR #217). Default-Annahme: der bei der Anlage verwendete Ordner-Pfad wird beim Projekt hinterlegt und hier wiederverwendet; alternativ Auswahl im Bestätigungsdialog. Owner/architekt fixieren dies beim Merge von #217.
- **A2 (Priorität):** Diese Capability ist bewusst **niedriger priorisiert** („später") als [[obsidian-project-intake]] — der Sync-Knopf setzt einen bereits aus Notizen angelegten/gepflegten Projektstand voraus.
