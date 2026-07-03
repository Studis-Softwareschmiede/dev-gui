---
id: bereichs-migration-dev-gui
title: Bereichs-Migration dev-gui — 59 Features → 11 Bereiche, Storys umhängen, erledigte archivieren, 124 Specs area-stempeln
status: active
area: board
version: 1
---

# Spec: Bereichs-Migration dev-gui  (`bereichs-migration-dev-gui`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Einmalige **Daten-Migration** des dev-gui-Boards vom Auftrags-Feature-Modell auf **Bereichs-Features** ([[bereichs-modell]]): (1) `board/areas.yaml` mit der vom Owner freigegebenen **initialen 11er-Bereichsliste** seeden, (2) die **59 Bestands-Features** auf die 11 Bereiche **mappen** (`feature.area` stempeln), (3) **Storys umhängen** (`story.area` aus dem Bereich des Parent-Features setzen), (4) **erledigte (terminale) Storys archivieren** ([[board-storys-archivieren]]), (5) die **124 Bestands-Specs** mit dem `area`-Frontmatter **stempeln**. Alles als **EIN PR zur Owner-Freigabe**. **Unklare Zuordnungen** werden als **Fragenkatalog** ausgewiesen — **nicht geraten**.

> **Prinzip: kein Raten.** Wo eine Feature→Bereich- oder Spec→Bereich-Zuordnung nicht eindeutig ist, wird der Eintrag **nicht** zwangszugeordnet, sondern in einen **Fragenkatalog** aufgenommen und **unangetastet** gelassen (bleibt bereichslos). Der Owner entscheidet die offenen Fälle; ein Folgelauf trägt sie nach.

## Kontext / Designentscheidungen
- **Realisierung:** ein **idempotentes Migrations-Skript** (z.B. `scripts/migrate-areas.mjs`, ESM, ohne Netz/Secrets) mit einer **eingebetteten, versionierten Zuordnungstabelle** (Feature-ID → Bereich, Spec-ID → Bereich) und einem **„unklar"-Set**. Es schreibt ausschließlich in den Working-Tree (Board-YAMLs + Spec-Frontmatter) und erzeugt **keinen** Laufzeit-Effekt im Server.
- **Ein PR, Git-reversibel:** die Migration läuft auf einem Branch, das Ergebnis geht als **ein** PR an den Owner; Rückgängigmachen = PR nicht mergen / Revert. Kein Hard-Delete, kein Datenverlust (Archivieren = In-place-Flag, [[board-storys-archivieren]]).
- **Schreib-Boundaries wiederverwenden:** Bereichs-Anlage über `AreaWriter` ([[bereichs-modell]]), Story-Archiv über `BoardWriter.archiveDoneStories` ([[board-storys-archivieren]]); das Skript orchestriert diese, statt eigene Schreibpfade zu erfinden. Das `area`-Stempeln von Features/Storys/Specs erfolgt als byte-schonender Frontmatter-/Feld-Patch (Muster `patchTopLevelFields`).
- **Idempotenz:** ein zweiter Lauf ändert bereits gestempelte Einträge nicht (kein Doppel-Stempel), seedet vorhandene Bereiche nicht erneut, archiviert bereits archivierte Storys nicht erneut.

## Verhalten

### V1 — `areas.yaml` mit der initialen 11er-Liste seeden (idempotent)
Das Skript legt `board/areas.yaml` (falls fehlend) mit **genau** diesen 11 Bereichen an (Reihenfolge = `order`):
1. `board` — Kanban, Storys, Filter, Archiv, Live-Push
2. `fabrik-arbeiten` — Cockpit, Drains, Befehls-Auslösung, Abschlussberichte
3. `nachtwaechter` — Nacht-Drain, Auto-Retro, Budget-Schutz
4. `einstellungen` — Settings-Panel, Credentials, Workspace-Pfad
5. `vps` — Server-Verwaltung, SSH-Keys/-Terminal
6. `deployment` — Deploy-Orchestrierung, Cloudflare, Container
7. `benachrichtigungen` — ntfy, Events, Meldeklassen
8. `obsidian` — Vault, Ingest, Sync, Fragenkatalog
9. `sicherung` — Backup, Restore
10. `spezifikation` — Doku-Ansicht, Reconcile
11. `retro-lernen` — RetroView, Trends, Verbesserungs-Board
Existiert `areas.yaml` bereits, werden fehlende der 11 Bereiche ergänzt, vorhandene unangetastet gelassen (idempotent).

### V2 — 59 Features → Bereich mappen (`feature.area`)
Für jedes der 59 Bestands-Features setzt das Skript `area: <area-id>` gemäß der Zuordnungstabelle. **Klare** Zuordnungen werden gestempelt. **Unklare** Features (nicht eindeutig einem Bereich zuordenbar) werden **nicht** gestempelt (bleiben bereichslos) und in den Fragenkatalog (V6) aufgenommen. Byte-schonender Feld-Patch, atomarer Write.

### V3 — Storys umhängen (`story.area` aus dem Parent-Feature)
Jede Story erhält `area: <area-id>` = der Bereich ihres Parent-Features (aus V2). Storys, deren Parent-Feature bereichslos blieb (V2-unklar), bleiben bereichslos (folgen der Feature-Entscheidung im Folgelauf). Verwaiste Storys (`_orphaned`, kein Parent) bleiben bereichslos und werden im Fragenkatalog vermerkt. Byte-schonend, atomar.

### V4 — Erledigte (terminale) Storys archivieren
Nach dem Umhängen ruft das Skript den Story-Archivpfad ([[board-storys-archivieren]] V2, `BoardWriter.archiveDoneStories`) auf: alle Storys mit `status` ∈ {`Done`,`Verworfen`} und noch nicht archiviert erhalten `archived: true` + `archived_at`. Bereichs-Kacheln bleiben sichtbar (kein Feature-Archiv). Idempotent.

### V5 — 124 Bestands-Specs `area`-stempeln
Für jede Bestands-Spec unter `docs/specs/*.md` (ohne `_template.md`) setzt das Skript das Frontmatter-Feld `area: <area-id>` gemäß der Spec→Bereich-Zuordnungstabelle. **Klare** Zuordnungen werden gestempelt; **unklare** Specs bleiben ungestempelt (bereichslos) und gehen in den Fragenkatalog (V6). Bereits gestempelte Specs (z.B. die neuen Specs dieser Anforderung) werden **nicht** überschrieben (idempotent). Frontmatter-Patch byte-schonend (nur `area:` ergänzen, übrige Zeilen unverändert), atomarer Write.

### V6 — Fragenkatalog für unklare Zuordnungen (statt Raten)
Das Skript erzeugt einen **maschinen- und menschenlesbaren Fragenkatalog** aller nicht eindeutig zugeordneten Einträge — je Eintrag: `{ kind: 'feature'|'story'|'spec', id, title, kandidaten?: [area-id…], grund }`. Der Katalog wird als Artefakt ausgegeben (z.B. `docs/migration/areas-open-questions.md` **und/oder** JSON), im PR-Text zusammengefasst und **nicht** durch eine geratene Zuordnung ersetzt. Die betroffenen Einträge bleiben bereichslos, bis der Owner entscheidet.

### V7 — Ein PR, idempotent, reversibel
Alle Änderungen (areas.yaml, Feature-/Story-Stempel, Story-Archiv, Spec-Frontmatter, Fragenkatalog-Artefakt) landen auf **einem** Branch und gehen als **ein** PR an den Owner. Ein erneuter Lauf auf dem migrierten Stand ist ein **No-Op** (idempotent). Kein Datenverlust (Archiv = In-place-Flag; Stempel = additiv). `board/board.yaml`-Referenzlisten werden **nicht** umgebaut.

## Acceptance-Kriterien

- **AC1** — Das Migrations-Skript seedet `board/areas.yaml` mit **genau** den 11 Bereichen (IDs + Reihenfolge wie V1); existiert die Datei, ergänzt es fehlende Bereiche und lässt vorhandene unangetastet (idempotent). *(V1)*
- **AC2** — Jedes der 59 Features erhält `area: <area-id>` gemäß Zuordnungstabelle; **unklare** Features bleiben ungestempelt und stehen im Fragenkatalog; Schreiben byte-schonend + atomar; kein Raten. *(V2)*
- **AC3** — Jede Story erhält `area` aus dem Bereich ihres Parent-Features; Storys unter bereichslosem/unklarem oder fehlendem Parent bleiben bereichslos (letztere im Fragenkatalog vermerkt); byte-schonend + atomar. *(V3)*
- **AC4** — Nach dem Umhängen sind alle terminalen (`Done`/`Verworfen`), noch nicht archivierten Storys über `BoardWriter.archiveDoneStories` ([[board-storys-archivieren]]) archiviert (`archived: true` + `archived_at`); Bereichs-Kacheln/Features bleiben sichtbar; idempotent. *(V4)*
- **AC5** — Jede Bestands-Spec unter `docs/specs/*.md` (ohne `_template.md`) erhält `area: <area-id>` im Frontmatter gemäß Zuordnungstabelle; **unklare** Specs bleiben ungestempelt (Fragenkatalog); bereits gestempelte Specs werden nicht überschrieben; Frontmatter-Patch byte-schonend + atomar. *(V5)*
- **AC6** — Das Skript erzeugt einen maschinen- und menschenlesbaren **Fragenkatalog** aller nicht eindeutig zugeordneten Einträge (`kind`, `id`, `title`, `kandidaten?`, `grund`) als Artefakt + PR-Zusammenfassung; die betroffenen Einträge bleiben **bereichslos** (kein geratener Stempel). *(V6)*
- **AC7** — Idempotenz + Reversibilität: ein zweiter Lauf auf dem migrierten Stand ist ein No-Op (kein Doppel-Stempel, kein erneutes Seeden/Archivieren); alle Änderungen sind additiv/reversibel (kein Hard-Delete), `board/board.yaml`-Referenzlisten unverändert; das Ergebnis geht als **ein** PR an den Owner. *(V7)*
- **AC8** — Security/Robustheit: das Skript arbeitet nur im Working-Tree (kein Netz, keine Secrets, kein Laufzeit-Server-Effekt), nutzt die bestehenden Schreib-Boundaries (`AreaWriter`, `BoardWriter`) bzw. byte-schonende Frontmatter-Patches, schreibt atomar (tmp+rename) und bricht bei einzelnen nicht-patchbaren Dateien nicht den Gesamtlauf ab (best effort + Log, kein Datenverlust). *(alle)*

## Verträge

- **Migrations-Skript** (z.B. `scripts/migrate-areas.mjs`): idempotenter One-Shot; liest Board-YAMLs + `docs/specs/*.md`; schreibt `board/areas.yaml`, `feature.area`/`story.area`, Story-`archived`-Flags, Spec-`area`-Frontmatter, Fragenkatalog-Artefakt. Kein Netz, keine Secrets.
- **Zuordnungstabelle (versioniert, im Skript/Config):** `{ features: { 'F-0XX': 'area-id' | 'UNKLAR' }, specs: { '<spec-slug>': 'area-id' | 'UNKLAR' } }`. `UNKLAR` → Fragenkatalog, kein Stempel.
- **Fragenkatalog-Artefakt:** `docs/migration/areas-open-questions.md` (+ optional JSON) — Liste `{ kind, id, title, kandidaten?, grund }`.
- **Wiederverwendet:** `AreaWriter` (Seed/Anlage, [[bereichs-modell]]), `BoardWriter.archiveDoneStories` (Archiv, [[board-storys-archivieren]]).
- **YAML-/Frontmatter-Felder (additiv):** `feature.area`, `story.area`, `story.archived`/`archived_at`, Spec-Frontmatter `area`.

## Edge-Cases & Fehlerverhalten
- **Feature nicht eindeutig zuordenbar** → `UNKLAR`, bereichslos, Fragenkatalog (mit Kandidaten + Grund).
- **Story unter unklarem/fehlendem Parent** → bereichslos; verwaiste (`_orphaned`) Storys im Fragenkatalog vermerkt.
- **Spec nicht eindeutig zuordenbar** → `UNKLAR`, bereichslos, Fragenkatalog.
- **Bereits (teil-)migrierter Stand** → idempotenter No-Op für bereits gestempelte/archivierte/geseedete Einträge.
- **Einzelne Datei nicht patchbar** → übersprungen + geloggt, Gesamtlauf läuft weiter (best effort), kein Datenverlust.
- **`areas.yaml` existiert mit abweichenden Bereichen** → fehlende der 11 ergänzt, vorhandene (auch zusätzliche) unangetastet; keine Löschung.

## NFRs
- **Sicherheit (Floor):** kein Netz, keine Secrets, kein Laufzeit-Server-Effekt; nur Working-Tree; atomare Writes; keine Secrets in Log/PR.
- **Datenintegrität:** additiv/reversibel; kein Hard-Delete; `estimator`/`retro` lesen Storys weiter am Ort (Archiv = In-place-Flag).
- **Nachvollziehbarkeit:** ein PR, Fragenkatalog als Artefakt, Zuordnungstabelle versioniert.

## Nicht-Ziele
- **Automatisches Beantworten** unklarer Zuordnungen (bewusst: Fragenkatalog statt Raten).
- **Umbau der `board/board.yaml`-Referenzlisten** (Stempel + Flags statt Re-Parenting der Referenzlisten).
- **Neu-Definition** des `areas.yaml`-/`area`-Schemas (agent-flow-Schema; hier nur Konsum).
- **Löschen** von Features/Storys/Specs (nur Stempeln + Story-Archiv).
- **Nachziehen der offenen Fälle** in demselben PR (Folgelauf nach Owner-Entscheidung).

## Abhängigkeiten
- [[bereichs-modell]] (`AreaWriter`, `areas.yaml`, `feature.area`/`story.area`) · [[board-storys-archivieren]] (`BoardWriter.archiveDoneStories`, terminale Storys) · [[spec-bereich-filter]] (`area`-Frontmatter, das hier gestempelt wird) · [[projekt-spezifikation-anzeige]] (`DocsReader` liest die gestempelten Specs).
- **dev-gui:** neues `scripts/migrate-areas.mjs`, `src/AreaWriter.js`, `src/BoardWriter.js` (`archiveDoneStories`), Board-/Spec-Dateien im Working-Tree.
- **agent-flow (textueller Verweis, kein depends):** Schema-Specs zu `areas.yaml` / Bereichs-Features + `area`-Feld/Frontmatter (Repo agent-flow) — definieren das Zielschema dieser Migration.
