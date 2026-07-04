---
id: app-stack-brew-assistent
title: App-Stack brew_assistent — Compose (web_assistent + api_proxy[assistent] + Lean-Supabase + db-init + Labels, KEIN SSO) (Etappe 4)
status: draft
area: deployment
version: 1
---

# Spec: App-Stack brew_assistent (`app-stack-brew-assistent`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). **Security-kritisch** (App-DB,
> auth, Secret-Generierung auf VPS, OpenAI-Key).
> Dach: [[compose-stack-deployment]] (E1/E2/E3/E4). Spiegelt die in Etappe 3 bewährte Mechanik; **KEIN SSO**.
> **Repo-Hinweis:** Das `docker-compose.yml` lebt im **App-Repo** (`brew_assistent-new`), nicht in dev-gui.

## Zweck
Der brew_assistent als **eigenständiges, pro-App deploybares Compose-Stack**: `web_assistent` +
`api_proxy` (role=assistent: OpenAI + Brewfather) + **eigene** Lean-Supabase (`db` + `auth` + `rest` +
`kong`) + `db-init` (one-shot). Eigener Login (`auth`), **KEIN SSO** (E4). App-Boot-Secrets +
`OPENAI_API_KEY` leben lokal auf dem VPS in der App-`.env` (E3 — generierbare Werte auf dem VPS erzeugt;
nicht-generierbare wie `OPENAI_API_KEY` einmalig auf dem VPS eingetragen).

## Verhalten
1. Das App-Repo enthält ein **eigenes** `docker-compose.yml` mit den Services:
   `web_assistent`, `api_proxy` (PROXY_ROLE=assistent: OpenAI + Brewfather, **kein** db-sync),
   `db` (Lean-Supabase Postgres), `auth` (GoTrue), `rest` (PostgREST), `kong`, `db-init` (one-shot).
   `realtime`/`storage`/`studio`/`meta` entfallen.
2. **Öffentliche Services** (tragen `cloudflare.tunnel-hostname`):
   - `web_assistent` → App-Host (z.B. `assistent.<domain>` bzw. die Haupt-App-Domäne).
   - `kong` → DB-Host `db-assistent.<domain>`.
   - `api_proxy` → ggf. Proxy-Host (z.B. `api-assistent.<domain>`), falls der Client ihn direkt
     erreichen muss; sonst intern. Registry legt die genaue Liste fest.
   **Interne Services** (KEIN Label): `db`, `auth`, `rest`, `db-init`.
3. Compose-File **ohne** `cloudflared`/`watchtower` (E2).
4. **App-Boot-Secrets** (`ASSISTENT_POSTGRES_PASSWORD`, `ASSISTENT_JWT_SECRET`, `ASSISTENT_ANON_KEY`,
   `ASSISTENT_SERVICE_ROLE_KEY`) beim **Erst-Deploy** über `generate-supabase-secrets.sh` **auf dem VPS**
   erzeugt (E3). **`OPENAI_API_KEY`** ist **nicht generierbar** → wird von dev-gui **nicht** transportiert;
   er wird einmalig direkt auf dem VPS in die `.env` eingetragen (Betreiber-Schritt); dev-gui prüft beim
   Deploy nur **Vorhandensein** des Schlüssels, nie den Wert ([[stack-deploy-orchestration]] AC5).
   **KEIN** `SSO_SIGNING_SECRET` (E4); **kein** `RAPT_SERVICE_ROLE_KEY`/`DATABASE_URL` (kein db-sync).
5. `db-init` (one-shot) wendet die konsolidierte `aibrewgenius`-Init-Baseline (ohne RAPT-Reste) +
   pending Migrationen idempotent an, nach `auth.users`-Readiness; `db_scripts/` im App-Repo.
6. RAPT-Key-Eintragungs-UI entfällt im assistent (Pivot-Entscheidung 7). End-User-Creds bleiben lokal
   in der assistent-DB/Vault auf dem VPS (multiuser; dev-gui fasst sie nie an, E3).
7. Stack-Deploy/Undeploy/Status über [[stack-deploy-orchestration]]; eigenes Netz + Projektname
   (`--project-name brew-assistent`).

## Acceptance-Kriterien
- **AC1** — Das App-Repo-`docker-compose.yml` definiert: `web_assistent`, `api_proxy`
  (PROXY_ROLE=assistent), `db`, `auth`, `rest`, `kong`, `db-init` (one-shot). Kein
  `realtime`/`storage`/`studio`/`meta`, kein `cloudflared`, kein `watchtower`. Eigenes App-Netz; keine
  Includes/Bezüge auf rapt/webPage_infra.
- **AC2** — Nur öffentliche Services (`web_assistent`, `kong`, ggf. `api_proxy`) tragen
  `cloudflare.tunnel-hostname=<host>`; `db`/`auth`/`rest`/`db-init` tragen **kein** solches Label (intern).
- **AC3** — Beim Erst-Deploy generiert dev-gui die assistent-App-Boot-Secrets **auf dem VPS**
  ([[stack-deploy-orchestration]] AC3); die Werte erscheinen nie in dev-gui-Response/Log/Audit/WS.
  Re-Deploy lässt die `.env` unverändert ([[stack-deploy-orchestration]] AC4).
- **AC4** — `OPENAI_API_KEY` wird von dev-gui **nicht** transportiert; fehlt der Schlüssel in der
  VPS-`.env`, meldet der Deploy einen klaren, geheimnis-freien Fehler **ohne** je einen Wert zu
  lesen/zeigen ([[stack-deploy-orchestration]] AC5). Der assistent-`api_proxy` bricht beim Start ab,
  wenn `OPENAI_API_KEY` fehlt (bestehendes Proxy-Verhalten).
- **AC5** — **KEIN** `SSO_SIGNING_SECRET` und **kein** SSO-Ticket-Pfad im Stack/Proxy (E4); der
  assistent-`api_proxy` startet ohne SSO-Secret; **kein** `RAPT_SERVICE_ROLE_KEY`/`DATABASE_URL`
  (kein db-sync in dieser Rolle).
- **AC6** — `db-init` wendet die `aibrewgenius`-Baseline (ohne RAPT-Reste) + pending Migrationen
  idempotent nach `auth.users`-Readiness an (`restart: "no"`; re-run = No-op). `db_scripts/` aus dem App-Repo.
- **AC7** — Der Stack ist über den dev-gui-Modus „Compose-Stack aus Repo" eigenständig deploybar und
  **unabhängig** von den anderen Apps (eigener Projektname/Netz). Undeploy entfernt alle Stack-Routen +
  DNS und fährt den Stack herunter (Volumes behalten; type-to-confirm).
- **AC8** (Security/Floor) — Keine App-Boot-Secrets/keine End-User-Creds in dev-gui; keine Secrets im
  Repo/Compose-File/Logs/Audit/Response/WS/Frontend. End-User-Creds bleiben lokal in der assistent-DB/
  Vault auf dem VPS (multiuser; E3).

## Verträge
- **Compose-File (App-Repo, Vorlage = `webPage_infra/docker-compose.yml` assistent-Anteil):**
  Service-Namen App-lokal, Supabase-Images versionsgepinnt, `web_assistent`/`api_proxy` aus App-CI,
  `db-init` `restart: "no"` + `db_scripts/`-Mount. Env via App-`.env` auf dem VPS. Öffentliche Services
  mit `cloudflare.tunnel-hostname`-Label.
- **PROXY_ROLE=assistent**: `api_proxy` mit `SUPABASE_INTERNAL_URL` → stack-eigenes `kong`,
  `SUPABASE_ANON_KEY`, `OPENAI_API_KEY` (VPS-lokal). **Ohne** `SSO_SIGNING_SECRET`, **ohne**
  `RAPT_SERVICE_ROLE_KEY`/`DATABASE_URL` (kein db-sync).
- **secretsSpec** im Registry-Eintrag: `generate: [ASSISTENT_POSTGRES_PASSWORD, ASSISTENT_JWT_SECRET,
  ASSISTENT_ANON_KEY, ASSISTENT_SERVICE_ROLE_KEY]`, `required: [OPENAI_API_KEY]` (nicht-generierbar,
  nur Existenz auf dem VPS geprüft).
- **publicServices:** `[{ web_assistent, <app-host> }, { kong, db-assistent.<domain> }]` (+ ggf.
  `api_proxy`, `api-assistent.<domain>`). `tunnelId` im Registry-Eintrag.

## Edge-Cases & Fehlerverhalten
- Protected öffentlicher Hostname → 422 `protected-resource`, kein Schritt.
- `OPENAI_API_KEY` fehlt in der VPS-`.env` → klarer Fehler ohne Wert-Leak; assistent-Proxy startet nicht.
- `db-init`-Fehler → Exit≠0, Stack gestört, kein „ok".
- Re-Deploy rotiert keine Secrets ([[stack-deploy-orchestration]] AC4).

## NFRs
- **Sicherheit (Floor, hart):** generierbare App-Boot-Secrets auf dem VPS erzeugt; `OPENAI_API_KEY`
  VPS-lokal, nie durch dev-gui transportiert; kein SSO-Secret (E4); End-User-Creds lokal in DB/Vault.
  Route-Anlage hinter Access + Rolle + Audit + LockoutGuard.
- **Lean:** kein realtime/storage/studio/meta.
- **Unabhängigkeit:** eigener Projektname/Netz/Volume; verteilt deploybar.

## Nicht-Ziele
- SSO/REST-Föderation zu rapt (E4 — vertagt).
- Build/Push der `web_assistent`/`api_proxy`-Images (App-CI).
- Backup/Restore der assistent-DB (Etappe 5; [[webpage-infra-decommission]]).
- RAPT-Key-Eintragungs-UI im assistent (entfällt, Pivot-Entscheidung 7).

## Abhängigkeiten
- [[compose-stack-deployment]] (Dach, E1–E4).
- [[vps-compose-control]] + [[stack-deploy-orchestration]] (dev-gui-Fähigkeit — Voraussetzung).
- [[app-stack-rapt-dashboard]] (bewährte die DB/Proxy/Secret-Mechanik zuerst).
- Quellen (webPage_infra): assistent-Anteil von `docker-compose.yml`, `supabase/kong-assistent/kong.yml`,
  `supabase/db_init_assistent/zz-set-role-passwords.sh`, `scripts/db-init-runner.sh`,
  `scripts/generate-supabase-secrets.sh`; assistent-`db_scripts/` (App-Repo).
