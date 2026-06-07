---
id: github-repo-create
title: GitHub-Repository anlegen (Schreibpfad, GitHubWriter)
status: draft
version: 1
---

# Spec: GitHub-Repository anlegen (`github-repo-create`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch (erster mutierender GitHub-Schreibpfad).

## Zweck
Über die GitHub-Ansicht ([[view-github]]) lässt sich ein **neues GitHub-Repository in der Org anlegen**. Dies ist der **erste mutierende GitHub-Schreibpfad** der dev-gui — bislang ist GitHub-Zugriff read-only (`GitHubReader`). Das Anlegen läuft über einen **neuen, getrennten Schreib-Boundary** (`GitHubWriter`, **nicht** im read-only `GitHubReader`), ruft die GitHub-REST-API mit dem App-Installation-Token auf und liefert strukturiertes Feedback (Repo-URL). Die Aktion ist **auditiert** und **identitäts-/rollengeschützt** (gleiche `CRED_ADMIN_EMAILS`-Linie wie ADR-007).

## Verhalten
1. In der GitHub-Ansicht kann der Nutzer ein neues Repo anlegen: er gibt **Name** (Pflicht), **Sichtbarkeit** (privat/öffentlich, Default privat), optional **Beschreibung** und optional „mit README initialisieren" an und löst das Anlegen aus.
2. Das Backend validiert die Eingaben (Name nicht leer, GitHub-konformes Namensformat, Längenlimit), mintet **unmittelbar vor dem Aufruf** einen frischen Installation-Token aus dem `CredentialStore`-Schema `github` (App-ID/Installation-ID/Private-Key) und ruft `POST /orgs/{org}/repos` der GitHub-REST-API auf.
3. Bei Erfolg liefert das Backend **strukturiertes Feedback** zurück: mindestens `{ name, fullName, htmlUrl, visibility }`. Das Frontend zeigt die Repo-URL klickbar an.
4. Schlägt das Anlegen fehl (Name bereits vergeben, fehlende App-Permission, GitHub-Fehler), wird ein klarer Fehler mit passendem Statuscode gemeldet — **ohne** Token-/Secret-Leak.
5. Jede Anlege-Aktion (Erfolg wie Fehlschlag) wird **auditiert** (Identität, Aktion, Repo-Name, Ergebnis, Zeit) — **ohne** Token im Audit-Eintrag.
6. Die Aktion ist **mutierend, höher-privilegiert** als reine Lese-Views: sie ist nur einer berechtigten Access-Identität erlaubt (Access-Mauer + Identitätsauswertung + optionale `CRED_ADMIN_EMAILS`-Allowlist).

## Acceptance-Kriterien
- **AC1** — Über einen neuen Backend-Endpunkt lässt sich ein Repository in der Org anlegen; bei Erfolg liefert die Response strukturiertes Feedback mit mindestens `{ name, fullName, htmlUrl, visibility }`, und das Frontend zeigt die Repo-URL klickbar an.
- **AC2** — Der Schreibpfad liegt in einem **neuen, eigenen Boundary** (`GitHubWriter`, `src/GitHubWriter.js`) — der read-only `GitHubReader` enthält **keinen** mutierenden GitHub-Aufruf (testbar: kein `POST/PATCH/PUT/DELETE` gegen die GitHub-API im `GitHubReader`).
- **AC3** — Der Installation-Token wird **unmittelbar vor** dem GitHub-Aufruf frisch gemintet (App-ID/Installation-ID/Private-Key aus dem `CredentialStore`-Schema `github`) und erscheint **nie** in einer HTTP-Response, einem Log, dem Audit-Eintrag, dem WS-Stream oder einer URL/Argv. (Testbar: Response-Body/Audit enthalten den Token nicht.)
- **AC4** — Jede Anlege-Aktion (Erfolg **und** Fehlschlag) erzeugt einen Audit-Eintrag (Identität, Aktion, Repo-Name, Ergebnis, Zeit) **ohne** Token/Secret; schlägt der Audit-Write fehl, unterbleibt die Mutation (Audit-First, vgl. [[access-and-guardrails]]).
- **AC5** — Der Anlege-Endpunkt ist hinter der Access-Mauer; eine Anfrage ohne gültigen Access-Nachweis → `403`; ist `CRED_ADMIN_EMAILS` gesetzt, sind nur diese Identitäten berechtigt (sonst `403`) — identische Logik zu ADR-007.
- **AC6** — Ungültige/leere Eingaben (Name leer, ungültiges Namensformat, Längenüberschreitung) werden mit klarer Fehlermeldung (4xx) abgelehnt, **ohne** GitHub-Aufruf.
- **AC7** — Fehlerpfade liefern den passenden Statuscode ohne Secret-Leak: Repo-Name bereits vorhanden → `409`/`422`; fehlende App-Permission (GitHub `403`) → klarer `403`/`502` mit Hinweis auf die nötige Permission; sonstiger GitHub-/Netzfehler → `502`.

## Verträge
> Pfade/Felder kanonisch; Token-Minting + GitHub-API-Aufruf sind in `GitHubWriter` gekapselt (Boundary).

- **POST `/api/github/repos`** — Body `{ name: string, visibility?: "private"|"public" (Default "private"), description?: string, autoInit?: boolean }`.
  - **201** `{ name, fullName, htmlUrl, visibility }` bei Erfolg.
  - **4xx** bei Validierungsfehler (AC6) / Namenskonflikt (AC7).
  - **502** bei GitHub-/Netzfehler bzw. fehlender App-Permission (AC7).
  - **403** ohne Access bzw. ohne Berechtigung (AC5).
- **GitHub-Aufruf (Boundary-intern):** `POST https://api.github.com/orgs/{org}/repos` mit `Authorization: Bearer <installation-token>`; `org` aus Konfiguration/Profil. Token store-intern, nie nach außen.
- Alle Endpunkte hinter AccessGuard; mutierende zusätzlich identitäts-/rollengeprüft; jede Mutation schreibt einen AuditEntry (vgl. [[access-and-guardrails]]).

## Edge-Cases & Fehlerverhalten
- Repo-Name in der Org bereits vergeben → kein Doppel-Anlegen; klarer `409`/`422`, auditiert als Fehlschlag.
- GitHub-App hat **keine** `Administration: Read & Write`-Permission → GitHub antwortet `403`; das Backend meldet `403`/`502` mit klarem Hinweis auf die nötige Permission, **ohne** Token-Leak (siehe Betriebs-Vorbedingung).
- `CredentialStore`-Schema `github` unvollständig/nicht gesetzt (kein App-ID/Installation-ID/Private-Key) → `500`/`502` mit klarer Meldung, **ohne** Klartext-Leak; kein GitHub-Aufruf.
- GitHub-API nicht erreichbar / Timeout → `502`, auditiert als Fehlschlag, kein Teil-Zustand.
- Ungültiger Name (Leerzeichen, verbotene Zeichen, zu lang) → `422` vor jedem GitHub-Aufruf.

## NFRs
- **Sicherheit (Floor, hart):** Installation-Token niemals in Frontend-Bundle, Logs, Audit, WS-Stream, Response oder URL/Argv. Token transient pro Request (frisch gemintet, nicht über den Request hinaus gecached).
- **Sicherheit:** mutierende Aktion auditiert (Audit-First) + identitäts-/rollengeschützt (höher-privilegiert als Lese-Views).
- **Betriebs-Vorbedingung (dokumentieren):** Die GitHub-App `softwareschmiede-bot[bot]` benötigt die Permission **Administration: Read & Write** (Org-Repos anlegen). Ohne diese Permission scheitert das Anlegen mit GitHub-`403` — das ist ein **Konfigurations**-Fehler, kein Code-Fehler. Hinweis in der Fehlermeldung + Deploy-/Setup-Doku.
- **A11y:** Formularfelder beschriftet, Fehler programmatisch zugeordnet, Fokusführung beim Anlegen/Fehler; Erfolgs-URL fokussierbar/klickbar.

## Nicht-Ziele
- Repository-Konfiguration über das Anlegen hinaus (Branch-Protection, Topics, Collaborators, Webhooks) — Folge-Anforderung.
- Anlegen außerhalb der konfigurierten Org (User-Repos) — Scope ist die Org.
- Lokales Klonen des neu angelegten Repos — das ist [[github-repo-clone]] (getrennte Capability).

## Abhängigkeiten
- [[view-github]] (Ansicht, in der das Anlege-Formular sitzt).
- [[settings-credentials]] / `CredentialStore` (Schema `github`: App-ID/Installation-ID/Private-Key fürs Token-Minting).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identitätsauswertung).
- **Architektur:** neuer `GitHubWriter`-Boundary (siehe `docs/architecture.md`); tiefe Architektur-Festlegung beim `architekt`.
