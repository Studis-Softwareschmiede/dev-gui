---
id: workspace-repos
title: Workspace-Übersicht (lokale Klone — Listing, Pull, Löschen)
status: draft
version: 1
---

# Spec: Workspace-Übersicht lokaler Klone (`workspace-repos`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch (Token-Handling beim Pull + Path-Traversal/Symlink-Schutz beim Löschen).

## Zweck
Die GitHub-Ansicht ([[view-github]]) zeigt neben der Org-Repo-Übersicht ([[github-repos-overview]]) eine **Übersicht der lokal im Workspace geklonten Repos** und erlaubt deren Verwaltung. Sie schließt die in [[github-repo-clone]] als Folge-Idee notierte Lücke: das Backend scannt `WORKSPACE_DIR` (live vom Dateisystem, keine eigene Datenhaltung), listet die Klone mit Git-Zustand und bietet pro Klon zwei mutierende Aktionen: **Pull** (frischer Stand vom Remote) und **Löschen** (Klon strikt innerhalb `WORKSPACE_DIR` entfernen). Beide Mutationen sind auditiert + identitäts-/rollengeschützt (gleiche `CRED_ADMIN_EMAILS`-Linie wie ADR-007).

## Verhalten

### Listing (read-only)
1. Das Backend scannt **live** die **direkten** Unterordner von `WORKSPACE_DIR`; ein Unterordner mit einem `.git`-Eintrag gilt als lokaler Klon. Nicht-Git-Ordner und tiefer verschachtelte Repos werden nicht als Klon gelistet.
2. Pro Klon werden gemeldet: `name` (Ordnername), `branch` (aktueller Branch), `dirty` (true = uncommitted changes / nicht clean), `lastCommit` (Kurz-Info zum letzten Commit: Hash kurz, Subject, Datum) und `originUrl` (Remote `origin`, **maskiert**, s.u.).
3. Liegt in der Remote-`origin`-URL je ein Credential/Token (z.B. `https://x-access-token:TOKEN@github.com/...`), wird es vor der Auslieferung ans Frontend **gestrippt/maskiert** — die Klartext-`origin`-URL mit Credential verlässt das Backend nie.

### Pull (mutierend)
4. Pro Klon kann ein **Pull** ausgelöst werden. Das Backend mintet **unmittelbar vorher** einen frischen Installation-Token (Mechanik identisch zu [[github-repo-clone]] AC3: aus dem `CredentialStore`-Schema `github`, transient pro Request) und führt einen `git pull` im Klon-Verzeichnis aus.
5. Der Token wird **nie** in der `origin`-Remote-URL persistiert, nie in Argv/Prozessliste, Logs, Audit, Response oder WS-Stream sichtbar (transiente Injektion analog Klonen).
6. Der Pull-Ziel-Pfad wird gegen Path-Traversal/Symlink-Flucht geprüft: nur ein Klon **strikt innerhalb** `WORKSPACE_DIR` darf gepullt werden (gleiche Schutz-Linie wie [[github-repo-clone]] AC2).

### Löschen (mutierend)
7. Pro Klon kann ein **Löschen** ausgelöst werden. Die Löschung erfolgt **strikt innerhalb** `WORKSPACE_DIR`: der aufgelöste Zielpfad muss ein direkter Unterordner von `WORKSPACE_DIR` sein (kein `..`, keine absoluten Pfade, keine Symlink-Flucht aus `WORKSPACE_DIR` heraus); andernfalls Abbruch ohne Löschung.
8. Das Frontend verlangt vor dem Löschen eine **explizite Bestätigung** (Bestätigungs-Dialog), da die Aktion destruktiv und nicht rückgängig ist.

### Querschnitt (beide Mutationen)
9. Jede Mutation (Pull wie Löschen, Erfolg **und** Fehlschlag) wird **auditiert** (Identität, Aktion, Klon-Name/Ziel-Pfad, Ergebnis, Zeit) — **ohne** Token/Secret im Audit; schlägt der Audit-Write fehl, unterbleibt die Mutation (Audit-First).
10. Beide Mutationen sind **höher-privilegiert**: hinter der Access-Mauer + identitäts-/rollengeschützt (gleiche `CRED_ADMIN_EMAILS`-Logik wie ADR-007); ohne Berechtigung → `403`.

## Acceptance-Kriterien
- **AC1** — Ein neuer read-only Backend-Endpunkt listet **live** die lokalen Klone aus `WORKSPACE_DIR`: direkte Unterordner mit `.git`. Pro Klon enthält die Response mindestens `{ name, branch, dirty, lastCommit, originUrl }`. Kein Wert stammt aus einem persistierten Store (ADR-005); Nicht-Git-Ordner werden nicht gelistet.
- **AC2** — Die `originUrl` im Listing ist **credential-frei**: enthielt die echte `origin`-Remote-URL je einen Token/ein Passwort (`user:token@host`), wird dieser Teil gestrippt/maskiert, bevor die URL das Backend verlässt. (Testbar: eine `origin`-URL mit eingebettetem Token erscheint in der Response **ohne** den Token.)
- **AC3** — **Pull:** Ein neuer Endpunkt führt `git pull` für einen benannten Klon aus. Der Installation-Token wird **unmittelbar vor** dem Pull frisch gemintet und erscheint **nie** in Response, Log, Audit, WS-Stream, der persistierten `origin`-Remote-URL oder der Argv/Prozessliste (Mechanik identisch zu [[github-repo-clone]] AC3). (Testbar: Token taucht nirgends in Response/Audit/Prozess-Argv/persistierter origin-URL auf.)
- **AC4** — **Pull-Pfadschutz:** Der Pull-Ziel-Pfad liegt strikt innerhalb `WORKSPACE_DIR`; eine Klon-Referenz, die außerhalb zeigt (`..`, absoluter Pfad, Symlink-Flucht), wird mit `4xx` abgewiesen, ohne dass `git pull` außerhalb `WORKSPACE_DIR` läuft.
- **AC5** — **Löschen:** Ein neuer Endpunkt entfernt einen benannten Klon **strikt innerhalb** `WORKSPACE_DIR`. Der aufgelöste Zielpfad wird gegen Path-Traversal/Symlink-Flucht geprüft (gleiche Linie wie [[github-repo-clone]] AC2): eine Referenz außerhalb `WORKSPACE_DIR` wird mit `4xx` abgewiesen, **ohne** dass etwas außerhalb gelöscht wird. (Testbar: Traversal-/Symlink-Eingabe löscht keine Datei außerhalb `WORKSPACE_DIR`.)
- **AC6** — **Lösch-Bestätigung:** Das Frontend löst das Löschen erst nach einer expliziten Nutzer-Bestätigung (Bestätigungs-Dialog) aus.
- **AC7** — **Audit-First:** Jede Mutation (Pull **und** Löschen, Erfolg **und** Fehlschlag) erzeugt einen Audit-Eintrag (Identität, Aktion, Klon-Name/Ziel-Pfad, Ergebnis, Zeit) **ohne** Token/Secret; schlägt der Audit-Write fehl, unterbleibt die Mutation.
- **AC8** — **Schutz:** Pull- und Lösch-Endpunkt sind hinter der Access-Mauer; eine Anfrage ohne gültigen Access-Nachweis → `403`; ist `CRED_ADMIN_EMAILS` gesetzt, sind nur diese Identitäten berechtigt (sonst `403`) — identische Logik zu ADR-007. Der read-only Listing-Endpunkt ist (wie alle `/api/*`) ebenfalls hinter der Access-Mauer, aber nicht zusätzlich rollengeschützt.
- **AC9** — **Frontend-Verzahnung:** Die Workspace-Übersicht rendert pro Klon Name, Branch, clean/dirty-Status, letzten Commit sowie die credential-freie origin-URL und die Aktionen Pull + Löschen. (Die Badge „lokal vorhanden" in der Org-Repo-Liste ist in [[github-repos-overview]] AC5 spezifiziert.)

## Verträge
> Pfade/Felder kanonisch; Git-Ausführung (Scan/`git pull`) + Token-Minting sind boundary-intern gekapselt; Token nie nach außen.

- **GET `/api/workspace/repos`** (read-only, hinter AccessGuard) → **200** `{ repos: [{ name, branch, dirty: boolean, lastCommit: { hash, subject, date }, originUrl }] }`. `originUrl` credential-frei (AC2).
- **POST `/api/workspace/repos/pull`** (mutierend) — Body `{ name: string }` (Klon-Ordnername; **keine** freie Pfadangabe).
  - **200** `{ name, status: "pulled", summary? }` bei Erfolg.
  - **4xx** bei Validierungs-/Traversal-Fehler (AC4) bzw. unbekanntem Klon (`404`).
  - **502** wenn `git pull` fehlschlägt (Netz/Auth) — kein Secret-Leak (AC3).
  - **403** ohne Access bzw. ohne Berechtigung (AC8).
- **POST `/api/workspace/repos/delete`** (mutierend) — Body `{ name: string }`.
  - **200** `{ name, status: "deleted" }` bei Erfolg.
  - **4xx** bei Validierungs-/Traversal-/Symlink-Fehler (AC5) bzw. unbekanntem Klon (`404`).
  - **403** ohne Access bzw. ohne Berechtigung (AC8).
- **Konfiguration:** Workspace-Root = **Effektivwert** (konfiguriert ?? Env `WORKSPACE_DIR`, siehe [[workspace-path-config]]) — derselbe Workspace-Root wie in [[github-repo-clone]]; direkte Unterordner = potenzielle Klone. Ist nichts konfiguriert, gilt unverändert die Env `WORKSPACE_DIR`.
- **Boundary:** das Workspace-Scannen + Git-Ausführen (`git pull`, Status/Branch/Commit lesen) + Löschen erfolgt in einem klaren Boundary; das Token-Minting für den Pull nutzt **dieselbe** Mechanik/Quelle wie [[github-repo-clone]] (`CredentialStore`-Schema `github`). Welche konkrete Komponente die Git-/FS-Operationen kapselt (eigener `WorkspaceManager` vs. Erweiterung des Klon-Boundary) entscheidet der `architekt`; bindend ist: **ein** Boundary für Workspace-FS/Git, Token nie persistiert.
- Mutierende Endpunkte zusätzlich identitäts-/rollengeprüft; jede Mutation schreibt einen AuditEntry (vgl. [[access-and-guardrails]]).

## Edge-Cases & Fehlerverhalten
- `WORKSPACE_DIR` nicht gesetzt / nicht existent → Listing liefert `{ repos: [] }` (oder klaren leeren-Zustand), kein Crash.
- Unterordner ohne `.git` → nicht als Klon gelistet.
- Klon ohne `origin`-Remote → `originUrl: null`; Pull → `4xx`/`409` mit klarer Meldung (kein Remote zum Pullen).
- `git pull` mit lokalen uncommitted changes / Merge-Konflikt → `409`/`502` mit klarer Meldung, lokaler Zustand nicht zerstört.
- Referenz mit `..`, absolutem Pfad oder Symlink, der aus `WORKSPACE_DIR` herauszeigt → `4xx`, nichts außerhalb gepullt/gelöscht (AC4/AC5).
- `CredentialStore`-Schema `github` unvollständig → Pull `500`/`502` ohne Klartext-Leak, kein Token in der URL.
- Lösch-Ziel existiert nicht (Race) → `404`/`409`, idempotent-tolerant, kein Fehler-Leak.

## NFRs
- **Sicherheit (Floor, hart):** Installation-Token niemals in Frontend-Bundle, Logs, Audit, WS-Stream, Response, der `git pull`-/Clone-URL, Argv/Prozessliste oder persistierter `origin`-Remote-URL. Token transient pro Request (frisch gemintet, unmittelbar vor dem Pull). `origin`-URLs im Listing immer credential-frei.
- **Sicherheit:** Löschen/Pull strikt innerhalb `WORKSPACE_DIR` (Path-Traversal-/Symlink-Schutz); beide Mutationen auditiert (Audit-First) + identitäts-/rollengeschützt.
- **Datenhaltung:** Listing live vom Dateisystem (ADR-005, kein Store).
- **A11y:** Liste semantisch strukturiert; Aktions-Buttons beschriftet; Lösch-Bestätigung tastaturbedienbar mit klarer Fokusführung; Fehler programmatisch zugeordnet.

## Nicht-Ziele
- Klonen selbst (das ist [[github-repo-clone]]) — diese Spec setzt einen bereits geklonten Workspace voraus.
- Fabrik-Onboarding (`/agent-flow:adopt`) — kein Profil/Board-Verknüpfen, kein Flow-Trigger.
- Push/Commit/Branch-Operationen aus der GUI — nur Pull (Stand aktualisieren) + Löschen.
- Board-/PR-Verwaltung (eigene, noch zu verfeinernde Folge-Anforderung; Kollision mit der `/flow`-Rolle als einzigem Schreiber von Board-Status/PRs → Abgrenzung beim `architekt`).

## Abhängigkeiten
- [[view-github]] (Ansicht, in der die Workspace-Übersicht sitzt).
- [[github-repo-clone]] (definiert den Workspace-Root, die Path-Traversal-/Symlink-Schutzlinie und die Token-Mint-Mechanik für den Pull; Workspace-Klone sind das Eingabematerial dieser Spec).
- [[workspace-path-config]] (der Workspace-Root ist konfigurierbar; Listing/Pull/Löschen nutzen den Effektivwert statt direkt Env `WORKSPACE_DIR`).
- [[github-repos-overview]] (Verzahnung: Badge „lokal vorhanden" in der Org-Repo-Liste).
- [[settings-credentials]] / `CredentialStore` (Schema `github`: Token-Minting für den Pull).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identitätsauswertung).
- **Architektur:** Workspace-FS/Git-Boundary; tiefe Architektur-Festlegung beim `architekt`.
