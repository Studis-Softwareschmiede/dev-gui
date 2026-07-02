---
id: feature-status-derivation
title: Board — Feature-Status live aus Kind-Stories ableiten (kein manuell gepflegtes Feld mehr)
status: active
version: 2
---

# Spec: Feature-Status live aus Kind-Stories ableiten  (`feature-status-derivation`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig. Source of Truth für coder/tester/reviewer (hartes Drift-Gate).
>
> **Erweitert [[studis-kanban-board-ux]]** und hängt an die bereits im **`BoardAggregator`** vorhandene read-only-Rollup-Berechnung („X/Y done", `computeRollup`) an. Rein lesende Backend-Änderung — kein neuer Endpunkt, keine Board-Datei-Schreibvorgänge, keine Frontend-Änderung.

## Zweck

Heute pflegt jedes Feature ein **eigenes, unabhängiges `status`-Feld** in `board/features/*.yaml` (z.B. „Backlog", „Done"), das **nicht zwangsläufig zum tatsächlichen Zustand seiner Stories passt** — Praxisbeispiel: Feature „Claude-Auth-Health" zeigt „Backlog", obwohl seine einzige Story S-209 bereits „Done" ist. Diese Spec ersetzt das manuell gepflegte Feld durch einen **live aus den Kind-Stories abgeleiteten** Feature-Status — analog zur bestehenden Fortschritts-Rollup „X/Y done", die schon read-only im `BoardAggregator` berechnet wird. Damit kann der Feature-Status **nie mehr vom Story-Zustand abweichen** (Drift beseitigt).

## Kontext / Designentscheidungen (vom requirement-Agenten getroffen; Owner-Delegation)

> Der Owner hat die **Ableitungsregel** vollständig vorgegeben und **zwei** Umsetzungsdetails ausdrücklich an den requirement-Agenten delegiert. Beide sind hier bindend dokumentiert; der Owner kann sie im Cut-PR revidieren.

- **Entscheidung A — Computed/live statt persistiert (bindend).** Der Feature-Status wird **rein lesend** im `BoardAggregator` berechnet (wie `computeRollup`), **immer** — das persistierte `status:`-Feld in `board/features/*.yaml` wird für die Anzeige **nicht mehr gelesen** und **nicht** synchron nachgezogen. **Begründung:** (1) konsistent mit dem bestehenden read-only-Aggregator (dessen Read-only-Garantie: keine Schreibzugriffe auf `board/`-Dateien) und der Projekt-Doktrin „State: live aus GitHub-API + Docker, keine eigene DB"; (2) genau derselbe Ort/dasselbe Muster wie die schon vorhandene Progress-Rollup; (3) **beseitigt die gemeldete Drift restlos** — ein persistiertes Feld müsste bei jedem Story-Status-Wechsel synchron über `BoardWriter` nachgezogen werden (mehr Code, mehr Kopplung, weiterhin drift-anfällig bei manuellen Edits / `/flow`-Schreibvorgängen); (4) kostenfrei — keine Schreibvorgänge, keine Lock-Contention. Die Progress-Rollup bevorzugt heute noch einen persistierten Wert und rechnet nur bei fehlendem/`null`-Wert nach; der Feature-**Status** dagegen wird **immer neu abgeleitet** (das persistierte Feld gilt als unzuverlässig — genau das ist der gemeldete Bug).
- **Entscheidung B — Default bei „gar keine (zählbaren) Stories" = `Backlog`.** Hat ein Feature nach Ausschluss der Idee-Stories **keine** verbleibende Story, ist der abgeleitete Status **`Backlog`** (nichts committet/in der Pipeline). Gewählt statt „To Do", weil „Backlog" das „noch nichts angefangen"-Semantik korrekt vom „hat eine To-Do-Story bereit"-Zustand abgrenzt; „Backlog" ist bereits als Feature-Status in Gebrauch (14 Features) und rendert im vorhandenen `StatusBadge` über den `_default`-Stil (kein neuer Badge-Ton nötig).

## Verhalten

### V1 — Ausschluss der Idee-Stories (Priorität 1, vor allem anderen)
Stories mit `status: Idee` werden bei der Ableitung **vollständig ausgeschlossen** (nicht mitgezählt) — sie sind noch nicht committet. Alle folgenden Regeln (V2–V4) beziehen sich ausschließlich auf die **verbleibenden** Stories.

### V2 — Blocked gewinnt (höchste Priorität)
Ist nach Ausschluss der Idee-Stories **mindestens eine** verbleibende Story `Blocked` → Feature-Status = **`Blocked`**. Dies überschreibt jede andere Ableitung (soll sofort sichtbar sein, weil das Feature Aufmerksamkeit braucht).

### V3 — „Das Schwächste gewinnt" (weakest-wins)
Gibt es (nach V1) **keine** Blocked-Story, entspricht der Feature-Status dem **am wenigsten fortgeschrittenen** Status unter den verbleibenden (nicht-Idee, nicht-Blocked) Stories, in dieser Fortschritts-Reihenfolge (schwächste zuerst):

> **To Do < In Progress < In Review < Done**

Konkret, von oben nach unten geprüft:
- mindestens eine Story `To Do` → Feature = **`To Do`**;
- sonst mindestens eine `In Progress` → Feature = **`In Progress`**;
- sonst mindestens eine `In Review` → Feature = **`In Review`**;
- sonst (alle verbleibenden `Done`) → Feature = **`Done`**.

### V4 — Randfall „keine zählbaren Stories" (Default)
Hat ein Feature **gar keine** Stories **oder nur Idee-Stories** (die nach V1 ausgeschlossen werden), sodass **keine** verbleibende Story übrig bleibt → Feature-Status = **`Backlog`** (Entscheidung B).

### V5 — Ableitung ist immer autoritativ (persistiertes Feld wird ignoriert)
Der `BoardAggregator` setzt den ausgegebenen `feature.status` **immer** auf den nach V1–V4 abgeleiteten Wert — **unabhängig** vom persistierten `status:`-Feld im Feature-YAML. Das persistierte Feld wird **nicht** gelesen (für die Anzeige), **nicht** geschrieben und **nicht** entfernt; es bleibt byte-genau in der Datei (read-only-Aggregator) und ist damit obsolet. Die bestehende Progress-Rollup („X/Y done") bleibt **unverändert**.

### V6 — Unbekannter Story-Status
Trägt eine (nicht-Idee-)Story einen Status **außerhalb** der bekannten Skala `{To Do, In Progress, Blocked, In Review, Done, Verworfen}`, wird er in der weakest-wins-Ordnung als **schwächste** bekannte Stufe (`To Do`) behandelt — konsistent mit dem Frontend, das unbekannte Story-Status im `byStatus`-Fallback der `To Do`-Spalte zuordnet. So verschwindet ein unerwarteter Status nie fälschlich als „Done". *(`Verworfen` ist ab V7 ein **bekannter** terminaler Wert und fällt nicht in diesen Fallback.)*

### V7 — Story-Status „Verworfen" ist terminal (Done-äquivalent) — fortgeschrieben v2
Der terminale Story-Status **`Verworfen`** (Won't-Do/obsolet, siehe [[board-status-verworfen]]) zählt in der Ableitung **wie `Done`** — er ist die **stärkste/terminale** Stufe der Fortschritts-Skala. Konkret:
- `Verworfen` wird **nicht** ausgeschlossen (anders als `Idee`), sondern als **`Done`-äquivalent** (gleicher, höchster Fortschrittsindex) in die weakest-wins-Ordnung eingerechnet.
- **Blocked-Priorität (V2) bleibt unberührt:** eine `Blocked`-Story gewinnt weiterhin über alles.
- **Ergebnis-Label:** Kollabiert die Ableitung auf die terminale Stufe (alle verbleibenden Stories sind `Done` und/oder `Verworfen`), ist der Feature-Status **`Done`** — `Verworfen` erscheint **nie** als abgeleiteter Feature-Status.

Folgerungen (bindend, für Tests):
- Feature mit **nur** `Verworfen`-Stories (kein `Done`) → **`Done`** (alle terminal).
- Feature mit **`Done` + `Verworfen`** → **`Done`**.
- Feature mit **`To Do` + `Verworfen`** → **`To Do`** (weakest-wins; die nicht-terminale Stufe gewinnt).
- Feature mit **`Idee` + `Verworfen`** → Idee ausgeschlossen (V1), bleibt nur terminal → **`Done`**.
- Feature mit **`Blocked` + `Verworfen`** → **`Blocked`** (V2-Priorität).

## Acceptance-Kriterien

- **AC1** — Der `BoardAggregator` leitet je Feature einen Status ausschließlich aus den Kind-Stories ab und schließt dabei alle Stories mit `status: Idee` vollständig von der Zählung aus. *(V1)*
- **AC2** — Ist nach Ausschluss der Idee-Stories mindestens eine verbleibende Story `Blocked`, ist der abgeleitete Feature-Status `Blocked` — unabhängig davon, welche anderen Status vorkommen (höchste Priorität). *(V2)*
- **AC3** — Ohne Blocked-Story ist der abgeleitete Status der schwächste vorkommende in der Reihenfolge To Do < In Progress < In Review < Done: gibt es eine `To Do` → `To Do`; sonst eine `In Progress` → `In Progress`; sonst eine `In Review` → `In Review`; sonst (alle verbleibenden `Done`) → `Done`. *(V3)*
- **AC4** — Hat ein Feature keine Stories oder nur Idee-Stories (keine verbleibende zählbare Story), ist der abgeleitete Status `Backlog`. *(V4)*
- **AC5** — Der vom Aggregator ausgegebene `feature.status` entspricht IMMER dem abgeleiteten Wert (V1–V4) und ignoriert das persistierte `status:`-Feld im Feature-YAML; es findet KEIN Schreiben/Ändern/Entfernen von `board/`-Dateien statt (read-only-Garantie unverändert), und die Progress-Rollup „X/Y done" bleibt unverändert. *(V5)*
- **AC6** — Eine nicht-Idee-Story mit einem Status außerhalb `{To Do, In Progress, Blocked, In Review, Done, Verworfen}` wird in der Ableitung als schwächste Stufe (`To Do`) behandelt (nie fälschlich als `Done`). *(V6)*
- **AC7** — Das Pseudo-Feature `_orphaned` (verwaiste Stories/Ideen) ist von der Ableitung ausgenommen und behält `status: null` (die Regel gilt nur für echte Features). *(Edge-Case)*
- **AC8** — `Verworfen`-Stories zählen in der Ableitung als terminal (`Done`-äquivalent, höchster Fortschrittsindex), werden NICHT wie `Idee` ausgeschlossen, und ändern die Blocked-Priorität nicht. Folge: nur `Verworfen` → `Done`; `Done`+`Verworfen` → `Done`; `To Do`+`Verworfen` → `To Do`; `Blocked`+`Verworfen` → `Blocked`. Der abgeleitete Feature-Status ist nie `Verworfen` (kollabiert auf `Done`). *(V7)*

## Verträge

- **Keine API-/Schema-Änderung.** Die bestehende Board-Liste (`/api/board/projects…`) liefert weiterhin je Feature `status` + `progress`; neu ist nur, dass `status` ein **abgeleiteter** Wert ist. Der Wertebereich von `feature.status` ist `{Backlog, To Do, In Progress, Blocked, In Review, Done}` (`null` nur für `_orphaned`).
- **Ort:** neue reine Ableitungs-Funktion (z.B. `computeFeatureStatus(stories)`) in `src/BoardAggregator.js`, angewandt in `_readBoard` unmittelbar bei/nach der bestehenden `computeRollup`-Berechnung; überschreibt das aus dem YAML gelesene `feature.status` bedingungslos.
- **Ordnungs-Skala (bindend, für Tests):** `Blocked` (Sonderfall, höchste Priorität) — sonst `To Do`(0) < `In Progress`(1) < `In Review`(2) < `Done`(3); **`Verworfen` wird auf denselben terminalen Index wie `Done`(3) abgebildet** (Done-äquivalent, V7). Ergebnis = Status mit **kleinstem** Index unter den verbleibenden Stories; kollabiert der kleinste Index auf die terminale Stufe (3), ist das Ergebnis-Label **`Done`** (nie `Verworfen`).
- **Frontend:** unverändert. `client/src/BoardView.jsx` rendert `feature.status` bereits via `StatusBadge` und nutzt ihn in `isFeatureDone` (Collapse-Default); beides profitiert automatisch vom korrigierten Wert, ohne Codeänderung.

## Edge-Cases & Fehlerverhalten

- **Feature ohne Stories** → `Backlog` (V4).
- **Feature nur mit Idee-Stories** → `Backlog` (Ideen ausgeschlossen, dann keine verbleibende → V4).
- **Idee + Done gemischt** → Idee ausgeschlossen; bleibt nur `Done` → `Done`.
- **Blocked + Done + Idee** → Idee raus, Blocked gewinnt → `Blocked`.
- **Nur Verworfen** (kein Done) → alle terminal → `Done` (V7/AC8).
- **Done + Verworfen** → beide terminal → `Done` (V7/AC8).
- **To Do + Verworfen** → weakest-wins, nicht-terminale Stufe gewinnt → `To Do` (V7/AC8).
- **`_orphaned`-Pseudo-Feature** → `status: null`, nicht abgeleitet (AC7).
- **Story mit fehlendem/`null`-Status** → wie unbekannter Status behandelt (schwächste Stufe `To Do`, V6/AC6) — kein Crash.
- **Archivierte Features** ([[board-feature-archive]]) → die Ableitung ist orthogonal zum `archived`-Flag/Filter; im „Archiv anzeigen"-Modus leitet ein voll-erledigtes Feature korrekt `Done` ab. Der `archived`-Filter bleibt unverändert.
- Fehlertoleranz wie im übrigen Aggregator: defekte/teilweise geparste Stories dürfen die Ableitung nicht crashen (best effort, Default greift).

## NFRs

- **Read-only-Garantie:** keine Schreibzugriffe auf `board/`-Dateien; kein persistenter Cache; die Ableitung ist eine reine In-Memory-Berechnung beim Scan.
- **Performance:** O(#Stories je Feature), vernachlässigbar; identisches Kostenprofil wie `computeRollup`.
- **Security:** kein neuer Input-Pfad, keine Secrets in Ausgabe/Log.

## Nicht-Ziele

- **Entfernen des obsoleten persistierten `status:`-Felds** aus `board/features/*.yaml` (mögliche spätere Aufräum-/reconcile-Aufgabe; hier bewusst nicht, um rein lesend/risikoarm zu bleiben).
- **Synchrones Nachziehen** eines persistierten Feature-Status über `BoardWriter` (bewusst verworfen — Entscheidung A).
- **Änderung der Progress-Rollup „X/Y done"** (zählt weiterhin alle Stories inkl. Idee — nicht Teil dieser Anforderung).
- **Frontend-/Badge-Änderungen** (der bestehende `StatusBadge` rendert alle Werte inkl. `Backlog` über `_default`).
- **Neuer Endpunkt / API-Vertrags-Änderung.**

## Abhängigkeiten

- **dev-gui:** `src/BoardAggregator.js` (`computeFeatureStatus()` + Anwendung in `_readBoard`).
- **Specs:** [[studis-kanban-board-ux]] (Board-Übersicht/Aggregator-Basis), [[board-feature-collapse]] (nutzt `feature.status` im Collapse-Default), [[board-feature-archive]] (orthogonaler `archived`-Filter), [[ideen-inbox]] (Story-Status `Idee`), [[board-status-verworfen]] (führt den terminalen Status `Verworfen` ein; V7/AC8 dieser Spec setzt die Ableitungs-Semantik dafür um).
</content>
</invoke>
