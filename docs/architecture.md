# Detailkonzept / Architektur — dev-gui

> **Schicht 2 von 3.** Das **WIE konzeptionell** — logisch, sprach-/paradigma-unabhängig (Komponenten/Flows/Zustände, keine Idiome/Klassen). Bindend für den `coder`; Architektur-Konformität ist Review-Kriterium.

## Domänenmodell
- **Session** — die *eine* interaktive Claude-Code-Session, die die GUI fernsteuert. Lebenszyklus: `starting → ready → busy → ready` (bzw. `stopped`/`failed`). Genau eine pro Dienst.
- **Command** — ein ausgelöster Slash-Befehl (z.B. `/flow #12`) + Status (`queued → running → done|cancelled`) + Auslöser-Identität + Zeit.
- **Read-Models** (nur gelesen, nie persistiert): **Project** (Org-Repo ≠ agent-flow), **BoardItem**, **CIRun**, **PreviewContainer**.
- **AuditEntry** — append-only: Zeit, Access-Identität, Befehl.

## Komponenten
**Backend (Node, ESM, Express + ws):**
- **PtyManager** — startet/hält/restartet **genau eine** `claude`-Session in einem PTY (`node-pty`); schreibt Input, broadcastet Output; kennt den Session-Zustand. *Boundary:* einziger Ort, der den PTY berührt.
- **WS-Gateway** — WebSocket `/ws/terminal`: Client-Eingaben → PtyManager; PTY-Output → alle Clients. Reicht auch Status-Pushes durch.
- **CommandService** — nimmt Trigger entgegen, prüft **Allowlist** + **Concurrency-Lock (1)**, injiziert den Befehl in die Session, schreibt den **AuditEntry**. *Boundary:* einziger Schreibpfad in die Session von außen.
- **GitHubReader** — liest Projekte/Board/CI über den GitHub-App-Token. *Boundary:* einziger GitHub-Zugriff.
- **DockerReader** — liest Preview-Container über die Docker-Engine. *Boundary:* einziger Docker-Zugriff.
- **AccessGuard** — Middleware: validiert den Cloudflare-Access-JWT (`Cf-Access-Jwt-Assertion`) vor jeder `/api/*`- und WS-Anfrage; Fail-Fast beim Boot ohne Access-Konfig.
- **Static server** — liefert das gebaute React-Frontend.

**Frontend (React):**
- **App-Shell** — Einstiegs-Panel (vier Kacheln: GitHub · VPS · Cloudflare · Fabrik) + client-seitige Navigation (deep-linkbare Routen, Browser-Verlauf, Fallback auf Panel). Rendert je nach Route eine der vier Ansichten. *Boundary:* einziger Ort, der View-Routing kennt.
- **Fabrik-Ansicht** — Terminal-Pane (xterm.js) · Status-Dashboard · Flow-Trigger-Panels · Job-/Kill-Steuerung (= bisheriges Frontend, jetzt als eine Ansicht eingebettet).
- **GitHub- / VPS- / Cloudflare-Ansicht** — derzeit Platzhalter-Views (Grundgerüst); Detail-Funktionen + zugehörige Backend-Boundaries folgen als eigene Anforderungen. *Geplante neue Boundaries (noch nicht entschieden):* erweiterter `GitHubReader`/Schreibpfad, ein **VPS-Provider-Boundary** (z.B. Hetzner-API) und ein **Cloudflare-API-Boundary** — jeweils mit Secret-Handling, Audit + Identitäts-/Rollenschutz (Entscheidung: `architekt`).

**Davor (Infra, nicht im Image):** Cloudflare **Access** (Identitäts-Gate) + Tunnel-Route `devgui.<domain>`.

## Kern-Flows
1. **Flow auslösen:** Panel-Klick → `POST /api/command {command}` → AccessGuard ok → CommandService: Allowlist ok? Lock frei? → schreibt `command\n` in den PTY, Command→`running`, AuditEntry → PTY-Output streamt via WS → xterm rendert → bei Prompt-Ende Command→`done`, Lock frei.
2. **Status laden:** Frontend abonniert `GET /api/status` (Polling/SSE) → GitHubReader + DockerReader aggregieren **live** → Dashboard rendert.
3. **Kill-Switch:** `POST /api/command/cancel` → Interrupt (Ctrl-C) an die Session → Command→`cancelled`, Lock frei.
4. **Session-Bootstrap:** Container-Start → `claude` per **Abo-OAuth** (persistierte Credentials, kein API-Key) interaktiv im PTY → Session `ready`.

## Zustände
- **Session:** `starting → ready ⇄ busy`; `→ stopped` (down), `→ failed` (Restart-Limit überschritten). Restart-Policy: bis *N* Neustarts in *M* s, sonst `failed`.
- **Command:** `queued → running → (done | cancelled)`. Globaler Lock: max **1** `running`.

## Externe Schnittstellen
- **Claude Code CLI** — interaktiv via PTY (`node-pty`). **Vertrag:** Start **ohne** `-p`/`--print`, **ohne** `ANTHROPIC_API_KEY`; Auth = Abo-OAuth (persistierte Credentials). Pre-granted Tool-Permissions (dokumentiert).
- **GitHub** — REST/GraphQL via App-Token (read-only Nutzung hier).
- **Docker Engine** — Socket, read-only Nutzung (`ps`/`inspect`).
- **Cloudflare Access** — JWT im Header `Cf-Access-Jwt-Assertion`; validiert gegen Team-Domain + AUD (Public Keys von `/cdn-cgi/access/certs`).

## NFRs (prüfbar)
- **Sicherheit (Floor):** keine `/api/*`-/WS-Anfrage ohne gültigen Access-Nachweis (→403). Dienst **startet nicht** ohne Access-Konfig in Produktion. Keine Secrets (API-Key, GPG-Passphrase, Tokens) in Frontend-Bundle, Logs, Audit oder WS-Stream.
- **Kosten:** Engine nutzt ausschließlich die interaktive Abo-Session — **kein** API/`-p`. (Testbar: Prozess-Argv + Environment.)
- **Concurrency:** global **max. 1** laufender Command.
- **Beobachtbarkeit:** jeder ausgelöste Befehl im append-only Audit-Log (`GET /api/audit`).
- **Verfügbarkeit:** Session überlebt Absturz via Restart-Policy.

## Entscheidungen (ADR)
- **ADR-001 · 2026-05-26 · Engine = interaktive Claude-Session via `node-pty`** (nicht Agent-SDK, nicht `claude -p`). *Grund:* Abo deckt nur interaktive Nutzung kostenlos; API + `-p` kosten Token bzw. ziehen ab 2026-06-15 aus separatem SDK-Kontingent. *Verworfen:* Agent-SDK (`@anthropic-ai/claude-agent-sdk`, API-Cost), `claude -p` (separates Kontingent).
- **ADR-002 · 2026-05-26 · Session-Ort = VPS, always-on.** *Grund:* jederzeit über `devgui` erreichbar. *Verworfen:* Mac-Runner (muss laufen) — geringere Cred-Fläche, aber nicht always-on.
- **ADR-003 · 2026-05-26 · Pre-granted, unbeaufsichtigt.** *Grund:* maximaler Komfort, Voll-Steuerung ab Tag 1. *Verworfen:* attended (Genehmigung pro Prompt). *Risiko* (RCE-Fläche) bewusst getragen — kompensiert durch ADR-004 + Leitplanken (`access-and-guardrails`).
- **ADR-004 · 2026-05-26 · Auth = Cloudflare Access** (kein App-Login). *Grund:* Zero-Trust ohne App-Code; einzige Mauer vor der pre-granted Engine. *Verworfen:* Supabase-JWT (mehr Code, weiterer Dienst).
- **ADR-005 · 2026-05-26 · Kein eigener State-Store.** GitHub + Docker sind Source of Truth; jede Statusantwort wird live ermittelt.
- **ADR-006 · 2026-05-26 · Stack = Node-Vollstack** (React + Express + ws + `node-pty` + xterm.js). *Grund:* ein Dienst, SDK-frei, passt zur PTY-Bridge.
