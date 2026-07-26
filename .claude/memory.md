> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-050 (Obsidian-Ingest-Fragenkatalog) läuft als Feature-Batch auf
feature/F-050: S-389 (ehrliche Warteanzeige) ist dort gelandet — Stand
13/15 Stories. Verbleibend: S-390 (Hintergrund-Naht/Badge, durch S-389-Done
jetzt frei) und S-391 (v5 Headless-Format-Signal, hängt fachlich an der
agent-flow-Vertragsstory). Feature-Merge nach main erfolgt gebündelt am
Batch-Ende durch den Drain. Parallel liegen F-095 (Red-Team-Report,
S-410..S-413) und F-096 (Regression target:local, S-415..S-419) auf dem
Board; F-097 (Drain-Endlosschleifen-Fix + Stop) ist auf main gelandet.

## Letzte Arbeiten
- S-389 / Warteanzeige (AC16/AC17): ObsidianIngestRunner setzt startedAt
  einmalig in start(), Status-Endpunkt liefert es für jeden Zustand
  secret-frei; Overlay mit Spinner + live „läuft seit m:ss" (setInterval,
  kein NaN ohne startedAt, Cleanup bei Unmount). EP 4/4.0, 1 Iteration.
- S-409 / bw config konditional (AC17-AC21): #openSession ruft config nur
  bei unauthenticated oder abweichender Server-URL; Server-Wechsel =
  logout→config→login→unlock; Fehlerklasse config-failed. EP 6.5/5.25.
- S-408 / Kachel-Rückbau (AC23): Red-Team-Kachel entfernt. EP 4/4.
- S-404 / Verlauf-Aufklapper (AC14/AC15): RedTeamScanHistory.jsx. EP 4/4.
- S-406 / Befundliste (AC18-AC20): Sammel-Button + Rückfrage. EP 7 vs. 4.
- S-405 / Befunde→Board-Übertrag (AC16/AC17): idempotent. EP 4.0/4.0.
- S-403 / Scan-Knopf + Panel: RedTeamScanPanel.jsx. EP 7/5.25.

## Offene Fäden
- S-390: Badge/Wiedereinstieg kann auf startedAt (jeder Zustand) aufbauen;
  Spinner-/Liveness-Muster aus RegressionDefineDialog.jsx wiederverwenden.
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt die Klasse
  config-failed nicht — Folge-Ticket als S-414 auf dem Board.
- Landen aus Worktree weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree (S-400) statt tar-Workaround.
