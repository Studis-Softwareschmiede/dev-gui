---
id: drain-completion-report
title: Abschlussbericht nach Board-Drain (Nachtwächter + manueller „Board abarbeiten"-Lauf)
status: active
version: 1
---

# Spec: Abschlussbericht nach Board-Drain  (`drain-completion-report`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Nach **jedem abgeschlossenen** Board-Drain — sowohl automatischer Nachtwächter-Lauf ([[taktgeber-nachtwaechter]] / `NightWatchScheduler` → `nightProjectDrain`) als auch manueller „Board abarbeiten"-Lauf ([[headless-manual-drain]] / `POST /api/projects/:slug/drain`) — entsteht ein **Abschlussbericht**, der zeigt, **welche Board-Stories** in diesem Lauf **erledigt** (→ `Done`) bzw. **blockiert** (→ `Blocked`/eskaliert) wurden. Heute liefert `ProjectDrain.drainProject()` nur ein minimales Ergebnis (`reason`, `flowRuns`, `escalated`), und der Nacht-Drain verwirft dieses Ergebnis sogar (`.catch(() => null)` im Scheduler) — es gibt **keine** Liste der abgearbeiteten Stories und **keine** Sichtbarkeit der Nacht-Läufe in der GUI. Diese Spec schließt beides: eine schmale Erweiterung des Drain-Ergebnisses um die erledigten/blockierten Stories, eine **kleine, größenbegrenzte persistente Bericht-Ablage** (letzte 30 Berichte je Projekt, überlebt einen Server-Neustart), einen read-only Endpunkt und die Anzeige in der bestehenden Drain-Status-Fläche (`CockpitView.jsx`).

**Bewusst kein Audit-Log-Reuse.** Der bestehende `AuditStore` (append-only, `GET /api/audit`) dient der revisionssicheren Nachvollziehbarkeit *ausgeführter Befehle* (u. a. Reconcile-Berichte, [[access-and-guardrails]]) — er ist eine flache, unbegrenzte, projekt-übergreifende Liste ohne Rückschnitt. Für Drain-Abschlussberichte ist aber eine harte **Pro-Projekt-Grenze** (letzte 30) ein Kernkriterium; das liesse sich nur mit zusätzlicher Filter-/Parse-Logik in den `AuditStore` zwingen. Eine **eigene, dedizierte Ablage** nach dem etablierten Settings-Store-Muster (`TickerSettingsStore`, `NotificationSettingsStore`: eine JSON-Datei unter `${CRED_STORE_DIR}`, atomarer Schreibzugriff) ist hier einfacher und hält die Pro-Projekt-Grenze nativ ein, ohne den Audit-Trail zu verändern oder zu vermischen.

## Verhalten

### Erledigte/blockierte Stories im Drain-Ergebnis (Backend, ProjectDrain)
1. `ProjectDrain.drainProject()` erfasst über seinen ohnehin vorhandenen Snapshot-Mechanismus (`computeDrainState`, Full-Board-Snapshot je Runde) den **Anfangs-Snapshot** (vor der ersten `/flow`-Runde) und den **End-Snapshot** (nach der letzten Runde) und leitet daraus ab:
   - **`completed`** — Stories, die von einem beliebigen Nicht-`Done`-Status (`To Do`/`In Progress`) nach **`Done`** übergegangen sind.
   - **`blocked`** — Stories, die nach **`Blocked`** übergegangen sind (Obermenge der bereits gelieferten `escalated`-Liste: Eskalationen durch den Taktgeber **plus** durch `/flow` selbst gesetzte `Blocked`).
   Je Eintrag: `{ id, title }` — `title` aus dem End-Snapshot-Board-Eintrag (`BoardAggregator`-Story), sonst leer. **Keine** Pfade/Secrets.
2. Das Ergebnis von `drainProject()` wird um `completed` und `blocked` erweitert; die **bestehenden** Felder (`stopped`, `reason`, `flowRuns`, `escalated`) bleiben **unverändert** (kein Regress an [[taktgeber-nachtwaechter]] / [[headless-parallel-drain]] / [[headless-manual-drain]]). Ist kein Board-Scan möglich (`scan-failed`) oder lief keine Runde (`flowRuns == 0`), sind `completed`/`blocked` **leere** Listen (kein Fehler).

### Bericht-Ablage (Backend, persistiert, größenbegrenzt)
3. Ein **`DrainReportStore`** (Muster [[headless-parallel-drain]]/Settings-Stores: eigene Datei `${CRED_STORE_DIR}/drain-reports.json`, atomarer Schreibzugriff — tmp+rename, analog `TickerSettingsStore`) hält je Drain-Abschluss **einen** Bericht: `{ reportId, project, trigger, startedAt, finishedAt, reason, flowRuns, completed, blocked }`. `trigger` ∈ `{ 'night', 'manual' }`. `project` = Projekt-**Slug** (kein absoluter Pfad). Der Store hält je Projekt die **letzten 30** Berichte (harte Grenze, älteste fallen beim Schreiben automatisch heraus — `slice(-30)` vor dem atomaren Schreiben). Persistiert ⇒ überlebt einen Server-Neustart; die feste Pro-Projekt-Grenze hält die Datei dauerhaft klein (wenige KB, unabhängig von der Projektzahl oder Laufzeit der Fabrik).
4. **Beide Auslöser schreiben** bei Abschluss genau einen Bericht in dieselbe Store-Instanz:
   - **Manueller Drain:** der bestehende `.then((result) => …)`-Pfad im `projectDrainRouter` schreibt zusätzlich zum `DrainJobRegistry`-Status auch einen `DrainReportStore`-Bericht (`trigger:'manual'`).
   - **Nacht-Drain:** der `NightWatchScheduler` verwirft das Drain-Ergebnis heute (`.catch(() => null)`); statt dessen wird das (erfolgreiche wie fehlgeschlagene) Ergebnis je Drain **erfasst** und als Bericht (`trigger:'night'`) geschrieben — ein Drain-Fehler darf den Scheduler weiterhin **nicht** crashen (best-effort, degradierend).
5. **`GET /api/drain-reports`** liefert die Berichte **read-only**, absteigend nach `finishedAt` (jüngster zuerst), optional per `?project=<slug>` gefiltert. Hinter dem bestehenden AccessGuard auf `/api/*`. **Keine** Secrets/Pfade in der Response.

### Anzeige (Frontend, CockpitView)
6. Die **manuelle** Drain-Status-Anzeige (CockpitView, inline neben dem „Board abarbeiten"-Knopf, [[headless-manual-drain]] AC6) wird bei `done` um eine **kompakte Bericht-Ansicht** ergänzt: „**X erledigt / Y blockiert**" plus eine aufklappbare Liste der erledigten/blockierten Story-IDs (+ Titel). Der bestehende „läuft / fertig / fehlgeschlagen"-Status bleibt.
7. Eine **Nacht-Läufe-Sektion** in der Fabrik-/Cockpit-Übersicht (bei der bestehenden Nachtwächter-Statusanzeige, [[taktgeber-nachtwaechter]] AC17 / `NightWatchStatusBadge`) zeigt die letzten Drain-Abschlussberichte (aus `GET /api/drain-reports`): je Bericht Projekt, Zeitpunkt, `X erledigt / Y blockiert`, aufklappbare Story-Liste. So sieht der Owner morgens, **was nachts erledigt wurde**. Status/Zahlen immer **textlich** (nicht nur über Farbe).

## Acceptance-Kriterien

- **AC1** — `ProjectDrain.drainProject()` liefert im Ergebnis zusätzlich `completed: [{id,title}]` (Stories, die während des Drains nach `Done` übergingen) und `blocked: [{id,title}]` (Stories, die nach `Blocked` übergingen — Obermenge von `escalated`), abgeleitet aus dem Anfangs-/End-Snapshot. Die bestehenden Felder (`stopped`, `reason`, `flowRuns`, `escalated`) bleiben **unverändert** — kein Regress an bestehenden ProjectDrain-Tests. Kein Pfad/Secret in `title`. *(1,2)*
- **AC2** — Randfälle: `flowRuns == 0` (sofortige Konvergenz), `reason == 'scan-failed'`, `reason == 'command-channel-busy'` oder ein Projekt ohne Board → `completed`/`blocked` sind **leere Listen** (kein Crash, kein Fehler). Eine Story, die während des Drains `To Do → In Progress` (aber **nicht** `Done`) wechselt, erscheint **weder** in `completed` **noch** in `blocked`. *(1,2)*
- **AC3** — `DrainReportStore` (persistiert unter `${CRED_STORE_DIR}/drain-reports.json`, atomarer Schreibzugriff): `record({project, trigger, startedAt, finishedAt, reason, flowRuns, completed, blocked})` legt einen Bericht mit generierter `reportId` an, schreibt die Datei atomar (tmp+rename) und hält je Projekt **höchstens 30** Berichte (älteste fallen beim Schreiben automatisch heraus); `list({project?})` liefert die Berichte absteigend nach `finishedAt`. `trigger` ∈ `{night,manual}`, `project` ist ein **Slug** (kein absoluter Pfad). Berichte überstehen einen Server-Neustart. *(3)*
- **AC4** — `GET /api/drain-reports` → `200 { reports: [ {reportId, project, trigger, startedAt, finishedAt, reason, flowRuns, completed, blocked} ] }`, absteigend nach `finishedAt`; optional `?project=<slug>` filtert (ungültiger/traversierender Slug → leere Liste oder `400`, **kein** Dateizugriff). Read-only, hinter AccessGuard, **keine** Secrets/absoluten Pfade in der Response. *(5)*
- **AC5** — Der **manuelle** Drain schreibt bei `done` **genau einen** Bericht (`trigger:'manual'`) in die geteilte `DrainReportStore`-Instanz (zusätzlich zum bestehenden `DrainJobRegistry`-Status, den er unverändert weiter setzt). Ein fehlgeschlagener manueller Drain schreibt **keinen** oder einen als `reason` gekennzeichneten Bericht (Implementierungswahl), **ohne** Roh-Fehlertext/Secret. *(4)*
- **AC6** — Der **Nacht-Drain** schreibt je abgeschlossenem Drain **genau einen** Bericht (`trigger:'night'`) in dieselbe Store-Instanz; ein Drain-Fehler crasht den `NightWatchScheduler` **nicht** (best-effort/degradierend, wie heute). Der frühere `.catch(() => null)`-Ergebnisverlust ist damit geschlossen — das Ergebnis wird erfasst statt verworfen. *(4)*
- **AC7** — Frontend (`CockpitView.jsx`): (a) die manuelle Inline-Status-Fläche zeigt bei `done` „**X erledigt / Y blockiert**" + aufklappbare Story-Liste (ID + Titel); (b) eine Nacht-Läufe-Sektion listet die Berichte aus `GET /api/drain-reports` (Projekt, Zeitpunkt, X/Y, aufklappbare Story-Liste). Zahlen/Status **textlich**, nicht nur farblich; leere Liste dezent. Der bestehende Inline-Status (läuft/fertig/fehlgeschlagen) und das Board-Re-Fetch-Verhalten ([[headless-manual-drain]] AC6) bleiben unverändert. *(6,7)*

## Verträge

### Endpunkte
- `GET /api/drain-reports[?project=<slug>]` → `200 { reports: [...] }` (absteigend nach `finishedAt`); read-only, hinter AccessGuard. Bericht-Schema: `{ reportId, project, trigger:'night'|'manual', startedAt, finishedAt, reason, flowRuns, completed:[{id,title}], blocked:[{id,title}] }`. Secret-/pfad-frei.

### Boundaries / Wiederverwendung
- `ProjectDrain` (`src/ProjectDrain.js`) — `#runLoop` hält bereits je Runde `computeDrainState().snapshot`; der Anfangs-/End-Snapshot-Diff für `completed`/`blocked` ist eine schmale Erweiterung des Rückgabewerts. Story-Titel aus dem `BoardAggregator`-Story-Objekt des End-Scans (`#findProject`).
- `DrainReportStore` (neu, `src/DrainReportStore.js`) — eigene Datei `${CRED_STORE_DIR}/drain-reports.json`, atomarer Schreibzugriff (tmp+rename), Muster `TickerSettingsStore`/`NotificationSettingsStore` (`src/TickerSettingsStore.js`); Rückschnitt auf die letzten 30 Berichte je Projekt bei jedem `record()`. Bewusst **kein** Reuse des `AuditStore` (`src/AuditStore.js`) — der ist eine flache, unbegrenzte, projekt-übergreifende Befehls-Historie (Reconcile/Command-Nachvollziehbarkeit) ohne Pro-Projekt-Rückschnitt.
- `projectDrainRouter` (`src/projectDrainRouter.js`) — der bestehende `.then(result)`-Pfad schreibt zusätzlich den Bericht (injizierte `drainReportStore`).
- `NightWatchScheduler` (`src/NightWatchScheduler.js`) — `#startDrain` erfasst das Drain-Ergebnis (statt `.catch(() => null)` zu verwerfen) und schreibt den Bericht (injizierte `drainReportStore`, best-effort).
- Neuer thin Router `src/routers/drainReports.js` (Muster `src/routers/ticker.js`, `create(deps)` + `order`) für `GET /api/drain-reports`; Verdrahtung in `server.js`.

## Edge-Cases & Fehlerverhalten
- **`flowRuns == 0` / sofortige Konvergenz** → leerer Bericht (0 erledigt / 0 blockiert), trotzdem geschrieben (Owner sieht „nichts zu tun").
- **Drain rejected (Fehler)** → Nacht: Bericht best-effort mit `reason` (kein Roh-Fehlertext); manuell: `DrainJobRegistry` bleibt `failed`, Bericht optional/gekennzeichnet.
- **Story ohne Titel im End-Snapshot** → `title: ''` (kein Crash).
- **Server-Neustart** → Berichte bleiben erhalten (persistiert unter `${CRED_STORE_DIR}/drain-reports.json`); die letzten 30 je Projekt sind nach dem Neustart weiter abrufbar.
- **`?project` mit Traversal/ungültigen Zeichen** → keine Dateiwirkung (Slug ist reiner Filter-Schlüssel auf den bereits geladenen Store-Inhalt, kein direkter Dateizugriff pro Request); leere Liste oder `400`.
- **Gleichzeitiges Schreiben (Nacht- und manueller Drain fast zeitgleich)** → atomares Schreiben (tmp+rename, Muster `TickerSettingsStore`) verhindert eine korrupte Datei; im ungünstigsten Fall „letzter Schreiber gewinnt" bei exakt gleichzeitigen Writes (kein Datenverlust der Board-Stories selbst, nur ein theoretisch verzögerter Bericht-Eintrag).

## NFRs
- **Sicherheit (Floor):** read-only Endpunkt hinter AccessGuard; **keine** absoluten Host-Pfade, Tokens oder Roh-Fehlertexte in Store/Response/Log (nur Slug + Story-ID/Titel + Zähler); Story-Titel stammen aus dem Board (kein Freitext-Injection-Sink im Backend, Frontend rendert sicher).
- **Robustheit:** die Bericht-Erfassung darf **weder** `ProjectDrain` **noch** `NightWatchScheduler` **noch** den manuellen Drain crashen (best-effort, degradierend). Ein Store-/Schreibfehler ist non-fatal.
- **ADR-005-Linie:** die Bericht-Ablage ist eine **Betreiber-nahe, größenbegrenzte Beobachtbarkeits-Ablage** (analog `TickerSettingsStore`/`NotificationSettingsStore` unter `${CRED_STORE_DIR}`, ADR-007-Re-Scoping-Linie), **kein** Fabrik-/Domänen-State — Source of Truth für Board/Story-Status bleiben GitHub/`board/`. Die feste Pro-Projekt-Grenze (30) hält den Footprint dauerhaft klein.

## Nicht-Ziele
- **Keine** unbegrenzte Bericht-Historie — feste Grenze von 30 Berichten je Projekt, ältere werden beim Schreiben automatisch verworfen.
- **Keine** Änderung der Drain-/Abbruch-/Eskalations-Logik selbst (nur additive Ergebnis-Erfassung).
- **Keine** neue Autorisierung/Secrets.
- **Kein** Ersatz für das Audit-Log — der Bericht ist die **kompakte, GUI-nahe** Sicht, nicht die revisionssichere Befehls-Spur ([[access-and-guardrails]]).

## Abhängigkeiten
- [[taktgeber-nachtwaechter]] (`ProjectDrain`-Engine, `NightWatchScheduler`, Nacht-Läufe, Statusanzeige AC17) · [[headless-manual-drain]] (`projectDrainRouter`, `DrainJobRegistry`-Muster, manueller Drain-Status) · [[headless-parallel-drain]] (Nacht-Drain-Ergebnis) · `BoardAggregator` (Story-Titel/Status) · [[access-and-guardrails]] (AccessGuard).
- Der Abschlussbericht ist die **gemeinsame Datenquelle** für den Auto-Retro-Auslöser ([[retro-auto-trigger]]) — dessen „Drain abgeschlossen"-Hook nutzt denselben Abschlusspunkt (dieselbe Naht in `NightWatchScheduler`/`projectDrainRouter`).
