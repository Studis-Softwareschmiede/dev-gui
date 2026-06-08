---
id: view-cloudflare
title: Cloudflare-Ansicht — Inventar + Lösch-Werkzeug (Zones / Tunnel / Routen)
status: draft
version: 2
---

# Spec: Cloudflare-Ansicht (`view-cloudflare`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). Security-kritisch (Cloudflare-Token, Self-Lockout-Risiko).
> **v2:** erweitert das in v1 gelieferte Platzhalter-Gerüst (AC1–AC3) um **Capability A — Cloudflare-Inventar**: verwaltete Zones/Domänen auflisten + anwählen → zugehörige Tunnel + Public-Hostname-Routen anzeigen → einzelne Tunnel/Routen **löschen**. Der Cloudflare-API-Boundary ist in **ADR-010** fixiert, der Self-Lockout-Schutz in **ADR-011**. Deploy-Lifecycle (B) und Reconciliation (C) sind **bewusst eigene Specs** ([[deploy-lifecycle]], [[cloudflare-reconciliation]]) — diese View bleibt Inventar+Lösch-Werkzeug.

## Zweck
Eine eigenständige Ansicht zum **Inventarisieren und Bereinigen** der bei Cloudflare verwalteten Domänen/Tunnel: der Betreiber wählt eine Zone an, sieht deren Tunnel + Public-Hostname-Routen und kann einzelne **löschen**. Die Ansicht konsumiert ausschließlich provider-agnostische Read-Models + `protected`-Flags (`CloudflareApi`, ADR-010) und kennt keinen Cloudflare-API-Token.

## Verhalten

### Gerüst (bestehend, v1)
1. Die Cloudflare-Ansicht ist über die Kachel *Cloudflare* und über die Route `cloudflare` erreichbar ([[app-shell-navigation]]) und trägt den Titel „Cloudflare".
2. Navigation/Home-Rückkehr funktioniert aus dieser Ansicht.

### Inventar (v2 — Capability A)
3. Die Ansicht listet die **verwalteten Zones/Domänen** (`GET /api/cloudflare/zones`, live). Ist Cloudflare nicht konfiguriert (kein Token/Account-Id), zeigt sie einen Onboarding-Hinweis mit Verweis auf die Settings-/Credentials-Sektion ([[settings-credentials]]) — **kein** Cloudflare-API-Aufruf.
4. Der Nutzer wählt eine Zone an → die Ansicht lädt deren **Tunnel + Public-Hostname-Routen** (`GET /api/cloudflare/zones/{zoneId}/tunnels`); je Route werden mindestens Hostname, Ziel-Service und ein `protected`-Flag angezeigt.
5. **Protected-Ressourcen** (eigene `devgui`-Erreichbarkeit ODER Cloudflare-Access-Mauer, ADR-011) werden als **gesperrt** markiert und bieten **keine** Lösch-Affordance (Button fehlt/disabled mit Begründung „geschützt: eigene Erreichbarkeit").
6. **Löschen** einer nicht-protected Route/eines Tunnels erfordert einen **type-to-confirm**-Schritt: der Nutzer tippt den exakten Hostname; erst dann ist der Lösch-Request möglich. Die Ansicht ruft `DELETE /api/cloudflare/tunnels/{tunnelId}/routes/{hostname}` (Route) bzw. `DELETE /api/cloudflare/tunnels/{tunnelId}` (ganzer Tunnel) mit `confirm: "<hostname>"`.
7. Liefert eine Zone/ein Tunnel beim Auflisten einen Fehler, **degradiert** die Ansicht: die übrigen Zonen/Tunnel bleiben sichtbar, der gestörte Bereich wird markiert (kein leerer Voll-Fehler).
8. Nach einer Löschung aktualisiert die Ansicht die Liste (Re-Fetch); ein Fehler wird klar gemeldet, ohne Geheimnisse zu zeigen.

### Reconciliation-Statusmeldungen + Report (v2 — read-only, ADR-013)
9. Die Ansicht zeigt einen **read-only Bereich „Reconciliation"** mit (a) den letzten internen **Statusmeldungen** des Reconciliation-Crons (`GET /api/deployments/reconcile/notices`: angelegt / gelöscht / protected-übersprungen / Fehler, je mit Hostname + VPS + Zeit) und (b) dem **letzten `ReconcileReport`** (`GET /api/deployments/reconcile/last`: je VPS/Provider geprüfte Container, angelegte/gelöschte Routen, protected-übersprungene, unmanaged, Fehler). Beides ist **read-only** — die Heilung selbst läuft im Cron/headless ([[cloudflare-reconciliation]]).
10. Die Ansicht bietet einen **manuellen „jetzt abgleichen"-Trigger** (`POST /api/deployments/reconcile`), der einen Ad-hoc-Lauf auslöst; nach Abschluss aktualisiert sie die Statusmeldungen + den Report (Re-Fetch). Der Trigger ist serverseitig identitäts-/rollengeschützt (403 → klare „keine Berechtigung"-Meldung).

## Acceptance-Kriterien

### Gerüst (bestehend — unverändert gültig)
- **AC1** — Die Cloudflare-Ansicht ist über die *Cloudflare*-Kachel und per Deep-Link (Route `cloudflare`) erreichbar und zeigt einen erkennbaren Titel „Cloudflare".
- **AC2** — Aus der Ansicht ist die Rückkehr zum Einstiegs-Panel und der Wechsel zu jeder anderen Ansicht möglich.
- **AC3** — Ist Cloudflare nicht konfiguriert, rendert die Ansicht einen Onboarding-Hinweis (Verweis auf Settings) und löst **keinen** Cloudflare-API-Aufruf aus.

### Inventar (v2)
- **AC4** — Die Ansicht ruft `GET /api/cloudflare/zones` ab und listet die verwalteten Zones/Domänen; eine anwählbare Zone lädt ihre Tunnel + Public-Hostname-Routen über `GET /api/cloudflare/zones/{zoneId}/tunnels`.
- **AC5** — Je Route werden Hostname, Ziel-Service und das `protected`-Flag angezeigt; eine **protected** Route bietet **keine** Lösch-Affordance (kein/disabled Button, mit Begründung).
- **AC6** — Das Löschen einer **nicht-protected** Route/eines Tunnels ist nur nach **type-to-confirm** (exakter Hostname getippt) möglich; ohne korrekten Confirm-Wert ist der Lösch-Aktion deaktiviert/abgelehnt. Erfolg → die Route/der Tunnel verschwindet nach Re-Fetch aus der Liste.
- **AC7** — Meldet eine Zone/ein Tunnel einen Fehler, zeigt die Ansicht die übrigen weiter und kennzeichnet den gestörten Bereich (degradiert), statt die ganze Übersicht auf Fehler zu setzen.
- **AC8** — **Kein** Cloudflare-Token/Account-Id erscheint im Frontend (nur Status/Meldungen aus den Backend-Antworten).

### Reconciliation-Anzeige (v2 — read-only, ADR-013)
- **AC10** — Die Ansicht zeigt die letzten internen Reconciliation-**Statusmeldungen** (`GET /api/deployments/reconcile/notices`) mit `kind` (`route-created` | `route-removed` | `protected-skipped` | `error`), Hostname, VPS und Zeit, **read-only**; sie enthält **keine** Secrets. Ist nichts vorhanden, zeigt sie einen neutralen Leer-Zustand.
- **AC11** — Die Ansicht zeigt den **letzten `ReconcileReport`** (`GET /api/deployments/reconcile/last`) read-only (je VPS/Provider: geprüfte Container, angelegte/gelöschte Routen, protected-übersprungene, unmanaged, Fehler) und bietet einen **manuellen „jetzt abgleichen"-Trigger** (`POST /api/deployments/reconcile`); nach Abschluss werden Statusmeldungen + Report neu geladen. 403 → „keine Berechtigung", Fehler ohne Secret-Leak.

### Sicherheit / A11y
- **AC9** — Die Ansicht ist hinter der Access-Mauer; sie führt **keine** Cloudflare-Token mit (alle Secrets bleiben im Backend/`CredentialStore`). Lösch-Aktionen sind serverseitig zusätzlich identitäts-/rollengeschützt (ADR-010/011) — die UI behandelt 403 als klare „keine Berechtigung"-Meldung, 422 `protected-resource` als „geschützt", 422 `confirmation-required` als „Bestätigung nötig".

## Verträge
> Pfade/Felder kanonisch; Boundary-Detail in **ADR-010/011** (`CloudflareApi`, `LockoutGuard`).

- Konsumiert das Container-Gerüst aus [[app-shell-navigation]] (Route `cloudflare`, Navigation, Home).
- **GET `/api/cloudflare/zones`** → `{ configured: boolean, zones: CfZone[], errors?: [{ scope, errorClass }] }`. `CfZone = { id, name, status }`.
- **GET `/api/cloudflare/zones/{zoneId}/tunnels`** → `{ tunnels: CfTunnel[], routes: CfRoute[], errors?: [...] }`. `CfTunnel = { id, name, status, zoneId }`; `CfRoute = { hostname, service, tunnelId, protected: boolean }`.
- **DELETE `/api/cloudflare/tunnels/{tunnelId}/routes/{hostname}`** — Body `{ confirm: "<hostname>" }` → `{ result: "ok"|"error", reason? }`. Protected → 422 `protected-resource`; fehlender/falscher Confirm → 422 `confirmation-required`.
- **DELETE `/api/cloudflare/tunnels/{tunnelId}`** — Body `{ confirm: "<tunnelname-oder-hostname>" }` → `{ result, reason? }`; protected (enthält eine protected Route) → 422 `protected-resource`.
- **GET `/api/deployments/reconcile/notices?limit=N`** → die letzten N `ReconcileNotice` (`{ at, kind, vps, hostname, detail? }`, ADR-013/[[data-model]]) für die read-only Statusmeldungs-Anzeige; **keine** Secrets. Hinter Access.
- **GET `/api/deployments/reconcile/last`** → letzter `ReconcileReport` (ADR-013/[[data-model]]) für die read-only Report-Anzeige. Hinter Access.
- **POST `/api/deployments/reconcile`** → manueller „jetzt abgleichen"-Trigger; hinter Access + `CRED_ADMIN_EMAILS`-Rolle + Audit (Vertrag in [[cloudflare-reconciliation]]).
- **Token-Quelle:** Cloudflare-API-Token + Account-Id aus dem `CredentialStore` (`credentials/cloudflare/api_token`, `credentials/cloudflare/account_id`, siehe [[settings-credentials]]); store-intern, transient pro Aufruf, nie persistiert außerhalb des Stores, nie im Frontend.
- Alle Endpunkte hinter AccessGuard; mutierende zusätzlich identitäts-/rollengeprüft (`CRED_ADMIN_EMAILS`-Logik) + AuditEntry (vgl. [[access-and-guardrails]]).

## Edge-Cases & Fehlerverhalten
- Aufruf ohne Access-Cookie → die bestehende Access-Mauer greift davor.
- Cloudflare nicht konfiguriert → Onboarding-Hinweis, kein API-Call (AC3).
- Cloudflare-Auth fehlgeschlagen (ungültiger Token) → 502 `cloudflare-auth-failed`, ohne Token-Leak, auditiert.
- Lösch-Ziel ist die eigene `devgui`-Route / Access-Mauer → **422 `protected-resource`**, keine Mutation (ADR-011), nicht überschreibbar (auch nicht mit korrektem Confirm/Admin-Rolle).
- Lösch-Request ohne/mit falschem `confirm`-Wert → **422 `confirmation-required`**, keine Mutation.
- Einzelne Zone/Tunnel unerreichbar → degradiert (AC7), übrige bleiben sichtbar.
- Backend nicht erreichbar/inkonsistent → 5xx ohne Token-/Teil-Leak.

## NFRs
- **A11y (WCAG 2.1 AA):** Titel als Überschrift; Listen/Tabellen mit Header; Lösch-Buttons beschriftet, protected-Status für Screenreader erkennbar; type-to-confirm-Feld beschriftet, Fehler programmatisch zugeordnet; sichtbarer Fokus.
- **Sicherheit (Floor, hart):** Tunnel-/Routen-/DNS-mutierende Aktionen sind hoch-privilegiert (können die eigene Erreichbarkeit + Zugangsmauer betreffen) — serverseitig auditiert, identitäts-/rollengeschützt, mit Self-Lockout-Hard-Block (ADR-011) + type-to-confirm. Cloudflare-API-Token **nie** im Frontend-Bundle/Log/WS-Stream/Audit (durchgesetzt im Backend, ADR-010).

## Nicht-Ziele
- **Deploy-Lifecycle** (Image→Container+Route als Einheit) → eigene Spec [[deploy-lifecycle]] / eigene View (`deployments`), nicht in diese Ansicht gedrängt.
- **Reconciliation-Cron-Logik** (Abgleich/Heilung selbst) → [[cloudflare-reconciliation]]; diese View **zeigt** nur dessen Statusmeldungen + letzten Report read-only an und bietet den manuellen Trigger.
- **Migration** der Bestands-Tunnel von local-config auf remote-managed → operative Betreiber-Entscheidung (ADR-010, OFFENE ENTSCHIEDUNG O1).
- Cloudflare-Billing, WAF/Firewall-Regeln, Page-Rules, vollständige DNS-Verwaltung jenseits der Tunnel-CNAMEs.

## Abhängigkeiten
- [[app-shell-navigation]] (Container/Routing).
- [[settings-credentials]] (Cloudflare-API-Token + Account-Id im `CredentialStore`).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität).
- [[cloudflare-reconciliation]] (Quelle der `ReconcileNotice`/`ReconcileReport`, ADR-013) + [[data-model]] (deren kanonische Felder).
- `docs/architecture.md` — **`CloudflareApi`-Boundary in ADR-010** (SDK-frei via `fetch`, remote-managed Tunnels, Token transient store-intern, live + degradierend); **`LockoutGuard` in ADR-011** (Self-Lockout-Hard-Block + type-to-confirm); **`ReconciliationJob` in ADR-013** (beidseitig selbst-heilend; Panel-Statusmeldung + Report über `AuditStore`).
