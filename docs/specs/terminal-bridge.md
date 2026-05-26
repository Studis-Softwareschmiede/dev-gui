---
id: terminal-bridge
title: Terminal-Bridge (PTY ↔ interaktive Claude-Session)
status: draft
version: 1
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

## Acceptance-Kriterien
- **AC1** — `GET /api/session` liefert den aktuellen Session-Zustand (`starting|ready|busy|stopped|failed`). Nach dem Boot erreicht er ohne Eingabe `ready`.
- **AC2** — WebSocket `/ws/terminal`: eine vom Client gesendete Eingabe wird in den PTY geschrieben; PTY-Ausgabe wird an alle verbundenen Clients gestreamt (ANSI-Sequenzen bleiben erhalten).
- **AC3** — Die Session läuft **ohne** `-p`/`--print` und **ohne** gesetzten `ANTHROPIC_API_KEY` (Auth = Abo-OAuth). Testbar: die gestartete Befehlszeile enthält kein `-p`/`--print`; die Prozess-Umgebung enthält keinen `ANTHROPIC_API_KEY`.
- **AC4** — Beendet sich die Session unerwartet, wird sie automatisch neu gestartet; nach Überschreiten von *N* Restarts in *M* s bleibt der Zustand `failed` (kein Endlos-Restart).

## Verträge
- `GET /api/session` → `200 {state, restarts, startedAt}`.
- `WS /ws/terminal` — Nachrichten: Client→Server `{type:"input", data:string}`; Server→Client `{type:"output", data:string}` + `{type:"state", state}`.

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
