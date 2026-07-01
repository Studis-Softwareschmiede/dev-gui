---
id: headless-parallel-drain
title: Headless-Parallel-Drain — Nacht-/flow-Läufe als parallele `claude -p`-Prozesse
status: active
version: 1
---

# Spec: Headless-Parallel-Drain  (`headless-parallel-drain`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der Nachtwächter ([[taktgeber-nachtwaechter]]) soll das bezahlte Token-Kontingent nachts **maximal ausschöpfen**, indem er mehrere `/agent-flow:flow`-Läufe **echt gleichzeitig** fährt. Heute serialisiert der prozessweite `CommandService`-`JobLock` (eine interaktive PTY) alle Läufe: bei `maxParallel>1` startet der Scheduler zwar bis zu `maxParallel` Drains, aber nur **einer** bekommt die PTY — die übrigen erhalten `{ok:false, reason:'locked'}` und beenden sich als `command-channel-busy` (siehe `NightWatchScheduler.js` Modul-Doku Z.34–41; [[taktgeber-nachtwaechter]] Engine-Schnittstelle `command-channel-busy`). Diese Spec führt einen **headless-Ausführungspfad** ein: der Nacht-Drain stößt `/flow` als **one-shot `claude -p`-Kindprozesse** an (analog [[headless-reconcile-runner]]), die **nicht** am PTY-Lock hängen → echte Nebenläufigkeit bis `maxParallel`, ohne den interaktiven Terminal-Baustein anzufassen.

Parallelität hilft, weil ein einzelner `/flow`-Lauf die Rate wegen Tool-/CI-/IO-Wartezeiten oft **nicht** sättigt — mehrere parallele Läufe verwandeln mehr Budget in erledigte Stories.

## Verhalten

### Abgrenzung: interaktiv vs. headless (verbindlich)
1. **Interaktiver Pfad bleibt 100% unangetastet.** Der manuelle Knopf „Board abarbeiten" (S-196, [[taktgeber-nachtwaechter]] AC12) und das Terminal laufen **weiterhin rein über `CommandService`/PTY** (kein `claude -p`, kein PTY-Lock-Bypass). Weder `CommandService` noch der globale `JobLock` werden umgebaut — der verworfene Alt-Ansatz (interaktiven Lock projektweise entkoppeln) wird **nicht** gebaut.
2. **Nur der automatische Nachtwächter** nutzt den headless-Pfad. Echte Parallelität entsteht dadurch, dass headless-Subprozesse gar nicht am PTY-Lock hängen — jeder Lauf ist ein eigener Prozess mit projektweisem `ProjectJobLock`.

### Generischer Headless-Runner
3. Ein **`HeadlessFlowRunner`** fährt einen **konfigurierbaren** Befehl (Default `/agent-flow:flow`, optional zusätzliche Argumente wie `--cost <mode>`) als `claude -p`-Kindprozess in **Array-argv-Form** (kein Shell-String). Er übernimmt die Semantik von [[headless-reconcile-runner]] **1:1**: Env-Allowlist + `CLAUDE_CODE_OAUTH_TOKEN`-Durchreichung, harter `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block (Trust-Boundary), 401-Vorrang vor „sauberem" Exit 0, `close`-Event als **einzige** Fertig-Quelle, SIGTERM-Timeout, projektweises `ProjectJobLock` (finally-Freigabe), In-Memory-Job-Registry (`getJob(jobId) → {status,result?,error?}`).
4. Der `/agent-flow:reconcile`-Befehl ist heute in `HeadlessReconcileRunner.js` Z.212 **hart verdrahtet**. Diese Spec **generalisiert** den Runner (gemeinsame Basis extrahieren **oder** parametrierter Runner), sodass der Befehl injizierbar ist. Das **bestehende Reconcile-Verhalten bleibt unverändert** (alle ACs von [[headless-reconcile-runner]] bleiben grün — kein Regress).
5. **Eigener, viel großzügigerer Timeout für `/flow`.** Ein `/flow`-Lauf über ein ganzes Board dauert lange (viele Subagenten, CI, IO) — der 15-min-Reconcile-Default (`DEFAULT_RECONCILE_TIMEOUT_MS`) ist ungeeignet. Der Flow-Runner nutzt einen **eigenen, konfigurierbaren** Env-Default (`FLOW_HEADLESS_TIMEOUT_MS`), deutlich größer als der Reconcile-Wert.

### FlowRunner-Interface + ProjectDrain-Injection
6. `ProjectDrain` behält seine **gesamte** Logik (Drain-Ziele/`ready`, zustandsbasierte Abbruch-/Konvergenz-Regel, transitive-Sackgassen-Konvergenz, Eskalation-auf-`Blocked`, Snapshot-Diff-Fortschritt, Token-Limit-Pause, Sicherheitsgürtel). **Nur** der Ausführungs-Schritt in `#runLoop` (heute `commandService.tryRun({command:FLOW_COMMAND})` + `#awaitCompletion()`-Idle-Poll, `ProjectDrain.js` Z.558/Z.580) wird über ein **injizierbares `FlowRunner`-Interface** abstrahiert.
7. Das `FlowRunner`-Interface deckt zwei Operationen: **(a)** einen Lauf starten (`projectPath`, `command`) und **(b)** auf das **echte** Ende warten. Zwei Implementierungen:
   - **Interaktiver Adapter** (Default, heutiges Verhalten): kapselt `CommandService.tryRun()` + Idle-Completion-Poll (`getStatus()` bis nicht `running`). Verhalten **bit-identisch** zu heute.
   - **Headless Adapter**: kapselt `HeadlessFlowRunner.start()`; „auf Ende warten" = auf das **`close`-Event** des Kindprozesses (nicht PTY-Idle-Poll).
8. `ProjectDrain` bekommt den `FlowRunner` **injiziert** (kein hart verdrahtetes `CommandService` mehr im Ausführungs-Schritt). Ohne Injektion (Default) verhält sich `ProjectDrain` wie heute (interaktiver Adapter) — der manuelle Knopf und bestehende Tests bleiben unverändert.

### Scheduler-Headless-Integration
9. Im **Nachtmodus** startet `NightWatchScheduler` bis zu `maxParallel` `ProjectDrain`s, die den **headless** `FlowRunner`-Adapter nutzen → echte parallele Subprozesse, **nicht** mehr am globalen PTY-Lock serialisiert. Nachtfenster, sanftes Ende, Token-Pause und `maxParallel` (Default **3**, geklemmt 1–3, bestehendes ticker-Setting) bleiben **unverändert** ([[taktgeber-nachtwaechter]] AC9–AC11, AC13–AC15).
10. Der Stop-Grund `command-channel-busy` ([[taktgeber-nachtwaechter]] Engine-Schnittstelle) **entfällt im Headless-Modus**, weil es keinen globalen PTY-Lock gibt, an dem parallele Läufe kollidieren — das projektweise `ProjectJobLock` genügt. (Der interaktive/manuelle Pfad behält `command-channel-busy` unverändert.)

### Auth-Vorabprüfung (empfohlen)
11. Vor dem Start eines Nacht-Laufs prüft der Scheduler `ClaudeAuthHealthService.getState()`. Bei `claudeAuth: 'expired'` wird der Lauf **gar nicht** gestartet (spart Fehl-Läufe) und der Umstand wird sichtbar gemacht (Audit + Status). `unknown` → fortfahren (kein Fehlalarm-Block).

### Headless-Semantik (kein User-Input nachts)
12. Ein `claude -p '/agent-flow:flow'`-Prozess ist eine **autonome** Claude-Instanz, die den `/flow`-Orchestrator fährt (dispatcht selbst coder/reviewer/tester/cicd), bis das Board so weit wie möglich abgearbeitet ist → Prozess-Ende (`close`). `ProjectDrain.#runLoop` wiederholt bei Bedarf (Snapshot zeigt noch Drain-Ziele) — **dieselbe** Abbruch-/Konvergenz-Logik wie heute.
13. Headless-Läufe dürfen **nie** auf User-Input warten (kein interaktives AskUserQuestion nachts). `/flow` setzt bei Unklarheit ohnehin `Blocked` statt zu fragen; der **Timeout** (Regel 5) fängt einen dennoch hängenden Prozess und beendet ihn (SIGTERM → `failed`).

## Acceptance-Kriterien

- **AC1** — `HeadlessFlowRunner` startet einen `claude -p`-Kindprozess mit **konfigurierbarem** Befehl (Default-argv `['-p','/agent-flow:flow','--dangerously-skip-permissions']`, optional weitere Args wie `--cost <mode>`) in **Array-argv-Form** (kein Shell-String, security/R03), `cwd` = aufgelöster, validierter Projekt-Pfad. Übernimmt 1:1 aus [[headless-reconcile-runner]]: Env-Allowlist + `CLAUDE_CODE_OAUTH_TOKEN` (`buildChildEnv`), harter `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block, 401-Vorrang vor Exit 0 (`isAuthError`), `close`-Event als **einzige** Fertig-Quelle, projektweises `ProjectJobLock` (finally-Freigabe), In-Memory-Job-Registry `getJob(jobId) → {status:'running'|'done'|'failed'|'auth-expired', result?, error?}`. *(3,4)*
- **AC2** — Kein Regress am Reconcile-Pfad: der Befehl ist injizierbar (nicht mehr hart auf `/agent-flow:reconcile` verdrahtet); das bestehende `HeadlessReconcileRunner`-Verhalten bleibt unverändert und **alle** ACs von [[headless-reconcile-runner]] bleiben grün (gemeinsame Basis extrahiert **oder** parametrierter Runner — Implementierungswahl frei). *(4)*
- **AC3** — Der Flow-Runner nutzt einen **eigenen, konfigurierbaren** Timeout (`FLOW_HEADLESS_TIMEOUT_MS`), **deutlich größer** als der Reconcile-Default (`DEFAULT_RECONCILE_TIMEOUT_MS` = 15 min) und **nicht** an diesen gekoppelt. Timeout-Ablauf → SIGTERM + Job `failed` (Runaway-Schutz). *(5)*
- **AC4** — Es existiert ein `FlowRunner`-Interface mit zwei Operationen: (a) Lauf starten (`projectPath`, `command`), (b) auf **echtes** Ende warten (liefert einen terminalen Status). Zwei Implementierungen: **interaktiver Adapter** (`CommandService.tryRun()` + Idle-Completion-Poll, heutiges Verhalten) und **headless Adapter** (`HeadlessFlowRunner`, Ende = `close`-Event, **kein** PTY-Idle-Poll). *(6,7)*
- **AC5** — `ProjectDrain` bekommt den `FlowRunner` injiziert; der Ausführungs-Schritt in `#runLoop` geht über das Interface statt über ein hart verdrahtetes `CommandService`. **Alle** übrige `ProjectDrain`-Logik (Drain-Ziel-/`ready`-Auswahl, zustandsbasierte Abbruch-/Konvergenz-Regel AC1–AC5 der [[taktgeber-nachtwaechter]], Eskalation-auf-`Blocked`, Snapshot-Diff-Fortschritt, Sicherheitsgürtel) bleibt **unverändert**. *(6,8)*
- **AC6** — Ohne injizierten Runner (Default) verhält sich `ProjectDrain` **bit-identisch** zu heute (interaktiver Adapter): der manuelle „Board abarbeiten"-Knopf (S-196) und das Terminal bleiben rein `CommandService`/PTY — **kein** Verhaltens-/Regressions-Unterschied im interaktiven Pfad. *(1,8)*
- **AC7** — Im Nachtmodus verdrahtet `NightWatchScheduler` seine `ProjectDrain`s mit dem **headless** `FlowRunner`-Adapter → bis zu `maxParallel` (Default 3, geklemmt 1–3) **echt parallele** `claude -p`-Subprozesse, **nicht** am globalen PTY-Lock serialisiert. Nachtfenster/sanftes Ende/Token-Pause/`maxParallel`-Klemmung unverändert ([[taktgeber-nachtwaechter]] AC9–AC11). *(9)*
- **AC8** — Im Headless-Modus tritt der Stop-Grund `command-channel-busy` **nicht** auf (kein globaler PTY-Lock, an dem parallele Läufe kollidieren; projektweises `ProjectJobLock` genügt). Der interaktive/manuelle Pfad behält `command-channel-busy` unverändert. *(10)*
- **AC9** — Auth-Vorabprüfung: vor dem Start eines Nacht-Laufs wird `ClaudeAuthHealthService.getState()` konsultiert; bei `claudeAuth:'expired'` wird der Lauf **nicht** gestartet und der Umstand auditiert/sichtbar gemacht. `claudeAuth:'unknown'`/`'ok'` → fortfahren (kein Fehlalarm-Block). *(11)*
- **AC10** — Headless-`/flow`-Läufe warten **nie** auf User-Input (kein interaktives AskUserQuestion nachts); ein dennoch hängender Prozess wird durch den Flow-Timeout (AC3) via SIGTERM beendet (`failed`). Das ist eine **testbare Anforderung** (Timeout-Pfad + Fehlerzustand). *(12,13)*
- **AC11** — Audit: jeder headless-Lauf erzeugt bei **Start**, **Ende** (Erfolg) und **Fehler** je **genau einen** `AuditEntry` (`AuditStore.record`), analog Reconcile ([[taktgeber-nachtwaechter]] AC18). Keine Secrets/Token/absoluten Host-Pfade in Audit/Log/Response. *(3,9)*
- **AC12** — Sanftes Fensterende mit laufenden headless-Prozessen: ab `window.end` werden **keine** neuen headless-Läufe gestartet; bereits laufende `claude -p`-Subprozesse werden **nicht** gekillt, sondern zu Ende geführt (oder laufen in ihren eigenen Timeout, AC3) — konsistent mit [[taktgeber-nachtwaechter]] AC11. *(9)*
- **AC13** — Gate = **Unit-/Integrationstests mit gemocktem `spawn`/Runner** (injizierbare `spawnFn` wie in `HeadlessReconcileRunner`). **Kein** echter `claude -p`-Live-Lauf gegen ein Sandbox-Projekt ist Teil dieser Umsetzung. Die reale Naht zu echtem `claude -p` wird bewusst erst im ersten Nacht-Einsatz verifiziert (siehe **Restrisiko**). *(alle)*
- **AC14** — `.claude/CLAUDE.md` dokumentiert den **headless-Nacht-Drain** als **weitere bewusste, auditierte Ausnahme** (headless, one-shot, kein PTY-Lock, kein API-Key, auditiert) — in einer Reihe mit den bestehenden Ausnahmen (Assist-Helfer, Knowledge-Suche, Reconcile-Runner). Der interaktive Pfad bleibt ausdrücklich rein PTY. *(1,2)*

## Verträge

### `FlowRunner`-Interface (sprach-neutral)
- `startRun({ projectPath, command, args? }) → { ok: true, handle } | { ok: false, reason: 'locked'|'busy'|'internal' }`
  - **Interaktiver Adapter:** `ok:false, reason:'locked'|'busy'` wenn der globale `CommandService`-`JobLock` von einem anderen Projekt gehalten wird (→ `ProjectDrain` mappt dies wie heute auf `command-channel-busy`).
  - **Headless Adapter:** `ok:false, reason:'locked'` nur, wenn das **projektweise** `ProjectJobLock` für **dasselbe** Projekt bereits gehalten wird (kein globaler Engpass → AC8).
- `awaitCompletion(handle) → { status: 'done'|'failed'|'auth-expired', … }`
  - **Interaktiver Adapter:** pollt `CommandService.getStatus()` bis nicht `running` (heutiges `#awaitCompletion`).
  - **Headless Adapter:** resolved beim `close`-Event des Kindprozesses (bzw. `auth-expired` bei 401-Vorrang, `failed` bei Timeout/Non-Zero-Exit).

### `HeadlessFlowRunner` (Wiederverwendung [[headless-reconcile-runner]]-Muster)
- `start(projectPath, { command?, args? }) → { ok: true, jobId } | { ok: false, reason: 'locked' }`
- `getJob(jobId) → { status: 'running'|'done'|'failed'|'auth-expired', result?, error? } | undefined`
- Konstruktor injizierbar: `spawnFn` (Default `node:child_process` `spawn`), `timeoutMs` (Default `FLOW_HEADLESS_TIMEOUT_MS`), `lock` (`ProjectJobLock`).

### Konfiguration
| Schlüssel | Typ | Default | Zweck |
|---|---|---|---|
| `FLOW_HEADLESS_TIMEOUT_MS` | int (ms) | deutlich > 15 min (z.B. mehrere Stunden) | Runaway-Timeout für einen headless-`/flow`-Lauf (AC3) |
| Headless-Modus-Schalter | bool/inject | interaktiv (Default) | wählt im `NightWatchScheduler` den headless-Adapter (AC7) |

- **Keine** neue persistente Ticker-Einstellung nötig: `maxParallel`/Nachtfenster stammen unverändert aus `ticker-settings.json` ([[taktgeber-nachtwaechter]] AC15). Der Headless-Modus wird verdrahtet (Injection), nicht als User-Setting exponiert (kann später als Setting nachgezogen werden — Nicht-Ziel).
- **Kein neuer öffentlicher HTTP-Endpunkt** ist erforderlich (der Nacht-Trigger ist der Scheduler, der manuelle Trigger bleibt interaktiv). Ein optionaler Debug-Endpunkt (analog `POST /api/reconcile`) ist **Nicht-Ziel** dieser Spec.

## Edge-Cases & Fehlerverhalten
- **`auth-expired` (401)** — Vorrang vor „sauberem" Exit 0 (Job `auth-expired`); AC9-Vorabprüfung verhindert idealerweise schon den Start. Ein zur Laufzeit auftretender 401 → Lauf `failed`/`auth-expired`, auditiert, kein Crash, Lock-Freigabe im finally.
- **Timeout / hängender Prozess** — SIGTERM nach `FLOW_HEADLESS_TIMEOUT_MS` → `failed`; `kill` auf bereits beendeten Prozess ist no-op (Race „Timeout exakt bei Exit").
- **`spawn`-Fehler (`ENOENT` „claude nicht verfügbar")** — Job `failed` mit generischer, secret-freier Meldung; kein Pfad-/Env-Leak.
- **Token-Limit** — bleibt konto-weit über den bestehenden `TokenLimitWatcher`/PTY-Pfad erkannt ([[taktgeber-nachtwaechter]] AC13/AC14); im Headless-Modus gibt es keine PTY-Ausgabe des Subprozesses zum Mitlesen → Token-Limit-Erkennung/-Pause bleibt Sache des Schedulers (best-effort), der headless-Lauf selbst endet regulär oder im Timeout. **Restrisiko** (s.u.): headless-Token-Limit-Signal wird erst im Nacht-Einsatz beobachtet.
- **PTY-Attach im Headless-Modus entfällt (CRITICAL-Fix, S-213 Iteration 2)** — `NightWatchScheduler#attachTokenWatcher()` hängt den `TokenLimitWatcher` **nur** an eine BEREITS bestehende Session an (`sessionRegistry.hasSession()`), **niemals** über `sessionRegistry.getOrCreate()` selbst eine neue PTY-Session erzeugen. Grund: `server.js` injiziert dieselbe `sessionRegistry`-Instanz sowohl für diesen Attach als auch in `ProjectDrain#isProjectBusy()` (Busy-Erkennung, AC7 [[taktgeber-nachtwaechter]]) — ein erzeugender Attach würde für ein frisches Projekt ohne offene manuelle Session GENAU JETZT eine Session anlegen, die `isProjectBusy()` unmittelbar danach als "aktiv" liest und den Drain mit `already-busy` abbricht, OHNE dass `flowRunner.startRun()` je läuft (AC7 komplett unterlaufen). Im Normalfall nachts (kein offenes manuelles Terminal für das Projekt) findet daher im Headless-Modus **gar kein** PTY-Attach statt — konsistent mit dem obigen Punkt: es gibt ohnehin keine PTY-Ausgabe zum Mitlesen.
- **Sanftes Fensterende** — laufende headless-Subprozesse werden nicht abgebrochen (AC12); der Scheduler startet nur keine neuen mehr.
- **`ProjectJobLock` bei Crash** — immer im finally freigegeben (kein Dauer-Lock), analog `HeadlessReconcileRunner` Z.260–262.
- **Server-Neustart** — In-Memory-Job-Registry geht verloren (Nicht-Ziel: keine persistente Job-Historie); ein laufender Subprozess wird ggf. verwaist (Timeout/OS bereinigt) — akzeptiert, im Restrisiko vermerkt.

## NFRs
- **Sicherheit (Floor):** kein Anthropic-/OpenAI-API-Key in der Child-Env (harter Block, AC1); `--dangerously-skip-permissions` bleibt ausschließlich im getrennten headless-Pfad; argv als Array (kein Shell-Interpolation); keine Secrets/Token/Host-Pfade in Log/Audit/Response. Der interaktive PTY-Pfad bleibt unverändert (`.claude/CLAUDE.md`).
- **Isolation:** der headless-Pfad importiert/mutiert **weder** `PtyManager`/`PtySessionRegistry` **noch** den `CommandService`-Schreibpfad (Trust-Boundary, analog [[headless-reconcile-runner]] AC7).
- **Robustheit:** ein headless-Lauf-Fehler kippt weder den `ProjectDrain` noch den `NightWatchScheduler` (degradierend, `.catch()` im `#startDrain`); Timer/Locks blockieren keinen Shutdown.
- **Testbarkeit:** `spawnFn`/`FlowRunner` injizierbar → alle ACs ohne echten `claude`-Lauf prüfbar (AC13).

## Restrisiko (bewusst akzeptiert)
Die **reale Naht** zu echtem `claude -p '/agent-flow:flow'` (tatsächliches Prozess-Verhalten, OAuth-Token-Nutzung mehrerer paralleler Prozesse auf **einem** Abo-Token, echte `close`-Semantik, headless-Token-Limit-Signal, Verwaisung bei Server-Neustart) wird durch diese Umsetzung **nicht** live verifiziert — das Gate sind gemockte Unit-/Integrationstests (AC13). Die reale Verifikation erfolgt **bewusst erst im ersten Nacht-Einsatz** (Audit-Logs beobachten: Start/Ende/Fehler je Lauf, echte Parallelität, kein Rate-/Auth-Kollaps). Offen bis dahin: die **sinnvolle** maximale Parallelität auf einem Abo-Token (Rate-Limits) — Default 3 ist die konservative Obergrenze des bestehenden Settings.

## Wiederverwendung bestehender Bausteine
- **`HeadlessReconcileRunner`** (`src/HeadlessReconcileRunner.js`) — Vorlage/Basis: `spawn` argv-Array (Z.212), `buildChildEnv()` Env-Allowlist + `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`-Block (Z.77–91), `isAuthError()` 401-Vorrang (Z.102–105), `close`-Event-Ende + stdout/stderr-Capture (Z.235–249), Timeout/SIGTERM (Z.47,223–228), `ProjectJobLock.tryAcquire/release` mit finally-Freigabe (Z.157–159,260–262), Job-Registry `getJob` (Z.182–184). Heute hart auf `/agent-flow:reconcile` verdrahtet (Z.212) → **generalisieren** (AC1/AC2).
- **`reconcileRouter.js` / `routers/reconcile.js`** — Muster für einen (optionalen) headless-Trigger: `resolveProjectSlug`+`validateProjectPath`, `202 {jobId}` / `409 locked`, secret-freie Responses.
- **`ProjectDrain`** (`src/ProjectDrain.js`) — Austausch-Punkt: `#runLoop` Z.558 (`commandService.tryRun({command:FLOW_COMMAND})`) + `#awaitCompletion()` Z.580 (Idle-Poll) → hinter das injizierte `FlowRunner`-Interface (AC4/AC5); gesamte übrige Logik bleibt.
- **`NightWatchScheduler`** (`src/NightWatchScheduler.js`) — `#startDrain(projectPath)` Z.463–469, `isWithinWindow` Z.127, `readSettings`, `#activeDrains`-Tracking, `maxParallel`-Klemmung (Z.188) → headless-Adapter injizieren (AC7); Modul-Doku Z.34–41 beschreibt exakt den heutigen Lock-Engpass, den AC8 auflöst.
- **`ClaudeAuthHealthService`** (`src/ClaudeAuthHealthService.js`) — `getState() → {claudeAuth:'ok'|'expired'|'unknown', lastCheckedAt}` (Z.167) als Auth-Vorabprüfung (AC9).
- **`ProjectJobLock`** — projektweises Lock (Schlüssel = Projektpfad) für den headless-Runner.
- **`AuditStore`** (`src/AuditStore.js`) — Audit je headless-Lauf (AC11).

## Neu zu bauen (Lücken)
- **`HeadlessFlowRunner`** (parametrierter Runner **oder** aus `HeadlessReconcileRunner` extrahierte gemeinsame Basis) mit konfigurierbarem Befehl + eigenem `FLOW_HEADLESS_TIMEOUT_MS` (AC1–AC3).
- **`FlowRunner`-Interface** + zwei Adapter (interaktiv über `CommandService`, headless über `HeadlessFlowRunner`) (AC4).
- **`ProjectDrain`-Injection**: Ausführungs-Schritt in `#runLoop` über den injizierten `FlowRunner` statt hart über `CommandService` (AC5/AC6).
- **`NightWatchScheduler`-Verdrahtung** des headless-Adapters im Nachtmodus + Auth-Vorabprüfung (AC7/AC9); `command-channel-busy` entfällt im Headless-Modus (AC8).
- **`.claude/CLAUDE.md`-Ergänzung**: headless-Nacht-Drain als bewusste, auditierte Ausnahme (AC14).

## Nicht-Ziele
- **Kein** Umbau von `CommandService`/`JobLock`/interaktivem PTY-Pfad (verworfener Alt-Ansatz).
- **Kein** echter `claude -p`-Live-Lauf im Test-Gate (Restrisiko, AC13).
- **Kein** neuer öffentlicher HTTP-Endpunkt (Nacht-Trigger = Scheduler; manueller Trigger bleibt interaktiv). Optionaler Debug-Endpunkt bewusst ausgelassen.
- **Keine** neue User-Einstellung für den Headless-Modus (Injection/Verdrahtung; späteres Setting = Nicht-Ziel dieser Spec).
- **Keine** Modell-/Cost-Mode-Entscheidungslogik (liegt in agent-flow; der Runner reicht Args nur durch — vgl. S-211 „Cost Mode überprüfen").
- **Keine** persistente headless-Job-Historie (In-Memory-Registry, geht bei Neustart verloren).

## Abhängigkeiten
- [[taktgeber-nachtwaechter]] (ProjectDrain-Engine, Nachtfenster, `maxParallel`, `command-channel-busy`, Audit AC18) · [[headless-reconcile-runner]] (Runner-Muster, Env-Allowlist, 401-Vorrang, Timeout, ProjectJobLock) · [[claude-code-oauth-token]] (`CLAUDE_CODE_OAUTH_TOKEN` in Container/Env) · [[claude-auth-health]] (`getState()` Auth-Vorabprüfung) · [[flow-trigger]] (CommandService/PTY — interaktiver Pfad, unverändert) · [[autonome-board-abarbeitung]] (Blocked-statt-Raten — headless setzt `Blocked` statt zu fragen).
