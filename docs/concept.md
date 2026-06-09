# Konzept — dev-gui

> **Schicht 1 von 3** (Konzept → Detailkonzept → Spezifikation). Das **WARUM & WAS**, sprach-/paradigma-unabhängig. Ändert selten. Source of Truth — der Code ist nachgelagert.

## Problem
Die agent-flow-**Fabrik** wird heute ausschließlich per CLI/Slash-Commands bedient. Der Status ist über mehrere Oberflächen verstreut (GitHub Projects/Actions/Packages + lokales Docker), und einen Flow zu starten heißt, im Terminal Befehle zu tippen. Es fehlt eine **zentrale Web-Oberfläche**, die den Fabrik-Status zeigt **und** Flows auf Knopfdruck auslöst — **ohne** pro-Token-API-Kosten (das Claude-Abo ist bezahlt und soll die Engine sein).

## Nutzer & Kontext
Einzel-Betreiber (Alex) + optional ein Outside-Collaborator. Desktop-Browser. Erreichbar über `devgui.<domain>` via Cloudflare-Tunnel, **hinter Cloudflare Access** (private Admin-Konsole, kein öffentliches SaaS).

## Ziele
- **Status in einer Ansicht:** Projekte der Org, offene Board-Items, letzter CI-Lauf, laufende Preview-Container — **live** aus GitHub-API + Docker (kein eigener Store).
- **Flows auf Knopfdruck:** `/flow`, `/adopt`, `/preview …`, `/requirement`, `/train` per Panel auslösbar; **Live-Log** des Laufs im Browser.
- **Engine = Abo, nicht API:** jeder Lauf zählt gegen das interaktive Claude-Abo (ferngesteuerte interaktive Session) — **null** Anthropic-API-/`claude -p`-Kosten.
- **Geschützter Zugang:** kein Request ohne gültigen Cloudflare-Access-Nachweis; der Dienst geht ohne Access-Konfig gar nicht erst online.

## Nicht-Ziele
- **Kein** Anthropic-API-Key und **kein** `claude -p` (beide kosten extra / ziehen aus separatem Kontingent).
- **Keine** eigene Datenbank / Persistenz von Fabrik-State — GitHub + Docker sind Source of Truth.
- **Kein** Multi-Tenant / öffentliches SaaS (privates Werkzeug für 1–2 erlaubte Identitäten).
- **Keine** Mensch-im-Loop-Genehmigung pro Aktion (bewusst *pre-granted*) — der Schutz liegt bei Cloudflare Access + den Sicherheits-Leitplanken (1-Job-Limit, Kill-Switch, Audit-Log).

## Scope
Kern-Capabilities (Details je Capability in `docs/specs/<feature>.md`):
1. **Terminal-Bridge** (`terminal-bridge`) — Backend hält **eine** interaktive Claude-Code-Session (Abo-OAuth) in einem PTY und streamt sie über WebSocket.
2. **Terminal-Frontend** (`terminal-frontend`) — xterm.js-Live-Konsole im Browser.
3. **Fabrik-Status** (`factory-status`) — Dashboard live aus GitHub-API + Docker.
4. **Flow-Trigger** (`flow-trigger`) — Panels injizieren erlaubte Slash-Befehle in die Session.
5. **Access & Leitplanken** (`access-and-guardrails`) — Access-Gate, 1-Job-Limit, Kill-Switch, Audit-Log (security-kritisch).
6. **Deployment** (`deployment`) — Docker-Image, Cloudflare-`devgui`-Route, Bootstrap (claude-Install + Abo-OAuth + node-pty + Docker-Socket).

### Scope-Erweiterung: Multi-View-Konsole (ab 2026-06)
Die GUI wächst von einer reinen Fabrik-Oberfläche zu einer **Admin-Konsole mit fünf Ansichten**, erreichbar über ein **Einstiegs-Panel mit fünf Kacheln**:
7. **App-Shell & Navigation** (`app-shell-navigation`) — Einstiegs-Panel (fünf Kacheln: GitHub · VPS · Cloudflare · Fabrik · Deployments) + deep-linkbare Navigation; bindet die bestehende Fabrik-Ansicht (Capabilities 2–4) als Kachel ein. **Grundgerüst zuerst.**
8. **GitHub-Ansicht** (`view-github`) — Repos/Boards/PRs der Org verwalten. *Heute nur Platzhalter-Gerüst; Detail-Funktionen folgen.*
9. **VPS-Ansicht** (`view-vps`) — Server bei **mehreren Providern** (Hetzner, IONOS, Hostinger) verwalten: laufende Maschinen im Überblick, Server **starten/stoppen** und **neu provisionieren** (Create-from-scratch mit Default-Setup via cloud-init: Ubuntu 26.04 LTS → Update → neueste Docker-Version → User `root` + `alex` mit ihren SSH-Keys). Über die **Provider-Boundary** (`vps-provider-boundary`) hinter einem provider-agnostischen `VpsProvider`-Vertrag; Default-Setup in `vps-cloud-init-setup`; SSH-Key-Zuordnung root/alex in `vps-ssh-key-assignment`. **Rebuild (destruktiv) + Backup bewusst vertagt** (`vps-rebuild-backup`, Platzhalter). *Provider-API-Tokens je Provider im `CredentialStore`; Server-mutierende Aktionen auditiert + identitäts-/rollengeschützt.*
10. **Cloudflare-Ansicht** (`view-cloudflare`) — Domäne + Tunnel verwalten: verwaltete Zones/Domänen anwählen → zugehörige Tunnel + Public-Hostname-Routen anzeigen → einzelne Tunnel/Routen **löschen** (Capability A). Über den **Cloudflare-API-Boundary** (`CloudflareApi`, SDK-frei via `fetch`, **remote-managed Tunnels**) hinter dem `CredentialStore`; Self-Lockout der eigenen `devgui`/Access-Mauer **hart gesperrt** (`LockoutGuard`), jede andere Löschung **type-to-confirm**. Dazu zwei Folge-Capabilities: **Deploy-Lifecycle** (`deploy-lifecycle`, ghcr-Image → Container+Tunnel-Route als atomare Einheit) und **Reconciliation-Cron** (`cloudflare-reconciliation`, **beidseitig selbst-heilender** Mitternachts-Abgleich Container ↔ Route: verwaiste Routen entfernen **und** managed Container ohne Route → Route anlegen; je Lauf ein über `AuditStore` persistierter Report + im Panel sichtbare Statusmeldungen; manueller „jetzt abgleichen"-Trigger). *Cloudflare-API-Token + Account-Id im `CredentialStore`; mutierende Aktionen auditiert + identitäts-/rollengeschützt. Entscheidung: `architekt` (ADR-010/011/012/013).*

> **Hinweis zu Nicht-Ziel „kein eigener State-Store":** die VPS- und Cloudflare-Detail-Funktionen führen neue **schreibende** externe Integrationen (Provider-/Cloudflare-API + Docker-on-VPS via SSH) samt Secret-Handling ein. Das ist eine bewusste Architektur-Erweiterung (Entscheidung beim `architekt`: VPS = ADR-009; Cloudflare = ADR-010/011/012/013). ADR-005 (live statt Store) bleibt durchgehend gewahrt: VPS-Maschinen, Cloudflare-Inventar **und** der Deploy-/Reconcile-Bestand sind **Read-Models live** (Docker-Label ⊕ Cloudflare-Route), kein persistenter Domänen-State; einzige Persistenz sind die Betreiber-Credentials im `CredentialStore` (ADR-007).

### Scope-Erweiterung: Zentrale Einstellungen & Credentials (ab 2026-06)
Eine **zentrale Einstellmaske**, über ein **Zahnrad in der App-Shell-Navigation** (nicht als fünfte Einstiegs-Kachel) erreichbar, bündelt die Konfiguration aller Integrationen:
11. **Settings-Ansicht** (`settings-shell`) — Zahnrad-Einstieg + deep-linkbare Settings-View mit Sektionen je Integration (GitHub, Cloudflare, Hetzner/VPS, SSH-Keys). **Grundgerüst zuerst.**
12. **Credential-Verwaltung** (`settings-credentials`) — Credentials je Integration anlegen/ändern/löschen; **write-only** (Geheimwerte werden NIE im Klartext ans Frontend zurückgegeben), nur Status „gesetzt/nicht gesetzt" + maskierte Anzeige; auditiert, identitäts-/rollengeschützt. *Security-kritisch.*
13. **SSH-Key-Verwaltung + VPS-Provisionierung** (`settings-ssh-keys`) — Public/Private-Keys je VPS-Benutzer (z.B. `root`, `alex`) hinterlegen (Stufe A); Public-Key automatisch idempotent in `authorized_keys` eines VPS provisionieren (Stufe B, Folge-Capability am VPS-Boundary). *Security-kritisch.*

> **Architektur-Frage (Credential-Store) — ENTSCHIEDEN (ADR-007/008, 2026-06-07):** Das Speichern von Credentials/Private-Keys ist eine bewusste, eng begrenzte Erweiterung des Nicht-Ziels „keine eigene DB" — es betrifft **Betreiber-Konfiguration**, nicht Fabrik-/Domänen-State (ADR-005 bleibt für den **Lese**-Status gültig). Realisierung: **verschlüsselte JSON-Datei (AES-256-GCM) auf dem bestehenden Volume**, Master-Key aus Boot-Env (`CRED_MASTER_KEY`), einziger Boundary `CredentialStore`; VPS-Provisionierung über eine spätere `VpsProvisioner`-SSH-Boundary (ADR-008). Kein neuer Dienst, keine DB-Engine. Details: `docs/architecture.md`.
