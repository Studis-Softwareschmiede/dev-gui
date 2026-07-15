# Orchestrator-Lessons (/flow) — dev-gui

Newest-first. Regeln für die Orchestrator-Ebene (Landen/Konsolidieren/Recovery/Dispatch-Ökonomie).

## flow/L06 — Agent stirbt an einem API-Fehler: **fortsetzen, nicht neu dispatchen** (Kontext bleibt intakt)

**Beobachtung (2026-07-15, S-359):** Der coder-Dispatch endete nach 32 Tool-Calls und ~118k Token mit `Agent terminated early due to an API error: Server error mid-response`. Der Handoff fehlte, der Auftrag war unfertig (Produktionscode geändert, Tests noch nicht umgestellt) — die Arbeit selbst war aber weder falsch noch verloren: der bereits geschriebene Diff stand vollständig im Working-Tree.

**Regel:** Ein API-Abbruch ist ein **Transport**-Fehler, kein Agenten-Fehler. Nicht als „Iteration gescheitert" werten (zählt **nicht** zum Schleifenschutz N=3, es gab keinen Befund) und **nicht** frisch neu dispatchen — ein neuer Dispatch startet bei null und zahlt die verbrauchten Token ein zweites Mag. Stattdessen:
1. **Ist-Stand aus dem Working-Tree erheben** (`git status --porcelain`, `git diff --shortstat`) — er ist die verlässliche Quelle, nicht der abgeschnittene Agent-Output. Der Agent editiert direkt, also überlebt jede fertige Datei den Abbruch.
2. **Denselben Agenten via `SendMessage` an seine `agentId` fortsetzen** (aus dem Spawn-Ergebnis). Er wird aus seinem Transcript resumt — voller Kontext, kein Neuaufbau.
3. Die Fortsetzungs-Nachricht **explizit machen**: dass der Abbruch technisch war (nicht seine Schuld — sonst „korrigiert" er funktionierende Arbeit), was laut git schon steht, welche Schritte noch offen sind, und dass er Erledigtes überspringen soll.

**Ökonomie (der eigentliche Punkt):** Resume kostete hier ~37k Token für den Rest; ein Neu-Dispatch hätte die 118k komplett wiederholt. Bei einem coder mitten in einer L/XL-Story ist der Unterschied schnell sechsstellig.

**Nicht tun:** Den Working-Tree „sicherheitshalber" zurücksetzen, um sauber neu zu starten — das ist genau der stille Datenverlust aus der `git reset`-Falle (vgl. CLAUDE.md „Parallelbetrieb", S-047-Vorfall). Ein halbfertiger Diff ist kein beschädigter Diff.

## flow/L05 — EINE kaputte Zeile in `dispatches.jsonl` vergiftet **alle** Rollups still (`iters=1`, `crit/imp=0`, `secs_total=0`)

**Beobachtung (2026-07-15, S-355):** `metrics-append-item.sh` meldete `ep_act=4 iters=1 crit=0 imp=0` — obwohl die fünf Dispatch-Zeilen des Items korrekt `iter` bis 2, `imp=1` und Σ`secs`=1832 tragen. Die geschriebene `items.jsonl`-Zeile hatte zusätzlich `secs_total=0`. Kein Fehler, kein Hinweis, falsche Zahlen.

**Ursache (verifiziert, nicht vermutet):** Der Rollup liest die Datei mit **einem** `jq -s` über **alle** Zeilen (`scripts/metrics-append-item.sh` ~Z.105–116). `jq -s` ist **atomar**: eine einzige nicht-parsbare Zeile lässt den **gesamten** Aufruf mit Exit 5 sterben. Die Zeilen 375–378 (vom **2026-07-03**, Item S-289) sind korrupt — dort sind Positionsparameter in die JSON-Felder gerutscht: `{"ts":…,"item":"S-289","seq":1 coder 1 null 1018,"agent":"","iter":,…}`. Der Aufrufer hatte offenbar Env-Variablen als Argumente übergeben. Das `|| ITERS=1` hinter dem `jq` (K3-Absicherung: „Messen blockiert nie den Loop") **schluckt den Parse-Fehler** und lässt die Defaults greifen.

**Tragweite:** Die Verunreinigung ist **12 Tage alt**. Seit dem 2026-07-03 sind damit **alle** `items.jsonl`-Zeilen dieses Repos mit `iters=1`/`crit=0`/`imp=0`/`secs_total=0` geschrieben worden — d.h. die gesamte EP-Historie seither ist Müll, und `retro` Modus C (EP-Kalibrierung) sowie der `baseline.json`-Lookup in §1a rechnen darauf. `ep_est` aus §1a ist entsprechend wertlos kalibriert.

**Regel für den Orchestrator:** Der Rollup-Output ist **nicht** selbstvalidierend — `[metrics-append-item] OK: …` erscheint auch bei totgelaufenem `jq`. Wenn die gemeldeten `iters`/`crit`/`imp` **nicht zu den eigenen Dispatches dieses Laufs passen** (die du selbst gezählt hast), ist das der Fingerabdruck dieses Defekts. Verifikations-Einzeiler (kostet nichts):
```bash
jq -e . .claude/metrics/dispatches.jsonl >/dev/null || echo "Ledger korrupt — Rollups laufen auf Defaults"
```
(`jq -e .` ohne `-s` prüft zeilenweise und nennt die erste kaputte Zeilennummer.)

**Nachtrag (2026-07-15, S-360) — `iters`/`crit`/`imp` sind als Fingerabdruck UNZUVERLÄSSIG; `secs_total=0` ist der harte Marker.** S-360 lief mit genau 1 Iteration, Review-PASS ohne Befunde — die Defaults `iters=1`/`crit=0`/`imp=0` waren damit **zufällig identisch mit den echten Werten**. Der Defekt wäre über den oben genannten Abgleich unsichtbar geblieben. Eindeutig war allein **`secs_total=0`** bei drei Dispatches à ~200–330 s. Ein abgeschlossenes Item kann **nie** legitim `secs_total=0` haben — das ist der einzige Wert, der bei totgelaufenem `jq` mit Sicherheit falsch ist, unabhängig vom Verlauf der Story. Prüfe nach jedem `metrics-append-item.sh`:
```bash
grep '"item":"<S-###>"' .claude/metrics/items.jsonl | tail -1 | jq -c '{ep_act,iters,crit,imp,secs_total}'
```
`secs_total: 0` → Rollup lief auf Defaults, **alle** Aggregate der Zeile sind wertlos (auch die zufällig richtig aussehenden). Melden, nicht putzen (s.o.). Der Defekt ist damit weiterhin **jeden Lauf** aktiv — S-355 (Erstfund) und S-360 sind zwei bestätigte Fälle; die Fehlannahme „unauffällige Zahlen = Ledger heil" ist die eigentliche Falle.

**Nicht tun:**
- **Die kaputten Zeilen im Story-Drain eigenmächtig löschen/reparieren.** Die Ledger-Regel ist explizit append-only („historische Zeilen werden nie gelöscht oder umgeschrieben", Ausnahme nur der `tok`-Patch). Ein `/flow`-Lauf, der das Ledger zurechtbiegt, damit seine eigenen Zahlen schön aussehen, ist dasselbe verbotene Muster wie eine Spec eigenmächtig auf `active` zu heben (vgl. flow/L04). **Melden, nicht putzen** — die Entscheidung gehört dem Owner.
- Die falschen Aggregate in die Story-YAML „korrigieren". Der Dispo-Spiegel (§2b/AC6) spiegelt, was **im Ledger steht** — das Ledger bleibt Source of Truth, auch wenn es hier falsch liegt. Bei S-355 wurde daher bewusst `dispo_act=4` gespiegelt (statt des rechnerisch richtigen Werts aus iters=2/imp=1).

**Strukturelle Kur (offen, cross-repo — agent-flow, Owner-Entscheidung nötig):** zwei unabhängige Defekte. (1) **Robustheit:** der Rollup sollte pro Zeile parsen und unparsbare Zeilen überspringen + zählen (`jq -R 'fromjson? // empty'` statt `jq -s`), statt an einer Zeile komplett zu sterben. (2) **Sichtbarkeit:** das `|| DEFAULT`-Muster darf einen **Parse**-Fehler nicht wie „keine Daten" behandeln — K3 verlangt, den Loop nicht zu blockieren, aber **nicht**, den Fehler zu verschweigen; ein `>&2`-Hinweis wäre K3-konform. Solange beides offen ist, tritt die Falle in **jedem** Projekt auf, dessen Ledger je eine kaputte Zeile bekommen hat — und sie ist selbstverstärkend, weil sie unsichtbar bleibt.

**Für den Owner offen (bewusst nicht vom Orchestrator entschieden):** die vier Zeilen 375–378 lokal aus `.claude/metrics/dispatches.jsonl` entfernen (die Datei ist gitignored, also rein lokal, kein Repo-Eingriff). Danach rechnen künftige Rollups wieder korrekt; die zwischen 2026-07-03 und heute geschriebenen `items.jsonl`-Zeilen bleiben aber falsch und müssten für eine saubere Kalibrierung verworfen werden.

## flow/L04 — `board next` und `board ready` widersprechen sich (R2/spec-status) — `next` ist die Auswahlquelle, `ready` nur Diagnose

**Beobachtung (2026-07-15, S-354):** `board next --parent F-080` liefert S-354, während `board ready --parent F-080` im selben Moment `NOT-READY S-354 — R2: spec status='draft' (erwartet 'active')` und `Summary: 0/4 To-Do-Stories ready` meldet. Kein Fehler auf beiden Seiten — die zwei Verben haben **unterschiedliche Regelsätze**.

**Ursache (verifiziert im Code, nicht vermutet):** `cmd_next()` (`scripts/board` ~Z.860–890) filtert **ausschliesslich** auf `status == "To Do"` + Depends-Gate (`{Done, Verworfen}`). Die Regel **R2** (spec gesetzt + Datei existiert + Frontmatter `status: active`) lebt **nur** in `cmd_ready()` (~Z.1843/1983–2010). `next` kennt sie nicht.

**Regel:** Der `/flow`-Vertrag (§1) macht **`board next` zur Auswahlquelle**; `board ready` ist der **Diagnose**-Pfad und wird laut §1 nur konsultiert, wenn `next` **leer** ist (empty-drain-diagnostics AC3/AC4). Liefert `next` eine Story, wird sie abgearbeitet — auch wenn `ready` sie als NOT-READY führt. Konsistent mit der Praxis von F-080: S-351–S-353 sind gegen dieselben `draft`-Specs gelandet.

**Nicht tun:**
- Bei nicht-leerem `next` auf `ready` umschwenken und „nichts abarbeitbar" melden — das legt einen beauftragten Feature-Drain still, obwohl der Vertrag eine Story ausweist.
- Die Spec eigenmächtig auf `status: active` heben, um die Kommandos zu versöhnen. Der Spec-Status ist eine Owner-/`requirement`-Entscheidung, keine Orchestrator-Aufräumarbeit — und ein `/flow`-Lauf, der Specs freigibt, um sich selbst zu entsperren, hat das Drift-Gate umgangen.

**Für den Owner offen (bewusst nicht vom Orchestrator entschieden):** Ist `draft` bei F-080 Absicht (Specs gehen erst am Feature-Ende auf `active`), dann ist die `ready`-Warnung Rauschen. Ist es ein Versäumnis, sind vier Storys gegen unfreigegebene Specs gebaut. Beides plausibel — die Entscheidung gehört nicht in den Loop.

## flow/L03 — `board`/`board-ship.sh` nicht im PATH — **beide** aus dem agent-flow-Arbeitsrepo, NIE aus dem Plugin-Cache

> **KORRIGIERT 2026-07-15 (S-353).** Die ursprüngliche Fassung dieser Lesson empfahl für `board` den Plugin-Cache-Glob. **Das ist falsch und führt aktiv in die Irre** — Details unten. Wer die alte Fassung befolgt, verliert bei `--parent` still den Feature-Scope.

**Beobachtung (2026-07-15, S-352):** `board next` scheitert zu Lauf-Beginn mit `command not found: board` — das CLI ist in diesem Repo **nicht** im PATH. Zusätzlich: `board-ship.sh` existiert im Plugin-Cache **nicht**, wohl aber `board` selbst.

**Nachtrag (2026-07-15, S-353) — der eigentliche Befund:** Das Cache-`board` ist **inhaltlich veraltet**, nicht nur unvollständig. Konkret: sein `cmd_next()` parst **überhaupt keine Argumente** — `board next --parent F-080` schluckt das Flag stillschweigend und liefert die board-**weit** nächste Story. Kein Fehler, kein Hinweis, falsches Ergebnis. In diesem Lauf lieferte es `S-325` (`parent: F-069`) auf die Frage nach F-080; dass der erste Aufruf zufällig die richtige Story (S-353) traf, war **Glück über die Priority-Reihenfolge, nicht der Filter**. Das Arbeitsrepo-`board` hat den Parser (`--parent) shift; parent_filter="$1"`) und liefert korrekt S-354.

**Auflösung — beide Pfade zu Beginn einmal setzen, beide aus dem Arbeitsrepo:**
```bash
BOARD=/Users/alex/Git/Studis-Softwareschmiede/agent-flow/scripts/board
SHIP=/Users/alex/Git/Studis-Softwareschmiede/agent-flow/scripts/board-ship.sh
```
Das ist zugleich das Verzeichnis, auf das `Base directory for this skill` zeigt — die Skill-Doku und ihre Skripte stammen aus **derselben** Quelle. Der Plugin-Cache ist ein Deployment-Artefakt, das dahinter zurückhängt: die Skill-Doku beschreibt `--parent` „seit 2026-07-06", das Cache-`board` kann es bis heute nicht.

**Nicht tun:**
- **`board` aus dem Plugin-Cache** (`~/.claude/plugins/cache/…/scripts/board`) — kennt `--parent` nicht, Feature-Scope geht **still** verloren. Der Glob ist gegen Cache-*Rotation* robust, aber nicht gegen Cache-*Rückstand*; „update-fest" ≠ „aktuell".
- Den in CLAUDE.md notierten absoluten Cache-Pfad (`1da6c7dfc966`) verwenden — der rotiert und ist bereits veraltet.
- `board` als PATH-Kommando annehmen, nur weil die Skill-Doku es so schreibt.

**Verifikations-Einzeiler bei Zweifel** (kostet nichts, deckt den stillen Fallback sofort auf): `"$BOARD" next --parent F-999` → liefert es trotz Phantasie-Feature eine Story, ist der Filter tot.

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
