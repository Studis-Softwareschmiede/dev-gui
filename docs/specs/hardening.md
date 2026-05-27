---
id: hardening
title: VPS-Härtung (Non-Root + Docker-Socket-Proxy)
status: draft
version: 1
---

# Spec: VPS-Härtung (`hardening`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> Kontext: dev-gui läuft auf dem VPS hinter Cloudflare Access als *pre-granted/unbeaufsichtigte* Engine (ADR-003). Zwei Dinge minimieren den Blast-Radius **und** ermöglichen erst das unbeaufsichtigte Fahren: der Container darf nicht als root laufen, und der Docker-Socket darf nicht roh in den Container.

## Zweck
dev-gui VPS-reif machen: (1) **Non-Root-Container** → Claude erlaubt `--dangerously-skip-permissions` (unbeaufsichtigt, ADR-003) und die Container-Privilegien sinken; (2) **docker-socket-proxy** statt rohem Socket → der Agent erreicht nur die nötigen, nicht die gefährlichen Docker-Endpunkte.

## Verhalten
1. Der Container-Prozess läuft als **Non-Root** (`node`-User, uid 1000); HOME = `/home/node`; alle Laufzeit-Pfade (Claude-Login-Volume, gpg.pass, Plugin-Cache, App-Code) liegen unter dem Non-Root-Home.
2. Als Non-Root startet die PtyManager-Session mit `--dangerously-skip-permissions` (über `SESSION_ARGS`), sodass GUI-Trigger **ohne** Bash-Prompt pro Aktion laufen — der Schutz liegt bei Cloudflare Access (ADR-004).
3. dev-gui mountet den **rohen Docker-Socket nicht**; ein **docker-socket-proxy**-Sidecar gibt eine eingeschränkte Docker-API frei; dev-gui spricht via `DOCKER_HOST=tcp://socket-proxy:2375`.

## Acceptance-Kriterien
- **AC1** — Der Container läuft als **Non-Root**. Testbar: `docker run --rm <image> id -u` → ≠ `0` (der `node`-User, uid 1000). `/app` + benötigte Verzeichnisse gehören dem User; keine root-only-Pfade im Laufpfad.
- **AC2** — Alle Laufzeit-Mounts/Pfade liegen unter `/home/node`: Claude-Login-Volume → `/home/node/.claude`, gpg.pass → `/home/node/.config/softwareschmiede/gpg.pass`, Plugin-Cache → `/home/node/.claude/plugins`. **Build + Plugin-Auto-Provisionierung (Entrypoint) + Auth-Kette (gpg→mint→gh) funktionieren weiterhin als Non-Root.** (BOOTSTRAP.md-Mounts entsprechend aktualisiert.)
- **AC3** — Mit `SESSION_ARGS=["--dangerously-skip-permissions"]` erreicht die Session als Non-Root `ready` (kein „cannot be used with root/sudo"-Fehler, kein Restart-Loop) → GUI-Trigger laufen **unbeaufsichtigt**. Testbar: `/api/session` ist `ready`, Logs zeigen keinen Root-Guard-Fehler.
- **AC4** — Bei der Compose-/Deploy-Konfiguration mountet dev-gui **keinen** `/var/run/docker.sock`; stattdessen existiert ein **socket-proxy**-Service (z.B. `tecnativa/docker-socket-proxy`) mit nur den nötigen Rechten: `CONTAINERS=1`, `IMAGES=1`, `POST=1` (für `/agent-flow:preview up/down`), **`EXEC=0`** und sonstige gefährliche Endpunkte aus. dev-gui erhält `DOCKER_HOST=tcp://socket-proxy:2375`.
- **AC5** — DockerReader (`docker ps`) **und** die `docker`-Aufrufe von `/agent-flow:preview` funktionieren über den Proxy (das `docker`-CLI ehrt `DOCKER_HOST` — i.d.R. ohne Code-Änderung; verifizieren). `/api/status` liefert `previews` über den Proxy.
- **AC6** — Ein **Deploy-Artefakt** im Repo (`docker-compose.yml` oder `deploy/`-Snippet) definiert dev-gui **+** socket-proxy zusammen (gemeinsames internes Netz; nur der Proxy hat den Socket, read-mostly).

## Verträge
- Image: läuft als uid 1000 (`node`); `ENTRYPOINT` + node-pty + claude funktionieren als Non-Root.
- Env (Laufzeit): zusätzlich `DOCKER_HOST=tcp://socket-proxy:2375`; `SESSION_ARGS` für Skip-Permissions.
- socket-proxy: `tecnativa/docker-socket-proxy` mit `CONTAINERS/IMAGES/POST=1`, `EXEC=0`, Default-deny für den Rest.

## Edge-Cases & Fehlerverhalten
- node-pty als Non-Root: `/dev/ptmx` ist world-zugänglich → PTY funktioniert; falls nicht, dokumentieren.
- `claude login`-Volume muss dem `node`-User gehören (sonst kann claude die Credentials nicht schreiben).
- socket-proxy nicht erreichbar → DockerReader degradiert (`previews` „unknown"/leer), kein Crash (factory-status AC4).

## NFRs
- **Sicherheit (Tradeoff dokumentieren):** `POST=1` erlaubt Container-Create — mit Bind-Mounts theoretisch mächtig; der Proxy ist **kein** vollständiger Sandbox-Ersatz. Primäre Kontrolle bleibt **Cloudflare Access** (nur erlaubte Identitäten) + **Non-Root** + gesperrtes `EXEC`. Der rohe Socket (= Host-Root) ist eliminiert.
- Keine Secrets im Image; Credentials weiterhin nur zur Laufzeit gemountet.

## Nicht-Ziele
- Vollständige Container-Sandbox / rootless-Docker (späterer Schritt, falls nötig).

## Abhängigkeiten
- [[deployment]] (Image/Bootstrap), [[factory-status]] (DockerReader), [[flow-trigger]] (preview-Befehle), [[access-and-guardrails]] (Access als primäre Kontrolle).
