---
id: deployment
title: Deployment (Docker + Cloudflare devgui + Bootstrap)
status: draft
version: 2
---

# Spec: Deployment (`deployment`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.

## Zweck
dev-gui als Container auf den VPS bringen, über Cloudflare als Dienst `devgui.<domain>` (hinter Access) erreichbar machen und im Bootstrap die interaktive Claude-Session (Abo-OAuth) + node-pty + Docker-Socket verdrahten.

## Verhalten
1. Ein einziges Docker-Image bündelt das gebaute React-Frontend + den Node-Backend-Dienst; `node server.js` liefert API + WS + statisches Frontend auf Port 8080.
2. Das Image enthält die `claude`-CLI; der Bootstrap richtet den **Abo-OAuth-Login** ein (einmalig, persistierte Credentials), node-pty-Voraussetzungen und den **Docker-Socket-Zugriff** des Containers.
3. Eine Cloudflare-Tunnel-Route `devgui.<domain>` zeigt auf den Container (Port 8080); eine **Cloudflare-Access-Policy** auf diesem Hostname listet die erlaubten Identitäten.

## Acceptance-Kriterien
- **AC1** — `docker build` erzeugt ein lauffähiges Image (Frontend-Build + Backend); Container hört auf `8080`; `GET /` liefert das Frontend, `GET /api/session` antwortet (hinter Access).
- **AC2** — Das Image enthält die `claude`-CLI; eine **Bootstrap-Doku/Skript** beschreibt nachvollziehbar: Abo-OAuth-Login (persistierte Credentials, **kein** API-Key), node-pty-Build-Voraussetzungen, und den Docker-Socket-Mount (read-only) des Containers.
- **AC3** — Die Deploy-Konfiguration enthält die Cloudflare-Tunnel-Route `devgui.<domain>` → `:8080` **und** eine Access-Policy (Allowlist der erlaubten E-Mails) auf diesem Hostname. (Die App selbst erzwingt Access zusätzlich, siehe [[access-and-guardrails]] AC1/AC2.)
- **AC4** — Der ghcr-Image-Name ist lowercase (`ghcr.io/studis-softwareschmiede/dev-gui`); der Build pusht via eingebautem `GITHUB_TOKEN` (kein zusätzliches Push-Secret).
- **AC5** — Das Runtime-Image enthält das **`docker`-CLI**, sodass der DockerReader (`docker ps`) gegen den read-only gemounteten Socket die Preview-Container lesen kann. Testbar: `docker` ist im Image vorhanden (`command -v docker`); bei gemountetem Socket + laufenden Preview-Containern liefert `GET /api/status` nicht-leere `previews`.
- **AC6** — Das **agent-flow-Plugin wird automatisch provisioniert**: ein Entrypoint installiert es beim ersten Start, falls nicht vorhanden (`claude plugin marketplace add Studis-Softwareschmiede/agent-flow` + `claude plugin install agent-flow@agent-flow`; nutzt `GH_TOKEN` für den Clone des privaten Repos via git-credential-Helper), persistiert im `/root/.claude`-Volume — danach startet der Server. So lösen `/agent-flow:*`-Befehle im Container auf. Die Fabrik-Skills entschlüsseln `.env.gpg` (reist mit dem Plugin-Repo) über die **zur Laufzeit bereitgestellte GPG-Passphrase** (gemountete `~/.config/softwareschmiede/gpg.pass` oder `GPG_PASSPHRASE`) — niemals ins Image gebacken. Testbar: nach dem Boot listet `claude plugin list` agent-flow; ein erkannter `/agent-flow:preview available`-Lauf listet Org-Repos.

## Verträge
- Image: `ghcr.io/studis-softwareschmiede/dev-gui:latest`. Port: `8080`.
- Env (Laufzeit): `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (Pflicht in prod), `GH_TOKEN` (oder App-Key-Quelle) für Status + Plugin-Clone, GPG-Passphrase (gemountete `gpg.pass` **oder** `GPG_PASSPHRASE`) für die Skill-Auth, Docker-Socket-Pfad (read-only).
- Cloudflare: Tunnel-Ingress + Access-Policy für `devgui.<domain>`.

## Edge-Cases & Fehlerverhalten
- Fehlt die Access-Konfig in prod → Container startet nicht (siehe [[access-and-guardrails]] AC2) — bewusst, kein ungeschützter Start.
- Abo-OAuth-Credentials abgelaufen → Session `failed`, Bootstrap-Doku beschreibt Re-Login.

## NFRs
- **Sicherheit:** keine Secrets im Image-Layer/Repo (Credentials zur Laufzeit gemountet/persistiert, nicht eingebacken). Docker-Socket möglichst read-only.

## Nicht-Ziele
- Voll-automatischer VPS-Bootstrap in diesem Item (die VPS-seitige Cloudflare-Detailimplementierung folgt dem allgemeinen Infra-Bootstrap der Fabrik).

## Abhängigkeiten
- Alle vorherigen Specs. Korrespondiert mit der `/preview`-`vps`-Route-Mechanik der Fabrik.
