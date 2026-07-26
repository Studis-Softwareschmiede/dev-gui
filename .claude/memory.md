> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-095 (Red-Team-Report + Fund-Extraktion, S-410..S-413) ist fachlich
KOMPLETT — alle vier Storys sind Done und auf `feature/F-095` gelandet.
Es fehlt nur noch der finale Feature-Merge nach `main` via
`board-ship.sh --merge-feature feature/F-095` (bündelt CI-Watch + Rollout;
übernimmt `board-feature-drain.sh` am Batch-Ende bzw. der Owner).
Wichtig: das reale red-team-End-JSON liefert nur einen Fund-Zähler, daher
liefert der Parser heute immer `auswertbar:false` — der Store bleibt leer
(ehrliche Degradation), bis der red-team-Skill strukturierte Arrays liefert.

## Letzte Arbeiten
- S-413 / Overlay-Text (AC31): Hinweisblock in `RedTeamScanPanel.jsx`
  (gefahrlos schliessen / Hintergrund-Lauf / ~15 min / später unter
  Verlauf/„Reports"), sichtbar bei starting/running, weg bei done/Fehler.
  Rein additiv (63 Zeilen inkl. 4 Tests). EP 3/3, 1 Iteration,
  Review+Test PASS ohne Befunde. Modus-B-Ship glatt (flow/L09 bestätigt).
- S-412 / In-App-Report Frontend (AC29/AC30): Panel lädt `scan.checks` über
  den Detail-Endpunkt nach; `AMPEL_STYLE`/`AMPEL_LABEL` exportiert und
  geteilt. Kein-Fund vs. nicht-auswertbar klar getrennt. EP 4/4.
- S-411 / record()-Naht + checks (AC26–AC28): Poll persistiert bei done
  genau einmal (nur bei `auswertbar:true`); `deriveCheckAmpel()` ohne
  Invertierung; `prHint` nie mehr als `reportRef`. EP 4/4.
- S-410 / Parser + Exposition (AC24/AC25): `src/redTeamOutputParser.js`
  (fail-safe); `HeadlessRunnerCore` opt-in `captureOutput`. EP 4/4.
- S-409 / bw config konditional (AC17-AC21). EP 6.5 vs. 5.25.
- S-408 / Kachel-Rückbau (AC23). EP 4/4.

## Offene Fäden
- ⚠ F-095-Kernrisiko: `/agent-flow:red-team`-End-JSON hat kein
  `findings`/`checks`-Array (nur `findings_count`) — ohne Skill-Erweiterung
  im agent-flow-Repo bleibt der Store dauerhaft leer (ehrliche
  Degradation, nie falsches Grün). Owner-Entscheid weiterhin offen.
- Finaler F-095-Merge nach `main` steht aus (erst dann Rollout/Deploy).
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt
  config-failed nicht (generischer Fallback-Text) — kleines Folge-Ticket.
- Testläufe im Worktree: npm run test:worktree (S-400).
