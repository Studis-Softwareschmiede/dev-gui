---
id: push-notifications
title: Push-Benachrichtigungen (ntfy) bei Board-Ereignissen
status: draft
version: 1
---

# Spec: Push-Benachrichtigungen (ntfy) bei Board-Ereignissen  (`push-notifications`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der Owner soll auf Handy/Uhr eine Push-Nachricht erhalten, wenn sich im Board etwas
Relevantes tut — primär wenn eine Story fertig abgearbeitet (`Done`) wurde. Der Versand
läuft über **ntfy** (ntfy.sh oder selbst gehostet): das Backend POSTet an ein Topic, das
der Owner in der ntfy-App abonniert hat. Welche Ereignisse benachrichtigt werden, sowie
Server/Topic/Token, sind in den **Einstellungen** parametrisierbar.

## Verhalten
1. In den Einstellungen gibt es eine Sektion **„Benachrichtigungen (ntfy)"** mit:
   Ein-/Aus-Schalter, Server-URL (Default `https://ntfy.sh`), Topic, optionalem
   Zugriffs-Token (für geschützte Topics), optionaler Priorität, und einer
   **Ereignis-Auswahl** (Mehrfachauswahl), welche Board-Ereignisse feuern.
2. Die dev-gui beobachtet das Board (sie scannt es ohnehin read-only). Wechselt eine Story
   ihren Status, wird das als **Übergang** erkannt und — falls das zugehörige Ereignis
   aktiviert ist — eine Notification an ntfy gesendet.
3. Unterstützte Ereignisse: **Story fertig** (`→ Done`), **Story blockiert** (`→ Blocked`),
   **Feature komplett** (alle Kind-Stories `Done` bzw. Feature-Rollup `Done`).
4. Es feuert **nur bei einem echten Statuswechsel** — eine unverändert auf `Done` stehende
   Story löst nichts aus. Bereits gemeldete Übergänge werden nicht erneut gesendet, auch
   nicht über einen Neustart der dev-gui hinweg.
5. Beim Erst-Scan (bzw. erstmaligem Aktivieren) wird der aktuelle Board-Zustand als
   **Baseline** festgehalten, **ohne** zu senden — sonst gäbe es eine Flut für alle bereits
   abgeschlossenen Items.
6. In den Einstellungen kann der Owner per **„Test-Benachrichtigung senden"** sofort eine
   Probenachricht mit der aktuellen Konfiguration auslösen.
7. Der Versand ist **best-effort**: ein ntfy-Fehler wird geloggt, bricht aber weder den
   Watcher noch den Board-Scan ab.

## Acceptance-Kriterien

- **AC1 — Persistenz.** Die nicht-geheimen Notification-Settings (`enabled`, `server`,
  `topic`, `priority`, `events`) werden serverseitig persistiert und überleben einen
  Neustart. Der optionale ntfy-**Token** wird **getrennt im verschlüsselten
  Credential-Store** (Integration `notifications`, Name `ntfy_token`) abgelegt, nie im
  Klartext zurückgegeben.
- **AC2 — Settings-API.** `GET /api/settings/notifications` liefert die Konfiguration
  inkl. `has_token` (Bool), aber **nie** den Token-Klartext. `PUT /api/settings/notifications`
  speichert die nicht-geheimen Felder mit Validierung: `server` ist eine http(s)-URL;
  bei `enabled=true` ist `topic` nicht leer; `events` ist eine Teilmenge der erlaubten
  Schlüssel (`story_done`, `story_blocked`, `feature_done`); `priority` liegt im gültigen
  ntfy-Bereich. Ungültige Eingabe → `400` mit feldgenauer Meldung, keine Teilspeicherung.
- **AC3 — Settings-UI.** Die SettingsView zeigt eine Sektion „Benachrichtigungen (ntfy)"
  mit allen Feldern aus §1 (Token-Feld maskiert, gespeichert über den Credential-Pfad).
  Gespeicherte Werte werden beim Laden wieder angezeigt; der Token erscheint nur als
  „gesetzt/nicht gesetzt", nie im Klartext. Ein deaktivierter Schalter graut die übrigen
  Felder nicht weg, verhindert aber den Versand (AC8).
- **AC4 — Notify-Service.** Ein serverseitiges Notify-Modul nimmt Config + Ereignis-Payload
  und sendet via `POST <server>/<topic>` mit Titel, Text, Priorität und Tags; bei
  vorhandenem Token wird ein `Authorization`-Header gesetzt. Mit Timeout; ein Fehler
  (Netz/Non-2xx) wird strukturiert geloggt und **nicht** als Exception nach aussen geworfen.
- **AC5 — Test-Versand.** `POST /api/settings/notifications/test` sendet eine
  Probenachricht mit der aktuellen Config und meldet in der Antwort Erfolg **oder** Fehler
  (inkl. ntfy-Statuscode/Grund). Bei `enabled=false` oder leerem Topic → klare
  Fehlerantwort statt Versuch.
- **AC6 — Übergangs-Erkennung.** Der Watcher erkennt Statuswechsel je Story über
  aufeinanderfolgende Scans und sendet **nur** bei echtem Übergang. Der Snapshot des zuletzt
  gesehenen Status je Story wird persistiert → kein Re-Fire bereits gemeldeter Übergänge,
  auch nach Neustart.
- **AC7 — Baseline ohne Flut.** Der erste Scan nach (Neu-)Start bzw. Aktivierung etabliert
  die Baseline, **ohne** für bereits bestehende Zustände zu senden. Erst danach feuern neue
  Übergänge.
- **AC8 — Ereignis-Mapping & Gating.** `→ Done` ⇒ `story_done`; `→ Blocked` ⇒ `story_blocked`;
  Feature komplett ⇒ `feature_done`. Eine Notification wird **nur** gesendet, wenn global
  `enabled=true` **und** das konkrete Ereignis in `events` aktiviert ist.
- **AC9 — Nachrichteninhalt.** Die Notification nennt Projekt-Slug, Item-ID, Titel und
  Ereignistyp (z. B. Titel „✅ dev-gui · S-181 fertig", Text = Story-Titel).
- **AC10 — Sicherheit.** Token wird nie geloggt und nie im Klartext an das Frontend
  ausgeliefert; der Versand erfolgt ausschliesslich serverseitig (Topic/Token verlassen das
  Backend nicht Richtung Browser, ausser maskiert).

## Verträge
**Settings-Objekt (nicht-geheim):**
```
{
  "enabled": boolean,
  "server": string,        // http(s)-URL, Default "https://ntfy.sh"
  "topic": string,
  "priority": integer,     // ntfy-Bereich (min..max, Default = ntfy-Default)
  "events": string[],      // Teilmenge von ["story_done","story_blocked","feature_done"]
  "has_token": boolean     // nur in GET; true wenn Credential notifications/ntfy_token gesetzt
}
```

**Endpunkte:**
- `GET  /api/settings/notifications` → `200` Settings-Objekt (ohne Token-Klartext).
- `PUT  /api/settings/notifications` → Body = Settings ohne `has_token`; `200` gespeicherte
  Settings | `400` `{ field, message }` bei Validierungsfehler.
- `POST /api/settings/notifications/test` → `200 { ok: true }` | `200/4xx { ok: false, error }`.
- Token-Pflege über den **bestehenden** Credential-Pfad:
  `PUT/DELETE /api/settings/credentials/notifications/ntfy_token`.

**ntfy-Request (ausgehend):** `POST <server>/<topic>` mit Headern `Title`, `Priority`,
`Tags` und Body = Nachrichtentext; optional `Authorization: Bearer <token>`.

**Config-Provider-Naht (S-182/S-183):** Der Test-Endpunkt (AC5) bezieht die aktuelle
Notification-Config über eine injizierbare `getNotificationConfig()`-Funktion in den
`deps`. Signatur:
```
getNotificationConfig(): Promise<{ enabled: boolean, server: string, topic: string,
  priority?: number, events: string[] }>
```
Default-Provider (S-182): liefert `{ enabled: false, server: 'https://ntfy.sh', topic: '', events: [] }`.
S-183 ersetzt den Provider mit dem echten persistierten Store — kein weiterer Umbau des Routers nötig.

**Watcher-Snapshot:** persistierte Abbildung `story_id → letzter_status` (+ ggf.
`feature_id → komplett?`), atomar geschrieben, im dev-gui-Datenverzeichnis.

## Edge-Cases & Fehlerverhalten
- ntfy nicht erreichbar / Non-2xx → Fehler loggen, Watcher läuft weiter (AC4/AC7).
- `enabled=false` → Watcher hält den Snapshot weiter aktuell (damit nach dem Einschalten
  keine alten Übergänge nachgefeuert werden), sendet aber nichts.
- Story springt `Done → To Do` (Re-Open) und wieder `→ Done` → erneuter Übergang, feuert
  erneut (gewollt: es ist ein echter neuer Abschluss).
- Mehrere Übergänge im selben Scan → je Übergang eine Notification (kein Verschlucken).
- Fehlende/halbe Config (Topic leer, aber `enabled=true`) → Versand-Versuch unterbleibt,
  Test-Endpoint meldet den Grund.
- Board-Scan-Fehler → kein Snapshot-Update für betroffene Items, kein Fehlversand.

## NFRs
- **Security:** kein Secret in Code/Log; Token nur verschlüsselt; Versand serverseitig.
- **Performance:** Watcher hängt am bestehenden Board-Scan/rescan; kein separates Dauer-Polling
  mit nennenswerter Last; Notify mit kurzem Timeout, nicht-blockierend für den Scan.
- **A11y:** Settings-Sektion mit Labels, Test-Status mit `role=status`/`aria-live`.

## Nicht-Ziele
- Kein zweiter Push-Anbieter (Pushover/Telegram/Webhook) — nur ntfy.
- Kein Eingriff in `agent-flow` / `scripts/board`; der Auslöser sitzt vollständig in der dev-gui.
- Keine Benachrichtigung pro Flow-Zwischenschritt (coder/reviewer/tester) — nur Board-Status.
- Keine Zustellgarantie/Retry-Queue — best-effort genügt.

## Abhängigkeiten
- Bestehender Credential-Store für den Token ([[credential-backup]] / Credential-Persistenz).
- Bestehender Board-Reader/-Scan der dev-gui (BoardAggregator + `rescan`).
- Externer Dienst **ntfy** (ntfy.sh oder self-hosted).
