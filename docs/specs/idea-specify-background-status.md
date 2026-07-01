---
id: idea-specify-background-status
title: Idee spezifizieren — sichtbarer Status des Hintergrund-Laufs (Karten-Badge + Reopen-Inline)
status: draft
version: 1
---

# Spec: Idee spezifizieren — sichtbarer Status des Hintergrund-Laufs  (`idea-specify-background-status`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Seit dem fire-and-forget-Umbau ([[idea-specify-chat]] AC10/AC14/AC16, Story S-229) schließt das Idee-Specify-Overlay **sofort**, sobald der Owner „Story anlegen" klickt — der `requirement`-Finalize-Lauf läuft **detached** im Hintergrund weiter. Damit entsteht ein **blinder Fleck**: nach dem Schließen gibt es **keine** UI-Stelle, die „für Idee S-XXX läuft noch ein Spezifizieren-Job" anzeigt. Der einzige indirekte Hinweis ist, dass die Idee-Karte weiter `status: Idee` trägt — und das unterscheidet **nicht** zwischen „läuft noch" und „fehlgeschlagen/no-op" (beides sieht gleich aus). Der Owner fragt konkret: **„Wo sehe ich den Status, wenn im Hintergrund noch spezifiziert/angelegt wird?"**

Diese Spec **realisiert und ersetzt** den Folge-Story-Stub [[idea-specify-chat]] **AC17** und macht den Hintergrund-Lauf **sichtbar** — in der vom Owner bestätigten **kombinierten** Variante:
1. **Lauf-Indikator direkt auf der Idee-Karte** im Board (Badge/Spinner „wird spezifiziert…"), der bei Erfolg verschwindet (Karte übernommen/archiviert) und bei No-Op/Fehler zu einem **Fehler-Hinweis** wechselt (Idee bleibt anklickbar → erneuter Versuch).
2. **Wiedereröffnen des Chat-Overlays** für dieselbe Idee zeigt den **letzten bekannten Job-Status inline** nach (läuft noch / zuletzt fehlgeschlagen), ohne dass das Overlay dafür durchgehend offen bleiben musste.

Damit beide Wege **reload-fest** und **overlay-unabhängig** funktionieren (der Owner will den Status **jederzeit später** nachschauen, ggf. nach Seiten-Reload), wird der bereits jobId-basierte Finalizer-Status um eine **idea-keyed** Sicht + zwei schmale **Read-Endpunkte** ergänzt (kein neuer Board-Schreibpfad, kein Agenten-Dispatch).

> **Verhältnis zu [[idea-specify-chat]]:** Diese Spec **baut auf** dem fire-and-forget-Schließen auf (AC10/AC11/AC14/AC15/AC16 — dort verbleibend, **hier nicht** neu spezifiziert) und **realisiert** den bisher als Stub ausgewiesenen Ausgangs-Watcher **AC17**. Sie **erweitert** AC17 über dessen ursprüngliche Skizze hinaus um (a) einen **`running`-Lauf-Indikator** (AC17 nannte nur den Fehler-Hinweis), (b) das **Reopen-Inline-Status-Nachziehen** und (c) eine **reload-feste, idea-keyed** Server-Sicht (AC17 skizzierte den client-gehaltenen jobId ohne Reload-Festigkeit). Endpunkte/Boundaries/Finalize-Verfahren aus [[idea-specify-chat]] (AC3–AC9, AC12, AC13) bleiben **unverändert** gültig; der bestehende per-Job-Status-Endpunkt ([[idea-specify-chat]] AC7) bleibt bestehen und wird um die idea-keyed Sicht **ergänzt** (nicht ersetzt).

## Verhalten

### Idea-keyed Finalize-Status (Server, reload-fest)
1. Der `IdeaSpecifyFinalizer` führt zusätzlich zur bestehenden jobId-Registry ([[idea-specify-chat]] AC7) eine **idea-keyed** Sicht: je `ideaStoryId` der **letzte** Finalize-Job (`status ∈ {running, done, failed, auth-expired}`, `jobId`, optional `error` als secret-freie Kurzmeldung). Der Job wird **synchron beim Finalize-Request-Empfang** mit Status `running` (keyed by `ideaStoryId`) registriert — **bevor** der `requirement`-Kindprozess spawnt. So findet der Board-Status-Indikator den Lauf **zuverlässig** und **reload-fest**, unabhängig davon, ob der Client die `202`-Antwort noch verarbeitet (das Overlay ist beim fire-and-forget-Klick schon zu).
2. Zwei schmale **Read-Endpunkte** speisen die UI: ein **projektweiter** Endpunkt liefert alle **nicht-`done`** Finalize-Jobs des Projekts (running + failed + auth-expired) in **einem** Call — damit die Board-Ansicht alle Idee-Badges günstig hydratisieren/pollen kann; ein **per-Idee**-Endpunkt liefert den letzten Job einer einzelnen Idee — für das Overlay-Reopen. Beide Reads sind **token-frei** (kein Agenten-Dispatch, keine Board-Schreibaktion) und **secret-/token-/host-pfad-frei**.

### Lauf-Indikator auf der Idee-Karte
3. Solange für eine Idee ein Finalize-Job **`running`** ist, zeigt ihre Board-Karte einen **sichtbaren Lauf-Indikator** (Badge/Spinner „wird spezifiziert…"), **nicht nur farblich** unterscheidbar (Text/Icon + `aria-busy`/`role=status`).
4. Bei **`failed`/`auth-expired`** wechselt das Badge zu einem **nicht-blockierenden Fehler-Hinweis** („Spezifizieren fehlgeschlagen — erneut versuchen"); die Karte bleibt **anklickbar**, sodass der Owner das Overlay erneut öffnen und einen neuen Versuch starten kann. Bei **`done`** ist **kein** Badge mehr sichtbar, weil die Idee-Karte übernommen/verschwunden **oder** ([[idea-specify-chat]] AC9) auf `Done` archiviert ist.

### Hydratisieren, Polling, Re-Fetch (Board-View)
5. Der Board-View **hydratisiert** die Idee-Badges aus dem projektweiten Status-Endpunkt und **pollt** ihn leichtgewichtig, solange mindestens eine Idee einen `running`-Job trägt **oder** unmittelbar nachdem „Story anlegen" für eine Idee ausgelöst wurde, bis alle Jobs terminal sind. Verschwindet ein zuvor `running`-Job aus dem Snapshot (→ `done`), löst der Board-View **genau ein** Re-Fetch der Board-Daten aus (über den bestehenden `reloadToken`-/`onSpecified`-Mechanismus) — die neue `To Do`-Story erscheint **ohne** manuellen Reload. Trägt **keine** Idee einen aktiven Job, **pollt** der View **nicht** (kein Dauer-Polling im Ruhezustand). Der Status überlebt einen Reload (server-seitige Registry, nicht Client-State).

### Reopen zeigt letzten Status inline
6. Öffnet der Owner das Chat-Overlay für dieselbe Idee erneut, fragt es beim Öffnen den **per-Idee**-Status-Endpunkt ab und zeigt den letzten bekannten Job-Status **inline** nach: `running` → Status-Banner „Ein Spezifizieren-Lauf läuft noch…" **und** „Story anlegen" **deaktiviert** (kein zweiter Lauf, AC7); `failed`/`auth-expired` → Fehler-Banner mit **Retry**-Möglichkeit; `null`/`done` → normaler Chat-Einstieg (frische Session, [[idea-specify-chat]] AC3). Secret-/pfad-frei.

### Nur ein aktiver Finalize je Idee
7. Für **eine** Idee läuft **höchstens ein** Finalize gleichzeitig. Ein zweiter Finalize-Request, während für dieselbe Idee bereits ein Job `running` ist, wird **abgelehnt** (`409`, **kein** zweiter Kindprozess): der bestehende `ProjectJobLock` deckt die **Projekt**-Ebene ab ([[idea-specify-chat]] AC6), zusätzlich verhindert die idea-keyed Registry einen Doppel-Start je **Idee**. In der UI ist „Story anlegen" bei laufendem Job der Idee deaktiviert (AC6) und der Board-Badge zeigt den Lauf (AC3) — ein paralleler zweiter Specify-Versuch derselben Idee ist damit ausgeschlossen.

## Acceptance-Kriterien

- **AC1** — **Idea-keyed Registry + synchrone Registrierung (Server).** Der `IdeaSpecifyFinalizer` hält je `ideaStoryId` den **letzten** Finalize-Job (`status`, `jobId`, `error?`). Der Job wird **synchron beim Finalize-Request-Empfang** mit Status `running`, keyed by `ideaStoryId`, registriert — **bevor** der Kindprozess spawnt —, sodass der Status reload-fest und unabhängig von der Client-Verarbeitung der `202` sichtbar ist. `error` ist eine secret-/pfad-freie Kurzmeldung. (Das fire-and-forget-Schließen selbst ist [[idea-specify-chat]] AC10/AC14 — hier nur die Server-seitige Statushaltung.) *(1)*
- **AC2** — **Status-Endpunkte (token-frei, secret-frei).** Neu: `GET /api/board/projects/:slug/specify/jobs` → `200 { jobs: { [ideaStoryId]: { status: 'running'|'failed'|'auth-expired', jobId, error? } } }` (nur **nicht-`done`**; `done`-Jobs sind entfernt, die Karte ist dann ohnehin weg/archiviert). Neu: `GET /api/board/projects/:slug/ideas/:id/specify/status` → `200 { job: { status: 'running'|'done'|'failed'|'auth-expired', jobId, error? } | null }`. Beide hinter AccessGuard, **kein** Agenten-Dispatch, **kein** Board-Schreibpfad, **keine** Secrets/Token/Host-Pfade in Response/Log. Slug-/ID-Validierung wie der bestehende Router (`resolveProjectSlug`/`validateProjectPath`, `STORY_ID_RE`); `404` bei unbekanntem Projekt/Idee. Der per-Job-Endpunkt ([[idea-specify-chat]] AC7) bleibt unverändert. **`no-op`-Mapping:** der bestehende Finalizer-Terminalstatus `no-op` (headless-arg-finalize-safety AC5 — der `requirement`-Lauf lief durch, aber es entstand nichts, die Idee bleibt sichtbar `Idee`) wird in **beiden** idea-keyed Sichten auf **`failed`** abgebildet: aus Board-/Reopen-Sicht ist er ein nicht-`done`, retry-würdiges Ergebnis (Fehler-Badge AC4, Reopen-Fehler-Banner + Retry AC6). Der per-Job-Endpunkt (AC7) liefert `no-op` unverändert. *(2)*
- **AC3** — **Lauf-Indikator auf der Idee-Karte.** Solange für eine Idee ein Job `running` ist, rendert ihre Board-Karte ein sichtbares Badge/Spinner „wird spezifiziert…", **nicht nur farblich** unterscheidbar (Text/Icon + `aria-busy`/`role=status`/`aria-live`). *(3)*
- **AC4** — **Fehler-Hinweis + Erfolgs-Ausblendung.** Bei `failed`/`auth-expired` zeigt die Idee-Karte einen **nicht-blockierenden**, secret-freien Fehler-Hinweis („Spezifizieren fehlgeschlagen — erneut versuchen"); die Karte bleibt **anklickbar** (Retry via Overlay-Reopen, AC6). Bei `done` ist **kein** Badge mehr sichtbar (Idee übernommen/verschwunden oder auf `Done` archiviert, [[idea-specify-chat]] AC9). *(4)*
- **AC5** — **Hydratisieren + Polling + Re-Fetch.** Der Board-View hydratisiert die Idee-Badges aus `GET …/specify/jobs` und **pollt** diesen Endpunkt leichtgewichtig, solange ≥1 Idee einen `running`-Job trägt **oder** direkt nachdem „Story anlegen" ausgelöst wurde, bis alle Jobs terminal sind. Verschwindet ein zuvor `running`-Job aus dem Snapshot (→ `done`) → **genau ein** Board-Re-Fetch (bestehender `reloadToken`-/`onSpecified`-Mechanismus) → neue `To Do`-Story erscheint ohne manuellen Reload. Ohne aktive Jobs **kein** Polling. Reload-fest (Status aus server-seitiger Registry, nicht Client-State). *(5)*
- **AC6** — **Reopen zeigt letzten Status inline.** Beim (Wieder-)Öffnen des Chat-Overlays für eine Idee fragt es `GET …/ideas/:id/specify/status` ab: `running` → inline Status-Banner „Ein Spezifizieren-Lauf läuft noch…" **und** „Story anlegen" deaktiviert; `failed`/`auth-expired` → inline Fehler-Banner + Retry möglich; `null`/`done` → normaler Chat-Einstieg (frische Session). Secret-/pfad-frei. *(6)*
- **AC7** — **Nur ein aktiver Finalize je Idee.** Ein zweiter Finalize-Request, während für dieselbe Idee bereits ein Job `running` ist, wird abgelehnt (`409`, **kein** zweiter Kindprozess) — abgesichert durch den bestehenden `ProjectJobLock` (Projekt-Ebene) **und** die idea-keyed Registry (Idee-Ebene). „Story anlegen" ist bei laufendem Job der Idee deaktiviert; das Board-Badge zeigt den Lauf. Ein paralleler zweiter Specify-Versuch derselben Idee ist ausgeschlossen. *(7)*
- **AC8** — **Security-Floor + Audit.** Die neuen Status-Reads sind token-frei (kein Agenten-Dispatch, keine Board-Schreibaktion) und liegen hinter dem AccessGuard; Response/Log/Audit enthalten **keine** Secrets/Token/Host-Pfade (`error` als secret-freie Kurzmeldung). Diese Story fügt **keinen** neuen Board-Schreibpfad hinzu: die Idee-Archivierung bei `done` bleibt ausschließlich [[idea-specify-chat]] AC9 (`BoardWriter.archiveSupersededIdea`, atomar). Der Finalize-Start bleibt auditiert wie [[idea-specify-chat]] AC6. *(1,2)*

## Verträge

### Endpunkte (Erweiterung des `ideaSpecifyRouter`)
- `GET /api/board/projects/:slug/specify/jobs` → `200 { jobs: { [ideaStoryId]: { status: 'running'|'failed'|'auth-expired', jobId: string, error?: string } } }` | `404` (Projekt unbekannt). Nur **nicht-`done`** Jobs. Token-/secret-frei. Für Board-Hydration + Polling.
- `GET /api/board/projects/:slug/ideas/:id/specify/status` → `200 { job: { status: 'running'|'done'|'failed'|'auth-expired', jobId: string, error?: string } | null }` | `404` (Projekt/Idee unbekannt). Letzter bekannter Finalize-Job **dieser** Idee. Für Overlay-Reopen.
- Unverändert: `POST …/ideas/:id/specify/finalize` ([[idea-specify-chat]] AC6; **neu**: synchrone idea-keyed `running`-Registrierung vor dem Spawn), `GET …/ideas/:id/specify/finalize/:jobId` (per-Job-Status, AC7), `…/specify/start`, `…/specify/message`.

### Finalizer-Boundary (`IdeaSpecifyFinalizer`, Erweiterung)
- `lastJobByIdea: Map ideaStoryId → { status, jobId, error? }`, in-memory (Verlust bei Server-Neustart = Nicht-Ziel, wie die bestehende jobId-Registry).
- `start(...)` registriert den Job **synchron** (keyed by `projectSlug`+`ideaStoryId`, Wert enthält `jobId`) — kein `await` zwischen Runner-`start()` (Spawn) und der Registrierung, also atomar aus Sicht jedes Beobachters; lehnt Start ab, wenn für die Idee bereits ein Job `running` ist (`{ ok:false, reason:'idea-locked' }` → Router `409`, kein zweiter Kindprozess).
- `jobsForProject(projectSlug) → { [ideaStoryId]: {...} }` (nur nicht-`done`) und `statusForIdea(projectSlug, ideaStoryId) → {...}|null` speisen die Read-Endpunkte. Beide resolven den **aktuellen** Status stets **live** über `getJob()` (inkl. Sicherheitsnetz-/`no-op`-Mapping), damit ein terminaler Job nicht als stale `running` hängen bleibt; `no-op` → `failed` (s. AC2).

### Frontend
- **Board-View** (`BoardView.jsx`): Idee-Karten-Render um Lauf-/Fehler-Badge (AC3/AC4); leichtgewichtiges Polling von `…/specify/jobs` mit Start-/Stopp-Bedingung (aktive Jobs / „Story anlegen" gerade ausgelöst, AC5); Re-Fetch via bestehendem `reloadToken`/`onSpecified` bei `running`→weg.
- **Chat-Overlay** (`IdeaSpecifyChatModal.jsx`): beim Öffnen `…/ideas/:id/specify/status` abfragen + Status-/Fehler-Banner inline; „Story anlegen" bei `running` deaktivieren (AC6). Das fire-and-forget-Schließen selbst bleibt Story S-229 ([[idea-specify-chat]] AC10/AC14).

## Edge-Cases & Fehlerverhalten
- **Client sieht die `202` nie** (Overlay bereits zu / Reload) → egal: der Job ist server-seitig **vor** dem Spawn registriert; der Board-Badge erscheint beim nächsten `…/specify/jobs`-Poll.
- **Zweiter „Story anlegen"-Klick für dieselbe Idee** (laufender Job) → `409`, kein zweiter Kindprozess; UI hält „Story anlegen" deaktiviert.
- **`failed`/`auth-expired`** → Idee bleibt `status: Idee`; Board-Badge wechselt zu Fehler-Hinweis; Karte bleibt anklickbar → Reopen zeigt Fehler inline + Retry. `ProjectJobLock` im `finally` freigegeben (kein Dauer-Lock).
- **`done`** → Job aus `…/specify/jobs` entfernt; Board-View re-fetcht **einmal**; Idee übernommen/verschwunden **oder** (AC9) auf `Done` archiviert → kein Badge mehr.
- **Server-Neustart während laufendem Finalize** → idea-keyed Registry (in-memory) geht verloren → Badge verschwindet, Idee zeigt nur noch `status: Idee` (akzeptiertes Restrisiko, konsistent mit [[idea-specify-chat]] Nicht-Zielen). Erneuter Versuch über Reopen jederzeit möglich.
- **Board ohne aktive Jobs** → `…/specify/jobs` liefert `{ jobs: {} }`; Board-View pollt nicht (Ruhezustand).

## NFRs
- **Sicherheit (Floor):** neue Reads token-frei (kein Agenten-Dispatch), hinter AccessGuard; keine Secrets/Token/Host-Pfade in Response/Log/Audit (`error` als secret-freie Kurzmeldung); **kein** neuer Board-Schreibpfad (Archivierung bleibt `BoardWriter`, [[idea-specify-chat]] AC9).
- **A11y:** Lauf-/Fehler-Badge nicht nur farblich (Text/Icon + `aria-busy`/`role=status`/`aria-live`); Overlay-Fokusführung/`Esc` unverändert ([[idea-specify-chat]] AC1); Status-/Fehler-Banner programmatisch zugeordnet (`aria-live`).
- **Token-Sparsamkeit:** Status-Polling ist ein **lokaler** In-Memory-Read (kein `claude`-/Agenten-Aufruf); der teure `requirement`-Lauf bleibt **genau einmal** je „Story anlegen". Polling nur bei aktiven Jobs (kein Dauer-Poll im Ruhezustand).
- **Robustheit:** Status-Read degradierend (leerer/`null`-Job kein Crash); reload-fest (server-seitige Registry).

## Nicht-Ziele
- **Keine** persistente Job-/Status-Historie: die idea-keyed Registry ist in-memory (Verlust bei Neustart, wie die bestehenden Runner-Registries).
- **Kein** Abbruch/Cancel eines laufenden Finalize-Jobs aus der UI (nur Sichtbarkeit).
- **Kein** neuer Board-Schreibpfad; **keine** Änderung an Finalize-Verfahren/Boundaries/Doktrin aus [[idea-specify-chat]] (AC3–AC16 bleiben gültig); **keine** erneute Spezifikation des fire-and-forget-Schließens (Story S-229).
- **Kein** globaler Fortschrittsbalken / keine projektübergreifende Job-Queue-Ansicht (nur per-Idee-Badge + per-Idee-Reopen).
- **Keine** WebSocket-/Push-Zustellung des Status (Polling reicht; konsistent mit den bestehenden Status-Endpunkten).

## Abhängigkeiten
- [[idea-specify-chat]] (**realisiert** dessen Stub AC17; **baut auf** dem fire-and-forget-Schließen AC10/AC11/AC14/AC15/AC16 auf; nutzt/erweitert `IdeaSpecifyFinalizer`, `ideaSpecifyRouter`, per-Job-Status-Endpunkt AC7, Finalize AC6, Archivierung AC9, `IdeaSpecifyChatModal.jsx`) · [[ideen-inbox]] (Status `Idee`, Idee-Karte, `BoardWriter`) · [[headless-reconcile-runner]] (Status-Endpunkt-/In-Memory-Registry-Muster) · [[studis-kanban-board-ux]] (Board-/Karten-Rendering, Status-Spalten) · [[access-and-guardrails]] (AccessGuard, Audit-First) · `BoardView.jsx` · `AuditStore`.
