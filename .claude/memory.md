> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-095 (Red-Team-Report + Fund-Extraktion, S-410..S-413) läuft als Feature-
Batch auf `feature/F-095`. S-410 ist gelandet: fail-safe Parser + additive
Ausgabe-Exposition — die technische Basis der Findings-Naht steht. 3 von 4
Stories offen (S-411 Store/record(), danach Frontend-Report). Wichtig: das
reale red-team-End-JSON liefert nur einen Fund-Zähler, daher liefert der
Parser heute immer `auswertbar:false` — echte Funde brauchen eine
Cross-Repo-Erweiterung des red-team-Skills (agent-flow), s. Offene Fäden.

## Letzte Arbeiten
- S-410 / Parser + Exposition (AC24/AC25): `src/redTeamOutputParser.js`
  (fail-safe, nie werfend, Allowlist); `HeadlessRunnerCore` opt-in
  `captureOutput` (Default false, übrige Runner byte-identisch); nur
  `HeadlessRedTeamRunner` exponiert `output` via `getJob()`. EP 4/4,
  1 Iteration, Review+Test PASS ohne Befunde.
- S-409 / bw config konditional (AC17-AC21): #openSession ruft config nur
  noch bei unauthenticated oder abweichender Server-URL; config-failed →
  bitwarden-config-failed. EP 6.5 vs. 5.25.
- S-408 / Kachel-Rückbau (AC23): Red-Team-Kachel entfernt. EP 4/4.
- S-404 / Verlauf-Aufklapper (AC14/AC15): RedTeamScanHistory.jsx. EP 4/4.
- S-406 / Befundliste (AC18-AC20): Sammel-Button + Rückfrage. EP 7 vs. 4.
- S-405 / Befunde→Board-Übertrag (AC16/AC17): idempotent. EP 4.0/4.0.
- S-403 / Scan-Knopf + Panel: RedTeamScanPanel.jsx. EP 7/5.25.

## Offene Fäden
- ⚠ F-095-Kernrisiko: `/agent-flow:red-team`-End-JSON hat kein
  `findings`/`checks`-Array (nur `findings_count`) — ohne Skill-Erweiterung
  im agent-flow-Repo persistieren S-411+ dauerhaft leer (ehrliche
  Degradation, nie falsches Grün). Owner-Entscheid vor/mit S-411 nötig.
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt
  config-failed nicht (generischer Fallback-Text) — kleines Folge-Ticket.
- Landen aus Worktree weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree (S-400).
