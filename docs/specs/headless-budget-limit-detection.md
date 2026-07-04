---
id: headless-budget-limit-detection
title: Reaktive Session-Limit-Erkennung im headless `claude -p`-Kindprozess
status: active
area: nachtwaechter
version: 1
---

# Spec: Reaktive Session-Limit-Erkennung im Headless-Runner  (`headless-budget-limit-detection`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Ein headless `claude -p '/agent-flow:flow'`-Kindprozess ([[headless-parallel-drain]]) kann mitten im Lauf Claudes **Session-/Usage-Limit** erreichen. Der Prozess gibt dann eine Meldung wie **„hit your session limit · resets <Zeit>"** auf stdout/stderr aus und endet. Bislang wird das im Headless-Pfad **nicht** erkannt: `HeadlessRunnerCore` unterscheidet nur `done` / `failed` / `auth-expired` (kein PTV zum Mitlesen, siehe [[headless-parallel-drain]] Abschnitt „Restrisiko"). Ein solcher Lauf landet heute als **`failed`** — der Nacht-Drain wertet das im schlimmsten Fall als „kein Fortschritt" und eskaliert eine gesunde Story fälschlich auf `Blocked` (reiner Token-Mangel, keine echte Blockade).

Diese Spec schliesst die **reaktive** Erkennungslücke: `HeadlessRunnerCore` liest die von ihm ohnehin erfasste kombinierte Kindprozess-Ausgabe (`stdout`+`stderr`) auf die Session-Limit-Meldung, **parst den Reset-Zeitpunkt** und meldet einen **eigenen terminalen Job-Status `budget-limited`** samt `resetAt` — statt `failed`. Dieser Status ist das reaktive Signal, das [[night-budget-guard]] konsumiert, um den Drain sauber zu **pausieren** (statt zu eskalieren). Diese Spec liefert **nur die Erkennung/den Signalträger** — die Pause-/Fortsetzungs-Logik selbst liegt in [[night-budget-guard]].

## Verhalten

1. **Erfassung wiederverwendet.** `HeadlessRunnerCore` sammelt bereits `stdout`/`stderr` des Kindprozesses zu `combined` (`src/HeadlessRunnerCore.js`, `#runProcess`). Die Erkennung nutzt genau diese bereits vorhandene `combined`-Ausgabe — **kein** neuer IO-/PTY-Pfad.
2. **Parser wiederverwendet.** Die Reset-Zeit wird über die bestehende, fehlalarm-robuste `parseTokenLimitMessage`/`LIMIT_KEYWORD_RE`-Logik aus `src/TokenLimitWatcher.js` bestimmt (Keyword-Proximity, ANSI-Stripping, TZ-/Über-Mitternacht-Rollover). Deckt die Meldungsform **„session limit … resets <Zeit>"** ab; die Wortvariante **„hit your session limit · resets 3am"** wird mit abgedeckt (falls die bestehende Regex sie nicht trifft, wird sie **minimal erweitert** — ohne die bestehenden `TokenLimitWatcher`-ACs zu brechen).
3. **Neuer terminaler Status `budget-limited`.** Erkennt `HeadlessRunnerCore` in `combined` eine Session-Limit-Meldung **mit** parsebarem Reset-Zeitpunkt, wird der Job terminal auf `budget-limited` gesetzt (`{ status: 'budget-limited', resetAt: <ms epoch>, rawMatch }`) — **nicht** `failed`. Eine erkannte Limit-Meldung **ohne** robust parsebare Reset-Zeit fällt auf das bisherige Verhalten zurück (`failed`, kein Fehlalarm — analog `TokenLimitWatcher`-Robustheit).
4. **Vorrang-Reihenfolge (verbindlich).** In der terminalen Auswertung des `close`-Events gilt: **(1)** `auth-expired` (401) hat weiterhin **höchsten** Vorrang (unverändert); **(2)** dann `budget-limited` (Session-Limit erkannt + Reset parsebar) — **auch** wenn der Exit-Code 0 oder ≠ 0 ist (die Limit-Meldung ist aussagekräftiger als der Exit-Code); **(3)** dann `done` bei Exit 0; **(4)** sonst `failed`. Die bestehende 401-Vorrang-Regel bleibt bit-identisch.
5. **Durchreichung durch den Adapter.** `HeadlessFlowRunnerAdapter.awaitCompletion()` (`src/FlowRunner.js`) reicht den neuen Status `budget-limited` samt `resetAt` **1:1** durch (analog zur bestehenden 1:1-Durchreichung von `done`/`failed`/`auth-expired`). Der `awaitCompletion`-Rückgabewert erhält zusätzlich das Feld `resetAt` (nur gesetzt bei `budget-limited`, sonst `undefined`).
6. **Audit.** Der Adapter erzeugt bei einem `budget-limited`-Ende **genau einen** Ende-`AuditEntry` (analog zum bestehenden `headless-flow-failed`-Audit), secret-/pfad-frei, mit `status=budget-limited` und dem Reset-Zeitpunkt (ISO-8601, keine absoluten Host-Pfade).
7. **Kein Regress.** `done`/`failed`/`auth-expired` und alle bestehenden ACs von [[headless-parallel-drain]] / [[headless-reconcile-runner]] bleiben unverändert (`HeadlessReconcileRunner` nutzt denselben Core, darf aber weiterhin nie `budget-limited` als unerwarteten Status brechen — der Status ist additiv, Reconcile-Aufrufer ignorieren ihn wie einen `failed`).

## Acceptance-Kriterien

- **AC1** — `HeadlessRunnerCore` prüft die bereits erfasste kombinierte Kindprozess-Ausgabe (`stdout`+`stderr`) beim `close`-Event auf eine Session-/Usage-Limit-Meldung (Wiederverwendung `parseTokenLimitMessage` aus `src/TokenLimitWatcher.js`). Wird eine Meldung **mit** parsebarem Reset-Zeitpunkt erkannt, wird der Job terminal auf `budget-limited` gesetzt mit `{ status:'budget-limited', resetAt:<ms epoch>, rawMatch }` (**kein** neuer PTY-/IO-Pfad). *(1,2,3)*
- **AC2** — Vorrang-Reihenfolge im `close`-Handler: (1) `auth-expired` (401, unverändert höchster Vorrang) → (2) `budget-limited` (Limit erkannt + Reset parsebar, **unabhängig** vom Exit-Code) → (3) `done` (Exit 0) → (4) `failed`. Die bestehende 401-Vorrang-Regel und alle bestehenden Statuspfade bleiben bit-identisch. *(4)*
- **AC3** — Eine Session-Limit-Meldung **ohne** robust parsebare Reset-Zeit löst **kein** `budget-limited` aus (kein Fehlalarm): der Job fällt auf das bisherige Verhalten zurück (`failed` bei Exit ≠ 0, `done` bei Exit 0). Ein Text **ohne** Limit-Keyword ergibt nie `budget-limited`. *(3)*
- **AC4** — `HeadlessFlowRunnerAdapter.awaitCompletion()` reicht `budget-limited` samt `resetAt` 1:1 durch (`{ status:'budget-limited', resetAt, … }`); für alle anderen Status bleibt `resetAt` `undefined`. Der `handle`-Vertrag (`{jobId}`) und die Durchreichung von `done`/`failed`/`auth-expired` bleiben unverändert (S-212/S-213 kein Regress). *(5)*
- **AC5** — Der Adapter erzeugt bei `budget-limited` **genau einen** secret-/pfad-freien Ende-`AuditEntry` (`status=budget-limited`, Reset-Zeit ISO-8601, Projekt-**Basename** statt absolutem Pfad) — analog zum bestehenden `headless-flow-failed`-Audit. Keine Secrets/Token/absoluten Host-Pfade in Audit/Log. *(6)*
- **AC6** — Kein Regress: `HeadlessReconcileRunner` und alle ACs von [[headless-parallel-drain]] / [[headless-reconcile-runner]] bleiben grün; der neue Status ist rein additiv (bestehende Aufrufer, die nur `done`/`failed`/`auth-expired` kennen, behandeln `budget-limited` unschädlich wie einen nicht-erfolgreichen Lauf). Gate = Unit-Tests mit gemocktem `spawn`/Runner (kein echter `claude -p`-Lauf). *(7)*

## Verträge

### `HeadlessRunnerCore` Job-Registry (Erweiterung)
- `getJob(jobId) → { status: 'running'|'done'|'failed'|'auth-expired'|'budget-limited', result?, error?, prHint?, resetAt? }`
  - `resetAt` (ms epoch) ist **nur** bei `status:'budget-limited'` gesetzt.

### `FlowRunner`-Interface (`HeadlessFlowRunnerAdapter`, Erweiterung)
- `awaitCompletion(handle) → Promise<{ status: 'done'|'failed'|'auth-expired'|'budget-limited', result?, error?, prHint?, resetAt? }>`
  - Neuer Terminal-Status `budget-limited` inkl. `resetAt` (1:1-Durchreichung, keine sonstige Vertrags-/`handle`-Änderung).

## Edge-Cases & Fehlerverhalten
- **Limit-Meldung + Exit 0** — `budget-limited` gewinnt gegen `done` (die Meldung ist aussagekräftiger als der Exit-Code), aber **nicht** gegen `auth-expired` (401 bleibt höchster Vorrang).
- **Reset-Zeit in der Vergangenheit / unplausibel** — die Rollover-Logik von `parseTokenLimitMessage` (heute→morgen) greift wie im `TokenLimitWatcher`; die Pause-Logik selbst ([[night-budget-guard]]) begrenzt negative Wartezeiten separat.
- **Mehrere Limit-Meldungen im selben Output** — der zuletzt/ein plausibel geparster Reset-Zeitpunkt wird verwendet (Parser-Verhalten unverändert); genau **ein** terminaler Status.
- **Kein Reset-Zeitpunkt parsebar** — kein `budget-limited` (AC3), kein Fehlalarm.

## NFRs
- **Sicherheit (Floor):** keine Secrets/Token/absoluten Host-Pfade in Status/Audit/Log; der `rawMatch` wird nur secret-frei (kurzer Meldungsausschnitt) geführt. Kein neuer Env-/Spawn-Pfad — die bestehende Env-Allowlist/`ANTHROPIC_API_KEY`-Block-Trust-Boundary bleibt unverändert.
- **Robustheit:** die Erkennung ist rein additiv im bestehenden `close`-Handler; ein Parser-Fehler darf den Runner nicht crashen (Fallback `failed`/`done` wie bisher).
- **Testbarkeit:** `spawnFn` injizierbar (wie bisher) → alle ACs ohne echten `claude`-Lauf prüfbar.

## Nicht-Ziele
- **Keine** Pause-/Fortsetzungs-Logik, **kein** `budget-paused`-Zustand, **keine** Eskalations-Schutz-Änderung — das liegt vollständig in [[night-budget-guard]].
- **Keine** proaktive Verbrauchsmessung — das liegt in [[token-usage-meter]].
- **Kein** Umbau des interaktiven `TokenLimitWatcher`-PTY-Pfads (der bleibt für den interaktiven Pfad unverändert; hier wird nur sein **Parser** wiederverwendet).

## Abhängigkeiten
- [[headless-parallel-drain]] (`HeadlessRunnerCore`, `HeadlessFlowRunnerAdapter`, Job-Registry, „Restrisiko" headless-Token-Limit — hier geschlossen) · [[taktgeber-nachtwaechter]] (`TokenLimitWatcher.parseTokenLimitMessage` — Parser-Wiederverwendung) · [[night-budget-guard]] (Konsument des `budget-limited`-Signals) · [[headless-reconcile-runner]] (geteilter Core — kein Regress).
