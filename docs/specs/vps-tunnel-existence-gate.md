---
id: vps-tunnel-existence-gate
title: Tunnel-Existenz-Gate + VPS↔Tunnel-Formular-Kopplung (Capability A)
status: draft
version: 1
---

# Spec: Tunnel-Existenz-Gate + VPS↔Tunnel-Kopplung (`vps-tunnel-existence-gate`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Security-relevant (Cloudflare-Read im Deploy-Preflight, Fehlverdrahtungs-Schutz, kein Token-Leak).
> Boundaries fixiert: `DeployOrchestrator` + `VpsDockerControl` (**ADR-012**), `CloudflareApi` (**ADR-010**), VPS↔Tunnel-Zuordnung (`VpsProviderRegistry`, `TUNNEL_ID_KEY`, [[vps-tunnel-provisioning]]). Folge-Story zu **F-013** ([[deploy-lifecycle]], Done), erweitert das Preflight-Gate aus **F-024** ([[vps-readiness-gate]]).

## Zweck
**Capability A des selbstheilenden VPS-Tunnel-Vorhabens.** dev-gui speichert je VPS genau eine Cloudflare-Tunnel-Id (`credentials/misc/vps-<name>-tunnel-id`, [[vps-tunnel-provisioning]]). Wird der Tunnel **extern in Cloudflare gelöscht**, bleibt die gespeicherte Id stehen → der VPS zeigt auf einen toten Tunnel, Deploys misslingen (Cloudflare-Error 1033), ohne dass es vorher jemand merkt. Zweitens zeigt das Deploy-Formular einen **account-weiten Tunnel-Dropdown** (Tunnel je Cloudflare-Zone), statt den **dem VPS zugehörigen** Tunnel zu erzwingen — so kann ein Hostname versehentlich am falschen Tunnel landen (real geschehen: `sandbox-3.alexstuder.cloud` am `beautymoltTunnel`).

Diese Capability schließt beide Lücken: (1) ein **Tunnel-Existenz-Check** im Deploy-Preflight (Abgleich der gespeicherten `tunnelId` gegen die in Cloudflare real existierenden Tunnel), der den Deploy mit einer eigenen, freundlichen Fehlerklasse `tunnel-missing` hart abbricht, **bevor** Docker/Route laufen; (2) eine **VPS↔Tunnel-Kopplung** im Formular: die Tunnel-Id wird aus der VPS-Registry abgeleitet (kein account-weiter Dropdown mehr), ein Badge „Tunnel ✓ / Tunnel fehlt ✗" zeigt den Zustand analog dem „VPS bereit"-Badge, der Deploy-Button ist gesperrt solange der Tunnel fehlt, und das Backend lehnt einen Deploy ab, dessen mitgegebene `tunnelId` **nicht** der für den VPS registrierten entspricht.

> **Abgrenzung:** Diese Spec prüft nur **Tunnel-Existenz + korrekte VPS↔Tunnel-Bindung** vor dem Deploy und koppelt das Formular. Die **Selbstheilung** (Tunnel neu anlegen, Token pushen, Routen bestücken) ist [[vps-tunnel-self-heal]] (Capability B). Der **proaktive Drift-Push** über die Reconciliation ist [[vps-tunnel-drift-notify]] (Capability C). Die **VPS-Infra-Bereitschaft** (Docker/cloudflared läuft) bleibt das Readiness-Gate aus [[vps-readiness-gate]] — diese Capability ergänzt es um die Tunnel-Existenz; beide laufen im selben Preflight.

## Verhalten
1. **Tunnel-Existenz-Probe im Deploy-Preflight.** `DeployOrchestrator.deploy()` prüft an derselben Stelle wie das bestehende Readiness-Gate ([[vps-readiness-gate]] AC4) — **vor** `docker pull` und **vor** jedem Cloudflare-Mutationsschritt — ob der dem Deploy mitgegebene Tunnel in Cloudflare **wirklich existiert**: `CloudflareApi.listTunnels(...)` wird konsultiert und es wird geprüft, ob `some(t => t.id === tunnelId)`. Fehlt der Tunnel → der Deploy bricht hart ab mit `{ result: "error", errorClass: "tunnel-missing", reason: <freundliche Meldung> }`, **kein** Docker- und **kein** Cloudflare-Mutationsschritt läuft.
2. **Reihenfolge der Preflight-Gates.** Die Gates laufen vor dem Pull in dieser Reihenfolge: (a) LockoutGuard (protected → 422, unverändert [[deploy-lifecycle]] AC7); (b) Readiness-Probe ([[vps-readiness-gate]] AC4, `vps-provisioning`); (c) **Tunnel-Existenz** (diese Spec, `tunnel-missing`). Schlägt eines fehl, brechen die folgenden nicht mehr aus (kein Docker/Cloudflare-Schritt). Die genaue Reihenfolge von (b)/(c) ist nicht verhaltensrelevant, solange **beide** vor dem ersten Docker-/Cloudflare-Schritt liegen.
3. **Fehlverdrahtungs-Schutz im Backend.** Der Deploy lehnt einen Request ab, dessen `tunnelId` **nicht** die für den gewählten VPS registrierte Tunnel-Id ist (aufgelöst über `VpsProviderRegistry`/`TUNNEL_ID_KEY` aus dem sanitisierten VPS-Namen). Stimmt die mitgegebene `tunnelId` nicht mit der registrierten überein → `{ result: "error", errorClass: "tunnel-mismatch", reason: <freundliche Meldung> }`, **kein** Schritt. Hat der VPS **keine** registrierte Tunnel-Id → `tunnel-missing` (kein Tunnel zugeordnet).
4. **VPS-Tunnel-Read-Model.** Das Backend stellt je VPS die **nicht-geheime** registrierte `tunnelId` und einen Existenz-Status bereit, damit das Frontend Badge + Kopplung rendern kann (read-only, kein Token). Die `tunnelId` ist **kein Geheimnis** (sie wird heute bereits geloggt); das Tunnel-**Token** bleibt ausschließlich store-intern.
5. **Formular-Kopplung (Frontend).** Im Deploy-Formular (`client/src/DeploymentsView.jsx`) wird die Tunnel-Auswahl **an den gewählten VPS gekoppelt**: die effektive `tunnelId` wird aus der VPS-Registry abgeleitet (über das VPS-Tunnel-Read-Model), **nicht** mehr aus einem account-/zonen-weiten Tunnel-Dropdown. Der bisherige zonen-basierte Tunnel-Dropdown im Deploy-Formular entfällt als Quelle der wirksamen `tunnelId`.
6. **Tunnel-Badge.** Neben dem VPS-/Tunnel-Feld zeigt die Ansicht ein Badge analog dem „VPS bereit"-Badge ([[vps-readiness-gate]] AC9): **„Tunnel ✓"** wenn der registrierte Tunnel des VPS in Cloudflare existiert, **„Tunnel fehlt ✗"** wenn nicht (oder kein Tunnel registriert ist). Quelle ist das VPS-Tunnel-Read-Model.
7. **Deploy-Button-Gate.** „Deploy starten" ist **zusätzlich** zu den bestehenden Bedingungen ([[deploy-lifecycle]] AC12 + [[vps-readiness-gate]] AC10) **gesperrt**, solange der Tunnel fehlt (Badge „Tunnel fehlt ✗"), und wird freigegeben, sobald der Tunnel existiert (sofern die übrigen Bedingungen erfüllt sind).
8. **errorClass-Mapping im Frontend.** Eine Deploy-Antwort mit `errorClass: "tunnel-missing"` oder `"tunnel-mismatch"` wird auf einen freundlichen, secret-freien Hinweis abgebildet (z.B. „Tunnel für diesen VPS fehlt in Cloudflare — bitte über ‚Tunnel neu anlegen & bestücken' wiederherstellen"), statt der rohen Klasse.

## Acceptance-Kriterien

### Tunnel-Existenz-Gate (Backend)
- **AC1** — `DeployOrchestrator.deploy()` führt **vor** `docker pull` und **vor** jedem Cloudflare-Mutationsschritt eine Tunnel-Existenz-Prüfung aus: über `CloudflareApi.listTunnels(...)` wird geprüft, ob die mitgegebene `tunnelId` real existiert (`some(t => t.id === tunnelId)`). Existiert sie **nicht** → `{ result: "error", errorClass: "tunnel-missing", reason }`; **kein** `docker pull`/`run` und **kein** Cloudflare-Route-/DNS-Schritt wird ausgeführt (testbar: Orchestrator-Test mit `listTunnels`-Mock ohne den Tunnel ruft `pull` **nie** auf).
- **AC2** — Existiert der Tunnel in Cloudflare, läuft die bestehende Deploy-Saga **unverändert** weiter (AC3–AC9 [[deploy-lifecycle]], inkl. Readiness-Gate [[vps-readiness-gate]]); das Tunnel-Existenz-Gate ist im Erfolgsfall ein No-op-Vorschritt.
- **AC3** — Das Gate ordnet sich in die Preflight-Reihenfolge ein: LockoutGuard (protected → 422, unverändert) und Readiness-Probe (`vps-provisioning`, unverändert) **vor** dem ersten Docker-/Cloudflare-Schritt; das Tunnel-Existenz-Gate liegt **ebenfalls** vor dem ersten Docker-/Cloudflare-Schritt. Schlägt ein früheres Gate fehl, wird das Tunnel-Gate nicht mehr relevant (kein Schritt).
- **AC4** — Kann Cloudflare **nicht** konsultiert werden (nicht konfiguriert / Auth-Fehler / Netzfehler bei `listTunnels`), wird der Deploy **nicht blind durchgelassen**: er bricht mit der zugehörigen, bestehenden Cloudflare-Fehlerklasse (`cloudflare-not-configured` / `cloudflare-auth-failed` / `cloudflare-unavailable`) ab — fail-closed, **kein** Docker-Schritt. (Ein nicht-prüfbarer Tunnel zählt nicht als „existiert".)

### Fehlverdrahtungs-Schutz (Backend)
- **AC5** — Der Deploy löst die **registrierte** Tunnel-Id des gewählten VPS auf (über `VpsProviderRegistry`/`TUNNEL_ID_KEY` aus dem sanitisierten VPS-Namen). Stimmt die im Request mitgegebene `tunnelId` **nicht** mit der registrierten überein → `{ result: "error", errorClass: "tunnel-mismatch", reason }`, **kein** Docker- und **kein** Cloudflare-Schritt (testbar: Request mit fremder `tunnelId` → keine Mutation).
- **AC6** — Hat der VPS **keine** registrierte Tunnel-Id (kein `TUNNEL_ID_KEY`-Eintrag) → der Deploy bricht mit `tunnel-missing` ab (kein Tunnel zugeordnet → nichts zu deployen), **kein** Schritt.

### VPS-Tunnel-Read-Model (Backend)
- **AC7** — Es existiert ein **read-only** Pfad, der je VPS die **nicht-geheime** registrierte `tunnelId` (oder `null`) und einen Existenz-Status (`tunnelPresent: boolean`, ermittelt via `CloudflareApi.listTunnels`) liefert — als Erweiterung des bestehenden VPS-Ziel-Listings (`GET /api/deployments/vps-targets`) **oder** als eigener read-only Endpunkt. Die Antwort enthält **kein** Tunnel-**Token**, keinen SSH-Key, keinen API-Token, keinen Host/Key (Floor wie `vps-targets` AC8 heute). Read-only, kein Audit, keine Mutation. Cloudflare nicht konsultierbar → `tunnelPresent` degradiert sichtbar (z.B. `null`/`"unknown"`), kein Crash.

### Frontend-Kopplung, Badge & Gate
- **AC8** — Das Deploy-Formular (`client/src/DeploymentsView.jsx`) leitet die wirksame `tunnelId` für den Deploy **aus dem gewählten VPS** ab (VPS-Tunnel-Read-Model), **nicht** aus einem zonen-/account-weiten Tunnel-Dropdown. Der bisherige zonen-basierte Tunnel-Dropdown ist **nicht mehr** die Quelle der für `POST /api/deployments` mitgegebenen `tunnelId` (testbar: Auswahl eines VPS setzt die `tunnelId` auf die registrierte Tunnel-Id dieses VPS).
- **AC9** — Neben dem VPS-/Tunnel-Feld zeigt die Ansicht ein Badge analog dem „VPS bereit"-Badge: **„Tunnel ✓"** wenn der registrierte Tunnel des VPS in Cloudflare existiert, sonst **„Tunnel fehlt ✗"** (auch wenn kein Tunnel registriert ist). Ohne gewählten VPS kein Tunnel-Badge.
- **AC10** — „Deploy starten" ist **deaktiviert**, solange das Tunnel-Badge „Tunnel fehlt ✗" zeigt (zusätzlich zu [[deploy-lifecycle]] AC12 + [[vps-readiness-gate]] AC10), und wird freigegeben, sobald „Tunnel ✓" gilt (sofern die übrigen Bedingungen erfüllt sind).
- **AC11** — Eine Deploy-Antwort mit `errorClass: "tunnel-missing"` **oder** `"tunnel-mismatch"` wird im Frontend auf einen freundlichen, secret-freien Hinweis abgebildet (statt der rohen Klasse); andere Fehlerklassen behalten ihre bestehende Anzeige.

### Sicherheit & Audit (Floor)
- **AC12** (Security) — In **keinem** Pfad dieser Capability (Existenz-Probe, Mismatch-Check, Read-Model, Frontend) erscheint ein Tunnel-**Token**, SSH-Private-Key oder Cloudflare-API-Token in Argv, Log, Audit, HTTP-Response, WS-Stream oder Frontend-Bundle. Die `tunnelId` selbst ist nicht-geheim (heute bereits geloggt) und darf im Read-Model/Response stehen; das Token niemals (store-intern, transient — ADR-007/010).
- **AC13** (Audit) — Die Tunnel-Existenz-Probe, der Mismatch-Check und das Read-Model sind **read-only** und erzeugen **keinen** Audit-Eintrag (kein Audit-First nötig). Wird der Deploy durch ein Tunnel-Gate (`tunnel-missing`/`tunnel-mismatch`) abgelehnt, bleibt die bestehende Audit-First-Mechanik des mutierenden Deploy-Pfads unverändert ([[deploy-lifecycle]] AC9): ein **abgelehnter** Deploy führt zu **keiner** Mutation und leakt im Audit kein Secret.

## Verträge
> Boundary-Detail: `DeployOrchestrator` + `VpsDockerControl` (ADR-012), `CloudflareApi` (ADR-010), VPS↔Tunnel-Zuordnung ([[vps-tunnel-provisioning]], `TUNNEL_ID_KEY`).

- **Fehlerklassen-Vokabular (additiv):**
  - `tunnel-missing` (neu) — die für den Deploy maßgebliche Tunnel-Id existiert in Cloudflare nicht (extern gelöscht) **oder** dem VPS ist gar kein Tunnel zugeordnet.
  - `tunnel-mismatch` (neu) — die mitgegebene `tunnelId` ist nicht die für den VPS registrierte (Fehlverdrahtungs-Schutz).
  - Bestehende Klassen (`vps-provisioning`, `protected-resource`, `docker-failed`, `zone-not-found`, `cloudflare-not-configured`, `cloudflare-auth-failed`, `cloudflare-unavailable`, …) bleiben unverändert.
- **Deploy-Preflight-Erweiterung:** `POST /api/deployments` kann zusätzlich `{ result: "error", errorClass: "tunnel-missing"|"tunnel-mismatch", reason }` liefern (additiv zu den bestehenden Klassen). Der atomare Saga-Vertrag (AC3/AC4 [[deploy-lifecycle]]) bleibt unverändert.
- **VPS-Tunnel-Read-Model:** je VPS `{ vpsId, tunnelId: string|null, tunnelPresent: boolean|"unknown" }` (nicht-geheim). Implementiert als **zwei komplementäre Endpunkte** (S-185/S-186): `GET /api/deployments/vps-targets` liefert `{ vpsIds, tunnelIds: { [vpsId]: tunnelId|null } }` (für die Formular-Kopplung AC8); `GET /api/deployments/vps-tunnel-status` liefert `[{vpsId, tunnelId, tunnelPresent}]` (für das Badge AC9 + Button-Gate AC10, gepolt vom Frontend). Das Frontend nutzt beide: `tunnelIdsByVps` aus `vps-targets` für den POST-Body (AC8), `vps-tunnel-status` für das Badge/Poll (AC9/AC10).
- **Existenz-Prüfung:** `CloudflareApi.listTunnels(...)` (bestehend) → `some(t => t.id === tunnelId)`. Token + Account-Id store-intern, transient, nie geleakt (ADR-010).
- **VPS↔Tunnel-Auflösung:** `VpsProviderRegistry`/`TUNNEL_ID_KEY(sanitize(vpsName))` → registrierte `tunnelId` (store-intern; die **Id** ist nicht-geheim und darf zurückgegeben werden, das **Token** nicht).
- Alle mutierenden Endpunkte bleiben hinter AccessGuard + identitäts-/rollengeprüft + Audit-First (unverändert [[deploy-lifecycle]] AC8/AC9).

## Edge-Cases & Fehlerverhalten
- Gespeicherte `tunnelId` zeigt auf extern gelöschten Tunnel → `listTunnels` enthält ihn nicht → `tunnel-missing`, kein Schritt (der real aufgetretene Fall: VPS „test", `0149ccdd-…`).
- VPS ohne registrierten Tunnel → `tunnel-missing` (kein Tunnel zugeordnet).
- Request mit `tunnelId` eines fremden Tunnels (z.B. `beautymoltTunnel` für `sandbox-3`) → `tunnel-mismatch`, kein Schritt (Fehlverdrahtungs-Schutz).
- Cloudflare nicht konfiguriert / Auth-Fehler / Netzfehler bei `listTunnels` → fail-closed mit bestehender CF-Fehlerklasse, **kein** Docker-Schritt (AC4); Tunnel zählt nicht als „existiert".
- Race: Tunnel wird zwischen Read-Model (Badge „Tunnel ✓") und Deploy gelöscht → das Backend-Gate fängt es serverseitig mit `tunnel-missing` ab (Backend ist die maßgebliche Prüfung; das Frontend-Gate ist UX-Komfort).
- Mehrere Tunnel im Account, der registrierte existiert → Existenz erfüllt; der Mismatch-Check stellt sicher, dass **genau** der registrierte mitgegeben wird (kein versehentliches Wählen eines anderen Account-Tunnels).

## NFRs
- **Sicherheit (Floor, hart):** Tunnel-Token/SSH-Key/CF-API-Token nie in Argv/Log/Audit/Response/WS/Frontend-Bundle (AC12). `tunnelId` (nicht-geheim) im Read-Model erlaubt. Fail-closed bei nicht-prüfbarem Cloudflare (AC4) — kein Deploy auf ungewissem Tunnel.
- **Kosten/Last:** Existenz-Probe = **ein** `listTunnels`-Call im Preflight (kein Polling-Sturm). Das Badge nutzt das read-only Read-Model (HTTP-Polls, token-frei); `coder` wählt ein moderates Poll-/Lade-Verhalten analog dem Readiness-Badge.
- **Robustheit:** Das Gate wirft nie unkontrolliert — jeder Cloudflare-/Auflösungsfehler wird auf eine definierte Fehlerklasse abgebildet; ein fehlender Tunnel ist ein normaler `error`-Zustand, kein 5xx-Crash.
- **ADR-005/010/012-Konformität:** kein neuer Store; Tunnel-Existenz wird **live** per `listTunnels` ermittelt; die Probe lebt im bestehenden Deploy-Preflight (`DeployOrchestrator`), kein neuer Boundary.

## Nicht-Ziele
- **Selbstheilung** (Tunnel neu anlegen, Token pushen, Routen bestücken) → [[vps-tunnel-self-heal]] (Capability B).
- **Proaktiver Drift-Push** über die Reconciliation → [[vps-tunnel-drift-notify]] (Capability C).
- **VPS-Infra-Bereitschaft** (Docker/cloudflared läuft) → [[vps-readiness-gate]] (eigenständiges Gate; diese Capability ergänzt nur die Tunnel-Existenz).
- **Mehrere Tunnel pro VPS / Tunnel-Auswahl** — genau 1 Tunnel/VPS ([[vps-tunnel-provisioning]]); die Kopplung erzwingt diesen einen.
- **Reparatur des toten Tunnels** — dieses Gate **meldet/blockt** nur; die Wiederherstellung leistet Capability B.

## Abhängigkeiten
- [[deploy-lifecycle]] (`DeployOrchestrator`-Deploy-Saga; das Gate erweitert das Preflight; ADR-012).
- [[vps-readiness-gate]] (gleiche Preflight-Stelle; Reihenfolge der Gates; F-024).
- [[vps-tunnel-provisioning]] (VPS↔Tunnel-Zuordnung, `TUNNEL_ID_KEY`; 1 Tunnel/VPS).
- [[view-cloudflare]] (`CloudflareApi.listTunnels`, ADR-010).
- [[vps-dynamic-ssh-targets]] (VPS-Auflösung für das Read-Model).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität).
- `docs/architecture.md` — `DeployOrchestrator` (ADR-012), `CloudflareApi` (ADR-010).
