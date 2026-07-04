---
id: fswatcher-crash-hardening
title: FSWatcher-Crash-Härtung (Server-Stabilität)
status: active
area: fabrik-arbeiten
version: 1
---

# Spec: FSWatcher-Crash-Härtung  (`fswatcher-crash-hardening`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Ein unbehandelter Dateisystem-Watcher-Fehler darf den Node-Server **nie** beenden. Der Server beobachtet die Workspace-Repo-Wurzeln (`BOARD_ROOTS`) **rekursiv** auf Board-Änderungen; genau diese Wurzeln werden aber gleichzeitig von Flow-Sessions mutiert (npm install in `node_modules`, Worktree-Anlage/-Entfernung). Diese Capability härtet **alle** Watcher gegen verschwindende/wiederauftauchende Pfade: error-Handler ist Pflicht, ein Fehler führt zu sauberem Schließen + Re-Arm mit Backoff statt zum Prozess-Ende.

## Kontext / Vorfall (Motivation)
**Vorfall 2026-07-02 09:25:** Ein unbehandelter FSWatcher-Fehler (`ENOENT: … scandir '/workspace/dev-gui/node_modules/.bin'`), ausgelöst durch ein `npm install` einer Flow-Session im Workspace, beendete den **gesamten** Node-Prozess. Der Container-Restart killte alle laufenden headless-Kindprozesse (beide Drains) und die In-Memory-Registries (Drain-Jobs, PTY-Sessions, Locks).

**Ursachen-Kette (nachvollzogen im Code):**
- `server.js:318–319` erzeugt einen `BoardAggregator` und ruft `startWatchers()`.
- `BoardAggregator.startWatchers()` → `_watchRoot(root, signal)` (`src/BoardAggregator.js:798–846`) bewaffnet je `BOARD_ROOTS`-Wurzel **einen `recursive: true`-Watcher** über die `node:fs/promises.watch`-Async-Iterator-API.
- `BOARD_ROOTS` steht in dieser Deployment-Umgebung auf `/workspace` (siehe `.env`, `.env.example:25`) — also die **gesamte** Workspace-Wurzel inklusive aller geklonten Repos **mitsamt deren `node_modules`, `.git`, Worktrees**.
- Erzeugt/löscht eine Flow-Session Unterverzeichnisse (z.B. `node_modules/.bin` während `npm install`, oder Worktrees unter `.claude/worktrees/`), kann der rekursive Watch beim internen Nach-Bewaffnen von Unterverzeichnissen auf ein bereits verschwundenes Verzeichnis treffen → `ENOENT scandir`. Dieser Fehler eskaliert derzeit zum Prozess-Ende statt kontrolliert abgefangen zu werden.

## Bestandsaufnahme: fs-Watcher-Verwendungen im Server-Code
Ergebnis der Code-Durchsicht (`grep -rniE "fs\.watch|fsPromises\.watch|FSWatcher|chokidar|\.watch\(" src/ server.js`, Stand dieser Spec):

1. **`src/BoardAggregator.js` — `_watchRoot()` / `startWatchers()` / `stopWatchers()`** (Zeilen ~798–857). **Der einzige echte Dateisystem-Watcher.** Nutzt `node:fs/promises.watch(root, { recursive: true, signal })` (injizierbar via `#fsDeps.watch`, Default `node:fs/promises.watch`, Zeile 43/165). Konsumiert den Async-Iterator in `for await`, debounced (200 ms) die Index-Invalidierung. **Härtungsziel dieser Spec.**
2. **`chokidar` / externe Watch-Bibliotheken:** nicht vorhanden (keine Fundstelle).
3. **Kein weiterer `fs.watch`/`fs.watchFile`/`FSWatcher`-Verwender.** Andere „Watcher"-benannte Bausteine sind **keine** Dateisystem-Watcher und damit **nicht** betroffen:
   - `src/NotificationWatcher.js` — periodischer `setInterval`-Board-Poller (kein `fs.watch`).
   - `src/TokenLimitWatcher.js` — PTY-Output-/Token-Beobachter (kein `fs.watch`).
   - `NightWatchScheduler`/`attachTokenWatcher` — Scheduler, kein `fs.watch`.

> **Invariante (zukunftssicher):** Kommt künftig ein **weiterer** `fs.watch`/`FSWatcher`/`chokidar`-Verwender hinzu, gilt für ihn dieselbe Regel (AC1–AC4): error-Handler Pflicht, kein Prozess-Ende, Re-Arm-mit-Backoff-Disziplin.

## Verhalten
1. **error-Handler ist Pflicht.** Jeder Watcher wird so konsumiert, dass ein geworfener/emittierter Fehler abgefangen wird. Bei der Callback-`fs.watch`-Variante bedeutet das einen registrierten `'error'`-Listener (ein `'error'`-Event ohne Handler wird zur `uncaughtException` und beendet den Prozess). Bei der `promises.watch`-Async-Iterator-Variante bedeutet das ein umschließendes `try/catch` um die `for await`-Schleife **plus** Absicherung der Bewaffnung selbst.
2. **Verschwindender Pfad → sauberes Schließen.** Verschwindet eine beobachtete Wurzel (oder wirft der Watcher `ENOENT`/`scandir`), wird der zugehörige Watcher kontrolliert geschlossen (Iterator beendet / `AbortController` abbricht, Debounce-Timer gecleart) — **kein** Prozess-Ende, **kein** hängender Iterator.
3. **Re-Arm mit Backoff.** Nach Fehler oder Verschwinden versucht der Aggregator, die Wurzel **neu zu bewaffnen**, sobald der Pfad wieder existiert. Wiederholungen erfolgen mit **exponentiellem Backoff** (feste Startverzögerung, fester Faktor, feste Obergrenze) — kein Busy-Loop. Existiert der Pfad wieder und die Bewaffnung gelingt, wird der Backoff **zurückgesetzt**.
4. **Konsistenz nach Re-Arm.** Nach erfolgreichem Re-Arm wird der Index **einmal invalidiert** (nächster `getIndex()`/`scan()` liest neu), damit während der Ausfallzeit verpasste Änderungen nicht dauerhaft unsichtbar bleiben.
5. **Stop bricht Re-Arm ab.** `stopWatchers()` beendet nicht nur aktive Watcher, sondern auch **anstehende Re-Arm-/Backoff-Timer** — nach `stopWatchers()` findet **kein** Re-Arm mehr statt (kein Timer-Leak, keine Zombie-Bewaffnung).
6. **Workspace-Mutationen sind folgenlos für die Prozess-Lebensdauer.** Egal was eine Flow-Session im Workspace tut (npm install/rm in `node_modules`, Worktree-Anlage/-Entfernung, Repo-Klon/-Löschung) — der Server-Prozess läuft weiter.

## Acceptance-Kriterien
<Nummeriert, **testbar** — der Vertrag für `coder` + `tester`. Board-Items referenzieren diese Nummern.>

- **AC1** — **error-Handler-Pflicht + Invariante.** Der einzige Dateisystem-Watcher-Pfad (`BoardAggregator._watchRoot`, `recursive: true` je `BOARD_ROOTS`-Wurzel) fängt **jeden** Watcher-Fehler ab — sowohl einen bei der **Bewaffnung** geworfenen (`this.#fsDeps.watch(...)` wirft synchron) als auch einen **während** des Iterierens geworfenen. Kein Watcher-Fehler eskaliert zu einer `uncaughtException`. Testbar: ein `#fsDeps.watch`, dessen Iterator einen Fehler wirft **und** eine Variante, die synchron beim Aufruf wirft, führen beide **nicht** zu einem unbehandelten Reject / Prozess-Ende.
- **AC2** — **Kein Crash bei `ENOENT`/`scandir`.** Wirft der Watcher während des Beobachtens einen Fehler mit `code === 'ENOENT'` (bzw. eine `scandir`-Fehlermeldung, wie im Vorfall durch ein verschwindendes `node_modules/.bin`), endet der betroffene Watcher-Loop **kontrolliert** und der Node-Prozess bleibt am Leben. Testbar: injizierter Watcher wirft `ENOENT scandir` → Test-Prozess/`uncaughtException`-Zähler unverändert, Methode kehrt ohne Reject zurück.
- **AC3** — **Verschwindender Pfad → sauberes Schließen.** Verschwindet eine beobachtete Wurzel während des Watchens, wird der zugehörige Watcher sauber geschlossen (kein hängender Async-Iterator, Debounce-Timer gecleart). Kein Prozess-Ende.
- **AC4** — **Re-Arm mit begrenztem, exponentiellem Backoff.** Nach Fehler/Verschwinden versucht der Aggregator, die Wurzel neu zu bewaffnen, sobald sie wieder existiert. Die Wiederholung nutzt exponentiellen Backoff mit **festen** Parametern (Startverzögerung, Faktor, Obergrenze) und ist nach oben begrenzt (kein Busy-Loop / keine unbeschränkte Frequenz). Bei erfolgreicher Neu-Bewaffnung wird (a) der Backoff zurückgesetzt und (b) der Index **einmal** invalidiert. Testbar mit injizierbarem Timer/Clock: nach k fehlgeschlagenen Versuchen wächst der Abstand exponentiell bis zur Obergrenze; sobald `watch` wieder erfolgreich ist, wird der Iterator erneut konsumiert und der Index invalidiert.
- **AC5** — **`stopWatchers()` bricht Re-Arm ab.** Ein anstehender Backoff-/Re-Arm-Timer wird durch `stopWatchers()` abgebrochen; nach `stopWatchers()` erfolgt **kein** weiterer `watch`-Aufruf und **kein** Re-Arm. Testbar: `stopWatchers()` während einer laufenden Backoff-Phase → der injizierte `watch`-Spy wird danach nicht erneut aufgerufen; kein aktiver Timer verbleibt.
- **AC6** — **Workspace-Mutationen crashen den Server nie (Integration).** Ein automatisierter Test bewaffnet einen echten Watcher auf ein temporäres Verzeichnis, simuliert dann Flow-Session-Mutationen darunter — Anlegen **und** Löschen von Unterverzeichnissen (npm-install-artig) sowie eines Worktree-artigen Unterordners — und stellt sicher, dass der Prozess-`uncaughtException`-/`unhandledRejection`-Handler **nicht** auslöst und der Watcher-Baustein weiter funktionsfähig ist.
- **AC7** — **Regressionstest ENOENT-Zyklus (löschen → neu erzeugen → re-armt).** Ein automatisierter Test bewaffnet einen Watcher auf ein Verzeichnis, **löscht** das Verzeichnis während des Watchens und **erzeugt es neu**. Assert: (a) kein Prozess-Exit / keine uncaught exception, (b) der Watcher **re-armt** — eine **nach** der Neu-Erzeugung vorgenommene Änderung invalidiert den Index erneut (nächster `getIndex()` liest neu). Dieser Test bildet den Vorfall 2026-07-02 direkt ab.

## Verträge
- **Betroffenes Modul:** `src/BoardAggregator.js` — Methoden `startWatchers()`, `_watchRoot(root, signal)`, `stopWatchers()`; Felder `#watchers`, `#index`/`#standardIndex`.
- **Injektionspunkte (Test-Vertrag, rückwärtskompatibel):** `#fsDeps.watch` bleibt die injizierbare Watch-Quelle (Signatur wie `node:fs/promises.watch(path, { recursive, signal }) → AsyncIterator`). Für deterministische Backoff-Tests werden Timer/Delay injizierbar (z.B. `setTimeout`/`clearTimeout` bzw. ein `sleepFn` und ein `existsFn`/`stat`-Prüfer für „Pfad wieder da?"), analog zum bestehenden `#fsDeps`-Muster. Bestehende öffentliche Signaturen (`startWatchers()`/`stopWatchers()` ohne Argumente, `getIndex()`/`scan()`) bleiben **unverändert**.
- **Backoff-Parameter:** feste Konstanten im Modul (Startverzögerung, Faktor, Obergrenze) — als benannte Konstanten dokumentiert. Empfohlene Größenordnung (nicht bindend, sofern begrenzt & exponentiell): Start ~500 ms, Faktor 2, Obergrenze ~30 s.
- **Keine neue Runtime-Abhängigkeit** (kein `chokidar` o.Ä.); nur `node:fs`-Bordmittel.
- **Kein neuer HTTP-Endpunkt, keine API-Änderung, kein neues Env.** `BOARD_ROOTS` bleibt Konfiguration wie gehabt.

## Edge-Cases & Fehlerverhalten
- **`AbortError`** (durch `stopWatchers()` → `AbortController.abort()`) ist der erwartete, saubere Stop und löst **kein** Re-Arm aus (unterscheiden von echten Fehlern wie `ENOENT`).
- **Pfad existiert dauerhaft nicht** (Wurzel nie vorhanden): Bewaffnung schlägt fort, Backoff läuft bis zur Obergrenze und **verweilt** dort (bounded), ohne Busy-Loop und ohne Crash.
- **Schnelle Lösch-/Neuanlege-Zyklen** (mehrfach hintereinander): kein unkontrolliertes Aufstauen paralleler Re-Arm-Timer pro Wurzel — höchstens **ein** ausstehender Re-Arm je Wurzel.
- **Fehler ohne `code`** (generischer Watcher-Fehler): wird wie ein re-armbarer Fehler behandelt (schließen + Backoff-Re-Arm), niemals rethrow zum Prozess.
- **Debounce-Timer beim Schließen/Stop:** wird immer gecleart (kein Leak), auch im Fehlerpfad.

## NFRs
- **Verfügbarkeit/Robustheit (primär):** Der Server-Prozess überlebt beliebige Workspace-Mutationen durch Flow-Sessions — genau das ermöglicht den unbeaufsichtigten Dauerbetrieb (headless Drains, In-Memory-Registries). Ein Watcher-Ausfall degradiert höchstens die **Live-Aktualität** des Board-Index (bis zum Re-Arm oder nächsten expliziten `scan()`), niemals die Prozess-Lebensdauer.
- **Ressourcen:** kein Busy-Loop; höchstens ein ausstehender Re-Arm-Timer je Wurzel; Timer werden bei Stop freigegeben.
- **Beobachtbarkeit:** Watcher-Fehler + Re-Arm-Versuche werden knapp geloggt (`console.warn`/`error`, secret-frei), damit wiederkehrende Instabilität sichtbar ist — ohne Log-Sturm (z.B. nicht pro Backoff-Tick spammen).

## Nicht-Ziele
- **Kein globaler `process.on('uncaughtException')`-Fänger** als Ersatz — die Härtung geschieht **an der Fehlerquelle** (dem Watcher), nicht durch prozessweites Verschlucken von Ausnahmen (das würde echte Bugs verstecken).
- **Keine Verengung des Watch-Scopes** (z.B. `node_modules`/`.git` aus dem rekursiven Watch ausschließen) in diesem Vorhaben — siehe Abschnitt „Annahmen"; als Folge-Optimierung eskaliert, nicht Teil dieser Crash-Härtung.
- **Kein Wechsel der Watch-Bibliothek** (kein `chokidar`); Bordmittel bleiben.
- **Keine Änderung an `BOARD_ROOTS`-Semantik** oder am Debounce-Verhalten der Index-Invalidierung.

## Annahmen
> Diese Session ist non-interaktiv; folgende konservative Annahmen wurden getroffen (statt Rückfrage) und sind hier dokumentiert:
- **A1 — Sole watcher.** Die Code-Durchsicht ergab genau **einen** `fs.watch`-Verwender (`BoardAggregator._watchRoot`). Die Härtung konzentriert sich auf ihn; AC1 formuliert die Regel zusätzlich als **Invariante** für künftige Watcher.
- **A2 — Root-Ursache ist der rekursive `/workspace`-Watch.** `BOARD_ROOTS=/workspace` zieht alle `node_modules`/`.git`/Worktrees in den rekursiven Watch — genau der Vorfall-Vektor. Die verlangte Lösung (error-Handler + Re-Arm-mit-Backoff) behebt den **Crash** vollständig; sie reduziert nicht die **Häufigkeit** transienter Watcher-Fehler.
- **A3 — Scope-Verengung bewusst ausgeklammert.** Das Ignorieren irrelevanter Unterbäume (`node_modules`, `.git`) würde die Re-Arm-**Häufigkeit** drastisch senken (weniger Churn) und ist die naheliegende Folge-Optimierung. Da der Owner sie **nicht** angefordert hat, wird sie **nicht** eigenmächtig als AC umgesetzt, sondern im Handoff als Empfehlung eskaliert.
- **A4 — Backoff-Parameter** werden als feste Modul-Konstanten gewählt (Vorschlag: Start 500 ms, Faktor 2, Obergrenze 30 s); exakte Werte sind Implementierungsdetail, solange „exponentiell + begrenzt" (AC4) erfüllt ist.
- **A5 — Test-Doppelstrategie.** AC1–AC5 sind mit injiziertem `#fsDeps.watch`/injizierten Timern deterministisch (unit) testbar; AC6/AC7 nutzen einen **echten** Watcher auf einem temporären Verzeichnis (Integration), da das reale ENOENT-Verhalten plattformnah abgebildet werden soll.

## Abhängigkeiten
- Konsument des Watchers: `server.js` (`new BoardAggregator()` + `startWatchers()`).
- Verwandte Stabilitäts-/Betriebs-Specs: [[factory-status]] (Board-Index-Quelle), [[headless-parallel-drain]] / [[headless-manual-drain]] (die headless-Kindprozesse + In-Memory-Registries, die ein Prozess-Restart killt), [[taktgeber-nachtwaechter]] (unbeaufsichtigter Dauerbetrieb).
