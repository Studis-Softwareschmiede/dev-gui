---
id: obsidian-question-catalog
title: Obsidian-Ingest — strukturierter Fragenkatalog in der GUI (Interrupt/Resume)
status: active
version: 1
spec_format: use-case-2.0
---

# Spec: Strukturierter Fragenkatalog für den Obsidian-Ingest (`obsidian-question-catalog`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` — hartes Drift-Gate. Security-relevant (headless `claude -p`-Pfad, Trust-Boundary).

## Zweck
Wird die from-notes-Pipeline ([[obsidian-project-intake]]) durch **Widersprüche/Lücken** in den Notizen unterbrochen, liefert die Fabrik-Seite (agent-flow, PR #217) einen **maschinenlesbaren Fragenkatalog** (Felder je Frage: `stage`, `id`, `frage`, `quelle`, `optionen`). Diese Spec zeigt diesen Katalog **strukturiert in der GUI** an — statt ihn nur als Terminal-Text durchlaufen zu lassen — sammelt die Antworten **gebündelt** und gibt sie **zurück**, bevor die unterbrochene Stufe fortgesetzt wird. Das Interaktionsmuster orientiert sich an den bestehenden strukturierten Q&A-Overlays [[idea-specify-chat]] und [[new-story-chat]] (Overlay über dem Board/Flow, A11y, Fehler inline, headless `claude -p` + `HeadlessFlowRunner`-Muster).

> **Warum eigene Spec + eigene Priorität:** Ein maschinenlesbarer `stage/id/frage/quelle/optionen`-Katalog und ein **Resume-mit-Antworten**-Protokoll setzen einen **strukturierten Rückkanal** voraus, den der reine interaktive PTY-Stream ([[obsidian-project-intake]]) nicht sauber liefert. Diese Capability ist daher als **headless Runner + strukturierter Return** modelliert (Präzedenz [[idea-specify-chat]]/[[new-story-chat]] · ADR-016/ADR-017) und **hängt am noch nicht gemergten agent-flow-Rückgabeformat** (PR #217). Bis dessen Vertrag verbindlich ist, sind Feldnamen/Endpunkt-Mapping unten als **Annahme** markiert und **lose gekoppelt** — deshalb eigene, niedriger geordnete Story (nicht Blocker für [[obsidian-project-intake]], das über den Terminal-Handoff bereits funktioniert).

## Verhalten

### Headless-Lauf mit strukturiertem Ausgang
1. Der from-notes-Lauf für die GUI-Katalog-Variante läuft **headless** über eine **eigene `HeadlessFlowRunner`-Instanz mit eigener `ProjectJobLock`-Instanz** (getrennt von Flow-/Reconcile-/Nacht-Drain-/Idee-Finalize-Lock — sonst Selbstblockade), analog [[idea-specify-chat]] AC6 / [[headless-manual-drain]]. Der Lauf endet je Runde in **einem** von zwei strukturierten Zuständen: **`done`** (Pipeline durch, Board/`docs/` aktualisiert) **oder** **`needs-answers`** (Fragenkatalog liegt an).
2. Bei `needs-answers` liefert der Status-Endpunkt den **maschinenlesbaren Fragenkatalog**: eine Liste von Fragen, je Frage `{ stage, id, frage, quelle, optionen? }` (Feldnamen aus dem agent-flow-Rückgabeformat, PR #217 — s. Annahme A1). `stage` = betroffene Ingest-Stufe (Notiz→Konzept→Spec→Story); `quelle` = Notiz-/Fundstellen-Hinweis; `optionen` = optionale Antwort-Auswahl.

### Fragenkatalog-Overlay (kein Tab-Sprung)
3. Ist ein Katalog offen, öffnet dev-gui ein **Overlay** (Muster [[idea-specify-chat]]/[[new-story-chat]]: Backdrop, Fokus beim Öffnen, `Esc` schließt/pausiert, Fokus-Rückgabe an den Auslöser) und rendert den Katalog **strukturiert**: gruppiert nach `stage`, je Frage der `frage`-Text, die `quelle` als Kontext, und — falls `optionen` vorhanden — als Auswahl (Radio/Select), sonst als Freitext-Antwort. Fragen sind **nicht nur über Farbe** unterscheidbar (Semantik/Typografie), Antworten sind Pflicht-/Optional-markiert wie vom Katalog vorgegeben.
4. Der Nutzer beantwortet die Fragen **gebündelt** (eine Runde = ein Katalog). „Antworten senden" ist erst aktiv, wenn alle **Pflicht**-Fragen beantwortet sind.

### Antworten zurückgeben → Stufe fortsetzen (Resume)
5. „Antworten senden" gibt die gesammelten Antworten **strukturiert** zurück (`[{ id, answer }]`, `id` = die Katalog-Frage-ID) und **setzt die unterbrochene Stufe fort** (Resume desselben headless Laufs). Die Pipeline verarbeitet die Antworten und läuft weiter — bis zum nächsten Katalog (`needs-answers`, erneut Overlay) oder bis `done`.
6. Bei `done` schließt das Overlay mit Erfolgsmeldung; ein `onSpecified`/Re-Fetch-Callback aktualisiert Board/`docs/`-Ansicht (neue Story/Specs erscheinen), analog [[new-story-chat]] AC6.

### Fehler-/Randpfade
7. Ein `claude -p`-/Runner-Fehler oder ein nicht-parsbarer Katalog liefert einen klaren, **secret-freien** Fehler **inline** im Overlay; das Overlay bleibt nutzbar (Retry möglich). Schließen/`Esc`/Backdrop reagieren **immer** (kein blockierender Guard, Lehre aus [[idea-specify-chat]] AC14); ein bereits gestarteter headless Lauf wird durch Schließen **nicht** abgebrochen (läuft detached weiter). Fehlende/leere Antwort auf eine Pflicht-Frage → „Antworten senden" deaktiviert.

## Acceptance-Kriterien
- **AC1** — Der from-notes-Katalog-Lauf läuft **headless** über eine **eigene `HeadlessFlowRunner`-Instanz mit eigener `ProjectJobLock`-Instanz** (getrennt von allen anderen Locks); ein Status-Endpunkt liefert je Runde einen **terminalen** Zustand `done` **oder** einen **Interrupt-Zustand** `needs-answers` mit dem Fragenkatalog. Keine Secrets/Token/Host-Pfade in Log/Audit/Response. *(1,2)*
- **AC2** — Bei `needs-answers` liefert der Endpunkt den **maschinenlesbaren Katalog** als Liste `[{ stage, id, frage, quelle, optionen? }]` (Feldnamen aus dem agent-flow-Format, PR #217; Markdown-Fence-tolerant geparst). Ein nicht-parsbarer Ausgang → definierter `502`/Fehlerzustand, **kein** Crash, secret-frei. *(2,7)*
- **AC3** — dev-gui rendert den Katalog in einem **Overlay** (A11y-Muster [[idea-specify-chat]] AC1: Backdrop, Fokus, `Esc`, Fokus-Rückgabe), **gruppiert nach `stage`**, je Frage `frage`-Text + `quelle`-Kontext, `optionen` als Auswahl (sonst Freitext). Fragen/Zustände nicht nur über Farbe unterscheidbar. *(3)*
- **AC4** — „Antworten senden" ist **erst aktiv**, wenn alle **Pflicht**-Fragen beantwortet sind; ein Klick gibt die Antworten **strukturiert** (`[{ id, answer }]`) zurück und **setzt den unterbrochenen Lauf fort** (Resume). *(4,5)*
- **AC5** — Nach Resume liefert der Status-Endpunkt entweder den **nächsten** `needs-answers`-Katalog (→ erneut Overlay) oder `done`. Bei `done` schließt das Overlay mit Erfolgsmeldung und löst ein **Board-/`docs/`-Re-Fetch** aus (neue Story/Specs erscheinen). *(5,6)*
- **AC6** — **Security-Floor (hart):** Der headless-Pfad nutzt den tool-fähigen `HeadlessFlowRunner` (argv-Array, kein Shell-String; harter `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block; `--dangerously-skip-permissions` bleibt ausschließlich im getrennten headless-Pfad), liegt hinter dem AccessGuard und ist **auditiert** (Job-Start/-Ende/-Fehler, Identität + Aktion, ohne Klartext-Secret); Antwort-Text geht via **stdin/argv-Array**, nie als roher Shell-String; keine Secrets/Token/Host-Pfade in Log/Audit/Response/WS. Eigenes, getrenntes `ProjectJobLock`. *(1,5)*
- **AC7** — **Fehler-/Randpfade:** `claude -p`-/Runner-Fehler oder nicht-parsbarer Katalog → klarer, secret-freier Fehler **inline**, Overlay bleibt nutzbar (Retry). Schließen/`Esc`/Backdrop reagieren **immer** (kein blockierender Guard); ein gestarteter headless Lauf wird durch Schließen **nicht** abgebrochen (detached). Pflicht-Frage unbeantwortet → „Antworten senden" deaktiviert. *(7)*

## Verträge
> Endpunkt-Basis/Feldnamen sind **an das agent-flow-Rückgabeformat (PR #217) gekoppelt** und bis zu dessen Merge als **Annahme** zu behandeln (A1). Die dev-gui-Boundaries (Runner-Instanz, Job-/Session-Registry, Status-Endpunkt-Muster) sind aus [[idea-specify-chat]]/[[new-story-chat]]/[[headless-reconcile-runner]] **wiederverwendet**, nicht neu erfunden.

- **`POST …/obsidian-ingest/start`** `{ projectFolderPath }` → `202 { jobId, status: 'running' }` | `409` (Projekt-Lock belegt) | `400`/`404`. Startet den headless from-notes-Lauf (eigene Runner-/Lock-Instanz). `projectFolderPath` wird **vault-confined** validiert (Wiederverwendung, kein neuer Confinement-Mechanismus): der konfigurierte Obsidian-Vault-Pfad wird gelesen und `listObsidianVaultProjects()` ([[obsidian-vault-config]] AC5) liefert die aktuell gültigen `<vault>/Projekte`-Unterordner (bereits realpath-/Symlink-sicher confined); der eingereichte Pfad muss nach `realpath`-Auflösung exakt einem gelisteten Eintrag entsprechen — kein Freitext-Pfad gelangt ungeprüft in cwd/argv (analog dem PTY-Trigger `/agent-flow:from-notes`, [[obsidian-project-intake]] AC4). Kein Vault konfiguriert oder „Projekte" (mehr) nicht erreichbar → `404`.
- **`GET …/obsidian-ingest/:jobId`** → `200 { status: 'running'|'needs-answers'|'done'|'failed'|'auth-expired', catalog?: Array<{ stage, id, frage, quelle, optionen?, pflicht? }>, result?, error? }` | `404`. Format-Muster 1:1 wie der headless-Reconcile-/Idee-Specify-Status-Endpunkt; `catalog` nur bei `needs-answers`. Secret-frei. `pflicht?` (optionaler Bool je Frage, **Default `true`**) markiert Pflicht- vs. optionale Fragen: eine Frage gilt als Pflicht, außer der Katalog liefert ausdrücklich `pflicht: false` **oder** `optional: true` — Grundlage der server-seitigen `answers`-Validierung (AC4).
- **`POST …/obsidian-ingest/:jobId/answers`** `{ answers: Array<{ id, answer }> }` → `202 { status: 'running' }` | `400` (Pflicht-Frage fehlt / unbekannte `id`) | `404`/`409`. Reicht die gebündelten Antworten in den laufenden/unterbrochenen Lauf zurück (Resume).
- **Chat-/Runner-Boundary:** eigene, schmale Service-Boundary mit **injizierbarem** Claude-/Runner-Adapter (testbar ohne echten `claude`-Lauf); In-Memory-Job-Registry (Verlust bei Neustart = Nicht-Ziel, wie bestehende Runner).
- **Cross-Repo (SR3):** Der Fragenkatalog + das Resume-Protokoll sind der **Vertrag mit agent-flow** (`obsidian-ingest-subsystem.md`, PR #217, Felder `stage/id/frage/quelle/optionen`); dev-gui rendert/sammelt nur, erfindet **keine** Ingest-Logik.

## Edge-Cases & Fehlerverhalten
- Pipeline läuft in einem Rutsch durch (nie `needs-answers`) → kein Overlay, direkt `done` + Re-Fetch (Deckungsgleich zum Happy-Path von [[obsidian-project-intake]], nur headless statt PTY).
- Katalog ohne `optionen` → Freitext-Antwortfelder.
- Katalog mit ausschließlich optionalen Fragen → „Antworten senden" sofort aktiv.
- Nicht-parsbarer/kaputter Katalog-Ausgang → `502`/Fehlerzustand, secret-frei, Retry.
- Server-Neustart während Lauf → In-Memory-Job/-Session verloren (Nicht-Ziel); ein laufender `claude -p`-Subprozess wird ggf. verwaist (Timeout/OS bereinigt).
- Parallel-Start fürs selbe Projekt → eigenes `ProjectJobLock` verhindert Doppel-Läufe (`409`), ohne andere Pfade zu berühren. Das Lock wird bei `start()` erworben und erst bei einem **terminalen** Zustand (`done`/`failed`/`auth-expired`) freigegeben — während `running` UND während des pausierten `needs-answers`-Zustands (offener, noch nicht beantworteter Katalog) bleibt es gehalten (ein zweiter Start fürs selbe Projekt → `409`, bis der Lauf terminal wird oder der Server neu startet).
- `answers` mit unbekannter `id` / fehlender Pflicht-`id` → `400`, kein Resume.

## NFRs
- **Sicherheit (Floor):** headless-Pfad wie [[idea-specify-chat]] NFR — tool-fähiger `HeadlessFlowRunner` (argv-Array, kein Shell-String; harter API-Key-Block), auditiert, eigenes getrenntes `ProjectJobLock`, keine Secrets/Token/Host-Pfade in Log/Audit/Response/WS.
- **A11y:** Overlay-Fokusführung (Öffnen/Schließen/Fehler), `Esc`, Fokus-Rückgabe; Fragen/Stufen semantisch/typografisch unterscheidbar (nicht nur Farbe); Pflicht-/Fehler-Status programmatisch zugeordnet.
- **Token-Sparsamkeit:** der Ingest-Lauf läuft headless; das Overlay ist reines Sammeln/Anzeigen — kein zusätzlicher `claude -p`-Aufruf je Fragen-Render.
- **Entkopplung:** UI baubar/testbar mit gemocktem Status-/Answers-Endpunkt; kein dev-gui-Test hängt von einem realen agent-flow-Lauf ab.

## Nicht-Ziele
- Die **Ingest-Logik** (Widerspruchserkennung, Katalog-Erzeugung, 3 Stufen) — liegt in agent-flow (`obsidian-ingest-subsystem.md`, PR #217).
- **Persistente** Chat-/Job-/Katalog-Historie (In-Memory, Verlust bei Neustart).
- **Kein** neuer Kindprozess-/Env-/Lock-Mechanismus (wiederverwendet dieselben `HeadlessRunnerCore`-Primitive — argv-Array, `buildChildEnv()`-API-Key-Block, `ProjectJobLock` — wie `HeadlessFlowRunner`/`HeadlessReconcileRunner`), **kein** neues Spec-Format-Wissen in dev-gui (Board/Specs legt der Fabrik-Agent an). Die konkrete `HeadlessFlowRunner`-Klasse selbst ist fire-and-forget bis `done`/`failed`/`auth-expired` und bietet keine Interrupt/Resume-Naht — die in AC1/AC2/AC4/AC5 geforderte `needs-answers`/`--resume`-state-machine ist daher der **einzige** neue Baustein (`ObsidianIngestRunner`, dünne Schwester-Boundary analog `StorySpecifyFinalizer`/`IdeaSpecifyFinalizer`, gleiche Sicherheits-/Audit-Disziplin).
- Der **Terminal-Handoff-Happy-Path** (rein PTY, ohne strukturierten Katalog) bleibt in [[obsidian-project-intake]]; diese Spec ist die richere, headless Variante.
- Die **Sync-Widerspruchsanzeige** ([[obsidian-sync-trigger]]) — eigener Trigger/eigene Anzeige.

## Abhängigkeiten
- [[obsidian-project-intake]] (löst den Ingest aus; diese Spec ist die richere Fragenkatalog-Variante). **Depends-on.**
- [[idea-specify-chat]] / [[new-story-chat]] (Overlay-/Chat-Muster, headless `HeadlessFlowRunner`-Finalizer, `ProjectJobLock`-Trennung, Status-Endpunkt-Muster — Wiederverwendung).
- [[headless-reconcile-runner]] / [[headless-parallel-drain]] (`HeadlessFlowRunner`/Job-Registry-/Status-Muster).
- [[access-and-guardrails]] (AccessGuard, Audit-First).
- **agent-flow** `docs/architecture/obsidian-ingest-subsystem.md` (PR #217, SR3) — liefert Fragenkatalog-Format (`stage/id/frage/quelle/optionen`) + Resume-Einstieg mit gesammelten Antworten.

## Offene Annahmen (mangels Rückfrage-Möglichkeit als Subagent gesetzt — vom Owner bestätigbar)
- **A1 (agent-flow-Vertrag, PR #217 noch in Review):** Feldnamen (`stage/id/frage/quelle/optionen`), der Interrupt-Zustand (`needs-answers`) **und** ein **Resume-Einstieg**, der gesammelte Antworten (`[{id, answer}]`) annimmt und die unterbrochene Stufe fortsetzt, existieren als maschinenlesbarer Vertrag. Steht #217 anders zur Verfügung (z.B. reiner Terminal-Text ohne strukturierten Resume-Einstieg), reduziert sich diese Capability auf den Terminal-Handoff aus [[obsidian-project-intake]]; die Endpunkt-/Feld-Details hier werden dann beim Merge nachgezogen (lose Kopplung, Drift bewusst gatet).
- **A2 (Ausführungsmodell headless):** Anders als der PTY-Trigger in [[obsidian-project-intake]] setzt der strukturierte Katalog einen **headless** Lauf voraus (strukturierter Rückkanal statt Terminal-Stream), analog ADR-016/ADR-017. Bevorzugt der Owner strikt den interaktiven PTY-Pfad, entfällt diese Spec zugunsten des Terminal-Handoffs.
