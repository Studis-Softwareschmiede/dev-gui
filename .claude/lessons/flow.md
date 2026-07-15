# Orchestrator-Lessons (/flow) — dev-gui

Newest-first. Regeln für die Orchestrator-Ebene (Landen/Konsolidieren/Recovery/Dispatch-Ökonomie).

## flow/L02 — `board-ship.sh --target-branch feature/*` wartet hier 10 Min ins Leere (kein CI-Fehler)

**Beobachtung (2026-07-15, S-351):** `board-ship.sh <id> --target-branch feature/F-080` merged und pusht korrekt, bleibt dann aber in `watch_ci_or_die` hängen und bricht nach 40×15s mit `CI nicht erfolgreich (conclusion='timeout/unbekannt')` ab — **obwohl nichts kaputt ist**. Der Board-Flip (Schritt 5/6) unterbleibt dadurch, der Merge ist zu dem Zeitpunkt aber bereits gelandet.

**Ursache:** `.github/workflows/build.yml` triggert ausschliesslich auf `push: branches: [main]`, `security.yml` nur `schedule`/`workflow_dispatch`. Für `feature/**`-Branches existiert **strukturell keine CI**. Der Skript-Guard dagegen (`workflow_count == 0` → CI-Watch entfällt) greift nicht, weil das Repo sehr wohl Workflows hat — nur keinen, der auf diesem Branch triggert.

**Regel:** Bei aktivem `--parent <F-###>` den Exit-Code von `board-ship.sh` **nicht** als Merge-Fehler lesen. Stattdessen mechanisch nachprüfen, statt zu raten:
- `git merge-base --is-ancestor <story-sha> origin/feature/<F-###>` → gelandet?
- `gh run list --branch feature/<F-###>` → leer (`[]`) = strukturell keine CI, **nicht** „noch nicht gestartet"?
- Rollout entfällt bei `--target-branch` ohnehin per Skript-Design.
Sind alle drei bestätigt, Schritt 5/6 deterministisch nachziehen: `BOARD_WRITER=flow board set <id> status Done` + `board set <id> branch <branch>`, `git add board/ && git commit && git push origin feature/<F-###>`. Die echte CI-Abdeckung entsteht beim finalen `board-ship.sh --merge-feature` (Push auf `main` → `build.yml` inkl. Secret-Gate) — für Feature-Zwischenstände gibt es sie per Design nicht.

**Nicht tun:** Skript blind erneut starten (Schritt 1 erkennt „bereits gemergt", läuft in denselben 10-Min-Timeout, Board-Flip bleibt erneut aus) — oder `build.yml` auf `feature/**` erweitern, nur um das Skript zufriedenzustellen (kostet Actions-Minuten pro Story; die Bündelung am Feature-Ende ist Absicht, SR3).

## flow/L01 — DB-Trigger springt bei `docs/data-model.md` an, obwohl dev-gui keine DB hat

**Beobachtung (2026-07-15, S-351):** Der DBA-Zweit-Review-Trigger aus `/flow` §3.2a ist mechanisch definiert („Diff berührt `db_scripts/`, **`docs/data-model.md`** ODER Datenzugriffscode"). S-351 änderte `docs/data-model.md` (Feld `stoppedSkipped` am `ReconcileReport`-Typ) → Trigger griff, obwohl das Item kein `db`-Label trägt.

**Ursache:** dev-gui hat **keine Datenbank** (ADR-005 „Kein eigener State-Store"; `docs/data-model.md` Z.3 sagt es selbst: Read-Models, kein persistentes Tabellenmodell). `.claude/profile.md` hat kein `db_dialect`, `domains: [security]`. Der `dba`-Vertrag bricht in genau diesem Fall ab (kein Dialekt-Pack ladbar) und liefert **kein** `Review-Gate` — was vertragskonform ist, aber die §3.2a-Formulierung „beide Gates müssen PASS sagen" formal unerfüllbar macht.

**Regel:** Läuft der `dba` mit der Meldung „kein DB-Subsystem (`db_dialect: none`)" zurück, ist das ein **`SKIPPED`**, kein Blocker — weiter zum `tester`. Die Datenmodell-/Drift-Konformität von `docs/data-model.md` ist in Nicht-DB-Projekten Sache des generischen `reviewer` (Drift-Gate), nicht der DB-Achse. Metrik-Zeile mit `gate: SKIPPED-NO-DB` schreiben.

**Ökonomie:** Der Dispatch kostete ~33k Token für ein „kann strukturell nicht laufen". Vor dem `dba`-Dispatch prüfen: hat `.claude/profile.md` ein `db_dialect` ≠ `none` **oder** trägt das Item ein `db`-Label? Wenn beides nein und der Trigger nur wegen `docs/data-model.md` griff → Dispatch überspringen, `SKIPPED-NO-DB` direkt vermerken.
