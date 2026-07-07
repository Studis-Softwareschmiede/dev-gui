---
id: drain-origin-progress-sync
title: Taktgeber-Fortschrittserkennung auf aktuellem Board-Stand — origin-basierte Aussensicht bei merge_policy=pr
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Taktgeber-Fortschrittserkennung auf aktuellem Board-Stand  (`drain-origin-progress-sync`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der Taktgeber ([[taktgeber-nachtwaechter]] / `ProjectDrain`) bewertet Fortschritt, Eskalation und Abschlussbericht heute **ausschliesslich** aus dem **lokalen Working-Tree-Checkout** eines gedrainten Projekts (`/workspace/<projekt>`, gelesen über `BoardAggregator`). Bei Projekten mit **`merge_policy: pr`** (z.B. agent-flow) landen die `/flow`-Sessions ihre Board-Flips (`→ Done`) jedoch **per PR auf `origin/<default_branch>`** — der lokale Checkout, den `ProjectDrain`/`BoardAggregator` lesen, wird dabei **nicht** nachgezogen. Die **Aussensicht** des Taktgebers arbeitet dann auf **stalem** Stand.

## Kontext / Problem (verifizierter Vorfall 2026-07-07, ~15:00 UTC)
Beim agent-flow-Drain (`merge_policy: pr`) landeten S-053/S-054/S-055 als `Done` auf `origin/main`. Der lokale Checkout blieb auf `To Do`. Folge:
- Der Taktgeber wertete für die bereits gelandeten Storys dauerhaft `To Do`, zählte **„3× kein Fortschritt"** und schrieb fälschlich `status: Blocked` / `blocked_reason: "Taktgeber: 3x kein Fortschritt"` in die **lokalen** Board-Dateien — im **Widerspruch** zu `origin`.
- Der **Abschlussbericht** ([[drain-completion-report]]) meldete dieselben Storys als „escalated/blocked", obwohl **alle** Storys des Laufs auf `origin` erfolgreich `Done` waren.
- Der Lauf selbst funktionierte (die `/flow`-Sessions fetchen selbst in ihren Worktrees, [[board-abarbeitungs-strategie]]) — **nur** die Aussensicht (Fortschrittsbewertung, Eskalation, Abschlussbericht) war veraltet.
- Bei `merge_policy: direct`-Projekten tritt das **nicht** auf: Flips erreichen den lokalen Checkout direkt.

## Gewählte Lösung — origin-basierte, mutationsfreie Aussensicht (Variante b, verfeinert)

**Bindend:** Der Taktgeber leitet seinen Board-Snapshot für **Fortschritt, Stale-Erkennung, Drain-Ziel-Auswahl, Eskalation und Abschlussbericht** aus dem **verifiziert-aktuellen** Board-Stand ab — read-only, **ohne jede** Mutation des Working-Trees.

Mechanismus je Drain-Runde, **vor** der Bewertung:
1. **Read-only `git fetch`** des Projekt-Remotes (`origin`). Ein Fetch aktualisiert nur `.git/refs` — er berührt den Working-Tree **nie**.
2. **Truth-Ref-Auswahl (ancestry-basiert, policy-agnostisch, regressionsfrei):**
   - Existiert ein Remote-Tracking-Ref (`@{u}` bzw. `origin/<default_branch>`) **und** ist der lokale `HEAD` ein **echter Vorfahr** davon (`origin` strikt voraus, d.h. der lokale Checkout ist **zurück**) → der Board-Snapshot wird **aus dem Remote-Tracking-Ref** berechnet (read-only Git-Objekt-Lese, kein Datei-Write).
   - **Sonst** (kein Upstream, `HEAD` == `origin`, `HEAD` **voraus** von `origin`, oder Fetch fehlgeschlagen) → der Snapshot wird wie bisher aus dem **Working-Tree** berechnet.
   - Diese Regel fixt den `pr`-Fall (Flip auf `origin`, lokal zurück → `origin`-Snapshot) und **regressiert** `direct`-Projekte **nie**: bei `direct` landet der Flip lokal, `HEAD ≥ origin` → Working-Tree bleibt Quelle (heutiges, korrektes Verhalten), auch wenn ein `direct`-Projekt **nicht** nach `origin` pusht.
3. **Verifiziert-aktuell = Voraussetzung jeder Eskalation.** Ein Snapshot gilt als **verifiziert-aktuell**, wenn der Fetch **erfolgreich** war (unabhängig davon, ob danach der `origin`-Ref oder der bestätigt-nicht-zurückliegende Working-Tree gelesen wird). Schlug der Fetch **fehl** (offline/transient), ist der Snapshot **unverifiziert**.

**Leitplanken (Trauma-konform, Vorfall 2026-07-02 „stiller Datenverlust im geteilten Hauptordner"):**
- Der Taktgeber führt **keinerlei** working-tree-mutierende Git-Operation aus — **kein** `pull`/`merge`/`checkout`/`reset`/`clean`/`stash`. Ausschliesslich `fetch` (refs) + read-only Objekt-Lese.
- **Eskalation (`setBlocked`) nur auf verifiziert-aktuellem Stand.** Ist der Snapshot unverifiziert (Fetch-Fehler), wird in dieser Runde **kein** `Blocked` geschrieben — Log + Retry im nächsten Tick. Der kein-Fortschritt-Zähler wird durch einen unverifizierten Lauf **nicht** hochgezählt (kein Increment auf stalem Stand).
- Ein **dirty** Working-Tree wird **nie** angetastet und löst **nie** eine Eskalation auf stalem Stand aus: wird der `origin`-Ref gelesen, sind uncommittete lokale Änderungen für die Bewertung irrelevant; wird der Working-Tree gelesen und ist der Stand unverifiziert, wird die Eskalation übersprungen + geloggt.

### Warum Variante (b) und nicht (a) (fetch + ff-only pull)
Variante (a) — vor jeder Bewertung `fetch` + `ff-only pull` des Projekt-Checkouts (nur bei sauberem Tree, sonst Skip) — wurde **bewusst verworfen**:
- **(a) mutiert den Working-Tree.** Auch ein `ff-only pull` schreibt Dateien im **geteilten** `/workspace/<projekt>`-Checkout und kann parallele Reader/`/flow`-Sessions mitten im Scan überraschen; jede Working-Tree-Mutation im geteilten Hauptordner ist das bekannte Trauma dieses Repos (Vorfall 2026-07-02). Variante (b) berührt **nur** `.git/refs` (fetch) + liest Objekte — **null** Working-Tree-Mutation.
- **(a) fixt den dirty-Fall nicht.** Bei dirty Tree **skippt** (a) den Pull und wertet damit **weiter stal** — der `pr`-Bug bliebe bei dirty Tree offen. (b) liest den `origin`-Ref **unabhängig** vom Tree-Zustand und ist auch bei dirty Tree korrekt.
- **(a) eskaliert-oder-skippt binär.** (b) trennt sauber: verifiziert → korrekte Bewertung inkl. zulässiger Eskalation; unverifiziert (nur bei Fetch-Fehler) → keine Eskalation, Retry.

Preis von (b): der Board-Scan muss aus einem Git-Ref lesen können (statt nur aus dem Dateisystem) — eine bewusst akzeptierte, gekapselte Erweiterung des **Lese**-Pfads. Der Drain-/Abbruch-/Eskalations-**Logik** ([[taktgeber-nachtwaechter]] AC1–AC5) bleibt unverändert; nur die **Quelle** des Snapshots + das **Eskalations-Gate** kommen hinzu.

## Verhalten
1. **Fetch vor Bewertung.** Zu Beginn jeder Fortschritts-/Eskalations-Bewertung (und vor dem Bilden des Abschlussberichts) führt der Drain je Projekt einen read-only `git fetch origin` aus. Fetch-Fehler sind **non-fatal** (Log, weiter mit Working-Tree-Snapshot, Snapshot als unverifiziert markiert).
2. **Snapshot-Quelle.** Der Board-Snapshot (Story-Status, `ready`-Flag über `computeStoryReadyStatus`, Titel) wird aus dem gemäss Truth-Ref-Auswahl (Zweck-Schritt 2) bestimmten Stand berechnet. Wird der `origin`-Ref gelesen, stammen **alle** dafür nötigen Dateien (`board/stories/*.yaml`, `board/features/*.yaml`, `docs/specs/*.md`) aus **demselben** Ref → konsistenter Snapshot.
3. **Fortschritt.** Fortschritt ([[taktgeber-nachtwaechter]] AC5) wird zwischen zwei **Snapshots dieser Quelle** bestimmt. Eine per PR frisch auf `origin` gelandete Story (`To Do`→`Done`) wird als Fortschritt erkannt → kein-Fortschritt-Zähler wird zurückgesetzt.
4. **Drain-Ziel-Auswahl.** Drain-Ziele ([[taktgeber-nachtwaechter]] AC1/AC3) werden aus demselben Snapshot bestimmt. Eine auf `origin` bereits `Done`-Story ist **kein** Drain-Ziel mehr → kein sinnloser `/flow`-Anstoss auf eine erledigte Story.
5. **Eskalation gated.** `setBlocked` (`BoardWriter`, [[taktgeber-nachtwaechter]] AC4/AC8) greift **nur**, wenn der Snapshot verifiziert-aktuell ist. Unverifiziert → kein Write, kein Zähler-Increment, Log, Retry.
6. **Abschlussbericht.** `completed`/`blocked` ([[drain-completion-report]] AC1) werden aus dem Anfangs-/End-Snapshot **derselben Quelle** abgeleitet → der Bericht spiegelt `origin`. Keine Story erscheint als „blockiert/eskaliert", die auf `origin` `Done` ist.
7. **Audit.** Je Runde ein secret-/pfad-freier `AuditEntry` ([[taktgeber-nachtwaechter]] AC18): gewählte Snapshot-Quelle (`origin-ref` | `working-tree`), Verifiziert-Status, ggf. „Eskalation wegen unverifiziertem Stand übersprungen". Keine absoluten Pfade/Tokens.

## Acceptance-Kriterien

- **AC1** — Der Taktgeber führt **vor** jeder Fortschritts-/Eskalations-Bewertung und vor dem Abschlussbericht je Projekt einen **read-only `git fetch origin`** aus und **niemals** eine working-tree-mutierende Git-Operation (`pull`/`merge`/`checkout`/`reset`/`clean`/`stash`). Ein Fetch-Fehler ist **non-fatal** (Log, weiter, Snapshot als **unverifiziert** markiert), crasht **weder** `ProjectDrain` **noch** `NightWatchScheduler`. *(1)*
- **AC2** — **Truth-Ref-Auswahl (ancestry-basiert):** Nach erfolgreichem Fetch wird der Board-Snapshot aus dem **Remote-Tracking-Ref** (`@{u}`/`origin/<default_branch>`) berechnet **genau dann**, wenn ein Upstream existiert **und** der lokale `HEAD` ein **echter Vorfahr** davon ist (`origin` strikt voraus). Sonst — kein Upstream, `HEAD == origin`, `HEAD` voraus, **oder** Fetch fehlgeschlagen — wird aus dem **Working-Tree** berechnet. Der Snapshot aus dem Ref umfasst konsistent `board/stories/*.yaml`, `board/features/*.yaml` **und** `docs/specs/*.md` desselben Refs. *(2)*
- **AC3** — **`merge_policy=pr`-Regression (Kernfall):** Eine Story, die per PR auf `origin` `Done` ist, im **stalen lokalen Checkout** aber noch `To Do`, wird über den `origin`-Snapshot als **`Done`** erkannt → zählt als **Fortschritt** (kein-Fortschritt-Zähler-Reset), wird **nicht** als Drain-Ziel gewählt und **nicht** eskaliert. Kein `Blocked`-Write in die lokale `board/stories/<id>.yaml` für eine auf `origin` erledigte Story. *(3,4,5)*
- **AC4** — **Kein `Blocked`-Write auf stalem/unverifiziertem Stand:** `setBlocked` (`BoardWriter`, [[taktgeber-nachtwaechter]] AC4) wird **ausschliesslich** auf einem **verifiziert-aktuellen** Snapshot ausgeführt (Fetch erfolgreich). Bei **fehlgeschlagenem** Fetch wird in dieser Runde **kein** `Blocked` geschrieben **und** der kein-Fortschritt-Zähler **nicht** hochgezählt (Log, Retry im nächsten Tick). *(5)*
- **AC5** — **Dirty Working-Tree:** Ein Working-Tree mit uncommitteten Änderungen wird **nie** durch `reset`/`checkout`/`clean`/`pull` verändert und löst **nie** eine Eskalation auf stalem Stand aus. Wird der `origin`-Ref gelesen, sind lokale uncommittete Änderungen für die Bewertung **irrelevant** (Ref-Lese, kein Datei-Read); wird der Working-Tree gelesen und der Stand ist unverifiziert (Fetch-Fehler), wird die Eskalation **übersprungen + geloggt** (Skip statt Reset/Eskalation). *(5)*
- **AC6** — **Abschlussbericht konsistent mit `origin`:** `completed`/`blocked` ([[drain-completion-report]] AC1) werden aus dem Anfangs-/End-Snapshot **derselben** (ggf. `origin`-basierten) Quelle abgeleitet. Keine Story wird als `blocked`/`escalated` gemeldet, die auf `origin` `Done` ist; für `pr`-Projekte spiegeln die Zähler den `origin`-Stand. *(6)*
- **AC7** — **Doku/Drift + Audit:** Ein **ergänzt-Vermerk** in [[taktgeber-nachtwaechter]] (§ProjectDrain-Engine sowie AC4/AC5, „Fortschritt/Board-Scan") hält fest, dass die Snapshot-Quelle für `pr`-Projekte der `origin`-Ref (nach read-only Fetch) ist und Eskalation ein verifiziert-aktuelles `git fetch` voraussetzt — Verweis auf diese Spec (sonst Doktrin-Drift, hartes `reviewer`-Gate). Je Runde ein secret-/pfad-freier `AuditEntry` (Snapshot-Quelle, Verifiziert-Status, ggf. übersprungene Eskalation). **Kein** neuer HTTP-Endpunkt; **keine** Änderung der Drain-/Abbruch-/Eskalations-**Logik** ([[taktgeber-nachtwaechter]] AC1–AC5) über Snapshot-Quelle + Eskalations-Gate hinaus. *(7)*

## Verträge

### Git-Lesezugriff (read-only, pro Projekt)
- **Fetch:** `git -C <projektPfad> fetch --quiet origin` (oder äquivalent). Nur `.git/refs`, **kein** Working-Tree-Write. Timeout-/Fehler-gekapselt (non-fatal).
- **Upstream/Ahead-Bestimmung:** Remote-Tracking-Ref via `@{u}` bzw. `origin/<default_branch>`; „lokaler `HEAD` echter Vorfahr" via `git merge-base --is-ancestor HEAD <ref>` (Exit 0) **und** `HEAD` ≠ `<ref>`.
- **Ref-Snapshot-Lese:** Datei-Inhalt am Ref via `git show <ref>:<pfad>`; Datei-Aufzählung via `git ls-tree -r --name-only <ref> <verzeichnis>`. **Keine** Working-Tree-Interaktion.
- **Fehlerpfade:** kein Remote / kein Upstream / Fetch-Timeout / Ref-Lese-Fehler → Fallback Working-Tree-Snapshot + `unverifiziert` (bei Fetch-Fehler), **kein** Crash.

### Snapshot-Schnittstelle (sprach-neutral)
- Der Board-Scan (`BoardAggregator`-Ebene) erhält eine **Datei-Quelle**-Abstraktion: `working-tree` (heutiges `fs`-Lesen) **oder** `git-ref` (Ref-basierte Lese, obige Verträge). Der `ProjectDrain` wählt die Quelle je Runde gemäss AC2 und markiert den Snapshot `{ source: 'origin-ref'|'working-tree', verified: bool, ref? }`.
- `setBlocked` konsumiert `verified` als hartes Gate (AC4). Der Abschlussbericht-Diff nutzt Anfangs-/End-Snapshot **derselben** Quelle (AC6).

### Wiederverwendung bestehender Bausteine
- `ProjectDrain` (`src/ProjectDrain.js`) — Ort des Fetch + Truth-Ref-Auswahl + Eskalations-Gate; Snapshot-Bildung je Runde (`computeDrainState`) bekommt die Quellen-Abstraktion.
- `BoardAggregator` + `computeStoryReadyStatus` (`src/BoardAggregator.js`) — Scan/`ready`-Regel unverändert, nur die **Datei-Quelle** wird injizierbar (fs ↔ git-ref); bleibt **read-only**.
- `BoardWriter` (`src/BoardWriter.js`, [[taktgeber-nachtwaechter]] AC8) — einziger Blocked-Schreibpfad; jetzt hinter dem `verified`-Gate.
- `NightWatchScheduler` (`src/NightWatchScheduler.js`) — unverändert; erbt die korrekte Bewertung.
- `DrainReportStore` / Abschlussbericht ([[drain-completion-report]]) — unverändert; erbt die `origin`-konsistenten Zähler.
- `AuditStore` (`src/AuditStore.js`) — Runden-Audit (Snapshot-Quelle/Verifiziert-Status).

## Edge-Cases & Fehlerverhalten
- **Fetch schlägt fehl (offline/transient)** → Working-Tree-Snapshot **nur für Fortschritts-Beobachtung** (best-effort), Snapshot `unverified` → **keine** Eskalation, **kein** Zähler-Increment, Log, Retry nächster Tick.
- **Kein Remote / kein Upstream konfiguriert** → Working-Tree-Snapshot (heutiges Verhalten); da kein `origin` existiert, ist der Working-Tree die Wahrheit → als verifiziert behandelbar (keine Fetch-Quelle, die staler sein könnte).
- **`merge_policy: direct` (lokaler Checkout ist Wahrheit)** → `HEAD ≥ origin` → Working-Tree bleibt Quelle; **keine** Verhaltensänderung, **keine** Regression.
- **`origin`-Ref strikt voraus, aber Working-Tree dirty** → `origin`-Ref wird gelesen (read-only); lokale uncommittete Änderungen bleiben **unangetastet** und irrelevant für die Bewertung.
- **Story existiert auf `origin`, aber nicht lokal (oder umgekehrt)** → der jeweils gewählte Snapshot ist maßgeblich; kein Crash bei fehlender Datei am Ref (`git show` schlägt fehl → Story fehlt im Snapshot, wie ein nicht-existierender Eintrag).
- **Malformed YAML am Ref** → gleiche Toleranz wie beim fs-Lesen (überspringen/leerer Eintrag), kein Crash.
- **Detached HEAD / ungewöhnlicher Branch-Zustand** → kein Upstream auflösbar → Fallback Working-Tree.

## NFRs
- **Sicherheit (Floor):** **keine** working-tree-mutierende Git-Operation (kein `pull`/`reset`/`checkout`/`clean`/`stash`) — ausschliesslich `fetch` (refs) + read-only Objekt-Lese. Kein Secret/absoluter Host-Pfad in Audit/Log/Response (nur Slug + Story-ID/Status + Snapshot-Quelle). Git-Kommandos ohne Shell-Interpolation von Fremd-Eingaben (Pfade/Refs aus validierter Projekt-Auflösung, [[drain-restart-robustness]]-Linie).
- **Robustheit/Degradation:** Fetch-/Ref-Lese-Fehler sind non-fatal (best-effort, degradierend); der Drain fällt sauber auf das heutige Working-Tree-Verhalten zurück, **ohne** je auf unverifiziertem Stand zu eskalieren.
- **Korrektheit:** Eskalation (`setBlocked`) ist **monoton sicher** — sie geschieht nur, wenn ein erfolgreicher Fetch den bewerteten Stand als aktuell bestätigt hat. Der Abschlussbericht ist mit `origin` konsistent.
- **Testbarkeit:** injizierbare Git-Lese-Boundary (gemockte `fetch`/`merge-base`/`show`/`ls-tree`) + injizierbare Datei-Quelle → alle AC ohne echten Netz-Fetch und ohne echten `claude`-Lauf prüfbar. Szenarien: (a) `pr`-Projekt lokal zurück → `origin`-Snapshot, Story `Done` erkannt, keine Eskalation; (b) Fetch-Fehler → keine Eskalation, kein Increment; (c) `direct`/`HEAD≥origin` → Working-Tree, unverändert; (d) dirty Tree nie mutiert.

## Nicht-Ziele
- **Kein** `pull`/`merge`/`checkout`/`reset`/`clean`/`stash` durch den Taktgeber (Variante (a) bewusst verworfen).
- **Keine** Änderung der Drain-Ziel-Definition, Abbruch-/Konvergenz-Regel oder Eskalations-Schwelle ([[taktgeber-nachtwaechter]] AC1–AC5) — nur die **Quelle** des Snapshots + das **Eskalations-Gate**.
- **Kein** neuer HTTP-Endpunkt, **keine** neue User-Einstellung.
- **Kein** Schreibpfad in Board-Dateien jenseits des bestehenden `BoardWriter` (status/blocked_reason, hinter dem neuen `verified`-Gate).
- **Kein** Anthropic-API; der `/flow`-Ausführungspfad (Worktrees, eigener Fetch) bleibt unverändert.

## Abhängigkeiten
- [[taktgeber-nachtwaechter]] (`ProjectDrain`-Engine, `BoardAggregator`/`computeStoryReadyStatus`, `BoardWriter`, Fortschritt/Eskalation AC4/AC5/AC8 — Snapshot-Quelle + Eskalations-Gate werden hier verfeinert; ergänzt-Vermerk, AC7) · [[drain-completion-report]] (`completed`/`blocked` erben die `origin`-konsistente Quelle, AC6) · [[headless-parallel-drain]] / [[headless-manual-drain]] (Nacht- + manueller Drain nutzen dieselbe `ProjectDrain`-Engine) · [[board-abarbeitungs-strategie]] (die `/flow`-Sessions fetchen selbst in ihren Worktrees — nur die Aussensicht war betroffen) · [[drain-restart-robustness]] (validierte Slug→Pfad-Auflösung / realpath-Containment für die Git-Kommandos).
</content>
</invoke>
