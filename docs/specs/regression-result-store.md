---
id: regression-result-store
title: Regressions-Ergebnis-Store — CTRF-JSON je Lauf, Retention 50, Debug-Artefakte kopiert (Grün+Rot, eigene Artefakt-Retention), Auto-Prune
status: active
area: fabrik-arbeiten
version: 2
spec_format: use-case-2.0
---

# Spec: Regressions-Ergebnis-Store  (`regression-result-store`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Jeder Regressionslauf legt sein **CTRF-JSON-Ergebnis** samt seiner **visuellen Debug-Artefakte** in einer kleinen, betreiber-nahen dev-gui-Datenablage ab (Muster `DrainReportStore`) — **nicht** im Projekt-Git. Je Projekt werden die letzten **50** Läufe behalten (Lauf-Retention); Debug-Artefakte (HTML-Report/Test-Ergebnis-Ordner inkl. Screenshots/Traces/Videos) werden **beim Ablegen aus dem Projekt-Klon in die eigene Lauf-Ablage kopiert** — bei **jedem** Status (Default AN, abschaltbar für Grün), mit einer eigenen, engeren **Artefakt-Retention** — und überzählige Läufe/Artefakte werden automatisch geprunt. **Auch ein Lauf, der vor der Testausführung scheitert** (Frühausfall — kein CTRF vorhanden), legt einen Datensatz ab; er trägt seinen Fehlgrund statt eines CTRF-Ergebnisses. Der Store ist die Quelle der Ergebnis-Ansicht ([[regression-result-view]]) und des letzten Lauf-Zustands in der Karte ([[regression-panel]]).

## Kontext / Designnuancen (bindend)
- **Ablage-Muster `DrainReportStore`:** datei-basiert unter `${CRED_STORE_DIR}` (Betreiber-nahe Beobachtbarkeits-Ablage, ADR-005-Linie — **kein** Fabrik-/Domänen-State, kein neuer Store-Typ), atomarer tmp+rename-Schreibzugriff, `0600`; ohne `CRED_STORE_DIR` In-Memory-Degradation (kein Crash, aber auch keine Artefakt-Kopie möglich).
- **CTRF-JSON je Lauf:** das vom Runner ([[regression-run]]) erzeugte CTRF-Ergebnis wird als Lauf-Datensatz abgelegt (plus Metadaten: Datum, Projekt, Suite/Scope, grün/rot, Dauer, Testfall-Zähler) — mit relativierten Attachment-Pfaden (s.u.).
- **Frühausfall-Datensatz (S-326, kein CTRF vorhanden):** ein Lauf, der **vor oder ohne** Testausführung endet (Vorbedingung nicht erfüllt, Rollout-Fehler, Runner-Fehler, Timeout, kein CTRF-Ergebnis, nicht unterstütztes Testobjekt — s. [[regression-run]] AC10), wird **ebenso** als Datensatz abgelegt. Er trägt `status: "precondition-error"|"error"`, `ctrf: null` (**kein synthetisches CTRF** — ein erfundenes Testergebnis würde eine Ausführung vortäuschen, die nie stattfand), `counts: {passed:0,failed:0,total:0}` und ein **`reason`** mit einer secret-freien Kurzbegründung. Ohne diesen Datensatz bliebe der Fehlgrund nur im flüchtigen In-Memory-Lauf-Status und wäre verloren, sobald der Dialog schließt — die GUI zeigte dann „nichts" (verifizierter Befund 2026-07-08).
- **Status = terminaler Lauf-Zustand des Runners:** die vier Status-Werte sind identisch mit den terminalen Zuständen des `GET …/regression-run/:runId`-Vertrags ([[regression-run]] §Verträge) — `passed | failed | precondition-error | error`. Kein zweites, abweichendes Status-Vokabular (`running` ist nicht-terminal und erreicht den Store nie).
- **Retention 50 je Projekt (Lauf-Retention, unverändert):** pro Projekt werden höchstens die **50 jüngsten** Läufe (Datensätze) behalten; ältere werden geprunt (inkl. ihrer Artefakte).
- **Debug-Artefakte werden KOPIERT, nicht nur referenziert (S-327, wesentlicher Befund):** eine reine Pfad-Referenz auf den Projekt-Klon ist falsch, sobald der nächste Lauf denselben Klon überschreibt. Beim Ablegen eines Laufs kopiert der Store `playwright-report/` + `test-results/` (best-effort, `fs.cp` rekursiv, Klon-Ordnernamen bleiben erhalten) aus dem vom Runner übergebenen Projekt-Klon-Pfad in seine **eigene** Lauf-Ablage `${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>/`. Die im CTRF-JSON enthaltenen `tests[].attachments[].path` (vom Reporter mit **absoluten** Pfaden gesetzt) werden dabei auf einen zur Lauf-Artefakt-Ablage **relativen** Pfad umgeschrieben (Security-Floor: kein absoluter Server-Pfad in der Response); Attachments außerhalb des Projekt-Klons werden nicht durchgereicht.
- **Artefakte bei Grün UND Rot (Default AN):** anders als zuvor werden Debug-Artefakte **nicht mehr nur bei roten Läufen** aufbewahrt — der Default ist AN für **beide** Status, abschaltbar für grüne Läufe via `REGRESSION_KEEP_ARTIFACTS_ON_PASS=false` (dann: frühere Regel, Artefakte nur bei Rot). Bei `status:"failed"` werden Artefakte **immer** versucht. Ein **Frühausfall** (`precondition-error`/`error`) hat naturgemäß keine Artefakte (Playwright lief nicht, der Klon enthält keinen `playwright-report/`) — die Kopie greift dort ins Leere (best-effort, kein Fehler).
- **Zwei getrennte Retentions (Owner-Entscheidung 2026-07-16, Plattenbremse):** Lauf-Retention bleibt 50 (Datensätze, klein); zusätzlich eine **Artefakt-Retention** (Default **10**, `REGRESSION_ARTIFACT_RETENTION`, gedeckelt auf höchstens die Lauf-Retention) für die schwereren Artefakt-Ordner.
- **Auto-Prune (zwei Stufen):** beim Ablegen eines neuen Laufs werden je Projekt (a) Läufe jenseits der Lauf-Retention (Datensatz **und** Artefakte) sowie (b) Läufe jenseits der (engeren) Artefakt-Retention, aber noch innerhalb der Lauf-Retention (nur der Artefakt-Ordner **und** die `artifacts`-Referenz im Datensatz) automatisch entfernt (idempotent, keine toten Referenzen, keine verwaisten Ordner).
- **NICHT im Projekt-Git:** die Ablage liegt in der dev-gui-Datenablage, nie im geklonten Projekt-Repo (`test-results/`/`playwright-report/` des Projekts sind ohnehin gitignored, agent-flow `regression-playwright-conventions` AC6).

## Main Success Scenario
1. Ein Lauf endet ([[regression-run]]); der Runner übergibt CTRF-JSON + Metadaten (Suite/Scope, grün/rot, Dauer, Zähler) + den absoluten Projekt-Klon-Pfad, aus dem der Store bei Bedarf Artefakte kopiert.
2. Der Store legt einen neuen Lauf-Datensatz je Projekt an (atomar).
3. Ist das Aufbewahren von Artefakten für diesen Status aktiv (Rot: immer; Grün: Default AN, s.o.), kopiert der Store HTML-Report/Test-Ergebnis-Ordner aus dem Projekt-Klon in seine eigene Lauf-Ablage und relativiert die CTRF-Attachment-Pfade; sonst bleibt der Datensatz ohne `artifacts`.
4. Auto-Prune entfernt je Projekt Läufe jenseits der Lauf-Retention (inkl. deren Artefakte) sowie Artefakt-Ordner (inkl. Referenz) jenseits der Artefakt-Retention.
5. Die Datensätze sind read-only abrufbar (Liste + Einzel-Lauf) für [[regression-result-view]]/[[regression-panel]].

## Alternative Flows
- **A1 — Frühausfall (kein CTRF, S-326):** ein Lauf endet **ohne** Testausführung ([[regression-run]] AC10). Der Runner übergibt denselben Metadaten-Satz, aber `status: "precondition-error"|"error"`, `ctrf: null`, `counts: {0,0,0}` und ein `reason`. Der Store legt ihn wie jeden anderen Datensatz ab (Schritt 2, 4, 5 identisch); Debug-Artefakte gibt es keine (Schritt 3 greift ins Leere — Playwright lief nicht, der Klon enthält keinen `playwright-report/`; kein Fehler, AC3).

## Acceptance-Kriterien
- **AC1** — Je Lauf wird ein Datensatz mit dem **CTRF-JSON** + Metadaten `{ runId, projekt, suite, scopeTyp, status: "passed"|"failed"|"precondition-error"|"error", startedAt, durationMs, counts:{passed,failed,total}, reason? }` abgelegt; die Ablage folgt dem `DrainReportStore`-Muster (datei-basiert unter `${CRED_STORE_DIR}`, atomar tmp+rename, `0600`; ohne `CRED_STORE_DIR` In-Memory-Degradation). **Nicht** im Projekt-Git.
- **AC1b** — **Frühausfall-Datensatz (S-326):** bei `status: "precondition-error"|"error"` wird der Datensatz **ohne** CTRF abgelegt (`ctrf: null`, **kein** synthetisches Ersatz-CTRF) und trägt ein **`reason`** mit einer secret-freien Kurzbegründung des Fehlgrunds; `counts` ist `{passed:0,failed:0,total:0}`. Ein solcher Datensatz durchläuft Retention/Prune/Read-API **identisch** zu einem `passed`/`failed`-Lauf (kein Sonderweg, kein zweiter Store). Bei `status: "passed"|"failed"` ist `reason` **abwesend**.
- **AC2** — **Retention:** pro Projekt werden höchstens die **50 jüngsten** Läufe behalten; beim Ablegen eines neuen Laufs werden ältere je Projekt automatisch geprunt (Auto-Prune, idempotent).
- **AC3** — **Debug-Artefakte kopiert, Grün+Rot, eigene Artefakt-Retention:** beim Ablegen eines Laufs kopiert der Store (best-effort) `playwright-report/` + `test-results/` aus dem vom Runner übergebenen Projekt-Klon-Pfad in seine eigene Lauf-Ablage — bei `status:"failed"` **immer**, bei `status:"passed"` **per Default ebenfalls** (abschaltbar via `REGRESSION_KEEP_ARTIFACTS_ON_PASS=false`); ein Frühausfall (`precondition-error`/`error`) hat keine Artefakte (kein `playwright-report/` im Klon — die Kopie greift ins Leere, kein Fehler). Die CTRF-Attachment-Pfade (`tests[].attachments[].path`, vom Reporter absolut gesetzt) werden dabei auf einen zur Lauf-Artefakt-Ablage relativen Pfad umgeschrieben; Attachments außerhalb des Projekt-Klons werden nicht durchgereicht. Zusätzlich zur Lauf-Retention (AC2, 50) gilt eine engere **Artefakt-Retention** (Default **10**, `REGRESSION_ARTIFACT_RETENTION`, gedeckelt auf höchstens die Lauf-Retention): Läufe innerhalb der Artefakt-Retention behalten Datensatz **und** Artefakte; Läufe jenseits der Artefakt-Retention, aber noch innerhalb der Lauf-Retention, behalten **nur** den Datensatz — ihr Artefakt-Ordner **und** die `artifacts`-Referenz im Datensatz entfallen (keine toten Referenzen, keine verwaisten Ordner). Wird ein Lauf komplett geprunt (jenseits der Lauf-Retention), werden seine Artefakte mitentfernt.
- **AC4** — Read-only Zugriff: der Store liefert je Projekt die Lauf-Liste (jüngste zuerst) und einen Einzel-Lauf inkl. Testfall-Details (aus dem CTRF-JSON) sowie — sofern (noch) vorhanden, s. AC3 — die Referenz auf die Debug-Artefakte. Bei einem Frühausfall-Datensatz (AC1b) liefert er statt der Testfall-Details das `reason`.
- **AC5** — Keine Secrets/Tokens in abgelegten Datensätzen/Metadaten/Log — **einschliesslich `reason`** (Kurztext aus einer festen Meldungs-Menge des Runners, **nie** roher Fehler-/Prozess-Output, nie ein Pfad/Token/Kommandozeilen-Fragment); das CTRF-JSON wird inhaltlich unverändert übernommen (nur die Attachment-Pfade werden relativiert, s. AC3 — der Runner stellt sicher, dass keine Secrets in die Artefakte gelangen, agent-flow `regression-runner` AC9). Die Attachment-Relativierung läuft **immer**, sobald der Store einen Projekt-Klon-Pfad erhält — **unabhängig davon**, ob tatsächlich Artefakte kopiert werden (AC3-Gate `status`/`REGRESSION_KEEP_ARTIFACTS_ON_PASS`): auch ein grüner Lauf bei abgeschalteten Grün-Artefakten darf **niemals** einen absoluten Server-Pfad im persistierten `ctrf` behalten.

## Verträge
- **Datensatz-Schema:** `{ runId, projekt, suite, scopeTyp: "bereich"|"verbund"|"gesamt", status: "passed"|"failed"|"precondition-error"|"error", startedAt, durationMs, counts:{passed,failed,total}, ctrf: <CTRF-JSON, Attachment-Pfade relativ>|null, reason?: string, artifacts?: { htmlReport, testResults } }` — `artifacts` kann bei JEDEM Status vorkommen (s. AC3 — fehlt, wenn keine Artefakte kopiert wurden oder die Artefakt-Retention den Lauf bereits übersprungen hat); `ctrf: null` + `reason` gesetzt genau bei `precondition-error`/`error` (AC1b).
- **Ablage:** `${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>.json` (Datensatz) + `${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>/{playwright-report,test-results}/…` (kopierte Artefakte, Klon-Ordnernamen erhalten — Muster `DrainReportStore`); atomarer Schreibzugriff für den Datensatz, `0600`.
- **Read-API (konsumiert von [[regression-result-view]]):** `GET /api/projects/:slug/regression-runs` (Liste, jüngste zuerst) · `GET /api/projects/:slug/regression-runs/:runId` (Einzel-Lauf inkl. Testfälle) · Artefakt-Zugriff für jeden Lauf mit vorhandener Artefakt-Ablage, unabhängig von grün/rot (S-328, s. [[regression-result-view]]), aus der Lauf-eigenen Artefakt-Ablage (nicht mehr aus dem Projekt-Klon).

## Edge-Cases & Fehlerverhalten
- `CRED_STORE_DIR` nicht gesetzt → In-Memory-Degradation (Läufe überleben Neustart nicht, keine Artefakt-Kopie möglich), kein Crash.
- Artefakte fehlen im Projekt-Klon (Runner lieferte keine, z.B. kein `playwright-report/`) → Datensatz ohne (den jeweiligen Teil von) `artifacts`, kein Fehler.
- Artefakt-Kopie schlägt fehl (z.B. `fs.cp`-Fehler abseits eines fehlenden Quellordners) → best-effort/non-fatal, der Lauf-Datensatz selbst geht dadurch nicht verloren, es fehlt lediglich der betroffene `artifacts`-Schlüssel.
- Frühausfall-Datensatz ohne `reason` (Runner lieferte keinen) → Datensatz wird abgelegt, `reason` fehlt; die Ansicht zeigt einen generischen Fehl-Hinweis (kein Crash, kein stiller Verlust des Datensatzes).
- Unbekannter/ungültiger `status` (weder `passed`/`failed`/`precondition-error`/`error`) → **Ablehnung** durch den Store (der Runner ist der einzige Produzent und liefert ausschliesslich terminale Zustände); das Vokabular bleibt geschlossen.
- Gleichzeitiges Ablegen zweier Läufe verschiedener Projekte → getrennte Projekt-Buckets, keine Kollision; atomarer Schreibzugriff verhindert Teilzustände.
- Korruptes/teilweises Datei-Set beim Laden → betroffener Datensatz wird übersprungen (degradierend), Rest bleibt lesbar.

## NFRs
- **Größenbegrenzung (hart):** Lauf-Retention 50 je Projekt + eine engere Artefakt-Retention (Default 10, gedeckelt auf höchstens die Lauf-Retention) begrenzt den Plattenbedarf trotz Artefakten bei Grün+Rot; Auto-Prune hält die Ablage klein (ADR-005-Linie: kleine betreiber-nahe Ablage, kein Domänen-State).
- **Sicherheit:** `0600` (Datensätze), keine Secrets/absoluten Server-Pfade in Datensätzen/Log/Response (Attachment-Pfade relativiert); hinter Access (Read-API rollen-/access-geschützt wie die übrigen Beobachtbarkeits-Endpunkte).

## Nicht-Ziele
- Testausführung ([[regression-run]]) und Ansicht/Drilldown ([[regression-result-view]]).
- Persistenz im Projekt-Git (bewusst ausgeschlossen).
- Unbegrenzte Lauf-Historie / Langzeitarchiv.

## Abhängigkeiten
- [[regression-run]] (Produzent: CTRF + Artefakte) · [[regression-result-view]] (Konsument) · [[regression-panel]] (letzter Lauf-Zustand).
- `DrainReportStore` / `drain-completion-report` (Ablage-Muster) · ADR-020 (`DrainJobRegistry`-Persistenz-Muster).
- agent-flow `regression-playwright-conventions` (CTRF-Reporter-Format, gitignore-Pflicht).
