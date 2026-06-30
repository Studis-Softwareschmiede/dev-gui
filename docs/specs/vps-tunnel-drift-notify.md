---
id: vps-tunnel-drift-notify
title: "Tunnel-Drift-Push — Reconciliation erkennt fehlenden Tunnel → ntfy-Push (Capability C)"
status: draft
version: 1
---

# Spec: Tunnel-Drift-Push (`vps-tunnel-drift-notify`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Security-relevant (kein Token/Key in Push/Log/Audit; best-effort-Versand bricht den Cron nicht).
> Boundaries: `ReconciliationJob` (**ADR-013**, node-interner Mitternachts-Scheduler), `CloudflareApi.listTunnels` (**ADR-010**), `VpsProviderRegistry`/`TUNNEL_ID_KEY` ([[vps-tunnel-provisioning]]), `NotifyService`/`NotificationWatcher` ([[push-notifications]], F-025), `AuditStore`.

## Zweck
**Capability C des selbstheilenden VPS-Tunnel-Vorhabens.** Heute merkt niemand, wenn der Cloudflare-Tunnel eines VPS extern gelöscht wurde — erst der nächste Deploy scheitert ([[vps-tunnel-existence-gate]] fängt es dann ab). Diese Capability macht den Drift **proaktiv** sichtbar: die periodische `ReconciliationJob` ([[cloudflare-reconciliation]]) erkennt den Zustand „VPS hat eine gespeicherte `tunnelId`, die in Cloudflare **nicht mehr** existiert" als **Drift** und schickt eine **ntfy-Push** über den bestehenden Notify-Pfad aus F-025 ([[push-notifications]], `NotifyService`/`NotificationWatcher`). So erfährt der Owner sofort vom gelöschten Tunnel und kann ihn per Ein-Klick ([[vps-tunnel-self-heal]]) wiederherstellen.

> **Abgrenzung:** Diese Spec liefert nur die **Erkennung des fehlenden Tunnels im Reconcile-Lauf + den Push**. Das **Deploy-Gate** ist [[vps-tunnel-existence-gate]] (A); die **Wiederherstellung** ist [[vps-tunnel-self-heal]] (B). Die **Route-↔-Container-Konvergenz** der Reconciliation ([[cloudflare-reconciliation]] AC3–AC5) bleibt unverändert — diese Capability ergänzt **eine zusätzliche Drift-Klasse** (fehlender Tunnel) plus den Push-Versand. Der **Versandkanal** (ntfy-Config/Token/Topic, Settings, Test-Versand) ist vollständig in [[push-notifications]] spezifiziert; diese Capability **konsumiert** ihn.

## Verhalten
1. **Tunnel-Existenz-Check je VPS im Reconcile-Lauf.** Für jeden konfigurierten VPS prüft der `ReconciliationJob`, ob die dem VPS zugeordnete `tunnelId` (`VpsProviderRegistry`/`TUNNEL_ID_KEY`) in Cloudflare real existiert (`CloudflareApi.listTunnels(...)` → `some(t => t.id === tunnelId)`). Existiert sie **nicht**, gilt der VPS als **Tunnel-Drift** (`tunnel-missing`).
2. **Reconcile-Verhalten bei Tunnel-Drift.** Fehlt der Tunnel eines VPS, kann der Lauf für diesen VPS **keine** Routen auf einem toten Tunnel abgleichen/heilen → der VPS wird als **gestört** vermerkt (fail-closed für die Route-Konvergenz dieses VPS, analog [[cloudflare-reconciliation]] AC7), **ohne** den Gesamtlauf zu kippen (Degradation pro VPS, AC6 dort). Der `ReconciliationJob` **heilt den Tunnel nicht automatisch** (Selbstheilung bleibt der manuelle Ein-Klick-Pfad B) — er **meldet** nur.
3. **Drift als Report-/Notice-Eintrag.** Der Tunnel-Drift erscheint im `ReconcileReport` je VPS (neues Feld/Marker, z.B. `tunnelMissing: true`) und als `ReconcileNotice` (`kind: "tunnel-missing"`), getragen über die bestehende `AuditStore`-Mechanik ([[cloudflare-reconciliation]] AC8/AC8b) — **ohne** Secrets.
4. **ntfy-Push bei Drift.** Wird ein Tunnel-Drift **neu** erkannt, sendet der Job über den bestehenden `NotifyService` ([[push-notifications]] AC4) eine Push (Titel/Text nennen VPS + Hinweis „Tunnel fehlt in Cloudflare"), **sofern** Notifications global aktiviert sind und das zugehörige Ereignis aktiviert ist. Der Versand ist **best-effort**: ein ntfy-Fehler wird geloggt, bricht aber **weder** den Reconcile-Lauf **noch** die übrigen VPS-Abgleiche ab ([[push-notifications]] AC4/§7).
5. **Kein Push-Sturm (Übergangs-Erkennung).** Ein dauerhaft fehlender Tunnel feuert **nicht** bei jedem nächtlichen Lauf erneut: nur der **Übergang** „Tunnel war da / unbekannt → Tunnel fehlt" löst eine Push aus (analog der Übergangs-Erkennung in [[push-notifications]] AC6/AC7). Heilt der Tunnel (Ein-Klick B / extern neu angelegt) und fällt später wieder aus, ist das ein neuer Übergang und feuert erneut.
6. **Ereignis-Konfiguration.** Das Drift-Ereignis ist über die bestehende Notification-Ereignis-Auswahl gate-bar ([[push-notifications]] AC8): ein neuer Ereignis-Schlüssel `tunnel_missing` reiht sich in die erlaubten `events` ein; ohne Aktivierung kein Push (der Report/Notice-Eintrag entsteht dennoch).
7. **Sicherheit.** Weder die Push-Nachricht, der Report, die Notice noch ein Log enthalten ein Tunnel-Token, einen SSH-Key oder einen Cloudflare-API-Token. Die nicht-geheime `tunnelId`/`vpsId` darf genannt werden.

## Acceptance-Kriterien

### Drift-Erkennung im Reconcile-Lauf
- **AC1** — Der `ReconciliationJob` prüft je konfiguriertem VPS, ob die zugeordnete `tunnelId` (`TUNNEL_ID_KEY`/`VpsProviderRegistry`) in `CloudflareApi.listTunnels(...)` enthalten ist (`some(t => t.id === tunnelId)`). Fehlt sie → der VPS gilt als Tunnel-Drift (`tunnel-missing`); existiert sie → kein Drift (testbar mit `listTunnels`-Mock mit/ohne den Tunnel).
- **AC2** — Bei Tunnel-Drift eines VPS werden für diesen VPS **keine** Routen auf dem (toten) Tunnel gelöscht **oder** geheilt (fail-closed für die Route-Konvergenz dieses VPS, [[cloudflare-reconciliation]] AC7-Linie); der **Gesamtlauf** läuft für die übrigen VPS normal weiter (Degradation pro VPS, AC6 dort). Der Job heilt den Tunnel **nicht** automatisch (kein `createTunnel` im Cron).

### Report/Notice
- **AC3** — Ein Tunnel-Drift erscheint im `ReconcileReport` je VPS als secret-freier Marker (z.B. `tunnelMissing: true` bzw. `errors[]`-Eintrag `errorClass: "tunnel-missing"`) und als `ReconcileNotice` `{ at, kind: "tunnel-missing", vps, detail? }` (ohne Secret), persistiert über die bestehende `AuditStore`-Mechanik (kein neuer Store). Abrufbar über die bestehenden Reconcile-Report-/Notice-Endpunkte ([[cloudflare-reconciliation]] AC8/AC8b).

### ntfy-Push
- **AC4** — Wird ein Tunnel-Drift **neu** erkannt, ruft der Job den bestehenden `NotifyService.sendNotification(config, payload)` ([[push-notifications]] AC4) mit einer secret-freien Nachricht auf, die **VPS** und den Hinweis „Tunnel fehlt in Cloudflare" nennt — **nur** wenn Notifications global aktiviert (`enabled=true`) **und** das Ereignis `tunnel_missing` in `events` aktiviert ist ([[push-notifications]] AC8). Andernfalls kein Versand (Report/Notice entsteht dennoch).
- **AC5** — Der Versand ist **best-effort**: ein ntfy-Fehler (Netz/Non-2xx) wird strukturiert geloggt, aber **nicht** als Exception geworfen — der Reconcile-Lauf und die übrigen VPS-Abgleiche laufen weiter ([[push-notifications]] AC4). Ein deaktivierter/unkonfigurierter Notify-Pfad führt zu **keinem** Fehler im Reconcile-Lauf.
- **AC6** (Kein Sturm / Übergang) — Ein über mehrere Läufe **unverändert** fehlender Tunnel löst **nicht** bei jedem Lauf eine neue Push aus; nur der **Übergang** zu „Tunnel fehlt" feuert (Übergangs-Erkennung analog [[push-notifications]] AC6/AC7). Der Übergangs-Zustand wird so gehalten, dass ein dev-gui-Neustart keinen Re-Fire eines bereits gemeldeten, unverändert fehlenden Tunnels auslöst (Snapshot-/AuditStore-getragen; `coder` finalisiert die Trägerschicht konsistent mit [[push-notifications]] bzw. dem Reconcile-AuditStore).

### Konfiguration & Sicherheit (Floor)
- **AC7** — Das Drift-Ereignis ist über die bestehende Ereignis-Auswahl konfigurierbar: ein neuer Schlüssel `tunnel_missing` reiht sich in die erlaubten `events` ([[push-notifications]] AC2/AC8) ein; PUT-Validierung akzeptiert ihn als Teilmengen-Element. Ohne Aktivierung kein Push (Report/Notice unberührt).
- **AC8** (Security, hart) — Weder Push-Nachricht, `ReconcileReport`, `ReconcileNotice`, Log noch Audit enthalten ein Tunnel-Token, einen SSH-Private-Key, einen Cloudflare-API-Token oder den ntfy-Token. Die nicht-geheime `tunnelId`/`vpsId` darf genannt werden. Der ntfy-Token bleibt store-intern ([[push-notifications]] AC1/AC10).

## Verträge
> Pfade/Felder kanonisch; Boundary-Detail: `ReconciliationJob` (ADR-013), `CloudflareApi.listTunnels` (ADR-010), `NotifyService` ([[push-notifications]]).

- **Drift-Prädikat:** je VPS `tunnelMissing = !(await cloudflareApi.listTunnels(...)).some(t => t.id === registeredTunnelId)`; `registeredTunnelId` über `VpsProviderRegistry`/`TUNNEL_ID_KEY(sanitize(vpsName))`.
- **`ReconcileReport`-Erweiterung (additiv):** je VPS optional `tunnelMissing: boolean` (oder `errors[]`-Eintrag `{ scope, errorClass: "tunnel-missing" }`); **keine** Secrets. (Bestehende Felder [[cloudflare-reconciliation]] unverändert.)
- **`ReconcileNotice`-Erweiterung (additiv):** `kind: "tunnel-missing"` ergänzt das bestehende Vokabular (`route-created`|`route-removed`|`protected-skipped`|`error`); `{ at, kind: "tunnel-missing", vps, detail? }`, **keine** Secrets.
- **Notify-Payload (ausgehend, secret-frei):** `{ title: "⚠️ <slug> · VPS <vpsId>: Tunnel fehlt", message: "Der Cloudflare-Tunnel dieses VPS existiert nicht mehr — über ‚Tunnel neu anlegen & bestücken' wiederherstellen", tags?: [...] }` an `NotifyService.sendNotification(config, payload)`. Config aus dem bestehenden Notification-Settings-Provider ([[push-notifications]] Config-Naht).
- **Ereignis-Schlüssel (additiv):** `tunnel_missing` ergänzt `["story_done","story_blocked","feature_done"]` als erlaubtes `events`-Element ([[push-notifications]] AC2/AC8).
- **Quellen:** `CloudflareApi.listTunnels` (ADR-010), `VpsProviderRegistry` (`TUNNEL_ID_KEY`), `NotifyService`/Notification-Config ([[push-notifications]]), `AuditStore` (Report/Notice). Token/Key store-intern, transient, nie geleakt.
- Keine neuen mutierenden Endpunkte; die bestehenden Reconcile-Trigger/-Report-Endpunkte ([[cloudflare-reconciliation]]) bleiben unverändert.

## Edge-Cases & Fehlerverhalten
- VPS ohne registrierte `tunnelId` → **kein** Tunnel-Drift (es gibt nichts zu vermissen); kein Push.
- Cloudflare nicht konsultierbar (`listTunnels` Fehler) → der VPS wird als **gestört** vermerkt (degradierend, [[cloudflare-reconciliation]] AC6), **nicht** fälschlich als `tunnel-missing` (ein nicht-prüfbarer Zustand ist kein bewiesener Drift) → **kein** Fehlalarm-Push.
- Notifications deaktiviert / `tunnel_missing` nicht in `events` → kein Push, aber Report/Notice entstehen (AC4/AC7).
- ntfy unerreichbar → Fehler geloggt, Lauf läuft weiter (AC5).
- Tunnel fehlt über mehrere Läufe unverändert → genau **ein** Push beim Übergang, danach Ruhe (AC6); dev-gui-Neustart re-fired nicht.
- Tunnel geheilt (B/extern) → Drift-Zustand löst sich; ein späterer erneuter Ausfall ist ein neuer Übergang und feuert erneut.
- Mehrere VPS mit gleichzeitigem Drift → je VPS eine Push beim jeweiligen Übergang (kein Verschlucken, analog [[push-notifications]] Mehr-Übergangs-Regel).

## NFRs
- **Sicherheit (Floor, hart):** keine Secrets in Push/Report/Notice/Log/Audit (AC8); ntfy-Token store-intern ([[push-notifications]]). Drift-Erkennung ist read-only (nur `listTunnels`); kein autonomes `createTunnel`/`deleteTunnel` im Cron.
- **Resilienz:** best-effort-Versand bricht den Cron nie ab (AC5); Drift-Check pro VPS degradierend; fail-closed bei nicht-prüfbarem Cloudflare (kein Fehlalarm).
- **Kosten/Last:** der Drift-Check hängt am bestehenden Reconcile-Lauf (ein zusätzlicher `listTunnels`-Read je Lauf bzw. je VPS); kein separates Dauer-Polling.
- **ADR-005/010/013-Konformität:** kein neuer Store (Report/Notice über `AuditStore`, Übergangs-Zustand über die bestehende Snapshot-/AuditStore-Mechanik); `CloudflareApi` bleibt einziger CF-Sprecher; Versand über den bestehenden F-025-Pfad (kein zweiter Push-Anbieter).

## Nicht-Ziele
- **Automatische Selbstheilung im Cron** (Tunnel neu anlegen + Token pushen) — bewusst ausgeschlossen; die Heilung bleibt der manuelle Ein-Klick-Pfad [[vps-tunnel-self-heal]] (autonome Cloudflare-Mutation in diese Richtung ist nicht gewollt).
- **Deploy-Gate** → [[vps-tunnel-existence-gate]] (A).
- **Zweiter Push-Anbieter** (Pushover/Telegram/Webhook) → nur ntfy ([[push-notifications]] Nicht-Ziele).
- **Änderung der Route↔Container-Konvergenz** der Reconciliation → [[cloudflare-reconciliation]] (unverändert; diese Capability ergänzt nur Drift-Erkennung + Push).

## Abhängigkeiten
- [[cloudflare-reconciliation]] (`ReconciliationJob` — Drift-Erkennung reiht sich in den Lauf ein; Report/Notice-Mechanik; ADR-013).
- [[push-notifications]] (`NotifyService`/`NotificationWatcher`, Notification-Config, Ereignis-Gating, Übergangs-Erkennung; F-025).
- [[vps-tunnel-provisioning]] (VPS↔Tunnel-Zuordnung, `TUNNEL_ID_KEY`).
- [[vps-tunnel-existence-gate]] (gleiches Drift-Prädikat `listTunnels`-Existenz; A).
- [[vps-tunnel-self-heal]] (die vom Push empfohlene Wiederherstellung; B).
- [[view-cloudflare]] (`CloudflareApi.listTunnels`, ADR-010).
- [[access-and-guardrails]] (`AuditStore` als Persistenz von Report/Notice).
- `docs/architecture.md` — `ReconciliationJob` (ADR-013), `CloudflareApi` (ADR-010), Notify-Pfad (F-025).
