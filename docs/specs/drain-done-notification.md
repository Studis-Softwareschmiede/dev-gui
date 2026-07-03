---
id: drain-done-notification
title: "Drain-Fertig-Push (drain_done) — genau ein ntfy-Push je Drain-Ende mit Bilanz"
status: active
version: 1
---

# Spec: Drain-Fertig-Push  (`drain-done-notification`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Meldeklasse **„Arbeit fertig"** ([[notification-event-defaults]]). Statt vieler Einzel-Story-Pushes
(`story_done`/`story_blocked`, seit [[notification-event-defaults]] default AUS) erhält der Owner
**genau EINEN** ntfy-Push je abgeschlossenem Board-Drain — mit einer kompakten **Bilanz**
(„🏁 <slug>: X Done, Y Blocked"). Das gilt für **beide** Drain-Auslöser: den nächtlichen
Nachtwächter-Drain ([[headless-parallel-drain]] / `NightWatchScheduler`) **und** den manuellen
„Board abarbeiten"-Lauf ([[headless-manual-drain]] / `POST /api/projects/:slug/drain`).

Die Datenquelle ist **dieselbe Drain-Abschluss-Naht** wie beim Abschlussbericht
([[drain-completion-report]]): das erweiterte `drainProject()`-Ergebnis (`completed`/`blocked`,
und — sobald vorhanden — `budgetPauses`). Der Push ist ein **eigener Produzent** und läuft
**nicht** über die Board-Übergangs-Erkennung des `NotificationWatcher` ([[push-notifications]] AC6)
— er feuert **einmalig** am Drain-Ende, nicht je Board-Scan (kein Doppelfeuern mit `story_done`).

## Annahmen (konservativ, da nicht-interaktiv geklärt)
- **A1 — Kein Push bei Leerlauf.** Ein Drain, der **keine** Flow-Runde fuhr (`flowRuns == 0`,
  z.B. sofortige Konvergenz, `scan-failed`, `command-channel-busy`, fehlgeschlagener Leer-Drain),
  löst **keinen** Push aus — sonst entstünde bei einem Nacht-Lauf über viele leerlaufende
  Projekte erneut eine Flut (genau das Problem, das diese Präzisierung löst). Der Push feuert
  **genau dann**, wenn `flowRuns > 0` (der Drain hat mindestens eine Runde gearbeitet). Der
  Leerlauf bleibt in der GUI sichtbar (`drain-completion-report` AC7) — nur ohne Push.
- **A2 — Budget-Pausen vorbereiten, nicht blockieren.** Trägt das Drain-Ergebnis das Feld
  `budgetPauses` ([[night-budget-guard]] AC12) und ist es **nicht leer**, ergänzt die Bilanz
  „· Z Budget-Pausen". Fehlt das Feld (heutiger Zustand, solange [[night-budget-guard]] nicht
  gelandet ist) oder ist es leer, wird der Zusatz **weggelassen** — diese Spec **hängt nicht**
  von [[night-budget-guard]] ab (defensives Lesen, vorwärtskompatibel).
- **A3 — Slug, kein Pfad.** Der Push nennt den Projekt-**Slug** (manuell: der form-validierte
  Route-Slug; Nacht: der bereits vom Scheduler abgeleitete Slug, `drain-completion-report` AC6),
  **nie** einen absoluten Host-Pfad.

## Verhalten
1. **Ein Produzent, beide Nähte.** Ein `DrainNotifier` (best-effort, injiziert, Muster
   `_writeManualReport`/`#writeReport` in [[drain-completion-report]]) wird an **derselben**
   Drain-Abschluss-Naht aufgerufen, an der der Abschlussbericht geschrieben wird:
   - **Manueller Drain:** im `.then((result) => …)`-Pfad des `projectDrainRouter` (zusätzlich
     zu `_writeManualReport` + `_notifyAutoRetro`).
   - **Nacht-Drain:** in der `NightWatchScheduler`-Abschluss-Naht (dieselbe Stelle wie
     `#writeReport`/`#notifyAutoRetro`), je abgeschlossenem Projekt-Drain.
2. **Genau ein Push je qualifiziertem Drain-Ende.** Ist `flowRuns > 0` (A1), sendet der
   `DrainNotifier` **genau eine** Notification via `NotifyService.sendNotification`
   ([[push-notifications]] AC4) — **sofern** Notifications global aktiviert (`enabled=true`)
   **und** `drain_done` in `events` aktiviert sind ([[push-notifications]] AC8 /
   [[notification-event-defaults]]). Andernfalls kein Versand.
3. **Bilanz-Inhalt.** Titel „🏁 <slug>: X Done, Y Blocked" mit `X = completed.length`,
   `Y = blocked.length`; bei nicht-leeren `budgetPauses` zusätzlich „· Z Budget-Pausen" mit
   `Z = budgetPauses.length` (A2). Der Nachrichtentext nennt kompakt die Bilanz (Slug + Zähler);
   **keine** absoluten Pfade/Secrets. Story-Titel/IDs sind optional (Implementierungswahl,
   secret-frei), aber die **Bilanz-Zähler** sind Pflicht.
4. **Kein Watcher-Doppelfeuern.** `drain_done` wird **ausschliesslich** vom `DrainNotifier`
   an der Drain-Naht erzeugt, **nicht** im `NotificationWatcher.detectTransitions`
   ([[push-notifications]]). Der Watcher bleibt für board-status-basierte Ereignisse
   (`story_done`/…) unverändert.
5. **Best-effort, non-fatal.** Ein Notify-Fehler (Netz/Non-2xx/Token-Lesefehler) wird
   strukturiert geloggt, bricht aber **weder** den Drain-Abschluss, **noch** den Bericht-Write,
   **noch** den Auto-Retro-Check, **noch** den Scheduler ab (degradierend, wie die übrigen
   Abschluss-Best-effort-Schritte).

## Acceptance-Kriterien

- **AC1 — Produzent + Gating.** Ein `DrainNotifier.notifyDrainDone({ slug, result })` sendet
  via `NotifyService.sendNotification` **genau eine** Notification, **wenn** `result.flowRuns > 0`
  (A1) **und** die Notification-Config `enabled=true` liefert **und** `events` `drain_done`
  enthält. Ist eine der Bedingungen nicht erfüllt (`flowRuns == 0`, `enabled=false`, `drain_done`
  nicht in `events`), wird **nicht** gesendet. Testbar mit gemocktem `sendNotification` +
  Config-Provider. *(1,2)*
- **AC2 — Bilanz-Payload.** Der Payload-Titel lautet „🏁 <slug>: X Done, Y Blocked" mit
  `X = (result.completed?.length ?? 0)` und `Y = (result.blocked?.length ?? 0)`. Ist
  `result.budgetPauses` ein **nicht-leeres** Array, wird „· Z Budget-Pausen"
  (`Z = result.budgetPauses.length`) angehängt; fehlt das Feld oder ist es leer, **kein** Zusatz
  (A2). `<slug>` ist der Projekt-Slug (A3), kein Pfad. *(3)*
- **AC3 — Manuelle Naht.** Der `projectDrainRouter` ruft im `.then(result)`-Pfad zusätzlich zu
  `_writeManualReport` den `DrainNotifier` best-effort auf (`slug` = form-validierter Route-Slug).
  Der bestehende Bericht-Write, `DrainJobRegistry`-Status und `_notifyAutoRetro` bleiben
  **unverändert**; ein Notify-Fehler ist non-fatal (kein Einfluss auf die 202-Antwort / den
  Abschluss). Der `.catch`-(fehlgeschlagen)-Pfad hat `flowRuns:0` → **kein** Push (A1). *(1,5)*
- **AC4 — Nacht-Naht.** Der `NightWatchScheduler` ruft an derselben Abschluss-Naht wie
  `#writeReport` den `DrainNotifier` best-effort je abgeschlossenem Projekt-Drain auf
  (`slug` = der bereits abgeleitete Projekt-Slug, `drain-completion-report` AC6). Ein
  Notify-Fehler crasht den Scheduler **nicht** (best-effort/degradierend). *(1,5)*
- **AC5 — Kein Watcher-Doppelfeuern.** `NotificationWatcher.detectTransitions`
  ([[push-notifications]]) erzeugt **kein** `drain_done` — der Board-Übergangs-Watcher bleibt
  bit-identisch (nur `story_done`/`story_blocked`/`feature_done`). `drain_done` entsteht
  ausschliesslich am Drain-Ende. *(4)*
- **AC6 — Wiring.** `server.js` baut einen `DrainNotifier` (kapselt Config-Provider aus
  [[push-notifications]] + Token-Lesen aus dem Credential-Store + `sendNotification`) und
  injiziert dieselbe Instanz in `projectDrainRouter` **und** `NightWatchScheduler`. Fehlt der
  Notifier (nicht injiziert) → No-op an beiden Nähten (kein Crash, Default-Regress). *(1)*
- **AC7 — Sicherheit (Floor, hart).** Weder Push, Log noch Fehlermeldung enthalten den
  ntfy-Token, einen absoluten Host-Pfad oder ein Secret; nur Slug + Zähler (+ optional
  secret-freie Story-IDs/Titel). Der Token bleibt store-intern ([[push-notifications]] AC1/AC10).

## Verträge

### `DrainNotifier` (neu, `src/DrainNotifier.js`) — sprach-neutral
- Konstruktor-`deps`: `{ getNotificationConfig, getToken, sendNotificationFn }`
  (Config-Provider + Token-Getter + Versand — alle injizierbar, Test-Entkopplung).
- `notifyDrainDone({ slug, result }) → Promise<void>`
  - No-op wenn `result.flowRuns <= 0` (A1) **oder** Config `enabled=false` **oder** `drain_done`
    nicht in `events`.
  - sonst: Payload bauen (AC2), `sendNotificationFn(config, payload)`; ein Fehler wird
    gefangen + geloggt (best-effort), nie geworfen.

### Payload (ausgehend, secret-frei)
```
title:   "🏁 <slug>: X Done, Y Blocked"   // + " · Z Budget-Pausen" bei nicht-leerem budgetPauses
message: kompakte Bilanz (Slug + Zähler)   // keine absoluten Pfade/Secrets
tags:    ["checkered_flag"]                // Implementierungswahl
```

### Naht-Verträge (Wiederverwendung)
- `projectDrainRouter` (`src/projectDrainRouter.js`) — `.then(result)`: zusätzlicher
  best-effort `drainNotifier.notifyDrainDone({ slug: rawSlug, result })`, analog `_writeManualReport`.
- `NightWatchScheduler` (`src/NightWatchScheduler.js`) — Abschluss-Naht (`#writeReport`-Stelle):
  zusätzlicher best-effort Aufruf je Projekt-Drain mit dem dort bereits abgeleiteten Slug.
- Config-/Token-Quelle: der Notification-Config-Provider + Credential-Store-Token wie im
  `NotificationWatcher` ([[push-notifications]] AC1/AC4/AC10) — kein zweiter Config-Pfad.

## Edge-Cases & Fehlerverhalten
- **`flowRuns == 0` / `scan-failed` / `command-channel-busy` / fehlgeschlagener Leer-Drain**
  → kein Push (A1).
- **`enabled=false` oder `drain_done` nicht aktiviert** → kein Push (Gating).
- **`completed`/`blocked` fehlen im Ergebnis** → als `0` gezählt (defensiv, kein Crash).
- **`budgetPauses` fehlt** (heutiger Zustand) → Zusatz weggelassen; kein Fehler (A2).
- **ntfy unerreichbar / Non-2xx / Token-Lesefehler** → geloggt (secret-frei), Drain-Abschluss +
  Bericht + Auto-Retro + Scheduler laufen weiter (AC3/AC4/AC7).
- **Mehrere Projekt-Drains in einer Nacht** → je qualifiziertem Projekt-Drain **ein** Push
  (kein Verschlucken, kein Sammeln).

## NFRs
- **Sicherheit (Floor, hart):** keine Secrets/Token/absoluten Pfade in Push/Log/Fehler (AC7);
  Token store-intern ([[push-notifications]]).
- **Robustheit:** best-effort an beiden Nähten — der Push darf keinen Abschlussschritt crashen
  (AC3/AC4). Kein neuer Store, kein neuer Timer, kein Dauer-Polling.
- **Anti-Flut:** genau ein Push je qualifiziertem Drain-Ende (A1) — ersetzt die vielen
  Einzel-Story-Pushes ([[notification-event-defaults]]).

## Nicht-Ziele
- **Kein** Push bei Leerlauf-Drains (A1).
- **Keine** Board-Übergangs-Erkennung für `drain_done` (kein Watcher-Pfad, AC5).
- **Keine** Änderung der Drain-/Bericht-/Auto-Retro-Logik (nur additiver Push an der Naht).
- **Kein** zweiter Push-Anbieter (nur ntfy).

## Abhängigkeiten
- [[notification-event-defaults]] (`drain_done` im Katalog + im Default-Satz — **Voraussetzung**).
- [[push-notifications]] (`NotifyService`, Notification-Config/Token/Gating; F-025).
- [[drain-completion-report]] (dieselbe Drain-Abschluss-Naht, `completed`/`blocked`,
  `DrainReportStore`-Muster) · [[headless-manual-drain]] (`projectDrainRouter`) ·
  [[headless-parallel-drain]] / [[taktgeber-nachtwaechter]] (`NightWatchScheduler`).
- [[night-budget-guard]] (**optional**, liefert `budgetPauses` — defensiv gelesen, A2; keine
  harte Abhängigkeit).
