# dev-gui — GUI für die Softwareschmiede-Fabrik

Node-Vollstack: React-Frontend + Express/ws-Backend. Steuert die agent-flow-Fabrik über eine Web-GUI.

- **Engine:** fernsteuert eine INTERAKTIVE Claude-Code-Session (Abo-OAuth) per `node-pty` — KEIN Anthropic-API. `claude -p` ist **projektweit erlaubt** (Owner-Entscheidung 2026-07-01, ADR-016 in `docs/architecture.md`) — sowohl **zustandslos/tool-los** als auch **tool-fähig via `HeadlessFlowRunner`**; der **interaktive PTY-Pfad bleibt parallel bestehen** (kein PTY-Lock-Bypass für ihn) und ist keine Alleinstellungs-Doktrin mehr. **Bislang benannte Bausteine (headless, one-shot bzw. langlaufend, kein PTY-Lock, kein API-Key, auditiert):** (1) der zustandslose „Let Claude proof"-Helfer (`POST /api/assist/refine`, eigene `AssistService`-Boundary, tool-los) — AC11 docs/specs/fabric-intake-dialog.md; (2) der zustandslose Quellen-Such-Helfer (`POST /api/assist/knowledge-sources`, eigene `KnowledgeSourceService`-Boundary, **Web-fähig**: Tool-Allowlist exklusiv `WebSearch`, kein `WebFetch`) — AC10 docs/specs/team-knowledge-add.md; (3) der Headless-Reconcile-Runner (`POST /api/reconcile`, eigene `HeadlessReconcileRunner`-Boundary, `claude -p '/agent-flow:reconcile'` als Kindprozess mit eigenem `ProjectJobLock`, kein Idle-/Rate-Timer) — AC1–AC7 docs/specs/headless-reconcile-runner.md; (4) der **headless-Nacht-Drain** des Nachtwächters (`NightWatchScheduler` → separate, headless verdrahtete `ProjectDrain`-Instanz, `HeadlessFlowRunner`/`HeadlessFlowRunnerAdapter`, `claude -p '/agent-flow:flow'` als eigener Kindprozess je Lauf, **eigene** `ProjectJobLock`-Instanz — bewusst getrennt von der `ProjectDrain`-eigenen Session-Lock-Instanz, sonst Selbst-Blockade) — AC1–AC12 docs/specs/headless-parallel-drain.md; ermöglicht **echte Parallelität** mehrerer Projekt-Drains nachts, ohne den globalen PTY-Lock zu berühren; (5) der **Idee-Specify-Chat + Requirement-Finalizer** (`IdeaSpecifyChatService` — zustandsloser, tool-loser Multi-Turn-`claude -p`-Chat je Turn, Verlauf via stdin; `IdeaSpecifyFinalizer` — eigene `HeadlessFlowRunner`-Instanz mit eigener `ProjectJobLock`-Instanz, fährt `claude -p '/agent-flow:requirement'` als Kindprozess) — AC1–AC13 docs/specs/idea-specify-chat.md. Der manuelle „Board abarbeiten"-Knopf (S-196) und das Terminal bleiben davon unberührt und laufen weiterhin ausschließlich interaktiv. Alle fünf Boundaries sind getrennt (unterschiedliche Capability + Risikoprofil); `AssistService` bleibt tool-/netz-los. Kein Anthropic-API bleibt unverändert ausgeschlossen.
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
