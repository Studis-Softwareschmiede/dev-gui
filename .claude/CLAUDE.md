# dev-gui — GUI für die Softwareschmiede-Fabrik

Node-Vollstack: React-Frontend + Express/ws-Backend. Steuert die agent-flow-Fabrik über eine Web-GUI.

- **Engine:** fernsteuert eine INTERAKTIVE Claude-Code-Session (Abo-OAuth) per `node-pty` — KEIN Anthropic-API, KEIN `claude -p`.
- **Auth:** Cloudflare Access vor dem öffentlichen Endpunkt (`devgui.<domain>`).
- **State:** live aus GitHub-API + Docker, keine eigene DB.
- **Konventionen:** ESM, async/await; kein Secret in Code/Log.
- **Source of Truth:** `docs/concept.md` + `docs/architecture.md` (Schicht 1+2), `docs/specs/*.md` (Schicht 3).
