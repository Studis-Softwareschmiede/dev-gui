> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-050 (Obsidian-Ingest-Fragenkatalog) ist mit S-391 fachlich **komplett**
(15/15 Stories auf feature/F-050 gelandet). Es fehlt nur noch der
gebündelte Feature-Merge nach main + Rollout — das übernimmt der Drain
am Batch-Ende via `board-ship.sh --merge-feature feature/F-050`.
Parallel liegen F-095 (Red-Team-Report, S-410..S-413) und F-096
(Regression target:local, S-415..S-419) auf dem Board; F-097
(Drain-Fix + Stop) ist auf main.

## Letzte Arbeiten
- S-391 / Headless-Format-Signal (AC20-AC22): exportiertes Token
  `HEADLESS_GUI_TOKEN='--gui'` + `JSON_OUTPUT_INSTRUCTION` in Initial-
  und Resume-Prompt von defaultRunClaude; Parsing unverändert.
  EP 3 vs. 4.0, 1 Iteration, Review+Test ohne Befund, 8523 Tests grün.
- S-390 / Hintergrund-Naht (AC18/AC19): Badge-Polling bei geschlossenem
  Overlay, Klick öffnet via initialJobId. EP 4/4.0.
- S-389 / Warteanzeige (AC16/AC17): startedAt + Spinner/Laufzeit. EP 4/4.
- S-409 / bw config konditional (AC17-AC21): EP 6.5/5.25.
- S-408 / Kachel-Rückbau (AC23): Red-Team-Kachel entfernt. EP 4/4.
- S-404 / Verlauf-Aufklapper (AC14/AC15): RedTeamScanHistory.jsx. EP 4/4.
- S-406 / Befundliste (AC18-AC20): Sammel-Button + Rückfrage. EP 7 vs. 4.

## Offene Fäden
- F-050-Abschluss: Feature-Merge nach main + Rollout steht aus (Drain-
  Ende, nicht je Story); danach GUI-Pfad „Strukturiert starten" gegen
  agent-flow S-098 (`--gui`-Vertrag) real verifizieren.
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt die Klasse
  config-failed nicht — Folge-Ticket als S-414 auf dem Board.
- Landen aus Worktree weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree (S-400) statt tar-Workaround.
