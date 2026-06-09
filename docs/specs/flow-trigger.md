---
id: flow-trigger
title: Flow-Trigger (Slash-Befehl in die Session injizieren)
status: draft
version: 4
---

# Spec: Flow-Trigger (`flow-trigger`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.

## Zweck
Fabrik-Flows auf Knopfdruck: ein GUI-Trigger injiziert einen **erlaubten** Slash-Befehl in die interaktive Session; der Lauf erscheint live im Terminal. Mit Concurrency-Schutz, Kill-Switch und vollständigem Audit-Eintrag.

## Verhalten
1. `POST /api/command {command}` injiziert den Befehl in die Session (schreibt `command\n` in den PTY) und markiert den Command als `running`.
2. Es gibt eine **Allowlist** erlaubter Befehls-Präfixe — die **Plugin-namespaced** agent-flow-Skill-Befehle: `/agent-flow:flow`, `/agent-flow:adopt`, `/agent-flow:preview`, `/agent-flow:requirement`, `/agent-flow:train`. Nicht-gelistete Befehle werden abgewiesen. *(Claude Code adressiert Plugin-Skills mit dem `<plugin>:`-Präfix — ohne `/agent-flow:` kennt Claude die Befehle nicht.)* Sub-Befehle/Argumente (s. Befehls-Katalog) folgen dem Präfix in derselben Zeile.
3. **Concurrency-Lock = 1:** ist bereits ein Command `running` (Session `busy`), wird ein weiterer Trigger abgelehnt.
4. **Kill-Switch:** `POST /api/command/cancel` sendet einen Interrupt (Ctrl-C) an die Session und gibt den Lock frei.
5. Frontend-Panels (Projekt/Item wählen → Aktions-Button) rufen diese Endpunkte; der Verlauf erscheint im Terminal-Pane aus [[terminal-frontend]].
6. **Cost-Mode (Token-Hebel):** Für die Agent-dispatchenden Befehle (`flow`, `requirement`, `train`) kann das Panel einen Modus-Schalter mitschicken — als **`--cost <mode>`-Flag** direkt nach dem Befehls-Präfix. Gültige Modi: `low-cost | balanced | max-quality` (Enum). `balanced` ist der Default und wird **nicht** als Flag gesendet (der Projekt-Default `profile.cost_mode` in agent-flow greift). Der agent-flow-Skill liest das Flag und wählt je Agent ein günstigeres/teureres Modell — schont Token bei Prototypen, dreht für kritische Reviews/Tests/Retros auf. *(Vertrag mit agent-flow `knowledge/model-tiers.md` — dev-gui injiziert nur das Flag, die Modell-Auflösung liegt in agent-flow.)*

## Completion-Modell (Command → done, Lock frei)
Ein laufender Command gilt als **abgeschlossen**, sobald der PTY für eine konfigurierbare **Quiet-Period** (`COMMAND_IDLE_MS`, default `8000` ms) keine Ausgabe mehr produziert. Dann: `status → done`, Lock freigegeben.

- Der Timer wird bei jeder PTY-Ausgabe zurückgesetzt.
- `COMMAND_IDLE_MS` ist per Env-Var injizierbar (Tests nutzen einen kurzen Wert, z.B. 200 ms).
- Vorzeitiges Ende via `POST /api/command/cancel`: Ctrl-C wird gesendet, `status → cancelled`, Lock sofort freigegeben (kein Warten auf Idle).
- **Bekanntes Risiko:** Produziert ein laufender Command eine längere Pause ohne Ausgabe (z.B. während eines interaktiven Prompts oder I/O-Wartezeit), kann der Idle-Timer den Lock vorzeitig freigeben — Aufrufer sollten den tatsächlichen Session-State via `/api/session` konsultieren, bevor sie einen neuen Command senden.

## Befehls-Katalog (was das Panel anbietet)
Das Frontend ist **befehls-bewusst**: je gewähltem Befehl bietet es die gültigen Sub-Befehle/Argumente an und komponiert daraus die vollständige Befehlszeile.

| Befehl | Sub-Befehl / Argument | Cost-Mode | Beispiel-Zeile |
|---|---|---|---|
| `/agent-flow:flow` | — (arbeitet das Board ab) | ✓ | `/agent-flow:flow --cost max-quality` |
| `/agent-flow:adopt` | `<owner/repo>` (Pflicht) | — | `/agent-flow:adopt octocat/Hello-World` |
| `/agent-flow:preview` | `up <repo>` · `down <repo>` · `list` · `available` | — | `/agent-flow:preview up sandbox-2` |
| `/agent-flow:requirement` | optionaler Kontext/Feature-Text | ✓ | `/agent-flow:requirement --cost low-cost Dark-Mode-Toggle` |
| `/agent-flow:train` | optional `<lang\|domain>` | ✓ | `/agent-flow:train --cost max-quality security` |

- Bei `preview up`/`preview down` und `adopt` stammt die `<repo>`-Auswahl aus der **Projektliste** (`/api/status`), damit kein Tippfehler nötig ist.
- **Cost-Mode (Spalte ✓):** nur die Agent-dispatchenden Befehle (`flow`/`requirement`/`train`) bieten den Schalter. Das `--cost <mode>`-Flag steht **direkt nach dem Präfix**, vor sub/arg/Freitext. `balanced` → Flag weggelassen. `preview` (kein Agent) und `adopt` (eigener Flow) bieten keinen Cost-Mode.
- Die komponierte Zeile wird unverändert (sanitisiert, **eine** Zeile) als `command` an `POST /api/command` geschickt; die Allowlist prüft das **Präfix** (`/agent-flow:<skill>`), und ein etwaiges `--cost`-Flag wird gegen das Modus-Enum validiert (AC8).

## Acceptance-Kriterien
- **AC1** — `POST /api/command {command}` mit erlaubtem Befehl schreibt `command\n` in den PTY und antwortet `202 {commandId, status:"running"}`; der Output erscheint im `/ws/terminal`-Stream.
- **AC2** — Befehle werden gegen eine **Allowlist** der `/agent-flow:`-**namespaced** Präfixe geprüft (`/agent-flow:flow|adopt|preview|requirement|train`); ein nicht-gelisteter (inkl. **un-namespaced** wie `/preview` oder `/flow`) oder leerer Befehl → `400` und **nichts** wird in den PTY geschrieben; kein Audit-Eintrag. **Sanitisierung:** Befehle mit Newline/CR oder sonstigen Steuerzeichen (U+0000–U+001F, U+007F) werden ebenfalls mit `400` abgewiesen (verhindert Mehrfach-Zeilen-Injektion); **nichts** wird in den PTY geschrieben.
- **AC3** — Ist bereits ein Command `running`, liefert `POST /api/command` `409` (kein zweiter paralleler Job) — der Lock gilt **global**, nicht pro Client.
- **AC4** — Das Frontend zeigt ein **befehls-bewusstes** Trigger-Panel: Befehl wählen → die gültigen Sub-Befehle/Argumente erscheinen (Befehls-Katalog); `preview` bietet `up|down|list|available` (bei `up`/`down` ein `<repo>` aus der Projektliste), `adopt` ein `<owner/repo>`. Daraus wird die vollständige `/agent-flow:…`-Zeile komponiert und per `/api/command` ausgelöst. Bei aktivem Job sind Trigger deaktiviert und der Kill-Button aktiv.
- **AC5** — `POST /api/command/cancel` sendet Interrupt an die Session, setzt den laufenden Command auf `cancelled` und gibt den Lock frei (`/api/session` wird wieder `ready`).
- **AC6** — Jeder **akzeptierte** Command erzeugt **genau einen** Audit-Eintrag (`AuditStore.record({identity, command})`) mit der Access-Identität des Auslösers (`req.identity.email`, oder `null` bei Dev-Bypass). Das Audit-Schreiben erfolgt **vor** dem PTY-Write. Schlägt `record()` fehl, wird der Command **nicht** ausgeführt und der Lock sofort freigegeben — kein nicht-auditierter Lauf. *(Schließt [[access-and-guardrails]] AC3 end-to-end ab.)*
- **AC7** — Die vom Panel komponierte Befehlszeile trägt das `/agent-flow:`-Präfix und (wo zutreffend) Sub-Befehl + Argument in **einer** Zeile (z.B. `/agent-flow:preview up sandbox-2`). `list`/`available` werden ohne Argument gesendet; `up`/`down`/`adopt` **ohne** gewähltes `<repo>`/`<owner/repo>` lösen keinen Request aus (Frontend-Validierung, kein `400`-Roundtrip nötig).
- **AC8** (Cost-Mode-Validierung, Backend) — Enthält ein akzeptierter Befehl ein `--cost`-Flag, MUSS der **unmittelbar folgende** Token ∈ `{low-cost, balanced, max-quality}` sein; andernfalls → `400` und **nichts** wird in den PTY geschrieben (kein Audit-Eintrag). Ein `--cost` als **letzter** Token (ohne Wert) → ebenfalls `400`. Die Prüfung ist **command-agnostisch** (greift für jeden Befehl, der das Flag trägt) und liegt als Konfiguration neben der Allowlist (nicht verstreut). Befehle **ohne** `--cost` sind von AC8 unberührt (Backwards-Compat: `/agent-flow:flow` bleibt gültig).
- **AC9** (Cost-Mode-Schalter, Frontend) — Für `flow`/`requirement`/`train` zeigt das Panel einen **3-Wege-Schalter** (`low-cost | balanced | max-quality`, Default `balanced`). Bei `balanced` wird **kein** `--cost`-Flag in die Zeile komponiert (`/agent-flow:flow` bleibt bare); bei `low-cost`/`max-quality` steht `--cost <mode>` direkt nach dem Präfix, vor sub/arg/Freitext (z.B. `/agent-flow:requirement --cost low-cost Dark-Mode-Toggle`). Für `preview`/`adopt` ist der Schalter **nicht** sichtbar.

## Verträge
- `POST /api/command` `{command:string}` → `202 {commandId, status}` | `400` (Allowlist / Sanitisierung / **Cost-Mode-Enum (AC8)** / Audit-Fehler) | `409` (Lock) | `500` (interner/PTY-Write-Fehler).
- `POST /api/command/cancel` → `200 {cancelled:bool}`.
- Allowlist als Konfiguration (Liste erlaubter Präfixe), nicht hartkodiert verstreut.
- Cost-Mode-Enum (`low-cost|balanced|max-quality`) als Konfiguration (exportierte Konstante), nicht verstreut; `--cost`-Validierung command-agnostisch (AC8).
- `COMMAND_IDLE_MS` (Env, integer > 0, default 8000) — konfiguriert die Quiet-Period; testbar mit kurzem Wert.

## Edge-Cases & Fehlerverhalten
- Session nicht `ready` (z.B. `starting`/`failed`) → der PTY-Write wird von `PtyManager.write()` verworfen; der Command-Lifecycle läuft trotzdem durch (AC1 schreibt in PTY, Ausgabe folgt sobald Session ready ist). Bewusste Designentscheidung: CommandService kennt den Session-State nicht direkt.
- Befehl mit Steuerzeichen/Newline-Injection → wird mit `400` abgewiesen (kein Mehrfach-Befehl schmuggeln), AC2.
- `cancel()` ohne laufenden Command → `{ cancelled: false }` (idempotent, kein Fehler).

## NFRs
- **Sicherheit (Floor):** Allowlist + Sanitisierung verhindern beliebige Befehls-Injektion; jeder akzeptierte Command wird auditiert (AC6). Befehls-String wird nie unsanitisiert in eine Shell, nur in den PTY der Session geschrieben. Keine Secrets in Logs oder Audit.

## Nicht-Ziele
- Freitext-Befehle außerhalb der Allowlist (bewusst eng).

## Abhängigkeiten
- [[terminal-bridge]] (PTY/Session) · [[access-and-guardrails]] (Gate, Lock, Audit) · [[terminal-frontend]] (Live-Ausgabe).
