---
id: regression-run
title: Regressionstest ausführen — deterministischer RegressionRunner (Ausführen-Dialog, Testobjekt, Frisch-Ausrollen)
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Regressionstest ausführen — deterministischer Runner  (`regression-run`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate). **Security-relevant** (lokaler Docker-Zugriff / ghcr-Pull / privilegierte Aktion).
>
> **Cross-Repo-Bindung (textuell):** das Testobjekt-/`target`-Modell (`local | ephemeral-infra | url`), die Infra-Leitplanken (`rtest-*`-Namensschema, Produktiv-Allowlist, garantiertes Cleanup) und die Deterministik (kein Agent pro Testlauf) sind in agent-flow `regression-runner` verbindlich festgelegt. dev-gui **spiegelt** dieses Modell in der GUI-Ausführung (`npx playwright test` im Projekt), es **definiert die Leitplanken nicht neu**.

## Zweck
Ein Regressionstest-Lauf läuft **deterministisch, ohne Agent** — `npx playwright test` im Projekt-Klon (kein `claude`, kein API-Key) über einen neuen `RegressionRunner`-Boundary (eigenes Lock, Audit, Timeout). Der Ausführen-Dialog wählt die Suite (Bereich / Verbund / Gesamt), zeigt je Suite ihr deklariertes Testobjekt (`target`) und — bei `target: local` — eine Option „Neustes Image vor dem Lauf ausrollen" (Default AN). Vor `local`-Läufen wird die Container-Erreichbarkeit geprüft (klarer Vorbedingungs-Fehler statt roter Tests).

## Kontext / Designnuancen (bindend)
- **Deterministisch, kein Agent:** je Lauf wird **kein** `claude`-Prozess/Agent dispatcht; der Runner startet `npx playwright test` im Projekt (agent-flow `regression-runner` AC1). Kein API-Key.
- **Eigener `RegressionRunner`-Boundary** mit **eigener** `ProjectJobLock`-Instanz, Audit-First, entkoppeltem Runaway-Timeout — getrennt von den `claude -p`-Runnern (dieser Pfad ruft kein `claude`).
- **Busy-Check gegen laufende Drains desselben Projekts:** ein Lauf startet nicht, solange ein Drain (manuell/Nacht) oder ein anderer Regressionslauf desselben Projekts aktiv ist (Erkennung über die projektweise Busy-Logik, kein Doppel-Trigger).
- **Testobjekt-Anzeige:** der Ausführen-Dialog zeigt je Suite ihr in der Begleitbeschreibung deklariertes `target` (`local` = lokaler Docker-Container | `ephemeral-infra` = flüchtige `rtest-*`-Infrastruktur | `url`).
- **Kosten-/Ressourcen-Hinweis** bei Infra-Suiten (`ephemeral-infra`): der Dialog zeigt die Kosten-/Ressourcen-Deklaration aus der Begleitbeschreibung.
- **Frisch-Ausrollen (Owner-Entscheidung 2026-07-03, DEFAULT AN):** bei `target: local` bietet der Dialog „Neustes Image vor dem Lauf ausrollen" — der Runner zieht das aktuelle ghcr-Image des Projekts und erstellt den lokalen Container **neu** (pull + recreate, **niemals** `restart`), wartet auf Readiness und startet erst dann die Suite. **Bestehende Rollout-Mechanik von cicd/preview wird wiederverwendet** (kein neuer Rollout-Pfad).
- **Sonderfall Selbsttest:** ist das Testobjekt das Projekt, in dem der Runner selbst läuft (**dev-gui**), wird Frisch-Ausrollen **automatisch übersprungen** (Selbst-Erkennung, Hinweis im Dialog, Lauf gegen die laufende Instanz) — ein recreate würde den Runner mitsamt Lauf beenden.
- **„Gesamt"-Lauf = ein aggregierter Datensatz** (Annahme, konservativ, s. „Annahmen"): die Auswahl Bereich/Verbund/Gesamt erzeugt **einen** Lauf-Datensatz mit `suite`-Label = gewählter Scope; Testfall-Zähler summiert über die ausgeführten Suiten. So passt „genau EIN Push bei Rot — X/Y rot" ([[regression-failed-notification]]).

## Annahmen
- **A1 (Owner-Rückfrage im Lauf nicht erreichbar, konservativ gewählt):** ein „Gesamt"-Lauf wird als **ein** aggregierter Lauf-Datensatz (Suite=„Gesamt") abgelegt — nicht als N Einzel-Datensätze. Begründung: deckt sich mit der Owner-Vorgabe „genau EIN Push NUR bei rotem Lauf … X/Y rot". **Im Lauf-Output eskaliert** — bei anderer Owner-Präferenz ist das eine additive Änderung an [[regression-result-store]]/[[regression-failed-notification]].
- **A2:** Selbst-Erkennung von dev-gui über den Projekt-Slug (`dev-gui`, Profil/`board`); die genaue Erkennungsquelle ist Implementierungs-/`architekt`-Detail, das beobachtbare Verhalten (Frisch-Ausrollen übersprungen + Dialog-Hinweis) ist bindend.

## Main Success Scenario
1. Owner klickt „Regressionstest ausführen" ([[regression-panel]]) → Ausführen-Dialog öffnet.
2. Dialog listet die verfügbaren Suiten (Bereich / Verbund / Gesamt) und zeigt je Suite ihr deklariertes `target`; bei `ephemeral-infra` zusätzlich den Kosten-/Ressourcen-Hinweis.
3. Bei mindestens einer `local`-Suite zeigt der Dialog die Option „Neustes Image vor dem Lauf ausrollen" (Default AN); ist das Testobjekt dev-gui, ist die Option deaktiviert mit Selbsttest-Hinweis.
4. Bestätigen → Busy-Check (kein aktiver Drain/Lauf desselben Projekts) → `RegressionRunner` startet, Zustand `running`, Lock gehalten, Audit-Eintrag.
5. Bei `target: local` + Frisch-Ausrollen (und **nicht** Selbsttest): pull + recreate des lokalen Containers (cicd/preview-Mechanik), Readiness-Warten; danach Erreichbarkeitsprüfung.
6. Bei `target: local` ohne Frisch-Ausrollen: reine Erreichbarkeitsprüfung des Containers; nicht erreichbar → **Vorbedingungs-Fehler** „Applikation lokal nicht gestartet" (statt roter Tests), Lauf endet ohne Testausführung.
7. `npx playwright test` läuft deterministisch im Projekt-Klon; nach Abschluss werden CTRF-Ergebnis + Artefakte an den Ergebnis-Store übergeben ([[regression-result-store]]); Lock frei, Audit-Ende.

## Alternative Flows
- **A3 — `ephemeral-infra`:** der Lauf provisioniert/zerstört sein eigenes `rtest-*`-Wegwerf-Ziel (Cleanup garantiert, auch im Fehlerpfad — agent-flow `regression-runner` AC4/AC7/AC8); der Dialog hat vorab den Kosten-/Ressourcen-Hinweis gezeigt.
- **A4 — `target: url`:** Lauf gegen die deklarierte URL, ohne lokal zu provisionieren (kein Frisch-Ausrollen, keine local-Erreichbarkeitsprüfung).
- **E1 — Busy:** ein Drain/Regressionslauf desselben Projekts ist aktiv → Start abgelehnt mit klarer Meldung; kein Doppel-Lauf.

## Acceptance-Kriterien

### Runner-Boundary & Deterministik (Backend, Security-Floor)
- **AC1** — `RegressionRunner` ist ein eigener Boundary mit **eigener** `ProjectJobLock`-Instanz, Audit-First und entkoppeltem Runaway-Timeout; je Lauf wird **kein** `claude`/Agent dispatcht (Grep-prüfbar) — reine `npx playwright test`-Ausführung im Projekt-Klon, **kein** API-Key.
- **AC2** — **Busy-Check:** ein Lauf startet nur, wenn kein Drain (manuell/Nacht) **und** kein anderer Regressionslauf desselben Projekts aktiv ist; sonst Ablehnung mit klarer Meldung (E1).
- **AC3** — Der Endpunkt liegt hinter Access, ist identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`-Linie, 403 ohne Berechtigung) und audit-first (Eintrag mit Identität/Projekt/Suite/`target` **vor** Start); keine Secrets/Tokens in Response/Log/WS/Audit.

### Testobjekt & Vorbedingung (`target`)
- **AC4** — Der Ausführen-Dialog zeigt je Suite ihr deklariertes `target` (`local | ephemeral-infra | url`), gelesen aus der Begleitbeschreibung der Suite (agent-flow `regression-runner` AC2).
- **AC5** — Vor einem `local`-Lauf prüft der Runner die **Erreichbarkeit** des lokalen Containers; nicht erreichbar → klarer **Vorbedingungs-Fehler** mit dem Hinweis „Applikation lokal nicht gestartet" **statt** roter Testfälle (agent-flow `regression-runner` AC6). `ephemeral-infra`/`url` durchlaufen diese local-Prüfung nicht.
- **AC6** — Bei `ephemeral-infra`-Suiten zeigt der Dialog vor dem Start den **Kosten-/Ressourcen-Hinweis** aus der Begleitbeschreibung.

### Frisch-Ausrollen & Selbsttest (`target: local`)
- **AC7** — Bei `target: local` bietet der Dialog „Neustes Image vor dem Lauf ausrollen" mit **Default AN**; ist die Option aktiv, zieht der Runner das aktuelle ghcr-Image des Projekts und erstellt den lokalen Container **neu** (**pull + recreate, niemals `restart`**), wartet auf Readiness und startet die Suite **erst danach** — unter **Wiederverwendung der bestehenden cicd/preview-Rollout-Mechanik** (kein neuer Rollout-Pfad, Grep-prüfbar).
- **AC8** — **Selbsttest-Sonderfall:** ist das Testobjekt das Projekt, in dem der Runner läuft (dev-gui), wird Frisch-Ausrollen **automatisch übersprungen** (Selbst-Erkennung), der Dialog zeigt einen Selbsttest-Hinweis und der Lauf läuft gegen die laufende Instanz — **kein** recreate des eigenen Containers.

### Ausführung & Ergebnis-Übergabe
- **AC9** — Der Lauf führt `npx playwright test` für den gewählten Scope (Bereich / Verbund / Gesamt) aus; ein „Gesamt"-Lauf erzeugt **einen** aggregierten Lauf-Datensatz (Suite=„Gesamt", A1). Nach Abschluss werden CTRF-Ergebnis + (bei Rot) Debug-Artefakte an den Ergebnis-Store übergeben ([[regression-result-store]]).

## Verträge
- **POST `/api/projects/:slug/regression-run`** — Body `{ scope: { typ: "bereich"|"verbund"|"gesamt", id?: <bereich-id|verbund-name> }, freshRollout?: boolean }` → `{ runId, status: "running" }` · `409 { error: "busy" }` (Drain/Lauf aktiv) · `403` (keine Berechtigung). Die local-Erreichbarkeitsprüfung (AC5) läuft **asynchron als Teil des gestarteten Laufs** (Main Success Scenario Schritt 4–6), NICHT synchron im POST-Response — ein nicht erreichbares `local`-Ziel liefert daher **keinen** eigenen POST-Statuscode, sondern den Lauf-Zustand `precondition-error` über den GET-Endpunkt (Präzisierung: eine frühere Fassung nannte hier zusätzlich einen synchronen `422`-Code, der der beschriebenen Async-Ausführung widersprach).
- **GET `/api/projects/:slug/regression-run/:runId`** → `{ status: "running"|"passed"|"failed"|"precondition-error"|"error", target, suite, counts?: {passed,failed,total}, durationMs?, reason? }`.
- **`target`-Quelle:** Begleitbeschreibung der Suite (`tests/regression/<bereich>/` bzw. `tests/regression/verbund/`, agent-flow `regression-playwright-conventions`-Layout).
- **Frisch-Ausrollen:** ruft die bestehende cicd/preview-Rollout-Boundary (pull + recreate + Readiness-Warten); **nie** `docker restart`. Selbsttest (dev-gui) → Schritt übersprungen.
- Hinter AccessGuard; Mutation identitäts-/rollengeprüft + AuditEntry.

## Edge-Cases & Fehlerverhalten
- ghcr-Pull/recreate schlägt fehl (Frisch-Ausrollen) → Lauf `error` mit Grund, Suite nicht gestartet; kein verwaister Halbzustand (bestehende cicd/preview-Fehlerbehandlung).
- local-Container nach Frisch-Ausrollen nicht readiness-bereit (Timeout) → `precondition-error`, keine roten Tests.
- `npx playwright test` bricht ab / Timeout → `error`/`failed` je nach Ursache, Lock freigegeben, Audit-Ende; `ephemeral-infra`-`rtest-*`-Cleanup läuft garantiert (agent-flow `regression-runner` AC8).
- Kein Projekt-Klon im Workspace / kein Playwright-Grundgerüst → klarer Fehler „kein Regressions-Grundgerüst" (kein Crash).
- Selbsttest mit aktivierter Frisch-Ausrollen-Option (z.B. über direkten API-Aufruf) → Runner überspringt recreate dennoch (AC8, Server-seitig erzwungen, nicht nur UI-seitig).

## NFRs
- **Sicherheit (Floor, hart):** hinter Access, identitäts-/rollengeschützt, audit-first; kein API-Key/`claude`-Prozess; Selbst-recreate hart ausgeschlossen (AC8, Server-seitig); Infra-Leitplanken (`rtest-*`, Produktiv-Allowlist, garantiertes Cleanup) gemäß agent-flow `regression-runner`; keine Secrets in Response/Log/WS/Audit.
- **Determinismus:** reproduzierbar, kein Agent, kein Nichtdeterminismus durch LLM-Aufruf.
- **Isolation:** eigenes `ProjectJobLock` (kein globaler PTY-Lock berührt).

## Nicht-Ziele
- Testdefinition/Redaktion ([[regression-define-dialog]]).
- Ergebnis-Ablage/Retention/Artefakt-Aufbewahrung ([[regression-result-store]]) und Ansicht ([[regression-result-view]]) — hier nur die Übergabe.
- Benachrichtigung bei Rot ([[regression-failed-notification]]).
- Neu-Definition der Infra-Leitplanken/`target`-Semantik (agent-flow `regression-runner`).

## Abhängigkeiten
- agent-flow `regression-runner` (Testobjekt-/`target`-Modell, Infra-Leitplanken, Deterministik) · agent-flow `regression-playwright-conventions` (Suite-Layout, CTRF-Reporter).
- [[regression-panel]] (Einstieg) · [[regression-result-store]] (Ergebnis-Übergabe) · [[regression-failed-notification]] (Push bei Rot).
- Bestehende cicd/preview-Rollout-Mechanik (pull + recreate + Readiness) — wiederverwendet für Frisch-Ausrollen ([[deploy-lifecycle]]/[[local-image-test]]-Linie, lokaler Docker via socket-proxy).
- `WorkspaceManager` (Projekt-Klon im Workspace, in dem `npx playwright test` läuft).
