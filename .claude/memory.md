> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-095 (Red-Team-Report + Fund-Extraktion, S-410..S-413) läuft als Feature-
Batch auf `feature/F-095`. Backend-Naht ist komplett: S-410 (Parser +
Ausgabe-Exposition) und S-411 (record()-Naht + checks-Schema +
reportRef-Fix) sind gelandet. Es fehlen die zwei Frontend-Report-Stories
(S-412/S-413: In-App-Report mit Prüfpunkt-Liste, AC29–AC31). Wichtig: das
reale red-team-End-JSON liefert nur einen Fund-Zähler, daher liefert der
Parser heute immer `auswertbar:false` — der Store bleibt leer (ehrliche
Degradation), bis der red-team-Skill (agent-flow) strukturierte Arrays
liefert, s. Offene Fäden.

## Letzte Arbeiten
- S-411 / record()-Naht + checks (AC26–AC28): Status-Poll persistiert bei
  done genau einmal (`recordedJobs`-Guard, nur bei `auswertbar:true`);
  `ScanResultStore.checks` + `deriveCheckAmpel()` (keine Invertierung);
  `job.prHint` nie mehr als `reportRef`; `GET …/scans/:scanId` liefert
  additiv `scan.checks`. EP 4/4, 1 Iteration, Review+Test PASS ohne
  Befunde.
- S-410 / Parser + Exposition (AC24/AC25): `src/redTeamOutputParser.js`
  (fail-safe); `HeadlessRunnerCore` opt-in `captureOutput`; nur
  `HeadlessRedTeamRunner` exponiert `output` via `getJob()`. EP 4/4.
- S-409 / bw config konditional (AC17-AC21). EP 6.5 vs. 5.25.
- S-408 / Kachel-Rückbau (AC23). EP 4/4.
- S-404 / Verlauf-Aufklapper (AC14/AC15): RedTeamScanHistory.jsx. EP 4/4.
- S-406 / Befundliste (AC18-AC20): Sammel-Button + Rückfrage. EP 7 vs. 4.
- S-405 / Befunde→Board-Übertrag (AC16/AC17): idempotent. EP 4.0/4.0.

## Offene Fäden
- ⚠ F-095-Kernrisiko: `/agent-flow:red-team`-End-JSON hat kein
  `findings`/`checks`-Array (nur `findings_count`) — ohne Skill-Erweiterung
  im agent-flow-Repo bleibt der Store dauerhaft leer (ehrliche
  Degradation, nie falsches Grün). Owner-Entscheid weiterhin offen.
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt
  config-failed nicht (generischer Fallback-Text) — kleines Folge-Ticket.
- Landen aus Worktree weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree (S-400).
