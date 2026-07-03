---
id: story-idee-bereich-zuordnung
title: Bereichs-Zuordnung im Story-/Idee-Dialog — Dropdown über dem Titel, Vorbelegung, Inline-Neuanlage
status: active
area: board
version: 1
---

# Spec: Bereichs-Zuordnung im Story-/Idee-Dialog  (`story-idee-bereich-zuordnung`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Wer eine **Idee** ([[ideen-inbox]], `IdeaCaptureModal`) oder eine **neue Story** ([[new-story-chat]], „Neue Story"-Scratch-Start des `IdeaSpecifyChatModal`) erfasst, ordnet sie **sofort einem Bereich** zu. Ein **Bereichs-Dropdown oberhalb des Titelfelds** in **beiden** Dialogen ist mit dem **Bereich der aktuell geöffneten Kachel/Ansicht** vorbelegt, listet alle Bereiche aus `board/areas.yaml` ([[bereichs-modell]]) und erlaubt eine **Inline-Neuanlage** eines Bereichs (schreibt `areas.yaml` über den bestehenden „Bereiche verwalten"-Pfad). So landet jedes neue Item von Anfang an unter dem richtigen Bereichs-Feature (der dauerhaften Kachel).

## Verhalten

### V1 — Bereichs-Dropdown oberhalb des Titelfelds (beide Dialoge)
Sowohl das **Idee-Erfassungs-Modal** (`IdeaCaptureModal`, Titel + Stichwort-Body) als auch das **„Neue Story"-Start-Feld** (`IdeaSpecifyChatModal` „scratch"-Modus, Titel + Stichwort-Body) erhalten **über dem Titelfeld** ein **Bereichs-Dropdown**. Es listet alle Bereiche aus `GET …/areas` ([[bereichs-modell]] V6), sortiert nach `order`, mit `name` als Label und `id` als Wert. Der Dialog ist ohne Bereichsauswahl absendbar nur, wenn mindestens ein Default gesetzt werden kann (V2); ist **kein** Bereich vorhanden (leere `areas.yaml`), zeigt das Dropdown einen Hinweis + bietet die Inline-Neuanlage (V3).

### V2 — Vorbelegung mit dem Bereich der aktuell geöffneten Kachel/Ansicht
Öffnet der Owner den Dialog aus dem Kontext eines geöffneten **Bereichs-Features/einer Bereichs-Kachel** (bzw. mit einem aktiven Bereichs-Filter), ist das Dropdown mit **genau diesem Bereich** vorbelegt. Fehlt ein solcher Kontext (z.B. Öffnen aus einer bereichsübergreifenden Ansicht), wird der **erste Bereich nach `order`** vorbelegt; ist gar kein Bereich vorhanden, bleibt das Feld leer und erzwingt die Inline-Neuanlage (V3) vor dem Speichern.

### V3 — Inline-Neuanlage eines Bereichs
Das Dropdown bietet einen Eintrag/Button **„Neuer Bereich…"**. Ein Klick öffnet ein kleines Inline-Feld (Name); Bestätigen ruft **denselben** Anlege-Pfad wie „Bereiche verwalten" auf (`POST /api/board/projects/:slug/areas`, [[bereichs-modell]] V3/AC3 — **kein** zweiter Schreibpfad). Nach `201 { id }` wird die Bereichsliste neu geladen, der neue Bereich **automatisch ausgewählt** und der Fokus zurück ins Formular gesetzt. Validierungs-/Duplikat-/Lock-Fehler (`400`/`409`) erscheinen inline, ohne den Dialog zu zerstören.

### V4 — Persistenz der Bereichszuordnung bei der Item-Anlage
Beim Speichern trägt das neu angelegte Item die gewählte Bereichszuordnung:
- **Idee** (`POST …/ideas`, [[ideen-inbox]] AC3): der Create-Pfad des `BoardWriter` schreibt zusätzlich das additiv-optionale Feld `area: <area-id>` in die neue Story-YAML.
- **Neue Story** (`POST …/story-specify/start`, [[new-story-chat]] AC2): die gewählte `area-id` wird an den Start-Endpunkt mitgegeben und über den `buildRequirementPrompt`-Hinweis an den headless `requirement`-Lauf durchgereicht (**best effort**: „Ordne die anzulegende Story/das Feature dem Bereich `<area-id>` zu"), sodass der `requirement`-Agent Feature/Story mit `area: <area-id>` anlegt. dev-gui erzwingt hier **keine** eigene Nachbearbeitung des Agenten-Outputs.

### V5 — Konsistenz & Fehlerpfade
Ist das gewählte Bereichs-Dropdown leer/ungültig (nur möglich bei leerer `areas.yaml` ohne Inline-Neuanlage), ist „Speichern"/„Story anlegen" deaktiviert bzw. wird abgelehnt (`400 { field: 'area' }`). Die bestehende Titel-/Body-Validierung ([[ideen-inbox]] AC3, [[new-story-chat]] AC2) bleibt unverändert gültig. Kein neuer Schreibpfad jenseits `BoardWriter` (Idee) bzw. des bestehenden `story-specify/start` (Neue Story) + `AreaWriter` (Inline-Neuanlage).

## Acceptance-Kriterien

- **AC1** — Beide Dialoge (`IdeaCaptureModal` **und** `IdeaSpecifyChatModal` „scratch"-Start) zeigen **oberhalb des Titelfelds** ein Bereichs-Dropdown, das alle Bereiche aus `GET …/areas` sortiert nach `order` (Label `name`, Wert `id`) listet. *(V1)*
- **AC2** — Das Dropdown ist mit dem Bereich der **aktuell geöffneten Kachel/Ansicht** vorbelegt; fehlt ein Bereichskontext, ist der **erste Bereich nach `order`** vorbelegt; ist gar kein Bereich vorhanden, bleibt es leer und erzwingt die Inline-Neuanlage vor dem Speichern. *(V2)*
- **AC3** — Ein „Neuer Bereich…"-Eintrag/Button legt über **denselben** Anlege-Pfad wie „Bereiche verwalten" (`POST …/areas`, kein zweiter Schreibpfad) einen Bereich an; nach `201` wird die Liste neu geladen, der neue Bereich automatisch ausgewählt, der Fokus zurückgesetzt; `400`/`409` erscheinen inline ohne Dialog-Verlust. *(V3)*
- **AC4** — Beim Speichern einer **Idee** schreibt der `BoardWriter`-Create-Pfad zusätzlich `area: <area-id>` in die neue Story-YAML (additiv-optional, byte-schonend/atomar wie der bestehende Create-Pfad); alle übrigen Felder/Verhalten aus [[ideen-inbox]] AC3 bleiben unverändert. *(V4)*
- **AC5** — Beim Start einer **Neuen Story** wird die gewählte `area-id` an `POST …/story-specify/start` übergeben und über den Requirement-Prompt-Hinweis best-effort an den headless `requirement`-Lauf durchgereicht (Ziel: Feature/Story mit `area: <area-id>`); dev-gui bearbeitet den Agenten-Output **nicht** nach. Fehlt/ungültig die Bereichsauswahl (leere `areas.yaml` ohne Neuanlage), ist „Story anlegen"/„Speichern" deaktiviert bzw. wird mit `400 { field: 'area' }` abgelehnt. *(V4, V5)*
- **AC6** — A11y/Sicherheit: das Dropdown ist ein beschriftetes, per Tastatur bedienbares `select`/Combobox-Element mit sprechendem `aria-label`; Fehler programmatisch zugeordnet; kein neuer Schreibpfad jenseits `BoardWriter`/`story-specify/start`/`AreaWriter`; keine Secrets in Ausgabe/Log; `area-id` sanitisiert (kein Traversal). *(V1–V5)*

## Verträge

- **`GET /api/board/projects/:slug/areas`** (aus [[bereichs-modell]]) — Bereichsliste für das Dropdown.
- **`POST /api/board/projects/:slug/areas`** (aus [[bereichs-modell]]) — Inline-Neuanlage (kein neuer Endpunkt).
- **`POST /api/board/projects/:slug/ideas`** `{ title, body?, area? }` (erweitert [[ideen-inbox]] AC3 um optionales `area`) → `201 { storyId }`; bei gesetztem `area` trägt die neue Story `area: <area-id>`. `400 { field: 'area', message }` bei unbekanntem Bereich.
- **`POST /api/board/projects/:slug/story-specify/start`** `{ initialText, area? }` (erweitert [[new-story-chat]] AC2 um optionales `area`) → `201 { sessionId, reply }`; `area` fließt in den Requirement-Prompt-Hinweis (V4). `400 { field: 'area' }` bei unbekanntem Bereich.
- **Story-YAML-Feld (additiv, optional):** `area: <area-id>`. Fehlt es, gilt das Item als (noch) keinem Bereich zugeordnet (verwaist → Standard-/`_orphaned`-Behandlung wie bisher).

## Edge-Cases & Fehlerverhalten
- **Leere `areas.yaml`** → Dropdown zeigt Hinweis + zwingt zur Inline-Neuanlage vor dem Speichern; Speichern ohne Bereich abgelehnt (`400 { field: 'area' }`).
- **Inline-Neuanlage mit Duplikat-Name** → `400` inline, Dialog bleibt offen; bestehende Auswahl unverändert.
- **`ProjectJobLock` belegt bei Inline-Neuanlage** → `409` inline, Owner kann später erneut versuchen; die Item-Anlage selbst ist davon unberührt (separater Klick).
- **Unbekannte/ungültige `area-id` beim Speichern** → `400 { field: 'area' }`, keine Item-Anlage.
- **Neue Story: Agent ignoriert den Bereichs-Hinweis** → best-effort akzeptiert (kein Garant, konsistent mit [[idea-specify-chat]]-Restrisiko); die Story kann später über „Bereiche verwalten"/manuell umgehängt werden.

## NFRs
- **Sicherheit (Floor):** kein neuer Schreibpfad jenseits der bestehenden (`BoardWriter`-Create, `story-specify/start`, `AreaWriter`); `area-id` sanitisiert (kein Traversal, keine Steuerzeichen); keine Secrets in Log/Audit/Response.
- **A11y:** Dropdown beschriftet + tastaturbedienbar; Vorbelegung sichtbar; Fehler programmatisch zugeordnet; Status nie nur über Farbe.

## Nicht-Ziele
- **Umhängen bestehender** Storys/Ideen zwischen Bereichen (Migration [[bereichs-migration-dev-gui]] bzw. mögliches Folge-Feature).
- **Neu-Definition** des `area`-Felds (agent-flow-Schema; hier nur Nutzung).
- **Nachbearbeitung des `requirement`-Agenten-Outputs** durch dev-gui (best-effort-Durchreichung, kein Garant).

## Abhängigkeiten
- [[bereichs-modell]] (`GET …/areas`, `POST …/areas`, `AreaWriter`) · [[ideen-inbox]] (`IdeaCaptureModal`, `BoardWriter`-Create-Pfad) · [[new-story-chat]] / [[idea-specify-chat]] (`IdeaSpecifyChatModal` „scratch"-Start, `story-specify/start`, `buildRequirementPrompt`) · [[studis-kanban-board-ux]] (Board-/Kachel-Kontext für die Vorbelegung).
- **dev-gui:** `client/src/IdeaCaptureModal.jsx`, `client/src/IdeaSpecifyChatModal.jsx`, `client/src/BoardView.jsx` (Kontext für Vorbelegung), `src/BoardWriter.js` (Create-Pfad um `area` erweitert), `src/boardRouter.js`/`ideaSpecifyRouter` (optionales `area` durchreichen).
- **agent-flow (textueller Verweis, kein depends):** Schema-Specs zum `area`-Feld auf Storys/Features (Repo agent-flow).
