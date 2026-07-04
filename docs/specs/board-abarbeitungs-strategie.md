---
id: board-abarbeitungs-strategie
title: Board-Abarbeitungs-Strategie — Vorab-Analyse, Parallelität, Feature-Branches
status: draft
area: fabrik-arbeiten
version: 1
---

# Spec: Board-Abarbeitungs-Strategie  (`board-abarbeitungs-strategie`)

> **Konzept-only** (status: draft). Beschreibt, wie `/flow` ein Board mit mehreren Features/Stories **abarbeiten** soll. Umsetzung betrifft primär **agent-flow** (`/flow`, `skills/flow`, `agents/retro`), getrackt hier auf dem dev-gui-Board.
>
> **Zweck.** Vor dem Abarbeiten eines Board-Backlogs einen kurzen **Plan** erstellen: Konflikte erkennen, Parallelisierbarkeit bestimmen, Branch-Strategie wählen. Aus den Erfahrungen dieses Implementierungs-Laufs destilliert.

## Lösungsvorschlag / Aspekte

### 1. Vorab-Konflikt-/Überschneidungsanalyse (Owner-Punkt a)
Bevor Stories abgearbeitet werden, prüft `/flow`:
- **Hot-Spot-Dateien:** Berühren mehrere Stories dieselben zentralen Dateien (z.B. `AppShell`, Router, `BoardView`)? → diese Stories **serialisieren**, nicht parallel.
- **Heben sich auf / kommen in die Quere:** Widersprechen sich Stories (eine baut um, was die andere voraussetzt)? → Reihenfolge nach `depends` + logischer Schichtung (Backend vor Frontend, Shell vor Reiter).
- **depends-Graph:** topologische Reihenfolge; eine Story startet erst, wenn ihre `depends` Done sind ([[board-cli]] `board next`).
Ergebnis: ein **Abarbeitungsplan** (Reihenfolge + welche Gruppen seriell/parallel).

### 2. Parallel-Abarbeitbarkeit (Owner-Punkt b)
- Stories mit **disjunkten Dateien** (z.B. ein Backend-Reader + ein unabhängiger Frontend-Teil) laufen **parallel** in **isolierten git-Worktrees** (ein coder je Worktree).
- Stories, die **Hot-Spot-Dateien teilen**, laufen **seriell**.
- **Test-Isolation:** parallele Worktrees müssen aus Test-Auswahl UND Modul-Auflösung ausgeschlossen sein (sonst Cache-Vergiftung). Landen ist immer **seriell** (main ist die eine Senke; Rebase zwischen den PRs).

### 3. Feature-Branch-Strategie (Owner-Punkt c)
- **Je Feature ein Branch** (`feature/<F-###>`), die Stories des Features landen dort, am Ende **ein** Merge des Feature-Branches in `main`. Vorteil: ein zusammenhängendes Review/CI je Feature, weniger main-Churn.
- Alternative (heute praktiziert): je Story ein PR direkt in main — einfacher, aber mehr PRs. **Empfehlung: Feature-Branch ab ≥3 Stories/Feature.**

### 4. Weitere Aspekte (aus dem Lauf gelernt)
- **board-Status persistent:** `board set … Done` muss via PR in `main` landen (sonst bei `reset` verloren) — am besten **gebündelt** mit dem Story-Code-PR.
- **Image-Build/Deploy gebündelt** am Feature-Ende, nicht pro Story (CI + recreate sind teuer).
- **Cross-Repo:** Stories, deren Code in einem anderen Repo lebt (z.B. dev-gui-Anzeige vs. agent-flow-Logik), klar markieren; Spec liegt beim Subsystem, Tracking auf dem Board.
- **Review-Gate bei Parallelität nicht überspringen:** ein paralleler coder übersieht eher etwas (im Lauf: Path-Traversal gefangen) — gerade dann adversarial reviewen.

## Acceptance-Kriterien
- **AC1** — `/flow` erstellt vor dem Abarbeiten einen Plan: Hot-Spot-/Konflikt-/depends-Analyse → Reihenfolge + seriell/parallel-Gruppen. *(1)*
- **AC2** — Disjunkte Stories werden parallel (Worktree) abgearbeitet, Hot-Spot-teilende seriell; Landen immer seriell mit Rebase. *(2)*
- **AC3** — Feature-Branch-Option (je Feature ein Branch, ein Merge in main) ab Schwelle dokumentiert/umgesetzt. *(3)*
- **AC4** — board-Status-Done landet persistent (PR); Image-Deploy gebündelt am Feature-Ende; Cross-Repo-Markierung. *(4)*

## Nicht-Ziele
- Vollautomatischer Konflikt-Solver (heuristische Analyse genügt).

## Abhängigkeiten
- agent-flow: `skills/flow/SKILL.md`, `agents/retro.md`, [[board-cli]].
