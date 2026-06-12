---
id: app-stack-rapt-dashboard
title: App-Stack rapt_dashboard — Compose (web_rapt + api_proxy[rapt] + Lean-Supabase + db-init + Labels) (Etappe 3)
status: draft
version: 1
---

# Spec: App-Stack rapt_dashboard (`app-stack-rapt-dashboard`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). **Security-kritisch** (App-DB,
> auth, Secret-Generierung auf VPS, proxy_sync).
> Dach: [[compose-stack-deployment]] (E1/E2/E3/E4). **Akute Etappe** — löst nebenbei das dringende
> Betriebs-Problem: der Sync-Proxy läuft wieder, RAPT-Telemetrie erscheint.
> **Repo-Hinweis:** Das `docker-compose.yml` lebt im **App-Repo** (`RAPT_Brewing_Dashboard-new`),
> nicht in dev-gui. Diese Spec ist die durable Vorgabe für dieses Compose-File + den Registry-Eintrag.

## Zweck
Das vollständige RAPT-Dashboard als **eigenständiges, pro-App deploybares Compose-Stack**:
`web_rapt` + `api_proxy` (role=rapt) + **eigene** Lean-Supabase (`db` + `auth` + `rest` + `kong`) +
`db-init` (one-shot). Eigener Login (`auth-rapt`), **KEIN SSO** (E4). App-Boot-Secrets werden beim
Erst-Deploy **auf dem VPS** generiert (E3). Öffentliche Services tragen das
`cloudflare.tunnel-hostname`-Label; DB/auth/rest bleiben intern (E2).

## Verhalten
1. Das App-Repo enthält ein **eigenes** `docker-compose.yml` mit den Services:
   `web_rapt`, `api_proxy` (PROXY_ROLE=rapt: RAPT-Telemetrie + `db-sync`), `db` (Lean-Supabase
   Postgres), `auth` (GoTrue), `rest` (PostgREST), `kong` (API-Gateway), `db-init` (one-shot
   Baseline + Migrationen). `realtime`/`storage`/`studio`/`meta` entfallen (verifiziert ungenutzt).
2. **Öffentliche Services** (tragen `cloudflare.tunnel-hostname`):
   - `web_rapt` → App-Host (z.B. `rapt.<domain>`).
   - `kong` → DB-Host `db-rapt.<domain>` (PostgREST/Auth-Gateway für den Flutter-Client).
   **Interne Services** (KEIN Label): `db`, `auth`, `rest`, `db-init`. `api_proxy` ist öffentlich genau
   dann, wenn der Client ihn direkt erreichen muss (eigener Proxy-Host, z.B. `api-rapt.<domain>`) —
   sonst intern; `coder`/Registry legt die genaue öffentliche Service-Liste fest (Default: `web_rapt`,
   `kong`, `api_proxy`).
3. Das Compose-File enthält **KEIN** `cloudflared`, **KEIN** `watchtower` (E2).
4. **App-Boot-Secrets** (`RAPT_POSTGRES_PASSWORD`, `RAPT_JWT_SECRET`, `RAPT_ANON_KEY`,
   `RAPT_SERVICE_ROLE_KEY`, `RAPT_PROXY_SYNC_PASSWORD`) werden beim **Erst-Deploy** über das
   mitwandernde `generate-supabase-secrets.sh` **lokal auf dem VPS** in die App-`.env` erzeugt (E3);
   dev-gui sieht/persistiert diese Werte nie. **KEIN** `SSO_SIGNING_SECRET` (E4).
5. `db-init` (one-shot, `restart: "no"`) wendet die konsolidierte `rapt`-Init-Baseline (falls
   `schema_migrations` leer) + pending Migrationen an, nach `auth.users`-Readiness; idempotent (re-run = No-op).
   Die `db_scripts/` liegen **im App-Repo** (Schema-Authoring zog dorthin, Pivot-Entscheidung 3).
6. `proxy_sync`-Rolle/Grants leben in der **rapt-DB** (db-sync schreibt nur `rapt`). RAPT-Key/Creds
   pro User in `rapt.user_profiles` / Vault (multiuser, lokal auf dem VPS; dev-gui fasst sie nie an, E3).
7. Stack-Deploy/Undeploy/Status über [[stack-deploy-orchestration]]; eigenes Netz + Projektname
   (`--project-name rapt-dashboard`).

## Acceptance-Kriterien
- **AC1** — Das App-Repo-`docker-compose.yml` definiert: `web_rapt`, `api_proxy` (PROXY_ROLE=rapt),
  `db`, `auth`, `rest`, `kong`, `db-init` (one-shot). Kein `realtime`/`storage`/`studio`/`meta`, kein
  `cloudflared`, kein `watchtower`. Eigenes App-Netz; keine Includes/Bezüge auf assistent/webPage_infra.
- **AC2** — Nur die öffentlichen Services (`web_rapt`, `kong`, ggf. `api_proxy`) tragen
  `cloudflare.tunnel-hostname=<host>`; `db`/`auth`/`rest`/`db-init` tragen **kein** solches Label
  (intern). Testbar: `docker inspect` zeigt das Label nur bei öffentlichen Services.
- **AC3** — Beim Erst-Deploy generiert dev-gui die rapt-App-Boot-Secrets **auf dem VPS** (über
  [[stack-deploy-orchestration]] AC3); die Werte erscheinen **nie** in dev-gui-Response/Log/Audit/WS;
  die `.env` lebt nur auf dem VPS. Re-Deploy lässt die `.env` unverändert ([[stack-deploy-orchestration]] AC4).
- **AC4** — **KEIN** `SSO_SIGNING_SECRET` und **kein** SSO-Ticket-Pfad im Stack/Proxy (E4). Der
  rapt-`api_proxy` startet ohne SSO-Secret; es gibt kein geteiltes Secret mit dem assistent-Stack.
- **AC5** — `db-init` wendet Baseline + pending Migrationen idempotent nach `auth.users`-Readiness an
  (`restart: "no"`, beendet sich nach Apply; re-run ohne Schema-Drift = No-op). `db_scripts/` aus dem App-Repo.
- **AC6** — Nach Deploy ist der RAPT-`db-sync`/Telemetrie-Pfad funktionsfähig (Sync-Proxy läuft,
  Telemetrie wird in `rapt` geschrieben) — das akute Betriebs-Problem ist gelöst. Testbar: nach Deploy
  liefert die App-DB Telemetrie-Daten (smoke), der `api_proxy`(rapt) ist gesund.
- **AC7** — Der Stack ist über den dev-gui-Modus „Compose-Stack aus Repo" eigenständig deploybar
  (clone/pull → .env-Generierung → composeUp → Routen je öffentlichem Service) und **unabhängig** von
  den anderen Apps (eigener Projektname/Netz). Undeploy entfernt alle Stack-Routen + DNS und fährt den
  Stack herunter (Volumes behalten; type-to-confirm).
- **AC8** (Security/Floor) — Keine App-Boot-Secrets/keine End-User-Creds/RAPT-Keys in dev-gui;
  keine Secrets im Repo/Compose-File/Logs/Audit/Response/WS/Frontend. End-User-Creds + pro-User-RAPT-Key
  bleiben lokal in `rapt`-DB/Vault auf dem VPS (multiuser; E3).

## Verträge
- **Compose-File (App-Repo, Vorlage = `webPage_infra/docker-compose.yml` rapt-Anteil):**
  Service-Namen App-lokal (z.B. `db`, `auth`, `rest`, `kong` statt `db-rapt` etc. — da pro-Stack
  isoliert über Projektname), Images versionsgepinnt (Supabase-Stack) bzw. aus App-CI (`web_rapt`,
  `api_proxy`), `db-init` `restart: "no"` mit Volume-Mount der `db_scripts/`. Env via App-`.env` auf dem VPS.
  Öffentliche Services mit `cloudflare.tunnel-hostname`-Label.
- **PROXY_ROLE=rapt** (ein Image, Rolle via Env — Pivot B1): `api_proxy` mit `SUPABASE_INTERNAL_URL`
  → stack-eigenes `kong`, `RAPT_SERVICE_ROLE_KEY`, `DATABASE_URL` (proxy_sync@stack-db),
  `RAPT_SYNC_ENABLED`. **Ohne** `SSO_SIGNING_SECRET`, **ohne** `OPENAI_API_KEY`.
- **secretsSpec** im Registry-Eintrag: `generate: [RAPT_POSTGRES_PASSWORD, RAPT_JWT_SECRET,
  RAPT_ANON_KEY, RAPT_SERVICE_ROLE_KEY, RAPT_PROXY_SYNC_PASSWORD]`, `required: []` (alle generierbar).
- **publicServices:** `[{ web_rapt, rapt.<domain> }, { kong, db-rapt.<domain> }]` (+ ggf. `api_proxy`,
  `api-rapt.<domain>`). `tunnelId` im Registry-Eintrag.

## Edge-Cases & Fehlerverhalten
- Protected öffentlicher Hostname → 422 `protected-resource`, kein Schritt.
- `db-init` schlägt fehl (SQL-Fehler, `ON_ERROR_STOP=1`) → Exit≠0, Stack als gestört sichtbar; keine
  „ok"-Meldung für einen halb-initialisierten Stack.
- Erst-Deploy ohne erfolgreiche Secret-Generierung → kein composeUp mit leerer `.env` (siehe
  [[stack-deploy-orchestration]] AC3/AC5).
- Re-Deploy rotiert **keine** Secrets ([[stack-deploy-orchestration]] AC4) — sonst bricht auth/db.

## NFRs
- **Sicherheit (Floor, hart):** App-Boot-Secrets auf dem VPS generiert + verbleibend (E3); kein SSO-Secret
  (E4); End-User-/RAPT-Creds lokal in DB/Vault, dev-gui fasst sie nie an. Route-Anlage hinter Access +
  Rolle + Audit + LockoutGuard (über [[stack-deploy-orchestration]]).
- **Lean:** kein realtime/storage/studio/meta (verifiziert ungenutzt).
- **Unabhängigkeit:** eigener Projektname/Netz/Volume; verteilt deploybar.

## Nicht-Ziele
- SSO/REST-Föderation zu assistent (E4 — vertagt).
- Build/Push der `web_rapt`/`api_proxy`-Images (App-CI).
- Backup/Restore der rapt-DB (Bausteine wandern in Etappe 5; [[webpage-infra-decommission]]).

## Abhängigkeiten
- [[compose-stack-deployment]] (Dach, E1–E4).
- [[vps-compose-control]] + [[stack-deploy-orchestration]] (dev-gui-Fähigkeit — Voraussetzung).
- [[app-stack-alexstuder-webpage]] (Pilot bewies die Mechanik zuerst).
- Quellen (webPage_infra): rapt-Anteil von `docker-compose.yml`, `supabase/kong-rapt/kong.yml`,
  `supabase/db_init_rapt/zz-set-role-passwords.sh`, `scripts/db-init-runner.sh`,
  `scripts/generate-supabase-secrets.sh`; rapt-`db_scripts/` (App-Repo).
