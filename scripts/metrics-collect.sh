#!/usr/bin/env bash
# metrics-collect.sh <item>
#
# Parst Subagent-Transcript-JSONL für ein Board-Item, summiert echte Token
# (input/output/cache) je Dispatch und patcht die `tok`-Felder in
# .claude/metrics/dispatches.jsonl + `tok_total` in .claude/metrics/items.jsonl.
#
# Nur null-Felder werden überschrieben — bestehende Werte bleiben (K5, append-only-Geist).
# Jeder Fehler → null, nie Loop-Stopp, nie Gate-Änderung (K3/K4).
# Kein LLM-Aufruf — reine Bash/jq-Dateiarithmetik (K1, AC6).
#
# Usage: scripts/metrics-collect.sh <story-id>
#   <story-id>: kanonisches String-Format "S-###" (AC2) ODER numerisch "<nr>"
#               S-Präfix wird intern für das Transcript-Matching als numerischer Anteil
#               und für das Ledger-Matching als String verwendet.
#
# ─── Pfad-Auflösung (AC4/V3) ─────────────────────────────────────────────────
# Transcript-Verzeichnis wird in dieser Priorität gesucht:
#   1. $CLAUDE_CONFIG_DIR/.claude/projects/... (GUI-/Container-Kontext)
#   2. $HOME/.claude/projects/...             (Standard-Kontext)
#
# Pfad-Escaping: cwd mit '/' → '-' ergibt den Verzeichnisnamen (führendes '-' = '/')
# Beispiel: /Users/alex/Git/Studis-Softwareschmiede → -Users-alex-Git-Studis-Softwareschmiede
#
# Schlägt das Auffinden fehl → tok bleibt null, kein Crash (K3/K4).
#
# ─── Phase-0-Verifikation (AC1) ──────────────────────────────────────────────
# Tatsächlich vorgefundenes Transcript-Format (empirisch verifiziert 2026-06-12):
#
#   Pfad:  <claude-dir>/projects/<escaped-cwd>/<session-uuid>/subagents/agent-<id>.jsonl
#          <claude-dir>/projects/<escaped-cwd>/<session-uuid>/subagents/agent-<id>.meta.json
#
#   meta.json-Schema:
#     { "agentType": "agent-flow:coder", "description": "coder #108 Ledger-Schema",
#       "toolUseId": "toolu_..." }
#   - `description` enthält "#<item_nr>" wenn von /flow dispatcht (reliable Matching-Quelle)
#   - `agentType` enthält die Rolle nach dem letzten ':' (coder/reviewer/tester/dba/cicd)
#
#   JSONL-Zeilen-Schema (assistant-Zeilen mit usage):
#     { "type": "assistant", "message": { "usage": {
#         "input_tokens": <int>,
#         "output_tokens": <int>,
#         "cache_creation_input_tokens": <int>,
#         "cache_read_input_tokens": <int>,
#         ... (weitere Felder werden ignoriert)
#       } }, "timestamp": "...", "agentId": "...", ... }
#
#   Token-Summierung je Subagent:
#     in    = Σ input_tokens aller assistant-Zeilen
#     out   = Σ output_tokens aller assistant-Zeilen
#     cache = Σ (cache_creation_input_tokens + cache_read_input_tokens) aller assistant-Zeilen
#
#   Dispatch-Matching: meta.json description enthält "#<item_nr>" UND agentType enthält Rolle.
#   Bei mehreren Subagents je Dispatch (gleiche Rolle/Item): Token summieren.
#
# ─── Fallback ────────────────────────────────────────────────────────────────
# Wird kein Transcript-Verzeichnis gefunden oder enthält kein Subagent "#<item_nr>":
#   → tok-Felder bleiben null, Script gibt einzeiligen Hinweis aus, Exit 0.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

ITEM_RAW="${1:-}"
if [[ -z "$ITEM_RAW" ]]; then
  echo "[metrics-collect] WARN: kein Item-Argument — tok bleibt null" >&2
  exit 0
fi

# Item-Argument: akzeptiert sowohl "S-014" (String) als auch "14" (numerisch)
# ITEM_NR = numerischer Anteil für Transcript-Matching (#14 in meta.json description)
# ITEM_STR = kanonischer String "S-###" für Ledger-Matching (AC2)
if [[ "$ITEM_RAW" =~ ^S-([0-9]+)$ ]]; then
  ITEM_NR="${BASH_REMATCH[1]}"
  ITEM_STR="$ITEM_RAW"
elif [[ "$ITEM_RAW" =~ ^[0-9]+$ ]]; then
  ITEM_NR="$ITEM_RAW"
  ITEM_STR="S-${ITEM_RAW}"
else
  echo "[metrics-collect] WARN: Item-Argument nicht parsebar ('$ITEM_RAW') — tok bleibt null" >&2
  exit 0
fi

# ITEM bleibt ITEM_NR für das Subagent-Matching (grep -E auf "#<nr>")
ITEM="$ITEM_NR"

# Prüfen ob jq vorhanden
if ! command -v jq >/dev/null 2>&1; then
  echo "[metrics-collect] WARN: jq nicht gefunden — tok bleibt null" >&2
  exit 0
fi

# Prüfen ob python3 vorhanden
if ! command -v python3 >/dev/null 2>&1; then
  echo "[metrics-collect] WARN: python3 nicht gefunden — tok bleibt null" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DISPATCHES_FILE="$REPO_ROOT/.claude/metrics/dispatches.jsonl"
ITEMS_FILE="$REPO_ROOT/.claude/metrics/items.jsonl"

# Pfad-Auflösung (AC4/V3): CLAUDE_CONFIG_DIR hat Vorrang vor HOME
# Ermöglicht Token-Erfassung im GUI-/Container-Kontext, wo ~/.claude u.U. nicht greift.
if [[ -n "${CLAUDE_CONFIG_DIR:-}" && -d "${CLAUDE_CONFIG_DIR}/.claude/projects" ]]; then
  CLAUDE_PROJECTS_DIR="${CLAUDE_CONFIG_DIR}/.claude/projects"
elif [[ -d "$HOME/.claude/projects" ]]; then
  CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
else
  # Fallback: $HOME/.claude/projects (wird in main() auf Existenz geprüft)
  CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
fi

# Global temp files, cleaned up by EXIT trap
WORK_DISPATCHES=""
WORK_ITEMS=""
cleanup_temps() {
  [[ -n "${WORK_DISPATCHES:-}" ]] && rm -f "$WORK_DISPATCHES" || true
  [[ -n "${WORK_ITEMS:-}" ]]      && rm -f "$WORK_ITEMS"      || true
}
trap 'cleanup_temps' EXIT

# ─── Hilfsfunktion: Token aus einem Subagent-JSONL summieren ──────────────────
# Gibt JSON-Objekt {"in":<int>,"out":<int>,"cache":<int>} aus,
# oder "null" wenn nichts parsebar.
sum_tokens_from_jsonl() {
  local jsonl_file="$1"
  [[ -f "$jsonl_file" ]] || { printf 'null'; return 0; }

  python3 - "$jsonl_file" 2>/dev/null <<'PYEOF' || printf 'null'
import sys, json

fpath = sys.argv[1]
total_in = 0
total_out = 0
total_cache = 0
found = False

try:
    with open(fpath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get('type') == 'assistant' and 'message' in obj:
                usage = obj['message'].get('usage', {})
                if not isinstance(usage, dict):
                    continue
                inp     = usage.get('input_tokens', 0)
                out     = usage.get('output_tokens', 0)
                cache_cr = usage.get('cache_creation_input_tokens', 0)
                cache_rd = usage.get('cache_read_input_tokens', 0)
                inp      = inp      if isinstance(inp,      int) else 0
                out      = out      if isinstance(out,      int) else 0
                cache_cr = cache_cr if isinstance(cache_cr, int) else 0
                cache_rd = cache_rd if isinstance(cache_rd, int) else 0
                if inp or out or cache_cr or cache_rd:
                    found = True
                total_in    += inp
                total_out   += out
                total_cache += cache_cr + cache_rd
except Exception:
    print('null')
    sys.exit(0)

if found:
    print(json.dumps({"in": total_in, "out": total_out, "cache": total_cache}))
else:
    print('null')
PYEOF
}

# ─── Subagent-JSONLs für dieses Item suchen ──────────────────────────────────
# Gibt Zeilen im Format: <agent_role>\t<jsonl_path>
# Fehler werden still übergangen (best-effort).
find_subagent_jsonls_for_item() {
  local item="$1"
  [[ -d "$CLAUDE_PROJECTS_DIR" ]] || return 0

  # Suche bis Tiefe 4: projects/<proj>/<session>/subagents/*.meta.json
  find "$CLAUDE_PROJECTS_DIR" -maxdepth 4 -name "*.meta.json" 2>/dev/null | \
  while IFS= read -r metaf; do
    # Beide Felder aus meta.json lesen
    # Python gibt zwei Zeilen aus: Zeile 1 = description, Zeile 2 = agentType
    # IFS='' + mapfile verhindert Word-Splitting bei Leerzeichen in description
    local meta_lines=()
    while IFS= read -r meta_line; do
      meta_lines+=("$meta_line")
    done < <(python3 - "$metaf" 2>/dev/null <<'PYEOF' || true
import sys, json
try:
    d = json.load(open(sys.argv[1], encoding='utf-8', errors='replace'))
    # Felder dürfen Leerzeichen, keine Newlines enthalten (safe)
    desc  = d.get('description', '').replace('\n', ' ')
    atype = d.get('agentType',   '').replace('\n', ' ')
    print(desc)
    print(atype)
except Exception:
    print('')
    print('')
PYEOF
    ) || continue
    [[ "${#meta_lines[@]}" -ge 2 ]] || continue

    local description="${meta_lines[0]}"
    local agent_type_raw="${meta_lines[1]}"

    # Prüfen ob description "#<item>" enthält
    # Pattern: "#108" oder "#108 " etc.; kein Prefix wie "#1080"
    if ! printf '%s' "$description" | grep -qE "#[[:space:]]*${item}([^0-9]|$)"; then
      continue
    fi

    # Rolle aus agentType extrahieren (letzter Teil nach ':')
    local role
    role="${agent_type_raw##*:}"
    role="$(printf '%s' "$role" | tr '[:upper:]' '[:lower:]')"

    local jsonl_file="${metaf%.meta.json}.jsonl"
    [[ -f "$jsonl_file" ]] || continue

    printf '%s\t%s\n' "$role" "$jsonl_file"
  done
}

# ─── dispatches.jsonl patchen ─────────────────────────────────────────────────
# Für jede Dispatch-Zeile des Items mit tok==null: passendes Subagent-JSONL finden
# und tok setzen.
# Matcht item sowohl als String "S-###" (neu, AC2) als auch als int (Alt-Zeilen, AC7).
patch_dispatches() {
  local item_str="$1"   # kanonischer String, z.B. "S-014"
  local item_nr="$2"    # numerischer Anteil, z.B. "14" (für Alt-Zeilen-Compat)
  local subagent_list="$3"
  [[ -f "$DISPATCHES_FILE" ]] || return 0
  [[ -n "$subagent_list" ]] || return 0

  # Temp im SELBEN Verzeichnis wie die Zieldatei, damit der spätere mv ein atomarer
  # rename(2) ist (cross-device mv via /tmp wäre auf macOS nicht atomar).
  WORK_DISPATCHES="$(mktemp "$REPO_ROOT/.claude/metrics/dispatches-patch.XXXXXX")"
  local patched_count=0

  while IFS= read -r line; do
    # Nur Zeilen für dieses Item mit null-tok verarbeiten.
    # item-Feld kann String "S-###" (neu) oder int-Zahl (Alt-Zeilen, AC7) sein.
    local line_item line_tok line_agent
    line_item="$(printf '%s' "$line" | jq -r '.item // empty | tostring' 2>/dev/null)" || line_item=""
    line_tok="$(printf '%s' "$line" | jq -r 'if .tok == null then "null" else "set" end' 2>/dev/null)" || line_tok=""
    line_agent="$(printf '%s' "$line" | jq -r '.agent // empty' 2>/dev/null)" || line_agent=""

    # Match: String "S-###" ODER numerischer Wert (Alt-Zeilen)
    local item_matches=false
    if [[ "$line_item" == "$item_str" || "$line_item" == "$item_nr" ]]; then
      item_matches=true
    fi

    if [[ "$item_matches" == "true" && "$line_tok" == "null" && -n "$line_agent" ]]; then
      local role_normalized
      role_normalized="$(printf '%s' "$line_agent" | tr '[:upper:]' '[:lower:]')"

      # Token über alle matching Subagents summieren
      local total_in=0 total_out=0 total_cache=0 found_any=false
      while IFS=$'\t' read -r sub_role sub_jsonl; do
        if [[ "$sub_role" == "$role_normalized" ]]; then
          local tok_json
          tok_json="$(sum_tokens_from_jsonl "$sub_jsonl")" || tok_json="null"
          if [[ "$tok_json" != "null" && -n "$tok_json" ]]; then
            found_any=true
            local s_in s_out s_cache
            s_in="$(printf '%s' "$tok_json" | jq -r '.in // 0' 2>/dev/null)" || s_in=0
            s_out="$(printf '%s' "$tok_json" | jq -r '.out // 0' 2>/dev/null)" || s_out=0
            s_cache="$(printf '%s' "$tok_json" | jq -r '.cache // 0' 2>/dev/null)" || s_cache=0
            total_in=$(( total_in + s_in ))
            total_out=$(( total_out + s_out ))
            total_cache=$(( total_cache + s_cache ))
          fi
        fi
      done <<< "$subagent_list"

      if [[ "$found_any" == "true" ]]; then
        # tok-Feld patchen — Guard: nur wenn noch null (K5)
        local patched_line
        patched_line="$(printf '%s' "$line" | jq -c \
          --argjson in_tok "$total_in" \
          --argjson out_tok "$total_out" \
          --argjson cache_tok "$total_cache" \
          'if .tok == null then .tok = {"in": $in_tok, "out": $out_tok, "cache": $cache_tok} else . end' \
          2>/dev/null)" || patched_line="$line"
        printf '%s\n' "$patched_line" >> "$WORK_DISPATCHES"
        patched_count=$(( patched_count + 1 ))
      else
        printf '%s\n' "$line" >> "$WORK_DISPATCHES"
      fi
    else
      printf '%s\n' "$line" >> "$WORK_DISPATCHES"
    fi
  done < "$DISPATCHES_FILE"

  if [[ "$patched_count" -gt 0 ]]; then
    mv "$WORK_DISPATCHES" "$DISPATCHES_FILE"
    WORK_DISPATCHES=""   # an Ziel übergeben — Cleanup-Trap soll es nicht löschen
  fi
}

# ─── items.jsonl patchen (tok_total) ─────────────────────────────────────────
# Matcht item als String "S-###" (neu, AC2) oder als int (Alt-Zeilen, AC7).
patch_items_tok_total() {
  local item_str="$1"   # kanonischer String, z.B. "S-014"
  local item_nr="$2"    # numerischer Anteil, z.B. "14" (für Alt-Zeilen-Compat)
  [[ -f "$DISPATCHES_FILE" ]] || return 0
  [[ -f "$ITEMS_FILE" ]] || return 0

  # tok_total = Σ (tok.in + tok.out + tok.cache) aller gepatchten Dispatches für dieses Item
  # Matcht item als String ODER als Zahl (Alt-Zeilen-Compat)
  local tok_total
  tok_total="$(jq -s \
    --arg item_str "$item_str" \
    --arg item_nr  "$item_nr" \
    '[.[] | select((.item == $item_str or (.item | type == "number" and tostring == $item_nr))
                   and .tok != null)
           | (.tok.in // 0) + (.tok.out // 0) + (.tok.cache // 0)
     ] | add // null' \
    "$DISPATCHES_FILE" 2>/dev/null)" || tok_total="null"

  [[ "$tok_total" != "null" && -n "$tok_total" ]] || return 0

  # Temp im Zielverzeichnis → atomarer mv (s. patch_dispatches).
  WORK_ITEMS="$(mktemp "$REPO_ROOT/.claude/metrics/items-patch.XXXXXX")"
  local patched=false

  while IFS= read -r line; do
    local line_item line_toktotal
    line_item="$(printf '%s' "$line" | jq -r '.item // empty | tostring' 2>/dev/null)" || line_item=""
    line_toktotal="$(printf '%s' "$line" | jq -r 'if .tok_total == null then "null" else "set" end' 2>/dev/null)" || line_toktotal=""

    # Match: String "S-###" ODER numerischer Wert (Alt-Zeilen)
    local item_matches=false
    if [[ "$line_item" == "$item_str" || "$line_item" == "$item_nr" ]]; then
      item_matches=true
    fi

    if [[ "$item_matches" == "true" && "$line_toktotal" == "null" ]]; then
      local patched_line
      patched_line="$(printf '%s' "$line" | jq -c \
        --argjson tt "$tok_total" \
        'if .tok_total == null then .tok_total = $tt else . end' \
        2>/dev/null)" || patched_line="$line"
      printf '%s\n' "$patched_line" >> "$WORK_ITEMS"
      patched=true
    else
      printf '%s\n' "$line" >> "$WORK_ITEMS"
    fi
  done < "$ITEMS_FILE"

  if [[ "$patched" == "true" ]]; then
    mv "$WORK_ITEMS" "$ITEMS_FILE"
    WORK_ITEMS=""   # an Ziel übergeben — Cleanup-Trap soll es nicht löschen
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────
main() {
  [[ -d "$CLAUDE_PROJECTS_DIR" ]] || {
    echo "[metrics-collect] WARN: $CLAUDE_PROJECTS_DIR nicht gefunden — tok bleibt null" >&2
    return 0
  }

  # Subagent-JSONLs für dieses Item einsammeln (ITEM = numerischer Anteil für description-Matching)
  local subagent_list
  subagent_list="$(find_subagent_jsonls_for_item "$ITEM")" || subagent_list=""

  local subagent_count=0
  [[ -n "$subagent_list" ]] && subagent_count="$(printf '%s\n' "$subagent_list" | wc -l | tr -d ' ')" || true

  if [[ "$subagent_count" -eq 0 ]]; then
    echo "[metrics-collect] INFO: Keine Subagent-Transcripts für ${ITEM_STR} (#${ITEM_NR}) gefunden — tok bleibt null" >&2
    return 0
  fi

  # Dispatches patchen (AC3): übergebe String + Nummer für dual-Match (String neu + int Alt)
  patch_dispatches "$ITEM_STR" "$ITEM_NR" "$subagent_list" || true

  # items.jsonl tok_total patchen (AC3)
  patch_items_tok_total "$ITEM_STR" "$ITEM_NR" || true

  echo "[metrics-collect] OK: ${ITEM_STR} (#${ITEM_NR}) — ${subagent_count} Subagent(s) verarbeitet" >&2
}

# Alle Fehler → exit 0 + Hinweis (AC5, K3) — Messung blockiert nie den Loop
{
  main
} || {
  echo "[metrics-collect] WARN: Fehler beim Token-Sammeln für ${ITEM_STR:-Item} — tok bleibt null" >&2
  exit 0
}
