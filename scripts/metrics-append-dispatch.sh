#!/usr/bin/env bash
# metrics-append-dispatch.sh <story-id> <agent> <seq> <iter> <gate> <secs> [<cost_mode>]
#
# Hängt eine Zeile an .claude/metrics/dispatches.jsonl an.
# Wird von /flow nach jedem Agent-Dispatch aufgerufen (§2b Touchpoint).
#
# Verträge (Spec metrics-recording-reliability V1/V2):
#   - <story-id>  : kanonisches String-Format "S-###" (AC2)
#   - <agent>     : coder|reviewer|dba|tester|cicd|estimator
#   - <seq>       : laufende Dispatch-Nummer innerhalb des Items (ab 1)
#   - <iter>      : Build-Loop-Iteration (int)
#   - <gate>      : PASS|CHANGES-REQUIRED|FAIL|SKIPPED-*|null
#   - <secs>      : Wall-Clock-Dauer in Sekunden (int)
#   - <cost_mode> : optional; Default "balanced"
#
# Append-only, idempotenz-tolerant, || true (K3: kein Loop-Abbruch bei Fehler).
# Kein LLM-Aufruf — reine Bash/jq-Arithmetik (K1, AC6).
# Historische Zeilen werden nie geändert (AC7).
#
# Optionale Env-Variablen (crit/imp/rule_hits aus Reviewer-Handoff):
#   METRIC_CRIT=<int>            (Default 0)
#   METRIC_IMP=<int>             (Default 0)
#   METRIC_RULE_HITS='["r/R01"]' (Default [])

set -euo pipefail

STORY_ID="${1:-}"
AGENT="${2:-}"
SEQ="${3:-1}"
ITER="${4:-1}"
GATE_RAW="${5:-null}"
SECS="${6:-0}"
COST_MODE="${7:-balanced}"

# Pflichtfelder prüfen
if [[ -z "$STORY_ID" || -z "$AGENT" ]]; then
  echo "[metrics-append-dispatch] WARN: Pflichtfelder fehlen (story-id, agent) — Zeile nicht geschrieben" >&2
  exit 0
fi

# ID-Normalisierung (V2): kanonisches String-Format "S-###" erzwingen.
# Eine rein numerische ID (z.B. "179") würde als bloße Zahl ins Ledger gelangen und
# könnte später beim Lesen (numerisches ID-Matching) mit einer wiederverwendeten
# Story-Nummer kollidieren. Daher hier an der Quelle zu "S-179" normalisieren.
if [[ "$STORY_ID" =~ ^[0-9]+$ ]]; then
  echo "[metrics-append-dispatch] WARN: numerische story-id='${STORY_ID}' → normalisiert zu 'S-${STORY_ID}'" >&2
  STORY_ID="S-${STORY_ID}"
fi

# AGENT-Enum-Guard (Typo-Schutz, K3-tolerant — ungültig → Warnung, kein Abbruch)
case "$AGENT" in
  coder|reviewer|dba|tester|cicd|estimator) ;;
  *)
    echo "[metrics-append-dispatch] WARN: Unbekannter agent='${AGENT}' (erwartet: coder|reviewer|dba|tester|cicd|estimator) — Zeile trotzdem geschrieben" >&2
    ;;
esac

# jq-Verfügbarkeit prüfen
if ! command -v jq >/dev/null 2>&1; then
  echo "[metrics-append-dispatch] WARN: jq nicht gefunden — Zeile nicht geschrieben" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
METRICS_DIR="$REPO_ROOT/.claude/metrics"
DISPATCHES_FILE="$METRICS_DIR/dispatches.jsonl"

# Verzeichnis anlegen falls nötig
mkdir -p "$METRICS_DIR" 2>/dev/null || true

# Optionale Felder aus Env
CRIT="${METRIC_CRIT:-0}"
IMP="${METRIC_IMP:-0}"
RULE_HITS="${METRIC_RULE_HITS:-[]}"

# gate: "null" als String → JSON null; sonst String
if [[ "$GATE_RAW" == "null" || -z "$GATE_RAW" ]]; then
  GATE_JSON='null'
else
  GATE_JSON="$(jq -n --arg g "$GATE_RAW" '$g')"
fi

# Numerik-Guards (keine Shell-Injection über jq-argjson)
[[ "$SEQ"  =~ ^[0-9]+$ ]] || SEQ=1
[[ "$ITER" =~ ^[0-9]+$ ]] || ITER=1
[[ "$SECS" =~ ^[0-9]+$ ]] || SECS=0
[[ "$CRIT" =~ ^[0-9]+$ ]] || CRIT=0
[[ "$IMP"  =~ ^[0-9]+$ ]] || IMP=0

# rule_hits muss gültiges JSON-Array sein
if ! printf '%s' "$RULE_HITS" | jq -e 'if type=="array" then true else false end' >/dev/null 2>&1; then
  RULE_HITS='[]'
fi

# Zeile schreiben (append-only)
jq -nc \
  --arg     ts        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg     item      "$STORY_ID" \
  --argjson seq       "$SEQ" \
  --arg     agent     "$AGENT" \
  --argjson iter      "$ITER" \
  --argjson gate      "$GATE_JSON" \
  --argjson crit      "$CRIT" \
  --argjson imp       "$IMP" \
  --argjson rule_hits "$RULE_HITS" \
  --argjson secs      "$SECS" \
  --arg     cost_mode "$COST_MODE" \
  '{ts:$ts, item:$item, seq:$seq, agent:$agent, iter:$iter,
    gate:$gate, crit:$crit, imp:$imp, rule_hits:$rule_hits,
    secs:$secs, tok:null, cost_mode:$cost_mode}' \
  >> "$DISPATCHES_FILE" 2>/dev/null || true

echo "[metrics-append-dispatch] OK: ${STORY_ID} seq=${SEQ} agent=${AGENT} gate=${GATE_RAW}" >&2
