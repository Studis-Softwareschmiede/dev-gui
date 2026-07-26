---
id: drain-escalation-effectiveness
title: Taktgeber-Eskalation wirksam + ehrlicher Sicherheitsgürtel — Endlosschleife strukturell unmöglich
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Taktgeber-Eskalation wirksam + ehrlicher Sicherheitsgürtel  (`drain-escalation-effectiveness`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der Taktgeber (`ProjectDrain`, [[taktgeber-nachtwaechter]]) kann in eine **selbstverstärkende Endlosschleife** geraten, in der er stunden­lang fortschrittslose `/flow`-/Feature-Drain-Runden anstößt, ohne je zu einem definierten Ende zu kommen. Diese Spec macht die **Eskalation wirksam** und den **Sicherheitsgürtel ehrlich**, sodass der beobachtete Vorfall **strukturell unmöglich** wird.

## Kontext / Verifizierter Vorfall 2026-07-26 („Taktgeber-Endlosschleife")
Ein manueller Drain lief ~1,5 h im Kreis (149 `claude`-Sessions, keine Story fertig; nur per Container-Neustart gestoppt). Verifizierte Kausalkette:

1. **Eskalations-Write und Snapshot-Quelle inkonsistent (Kern-Bug).** `#escalate` schreibt `status: Blocked` + `blocked_reason: "Taktgeber: 3x kein Fortschritt"` über `BoardWriter.setBlocked` **nur** in den **Working-Tree** des Ausführungs-Klons (kein Commit, kein Push). `#findProject` liest den Runden-Snapshot aber gemäß [[drain-origin-progress-sync]] AC2 **bevorzugt aus dem `origin`-Ref** (Quelle `origin-ref`), sobald der lokale `HEAD` hinter `origin` zurückliegt (Fetch erfolgreich, `origin` strikt voraus). Folge (a): die Eskalation wird im Snapshot **nie** sichtbar → die Story bleibt Drain-Ziel.
2. **Falscher Fortschritts-Reset.** `#runLoop` wertete die „gelungene" Eskalation (BoardWriter-Write erfolgreich) trotzdem als Fortschritt und setzte `totalNoProgressRounds = 0` (der Sicherheitsgürtel-Zähler) **unbedingt** zurück — auch wenn die Eskalation im Folge-Snapshot nie erschien. Folge (b): der Sicherheitsgürtel (`safetyMaxNoProgressRounds`, Default 50) griff **nie**.
3. **Dirty-Leichen.** Die Working-Tree-Blocked-Writes blieben als uncommittete Dateien liegen (im Container nachgewiesen: S-385/S-389/S-391/S-407/S-410/S-413) — Nährboden für die Klon-Kaskade ([[drain-clone-precondition-sync]] BEFUND 3).

Zusammengefasst: die Eskalation war **unwirksam** (write-Ebene ≠ snapshot-Ebene), aber der Zähler-Reset behandelte sie als **wirksam** → der einzige garantierte Notausstieg wurde neutralisiert → Endlosschleife.

## Gewählte Lösung + getroffene Annahmen (mangels Rückfrage-Kanal explizit dokumentiert)
Der `requirement`-Subagent hat keinen Owner-Rückfrage-Kanal; die folgenden Design-Entscheidungen sind token-bewusst + doktrin-konform getroffen (idempotent, degradierend, read-only Aussensicht) und **AC-tragend** — vom Owner bei Abnahme revidierbar (dann Spec + AC nachziehen).

- **A1 — Wirksamkeits-Check statt commit+push (bewusst).** Der Taktgeber **committet/pusht die Eskalation NICHT** auf `origin`. Begründung: (1) das widerspräche der harten **read-only Aussensicht**-Doktrin von [[drain-origin-progress-sync]] (NFR: „**keine** working-tree-mutierende Git-Operation … ausschließlich `fetch` + read-only Objekt-Lese"); (2) ein Push vom **geteilten, veralteten** Ausführungs-Klon ist fragil (Non-Fast-Forward auf tagelang zurückliegendem `HEAD`) und trägt das Trauma des geteilten Hauptordners (Vorfall 2026-07-02). Stattdessen wird die **Wirksamkeit geprüft**: eine Eskalation zählt nur dann als Fortschritt (Zähler-Reset), wenn sie in einem **Folge-Snapshot derselben Quelle** als `Blocked` **sichtbar** wird. Das macht den Sicherheitsgürtel ehrlich und garantiert Terminierung — der eigentliche Kern-Bug (Punkt 2 oben) ist der falsche Reset, nicht das fehlende Push.
- **A2 — In `origin-ref`-Quellenmodus wird gar nicht geschrieben.** Ist die Snapshot-Quelle dieser Runde `origin-ref` (Klon hinter `origin`, [[drain-origin-progress-sync]] AC2), wäre ein Working-Tree-`setBlocked` **per Konstruktion** unsichtbar **und** eine Dirty-Leiche. Daher unterlässt der Taktgeber in diesem Modus den `setBlocked`-Write vollständig (Audit-Vermerk) und behandelt die Runde als **unwirksame/unmögliche Eskalation**, die die gebundene Terminierung (AC3) speist. So bleibt der Klon sauber (kein Dirty-Artefakt) und die Story wird **nicht** fälschlich auf `Blocked` gesetzt. Im `working-tree`-Quellenmodus (`HEAD ≥ origin`, der Working-Tree **ist** die Wahrheit — u.a. aktueller Klon / `merge_policy: direct`) schreibt die Eskalation wie bisher (legitim, sichtbar).
- **A3 — Per-Story-Eskalations-Cap.** Eine in dieser Drain-Session bereits (versucht) eskalierte Story wird **nicht erneut** als Eskalations-Opfer gewählt. Verhindert das beliebig häufige Re-Eskalieren derselben Story im unwirksamen Fall.

## Verhalten

### Ehrlicher Sicherheitsgürtel (Kern-Fix)
1. Der **unbedingte** `totalNoProgressRounds = 0`-Reset **nach** einem erfolgreichen `#escalate` entfällt. `totalNoProgressRounds` (Sicherheitsgürtel-Zähler) wird **ausschließlich** durch **echt beobachteten Fortschritt** zurückgesetzt — d.h. durch eine Status-/`ready`-Änderung im Snapshot-Diff derselben Quelle ([[taktgeber-nachtwaechter]] AC5). Eine Eskalation zählt genau dann als Fortschritt, wenn ihr `Blocked`-Übergang in einem **Folge-Snapshot derselben Quelle** erscheint (Wirksamkeits-Check). Im `working-tree`-Modus geschieht das natürlich in der nächsten Runde (der Write **ist** die Snapshot-Quelle) → regulärer `progressed`-Reset. Im `origin-ref`-Modus erscheint er nie → **kein** Reset.
2. **Kein Regress im gesunden Fall:** ein Board mit vielen nacheinander eskalierten Stories im `working-tree`-Modus löst den Sicherheitsgürtel **nicht** fälschlich aus — jede wirksame Eskalation ist echter, im nächsten Scan sichtbarer Fortschritt und setzt den Zähler regulär zurück (die frühere Sorge, die den unbedingten Reset motivierte, greift nur im **unwirksamen** Fall, den diese Spec gezielt terminiert).

### Eskalation nur wirksam schreiben (kein Dirty-Klon)
3. Vor jedem `setBlocked` prüft der Taktgeber die **Quelle** des aktuellen Snapshots ([[drain-origin-progress-sync]] `{ source }`): `working-tree` → schreiben (wie heute, hinter dem bestehenden `verified`-Gate, [[drain-origin-progress-sync]] AC4); `origin-ref` → **nicht** schreiben (A2), Runde als unwirksame Eskalation zählen, Audit-Vermerk. Der Taktgeber hinterlässt so **keine** eigene Blocked-Leiche im Klon, wenn sie ohnehin unsichtbar bliebe.

### Per-Story-Eskalations-Cap
4. Der Taktgeber führt je Drain-Session eine Menge der bereits (versucht) eskalierten Story-IDs. `pickLongestUnmovedTarget` wählt **nur** Ziele, die **noch nicht** in dieser Menge sind. Sind alle aktuellen Drain-Ziele bereits (versucht) eskaliert und ist keine Wirksamkeit eingetreten → keine weitere Eskalation, Übergang zur gebundenen Terminierung (AC3).

### Gebundene Terminierung (Endlosschleife strukturell unmöglich)
5. Der Drain endet in **endlicher** Rundenzahl, auch wenn **jede** Eskalation unwirksam ist und **jede** `/flow`-/Feature-Drain-Runde fruchtlos bleibt: sobald ein Eskalations-Zyklus ausgelöst wurde, keine Drain-Ziel-Story fortschreitet **und** alle aktuellen Drain-Ziele bereits (versucht) eskaliert sind (bzw. Eskalation strukturell unwirksam ist), stoppt der Drain mit dem **eigenen terminalen** `reason: 'escalation-ineffective'`. Der bestehende Sicherheitsgürtel (`safety-stop-no-progress`, Default 50) bleibt als **unabhängiger** Backstop erhalten. Die Rundenzahl ist damit durch `O(#Drain-Ziele × escalationAttempts)` bzw. `safetyMaxNoProgressRounds` **hart begrenzt** — **kein** unbegrenzter Loop.
6. **Wiederholt scheiternder Feature-Drain/`/flow` (`failed`/„WARTET").** Eine Runde, die ohne beobachtbare Zustandsänderung endet — inklusive eines Feature-Drain-Kindprozesses, der `failed`/„WARTET" liefert (z.B. am Feature-Branch-Checkout scheitert, [[drain-clone-precondition-sync]] BEFUND 3) — inkrementiert `consecutiveNoProgress`/`totalNoProgressRounds` **regulär** und wird **nie** fälschlich als Fortschritt gewertet. N solche Runden führen über AC5 zur gebundenen Terminierung. Der Eskalations-Schutz für **Budget/Token-Limit** bleibt unberührt: budget-/limit-bedingte Pausen inkrementieren **nie** die Zähler ([[night-budget-guard]] AC7) — diese Spec ändert daran nichts.

### Audit & Bericht
7. Je unterlassener (A2) oder unwirksamer Eskalation ein secret-/pfad-freier `AuditEntry` ([[taktgeber-nachtwaechter]] AC18): Story-ID, Quelle (`origin-ref`), Grund („Eskalation unterlassen: origin-ref-Quelle" / „Eskalation unwirksam"). Der neue Stop-`reason` `escalation-ineffective` fließt unverändert in den Abschlussbericht ([[drain-completion-report]]) — die auf `origin` erledigten Stories erscheinen **nicht** als `blocked` (bleibt konsistent zu [[drain-origin-progress-sync]] AC6).

## Acceptance-Kriterien

- **AC1** — **Ehrlicher Sicherheitsgürtel (Kern-Fix):** der unbedingte `totalNoProgressRounds = 0`-Reset nach `#escalate` (heute `src/ProjectDrain.js`, Zeile ~1204) entfällt. `totalNoProgressRounds` wird **ausschließlich** durch echt beobachteten Snapshot-Fortschritt zurückgesetzt (Status-/`ready`-Diff derselben Quelle, [[taktgeber-nachtwaechter]] AC5). Eine Eskalation zählt nur dann als Fortschritt, wenn ihr `Blocked`-Übergang in einem Folge-Snapshot **derselben Quelle** sichtbar wird. Ein Test weist nach: bei `origin-ref`-Quelle mit einer nie sichtbar werdenden Eskalation **steigt** `totalNoProgressRounds` monoton (kein Reset). *(1)*
- **AC2** — **Kein Regress im `working-tree`-Modus:** eine wirksame Eskalation (Snapshot-Quelle `working-tree`) wird in der Folge-Runde als `To Do→Blocked` sichtbar → regulärer `progressed`-Reset; ein Board mit vielen nacheinander wirksam eskalierten Stories löst den Sicherheitsgürtel **nicht** fälschlich aus (bestehende [[taktgeber-nachtwaechter]] AC4/AC5-Tests bleiben grün). *(1,2)*
- **AC3** — **Kein Write in `origin-ref`-Quellenmodus (A2):** ist die Snapshot-Quelle der Runde `origin-ref` ([[drain-origin-progress-sync]] AC2), führt der Taktgeber **kein** `BoardWriter.setBlocked` aus (kein Dirty-Artefakt im Klon, keine fälschlich auf `Blocked` gesetzte Story), sondern zählt die Runde als **unwirksame Eskalation** (AC5) + Audit. Im `working-tree`-Modus schreibt die Eskalation wie bisher (hinter dem `verified`-Gate, [[drain-origin-progress-sync]] AC4). *(3)*
- **AC4** — **Per-Story-Eskalations-Cap (A3):** eine in dieser Drain-Session bereits (versucht) eskalierte Story wird **nie** erneut als Eskalations-Opfer gewählt (`pickLongestUnmovedTarget` ignoriert bereits-eskalierte IDs). *(4)*
- **AC5** — **Gebundene Terminierung (Endlosschleife strukturell unmöglich):** ist ein Eskalations-Zyklus ausgelöst, kein Drain-Ziel fortgeschritten **und** sind alle aktuellen Drain-Ziele bereits (versucht) eskaliert bzw. Eskalation strukturell unwirksam, stoppt der Drain mit **`reason: 'escalation-ineffective'`** (neuer terminaler `reason`). Der bestehende `safety-stop-no-progress`-Backstop bleibt unabhängig erhalten. Ein Test weist nach: ein Runner, der **nie** Fortschritt liefert, bei `origin-ref`-Quelle mit stets unwirksamer Eskalation, führt in **endlicher, gebundener** Rundenzahl zum Stop (kein unbegrenzter Loop) — der Vorfall 2026-07-26 ist strukturell reproduziert und terminiert jetzt. *(5)*
- **AC6** — **Fruchtloser Feature-Drain/`/flow` konvergiert:** eine Runde ohne Zustandsänderung (inkl. `failed`/„WARTET"-Feature-Drain) inkrementiert die No-Progress-Zähler regulär und wird nie als Fortschritt gewertet; N solche Runden führen über AC5 zur gebundenen Terminierung. Budget-/Limit-Pausen inkrementieren **nie** die Zähler und setzen **nie** `Blocked` ([[night-budget-guard]] AC7, unverändert). *(6)*
- **AC7** — **Doku/Drift + Audit:** ein **ergänzt-Vermerk** in [[taktgeber-nachtwaechter]] (AC4/AC5, „Eskalation/Sicherheitsgürtel") und in [[drain-origin-progress-sync]] (AC4, „Eskalations-Gate") hält fest, dass Eskalation nur bei **wirksamer** (im Folge-Snapshot sichtbarer) Wirkung als Fortschritt zählt und im `origin-ref`-Modus unterlassen wird — Verweis auf diese Spec (sonst Doktrin-Drift, hartes `reviewer`-Gate). Je unterlassener/unwirksamer Eskalation ein secret-/pfad-freier `AuditEntry`. **Kein** neuer HTTP-Endpunkt; **keine** Änderung der Drain-Ziel-/Abbruch-Regel ([[taktgeber-nachtwaechter]] AC1–AC3) über den Wirksamkeits-Check + `origin-ref`-Skip + Per-Story-Cap + neuen Stop-`reason` hinaus. *(7)*

## Verträge

### `ProjectDrain` (Erweiterung, additiv)
- `#runLoop`: der unbedingte `totalNoProgressRounds = 0`-Reset nach `#escalate` entfällt (AC1). Reset **nur** im `progressed`-Zweig.
- `#escalate(project, victim, identity, { source })`: schreibt `setBlocked` **nur** bei `source === 'working-tree'`; bei `source === 'origin-ref'` No-Op + Audit + Rückgabe „unwirksam" (AC3).
- Eskalations-Opfer-Auswahl: `pickLongestUnmovedTarget(targets, lastChangeRound, escalatedIds)` — bereits-eskalierte IDs ausgeschlossen (AC4).
- Rückgabe `reason` erweitert um `'escalation-ineffective'` (AC5); alle bestehenden `reason`-Werte + Felder (`stopped`/`flowRuns`/`escalated`/`completed`/`blocked`/`budgetPauses`) unverändert (kein Regress).

### Wiederverwendung
- `ProjectDrain` (`src/ProjectDrain.js`) — Ort des Fix (Zähler-Reset, Eskalations-Gate, Opfer-Auswahl, Stop-`reason`).
- `BoardWriter` (`src/BoardWriter.js`) — unverändert (einziger Blocked-Schreibpfad; jetzt zusätzlich hinter dem Quellen-Gate A2).
- `computeDrainState` / Snapshot-`{ source, verified }` ([[drain-origin-progress-sync]]) — liefert die Quellen-Information für das Eskalations-Gate.
- `AuditStore` (`src/AuditStore.js`) — Audit für unterlassene/unwirksame Eskalation.

## Edge-Cases & Fehlerverhalten
- **`origin-ref`-Quelle, genuin steckengebliebene Story (auch auf `origin`)** → keine `Blocked`-Schreibung (A2), Drain endet mit `escalation-ineffective`; die Story bleibt `To Do` (nicht fälschlich `Blocked`), der Owner sieht den Grund im Abschlussbericht. Besser als der Vorfall (der falsches `Blocked` schrieb).
- **`working-tree`-Quelle, steckengebliebene Story** → `setBlocked` wie bisher, nächste Runde sichtbar → regulärer Reset (unveränderter, korrekter Pfad).
- **Fetch fehlgeschlagen (`unverified`)** → unverändert [[drain-origin-progress-sync]] AC4/AC5: kein `Blocked`, **kein** Zähler-Increment, Retry — diese Spec ändert daran nichts.
- **Alle Drain-Ziele bereits eskaliert, aber echter Fortschritt tritt doch ein** (z.B. `/flow` bringt eine andere Story auf `Done`) → `progressed`-Reset greift, Cap/Terminierung greifen nicht (korrekt).
- **`escalationAttempts` sehr hoch / `safetyMaxNoProgressRounds` sehr niedrig** → Terminierung greift über den früher zuschlagenden der beiden Mechanismen; in beiden Fällen endlich.

## NFRs
- **Sicherheit/Datenintegrität (Floor):** keine Board-Story wird durch einen unwirksamen/unsichtbaren Write auf `Blocked` gesetzt; im `origin-ref`-Modus wird gar nicht geschrieben (A2). **Keine** working-tree-mutierende Git-Operation, **kein** Commit/Push durch den Taktgeber (read-only Aussensicht, [[drain-origin-progress-sync]] NFR — unverändert). Keine Secrets/absoluten Host-Pfade in Audit/Log/Response.
- **Terminierung (harte Garantie):** die Drain-Schleife terminiert für jedes Board in gebundener Rundenzahl (AC5) — der Vorfall 2026-07-26 ist strukturell ausgeschlossen.
- **Robustheit:** ein fehlgeschlagener `setBlocked` crasht den Drain nicht (bestehendes try/catch, unverändert); die Terminierungs-Garantie hängt **nicht** vom Erfolg eines Writes ab (Sicherheitsgürtel + `escalation-ineffective` greifen write-unabhängig).
- **Testbarkeit:** injizierbare Snapshot-Quelle (`working-tree`/`origin-ref`), gemockter `BoardWriter`/Runner → alle AC ohne echten `claude`-Lauf und ohne echten Netz-Fetch prüfbar. Kern-Szenario: `origin-ref` + nie sichtbare Eskalation → monoton steigender Zähler → `escalation-ineffective`/`safety-stop` in gebundener Rundenzahl.

## Nicht-Ziele
- **Kein** Commit/Push der Eskalation auf `origin` (A1 — bewusst verworfen).
- **Keine** Änderung der Drain-Ziel-Definition, Abbruch-/Konvergenz-Regel oder Eskalations-Schwelle ([[taktgeber-nachtwaechter]] AC1–AC3) außer Wirksamkeits-Check + `origin-ref`-Skip + Per-Story-Cap + neuem Stop-`reason`.
- **Keine** Änderung der Budget-/Token-Limit-Eskalations-Schutzlogik ([[night-budget-guard]] AC7, unverändert übernommen).
- **Kein** neuer HTTP-Endpunkt, **keine** neue User-Einstellung, **keine** UI-Änderung (der neue `reason` fließt in die bestehende Bericht-Anzeige).
- **Keine** Bereinigung bereits liegender Dirty-Leichen — das ist [[drain-clone-precondition-sync]].

## Abhängigkeiten
- [[taktgeber-nachtwaechter]] (`ProjectDrain`-Engine, Eskalation/Sicherheitsgürtel AC4/AC5, `pickLongestUnmovedTarget`, `BoardWriter` — Wirksamkeits-Check + `origin-ref`-Skip + Per-Story-Cap ergänzen AC4/AC5; ergänzt-Vermerk, AC7) · [[drain-origin-progress-sync]] (Snapshot-`{ source, verified }`, Eskalations-`verified`-Gate — liefert die Quellen-Information; ergänzt-Vermerk AC4) · [[night-budget-guard]] (Budget-/Limit-Eskalations-Schutz, unverändert) · [[drain-completion-report]] (der neue `reason` `escalation-ineffective` fließt in den Bericht) · [[drain-clone-precondition-sync]] (bereinigt die Dirty-Leichen-Ursache; komplementär).
</content>
</invoke>
