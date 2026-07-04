---
id: terminal-bridge
title: Terminal-Bridge (PTY ↔ interaktive Claude-Session)
status: draft
area: fabrik-arbeiten
version: 2
---

# Spec: Terminal-Bridge (`terminal-bridge`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> Source of Truth für `coder`/`tester`/`reviewer` (Drift-Gate).

## Zweck
Das Backend hält **genau eine** interaktive Claude-Code-Session in einem PTY (Abo-OAuth, **kein** API/`-p`) und macht ihren Ein-/Ausgabestrom über WebSocket verfügbar. Fundament für Frontend-Terminal und Flow-Trigger.

## Verhalten
1. Beim Boot startet der PtyManager eine `claude`-Session interaktiv im PTY und führt einen Session-Zustand (`starting → ready ⇄ busy`, `stopped`, `failed`).
2. Es existiert zu jedem Zeitpunkt **höchstens eine** Session.
3. Über WebSocket `/ws/terminal` fließen Client-Eingaben in den PTY und PTY-Ausgaben (byteweise, ANSI erhalten) an **alle** verbundenen Clients.
4. Stürzt die Session ab/endet sie, startet der PtyManager sie neu — bis *N* Restarts in *M* s, danach Zustand `failed`.
5. Der Client meldet die Terminalgröße (`{type:"resize",cols,rows}`); das Backend passt die PTY-Größe an (`pty.resize`), damit das Voll-TUI von `claude` in der **tatsächlichen** Client-Größe rendert (sonst verschobene/unlesbare Darstellung). Die PTY startet mit einer sinnvollen Initialgröße.
6. Das Backend hält einen **begrenzten Ring-Puffer** der jüngsten PTY-Ausgabe und **spielt ihn einem neu verbundenen WS-Client sofort vor** (Scrollback-Replay) — ein spät verbundener Browser sieht den aktuellen Bildschirm statt eines leeren Terminals.

## Acceptance-Kriterien
- **AC1** — `GET /api/session` liefert den aktuellen Session-Zustand (`starting|ready|busy|stopped|failed`). Nach dem Boot erreicht er ohne Eingabe `ready`.
- **AC2** — WebSocket `/ws/terminal`: eine vom Client gesendete Eingabe wird in den PTY geschrieben; PTY-Ausgabe wird an alle verbundenen Clients gestreamt (ANSI-Sequenzen bleiben erhalten).
- **AC3** — Die Session läuft **ohne** `-p`/`--print` und **ohne** gesetzten `ANTHROPIC_API_KEY` (Auth = Abo-OAuth). Testbar: die gestartete Befehlszeile enthält kein `-p`/`--print`; die Prozess-Umgebung enthält keinen `ANTHROPIC_API_KEY`. Allgemeiner: der PTY-Child-Env wird aus einer **expliziten Allowlist** gebaut, nicht aus `process.env` (security/R01). Auf der Liste stehen Shell-/Locale-Plumbing (`PATH, HOME, TERM, LANG, LC_ALL, LC_CTYPE, USER, LOGNAME, SHELL, TZ`) **plus** die Skill-Bridge-Vars, die `/agent-flow:*`-Skills im Session-Kontext brauchen: `DOCKER_HOST` (verweist die `docker`-CLI auf den socket-proxy — Adresse, kein Secret) und `GPG_PASSPHRASE` (entschlüsselt `.env.gpg` für Token-Refresh; ist nicht „geheimer" als der Inhalt der Datei, die die Skills sowieso lesen). Explizit **nicht** auf der Liste und damit blockiert sind alle Server-/Plattform-Configs: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `NODE_ENV`, `DEV_NO_ACCESS`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GH_TOKEN`/`GITHUB_TOKEN` (letztere zusätzlich vom Entrypoint vor `exec node server.js` `unset`, siehe [[deployment]] AC7). Testbar: `/proc/<claude-pid>/environ` zeigt nur die Allowlist-Keys, keine blockierten. **Erweiterung:** Die Allowlist umfasst zusätzlich `CLAUDE_CODE_OAUTH_TOKEN` (langlebige Agent-Auth, bewusst durchgereicht — im Gegensatz zu `ANTHROPIC_API_KEY`); Verhalten + Tests dazu in [[claude-code-oauth-token]].
- **AC4** — Beendet sich die Session unerwartet, wird sie automatisch neu gestartet; nach Überschreiten von *N* Restarts in *M* s bleibt der Zustand `failed` (kein Endlos-Restart).
- **AC5** — Sendet der Client `{type:"resize", cols, rows}` (cols/rows positive Integer), ruft das Backend `pty.resize(cols, rows)` auf; die PTY wird mit einer sinnvollen Initialgröße gestartet. Testbar: nach einem resize-Event hat die PTY die gemeldeten Maße; ungültige (nicht-positive/nicht-numerische) Werte werden ignoriert (kein Absturz).
- **AC6** — Ein neu verbundener `/ws/terminal`-Client erhält **sofort beim Connect** den gepufferten jüngsten PTY-Output (begrenzter Ring-Puffer) als `{type:"output"}`, bevor neuer Live-Output folgt — ein spät verbundener Client sieht den aktuellen Bildschirm, nicht ein leeres Terminal.

## Verträge
- `GET /api/session` → `200 {state, restarts, startedAt}`.
- `WS /ws/terminal` — Nachrichten: Client→Server `{type:"input", data:string}` · `{type:"resize", cols:int>0, rows:int>0}`; Server→Client `{type:"output", data:string}` + `{type:"state", state}`. **Bei Connect:** Replay des gepufferten Scrollbacks als `{type:"output"}` (AC6).

## Edge-Cases & Fehlerverhalten
- Noch nicht `ready` → eingehende Inputs werden gepuffert oder mit `{type:"state"}` quittiert (kein Absturz).
- Mehrere Clients: alle sehen denselben Output (shared session).
- `failed` → `/api/session` zeigt `failed`; ein Neustart ist nur über expliziten Restart-Pfad möglich.

## NFRs
- **Sicherheit:** keine Secrets (Tokens/Passphrase) im WS-Stream oder Log. (`security` Floor.)
- Output-Streaming latenzarm (Tasten-Echo ohne spürbare Verzögerung).

## Nicht-Ziele
- Mehr als eine parallele Session (siehe `flow-trigger` Concurrency-Lock = 1).

## Abhängigkeiten
- Cloudflare-Access-Gate aus [[access-and-guardrails]] schützt `/ws/terminal` + `/api/session`.

> *Out of scope für dieses Item:* die Bridge wird **ungated** ausgeliefert; serverseitige Authz (Cloudflare-Access-JWT-Validierung) + Prod-Fail-Fast liefert [[access-and-guardrails]] (#7), ein **Pflicht-Vorgänger von [[deployment]] (#13)**. Die Bridge ist nie öffentlich erreichbar, bevor #7 gelandet ist.
