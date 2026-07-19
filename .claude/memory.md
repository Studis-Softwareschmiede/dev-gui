> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
Board ist leer — S-383/S-384 (Obsidian-Ingest-cwd-Defekt, F-050 reopened→Done)
sind gelandet: Der headless Ingest («Strukturiert starten») läuft jetzt im
Ziel-Projekt-Repo (targetProjectSlug, Confinement wie Drain-Router) mit dem
Notiz-Ordner nur als Argument; die GUI hat eine Ziel-Projekt-Auswahl aus der
Workspace-Liste + new-project-Hinweis bei leerer Liste; Fehlertexte
unterscheiden «kein JSON-Ausgang» von «Fragenkatalog defekt». Auslöser war
der erste Research-App-Pilot (19.07.): Ingest im Vault-Ordner → Freitext-
Abbruch → irreführende Sammelmeldung. Rollout des neuen Images: siehe
Letzte Arbeiten. agent-flow-seitig ist pm-import (PRs #389–#391) komplett —
pm-skills-Artefakte werden feldgenau eingezogen.

## Letzte Arbeiten
- S-383 / Runner+Router: start(targetRepoPath,{noteFolderPath}), 400/404-
  Confinement, BrokenCatalogError-Split (AC8/AC9/AC12).
- S-384 / GUI: Ziel-Projekt-Select (GET /api/workspace/repos), Start-Gating,
  new-project-Hinweis, Resume-Matching um targetProjectSlug (AC10/AC11).
- S-385 (parallele Session) / RunStateReader ENOENT still + CI
  workflow_dispatch.
- S-380/S-381 / Obsidian-Projekt-Unterordner persistierbar (F-089,
  Revision 0693b6d).

## Offene Fäden
- Reviewer-Suggestion S-383: einmaliger supervised Live-Smoke des echten
  from-notes-Laufs mit neuem cwd/argv (Unit-Tests fanden den cwd-Defekt
  nicht) — ideal beim ersten Research-App-Ingest.
- Für den Research-App-Ingest fehlt noch das Ziel-Repo (new-project) —
  Auswahl in der GUI zeigt nur bestehende Workspace-Projekte.
- Retro: Issue #371 (board-ship.sh worktree-tauglich) bleibt offen.
- Reviewer-Suggestions F-088 (Kosmetik) + S-384 (AC11-Hinweis verlinken,
  aria-label im loading-Fenster) offen.
