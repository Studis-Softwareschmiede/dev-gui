---
id: metrics-scripts-backfill
title: Metrik-Ledger-Skripte in dev-guis scripts/ nachrüsten
status: superseded
area: retro-lernen
version: 1
---

# Spec: Metrik-Ledger-Skripte in dev-guis scripts/ nachrüsten  (`metrics-scripts-backfill`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
> **Abgelöst (2026-07-17, Story S-364).** Diese Spec schreibt Skript-**Kopien** ins Projekt vor. agent-flow-Spec `metrics-repo-anchor` AC6 (V2) legt das Werkzeug stattdessen ausschließlich ins Plugin (`${CLAUDE_PLUGIN_ROOT}/scripts/`) und übergibt den Ledger-Pfad explizit via `METRICS_ROOT`. Damit wird das Nachrüsten gegenstandslos: Kopien driften (dev-gui hatte sie, sechs andere Projekte nie — Erfassung existierte in 2 von 8 Projekten). Status → `superseded`, sobald S-069 gelandet ist; Kopien unter `scripts/metrics-*.sh` entfallen.

dev-gui entstand, bevor das Metrik-Subsystem in den `new-project`/`adopt`-Scaffold aufgenommen wurde — das Nachrüsten der projekteigenen Ledger-Skripte wurde nie durchgeführt. Diese Spec rüstet die vier Metrik-Ledger-Skripte einmalig in dev-guis `scripts/` nach, damit `/flow` und `/retro` sie **spec-konform** über `${METRICS_ROOT}/scripts/…` finden (agent-flow-Spec `metrics-repo-anchor` AC2) und die Ledger-Aggregation/Kalibrierung wieder läuft.

## Kontext / Problem
- `/flow` und `/retro` rufen die Metrik-Skripte **zwingend** über `${METRICS_ROOT}/scripts/…` auf; der interne Ledger-Pfad wird aus `$SCRIPT_DIR/..` abgeleitet, nur der Aufruf über `${METRICS_ROOT}/scripts/` garantiert Übereinstimmung mit dem Board-Repo (agent-flow-Spec `metrics-repo-anchor` AC2).
- In dev-gui **fehlen** diese vier Skripte im `scripts/`-Ordner: `metrics-append-item.sh`, `metrics-append-dispatch.sh`, `metrics-aggregate.sh`, `metrics-collect.sh` (dev-guis `scripts/` enthält bislang nur `fix-pty-perms.mjs`, `migrate-areas.mjs`, `validate-json.py`).
- Das Ledger-Verzeichnis `.claude/metrics/` existiert und wird beschrieben (`baseline.json` vorhanden; `dispatches.jsonl`/`items.jsonl` werden erzeugt), aber die Drain-/Retro-Agenten mussten notdürftig über die agent-flow-Plugin-Cache-Kopie der Skripte überbrücken.
- **Folgen:** (1) die spec-vorgeschriebene Aufruf-Naht (`${METRICS_ROOT}/scripts/…`) ist verletzt; (2) `tok_total`-/Token-Metriken bleiben leer; (3) die Retro-Modi **C** (Ledger-Aggregation), **D** (LEARNINGS-Lebenszyklus) und **E** (Estimator-Kalibrierung) laufen mangels `metrics-aggregate.sh` in dev-gui gar nicht.

## Verhalten
1. Die vier Skripte werden **einmalig** aus dem agent-flow-Bestand nach `scripts/` kopiert und als ausführbar markiert.
2. Das Nachrüsten ist **idempotent**: ein wiederholter Lauf lässt bereits vorhandene, inhaltsgleiche Skripte unverändert und überschreibt **keine** bestehenden Ledger-Dateien.
3. Die Skripte sind **repo-agnostisch**: sie leiten ihren Ledger-Pfad aus `$SCRIPT_DIR/..` ab und funktionieren ohne dev-gui-spezifische Pfad-Anpassung. Ergibt die Prüfung wider Erwarten eine Abhängigkeit von einem fixen/fremden Pfad, wird diese im Rahmen des Nachrüstens minimal auf die dev-gui-Struktur angepasst (Ledger unter `.claude/metrics/`).

## Acceptance-Kriterien

- **AC1** — Die vier Skripte `metrics-append-item.sh`, `metrics-append-dispatch.sh`, `metrics-aggregate.sh`, `metrics-collect.sh` liegen in dev-guis `scripts/` und sind ausführbar (`chmod +x`). Das Nachrüsten ist idempotent und überschreibt **keine** bestehende Ledger-Datei unter `.claude/metrics/` (`baseline.json`, `dispatches.jsonl`, `items.jsonl` bleiben unangetastet).
- **AC2** — Die Skripte sind repo-agnostisch verifiziert: aufgerufen über `${METRICS_ROOT}/scripts/metrics-*.sh` (mit `METRICS_ROOT` = dev-gui-Repo-Wurzel) lösen sie ihren Ledger-Pfad korrekt auf `<repo>/.claude/metrics/` auf (Übereinstimmung mit der Naht aus agent-flow-Spec `metrics-repo-anchor` AC2). War eine minimale Pfad-Anpassung nötig, ist sie dokumentiert.
- **AC3** — Nach dem Nachrüsten sind die von `/flow` und `/retro` erwarteten Aufrufe lauffähig: `metrics-append-dispatch.sh`/`metrics-append-item.sh` hängen ans Ledger an (Token-/`tok_total`-Metriken werden nicht mehr leer bleiben), und `metrics-aggregate.sh` läuft ohne Fehler durch, sodass die Retro-Modi **C/D/E** in dev-gui wieder ausführbar sind.

## Verträge
- **Quelle:** aktueller agent-flow-Bestand (Plugin-Cache `~/.claude/plugins/cache/agent-flow/agent-flow/<version>/scripts/metrics-*.sh`, robust auf die neueste Version aufgelöst via `ls -dt`).
- **Ziel:** `scripts/metrics-append-item.sh`, `scripts/metrics-append-dispatch.sh`, `scripts/metrics-aggregate.sh`, `scripts/metrics-collect.sh` (relativ zur dev-gui-Repo-Wurzel).
- **Ledger (nicht überschreiben):** `.claude/metrics/baseline.json`, `.claude/metrics/dispatches.jsonl`, `.claude/metrics/items.jsonl`.
- **Aufruf-Naht (unverändert von agent-flow vorgegeben):** `${METRICS_ROOT}/scripts/<script>.sh`; interner Ledger-Pfad = `$SCRIPT_DIR/../.claude/metrics/`.

## Edge-Cases & Fehlerverhalten
- Skript existiert bereits und ist inhaltsgleich → keine Änderung (Idempotenz).
- Skript existiert bereits, ist aber veraltet → auf den aktuellen agent-flow-Stand aktualisieren (Skripte sind Werkzeuge, keine Ledger-Daten).
- Ledger-Datei existiert bereits → **nie** überschreiben.
- Plugin-Cache-Pfad nicht auflösbar → Fehler sichtbar melden, keine leeren/teilweisen Skripte zurücklassen.

## NFRs
- Kein Secret in Skripten/Logs.
- Rein dateibasiertes Nachrüsten, kein LLM-Aufruf zur Ausführung der Skripte selbst.

## Nicht-Ziele
- **Keine** Änderung am Inhalt/Verhalten der agent-flow-Metrik-Skripte (nur Übernahme des Bestands).
- **Keine** Rückrechnung/Backfill historischer Ledger-Zeilen.
- **Keine** Neudefinition der Ledger-Formate oder der EP-Formel (liegt in agent-flow `metrics-subsystem`/`metrics-repo-anchor`).

## Abhängigkeiten
- agent-flow-Spec **`metrics-repo-anchor`** (Aufruf-Naht `${METRICS_ROOT}/scripts/…`, Ledger-Pfad aus `$SCRIPT_DIR/..`) — Source of Truth für Verhalten/Naht; hier **nicht dupliziert**, nur referenziert.
- agent-flow-Spec **`metrics-subsystem`** (Single-Writer-Disziplin, EP-Formel, Ledger-Dateien).
