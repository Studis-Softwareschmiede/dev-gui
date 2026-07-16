---
id: regression-result-view
title: Regressions-Ergebnis-Ansicht je Projekt — Lauf-Liste, grün/rot-Trend, Drilldown, Debug-Artefakt-Zugriff
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Regressions-Ergebnis-Ansicht  (`regression-result-view`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Je Projekt zeigt eine Ergebnis-Ansicht die letzten Regressionsläufe (Datum, Suite, grün/rot, Dauer, Testfall-Zähler), einen einfachen grün/rot-Trend je Suite, einen Drilldown in die Testfälle eines Laufs und — bei roten Läufen — Zugriff auf die Debug-Artefakte (HTML-Report/Traces). Die Ansicht ist rein lesend und speist sich aus dem Ergebnis-Store ([[regression-result-store]]).

## Kontext / Designnuancen (bindend)
- **Read-only:** die Ansicht mutiert nichts; sie konsumiert die Read-API des Stores.
- **Lauf-Liste je Projekt:** die letzten Läufe (jüngste zuerst) mit Datum, Suite/Scope, grün/rot, Dauer, Testfall-Zähler (`passed/total`).
- **Einfacher grün/rot-Trend je Suite:** eine kompakte Abfolge der letzten Läufe je Suite (grün/rot), keine aufwendige Statistik — nur die Trend-Sicht „läuft die Suite zuletzt grün oder rot?".
- **Drilldown:** ein Lauf öffnet die Testfall-Liste (aus dem CTRF-JSON): je Testfall Name + grün/rot (+ Fehlermeldung bei Rot).
- **Debug-Artefakt-Zugriff nur bei Rot:** bei roten Läufen sind HTML-Report/Traces zugänglich; grüne Läufe haben keine Artefakte (nur CTRF-Details).
- **Icon + Text + Farbe** für grün/rot (nie Farbe allein, WCAG 2.1 AA) — konsistent zur Karten-Statuszeile ([[regression-panel]] D9).
- **Nicht-ausgeführte Läufe sichtbar machen (S-326):** ein Frühausfall-Datensatz ([[regression-result-store]] AC1b, `status: "precondition-error"|"error"`) ist **kein roter Testlauf**, sondern ein Lauf, der gar nicht erst ausgeführt wurde. Die Ansicht stellt ihn als **dritten, eigenen Zustand** dar („nicht ausgeführt", Icon ⚠ + Text + Farbe) und zeigt sein `reason` als Fehlgrund — genau dafür existiert der Datensatz. Ihn als grün oder als rot darzustellen wäre in beide Richtungen falsch (grün: verschweigt den Fehler; rot: behauptet eine Test-Regression, die nie gemessen wurde).

## Main Success Scenario
1. Owner öffnet die Regressions-Ergebnis-Ansicht eines Projekts.
2. Die Ansicht listet die letzten Läufe (jüngste zuerst) mit Datum, Suite, grün/rot, Dauer, Testfall-Zähler.
3. Je Suite zeigt sie einen einfachen grün/rot-Trend (Abfolge der letzten Läufe dieser Suite).
4. Klick auf einen Lauf öffnet den Drilldown: die Testfälle des Laufs (Name + grün/rot + Fehlermeldung bei Rot).
5. Bei einem roten Lauf sind die Debug-Artefakte (HTML-Report/Traces) zugänglich.

## Acceptance-Kriterien

### Read-API (Backend)
- **AC1** — `GET /api/projects/:slug/regression-runs` liefert die Lauf-Liste des Projekts (jüngste zuerst) mit `{ runId, suite, scopeTyp, status, startedAt, durationMs, counts }`; `GET /api/projects/:slug/regression-runs/:runId` liefert den Einzel-Lauf inkl. Testfall-Details aus dem CTRF-JSON. Beide read-only, hinter Access.
- **AC2** — Debug-Artefakt-Zugriff (HTML-Report/Traces) ist **nur** für rote Läufe verfügbar (bei grünen existieren keine Artefakte); der Artefakt-Endpunkt liegt hinter Access und dient die Artefakte pfad-confined (kein Traversal aus der Ablage heraus).

### Ansicht (Frontend)
- **AC3** — Die Ansicht zeigt je Projekt die Lauf-Liste (Datum, Suite, grün/rot, Dauer, Testfall-Zähler `passed/total`), jüngste zuerst; grün/rot mit Icon + Text + Farbe (nie Farbe allein).
- **AC4** — Je Suite wird ein **einfacher grün/rot-Trend** dargestellt (Abfolge der letzten Läufe dieser Suite).
- **AC5** — **Drilldown:** Klick auf einen Lauf zeigt dessen Testfälle (Name + grün/rot + Fehlermeldung bei Rot) aus dem CTRF-JSON.
- **AC6** — Bei roten Läufen sind die Debug-Artefakte (HTML-Report/Traces) aus der Ansicht heraus zugänglich; bei grünen Läufen gibt es keinen Artefakt-Zugriff (kein toter Link).
- **AC7** — **Frühausfall-Darstellung (S-326):** ein Lauf mit `status: "precondition-error"|"error"` wird in der Lauf-Liste **und** im Drilldown als eigener Zustand „⚠ Nicht ausgeführt" (Icon + Text + Farbe) gezeigt — **nicht** als grün und **nicht** als rot; sein `reason` erscheint als Fehlgrund-Text (Drilldown mit `role="alert"`). Fehlt `reason`, steht dort ein generischer Hinweis. Kein Artefakt-Zugriff (AC6 gilt nur für `failed`), keine Testfall-Liste (es gibt kein CTRF) — statt „Keine Testfälle im Ergebnis" erscheint der Fehlgrund. Im Suite-Trend (AC4) zählt er als eigenes ⚠-Zeichen, **nie** als ✓.

## Verträge
- Konsumiert die Read-API aus [[regression-result-store]] (`GET …/regression-runs`, `GET …/regression-runs/:runId`).
- **Artefakt-Zugriff:** `GET /api/projects/:slug/regression-runs/:runId/artifacts/*` — nur bei `status: "failed"`, pfad-confined auf die Artefakt-Ablage des Laufs (kein Path-Traversal/Symlink-Ausbruch), hinter Access.
- Keine Mutations-Endpunkte (Ansicht ist read-only).

## Edge-Cases & Fehlerverhalten
- Keine Läufe für ein Projekt → leere Liste mit Hinweis „Noch kein Regressionstest gelaufen." (kein Fehler).
- Artefakt-Zugriff auf einen grünen/gepruneten Lauf → 404 (kein Artefakt), kein Leak.
- CTRF-Details eines Laufs unlesbar/teilweise → Lauf erscheint in der Liste, Drilldown zeigt eine degradierte Meldung statt Crash.
- Frühausfall-Lauf ohne `reason` → „⚠ Nicht ausgeführt" + generischer Hinweis „Kein Fehlgrund hinterlegt." (kein Crash, kein leerer Drilldown).
- Suite hat **ausschliesslich** Frühausfall-Läufe → Trend zeigt eine reine ⚠-Kette (weder grün noch rot suggeriert).
- Suite mit nur einem Lauf → Trend zeigt genau diesen einen Zustand.

## NFRs
- **A11y:** grün/rot nie allein über Farbe (Icon + Text), WCAG 2.1 AA — konsistent zu [[regression-panel]] D9.
- **Sicherheit:** read-only, hinter Access; Artefakt-Auslieferung pfad-confined (kein Traversal), keine Secrets im CTRF/Artefakt-Stream.

## Nicht-Ziele
- Testausführung/Definition ([[regression-run]]/[[regression-define-dialog]]).
- Ablage/Retention/Prune selbst ([[regression-result-store]]).
- Aufwendige Langzeit-Statistik/Diagramme (nur einfacher grün/rot-Trend).
- Benachrichtigung bei Rot ([[regression-failed-notification]]).

## Abhängigkeiten
- [[regression-result-store]] (Datenquelle + Read-API/Artefakt-Ablage).
- [[regression-panel]] (konsistente grün/rot-Darstellung).
- [[access-and-guardrails]] (Access-Mauer für die Read-/Artefakt-Endpunkte).
