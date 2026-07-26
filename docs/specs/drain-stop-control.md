---
id: drain-stop-control
title: Drain-Stop — laufenden Board-Drain (manuell + Nacht) kooperativ zwischen Runden abbrechen
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Drain-Stop  (`drain-stop-control`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Ein laufender Board-Drain (manueller „Board abarbeiten"-Knopf **oder** Nacht-Drain) lässt sich heute **weder** per API **noch** per GUI stoppen — `projectDrainRouter` kennt nur `POST` (Start) und `GET` (Status). Der einzige Not-Halt ist ein Container-Neustart (killt die PTY-Session; zudem würde [[drain-restart-robustness]]-`BootDrainRecovery` einen verwaisten **manuellen** Drain sofort **neu** starten). Diese Spec ergänzt einen **Stop-Hebel**: einen `POST`-Stop-Endpunkt, eine **kooperative Abbruch-Prüfung zwischen den Drain-Runden**, den terminalen Status `aborted` in der `DrainJobRegistry` (den `BootDrainRecovery` **nicht** wieder anläuft) und einen **Stop-Knopf** im Fabrik-Panel („Arbeiten"-Tab). Gilt für **manuellen UND Nacht-Drain**.

## Getroffene Annahmen (mangels Rückfrage-Kanal explizit dokumentiert)
- **A1 — Kooperativer Abbruch zwischen Runden, KEIN hartes Killen des laufenden Flow-Kindprozesses (bewusst).** Der Stop setzt ein Abbruch-Signal; `ProjectDrain#runLoop` prüft es **am Anfang jeder Runde** (vor dem nächsten `/flow`-/Feature-Drain-Anstoß) und beendet sich dann sauber mit `reason: 'aborted'`. Eine **bereits laufende** Flow-/Feature-Drain-Runde wird **zu Ende geführt** (nicht mitten in einer Story SIGTERM't) — analog zum „sanften Ende" des Nachtfensters ([[taktgeber-nachtwaechter]] AC11). Begründung: ein hartes Kill mitten in einer `/flow`-Session riskiert einen halb-geschriebenen Board-/Git-Zustand im geteilten Klon (Trauma 2026-07-02). Der zusätzliche SIGTERM an den aktiven Kindprozess ist eine **bewusst zurückgestellte** Option (Nicht-Ziel) — bei Bedarf als Owner-Entscheidung nachziehbar.
- **A2 — `aborted` ist terminal und nicht wiederanlauf-fähig.** Ein per Stop beendeter Drain trägt in der `DrainJobRegistry` den terminalen Status `aborted` (bereits Teil des Schemas, [[drain-restart-robustness]] AC1). `BootDrainRecovery` läuft **ausschließlich** verwaiste (`running`→`aborted` beim Boot markierte) Drains wieder an ([[drain-restart-robustness]] AC4/AC5) — ein **vor** dem Neustart bewusst gestoppter Drain ist bereits terminal `aborted` und wird von `reconcileOrphans()` (idempotent, terminale Einträge unangetastet) **nicht** als Orphan zurückgegeben → **kein** Wiederanlauf.

## Verhalten

### Abbruch-Signal-Registry (Backend, geteilt manuell + Nacht)
1. Eine schmale, **In-Memory** `DrainAbortRegistry` (Muster `DrainJobRegistry`, aber **nicht** persistiert — ein Abbruch gilt nur für den lebenden Prozess) hält je aktivem Drain `drainId → abortHandle`. Beim Start eines Drains (manuell **und** Nacht) registriert der jeweilige Auslöser das `abortHandle`; bei Drain-Ende (jeder terminale Ausgang) wird der Eintrag entfernt. `signal(drainId)` markiert den Drain als abzubrechen und liefert `true`, wenn ein aktiver Eintrag getroffen wurde, sonst `false`.
2. Der Abbruch wird an `ProjectDrain#drainProject(path, { …, abortSignal })` als **injiziertes Signal** (Muster `AbortSignal`/Prädikat `isAborted()`) durchgereicht — der Auslöser (Router / `NightWatchScheduler`) erzeugt es, registriert es unter der `drainId` und übergibt es dem Drain.

### Kooperative Abbruch-Prüfung in der Drain-Schleife (Backend)
3. `ProjectDrain#runLoop` prüft das Abbruch-Signal **am Anfang jeder Runde** (unmittelbar nach dem Event-Loop-Yield, **vor** dem nächsten `#findProject`/Flow-Anstoß). Ist es gesetzt, beendet sich die Schleife sofort mit `reason: 'aborted'` (samt bereits gesammelten `completed`/`blocked`/`escalated`/`budgetPauses` + End-Snapshot-Diff, analog den übrigen Stop-Pfaden). Eine bereits gestartete Flow-Runde wird **nicht** unterbrochen (A1). Das `ProjectJobLock` wird wie immer im `finally` freigegeben.

### Stop-Endpunkt (Backend)
4. **`POST /api/projects/:slug/drain/:drainId/stop`** signalisiert den Abbruch des Drains mit dieser `drainId`: `slug` wird wie bei den bestehenden Drain-Routen form-/pfad-validiert (`resolveProjectSlug`+`validateProjectPath`, `400` bei Traversal/Boundary); dann `DrainAbortRegistry.signal(drainId)`. Treffer (aktiver Drain) → `202 { drainId, status: 'aborting' }`; kein aktiver Drain unter der `drainId` (bereits fertig/unbekannt) → `404 { error }`. Zusätzlich wird der `DrainJobRegistry`-Eintrag auf `aborted` gesetzt (idempotent; A2) — **sobald** der Drain-Loop den Abbruch verarbeitet und terminiert, überschreibt der reguläre Abschluss-Pfad den Status **nicht** zurück auf `done` (der `reason: 'aborted'` wird als `aborted` gehalten, siehe AC5). Secret-/pfad-frei. Gilt für manuelle **und** Nacht-`drainId`s (dieselbe geteilte Abort-Registry).

### Status-Konsistenz: `aborted` nicht durch `markDone` überschreiben (Backend)
5. Der fire-and-forget-Abschlusspfad (Router `.then((result) => markDone(...))` bzw. `NightWatchScheduler`-Abschluss) erkennt `result.reason === 'aborted'` und setzt/hält den `DrainJobRegistry`-Status auf **`aborted`** (nicht `done`). So bleibt ein gestoppter Drain nach seinem sauberen Loop-Ende terminal `aborted` — Voraussetzung dafür, dass `BootDrainRecovery` ihn nach einem Neustart **nicht** wieder anläuft (A2). Ein Abschlussbericht ([[drain-completion-report]]) wird best-effort mit `reason: 'aborted'` geschrieben (kein Roh-Fehlertext).

### GUI: Stop-Knopf im Fabrik-Panel („Arbeiten"-Tab)
6. Zeigt die manuelle Drain-Status-Fläche (`CockpitView.jsx`, inline neben dem „Board abarbeiten"-Knopf, [[headless-manual-drain]] AC6) den Status **`running`**, erscheint ein **Stop-Knopf** daneben. Klick → `POST …/drain/:drainId/stop`; danach zeigt die Fläche **textlich** „wird gestoppt …" (nach `202`) und beim nächsten Status-Poll `aborted` → „gestoppt". Der Knopf ist während `aborting` deaktiviert. Ein Bestätigungsdialog verhindert versehentliches Stoppen. Status/Übergänge immer **textlich** (nicht nur farblich). Die bestehende Nacht-Läufe-/Nachtwächter-Statusanzeige ([[drain-completion-report]] AC7 / [[taktgeber-nachtwaechter]] AC17) nennt weiterhin die Anzahl aktiver Drains; ein Stop-Knopf je **Nacht**-Drain in dieser Übersicht ist zulässig, sobald deren `drainId`s dort sichtbar sind (siehe AC7) — sonst außerhalb dieses Scopes.

### Nacht-Drain-Teilnahme (Backend)
7. Der `NightWatchScheduler` registriert beim Start jedes Nacht-Drains dessen `abortHandle` unter der bereits generierten `drainId` ([[drain-restart-robustness]] AC3) in derselben geteilten `DrainAbortRegistry` und reicht das Abbruch-Signal an seine `ProjectDrain`-Instanz durch. Damit stoppt `POST …/drain/:drainId/stop` einen **Nacht**-Drain identisch (kooperativ zwischen Runden). Das bestehende `#activeDrains`-Concurrency-Tracking + die übrige Scheduler-Logik bleiben **unverändert**; die Registrierung ist best-effort und crasht den Scheduler **nie**.

## Acceptance-Kriterien

- **AC1** — **Abbruch-Registry:** eine In-Memory `DrainAbortRegistry` hält `drainId → abortHandle`; `register(drainId, handle)` beim Drain-Start (manuell + Nacht), Entfernen bei jedem terminalen Drain-Ende; `signal(drainId)` markiert den Abbruch und liefert `true` bei Treffer, sonst `false`. Nicht persistiert (ein Abbruch gilt nur für den lebenden Prozess). *(1,2)*
- **AC2** — **Kooperative Prüfung zwischen Runden (A1):** `ProjectDrain#runLoop` prüft das injizierte Abbruch-Signal **am Anfang jeder Runde** (nach dem Event-Loop-Yield, vor dem nächsten Flow-Anstoß) und beendet sich bei gesetztem Signal sofort mit **`reason: 'aborted'`** (samt `completed`/`blocked`/`escalated`/`budgetPauses` + End-Snapshot-Diff). Eine **bereits laufende** Flow-/Feature-Drain-Runde wird **zu Ende geführt** (kein SIGTERM, A1). Das `ProjectJobLock` wird im `finally` freigegeben. Ohne injiziertes Signal verhält sich `runLoop` **bit-identisch** zu heute (kein Regress). *(3)*
- **AC3** — **Stop-Endpunkt:** `POST /api/projects/:slug/drain/:drainId/stop` validiert `slug` wie die bestehenden Drain-Routen (`400` bei Traversal/Boundary), ruft `DrainAbortRegistry.signal(drainId)` → Treffer: `202 { drainId, status: 'aborting' }`; kein aktiver Drain unter `drainId`: `404 { error }`. Secret-/pfad-frei; hinter dem bestehenden AccessGuard. Gilt für manuelle **und** Nacht-`drainId`s (geteilte Registry). *(4)*
- **AC4** — **`aborted` in der Job-Registry:** beim Stop-Signal wird der `DrainJobRegistry`-Eintrag der `drainId` auf **`aborted`** gesetzt (idempotent; Schema bereits vorhanden, [[drain-restart-robustness]] AC1). *(4,5)*
- **AC5** — **Kein Überschreiben zu `done`:** der fire-and-forget-Abschlusspfad (Router `.then`/`NightWatchScheduler`) erkennt `result.reason === 'aborted'` und **hält/setzt** den Registry-Status auf `aborted` (nicht `done`/`failed`). Ein gestoppter Drain bleibt nach seinem sauberen Loop-Ende terminal `aborted`. Best-effort-Abschlussbericht mit `reason: 'aborted'` (kein Roh-Fehlertext). *(5)*
- **AC6** — **`BootDrainRecovery` läuft `aborted` NICHT wieder an (A2):** ein **vor** dem Neustart per Stop terminal `aborted` gesetzter Drain wird von `reconcileOrphans()` (nur `running`→`aborted`, idempotent, terminale Einträge unangetastet, [[drain-restart-robustness]] AC4) **nicht** als Orphan zurückgegeben und daher **nicht** wiederangelaufen. Ein Test weist explizit nach: ein `aborted`-Eintrag löst beim Boot **keinen** Wiederanlauf-Drain aus (weder manuell noch Nacht). *(5, [[drain-restart-robustness]] AC5–AC7)*
- **AC7** — **GUI-Stop-Knopf (`CockpitView.jsx`):** bei manuellem Drain-Status `running` erscheint neben dem Inline-Status ein **Stop-Knopf** (mit Bestätigungsdialog); Klick → `POST …/drain/:drainId/stop`, danach textlich „wird gestoppt …" → beim nächsten Poll `aborted` → „gestoppt". Knopf während `aborting` deaktiviert; Status/Übergänge **textlich** (nicht nur farblich). Der bestehende „läuft/fertig/fehlgeschlagen"-Status + Board-Re-Fetch ([[headless-manual-drain]] AC6) bleiben unverändert. *(6)*
- **AC8** — **Nacht-Drain-Teilnahme:** der `NightWatchScheduler` registriert je Nacht-Drain-Start das `abortHandle` unter der `drainId` in der geteilten `DrainAbortRegistry` und reicht das Signal an seine `ProjectDrain`-Instanz durch; `POST …/drain/:drainId/stop` stoppt einen Nacht-Drain identisch (kooperativ zwischen Runden). `#activeDrains` + übrige Scheduler-Logik unverändert; Registrierung best-effort (crasht den Scheduler nie). *(7)*

## Verträge

### Endpunkte
- `POST /api/projects/:slug/drain/:drainId/stop` → `202 { drainId, status: 'aborting' }` (aktiver Drain getroffen) | `404 { error }` (keine aktive `drainId`) | `400 { error }` (ungültiger Slug/Pfad). Read-/Write-arm: signalisiert nur den kooperativen Abbruch; **kein** Prozess-Kill. Secret-/pfad-frei, hinter AccessGuard.

### `DrainAbortRegistry` (neu, `src/DrainAbortRegistry.js`) — sprach-neutral
- `register(drainId, handle)` / `unregister(drainId)` — In-Memory (nicht persistiert).
- `signal(drainId) → boolean` — markiert den Abbruch, `true` bei Treffer.
- `isAborted(drainId) → boolean` — vom Drain-Loop bzw. dem injizierten Signal konsumiert.

### `ProjectDrain` (Erweiterung, additiv)
- `drainProject(projectPath, opts)` — `opts.abortSignal?` (`AbortSignal`-artig / `{ isAborted(): boolean }`); ohne ihn Default-Verhalten (AC2).
- `#runLoop` prüft `abortSignal` am Rundenanfang → Rückgabe-`reason` erweitert um `'aborted'`; alle übrigen Felder/`reason`-Werte unverändert.

### Wiederverwendung
- `projectDrainRouter` (`src/projectDrainRouter.js`) — neue Stop-Route + `DrainAbortRegistry.register` beim POST-Start + `result.reason==='aborted'`→`aborted` im `.then`-Pfad.
- `DrainJobRegistry` (`src/DrainJobRegistry.js`) — Status `aborted` bereits im Schema ([[drain-restart-robustness]] AC1); hier zusätzlich als Stop-Ziel gesetzt.
- `NightWatchScheduler` (`src/NightWatchScheduler.js`) — `#startDrain` registriert `abortHandle` + reicht Signal durch (AC8).
- `BootDrainRecovery` (`src/BootDrainRecovery.js`) — **unverändert**; profitiert von der `aborted`-Terminalität (AC6).
- `resolveProjectSlug`+`validateProjectPath` (`src/workspacePath.js`) — Slug-/Pfad-Härtung der Stop-Route.
- `CockpitView.jsx` (`client/`) — Stop-Knopf + Bestätigung + `aborting`/`aborted`-Textstatus (AC7).

## Edge-Cases & Fehlerverhalten
- **Stop auf bereits fertigen/unbekannten Drain** → `404`, kein Fehler (idempotent aus Nutzersicht: „läuft nicht mehr").
- **Stop-Signal, während eine Flow-Runde läuft** → die Runde läuft zu Ende, dann greift die Rundenanfang-Prüfung (A1); kein halb-geschriebener Zustand.
- **Zwei Stop-Requests kurz nacheinander** → idempotent (`signal` bleibt gesetzt; zweiter Treffer ebenfalls `202`/`404` je nach Aktivität).
- **Server-Neustart nach Stop, aber vor Loop-Terminierung** → der Kindprozess starb mit dem Server; der Registry-Eintrag ist bereits `aborted` (oder wird als `running`→`aborted`-Orphan markiert). Ein **bewusst gestoppter** (`aborted` **vor** Boot) Drain wird nicht wiederangelaufen (AC6); ein **verwaister** (`running` bei Boot) Drain fällt unverändert unter die reguläre [[drain-restart-robustness]]-Recovery (kein Regress).
- **Nacht-Drain gestoppt** → der Scheduler führt den nächsten Tick regulär aus; das Projekt bleibt Kandidat für spätere Ticks (kein dauerhafter Ausschluss) — ein Stop beendet nur **diesen** Lauf.

## NFRs
- **Sicherheit (Floor):** keine Secrets/Tokens/absoluten Host-Pfade in Stop-Response/Log; `drainId` ist eine Korrelations-UUID (kein Secret); Slug-/Pfad-Härtung wie die bestehenden Drain-Routen. Der Stop mutiert **nichts** im Git/Working-Tree (reines Prozess-internes Signal).
- **Trauma-Konformität (2026-07-02):** kein hartes Kill mitten in einer `/flow`-Session (A1) — kein Risiko halb-geschriebener Board-/Git-Zustände im geteilten Klon.
- **Robustheit/Degradation:** ohne `DrainAbortRegistry`/`abortSignal` verhält sich alles wie heute (rein additiv); die Nacht-Registrierung ist best-effort (crasht den Scheduler nie).
- **Testbarkeit:** injizierbares `abortSignal` + gemockte Registry/Runner → alle AC ohne echten `claude`-Lauf. Szenarien: (a) Signal am Rundenanfang → `reason:'aborted'`, Lock frei; (b) laufende Runde läuft zu Ende, dann Abbruch; (c) `aborted`-Eintrag → kein Boot-Wiederanlauf; (d) `markDone` überschreibt `aborted` nicht.

## Nicht-Ziele
- **Kein** hartes Killen (SIGTERM/SIGKILL) eines laufenden Flow-/Feature-Drain-Kindprozesses (A1, bewusst zurückgestellt — Owner-Entscheidung nachziehbar).
- **Keine** persistente Abbruch-Registry (ein Abbruch gilt nur für den lebenden Prozess; `aborted` in der `DrainJobRegistry` ist die persistente Spur).
- **Keine** Änderung der Drain-Ziel-/Abbruch-/Eskalations-Logik ([[taktgeber-nachtwaechter]]) außer dem additiven `aborted`-Pfad.
- **Kein** dauerhafter Projekt-Ausschluss vom Nacht-Drain durch einen Stop (nur der aktuelle Lauf endet).
- **Kein** echter `claude -p`-Live-Lauf im Test-Gate (gemockte Runner/Registry).

## Abhängigkeiten
- [[headless-manual-drain]] (`projectDrainRouter`, manueller Drain-Status/`DrainJobRegistry`, Inline-Status-Fläche AC6 — Stop-Route + GUI-Knopf docken an) · [[drain-restart-robustness]] (`DrainJobRegistry`-Status `aborted`, `BootDrainRecovery`/`reconcileOrphans` — `aborted` wird nicht wiederangelaufen, AC6; Nacht-Drain-`drainId` AC3) · [[taktgeber-nachtwaechter]] (`ProjectDrain`-Engine, `NightWatchScheduler`, sanftes Ende AC11 als Muster für den kooperativen Abbruch) · [[drain-completion-report]] (Abschlussbericht mit `reason:'aborted'`; Nacht-Läufe-/Statusanzeige) · [[access-and-guardrails]] (AccessGuard vor der Stop-Route).
</content>
