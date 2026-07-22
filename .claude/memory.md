> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-093 „Red-Team-Scan pro Container" ist story-seitig fertig: S-401..S-406 und
S-408 gelandet auf feature/F-093 (S-407 gehört zu F-094 Ausbaustufe 2, nicht
zu F-093). Die eigenständige Red-Team-Kachel ist abgebaut, der
Container-Knopf ist der einzige Einstieg. Es folgt der Feature-Abschluss:
board-ship.sh --merge-feature feature/F-093 (Push→main mit echter CI +
Secret-Gate), Rollout und ID-Block-Freigabe gebündelt durch den Drain.

## Letzte Arbeiten
- S-408 / Kachel-Rückbau (AC23): RedTeamView.jsx, redTeamRouter.js,
  routers/redTeam.js, viewRegistry-Eintrag + Kachel-Tests entfernt;
  imageRepoName() lokal in vpsContainerScanRouter.js; red-team-tile.md
  superseded. Zählungen: 53 Router, 6 Tiles. EP 4/4 (Punktlandung).
- S-404 / Verlauf-Aufklapper (AC14/AC15): RedTeamScanHistory.jsx, Board-Status
  live via GET /api/board/projects/:slug. EP 4/4.
- S-406 / Befundliste (AC18-AC20): Sammel-Button + Rückfrage. EP 7 vs. 4.
- S-405 / Befunde→Board-Übertrag (AC16/AC17): POST scans/:scanId/board,
  idempotent. EP 4.0/4.0.
- S-403 / Scan-Knopf + Panel (AC10-AC13,AC21): RedTeamScanPanel.jsx. EP 7/5.25.
- S-402 / ScanResultStore (AC7-AC9): dateibasiert, Cap 30/App. EP 4.0/4.0.
- S-401 / Scan-Endpunkt (AC1-AC6,AC22): vpsContainerScanRouter. EP 6.5/5.25.

## Offene Fäden
- Findings-Extraktion bleibt offene Folge-Naht (keiner Story zugeordnet):
  HeadlessRunnerCore exponiert Runner-Ausgabe nicht → record() wird nirgends
  mit echten Findings aufgerufen; Verlauf/Befundliste/Ampel ohne echte Daten.
  Der künftige record()-Aufrufer muss repoSlug mitgeben. Owner/requirement.
- Landen bei --parent weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree (S-400) statt tar-Workaround.
