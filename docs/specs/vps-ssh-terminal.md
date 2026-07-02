---
id: vps-ssh-terminal
title: SSH-Terminal je VPS/User (root/alex) im VPS-Panel — direkt auf dem Server arbeiten
status: active
version: 1
spec_format: use-case-2.0
---

# Spec: SSH-Terminal je VPS/User (`vps-ssh-terminal`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).
> **Security-kritisch:** interaktive SSH-Sitzung vom Backend auf einen VPS (neue Trust-Boundary); SSH-Private-Key bleibt store-intern (ADR-007/ADR-008), interaktive Vollzugriff-Shell als root/alex.

## Zweck
Jede VPS-Karte in der VPS-Ansicht ([[view-vps]]) bekommt zwei **klein übereinander** angeordnete Buttons **„root"** und **„alex"**. Ein Klick öffnet **unterhalb der Karte** ein Terminal-Fenster, das **automatisch** per SSH mit dem jeweiligen User (`root` bzw. `alex`) und dem beim VPS-Bootstrap hinterlegten SSH-Key auf den VPS verbindet — so kann der Betreiber direkt auf dem Server arbeiten, ohne ein externes SSH-Tool.

> **Wiederverwendung statt Neubau:** Die xterm.js-Frontend-Konsole (`client/src/Terminal.jsx`) + der WS-PTY-Bridge-Mechanismus (`node-pty` + WS-Streaming, Muster [[terminal-bridge]]/[[terminal-frontend]]) werden **wiederverwendet**. **Neu** ist ausschließlich, dass der PTY nun **`ssh`** statt `claude` fährt und **mehrere** unabhängige Sitzungen (je VPS/User) parallel laufen — der bestehende einzelne interaktive Claude-Session-PTY (`PtyManager`, [[terminal-bridge]]) bleibt **unberührt** (getrennte Boundary, kein globaler PTY-Lock).

> **Boundary-Frage (architekt):** Nach ADR-008 ist `VpsProvisioner` der **einzige** Ort für SSH-Verbindungen (heute nicht-interaktive Kommandos: `addAuthorizedKey`/`removeAuthorizedKey`/`testConnection`). Ob die **interaktive PTY-SSH-Sitzung** eine neue Methode dieses Boundary oder ein **Geschwister-Boundary** wird (z.B. `SshPtyManager`/`VpsSshTerminal`, der dieselbe Key-Handling-Linie teilt), entscheidet der `architekt` samt neuem ADR (nächste freie Nummer). **Bindend unabhängig davon:** der SSH-Private-Key bleibt store-intern + transient und leakt nie (AC8), und es gibt **eine** SSH-Verbindungs-Linie (kein zweiter, ungeschützter SSH-Pfad).

## Verhalten

### UI (VpsView)
1. Jede VPS-Karte (`client/src/VpsView.jsx`) trägt — zusätzlich zu den bestehenden Aktionen (Start/Stop/Löschen/Container) — zwei **klein übereinander** angeordnete Buttons **„root"** und **„alex"**.
2. Ein Klick auf „root" bzw. „alex" öffnet **unterhalb dieser Karte** ein Terminal-Fenster und **verbindet automatisch** per SSH als der gewählte User; ein zweiter Klick (oder ein „Schließen"-Knopf) beendet die Sitzung und schließt das Fenster.
3. Das Terminal-Fenster zeigt den **Verbindungs-Status** (verbindet … / verbunden / getrennt) als **Label + Icon** (nie nur über Farbe) und reicht Tastatureingaben durch (read-write, wie [[terminal-frontend]]).
4. Mehrere VPS-Karten dürfen **gleichzeitig** je ein eigenes SSH-Terminal offen haben (unabhängige Sitzungen); das Öffnen eines SSH-Terminals berührt den freien Claude-Terminal-Pane **nicht**.
5. Bricht die Verbindung ab (SSH-Ende, Netzfehler), zeigt das Fenster den Getrennt-Status; ein erneuter Klick auf „root"/„alex" baut eine frische Sitzung auf. Ein Fehler eines VPS-Terminals **degradiert** nur dieses Fenster, nicht die übrige VPS-Liste.

### Backend (SSH-PTY-Bridge)
6. Der Client öffnet eine WebSocket-Verbindung und sendet ein **Open-Handshake** mit `{ provider, serverId, user }`, wobei `user` **ausschließlich** `"root"` oder `"alex"` sein darf. Das Backend löst daraus **serverseitig** das SSH-Ziel `{ host, port }` über die bestehende Auflösung ([[vps-dynamic-ssh-targets]] `resolveVpsTarget`, host ggf. via `getMachineIp` aufgefrischt) auf; **der Client übergibt kein** host/port, **kein** Key-Material und **keinen** freien User.
7. Das Backend startet einen **PTY** mit `ssh` als dem gewählten User zum aufgelösten Host, authentifiziert mit dem **store-internen** SSH-Private-Key des jeweiligen Users (`CredentialStore` `ssh/<user>/private_key`, ADR-007/ADR-008), und streamt Ein-/Ausgabe **byteweise (ANSI erhalten)** über den WS (Muster [[terminal-bridge]] AC2). Terminalgröße wird über `{type:"resize",cols,rows}` an den PTY durchgereicht (Muster [[terminal-bridge]] AC5).
8. Jede WS-Verbindung entspricht **genau einer** SSH-Sitzung (kein geteilter Broadcast wie beim Claude-Terminal); mehrere Sitzungen laufen parallel bis zu einer **Obergrenze** (Ressourcen-Cap). Wird die WS-Verbindung geschlossen oder läuft ein **Idle-Timeout** ab, beendet das Backend den `ssh`-PTY und **räumt jegliches transientes Key-Material auf**.
9. Fehler (Ziel nicht auflösbar, kein Key hinterlegt, VPS unerreichbar, SSH-Auth fehlgeschlagen, Host-Key-Konflikt) werden dem Client als **geheimnisfreie, klassifizierte** Statusmeldung gemeldet (`no-target | no-private-key | unreachable | auth-failed | host-key-mismatch | error`) — **ohne** Key/Token/Host-Secret; kein Crash der Bridge, keine offene halbe Sitzung.

## Acceptance-Kriterien

### UI (Frontend)
- **AC1** — Jede VPS-Karte in `VpsView.jsx` zeigt zwei **klein übereinander** angeordnete, beschriftete Buttons **„root"** und **„alex"** (aria-label je Rolle). (Testbar: beide Buttons je Karte vorhanden + beschriftet.)
- **AC2** — Ein Klick auf „root" bzw. „alex" öffnet **unterhalb genau dieser Karte** ein Terminal-Fenster (wiederverwendetes `Terminal.jsx` mit überschriebener WS-URL) und startet den Verbindungsaufbau als der gewählte User; das Terminal reicht Tastatureingaben durch. (Testbar: Klick rendert das Terminal unter der Karte + öffnet den WS mit korrektem `{provider,serverId,user}`-Handshake; Eingabe geht über WS raus.)
- **AC3** — Das Terminal-Fenster zeigt den Verbindungs-Status als **Label + Icon** (nie nur Farbe), bietet einen **„Schließen"**-Knopf, der die Sitzung beendet, und erlaubt **mehrere** gleichzeitig offene VPS-Terminals (je Karte eigenständig). (Testbar: Status-Label sichtbar; Schließen beendet den WS; zwei Karten → zwei unabhängige WS.)
- **AC4** — Ein Fehler/Abbruch eines VPS-Terminals (unreachable/no-private-key/auth-failed/host-key-mismatch) zeigt **in genau diesem Fenster** eine klare geheimnisfreie Meldung, ohne die übrige VPS-Liste zu zerstören; `403` → „keine Berechtigung"-Meldung ohne UI-Crash. (Testbar: Fehler-Status im betroffenen Fenster; übrige Karten bleiben; 403 → Berechtigungs-Meldung.)

### Backend (SSH-PTY-Bridge)
- **AC5** — Der WS-SSH-Endpunkt nimmt ein **Open-Handshake** `{ provider, serverId, user }` (`user ∈ {root, alex}`) entgegen, löst das SSH-Ziel serverseitig via `resolveVpsTarget` auf (host ggf. via `getMachineIp` aufgefrischt), startet einen `ssh`-PTY als diesem User und streamt Ein-/Ausgabe byteweise (ANSI erhalten) bidirektional; `{type:"resize",cols,rows}` (positive Integer) ruft `pty.resize`. (Testbar mit gemocktem `node-pty`/Registry/Store: Handshake → aufgelöstes Ziel → `ssh`-Spawn als User → Output-Stream; resize → `pty.resize`.)
- **AC6** — `user` ist serverseitig **strikt** auf `{root, alex}` begrenzt; der Client liefert **kein** host/port, **kein** Key-Material und **keinen** freien User/Command. Ein unbekannter/leerer `user` oder ein nicht auflösbares Ziel → geheimnisfreier Fehler (`no-target`/`error`), **kein** Spawn (kein Command-/User-Injection-Vektor). (Testbar: `user:"bob"` → abgelehnt, kein Spawn; unbekannte serverId → `no-target`, kein Spawn.)
- **AC7** — Sitzungs-Lebenszyklus: jede WS = genau eine SSH-Sitzung; WS-Close **oder** Idle-Timeout beendet den `ssh`-PTY und räumt transientes Key-Material auf; eine **Obergrenze** paralleler Sitzungen wird durchgesetzt (darüber → geheimnisfreie Ablehnung, kein Ressourcen-Leck). (Testbar: WS-Close → PTY-kill + Key-Cleanup; Cap überschritten → Ablehnung.)

### Sicherheit & Audit (Floor, hart)
- **AC8** — Der SSH-Private-Key bleibt **store-intern** (`CredentialStore` `ssh/<user>/private_key`), wird **transient pro Sitzung** geladen und leakt **niemals** in Argv, Log, Audit, WS-Stream, HTTP-Response, URL oder Frontend-Bundle; wird der Key für `ssh` als transiente Datei benötigt, ist sie mode `0600` und wird bei Sitzungsende **entfernt**. (Testbar: `ssh`-Argv enthält keinen Key-Inhalt; Grep auf Log/Audit/WS/Response secret-frei; transiente Key-Datei nach Sitzungsende weg.)
- **AC9** — Der WS-SSH-Endpunkt liegt hinter der **AccessGuard**-Mauer (403 ohne gültigen Access); das **Öffnen** einer SSH-Sitzung ist eine privilegierte Aktion → zusätzlich **identitäts-/rollengeschützt** (`CRED_ADMIN_EMAILS`-Logik wie ADR-007; 403 ohne Berechtigung) und **audit-first** (Audit-Eintrag VOR dem Spawn mit Identität, provider, serverId, user, Zeit; schlägt der Audit-Write fehl → keine Sitzung). Der Audit-Eintrag enthält **kein** Key-/Host-Secret. (Testbar: ohne Access 403; ohne Rolle 403; Audit-Eintrag vor Spawn vorhanden + secret-frei.)
- **AC10** — Host-Key-Umgang ist **dokumentiert** und deaktiviert die Host-Verifikation **nicht** global in einer MITM-verschleiernden Weise (kein pauschales `StrictHostKeyChecking=no` ohne persistiertes/gepinntes known-hosts); die gewählte Policy (z.B. `accept-new` mit persistiertem `known_hosts`, oder ein beim Create gepinnter Host-Key) ist im Code/Doku benannt. Ein Host-Key-Konflikt → `host-key-mismatch`, **kein** stiller Weiterverbindungs-Bypass. (Testbar: gewählte Policy im Aufruf sichtbar; Konflikt → `host-key-mismatch`, kein Auto-Accept eines geänderten Keys.)

## Verträge
> Pfade/Nachrichtenform kanonisch; Boundary-Detail (VpsProvisioner-Methode vs. Geschwister-Boundary, exaktes Key-Injektions-Verfahren, Host-Key-Persistenz) = `architekt`/`coder`. ServerId-Routing per literaler serverId (IONOS composite mit Slash, analog `*splat`/[[vps-dynamic-ssh-targets]]).

- **WS `/ws/vps-terminal`** (Pfad kanonisch; `architekt` darf Query- statt Message-Handshake wählen) — Nachrichten:
  - Client→Server: `{ type:"open", provider:string, serverId:string, user:"root"|"alex" }` (einmalig, erste Nachricht) · `{ type:"input", data:string }` · `{ type:"resize", cols:int>0, rows:int>0 }`.
  - Server→Client: `{ type:"output", data:string }` · `{ type:"state", state:"connecting"|"connected"|"disconnected" }` · `{ type:"error", errorClass, reason }` (geheimnisfrei).
- **Ziel-Auflösung:** `resolveVpsTarget(provider, serverId, …)` → `{ host, port }` ([[vps-dynamic-ssh-targets]] AC4; host via `getMachineIp` auffrischbar). `null` → `no-target`, kein Spawn.
- **Key-Quelle (store-intern):** `CredentialStore` `ssh/<user>/private_key`, transient pro Sitzung, nie geleakt (ADR-007/ADR-008). Fehlt der Key → `no-private-key`, kein Spawn.
- **SSH-PTY-Boundary (neu oder VpsProvisioner-Erweiterung, architekt):** startet/hält/beendet je Sitzung genau einen `ssh`-PTY (`node-pty`), Container-/User-/Ziel-validiert, geheimnisfreie Fehlerklassen (`no-target | no-private-key | unreachable | auth-failed | host-key-mismatch | error`), erzwingt den parallel-Sitzungs-Cap + Idle-Timeout + Cleanup. **Einzige** interaktive SSH-Verbindungs-Stelle.
- **Fehlerklassen:** `no-target | no-private-key | unreachable | auth-failed | host-key-mismatch | error` — alle geheimnisfrei.
- Alle Endpunkte hinter AccessGuard; Sitzungs-Öffnen zusätzlich `CRED_ADMIN_EMAILS`-rollengeprüft + audit-first (Muster [[vps-container-overview]] AC12, [[vps-provider-boundary]]).

## Edge-Cases & Fehlerverhalten
- Kein Access-Cookie → Access-Mauer greift davor (403), gar kein WS-Upgrade.
- Kein SSH-Private-Key für den gewählten User hinterlegt → `no-private-key`, klare Meldung, kein Spawn.
- VPS unerreichbar / Provisionierung noch nicht fertig → `unreachable`, Fenster degradiert, übrige Karten bleiben.
- SSH-Auth fehlgeschlagen (Key nicht in `authorized_keys`) → `auth-failed`, geheimnisfrei; kein Retry-Sturm.
- Host-Key geändert/unbekannt → `host-key-mismatch` gemäß AC10 (kein stiller Bypass).
- `user` ≠ `root`/`alex` (manipulierter Client) → abgelehnt, kein Spawn (AC6).
- Ziel nur dynamisch angelegt (leere `VPS_TARGETS`) → aufgelöst über die dynamische Quelle ([[vps-dynamic-ssh-targets]]).
- WS bricht ab / Browser-Tab zu → Backend killt den `ssh`-PTY + Cleanup (kein verwaister Prozess/Key).
- Parallel-Sitzungs-Cap erreicht → geheimnisfreie Ablehnung der neuen Sitzung, bestehende laufen weiter.

## NFRs
- **Sicherheit (Floor, hart):** SSH-Private-Key store-intern + transient, nie in Argv/Log/Audit/WS/Response/URL/Bundle (AC8); genau **eine** SSH-Verbindungs-Linie (kein zweiter ungeschützter Pfad); Sitzungs-Öffnen audit-first + `CRED_ADMIN_EMAILS`-geschützt (AC9); Host-Key-Policy ohne MITM-Blind-Bypass (AC10); `user` server-seitig auf `{root,alex}` begrenzt (kein Injection).
- **Isolation:** die SSH-PTY-Bridge ist **getrennt** vom Claude-`PtyManager` (kein globaler PTY-Lock, kein Import/Mutation des interaktiven Claude-Schreibpfads — Trust-Boundary); mehrere SSH-Sitzungen parallel bis Cap.
- **Robustheit:** ein VPS-Terminal-Fehler degradiert nur dieses Fenster; Cleanup garantiert (kein Prozess-/Key-Leck).
- **A11y (WCAG 2.1 AA):** root/alex-Buttons + Schließen beschriftet (aria-label); Verbindungs-Status als Label+Icon (nie nur Farbe); Terminal fokussierbar + per Tastatur verlassbar (keine Fokus-Falle); Touch-Targets ≥ 44 px; sichtbarer Fokus; Fehlermeldung als role=alert.

## Nicht-Ziele
- **Neuer Claude-Session-Pfad** — der einzelne interaktive Claude-`PtyManager` ([[terminal-bridge]]) bleibt unverändert; diese Spec fügt nur die SSH-PTYs hinzu.
- **Beliebiger SSH-User/Host aus dem Client** — nur `root`/`alex` + serverseitig aufgelöstes Ziel (fixierte Default-Rollen wie [[vps-ssh-key-assignment]]).
- **Datei-Upload/Download, SFTP, Port-Forwarding, Multi-Tab je VPS** — nur die interaktive Shell.
- **Key-Erzeugung/-Rotation** → [[ssh-key-generation]]/[[ssh-key-rotation]]; hier nur Nutzung des hinterlegten Keys.
- **Scrollback-Replay über mehrere Clients** (der Claude-Terminal-Broadcast/Ring-Puffer aus [[terminal-bridge]] AC6 gilt hier nicht — je WS eine eigene Sitzung).
- **Persistente Sitzungen über Server-Neustart** (Sitzungen sind flüchtig; Neustart beendet sie).

## Abhängigkeiten
- [[view-vps]] (VPS-Karten + Zeilen-Gerüst, in das die root/alex-Buttons + das Terminal-Fenster integriert werden).
- [[vps-dynamic-ssh-targets]] (`resolveVpsTarget`/`getMachineIp` — SSH-Ziel-Auflösung; `VpsTarget`-Schema).
- [[vps-ssh-key-assignment]] / [[settings-ssh-keys]] (Herkunft der root-/alex-Keys beim Bootstrap; Private-Key store-intern, ADR-007/ADR-008).
- [[terminal-frontend]] (`Terminal.jsx`/xterm.js-Konsole — wiederverwendet mit überschriebener WS-URL) · [[terminal-bridge]] (WS-PTY-Bridge-Muster: Streaming, resize, Fehlertoleranz — als Vorlage, **nicht** der geteilte Claude-Single-Session-PTY).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität; Rollen-/Audit-Floor für das Sitzungs-Öffnen).
- `docs/architecture.md` — **ADR-008** (SSH-Linie/`VpsProvisioner`, Boundary-Frage für die interaktive PTY-SSH-Sitzung), **ADR-007** (`CredentialStore`, Key store-intern), **ADR-009** (`resolveVpsTarget`/Provider-Boundary). Neuer ADR (nächste freie Nummer) durch `architekt` für die interaktive SSH-PTY-Boundary.
