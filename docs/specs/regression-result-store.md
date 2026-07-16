---
id: regression-result-store
title: Regressions-Ergebnis-Store — CTRF-JSON je Lauf, Retention 50, Debug-Artefakte nur bei Rot, Auto-Prune
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Regressions-Ergebnis-Store  (`regression-result-store`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Jeder Regressionslauf legt sein **CTRF-JSON-Ergebnis** in einer kleinen, betreiber-nahen dev-gui-Datenablage ab (Muster `DrainReportStore`) — **nicht** im Projekt-Git. Je Projekt werden die letzten **50** Läufe behalten (Retention), Debug-Artefakte (HTML-Report/Traces) nur bei **roten** Läufen aufbewahrt, und überzählige Läufe/Artefakte werden automatisch geprunt. **Auch ein Lauf, der vor der Testausführung scheitert** (Frühausfall — kein CTRF vorhanden), legt einen Datensatz ab; er trägt seinen Fehlgrund statt eines CTRF-Ergebnisses. Der Store ist die Quelle der Ergebnis-Ansicht ([[regression-result-view]]) und des letzten Lauf-Zustands in der Karte ([[regression-panel]]).

## Kontext / Designnuancen (bindend)
- **Ablage-Muster `DrainReportStore`:** datei-basiert unter `${CRED_STORE_DIR}` (Betreiber-nahe Beobachtbarkeits-Ablage, ADR-005-Linie — **kein** Fabrik-/Domänen-State, kein neuer Store-Typ), atomarer tmp+rename-Schreibzugriff, `0600`; ohne `CRED_STORE_DIR` In-Memory-Degradation (kein Crash).
- **CTRF-JSON je Lauf:** das vom Runner ([[regression-run]]) erzeugte CTRF-Ergebnis wird 1:1 als Lauf-Datensatz abgelegt (plus Metadaten: Datum, Projekt, Suite/Scope, grün/rot, Dauer, Testfall-Zähler).
- **Frühausfall-Datensatz (S-326, kein CTRF vorhanden):** ein Lauf, der **vor oder ohne** Testausführung endet (Vorbedingung nicht erfüllt, Rollout-Fehler, Runner-Fehler, Timeout, kein CTRF-Ergebnis, nicht unterstütztes Testobjekt — s. [[regression-run]] AC10), wird **ebenso** als Datensatz abgelegt. Er trägt `status: "precondition-error"|"error"`, `ctrf: null` (**kein synthetisches CTRF** — ein erfundenes Testergebnis würde eine Ausführung vortäuschen, die nie stattfand), `counts: {passed:0,failed:0,total:0}` und ein **`reason`** mit einer secret-freien Kurzbegründung. Ohne diesen Datensatz bliebe der Fehlgrund nur im flüchtigen In-Memory-Lauf-Status und wäre verloren, sobald der Dialog schließt — die GUI zeigte dann „nichts" (verifizierter Befund 2026-07-08).
- **Status = terminaler Lauf-Zustand des Runners:** die vier Status-Werte sind identisch mit den terminalen Zuständen des `GET …/regression-run/:runId`-Vertrags ([[regression-run]] §Verträge) — `passed | failed | precondition-error | error`. Kein zweites, abweichendes Status-Vokabular (`running` ist nicht-terminal und erreicht den Store nie).
- **Retention 50 je Projekt:** pro Projekt werden höchstens die **50 jüngsten** Läufe behalten; ältere werden geprunt (inkl. ihrer Artefakte).
- **Debug-Artefakte nur bei Rot:** HTML-Report/Traces eines Laufs werden **nur** aufbewahrt, wenn der Lauf rot war; grüne Läufe behalten nur das CTRF-JSON + Metadaten (keine schweren Artefakte).
- **Auto-Prune:** beim Ablegen eines neuen Laufs werden je Projekt Läufe jenseits der 50 **und** verwaiste/grün-gewordene Artefakte automatisch entfernt (idempotent).
- **NICHT im Projekt-Git:** die Ablage liegt in der dev-gui-Datenablage, nie im geklonten Projekt-Repo (`test-results/`/`playwright-report/` des Projekts sind ohnehin gitignored, agent-flow `regression-playwright-conventions` AC6).

## Main Success Scenario
1. Ein Lauf endet ([[regression-run]]); der Runner übergibt CTRF-JSON + Metadaten (Suite/Scope, grün/rot, Dauer, Zähler) + (bei Rot) den Pfad zu HTML-Report/Traces.
2. Der Store legt einen neuen Lauf-Datensatz je Projekt an (atomar).
3. War der Lauf **grün**, werden keine Debug-Artefakte aufbewahrt; war er **rot**, werden HTML-Report/Traces beim Lauf-Datensatz hinterlegt.
4. Auto-Prune entfernt je Projekt Läufe jenseits der 50 jüngsten (inkl. deren Artefakte).
5. Die Datensätze sind read-only abrufbar (Liste + Einzel-Lauf) für [[regression-result-view]]/[[regression-panel]].

## Alternative Flows
- **A1 — Frühausfall (kein CTRF, S-326):** ein Lauf endet **ohne** Testausführung ([[regression-run]] AC10). Der Runner übergibt denselben Metadaten-Satz, aber `status: "precondition-error"|"error"`, `ctrf: null`, `counts: {0,0,0}` und ein `reason`. Der Store legt ihn wie jeden anderen Datensatz ab (Schritt 2, 4, 5 identisch); Debug-Artefakte gibt es keine (Schritt 3 entfällt — `artifacts` bleibt `failed`-exklusiv, AC3).

## Acceptance-Kriterien
- **AC1** — Je Lauf wird ein Datensatz mit dem **CTRF-JSON** + Metadaten `{ runId, projekt, suite, scopeTyp, status: "passed"|"failed"|"precondition-error"|"error", startedAt, durationMs, counts:{passed,failed,total}, reason? }` abgelegt; die Ablage folgt dem `DrainReportStore`-Muster (datei-basiert unter `${CRED_STORE_DIR}`, atomar tmp+rename, `0600`; ohne `CRED_STORE_DIR` In-Memory-Degradation). **Nicht** im Projekt-Git.
- **AC1b** — **Frühausfall-Datensatz (S-326):** bei `status: "precondition-error"|"error"` wird der Datensatz **ohne** CTRF abgelegt (`ctrf: null`, **kein** synthetisches Ersatz-CTRF) und trägt ein **`reason`** mit einer secret-freien Kurzbegründung des Fehlgrunds; `counts` ist `{passed:0,failed:0,total:0}`. Ein solcher Datensatz durchläuft Retention/Prune/Read-API **identisch** zu einem `passed`/`failed`-Lauf (kein Sonderweg, kein zweiter Store). Bei `status: "passed"|"failed"` ist `reason` **abwesend**.
- **AC2** — **Retention:** pro Projekt werden höchstens die **50 jüngsten** Läufe behalten; beim Ablegen eines neuen Laufs werden ältere je Projekt automatisch geprunt (Auto-Prune, idempotent).
- **AC3** — **Debug-Artefakte nur bei Rot:** HTML-Report/Traces werden **nur** für Läufe mit `status: "failed"` aufbewahrt; bei `status: "passed"|"precondition-error"|"error"` werden keine schweren Artefakte gehalten (nur CTRF-JSON bzw. `reason` + Metadaten). Wird ein Lauf geprunt, werden seine Artefakte mitentfernt (keine verwaisten Artefakte).
- **AC4** — Read-only Zugriff: der Store liefert je Projekt die Lauf-Liste (jüngste zuerst) und einen Einzel-Lauf inkl. Testfall-Details (aus dem CTRF-JSON) sowie — bei roten Läufen — die Referenz auf die Debug-Artefakte. Bei einem Frühausfall-Datensatz (AC1b) liefert er statt der Testfall-Details das `reason`.
- **AC5** — Keine Secrets/Tokens in abgelegten Datensätzen/Metadaten/Log — **einschliesslich `reason`** (Kurztext aus einer festen Meldungs-Menge des Runners, **nie** roher Fehler-/Prozess-Output, nie ein Pfad/Token/Kommandozeilen-Fragment); das CTRF-JSON wird unverändert übernommen (der Runner stellt sicher, dass keine Secrets in die Artefakte gelangen, agent-flow `regression-runner` AC9).

## Verträge
- **Datensatz-Schema:** `{ runId, projekt, suite, scopeTyp: "bereich"|"verbund"|"gesamt", status: "passed"|"failed"|"precondition-error"|"error", startedAt, durationMs, counts:{passed,failed,total}, ctrf: <CTRF-JSON>|null, reason?: string, artifacts?: { htmlReport, traces } }` — `artifacts` nur bei `failed`; `ctrf: null` + `reason` gesetzt genau bei `precondition-error`/`error` (AC1b).
- **Ablage:** `${CRED_STORE_DIR}/regression-runs/<projekt>/…` (Muster `DrainReportStore`); atomarer Schreibzugriff, `0600`.
- **Read-API (konsumiert von [[regression-result-view]]):** `GET /api/projects/:slug/regression-runs` (Liste, jüngste zuerst) · `GET /api/projects/:slug/regression-runs/:runId` (Einzel-Lauf inkl. Testfälle) · Artefakt-Zugriff nur bei roten Läufen (s. [[regression-result-view]]).

## Edge-Cases & Fehlerverhalten
- `CRED_STORE_DIR` nicht gesetzt → In-Memory-Degradation (Läufe überleben Neustart nicht), kein Crash.
- Artefakte fehlen bei einem roten Lauf (Runner lieferte keine) → Datensatz ohne `artifacts`, kein Fehler.
- Frühausfall-Datensatz ohne `reason` (Runner lieferte keinen) → Datensatz wird abgelegt, `reason` fehlt; die Ansicht zeigt einen generischen Fehl-Hinweis (kein Crash, kein stiller Verlust des Datensatzes).
- Unbekannter/ungültiger `status` (weder `passed`/`failed`/`precondition-error`/`error`) → **Ablehnung** durch den Store (der Runner ist der einzige Produzent und liefert ausschliesslich terminale Zustände); das Vokabular bleibt geschlossen.
- Gleichzeitiges Ablegen zweier Läufe verschiedener Projekte → getrennte Projekt-Buckets, keine Kollision; atomarer Schreibzugriff verhindert Teilzustände.
- Korruptes/teilweises Datei-Set beim Laden → betroffener Datensatz wird übersprungen (degradierend), Rest bleibt lesbar.

## NFRs
- **Größenbegrenzung (hart):** Retention 50 je Projekt + Artefakte nur bei Rot begrenzt den Plattenbedarf; Auto-Prune hält die Ablage klein (ADR-005-Linie: kleine betreiber-nahe Ablage, kein Domänen-State).
- **Sicherheit:** `0600`, keine Secrets in Datensätzen/Log; hinter Access (Read-API rollen-/access-geschützt wie die übrigen Beobachtbarkeits-Endpunkte).

## Nicht-Ziele
- Testausführung ([[regression-run]]) und Ansicht/Drilldown ([[regression-result-view]]).
- Persistenz im Projekt-Git (bewusst ausgeschlossen).
- Unbegrenzte Lauf-Historie / Langzeitarchiv.

## Abhängigkeiten
- [[regression-run]] (Produzent: CTRF + Artefakte) · [[regression-result-view]] (Konsument) · [[regression-panel]] (letzter Lauf-Zustand).
- `DrainReportStore` / `drain-completion-report` (Ablage-Muster) · ADR-020 (`DrainJobRegistry`-Persistenz-Muster).
- agent-flow `regression-playwright-conventions` (CTRF-Reporter-Format, gitignore-Pflicht).
