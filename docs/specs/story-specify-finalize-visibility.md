---
id: story-specify-finalize-visibility
title: „Neue Story"-Chat — Finalize-Lauf sichtbar machen (No-Op-Erkennung + Status-Rückmeldung)
status: draft
version: 1
spec_format: use-case-2.0
---

# Spec: „Neue Story"-Chat — Finalize-Lauf sichtbar machen  (`story-specify-finalize-visibility`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der „Neue Story"-Chat ([[new-story-chat]], `mode="scratch"`) legt am Ende über den `StorySpecifyFinalizer` headless einen `/agent-flow:requirement`-Lauf an, der **von Grund auf** Feature + Story + Spec erzeugen soll. Ein Live-Test (Owner, 2026-07-01) hat einen **blinden Fleck** aufgedeckt: schlägt der Lauf ergebnislos fehl, entsteht **nichts** — **ohne** jede Rückmeldung an den Owner. Diese Spec macht den Finalize-Lauf **sichtbar**: sie erkennt den „durchgelaufen, aber nichts erzeugt"-Fall (**No-Op**) und surface-t ihn zuverlässig (Overlay-inline + reload-feste, projekt-keyed Status-Rückmeldung), sodass der Owner **jeden** Fehlausgang bemerkt und erneut versuchen kann.

## Kontext / Root-Cause (per Live-Diagnose bestätigt)

- **Auslöser:** der headless `/agent-flow:requirement`-Lauf konnte in diesem Moment die interne GitHub-Auth (`ensure-gh-auth.sh` im Container) **transient** nicht erneuern (einmaliger GPG-Mint-Aussetzer; kurz danach manuell reproduziert → sofort wieder ok, **kein** Dauerzustand). Der `requirement`-Agent gab daraufhin **nur eine erklärende Text-Antwort** und beendete den Lauf — **ohne** Board-Schreib-/Anlage-Aktion.
- **Warum unsichtbar:** der `StorySpecifyFinalizer` reicht den Runner-Status **1:1** durch (bewusste Entscheidung in [[new-story-chat]] AC5/AC8: „KEIN no-op-Mapping, KEIN Sicherheitsnetz, da keine Platzhalter-Idee existiert, die geschützt werden müsste"). Der `claude -p`-Kindprozess **exitet sauber (Code 0)**, weil der Agent nur Text ausgab — der Runner meldet daher **`done`**. Der scratch-Modus des `IdeaSpecifyChatModal` wertet `done` als **Erfolg**: kurze Erfolgsmeldung → `onSpecified()` → Board-Re-Fetch → Overlay schließt. Da nichts entstand, erscheint **keine** neue Story — und **kein** Fehler. Der Owner erfährt rein gar nichts (nur Audit-Log + Docker-interne Transcripts hätten es gezeigt).
- **Der eigentliche Defekt ist breiter als der Auth-Aussetzer:** die fehlende No-Op-/Sichtbarkeits-Schicht macht **jeden** ergebnislosen `requirement`-Ausgang unsichtbar (nicht nur den Auth-Fall). Das ist ein von der No-Op-Sicherheitsnetz-Frage **unabhängiges**, eigenständiges Problem.

## Kontext / Designentscheidungen (vom requirement-Agenten getroffen; Owner-delegiert, im Cut-PR revidierbar)

> Der Owner hat zwei gleichwertige Lösungswege angeboten (volle idea-keyed-Maschinerie wie S-230/S-237 **oder** eine leichtgewichtigere Variante) und die fachliche Abwägung delegiert. Bindend dokumentiert:

- **Entscheidung A — No-Op-Erkennung ist der Kern, nicht die Registry.** Anders als beim Idee-Specify-Pfad (fire-and-forget → Overlay schließt sofort → brauchte die volle overlay-unabhängige, idea-keyed Sichtbarkeit S-230/S-237) **pollt** der scratch-Modus den Finalize-Status **mit offenem Overlay** bis Terminal ([[new-story-chat]] AC6). Der primäre blinde Fleck ist daher **nicht** „Overlay geschlossen", sondern „`done`, obwohl nichts entstand". Deshalb ist die **No-Op-Erkennung** (Entscheidung A1) der Kern der Behebung — ohne sie würde selbst eine volle Registry einen ergebnislosen Lauf weiterhin grün als `done` zeigen.
- **Entscheidung A1 — No-Op read-only per Snapshot-Diff (revidiert [[new-story-chat]] AC8).** Der `StorySpecifyFinalizer` erhält doch eine No-Op-Erkennung — aber **read-only** (kein `BoardWriter`, es gibt nichts zu archivieren): Snapshot der Story-/Feature-Menge vor dem Lauf, Diff nach Runner-`done`. Kein neuer Schreibpfad, konsistent mit der read-only-Aggregator-Linie und ADR-005. Die frühere Absolutaussage „KEIN no-op-Mapping" in [[new-story-chat]] AC5/AC8 wird durch diese Spec **superseded** (Live-Test-Nachlese).
- **Entscheidung A2 — leichtgewichtige, projekt-keyed Status-Rückmeldung statt per-Karten-Badge.** Die volle idea-keyed-Maschinerie (S-230/S-237) hat eine **Idee-Karte** als Anker; im „from scratch"-Pfad existiert vor dem Erfolg **keine Karte und keine Story** — ein per-Karten-Badge hätte hier keinen Anker. Gewählt wird deshalb die **leichtgewichtigere Variante**: eine **projekt-keyed** In-Memory-Registry des letzten Finalize-Jobs + **ein** schmaler Read-Endpunkt, angezeigt als (a) inline im Overlay (auch beim Wieder-Öffnen der „Neue Story") und (b) ein nicht-blockierender Board-Hinweis („Story-Erstellung fehlgeschlagen — erneut versuchen"). Das deckt Reload-Festigkeit ab, ohne die schwere per-Idee-Sicht zu duplizieren.

## Verhalten

### V1 — No-Op-Erkennung (read-only Snapshot-Diff)
1. Beim `start()` nimmt der `StorySpecifyFinalizer` einen **read-only Snapshot** der aktuellen Board-Menge des Projekts (Menge der Story-IDs in `board/stories/` und/oder der Feature-IDs in `board/features/`). Nach Erreichen des Runner-Terminalstatus **`done`** re-scannt er dieselbe Menge und bildet den **Diff**.
2. Ist nach `done` **keine neue Story** (und **kein neues Feature**) hinzugekommen → der Lauf lief zwar durch, erzeugte aber **nichts** → Terminalstatus **`no-op`** (secret-freie Kurzmeldung, z.B. „Der Lauf hat keine Story angelegt — bitte erneut versuchen."). Kam mindestens eine neue Story hinzu → `done` (echter Erfolg). Der Snapshot-Read ist **best effort**: schlägt er fehl, degradiert die Erkennung sicher zu `done` (kein Crash), ohne den Lauf zu blockieren.

### V2 — Terminal-Status unterscheidet Erfolg von No-Op/Fehler
3. `getJob(jobId)` liefert `status ∈ {running, done, no-op, failed, auth-expired}`: `done` **nur** bei tatsächlich angelegter Story (V1), `no-op` beim „durchgelaufen, aber nichts erzeugt", `failed`/`auth-expired` wie vom Runner gemeldet. Format ansonsten 1:1 wie der bestehende idea-specify-/Reconcile-Status-Endpunkt; secret-/token-/host-pfad-frei.

### V3 — Projekt-keyed Last-Finalize-Registry (reload-fest)
4. Der `StorySpecifyFinalizer` hält zusätzlich eine **projekt-keyed** Sicht: je `projectSlug` den **letzten** Finalize-Job (`status`, `jobId`, `error?`). Der Job wird **synchron beim Finalize-Request-Empfang** mit Status `running` (keyed by `projectSlug`) registriert — **bevor** der `requirement`-Kindprozess spawnt (analog S-237/AC1). So findet die UI den Lauf **reload-fest**, unabhängig davon, ob der Client die `202`-Antwort verarbeitet oder das Overlay bereits geschlossen/neu geladen wurde.
5. Ein **schmaler** Read-Endpunkt liefert den letzten Finalize-Job **eines Projekts** (projekt-keyed), inkl. `no-op` (→ als retry-würdiger Fehlausgang behandelt). Der Read ist **token-frei** (kein Agenten-Dispatch, keine Board-Schreibaktion) und **secret-/token-/host-pfad-frei**.

### V4 — Overlay reflektiert den Ausgang zuverlässig
6. Der scratch-Modus schließt **nur** bei echtem `done` mit Erfolgsmeldung + `onSpecified()` (Board-Re-Fetch). Bei `no-op`/`failed`/`auth-expired` **bleibt das Overlay offen**, zeigt einen **nicht-blockierenden**, secret-freien Fehler **inline** und erlaubt **Retry** (der „Story anlegen"-Pfad bleibt nutzbar). Insbesondere darf `no-op` **nicht** den Erfolgs-/Schließ-Pfad auslösen.
7. Beim **Wieder-Öffnen** der „Neue Story" fragt das Overlay den projekt-keyed Status-Endpunkt ab und zieht den letzten bekannten Ausgang **inline** nach: `running` → Banner „Ein Story-Erstellungs-Lauf läuft noch…" + „Story anlegen" deaktiviert (kein zweiter Lauf); `no-op`/`failed`/`auth-expired` → Fehler-Banner + Retry; `null`/`done` → normaler frischer Chat-Einstieg. Secret-/pfad-frei; degradiert still (leerer/`null`-Job → normaler Einstieg).

### V5 — Board-Hinweis (nicht-blockierend, reload-fest)
8. Trägt der letzte Finalize-Lauf eines Projekts `no-op`/`failed`/`auth-expired`, zeigt die Board-Ansicht einen **nicht-blockierenden**, secret-freien Hinweis („Story-Erstellung fehlgeschlagen — erneut versuchen"), der die Board-Nutzung **nicht** blockiert (Text/Icon, nicht nur Farbe; `role=status`/`aria-live`). Der Hinweis ist **quittierbar** bzw. verschwindet, sobald ein neuer Lauf `running`/`done` erreicht. Der Board-View **pollt** den Status-Endpunkt nur leichtgewichtig, solange ein Finalize `running` ist **oder** direkt nach dem Auslösen — im Ruhezustand **kein** Polling.

## Acceptance-Kriterien

- **AC1** — **No-Op-Erkennung (read-only Snapshot-Diff).** Der `StorySpecifyFinalizer` nimmt beim `start()` einen read-only Snapshot der Projekt-Board-Menge (Story-IDs, optional Feature-IDs) und bildet nach Runner-`done` den Diff. Kam **keine** neue Story hinzu → Terminalstatus **`no-op`** (secret-freie Kurzmeldung); kam ≥1 neue Story hinzu → `done`. **Kein** `BoardWriter`-/Schreibpfad (read-only). Schlägt der Snapshot-Read fehl → sichere Degradierung zu `done` (kein Crash). *(V1)* — **revidiert [[new-story-chat]] AC5/AC8** („kein no-op-Mapping").
- **AC2** — **Terminal-Status-Klassifizierung.** `getJob(jobId)` liefert `status ∈ {running, done, no-op, failed, auth-expired}` mit `done` **ausschließlich** bei tatsächlich angelegter Story. Format sonst 1:1 wie der bestehende Status-Endpunkt; Response/Log secret-/token-/host-pfad-frei. *(V2)*
- **AC3** — **Projekt-keyed Registry + synchrone Registrierung.** Der Finalizer hält je `projectSlug` den letzten Job (`status`, `jobId`, `error?`) und registriert ihn **synchron mit `running` vor dem Kindprozess-Spawn** (reload-fest, unabhängig von der `202`-Verarbeitung). `error` ist eine secret-/pfad-freie Kurzmeldung. *(V3)*
- **AC4** — **Projekt-keyed Read-Endpunkt (token-frei, secret-frei).** `GET /api/board/projects/:slug/story-specify/finalize` → `200 { job: { status: 'running'|'done'|'no-op'|'failed'|'auth-expired', jobId, error? } | null }` | `404` (Projekt unbekannt). Hinter AccessGuard, **kein** Agenten-Dispatch, **kein** Board-Schreibpfad, **keine** Secrets/Token/Host-Pfade in Response/Log. Slug-Validierung wie der bestehende `storySpecifyRouter`. Der bestehende per-Job-Endpunkt (`…/finalize/:jobId`) bleibt unverändert. *(V3)*
- **AC5** — **Overlay reflektiert den Ausgang.** Der scratch-Modus schließt **nur** bei echtem `done` (Erfolg + `onSpecified()` + Board-Re-Fetch). Bei `no-op`/`failed`/`auth-expired` bleibt das Overlay **offen**, zeigt einen nicht-blockierenden, secret-freien Fehler **inline**, Retry möglich; `no-op` löst **nicht** den Erfolgs-/Schließ-Pfad aus. Beim Wieder-Öffnen zieht das Overlay den projekt-keyed Status **inline** nach (`running` → Banner + „Story anlegen" deaktiviert; `no-op`/`failed`/`auth-expired` → Fehler-Banner + Retry; `null`/`done` → frischer Einstieg). *(V4)*
- **AC6** — **Board-Hinweis + leichtgewichtiges Polling.** Trägt der letzte Finalize eines Projekts `no-op`/`failed`/`auth-expired`, zeigt die Board-Ansicht einen nicht-blockierenden, secret-freien Hinweis (Text/Icon, nicht nur Farbe; `role=status`/`aria-live`), der die Board-Nutzung nicht blockiert und verschwindet/quittierbar ist, sobald ein neuer Lauf `running`/`done` erreicht. Der Endpunkt aus AC4 wird nur gepollt, solange ein Job `running` ist **oder** direkt nach dem Auslösen — im Ruhezustand **kein** Polling. Reload-fest (server-seitige Registry). *(V5)*

## Verträge

### Endpunkte (Erweiterung des `storySpecifyRouter`)
- **Neu:** `GET /api/board/projects/:slug/story-specify/finalize` → `200 { job: { status: 'running'|'done'|'no-op'|'failed'|'auth-expired', jobId: string, error?: string } | null }` | `404` (Projekt unbekannt). Letzter bekannter Finalize-Job **dieses Projekts** (projekt-keyed). Token-/secret-frei. Für Overlay-Reopen + Board-Hinweis.
- **Erweitert:** `POST /api/board/projects/:slug/story-specify/finalize` — **neu**: synchrone projekt-keyed `running`-Registrierung **vor** dem Spawn (Vertrag/Response `202 { jobId, status: 'running' }` unverändert).
- **Unverändert:** `GET /api/board/projects/:slug/story-specify/finalize/:jobId` (per-Job-Status; **neu** um `no-op` im Wertebereich ergänzt), `…/story-specify/start`, `…/story-specify/message`.

### Finalizer-Boundary (`StorySpecifyFinalizer`, Erweiterung)
- **Snapshot-Diff (AC1):** `start()` erfasst read-only die Projekt-Board-Menge (Story-IDs; optional Feature-IDs) — z.B. über den read-only `BoardAggregator`/`getIndex` oder einen schmalen Verzeichnis-Read von `board/stories/`. Nach Runner-`done`: Re-Scan + Diff → `no-op`, wenn keine neue Story. Kein `BoardWriter` (read-only).
- **Registry (AC3):** `lastJobByProject: Map projectSlug → { status, jobId, error? }`, in-memory (Verlust bei Server-Neustart = Nicht-Ziel, wie die bestehenden Runner-Registries). `start(projectPath, {draftText, projectSlug})` registriert **synchron** vor dem Spawn `running`; `getJob()` resolved den aktuellen Status **live** inkl. `no-op`-Mapping, damit ein terminaler Job nicht als stale `running` hängen bleibt.
- **`lastForProject(projectSlug) → {...}|null`** speist den Read-Endpunkt.

### Frontend
- **Overlay** (`IdeaSpecifyChatModal.jsx`, scratch-Modus): Terminal-Behandlung um `no-op` erweitern (bleibt offen + inline-Fehler + Retry, kein Erfolgs-Close); Reopen fragt den projekt-keyed Status ab und zeigt Banner/Retry inline (AC5).
- **Board-View** (`BoardView.jsx`): nicht-blockierender Hinweis bei letztem `no-op`/`failed`/`auth-expired`-Finalize; leichtgewichtiges Polling mit Start-/Stopp-Bedingung (AC6).

## Edge-Cases & Fehlerverhalten
- **`done`, aber nichts angelegt** (Auth-Aussetzer / Agent gab nur Text aus) → No-Op-Diff greift → `no-op` → Overlay bleibt offen + Fehler + Retry; Board-Hinweis; kein stiller Erfolg. **(Der gemeldete Bug.)**
- **`done` mit angelegter Story** → normaler Erfolg (Overlay schließt, `onSpecified`, neue To-Do-Story erscheint).
- **`failed`/`auth-expired`** → wie bisher Terminalstatus; Overlay bleibt offen, Retry; Board-Hinweis; `ProjectJobLock` im `finally` frei.
- **Snapshot-Read schlägt fehl** → sichere Degradierung zu `done` (kein Crash, kein blockierter Lauf).
- **Zweiter Finalize fürs selbe Projekt bei laufendem Job** → wie bisher `409` über das projekt-weite `ProjectJobLock` (kein zweiter Kindprozess); UI hält „Story anlegen" deaktiviert.
- **Client sieht die `202` nie** (Overlay zu / Reload) → egal: der Job ist projekt-keyed **vor** dem Spawn registriert; der Board-Hinweis/das Reopen findet ihn beim nächsten Read.
- **Server-Neustart während Finalize** → projekt-keyed Registry (in-memory) verloren → Hinweis verschwindet; erneuter Versuch jederzeit möglich (akzeptiertes Restrisiko, konsistent mit den bestehenden Runnern).

## NFRs
- **Sicherheit (Floor):** neuer Read token-frei (kein Agenten-Dispatch, kein Board-Write), hinter AccessGuard; keine Secrets/Token/Host-Pfade in Response/Log/Audit (`error` als secret-freie Kurzmeldung). Finalize-Start bleibt auditiert wie [[new-story-chat]] AC4. **Kein** neuer Board-Schreibpfad (No-Op-Diff ist read-only).
- **A11y:** Overlay-Fehler-/Status-Banner und Board-Hinweis programmatisch zugeordnet (`role=status`/`aria-live`), nicht nur farblich.
- **Token-Sparsamkeit:** Status-Read ist ein lokaler In-Memory-/Dateisystem-Read (kein `claude`-/Agenten-Aufruf); der teure `requirement`-Lauf bleibt **genau einmal** je „Story anlegen". Polling nur bei aktivem Job.
- **Robustheit:** No-Op-Diff und Status-Read degradieren sicher (kein Crash bei defektem/teilweisem Board).

## Folge-Hinweis außerhalb dev-gui (kein Board-Item in diesem Repo)
- **Transiente-Auth-Robustheit (`ensure-gh-auth.sh`).** Der einmalige GPG-Mint-Aussetzer, der den Lauf ergebnislos machte, entstand im **agent-flow-Plugin** (`scripts/ensure-gh-auth.sh` + `load-env.sh`) — **nicht** im dev-gui-Repo. Empfehlung für ein **separates Folge-Vorgehen im agent-flow-Repo** (hier bewusst **kein** Board-Item, da außerhalb dieses Repos, und diese Spec ändert das agent-flow-Repo nicht): ein **einmaliger Retry nach kurzer Pause** beim Passphrase-Mint/Login, bevor der Bootstrap endgültig aufgibt — das überbrückt künftige Ein-Wort-Aussetzer automatisch. Diese Härtung ist **unabhängig** von der oben spezifizierten Sichtbarkeit (die Sichtbarkeit fängt **jeden** ergebnislosen Ausgang ab, nicht nur den Auth-Fall).

## Nicht-Ziele
- **Keine** volle per-Karten/per-Idee-Badge-Maschinerie wie [[idea-specify-background-status]] (es gibt im „from scratch"-Pfad keine Karte als Anker — Entscheidung A2).
- **Kein** neuer Board-Schreibpfad; **kein** `BoardWriter`-Nachlauf (No-Op-Diff ist read-only — es existiert keine verwaiste Idee, die archiviert werden müsste).
- **Keine** persistente Job-/Status-Historie (In-Memory, Verlust bei Neustart).
- **Kein** Abbruch/Cancel eines laufenden Finalize-Jobs aus der UI (nur Sichtbarkeit).
- **Keine** Änderung am agent-flow-Repo / an `ensure-gh-auth.sh` (nur als Folge-Hinweis dokumentiert).
- **Kein** Umbau des interaktiven PTY-/`CommandService`-Pfads.

## Abhängigkeiten
- [[new-story-chat]] (**supersedet** dessen „kein no-op-Mapping"-Entscheidung AC5/AC8; erweitert `StorySpecifyFinalizer`, `storySpecifyRouter`, `IdeaSpecifyChatModal` scratch-Modus) · [[idea-specify-background-status]] (Muster: synchrone `running`-Registrierung vor Spawn, token-freie Status-Reads — hier projekt-keyed statt idea-keyed) · [[idea-specify-chat]] (Finalizer-/Status-Endpunkt-Muster, `ProjectJobLock`-Trennung) · [[headless-parallel-drain]] (`HeadlessFlowRunner`) · [[access-and-guardrails]] (AccessGuard, Audit-First) · [[studis-kanban-board-ux]] (Board-/Karten-Rendering) · `BoardView.jsx` · `AuditStore`.
- **agent-flow (außerhalb dev-gui, kein Board-Item):** `scripts/ensure-gh-auth.sh` + `load-env.sh` — optionaler transienter Retry (Folge-Hinweis).
</content>
</invoke>
