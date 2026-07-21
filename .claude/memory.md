> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-093 „Red-Team-Scan pro Container" läuft (Spec red-team-scan-per-container,
7 Stories S-401..S-408, Feature-Branch feature/F-093). Der Scan wird künftig
über einen Knopf pro laufender App in der VPS-Container-Übersicht ausgelöst —
KEINE eigene Kachel; die Red-Team-Kachel wird per S-408 abgebaut (Runner
HeadlessRedTeamRunner bleibt). S-401 (Endpunkt-Fundament) und S-402
(ScanResultStore + Verlauf-Endpunkte + Ampel) sind gelandet. Nächste bereite
Story: S-403 (UI: Scan-Knopf + Live-Fortschritts-Panel).

## Letzte Arbeiten
- S-402 / ScanResultStore (AC7-AC9): dateibasiert `${CRED_STORE_DIR}/
  scan-results.json`, atomar, 0600, Cap 30/App, In-Memory-Degradation;
  2 Verlauf-GET-Endpunkte (scanId≡jobId), deterministische Ampel. Review+Test
  PASS in 1 Iteration, EP 4.0 vs. 4.0 (Punktlandung).
- S-401 / Pro-Container-Scan-Endpunkt (AC1-AC6,AC22): Router
  vpsContainerScanRouter.js + Auto-Discovery, Runner wiederverwendet,
  409-Guard via mapStatus. EP 6.5 vs. 5.25.
- S-388 / GUI-Kombifeld Obsidian-Ingest + ensure-Statusanzeige (AC10/AC15).
- S-387 / ensure-target-Endpunkt: 4 Review-Runden (Prompt-Injection-Guard,
  checkMutationAuthz, GPG-Naht scaffoldOk, TOCTOU).

## Offene Fäden
- Wer ruft nach Job-Abschluss `scanResultStore.record()` auf (Findings-Parsing
  aus dem Agent-Output)? Keiner Story explizit zugeordnet — bei S-403/S-405
  klären; Rückschnitt erwartet record() in Abschluss-Reihenfolge.
- phase ist coarse (direkt/fertig) — der Runner hat kein Zwischen-Signal;
  S-403-UI muss damit rechnen. activeJobs-Maps ohne Pruning (bewusst).
- Supervised Live-Smoke des echten from-notes-Laufs (neuer cwd/argv) offen.
- Retro: Issue #371 (board-ship.sh worktree-tauglich) bleibt offen — Landen
  bei --parent muss weiter von Hand deterministisch gefahren werden (flow/L02).
