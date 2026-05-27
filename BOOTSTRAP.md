# dev-gui Bootstrap Guide

Step-by-step instructions for deploying dev-gui on a VPS behind Cloudflare Tunnel + Access.

---

## 1. Prerequisites — node-pty runtime dependencies

`node-pty` is a native addon compiled against glibc (Debian). The image is built
on `node:20-slim` (Debian Bookworm slim). No extra packages are needed inside the
container because the compiled `.node` binary is copied from the builder stage.

On the **host VPS** you only need:
- Docker Engine ≥ 24
- A running `cloudflared` tunnel (see section 3)

---

## 2. Runtime environment variables

| Variable            | Required in prod | Description                                             |
|---------------------|------------------|---------------------------------------------------------|
| `ACCESS_TEAM_DOMAIN`| yes              | Cloudflare Access team domain, e.g. `myteam.cloudflareaccess.com` |
| `ACCESS_AUD`        | yes              | Cloudflare Access Application Audience tag (AUD)        |
| `GH_TOKEN`          | recommended      | GitHub PAT (read:org + repo) for GitHubReader **and** agent-flow plugin clone (private repo) |
| `GPG_PASSPHRASE`    | for agent-flow skills | GPG passphrase to decrypt `.env.gpg` shipped with the plugin repo (simplest option under non-root — see caveat below) |
| `SESSION_CMD`       | no               | Command the PTY spawns; defaults to `claude`            |
| `SESSION_ARGS`      | yes in prod      | JSON array of extra args for `claude`; set to `["--dangerously-skip-permissions"]` for unattended VPS operation (requires non-root container, see section 8) |
| `DEV_NO_ACCESS`     | **never in prod**| Set to `1` only for local dev (bypasses Access JWT check) |
| `NODE_ENV`          | yes in prod      | Set to `production` in prod (activates fail-fast Access check) |

The server **refuses to start** in production if `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD`
is missing (fail-fast guard in `AccessGuard.assertAccessConfig`).

---

## 3. Claude Code CLI — Abo-OAuth login (subscription, not API key)

The image ships the `claude` CLI installed globally via
`npm install -g @anthropic-ai/claude-code`.

### 3a. Persist credentials with a named volume

Claude Code stores OAuth credentials in `~/.claude/` (the `node` user's home,
`/home/node/.claude`, inside the container).
Mount a named Docker volume so credentials survive container restarts/updates:

```sh
docker volume create dev-gui-claude
```

### 3b. First-run interactive login

The very first time, run the container **interactively** to complete the browser-based
OAuth flow ("Log in with Claude.ai" — subscription login, **not** an API key):

```sh
docker run --rm -it \
  -v dev-gui-claude:/home/node/.claude \
  ghcr.io/studis-softwareschmiede/dev-gui:latest \
  claude login
```

Follow the URL printed by `claude login`, authenticate in the browser, and confirm.
Credentials are saved to `/home/node/.claude/` (inside the volume). This step is **one-time**
until the session expires.

### 3c. Re-login if session expires

If the PTY session reports `failed` state (check `GET /api/session`), re-run the
interactive login command above. The OAuth token has a long lifetime (months) for
subscription accounts; re-login is rarely needed.

### 3d. Normal production start

**Recommended:** use `docker compose` (see section 9 — deploys socket-proxy + dev-gui
together, replaces the raw socket mount):

```sh
docker compose up -d
```

**Legacy / single-container alternative** (requires raw socket access — not recommended
under non-root; use the compose deploy instead):

```sh
docker run -d \
  --name dev-gui \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e NODE_ENV=production \
  -e ACCESS_TEAM_DOMAIN=myteam.cloudflareaccess.com \
  -e ACCESS_AUD=<your-aud-tag> \
  -e GH_TOKEN=<your-gh-token> \
  -e SESSION_ARGS='["--dangerously-skip-permissions"]' \
  -v dev-gui-claude:/home/node/.claude \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v ~/.config/softwareschmiede/gpg.pass:/home/node/.config/softwareschmiede/gpg.pass:ro \
  ghcr.io/studis-softwareschmiede/dev-gui:latest
```

Notes:
- `-p 127.0.0.1:8080:8080` — bind only to loopback; Cloudflare Tunnel reaches the
  container via `localhost:8080`, so no direct internet exposure.
- `-v /var/run/docker.sock:/var/run/docker.sock:ro` — **read-only** mount; DockerReader
  uses the socket to list running containers. Write access is not needed and not granted.
- `-v ~/.config/softwareschmiede/gpg.pass:/home/node/.config/softwareschmiede/gpg.pass:ro` —
  GPG passphrase file (read-only mount) for the agent-flow Fabrik-Skills to decrypt
  `.env.gpg` (ships with the plugin repo). **Non-root caveat:** the container runs as
  uid 1000 (`node`). A typical `gpg.pass` created by root is `0600 root:root` and is
  **not readable by uid 1000** — the skills will silently fall back to prompting.
  Fix with either (a) `-e GPG_PASSPHRASE=<pass>` (environment variable, simplest) or
  (b) `sudo chown 1000 ~/.config/softwareschmiede/gpg.pass` (or mode `0644` on a
  dedicated copy). **Never bake the passphrase into the image.**
- `-v dev-gui-claude:/home/node/.claude` — persists Claude OAuth credentials **and** the
  installed agent-flow plugin across restarts. The entrypoint installs the plugin on
  first boot (see section 3e below) and skips it on subsequent starts. The mounted volume
  must be owned by uid 1000 (`node`) — see note below.
- `-e SESSION_ARGS='["--dangerously-skip-permissions"]'` — enables **unattended operation**
  (ADR-003). Allowed because the container runs as **non-root** (uid 1000); Claude Code's
  root guard no longer blocks the flag. The primary access control remains Cloudflare
  Access (ADR-004). Do **not** set this flag when running the container as root.
- No secrets are baked into the image layers.

**Volume ownership (important):** The container runs as uid 1000 (`node`). Named Docker
volumes created with `docker volume create` are owned by root by default. The `node` user
can write into them because Docker initialises the volume contents from the container's
image layer (where `/home/node` is owned by `node`). If you use a **bind mount** (host
directory), ensure the host path is owned by uid 1000:
```sh
sudo chown -R 1000:1000 /path/to/host/dir
```

### 3e. agent-flow plugin auto-provision (first boot)

The container entrypoint (`docker-entrypoint.sh`) automatically installs the
agent-flow plugin on first boot if it is not already present in `/home/node/.claude`:

1. If `GH_TOKEN` is set, `git` is configured to use it as a credential for
   cloning the **private** `Studis-Softwareschmiede/agent-flow` repo. The token
   is never echoed or logged.
2. `claude plugin marketplace add Studis-Softwareschmiede/agent-flow` downloads
   the plugin metadata.
3. `claude plugin install agent-flow@agent-flow` installs the plugin into
   `/home/node/.claude` (persisted via the volume).
4. On success, `node server.js` starts normally. On failure the install warning
   is logged to stderr and the server still starts — `/agent-flow:*` slash-commands
   won't resolve until the plugin is installed, but the GUI and status panel work.

On subsequent restarts the plugin is already present in the volume and the
install step is skipped.

**Verify after first boot:**

```sh
docker exec dev-gui claude plugin list
# should include: agent-flow
```

---

## 4. Docker access — socket-proxy (recommended) vs. raw socket

DockerReader communicates with the Docker daemon to enumerate containers for the
`/api/status` previews panel, and the `/agent-flow:preview up/down` skill issues
`docker run`/`docker rm` commands.

### 4a. Recommended: docker-socket-proxy (compose deploy, AC4–AC6)

The **`docker-compose.yml`** in the repo root defines the full production stack:
a `socket-proxy` sidecar (`tecnativa/docker-socket-proxy`) that mounts the raw
Docker socket read-only and exposes a restricted API over TCP, and a `dev-gui`
service that talks to Docker via `DOCKER_HOST=tcp://socket-proxy:2375`.

**Why the proxy:** `/var/run/docker.sock` is owned by `root:docker` (mode `0660`).
The container runs as uid 1000 (`node`) and **cannot access the raw socket** without
joining the `docker` group — which is not recommended (group membership grants
unrestricted daemon access). The socket-proxy solves both the permission problem and
the privilege-surface problem at once.

**`docker` CLI and DockerReader honour `DOCKER_HOST` automatically** — no code
changes in DockerReader or the `/agent-flow:preview` skill are needed; all `docker`
invocations inherit `DOCKER_HOST` from the process environment.

Start the stack:

```sh
# First-time: create Claude credentials volume
docker volume create dev-gui-claude

# Copy .env.example to .env and fill in your values (never commit .env)
cp .env.example .env   # see section 9

# Start (detached)
docker compose up -d
```

### 4b. Raw socket (legacy / dev-only)

A raw socket mount works when the container runs in the `docker` group or as root,
but is **not recommended for production** under non-root (uid 1000):

```
-v /var/run/docker.sock:/var/run/docker.sock:ro
```

Without any Docker access, DockerReader returns an empty previews list; the rest of
the app continues to function normally.

---

## 5. Cloudflare Tunnel — ingress route

In your `cloudflared` tunnel configuration (`config.yml`), add the following ingress
rule to route `devgui.<domain>` to the container:

```yaml
ingress:
  - hostname: devgui.<domain>       # e.g. devgui.alexstuder.cloud
    service: http://localhost:8080
  # ... other rules ...
  - service: http_status:404
```

Restart `cloudflared` after editing the config:

```sh
systemctl restart cloudflared
# or: docker restart cloudflared
```

---

## 6. Cloudflare Access policy

In the Cloudflare Zero Trust dashboard (access.cloudflare.com):

1. **Applications → Add application → Self-hosted**
2. **Application name:** `dev-gui`
3. **Application domain:** `devgui.<domain>`
4. Under **Application Audience (AUD)** — copy the tag; this is your `ACCESS_AUD` env var.
5. **Policies → Add policy**
   - Policy name: `Allowlist`
   - Action: `Allow`
   - Rule: `Emails` → add the permitted email addresses (one per line), e.g.:
     ```
     alex@alexstuder.ch
     collaborator@example.com
     ```
6. Save and deploy.

The Access policy issues a short-lived JWT (`Cf-Access-Jwt-Assertion` header) for
every authenticated browser session. dev-gui's `AccessGuard` validates this JWT on
every `/api/*` request and every `/ws/terminal` upgrade. Requests without a valid
JWT are rejected with `403 Forbidden` — the app enforces Access independently of the
tunnel configuration.

---

## 7. Image reference

```
ghcr.io/studis-softwareschmiede/dev-gui:latest
```

Built automatically on every push to `main` via GitHub Actions (`.github/workflows/build.yml`).
Pushed to GitHub Container Registry using the built-in `GITHUB_TOKEN` — no additional
push secret required.

---

## 8. Härtung / bekannte Trade-offs

### Container läuft als Non-Root (uid 1000, `node`)

Der Runtime-Container läuft als `node`-User (uid 1000, `USER node` im Dockerfile).
`HOME` ist `/home/node`. Alle Laufzeit-Pfade liegen unter dem Non-Root-Home:

| Pfad | Zweck |
|------|-------|
| `/home/node/.claude` | Claude OAuth-Credentials + Plugin-Cache (Volume) |
| `/home/node/.config/softwareschmiede/gpg.pass` | GPG-Passphrase (bind-mount, read-only) |

**Warum Non-Root wichtig ist:**
- Claude Code's `--dangerously-skip-permissions`-Flag ist für Root-Container gesperrt
  (Root-Guard: „cannot be used with root/sudo"). Non-root ist Voraussetzung für den
  unbeaufsichtigten Betrieb (ADR-003), in dem GUI-Trigger ohne Bash-Prompt laufen.
- Geringere Container-Privilegien: ein kompromittierter Prozess hat keine Host-Root-Rechte.

**node-pty als Non-Root:** `/dev/ptmx` ist world-accessible (mode 0666 auf Linux); PTY
funktioniert ohne zusätzliche Capabilities.

**Docker-Socket-Mount** ist **read-only** (`:ro`): DockerReader kann nur Metadaten lesen,
keine Container starten/stoppen/löschen.

**`SESSION_ARGS=["--dangerously-skip-permissions"]`** — nur setzen wenn der Container als
Non-Root läuft (uid ≠ 0). Die primäre Zugangskontrolle ist Cloudflare Access (ADR-004);
das Flag aktiviert lediglich den unbeaufsichtigten Modus des Claude-Clients.

### Non-Root Deploy Caveats

#### GPG-Passphrase unter Non-Root

`gpg.pass` wird typischerweise von root erstellt und hat `0600 root:root`. Der Container
läuft als uid 1000 (`node`) und kann diese Datei **nicht lesen** — die agent-flow-Skills
fallen stumm auf einen interaktiven Passphrase-Prompt zurück.

Empfohlene Lösung (einfachste): Passphrase als Umgebungsvariable übergeben:
```sh
-e GPG_PASSPHRASE=<passphrase>
```

Alternative: Datei dem Node-User lesbar machen (dedizierte Kopie empfohlen):
```sh
sudo chown 1000 ~/.config/softwareschmiede/gpg.pass   # oder: chmod 0644
```

**Niemals die Passphrase ins Image baken.**

#### Docker-Socket unter Non-Root — socket-proxy (AC4–AC6)

`/var/run/docker.sock` gehört `root:docker` (mode `0660`). Als uid 1000 hat der
Container-Prozess **keinen Zugriff** auf den rohen Socket — `docker ps` schlägt fehl,
DockerReader/Previews degradieren auf leere Listen.

Implementierter Pfad: **docker-socket-proxy** — deployed via `docker-compose.yml`:
- Sidecar `tecnativa/docker-socket-proxy:0.3.0` mit `CONTAINERS=1`, `IMAGES=1`,
  `POST=1`, `EXEC=0` — nur dieser Sidecar bekommt den rohen Socket.
- dev-gui erhält `DOCKER_HOST=tcp://socket-proxy:2375`; das `docker`-CLI und
  DockerReader sprechen automatisch gegen den Proxy (kein Code-Change nötig).
- Kein `POST /exec/*` (EXEC=0): keine Remote-Shell in laufende Container.
- Ein roher Socket-Mount + docker-group-Mitgliedschaft für uid 1000 ist **nicht
  empfohlen** (erhöht Privileges unkontrolliert).

**Security-Tradeoff (NFR):** `POST=1` erlaubt Container-Create — mit Bind-Mounts
theoretisch mächtig. Der Proxy ist **kein vollständiger Sandbox-Ersatz.** Primäre
Kontrolle: **Cloudflare Access** (nur erlaubte Identitäten) + **Non-Root** (uid 1000)
+ **`EXEC=0`** (kein Exec in Container). Der rohe Host-Root-Socket ist eliminiert.

Siehe Section 9 für den Compose-Deploy-Workflow.

---

## 9. Compose-basierter Deploy (socket-proxy + dev-gui)

The `docker-compose.yml` at the repo root is the **canonical production deploy
artifact** (AC6). It replaces the raw-socket `docker run` command from section 3d.

### Services

| Service | Image | Role |
|---------|-------|------|
| `socket-proxy` | `tecnativa/docker-socket-proxy:0.3.0` | Restricted Docker API proxy; holds the raw socket |
| `dev-gui` | `ghcr.io/studis-softwareschmiede/dev-gui:latest` | GUI; talks to Docker via `DOCKER_HOST` |

Both services share an `internal: true` bridge network (`docker-proxy-net`). The
`socket-proxy` has **no published ports** — it is only reachable from `dev-gui`
inside the bridge.

### Environment variables (.env file)

Create a `.env` file in the same directory as `docker-compose.yml` (never commit it):

```sh
# .env — runtime secrets for docker compose
ACCESS_TEAM_DOMAIN=myteam.cloudflareaccess.com
ACCESS_AUD=<your-aud-tag-from-cloudflare>
GH_TOKEN=<github-pat-read-org-repo>
GPG_PASSPHRASE=<gpg-passphrase>
```

`docker compose` loads `.env` automatically. Variables are referenced in
`docker-compose.yml` as `${VAR}` — never as literal values.

### First-time setup

```sh
# 1. Create the Claude credentials volume (once per VPS)
docker volume create dev-gui-claude

# 2. Interactive Claude login (once per OAuth session)
docker run --rm -it \
  -v dev-gui-claude:/home/node/.claude \
  ghcr.io/studis-softwareschmiede/dev-gui:latest \
  claude login

# 3. Create .env (fill in your values, never commit)
cp .env.example .env   # or create manually

# 4. Start the stack
docker compose up -d
```

### Day-to-day operations

```sh
# Start
docker compose up -d

# Stop
docker compose down

# View logs
docker compose logs -f dev-gui
docker compose logs -f socket-proxy

# Validate compose syntax
docker compose config

# Update to latest image (Watchtower handles this automatically in prod)
docker compose pull && docker compose up -d
```

### Why this replaces the raw socket mount

Under non-root (uid 1000), the container process cannot access
`/var/run/docker.sock` (owned by `root:docker`, mode `0660`) without joining the
`docker` group — which grants unrestricted daemon access. The socket-proxy solves
both: the proxy (running as root on the host) holds the socket and exposes only
the needed endpoints over a TCP port on the internal network.

**DOCKER_HOST and DockerReader:** DockerReader shells out to the `docker` CLI
with `execFile('docker', [...])` — no socket path or `-H` flag is hardcoded.
The `docker` CLI automatically reads `DOCKER_HOST` from its environment, so
setting `DOCKER_HOST=tcp://socket-proxy:2375` routes all docker calls through
the proxy with zero code changes. The `/agent-flow:preview up/down` skill's
`docker run`/`docker rm` calls likewise inherit `DOCKER_HOST` from the process
environment.

**Security tradeoff (NFR):** `POST=1` allows container-create. With arbitrary
bind-mounts that is theoretically powerful — the proxy is **not a full sandbox**.
Primary controls:
1. **Cloudflare Access** — only permitted identities reach the app (ADR-004)
2. **Non-root container** — uid 1000, no host-root capabilities
3. **`EXEC=0`** — no `POST /exec/*`; no remote shell into running containers
4. Raw host-root socket eliminated — the attack surface is reduced, not zero
