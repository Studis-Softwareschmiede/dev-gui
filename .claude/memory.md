> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-093 „Red-Team-Scan pro Container" läuft (Spec red-team-scan-per-container,
Stories S-401..S-408, Feature-Branch feature/F-093). Gelandet: S-401 (Endpunkt),
S-402 (ScanResultStore + Verlauf + Ampel), S-403 (Scan-Knopf + Panel),
S-405 (Befunde→Board-Übertrag-Endpunkt AC16/AC17). Bereite Stories: S-404
(Verlauf-UI) und S-406 (Client-Befundliste AC18-AC20, jetzt entsperrt) sowie
S-408; S-406 baut gegen den S-405-Endpunkt. Kein gemeinsamer Hot-Spot zwischen
S-404 und S-406 (Verlauf-Anzeige vs. Übertrag-UI) — mit Vorsicht parallelisierbar.

## Letzte Arbeiten
- S-405 / Befunde→Board-Übertrag (AC16/AC17): POST scans/:scanId/board legt
  ausgewählte Befunde via BoardWriter.createIdea() an (idempotent je
  finding.boardId), 400/404/422; ScanResultStore.recordBoardTransfer()
  schreibt boardId/boardItemIds zurück. 1 Iteration, Review+Test PASS ohne
  Befunde. EP 4.0/4.0 (Vorhersage exakt).
- S-403 / Scan-Knopf + Panel (AC10-AC13,AC21): RedTeamScanPanel.jsx,
  ContainerRow-Knopf managed+running; Ampel nur bei echten Daten. EP 7 vs. 5.25.
- S-402 / ScanResultStore (AC7-AC9): dateibasiert, atomar, 0600, Cap 30/App;
  2 Verlauf-GET-Endpunkte (scanId≡jobId), deterministische Ampel. EP 4.0/4.0.
- S-401 / Pro-Container-Scan-Endpunkt (AC1-AC6,AC22): vpsContainerScanRouter
  + Auto-Discovery, 409-Guard via mapStatus. EP 6.5 vs. 5.25.

## Offene Fäden
- Findings-Extraktion bleibt offene Folge-Naht (keiner Story zugeordnet):
  HeadlessRunnerCore exponiert Runner-Ausgabe nicht → record() wird nirgends
  mit echten Findings aufgerufen. Übertrag/Verlauf/Ampel bleiben ohne echte
  Daten. Der künftige record()-Aufrufer muss repoSlug (≡ ziel aus AC1)
  mitgeben. Braucht Core-Änderung + Parser-Vertrag — Owner/requirement.
- phase ist coarse (direkt/fertig) — S-404-Verlauf-UI muss damit rechnen;
  activeJobs-Maps ohne Pruning (bewusst).
- Landen bei --parent weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Feature-Abschluss F-093: am Ende board-ship.sh --merge-feature (Push→main,
  echte CI+Secret-Gate) + ID-Block-Freigabe gebündelt.
