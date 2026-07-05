---
id: repo-size-badge
title: Repo-Größen-Anzeige in der Fabrik-Übersicht (Größen-Badge + Aufschlüsselung + .git-Frühwarnung)
status: active
area: fabrik-arbeiten
version: 1
---

# Spec: Repo-Größen-Anzeige in der Fabrik-Übersicht  (`repo-size-badge`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate). **Security-relevant** (Dateisystem-Scan-Boundary innerhalb des Workspace-Mounts).

## Zweck
Die **Fabrik-Übersicht** listet die **lokalen Klone** unter dem Effektivwert `WORKSPACE_DIR` (`WorkspaceScanner` / `GET /api/workspace/repos`, [[projekt-cockpit-navigation]] V1 / [[workspace-repos]]). Jede Projekt-Karte soll zusätzlich zeigen, **wie viel Platte** der Klon belegt — als menschenlesbares **Größen-Badge** (MB/GB) mit einer **Aufschlüsselung** in drei Buckets: **Arbeitsstand** (Code/Docs/Board) · **.git** (Historie) · **Abhängigkeiten/Artefakte** (`node_modules`, `build`/`dist`, `.claude/worktrees` …). Die Summe der drei Buckets ist die **Gesamtgröße auf Platte**.

Die Messung erfolgt **lokal** über einen **Verzeichnis-Scan** des Klon-Ordners im gemounteten Workspace (**kein** GitHub-API — die GitHub-Repo-Size wäre nur der `.git`-Pack, nicht der Arbeitsstand/`node_modules`). Weil ein voller Verzeichnis-Scan teuer ist, läuft er **asynchron** und wird **gecacht/persistiert** (Zeitstempel), damit die Karte **sofort** den **letzten bekannten Wert + dessen Alter** zeigt und der Scan **nie** den Request-Pfad blockiert. Überschreitet der `.git`-Bucket eine konfigurierbare Grenze (Default **500 MB**), zeigt die Karte einen **dezenten Warnhinweis** (Git-Blähungs-Frühwarnung) — reine UI-Info, **kein** Push, **keine** Mutation.

Wiederverwendet werden zwei etablierte Muster: (a) die **pfad-confined** Workspace-Auflösung + Traversal-/Symlink-Schutz (`workspacePath.js` / `WorkspaceScanner`, [[workspace-repos]] AC4, [[github-repo-clone]] AC2) und (b) das **persistierte, zeitgestempelte, größenbegrenzte** Store-Muster unter `${CRED_STORE_DIR}` (`DrainReportStore`/`TickerSettingsStore`, atomarer tmp+rename-Schreibzugriff, [[drain-completion-report]] AC3).

> **Offene Defaults (Owner-Bestätigung ausstehend — `AskUserQuestion` im Subagenten nicht verfügbar):**
> 1. **Bucket-Definition** = *Rest + feste Artefakt-Liste, rekursiv*: Artefakte = feste Namensliste (`node_modules`, `build`, `dist`, `.next`, `coverage`, `.claude/worktrees`) **rekursiv** aufsummiert (auch verschachtelte `node_modules` in Monorepo-Sub-Packages); Arbeitsstand = Gesamt − `.git` − Artefakte.
> 2. **Schwellwert-Konfig** = **Env** `GIT_SIZE_WARN_MB` (Default 500), nicht-geheim, pro Request gelesen — bewusst **kein** eigenes Settings-UI-Item für v1 (kann als Folge-Anforderung ein meta-Block-Feld werden, Muster [[workspace-path-config]]).
> 3. **Auslösung** = **Pro-Karte-Aktualisieren-Button** + **async Auto-Messung beim Workspace-Scan**, wenn ein Wert fehlt oder älter als die Staleness-Grenze (Default 24 h) ist — non-blocking.
> Bestätigt der Owner eine Alternative, sind die betroffenen ACs (AC1/AC5/AC8) entsprechend zu präzisieren.

## Verhalten

### Messung (Backend, RepoSizeScanner — pfad-confined, rekursiv)
1. Der **`RepoSizeScanner`** vermisst **einen** Klon (direkter Unterordner des Effektivwerts `WORKSPACE_DIR`, aufgelöst über **dieselbe** geteilte Workspace-Auflösung wie `WorkspaceScanner`/`WorkspaceMutator` — nicht direkt `process.env.WORKSPACE_DIR`). Ergebnis in **Bytes**, aufgeteilt in drei Buckets:
   - **`git`** — die Größe des Top-Level-`.git`-Verzeichnisses des Klons.
   - **`artifacts`** — die **rekursive** Summe **aller** Verzeichnisse, deren Basisname in der festen Artefakt-Liste liegt (`node_modules`, `build`, `dist`, `.next`, `coverage`, `.claude/worktrees`), an **beliebiger** Verschachtelungstiefe. Ein `.git` **innerhalb** eines Worktrees unter `.claude/worktrees` zählt zu **`artifacts`** (Worktree-Bucket), **nicht** zu `git`.
   - **`workspace`** — der **Rest**: Gesamt − `git` − `artifacts` (= Arbeitsstand Code/Docs/Board).
   - **`total`** = `git` + `artifacts` + `workspace` = die tatsächliche Belegung des Klon-Ordners auf Platte.
2. Byte-Ermittlung **konsistent** (durchgehend dieselbe Grundlage: tatsächliche Datei-Byte-Größe je Eintrag, aufsummiert; keine Mischung aus apparent/allocated). Ein Verzeichnis wird **genau einmal** einem Bucket zugeordnet (ein Artefakt-Verzeichnis wird als Ganzes dem `artifacts`-Bucket zugerechnet und **nicht** zusätzlich in `workspace` weiter durchlaufen — keine Doppelzählung).

### Sicherheit des Scans (pfad-confined, symlink-sicher)
3. Der aufgelöste Klon-Pfad muss **strikt innerhalb** des Effektivwerts `WORKSPACE_DIR` liegen (realpath-Check, gleiche Schutz-Linie wie [[workspace-repos]] AC4 / [[github-repo-clone]] AC2). Eine Referenz mit `..`, absolutem Pfad oder Symlink-Flucht → **Abweisung**, **kein** Dateisystem-Walk außerhalb des Mounts.
4. Beim rekursiven Walk werden **Symlinks nicht verfolgt** (der Link-Eintrag selbst zählt, sein Ziel wird **nie** betreten) → keine Flucht aus dem Mount, keine Endlosschleife, keine Doppelzählung von Link-Zielen.

### Persistenz (Backend, RepoSizeStore — zeitgestempelt, größenbegrenzt)
5. Ein **`RepoSizeStore`** (Muster `DrainReportStore`: eigene Datei `${CRED_STORE_DIR}/repo-sizes.json`, atomarer Schreibzugriff tmp+rename, `0600`) hält je Klon **den letzten** Messwert: `{ total, git, artifacts, workspace, measuredAt }` (`measuredAt` = ISO-Zeitstempel). `record(repoSlug, buckets)` stempelt `measuredAt` und schreibt atomar; `get(repoSlug)` / `list()` liefern die letzten bekannten Werte. Der Store-Schlüssel ist der Klon-**Slug** (reiner Schlüssel, **kein** per-Request-Dateipfad aus dem Slug; traversal-neutral). Werte überstehen einen Server-Neustart. Fehlt `${CRED_STORE_DIR}` → In-Memory-Degradation (kein Crash).

### Async, non-blocking, Auslösung
6. Die Messung läuft **asynchron** (Hintergrund-Job). Sie wird **nie** synchron im Request-Pfad der Workspace-Übersicht oder eines Lese-Endpunkts ausgeführt; ein Lese-Request liefert **sofort** den letzten bekannten Wert (bzw. „noch nicht vermessen"), unabhängig davon, ob gerade ein Scan läuft oder nie einer lief.
7. **Auslösung** (Default): (a) eine **explizite Aktualisieren-Aktion je Klon** startet eine Hintergrund-Messung; (b) beim **Workspace-Scan** (Laden der Übersicht) wird für einen Klon, dessen Wert **fehlt** oder **älter als die Staleness-Grenze** (Default 24 h) ist, **automatisch** eine Hintergrund-Messung angestoßen — non-blocking. Es läuft **höchstens eine** Messung je Klon gleichzeitig (Dedup/Lock); ein zweiter Trigger während einer laufenden Messung ist ein No-op/wird koalesziert. Ein Scan-Fehler für **einen** Klon lässt die übrigen unberührt und den letzten bekannten Wert **intakt** (degradierend).

### Schwellwert-Frühwarnung (.git)
8. Die `.git`-Warngrenze ist konfigurierbar über die Env **`GIT_SIZE_WARN_MB`** (Default **500** MB). Überschreitet der `git`-Bucket eines Klons die wirksame Grenze, trägt die Größen-Nutzlast dieses Klons ein `gitWarning: true`-Flag (gegen die wirksame Grenze berechnet). Reine Info — **kein** Push, **keine** Mutation, kein Blockieren.

### Anzeige (Frontend, Projekt-Karte)
9. Jede Projekt-Karte der Fabrik-Übersicht zeigt ein **menschenlesbares Größen-Badge** (MB/GB, z.B. „1.4 GB") mit dem **letzten bekannten Gesamtwert** + dessen **Alter** (relativ, z.B. „vor 3 h", absoluter Zeitstempel im `title`/Tooltip). Nie vermessen → neutraler Platzhalter („noch nicht vermessen"). Das Badge blockiert das Rendern der Karte **nie**.
10. Eine **Aufschlüsselung** (Tooltip/Detail am Badge) zeigt die drei Buckets **Arbeitsstand** · **.git** · **Abhängigkeiten/Artefakte** je menschenlesbar und nennt die **Summe = Gesamt**. Eine **Aktualisieren**-Aktion je Karte stößt die Neu-Messung an und spiegelt „läuft"- und „aktualisiert"-Zustand. Alle Zahlen **textlich** (nicht nur über Farbe).
11. Ist `gitWarning` gesetzt, zeigt die Karte einen **dezenten, textlichen** Warnhinweis (Git-Blähungs-Frühwarnung), a11y-zugänglich (nicht nur farblich), **ohne** Aktion/Push.

## Acceptance-Kriterien
- **AC1** — `RepoSizeScanner` vermisst einen Klon (aufgelöst über die geteilte Workspace-Root-Auflösung) und liefert `{ total, git, artifacts, workspace }` in Bytes gemäß der Rest-+-feste-Liste-Definition: `git` = Top-Level-`.git`; `artifacts` = rekursive Summe aller Verzeichnisse mit Basisname ∈ {`node_modules`,`build`,`dist`,`.next`,`coverage`,`.claude/worktrees`} an beliebiger Tiefe; `workspace` = Gesamt − `git` − `artifacts`; `total` = `git`+`artifacts`+`workspace` = voller Klon-Ordner. Keine Doppelzählung (ein Artefakt-Verzeichnis wird als Ganzes zugeordnet, nicht zusätzlich in `workspace` durchlaufen). Ein `.git` **innerhalb** `.claude/worktrees` zählt zu `artifacts`, nicht zu `git`. *(1,2)* (Testbar: ein Fixture-Klon mit bekanntem Layout ergibt die erwartete Drei-Bucket-Aufteilung, deren Summe dem vollen Verzeichnis-Walk entspricht.)
- **AC2** — **Pfad-/Symlink-Schutz:** Der Scan-Zielpfad liegt strikt innerhalb des Effektivwerts `WORKSPACE_DIR` (realpath-Check); eine Referenz mit `..`, absolutem Pfad oder Symlink-Flucht → Abweisung ohne Walk außerhalb des Mounts. Beim rekursiven Walk werden Symlinks **nicht verfolgt** (kein Betreten des Ziels) → keine Flucht, keine Endlosschleife, keine Doppelzählung. *(3,4)* (Testbar: ein Symlink im Klon, der aus `WORKSPACE_DIR` herauszeigt, verändert die Summe nicht und wird nicht traversiert; eine traversierende Slug-Eingabe scannt nichts außerhalb.)
- **AC3** — `RepoSizeStore` (persistiert unter `${CRED_STORE_DIR}/repo-sizes.json`, atomarer tmp+rename-Schreibzugriff, `0600`): `record(repoSlug, {total,git,artifacts,workspace})` stempelt `measuredAt` (ISO) und schreibt atomar; `get(repoSlug)`/`list()` liefern die letzten bekannten Werte inkl. `measuredAt`. Der Store-Schlüssel ist ein Slug (kein per-Request-Dateipfad daraus). Werte überstehen einen Server-Neustart; fehlt `${CRED_STORE_DIR}` → In-Memory-Degradation ohne Crash. *(5)*
- **AC4** — **Non-blocking:** Die Messung läuft ausschließlich asynchron (Hintergrund-Job); sie wird **nie** synchron im Request-Pfad eines Lese-Endpunkts (`GET /api/workspace/repos`, Größen-Read-Endpunkt) ausgeführt. Ein Lese-Request liefert **sofort** den letzten bekannten Wert (oder „nie vermessen"), unabhängig von einem in-flight-Scan. *(6)* (Testbar: der Read-Endpunkt antwortet ohne auf einen laufenden/nie-gelaufenen Scan zu warten.)
- **AC5** — **Auslösung + Dedup + Degradation:** Ein Pro-Klon-Refresh-Trigger startet eine Hintergrund-Messung; beim Workspace-Scan wird für einen Klon mit fehlendem oder älter-als-Staleness-Grenze (Default 24 h) Wert automatisch eine Hintergrund-Messung angestoßen (non-blocking). Höchstens **eine** Messung je Klon gleichzeitig (Dedup/Lock); ein zweiter Trigger während eines laufenden Scans ist No-op/koalesziert. Ein Scan-Fehler für einen Klon lässt die übrigen unberührt und den letzten bekannten Wert intakt. *(7)*
- **AC6** — **Read-Endpunkt:** `GET /api/workspace/repo-sizes[?repo=<slug>]` → `200 { sizes: [{ repo, total, git, artifacts, workspace, measuredAt, gitWarning }] }` mit den letzten bekannten Werten je Klon (`measuredAt: null` / Eintrag fehlt, wenn nie vermessen). Read-only, hinter AccessGuard; **keine** absoluten Host-Pfade/Secrets in der Response; `?repo` traversal-neutral (reiner Filter-Schlüssel, kein Dateizugriff pro Request). *(6,8)*
- **AC7** — **Refresh-Endpunkt:** `POST /api/workspace/repo-sizes/refresh` Body `{ repo: <slug> }` startet eine Hintergrund-Messung und antwortet **sofort** (`202`/`200`, non-blocking). Ungültiger/unbekannter/traversierender Slug → `4xx` ohne Dateiwirkung außerhalb des Mounts; hinter AccessGuard. Concurrency-Dedup je Klon gemäß AC5. *(6,7)*
- **AC8** — **Schwellwert-Frühwarnung:** Die `.git`-Warngrenze ist über die Env `GIT_SIZE_WARN_MB` (Default 500 MB) konfigurierbar; überschreitet der `git`-Bucket die wirksame Grenze, trägt die Größen-Nutzlast des Klons `gitWarning: true` (sonst `false`). Reine Info — keine Mutation, kein Push. *(8)* (Testbar: `git`-Bucket über/unter der wirksamen Grenze setzt das Flag korrekt; eine geänderte Env verschiebt die Schwelle.)
- **AC9** — **Frontend-Badge:** Jede Projekt-Karte zeigt ein menschenlesbares Gesamt-Größen-Badge (MB/GB) mit letztem bekanntem Wert + Alter (relativ + absoluter Zeitstempel im `title`); nie vermessen → neutraler Platzhalter. Das Badge blockiert das Karten-Rendern nie. *(9)*
- **AC10** — **Frontend-Aufschlüsselung + Aktualisieren:** Ein Tooltip/Detail am Badge zeigt die drei Buckets (Arbeitsstand | .git | Abhängigkeiten/Artefakte) je menschenlesbar und nennt die Summe = Gesamt. Eine Pro-Karte-„Aktualisieren"-Aktion ruft `POST /api/workspace/repo-sizes/refresh` und spiegelt „läuft"/„aktualisiert"-Zustand. Zahlen textlich (nicht nur farblich). *(10)*
- **AC11** — **Frontend-Warnhinweis:** Bei `gitWarning: true` zeigt die Karte einen dezenten, **textlichen** Warnhinweis (Git-Blähungs-Frühwarnung), a11y-zugänglich (nicht nur über Farbe), ohne Aktion/Push. *(11)*

## Verträge

### Endpunkte
- **GET `/api/workspace/repo-sizes[?repo=<slug>]`** (read-only, hinter AccessGuard) → `200 { sizes: [{ repo, total, git, artifacts, workspace, measuredAt: string|null, gitWarning: boolean }] }`. Alle Größen in **Bytes** (menschenlesbare Formatierung im Frontend). Secret-/pfad-frei. `?repo` = reiner Filter-Schlüssel.
- **POST `/api/workspace/repo-sizes/refresh`** (mutierend im Sinne „startet Job", non-blocking) — Body `{ repo: string }` (Slug, **kein** freier Pfad):
  - **202/200** `{ repo, status: "scheduled"|"running" }` — Hintergrund-Messung angestoßen (oder bereits laufend, koalesziert).
  - **4xx** bei Validierungs-/Traversal-Fehler bzw. unbekanntem Klon (`404`).
  - **403** ohne gültigen Access-Nachweis.

### Boundaries / Wiederverwendung
- **`RepoSizeScanner`** (neu, `src/RepoSizeScanner.js`) — rekursiver, symlink-sicherer Verzeichnis-Scan mit Drei-Bucket-Zuordnung; nutzt **dieselbe** geteilte Workspace-Root-Auflösung + Traversal-/Symlink-Boundary wie `WorkspaceScanner`/`WorkspaceMutator` (`src/workspacePath.js`), **nicht** direkt `process.env.WORKSPACE_DIR`.
- **`RepoSizeStore`** (neu, `src/RepoSizeStore.js`) — Datei `${CRED_STORE_DIR}/repo-sizes.json`, atomarer tmp+rename-Schreibzugriff, Muster `DrainReportStore`/`TickerSettingsStore` (`src/DrainReportStore.js`). Hält je Klon **einen** letzten Messwert (kein Verlauf).
- **Async-Orchestrierung** (neu — schmaler `RepoSizeService`/Job-Koordinator) — Dedup/Lock je Klon (höchstens ein in-flight Scan), Staleness-Prüfung, Auto-Trigger-Naht am Workspace-Scan; degradierend (Scan-Fehler non-fatal). Wo genau die Auto-Trigger-Naht andockt (im `workspaceReposRouter`-Read-Pfad, ausschließlich Job-Start ohne Blockieren), ist Architektur-Detail — bindend: **nie** synchron im Request-Pfad.
- **Router** — neuer thin Router `src/routers/repoSizes.js` (Muster `src/routers/ticker.js`/`src/routers/drainReports.js`, `create(deps)` + `order`) für die zwei Endpunkte; Verdrahtung in `server.js`.
- **Frontend** — Größen-Badge + Aufschlüsselung + Alter + Aktualisieren-Aktion + Warnhinweis in der Projekt-Karten-Darstellung der Fabrik-Übersicht (`client/src/FactoryView.jsx` / Repo-Übersicht, [[projekt-cockpit-navigation]] V1). Konsumiert `GET/POST /api/workspace/repo-sizes*`.
- **Konfiguration** — `GIT_SIZE_WARN_MB` (Env, Default 500), nicht-geheim, pro Request/Job gelesen. Effektiver Workspace-Root = konfiguriert ?? Env `WORKSPACE_DIR` ([[workspace-path-config]]).

## Edge-Cases & Fehlerverhalten
- Klon nie vermessen → Read liefert Eintrag mit `measuredAt: null` (oder fehlt); Frontend zeigt „noch nicht vermessen"; Auto-Trigger beim nächsten Scan.
- `${CRED_STORE_DIR}` nicht gesetzt → `RepoSizeStore` degradiert in-memory (Werte gehen bei Neustart verloren), **kein** Crash.
- Effektiver `WORKSPACE_DIR` nicht gesetzt/nicht existent → Read liefert `{ sizes: [] }`, Refresh `4xx`/`404`, kein Crash.
- Klon-Ordner wird **während** des Scans extern verändert/gelöscht (Race) → best-effort-Ergebnis oder sauberer Abbruch, letzter bekannter Wert bleibt intakt, kein Crash.
- Symlink im Klon, der aus `WORKSPACE_DIR` herauszeigt → nicht verfolgt, zählt nur als Link-Eintrag (AC2).
- Sehr großer Klon (langer Scan) → läuft im Hintergrund; Karte zeigt weiter den letzten Wert + Alter; kein blockierender Request (AC4).
- Zweiter Refresh-Klick während laufendem Scan → koalesziert (No-op), kein Doppel-Scan (AC5).
- `GIT_SIZE_WARN_MB` unlesbar/ungültig → Fallback auf Default 500, kein Crash.
- `?repo` mit Traversal/ungültigen Zeichen → reiner Filter-Schlüssel auf den geladenen Store-Inhalt, **kein** Dateizugriff pro Request; leere Liste oder `400`.

## NFRs
- **Sicherheit (Floor, hart):** Der Scan bleibt **strikt innerhalb** des Effektivwerts `WORKSPACE_DIR` (realpath-Check + Symlinks nicht verfolgt) — verhindert Datei-Enumeration/-Größenmessung außerhalb des gemounteten Workspace. Response/Store/Log enthalten **keine** absoluten Host-Pfade, Tokens oder Secrets (nur Slug + Byte-Zähler + `measuredAt`). Read- und Refresh-Endpunkt hinter AccessGuard.
- **Kosten/Performance:** die Messung ist **asynchron** und **gecacht** — **nie** blockierend im Request-Pfad (AC4); Dedup verhindert parallele Mehrfach-Scans desselben Klons; die Übersicht rendert sofort mit dem letzten bekannten Wert.
- **Robustheit:** ein Scan-/Store-Fehler ist **non-fatal** (degradierend) — er crasht weder den Workspace-Scan noch den Server; der letzte bekannte Wert bleibt erhalten.
- **ADR-005-Linie:** die Größen-Ablage ist eine **Betreiber-nahe, größenbegrenzte Beobachtbarkeits-Ablage** (ein Wert je Klon, Muster `DrainReportStore` unter `${CRED_STORE_DIR}`), **kein** Fabrik-/Domänen-State — Source of Truth für die Klone bleibt das Dateisystem (live), der Store ist nur ein Mess-Cache.
- **A11y:** Badge/Aufschlüsselung/Alter/Warnhinweis textlich (nicht nur farblich), Aktualisieren-Button beschriftet, Fokus-/Status-Führung; Warnhinweis programmatisch zugeordnet.

## Nicht-Ziele
- **Keine** GitHub-API-Größenmessung (die liefert nur den `.git`-Pack, nicht Arbeitsstand/`node_modules`) — bewusst lokaler Verzeichnis-Scan.
- **Kein** Push/`git gc`/keine Repo-Verkleinerung — der Schwellwert ist reine **UI-Frühwarnung** (kein Eingriff).
- **Kein** Größen-Verlauf/Trend — der Store hält **einen** letzten Wert je Klon (kein Zeitreihen-Store).
- **Kein** eigenes Settings-UI für die Schwelle in v1 — konfigurierbar via Env (Owner-Default; ein meta-Block-Feld wäre eine Folge-Anforderung).
- **Keine** Messung von Repos außerhalb des Workspace-Mounts / von nicht geklonten Org-Repos.

## Abhängigkeiten
- [[workspace-repos]] (`WorkspaceScanner`/`WorkspaceMutator`, Traversal-/Symlink-Schutzlinie, Klon-Liste als Eingabematerial) · [[workspace-path-config]] (Effektivwert `WORKSPACE_DIR` = konfiguriert ?? Env; geteilte Auflösung) · [[projekt-cockpit-navigation]] (Fabrik-Übersicht / Projekt-Karten, in denen das Badge sitzt) · [[drain-completion-report]] (Muster für den persistierten, zeitgestempelten Store unter `${CRED_STORE_DIR}`) · [[access-and-guardrails]] (AccessGuard vor den Endpunkten).
