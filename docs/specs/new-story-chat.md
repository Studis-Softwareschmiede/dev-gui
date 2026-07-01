---
id: new-story-chat
title: „Neue Story" — Spezifizier-Chat von Grund auf (ohne Idee-Karte), Feature+Story automatisch
status: draft
version: 1
spec_format: use-case-2.0
---

# Spec: „Neue Story" — Spezifizier-Chat von Grund auf  (`new-story-chat`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Ein neuer Button **„Neue Story"** (Fabrik-Panel, „Arbeiten"-Tab, rechte Sidebar) **ersetzt** den bisherigen **„Änderung erfassen"**-Button. Er öffnet **dasselbe Multi-Turn-Chat-Overlay** wie der „Spezifizieren"-Klick auf einer Idee-Karte ([[idea-specify-chat]] — `IdeaSpecifyChatModal` + `IdeaSpecifyChatService` + headless `/agent-flow:requirement`-Finalizer), **aber ohne** dass vorher eine **Idee-Karte** existieren muss. Die **Idee-Phase entfällt komplett**: ein Klick auf „Neue Story" startet den Spezifizier-Chat **von Grund auf**; am Ende (sobald ausreichend spezifiziert) legt der `requirement`-Agent **automatisch Feature + Story im Status `To Do`** an — bereit für einen späteren Flow-Lauf.

> **Verhältnis zu [[idea-specify-chat]] (Wiederverwendung, kein Fork):** Diese Spec ist die **„from scratch"-Variante** von [[idea-specify-chat]]. Sie nutzt **denselben** zustandslosen, tool-losen Multi-Turn-`claude -p`-Chat (`IdeaSpecifyChatService`) und **denselben** headless `HeadlessFlowRunner`-Finalizer-Mechanismus — **ohne** die idee-spezifischen Teile: **kein** Seed aus einer Idee-Story, **kein** `ideaStoryId`-Übernahme-Hinweis im Requirement-Prompt und **kein** `archiveSupersededIdea`-Sicherheitsnetz (es existiert keine Idee-Karte, die verwaisen könnte). Die Board-Anlage (Feature+Story+Spec) macht **ausschließlich** der `requirement`-Agent (keine neue Spec-Format-Kenntnis in dev-gui, [[idea-specify-chat]] Nicht-Ziele).

> **Doktrin:** `claude -p` ist projektweit erlaubt (ADR-016). Diese Spec führt **keine** neue Doktrin-Ausnahme ein — sie nutzt die bereits freigegebenen Bausteine (tool-loser Chat + headless Requirement-Finalizer).

## Verhalten

### „Neue Story"-Button (ersetzt „Änderung erfassen")
1. Der bisherige **„Änderung erfassen"**-Button (öffnet `IntakeDialog` im `change`-Modus → `/agent-flow:requirement <text>` interaktiv) wird durch einen Button **„Neue Story"** ersetzt. Der `change`-Modus-Trigger dieser Sidebar-Box (`IntakeDialog mode="change"` + zugehöriger Öffnen/Schließen-State) wird entfernt.
2. Ein Klick auf **„Neue Story"** öffnet ein **Start-Feld** (einzeiliger Titel + optionaler mehrzeiliger Stichwort-Body, Muster Quick-Capture / `IdeaCaptureModal`) und startet damit den Spezifizier-Chat: der eingegebene Text seedet den **ersten** Chat-Turn. (Annahme, siehe „Offene Annahmen": ein kurzes Startfeld seedet den Chat — statt leerem Chat mit generischer Claude-Eröffnung.)
3. Danach läuft **dasselbe** Chat-Overlay wie bei [[idea-specify-chat]] (`IdeaSpecifyChatModal`, im „scratch"-Modus): Chat-Bubble-Liste (Owner-/Claude-Turns unterscheidbar, nicht nur über Farbe), A11y (Backdrop, Fokus beim Öffnen, `Esc` schließt, Fokus-Rückgabe an den Auslöser). Das Board bleibt im Hintergrund sichtbar (kein Tab-Wechsel).

### Multi-Turn-Chat (Wiederverwendung `IdeaSpecifyChatService`)
4. Der Chat nutzt **denselben** `IdeaSpecifyChatService` wie [[idea-specify-chat]]: zustandsloser `claude -p`-one-shot je Turn, **tool-los** (kein `--dangerously-skip-permissions`), belegt den PTY-Job-Lock **nicht**, läuft **ohne** `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, Verlauf **serverseitig in-memory** je Session (`sessionId → turns[]`), Text via **stdin** (nicht argv), hinter dem AccessGuard, **auditiert** (genau ein Audit-Eintrag je akzeptiertem Turn). Der Service liefert je Turn `{ reply, readyToSpecify, draftText? }` (Markdown-Fence-tolerant geparst).

### Finalisierung → echtes Feature+Story via `/agent-flow:requirement` (headless, „from scratch")
5. Sobald der Chat `readyToSpecify === true` meldet, wird **„Story anlegen"** aktiv. Ein Klick startet den **Finalizer**: eine **eigene `HeadlessFlowRunner`-Instanz mit eigener `ProjectJobLock`-Instanz** (getrennt von Flow-/Reconcile-/Nacht-Drain-/Idee-Finalize-Lock — sonst Selbstblockade) fährt `claude -p '/agent-flow:requirement <promptText>'` als Kindprozess.
6. `buildRequirementPrompt`-Variante **ohne** Idee-Bezug: hängt an den `draftText` **nur** den Hinweis „Alle nötigen Informationen liegen bereits vor — bitte nicht nachfragen, sondern mit sinnvollen Annahmen weiterarbeiten." (mildert das headless-Ohne-Rückfrage-Risiko). **Kein** `ideaStoryId`-Übernahme-Hinweis, **kein** `archiveSupersededIdea`-Sicherheitsnetz (es existiert keine Idee-Story).

### Frontend-Rückkopplung
7. Bei Finalize-Job-Status `done` schließt das Overlay mit Erfolgsmeldung; ein `onSpecified`-Callback löst ein **Board-Re-Fetch** aus, sodass das **neue Feature** (`board/features/`) und die **neue `To Do`-Story** (mit gesetztem `parent`) sofort erscheinen.
8. **Fehler-/Randpfade:** Bei `auth-expired`/`failed` erscheint der Fehler **inline**, das Overlay bleibt offen, **Retry** möglich (kein Secret-/Pfad-Leak). „Story anlegen" **ohne** `readyToSpecify` wird abgelehnt (Button deaktiviert). Ein `claude -p`-Chatfehler liefert einen klaren, secret-freien Fehler; das Overlay bleibt nutzbar.

## Acceptance-Kriterien

- **AC1** — Der Button **„Neue Story"** ersetzt „Änderung erfassen" im Fabrik-Panel („Arbeiten"-Tab, rechte Sidebar); der bisherige `IntakeDialog mode="change"`-Trigger dieser Box (Öffnen/Schließen-State + Render) ist **entfernt**. Ein Klick auf „Neue Story" öffnet **dasselbe** Chat-Overlay (`IdeaSpecifyChatModal`, „scratch"-Modus) wie der „Spezifizieren"-Klick auf einer Idee — **ohne** vorhandene Idee-Karte; A11y-Muster wie [[idea-specify-chat]] AC1 (Backdrop, Fokus, `Esc`, Fokus-Rückgabe, Bubble-Liste nicht nur über Farbe). *(1,3)*
- **AC2** — `POST /api/board/projects/:slug/story-specify/start` `{ initialText }` → `201 { sessionId, reply }`: legt eine neue serverseitige Chat-Session an und seedet sie mit `initialText` (Start-Feld, AC-Anmerkung: Titel+Stichworte); die erste `reply` ist Claudes Eröffnungs-Turn. Validierung: `initialText` getrimmt nicht-leer + Längenlimit → sonst `400 { field, message }`. `404` bei unbekanntem Projekt. Slug-Validierung wie der bestehende Board-/`ideaSpecify`-Router. *(2)*
- **AC3** — `POST /api/board/projects/:slug/story-specify/message` `{ sessionId, message }` → `200 { reply, readyToSpecify, draftText? }`: hängt die Nutzer-Nachricht an die **serverseitig** gehaltene Session-Historie an und liefert Claudes nächsten Turn (Client sendet nur die neue Nachricht). Nutzt **denselben** `IdeaSpecifyChatService` (zustandslos je Turn, tool-los, kein PTY-Lock, kein API-Key, stdin statt argv, auditiert — Garantien wie [[idea-specify-chat]] AC5/AC13). `400`/`404` bei unbekannter/abgelaufener Session; `502` (secret-freier `claude -p`-Fehler). *(4)*
- **AC4** — `POST /api/board/projects/:slug/story-specify/finalize` `{ sessionId }` → `202 { jobId, status: 'running' }`: startet den **„from scratch"-Finalizer** über eine **eigene `HeadlessFlowRunner`-Instanz mit eigener `ProjectJobLock`-Instanz** (getrennt von allen anderen Locks), der `/agent-flow:requirement <promptText>` headless fährt. `promptText` = `draftText` + **nur** der „nicht-nachfragen"-Hinweis (AC/Regel 6) — **ohne** `ideaStoryId`-Hinweis. **Kein** `archiveSupersededIdea`-Nachlauf. Finalize nur zulässig bei gemeldetem `readyToSpecify` (sonst `400`/`409`). Job-Start/-Ende/-Fehler auditiert; keine Secrets/Token/Host-Pfade in Audit/Log/Response. *(5,6)*
- **AC5** — `GET /api/board/projects/:slug/story-specify/finalize/:jobId` → `200 { status: 'running'|'done'|'failed'|'auth-expired', result?, error? }` | `404` (Job unbekannt). Format 1:1 wie der [[idea-specify-chat]]-/Reconcile-Status-Endpunkt. Secret-frei. *(5,8)*
- **AC6** — Bei Finalize-Status `done` schließt das Overlay mit Erfolgsmeldung und löst über `onSpecified` ein **Board-Re-Fetch** aus: das **neue Feature** + die **neue `To Do`-Story** (mit gesetztem `parent`) erscheinen sofort. *(7)*
- **AC7** — Fehler-/Randpfade: bei `auth-expired`/`failed` erscheint der Fehler **inline**, das Overlay **bleibt offen**, Retry möglich, **kein** Secret-/Pfad-Leak; „Story anlegen" **ohne** `readyToSpecify` ist deaktiviert; ein Chat-`502` liefert einen klaren, secret-freien Fehler, Overlay bleibt nutzbar. *(8)*
- **AC8** — Wiederverwendung ohne Fork/Neubau: der Chat nutzt **denselben** `IdeaSpecifyChatService` (kein neuer Chat-Service) und den **bestehenden** `HeadlessFlowRunner` (kein neuer Runner-Typ); es entsteht **keine** neue Spec-Format-Kenntnis in dev-gui — Feature/Story/Spec (inkl. `spec_format`-Stempel) legt **ausschließlich** der `requirement`-Agent an. Der „scratch"-Finalizer unterscheidet sich vom Idee-Finalizer **nur** durch den Prompt (kein Idee-Hinweis) und das fehlende `archiveSupersededIdea`-Netz. *(4,5,6)*

## Verträge

### Endpunkte (neuer/erweiterter Router, Slug-Validierung wie `ideaSpecifyRouter`)
- `POST /api/board/projects/:slug/story-specify/start` `{ initialText: string }` → `201 { sessionId, reply }` | `400 { field, message }` (leerer/zu langer `initialText`) | `404` (Projekt unbekannt) | `502` (`claude -p`-Fehler, secret-frei).
- `POST /api/board/projects/:slug/story-specify/message` `{ sessionId, message }` → `200 { reply, readyToSpecify: boolean, draftText? }` | `400 { field, message }` | `404` (Session unbekannt) | `502`.
- `POST /api/board/projects/:slug/story-specify/finalize` `{ sessionId }` → `202 { jobId, status: 'running' }` | `400`/`409` (kein `readyToSpecify` / Projekt-Lock belegt) | `404`.
- `GET /api/board/projects/:slug/story-specify/finalize/:jobId` → `200 { status: 'running'|'done'|'failed'|'auth-expired', result?, error? }` | `404`.

### Boundaries
- **Chat:** `IdeaSpecifyChatService` (`src/IdeaSpecifyChatService.js`) — **unverändert** wiederverwendet (Session-Registry, injizierbarer Claude-Runner, stdin, tool-los).
- **Finalizer (scratch):** dünner Orchestrator um eine **eigene** `HeadlessFlowRunner`-Instanz + **eigenes** `ProjectJobLock` (Konstruktor-Default), `buildRequirementPrompt`-Variante ohne Idee-Hinweis; **kein** `BoardWriter.archiveSupersededIdea`-Nachlauf. (Kann als Modus/Parametrisierung des bestehenden `IdeaSpecifyFinalizer` **oder** als schlanke Schwester-Boundary umgesetzt werden — Implementierungswahl frei, solange die Locks getrennt sind und der Prompt korrekt ist.)
- **Router:** ein neuer `storySpecifyRouter` **oder** eine Erweiterung von `ideaSpecifyRouter` (frei), mit den vier `story-specify`-Endpunkten.
- **Frontend:** `IdeaSpecifyChatModal` bekommt einen **„scratch"-Modus** (Start-Feld + andere Endpunkt-Basis, ohne `story.id`); die Sidebar-Box „Änderung erfassen" wird zu „Neue Story" (Trigger + Modal-Verdrahtung); `IntakeDialog mode="change"` entfällt an dieser Stelle.

## Edge-Cases & Fehlerverhalten
- **Leerer/whitespace-only `initialText`** → `400 { field: "initialText" }`; keine Session.
- **`initialText`/Message über Längenlimit** → `400` (Schutz vor Riesen-Payload).
- **`claude -p` im Chat schlägt fehl / nicht im PATH** → `502` secret-frei; Overlay bleibt nutzbar (Historie erhalten, Retry möglich).
- **Finalize ohne `readyToSpecify`** → Button deaktiviert; dennoch abgesetzter Request → `400`/`409`, kein Job-Start.
- **Finalize-`requirement`-Job `failed`/`auth-expired`** → Status-Endpunkt liefert den Terminal-Status; Overlay zeigt Fehler inline, bleibt offen, Retry möglich; `ProjectJobLock` im finally frei.
- **Parallele Finalize fürs selbe Projekt** → das **eigene** `ProjectJobLock` verhindert Doppel-Läufe (`409`/`locked`), ohne andere Pfade zu berühren.
- **`requirement`-Agent legt keine Story an / bricht ab** → keine verwaiste Idee (es gab keine); der Owner sieht den Fehlerstatus und kann erneut spezifizieren. (Restrisiko: der headless `requirement` kann niemanden fragen — gemildert durch den vorgelagerten Chat + den „nicht-nachfragen"-Hinweis.)
- **Server-Neustart während Chat/Finalize** → In-Memory-Session + Job-Registry verloren (Nicht-Ziel, wie bei den bestehenden Runnern).

## NFRs
- **Sicherheit (Floor):** Chat-Pfad hinter AccessGuard, auditiert, Text via **stdin** (nicht argv), tool-los, **kein** API-Key in der Child-Env. Finalizer nutzt den tool-fähigen `HeadlessFlowRunner` (argv-Array, kein Shell-String; harter `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block; `--dangerously-skip-permissions` bleibt ausschließlich im getrennten headless-Pfad). Keine Secrets/Token/Host-Pfade in Log/Audit/Response/WS. Eigenes, getrenntes `ProjectJobLock`.
- **A11y:** Overlay-Fokusführung, `Esc`, Fokus-Rückgabe; Chat-Turns semantisch/typografisch unterscheidbar (nicht nur Farbe); Status/Fehler programmatisch zugeordnet ([[idea-specify-chat]] AC1).
- **Token-Sparsamkeit:** je Turn ein kleiner tool-loser `claude -p`-Aufruf; der teure `requirement`-Lauf läuft **genau einmal** beim „Story anlegen".

## Nicht-Ziele
- **Kein** neuer Chat-Service (nutzt `IdeaSpecifyChatService` unverändert) und **kein** neuer Runner-Typ (nutzt `HeadlessFlowRunner`).
- **Keine** Idee-Karte / **kein** Board-Item vor dem Chat — die Idee-Phase entfällt bewusst komplett.
- **Kein** neues Spec-Format-Wissen in dev-gui: Feature/Story/Spec legt **ausschließlich** der `requirement`-Agent an.
- **Keine** persistente Chat-/Job-Historie (In-Memory).
- **Kein** Umbau des interaktiven PTY-/`CommandService`-Pfads.

## Abhängigkeiten
- [[idea-specify-chat]] (Chat-Overlay `IdeaSpecifyChatModal`, `IdeaSpecifyChatService`, headless `requirement`-Finalizer, `ProjectJobLock`-Trennung, Status-Endpunkt-Muster — **Wiederverwendung**; diese Spec ist die „from scratch"-Variante ohne Idee-Bezug) · [[headless-parallel-drain]] (`HeadlessFlowRunner`) · [[headless-reconcile-runner]] (Job-Registry-/Status-Muster) · [[access-and-guardrails]] (AccessGuard, Audit-First) · [[fabric-intake-dialog]] (die abgelöste „Änderung erfassen"-Intake-Box) · [[flow-trigger]] (interaktiver Pfad, unverändert).
- **agent-flow-Skills:** `requirement` (Chat-Draft → Feature/Story/Spec) — **keine** Änderung nötig; headless mit dem „nicht-nachfragen"-Hinweis aufgerufen.

## Offene Annahmen (mangels Rückfrage-Möglichkeit als Subagent gesetzt — vom Owner bestätigbar)
- **A1 (Chat-Start):** „Neue Story" öffnet ein **kurzes Start-Feld** (Titel + Stichworte), dessen Text den ersten Turn seedet — **statt** eines leeren Chats mit generischer Claude-Eröffnung. Falls der Owner den leeren Chat bevorzugt: `start` ohne `initialText`, Claude eröffnet generisch (AC2 entsprechend anpassen).
