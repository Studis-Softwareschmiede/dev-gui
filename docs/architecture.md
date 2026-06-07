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
- **GitHubReader** — liest Projekte/Board/CI über den GitHub-App-Token. *Boundary:* einziger **read-only** GitHub-Zugriff (kein POST/PATCH/PUT/DELETE).
- **GitHubWriter** *(neu — `src/GitHubWriter.js`; einziger **mutierender** GitHub-Boundary, getrennt vom read-only `GitHubReader`)* — führt schreibende GitHub-Aktionen aus: Org-Repository anlegen (`POST /orgs/{org}/repos`, [[github-repo-create]]) und bestehendes Repo lokal in `WORKSPACE_DIR` klonen ([[github-repo-clone]]). Mintet den Installation-Token **transient unmittelbar vor** dem Aufruf (App-ID/Installation-ID/Private-Key store-intern aus dem `CredentialStore`-Schema `github`); Token nie in Response/Log/Audit/WS/URL/Argv/persistierter Remote-URL. Mutierende Aktionen auditiert (Audit-First) + identitäts-/rollengeschützt (gleiche `CRED_ADMIN_EMAILS`-Logik wie ADR-007). **Betriebs-Vorbedingung Repo-Create:** GitHub-App braucht **Administration: Read & Write**. **Klon-Ziel** strikt innerhalb `WORKSPACE_DIR` (Path-Traversal-/Symlink-Schutz), Re-Clone nicht stillschweigend überschreibend. Detail-Architektur (SSH-/Git-Ausführungsweg, Token-Injektion ohne Persistenz) = `architekt`.
- **DockerReader** — liest Preview-Container über die Docker-Engine. *Boundary:* einziger Docker-Zugriff.
- **AccessGuard** — Middleware: validiert den Cloudflare-Access-JWT (`Cf-Access-Jwt-Assertion`) vor jeder `/api/*`- und WS-Anfrage; Fail-Fast beim Boot ohne Access-Konfig.
- **Static server** — liefert das gebaute React-Frontend.

**Frontend (React):**
- **App-Shell** — Einstiegs-Panel (vier Kacheln: GitHub · VPS · Cloudflare · Fabrik) + client-seitige Navigation (deep-linkbare Routen, Browser-Verlauf, Fallback auf Panel) + ein **Zahnrad** in der Navigation, das die **Settings-Ansicht** öffnet (Route `settings`, NICHT als fünfte Kachel). Rendert je nach Route eine der Ansichten. *Boundary:* einziger Ort, der View-Routing kennt.
- **Settings-Ansicht** — zentrale Einstellmaske mit Sektionen je Integration (GitHub · Cloudflare · Hetzner/VPS · SSH-Keys); Credential-Felder write-only/maskiert (nur Status „gesetzt/nicht gesetzt"). Konsumiert die Settings-/Credential-/SSH-Endpunkte (siehe unten).
- **Fabrik-Ansicht** — Terminal-Pane (xterm.js) · Status-Dashboard · Flow-Trigger-Panels · Job-/Kill-Steuerung (= bisheriges Frontend, jetzt als eine Ansicht eingebettet).
- **GitHub- / VPS- / Cloudflare-Ansicht** — derzeit Platzhalter-Views (Grundgerüst); Detail-Funktionen + zugehörige Backend-Boundaries folgen als eigene Anforderungen. *Geplante neue Boundaries (noch nicht entschieden):* erweiterter `GitHubReader`/Schreibpfad, ein **VPS-Provider-Boundary** (z.B. Hetzner-API) und ein **Cloudflare-API-Boundary** — jeweils mit Secret-Handling, Audit + Identitäts-/Rollenschutz (Entscheidung: `architekt`).

**Backend — geplant (Settings/Credentials; Boundary + Store ENTSCHIEDEN, s. ADR-007/008):**
- **CredentialStore** *(neu — `src/CredentialStore.js`; einziger Lese-/Schreibpfad zu `secrets.enc.json`)* — einziger Boundary für Geheimnisse (Credentials je Integration + SSH-Private-Keys). At rest **AES-256-GCM** auf dem persistenten Volume; Master-Key aus Env (`CRED_MASTER_KEY`, scrypt-abgeleitet). **Write-only nach außen:** Lese-Antworten liefern nur Metadaten (Status „set/unset", Maske, `updatedAt`), **nie** Klartext; Klartext verlässt den Store nur store-intern an Konsumenten. Endpunkte `GET/PUT/DELETE /api/settings/credentials*`, `GET/PUT/DELETE /api/settings/ssh-keys*`; mutierende Aktionen auditiert + identitäts-/rollengeschützt (Access-Identität genügt; optionale `CRED_ADMIN_EMAILS`-Allowlist). **Details + Datei-Schema: ADR-007.**
- **VpsProvisioner** *(neu, Folge-Capability — `src/VpsProvisioner.js`; Boundary in ADR-008 fixiert)* — einziger Ort für SSH-Verbindungen; trägt einen hinterlegten Public-Key idempotent in `authorized_keys` eines VPS-Ziels ein (`POST /api/settings/ssh-keys/{user}/provision`), Private-Key store-intern aus dem `CredentialStore`. Ziel-Schema `{ host, port?, targetUser }`. Detail-Spec = #47; #45/#46 dürfen keinen SSH-/Provider-Code einführen (s. ADR-008).

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
- **GitHub** — REST/GraphQL via App-Token: read-only über `GitHubReader`; **schreibend** über `GitHubWriter` (Repo anlegen via REST, Repo klonen via `git clone` in `WORKSPACE_DIR`). Installation-Token (~1h TTL) transient pro Aufruf gemintet.
- **Workspace (Dateisystem)** — konfigurierbarer `WORKSPACE_DIR` (Env) auf dem persistenten Volume, uid-1000-schreibbar, beim Boot idempotent angelegt: Ziel lokaler Repo-Klone ([[github-repo-clone]]). Klon-Ziele strikt innerhalb `WORKSPACE_DIR`.
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
- **ADR-007 · 2026-06-07 · ENTSCHIEDEN · Credential-Store = verschlüsselte JSON-Datei auf dem persistenten Volume (AES-256-GCM, Master-Key aus Boot-Env).** Siehe Vollfassung unten.
- **ADR-008 · 2026-06-07 · ENTSCHIEDEN (Skizze) · VPS-/SSH-Provisionierung = eigener `VpsProvisioner`-Boundary, SSH-from-Backend.** Boundary-Festlegung, damit #45/#46 nicht in eine Sackgasse bauen. Siehe Vollfassung unten.

---

### ADR-007 (Vollfassung) · Verschlüsselter Credential-Store

**Status:** ENTSCHIEDEN · 2026-06-07 · Entscheider: `architekt` · betrifft `settings-credentials` (#45), `settings-ssh-keys` Stufe A (#46).

**Kontext.** Die Settings-Ansicht muss Geheimnisse (Integration-Credentials + optionale SSH-Private-Keys) **persistent** und **at rest verschlüsselt** ablegen. Das kollidiert nominal mit ADR-005/Nicht-Ziel „keine eigene DB". Rahmen: Non-Root-Container (uid 1000), genau **ein** persistentes Named-Volume (`dev-gui-claude` → `/home/node/.claude`), Cloudflare Access davor, ein bis zwei Identitäten, write-only Richtung Frontend, kein Secret in Code/Log. Im Projektumfeld existiert bereits das Muster „verschlüsselte Datei + Passphrase aus Env" (agent-flow `.env.gpg` + `GPG_PASSPHRASE`).

**Betrachtete Optionen.**
1. **Verschlüsselte JSON-Datei auf dem persistenten Volume**, App-eigene AES-256-GCM-Krypto via Node-`crypto`, Master-Key aus Boot-Env. *(gewählt)*
2. GPG-Datei analog `.env.gpg` (Reuse der vorhandenen GPG-Mechanik). *Verworfen:* GPG ist für **statische, beim Deploy einmal verschlüsselte** Env-Dateien gedacht; pro Mutation einen `gpg`-Subprozess zu spawnen (write-many) ist umständlich, schwer atomar und vermischt Geheimnis-Klartext mit Prozess-Argv/Tempfiles. Die Passphrase-aus-Env-**Idee** wird aber übernommen.
3. Externer Secret-Manager (Vault/Cloud-KMS). *Verworfen:* zusätzlicher Dienst + Netz-/Auth-Abhängigkeit, überdimensioniert für 1–2 Identitäten; widerspricht „ein Dienst, SDK-frei" (ADR-006). Bleibt als spätere Migration offen (Boundary kapselt das, s.u.).
4. Container-Secret (Docker/Compose secret). *Verworfen:* Docker-Secrets sind **read-only zur Laufzeit** und beim Deploy gesetzt — taugen nicht für ein zur Laufzeit über die GUI **beschreibbares** Store.

**Entscheidung.**
- **Speicherort:** eine Datei `secrets.enc.json` unter `/home/node/.claude/dev-gui/` (also auf dem bestehenden Volume — kein neues Volume, keine echte DB; bewusste, eng begrenzte Erweiterung von ADR-005, s. „Verhältnis zu ADR-005"). Verzeichnis beim Boot idempotent anlegen (uid-1000-owned, mode `0700`); Datei mode `0600`.
- **Krypto:** **AES-256-GCM** via Node-Builtin `crypto` (kein Drittlib). Pro Eintrag (oder pro Datei-Schreibvorgang) ein frischer 12-Byte-Random-IV; GCM-Auth-Tag wird mitgespeichert und bei Lesen verifiziert (Integritätsschutz → manipulierte Datei = harter Fehler, kein stilles Fallback).
- **Datei-Schema (kanonisch):**
  ```json
  {
    "version": 1,
    "kdf": { "algo": "scrypt", "salt": "<base64>", "N": 16384, "r": 8, "p": 1 },
    "entries": {
      "credentials/<integration>/<name>": { "iv": "<b64>", "tag": "<b64>", "ct": "<b64>", "updatedAt": "<iso>" },
      "ssh/<user>/private_key":          { "iv": "<b64>", "tag": "<b64>", "ct": "<b64>", "updatedAt": "<iso>" }
    }
  }
  ```
  Public-Keys sind **nicht geheim** → sie gehören **nicht** verschlüsselt in `entries`, sondern als Klartext-Metadatum (gleiche Datei, eigener `meta`-Block, oder separate `meta.json`); `coder` wählt die einfachste Variante, solange Public-Keys getrennt vom verschlüsselten Block liegen.
- **Master-Key-Herkunft (Boot):** Env-Var **`CRED_MASTER_KEY`** (Compose-`environment`, aus `.env`/Host-Secret — **nie** im Image, nie geloggt). Daraus wird mit **scrypt** (Salt aus der Datei, beim ersten Schreiben generiert) der 32-Byte-AES-Schlüssel abgeleitet — der Roh-Env-Wert wird **nie** direkt als Key benutzt und **nie** persistiert. Fehlt `CRED_MASTER_KEY` in Produktion, aber `secrets.enc.json` enthält **verschlüsselte Einträge** (d.h. `kdf`-Block vorhanden UND `entries` nicht leer) → **Fail-Fast beim Boot** (analog `assertAccessConfig`), damit nicht stillschweigend ein leeres/neues Store entsteht. Eine reine Meta-Datei ohne verschlüsselte Einträge (z.B. nur Public-Keys im `meta`-Block) löst diesen Fail-Fast **nicht** aus — sie enthält keine Geheimnisse und erfordert keinen Key. Optionaler Datei-Fallback `CRED_MASTER_KEY_FILE` (Pfad, Wert wird gelesen) analog zur `GPG_PASSPHRASE`-Option-B im Compose — `coder` darf das ergänzen, Env hat Vorrang.
- **Schreibsicherheit (atomar):** Mutationen schreiben in `secrets.enc.json.tmp` + `fsync` + `rename()` → kein halb geschriebenes Store bei Crash. In-Memory wird die **entschlüsselte** Form nur transient pro Request gehalten, nie über den Request hinaus gecached (Vereinfachung; bei 1–2 Identitäten unkritisch). Concurrency: ein prozess-interner Schreib-Mutex (kleine Schreiblast).
- **Boundary:** genau **eine** Komponente **`CredentialStore`** (`src/CredentialStore.js`) ist einziger Lese-/Schreibpfad zu `secrets.enc.json`. Vertrag (write-only nach außen): `get(key)`/`list()` liefern an HTTP-Handler **nur Metadaten** (`status`, optional Maske, `updatedAt`) — Klartext verlässt den Store **ausschließlich** intern an Konsumenten (z.B. künftiger `VpsProvisioner`), **nie** in eine HTTP-Response, Log, Audit oder WS-Stream. Maske = höchstens letzte 4 Zeichen (für kurze Werte: nur „•••• gesetzt").
- **Rollenfrage (OA3):** **Gültige Cloudflare-Access-Identität genügt** zum Mutieren — **plus** zwingender Audit-Eintrag pro Mutation. *Begründung:* privates Werkzeug für 1–2 vorab durch Access freigeschaltete Identitäten; eine zweite App-interne Allowlist wäre Doppel-Gate ohne Mehrwert (ADR-004-Linie: Access ist die Mauer). **Erweiterungspunkt (prüfbar vorbereitet):** eine optionale Env **`CRED_ADMIN_EMAILS`** (Komma-Liste). Ist sie **gesetzt**, dürfen nur diese `req.identity.email` mutieren (sonst 403); ist sie **leer/ungesetzt**, gilt „jede gültige Access-Identität". Damit ist AC7 in beiden Auslegungen erfüllbar und eine spätere Rollentrennung ohne Re-Architektur möglich. Die Identität kommt aus dem bestehenden `req.identity.email` (AccessGuard).

**Verhältnis zu ADR-005 / Re-Scoping.** ADR-005 bleibt unverändert gültig für **Fabrik-Read-Models** (Project/Board/CI/Preview = live aus GitHub+Docker, kein Store). ADR-007 ergänzt eine **eng abgegrenzte, verschlüsselte Konfig-Ablage** ausschließlich für **vom Betreiber gesetzte Geheimnisse**. Re-Scoping des Nicht-Ziels: „keine eigene DB für **Fabrik-/Domänen-State**" — Betreiber-**Konfiguration/Credentials** sind davon ausgenommen und werden als verschlüsselte Datei (kein RDBMS, kein Query-Layer) auf dem ohnehin vorhandenen Volume gehalten. Kein neuer Dienst, keine DB-Engine → ADR-006 („ein Dienst, SDK-frei") bleibt gewahrt.

**Konsequenzen (prüfbar — Review-Kriterien).**
- `CredentialStore` ist der **einzige** Modul, der `secrets.enc.json` öffnet (Grep: kein anderer `fs`-Zugriff auf den Pfad). *(architecture/R01)*
- Keine HTTP-Response / kein Log / kein Audit / kein WS-Frame enthält je einen Geheimnis-Klartext (testbar: Response-Body/Audit enthalten gesetzten Wert nicht — AC4/AC6).
- `CRED_MASTER_KEY` erscheint nicht im Image (Grep Dockerfile), nicht im Log, nicht im Frontend-Bundle.
- Produktionsstart ohne `CRED_MASTER_KEY`, wenn `secrets.enc.json` verschlüsselte Einträge enthält (`kdf`-Block vorhanden UND `entries` nicht leer) → Prozess bricht ab (Fail-Fast), analog AccessGuard. Reine Meta-Datei (nur `meta`-Block, keine verschlüsselten `entries`) löst keinen Fail-Fast aus.
- Manipuliertes/inkonsistentes Store (GCM-Tag falsch) → harter Fehler, **kein** stiller Reset, kein Teil-/Klartext-Leak (Spec-Edge-Case „Backend nicht erreichbar/konsistent → 5xx ohne Leak").
- Jede Mutation erzeugt vor Ausführung einen `AuditStore`-Eintrag (Identität, Feld-Key, Aktion) **ohne** Klartext; schlägt der Audit-Write fehl → Mutation unterbleibt (bestehende AuditStore-Vertragslogik).
- Neue Env-Vars für `coder`/Deployment: `CRED_MASTER_KEY` (Pflicht in Prod), optional `CRED_MASTER_KEY_FILE`, optional `CRED_ADMIN_EMAILS`. In `docker-compose.yml` als `environment`-Einträge zu ergänzen (auskommentierter Block analog `GPG_PASSPHRASE`).

---

### ADR-008 (Skizze) · VPS-/SSH-Provisionierungs-Boundary

**Status:** ENTSCHIEDEN als **Boundary-Festlegung** (Skizze) · 2026-06-07 · betrifft `settings-ssh-keys` Stufe B (#47) + `view-vps`. Zweck: verhindern, dass #45/#46 in eine Sackgasse bauen. Die **Detail-Spec** der Provisionierung bleibt Folge-Anforderung; hier wird nur die Architektur-Grenze fixiert, an die #46 andocken darf.

**Kontext.** Stufe B (`POST /api/settings/ssh-keys/{user}/provision`) soll einen hinterlegten **Public-Key idempotent** in `authorized_keys` eines VPS-Ziels eintragen. Das ist eine **schreibende externe Integration** (neuer Boundary). #46 (Stufe A: Key-Verwaltung) darf jetzt nicht so bauen, dass Stufe B später kollidiert.

**Entscheidung (Boundary, bindend).**
- **Mechanik:** **SSH-from-Backend** — der Dienst verbindet sich als SSH-Client direkt zum VPS und schreibt idempotent in `authorized_keys` (z.B. mit `ssh-copy-id`-Semantik bzw. append-if-absent). *Verworfen:* Hetzner-Provider-API für Key-Injection — die Provider-Cloud-Init-API setzt Keys nur **bei Server-Erstellung**, nicht idempotent auf laufende Server; SSH ist provider-unabhängig und deckt alle Ziel-Benutzer (`root`, `alex`) ab.
- **Authentifizierungs-Quelle:** der für die SSH-Verbindung nötige **Private-Key** stammt aus dem **`CredentialStore` (ADR-007)** — Stufe A legt ihn dort write-only ab; Stufe B konsumiert ihn **store-intern** (Klartext verlässt den Store nie Richtung HTTP/Log). Damit ist Stufe A → Stufe B über genau eine Boundary verbunden.
- **Neue Komponente (später):** **`VpsProvisioner`** (`src/VpsProvisioner.js`) — einziger Ort, der SSH-Verbindungen aufbaut. Konsumiert `CredentialStore` (Private-Key) + ein **VPS-Ziel-Schema**.
- **VPS-Ziel-Schema (vorab fixiert, damit #46 stabil bleibt):** ein Ziel ist `{ host, port?: 22, targetUser }` (frei eintragbar/„misc"-artig; Hetzner-spezifische Server-Auflösung kann später ergänzt werden). `view-vps` (#48+) liefert später eine Auswahl; bis dahin genügt direkte Eingabe der Ziel-Referenz im Provision-Request.
- **Schutz:** hoch-privilegiert → Access-Mauer + Audit + identitäts-/rollengeschützt (gleiche `CRED_ADMIN_EMAILS`-Logik wie ADR-007), idempotent, explizites `{result, reason?}` ohne Geheim-Leak (AC7–AC10).

**Was #45/#46 jetzt einhalten müssen (Sackgassen-Vermeidung — prüfbar).**
- #46 legt Private-Keys **ausschließlich** über `CredentialStore` (ADR-007) ab — **kein** separater SSH-Key-Store, kein Schreiben in das echte `~/.ssh/` des Containers. Schlüssel-Key-Schema: `ssh/<user>/private_key` (Geheimnis) + Public-Key als Klartext-Metadatum (s. ADR-007-Schema).
- #45/#46 führen **keinen** SSH-Client/Provider-Code ein — der bleibt allein in der späteren `VpsProvisioner`-Boundary.
- Die Provision-Route existiert in #46 (Stufe A) **nicht** oder nur als 501/„not yet" — Detail-Implementierung = #47.

**Konsequenz / offen für die Folge-Spec.** Wahl der SSH-Lib (Node `ssh2` vs. Spawn von System-`ssh`/`ssh-copy-id`), Host-Key-Verifikation (known_hosts-Strategie) und das endgültige `view-vps`-Ziel-Schema werden in der #47-Spec entschieden — sie berühren keine #45/#46-Verträge mehr.
