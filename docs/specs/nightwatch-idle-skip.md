---
id: nightwatch-idle-skip
title: Nachtwächter-Vorab-Skip — Projekte ohne Drain-Ziel gar nicht erst drainen
status: active
area: nachtwaechter
version: 1
spec_format: use-case-2.0
---

# Spec: Nachtwächter-Vorab-Skip  (`nightwatch-idle-skip`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der `NightWatchScheduler` startet heute je Tick für **jedes** konfigurierte Projekt einen Drain — auch für Projekte, deren Board **kein** abarbeitbares Ziel enthält. Ein solcher Drain endet sofort mit `reason:'no-drain-target'`, `flowRuns:0` und erzeugt (bis [[drain-completion-report]] v2) je Tick einen Leerlauf-Bericht (verifiziert: 30 identische Leermeldungen für `agent-flow`). Diese Spec beseitigt die **Quelle**: der Scheduler prüft **vor** dem Drain-Start je Projekt anhand des **bereits vorhandenen** Board-Scans, ob überhaupt ein Drain-Ziel existiert **oder entstehen kann**; wenn nein → **kein** Drain-Start, **kein** Bericht, nur ein **gedrosselter**, leiser Log/Audit-Vermerk. Die maßgebliche Ziel-Logik `computeDrainState` (aus `ProjectDrain.js`) wird **wiederverwendet** — **kein** zweiter Regel-Satz.

## Verhalten

1. **Vorab-Check je Projekt.** Bevor der `NightWatchScheduler` für ein Projekt einen Drain startet, berechnet er aus dem **bereits vorhandenen** `BoardAggregator`-Scan (kein zusätzlicher, erzwungener Scan) via `computeDrainState(project, now, staleInProgressHours)` das Paar `{ targets, couldBecomeReady }`. Ein Drain wird **nur** gestartet, wenn `targets.length > 0 || couldBecomeReady === true`. Andernfalls: **Skip** — kein `/agent-flow:flow`-Anstoß, kein Drain-Ergebnis, **kein** `DrainReportStore`-Bericht.
2. **`computeDrainState` ist die maßgebliche Ziel-Logik** (`src/ProjectDrain.js`, [[taktgeber-nachtwaechter]] AC1–AC3) und wird hier **nicht** neu definiert: `targets` = ready-`To Do` + verwaistes `In Progress`; `couldBecomeReady` = mindestens ein `To Do`, das durch Fertigstellen eines noch nicht fertigen Vorgängers ready **werden kann**. `Blocked`, `Idee`, `Done`, nicht-ready `To Do` — und (sobald vorhanden) `Waiting` ([[waiting-status-devgui]]) — sind **kein** Ziel und lösen daher **keinen** Drain aus.
3. **Gedrosselter Vermerk.** Ein übersprungenes Projekt erzeugt **nicht** je Tick einen Log/Audit-Eintrag, sondern **gedrosselt**: höchstens beim **Übergang** „hatte Ziel → kein Ziel" bzw. höchstens **einmal je Projekt je Nachtfenster** (konkrete Drosselung = Implementierungswahl, Owner-Vorgabe nur „nicht je Tick"). Der Vermerk ist secret-/pfad-frei (nur Slug + „übersprungen: kein Drain-Ziel"). **Kein** Bericht, **kein** Crash.
4. **Frische-Toleranz (kein stale-Board-Regress).** Der Vorab-Check basiert auf dem **zuletzt vorhandenen** Aggregator-Scan — derselben Quelle, aus der `ProjectDrain` heute ohnehin sein `no-drain-target` ableitet. Es wird **kein** neues Stale-Risiko eingeführt: ein fälschlich übersprungenes Projekt (Scan zeigt das neue Ziel noch nicht) wird im **nächsten** Tick automatisch wieder gedraint, sobald der Scan das Ziel sieht — der Skip **heilt sich selbst** (konservative, dokumentierte Annahme). Es ist **nicht** nötig, für den Check synchron neu zu scannen.
5. **Manueller Drain-Knopf unberührt.** Der Vorab-Skip greift **ausschließlich** im `NightWatchScheduler`. Der manuelle „Board abarbeiten"-Drain ([[headless-manual-drain]] / `POST /api/projects/:slug/drain`) startet weiterhin **bedingungslos** und darf ehrlich „nichts zu tun" (`no-drain-target`) melden/berichten — bewusster Owner-Klick.

## Acceptance-Kriterien

- **AC1** — Der `NightWatchScheduler` startet für ein Projekt **nur dann** einen Drain, wenn `computeDrainState` (aus dem vorhandenen `BoardAggregator`-Scan) `targets.length > 0 || couldBecomeReady === true` liefert. Trifft keines zu → **kein** Drain-Start, **kein** `/agent-flow:flow`-Anstoß, **kein** `DrainReportStore`-Bericht. `computeDrainState` (`ProjectDrain.js`) ist die maßgebliche Ziel-Logik — kein zweiter Regel-Satz; die Nicht-Ziele aus [[taktgeber-nachtwaechter]] AC1/AC3 gelten unverändert. *(1,2)*
- **AC2** — Ein übersprungenes Projekt erzeugt einen **leisen, gedrosselten** Log/Audit-Vermerk (nicht je Tick — höchstens beim Übergang „Ziel → kein Ziel" bzw. höchstens einmal je Projekt je Nachtfenster), secret-/pfad-frei, **kein** Bericht, **kein** Crash. Ein Fehler im Vorab-Check kippt den Tick nicht (degradierend, analog bestehender Tick-Robustheit). *(3)*
- **AC3** — **Frische-Toleranz:** der Vorab-Check nutzt den zuletzt vorhandenen Aggregator-Scan (kein erzwungener Extra-Scan); ein fälschlich übersprungenes Projekt wird im nächsten Tick automatisch wieder gedraint, sobald der Scan ein Ziel zeigt (Selbstheilung). Kein stale-Board-Regress gegenüber dem heutigen Verhalten (`ProjectDrain` liest denselben Board-Stand). *(4)*
- **AC4** — Der Vorab-Skip greift **ausschließlich** im `NightWatchScheduler`; der manuelle „Board abarbeiten"-Drain startet weiterhin bedingungslos und darf ehrlich „nichts zu tun" (`no-drain-target`) melden/berichten. Kein Regress an [[headless-manual-drain]] AC1–AC8. *(5)*

## Verträge

### Wiederverwendung (keine neuen Endpunkte)
- `computeDrainState(project, nowMs, staleInProgressHours) → { targets, couldBecomeReady, snapshot }` (`src/ProjectDrain.js`) — **unverändert** wiederverwendet; der Scheduler ruft sie mit dem Projekt-Eintrag aus dem bestehenden `BoardAggregator.getIndex()`-Scan und entscheidet `start ⇔ targets.length>0 || couldBecomeReady`.
- `BoardAggregator.getIndex()` (`src/BoardAggregator.js`) — read-only Board-Scan, bereits vorhanden; **keine** zusätzliche Scan-Last für den Check.
- `NightWatchScheduler` (`src/NightWatchScheduler.js`) — der Tick-/Projekt-Auswahl-Pfad ruft den Vorab-Check **vor** `#startDrain`; die übrige Nacht-Logik (Fenster/`maxParallel`/`enabled`, [[taktgeber-nachtwaechter]] AC9–AC16) bleibt unverändert.
- `AuditStore` (`src/AuditStore.js`) / Logger — Ziel des gedrosselten Vermerks (AC2).

## Edge-Cases & Fehlerverhalten
- **Board-Scan für ein Projekt fehlgeschlagen / Projekt-Eintrag `null`** → wie ein leeres Board behandeln (kein Ziel ⇒ Skip), **kein** Crash; im nächsten Tick heilt ein transienter Scan-Fehler selbst (AC3). Verhält sich damit konsistent zum bestehenden `scan-failed`-Pfad, ohne einen Leerlauf-Bericht zu erzeugen.
- **Projekt bereits busy (Lock/Session)** → die bestehende Busy-Erkennung ([[taktgeber-nachtwaechter]] AC7) greift **vor** oder **zusätzlich** zum Vorab-Check; kein Doppel-Trigger. Der Vorab-Skip ersetzt die Busy-Erkennung nicht.
- **`couldBecomeReady === true`, aber `targets` leer** (nachgelagertes `To Do` wartet auf noch nicht fertigen Vorgänger) → Drain **wird** gestartet (das Ziel kann in der Session ready werden) — unverändert zur heutigen Konvergenz-Regel.
- **Übergang „Ziel → kein Ziel" innerhalb einer Nacht** → genau **ein** gedrosselter Vermerk beim Übergang; danach kein weiterer Vermerk je Tick.

## NFRs
- **Token-Sparsamkeit:** kein `/agent-flow:flow`-Anstoß für zielleere Projekte — spart Tokens **und** hält die Nacht-Läufe-Ansicht sauber (komplementär zu [[drain-completion-report]] v2).
- **Robustheit:** der Vorab-Check ist read-only + degradierend; ein Fehler darf den Tick/Scheduler nicht crashen (analog `ReconciliationJob`).
- **Sicherheit (Floor):** keine Secrets/absoluten Pfade im Vermerk/Log (nur Slug + Grund).

## Nicht-Ziele
- **Keine** Änderung der `computeDrainState`-Ziel-Logik selbst (nur Wiederverwendung als Gate).
- **Keine** Änderung am manuellen Drain-Knopf (AC4).
- **Kein** synchroner Extra-Board-Scan nur für den Vorab-Check (Frische-Toleranz statt Perfektion, AC3).
- **Keine** neue Konfig/Autorisierung/Secrets.

## Abhängigkeiten
- [[taktgeber-nachtwaechter]] (`NightWatchScheduler`, `computeDrainState`, Drain-Ziel-Definition AC1–AC3, Nacht-Tick/Fenster) · [[drain-completion-report]] v2 (komplementär: aggregiert Leerlauf-Berichte, falls doch welche entstehen — manuell/übergangsweise) · [[headless-manual-drain]] (manueller Drain bleibt unberührt, AC4) · [[waiting-status-devgui]] (`Waiting` ist über dieselbe `computeDrainState`-Logik automatisch kein Ziel) · `BoardAggregator` (read-only Scan-Quelle) · [[taktgeber-nachtwaechter]] AC18 (`AuditStore`-Vermerk).
