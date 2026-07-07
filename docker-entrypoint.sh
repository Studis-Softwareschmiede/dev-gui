#!/bin/bash
# docker-entrypoint.sh — dev-gui container entrypoint
#
# AC6: auto-provisions the agent-flow plugin on first boot.
# plugin-auto-update (AC1-AC5): on EVERY boot the factory tooling is brought
# up to date — first-boot install path unchanged; on subsequent boots (plugin
# already installed) marketplace + plugin are updated instead of being left
# pinned to whatever version was installed first.
#
# Shell safety: errexit + nounset + pipefail.
# IMPORTANT: the plugin-install/update block is guarded with its own error
# handling so that a failed install/update does NOT abort the container —
# the server still starts and GUI/status work without it; only
# /agent-flow:* commands won't resolve (install failure) or may be
# outdated (update failure).

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
#
# SCOPED to the agent-flow repo only (2026-07-06-Vorfall): eine frühere,
# unscoped Regel ("https://github.com/" -> insteadOf für ALLE github.com-URLs)
# hat dauerhaft den zum Boot-Zeitpunkt gültigen GH_TOKEN in JEDEN Git-Zugriff
# eingebaut — auch in den von /workspace/*-Projekten (z.B. dev-guis eigenes
# Repo). Der eigentlich korrekt und regelmäßig erneuerte `gh`-Login
# (ensure-gh-auth.sh, "gh auth setup-git") wurde dadurch für ALLE
# github.com-Zugriffe von diesem einen, nach ~1h ablaufenden Token
# überstimmt — Git-Pushes aus länger laufenden Containern schlugen dann mit
# "Invalid username or token" fehl, obwohl `gh auth status` einen gültigen,
# aktiven Login zeigte. Die Regel jetzt exakt auf die eine Adresse begrenzt,
# die für den (chicken-and-egg) Erst-Bootstrap des privaten agent-flow-Plugins
# gebraucht wird — alle anderen github.com-Zugriffe nutzen den echten,
# sich selbst erneuernden gh-Login.
if [ -n "${GH_TOKEN:-}" ]; then
  git config --global url."https://x-access-token:${GH_TOKEN}@github.com/Studis-Softwareschmiede/agent-flow".insteadOf "https://github.com/Studis-Softwareschmiede/agent-flow"
fi

# ── Claude-Code-OAuth-Token (AC4 — claude-code-oauth-token) ──────────────────
# Best-effort Boot-Warnung: fehlt CLAUDE_CODE_OAUTH_TOKEN, scheitern headless
# claude-Läufe (/agent-flow:*, reconcile, Nachtwächter) mit 401, sobald die
# interaktive OAuth-Datei abläuft. Keine Boot-Blockade (Muster wie der
# gh-Auth-Bootstrap unten). Der Token-Wert selbst wird NIE geloggt.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "[entrypoint] WARNING: CLAUDE_CODE_OAUTH_TOKEN nicht gesetzt — /agent-flow:*-Läufe schlagen mit 401 fehl." >&2
fi

# ── AC6/plugin-auto-update: agent-flow plugin auto-provision + auto-update ───
# (best-effort, idempotent — see docs/specs/plugin-auto-update.md AC1-AC5)
# Check without -e (nounset safe: 2>/dev/null swallows errors from `claude`).
if ! claude plugin list 2>/dev/null | grep -q agent-flow; then
  # Not installed yet (first boot) → install path, unchanged.
  echo "[entrypoint] agent-flow plugin not found — installing..."
  if claude plugin marketplace add Studis-Softwareschmiede/agent-flow \
     && claude plugin install agent-flow@agent-flow; then
    echo "[entrypoint] agent-flow plugin installed successfully."
  else
    echo "[entrypoint] WARNING: agent-flow plugin install failed — server will start without it." >&2
    echo "[entrypoint] WARNING: /agent-flow:* commands will not resolve until the plugin is installed." >&2
  fi
else
  # Already installed → bring marketplace + plugin up to the latest
  # published version on every boot instead of staying pinned (AC1).
  # Idempotent: an already-current marketplace/plugin is not a hard error (AC3).
  echo "[entrypoint] agent-flow plugin already installed — checking for updates..."
  if claude plugin marketplace update \
     && claude plugin update agent-flow@agent-flow; then
    echo "[entrypoint] agent-flow plugin updated successfully."
  else
    echo "[entrypoint] WARNING: agent-flow plugin update failed — continuing with the currently installed version." >&2
    echo "[entrypoint] WARNING: /agent-flow:* commands may be outdated until the plugin update succeeds." >&2
  fi
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

# ── gh-Auth-Refresh-Schleife (headless-gh-token-refresh, AC1-AC7) ────────────
# Der einmalige Bootstrap oben mintet einen App-Token, der nur ~60min gültig
# ist. Mehrstündige headless-Drains (manueller "Board abarbeiten"-Knopf UND
# Nachtwächter) überleben einen Token-Ablauf sonst nicht (Vorfall
# 2026-07-07): claude -p-Kindprozesse können nicht re-minten, weil
# buildChildEnv() (src/HeadlessRunnerCore.js) bewusst NUR eine Allowlist an
# Env-Vars durchreicht — GPG_PASSPHRASE/GH_TOKEN werden gestrippt (Security,
# NICHT geändert — siehe docs/specs/headless-gh-token-refresh.md Nicht-Ziele).
#
# Deshalb läuft der Refresh stattdessen HIER, im Entrypoint-Prozess selbst,
# der GPG_PASSPHRASE ohnehin aus der Server-Env hat: eine Hintergrund-
# Schleife, die in festem Intervall (default ~45min, strikt < ~60min
# Token-Gültigkeit) erneut ensure-gh-auth.sh aufruft. Weil `gh`/git ihre
# Konfiguration pro Aufruf neu aus $HOME/.config/gh bzw. der git-Credential-
# Ablage lesen, profitieren bereits laufende Sessions automatisch — ohne
# Neustart (AC2/AC3).
#
# Security (AC4/AC5): GPG_PASSPHRASE verlässt NIE diesen Prozess — die
# Schleife ruft nur dasselbe ensure-gh-auth.sh auf, das GPG_PASSPHRASE aus
# genau dieser (Entrypoint-)Shell-Env liest. Es wird KEINE neue,
# session-lesbare Ablage angelegt (keine gpg.pass-Datei, keine Aufnahme in
# buildChildEnv). Sessions sehen nur das Ergebnis: die frische, kurzlebige
# gh/git-Auth in den bestehenden Ist-Ablagen.
#
# Robustheit (AC6): ein fehlgeschlagener Refresh (Netz weg, GPG-/Mint-Fehler,
# Skript nicht gefunden) loggt nur eine klare, secret-freie Warnung und läuft
# beim nächsten Intervall einfach weiter — kein Crash, kein Effekt auf
# node server.js (läuft in einem separaten Hintergrundprozess).
#
# Fangnetz (AC7): die bestehende 401-Erkennung (isAuthError/
# AUTH_ERROR_PATTERN, src/HeadlessRunnerCore.js) bleibt unverändert — falls
# ein Refresh doch einmal zu spät kommt.
#
# Log-Ziel: eine eigene, secret-freie Log-Datei statt der geerbten
# stdout/stderr-Filedeskriptoren des Entrypoint-Prozesses. Ein Hintergrund-
# prozess, der (gewollt) bis in alle Ewigkeit weiterläuft, hält andernfalls
# das Pipe-Ende von stdout/stderr für IMMER offen — jeder Aufrufer, der den
# Entrypoint-Prozess per Pipe beobachtet und auf EOF wartet (z.B. Node
# `child_process.spawnSync`, aber auch mancher Log-Collector), würde NIE ein
# EOF sehen, selbst lange nachdem `exec node server.js` selbst geendet hat.
# Ein reines FD-Duplikat (`exec 3>&1`) löst das NICHT — es zeigt auf dieselbe
# zugrundeliegende Pipe. Die Log-Datei ist trotzdem "sichtbar genug": sie
# liegt unter $HOME (persistentes Volume) und kann jederzeit inspiziert
# werden (`tail -f`), ohne den Docker-Log-Stream zu blockieren.
GH_TOKEN_REFRESH_INTERVAL_SECONDS="${GH_TOKEN_REFRESH_INTERVAL_SECONDS:-2700}"
GH_TOKEN_REFRESH_LOG="$HOME/.claude/gh-token-refresh.log"

gh_token_refresh_loop() {
  while true; do
    sleep "$GH_TOKEN_REFRESH_INTERVAL_SECONDS"
    # Plugin-Root bei JEDEM Durchlauf neu auflösen (derselbe Mechanismus wie
    # beim Boot-Bootstrap oben) — kein hartkodierter, versions-fixierter Pfad;
    # überlebt auch ein zwischenzeitliches Plugin-Update.
    local_plugin_root="$(find "$HOME/.claude/plugins/cache/agent-flow" -mindepth 2 -maxdepth 2 -type d -print -quit 2>/dev/null || true)"
    if [ -n "${local_plugin_root:-}" ] && [ -x "$local_plugin_root/scripts/ensure-gh-auth.sh" ]; then
      if "$local_plugin_root/scripts/ensure-gh-auth.sh" >/dev/null 2>&1; then
        echo "[entrypoint] gh-auth refresh: fresh GitHub-App token minted — running sessions pick it up on their next gh/git call."
      else
        echo "[entrypoint] WARNING: gh-auth refresh failed this interval — will retry next interval (running sessions keep using the previous token/401-fallback)." >&2
      fi
    else
      echo "[entrypoint] WARNING: gh-auth refresh skipped — ensure-gh-auth.sh not found (plugin missing or path changed). Will retry next interval." >&2
    fi
  done
}

echo "[entrypoint] starting background gh-auth refresh loop (interval: ${GH_TOKEN_REFRESH_INTERVAL_SECONDS}s, log: $GH_TOKEN_REFRESH_LOG)..."
nohup bash -c "$(declare -f gh_token_refresh_loop); GH_TOKEN_REFRESH_INTERVAL_SECONDS='$GH_TOKEN_REFRESH_INTERVAL_SECONDS' HOME='$HOME' gh_token_refresh_loop" >>"$GH_TOKEN_REFRESH_LOG" 2>&1 < /dev/null &
disown

# ── Credential-Store Master-Key (AC4 — Entkopplung von GPG_PASSPHRASE) ────────
# Der Master-Key für den Credential-Store (ADR-007 / credential-master-key-decoupling)
# wird aus einem EIGENEN Bitwarden-Item beschafft (dev-gui-cred-master-key) und als
# DEVGUI_CRED_MASTER_KEY oder DEVGUI_CRED_MASTER_KEY_FILE übergeben.
#
# GPG_PASSPHRASE bleibt AUSSCHLIESSLICH für .env.gpg / GitHub-Auth-Bootstrap
# (ensure-gh-auth.sh). Der frühere GPG_PASSPHRASE→CRED_MASTER_KEY-Fallback wurde
# entfernt (AC4). Ohne dedizierten Store-Key startet der Store im locked-Zustand
# (Fail-Fast greift erst bei vorhandenen verschlüsselten Einträgen).
if [ -z "${DEVGUI_CRED_MASTER_KEY:-}" ] && [ -z "${DEVGUI_CRED_MASTER_KEY_FILE:-}" ]; then
  if [ -z "${CRED_MASTER_KEY:-}" ] && [ -z "${CRED_MASTER_KEY_FILE:-}" ]; then
    echo "[entrypoint] Hinweis: kein DEVGUI_CRED_MASTER_KEY(_FILE) — Credential-Store startet ohne Master-Key (locked). Fail-Fast greift erst bei vorhandenen verschlüsselten Einträgen."
  else
    echo "[entrypoint] Hinweis: altes CRED_MASTER_KEY(_FILE) gesetzt — deprecated, bitte auf DEVGUI_CRED_MASTER_KEY umstellen."
  fi
fi

# ── Start the server ──────────────────────────────────────────────────────────
exec node server.js
