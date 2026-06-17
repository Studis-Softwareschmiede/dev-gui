---
id: vps-tunnel-provisioning
title: VPS Cloudflare-Tunnel-Provisionierung (1 Tunnel/VPS, cloudflared)
status: draft
version: 1
---

# Spec: VPS Cloudflare-Tunnel-Provisionierung (`vps-tunnel-provisioning`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Security-kritisch (Tunnel-Token ist ein Geheimnis).

## Zweck
Jeder VPS bekommt **beim Anlegen automatisch genau einen Cloudflare-Tunnel** (1 Tunnel/VPS), auf dem `cloudflared` als Dienst läuft. Damit werden später deployte Apps des VPS über Cloudflare aus dem Internet erreichbar (Routen/DNS legt das Deploy in Paket ② an). Diese Spec definiert (a) das Anlegen eines **named, remote-managed Tunnels** über die Cloudflare-API inklusive sicherem Umgang mit dem **Tunnel-Token**, und (b) die **Provisionierung von `cloudflared`** auf dem frisch erstellten VPS, sowie (c) die **Zuordnung** von Tunnel-ID/Token-Referenz zum VPS, damit Paket ② die `tunnelId` kennt.

> **Abgrenzung:** Diese Spec liefert den **Tunnel-Lifecycle beim Create** (Tunnel anlegen + cloudflared installieren/starten + Zuordnung). Das **cloud-init-Default-Setup** (Update/Docker/User) ist in [[vps-cloud-init-setup]]; die **Provider-Create-Boundary** in [[vps-provider-boundary]]; das **Aufräumen beim VPS-Löschen** in [[vps-delete]]; das **Routen-/DNS-Anlegen pro App-Deploy** in [[cloudflare-reconciliation]] / Paket ② (Nicht-Ziel hier). Der einzige Ort, der die Cloudflare-API spricht, bleibt `CloudflareApi` (ADR-010).

## Verhalten
1. **Tunnel anlegen (`createTunnel`):** Eine neue Methode auf `CloudflareApi` legt über die Cloudflare-API einen **named Tunnel** an (`POST /accounts/{accountId}/cfd_tunnel`, configured **remote-managed** — kein lokaler Credentials-Datei-Modus). Sie liefert die **Tunnel-ID** und das **Tunnel-Token** (Connector-Token) zurück.
2. **Token-Geheimhaltung:** Das Tunnel-Token ist ein **Geheimnis** (gleicher Floor wie alle `CloudflareApi`-Mutationen / der Provider-Token-Floor): es erscheint **niemals** in Log, Audit, WS-Stream, Argv, Response an den Client, Fehlermeldung oder Frontend-Bundle. Der Aufrufer legt das Token im `CredentialStore` ab; `createTunnel` selbst persistiert nichts und cached nichts (per-request Credential-Auflösung, ADR-010).
3. **cloudflared auf dem VPS:** Beim **Create-from-scratch** ([[vps-provider-boundary]] AC7) wird — nach dem bestehenden cloud-init-Default-Setup (Docker/User/SSH, [[vps-cloud-init-setup]]) — für den neuen VPS automatisch (a) ein Tunnel via `createTunnel` angelegt (Name **`devgui-<vpsname>`**), (b) das Tunnel-Token **sicher** auf den VPS gebracht und (c) **`cloudflared` installiert und als Dienst gestartet** (token-basiert, remote-managed). Der Mechanismus (cloud-init mit sicherem Token-Handling **oder** post-create per SSH über `VpsProvisioner`/`VpsDockerControl`) wird von `architekt`/`coder` gewählt; verbindlich ist nur, dass das Token **nicht im Klartext-Log/Argv** landet.
4. **Zuordnung VPS ↔ Tunnel:** Die erzeugte **Tunnel-ID** und eine **Token-Referenz** (CredentialStore-Schlüssel, nicht das Token selbst) werden dem VPS zugeordnet (Provider-Label/Metadatum oder store-interne Map), sodass Paket ② (App-Deploy) und [[vps-delete]] (Aufräumen) die `tunnelId` des VPS auflösen können.
5. **Tunnel-Name-Eindeutigkeit:** Der Tunnel-Name wird aus dem VPS-Namen abgeleitet (`devgui-<sanitized-vpsname>`); kollidiert er provider-/account-seitig, schlägt `createTunnel` mit klarer Meldung fehl, ohne ein halb angelegtes Geheimnis zu hinterlassen.
6. **Idempotenz/Abbruch:** Schlägt das cloudflared-Setup auf dem VPS fehl, bleibt der Tunnel zwar account-seitig angelegt; der Create-Pfad meldet einen klaren Teil-Fehler, und das angelegte Token ist im `CredentialStore` referenziert (kein verwaistes, unreferenziertes Geheimnis). Wiederholtes Anlegen erzeugt keinen Doppel-Tunnel mit identischem Namen ohne Fehlermeldung.

## Acceptance-Kriterien

### createTunnel (CloudflareApi)
- **AC1** — `CloudflareApi.createTunnel(name)` ruft `POST /accounts/{accountId}/cfd_tunnel` (configured remote-managed) auf und liefert `{ tunnelId, token }` zurück. Account-ID + API-Token werden per-request store-intern aufgelöst (ADR-010); nicht konfiguriert (kein API-Token/Account-ID) → `CloudflareApiError('cloudflare-not-configured', 422)` **ohne** API-Call (analog der bestehenden Mutate-Methoden).
- **AC2** — Das zurückgegebene **Tunnel-Token** erscheint **niemals** in einer geworfenen Fehlermeldung, in `console`-Logs, im Audit, im WS-Stream, in Argv oder in einer HTTP-Response an den Client. Der API-Token geht ausschließlich in den `Authorization: Bearer`-Header (bestehender `CloudflareApi`-Floor). Testbar: Fehler-/Log-Pfade enthalten weder Tunnel-Token noch API-Token.
- **AC3** — Cloudflare-API-Fehler werden wie bei den übrigen `CloudflareApi`-Methoden klassifiziert: 401/403 → `cloudflare-auth-failed` (502, ohne Token-Leak), Timeout/429/5xx → `cloudflare-unavailable` (503/502), `success:false` → `cloudflare-unavailable` (bzw. `cloudflare-auth-failed` bei Auth-Fehlercode). Per-request AbortController-Timeout greift (js/R03).
- **AC4** — Eine `deleteTunnel(tunnelId)`-Methode existiert (bereits vorhanden) und wird wiederverwendet; `createTunnel` legt keinen eigenen Lösch-Pfad an.

### cloudflared-Provisionierung beim Create
- **AC5** — Beim erfolgreichen `POST /api/vps/machines/{provider}` (Create) wird genau **ein** Tunnel mit Name **`devgui-<sanitized-vpsname>`** via `createTunnel` angelegt; der VPS-Create-Pfad bringt das Tunnel-Token sicher auf den VPS und installiert + startet `cloudflared` als Dienst (token-basiert, remote-managed). Testbar an der gewählten Mechanik (cloud-init-Dokument enthält den cloudflared-Install/-Start-Schritt **oder** der post-create-SSH-Pfad führt ihn aus).
- **AC6** — Das Tunnel-Token wird beim Transport auf den VPS **nicht im Klartext in ein Log oder in Argv** geschrieben (z.B. nicht als `cloudflared service install <TOKEN>` in einem geloggten Befehl, sondern via Datei/`write_files` mit `defer`/Env mit Redaction). Testbar: kein Log-/Argv-Pfad gibt das Token aus; falls cloud-init genutzt wird, steht das Token nur als YAML-Wert in einer `write_files`-Datei, nie in einem geloggten `runcmd`-Echo.
- **AC7** — Nach erfolgreichem Create sind dem VPS die **Tunnel-ID** und eine **Token-Referenz** (CredentialStore-Schlüssel, **nicht** das Token-Material) zugeordnet, sodass die `tunnelId` eines VPS später (Paket ②, [[vps-delete]]) auflösbar ist. Testbar: die Zuordnung ist über die gewählte Persistenz/Label-Mechanik abrufbar und enthält **kein** Token-Material.
- **AC8** — Das Tunnel-Token wird im `CredentialStore` (verschlüsselt at rest, ADR-007) abgelegt; es erscheint nicht in der Create-Response, im Maschinen-Read-Model (`VpsMachine`), im Audit oder im Frontend-Bundle. Testbar: Create-Response + `VpsMachine` enthalten kein Token.

### Fehler/Resilienz (Floor)
- **AC9** — Schlägt `createTunnel` fehl (z.B. `cloudflare-not-configured`, `cloudflare-auth-failed`), wird **kein** VPS-orphan-Geheimnis hinterlassen und der Create-Pfad meldet einen klaren Fehler; ist Cloudflare nicht konfiguriert, ist das Verhalten beim Create klar definiert. **Gewählte Variante (S-152, coder-Entscheid):** Bei `cloudflare-not-configured` → Create läuft **ohne Tunnel** weiter (kein Crash, kein 422); VPS wird ohne cloudflared angelegt, Console-Log ohne Secret. Bei anderen CF-Fehlern (`cloudflare-auth-failed`, Netzfehler) → Create **bricht ab** (Fehler wird weiter geworfen). Getestet in `VpsProviderRegistry.test.js` (S-152-Tunnel-Block, AC9).
- **AC10** — Schlägt das cloudflared-Setup **auf dem VPS** fehl (Laufzeit), bleibt der account-seitig angelegte Tunnel **referenziert** (Token im Store, ID dem VPS zugeordnet) — kein verwaistes, unreferenziertes Geheimnis. (Die Laufzeit-Verifikation auf dem Server selbst ist Nicht-Ziel der Backend-Garantie, analog [[vps-cloud-init-setup]].)

## Verträge
> Konkrete cloudflared-Install-Schritte (apt-Repo vs. `.deb`, `cloudflared service install`) und das exakte Token-Transport-Verfahren wählt `architekt`/`coder`; die ACs prüfen die Garantien, nicht die Zeilenform.

- **`CloudflareApi.createTunnel(name)`** → `{ tunnelId: string, token: string }`. Token ist Connector-/Tunnel-Token (remote-managed). Wirft `CloudflareApiError(errorClass, httpStatus)` analog der übrigen Methoden.
- **Cloudflare-Endpunkt:** `POST {CF_BASE}/accounts/{accountId}/cfd_tunnel` mit `{ name, config_src: "cloudflare" }` (remote-managed); Antwort liefert `result.id` (Tunnel-ID) und `result.token` (bzw. nachgelagerter Token-Abruf, falls die API ihn nicht direkt im Create liefert — `coder`-Recherche-Touchpoint).
- **Tunnel-Name:** `devgui-<sanitized-vpsname>` (sanitize wie Hostname: lowercase, nur `[a-z0-9-]`).
- **CredentialStore-Schlüssel (Vorschlag):** `credentials/cloudflare/tunnel_token/<tunnelId>` (Token, geheim, verschlüsselt). Token-Referenz = dieser Schlüssel; **nie** das Token selbst als VPS-Label.
- **VPS-Zuordnung:** Tunnel-ID + Token-Referenz dem VPS via Provider-Label/Metadatum **oder** store-interner Zuordnung; abrufbar für Paket ② + [[vps-delete]].
- **Create-Pfad:** Erweiterung von `POST /api/vps/machines/{provider}` ([[vps-provider-boundary]] AC7) — Tunnel-Provisionierung läuft als Teil des Create, audit-first wie die übrige Mutation.

## Edge-Cases & Fehlerverhalten
- Cloudflare nicht konfiguriert → `createTunnel` 422 `cloudflare-not-configured`, kein API-Call; VPS-Create läuft ohne Tunnel (AC9-Variante: skip + log, kein 422).
- Cloudflare-Auth fehlgeschlagen → 502 `cloudflare-auth-failed`, ohne Token-Leak, auditiert.
- Tunnel-Name-Kollision → klare Fehlermeldung, kein halb angelegtes Geheimnis.
- cloudflared-Install auf dem VPS schlägt zur Laufzeit fehl → Teil-Fehler gemeldet, Tunnel bleibt referenziert (AC10).
- Token-Transport: niemals Token in geloggtem `runcmd`/Argv (AC6).

## NFRs
- **Sicherheit (Floor, hart):** Tunnel-Token + API-Token nie in Log/Audit/WS/Argv/Response/Bundle; Token at rest verschlüsselt (ADR-007). `CloudflareApi` bleibt einziger Cloudflare-API-Sprecher (ADR-010, Grep-prüfbar).
- **Reproduzierbarkeit:** ein Tunnel pro VPS, deterministischer Name aus dem VPS-Namen.
- **Wartbarkeit:** Tunnel-Lifecycle (create/delete) zentral in `CloudflareApi`, cloudflared-Provisionierung in einer Stelle (cloud-init-Vorlage **oder** Provisioner), nicht über Adapter verstreut.

## Nicht-Ziele
- **Routen/DNS pro App-Deploy** (Paket ②, [[cloudflare-reconciliation]]) — diese Spec legt nur den Tunnel + cloudflared an, keine Public-Hostname-Routen.
- Laufzeit-Verifikation auf dem Server, dass cloudflared dauerhaft verbunden ist (nur korrektes Setup wird garantiert).
- Mehrere Tunnels pro VPS / konfigurierbare Tunnel-Profile (genau 1 Tunnel/VPS in diesem Durchgang).

## Abhängigkeiten
- [[vps-provider-boundary]] (Create-Pfad, in den die Tunnel-Provisionierung integriert wird).
- [[vps-cloud-init-setup]] (cloudflared-Abschnitt, falls cloud-init-Variante gewählt; TEMPLATE_VERSION-Erhöhung).
- [[view-cloudflare]] / [[cloudflare-reconciliation]] (CloudflareApi-Boundary + Routen/DNS in Paket ②).
- [[vps-delete]] (Aufräumen des Tunnels beim VPS-Löschen).
- [[settings-credentials]] (Cloudflare-API-Token + Account-ID + Tunnel-Token im `CredentialStore`).
- `docs/architecture.md` — ADR-010 (`CloudflareApi` als einziger Cloudflare-API-Sprecher), ADR-007 (CredentialStore), ADR-009 (VPS-Boundary/cloud-init-Owner).
