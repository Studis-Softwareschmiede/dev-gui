---
id: regression-define-dialog
title: Regressionstest definieren — Redaktionsschleife (headless Definier-Runner + editierbares Vorschlags-Overlay)
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Regressionstest definieren — Redaktionsschleife  (`regression-define-dialog`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).
>
> **Cross-Repo-Bindung (textuell):** die eigentliche **Definier-Logik** (Spec-Lesen → NL-Vorschlag → Übersetzung in Playwright-Testdatei + Datentabelle) liegt **ausschließlich** in agent-flow (Spec `regression-define`, Agent `agents/regression-define.md`, maschinenlesbares Rückgabeformat). dev-gui **entwirft sie nicht neu**, sondern koppelt lose an deren Rückgabeformat und stellt die **Redaktionsschleife** (Owner redigiert den NL-Vorschlag) samt headless-Ausführung bereit — analog zum Obsidian-Ingest-Muster ([[obsidian-question-catalog]]).

## Zweck
Der Owner definiert eine Regressionstest-Suite für einen Bereich (oder einen Verbund) **ohne Handarbeit am Testcode**: ein Dialog wählt das Ziel, ein **headless Definitions-Lauf** erzeugt einen natürlichsprachlichen Vorschlag (Schritte, Prüfpunkte, Beispieldaten), der Owner **redigiert den Text direkt im Dialog**, und die **bestätigte** Fassung geht per Resume an denselben Agenten zur Übersetzung in Testdatei + Datentabelle. Ein Job, Zustand `needs-review`, Antwort via STDIN-Resume — kein neuer Lauf, kein zweiter Codepfad.

## Kontext / Designnuancen (bindend)
- **Eigener Headless-Runner-Boundary** (`RegressionDefineRunner`) mit **eigener** `ProjectJobLock`-Instanz — bewusst getrennt von ALLEN bestehenden headless-Locks (Nacht-Drain / manueller Drain / Reconcile-Runner / `IdeaSpecifyFinalizer` / Auto-Retro / `ObsidianIngestRunner`), Muster der bestehenden Runner (`HeadlessRunnerCore.js`-Primitive: Env-Allowlist, `CLAUDE_CODE_OAUTH_TOKEN`, harter `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block, argv-Array, Audit-First). ADR-016-Linie (`claude -p` projektweit erlaubt).
- **State-Machine wie Obsidian-Ingest** ([[obsidian-question-catalog]], `ObsidianIngestRunner`): EIN Lauf je Runde endet in `done` **oder** dem Interrupt-Zustand `needs-review` (der NL-Vorschlag). Das Lock bleibt **während** `needs-review` gehalten (kein Doppel-Lauf) und wird erst bei einem terminalen Zustand (`done`/`failed`) freigegeben.
- **Resume via STDIN, nie argv:** die redigierte, bestätigte Fassung wird gebündelt **via STDIN** (`--resume <session-id>`) in denselben `claude`-Session-Kontext zurückgereicht — Resume, kein neuer Lauf.
- **Bereichs-Auswahl aus `board/areas.yaml`** plus Option „Verbund…" mit freiem Namensfeld (Infra-/Verbund-Suite). Bereichs-`id` bzw. Verbund-Name werden als Eingabe-Vertrag an den Agenten durchgereicht (agent-flow `regression-define` AC1).
- **Editierbares Textfeld, Muster Fragenkatalog-Overlay:** der Owner redigiert den NL-Vorschlag direkt im Overlay (kein Sprung in einen externen Editor), analog `ObsidianIngestOverlay.jsx`.

## Main Success Scenario
1. Owner klickt „Regressionstest definieren" ([[regression-panel]]) → Dialog öffnet.
2. Dialog zeigt eine Bereichs-Auswahl aus `board/areas.yaml` (Bereichs-`id` + Name) plus die Option „Verbund…" mit Namensfeld; optional Owner-Stichworte.
3. Bestätigen → `RegressionDefineRunner` startet einen headless `claude -p`-Definitions-Lauf (agent-flow `regression-define`) für das gewählte Ziel; Zustand `running`.
4. Der Lauf endet in `needs-review` und liefert den **natürlichsprachlichen Vorschlag** (Schritte, Prüfpunkte, Beispieldaten) im maschinenlesbaren Rückgabeformat.
5. Das Overlay zeigt den Vorschlag in einem **editierbaren Textfeld**; der Owner redigiert ihn direkt.
6. Owner bestätigt die Fassung → die redigierte Fassung wird via **STDIN-Resume** an denselben Job/dieselbe Session zurückgereicht.
7. Der Agent übersetzt die bestätigte Fassung in Playwright-Testdatei + Datentabelle + Begleitbeschreibung (agent-flow `regression-define` AC4/AC5, Auslieferung als PR/Commit); der Job endet `done`, das Lock wird freigegeben, das Overlay meldet Abschluss.

## Alternative Flows
- **A1 — Verbund statt Bereich:** Auswahl „Verbund…" + Name → das Ziel wird als Verbund an den Agenten übergeben; die erzeugte Begleitbeschreibung trägt `target: ephemeral-infra` + Kosten-/Ressourcen-Deklaration (agent-flow `regression-define` AC6).
- **E1 — Projektwechsel während `needs-review`:** wechselt die Projekt-Auswahl auf ein anderes Projekt, wird der gemerkte Wiedereinstiegs-Job (`{jobId, ziel}`) verworfen (kein stilles Resume des falschen Jobs) — analog Obsidian-Ingest.
- **E2 — Bereich ohne deckende Specs:** der Agent meldet „keine deckenden Specs im Bereich"; das Overlay zeigt die Meldung statt eines leeren/erfundenen Vorschlags, Job endet ohne Artefakt.

## Acceptance-Kriterien

### Headless-Runner-Boundary (Backend)
- **AC1** — `RegressionDefineRunner` ist ein eigener headless-Boundary mit **eigener** `ProjectJobLock`-Instanz (getrennt von allen anderen headless-Locks, Grep-prüfbar) und nutzt die `HeadlessRunnerCore`-Primitive (Env-Allowlist, `CLAUDE_CODE_OAUTH_TOKEN`, harter `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block, argv-Array, kein globaler PTY-Lock, kein API-Key).
- **AC2** — Ein Definitions-Lauf endet je Runde in **genau einem** von zwei Zuständen: `done` (terminal) **oder** `needs-review` (Interrupt mit NL-Vorschlag). Während `needs-review` bleibt das Lock **gehalten**; es wird erst bei `done`/`failed` freigegeben (kein Doppel-Lauf).
- **AC3** — Die bestätigte, redigierte Fassung wird **via STDIN** (`--resume <session-id>`) in denselben Session-Kontext zurückgereicht — **nie** über argv; es entsteht **kein** neuer Lauf. Der Job wird über einen `jobId` adressiert.
- **AC4** — Eingabe-Vertrag an den Agenten: **Projekt** + **Bereichs-`id`** (aus `board/areas.yaml`) **oder Verbund-Name** + optionale Stichworte (agent-flow `regression-define` AC1). Die Bereichsliste wird aus `board/areas.yaml` gelesen (read-only).
- **AC5** — Per-Lauf-**Audit** (Start/Interrupt/Resume/Ende/Fehler), secret-frei (nur sanitisiertes Projekt/Ziel, **kein** Host-Pfad/Token). Keine Secrets in Response/Log/WS/Audit.

### Redaktions-Dialog & Overlay (Frontend)
- **AC6** — Der Definier-Dialog zeigt eine Bereichs-Auswahl aus `board/areas.yaml` (Bereichs-`id` + Name) **plus** die Option „Verbund…" mit freiem Namensfeld; optionales Stichwort-Feld. Bestätigen startet den Definitions-Lauf über `RegressionDefineRunner`.
- **AC7** — Bei `needs-review` zeigt das Overlay den NL-Vorschlag (Schritte, Prüfpunkte, Beispieldaten) in einem **editierbaren Textfeld** (Muster `ObsidianIngestOverlay.jsx`); der Owner redigiert direkt im Dialog. Bestätigen reicht die redigierte Fassung zum Resume (AC3) und pollt bis `done`/Fehler.
- **AC8** — Der gemerkte Wiedereinstiegs-Job wird verworfen, sobald die Projekt-Auswahl auf ein anderes Projekt wechselt (E1); ein Bereich-ohne-Specs-Fall (E2) und `failed` werden als klare Meldung angezeigt (kein leeres Overlay).

## Verträge
- **Runner-Endpunkte (Muster Obsidian-Ingest):**
  - `POST /api/projects/:slug/regression-define` — Body `{ ziel: { typ: "bereich"|"verbund", id: <bereich-id|verbund-name> }, stichworte?: [] }` → `{ jobId, status: "running" }`.
  - `GET /api/projects/:slug/regression-define/:jobId` → `{ status: "running"|"needs-review"|"done"|"failed", vorschlag?, sessionId?, reason? }`.
  - `POST /api/projects/:slug/regression-define/:jobId/review` — redigierte Fassung **via STDIN-Resume** (Body enthält die redigierte Struktur; Weitergabe an den Kindprozess ausschließlich über STDIN) → `{ status }`.
- **Rückgabeformat NL-Vorschlag:** lose gekoppelt an agent-flow `regression-define` (`{ projekt, ziel, quell_specs, vorschlag:[{titel,schritte,pruefpunkte,beispieldaten}], target_vorschlag }`).
- Alle mutierenden Endpunkte hinter AccessGuard, identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`-Linie), Audit-First.

## Edge-Cases & Fehlerverhalten
- `board/areas.yaml` fehlt/leer → Dialog bietet nur „Verbund…" (Bereichs-Auswahl leer), kein Crash.
- Kindprozess-Timeout/Absturz während `running`/`needs-review` → Job `failed`, Lock freigegeben, Overlay meldet Fehler; kein hängendes Lock.
- Doppelter Start-Klick → durch das `ProjectJobLock` serialisiert (kein zweiter paralleler Definitions-Lauf desselben Projekts).
- Redigierte Fassung entfernt alle Beispieldaten → an den Agenten durchgereicht (nicht-datengetriebener Test, agent-flow `regression-define` Edge-Case), kein dev-gui-Fehler.

## NFRs
- **Sicherheit (Floor, hart):** kein API-Key, kein globaler PTY-Lock, kein Secret in Response/Log/WS/Audit/argv; Resume-Nutzlast nur via STDIN. Hinter Access + rollengeschützt + Audit-First.
- **Isolation:** eigene `ProjectJobLock`-Instanz (Fremd-/Selbstblockade-Vermeidung).

## Nicht-Ziele
- Die Definier-/Übersetzungs-Logik selbst (agent-flow `regression-define`) — hier nur Orchestrierung + Redaktionsschleife.
- Testausführung ([[regression-run]]) und Ergebnis-Ablage/Ansicht ([[regression-result-store]]/[[regression-result-view]]).
- Reparatur roter Läufe (agent-flow `regression-heal`).

## Abhängigkeiten
- agent-flow `regression-define` (Definier-Agent + maschinenlesbares Rückgabeformat) — **lose gekoppelte Cross-Repo-Abhängigkeit**; der headless-Einstieg (Slash-Command/Agent-Aufruf) muss in agent-flow verdrahtet sein (analog Obsidian/PR #217). **Offen/eskaliert:** in agent-flow existiert (Stand Anlage) noch **kein** Slash-Command für die Definier-Rolle — diese Spec ist bewusst dependency-gatet entworfen.
- agent-flow `regression-playwright-conventions` (Ziel-Layout der Übersetzung) · agent-flow `regression-runner` (`target:`-Header).
- [[obsidian-question-catalog]] — wiederverwendetes Interrupt/Resume-Muster (`HeadlessRunnerCore`, `ObsidianIngestOverlay.jsx`).
- [[regression-panel]] — Einstieg (Klick „Regressionstest definieren").
