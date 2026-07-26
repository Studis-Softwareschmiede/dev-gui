> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-050 (Obsidian-Ingest-Fragenkatalog) läuft als Feature-Batch auf
feature/F-050: S-390 (Hintergrund-Naht/Badge) ist dort gelandet — Stand
14/15 Stories. Verbleibend nur noch S-391 (v5 Headless-Format-Signal im
Runner), das fachlich an der agent-flow-Vertragsstory hängt (Cross-Repo);
die AC21-Prompt-Absicherung funktioniert auch allein. Feature-Merge nach
main erfolgt gebündelt am Batch-Ende durch den Drain. Parallel liegen
F-095 (Red-Team-Report, S-410..S-413) und F-096 (Regression target:local,
S-415..S-419) auf dem Board; F-097 (Drain-Fix + Stop) ist auf main.

## Letzte Arbeiten
- S-390 / Hintergrund-Naht (AC18/AC19): ObsidianImportSection pollt bei
  geschlossenem Overlay den Status-Endpunkt, text-beschrifteter Badge
  (needs-answers/done/failed/auth-expired), Klick öffnet Overlay via
  initialJobId (kein zweiter start()); 404/Fehler → Merkung verworfen.
  EP 4/4.0, 1 Iteration, Review+Test ohne Befund.
- S-389 / Warteanzeige (AC16/AC17): startedAt im Job-Status für jeden
  Zustand; Overlay mit Spinner + live „läuft seit m:ss". EP 4/4.0.
- S-409 / bw config konditional (AC17-AC21): #openSession ruft config nur
  bei unauthenticated oder abweichender Server-URL. EP 6.5/5.25.
- S-408 / Kachel-Rückbau (AC23): Red-Team-Kachel entfernt. EP 4/4.
- S-404 / Verlauf-Aufklapper (AC14/AC15): RedTeamScanHistory.jsx. EP 4/4.
- S-406 / Befundliste (AC18-AC20): Sammel-Button + Rückfrage. EP 7 vs. 4.
- S-405 / Befunde→Board-Übertrag (AC16/AC17): idempotent. EP 4.0/4.0.

## Offene Fäden
- S-391: nur Runner-seitig (ObsidianIngestRunner/defaultRunClaude —
  Headless-Token + Prompt-Absicherung); Parsing bleibt unverändert.
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt die Klasse
  config-failed nicht — Folge-Ticket als S-414 auf dem Board.
- Landen aus Worktree weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree (S-400) statt tar-Workaround.
