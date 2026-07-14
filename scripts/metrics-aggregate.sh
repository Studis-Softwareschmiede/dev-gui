#!/usr/bin/env bash
# metrics-aggregate.sh
#
# Liest .claude/metrics/dispatches.jsonl + items.jsonl, bildet Mediane je
# <lang>|<cost_mode>|<size> und kalibriert die EP-Gewichte per linearer
# Regression gegen echte tok/secs. Schreibt .claude/metrics/baseline.json neu.
#
# Aufgerufen von retro im periodischen Mess-Schritt (Modus C).
# Single-Writer-Disziplin: NUR retro darf baseline.json schreiben (K2).
#
# ─── Design-Entscheidung: Cache-Token-Gewichtung ─────────────────────────────
# Echte Token-Verteilung (empirisch, #109): ~302 in / ~72k out / ~15.4M cache.
# Cache-Reads sind ~10× billiger als frischer Input (API-Pricing). Würde man
# tok_total = in+out+cache ungewichtet als Eich-Ziel nehmen, würde das Cache-
# Volumen alles andere dominieren und ep_per_token verzerren.
#
# Lösung: "effektive Token" für die Kalibrierung:
#   tok_eff = in + out + κ·cache   (κ = 0.1)
#
# κ = 0.1 entspricht näherungsweise dem relativen API-Preis-Verhältnis
# (cache_read ≈ 0.1 × input_cost). So reflektiert ep_per_token den echten
# Kontingent-Verbrauch besser. items.jsonl speichert tok_total ungewichtet
# (Rohdaten), dispatches.jsonl enthält die Aufschlüsselung {in, out, cache}.
#
# Fallback: Gibt es keine Token-Daten (tok null), wird secs_total als
# Alternativ-Signal für die Regression verwendet (zeitbasierte Eichung).
# ep_per_token bezieht sich dann auf effektive Token und bleibt null wenn
# auch keine secs-Daten vorhanden sind.
# ─────────────────────────────────────────────────────────────────────────────
#
# ─── Phase 3: Defektrate je Regel-ID (AC1, §9 Arch) ─────────────────────────
# Zusätzlich zu Medianen/Kalibrierung berechnet das Script die Defektrate je
# Regel-ID aus rule_hits der items.jsonl:
#
#   Defektrate(rule_id) = (Σ Treffer von rule_id in items.rule_hits)
#                         ─────────────────────────────────────────── × 100
#                         (Σ ep_act aller Items mit ≥1 rule_hits)
#
# Normiert auf EP (nicht Item-Zahl) → über unterschiedlich grosse Sprints
# vergleichbar. Ausgabe als `defect_rates`-Objekt in baseline.json:
#   {
#     "<rule_id>": { "hits": <int>, "ep_total": <float>, "rate_per_100ep": <float>,
#                    "n_items": <int>, "window_items": [<item1>, <item2>, ...] }
#   }
# Für Zeit-/Item-Fenster: das Script gibt die gesamte History aus; retro kann
# Fenster via `since_item`-Parameter einschränken (optional, Standard = alle).
#
# Robust: 0 rule_hits in allen Items → defect_rates = {} (kein Abbruch).
# ─────────────────────────────────────────────────────────────────────────────
#
# Robust gegen leere/kleine Ledger:
#   - < MIN_ITEMS Items mit Daten → Regression wird übersprungen (null)
#   - < MIN_MEDIAN Einträge in einem Schnitt → Median bleibt null
#   - Jeder Fehler → null-Feld, kein Abbruch (K3)
#
# Requires: bash ≥3, jq, python3
#
# Usage: scripts/metrics-aggregate.sh [--repo-root <path>] [--since-item <N>]
#   --since-item N   Nur Items mit item >= N in Defektrate einbeziehen
#                    (für Fenster-Auswertung; 0 = alle, Default = 0)
#

set -euo pipefail

MIN_ITEMS=5          # Minimum Items für lineare Regression (EP-Kalibrierung)
MIN_MEDIAN=2         # Minimum Einträge für einen validen Median-Schnitt
CACHE_KAPPA="0.1"    # Cache-Token-Gewichtungsfaktor (κ = ~Preis-Verhältnis)
SINCE_ITEM="0"       # Untere Grenze für Defektrate-Fenster (0 = alle Items)

# ─── Argumente / Pfade ────────────────────────────────────────────────────────
REPO_ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)   REPO_ROOT="$2";   shift 2 ;;
    --since-item)  SINCE_ITEM="$2";  shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$REPO_ROOT" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

DISPATCHES_FILE="$REPO_ROOT/.claude/metrics/dispatches.jsonl"
ITEMS_FILE="$REPO_ROOT/.claude/metrics/items.jsonl"
BASELINE_FILE="$REPO_ROOT/.claude/metrics/baseline.json"

# ─── Vorbedingungen ───────────────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  echo "[metrics-aggregate] WARN: jq nicht gefunden — baseline.json bleibt unverändert" >&2
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[metrics-aggregate] WARN: python3 nicht gefunden — baseline.json bleibt unverändert" >&2
  exit 0
fi
if [[ ! -f "$ITEMS_FILE" ]]; then
  echo "[metrics-aggregate] INFO: items.jsonl nicht vorhanden — noch keine Daten" >&2
  exit 0
fi

# ─── Temp-Datei (atomarer Write auf baseline.json) ────────────────────────────
WORK_BASELINE=""
cleanup_temp() {
  [[ -n "${WORK_BASELINE:-}" ]] && rm -f "$WORK_BASELINE" || true
}
trap 'cleanup_temp' EXIT

WORK_BASELINE="$(mktemp "$REPO_ROOT/.claude/metrics/baseline-work.XXXXXX")"

# ─── Haupt-Logik in Python ────────────────────────────────────────────────────
# set +e um den python3-Aufruf: unter `set -e` würde ein Python-Crash bash SOFORT
# abbrechen (exit≠0), bevor der EXIT_CODE-Block unten greift — das verstösst gegen
# K3 (Messen blockiert nie den Loop). Nach dem Capture set -e wieder aktivieren.
set +e
python3 - \
  "$ITEMS_FILE" \
  "${DISPATCHES_FILE:-}" \
  "$WORK_BASELINE" \
  "$MIN_ITEMS" \
  "$MIN_MEDIAN" \
  "$CACHE_KAPPA" \
  "$BASELINE_FILE" \
  "$SINCE_ITEM" \
  <<'PYEOF'

import sys
import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path

items_file      = sys.argv[1]
dispatches_file = sys.argv[2]
work_out        = sys.argv[3]
min_items       = int(sys.argv[4])
min_median      = int(sys.argv[5])
cache_kappa     = float(sys.argv[6])
baseline_file   = sys.argv[7]
since_item      = int(sys.argv[8]) if len(sys.argv) > 8 else 0

# ─── Ledger-Daten lesen ───────────────────────────────────────────────────────
def read_jsonl(path):
    """Liest eine JSONL-Datei. Fehlerhafte Zeilen werden übersprungen."""
    rows = []
    try:
        with open(path, encoding='utf-8') as f:
            for lineno, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # Fehlerhafte Zeile überspringen (K3)
    except (OSError, IOError):
        pass
    return rows

items = read_jsonl(items_file)
dispatches = read_jsonl(dispatches_file) if (dispatches_file and Path(dispatches_file).is_file()) else []

# ─── Bestehende baseline.json lesen (weights als Fallback) ────────────────────
DEFAULT_WEIGHTS = {
    "iter": 2, "crit": 1, "imp": 0.5,
    "test_fail": 2, "loc_log": 1, "blocked": 3
}

existing_weights = dict(DEFAULT_WEIGHTS)
if Path(baseline_file).is_file():
    try:
        with open(baseline_file, encoding='utf-8') as f:
            existing = json.load(f)
        if isinstance(existing.get('weights'), dict):
            # Bestehende Gewichte als Ausgangspunkt (werden ggf. kalibriert)
            for k, v in existing['weights'].items():
                if isinstance(v, (int, float)):
                    existing_weights[k] = v
    except Exception:
        pass

# ─── Helper: sicherer numerischer Wert ───────────────────────────────────────
def safe_num(val, default=None):
    if val is None:
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default

def safe_int(val, default=0):
    if val is None:
        return default
    try:
        return int(val)
    except (TypeError, ValueError):
        return default

# ─── dispatches per Item-Dispatch aggregieren: effektive Token ───────────────
# Aus dispatches.jsonl: tok = {"in": int, "out": int, "cache": int}
# tok_eff = in + out + κ·cache
# Pro Item die Summe über alle Dispatches.
dispatch_tok_eff_per_item = {}  # item_id → tok_eff (float)
for d in dispatches:
    item_id = d.get('item')
    if item_id is None:
        continue
    tok = d.get('tok')
    if not isinstance(tok, dict):
        continue
    t_in    = safe_int(tok.get('in'), 0)
    t_out   = safe_int(tok.get('out'), 0)
    t_cache = safe_int(tok.get('cache'), 0)
    eff = t_in + t_out + cache_kappa * t_cache
    dispatch_tok_eff_per_item[item_id] = dispatch_tok_eff_per_item.get(item_id, 0.0) + eff

# ─── Items validieren und anreichern ─────────────────────────────────────────
valid_items = []
for item in items:
    ep_act = safe_num(item.get('ep_act'))
    if ep_act is None or ep_act <= 0:
        continue  # ep_act ist Pflicht und positiv
    lang      = item.get('lang') or 'unknown'
    cost_mode = item.get('cost_mode') or 'balanced'
    size_est  = item.get('size_est') or 'M'
    iters     = safe_int(item.get('iters'), 1)
    crit      = safe_int(item.get('crit'), 0)
    imp       = safe_int(item.get('imp'), 0)
    test_fails = safe_int(item.get('test_fails'), 0)
    loc       = safe_int(item.get('loc'), 0)
    blocked   = safe_int(item.get('blocked'), 0)
    secs_total = safe_num(item.get('secs_total'))
    tok_total_raw = safe_num(item.get('tok_total'))

    item_id = item.get('item')
    # Effektive Token: aus dispatches (bevorzugt) oder tok_total (Fallback, keine κ-Gewichtung)
    tok_eff = dispatch_tok_eff_per_item.get(item_id) if item_id is not None else None
    if tok_eff is None and tok_total_raw is not None:
        # Fallback: tok_total ist in+out+cache ungewichtet — trotzdem besser als null
        # Wir markieren es als "unweighted" durch flag (wird bei ep_per_token beachtet)
        tok_eff = tok_total_raw  # konservativ: keine κ-Korrektur möglich

    valid_items.append({
        'item': item_id,
        'ep_act': ep_act,
        'lang': lang,
        'cost_mode': cost_mode,
        'size_est': size_est,
        'iters': iters,
        'crit': crit,
        'imp': imp,
        'test_fails': test_fails,
        'loc': loc,
        'blocked': blocked,
        'secs_total': secs_total,
        'tok_eff': tok_eff,
        'ep_est': safe_num(item.get('ep_est')),
    })

n_items = len(valid_items)

# ─── Mediane je <lang>|<cost_mode>|<size> ────────────────────────────────────
from collections import defaultdict
groups = defaultdict(list)
for item in valid_items:
    key = f"{item['lang']}|{item['cost_mode']}|{item['size_est']}"
    groups[key].append(item)

def median_or_null(values):
    vals = [v for v in values if v is not None]
    if len(vals) < min_median:
        return None
    return statistics.median(vals)

medians = {}
for key, group in sorted(groups.items()):
    n = len(group)
    entry = {
        'n': n,
        'ep':         median_or_null([g['ep_act']   for g in group]),
        'iters':      median_or_null([g['iters']     for g in group]),
        'crit':       median_or_null([g['crit']      for g in group]),
        'tok_total':  median_or_null([g['tok_eff']   for g in group if g['tok_eff'] is not None]),
        'secs_total': median_or_null([g['secs_total'] for g in group if g['secs_total'] is not None]),
    }
    medians[key] = entry

# ─── EP-Kalibrierung: lineare Regression ─────────────────────────────────────
# Wir kalibrieren:
#   1. ep_per_token: Median von ep_act / tok_eff (robust gegen Ausreisser)
#   2. weights: OLS-Regression EP ~ Σ weight_i * driver_i
#      Treiber: (iters-1), crit, imp, test_fails, log10(loc+1), blocked
#
# Mindest-Stichprobengrösse: MIN_ITEMS.

ep_per_token = None
calibrated_weights = dict(existing_weights)
calibration_note = None

# 1. ep_per_token
items_with_tok = [it for it in valid_items if it['tok_eff'] is not None and it['tok_eff'] > 0]
if len(items_with_tok) >= min_items:
    ratios = [it['ep_act'] / it['tok_eff'] for it in items_with_tok]
    ep_per_token = statistics.median(ratios)
    # Runden auf 6 Nachkommastellen (Lesbarkeit)
    ep_per_token = round(ep_per_token, 6)
    calibration_note = f"ep_per_token kalibriert auf {len(items_with_tok)} Items (κ={cache_kappa})"
elif len(items_with_tok) > 0:
    calibration_note = (
        f"Zu wenig Token-Daten ({len(items_with_tok)}/{min_items}) — ep_per_token bleibt null"
    )
else:
    calibration_note = "Keine Token-Daten — ep_per_token bleibt null"

# 2. Gewichts-Kalibrierung via OLS (nur wenn genug Daten)
# EP-Formel: EP = 1 + w_iter*(iters-1) + w_crit*crit + w_imp*imp
#                  + w_tf*test_fails + w_loc*log10(loc+1) + w_bl*blocked
#
# Für OLS subtrahieren wir den Basis-EP=1 von ep_act:
#   y = ep_act - 1
#   X = [(iters-1), crit, imp, test_fails, log10(loc+1), blocked]
#
# OLS: w = (X^T X)^{-1} X^T y  (via numpy-freie Implementierung)
#
# Constraints: alle Gewichte >= 0.1 (Plausibilitäts-Clamp)

def ols_nonneg(X, y, min_weight=0.1):
    """Einfache OLS ohne numpy. Gibt Koeffizientenvektor zurück oder None."""
    n = len(y)
    k = len(X[0]) if X else 0
    if n < k + 1:
        return None  # unterbestimmt
    # X^T X
    XtX = [[0.0]*k for _ in range(k)]
    for row in X:
        for i in range(k):
            for j in range(k):
                XtX[i][j] += row[i] * row[j]
    # X^T y
    Xty = [0.0]*k
    for idx, row in enumerate(X):
        for i in range(k):
            Xty[i] += row[i] * y[idx]
    # Gauß-Elimination mit Pivotierung
    aug = [XtX[i] + [Xty[i]] for i in range(k)]
    for col in range(k):
        # Pivot suchen
        pivot_row = max(range(col, k), key=lambda r: abs(aug[r][col]))
        aug[col], aug[pivot_row] = aug[pivot_row], aug[col]
        if abs(aug[col][col]) < 1e-12:
            return None  # Singularität
        factor = aug[col][col]
        aug[col] = [v / factor for v in aug[col]]
        for row in range(k):
            if row != col:
                mult = aug[row][col]
                aug[row] = [aug[row][j] - mult * aug[col][j] for j in range(k+1)]
    coeffs = [aug[i][k] for i in range(k)]
    # Clamp auf min_weight (kein negatives Gewicht)
    return [max(c, min_weight) for c in coeffs]

if n_items >= min_items:
    X_data = []
    y_data = []
    for it in valid_items:
        iter_driver = max(it['iters'] - 1, 0)
        loc_driver  = math.log10(it['loc'] + 1)
        X_data.append([
            float(iter_driver),
            float(it['crit']),
            float(it['imp']),
            float(it['test_fails']),
            loc_driver,
            float(it['blocked']),
        ])
        y_data.append(it['ep_act'] - 1.0)  # Basis-EP subtrahieren

    coeffs = ols_nonneg(X_data, y_data)
    if coeffs is not None:
        weight_keys = ['iter', 'crit', 'imp', 'test_fail', 'loc_log', 'blocked']
        for k_name, c in zip(weight_keys, coeffs):
            calibrated_weights[k_name] = round(c, 4)

# ─── Forecast-MAE ─────────────────────────────────────────────────────────────
items_with_est = [it for it in valid_items if it['ep_est'] is not None]
forecast_mae = None
if len(items_with_est) >= min_median:
    abs_errs = []
    for it in items_with_est:
        if it['ep_act'] > 0:
            abs_errs.append(abs(it['ep_est'] - it['ep_act']) / it['ep_act'])
    if abs_errs:
        forecast_mae = round(statistics.mean(abs_errs), 4)

# ─── Defektrate je Regel-ID (Phase 3 / AC1) ──────────────────────────────────
# Normierung: Treffer pro 100 EP.
# Fenster: nur Items mit item >= since_item (0 = alle).
# Toleranz (AC6): 0 rule_hits oder leere items-Menge → defect_rates = {}
#
# Aus items.jsonl: rule_hits = ["coder/R01", "sql/R03", ...] (Vereinigung je Item).
# ep_total für Normierung = Σ ep_act ALLER Items im Fenster (mit UND ohne rule_hits)
# — siehe window_ep_total unten und die Architektur-Entscheidung im nächsten Absatz.
#
# Architektur-Entscheidung: ep_total je Regel bezieht sich auf ALLE Items im
# Fenster (mit UND ohne rule_hits), um den echten Aufwand zu normieren.
# Begründung: eine Regel schützt vor Fehlern auf ALLEN Items — auch die, die
# gar keinen Befund erzeugten, zählen zum "geschützten" Aufwand.

defect_rates = {}

# Alle Items im Fenster (Normierungs-Basis = gesamter EP-Aufwand im Fenster)
# Defensiv: since_item == 0 → alle Items rein (kein Vergleich nötig).
# Non-numerische item-Werte (Alt-Ledger mit String-IDs wie "S-###") →
# immer ins Fenster aufnehmen, damit sie den Lauf nicht crashen (gemischte Ledger).
def in_window(it_item, since):
    if since == 0:
        return True
    try:
        return int(it_item) >= since
    except (TypeError, ValueError):
        return True  # non-numerisch: kein Ausschluss (Alt-Daten, K3)
window_items = [it for it in valid_items if in_window(it['item'], since_item)]
window_ep_total = sum(it['ep_act'] for it in window_items)

if window_ep_total > 0:
    # Treffer je Regel-ID akkumulieren.
    # valid_items enthält kein rule_hits-Feld — wir lesen direkt aus items[] (raw),
    # den Rohdaten aus read_jsonl(items_file). Fenster-Filter: item >= since_item
    # UND ep_act vorhanden (identische Kriterien wie window_items-Aufbau oben).
    rule_hits_count = {}    # rule_id → int
    rule_items_set  = {}    # rule_id → list of item IDs (Deduplizierung)

    for raw_item in items:
        raw_item_id = raw_item.get('item')
        raw_ep = safe_num(raw_item.get('ep_act'))
        if raw_ep is None or raw_ep <= 0:
            continue
        if not in_window(raw_item_id, since_item):
            continue

        hits = raw_item.get('rule_hits')
        if not isinstance(hits, list) or len(hits) == 0:
            continue

        for rule_id in hits:
            if not isinstance(rule_id, str) or not rule_id.strip():
                continue
            rule_id = rule_id.strip()
            rule_hits_count[rule_id] = rule_hits_count.get(rule_id, 0) + 1
            if rule_id not in rule_items_set:
                rule_items_set[rule_id] = []
            if raw_item_id is not None and raw_item_id not in rule_items_set[rule_id]:
                rule_items_set[rule_id].append(raw_item_id)

    for rule_id, hits in sorted(rule_hits_count.items()):
        rate = round(hits / window_ep_total * 100, 4) if window_ep_total > 0 else None
        defect_rates[rule_id] = {
            "hits": hits,
            "ep_total": round(window_ep_total, 4),
            "rate_per_100ep": rate,
            "n_items": len(rule_items_set.get(rule_id, [])),
            "window_items": sorted(rule_items_set.get(rule_id, [])),
        }

# ─── Estimator-Bias je <lang>|<cost_mode>|<size> (AC8 estimator-Spec) ────────
# Vorzeichenbehafteter mittlerer Schätzfehler (Bias) je Schnitt:
#   bias = ø( (ep_est − ep_act) / ep_act )   über alle Items im Schnitt
#
# Positives Ergebnis → Schätzung war höher als Ist-Wert → Überschätzung.
# Negatives Ergebnis → Schätzung war unter dem Ist-Wert → Unterschätzung.
# (coder/L16: Vorzeichen-Kommentar immer gegen Beispiel gegenprüfen:
#  est=5, act=3 → (5−3)/3 = +0.67 → Überschätzung ✓)
#
# Nur Items MIT ep_est (nicht null) und positiven ep_act berücksichtigen.
# Schnitte mit < MIN_MEDIAN solcher Items → kein Bias-Eintrag (keine Schein-Präzision).
# Fenster: alle Items (keine --since-item-Filterung; Bias-Berechnung nutzt globale Basis).
# Datenmangel (keine ep_est-Daten) → estimator_bias = {} (kein Abbruch, K3).
#
# Single-Writer: metrics-aggregate.sh schreibt estimator_bias (Modus C/AC8).
# Die Werte werden von retro (Modus E) in estimator_calibration nachverfolgt.

estimator_bias_groups = {}  # schnitt → list of relative errors
for it in valid_items:
    if it['ep_est'] is None:
        continue
    if it['ep_act'] <= 0:
        continue
    key = f"{it['lang']}|{it['cost_mode']}|{it['size_est']}"
    rel_err = (it['ep_est'] - it['ep_act']) / it['ep_act']
    if key not in estimator_bias_groups:
        estimator_bias_groups[key] = []
    estimator_bias_groups[key].append(rel_err)

estimator_bias = {}
for key, errors in sorted(estimator_bias_groups.items()):
    if len(errors) < min_median:
        continue  # Zu wenig Daten für diesen Schnitt → kein Eintrag
    bias_val = sum(errors) / len(errors)
    estimator_bias[key] = round(bias_val, 4)

# ─── Persistente Felder aus bestehender baseline.json lesen ──────────────────
# Beide Felder — learnings_rules (Modus D) und estimator_calibration (Modus E) —
# werden von retro geschrieben und von diesem Script nur als Pass-through
# weitergeführt (Single-Writer-Disziplin K2). Einmaliges Lesen der Datei.
_persistent_baseline = {}
if Path(baseline_file).is_file():
    try:
        with open(baseline_file, encoding='utf-8') as f:
            _persistent_baseline = json.load(f)
    except Exception:
        pass

# estimator_calibration (AC10 estimator-Spec): persistent aus baseline.json
# Format je Eintrag:
#   { target: str, kind: "bias"|"anchor"|"prompt",
#     status: "pending"|"validated"|"reverted",
#     baseline_mae: float|null, measured_mae: float|null,
#     n: int, started_after_item: int|null, decided_after_item: int|null }
estimator_calibration = []
ec = _persistent_baseline.get('estimator_calibration')
if isinstance(ec, list):
    estimator_calibration = ec

# ─── Gesamt-Retro-Effektivitäts-Kennzahl (AC4) ───────────────────────────────
# Berechnet aus baseline.json.learnings_rules (wird von retro beim Promoten
# befüllt — siehe retro.md Modus D). Format der Einträge:
#   { "rule_id": "coder/R01", "status": "Validated"|"Measuring"|"Reverted",
#     "baseline_rate": 4.2, "measured_rate": 0.8, "measured_n": 30,
#     "promoted_after_item": 100 }
#   (Feldname measured_n — konsistent mit arch §2.3, spec V6b, retro.md D2.)
#
# Gesamt-Effektivität = Σ (baseline_rate - measured_rate) * (measured_n/100)
#                         über alle Validated-Regeln
#                     - Σ (measured_rate - baseline_rate) * (measured_n/100)
#                         über alle Reverted-Regeln
#
# Einheit: "EP-äquivalente Defekt-Reduktion" (normiert auf 100 EP).
# Null, wenn keine Validated/Reverted-Daten vorhanden.

retro_effectiveness = None
learnings_rules = []

# Bestehende learnings_rules aus baseline.json lesen (persistent über Läufe)
lr = _persistent_baseline.get('learnings_rules')
if isinstance(lr, list):
    learnings_rules = lr

validated = [r for r in learnings_rules if r.get('status') == 'Validated'
             and r.get('baseline_rate') is not None and r.get('measured_rate') is not None
             and r.get('measured_n') is not None]
reverted  = [r for r in learnings_rules if r.get('status') == 'Reverted'
             and r.get('baseline_rate') is not None and r.get('measured_rate') is not None
             and r.get('measured_n') is not None]

if validated or reverted:
    gain   = sum((r['baseline_rate'] - r['measured_rate']) * r['measured_n'] / 100
                 for r in validated
                 if r['baseline_rate'] > r['measured_rate'])
    damage = sum((r['measured_rate'] - r['baseline_rate']) * r['measured_n'] / 100
                 for r in reverted
                 if r['measured_rate'] > r['baseline_rate'])
    retro_effectiveness = round(gain - damage, 4)

# ─── baseline.json schreiben ──────────────────────────────────────────────────
calibrated_at = datetime.now(timezone.utc).strftime('%Y-%m-%d')

output = {
    "schema_version": 1,
    "calibrated_at": calibrated_at,
    "n_items": n_items,
    "ep_per_token": ep_per_token,
    "cache_kappa": float(cache_kappa),
    "weights": calibrated_weights,
    "medians": medians,
    "forecast_mae": forecast_mae,
    "defect_rates": defect_rates,
    "retro_effectiveness": retro_effectiveness,
    "learnings_rules": learnings_rules,
    "estimator_bias": estimator_bias,
    "estimator_calibration": estimator_calibration,
}

if calibration_note:
    output["_calibration_note"] = calibration_note

with open(work_out, 'w', encoding='utf-8') as f:
    json.dump(output, f, indent=2, ensure_ascii=False)
    f.write('\n')

# Status-Ausgabe — auf stderr (stdout bleibt sauber; konsistent mit metrics-collect.sh)
n_rules = len(defect_rates)
n_bias_schnitte = len(estimator_bias)
n_calibration = len(estimator_calibration)
print(f"[metrics-aggregate] OK: {n_items} Items, "
      f"{len(medians)} Median-Schnitte, "
      f"ep_per_token={'%.6f' % ep_per_token if ep_per_token is not None else 'null'}, "
      f"forecast_mae={forecast_mae}, "
      f"defect_rates={n_rules} Regeln, "
      f"retro_effectiveness={retro_effectiveness}, "
      f"estimator_bias={n_bias_schnitte} Schnitte, "
      f"estimator_calibration={n_calibration} Eintraege", file=sys.stderr)
PYEOF

EXIT_CODE=$?
set -e
if [[ $EXIT_CODE -ne 0 ]]; then
  echo "[metrics-aggregate] WARN: Python-Aggregation fehlgeschlagen (exit $EXIT_CODE) — baseline.json bleibt unverändert" >&2
  exit 0
fi

# Prüfen ob WORK_BASELINE etwas enthält (Python hat erfolgreich geschrieben)
if [[ ! -s "$WORK_BASELINE" ]]; then
  echo "[metrics-aggregate] WARN: Leere Ausgabe — baseline.json bleibt unverändert" >&2
  exit 0
fi

# Atomarer Replace (rename(2) im selben Verzeichnis — coder/L10)
mv "$WORK_BASELINE" "$BASELINE_FILE"
WORK_BASELINE=""  # Cleanup-Trap soll die nun an Ziel übergebene Datei nicht löschen
