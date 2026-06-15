---
id: retro-train-board-local
title: Retro/Train-Verbesserungs-Board lokal im dev-gui (Quelle LEARNINGS.md)
status: active
version: 1
---

# Spec: Retro/Train-Verbesserungs-Board lokal  (`retro-train-board-local`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge. Source of Truth für coder/tester/reviewer.
>
> **Zweck.** Das Lern-Tracking der Fabrik (retro/train-Promotion-Karten) wird **lokal im dev-gui** sichtbar — als Kanban über den Status-Lebenszyklus — statt nur auf dem GitHub-Project #5. Quelle ist das bereits vorhandene, git-versionierte `LEARNINGS.md` (im agent-flow-Repo); GitHub #5 wird danach archiviert.

## Kontext / Designentscheidungen (bindend)

- **Quelle der Wahrheit = `LEARNINGS.md`** (agent-flow, git-versioniert). Es trägt schon den Lebenszyklus `Proposed → Merged → Measuring → Validated | Reverted | Expired`. Kein neuer Datenspeicher. Kennzahlen (Defektraten/Effektivität) kommen wie heute aus `baseline.json`. *(Entscheidung Owner 2026-06-15)*
- **Anzeige = RetroView erweitern**, kein neuer Einstieg: ein zweiter Reiter „Verbesserungs-Board" neben den bestehenden Lauf-Listen; nutzt denselben `RetroReader`. *(Owner)*
- **GitHub-Board #5 wird archiviert** (read-only Rückfall via `gh project close --undo`); retro/train schreiben künftig nur noch `LEARNINGS.md` (der best-effort-gh-Schritt entfällt). *(Owner)*
- **Read-only Anzeige.** dev-gui zeigt nur; geschrieben wird `LEARNINGS.md` ausschließlich von retro/train über PR (unverändert).
- **Cross-Repo:** die Anzeige lebt in dev-gui; das Weglassen des gh-Schritts + das Archivieren in agent-flow.

## Verhalten

### V1 — Karten aus LEARNINGS.md lesen (dev-gui Backend)
`RetroReader` bekommt eine Methode (z.B. `getPromotionCards()`), die `LEARNINGS.md` parst und je Eintrag eine Karte liefert: `id, datum, ziel (pack/skill/agent), regel, quelle, pr, status`, abgeleitete `art` (retro|train aus der Quelle/PR-Spalte) und `kategorie` (agents|skills|knowledge aus dem Ziel). Gruppiert nach `status`.

### V2 — API-Endpunkt (dev-gui Backend)
Neuer read-only Endpunkt `GET /api/retro/cards` (hinter dem bestehenden `accessGuard`) liefert die Karten gruppiert nach Status. Fehlt `LEARNINGS.md` → leere, valide Antwort (kein Crash).

### V3 — Kanban-Reiter in RetroView (dev-gui Frontend)
RetroView bekommt einen Reiter-Umschalter „Läufe" | „Verbesserungs-Board". Der Board-Reiter zeigt Spalten je Status (`Proposed · Merged · Measuring · Validated · Reverted · Expired`); leere Spalten dezent.

### V4 — Karten-Darstellung (dev-gui Frontend)
Je Karte: Regel-ID, Ziel (Pack/Skill/Agent), Art-Badge (retro|train), Status-Badge, Link zum PR (extern). Kennzahl (rate_per_100ep, baseline→neu) anzeigen, wo aus `baseline.json` vorhanden — analog der heutigen RetroView-Detailanzeige.

### V5 — Filter (dev-gui Frontend)
Im Board-Reiter Filter nach Kategorie (agents|skills|knowledge) und Art (retro|train). Mehrfachauswahl konsistent zum Board-View-Muster.

### V6 — gh-Schritt entfernen (agent-flow)
In agents/retro.md, agents/train.md, skills/retro, skills/train den best-effort-Schreibschritt auf GitHub-Project #5 entfernen; `LEARNINGS.md` als alleinige Karten-Quelle dokumentieren.

### V7 — Board #5 archivieren (Ops)
`gh project close 5 --owner Studis-Softwareschmiede` (archivieren, nicht löschen); Rückfall `--undo` dokumentiert. Erst NACHDEM V1–V3 stehen und verifiziert sind.

## Acceptance-Kriterien

- **AC1** — `RetroReader.getPromotionCards()` parst `LEARNINGS.md`, liefert je Eintrag Karte mit id/datum/ziel/regel/quelle/pr/status + abgeleiteter art (retro|train) + kategorie (agents|skills|knowledge), gruppiert nach status; fehlende Datei → leeres Ergebnis, kein Crash. *(V1)*
- **AC2** — `GET /api/retro/cards` liefert die Karten gruppiert nach Status (read-only, hinter accessGuard); leere/fehlende Quelle → valide leere Antwort. *(V2)*
- **AC3** — RetroView hat einen Reiter „Verbesserungs-Board" mit Kanban-Spalten je Status; bestehende Lauf-Ansicht bleibt unverändert erreichbar. *(V3)*
- **AC4** — Je Karte werden Regel-ID, Ziel, Art-Badge, Status-Badge und PR-Link gezeigt; vorhandene Kennzahlen aus baseline.json eingeblendet. *(V4)*
- **AC5** — Board-Reiter bietet Filter nach Kategorie + Art (Mehrfachauswahl). *(V5)*
- **AC6** — retro/train (agent-flow) schreiben nicht mehr auf GitHub-Project #5; LEARNINGS.md ist alleinige Quelle; Doku nachgezogen. *(V6)*
- **AC7** — Board #5 ist archiviert (nicht gelöscht); Rückfall dokumentiert; erst nach Verifikation der lokalen Anzeige. *(V7)*

## Nicht-Ziele
- Schreibpfad aus der GUI (Karten bleiben read-only; retro/train pflegen sie via PR).
- Neues Karten-Dateiformat (LEARNINGS.md bleibt Quelle).
- Änderung des Promotion-Lebenszyklus selbst (nur Anzeige).

## Abhängigkeiten
- agent-flow: `LEARNINGS.md`, `.claude/metrics/baseline.json`, agents/retro.md + train.md.
- dev-gui: `src/RetroReader.js`, `src/retroRouter.js`, `client/src/RetroView.jsx`, `client/src/RetroTrendView.jsx` (Muster).
