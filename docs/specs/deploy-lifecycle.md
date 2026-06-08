---
id: deploy-lifecycle
title: Deploy-Lifecycle — Container + Tunnel-Route als atomare Einheit (Capability B)
status: draft
version: 1
---

# Spec: Deploy-Lifecycle (`deploy-lifecycle`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). Security-kritisch (SSH-on-VPS + Cloudflare-Mutation, Self-Lockout-Risiko).
> Boundaries fixiert in **ADR-012** (`DeployOrchestrator` + `VpsDockerControl`), Cloudflare-Pfad in **ADR-010**, Self-Lockout-Schutz in **ADR-011**. Die produktive, panel-steuerbare Variante des heutigen `preview`-Skill-Mechanismus (ghcr-Image → Container → Tunnel-Route + DNS-CNAME).

## Zweck
**Capability B des Cloudflare-Vorhabens:** ein ghcr-Image als Docker-Container auf einem laufenden VPS **plus** die zugehörige Cloudflare-Tunnel-Route zur Domäne als **eine atomare Einheit** anlegen (Deploy); das Entfernen des Containers entfernt auch Route + DNS (Undeploy). Bewusst eine **eigene** Komponente/View (`deployments`) — die Cloudflare-Ansicht ([[view-cloudflare]]) bleibt Inventar+Lösch-Werkzeug.

> **Abgrenzung:** Diese Spec liefert die Deploy/Undeploy-Orchestrierung. Der **Cloudflare-Route-Teil** läuft über `CloudflareApi` ([[view-cloudflare]] / ADR-010, remote-managed Tunnels — kein SSH für Routen). Der **Container-Teil** läuft über die neue `VpsDockerControl`-Boundary (`docker pull/run/rm` via SSH, ADR-008-Linie). Der **Server-Lifecycle** (Maschine starten/stoppen/erstellen) bleibt in [[vps-provider-boundary]] und wird hier **nicht** dupliziert.

## Verhalten
1. Das Backend stellt eine **Deployments**-Capability bereit: eine Liste der aktiven Deploys (Container+Route als Einheit) je konfiguriertem VPS, sowie Deploy und Undeploy.
2. **Container↔Route-Bindung** erfolgt store-los über das Container-Label **`cloudflare.tunnel-hostname=<hostname>`** — die einzige Bindung zwischen Container und Tunnel-Route, von beiden Seiten live abgleichbar (kein eigener Deploy-Store, ADR-005-Linie).
3. **Deploy** `{image, vps, hostname}`: (a) **LockoutGuard-Check** auf `hostname` (protected → abgelehnt, kein Schritt); (b) `VpsDockerControl` pullt das ghcr-Image und startet den Container auf dem VPS mit dem Bindungs-Label; (c) `CloudflareApi` legt die Tunnel-Route (`PUT …/configurations`) + DNS-CNAME `<hostname>` an. **Saga-Rollback:** schlägt (c) fehl, wird der Container aus (b) wieder entfernt (kein verwaister Container ohne Route); schlägt (b) fehl, wird (c) nicht versucht.
4. **Undeploy** `{vps, hostname}`: (a) LockoutGuard-Check (protected → abgelehnt); (b) **type-to-confirm** (Hostname tippen); (c) Route + DNS-CNAME entfernen (`CloudflareApi`); (d) Container `rm` (`VpsDockerControl`). Reihenfolge Route-zuerst, damit kein Traffic auf einen entfernten Container zeigt.
5. **Live-Bestand:** die Deploy-Liste wird live ermittelt — `VpsDockerControl` listet Container mit `cloudflare.tunnel-hostname`-Label je VPS, `CloudflareApi` listet die Routen; der Schnitt ist der gesunde Bestand, Drift (Container ohne Route / Route ohne Container) wird sichtbar gemacht (und vom Reconciliation-Cron, [[cloudflare-reconciliation]], **beidseitig geheilt**: verwaiste Route gelöscht, managed Container ohne Route → Route angelegt über genau diesen Anlege-Pfad).
6. Alle mutierenden Aktionen (Deploy/Undeploy) sind **hoch-privilegiert**: hinter Access, identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`-Logik), audit-first, LockoutGuard-Hard-Block.

## Acceptance-Kriterien

### Boundary & Bindung
- **AC1** — Es existiert **genau eine** Boundary (`DeployOrchestrator`), die Container- und Route-Schritt zu einer Einheit koppelt, und **genau eine** (`VpsDockerControl`), die **schreibende** `docker`-Kommandos auf einem VPS via SSH ausführt; kein anderes Modul tut beides (Grep-prüfbar, analog R01). Read-only-Docker bleibt beim lokalen `DockerReader`.
- **AC2** — Jeder Deploy-Container trägt das Label `cloudflare.tunnel-hostname=<hostname>` (testbar: `docker inspect` zeigt das Label); dieses Label ist die maßgebliche Container↔Route-Bindung (kein Deploy-State-Store).

### Deploy (atomare Einheit)
- **AC3** — `POST /api/deployments {image, vps, hostname}` erstellt Container **und** Tunnel-Route + DNS-CNAME; bei Erfolg ist `<hostname>` über den remote-managed Tunnel auf den Container geroutet und das Ergebnis `{ result: "ok", deployment }`.
- **AC4** — Schlägt der **Route-Schritt** fehl, wird der bereits gestartete Container rückabgewickelt (`docker rm`) → **kein verwaister Container ohne Route** (testbar im Saga-Test mit Cloudflare-Fehler-Mock). Schlägt der **Container-Schritt** fehl, wird kein Route-Schritt versucht; in beiden Fällen `{ result: "error", reason }` ohne Teil-/Geheim-Leak.

### Undeploy (inverse Einheit)
- **AC5** — `DELETE /api/deployments/{vps}/{hostname}` (Body `{ confirm: "<hostname>" }`) entfernt Route + DNS-CNAME **und** den Container; nach Erfolg ist weder Route noch Container vorhanden. Reihenfolge: Route/DNS vor Container-`rm`.
- **AC6** — Undeploy ohne/mit falschem `confirm`-Wert → 422 `confirmation-required`, keine Mutation.

### Sicherheit & Audit (Floor)
- **AC7** — Deploy/Undeploy auf einen **protected** Hostname (eigene `devgui`/Access-Mauer, ADR-011) → 422 `protected-resource`, **kein** Docker- und **kein** Cloudflare-Schritt ausgeführt; nicht durch Identität/Confirm überschreibbar.
- **AC8** — Alle `/api/deployments/*`-Endpunkte hinter Access (403 ohne gültigen Access); mutierende zusätzlich identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`; 403 ohne Berechtigung).
- **AC9** — Jede mutierende Aktion erzeugt **vor** Ausführung einen Audit-Eintrag (Identität, vps, image, hostname, Aktion, Zeit); schlägt der Audit-Write fehl, unterbleibt die Aktion. **Kein** SSH-Private-Key und **kein** Cloudflare-Token erscheint je in Response, Logs, Audit, WS-Stream, Argv oder Frontend-Bundle (store-intern aus dem `CredentialStore`).

## Verträge
> Pfade/Felder kanonisch; Boundary-Detail in **ADR-012** (`DeployOrchestrator`, `VpsDockerControl`), **ADR-010** (`CloudflareApi`), **ADR-008** (SSH/`VpsProvisioner`-Linie).

> **Vertrags-Präzisierung (Spec-Gap-Resolution, analog O3):** `zoneId` wird server-seitig per Suffix-Match aus dem `hostname` aufgelöst (via `CloudflareApi.resolveZoneForHostname()` — längster Suffix-Match); der Client übergibt **keine** `zoneId`. `tunnelId` bleibt expliziter Parameter (pro Account können mehrere Tunnel existieren; eine eindeutige VPS→Tunnel-Bindung ist noch nicht spezifiziert — Frontend wählt per Dropdown/Auswahl aus den vorhandenen Tunneln). Kein Zone-Match → 422 `zone-not-found` (ohne Leak).

- **`Deployment` (Read-Model, live):** `{ vps, hostname, image, containerId?, hostPort?, status, routePresent: boolean, containerPresent: boolean }`. `hostPort` ist der gemappte Host-Port (additiv, kann null sein). Drift sichtbar über `routePresent`/`containerPresent`.
- **GET `/api/deployments?vps=<vpsId>&tunnelId=<tunnelId>`** → `{ deployments: Deployment[], errors?: [{ scope, errorClass }] }` (degradiert pro VPS/Zone). Query-Parameter `vps` und `tunnelId` sind Pflicht.
- **POST `/api/deployments`** — Body `{ image, vps, hostname, tunnelId }` → `{ result: "ok"|"error", deployment?, reason? }`. (`zoneId` server-seitig aufgelöst.)
- **DELETE `/api/deployments/{vps}/{hostname}`** — Body `{ confirm: "<hostname>", tunnelId }` → `{ result: "ok"|"error", reason? }`. (`zoneId` server-seitig aufgelöst.)
- **Container-Label-Konvention:** `cloudflare.tunnel-hostname=<hostname>` (maßgeblich). Koexistenz mit `agent-flow.preview` / `agent-flow.compose-project` erlaubt (Wiederverwendung des `preview`-Mechanismus), aber `cloudflare.tunnel-hostname` ist die Reconcile-Bindung.
- **VPS-Referenz:** ein konfigurierter VPS (Ziel-Schema analog ADR-008 `{ host, port?, targetUser }`; SSH-Private-Key store-intern). **O3-Resolution:** Host-Port = erste freie ab 8080 (ermittelt via `ps()`). `VpsDockerControl` nutzt die SSH-Infrastruktur analog `VpsProvisioner`.
- **Token-/Key-Quelle:** Cloudflare-Token + Account-Id aus `credentials/cloudflare/*`; SSH-Private-Key aus `ssh/<user>/private_key` (ADR-007/008). Store-intern, transient, nie geleakt.
- Alle Endpunkte hinter AccessGuard; mutierende zusätzlich identitäts-/rollengeprüft + AuditEntry (mit `image`-Feld) + LockoutGuard (ADR-011).

## Edge-Cases & Fehlerverhalten
- Deploy/Undeploy auf protected Hostname → 422 `protected-resource` (ADR-011), kein Schritt.
- Cloudflare nicht konfiguriert / VPS-SSH nicht erreichbar → `{ result: "error", reason }`, kein Teil-Deploy zurückgelassen (Saga-Rollback bzw. kein Schritt).
- Image-Pull schlägt fehl (ghcr `denied`/nicht vorhanden) → kein Container, kein Route-Schritt, klare Fehlermeldung.
- Route-Schritt schlägt nach erfolgreichem Container-Start fehl → Container-Rollback (AC4).
- Undeploy ohne/falschen Confirm → 422 `confirmation-required`.
- Doppel-Deploy desselben Hostname → idempotenz-/Konflikt-Verhalten: bestehender Deploy wird ersetzt **oder** mit klarer Konflikt-422 abgelehnt (`coder` finalisiert; Default-Empfehlung: ersetzen analog `preview up`, das eine laufende Instanz ersetzt).
- Drift (Container ohne Route / Route ohne Container) wird in der Liste sichtbar und vom Cron ([[cloudflare-reconciliation]]) behandelt.

## NFRs
- **Sicherheit (Floor, hart):** SSH-Private-Key + Cloudflare-Token at rest verschlüsselt (CredentialStore/ADR-007), **nie** im Frontend-Bundle/Log/Audit/WS-Stream/Argv. Deploy/Undeploy auditiert + identitäts-/rollengeschützt + LockoutGuard-Hard-Block; destruktives Undeploy zusätzlich type-to-confirm.
- **Resilienz:** Deploy ist eine best-effort-Saga mit Kompensation (kein verwaister Container bei Route-Fehler); Rest-Drift fängt der Reconciliation-Cron.
- **ADR-005/006-Konformität:** kein Deploy-State-Store (live aus Docker-Label ⊕ Cloudflare-Route); kein neues SDK (Cloudflare via `fetch`, Docker via SSH-Linie ADR-008).

## Nicht-Ziele
- **Server-Lifecycle** (Maschine starten/stoppen/erstellen) → [[vps-provider-boundary]] (nicht hier).
- **Reconciliation-Cron** → [[cloudflare-reconciliation]].
- **Migration** der Bestands-Tunnel auf remote-managed → operativ (ADR-010 / O1).
- Build/Push des Images (ghcr-Image ist Source of Truth, wie im `preview`-Skill) — diese Capability **konsumiert** ein vorhandenes Image.
- Multi-Container-/Compose-Stacks pro Deploy (Erst-Durchgang: ein App-Container je Hostname).

## Abhängigkeiten
- [[view-cloudflare]] (`CloudflareApi`-Boundary, Route-/DNS-Mutation; ADR-010).
- [[vps-provider-boundary]] (welche VPS existieren — Maschinen-Read; Server-Lifecycle bleibt dort).
- [[settings-credentials]] (Cloudflare-Token), [[settings-ssh-keys]] (SSH-Private-Key für VpsDockerControl, ADR-008).
- [[cloudflare-reconciliation]] (fängt Drift; teilt `VpsDockerControl` + Label-Konvention).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität).
- `docs/architecture.md` — **`DeployOrchestrator` + `VpsDockerControl` in ADR-012**; `LockoutGuard` in ADR-011; SSH-Linie ADR-008.
