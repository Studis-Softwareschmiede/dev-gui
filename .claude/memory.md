> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-072 (Deploy-Bitwarden) wird als Feature-Batch abgearbeitet: S-386 ist
jetzt Done (Nachtrag — Fix war seit 2026-07-19 gelandet + deployt);
verbleibt S-414 (AC22, config-failed-Meldung im Validate-Katalog), dann
Feature-Merge. F-095 (Red-Team-Report) und F-050 (Obsidian-Ingest) sind
fachlich komplett; F-096 (Regression target:local) läuft parallel als
Feature-Batch; F-097 ist auf main und ausgerollt.
Wichtig (F-095): das reale red-team-End-JSON liefert nur einen
Fund-Zähler, daher liefert der Parser heute immer `auswertbar:false` —
der Store bleibt leer (ehrliche Degradation), bis der red-team-Skill
strukturierte Arrays liefert.

## Letzte Arbeiten
- S-386 / Done-Nachtrag: Fix (persistentes bw-Appdata-Verzeichnis,
  `login --check`, `lock` statt `logout`) war als PR #431 längst auf
  main + deployt; Session hat nur den Board-Status nachgezogen. Keine
  Metrik (keine Dispatches — Arbeit lief am 2026-07-19 extern).
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

## Offene Fäden
- ⚠ F-095-Kernrisiko: red-team-End-JSON ohne `findings`/`checks`-Array —
  ohne Skill-Erweiterung in agent-flow bleibt der Store leer (nie
  falsches Grün). Owner-Entscheid offen.
- F-050 gelandet — GUI-Pfad „Strukturiert starten" gegen agent-flow
  S-098 (`--gui`-Vertrag) real verifizieren.
- VALIDATE_ERROR_MESSAGES kennt config-failed nicht — S-414 auf dem
  Board (nächste F-072-Story, READY).
- Landen aus Worktree: Modus B (`--target-branch`) läuft (flow/L09);
  Modus A weiter von Hand (flow/L07, Retro-Issue #371 offen).
- Testläufe im Worktree: npm run test:worktree (S-400).
