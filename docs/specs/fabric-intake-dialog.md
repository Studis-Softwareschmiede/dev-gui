---
id: fabric-intake-dialog
title: Fabric-Intake-Dialog (Idee/Änderung erfassen → Spec/Board → Board abarbeiten)
status: draft
version: 2
---

# Spec: Fabric-Intake-Dialog  (`fabric-intake-dialog`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen).

## Zweck
Ein GUI-Dialog erfasst die **initiale Idee** (neues Repo) bzw. die **gewünschte Änderung** (bestehendes Repo) als Freitext und übergibt sie an die **bestehenden** agent-flow-Skills — ohne neuen Agenten/Bootstrap-Pfad. Der Ablauf ist eine feste **2-Phasen-Pipeline**: **Phase A** erzeugt (interaktiv) Konzept + Specs + Feature/Story aufs Board; **Phase B** lässt das Board per Knopfdruck autonom abarbeiten (z. B. über Nacht). Zusätzlich poliert ein **„Let Claude proof"-Button** jeden Freitext via `claude -p` prompt-ready auf und stellt etwaige Rückfragen sauber im Dialog dar.

> **Architektur-Hinweis (Doktrin-Erweiterung):** Bislang gilt laut `.claude/CLAUDE.md` / `docs/architecture.md` „**KEIN `claude -p`**" — dev-gui fernsteuert ausschließlich eine **interaktive** PTY-Session. Diese Spec führt `claude -p` **bewusst** als **zweiten, eng begrenzten Pfad** ein (nur der zustandslose Proof-Helfer, Baustein „Let Claude proof"). Der Flow-/Intake-Pfad (Phase A/B) bleibt **rein PTY-basiert**. Mit Annahme dieser Spec MÜSSEN `.claude/CLAUDE.md` und `docs/architecture.md` um diese Ausnahme ergänzt werden, sonst entsteht Doktrin-Drift (hartes `reviewer`-Gate).

## Verhalten

### Phase A — Erfassen → Konzept/Spec/Board (interaktiv)
1. Der Dialog öffnet kontextabhängig in zwei Modi:
   - **`new`** (neues Repo): Feld „Projektidee / Vision" (mehrzeilig), optional „Stack-Wunsch", „Constraints".
   - **`change`** (bestehendes Repo): Feld „Was soll sich ändern?" (mehrzeilig), optional „Betroffener Bereich".
2. **Die Idee/Änderung geht immer an `requirement`** — denn nur `requirement` erzeugt Konzept + Specs + Feature/Story. `new-project` bootstrappt ausschließlich das **Skelett** (Repo, Board, Stack, `.claude/`). Daraus folgt die Trigger-Anzahl je Modus:
   - **`change`** (Repo existiert bereits): **ein** Trigger — `/agent-flow:requirement <text>`.
   - **`new`** (frisches Repo): **zwei** sequentielle, **je vom Nutzer bestätigte** Trigger:
     1. **Trigger 1** — `/agent-flow:new-project` (Bootstrap, **ohne** Idee-Argument; Stack-Rückfragen laufen interaktiv im Terminal).
     2. **Trigger 2** — `/agent-flow:requirement <text>` mit der im Dialog **vorab gehaltenen** Idee. Nach dem Bootstrap ist der Pfad **identisch** zum `change`-Modus.
   Es gibt **kein** Auto-Chaining: Trigger 2 wird erst angeboten/ausgelöst, nachdem der Nutzer Trigger 1 als abgeschlossen sieht (das Idle-Timer-Lock-Modell aus [[flow-trigger]] eignet sich nicht für automatisches Verketten zweier interaktiver Läufe).
3. Bei **Submit** eines Triggers wird der mehrzeilige Idee-Text zu **einer** Zeile kollabiert (Newlines/Whitespace → einzelne Spaces, getrimmt) und als Argument an die `/agent-flow:requirement`-Zeile gehängt. `new-project` wird **ohne** Argument ausgelöst. Die fertige **Einzeilen**-Befehlszeile geht unverändert über den **bestehenden** `POST /api/command` (siehe [[flow-trigger]]); Allowlist + Sanitisierung bleiben die Enforcement-Grenze.
4. `/agent-flow:new-project` wird **neu in die Allowlist** aufgenommen (Backend-Konfiguration + Frontend-Katalog). Alle übrigen Allowlist-Regeln aus [[flow-trigger]] gelten unverändert.
5. Nach `202 {commandId, status:"running"}` **wechselt das GUI in den Terminal-Pane** ([[terminal-frontend]]). Die Rückfragen des `requirement`/`new-project`-Agenten erscheinen **live im Terminal** und werden dort beantwortet (Terminal-Handoff). Die Erzeugung von Konzept/Specs/Feature/Story liegt **vollständig beim Agenten**, nicht in dev-gui.

### „Let Claude proof"-Button (Headless-Helfer, `claude -p`)
6. Jedes Freitextfeld trägt einen **„Let Claude proof"-Button**. Er schickt den Feldinhalt an `POST /api/assist/refine` und erhält strukturiert zurück: einen **prompt-ready aufbereiteten Text** plus eine Liste **offener Rückfragen**.
7. Der Dialog zeigt `refinedText` **editierbar** an („Übernehmen" ersetzt den Feldinhalt) und rendert `openQuestions` als **saubere Liste** im Dialog (Frage + Begründung, optional Antwort-Optionen). Der Nutzer kann Antworten einarbeiten und erneut proofen.
8. Der Proof-Aufruf ist **zustandslos/one-shot** (`claude -p`), nimmt **nicht** den PTY-Job-Lock aus [[flow-trigger]] und funktioniert **auch während ein Flow-Lauf aktiv ist**. Er ist eine reine Vor-Aufbereitung — die **maßgebliche** Klärung übernimmt weiterhin der interaktive `requirement`-Agent in Phase A.

### Phase B — Board abarbeiten (autonom)
9. Ein Button **„Board abarbeiten"** löst den **bestehenden** `/agent-flow:flow` aus (über `POST /api/command`). Das ist der „starten und schlafen gehen"-Teil; der Lauf erscheint live im Terminal. Bei bereits laufendem Job ist der Button — wie alle Trigger — deaktiviert (bestehendes globales Lock-Modell, [[flow-trigger]] AC3).

## Acceptance-Kriterien

- **AC1** — Der Intake-Dialog öffnet in zwei Modi (`new`, `change`) mit **mehrzeiliger** Freitexterfassung. Die Idee/Änderung adressiert **immer** `requirement`; `new` schiebt **davor** einen `new-project`-Bootstrap-Trigger.
- **AC2** — Modus-abhängige Trigger-Zahl: `change` löst **einen** Trigger `/agent-flow:requirement <text>` aus; `new` löst **zwei** sequentielle, je vom Nutzer bestätigte Trigger aus — zuerst `/agent-flow:new-project` (**ohne** Argument), nach dessen sichtbarem Abschluss `/agent-flow:requirement <text>`. Es gibt **kein** automatisches Verketten (Trigger 2 erst nach Nutzer-Bestätigung).
- **AC2b** — Bei jedem Idee-Trigger wird der erfasste Text **client-seitig zu einer einzigen Zeile kollabiert** (alle Steuer-/Zeilenumbrüche → einzelne Spaces, getrimmt) und als Argument an die `/agent-flow:requirement`-Zeile gehängt; die resultierende Zeile enthält **keine** Steuerzeichen und passiert die bestehende Backend-Sanitisierung ([[flow-trigger]] AC2) unverändert. `new-project` trägt **kein** Idee-Argument.
- **AC3** — `/agent-flow:new-project` ist in der **Backend-Allowlist** (`DEFAULT_ALLOWED_COMMANDS`) **und** im Frontend-Befehlskatalog enthalten; ein Trigger mit diesem Präfix wird akzeptiert (202), alle bisher gelisteten Präfixe bleiben gültig (Backwards-Compat).
- **AC4** — Nach erfolgreichem Submit (`202`) wechselt die Ansicht in den Terminal-Pane; die interaktiven Rückfragen des Agenten erscheinen im `/ws/terminal`-Stream.
- **AC5** — `POST /api/assist/refine {text, kind}` antwortet `200 {refinedText, openQuestions[]}`; der Aufruf nutzt `claude -p` als **zustandslosen one-shot** und **belegt den PTY-Job-Lock nicht** (ein parallel laufender Flow-Command bleibt unberührt; kein `409`).
- **AC6** — Das Frontend rendert `refinedText` editierbar (mit „Übernehmen") und `openQuestions` als zugängliche Liste (Frage + Begründung; optionale Optionen). Leerer Feldinhalt löst **keinen** Proof-Request aus.
- **AC7** — Der Proof-Pfad liegt hinter dem AccessGuard und ist **auditiert** (genau ein Audit-Eintrag je akzeptiertem Aufruf, Identität + Aktion, **ohne** Klartext-Secret); der Nutzer-Text wird via **stdin** an `claude -p` übergeben, **nicht** als argv (keine Prozessliste-/Log-Leaks).
- **AC8** — Der Button „Board abarbeiten" löst `/agent-flow:flow` über `POST /api/command` aus und ist bei aktivem Job (Session `busy`) deaktiviert; der Kill-Switch aus [[flow-trigger]] bleibt wirksam.
- **AC9** — Für `requirement` (cost-aware) bietet der Dialog den **Cost-Mode-Schalter** analog [[flow-trigger]] AC9 an (Default `balanced` → kein Flag); `new-project` bietet — wie `adopt` — **keinen** Cost-Mode.
- **AC10** — Schlägt `claude -p` fehl oder ist nicht verfügbar, liefert `/api/assist/refine` einen klaren Fehler (`502`) **ohne** Secret-/Pfad-Leak; der Dialog bleibt nutzbar (Feldinhalt unverändert, Submit weiterhin möglich).
- **AC11** (Doktrin-Anpassung — Drift-Gate) — Mit Einführung des `claude -p`-Proof-Pfads sind `.claude/CLAUDE.md` und `docs/architecture.md` so ergänzt, dass die bisherige Absolutaussage „**KEIN `claude -p`**" als **eng begrenzte, bewusste Ausnahme** für den zustandslosen Proof-Helfer (`/api/assist/refine`) ausgewiesen ist: der interaktive PTY-/Flow-/Intake-Pfad bleibt unverändert die einzige Engine; der Proof-Pfad ist als zweiter, zustandsloser one-shot-Pfad benannt (eigene Headless-Boundary, kein PTY-Lock). Nach der Anpassung enthält die Engine-Doktrin **keine** unbedingte „kein `claude -p`"-Aussage mehr, die den Proof-Helfer ausschließt (sonst Doktrin-Drift → hartes `reviewer`-Gate). Diese Story ändert **ausschließlich** `docs/`/`.claude/`-Doktrin-Dokumente, keinen Laufzeit-Code.

## Verträge

- **`POST /api/assist/refine`** — Body `{ text: string, kind: "idea" | "change", repoContext?: string }`.
  - **200** `{ refinedText: string, openQuestions: Array<{ question: string, why?: string, options?: string[] }>, notes?: string }`.
  - **400** bei leerem/ungültigem `text` oder unbekanntem `kind` (kein `claude -p`-Aufruf).
  - **502** bei `claude -p`-Fehler/Nichtverfügbarkeit (AC10).
  - Hinter AccessGuard; jeder akzeptierte Aufruf erzeugt **einen** Audit-Eintrag (AC7). `text` geht via **stdin** in `claude -p`, nie als argv/URL.
- **`POST /api/command`** (bestehend, [[flow-trigger]]) — unverändert; **Allowlist erweitert** um `/agent-flow:new-project`. Die vom Dialog komponierte Einzeilen-Zeile (`/agent-flow:new-project <text>` bzw. `/agent-flow:requirement <text>`) wird hierüber injiziert.
- **Allowlist** als Konfiguration (exportierte Liste) — neuer Eintrag `/agent-flow:new-project`; nicht verstreut hartkodiert.
- **Headless-Boundary:** `claude -p` wird in einem eigenen, schmalen Service gekapselt (analog zur Boundary-Trennung bei `GitHubWriter`/`GitHubReader`); kein Vermischen mit dem PTY-Pfad.

## Edge-Cases & Fehlerverhalten
- Leerer/Whitespace-Text → kein Request (weder Proof noch Submit); Frontend-Validierung, kein `400`-Roundtrip.
- Proof während laufendem Flow-Command → erlaubt (kein Lock), AC5.
- Sehr langer kollabierter Freitext → wird als eine (lange) Zeile injiziert; der PTY verarbeitet lange Zeilen. Kein künstliches Längenlimit, aber Hinweis: nur **eine** Zeile.
- `claude -p` nicht im Container/PATH → `502` mit klarer Meldung (AC10), kein Secret-Leak.
- Modus `new`: Trigger 1 (`new-project`) bootstrappt das Skelett (Agenten-Verantwortung); Trigger 2 (`requirement`) wird **erst** angeboten, nachdem der Nutzer Trigger 1 als abgeschlossen sieht — kein Auto-Chaining (Idle-Timer-Lock eignet sich nicht zum Verketten interaktiver Läufe). Bricht der Nutzer nach Trigger 1 ab, bleibt ein gebootstrapptes, aber Spec-/Board-leeres Repo zurück (zulässiger Zwischenzustand; Trigger 2 später nachholbar).

## NFRs
- **Sicherheit (Floor):** Proof-Pfad auditiert + hinter AccessGuard; Nutzer-Text via stdin (nicht argv); keine Secrets in Logs/Audit/Response/WS. Submit reicht ausschließlich eine **sanitisierte Einzeilen**-Befehlszeile in den bestehenden, allowlist-geschützten Command-Kanal.
- **A11y:** Dialogfelder beschriftet, Fehler programmatisch zugeordnet, Fokusführung beim Öffnen/Submit/Fehler; `openQuestions`-Liste semantisch ausgezeichnet; Status nie nur über Farbe ([[terminal-frontend]]/design.md).

## Nicht-Ziele
- **Kein** neuer Agent, **kein** neuer Bootstrap-Pfad — ausschließlich Wiederverwendung von `new-project`/`requirement`/`flow`.
- **Keine** In-Dialog-Beantwortung der requirement-Rückfragen (bewusst: Rückfragen laufen interaktiv im Terminal-Handoff). Eine headless In-Dialog-Q&A-Schleife ist eine mögliche **Folge**-Anforderung.
- **Kein** mehrzeiliger Transport durch `POST /api/command` (Single-Line-Vertrag aus [[flow-trigger]] AC2 bleibt unangetastet).

## Abhängigkeiten
- [[flow-trigger]] (Command-Kanal, Allowlist, Lock, Audit, Cost-Mode) · [[terminal-frontend]] (Live-Ausgabe, Pane-Wechsel) · [[access-and-guardrails]] (AccessGuard, Audit-First).
- **agent-flow-Skills:** `new-project` (Bootstrap, ohne Idee-Argument), `requirement` (Idee/Änderung → Konzept/Specs/Feature/Story), `flow` (Abarbeitung). **Keine** Änderung an diesen Skills nötig — `new-project` muss **kein** Freitext-Argument akzeptieren, da die Idee ausschließlich an `requirement` geht.
- **Doktrin-Anpassung (eigenes Board-Item, AC11):** `.claude/CLAUDE.md` + `docs/architecture.md` um die `claude -p`-Ausnahme für den Proof-Helfer ergänzen (siehe Architektur-Hinweis unter „Zweck" + **AC11**), sonst Drift gegen die dokumentierte Engine-Doktrin (ADR-001). Dies ist eine **bewusste Owner-Entscheidung**, kein zu „behebender" Widerspruch.
