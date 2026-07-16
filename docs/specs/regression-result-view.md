---
id: regression-result-view
title: Regressions-Ergebnis-Ansicht je Projekt — Lauf-Liste, grün/rot-Trend, Drilldown, Debug-Artefakte (Screenshot-Galerie/Trace-Viewer/Video) bei jedem Lauf
status: active
area: fabrik-arbeiten
version: 2
spec_format: use-case-2.0
---

# Spec: Regressions-Ergebnis-Ansicht  (`regression-result-view`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Je Projekt zeigt eine Ergebnis-Ansicht die letzten Regressionsläufe (Datum, Suite, grün/rot, Dauer, Testfall-Zähler), einen einfachen grün/rot-Trend je Suite, einen Drilldown in die Testfälle eines Laufs und — für **jeden** Lauf, dessen Artefakt-Ablage noch vorhanden ist (S-328, unabhängig von grün/rot) — Zugriff auf die Debug-Artefakte: eine inline Screenshot-Galerie je Testfall, einen Trace-Viewer-Zugang über den eingebetteten Playwright-HTML-Report sowie ein Video je Testfall, sofern vorhanden. Die Ansicht ist rein lesend und speist sich aus dem Ergebnis-Store ([[regression-result-store]]).

## Kontext / Designnuancen (bindend)
- **Read-only:** die Ansicht mutiert nichts; sie konsumiert die Read-API des Stores.
- **Lauf-Liste je Projekt:** die letzten Läufe (jüngste zuerst) mit Datum, Suite/Scope, grün/rot, Dauer, Testfall-Zähler (`passed/total`).
- **Einfacher grün/rot-Trend je Suite:** eine kompakte Abfolge der letzten Läufe je Suite (grün/rot), keine aufwendige Statistik — nur die Trend-Sicht „läuft die Suite zuletzt grün oder rot?".
- **Drilldown:** ein Lauf öffnet die Testfall-Liste (aus dem CTRF-JSON): je Testfall Name + grün/rot (+ Fehlermeldung bei Rot).
- **Debug-Artefakt-Zugriff bei jedem Lauf (S-328):** seit S-327 kopiert der Store die Artefakte je Lauf in eine eigene, größenbegrenzte Ablage (Artefakt-Retention, [[regression-result-store]] AC3) — unabhängig von grün/rot. Der `htmlReport`-Teil (Playwright-HTML-Report) und der `testResults`-Teil (enthält die CTRF-Attachment-Dateien: Screenshots/Videos) werden Store-seitig **unabhängig voneinander** kopiert (zwei separate, je für sich best-effort scheiternde Vorgänge) — ein Teilzustand mit nur EINEM der beiden ist möglich (z.B. ein abgebrochener/getimeouteter Lauf hat `testResults`, aber der erst am Lauf-Ende geschriebene `htmlReport` fehlt noch). Die Ansicht behandelt beide Teile deshalb **getrennt**, solange der jeweilige Teil noch existiert:
  - eine **Screenshot-Galerie**: je Testfall werden dessen `image/*`-Attachments (aus `ctrf.results.tests[].attachments`) inline als Bild angezeigt, mit sinnvollem Alt-Text (Testfallname + „Screenshot") — abhängig vom `testResults`-Teil.
  - ein **Video** je Testfall (`video/webm`-Attachment), sofern vorhanden (typischerweise nur bei Rot, s. [[regression-result-store]]) — ebenfalls abhängig vom `testResults`-Teil.
  - einen **Trace-Viewer-Zugang** über den mitgelieferten Playwright-HTML-Report (`.../artifacts/playwright-report/index.html`), der einen eingebauten Trace-Viewer enthält — abhängig vom `htmlReport`-Teil. Bewusst **nicht** der öffentliche `https://trace.playwright.dev/?trace=<URL>`-Viewer: dieser lädt die `trace.zip` selbst per Client-seitigem Fetch — hinter Cloudflare Access ist die Artefakt-URL für ihn nicht erreichbar (Access-Redirect/CORS), der Link wäre tot. Der HTML-Report kommt aus derselben, access-geschützten Ablage und funktioniert deshalb ohne Sonderweg.
  - Fehlt der `testResults`-Teil (z.B. grüner Lauf ohne Artefakt-Kopie, durch die Artefakt-Retention geprunt, oder der o.g. Teilzustand), zeigt die Ansicht **keine tote Galerie**, sondern — nur wenn mindestens ein Testfall überhaupt Attachments referenziert — einen verständlichen Hinweis (z.B. „Screenshots/Video nicht mehr vorhanden."). Fehlt (nur) der `htmlReport`-Teil, entfällt lediglich der Trace-Viewer-Link, unabhängig von der Galerie.
- **Icon + Text + Farbe** für grün/rot (nie Farbe allein, WCAG 2.1 AA) — konsistent zur Karten-Statuszeile ([[regression-panel]] D9).
- **Nicht-ausgeführte Läufe sichtbar machen (S-326):** ein Frühausfall-Datensatz ([[regression-result-store]] AC1b, `status: "precondition-error"|"error"`) ist **kein roter Testlauf**, sondern ein Lauf, der gar nicht erst ausgeführt wurde. Die Ansicht stellt ihn als **dritten, eigenen Zustand** dar („nicht ausgeführt", Icon ⚠ + Text + Farbe) und zeigt sein `reason` als Fehlgrund — genau dafür existiert der Datensatz. Ihn als grün oder als rot darzustellen wäre in beide Richtungen falsch (grün: verschweigt den Fehler; rot: behauptet eine Test-Regression, die nie gemessen wurde). Frühausfall-Läufe haben kein CTRF und damit keine Artefakte (unverändert).

## Main Success Scenario
1. Owner öffnet die Regressions-Ergebnis-Ansicht eines Projekts.
2. Die Ansicht listet die letzten Läufe (jüngste zuerst) mit Datum, Suite, grün/rot, Dauer, Testfall-Zähler.
3. Je Suite zeigt sie einen einfachen grün/rot-Trend (Abfolge der letzten Läufe dieser Suite).
4. Klick auf einen Lauf öffnet den Drilldown: die Testfälle des Laufs (Name + grün/rot + Fehlermeldung bei Rot).
5. Ist die Artefakt-Ablage des Laufs noch vorhanden (unabhängig von grün/rot), sind die Debug-Artefakte zugänglich: Screenshot-Galerie inline je Testfall und ein Video je Testfall, sofern vorhanden (beide abhängig vom `testResults`-Teil der Ablage), sowie ein Trace-Viewer-Zugang über den eingebetteten HTML-Report (abhängig vom `htmlReport`-Teil, unabhängig von den beiden anderen). Fehlt ein Teil der Ablage, zeigt die Ansicht statt eines toten Links/einer toten Galerie einen verständlichen Hinweis.

## Acceptance-Kriterien

### Read-API (Backend)
- **AC1** — `GET /api/projects/:slug/regression-runs` liefert die Lauf-Liste des Projekts (jüngste zuerst) mit `{ runId, suite, scopeTyp, status, startedAt, durationMs, counts }`; `GET /api/projects/:slug/regression-runs/:runId` liefert den Einzel-Lauf inkl. Testfall-Details aus dem CTRF-JSON. Beide read-only, hinter Access.
- **AC2** (S-328) — Debug-Artefakt-Zugriff (HTML-Report inkl. eingebettetem Trace-Viewer, Screenshots, ggf. Video) ist für **jeden** Lauf verfügbar, dessen Artefakt-Ablage noch vorhanden ist — **unabhängig von grün/rot**. `htmlReport`- und `testResults`-Teil der Ablage werden [[regression-result-store]]-seitig **unabhängig voneinander** aufbewahrt (separate Kopiervorgänge, AC3) — ein Attachment-Zugriff (z.B. ein Screenshot unter `test-results/…`) ist deshalb bereits verfügbar, wenn NUR `testResults` referenziert ist (auch ohne `htmlReport`); der HTML-Report-Index selbst braucht spezifisch `htmlReport`. Ist WEDER `htmlReport` NOCH `testResults` referenziert (unbekannter Lauf, grüner Lauf ohne Artefakt-Kopie, oder durch die Artefakt-Retention komplett geprunt, [[regression-result-store]] AC3), liefert der Endpunkt 404 (kein Leak, kein toter Link). Der Artefakt-Endpunkt liegt hinter Access und dient die Artefakte pfad-confined (kein Traversal aus der Ablage heraus).

### Ansicht (Frontend)
- **AC3** — Die Ansicht zeigt je Projekt die Lauf-Liste (Datum, Suite, grün/rot, Dauer, Testfall-Zähler `passed/total`), jüngste zuerst; grün/rot mit Icon + Text + Farbe (nie Farbe allein).
- **AC4** — Je Suite wird ein **einfacher grün/rot-Trend** dargestellt (Abfolge der letzten Läufe dieser Suite).
- **AC5** — **Drilldown:** Klick auf einen Lauf zeigt dessen Testfälle (Name + grün/rot + Fehlermeldung bei Rot) aus dem CTRF-JSON.
- **AC6** (S-328) — Für jeden Lauf mit vorhandener Artefakt-Ablage (unabhängig von grün/rot) zeigt die Ansicht: eine **Screenshot-Galerie** (je Testfall dessen `image/*`-Attachments inline als `<img>`, mit Alt-Text aus Testfallname + „Screenshot") und ein **Video** je Testfall (`video/webm`-Attachment), sofern vorhanden — beide gated auf das Vorhandensein von `testResults` (NICHT `htmlReport`, s. AC2). Zusätzlich, gated auf `htmlReport` (unabhängig von `testResults`): ein **Trace-Viewer-Zugang** über den Link auf den eingebetteten Playwright-HTML-Report (`.../artifacts/playwright-report/index.html`, NICHT der öffentliche `trace.playwright.dev`-Viewer — Begründung s. Kontext). Die beiden Gates sind **unabhängig**: fehlt nur `testResults`, zeigt die Ansicht keine Galerie/kein Video (Hinweis statt totem `<img>`), der Report-Link bleibt trotzdem sichtbar, sofern `htmlReport` vorhanden ist — und umgekehrt. Fehlt `testResults`, aber mindestens ein Testfall referenziert Attachments, zeigt die Ansicht statt eines toten `<img>` einen verständlichen Hinweis (z.B. „Screenshots/Video nicht mehr vorhanden.").
- **AC7** — **Frühausfall-Darstellung (S-326):** ein Lauf mit `status: "precondition-error"|"error"` wird in der Lauf-Liste **und** im Drilldown als eigener Zustand „⚠ Nicht ausgeführt" (Icon + Text + Farbe) gezeigt — **nicht** als grün und **nicht** als rot; sein `reason` erscheint als Fehlgrund-Text (Drilldown mit `role="alert"`). Fehlt `reason`, steht dort ein generischer Hinweis. Kein Artefakt-Zugriff (Frühausfall-Läufe haben nie eine Artefakt-Ablage — Playwright lief nie, s. Kontext/[[regression-result-store]]), keine Testfall-Liste (es gibt kein CTRF) — statt „Keine Testfälle im Ergebnis" erscheint der Fehlgrund. Im Suite-Trend (AC4) zählt er als eigenes ⚠-Zeichen, **nie** als ✓.

## Verträge
- Konsumiert die Read-API aus [[regression-result-store]] (`GET …/regression-runs`, `GET …/regression-runs/:runId`).
- **Artefakt-Zugriff:** `GET /api/projects/:slug/regression-runs/:runId/artifacts/*` — für jeden Lauf mit vorhandener Artefakt-Ablage (S-328, unabhängig von grün/rot), pfad-confined auf die Artefakt-Ablage des Laufs (kein Path-Traversal/Symlink-Ausbruch), hinter Access.
- Keine Mutations-Endpunkte (Ansicht ist read-only).

## Edge-Cases & Fehlerverhalten
- Keine Läufe für ein Projekt → leere Liste mit Hinweis „Noch kein Regressionstest gelaufen." (kein Fehler).
- Artefakt-Zugriff auf einen Lauf ohne (mehr) vorhandene Artefakt-Ablage (unbekannter Lauf, grüner Lauf ohne Artefakt-Kopie, oder durch die Artefakt-Retention geprunt — S-328: das wird durch die neue Artefakt-Retention (10, [[regression-result-store]] AC3) zum Regelfall für ältere Läufe) → 404 (kein Artefakt), kein Leak — die Ansicht zeigt statt eines toten Links einen verständlichen Hinweis.
- Lauf mit nur EINEM Ablage-Teil (`testResults` ohne `htmlReport`, z.B. durch einen abgebrochenen/getimeouteten Lauf, s. Kontext) → Screenshot-Galerie/Video bleiben zugänglich, der Trace-Viewer-Link entfällt (kein toter Link) — und umgekehrt bei nur `htmlReport` ohne `testResults`.
- CTRF-Details eines Laufs unlesbar/teilweise → Lauf erscheint in der Liste, Drilldown zeigt eine degradierte Meldung statt Crash.
- Frühausfall-Lauf ohne `reason` → „⚠ Nicht ausgeführt" + generischer Hinweis „Kein Fehlgrund hinterlegt." (kein Crash, kein leerer Drilldown).
- Suite hat **ausschliesslich** Frühausfall-Läufe → Trend zeigt eine reine ⚠-Kette (weder grün noch rot suggeriert).
- Suite mit nur einem Lauf → Trend zeigt genau diesen einen Zustand.

## NFRs
- **A11y:** grün/rot nie allein über Farbe (Icon + Text), WCAG 2.1 AA — konsistent zu [[regression-panel]] D9. Screenshots (S-328) tragen einen sinnvollen Alt-Text (Testfallname + „Screenshot").
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
