# Glossar — dev-gui (Ubiquitous Language)

> Begriffe einheitlich und sprach-neutral definiert — stützt die Portabilität der Specs (gleicher Begriff in Konzept, Spec und Code).

| Begriff | Bedeutung |
|---|---|
| **Fabrik** | Die agent-flow-Pipeline (coder→reviewer→tester + requirement/retro/train). dev-gui ist ihre GUI, nicht Teil der Fabrik selbst. |
| **Session** | Die eine interaktive Claude-Code-Instanz, die dev-gui im PTY fernsteuert (Abo-OAuth, kein API). |
| **PTY** | Pseudo-Terminal (`node-pty`), über das das Backend mit der `claude`-CLI spricht wie ein Mensch im Terminal. |
| **Command** | Ein über die GUI ausgelöster Slash-Befehl (z.B. `/flow #12`) + sein Status. |
| **Flow** | Ein Fabrik-Lauf (typisch `/flow <item>`: coder→reviewer→tester über ein Board-Item). |
| **Trigger** | Die GUI-Aktion, die einen Command in die Session injiziert. |
| **Read-Model** | Live aus GitHub/Docker gelesene Statusdaten (Project, BoardItem, CIRun, PreviewContainer) — nie persistiert. |
| **Access** | Cloudflare Access — das Identitäts-Gate vor `devgui.<domain>`. |
| **Pre-granted** | Tool-Permissions der Session sind vorab erteilt; Flows laufen ohne Genehmigung pro Schritt. |
| **Kill-Switch** | Abbruch eines laufenden Commands (Interrupt an die Session). |
| **Audit-Log** | Append-only Protokoll jedes ausgelösten Commands (Zeit, Identität, Befehl). |
