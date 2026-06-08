---
id: workspace-path-config
title: Workspace-Pfad konfigurierbar (Settings-getriebener Workspace-Root)
status: draft
version: 1
---

# Spec: Workspace-Pfad konfigurierbar (`workspace-path-config`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-relevant (Path-Traversal/Container-Mount-Grenze).

## Zweck
Der lokale Workspace-Pfad, in den GitHub-Repos geklont und unter dem sie gelistet/gepullt/gelöscht
werden, ist heute die feste Env-Variable `WORKSPACE_DIR`. Diese Spec macht **einen** Workspace-Root
über die **Settings-Ansicht** ([[settings-shell]]) **konfigurierbar**: der Nutzer gibt **genau einen
Pfad** an; alle Repos werden — wie heute — als **direkte Unterordner** (Repo-Name) darunter geklont
und gelistet. Der konfigurierte Wert wird **persistiert** und ist der **Effektivwert** für alle
Workspace-Operationen ([[github-repo-clone]] · [[workspace-repos]]); ist nichts konfiguriert, gilt
weiterhin die Env `WORKSPACE_DIR` als **Fallback/Default**.

> **Begriff „Effektivwert WORKSPACE_DIR":** ab dieser Spec ist der für Klon/Listing/Pull/Löschen
> wirksame Workspace-Root **nicht mehr nur die Env**, sondern `konfigurierter Wert ?? Env
> WORKSPACE_DIR`. Die drei Workspace-Boundaries ([[github-repo-clone]] = `GitHubCloner`,
> [[workspace-repos]] = `WorkspaceScanner`/`WorkspaceMutator`) lesen diesen **Effektivwert** statt
> direkt `process.env.WORKSPACE_DIR`.

## Container-Mount-Grenze (zentraler Rahmen — Modell a)
Im Container ist der Workspace ein **gemountetes Volume** (`WORKSPACE_DIR=/workspace` ← Host
`WORKSPACE_HOST_DIR`, `docker-compose.yml`). Ein zur Laufzeit frei eingegebener **Host-Pfad** ist im
Container **nicht sichtbar**, wenn er nicht gemountet ist. Daher gilt **Modell (a)**:

- Die Env `WORKSPACE_DIR` bleibt die **äußere, gemountete Schranke** (= **Root-Boundary**, im
  Container immer erreichbar).
- Über die GUI wählt der Nutzer **einen Workspace-Root**, der **innerhalb dieser Schranke liegen
  muss**: entweder die Schranke selbst (`= WORKSPACE_DIR`, identisch zu heute) oder ein **Unterordner
  darunter** (Path-Traversal-/Symlink-sicher, gleiche Schutz-Linie wie [[github-repo-clone]] AC2).
- Ein konfigurierter Wert **außerhalb** der gemounteten Schranke wird **abgewiesen** mit klarer
  Meldung „Pfad nicht im Container erreichbar / außerhalb des gemounteten Workspace" — nicht
  stillschweigend übernommen.

> **Entschieden (User):** Modell (a) ist verbindlich — die Env `WORKSPACE_DIR` bleibt die äußere,
> gemountete Schranke; die GUI wählt einen Root **innerhalb** dieser Schranke (Traversal-/Symlink-
> sicher). Modell (b/c) (freier Host-Pfad) ist ausgeschlossen.

## Verhalten
1. In der Settings-Ansicht gibt es eine **Sektion „Workspace"** mit **einem** Feld „Workspace-Pfad":
   sie zeigt den **aktuell wirksamen** Workspace-Root (konfiguriert **oder** Env-Fallback, inkl.
   Quelle „konfiguriert" / „Default aus Env") und erlaubt, ihn zu **setzen/ändern** und auf den
   Env-Default **zurückzusetzen** (Löschen der Konfiguration).
2. Beim **Setzen** wird der Pfad validiert: (a) liegt **innerhalb** der gemounteten Schranke
   `WORKSPACE_DIR` (Modell a, Path-Traversal-/Symlink-sicher), (b) **existiert** und ist ein
   **Verzeichnis**, (c) ist **schreibbar** (uid-1000). Schlägt eine Prüfung fehl, wird der Wert
   **nicht** übernommen; der bisher wirksame Wert bleibt unverändert; das Frontend zeigt eine klare,
   feldzugeordnete Fehlermeldung.
3. Der konfigurierte Wert wird **persistiert** (nicht-geheime Betreiber-Konfiguration; **kein**
   Geheimnis) und überlebt einen Neustart.
4. **Alle** Workspace-Operationen — Klonen ([[github-repo-clone]]), Listing/Pull/Löschen
   ([[workspace-repos]]) — nutzen den **Effektivwert** (konfiguriert ?? Env) als Workspace-Root; die
   pro-Repo-Unterordner-Logik (ein direkter Unterordner je Repo) bleibt **unverändert**.
5. Eine Änderung des Workspace-Pfads greift **zur Laufzeit ohne Neustart** für jede **nachfolgende**
   Operation (der Effektivwert wird pro Operation aufgelöst, nicht beim Boot eingefroren).
6. **Bestehende Klone im alten Pfad** werden **nicht** automatisch verschoben/migriert: nach einer
   Umstellung wird der **neue** Root gescannt/beklont; im alten Pfad liegende Klone erscheinen
   schlicht nicht mehr im Listing (sie bleiben unangetastet auf der Platte).
7. Setzen/Ändern/Zurücksetzen des Workspace-Pfads wird **auditiert** (Identität, Aktion, alter→neuer
   Pfad, Zeit) und ist **identitäts-/rollengeschützt** (gleiche `CRED_ADMIN_EMAILS`-Linie wie
   ADR-007); ohne Berechtigung → `403`. Das **Lesen** des wirksamen Pfads ist (wie alle `/api/*`)
   hinter der Access-Mauer, aber nicht zusätzlich rollengeschützt.

> **Entschieden (User):** Verhalten 5 (Laufzeit **ohne** Neustart, Effektivwert pro Operation
> aufgelöst) ist verbindlich — AC5 bleibt.
> **Entschieden (User):** Verhalten 6 — alte Klone **ignorieren**, **nichts migrieren/anfassen**:
> alte Klone bleiben unangetastet auf der Platte und erscheinen nach der Umstellung nicht mehr im
> Listing.

## Acceptance-Kriterien
- **AC1** — Eine Settings-Sektion „Workspace" zeigt den **aktuell wirksamen** Workspace-Root inkl.
  Quelle (konfiguriert vs. Env-Default) und erlaubt, **einen** Pfad zu setzen, zu ändern und auf den
  Env-Default zurückzusetzen. (Read-Endpunkt liefert wirksamen Pfad + Quelle.)
- **AC2** — Beim Setzen wird der Pfad gegen die **gemountete Schranke** `WORKSPACE_DIR` geprüft: ein
  Pfad **außerhalb** (`..`, absoluter Pfad außerhalb, Symlink-Flucht) wird mit `4xx` und klarer
  Meldung abgewiesen, **ohne** dass er wirksam wird (Modell a; gleiche Traversal-/Symlink-Schutz-Linie
  wie [[github-repo-clone]] AC2). (Testbar: Eingabe außerhalb `WORKSPACE_DIR` → `4xx`, Effektivwert
  unverändert.)
- **AC3** — Beim Setzen wird geprüft, dass der Pfad **existiert**, ein **Verzeichnis** und
  **schreibbar** ist; schlägt das fehl → `4xx`/`422` mit klarer Meldung, der bisher wirksame Wert
  bleibt unverändert.
- **AC4** — Der konfigurierte Pfad wird **persistiert** und ist nach einem Neustart unverändert
  wirksam (Effektivwert = konfiguriert; ohne Konfiguration = Env-Fallback). (Testbar: setzen →
  Prozess-Neustart simulieren / Store neu laden → wirksamer Pfad ist der konfigurierte.)
- **AC5** — Nach erfolgreichem Setzen nutzen **alle nachfolgenden** Workspace-Operationen (Klonen,
  Listing, Pull, Löschen) den **neuen** Effektivwert **ohne** Prozess-Neustart. (Testbar: Pfad
  ändern → `GET /api/workspace/repos` scannt den neuen Root; `POST /api/github/repos/clone` klont
  dorthin.)
- **AC6** — Der Workspace-Pfad ist **kein Geheimnis**: er darf im Read-Endpunkt und im Frontend im
  Klartext angezeigt werden; er erscheint **nicht** in einem verschlüsselten Secret-Block. (Testbar:
  Wert liegt als Klartext-Metadatum vor, nicht im `entries`-Geheimblock.)
- **AC7** — Setzen/Ändern/Zurücksetzen erzeugt einen **Audit-Eintrag** (Identität, Aktion,
  alter→neuer Pfad, Zeit); schlägt der Audit-Write fehl, unterbleibt die Mutation (Audit-First).
- **AC8** — Mutierende Workspace-Pfad-Endpunkte sind hinter der Access-Mauer; ohne gültigen
  Access-Nachweis → `403`; ist `CRED_ADMIN_EMAILS` gesetzt, sind nur diese Identitäten berechtigt
  (sonst `403`) — identische Logik zu ADR-007.
- **AC9** — Ist **kein** Pfad konfiguriert, verhalten sich Klon/Listing/Pull/Löschen **exakt wie
  heute** (Env `WORKSPACE_DIR` als Effektivwert); die Umstellung ist für den unkonfigurierten Fall
  verhaltensneutral (keine Regression gegenüber [[github-repo-clone]] / [[workspace-repos]]).

## Verträge
> Pfade/Felder kanonisch; die Persistenz des nicht-geheimen Pfads ist Architektur-Detail (Andockpunkt:
> nicht-geheimer `meta`-Block des `CredentialStore`, s. Architektur — Entscheidung `architekt`).

- **GET `/api/settings/workspace-path`** (read-only, hinter AccessGuard) → **200**
  `{ effectivePath: string|null, source: "configured"|"env-default", mountRoot: string }`.
  `mountRoot` = die gemountete Schranke (`WORKSPACE_DIR`-Env), zur UI-Orientierung.
- **PUT `/api/settings/workspace-path`** (mutierend) — Body `{ path: string }` → validiert (AC2/AC3),
  persistiert, setzt `source: "configured"`.
  - **200** `{ effectivePath, source: "configured" }` bei Erfolg.
  - **4xx/422** bei Traversal/außerhalb-Schranke (AC2) bzw. nicht-existent/kein-Verzeichnis/nicht-
    schreibbar (AC3) — Effektivwert unverändert.
  - **403** ohne Access bzw. ohne Berechtigung (AC8).
- **DELETE `/api/settings/workspace-path`** (mutierend) — entfernt die Konfiguration → Effektivwert
  fällt auf Env-Default zurück. **200** `{ effectivePath, source: "env-default" }`.
- **Effektivwert-Auflösung (boundary-intern, bindend):** `GitHubCloner`, `WorkspaceScanner`,
  `WorkspaceMutator` lesen den Workspace-Root **nicht mehr direkt** aus `process.env.WORKSPACE_DIR`,
  sondern über **eine** gemeinsame Auflösung `effektiver Workspace-Root = konfiguriert ?? env`. Welche
  konkrete Komponente diese Auflösung kapselt (eigener `WorkspaceConfig`-Resolver vs. Erweiterung
  bestehender Boundary), entscheidet der `architekt`; bindend ist: **eine** Quelle der Wahrheit für
  den Effektivwert, pro Operation aufgelöst (AC5).
- Mutierende Endpunkte zusätzlich identitäts-/rollengeprüft; jede Mutation schreibt einen AuditEntry
  (vgl. [[access-and-guardrails]]).

## Edge-Cases & Fehlerverhalten
- Eingegebener Pfad = leer/whitespace → `422`, kein Effekt.
- Pfad = exakt die gemountete Schranke (`= WORKSPACE_DIR`) → **erlaubt** (identisch zu heute).
- Pfad existiert, ist aber **kein Verzeichnis** (Datei) → `422`/`4xx`.
- Pfad existiert, ist aber **nicht schreibbar** (uid-1000) → `4xx`/`422` mit klarer Meldung.
- Konfigurierter Pfad wird **nach** dem Setzen extern entfernt (Race) → Workspace-Operationen melden
  den passenden Fehler wie heute (Listing leer / Klon `500`/`502`), kein Crash; UI kann „Pfad nicht
  mehr vorhanden" anzeigen.
- Env `WORKSPACE_DIR` selbst nicht gesetzt **und** nichts konfiguriert → wie heute: Listing
  `{ repos: [] }`, Klon `500`/`502` mit klarer Meldung (keine Regression).
- Persistenz-Backend nicht erreibar beim Setzen → `5xx` ohne Teil-Zustand; bisher wirksamer Wert
  unverändert.

## NFRs
- **Sicherheit (Floor, hart):** der konfigurierte Workspace-Root muss innerhalb der gemounteten
  Schranke liegen (Modell a, Path-Traversal-/Symlink-sicher) — verhindert, dass über die GUI auf
  Container-Pfade außerhalb des Workspace geschrieben wird. Die bestehenden Per-Operation-Traversal-
  Schutzlinien aus [[github-repo-clone]] AC2 / [[workspace-repos]] AC4/AC5 bleiben **zusätzlich**
  wirksam (der konfigurierte Root ersetzt sie nicht, sondern verschiebt nur ihre Basis).
- **Datenhaltung:** der Pfad ist **nicht-geheime** Betreiber-Konfiguration (kein Secret) → Klartext-
  Metadatum, nicht im verschlüsselten `entries`-Block (ADR-007). Keine neue DB-Engine.
- **Verhaltensneutralität:** ohne Konfiguration identisch zum heutigen Env-getriebenen Verhalten (AC9).
- **A11y:** Feld beschriftet, Quelle (konfiguriert/Default) sichtbar, Fehler programmatisch
  zugeordnet, Fokusführung bei Erfolg/Fehler.

## Nicht-Ziele
- **Mehrere** Workspace-Roots / pro-Repo-Zielpfad — bewusst ausgeschlossen (User: genau **ein** Pfad,
  darunter je Repo ein Unterordner wie heute).
- **Migration/Verschieben** bestehender Klone aus dem alten Pfad (s. OFFEN-3) — Default: nicht
  anfassen.
- **Freier Host-Pfad außerhalb der Mount-Schranke** im Container (s. OFFEN-1, Modell b/c) — bis zur
  Klärung ausgeschlossen.
- Änderung der Volume-/Mount-Konfiguration selbst (`WORKSPACE_HOST_DIR` in `docker-compose.yml`) über
  die GUI — das ist Deploy-Zeit-Konfiguration, nicht Laufzeit.

## Abhängigkeiten
- [[settings-shell]] (Sektions-Gerüst + Route; neue Sektion „Workspace").
- [[github-repo-clone]] (Klon nutzt künftig den Effektivwert statt direkt Env; Traversal-Schutzlinie).
- [[workspace-repos]] (Listing/Pull/Löschen nutzen den Effektivwert).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identitätsauswertung).
- [[settings-credentials]] / `CredentialStore` (Andockpunkt für nicht-geheime Persistenz im
  `meta`-Block; **kein** Secret — Architektur-Entscheidung beim `architekt`).
