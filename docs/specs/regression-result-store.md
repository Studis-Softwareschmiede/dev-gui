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
Jeder Regressionslauf legt sein **CTRF-JSON-Ergebnis** in einer kleinen, betreiber-nahen dev-gui-Datenablage ab (Muster `DrainReportStore`) — **nicht** im Projekt-Git. Je Projekt werden die letzten **50** Läufe behalten (Retention), Debug-Artefakte (HTML-Report/Traces) nur bei **roten** Läufen aufbewahrt, und überzählige Läufe/Artefakte werden automatisch geprunt. Der Store ist die Quelle der Ergebnis-Ansicht ([[regression-result-view]]) und des letzten Lauf-Zustands in der Karte ([[regression-panel]]).

## Kontext / Designnuancen (bindend)
- **Ablage-Muster `DrainReportStore`:** datei-basiert unter `${CRED_STORE_DIR}` (Betreiber-nahe Beobachtbarkeits-Ablage, ADR-005-Linie — **kein** Fabrik-/Domänen-State, kein neuer Store-Typ), atomarer tmp+rename-Schreibzugriff, `0600`; ohne `CRED_STORE_DIR` In-Memory-Degradation (kein Crash).
- **CTRF-JSON je Lauf:** das vom Runner ([[regression-run]]) erzeugte CTRF-Ergebnis wird 1:1 als Lauf-Datensatz abgelegt (plus Metadaten: Datum, Projekt, Suite/Scope, grün/rot, Dauer, Testfall-Zähler).
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

## Acceptance-Kriterien
- **AC1** — Je Lauf wird ein Datensatz mit dem **CTRF-JSON** + Metadaten `{ runId, projekt, suite, scopeTyp, status: "passed"|"failed", startedAt, durationMs, counts:{passed,failed,total} }` abgelegt; die Ablage folgt dem `DrainReportStore`-Muster (datei-basiert unter `${CRED_STORE_DIR}`, atomar tmp+rename, `0600`; ohne `CRED_STORE_DIR` In-Memory-Degradation). **Nicht** im Projekt-Git.
- **AC2** — **Retention:** pro Projekt werden höchstens die **50 jüngsten** Läufe behalten; beim Ablegen eines neuen Laufs werden ältere je Projekt automatisch geprunt (Auto-Prune, idempotent).
- **AC3** — **Debug-Artefakte nur bei Rot:** HTML-Report/Traces werden **nur** für Läufe mit `status: "failed"` aufbewahrt; bei `status: "passed"` werden keine schweren Artefakte gehalten (nur CTRF-JSON + Metadaten). Wird ein Lauf geprunt, werden seine Artefakte mitentfernt (keine verwaisten Artefakte).
- **AC4** — Read-only Zugriff: der Store liefert je Projekt die Lauf-Liste (jüngste zuerst) und einen Einzel-Lauf inkl. Testfall-Details (aus dem CTRF-JSON) sowie — bei roten Läufen — die Referenz auf die Debug-Artefakte.
- **AC5** — Keine Secrets/Tokens in abgelegten Datensätzen/Metadaten/Log; das CTRF-JSON wird unverändert übernommen (der Runner stellt sicher, dass keine Secrets in die Artefakte gelangen, agent-flow `regression-runner` AC9).

## Verträge
- **Datensatz-Schema:** `{ runId, projekt, suite, scopeTyp: "bereich"|"verbund"|"gesamt", status, startedAt, durationMs, counts:{passed,failed,total}, ctrf: <CTRF-JSON>, artifacts?: { htmlReport, traces } }` (`artifacts` nur bei `failed`).
- **Ablage:** `${CRED_STORE_DIR}/regression-runs/<projekt>/…` (Muster `DrainReportStore`); atomarer Schreibzugriff, `0600`.
- **Read-API (konsumiert von [[regression-result-view]]):** `GET /api/projects/:slug/regression-runs` (Liste, jüngste zuerst) · `GET /api/projects/:slug/regression-runs/:runId` (Einzel-Lauf inkl. Testfälle) · Artefakt-Zugriff nur bei roten Läufen (s. [[regression-result-view]]).

## Edge-Cases & Fehlerverhalten
- `CRED_STORE_DIR` nicht gesetzt → In-Memory-Degradation (Läufe überleben Neustart nicht), kein Crash.
- Artefakte fehlen bei einem roten Lauf (Runner lieferte keine) → Datensatz ohne `artifacts`, kein Fehler.
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
