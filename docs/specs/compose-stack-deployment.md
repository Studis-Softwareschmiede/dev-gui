---
id: compose-stack-deployment
title: Compose-Stack-Deployment — Ablösung von webPage_infra durch lose gekoppelte, pro-App deploybare Stacks
status: draft
version: 1
---

# Spec: Compose-Stack-Deployment (`compose-stack-deployment`)

> **Schicht 3 von 3 — Dach-/Zielbild-Spec.** Hält die verbindlichen Architektur-Entscheidungen
> + den Etappenplan fest und verweist auf die umsetzbaren Detail-Specs (eine pro Capability/Etappe).
> Diese Spec selbst trägt **kein** Board-Item — sie ist die Source of Truth, gegen die die
> referenzierenden Items (`vps-compose-control`, `stack-deploy-orchestration`,
> `app-stack-*`, `webpage-infra-decommission`) ihre AC ziehen.
> **Security-kritisch** (SSH-on-VPS, Cloudflare-Mutation, Secret-Generierung-auf-VPS, Self-Lockout).

## Zweck
dev-gui löst das monolithische `webPage_infra`-Deploy-Werkzeug ab. Statt eines zentralen
`docker-compose.yml`, das alle Apps + Infra (cloudflared, watchtower) bündelt, wird jede der drei
Applikationen ein **eigenständiges, pro-App deploybares Compose-Stack** mit **eigenem**
`docker-compose.yml` in ihrem App-Repo. dev-gui erhält einen neuen Deploy-Modus
„**Compose-Stack aus Repo**": git clone/pull des App-Repos auf den VPS → App-`.env` bereitstellen
(Erst-Deploy: lokal auf dem VPS generieren) → `docker compose up -d` → Cloudflare-Routen je
öffentlichem Label-Container. dev-gui bleibt **Infra-Hoheit** (Routing + Reconciliation + Updates);
die App-Compose-Files enthalten **nur App-Services** (kein cloudflared, kein watchtower).

## Zielbild (verbindlich)
Drei **lose gekoppelte, eigenständige** Applikationen — jede für sich auf einem beliebigen VPS
deploybar (auch verteilt auf mehrere VPS):

| App | Services im App-Compose | öffentliche (Label-)Services | Cloudflare-Hostname(s) |
|---|---|---|---|
| **alexstuderWebpage** | `web_hauptseite` (statisch, zustandslos) | `web_hauptseite` | Haupt-Domäne (z.B. `alexstuder.<domain>`) |
| **brew_assistent** | `web_assistent` + `api_proxy` (role=assistent) + Lean-Supabase (`db` + `auth` + `rest` + `kong`) + `db-init` (one-shot) | `web_assistent` (App-Host), `kong` (DB-Host `db-assistent.<domain>`) | App-Host + DB-Host |
| **rapt_dashboard** | `web_rapt` + `api_proxy` (role=rapt) + Lean-Supabase (`db` + `auth` + `rest` + `kong`) + `db-init` (one-shot) | `web_rapt` (App-Host), `kong` (DB-Host `db-rapt.<domain>`) | App-Host + DB-Host |

**Kerneigenschaften:**
- Jede App ist unabhängig deploybar/updatebar/verschiebbar; kein geteiltes Compose-File, kein
  geteiltes Netz, kein geteiltes `auth.users`.
- `webPage_infra` wird als **Deploy-Werkzeug abgelöst** (deprecated/archiviert); seine wiederverwendbaren
  Bausteine wandern in die App-Repos bzw. in dev-gui (Etappe 5).

## Die 5 verbindlichen Entscheidungen (Source of Truth — kein Coder darf sie weginterpretieren)

### E1 — Zielbild: drei lose gekoppelte, pro-App deploybare Stacks
Jede App bekommt ein **eigenes** `docker-compose.yml` in ihrem App-Repo (s. Tabelle oben).
Verteiltes Deployment (jede App auf einem beliebigen/anderen VPS) ist ein **First-Class**-Ziel.

### E2 — Infra-Hoheit: „dev-gui managed alles"
- App-Compose-Files enthalten **NUR App-Services** — **KEIN** `cloudflared`, **KEIN** `watchtower`.
- dev-gui übernimmt: **Cloudflare-Tunnel-Routing** + **Reconciliation** + **Updates** (pull + recreate).
- **Routing-Mechanik (bestehend, wird wiederverwendet):** dev-gui routet per Container-Label
  `cloudflare.tunnel-hostname=<host>` (`src/deploy/DeployOrchestrator.js`, `src/deploy/VpsDockerControl.js`,
  `src/deploy/ReconciliationJob.js`). Im App-Compose tragen **NUR öffentliche** Services (`web_*`,
  ggf. `kong`/Proxy) dieses Label; `db`/`auth`/`rest` bleiben **intern/unmarkiert**.
- dev-guis Routing/Reconciliation läuft **weitgehend unverändert** weiter, wird aber **stack-aware**:
  mehrere Container & mehrere Hostnames pro Stack; Stack-Erkennung über das Compose-Label
  **`com.docker.compose.project`** (von `docker compose` automatisch gesetzt).

### E3 — Secret-Ownership: „ein Secret gehört dorthin, wo es benutzt wird" (KEIN zentraler Sammel-Store)
- **dev-gui besitzt NUR Infra-Secrets:** Cloudflare-Token/Account-ID/Zone-ID, VPS-SSH-Keys,
  VPS-Provider-Tokens (bereits im dev-gui `CredentialStore`, ADR-007). dev-gui kennt App-Boot-Secrets **nie**.
- **App-Boot-Secrets** (DB-Passwort, JWT-Secret, ANON-/Service-Key, proxy_sync-Passwort, bei assistent
  OpenAI-Key) leben **LOKAL** auf dem jeweiligen VPS in der App-`.env`. Beim **ERST-Deploy** werden die
  generierbaren Werte **LOKAL AUF DEM VPS** erzeugt (Skript `generate-supabase-secrets.sh` wandert mit).
  dev-gui transportiert diese Werte **nie** durch sich hindurch und persistiert sie **nie**.
- **End-User-Credentials** (App-Logins, pro-User RAPT-API-Key) bleiben **immer** lokal in App-DB /
  Supabase-Vault auf dem VPS (ist schon so; beide Apps werden MULTIUSER). dev-gui fasst diese Daten **nie** an.

### E4 — SSO/REST-Föderation assistent↔rapt: ERSTMAL WEGGELASSEN
Jede App hat einen **eigenen Login** (rapt nutzt `auth-rapt`). Damit entfällt das einzige geteilte
Secret (`SSO_SIGNING_SECRET`). Spätere Nachrüstung möglich, aber **NICHT in Scope** — keine
SSO-Ticket-Ausstellung/-Einlösung, kein `service_role`-SSO-Pfad in den App-Stacks dieses Vorhabens.

### E5 — Deploy-Flow: neuer Modus „Compose-Stack aus Repo" in der bestehenden Deployment-Kachel
Im bestehenden Deployments-Panel (`client/src/DeploymentsView.jsx`) gibt es zwei Modi:
- **Modus „Single-Image"** (heutiges [[deploy-lifecycle]], unverändert): ein ghcr-Image → ein Container → Route.
- **Modus „Compose-Stack aus Repo"** (neu): git clone/pull des App-Repos auf den VPS →
  App-`.env` bereitstellen (Erst-Deploy: lokal generieren) → `docker compose -f docker-compose.yml [-f override] up -d`
  → Cloudflare-Routen je öffentlichem Label-Container. **Undeploy** = `compose down` + Routen entfernen.
  **Status** = `compose ps`.

Neu zu bauen (in Etappe 1, s.u.):
`VpsComposeControl` (composeUp/Down/Ps via SSH, Schwester von `VpsDockerControl`),
**Stack-Registry** (Repo + Branch + compose-Pfad + VPS + öffentliche Services/Hostnames),
**.env-Materialisierung/Generierung auf dem VPS**, **UI-Modus-Umschalter**, **stack-aware Reconciliation**.

## Etappenplan (Reihenfolge risikoarm trivial → akut → Rest; je Etappe ≥ 1 Board-Item)

| Etappe | Spec | Inhalt | Board-Item(s) |
|---|---|---|---|
| **1a** | [[vps-compose-control]] | `VpsComposeControl`-Boundary (clone/pull, composeUp/Down/Ps, stack-aware ps) via SSH | eigenes Item |
| **1b** | [[stack-deploy-orchestration]] | Stack-Registry + .env-Materialisierung/-Generierung auf VPS + Stack-Deploy/Undeploy-Orchestrierung + UI-Modus + stack-aware Reconciliation | eigenes Item (ggf. weiter splitten) |
| **2** | [[app-stack-alexstuder-webpage]] | Pilot: eigenes Compose nur `web_hauptseite` + Label — beweist Mechanik ohne DB/Proxy | eigenes Item |
| **3** | [[app-stack-rapt-dashboard]] | Compose `web_rapt` + `api_proxy` (rapt) + Lean-Supabase + `db-init` + Labels — löst nebenbei das akute Sync-Proxy/Telemetrie-Problem | eigenes Item |
| **4** | [[app-stack-brew-assistent]] | analog rapt; **KEIN SSO** | eigenes Item |
| **5** | [[webpage-infra-decommission]] | `webPage_infra` abwickeln: Bausteine wandern in App-Repos/dev-gui; Repo deprecaten | eigenes Item |

> **Begründung Reihenfolge:** Etappe 1 schafft die dev-gui-Fähigkeit; Etappe 2 (trivialer
> statischer Stack) beweist die Mechanik ohne DB/Proxy-Risiko; Etappe 3 zieht die akute App
> (RAPT-Sync-Proxy/Telemetrie) zuerst, weil sie das dringendste Betriebs-Problem löst; Etappe 4
> spiegelt die nun bewährte Mechanik; Etappe 5 räumt das Altwerkzeug erst auf, wenn alle drei
> Apps produktiv über den neuen Modus laufen.

## Acceptance-Kriterien (Dach — verfeinert in den Detail-Specs)
- **AC1** — Jede der drei Apps ist über den neuen Modus „Compose-Stack aus Repo" eigenständig und
  ohne Bezug auf ein zentrales Compose-File deploybar (verfeinert in [[app-stack-alexstuder-webpage]],
  [[app-stack-rapt-dashboard]], [[app-stack-brew-assistent]]).
- **AC2** — Kein App-Compose-File enthält `cloudflared` oder `watchtower`; nur **öffentliche** Services
  tragen das Label `cloudflare.tunnel-hostname=<host>`; `db`/`auth`/`rest` bleiben unmarkiert (E2).
- **AC3** — dev-gui besitzt/transportiert **keine** App-Boot-Secrets; diese werden beim Erst-Deploy
  **auf dem VPS** generiert und verbleiben dort in der App-`.env` (E3, verfeinert in [[stack-deploy-orchestration]]).
- **AC4** — Routing + Reconciliation sind **stack-aware** (mehrere Hostnames/Container pro Stack,
  Stack über `com.docker.compose.project` erkennbar) und brechen das bestehende Single-Image-Verhalten nicht (E2).
- **AC5** — Es existiert **kein** geteiltes Secret zwischen den Apps (`SSO_SIGNING_SECRET` entfällt; E4).
- **AC6** (Security/Floor) — Über alle Etappen: keine App-Boot-Secrets und kein SSH-Key/CF-Token in
  Response, Log, Audit, WS-Stream, Argv oder Frontend-Bundle; alle mutierenden dev-gui-Aktionen
  hinter Access + identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`) + Audit-First + LockoutGuard-Hard-Block.

## Nicht-Ziele
- **SSO/REST-Föderation** assistent↔rapt (E4 — explizit vertagt).
- **Build/Push** der App-Images (App-Repos haben ihre eigene CI; dieser Modus **konsumiert** Images
  bzw. baut sie nicht in dev-gui).
- **Migration** der DB-Daten (kein Prod existiert; Clean-Cut wie im Pivot-Konzept).
- Ein **zentraler** dev-gui-Secret-Store für App-Boot-Secrets (E3 verbietet das ausdrücklich).

## Abhängigkeiten
- [[deploy-lifecycle]] (Single-Image-Modus bleibt; teilt Label-Konvention + `VpsDockerControl`).
- [[cloudflare-reconciliation]] (wird stack-aware erweitert).
- [[view-cloudflare]] (`CloudflareApi`-Boundary), [[settings-credentials]] (CF-Token),
  [[settings-ssh-keys]] (SSH-Key), [[vps-provider-boundary]] (welche VPS existieren),
  [[access-and-guardrails]] (Access + Audit + LockoutGuard).
- `docs/architecture.md` — ADR-008 (SSH-Linie), ADR-010 (CloudflareApi), ADR-011 (LockoutGuard),
  ADR-012 (DeployOrchestrator/VpsDockerControl), ADR-013 (ReconciliationJob). **Neuer ADR für die
  `VpsComposeControl`-Boundary + Stack-Registry erforderlich** (architekt) — diese Spec fixiert das
  Verhalten, nicht die tiefe Architektur-Grenze.
- Quell-Vorlagen (webPage_infra): `docker-compose.yml`, `supabase/kong-*/kong.yml`,
  `supabase/db_init_*/zz-set-role-passwords.sh`, `scripts/db-init-runner.sh`,
  `scripts/generate-supabase-secrets.sh` (Secret-Generierung), `scripts/backup.sh`/`restore.sh`.
