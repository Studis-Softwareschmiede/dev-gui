---
id: taktgeber-nachtwaechter
title: Taktgeber / Nachtwächter — Boards automatisch leerziehen (ProjectDrain-Engine + Nachtfenster)
status: active
version: 2
---

# Spec: Taktgeber / Nachtwächter  (`taktgeber-nachtwaechter`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`/`tester`/`reviewer`.

## Zweck
In der Fabrik bleiben Stories auf `To Do`/`In Progress` liegen — besonders bei nächtlichen Läufen werden Boards nicht leer abgearbeitet (Token-Limit, abgebrochene Läufe, unbekannte Ursachen). Diese Spec führt einen **Taktgeber** ein, der bezahlte Tokens nachts produktiv nutzt und offene Boards automatisch **leerzieht** — über eine zentrale **ProjectDrain-Engine**, die von zwei Auslösern genutzt wird (manueller Knopf + automatischer Nachtwächter).

## Verhalten

### ProjectDrain-Engine (zentral, von beiden Auslösern genutzt)

> **Drain-Ziel — verbindliche Definition (Schicht-Wechsel von „offen" auf „ready").** Drain-Ziele sind **ausschließlich**: **(a)** `To Do`-Stories mit **`ready==true`** gemäß `BoardAggregator.computeStoryReadyStatus` **PLUS (b)** verwaiste `In Progress`-Stories (länger als `staleInProgressHours` ohne Aktivität). **`ready` ist die maßgebliche Regel** (`src/BoardAggregator.js`, `computeStoryReadyStatus`) und wird hier **nicht** neu definiert: eine `To Do`-Story ist ready genau dann, wenn ALLE gelten — (1) Status `To Do`, (2) `spec` gesetzt + Spec-Datei existiert + Frontmatter `status: active`, (3) `implements` nicht leer + jede AC-Nr kommt in der Spec vor, (4) `depends` leer ODER alle referenzierten Stories `Done`, (5) kein `blocked_reason`. **Nicht-Drain-Ziele** (werden **nie** autonom angefasst): `To Do` mit `ready==false` (fehlende/inaktive Spec, fehlende AC, unerfüllte `depends`), `Blocked`, der Status `Idee` ([[ideen-inbox]]) und `Done`.

1. **Definition.** Für **ein** Projekt wird `/agent-flow:flow` so lange wiederholt angestoßen, wie das Board mindestens **eine Drain-Ziel-Story** hat (siehe Drain-Ziel-Definition oben) **oder** eine `To Do`-Story besitzt, die durch das Fertigstellen eines Vorgängers ready **werden kann** (Regel 2).
2. **Abbruch-/Konvergenz-Regel (zustandsbasiert, verbindlich).** Der Drain stoppt für ein Projekt **genau dann**, wenn **keine** Drain-Ziel-Story mehr existiert **und** keine `To Do`-Story durch Fertigstellen eines Vorgängers ready werden **kann** — d.h. jede Story ist `Done`/`Blocked`/`Idee` **oder** ein `To Do`, dessen `ready==false` **nicht** allein an noch nicht fertigen Vorgängern hängt (sondern an fehlender/inaktiver Spec, fehlenden AC o.ä.). Ein `To Do`, das nur auf einen noch nicht fertigen Vorgänger wartet (`depends`-Story noch nicht `Done`, sonst alles erfüllt), wird durch das Abarbeiten der Vorgänger **automatisch** ready und dann mitgezogen — also: **solange im Projekt mindestens eine Drain-Ziel-Story existiert ODER eine durch Vorgänger-Fertigstellung ready werden KANN → weiterarbeiten; sonst stoppen.** **Keine** fortschrittsbasierte Bremse.
3. **Drain-Ziele** = ready-`To Do` (a) + verwaiste `In Progress` (b). `Blocked`, `Idee` und nicht-ready `To Do` sind **kein** Drain-Ziel und bleiben unangetastet (= „Frage für den nächsten Tag" bzw. unfertige Anforderung) — Ausnahme nur die Eskalation selbst (Regel 4), die ausschließlich auf Drain-Ziel-Stories greift.
4. **Eskalation gegen Endlosschleifen (verbindlich).** Endet ein /flow-Lauf, ohne dass sich der **Zustand** einer **Drain-Ziel-Story** geändert hat, zählt ein „kein-Fortschritt"-Zähler je Projekt hoch. Erreicht er `escalationAttempts` (Default 3) **aufeinanderfolgende** fortschrittslose Läufe, setzt der Taktgeber die am längsten unbewegte **Drain-Ziel-Story** **selbst** auf `Blocked` mit `blocked_reason: "Taktgeber: Nx kein Fortschritt"` (N = `escalationAttempts`) und setzt den Zähler zurück. Nicht-ready `To Do` und `Idee` werden dabei **nie** eskaliert. Dadurch konvergiert die Abbruch-Regel garantiert — der Drain stoppt nie „aus Resignation", sondern bringt unbewegbare Drain-Ziel-Stories in den korrekten Zustand `Blocked`.
5. **Fortschritt** = jede beobachtbare Status-Änderung einer Story zwischen zwei Board-Scans (z.B. `To Do→In Progress`, `In Progress→Done`, `→Blocked`, Story erscheint/verschwindet) **oder** der Übergang einer `To Do`-Story von `ready==false` nach `ready==true` (ein fertiggestellter Vorgänger hat ein nachgelagertes Ziel freigeschaltet). Bei Fortschritt wird der kein-Fortschritt-Zähler zurückgesetzt.

### Zwei Auslöser, gleiche Engine
6. **Manueller Knopf „Board abarbeiten"** (Reiter „Arbeiten"): nutzt die ProjectDrain-Engine, draint das **eine** geöffnete Projekt **sofort**, ignoriert das Nachtfenster, Parallelität 1.
7. **Nachtwächter (automatisch):** draint **alle** Projekte (oder die konfigurierte Liste), nur im Nachtfenster, bis zu `maxParallel` parallel.

### Nachtfenster
8. Default **23:00–07:00**, Zeitzone **Europe/Zurich**. Fenster über Mitternacht (`start>end`) muss korrekt behandelt werden (ein Zeitpunkt liegt im Fenster, wenn er **≥ start ODER < end** liegt).
9. **Sanftes Ende:** ab `window.end` werden **keine** neuen /flow mehr gestartet; bereits laufende Läufe werden **nicht** abgebrochen, sondern zu Ende geführt.
10. Innerhalb des Fensters: Polling-Intervall `intervalMinutes` (Default 15), bis zu `maxParallel` (Default 3) Projekte parallel.

### Concurrency (projektweise Locks)
11. Der bestehende globale `JobLock` (process-weit, max. 1) genügt für 3 parallele Projekt-Läufe **nicht**. Für Drains gilt ein **projektweises Lock** (Schlüssel = absoluter Projektpfad). „Arbeitet jemand dran?" wird je Projekt aus aktivem Projekt-Lock **und** aktiver Session/aktivem Command (auch manuell im UI gestartete Läufe) bestimmt — kein Doppel-Trigger.

### Token-Limit (konto-weit)
12. Erkennung: der PTY-Output wird mitgelesen; Claudes Token-/Usage-Limit-Meldung samt **Reset-Zeitpunkt** wird geparst. Die Erkennung gilt **konto-weit** (nicht pro Projekt).
13. Verhalten: bis **Reset + 1 Minute Puffer** pausieren, dann fortsetzen. Liegt der Reset **nach** dem Fensterende (`window.end`) → **nicht** warten, sondern stoppen und in der nächsten Nacht fortsetzen.

## Acceptance-Kriterien

- **AC1** — `ProjectDrain.drainProject(projectPath)` stößt wiederholt `/agent-flow:flow` für **genau ein** Projekt an, solange das Board dieses Projekts mindestens eine **Drain-Ziel-Story** hat. **Drain-Ziel** = **(a)** `To Do` mit `ready==true` (gemäß `BoardAggregator.computeStoryReadyStatus`, **maßgebliche Regel**, hier nicht neu definiert) **PLUS (b)** verwaistes `In Progress` (älter als `staleInProgressHours`). `Done`, `Blocked`, `Idee` und **nicht-ready `To Do`** sind **kein** Drain-Ziel. *(1)*
- **AC2** — Abbruch-/Konvergenz-Regel zustandsbasiert: der Drain stoppt **genau dann**, wenn **keine** Drain-Ziel-Story mehr existiert **und** keine `To Do`-Story durch Fertigstellen eines Vorgängers ready werden **kann** (d.h. ihr `ready==false` hängt nicht allein an noch nicht fertigen `depends`). Ein `To Do`, das nur auf einen noch nicht fertigen Vorgänger wartet, wird durch Abarbeiten der Vorgänger automatisch ready und mitgezogen → weiterarbeiten. Keine fortschrittsbasierte Bremse. *(2)*
- **AC3** — Drain-Ziele sind **ausschließlich** ready-`To Do` + verwaistes `In Progress`. **Nicht-Drain-Ziele** — `To Do` mit `ready==false`, `Blocked`, `Idee` ([[ideen-inbox]]), `Done` — werden nie als Ziel gewählt und (außer der Eskalation in AC4) nie verändert. *(3)*
- **AC4** — Eskalation: nach `escalationAttempts` (Default 3) aufeinanderfolgenden Läufen **ohne** jede **Drain-Ziel**-Story-Statusänderung setzt der Taktgeber die am längsten unbewegte Drain-Ziel-Story selbst auf `Blocked` mit `blocked_reason: "Taktgeber: Nx kein Fortschritt"` (N = `escalationAttempts`) und setzt den kein-Fortschritt-Zähler zurück. Nicht-ready `To Do` und `Idee` werden nie eskaliert. Garantierte Konvergenz der Abbruch-Regel. *(4)*
- **AC5** — Fortschritt = jede Story-Statusänderung zwischen zwei Board-Scans **oder** der Übergang einer `To Do`-Story von `ready==false` nach `ready==true` (freigeschaltet durch einen fertigen Vorgänger); bei Fortschritt wird der kein-Fortschritt-Zähler zurückgesetzt (Eskalation nur bei **aufeinanderfolgenden** fortschrittslosen Läufen). *(5)*
- **AC6** — Pro Projekt höchstens **ein** aktiver Drain/flow gleichzeitig: ein projektweises Lock (Schlüssel = absoluter Projektpfad) ersetzt für Drains den globalen Lock. Ein zweiter Drain-/flow-Trigger für dasselbe Projekt wird abgelehnt, solange das Projekt-Lock gehalten wird. *(11)*
- **AC7** — „Arbeitet jemand dran?" je Projekt = aktives Projekt-Lock **ODER** aktive Session/aktiver Command (auch manuell im UI gestartet). Ein Projekt, an dem bereits gearbeitet wird, wird vom Nachtwächter **nicht** zusätzlich getriggert (kein Doppel-Trigger). *(11)*
- **AC8** — Schmale Schreib-Boundary `BoardWriter` in `board/stories/<id>.yaml`: setzt ausschließlich `status` (→ `Blocked`), `blocked_reason` und `updated_at`, **atomar** (tmp+rename), lässt alle übrigen Felder unverändert. Einziger Schreibpfad des Taktgebers in Board-Dateien; `BoardAggregator` bleibt read-only. *(4)*
- **AC9** — Der Nachtwächter draint im Nachtfenster **alle** Projekte (oder die konfigurierte `projects`-Liste), bis zu `maxParallel` (Default 3) parallel; Polling-Intervall `intervalMinutes` (Default 15). *(7,10)*
- **AC10** — Nachtfenster `window.start`/`window.end` in `window.timezone` (Default `Europe/Zurich`); Fenster über Mitternacht (`start>end`, z.B. 23:00–07:00) korrekt: ein Zeitpunkt liegt im Fenster, wenn er **≥ start ODER < end** ist. *(8)*
- **AC11** — Sanftes Ende: ab `window.end` werden **keine** neuen /flow gestartet; bereits laufende Läufe werden **nicht** abgebrochen, sondern zu Ende geführt. *(9)*
- **AC12** — Der manuelle Knopf „Board abarbeiten" nutzt dieselbe `ProjectDrain`-Engine: draint das aktuell geöffnete Projekt **sofort** (ignoriert das Nachtfenster), Parallelität 1. *(6)*
- **AC13** — Token-/Usage-Limit-Erkennung **konto-weit**: der PTY-Output wird mitgelesen; die Token-/Usage-Limit-Meldung samt Reset-Zeitpunkt wird geparst (robust gegen ausbleibende/abweichende Meldung — kein Fehlalarm). *(12)*
- **AC14** — Bei erkanntem Limit: alle neuen /flow-Anstöße pausieren bis **Reset + 1 Minute Puffer**, dann fortsetzen. Liegt der Reset **nach** `window.end` → nicht warten, sondern stoppen (nächste Nacht fortsetzen). *(13)*
- **AC15** — Persistente Konfig (Muster `NotificationSettingsStore`, atomar JSON, `${CRED_STORE_DIR}/ticker-settings.json`): `enabled`, `window.start`, `window.end`, `window.timezone` (Default `Europe/Zurich`), `intervalMinutes` (Default 15), `maxParallel` (Default 3, gültig 1–3), `staleInProgressHours` (Default 4), `escalationAttempts` (Default 3), `projects` (`"all"` | String-Liste von Projekt-Slugs). `GET/PUT /api/settings/ticker` lesen/schreiben mit Validierung; **keine** Secrets. *(8,10,11)*
- **AC16** — `enabled=false` → der Nachtwächter triggert nichts (Scheduler idle); der manuelle „Board abarbeiten"-Knopf bleibt davon **unberührt** (immer verfügbar). *(6,7)*
- **AC17** — UI-Abschnitt „Nachtwächter" (auf der globalen Settings-Seite, Muster Notification-Settings): Schalter `enabled` + Felder für Fenster/Intervall/`maxParallel`/`staleInProgressHours`/`escalationAttempts`/`projects`; liest/schreibt `/api/settings/ticker`. Zusätzlich eine kompakte Statusanzeige (aktiv/pausiert, im/außerhalb Fenster, aktuell laufende Drains) in der Fabrik-Übersicht. *(6,7,8)*
- **AC18** — Audit: jeder Drain-Start, jeder /flow-Anstoß, jede Eskalation-auf-`Blocked` und jede Token-Limit-Pause erzeugt **genau einen** `AuditEntry` (`AuditStore.record`). Keine Secrets in Audit/Log/Response. *(1–13)*

## Verträge

### Endpunkte
- `GET /api/settings/ticker` → `200 { enabled, window:{start,end,timezone}, intervalMinutes, maxParallel, staleInProgressHours, escalationAttempts, projects }`.
- `PUT /api/settings/ticker` `{…dieselben Felder…}` → `200 {…gespeicherte Settings…}` | `400 {field,message}` (Validierung).
- `POST /api/projects/:slug/drain` (oder Wiederverwendung des bestehenden „Board abarbeiten"-Pfads) → startet einen manuellen Drain für **ein** Projekt; `202 {drainId}` | `409` (Projekt-Lock gehalten / Projekt bereits busy, AC7).
- Bestehender Pfad `POST /api/command` (CommandService, [[flow-trigger]]) bleibt der **einzige** Schreibweg in den PTY; der Drain ruft ihn pro /flow-Anstoß.

### Settings-Schema (`ticker-settings.json`)
| Feld | Typ | Default | Validierung |
|---|---|---|---|
| `enabled` | bool | `false` | — |
| `window.start` | `"HH:MM"` | `"23:00"` | 24h-Format |
| `window.end` | `"HH:MM"` | `"07:00"` | 24h-Format |
| `window.timezone` | string | `"Europe/Zurich"` | gültige IANA-TZ |
| `intervalMinutes` | int | `15` | ≥ 1 |
| `maxParallel` | int | `3` | 1–3 |
| `staleInProgressHours` | int | `4` | ≥ 1 |
| `escalationAttempts` | int | `3` | ≥ 1 |
| `projects` | `"all"` \| string[] | `"all"` | Slugs aus `BoardAggregator`-Index |

### Engine-Schnittstelle (sprach-neutral)
- `ProjectDrain.drainProject(projectPath, opts) → Ergebnis { stopped, reason: "no-drain-target"|"token-limit-stop"|"window-end"|"already-busy"|"command-channel-busy"|"safety-stop-no-progress"|"scan-failed", flowRuns, escalated:[storyId] }`. (`reason: "no-drain-target"` = weder Drain-Ziel-Story noch ein durch Vorgänger ready-werdendes `To Do` vorhanden, AC2. `token-limit-stop`/`window-end` werden NICHT von dieser Story geliefert, siehe S-193/S-195. `safety-stop-no-progress` = Defense-in-Depth-Backstop (AC2-Nicht-Ziel "keine fortschrittsbasierte Abbruch-Heuristik" bleibt für die primäre Stop-Entscheidung unverändert — dies ist ein unabhängiger Notausstieg gegen unvorhergesehene Logikfehler, greift bei korrekter Konvergenz-Logik nie). `scan-failed` = derselbe "kein Drain-Ziel"-Zustand, aber ausgelöst durch einen fehlgeschlagenen Board-Scan statt durch ein wirklich leeres Board — erlaubt einem späteren Scheduler (S-195), bei einem transienten Scan-Fehler erneut zu versuchen statt das Projekt fälschlich als endgültig leer zu behandeln. `command-channel-busy` (S-195 Iteration 2, AC9/AC11 — mehrere Projekte gleichzeitig) = `CommandService.tryRun()` lieferte `{ok:false, reason:'locked'|'busy'}`, weil der weiterhin PROZESSWEITE `CommandService`-`JobLock` (nicht der projektweise `ProjectJobLock`) gerade von einem ANDEREN Projekt gehalten wird — es fand GAR KEIN /flow-Lauf statt. Zählt NICHT als fortschrittsloser Lauf (kein Eskalations-Zähler-Increment, kein `setBlocked`); der Drain für dieses Projekt beendet sich sofort sauber, das Projekt bleibt Kandidat für den nächsten Scheduler-Tick. Der zugrundeliegende globale Lock-Engpass selbst — d.h. ECHTE gleichzeitige /flow-Ausführung bei `maxParallel>1` — ist bewusst NICHT Teil dieser Story, siehe Folge-Story `S-204`.)
- Status-Quelle: `BoardAggregator.getIndex()` (read-only) inkl. `ready`-Flag aus `computeStoryReadyStatus` → Drain-Ziel-Auswahl (AC1/AC3). /flow-Anstoß: `CommandService.tryRun({command:"/agent-flow:flow", projectPath})`. Blocked-Schreiben: `BoardWriter`.

## Edge-Cases & Fehlerverhalten
- **Board-Scan-Fehler** für ein Projekt → dieses Projekt wird in diesem Tick übersprungen (kein Drain, kein Crash); andere Projekte laufen weiter.
- **`/flow` wirft / Session nicht ready** → der Anstoß zählt als fortschrittsloser Lauf (Eskalations-Zähler), kein Crash.
- **Token-Limit-Meldung nicht parsebar / mehrdeutig** → keine Pause erzwingen (kein Fehlalarm); im Zweifel weiterlaufen (best-effort), Vorfall auditieren.
- **Reset-Zeitpunkt in der Vergangenheit / unplausibel** → minimaler Puffer (Reset+1 min), nicht negativ warten.
- **Projekt-Lock bei Crash** → muss freigegeben werden (kein Dauer-Lock); Drain-Ende/Fehler gibt das Projekt-Lock immer frei (analog `CommandService`-Lock-Freigabe).
- **`maxParallel` außerhalb 1–3** → auf gültigen Bereich klemmen (Schutz vor Account-Überlast).
- **Fenster `start==end`** → als „nie im Fenster" behandeln (defens, Owner-Korrektur).
- **`enabled=true` aber `projects`-Liste leer** → nichts zu drainen, Scheduler idle.

## NFRs
- **Sicherheit (Floor):** der Drain schreibt **nur** über `CommandService` (Allowlist) in den PTY und über `BoardWriter` ausschließlich `status`/`blocked_reason`/`updated_at` in `board/stories/*.yaml` — kein anderer Board-Schreibpfad. Keine Secrets in Audit/Log/Response. Kein Anthropic-API; reiner PTV-Pfad bleibt (CLAUDE.md).
- **Robustheit:** ein Projekt-/Provider-Fehler kippt den Gesamt-Tick nicht (degradierend, analog `ReconciliationJob`). Scheduler nutzt eine einzelne `setTimeout`-Kette + Skip-if-running (kein Drift), Timer `unref()` (blockiert keinen Shutdown).
- **Token-Sparsamkeit:** der Drain stößt /flow nur an, wenn das Projekt nicht bereits busy ist (AC7) und kein Token-Limit-Stop greift (AC14).

## Wiederverwendung bestehender Bausteine
- **`BoardAggregator` + `computeStoryReadyStatus`** (`src/BoardAggregator.js`) — read-only Multi-Repo-Scan über `BOARD_ROOTS`; liefert je Story `status` (`Idee`/`To Do`/`In Progress`/`Done`/`Blocked`) + `updated_at`/`done_at` **und** das `ready`-Flag aus `computeStoryReadyStatus` (die **maßgebliche** ready-Regel, hier nicht neu definiert) → Quelle für die **Drain-Ziel-Auswahl** (ready-`To Do` + verwaistes `In Progress`, AC1/AC3), die Abbruch-/Konvergenz-Regel (AC2) und die Fortschritts-/Stale-/ready-Übergangs-Erkennung (AC1/AC5). `BoardAggregator` bleibt **read-only**.
- **`CommandService` + `POST /api/command`** (`src/CommandService.js`, [[flow-trigger]]) — einziger PTY-Schreibpfad; Allowlist enthält `/agent-flow:flow` bereits; `tryRun({projectPath})` schreibt in die Projekt-Session. Idle→done-Completion signalisiert Lauf-Ende.
- **`PtySessionRegistry`** (`src/PtySessionRegistry.js`) — eine PTY-Session je Projektpfad → ermöglicht parallele Projekt-Drains (AC9).
- **`NotificationSettingsStore`** (`src/NotificationSettingsStore.js`) — Muster für atomare, nicht-geheime JSON-Settings auf `${CRED_STORE_DIR}` → Vorlage für `TickerSettingsStore` (AC15).
- **`ReconciliationJob`** (`src/deploy/ReconciliationJob.js`) — Muster für node-internen Scheduler (einzelne `setTimeout`-Kette, Skip-if-running, Snapshot-Persistenz, degradierend, `unref()`) → Vorlage für den Nachtfenster-Scheduler (AC9–AC11).
- **`NotificationWatcher`** (`src/NotificationWatcher.js`) — Muster für periodisches Board-Beobachten + Snapshot-Diff (Status-Übergänge) → Vorlage für Fortschritts-Erkennung (AC5).
- **`AuditStore`** (`src/AuditStore.js`) — Audit für jeden Drain/flow/Eskalation/Pause (AC18).
- **`JobLock`** (`src/JobLock.js`) — bestehender **globaler** Lock; bewusst **nicht** ausreichend → projektweise Locks (AC6, Lücke).

## Neu zu bauen (Lücken)
- **`ProjectJobLock`** (projektweises Lock, Schlüssel = Projektpfad) + Busy-Erkennung je Projekt (Lock ∪ aktive Session/Command) — der globale `JobLock` reicht für `maxParallel>1` nicht (AC6/AC7).
- **`BoardWriter`** — schmale, atomare Schreib-Boundary in `board/stories/<id>.yaml` (nur `status`/`blocked_reason`/`updated_at`); `BoardAggregator` ist read-only (AC8).
- **`ProjectDrain`-Engine** — Abbruch-Regel (zustandsbasiert) + Eskalation-auf-`Blocked` + Fortschritts-Zähler (AC1–AC5).
- **`TokenLimitWatcher`** — konto-weite PTY-Output-Erkennung des Token-/Usage-Limits + Reset-Parsing + Pause/Stop-Logik (AC13/AC14).
- **`TickerSettingsStore` + `GET/PUT /api/settings/ticker`** — persistente Konfig + API (AC15/AC16).
- **`NightWatchScheduler`** — Nachtfenster-Logik (TZ, über-Mitternacht, sanftes Ende), Polling, `maxParallel`-Parallelität (AC9–AC11).
- **Umbau „Board abarbeiten"-Knopf** — vom Einzel-/flow-Schuss auf die `ProjectDrain`-Engine (AC12).
- **UI-Abschnitt „Nachtwächter"** + Statusanzeige (AC17).

## Nicht-Ziele
- Kein Killen bereits laufender /flow-Läufe am Fensterende (sanftes Ende, Ac11).
- Keine fortschrittsbasierte Abbruch-Heuristik (nur die zustandsbasierte Regel + Eskalation).
- Kein paralleles Drainen **desselben** Projekts (Projekt-Lock = 1 je Projekt).
- Keine Modell-/Cost-Mode-Logik (liegt in agent-flow; der Drain stößt `/agent-flow:flow` mit Projekt-Default an).
- Kein eigener Board-Schreibpfad jenseits von `BoardWriter` (status/blocked_reason).

## Abhängigkeiten
- [[flow-trigger]] (CommandService, `POST /api/command`, Allowlist) · [[autonome-board-abarbeitung]] (Blocked-statt-Raten, „Board abarbeiten"-Knopf) · [[board-abarbeitungs-strategie]] (Parallelität/Worktrees in agent-flow) · [[ideen-inbox]] (Status `Idee` als explizites Nicht-Drain-Ziel, AC3) · [[push-notifications]] (NotificationSettingsStore-Muster) · `BoardAggregator` + `computeStoryReadyStatus` (ready-Regel) · `PtySessionRegistry` · `ReconciliationJob` (Scheduler-Muster) · `AuditStore`.
