---
id: board-aggregator-periodic-rescan
title: BoardAggregator — periodischer Rescan als Cache-Refresh-Sicherheitsnetz (verpasste fs-Events)
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: BoardAggregator — periodischer Rescan  (`board-aggregator-periodic-rescan`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der `BoardAggregator` hält einen flüchtigen In-Memory-Index der Board-Dateien und aktualisiert ihn heute **ausschliesslich** event-getrieben (`fs.watch` → debounced Index-Invalidierung → lazy Re-Scan beim nächsten `getIndex()`). Bleibt ein fs-Event aus, bleibt der Index **unbegrenzt lange** stal — bis zum Container-Neustart. Diese Capability ergänzt einen **periodischen Rescan** als **Sicherheitsnetz**: der Aggregator liest die Board-Dateien zusätzlich in einem festen, per Env konfigurierbaren Intervall neu ein — unabhängig von fs-Events. Der event-getriebene Pfad bleibt **unverändert** für die schnelle Live-Reaktion; der Rescan begrenzt lediglich die maximale Stale-Dauer auf ein Intervall.

## Kontext / Vorfall (Motivation, Owner-Befund 2026-07-08)
**Verifizierter Vorfall:** Board-Änderungen, die **nicht** vom Drain selbst geschrieben werden (Host-seitiges `git pull`/`merge`, manuelle Edits am Host), erreichen den In-Memory-Cache des `BoardAggregator` **nie** — er serviert bis zum Container-Neustart den alten Stand.

**Ursache:** Native `fs.watch` empfängt im **macOS-Docker-Bind-Mount** keine inotify-Events für **Host-seitige** Datei-Änderungen. Vom Container aus geschriebene Änderungen feuern dagegen und refreshen live — deshalb fällt die Lücke im Normalbetrieb (Drain schreibt selbst) nicht auf.

**Konkreter Schaden (kostete eine Drain-Runde):** S-061 wurde per Host-Merge entsperrt (`blocked_reason` auf Platte bereits `null`), der Aggregator lieferte weiter `ready:false`/`blocked` → der Drain sah **kein Ziel** und lief leer.

**Owner-Entscheidung:** periodischer Rescan. **Additiv** zum bestehenden event-getriebenen Refresh/SSE, **kein** Ersatz. Fängt jedes verpasste Event auf **jeder** Plattform ab (macOS-Bind-Mount ist der bekannte, aber nicht der einzige denkbare Fall — auch der Re-Arm-Ausfall aus [[fswatcher-crash-hardening]] AC4 hinterlässt ein Fenster verpasster Events).

**Bestandsaufnahme (im Code verifiziert, `src/BoardAggregator.js`):**
- `scan()` liest alle `BOARD_ROOTS`-Wurzeln neu ein, ersetzt `#index` atomar, verwirft `#standardIndex` und **wirft nie** (Fehler werden per Board als Error-Marker geführt — `factory-status` AC8).
- `getIndex()` re-scannt **lazy**, wenn `#index === null` (Invalidierung), sonst liefert es den memoisierten Stand **ohne** Datei-Zugriff.
- Der Watcher-Pfad (`startWatchers()` → Meta-/Subtree-Watches → debounced `#index = null`) ist die **einzige** Quelle dieser Invalidierung. Bleibt sie aus, bleibt der Index unbegrenzt alt.
- `NotificationWatcher` (60 s-Takt, Quelle des SSE-Broadcasts via [[board-live-sse]] AC8) liest über `getIndex()` — auf einem nicht invalidierten Index sieht folglich **auch** der SSE-/Notification-Diff den stalen Stand.
- Timer sind über `#fsDeps` (`setTimeout`/`clearTimeout`) bereits injizierbar (Muster aus [[fswatcher-crash-hardening]] AC4) — deterministische Tests sind ohne neue Infrastruktur möglich.

## Verhalten
1. **Periodischer Rescan.** Der Aggregator liest in einem festen Intervall die Board-Dateien neu ein (voller Rescan über alle `BOARD_ROOTS`-Wurzeln, identische Semantik zu `scan()`) — **unabhängig** davon, ob fs-Events eintreffen. Nach einem Rescan spiegelt der Index den Platten-Stand; der nächste Lesezugriff (`getIndex()`, HTTP-API, `NotificationWatcher`) sieht ihn ohne weiteres Zutun.
2. **Additiv, nicht ersetzend.** Der event-getriebene Pfad (Watcher → 200 ms-Debounce → Invalidierung → lazy Re-Scan) bleibt **unverändert** bestehen und bleibt der schnelle Weg. Der periodische Rescan ist das **Sicherheitsnetz** für den Fall, dass kein Event kommt; er senkt weder die Reaktionszeit des Event-Pfads noch verändert er dessen Verhalten. Insbesondere bleibt der SSE-Pfad ([[board-live-sse]]) unangetastet — er profitiert lediglich, weil der `NotificationWatcher`-Diff nun nicht mehr auf einem stalen Index laufen kann.
3. **Konfigurierbares Intervall mit sinnvollem Default.** Das Intervall ist per Env konfigurierbar; ohne Env gilt ein fester, dokumentierter Default in der vom Owner vorgegebenen Grössenordnung (~30–60 s).
4. **Kein Rescan-Sturm, kein Overlap.** Es läuft **zu keinem Zeitpunkt** mehr als **ein** Rescan gleichzeitig. Fällt ein Tick, während der vorherige Rescan noch läuft, wird dieser Tick **übersprungen** (verworfen, **nicht** aufgestaut/gequeued) — der Rhythmus setzt danach normal fort.
5. **Lebenszyklus an die Watcher gekoppelt.** Der Rescan-Zyklus startet mit `startWatchers()` und endet mit `stopWatchers()`. Nach `stopWatchers()` findet **kein** weiterer Rescan statt und **kein** Timer bleibt zurück (gleiche Disziplin wie [[fswatcher-crash-hardening]] AC5). Ein wiederholtes `startWatchers()` erzeugt **keinen** zweiten, parallelen Zyklus.
6. **Degradierend, nie fatal.** Ein fehlgeschlagener Rescan beendet den Zyklus nicht und crasht den Prozess nie — der nächste Tick läuft normal. Der Rescan hält die bestehende **Read-only-Garantie** des Aggregators ([[factory-status]] AC7): er liest, er schreibt nie.

## Acceptance-Kriterien

- **AC1** — **Verpasstes fs-Event wird spätestens nach einem Intervall sichtbar (Kern-Kriterium, Vorfall S-061).** Ändert sich eine Board-Datei auf Platte, **ohne** dass ein fs-Event eintrifft, liefert der Aggregator den neuen Stand spätestens **ein Rescan-Intervall** später — an `getIndex()` **und** damit an der HTTP-API (`GET /api/board/projects`) — ohne Container-/Prozess-Neustart und ohne expliziten `POST /api/board/projects/rescan`. Testbar (deterministisch, ohne echtes Warten): Aggregator mit injiziertem `#fsDeps.watch`, das **nie** ein Event liefert, und injizierten Timern; `getIndex()` einmal lesen (Index memoisiert); danach den Datei-Inhalt der injizierten Quelle ändern (Vorfall-Abbild: `blocked_reason: "…"` → `null`); Timer um ein Intervall vorstellen; **Assert:** der nächste `getIndex()` liefert den **neuen** Stand (Vorfall-Abbild: die Story ist `ready:true`, nicht mehr `blocked`) — vor dem Tick lieferte er noch den alten.
- **AC2** — **Event-getriebener Pfad + SSE bleiben unverändert (additiv, kein Ersatz).** Der Watcher-Pfad bleibt in Bewaffnung, Scope-Verengung, 200 ms-Debounce und Invalidierungs-Semantik **unverändert** ([[fswatcher-crash-hardening]] AC1–AC11 bleiben erfüllt): ein eintreffendes fs-Event invalidiert den Index weiterhin debounced, **ohne** auf den nächsten Rescan-Tick zu warten. Der SSE-/`NotificationWatcher`-Pfad ([[board-live-sse]] AC8–AC12) wird **nicht** geändert — kein neuer Broadcast-Trigger, kein zusätzliches Event-Format, kein zweiter Codepfad. **Assert:** die bestehenden `BoardAggregator`-/Watcher-/SSE-Tests bleiben **unverändert grün** (kein Regress); ein Test belegt, dass eine Änderung **mit** fs-Event weiterhin nach dem Debounce (also **vor** Ablauf eines Rescan-Intervalls) sichtbar ist.
- **AC3** — **Intervall per Env konfigurierbar, sinnvoller Default.** Das Rescan-Intervall wird aus `BOARD_RESCAN_INTERVAL_MS` gelesen; fehlt die Env, gilt der Default **60000** (60 s) als benannte, dokumentierte Modul-Konstante. Für Tests ist der Wert zusätzlich über die Konstruktor-Option `rescanIntervalMs` überschreibbar (Muster `boardRootsEnv`); die Option hat Vorrang vor der Env. Ein **nicht** parsbarer oder **negativer** Wert fällt still auf den Default zurück (einmalige `console.warn`-Zeile, secret-frei) — **kein** Crash, **kein** Start ohne Rescan. Der Wert **`0`** deaktiviert den periodischen Rescan bewusst (Opt-out-Notausstieg): es wird **kein** Timer bewaffnet, der event-getriebene Pfad läuft unverändert weiter. Testbar: je ein Fall für Default (Env fehlt), gültige Env, ungültige Env (→ Default + Warn), `0` (→ kein Timer, kein Rescan).
- **AC4** — **Kein Rescan-Sturm / kein Overlap.** Zu **keinem** Zeitpunkt läuft mehr als **ein** Rescan gleichzeitig. Feuert ein Tick, während der vorherige Rescan noch in-flight ist, wird er **übersprungen** (kein zweiter paralleler `scan()`, **kein** Aufstauen/Nachholen mehrerer verpasster Ticks); nach Abschluss des laufenden Rescans setzt der normale Rhythmus fort. Es existiert höchstens **ein** ausstehender Rescan-Timer je Aggregator-Instanz. Testbar mit injizierten Timern + einem `scan()`/`readdir`, das kontrolliert langsam auflöst (Deferred): Ticks während der In-flight-Phase erhöhen die `scan()`-Aufrufzahl **nicht**; nach Auflösen läuft der nächste Tick regulär.
- **AC5** — **Lebenszyklus + kein Timer-Leak.** `startWatchers()` bewaffnet den Rescan-Zyklus; `stopWatchers()` bricht ihn ab: danach erfolgt **kein** weiterer Rescan und **kein** Timer bleibt aktiv (analog [[fswatcher-crash-hardening]] AC5). Ein zweiter `startWatchers()`-Aufruf erzeugt **keinen** zweiten parallelen Zyklus (der bestehende `startWatchers()`-Vertrag „stops previous watchers first" gilt auch für den Rescan-Timer — idempotent). Testbar: `stopWatchers()` → Timer weit vorstellen → der `scan`-Spy wird nicht erneut aufgerufen, kein aktiver Timer verbleibt; doppeltes `startWatchers()` → nur **ein** Rescan je Intervall.
- **AC6** — **Degradierend, nie fatal, read-only, kein Log-Sturm.** Wirft ein Rescan wider Erwarten (`scan()` ist bereits fehlertolerant), wird der Fehler abgefangen: der Zyklus läuft weiter (nächster Tick regulär), es entsteht **keine** `uncaughtException`/`unhandledRejection` und **kein** Prozess-Ende. Der periodische Rescan schreibt **nie** ins Dateisystem (Read-only-Garantie [[factory-status]] AC7 bleibt) und loggt **nicht** pro Tick (kein Dauer-Log-Sturm im Ruhezustand) — höchstens Fehler, secret-frei. Testbar: injizierter `scan`/`readdir`, der einmal wirft → Prozess-Handler-Zähler unverändert, der Folge-Tick ruft `scan()` erneut auf.

## Verträge
- **Betroffenes Modul:** `src/BoardAggregator.js` — Erweiterung von `startWatchers()`/`stopWatchers()` um den Rescan-Zyklus; Wiederverwendung des bestehenden `scan()` als Rescan-Mechanik (keine zweite Lese-Implementierung). Bestehende öffentliche Signaturen (`scan()`, `getIndex({includeArchived})`, `readProjectAt()`, `startWatchers()`/`stopWatchers()` ohne Argumente) bleiben **unverändert**.
- **Neues Env:** `BOARD_RESCAN_INTERVAL_MS` — Ganzzahl, Millisekunden.
  - Default (Env fehlt/leer): `60000` (60 s) — benannte Modul-Konstante, dokumentiert in `.env.example` (auskommentiert, Muster der bestehenden `*_INTERVAL_MS`-Einträge).
  - `0` → periodischer Rescan deaktiviert (Opt-out; Event-Pfad unberührt).
  - Nicht parsbar / negativ → Default + einmalige Warnung.
- **Konstruktor-Option (Test-Vertrag, additiv):** `new BoardAggregator({ boardRootsEnv, fsDeps, rescanIntervalMs })` — `rescanIntervalMs` überschreibt die Env (Vorrang), Muster `boardRootsEnv`. Bestehende Aufrufer (`server.js`: `new BoardAggregator()` + `startWatchers()`) bleiben **unverändert** — der Rescan ist ohne Verdrahtungs-Änderung aktiv.
- **Timer-Injektion:** der Rescan-Timer nutzt die **bestehenden** injizierbaren `#fsDeps.setTimeout`/`#fsDeps.clearTimeout` (Default: echte Timer) — deterministische Tests analog zur Re-Arm-/Backoff-Maschinerie. Eine selbst-nachplanende `setTimeout`-Kette (nächster Tick erst nach Abschluss des laufenden Rescans) erfüllt AC4 strukturell; ein In-flight-Flag ist gleichwertig zulässig. Implementierungsdetail des `coder`, solange AC4/AC5 erfüllt sind.
- **Kein neuer HTTP-Endpunkt, keine API-Änderung, kein neues Response-Feld.** `GET /api/board/projects` und `POST /api/board/projects/rescan` bleiben unverändert (der manuelle Rescan bleibt als Sofort-Weg bestehen).
- **Keine neue Runtime-Abhängigkeit** — Bordmittel (`node:fs` + Timer).

## Edge-Cases & Fehlerverhalten
- **Rescan dauert länger als das Intervall** (viele/grosse Repos, langsamer Bind-Mount): Ticks während der In-flight-Phase werden verworfen (AC4) — der effektive Rhythmus ist dann „so schnell wie der Rescan", nie überlappend, nie aufstauend.
- **`BOARD_ROOTS` leer / Wurzel existiert nicht:** `scan()` ist dafür bereits fehlertolerant (Error-Marker je Board statt Wurf) — der Rescan-Zyklus läuft unverändert weiter, kein Sonderfall.
- **Gleichzeitiges fs-Event + Rescan-Tick:** beide Pfade sind konfliktfrei — der Event-Pfad **invalidiert** nur (`#index = null`, lazy), der Rescan **ersetzt** den Index atomar. Eine Invalidierung, die während eines laufenden Rescans eintrifft, darf **nicht** verloren gehen: der Aggregator liefert danach **nie** einen Stand, der älter ist als der Beginn des jüngsten Rescans (schlimmstenfalls ein zusätzlicher lazy Re-Scan beim nächsten `getIndex()` — korrekt, nur minimal teurer).
- **`stopWatchers()` während eines laufenden Rescans:** der in-flight `scan()` läuft zu Ende (er ist read-only und harmlos), aber es wird **kein** Folge-Tick mehr geplant (AC5).
- **Doppeltes `startWatchers()`:** kein zweiter Timer, kein doppelter Rescan je Intervall (AC5).
- **Sehr kleines Intervall per Env** (z.B. 100 ms): zulässig (Betreiber-Entscheidung), durch AC4 gegen Overlap/Sturm geschützt; keine künstliche Untergrenze über den `0`-Opt-out hinaus.

## NFRs
- **Robustheit (primär):** Die maximale Stale-Dauer des Board-Index ist **nach oben begrenzt** (ein Intervall) — unabhängig von Plattform, Mount-Typ und Watcher-Gesundheit. Das ist die Eigenschaft, die den unbeaufsichtigten Nacht-/Drain-Betrieb ([[taktgeber-nachtwaechter]], [[headless-parallel-drain]]) gegen den Vorfall S-061 absichert.
- **Ressourcen:** ein voller Board-Rescan je Intervall (Default 60 s) — dieselbe Grössenordnung/Rhythmus wie der bestehende `NotificationWatcher`-Takt (60 s), der ohnehin je Runde `getIndex()` liest; kein Busy-Loop, höchstens ein Timer + ein in-flight Rescan je Instanz.
- **Beobachtbarkeit:** kein Log je Tick (Ruhezustand bleibt still); nur Fehler bzw. die einmalige Env-Warnung werden geloggt — secret-frei, ohne absolute Pfade.
- **Read-only:** unverändert ([[factory-status]] AC7) — der Rescan liest ausschliesslich.

## Nicht-Ziele
- **Kein Ersatz des event-getriebenen Pfads.** Der Watcher bleibt die schnelle Live-Quelle; der Rescan ist **nur** das Sicherheitsnetz (AC2). Ein „nur noch pollen"-Umbau ist ausdrücklich **nicht** Teil dieser Spec.
- **Keine Änderung an SSE/Notifications** ([[board-live-sse]], [[push-notifications]]) — kein neuer Broadcast-Trigger, kein neues Event, kein zweiter Diff-Pfad. Dass der `NotificationWatcher`-Diff nun auf frischem Index läuft, ist eine **Folge** des Rescans, keine Änderung an seinem Code-Pfad.
- **Kein Wechsel der Watch-Mechanik** (kein `chokidar`, kein `fs.watchFile`-Polling je Datei, keine Änderung an `BOARD_ROOTS`/Scope-Verengung).
- **Keine Mtime-/Hash-basierte Änderungs-Erkennung als Optimierung** (nur die geänderten Dateien lesen) — der volle `scan()` ist die bestehende, erprobte Mechanik; eine Optimierung wäre eine separate Anforderung.
- **Keine adaptive/dynamische Intervall-Anpassung** (z.B. schneller während eines Drains) — festes Intervall, Env-konfigurierbar.
- **Kein Fix der macOS-Bind-Mount-inotify-Lücke selbst** — sie ist eine Plattform-Eigenschaft; diese Spec macht das System **unabhängig** davon.

## Annahmen
> Diese Session ist non-interaktiv (Subagent); folgende konservative Annahmen wurden — statt einer Rückfrage — getroffen und sind hier dokumentiert. Sie liegen alle **innerhalb** des Owner-Befunds vom 2026-07-08 (`befund_2026_07_08`, S-325).
- **A1 — Rescan == `scan()`.** Der periodische Rescan verwendet die **bestehende** `scan()`-Mechanik (voller Re-Read, atomarer Index-Ersatz, `#standardIndex`-Verwurf, wirft nie) statt einer zweiten Lese-Implementierung — minimale Fläche, kein Divergenz-Risiko zwischen zwei Lesepfaden.
- **A2 — Default 60 s.** Der Owner gab „~30–60 s" vor. Gewählt wird das **obere** Ende (`60000`), weil es exakt dem bereits etablierten Board-Rhythmus entspricht (`NotificationWatcher` 60 s-Takt, der ohnehin je Runde den Index liest) — dadurch entsteht **kein neues Lastprofil**. Wer schnellere Sichtbarkeit will, senkt `BOARD_RESCAN_INTERVAL_MS` (z.B. auf 30000), ohne Code-Änderung.
- **A3 — Env-Name.** `BOARD_RESCAN_INTERVAL_MS` folgt den bestehenden Konventionen (`BOARD_ROOTS`-Präfix für Board-Belange, `*_INTERVAL_MS`-Suffix wie `CLAUDE_AUTH_PROBE_INTERVAL_MS`, `GH_TOKEN_REFRESH_INTERVAL_SECONDS`).
- **A4 — `0` deaktiviert.** Ein expliziter Opt-out-Wert ist nötig, damit Tests/Sonderbetrieb den Timer sicher abschalten können, ohne die Watcher zu deaktivieren. `0` (statt eines separaten Bool-Envs) hält die Konfigurationsfläche bei **einer** Variable.
- **A5 — Lebenszyklus an `startWatchers()`/`stopWatchers()`.** Damit ist der Rescan ohne Änderung an `server.js` (`new BoardAggregator()` + `startWatchers()`) aktiv, und `stopWatchers()` bleibt der **eine** vollständige Stop-Weg (kein zweiter, leicht zu vergessender Aufräum-Aufruf → kein Timer-Leak in Tests). Separate `startPeriodicRescan()`/`stopPeriodicRescan()`-Methoden wären gleichwertig umsetzbar, würden aber jeden Aufrufer zu einer zweiten Verdrahtung zwingen.
- **A6 — Test-Determinismus.** AC1/AC3–AC6 sind über injizierte `#fsDeps` (`watch`, `readdir`/`readFile`, `setTimeout`/`clearTimeout`) vollständig deterministisch unit-testbar — **ohne** echtes Warten und **ohne** echten Bind-Mount. Der reale macOS-Bind-Mount-Fall ist in CI **nicht** reproduzierbar; das injizierte „`watch` feuert nie"-Szenario ist sein exaktes strukturelles Abbild (genau die Bedingung, unter der der Vorfall entstand).

## Abhängigkeiten
- **Modul/Konsument:** `src/BoardAggregator.js`; verdrahtet in `server.js` (`new BoardAggregator()` + `startWatchers()`) — unverändert.
- **Verwandte Specs:** [[fswatcher-crash-hardening]] (der event-getriebene Watcher-Pfad + Re-Arm-/Timer-Disziplin, deren Muster dieser Rescan folgt — Rescan ist zusätzlich das Sicherheitsnetz für das Event-Fenster während eines Re-Arms), [[factory-status]] (Scan/Index/Read-only-Garantie, Aktualitäts-Vertrag), [[board-live-sse]] (SSE-Invalidierung via `NotificationWatcher`-Diff — Konsument des Index, unverändert), [[push-notifications]] (`NotificationWatcher`-Takt), [[taktgeber-nachtwaechter]] / [[headless-parallel-drain]] / [[headless-manual-drain]] (die Drains, die auf einem aktuellen Board-Stand ihre Ziele wählen — Vorfall S-061).
