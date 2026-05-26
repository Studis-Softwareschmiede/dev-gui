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
| `GH_TOKEN`          | recommended      | GitHub personal access token for GitHubReader (read:org, repo scope) |
| `SESSION_CMD`       | no               | Command the PTY spawns; defaults to `claude`            |
| `DEV_NO_ACCESS`     | **never in prod**| Set to `1` only for local dev (bypasses Access JWT check) |
| `NODE_ENV`          | yes in prod      | Set to `production` in prod (activates fail-fast Access check) |

The server **refuses to start** in production if `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD`
is missing (fail-fast guard in `AccessGuard.assertAccessConfig`).

---

## 3. Claude Code CLI — Abo-OAuth login (subscription, not API key)

The image ships the `claude` CLI installed globally via
`npm install -g @anthropic-ai/claude-code`.

### 3a. Persist credentials with a named volume

Claude Code stores OAuth credentials in `~/.claude/` (root user inside the container).
Mount a named Docker volume so credentials survive container restarts/updates:

```sh
docker volume create dev-gui-claude
```

### 3b. First-run interactive login

The very first time, run the container **interactively** to complete the browser-based
OAuth flow ("Log in with Claude.ai" — subscription login, **not** an API key):

```sh
docker run --rm -it \
  -v dev-gui-claude:/root/.claude \
  ghcr.io/studis-softwareschmiede/dev-gui:latest \
  claude login
```

Follow the URL printed by `claude login`, authenticate in the browser, and confirm.
Credentials are saved to `/root/.claude/` (inside the volume). This step is **one-time**
until the session expires.

### 3c. Re-login if session expires

If the PTY session reports `failed` state (check `GET /api/session`), re-run the
interactive login command above. The OAuth token has a long lifetime (months) for
subscription accounts; re-login is rarely needed.

### 3d. Normal production start

```sh
docker run -d \
  --name dev-gui \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e NODE_ENV=production \
  -e ACCESS_TEAM_DOMAIN=myteam.cloudflareaccess.com \
  -e ACCESS_AUD=<your-aud-tag> \
  -e GH_TOKEN=<your-gh-token> \
  -v dev-gui-claude:/root/.claude \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  ghcr.io/studis-softwareschmiede/dev-gui:latest
```

Notes:
- `-p 127.0.0.1:8080:8080` — bind only to loopback; Cloudflare Tunnel reaches the
  container via `localhost:8080`, so no direct internet exposure.
- `-v /var/run/docker.sock:/var/run/docker.sock:ro` — **read-only** mount; DockerReader
  uses the socket to list running containers. Write access is not needed and not granted.
- No secrets are baked into the image layers.

---

## 4. Docker socket mount (read-only)

DockerReader communicates with the Docker daemon to enumerate containers for the
`/api/status` previews panel. The socket mount MUST be **read-only** (`:ro`) to
follow the principle of least privilege:

```
-v /var/run/docker.sock:/var/run/docker.sock:ro
```

Without this mount DockerReader returns an empty previews list; the rest of the app
continues to function normally.

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

### Container läuft als root

Der Runtime-Container läuft als root (kein `USER`-Direktive im Dockerfile). Das ist ein
bewusster Trade-off:

- **node-pty** benötigt Zugriff auf `/dev/ptmx` und PTY-Slave-Devices; ein Non-root-User
  würde zusätzliche Capabilities oder Volume-Anpassungen erfordern.
- **`~/.claude/`-OAuth-Volume** ist auf `/root/.claude` gemountet; ein Non-root-User würde
  einen anderen Home-Pfad benötigen und die `claude login`-Anweisungen ändern.
- **Docker-Socket-Mount** ist **read-only** (`:ro`): DockerReader kann nur Metadaten lesen,
  keine Container starten/stoppen/löschen. Das read-only-Mount begrenzt die Angriffsfläche
  des root-Prozesses erheblich — ein kompromittierter Container kann den Docker-Daemon
  nicht steuern.

Ein zukünftiger Non-root-Pass ist möglich (z.B. `USER node` + Capability `CAP_SYS_PTRACE`
oder ein dedizierteres PTY-Proxy-Setup), ist aber ausserhalb des aktuellen Deployment-Scopes.
