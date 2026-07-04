---
id: vps-tunnel-self-heal
title: "Tunnel neu anlegen & bestücken — Ein-Klick-Selbstheilung pro VPS (Capability B)"
status: draft
area: deployment
version: 1
---

# Spec: Tunnel-Selbstheilung pro VPS (`vps-tunnel-self-heal`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). **Security-kritisch**: legt einen Cloudflare-Tunnel an (Token = Geheimnis), pusht das Token per SSH auf den VPS und mutiert Cloudflare-Routen/DNS. Token NIE in Argv/Log/Audit/Response/WS.
> Boundaries: `CloudflareApi` (**ADR-010**, `createTunnel`/`addRoute`/`createDnsRecord`[idempotent]/`listRoutes`), `VpsProviderRegistry` (VPS↔Tunnel-Persistenz, `TUNNEL_ID_KEY`/`TUNNEL_TOKEN_KEY`, [[vps-tunnel-provisioning]]), `VpsDockerControl` (**ADR-012**, `ps`/Token-Push/cloudflared-Restart via SSH), `DeployOrchestrator` atomarer Route-Anlege-Pfad (**ADR-012**, `addRouteOnly`), `CredentialStore` (**ADR-007**), `LockoutGuard` (**ADR-011**), `AuditStore`.

## Zweck
**Capability B des selbstheilenden VPS-Tunnel-Vorhabens.** Wenn der Cloudflare-Tunnel eines VPS extern gelöscht wurde ([[vps-tunnel-existence-gate]] erkennt das als `tunnel-missing`), soll der Owner ihn **mit einem Klick** wiederherstellen — **ohne** den VPS neu zu bauen und **ohne** manuelles Nachpflegen. Pro VPS gibt es einen Knopf „Tunnel neu anlegen & bestücken", der in einem Rutsch:
1. einen **neuen Cloudflare-Tunnel** anlegt (`CloudflareApi.createTunnel`, Namens-Konvention `<vpsname>`), die gespeicherte `tunnelId` in der `VpsProviderRegistry` aktualisiert (alte tote Referenz ersetzen) und das neue Token im `CredentialStore` ablegt;
2. das **neue Token per SSH auf den VPS** schiebt — die env-file `/etc/cloudflared/env` ersetzt (`TUNNEL_TOKEN=<neu>`, `0600 root:root`) und den `cloudflared`-Docker-Container neu startet (sonst verbindet sich der VPS nie mit dem neuen Tunnel); Token nie in Argv/Log/Audit/Response/WS;
3. die laufenden **managed Container** des VPS ausliest (`VpsDockerControl.ps` → Hostname via Label `cloudflare.tunnel-hostname` + Host-Port) und für **jeden** Container am neuen Tunnel die **Route anlegt** (`addRoute`) + **CNAME setzt** (`createDnsRecord` ist idempotent → biegt bestehende CNAMEs auf den neuen Tunnel um) — über denselben atomaren Anlege-Pfad wie der Deploy/die Reconciliation.

Ergebnis: VPS wieder voll erreichbar, ohne VPS-Neubau.

> **Abgrenzung:** Diese Spec leistet die **manuelle Ein-Klick-Wiederherstellung**. Das **Erkennen/Blocken** eines toten Tunnels im Deploy ist [[vps-tunnel-existence-gate]] (Capability A); der **proaktive Drift-Push** ist [[vps-tunnel-drift-notify]] (Capability C). Der **Routen-Anlege-Pfad** wird vom `DeployOrchestrator` (ADR-012) wiederverwendet — **kein** duplizierter Cloudflare-Mutationscode. Das **Erst-Provisioning** beim VPS-Create bleibt [[vps-tunnel-provisioning]]; diese Capability ist der **Reparatur**-Pfad mit identischem Token-Floor.

## Verhalten
1. **Ein-Klick-Endpunkt.** Ein mutierender Endpunkt `POST /api/deployments/vps/{vpsId}/tunnel/recreate` (Access + `CRED_ADMIN_EMAILS`-Rolle + Audit-First + LockoutGuard) führt die drei Phasen sequenziell aus und liefert einen strukturierten, **secret-freien** Report.
2. **Phase 1 — Tunnel neu anlegen & Referenz ersetzen.**
   - `CloudflareApi.createTunnel("<sanitized-vpsname>")` → `{ tunnelId, token }` (remote-managed; Namens-/Sanitize-Konvention identisch zu [[vps-tunnel-provisioning]]).
   - Das neue **Token** wird im `CredentialStore` unter `TUNNEL_TOKEN_KEY(newTunnelId)` (`credentials/cloudflare/tunnel_token/<tunnelId>`) abgelegt; die gespeicherte `tunnelId` des VPS (`TUNNEL_ID_KEY(sanitize(vpsName))` = `credentials/misc/vps-<name>-tunnel-id`) wird **auf die neue Id aktualisiert** (alte tote Referenz ersetzt).
   - Die **alte** Token-Referenz wird best-effort aufgeräumt (`CredentialStore.delete(TUNNEL_TOKEN_KEY(oldTunnelId))`), sofern eine alte Id bekannt war; ein Fehler dabei kippt die Heilung nicht.
3. **Phase 2 — Token auf den VPS pushen & cloudflared neu starten (via SSH).**
   - Über `VpsDockerControl` (SSH-Linie, ADR-008/012) wird `/etc/cloudflared/env` auf dem VPS **ersetzt** mit Inhalt `TUNNEL_TOKEN=<neu>` (Permissions `0600`, owner `root:root`) und der **`cloudflared`-Docker-Container neu gestartet** (`docker restart cloudflared` bzw. `rm`+`run` mit demselben `--network host --env-file /etc/cloudflared/env`-Muster aus [[vps-cloud-init-setup]]).
   - **Token-Floor (hart):** das Token wird **nicht** als Argument/Argv übergeben und **nicht** geloggt — es fließt nur als **Dateiinhalt** (z.B. via stdin in ein `cat > /etc/cloudflared/env`-bash-`-s`-Muster wie die `VpsProvisioner`-`authorized_keys`-Logik), nie in einem geloggten `runcmd`/Echo. Kein Token in Argv, Log, Audit, Response, WS-Stream.
4. **Phase 3 — Routen bestücken.**
   - `VpsDockerControl.ps(vps)` listet die laufenden **managed** Container (Label `cloudflare.tunnel-hostname` → Hostname; Host-Port aus den `Ports`).
   - Für **jeden** managed Container wird die Route am **neuen** Tunnel angelegt + CNAME gesetzt — über den **atomaren Anlege-Pfad des `DeployOrchestrator`** (ADR-012, `addRouteOnly`: LockoutGuard-Check → `CloudflareApi.addRoute(newTunnelId, hostname, http://localhost:<hostPort>)` → `createDnsRecord(zoneId, hostname, newTunnelId)`). `createDnsRecord` ist **idempotent** → ein bestehender CNAME wird auf den **neuen** Tunnel umgebogen (kein Duplikat). **Kein** eigener Cloudflare-Mutationscode neben dem geteilten Pfad.
   - **Protected** Hostnamen werden **nie** angelegt (LockoutGuard-Hard-Block, ADR-011) → `protectedSkipped`.
5. **Bündelung wie Reconciliation-Heilung.** Phase 3 entspricht der „managed Container ohne Route → Route anlegen"-Heilung aus [[cloudflare-reconciliation]] (AC5), nur **gebündelt gegen den frischen Tunnel** und manuell ausgelöst.
6. **Degradation & Teil-Fehler.** Schlägt eine spätere Phase fehl, wird das bereits Erreichte **nicht** zurückgerollt (additive Heilung, kein destruktiver Rollback): der Tunnel bleibt angelegt und referenziert (kein verwaistes, unreferenziertes Geheimnis); der Report nennt klar, welche Phase/welcher Container fehlschlug. Phase 3 ist **pro Container degradierend** (ein Routen-Fehler kippt die übrigen nicht).
7. **Idempotenz.** Ein zweiter Lauf legt einen weiteren neuen Tunnel an (jeder Lauf ersetzt die Referenz) — `createDnsRecord`-Idempotenz sorgt dafür, dass die CNAMEs konsistent auf den jeweils neuesten Tunnel zeigen; bereits passende Routen erzeugen keinen Doppel-Eintrag.
8. **Beobachtbarkeit.** Jeder Lauf erzeugt Audit-Einträge (Audit-First, ohne Token) und einen secret-freien Ergebnis-Report (je Container: Route angelegt / protected-übersprungen / Fehler).

## Acceptance-Kriterien

### Phase 1 — Tunnel neu anlegen & Referenz ersetzen
- **AC1** — `POST /api/deployments/vps/{vpsId}/tunnel/recreate` legt über `CloudflareApi.createTunnel("<sanitized-vpsname>")` genau **einen** neuen remote-managed Tunnel an, legt das zurückgegebene **Token** im `CredentialStore` unter `TUNNEL_TOKEN_KEY(newTunnelId)` ab und **aktualisiert** die gespeicherte `tunnelId` des VPS (`TUNNEL_ID_KEY`) auf die neue Id (testbar: nach Erfolg liefert die VPS↔Tunnel-Auflösung die **neue** Id; das alte Token-Referenz-Key wird best-effort entfernt).
- **AC2** — Schlägt `createTunnel` fehl (`cloudflare-not-configured`/`cloudflare-auth-failed`/`cloudflare-unavailable`), bricht die Heilung **vor** Phase 2 ab (kein SSH-Schritt, keine Routen), mit klarer Fehlerklasse; es bleibt **kein** halb angelegtes, unreferenziertes Geheimnis zurück.

### Phase 2 — Token-Push & cloudflared-Restart (SSH)
- **AC3** — Phase 2 schreibt `/etc/cloudflared/env` auf dem VPS neu mit `TUNNEL_TOKEN=<neu>` (Permissions `0600`, owner `root:root`) und startet den `cloudflared`-Container neu (Restart bzw. `rm`+`run` mit `--network host --env-file /etc/cloudflared/env`, identisch zur cloud-init-Konvention [[vps-cloud-init-setup]]). Testbar an der gewählten SSH-Mechanik (env-file ersetzt + cloudflared-Restart ausgeführt).
- **AC4** (Security/Floor, hart) — Das Tunnel-Token erscheint in Phase 2 **niemals** in Argv, einem geloggten Befehl/Echo, im Audit, in der HTTP-Response oder im WS-Stream. Es fließt ausschließlich als **Dateiinhalt** (stdin/`write`-Muster, nicht als Kommandozeilen-Argument). Testbar: kein Log-/Argv-/Audit-/Response-Pfad enthält das Token; der env-file-Inhalt wird nicht geloggt.
- **AC5** — Schlägt Phase 2 fehl (SSH unerreichbar / Restart-Fehler), bleibt der in Phase 1 angelegte Tunnel **referenziert** (Token im Store, neue Id dem VPS zugeordnet) — kein verwaistes Geheimnis; der Report meldet den Phase-2-Fehler klar (secret-frei). Phase 3 wird in diesem Fall übersprungen (kein Routen-Bestücken auf einem cloudflared, das das neue Token nicht hat) **oder** mit Warnvermerk versucht — `coder` finalisiert; Default: **überspringen** + klarer Teil-Fehler.

### Phase 3 — Routen bestücken
- **AC6** — Phase 3 liest über `VpsDockerControl.ps(vps)` die laufenden **managed** Container (Hostname via Label `cloudflare.tunnel-hostname`, Host-Port aus `Ports`) und legt für **jeden** Container über den **atomaren Anlege-Pfad des `DeployOrchestrator`** (ADR-012, `addRouteOnly`) die Route am **neuen** Tunnel an + CNAME (`createDnsRecord`, idempotent → bestehender CNAME wird auf den neuen Tunnel umgebogen). Der Self-Heal-Pfad enthält **keinen** eigenen `CloudflareApi.mutate*`-Anlegecode neben dem geteilten Pfad (Grep-prüfbar, analog [[cloudflare-reconciliation]] AC5).
- **AC7** — Ein **protected** Hostname (LockoutGuard, ADR-011) wird in Phase 3 **nie** angelegt → `protectedSkipped` im Report; testbar: protected Hostname am managed Container → kein Anlege-Call.
- **AC8** — Phase 3 ist **pro Container degradierend**: ein Routen-/DNS-Fehler bei einem Container kippt die übrigen nicht; jeder Container-Ausgang (`route-created`/`protected-skipped`/`error`) erscheint im Report. Ein zweiter Lauf ohne Drift erzeugt keinen Doppel-CNAME (Idempotenz von `createDnsRecord`).

### Frontend (Ein-Klick-Knopf pro VPS)
- **AC9** — Die Deployment-Ansicht (`client/src/DeploymentsView.jsx`) bietet **pro VPS** ein Bedienelement „Tunnel neu anlegen & bestücken", das genau dann sinnvoll sichtbar/aktiv ist, wenn der Tunnel fehlt (Badge „Tunnel fehlt ✗" aus [[vps-tunnel-existence-gate]] AC9) — und nach Erfolg den Tunnel-Status auf „Tunnel ✓" aktualisiert. Während der Ausführung zeigt die UI einen Lauf-Status; nach Abschluss das (secret-freie) Ergebnis je Container.
- **AC10** — Das Ergebnis der Heilung wird im Frontend secret-frei dargestellt (angelegte Routen / protected-übersprungen / Fehler je Phase/Container); ein Teil-Fehler (z.B. Phase 2 fehlgeschlagen) wird als klarer, freundlicher Hinweis angezeigt, **ohne** rohen SSH-/Cloudflare-Fehlertext, Host, Key oder Token.

### Sicherheit & Audit (Floor)
- **AC11** (Security, hart) — In **keinem** Pfad dieser Capability erscheint ein Tunnel-Token, SSH-Private-Key oder Cloudflare-API-Token in Argv, Log, Audit, HTTP-Response, WS-Stream oder Frontend-Bundle. Token/Key werden store-intern, transient aus dem `CredentialStore` gezogen (ADR-007/010). Die nicht-geheime `tunnelId` darf in Report/Response stehen.
- **AC12** (Audit) — Der Endpunkt ist mutierend und **hoch-privilegiert**: hinter AccessGuard (403 ohne Access) + identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`; 403 ohne Berechtigung) + **Audit-First** (vor jeder mutierenden Phase ein Audit-Eintrag mit Identität, vpsId, Aktion, Zeit — **ohne** Token/Key). Schlägt der Audit-Write fehl, unterbleibt die Aktion. **LockoutGuard-Hard-Block** gilt in Phase 3 für jeden Hostname (protected → nie angelegt, AC7).

## Verträge
> Konkrete SSH-Token-Transport-Form (stdin-`cat`/`write_files`-artig) + Restart-Mechanik (`docker restart` vs. `rm`+`run`) wählt `coder`; die ACs prüfen die Garantien (Token-Floor, env-file-Permissions, Restart), nicht die Zeilenform.

- **POST `/api/deployments/vps/{vpsId}/tunnel/recreate`** — Body optional `{}` → `{ result: "ok"|"error", report }`. Hinter Access + Rolle + Audit + LockoutGuard.
- **`TunnelRecreateReport` (secret-frei):** `{ vpsId, newTunnelId: string, oldTunnelId: string|null, phase2: { ok: boolean, errorClass?: string }, routes: [{ hostname, result: "route-created"|"protected-skipped"|"error", errorClass? }], errors: [{ scope, errorClass }] }`. **Keine** Secrets (kein Token, kein Key).
- **Phase 1:** `CloudflareApi.createTunnel("<sanitize(vpsName)>")` → `{ tunnelId, token }`; Token → `CredentialStore.set(TUNNEL_TOKEN_KEY(newTunnelId), token)`; `TUNNEL_ID_KEY(sanitize(vpsName))` → newTunnelId; alte Token-Referenz best-effort gelöscht.
- **Phase 2:** `VpsDockerControl`-SSH: env-file `/etc/cloudflared/env` (`TUNNEL_TOKEN=<neu>`, `0600 root:root`) ersetzt + cloudflared-Container-Restart. SSH-Private-Key store-intern (`ssh/<user>/private_key`, ADR-007/008). Token via Dateiinhalt, **nie** Argv/Log.
- **Phase 3:** `VpsDockerControl.ps(vps)` → managed Container `{ hostname, hostPort }`; je Container `DeployOrchestrator.addRouteOnly({ tunnelId: newTunnelId, hostname, hostPort })` (ADR-012-Anlege-Pfad: LockoutGuard → `addRoute` → `createDnsRecord` idempotent). **Kein** eigener CF-Mutationscode.
- **Token-/Key-Quelle:** Cloudflare-Token + Account-Id aus `credentials/cloudflare/*`; SSH-Private-Key aus `ssh/<user>/private_key`; Tunnel-Token in `credentials/cloudflare/tunnel_token/<tunnelId>` (ADR-007/010). Store-intern, transient, nie geleakt.
- **VPS-Auflösung:** `vpsId` über die vereinigte VPS-Auflösung (Env ⊕ dynamische Records, [[vps-dynamic-ssh-targets]]); unbekannte `vpsId` → 422 (`Unbekannter VPS: <id>`), analog Deploy.
- **Zone-Auflösung:** je Hostname server-seitig per Suffix-Match (`CloudflareApi.resolveZoneForHostname`, wie [[deploy-lifecycle]]); kein Zone-Match für einen Container → dieser Container `error: zone-not-found` (degradierend), die übrigen laufen weiter.

## Edge-Cases & Fehlerverhalten
- Cloudflare nicht konfiguriert/Auth-Fehler → Abbruch vor Phase 2, klare Klasse, kein orphan-Geheimnis (AC2).
- SSH unerreichbar / cloudflared-Restart-Fehler → Phase-2-Fehler im Report, Tunnel referenziert, Phase 3 übersprungen (AC5).
- Managed Container mit protected Hostname → `protectedSkipped`, kein Anlege-Call (AC7).
- Ein Container-Hostname ohne passende Zone → `error: zone-not-found` für diesen Container, übrige laufen weiter (degradierend).
- Kein managed Container am VPS → Phase 3 ist no-op (Tunnel + Token neu, keine Routen), Report mit leerer `routes`-Liste.
- VPS hatte keine alte Tunnel-Id → `oldTunnelId: null`, kein Alt-Cleanup nötig, sonst regulär.
- Zweiter Lauf → neuer Tunnel + Referenz-Ersatz; CNAMEs werden idempotent auf den neuesten Tunnel umgebogen (kein Doppel-Record, AC8).
- Unbekannte `vpsId` → 422, keine Mutation, kein createTunnel.

## NFRs
- **Sicherheit (Floor, hart):** Tunnel-Token/SSH-Key/CF-API-Token nie in Argv/Log/Audit/Response/WS/Frontend-Bundle (AC4/AC11); Token at rest verschlüsselt (ADR-007). Mutierend, hoch-privilegiert: Access + Rolle + Audit-First + LockoutGuard-Hard-Block (AC12).
- **Resilienz:** additive Heilung (kein destruktiver Rollback); Teil-Fehler hinterlässt **kein** verwaistes Geheimnis; Phase 3 pro Container degradierend; idempotent über `createDnsRecord`.
- **ADR-005/010/012-Konformität:** kein neuer Store (VPS↔Tunnel über `CredentialStore`-Keys, Report secret-frei); Routen-Anlegen über den **geteilten** ADR-012-Pfad (kein dupliziertes CF-Mutations-Logik); `CloudflareApi` bleibt einziger CF-Sprecher, `VpsDockerControl` einziger SSH+Docker-on-VPS-Pfad.

## Nicht-Ziele
- **Erkennen/Blocken** eines toten Tunnels im Deploy → [[vps-tunnel-existence-gate]] (Capability A).
- **Proaktiver Drift-Push** → [[vps-tunnel-drift-notify]] (Capability C).
- **VPS-Neubau / Rebuild** → [[vps-rebuild-backup]] (bewusst vermieden — diese Capability heilt **ohne** Neubau).
- **Compose-/Multi-Container-Stacks** als Sonderpfad — Phase 3 bestückt die managed Container, die `ps()` liefert (Single-App-Container je Hostname, wie [[deploy-lifecycle]]).
- **Automatischer Trigger** (selbst-auslösend bei Drift) — diese Capability ist der **manuelle** Ein-Klick-Pfad; der proaktive Hinweis kommt aus [[vps-tunnel-drift-notify]].

## Abhängigkeiten
- [[vps-tunnel-existence-gate]] (liefert den `tunnel-missing`-Zustand + Badge, der diesen Knopf motiviert; Capability A).
- [[vps-tunnel-provisioning]] (Tunnel-Namens-/Sanitize-Konvention, `TUNNEL_ID_KEY`/`TUNNEL_TOKEN_KEY`, Token-Floor; das Erst-Provisioning, dessen Reparatur diese Capability ist).
- [[deploy-lifecycle]] (`DeployOrchestrator.addRouteOnly` — atomarer Route-Anlege-Pfad; `VpsDockerControl.ps`; ADR-012).
- [[cloudflare-reconciliation]] (gleiches Heilungs-Muster „managed Container → Route anlegen", gebündelt).
- [[vps-cloud-init-setup]] (cloudflared-Container-Konvention `--network host --env-file /etc/cloudflared/env`).
- [[view-cloudflare]] (`CloudflareApi.createTunnel`/`addRoute`/`createDnsRecord`, ADR-010).
- [[settings-credentials]] / [[settings-ssh-keys]] (Cloudflare-Token, Account-Id, SSH-Private-Key store-intern).
- [[access-and-guardrails]] (Access + Audit + LockoutGuard ADR-011).
- `docs/architecture.md` — `CloudflareApi` (ADR-010), `DeployOrchestrator` + `VpsDockerControl` (ADR-012), `LockoutGuard` (ADR-011), `CredentialStore` (ADR-007).
