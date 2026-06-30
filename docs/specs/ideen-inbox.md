---
id: ideen-inbox
title: Ideen-Inbox / Status „Idee" — Quick-Capture + interaktive Besprechung zur Anforderung
status: active
version: 2
---

# Spec: Ideen-Inbox / Status „Idee"  (`ideen-inbox`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Eine **Ideen-Inbox** lässt den Owner eine vage Idee in **Sekunden** ins Board werfen — ein Einzeiler genügt, ohne saubere Anforderung, ohne Spec, ohne Acceptance-Kriterien. Solche Items leben im neuen, ganz links einsortierten Status **`Idee`** und werden von der Fabrik **nie autonom** angefasst. Das **Aufgreifen** einer Idee ist **kein** Ein-Klick-Automatismus auf den rohen Text, sondern eine **interaktive Besprechung**: ein Klick auf die Idee-Karte öffnet ein Dialogfenster, das eine **interaktive Gesprächs-Session** mit derselben PTY-Engine wie das „Arbeiten"-Terminal startet. Die Stichworte der Idee sind als Gesprächs-Einstieg vorgeladen; Owner und Claude **schärfen die Anforderung gemeinsam** (Hin und Her). Der `requirement`-Flow läuft erst als **Abschluss/Formalisierung** des Besprochenen — nicht als Startschuss auf den unbearbeiteten Text. So entsteht ein **Front-of-Funnel** vor `To Do`, ohne das Drain-/Ready-Modell zu unterlaufen.

## Verhalten

### Status „Idee" (Spalte ganz links)
1. **`Idee`** ist ein **kanonischer Story-Status**, einsortiert **GANZ LINKS** vor `To Do`. Die Status-Lebenszyklus-Reihenfolge ist damit: `Idee → To Do → In Progress → Blocked → In Review → Done`. Das Board rendert eine **„Idee"-Spalte** links von „To Do"; der Status-Filter führt `Idee` (Default ausgewählt); `BoardAggregator` kennt den Status in Index/Rollup.
2. **Idee-Items sind per Definition NIE `ready`.** Die maßgebliche ready-Regel (`BoardAggregator.computeStoryReadyStatus`, `src/BoardAggregator.js`) liefert für jeden Status ≠ `To Do` bereits `ready=false, ready_reason=null` — ein `Idee`-Item hat zudem **keine** aktive Spec und **keine** `implements`. Daraus folgt verbindlich: ein `Idee`-Item ist ein **Nicht-Drain-Ziel** des Taktgebers ([[taktgeber-nachtwaechter]] AC3) und wird **nie autonom** abgearbeitet, eskaliert oder verändert. Idee-Karten zeigen **kein** ready-Badge.

### Erfassen — Quick-Capture (Idee in Sekunden reinwerfen)
3. Die **„Arbeiten"-Seite** (`client`) trägt einen sichtbaren Button **„Idee"**. Ein Klick öffnet ein **kleines Fenster (Modal)** mit einem Eingabefeld für freie Stichwort-Notizen: ein **Einzeiler-Titel** (Pflicht) + ein **optionaler mehrzeiliger Stichwort-Body**. Bewusst minimal — **kein** Spec-/AC-Zwang, kein Pflichtfeld außer dem nicht-leeren Titel.
4. **Speichern** erzeugt **ein** Board-Item mit `status: Idee`, dem Titel und — falls vorhanden — dem Stichwort-Body (als `notes`), **OHNE** `spec`, **OHNE** `implements`/AC. Das Item wird über die schmale Board-Schreib-Boundary **`BoardWriter`** (Create-Pfad) als `board/stories/<id>.yaml` angelegt; die nächste Story-ID wird **atomar** aus `board/board.yaml` (`next_story_id`) allokiert + hochgezählt. `BoardAggregator` bleibt read-only. Die Anlage ist **token-frei** — **kein** Agent.
5. Nach erfolgreichem Anlegen erscheint die Idee **sofort** als Karte in der „Idee"-Spalte (ganz links; Re-Fetch/Rescan des Boards).

### Aufgreifen — interaktive Besprechung (ersetzt die alte Ein-Klick-Automatik)
6. Ein **Klick auf eine Idee-Karte** öffnet ein **Dialogfenster**, das eine **interaktive Besprechungs-Session** startet — ein **dialogisches Gespräch** zwischen Owner und der interaktiven Claude-Session, **NICHT** ein headless one-shot. Es ist **dieselbe interaktive PTY-Engine wie das „Arbeiten"-Terminal**: `CommandService` + die projektgebundene **PTY-Session** (`PtySessionRegistry`), reiner PTY-Pfad — **kein** `claude -p` (konsistent mit `.claude/CLAUDE.md`: der interaktive Flow-/Intake-Pfad bleibt rein PTY). Das GUI wechselt dabei in den **Terminal-Pane** des Projekts.
7. Die **Stichworte der Idee** (Titel + optionaler Body) werden als **Gesprächs-Einstieg/Kontext** in diese Session **vorgeladen** — als **konversationelle** Eröffnungs-Eingabe in die laufende interaktive Session (gleicher Pfad, über den der Owner im Terminal frei tippt), **nicht** als allowlist-gegateter Slash-Befehl und **nicht** als one-shot auf den rohen Text. Der Seed ist sanitisiert (Stichworte zu einer konversationellen Eingabe gebündelt; keine geschmuggelten Steuerzeichen / keine zweite Submit-Zeile).
8. In diesem Dialog **schärfen Owner und Claude die Anforderung gemeinsam** (Hin und Her, Lücken klären). Der **`requirement`-Flow** läuft als **Teil/Abschluss** dieses Gesprächs — als **Formalisierung des Besprochenen**: der Owner stößt `/agent-flow:requirement` (optional mit einer geschärften Zusammenfassung als Argument) über den **bestehenden** `POST /api/command` (CommandService) an — der Agent hat den Gesprächs-Kontext der Session. `/agent-flow:requirement` steht **bereits** in der Allowlist ([[flow-trigger]] AC2) — **keine** neue Allowlist-Regel. Ergebnis: **mindestens eine** umsetzbare (später ready-fähige) `To Do`-Story + Spec, vollständig vom `requirement`-Agenten erzeugt, **nicht** in dev-gui.

### Lifecycle (Idee bleibt Idee, bis echte Stories entstanden sind)
9. Die Idee **bleibt im Status `Idee`**, solange das Gespräch läuft. Das bloße **Öffnen** des Besprechungs-Fensters ändert den Status **nicht** (kein vorzeitiges `Done`). Wird das Gespräch **abgebrochen** (Owner schließt das Terminal, keine Stories entstanden), bleibt das Item **unverändert** in `Idee` und kann später erneut besprochen werden — **keine** verwaiste `Done`-Karte, **keine** Dublette.
10. **Auflösen/Verlinken (explizite Owner-Aktion).** Erst **nachdem** aus dem Dialog **echte Stories** entstanden sind, löst der Owner die Idee explizit auf: `BoardWriter` setzt das ursprüngliche Idee-Item auf `Done`, vermerkt `resolved_at` (Zeitstempel) und verlinkt die erzeugte(n) `To Do`-Story/Spec (`resolved_story_ids`, optional `resolved_note`). Da dev-gui den interaktiven Lauf **nicht** beobachtet/parst, ist diese Auflösung eine **bewusste, owner-bestätigte** Aktion — nicht automatisch aus Agenten-Output abgeleitet. Das Idee-Item wird **nie selbst** zur `To Do`-Story (kein `spec`, kein `implements`); die echten `To Do`-Stories entstehen **ausschließlich** aus dem `requirement`-Lauf → **keine Dublette**.

## Acceptance-Kriterien

- **AC1** — `Idee` ist ein kanonischer Story-Status, einsortiert **ganz links** vor `To Do`. Das Frontend führt `Idee` als **erstes** Element der Status-Lebenszyklus-Liste (`STATUS_LIFECYCLE` in `client/src/BoardView.jsx`); der Status-Filter enthält `Idee` (Default ausgewählt); eine „Idee"-Spalte rendert **links** von „To Do"; `BoardAggregator` kennt `Idee` in Index/Rollup (kein Crash bei unbekanntem Status, korrekte Spalten-Zuordnung). *(1)*
- **AC2** — Ein `Idee`-Item ist **nie `ready`**: `BoardAggregator.computeStoryReadyStatus` liefert für `status: Idee` `ready=false, ready_reason=null` (maßgebliche Regel, status ≠ `To Do`). Die „Idee"-Spalte zeigt **kein** ready-Badge. Verbindliche Konsequenz (testbar als Cross-Ref): `Idee` ist ein **Nicht-Drain-Ziel** ([[taktgeber-nachtwaechter]] AC3) und wird vom Taktgeber nie ausgewählt/eskaliert/verändert. *(2)*
- **AC3** — Quick-Capture-API `POST /api/board/projects/:slug/ideas` `{ title, body? }` → `201 { storyId }`: legt über `BoardWriter` (Create-Pfad) eine neue Story-YAML mit `status: Idee`, `title` und optionalem `notes` (Body) an — **ohne** `spec`, **ohne** `implements`. Die Story-ID wird **atomar** aus `board.yaml` (`next_story_id`) allokiert + hochgezählt. Validierung: `title` getrimmt nicht-leer + Längenlimit; `400 { field, message }` bei leerem/zu langem Titel. Die Anlage stößt **keinen** Agenten an (token-frei). *(3,4)*
- **AC4** — Quick-Capture-UI: die **„Arbeiten"-Seite** trägt einen sichtbaren Button **„Idee"**; Klick öffnet ein **Modal** mit Einzeiler-Titel + optionalem mehrzeiligem Stichwort-Body; Speichern → `POST …/ideas`; nach `201` erscheint die neue Idee **sofort** als Karte in der „Idee"-Spalte (Re-Fetch/Rescan). Leerer Titel → Speichern deaktiviert/abgelehnt (spiegelt AC3-Validierung). *(3,5)*
- **AC5** — Besprechungs-Session (Karte-Klick → Dialog): ein Klick auf eine Idee-Karte startet/nutzt die **interaktive PTY-Session** des Projekts (`CommandService` + `PtySessionRegistry`, **dieselbe** Engine wie das „Arbeiten"-Terminal, **kein** `claude -p`), wechselt ins **Terminal-Pane** und lädt die Stichworte der Idee (Titel + Body) als **konversationellen Gesprächs-Einstieg** in die Session vor (freier Gesprächstext, sanitisiert; **nicht** über die Slash-Allowlist, **nicht** als one-shot). Die Idee bleibt während des Gesprächs **unverändert** im Status `Idee`. Bei laufendem Command (Session `busy`) → kein Start, Idee unverändert in `Idee`. *(6,7)*
- **AC6** — Requirement als Abschluss + Lifecycle-Auflösung: im Dialog wird die Anforderung gemeinsam geschärft; der `requirement`-Flow läuft als **Formalisierung** über den **bestehenden** `POST /api/command` (`/agent-flow:requirement`, **bereits** in der Allowlist — keine neue Regel), **nicht** als one-shot auf den rohen Ideentext → erzeugt **mindestens eine** `To Do`-Story + Spec (Agenten-Verantwortung). Die Idee bleibt `Idee`, solange das Gespräch läuft; **kein** vorzeitiges `Done` beim Öffnen, **keine** Dublette. **Auflösung** ist eine **explizite** Owner-Aktion `POST …/ideas/:id/resolve`: `BoardWriter` setzt das Idee-Item auf `Done`, vermerkt `resolved_at` und verlinkt die erzeugte(n) Story/Spec (`resolved_story_ids`, optional `resolved_note`). Das Idee-Item wird nie selbst zur `To Do`-Story. *(8,9,10)*
- **AC7** — Audit: **jede** Idee-Anlage (AC3), **jeder** Besprechungs-Start (AC5) und **jede** Auflösung (AC6) erzeugt **genau einen** `AuditEntry` (`AuditStore.record`). Keine Secrets in Audit/Log/Response. *(4,7,10)*
- **AC8** — NFR/Sicherheit (Floor): der `BoardWriter`-Create-Pfad (Anlage) und der Resolve-Pfad (`status: Done` + `resolved_at`/`resolved_story_ids`/`resolved_note`) schreiben **atomar** (tmp+rename) ausschließlich nach `board/stories/<id>.yaml` und aktualisieren `next_story_id` in `board.yaml` atomar — **kein** anderer Board-Schreibpfad; `BoardAggregator` bleibt **read-only**. Pfad-/Slug-Sicherheit: die abgeleitete Story-Datei liegt garantiert unterhalb von `board/stories/` (kein Path-Traversal aus dem Titel). Der Gesprächs-Seed (AC5) ist **freier Gesprächstext** in die interaktive Session (kein Slash-Befehl) und sanitisiert (keine Steuerzeichen / keine zweite Submit-Zeile). *(4,7)*

## Verträge

### Endpunkte
- `POST /api/board/projects/:slug/ideas` `{ title: string, body?: string }` → `201 { storyId }` | `400 { field, message }` (Validierung) | `404` (Projekt unbekannt). Legt ein `Idee`-Item an (token-frei).
- `POST /api/board/projects/:slug/ideas/:id/discuss` → `200 { sessionId }` | `400 { field, message }` (Idee nicht besprechbar, z.B. bereits aufgelöst) | `404` (Idee unbekannt) | `409` (ein Command läuft / Session `busy`, [[flow-trigger]] AC3). **Startet/nutzt** die interaktive PTY-Session des Projekts und lädt die Stichworte der Idee als **konversationellen** Gesprächs-Einstieg vor (freier Gesprächstext in die Session, **nicht** die Slash-Allowlist). Ändert den Status der Idee **nicht** (bleibt `Idee`).
- `POST /api/board/projects/:slug/ideas/:id/resolve` `{ resolved_story_ids?: string[], resolved_note?: string }` → `200 { storyId }` | `400 { field, message }` (Idee nicht auflösbar / bereits `Done`) | `404` (Idee unbekannt). Setzt das Idee-Item via `BoardWriter` auf `Done` + `resolved_at` (+ `resolved_story_ids`/`resolved_note`). **Kein** Agent-Dispatch.
- Bestehender Pfad `POST /api/command` (CommandService, [[flow-trigger]]) bleibt der **einzige** PTY-Schreibweg für **Slash-Befehle**; der `requirement`-Abschluss (AC6) ruft ihn mit `/agent-flow:requirement` (bereits allowlisted).

### Story-Schema (`Idee`-Item, `board/stories/<id>.yaml`)
| Feld | Wert |
|---|---|
| `id` | `S-<n>` (atomar aus `board.yaml.next_story_id`) |
| `status` | `Idee` (→ `Done` nach expliziter Auflösung, AC6) |
| `title` | Einzeiler (Pflicht, getrimmt nicht-leer) |
| `notes` | optionaler Stichwort-Body |
| `spec` | **nicht gesetzt** (`null`/fehlt) |
| `implements` | **nicht gesetzt** (leer) |
| `parent` | optional (z.B. ein „Inbox"-Feature) — sonst orphan |
| `created_at`/`updated_at` | ISO-Zeitstempel |
| `resolved_at` | gesetzt nach Auflösung (AC6) |
| `resolved_story_ids` | IDs der aus dem Dialog erzeugten `To Do`-Story(s) (AC6) |
| `resolved_note` | optionaler Verweis auf Spec/Kontext der Auflösung (AC6) |

## Edge-Cases & Fehlerverhalten
- **Leerer/whitespace-only Titel** → `400 { field: "title" }`; kein Item angelegt.
- **Titel/Body über Längenlimit** → `400` (Schutz vor Riesen-Payloads / Argv-Überlauf beim späteren `requirement`-Trigger).
- **Besprechung bei laufendem Command** → `409` (Session `busy`, [[flow-trigger]] AC3); Idee-Item **unverändert** in `Idee`, kann später erneut besprochen werden.
- **Besprechung eines bereits aufgelösten Items** (`status: Done`/`resolved_at` gesetzt) → `400 { field: "status" }` (nicht besprechbar).
- **Gespräch wird abgebrochen** (Owner schließt das Terminal, keine Stories entstanden) → das Idee-Item bleibt **unverändert** in `Idee` (kein vorzeitiges `Done`), kann erneut besprochen werden — keine verwaiste `Done`-Karte, keine Dublette.
- **Auflösung eines bereits aufgelösten/nicht-besprochenen Items** → `400 { field: "status" }` (idempotenz-tolerant, kein zweites `Done`).
- **`BoardWriter`-Resolve-Schreibfehler** → Fehler wird auditiert, API antwortet `5xx` ohne Secret-Leak; das Item bleibt sichtbar (degradierend, keine verlorene Idee).
- **Board-Scan-/Schreibfehler** → kein Crash; Fehler wird auditiert, API antwortet mit `5xx` ohne Secret-Leak.

## NFRs
- **Sicherheit (Floor):** kein neuer Board-Schreibpfad jenseits `BoardWriter`; atomare Writes (tmp+rename); Pfad-/Slug-Sicherheit (kein Traversal aus Nutzereingabe); keine Secrets in Audit/Log/Response. **Reiner PTY-Pfad** für die Besprechung (interaktive Session) **und** für den `requirement`-Abschluss (über `CommandService`-Allowlist) — **kein** Anthropic-API, **kein** `claude -p` (`.claude/CLAUDE.md`). Der Gesprächs-Seed ist konversationeller Freitext in die interaktive Session, sanitisiert (keine Slash-Allowlist-Umgehung, keine Mehrfach-Zeilen-Injektion).
- **Token-Sparsamkeit:** Quick-Capture/Anlage stößt **keinen** Agenten an (rein lokaler Board-Write). Das Öffnen der Besprechung lädt nur den Gesprächs-Einstieg vor (kein Agent-Dispatch); erst der explizite `requirement`-Abschluss innerhalb des Dialogs kostet einen `requirement`-Lauf.
- **Robustheit:** Anlage/Besprechung/Auflösung sind idempotenz-tolerant gegenüber Doppel-Klick (Session-`busy`-Guard / `resolved_at`-Guard); Board-Aggregation bleibt read-only und degradierend. dev-gui beobachtet den interaktiven Lauf **nicht** — die Lifecycle-Auflösung ist eine explizite Owner-Aktion.

## Wiederverwendung bestehender Bausteine
- **Interaktive PTY-Session** (`CommandService` + `PtySessionRegistry`, [[flow-trigger]] / „Arbeiten"-Terminal) — **dieselbe** Engine für die Besprechungs-Session: reiner PTY-Pfad, dialogisches Gespräch, Gesprächs-Seed als konversationeller Freitext. Der `requirement`-Abschluss nutzt den **bestehenden** `POST /api/command` (Slash-Befehl, Allowlist enthält `/agent-flow:requirement` **bereits** → keine neue Regel).
- **`BoardWriter`** (aus [[taktgeber-nachtwaechter]] S-191) — schmale, atomare Board-Schreib-Boundary. Hier um einen **Create-Pfad** (neues `Idee`-Item) und einen **Resolve-Pfad** (`status: Done` + `resolved_at`/`resolved_story_ids`/`resolved_note`) erweitert. Einziger Board-Schreibpfad.
- **`BoardAggregator` + `computeStoryReadyStatus`** (`src/BoardAggregator.js`) — read-only Index/Rollup; kennt nach AC1 den Status `Idee`; `computeStoryReadyStatus` garantiert `ready=false` für `Idee` (status ≠ `To Do`, bereits implementiert) → fundiert das Nicht-Drain-Ziel (AC2).
- **`boardRouter`** (`src/boardRouter.js`) — bestehender Board-API-Router; nimmt die `POST …/ideas`, `…/ideas/:id/discuss` + `…/ideas/:id/resolve`-Endpunkte auf.
- **Terminal-Pane / Terminal-Handoff-Muster** ([[fabric-intake-dialog]] AC4/AC5, [[terminal-frontend]]) — GUI-Wechsel in den Terminal-Pane für die Besprechung.
- **`BoardView.jsx` / „Arbeiten"-Seite** (`client/src/BoardView.jsx`) — Kanban-Rendering + `STATUS_LIFECYCLE` + Status-Filter; um die „Idee"-Spalte (ganz links), den **„Idee"-Button + Modal** (Quick-Capture) und den **Karte-Klick → Besprechungs-Dialog** erweitert.
- **`AuditStore`** (`src/AuditStore.js`) — Audit je Anlage/Besprechungs-Start/Auflösung (AC7).

## Neu zu bauen (Lücken)
- **`BoardWriter`-Create-Pfad** — neues `Idee`-Item anlegen (ID-Allokation aus `board.yaml`, atomarer Write) — **und** **Resolve-Pfad** (`status: Done` + `resolved_at`/`resolved_story_ids`/`resolved_note`). (AC3/AC6/AC8)
- **`Idee`-Status im Frontend + Aggregator** — `STATUS_LIFECYCLE`-Erweiterung (ganz links), Spalten-Render, Filter-Default, `BoardAggregator`-Statuskenntnis. (AC1/AC2)
- **Quick-Capture-Button + Modal + API** — „Idee"-Button auf der „Arbeiten"-Seite, Modal (Titel + Stichwort-Body), `POST …/ideas`. (AC3/AC4)
- **Besprechungs-Start** — `POST …/ideas/:id/discuss`: interaktive PTY-Session sicherstellen/nutzen, Stichworte als konversationellen Gesprächs-Einstieg vorladen (sanitisiert), Terminal-Pane-Wechsel; Karte-Klick-Handler. (AC5)
- **Explizite Auflösung** — `POST …/ideas/:id/resolve`: Idee auf `Done` + Verlinkung der erzeugten Story/Spec; Owner-Aktion + UI. (AC6)

## Nicht-Ziele
- **Keine** Ein-Klick-Automatik mehr: die rohe Idee wird **nicht** headless one-shot durch `/agent-flow:requirement` geschickt — sie wird **interaktiv besprochen** (ersetzt die frühere Promotion-Semantik).
- **Kein** vorzeitiges `Done` beim bloßen Öffnen des Besprechungs-Fensters; **keine** automatische Lifecycle-Auflösung aus Agenten-Output (dev-gui beobachtet/parst den Lauf nicht — Auflösung ist explizite Owner-Aktion).
- **Keine** automatische Verfeinerung in dev-gui: aus einer Idee formt dev-gui **keine** Spec/Stories selbst — das macht ausschließlich der `requirement`-Agent (interaktiv im Dialog).
- **Kein** autonomes Anfassen von `Idee`-Items durch den Taktgeber (explizites Nicht-Drain-Ziel, AC2 / [[taktgeber-nachtwaechter]] AC3).
- **Kein** neuer Board-Schreibpfad jenseits `BoardWriter`; **kein** `claude -p` (interaktiver Pfad bleibt rein PTY).
- **Kein** neuer Bootstrap-/Agenten-Pfad (nutzt den bestehenden `requirement`-Flow + die bestehende interaktive PTY-Session).

## Abhängigkeiten
- [[taktgeber-nachtwaechter]] (Status `Idee` als Nicht-Drain-Ziel, `BoardWriter`-Boundary aus S-191) · [[flow-trigger]] (CommandService, interaktive PTY-Session, `POST /api/command`, Allowlist `/agent-flow:requirement`) · [[fabric-intake-dialog]] (Terminal-Pane / interaktiver Handoff) · [[terminal-frontend]] (Live-Terminal, Pane-Wechsel) · [[studis-kanban-board-ux]] (Status-Filter/Spalten-Rendering) · `BoardAggregator` + `computeStoryReadyStatus` · `boardRouter` · `PtySessionRegistry` · `AuditStore`.
