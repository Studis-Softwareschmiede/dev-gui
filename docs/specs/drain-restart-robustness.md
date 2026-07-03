---
id: drain-restart-robustness
title: Drain-Robustheit gegen Server-Neustart — persistente Job-Registry + Boot-Wiederanlauf
status: active
version: 1
spec_format: use-case-2.0
---

# Spec: Drain-Robustheit gegen Server-Neustart  (`drain-restart-robustness`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Ein Board-Drain (Nachtwächter ODER manueller „Board abarbeiten"-Knopf) läuft als `claude -p '/agent-flow:flow …'`-**Kindprozess**, der am Elternprozess (dev-gui/Container) hängt. Stirbt der Server/Container (Deploy, Absturz, Neustart), stirbt der Kindprozess mit — und die **In-Memory-Buchführung** ist danach leer: die `DrainJobRegistry` (manueller Drain, [[headless-manual-drain]] AC4) und das `#activeDrains`-Tracking des `NightWatchScheduler` sind weg. Ergebnis (Vorfall 2026-07-02): eine laufende `drainId` ist nach dem Neustart **unauffindbar** (`GET …/drain/:drainId` → `404`), das Monitoring ist **blind**, und ein zur Hälfte abgearbeitetes Board bleibt liegen, bis jemand von Hand nachtritt.

Diese Spec entkoppelt die Drain-**Beobachtbarkeit + Konvergenz** vom Server-Lebenszyklus:
1. **Persistente Job-Registry** (datei-basiert, Muster `DrainReportStore`): in-flight Drains überleben einen Neustart als Datensatz; beim Boot werden noch-`running`-Einträge als **`aborted` (verwaist)** markiert statt vergessen.
2. **Boot-Wiederanlauf:** verwaiste Drains werden erkannt und je betroffenem Projekt wird **genau ein** idempotenter Wiederanlauf-Drain angestoßen — `ProjectDrain` re-scannt das Board und konvergiert selbst (ein bereits leergezogenes Board ⇒ harmloser No-op).
3. **Bewusste Nicht-Entscheidung (ADR-020):** Kindprozesse werden **nicht** detached gespawnt (Begründung s.u. + ADR) — der Boot-Wiederanlauf ist der robustere, container-taugliche Weg.

## Getroffene Annahmen (mangels Rückfrage-Kanal im requirement-Subagenten explizit dokumentiert)
Der `requirement`-Subagent hat keinen interaktiven Rückfrage-Kanal (`AskUserQuestion` steht dort nicht zur Verfügung). Die folgenden drei Design-Entscheidungen wurden token-bewusst + doktrin-konform (idempotent, degradierend, best-effort — konsistent mit [[taktgeber-nachtwaechter]]/[[headless-parallel-drain]]) getroffen. Sie sind **AC-tragend** und können vom Owner bei der Story-Abnahme revidiert werden (dann Spec + betroffene AC nachziehen):

- **A1 — Nacht-Orphan respektiert das Nachtfenster (AC7).** Ein verwaister *Nacht*-Drain wird beim Boot **nur dann** sofort wiederangelaufen, wenn der Boot-Zeitpunkt **innerhalb** des Nachtfensters liegt (+ Nacht-Modus aktiv + Auth nicht `expired`). Ausserhalb des Fensters bleibt der Eintrag `aborted` und der **reguläre** Scheduler-Tick greift das Projekt im nächsten Fenster ohnehin wieder auf (idempotent) — ein Wiederanlauf um 09:00 würde die Fenster-Doktrin ([[taktgeber-nachtwaechter]] AC9–AC11, sanftes Ende) verletzen und Tages-Tokens verbrennen.
- **A2 — Manueller Orphan läuft automatisch wieder an (AC6).** Ein verwaister *manueller* Drain wird beim Boot **automatisch** (ohne Nutzer-Bestätigung) je betroffenem Projekt einmal wiederangelaufen — so die explizite Owner-Anforderung („automatisch EINEN Wiederanlauf-Drain je betroffenem Projekt anstoßen"). Der Token-Verbrauch ohne anwesenden Owner ist die bewusst akzeptierte Folge; `ProjectDrain`-Konvergenz + `isProjectBusy`-Schutz begrenzen ihn (leeres Board ⇒ No-op).
- **A3 — Cost-Mode/Args werden replay't (AC6).** Der ursprüngliche `costMode`/die `args` (z.B. `['--cost','frontier']`, secret-frei, nur das Enum) werden im persistenten Eintrag mitgeführt und beim Wiederanlauf **1:1** wiederverwendet — der Wiederanlauf läuft in der vom Owner gewählten Kostenstufe.

## Verhalten

### Persistente Drain-Job-Registry (Backend)
1. Die `DrainJobRegistry` ([[headless-manual-drain]] AC4, heute rein In-Memory) wird **datei-basiert persistiert** — Muster `DrainReportStore`/`TickerSettingsStore`: eine JSON-Datei unter `${CRED_STORE_DIR}` (`${CRED_STORE_DIR}/drain-jobs.json`), atomarer Schreibzugriff (tmp + rename), Rechte `0600`. Je Drain **ein** Eintrag: `{ drainId, project, trigger, status, args?, startedAt, finishedAt? }` — `project` = Projekt-**Slug** (kein absoluter Pfad), `trigger` ∈ `{ 'night', 'manual' }`, `status` ∈ `{ 'running', 'done', 'failed', 'aborted' }`, `args` = secret-freies argv-Array (nur das Cost-Mode-Enum). Ist `CRED_STORE_DIR` **nicht** gesetzt, degradiert die Registry auf reinen In-Memory-Betrieb (heutiges Verhalten) statt zu werfen — der Drain darf durch fehlende Persistenz **nie** crashen.
2. `register(drainId, { project, trigger, args?, startedAt })` schreibt einen `running`-Eintrag; `markDone(drainId, result)`/`markFailed(drainId)` setzen den terminalen Status + `finishedAt`; `getJob(drainId)` liest aus dem persistierten Cache. Das **Vertragsformat** von `GET /api/projects/:slug/drain/:drainId` ([[headless-manual-drain]] AC4) bleibt unverändert (`200 {status,result?,error?}` | `404`). Ein Store-/Schreibfehler ist **non-fatal** (best-effort — der Drain-Ablauf bleibt unberührt).

### Nacht-Drain wird registriert (Backend)
3. Der **Nacht-Drain** registriert seine in-flight Drains **zusätzlich** in derselben (geteilten) persistenten Registry (`trigger:'night'`, generierte `drainId`, Projekt-Slug) beim Start und markiert sie beim Abschluss terminal — das bestehende `#activeDrains`-Concurrency-Tracking des `NightWatchScheduler` bleibt **unverändert** (reine additive Erfassung). Dadurch hinterlässt ein abgestürzter/neugestarteter Nacht-Drain einen **wiederauffindbaren** `running`-Eintrag statt still verloren zu gehen. Best-effort/degradierend — die Registrierung darf den Scheduler nie crashen.

### Orphan-Markierung beim Boot (Backend)
4. Beim **ersten Laden** der Registry nach einem Server-Start gilt: jeder Eintrag, der noch `running` ist, ist **verwaist** (unmittelbar nach dem Boot kann kein Drain echt laufen — sein Kindprozess starb mit dem alten Prozess). Solche Einträge werden auf `status:'aborted'` gesetzt (`finishedAt` gestempelt) und persistiert — **nicht** gelöscht. `GET …/drain/:drainId` einer verwaisten `drainId` liefert danach `200 {status:'aborted'}` (Monitoring ist **nicht** mehr blind). Die Orphan-Markierung ist **idempotent**: ein zweiter Boot/Load markiert bereits-terminale Einträge nicht erneut.

### Boot-Wiederanlauf (Backend)
5. Nach der Orphan-Markierung sammelt der Boot-Wiederanlauf die **distinkte Menge** der Projekte mit ≥1 verwaisten Drain, getrennt nach `trigger`, und stößt je distinktem Projekt **genau einen** Wiederanlauf-Drain an — mehrere verwaiste Einträge desselben Projekts ⇒ **ein** Wiederanlauf (Dedup pro Projekt).
6. **Manueller Orphan (A2/A3):** je Projekt mit verwaistem `manual`-Drain wird ein Wiederanlauf-Drain über die **manuelle** `ProjectDrain`-Instanz **automatisch** gestartet, unter Replay der persistierten `args` (Cost-Mode) 1:1; ein frischer `running`-Eintrag wird registriert (neue `drainId`), sodass der Status-Endpunkt ihn zeigt. `isProjectBusy` wird vorher lesend geprüft (kein Doppel-Start).
7. **Nacht-Orphan (A1):** je Projekt mit verwaistem `night`-Drain wird ein Wiederanlauf-Drain **nur dann** über die **Nacht**-`ProjectDrain`-Instanz gestartet, wenn der Boot-Zeitpunkt **innerhalb** des Nachtfensters liegt UND der Nacht-Modus aktiviert ist UND `ClaudeAuthHealthService.getState()` nicht `expired` meldet; sonst bleibt der Eintrag `aborted` und der reguläre Scheduler-Tick konvergiert das Projekt im nächsten Fenster (kein separater Boot-Lauf).
8. Der **gesamte** Boot-Wiederanlauf ist **best-effort/degradierend**: jeder Fehler (Slug→Pfad-Re-Auflösung, Pfad-Validierung, Store-Read/Write, Drain-Start) wird gefangen und darf den **Server-Boot nicht crashen**; der Wiederanlauf für die übrigen Projekte läuft weiter. Die Slug→Pfad-Auflösung nutzt denselben validierten Pfad wie der Router (`resolveProjectSlug` + `validateProjectPath`, realpath-Containment); ein Slug, der nicht mehr auflöst (Repo entfernt), wird **übersprungen**. Die `ProjectDrain`-eigene Board-Re-Scan-Konvergenz garantiert, dass ein Wiederanlauf auf einem bereits leergezogenen Board ein **harmloser No-op** ist (idempotent).

### Detached-Spawn: bewusst abgelehnt (ADR-020)
9. Der **optionale** Ansatz „Kindprozesse detached spawnen, damit sie einen Server-Restart überleben (inkl. Wiederaufnahme der Ausgabe-Erfassung)" wird geprüft und **abgelehnt** — Begründung als **ADR-020** in `docs/architecture.md` festgehalten (Kern s. Edge-Cases/NFRs). Der idempotente Boot-Wiederanlauf (AC5–AC8) ist der robustere, container-taugliche Weg; ein detached, halb-überlebender Prozess wäre in diesem Deployment sowohl **unzureichend** (Container-Redeploy killt ihn trotzdem) als auch **schädlich** (Doppel-Lauf-Risiko mit dem Wiederanlauf).

### Doktrin/Drift (Doku)
10. `.claude/CLAUDE.md` + `docs/architecture.md` (ADR-020) dokumentieren die persistente Drain-Registry + den Boot-Wiederanlauf + die Detached-Ablehnung; die Aussagen „Server-Neustart → In-Memory-Registry/Prozess verloren (Nicht-Ziel/Restrisiko)" in [[headless-parallel-drain]] und [[headless-manual-drain]] tragen einen **supersede-/ergänzt-Vermerk** auf diese Spec (sonst Doktrin-Drift, hartes `reviewer`-Gate); `docs/concept.md` erhält einen kurzen Hinweis im Taktgeber-/Drain-Bereich.

## Acceptance-Kriterien

- **AC1** — Die `DrainJobRegistry` persistiert datei-basiert unter `${CRED_STORE_DIR}/drain-jobs.json` (atomarer tmp+rename-Schreibzugriff, Rechte `0600`, Muster `DrainReportStore`). Eintrag-Schema **secret-/pfad-frei**: `{ drainId, project (Slug), trigger:'night'|'manual', status:'running'|'done'|'failed'|'aborted', args?:string[], startedAt, finishedAt? }` — **keine** absoluten Host-Pfade/Tokens/Roh-Fehlertexte. Ohne gesetztes `CRED_STORE_DIR` degradiert die Registry auf reinen In-Memory-Betrieb (kein Crash). Einträge überstehen einen Server-Neustart. *(1)*
- **AC2** — `register(drainId,{project,trigger,args?,startedAt})` schreibt `running`; `markDone`/`markFailed` schreiben den terminalen Status + `finishedAt`; `getJob` liest aus dem persistierten Cache. Das Vertragsformat von `GET /api/projects/:slug/drain/:drainId` ([[headless-manual-drain]] AC4: `200 {status,result?,error?}` | `404` | `400`) bleibt **unverändert** — bestehende `projectDrainRouter`/`DrainJobRegistry`-Tests bleiben grün (kein Regress). Ein Store-/Schreibfehler ist **non-fatal** (best-effort, degradierend). *(1,2)*
- **AC3** — Der **Nacht-Drain** registriert jeden in-flight Drain zusätzlich in derselben geteilten persistenten Registry (`trigger:'night'`, generierte `drainId`, Projekt-Slug) beim Start und markiert ihn beim Abschluss terminal; das bestehende `#activeDrains`-Tracking + die übrige `NightWatchScheduler`-Logik bleiben **unverändert**. Die Registrierung ist best-effort und crasht den Scheduler **nie**. Ein neugestarteter Nacht-Drain hinterlässt einen wiederauffindbaren `running`-Eintrag. *(3)*
- **AC4** — Beim ersten Laden nach dem Boot wird **jeder** noch-`running`-Eintrag auf `status:'aborted'` (+ `finishedAt`) gesetzt und persistiert (nicht gelöscht); `GET …/drain/:drainId` liefert für eine so verwaiste `drainId` `200 {status:'aborted'}` statt `404`. Die Markierung ist **idempotent** (bereits-terminale Einträge werden nicht erneut angefasst; ein zweiter Load ändert nichts). *(4)*
- **AC5** — Der Boot-Wiederanlauf sammelt die **distinkte** Projektmenge mit ≥1 verwaisten (`aborted`, gerade markierten) Drain, getrennt nach `trigger`, und stößt je distinktem Projekt **genau einen** Wiederanlauf-Drain an (mehrere Orphans desselben Projekts ⇒ **ein** Wiederanlauf — Dedup pro Projekt). *(5)*
- **AC6** — **Manueller Orphan:** je Projekt mit verwaistem `manual`-Drain wird **automatisch** (ohne Bestätigung, A2) ein Wiederanlauf über die manuelle `ProjectDrain`-Instanz gestartet, unter Replay der persistierten `args`/`costMode` **1:1** (A3); ein frischer `running`-Eintrag (neue `drainId`) wird registriert. Vorher lesende `isProjectBusy`-Prüfung → bei Busy **kein** Doppel-Start. *(6)*
- **AC7** — **Nacht-Orphan:** je Projekt mit verwaistem `night`-Drain wird ein Wiederanlauf über die Nacht-`ProjectDrain`-Instanz **nur** gestartet, wenn der Boot-Zeitpunkt **im** Nachtfenster liegt UND Nacht-Modus aktiv UND Auth nicht `expired` (A1); sonst **kein** Boot-Wiederanlauf (Eintrag bleibt `aborted`, regulärer Scheduler-Tick übernimmt im nächsten Fenster). *(7)*
- **AC8** — Der gesamte Boot-Wiederanlauf ist **best-effort/degradierend**: jeder Fehler (Slug-Auflösung, Pfad-Validierung, Store-I/O, Drain-Start) wird gefangen und crasht den **Server-Boot nicht**; die übrigen Projekte werden weiter versorgt. Slug→Pfad via `resolveProjectSlug`+`validateProjectPath` (realpath-Containment); ein nicht mehr auflösbarer Slug wird übersprungen. Ein Wiederanlauf auf einem bereits leeren Board ist ein **idempotenter No-op** (ProjectDrain-Board-Re-Scan, garantierte Konvergenz). *(8)*
- **AC9** — Doku/Drift-Gate: `.claude/CLAUDE.md` + `docs/architecture.md` (neuer **ADR-020**, 2026-07-03, Verweis auf diese Spec) beschreiben die persistente Drain-Registry + Boot-Wiederanlauf; die „Server-Neustart → verloren (Nicht-Ziel/Restrisiko)"-Aussagen in [[headless-parallel-drain]] (Edge-Cases „Server-Neustart", Nicht-Ziele) und [[headless-manual-drain]] (AC4-Zusatz, Nicht-Ziele, Edge-Cases) tragen einen **supersede-/ergänzt-Vermerk** auf diese Spec; `docs/concept.md` erhält einen kurzen Hinweis. Diese Story ändert **ausschließlich** `docs/`/`.claude/`-Dokumente, **keinen** Laufzeit-Code. *(10)*
- **AC10** — Detached-Spawn-Entscheidung: **ADR-020** hält fest, dass detached-Spawn (Punkt 3) **abgelehnt/zurückgestellt** wird, mit den Begründungs-Kernen: (a) `deploy: docker` — ein Container-/Image-Redeploy killt **alle** In-Container-Prozesse unabhängig von `detached`; die dominante Neustart-Art wird dadurch **nicht** abgedeckt; (b) Wiederaufnahme der Ausgabe-Erfassung ist mit dem pipe-basierten `close`-Event-Single-Source-Modell (`HeadlessRunnerCore`) inkompatibel (bräuchte Datei-Redirect + Re-Attach + Re-Parse — grosser Umbau); (c) der idempotente Boot-Wiederanlauf (AC5–AC8) erreicht Konvergenz robuster, und ein halb-überlebender detached-Prozess brächte ein **Doppel-Lauf-Risiko** mit dem Wiederanlauf. Testbar als dokumentierte Entscheidung (kein Laufzeit-Code). *(9)*

## Verträge

### Persistente Registry (`DrainJobRegistry`, erweitert)
- Datei: `${CRED_STORE_DIR}/drain-jobs.json`, Format `{ jobs: [DrainJobEntry] }`, atomar (tmp+rename), `0600`.
- `DrainJobEntry = { drainId, project, trigger:'night'|'manual', status:'running'|'done'|'failed'|'aborted', args?:string[], startedAt:ISO-8601, finishedAt?:ISO-8601 }` — **secret-/pfad-frei**.
- `register(drainId, { project, trigger, args?, startedAt })` → persistiert `running`.
- `markDone(drainId, result)` / `markFailed(drainId, error?)` → persistiert terminalen Status + `finishedAt`; `result`/`error` bleiben secret-frei ([[headless-manual-drain]] AC4-Format).
- `getJob(drainId) → DrainJobState | undefined`.
- `reconcileOrphans()` (o.ä.) → markiert alle `running`-Einträge als `aborted`, persistiert, liefert die verwaisten Einträge (für den Wiederanlauf). Idempotent.
- Degradation: ohne `CRED_STORE_DIR` reiner In-Memory-Betrieb; ohne Persistenz kein Boot-Wiederanlauf (dokumentiertes Rest-Verhalten).

### Boot-Wiederanlauf (Composition-Root / `server.js` beim Start)
- Läuft **einmalig** beim Server-Start, **nach** dem Konstruieren von `manualProjectDrain`/`nightProjectDrain`/`nightWatchScheduler`/`drainJobRegistry`.
- Konsumiert `reconcileOrphans()`, dedupt pro `project`+`trigger`, ruft je Projekt den passenden `ProjectDrain.drainProject(resolvedPath, { args })` fire-and-forget auf (Manual: sofort; Night: fenster-/auth-gated).
- **Keine** neue HTTP-Route nötig; der bestehende `GET …/drain/:drainId` deckt die Monitoring-Sicht ab (jetzt inkl. `aborted` + neuer Wiederanlauf-`drainId`).

### Wiederverwendung
- `DrainReportStore` (`src/DrainReportStore.js`) — Vorlage für die Persistenz (atomarer tmp+rename-Schreibzugriff, `CRED_STORE_DIR`-Degradation, Slug-Härtung, In-Process-Serialisierungs-Kette gegen Read-Modify-Write-Race).
- `DrainJobRegistry` (`src/DrainJobRegistry.js`) — wird von In-Memory auf datei-basiert erweitert (Schema um `project`/`trigger`/`args`/`startedAt`/`finishedAt` + Status `aborted` ergänzt).
- `projectDrainRouter` (`src/projectDrainRouter.js`) — `register()`-Aufruf trägt jetzt `{project(slug),trigger:'manual',args,startedAt}` bei (der Router kennt Slug + `drainArgs` bereits).
- `NightWatchScheduler` (`src/NightWatchScheduler.js`) — `#startDrain` registriert/dereg. zusätzlich in der geteilten Registry (trigger:'night'); `isWithinWindow`/`readSettings`/`claudeAuthHealthService` liefern die Gating-Signale für AC7.
- `ProjectDrain` (`src/ProjectDrain.js`) — unverändert genutzt (Board-Re-Scan-Konvergenz = Idempotenz-Garant); `drainProject(path,{args})` reicht die replay'ten Args durch ([[headless-manual-drain]] AC3).
- `resolveProjectSlug` + `validateProjectPath` (`src/workspacePath.js`) — Slug→Pfad-Re-Auflösung beim Wiederanlauf (realpath-Containment).
- `ClaudeAuthHealthService` (`src/ClaudeAuthHealthService.js`) — Auth-Gate für den Nacht-Wiederanlauf (AC7).
- `AuditStore` (`src/AuditStore.js`) — je Boot-Wiederanlauf-Start ein secret-freier `AuditEntry` (nur Slug + trigger), analog den bestehenden Drain-Audits.

## Edge-Cases & Fehlerverhalten
- **Kein `CRED_STORE_DIR`** → Registry rein In-Memory; kein persistenter Datensatz ⇒ **kein** Boot-Wiederanlauf (erwartetes Rest-Verhalten, dokumentiert; heutiges Verhalten für Deployments ohne Store-Dir).
- **Korrupte/unlesbare `drain-jobs.json`** → leerer Cache (kein Crash, wie `DrainReportStore`); kein Wiederanlauf aus korrupten Daten.
- **Slug löst nach Neustart nicht mehr auf** (Repo entfernt/umbenannt) → Projekt übersprungen, Eintrag bleibt `aborted`, kein Crash (AC8).
- **`isProjectBusy` beim manuellen Wiederanlauf true** (unwahrscheinlich direkt nach Boot, aber z.B. wenn ein Nacht-Wiederanlauf desselben Projekts zuerst startete) → kein Doppel-Start; das Projekt konvergiert über den bereits laufenden Drain.
- **Nacht-Orphan ausserhalb des Fensters** → kein Boot-Lauf; regulärer Scheduler-Tick übernimmt im nächsten Fenster (idempotent, keine verlorene Arbeit — nur verzögert).
- **Wiederanlauf-Drain crasht/failt** → sein Eintrag geht regulär auf `failed`; **kein** erneuter Auto-Wiederanlauf in derselben Boot-Runde (Endlos-Restart-Schleifen-Schutz: Wiederanlauf gilt nur für Orphans aus einem **früheren** Prozess-Leben, nicht für in **dieser** Boot-Runde selbst gestartete Läufe).
- **Detached-Spawn (abgelehnt, AC10)** → in `deploy: docker` killt ein Container-Redeploy ohnehin alle Prozesse; Ausgabe-Re-Capture ist mit dem pipe-`close`-Modell inkompatibel; Doppel-Lauf-Risiko mit dem Boot-Wiederanlauf.
- **Gleichzeitiges Schreiben** (manueller + Nacht-Wiederanlauf fast zeitgleich) → In-Process-Serialisierungs-Kette + atomares tmp+rename (Muster `DrainReportStore`) verhindern eine korrupte Datei.

## NFRs
- **Sicherheit (Floor):** die persistente Datei enthält **nur** Slug + `drainId` (Korrelations-UUID) + trigger/status/args (Cost-Mode-Enum) + Zeitstempel — **keine** absoluten Host-Pfade, Tokens, Roh-Fehlertexte; `project` gegen einen Slug-Form-Check gehärtet (analog `DrainReportStore.PROJECT_SLUG_RE`); Rechte `0600`. Der Boot-Wiederanlauf nutzt ausschliesslich die validierte Slug→Pfad-Auflösung (realpath-Containment gegen `WORKSPACE_DIR`) — **kein** Freitext-Pfad aus der Datei.
- **Robustheit/Degradation:** Registry-Persistenz **und** Boot-Wiederanlauf sind best-effort — ein Fehler crasht **weder** einen Drain **noch** den Scheduler **noch** den Server-Boot. Ohne `CRED_STORE_DIR` fällt die Robustheit sauber auf das heutige In-Memory-Verhalten zurück.
- **Idempotenz:** Orphan-Markierung + Boot-Wiederanlauf sind idempotent (Dedup pro Projekt; ProjectDrain-Board-Re-Scan-Konvergenz; kein Doppel-Lauf; kein Restart der in dieser Boot-Runde gestarteten Läufe).
- **Isolation:** die Persistenz importiert/mutiert **weder** `PtyManager`/`PtySessionRegistry` **noch** den interaktiven `CommandService`-Schreibpfad (Trust-Boundary, analog [[headless-parallel-drain]]/[[headless-reconcile-runner]]). Manueller + Nacht-Wiederanlauf nutzen ihre jeweils **eigenen** `ProjectDrain`/`ProjectJobLock`-Instanzen (keine Lock-Vermischung, [[headless-manual-drain]] AC2).
- **Testbarkeit:** injizierbare Uhr + injizierbarer Store-Pfad + gemockte `ProjectDrain`/`spawn` — alle AC ohne echten `claude`-Lauf prüfbar (analog [[headless-parallel-drain]] AC13). Kein echter `claude -p`-Live-Lauf im Test-Gate.

## Nicht-Ziele
- **Kein** detached-Spawn / kein Überleben von Kindprozessen über den Server-Neustart hinaus (bewusst abgelehnt, ADR-020 / AC10).
- **Keine** unbegrenzte Job-Historie — die persistente Registry ist eine kleine Betreiber-nahe Beobachtbarkeits-Ablage (ADR-005-Linie, analog `DrainReportStore`); ein Rückschnitt (z.B. terminale Einträge älter als N Tage / letzte N je Projekt) ist zulässig, aber **keine** grosse Historie.
- **Keine** Änderung der `ProjectDrain`-Drain-/Abbruch-/Eskalations-Logik selbst (nur additive Erfassung + Wiederanlauf-Anstoß).
- **Kein** neuer öffentlicher HTTP-Endpunkt (der bestehende `GET …/drain/:drainId` genügt; die Boot-Recovery ist ein interner Start-Schritt).
- **Kein** echter `claude -p`-Live-Lauf im Test-Gate (gemockte `ProjectDrain`/`spawn`).
- **Keine** neue User-Einstellung (Boot-Wiederanlauf ist Default-Verhalten; Nacht-Gating nutzt die bestehenden Ticker-Settings).

## Abhängigkeiten
- [[headless-manual-drain]] (`DrainJobRegistry`, `projectDrainRouter`, manueller Drain-Status, `--cost`-Args — erweitert; „Server-Neustart = Nicht-Ziel" wird superseded) · [[headless-parallel-drain]] (`HeadlessFlowRunner`, Nacht-Drain, `ProjectJobLock`; „Server-Neustart = Restrisiko" wird superseded) · [[taktgeber-nachtwaechter]] (`ProjectDrain`-Engine, `NightWatchScheduler`, Nachtfenster/`isWithinWindow`, `#activeDrains`) · [[drain-completion-report]] (`DrainReportStore`-Persistenz-Muster; der Abschlussbericht bleibt die getrennte, GUI-nahe Sicht) · [[claude-auth-health]] (Auth-Gate für den Nacht-Wiederanlauf) · [[claude-code-oauth-token]] (`CLAUDE_CODE_OAUTH_TOKEN`).
- **Doku-Anpassung (eigenes Board-Item, AC9/AC10):** `docs/architecture.md` (ADR-020) + `.claude/CLAUDE.md` + supersede-Vermerke in [[headless-parallel-drain]]/[[headless-manual-drain]] + `docs/concept.md`.
