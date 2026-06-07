---
id: github-repo-clone
title: GitHub-Repository lokal klonen (Workspace)
status: draft
version: 1
---

# Spec: GitHub-Repository lokal klonen (`github-repo-clone`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch (Token-Handling + Path-Traversal).

## Zweck
Über die GitHub-Ansicht ([[view-github]]) lässt sich ein **bestehendes GitHub-Repository der Org lokal in einen festen Workspace klonen**. Dies ist eine **eigene, klar abgegrenzte Capability** — ein nacktes `git clone` in einen konfigurierbaren Workspace-Pfad (`WORKSPACE_DIR` auf dem persistenten Volume), **nicht** der Fabrik-Onboarding-Weg. Nach dem Klonen ist der Status schlicht „geklont"; Listing/Verwaltung lokaler Klone ist nicht im Scope.

> **Abgrenzung zu `/agent-flow:adopt`:** `adopt` ist der **Fabrik-Onboarding-Weg** (richtet ein Repo für den agent-flow-Loop ein: Profil, Board-Verknüpfung, Konventionen). `github-repo-clone` ist bewusst **schlanker**: nur ein lokaler Klon in den Workspace, **ohne** Fabrik-Onboarding. Wer ein Repo in die Fabrik aufnehmen will, nutzt weiterhin `adopt`; dieser Klon-Pfad führt **kein** Onboarding durch und triggert **keinen** Flow.

## Verhalten
1. In der GitHub-Ansicht kann der Nutzer ein bestehendes Org-Repository auswählen/eingeben und das **lokale Klonen** auslösen.
2. Das Backend validiert die Repo-Referenz, mintet **unmittelbar vor** dem Klonen einen frischen Installation-Token aus dem `CredentialStore`-Schema `github` und führt ein nacktes `git clone` in ein Zielverzeichnis **strikt innerhalb** von `WORKSPACE_DIR` aus.
3. Bei Erfolg meldet das Backend den Status „geklont" inkl. des relativen Ziel-Pfads im Workspace; das Frontend zeigt diese Bestätigung an.
4. Das **Klon-Ziel** ist gegen **Path-Traversal** abgesichert: der aufgelöste Zielpfad muss strikt innerhalb von `WORKSPACE_DIR` liegen (kein `..`, keine absoluten Pfade, keine Symlink-Flucht); andernfalls Abbruch mit Fehler.
5. **Re-Clone-/Idempotenz-Verhalten** ist definiert: existiert das Zielverzeichnis bereits, wird **nicht** stillschweigend überschrieben — die Aktion meldet „bereits vorhanden" (oder verlangt explizit Bestätigung/`force`), ohne den vorhandenen Klon zu zerstören.
6. Jede Klon-Aktion (Erfolg wie Fehlschlag) wird **auditiert** (Identität, Aktion, Repo-Referenz, Ziel-Pfad, Ergebnis, Zeit) — **ohne** Token im Audit.
7. Die Aktion ist **mutierend, höher-privilegiert**: nur einer berechtigten Access-Identität erlaubt (Access-Mauer + Identitätsauswertung + optionale `CRED_ADMIN_EMAILS`-Allowlist).

## Acceptance-Kriterien
- **AC1** — Über einen neuen Backend-Endpunkt lässt sich ein bestehendes Org-Repo lokal klonen; bei Erfolg meldet die Response Status „geklont" inkl. relativem Ziel-Pfad im Workspace, und das Frontend zeigt die Bestätigung an.
- **AC2** — Das Klon-Ziel liegt strikt innerhalb des konfigurierbaren `WORKSPACE_DIR` (persistentes Volume, uid-1000-schreibbar). Der aufgelöste Zielpfad wird gegen **Path-Traversal** geprüft: Repo-Referenzen, die außerhalb von `WORKSPACE_DIR` zeigen (`..`, absolute Pfade, Symlink-Flucht), werden mit `4xx` abgewiesen, **ohne** dass etwas außerhalb geschrieben wird. (Testbar: Traversal-Eingabe schreibt keine Datei außerhalb `WORKSPACE_DIR`.)
- **AC3** — Der Installation-Token wird **unmittelbar vor** dem Klonen frisch gemintet und erscheint **nie** in einer HTTP-Response, einem Log, dem Audit, dem WS-Stream, der Clone-URL, der Argv/Prozessliste oder im persistierten Repo (z.B. nicht eingebettet in `origin`-Remote-URL). (Testbar: Token taucht nirgends in Response/Audit/Prozess-Argv auf.)
- **AC4** — **Re-Clone-/Idempotenz:** Existiert das Zielverzeichnis bereits, wird der vorhandene Klon **nicht** stillschweigend überschrieben/zerstört; die Aktion meldet „bereits vorhanden" (`409`/Status `already-present`) bzw. verlangt ein explizites `force`-Flag.
- **AC5** — Jede Klon-Aktion (Erfolg **und** Fehlschlag) erzeugt einen Audit-Eintrag (Identität, Aktion, Repo-Referenz, Ziel-Pfad, Ergebnis, Zeit) **ohne** Token/Secret; schlägt der Audit-Write fehl, unterbleibt der Klon (Audit-First, vgl. [[access-and-guardrails]]).
- **AC6** — Der Klon-Endpunkt ist hinter der Access-Mauer; eine Anfrage ohne gültigen Access-Nachweis → `403`; ist `CRED_ADMIN_EMAILS` gesetzt, sind nur diese Identitäten berechtigt (sonst `403`) — identische Logik zu ADR-007.
- **AC7** — Fehlerpfade liefern den passenden Statuscode ohne Secret-Leak: Repo nicht gefunden/kein Zugriff → `404`/`502`; `git clone` schlägt fehl (Netz/Auth) → `502`; `WORKSPACE_DIR` fehlt/nicht schreibbar → `500`/`502` mit klarer Meldung, kein halb geschriebener Ziel-Zustand.

## Verträge
> Pfade/Felder kanonisch; Token-Minting + `git clone`-Ausführung sind boundary-intern gekapselt.

- **POST `/api/github/repos/clone`** — Body `{ repo: string (z.B. "owner/name" oder Repo-Name in der Org), force?: boolean }`.
  - **200/201** `{ repo, status: "cloned", path: <relativer-Pfad-im-Workspace> }` bei Erfolg.
  - **409** `{ status: "already-present", path }` wenn das Ziel ohne `force` schon existiert (AC4).
  - **4xx** bei Validierungs-/Traversal-Fehler (AC2).
  - **404/502** wenn das Repo nicht erreichbar ist bzw. `git clone` fehlschlägt (AC7).
  - **403** ohne Access bzw. ohne Berechtigung (AC6).
- **Konfiguration:** `WORKSPACE_DIR` (Env) — fester Workspace-Pfad auf dem persistenten Volume, uid-1000-schreibbar; beim Boot idempotent angelegt. Ziel = `WORKSPACE_DIR/<safe-repo-name>`.
- **Git-Aufruf (boundary-intern):** nacktes `git clone` der HTTPS-URL mit transient injiziertem Installation-Token; Token darf **nicht** in der persistierten `origin`-Remote-URL verbleiben.
- Alle Endpunkte hinter AccessGuard; mutierende zusätzlich identitäts-/rollengeprüft; jede Mutation schreibt einen AuditEntry (vgl. [[access-and-guardrails]]).

## Edge-Cases & Fehlerverhalten
- Ziel existiert bereits ohne `force` → `409` `already-present`, vorhandener Klon unangetastet (AC4).
- Repo-Referenz zielt außerhalb `WORKSPACE_DIR` (`..`, absolut, Symlink) → `4xx`, nichts außerhalb geschrieben (AC2).
- `WORKSPACE_DIR` nicht gesetzt / nicht schreibbar → `500`/`502` mit klarer Meldung, kein Teil-Zustand.
- `git clone` schlägt fehl (Netz, Auth, fehlender Zugriff) → `502`, auditiert als Fehlschlag; ein halb angelegtes Zielverzeichnis wird aufgeräumt oder klar als unvollständig gemeldet.
- `CredentialStore`-Schema `github` unvollständig → `500`/`502` ohne Klartext-Leak, kein Klon-Versuch.
- Ungültige/leere Repo-Referenz → `422` vor jedem Git-Aufruf.

## NFRs
- **Sicherheit (Floor, hart):** Installation-Token niemals in Frontend-Bundle, Logs, Audit, WS-Stream, Response, Clone-URL, Argv/Prozessliste oder persistierter `origin`-Remote-URL. Token transient pro Request (frisch gemintet, unmittelbar vor dem Klonen).
- **Sicherheit:** Klon-Ziel strikt innerhalb `WORKSPACE_DIR` (Path-Traversal-Schutz, Symlink-sicher); mutierende Aktion auditiert (Audit-First) + identitäts-/rollengeschützt.
- **A11y:** Formularfelder beschriftet, Fehler programmatisch zugeordnet, Fokusführung bei Erfolg/Fehler.

## Nicht-Ziele
- **Fabrik-Onboarding** (Profil, Board-Verknüpfung, Konventionen) — bleibt bei `/agent-flow:adopt` (siehe Abgrenzung oben).
- **Listing/Verwaltung lokaler Klone** in der GUI (welche Repos liegen im Workspace, Pull/Status/Löschen) — **nicht im Scope**. *Folge-Idee:* eine Workspace-Übersicht (geklonte Repos auflisten + Pull/entfernen) kann eine spätere Anforderung sein.
- Schreiben/Pushen aus dem geklonten Repo über die GUI — nur klonen (lokal verfügbar machen).
- Klonen außerhalb der konfigurierten Org.

## Abhängigkeiten
- [[view-github]] (Ansicht, in der das Klon-Formular sitzt).
- [[settings-credentials]] / `CredentialStore` (Schema `github`: Token-Minting für den Klon-Zugriff).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identitätsauswertung).
- **Architektur:** `WORKSPACE_DIR` auf dem persistenten Volume (siehe `docs/architecture.md`); Boundary für die Git-Ausführung; tiefe Architektur-Festlegung beim `architekt`.
