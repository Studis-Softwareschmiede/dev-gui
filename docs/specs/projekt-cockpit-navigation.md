---
id: projekt-cockpit-navigation
title: Projekt-Cockpit — projekt-zentrierte Fabrik-Navigation (Repo-Übersicht → Projekt → Aktion)
status: active
version: 1
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

## Acceptance-Kriterien

- **AC1** — „Fabrik" zeigt zuerst eine Repo-Übersicht der lokalen Klone (Name/Branch/dirty/letzter Commit), read-only. *(V1)*
- **AC2** — Repo-Auswahl setzt den aktiven Projekt-Kontext (State + `#/factory/<repo>`); Reload/Deep-Link erhält ihn; Rückweg zur Übersicht vorhanden. *(V2)*
- **AC3** — Projekt-Cockpit hat Reiter Arbeiten/Board/Spezifikation, die den Projekt-Kontext erben. *(V3)*
- **AC4** — PtyManager führt eine Session pro Projekt (cwd=Projekt-Pfad); Projektwechsel erhält andere Sessions; WsGateway routet zur aktiven Session; Session-Cap/Idle-Schließung als NFR. *(V4)*
- **AC5** — Flow-Trigger laufen im aktiven Projekt (cwd aus Cockpit, nicht inline). *(V5)*
- **AC6** — Board- + Spezifikation-Reiter zeigen nur das aktive Projekt (erben Kontext, kein eigener Selektor). *(V6)*
- **AC7** — GitHub/VPS/Cloudflare/Team/Deployments bleiben unveränderte globale Kacheln. *(V7)*

## Nicht-Ziele
- Klonen nicht-lokaler GitHub-Repos aus der Übersicht (bleibt GitHub-Kachel; mögliches Folge-Feature).
- Änderung des Auth-/Access-Modells.

## Abhängigkeiten
- Vorhandene Infrastruktur: `src/WorkspaceScanner.js`, `src/workspacePath.js`, `GET /api/workspace/repos`, `src/PtyManager.js`, `src/WsGateway.js`, `src/CommandService.js`, `client/src/AppShell.jsx`, `useHashRouter.js`, `FactoryView.jsx`.
- Integriert [[studis-kanban-board-ux]] (Board-Reiter) + [[projekt-spezifikation-anzeige]] (Spezifikation-Reiter) als Cockpit-Reiter.
