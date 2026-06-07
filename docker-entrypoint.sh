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

# ── Login-Persistenz: .claude.json aufs Volume umlenken ──────────────────────
# Claude CLI (v2.x) legt OAuth-Credentials in $HOME/.claude.json ab — eine
# Datei DIREKT im HOME, nicht unter $HOME/.claude/. Unser persistentes Volume
# mountet aber nur das Verzeichnis $HOME/.claude/. Ohne diesen Schritt liegt
# .claude.json auf der Overlay-FS und wird mit dem Container weggeworfen ⇒
# der User muss sich nach jedem Restart neu einloggen.
#
# Strategie (idempotent):
#   1) falls eine REGULÄRE Datei .claude.json existiert (frischer Container,
#      Claude-Bootstrap hat schon geschrieben) ⇒ aufs Volume verschieben.
#   2) state.json garantiert existieren lassen (sonst zeigt Symlink ins Leere
#      und Claude-Reader scheitern beim ENOENT).
#   3) Symlink $HOME/.claude.json → $HOME/.claude/state.json immer (re-)setzen.
#      Falls Claude atomar (rename) schreibt und den Symlink durch eine Datei
#      ersetzt, fängt der nächste Container-Start das wieder ein (Schritt 1).
if [ -f "$HOME/.claude.json" ] && [ ! -L "$HOME/.claude.json" ]; then
  mv "$HOME/.claude.json" "$HOME/.claude/state.json"
fi
[ -e "$HOME/.claude/state.json" ] || echo "{}" > "$HOME/.claude/state.json"
ln -sf "$HOME/.claude/state.json" "$HOME/.claude.json"

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

# ── gh-Auth-Bootstrap: frischen GitHub-App-Token minten ──────────────────────
# Source of Truth = `.env.gpg` im agent-flow Plugin-Tree (vom claude-plugin-Install
# mit ausgeliefert) + GPG_PASSPHRASE als Container-Env. ensure-gh-auth.sh
# entschlüsselt, mintet einen ~1h-gültigen Installation-Token und loggt `gh`
# persistent in $HOME/.config/gh/hosts.yml ein.
#
# Best-effort: schlägt der Bootstrap fehl, startet der Server trotzdem; nur
# die /agent-flow:*-Skills, die `gh` brauchen, schlagen dann auf.
#
# Wichtig: nach erfolgreichem Bootstrap die `GH_TOKEN`/`GITHUB_TOKEN`-Env-Vars
# UNSETZEN, weil `gh` eine aktive Env-Var IMMER über die persistente Datei-Auth
# stellt. Eine stale GH_TOKEN-Var (z.B. abgelaufener `ghs_…` vom docker-run)
# würde sonst die frische, persistente Auth überschatten.
PLUGIN_ROOT="$(find "$HOME/.claude/plugins/cache/agent-flow" -mindepth 2 -maxdepth 2 -type d -print -quit 2>/dev/null || true)"
if [ -n "${PLUGIN_ROOT:-}" ] && [ -x "$PLUGIN_ROOT/scripts/ensure-gh-auth.sh" ]; then
  echo "[entrypoint] minting fresh GitHub-App token via $PLUGIN_ROOT/scripts/ensure-gh-auth.sh ..."
  if "$PLUGIN_ROOT/scripts/ensure-gh-auth.sh"; then
    echo "[entrypoint] gh authenticated — clearing stale GH_TOKEN/GITHUB_TOKEN env-vars."
    unset GH_TOKEN GITHUB_TOKEN
  else
    echo "[entrypoint] WARNING: gh-auth bootstrap failed — /agent-flow:* skills using gh may not work." >&2
  fi
else
  echo "[entrypoint] no ensure-gh-auth.sh found (plugin missing or path changed) — skipping gh-auth bootstrap." >&2
fi

# ── CRED_MASTER_KEY-Fallback: gleiches Bitwarden-Secret wie die GPG-Passphrase ─
# Betreiber-Entscheid: der Master-Key für den Credential-Store (ADR-007) ist
# DIESELBE Passphrase, die der Bootstrap aus Bitwarden
# (Item: studis-softwareschmiede-gpg-passphrase) holt und die hier schon als
# GPG_PASSPHRASE (Env) bzw. gemountete gpg.pass ankommt. Ein explizit gesetztes
# CRED_MASTER_KEY/CRED_MASTER_KEY_FILE gewinnt immer (kein Überschreiben).
# Der Wert wird NIE geloggt. scrypt+Salt im CredentialStore leiten daraus einen
# eigenen AES-Key ab — GPG- und Store-Schlüssel bleiben kryptographisch getrennt.
if [ -z "${CRED_MASTER_KEY:-}" ] && [ -z "${CRED_MASTER_KEY_FILE:-}" ]; then
  if [ -n "${GPG_PASSPHRASE:-}" ]; then
    export CRED_MASTER_KEY="$GPG_PASSPHRASE"
    echo "[entrypoint] CRED_MASTER_KEY: Fallback auf GPG_PASSPHRASE (Bitwarden-Secret) aktiv."
  elif [ -f "$HOME/.config/softwareschmiede/gpg.pass" ]; then
    export CRED_MASTER_KEY_FILE="$HOME/.config/softwareschmiede/gpg.pass"
    echo "[entrypoint] CRED_MASTER_KEY_FILE: Fallback auf gemountete gpg.pass aktiv."
  else
    echo "[entrypoint] Hinweis: kein CRED_MASTER_KEY(_FILE) und keine GPG_PASSPHRASE/gpg.pass — Credential-Store startet ohne Master-Key (Fail-Fast greift erst bei vorhandenen verschlüsselten Einträgen)."
  fi
fi

# ── Start the server ──────────────────────────────────────────────────────────
exec node server.js
