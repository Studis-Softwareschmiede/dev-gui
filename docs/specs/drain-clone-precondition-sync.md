---
id: drain-clone-precondition-sync
title: Vorbedingungs-Sync des Ausführungs-Klons vor dem Board-Drain — origin/main-Stand ohne Fremd-Datenverlust
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Vorbedingungs-Sync des Ausführungs-Klons  (`drain-clone-precondition-sync`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der Board-Drain nutzt den **geteilten Container-Klon** (`/workspace/<projekt>`) als `cwd` der `/flow`-/Feature-Drain-Kindprozesse. Ist dieser Klon **veraltet** (im Vorfall 2026-07-26: Stand 4 Tage alt, 22.07.) oder mit **eigenen Drain-Artefakten dirty** (Taktgeber-Blocked-Leichen, [[drain-escalation-effectiveness]] BEFUND 1), scheitern Feature-Drain-Läufe am Feature-Branch-Checkout und neue Storys auf `origin/main` sind im Working-Tree-Fallback-Scan unsichtbar. Diese Spec bringt den Klon **vor der ersten Flow-Runde** auf `origin/main`-Stand — **ohne** je fremde, uncommittete Änderungen zu verwerfen (Parallelbetrieb!).

## Kontext / Verifizierter Vorfall 2026-07-26 (BEFUND 3)
- Die Eskalations-Leichen aus [[drain-escalation-effectiveness]] BEFUND 1 (uncommittete `board/stories/*.yaml`-Blocked-Writes) ließen **jeden** `board-feature-drain.sh`-Lauf am Feature-Branch-Checkout scheitern („would be overwritten by checkout", 5×10s-Retry, dann exit 3 „WARTET"). Der Drain wertete das als weitere fortschrittslose Runde → weitere Eskalationen → mehr Dirty-Dateien (Kaskade).
- Zusätzlich war der Klon 4 Tage veraltet: neu auf `origin/main` angelegte Storys waren im Working-Tree-Fallback-Scan unsichtbar. Ein automatischer Vorab-Sync existiert nicht.

## Getroffene Annahmen (mangels Rückfrage-Kanal explizit dokumentiert)
- **A1 — Eigene Drain-Artefakte dürfen bereinigt werden, Fremdes NIE.** Erkennbare **eigene** Taktgeber-Artefakte (uncommittete `board/stories/*.yaml`-Änderungen, deren Diff ausschließlich `status: Blocked` + `blocked_reason: "Taktgeber: … kein Fortschritt"` + `updated_at` setzt — die exakte, enge Signatur von `BoardWriter.setBlocked`, [[taktgeber-nachtwaechter]] AC8) dürfen vor dem Sync **verworfen** werden (`git checkout -- <datei>` **nur** dieser Dateien). **Jede andere** Working-Tree-Änderung (andere Dateien, oder Board-Dateien ohne exakt diese Signatur) gilt als **fremd** und wird **nie** angetastet.
- **A2 — Bei fremdem Dirty-Zustand: klarer Abbruch/Diagnose statt stillem Weiterarbeiten.** Ist der Working-Tree nach der Bereinigung eigener Artefakte **weiterhin dirty** (fremde uncommittete Änderungen), führt der Drain den Sync **nicht** durch und arbeitet **nicht** still auf altem Stand weiter: er **beendet sich sofort** mit einem eigenen terminalen `reason: 'clone-dirty'` (Audit mit den betroffenen Pfaden — nur Repo-relative Pfade, keine Host-Absolutpfade), damit der Owner den Konflikt sieht und auflöst. Konservativ: lieber ein sichtbarer Abbruch als ein stiller Lauf auf veraltetem/kollidierendem Stand (Trauma 2026-07-02).
- **A3 — Sync ist fast-forward-only, kein Merge/Rebase.** Der Sync bringt den Klon per **`fetch` + fast-forward-only** auf `origin/<default_branch>`. Lässt sich der lokale Branch **nicht** fast-forwarden (divergierte lokale Commits im geteilten Klon — sollte im reinen Ausführungs-Klon nicht vorkommen), wird **nicht** gemergt/rebased/reset, sondern mit `reason: 'clone-diverged'` sauber abgebrochen (Audit). Kein `reset --hard`, kein `clean -fd` über die eng-signierte A1-Bereinigung hinaus.

## Verhalten

### Vorbedingungs-Sync (einmalig, vor der ersten Flow-Runde)
1. **Vor** der ersten Flow-Runde eines `drainProject()`-Laufs führt der Drain je Projekt einen **Vorbedingungs-Sync** des Ausführungs-Klons durch (nur einmal pro Drain-Session, nicht je Runde):
   1. `git fetch origin` (read-only auf Refs, non-fatal bei Fehler — dann Sync übersprungen, Audit, Drain läuft auf aktuellem lokalen Stand weiter wie heute).
   2. **Eigene Artefakt-Bereinigung (A1):** uncommittete `board/stories/*.yaml`-Dateien mit **exakt** der Taktgeber-Blocked-Signatur werden per `git checkout -- <datei>` (nur diese) verworfen. Jede andere Änderung bleibt unangetastet.
   3. **Fremd-Dirty-Gate (A2):** ist der Working-Tree danach **weiterhin dirty** → Abbruch mit `reason: 'clone-dirty'` (kein Sync, kein Flow-Anstoß).
   4. **Fast-forward-only (A3):** sonst wird der lokale Branch per fast-forward-only auf `origin/<default_branch>` gebracht. Nicht ff-baubar → Abbruch mit `reason: 'clone-diverged'`. Erfolg → der Klon ist auf `origin/main`-Stand, der Drain startet die erste Flow-Runde.
2. **Kein Regress ohne Remote/ohne Upstream:** existiert kein `origin`/kein Upstream (z.B. rein lokales Projekt) → Sync ist ein No-Op (heutiges Verhalten), Drain läuft normal.
3. Der Sync ist die **einzige** working-tree-mutierende Git-Operation des Drains und **eng** begrenzt: `fetch` (Refs), `checkout -- <eigene-artefakt-datei>` (nur A1-signierte), fast-forward-only `merge`/`pull --ff-only`. **Kein** `reset --hard`, **kein** `clean -fd`, **kein** `rebase`, **kein** Merge-Commit, **kein** Stash. Er berührt die **Aussensicht**-Snapshot-Quelle ([[drain-origin-progress-sync]]) nicht — diese bleibt read-only und je Runde ancestry-basiert (der Sync bringt den Klon lediglich einmalig auf Stand, sodass Working-Tree-Fallback-Scans und Feature-Branch-Checkouts nicht mehr an veraltetem/dirty Stand scheitern).

### Audit & Bericht
4. Je Sync-Ausgang ein secret-/pfad-freier `AuditEntry` ([[taktgeber-nachtwaechter]] AC18): `synced-ff` | `up-to-date` | `cleaned-artifacts` (mit Anzahl) | `skipped-fetch-failed` | `clone-dirty` (mit Repo-relativen Pfaden) | `clone-diverged` | `no-remote`. Die terminalen Abbrüche `clone-dirty`/`clone-diverged` fließen als Stop-`reason` in den Abschlussbericht ([[drain-completion-report]]).

## Acceptance-Kriterien

- **AC1** — **Vorbedingungs-Sync vor der ersten Flow-Runde:** `ProjectDrain#drainProject()` führt genau **einmal** pro Drain-Session, **vor** der ersten Flow-Runde, den Sync aus: `git fetch origin` (read-only, non-fatal), dann A1-Bereinigung, dann Fremd-Dirty-Gate (A2), dann fast-forward-only (A3). Bei `fetch`-Fehler wird der Sync übersprungen (Audit `skipped-fetch-failed`) und der Drain läuft auf aktuellem lokalem Stand weiter (kein Crash). Kein Sync je Runde — nur einmalig. *(1)*
- **AC2** — **Eigene Artefakte bereinigen, Fremdes nie (A1):** uncommittete `board/stories/*.yaml`-Änderungen mit **exakt** der Signatur „nur `status: Blocked` + `blocked_reason: "Taktgeber: … kein Fortschritt"` + `updated_at` geändert" werden per `git checkout -- <datei>` (nur diese Dateien) verworfen. **Jede andere** Working-Tree-Änderung (andere Dateien; Board-Dateien ohne exakt diese Signatur; andere geänderte Felder) bleibt **unangetastet**. Ein Test weist nach: eine fremde, uncommittete Änderung überlebt den Sync unverändert. *(1)*
- **AC3** — **Fremd-Dirty-Gate (A2):** ist der Working-Tree **nach** der A1-Bereinigung weiterhin dirty, führt der Drain **keinen** Sync und **keine** Flow-Runde aus, sondern beendet sich mit `reason: 'clone-dirty'` (neuer terminaler `reason`) + Audit mit den **Repo-relativen** betroffenen Pfaden (keine Host-Absolutpfade). Kein stilles Weiterarbeiten auf altem Stand. *(1)*
- **AC4** — **Fast-forward-only (A3):** ist der Tree sauber (bzw. nur eigene Artefakte bereinigt), wird der lokale Branch per **fast-forward-only** auf `origin/<default_branch>` gebracht. Lässt er sich **nicht** fast-forwarden → Abbruch mit `reason: 'clone-diverged'` (kein Merge/Rebase/`reset --hard`/`clean`). Bei Erfolg ist der Klon auf `origin/main`-Stand; die erste Flow-Runde startet. **Keine** working-tree-mutierende Git-Operation außer `fetch` + eng-signiertem `checkout -- <datei>` + ff-only. *(1,3)*
- **AC5** — **Kein Regress:** kein `origin`/kein Upstream → Sync ist No-Op, Drain läuft normal (heutiges Verhalten). Ohne Dirty-Zustand und mit `HEAD == origin` → `up-to-date`, kein Write. Der Sync ändert die read-only Aussensicht-Snapshot-Quelle ([[drain-origin-progress-sync]]) **nicht** (die bleibt je Runde ancestry-basiert, read-only). *(2,3)*
- **AC6** — **Audit + Bericht:** je Sync-Ausgang ein secret-/pfad-freier `AuditEntry` (`synced-ff`/`up-to-date`/`cleaned-artifacts`/`skipped-fetch-failed`/`clone-dirty`/`clone-diverged`/`no-remote`). `clone-dirty`/`clone-diverged` fließen als Stop-`reason` in den Abschlussbericht ([[drain-completion-report]]); `completed`/`blocked` sind dann leere Listen (kein Flow lief). Keine Secrets/absoluten Host-Pfade. *(4)*

## Verträge

### Git-Zugriff (pro Drain-Session, einmalig, eng begrenzt)
- **Fetch:** `git -C <projektPfad> fetch --quiet origin` (Refs, non-fatal).
- **Eigene-Artefakt-Erkennung (A1):** `git -C <p> status --porcelain` → geänderte `board/stories/*.yaml`; je Kandidat `git -C <p> diff -- <datei>` prüfen, dass **ausschließlich** `status`/`blocked_reason`/`updated_at` mit der Taktgeber-Signatur geändert sind; nur solche per `git -C <p> checkout -- <datei>` verwerfen.
- **Dirty-Rest-Prüfung (A2):** erneut `git status --porcelain`; nicht leer → `clone-dirty`.
- **Fast-forward-only (A3):** `git -C <p> merge --ff-only origin/<default_branch>` (oder `pull --ff-only`); Nicht-ff → `clone-diverged`.
- **Fehlerpfade:** kein Remote/Upstream → `no-remote` (No-Op); Fetch-Fehler → `skipped-fetch-failed` (weiter auf lokalem Stand). **Kein** `reset`/`clean`/`rebase`/`stash`/Merge-Commit. Refs/Pfade aus validierter Projekt-Auflösung (kein Shell-Interpolation-Sink).

### `ProjectDrain` (Erweiterung, additiv)
- `#runLoop` (oder `drainProject`) ruft **vor** der ersten Runde `#syncCloneToOrigin(projectPath)` → `{ outcome, dirtyPaths? }`. `clone-dirty`/`clone-diverged` → sofortiger Stop-Return mit dem entsprechenden `reason` (leere `completed`/`blocked`). Rückgabe-`reason` erweitert um `'clone-dirty'|'clone-diverged'`; alle übrigen `reason`/Felder unverändert.
- Injizierbare **Git-Boundary** (gemockte `fetch`/`status`/`diff`/`checkout`/`merge`) für Testbarkeit — analog der Lese-Boundary aus [[drain-origin-progress-sync]] (kann dieselbe erweiterte Boundary sein).

### Wiederverwendung
- `ProjectDrain` (`src/ProjectDrain.js`) — Ort des Vorbedingungs-Syncs (vor der ersten Runde) + neue Stop-`reason`s.
- Git-Lese-/Schreib-Boundary ([[drain-origin-progress-sync]] `fetch`/`show`/`ls-tree` erweitert um `status`/`diff`/`checkout -- `/`merge --ff-only`) — eng gekapselt, injizierbar.
- `resolveProjectSlug`+`validateProjectPath` (`src/workspacePath.js`) — validierte Projekt-/Pfad-Auflösung (realpath-Containment).
- `AuditStore` (`src/AuditStore.js`) — Sync-Ausgang-Audit.
- `DrainReportStore` ([[drain-completion-report]]) — `clone-dirty`/`clone-diverged` als Bericht-`reason`.

## Edge-Cases & Fehlerverhalten
- **Eigene Artefakte + fremde Änderung gleichzeitig** → nur die eigenen (A1-signierten) werden bereinigt; die fremde bleibt → Fremd-Dirty-Gate greift → `clone-dirty` (kein Verlust der fremden Änderung).
- **`board/stories/*.yaml` mit Taktgeber-Signatur, die ein Owner absichtlich von Hand gesetzt hat** → wird als eigenes Artefakt behandelt und verworfen; akzeptierter, sehr enger False-Positive (die Signatur ist maschinell erzeugt; ein Owner setzt „Taktgeber: … kein Fortschritt" praktisch nie manuell). Bewusst konservativ nur exakt diese Signatur.
- **Fetch schlägt fehl (offline/transient)** → `skipped-fetch-failed`, Drain läuft auf lokalem Stand (best-effort, kein Crash).
- **Detached HEAD / kein Upstream** → `no-remote`/kein ff-Ziel auflösbar → No-Op-Sync, Drain läuft normal.
- **Nicht-ff (divergierte lokale Commits)** → `clone-diverged`, kein Merge/Rebase; Owner löst manuell (sollte im reinen Ausführungs-Klon nicht vorkommen).
- **`merge_policy: direct`-Projekt mit lokalem Vorlauf** → `HEAD ≥ origin`, ff-only ist No-Op/`up-to-date`, kein Write (kein Regress).

## NFRs
- **Sicherheit/Trauma-Konformität (2026-07-02):** **kein** `reset --hard`, **kein** `clean -fd`, **kein** Stash/Rebase; die einzige verwerfende Operation ist `checkout -- <datei>` auf **eng-signierte eigene** Artefakte (A1). Fremde uncommittete Änderungen werden **nie** verworfen — bei Zweifel Abbruch (`clone-dirty`, A2). Keine Secrets/absoluten Host-Pfade in Audit/Log/Bericht (nur Repo-relative Pfade). Git-Kommandos ohne Shell-Interpolation von Fremd-Eingaben.
- **Robustheit/Degradation:** Fetch-/Git-Fehler sind non-fatal (Sync übersprungen, Drain läuft auf lokalem Stand); der Sync crasht **weder** `ProjectDrain` **noch** `NightWatchScheduler`.
- **Idempotenz:** ein zweiter Drain auf bereits synchronem, sauberem Klon → `up-to-date`, kein Write, No-Op.
- **Testbarkeit:** injizierbare Git-Boundary (gemockte `fetch`/`status`/`diff`/`checkout`/`merge`) → alle AC ohne echten Git-Zustand/Netz. Szenarien: (a) eigene Artefakte bereinigt + ff → `synced-ff`; (b) fremde Änderung → `clone-dirty`, unangetastet; (c) nicht-ff → `clone-diverged`; (d) kein Remote → No-Op.

## Nicht-Ziele
- **Kein** `reset --hard`/`clean -fd`/`rebase`/`stash`/Merge-Commit (nur `fetch` + eng-signiertes `checkout` + ff-only).
- **Kein** Verwerfen fremder uncommitteter Änderungen (Parallelbetrieb!) — im Zweifel Abbruch.
- **Keine** Änderung der read-only Aussensicht-Snapshot-Quelle ([[drain-origin-progress-sync]]) — die bleibt je Runde ancestry-basiert.
- **Kein** Sync je Runde (nur einmalig vor der ersten Runde).
- **Kein** Fix des agent-flow-seitigen `board-feature-drain.sh`-Dossier-Cache (Cross-Repo, separat — hier nur als Kontext erwähnt).
- **Kein** echter Git-/`claude`-Live-Lauf im Test-Gate (gemockte Boundary).

## Abhängigkeiten
- [[taktgeber-nachtwaechter]] (`ProjectDrain`-Engine, `BoardWriter.setBlocked`-Signatur AC8 für die A1-Erkennung; Vorbedingungs-Sync ist additiv vor der ersten Runde) · [[drain-origin-progress-sync]] (read-only Aussensicht bleibt unverändert; die Git-Boundary wird um die eng begrenzten Schreib-Ops erweitert) · [[drain-escalation-effectiveness]] (beseitigt die **Ursache** der Dirty-Leichen — im `origin-ref`-Modus wird gar nicht mehr geschrieben; diese Spec bereinigt bereits **liegende** Leichen + bringt den Klon auf Stand — komplementär) · [[feature-aware-drain]] (der Feature-Branch-Checkout des `board-feature-drain.sh` scheiterte am dirty/veralteten Klon — dieser Sync ist die Vorbedingung dafür) · [[drain-completion-report]] (`clone-dirty`/`clone-diverged` als Bericht-`reason`) · [[drain-restart-robustness]] (validierte Slug→Pfad-Auflösung für die Git-Kommandos).
</content>
