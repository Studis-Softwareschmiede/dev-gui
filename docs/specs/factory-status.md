---
id: factory-status
title: Fabrik-Status (Dashboard live aus GitHub + Docker)
status: draft
area: fabrik-arbeiten
version: 1
---

# Spec: Fabrik-Status (`factory-status`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.

## Zweck
Ein Statusüberblick der Fabrik in einer Ansicht — Projekte, offene Board-Items, letzter CI-Lauf, laufende Preview-Container — **live** aus GitHub-API + Docker, ohne eigenen Persistenz-Store.

## Verhalten
1. Das Backend aggregiert auf Anfrage live: Org-Projekte (Repos ≠ `agent-flow`, ≠ `dev-gui`), je Projekt die Zahl offener Issues (= Proxy für offene Board-Items), den Status des letzten CI-Laufs und die laufenden Preview-Container (Name/Port→URL/Status).
2. GitHub-Daten kommen über den GitHub-App-Token (GitHubReader), Docker-Daten über die Docker-Engine (DockerReader).
3. Das Frontend stellt das als Dashboard dar und aktualisiert periodisch (oder per SSE).

## Acceptance-Kriterien
- **AC1** — `GET /api/status` liefert pro Projekt: `name`, `openItems` (`number|'unknown'` — Anzahl offener Issues des Repos, exkl. Pull Requests; `'unknown'` wenn die Quelle nicht erreichbar war), `lastCi` (`success|failure|in_progress|none|unknown`; `unknown` wenn die Quelle nicht erreichbar war), und global `previews` (Liste laufender Preview-Container mit `name`, `url`, `status`).
- **AC2** — GitHub-Daten werden über den App-Token gelesen; Docker-Daten über die Docker-Engine (`ps`/`inspect`). Kein Wert stammt aus einem persistierten Store.
- **AC3** — Das Frontend zeigt ein Dashboard mit je einer Karte pro Projekt (offene Items, letzter CI-Lauf, Preview-Container mit **klickbarer URL**) und aktualisiert sich automatisch (Intervall oder SSE).

  > **⟶ Superseded (2026-07-08, [[cockpit-declutter]] AC2, S-304):** Die Frontend-Dashboard-Kachel (`client/src/Dashboard.jsx`) ist im „Arbeiten"-Reiter des Cockpits **restlos entfernt** — kein Frontend-Rendering dieses ACs mehr. `GET /api/status` (AC1/AC2/AC4 hier) bleibt unverändert bestehen, weil `ClaudeAuthBadge.jsx` weiterhin konsumiert (`claudeAuth`-Zustand). Ein neues Frontend-Dashboard existiert aktuell nicht — diese Spec bleibt `draft`, bis ein Nachfolge-Item ein neues Zuhause definiert (kein Bestandteil dieser Story).
- **AC4** — Jede Antwort wird **live** ermittelt (kein Cache als Source of Truth); bei Nichterreichbarkeit einer Quelle wird das Feld als „unbekannt" markiert statt zu blockieren.

## Verträge
- `GET /api/status` → `200 {projects:[{name, openItems: number|'unknown', lastCi: 'success'|'failure'|'in_progress'|'none'|'unknown'}], previews:[{name, url, status}]}`.
- GitHub: REST/GraphQL via App-Token. Docker: Engine-Socket (read-only).

## Edge-Cases & Fehlerverhalten
- GitHub-Rate-Limit / Docker nicht erreichbar → betroffenes Feld „unbekannt", restliche Daten trotzdem geliefert (graceful degradation).
- Repo ohne Board → `openItems: 0` / `none`.

## NFRs
- **Sicherheit:** Antwort enthält keine Tokens/Secrets. (`security` Floor.)
- Performance: Aggregation parallelisiert; eine langsame Quelle blockiert die anderen nicht.

## Nicht-Ziele
- Schreibende GitHub-/Docker-Operationen (das macht die Fabrik selbst über die Session).

## Abhängigkeiten
- [[access-and-guardrails]] (Gate). Preview-Daten korrespondieren mit der `/preview`-Capability der Fabrik.
