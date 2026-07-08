---
title: dev-gui Rauchtest — App-Hülle lädt (lokal, kostenlos)
target: local
quell_specs:
  - docs/specs/run-state-live-view.md
---

# dev-gui — Rauchtest: App lädt

Test-Begleitbeschreibung für `dev-gui-app-loads.spec.ts`.

## target

`local` — läuft gegen die lokal laufende dev-gui-Instanz (`REGRESSION_BASE_URL`),
keine Cloud-Infrastruktur, keine Kosten. Dient als kostenloser Rauchtest der
Regressions-Laufzeit (Playwright + Runner), nicht als fachliche Abdeckung.

## nicht-datengetrieben

Bewusst ohne Datentabelle (`.data.json`) — der Rauchtest prüft nur, dass die
Anwendung ausgeliefert wird und die App-Hülle vorhanden ist.
