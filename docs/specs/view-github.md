---
id: view-github
title: GitHub-Ansicht (Grundgerüst)
status: draft
area: fabrik-arbeiten
version: 1
---

# Spec: GitHub-Ansicht (`view-github`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.

## Zweck
Eine eigenständige Ansicht zum **Verwalten von GitHub** der Org (Repos, Boards/Projects, Pull-Requests). **Dieses Paket liefert nur das Gerüst**: die über das Einstiegs-Panel erreichbare, deep-linkbare Platzhalter-Ansicht. Die eigentlichen Verwaltungs-Funktionen folgen als eigene Anforderungen — diese Spec hält den Rahmen und die Leitplanken fest, an die sich Folge-Items anhängen.

## Verhalten
1. Die GitHub-Ansicht ist über die Kachel *GitHub* und über die Route `github` erreichbar (siehe [[app-shell-navigation]]).
2. Im Grundgerüst zeigt die Ansicht einen klaren Titel („GitHub") und einen Platzhalter-Hinweis, dass die Verwaltungs-Funktionen folgen — **ohne** Backend-Aufruf. *(Die echten Inhalte — Org-Repo-Übersicht + Workspace-Übersicht — sind in [[github-repos-overview]] / [[workspace-repos]] spezifiziert und ersetzen den Platzhalter, sobald deren Frontend-Items umgesetzt sind.)*
3. Die bestehende Navigation/Home-Rückkehr funktioniert aus dieser Ansicht (geerbt aus [[app-shell-navigation]]).

## Acceptance-Kriterien
- **AC1** — Die GitHub-Ansicht ist über die *GitHub*-Kachel und per Deep-Link (Route `github`) erreichbar und zeigt einen erkennbaren Titel „GitHub".
- **AC2** — Das Grundgerüst rendert einen Platzhalter (Hinweis „folgt / in Arbeit") und löst **keinen** Backend-Aufruf und **keine** externe API-Anfrage aus. *(Hinweis: durch [[github-repo-create]] überholt — die Ansicht zeigt jetzt das Repo-Anlege-Formular statt eines Platzhalters; AC2 gilt damit nur noch für VPS/Cloudflare-Pendants, nicht mehr für die GitHub-Ansicht selbst.)*
- **AC3** — Aus der Ansicht ist die Rückkehr zum Einstiegs-Panel und der Wechsel zu jeder anderen Ansicht möglich.

## Verträge
- Konsumiert das Container-Gerüst aus [[app-shell-navigation]] (Route `github`, Navigation, Home).
- Keine neuen Backend-Endpunkte in **diesem** Paket. **Geplant (Folge-Anforderung):** Lese-Zugriff über den bestehenden `GitHubReader`-Boundary (App-Token, read-only) für Repos/Boards/PRs.
- **Lese-Capabilities (eigene Specs, spezifiziert):** Die echten Inhalte der Ansicht laufen über getrennte read-only Endpunkte:
  - [[github-repos-overview]] — Org-Repo-Übersicht (`GET /api/github/repos`, über den read-only `GitHubReader`).
  - [[workspace-repos]] — Übersicht lokaler Klone aus `WORKSPACE_DIR` (`GET /api/workspace/repos`).
- **Schreib-Capabilities (eigene Specs, spezifiziert):** Mutierende GitHub-/Workspace-Aktionen laufen **nicht** über den read-only `GitHubReader`, sondern über getrennte, auditierte + identitäts-/rollengeschützte Schreibpfade:
  - [[github-repo-create]] — neues Org-Repository anlegen (`POST /api/github/repos`, neuer `GitHubWriter`-Boundary).
  - [[github-repo-clone]] — bestehendes Repo lokal in den Workspace klonen (`POST /api/github/repos/clone`, `WORKSPACE_DIR`).
  - [[workspace-repos]] — lokalen Klon pullen/löschen (`POST /api/workspace/repos/pull` · `POST /api/workspace/repos/delete`), strikt innerhalb `WORKSPACE_DIR`, Pull mit transient gemintetem Token.

## Edge-Cases & Fehlerverhalten
- Aufruf ohne Access-Cookie → die bestehende Access-Mauer greift davor (kein view-eigenes Auth-Handling).

## NFRs
- **A11y:** Titel als Überschrift ausgezeichnet; Ansicht per Tastatur erreichbar.
- **Sicherheit (Floor, für Folge-Items vorgemerkt):** GitHub-Schreibaktionen sind ein neuer Schreibpfad — sie MÜSSEN auditiert (append-only) und identitäts-/rollengeschützt werden; keine GitHub-Tokens/Secrets ins Frontend-Bundle, in Logs oder den WS-Stream.

## Nicht-Ziele
- Eigene Datenhaltung (State bleibt live aus GitHub-API + Dateisystem gemäß ADR-005).
- Board-/PR-Verwaltung (weiterhin Folge-Anforderung, noch nicht verfeinert — **Achtung Kollision** mit der `/flow`-Rolle als einzigem Schreiber von Board-Status/PRs; Abgrenzung beim `architekt`). Repo-Anlegen/-Klonen + Repo-/Workspace-Übersichten + Pull/Löschen lokaler Klone sind in [[github-repo-create]] / [[github-repo-clone]] / [[github-repos-overview]] / [[workspace-repos]] spezifiziert.

## Abhängigkeiten
- [[app-shell-navigation]] (Container/Routing).
- [[access-and-guardrails]] (Access-Mauer; Audit-/Identitätspfad für Schreibaktionen).
- [[github-repos-overview]] · [[workspace-repos]] (Lese-Capabilities — die echten Inhalte der Ansicht).
- [[github-repo-create]] · [[github-repo-clone]] (Schreib-Capabilities, die in dieser Ansicht sitzen).
