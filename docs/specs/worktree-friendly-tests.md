---
id: worktree-friendly-tests
title: Worktree-freundliche Tests — Jest-Suite läuft sauber aus einem git-Worktree
status: draft
area: einstellungen
version: 1
---

# Worktree-freundliche Tests

> P2 aus der Retro 2026-07-21: die „Worktree-Steuer" senken. Parallele Sessions arbeiten in git-Worktrees unter
> `.claude/worktrees/`; die Jest-Suite ließ sich von dort bisher nicht ohne manuelle Flag-Bastelei ausführen. Feature: F-092.

## Kontext & Motivation

Zwei Reibungspunkte beim Testen aus einem Worktree:
1. **Jest ignoriert `.claude/worktrees/`** bewusst (`testPathIgnorePatterns` + `modulePathIgnorePatterns`, damit der
   Haupt-Gate keine fremden Worktree-Tests einsammelt) → `npm test` aus einem Worktree findet **0 Tests**.
2. **`routerLoader.test.js` legte Mock-Router-Temp-Verzeichnisse projekt-relativ** unter `test/.tmp-…` an. In einem
   Worktree enthält dieser Pfad `.claude/worktrees/`, worauf der routerLoader-**Sicherheits-Guard** (Produktionscode,
   verbietet Scan von `.claude/worktrees/` + `node_modules`) zu Recht anschlägt → **falsche** Test-Fehler.

## Akzeptanzkriterien

- **AC1 — routerLoader-Test kontext-unabhängig.** `test/routerLoader.test.js` legt seine Mock-Router-Temp-Verzeichnisse
  im **OS-tmpdir** an (statt projekt-relativ), mit einem eingelegten `package.json {"type":"module"}` (damit die
  `.js`-Router-Vorlagen weiterhin als ESM geladen werden). So schlägt der routerLoader-Guard **nie** fälschlich an —
  in JEDEM Kontext (Hauptordner ODER Worktree), ohne den Guard aufzuweichen.
- **AC2 — `npm run test:worktree`.** Ein neues Script fährt die volle Jest-Suite mit worktree-tauglichen Overrides:
  `.claude/worktrees/` NICHT ignoriert, `node_modules` + `tests/regression` (Playwright) weiter ignoriert,
  `--no-cache` + isolierter `cacheDirectory` (gegen Cache-Vergiftung zwischen Worktree + Hauptordner). Aus einem
  Worktree ausgeführt läuft die Suite grün (keine 0-Tests, keine Guard-Fehlalarme).
- **AC3 — Haupt-Gate unverändert.** `npm test` (der CI-/Haupt-Gate) bleibt **unangetastet** — es ignoriert
  `.claude/worktrees/` weiterhin (kein Einsammeln fremder Worktree-Tests). Nur das zusätzliche `test:worktree`-Script
  hebt die Worktree-Ignore für einen bewussten lokalen Lauf auf.
- **AC4 — Dokumentiert.** README nennt beide Wege (`npm test` = Haupt-Gate; `npm run test:worktree` = aus einem Worktree).

## Bewusst NICHT

- Kein Aufweichen des routerLoader-Sicherheits-Guards (er verbietet weiterhin `.claude/worktrees/`-Scans — nur der
  Test legt seine Temp-Dirs woanders an).
- Keine Änderung am Haupt-Gate `npm test` / an der CI.
