> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-095 (Red-Team-Report, S-410..S-413) und F-050 (Obsidian-Ingest,
15/15) sind fachlich KOMPLETT. F-050 ist bereits nach `main` gemergt +
ausgerollt; der finale F-095-Merge nach `main` läuft (Konflikt-Auflösung
.claude/memory.md, danach CI + Rollout). F-096 (Regression target:local)
wird parallel als Feature-Batch gebaut; F-097 (Drain-Fix + Stop) ist auf
main und ausgerollt.
Wichtig (F-095): das reale red-team-End-JSON liefert nur einen
Fund-Zähler, daher liefert der Parser heute immer `auswertbar:false` —
der Store bleibt leer (ehrliche Degradation), bis der red-team-Skill
strukturierte Arrays liefert.

## Letzte Arbeiten
- S-413 / Overlay-Text (AC31): Hinweisblock in `RedTeamScanPanel.jsx`,
  sichtbar bei starting/running, weg bei done/Fehler. EP 3/3.
- S-412 / In-App-Report Frontend (AC29/AC30): Panel lädt `scan.checks`
  über den Detail-Endpunkt nach; Ampel-Konstanten geteilt. EP 4/4.
- S-411 / record()-Naht + checks (AC26–AC28): Poll persistiert bei done
  genau einmal (nur `auswertbar:true`). EP 4/4.
- S-410 / Parser + Exposition (AC24/AC25): `src/redTeamOutputParser.js`
  (fail-safe); `HeadlessRunnerCore` opt-in `captureOutput`. EP 4/4.
- S-391 / Headless-Format-Signal (AC20-AC22): `HEADLESS_GUI_TOKEN` +
  `JSON_OUTPUT_INSTRUCTION` in defaultRunClaude. EP 3/4.
- S-390 / Hintergrund-Naht (AC18/AC19): Badge-Polling, initialJobId. EP 4/4.
- S-389 / Warteanzeige (AC16/AC17): startedAt + Spinner/Laufzeit. EP 4/4.

## Offene Fäden
- ⚠ F-095-Kernrisiko: red-team-End-JSON ohne `findings`/`checks`-Array —
  ohne Skill-Erweiterung in agent-flow bleibt der Store leer (nie
  falsches Grün). Owner-Entscheid offen.
- F-050 gelandet — GUI-Pfad „Strukturiert starten" gegen agent-flow
  S-098 (`--gui`-Vertrag) real verifizieren.
- VALIDATE_ERROR_MESSAGES kennt config-failed nicht — S-414 auf dem Board.
- Landen aus Worktree von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree (S-400).
