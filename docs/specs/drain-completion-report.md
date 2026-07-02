---
id: drain-completion-report
title: Abschlussbericht nach Board-Drain (Nachtwächter + manueller „Board abarbeiten"-Lauf)
status: draft
version: 1
---

# Spec: Abschlussbericht nach Board-Drain  (`drain-completion-report`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Nach **jedem abgeschlossenen** Board-Drain — sowohl automatischer Nachtwächter-Lauf ([[taktgeber-nachtwaechter]] / `NightWatchScheduler` → `nightProjectDrain`) als auch manueller „Board abarbeiten"-Lauf ([[headless-manual-drain]] / `POST /api/projects/:slug/drain`) — entsteht ein **Abschlussbericht**, der zeigt, **welche Board-Stories** in diesem Lauf **erledigt** (→ `Done`) bzw. **blockiert** (→ `Blocked`/eskaliert) wurden. Heute liefert `ProjectDrain.drainProject()` nur ein minimales Ergebnis (`reason`, `flowRuns`, `escalated`), und der Nacht-Drain verwirft dieses Ergebnis sogar (`.catch(() => null)` im Scheduler) — es gibt **keine** Liste der abgearbeiteten Stories und **keine** Sichtbarkeit der Nacht-Läufe in der GUI. Diese Spec schließt beides: eine schmale Erweiterung des Drain-Ergebnisses um die erledigten/blockierten Stories, eine **In-Memory-Bericht-Registry** (ADR-005-konform, kein Store), einen read-only Endpunkt und die Anzeige in der bestehenden Drain-Status-Fläche (`CockpitView.jsx`).

## Verhalten

### Erledigte/blockierte Stories im Drain-Ergebnis (Backend, ProjectDrain)
1. `ProjectDrain.drainProject()` erfasst über seinen ohnehin vorhandenen Snapshot-Mechanismus (`computeDrainState`, Full-Board-Snapshot je Runde) den **Anfangs-Snapshot** (vor der ersten `/flow`-Runde) und den **End-Snapshot** (nach der letzten Runde) und leitet daraus ab:
   - **`completed`** — Stories, die von einem beliebigen Nicht-`Done`-Status (`To Do`/`In Progress`) nach **`Done`** übergegangen sind.
   - **`blocked`** — Stories, die nach **`Blocked`** übergegangen sind (Obermenge der bereits gelieferten `escalated`-Liste: Eskalationen durch den Taktgeber **plus** durch `/flow` selbst gesetzte `Blocked`).
   Je Eintrag: `{ id, title }` — `title` aus dem End-Snapshot-Board-Eintrag (`BoardAggregator`-Story), sonst leer. **Keine** Pfade/Secrets.
2. Das Ergebnis von `drainProject()` wird um `completed` und `blocked` erweitert; die **bestehenden** Felder (`stopped`, `reason`, `flowRuns`, `escalated`) bleiben **unverändert** (kein Regress an [[taktgeber-nachtwaechter]] / [[headless-parallel-drain]] / [[headless-manual-drain]]). Ist kein Board-Scan möglich (`scan-failed`) oder lief keine Runde (`flowRuns == 0`), sind `completed`/`blocked` **leere** Listen (kein Fehler).

### Bericht-Registry (Backend, In-Memory)
3. Eine **`DrainReportRegistry`** (In-Memory, Muster [[headless-manual-drain]] `DrainJobRegistry`) hält je Drain-Abschluss **einen** Bericht: `{ reportId, project, trigger, startedAt, finishedAt, reason, flowRuns, completed, blocked }`. `trigger` ∈ `{ 'night', 'manual' }`. `project` = Projekt-**Slug** (kein absoluter Pfad). Die Registry hält je Projekt die **letzten N** Berichte (Ringpuffer, Default N=10) — ältere fallen heraus. In-Memory ⇒ Verlust bei Server-Neustart ist **Nicht-Ziel** (akzeptiert, konsistent mit `DrainJobRegistry`).
4. **Beide Auslöser schreiben** bei Abschluss genau einen Bericht in dieselbe Registry-Instanz:
   - **Manueller Drain:** der bestehende `.then((result) => …)`-Pfad im `projectDrainRouter` schreibt zusätzlich zum `DrainJobRegistry`-Status auch einen `DrainReportRegistry`-Bericht (`trigger:'manual'`).
   - **Nacht-Drain:** der `NightWatchScheduler` verwirft das Drain-Ergebnis heute (`.catch(() => null)`); statt dessen wird das (erfolgreiche wie fehlgeschlagene) Ergebnis je Drain **erfasst** und als Bericht (`trigger:'night'`) geschrieben — ein Drain-Fehler darf den Scheduler weiterhin **nicht** crashen (best-effort, degradierend).
5. **`GET /api/drain-reports`** liefert die Berichte **read-only**, absteigend nach `finishedAt` (jüngster zuerst), optional per `?project=<slug>` gefiltert. Hinter dem bestehenden AccessGuard auf `/api/*`. **Keine** Secrets/Pfade in der Response.

### Anzeige (Frontend, CockpitView)
6. Die **manuelle** Drain-Status-Anzeige (CockpitView, inline neben dem „Board abarbeiten"-Knopf, [[headless-manual-drain]] AC6) wird bei `done` um eine **kompakte Bericht-Ansicht** ergänzt: „**X erledigt / Y blockiert**" plus eine aufklappbare Liste der erledigten/blockierten Story-IDs (+ Titel). Der bestehende „läuft / fertig / fehlgeschlagen"-Status bleibt.
7. Eine **Nacht-Läufe-Sektion** in der Fabrik-/Cockpit-Übersicht (bei der bestehenden Nachtwächter-Statusanzeige, [[taktgeber-nachtwaechter]] AC17 / `NightWatchStatusBadge`) zeigt die letzten Drain-Abschlussberichte (aus `GET /api/drain-reports`): je Bericht Projekt, Zeitpunkt, `X erledigt / Y blockiert`, aufklappbare Story-Liste. So sieht der Owner morgens, **was nachts erledigt wurde**. Status/Zahlen immer **textlich** (nicht nur über Farbe).

## Acceptance-Kriterien

- **AC1** — `ProjectDrain.drainProject()` liefert im Ergebnis zusätzlich `completed: [{id,title}]` (Stories, die während des Drains nach `Done` übergingen) und `blocked: [{id,title}]` (Stories, die nach `Blocked` übergingen — Obermenge von `escalated`), abgeleitet aus dem Anfangs-/End-Snapshot. Die bestehenden Felder (`stopped`, `reason`, `flowRuns`, `escalated`) bleiben **unverändert** — kein Regress an bestehenden ProjectDrain-Tests. Kein Pfad/Secret in `title`. *(1,2)*
- **AC2** — Randfälle: `flowRuns == 0` (sofortige Konvergenz), `reason == 'scan-failed'`, `reason == 'command-channel-busy'` oder ein Projekt ohne Board → `completed`/`blocked` sind **leere Listen** (kein Crash, kein Fehler). Eine Story, die während des Drains `To Do → In Progress` (aber **nicht** `Done`) wechselt, erscheint **weder** in `completed` **noch** in `blocked`. *(1,2)*
- **AC3** — `DrainReportRegistry` (In-Memory): `record({project, trigger, startedAt, finishedAt, reason, flowRuns, completed, blocked})` legt einen Bericht mit generierter `reportId` an; je Projekt werden höchstens **N** Berichte (Default 10, Ringpuffer) gehalten; `list({project?})` liefert die Berichte absteigend nach `finishedAt`. `trigger` ∈ `{night,manual}`, `project` ist ein **Slug** (kein absoluter Pfad). *(3)*
- **AC4** — `GET /api/drain-reports` → `200 { reports: [ {reportId, project, trigger, startedAt, finishedAt, reason, flowRuns, completed, blocked} ] }`, absteigend nach `finishedAt`; optional `?project=<slug>` filtert (ungültiger/traversierender Slug → leere Liste oder `400`, **kein** Dateizugriff). Read-only, hinter AccessGuard, **keine** Secrets/absoluten Pfade in der Response. *(5)*
- **AC5** — Der **manuelle** Drain schreibt bei `done` **genau einen** Bericht (`trigger:'manual'`) in die geteilte `DrainReportRegistry`-Instanz (zusätzlich zum bestehenden `DrainJobRegistry`-Status, den er unverändert weiter setzt). Ein fehlgeschlagener manueller Drain schreibt **keinen** oder einen als `reason` gekennzeichneten Bericht (Implementierungswahl), **ohne** Roh-Fehlertext/Secret. *(4)*
- **AC6** — Der **Nacht-Drain** schreibt je abgeschlossenem Drain **genau einen** Bericht (`trigger:'night'`) in dieselbe Registry-Instanz; ein Drain-Fehler crasht den `NightWatchScheduler` **nicht** (best-effort/degradierend, wie heute). Der frühere `.catch(() => null)`-Ergebnisverlust ist damit geschlossen — das Ergebnis wird erfasst statt verworfen. *(4)*
- **AC7** — Frontend (`CockpitView.jsx`): (a) die manuelle Inline-Status-Fläche zeigt bei `done` „**X erledigt / Y blockiert**" + aufklappbare Story-Liste (ID + Titel); (b) eine Nacht-Läufe-Sektion listet die Berichte aus `GET /api/drain-reports` (Projekt, Zeitpunkt, X/Y, aufklappbare Story-Liste). Zahlen/Status **textlich**, nicht nur farblich; leere Liste dezent. Der bestehende Inline-Status (läuft/fertig/fehlgeschlagen) und das Board-Re-Fetch-Verhalten ([[headless-manual-drain]] AC6) bleiben unverändert. *(6,7)*

## Verträge

### Endpunkte
- `GET /api/drain-reports[?project=<slug>]` → `200 { reports: [...] }` (absteigend nach `finishedAt`); read-only, hinter AccessGuard. Bericht-Schema: `{ reportId, project, trigger:'night'|'manual', startedAt, finishedAt, reason, flowRuns, completed:[{id,title}], blocked:[{id,title}] }`. Secret-/pfad-frei.

### Boundaries / Wiederverwendung
- `ProjectDrain` (`src/ProjectDrain.js`) — `#runLoop` hält bereits je Runde `computeDrainState().snapshot`; der Anfangs-/End-Snapshot-Diff für `completed`/`blocked` ist eine schmale Erweiterung des Rückgabewerts. Story-Titel aus dem `BoardAggregator`-Story-Objekt des End-Scans (`#findProject`).
- `DrainReportRegistry` (neu, `src/DrainReportRegistry.js`) — In-Memory Ringpuffer je Projekt, Muster `DrainJobRegistry` (`src/DrainJobRegistry.js`).
- `projectDrainRouter` (`src/projectDrainRouter.js`) — der bestehende `.then(result)`-Pfad schreibt zusätzlich den Bericht (injizierte `drainReportRegistry`).
- `NightWatchScheduler` (`src/NightWatchScheduler.js`) — `#startDrain` erfasst das Drain-Ergebnis (statt `.catch(() => null)` zu verwerfen) und schreibt den Bericht (injizierte `drainReportRegistry`, best-effort).
- Neuer thin Router `src/routers/drainReports.js` (Muster `src/routers/ticker.js`, `create(deps)` + `order`) für `GET /api/drain-reports`; Verdrahtung in `server.js`.

## Edge-Cases & Fehlerverhalten
- **`flowRuns == 0` / sofortige Konvergenz** → leerer Bericht (0 erledigt / 0 blockiert), trotzdem geschrieben (Owner sieht „nichts zu tun").
- **Drain rejected (Fehler)** → Nacht: Bericht best-effort mit `reason` (kein Roh-Fehlertext); manuell: `DrainJobRegistry` bleibt `failed`, Bericht optional/gekennzeichnet.
- **Story ohne Titel im End-Snapshot** → `title: ''` (kein Crash).
- **Server-Neustart** → In-Memory-Registry verloren (Nicht-Ziel), unbekannte `reportId`/leere Liste.
- **`?project` mit Traversal/ungültigen Zeichen** → keine Dateiwirkung (Registry ist In-Memory, Slug ist reiner Filter-Schlüssel); leere Liste oder `400`.

## NFRs
- **Sicherheit (Floor):** read-only Endpunkt hinter AccessGuard; **keine** absoluten Host-Pfade, Tokens oder Roh-Fehlertexte in Registry/Response/Log (nur Slug + Story-ID/Titel + Zähler); Story-Titel stammen aus dem Board (kein Freitext-Injection-Sink im Backend, Frontend rendert sicher).
- **Robustheit:** die Bericht-Erfassung darf **weder** `ProjectDrain` **noch** `NightWatchScheduler` **noch** den manuellen Drain crashen (best-effort, degradierend). Ein Registry-/Schreibfehler ist non-fatal.
- **ADR-005-Linie:** kein persistenter Store — In-Memory-Registry (live), konsistent mit `DrainJobRegistry`. (Audit bleibt die persistente Spur, [[taktgeber-nachtwaechter]] AC18 / [[headless-parallel-drain]] AC11 — unverändert.)

## Nicht-Ziele
- **Keine** persistente Bericht-Historie (In-Memory, geht bei Neustart verloren; Audit bleibt die dauerhafte Spur).
- **Keine** Änderung der Drain-/Abbruch-/Eskalations-Logik selbst (nur additive Ergebnis-Erfassung).
- **Keine** neue Autorisierung/Secrets.
- **Kein** Ersatz für das Audit-Log — der Bericht ist die **kompakte, GUI-nahe** Sicht, nicht die revisionssichere Spur.

## Abhängigkeiten
- [[taktgeber-nachtwaechter]] (`ProjectDrain`-Engine, `NightWatchScheduler`, Nacht-Läufe, Statusanzeige AC17) · [[headless-manual-drain]] (`projectDrainRouter`, `DrainJobRegistry`-Muster, manueller Drain-Status) · [[headless-parallel-drain]] (Nacht-Drain-Ergebnis) · `BoardAggregator` (Story-Titel/Status) · [[access-and-guardrails]] (AccessGuard).
- Der Abschlussbericht ist die **gemeinsame Datenquelle** für den Auto-Retro-Auslöser ([[retro-auto-trigger]]) — dessen „Drain abgeschlossen"-Hook nutzt denselben Abschlusspunkt (dieselbe Naht in `NightWatchScheduler`/`projectDrainRouter`).
