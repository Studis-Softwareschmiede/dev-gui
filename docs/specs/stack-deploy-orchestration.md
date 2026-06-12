---
id: stack-deploy-orchestration
title: Stack-Deploy-Orchestrierung — Registry, .env-Generierung auf VPS, Stack-Deploy/Undeploy, UI-Modus, stack-aware Reconciliation (Etappe 1b)
status: draft
version: 1
---

# Spec: Stack-Deploy-Orchestrierung (`stack-deploy-orchestration`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). **Security-kritisch**:
> Secret-Generierung **auf dem VPS** (dev-gui sieht die Werte nie), autonome Cloudflare-Mutation,
> Self-Lockout-Risiko.
> Dach: [[compose-stack-deployment]] (E2/E3/E5). Konsumiert [[vps-compose-control]] (Compose-Lifecycle),
> `DeployOrchestrator`/`CloudflareApi` (Route-Anlage, ADR-012/010), `LockoutGuard` (ADR-011),
> `ReconciliationJob` (ADR-013, wird stack-aware erweitert).
>
> **Split-Hinweis (an den Orchestrator):** Diese Spec deckt mehrere zusammengehörige Bausteine ab.
> Sie wird in **mehrere Board-Items** zerlegt (s. „Item-Schnitt" unten) — jedes Item zeigt auf diese
> Spec + die von ihm abgedeckten AC-Nummern. Die Spec selbst bleibt **eine** Source of Truth.

## Zweck
Die orchestrierende Schicht über [[vps-compose-control]]: sie kennt die **Stack-Definitionen**
(welches Repo/Branch/compose-Pfad auf welchem VPS, welche Services öffentlich sind), stellt die
App-`.env` auf dem VPS bereit (Erst-Deploy: **lokal auf dem VPS generieren**, E3), fährt den Stack
hoch/runter, legt **je öffentlichem Label-Container** eine Cloudflare-Route an / entfernt sie, und
erweitert Routing + Reconciliation **stack-aware** (mehrere Hostnames/Container pro Stack, Stack über
`com.docker.compose.project`). Im Frontend kommt ein **Modus-Umschalter** „Single-Image | Compose-Stack
aus Repo" in die bestehende Deployments-Kachel.

## Verhalten

### Stack-Registry
1. Eine **Stack-Registry** beschreibt je Stack: `{ stackName, repoUrl, branch, composeFile,
   overrideFile?, vps (VPS-Referenz), publicServices: [{ service, hostname }], tunnelId,
   secretsSpec? }`. Die Registry ist **nicht-geheime Betreiber-Konfiguration** → Klartext-Metadatum
   (analog Workspace-Pfad: `meta`-Block des `CredentialStore` ODER eigene Konfig-Datei auf dem
   persistenten Volume), **nicht** im verschlüsselten `entries`-Block. `secretsSpec` enthält **keine**
   Secret-Werte, sondern nur die Liste der **auf dem VPS zu generierenden** Secret-Namen (E3).
2. Stack-Definitionen sind über das Backend les-/schreibbar (CRUD); Mutationen hinter Access +
   Rolle + Audit. `tunnelId` + öffentliche Hostnames pro Stack sind hier hinterlegt (nicht pro Request getippt).

### .env-Materialisierung/-Generierung auf dem VPS (E3)
3. **Erst-Deploy** (`.env` existiert auf dem VPS noch nicht): dev-gui löst auf dem VPS das mitwandernde
   Skript **`generate-supabase-secrets.sh`** (bzw. ein stack-spezifisches Generier-Skript) aus, das die
   App-Boot-Secrets (DB-Passwort, JWT-Secret, ANON-/Service-Key, proxy_sync-PW, …) **lokal auf dem VPS**
   erzeugt und in die App-`.env` schreibt. **dev-gui liest diese Werte nie zurück** und persistiert sie nie.
4. **Nicht generierbare** App-Boot-Secrets (z.B. assistent `OPENAI_API_KEY`) werden **nicht** von
   dev-gui transportiert; sie werden außerhalb dieses Flows einmalig direkt auf dem VPS in die `.env`
   eingetragen (Betreiber-Schritt, dokumentiert). dev-gui prüft beim Deploy höchstens **Vorhandensein**
   (Schlüsselname vorhanden), **nie** den Wert.
5. **Re-Deploy** (`.env` existiert bereits): die bestehende `.env` bleibt **unverändert** (kein
   Überschreiben, kein Re-Generieren — Secret-Stabilität); es wird nur `git pull` + `compose up -d`
   (recreate) gefahren.

### Stack-Deploy / -Undeploy
6. **Stack-Deploy** `{ stackName }`: (a) **LockoutGuard-Check** für **jeden** öffentlichen Hostname
   (ein protected Hostname → gesamter Deploy abgelehnt, kein Schritt); (b) `VpsComposeControl.syncRepo`;
   (c) `.env` materialisieren/generieren (Schritt 3–5); (d) `VpsComposeControl.composeUp`
   (`--project-name <stackName>`); (e) **je öffentlichem Label-Container** eine Cloudflare-Route +
   DNS-CNAME über den **geteilten atomaren Anlege-Pfad** des `DeployOrchestrator` (ADR-012, kein
   duplizierter Cloudflare-Code). Schlägt ein Route-Schritt fehl → die schon angelegten Routen dieses
   Laufs werden best-effort zurückgerollt; der Rest-Drift fängt die Reconciliation.
7. **Stack-Undeploy** `{ stackName, confirm }`: (a) LockoutGuard-Check je Hostname;
   (b) **type-to-confirm** (Stack-Name tippen); (c) **alle** Stack-Routen + DNS-CNAMEs entfernen
   (`CloudflareApi`); (d) `VpsComposeControl.composeDown` (Volumes **behalten**, Default). Reihenfolge
   Routen-zuerst (kein Traffic auf gestoppten Stack).
8. **Stack-Status** = `VpsComposeControl.composePs` ⊕ Cloudflare-Routen je öffentlichem Hostname; Drift
   (Service ohne Route / Route ohne Service) wird sichtbar gemacht.

### UI-Modus-Umschalter
9. Das Deployments-Panel (`client/src/DeploymentsView.jsx`) erhält einen **Modus-Umschalter**:
   - **„Single-Image"** = heutiges Verhalten (unverändert, [[deploy-lifecycle]]).
   - **„Compose-Stack aus Repo"** = Stack-Auswahl (aus der Registry) + Deploy/Undeploy/Status für Stacks.
   Beide Modi nutzen dieselbe Ansicht; kein Funktionsverlust für Single-Image. Keine Secrets im Frontend.

### Stack-aware Reconciliation (Erweiterung von ADR-013)
10. Der `ReconciliationJob` ([[cloudflare-reconciliation]]) wird **stack-aware**: er liest Container
    inkl. `com.docker.compose.project`-Label, behandelt **mehrere** öffentliche Hostnames pro Stack und
    heilt/löscht Routen pro **öffentlichem** (`cloudflare.tunnel-hostname`-tragendem) Container — egal
    ob Single-Image- oder Stack-Container. Interne Stack-Container (ohne `cloudflare.tunnel-hostname`)
    werden **nie** geroutet und **nie** als verwaist gewertet. Das beidseitig-selbstheilende Verhalten
    (verwaiste Route löschen / managed Container ohne Route → Route anlegen) bleibt unverändert; der
    Heilungs-Pfad bleibt der geteilte ADR-012-Anlege-Pfad (kein duplizierter Cloudflare-Code).

## Acceptance-Kriterien

### Stack-Registry (Item A)
- **AC1** — Eine Stack-Definition `{ stackName, repoUrl, branch, composeFile, overrideFile?, vps,
  publicServices: [{ service, hostname }], tunnelId, secretsSpec? }` ist über das Backend CRUD-bar;
  sie liegt als **nicht-geheime** Konfiguration (Klartext-Metadatum, nicht im verschlüsselten
  `entries`-Block) auf dem persistenten Volume. `secretsSpec` enthält **nur Secret-Namen**, **keine** Werte.
- **AC2** — Registry-Mutationen (Anlegen/Ändern/Löschen) sind hinter Access + `CRED_ADMIN_EMAILS`-Rolle
  + Audit-First; Eingaben (stackName/repoUrl/branch/Pfade/hostname) validiert (Path-Traversal-/
  Shell-Metazeichen-/Hostname-Validierung); keine Secrets in Response/Audit.

### .env-Generierung auf VPS (Item B) — E3 Kernschutz
- **AC3** — Beim Erst-Deploy (keine `.env` auf dem VPS) generiert dev-gui die App-Boot-Secrets
  **auf dem VPS** (Ausführung von `generate-supabase-secrets.sh`/Stack-Generierskript via
  `VpsComposeControl`/SSH); die erzeugten Werte werden **nie** an dev-gui zurückgegeben, **nie**
  geloggt/auditiert/im Frontend gezeigt, **nie** persistiert. Testbar: weder Response noch Audit noch
  Log noch WS enthalten je einen generierten Secret-Wert; der Audit-Eintrag nennt nur „env generated"
  + Schlüsselnamen, keine Werte.
- **AC4** — Beim Re-Deploy (`.env` existiert) wird die `.env` **nicht** überschrieben und **nicht**
  neu generiert (Secret-Stabilität); nur `git pull` + `compose up -d` (recreate). Testbar: bestehende
  `.env`-Datei bleibt byte-identisch (mtime/Hash unverändert durch den Deploy).
- **AC5** — Nicht generierbare Secrets (z.B. `OPENAI_API_KEY`) werden von dev-gui **nicht** transportiert;
  fehlt ein als „erforderlich" markierter Schlüssel in der VPS-`.env`, meldet der Deploy einen klaren,
  geheimnis-freien Fehler („Schlüssel `<name>` fehlt in der VPS-.env") **ohne** je einen Wert zu lesen/zeigen.

### Stack-Deploy / -Undeploy (Item C)
- **AC6** — `POST /api/deployments/stacks/{stackName}/deploy` führt syncRepo → .env-Materialisierung →
  composeUp (`--project-name <stackName>`) → Route je öffentlichem Label-Container (über den geteilten
  ADR-012-Anlege-Pfad) aus; bei Erfolg sind alle öffentlichen Hostnames geroutet und das Ergebnis
  `{ result: "ok", stack }`. Interne Services bekommen **keine** Route (AC: nur `publicServices`/
  `cloudflare.tunnel-hostname`-Container werden geroutet).
- **AC7** — Schlägt ein Route-Schritt fehl, werden die in **diesem** Lauf bereits angelegten Routen
  best-effort zurückgerollt; verbleibender Drift wird der Reconciliation überlassen; Ergebnis
  `{ result: "error", reason }` ohne Teil-/Geheim-Leak. Schlägt `composeUp` fehl → kein Route-Schritt.
- **AC8** — `DELETE /api/deployments/stacks/{stackName}/undeploy` (Body `{ confirm: "<stackName>" }`)
  entfernt **alle** Stack-Routen + DNS-CNAMEs und fährt den Stack via `composeDown` (Volumes behalten)
  herunter; Reihenfolge Routen-zuerst. Ohne/falschem `confirm` → 422 `confirmation-required`, keine
  Mutation. Sub-Pfad `/undeploy` trennt trennscharf vom Registry-DELETE (AC1/AC2, Item A).
- **AC9** — `GET /api/deployments/stacks/{stackName}/status` liefert den Live-Status (composePs ⊕
  Routen je öffentlichem Hostname) mit Drift-Flags; `GET /api/deployments/stacks` listet die
  registrierten Stacks (StackDefinition[] aus der Registry, unverändert).

### Sicherheit & Audit (Floor, Item C)
- **AC10** — Stack-Deploy/Undeploy auf einen **protected** öffentlichen Hostname (eigene `devgui`/
  Access-Mauer, ADR-011) → 422 `protected-resource`, **kein** Compose- und **kein** Cloudflare-Schritt;
  nicht durch Identität/Confirm überschreibbar.
- **AC11** — Alle `/api/deployments/stacks/*`-Endpunkte hinter Access; mutierende zusätzlich
  identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`) + Audit-First (Audit-Eintrag VOR der Aktion;
  schlägt Audit fehl → Aktion unterbleibt). **Kein** App-Boot-Secret, SSH-Key oder CF-Token in
  Response, Log, Audit, WS-Stream, Argv oder Frontend-Bundle.

### UI-Modus (Item D)
- **AC12** — Das Deployments-Panel bietet einen Modus-Umschalter „Single-Image | Compose-Stack aus
  Repo"; im Stack-Modus sind Stack-Auswahl (aus der Registry), Deploy, Undeploy (mit type-to-confirm
  Stack-Name) und Status bedienbar; der Single-Image-Modus bleibt funktional unverändert (kein
  Funktionsverlust, [[deploy-lifecycle]]). A11y wie der Rest der View (Tastatur, Fokusring,
  Touch-Target ≥ 44 px, kein Bedeutungstransport allein über Farbe). Keine Secrets im Frontend-Bundle.

### Stack-aware Reconciliation (Item E) — Erweiterung ADR-013
- **AC13** — `ReconciliationJob` liest Container inkl. `com.docker.compose.project`-Label und heilt/löscht
  Routen pro **öffentlichem** (`cloudflare.tunnel-hostname`-tragendem) Container — für Single-Image-
  **und** Stack-Container. **Interne** Stack-Container (ohne `cloudflare.tunnel-hostname`) werden nie
  geroutet und nie als verwaist gewertet. Mehrere öffentliche Hostnames pro Stack werden korrekt
  einzeln behandelt.
- **AC14** — Das bestehende Reconciliation-Verhalten (beidseitig selbst-heilend, LockoutGuard-Hard-Block,
  Audit-First, fail-closed, idempotent, degradierend pro VPS; [[cloudflare-reconciliation]] AC3–AC9)
  bleibt **unverändert** gültig; der Heilungs-Pfad bleibt der geteilte ADR-012-Anlege-Pfad (kein
  neuer Cloudflare-Mutationscode im Job, Grep-prüfbar).

## Verträge
> Pfade/Felder kanonisch; tiefe Boundary-Grenzen (wo die Registry persistiert, Generierskript-Aufruf)
> = `architekt` (neuer ADR, gemeinsam mit [[vps-compose-control]]).

- **`StackDefinition`** = `{ stackName, repoUrl, branch, composeFile, overrideFile?, vps, publicServices: [{ service, hostname }], tunnelId, secretsSpec?: { generate: string[], required: string[] } }`. Nicht-geheim. `secretsSpec.generate` = auf dem VPS zu generierende Schlüsselnamen; `secretsSpec.required` = Schlüsselnamen, die in der VPS-`.env` vorhanden sein müssen (nur Existenzprüfung, nie Wert).
- **`StackStatus` (live)** = `{ stackName, project, services: [{ service, status, hostname?, routePresent?, containerPresent? }], errors?: [{ scope, errorClass }] }`.
- **GET `/api/deployments/stacks`** → `{ stacks: StackDefinition[] }` (hinter Access).
- **POST `/api/deployments/stacks`** / **PUT `/api/deployments/stacks/{stackName}`** / **DELETE …** — Registry-CRUD (Mutation: Access + Rolle + Audit).
- **POST `/api/deployments/stacks/{stackName}/deploy`** → `{ result, stack?, reason? }` (Mutation).
- **DELETE `/api/deployments/stacks/{stackName}/undeploy`** — Body `{ confirm: "<stackName>" }` → `{ result, reason? }` (Mutation; trennscharf vom Registry-DELETE; Entscheidung Item C: Sub-Pfad `/undeploy`).
  - **DELETE `/api/deployments/stacks/{stackName}`** (ohne `/undeploy`) bleibt rein Registry-DELETE (AC1/AC2, Item A).
- **GET `/api/deployments/stacks/{stackName}/status`** → `StackStatus` (hinter Access; Live-Status via composePs ⊕ Routen).
  - **GET `/api/deployments/stacks/{stackName}`** (ohne `/status`) liefert `StackDefinition` aus der Registry (AC1, Item A).
- **Route-Anlage je öffentlichem Service:** über `DeployOrchestrator.addRouteOnly`/Deploy-Anlege-Pfad (ADR-012); kein duplizierter Cloudflare-Code.
- **Generierung auf VPS:** über [[vps-compose-control]]-SSH-Ausführung des mitwandernden Generierskripts; Werte verlassen den VPS nie.
- Token/Key/App-Secret store-intern bzw. VPS-lokal, transient, nie geleakt.

## Edge-Cases & Fehlerverhalten
- Protected öffentlicher Hostname im Stack → 422 `protected-resource`, kein Schritt (AC10).
- Erst-Deploy, Generierskript fehlt/scheitert auf dem VPS → `{ result: "error", reason }`, kein composeUp mit leerer `.env`.
- Re-Deploy → `.env` bleibt unverändert (AC4); nie Secret-Rotation als Nebeneffekt.
- Erforderlicher nicht-generierbarer Schlüssel (z.B. `OPENAI_API_KEY`) fehlt → klarer Fehler ohne Wert-Leak (AC5).
- Teil-Fehler bei Multi-Hostname-Route-Anlage → best-effort-Rollback der schon angelegten Routen; Rest → Reconciliation (AC7).
- Undeploy ohne/falschem confirm → 422 `confirmation-required` (AC8).
- Stack nicht in Registry → 404, keine SSH-/Cloudflare-Aktion.
- Stack-aware Reconciliation: interne Stack-Container nie geroutet/gelöscht (AC13).

## NFRs
- **Sicherheit (Floor, hart):** App-Boot-Secrets werden **auf dem VPS** generiert und verlassen ihn nie;
  dev-gui kennt nur Infra-Secrets (E3). Alle Mutationen Access + Rolle + Audit-First + LockoutGuard-Hard-Block;
  destruktives Undeploy zusätzlich type-to-confirm. Keine Secrets in Log/Audit/Report/WS/Argv/Frontend.
- **ADR-005/006-Konformität:** kein Deploy-State-Store (Status live aus composePs ⊕ Cloudflare-Routen);
  Registry ist nicht-geheime Betreiber-Konfig (kein RDBMS); kein neues SDK; Reconciliation bleibt der interne Timer.
- **Resilienz:** Stack-Deploy ist best-effort-Saga mit Route-Kompensation; Rest-Drift fängt die Reconciliation.

## Nicht-Ziele
- VPS-seitige Compose-/SSH-Mechanik → [[vps-compose-control]] (diese Spec orchestriert sie nur).
- Konkrete App-Compose-Files → [[app-stack-alexstuder-webpage]] / [[app-stack-rapt-dashboard]] / [[app-stack-brew-assistent]].
- SSO (E4, vertagt).
- Backup/Restore der App-DBs (Etappe 5 / [[webpage-infra-decommission]] — Bausteine wandern mit).

## Item-Schnitt (für den Orchestrator — jedes Item zeigt auf diese Spec + AC)
- **Item A — Stack-Registry (Backend):** AC1, AC2.
- **Item B — .env-Materialisierung/-Generierung auf VPS (Backend):** AC3, AC4, AC5.
- **Item C — Stack-Deploy/Undeploy-Orchestrierung + API (Backend):** AC6, AC7, AC8, AC9, AC10, AC11.
- **Item D — UI-Modus-Umschalter (Frontend):** AC12.
- **Item E — Stack-aware Reconciliation (Backend):** AC13, AC14.

## Abhängigkeiten
- [[compose-stack-deployment]] (Dach, E2/E3/E5).
- [[vps-compose-control]] (Compose-Lifecycle via SSH — Voraussetzung).
- [[deploy-lifecycle]] (geteilter ADR-012-Anlege-Pfad + Single-Image-Modus bleibt).
- [[cloudflare-reconciliation]] (wird stack-aware erweitert — AC13/AC14).
- [[view-cloudflare]] (`CloudflareApi`), [[settings-credentials]] (CF-Token), [[settings-ssh-keys]] (SSH-Key),
  [[vps-provider-boundary]] (VPS-Referenzen), [[access-and-guardrails]] (Access + Audit + LockoutGuard).
- `docs/architecture.md` — ADR-010/011/012/013; **neuer ADR (Stack-Registry + Generierung-auf-VPS)** erforderlich.
