---
id: projekt-cockpit-navigation
title: Projekt-Cockpit — projekt-zentrierte Fabrik-Navigation (Repo-Übersicht → Projekt → Aktion)
status: active
version: 2
---

# Spec: Projekt-Cockpit  (`projekt-cockpit-navigation`)

> **Schicht 3 von 3.** status: draft — erst nach Owner-Review auf active.
>
> **Zweck.** Die Fabrik-Kachel wird vom flachen „alles global" zu einem **projekt-zentrierten Cockpit**: erst **Repo-Übersicht**, dann **ein Projekt wählen**, dann **Aktion** (Arbeiten · Board · Spezifikation). Vereinheitlicht die Projekt-Auswahl, die sonst in Board und Spezifikation getrennt aufträte.

## Lösungsvorschlag / Designentscheidungen (Owner-bestätigt 2026-06-15)

- **Fabrik = Projekt-Hub.** Klick auf „Fabrik" zeigt zuerst die **Repo-Übersicht** (nicht mehr direkt Terminal). *(Owner)*
- **Repo-Quelle = lokale Klone** (`WorkspaceScanner`, bereits vorhanden: name, branch, dirty, lastCommit). *(Owner)*
- **Aktiver-Projekt-Kontext** in URL + State (`#/factory/<repo>`), den die Reiter erben.
- **Terminal = eine Session PRO Projekt** (Multi-Session). PtyManager wird von Single-Session auf keyed-by-Projekt umgebaut; cwd = Projekt-Pfad. Projektwechsel verliert die andere Session nicht. *(Owner — der größte Umbau)*
- **Reiter im Cockpit:** Arbeiten (Terminal + Flow-Trigger) · Board (Studis-Kanban, dieses Projekt) · Spezifikation (Repo-Doku, dieses Projekt).

  > **⟶ Superseded für das Terminal-Pane (S-265, [[fabrik-arbeiten-layout]]):** Das dominante Terminal-Pane ist entfernt; Terminal nur noch per Checkbox (Default aus) am unteren Rand. Übrige Navigation/Reiter-Struktur unverändert gültig.
- **Global bleibt global:** GitHub · VPS · Cloudflare · Team · Deployments bleiben eigene Kacheln (org-weit, nicht projektgebunden).
- **Vereinheitlichung:** Board ([[studis-kanban-board-ux]]) + Spezifikation ([[projekt-spezifikation-anzeige]]) bekommen das Projekt aus dem Cockpit-Kontext, statt je eine eigene Projekt-Auswahl.

## Verhalten

### V1 — Repo-Übersicht (Fabrik-Einstieg)
Klick auf „Fabrik" zeigt die Liste der lokalen Klone (`WorkspaceScanner` / `GET /api/workspace/repos`): je Repo Name, Branch, dirty-Status, letzter Commit. Read-only.

### V2 — Aktiver-Projekt-Kontext
Auswahl eines Repos setzt den aktiven Projekt-Kontext (Frontend-State + Hash-Route `#/factory/<repo>`). Reload/Deep-Link stellt das Projekt wieder her. Ein Rückweg zur Übersicht ist immer erreichbar.

### V3 — Projekt-Cockpit mit Reitern
Im aktiven Projekt: Reiter „Arbeiten" · „Board" · „Spezifikation". Reiter erben den Projekt-Kontext; Wechsel ohne erneute Projekt-Auswahl.

### V4 — Terminal: eine Session pro Projekt
`PtyManager` verwaltet **mehrere** Sessions, je Projekt eine (keyed by Projekt-Pfad), jede mit `cwd = Projekt-Pfad`. `WsGateway` routet WebSocket-Verbindungen zur Session des aktiven Projekts. Projektwechsel lässt andere Sessions bestehen (Scrollback bleibt). Ressourcen-/Idle-Begrenzung (z.B. Session-Cap, Leerlauf-Schließung) als NFR.

### V5 — Flow-Trigger im Projekt
Die Flow-Trigger-Befehle laufen im **aktiven Projekt** (Repo-Kontext aus dem Cockpit, nicht mehr inline pro Befehl gewählt); CommandService schreibt in die Projekt-Session.

### V6 — Board + Spezifikation erben Kontext
Der Board-Reiter zeigt **nur das aktive Projekt** (kein eigener Projekt-Selektor mehr); der Spezifikation-Reiter ebenso. (Die globale Multi-Projekt-Board-Übersicht kann als separater Einstieg erhalten bleiben oder entfallen — Owner-Entscheidung später.)

### V7 — Global-Views unverändert
GitHub · VPS · Cloudflare · Team · Deployments bleiben eigenständige Kacheln ohne Projekt-Kontext.

### V8 — Projekt-Terminal Ende-zu-Ende funktionsfähig (Bugfix V4/V5)

> **Kontext (Bug, 2026-06-15, gegen Container `dev-gui-dev-gui-1` reproduziert):** Das Cockpit-Terminal zeigt „✕ getrennt", sobald ein Projekt aktiv ist; nur die globale Session ohne `?project=` funktioniert. Zwei unabhängige Defekte verhindern V4/V5 zusammen: (1) der WS-Upgrade-Handler verwirft jede projekt-behaftete URL **vor** dem Handshake, und (2) das Frontend liefert einen Projekt-**Slug** statt eines Pfades innerhalb der Schranke `WORKSPACE_DIR`, der die `validateProjectPath`-Boundary nie passieren kann.

**V8a — WS-Upgrade matcht auf den Pfad, nicht die volle URL.** Der HTTP-`upgrade`-Handler entscheidet die Annahme einer WS-Verbindung anhand des **Pfad-Teils** (`pathname`) der Request-URL, nicht des vollständigen `req.url` inklusive Query-String. Eine Verbindung zu `/ws/terminal` wird unabhängig von einem `?project=…`-Query an den Access-Guard / die WS-Bridge weitergereicht. Nur ein **anderer Pfad** führt zur Ablehnung; die Ablehnung erfolgt sauber (kein roher `socket.destroy()` für an sich gültige `/ws/terminal`-Pfade, sondern Annahme + ggf. anschließender geordneter Close-Code durch die nachgelagerte Validierung).

**V8b — Projekt-Referenz wird zentral zu einem Pfad innerhalb der Schranke aufgelöst.** Das Frontend trägt das Projekt weiterhin als **Slug** (Repo-Ordnername, wie in `#/factory/<repo>` und `GET /api/workspace/repos[].name`). Eine **einzige** server-seitige Auflösungs-Stelle übersetzt einen client-gelieferten Projekt-Slug zu einem absoluten Pfad `WORKSPACE_DIR + '/' + slug`, **bevor** `validateProjectPath` greift. Diese Auflösung gilt für **beide** Eintrittspfade: das WS-Terminal (`?project=<slug>` in `WsGateway`) **und** das Senden eines Befehls (`projectPath` im Body von `POST /api/command` über `commandRouter`/`CommandService`). Die bestehende Boundary bleibt unverändert in Kraft: der aufgelöste Pfad muss via realpath strikt innerhalb `WORKSPACE_DIR` liegen (Slug mit `/`, `..`, absolutem Pfad oder Symlink-Flucht → Ablehnung; security R02/R03). Der globale (projekt-lose) Fall bleibt erhalten: keine Projekt-Referenz → globale Session ohne projekt-`cwd`.

> *Entscheidung (a) statt (b):* zentrale Slug→Pfad-Auflösung an einer Server-Stelle (statt ein zusätzliches absolutes `repo_path`-Feld durch API + Frontend zu reichen). Begründung: der Client-Vertrag bleibt slug-basiert (Deep-Link `#/factory/<slug>` leakt die Container-Mount-Topologie nicht), die Auflösung sitzt direkt an der bestehenden Boundary, und WS- wie HTTP-Pfad teilen denselben Traversal-Guard.

## Acceptance-Kriterien

- **AC1** — „Fabrik" zeigt zuerst eine Repo-Übersicht der lokalen Klone (Name/Branch/dirty/letzter Commit), read-only. *(V1)*
- **AC2** — Repo-Auswahl setzt den aktiven Projekt-Kontext (State + `#/factory/<repo>`); Reload/Deep-Link erhält ihn; Rückweg zur Übersicht vorhanden. *(V2)*
- **AC3** — Projekt-Cockpit hat Reiter Arbeiten/Board/Spezifikation, die den Projekt-Kontext erben. *(V3)*
- **AC4** — PtyManager führt eine Session pro Projekt (cwd=Projekt-Pfad); Projektwechsel erhält andere Sessions; WsGateway routet zur aktiven Session; Session-Cap/Idle-Schließung als NFR. *(V4)*
- **AC5** — Flow-Trigger laufen im aktiven Projekt (cwd aus Cockpit, nicht inline). *(V5)*
- **AC6** — Board- + Spezifikation-Reiter zeigen nur das aktive Projekt (erben Kontext, kein eigener Selektor). *(V6)*
- **AC7** — GitHub/VPS/Cloudflare/Team/Deployments bleiben unveränderte globale Kacheln. *(V7)*
- **AC8** — Der WS-Upgrade-Handler entscheidet anhand des **Pfad-Teils** der Request-URL: eine Verbindung zu `/ws/terminal` **mit** `?project=…`-Query wird an den Access-Guard / die WS-Bridge weitergereicht (nicht vor dem Handshake verworfen); eine Verbindung zu einem anderen Pfad wird abgelehnt. *(V8a)* — **Testbar:** WS-Connect auf `/ws/terminal?project=<x>` führt **nicht** mehr zu „socket hang up" vor dem Handshake; WS-Connect auf `/ws/terminal` ohne Query bleibt wie bisher offen; ein fremder Pfad wird weiterhin abgewiesen.
- **AC9** — Eine client-gelieferte Projekt-**Slug**-Referenz wird **server-seitig zentral** zu `WORKSPACE_DIR + '/' + slug` aufgelöst, bevor `validateProjectPath` prüft — für **beide** Eintrittspfade: WS-Terminal (`?project=<slug>`) und `POST /api/command` (`projectPath`-Body). Ein gültiger Slug (z.B. `dev-gui`) ergibt eine PTY-Session mit `cwd = WORKSPACE_DIR/<slug>` (z.B. `/workspace/dev-gui`); kein `cwd` außerhalb der Schranke wird je gesetzt. *(V8b)* — **Testbar:** Mit gültigem Slug liefert das WS-Terminal eine offene Session im korrekten `cwd` (nicht `/app/<slug>`); der globale Fall (keine Projekt-Referenz) bleibt unverändert; `POST /api/command` mit demselben Slug landet in derselben Projekt-Session statt 4xx.
- **AC10** — Die Schranke bleibt nach der Auflösung wirksam (security R02/R03): eine Slug-/Pfad-Referenz, die nach Auflösung außerhalb `WORKSPACE_DIR` zeigt (`..`, absoluter Pfad, Symlink-Flucht, unbekannter Slug), wird **sauber abgelehnt** — WS per geordnetem Close-Code (z.B. 1008), `POST /api/command` per 4xx — **ohne** Prozess-Crash und ohne PTY-Spawn außerhalb der Schranke. *(V8b)* — **Testbar:** Reproduktion gegen den laufenden Container: `?project=<gültig>` bleibt offen mit korrektem `cwd`, ohne Param weiterhin globale Session, außerhalb-der-Schranke-Eingabe wird abgewiesen, der Server-Prozess läuft weiter.

## Nicht-Ziele
- Klonen nicht-lokaler GitHub-Repos aus der Übersicht (bleibt GitHub-Kachel; mögliches Folge-Feature).
- Änderung des Auth-/Access-Modells.

## Abhängigkeiten
- Vorhandene Infrastruktur: `src/WorkspaceScanner.js`, `src/workspacePath.js`, `GET /api/workspace/repos`, `src/PtyManager.js`, `src/WsGateway.js`, `src/CommandService.js`, `client/src/AppShell.jsx`, `useHashRouter.js`, `FactoryView.jsx`.
- Integriert [[studis-kanban-board-ux]] (Board-Reiter) + [[projekt-spezifikation-anzeige]] (Spezifikation-Reiter) als Cockpit-Reiter.
