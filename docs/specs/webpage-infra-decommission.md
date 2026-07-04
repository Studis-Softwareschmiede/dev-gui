---
id: webpage-infra-decommission
title: webPage_infra abwickeln — Bausteine in App-Repos/dev-gui überführen, Repo deprecaten (Etappe 5)
status: draft
area: deployment
version: 1
---

# Spec: webPage_infra-Abwicklung (`webpage-infra-decommission`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate).
> Dach: [[compose-stack-deployment]] (E1/E2/E3). **Letzte** Etappe — erst ausführen, wenn alle drei
> Apps produktiv über den neuen Modus laufen ([[app-stack-alexstuder-webpage]],
> [[app-stack-rapt-dashboard]], [[app-stack-brew-assistent]]).
> **Repo-Hinweis:** Die Verschiebungen betreffen externe Repos (webPage_infra + App-Repos) und ggf.
> dev-gui (mitwandernde Skripte). dev-gui-seitige Änderungen schreibt der coder in dev-gui; die
> App-/infra-Repo-Änderungen sind Cross-Repo-Arbeit, hier durable spezifiziert.

## Zweck
`webPage_infra` als zentrales Deploy-Werkzeug **ablösen**: seine wiederverwendbaren Bausteine wandern
in die App-Repos bzw. in dev-gui, danach wird das Repo **deprecated** (archiviert). Ziel: kein
monolithisches Compose mehr, keine zentrale Secret-Sammlung, keine doppelte Routing-Mechanik.

## Verhalten — Baustein-Überführung (Quelle → Ziel)
1. **kong-Configs** (`supabase/kong-assistent/kong.yml`, `supabase/kong-rapt/kong.yml`) → in die
   jeweiligen **App-Repos** (assistent bzw. rapt), als Volume-Mount im App-Compose.
2. **`zz-set-role-passwords.sh`** (`supabase/db_init_{assistent,rapt}/`) → in die jeweiligen **App-Repos**
   (als `docker-entrypoint-initdb.d`-Mount im App-Compose).
3. **`db-init-runner.sh`** (`scripts/`) → entweder ins jeweilige **App-Repo** (db-init-Image-Quelle) oder
   als geteilter Runner; bindend: der db-init-Schritt jeder App ist self-contained im App-Repo deploybar
   (kein Bezug auf webPage_infra). `coder`/`architekt` wählt App-Repo-lokal vs. geteiltes Runner-Image.
4. **`generate-supabase-secrets.sh`** (Secret-Generierung) → **wandert mit** zu den App-Stacks, sodass
   dev-gui es beim Erst-Deploy **auf dem VPS** ausführen kann (E3, [[stack-deploy-orchestration]] AC3).
   Liegt im App-Repo (mit dem Stack) bzw. wird von dev-gui auf den VPS gebracht; `coder`/`architekt` fixiert den Ort.
5. **`backup.sh`/`restore.sh`** (+ zugehörige R2-/TimescaleDB-Hooks, `restore-supabase-grants.sql`) →
   pro App-DB getrennt in die **App-Repos** (zwei stateful Units: assistent-DB, rapt-DB; TimescaleDB-Hooks
   nur für rapt). Kein Cross-DB-Ordering mehr.
6. **Verworfen/entfernt** beim Cut: `cloudflared`-/`watchtower`-Services (dev-gui managed Routing/Updates,
   E2); zentrales Single-Compose; zentrale `.env.gpg`-Sammlung der App-Boot-Secrets (E3 — Secrets leben
   auf dem VPS); `SSO_SIGNING_SECRET` (E4).
7. **Repo-Deprecation:** `webPage_infra` wird als deprecated markiert (README-Hinweis + Archivierung),
   nachdem alle Bausteine überführt und alle drei Apps über den neuen Modus produktiv sind. Kein
   weiterer Deploy läuft über `webPage_infra`.

## Acceptance-Kriterien
- **AC1** — Jede der drei Apps ist **vollständig** über den neuen Modus „Compose-Stack aus Repo"
  deploybar, **ohne** dass irgendein Pfad noch auf `webPage_infra` verweist (kein Include, kein
  Skript-Bezug, kein zentrales Compose). Testbar: Grep über die App-Repos/Stack-Definitionen findet
  keinen `webPage_infra`-Bezug mehr; Deploy einer App funktioniert mit deaktiviertem/archiviertem `webPage_infra`.
- **AC2** — Die überführten Bausteine (kong-Configs, `zz-set-role-passwords.sh`, db-init-Runner,
  `generate-supabase-secrets.sh`, `backup.sh`/`restore.sh` + Hooks) liegen an ihrem neuen Ort
  (App-Repo bzw. dev-gui) und sind dort funktionsfähig referenziert; die `db-init`/Backup-Pfade der Apps
  nutzen die neuen Orte.
- **AC3** — Kein `cloudflared`/`watchtower` und kein zentrales Single-Compose mehr im aktiven
  Deploy-Pfad; Routing/Updates laufen ausschließlich über dev-gui (E2). Testbar: kein aktives App-Deploy
  bringt `cloudflared`/`watchtower` mit.
- **AC4** — Keine zentrale Sammlung der **App-Boot-Secrets** mehr (keine `.env.gpg` mit DB-PW/JWT/
  ANON/Service-Key/proxy_sync-PW als Quelle für App-Deploys); App-Boot-Secrets leben auf dem VPS (E3).
  `SSO_SIGNING_SECRET` ist entfernt (E4). dev-gui behält ausschließlich Infra-Secrets (E3).
- **AC5** — `webPage_infra` ist als **deprecated** markiert (README-Hinweis, der auf die neuen
  App-Stacks + den dev-gui-Modus verweist) und für neue Deploys nicht mehr verwendet; die Markierung
  erfolgt **erst**, nachdem AC1–AC4 erfüllt sind (alle drei Apps produktiv über den neuen Modus).
- **AC6** (Security/Floor) — Bei der Überführung wird **kein** Secret-Wert in ein Repo, Log, Audit oder
  in dev-gui-Response committet/geleakt; nur Skripte/Templates/Configs wandern, keine Secret-Werte.

## Verträge
- **Überführungs-Matrix** (verbindlich, s. „Verhalten"): Quelle (webPage_infra) → Ziel (App-Repo/dev-gui)
  je Baustein. Backups pro DB getrennt (assistent-DB, rapt-DB); TimescaleDB-Hooks nur rapt.
- **Deprecation-Artefakt:** README-Banner in `webPage_infra` + (optional) GitHub-Repo-Archivierung;
  Verweis auf die drei App-Stack-Specs + [[stack-deploy-orchestration]].
- **dev-gui-seitig:** falls `generate-supabase-secrets.sh` über dev-gui auf den VPS gebracht wird, ist
  der Transport Token-/Secret-frei (das Skript **erzeugt** Secrets auf dem VPS; es **enthält** keine).

## Edge-Cases & Fehlerverhalten
- Eine App läuft noch nicht produktiv über den neuen Modus → Deprecation **nicht** auslösen (AC5-Gate).
- Restore eines Backups muss pro App-DB unabhängig funktionieren (kein Cross-DB-Ordering); ein
  fehlgeschlagener Restore einer DB beeinflusst die andere nicht.
- Versehentlich verbliebener `webPage_infra`-Bezug in einem App-Stack → AC1-Grep schlägt an, Etappe nicht „done".

## NFRs
- **Sicherheit (Floor):** keine Secret-Werte in den überführten Artefakten/Repos; Secrets bleiben auf
  dem VPS (E3); kein geteiltes Secret (E4).
- **Rückbaubarkeit:** Deprecation erst nach grünem Cut aller drei Apps (kein „big bang" ohne Fallback-Fenster).

## Nicht-Ziele
- DB-Daten-Migration (kein Prod; Clean-Cut).
- SSO (E4).
- Neuaufbau der App-Stacks selbst → die drei `app-stack-*`-Specs (diese Etappe verschiebt nur die
  webPage_infra-Bausteine + deprecated das Repo).

## Abhängigkeiten
- [[compose-stack-deployment]] (Dach, E1/E2/E3).
- [[app-stack-alexstuder-webpage]] / [[app-stack-rapt-dashboard]] / [[app-stack-brew-assistent]]
  (müssen produktiv über den neuen Modus laufen — Vorbedingung AC5).
- [[stack-deploy-orchestration]] (der neue Deploy-Pfad, der webPage_infra ersetzt).
- Quellen (webPage_infra): `docker-compose.yml`, `supabase/kong-*/kong.yml`,
  `supabase/db_init_*/zz-set-role-passwords.sh`, `scripts/db-init-runner.sh`,
  `scripts/generate-supabase-secrets.sh`, `scripts/backup.sh`/`restore.sh`,
  `scripts/restore-supabase-grants.sql`, `BACKUP_RESTORE.md`, `MULTIVPS_ARCHITEKTUR.md`.
