---
id: board-feature-archive
title: Board — erledigte Features archivieren (aus Standardansicht entfernen, Dateien erhalten)
status: active
version: 2
---

# Spec: Board — erledigte Features archivieren  (`board-feature-archive`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig. Source of Truth für coder/tester/reviewer (hartes Drift-Gate).
>
> **Erweitert [[studis-kanban-board-ux]]** (Board-Übersicht) und **[[board-feature-collapse]]** (Kopfleiste). Nutzt die bestehende Schreib-Boundary **[[ideen-inbox]]** (`BoardWriter`) — kein neuer, zweiter Schreibpfad.

## Zweck

Das Studis-Kanban-Board wächst mit der Zeit unübersichtlich, weil abgeschlossene Features dauerhaft in der Übersicht stehen bleiben. Diese Spec ergänzt eine Aktion, die **alle vollständig erledigten Features (samt ihren Stories) aus der Standard-Übersicht entfernt** — jedoch **ohne Datenverlust**: Die Board-Dateien (`board/features/*.yaml`, `board/stories/*.yaml`) bleiben erhalten und weiterhin von `estimator` (Few-shot-Referenz) und `retro` (EP-Kalibrierung) lesbar. Das Entfernen erfolgt über ein **In-place-Archiv-Flag** (`archived: true` + `archived_at`); der Story-`status` bleibt unverändert `Done`. Eine **Bestätigungsabfrage** (mit Anzahl betroffener Features/Stories) schützt vor versehentlicher Massen-Archivierung.

## Kontext / Designentscheidungen (Default — Owner-Bestätigung ausstehend)

> Diese Entscheidungen wurden vom `requirement`-Agenten getroffen, weil eine interaktive Rückfrage im Batch-Lauf nicht möglich war. Sie sind bewusst konservativ; der Owner kann sie im Cut-PR revidieren.

- **Archivieren statt Löschen (bindend, Koordinator-Vorgabe 2026-07-01):** Kein Hard-Delete. `estimator` nutzt erledigte Stories als Few-shot-Referenz, `retro` kalibriert darauf die EP-Basis — ein Löschen zerstörte diese Datengrundlage.
- **In-place-Flag statt Verschieben (Default).** `archived: true` + `archived_at: <ISO>` als Top-Level-Feld im Feature-YAML **und** in jedem seiner Story-YAMLs. Die Dateien bleiben in `board/features/` bzw. `board/stories/`, der Story-`status` bleibt `Done`. **Begründung:** `estimator`/`retro` scannen `board/stories/*.yaml` direkt und filtern auf `status: Done` — bei einem In-place-Flag lesen sie unverändert weiter. Ein Verschieben nach `board/archive/` würde erzwingen, diese Reader umzubauen (höheres Risiko), und wurde daher verworfen.
- **`board/board.yaml` wird NICHT verändert.** Die Feature→Story-Referenzen bleiben intakt; das Ausblenden geschieht ausschließlich über das Flag im Aggregator. (Kein riskanter Umbau der Referenz-Listen.)
- **Archiv bleibt einsehbar.** Ein optionaler „Archiv anzeigen"-Schalter im Board macht archivierte Features read-only sichtbar (V6).
- **Kein Entarchivieren/Restore im MVP** (Nicht-Ziel; Rückgängig nur über Datei/Git — mögliches Folge-Feature).

## Verhalten

### V1 — Archivierbarkeits-Kriterium („vollständig erledigt")
> **Ab v2 (V7/AC9) auf „terminal" erweitert:** wo hier „jede Story `Done`" steht, gilt effektiv „jede Story **terminal** (`Done` **oder** `Verworfen`)". Die folgende Formulierung bleibt als historische Baseline (AC1) erhalten; die aktuelle Regel ist V7/AC9.

Ein Feature ist **archivierbar** genau dann, wenn **alle** folgenden Bedingungen gelten:
- es hat **mindestens eine** zugeordnete Story, **und**
- **jede** seiner Stories hat `status: Done` (→ ab V7/AC9: `Done` **oder** `Verworfen`), **und**
- es ist **nicht bereits** archiviert (`archived` nicht `true`).

Nicht archivierbar sind daher: Features mit **mindestens einer nicht-terminalen Story** (bleiben unangetastet — Owner-Vorgabe), Features **ohne** Stories, sowie das Pseudo-Feature `_orphaned` (verwaiste Stories/Ideen). Das Kriterium stützt sich auf die tatsächlichen Story-Status, **nicht** allein auf das (potenziell veraltete) `feature.status`-Feld.

### V2 — Archiv-Schreibpfad (in-place, atomar)
Eine neue Methode der bestehenden Schreib-Boundary (`BoardWriter`) archiviert **alle aktuell archivierbaren Features** eines Projekts. Für jedes solche Feature:
- patcht sie das **Feature-YAML**: setzt/ergänzt `archived: true` + `archived_at: <ISO-8601-UTC>` und aktualisiert `updated_at`;
- patcht sie **jede zugehörige Story-YAML** ebenso: `archived: true` + `archived_at` + `updated_at`; der Story-`status` bleibt **unverändert** `Done`.

Alle übrigen Felder (inkl. mehrzeiliger Werte, Kommentare, Quoting-Stil, Schlüssel-Reihenfolge) bleiben **byte-genau** erhalten (Line-Patch/Append — kein YAML-Roundtrip, Muster wie `resolveIdea()`/`patchTopLevelFields({allowAppend:true})`). Jede Datei wird **atomar** geschrieben (tmp + rename, Mode 0600). `board/board.yaml` wird **nicht** verändert. Der Vorgang ist **idempotent**: bereits archivierte Features/Stories werden übersprungen (kein zweites `archived_at`).

### V3 — Aggregator blendet Archivierte aus (Standardansicht)
Der Board-Aggregat-Index schließt in der **Standardansicht** Features mit `archived: true` (und deren Stories) aus — sie erscheinen weder in der Feature-Liste noch in Zählern/Rollups der Standardansicht. Eine Story, die einzeln `archived: true` trägt (deren Feature aber sichtbar bliebe — Rand­fall), wird ebenfalls aus der Standard-Story-Liste ausgeblendet. Ein explizites `includeArchived`-Signal (Query/Option) liefert archivierte Features/Stories **zusätzlich** zurück, klar als `archived` markiert.

### V4 — Endpoint „erledigte Features archivieren"
`POST /api/board/projects/:slug/archive-done` archiviert alle aktuell archivierbaren Features des Projekts (V1) über den Schreibpfad (V2):
- **Audit-First:** genau **ein** Audit-Eintrag je Aufruf (nach Slug-/Busy-Prüfung, vor dem Schreiben) — analog `POST .../ideas`.
- **Concurrency-Schutz:** hält kurz das projektweite `ProjectJobLock` um den Repo-Pfad; ist es bereits gehalten (Taktgeber/Drain/andere Board-Schreibaktion) → `409`.
- **Antwort `200`:** `{ archivedFeatureCount, archivedStoryCount }` (Anzahl tatsächlich archivierter Features/Stories; `0/0` wenn nichts archivierbar war — kein Fehler).
- Nach Erfolg ist der frisch gescannte Index frei von den archivierten Features (Client rescannt/lädt neu).

### V5 — Button + Bestätigungsabfrage (Frontend)
In der Board-Kopfleiste (dort, wo „Alle einklappen"/Filter sitzen) erscheint ein Button **„Erledigte Features archivieren"**. Verhalten:
- Sind **keine** Features archivierbar (V1), ist der Button **deaktiviert** (bzw. zeigt einen Hinweis „Keine erledigten Features") — kein Aufruf.
- Ein Klick öffnet eine **Bestätigungsabfrage**, die die **Anzahl betroffener Features und Stories** nennt (aus den bereits geladenen Board-Daten nach der Regel V1 berechnet, z.B. „3 Features mit 14 Stories werden archiviert. Sie verschwinden aus der Übersicht, bleiben aber gespeichert.").
- **Abbrechen** → keine Aktion, keine Änderung.
- **Bestätigen** → `POST .../archive-done`; nach Erfolg wird die Übersicht neu geladen (Rescan), die archivierten Features sind verschwunden. Fehler (`409`/`5xx`) werden als nicht-blockierender Hinweis dargestellt, ohne die Ansicht zu zerstören.

### V6 — Archiv-Ansicht (Frontend-Schalter)
Ein Schalter **„Archiv anzeigen"** im Board (Default: aus) blendet archivierte Features **read-only** wieder ein (nutzt `includeArchived`, V3). Archivierte Features/Stories sind dabei visuell klar als „Archiviert" gekennzeichnet und tragen keine Schreib-/Aktions-Affordances. Ist der Schalter aus, gilt die Standardansicht (V3).

### V7 — Archivierbarkeit auf terminale Stories erweitert (Done ODER Verworfen) — fortgeschrieben v2
Das Archivierbarkeits-Kriterium (V1) rechnet den terminalen Story-Status **`Verworfen`** (Won't-Do, siehe [[board-status-verworfen]]) **wie `Done`**: Ein Feature ist archivierbar, wenn es **≥1 Story** hat, **jede** seiner Stories **terminal** ist (`status` ∈ `{Done, Verworfen}`) und es **nicht bereits** archiviert ist. Eine `Verworfen`-Story blockiert das Archivieren **nicht** mehr (bisher galt sie als „nicht Done" → Feature blieb sichtbar).

Diese Erweiterung gilt an **allen** drei Stellen, die das Kriterium auswerten, damit sie konsistent bleiben:
- der **Backend-Schreibpfad** (`BoardWriter.archiveDoneFeatures` — Auswahl der zu archivierenden Features),
- die **Frontend-Archivierbarkeitsprüfung** (Aktivierung des Buttons + Bestätigungs-Zählung „N Features / M Stories"),
- (implizit) die **Zähl-/Anzeigelogik**, die daraus folgt.

Beim Archivieren bleibt der Story-`status` **unverändert** — `Done` bleibt `Done`, `Verworfen` bleibt `Verworfen`; ergänzt werden nur `archived: true` + `archived_at` (V2, byte-genau, atomar, idempotent). `estimator`/`retro` lesen `Verworfen`-Stories weiterhin am Ort (sie filtern auf `status: Done`; eine archivierte `Verworfen`-Story taucht dort schlicht nicht als Done-Referenz auf — kein Datenverlust).

## Acceptance-Kriterien

- **AC1** — `BoardWriter` bestimmt die archivierbaren Features eines Projekts exakt nach V1: ≥1 Story UND alle Stories `Done` UND nicht bereits archiviert; Features mit ≥1 nicht-Done-Story, Features ohne Stories und verwaiste Stories werden NICHT archiviert. *(V1)*
- **AC2** — Der Archiv-Schreibpfad setzt in Feature-YAML und allen zugehörigen Story-YAMLs `archived: true` + `archived_at` (+ aktualisiertes `updated_at`), lässt den Story-`status` auf `Done`, erhält alle übrigen Zeilen byte-genau, schreibt jede Datei atomar (tmp+rename, 0600) und verändert `board/board.yaml` NICHT; wiederholter Aufruf ist idempotent (kein zweites `archived_at`). *(V2)*
- **AC3** — Der Aggregator-Standardindex enthält keine Features/Stories mit `archived: true` (auch nicht in Zählern/Rollups); mit `includeArchived` werden sie zusätzlich, als `archived` markiert, geliefert. *(V3)*
- **AC4** — `POST /api/board/projects/:slug/archive-done` archiviert alle archivierbaren Features, schreibt genau EINEN Audit-Eintrag (Audit-First), hält kurz das `ProjectJobLock` (`409` wenn belegt), antwortet `200 { archivedFeatureCount, archivedStoryCount }` (`0/0` ohne Fehler wenn nichts archivierbar), `404` bei unbekanntem/ungültigem Slug; einziger Schreibpfad bleibt `BoardWriter`. *(V4)*
- **AC5** — Der Board-Button „Erledigte Features archivieren" ist deaktiviert, wenn nichts archivierbar ist; sonst öffnet ein Klick eine Bestätigungsabfrage mit der Anzahl betroffener Features UND Stories; Abbrechen ändert nichts; Bestätigen ruft den Endpoint auf und lädt die Übersicht neu (archivierte verschwinden); Endpoint-Fehler werden nicht-blockierend gemeldet. *(V5)*
- **AC6** — Ein „Archiv anzeigen"-Schalter (Default aus) blendet archivierte Features read-only + klar markiert ein (via `includeArchived`); ausgeschaltet gilt die Standardansicht. *(V6)*
- **AC7** — A11y (WCAG 2.1 AA): Button + Schalter sind echte `button`/Toggle-Elemente mit sprechendem `aria-label`; die Bestätigungsabfrage ist ein fokussiertes Dialog-Muster (`role="dialog"`, Fokusfalle/Esc-Abbruch, sichtbarer Fokusring); Bedeutung nicht allein über Farbe. *(V5, V6)*
- **AC8** — Security/Robustheit: kein neuer Schreibpfad außer `BoardWriter` (Pfad-/Slug-Sicherheit per BOARD_ROOTS-Realpath-Schranke, Muster `setBlocked`/`resolveIdea`); kein `dangerouslySetInnerHTML`; keine Secrets in Ausgabe/Log; ungültige Eingaben werden sauber abgewiesen (kein Crash). *(alle)*
- **AC9** — Das Archivierbarkeits-Kriterium (Backend `BoardWriter.archiveDoneFeatures` UND Frontend-Buttonaktivierung/Bestätigungs-Zählung) behandelt `Verworfen` wie `Done` als terminal: ein Feature mit ≥1 Story, dessen Stories ALLE `Done` oder `Verworfen` sind und das nicht bereits archiviert ist, IST archivierbar; ein Feature mit ≥1 nicht-terminaler Story (To Do/In Progress/Blocked/In Review/Idee) ist es NICHT. Beim Archivieren bleibt der Story-`status` unverändert (`Verworfen` bleibt `Verworfen`), nur `archived`/`archived_at` werden ergänzt; Idempotenz und byte-genaues/atomares Schreiben (AC2) gelten unverändert. *(V7)*

## Verträge

- **Endpoint:** `POST /api/board/projects/:slug/archive-done`
  - Request: kein Body (bzw. leerer JSON-Body). `:slug` gegen `SLUG_RE` geprüft, nur gegen den In-Memory-Index aufgelöst (nie als Pfad).
  - Response `200`: `{ "archivedFeatureCount": <int>, "archivedStoryCount": <int> }`.
  - `404 { error }` (Slug-Format ungültig ODER Projekt nicht unter BOARD_ROOTS), `409 { error }` (ProjectJobLock belegt), `500 { error }` (Audit-/Schreibfehler — kein Secret-Leak).
- **Aggregator:** `getIndex({ includeArchived?: boolean })` (oder äquivalente Option/Query) — Default `false` = Standardansicht ohne Archivierte; `true` = Archivierte zusätzlich, je Feature/Story `archived: true`/`archived_at` durchgereicht.
- **YAML-Schema-Erweiterung (additiv, optional):** Feature- und Story-YAML erhalten optionale Top-Level-Felder `archived: <bool>` und `archived_at: <ISO-8601-UTC-String>`. Fehlen sie, gilt `archived: false` (nicht archiviert). Kein Pflichtfeld — Abwärtskompatibilität mit bestehenden Dateien.
- **`BoardWriter.archiveDoneFeatures({ projectSlug, now? })`** → `{ archivedFeatureCount, archivedStoryCount, archivedFeatureIds }`. Einziger Schreibpfad; nutzt die vorhandenen Helfer (`patchTopLevelFields({allowAppend:true})`, `_atomicWrite`, `_resolveProjectPath`).

## Edge-Cases & Fehlerverhalten

- **Kein archivierbares Feature** → Button deaktiviert; Endpoint (falls dennoch aufgerufen) antwortet `200 { 0, 0 }`, kein Fehler.
- **Feature Done, aber mit einer Blocked/In-Progress-Story** → nicht archivierbar, bleibt vollständig sichtbar (Owner-Vorgabe).
- **Feature mit Done + Verworfen (alle terminal)** → archivierbar (V7/AC9); Story-Status bleiben unverändert.
- **Feature mit nur Verworfen-Stories** → archivierbar (alle terminal, V7/AC9); nach Archivierung aus der Standardansicht entfernt.
- **Feature mit ≥1 Verworfen + ≥1 To Do/In Progress** → nicht archivierbar (nicht alle terminal).
- **Feature ohne Stories** → nicht archivierbar (nichts „vollständig erledigt").
- **Bereits archiviert** → übersprungen (idempotent), zählt nicht erneut.
- **Paralleler Taktgeber/Drain hält ProjectJobLock** → `409`, keine Teil-Archivierung; Client zeigt nicht-blockierenden Hinweis.
- **Einzelne Datei nicht patchbar** (z.B. `archived`-Schlüssel-Kollision/`duplicate-key`) → dieses Feature wird übersprungen und als Fehler geloggt; die übrigen werden dennoch archiviert (best effort, kein Gesamt-Abbruch) — oder, falls atomare Gesamt-Semantik gefordert, sauberer Abbruch mit `500` (coder-Entscheidung; im Zweifel best-effort + Log, kein Crash).
- **localStorage/Anzeige** — der „Archiv anzeigen"-Schalter ist reiner Anzeige-Zustand; defektes localStorage → stiller Default (aus), kein Crash.

## NFRs

- **Datenintegrität:** atomare Einzeldatei-Schreibvorgänge; `estimator`/`retro` bleiben funktionsfähig, da Story-Dateien am Ort bleiben und `status: Done` behalten.
- **Security:** Pfad-/Slug-Sicherheit über die bestehende BOARD_ROOTS-Realpath-Schranke; Audit-First; kein Secret-Leak.
- **A11y/Design:** konsistent mit [[studis-kanban-board-ux]]/[[board-feature-collapse]] (Kopfleisten-Buttons, Fokusringe, Text-Badges).

## Nicht-Ziele

- **Hard-Delete** von Board-Dateien (bewusst verworfen — estimator/retro-Datengrundlage).
- **Entarchivieren/Restore** aus dem GUI (mögliches Folge-Feature).
- **Umbau der `board/board.yaml`-Referenzlisten** (Flag-basiertes Ausblenden statt Referenz-Entfernung).
- **Verschieben nach `board/archive/`** (Reader-Umbau vermieden).
- **Teamweite/serverseitige Persistenz des Anzeige-Schalters** (rein lokal).

## Abhängigkeiten

- **dev-gui:** `src/BoardWriter.js` (neue `archiveDoneFeatures()`-Methode + Feature-Datei-Finder), `src/BoardAggregator.js` (`includeArchived`-Filter), `src/boardRouter.js` (`POST .../archive-done`), `server.js` (Wiring), `client/src/BoardView.jsx` (Button + Bestätigungsabfrage + Archiv-Schalter).
- **Specs:** [[studis-kanban-board-ux]] (Board-Übersicht), [[board-feature-collapse]] (Kopfleiste), [[ideen-inbox]] (`BoardWriter`-Schreib-Boundary/Audit-Muster), [[board-status-verworfen]] (führt den terminalen Status `Verworfen` ein; V7/AC9 dieser Spec rechnet ihn im Archiv-Kriterium wie `Done`).
