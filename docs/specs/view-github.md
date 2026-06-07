---
id: view-github
title: GitHub-Ansicht (Grundgerüst)
status: draft
version: 1
---

# Spec: GitHub-Ansicht (`view-github`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.

## Zweck
Eine eigenständige Ansicht zum **Verwalten von GitHub** der Org (Repos, Boards/Projects, Pull-Requests). **Dieses Paket liefert nur das Gerüst**: die über das Einstiegs-Panel erreichbare, deep-linkbare Platzhalter-Ansicht. Die eigentlichen Verwaltungs-Funktionen folgen als eigene Anforderungen — diese Spec hält den Rahmen und die Leitplanken fest, an die sich Folge-Items anhängen.

## Verhalten
1. Die GitHub-Ansicht ist über die Kachel *GitHub* und über die Route `github` erreichbar (siehe [[app-shell-navigation]]).
2. Im Grundgerüst zeigt die Ansicht einen klaren Titel („GitHub") und einen Platzhalter-Hinweis, dass die Verwaltungs-Funktionen folgen — **ohne** Backend-Aufruf.
3. Die bestehende Navigation/Home-Rückkehr funktioniert aus dieser Ansicht (geerbt aus [[app-shell-navigation]]).

## Acceptance-Kriterien
- **AC1** — Die GitHub-Ansicht ist über die *GitHub*-Kachel und per Deep-Link (Route `github`) erreichbar und zeigt einen erkennbaren Titel „GitHub".
- **AC2** — Das Grundgerüst rendert einen Platzhalter (Hinweis „folgt / in Arbeit") und löst **keinen** Backend-Aufruf und **keine** externe API-Anfrage aus.
- **AC3** — Aus der Ansicht ist die Rückkehr zum Einstiegs-Panel und der Wechsel zu jeder anderen Ansicht möglich.

## Verträge
- Konsumiert das Container-Gerüst aus [[app-shell-navigation]] (Route `github`, Navigation, Home).
- Keine neuen Backend-Endpunkte in diesem Paket. **Geplant (Folge-Anforderung):** Lese-Zugriff über den bestehenden `GitHubReader`-Boundary (App-Token, read-only) für Repos/Boards/PRs; mutierende Aktionen (Repo/Board/PR ändern) sind ein neuer Schreibpfad, der gesondert spezifiziert und autorisiert wird.

## Edge-Cases & Fehlerverhalten
- Aufruf ohne Access-Cookie → die bestehende Access-Mauer greift davor (kein view-eigenes Auth-Handling).

## NFRs
- **A11y:** Titel als Überschrift ausgezeichnet; Ansicht per Tastatur erreichbar.
- **Sicherheit (Floor, für Folge-Items vorgemerkt):** GitHub-Schreibaktionen sind ein neuer Schreibpfad — sie MÜSSEN auditiert (append-only) und identitäts-/rollengeschützt werden; keine GitHub-Tokens/Secrets ins Frontend-Bundle, in Logs oder den WS-Stream.

## Nicht-Ziele
- Tatsächliche Repo-/Board-/PR-Verwaltung (Folge-Anforderung).
- Eigene Datenhaltung (State bleibt live aus GitHub-API gemäß ADR-005).

## Abhängigkeiten
- [[app-shell-navigation]] (Container/Routing).
- [[access-and-guardrails]] (Access-Mauer; künftiger Audit-/Lock-Pfad für Schreibaktionen).
