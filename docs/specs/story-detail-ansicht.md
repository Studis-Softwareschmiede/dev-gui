---
id: story-detail-ansicht
title: Story-Detail-Ansicht — Zeiten, Agenten-Flow, Schätzung vs. Ist
status: draft
area: board
version: 1
---

# Spec: Story-Detail-Ansicht  (`story-detail-ansicht`)

> **Konzept-only** (status: draft). Verbesserung der Story-Anzeige im Studis-Kanban-Board.
>
> **Zweck.** Klick auf eine Story öffnet eine **Detail-Seite** mit der Bearbeitungs-Historie: wann begonnen/beendet, welche Agenten in welcher Reihenfolge (Flow), und die **Soll-Ist-Gegenüberstellung** (geschätzte vs. tatsächliche Aufwands-Punkte + Tokens). Die Kanban-Karte selbst bleibt schlank — die Details sind ein Drill-down.

## Lösungsvorschlag / Designentscheidungen

- **Datenquelle = vorhandene Metrik-Ledger.** Alles ist schon erfasst (kein neuer Speicher):
  - `.claude/metrics/dispatches.jsonl` — je Agent-Dispatch: `ts` (Zeit), `agent`, `seq` (Reihenfolge = Flow), `iter`, `gate`, `secs`, `tok` → liefert **Start/Ende** (min/max ts) + **Agenten-Flow** (seq-geordnet) + Tokens.
  - `.claude/metrics/items.jsonl` — je Story: `size_est`, `ep_est`, `ep_act`, `tok_total`, `iters` → liefert **Soll-Ist** (Schätzung vs. Ist).
- **WO — Drill-down, nicht auf der Karte.** Klick auf eine Story-Karte → Detail-Panel/Seite (nicht permanent auf dem Board). Entlastet die Kanban-Übersicht.
- **WIE — drei Blöcke:** (1) Zeiten (Start/Ende/Dauer), (2) Flow (Agenten-Sequenz coder→reviewer→… mit Iterationen/Gates), (3) Schätzung vs. Ist (ep_est↔ep_act, tok_est↔tok_total, mit Abweichung in %).
- **QUELLE lazy + read-only** (neuer Reader bzw. Erweiterung des bestehenden RetroReader-Musters); pro Story on-demand.

## Verhalten

### V1 — Story-Metrik-Reader (Backend)
Liest zu einer Story-ID aus `dispatches.jsonl` (alle Zeilen mit `item == <story-id>`) + `items.jsonl` (die Story-Zeile) und liefert: `started_at` (min ts), `ended_at` (max ts), `duration`, `flow` (Liste {seq, agent, iter, gate, secs, tok}), `ep_est`, `ep_act`, `tok_est` (falls vorhanden), `tok_total`, `size_est`, Abweichungen.

### V2 — API (read-only, lazy)
`GET /api/board/projects/:slug/stories/:id/detail` → das Story-Detail-Objekt. Fehlende Metrik → Felder null, kein Crash.

### V3 — Detail-Ansicht (Frontend)
Klick auf eine Story-Karte im Kanban → Detail-Panel/Seite mit drei Blöcken: Zeiten · Agenten-Flow (chronologisch, je Schritt Agent/Iteration/Gate/Dauer) · Schätzung vs. Ist (ep_est vs ep_act, tok geschätzt vs. tatsächlich, Abweichung %). Zurück zum Board.

### V4 — Soll-Ist-Darstellung
Geschätzte Aufwands-Punkte (ep_est) und geschätzte Tokens gegenüber tatsächlichen (ep_act, tok_total); Abweichung farblich/numerisch (über-/unterschätzt) — analog der estimator/retro-Logik ([[estimator]] im agent-flow). Fehlt eine Schätzung (Baseline leer) → „keine Schätzung".

### V5 — Vorab-Schätzung als Fallback (Story-YAML)
Liefert `items.jsonl` für die Story **kein** `ep_est`/`tok_est` (z. B. vor dem ersten `/flow`-Lauf existiert keine Ledger-Zeile), fällt die Soll-Ist-Ansicht für die **Schätzungs-Spalte** auf die Vorab-Schätzung aus der Story-YAML zurück: `dispo_est` als geschätzte Aufwands-Punkte (und, falls in der YAML vorhanden, ein Token-Schätzfeld). Die **Ist-/Abweichungs-Spalten** bleiben leer, bis ein Flow-Lauf echte Werte ins Ledger schreibt. Die **Herkunft** der angezeigten Schätzung (Vorab-Schätzung aus der YAML vs. Flow-Ledger) ist im UI erkennbar (Label/Badge). Sind weder Ledger- noch YAML-Schätzung vorhanden → weiterhin „keine Schätzung".

## Acceptance-Kriterien
- **AC1** — Backend-Reader liefert zu einer Story aus dispatches.jsonl+items.jsonl: Start/Ende/Dauer, Agenten-Flow (seq-geordnet), ep_est/ep_act/tok-geschätzt/tok_total/size_est + Abweichungen; fehlende Metrik → null, kein Crash. *(V1)*
- **AC2** — `GET …/stories/:id/detail` liefert das Detail-Objekt (read-only, lazy, hinter accessGuard). *(V2)*
- **AC3** — Klick auf Story-Karte öffnet Detail-Ansicht mit drei Blöcken (Zeiten/Flow/Soll-Ist); Rückweg vorhanden. *(V3)*
- **AC4** — Soll-Ist zeigt ep_est↔ep_act + tok-geschätzt↔tok_total mit Abweichung; fehlende Schätzung sauber dargestellt. *(V4)*
- **AC5** — Liefert `items.jsonl` für die Story kein `ep_est`/`tok_est`, fällt die Soll-Ist-Ansicht für die Schätzung auf `dispo_est` (und ein Token-Schätzfeld, falls in der Story-YAML vorhanden) zurück; die Ist-/Abweichungs-Spalten bleiben leer bis zum Flow-Lauf; die Herkunft der Schätzung (Vorab-Schätzung aus YAML vs. Flow-Ledger) ist im UI erkennbar. Fehlt auch die YAML-Schätzung → „keine Schätzung". *(V5)* (Testbar: Story mit `dispo_est` und ohne Ledger-Zeile zeigt die YAML-Schätzung mit Herkunfts-Kennzeichnung und leere Ist-/Abweichungs-Spalten; Story ohne beides zeigt „keine Schätzung".)

## Nicht-Ziele
- Editieren der Metrik aus der GUI (read-only).
- Neue Metrik-Erfassung (nutzt die bestehende; tok_est wird ggf. aus ep_est/ep_per_token abgeleitet wie in estimator).

## Abhängigkeiten
- Metrik-Ledger (agent-flow `.claude/metrics/dispatches.jsonl`, `items.jsonl`); [[estimator]] (Soll-Ist-Logik).
- dev-gui: neuer Story-Metrik-Reader + Endpoint + Detail-Ansicht; baut auf [[studis-kanban-board-ux]] (Story-Karten) auf.
