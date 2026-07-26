> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-095 (Red-Team-Report + Fund-Extraktion, S-410..S-413) läuft als Feature-
Batch auf `feature/F-095`. Backend-Naht (S-410/S-411) und der In-App-Report
im Frontend (S-412) sind gelandet. Offen ist nur noch S-413 (AC31:
Overlay-Text „gefahrlos schliessen / läuft im Hintergrund / ~15 min /
später unter Reports") — danach der finale Feature-Merge nach `main` via
`board-ship.sh --merge-feature feature/F-095` inkl. Rollout. Wichtig: das
reale red-team-End-JSON liefert nur einen Fund-Zähler, daher liefert der
Parser heute immer `auswertbar:false` — der Store bleibt leer (ehrliche
Degradation), bis der red-team-Skill strukturierte Arrays liefert.

## Letzte Arbeiten
- S-412 / In-App-Report Frontend (AC29/AC30): Panel lädt `scan.checks` über
  den Detail-Endpunkt nach (Status-Poll liefert vertraglich keine
  `checks`), Verlauf rendert sie aus dem geladenen Detailbericht;
  `AMPEL_STYLE`/`AMPEL_LABEL` jetzt exportiert und geteilt. Kein-Fund vs.
  nicht-auswertbar bleiben klar getrennt. EP 4/4, 1 Iteration, rein
  additiv (344 Zeilen), Review+Test PASS ohne Befunde.
- S-411 / record()-Naht + checks (AC26–AC28): Poll persistiert bei done
  genau einmal (nur bei `auswertbar:true`); `deriveCheckAmpel()` ohne
  Invertierung; `prHint` nie mehr als `reportRef`. EP 4/4.
- S-410 / Parser + Exposition (AC24/AC25): `src/redTeamOutputParser.js`
  (fail-safe); `HeadlessRunnerCore` opt-in `captureOutput`. EP 4/4.
- S-409 / bw config konditional (AC17-AC21). EP 6.5 vs. 5.25.
- S-408 / Kachel-Rückbau (AC23). EP 4/4.
- S-404 / Verlauf-Aufklapper (AC14/AC15): RedTeamScanHistory.jsx. EP 4/4.

## Offene Fäden
- ⚠ F-095-Kernrisiko: `/agent-flow:red-team`-End-JSON hat kein
  `findings`/`checks`-Array (nur `findings_count`) — ohne Skill-Erweiterung
  im agent-flow-Repo bleibt der Store dauerhaft leer (ehrliche
  Degradation, nie falsches Grün). Owner-Entscheid weiterhin offen.
- S-413 fasst `RedTeamScanPanel.jsx` erneut an (Hot-Spot mit S-412) —
  vorher auf `origin/feature/F-095` zurücksetzen.
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt
  config-failed nicht (generischer Fallback-Text) — kleines Folge-Ticket.
- Testläufe im Worktree: npm run test:worktree (S-400).
