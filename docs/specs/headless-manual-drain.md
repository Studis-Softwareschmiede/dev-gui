---
id: headless-manual-drain
title: Manueller „Board abarbeiten"-Knopf läuft headless (claude -p) + Cost-Mode am Button
status: draft
version: 1
spec_format: use-case-2.0
---

# Spec: Manueller Headless-Board-Drain  (`headless-manual-drain`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der manuelle **„Board abarbeiten"-Knopf** (Fabrik-Panel, „Arbeiten"-Tab, rechte Sidebar) startet den Board-Drain künftig **headless** (`claude -p '/agent-flow:flow'` als eigener Kindprozess) — **analog** zum bestehenden headless-Nacht-Drain ([[headless-parallel-drain]]), statt wie bisher `/agent-flow:flow` **interaktiv** über den PTY-`CommandService` zu injizieren. Das **Cost-Mode-Dropdown** (Token-Hebel) wandert direkt an diesen Knopf, weil es genau diesen Board-Lauf steuert. Der generische „TRIGGER"-Bereich (Befehl-Dropdown + freie Befehlswahl) wird dabei verschlankt.

> **Doktrin-Änderung (Owner-Entscheidung 2026-07-01):** Bislang hielten `.claude/CLAUDE.md`, [[headless-parallel-drain]] (AC1/AC6) und [[taktgeber-nachtwaechter]] (AC12) fest, dass der **manuelle** „Board abarbeiten"-Knopf (S-196) **ausschließlich interaktiv** bleibt (reiner PTY-Pfad). Diese Spec setzt die **bewusste Owner-Entscheidung** um, auch diesen Knopf auf den bereits vorhandenen, auditierten Headless-Pfad umzustellen (analog zur letzten Erweiterung ADR-016 / [[idea-specify-chat]]). Mit Annahme dieser Spec MÜSSEN `.claude/CLAUDE.md` und `docs/architecture.md` angepasst werden (neuer ADR, nächste freie Nummer **ADR-017**; ADR-015 wird als „ergänzt" markiert, nicht rückwirkend umgeschrieben) und die o.g. Absolutaussagen in [[headless-parallel-drain]] / [[taktgeber-nachtwaechter]] als **superseded** markiert — sonst entsteht Doktrin-Drift (hartes `reviewer`-Gate). **AC7.**

> **Was NICHT umgebaut wird:** Der interaktive PTY-Pfad (`CommandService`/`PtyManager`/Terminal-Pane) bleibt **vollständig bestehen** und **unverändert** — er ist weiterhin der Pfad für das freie Terminal und die verschlankte Befehls-Auslösung (adopt/preview/train/new-project) sowie den Kill-Switch. Nur der **Ausführungspfad des „Board abarbeiten"-Knopfs** wechselt von interaktiv auf headless.

## Verhalten

### Headless-Ausführung des manuellen Drains
1. `POST /api/projects/:slug/drain` startet den Drain über eine **eigene, headless verdrahtete `ProjectDrain`-Instanz** (`HeadlessFlowRunnerAdapter` um eine **eigene `HeadlessFlowRunner`-Instanz** mit **eigener `ProjectJobLock`-Instanz**), **nicht** mehr über den interaktiven `InteractiveFlowRunner`/`CommandService`. Der Flow-Schritt jeder Drain-Runde ist damit ein `claude -p '/agent-flow:flow …'`-Kindprozess (kein PTY-Write, kein globaler PTY-Lock).
2. Die **eigene** `ProjectJobLock`-Instanz dieses manuellen Headless-Drains ist **bewusst getrennt** von den Locks des Nacht-Drains, des Reconcile-Runners und des `IdeaSpecifyFinalizer`s (sonst blockiert ein laufender Nacht-/Finalize-/Reconcile-Lauf fürs selbe Projekt fälschlich den manuellen Drain und umgekehrt). `ProjectDrain` selbst hält weiterhin sein projektweises Session-Lock über die Dauer der gesamten Drain-Session (unverändert).
3. **Kein Live-Terminal:** Ein headless-Drain schreibt **nicht** in die interaktive PTY-Session — es erscheint **keine** Live-Ausgabe im Terminal-Pane (wie beim Nacht-Drain). Fortschritt/Ergebnis werden über den Board-Re-Fetch (Karten-Updates), das Audit-Log und den Drain-Job-Status (AC3) sichtbar. Der Terminal-Pane bleibt für das freie interaktive Arbeiten unberührt.
4. Die **gesamte** übrige `ProjectDrain`-Logik (Drain-Ziel-/`ready`-Auswahl, zustandsbasierte Abbruch-/Konvergenz-Regel, Eskalation-auf-`Blocked`, Snapshot-Diff-Fortschritt, Sicherheitsgürtel, `isProjectBusy`-Erkennung, Audit) bleibt **unverändert** ([[taktgeber-nachtwaechter]] AC1–AC7, [[headless-parallel-drain]] AC5). Nur der Ausführungs-/Auth-Pfad ist headless.

### Cost-Mode am Board-Knopf
5. Der Drain-Endpunkt akzeptiert einen **optionalen Cost-Mode** und reicht ihn als `--cost <mode>`-Argument an den headless `/agent-flow:flow`-Befehl durch (der Runner reicht Args nur durch — die Modell-Auflösung liegt in agent-flow, [[flow-trigger]] AC8/AC9). Gültige Modi: `low-cost | balanced | max-quality | frontier` (Enum, identisch zu [[flow-trigger]]). `balanced` (Default) → **kein** Flag; `low-cost|max-quality|frontier` → `--cost <mode>` direkt nach dem Befehls-Präfix. Der Cost-Mode gilt für **alle** Flow-Runden desselben Drains.
6. Die Cost-Mode-Validierung ist **serverseitig** autoritativ (command-agnostisch, neben der Allowlist, wie [[flow-trigger]] AC8): ein ungültiger Modus → `400`, **kein** Drain-Start.

### Drain-Job-Status (Feedback)
7. Ein manueller Drain wird in einer **In-Memory-Job-Registry** (Muster [[headless-reconcile-runner]] / `IdeaSpecifyFinalizer`) geführt (`drainId → { status: 'running'|'done'|'failed', … }`). `GET /api/projects/:slug/drain/:drainId` liefert den aktuellen Status — secret-/pfad-frei. So sieht der Owner „läuft / fertig / fehlgeschlagen" trotz fehlender Live-Terminal-Ausgabe.

### Frontend (Fabrik-Panel, „Arbeiten"-Tab)
8. Das Cost-Mode-Dropdown (Token-Hebel, 4-Wege `low-cost|balanced|max-quality|frontier`, Default `balanced`, samt grober Tier-/Kosten-Orientierung + Abo-Disclaimer wie [[flow-trigger]] AC10) sitzt **direkt beim „Board abarbeiten"-Knopf** und wird beim Klick als `costMode` an den Drain-Endpunkt mitgeschickt.
9. Nach `202` pollt das Panel den Drain-Job-Status (AC3) und zeigt „läuft / fertig / fehlgeschlagen" **neben** dem Knopf; bei `done` löst es ein **Board-Re-Fetch** aus. Ein **Hinweis** macht klar, dass **keine** Live-Terminal-Ausgabe mehr erscheint (Erwartungsmanagement). Der Bestätigungsdialog vor dem Start bleibt (kein versehentlicher Lauf).
10. Der generische „TRIGGER"-Bereich (`TriggerPanel`) wird **verschlankt**: `flow` und der **Cost-Mode-Schalter** entfallen dort (Board-Lauf läuft nun über den dedizierten Knopf); die restlichen Befehle **`adopt` / `preview` / `train` / `new-project`** und der **Kill-Switch** bleiben (interaktiver PTY-Pfad, unverändert).

## Acceptance-Kriterien

- **AC1** — `POST /api/projects/:slug/drain` führt den Drain **headless** aus: über eine dedizierte, headless verdrahtete `ProjectDrain`-Instanz (`HeadlessFlowRunnerAdapter` um eine eigene `HeadlessFlowRunner`-Instanz), deren Flow-Schritt ein `claude -p '/agent-flow:flow …'`-Kindprozess ist (kein PTY-Write, kein globaler PTY-Lock). Der interaktive `CommandService`-/PTY-Pfad wird für den Flow-Schritt **nicht** mehr benutzt. Audit je Lauf (Start/Ende/Fehler, [[headless-parallel-drain]] AC11) — keine Secrets/Token/absoluten Host-Pfade in Audit/Log/Response. *(1,3,4)*
- **AC2** — Die dedizierte Headless-`ProjectDrain`-Instanz des manuellen Knopfs hält eine **eigene** `ProjectJobLock`-Instanz, **getrennt** von Nacht-Drain, Reconcile-Runner und `IdeaSpecifyFinalizer`: ein laufender Nacht-/Finalize-/Reconcile-Lauf fürs selbe Projekt blockiert den manuellen Drain **nicht** strukturell über einen geteilten Lock (und umgekehrt). Ein zweiter manueller Drain fürs **selbe** Projekt bei bereits laufendem Drain → `409` (`isProjectBusy`, unverändert). *(2)*
- **AC3** — Cost-Mode-Durchreichung: `POST …/drain` akzeptiert optional `{ costMode }` ∈ `{low-cost, balanced, max-quality, frontier}`; `balanced`/fehlend → **kein** Flag; sonst wird `--cost <mode>` direkt nach dem Präfix an den headless `/agent-flow:flow`-Befehl gehängt und gilt für **alle** Flow-Runden des Drains. `ProjectDrain` reicht die Args an `flowRunner.startRun({ args })` durch. Ungültiger Modus → `400`, **kein** Drain-Start (command-agnostische Validierung neben der Allowlist, [[flow-trigger]] AC8). *(5,6)*
- **AC4** — Drain-Job-Status: ein manueller Drain wird in einer In-Memory-Registry geführt; `GET /api/projects/:slug/drain/:drainId` → `200 { status: 'running'|'done'|'failed', … }` | `404` (unbekannte drainId). Secret-/pfad-frei; Format analog [[headless-reconcile-runner]]-Status. Registry-Verlust bei Server-Neustart ist Nicht-Ziel. *(7)* **Superseded/ergänzt (ADR-020, 2026-07-03):** die Registry ist seither datei-basiert persistiert (überlebt einen Server-Neustart, `status:'aborted'` statt `404` für verwaiste Einträge) + ein Boot-Wiederanlauf ist verdrahtet — das Vertragsformat dieses Endpunkts bleibt dabei **unverändert**, siehe [[drain-restart-robustness]] (AC1–AC8).
- **AC5** — Frontend Cost-Mode am Knopf: das Cost-Mode-Dropdown (4-Wege, Default `balanced`, grobe Tier-/Kosten-Orientierung + Abo-Disclaimer, geteilt via `costMode.js`) sitzt **beim „Board abarbeiten"-Knopf** und wird als `costMode` an `POST …/drain` gesendet (`balanced` → Feld weggelassen oder `balanced`, Server lässt Flag weg). *(8)*
- **AC6** — Frontend Feedback + Hinweis: nach `202` pollt das Panel `GET …/drain/:drainId` und zeigt „läuft / fertig / fehlgeschlagen" **inline neben** dem Knopf (Status immer TEXTLICH, nie nur über Farbe); bei `done` triggert das Panel ein **Board-Re-Fetch**. Der frühere `202`→`onNavigate('factory')`-Terminal-Pane-Wechsel (fabric-intake-dialog AC8 / taktgeber-nachtwaechter AC12) entfällt für diesen Knopf — der Drain läuft headless, es gibt kein Live-Terminal (AC1/AC7). Ein sichtbarer **Hinweis** stellt klar, dass **keine** Live-Terminal-Ausgabe erscheint. Der Bestätigungsdialog + die Busy-Deaktivierung des Knopfs bleiben erhalten. *(3,9)*
  - **Präzisierung (Coder S-224, Umsetzungsdetail):** „Board-Re-Fetch bei `done`" wird über ein **Re-Key der `BoardView`** realisiert (die `BoardView` remountet beim Öffnen des Board-Reiters ohnehin frisch; das Re-Key koppelt den frischen Fetch explizit an das `done`-Ereignis). Das Panel erzwingt **keinen** Tab-Wechsel — der Nutzer bleibt im „Arbeiten"-Reiter und sieht den „fertig"-Status inline neben dem Knopf (konsistent mit der S-205-Inline-Feedback-Doktrin, die den erzwungenen Navigate bewusst vermeidet). So sind **beide** AC6-Forderungen erfüllt: „fertig" bleibt sichtbar **und** das Board ist beim nächsten Öffnen frisch.
- **AC7** (Doktrin-Anpassung — Drift-Gate) — `.claude/CLAUDE.md` und `docs/architecture.md` sind so angepasst, dass der **manuelle „Board abarbeiten"-Knopf headless** läuft: die Aussage „Der manuelle „Board abarbeiten"-Knopf (S-196) … laufen weiterhin ausschließlich interaktiv" ist entfernt/umgeschrieben (der Knopf ist nun als **weiterer headless Baustein (6)** gelistet), `docs/architecture.md` trägt einen **neuen ADR (ADR-017 · 2026-07-01)** mit Verweis auf diese Spec (ADR-015 als „ergänzt" markiert, nicht rückwirkend umgeschrieben), und die Absolutaussagen in [[headless-parallel-drain]] (AC1/AC6) sowie [[taktgeber-nachtwaechter]] (AC12) sind mit einem **supersede-Vermerk** auf diese Spec versehen. Nach der Anpassung enthält die Doktrin **keine** unbedingte „manueller Knopf = rein interaktiv"-Aussage mehr. Diese Story ändert **ausschließlich** `docs/`/`.claude/`-Dokumente, **keinen** Laufzeit-Code. *(Zweck-Doktrin-Hinweis)*
- **AC8** (Trigger-Verschlankung) — Im generischen `TriggerPanel` entfallen `flow` (als Befehl) **und** der Cost-Mode-Schalter; die Befehle `adopt` / `preview` / `train` / `new-project` und der **Kill-Switch** bleiben unverändert (interaktiver PTY-Pfad). Der Cost-Mode lebt ab jetzt ausschließlich am „Board abarbeiten"-Knopf (AC5). *(10)*

## Verträge

### Endpunkte
- `POST /api/projects/:slug/drain` `{ costMode?: 'low-cost'|'balanced'|'max-quality'|'frontier' }` → `202 { drainId }` | `400 { error }` (ungültiger Slug/Pfad **oder** ungültiger `costMode`) | `409 { error }` (Projekt bereits busy) | `500` (Engine nicht verdrahtet). Führt den Drain **headless** aus (AC1); `costMode` → `--cost`-Arg (AC3).
- `GET /api/projects/:slug/drain/:drainId` → `200 { status: 'running'|'done'|'failed', … }` | `404` (drainId unbekannt) | `400` (ungültiger Slug). Secret-/pfad-frei (AC4).

### Wiederverwendung / Boundaries
- `HeadlessFlowRunner` + `HeadlessFlowRunnerAdapter` (`src/HeadlessFlowRunner.js`, `src/FlowRunner.js`) — bestehende Bausteine ([[headless-parallel-drain]]); **eigene** Instanzen + **eigenes** `ProjectJobLock` für den manuellen Knopf (getrennt vom Nacht-Drain).
- `ProjectDrain` (`src/ProjectDrain.js`) — Injektion des headless-Adapters (wie `nightProjectDrain`); **zusätzlich**: Durchreichung eines per-Drain `costMode`/`args` an `flowRunner.startRun({ args })` (neue, schmale Erweiterung des Ausführungs-Schritts; übrige Logik unverändert).
- `FlowRunner`-Interface — `startRun({ projectPath, command, args?, identity? })` reicht `args` bereits vor ([[headless-parallel-drain]] AC1/„args"); der headless-Befehl trägt `--cost <mode>` als zusätzliches argv-Array-Element (kein Shell-String).
- Cost-Mode-Enum + `--cost`-Validierung — **geteilte** Konfiguration mit [[flow-trigger]] AC8 (nicht dupliziert).
- Drain-Job-Registry — Muster [[headless-reconcile-runner]] (In-Memory `getJob`).
- `projectDrainRouter` (`src/projectDrainRouter.js`) — nimmt `costMode` entgegen (validiert), startet den headless Drain, verwaltet die Job-Registry + Status-Route.

## Edge-Cases & Fehlerverhalten
- **Ungültiger `costMode`** → `400`, kein Drain-Start (analog [[flow-trigger]] AC8).
- **`auth-expired` (401) im headless-Lauf** → Drain-Job `failed`/auditiert, Lock im finally frei; das Panel zeigt „fehlgeschlagen".
- **Timeout / hängender Prozess** → SIGTERM (`FLOW_HEADLESS_TIMEOUT_MS`, [[headless-parallel-drain]] AC3) → Runde `failed`; Drain konvergiert/endet, Lock frei.
- **Projekt bereits busy** (manueller Drain läuft, oder aktive Command-Session) → `409`, kein Doppel-Start (unverändert).
- **Server-Neustart während Drain** → Job-Registry verloren (Nicht-Ziel); laufender Subprozess ggf. verwaist (Timeout/OS bereinigt) — wie bei den bestehenden Runnern. **Superseded/ergänzt (ADR-020, 2026-07-03):** die Registry ist seither datei-basiert persistiert (kein Verlust mehr) und ein idempotenter Boot-Wiederanlauf über `BootDrainRecovery` stößt für das betroffene Projekt automatisch einen neuen Drain an; der ursprüngliche Kindprozess selbst überlebt weiterhin nicht (bewusste Nicht-Entscheidung gegen detached-Spawn). Siehe [[drain-restart-robustness]] (AC1–AC10).
- **Kein Live-Terminal** ist **erwartetes** Verhalten (kein Fehler) — der Hinweis (AC6) kommuniziert das.

## NFRs
- **Sicherheit (Floor):** kein Anthropic-/OpenAI-API-Key in der Child-Env (harter Block, [[headless-parallel-drain]] AC1); `--dangerously-skip-permissions` bleibt ausschließlich im getrennten headless-Pfad; argv als Array (kein Shell-Interpolation); `--cost <mode>` gegen das Enum validiert; keine Secrets/Token/absoluten Host-Pfade in Log/Audit/Response. Pfad-/Slug-Validierung wie bisher (`resolveProjectSlug`+`validateProjectPath`, realpath-Containment).
- **Isolation:** der manuelle Headless-Drain hält eine **eigene** `ProjectJobLock`-Instanz (keine Selbst-/Fremdblockade mit Nacht-Drain/Finalizer/Reconcile); er importiert/mutiert **nicht** den `PtyManager`/interaktiven `CommandService`-Schreibpfad (Trust-Boundary).
- **Kosten:** der Board-Lauf zählt gegen das Abo (`CLAUDE_CODE_OAUTH_TOKEN`, kein API-Key); Cost-Mode ist der Token-Hebel.

## Nicht-Ziele
- **Kein** Umbau des interaktiven PTY-/`CommandService`-/Terminal-Pfads (bleibt parallel bestehen, u.a. für die verschlankte Befehls-Auslösung + Kill).
- **Kein** neuer Runner-Typ (nutzt den bestehenden `HeadlessFlowRunner`, nur eigene Instanz + eigener Lock).
- **Keine** persistente Drain-Job-Historie (In-Memory, geht bei Neustart verloren). **Superseded/ergänzt (ADR-020, 2026-07-03):** eine kleine, größenbegrenzte persistente Registry + Boot-Wiederanlauf sind seither verdrahtet, siehe [[drain-restart-robustness]] (AC1–AC8) — weiterhin **keine** unbegrenzte Historie.
- **Keine** Modell-/Cost-Mode-Entscheidungslogik in dev-gui (liegt in agent-flow; der Runner reicht `--cost` nur durch).
- **Kein** echter `claude -p`-Live-Lauf im Test-Gate (gemockte `spawn`/Runner, [[headless-parallel-drain]] AC13).

## Abhängigkeiten
- [[headless-parallel-drain]] (`HeadlessFlowRunner`/`HeadlessFlowRunnerAdapter`, `FlowRunner`-Interface, `ProjectJobLock`, Timeout, Audit — Wiederverwendung; AC1/AC6 werden für den manuellen Pfad **superseded**) · [[taktgeber-nachtwaechter]] (`ProjectDrain`-Engine, `isProjectBusy`, Audit; AC12 wird für den manuellen Pfad **superseded**) · [[headless-reconcile-runner]] (Runner-/Status-Endpunkt-/Job-Registry-Muster) · [[flow-trigger]] (Cost-Mode-Enum + `--cost`-Validierung, geteilt; interaktiver Trigger bleibt für die verschlankten Befehle) · [[claude-code-oauth-token]] (`CLAUDE_CODE_OAUTH_TOKEN`) · [[claude-auth-health]] (Auth-Zustand).
- **Doktrin-Anpassung (eigenes Board-Item, AC7):** `.claude/CLAUDE.md` + `docs/architecture.md` (ADR-017) + supersede-Vermerke in [[headless-parallel-drain]] / [[taktgeber-nachtwaechter]].

## Restrisiko (bewusst akzeptiert)
- Der Verlust der Live-Terminal-Ausgabe beim manuellen Knopf ist eine **bewusste** Folge des Headless-Umbaus; Feedback läuft über Board-Re-Fetch + Drain-Job-Status + Audit (AC3/AC6). Die reale Naht zu echtem `claude -p` wird — wie beim Nacht-Drain — durch gemockte Tests gegatet und erst im echten Einsatz verifiziert ([[headless-parallel-drain]] Restrisiko).
