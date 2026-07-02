---
id: board-status-verworfen
title: Board — Story-Status „Verworfen" (Won't-Do) in der GUI darstellen
status: draft
version: 1
---

# Spec: Board — Story-Status „Verworfen" in der GUI  (`board-status-verworfen`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig. Source of Truth für coder/tester/reviewer (hartes Drift-Gate).
>
> **Erweitert [[studis-kanban-board-ux]]** (Board-Ansicht: Spalten + Status-Filter) und koordiniert mit **[[feature-status-derivation]]** (Ableitung, dort V7/AC8) und **[[board-feature-archive]]** (Archiv-Kriterium, dort V7/AC9). **Reine Anzeige-/Leseänderung in dev-gui — kein Schreibpfad, kein neuer Endpunkt.**

## Zweck

Ein neuer terminaler Story-Status **„Verworfen"** (Won't-Do / obsolet) wird als gültiger Wert eingeführt: „wird bewusst nicht mehr gemacht" — im Unterschied zu **„Done"** (erfolgreich umgesetzt). Er löst die bisherige informelle `[DEFERRED]`-Titel-Konvention ab (z.B. Story S-083). Diese Spec deckt **ausschließlich die dev-gui-GUI-Seite** ab: „Verworfen" wird im Studis-Kanban-Board **dargestellt** (eigene Spalte + Filter-Checkbox + eigener, gedämpfter Badge) und überall dort als gültiger Wert erkannt, wo dev-gui den Story-Status hart auflistet.

## Schema-Eigentum & Abgrenzung (bindend)

- **Das Board-Schema besitzt das Schwester-Repo `agent-flow`** (`docs/specs/board-schema.md`, `scripts/board-lint.sh`). Die Erweiterung des Story-Status-Enums (`To Do|In Progress|Blocked|In Review|Done` → `…|Verworfen`) sowie das `/agent-flow:flow`-Verhalten (Verworfen wie Done: nicht aufgreifen, zählt als abgeschlossen) laufen als **eigene, parallele agent-flow-Story** — **NICHT** Teil dieser dev-gui-Story.
- **dev-gui ist reiner Konsument des Status-Strings.** Der Board-Aggregator liest `status` **live** aus den Story-YAMLs (kein persistierter Enum, keine Enum-Validierung beim Lesen). Die GUI ist **schreib-frei für Status**: es gibt in dev-gui **keinen** Pfad, der einen Story-Status setzt/validiert (`BoardWriter` schreibt ausschließlich die kontrollierten Konstanten `Idee`/`Blocked`/`Done` — nie `Verworfen`). Daher entfällt jede „Backend-Validierung beim Setzen eines Status über die GUI" — es gibt keine solche Stelle. Die einzigen dev-gui-Stellen, die den Status-Enum **hart auflisten**, sind: (a) `STATUS_LIFECYCLE` im Frontend (Spalten + Filter-Checkboxen), (b) `FEATURE_STATUS_ORDER` / die Ableitung im `BoardAggregator` (→ [[feature-status-derivation]] V7/AC8). Beide werden erweitert.

## Kontext / Designentscheidungen (vom requirement-Agenten getroffen; Owner-Delegation, im Cut-PR revidierbar)

> Der `requirement`-Agent läuft headless (keine interaktive Rückfrage möglich). Die folgenden drei Entscheidungen sind bewusst konservativ und konsistent mit den bereits ausgelieferten Nachbar-Features; der Owner kann sie im Cut-PR revidieren.
>
> **Lage bei Anlage (2026-07-02):** [[feature-status-derivation]] (S-238), der Alle/Keine-Toggle ([[studis-kanban-board-ux]] AC7, S-235) und das Archiv-Feature ([[board-feature-archive]], S-232…S-236) sind **bereits `Done` und ausgeliefert**. Spalten **und** Filter-Checkboxen werden im Frontend zentral aus dem einen Array `STATUS_LIFECYCLE` erzeugt; der Feature-Status wird bereits read-only abgeleitet. Deshalb ist der dev-gui-Anteil primär additiv.

- **D1 — Filter-Checkbox „Verworfen" default AN/sichtbar (statt default aus).** „Verworfen" reiht sich als 7. Eintrag in `STATUS_LIFECYCLE` ein und ist damit — wie alle übrigen Status — beim Öffnen **vorausgewählt** (studis-kanban-board-ux AC2: „alle N Status vorausgewählt"). **Begründung:** bewahrt die generische, ein-Array-getriebene Invariante ohne Sonderfall; der Alle/Keine-Toggle und der `n/N`-Zähler funktionieren automatisch weiter. Terminal-Rauschen wird ohnehin separat durch das Archiv-Feature ([[board-feature-archive]]) gebändigt. *(Alternative „nur Verworfen default aus" wurde verworfen, weil sie AC2 bräche und einen Status-spezifischen Sonderfall im Filter erzwänge.)*
- **D2 — Verworfen ist terminal, Done-äquivalent für die Feature-Ableitung.** Siehe [[feature-status-derivation]] V7/AC8: in der weakest-wins-Skala zählt Verworfen wie Done (stärkste/terminale Stufe). Folge: Nur-Verworfen-Feature → `Done`; Done+Verworfen → `Done`; ToDo+Verworfen → `To Do`.
- **D3 — Verworfen zählt für die Archivierbarkeit als terminal.** Siehe [[board-feature-archive]] V7/AC9: ein Feature ist archivierbar, wenn alle Stories **terminal** sind (Done **oder** Verworfen) — eine Verworfen-Story blockiert das Archivieren nicht mehr.

## Verhalten

### V1 — Verworfen als 7. Kanban-Spalte (rechts neben Done)
Der Story-Status **`Verworfen`** wird als **7. Spalte** in der Feature→Story-Kanban-Ansicht geführt, **rechts neben `Done`** (Reihenfolge: Idee · To Do · In Progress · Blocked · In Review · Done · Verworfen). Die Spalte wird — wie die übrigen — **immer** gerendert (auch wenn leer). Konkret: `Verworfen` ist das letzte Element des zentralen `STATUS_LIFECYCLE`-Arrays, das sowohl die Spalten (`gridTemplateColumns: repeat(STATUS_LIFECYCLE.length, …)`) als auch die Spaltenüberschriften erzeugt.

### V2 — Eigener, gedämpfter Badge/Label (klar von „Done" abgesetzt)
Der `StatusBadge` für `Verworfen` trägt einen **eigenen, gedämpften (neutral-grauen) Farbton**, der ihn **optisch klar von `Done`** (erfolgreich, grün) abgrenzt und die terminale „bewusst-nicht-gemacht"-Semantik transportiert. Die Bedeutung wird **über den sichtbaren Text `Verworfen`** getragen, **nicht allein über Farbe** (WCAG 2.1 AA); der Kontrast von Text auf Hintergrund erfüllt AA (≥ 4.5:1). Umgesetzt als eigener Eintrag in `STATUS_BADGE_STYLES['Verworfen']`.

### V3 — Verworfen als 7. Filter-Checkbox (default AN)
Im Status-Filter-Popover ([[studis-kanban-board-ux]] V4/V7) erscheint `Verworfen` als **7. Checkbox** (nach Done). Weil `STATUS_LIFECYCLE` die Checkbox-Liste speist, ist `Verworfen` beim Öffnen **vorausgewählt** (D1/AC2), der `n/N`-Zähler des Buttons zählt jetzt bis 7, und der „Alle/Keine"-Toggle (AC7) bezieht `Verworfen` automatisch ein — **ohne** zusätzliche Filter-Logik. Deselektieren von `Verworfen` blendet die Verworfen-Spalte/-Karten aus; Selektieren zeigt sie.

### V4 — Verworfen-Stories landen in ihrer eigenen Spalte (kein To-Do-Fallback)
Eine Story mit `status: Verworfen` wird der **Verworfen-Spalte** zugeordnet — **nicht** dem `To Do`-Sammelbecken für unbekannte Status. Der bestehende „unbekannter Status → To Do"-Fallback der Spalten-Gruppierung bleibt für **echte** unbekannte Werte unverändert; `Verworfen` ist ab jetzt ein **bekannter** Wert (Teil von `STATUS_LIFECYCLE`).

### V5 — Keine Änderung an schreibenden/lebendigen Pfaden (Invariante, kein Code-Delta erwartet)
dev-gui **schreibt** `Verworfen` **nie** (Board bleibt aus der GUI read-only; `BoardWriter` kennt nur die Konstanten Idee/Blocked/Done). Der Drain/Readiness-Pfad greift `Verworfen` **nie** auf: `ProjectDrain` behandelt nur `To Do`/`In Progress` als „lebendig", und die Ready-Berechnung verlangt `status === 'To Do'` — `Verworfen` erfüllt beides nicht und wird (wie Blocked/Idee) übersprungen. Diese Invariante gilt **bereits** und darf durch die Anzeige-Änderung **nicht** verletzt werden (Regressions-Absicherung durch Test).

## Acceptance-Kriterien

- **AC1** — Das Studis-Kanban-Board rendert `Verworfen` als 7. Story-Spalte **rechts neben `Done`** (Reihenfolge Idee → … → Done → Verworfen); die Spalte wird auch bei 0 Stories gerendert und das Spalten-Grid folgt `STATUS_LIFECYCLE.length` (= 7). *(V1)*
- **AC2** — Der `StatusBadge` für `Verworfen` nutzt einen eigenen, gedämpft-neutralen Farbton, der sich sichtbar von `Done` (grün) unterscheidet; die Bedeutung steht als Text `Verworfen` im Badge (nicht nur Farbe), Kontrast erfüllt WCAG 2.1 AA. *(V2)*
- **AC3** — Im Status-Filter-Popover ist `Verworfen` die 7. Checkbox, beim Öffnen **vorausgewählt** (Default alle an); der Button-Zähler zählt bis 7 und der „Alle/Keine"-Toggle schließt `Verworfen` ein; Deselektieren blendet die Verworfen-Karten/-Spalte aus, Selektieren zeigt sie — ohne Status-spezifische Sonderlogik (rein über `STATUS_LIFECYCLE`). *(V3, D1)*
- **AC4** — Eine Story mit `status: Verworfen` erscheint in der Verworfen-Spalte, **nicht** im `To Do`-Fallback-Bucket; der Fallback bleibt ausschließlich für echte unbekannte Status erhalten. *(V4)*
- **AC5** — Regressions-Invariante: dev-gui besitzt keinen Pfad, der einen Story-Status `Verworfen` schreibt/setzt; `ProjectDrain` und die Ready-Berechnung greifen `Verworfen`-Stories nicht auf (werden wie Blocked/Idee übersprungen). Ein Test belegt, dass eine Verworfen-Story nicht als „ready"/„lebendig" gilt. *(V5)*

## Verträge

- **Frontend — einzige Enum-Quelle:** `STATUS_LIFECYCLE` (in `client/src/BoardView.jsx`) wird von `['Idee','To Do','In Progress','Blocked','In Review','Done']` auf `[…,'Done','Verworfen']` (7 Elemente) erweitert. Dieses Array speist Spalten (`gridTemplateColumns`, Spalten-Map), die Spalten-Gruppierung (`byStatus`) und die Filter-Checkbox-Liste (`statusOptions`) — **eine** Änderung, drei Wirkungen. `STATUS_BADGE_STYLES` erhält den Schlüssel `'Verworfen'` mit gedämpftem Ton (z.B. neutral-grau, deutlich anders als der grüne `Done`-Ton).
- **Backend — kein Enum-Write.** Der `BoardAggregator` liest `status` unverändert live aus den Story-YAMLs (keine Validierung/Allowlist beim Lesen). `BoardWriter` schreibt `Verworfen` nicht (nur Idee/Blocked/Done). Die Feature-Status-**Ableitung** (`FEATURE_STATUS_ORDER`/`computeFeatureStatus`) wird separat in [[feature-status-derivation]] V7/AC8 erweitert (eigene Story).
- **Story-Status-Wertebereich (Anzeige):** `{Idee, To Do, In Progress, Blocked, In Review, Done, Verworfen}`. Die **Definition/Validierung** dieses Enums liegt bei agent-flow (`board-schema.md`) — dev-gui spiegelt ihn nur.
- **Keine API-/Schema-Änderung in dev-gui**, kein neuer Endpunkt, keine Board-Datei-Schreibvorgänge durch diese Story.

## Edge-Cases & Fehlerverhalten

- **Leere Verworfen-Spalte** → trotzdem gerendert (konsistent mit den übrigen Spalten), zeigt keinen Karten-Inhalt.
- **Verworfen-Story mit `blocked_reason`** (unwahrscheinlich, da nicht Blocked) → kein Crash; der blocked_reason-Hinweis ist an `status === 'Blocked'` gebunden und wird nicht gezeigt.
- **Echt unbekannter Status** (weder in `STATUS_LIFECYCLE`) → weiterhin `To Do`-Fallback-Bucket (unverändert), damit nichts unsichtbar verschwindet.
- **Fehlender/`null`-Status** → unverändert `To Do`-Fallback (kein Crash).

## NFRs

- **A11y (WCAG 2.1 AA):** Verworfen-Badge über Text kenntlich (nicht nur Farbe), Kontrast ≥ 4.5:1; Filter-Checkbox `Verworfen` ist Teil der Popover-Tab-Ordnung mit sichtbarem Fokusring (erbt vom bestehenden `FilterBar`).
- **Read-only-Garantie:** keine Board-Datei-Schreibvorgänge, kein neuer Input-Pfad, keine Secrets in Ausgabe/Log.
- **Performance:** additive Konstante (+1 Spalte/Checkbox), vernachlässigbar.

## Nicht-Ziele

- **Definition/Validierung des Status-Enums** und das `/agent-flow:flow`-Verhalten (Verworfen wie Done: nicht aufgreifen, zählt als abgeschlossen) — Eigentum von **agent-flow** (`board-schema.md`, `board-lint.sh`), parallele Story.
- **Schreib-/Setz-Pfad für `Verworfen` aus der dev-gui-GUI** (Board bleibt read-only; das Verwerfen einer Story geschieht über Datei/`/flow`, nicht über die GUI).
- **Änderung der Progress-Rollup „X/Y done"** — bleibt unverändert (zählt weiterhin `Done`; Verworfen fließt nicht in den Done-Zähler ein). *(bewusst, konsistent mit [[feature-status-derivation]] Nicht-Zielen)*
- **Feature-Status-Ableitung** und **Archiv-Kriterium** — in ihren eigenen Specs geführt ([[feature-status-derivation]] V7/AC8, [[board-feature-archive]] V7/AC9), hier nur referenziert.

## Abhängigkeiten

- **dev-gui:** `client/src/BoardView.jsx` (`STATUS_LIFECYCLE`, `STATUS_BADGE_STYLES`, Spalten-Gruppierung/Filter). Kein Backend-Delta für **diese** Story (Ableitung/Archiv sind eigene Stories).
- **Specs:** [[studis-kanban-board-ux]] (Board-Ansicht/Filter, generischer `STATUS_LIFECYCLE`-Mechanismus), [[feature-status-derivation]] (V7/AC8 — Verworfen terminal), [[board-feature-archive]] (V7/AC9 — Archiv terminal), [[ideen-inbox]] (Status-Konventionen/`BoardWriter`).
- **Extern:** agent-flow `docs/specs/board-schema.md` + `scripts/board-lint.sh` (Schema-Eigentümer; parallele Story führt `Verworfen` als gültigen Enum-Wert ein).
