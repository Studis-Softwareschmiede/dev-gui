> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-093 „Red-Team-Scan pro Container" läuft (Spec red-team-scan-per-container,
Stories S-401..S-408, Feature-Branch feature/F-093). Gelandet: S-401 (Endpunkt),
S-402 (ScanResultStore + Verlauf + Ampel), S-403 (Scan-Knopf + Panel),
S-405 (Befunde→Board-Übertrag-Endpunkt), S-406 (Client-Befundliste mit
Vorauswahl + Sammel-Button, AC18-AC20). Bereit: S-408; S-404/S-407 laut
board ready aktuell nicht in der Ready-Liste. Nächster Lauf nimmt S-408.

## Letzte Arbeiten
- S-406 / Befundliste (AC18-AC20): Checkboxen vorgehakt, Schnellwahl
  Alle/Keine/Nur kritische, sticky Sammel-Button mit Rückfrage
  (alertdialog + Fokus), Nach-Übertrag gesperrt „→ aufs Board gelegt (ID)".
  2 Iterationen (Review: Touch-Target 44px, Fokus-Management). EP 7 vs. 4.
- S-405 / Befunde→Board-Übertrag (AC16/AC17): POST scans/:scanId/board,
  idempotent je finding.boardId; recordBoardTransfer(). EP 4.0/4.0.
- S-403 / Scan-Knopf + Panel (AC10-AC13,AC21): RedTeamScanPanel.jsx,
  Ampel nur bei echten Daten. EP 7 vs. 5.25.
- S-402 / ScanResultStore (AC7-AC9): dateibasiert, atomar, Cap 30/App,
  deterministische Ampel. EP 4.0/4.0.
- S-401 / Pro-Container-Scan-Endpunkt (AC1-AC6,AC22): vpsContainerScanRouter
  + Auto-Discovery, 409-Guard. EP 6.5 vs. 5.25.

## Offene Fäden
- Findings-Extraktion bleibt offene Folge-Naht (keiner Story zugeordnet):
  HeadlessRunnerCore exponiert Runner-Ausgabe nicht → record() wird nirgends
  mit echten Findings aufgerufen; Befundliste/Übertrag/Ampel bleiben ohne
  echte Daten. Der künftige record()-Aufrufer muss repoSlug mitgeben.
  Braucht Core-Änderung + Parser-Vertrag — Owner/requirement.
- Auswahl/Schnellwahl wirkt nur auf die 5 Kurzlisten-Befunde
  (MAX_FINDINGS_SHOWN, AC18-Präzisierung) — S-404-Verlauf-UI beachten.
- Landen bei --parent weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Feature-Abschluss F-093: am Ende board-ship.sh --merge-feature (Push→main,
  echte CI+Secret-Gate) + ID-Block-Freigabe gebündelt.
