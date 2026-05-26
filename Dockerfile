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

# Install claude CLI (Anthropic's official Claude Code CLI).
# Installed globally so `claude` is on $PATH for PtyManager (SESSION_CMD).
# No secrets baked in — credentials are mounted at runtime via a volume.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy production node_modules (contains compiled node-pty binary built
# against glibc in the builder stage — same libc, works at runtime).
COPY --from=builder /build/node_modules ./node_modules

# Copy application code
COPY --from=builder /build/server.js ./server.js
COPY --from=builder /build/src ./src
COPY --from=builder /build/scripts ./scripts

# Copy built frontend (vite output)
COPY --from=builder /build/client/dist ./client/dist

# Copy package.json (needed for "type":"module" ESM resolution)
COPY --from=builder /build/package.json ./package.json

EXPOSE 8080

CMD ["node", "server.js"]
