> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-093 „Red-Team-Scan pro Container" läuft (Spec red-team-scan-per-container,
Stories S-401..S-408, Feature-Branch feature/F-093). Gelandet: S-401 (Endpunkt),
S-402 (ScanResultStore + Verlauf + Ampel), S-403 (Scan-Knopf + Panel),
S-405 (Befunde→Board-Übertrag), S-406 (Befundliste + Sammel-Button),
S-404 (Verlauf-Aufklapper + Board-Rückverfolgung live). Verbleibt: S-408
(Kachel-Rückbau, ready); S-407 nicht in der Ready-Liste. Nächster Lauf: S-408.

## Letzte Arbeiten
- S-404 / Verlauf-Aufklapper (AC14/AC15): RedTeamScanHistory.jsx, Liste +
  Detail inline, Board-Status live via GET /api/board/projects/:slug (kein
  neuer Backend-Endpunkt); AMPEL_LABEL/STYLE aus RedTeamScanPanel reused.
  1 Iteration, Review+Test PASS ohne Befunde. EP 4/4 (Punktlandung).
- S-406 / Befundliste (AC18-AC20): Checkboxen vorgehakt, Schnellwahl,
  sticky Sammel-Button mit Rückfrage, Nach-Übertrag gesperrt. EP 7 vs. 4.
- S-405 / Befunde→Board-Übertrag (AC16/AC17): POST scans/:scanId/board,
  idempotent je finding.boardId; recordBoardTransfer(). EP 4.0/4.0.
- S-403 / Scan-Knopf + Panel (AC10-AC13,AC21): RedTeamScanPanel.jsx. EP 7/5.25.
- S-402 / ScanResultStore (AC7-AC9): dateibasiert, Cap 30/App. EP 4.0/4.0.
- S-401 / Scan-Endpunkt (AC1-AC6,AC22): vpsContainerScanRouter. EP 6.5/5.25.

## Offene Fäden
- Findings-Extraktion bleibt offene Folge-Naht (keiner Story zugeordnet):
  HeadlessRunnerCore exponiert Runner-Ausgabe nicht → record() wird nirgends
  mit echten Findings aufgerufen; Verlauf/Befundliste/Ampel ohne echte Daten.
  Der künftige record()-Aufrufer muss repoSlug mitgeben. Owner/requirement.
- S-408-Rückbau: AMPEL_LABEL/AMPEL_STYLE-Exporte in RedTeamScanPanel.jsx
  werden von RedTeamScanHistory gebraucht — nicht mit abräumen; prüfen, ob
  vpsContainerScanRouter Logik aus redTeamRouter importiert oder kopiert hat.
- Landen bei --parent weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Feature-Abschluss F-093: am Ende board-ship.sh --merge-feature (Push→main,
  echte CI+Secret-Gate) + ID-Block-Freigabe gebündelt.
