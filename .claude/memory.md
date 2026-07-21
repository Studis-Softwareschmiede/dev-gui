> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-093 „Red-Team-Scan pro Container" läuft (Spec red-team-scan-per-container,
Stories S-401..S-408, Feature-Branch feature/F-093). S-401 (Endpunkt),
S-402 (ScanResultStore + Verlauf + Ampel) und S-403 (Scan-Knopf +
Live-Fortschritts-Panel) sind gelandet. Bereite Stories: S-404 (Verlauf-UI)
und S-405 (Befunde→Board-Übertrag) — beide ohne gemeinsame Hot-Spot-Datei
mit Vorsicht parallelisierbar; S-406/S-408 warten auf deren Abschluss.

## Letzte Arbeiten
- S-403 / Scan-Knopf + Panel (AC10-AC13,AC21): RedTeamScanPanel.jsx neu,
  ContainerRow-Knopf nur managed+running; Ampel nur bei echten Daten, sonst
  „Befund-Erfassung noch nicht verfügbar". 2 Iterationen (1 Critical:
  record()-Platzhalter hätte alles „gruen" gemacht — entfernt). EP 7 vs. 5.25.
- S-402 / ScanResultStore (AC7-AC9): dateibasiert, atomar, 0600, Cap 30/App;
  2 Verlauf-GET-Endpunkte (scanId≡jobId), deterministische Ampel. EP 4.0/4.0.
- S-401 / Pro-Container-Scan-Endpunkt (AC1-AC6,AC22): vpsContainerScanRouter
  + Auto-Discovery, 409-Guard via mapStatus. EP 6.5 vs. 5.25.
- S-388 / GUI-Kombifeld Obsidian-Ingest + ensure-Statusanzeige (AC10/AC15).

## Offene Fäden
- Findings-Extraktion bleibt offene Folge-Naht (keiner Story zugeordnet):
  HeadlessRunnerCore exponiert Runner-Ausgabe nicht → record() wird nirgends
  aufgerufen, Verlauf/Ampel bleiben ohne echte Daten. Braucht Core-Änderung
  + Parser-Vertrag — Owner-Entscheid/requirement, nicht im Loop raten.
- phase ist coarse (direkt/fertig) — S-404-Verlauf-UI muss damit rechnen;
  activeJobs-Maps ohne Pruning (bewusst).
- Supervised Live-Smoke des echten from-notes-Laufs (neuer cwd/argv) offen.
- Retro: Issue #371 (board-ship.sh worktree-tauglich) offen — Landen bei
  --parent weiter von Hand deterministisch fahren (flow/L02/L07).
