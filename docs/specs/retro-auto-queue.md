---
id: retro-auto-queue
title: Serielle Warteschlange + headless Ausführung für automatisch ausgelöste Retro-Läufe
status: active
version: 1
---

# Spec: Serielle Auto-Retro-Warteschlange  (`retro-auto-queue`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Automatisch ausgelöste Retro-Läufe ([[retro-auto-trigger]]) schreiben in eine **geteilte, globale Lern-Ablage**: `LEARNINGS.md` und die globalen Knowledge-Packs im **agent-flow-Repo** (der `retro`-Agent öffnet dafür einen PR gegen agent-flow). Weil der Nachtwächter **mehrere Projekte parallel** drainen kann ([[headless-parallel-drain]], `maxParallel` bis 3) und mehrere Projekte etwa **gleichzeitig** fertig werden, würden mehrere Retro-Läufe **gleichzeitig** gegen dieselbe geteilte Ablage laufen und sich in die Quere kommen (Merge-Konflikte, konkurrierende PRs, inkonsistenter `.retro-last-run`-/Cooldown-Zustand).

Diese Spec führt eine **serielle Warteschlange** (`RetroAutoQueue`) mit **einem** Worker ein: automatisch ausgelöste Retro-Läufe werden **eingereiht und strikt nacheinander** (global serialisiert) abgearbeitet — **nie** gleichzeitig. Die eigentliche Ausführung ist ein **headless** `claude -p '/agent-flow:retro --force'`-Lauf je Repo (Muster `CostModeModelCheck`/[[headless-parallel-drain]]) — eine **weitere bewusste, auditierte headless-Ausnahme** (ADR-018).

## Verhalten

### Serielle Warteschlange (ein Worker, global)
1. **`RetroAutoQueue`** hält eine **FIFO**-Liste einzureihender Projekt-Repos und einen **einzigen** aktiven Worker. `enqueue(projectPath)` fügt ein Repo hinzu und startet die Abarbeitung, falls kein Lauf aktiv ist. Zu **keinem Zeitpunkt** läuft mehr als **ein** Retro-Lauf gleichzeitig (globale Serialisierung — die Ablage ist geteilt, deshalb **nicht** projektweise, sondern **global** seriell).
2. **Dedup pro Repo:** ein Repo, das bereits **eingereiht** (in der FIFO) **oder** gerade **aktiv** ist, wird durch ein weiteres `enqueue` **nicht** doppelt aufgenommen (idempotent). `isPendingOrActive(projectPath) → bool` erlaubt dem Auslöser den Dedup-Check ([[retro-auto-trigger]] AC5c).
3. **Abarbeitung:** der Worker nimmt das vorderste Repo, führt **einen** headless Retro-Lauf aus (Regel 5), wartet dessen **echtes Ende** ab (`close`-Event des Kindprozesses), nimmt dann das nächste Repo — bis die FIFO leer ist. Ein **fehlgeschlagener** Lauf (Timeout/Non-Zero/`auth-expired`) **stoppt die Queue nicht**: er wird auditiert, das nächste Repo folgt (degradierend).
4. **Statusanzeige (read-only):** `getStatus() → { active: string|null, pending: string[] }` (Slugs/Repos) als Erweiterungspunkt für die GUI (kein Board-/Secret-Zugriff, keine Seiteneffekte).

### Headless Retro-Ausführung
5. Der Worker fährt den Retro-Lauf über eine **eigene** `HeadlessFlowRunner`-Instanz (bereits generalisiert/befehl-injizierbar, [[headless-parallel-drain]] AC1/AC2) mit **eigener** `ProjectJobLock`-Instanz (getrennt von Nacht-Drain, manuellem Drain, Reconcile-Runner, `IdeaSpecifyFinalizer`, `CostModeModelCheck` — sonst Fremd-/Selbstblockade). Befehl: `/agent-flow:retro`, Args: **`--force`** (G3-Cooldown-Bypass, [[retro-auto-trigger]]), `cwd` = validierter Projekt-Repo-Pfad. Es gelten 1:1 die headless-Sicherheitsregeln: Env-Allowlist + `CLAUDE_CODE_OAUTH_TOKEN`, **harter** `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block (Trust-Boundary), argv als Array (kein Shell-String), `--dangerously-skip-permissions` nur im getrennten headless-Pfad, eigener Timeout, `close`-Event als einzige Fertig-Quelle.
6. **Audit:** jeder Auto-Retro-Lauf erzeugt bei **Start**, **Ende** (Erfolg) und **Fehler** je **genau einen** `AuditEntry` (`AuditStore.record`), analog [[headless-parallel-drain]] AC11. **Keine** Secrets/Token/absoluten Host-Pfade in Audit/Log.
7. **Kein User-Input, kein Live-Terminal:** der Auto-Retro-Lauf ist autonom (headless, `claude -p`), wartet **nie** auf User-Input; ein hängender Prozess wird durch den Timeout (SIGTERM → `failed`) beendet. Keine PTY-Ausgabe (konsistent mit den übrigen headless-Läufen).

### Doktrin / CLAUDE.md / ADR (Drift-Gate)
8. `.claude/CLAUDE.md` und `docs/architecture.md` werden so nachgezogen, dass der **headless Auto-Retro-Runner** als **weitere bewusste, auditierte Ausnahme** (headless, one-shot, kein PTY-Lock, kein API-Key, auditiert) in der bestehenden Reihe (Assist-Helfer, Knowledge-Suche, Reconcile-Runner, headless-Nacht-Drain, Idee-Specify-Finalizer, manueller Headless-Drain, Cost-Mode-Modellprüfung) gelistet ist; `docs/architecture.md` trägt einen **neuen ADR (nächste freie Nummer, ADR-018)** mit Verweis auf diese Spec. Der interaktive PTY-Pfad bleibt ausdrücklich unverändert.

## Acceptance-Kriterien

- **AC1** — `RetroAutoQueue.enqueue(projectPath)` reiht ein Repo ein und startet die Abarbeitung, falls kein Lauf aktiv ist. Es läuft zu **keinem Zeitpunkt** mehr als **ein** Retro-Lauf gleichzeitig (global seriell). Mehrere kurz aufeinander folgende `enqueue` **verschiedener** Repos werden **nacheinander** (FIFO) abgearbeitet — testbar mit gemocktem/instrumentiertem Runner (nie zwei aktive Läufe gleichzeitig). *(1,3)*
- **AC2** — Dedup: `enqueue` desselben Repos, das bereits eingereiht **oder** aktiv ist, ist **idempotent** (kein zweiter Eintrag, kein zweiter Lauf für dieses Repo, solange der erste pending/aktiv ist). `isPendingOrActive(projectPath)` spiegelt diesen Zustand korrekt. *(2)*
- **AC3** — Ein **fehlgeschlagener** Retro-Lauf (Timeout/Non-Zero-Exit/`auth-expired`/`spawn`-Fehler) **stoppt die Queue nicht**: der Fehler wird auditiert (secret-frei), der Worker fährt mit dem nächsten Repo fort; das `ProjectJobLock` wird im `finally` freigegeben (kein Dauer-Lock). *(3)*
- **AC4** — `getStatus() → { active: string|null, pending: string[] }` liefert einen read-only Snapshot ohne Seiteneffekte/Secrets. *(4)*
- **AC5** — Headless-Ausführung: der Lauf startet einen `claude -p`-Kindprozess mit Befehl `/agent-flow:retro` + Arg **`--force`** (argv-Array, kein Shell-String), `cwd` = validierter Repo-Pfad, über eine **eigene** `HeadlessFlowRunner`- + `ProjectJobLock`-Instanz (getrennt von allen anderen Runnern). Env-Allowlist + `CLAUDE_CODE_OAUTH_TOKEN`; **harter** `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block; `close`-Event als einzige Fertig-Quelle; eigener Timeout → SIGTERM/`failed`. **Kein** echter `claude -p`-Live-Lauf im Test-Gate (gemockte `spawnFn`/Runner). *(5,7)*
- **AC6** — Audit je Auto-Retro-Lauf bei **Start**, **Ende** (Erfolg), **Fehler** — je **genau ein** `AuditEntry`; **keine** Secrets/Token/absoluten Host-Pfade in Audit/Log. *(6)*
- **AC7** (Doktrin-Anpassung — Drift-Gate) — `.claude/CLAUDE.md` listet den **headless Auto-Retro-Runner** als weitere bewusste, auditierte headless-Ausnahme; `docs/architecture.md` trägt einen **neuen ADR (ADR-018)** mit Verweis auf diese Spec. Der interaktive PTY-Pfad bleibt ausdrücklich unverändert. Diese Doku-Anpassung ändert **keinen** Laufzeit-Code. *(8)*

## Verträge

### `RetroAutoQueue` (sprach-neutral)
- `enqueue(projectPath) → void` — idempotent pro Repo (AC2); startet den Worker falls idle.
- `isPendingOrActive(projectPath) → boolean` — Dedup-Abfrage für den Auslöser ([[retro-auto-trigger]] AC5c).
- `getStatus() → { active: string|null, pending: string[] }` — read-only.
- Konstruktor injizierbar: `retroRunner` (headless Retro-Runner, s.u.), `auditStore`, optional `identity`.
- **Queue↔Runner-Naht** (Grenze S-256 ⇄ S-257): die Queue ruft am injizierten `retroRunner` **ausschließlich** `run(projectPath) → Promise` auf — **resolved** bei Erfolg (echtes Lauf-Ende), **rejected** bei Fehlschlag (Timeout/Non-Zero/`auth-expired`/`spawn`-Fehler). Die konkrete headless-Ausführung (`HeadlessFlowRunner.start()`/`getJob()`, `close`-Event, Per-Lauf-Audit AC6, `ProjectJobLock`-Freigabe im `finally`) lebt **innerhalb** dieses `run()` (Folge-Story S-257, AC5/AC6) — **nicht** in der Queue. Die Queue behandelt eine Rejection als Degradation (AC3): secret-freies Queue-Audit (Repo-Slug, kein Host-Pfad), dann nächstes Repo. Bei Erfolg auditiert die Queue **nicht** (das Per-Lauf-Audit liegt im Runner, AC6).

### Headless Retro-Runner (Wiederverwendung)
- `HeadlessFlowRunner` (`src/HeadlessFlowRunner.js`) — bereits befehl-injizierbar ([[headless-parallel-drain]] AC1/AC2). Instanz mit **eigenem** `ProjectJobLock`; Aufruf `start(projectPath, { command: '/agent-flow:retro', args: ['--force'] })`; `getJob(jobId) → { status: 'running'|'done'|'failed'|'auth-expired', … }`; Ende = `close`-Event.
- Timeout: eigener, konfigurierbarer Env-Default (z.B. `RETRO_HEADLESS_TIMEOUT_MS`), großzügig (ein Retro-Lauf mit Clustering/Dedup/PR dauert). Nicht an den Reconcile-Default gekoppelt.
- `AuditStore` (`src/AuditStore.js`) — Audit je Lauf (AC6).

### Verdrahtung
- `server.js` (Composition-Root): eine `RetroAutoQueue`-Instanz + eigener `HeadlessFlowRunner` (+ eigenes `ProjectJobLock`) + `auditStore`; die Instanz wird [[retro-auto-trigger]] (Nacht-Scheduler + manueller Drain-Router) injiziert. Muster: `costModeModelCheck` (eigener Runner, fire-and-forget, best-effort) in `server.js` Z.385–389.

## Edge-Cases & Fehlerverhalten
- **`auth-expired` (401)** — Vorrang vor „sauberem" Exit 0; Lauf `failed`/auditiert, Queue fährt fort, Lock im finally frei.
- **Timeout / hängender Prozess** — SIGTERM nach Timeout → `failed`; Queue fährt fort.
- **`spawn`-Fehler (`ENOENT` „claude nicht verfügbar")** — Lauf `failed` mit generischer, secret-freier Meldung; Queue fährt fort.
- **`enqueue` während aktivem Lauf** — Repo landet hinten in der FIFO (bzw. Dedup, falls schon vorhanden); wird nach dem aktuellen Lauf gezogen.
- **Server-Neustart** — In-Memory-Queue verloren (Nicht-Ziel: keine persistente Retro-Queue); ein laufender Subprozess wird ggf. verwaist (Timeout/OS bereinigt) — akzeptiert, analog den bestehenden headless-Runnern.
- **Ungültiger/nicht-existenter Repo-Pfad** — der headless-Runner scheitert (`failed`), Queue fährt fort; kein Crash.

## NFRs
- **Sicherheit (Floor):** kein Anthropic-/OpenAI-API-Key in der Child-Env (harter Block); `--dangerously-skip-permissions` nur im getrennten headless-Pfad; argv als Array; keine Secrets/Token/absoluten Host-Pfade in Log/Audit; eigenes `ProjectJobLock` (keine Fremd-/Selbstblockade). Der headless-Retro-Pfad importiert/mutiert **weder** `PtyManager`/`PtySessionRegistry` **noch** den interaktiven `CommandService`-Schreibpfad (Trust-Boundary).
- **Serialisierung (Kern-NFR):** global genau **ein** aktiver Retro-Lauf — Schutz der geteilten Lern-Ablage (`LEARNINGS.md`, globale Packs) vor konkurrierenden Läufen/PRs.
- **Robustheit:** ein Lauf-Fehler kippt weder die Queue noch den Scheduler noch den manuellen Drain (degradierend, `.catch()`); Timer/Locks blockieren keinen Shutdown; Timer `unref()`.
- **Testbarkeit:** `retroRunner`/`spawnFn` injizierbar → alle ACs ohne echten `claude`-Lauf prüfbar (gemockt).
- **Kosten:** der Retro-Lauf zählt gegen das Abo (`CLAUDE_CODE_OAUTH_TOKEN`, kein API-Key).

## Nicht-Ziele
- **Keine** persistente Queue/Job-Historie (In-Memory; geht bei Neustart verloren).
- **Keine** projektweise Parallelität für Auto-Retro (bewusst **global seriell** wegen der geteilten Ablage).
- **Keine** Änderung des `retro`-Agenten selbst (G1/G3/G4 bleiben in agent-flow; `--force` existiert dort bereits).
- **Kein** echter `claude -p`-Live-Lauf im Test-Gate (gemockt, Restrisiko wie [[headless-parallel-drain]]).
- **Keine** Verdrahtung an den **manuellen** „Retro starten"-Klick ([[team-train-trigger]]) — der bleibt interaktiv/PTY mit G3; diese Queue betrifft **nur** die **automatisch** ausgelösten Läufe.

## Restrisiko (bewusst akzeptiert)
Die **reale Naht** zu echtem `claude -p '/agent-flow:retro --force'` (tatsächliches Prozess-/PR-Verhalten, OAuth-Token-Nutzung, echte `close`-Semantik, Verwaisung bei Server-Neustart) wird — wie bei den übrigen headless-Runnern — **nicht** live im Test-Gate verifiziert (gemockter Runner), sondern erst im echten Einsatz (Audit-Logs beobachten). Serialisierung + Dedup + Degradation sind vollständig gemockt testbar.

## Abhängigkeiten
- [[retro-auto-trigger]] (reiht ein — Policy/Auslösung + Schalter) · [[headless-parallel-drain]] (`HeadlessFlowRunner`, befehl-injizierbar, Env-Allowlist, 401-Vorrang, Timeout, `ProjectJobLock`, Audit-Muster) · [[headless-reconcile-runner]] (Runner-Muster) · [[claude-code-oauth-token]] (`CLAUDE_CODE_OAUTH_TOKEN`) · [[taktgeber-nachtwaechter]] (Audit AC18) · agent-flow `agents/retro.md` (`/agent-flow:retro --force`, G1/G3 unverändert).
- **Doktrin-Anpassung (eigenes Board-Item, AC7):** `.claude/CLAUDE.md` + `docs/architecture.md` (ADR-018).
