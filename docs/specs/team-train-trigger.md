---
id: team-train-trigger
title: Train-Button in der Teamsicht + Retro-Start in der Retro-Sicht (Self-Improvement aus der GUI)
status: draft
version: 3
---

# Spec: Train- & Retro-Start aus der GUI  (`team-train-trigger`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die ACs), `reviewer` (Drift-Gate).
>
> **Status: Draft / Konzept.** Mit dem Owner abgestimmte Designentscheidungen (2026-06-19) sind unten als *bindend* markiert. Offene Punkte stehen unter „Offene Fragen".
>
> **Revision v3 (Owner 2026-06-19):**
> 1. Train-Popup bekommt ganz oben eine **„Alle"-Auswahl**, die alle Knowledge-Bereiche an-/abwählt.
> 2. **Retro wandert aus der Teamsicht in die Retro-Sicht:** der bestehende „Retro"-Kopf-Link bleibt und führt wie heute zur Retro-Sicht (Reiter „Läufe" / „Verbesserungs-Board"). Dort kommt **neben dem Reiter „Verbesserungs-Board" ein Button „Retro starten"** hinzu. In der Teamsicht bleibt nur der **Train**-Button.
> 3. **„Parallel" = parallele Agenten in EINER Claude-Session** (Fan-out von Train-Subagenten), **nicht** mehrere Claude-Sessions. Der Session-Pool aus v2 entfällt.

## Zweck

Der Owner kann die Fabrik aus der GUI **dazulernen** lassen, ohne die passende Slash-Befehlszeile zu kennen:

- **„Train"** (Teamsicht) — Popup, in dem der Owner **ankreuzt, welche Knowledge-Bereiche** aktualisiert werden sollen (inkl. „Alle"), danach eine kleine **Ja/Nein-Bestätigung**, dann starten die Läufe.
- **„Retro starten"** (Retro-Sicht, neben dem Reiter „Verbesserungs-Board") — kleine **Ja/Nein-Nachfrage**, dann ein Retro-Lauf. Retro läuft global über das ganze Team; deshalb keine Auswahl.

Das ist der **Schreib-Komplement** zur heute rein lesenden Team-/Retro-Sicht.

## Kontext / Designentscheidungen (bindend)

- **Train in der Teamsicht, Retro in der Retro-Sicht.** *(Owner 2026-06-19)*
  - **Teamsicht:** ein Button **„Train"** → `/agent-flow:train …` (pro Knowledge-Bereich). Der bestehende „Retro"-Kopf-Link bleibt unverändert (führt zur Retro-Sicht).
  - **Retro-Sicht (`RetroView`):** neben dem Reiter „Verbesserungs-Board" ein Button **„Retro starten"** → `/agent-flow:retro` (genau ein Lauf).

- **Keine Agenten-/Skill-Auswahl.** *(Owner 2026-06-19)*
  `/retro` nimmt keinen Agent-/Skill-Parameter und aggregiert global. Eine Auswahl hätte keine Wirkung — daher entfällt sie. Train betrifft ausschließlich **Knowledge-Bereiche**.

- **Train: „Alle"-Auswahl zuoberst.** *(Owner 2026-06-19)*
  Im Train-Popup steht **über** der gruppierten Knowledge-Liste eine **„Alle"-Auswahl** (Master-Checkbox). Aktiviert → alle Knowledge-Bereiche angewählt; deaktiviert → keiner. Teilauswahl → unbestimmter („indeterminate") Zustand. Einzelne Häkchen bleiben weiter frei setzbar.

- **Train: Auswahl + Bestätigung.** *(Owner 2026-06-19)*
  Nach „Weiter" erscheint eine **kleine Ja/Nein-Bestätigung**, die die auszulösenden Läufe zusammenfasst („so wird trainiert: `java`, `tailwind` — starten?"). Erst „Ja" feuert.

- **Retro: nur Bestätigung.** *(Owner 2026-06-19)*
  „Retro starten" öffnet direkt eine **kleine Ja/Nein-Nachfrage** („Soll ich den Retro-Agenten starten?"). „Ja" feuert genau einen `/agent-flow:retro`-Lauf. Keine Auswahl, kein Kostenmodus-Schritt (bewusst minimal).

- **„Parallel" = parallele Agenten in einer Session.** *(Owner 2026-06-19)*
  Es gibt **eine** interaktive Claude-Session; in ihr lassen sich mehrere Subagenten gleichzeitig fahren (Fan-out). „Parallel" heißt daher: die GUI sendet **einen** Train-Befehl über **mehrere** Packs, und die Session startet **pro Pack einen Train-Subagenten parallel** — **nicht** mehrere Claude-Sessions. Voraussetzung: agent-flow-`/train` akzeptiert **mehrere Pack-IDs** und fächert intern auf (siehe Hauptrisiko/Abhängigkeiten).
  - **Warteschlange (Queue, Default):** die GUI sendet **N einzelne** `/train <pack>`-Befehle nacheinander (heutiges Verhalten, ein Pack pro Lauf).
  - **Parallel:** die GUI sendet **einen** Befehl `/agent-flow:train <pack-a> <pack-b> …`; die Session fächert auf.

- **Kostenmodus als Radio-Buttons (nur Train).** *(Owner 2026-06-19)*
  Train-Popup bietet den Kostenmodus (sparsam / balanced / gründlich) **als Radio-Buttons**. Default `balanced`, gilt für alle Train-Läufe des Durchgangs. Cost-Flag direkt nach dem Präfix, analog `costMode.js`.

- **Server bleibt die Durchsetzungs-Grenze.** Popups sind reine UX. Ausgelöst wird über `POST /api/command {command[, projectPath]}` → `CommandService` (Allowlist + Sanitizing + Job-Lock + Audit). Nur erlaubte Präfixe (`/agent-flow:train`, `/agent-flow:retro`) werden gebaut. Auch der Mehr-Pack-Train ist eine einzelne, einzeilige `/agent-flow:train …`-Befehlszeile (erster Token in der Allowlist, keine Steuerzeichen) — passt durch den bestehenden Pfad.

- **Keine neuen Daten-Endpunkte zum Befüllen.** Das Train-Popup nutzt die bestehende `GET /api/team`-Antwort (nur die `knowledge`-Gruppe).

## Verhalten

### V1 — Buttons platzieren (Frontend)
- **Teamsicht (`TeamView`):** im Kopfbereich ein markanter Button **„Train"** (Maus + Tastatur, Touch-Target ≥ 44 px, sichtbarer Fokusring). Der bestehende „Retro"- und „Retro-Trend"-Kopf-Link bleibt unverändert.
- **Retro-Sicht (`RetroView`):** in der Reiter-Leiste (`role="tablist"`, neben „Läufe" / „Verbesserungs-Board") ein Button **„Retro starten"** — visuell als **Aktion** erkennbar (kein Reiter, also nicht `role="tab"`; eigener Bereich/Abstand, damit er nicht mit dem Umschalten der Reiter verwechselt wird).

### V2 — Train-Popup: Auswahl inkl. „Alle" (Frontend)
Klick auf „Train" öffnet einen **modalen Dialog** (`role="dialog"`, `aria-modal="true"`, Fokus-Falle, `Esc` schließt, Fokus-Rückgabe an den Train-Button). Aufbau:
- **Zuoberst:** „Alle"-Master-Checkbox. Angekreuzt → wählt alle Knowledge-Bereiche; abgewählt → keiner; bei Teilauswahl → `indeterminate`.
- **Darunter:** die KNOWLEDGE-Bereiche als Mehrfach-Checkboxen, gruppiert nach `group` wie in der Teamsicht, je mit `EntityIcon` + Name. Keine Agenten/Skills.
- Quelle: `GET /api/team` (`knowledge`-Gruppe); lädt eigenständig mit `aria-busy`.

### V3 — Train-Popup: Optionen (Frontend)
Unterhalb der Liste:
- **Kostenmodus** als Radio-Gruppe (sparsam / balanced / gründlich), Default `balanced`.
- **Abarbeitung** als Radio-Gruppe (Warteschlange / Parallel), Default `Warteschlange`. „Parallel" ist nur aktiv, wenn agent-flow den Mehr-Pack-Train unterstützt; sonst deaktiviert mit Hinweis (AC7).

### V4 — Train-Popup: Bestätigung (Frontend)
„Weiter" zeigt eine **kleine Ja/Nein-Bestätigung** mit Zusammenfassung (z.B. „2 Train-Läufe: `java`, `tailwind` · balanced · parallel"). „Ja/Starten" feuert; „Nein/Zurück" kehrt zur Auswahl zurück. „Weiter" ist bei leerer Auswahl deaktiviert; Bestätigen ist gegen Doppel-Feuern geschützt.

### V5 — Train: Befehls-Komposition (Frontend → Backend)
- **Warteschlange:** je ausgewähltem Bereich ein Befehl `/agent-flow:train<cost> <pack-id>`, einzeln gesendet.
- **Parallel:** **ein** Befehl `/agent-flow:train<cost> <pack-id-1> <pack-id-2> …` mit allen ausgewählten Packs.
- `<cost>` = Cost-Flag aus dem Kostenmodus (analog `costFlag()` in `costMode.js`).
- `<pack-id>` aus der Knowledge-`id` (siehe „Verträge / Pack-ID-Mapping").

### V6 — Train: Abarbeitung (Backend-Verhalten)
- **Warteschlange:** der nächste Befehl wird erst gesendet, wenn `GET /api/session` wieder `ready` meldet; `409`/`session-cap` → Warten + Retry, kein Verlust.
- **Parallel:** ein einziger Befehl belegt die Session einmalig; die Parallelität passiert **innerhalb** der Session (Train-Subagenten fan-out durch agent-flow). Aus GUI-Sicht ist es ein Lauf; der Job-Lock bleibt unangetastet.

### V7 — „Retro starten" (Frontend → Backend)
Klick auf „Retro starten" öffnet eine **kleine modale Ja/Nein-Nachfrage** („Soll ich den Retro-Agenten starten?"; `role="dialog"`, `aria-modal`, `Esc`/„Nein" schließt, Fokus-Rückgabe). „Ja" sendet **genau einen** Befehl `/agent-flow:retro` an `POST /api/command`. Doppel-Feuer-Schutz während des Sendens. Ist die Session busy → `409` → Hinweis „läuft bereits / Session belegt".

### V8 — Rückmeldung & Lauf-Sicht (Frontend)
Nach dem Auslösen zeigt das jeweilige Popup je Befehl einen **Status** (gestartet / wartet / abgelehnt) und schließt sich nicht automatisch, solange Sends ausstehen. `/train` und `/retro` liefern **PR + Gate** — das Ergebnis erscheint später im **Verbesserungs-Board** (`retro-train-board-local`, Quelle `LEARNINGS.md`); darauf wird hingewiesen, ohne dass diese Spec dort etwas ändert.

## Acceptance-Kriterien

- **AC1** — Teamsicht zeigt einen „Train"-Button; Retro-Sicht zeigt in der Reiter-Leiste (neben „Verbesserungs-Board") einen Aktions-Button „Retro starten" (kein `role="tab"`); beide Maus + Tastatur bedienbar, Touch-Target ≥ 44 px, sichtbarer Fokusring. *(V1)*
- **AC2** — „Train" öffnet einen modalen Dialog (`role="dialog"`, `aria-modal`, Fokus-Falle, `Esc` schließt, Fokus-Rückgabe) mit einer „Alle"-Master-Checkbox zuoberst und darunter **nur** KNOWLEDGE-Bereichen als Mehrfach-Checkboxen, gruppiert nach `group`; keine Agenten/Skills. *(V2)*
- **AC3** — „Alle" an → alle Knowledge angewählt; „Alle" aus → keiner; Teilauswahl → „Alle" zeigt `indeterminate`; einzelne Häkchen bleiben frei setzbar und aktualisieren den „Alle"-Zustand korrekt. *(V2)*
- **AC4** — Train-Popup bietet Kostenmodus (Radio: sparsam/balanced/gründlich, Default balanced) und Abarbeitung (Radio: Warteschlange/Parallel, Default Warteschlange). *(V3)*
- **AC5** — „Weiter" zeigt eine Ja/Nein-Bestätigung mit Zusammenfassung; erst „Ja" feuert; leere Auswahl deaktiviert „Weiter". *(V4)*
- **AC6** — Warteschlange: je Bereich `/agent-flow:train<cost> <pack-id>`, einzeln, nächster erst bei `ready` (`409` → Warten + Retry). Parallel: **ein** `/agent-flow:train<cost> <pack-id-1> <pack-id-2> …`. Cost-Flag direkt nach dem Präfix. *(V5, V6)*
- **AC7** — „Parallel" ist nur aktiv, wenn agent-flow den Mehr-Pack-Train unterstützt; andernfalls deaktiviert mit Hinweis (Rückfall auf Warteschlange). *(V3, V6)*
- **AC8** — „Retro starten" öffnet eine kleine modale Ja/Nein-Nachfrage; „Ja" sendet genau einen `/agent-flow:retro`; keine Auswahl/kein Kostenmodus. *(V7)*
- **AC9** — Beide Popups: Bestätigen gegen Doppel-Feuern gesperrt; je Befehl Status (gestartet/wartet/abgelehnt). *(V4, V7, V8)*
- **AC10** — A11y (WCAG 2.1 AA): semantische Dialoge, beschriftete Checkboxen/Radios, korrekt kommunizierter „Alle"-Indeterminate-Zustand, sichtbare Fokusringe, Bedeutung nicht allein über Farbe, `aria-busy`/`aria-live`. *(V2–V4, V7, V8)*
- **AC11** — Security-Floor: kein `dangerouslySetInnerHTML`/`innerHTML`, keine Secrets im Bundle, nur `/api/team`, `/api/session`, `/api/command`; Server bleibt die Allowlist-Grenze (nur `train`/`retro`-Präfixe; Mehr-Pack-Train bleibt eine einzeilige `/agent-flow:train …`-Zeile). *(alle)*

## Verträge

### Genutzte Endpunkte (alle bestehend — keine neuen)
- `GET /api/team` → `{ agents[], skills[], knowledge[] }`. Train-Popup nutzt **nur** `knowledge[]` (je Item: `id`, `name`, `group`).
- `GET /api/session` → `{ state: "ready" | "busy", … }`.
- `POST /api/command` `{ command: string, projectPath?: string }` → `202` / `409` (`session-cap`/busy) / `400`. Ein Aufruf pro Lauf (Parallel = ein Aufruf für den Batch).

### Befehls-Komposition (Client, UX-seitig; Server ist autoritativ)
- Train Queue (je Pack): `"/agent-flow:train" + costFlag + " " + packId`
- Train Parallel (Batch): `"/agent-flow:train" + costFlag + " " + packIds.join(" ")`
- Retro: `"/agent-flow:retro"` (kein Argument, kein Cost-Flag)
- `costFlag` aus `costMode.js`.

### Pack-ID-Mapping (Knowledge-`id` → `/train`-Pack-ID)
Die Knowledge-`id` ist der Pfad unter `knowledge/` ohne `.md` (z.B. `java`, `tailwind`, `frameworks/spring-boot-3`, `build/maven`, `sql-mysql`):
- **Top-Level-Pack** → Pack-ID = `id` unverändert.
- **Unterordner-Pack** (`frameworks/…`, `build/…`, `migration/…`) → Pack-ID = expliziter Pfad-Präfix bzw. `<name>@<major>`-Form gemäß Pack-ID-Resolver (`framework-build-subsystem.md §8`).
> **Contract-Detail (offen):** Umsetzung von `frameworks/spring-boot-3` → `spring-boot@3` beim Bau gegen den Resolver fixieren. **Empfehlung:** Backend liefert pro Knowledge-Item ein optionales `trainPackId`-Feld (eine Quelle der Wahrheit).

## Edge-Cases & Fehlerverhalten

- **Leere Train-Auswahl** → „Weiter" deaktiviert (AC5).
- **„Alle" bei leerer Knowledge-Liste** → „Alle" deaktiviert; Popup zeigt den Leerzustand der Teamsicht.
- **Session busy / `409`** → Queue: Befehl bleibt, Retry nach nächstem `ready`; Retro/Parallel-Batch: Hinweis „Session belegt", kein Verlust.
- **`POST /api/command` `400`** → betroffener Lauf „abgelehnt"; übrige (Queue) laufen weiter.
- **`/api/team` leer / kein Plugin** → Train-Popup zeigt „Kein agent-flow-Plugin gefunden", „Weiter"/„Alle" deaktiviert. (Retro hängt nicht an `/api/team` und bleibt auslösbar.)
- **Parallel gewählt, aber Mehr-Pack-Train nicht verfügbar** → deaktiviert/Hinweis bzw. Rückfall auf Queue (AC7).
- **Esc / Klick außerhalb während laufender Auslösung** → Dialog warnt bzw. schließt erst, wenn keine Sends ausstehen.

## NFRs

- **A11y (WCAG 2.1 AA):** modale Dialoge mit Fokus-Falle/Fokus-Rückgabe, beschriftete Checkboxen/Radios, „Alle"-Master mit korrektem `indeterminate`, sichtbare Fokusringe (kein `outline:none`), `aria-busy`/`aria-live`, Bedeutung nicht nur über Farbe. „Retro starten" als Aktion klar von den Reitern abgesetzt. Konsistent mit `team-view-frontend`, `retro-view-frontend`, `flow-trigger`.
- **Security (Floor):** kein `dangerouslySetInnerHTML`/`innerHTML`; keine Secrets im Bundle; ausschließlich `/api/team`, `/api/session`, `/api/command`; Allowlist/Sanitizing serverseitig (`CommandService`).
- **Parallelität (Hauptrisiko — verschoben nach agent-flow).** „Parallel" bedeutet **parallele Train-Subagenten in der einen Session**, nicht mehrere Sessions. Dev-gui-seitig ist das **billig**: ein einzelner Mehr-Pack-Befehl, ein Job-Lock-Zyklus, kein Session-Pool. Die Voraussetzung liegt **in agent-flow**: `/train` muss **mehrere Pack-IDs** akzeptieren und intern **einen Train-Agenten pro Pack parallel** fahren (je Pack ein eigener PR, wie heute pro Pack ein PR). Heute nimmt `/train` nur **eine** Pack-ID. **Empfehlung:** Queue zuerst voll bauen (läuft mit dem heutigen Single-Pack-Train); „Parallel" freischalten, sobald der Mehr-Pack-Train in agent-flow steht. Bis dahin „Parallel" deaktiviert mit Hinweis. Die agent-flow-Änderung ist mit `train`-Agent/`teamLeader` zu klären.

## Nicht-Ziele

- **Agenten/Skill-Auswahl im Popup.** Entfällt (Retro läuft global).
- **Zielgerichteter Retro pro Agent/Skill.** Würde eine agent-flow-Änderung am retro-Agenten erfordern.
- **Kostenmodus beim Retro.** Retro bleibt eine minimale Ja/Nein-Bestätigung.
- **Mehrere Claude-Sessions / Session-Pool.** Ausdrücklich nicht der Weg für „Parallel" (war v2-Annahme, in v3 verworfen).
- **Schreiben/Mergen von Lern-Karten aus der GUI.** `/train`/`/retro` liefern PR + Gate; Ergebnis read-only im Verbesserungs-Board.
- **Bootstrap-/Sondermodi** (`/train --bootstrap`, `model-tiers`, `/retro --sonar`) — nicht exponiert.

## Offene Fragen

1. **Mehr-Pack-Train in agent-flow** (Voraussetzung für „Parallel"): `/train` um mehrere Pack-IDs + internen Fan-out (ein Subagent/PR pro Pack) erweitern. Eigene Achse/Spec in agent-flow nötig — Owner-Go?
2. **Pack-ID-Ableitung** für Unterordner-Packs im Client vs. neues `trainPackId`-Feld im `/api/team`-Backend (Empfehlung: Backend-Feld).
3. **Phasing „Parallel":** erste Version Queue voll funktionsfähig, „Parallel" deaktiviert mit Tooltip („kommt mit Mehr-Pack-Train") — bestätigen?

## Abhängigkeiten

- **dev-gui:** `client/src/TeamView.jsx` (Train-Button + Popup), `client/src/RetroView.jsx` („Retro starten"-Button + Confirm), `client/src/TriggerPanel.jsx` + `client/src/costMode.js` (Muster Komposition/Cost-Flag/Session-Poll), `src/CommandService.js` + `src/commandRouter.js` (Allowlist — `train`/`retro` erlaubt), `src/AgentFlowReader.js` + `src/teamRouter.js` (`/api/team`, ggf. `trainPackId`).
- **Specs:** [[team-view-frontend]], [[team-view-backend]], [[retro-view-frontend]], [[retro-train-board-local]], [[flow-trigger]].
- **agent-flow:** `agents/train.md` (Mehr-Pack-Fan-out), `agents/retro.md`, Pack-ID-Resolver (`framework-build-subsystem.md §8`).
