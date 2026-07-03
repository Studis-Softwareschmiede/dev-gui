---
id: notification-event-defaults
title: "Notifikations-Präzisierung: zwei Meldeklassen — neuer Event-Katalog, Default-Events + einmalige Migration"
status: active
version: 1
---

# Spec: Notifikations-Präzisierung — Event-Katalog & Default-Events  (`notification-event-defaults`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der Owner erhielt am 2026-07-02 eine **Push-Flut**: transiente `Blocked`-Wechsel und
Einzel-Story-Pushes ([[push-notifications]] AC8 `story_done`/`story_blocked`/`feature_done`)
feuerten im Watcher-Takt. Diese Spec präzisiert die Benachrichtigungen auf **genau zwei
Meldeklassen** — **„Eingabe zwingend nötig"** (der Owner muss aktiv etwas beisteuern) und
**„Arbeit fertig"** (ein abgeschlossener Lauf mit Bilanz) — und richtet das **Default-Verhalten**
darauf aus: nur noch wenige, hochrelevante Ereignisse feuern von Haus aus, die granularen
Einzel-Story-Ereignisse bleiben **verfügbar**, sind aber **default AUS**.

Diese Spec ist der **autoritative Event-Katalog + die Default-/Migrations-Politik**. Sie
**baut auf** [[push-notifications]] auf (Mechanik: `NotifyService`, `NotificationSettingsStore`,
Settings-API/-UI, Watcher-Gating, Token im Credential-Store) und **überschreibt** dessen
Event-Liste (AC2/AC8) sowie den Default-Event-Satz. Die beiden **Produzenten** der neuen
Ereignisse liegen in eigenen Specs: [[drain-done-notification]] (Klasse „Arbeit fertig",
`drain_done`) und [[questions-pending-notification]] (Klasse „Eingabe zwingend nötig",
`questions_pending`).

## Meldeklassen (konzeptioneller Rahmen)
- **„Eingabe zwingend nötig"** — ein laufender Prozess wartet auf eine Owner-Eingabe:
  primär `questions_pending` ([[questions-pending-notification]]). Der Infrastruktur-Alarm
  `tunnel_missing` ([[vps-tunnel-drift-notify]]) ist eine **verwandte** „Aktion nötig"-Meldung
  und bleibt aus Owner-Wunsch **default AN** (s. AC1).
- **„Arbeit fertig"** — ein Lauf ist abgeschlossen und liefert eine Bilanz: primär
  `drain_done` ([[drain-done-notification]]). Die feingranularen `story_done`/`feature_done`
  gehören konzeptionell hierher, bleiben aber **default AUS** (sie erzeugten die Flut).

## Annahmen (konservativ, da nicht-interaktiv geklärt)
- **A1 — Harte Migration auf die neuen Defaults.** „Bestands-Settings einmalig migrieren"
  bedeutet: der persistierte `events`-Satz wird **genau einmal** auf die neuen Defaults
  `["drain_done","tunnel_missing"]` **gesetzt** (Überschreiben, nicht nur ergänzen) — so
  stoppt die Flut sofort. Danach ist der Owner frei, in der GUI Ereignisse wieder
  zuzuschalten; die Migration greift **nicht erneut** (idempotent über einen persistierten
  Marker). Rationale: die Flut vom 2026-07-02 stammte aus dem alten Default-Satz; ein
  einmaliger Reset ist die eindeutige, konservative Wahl.
- **A2 — Migration berührt nur `events`.** `enabled`, `server`, `topic`, `priority` und der
  Token bleiben **unverändert**. Der Owner bleibt eingeschaltet/ausgeschaltet wie zuvor.
- **A3 — Kein Entfernen bestehender Schlüssel.** `story_done`/`story_blocked`/`feature_done`
  bleiben **gültige** `events`-Werte (verfügbar, zuschaltbar) — nur nicht mehr im Default.

## Verhalten
1. **Event-Katalog (`ALLOWED_EVENTS`).** Der erlaubte Ereignis-Satz wird um `drain_done`
   und `questions_pending` erweitert. `tunnel_missing` ist bereits enthalten
   ([[vps-tunnel-drift-notify]]). Vollständiger Katalog danach:
   `["story_done","story_blocked","feature_done","tunnel_missing","drain_done","questions_pending"]`.
2. **Default-Events.** Der Default-Satz (`DEFAULT_SETTINGS.events`, gilt für frische
   Installationen ohne persistierte Settings) wird von `[]` bzw. dem alten Satz auf
   **`["drain_done","tunnel_missing"]`** gesetzt.
3. **Einmalige Migration bestehender Settings.** Beim Server-Start läuft eine **idempotente,
   marker-gesteuerte** Migration: existiert eine persistierte `notification-settings.json`
   **ohne** den Migrations-Marker, wird deren `events` auf `["drain_done","tunnel_missing"]`
   **gesetzt** (Überschreiben, A1), der Marker gesetzt und die Datei atomar geschrieben. Ist
   der Marker bereits gesetzt, passiert **nichts** (kein erneuter Reset, A1). Die Migration
   ist **best-effort**: ein Fehler crasht den Server-Boot **nicht** (degradierend — im Zweifel
   greifen die Code-Defaults).
4. **PUT-Validierung.** `PUT /api/settings/notifications` akzeptiert die erweiterten
   `events`-Schlüssel als gültige Teilmenge (die Validierung prüft generisch gegen
   `ALLOWED_EVENTS` — die Konstante-Erweiterung genügt). Ungültige (nicht im Katalog
   enthaltene) Schlüssel → weiterhin `400 {field:'events'}`.
5. **Settings-UI (Ereignis-Auswahl).** Die Ereignis-Mehrfachauswahl in der SettingsView
   ([[push-notifications]] AC3) listet **alle** Katalog-Ereignisse mit deutschsprachigen
   Labels und ordnet sie sichtbar den **zwei Meldeklassen** zu; die zwei default-aktiven
   Ereignisse (`drain_done`, `tunnel_missing`) sind erkennbar. Der Owner kann jedes Ereignis
   an-/abwählen; Speichern läuft unverändert über `PUT /api/settings/notifications`.

## Acceptance-Kriterien

- **AC1 — Katalog & Defaults.** `NotificationSettingsStore.ALLOWED_EVENTS` enthält
  **zusätzlich** `drain_done` und `questions_pending` (und weiterhin `story_done`,
  `story_blocked`, `feature_done`, `tunnel_missing`). `DEFAULT_SETTINGS.events` ist
  **`["drain_done","tunnel_missing"]`**. Eine frische Installation ohne persistierte Datei
  liefert über `read()`/`GET /api/settings/notifications` genau diesen Default-Satz. *(1,2)*
- **AC2 — PUT akzeptiert die neuen Schlüssel.** `PUT /api/settings/notifications` mit
  `events` ⊆ `ALLOWED_EVENTS` (inkl. `drain_done`/`questions_pending`) → `200`, persistiert.
  Ein `events` mit einem nicht im Katalog enthaltenen Schlüssel → `400 {field:'events'}`,
  keine Teilspeicherung. Bestehende Werte (`server`/`topic`/`priority`) bleiben unberührt. *(4)*
- **AC3 — Einmalige Migration (idempotent).** Eine persistierte `notification-settings.json`
  **ohne** Migrations-Marker wird beim Start **einmal** migriert: `events` →
  `["drain_done","tunnel_missing"]`, Marker gesetzt, atomar geschrieben. Ein zweiter
  Migrations-Lauf (Marker vorhanden) lässt `events` **unverändert** — insbesondere überleben
  vom Owner **nach** der Migration in der GUI gesetzte Ereignisse einen Server-Neustart
  (kein erneuter Reset). Der Marker **überlebt** `read()`/`write()` (wird nicht durch das
  Feld-Whitelisting verworfen). *(3, A1)*
- **AC4 — Migration ist scharf begrenzt + best-effort.** Die Migration ändert **ausschließlich**
  `events` (und setzt den Marker); `enabled`, `server`, `topic`, `priority` und der Token
  bleiben **byte-identisch**. Ein Fehler (Datei nicht lesbar/schreibbar, `CRED_STORE_DIR`
  nicht gesetzt) crasht den Server-Boot **nicht** (degradierend geloggt, Code-Defaults
  greifen). *(3, A2)*
- **AC5 — Bestehende Schlüssel bleiben gültig.** `story_done`/`story_blocked`/`feature_done`
  bleiben in `ALLOWED_EVENTS` und sind über `PUT` weiterhin setzbar (verfügbar, zuschaltbar) —
  nur nicht mehr default aktiv. Kein Regress an [[push-notifications]] AC2/AC8 (Gating-Logik
  im Watcher unverändert: nur aktivierte Ereignisse feuern). *(A3, [[push-notifications]] AC8)*
- **AC6 — Settings-UI: zwei Meldeklassen.** Die Ereignis-Auswahl in `SettingsView.jsx` listet
  alle `ALLOWED_EVENTS` mit deutschsprachigen Labels, ordnet sie den zwei Meldeklassen
  („Eingabe zwingend nötig" / „Arbeit fertig") sichtbar zu und markiert die zwei
  default-aktiven Ereignisse. An-/Abwählen + Speichern über `PUT /api/settings/notifications`
  (unverändert). Gespeicherte Auswahl wird beim Laden korrekt vorbelegt. Zustände textlich
  (nicht nur farblich), Labels/`aria`-Muster wie die bestehenden Felder. *(5)*

## Verträge

### `NotificationSettingsStore` (Erweiterung, `src/NotificationSettingsStore.js`)
- `ALLOWED_EVENTS` (additiv): `[..., 'drain_done', 'questions_pending']`.
- `DEFAULT_SETTINGS.events = ['drain_done','tunnel_missing']`.
- **Migrations-Marker** (persistiert, überlebt `read`/`write`): z.B. `eventsDefaultsVersion: 2`
  (Feld-Name Implementierungswahl) — `_mergeWithDefaults` muss ihn **durchreichen** (nicht
  verwerfen), sonst wäre die Migration nicht idempotent.
- `migrateEventDefaults()` (neu, sprach-neutral): liest die persistierte Datei; fehlt der
  Marker → setzt `events = ['drain_done','tunnel_missing']` + Marker, schreibt atomar (tmp+rename);
  Marker vorhanden → No-op. Best-effort (wirft nicht nach aussen). Wird beim Server-Start
  (`server.js`) genau einmal aufgerufen.

### Settings-API (unverändert im Vertrag, erweiterte Werte)
- `GET /api/settings/notifications` → `events` kann jeden `ALLOWED_EVENTS`-Schlüssel enthalten.
- `PUT /api/settings/notifications` → `events` ⊆ `ALLOWED_EVENTS`, sonst `400 {field:'events'}`.

## Edge-Cases & Fehlerverhalten
- **`CRED_STORE_DIR` nicht gesetzt** → keine persistierte Datei; Migration ist No-op; frische
  Defaults (`["drain_done","tunnel_missing"]`) greifen über die Code-Defaults. Kein Crash.
- **Persistierte Datei ohne `events`-Feld** (Alt-Datei) → gilt als „nicht migriert" → wird
  einmal migriert (Marker gesetzt).
- **Owner hat nach Migration alle Ereignisse abgewählt (`events: []`)** → bleibt `[]` über
  Neustarts (Marker verhindert Re-Reset). Kein Push (gewollt).
- **Nicht-Katalog-Schlüssel in einer manuell editierten Datei** → `_mergeWithDefaults`
  filtert ihn beim Lesen heraus (bestehendes Verhalten, unverändert).

## NFRs
- **Sicherheit (Floor):** kein Secret/Token in Migration/Log; der Token-Pfad bleibt unberührt
  ([[push-notifications]] AC1/AC10). Migration schreibt nur nicht-geheime Felder.
- **Robustheit:** Migration best-effort — Boot darf nie an ihr scheitern (AC4).
- **A11y:** Ereignis-Auswahl mit Labels + Meldeklassen-Überschriften, Zustand textlich.

## Nicht-Ziele
- **Kein** Entfernen von `story_done`/`story_blocked`/`feature_done` aus dem Katalog (nur
  aus dem Default).
- **Keine** neue Push-Mechanik — `NotifyService`/Watcher-Gating/Settings-API bleiben
  [[push-notifications]]. Diese Spec ändert nur Katalog + Defaults + Migration + UI-Labels.
- **Keine** Produzenten-Logik — `drain_done` liegt in [[drain-done-notification]],
  `questions_pending` in [[questions-pending-notification]].
- **Kein** zweiter Push-Anbieter (nur ntfy).

## Abhängigkeiten
- [[push-notifications]] (Basis: `NotifyService`, `NotificationSettingsStore`, Settings-API/-UI,
  Watcher-Gating, Token; F-025) — diese Spec **erweitert** den Event-Katalog + Defaults.
- [[drain-done-notification]] (`drain_done`-Produzent) · [[questions-pending-notification]]
  (`questions_pending`-Produzent) · [[vps-tunnel-drift-notify]] (`tunnel_missing`, bereits im
  Katalog + im neuen Default).
