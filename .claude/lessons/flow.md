# Orchestrator-Lessons (/flow) — dev-gui

Newest-first. Regeln für die Orchestrator-Ebene (Landen/Konsolidieren/Recovery/Dispatch-Ökonomie).

## flow/L03 — `board`/`board-ship.sh` liegen nicht im PATH; `board-ship.sh` fehlt im Plugin-Cache

**Beobachtung (2026-07-15, S-352):** `board next` scheitert zu Lauf-Beginn mit `command not found: board` — das CLI ist in diesem Repo **nicht** im PATH. Zusätzlich: `board-ship.sh` existiert im aktuellen Plugin-Cache (`082e800afc80`) **nicht**, wohl aber `board` selbst. Beides kostet sonst mehrere Such-Runden mitten im Lauf (einmal vor §1, einmal vor §5).

**Auflösung — beide Pfade zu Beginn einmal setzen, statt zweimal zu suchen:**
- `board`: `"$(ls -dt ~/.claude/plugins/cache/agent-flow/agent-flow/*/ | head -1)scripts/board"` (Glob = update-fest, s. CLAUDE.md).
- `board-ship.sh`: **nur** im agent-flow-Arbeitsrepo — `/Users/alex/Git/Studis-Softwareschmiede/agent-flow/scripts/board-ship.sh`. Das ist zugleich das Verzeichnis, auf das `Base directory for this skill` zeigt; der Plugin-Cache ist hier **nicht** die Quelle.

**Nicht tun:** den in CLAUDE.md notierten absoluten Cache-Pfad (`1da6c7dfc966`) verwenden — der Cache rotiert (aktuell `082e800afc80`) und der Wert dort ist bereits veraltet. Ebenso wenig `board` als PATH-Kommando annehmen, nur weil die Skill-Doku es so schreibt.

## flow/L02 — `board-ship.sh --target-branch feature/*` wartet hier 10 Min ins Leere (kein CI-Fehler)

**Beobachtung (2026-07-15, S-351):** `board-ship.sh <id> --target-branch feature/F-080` merged und pusht korrekt, bleibt dann aber in `watch_ci_or_die` hängen und bricht nach 40×15s mit `CI nicht erfolgreich (conclusion='timeout/unbekannt')` ab — **obwohl nichts kaputt ist**. Der Board-Flip (Schritt 5/6) unterbleibt dadurch, der Merge ist zu dem Zeitpunkt aber bereits gelandet.

**Ursache:** `.github/workflows/build.yml` triggert ausschliesslich auf `push: branches: [main]`, `security.yml` nur `schedule`/`workflow_dispatch`. Für `feature/**`-Branches existiert **strukturell keine CI**. Der Skript-Guard dagegen (`workflow_count == 0` → CI-Watch entfällt) greift nicht, weil das Repo sehr wohl Workflows hat — nur keinen, der auf diesem Branch triggert.

**Regel (geschärft 2026-07-15, S-353 — Fehlschlag überspringen statt reparieren):** Bei aktivem `--parent <F-###>` `board-ship.sh` **gar nicht erst fahren** — es kann Schritt 5/6 hier strukturell nie erreichen (Schritt 3 stirbt vorher), liefert also keinen Wert und kostet 10 Min. Es gibt **keinen** Env-Seam, der den CI-Watch überspringt (`BOARD_SHIP_SKIP_GH_AUTH` deckt nur die Auth). Stattdessen den Ablauf direkt deterministisch fahren — dieselben Schritte, dieselben mechanischen Prüfungen, ohne Leerlauf:
1. Story-Branch `feat/<id>-<slug>` von `feature/<F-###>` anlegen, Code+Spec+Tests+`.claude/lessons/*` committen, pushen. *(Etabliertes Muster des Features — S-351/S-352 liegen so.)*
2. `git status --porcelain` vor jedem git-Schritt (L6-Guard von Hand) → nur `board/` darf offen sein.
3. `git checkout feature/<F-###> && git merge --no-ff` + push.
4. **Mechanisch verifizieren, nie behaupten** (das ist der eigentliche Wert des Skripts):
   - `git merge-base --is-ancestor <story-sha> feature/<F-###>` → gelandet?
   - `gh run list --branch feature/<F-###>` → leer = strukturell keine CI, **nicht** „noch nicht gestartet"?
   - Rollout entfällt bei Feature-Ziel per Skript-Design.
5. Erst dann Schritt 5/6: `BOARD_WRITER=flow board set <id> status Done` + Dispo-Spiegel, `git add board/ && git commit && git push origin feature/<F-###>`.

Die echte CI-Abdeckung entsteht beim finalen `board-ship.sh --merge-feature` (Push auf `main` → `build.yml` inkl. Secret-Gate) — für Feature-Zwischenstände gibt es sie per Design nicht. Der `tester` (volle Suite, §4) ist das Gate für die Einzel-Story.

**Nicht tun:** Skript blind erneut starten (Schritt 1 erkennt „bereits gemergt", läuft in denselben 10-Min-Timeout, Board-Flip bleibt erneut aus) — oder `build.yml` auf `feature/**` erweitern, nur um das Skript zufriedenzustellen (kostet Actions-Minuten pro Story; die Bündelung am Feature-Ende ist Absicht, SR3).

**Strukturelle Kur (offen, cross-repo — agent-flow, Owner-Entscheidung nötig):** Der Guard in `board-ship.sh:112` fragt „hat das *Repo* Workflows?" (`workflow_count`), müsste aber fragen „triggert ein Workflow auf *diesem Branch*?". Solange das so ist, tritt die Falle in **jedem** Projekt mit `main`-only-CI + Feature-Branch-Strategie (SR2) auf — die Lesson hier ist nur die lokale Umgehung. Drei Läufe (S-351, S-352, S-353) haben sie bestätigt.

## flow/L01 — DB-Trigger springt bei `docs/data-model.md` an, obwohl dev-gui keine DB hat

**Beobachtung (2026-07-15, S-351):** Der DBA-Zweit-Review-Trigger aus `/flow` §3.2a ist mechanisch definiert („Diff berührt `db_scripts/`, **`docs/data-model.md`** ODER Datenzugriffscode"). S-351 änderte `docs/data-model.md` (Feld `stoppedSkipped` am `ReconcileReport`-Typ) → Trigger griff, obwohl das Item kein `db`-Label trägt.

**Ursache:** dev-gui hat **keine Datenbank** (ADR-005 „Kein eigener State-Store"; `docs/data-model.md` Z.3 sagt es selbst: Read-Models, kein persistentes Tabellenmodell). `.claude/profile.md` hat kein `db_dialect`, `domains: [security]`. Der `dba`-Vertrag bricht in genau diesem Fall ab (kein Dialekt-Pack ladbar) und liefert **kein** `Review-Gate` — was vertragskonform ist, aber die §3.2a-Formulierung „beide Gates müssen PASS sagen" formal unerfüllbar macht.

**Regel:** Läuft der `dba` mit der Meldung „kein DB-Subsystem (`db_dialect: none`)" zurück, ist das ein **`SKIPPED`**, kein Blocker — weiter zum `tester`. Die Datenmodell-/Drift-Konformität von `docs/data-model.md` ist in Nicht-DB-Projekten Sache des generischen `reviewer` (Drift-Gate), nicht der DB-Achse. Metrik-Zeile mit `gate: SKIPPED-NO-DB` schreiben.

**Ökonomie:** Der Dispatch kostete ~33k Token für ein „kann strukturell nicht laufen". Vor dem `dba`-Dispatch prüfen: hat `.claude/profile.md` ein `db_dialect` ≠ `none` **oder** trägt das Item ein `db`-Label? Wenn beides nein und der Trigger nur wegen `docs/data-model.md` griff → Dispatch überspringen, `SKIPPED-NO-DB` direkt vermerken.
