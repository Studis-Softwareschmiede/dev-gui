> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
S-387/S-388 gelandet (20.07., Revision 2f35df8): Das Ziel-Projekt-Feld im
Obsidian-Ingest ist jetzt ein Kombifeld — bestehendes Projekt wählen ODER
«Neues Projekt erstellen» mit Namens-Eingabe (Slug-Vorschlag aus dem
Ordnernamen). Neuanlage läuft über POST /api/obsidian-ingest/ensure-target
(HeadlessNewProjectRunner via runWithAutoProvisioning/ADR-021, scaffoldOk-
Flag, checkMutationAuthz, APP_SLUG_RE nur im Anlage-Pfad, TOCTOU-fest);
die GUI pollt den Status und startet den Ingest erst bei ready, mit beim
Klick eingefrorener Start-Absicht. Parallel-Session baut S-389/S-390
(AC16–AC19, ehrliche Warteanzeige). Für den Research-App-Pilot existiert
das Repo research-app bereits (stack-neutral, obsidian_source gesetzt).

## Letzte Arbeiten
- S-388 / GUI-Kombifeld + ensure-Statusanzeige + Stale-Poll-Fix (AC10/AC15).
- S-387 / ensure-target-Endpunkt: 4 Review-Runden (Prompt-Injection-Guard,
  checkMutationAuthz, GPG-Naht scaffoldOk, TOCTOU) — EP 10.5 vs. 5.25.
- S-383/S-384 / Ingest-cwd-Fix (Ziel-Repo statt Vault-Ordner) + erste
  Ziel-Projekt-Auswahl; ausgerollt als be5ef44.
- S-385/S-386 (parallele Sessions) / RunStateReader-ENOENT, bw-Verzeichnis.

## Offene Fäden
- Supervised Live-Smoke des echten from-notes-Laufs (neuer cwd/argv) steht
  aus — ideal beim ersten Research-App-Ingest des Owners.
- scaffoldOk-Semantik: PerAppGpgProvisioningService liefert jetzt additives
  Flag — bei künftigen Aufrufer-Änderungen darauf stützen, nie auf result.
- Reviewer-Suggestions offen: Retry-Test nach 404-Rollback (Preparer),
  checkMutationAuthz/resolveWorkspaceRootDir-Dedup, Slug-Längenprüfung GUI.
- Retro: Issue #371 (board-ship.sh worktree-tauglich) bleibt offen.
