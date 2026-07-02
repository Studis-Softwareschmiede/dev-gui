---
id: obsidian-vault-config
title: Obsidian-Vault-Pfad konfigurierbar + Projekt-Ordner auflisten
status: draft
version: 1
spec_format: use-case-2.0
---

# Spec: Obsidian-Vault-Pfad konfigurierbar (`obsidian-vault-config`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` — hartes Drift-Gate. Security-relevant (Dateisystem-Lese-Boundary, Path-Traversal/Symlink).

## Zweck
Ein **dritter Projekt-Anlage-Weg** (neben „komplett neu" und „aus GitHub klonen") soll Projekte aus **lokalen Obsidian-Notizen** speisen. Dafür braucht dev-gui **einen** konfigurierbaren Pfad zum lokalen **Obsidian-Vault** — dem Ordner, der einen Unterordner **„Projekte"** enthält, unter dem je Idee ein Unterordner mit mehreren `.md`-Notizen liegt. Diese Spec macht diesen Vault-Pfad über die **Einstellungen-Ansicht** konfigurierbar (setzen/ändern/zurücksetzen, mit Validierung) und liefert einen **read-only Endpunkt**, der die Projekt-Unterordner unter `<vault>/Projekte` auflistet — die Auswahlgrundlage für den Anlage-Flow ([[obsidian-project-intake]]).

> **Muster:** Bewusst analog zu [[workspace-path-config]] (nicht-geheime Betreiber-Konfiguration im `meta`-Block des `CredentialStore`, Read-/Set-/Reset-Endpunkte, Audit + Rollenschutz auf Mutation). Der Vault-Pfad ist **kein Geheimnis**.

## Container-Erreichbarkeit (Rahmen)
dev-gui läuft im Container (ADR-006). Ein auf dem **Host** liegender Obsidian-Vault ist im Container **nur sichtbar, wenn er als Volume gemountet ist** — dieselbe Mount-Grenze wie beim Workspace ([[workspace-path-config]], Modell a). Diese Spec validiert den konfigurierten Pfad **aus Sicht des Backend-Prozesses** (existiert / ist Verzeichnis / lesbar); **ob** ein Host-Vault dafür gemountet werden muss, ist **Deploy-Zeit-Konfiguration** (Volume-Mount, analog `WORKSPACE_HOST_DIR`) und liegt außerhalb dieser Spec (Architektur-/Deploy-Entscheidung — s. Offene Annahmen A1). Ist ein äußerer Mount-Root als Env gesetzt (analog `WORKSPACE_DIR`), gilt dessen Containment-Schranke; ohne einen solchen gilt „lesbar aus Backend-Sicht" als wirksame Prüfung.

## Verhalten
1. In der **Einstellungen-Ansicht** gibt es einen Eintrag **„Obsidian-Vault-Pfad"** (eigene Sektion oder unter „Integrationen", **kein** verschlüsseltes Credential-Feld): er zeigt den **aktuell konfigurierten** Vault-Pfad inkl. Zustand (konfiguriert / nicht konfiguriert) und erlaubt, ihn zu **setzen/ändern** und zu **löschen** (zurücksetzen auf „nicht konfiguriert").
2. Beim **Setzen** wird der Pfad validiert: (a) **existiert** und ist ein **Verzeichnis**; (b) ist **lesbar** (Backend-uid); (c) enthält einen Unterordner **„Projekte"** (Verzeichnis) — sonst klare, feldzugeordnete Fehlermeldung, der bisher konfigurierte Wert bleibt unverändert. Bei gesetztem Mount-Root-Env (s. Rahmen) zusätzlich: liegt **innerhalb** dieser Schranke (Path-Traversal-/Symlink-sicher).
3. Der konfigurierte Wert wird **persistiert** (nicht-geheime Betreiber-Konfiguration, `meta`-Block — **kein** Secret) und überlebt einen Neustart.
4. Ein read-only Endpunkt liefert die **Projekt-Unterordner** unter `<vault>/Projekte`: je direkter Unterordner ein Eintrag mit `{ name, path }` (`path` = der an [[obsidian-project-intake]] weiterzureichende, vault-confinte Ordnerpfad). Nur Verzeichnisse; keine `.md`-Dateien, keine versteckten/Dot-Ordner; stabil sortiert. Die Auflistung ist **strikt auf `<vault>/Projekte` confined** (kein `..`, keine Symlink-Flucht aus dem Vault).
5. Setzen/Ändern/Löschen des Vault-Pfads wird **auditiert** (Identität, Aktion, alter→neuer Pfad, Zeit) und ist **identitäts-/rollengeschützt** (gleiche `CRED_ADMIN_EMAILS`-Linie wie ADR-007); ohne Berechtigung → `403`. Das **Lesen** (wirksamer Pfad + Projekt-Liste) ist wie alle `/api/*` hinter der Access-Mauer, aber nicht zusätzlich rollengeschützt.

## Acceptance-Kriterien
- **AC1** — Ein Eintrag „Obsidian-Vault-Pfad" in der Einstellungen-Ansicht zeigt den **konfigurierten** Vault-Pfad (bzw. „nicht konfiguriert") und erlaubt, **einen** Pfad zu **setzen**, zu **ändern** und zu **löschen** (zurücksetzen). Read-Endpunkt liefert den konfigurierten Pfad + Zustand. *(1)*
- **AC2** — Beim Setzen wird geprüft, dass der Pfad **existiert**, ein **Verzeichnis** und **lesbar** ist **und** einen Unterordner **„Projekte"** (Verzeichnis) enthält; schlägt eine Prüfung fehl → `4xx`/`422` mit klarer, feldzugeordneter Meldung, der bisher konfigurierte Wert bleibt **unverändert**. *(2)*
- **AC3** — **Traversal-/Symlink-Schutz (Security-Floor, hart):** ist ein Mount-Root-Env gesetzt, wird ein Pfad **außerhalb** dieser Schranke (`..`, absoluter Pfad außerhalb, Symlink-Flucht) mit `4xx` und klarer Meldung abgewiesen, **ohne** wirksam zu werden (gleiche Schutzlinie wie [[workspace-path-config]] AC2 / [[github-repo-clone]] AC2). Die **Projekt-Auflistung** (AC5) ist strikt auf `<vault>/Projekte` confined — kein Eintrag zeigt auf einen Pfad außerhalb des Vaults. *(2,4)*
- **AC4** — Der konfigurierte Pfad wird **persistiert** und ist nach einem Neustart unverändert wirksam; er liegt als **Klartext-Metadatum** (`meta`-Block) vor, **nicht** im verschlüsselten `entries`-Secret-Block (kein Geheimnis). *(3)*
- **AC5** — `GET …/obsidian-vault/projects` liefert die **direkten Unterordner** unter `<vault>/Projekte` als `[{ name, path }]` (nur Verzeichnisse, keine Dot-Ordner, keine Dateien, stabil sortiert). Ist kein Vault konfiguriert → definierte Antwort (`409`/`{ configured: false }`, s. Verträge), **kein** Crash; fehlt „Projekte" trotz konfiguriertem Vault → leere Liste **oder** klarer `4xx` (s. Verträge). *(4)*
- **AC6** — Setzen/Ändern/Löschen erzeugt einen **Audit-Eintrag** (Identität, Aktion, alter→neuer Pfad, Zeit) **ohne** Secret; schlägt der Audit-Write fehl, unterbleibt die Mutation (Audit-First). *(5)*
- **AC7** — Mutierende Vault-Pfad-Endpunkte sind hinter der Access-Mauer; ohne Access → `403`; ist `CRED_ADMIN_EMAILS` gesetzt, sind nur diese Identitäten berechtigt (sonst `403`) — identische Logik zu ADR-007. Die Read-Endpunkte (wirksamer Pfad, Projekt-Liste) sind hinter der Access-Mauer, aber nicht zusätzlich rollengeschützt. *(5)*

## Verträge
> Persistenz-Detail (Andockpunkt `meta`-Block des `CredentialStore`, ggf. eigener Resolver) = Architektur-Entscheidung `architekt`; bindend: **eine** Quelle der Wahrheit für den konfigurierten Vault-Pfad, nicht-geheim.

- **GET `/api/settings/obsidian-vault-path`** (read-only, hinter AccessGuard) → **200** `{ vaultPath: string|null, configured: boolean, mountRoot?: string }`. `mountRoot` = die Mount-Schranke (falls per Env gesetzt), zur UI-Orientierung.
- **PUT `/api/settings/obsidian-vault-path`** (mutierend) — Body `{ path: string }` → validiert (AC2/AC3), persistiert (AC4).
  - **200** `{ vaultPath, configured: true }` bei Erfolg.
  - **4xx/422** bei nicht-existent / kein-Verzeichnis / nicht-lesbar / fehlendem „Projekte"-Unterordner (AC2) bzw. Traversal/außerhalb-Schranke (AC3) — konfigurierter Wert unverändert.
  - **403** ohne Access bzw. ohne Berechtigung (AC7).
- **DELETE `/api/settings/obsidian-vault-path`** (mutierend) — entfernt die Konfiguration → `200 { vaultPath: null, configured: false }`.
- **GET `/api/settings/obsidian-vault/projects`** (read-only, hinter AccessGuard) → **200** `{ projects: Array<{ name: string, path: string }> }` (direkte Unterordner unter `<vault>/Projekte`, AC5). **409** `{ configured: false }` wenn kein Vault konfiguriert. **4xx** wenn konfigurierter Vault den „Projekte"-Ordner (mehr) nicht enthält (klare Meldung). Jeder `path` ist **vault-confined** (AC3).
- Mutierende Endpunkte identitäts-/rollengeprüft; jede Mutation schreibt einen `AuditEntry` (vgl. [[access-and-guardrails]]). Der Vault-Pfad erscheint **nicht** im verschlüsselten `entries`-Block.

## Edge-Cases & Fehlerverhalten
- Eingegebener Pfad = leer/whitespace → `422`, kein Effekt.
- Pfad existiert, ist aber **kein Verzeichnis** (Datei) → `422`.
- Pfad existiert/ist Verzeichnis, aber **ohne** Unterordner „Projekte" → `422` mit klarer Meldung (AC2).
- Pfad existiert, ist aber **nicht lesbar** (Backend-uid) → `4xx`/`422`.
- Vault wird **nach** dem Setzen extern entfernt/unmounted (Race) → Projekt-Liste meldet definierten Fehler (leer / `4xx`), kein Crash; UI kann „Vault nicht mehr erreichbar" anzeigen.
- `<vault>/Projekte` existiert, ist aber leer → `{ projects: [] }`.
- Symlink innerhalb „Projekte", der aus dem Vault zeigt → **nicht** als Projekt gelistet (Confinement, AC3).

## NFRs
- **Sicherheit (Floor, hart):** Dateisystem-Zugriffe (Validierung + Auflisten) strikt confined; kein Lesen/Auflisten außerhalb des konfigurierten Vaults (Path-Traversal-/Symlink-sicher). Vault-Pfad ist **nicht-geheime** Konfiguration → Klartext-Metadatum, nie im verschlüsselten `entries`-Block. Kein Secret in Log/Audit/Response.
- **A11y:** Feld beschriftet, Zustand (konfiguriert/nicht) sichtbar (nicht nur Farbe), Fehler programmatisch zugeordnet, Fokusführung bei Erfolg/Fehler.
- **Datenhaltung:** keine neue DB-Engine — `meta`-Block wie [[workspace-path-config]] / ADR-014-Linie.

## Nicht-Ziele
- **Mehrere** Vaults / mehrere Vault-Roots — bewusst **ein** Pfad.
- **Schreiben** in den Vault (dev-gui liest den Vault nur; Notizen bleiben unangetastet).
- **Parsen/Interpretieren** der `.md`-Notizen — das macht ausschließlich die Fabrik-Pipeline (`/agent-flow:from-notes`, agent-flow-Seite), nicht dev-gui.
- **Volume-/Mount-Konfiguration** selbst (Deploy-Zeit) über die GUI ändern.

## Abhängigkeiten
- [[workspace-path-config]] (Muster: nicht-geheime Pfad-Konfiguration im `meta`-Block, Read-/Set-/Reset-Endpunkte, Traversal-/Symlink-Schutz, Audit + Rollenschutz — hier gespiegelt).
- [[settings-credentials]] / [[settings-shell]] (Einstellungen-Ansicht, in die der Eintrag gehängt wird; `CredentialStore`-`meta`-Andockpunkt).
- [[access-and-guardrails]] (Access-Mauer + Audit-First + Identitätsauswertung).
- [[obsidian-project-intake]] (Konsument der Projekt-Liste `GET …/obsidian-vault/projects`).

## Offene Annahmen (mangels Rückfrage-Möglichkeit als Subagent gesetzt — vom Owner bestätigbar)
- **A1 (Container-Mount):** Der Vault ist dem Backend als Volume gemountet (analog `WORKSPACE_HOST_DIR`), damit ein Host-Pfad im Container sichtbar ist. Der konkrete Mount (Env-Name, Schranke) ist **Deploy-/Architektur-Detail** (`architekt`/Deploy) und **nicht** Teil dieser Spec; hier wird nur „lesbar aus Backend-Sicht" + optionale Containment-Schranke geprüft. Falls der Owner einen expliziten Mount-Root-Env wünscht (harte Modell-a-Schranke wie beim Workspace), wird AC3 entsprechend geschärft.
- **A2 (Sektion in Settings):** Der Vault-Pfad lebt in einer eigenen „Obsidian"-/„Integrationen"-Sektion der Einstellungen (nicht in der GitHub-Sektion, da nicht GitHub-bezogen). Owner kann die Platzierung anders wünschen.
