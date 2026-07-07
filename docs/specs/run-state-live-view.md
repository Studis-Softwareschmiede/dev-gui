---
id: run-state-live-view
title: Run-State-Live-Anzeige — Feature-Drain-Fortschritt pro Projekt live (SSE, kein Refresh)
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Run-State-Live-Anzeige  (`run-state-live-view`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Die Fabrik-/Board-Ansicht zeigt **live** — ohne manuellen Reload — pro Projekt, welche Features gerade von einem Feature-Drain (`board-feature-drain.sh F-###`, [[feature-aware-drain]]) abgearbeitet werden: aktuelle Story, Fortschritt (z.B. `4/7`), Phase (`dossier`/`story`/`merge`/`rollout`) und der letzte Fehler. Quelle ist der **ephemere Run-State** `board/runs/F-###/state.yaml`, den der Feature-Drain im jeweiligen Projekt-Repo schreibt. Dossier/Notizen müssen **nicht** gerendert werden; `state.yaml` ist das Kernstück.

> **Vertrags-Herkunft (nicht duplizieren):** Das autoritative Schema von `board/runs/F-###/state.yaml` (Feldnamen, Wertebereiche, Phasen-Enum, Schreibzeitpunkte) definiert die **agent-flow-Spec `feature-batch-orchestration` v2** als bindenden Vertrag. Diese Spec beschreibt ausschließlich das **Lesen/Anzeigen** dieser Felder und referenziert das Schema — sie legt es **nicht** neu fest. Weicht der reale `state.yaml`-Aufbau vom hier angenommenen Feldsatz ab, gilt die agent-flow-Spec; die dev-gui-Leseschicht bleibt tolerant (AC2/Edge-Cases).

> **Cross-Repo-Abhängigkeit:** Umsetzbar/end-to-end verifizierbar erst, wenn agent-flow `feature-batch-orchestration` v2 (das Run-State-**Schreiben** nach `board/runs/F-###/`) gelandet ist. Bis dahin baut/prüft dev-gui gegen Fixture-`state.yaml`-Dateien (gemockter Producer); Live-Daten erscheinen erst mit dem realen Schreiber.

## Verhalten

### Run-State-Lesen (Backend, read-only)
1. Der bestehende Multi-Repo-Scan (`BoardAggregator`, `BOARD_ROOTS`) wird um das Verzeichnis `board/runs/` je Projekt-Repo erweitert: für jedes vorhandene `board/runs/F-###/state.yaml` wird der Run-State **read-only** eingelesen und dem Projekt-Index als Liste **aktiver/letzter Feature-Läufe** angehängt. Der Aggregator bleibt **read-only** — kein Schreibpfad in `board/runs/`.
2. Aus `state.yaml` werden mindestens folgende Felder übernommen (Feldnamen gemäß agent-flow `feature-batch-orchestration` v2): Feature-ID (`F-###`, aus dem Ordnernamen ableitbar), **Phase** (`dossier`|`story`|`merge`|`rollout`), **aktuelle Story-ID**, **Fortschritt** `done`/`total`, **Runde**, **Startzeit**, **letzter Fehler**. Fehlende Einzelfelder → `null` (kein Crash), unbekannte Zusatzfelder werden ignoriert (vorwärtskompatibel).
3. Ein defektes/halb-geschriebenes `state.yaml` (YAML-Parse-Fehler, Teil-Schreibzugriff) macht **nur diesen einen** Feature-Lauf unsichtbar (übersprungen, best-effort geloggt, secret-frei) — es zerstört **weder** den restlichen Run-State-Index **noch** den bestehenden Board-Index (Fehlertoleranz analog `areas.yaml`-Lesen).
4. Nach erfolgreichem Feature-Merge dampft der Feature-Drain den Ordner zu einem kompakten **Last-Run-Protokoll** ein (agent-flow). Ein solches Protokoll darf gelesen und als „letzter Lauf" markiert werden (nice-to-have); es ist **kein** aktiver Lauf. Fehlt `board/runs/` ganz → leere Liste, keine Anzeige, kein Fehler.

### Live-Push (SSE — HARTES Owner-AC)
5. **Jede** Schreiboperation des Feature-Drains an `board/runs/F-###/state.yaml` löst **ohne manuellen Refresh** eine Aktualisierung der Anzeige aus — über die **bestehende** SSE-Infrastruktur ([[board-live-sse]]: `BoardEventHub` + `GET /api/board/events` + `boardEventsRouter`). Ein Producer beobachtet `board/runs/` (Muster: `NotificationWatcher`-Snapshot-Diff **oder** der bestehende `fs.watch`-Watcher des `BoardAggregator`) und ruft je betroffenem Projekt genau **ein** `hub.broadcast({ slug })`.
6. Das SSE-Frame bleibt das **schmale Invalidierungs-Signal** `{ slug }` ([[board-live-sse]] AC4) — **keine** Run-State-Voll-Payload über SSE. Das Frontend lädt bei einem Event für das **aktuell angezeigte** Projekt den Run-State über den regulären Ladepfad (AC7) neu.
7. Der Run-State ist über einen **read-only** HTTP-Ladepfad abrufbar: entweder als zusätzliches Feld am bestehenden Projekt-Ladepfad (`GET /api/board/projects/:slug`) **oder** als eigener `GET /api/projects/:slug/runs`. Antwort enthält die Liste der aktiven/letzten Feature-Läufe (Felder aus AC2), secret-/pfad-frei. Hinter dem bestehenden `AccessGuard` (`/api/*`).

### Frontend (Fabrik-/Board-Ansicht)
8. Die Fabrik-/Board-Ansicht zeigt pro Projekt kompakt die **aktiven** Feature-Läufe: Feature-ID, Phase, aktuelle Story, Fortschritt (`done/total`, z.B. „4/7"), und — falls gesetzt — den letzten Fehler. Status/Phase immer **textlich** (nie nur über Farbe). Kein aktiver Lauf → die Anzeige ist leer/unauffällig (kein Platzhalter-Rauschen).
9. Die Anzeige aktualisiert sich über den **bestehenden** `EventSource`-Abonnenten ([[board-live-sse]] AC13–AC17): bei einem SSE-Event für das angezeigte Projekt genau **ein** Re-Fetch über den bestehenden Ladepfad; **kein** Voll-Seiten-Reload, **kein** Dauer-Polling. Der manuelle Refresh bleibt Fallback.
10. Dossier (`dossier.md`) und Notizen (`notes.md`) werden **nicht** gerendert (bewusstes Nicht-Ziel); ein späteres Einsehen ist nice-to-have und **nicht** Teil dieser Spec.

## Acceptance-Kriterien

- **AC1** — `BoardAggregator` (oder eine schmale, read-only Schwester-Leseschicht) liest je Projekt-Repo alle `board/runs/F-###/state.yaml` ein und hängt die aktiven/letzten Feature-Läufe an den Projekt-Index; **read-only** (kein Schreibpfad nach `board/runs/`). Fehlt `board/runs/` → leere Liste, kein Crash. *(1,4)*
- **AC2** — Je Run-State werden mindestens Feature-ID, Phase (`dossier`|`story`|`merge`|`rollout`), aktuelle Story-ID, Fortschritt `done`/`total`, Runde, Startzeit und letzter Fehler übernommen (Feldnamen gemäß agent-flow `feature-batch-orchestration` v2, hier **nicht** neu definiert). Fehlende Einzelfelder → `null`; unbekannte Zusatzfelder werden ignoriert (vorwärtskompatibel). *(2)*
- **AC3** — Fehlertoleranz: ein defektes/halb-geschriebenes `state.yaml` macht nur diesen einen Feature-Lauf unsichtbar (übersprungen, secret-frei geloggt); der restliche Run-State-Index **und** der bestehende Board-Index bleiben intakt (kein Crash, keine `uncaughtException`). *(3)*
- **AC4** (**HARTES Owner-AC**) — **Jede** Schreiboperation des Feature-Drains an `board/runs/F-###/state.yaml` führt **ohne manuellen Refresh** zu einer Aktualisierung der Anzeige: ein Producer beobachtet `board/runs/` und löst je betroffenem Projekt genau **ein** `BoardEventHub.broadcast({ slug })` aus. Die Aktualisierung passiert über die **bestehende** SSE-Infrastruktur ([[board-live-sse]]) — **kein** neuer Auth-/Transport-Weg. *(5)*
- **AC5** — Das SSE-Frame bleibt `data: {"slug":"<slug>"}` ([[board-live-sse]] AC4) — **keine** Run-State-Voll-Payload über SSE. Der Producer feuert **nicht** im Ruhezustand (nur bei tatsächlicher `state.yaml`-Änderung) und **nicht** beim Baseline-/Erst-Scan. *(6)*
- **AC6** — Read-only Ladepfad: der Run-State ist über `GET /api/board/projects/:slug` (zusätzliches Feld) **oder** `GET /api/projects/:slug/runs` abrufbar; Antwort = Liste der Feature-Läufe (Felder aus AC2), hinter `AccessGuard`, secret-/pfad-frei (keine absoluten Host-Pfade, keine Tokens im Response). *(7)*
- **AC7** — Frontend-Anzeige: die Fabrik-/Board-Ansicht zeigt pro Projekt die aktiven Feature-Läufe (Feature-ID, Phase, aktuelle Story, Fortschritt `done/total`, letzter Fehler falls gesetzt); Phase/Status **textlich** (nie nur Farbe). Kein aktiver Lauf → leere/unauffällige Anzeige. *(8)*
- **AC8** — Frontend-Live: die Anzeige aktualisiert sich über den bestehenden `EventSource`-Abonnenten ([[board-live-sse]] AC13–AC17) — bei einem Event für das angezeigte Projekt genau **ein** Re-Fetch über den bestehenden Ladepfad, **kein** Voll-Reload, **kein** Dauer-Polling; manueller Refresh bleibt Fallback. Dossier/Notizen werden **nicht** gerendert. *(9,10)*

## Verträge

### Endpunkte
- `GET /api/board/projects/:slug` **oder** `GET /api/projects/:slug/runs` → `200 { runs: [ { feature: "F-###", phase: "dossier"|"story"|"merge"|"rollout"|null, currentStory: "S-###"|null, done: int|null, total: int|null, round: int|null, startedAt: string|null, lastError: string|null, isLastRun: bool } ] }`. Read-only, hinter `AccessGuard`, secret-/pfad-frei. Feldnamen der Quelle richten sich nach agent-flow `feature-batch-orchestration` v2 (Mapping in der Leseschicht).
- `GET /api/board/events` (bestehend, [[board-live-sse]]) — unverändert; der Run-State-Producer nutzt denselben `BoardEventHub`/dasselbe Frame-Format.

### Datenquelle
- `board/runs/F-###/state.yaml` je Projekt-Repo (ephemer, vom Feature-Drain geschrieben). **Nur gelesen.** Schema = agent-flow `feature-batch-orchestration` v2 (bindend, nicht dupliziert).
- `board/runs/F-###/dossier.md`, `board/runs/F-###/notes.md` — **nicht** Teil dieser Spec (Nicht-Ziel AC-los).

### Wiederverwendung
- `BoardEventHub` (`src/BoardEventHub.js`) + `boardEventsRouter` (`src/boardEventsRouter.js`) + `GET /api/board/events` — SSE-Boundary unverändert; nur ein zusätzlicher Producer-Aufruf.
- `BoardAggregator` (`src/BoardAggregator.js`) — read-only Scan + `fs.watch`-Watcher (`fswatcher-crash-hardening`) als Vorlage/Naht für den `board/runs/`-Scan + Änderungserkennung.
- `NotificationWatcher` (`src/NotificationWatcher.js`) — Snapshot-Diff-Muster als alternative Producer-Naht.
- `AccessGuard` (`/api/*`-Gate) — kein neuer Auth-Header.

## Edge-Cases & Fehlerverhalten
- **`board/runs/` fehlt / leer** → leere Liste, keine Anzeige, kein Fehler (erwarteter Normalzustand ohne laufenden Feature-Drain).
- **Halb-geschriebenes `state.yaml`** (Feature-Drain schreibt gerade) → dieser Lauf in diesem Scan übersprungen; nächster Scan/Event korrigiert (best-effort, kein Crash).
- **Schema-Drift** (agent-flow ändert Feldnamen) → tolerante Leseschicht: fehlende Felder `null`, Anzeige bleibt lauffähig; das autoritative Schema bleibt die agent-flow-Spec.
- **`board/runs/` eines Repos in `.gitignore`** — der ephemere Run-State soll im jeweiligen Projekt-Repo **gitignored** sein (Vorgabe agent-flow-Konzept). Auch dev-gui selbst kann feature-gedraint werden; das Anlegen/Pflegen des `.gitignore`-Eintrags im jeweiligen Repo ist Sache des Feature-Drains/Repo-Setups, **nicht** dieser Leseschicht (die liest nur).
- **SSE-Verbindung tot** → stiller Fallback auf manuellen Refresh ([[board-live-sse]] AC16), keine Fehlermauer.
- **Producer-Fehler** (Watch/Diff wirft) → gefangen, kein Crash des Board-Scans oder des ntfy-Pfads (degradierend).

## NFRs
- **Sicherheit (Floor):** Ladepfad hinter `AccessGuard`; SSE-Frame ausschließlich `{ slug }` (keine Run-State-Inhalte über SSE); **keine** Secrets/Tokens/absoluten Host-Pfade in Response/Log/Stream. Read-only — kein Schreibpfad nach `board/runs/`.
- **Kosten/Last:** kein zusätzliches serverseitiges Dauer-Polling über den bestehenden Watcher-Takt hinaus; UI ohne Dauer-Polling (Event-getrieben).
- **Robustheit:** ein defekter Run-State kippt weder Board-Index noch Server (best-effort, degradierend, `fs.watch`-gehärtet analog `fswatcher-crash-hardening`).

## Nicht-Ziele
- **Kein** Rendern von `dossier.md`/`notes.md` (nur `state.yaml` ist Kernstück).
- **Keine** Run-State-Voll-Payload über SSE (nur `{ slug }`-Invalidierung).
- **Kein** Schreibpfad nach `board/runs/` (rein lesend; das Schreiben ist agent-flow).
- **Keine** eigene Definition des `state.yaml`-Schemas (bindend in agent-flow `feature-batch-orchestration` v2).
- **Keine** Historie/Persistenz vergangener Läufe über das agent-flow-seitige Last-Run-Protokoll hinaus.

## Abhängigkeiten
- **agent-flow `feature-batch-orchestration` v2** (Cross-Repo, bindender `state.yaml`-Vertrag + Run-State-**Schreiben**) — end-to-end erst danach verifizierbar.
- [[feature-aware-drain]] (der dev-gui-seitige Auslöser der Feature-Drains, deren Run-State hier angezeigt wird).
- [[board-live-sse]] (`BoardEventHub`, `GET /api/board/events`, `boardEventsRouter`, `EventSource`-Abonnent — Wiederverwendung, unverändertes Frame-Format).
- [[taktgeber-nachtwaechter]] (`BoardAggregator`-Scan, Fabrik-Statusanzeige-Kontext) · `fswatcher-crash-hardening` (gehärteter `fs.watch`-Watcher als Producer-Naht) · [[push-notifications]] (`NotificationWatcher`-Snapshot-Diff-Muster).
</content>
</invoke>
