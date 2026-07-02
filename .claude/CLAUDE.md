# dev-gui — GUI für die Softwareschmiede-Fabrik

Node-Vollstack: React-Frontend + Express/ws-Backend. Steuert die agent-flow-Fabrik über eine Web-GUI.

- **Engine:** fernsteuert eine INTERAKTIVE Claude-Code-Session (Abo-OAuth) per `node-pty` — KEIN Anthropic-API. `claude -p` ist **projektweit erlaubt** (Owner-Entscheidung 2026-07-01, ADR-016 in `docs/architecture.md`) — sowohl **zustandslos/tool-los** als auch **tool-fähig via `HeadlessFlowRunner`**; der **interaktive PTY-Pfad bleibt parallel bestehen** (kein PTY-Lock-Bypass für ihn) und ist keine Alleinstellungs-Doktrin mehr. **Bislang benannte Bausteine (headless, one-shot bzw. langlaufend, kein PTY-Lock, kein API-Key, auditiert):** (1) der zustandslose „Let Claude proof"-Helfer (`POST /api/assist/refine`, eigene `AssistService`-Boundary, tool-los) — AC11 docs/specs/fabric-intake-dialog.md; (2) der zustandslose Quellen-Such-Helfer (`POST /api/assist/knowledge-sources`, eigene `KnowledgeSourceService`-Boundary, **Web-fähig**: Tool-Allowlist exklusiv `WebSearch`, kein `WebFetch`) — AC10 docs/specs/team-knowledge-add.md; (3) der Headless-Reconcile-Runner (`POST /api/reconcile`, eigene `HeadlessReconcileRunner`-Boundary, `claude -p '/agent-flow:reconcile'` als Kindprozess mit eigenem `ProjectJobLock`, kein Idle-/Rate-Timer) — AC1–AC7 docs/specs/headless-reconcile-runner.md; (4) der **headless-Nacht-Drain** des Nachtwächters (`NightWatchScheduler` → separate, headless verdrahtete `ProjectDrain`-Instanz, `HeadlessFlowRunner`/`HeadlessFlowRunnerAdapter`, `claude -p '/agent-flow:flow'` als eigener Kindprozess je Lauf, **eigene** `ProjectJobLock`-Instanz — bewusst getrennt von der `ProjectDrain`-eigenen Session-Lock-Instanz, sonst Selbst-Blockade) — AC1–AC12 docs/specs/headless-parallel-drain.md; ermöglicht **echte Parallelität** mehrerer Projekt-Drains nachts, ohne den globalen PTY-Lock zu berühren; (5) der **Idee-Specify-Chat + Requirement-Finalizer** (`IdeaSpecifyChatService` — zustandsloser, tool-loser Multi-Turn-`claude -p`-Chat je Turn, Verlauf via stdin; `IdeaSpecifyFinalizer` — eigene `HeadlessFlowRunner`-Instanz mit eigener `ProjectJobLock`-Instanz, fährt `claude -p '/agent-flow:requirement'` als Kindprozess) — AC1–AC13 docs/specs/idea-specify-chat.md; (6) der **manuelle „Board abarbeiten"-Knopf** (Fabrik-Panel, „Arbeiten"-Tab) läuft seit **ADR-017** (Owner-Entscheidung 2026-07-01) **ebenfalls headless**: `POST /api/projects/:slug/drain` fährt eine **eigene, headless verdrahtete `ProjectDrain`-Instanz** (`HeadlessFlowRunnerAdapter` um eine **eigene `HeadlessFlowRunner`-Instanz** mit **eigener `ProjectJobLock`-Instanz** — getrennt von Nacht-Drain/Reconcile-Runner/`IdeaSpecifyFinalizer`), deren Flow-Schritt je Drain-Runde ein `claude -p '/agent-flow:flow …'`-Kindprozess ist (kein PTY-Write, kein globaler PTY-Lock); optionaler Cost-Mode via `--cost <mode>` — AC1–AC8 docs/specs/headless-manual-drain.md. **Rein interaktiv (PTY-`CommandService`, unverändert)** bleiben nur noch das **Terminal** (freies Arbeiten) und die **verschlankte Befehls-Auslösung** (`adopt`/`preview`/`train`/`new-project` + Kill-Switch); der interaktive PTY-Pfad bleibt vollständig bestehen — nur der **Ausführungspfad des „Board abarbeiten"-Knopfs** wechselte von interaktiv auf headless. Alle sechs Boundaries sind getrennt (unterschiedliche Capability + Risikoprofil); `AssistService` bleibt tool-/netz-los. Kein Anthropic-API bleibt unverändert ausgeschlossen.
- **Auth:** Cloudflare Access vor dem öffentlichen Endpunkt (`devgui.<domain>`).
- **State:** live aus GitHub-API + Docker, keine eigene DB.
- **Konventionen:** ESM, async/await; kein Secret in Code/Log.
- **Source of Truth:** `docs/concept.md` + `docs/architecture.md` (Schicht 1+2), `docs/specs/*.md` (Schicht 3).

## gh-Auth: GitHub-App-Token erneuern (bei `HTTP 401: Bad credentials`)

`gh` ist als GitHub App **`softwareschmiede-bot[bot]`** eingeloggt; Installation-Tokens sind nur **~1h gültig**. Bei 401 NICHT `gh auth login` interaktiv vorschlagen, sondern frischen Token über das agent-flow-Plugin minten:

```bash
"$(ls -dt ~/.claude/plugins/cache/agent-flow/agent-flow/*/ | head -1)scripts/ensure-gh-auth.sh"
```

Der Glob ist die **robuste, update-feste Variante** — er löst stets auf die aktuellste Plugin-Version auf.

Für Kontexte ohne Glob-Auflösung (z.B. manuelles Ausführen in einer Shell, die Glob-Expansion in Anführungszeichen unterdrückt) ist nachfolgend der **aktuell aufgelöste absolute Pfad** (Plugin-Version `1da6c7dfc966`) angegeben:

```bash
/Users/alex/.claude/plugins/cache/agent-flow/agent-flow/1da6c7dfc966/scripts/ensure-gh-auth.sh
```

> **Hinweis:** Nach einem Plugin-Update ist dieser absolute Pfad veraltet. Neuen Pfad via `ls -dt ~/.claude/plugins/cache/agent-flow/agent-flow/*/` ermitteln und hier aktualisieren. Der Glob oben bleibt davon unberührt.

Das Skript mintet den App-Token aus `.env.gpg`, loggt `gh` persistent ein (`~/.config/gh`) und konfiguriert git via `gh auth setup-git`. Idempotent — bei gültiger Auth passiert nichts. Gleicher Mechanismus läuft im Container über `docker-entrypoint.sh`.

## Parallelbetrieb: mehrere Cloud-Sessions

Der Owner arbeitet an diesem Repo häufig mit mehreren Cloud-Sessions gleichzeitig (z. B. um mehrere Anforderungen parallel einzubringen). Fremde, session-fremde Änderungen im Working Tree/Board sind normal — kein Hinweis an den Owner nötig, solange keine eigene Arbeit dadurch verloren geht.

**Pflicht: eigener Branch UND eigener Worktree.** Ein reiner Branch-Wechsel reicht NICHT — er tauscht die Dateien im geteilten Hauptordner auch für jede andere dort aktive Session aus. Bevor eine Session in diesem Repo schreibend tätig wird (Board-Dateien, Specs, Code) und nicht sicher ausschließen kann, dass sie die einzige aktive Session ist, MUSS sie zuerst `EnterWorktree` aufrufen (eigener Ordner unter `.claude/worktrees/`, eigener Branch, gleiche Git-Historie wie der Hauptordner). Am Ende der Session: Änderungen committen + pushen, danach `ExitWorktree` (`action: "remove"`, sobald nichts mehr daraus gebraucht wird).

**Warum:** `git checkout`/`reset`/`clean` im Hauptordner wirkt sich auf ALLE dort aktiven Prozesse aus — auch auf noch nicht committete Änderungen einer anderen Session. Das führt zu stillem Datenverlust statt zu einem sichtbaren Konflikt. *(Vorfall 2026-07-02: ein `/requirement`-Lauf verlor zweimal frisch angelegte Board-Items, weil eine parallele Headless-Flow-Session im selben Hauptordner reset/clean ausführte.)*

Ausnahme: rein lesende Sessions (nur ansehen, keine Schreiboperation geplant) können im Hauptordner bleiben. Beauftragt der Owner explizit eine Board-weite Abarbeitung (z. B. `/agent-flow:flow`, Nachtwächter-Modus), darf übergreifend über mehrere Stories hinweg gearbeitet werden.

## Kommunikation mit dem Owner

Diese Vorgaben gelten für die **Haupt-Session im Dialog mit dem Owner** — nicht für die Arbeits-Agenten (coder/reviewer/tester/…), die ihren Handoff-Verträgen folgen.

- **Ergebnis zuerst.** 1–2 Sätze in Alltagssprache, was passiert ist bzw. was empfohlen wird. Kein Status-Dump aller berührten Dateien.
- **Wenig Fachjargon.** Kürzel/IDs (z. B. AC-Nummern, K3, Datei-Pfade) nur wenn nötig — und beim ersten Mal kurz erklären. Lieber ein Bild als ein Fachbegriff.
- **3-Schichten-Antwort:**
  1. **Ergebnis** — immer, ohne Jargon.
  2. **Begründung** — nur wenn nötig, kurze Stichpunkte in Alltagssprache.
  3. **Technische Details** (Pfade, Kürzel, Zeilennummern) — nur auf Nachfrage oder bei echtem Risiko.
- **Länge an die Frage koppeln.** Kurze Frage → kurze Antwort.
- **Steuerwörter des Owners** (sofort befolgen):
  - `kurz` → nur Schicht 1.
  - `erklär` → Schicht 1 + 2 in Alltagssprache.
  - `technisch` → volle Details mit Pfaden/Kürzeln.
