#!/bin/bash
# docker-entrypoint.sh — dev-gui container entrypoint
#
# AC6: auto-provisions the agent-flow plugin on first boot, then starts the server.
#
# Shell safety: errexit + nounset + pipefail.
# IMPORTANT: the plugin-install block is guarded with its own error handling so
# that a failed install does NOT abort the container — the server still starts
# and GUI/status work without the plugin; only /agent-flow:* commands won't resolve.

set -euo pipefail

# ── AC6: git credential helper for private repo clone ────────────────────────
# If GH_TOKEN is set, configure git so the private agent-flow repo can be cloned.
# The resolved URL contains the token — do NOT log it.
if [ -n "${GH_TOKEN:-}" ]; then
  git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

# ── AC6: agent-flow plugin auto-provision (best-effort) ──────────────────────
# Check without -e (nounset safe: 2>/dev/null swallows errors from `claude`).
if ! claude plugin list 2>/dev/null | grep -q agent-flow; then
  echo "[entrypoint] agent-flow plugin not found — installing..."
  if claude plugin marketplace add Studis-Softwareschmiede/agent-flow \
     && claude plugin install agent-flow@agent-flow; then
    echo "[entrypoint] agent-flow plugin installed successfully."
  else
    echo "[entrypoint] WARNING: agent-flow plugin install failed — server will start without it." >&2
    echo "[entrypoint] WARNING: /agent-flow:* commands will not resolve until the plugin is installed." >&2
  fi
else
  echo "[entrypoint] agent-flow plugin already installed."
fi

# ── Start the server ──────────────────────────────────────────────────────────
exec node server.js
