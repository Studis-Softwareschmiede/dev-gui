---
id: app-stack-alexstuder-webpage
title: App-Stack alexstuderWebpage — Pilot-Compose (nur web_hauptseite + Label) (Etappe 2)
status: draft
version: 1
---

# Spec: App-Stack alexstuderWebpage (`app-stack-alexstuder-webpage`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate).
> Dach: [[compose-stack-deployment]] (E1/E2). Erst-Pilot des neuen Modus — beweist die Mechanik
> **ohne** DB/Proxy/Secrets-Risiko.
> **Repo-Hinweis:** Das `docker-compose.yml` lebt im **App-Repo** (alexstuderWebpage), nicht in dev-gui.
> Diese Spec ist die durable Vorgabe für dieses Compose-File + den dev-gui-Stack-Registry-Eintrag.

## Zweck
Den trivialsten, zustandslosen Stack (statische Hauptseite, `web_hauptseite`) als **eigenständiges,
pro-App deploybares Compose-Stack** über den neuen dev-gui-Modus „Compose-Stack aus Repo" deployen —
als Beweis der gesamten Mechanik (clone/pull → composeUp → Cloudflare-Route) ohne DB/Proxy/Secrets.

## Verhalten
1. Das App-Repo enthält ein **eigenes** `docker-compose.yml` mit **genau einem** Service
   `web_hauptseite` (Nginx, statischer Build, zustandslos).
2. `web_hauptseite` ist **öffentlich** → trägt das Label `cloudflare.tunnel-hostname=<haupt-host>`
   (z.B. `alexstuder.<domain>`). Es gibt **keine** internen Services.
3. Das Compose-File enthält **KEIN** `cloudflared` und **KEIN** `watchtower` (E2 — dev-gui managed Routing/Updates).
4. Es gibt **keine** App-Boot-Secrets, **keine** `.env`-Generierung (zustandslos) — der Pilot prüft den
   Pfad ohne Secret-Komplexität.
5. dev-gui-Stack-Registry-Eintrag verweist auf Repo/Branch/compose-Pfad + `publicServices: [{ web_hauptseite,
   <haupt-host> }]` + `tunnelId`. Deploy/Undeploy/Status laufen über [[stack-deploy-orchestration]].

## Acceptance-Kriterien
- **AC1** — Das App-Repo-`docker-compose.yml` definiert genau einen Service `web_hauptseite`
  (statischer Nginx-Build); kein DB/auth/rest/kong/proxy, kein `cloudflared`, kein `watchtower`.
- **AC2** — `web_hauptseite` trägt das Label `cloudflare.tunnel-hostname=<haupt-host>` (öffentlicher
  Service); kein anderes Label-Routing-Artefakt. Testbar: `docker inspect` zeigt das Label.
- **AC3** — Der Stack ist über den dev-gui-Modus „Compose-Stack aus Repo" deploybar: nach Deploy läuft
  der Container (compose ps), und der Haupt-Hostname ist über den remote-managed Tunnel auf den
  Container geroutet (Route + DNS-CNAME über den geteilten ADR-012-Anlege-Pfad).
- **AC4** — Undeploy entfernt die Route + DNS und fährt den Stack via `compose down` herunter
  (type-to-confirm Stack-Name; [[stack-deploy-orchestration]] AC8).
- **AC5** — Keine `.env`-Generierung, keine App-Boot-Secrets im Stack; keine Secrets im Repo, im
  Compose-File oder in dev-gui-Logs/Audit/Response.
- **AC6** — Der Stack ist **unabhängig** von den anderen Apps deploybar (eigenes Netz/Projektname über
  `--project-name`; kein Include/Bezug auf rapt/assistent/webPage_infra).

## Verträge
- **Compose-File (App-Repo):** ein Service `web_hauptseite`, Image aus der App-CI (ghcr/registry je
  App-Konvention), `restart: unless-stopped`, Label `cloudflare.tunnel-hostname=<haupt-host>`,
  Container-Port = App-Konvention (z.B. 8080/80; muss zum Route-Origin passen, das
  [[stack-deploy-orchestration]] setzt). **Kein** `cloudflared`/`watchtower`/Ports-Publishing über das
  von dev-gui gewählte Host-Port-Mapping hinaus.
- **dev-gui-Stack-Registry-Eintrag:** `{ stackName: "alexstuder-webpage", repoUrl, branch, composeFile:
  "docker-compose.yml", vps, publicServices: [{ service: "web_hauptseite", hostname: "<haupt-host>" }],
  tunnelId, secretsSpec: { generate: [], required: [] } }`.

## Edge-Cases & Fehlerverhalten
- Protected Haupt-Hostname → 422 `protected-resource` (LockoutGuard) — Deploy abgelehnt.
- Image nicht verfügbar (Pull denied) → composeUp-Fehler, kein Route-Schritt.
- Re-Deploy → `git pull` + `compose up -d` recreate; keine Secret-Berührung (es gibt keine).

## NFRs
- **Sicherheit (Floor):** zustandslos, keine Secrets; Route-Anlage hinter Access + Rolle + Audit +
  LockoutGuard (über [[stack-deploy-orchestration]]).
- **Einfachheit (Pilot-Zweck):** minimale Fläche — beweist nur den clone→up→route-Pfad.

## Nicht-Ziele
- DB/Proxy/Supabase (gibt es in diesem Stack nicht).
- Build/Push des `web_hauptseite`-Images (App-CI, nicht dev-gui).

## Abhängigkeiten
- [[compose-stack-deployment]] (Dach, E1/E2).
- [[vps-compose-control]] + [[stack-deploy-orchestration]] (dev-gui-Fähigkeit — Voraussetzung, Etappe 1).
- Quelle: `webPage_infra/docker-compose.yml` Service `web_hauptseite` (heutige Definition als Vorlage).
