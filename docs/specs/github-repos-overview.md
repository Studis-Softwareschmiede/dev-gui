---
id: github-repos-overview
title: GitHub-Repo-Übersicht (Org, read-only)
status: draft
area: fabrik-arbeiten
version: 1
---

# Spec: GitHub-Repo-Übersicht (`github-repos-overview`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Read-only (ADR-005: live aus GitHub-API, keine eigene Datenhaltung).

## Zweck
Die GitHub-Ansicht ([[view-github]]) erhält ihren ersten echten Inhalt: eine **Liste aller Repositories der Org**, live aus der GitHub-API über den bestehenden read-only `GitHubReader`-Boundary. Pro Repo werden die wichtigsten Verwaltungs-Eckdaten angezeigt (Name, Sichtbarkeit, offene Issues, letzter CI-Status, Link zu GitHub). Die Liste ist außerdem der **Andockpunkt** für die bereits spezifizierten Aktionen „Neues Repo" ([[github-repo-create]]) und „Klonen" pro Zeile ([[github-repo-clone]]) und kennzeichnet Repos, die lokal bereits im Workspace liegen ([[workspace-repos]]).

## Verhalten
1. Das Backend listet auf Anfrage **live** alle Org-Repos über den `GitHubReader`-Boundary (App-Token, read-only). Pro Repo werden mindestens gemeldet: `name`, `fullName`, `visibility` (`private|public`), `openIssues` (Anzahl offener Issues, PRs exkludiert; `'unknown'` wenn die Quelle nicht erreichbar war), `lastCi` (`success|failure|in_progress|none|unknown`) und `htmlUrl` (Link zu GitHub).
2. Anders als [[factory-status]] (das `agent-flow`/`dev-gui` ausschließt und ein Fabrik-Dashboard liefert) zeigt diese Übersicht **alle** Org-Repos zur Verwaltung — Ausschlüsse sind hier nicht erwünscht.
3. Die GitHub-Ansicht rendert die Liste (eine Zeile/Karte pro Repo) mit den o.g. Feldern; der GitHub-Link ist klickbar (öffnet `htmlUrl`).
4. Pro Zeile gibt es einen Andockpunkt „Klonen" ([[github-repo-clone]]); über der Liste einen Andockpunkt „Neues Repo" ([[github-repo-create]]). Diese Aktionen selbst sind in ihren eigenen Specs verifiziert — hier wird nur ihre Verortung/Sichtbarkeit gefordert.
5. **Verzahnung mit dem Workspace:** Ein Repo, das laut [[workspace-repos]] bereits lokal im Workspace liegt, wird mit einem Badge „lokal vorhanden" markiert; für dieses Repo entfällt der „Klonen"-Andockpunkt (bzw. ist deaktiviert). Die Zuordnung erfolgt über den Repo-Namen (Workspace-Klon-Ordnername ↔ Repo-Name).
6. Bei Nichterreichbarkeit der GitHub-Quelle degradiert die Ansicht graziös: einzelne Felder als „unbekannt", die Ansicht blockiert/abstürzt nicht (analog [[factory-status]] AC4).

## Acceptance-Kriterien
- **AC1** — Ein neuer read-only Backend-Endpunkt liefert **live** die Liste aller Org-Repos; pro Repo enthält die Response mindestens `{ name, fullName, visibility, openIssues, lastCi, htmlUrl }`. Kein Wert stammt aus einem persistierten Store (ADR-005).
- **AC2** — Die Repo-Liste wird **ausschließlich** über den bestehenden read-only `GitHubReader`-Boundary gelesen (kein neuer GitHub-Zugriff außerhalb dieses Boundary; weiterhin kein `POST/PATCH/PUT/DELETE` gegen die GitHub-API im Reader). Der GitHub-App-Token erscheint **nie** in Response, Log, Audit oder WS-Stream (security/R01).
- **AC3** — Die GitHub-Ansicht rendert pro Repo eine Zeile/Karte mit Name, Sichtbarkeit, offenen Issues, letztem CI-Status und einem **klickbaren** GitHub-Link (`htmlUrl`).
- **AC4** — Über der Liste ist der Andockpunkt „Neues Repo" ([[github-repo-create]]) sichtbar; pro Repo-Zeile ein Andockpunkt „Klonen" ([[github-repo-clone]]).
- **AC5** — Ein Repo, das laut [[workspace-repos]] bereits lokal im Workspace liegt, wird mit Badge „lokal vorhanden" markiert und der „Klonen"-Andockpunkt für dieses Repo entfällt/ist deaktiviert. Die Zuordnung erfolgt über den Repo-Namen.
- **AC6** — Ist die GitHub-Quelle nicht erreichbar, degradiert die Ansicht graziös (betroffene Felder „unbekannt", keine leere Whitescreen-/Crash-Situation); die Übersicht bleibt bedienbar.

## Verträge
- **GET `/api/github/repos`** (read-only, hinter AccessGuard) → **200** `{ repos: [{ name, fullName, visibility: "private"|"public", openIssues: number|"unknown", lastCi: "success"|"failure"|"in_progress"|"none"|"unknown", htmlUrl }] }`.
  - Quelle: `GitHubReader` (App-Token, read-only). Die genaue Methode/Signatur im Reader (z.B. Erweiterung um `listRepos()` mit Sichtbarkeit + `htmlUrl`) wählt `coder`; der Boundary-Vertrag „einziger read-only GitHub-Zugriff" bleibt gewahrt.
  - **5xx**/degradierte Felder bei Nichterreichbarkeit der Quelle (AC6) — kein Secret-Leak.
- **Frontend:** konsumiert `/api/github/repos`; für die Verzahnung zusätzlich `/api/workspace/repos` ([[workspace-repos]]), um die Badge „lokal vorhanden" zu setzen.
- Alle Endpunkte hinter AccessGuard (kein mutierender Pfad in dieser Spec).

## Edge-Cases & Fehlerverhalten
- GitHub-Rate-Limit/nicht erreichbar → betroffene Felder „unbekannt", restliche Daten geliefert (graceful degradation, AC6).
- Org ohne Repos / leere Liste → `{ repos: [] }`, Ansicht zeigt einen leeren-Zustand-Hinweis.
- Workspace-Endpunkt nicht erreichbar → Badge-Verzahnung entfällt still (Liste bleibt nutzbar), keine Blockade der Repo-Liste.
- Repo ohne Actions/CI → `lastCi: "none"`.

## NFRs
- **Sicherheit (Floor):** Response enthält keine Tokens/Secrets (security/R01); kein neuer GitHub-Zugriff außerhalb des read-only `GitHubReader`.
- **Performance:** Aggregation der Per-Repo-Daten parallelisiert; eine langsame Quelle blockiert die anderen nicht (analog [[factory-status]]).
- **A11y:** Liste als semantische Struktur (Überschrift + Listen-/Tabellen-Semantik); GitHub-Link und Aktions-Andockpunkte tastaturerreichbar und beschriftet.

## Nicht-Ziele
- Eigene Datenhaltung/Cache als Source of Truth (ADR-005).
- Repo-Anlegen/-Klonen selbst (eigene Specs [[github-repo-create]] / [[github-repo-clone]]) — hier nur die Verortung der Andockpunkte.
- Workspace-Scan + Pull/Löschen lokaler Klone (eigene Spec [[workspace-repos]]).
- Board-/PR-Verwaltung (weiterhin Folge-Anforderung; Achtung Kollision mit der `/flow`-Rolle als einzigem Schreiber von Board-Status/PRs — Abgrenzung beim `architekt`).

## Abhängigkeiten
- [[view-github]] (Ansicht, die diese Übersicht füllt).
- [[factory-status]] / `GitHubReader` (read-only Boundary, hier um Repo-Listing inkl. Sichtbarkeit + `htmlUrl` genutzt/erweitert).
- [[workspace-repos]] (Badge „lokal vorhanden" + Klonen-Andockpunkt-Verzahnung).
- [[github-repo-create]] · [[github-repo-clone]] (Aktions-Andockpunkte in der Liste).
- [[access-and-guardrails]] (Access-Mauer).
