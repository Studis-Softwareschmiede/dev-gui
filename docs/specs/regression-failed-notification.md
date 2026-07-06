---
id: regression-failed-notification
title: Regression-Fehlschlag-Benachrichtigung — Event regression_failed, genau ein Push nur bei rotem Lauf (Default an)
status: active
area: benachrichtigungen
version: 1
spec_format: use-case-2.0
---

# Spec: Regression-Fehlschlag-Benachrichtigung  (`regression-failed-notification`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Ein roter Regressionslauf ([[regression-run]]) löst **genau einen** Push aus — grüne Läufe melden **nie**. Der neue Event-Typ `regression_failed` wird in den bestehenden Benachrichtigungs-Katalog + die Settings aufgenommen und ist **default an** (Owner-Vorgabe 2026-07-03). Baut auf der bestehenden Notify-Mechanik auf ([[push-notifications]]/[[notification-event-defaults]]: `NotifyService`, `NotificationSettingsStore`, Settings-API/-UI, Token im Credential-Store) — kein neuer Notify-Pfad.

## Kontext / Designnuancen (bindend)
- **Genau EIN Push je rotem Lauf:** ein abgeschlossener Regressionslauf mit `status: "failed"` erzeugt **einen** Push; grüne Läufe erzeugen **keinen** (Meldeklasse „Aktion nötig" — eine Regression will gesehen werden).
- **Push-Text (Owner-Wortlaut):** „🔴 `<projekt>`: Regression `<suite>` fehlgeschlagen — X/Y rot" (X = fehlgeschlagene Testfälle, Y = gesamte Testfälle des Laufs).
- **Neuer Event-Typ `regression_failed`** im Katalog `NotificationSettingsStore.ALLOWED_EVENTS`; **default an** — d.h. Teil von `DEFAULT_SETTINGS.events`. Bestehende Defaults (`drain_done`, `tunnel_missing`) bleiben erhalten ([[notification-event-defaults]] AC1).
- **Producer-Naht:** der Push wird beim Lauf-Abschluss ausgelöst (aus dem `RegressionRunner`-/Store-Abschluss, [[regression-run]] AC9 / [[regression-result-store]]), über den bestehenden `NotifyService`, gated am aktivierten Event `regression_failed`.
- **Ein aggregierter Lauf = ein Push:** da ein „Gesamt"-Lauf als **ein** aggregierter Datensatz abgelegt wird ([[regression-run]] A1), feuert er höchstens **einen** `regression_failed`-Push (kein Push-Sturm bei vielen Suiten).

## Main Success Scenario
1. Ein Regressionslauf endet mit `status: "failed"` (mindestens ein roter Testfall).
2. Ist `regression_failed` in den aktiven Ereignissen (default an), sendet der `NotifyService` **einen** Push „🔴 `<projekt>`: Regression `<suite>` fehlgeschlagen — X/Y rot".
3. Ein grüner Lauf (`status: "passed"`) sendet **keinen** Push.

## Acceptance-Kriterien
- **AC1 — Katalog & Default an.** `regression_failed` ist in `NotificationSettingsStore.ALLOWED_EVENTS` **und** in `DEFAULT_SETTINGS.events` enthalten (default an); die bestehenden Defaults (`drain_done`, `tunnel_missing`) und übrigen Katalog-Schlüssel bleiben unverändert ([[notification-event-defaults]] AC1/AC5, kein Regress). Eine frische Installation liefert `regression_failed` als aktiv über `GET /api/settings/notifications`.
- **AC2 — Genau ein Push nur bei Rot.** Ein Lauf mit `status: "failed"` erzeugt **genau einen** `regression_failed`-Push; ein Lauf mit `status: "passed"` erzeugt **keinen** Push. Ein aggregierter „Gesamt"-Lauf feuert höchstens **einen** Push (kein Sturm).
- **AC3 — Push-Text.** Der Push-Titel/-Text lautet „🔴 `<projekt>`: Regression `<suite>` fehlgeschlagen — X/Y rot" mit `<projekt>` = Projekt-Slug, `<suite>` = Suite/Scope-Label des Laufs, X = fehlgeschlagene, Y = gesamte Testfälle (`counts.failed`/`counts.total` aus [[regression-result-store]]).
- **AC4 — Gating am aktivierten Event.** Der Push feuert **nur**, wenn `regression_failed` in den aktiven Ereignissen ist; ist es abgewählt, feuert **kein** Push (Watcher-/Gating-Logik unverändert, [[push-notifications]] AC2/AC8). Kein Secret/Token in Push/Log.
- **AC5 — Settings-UI.** `regression_failed` erscheint in der Ereignis-Auswahl (`SettingsView.jsx`) mit deutschsprachigem Label, ist der passenden Meldeklasse zugeordnet und als default-aktiv markiert; An-/Abwählen + Speichern über `PUT /api/settings/notifications` (unverändert). Gespeicherte Auswahl wird beim Laden korrekt vorbelegt.

## Verträge
- **Event-Schlüssel:** `regression_failed` (`ALLOWED_EVENTS` + `DEFAULT_SETTINGS.events`).
- **Producer-Aufruf:** beim Lauf-Abschluss (`status: "failed"`) → `NotifyService.notify("regression_failed", { projekt, suite, failed, total })`; der Titel-Text wird gemäß AC3 komponiert. Keine neue Notify-Boundary.
- **PUT/GET `/api/settings/notifications`** bleiben unverändert; `regression_failed` ist ein zusätzlicher erlaubter Wert im `events`-Array ([[notification-event-defaults]] AC2).

## Edge-Cases & Fehlerverhalten
- Notify-Konfig unvollständig (kein Server/Topic gesetzt) → best-effort, kein Crash des Lauf-Abschlusses (Push-Fehler degradiert, Lauf-Ergebnis bleibt im Store).
- `regression_failed` vom Owner abgewählt → kein Push (AC4), auch bei rotem Lauf.
- Lauf endet mit Vorbedingungs-/Runner-Fehler (`precondition-error`/`error`, **nicht** `failed` durch rote Tests) → **kein** `regression_failed`-Push (es liegt keine Test-Regression vor); der Lauf-Zustand ist über Karte/Ansicht sichtbar.
- Aggregierter „Gesamt"-Lauf mit mehreren roten Suiten → **ein** Push mit den aggregierten Zählern (kein Push je Suite).

## NFRs
- **Kein Push-Sturm:** höchstens ein Push je (aggregiertem) Lauf; grüne Läufe stumm.
- **Sicherheit:** kein Secret/Token in Push/Log (bestehende Notify-Floor-Linie).

## Nicht-Ziele
- Grüne-Lauf-/Erfolgs-Benachrichtigungen (bewusst ausgeschlossen).
- Die Notify-Mechanik selbst ([[push-notifications]]) und der Event-Katalog-Rahmen ([[notification-event-defaults]]) — hier nur der zusätzliche Event + Producer + Default.
- Testausführung/-ablage ([[regression-run]]/[[regression-result-store]]).

## Abhängigkeiten
- [[push-notifications]] (Notify-Mechanik: `NotifyService`, `NotificationSettingsStore`, Settings-API/-UI, Token) · [[notification-event-defaults]] (Event-Katalog + Default-Politik + Settings-UI-Meldeklassen).
- [[regression-run]] / [[regression-result-store]] (Producer: Lauf-Abschluss `status: "failed"` + Zähler).
