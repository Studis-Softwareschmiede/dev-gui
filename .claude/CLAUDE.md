# dev-gui — GUI für die Softwareschmiede-Fabrik

Node-Vollstack: React-Frontend + Express/ws-Backend. Steuert die agent-flow-Fabrik über eine Web-GUI.

- **Engine:** fernsteuert eine INTERAKTIVE Claude-Code-Session (Abo-OAuth) per `node-pty` — KEIN Anthropic-API; der interaktive Flow-/Intake-Pfad bleibt **rein PTY** (kein `claude -p`, kein PTY-Lock-Bypass). **Bewusste Ausnahme:** der zustandslose „Let Claude proof"-Helfer (`POST /api/assist/refine`, eigene `AssistService`-Boundary, headless one-shot, kein PTY-Lock) nutzt `claude -p` — eng begrenzt, auditiert, ohne API-Key (docs/specs/fabric-intake-dialog.md AC11). Kein Anthropic-API bleibt unverändert ausgeschlossen.
- **Auth:** Cloudflare Access vor dem öffentlichen Endpunkt (`devgui.<domain>`).
- **State:** live aus GitHub-API + Docker, keine eigene DB.
- **Konventionen:** ESM, async/await; kein Secret in Code/Log.
- **Source of Truth:** `docs/concept.md` + `docs/architecture.md` (Schicht 1+2), `docs/specs/*.md` (Schicht 3).

## gh-Auth: GitHub-App-Token erneuern (bei `HTTP 401: Bad credentials`)

`gh` ist als GitHub App **`softwareschmiede-bot[bot]`** eingeloggt; Installation-Tokens sind nur **~1h gültig**. Bei 401 NICHT `gh auth login` interaktiv vorschlagen, sondern frischen Token über das agent-flow-Plugin minten:

```bash
"$(ls -dt ~/.claude/plugins/cache/agent-flow/agent-flow/*/ | head -1)scripts/ensure-gh-auth.sh"
```

Das Skript mintet den App-Token aus `.env.gpg`, loggt `gh` persistent ein (`~/.config/gh`) und konfiguriert git via `gh auth setup-git`. Idempotent — bei gültiger Auth passiert nichts. Gleicher Mechanismus läuft im Container über `docker-entrypoint.sh`.
