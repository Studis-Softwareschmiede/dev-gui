---
id: board-filter-feature-status-consistency
title: Board-Status-Filter — Feature-Badge + Leer-Features konsistent mit der gefilterten Story-Menge
status: draft
version: 1
spec_format: use-case-2.0
---

# Spec: Board-Status-Filter — Feature-Badge + Leer-Features konsistent  (`board-filter-feature-status-consistency`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).
>
> **Erweitert [[studis-kanban-board-ux]]** (Status-Filter im Board) und **[[feature-status-derivation]]** (server-seitig abgeleiteter Feature-Status). Rein frontend-seitige Konsistenz-Korrektur; **kein** neuer Endpunkt, **keine** API-/Board-Schema-Änderung.

## Zweck
Der Status-Filter im Kanban-Board filtert heute nur die **Story-Liste** je Feature, lässt aber den **Feature-Status-Badge** unverändert auf dem server-berechneten Wert (über **alle** Kind-Stories). Ergebnis: ein Feature kann trotz aktivem Filter ein rotes **„Blocked"**-Etikett zeigen, obwohl nach dem Filtern **keine** blockierte Story mehr sichtbar ist — ein inkonsistenter Anschein (Owner-Live-Test 2026-07-01). Diese Spec macht den Feature-Badge **konsistent mit der aktuell sichtbaren (gefilterten) Story-Menge** und legt das Verhalten für **leer gefilterte Features** fest.

## Kontext / Root-Cause (per Code-Analyse bestätigt)

- **Server (`src/BoardAggregator.js`):** seit [[feature-status-derivation]] (S-238) wird `feature.status` **einmalig** aus **allen** Kind-Stories abgeleitet (`computeFeatureStatus(feature.stories)`) — `Blocked` hat höchste Priorität. Ein Feature mit auch nur **einer** Blocked-Story bekommt **immer** `status: 'Blocked'`, unabhängig von einem späteren client-seitigen Filter.
- **Client (`client/src/BoardView.jsx`, `filteredProjects`-`useMemo`):** der Status-/Label-Filter filtert **nur** `f.stories` und gibt `{ ...f, stories: filteredStories }` zurück — das server-berechnete **`f.status` bleibt unverändert**. Der `FeatureRow` rendert `feature.status` via `StatusBadge`. → Badge kann `Blocked` zeigen, obwohl die sichtbaren Stories darunter keine Blocked-Story mehr enthalten.
- **Zusätzlich:** Features werden **immer** gerendert, auch wenn ihre gefilterte `stories`-Liste **leer** ist — es gibt kein „Feature ausblenden, wenn keine sichtbaren Stories übrig" unter aktivem Filter. Der bestehende Leer-Hinweis (`totalFilteredStories === 0`) ist derzeit nur für den **Label**-Filter verdrahtet, nicht für den **Status**-Filter. Das Pseudo-Feature `_orphaned` behält laut [[feature-status-derivation]] AC7 **immer** `status: null` und ist gesondert zu behandeln.

## Kontext / Designentscheidungen (vom requirement-Agenten getroffen; Owner-delegiert, im Cut-PR revidierbar)

> Der Owner hat drei Umsetzungsdetails ausdrücklich delegiert (Serverfunktion clientseitig duplizieren vs. Badge aus sichtbaren Stories neu ableiten vs. anderer Ansatz; Leer-Feature-Verhalten; `_orphaned`-Sonderfall). Bindend dokumentiert:

- **Entscheidung A — Badge client-seitig aus der sichtbaren Story-Menge ableiten, mit **einer** logischen Regel-Quelle.** Der Feature-Badge wird im Client aus der **aktuell sichtbaren (gefilterten)** Story-Menge neu berechnet — mit **derselben** Ableitungsregel wie server-seitig ([[feature-status-derivation]] V1–V6: Idee-Ausschluss, Blocked-Prio, weakest-wins `To Do < In Progress < In Review < Done`, unbekannt → schwächste Stufe). **Ohne aktiven Filter** ist die sichtbare Menge = alle Stories → das Ergebnis ist **identisch** zum server-`feature.status` (keine Verhaltensänderung im ungefilterten Fall). **Drift-Vermeidung (bindend):** die Ableitungsregel soll **einmal** existieren — bevorzugt als **geteilte, dependency-freie Pure-Funktion** (z.B. `computeFeatureStatus` aus einem gemeinsamen Modul), die **sowohl** `src/BoardAggregator.js` **als auch** `client/src/BoardView.jsx` importieren. Ist ein Cross-Build-Import wegen der getrennten Vite-Client-Build-Wurzel nicht praktikabel, ist eine **Duplikat-Funktion** im Client zulässig **nur** mit (a) explizitem „keep-in-sync mit `BoardAggregator.computeFeatureStatus`"-Kommentar an **beiden** Stellen **und** (b) einer **geteilten Test-Vektor-Tabelle**, die beide Implementierungen gegen dieselben Fälle prüft. *Begründung:* die Regel ist die einzige Logik, die driften könnte — genau das (Server/Client-Divergenz) ist zu verhindern. Der `architekt`/`coder` wählt den Mechanismus (Shared-Modul bevorzugt), das **Verhalten** ist bindend.
- **Entscheidung B — leer gefilterte Features unter aktivem Filter ausblenden.** Ist ein (echtes) Feature nach dem Filtern **ohne** sichtbare Story **und** ist ein einschränkender Filter aktiv (`hasRestrictingFilter`), wird das Feature **ausgeblendet** (kein leerer Feature-Rumpf mit dann bedeutungslosem Badge). **Ohne** aktiven Filter bleibt das bisherige Verhalten unverändert (ein echtes Feature mit genuin null Stories rendert weiterhin, `Backlog`-Badge). *Begründung:* mit aktivem Filter will der Owner die passende Arbeit sehen — leere Feature-Rümpfe sind Rauschen und waren die Quelle des inkonsistenten Anscheins. Anlehnung an das bestehende `hasRestrictingFilter`-Muster (Collapse-Override) und den vorhandenen Leer-Hinweis.
- **Entscheidung C — `_orphaned`-Pseudo-Feature konsistent mitbehandeln.** `_orphaned` behält `status: null` ([[feature-status-derivation]] AC7) und bekommt **nie** einen abgeleiteten Badge (weder server- noch client-seitig). Unter aktivem Filter wird es wie ein echtes Feature **ausgeblendet**, wenn seine gefilterte Story-Menge leer ist.

## Verhalten

### V1 — Badge aus sichtbaren Stories (echte Features)
1. Für jedes **echte** Feature (nicht `_orphaned`) berechnet der Board-View den angezeigten Status-Badge aus der **aktuell sichtbaren (gefilterten)** Story-Menge dieses Features — mit derselben Regel wie [[feature-status-derivation]] (V1–V6). Der server-gelieferte `feature.status` wird für die Anzeige durch diesen client-abgeleiteten Wert **ersetzt**, sobald ein einschränkender Filter aktiv ist.
2. Ist **kein** einschränkender Filter aktiv, ist die sichtbare Menge = alle Stories; der abgeleitete Wert ist identisch zum server-`feature.status` (der `coder` darf in diesem Fall zur Optimierung direkt `feature.status` verwenden — das Ergebnis muss identisch sein).

### V2 — `_orphaned` ohne Badge
3. Das Pseudo-Feature `_orphaned` (`status: null`, `_orphaned === true`) bekommt **keinen** abgeleiteten Badge — es bleibt ohne Status-Etikett (wie heute, da `feature.status` `null` ist und der Badge nur bei truthy-Status rendert).

### V3 — Leer gefilterte Features ausblenden (nur bei aktivem Filter)
4. Ist ein einschränkender Filter aktiv (`hasRestrictingFilter`) und hat ein Feature (echt **oder** `_orphaned`) nach dem Filtern **keine** sichtbare Story, wird das Feature **nicht gerendert** (ausgeblendet). Ohne aktiven Filter bleibt das Rendering unverändert (leere echte Features rendern weiter).

### V4 — Leer-Hinweis auch für den Status-Filter
5. Führt ein aktiver Filter (Status **und/oder** Label) dazu, dass **keine** Story mehr sichtbar ist (`totalFilteredStories === 0`), zeigt der Board-View den bestehenden, nicht-blockierenden Leer-Hinweis („Keine Stories passen zum aktiven Filter." bzw. „Keine Projekte / Stories passen zum aktuellen Filter.") — bisher nur für den Label-Filter verdrahtet, jetzt auch für den **Status**-Filter. Der bestehende „alle Status deselektiert"-Hinweis ([[studis-kanban-board-ux]] AC3) bleibt unverändert.

## Acceptance-Kriterien

- **AC1** — **Badge = sichtbare Stories (echte Features).** Bei aktivem einschränkenden Filter zeigt der Feature-Status-Badge den aus der **gefilterten** Story-Menge abgeleiteten Status ([[feature-status-derivation]] V1–V6). Konkret: Feature mit Stories `[To Do, Blocked]`, Filter = nur „To Do" → sichtbare Menge `[To Do]` → Badge **„To Do"** (nicht mehr „Blocked"). *(V1)*
- **AC2** — **Ungefilterter Fall unverändert.** Ohne einschränkenden Filter entspricht der angezeigte Feature-Badge exakt dem server-`feature.status` (identisches Ergebnis der Ableitung über alle Stories). *(V1)*
- **AC3** — **Eine logische Regel-Quelle (Drift-Gate).** Die Feature-Status-Ableitung existiert als **eine** dependency-freie Pure-Funktion, die Server und Client teilen (bevorzugt geteiltes Modul). Ist ein geteiltes Modul nicht praktikabel, ist ein Client-Duplikat **nur** mit explizitem keep-in-sync-Kommentar an beiden Stellen **und** einer geteilten Test-Vektor-Tabelle zulässig, die beide Implementierungen gegen dieselben Fälle (Idee-Ausschluss, Blocked-Prio, jede weakest-wins-Stufe, Backlog-Default, unbekannter Status) prüft. Server- und Client-Ableitung liefern für dieselbe Story-Menge **denselben** Wert. *(V1, Entscheidung A)*
- **AC4** — **`_orphaned` ohne Badge.** Das Pseudo-Feature `_orphaned` bekommt weder server- noch client-seitig einen abgeleiteten Status-Badge (bleibt `status: null`, kein Etikett). *(V2, Entscheidung C)*
- **AC5** — **Leer gefilterte Features ausblenden.** Bei aktivem einschränkenden Filter wird ein Feature (echt oder `_orphaned`) mit **null** sichtbaren Stories nach dem Filtern **nicht gerendert**. Ohne aktiven Filter bleibt das Rendering unverändert (leere echte Features rendern weiter). *(V3, Entscheidung B)*
- **AC6** — **Leer-Hinweis für Status-Filter.** Führt ein aktiver Status- und/oder Label-Filter zu `totalFilteredStories === 0` (aber vorhandenen Projekten/Features), zeigt der Board-View den bestehenden nicht-blockierenden Leer-Hinweis — jetzt auch für den Status-Filter (bisher nur Label). Der „alle Status deselektiert"-Hinweis ([[studis-kanban-board-ux]] AC3) bleibt unverändert. *(V4)*

## Verträge

- **Keine API-/Board-Schema-Änderung.** Der Board-Endpunkt liefert `feature.status` (server-abgeleitet, [[feature-status-derivation]]) unverändert; die Konsistenz-Korrektur ist **rein client-seitig** (plus optional die Extraktion der geteilten Pure-Funktion, die den server-seitigen Wert nicht ändert).
- **Geteilte Ableitungs-Funktion:** `computeFeatureStatus(stories) → 'Backlog'|'To Do'|'In Progress'|'Blocked'|'In Review'|'Done'` (bindende Ordnungs-Skala: `Blocked` = höchste Prio; sonst `To Do`(0) < `In Progress`(1) < `In Review`(2) < `Done`(3), kleinster Index gewinnt; leere zählbare Menge → `Backlog`; Idee-Stories ausgeschlossen; unbekannt/fehlend → `To Do`). Identisch zur bestehenden Funktion in `src/BoardAggregator.js`.
- **Frontend (`client/src/BoardView.jsx`):**
  - `filteredProjects`-`useMemo` (oder `FeatureRow`): angezeigter Feature-Badge aus der gefilterten Story-Menge via geteilter Funktion (echte Features); `_orphaned` unangetastet.
  - Feature-Rendering: bei `hasRestrictingFilter && sichtbareStories.length === 0` das Feature überspringen (AC5).
  - Leer-Hinweis-Bedingung (`totalFilteredStories === 0`) auf Status-Filter erweitern (AC6).

## Edge-Cases & Fehlerverhalten
- **Feature `[To Do, Blocked]`, Filter „To Do"** → Badge „To Do", Blocked-Story nicht sichtbar → konsistent (der gemeldete Bug).
- **Feature `[Blocked]`, Filter „To Do"** → sichtbare Menge leer → Feature ausgeblendet (AC5), kein irreführender Badge.
- **Feature `[Done]`, Filter „Done"** → Badge „Done".
- **Feature nur Idee-Stories, Filter „Idee"** → Idee-Stories werden bei der Ableitung ausgeschlossen → sichtbare zählbare Menge leer → Badge-Ableitung `Backlog`; ist die sichtbare Story-Menge (inkl. Idee) leer, greift AC5 (Ausblenden). *(Konsistent mit [[feature-status-derivation]] V1/V4.)*
- **`_orphaned` mit gefilterten Stories** → rendert ohne Status-Badge (AC4); leer gefiltert → ausgeblendet (AC5/Entscheidung C).
- **Kein Filter aktiv** → keine Änderung gegenüber heute (AC2); leere echte Features rendern weiter.
- **Defekte/teilweise geparste Story** → Ableitung degradiert wie server-seitig (best effort, kein Crash); unbekannter/fehlender Status → schwächste Stufe.

## NFRs
- **Read-only:** rein anzeigende Berechnung im Client; keine Board-/API-Mutation, kein neuer Netzwerk-Call.
- **Performance:** O(#sichtbare Stories je Feature), vernachlässigbar (identisches Profil wie die bestehende Rollup-/Filter-Berechnung).
- **A11y:** `StatusBadge` unverändert (Bedeutung per Text, nicht nur Farbe); Leer-Hinweis `role=status`.
- **Security:** kein neuer Input-/Netzpfad, keine Secrets in Ausgabe/Log.

## Nicht-Ziele
- **Keine** Änderung am server-seitig abgeleiteten `feature.status` ([[feature-status-derivation]] bleibt gültig) — nur die **Anzeige** unter aktivem Filter wird konsistent gemacht.
- **Keine** API-/Endpunkt-/Board-Schema-Änderung.
- **Keine** Änderung an der Progress-Rollup „X/Y done".
- **Keine** neue Filter-Dimension / kein neues Filter-UI (nur Konsistenz des bestehenden Status-/Label-Filters).
- **Kein** Entfernen des obsoleten persistierten `status:`-Felds (bleibt [[feature-status-derivation]] Nicht-Ziel).

## Abhängigkeiten
- [[feature-status-derivation]] (server-seitige Ableitung `computeFeatureStatus`, `_orphaned`-Sonderfall AC7 — **geteilte/gespiegelte Regel**) · [[studis-kanban-board-ux]] (Status-/Label-Filter, Leer-Hinweise, `StatusBadge`, AC3 „alle deselektiert") · [[board-feature-collapse]] (`hasRestrictingFilter`-Muster) · [[board-feature-archive]] (orthogonaler `archived`-Filter, unverändert) · `client/src/BoardView.jsx` · `src/BoardAggregator.js` (`computeFeatureStatus`).
</content>
