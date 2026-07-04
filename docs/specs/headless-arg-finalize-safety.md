---
id: headless-arg-finalize-safety
title: Headless-`claude -p`-Argumentübergabe + Finalize-Sicherheitsnetz (kein stiller Idee-Verlust)
status: draft
area: fabrik-arbeiten
version: 1
---

# Spec: Headless-`claude -p`-Argumentübergabe + Finalize-Sicherheitsnetz  (`headless-arg-finalize-safety`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Ein Owner-Live-Test (2026-07-01) hat einen Produktionsbug im headless-`claude -p`-Pfad aufgedeckt: beim „Story anlegen" im Idee-Specify-Chat ([[idea-specify-chat]] AC6–AC9) entstand **keine** Story/Spec, aber die Platzhalter-Idee wurde fälschlich als `Done` archiviert (`resolved-note: superseded-by-specify`) → **stiller Verlust der Idee-Absicht**. Diese Spec behebt die **zwei** dafür verantwortlichen, eng zusammenhängenden Fehler (der zweite wurde durch den ersten überhaupt erst sichtbar):

1. **Argumentverlust (Hauptbug):** Der gemeinsame Baustein `HeadlessRunnerCore` übergibt Befehl (`command`) und Zusatzargumente (`args`, z.B. der vom Chat gebaute Prompt-Text) als **zwei getrennte** argv-Elemente an `claude -p`. Die reale `claude -p`-CLI nimmt aber nur **ein** Argument nach `-p` als Prompt — der Rest verpufft. Der headless `requirement`-Agent erhielt daher **kein** `ARGUMENTS:`-Feld, fragte „Was soll ich aufnehmen?" und beendete sich (Exit 0), ohne etwas zu leisten. Unbemerkt, weil alle bisherigen Nutzer (`/flow`-Nacht-Drain, `/reconcile`) **immer** mit `args: []` liefen; der `IdeaSpecifyFinalizer` ist der erste Aufrufer mit nicht-leeren `args`.

2. **Blindes Vertrauen auf Exit 0 (Sekundärbug):** Das Sicherheitsnetz des `IdeaSpecifyFinalizer` archiviert die Platzhalter-Idee, sobald der Job-Status `done` (= Kindprozess-Exit 0) erreicht — **ohne** zu prüfen, ob tatsächlich eine neue Story/Spec entstand. Ein leerer Exit-0-Lauf archiviert so fälschlich eine unbearbeitete Idee.

**Bestätigt per echtem Produktions-Transcript** (Container `dev-gui-dev-gui-1`, `~/.claude/projects/-workspace-dev-gui/1e862deb-…jsonl`, 2026-07-01T19:23): der headless `requirement`-Agent erhielt nur `<command-name>/agent-flow:requirement</command-name>` **ohne** `ARGUMENTS:`-Abschnitt. Root-Cause ist damit Fakt, nicht Hypothese.

## Verhalten

### Root Cause 1 — argv-Zusammensetzung (zentral in `HeadlessRunnerCore`)
1. In `HeadlessRunnerCore.#runProcess()` werden `command` und `args` zu **einem** zusammenhängenden `-p`-argv-**Element** zusammengesetzt, **bevor** an `spawn()` übergeben wird: bei nicht-leeren `args` ist der Prompt-Wert `` `${command} ${args.join(' ')}` `` (**ein** Array-Element), bei leeren `args` unverändert nur `command`. `--dangerously-skip-permissions` bleibt ein **eigenes**, nachfolgendes argv-Element.
2. Die Übergabe an `spawn()` bleibt **Array-Form** (kein Shell-String, keine Shell-Interpretation). Die bestehende Sicherheitseigenschaft „kein argv-Join durch eine Shell → keine Command-Injection" (security/R03) bleibt **vollständig** erhalten — es ändert sich ausschließlich **was** als der eine `-p`-Wert übergeben wird (command+text zusammen statt nur command).
3. Der Fix liegt **ausschließlich zentral** in `HeadlessRunnerCore` (dem gemeinsamen Baustein hinter `HeadlessFlowRunner` **und** `HeadlessReconcileRunner`) — **nicht** pro Aufrufer dupliziert. Damit profitieren alle heutigen und künftigen Nutzer (Reconcile, Nacht-Drain, Idee-Specify-Finalizer) automatisch. Das bestehende Verhalten für `args: []` (Reconcile/Flow/Nacht-Drain) bleibt **bit-identisch** (kein Regress).

### Root Cause 2 — Sicherheitsnetz verifiziert echtes Ergebnis (`IdeaSpecifyFinalizer`)
4. Der `IdeaSpecifyFinalizer` archiviert die Platzhalter-Idee **nur**, wenn der headless-Lauf tatsächlich ein neues Board-Ergebnis produziert hat. Dazu erfasst er **vor** `runner.start(...)` einen **Baseline-Snapshot** der Board-/Spec-Artefakte des Zielprojekts (Menge der Story-Dateien unter `board/stories/`, ergänzend Feature-Dateien unter `board/features/` und Spec-Dateien unter `docs/specs/`) und vergleicht ihn **nach** Job-`done` gegen den Nach-Zustand.
5. Fall-Unterscheidung nach Job-`done`:
   - **(a) Neue Story entstanden UND Idee noch `status: Idee`** → archivieren wie bisher ([[idea-specify-chat]] AC9): `BoardWriter.archiveSupersededIdea(...)` (Status `Done` + festes `resolved_note: superseded-by-specify` + `resolved_at`). Keine verwaiste Idee-Karte.
   - **(b) Idee **nicht mehr** `status: Idee`** (der Agent hat die Platzhalter-Idee selbst übernommen/aufgelöst — best-effort-Übernahme, [[idea-specify-chat]] AC8) → **No-Op** beim Archivieren (unverändertes erwartetes Verhalten, `archiveSupersededIdea` wirft `not-resolvable`); der Lauf gilt als **erfolgreich** (`done`), weil echte Arbeit geleistet wurde.
   - **(c) WEDER neue Story entstanden NOCH Idee-Transformation** (der reproduzierte Fehlerfall: leerer Exit-0-Lauf) → **kein** Archivieren; die Idee bleibt sichtbar `status: Idee`.
6. Im Fall (c) meldet der Finalize-Job einen **eigenen Terminalstatus `no-op`** (statt `done`) über den Status-Endpunkt. Die Status-Abbildung liegt im `IdeaSpecifyFinalizer` (er mappt den `done` des zugrundeliegenden `HeadlessFlowRunner` auf `no-op`, wenn die Ergebnis-Verifikation aus AC4/AC5 negativ ist) — der `HeadlessFlowRunner`/`HeadlessRunnerCore` bleibt unangetastet. `no-op` ist secret-frei und trägt eine klare, anzeigbare Meldung (sinngemäß „Es ist kein Feature/keine Story entstanden — die Idee bleibt unverändert, bitte erneut versuchen").
7. Der No-Op-Fall wird **auditiert** (genau ein `AuditStore`-Eintrag, secret-frei) — der faktische No-Op wird für den Owner **sichtbar** gemacht statt als Erfolg verschleiert.

### Frontend — No-Op sichtbar, kein falscher Erfolg
8. Bei Finalize-Status `no-op` zeigt das `IdeaSpecifyChatModal` den Fall **inline** als Fehler-/Warnzustand (`role="alert"`/`status`, Text — nicht nur Farbe); das Overlay **bleibt offen**, ein **Retry** ist möglich. Es erscheint **keine** Erfolgsmeldung, das Modal **schließt nicht**, und es wird **kein** `onSpecified`-Re-Fetch ausgelöst (im Gegensatz zum `done`-Pfad, [[idea-specify-chat]] AC10). Damit ist der reproduzierte „stille Erfolg trotz No-Op" ausgeschlossen.

## Acceptance-Kriterien

- **AC1** — `HeadlessRunnerCore.#runProcess()` setzt `command` + `args` zu **einem** zusammenhängenden `-p`-argv-Element zusammen: bei nicht-leeren `args` spawnt es `claude` mit **genau** `['-p', '<command> <args.join(" ")>', '--dangerously-skip-permissions']` (3 Elemente, Prompt-Text **nicht** verloren); bei `args: []` mit **genau** `['-p', '<command>', '--dangerously-skip-permissions']` (bisheriges Reconcile-/Flow-/Nacht-Drain-Verhalten **bit-identisch**). Übergabe bleibt Array-Form (kein Shell-String). Testbar mit injizierbarem `spawnFn`: das an `spawnFn` übergebene argv-Array wird exakt geprüft, für beide Fälle (`args` leer/nicht-leer). *(1,2)*
- **AC2** — Ein **neuer Regressionstest** deckt **explizit** den Fall „nicht-leere `args`" ab und prüft die **reale argv-Konstruktion** (das tatsächlich an `spawnFn` übergebene Array — nicht nur einen blind bestätigten Fake-Aufruf). Alle bestehenden Tests von `HeadlessRunnerCore`/`HeadlessFlowRunner`/`HeadlessReconcileRunner`/`IdeaSpecifyFinalizer` bleiben **grün** (kein Regress — bisher liefen alle nur mit `args: []`). *(1,3)*
- **AC3** — Der Fix liegt **ausschließlich zentral** in `HeadlessRunnerCore`; **kein** Aufrufer (`IdeaSpecifyFinalizer`/Flow/Reconcile) dupliziert die argv-Zusammensetzung. Nachweisbar: `HeadlessReconcileRunner` **und** `HeadlessFlowRunner` delegieren beide an denselben Core; nach dem Fix übergibt der `IdeaSpecifyFinalizer` den **vollständigen** `buildRequirementPrompt(...)`-Text an den headless `requirement`-Lauf (der Agent erhält ein nicht-leeres Prompt-Argument statt einer leeren Aufforderung). Testbar mit injiziertem `spawnFn` über den Finalizer-Pfad: das gespawnte argv enthält den Prompt-Text. *(3)*
- **AC4** — Vor `runner.start(...)` erfasst der `IdeaSpecifyFinalizer` einen **Baseline-Snapshot** der Board-/Spec-Artefakte des Zielprojekts (mind. Menge der `board/stories/`-Story-Dateien; ergänzend `board/features/` + `docs/specs/`). Nach Job-`done` vergleicht das Sicherheitsnetz Vor-/Nach-Zustand und archiviert **nur** dann (`BoardWriter.archiveSupersededIdea`), wenn **mindestens eine neue Story/Spec/Feature-Datei** entstanden ist **und** die Idee noch `status: Idee` trägt (Fall a). Ist die Idee nicht mehr `Idee` (Fall b) → erwartetes No-Op wie bisher (kein zweiter Write). Verzeichnis-Lesungen bleiben **strikt innerhalb** des validierten Projektpfads (kein Traversal); Board-Schreiben ausschließlich über `BoardWriter` (atomar). Testbar mit gestubtem Runner + injizierbarem FS/Board-Reader: kein neuer Artefakt → **kein** `archiveSupersededIdea`-Aufruf. *(4,5)*
- **AC5** — Fall (c) (Job `done`, aber **weder** neue Story/Spec/Feature **noch** Idee-Transformation): der `IdeaSpecifyFinalizer.getJob()` liefert den **eigenen** Terminalstatus **`no-op`** (statt `done`) mit klarer, secret-freier Meldung; die Idee bleibt `status: Idee` (**kein** `archiveSupersededIdea`). Der zugrundeliegende `HeadlessFlowRunner`/`HeadlessRunnerCore` bleibt dabei unverändert (Mapping ausschließlich im Finalizer). Testbar mit gestubtem Runner (`done`, keine neuen Artefakte) → `getJob()` liefert `no-op`, keine Archivierung, keine verwaiste Archivierung. *(6)*
- **AC6** — Der No-Op-Fall (AC5) erzeugt **genau einen** secret-freien `AuditStore`-Eintrag (kein Token/Host-Pfad), sodass der faktische No-Op für den Owner sichtbar ist statt als Erfolg verschleiert. Testbar mit injiziertem `AuditStore`-Stub. *(7)*
- **AC7** — Bei Finalize-Status `no-op` zeigt das `IdeaSpecifyChatModal` den Fall **inline** als Fehler-/Warnzustand (`role="alert"`/`status`, Text, nicht nur Farbe); das Overlay **bleibt offen**, Retry möglich; es erscheint **keine** Erfolgsmeldung, das Modal **schließt nicht** und ruft **kein** `onSpecified`/Re-Fetch auf. Testbar mit mockbarer `fetchFn` (Status-Sequenz `running` → `no-op`): kein `onClose`, kein `onSpecified`, sichtbarer No-Op-Hinweis. *(8)*
- **AC8** (Sicherheit/Isolation — Floor) — Der argv-Fix ändert **nichts** an den Sicherheits-Eigenschaften des headless-Pfads: argv bleibt Array (kein Shell-Interpolation, security/R03), der harte `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block bleibt, `--dangerously-skip-permissions` bleibt ausschließlich im getrennten Headless-Pfad, keine Secrets/Token/absoluten Host-Pfade in Log/Audit/Response. Die Board-Verifikation (AC4) liest ausschließlich innerhalb des validierten Projektpfads und schreibt weiterhin nur über `BoardWriter`. Testbar: Child-Env-Assertions (kein API-Key), argv-Array-Assertion, kein Klartext-Leak in Fehlermeldungen/Audit. *(2,4)*

## Verträge

### `HeadlessRunnerCore` (geändert — zentraler Fix)
- **Vorher (Bug):** `spawnFn('claude', ['-p', command, '--dangerously-skip-permissions', ...args], …)` — `command` und jedes `args`-Element sind getrennte argv-Elemente; `claude -p` ignoriert alles nach dem ersten Prompt-Argument.
- **Nachher (Fix):** Prompt-Wert = `args.length > 0 ? `${command} ${args.join(' ')}` : command`; `spawnFn('claude', ['-p', promptArg, '--dangerously-skip-permissions'], …)`. Weiterhin Array-argv, kein Shell-String. Env/Timeout/Lock/close/401-Vorrang **unverändert**.

### `IdeaSpecifyFinalizer` (geändert — Sicherheitsnetz + No-Op)
- `start(projectPath, { draftText, ideaStoryId, projectSlug })` erfasst zusätzlich einen **Baseline-Snapshot** (Artefakt-Mengen) und legt ihn in `#jobMeta[jobId]` ab (neben `projectSlug`/`storyId`/`projectPath`).
- `getJob(jobId) → { status: 'running'|'done'|'failed'|'auth-expired'|'no-op', result?, error? }` — bei zugrundeliegendem `done` läuft **einmalig** die Ergebnis-Verifikation (AC4); ergibt sie „kein neues Artefakt UND Idee noch `Idee`" (Fall c) → gemappter Status **`no-op`** (+ secret-freie Meldung + Audit-Eintrag); sonst `done` (Fall a: nach Archivierung; Fall b: Idee bereits transformiert). Race-frei genau einmal je Job (bestehendes `#safetyNetChecked`-Muster).
- **Board-/FS-Lesung** injizierbar (Test-Entkopplung): der Artefakt-Snapshot-Reader ist gegen ein Test-Double austauschbar (kein echtes FS nötig).

### Status-Endpunkt (unverändert im Router, neuer Statuswert wird durchgereicht)
- `GET /api/board/projects/:slug/ideas/:id/specify/finalize/:jobId` → `200 { status, result?, error? }` mit `status ∈ {running,done,failed,auth-expired,no-op}`. Der Router reicht den Finalizer-Status **unverändert** durch (kein Router-Umbau nötig außer ggf. Doku/Kommentar).

### Frontend (`IdeaSpecifyChatModal.jsx`)
- Neuer Zweig im Finalize-Poll: `data.status === 'no-op'` → Fehler-/Warn-Anzeige (analog `failed`/`auth-expired`), **kein** `onSpecified`, **kein** `onClose`.

## Edge-Cases & Fehlerverhalten
- **`args` mit mehreren Elementen** (heute nie genutzt, aber Contract): werden per `join(' ')` zu **einem** Prompt-Wert verkettet und mit `command` vorangestellt — ein argv-Element (kein Shell-Splitting).
- **Leerer/whitespace-only Prompt** (`buildRequirementPrompt` liefert nur die zwei Hinweise, kein Draft): der Prompt ist trotzdem nicht-leer (Hinweise), der Lauf startet regulär; entsteht dennoch keine Story → No-Op (AC5), keine Fehl-Archivierung.
- **Job endet `failed`/`auth-expired`** (nicht `done`): unverändert kein Sicherheitsnetz, keine Archivierung; Frontend zeigt Fehler inline ([[idea-specify-chat]] AC11).
- **Baseline-Snapshot schlägt fehl** (FS-Fehler beim Erfassen vor/nach dem Lauf): fail-safe → **nicht** archivieren + `no-op` (lieber eine sichtbare, nicht-archivierte Idee als stiller Verlust); best-effort geloggt, kein Crash des Status-Endpunkts.
- **Agent übernimmt die Idee-Story (Fall b)** aber legt zusätzlich keine separate Story an: die Idee ist nicht mehr `Idee` → `done`, kein No-Op (echte Arbeit geleistet).
- **Server-Neustart während Finalize:** In-Memory-Job-Registry + Baseline-Snapshot gehen verloren (Nicht-Ziel, wie bei allen headless-Runnern) → `GET :jobId` `404`, Frontend degradiert neutral.

## NFRs
- **Sicherheit (Floor):** argv als Array (kein Shell-Interpolation, security/R03) — durch den Fix **unverändert** gewahrt; harter `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block bleibt; `--dangerously-skip-permissions` bleibt ausschließlich im getrennten Headless-Pfad; keine Secrets/Token/absoluten Host-Pfade in Log/Audit/Response. Board-Schreiben nur über `BoardWriter` (atomar, kein Traversal); Board-/Spec-Lesung strikt innerhalb des validierten Projektpfads.
- **Robustheit:** Sicherheitsnetz ist fail-safe zugunsten der Idee-Sichtbarkeit (im Zweifel `no-op` statt archivieren); genau ein terminaler Statuswechsel je Job.
- **Testbarkeit:** `spawnFn`, Runner, Board-/FS-Reader, `AuditStore` und `fetchFn` injizierbar — alle ACs ohne echten `claude`-Lauf und ohne echtes FS prüfbar.
- **A11y:** No-Op-Zustand als Text (`role="alert"`/`status`, `aria-live`), nicht nur Farbe; Retry-Affordance bedienbar; Fokusführung wie die bestehenden Fehlerpfade des Modals.

## Nicht-Ziele
- **Kein** Umbau des interaktiven PTY-/`CommandService`-Pfads.
- **Kein** neuer Runner-Typ; der Fix liegt im **bestehenden** `HeadlessRunnerCore`, das Sicherheitsnetz im **bestehenden** `IdeaSpecifyFinalizer`.
- **Keine** persistente Job-/Baseline-Historie (In-Memory, geht bei Neustart verloren — wie bisher).
- **Keine** Story-ID-Kontinuitäts-Garantie (bleibt best effort; diese Spec verhindert nur die Fehl-Archivierung, nicht die ID-Kontinuität).
- **Kein** echter `claude -p`-Live-Lauf im Test-Gate (gemockter `spawnFn`, wie bei allen headless-Runnern).

## Abhängigkeiten
- [[idea-specify-chat]] (AC6–AC9 — Finalizer/Sicherheitsnetz/`archiveSupersededIdea`; diese Spec **härtet** deren AC9 und ergänzt den `no-op`-Pfad) · [[headless-parallel-drain]] (`HeadlessFlowRunner`/`HeadlessRunnerCore` — Ort des zentralen argv-Fix; alle bestehenden ACs bleiben grün) · [[headless-reconcile-runner]] (nutzt denselben Core — profitiert vom Fix, Verhalten bei `args: []` bit-identisch) · [[ideen-inbox]] (`BoardWriter`-Boundary, Status `Idee`).
