# Multi-stage build — node:20-slim (Debian) throughout.
# Alpine is intentionally avoided: node-pty's native addon requires a glibc
# toolchain; using the same libc in build + runtime ensures the compiled
# binary works without reimporting.
#
# Stage 1 — builder: install build tools, compile node-pty, run vite.
# Stage 2 — runtime: copy only what's needed to run the server.

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# Build deps for node-pty (node-gyp needs python3 + make + g++).
# build-essential already includes make and g++; python3 is the only extra needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy manifests first — layer-cache npm install separately from source
COPY package*.json ./
# scripts/ is needed by the postinstall hook (fix-pty-perms.mjs)
COPY scripts ./scripts

# Full install (including devDependencies) so vite is available for the build
RUN npm ci

# Copy all source (server, src/, client/)
COPY . .

# Build the React frontend → client/dist
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Install runtime tools:
#   - curl + ca-certificates: needed to download static binaries
#   - git: needed by the agent-flow plugin auto-provision (clone private repo)
#   - gnupg: needed by ensure-gh-auth.sh / load-env.sh to decrypt .env.gpg
#   - jq: used by the agent-flow factory skill scripts
#   - openssl: used by gh-app-token.sh (JWT signing: openssl dgst + openssl base64)
#   - python3: used by gh-app-token.sh to parse the GitHub API JSON response
# No secrets baked in — credentials are mounted at runtime via env / volume.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    gnupg \
    jq \
    openssl \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# AC6 — GitHub CLI (gh): needed by ensure-gh-auth.sh + skill scripts.
# Tarball layout: gh_2.62.0_linux_amd64/bin/gh → with --strip-components=1
# and -C /usr/local the binary lands at /usr/local/bin/gh.
RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.62.0/gh_2.62.0_linux_amd64.tar.gz \
    | tar -xz -C /usr/local --strip-components=1 gh_2.62.0_linux_amd64/bin/gh

# AC5 — docker client only (no daemon).
# Static binary; pinned version; --strip-components=1 extracts docker/docker → /usr/local/bin/docker.
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker

# bitwarden-master-key-unlock — Bitwarden CLI (bw) für serverseitige Master-Key-Beschaffung.
# AC6: Passwort/Session-Token werden via env übergeben, NICHT als CLI-Arg (kein Argv-Leak).
# Pinned version für reproduzierbare Builds; statisches npm-global-Binary.
RUN npm install -g @bitwarden/cli@2026.5.0

# Install claude CLI (Anthropic's official Claude Code CLI).
# Installed globally so `claude` is on $PATH for PtyManager (SESSION_CMD).
# No secrets baked in — credentials are mounted at runtime via a volume.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy production node_modules (contains compiled node-pty binary built
# against glibc in the builder stage — same libc, works at runtime).
COPY --chown=node:node --from=builder /build/node_modules ./node_modules

# Copy application code
COPY --chown=node:node --from=builder /build/server.js ./server.js
COPY --chown=node:node --from=builder /build/src ./src
COPY --chown=node:node --from=builder /build/scripts ./scripts

# Copy built frontend (vite output)
COPY --chown=node:node --from=builder /build/client/dist ./client/dist

# Copy package.json (needed for "type":"module" ESM resolution)
COPY --chown=node:node --from=builder /build/package.json ./package.json

# AC6 — entrypoint: auto-provisions agent-flow plugin, then starts server.
COPY --chown=node:node docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# AC2/AC18 — pre-create node-owned dirs so that named volumes mounted at
# /home/node/.claude and /home/node/.cred are initialised with node ownership
# (Docker copies the image directory's ownership when seeding an empty named
# volume; without this the mountpoints are created root-owned → EACCES on
# plugin auto-provision / credential persist+boot-reload).
RUN mkdir -p /home/node/.claude /home/node/.config /home/node/.cred \
  && chown -R node:node /home/node/.claude /home/node/.config /home/node/.cred

# Build-Version — baked in at image build time (yymmddhhmmss TZ, Europe/Zurich).
# Produced by CI and passed via --build-arg BUILD_VERSION=... .
# Fallback "dev" is used when building locally without the arg.
ARG BUILD_VERSION=dev
ENV APP_VERSION="${BUILD_VERSION}"
# Same value as an image label so `docker inspect` surfaces the build version
# without having to query the running app's /api/version endpoint.
LABEL build.version="${BUILD_VERSION}"

# AC1 — run as non-root: switch to the node user (uid 1000, present in
# node:20-slim). Global tools (claude, docker, gh) are in /usr/local/bin —
# readable+executable by all users. /home/node is the node user's home dir
# (created by the base image); claude stores OAuth credentials in ~/.claude.
ENV HOME=/home/node
USER node

EXPOSE 8080

ENTRYPOINT ["/docker-entrypoint.sh"]
