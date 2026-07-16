---
id: regression-panel
title: Regressionstests-Karte im Fabrik-„Arbeiten"-Reiter (zwei Buttons + Inline-Status)
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Regressionstests-Karte im Fabrik-Panel  (`regression-panel`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).
>
> **Design-Bindung:** die visuelle Ausgestaltung ist in `docs/design.md`, Sektion „Fabrik-Panel Regressionstests" (D1–D16), **bindend** festgelegt (Owner-Ko-Design 2026-07-03). Diese Spec übernimmt die D-Vorgaben 1:1 als testbare Kriterien und ergänzt das Verhalten (Klick-Ziele, Sperr-/Status-Logik). Bei Konflikt gilt die Design-Sektion für alle rein visuellen Fragen.

## Zweck
Der Fabrik-„Arbeiten"-Reiter (`CockpitView.jsx`, `actionGrid`) bekommt je Projekt einen eigenen, gestalteten Bereich **„Regressionstests"** mit genau zwei Buttons untereinander — oben „Regressionstest ausführen" (primär), darunter „Regressionstest definieren" (sekundär) — plus eine Inline-Statuszeile zum letzten Lauf. Die Karte ist der Einstieg in die beiden Regressions-Dialoge ([[regression-run]] / [[regression-define-dialog]]) und spiegelt den letzten Lauf-Zustand ([[regression-result-store]]).

## Verhalten
1. Im `actionGrid` erscheint eine neue Karte „Regressionstests" als **fünftes** Flex-Item, direkt nach „Neue Story" und vor `TriggerPanel`/Status-Dashboard (Design D1). Rahmen/Kopf/Kurzbeschreibung folgen exakt den bestehenden `flowTriggerBox`/`flowTriggerHeader`/`flowTriggerHint`-Tokens (D2–D4) — keine neuen Farbwerte (D15).
2. Zwei Buttons untereinander (D5): „Regressionstest ausführen" primär (`btnFlowTrigger`-Token, D6), „Regressionstest definieren" sekundär (Outline-Familie `btnCancel`/`btnFlowReset`, D7). Visuelle Hierarchie nur über Fläche + Fettdruck (D8).
3. Klick auf „Regressionstest ausführen" öffnet den Ausführen-Dialog ([[regression-run]]); Klick auf „Regressionstest definieren" öffnet den Definier-Dialog ([[regression-define-dialog]]).
4. Unter den Buttons steht eine Inline-Statuszeile zum **letzten** Lauf des Projekts (D9/D9a): „Noch kein Regressionstest gelaufen." / „⏳ Regressionstest läuft…" / „✓ Erfolgreich — `<Zeitstempel>`" / „✗ Fehlgeschlagen — `<Zeitstempel>`" / „⚠ Nicht ausgeführt — `<Zeitstempel>`" (Lauf vor der Testausführung gescheitert, S-326). Icon + Text + Farbe immer gemeinsam (nie Farbe allein, WCAG 2.1 AA). Zeitstempel-Format `toLocaleString('de-DE', {dateStyle:'short', timeStyle:'medium'})` (D10).
5. Während eines aktiven Regressionstest-Laufs ist **ausschließlich** „Regressionstest ausführen" gesperrt (Disabled-Token + `lockNotice`-Hinweis „Ein Regressionstest läuft — Ausführen gesperrt."); „Regressionstest definieren" bleibt bedienbar (D11).
6. Der Lauf-Zustand der Statuszeile wird aus dem Ergebnis-Store/Lauf-Status gespeist ([[regression-result-store]] / [[regression-run]]); die konkrete Quelle (Polling des Lauf-Status, SSE, lokaler State) ist Implementierungssache, das beobachtbare Verhalten (Tabelle D9 + D11) ist bindend.

## Acceptance-Kriterien

### Platzierung & Gestaltung (Design-Bindung)
- **AC1** — Die Karte „Regressionstests" rendert im `actionGrid` an Position 5 (nach „Neue Story", vor `TriggerPanel`/Status-Dashboard); Rahmen/Kopf/Kurzbeschreibung nutzen die bestehenden `flowTriggerBox`/`flowTriggerHeader`/`flowTriggerHint`-Tokens (D1–D4). Keine neuen Farb-Hex-Werte (D15, Grep-prüfbar gegen die in D15 gelistete Palette).
- **AC2** — Genau zwei Buttons untereinander (`gap:8`, volle Kartenbreite), feste Reihenfolge „ausführen" (primär, `btnFlowTrigger`) → „definieren" (sekundär, Outline `btnCancel`/`btnFlowReset`); Hierarchie nur über Fläche + Fettdruck (D5–D8).

### Klick-Ziele & Sperr-/Status-Logik
- **AC3** — „Regressionstest ausführen" öffnet den Ausführen-Dialog ([[regression-run]]); „Regressionstest definieren" öffnet den Definier-Dialog ([[regression-define-dialog]]).
- **AC4** — Die Inline-Statuszeile bildet die fünf Zustände „kein Lauf" / „läuft" / „erfolgreich + Zeitstempel" / „fehlgeschlagen + Zeitstempel" / **„nicht ausgeführt + Zeitstempel"** (S-326, D9a) mit den D9/D9a-Tokens ab; Icon + Text + Farbe stets gemeinsam; Zeitstempel-Format wie D10.
- **AC4b** (S-326) — Ein letzter Lauf mit `status: "precondition-error"|"error"` ([[regression-result-store]] AC1b) zeigt „⚠ Nicht ausgeführt — `<Zeitstempel>`" (D9a) — **nicht** „Noch kein Regressionstest gelaufen.". Die Karte darf einen terminalen Lauf-Zustand des Stores **nie** auf „kein Lauf" abbilden: genau das liess einen gescheiterten Lauf spurlos verschwinden (verifizierter Befund 2026-07-08).
- **AC5** — Während eines aktiven Laufs ist **nur** der „ausführen"-Button gesperrt (Disabled-Token + `lockNotice`-Hinweis mit dem Wortlaut aus D11); „definieren" bleibt bedienbar (D11).

### Accessibility (WCAG 2.1 AA, Design-Bindung)
- **AC6** — Beide Buttons sind natives `<button type="button">`, `minHeight:44` bei voller Kartenbreite, Fokusring nicht entfernt, Tab-Reihenfolge = visuelle Reihenfolge; aria-labels (inkl. Gesperrt-Variante) exakt wie Design-Abschnitt 4 / D13. Statusfarbe nie alleinige Bedeutung (D9/AC4).
- **AC7** — `data-testid`-Konvention (kebab-case, Präfix `regression-`, D16): `regression-card`, `regression-run-btn`, `regression-define-btn`, `regression-status` sind gesetzt.

## Verträge
- Reine Frontend-Erweiterung von `CockpitView.jsx`/`actionGrid`; **keine** neuen Backend-Endpunkte in dieser Spec. Der Lauf-Status wird über die in [[regression-run]]/[[regression-result-store]] definierten Read-Endpunkte bezogen.
- Style-Tokens werden **wiederverwendet** (kein neuer Token), Bezugsquelle `CockpitView.jsx`/`TriggerPanel.jsx` gemäß D2–D15.

## Edge-Cases & Fehlerverhalten
- Ergebnis-Store liefert (noch) keinen Lauf → Zustand „Noch kein Regressionstest gelaufen." (kein Fehler, kein `role`).
- Lauf-Status-Quelle nicht erreichbar → letzter bekannter Zustand bleibt stehen bzw. „kein Lauf"; kein Karten-Crash.
- Schmaler Viewport (< ~768 px) → Karte umbricht identisch zu den Nachbarkarten (keine neue Breakpoint-Logik, D-Layout).

## NFRs
- **A11y:** WCAG 2.1 AA (Touch-Targets ≥ 44 px, Kontraste ≥ 4.5:1 Text / ≥ 3:1 Fokusring, Farbe nie allein) — alle Werte aus der Design-Sektion, dort geprüft.
- **Konsistenz:** ausschließlich bestehende Tokens; `reviewer` prüft die Design-Konformität (D1–D16).

## Nicht-Ziele
- Die Dialoge selbst (Ausführen: [[regression-run]]; Definieren: [[regression-define-dialog]]).
- Ergebnis-Ansicht/Drilldown ([[regression-result-view]]).
- Die Benachrichtigung bei rotem Lauf ([[regression-failed-notification]]).

## Abhängigkeiten
- `docs/design.md` — Sektion „Fabrik-Panel Regressionstests" (D1–D16, bindend).
- [[regression-run]] · [[regression-define-dialog]] — Klick-Ziele.
- [[regression-result-store]] — Quelle des letzten Lauf-Zustands.
- Bestehendes `CockpitView.jsx`/`actionGrid` (Design-Sektion „„Arbeiten"-Layout").
