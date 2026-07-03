---
id: night-budget-guard
title: Nacht-Budget-Schutz — Drain pausiert statt zu eskalieren bei Token-Limit/Budget
status: active
version: 1
---

# Spec: Nacht-Budget-Schutz  (`night-budget-guard`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Nächtliche Board-Drains ([[headless-parallel-drain]], [[taktgeber-nachtwaechter]]) laufen gegen **ein** Abo-Token mit konto-weitem Session-/Usage-Limit. Erreicht der Drain dieses Limit, passieren heute zwei Probleme: **(1)** limit-bedingte Fehlläufe werden als „kein Fortschritt" gewertet und eine **gesunde** Drain-Ziel-Story fälschlich auf `Blocked` eskaliert (Board-Datenkorruption aus reinem Token-Mangel); **(2)** der Drain verbrennt Token bis zum harten Limit statt vorausschauend zu pausieren.

Diese Spec führt den **Nacht-Budget-Schutz** ein — die **zentrale Pause-/Schutz-Logik** über den beiden Signalquellen:
- **REAKTIV** — ein headless-`/flow`-Lauf, der Claudes Session-Limit erreicht, meldet über [[headless-budget-limit-detection]] den Status `budget-limited` samt Reset-Zeitpunkt. Der Drain wechselt in den Zustand **`budget-paused`** und setzt **~5 Min nach dem Reset** fort.
- **PROAKTIV** — ein Owner-konfigurierbares **Nacht-Budget** (Output-Tokens) wird über [[token-usage-meter]] laufend gemessen. Überschreitet der Verbrauch die Schwelle (Default **85 %**), pausiert der Drain **zwischen zwei Flow-Runden** (Story-Grenze — kein Abbruch mitten in einer Story) bis zum Reset.
- **ESKALATIONS-SCHUTZ (kritisch)** — limit-/budget-bedingte Fehlläufe und Pausen inkrementieren **niemals** den Eskalations-Zähler von `ProjectDrain`; **keine** Story wird wegen Token-Mangel auf `Blocked` gesetzt.
- **BERICHT** — jede Budget-Pause (von–bis, Grund) erscheint im Drain-Abschlussbericht ([[drain-completion-report]]).

## Annahmen (konservativ, da nicht-interaktiv geklärt)
- **A1 — Proaktives Reset-Wissen.** Eine proaktive Schwellen-Überschreitung kennt den exakten konto-weiten Reset-Zeitpunkt nur, wenn in **derselben** Nacht bereits eine **reaktive** Limit-Meldung erkannt wurde (deren `resetAt` gemerkt wird). Ist **kein** Reset-Zeitpunkt bekannt, wird **nicht geraten**: der Drain führt ein **sanftes Ende für die aktuelle Nacht** aus (`budget-window-end` beim Nacht-Drain / `budget-stop` beim manuellen Drain ohne Fenster) und setzt in der nächsten Nacht mit frischem Budget fort. Das ist die konservativste, token-sparsame Wahl.
- **A2 — Fenster-Ende hat Vorrang.** Liegt der Fortsetzungs-Zeitpunkt (`resetAt + Puffer`) **nach** `window.end`, wird **nicht** gewartet — der Drain stoppt sanft (`budget-window-end`) und die nächste Nacht setzt fort (identische Semantik zu [[taktgeber-nachtwaechter]] AC14 / `TokenLimitWatcher.waitForReset` `exceeds-window`).
- **A3 — Reaktiver Puffer.** Der Fortsetzungs-Puffer nach dem Reset ist **~5 Min** (Default `BUDGET_RESUME_BUFFER_MS`), bewusst großzügiger als der 1-Min-Puffer des interaktiven [[taktgeber-nachtwaechter]]-Pfads (headless-Prozesse starten träger, Reset-Zeit ist gerundet).
- **A4 — Proaktiv nur bei konfiguriertem Budget.** `nightBudgetTokens = 0` (Default) ⇒ der **proaktive** Schutz ist inaktiv. Der **reaktive** Schutz (Limit-Meldung → Pause statt Eskalation) ist **immer** aktiv (er kostet nichts und verhindert Board-Korruption).

## Verhalten

### Konfiguration (Settings)
1. Zwei neue, persistente Nachtwächter-Settings (Erweiterung des bestehenden `TickerSettingsStore` / `ticker-settings.json`, Muster [[taktgeber-nachtwaechter]] AC15):
   - **`nightBudgetTokens`** — Ganzzahl **≥ 0**, Default **0**. Nacht-Budget in Output-Tokens; `0` = proaktiver Schutz aus (A4).
   - **`budgetThresholdPercent`** — Ganzzahl **1–100**, Default **85**. Anteil des Budgets, ab dem proaktiv pausiert wird.
   Beide werden über `GET/PUT /api/settings/ticker` gelesen/geschrieben und in `NightWatchSettings.jsx` als Felder angeboten. Alle bestehenden Ticker-Felder bleiben unverändert.

### Reaktiver Schutz (Drain-Ebene)
2. Ein `/flow`-Lauf, dessen `FlowRunner`-Ergebnis den Status **`budget-limited`** (mit `resetAt`, aus [[headless-budget-limit-detection]]) trägt, gilt **nicht** als fortschrittsloser Lauf. Der Drain: **(a)** merkt sich `resetAt` (für A1), **(b)** erfasst eine Budget-Pause (`reason:'reactive-limit'`, `from = now`), **(c)** wartet bis `resetAt + BUDGET_RESUME_BUFFER_MS` (A3) — sofern das **nicht** hinter `window.end` liegt (A2) — und **(d)** setzt danach die Drain-Schleife fort (nächster Board-Scan). Kein Eskalations-Zähler-Increment, kein `setBlocked`.
3. Liegt der Fortsetzungs-Zeitpunkt hinter `window.end` (A2), stoppt der Drain sanft mit `reason:'budget-window-end'` (kein Kill, nächste Nacht). Ohne Fenster (manueller Drain) wird gewartet.

### Proaktiver Schutz (zwischen zwei Flow-Runden)
4. **Vor** dem Start einer Flow-Runde (Story-Grenze) fragt der Drain — sofern ein `budgetGuard` injiziert ist — dessen proaktive Prüfung: der `budgetGuard` misst über [[token-usage-meter]] den Output-Token-Verbrauch im laufenden Fenster und vergleicht ihn gegen `nightBudgetTokens × budgetThresholdPercent / 100`. Ist die Schwelle **erreicht/überschritten**, pausiert der Drain **ohne** eine Flow-Runde zu starten (kein `flowRuns`-Increment): Budget-Pause erfassen (`reason:'proactive-threshold'`, `from = now`), bis zum bekannten Reset warten (A1) bzw. sanft enden (A1/A2), dann fortsetzen. Kein Eskalations-Zähler-Increment, kein `setBlocked`.
5. `nightBudgetTokens = 0` **oder** kein `budgetGuard` injiziert ⇒ die proaktive Prüfung ist ein No-op (Default-Verhalten unverändert, A4).

### Eskalations-Schutz (kritisch)
6. **Weder** ein `budget-limited`-Flow-Ergebnis, **noch** eine reaktive/proaktive Budget-Pause, **noch** ein `budget-window-end`/`budget-stop`-Stop dürfen den `consecutiveNoProgress`- **oder** den `totalNoProgressRounds`-Zähler von `ProjectDrain` erhöhen oder eine `BoardWriter.setBlocked`-Eskalation auslösen. Eine Drain-Ziel-Story darf **unter keinen Umständen** wegen Token-Mangel auf `Blocked` landen. Dies ist eine **harte, testbare Sicherheits-Anforderung** (Schutz vor Board-Datenkorruption).

### Wiring (Nacht-Drain + manueller Drain)
7. Die Composition-Root (`server.js`) baut einen konkreten `BudgetGuard` (kapselt [[token-usage-meter]] + Settings-Lesen + Reset-/Puffer-Logik) und injiziert ihn in die **Nacht-Drain**-`ProjectDrain`-Instanz. Der `NightWatchScheduler` reicht das für „jetzt" gültige `windowEndMs` (Wiederverwendung `computeWindowEndMs`, [[taktgeber-nachtwaechter]] AC10) an den Drain, damit Budget-Pausen das sanfte Fensterende ehren (A2). Der reaktive Schutz (Punkt 2/3) gilt **auch** für den manuellen Headless-Drain ([[headless-manual-drain]]); der proaktive Schutz ist dort verfügbar, sofern ein Budget konfiguriert ist (ohne Fenster gilt A1: `budget-stop`).

### Bericht
8. Das Drain-Ergebnis (`drainProject()`) trägt zusätzlich `budgetPauses: [{ from, to, reason }]` (`reason` ∈ `reactive-limit`|`proactive-threshold`; `to = null`, wenn die Pause den Drain sanft beendete). `DrainReportStore.record` ([[drain-completion-report]] AC3) wird **additiv** um `budgetPauses` erweitert; Nacht- **und** manueller Drain persistieren es. Die Bericht-Anzeige ([[drain-completion-report]] AC7) zeigt Budget-Pausen (von–bis, Grund) **textlich**.

## Acceptance-Kriterien

### Konfiguration (Settings)
- **AC1** — `TickerSettingsStore` erhält zwei additive Felder: `nightBudgetTokens` (Ganzzahl ≥ 0, Default 0) und `budgetThresholdPercent` (Ganzzahl 1–100, Default 85). `read`/`write`/`_mergeWithDefaults`/`validate` behandeln sie (Default-Merge, Typ-/Bereichs-Validierung: `nightBudgetTokens < 0` → `400 {field}`, `budgetThresholdPercent` außerhalb 1–100 → `400 {field}`). `GET/PUT /api/settings/ticker` geben/nehmen beide Felder durch. **Alle** bestehenden Ticker-Felder + ACs ([[taktgeber-nachtwaechter]] AC15) bleiben unverändert. *(1)*
- **AC2** — `NightWatchSettings.jsx` bietet beide Felder an (Nacht-Budget in Tokens, Schwelle in %), mit leichter Client-Vorabprüfung, feldzugeordneter 4xx-Fehleranzeige (`aria-describedby`/`aria-invalid`) und A11y-Muster wie die bestehenden Felder. Werte werden über `GET`/`PUT /api/settings/ticker` geladen/gespeichert. Bestehende Sektions-Felder unverändert. *(1)*
- **AC3** — `nightBudgetTokens = 0` (Default) ⇒ proaktiver Schutz inaktiv (A4); die Konfiguration ist rein additiv (bestehende `ticker-settings.json`-Dateien ohne die neuen Felder lesen sauber auf die Defaults). *(1,5)*

### Drain-Kern (reaktiv + proaktiv + Eskalations-Schutz)
- **AC4** — **Reaktiv:** ein `/flow`-Lauf, dessen `FlowRunner.awaitCompletion()`-Ergebnis `status:'budget-limited'` (mit `resetAt`) ist, wird **nicht** als fortschrittsloser Lauf gewertet: der Drain erfasst eine Budget-Pause (`reason:'reactive-limit'`), wartet bis `resetAt + BUDGET_RESUME_BUFFER_MS` (Default ~5 min) — sofern nicht hinter `windowEndMs` (AC6) — und setzt danach die Schleife fort. Wartezeiten werden nie negativ. *(2, A3)*
- **AC5** — **Proaktiv:** ist ein `budgetGuard` injiziert und `nightBudgetTokens > 0`, prüft der Drain **vor** jeder Flow-Runde die Schwelle (`verbrauch ≥ nightBudgetTokens × budgetThresholdPercent/100`, Verbrauch aus [[token-usage-meter]]). Bei Überschreitung startet **keine** Flow-Runde (`flowRuns` unverändert), es wird eine Budget-Pause (`reason:'proactive-threshold'`) erfasst und bis zum Reset gewartet (A1) bzw. sanft geendet (AC6). *(4)*
- **AC6** — **Sanftes Ende:** liegt der Fortsetzungs-Zeitpunkt hinter dem übergebenen `windowEndMs` **oder** ist bei einer proaktiven Pause kein Reset-Zeitpunkt bekannt (A1), stoppt der Drain sanft — `reason:'budget-window-end'` (Nacht-Drain mit Fenster) bzw. `reason:'budget-stop'` (kein Fenster/manuell) — **ohne** laufende Läufe zu killen; die nächste Nacht setzt fort. `windowEndMs = null` (kein Fenster) ⇒ reaktive Pause wartet regulär. *(3,4, A1,A2)*
- **AC7** — **Eskalations-Schutz (kritisch, Sicherheit):** ein `budget-limited`-Ergebnis, eine reaktive/proaktive Budget-Pause und ein `budget-window-end`/`budget-stop`-Stop erhöhen **weder** `consecutiveNoProgress` **noch** `totalNoProgressRounds` und lösen **nie** `BoardWriter.setBlocked` aus. Ein Test weist explizit nach: ein wiederholt `budget-limited` liefernder Flow-Runner führt **nie** zu einer eskalierten (`Blocked`) Story — auch über `escalationAttempts` Runden hinaus. *(6)*
- **AC8** — **Kein Regress (Default):** ohne injizierten `budgetGuard` und ohne `budget-limited`-Status verhält sich `ProjectDrain` **bit-identisch** zu heute (Ziel-Auswahl, Konvergenz, Eskalation, Snapshot-Diff, Sicherheitsgürtel, `command-channel-busy`-Pfad unverändert); der interaktive/manuelle Default-Pfad bleibt unberührt. *(5, [[headless-parallel-drain]] AC6)*

### Wiring (Composition-Root + Scheduler)
- **AC9** — Ein konkreter `BudgetGuard` (kapselt [[token-usage-meter]] `getUsage`, Settings-Lesen `nightBudgetTokens`/`budgetThresholdPercent`, `BUDGET_RESUME_BUFFER_MS`, gemerkter `resetAt` A1) wird in `server.js` gebaut und in die **Nacht-Drain**-`ProjectDrain`-Instanz injiziert. Seine proaktive Prüfung vergleicht den gemessenen Output-Token-Verbrauch gegen die Budget-Schwelle. `nightBudgetTokens = 0` ⇒ proaktive Prüfung liefert „keine Pause" (No-op, A4). *(4,5,7)*
- **AC10** — `NightWatchScheduler` reicht `windowEndMs` (Wiederverwendung `computeWindowEndMs`, [[taktgeber-nachtwaechter]] AC10 — keine eigene TZ-Logik) an den Nacht-Drain, sodass Budget-Pausen das sanfte Fensterende ehren (AC6). `BUDGET_RESUME_BUFFER_MS` (Default ~5 min) ist per Env konfigurierbar, entkoppelt vom 1-Min-`TokenLimitWatcher`-Puffer. *(7, A2,A3)*
- **AC11** — **Reset-Wissen (A1):** der `BudgetGuard` merkt sich den `resetAt` einer reaktiven Limit-Meldung; eine proaktive Pause nutzt diesen (falls in derselben Nacht bekannt), sonst führt sie das sanfte Ende (AC6) aus statt zu raten. Der **reaktive** Schutz (AC4) ist **unabhängig** von `nightBudgetTokens` immer aktiv. *(A1, A4)*

### Bericht
- **AC12** — `drainProject()` liefert zusätzlich `budgetPauses: [{ from, to, reason }]` (`reason` ∈ `reactive-limit`|`proactive-threshold`; `to = null` bei sanftem Ende). `DrainReportStore.record` ([[drain-completion-report]] AC3) wird **additiv** um `budgetPauses` erweitert; **Nacht- und manueller** Drain persistieren es; fehlendes Feld (Alt-Berichte) → `[]` (rückwärtskompatibel). Kein Regress an den bestehenden Report-Feldern. *(8)*
- **AC13** — Die Bericht-Anzeige ([[drain-completion-report]] AC7, `CockpitView.jsx`) zeigt Budget-Pausen **textlich** (von–bis, Grund) je Bericht; leer → dezent/nichts. Zahlen/Status textlich (nicht nur farblich). Bestehende Bericht-Ansicht (erledigt/blockiert) unverändert. *(8)*

## Verträge

### Settings-Schema (`ticker-settings.json`, additiv)
| Feld | Typ | Default | Validierung |
|---|---|---|---|
| `nightBudgetTokens` | int | `0` | ≥ 0 (`0` = proaktiv aus) |
| `budgetThresholdPercent` | int | `85` | 1–100 |

### `BudgetGuard` (neu, injiziert in `ProjectDrain`) — sprach-neutral
- `checkProactive({ nowMs }) → Promise<{ pause: boolean, reason?: 'proactive-threshold', resumeAt?: number|null }>`
  - `pause:false` wenn `nightBudgetTokens = 0`, keine Messung möglich, oder Verbrauch < Schwelle.
- `noteReset(resetAt)` — merkt den zuletzt reaktiv erkannten Reset-Zeitpunkt (A1/AC11).
- `awaitResume({ resumeAt, windowEndMs, nowMs }) → Promise<{ resumed: true, from, to } | { resumed: false, reason: 'budget-window-end'|'budget-stop', from }>`
  - wartet bis `resumeAt + BUDGET_RESUME_BUFFER_MS`, sofern nicht hinter `windowEndMs`; sonst sanftes Ende (kein negatives Warten).

### `ProjectDrain` (Erweiterung)
- Konstruktor: optionaler `budgetGuard`; ohne ihn Default-Verhalten (AC8).
- `drainProject(projectPath, opts)` — `opts.windowEndMs?: number|null` (vom Scheduler; `null` = kein Fenster).
- Rückgabe erweitert: `reason` zusätzlich `'budget-window-end'|'budget-stop'`; neues Feld `budgetPauses: [{from,to,reason}]`.

### `DrainReportStore.record` (Erweiterung, [[drain-completion-report]])
- Bericht-Schema additiv um `budgetPauses: [{ from, to, reason }]`; `list()`/`GET /api/drain-reports` geben es durch (fehlend → `[]`).

## Edge-Cases & Fehlerverhalten
- **Reset-Zeit in der Vergangenheit** (Latenz zwischen Erkennung und Warten) → Wartezeit `max(…, 0)`, minimaler Puffer statt negativem `setTimeout`.
- **`budget-limited` ohne `resetAt`** (dürfte nach [[headless-budget-limit-detection]] AC3 nicht auftreten) → defensiv wie ein fehlgeschlagener Lauf behandelt, aber **weiterhin** ohne Eskalation (Eskalations-Schutz hat Vorrang, AC7).
- **Proaktive Schwelle erreicht, aber kein Reset bekannt + kein Fenster (manuell)** → `budget-stop` (Drain endet sauber, keine Eskalation, A1).
- **`token-usage-meter` liefert `0`** (Messung nicht möglich) → keine proaktive Pause (konservativ: nicht grundlos pausieren; der reaktive Schutz fängt das harte Limit weiterhin ab).
- **Mehrere Budget-Pausen in einem Drain** → alle als getrennte Einträge in `budgetPauses` (chronologisch).
- **Gleichzeitige reaktive + proaktive Auslösung** → eine Pause je Runde (reaktiv nach dem Lauf, proaktiv davor); kein Doppel-Warten.

## NFRs
- **Sicherheit (Floor):** der Eskalations-Schutz (AC7) ist eine **Datenintegritäts-Sicherung** — keine Board-Story darf durch Token-Mangel korrumpiert werden. Keine Secrets/Token/absoluten Host-Pfade in Settings/Bericht/Audit/Log/Response. Budget-Werte sind nicht-geheim (reine Konfiguration).
- **Robustheit:** ein Fehler im `budgetGuard`/Meter darf den Drain **nicht** crashen (degradierend: im Zweifel nicht pausieren, reaktiver Schutz bleibt). Ein Store-Fehler beim Bericht ist non-fatal ([[drain-completion-report]] NFR).
- **Token-Sparsamkeit:** proaktives Pausieren an Story-Grenzen verhindert das Verbrennen von Budget bis zum harten Limit; das sanfte Ende (A2) wartet nie über das Fenster hinaus.
- **Testbarkeit:** `budgetGuard`, `tokenUsageMeter`, `sleepFn`, `now`, `windowEndMs`, `BUDGET_RESUME_BUFFER_MS` injizierbar → alle ACs ohne echtes Warten/echten `claude`-Lauf.

## Nicht-Ziele
- **Keine** Änderung der Drain-Ziel-Auswahl / Konvergenz-Regel / normalen Eskalations-Logik (AC4/AC5 der [[taktgeber-nachtwaechter]] bleiben unverändert — nur der budget-/limit-bedingte Pfad ist neu und **nicht**-eskalierend).
- **Keine** Erkennung des Limits selbst (liegt in [[headless-budget-limit-detection]]) und **keine** Verbrauchsmessung selbst (liegt in [[token-usage-meter]]).
- **Kein** Umbau des interaktiven `TokenLimitWatcher`-Tick-Gates ([[taktgeber-nachtwaechter]] AC13/AC14) — das bleibt für den interaktiven Pfad bestehen; der Budget-Schutz hier ist die drain-interne Ergänzung an Story-Grenzen.
- **Keine** persistente Budget-Verbrauchs-Historie über die Bericht-Einträge hinaus.

## Abhängigkeiten
- [[headless-budget-limit-detection]] (reaktives `budget-limited`-Signal + `resetAt`) · [[token-usage-meter]] (proaktive Verbrauchsmessung) · [[taktgeber-nachtwaechter]] (`ProjectDrain`-Engine, `TickerSettingsStore`, `computeWindowEndMs`, Eskalations-Logik, AC13/AC14/AC15) · [[headless-parallel-drain]] (`NightWatchScheduler`-Verdrahtung, Nacht-Drain-`ProjectDrain`, Default-Regress AC6) · [[headless-manual-drain]] (manueller Drain — reaktiver Schutz gilt auch dort) · [[drain-completion-report]] (`DrainReportStore`, Bericht-Schema + UI, additiv um `budgetPauses`).
