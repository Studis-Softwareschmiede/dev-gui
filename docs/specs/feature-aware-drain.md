---
id: feature-aware-drain
title: Feature-bewusster ProjectDrain/Nachtwächter — Feature-Drain statt Einzel-/flow bei Mehr-Story-Features
status: active
area: nachtwaechter
version: 1
spec_format: use-case-2.0
---

# Spec: Feature-bewusster ProjectDrain/Nachtwächter  (`feature-aware-drain`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
`ProjectDrain` (manueller „Board abarbeiten"-Knopf) und der `NightWatchScheduler` (Nachtwächter) wählen den Abarbeitungs-Modus künftig **auf Feature-Ebene**: Gehört die nächste bereite `To Do`-Story zu einem **Parent-Feature mit mehreren bereiten Storys**, wird der **Feature-Drain** `board-feature-drain.sh F-###` (agent-flow, arbeitet alle Storys des Features sequenziell in frischen `/flow`-Sessions ab und schreibt Run-State nach `board/runs/F-###/`) gestartet — statt vieler einzelner `/flow`-Läufe. **Einzelgänger-Storys** (Feature mit nur **einer** bereiten Story) laufen **wie bisher** über `/agent-flow:flow`. Alle bestehenden Leitplanken gelten unverändert auch für Feature-Drain-Läufe.

> **Cross-Repo-Abhängigkeit:** Umsetzbar erst, wenn agent-flow `feature-batch-orchestration` v2 (das Skript `board-feature-drain.sh` samt Run-State-Schreiben nach `board/runs/F-###/`) gelandet ist. dev-gui **startet und überwacht** den Feature-Drain, es implementiert das Skript **nicht**.

> **Was NICHT geändert wird (bewusst verworfen, nicht spezifizieren):** Orchestratoren als lebende LLM-Kontexte, **parallele** Features (innerhalb eines Projekts), Feature-PRs. Der Feature-Drain arbeitet ein Feature **sequenziell** ab; die Projekt-Parallelität des Nachtwächters (`maxParallel` über **verschiedene** Projekte) bleibt unverändert.

## Verhalten

### Feature-Ebenen-Auswahl (gemeinsame Engine)
1. **Auswahlregel.** Vor dem Anstoßen einer Drain-Runde bestimmt die Engine die nächste **bereite** `To Do`-Story (Drain-Ziel gemäß `BoardAggregator.computeStoryReadyStatus`, [[taktgeber-nachtwaechter]] AC1 — die **maßgebliche** ready-Regel, hier nicht neu definiert). Aus deren **Parent-Feature** (`parent: F-###`) wird zuerst geprüft, ob es ein **Bereichs-Container-Feature** ist — **1:1-Zählung**: das `area`-Feld ist gesetzt UND das Feature ist das **einzige** Feature des Projekts mit genau diesem `area`-Wert (Zählung über alle Features des Projekts, nicht reine Presence-Prüfung; `board/feature.schema.json`/[[board-areas]] AC2 — ein Feature 1:1 gekoppelt an einen `areas.yaml`-Eintrag, das dauerhaft ist und nie automatisch `Done`/`Archived` wird), danach die Anzahl **bereiter** Storys ermittelt:
   - **Bereichs-Container-Feature** (`area`-Feld gesetzt UND kein anderes Feature des Projekts teilt denselben `area`-Wert) → **NIE** Feature-Drain, unabhängig von der Anzahl bereiter Storys — starte **immer** `/agent-flow:flow` (Einzel-Story-Lauf, unveränderter Pfad). Grund: ein Bereichs-Container sammelt fortlaufend neue Storys und ist per Design nie „alle-fertig"; ein Feature-Batch würde bei einer einzigen blockierten Geschwister-Story den gesamten Feature-Branch einfrieren und bereits fertige Geschwister-Storys nie nach `main` mergen (verifizierter Vorfall F-019/S-062/S-061, PR #322).
   - **`area`-Feld gesetzt, ABER von mehreren Features geteilt** (reine Kachel-Kategorisierung, kein 1:1-Bereichs-Signal) → **kein** Bereichs-Container, normales ≥2-Schwellen-Verhalten gilt (s. u.).
   - **kein Bereichs-Container UND ≥ 2 bereite Storys** im Parent-Feature → starte **`board-feature-drain.sh F-###`** (ein Feature-Drain für dieses Feature) statt einzelner `/flow`-Läufe.
   - **kein Bereichs-Container UND genau 1 bereite Story** im Parent-Feature (Einzelgänger) → starte **wie bisher** `/agent-flow:flow` (Einzel-Story-Lauf, unveränderter Pfad).
2. **„Bereit" ist identisch zur bestehenden Drain-Ziel-Definition** ([[taktgeber-nachtwaechter]] AC1/AC3): `To Do` mit `ready==true`. `Blocked`, `Idee`, `Done` und nicht-ready `To Do` zählen **nicht** als bereite Storys des Features (weder für die ≥2-Schwelle noch als Drain-Ziel). Stories **ohne** `parent` gelten als Einzelgänger (kein Feature-Drain).
3. **Ein Feature-Drain zählt als eine Drain-Runde** der Engine: `ProjectDrain.drainProject()` stößt pro Runde **entweder** einen Feature-Drain **oder** einen Einzel-`/flow` an; danach re-scannt es das Board und entscheidet erneut (AC1). Die zustandsbasierte Abbruch-/Konvergenz-Regel ([[taktgeber-nachtwaechter]] AC2) bleibt unverändert: gestoppt wird, wenn kein Drain-Ziel mehr existiert und keines durch Vorgänger ready werden kann.

### Ausführung des Feature-Drains (headless, wie /flow)
4. Der Feature-Drain wird **headless** als Kindprozess gestartet — **analog** zum bestehenden headless-Ausführungspfad ([[headless-manual-drain]] / [[headless-parallel-drain]]): eigener Kindprozess, **kein** PTY-Write, argv als **Array** (kein Shell-String), gleiche Env-Härtung (**kein** Anthropic-/OpenAI-API-Key in der Child-Env), gleiche Timeout-/`close`-Disziplin. `F-###` wird gegen `^F-\d+$` validiert (kein Freitext, keine Argument-Injektion) und muss ein real existierendes Parent-Feature des Projekts sein.
5. Die **Lokalisierung** des Skripts `board-feature-drain.sh` (agent-flow-Plugin) erfolgt über den bestehenden Plugin-Cache-Auflösungsmechanismus (Muster `ensure-gh-auth.sh`, robuste Glob-Auflösung auf die aktuellste Plugin-Version) — **kein** hartkodierter absoluter Pfad. Fehlt das Skript (agent-flow-Version ohne `feature-batch-orchestration` v2) → der Feature-Drain-Modus ist **nicht** verfügbar; die Engine fällt sauber auf den Einzel-`/flow`-Pfad zurück (graceful degradation, auditiert), statt zu crashen.

### Leitplanken (unverändert, auch für Feature-Drain)
6. **JobLock max 1 pro Projekt:** ein Feature-Drain hält dasselbe projektweise `ProjectJobLock` wie ein Einzel-`/flow`-Lauf ([[taktgeber-nachtwaechter]] AC6/AC7). Ein zweiter Drain (Feature **oder** Einzel) fürs **selbe** Projekt bei gehaltenem Lock wird abgelehnt (`already-busy`/`409`). Die Projekt-Parallelität des Nachtwächters (`maxParallel`, **verschiedene** Projekte) bleibt unverändert.
7. **TokenLimitWatcher / BudgetGuard:** die konto-weite Token-Limit-Erkennung ([[taktgeber-nachtwaechter]] AC13/AC14) und der Nacht-Budget-Schutz ([[night-budget-guard]]/[[headless-budget-limit-detection]]) gelten für Feature-Drain-Läufe **genauso** — Limit/Budget pausiert/stoppt auch einen laufenden bzw. den nächsten Feature-Drain; limit-/budget-bedingte Pausen erhöhen **nie** den Eskalations-Zähler.
8. **Eskalation nach 3× kein Fortschritt:** die zustandsbasierte Fortschritts-/Eskalationslogik ([[taktgeber-nachtwaechter]] AC4/AC5) greift unverändert. Endet eine Runde (Feature-Drain **oder** Einzel-`/flow`) ohne beobachtbare Zustandsänderung einer Drain-Ziel-Story, zählt der kein-Fortschritt-Zähler hoch; nach `escalationAttempts` (Default 3) aufeinanderfolgenden fortschrittslosen Runden setzt der Taktgeber die am längsten unbewegte Drain-Ziel-Story selbst auf `Blocked` (`blocked_reason: "Taktgeber: Nx kein Fortschritt"`). Ein Feature-Drain, der ≥1 Story auf `Done` bringt, gilt als Fortschritt (Zähler-Reset).
9. **Sanftes Ende / Nachtfenster:** ab `window.end` startet der Nachtwächter **keinen** neuen Feature-Drain; ein bereits laufender Feature-Drain wird **nicht** abgebrochen, sondern zu Ende geführt ([[taktgeber-nachtwaechter]] AC11) — die Feature-Drain-interne Sequenz respektiert das übergebene Fensterende (agent-flow-seitig).

## Acceptance-Kriterien

- **AC1** — Feature-Ebenen-Auswahl: vor jeder Drain-Runde ermittelt die Engine die nächste bereite `To Do`-Story und daraus, ob ihr Parent-Feature ein **Bereichs-Container** ist — **1:1-Zählung**: `area`-Feld gesetzt UND kein anderes Feature des Projekts trägt denselben `area`-Wert (Zählung über alle Features des Projekts, `board/feature.schema.json`/[[board-areas]] AC2) — sowie die Anzahl bereiter Storys dieses Parent-Features. Ist das Parent-Feature ein **Bereichs-Container** → **immer** `/agent-flow:flow` (Einzel-Story), **unabhängig von der Anzahl bereiter Storys** (Bereichs-Container batchen NIE — verifizierter Vorfall F-019/S-062/S-061, PR #322). Teilen sich **mehrere** Features denselben `area`-Wert (reine Kachel-Kategorisierung, kein 1:1-Signal) → **kein** Bereichs-Container, normales Schwellen-Verhalten gilt. Andernfalls: **≥ 2** bereite Storys → **`board-feature-drain.sh F-###`** wird gestartet (Feature-Drain); **genau 1** (oder Story ohne `parent`) → **`/agent-flow:flow`** wie bisher (Einzel-Story). *(1,3)*
- **AC2** — „Bereit" ist die bestehende Drain-Ziel-Definition (`To Do` + `ready==true` gemäß `computeStoryReadyStatus`, [[taktgeber-nachtwaechter]] AC1/AC3, hier **nicht** neu definiert); `Blocked`/`Idee`/`Done`/nicht-ready `To Do` zählen **nicht** — weder zur ≥2-Schwelle noch als Drain-Ziel. Die Bereichs-Container-Ausnahme (AC1, 1:1-Zählung) ist der ≥2-Schwelle **vorgelagert**: bei einem Bereichs-Container-Feature wird die ≥2-Schwelle gar nicht erst ausgewertet. *(2)*
- **AC3** — Ein Feature-Drain zählt als **eine** Drain-Runde; danach re-scannt `drainProject()` und entscheidet erneut. Die zustandsbasierte Abbruch-/Konvergenz-Regel ([[taktgeber-nachtwaechter]] AC2) bleibt **unverändert** (keine fortschrittsbasierte Bremse). *(3)*
- **AC4** — Headless-Start: der Feature-Drain läuft als Kindprozess (**kein** PTY-Write), argv als **Array**, `F-###` gegen `^F-\d+$` validiert + als real existierendes Parent-Feature geprüft (kein Freitext, keine Injektion); **kein** Anthropic-/OpenAI-API-Key in der Child-Env (harter Floor, [[headless-parallel-drain]] AC1); Audit je Start/Ende/Fehler, secret-/pfad-frei. *(4)*
- **AC5** — Skript-Lokalisierung über den bestehenden Plugin-Cache-Glob (Muster `ensure-gh-auth.sh`), **kein** hartkodierter absoluter Pfad. Fehlt `board-feature-drain.sh` → Feature-Drain-Modus **nicht** verfügbar, saubere Rückfall-Auswahl auf Einzel-`/flow` (graceful, auditiert), **kein** Crash. *(5)*
- **AC6** — JobLock: ein Feature-Drain hält dasselbe projektweise `ProjectJobLock` wie ein Einzel-`/flow`; ein zweiter Drain (Feature/Einzel) fürs selbe Projekt bei gehaltenem Lock → abgelehnt (`already-busy`/`409`). Projekt-Parallelität (`maxParallel`, verschiedene Projekte) unverändert; **kein** paralleler Feature-Drain **desselben** Projekts. *(6)*
- **AC7** — TokenLimit/Budget: konto-weite Token-Limit-Erkennung ([[taktgeber-nachtwaechter]] AC13/AC14) und Nacht-Budget-Schutz ([[night-budget-guard]]) gelten für Feature-Drain-Läufe unverändert; limit-/budget-bedingte Pausen/Fehlläufe erhöhen **nie** den Eskalations-Zähler und setzen **keine** Story auf `Blocked`. *(7)*
- **AC8** — Eskalation nach 3× kein Fortschritt ([[taktgeber-nachtwaechter]] AC4/AC5) greift unverändert für beide Modi; ein Feature-Drain, der ≥1 Story auf `Done` bringt, ist Fortschritt (Zähler-Reset). Sanftes Ende ([[taktgeber-nachtwaechter]] AC11): ab `window.end` **kein** neuer Feature-Drain, laufender wird zu Ende geführt. *(8,9)*

## Verträge

### Engine-Schnittstelle (sprach-neutral, additiv)
- `ProjectDrain.drainProject(projectPath, opts)` — unverändertes Ergebnis-Objekt ([[taktgeber-nachtwaechter]] Verträge) plus interner Modus-Entscheid je Runde: `mode ∈ {"feature-drain","single-flow"}`. `reason`-Werte bleiben kompatibel; ein fehlendes Skript liefert **kein** neues Terminal-`reason`, sondern den Einzel-`/flow`-Rückfall (AC5).
- **Feature-Drain-Start:** Kindprozess `board-feature-drain.sh <F-###>` (headless, argv-Array), Skriptpfad via Plugin-Cache-Glob aufgelöst. Reicht dem Skript das Nachtfenster-Ende durch (analog dem `windowEndMs`-Pfad, agent-flow-seitig interpretiert).
- **Einzel-`/flow`-Start:** unverändert `flowRunner.startRun({ command: '/agent-flow:flow', args })` bzw. `CommandService.tryRun()` ([[taktgeber-nachtwaechter]] / [[headless-manual-drain]]).

### Wiederverwendung
- `ProjectDrain` (`src/ProjectDrain.js`) — Auswahl-/Abbruch-/Eskalationslogik; **additiv** um die Feature-Ebenen-Auswahl (AC1) + den Feature-Drain-Ausführungsschritt (AC4).
- `NightWatchScheduler` (`src/NightWatchScheduler.js`) — Projekt-Auswahl/Parallelität/Nachtfenster unverändert; nutzt `drainProject()`, das nun feature-bewusst entscheidet.
- `HeadlessFlowRunner`/`HeadlessFlowRunnerAdapter` (`src/HeadlessFlowRunner.js`) — Muster für headless Kindprozess-Start (Env-Härtung, Timeout, `close`, Audit); der Feature-Drain-Start folgt demselben Muster (anderes Kommando/argv).
- `ProjectJobLock`, `TokenLimitWatcher` (`src/TokenLimitWatcher.js`), `AuditStore`, `BoardAggregator`+`computeStoryReadyStatus` — unverändert.
- Plugin-Cache-Glob-Auflösung (Muster `ensure-gh-auth.sh`, `.claude/CLAUDE.md`) — Skript-Lokalisierung.

## Edge-Cases & Fehlerverhalten
- **Skript `board-feature-drain.sh` fehlt** (agent-flow ohne v2) → Feature-Drain-Modus deaktiviert, Einzel-`/flow`-Rückfall, auditiert; kein Crash (Cross-Repo-Reihenfolge-Schutz).
- **`F-###` ungültig / kein reales Parent-Feature** → kein Feature-Drain-Start, Einzel-`/flow`-Rückfall bzw. sauberer Fehler; keine Argument-Injektion (argv-Array + Regex-Validierung).
- **Parent-Feature ist ein Bereichs-Container** (1:1-Zählung: `area`-Feld gesetzt UND einziges Feature des Projekts mit diesem `area`-Wert, ≥2 bereite Storys) → **kein** Feature-Drain-Start, Einzel-`/flow`-Rückfall (AC1) — bewusstes Design, kein Fehlerfall (Bereichs-Container sind per Definition nie „alle-fertig").
- **Mehrere Features teilen sich denselben `area`-Wert** (reine Kachel-Kategorisierung, kein 1:1-Bereichs-Signal, z.B. dev-gui vor der `F-064`-Bereichs-Migration) → **keines** von ihnen gilt als Bereichs-Container; normales ≥2-Schwellen-Verhalten greift unverändert.
- **Bekannter, akzeptierter Trade-off:** ein Feature, das zufällig das **einzige** Feature des Projekts mit einem bestimmten `area`-Wert ist, ohne selbst ein echter Bereichs-Container im eigentlichen Sinn zu sein (z.B. `F-050-obsidian-notizen…`, `area: obsidian`, aktuell einziges Feature dieses Bereichs), wird unter der 1:1-Heuristik ebenfalls als Bereichs-Container eingestuft (False Positive) und daher nie gebatcht. Das ist **sicher**, aber konservativ: es fällt nur auf das alte Einzel-`/flow`-Verhalten zurück (kein Risiko, keine eingefrorenen fertigen Geschwister-Storys). Bewusst akzeptiert bis `F-064` (Bereichs-Migration, dev-gui) landet und die 1:1-Struktur projektweit herstellt — **kein** erneut zu meldender Bug.
- **Feature-Drain-Kindprozess crasht / Timeout** → Runde zählt als fortschrittsloser Lauf (Eskalations-Zähler, AC8) **außer** bei Limit-/Budget-Ursache (AC7); Lock im `finally` frei; Drain konvergiert.
- **Feature verliert während des Laufs Storys** (z.B. eine Story wird `Blocked`) → nächste Runde re-scannt frisch (AC3); Auswahl bleibt zustandsbasiert korrekt.
- **`maxParallel>1` (Nachtwächter):** verschiedene Projekte laufen weiter parallel; **desselben** Projekts nie zwei Drains (AC6).
- **Fensterende während laufendem Feature-Drain** → laufender Drain wird zu Ende geführt (sanftes Ende), kein neuer Feature-Drain gestartet (AC8).

## NFRs
- **Sicherheit (Floor):** kein API-Key in der Child-Env; argv als Array (keine Shell-Interpolation); `F-###` streng validiert; Pfad-/Slug-Validierung wie bisher (`resolveProjectSlug`+`validateProjectPath`, realpath-Containment); keine Secrets/Tokens/absoluten Host-Pfade in Audit/Log/Response.
- **Robustheit:** ein fehlendes/fehlerhaftes Feature-Drain-Skript kippt weder den Drain noch den Scheduler (degradierend, Einzel-`/flow`-Rückfall). Ein Projekt-/Provider-Fehler kippt den Gesamt-Tick nicht ([[taktgeber-nachtwaechter]] NFR).
- **Token-Sparsamkeit:** der Feature-Drain bündelt die Storys eines Features in eine Kontext-getragene Sequenz (Dossier einmalig, Handoff-Notizen) — token-effizienter als isolierte Einzel-`/flow`-Läufe; das ist der Kern-Nutzen (Effizienz liegt agent-flow-seitig, dev-gui löst nur aus).

## Nicht-Ziele
- **Kein** paralleles Abarbeiten **mehrerer Features** eines Projekts (bewusst verworfen); Feature-Drain ist sequenziell.
- **Keine** Orchestratoren als lebende LLM-Kontexte, **keine** Feature-PRs (bewusst verworfen).
- **Keine** Implementierung von `board-feature-drain.sh` oder des `state.yaml`-Schreibens (agent-flow).
- **Keine** Änderung der bestehenden Abbruch-/Konvergenz-/Eskalations-Regeln ([[taktgeber-nachtwaechter]] AC2/AC4) — nur der Modus-Entscheid je Runde ist neu.
- **Keine** Änderung der Projekt-Parallelität (`maxParallel`) des Nachtwächters.

## Abhängigkeiten
- **agent-flow `feature-batch-orchestration` v2** (Cross-Repo, bindend: `board-feature-drain.sh` + Run-State-Schreiben nach `board/runs/F-###/`) — umsetzbar erst danach.
- [[taktgeber-nachtwaechter]] (`ProjectDrain`-Engine, Drain-Ziel/`ready`-Regel, Abbruch/Eskalation, ProjectJobLock, TokenLimit, Nachtfenster — Wiederverwendung; nur additive Feature-Auswahl).
- [[headless-manual-drain]] / [[headless-parallel-drain]] (headless Kindprozess-Ausführungspfad, Env-Härtung, Audit — Muster für den Feature-Drain-Start).
- [[night-budget-guard]] / [[headless-budget-limit-detection]] (Budget-/Limit-Schutz, gilt für Feature-Drain-Läufe unverändert).
- [[run-state-live-view]] (zeigt den Run-State an, den die hier gestarteten Feature-Drains schreiben) · `.claude/CLAUDE.md` (Plugin-Cache-Glob-Muster `ensure-gh-auth.sh`).
</content>
