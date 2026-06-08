---
id: vps-provider-boundary
title: VPS-Provider-Boundary + Multi-Provider-Adapter (Hetzner, IONOS, Hostinger)
status: draft
version: 1
---

# Spec: VPS-Provider-Boundary + Multi-Provider-Adapter (`vps-provider-boundary`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). Security-kritisch (Provider-Tokens, Server-mutierende Aktionen).

## Zweck
Eine einzige Backend-Boundary, über die dev-gui Server bei **mehreren Cloud-Providern** (Hetzner, IONOS, Hostinger) verwaltet: Server **auflisten**, **starten**, **stoppen** und **neu provisionieren (Create-from-scratch)**. Die Boundary kapselt die provider-spezifischen APIs hinter einem stabilen, provider-agnostischen Vertrag (`VpsProvider`), sodass die VPS-Ansicht ([[view-vps]]) und höhere Schichten keinen Provider-Code kennen. Die Provider-API-Tokens kommen ausschließlich store-intern aus dem `CredentialStore` (ADR-007); sie verlassen das Backend niemals.

> **Abgrenzung:** Diese Spec liefert (a) den `VpsProvider`-Abstraktions-Boundary **und** (b) drei voll funktionsfähige Provider-Adapter mit echtem Lifecycle (list/start/stop/create). Die **Create-user-data-Mechanik** (cloud-init Default-Setup) ist in [[vps-cloud-init-setup]] spezifiziert; die **SSH-Key-Zuordnung root/alex** in [[vps-ssh-key-assignment]]; die **UI** in [[view-vps]]. Diese Spec definiert nur die Boundary-Verträge, die jene Specs konsumieren.
>
> **Item-Zerlegung:** In **Item #95** wird der **Hetzner-Adapter vollständig** implementiert. **IONOS** und **Hostinger** folgen als interface-kompatible, voll funktionsfähige Adapter in **#96** bzw. **#97**; in #95 sind sie als Stubs vorhanden, die den `VpsProvider`-Vertrag erfüllen (capabilities `false` bis zur vollständigen Implementierung). Die Gesamtlieferung (alle drei Adapter voll funktionsfähig) ist das Ziel der Items #95–#97 gemeinsam.

## Verhalten
1. Das Backend stellt **eine** Boundary `VpsProviderRegistry` bereit, die für jeden konfigurierten Provider (`hetzner`, `ionos`, `hostinger`) einen Adapter auflöst, der den gemeinsamen `VpsProvider`-Vertrag erfüllt.
2. Ein Provider gilt als **konfiguriert**, wenn sein API-Token im `CredentialStore` gesetzt ist (siehe [[settings-credentials]]). Nicht konfigurierte Provider werden in Listen-Antworten als `configured: false` ausgewiesen und lösen keinen Provider-API-Aufruf aus.
3. **Auflisten:** Für jeden konfigurierten Provider liefert die Boundary die laufenden/vorhandenen Server als provider-agnostische `VpsMachine`-Read-Models (kein eigener Store — live aus der Provider-API, analog ADR-005 für Read-Status).
4. **Starten / Stoppen:** Für einen identifizierten Server (`provider` + `serverId`) löst die Boundary die provider-spezifische Power-On- bzw. Power-Off-Aktion aus und meldet ein klares Ergebnis.
5. **Create-from-scratch:** Die Boundary erstellt einen neuen Server bei einem Provider mit den übergebenen Parametern (Region/Location, Servertyp/Plan, Image=Ubuntu 26.04 LTS) und übergibt die **user-data** (cloud-init aus [[vps-cloud-init-setup]]) sowie die SSH-Keys an die provider-spezifische Create-API.
6. **Lifecycle-Lücken provider-seitig:** Unterstützt ein Provider eine Lifecycle-Aktion API-seitig nicht (z.B. kein programmatisches Stop/Start für eine bestimmte Produktlinie), meldet der Adapter sie als **`unsupported`** (klar, nicht erzwingend simuliert) statt zu raten. Welche Aktion bei welchem Provider unsupported ist, wird im Adapter dokumentiert und ist über `GET /api/vps/providers` (Capability-Flags) abfragbar.
7. Alle mutierenden Aktionen (start/stop/create) sind **hoch-privilegiert**: hinter der Access-Mauer, identitäts-/rollengeschützt (gleiche `CRED_ADMIN_EMAILS`-Logik wie ADR-007) und **audit-first** (Audit-Eintrag vor Ausführung; schlägt der Audit-Write fehl → Aktion unterbleibt).

## Acceptance-Kriterien

### Boundary & Abstraktion
- **AC1** — Es existiert **genau eine** Boundary-Komponente, die Provider-API-Aufrufe ausführt; kein anderes Modul spricht direkt eine Provider-API an (Grep-prüfbar, analog R01 für `CredentialStore`). Jeder Provider-Adapter (`hetzner`, `ionos`, `hostinger`) implementiert denselben `VpsProvider`-Vertrag (list/start/stop/create + Capability-Flags).
- **AC2** — `GET /api/vps/providers` liefert je Provider `{ id, configured: boolean, capabilities: { list, start, stop, create } }`; ein Provider ohne gesetzten Token ist `configured: false` und löst **keinen** Provider-API-Aufruf aus.

### Auflisten (Read)
- **AC3** — `GET /api/vps/machines` aggregiert über **alle konfigurierten** Provider eine Liste provider-agnostischer `VpsMachine`-Read-Models live aus den Provider-APIs (kein persistenter Store für Maschinen-State).
- **AC4** — Ist ein einzelner Provider beim Auflisten nicht erreichbar oder liefert einen Fehler, **degradiert** die Aggregation: die übrigen Provider werden weiterhin gelistet, der fehlerhafte Provider wird als `error`/`unreachable` markiert (kein 500 für die Gesamt-Antwort, analog factory-status-Degradation).

### Start / Stop
- **AC5** — `POST /api/vps/machines/{provider}/{serverId}/start` bzw. `…/stop` löst beim adressierten Provider die Power-On-/Power-Off-Aktion aus und liefert ein klares Ergebnis `{ result: "ok"|"unsupported"|"error", reason? }`. Erfolg = der Server-Power-State wechselt provider-seitig (bzw. ist bereits im Zielzustand → idempotent `ok`).
- **AC6** — Unterstützt ein Provider start oder stop API-seitig nicht, liefert die Aktion `result: "unsupported"` mit klarer Begründung (HTTP 422) und löst keine destruktive Ersatzaktion aus.

### Create-from-scratch
- **AC7** — `POST /api/vps/machines/{provider}` erstellt mit `{ name, region, serverType, image }` einen neuen Server; das Backend übergibt die cloud-init-**user-data** ([[vps-cloud-init-setup]]) und die ausgewählten SSH-Public-Keys ([[vps-ssh-key-assignment]]) an die provider-spezifische Create-API. Default-`image` ist Ubuntu 26.04 LTS (provider-spezifischer Image-Slug); ein nicht verfügbares Image wird mit klarer 422-Meldung abgelehnt. **Hetzner-Annahme (Stand Juni 2026):** Der Slug `ubuntu-26.04` ist bei Hetzner noch nicht verfügbar (Ubuntu 26.04 LTS erscheint April 2026; Hetzner-Verfügbarkeit folgt einige Wochen später). Als Default-Slug wird `ubuntu-24.04` (Noble Numbat, aktuell letzter offizieller Ubuntu-LTS-Slug bei Hetzner) genutzt bis `ubuntu-26.04` verfügbar ist (Grep-Tag: `UBUNTU_26_04_SLUG` in `src/vps/providers/hetzner.js`).
- **AC8** — Die Create-Antwort liefert die neue Maschine als `VpsMachine` (mindestens `provider`, `serverId`, `name`, `status`, sofern bekannt `ipv4`); ein Create-Fehler verändert keinen bestehenden Server und meldet `result: "error"` mit Grund (kein Teil-/Geheim-Leak).

### Sicherheit & Audit (Floor)
- **AC9** — Alle `/api/vps/*`-Endpunkte sind hinter der Access-Mauer (403 ohne gültigen Access). Mutierende Aktionen (start/stop/create) sind zusätzlich identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`-Logik; 403 ohne Berechtigung).
- **AC10** — Jede mutierende Aktion erzeugt **vor** Ausführung einen Audit-Eintrag (Identität, Provider, serverId/Name, Aktion, Zeit); schlägt der Audit-Write fehl, unterbleibt die Aktion. Provider-API-Tokens erscheinen **nie** in Response, Logs, Audit, WS-Stream, Argv oder Frontend-Bundle (Tokens werden store-intern aus dem `CredentialStore` gezogen).

## Verträge
> Pfade/Felder kanonisch; konkrete Provider-SDK-/REST-Endpunkte, Image-/Plan-Slugs und Auth-Header sind **Provider-Recherche-Touchpoints** für `architekt`/`coder` (jede Provider-API hat eigene Auth, Produktlinien und Lifecycle-Semantik — IONOS/Hostinger ggf. neuere/abweichende APIs).

- **`VpsMachine` (Read-Model, provider-agnostisch):** `{ provider, serverId, name, status, ipv4?, ipv6?, region?, serverType?, createdAt? }`. `status` normalisiert auf `running | stopped | provisioning | error | unknown`. **Kanonisches Schema + Normalisierungsregeln: [[data-model]]** (fehlende Felder → `null`/`unknown`, nie Fehler; fixiert in `docs/architecture.md` ADR-009).
- **`VpsProvider`-Vertrag (intern, je Adapter):** `listMachines()` → `VpsMachine[]`; `start(serverId)` / `stop(serverId)` → `{ result, reason? }`; `create({ name, region, serverType, image, userData, sshPublicKeys })` → `VpsMachine`; `capabilities()` → `{ list, start, stop, create }`.
- **GET `/api/vps/providers`** → `[{ id, configured, capabilities }]`.
- **GET `/api/vps/machines`** → `{ machines: VpsMachine[], providerErrors?: [{ provider, errorClass }] }`.
- **POST `/api/vps/machines/{provider}`** — Body `{ name, region, serverType, image?, ...setup-Refs }` (Setup-/Key-Felder siehe [[vps-cloud-init-setup]] / [[vps-ssh-key-assignment]]) → `{ result, machine?, reason? }`.
- **POST `/api/vps/machines/{provider}/{serverId}/start`** / **`…/stop`** → `{ result: "ok"|"unsupported"|"error", reason? }`.
- **Token-Quelle:** je Provider ein API-Token aus dem `CredentialStore` unter `credentials/vps/<provider>_api_token` (siehe [[settings-credentials]]); store-intern konsumiert, transient pro Aufruf, nie persistiert außerhalb des Stores.
- Alle Endpunkte hinter AccessGuard; mutierende zusätzlich identitäts-/rollengeprüft + AuditEntry (vgl. [[access-and-guardrails]]).

## Edge-Cases & Fehlerverhalten
- Provider nicht konfiguriert (kein Token) → Listing markiert `configured: false`; mutierende Aktion → 422 `errorClass: "provider-not-configured"`, kein Provider-Call.
- Provider-API-Auth fehlgeschlagen (ungültiger Token) → 502 `errorClass: "provider-auth-failed"`, ohne Token-Leak, auditiert.
- Unbekannter `provider` (nicht in {hetzner, ionos, hostinger}) → 404/422.
- Unbekannter `serverId` beim Provider → 404 vom Adapter durchgereicht als `result: "error"`, `errorClass: "not-found"`.
- start auf bereits laufendem / stop auf bereits gestopptem Server → idempotent `result: "ok"` (kein Fehler).
- Lifecycle-Aktion provider-seitig nicht unterstützt → 422 `result: "unsupported"` (AC6).
- Provider-Rate-Limit/Timeout → 502/503 `errorClass: "provider-unavailable"`, Listing degradiert (AC4), Mutation als Fehler gemeldet (kein Teil-Zustand).
- Create mit ungültigem Image/Region/Servertyp → 422 mit klarer Meldung, kein Server erstellt.

## NFRs
- **Sicherheit (Floor, hart):** Provider-Tokens at rest verschlüsselt (CredentialStore/ADR-007), nie im Frontend-Bundle/Log/Audit/WS-Stream/Argv. Server-mutierende Aktionen (Kosten + Verfügbarkeit) auditiert + identitäts-/rollengeschützt.
- **Resilienz:** Read-Aggregation degradiert pro Provider (ein Provider-Ausfall kippt nicht die Gesamt-Antwort).
- **Provider-Neutralität:** höhere Schichten ([[view-vps]]) konsumieren nur `VpsMachine` + Capability-Flags, nie provider-spezifische Felder.

## Nicht-Ziele
- **Rebuild** (destruktives Neu-Aufsetzen eines bestehenden Servers) und **Backup/Snapshot** → bewusst vertagt, siehe [[vps-rebuild-backup]] (nur Platzhalter, keine Implementierung in diesem Durchgang).
- Provider-Billing/Kostenauswertung, DNS-Verwaltung, Volume-/Netzwerk-Management (jenseits des Create-Defaults).
- Eigener persistenter Maschinen-State-Store (Read bleibt live aus der Provider-API).

## Abhängigkeiten
- [[settings-credentials]] (Provider-API-Tokens je Provider im `CredentialStore`).
- [[vps-cloud-init-setup]] (user-data für Create).
- [[vps-ssh-key-assignment]] (SSH-Public-Keys für Create).
- [[view-vps]] (UI-Konsument).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität).
- `docs/architecture.md` — **`VpsProviderRegistry`/`VpsProvider`-Boundary in ADR-009 fixiert** (SDK-frei via eingebautes `fetch` je Provider; Adapter-Layout `src/vps/`; Token-Injektion transient store-intern ohne Persistenz; cloud-init-Owner = `CloudInitBuilder`; Normalisierung `VpsMachine`).
- [[data-model]] — kanonisches `VpsMachine`-Schema + Normalisierungsregeln.
