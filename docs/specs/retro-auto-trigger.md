---
id: retro-auto-trigger
title: Automatischer Retro-Trigger nach Board-Läufen + globaler Ein/Aus-Schalter
status: active
version: 1
---

# Spec: Automatischer Retro-Trigger + Schalter  (`retro-auto-trigger`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der `retro`-Agent ([[retro-view-backend]]-Quelle; agent-flow `/agent-flow:retro`) destilliert projekt-lokale Lessons (`.claude/lessons/*`) in Verbesserungen der **globalen** Knowledge-Packs (PR gegen agent-flow). Heute läuft er **nur manuell per Klick** ([[team-train-trigger]] „Retro starten" in `RetroView.jsx`) und trägt einen **fest codierten Wochen-Cooldown** (Schutzgitter **G3**: max. 1×/Woche/Repo, `agents/retro.md` §3a, `docs/architecture/framework-build-subsystem.md` §9). Bei einem leistungsstarken Abo sind häufigere Retro-Läufe kostenmäßig unkritisch — der Owner will die Fabrik **nach jedem Board-Lauf automatisch dazulernen** lassen, aber die **Wahl behalten**.

Diese Spec führt einen **globalen Ein/Aus-Schalter „Danach automatisch Retro durchführen"** ein (eigener Settings-Store, eigener Router, GET/PUT-API, UI bei den Nachtwächter-Einstellungen). Ist der Schalter **an**, wird nach **jedem abgeschlossenen** Nachtwächter-Lauf **und** nach **jedem abgeschlossenen** manuellen „Board abarbeiten"-Lauf geprüft, ob ein Retro-Lauf **fällig** ist; ist er fällig, wird für das gerade gedrainte Projekt-Repo ein Retro-Lauf **eingereiht** ([[retro-auto-queue]]). Der starre Wochen-Cooldown **G3 entfällt dann** zugunsten dieses Schalters (Auto-Läufe nutzen `--force`). Ist der Schalter **aus**, bleibt das **heutige Verhalten** unverändert: nur manueller Klick, Wochen-Cooldown aktiv.

> **Ausdrücklich unverändert (NICHT anfassen): Qualitätsschwelle G1.** Ein Lesson-Muster muss weiterhin in **≥2 verschiedenen Projekten UND ≥2 verschiedenen Code-Stellen** auftauchen, bevor `retro` es in einen globalen Pack promotet. G1 ist der eigentliche Schutz gegen Fehlgeneralisierung und lebt **im `retro`-Agenten** (agent-flow) — er wird von dieser Spec **nicht** berührt. Nur der **Cooldown G3** (Frequenz) wird bei aktivem Schalter durch `--force` umgangen.

## Verhalten

### Schalter-Persistenz + API (eigener Store, eigener Router)
1. Ein eigener **`RetroAutoSettingsStore`** (Muster [[taktgeber-nachtwaechter]] `TickerSettingsStore` / `NotificationSettingsStore`) persistiert die Konfiguration als nicht-geheimes, atomar geschriebenes JSON unter `${CRED_STORE_DIR}/retro-auto-settings.json` (0600, tmp+rename). Feld: **`enabled`** (bool, Default **`false`** — das heutige Verhalten bleibt Default). **Keine** Secrets.
2. Ein eigener thin Router `src/routers/retroAutoSettings.js` (Muster `src/routers/ticker.js`, `create(deps)` + `order`) stellt bereit:
   - `GET /api/settings/retro-auto` → `200 { enabled }` (oder Default).
   - `PUT /api/settings/retro-auto` `{ enabled }` → `200 { enabled }` | `400 { field, message }` (Validierung: `enabled` muss Boolean sein).
   Beide hinter dem bestehenden AccessGuard auf `/api/*`.

### UI-Schalter (bei den Nachtwächter-Einstellungen)
3. In `NightWatchSettings.jsx` (Settings-Seite, `SettingsView.jsx`) erscheint **bei** den bestehenden Nachtwächter-Einstellungen ein Schalter **„Danach automatisch Retro durchführen"** (an/aus), der `/api/settings/retro-auto` liest/schreibt (Muster wie der bestehende `enabled`-Schalter des Nachtwächters). Ein kurzer Hilfetext macht klar: bei **an** läuft nach jedem Board-Lauf ggf. ein Retro (Wochen-Cooldown wird umgangen); bei **aus** bleibt es beim manuellen Klick. Status **textlich**.

### Fälligkeits-Prüfung + Auslösung (Wiring an der Drain-Abschluss-Naht)
4. **Auslöse-Naht:** an **derselben** Stelle, an der ein Drain abschließt und den Abschlussbericht schreibt ([[drain-completion-report]] — `NightWatchScheduler#startDrain`-Abschluss für Nacht-Läufe, `projectDrainRouter`-`.then(result)` für manuelle Läufe), wird nach dem Abschluss der **Auto-Retro-Check** angestoßen. Er ist **best-effort/fire-and-forget** und darf den Drain-Abschluss, den Scheduler oder die HTTP-Antwort **nie** blockieren oder crashen.
5. **Fälligkeits-Regel (`isRetroDue`).** Ein Retro-Lauf für ein Projekt-Repo ist **fällig**, wenn **alle** gelten:
   - (a) der Schalter ist **an** (`RetroAutoSettingsStore.read().enabled == true`), **und**
   - (b) der abgeschlossene Drain hat **echte Arbeit** geleistet: `flowRuns ≥ 1` (ein Drain, der sofort ohne `/flow`-Runde konvergierte, ist **nicht** fällig — nichts Neues zu destillieren), **und**
   - (c) für **dasselbe** Projekt-Repo ist aktuell **kein** Auto-Retro bereits **eingereiht oder laufend** (Dedup, [[retro-auto-queue]]).
   Ist der Schalter **aus** (a=false), passiert **nichts** (kein Enqueue) — heutiges Verhalten.
6. **Einreihung statt Direktstart.** Ist der Lauf fällig, wird das Projekt-Repo in die **serielle Auto-Retro-Warteschlange** ([[retro-auto-queue]]) eingereiht (`enqueue(projectPath)`) — **nicht** direkt gestartet. Die Queue garantiert die serielle, race-freie Ausführung gegen die geteilte Lern-Ablage. Der eigentliche Retro-Lauf ist ein **headless** `claude -p '/agent-flow:retro --force'`-Lauf für dieses Repo ([[retro-auto-queue]]) — `--force` umgeht bewusst den Cooldown **G3**, der bei aktivem Schalter durch diese Auslöse-Regel ersetzt ist.
7. **Cross-Trigger-Einheitlichkeit.** Nacht- und manueller Auslöser nutzen **denselben** `isRetroDue`-Check und **dieselbe** Queue-Instanz — kein zweiter Codepfad, keine Divergenz. Beim Nacht-Drain werden mehrere Projekte in einer Nacht abgearbeitet; jedes fällige Projekt reiht **genau einen** Retro-Lauf ein (Dedup pro Repo, 5c).

## Acceptance-Kriterien

- **AC1** — `RetroAutoSettingsStore`: `read()` liefert `{ enabled }` (Default `enabled:false`, auch bei fehlender Datei — kein Crash); `write({enabled})` persistiert atomar (tmp+rename, 0600) unter `${CRED_STORE_DIR}/retro-auto-settings.json`; `validate({enabled})` lehnt Nicht-Boolean mit `{ok:false, field:'enabled'}` ab. **Keine** Secrets in der Datei. *(1)*
- **AC2** — `GET /api/settings/retro-auto` → `200 { enabled }`; `PUT /api/settings/retro-auto {enabled}` → `200 { enabled }` (persistiert) | `400 {field,message}` bei ungültigem `enabled`. Beide hinter AccessGuard; **keine** Secrets in der Response. *(2)*
- **AC3** — `NightWatchSettings.jsx` zeigt bei den Nachtwächter-Einstellungen einen Schalter „Danach automatisch Retro durchführen", der `/api/settings/retro-auto` liest (Initialzustand) und bei Änderung per `PUT` schreibt; Status **textlich** (an/aus), kurzer Hilfetext zum Cooldown-Bypass. Der bestehende Nachtwächter-`enabled`-Schalter bleibt unverändert. *(3)*
- **AC4** — Nach **jedem** abgeschlossenen Drain (Nacht **und** manuell) wird der Auto-Retro-Check an der Drain-Abschluss-Naht angestoßen — **best-effort/fire-and-forget**: er blockiert **nie** den Drain-Abschluss, den `NightWatchScheduler`-Tick oder die HTTP-`202`-Antwort und crasht diese **nie** (ein Fehler im Check ist non-fatal). *(4)*
- **AC5** — `isRetroDue(projectPath, drainResult)` liefert `true` **genau dann**, wenn (a) `RetroAutoSettingsStore.read().enabled == true` **und** (b) `drainResult.flowRuns ≥ 1` **und** (c) für dasselbe Repo aktuell kein Auto-Retro eingereiht/laufend ist. Ist (a) false → `false` (kein Enqueue, heutiges Verhalten). Ist (b) false (`flowRuns == 0`) → `false`. *(5)*
- **AC6** — Bei `isRetroDue == true` wird das Projekt-Repo **genau einmal** in die [[retro-auto-queue]] eingereiht (`enqueue`), **nicht** direkt gestartet; der Auto-Retro-Lauf trägt `--force` (G3-Bypass). Bei `isRetroDue == false` erfolgt **kein** Enqueue. Nacht- und manueller Auslöser nutzen **dieselbe** Queue-Instanz und **denselben** Check (kein zweiter Pfad). *(6,7)*
- **AC7** (Schalter aus = heutiges Verhalten) — Bei `enabled == false` löst **kein** Drain-Abschluss (Nacht oder manuell) einen Auto-Retro aus; der manuelle „Retro starten"-Klick ([[team-train-trigger]]) und der Wochen-Cooldown **G3** bleiben **unverändert** wirksam. G1 bleibt in **allen** Fällen unverändert. *(5)*

## Verträge

### Endpunkte
- `GET /api/settings/retro-auto` → `200 { enabled: boolean }`.
- `PUT /api/settings/retro-auto` `{ enabled: boolean }` → `200 { enabled }` | `400 { field, message }`.

### Settings-Schema (`retro-auto-settings.json`)
| Feld | Typ | Default | Validierung |
|---|---|---|---|
| `enabled` | bool | `false` | muss Boolean sein |

### Boundaries / Wiederverwendung
- `RetroAutoSettingsStore` (neu, `src/RetroAutoSettingsStore.js`) — Muster `TickerSettingsStore.js` (`resolveSettingsFilePath`/`read`/`write`/`validate`, atomar, 0600, Merge-mit-Defaults).
- `src/routers/retroAutoSettings.js` (neu) — thin Router, Muster `src/routers/ticker.js` (`create(deps)`, `order`).
- **Auslöse-Naht** = derselbe Drain-Abschlusspunkt wie [[drain-completion-report]]: `NightWatchScheduler#startDrain` (Nacht) + `projectDrainRouter`-`.then(result)` (manuell). Der Check erhält `projectPath` + `drainResult` (`{flowRuns, …}`).
- `isRetroDue` — kleine, reine Prüf-Funktion (Settings-Read + `flowRuns`-Schwelle + Queue-Dedup-Abfrage); injizierbar für Tests.
- Ausführung/Serialisierung: [[retro-auto-queue]] (`RetroAutoQueue.enqueue`).
- Verdrahtung in `server.js` (Composition-Root): Store, Router (auto-load via `routerLoader`), `RetroAutoQueue`-Instanz + Injektion des Checks in `NightWatchScheduler` und `projectDrainRouter`.

## Edge-Cases & Fehlerverhalten
- **`CRED_STORE_DIR` nicht gesetzt** → `write` wirft (wie `TickerSettingsStore`); `read` liefert Default (`enabled:false`).
- **Settings-Datei korrupt/ungültig** → `read` fällt auf Default (`enabled:false`) zurück, kein Crash.
- **`enabled` toggelt während eines laufenden Nacht-Ticks** → best-effort: der Check liest den aktuellen Wert je Drain-Abschluss; keine Transaktionssemantik nötig.
- **Mehrere Projekte schließen quasi-gleichzeitig ab** → jeder fällige Auslöser reiht ein; die Queue serialisiert ([[retro-auto-queue]]); Dedup verhindert Doppel-Enqueue **desselben** Repos.
- **Fehler im Auto-Retro-Check** (Settings-Read-Fehler, Queue nicht verdrahtet) → non-fatal, kein Enqueue, Drain-Abschluss unberührt (AC4).

## NFRs
- **Sicherheit (Floor):** Settings-Datei nicht-geheim, 0600, atomar; **keine** Secrets in Datei/Response/Log. Der Auto-Retro-Lauf selbst läuft headless über [[retro-auto-queue]] (kein API-Key, OAuth-Token-Durchreichung dort) — diese Spec triggert nur.
- **Robustheit:** der Auslöse-Check ist strikt best-effort/degradierend — Fabrik-Kernpfade (Drain, Scheduler, HTTP) bleiben bei jedem Check-Fehler funktionsfähig.
- **Least-surprise:** Default `enabled:false` ⇒ ohne bewusste Aktivierung ändert sich **nichts** gegenüber heute (Cooldown + manueller Klick bleiben).

## Nicht-Ziele
- **Keine** Änderung an G1 (Qualitätsschwelle, agent-flow) — bleibt der Fehlgeneralisierungs-Schutz.
- **Keine** Ausführungs-/Serialisierungslogik hier — die liegt in [[retro-auto-queue]] (Trennung Policy/Mechanismus).
- **Kein** Entfernen des manuellen „Retro starten"-Knopfs oder des Cooldowns bei ausgeschaltetem Schalter.
- **Keine** pro-Projekt-Granularität des Schalters (bewusst **global** — ein Schalter für die ganze Fabrik).
- **Keine** Änderung des `retro`-Agenten selbst außer der bereits vorhandenen `--force`-Nutzung (G3-Bypass existiert bereits in agent-flow).

## Abhängigkeiten
- [[retro-auto-queue]] (serielle Ausführung + headless Retro-Runner — die Auslösung reiht dort ein) · [[drain-completion-report]] (gemeinsame Drain-Abschluss-Naht + `flowRuns`) · [[taktgeber-nachtwaechter]] (`NightWatchScheduler`, Settings-Store-Muster, UI-Sektion) · [[headless-manual-drain]] (`projectDrainRouter`-Abschlusspunkt) · [[team-train-trigger]] (manueller „Retro starten"-Knopf bleibt) · [[access-and-guardrails]] (AccessGuard) · agent-flow `agents/retro.md` (G3 `--force`-Bypass, G1 unverändert).
